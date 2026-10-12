#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修正 manifest.json 中**垂直温度切片**的 ni/nj 维度。

问题
====
`convert_fds_outputs.py` 的 `slice_dims(bounds)` 恒返回网格 i/j 跨度的点数：

    ni = |i2-i1| + 1,  nj = |j2-j1| + 1

但 `.sf` 切片是**二维**文件，帧点数等于**面内两轴**之积：

    PBZ（法向 z）  面内 = (i, j)  ->  ni x nj   （slice_dims 恰好正确）
    PBY（法向 y）  面内 = (i, k)  ->  ni x nk   （slice_dims 给出 ni x 1，错）
    PBX（法向 x）  面内 = (j, k)  ->  nj x nk   （slice_dims 给出 1 x nj，错）

前端 `ThermalSlices.tsx` 用 `new THREE.DataTexture(pixels, ni, nj, ...)`
解码，ni/nj 就是纹理宽高。垂直切片维度错会导致纹理按错误行宽读取，
温度场**空间错位**。

实测规模：16 个工况共 667 个切片，其中 278 个（全部垂直切片）不自洽。

处理方式
========
**不修改 `convert_fds_outputs.py`**（用户并行改动中）。本脚本只读源 `.sf`
的真实帧长，用「面内两轴由 plane 决定」的规则直接改写各工况 manifest.json
中的 ni/nj，并新增 `gridDims` 保存原始网格维度。`.bin` 数据本身是正确的，
无需重算，只改元数据。

判定 plane沿用 convert_fds_outputs 的约定：
    k1 == k2 -> PBZ;  j1 == j2 -> PBY;  否则 PBX
判定用的边界从 manifest 的 `plane` 字段直接读（已经是权威值）。
"""

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from convert_fds_outputs import parse_sf, slice_dims  # noqa: E402

RESULTS_DIR = os.path.join(ROOT, "public", "assets", "results")

# 每个 plane 的面内两轴在 (gridNi, gridNj, gridNk) 中的索引
PLANE_INPLANES = {
    "PBZ": ("u=i,v=j", 0, 1),
    "PBY": ("u=i,v=k", 0, 2),
    "PBX": ("u=j,v=k", 1, 2),
}


def source_dir_for(sid, chid):
    """定位该工况的原始结果目录，用于读 .sf 真实帧长。"""
    ws = os.path.dirname(ROOT)
    cands = [
        os.path.join(ws, "_V2_extract",
                     "WorkBuddy_116_Fire_Visualization_FINAL", "raw_results",
                     sid, "rar_out", "新建文件夹", chid),
        os.path.join(ws, "116-diya-window", chid),
        os.path.join(ws, "116-gaoya-window", chid),
    ]
    for c in cands:
        if os.path.isdir(c):
            return c
    return None


def fix_scenario(sid, chid, dry_run=False):
    """修正单个工况。返回 (fixed, skipped, details)。"""
    mp = os.path.join(RESULTS_DIR, sid, "manifest.json")
    if not os.path.isfile(mp):
        return 0, 0, []
    with open(mp, encoding="utf-8") as f:
        m = json.load(f)

    cdir = source_dir_for(sid, chid)
    fixed = skipped = 0
    details = []
    for s in m.get("slices", []):
        plane = s.get("plane")
        if plane not in PLANE_INPLANES:
            skipped += 1
            continue
        desc, ia, ib = PLANE_INPLANES[plane]
        gd = s.get("gridDims")
        if not gd:
            # 从现有 ni/nj 与 plane 反推网格维度不可靠，改为读源 .sf 的 bounds
            if cdir is None:
                skipped += 1
                continue
            sf_path = os.path.join(cdir, s["sourceFile"])
            if not os.path.isfile(sf_path):
                skipped += 1
                continue
            parsed = parse_sf(sf_path)
            if not parsed or not parsed.get("bounds"):
                skipped += 1
                continue
            dims = slice_dims(parsed["bounds"]["raw"])
            gd = {"ni": dims["ni"], "nj": dims["nj"], "nk": dims["nk"]}
        want_ni = gd["ni"] if ia == 0 else gd["nj"]
        want_nj = gd["nj"] if ib == 1 else gd["nk"]
        if s.get("ni") == want_ni and s.get("nj") == want_nj \
                and s.get("gridDims") == gd:
            continue
        # 用真实 .bin 帧长做最终确认，避免误改
        binp = os.path.join(RESULTS_DIR, sid, s["asset"])
        if os.path.isfile(binp) and s.get("frameCount"):
            per = os.path.getsize(binp) // s["frameCount"]
            if per != want_ni * want_nj:
                details.append((sid, s["asset"], plane,
                                "跳过：.bin 帧长 %d != %dx%d=%d"
                                % (per, want_ni, want_nj, want_ni * want_nj)))
                skipped += 1
                continue
        old = (s.get("ni"), s.get("nj"))
        s["ni"], s["nj"] = want_ni, want_nj
        s["gridDims"] = gd
        s["inPlaneAxes"] = desc
        fixed += 1
        details.append((sid, s["asset"], plane,
                        "%sx%s -> %dx%d (%s)" % (old[0], old[1],
                                                 want_ni, want_nj, desc)))

    if fixed and not dry_run:
        with open(mp, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
    return fixed, skipped, details


def verify(sid):
    """复核：.bin 字节数 == frameCount * ni * nj。"""
    mp = os.path.join(RESULTS_DIR, sid, "manifest.json")
    with open(mp, encoding="utf-8") as f:
        m = json.load(f)
    bad = []
    for s in m.get("slices", []):
        p = os.path.join(RESULTS_DIR, sid, s["asset"])
        if not os.path.isfile(p):
            bad.append((s["asset"], "缺文件"))
            continue
        if os.path.getsize(p) != s["frameCount"] * s["ni"] * s["nj"]:
            bad.append((s["asset"], "%d != %d"
                        % (os.path.getsize(p),
                           s["frameCount"] * s["ni"] * s["nj"])))
    return len(m.get("slices", [])), bad


def main():
    with open(os.path.join(ROOT, "data", "scenarios.json"),
              encoding="utf-8") as f:
        scenarios = json.load(f)

    print("修正垂直切片 ni/nj（面内两轴）\n")
    grand_fixed = grand_skip = 0
    for sc in scenarios:
        sid, chid = sc["id"], sc["chid"]
        fixed, skipped, details = fix_scenario(sid, chid)
        grand_fixed += fixed
        grand_skip += skipped
        n, bad = verify(sid)
        status = "OK" if not bad else "仍有 %d 处不一致" % len(bad)
        print("%-16s 修正 %3d, 跳过 %3d, 切片 %3d -> %s"
              % (sid, fixed, skipped, n, status))
        for b in bad[:3]:
            print("      !", b)
        if fixed:
            seen = {}
            for _, _, pl, msg in details:
                seen.setdefault(pl, msg)
            for pl, msg in sorted(seen.items()):
                print("      e.g. %s  %s" % (pl, msg))

    print("\n共修正 %d 个切片，跳过 %d 个" % (grand_fixed, grand_skip))
    print("说明：未修改 convert_fds_outputs.py（用户并行改动中）；"
          ".bin 数据未重算，只改manifest 元数据。")


if __name__ == "__main__":
    main()
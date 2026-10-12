#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修正 hrr.json 抽稀导致的峰值丢失（阻塞级数据管道缺陷）。

问题：原实现先算全序列 max 写入 manifest.peakKW，再按 SERIES_STRIDE=5
      抽稀写 hrr.json，导致 hrr.json 的峰值比 manifest.peakKW 低 26~99 倍
      （高压燃烧尖峰陡，抽稀直接漏掉峰值帧）。

修复：hrr.json 保留**全分辨率**（HRR 序列仅约 1000 点，体积可忽略），
      并在 manifest 中记录峰值发生时刻，保证任意粒度求 max 都一致。

同时：
  - 修正 manifest 的 hrrInterpretation 措辞：陈述事实，不推断未验证的成因。
  - 保持 series.json 的 fireSourceMaxC 语义（本脚本不改动它）。
"""

import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RES = os.path.join(ROOT, "public", "assets", "results")
WORKSPACE = os.path.dirname(ROOT)


def find_case_dir(chid):
    for root in (
        os.path.join(WORKSPACE, "116-diya-window"),
        os.path.join(WORKSPACE, "116-gaoya-window"),
    ):
        p = os.path.join(root, chid)
        if os.path.isdir(p):
            return p
    return None


def parse_hrr_full(path):
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        rows = list(csv.reader(f))
    times, hrr = [], []
    for r in rows[2:]:
        if not r or not r[0].strip():
            continue
        try:
            times.append(float(r[0]))
            hrr.append(float(r[1]))
        except (ValueError, IndexError):
            continue
    return times, hrr


def main():
    if not os.path.isdir(RES):
        print("results 目录不存在，请先运行 convert_fds_outputs.py")
        return 1

    fixed, skipped = 0, 0
    for sid in sorted(os.listdir(RES)):
        mdir = os.path.join(RES, sid)
        mpath = os.path.join(mdir, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        with open(mpath, encoding="utf-8") as f:
            manifest = json.load(f)

        if manifest.get("status") != "READY":
            skipped += 1
            continue

        chid = manifest["chid"]
        cdir = find_case_dir(chid)
        if not cdir:
            skipped += 1
            continue
        hrr_path = os.path.join(cdir, chid + "_hrr.csv")
        if not os.path.isfile(hrr_path):
            skipped += 1
            continue

        times, hrr = parse_hrr_full(hrr_path)
        if not times:
            skipped += 1
            continue

        # 全分辨率写出（修正：不再抽稀）
        with open(os.path.join(mdir, "hrr.json"), "w", encoding="utf-8") as f:
            json.dump(
                {
                    "timesS": [round(t, 4) for t in times],
                    "hrrKW": [round(v, 4) for v in hrr],
                },
                f,
                ensure_ascii=False,
                separators=(",", ":"),
            )

        # 峰值取绝对值最大帧，并记录其时刻
        peak_i = max(range(len(hrr)), key=lambda i: abs(hrr[i]))
        peak_kw = round(abs(hrr[peak_i]), 4)
        peak_t = round(times[peak_i], 4)

        manifest["hrr"] = {
            "peakKW": peak_kw,
            "peakTimeS": peak_t,
            "sourceFile": chid + "_hrr.csv",
            "sampling": "FULL_RESOLUTION",
            "frameCount": len(times),
        }

        # 措辞修正：陈述可验证事实，不断言未经验证的成因
        manifest["hrrInterpretation"] = {
            "nominalPeakHRRKW": None,  # 由 scenarios.json 回填
            "measuredPeakHRRKW": peak_kw,
            "measuredPeakTimeS": peak_t,
            "note": (
                "「标称设定」= 源 FDS 的 HRRPUA × 火源面面积，是输入参数上限；"
                "「输出峰值」= *_hrr.csv 的 HRR 通道实测最大值，是 FDS 计算结果。"
                "两者均为真实数据。实测峰值低于标称设定的原因是本项目尚未完成的"
                "建模核查项（TODO_FDS_HRR），前端只陈述数值与比值，不推断成因。"
            ),
        }
        manifest["hrrFile"] = "hrr.json"

        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)

        fixed += 1
        print("%-14s peak=%10.2f kW @ t=%7.2f s  frames=%d"
              % (sid, peak_kw, peak_t, len(times)))

    # 回填标称值
    spath = os.path.join(ROOT, "public", "assets", "scenarios", "scenarios.json")
    if os.path.isfile(spath):
        with open(spath, encoding="utf-8") as f:
            scn = json.load(f)
        nom = {s["id"]: s["nominalPeakHRRKW"] for s in scn["scenarios"]}
        for sid in os.listdir(RES):
            mpath = os.path.join(RES, sid, "manifest.json")
            if not os.path.isfile(mpath):
                continue
            with open(mpath, encoding="utf-8") as f:
                m = json.load(f)
            if m.get("status") == "READY" and "hrrInterpretation" in m:
                m["hrrInterpretation"]["nominalPeakHRRKW"] = nom.get(sid)
                with open(mpath, "w", encoding="utf-8") as f:
                    json.dump(m, f, ensure_ascii=False, indent=1)

    print("\n修正 %d 个工况，跳过 %d 个" % (fixed, skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
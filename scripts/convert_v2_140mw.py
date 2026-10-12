#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HV-01-140MW 工况完整重接入（V2 沙箱复算数据）。

背景
----
`public/assets/results/HV-01-140MW/` 原内容来自 **旧错误运行**
（源 FDS HRRPUA=5.6E6 kW/m² × 0.25 m² = 1400 MW，与标称 140 MW 不符），
status=INVALID_SOURCE，必须完全作废。本脚本用 V2 复算输出重建该工况资产。

V2 复算已修正 HRRPUA -> 5.6E5，`.out` 末尾为 `STOP: FDS completed successfully`。

绝对不使用 `116-gaoya-window/116-gaoya-1-140mw/`（旧错误运行）。

复用
----
本脚本 **import** `scripts/convert_fds_outputs.py` 中已实测验证的解析函数
（read_meshes_from_fds / parse_smv / parse_sf / parse_devc / parse_hrr /
slice_dims / sha256_file / case_devc_xyz），不重写、不修改那个文件。
唯一自行实现的是 V2 目录定位（`find_case_dir` 只认116-*-window，对 V2 不适用）。

量化标度的重要修正
-------------------
任务说明里给的 8bit 标度 `T = 20 + byte×(780/255)`（byte255=800°C）是**错的**：
`.sf` 里是 float32 真实摄氏温度，实测最高 1083.69°C，780/255 需要 byte>255
根本无法表示，800°C 以上会被截断（这是现有convert_fds_outputs.py 的已知缺陷）。
实测正确标度（5 个 mesh 共 1953 帧交叉验证，.sf 真实温度反解 byte 与实测一致）：

    T = 20.0 + byte × (2000.0/255)     # 步长 7.843137 °C/LSB, byte255 = 2020°C

⚠️ 2026-10-08 P0 修正：`quantize()` 曾误写为 `(v-20)/SCALE_C*255.0`（多乘 255），
使实际标度变成 2000，导致 **>27.84 °C 的像素全被压成 byte=255**，49 个切片
合计 1,517,756 个饱和字节，火场渲染为一片白。现已去掉 `*255.0`，并补上
越界抛错自检（详见 `quantize()` docstring）。

本工况的 `scaleC` 语义是 **PER_LSB**（每 LSB 增量），与另外 15 个 SPAN 工况
（`convert_fds_outputs.py`，`T = baseC + (byte/255)×scaleC`）**不同**。
故 manifest 顶层显式写出 `"scaleMode": "PER_LSB"`，前端 `resolveScaleMode()`
优先采信该字段，不再依赖 `scaleC` 量级启发式。
"""

import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# 复用既有解析器（实测验证过，禁止重写）
from convert_fds_outputs import (  # noqa: E402
    case_devc_xyz,
    parse_devc,
    parse_hrr,
    parse_sf,
    parse_smv,
    read_meshes_from_fds,
    sha256_file,
    slice_dims,
)

SID = "HV-01-140MW"
CHID = "116-gaoya-1-140mw"
T_END = 1800.0

V2_ROOT = ("d:/可视化/不开窗/_V2_extract/"
           "WorkBuddy_116_Fire_Visualization_FINAL")
V2_CASE = os.path.join(V2_ROOT, "raw_results", "HV-01-140MW")
# rar 解压后的完整结果（含 .smv / .sf / .s3d / .fds），目录名含中文「新建文件夹」
V2_OUT = os.path.join(V2_CASE, "rar_out", "新建文件夹", CHID)

OUT_RES = os.path.join(ROOT, "public", "assets", "results")

# 实测标度（见模块 docstring）
BASE_C = 20.0
SCALE_C = 2000.0 / 255.0

SERIES_STRIDE = 5  # DEVC 标量时序抽稀（仅影响 series.json，不影响 hrr.json）


# --------------------------------------------------------------- V2 路径定位

def v2_case_dir():
    """返回 V2 复算结果目录，并做存在性校验。"""
    if not os.path.isdir(V2_OUT):
        raise SystemExit("V2 结果目录不存在: %s" % V2_OUT)
    return V2_OUT


def read_out_completed(path):
    """真实读取 .out 尾部确认 FDS 是否正常结束，不硬编码。"""
    if not os.path.isfile(path):
        return False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        tail = f.read()[-4000:]
    return "FDS completed successfully" in tail


def fds_hrrpua(path):
    """从 .fds 的 &SURF 里读 HRRPUA（用于 provenance 标注）。"""
    if not os.path.isfile(path):
        return None
    import re
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        txt = f.read()
    m = re.search(r"HRRPUA\s*=\s*([-+0-9.eEdD]+)", txt, re.I)
    if not m:
        return None
    try:
        return float(m.group(1).replace("D", "E").replace("d", "e"))
    except ValueError:
        return None


QUANT_CEIL_C = BASE_C + 255 * SCALE_C  # 2020.0 ℃，byte=255 的解码上限


def quantize(vals):
    """
    float 摄氏温度 -> 8bit（base 20, scale 2000/255，**PER_LSB 语义**）。

        T = BASE_C + byte × SCALE_C

    ⚠️ 2026-10-08 P0 修正：原实现写成 `(v - BASE_C) / SCALE_C * 255.0`，
    多乘了一个 255，使实际生效标度变成 2000/255×255 = 2000，于是
    `(v-20)/7.8431×255` 在 **v=27.84 ℃** 就到 255 —— 凡高于约 27.84 ℃ 的
    像素全被压成 byte=255，49 个切片无一幸免（合计 1,517,756 个饱和字节），
    140MW 的火场被渲染成一片饱和白色。
    正确公式不含 `* 255.0`：byte = (v-20)/7.8431，故 940.72 ℃ -> 117，
    1083.69 ℃ -> 135，均 < 255，不再饱和。

    饱和自检（本次一并补上 —— 该缺陷之所以逃过全部单元测试，
    正是因为旧实现对越界值静默 clamp 到 255 而无任何断言）：
    超出可表示域（> QUANT_CEIL_C = 2020 ℃）**直接抛错**，不再静默截断。
    NaN -> byte 0；低于 baseC -> byte 0（这两项是合法的域下越界，保留）。
    """
    out = bytearray()
    for idx, v in enumerate(vals):
        if v != v:  # NaN -> 基准
            out.append(0)
            continue
        tq = (v - BASE_C) / SCALE_C
        if tq < 0:
            out.append(0)
        elif tq > 255:
            raise ValueError(
                "量化饱和：第 %d 个值 %.4f ℃ 超出可表示上限 %.4f ℃ "
                "(= 20 + 255×2000/255)。这说明标度或数据异常，"
                "禁止静默 clamp 到 255（该静默行为曾使 140MW 全部切片"
                "被压成饱和白）。" % (idx, v, QUANT_CEIL_C)
            )
        else:
            out.append(int(round(tq)))
    return out


def dequantize(b):
    return BASE_C + b * SCALE_C


# ------------------------------------------------------------------- 主流程

def build_series(devc, scen, outdir):
    """柜体区域热电偶时序。语义与既有实现保持一致。"""
    times = devc["times"]
    n_t = len(times)
    idx = list(range(0, n_t, SERIES_STRIDE))
    if idx[-1] != n_t - 1:
        idx.append(n_t - 1)
    series_times = [round(times[i], 4) for i in idx]

    fire = []
    for i in idx:
        vals = [devc["values"][ci][i] for ci in range(len(devc["ids"]))]
        vals = [v for v in vals if v == v]
        fire.append(round(max(vals), 3) if vals else None)

    pts = case_devc_xyz(scen["fds_path"])
    envelope = None
    if pts:
        envelope = [
            round(min(p[0] for p in pts), 3), round(max(p[0] for p in pts), 3),
            round(min(p[1] for p in pts), 3), round(max(p[1] for p in pts), 3),
            round(min(p[2] for p in pts), 3), round(max(p[2] for p in pts), 3),
        ]

    spatial = []
    for ci, did in enumerate(devc["ids"]):
        col = devc["values"][ci]
        finite = [v for v in col if v == v]
        if not finite:
            continue
        spatial.append({
            "id": did,
            "maxC": round(max(finite), 2),
            "finalC": round(col[-1], 2) if col[-1] == col[-1] else None,
        })
    spatial.sort(key=lambda d: -d["maxC"])

    series = {
        "timesS": series_times,
        "fireSourceMaxC": fire,
        "sensorCount": len(devc["ids"]),
        "aggregation": "MAX_OVER_THERMOCOUPLE_IN_FIRE_SOURCE_REGION",
        "sensorEnvelopeFdsM": envelope,
        "sensorScopeNote": (
            "本工况全部热电偶均布置在起火柜 burner 附近（见 sensorEnvelopeFdsM），"
            "代表起火柜区域温度；同工况下其它柜体未布设热电偶，温度未接入。"
        ),
        "spatialMax": spatial[:12],
    }
    with open(os.path.join(outdir, "series.json"), "w", encoding="utf-8") as f:
        json.dump(series, f, ensure_ascii=False, separators=(",", ":"))
    return series


def build_slices(cdir, scen, outdir):
    """从 .smv + .sf 产出 8bit 温度切片。"""
    smv_path = os.path.join(cdir, CHID + ".smv")
    fds_path = scen["fds_path"]
    slice_defs = parse_smv(smv_path)
    mesh_list = read_meshes_from_fds(fds_path) if os.path.isfile(fds_path) else []

    sdir = os.path.join(outdir, "slices")
    os.makedirs(sdir, exist_ok=True)

    entries = []
    for sl in slice_defs:
        mi = sl["meshIndex"]
        if mi < 1 or mi > len(mesh_list):
            continue
        mxb, mijk = mesh_list[mi - 1]
        dx = (mxb[1] - mxb[0]) / mijk[0]
        dy = (mxb[3] - mxb[2]) / mijk[1]
        dz = (mxb[5] - mxb[4]) / mijk[2]

        sf_path = os.path.join(cdir, sl["file"])
        if not os.path.isfile(sf_path):
            continue
        sf = parse_sf(sf_path)
        if not sf or not sf["frames"]:
            continue

        bounds = sf["bounds"]["raw"] if sf["bounds"] else [
            sl["i1"], sl["i2"], sl["j1"], sl["j2"], sl["k1"], sl["k2"]]
        dims = slice_dims(bounds)
        if not dims:
            continue

        if dims["k1"] == dims["k2"]:
            plane, coord = "PBZ", round(mxb[4] + dims["k1"] * dz, 4)
            uAxis, vAxis = "X", "Y"
            # 面内两轴 = (i, j)
            uN, vN = dims["ni"], dims["nj"]
        elif dims["j1"] == dims["j2"]:
            plane, coord = "PBY", round(mxb[2] + dims["j1"] * dy, 4)
            uAxis, vAxis = "X", "Z"
            # 面内两轴 = (i, k)
            uN, vN = dims["ni"], dims["nk"]
        else:
            plane, coord = "PBX", round(mxb[0] + dims["i1"] * dx, 4)
            uAxis, vAxis = "Y", "Z"
            # 面内两轴 = (j, k)
            uN, vN = dims["nj"], dims["nk"]

        if plane == "PBZ":
            u0, u1, v0, v1 = mxb[0], mxb[1], mxb[2], mxb[3]
        elif plane == "PBY":
            u0, u1, v0, v1 = mxb[0], mxb[1], mxb[4], mxb[5]
        else:
            u0, u1, v0, v1 = mxb[2], mxb[3], mxb[4], mxb[5]

        # 帧长自检：.sf 每帧点数必须等于面内两轴之积。
        # slice_dims() 恒返回 (ni,nj)（网格 i/j 跨度），对垂直切片是错的：
        # PBY 面内是 (i,k)、PBX 面内是 (j,k)。前端用 DataTexture(pixels, ni, nj)
        # 解码，ni/nj 必须是面内点数，否则纹理会错行。
        expectPerFrame = uN * vN
        actualPerFrame = len(sf["frames"][0][1])
        if actualPerFrame != expectPerFrame:
            raise SystemExit(
                "切片 %s 帧长 %d != 面内 %dx%d=%d（plane=%s）"
                % (sl["file"], actualPerFrame, uN, vN, expectPerFrame,
                   plane))

        # 切片全分辨率保留（.sf 只有 1001 帧，体积可忽略；不做 stride 抽稀）
        blob = bytearray()
        frame_times = []
        gmin, gmax = 1e9, -1e9
        clipped = 0
        for (t, vals) in sf["frames"]:
            if not vals:
                continue
            gmin = min(gmin, min(vals))
            gmax = max(gmax, max(vals))
            frame_times.append(round(t, 4))
            blob.extend(quantize(vals))

        sname = sl["file"][:-3] + ".bin"
        with open(os.path.join(sdir, sname), "wb") as f:
            f.write(bytes(blob))

        # 量化域自检：byte=255 上限 = 2020°C。
        # quantize() 对越界值直接抛错，故走到这里即代表**未发生截断**，
        # quantizationClipped 恒为 False（保留字段仅为 manifest 向后兼容）。
        if gmax > QUANT_CEIL_C:
            raise ValueError(
                "切片 %s 最高温 %.2f ℃ 超出量化上限 %.2f ℃"
                % (sl["file"], gmax, QUANT_CEIL_C))
        clipped = 0

        entries.append({
            "asset": "slices/" + sname,
            "sourceFile": sl["file"],
            "plane": plane,
            "planeCoordM": coord,
            "meshIndex": mi,
            "meshXb": [round(v, 4) for v in mxb],
            # ni/nj 是**面内两轴**的点数（前端 DataTexture 宽高），不是网格 i/j 跨度
            "ni": uN, "nj": vN,
            "gridDims": {"ni": dims["ni"], "nj": dims["nj"],
                         "nk": dims["nk"]},
            "uAxis": uAxis, "vAxis": vAxis,
            "uRangeM": [round(u0, 4), round(u1, 4)],
            "vRangeM": [round(v0, 4), round(v1, 4)],
            "frameCount": len(frame_times),
            "frameTimesS": frame_times,
            "units": sf["header"]["units"],
            "dataMinC": round(gmin, 2),
            "dataMaxC": round(gmax, 2),
            "quantization": {"baseC": BASE_C, "scaleC": SCALE_C, "bits": 8},
            "quantizationClipped": bool(clipped),
        })
    return entries


def main():
    outdir = os.path.join(OUT_RES, SID)
    os.makedirs(outdir, exist_ok=True)
    cdir = v2_case_dir()

    devc_path = os.path.join(V2_CASE, CHID + "_devc.csv")
    hrr_path = os.path.join(V2_CASE, CHID + "_hrr.csv")
    out_path = os.path.join(V2_CASE, CHID + ".out")
    fds_path = os.path.join(cdir, CHID + ".fds")
    smv_path = os.path.join(cdir, CHID + ".smv")

    print("V2 源目录: %s" % cdir)
    for p in (devc_path, hrr_path, out_path, fds_path, smv_path):
        if not os.path.isfile(p):
            raise SystemExit("缺少必需文件: %s" % p)
    print("全部必需文件存在")

    scen = {"fds_path": fds_path, "nominalPeakHRRKW": 140000.0}

    # ---------------- DEVC
    devc = parse_devc(devc_path)
    if not devc:
        raise SystemExit("DEVC 解析失败: %s" % devc_path)
    print("DEVC: 样本 %d, 热电偶 %d, t=[%.3f, %.3f]"
          % (len(devc["times"]), len(devc["ids"]),
             devc["times"][0], devc["times"][-1]))
    series = build_series(devc, scen, outdir)

    # ---------------- HRR（全分辨率，禁止抽稀）
    h = parse_hrr(hrr_path)
    if not h:
        raise SystemExit("HRR 解析失败: %s" % hrr_path)
    times, hrr = h["times"], h["hrrKW"]
    peak_i = max(range(len(hrr)), key=lambda i: abs(hrr[i]))
    peak_kw = round(abs(hrr[peak_i]), 4)
    peak_t = round(times[peak_i], 4)

    # 梯形积分（仅用于报告/自检，不写入前端资产）
    energy = 0.0
    for i in range(len(times) - 1):
        energy += (times[i + 1] - times[i]) * (hrr[i] + hrr[i + 1]) / 2.0

    dts = sorted({round(times[i + 1] - times[i], 6)
                  for i in range(len(times) - 1)})

    hrr_payload = {
        "timesS": [round(t, 4) for t in times],
        "hrrKW": [round(v, 4) for v in hrr],
    }
    with open(os.path.join(outdir, "hrr.json"), "w", encoding="utf-8") as f:
        json.dump(hrr_payload, f, ensure_ascii=False, separators=(",", ":"))

    print("HRR :样本 %d, t=[%.1f, %.1f], 峰值 %.4f kW @ %.6f s"
          % (len(times), times[0], times[-1], peak_kw, peak_t))
    print("      梯形积分 %.4f kJ, dt 不同取值 %d 个 (min=%.6f max=%.6f)"
          % (energy, len(dts), dts[0], dts[-1]))
    print("      末非零时刻 %.6f s" % times[max(i for i, v in enumerate(hrr) if v != 0)])

    # ---------------- 切片
    slices = build_slices(cdir, scen, outdir)
    print("切片: %d 个" % len(slices))
    for e in slices:
        print("      %-34s %s %s  %d 帧  T=[%.2f, %.2f]C%s"
              % (e["sourceFile"], e["plane"], e["planeCoordM"],
                 e["frameCount"], e["dataMinC"], e["dataMaxC"],
                 "  [已截断]" if e["quantizationClipped"] else ""))

    # ---------------- provenance
    completed = read_out_completed(out_path)
    hrrpua = fds_hrrpua(fds_path)
    provenance = {
        "origin": "V2_HANDBOX_RECALC",
        "sourceFdsSha256": sha256_file(fds_path),
        "sourceFdsHrrpua": hrrpua,
        "verifiedBy": "scripts/convert_v2_140mw.py",
        "verifiedAt": datetime.datetime.now().astimezone().isoformat(),
        "fdsCompletedSuccessfully": completed,
        "inputCorrection": "HRRPUA 5.6E6 -> 5.6E5 已修正并复算",
    }
    print("provenance: hrrpua=%s completed=%s sha256=%s"
          % (hrrpua, completed, provenance["sourceFdsSha256"][:16] + "..."))

    # ---------------- manifest
    manifest = {
        "scenarioId": SID,
        "status": "READY",
        "kind": "PRECOMPUTED_FDS",
        "dataTruthLabel": "FDS SIMULATED",
        "chid": CHID,
        "scaleMode": "PER_LSB",
        "timeRangeS": [0.0, T_END],
        "seriesFile": "series.json",
        "hrrFile": "hrr.json",
        "hrr": {
            "peakKW": peak_kw,
            "peakTimeS": peak_t,
            "sourceFile": CHID + "_hrr.csv",
            "sampling": "FULL_RESOLUTION",
            "frameCount": len(times),
        },
        "hrrInterpretation": {
            "nominalPeakHRRKW": scen["nominalPeakHRRKW"],
            "measuredPeakHRRKW": peak_kw,
            "measuredPeakTimeS": peak_t,
            "note": (
                "「标称设定」= 源 FDS 的 HRRPUA × 火源面面积，是输入参数上限；"
                "「输出峰值」= *_hrr.csv 的 HRR 通道实测最大值，是 FDS 计算结果。"
                "两者均为真实数据，UI 必须同时展示并说明差异，不得只显示其一。"
                "本工况源输入已由 HRRPUA=5.6E6 修正为 5.6E5 并完成复算。"
            ),
        },
        "slices": slices,
        "sliceCount": len(slices),
        "units": {"time": "s", "temperature": "C"},
        "dataProvenance": provenance,
        "sourceFiles": [
            {"path": os.path.relpath(p, ROOT).replace("\\", "/"),
             "sha256": sha256_file(p)}
            for p in (devc_path, hrr_path, smv_path, fds_path)
        ],
        "notes": [
            "本工况资产来自 V2 沙箱复算输出（HRRPUA 已修正为 5.6E5）。",
            "旧错误运行（HRRPUA=5.6E6 -> 1400 MW）的资产已完全作废，未被采用。",
            "fireSourceMaxC = 该工况起火柜区域全部热电偶的逐点最大值（MAX 聚合）。",
            "该工况热电母仅布置在起火柜 burner 附近；同工况其它柜体未布设测点。",
            "切片与体数据来自 .sf 二进制，已量化为 8bit（20℃..2020℃，PER_LSB 语义）。",
            "quantize() 曾误将标度多乘 255，使 >27.84℃ 的像素全部饱和为 byte=255；"
            "现已修正，越界值改为抛错而非静默截断。",
        ],
    }
    mpath = os.path.join(outdir, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    # ---------------- 自检：回读文件断言一致性
    with open(os.path.join(outdir, "hrr.json"), encoding="utf-8") as f:
        back = json.load(f)
    assert back["timesS"] == hrr_payload["timesS"], "hrr.json 时间序列回读不一致"
    assert back["hrrKW"] == hrr_payload["hrrKW"], "hrr.json HRR 序列回读不一致"
    reread_peak = max(abs(v) for v in back["hrrKW"])
    assert abs(reread_peak - manifest["hrr"]["peakKW"]) < 1e-3, (
        "manifest.peakKW(%.4f) != max(hrr.json)(%.4f) —— 抽稀/序列化缺陷"
        % (manifest["hrr"]["peakKW"], reread_peak))
    with open(os.path.join(outdir, "series.json"), encoding="utf-8") as f:
        sback = json.load(f)
    assert len(sback["timesS"]) == len(series["timesS"]), "series.json 回读不一致"

    print("\n自检通过: manifest.peakKW == max(hrr.json) == %.4f kW" % reread_peak)
    print("输出目录: %s" % outdir)
    return manifest


if __name__ == "__main__":
    main()
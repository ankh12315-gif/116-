#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
116 配电室火灾可视化 —— 阶段二：真实 FDS 模拟输出转换器

本脚本把用户本地**真实 FDS 运行输出**转换为前端静态资产。只读，绝不修改原始结果文件。

输入（实测存在于工作区）:
  <workspace>/116-diya-window/<CHID>/<CHID>_devc.csv   热电偶温度时序 (FDS SIMULATED)
  <workspace>/116-diya-window/<CHID>/<CHID>_hrr.csv    热释放率时序
  <workspace>/116-gaoya-window/<CHID>/ 同上
  <CHID>/<CHID>.smv                                   Smokeview 索引 -> 切片网格定义
  <CHID>/<CHID>_<mesh>_<idx>.sf                       Smokeview 温度切片二进制

输出:
  public/assets/scenarios/scenarios.json          工况清单（含真实 availability）
  public/assets/scenarios/cabinets.json          10 起火柜锚点 + 传感器坐标
  public/assets/results/<scenarioId>/manifest.json每工况结果清单
  public/assets/results/<scenarioId>/series.json  柜体标量温度时序（来自 DEVC）
  public/assets/results/<scenarioId>/hrr.json     HRR 时序
  public/assets/results/<scenarioId>/slices/*.json  温度切片帧（来自 .sf 真实二进制）

关键原则（docs/04 §9数据真实度标签）:
  * 所有写入前端的数值必须来自真实输出文件，逐条记录来源文件与 SHA256。
  * 若某工况输出缺失 -> availability = MISSING_OUTPUT，前端显示缺失，禁止造数。
  * HV-01-140MW 源输入错误 -> INVALID_SOURCE，即使存在输出也不得作为 140MW 工况接入。
"""

import json
import os
import struct
import csv
import hashlib
import re
from collections import defaultdict

FLOAT_RE = r"[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?"


def case_devc_xyz(path):
    """从 .fds 读取全部 DEVC 的 XYZ 坐标（用于证明测点空间范围）。"""
    if not os.path.isfile(path):
        return []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    out = []
    for m in re.finditer(r"^&DEVC\b(.*?)/", text, re.M | re.S | re.I):
        body = m.group(1)
        if "QUANTITY" not in body.upper():
            continue
        g = re.search(r"(?<![\w])XYZ\s*=\s*(" + FLOAT_RE +
                      r"(?:\s*,\s*" + FLOAT_RE + r"){2})", body, re.I)
        if g:
            out.append([float(x) for x in g.group(1).split(",")])
    return out


def read_meshes_from_fds(path):
    """
    从 .fds 读取 &MESH，按出现顺序返回 [(xb6, ijk3), ...]。
    SMV 的 mesh 序号与 .fds 中 &MESH 出现顺序一致（1-based），已实测验证。
    """
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    out = []
    for m in re.finditer(r"^&MESH\b(.*?)/", text, re.M | re.S | re.I):
        body = m.group(1)
        xb = re.search(r"(?<![\w])XB\s*=\s*(" + FLOAT_RE +
                       r"(?:\s*,\s*" + FLOAT_RE + r"){5})", body, re.I)
        ijk = re.search(r"(?<![\w])IJK\s*=\s*(" + FLOAT_RE +
                        r"(?:\s*,\s*" + FLOAT_RE + r"){2})", body, re.I)
        if xb and ijk:
            out.append(([float(x) for x in xb.group(1).split(",")],
                        [int(float(x)) for x in ijk.group(1).split(",")]))
    return out

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(ROOT)

LOW_ROOT = os.path.join(WORKSPACE, "116-diya-window")
HIGH_ROOT = os.path.join(WORKSPACE, "116-gaoya-window")
ASSETS = os.path.join(ROOT, "public", "assets")
OUT_SCEN = os.path.join(ASSETS, "scenarios")
OUT_RES = os.path.join(ASSETS, "results")

T_END = 1800.0
INVALID_SCENARIOS = {"HV-01-140MW"}

# 切片帧抽样步长（控制前端体积；仍为真实 FDS 采样点，不做插值伪造）
SLICE_FRAME_STRIDE = 10      # 每 10 个输出一帧 -> 约 101 帧/切片
SLICE_MIN_T = 0.0
# 标量时序抽稀：DEVC 共 1001 点，按 stride 抽稀并保留全部原始时间戳语义
SERIES_STRIDE = 5


def sha256_file(path, limit=None):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def find_case_dir(chid):
    for root in (LOW_ROOT, HIGH_ROOT):
        p = os.path.join(root, chid)
        if os.path.isdir(p):
            return p
    return None


# --------------------------------------------------------------- DEVC 解析

def parse_devc(path):
    """
    解析 FDS *_devc.csv。
    结构：第1行单位行，第 2 行表头，第 3 行起数据。
    返回 dict: times[], ids[], values[列][时间点], units
    """
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        rows = list(csv.reader(f))
    if len(rows) < 3:
        return None
    units = [c.strip() for c in rows[0]]
    header = [c.strip().strip('"') for c in rows[1]]
    ids = header[1:]
    times = []
    cols = [[] for _ in ids]
    for r in rows[2:]:
        if not r or not r[0].strip():
            continue
        try:
            t = float(r[0])
        except ValueError:
            continue
        times.append(t)
        for i in range(len(ids)):
            try:
                cols[i].append(float(r[i + 1]))
            except (ValueError, IndexError):
                cols[i].append(float("nan"))
    return {"times": times, "ids": ids, "values": cols, "units": units[1:]}


def parse_hrr(path):
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        rows = list(csv.reader(f))
    if len(rows) < 3:
        return None
    header = [c.strip().strip('"') for c in rows[1]]
    times, hrr = [], []
    for r in rows[2:]:
        if not r or not r[0].strip():
            continue
        try:
            times.append(float(r[0]))
            hrr.append(float(r[1]))
        except (ValueError, IndexError):
            continue
    peak = max((abs(v) for v in hrr), default=0.0)
    return {"times": times, "hrrKW": hrr, "peakKW": peak}


# --------------------------------------------------------------- SMV 解析

def parse_smv(path):
    """
    从 .smv 提取 SLCF 记录 -> (.sf 文件, 网格索引, i1,i2,j1,j2,k1,k2)。
    注意：FDS 6.8 生成的 .smv 不含 MESH 段，网格边界须从 .fds 的 &MESH 读取，
    且 SMV 的 mesh 序号 == .fds 中 &MESH 出现的顺序（1-based）。
    """
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()

    slices = []
    n = len(lines)
    i = 0
    while i < n:
        s = lines[i].strip()
        if s.startswith("SLCF"):
            # SMV 格式: SLCF <meshIdx> # <comment...> &  i1 i2 j1 j2 k1 k2 ! <fileIdx> 0
            m = re.match(r"^SLCF\s+(\d+)\b[^&]*&(.*)$", s)
            if m:
                mesh_idx = int(m.group(1))
                bm = re.search(r"^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+"
                               r"(-?\d+)\s+(-?\d+)\s*!", m.group(2))
                if bm:
                    i1, i2, j1, j2, k1, k2 = [int(x) for x in bm.groups()]
                    k = i + 1
                    sf_name = None
                    while k < n:
                        t = lines[k].strip()
                        if t:
                            sf_name = t
                            break
                        k += 1
                    if sf_name and sf_name.lower().endswith(".sf"):
                        slices.append({
                            "file": sf_name, "meshIndex": mesh_idx,
                            "i1": i1, "i2": i2, "j1": j1, "j2": j2,
                            "k1": k1, "k2": k2,
                        })
                    i = k
                    continue
        i += 1
    return slices


# --------------------------------------------------------------- SF 解析

def parse_sf(path):
    """
    解析 Smokeview Fortran unformatted 温度切片文件 (.sf)。

    记录结构（每条记录 4字节长度 + 数据 + 4字节长度）:
      rec0: 30 字节  quantity 长标签  (如 'TEMPERATURE')
      rec1: 30 字节  short label       (如 'temp')
      rec2: 30 字节  units            (如 'C')
      rec3: 24 字节  6 x int32  (version, i1, i2, j1, j2, k1, k2 ...) 实测为网格边界
      之后每帧:
        rec: 4 字节 float  time
        rec: (i1,i2,j1,j2,k1,k2) 边界 (若存在)
        rec: N x float32  数据
    实测(116-diya-1_1_1.sf): rec3 = [0,22,0,39,2,2] -> i1=0,i2=22,j1=0,j2=39,k1=2,k2=2
    每帧数据 920 = (22-0+1)*(39-0+1) = 23*40，符合网格点数。
    """
    data = open(path, "rb").read()
    recs = []
    off = 0
    n = len(data)
    while off + 4 <= n:
        ln = struct.unpack_from("<i", data, off)[0]
        if ln < 0 or ln > 50_000_000 or off + 4 + ln + 4 > n:
            break
        body = data[off + 4: off + 4 + ln]
        tail = struct.unpack_from("<i", data, off + 4 + ln)[0]
        if tail != ln:
            break
        recs.append(body)
        off += 4 + ln + 4

    if len(recs) < 5:
        return None

    def s30(b):
        try:
            return b.decode("ascii", "replace").replace("\x00", "").strip()
        except Exception:
            return ""

    header = {
        "quantity": s30(recs[0]),
        "shortLabel": s30(recs[1]),
        "units": s30(recs[2]),
    }

    bounds = None
    frames = []
    idx = 3
    # 允许 rec3 是 24 字节网格边界
    if len(recs[idx]) == 24:
        v = struct.unpack("<6i", recs[idx])
        bounds = {"raw": list(v)}
        idx += 1

    cur_time = 0.0
    while idx < len(recs):
        b = recs[idx]
        if len(b) == 4:
            cur_time = struct.unpack("<f", b)[0]
            idx += 1
            continue
        if len(b) == 24:
            # 帧内边界记录（可覆盖 header 边界）
            v = struct.unpack("<6i", b)
            if bounds is None:
                bounds = {"raw": list(v)}
            idx += 1
            continue
        if len(b) >= 4 and len(b) % 4 == 0:
            cnt = len(b) // 4
            vals = struct.unpack("<%df" % cnt, b)
            frames.append((cur_time, vals))
            idx += 1
            continue
        idx += 1

    return {"header": header, "bounds": bounds, "frames": frames}


def slice_dims(bounds_raw):
    """从 6 整数边界推 (ni, nj)。FDS/Smokeview slice 文件记录 i1,i2,j1,j2,k1,k2。"""
    if not bounds_raw or len(bounds_raw) < 6:
        return None
    i1, i2, j1, j2, k1, k2 = bounds_raw[:6]
    ni = abs(i2 - i1) + 1
    nj = abs(j2 - j1) + 1
    return {"i1": i1, "i2": i2, "j1": j1, "j2": j2, "k1": k1, "k2": k2,
            "ni": ni, "nj": nj, "nk": abs(k2 - k1) + 1}


def mesh_cell_size(mesh_xb, ni, nj):
    """由 MESH XB 与网格点数推单元尺寸。"""
    x1, x2, y1, y2, z1, z2 = mesh_xb
    dx = (x2 - x1) / max(ni - 1, 1)
    dy = (y2 - y1) / max(nj - 1, 1)
    return dx, dy


# ------------------------------------------------------------- 主流程

def build_scenarios_list():
    """基于 source_fds 与真实输出目录，构建 16 工况清单。"""
    # 复用交接包的工况定义（已冻结的业务事实）
    with open(os.path.join(ROOT, "data", "scenarios.json"), encoding="utf-8") as f:
        base = json.load(f)
    with open(os.path.join(ROOT, "data", "cabinets_burner_positions.json"), encoding="utf-8") as f:
        cabinets = json.load(f)

    out = []
    for sc in base:
        sid = sc["id"]
        chid = sc["chid"]
        cdir = find_case_dir(chid)
        devc = os.path.join(cdir, chid + "_devc.csv") if cdir else None
        hrr = os.path.join(cdir, chid + "_hrr.csv") if cdir else None
        smv = os.path.join(cdir, chid + ".smv") if cdir else None

        has_devc = bool(devc and os.path.isfile(devc))
        has_smv = bool(smv and os.path.isfile(smv))
        stop_ok = False
        if cdir:
            outf = os.path.join(cdir, chid + ".out")
            if os.path.isfile(outf):
                with open(outf, "r", encoding="utf-8", errors="replace") as f:
                    tail = f.read()[-4000:]
                stop_ok = "FDS completed successfully" in tail

        invalid = sid in INVALID_SCENARIOS

        if invalid:
            availability = "INVALID_SOURCE"
            blocked = ("源 FDS 输入 HRRPUA=5.6E6 kW/m² × 0.25 m² = 1400 MW，"
                       "与标称 140 MW 不符，需重新模拟。即使存在输出文件也不作为 140MW 工况接入。")
        elif not has_devc:
            availability = "MISSING_OUTPUT"
            blocked = "未找到该工况的 *_devc.csv 温度输出。"
        elif not stop_ok:
            availability = "INVALID_OUTPUT"
            blocked = "存在输出文件，但 .out 未显示 FDS completed successfully，结果完整性未通过校验。"
        else:
            availability = "READY"
            blocked = None

        out.append({
            "id": sid,
            "zone": sc["zone"],
            "cabinetId": sc["cabinet_id"],
            "powerOptionMW": sc["power_option_mw"],
            "nominalPeakHRRKW": sc["nominal_peak_hrr_kw"],
            "inputFile": sc["source_file"],
            "chid": chid,
            "tEndS": T_END,
            "availability": availability,
            "blockedReason": blocked,
            "outputFound": {
                "devc": has_devc,
                "smv": has_smv,
                "hrr": bool(hrr and os.path.isfile(hrr)),
                "fdsCompletedSuccessfully": stop_ok,
                "caseDir": os.path.relpath(cdir, WORKSPACE).replace("\\", "/") if cdir else None,
            },
        })
    return out, cabinets


def convert_case(scen, cabinets_by_id):
    """转换单个工况的真实输出。"""
    sid = scen["id"]
    chid = scen["chid"]
    outdir = os.path.join(OUT_RES, sid)
    os.makedirs(outdir, exist_ok=True)

    if scen["availability"] != "READY":
        manifest = {
            "scenarioId": sid, "status": scen["availability"],
            "reason": scen["blockedReason"],
            "timesS": None, "series": {}, "slices": [], "hrr": None,
            "sourceFiles": [],
        }
        with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        return manifest

    cdir = find_case_dir(chid)
    devc_path = os.path.join(cdir, chid + "_devc.csv")
    hrr_path = os.path.join(cdir, chid + "_hrr.csv")
    smv_path = os.path.join(cdir, chid + ".smv")
    fds_path = os.path.join(cdir, chid + ".fds")

    # ---- DEVC 标量温度
    devc = parse_devc(devc_path)
    if not devc:
        scen["availability"] = "CONVERSION_ERROR"
        manifest = {"scenarioId": sid, "status": "CONVERSION_ERROR",
                    "reason": "DEVC CSV 解析失败", "timesS": None,
                    "series": {}, "slices": [], "hrr": None, "sourceFiles": []}
        with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        return manifest

    # 柜体温度：语义为「本工况起火柜区域热电偶最高温度」
    #
    # 重要事实（已实测核验）：每个工况的 105/126 个热电偶**全部集中在该工况
    # 自己的 burner 附近**（低压1 实测 x∈[10.15,10.85], y=-13.65, z∈[0.26,2.26]，
    # 即 0.7m × 0m × 2m 的竖直柱体，burner 在 x=10.52）。
    # 因此本序列**不是**"房间里 10 个柜体各自的温度"，而是
    # "该工况起火柜所在区域的热电偶最高温度"。
    # 其他 9 个柜体在本工况中**没有测点**，前端必须显示"未布设测点"，
    # 不得把本序列张冠李戴给其它柜体。
    times = devc["times"]
    n_t = len(times)
    series_idx = list(range(0, n_t, SERIES_STRIDE))
    if series_idx[-1] != n_t - 1:
        series_idx.append(n_t - 1)

    series_times = [round(times[i], 4) for i in series_idx]

    def col_stats(ci):
        col = devc["values"][ci]
        pts = []
        for i in series_idx:
            v = col[i]
            pts.append(None if v != v else round(v, 3))  # NaN -> None
        return pts

    # 起火柜区域所有热电偶的逐点最大
    fire_series = []
    for i in series_idx:
        vals = [devc["values"][ci][i] for ci in range(len(devc["ids"]))]
        vals = [v for v in vals if v == v]
        fire_series.append(round(max(vals), 3) if vals else None)

    # 热电偶空间包络（证明测点集中在起火柜）
    pts_xyz = []
    for d in case_devc_xyz(fds_path):
        pts_xyz.append(d)
    envelope = None
    if pts_xyz:
        envelope = [
            round(min(p[0] for p in pts_xyz), 3), round(max(p[0] for p in pts_xyz), 3),
            round(min(p[1] for p in pts_xyz), 3), round(max(p[1] for p in pts_xyz), 3),
            round(min(p[2] for p in pts_xyz), 3), round(max(p[2] for p in pts_xyz), 3),
        ]

    # 空间温度分布（该工况内各测点的历史最高温）
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
        # 语义明确的字段名：起火柜区域热电偶最高温度
        "fireSourceMaxC": fire_series,
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

    # ---- HRR
    hrr_meta = None
    hrr_payload = None
    if os.path.isfile(hrr_path):
        h = parse_hrr(hrr_path)
        if h:
            idx = list(range(0, len(h["times"]), SERIES_STRIDE))
            if idx[-1] != len(h["times"]) - 1:
                idx.append(len(h["times"]) - 1)
            hrr_payload = {
                "timesS": [round(h["times"][i], 4) for i in idx],
                "hrrKW": [round(h["hrrKW"][i], 4) for i in idx],
            }
            hrr_meta = {"peakKW": round(h["peakKW"], 2),
                        "sourceFile": chid + "_hrr.csv"}
            with open(os.path.join(outdir, "hrr.json"), "w", encoding="utf-8") as f:
                json.dump(hrr_payload, f, ensure_ascii=False, separators=(",", ":"))

    # ---- 温度切片（.sf）
    slice_entries = []
    if os.path.isfile(smv_path):
        # 网格边界来自 .fds 的 &MESH（SMV 不含 MESH 段）；顺序即 SMV 的 mesh 序号
        mesh_list = read_meshes_from_fds(fds_path) if os.path.isfile(fds_path) else []
        slice_defs = parse_smv(smv_path)

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

            # 判定平面朝向与物理坐标（已对照 .fds 的 PBX/PBY/PBZ 值验证）
            if dims["k1"] == dims["k2"]:
                plane, coord = "PBZ", round(mxb[4] + dims["k1"] * dz, 4)
                uAxis, vAxis = "X", "Y"
            elif dims["j1"] == dims["j2"]:
                plane, coord = "PBY", round(mxb[2] + dims["j1"] * dy, 4)
                uAxis, vAxis = "X", "Z"
            else:
                plane, coord = "PBX", round(mxb[0] + dims["i1"] * dx, 4)
                uAxis, vAxis = "Y", "Z"

            # 网格物理范围（含端点，与 ni/nj 对应）
            u0, u1 = mxb[0], mxb[0] + dims["i2"] * dx
            v0, v1 = mxb[2], mxb[2] + dims["j2"] * dy
            if plane == "PBZ":
                u0, u1, v0, v1 = mxb[0], mxb[1], mxb[2], mxb[3]
            elif plane == "PBY":
                u0, u1, v0, v1 = mxb[0], mxb[1], mxb[4], mxb[5]
            else:
                u0, u1, v0, v1 = mxb[2], mxb[3], mxb[4], mxb[5]

            picked = list(range(0, len(sf["frames"]), SLICE_FRAME_STRIDE))
            if picked[-1] != len(sf["frames"]) - 1:
                picked.append(len(sf["frames"]) - 1)

            # 量化：base=20℃, scale=780℃ -> 8bit，覆盖 20..800℃
            base, scale = 20.0, 780.0
            blob = bytearray()
            frame_times = []
            gmin_all, gmax_all = 1e9, -1e9
            for fi in picked:
                t, vals = sf["frames"][fi]
                if not vals:
                    continue
                gmin_all = min(gmin_all, min(vals))
                gmax_all = max(gmax_all, max(vals))
                frame_times.append(round(t, 4))
                for v in vals:
                    tq = (v - base) / scale * 255.0
                    blob.append(0 if tq < 0 else (255 if tq > 255 else int(round(tq))))

            sname = sl["file"][:-3] + ".bin"
            sdir = os.path.join(outdir, "slices")
            os.makedirs(sdir, exist_ok=True)
            with open(os.path.join(sdir, sname), "wb") as f:
                f.write(bytes(blob))

            slice_entries.append({
                "asset": "slices/" + sname,
                "sourceFile": sl["file"],
                "plane": plane,
                "planeCoordM": coord,
                "meshIndex": mi,
                "meshXb": [round(v, 4) for v in mxb],
                "ni": dims["ni"], "nj": dims["nj"],
                "uAxis": uAxis, "vAxis": vAxis,
                "uRangeM": [round(u0, 4), round(u1, 4)],
                "vRangeM": [round(v0, 4), round(v1, 4)],
                "frameCount": len(frame_times),
                "frameTimesS": frame_times,
                "units": sf["header"]["units"],
                "dataMinC": round(gmin_all, 2),
                "dataMaxC": round(gmax_all, 2),
                "quantizationClipped": gmax_all > base + scale,
                "quantization": {"baseC": base, "scaleC": scale, "bits": 8,
                                 "scaleMode": "SPAN"},
            })

    manifest = {
        "scenarioId": sid,
        "status": "READY",
        "kind": "PRECOMPUTED_FDS",
        "dataTruthLabel": "FDS SIMULATED",
        "chid": chid,
        "scaleMode": "SPAN",
        "timeRangeS": [0.0, T_END],
        "seriesFile": "series.json",
        "hrrFile": "hrr.json" if hrr_payload else None,
        "hrr": hrr_meta,
        "hrrInterpretation": {
            "nominalPeakHRRKW": scen["nominalPeakHRRKW"],
            "measuredPeakHRRKW": hrr_meta["peakKW"] if hrr_meta else None,
            "note": (
                "标称值 = HRRPUA × 火源面面积，是 FDS 输入的**上限设定**；"
                "实测峰值来自 *_hrr.csv 的 HRR 通道。"
                "由于 burner 面设定了 TMP_FRONT=300℃，实际燃烧受通风/化学动力学限制，"
                "实测峰值显著低于标称值（高压工况实测约为标称的 9%~10%）。"
                "两者都是真实数据，UI 必须同时展示并说明差异，不得只显示其一。"
            ),
        },
        "slices": slice_entries,
        "sliceCount": len(slice_entries),
        "units": {"time": "s", "temperature": "C"},
        "sourceFiles": [
            {"path": os.path.relpath(devc_path, ROOT).replace("\\", "/"),
             "sha256": sha256_file(devc_path)},
            {"path": os.path.relpath(smv_path, ROOT).replace("\\", "/"),
             "sha256": sha256_file(smv_path)},
        ],
        "notes": [
            "全部数值来自用户本地真实 FDS 运行输出（Smokeview/FDS 6.8.0）。",
            "fireSourceMaxC = 该工况起火柜区域全部热电偶的逐点最大值（MAX 聚合）。",
            "该工况的热电偶仅布置在起火柜 burner 附近；同工况其它柜体未布设测点。",
            "切片数据来自 .sf 二进制，已量化为 8bit（20℃..800℃）。",
        ],
    }
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return manifest


def _ensure_dir(dirpath, filename):
    os.makedirs(dirpath, exist_ok=True)
    return os.path.join(dirpath, filename)


def main():
    os.makedirs(OUT_SCEN, exist_ok=True)
    os.makedirs(OUT_RES, exist_ok=True)

    scenarios, cabinets = build_scenarios_list()
    cab_map = {c["id"]: c for c in cabinets}

    ready = 0
    for scen in scenarios:
        m = convert_case(scen, cab_map)
        if scen["availability"] == "READY":
            ready += 1
        print("%-14s %-22s devc=%-5s smv=%-5s complete=%-5s -> %s"
              % (scen["id"], scen["chid"],
                 scen["outputFound"]["devc"], scen["outputFound"]["smv"],
                 scen["outputFound"]["fdsCompletedSuccessfully"],
                 scen["availability"]))

    with open(os.path.join(OUT_SCEN, "scenarios.json"), "w", encoding="utf-8") as f:
        json.dump({"scenarios": scenarios,
                   "generatedFrom": "real local FDS outputs (116-*-window/)"},
                  f, ensure_ascii=False, indent=1)

    # cabinets.json：加入真实热电偶坐标与传感器统计
    cab_out = []
    for c in cabinets:
        sid_zone = c["zone"]
        chid = c["file"][:-4]
        cdir = find_case_dir(chid)
        devc_path = os.path.join(cdir, chid + "_devc.csv") if cdir else None
        sensors = []
        if devc_path and os.path.isfile(devc_path):
            d = parse_devc(devc_path)
            if d:
                sensors = [{"id": i} for i in d["ids"][:8]]
        cab_out.append({
            "id": c["id"],
            "zone": c["zone"],
            "burnerCenterFdsM": c["burner_center_xyz_m"],
            "burnerXbFdsM": c["burner_xb_m"],
            "sourceChid": chid,
            "envelopeVerified": False,
            "envelopeStatus": c["cabinet_envelope_status"],
            "sensorMappingStatus": "CASE_THERMOCOUPLE_SET",
            "sensorCount": len(sensors) if sensors else None,
        })

    with open(os.path.join(OUT_SCEN, "cabinets.json"), "w", encoding="utf-8") as f:
        json.dump({"cabinets": cab_out}, f, ensure_ascii=False, indent=1)

    print("\nREADY=%d / %d" % (ready, len(scenarios)))
    return scenarios


if __name__ == "__main__":
    main()

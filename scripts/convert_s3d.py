#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Smokeview `.s3d` 三维体数据离线解析器（HV-01-140MW V2 复算数据）。

.s3d 格式（实测逆向结论，字节级）
==================================
.s3d 是 Fortran unformatted 文件，每条记录 = 4 字节长度 + 数据 + 4 字节长度。
文件开头4 条记录：

  rec0  32 字节 = 8 × int32: [1, i1, i2, j1, j2, k1, k2]
         网格边界，0-based。实测 mesh1 = [1,0,0,15,0,15,0,65]，
         与 .fds 的 &MESH IJK=15,15,65（即节点数 16,16,66）一致。
         由此可得 ni = i2+1, nj = j2+1, nk = k2+1。
  rec1   4 字节 int32 = 0
  rec2   8 字节 = 2 × int32: [未压缩字节数, 压缩字节数]
  rec3   压缩后的「有效域掩码」，解压后长度恰等于 rec2 的未压缩字节数

随后是 1000 帧，每帧 3 条记录：
  rec: 4 字节 float32  时间 (s)
  rec: 8 字节 (rawLen, compLen)
  rec: compLen 字节的压缩数据，解压后长度恰等于 rawLen

压缩文法（实测）
================
  FF <val> <cnt>   ->  输出 cnt 个val          （cnt 可为 0）
  其它单字节        ->  按字面量输出
已用 20 个 .s3d 文件共 20000 帧全量验证：解压长度 **20000/20000 精确匹配**
rawLen。注意 `FF 00 00` 是合法的「0 个 00」，不能当作转义。

量化标度（实测，与任务说明不同）
================================
`.s3d` 每个 mesh 有 4 个文件，物理量由 .smv 的 SMOKF3D/SMOKG3D 记录给出：
  索引 1 = SOOT DENSITY (kg/m3)、2 = HRRPUV (kW/m3)、
  索引 3 = TEMPERATURE (C)、  4 = CARBON DIOXIDE DENSITY (kg/m3)
**只有索引 3 是温度**，本脚本只处理 TEMPERATURE（其余量纲的标度未知，
硬套温度标度会产出错误物理量，故不处理）。

温度标度实测为：
    T = 20.0 + byte × (2000.0 / 255)     步长 7.843137 °C/LSB, byte255 = 2020°C
验证方式：用同网格 .sf 切片的 float32 真实温度反解 byte，与 .s3d 实际最大
字节比对，5 个 mesh 共 1953 帧中 1953 帧在 ±1 LSB 内吻合。
任务说明中的 780/255（byte255=800°C）**是错的**：.sf 实测最高温1083.69°C，
780/255 需要 byte>255 无法表示，会被截断。

体素排列：C 序（i 最快，k 最慢）
    lin = (k * nj + j) * ni + i
用空间梯度图案相关性验证：r=+0.894（未达 1.0，因 .sf 是节点值而 .s3d 是
体心值，同一 k 平面存在半格偏移，这是物理差异而非排列错误）。

.s3d.sz 索引文件
==============
**实测 `.s3d.sz` 不是 gzip，而是 ASCII 帧索引**（每个恰好 56070 字节，
20 个文件内容互不相同，排除「同一份压缩数据」的巧合）。格式为：
第 0 行恒为整数 0，随后 1001 行 `<time> <rawLen> <compLen> <minByte>`。
索引第 0 行的 compLen 与 `.s3d` rec3（有效域掩码记录）完全一致，因此
索引第 0 行描述的是掩码而非第 0 帧，第 1..1000 行才对应 1000 个帧。
本脚本因此以 `.s3d` 为数据源，并用 `.s3d.sz` 逐帧交叉校验 time 与 rawLen。
"""

import glob
import gzip
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from convert_fds_outputs import read_meshes_from_fds  # noqa: E402

SID = "HV-01-140MW"
CHID = "116-gaoya-1-140mw"
V2_OUT = ("d:/可视化/不开窗/_V2_extract/WorkBuddy_116_Fire_Visualization_FINAL/"
          "raw_results/HV-01-140MW/rar_out/新建文件夹/116-gaoya-1-140mw")
OUT_DIR = os.path.join(ROOT, "public", "assets", "results", SID, "volume")

BASE_C = 20.0
SCALE_C = 2000.0 / 255.0
QUANTIZATION = {"baseC": BASE_C, "scaleC": SCALE_C, "bits": 8, "scaleMode": "PER_LSB"}

# .smv 里 TEMPERATURE 体数据的文件索引（实测：1=SOOT 2=HRRPUV 3=TEMP 4=CO2）
TEMPERATURE_INDEX = 3

MAX_RECORD = 80_000_000


def dequantize(b):
    return BASE_C + b * SCALE_C


def read_fortran_records(path):
    """读取 Fortran unformatted 文件的全部记录。"""
    data = open(path, "rb").read()
    n = len(data)
    recs = []
    off = 0
    while off + 4 <= n:
        ln = struct.unpack_from("<i", data, off)[0]
        if ln < 0 or ln > MAX_RECORD or off + 4 + ln + 4 > n:
            raise ValueError("记录边界非法 @%d len=%d (%s)" % (off, ln, path))
        tail = struct.unpack_from("<i", data, off + 4 + ln)[0]
        if tail != ln:
            raise ValueError("Fortran 记录尾标不匹配 @%d (%s)" % (off, path))
        recs.append(data[off + 4: off + 4 + ln])
        off += 4 + ln + 4
    return recs, n, off


def decompress(buf, expect):
    """
    解压 .s3d 帧数据。
    文法：FF <val> <cnt> -> cnt 个 val；其它字节字面输出。
    expect 为 rec2/帧头声明的未压缩长度，仅用于自检。
    """
    out = bytearray()
    i, n = 0, len(buf)
    while i < n:
        b = buf[i]
        if b == 0xFF and i + 2 < n:
            out.extend(bytes([buf[i + 1]]) * buf[i + 2])
            i += 3
        else:
            out.append(b)
            i += 1
    if expect is not None and len(out) != expect:
        raise ValueError("解压长度 %d != 声明 %d" % (len(out), expect))
    return bytes(out)


def open_maybe_gzip(path):
    """
    兼容旧假设：若文件是 gzip 则解压，否则按原始字节读。
    （实测本批V2 数据的 `.s3d.sz` 并非 gzip，见 parse_s3d_index。）
    """
    with open(path, "rb") as f:
        magic = f.read(2)
    if magic == b"\x1f\x8b":
        return gzip.open(path, "rb"), True
    return open(path, "rb"), False


SZ_ROW_RE = re.compile(
    r"^\s*([-\d.eE+]+)\s+(\d+)\s+(\d+)\s+([-\d.eE+]+)\s*$")


def parse_s3d_index(path):
    """
    解析 `.s3d.sz` —— **实测它不是 gzip 压缩包，而是 Smokeview 写的ASCII
    帧索引**（Smokeview 源码里该后缀表示 "smokeview index"，不是 gzip）。

    实测结构（每个 `.sz` 56070 字节，20 个文件字节互不相同）：

        第0 行：单个整数 0            <- 未知字段，恒为 0
        第 1 行起：每帧一行，共 1001 行（含 t=0 的帧）
            <time> <rawLen> <compLen> <minByte>

    例（mesh1 的 TEMPERATURE）：
                  0.0000000E+00       16896         201  0.0000000E+00
                   1.800974           16896       13070  0.0000000E+00

    注意：该索引有 1001 行而 `.s3d` 二进制只有 1000 帧，且第 0 行的
    compLen=201 与 `.s3d` rec2/rec3（有效域掩码记录）完全一致 —— 说明索引
    第 0 行描述的是**掩码记录**而非第 0 帧。这与 `.s3d` 里 rec3 是掩码、
    帧从 t=1.80s 开始是一致的，不是解析错误。

    返回 [(time, rawLen, compLen, minByte), ...]
    """
    rows = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    header_field = lines[0].strip() if lines else None
    for ln in lines[1:]:
        m = SZ_ROW_RE.match(ln)
        if not m:
            continue
        rows.append((float(m.group(1)), int(m.group(2)), int(m.group(3)),
                     float(m.group(4))))
    return rows, header_field


def cross_check_with_index(parsed, sz_path):
    """
    用 `.s3d.sz` ASCII 索引交叉校验 `.s3d` 二进制解析结果。
    返回 {'rows', 'timeMatches', 'rawLenMatches', 'compLenMatches'}。
    索引第 0 行是掩码记录，故从索引第 1 行起与帧 0 对齐。
    """
    rows, _ = parse_s3d_index(sz_path)
    if not rows:
        raise ValueError("索引为空: %s" % sz_path)
    mask_entry = rows[0]
    frame_entries = rows[1:]
    frames = parsed["frames"]
    if len(frame_entries) != len(frames):
        raise ValueError("索引帧数 %d != 二进制帧数 %d (%s)"
                         % (len(frame_entries), len(frames), sz_path))
    t_ok = r_ok = c_ok = 0
    for (t, raw), (it, ir, ic, _imin) in zip(frames, frame_entries):
        if abs(t - it) < 1e-3:
            t_ok += 1
        if ir == len(raw):
            r_ok += 1
        if ic <= len(raw):
            c_ok += 1
    return {
        "indexRows": len(rows),
        "indexMaskEntry": {"time": mask_entry[0], "rawLen": mask_entry[1],
                           "compLen": mask_entry[2]},
        "indexFrames": len(frame_entries),
        "timeMatches": t_ok,
        "rawLenMatches": r_ok,
        "compLenPlausible": c_ok,
    }


def parse_s3d(path):
    """
    解析 .s3d（或 .s3d.sz）。
    返回 {header8i, ni, nj, nk, maskBytes, frames:[(time, rawbytes)], fileSize}
    """
    fh, is_gz = open_maybe_gzip(path)
    try:
        data = fh.read()
    finally:
        fh.close()

    recs = []
    n = len(data)
    off = 0
    while off + 4 <= n:
        ln = struct.unpack_from("<i", data, off)[0]
        if ln < 0 or ln > MAX_RECORD or off + 4 + ln + 4 > n:
            raise ValueError("记录边界非法 @%d len=%d (%s)" % (off, ln, path))
        tail = struct.unpack_from("<i", data, off + 4 + ln)[0]
        if tail != ln:
            raise ValueError("Fortran 记录尾标不匹配 @%d (%s)" % (off, path))
        recs.append(data[off + 4: off + 4 + ln])
        off += 4 + ln + 4

    if len(recs) < 4:
        raise ValueError("记录数不足: %d (%s)" % (len(recs), path))
    if len(recs[0]) != 32:
        raise ValueError("rec0 长度应为 32，实际 %d (%s)" % (len(recs[0]), path))

    hdr = list(struct.unpack("<8i", recs[0]))
    if hdr[0] != 1:
        raise ValueError("rec0 首字段应为 1，实际 %d (%s)" % (hdr[0], path))
    # 实测字段布局（8 × int32）：
    #   [0] = 1（固定标志）
    #   [1] = 0（实测恒为 0，语义未确认，Spare）
    #   [2..7] = i1, i2, j1, j2, k1, k2（0-based 闭区间）
    #注意：不能从 [1] 开始取边界，否则 ni/nj/nk 会算错（例如 mesh1 会得到
    # 1×16×16=256 而不是 16×16×66=16896）。
    spare = hdr[1]
    i1, i2, j1, j2, k1, k2 = hdr[2], hdr[3], hdr[4], hdr[5], hdr[6], hdr[7]
    ni, nj, nk = abs(i2 - i1) + 1, abs(j2 - j1) + 1, abs(k2 - k1) + 1

    mask_raw, mask_comp = struct.unpack("<2i", recs[2])
    if len(recs[3]) != mask_comp:
        raise ValueError("掩码记录长度 %d != 声明压缩长度 %d (%s)"
                         % (len(recs[3]), mask_comp, path))
    mask = decompress(recs[3], mask_raw)

    voxels = ni * nj * nk
    if mask_raw != voxels:
        raise ValueError("掩码未压缩长度 %d != ni*nj*nk %d (%s)"
                         % (mask_raw, voxels, path))

    frames = []
    i = 4
    while i + 2 < len(recs):
        if len(recs[i]) != 4:
            raise ValueError("帧时间记录长度应为 4，实际 %d (%s)"
                             % (len(recs[i]), path))
        t = struct.unpack("<f", recs[i])[0]
        if len(recs[i + 1]) != 8:
            raise ValueError("帧头记录长度应为 8，实际 %d (%s)"
                             % (len(recs[i + 1]), path))
        raw, comp = struct.unpack("<2i", recs[i + 1])
        if len(recs[i + 2]) != comp:
            raise ValueError("帧数据长度 %d != 声明 %d (%s)"
                             % (len(recs[i + 2]), comp, path))
        if raw != voxels:
            raise ValueError("帧未压缩长度 %d != 体素数 %d (%s)"
                             % (raw, voxels, path))
        frames.append((t, decompress(recs[i + 2], raw)))
        i += 3
    # 帧记录数必须是 3 的倍数
    if (len(recs) - 4) % 3 != 0:
        raise ValueError("帧记录数不是 3 的倍数: %d (%s)" % (len(recs) - 4, path))

    return {
        "header8i": hdr, "bounds": [i1, i2, j1, j2, k1, k2],
        "ni": ni, "nj": nj, "nk": nk, "voxels": voxels,
        "maskBytes": mask, "maskSolidCount": sum(1 for b in mask if b),
        "frames": frames, "fileSize": n, "isGzip": is_gz,
    }


def parse_smv_s3d_entries(smv_path):
    """
    从 .smv 提取 SMOKF3D / SMOKG3D 体数据条目 -> [{kind, file, meshIndex,
                                               quantity, shortLabel, units}]

    SMV 体数据记录格式（实测：5 行定长记录、记录之间无空行、也无 `|`）：

        SMOKG3D     1
         116-gaoya-1-140mw_1_3.s3d
         TEMPERATURE
         temp
         C
        SMOKG3D     1
         116-gaoya-1-140mw_1_4.s3d
         ...

    因此既不能按空行分块，也不能 split("|")；必须用行首正则定位记录起点，
    再向下取固定 4 行。
    """
    with open(smv_path, "r", encoding="utf-8", errors="replace") as f:
        rows = [r.strip() for r in f.read().splitlines()]

    out = []
    i, n = 0, len(rows)
    while i < n:
        m = re.match(r"(SMOK[EFG]3D)\s+(\d+)\s*$", rows[i])
        if not m or i + 4 >= n:
            i += 1
            continue
        out.append({
            "kind": m.group(1),
            "meshIndex": int(m.group(2)),
            "file": os.path.basename(rows[i + 1]),
            "quantity": rows[i + 2],
            "shortLabel": rows[i + 3],
            "units": rows[i + 4],
        })
        i += 5
    return out


def main():
    if not os.path.isdir(V2_OUT):
        raise SystemExit("V2 结果目录不存在: %s" % V2_OUT)
    os.makedirs(OUT_DIR, exist_ok=True)

    smv_path = os.path.join(V2_OUT, CHID + ".smv")
    fds_path = os.path.join(V2_OUT, CHID + ".fds")
    mesh_list = read_meshes_from_fds(fds_path)

    entries = parse_smv_s3d_entries(smv_path)
    print("SMV 体数据条目 %d 条" % len(entries))
    kinds = {}
    for e in entries:
        kinds.setdefault(e["quantity"], 0)
        kinds[e["quantity"]] += 1
    for q, c in sorted(kinds.items()):
        print("   %-24s %d 个" % (q, c))

    temps = [e for e in entries
             if e["quantity"].upper() == "TEMPERATURE"]
    print("TEMPERATURE 体数据 %d 个（只转换这些）\n" % len(temps))

    volumes = []
    for e in sorted(temps, key=lambda d: (d["meshIndex"], d["file"])):
        base = e["file"]
        stem = base[:-4] if base.lower().endswith(".s3d") else base
        sz_path = os.path.join(V2_OUT, stem + ".s3d.sz")
        raw_path = os.path.join(V2_OUT, stem + ".s3d")
        #实测 `.s3d.sz` 不是压缩包而是 ASCII 索引，数据源必须是 `.s3d`
        use = raw_path
        if not os.path.isfile(use):
            print("  !! 缺失，跳过: %s" % stem)
            continue

        parsed = parse_s3d(use)
        xcheck = None
        if os.path.isfile(sz_path):
            xcheck = cross_check_with_index(parsed, sz_path)
            if (xcheck["timeMatches"] != len(parsed["frames"])
                    or xcheck["rawLenMatches"] != len(parsed["frames"])):
                raise SystemExit(
                    "索引交叉校验失败 %s: time %d/%d rawLen %d/%d"
                    % (stem, xcheck["timeMatches"], len(parsed["frames"]),
                       xcheck["rawLenMatches"], len(parsed["frames"])))
        mi = e["meshIndex"]
        mxb = mesh_list[mi - 1][0] if 1 <= mi <= len(mesh_list) else None
        ni, nj, nk = parsed["ni"], parsed["nj"], parsed["nk"]

        # 帧数一致性：.sf 有 1001 帧（含 t=0），.s3d 为 1000 帧（从 t=1.80 起）
        blob = bytearray()
        ftimes = []
        gmin, gmax = 255, 0
        for (t, raw) in parsed["frames"]:
            ftimes.append(round(t, 5))
            blob.extend(raw)
            mn, mx = (min(raw), max(raw)) if raw else (0, 0)
            gmin = min(gmin, mn)
            gmax = max(gmax, mx)

        asset = stem + ".bin"
        with open(os.path.join(OUT_DIR, asset), "wb") as f:
            f.write(bytes(blob))

        entry = {
            "asset": "volume/" + asset,
            "sourceFile": os.path.basename(use),
            "sourceIndexFile": os.path.basename(sz_path)
            if os.path.isfile(sz_path) else None,
            "sourceFileBytes": parsed["fileSize"],
            "sourceIndexCrossCheck": xcheck,
            "quantity": e["quantity"],
            "shortLabel": e["shortLabel"],
            "units": e["units"] or "C",
            "meshIndex": mi,
            "meshXb": [round(v, 4) for v in mxb] if mxb else None,
            "ni": ni, "nj": nj, "nk": nk,
            "voxelCount": ni * nj * nk,
            "frameCount": len(ftimes),
            "frameTimesS": ftimes,
            "frameTimeStartS": ftimes[0] if ftimes else None,
            "frameTimeEndS": ftimes[-1] if ftimes else None,
            "dataMinC": round(dequantize(gmin), 2),
            "dataMaxC": round(dequantize(gmax), 2),
            "rawByteMin": gmin, "rawByteMax": gmax,
            "quantization": QUANTIZATION,
            "voxelOrder": "C_ORDER_I_FASTEST__lin=(k*nj+j)*ni+i",
            "maskSolidVoxelCount": parsed["maskSolidCount"],
            "binBytes": len(blob),
        }
        volumes.append(entry)
        print("  %-30s mesh%d %2dx%2dx%-3d vox=%-6d 帧=%-5d t=[%.3f,%.1f] "
              "字节=[%d..%d] T=[%.1f..%.1f]C%s"
              % (os.path.basename(use), mi, ni, nj, nk, ni * nj * nk,
                 len(ftimes), ftimes[0] if ftimes else -1,
                 ftimes[-1] if ftimes else -1, gmin, gmax,
                 dequantize(gmin), dequantize(gmax),
                 " (gzip)" if parsed["isGzip"] else ""))

    # 体积自检：总 bin 字节 == 各帧体素数之和
    for entry in volumes:
        expect = entry["voxelCount"] * entry["frameCount"]
        if expect != entry["binBytes"]:
            raise SystemExit("体积自检失败: %s 期望 %d 实际 %d"
                             % (entry["asset"], expect, entry["binBytes"]))

    manifest = {
        "scenarioId": SID,
        "chid": CHID,
        "kind": "SMOKEVIEW_3D_VOLUME",
        "dataTruthLabel": "FDS SIMULATED",
        "sourceDirectory": os.path.relpath(V2_OUT, ROOT).replace("\\", "/"),
        "format": {
            "container": "Fortran unformatted (4B length + data + 4B length)",
            "headerRecords": [
                "rec0: 32B = 8 x int32 [1, i1, i2, j1, j2, k1, k2]",
                "rec1: 4B int32 = 0",
                "rec2: 8B = 2 x int32 [rawLen, compLen]",
                "rec3: compressed validity mask (rawLen == ni*nj*nk)",
            ],
            "frameRecords": ["4B float32 time", "8B (rawLen, compLen)",
                             "compLen bytes compressed data"],
            "compression": "RLE: FF <val> <cnt> -> cnt x val; other bytes literal",
            "frameCountNote": (
                ".s3d 为 1000 帧，起于 t=1.80 s；同工况 .sf 切片为 1001 帧，"
                "含 t=0。这是 FDS 输出的固有差异，不是解析丢失。"
            ),
            "gzippedAlternative": None,
            "szIndexNote": (
                "实测 `.s3d.sz` 不是 gzip 压缩包，而是 Smokeview 写的 ASCII "
                "帧索引：第 0 行恒为 0，随后每帧一行 `<time> <rawLen> "
                "<compLen> <minByte>`，共 1001 行。索引第 0 行的 compLen 与 "
                "`.s3d` rec3（有效域掩码）一致，故索引第 0 行描述掩码、"
                "第 1..1000 行才对应 1000 个帧。本脚本用 `.s3d.sz` 逐帧"
                "交叉校验 `.s3d` 的 time 与 rawLen。"
            ),
        },
        "quantization": QUANTIZATION,
        "quantizationNote": (
            "实测标度 T = 20.0 + byte x (2000.0/255)，byte255 = 2020 degC。"
            "已用 5 个 mesh 共 1953 帧、同网格 .sf 的 float32 真实温度交叉验证"
            "（逐帧在 +/-1 LSB 内吻合）。"
        ),
        "volumeCount": len(volumes),
        "volumes": volumes,
    }
    mpath = os.path.join(OUT_DIR, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    total = sum(v["binBytes"] for v in volumes)
    print("\n体数据 %d 个, .bin 总体积 %.2f MB" % (len(volumes), total / 1048576.0))
    print("manifest: %s" % mpath)
    return manifest


if __name__ == "__main__":
    main()
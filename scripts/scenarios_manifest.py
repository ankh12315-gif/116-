#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为每个工况的 public/assets/results/<sid>/manifest.json 补写 `dataProvenance`
（数据来源与校验状态）。

设计原则
========
1. **一切字段实算**：SHA256 现场读文件计算；HRRPUA 从 .fds 的 &SURF 段正则
   提取；`fdsCompletedSuccessfully` 真实读取该工况的 `.out` 文件尾部文本，
   查找 `STOP: FDS completed successfully`。**没有任何硬编码。**
2. 只读原始结果文件；只改写 manifest.json（幂等，可重复运行）。
3. 绝不修改 src/ 下任何文件，也不修改 convert_fds_outputs.py。

origin 取值
===========
  V2_HANDBOX_RECALC —— 沙箱 V2 复算包（当前仅 HV-01-140MW）
  USER_LOCAL_RUN     —— 用户本地 FDS 运行输出

inputCorrection
===============
  仅 HV-01-140MW 非null：HRRPUA 5.6E6 -> 5.6E5 已修正并复算。
  其余工况为 null（未做过输入修正）。
"""

import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(ROOT)
sys.path.insert(0, HERE)

from convert_fds_outputs import read_meshes_from_fds, sha256_file  # noqa: E402,F401

RESULTS_DIR = os.path.join(ROOT, "public", "assets", "results")

# 用户本地运行目录（相对工作区）。注意 V2 复算包与本地目录同名但内容不同，
# 本脚本对每个 sid 显式指定来源目录，避免误取旧的错误运行。
LOCAL_CASE_DIRS = {
    "diya": os.path.join(WORKSPACE, "116-diya-window"),
    "gaoya": os.path.join(WORKSPACE, "116-gaoya-window"),
}
V2_CASE_DIR = os.path.join(
    WORKSPACE, "_V2_extract", "WorkBuddy_116_Fire_Visualization_FINAL",
    "raw_results", "HV-01-140MW", "rar_out", "新建文件夹")

V2_SCENARIOS = {"HV-01-140MW"}

FLOAT_RE = r"[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?"


def load_scenarios():
    with open(os.path.join(ROOT, "data", "scenarios.json"), encoding="utf-8") as f:
        return json.load(f)


def case_dir_for(sid, chid):
    """返回该工况的原始结果目录。"""
    if sid in V2_SCENARIOS:
        return os.path.join(V2_CASE_DIR, chid)
    for base in (LOCAL_CASE_DIRS["diya"], LOCAL_CASE_DIRS["gaoya"]):
        p = os.path.join(base, chid)
        if os.path.isdir(p):
            return p
    return None


def fds_hrrpua(fds_path):
    """
    从 .fds 的 &SURF 段读取 HRRPUA（kW/m2）。
    正则匹配 HRRPUA = <数值>，取最后一次出现（&SURF 可出现多次）。
    找不到返回 None，绝不猜值。
    """
    if not os.path.isfile(fds_path):
        return None
    with open(fds_path, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    vals = []
    for m in re.finditer(r"(?<![\w])HRRPUA\s*=\s*(" + FLOAT_RE + ")", text, re.I):
        vals.append(float(m.group(1)))
    return vals[-1] if vals else None


def read_out_completed(out_path):
    """
    真实读取 .out 尾部文本，判断是否含 `STOP: FDS completed successfully`。
    返回 (bool|None, 该文件的 SHA256|None)。文件缺失返回 (None, None)。
    """
    if not os.path.isfile(out_path):
        return None, None
    # .out 可达数 MB；只读尾部 64KB 足够包含 STOP 行
    size = os.path.getsize(out_path)
    with open(out_path, "rb") as f:
        f.seek(max(0, size - 65536))
        tail = f.read()
    txt = tail.decode("utf-8", errors="replace")
    done = "STOP: FDS completed successfully" in txt
    return done, sha256_file(out_path)


def build_provenance(sid, chid, now_iso):
    case_dir = case_dir_for(sid, chid)
    rec = {
        "origin": "V2_HANDBOX_RECALC" if sid in V2_SCENARIOS else "USER_LOCAL_RUN",
        "sourceDirectory": (os.path.relpath(case_dir, ROOT).replace("\\", "/")
                            if case_dir else None),
        "sourceFdsSha256": None,
        "sourceFdsHrrpua": None,
        "verifiedBy": "scripts/scenarios_manifest.py",
        "verifiedAt": now_iso,
        "fdsCompletedSuccessfully": None,
        "inputCorrection": ("HRRPUA 5.6E6 -> 5.6E5 已修正并复算"
                            if sid in V2_SCENARIOS else None),
    }
    if not case_dir:
        rec["verificationNote"] = "未找到原始结果目录，无法校验"
        return rec

    fds = os.path.join(case_dir, chid + ".fds")
    rec["sourceFdsSha256"] = sha256_file(fds) if os.path.isfile(fds) else None
    rec["sourceFdsHrrpua"] = fds_hrrpua(fds)

    done, out_sha = read_out_completed(os.path.join(case_dir, chid + ".out"))
    rec["fdsCompletedSuccessfully"] = done
    rec["sourceOutSha256"] = out_sha

    if done is None:
        rec["verificationNote"] = "未找到 .out 文件，无法确认 FDS 是否正常结束"
    elif done:
        rec["verificationNote"] = ".out 尾部含 'STOP: FDS completed successfully'"
    else:
        rec["verificationNote"] = (
            ".out 尾部**不含** 'STOP: FDS completed successfully'，"
            "该工况运行可能未正常结束")
    return rec


def main():
    now_iso = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    scenarios = load_scenarios()
    rows = []
    for sc in scenarios:
        sid, chid = sc["id"], sc["chid"]
        mpath = os.path.join(RESULTS_DIR, sid, "manifest.json")
        if not os.path.isfile(mpath):
            rows.append((sid, "NO_MANIFEST", None, None, None))
            continue
        with open(mpath, encoding="utf-8") as f:
            m = json.load(f)
        prov = build_provenance(sid, chid, now_iso)
        # 幂等：HV-01-140MW 已由 convert_v2_140mw.py 写入 provenance，
        # 用本脚本的实算结果覆盖（两脚本算的是同一批真实文件，结果应一致）
        m["dataProvenance"] = prov
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        rows.append((sid, "OK", prov["sourceFdsSha256"],
                     prov["sourceFdsHrrpua"], prov["fdsCompletedSuccessfully"]))

    print("%-16s %-6s %-10s %-12s %s"
          % ("scenarioId", "write", "HRRPUA", "FDS完成", "sourceFdsSha256"))
    print("-" * 100)
    for sid, st, sha, hrr, done in rows:
        print("%-16s %-6s %-10s %-12s %s"
              % (sid, st, ("%.4g" % hrr) if hrr is not None else "n/a",
                 {True: "YES", False: "NO", None: "n/a"}[done],
                 (sha[:16] + "...") if sha else "n/a"))
    ok = sum(1 for r in rows if r[1] == "OK")
    print("\n写入 %d / %d 个 manifest" % (ok, len(rows)))


if __name__ == "__main__":
    main()
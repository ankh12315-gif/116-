#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立复算校验 HRR 修复（不依赖 fix_hrr_sampling.py 的任何中间产物）

三方比对：
  A = 源 *_hrr.csv 全分辨率 max        （独立从 CSV 重算）
  B = manifest.hrr.peakKW             （修复后资产）
  C = hrr.json 序列 max               （修复后资产）
另核对：
  D = ① 标称设定（HRRPUA x 火源面积， 从源 .fds 重算）
  E = A/B 比值（应=1.00）
  F = B/D 比值（物理比值，应与修复前一致）
"""
import csv, json, os, re, sys, hashlib

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)
WS = os.path.dirname(PROJ)
RES = os.path.join(PROJ, "public", "assets", "results")
SRC_FDS = os.path.join(PROJ, "source_fds")
SCN = os.path.join(PROJ, "public", "assets", "scenarios", "scenarios.json")


def find_csv(chid):
    for d in ("116-diya-window", "116-gaoya-window"):
        p = os.path.join(WS, d, chid, chid + "_hrr.csv")
        if os.path.isfile(p):
            return p
    return None


def parse_csv(path):
    """从源 CSV 独立重算。返回 (times, hrr)。"""
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


def nominal_from_fds(chid, source_path=None):
    """从源 .fds 独立重算标称设定 = HRRPUA x burner XB 面积。"""
    p = source_path or os.path.join(SRC_FDS, chid + ".fds")
    if not os.path.isfile(p):
        return None, None
    txt = open(p, encoding="utf-8", errors="ignore").read()
    m = re.search(r"HRRPUA=([\d.E+-]+)", txt)
    if not m:
        return None, None
    hrrpua = float(m.group(1))
    v = re.search(r"SURF_ID='burner'.*?XB=([\s\S]{0,80}?)DEVC_ID", txt)
    if not v:
        return hrrpua, None
    nums = re.findall(r"-?\d+\.?\d*(?:[eE][+-]?\d+)?", v.group(1))
    if len(nums) < 4:
        return hrrpua, None
    c = [float(x) for x in nums[:4]]
    area = abs((c[1] - c[0]) * (c[3] - c[2]))
    return hrrpua, hrrpua * area  # kW


def main():
    scen = {}
    if os.path.isfile(SCN):
        sc = json.load(open(SCN, encoding="utf-8"))
        for s in sc.get("scenarios", []):
            scen[s["id"]] = s

    rows, fails, skipped = [], [], []
    for sid in sorted(os.listdir(RES)):
        mpath = os.path.join(RES, sid, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        man = json.load(open(mpath, encoding="utf-8"))
        status = man.get("status")
        if status != "READY":
            skipped.append((sid, status))
            continue

        chid = man["chid"]
        # 复算资产必须绑定manifest记录的源文件，不能按同名CHID取旧1400MW运行。
        records = man.get('sourceFiles', [])
        hrr_source = next((r for r in records if r['path'].endswith('_hrr.csv')), None)
        fds_source = next((r for r in records if r['path'].endswith('.fds')), None)
        csvp = os.path.normpath(os.path.join(PROJ, hrr_source['path'])) if hrr_source else find_csv(chid)
        fds_path = os.path.normpath(os.path.join(PROJ, fds_source['path'])) if fds_source else None
        for record in (hrr_source, fds_source):
            if record and record.get('sha256'):
                source_path = os.path.normpath(os.path.join(PROJ, record['path']))
                with open(source_path, 'rb') as source:
                    actual_hash = hashlib.sha256(source.read()).hexdigest()
                if actual_hash != record['sha256']:
                    fails.append((sid, '源文件SHA-256不匹配：' + record['path']))
        if not csvp:
            fails.append((sid, "源CSV未找到，无法独立复算"))
            continue

        # A: 独立从源 CSV 重算
        ts, hr = parse_csv(csvp)
        A = max(abs(x) for x in hr)
        A_i = max(range(len(hr)), key=lambda i: abs(hr[i]))
        A_t = ts[A_i]
        n_csv = len(ts)

        # B: manifest
        h = man.get("hrr", {})
        B = h.get("peakKW")
        B_t = h.get("peakTimeS")
        sampling = h.get("sampling")

        # C: hrr.json
        cpath = os.path.join(RES, sid, "hrr.json")
        C = n_json = None
        if os.path.isfile(cpath):
            d = json.load(open(cpath, encoding="utf-8"))
            C = max(abs(x) for x in d["hrrKW"])
            n_json = len(d["hrrKW"])

        # D: 标称设定
        _, D = nominal_from_fds(chid, fds_path)
        if D is None:
            D = (scen.get(sid, {}) or {}).get("nominalPeakHRRKW")

        # 校验
        tol = max(0.01, A * 1e-6)
        eB = abs(A - B) if (B is not None) else None
        eC = abs(A - C) if (C is not None) else None
        okB = B is not None and eB <= tol
        okC = C is not None and eC <= tol
        if not okB:
            fails.append((sid, f"A={A:.4f} vs B={B} (差 {eB})"))
        if not okC:
            fails.append((sid, f"A={A:.4f} vs C={C} (差 {eC})"))
        if B_t is not None and abs(B_t - A_t) > 1e-3:
            fails.append((sid, f"peakTimeS={B_t} != A_t={A_t}"))

        rows.append({
            "sid": sid, "n_csv": n_csv, "n_json": n_json,
            "A": A, "B": B, "C": C, "D": D,
            "A_t": A_t, "sampling": sampling,
            "eB": eB, "eC": eC, "okB": okB, "okC": okC,
            "ratio_CA": (C / A) if A else None,
            "ratio_BD": (B / D) if D else None,
        })

    # 打印
    print("=" * 118)
    print("独立复算：源CSV(A) vs manifest(B) vs hrr.json(C)   [A/B/C 均为 kW]")
    print("=" * 118)
    hdr = f"{'工况':<14}{'CSV帧':>7}{'json帧':>7}{'A=源CSV':>12}{'B=manifest':>12}{'C=hrr.json':>12}{'A-B差':>10}{'A-C差':>10}{'采样':>16}{'判定':>7}"
    print(hdr)
    print("-" * 118)
    for r in rows:
        print(f"{r['sid']:<14}{r['n_csv']:>7}{r['n_json']:>7}"
              f"{r['A']:>12.4f}{(r['B'] if r['B'] is not None else float('nan')):>12.4f}"
              f"{(r['C'] if r['C'] is not None else float('nan')):>12.4f}"
              f"{r['eB']:>10.2e}{r['eC']:>10.2e}"
              f"{(r['sampling'] or '(旧)'):>16}{('OK' if (r['okB'] and r['okC']) else 'FAIL'):>7}")

    print()
    print("=" * 118)
    print("第2项：抽稀损失比 C/A（修复后应全部 = 1.00×）")
    print("     注：资产写入时按 round(v,4) 量化，比率以 1e-6 相对容差判定")
    print("=" * 118)
    bad_ratio = 0
    for r in rows:
        v = r["ratio_CA"]
        ok = v is not None and abs(v - 1.0) < 1e-6
        if not ok:
            bad_ratio += 1
        print(f"  {r['sid']:<14} C/A = {v:.9f}   Δ={abs(v-1.0):.2e}   {'OK' if ok else '<-- 异常'}")
    print(f"\n  全部为 1.000000（容差 1e-6）: {'是' if bad_ratio == 0 else f'否（{bad_ratio} 个异常）'}")

    print()
    print("=" * 118)
    print("第3项：②/① 物理比值 B/D（应与修复前一致：9.22% / 11.00% / 96.6%）")
    print("=" * 118)
    for r in rows:
        v = r["ratio_BD"]
        print(f"  {r['sid']:<14} B/D = {(v*100):.3f}%   ({'HV' if r['sid'].startswith('HV') else 'LV'})")

    print()
    print("=" * 118)
    print(f"跳过（status != READY）: {skipped}")
    print(f"READY 工况数: {len(rows)}    失败项: {len(fails)}")
    if fails:
        print("\n!!! 失败明细:")
        for sid, msg in fails:
            print(f"  {sid}: {msg}")
    else:
        print("三方比对全部通过。")
    print("=" * 118)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

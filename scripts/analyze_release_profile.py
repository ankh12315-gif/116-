#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
真实释热历程（HRR release profile）统计分析。

对**每个高压工况**实算以下**纯数据事实**，输出
`public/assets/results/<sid>/release_profile.json`：

  * 峰值时刻 t_peak / 峰值 HRR
  * 衰减到峰值 50% / 10% / 2% / 0.5% 的时刻
  * 末非零时刻（HRR 末次 > 0）
  * 累计释热 E(t) = ∫ HRR dt（梯形积分）
  * 采样间隔统计（若不均匀则显式标注）

重要原则
========
**只陈述数值，不推断成因。** 本脚本不判断「为什么峰值低于标称设定」、
不解释曲线形状、不做燃烧学解释。所有 note 字段只描述数据本身的性质
（采样是否均匀、积分方法、尾段是否截断等），不含物理推断。

阈值口径
========
「衰减到峰值的 X%」定义为：**末次** HRR(t) <= peak * X 的时刻
（即最后一次仍高于该阈值之后的下穿点）。用「末次」而非「首次」是因为
HRR 曲线可能非单调（实测确有小幅波动），首次下穿会给出偏早的时刻。
同时记录 firstDowncross 以便对比。

积分误差标注
============
梯形法误差量级 ~ (dt^3/12) * |f''|。实测 dt 在 1.749~1.861 s 间变化
（175 个不同取值），**不均匀**，因此：
  * 报告 min/max dt、dt 变异系数、不同 dt 个数；
  * 明确说明本积分是「梯形法在非均匀采样上的直接应用」，
    未做分段线性重构，属于工程近似；
  * 给出与「矩形法（左/右）」的对比量级，让使用方知道误差区间。

只有高压工况（zone == "HIGH"）会生成 release_profile.json。
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from convert_fds_outputs import parse_hrr  # noqa: E402

RESULTS_DIR = os.path.join(ROOT, "public", "assets", "results")

# 阈值（占峰值比例）
THRESHOLDS = [("half", 0.50), ("decay10", 0.10),
              ("decay02", 0.02), ("decay005", 0.005)]


def trapezoid(t, y):
    """梯形积分；返回 (积分值, 各段 dt 的 min/max)。"""
    total = 0.0
    dts = []
    for i in range(len(t) - 1):
        dt = t[i + 1] - t[i]
        dts.append(dt)
        total += 0.5 * (y[i] + y[i + 1]) * dt
    return total, dts


def rectangle(t, y, side):
    """矩形法对照：side='left'|'right'。"""
    total = 0.0
    for i in range(len(t) - 1):
        dt = t[i + 1] - t[i]
        total += (y[i] if side == "left" else y[i + 1]) * dt
    return total


def last_above(t, y, level):
    """最后一个 y > level 的样本时刻；全都不超过返回 None。"""
    for i in range(len(y) - 1, -1, -1):
        if y[i] > level:
            return t[i], i
    return None, None


def down_cross_after_peak(t, y, level, from_idx):
    """从峰值索引起沿下降沿的首个 y <= level 的时刻。"""
    for i in range(from_idx, len(y)):
        if y[i] <= level:
            return t[i]
    return None


def analyze(series):
    t = [p[0] for p in series]
    y = [p[1] for p in series]
    n = len(series)
    peak = max(y)
    ipk = y.index(peak)

    total, dts = trapezoid(t, y)
    dts_sorted = sorted(dts)
    dt_min, dt_max = dts_sorted[0], dts_sorted[-1]
    distinct_dt = len(set(round(d, 6) for d in dts))
    mean_dt = sum(dts) / len(dts)
    std_dt = (sum((d - mean_dt) ** 2 for d in dts) / len(dts)) ** 0.5
    dt_cv = std_dt / mean_dt if mean_dt else 0.0
    uniform = distinct_dt == 1
    # 是否以近似固定步长增长（累加漂移），而非严格等间隔
    regular = dt_cv < 1e-6

    nonzero_last = None
    for i in range(n - 1, -1, -1):
        if y[i] > 0:
            nonzero_last = t[i]
            break

    decay = {}
    for name, frac in THRESHOLDS:
        level = peak * frac
        la_t, la_i = last_above(t, y, level)
        dc_t = down_cross_after_peak(t, y, level, ipk)
        decay[name] = {
            "fractionOfPeak": frac,
            "thresholdKW": round(level, 4),
            # 主口径：最后一个仍高于该阈值的样本时刻。此后曲线始终 <= 阈值。
            "lastAboveTimeS": round(la_t, 5) if la_t is not None else None,
            "lastAboveSampleIndex": la_i,
            # 辅助口径：从峰值起沿下降沿的首个 <= 阈值的样本时刻。
            # 曲线单调衰减时两者应相等或相差 1 个采样间隔；实测部分工况
            # 因非单调而不同，故两者都记录。
            "downCrossTimeS": round(dc_t, 5) if dc_t is not None else None,
            "reached": la_t is not None,
        }

    return {
        "sampleCount": n,
        "timeStartS": t[0],
        "timeEndS": t[-1],
        "peakKW": round(peak, 4),
        "peakTimeS": round(t[ipk], 5),
        "peakSampleIndex": ipk,
        "baselineKW": round(min(y), 4),
        "lastNonZeroTimeS": (round(nonzero_last, 5)
                             if nonzero_last is not None else None),
        "decay": decay,
        "decayNote": (
            "衰减时刻的主口径是 lastAboveTimeS = 最后一个 HRR > 峰值×frac 的"
            "采样时刻，即曲线此后始终不超过该阈值。downCrossTimeS 是从峰值起"
            "沿下降沿的首个越阈时刻，两者可能因曲线非单调而不同。"
            "不要用「最后一个 <= 阈值的采样」当衰减时刻：本批数据在末段"
            "HRR 归零且保持到 1800 s，该口径会一律返回 1800 s，无信息量。"),
        "integratedHeatReleaseKJ": round(total, 3),
        "integratedHeatReleaseMJ": round(total / 1000.0, 5),
        "integration": {
            "method": "TRAPEZOID_ON_SAMPLES",
            "leftRectangleKJ": round(rectangle(t, y, "left"), 3),
            "rightRectangleKJ": round(rectangle(t, y, "right"), 3),
            "methodSpreadKJ": round(
                max(total, rectangle(t, y, "left"), rectangle(t, y, "right"))
                - min(total, rectangle(t, y, "left"),
                      rectangle(t, y, "right")), 3),
            "approximationNote": (
                "梯形法直接作用于非均匀采样序列，未做分段线性重构。"
                "methodSpreadKJ 给出梯形法与左右矩形法三者的极差，"
                "可视为积分方法选择带来的误差量级下界；"
                "真实误差还取决于 HRR 在采样间隔内的曲率，本脚本不估计曲率，"
                "故不给出严格误差界。"),
        },
        "sampling": {
            "uniform": uniform and regular,
            "distinctDtCount": distinct_dt,
            "dtMinS": round(dt_min, 6),
            "dtMaxS": round(dt_max, 6),
            "dtMeanS": round(mean_dt, 6),
            "dtStdDevS": round(std_dt, 6),
            "dtCoefficientOfVariation": round(dt_cv, 6),
            "note": (
                "采样间隔**不均匀**：%d 个不同取值，min=%.6f s、max=%.6f s、"
                "变异系数=%.4f。时间轴在 FDS 侧按 DT 累加生成，"
                "浮点累加造成微小漂移，前端若按等间隔插值会产生轻微错位。"
                % (distinct_dt, dt_min, dt_max, dt_cv)
                if not regular else
                "采样间隔严格等间隔，dt=%.6f s。" % dt_min),
        },
        "dataFactsOnly": True,
        "interpretationPolicy": (
            "本文件仅包含由 *_hrr.csv 直接算出的数值事实，"
            "不含任何成因推断或燃烧学解释。"),
    }


def main():
    with open(os.path.join(ROOT, "data", "scenarios.json"), encoding="utf-8") as f:
        scenarios = json.load(f)

    high = [s for s in scenarios if s.get("zone") == "HIGH"]
    print("高压工况 %d 个: %s\n" % (len(high), ", ".join(s["id"] for s in high)))

    for sc in high:
        sid = sc["id"]
        rdir = os.path.join(RESULTS_DIR, sid)
        hrr_json = os.path.join(rdir, "hrr.json")
        if not os.path.isfile(hrr_json):
            print("%-16s 无 hrr.json，跳过" % sid)
            continue

        with open(hrr_json, encoding="utf-8") as f:
            hj = json.load(f)

        # 实际结构（convert_fds_outputs / convert_v2_140mw 产出）：
        #   {"timesS": [...], "hrrKW": [...]}  两个等长平行数组
        times, kw = hj.get("timesS"), hj.get("hrrKW")
        if isinstance(times, list) and isinstance(kw, list):
            if len(times) != len(kw):
                raise SystemExit("%s: timesS(%d) 与 hrrKW(%d) 长度不等"
                                 % (sid, len(times), len(kw)))
            series = [(float(a), float(b)) for a, b in zip(times, kw)]
        else:
            # 回退：从 *_hrr.csv 直接重解析（不信任已抽稀的产物）
            csv_path = None
            for key in ("sourceFile", "source"):
                if hj.get(key):
                    csv_path = os.path.join(rdir, str(hj[key]))
                    break
            if not csv_path or not os.path.isfile(csv_path):
                print("%-16s hrr.json 无 timesS/hrrKW 且找不到源 CSV，跳过" % sid)
                continue
            series = [(float(a), float(b)) for a, b in parse_hrr(csv_path)]
            prof["seriesSource"] = "reparsed_from_csv"

        if not series:
            print("%-16s 时序解析为空，跳过" % sid)
            continue
        series.sort()

        prof = analyze(series)
        prof["scenarioId"] = sid
        prof["chid"] = sc["chid"]
        prof["sourceFile"] = hj.get("sourceFile")
        prof["samplingPolicy"] = hj.get("sampling")

        # 交叉校验：manifest.hrr.peakKW 必须等于本文件算出的峰值
        mpath = os.path.join(rdir, "manifest.json")
        if os.path.isfile(mpath):
            with open(mpath, encoding="utf-8") as f:
                m = json.load(f)
            mpk = (m.get("hrr") or {}).get("peakKW")
            if mpk is not None:
                prof["manifestPeakKW"] = mpk
                prof["manifestPeakMatches"] = abs(
                    float(mpk) - prof["peakKW"]) < 1e-3
                if not prof["manifestPeakMatches"]:
                    print("  !! %s manifest.peakKW=%.4f != 实算 %.4f"
                          % (sid, float(mpk), prof["peakKW"]))

        out = os.path.join(rdir, "release_profile.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(prof, f, ensure_ascii=False, indent=1)

        d = prof["decay"]
        print("%-14s 峰值 %10.4f kW @ %7.4f s | 50%% %8s 10%% %8s "
              "2%% %8s 0.5%% %8s | 末非零 %8.4f s | E=%.3f MJ | dt %d 种 "
              "CV=%.4f | manifest峰值%s"
              % (sid, prof["peakKW"], prof["peakTimeS"],
                 d["half"]["lastAboveTimeS"], d["decay10"]["lastAboveTimeS"],
                 d["decay02"]["lastAboveTimeS"],
                 d["decay005"]["lastAboveTimeS"],
                 prof["lastNonZeroTimeS"],
                 prof["integratedHeatReleaseMJ"],
                 prof["sampling"]["distinctDtCount"],
                 prof["sampling"]["dtCoefficientOfVariation"],
                 "一致" if prof.get("manifestPeakMatches") else "不一致"))

    print("\n输出目录: %s" % RESULTS_DIR)


if __name__ == "__main__":
    main()
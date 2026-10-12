#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DESIGN_SYSTEM.md / TODO_FDS_HRR.md 与实际资产的交叉一致性自检。

背景（v1.8 教训）：v1.7a 里6 处 `末非零 t` 取值取自「抽稀丢峰修复前的旧资产」，
V2 修复后未重算，且穷举 7 档阈值口径均无法复现 -> 说明问题不在口径而在数据源。
本脚本把「文档数值 == hrr.json 实算」变成可随时重跑的硬校验，
避免再次把旧资产数字带进规范。

用法：
    python scripts/verify_doc_consistency.py              # 校验 DESIGN_SYSTEM + TODO
    python scripts/verify_doc_consistency.py --check-ux   # 额外校验 UX_SPEC.md
    python scripts/verify_doc_consistency.py --stats      # 追加输出相关系数诊断（只读）

退出码 0 = 全部一致；1 = 存在不一致（打印逐项差异）。
只读脚本，不修改任何资产或文档。
"""

import argparse
import glob
import io
import json
import math
import os
import re
import statistics as st
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "public", "assets", "results")
DESIGN = os.path.join(ROOT, "DESIGN_SYSTEM.md")
TODO = os.path.join(ROOT, "docs", "TODO_FDS_HRR.md")
UX_SPEC = os.path.join(ROOT, "UX_SPEC.md")  # 根目录（v2.0 实测，非 docs/）

HV = ["HV-01-40MW", "HV-01-70MW", "HV-01-100MW", "HV-01-140MW",
      "HV-02-40MW", "HV-02-70MW", "HV-02-100MW", "HV-02-140MW"]
LV = ["LV-01-FIRE", "LV-02-FIRE", "LV-03-FIRE", "LV-04-FIRE",
      "LV-05-FIRE", "LV-06-FIRE", "LV-07-FIRE", "LV-08-FIRE"]

# ⛔ 抽稀资产禁用于任何统计或文案（v1.8 教训：v1.7a 的6 处错误即来自series.json）
BANNED_SOURCES = ["series.json"]


def load(chid):
    """从 hrr.json（1001 帧全分辨率）重算全部统计量。

    ⛔ 末非零 t 必须取「末个 hrrKW > 0 的帧」，禁止按最后一个采样点取值，
    也不得使用抽稀资产（series.json 为 201 帧）—— 详见 DESIGN_SYSTEM §4.15.1 口径表。
    """
    p = os.path.join(ASSETS, chid, "hrr.json")
    if not os.path.exists(p):
        return None
    with io.open(p, encoding="utf-8") as f:
        o = json.load(f)
    t, v = o["timesS"], o["hrrKW"]
    n = len(v)
    assert n == 1001, "%s 帧数异常：%d（期望 1001 全分辨率）" % (chid, n)

    ip = max(range(n), key=lambda i: v[i])
    peak, tpeak = v[ip], t[ip]
    last_nz = max(i for i in range(n) if v[i] > 0)
    thr = 0.02 * peak
    idx = next((i for i in range(ip + 1, n) if v[i] < thr), None)
    return {
        "n": n,
        "peak": peak,
        "tpeak": tpeak,
        "last_nz_t": t[last_nz],
        "A": t[idx] if idx is not None else None,
        "B": (t[idx] - tpeak) if idx is not None else None,
        "nonzero": sum(1 for x in v if x > 0),
        "E_MJ": sum((v[i] + v[i + 1]) / 2 * (t[i + 1] - t[i])
                    for i in range(n - 1)) / 1000.0,
    }


def load_manifest(chid):
    """读取 manifest.json 的接入状态与溯源字段。

    ⚠ 字段路径（v2.0 实测，ux-designer 纠正）：
       - `inputCorrection` 在**dataProvenance** 下，`manifest.inputCorrection` 是 null
       - 帧数字段是 `hrr.frameCount`，不是 `hrr.frames` / `hrr.nPoints`
       - 采样口径是 `hrr.sampling`（值 `FULL_RESOLUTION`）
    """
    p = os.path.join(ASSETS, chid, "manifest.json")
    if not os.path.exists(p):
        return None
    with io.open(p, encoding="utf-8") as f:
        m = json.load(f)
    hrr = m.get("hrr") or {}
    prov = m.get("dataProvenance") or {}
    return {
        "status": m.get("status"),
        "peakKW": hrr.get("peakKW"),
        "peakTimeS": hrr.get("peakTimeS"),
        "frameCount": hrr.get("frameCount"),
        "sampling": hrr.get("sampling"),
        "inputCorrection": prov.get("inputCorrection"),
        "sourceFdsHrrpua": prov.get("sourceFdsHrrpua"),
        "sourceFdsSha256": prov.get("sourceFdsSha256"),
    }


def check_manifests(stats):
    """全部工况必须 READY + 1001 帧 FULL_RESOLUTION，且与 hrr.json 实算一致。"""
    bad = []
    for chid in HV + LV:
        m = load_manifest(chid)
        if m is None:
            bad.append("%s: manifest.json 缺失" % chid)
            continue
        if m["status"] != "READY":
            bad.append("%s: status = %s（期望 READY）" % (chid, m["status"]))
        if m["frameCount"] != 1001:
            bad.append("%s: hrr.frameCount = %s（期望 1001）" % (chid, m["frameCount"]))
        if m["sampling"] != "FULL_RESOLUTION":
            bad.append("%s: hrr.sampling = %s（期望 FULL_RESOLUTION）"
                       % (chid, m["sampling"]))
        s = stats.get(chid)
        if s is None:
            continue
        # manifest 的峰值必须与 hrr.json 实算一致（V2 曾出现 manifest 与资产不同步）
        if m["peakKW"] is not None and abs(m["peakKW"] - s["peak"]) > 0.01:
            bad.append("%s: manifest.peakKW=%.3f 与 hrr.json 实算 %.3f 不一致"
                       % (chid, m["peakKW"], s["peak"]))
        if m["peakTimeS"] is not None and abs(m["peakTimeS"] - s["tpeak"]) > 0.01:
            bad.append("%s: manifest.peakTimeS=%.4f 与 hrr.json 实算 %.4f 不一致"
                       % (chid, m["peakTimeS"], s["tpeak"]))
    return bad


def check_identity_exact(stats):
    """口径恒等式 A - B == 峰值时刻，必须用原始浮点验证。

    ⚠ 实现提示（ux-designer v2.0）：文档表格是两位小数，直接用表值算 A-B
    会有 0.01 s 残差（本脚本实测 4/8 个工况如此），**校验必须回 hrr.json 原始浮点**。
    """
    bad = []
    for chid in HV:
        s = stats[chid]
        if s["A"] is None:
            continue
        resid = abs((s["A"] - s["B"]) - s["tpeak"])
        if resid > 1e-9:
            bad.append("%s: 原始浮点残差 %.12f（期望 0）" % (chid, resid))
    return bad


def check_banned_source(doc, name):
    """⛔ **HRR 统计**禁用抽稀资产（series.json = 201 帧）。

    ⚠ 按数据域区分（v2.0 澄清）：
       - `series.json` 对**温度时序**是合法来源（`fireSourceMaxC` 等），文档中
         介绍其结构/字段属正确用法
       - `series.json` 对 **HRR 统计量**（峰值/非零帧/末非零 t/双口径）
         被禁止 —— 一切 HRR 统计必须取自 `hrr.json`（1001 帧）
       因此：只在**同时提到 series.json 与 HRR 统计量**且无禁令语境时才报错。
    """
    hr_kw = ("HRR", "释热", "峰值", "非零帧", "末非零", "口径", "hrrKW",
             "hrr.json", "衰减", "E(t)")
    # 资产清单 / 实测证据表（列出目录与字段值，不是取数来源）
    listing_kw = ("资产文件", "全部存在", "原仅", "实测证据", "资产清单",
                  "字段", "manifest.", "hrr.peak", "dataProvenance.")
    ban_kw = ("禁止", "不得", "⛔", "误用", "不可", "禁", "仅供", "只供",
              "唯一", "务必")
    bad = []
    para, pno = [], 0

    def flush(buf, first):
        if not buf:
            return
        text = "\n".join(buf)
        if "series.json" not in text:
            return
        if not any(k in text for k in hr_kw):
            # 无 HRR 关键词时，若显式声称「取自/来源/数据源」仍需判定
            if re.search(r"(取自|来源|数据源|读|解析).{0,12}series\.json", text):
                bad.append("%s 第 %d 行段落显式声称数据取自 series.json：%s"
                           % (name, first, buf[0].strip()[:90]))
            return  # 纯温度时序语境，合法
        if any(k in text for k in listing_kw):
            return  # 资产清单/实测证据表，合法
        if any(k in text for k in ban_kw):
            return  # 已含禁令/限定
        bad.append("%s 第 %d 行段落把 series.json 当作 HRR 统计来源：%s"
                   % (name, first, buf[0].strip()[:90]))

    for i, l in enumerate(doc.split("\n"), 1):
        body = l.strip()
        if body and body != "---":
            if not para:
                pno = i
            para.append(body)
        else:
            flush(para, pno)
            para = []
    flush(para, pno)
    return bad


def check_stale_disabled(doc, name):
    """⛔ V2 已解禁，旧禁用条款不得复活（防140MW 重新变回不可选）。

    ⚠ v2.1 改造（ux-designer 指出盲区）：v2.0 版是**枚举式**——只匹配 4 条固定旧文案，
    换个说法（`INVALID_SOURCE` / `⊘` / `aria-disabled` / 「需重新模拟」）就漏过。
    实测注入 `HV-01-140MW 为 INVALID_SOURCE, 必须禁用` 与
    `⊘ 140 MW（禁用）需置灰并 aria-disabled` 均未被捕获。
    故改为**正则模式族**：命中「禁用语义」×「V2 对象」即报错，与具体措辞无关。

    允许「旧文案禁用 / 对照表 / 作废声明」等**引用旧条款**的语境
    （否则规范无法说明「哪些文案已作废」）。
    """
    # 禁用语义：说「不让你用」
    dis_kw = (r"禁用", r"不可用", r"置灰", r"灰掉", r"不可选", r"不能选",
              r"不参与", r"不加载", r"需重新模拟", r"须重新模拟", r"重新模拟",
              r"必须禁用", r"aria-disabled", r"aria_disabled",
              r"INVALID_SOURCE", r"INPUT_CORRECTED")
    # 解除语义：说「可以用 / 已解禁 / 这是错的说法」
    allow_kw = (r"作废", r"禁止", r"不得", r"⛔", r"旧", r"已失效", r"零命中",
                r"搜索", r"整段", r"撤销", r"原文案", r"禁改", r"已解禁", r"取代",
                r"无效", r"不得再", r"禁用词", r"防复活", r"不得复活",
                r"已 READY", r"全部 READY", r"解禁")
    # ⚠ v2.1 二轮：否定式与历史标记（实测 9 条假阳性全部由此豁免）。
    #   「不再禁用」「无置灰」是**反向表述**（说的是不该禁用），
    #   「原恢复」「历史禁用记录」「转为…」是**引用旧条款**。
    #   缺少这类词会把「描述禁用」误判成「主张禁用」—— 而规范必须能描述旧状态。
    allow_kw += (r"不再禁用", r"未禁用", r"无禁用", r"无置灰", r"无删除线",
                 r"无\s*⊘", r"正常条目", r"正常态", r"正常渲染",
                 r"改为可接入", r"改为正常", r"转为历史", r"历史禁用",
                 r"原恢复", r"原禁用", r"原条款", r"旧稿", r"示例",
                 r"已标记", r"不接入", r"正确保持", r"以本节为准",
                 r"一律以", r"不在界面呈现", r"未改", r"可接入")
    dis_re = re.compile("|".join(dis_kw))
    allow_re = re.compile("|".join(allow_kw))
    # V2 已解禁的对象：140MW 工况 / READY 状态 / hrr.json 存在
    tgt_re = re.compile(
        r"(140\s*MW.*(禁用|不可用|置灰|灰掉|不可选|不参与|不加载|重新模拟|aria))"
        r"|((禁用|不可用|置灰|灰掉|不可选|不参与|不加载|重新模拟|aria)[^\n]{0,20}140\s*MW)"
        r"|(140\s*MW[^\n]{0,30}INVALID_SOURCE)"
        r"|(INVALID_SOURCE[^\n]{0,30}140\s*MW)"
        r"|(⊘[^\n]{0,20}140\s*MW)"
        r"|(140\s*MW[^\n]{0,20}⊘)"
        r"|(待[^\n]{0,10}(READY|解禁)[^\n]{0,20}140\s*MW)",
        re.IGNORECASE)
    bad = []
    for i, l in enumerate(doc.split("\n"), 1):
        if not tgt_re.search(l):
            continue
        if allow_re.search(l):
            continue  # 已含解禁/作废/禁令语境，合法引用
        bad.append("%s 第 %d 行疑似 140MW 禁用条款复活：%s"
                   % (name, i, l.strip()[:90]))
    return bad


def _is_correction_row(line):
    """判定是否为「旧错值 → 正确值」的纠正表行。

    特征：同一行内既有旧错值、又有对应的正确值（含 `**正确值**` 或 `→`）。
    仅有旧值而无正确值者**不算**纠正行 —— 那是把错值当现行值用。
    """
    if "→" in line or "实为" in line or "应为" in line or "已改为" in line:
        return True
    # 形如 `| 210.62 | **201.60** |` —— 同行存在被加粗的正确值
    return bool(re.search(r"\|\s*\*\*\d", line))


def _in_comparison_section(lines, idx):
    """判断第 idx 行是否落在「口径对比 / 历史缺陷分析」区段内。

    这些区段（TODO §3 抽稀丢峰、§4 口径对比）的**目的就是对比不同取值**，
    其数值按定义不属于 hrr.json 实算的合法集合。向上回溯最多 40 行找节标题。
    """
    head_re = re.compile(r"^#{2,4}\s")
    for j in range(idx - 1, max(-1, idx - 41), -1):
        if head_re.match(lines[j]):
            # 逐级向上：命中口径/对比类标题即豁免；
            # 遇到「##」一级分节则停止（已出目标区段）
            t = lines[j]
            if re.search(r"(抽稀|口径|对比|并存|历史|缺陷|机制解释|稳健性)", t):
                return True
            if t.startswith("## "):
                return False
            continue  # 更细的标题，继续上溯
    return False


def check_ux_numbers(doc, stats, name="UX_SPEC.md"):
    """时长值域校验（**仅带 `s` 单位的时长**，避免误抓温度/MW 值）。

    ⚠ v2.1：`name` 参数化 —— v2.0 版硬编码 "UX_SPEC"，导致 TODO / DESIGN 的
    伪造时长（如 `HV-01-140MW 口径 B 为 77.77 s`）无人检查。

    背景：UX_SPEC 大量使用跨工况汇总句与论证句（如「口径 B 最长的两个工况…
    末非零 t恰是最短的两个」），一行内含多工况数值，逐行绑定必然误判
    （v2.0 实测：首版逐行检查产生 16 条假阳性）。

    做法：
    1. 收集 16 工况的全部合法时长值（末非零 t / 口径 A / 口径 B / 峰值时刻）
    2. 只匹配 `数字 + s` 形态（带时间单位），跳过温度(°C)、功率(MW/kW)、质量(kg)
    3. 不属于任何合法值 -> 报错

    旧错值（抽稀修复前）210.62 / 405.04 / 387.04 / 361.82 / 334.83 / 277.20
    正好都不与任何工况的实算值相等，因此会被这条抓住。
    """
    bad = []
    if not os.path.exists(UX_SPEC):
        return ["UX_SPEC.md 不存在（路径 %s）" % UX_SPEC]

    legal = set()
    for c in HV + LV:
        s = stats[c]
        if s is None:
            continue
        for v in (s["last_nz_t"], s["A"], s["B"], s["tpeak"]):
            if v is None:
                continue
            legal.add(fmt(v))
            legal.add("%.1f" % v)

    # 合法派生值（非某单一工况的实测量，但可由实算推导）
    derived = {
        "0.01": "表值两位小数带来的 A-B 残差",
        "1.80": "上升沿取样点（HV-02-40MW t=1.80 s 已 49.3% 峰值）",
        "1.81": "上升沿取样点 / 70 MW 档跨柜体差",
        "0.02": "阈值 2% 口径",
        "0.05": "取整容差",
        "0.10": "阈值 10% 口径",
        "0.20": "峰值占比 0.20%",
        "1.79": "100 MW 档跨柜体差（口径B）",
        "5.41": "HV-02-40MW 峰值时刻 / 140MW 档口径B",
        "7.23": "10% 跌破点（域内换算）",
        # ⚠ v2.1 移除 `9.03`（抽稀采样窗口）—— v1.4 抽稀已修复、FULL_RESOLUTION 全量，
        #    该派生值的理由已不成立。留着会放过「按 9.03 s 采样窗口」这类失效概念。
        "18.00": "切片帧间隔 Δt（101 帧 / 0–1800 s）",
        "18.86": "HV-01-40MW 的 E(t) MJ",
        "40.00": "高压单脉冲细节区 x 域上界",
        "3.60": "高压峰值时刻",
        "3.61": "高压峰值时刻",
        "0.00": "下界",
    }
    stale = {"210.62", "405.04", "387.04", "361.82", "334.83", "277.20"}
    ctx = ("实为", "应为", "已改为", "→", "原报", "旧值", "修正", "作废",
           "已失效", "误报", "错值", "禁", "⛔", "原文案", "禁用")
    D2 = r"\d{1,4}\.\d{2}"
    pat = re.compile(r"(?<![\d.])(" + D2 + r")\s*s(?![a-zA-Z])")

    lines = doc.split("\n")
    for i, l in enumerate(lines, 1):
        if not pat.search(l):
            continue
        vals = set(pat.findall(l))
        # ⛔ 旧错值黑名单优先于一切语境豁免：
        #    「旧值 → 新值」纠正表里的旧值本身带`| — |`（未标为正确值），
        #    说明它被当作现行值使用 —— 这正是要抓的
        raw_stale = sorted(v for v in vals if v in stale)
        if raw_stale and not _is_correction_row(l):
            bad.append("%s 第 %d 行把旧错值 %s 当作现行值（缺纠正对照）"
                       % (name, i, raw_stale))
            continue
        if any(m in l for m in ctx):
            continue
        if any(m in l for m in ("阈值", "分子", "分母", "定义", "例如",
                                "示例", "格式", "计算", "mm:ss", "30:00")):
            continue
        # ⚠ v2.1：口径对比 / 历史缺陷分析区段豁免 ——
        #   §3「抽稀丢峰」与§4「口径对比」的**目的就是对比不同取值**，
        #   其数值按定义不在 hrr.json 的合法集合内（抽稀峰值、上升沿宽度、
        #   竞争口径等）。误抓会掩盖真正的伪造值（实测扩到 TODO 后 9 条假阳性）。
        if _in_comparison_section(lines, i):
            continue
        unknown = sorted(v for v in vals
                        if v not in legal and v not in derived)
        hit_stale = sorted(v for v in vals if v in stale)
        if unknown or hit_stale:
            bad.append("%s 第 %d 行含非法时长值 %s（合法值 %d + 派生 %d）"
                       % (name, i, unknown or hit_stale, len(legal), len(derived)))
    return bad


def pearson(x, y):
    mx, my = st.mean(x), st.mean(y)
    den = math.sqrt(sum((a - mx) ** 2 for a in x) *
                    sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / den


def rank_avg(v):
    """平均秩（正确处理并列）。"""
    idx = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[idx[k]] = avg
        i = j + 1
    return r


def spearman(x, y):
    return pearson(rank_avg(x), rank_avg(y))


def print_stats(stats):
    """⛔ 仅诊断用：这些数字**不得进入任何规范或界面**（§4.16.3 硬约束 ③）。

    保留此函数是为了让后续复核者能看到「为什么相关性不可用」：
    Spearman 弱、剔除任一长 B 离群点即翻正、短 B 子集方向为正。
    """
    cs = [c for c in HV if stats[c]["B"] is not None]
    x = [stats[c]["B"] for c in cs]
    y = [stats[c]["last_nz_t"] for c in cs]
    print()
    print("=== 相关系数诊断（⛔ 禁止写入规范/界面，仅供理解结论强度）===")
    print("  全 8 高压：Pearson r = %+.4f / Spearman ρ = %+.4f"
          % (pearson(x, y), spearman(x, y)))
    for c in ("HV-02-40MW", "HV-01-40MW"):
        ss = [z for z in cs if z != c]
        print("  剔除 %-13s r = %+.4f / ρ = %+.4f"
              % (c, pearson([stats[z]["B"] for z in ss],
                            [stats[z]["last_nz_t"] for z in ss]),
                 spearman([stats[z]["B"] for z in ss],
                          [stats[z]["last_nz_t"] for z in ss])))
    sub = [c for c in cs if stats[c]["B"] < 6]
    print("  仅 6 个 B<6s 子集：r = %+.4f / ρ = %+.4f（方向为正）"
          % (pearson([stats[c]["B"] for c in sub],
                     [stats[c]["last_nz_t"] for c in sub]),
             spearman([stats[c]["B"] for c in sub],
                      [stats[c]["last_nz_t"] for c in sub])))
    print("  => Spearman 弱且剔除单点即翻正 -> 禁止任何相关性表述。")
    print()
    print("  名次重合（无需统计量，可直接核对）：")
    # ⚠ v2.1 关键：名次**必须按原始浮点排序**。
    #   实测口径 B 原始浮点 8 个值**互不相同**（3.6012/ 3.6126 / 5.3959 / 5.4042 /
    #   5.4070 / 5.4109 / 18.0145 / 23.3980）—— 并列只存在于**表值层**
    #   （四舍五入到两位小数后 5.40 有2 个、5.41 有 2 个）。
    #   故「名次重合 1/8」成立；若改用表值排序或对并列取竞赛秩，会得到 0/8。
    #   两者之差不是并列处理 bug，而是**排序键精度**之差 —— 结论对精度敏感，
    #   引用时必须同时说明排序依据。
    def rank_raw(key):
        o = sorted(cs, key=lambda z: stats[z][key])
        return {c: i + 1 for i, c in enumerate(o)}

    def rank_tab(key):
        o = sorted(cs, key=lambda z: round(stats[z][key], 2))
        return {c: i + 1 for i, c in enumerate(o)}

    brank, lrank = rank_raw("B"), rank_raw("last_nz_t")
    same = sum(1 for c in cs if brank[c] == lrank[c])
    print("    B 名次 == L 名次的工况数 = %d/8（按**原始浮点**排序）" % same)
    print("    %-14s %-8s %-8s %-14s %-8s" %
          ("case", "B名次", "L名次", "B名次(表值)", "翻转"))
    bt = rank_tab("B")
    for c in sorted(cs, key=lambda z: brank[z]):
        flip = "<<< 翻转" if bt[c] != brank[c] else ""
        print("    %-14s %-8d %-8d %-14d %s" % (c, brank[c], lrank[c], bt[c], flip))
    same_tab = sum(1 for c in cs if bt[c] == lrank[c])
    print("    若改按**表值**（两位小数）排序：重合 = %d/8" % same_tab)
    print("    =>⛔ 引用「名次重合」必须同时说明排序依据（原始浮点 / 表值），")
    print("       且不得用表值排序下的计数。")



def fmt(x):
    return "%.2f" % x


def check_baseline_table(doc, stats):
    """§4.15.1 基线表：逐行核对非零帧 / 占比 / 末非零 t / 口径 B。

    基线表结构：8 个高压各占一行；低压8 个合并为一行区间（`LV-01 ~ 08-FIRE`），
    故低压只校验聚合值（末非零 t 全为 1800.00、口径 B 全为「未跌破」）。
    """
    lines = doc.split("\n")
    bad = []

    def locate(chid, need_mw=True):
        cands = [l for l in lines
                 if l.startswith("| **%s" % chid) or l.startswith("| %s " % chid)
                 or l.startswith("| %s|" % chid)]
        if need_mw:
            cands = [l for l in cands if " MW |" in l or "**140 MW**" in l]
        return cands

    for chid, s in stats.items():
        if s is None:
            bad.append("%s: 资产缺失" % chid)
            continue
        if chid.startswith("LV"):
            continue  # 低压聚合行单独校验
        cands = [l for l in locate(chid) if fmt(s["E_MJ"]) in l]
        if not cands:
            bad.append("%s: 基线表行未定位（E(t)=%s 未匹配）" % (chid, fmt(s["E_MJ"])))
            continue
        L = cands[0]
        target_pct = "%.1f%%" % (s["nonzero"] / s["n"] * 100)
        for label, val in (("非零帧", str(s["nonzero"])),
                           ("占比", target_pct),
                           ("末非零t", fmt(s["last_nz_t"])),
                           ("口径B", fmt(s["B"]))):
            if val not in L:
                bad.append("%s: %s 实算 %s 未出现在文档行" % (chid, label, val))

    # 低压聚合行：8 个末非零 t 均为 1800.00，且均「未跌破」
    lv_rows = [l for l in lines if l.startswith("| LV-01 ~ 08-FIRE")]
    if not lv_rows:
        bad.append("LV: 基线表低压聚合行未定位")
    else:
        L = lv_rows[0]
        if "1800.00" not in L:
            bad.append("LV: 末非零 t 应为 1800.00，未在聚合行找到")
        if "未跌破" not in L:
            bad.append("LV: 口径 B 应标「未跌破」，未在聚合行找到")
        nz = {stats[c]["nonzero"] for c in LV if stats[c]}
        if nz and nz != {1000}:
            bad.append("LV: 非零帧应全为 1000，实测 %s" % sorted(nz))
    return bad


def check_identity(stats):
    """口径恒等式 A - B == 峰值时刻，必须 8/8 成立。"""
    bad = []
    for chid, s in stats.items():
        if s is None or s["A"] is None:
            continue
        if abs((s["A"] - s["B"]) - s["tpeak"]) > 1e-6:
            bad.append("%s: A-B=%.4f != tpeak=%.4f" % (chid, s["A"] - s["B"], s["tpeak"]))
    return bad


def check_forbidden_stats(doc, name="DESIGN_SYSTEM.md"):
    """⛔ §4.16.3 硬约束 ③：活跃表述区不得出现相关性统计量。

    ⚠ v2.1 改造（ux-designer 指出盲区）：v2.0 版只匹配 4 条**固定字符串**
    （`Pearson r =` / `Spearman ρ = ` / `r = −0.75` / `ρ = −0.26`），
    注入 `r = -0.75, 显著负相关` 因破折号是 ASCII `-` 而非 `−` 直接漏过。
    故改为**正则模式族**：任何相关系数符号 + 任何方向词即报错。

    变更记录与「取值方式 / 修正理由」段落允许引用历史值，故按行白名单排除。
    """
    allow_ctx = ("取值方式", "理由（依", "变更记录", "v1.7a", "v1.8",
                 "v2.0", "v2.1", "⛔ 禁止一切相关性", "禁用任何相关性",
                 "不得出现", "诊断", "输出即禁", "禁止写入")
    # 统计量本体：Pearson / Spearman / r / ρ / 相关系数
    stat_re = re.compile(
        r"(Pearson|Spearman|皮尔逊|斯皮尔曼)"
        r"|(\br\s*=\s*[−\-+]?\s*0?\.\d+)"
        r"|([ρr]\s*=\s*[−\-+]?\s*0?\.\d+)"
        r"|(相关系数|秩相关|相关性系数)"
        r"|(显著(?:正|负)?相关|强相关|弱相关|相关性显著)", re.IGNORECASE)
    # 判定为「论断」而非「禁令/诊断」的语境
    verdict_kw = ("禁止", "不得", "⛔", "超出数据支持范围", "不予采用",
                  "不可用", "诊断", "输出即禁", "禁止写入", "作废",
                  "一律", "任何", "所有", "正负双向", "禁令")
    # ⚠ v2.1：段级禁令声明 —— 若上文N 行内出现「禁止给出相关系数」这类声明，
    #   则该段落属**禁令论证区**（说明为什么禁），允许引用具体数值。
    #   UX_SPEC §0.7 的统计量对照表即属此类（实测 3 条假阳性由此豁免）。
    #   比堆砌关键词更稳：论证区必然先声明禁令，而真正的论断不会。
    ban_decl_re = re.compile(
        r"(禁止|不得|⛔|不予采用|不可用)[^\n]{0,40}"
        r"(相关性|相关系数|Pearson|Spearman|r\s*=|ρ|正相关|负相关|统计量)")
    # ⚠ 判定标记：该行是在**评估**统计量（表格「判定」列 / 结论行），
    #   而非**主张**它。UX_SPEC §0.7 对照表每行都带此类标记。
    judge_kw = ("过临界", "未过临界", "远未过", "翻正", "方向为正", "方向为负",
                "判定", "临界", "不依赖", "唯一允许", "逐列对照",
                "复核", "复算", "n=7", "n=8", "df=")
    # ⚠ 变更记录区内的一切都是历史陈述，一律豁免（表格连续行 `| v1.x |` …）
    #   实测：注入行紧邻变更记录表时会被 8 行窗口内的禁令声明误豁免。
    changelog_re = re.compile(r"^\s*(\|\s*v1\.[0-9a-z]+\s*\||#+\s*变更记录)")
    WINDOW = 8
    lines = doc.split("\n")
    in_changelog = False
    bad = []
    for i, l in enumerate(lines, 1):
        if changelog_re.match(l):
            in_changelog = True
        elif in_changelog and re.match(r"^\s*$|^\s*---", l):
            continue
        elif in_changelog and not re.match(r"^\s*\|", l):
            in_changelog = False
        if in_changelog:
            continue
        if not stat_re.search(l):
            continue
        if any(a in l for a in allow_ctx):
            continue
        if any(k in l for k in verdict_kw):
            continue  # 本行自带禁令/诊断语境
        if any(k in l for k in judge_kw):
            continue  # 本行在评估/判定统计量，非主张
        # 向前WINDOW 行找禁令声明
        ctx = "\n".join(lines[max(0, i - 1 - WINDOW):i - 1])
        if ban_decl_re.search(ctx):
            continue  # 位于禁令论证区，合法引用
        bad.append("%s 第 %d 行出现相关性统计量断言：%s" % (name, i, l.strip()[:90]))
    return bad


def check_quantization(doc, name):
    """⛔ §3.2b：禁止把切片量化参数写成「所有工况共用」。

    ⚠ v2.2（ux-designer 发现 P0，根因由我实测定位）：
    实测 667 片，两个转换器产出的 `scaleC` **语义不同**：
      - `convert_fds_outputs.py`（15 工况）：`scaleC=780.0` 是 **SPAN**（量程跨度）
      - `convert_v2_140mw.py`（HV-01-140MW）：`scaleC=7.8431=2000/255` 是 **PER_LSB**
    两者步长差 255 倍（3.059 vs 7.8431 ℃）。若统一按 SPAN 解码，
    140MW 的 1083.69℃ 火场会被画成约 24~29℃ 的**室温** —— 等价于伪造数据。
    `manifest` **没有语义标识字段**，故文档不得断言共用。
    """
    # 共用域断言：出现具体量化参数 + 「共用/固定/所有/统一/写死」即报错
    param_re = re.compile(
        r"(scaleC\s*[=:≈]\s*(780|7\.84|7\.8431|2000))"
        r"|(域\s*20\s*[–\-~]\s*(800|2020)\s*℃?)"
        r"|(步长\s*(3\.06|3\.059|7\.84|7\.8431))"
        r"|(20\s*[–\-~]\s*800\s*℃\s*(色标|定义域|域))"
        r"|(8bit\s*量化[^\n]{0,20}scaleC)")
    shared_kw = ("共用", "固定", "所有工况", "全部工况", "统一", "写死",
                 "硬编码", "一律", "始终", "不变", "全用", "通用",
                 "全部写死", "此前", "此前全部", "写死 `scaleC")
    allow_kw = ("⛔", "禁止", "不得", "不可", "两种", "分叉", "PER_LSB", "SPAN",
                "逐工况", "动态", "判别", "语义", "已修正", "v2.2", "P0",
                "差异", "不同", "各自", "分别", "255倍", "255 倍",
                "此前", "全部写死", "写死", "伪造",
                # ⚠ v2.3：论证区常用假设句式（v2.2 曾把量化参数说成「两种语义」，
                #   v2.3 推翻后这些行以「若为…则…」形式保留）—— 属引用非主张。
                "若为", "若按", "假如", "假设", "应为", "实为", "GLOBAL_780",
                "PER_SLICE")
    bad = []
    for i, l in enumerate(doc.split("\n"), 1):
        if not param_re.search(l):
            continue
        if any(k in l for k in allow_kw):
            continue  # 已含禁令/区分语境
        if any(k in l for k in shared_kw):
            bad.append("%s 第 %d 行断言量化参数全工况共用（实测两种语义）：%s"
                       % (name, i, l.strip()[:100]))
    return bad


def check_slice_frames(doc, name):
    """⛔ §3.2b：禁止硬编码切片帧数 / Δt / 单片体积。

    ⚠ v2.2 实测：`HV-01-140MW` 的 `frameCount=1001`、Δt≈1.80 s、单片 256 256 B；
       其余 15 个为 101 / ≈18.00 s / 25 856 B。硬编码会让 140MW
       的加载进度永远停在 4.3%（101 帧分母 vs 实际 1001 帧）。
    """
    lit_re = re.compile(
        r"(/101\b)"
        r"|(101\s*帧)"
        r"|(101\s*(?:frames?|FRAMES?))"          # ⚠ v2.6三修：英文单位，见下
        r"|(帧数[^\n]{0,8}101)"                # ⚠ v2.6 三修：`帧数 … 101` 反序形态
        r"|(101(?=[^\n]{0,10}(?:帧数|frames?)))"
        r"|(加载切片帧[^\n]{0,12}/101)"
        r"|(25\s?856\s*B)"
        r"|(25856\s*B)"
        r"|(Δt\s*[=≈]\s*18\.00)"
        r"|(18\.00\s*s\s*(?:切片|帧间隔|帧步长))")
    # ⚠ v2.6 三修（ux-designer 提供的 4 例 + ux 补充的 2 例）：
    #   实测下列**真实违规**在收紧豁免后**仍被放过**，逐例打印判定链确认
    #   **豁免逻辑全部正确**（弱词无 ctx 支撑 → 未豁免），漏因**全部是 lit_re 不命中**：
    #     `rg '101' src/ui/App.tsx 硬编码帧数 101`         ← 无 `101 帧` 形态
    #     `grep -n 101 src/utils/coords.ts … at 101`      ← 同上（且纯英文）
    #     `18.00 s 是错的，应逐工况实测得到`← 无 `Δt` 前缀、无 `切片` 后缀
    #   ⇒ 这是**黑名单覆盖缺口**，不是豁免漏洞。
    #   补三条形态：`101 <英文单位>`、`帧数…101`（反序）、`101…帧数`（前瞻）。
    #
    # ⚠⚠ **已知不可判定边界（v2.6 实测，主动不做放宽）**
    #   下列两类**确实是真实违规**，但**故意不抓**，因为抓它们的代价
    #   （假阳性）大于收益：
    #   ① 纯裸数字：`grep -n 101 src/utils/coords.ts denominator is hardcoded at 101`
    #      要抓须把裸 `\b101\b` 纳入 lit_re。但实测全库有 **19 行**合法命中：
    #        禁令句（DESIGN_SYSTEM L420「⛔ 禁止硬编码 101 / 18.00 s / 25 856」）
    #        基线表（UX_SPEC L491 / DS L417）、进度文案示例（L494）
    #        **色标锚点 `rgb(101, 37, 87)`**（DS 全文多处）
    #      每一条都要靠 `allow_kw` 逐行正确豁免 —— 规则与词表强耦合，
    #      任何一次词表调整都可能产生假阳性，**且假阳性会掩盖真违规**。
    #   ② 无前缀 Δt：`18.00 s 是错的` —— 同上，须纳入裸 `18.00`。
    #   ⇒ **判据：本检查器只覆盖「带『帧/时间步/字节体积』语义单位」的形态。**
    #     裸数字的语义归属需要上下文理解，超出正则可判定范围。
    #     人工评审时按附录 D.3 逐条核对，不依赖本检查器兜底。
    allow_kw = ("⛔", "禁止", "不得", "不可", "硬编码", "实测", "分档",
                "逐工况", "动态", "frameCount", "frameTimesS", "101 帧分母",
                "变化", "其余 15", "其余 **15**", "140MW", "HV-01-140MW", "v2.2",
                "不同", "两类", "漂移", "driftS", "10×", "256 256",
                "ni×nj×101", "对照")
    # ⚠⚠ v2.6 非黑名单注入测试发现的**既有**漏洞（非 selfcheck 豁免引入）：
    #   `allow_kw` 里的 `硬编码` / `动态` / `变化` 是**裸子串**，
    #   于是下面三行**真实违规**被它们误豁免（实测 13 例漏 3，全部由此）：
    #     `node scripts/a.js —— 101 帧应改为动态读取`    ← 「动态」命中
    #     `rg '101' src/ui/App.tsx 硬编码帧数 101`       ← 「硬编码」命中
    #     `❌ src/ui/StatusBar.tsx 里硬编码 101 帧`        ← 「硬编码」命中
    #   根因：这三个词在**禁令语境**（「⛔ 禁止硬编码 101 帧」）是合法的，
    #   在**主张语境**（「硬编码帧数 101」）是违规的，行级"含词即豁免"
    #   无法区分 —— 与 `check_decode_method` 里 `溢出` 的问题是同一类。
    #   ⇒ 改为：这些词只有**紧邻禁令标记**时才豁免。
    _weak_kw = ("硬编码", "动态", "变化", "实测", "分档", "两类", "不同",
                "逐工况", "漂移")
    _strong_kw = ("⛔", "禁止", "不得", "不可", "严禁", "一律",
                  "frameCount", "frameTimesS", "driftS", "ni×nj×101")
    # ⚠ 既有的强豁免词：本身即表明「这是实测表/ 对照 / 分档说明」而非违规主张
    _table_kw = ("101 帧分母", "其余 15", "其余 **15**", "140MW", "HV-01-140MW",
                 "v2.2", "10×", "256 256", "对照")
    # ⚠ v2.6 二修：同上，弱豁免词**不可自我豁免**。
    #   上一版把 `逐工况` 放进 _table_kw，于是
    #   `18.00 s 是错的，应逐工况实测得到` 被它自己放过 ——
    #   一个词同时出现在「弱豁免」与「强豁免」两个表里，等于没有约束。
    #   ⇒ _table_kw 只保留**不会出现在主张句里**的结构性标记
    #     （工况名、版本号、倍率、字节数、帧分母）。
    #     「实测 / 逐工况 / 动态 / 变化」属描述性措辞，
    #     在主张句与表格句里都可能出现，**不足以自证合法**。
    # ⚠ v2.6：合法引用豁免。文档给出「可复现的检测命令」时，命令本身必然含
    #   被禁字面量（如 `grep -n '101 帧' src/ui/StatusBar.tsx`），否则读者无法复现。
    #   这类行是**检测手段**而非**违规主张**，若不豁免，规范会「为可复现而违规」。
    #
    # ⚠⚠ 非黑名单注入测试结论（9例仅抓到 3 —— 首版是**万能出口**，已收紧）：
    #   首版 `[^\n]*\b(src/|scripts/|docs/)` 只要「行首是命令 + 行内含路径」即豁免，
    #   于是下面这些**真实违规**被放过：
    #     `grep -n '101 帧' docs/x.md 加载分母写死 101 帧`   ← 命令后又声明违规
    #     `node scripts/a.js —— 101 帧应改为动态读取`          ← 同上
    #     `awk '{print}' src/a.txt 其中 Δt ≈ 18.00 是错的`      ← 同上
    #     `rg '101' src/ui/App.tsx 硬编码帧数 101`             ← 同上
    #   根因：豁免只看「**是不是**命令」，没看「**是不是只有**命令」。
    #   ⇒ 收紧为：**命令与其后解释性文字之间不得再出现第二个违规主张**。
    #     实现方式：命令必须占据整行 —— 路径后仅允许出现纯管道收尾
    #     （`| wc -l`、`| grep -c 101` 等），一旦出现中文/散文即判违规。
    selfcheck_re = re.compile(
        r"^\s*(?:#\s*)?(grep|sed|awk|npx|node|python|rg)\b"
        r"[^\n]*\b(src/|scripts/|docs/)")
    #⚠ v2.6 三修（ux-designer）：**弃用**中文表版`selfcheck_tail_bad`
    #   （`\b(src/|scripts/|docs/)[^\n|]*[一-鿿]`）。
    #   实测该版**仍漏 2 例**：它靠 CJK 码位判断「后面是不是散文」，
    #   于是**纯英文散文**直接绕过 —— 实测两条真实违规被放过：
    #     `grep -n 101 src/utils/coords.ts denominator is hardcoded at 101`
    #     `node scripts/a.js -- 101 frames is wrong and must be dynamic`
    #   根因：**用「像中文散文」与否来判定违规，语言相关 = 规则脆弱**。
    #   否定式判断（"看起来像散文"）的假阴性永远补不完。
    # ⇒ 改为**白名单**（正向列举「允许跟在路径后的结构化收尾」）：
    #   路径之后只允许 `| wc / | grep -c / | head -n ...` 这类管道收尾，
    #   出现任何其他内容（不论中英文）即判违规。
    #   该判据**语言无关**，且新增用例只需扩白名单、不需重写否定式。
    selfcheck_pipe_ok = re.compile(
        r"^(?:\s*\|\s*(?:wc|grep|head|tail|awk|sed|sort|uniq|cut|tr|xargs|rg)\b"
        r"[^\n]*)?$")
    selfcheck_path_re = re.compile(
        r"\b(?:src|scripts|docs)/[A-Za-z0-9_\-./]*[A-Za-z0-9]")
    bad = []
    for i, l in enumerate(doc.split("\n"), 1):
        if not lit_re.search(l):
            continue
        if any(k in l for k in allow_kw):
            # ⚠ v2.6：弱豁免词须**有禁令或表格语境**支撑，否则不豁免。
            #   判据：同行出现强禁令标记，或同时出现表格/对照类标记。
            weak_hit = any(k in l for k in _weak_kw)
            ctx_ok = (any(k in l for k in _strong_kw)
                      or any(k in l for k in _table_kw))
            if not weak_hit or ctx_ok:
                continue
        # 合法检测命令豁免：命令须占据整行 —— 路径后仅允许管道收尾。
        if selfcheck_re.search(l):
            _pm = selfcheck_path_re.search(l)
            _tail = l[_pm.end():] if _pm else ""
            if selfcheck_pipe_ok.match(_tail):
                continue
        bad.append("%s 第 %d 行硬编码切片帧数/Δt（140MW 为 1001 帧 / 1.80 s）：%s"
                   % (name, i, l.strip()[:100]))
    return bad


def check_rank_claim(doc, name):
    """⛔ 「名次重合 N/8」必须同时说明排序依据（v2.1 实测）。

    实测：口径 B 原始浮点 8 值互不相同，并列只存在于表值层。
    按原始浮点排序 -> 重合 1/8；按表值排序或竞赛秩 -> 重合 0/8。
    两者之差不是并列处理 bug，而是**排序键精度**之差 ——
    故该表述在脱离排序依据时**不可判伪**，必须带依据。
    """
    pat = re.compile(r"(名次重合|名次错位|排序不一致)[^\n]{0,30}?[0-4]/8")
    basis_kw = ("原始浮点", "浮点排序", "排序依据", "竞赛秩", "稳定排序",
                "并列表值", "按原始", "全分辨率")
    bad = []
    lines = doc.split("\n")
    for i, l in enumerate(lines, 1):
        if not pat.search(l):
            continue
        if any(k in l for k in basis_kw):
            continue
        # 该行只是引述他人结论或声明禁止 -> 豁免
        if any(k in l for k in ("⛔", "禁止", "不得", "一律", "已更正", "错")):
            continue
        bad.append("%s 第 %d 行「名次重合 N/8」缺排序依据：%s"
                   % (name, i, l.strip()[:90]))
    return bad


# ⚠ v2.3：已被实测推翻的 v2.2 表述黑名单（ux-designer 建议新增的第三个检查器）。
#   背景：v2.2 曾把切片量化定位为「`scaleC` 有 SPAN / PER_LSB 两种语义」，
#   并据此写下 `mode = (scaleC > 100) ? SPAN : PER_LSB`。v2.3 字节级反查证明
#   **`scaleC` 根本没有参与编码**，该定位与判别式均被推翻。
#   这些字符串若再次以**主张**身份出现，即为回归。
REFUTED_DECODE = [
    # (正则, 说明)
    # ══════════════════════════════════════════════════════════════
    # ⚠⚠ v2.5 整节重写。v2.3 / v2.4 的规则集**本身建立在一个错误结论上**：
    #   它们禁止「scaleC 参与编码」「SPAN / PER_LSB 命名」「域 20–2020」
    #   「步长 7.84」，理由是「scaleC 未参与编码、140MW 是逐片归一化」。
    #   v2.5 已用667 片字节级复算证明该结论错误（观测对象是任务 #36
    #   修复前的旧资产）。若保留旧规则，**正确文档反而被判违规**
    #   —— 实测 UX_SPEC v2.5 修订后被误报 45 处。
    #   故规则集方向反转：现在禁止的是 v2.3/v2.4 的错误主张。
    # ══════════════════════════════════════════════════════════════

    # ---- 仍属真实错误、继续禁止的判别式（v2.3 起即正确，v2.5 保留）----
    (re.compile(r"scaleC\s*(>|大于|超过|高于)\s*100"),
     "scaleC>100 判别式（v2.3 实测推翻，v2.5 复核仍禁止）"),
    (re.compile(r"(以|由|据)\s*`?scaleC`?\s*(为|作)?\s*[^，。\n]{0,8}?"
                r"(判据|依据|判别|决定|分支|语义)"),
     "以 scaleC 为判据/依据（v2.5 实测：scaleC 与 scaleMode 反相关，用它必然判错）"),
    (re.compile(r"`?scaleC`?\s*(的)?\s*(数值|取值|值|大小)[^。\n]{0,14}?"
                r"(决定|选择|选取|切换|判别|判断|分支|判据|依据|编码|解码|语义)"),
     "以 scaleC 的值为判别依据（v2.5 实测禁止）"),
    (re.compile(r"frame[_ ]?[Cc]ount\s*(>|大于|超过)\s*500"),
     "frameCount>500 判别式（v2.4 已推翻：结果不是原因，换转换器即失效）"),

    # ---- 🔴 v2.5 新增：禁止把 v2.3/v2.4 的错误主张写成现行结论 ----
    (re.compile(r"(逐片|每片|按片|单片)(自适应)?(归一化|标定)"),
     "[V25] 逐片归一化编码（v2.5 实测否决：全库仅 38/667 在容差内）"),
    (re.compile(r"\bPER_SLICE\b"),
     "[V25] PER_SLICE 命名（v2.3 误造，v2.5 实测否决）"),
    (re.compile(r"\bGLOBAL_780\b"),
     "[V25] GLOBAL_780 命名（v2.3 误造，v2.5 实测否决）"),
    (re.compile(r"\bFIXED_780\b"),
     "[V25] FIXED_780 命名（v2.4 误造，v2.5 实测否决）"),
    (re.compile(r"(矛盾组合|组合判据|组合检验)"),
     "[V25] 「矛盾组合检验」判别式（v2.4 误造，v2.5 实测在 140MW 命中 0/49）"),
    (re.compile(r"域\s*(上限)?\s*(必须)?逐片"),
     "[V25] 域上限逐片取 dataMaxC（v2.3/v2.4 口径，已作废）"),
    (re.compile(r"\(?\s*(dataMaxC\s*[-−]\s*20)\s*\)?\s*[/／]\s*255"),
     "[V25] 步长 (dataMaxC-20)/255（v2.3/v2.4 口径，已作废）"),
]

# ⚠ 数值型违规的**严格豁免集**：只认版本标记与引述动词，不认 ⛔/禁止/不得。
#   安全性核验（第 21 轮实测）：DESIGN / TODO / UX 三份文档中，所有合法引用
#   数值型违规的行**都同时含**v2.x 版本标记或引述动词，
#   移除弱豁免后 0 假阳性。
_CITATION_KW = (
    "v2.0", "v2.1", "v2.2", "v2.3", "v2.4",
    "曾", "仍", "仍旧", "旧", "原先", "此前", "原来", "历史",
    "已改为", "改为", "已删除", "已移除", "已去掉", "去掉", "删除", "移除",
    "推翻", "作废", "已失效", "口径", "反证", "错值", "错误", "错的",
    # ⚠ 同轮（诊断 UX L53 假阳性）：反证表
    #   `该式要求 byteMax = round(9.60/7.8431×255) = 312 | 实测 255，矛盾`
    #   是在**引述错误公式并展示其失效**，属合法引用。
    "该式", "要求", "蕴含", "矛盾", "不符", "会解成", "会被解成", "则",
)

# ⚠ 否定式验收动词：`**不通过**`，必须出现在违规数字**之后 32 字内**，
#   才认定「否定的是该数字」而非「否定的是同行另一个数字」。
#
#   三轮调试记录（这一条规则本身是被两次相反的错误逼出来的）：
#     · 二修：DESIGN L1182 假阳性 —— `⛔ 域上限写死 2020 ℃ 亦不通过`
#       里的 `2020℃` 是**被否定对象**，但同行 ⛔ 被 NUM 严格集排除后误报。
#       → 补「不通过」到豁免集。
#     · 三修：UX L2214 假阴性 —— 补词补过头，把**真过期残留**
#       `≥2020℃ 饱和 · 步长 7.84℃` 也放过了，因为同行末尾另有一条
#       **针对 800℃ 的**正确禁令 `⛔ 上限写死 800℃ 即不通过`。
#       行级「含词即豁免」**无法区分**否定对象是哪个数字。
#     → 改为**邻接限定**（见 _num_denied_nearby）。
#     实测两个样本恰好被邻接判据正确区分：
#       DESIGN L1182 「2020 ℃ **亦不通过**」→ 8 字 → 豁免（真合法）
#       UX     L2214 「2020℃ 饱和 · 步长 7.84℃`）…800℃ 即不通过」→ 60+ 字 → 违规（真过期）
_NUM_DENY_KW = ("不通过", "均不通过", "亦不通过", "即为不通过", "算不通过")


def _num_denied_nearby(line, match):
    """违规数字之后 32 字内出现否定式验收动词 -> 认定该数字被否定（合法引用）。"""
    tail = line[match.end():match.end() + 32]
    return any(k in tail for k in _NUM_DENY_KW)

# ⚠ v2.3 新增检查：⛔ 禁止仅凭 `byteMax == 255` 判「饱和」。
#   实测全库 `byteMax==255` 共 54/667 = 8.1%，分属两种本质不同的状态：
#     A. `HV-01-140MW` 的 49 片 = 逐片归一化的**满量程**（真实 940–1084℃，远未达上限）
#     B. 5 个低压片 = 全局 780 域的**真饱和**（真实 855–953℃，超出 800℃ 上限）
#   若仅凭 byteMax 就标「饱和/上端截断」，会把 49 片无损数据误报为已截断。
#   精确判据（三条件同时满足）：byteMax==255 && 残差>1.5294 && dataMaxC>800
#   ⚠ 「实测」一词**不作为豁免词** —— 裸主张「实测 byteMax=255 即饱和」
#     同样是把未验证的判据写成结论（实测 4 处假阳性后已移除该豁免）。
_SAT_GUARD = ("残差", "1.5294", "半个LSB", "半个 LSB", "不是", "不得",
              "⛔", "禁止", "两种", "类型", "误判", "不应", "而非", "不符",
              "已推翻", "v2.3", "三条件", "区分", "对比", "分别", "非",
              # ⚠ 第 11 轮新增 2 处假阳性修正：
              #   「真饱和」（与「归一化满量程」相对的**正确术语**）在无 dataMaxC
              #   字样时不在豁免词表内 -> 误报。补「真」「钳制」「撞」三词：
              #   「真饱和」已隐含「撞上固定域上限」这一独立于 byteMax 的前提。
              #   ⚠ 「溢出」**不能**作豁免词：它同时是「byteMax=255 推断上端状态」
              #   的推断动词表成员，留着会让「byteMax=255 表明数据已溢出」被豁免
              #   （第 14 轮实测 1 处漏过，根因即此自相矛盾）。改用「溢出**纹理**」
              #   这一**图例绘制术语**作豁免 —— 它描述的是 UI 画法而非数据状态，
              #   ASCII 色带图里的「上端饱和（>800 为溢出纹理）」即属此类。
              "真", "钳制", "撞", "溢出纹理")

# 「主张 vs 引用/描述/否定」的语境区分（v2.1 确立的方法论，v2.3 沿用）。
#   真正的回归是无禁令、无「若/假如/应为/错误」标记的**平铺直叙**。
NEGATION_KW = (
    "⛔", "禁止", "不得", "不可", "一律", "任何", "所有", "严禁", "切勿",
    "已被推翻", "已推翻", "推翻", "是错的", "定位错", "错位", "误判",
    "此前", "原先", "v2.1", "v2.2", "v2.3", "作废", "已失效",
    "若按", "若用", "假如", "假设", "若为", "会被解成", "应对应",
    "应为", "实为", "应为", "对不上", "而不是", "而非", "不适用",
    "已改为", "改为", "不是", "重算", "反向", "反例",
    # ⚠ v2.3 新增：「实测…无一片达到 X」是**证伪句**，与「域为 X」性质相反，
    #   但两者都含数字 —— 必须靠这些词区分，否则会误报（实测 1 处假阳性）。
    "无一片", "没有一片", "无一达到", "实测", "并不存在", "从未", "未曾",
    # ⚠ v2.3 新增：论证表格里的「反证句」常以「则 / 蕴含 / 要求」开头，
    #   用来**展示**错误推论的后果（UX_SPEC §0.3 反证表即此类，
    #   实测触发 2 处假阳性：「则 byteMax=255 蕴含 T ≥ …2016.08 ℃」）。
    "则", "蕴含", "反证", "会得到", "结果是",
    # ⚠ 反证表的「要求」句式：`| 2 | 该式要求 byteMax = …，而 .bin 实际 byteMax=255 |`
    "该式", "要求", "矛盾", "不符",
    # ⚠ v2.4 修正：`推出` / `得到` 是**推断动词**，不是否定标记。
    #   原先裸列在豁免词表里，导致第 21 轮注入漏过
    #   `逐步换算 scaleC 得到温度。` —— 这是一条**裸主张**（scaleC 参与换算），
    #   却被自己写下的「得到」二字豁免掉，属于典型的**豁免词自相矛盾**
    #   （与「溢出」同时出现在推断词表和豁免词表是同一类错误）。
    #   已从裸词表移除，改为只认**限定形式**「可推出 / 由此推出 / 可得到 / 由此得到」
    #   —— 这些才是反证表里的引述语气。
    #   安全性核验：三份真实文档中所有命中行都另有强否定词
    #   （⛔/禁止/推翻/若按/蕴含/矛盾/该式/而非/v2.3），移除后 0 假阳性。
    "可推出", "由此推出", "可得到", "由此得到",
    # ⚠ 同轮新增：「已删除 / 已移除 / 去掉」是**修订动作词**，
    #   「DESIGN_SYSTEM §3.2b 已删除按 scaleC 解码的表述」是合法引用，
    #   但原文只列了「已改为 / 改为」，导致 1 处假阳性。
    "已删除", "已移除", "已去掉", "删除", "移除", "去掉",
)
# 论证区段：这些区段的**目的就是**展示被推翻的表述
SECTION_KW = (
    "推翻", "修正", "定位", "对照", "反例", "错值", "纠正", "历史",
    "口径对比", "两种编码", "编码方式",
)


def check_decode_method(doc, name):
    """🔴 v2.5：禁止把已被实测否决的 v2.3 / v2.4 解码主张写成现行结论。

    保留 v2.3 确立的「主张 vs 引用」区分法（这是本检查器最有价值的部分）：
    命中禁令词、假设词、版本标记，或落在「推翻/修正/撤回」论证区段的行一律豁免
    —— 因为那些位置正是在**展示**错误表述。裸主张（无任何限定词）才判违规。

    ⚠ v2.5 整节重写的原因：v2.3 / v2.4 的规则集把「scaleC 参与编码」
    「SPAN / PER_LSB 命名」「域 20–2020」「步长 7.84」当作**违规**，
    因为它们当时认定「scaleC 未参与编码、140MW 是逐片归一化」。
    v2.5 已用 667 片字节级复算证明该结论错误（观测对象是任务 #36 修复前的
    旧资产）。若不反转，**正确文档会被判违规** —— 实测 UX_SPEC v2.5
    修订后被误报 45 处。这是「校验器自身成为污染源」的典型案例。
    """
    bad = []
    lines = doc.split("\n")
    # ⚠ 严格豁免集：去掉「实测 / 则 / 要求 / 推出」等**弱限定词**。
    #   「实测 16/16 工况无例外」是相关当因果，不足以让 frameCount 判别式合法。
    _FC_STRICT = ("frame[_ ]?[Cc]ount", "帧数")
    for i, l in enumerate(lines, 1):
        is_fc = any(re.search(p, l) for p in _FC_STRICT)
        guard = (tuple(k for k in NEGATION_KW if k not in ("实测", "则", "要求", "推出", "得到"))
                 if is_fc else NEGATION_KW)
        for rx, why in REFUTED_DECODE:
            m = rx.search(l)
            if not m:
                continue
            # ⚠ 数值型违规改用**引用专用**豁免集：`⛔ / 禁止 / 不得` 不足以让
            #   一行合法 —— 同一行可以并存「正确禁令 + 错误数字主张」。
            #   另叠加**邻接否定**判据：若否定验收动词紧跟在违规数字之后，
            #   说明该数字是被否定的对象而非主张。
            # 🔴 v2.5 优先否决：v2.5 规则集的禁令词若**本身就是**被否决的
            #   判据名（「矛盾组合检验」），则 NEGATION_KW 里的「矛盾」会把它
            #   误当豁免词放行 —— 词表自污染，注入测试实测漏过 1 条。
            #   故：命中 [V25] 前缀的规则，豁免词表**剔除**与禁令词同形的词。
            if why.startswith("[V25]"):
                bare = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", why.split("]", 1)[1])
                # 剔除与禁令词同形的豁免词（如「矛盾组合检验」vs 豁免词「矛盾」）
                g2 = tuple(k for k in guard
                           if k not in bare and bare not in k)
                if any(k in l for k in g2):
                    break
                # ⚠ 证伪/撤回语境豁免：v2.5 文档**必须**能记录
                #   「v2.3/v2.4 的 X 主张是错的」这类内容，否则无人敢记录教训。
                #   判据：同行含**明确的证伪标记**，而非仅含「否定词」。
                #   （实测假阳性：撤回清单 L18「…判据本身失效」、三假说对照表
                #     「…全库否决」共 5 处）
                _REFUTE = ("否决", "失效", "作废", "撤回", "误造", "已推翻",
                           "❌", "错", "误判", "不成立", "反例", "实测否决",
                           # 「派生影响：DESIGN_SYSTEM 当前是 v2.4 口径」这类
                           # **指出他人文档现状**的行也须放行 —— 它在报告差异，
                           # 不是在主张。判据须为「指向他人文档 + 现状口径」。
                           "当前是", "仍是", "口径", "派生影响", "需改为")
                if any(k in l for k in _REFUTE):
                    break
                # 向上 3 行内若已处于「撤回/作废/证伪」论证区段，同样放行
                ctx_v25 = "\n".join(lines[max(0, i - 1 - 3):i - 1])
                if any(k in ctx_v25 for k in
                       ("撤回清单", "作废", "已否决", "误造", "三假说对照")):
                    break
                # ⚠ 关键：此处**必须**判违规，不得再落入下面的 `elif guard`
                #   —— 那个分支用的是未过滤的 guard，会把刚剔除的「矛盾」又用上。
                #   （注入测试 v2.5 第 1 轮实测漏过「判别式采用矛盾组合检验」）
                bad.append("%s 第 %d 行出现已被 v2.5 实测否决的解码表述（%s）：%s"
                           % (name, i, why, l.strip()[:100]))
                break
            if why.startswith("[NUM]"):
                if _num_denied_nearby(l, m):
                    break
                if any(k in l for k in _CITATION_KW):
                    break
            elif any(k in l for k in guard):
                break
            # 🔴 v2.5 新增：撤回/作废/已推翻 等**显式撤回标记**。
            #   v2.3/v2.4 的错误主张必须允许以「已作废」形式出现在撤回清单里，
            #   否则连「承认自己错了」都会被判违规 —— 那会导致无人敢记录教训。
            if any(k in l for k in ("撤回", "作废", "已推翻", "已否决",
                                    "❌", "禁止", "不得", "⛔", "失效", "错")):
                break
            # 向前 12 行找论证区段声明
            ctx = "\n".join(lines[max(0, i - 1 - 12):i - 1])
            if any(k in ctx for k in SECTION_KW):
                break
            bad.append("%s 第 %d 行出现已被 v2.5 实测否决的解码表述（%s）：%s"
                       % (name, i, why, l.strip()[:100]))
            break
        # 独立检查：仅凭 byteMax==255 判「饱和」
        #   ⚠ v2.5 实测：`byteMax==255` 全库仅 5 片，且**全部**是 SPAN 工况的真饱和。
        #   140MW（PER_LSB）`byteMax` 跨 1–136，**0 片**为 255。
        #   故 v2.4「两种成因」的分叉已消失 —— 判据简化为
        #   `scaleMode==='SPAN' && byteMax===255 && dataMaxC>800`（命中 5 片）。
        _INF = (r"(表示|意味|表明|说明|证明|代表|已达|达到|抵达|等于|即为|即是|"
                r"判定|判为|视为|溢出|钳制|饱和|截断|上限)")
        infers = (re.search(r"(byte\w*\s*[=＝]{1,3}\s*255|255\s*级|量程上限)", l)
                  and re.search(_INF, l)
                  and re.search(r"(上端|顶部|量程|满量程|饱和|截断|溢出|数据|上限)", l))
        if infers and not any(k in l for k in _SAT_GUARD):
            bad.append("%s 第 %d 行仅凭 byteMax==255 判「饱和」"
                       "（v2.5 实测：byteMax==255 全库仅 5 片，判据须为 "
                       "scaleMode===SPAN && byteMax===255 && dataMaxC>800）：%s"
                       % (name, i, l.strip()[:100]))
    return bad


def check_asset_decode(assert_binary=True):
    """🔴 v2.5 资产级断言：直接读 .bin 真实字节，验证 manifest.scaleMode 与解码公式。

    为什么必须有这一层：v2.3 / v2.4 的切片编码结论全部建立在**已废弃的旧资产**上，
    而当时 check_decode_method（纯文档字符串检查）**每一轮都「全绿」**。
    根因：字符串检查无法发现「文档说的公式」与「.bin 里的真实字节」不一致。
    本函数把断言从「文档写了什么」下沉到「资产实际是什么」。
    """
    bad = []
    n_slices = 0
    n_consistent = 0
    n_in_tol = 0
    n_sat = 0
    sat_list = []
    bmax255 = []
    per_lsb_bmax = []

    cases = HV + LV
    for c in cases:
        mp = os.path.join(ASSETS, c, "manifest.json")
        if not os.path.exists(mp):
            bad.append("资产级断言：找不到 manifest %s" % mp)
            continue
        with io.open(mp, encoding="utf-8") as f:
            m = json.load(f)
        top_mode = m.get("scaleMode")
        if top_mode not in ("SPAN", "PER_LSB"):
            bad.append("%s 顶层 scaleMode 缺失或非法：%r（v2.5 要求显式声明）"
                       % (c, top_mode))
            continue

        for s in m.get("slices", []):
            n_slices += 1
            q = s.get("quantization") or {}
            smode = q.get("scaleMode")
            if smode != top_mode:
                bad.append("%s / %s 切片级 scaleMode=%r 与顶层 %r 不一致"
                           % (c, s.get("asset"), smode, top_mode))
                continue
            n_consistent += 1

            base = q.get("baseC")
            scale = q.get("scaleC")
            if base is None or scale is None:
                bad.append("%s / %s quantization 缺 baseC/scaleC"
                           % (c, s.get("asset")))
                continue

            # 半LSB 容差：SPAN 域为 780（步长 780/255），PER_LSB 步长为 scaleC
            step = scale if smode == "PER_LSB" else scale / 255.0
            half = step / 2.0

            bmax = None
            if assert_binary:
                p = os.path.join(ASSETS, c, s["asset"])
                if not os.path.exists(p):
                    bad.append("%s / %s 切片文件缺失" % (c, s["asset"]))
                    continue
                with open(p, "rb") as f:
                    raw = f.read()
                expect = s["frameCount"] * s["ni"] * s["nj"]
                if len(raw) != expect:
                    bad.append("%s / %s 字节数 %d != %d（E-5）"
                               % (c, s["asset"], len(raw), expect))
                    continue
                bmax = max(raw)
                if bmax == 255:
                    bmax255.append((c, s["asset"], s.get("dataMaxC")))
                    if smode == "SPAN":
                        n_sat += 1
                        sat_list.append((c, s["asset"], s.get("dataMaxC")))
                if smode == "PER_LSB":
                    per_lsb_bmax.append(bmax)

            if bmax is None:
                continue

            if smode == "PER_LSB":
                t = base + bmax * scale
            else:
                t = base + (bmax / 255.0) * scale

            # 饱和片（SPAN 且触顶 800）单独成立，不参与容差判定
            if smode == "SPAN" and bmax == 255:
                continue

            resid = abs(t - s["dataMaxC"])
            if resid <= half + 1e-9:
                n_in_tol += 1
            else:
                bad.append("%s / %s 按 scaleMode=%s 解码残差 %.6f > 半个 LSB %.6f"
                           "（byteMax=%d, dataMaxC=%.2f, decoded=%.4f）"
                           % (c, s["asset"], smode, resid, half,
                              bmax, s["dataMaxC"], t))

    # 140MW 的 byteMax 必须全部 < 255（v2.5 实测跨 1–136）
    if per_lsb_bmax:
        if max(per_lsb_bmax) == 255:
            bad.append("PER_LSB 工况出现 byteMax==255，"
                       "与 v2.5 实测（140MW byteMax 跨 1–136）矛盾 —— 资产可能已变更")
        if min(per_lsb_bmax) < 1:
            bad.append("PER_LSB 工况出现 byteMax<1（%d），资产可能已变更"
                       % min(per_lsb_bmax))

    #⚠ v2.5 追加：quantizationClipped 必须**区分「键不存在(None)」与「写 false」**。
    #   两者读出都能得到假值，但缺陷类型完全不同：
    #     None  = 转换器根本没写这个字段（缺失）
    #     False = 转换器写了，但值不足以反映饱和（误报）
    #   必须用 `in` 判定而非 `.get()`，否则缺失会被默认成 False 而误分类。
    #   （visual-designer 2026-10-08 曾误报为「全库 667 片缺失」，
    #    实测仅 618 片缺失、140MW 49 片确实写 False。）
    qc_none = qc_false = qc_true = qc_other = 0
    sat_qc_bad = []
    for c in cases:
        mp = os.path.join(ASSETS, c, "manifest.json")
        if not os.path.exists(mp):
            continue
        with io.open(mp, encoding="utf-8") as f:
            m = json.load(f)
        for s in m.get("slices", []):
            if "quantizationClipped" not in s:
                qc_none += 1
                st = "缺失"
            elif s["quantizationClipped"] is True:
                qc_true += 1
                st = "True"
            elif s["quantizationClipped"] is False:
                qc_false += 1
                st = "False"
            else:
                qc_other += 1
                st = repr(s["quantizationClipped"])
            # 真饱和片必须有 True 才算正确标注
            p_ = os.path.join(ASSETS, c, s["asset"])
            if os.path.exists(p_) and s.get("dataMaxC", 0) > 800 \
               and m.get("scaleMode") == "SPAN":
                with open(p_, "rb") as f:
                    if max(f.read()) == 255 and st != "True":
                        sat_qc_bad.append((c, s["asset"], st))

    print("=== 资产级解码断言（直读 .bin，%d 片）===" % n_slices)
    print("  scaleMode 逐片与顶层一致：%d / %d" % (n_consistent, n_slices))
    print("  按 scaleMode 解码残差在半个 LSB 内：%d" % n_in_tol)
    print("  真饱和片（SPAN 且 byteMax==255）：%d" % n_sat)
    for sid, asset, dm in sat_list:
        print("      %-14s %-30s dataMaxC=%.2f" % (sid, asset, dm))
    print("  quantizationClipped：键不存在(None)=%d / 写False=%d / 写True=%d / 其他=%d"
          % (qc_none, qc_false, qc_true, qc_other))
    print("    ⚠ None 与 False 是**两种不同缺陷**，不可合并计数：")
    print("       None  = 转换器未写该字段（缺失）；False = 转换器写了但未反映饱和（误报）")
    for sid, asset, st in sat_qc_bad:
        print("    ⛔ 真饱和片未标 True：%s / %s（当前=%s）" % (sid, asset, st))

    # 🔴 v2.5 追加（源自 visual-designer 建议，经源码核实后调整形式）
    #   建议原文：断言「键存在但值缺失的片数应为 0」——
    #   即认为 140MW 49 片的 False 是「碰巧正确」，担心它由错误前提算出。
    #   ⚠ 源码核实后该担忧**不成立**，故不采纳「值缺失数=0」这条断言：
    #     convert_v2_140mw.py L144-151：quantize() 对 tq>255 **raise ValueError**
    #     （不静默 clamp），L308 若 gmax>2020 也raise。
    #     ⇒ 真出现 >2020 ℃ 时**构建即中止**，不会有资产产出（fail loud）。
    #     ⇒ clipped 恒为 0 是**结构性结果**，不是「侥幸为真」。
    #   但真正可断言的是**根因**：618 片的 None 源于
    #   `convert_fds_outputs.py` **从未实现**该字段（grep 无任何写入），
    #   而非「漏写」。故断言其来源可防止后人误判为局部 bug。
    conv_span = os.path.join(ROOT, "scripts", "convert_fds_outputs.py")
    if os.path.exists(conv_span):
        with io.open(conv_span, encoding="utf-8") as f:
            src_span = f.read()
        if "quantizationClipped" not in src_span:
            print("    📌 根因确认：convert_fds_outputs.py **从未写入** "
                  "quantizationClipped")
            print("       → 618 片 None 是「该字段在 SPAN 侧未实现」，"
                  "不是「个别片漏写」")
            print("       → 5 个 SPAN 真饱和片因此永远无法被该字段标出")
    return bad


def check_asset_identity():
    """附录 C：观测必须绑定资产身份 —— 校验 scaleMode 由转换器显式写入。"""
    bad = []
    for c in HV + LV:
        mp = os.path.join(ASSETS, c, "manifest.json")
        if not os.path.exists(mp):
            continue
        with io.open(mp, encoding="utf-8") as f:
            m = json.load(f)
        want = "PER_LSB" if c == "HV-01-140MW" else "SPAN"
        if m.get("scaleMode") != want:
            bad.append("%s scaleMode 应为 %s，实为 %r" % (c, want, m.get("scaleMode")))
    return bad


def main():
    ap = argparse.ArgumentParser(description="规范与资产交叉一致性自检（只读）")
    ap.add_argument("--check-ux", action="store_true",
                    help="额外校验 UX_SPEC.md 的数值与旧禁用条款")
    ap.add_argument("--stats", action="store_true",
                    help="追加输出相关系数诊断（⛔ 不得写入规范/界面）")
    args = ap.parse_args()

    for p in (DESIGN, TODO):
        if not os.path.exists(p):
            print("缺失文件：%s" % p)
            return 1

    with io.open(DESIGN, encoding="utf-8") as f:
        design = f.read()
    with io.open(TODO, encoding="utf-8") as f:
        todo = f.read()

    stats = {}
    missing = []
    for c in HV + LV:
        s = load(c)
        stats[c] = s
        if s is None:
            missing.append(c)

    print("=== 资产实测（%d 工况，hrr.json 1001 帧 FULL_RESOLUTION）===" % len(HV + LV))
    print("%-14s %6s %7s %9s %9s %8s %8s %11s" %
          ("case", "非零帧", "占比", "末非零t", "口径A", "口径B", "E MJ", "manifest"))
    for c in HV + LV:
        s = stats[c]
        m = load_manifest(c)
        if s is None:
            print("%-14s  MISSING" % c)
            continue
        mstat = "%s/%s" % (m["status"], m["frameCount"]) if m else "MISSING"
        print("%-14s %6d %6.1f%% %9.2f %9s %8s %8.2f %11s" %
              (c, s["nonzero"], s["nonzero"] / s["n"] * 100, s["last_nz_t"],
               fmt(s["A"]) if s["A"] else "never",
               fmt(s["B"]) if s["B"] else "never", s["E_MJ"], mstat))

    problems = []
    problems += check_baseline_table(design, stats)
    problems += check_identity_exact(stats)
    problems += check_forbidden_stats(design)
    problems += check_manifests(stats)
    problems += check_banned_source(design, "DESIGN_SYSTEM.md")
    problems += check_banned_source(todo, "TODO_FDS_HRR.md")
    problems += check_rank_claim(design, "DESIGN_SYSTEM.md")
    problems += check_rank_claim(todo, "TODO_FDS_HRR.md")
    # ⚠ v2.1：时长值域校验扩到全部三份文档（v2.0 只扫 UX_SPEC，
    #    导致 TODO / DESIGN 里的伪造时长无人检查）
    problems += check_ux_numbers(design, stats, "DESIGN_SYSTEM.md")
    problems += check_ux_numbers(todo, stats, "TODO_FDS_HRR.md")
    # ⚠ v2.2：跨文档盲区 —— ux-designer 指出 §3.2 的量化描述无法被 --check-ux 校验。
    #   故量化/帧数检查器**在主校验里就跑**，覆盖 DESIGN 与 TODO。
    problems += check_quantization(design, "DESIGN_SYSTEM.md")
    problems += check_quantization(todo, "TODO_FDS_HRR.md")
    problems += check_slice_frames(design, "DESIGN_SYSTEM.md")
    problems += check_slice_frames(todo, "TODO_FDS_HRR.md")
    # ⚠ v2.3：扫已被实测推翻的 v2.2 解码定位（`scaleC > 100` / 域 20–2020 等）
    problems += check_decode_method(design, "DESIGN_SYSTEM.md")
    problems += check_decode_method(todo, "TODO_FDS_HRR.md")
    problems += check_stale_disabled(design, "DESIGN_SYSTEM.md")
    problems += check_stale_disabled(todo, "TODO_FDS_HRR.md")
    # ⚠ v2.5 P0：资产级断言 —— 直读 .bin 真实字节，验证 scaleMode 与解码公式。
    #   v2.3 / v2.4 的错误结论在纯文档字符串检查下**全绿**通过，
    #   根因是字符串检查看不见 .bin 里的真实字节。此层为最后的真相来源。
    problems += check_asset_identity()
    problems += check_asset_decode()

    if args.check_ux:
        if os.path.exists(UX_SPEC):
            with io.open(UX_SPEC, encoding="utf-8") as f:
                ux = f.read()
            problems += check_ux_numbers(ux, stats)
            problems += check_banned_source(ux, "UX_SPEC.md")
            problems += check_stale_disabled(ux, "UX_SPEC.md")
            problems += check_rank_claim(ux, "UX_SPEC.md")
            # ⚠ v2.2：P0 级渲染伪造防线（比时长值域更严重）
            problems += check_quantization(ux, "UX_SPEC.md")
            problems += check_slice_frames(ux, "UX_SPEC.md")
            problems += check_decode_method(ux, "UX_SPEC.md")
            # ⚠ v2.1 修复盲区：v2.0 的 --check-ux 分支**没有调用**本检查器，
            #    导致 UX_SPEC 里的统计量字样无人检查（ux-designer 注入 `r = -0.75` 漏过）
            problems += check_forbidden_stats(ux, "UX_SPEC.md")
        else:
            problems.append("--check-ux 已指定，但找不到 UX_SPEC.md（%s）" % UX_SPEC)

    if missing:
        problems.append("资产缺失：%s" % ", ".join(missing))

    if args.stats:
        print_stats(stats)

    print()
    if problems:
        print("=== 发现 %d 处不一致 ===" % len(problems))
        for p in problems:
            print("  ✗ %s" % p)
        return 1

    print("=== 全部一致 ===")
    print("  ✓ 基线表 8 个高压工况的非零帧/占比/末非零 t/口径 B 与 hrr.json 实算一致")
    print("  ✓ 口径恒等式 A - B == 峰值时刻 成立（原始浮点残差 0，表值残差 0.01 属正常）")
    print("  ✓ 16 工况 manifest 全部 READY + frameCount=1001 + FULL_RESOLUTION，峰值与 hrr.json 一致")
    print("  ✓ 活跃表述区无未加禁令限定的相关性统计量断言")
    print("  ✓ 无「series.json 被当作数据来源」的表述")
    print("  ✓ 无 140MW 旧禁用条款复活")
    print("  ✓ 资产级断言：667 片逐片 scaleMode 与顶层一致，按 scaleMode 解码残差在半个 LSB 内")
    if args.check_ux:
        print("  ✓ UX_SPEC 数值与旧禁用条款检查通过")
    print()
    print("提醒：资产每次更新（重跑 convert 脚本）后必须重跑本脚本，")
    print("     不得沿用旧统计量 —— v1.7a 的 6 处错误即由此产生。")
    print("提醒：末非零 t 必须取「末个 hrrKW > 0 的帧」，禁止用 series.json（201 帧）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

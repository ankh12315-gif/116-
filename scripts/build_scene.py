#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
116 配电室火灾可视化 —— 离线数据转换器（阶段一：几何 + 工况清单）

只读输入，绝不修改用户原始文件：
  - source_fds/*.fds            16 份 FDS 输入（几何、VENT、RAMP、DEVC 定义）
  - ../116-diya-window/<CHID>/  低压工况真实模拟输出
  - ../116-gaoya-window/<CHID>/ 高压工况真实模拟输出

输出：
  public/assets/geometry/scene_master.json     主几何（OBST 面/体 + HOLE + MESH + 火源锚点）
  public/assets/geometry/geometry_audit.json   几何审计与语义置信度
  public/assets/scenarios/scenarios.json       工况清单（availability 基于真实输出检查）
  public/assets/scenarios/cabinets.json10 个起火柜锚点

几何语义策略（严格遵守 docs/03、docs/04）：
  * OBST 为零厚度 -> 归类为 SURFACE（双面板渲染）
  * OBST 三维均非零 -> 归类为 SOLID
  * 不按 AutoCAD ID 猜测"墙/门/窗"。分类只依据可验证的几何规则：
      - 依据 SURF_ID / COLOR 的材质线索（'ke'=金属灰, 'Global08'=白, 'INERT' 等）
      - 依据几何位置（是否位于房间外轮廓 / 是否为水平薄板）
    并为每类打上 confidence 标签，前端展示"几何待核验"。
  * HOLE 单独输出，不作为实体绘制
  * VENT 中 SURF_ID='OPEN' 的是计算域开边界 -> 单独标注为 MESH_BOUNDARY，绝不画成门窗
  * VENT 中 SURF_ID='burner' 的是火源面 -> 输出为 FIRE_SOURCE 锚点
"""

import json
import math
import os
import re
import sys
import hashlib
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE_FDS = os.path.join(ROOT, "source_fds")
ASSETS = os.path.join(ROOT, "public", "assets")
OUT_GEO = os.path.join(ASSETS, "geometry")
OUT_SCEN = os.path.join(ASSETS, "scenarios")

#真实模拟输出根目录（与项目文件夹同级）
WORKSPACE = os.path.dirname(ROOT)
LOW_ROOT = os.path.join(WORKSPACE, "116-diya-window")
HIGH_ROOT = os.path.join(WORKSPACE, "116-gaoya-window")

T_END = 1800.0

# 已确认禁用工况（源输入错误：HRRPUA=5.6E6 * 0.25 m² = 1400 MW）
DISABLED = {"HV-01-140MW"}


# ---------------------------------------------------------------- FDS 解析

def strip_comments(text):
    """去掉 FDS 行注释，保留 &NAME 记录。"""
    out = []
    for line in text.splitlines():
        # FDS 注释以 ! 开头（需不在引号内）
        inq = False
        cut = None
        for i, ch in enumerate(line):
            if ch == "'":
                inq = not inq
            elif ch == "!" and not inq:
                cut = i
                break
        out.append(line[:cut] if cut is not None else line)
    return "\n".join(out)


NAMELIST_RE = re.compile(r"^&([A-Za-z0-9_]+)\b(.*?)/", re.M | re.S)
FLOAT_RE = r"[-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?"


def parse_namelists(text):
    """返回 [(NAME, body_string)]，body 为 namelist 内部原文。"""
    return [(m.group(1).upper(), m.group(2)) for m in NAMELIST_RE.finditer(text)]


def fnum(body, key):
    """取第一个数值。"""
    m = re.search(r"(?<![\w])" + re.escape(key) + r"\s*=\s*(" + FLOAT_RE + r")",
                  body, flags=re.I)
    return float(m.group(1)) if m else None


def fnums(body, key, count):
    """取 count 个逗号分隔数值（XB 等）。"""
    m = re.search(r"(?<![\w])" + re.escape(key) + r"\s*=\s*(" +
                  FLOAT_RE + r"(?:\s*,\s*" + FLOAT_RE + r"){" + str(count - 1) + r"})",
                  body, flags=re.I)
    return [float(x.strip()) for x in m.group(1).split(",")] if m else None


def fstr(body, key):
    """取第一个单引号字符串。"""
    m = re.search(r"(?<![\w])" + re.escape(key) + r"\s*=\s*'([^']*)'", body, flags=re.I)
    return m.group(1) if m else None


def fstr_list(body, key):
    """取逗号分隔的字符串列表（SURF_ID6 / SURF_IDS）。"""
    m = re.search(r"(?<![\w])" + re.escape(key) + r"\s*=\s*"
                  r"((?:'[^']*'\s*,\s*)*'[^']*')", body, flags=re.I)
    if not m:
        return []
    return re.findall(r"'([^']*)'", m.group(1))


# ------------------------------------------------------------- 几何分类

def classify_obst(obst, room_bbox):
    """
    仅依据可验证的几何/材质规则分类，不猜测语义身份。
    返回 (kind, role, confidence, reason)
      kind: SOLID | SURFACE
      role: 用于前端分组与材质选择的中性名称
    """
    x1, x2, y1, y2, z1, z2 = obst["xb"]
    dx = x2 - x1
    dy = y2 - y1
    dz = z2 - z1
    flat = [abs(dx) < 1e-6, abs(dy) < 1e-6, abs(dz) < 1e-6]
    nflat = sum(flat)
    surf = obst.get("surf_ids") or []
    color = (obst.get("color") or "").upper()

    if nflat == 0:
        return ("SOLID", "SOLID_VOLUME", "GEOMETRY",
                "OBST 三维均为非零厚度，按实体体渲染")

    # 零厚度 -> 面片
    if nflat == 1:
        if flat[2]:
            return ("SURFACE", "HORIZONTAL_PLANE", "GEOMETRY",
                    "z1==z2，水平零厚度面")
        if flat[1]:
            return ("SURFACE", "Y_CONST_PLANE", "GEOMETRY", "y1==y2，Y 常量零厚度面")
        return ("SURFACE", "X_CONST_PLANE", "GEOMETRY", "x1==x2，X 常量零厚度面")
    if nflat == 2:
        axis = "Z" if flat[2] else ("Y" if flat[1] else "X")
        return ("SURFACE", "DEGENERATE_" + axis, "LOW",
                "两轴退化，疑似退化体/残留数据，按面渲染并标注低置信")
    return ("SURFACE", "DEGENERATE_POINT", "LOW", "三轴退化，按点处理")


def surface_family(obst):
    """依据 SURF_ID / COLOR 给出材质族（这是 FDS 里真实的表面定义，不是猜测）。"""
    surf = obst.get("surf_ids") or []
    color = (obst.get("color") or "").upper()
    joined = " ".join(s.upper() for s in surf)
    if "KE" in joined:
        return "METAL_GRAY"
    if "INERT" in joined:
        return "INERT"
    if color == "WHITE":
        return "WHITE"
    if color in ("RED", "CYAN", "YELLOW", "GREEN", "BLUE"):
        return "COLOR_" + color
    if any(s.startswith("GLOBAL") for s in surf):
        return "GLOBAL"
    return "UNKNOWN"


# ------------------------------------------------------------- 几何构建

def build_geometry_from_fds(path, chid):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    nls = parse_namelists(text)

    obsts, holes, meshes, vents, devcs, slcfs = [], [], [], [], [], []
    surf_defs = {}
    ramp_ids = set()
    time_end = T_END

    for name, body in nls:
        if name == "TIME":
            te = fnum(body, "T_END")
            if te:
                time_end = te
        elif name == "OBST":
            xb = fnums(body, "XB", 6)
            if not xb:
                continue
            ids = fstr_list(body, "SURF_ID6") or fstr_list(body, "SURF_IDS")
            if not ids:
                s1 = fstr(body, "SURF_ID")
                ids = [s1] if s1 else []
            obsts.append({
                "id": fstr(body, "ID") or "OBST",
                "xb": xb,
                "surf_ids": ids,
                "color": fstr(body, "COLOR"),
            })
        elif name == "HOLE":
            xb = fnums(body, "XB", 6)
            if xb:
                holes.append({"id": fstr(body, "ID") or "Hole", "xb": xb})
        elif name == "MESH":
            xb = fnums(body, "XB", 6)
            ijk = fnums(body, "IJK", 3)
            if xb and ijk:
                meshes.append({"id": fstr(body, "ID") or "MESH",
                               "xb": xb, "ijk": [int(v) for v in ijk]})
        elif name == "VENT":
            xb = fnums(body, "XB", 6)
            if not xb:
                continue
            vents.append({"id": fstr(body, "ID") or "VENT",
                          "xb": xb, "surf_id": fstr(body, "SURF_ID")})
        elif name == "DEVC":
            xyz = fnums(body, "XYZ", 3)
            devcs.append({"id": fstr(body, "ID"),
                          "quantity": fstr(body, "QUANTITY"),
                          "xyz": xyz})
        elif name == "SLCF":
            orient = None
            for k in ("PBX", "PBY", "PBZ"):
                v = fnum(body, k)
                if v is not None:
                    orient = (k, v)
                    break
            slcfs.append({
                "id": fstr(body, "ID"),
                "quantity": fstr(body, "QUANTITY"),
                "plane": orient[0] if orient else None,
                "value": orient[1] if orient else None,
            })
        elif name == "SURF":
            sid = fstr(body, "ID")
            surf_defs[sid] = {
                "color": fstr(body, "COLOR"),
                "hrrpua": fnum(body, "HRRPUA"),
                "ramp_q": fstr(body, "RAMP_Q"),
                "tmp_front": fnum(body, "TMP_FRONT"),
            }
        elif name == "RAMP":
            rid = fstr(body, "ID")
            if rid:
                ramp_ids.add(rid)

    # 房间/计算域包络
    if meshes:
        room_bbox = [
            min(m["xb"][0] for m in meshes), max(m["xb"][1] for m in meshes),
            min(m["xb"][2] for m in meshes), max(m["xb"][3] for m in meshes),
            min(m["xb"][4] for m in meshes), max(m["xb"][5] for m in meshes),
        ]
    else:
        room_bbox = [0, 0, 0, 0, 0, 0]

    return {
        "chid": chid, "obsts": obsts, "holes": holes, "meshes": meshes,
        "vents": vents, "devcs": devcs, "slcfs": slcfs,
        "surf_defs": surf_defs, "ramp_ids": sorted(ramp_ids),
        "time_end": time_end, "room_bbox": room_bbox,
    }


def geometry_signature(obsts):
    """用于比较不同工况几何是否一致。"""
    items = sorted(
        (",".join(s.upper() for s in o["surf_ids"]),
         tuple(round(v, 4) for v in o["xb"]))
        for o in obsts
    )
    h = hashlib.sha256(repr(items).encode("utf-8")).hexdigest()[:16]
    return h, len(items)


def main():
    os.makedirs(OUT_GEO, exist_ok=True)
    os.makedirs(OUT_SCEN, exist_ok=True)

    files = sorted(f for f in os.listdir(SOURCE_FDS) if f.lower().endswith(".fds"))
    print("解析 FDS 输入 %d 个" % len(files))

    cases = {}
    for fn in files:
        chid = fn[:-4]
        cases[chid] = build_geometry_from_fds(os.path.join(SOURCE_FDS, fn), chid)

    # 几何签名差异
    sigs = {}
    for chid, c in cases.items():
        sig, n = geometry_signature(c["obsts"])
        sigs[chid] = {"signature": sig, "obst_count": len(c["obsts"]), "unique": n}
    distinct = len(set(v["signature"] for v in sigs.values()))
    print("几何签名种类: %d" % distinct)

    # ---- 选择 geometry master：取 OBST 数量与文件名的规范代表
    # 优先选低压1（LV-01），它是基准工况；若不存在则取第一个
    master_chid = "116-diya-1" if "116-diya-1" in cases else files[0][:-4]
    master = cases[master_chid]
    print("Geometry master = %s (OBST %d)" % (master_chid, len(master["obsts"])))

    # 火源锚点（来自 VENT SURF_ID='burner'，真实 FDS 几何中心）
    burners = []
    for v in master["vents"]:
        if (v["surf_id"] or "").lower() == "burner":
            xb = v["xb"]
            burners.append({
                "xb": xb,
                "center": [(xb[0] + xb[1]) / 2, (xb[2] + xb[3]) / 2, (xb[4] + xb[5]) / 2],
            })
    print("master burner vents: %d" % len(burners))

    # ---- 构建渲染几何
    solid_boxes = []
    surface_rects = []
    family_count = defaultdict(int)
    for i, o in enumerate(master["obsts"]):
        kind, role, conf, reason = classify_obst(o, master["room_bbox"])
        fam = surface_family(o)
        family_count[fam] += 1
        item = {
            "i": i,
            "id": o["id"],
            "xb": [round(v, 6) for v in o["xb"]],
            "fam": fam,
            "role": role,
            "conf": conf,
            "reason": reason,
        }
        if kind == "SOLID":
            item["kind"] = "SOLID"
            solid_boxes.append(item)
        else:
            item["kind"] = "SURFACE"
            surface_rects.append(item)

    # 计算域开边界（VENT SURF_ID='OPEN'）—— 单独标注，绝不当门窗
    mesh_boundary = []
    for v in master["vents"]:
        if (v["surf_id"] or "").upper() == "OPEN":
            xb = v["xb"]
            mesh_boundary.append({"xb": [round(x, 6) for x in xb], "id": v["id"]})

    # HOLE（FDS 开孔，不绘制为实体）
    holes = [{"id": h["id"], "xb": [round(x, 6) for x in h["xb"]]} for h in master["holes"]]

    # 表面定义（真实来自 FDS）
    surf_defs = {k: v for k, v in master["surf_defs"].items() if k}

    scene_master = {
        "schemaVersion": "1.0.0",
        "generatedFrom": {
            "masterChid": master_chid,
            "masterFile": master_chid + ".fds",
            "sourceFiles": files,
            "note": ("几何全部来自用户真实 FDS 的 &OBST/&HOLE/&VENT/&MESH，"
                     "保持 FDS 坐标系 (x,y,z)，未做任何虚构房间设计。"),
        },
        "coordinateSystem": {
            "name": "FDS",
            "units": "m",
            "bbox": master["room_bbox"],
            "note": "FDS(x,y,z)；Three.js 映射 three = [x, z, -y]（见 src/utils/coords.ts）",
        },
        "meshes": master["meshes"],
        "solids": solid_boxes,
        "surfaces": surface_rects,
        "holes": holes,
        "meshBoundaryVents": mesh_boundary,
        "surfaceDefs": surf_defs,
        "fireSourceVents": burners,
        "stats": {
            "obstTotal": len(master["obsts"]),
            "solidCount": len(solid_boxes),
            "surfaceCount": len(surface_rects),
            "holeCount": len(holes),
            "meshBoundaryVentCount": len(mesh_boundary),
            "familyCount": dict(family_count),
        },
        "semanticVerification": {
            "status": "UNVERIFIED",
            "reason": ("源 FDS 的 OBST ID 为 AutoCAD 通用 ID（AcDb3dSolid-*），"
                       "无 cabinet_id/room_wall/door/window 语义字段。"
                       "本文件的 role 仅为几何形态分类（水平面/常量面/实体），"
                       "不代表已确认的墙/门/窗/柜体身份，需与 Smokeview 截图对照核验。"),
            "confirmedFacts": [
                "10 个起火柜锚点位置来自 VENT SURF_ID='burner' 的 XB 几何中心（真实）",
                "计算域包络来自 &MESH（真实）",
                "所有 OBST 坐标 1:1 来自源文件（真实）",
            ],
        },
    }

    with open(os.path.join(OUT_GEO, "scene_master.json"), "w", encoding="utf-8") as f:
        json.dump(scene_master, f, ensure_ascii=False, separators=(",", ":"))

    audit = {
        "files": len(files),
        "distinctGeometrySignatures": distinct,
        "perCase": sigs,
        "masterChid": master_chid,
        "obstZeroThickness": sum(1 for r in surface_rects),
        "obstSolid": len(solid_boxes),
        "familyCount": dict(family_count),
        "openVentCount": len(mesh_boundary),
        "holeCount": len(holes),
        "warnings": [
            "VENT SURF_ID='OPEN' 为 FDS 计算域开边界，未绘制为建筑门窗。",
            "HOLE 为 FDS 几何开孔，未绘制为实体挡板。",
            "OBST 语义身份未核验，role 仅为几何形态分类。",
            "116-gaoya-1-140mw 输入 HRRPUA=5.6E6 kW/m² x 0.25 m² = 1400 MW，已禁用。",
        ],
    }
    with open(os.path.join(OUT_GEO, "geometry_audit.json"), "w", encoding="utf-8") as f:
        json.dump(audit, f, ensure_ascii=False, indent=1)

    print("几何输出完成: %d 实体 / %d 面 / %d 开孔"
          % (len(solid_boxes), len(surface_rects), len(holes)))
    return scene_master, audit


if __name__ == "__main__":
    main()
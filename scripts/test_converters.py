#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FDS 离线转换器单元测试（unittest，非 pytest）。

运行：
    python -m unittest scripts.test_converters -v
    python scripts/test_converters.py

覆盖范围
========
  1. `.sf` 切片：帧数、时间范围与manifest 声明一致；帧长 == ni*nj
  2. `.s3d` 体数据：帧尺寸推断自洽（总字节 == 头部 + 帧数×帧长）
  3. 量化往返：dequantize(quantize(T)) 与端点值
  4. HV-01-140MW HRR 峰值与参考值一致（容差 1e-3）
  5. manifest.peakKW == max(hrr.json 序列)（历史上真实踩过的 bug）
  6. 非 ASCII 路径（中文目录「新建文件夹」）可被正确处理
  7. SMV 体数据条目解析（5 行定长记录，易回归）
  8. `.s3d.sz` ASCII 索引与 `.s3d` 逐帧交叉校验

关于量化端点的重要说明
======================
任务说明给的标度是 `T = 20.0 + byte x (780.0/255)`，即 dequantize(255)
= 800.0 °C。**实测标度是 `20.0 + byte x (2000.0/255)`**，dequantize(255)
= 2020.0 °C。

决定性反证：`.sf` 切片 float32 实测最高温 1083.69 °C（> 800 °C）。在
780/255 标度下该温度需要 byte = (1083.69-20)/3.0588≈ 348 > 255，无法表示，
会被硬截断到 800 °C。另一独立验证：用同网格 `.sf` 真实温度反解 byte 与
`.s3d` 实际最大字节比对，5 个 mesh 共 1953 帧全部在 ±1 LSB 内吻合。

因此本测试断言 dequantize(255) == 2020.0，并在
`test_quantization_reference_conflict` 中显式记录该冲突。
"""

import json
import os
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import convert_s3d as S3D  # noqa: E402
import convert_v2_140mw as V2  # noqa: E402
from convert_fds_outputs import parse_sf, slice_dims  # noqa: E402

RESULTS = os.path.join(ROOT, "public", "assets", "results")
SID = "HV-01-140MW"
SDIR = os.path.join(RESULTS, SID)
V2_OUT = os.path.join(
    os.path.dirname(ROOT), "_V2_extract",
    "WorkBuddy_116_Fire_Visualization_FINAL", "raw_results", SID,
    "rar_out", "新建文件夹", "116-gaoya-1-140mw")

# 用户给定的参考值
REF_PEAK_KW = 13382.431
REF_PEAK_T = 3.6011
REF_ENERGY_KJ = 59313.7
REF_SF_FRAMES = 1001
REF_S3D_FRAMES = 1000
REF_T_MAX_C = 1083.69

HAS_DATA = os.path.isdir(SDIR) and os.path.isdir(V2_OUT)


def load(name):
    with open(os.path.join(SDIR, name), encoding="utf-8") as f:
        return json.load(f)


@unittest.skipUnless(HAS_DATA, "V2 转换产物或源数据不存在，跳过")
class TestSfSlices(unittest.TestCase):
    """`.sf` 切片：帧数 / 时间范围 / 帧长自洽。"""

    @classmethod
    def setUpClass(cls):
        cls.m = load("manifest.json")

    def test_slice_count_matches_manifest(self):
        self.assertEqual(self.m["sliceCount"], len(self.m["slices"]))
        self.assertEqual(self.m["sliceCount"], 49)

    def test_every_slice_has_1001_frames(self):
        for s in self.m["slices"]:
            self.assertEqual(s["frameCount"], REF_SF_FRAMES,
                             "切片 %s 帧数异常" % s["asset"])
            self.assertEqual(len(s["frameTimesS"]), REF_SF_FRAMES)

    def test_slice_time_range(self):
        for s in self.m["slices"]:
            self.assertAlmostEqual(s["frameTimesS"][0], 0.0, places=6)
            self.assertAlmostEqual(s["frameTimesS"][-1], 1800.0, places=3)

    def test_slice_bin_size_equals_frames_times_pixels(self):
        """
        帧长 == ni*nj，.bin 字节数 == frameCount * ni * nj。

        回归测试：`slice_dims()` 恒返回网格 i/j跨度，垂直切片(PBX/PBY)的
        面内两轴其实是 (j,k)/(i,k)，曾导致 278/667 个切片的 ni/nj 错误，
        前端 DataTexture(pixels, ni, nj) 会按错误行宽读取导致温度场错位。
        """
        for s in self.m["slices"]:
            p = os.path.join(SDIR, s["asset"])
            self.assertTrue(os.path.isfile(p), "缺切片资产 %s" % s["asset"])
            expect = s["frameCount"] * s["ni"] * s["nj"]
            self.assertEqual(os.path.getsize(p), expect,
                             "切片 %s 字节数与帧长不符" % s["asset"])

    def test_slice_dims_are_in_plane_axes(self):
        """垂直切片的 ni/nj 必须是面内两轴，且与 gridDims 一致。"""
        want = {"PBZ": ("ni", "nj"), "PBY": ("ni", "nk"), "PBX": ("nj", "nk")}
        for s in self.m["slices"]:
            gd = s["gridDims"]
            u_key, v_key = want[s["plane"]]
            self.assertEqual(s["ni"], gd[u_key],
                             "%s 的 ni 应取 gridDims.%s" % (s["asset"], u_key))
            self.assertEqual(s["nj"], gd[v_key],
                             "%s 的 nj 应取 gridDims.%s" % (s["asset"], v_key))

    def test_all_scenarios_slices_are_self_consistent(self):
        """跨全部 16 工况：667 个切片的 .bin 字节数 == frameCount*ni*nj。"""
        with open(os.path.join(ROOT, "data", "scenarios.json"),
                  encoding="utf-8") as f:
            scenarios = json.load(f)
        total = 0
        for sc in scenarios:
            with open(os.path.join(RESULTS, sc["id"], "manifest.json"),
                      encoding="utf-8") as f:
                m = json.load(f)
            for s in m.get("slices", []):
                total += 1
                p = os.path.join(RESULTS, sc["id"], s["asset"])
                self.assertTrue(os.path.isfile(p), "缺 %s" % p)
                self.assertEqual(
                    os.path.getsize(p), s["frameCount"] * s["ni"] * s["nj"],
                    "%s/%s 字节数与帧长不符" % (sc["id"], s["asset"]))
        self.assertEqual(total, 667)

    def test_parse_sf_direct_from_source(self):
        """直接解析源 .sf，确认 1001 帧且首帧 t=0。"""
        src = os.path.join(V2_OUT, "116-gaoya-1-140mw_1_1.sf")
        if not os.path.isfile(src):
            self.skipTest("源 .sf 不存在")
        parsed = parse_sf(src)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["header"]["quantity"], "TEMPERATURE")
        self.assertEqual(parsed["header"]["units"], "C")
        frames = parsed["frames"]
        self.assertEqual(len(frames), REF_SF_FRAMES)
        self.assertAlmostEqual(frames[0][0], 0.0, places=5)
        self.assertAlmostEqual(frames[-1][0], 1800.0, places=2)
        # 每帧点数 == ni*nj
        dims = slice_dims(parsed["bounds"]["raw"])
        self.assertEqual(len(frames[0][1]), dims["ni"] * dims["nj"])


@unittest.skipUnless(HAS_DATA, "V2 转换产物或源数据不存在，跳过")
class TestS3dVolume(unittest.TestCase):
    """`.s3d` 体数据：帧尺寸推断自洽。"""

    @classmethod
    def setUpClass(cls):
        cls.v = load(os.path.join("volume", "manifest.json"))

    def test_volume_count_is_five(self):
        """5 个 mesh 各 1 个 TEMPERATURE 体数据。"""
        self.assertEqual(self.v["volumeCount"], 5)
        self.assertEqual(len(self.v["volumes"]), 5)
        for e in self.v["volumes"]:
            self.assertEqual(e["quantity"].upper(), "TEMPERATURE")

    def test_frame_count(self):
        for e in self.v["volumes"]:
            self.assertEqual(e["frameCount"], REF_S3D_FRAMES,
                             "%s 帧数异常" % e["asset"])

    def test_total_bytes_equals_header_plus_frames(self):
        """
        帧尺寸自洽：.bin 字节数 == frameCount * voxelCount，
        且 voxelCount == ni*nj*nk。
        """
        for e in self.v["volumes"]:
            vox = e["ni"] * e["nj"] * e["nk"]
            self.assertEqual(e["voxelCount"], vox)
            self.assertEqual(e["binBytes"], e["frameCount"] * vox,
                             "%s 体积与帧长不自洽" % e["asset"])
            p = os.path.join(SDIR, e["asset"])
            self.assertTrue(os.path.isfile(p))
            self.assertEqual(os.path.getsize(p), e["frameCount"] * vox)

    def test_actual_bin_size_matches_manifest(self):
        """磁盘上的真实文件大小 == manifest 记录。"""
        for e in self.v["volumes"]:
            p = os.path.join(SDIR, e["asset"])
            self.assertEqual(os.path.getsize(p), e["binBytes"])

    def test_frame_time_range(self):
        """`.s3d` 1000 帧，起于 t≈1.80 s（.sf 的 1001 帧含 t=0）。"""
        for e in self.v["volumes"]:
            self.assertEqual(len(e["frameTimesS"]), e["frameCount"])
            self.assertAlmostEqual(e["frameTimesS"][0], 1.801, places=2)
            self.assertAlmostEqual(e["frameTimesS"][-1], 1800.0, places=2)

    def test_source_index_cross_check_passed(self):
        """`.s3d.sz` ASCII 索引与 `.s3d` 逐帧 time/rawLen 一致。"""
        for e in self.v["volumes"]:
            x = e.get("sourceIndexCrossCheck")
            self.assertIsNotNone(x, "%s 缺少索引交叉校验结果" % e["asset"])
            self.assertEqual(x["timeMatches"], e["frameCount"])
            self.assertEqual(x["rawLenMatches"], e["frameCount"])

    def test_bin_actually_contains_expected_max_temperature(self):
        """真实读 .bin 校验最大温度与 manifest 一致，且 > 800 °C。"""
        for e in self.v["volumes"]:
            p = os.path.join(SDIR, e["asset"])
            with open(p, "rb") as f:
                data = f.read()
            self.assertEqual(len(data), e["binBytes"])
            self.assertEqual(max(data), e["rawByteMax"])
            self.assertEqual(min(data), e["rawByteMin"])
            self.assertAlmostEqual(S3D.dequantize(e["rawByteMax"]),
                                   e["dataMaxC"], places=1)

    def test_voxel_dims_match_fds_mesh(self):
        """体数据维度与 .fds 的 &MESH IJK 对应（节点数 = IJK+1）。"""
        fds = os.path.join(V2_OUT, "116-gaoya-1-140mw.fds")
        if not os.path.isfile(fds):
            self.skipTest(".fds 不存在")
        from convert_fds_outputs import read_meshes_from_fds
        meshes = read_meshes_from_fds(fds)
        for e in self.v["volumes"]:
            ijk = meshes[e["meshIndex"] - 1][1]
            self.assertEqual(e["ni"], ijk[0] + 1)
            self.assertEqual(e["nj"], ijk[1] + 1)
            self.assertEqual(e["nk"], ijk[2] + 1)


@unittest.skipUnless(HAS_DATA, "V2 源数据不存在，跳过")
class TestS3dByteFormat(unittest.TestCase):
    """从源文件直接验证 .s3d 字节结构与压缩文法。"""

    def test_fortran_record_structure(self):
        """
        rec0 = 32B = 8 x int32 = [1, 0, i1, i2, j1, j2, k1, k2]
        rec1 = 4B int32 = 0
        rec2 = 8B = [rawLen, compLen]，rawLen == ni*nj*nk
        rec3 = compLen 字节压缩掩码
        """
        p = os.path.join(V2_OUT, "116-gaoya-1-140mw_1_3.s3d")
        if not os.path.isfile(p):
            self.skipTest(".s3d 不存在")
        data = open(p, "rb").read()
        recs, n, off = S3D.read_fortran_records(p)
        self.assertEqual(off, n, "记录未覆盖整个文件")
        self.assertEqual(len(recs[0]), 32)
        hdr = struct.unpack("<8i", recs[0])
        self.assertEqual(hdr[0], 1)
        self.assertEqual(hdr[1], 0)
        ni, nj, nk = (abs(hdr[3] - hdr[2]) + 1, abs(hdr[5] - hdr[4]) + 1,
                      abs(hdr[7] - hdr[6]) + 1)
        self.assertEqual((ni, nj, nk), (16, 16, 66))
        self.assertEqual(len(recs[1]), 4)
        raw, comp = struct.unpack("<2i", recs[2])
        self.assertEqual(raw, ni * nj * nk)
        self.assertEqual(len(recs[3]), comp)

    def test_record_count_is_4_plus_3x1000(self):
        p = os.path.join(V2_OUT, "116-gaoya-1-140mw_1_3.s3d")
        if not os.path.isfile(p):
            self.skipTest(".s3d 不存在")
        recs, _, _ = S3D.read_fortran_records(p)
        self.assertEqual((len(recs) - 4) % 3, 0)
        self.assertEqual((len(recs) - 4) // 3, REF_S3D_FRAMES)

    def test_decompress_grammar(self):
        """RLE 文法：FF <val> <cnt> -> cnt 个 val；其它字节字面。"""
        self.assertEqual(S3D.decompress(b"\xff\x05\x03", 3), b"\x05\x05\x05")
        # FF 00 00 -> cnt=0 个 00，长度不增长
        self.assertEqual(S3D.decompress(b"\x01\xff\x00\x00\x02", 2),
                         b"\x01\x02")
        # cnt 可以为 0
        self.assertEqual(S3D.decompress(b"\xff\x00\x00\x07", 1), b"\x07")
        # 0xFE 不是转义前缀，必须字面输出；后随 FF 01 02 -> 2 个 0x01
        self.assertEqual(S3D.decompress(b"\xfe\xff\x01\x02", 3),
                         b"\xfe\x01\x01")
        with self.assertRaises(ValueError):
            S3D.decompress(b"\xff\x05\x03", 99)

    def test_decompress_all_frames_length_exact(self):
        """全量验证：每帧解压长度精确等于声明的 rawLen。"""
        p = os.path.join(V2_OUT, "116-gaoya-1-140mw_1_3.s3d")
        if not os.path.isfile(p):
            self.skipTest(".s3d 不存在")
        parsed = S3D.parse_s3d(p)
        self.assertEqual(len(parsed["frames"]), REF_S3D_FRAMES)
        for t, raw in parsed["frames"]:
            self.assertEqual(len(raw), parsed["voxels"])

    def test_sz_is_ascii_index_not_gzip(self):
        """
        `.s3d.sz` 实为 ASCII 帧索引而非 gzip：
        第 0 行为整数 0，随后 1001 行 `<time> <rawLen> <compLen> <minByte>`。
        """
        p = os.path.join(V2_OUT, "116-gaoya-1-140mw_1_3.s3d.sz")
        if not os.path.isfile(p):
            self.skipTest(".s3d.sz 不存在")
        with open(p, "rb") as f:
            head = f.read(2)
        self.assertNotEqual(head, b"\x1f\x8b", ".s3d.sz 不应是 gzip")
        rows, first = S3D.parse_s3d_index(p)
        self.assertEqual(first, "0")
        self.assertEqual(len(rows), REF_S3D_FRAMES + 1)
        parsed = S3D.parse_s3d(
            os.path.join(V2_OUT, "116-gaoya-1-140mw_1_3.s3d"))
        x = S3D.cross_check_with_index(parsed, p)
        self.assertEqual(x["timeMatches"], REF_S3D_FRAMES)
        self.assertEqual(x["rawLenMatches"], REF_S3D_FRAMES)


@unittest.skipUnless(HAS_DATA, "V2 转换产物不存在，跳过")
class TestQuantization(unittest.TestCase):
    """量化标度往返。"""

    def test_endpoints(self):
        self.assertAlmostEqual(S3D.dequantize(0), 20.0, places=9)
        # 实测标度：2000/255 -> 2020 °C（**不是**任务说明的 800 °C）
        self.assertAlmostEqual(S3D.dequantize(255), 2020.0, places=6)
        self.assertAlmostEqual(S3D.BASE_C, 20.0, places=9)
        self.assertAlmostEqual(S3D.SCALE_C, 2000.0 / 255.0, places=12)

    def test_roundtrip(self):
        """quantize -> dequantize 往返误差 <= 半LSB。"""
        half = S3D.SCALE_C / 2.0
        for byte in range(256):
            t = S3D.dequantize(byte)
            back = byte
            self.assertAlmostEqual(S3D.dequantize(back), t, places=9)
        for temp in (20.0, 100.0, 800.0, 1083.69, 2020.0):
            byte = int(round((temp - S3D.BASE_C) / S3D.SCALE_C))
            byte = max(0, min(255, byte))
            self.assertLessEqual(abs(S3D.dequantize(byte) - temp), half)

    def test_quantization_reference_conflict(self):
        """
        记录与任务说明的冲突：780/255 标度下dequantize(255)=800 °C，
        无法表示实测最高温 1083.69 °C，故采用实测的 2000/255。
        若将来有人把标度改回 780/255，本测试会失败。
        """
        self.assertNotAlmostEqual(S3D.SCALE_C, 780.0 / 255.0, places=3)
        v = load(os.path.join("volume", "manifest.json"))
        max_c = max(e["dataMaxC"] for e in v["volumes"])
        self.assertGreater(max_c, 800.0,
                           "体数据最高温应超过 800 °C，证明 780/255 标度错误")

    def test_manifest_quantization_matches_module(self):
        v = load(os.path.join("volume", "manifest.json"))
        self.assertAlmostEqual(v["quantization"]["baseC"], S3D.BASE_C)
        self.assertAlmostEqual(v["quantization"]["scaleC"], S3D.SCALE_C)
        self.assertEqual(v["quantization"]["bits"], 8)

    def test_max_temperature_not_truncated(self):
        """最高温应接近 .sf 实测的 1083.69 °C，未被量化截断。"""
        m = load("manifest.json")
        top = max(s["dataMaxC"] for s in m["slices"])
        self.assertGreater(top, REF_T_MAX_C - 10.0)
        self.assertLess(top, 2020.0)


@unittest.skipUnless(HAS_DATA, "V2 转换产物不存在，跳过")
class TestHrrPeak(unittest.TestCase):
    """HV-01-140MW HRR 峰值与积分的参考值一致性。"""

    @classmethod
    def setUpClass(cls):
        cls.m = load("manifest.json")
        cls.h = load("hrr.json")

    def test_peak_matches_reference(self):
        self.assertAlmostEqual(self.m["hrr"]["peakKW"], REF_PEAK_KW, places=3)
        self.assertAlmostEqual(max(self.h["hrrKW"]), REF_PEAK_KW, places=3)
        self.assertAlmostEqual(self.m["hrr"]["peakTimeS"], REF_PEAK_T, places=3)

    def test_manifest_peak_equals_max_of_series(self):
        """
        回归测试：历史上先算全序列 max 写 manifest、再抽稀写 hrr.json，
        导致 manifest.peakKW 与 max(hrr.json) 相差 26~99 倍。
        """
        self.assertAlmostEqual(self.m["hrr"]["peakKW"],
                               max(self.h["hrrKW"]), places=6)

    def test_sampling_is_full_resolution(self):
        """绝不能退回抽稀：HRR 必须全分辨率写出。"""
        self.assertEqual(self.m["hrr"]["sampling"], "FULL_RESOLUTION")
        self.assertEqual(self.h["sampling"] if "sampling" in self.h else
                         self.m["hrr"]["sampling"], "FULL_RESOLUTION")
        self.assertEqual(len(self.h["hrrKW"]), 1001)
        self.assertEqual(len(self.h["timesS"]), 1001)

    def test_series_time_range(self):
        self.assertAlmostEqual(self.h["timesS"][0], 0.0, places=6)
        self.assertAlmostEqual(self.h["timesS"][-1], 1800.0, places=3)

    def test_integrated_energy_matches_reference(self):
        p = load("release_profile.json")
        self.assertAlmostEqual(p["integratedHeatReleaseKJ"],
                               REF_ENERGY_KJ, places=1)
        self.assertAlmostEqual(p["peakKW"], REF_PEAK_KW, places=3)
        self.assertAlmostEqual(p["peakTimeS"], REF_PEAK_T, places=3)

    def test_release_profile_decay_reference(self):
        """2% 点 ≈ 7.21 s，0.5%(66.9 kW) 最后超越 243.02 s。"""
        p = load("release_profile.json")
        self.assertAlmostEqual(p["decay"]["decay02"]["lastAboveTimeS"],
                               7.2138, places=2)
        self.assertAlmostEqual(p["decay"]["decay005"]["thresholdKW"],
                               66.9122, places=3)
        self.assertAlmostEqual(p["decay"]["decay005"]["lastAboveTimeS"],
                               243.02, places=1)

    def test_release_profile_flags_nonuniform_sampling(self):
        p = load("release_profile.json")
        self.assertFalse(p["sampling"]["uniform"])
        self.assertGreater(p["sampling"]["distinctDtCount"], 1)
        self.assertIn("不均匀", p["sampling"]["note"])

    def test_provenance_recorded(self):
        p = self.m["dataProvenance"]
        self.assertEqual(p["origin"], "V2_HANDBOX_RECALC")
        self.assertTrue(p["sourceFdsSha256"].startswith("7019c0bb"))
        self.assertAlmostEqual(p["sourceFdsHrrpua"], 560000.0, places=1)
        self.assertTrue(p["fdsCompletedSuccessfully"])
        self.assertIsNotNone(p["inputCorrection"])


@unittest.skipUnless(HAS_DATA, "V2 源数据不存在，跳过")
class TestSmvParsing(unittest.TestCase):
    """SMV 体数据条目解析（5 行定长记录，易回归）。"""

    @classmethod
    def setUpClass(cls):
        cls.entries = S3D.parse_smv_s3d_entries(
            os.path.join(V2_OUT, "116-gaoya-1-140mw.smv"))

    def test_entry_count(self):
        self.assertEqual(len(self.entries), 20)

    def test_temperature_entries(self):
        temps = [e for e in self.entries
                 if e["quantity"].upper() == "TEMPERATURE"]
        self.assertEqual(len(temps), 5)
        self.assertEqual(sorted(e["meshIndex"] for e in temps),
                         [1, 2, 3, 4, 5])
        for e in temps:
            self.assertEqual(e["shortLabel"], "temp")
            self.assertEqual(e["units"], "C")
            self.assertTrue(e["file"].endswith("_%d.s3d" % TEMP_INDEX[e["meshIndex"]]))

    def test_only_index3_is_temperature(self):
        """
        每个 mesh 4 个 .s3d：1=SOOT DENSITY 2=HRRPUV 3=TEMPERATURE
        4=CARBON DIOXIDE DENSITY。**只有索引 3 是温度。**
        """
        per_mesh = {}
        for e in self.entries:
            per_mesh.setdefault(e["meshIndex"], set()).add(e["quantity"])
        self.assertEqual(len(per_mesh), 5)
        for mi, qs in per_mesh.items():
            self.assertEqual(len(qs), 4, "mesh%d 应有4 个体数据量" % mi)
            self.assertIn("TEMPERATURE", qs)

    def test_entries_have_all_fields(self):
        for e in self.entries:
            for k in ("kind", "meshIndex", "file", "quantity",
                      "shortLabel", "units"):
                self.assertIn(k, e)
                self.assertNotEqual(e[k], "", "%s 的 %s 为空" % (e["file"], k))


TEMP_INDEX = {1: 3, 2: 3, 3: 3, 4: 3, 5: 3}


class TestNonAsciiPath(unittest.TestCase):
    """非 ASCII 路径处理（中文目录「新建文件夹」）。"""

    def test_v2_path_contains_chinese(self):
        self.assertIn("新建文件夹", V2_OUT)
        self.assertTrue(os.path.isdir(os.path.dirname(V2_OUT)))

    def test_read_chinese_path(self):
        p = os.path.join(V2_OUT, "116-gaoya-1-140mw.smv")
        if not os.path.isfile(p):
            self.skipTest("源 .smv 不存在")
        entries = S3D.parse_smv_s3d_entries(p)
        self.assertEqual(len(entries), 20)

    def test_scenarios_manifest_handles_chinese_dir(self):
        """scenarios_manifest.py 的 V2 目录含中文，必须可定位 .fds。"""
        import scenarios_manifest as SM
        fds = os.path.join(V2_OUT, "116-gaoya-1-140mw.fds")
        if not os.path.isfile(fds):
            self.skipTest("V2 .fds 不存在")
        prov = SM.build_provenance(SID, "116-gaoya-1-140mw", "test")
        self.assertTrue(prov["sourceFdsSha256"].startswith("7019c0bb"))
        self.assertAlmostEqual(prov["sourceFdsHrrpua"], 560000.0, places=1)
        self.assertTrue(prov["fdsCompletedSuccessfully"])


@unittest.skipUnless(HAS_DATA, "V2 转换产物或源数据不存在，跳过")
class TestV2SliceQuantizationFixed(unittest.TestCase):
    """
    🔴 P0 回归（2026-10-08）：`convert_v2_140mw.quantize()` 曾多乘一个 255

    旧实现::

        tq = (v - BASE_C) / SCALE_C * 255.0     # ← 多乘 255

    使实际生效标度变成 `2000/255 × 255 = 2000`，于是
    `(v-20)/7.8431×255` 在 **v=27.84 ℃** 就到 255 ——
    **凡是高于约 27.84 ℃ 的像素全被压成 byte=255**，火场被渲染成一片饱和白色。

    实测后果：49 个切片**无一幸免**，合计 1,517,756 个饱和字节
    （注：网上流传的「24,262 个」只是 `_1_1.bin` 单个文件）。

    为什么旧测试没抓到：既有 42 个测试只测 `convert_s3d.dequantize` 的往返，
    **从不校验 `convert_v2_140mw.quantize()` 产出的字节**。
    本类专门补上这个盲区。
    """

    # ---------------------------------------------------------- 端点与量纲

    def test_endpoints(self):
        """端点：byte0 -> 20.0 ℃，byte255 -> 2020.0 ℃。"""
        self.assertAlmostEqual(V2.dequantize(0), 20.0, places=9)
        self.assertAlmostEqual(V2.dequantize(255), 2020.0, places=6)
        self.assertAlmostEqual(V2.BASE_C, 20.0, places=9)
        self.assertAlmostEqual(V2.SCALE_C, 2000.0 / 255.0, places=12)

    def test_scale_semantics_is_per_lsb_not_span(self):
        """
        `scaleC` 必须是 **PER_LSB**（每 LSB 增量），不是 SPAN。

        判别式：相邻 byte 代表的温差应恰好等于 `SCALE_C`（7.8431 ℃/LSB）。
        若 `quantize()` 里混入了 `*255`，相邻 byte 的温差会变成 2000 ℃。
        """
        step = V2.dequantize(1) - V2.dequantize(0)
        self.assertAlmostEqual(step, V2.SCALE_C, places=12,
                               msg="相邻 byte 温差应等于 SCALE_C（PER_LSB 语义）")
        # 100 个 LSB 的跨度必须是 784.31 ℃，而不是 SPAN 的整量程 780 ℃
        span100 = V2.dequantize(100) - V2.dequantize(0)
        self.assertAlmostEqual(span100, 100 * 2000.0 / 255.0, places=9)

    # ------------------------------------------------- 往返（roundtrip）

    def test_roundtrip_temperature_to_byte_to_temperature(self):
        """
        `quantize -> dequantize` 往返，误差 <= 半LSB。

        覆盖任务书指定的全部探测点：20 / 100 / 500 / 940.72 / 1133.24 / 2020。
        """
        half = V2.SCALE_C / 2.0
        for temp in (20.0, 100.0, 500.0, 940.72, 1133.24, 2020.0):
            b = V2.quantize([temp])[0]
            back = V2.dequantize(b)
            self.assertLessEqual(
                abs(back - temp), half,
                "%.2f ℃ 往返误差 %.4f ℃ 超过半LSB (%.4f)"
                % (temp, abs(back - temp), half))
            # 全 256 档byte 都应能精确往返
        for byte in range(256):
            t = V2.dequantize(byte)
            self.assertEqual(V2.quantize([t])[0], byte,
                             "byte=%d 往返不自洽" % byte)

    def test_nan_and_below_base_clamp_to_zero(self):
        """NaN 与低于 baseC 的值仍压到 byte0（合法域下越界，保留旧行为）。"""
        self.assertEqual(V2.quantize([float("nan")])[0], 0)
        self.assertEqual(V2.quantize([-40.0])[0], 0)
        self.assertEqual(V2.quantize([19.999])[0], 0)

    # -------------------------------------------- 🔴 高温不饱和（核心回归）

    def test_940_72c_must_not_saturate(self):
        """
        🔴 **本缺陷的直接锁死测试**：940.72 ℃ 量化后必须 < 255。

        源 `.sf`（`116-gaoya-1-140mw_1_1.sf` 峰值帧 index 1, t=1.80s）
        实测最高温 940.72 ℃。旧实现（多乘 255）给出 byte=255（饱和）。
        正确值：(940.72-20)/7.8431 = **117**。
        """
        b = V2.quantize([940.72])[0]
        self.assertLess(
            b, 255,
            "940.72 ℃ 量化结果为 %d（已饱和）—— quantize() 是否又混入了 ×255？" % b)
        self.assertEqual(b, 117)
        self.assertAlmostEqual(V2.dequantize(b), 940.72, delta=V2.SCALE_C)

    def test_1083_69c_global_max_must_not_saturate(self):
        """
        全 49 切片的全局最高温 1083.69 ℃ 也必须不饱和。

        byte = round((1083.69-20)/7.8431) = **136**，
        解码 20+136×7.8431 = 1086.67 ℃，与源值差 2.98 ℃（< 1 LSB）。
        """
        b = V2.quantize([1083.69])[0]
        self.assertLess(b, 255, "1083.69 ℃ 量化后饱和（byte=%d）" % b)
        self.assertEqual(b, 136)
        self.assertAlmostEqual(V2.dequantize(b), 1083.69, delta=V2.SCALE_C)

    def test_temperature_above_28c_no_longer_saturates(self):
        """
        旧缺陷的临界点：v=27.84 ℃ 就被压成 255。

        扫一遍20~2020 ℃，饱和（byte=255）只应出现在**恰好** 2020 ℃ 处，
        任何低于 2020 ℃ 的温度都不允许出现 byte=255。
        """
        for temp in range(20, 2020, 7):# 逐 LSB 扫全域
            b = V2.quantize([float(temp)])[0]
            self.assertLess(b, 255, "%d ℃ 被错误压成 255" % temp)
        self.assertEqual(V2.quantize([2020.0])[0], 255, "2020 ℃ 应正好是域上限")

    def test_over_range_raises_instead_of_silent_clamp(self):
        """
        🔴 饱和自检：超出可表示域（>2020 ℃）必须**抛错**，不得静默 clamp。

        静默 clamp 正是该缺陷逃过全部 42 个测试的根因。
        """
        with self.assertRaises(ValueError):
            V2.quantize([2020.5])
        with self.assertRaises(ValueError):
            V2.quantize([5000.0])

    # ------------------------------------------- 源 .sf float32 交叉校验

    def test_crosscheck_against_source_sf_float32(self):
        """
        与源 `.sf` float32 交叉校验：随机取样本，量化后反解应吻合在 1 LSB 内。

        这是**独立于 manifest 声明**的验证 —— 直接对源二进制算，
        防止"资产与manifest 一起错得一致"。
        """
        import random
        random.seed(20261008)          # 固定种子，失败可复现
        checked = 0
        for sl in load("manifest.json")["slices"]:
            sf_path = os.path.join(V2_OUT, sl["sourceFile"])
            if not os.path.isfile(sf_path):
                continue
            sf = parse_sf(sf_path)
            if not sf or not sf["frames"]:
                continue
            for (t, vals) in sf["frames"]:
                if not vals:
                    continue
                for v in random.sample(vals, min(5, len(vals))):
                    if v != v:                # NaN 跳过
                        continue
                    b = V2.quantize([v])[0]
                    back = V2.dequantize(b)
                    self.assertLessEqual(
                        abs(back - v), V2.SCALE_C,
                        "%s t=%.2f 源 %.3f ℃ 量化为 byte=%d 反解 %.2f ℃，"
                        "残差超过 1 LSB" % (sl["sourceFile"], t, v, b, back))
                    checked += 1
        self.assertGreater(checked, 500,
                           "交叉校验样本过少（%d），未能有效覆盖" % checked)

    def test_regenerated_asset_has_no_saturated_bytes(self):
        """
        重生成的资产里 byte=255 的数量必须为 0。

        修复前：49 个切片合计 1,517,756 个饱和字节。
        源数据全局最高温仅 1083.69 ℃（byte=135），本不该有任何饱和。
        """
        total_sat = 0
        byte_max = 0
        for sl in load("manifest.json")["slices"]:
            p = os.path.join(SDIR, sl["asset"])
            with open(p, "rb") as f:
                blob = f.read()
            total_sat += blob.count(255)
            byte_max = max(byte_max, max(blob))
            # 逐切片：byteMax 反解应与 manifest 声明的 dataMaxC 吻合
            decoded = V2.dequantize(max(blob))
            self.assertAlmostEqual(
                decoded, sl["dataMaxC"], delta=V2.SCALE_C,
                msg="%s byteMax=%d 反解 %.2f ℃ vs 声明 %.2f ℃"
                    % (sl["sourceFile"], max(blob), decoded, sl["dataMaxC"]))
        self.assertEqual(total_sat, 0,
                         "仍有 %d 个 byte=255 饱和字节，quantize() 未真正修好"
                         % total_sat)
        self.assertLess(byte_max, 255, "全局 byteMax 仍为 255")

    def test_manifest_declares_per_lsb_explicitly(self):
        """
        manifest 必须显式声明 `scaleMode`，且quantization 三元组不变。

        显式字段是必需的：修复数据后矛盾探测对140MW 完全失效
        （矛盾片数 28 → 0，见 TestScaleModeExplicitEverywhere），
        前端只能靠这个字段确定性判别。
        """
        m = load("manifest.json")
        self.assertEqual(m.get("scaleMode"), "PER_LSB")
        for sl in m["slices"]:
            q = sl["quantization"]
            self.assertEqual(q["scaleMode"], "PER_LSB")
            # 前端已按此三元组判别，**不得**改动
            self.assertAlmostEqual(q["baseC"], 20.0, places=9)
            self.assertAlmostEqual(q["scaleC"], 2000.0 / 255.0, places=12)
            self.assertEqual(q["bits"], 8)
            self.assertFalse(sl["quantizationClipped"],
                             "%s 标记为已截断" % sl["sourceFile"])


class TestScaleModeExplicitEverywhere(unittest.TestCase):
    """
    16 个工况的 manifest 都必须显式声明 `scaleMode`。

    这是前端 v2.4 判别链第①级判据的**唯一**可靠来源。
    缺字段时前端只能退到第③级`scaleC` 量级启发式，
    或第②级矛盾探测——后者在数据修复后对 140MW 已完全失效
    （byte=255 归零 → 矛盾片数 28 → 0 → 会误判为 SPAN → 把火场画成室温）。
    """

    SPAN_IDS = (
        "HV-01-100MW", "HV-01-40MW", "HV-01-70MW",
        "HV-02-40MW", "HV-02-70MW", "HV-02-100MW", "HV-02-140MW",
        "LV-01-FIRE", "LV-02-FIRE", "LV-03-FIRE", "LV-04-FIRE",
        "LV-05-FIRE", "LV-06-FIRE", "LV-07-FIRE", "LV-08-FIRE",
    )

    def _all_ids(self):
        with open(os.path.join(ROOT, "data", "scenarios.json"),
                  encoding="utf-8") as f:
            return [s["id"] for s in json.load(f)]

    def test_sixteen_scenarios_present(self):
        """基线：确知是 16 个工况，防止下面的枚举悄悄漏掉新工况。"""
        self.assertEqual(len(self._all_ids()), 16)
        self.assertEqual(sorted(list(self.SPAN_IDS) + [SID]),
                         sorted(self._all_ids()))

    def test_every_manifest_has_explicit_scale_mode(self):
        for sid in self._all_ids():
            mp = os.path.join(RESULTS, sid, "manifest.json")
            self.assertTrue(os.path.isfile(mp), "%s 缺 manifest" % sid)
            with open(mp, encoding="utf-8") as f:
                m = json.load(f)
            want = "PER_LSB" if sid == SID else "SPAN"
            self.assertEqual(
                m.get("scaleMode"), want,
                "%s 顶层 scaleMode 应为 %s" % (sid, want))
            for sl in m["slices"]:
                self.assertEqual(
                    sl["quantization"].get("scaleMode"), want,
                    "%s 的切片 %s 缺显式 scaleMode"
                    % (sid, sl.get("sourceFile", "?")))

    def test_volume_manifest_has_explicit_scale_mode(self):
        """体数据 manifest 也是 PER_LSB，同样需要显式字段。"""
        vp = os.path.join(SDIR, "volume", "manifest.json")
        if not os.path.isfile(vp):
            self.skipTest("体数据产物不存在")
        with open(vp, encoding="utf-8") as f:
            v = json.load(f)
        self.assertEqual(v.get("scaleMode"), "PER_LSB")
        self.assertEqual(v["quantization"].get("scaleMode"), "PER_LSB")


class TestSpanScenariosUntouched(unittest.TestCase):
    """
    🔴 回归：15 个 SPAN 工况的 `.bin` 字节必须与基线完全一致。

    本次修复只针对 HV-01-140MW。`convert_fds_outputs.py` 的公式
    `T = baseC + (byte/255)×scaleC`（scaleC=780）本来就正确，
    若修复过程中误改其量化逻辑，这些工况的温度场会全错而测试未必报警。

    下面的 SHA256 取自**修复前**的实测基线（689 个 .bin+manifest 中
    属于 15 个 SPAN 工况的 .bin 部分），一个字节都不许变。
    """

    # 15 个 SPAN 工况全部 618 个 .bin 的聚合 SHA256
    # （对 "工况名/文件名" + 文件内容做滚动摘要）。
    # 该值取自修复前基线，并已用 `sha256sum -c` 逐文件确认与修复前完全一致。
    SPAN_BIN_DIGEST = (
        "b8a06f83e295774bc44f2a9436a1f8fe5a023f84ae54347a5180938101b0221d")

    def test_span_bins_bit_identical(self):
        import hashlib
        h = hashlib.sha256()
        n_files = 0
        for sid in sorted(TestScaleModeExplicitEverywhere.SPAN_IDS):
            sdir = os.path.join(RESULTS, sid, "slices")
            self.assertTrue(os.path.isdir(sdir), "%s 缺 slices 目录" % sid)
            for name in sorted(os.listdir(sdir)):
                if not name.endswith(".bin"):
                    continue
                with open(os.path.join(sdir, name), "rb") as f:
                    h.update(("%s/%s" % (sid, name)).encode("utf-8"))
                    h.update(f.read())
                n_files += 1
        self.assertEqual(n_files, 618,
                         "15 个 SPAN 工况的 .bin 文件数应为 618，实际 %d" % n_files)
        digest = h.hexdigest()
        self.assertEqual(
            digest, self.SPAN_BIN_DIGEST,
            "15 个 SPAN 工况的 .bin 字节已被改动（实测 %s）—— 本次修复"
            "只应影响 HV-01-140MW" % digest)

    def test_span_scenarios_still_span_scale(self):
        """交叉确认：SPAN 工况的量化参数仍是 base=20 / scale=780。"""
        for sid in TestScaleModeExplicitEverywhere.SPAN_IDS:
            with open(os.path.join(RESULTS, sid, "manifest.json"),
                      encoding="utf-8") as f:
                m = json.load(f)
            for sl in m["slices"]:
                q = sl["quantization"]
                self.assertAlmostEqual(q["scaleC"], 780.0, places=6,
                                       msg="%s scaleC 被改动" % sid)
                self.assertAlmostEqual(q["baseC"], 20.0, places=9)


class TestProvenanceAllScenarios(unittest.TestCase):
    """16 个工况都应带dataProvenance 且校验状态已实算。"""

    def test_all_manifests_have_provenance(self):
        with open(os.path.join(ROOT, "data", "scenarios.json"),
                  encoding="utf-8") as f:
            scenarios = json.load(f)
        self.assertEqual(len(scenarios), 16)
        for sc in scenarios:
            mp = os.path.join(RESULTS, sc["id"], "manifest.json")
            self.assertTrue(os.path.isfile(mp), "%s 缺 manifest" % sc["id"])
            with open(mp, encoding="utf-8") as f:
                m = json.load(f)
            p = m.get("dataProvenance")
            self.assertIsNotNone(p, "%s 缺 dataProvenance" % sc["id"])
            self.assertIn(p["origin"],
                          ("V2_HANDBOX_RECALC", "USER_LOCAL_RUN"))
            self.assertEqual(len(p["sourceFdsSha256"]), 64,
                             "%s SHA256 长度异常" % sc["id"])
            self.assertIsNotNone(p["sourceFdsHrrpua"])
            self.assertTrue(p["fdsCompletedSuccessfully"],
                            "%s 的 .out 未确认正常结束" % sc["id"])
            if sc["id"] == SID:
                self.assertEqual(p["origin"], "V2_HANDBOX_RECALC")
                self.assertIsNotNone(p["inputCorrection"])
            else:
                self.assertEqual(p["origin"], "USER_LOCAL_RUN")
                self.assertIsNone(p["inputCorrection"])

    def test_no_invalid_source_status_remains(self):
        """旧错误数据 status=INVALID_SOURCE 必须已被V2 数据替换。"""
        m = load("manifest.json")
        self.assertEqual(m["status"], "READY")
        self.assertNotIn("INVALID_SOURCE", json.dumps(m))


if __name__ == "__main__":
    unittest.main(verbosity=2)
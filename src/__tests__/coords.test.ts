/**
 * 坐标变换与温度色标测试
 *
 * 覆盖：
 *  - fdsToThree / threeToFds 互逆（坐标映射不得有损）
 *  - fdsXbToThreeAabb 对已知 XB 输入输出正确
 *  - dequantizeTemp 两端（0 → 20℃，255 → 800℃）
 *  - temperatureToColor(20) 近背景色 + alpha≈0
 *  - 明度随温度单调递减
 *  - queryCabinetTemperature 越界返回 OUT_OF_RANGE 且 valueC===null
 *  -🔴 resolveScaleMode 的 v2.4 三级判别链（显式字段 > 矛盾探测 > 量级兜底）
 *    + gridDims 回归哨兵+ 140MW 资产 byte=255 饱和归零验证
 *    （读 public/assets/results 真实 manifest，不构造假 meta）
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  NO_DATA_COLOR,
  SLICE_MAX_C,
  SLICE_MIN_C,
  SLICE_QUANT,
  TEMP_MAX_C,
  TEMP_MIN_C,
  auditSliceScale,
  classifyTemperature,
  dequantizeTemp,
  fdsToThree,
  fdsToThreeV,
  fdsXbToThreeAabb,
  formatSimTime,
  quantNote,
  quantSpecFromSlice,
  resolveScaleMode,
  sliceQuantDomain,
  temperatureToAlpha,
  temperatureToColor,
  threeToFds,
} from '../utils/coords';
import { queryCabinetTemperature } from '../data/scenarioProvider';
import type { ScenarioSeries, SliceMeta } from '../types/domain';

/* ------------------------------ 坐标变换 ------------------------------ */

describe('fdsToThree / threeToFds 互逆', () => {
  const samples: Array<[number, number, number]> = [
    [0, 0, 0],
    [11.75, -11.95, 1.0], // HV-01 burner 中心（资产实测）
    [-1, -17.5, 6.5], // 房间 bbox 角点
    [14, 2, 0],
    [10.52, -13.65, 2.26], // LV-01 热电偶包络角点
    [-3.7, 8.25, 1.5],
  ];

  it('对每个采样点往返一致', () => {
    for (const [x, y, z] of samples) {
      const t = fdsToThree(x, y, z);
      const back = threeToFds(t[0], t[1], t[2]);
      expect(back[0]).toBeCloseTo(x, 10);
      expect(back[1]).toBeCloseTo(y, 10);
      expect(back[2]).toBeCloseTo(z, 10);
    }
  });

  it('映射规则为 three = [x, z, -y]', () => {
    expect(fdsToThree(11.75, -11.95, 1.0)).toEqual([11.75, 1.0, 11.95]);
    expect(threeToFds(11.75, 1.0, 11.95)).toEqual([11.75, -11.95, 1.0]);
  });

  it('FDS 的 z（高度）成为 Three 的 y（向上）', () => {
    expect(fdsToThree(0, 0, 6.5)[1]).toBe(6.5);
  });

  it('fdsToThreeV 与 fdsToThree 等价', () => {
    for (const [x, y, z] of samples) {
      expect(fdsToThreeV([x, y, z])).toEqual(fdsToThree(x, y, z));
    }
  });
});

describe('fdsXbToThreeAabb 对已知 XB 输入输出正确', () => {
  /**
   * ✅ 已修复（2026-10-08）：`fdsToThree` 的 y → -y 是**带符号翻转**，
   * 原实现先对 FDS 取 min/max 再整体映射，映射后未按分量重排，
   * 导致 `size[2] < 0`（房间包围盒为 -19.5）。
   * `RoomGeometry.tsx:91` 的 `if (size[2] < 1e-6) continue;`
   * 会把**每一个实体**都跳过 → 三维场景完全空白。
   *
   * 现实现为：8 个角点全部映射后逐分量取 min/max。
   * 下列断言由 `it.fails()` 转为普通 `it()`，作为回归哨兵。
   */

  it('HV-01 burner 面片（z 方向退化）', () => {
    // 资产 cabinets.json: HV-01 burnerXbFdsM = [11.5,12.0,-12.2,-11.7,1.0,1.0]
    // FDS x[11.5,12.0] y[-12.2,-11.7] z[1.0,1.0]
    // Three x[11.5,12.0] y[1.0,1.0] z[11.7, 12.2]  ← y 被取反后已重排
    const aabb = fdsXbToThreeAabb([11.5, 12.0, -12.2, -11.7, 1.0, 1.0]);
    expect(aabb.min[2]).toBeLessThanOrEqual(aabb.max[2]);
    expect(aabb.min).toEqual([11.5, 1.0, 11.7]);
    expect(aabb.max).toEqual([12.0, 1.0, 12.2]);
    expect(aabb.size).toEqual([0.5, 0, 0.5]);
    expect(aabb.center).toEqual([11.75, 1.0, 11.95]);
  });

  it('房间包围盒 [-1,14,-17.5,2,0,6.5]', () => {
    // FDS y[-17.5,2] ⇒ Three z[-2, 17.5]
    const aabb = fdsXbToThreeAabb([-1, 14, -17.5, 2, 0, 6.5]);
    expect(aabb.min[2]).toBeLessThanOrEqual(aabb.max[2]);
    expect(aabb.min).toEqual([-1, 0, -2]);
    expect(aabb.max).toEqual([14, 6.5, 17.5]);
    expect(aabb.size).toEqual([15, 6.5, 19.5]);
    expect(aabb.center).toEqual([6.5, 3.25, 7.75]);
  });

  it('HV-01-40MW slice[0] 的 meshXb（资产实测）', () => {
    // manifest.json: meshXb = [11.0,12.5,-12.5,-11.0,0.0,6.5]
    // FDS y[-12.5,-11.0] ⇒ Three z[11.0, 12.5]
    const aabb = fdsXbToThreeAabb([11.0, 12.5, -12.5, -11.0, 0.0, 6.5]);
    expect(aabb.min[2]).toBeLessThanOrEqual(aabb.max[2]);
    expect(aabb.min).toEqual([11.0, 0.0, 11.0]);
    expect(aabb.max).toEqual([12.5, 6.5, 12.5]);
    expect(aabb.size).toEqual([1.5, 6.5, 1.5]);
  });

  it('非退化实体的 size 三个分量必须为正（RoomGeometry.tsx:91 依赖该前提）', () => {
    // RoomGeometry.tsx:91 用 `size[i] < 1e-6` 跳过退化实体。
    // size[2] 若为负（房间 −19.5 / 切片 −1.5），**每一个实体**都会被跳过
    // → 三维场景完全空白。
    const cases: Array<{ xb: number[]; size: [number, number, number] }> = [
      { xb: [-1, 14, -17.5, 2, 0, 6.5], size: [15, 6.5, 19.5] },
      { xb: [11.0, 12.5, -12.5, -11.0, 0.0, 6.5], size: [1.5, 6.5, 1.5] },
    ];
    for (const { xb, size } of cases) {
      const actual = fdsXbToThreeAabb(xb).size;
      for (let i = 0; i < 3; i++) {
        expect(actual[i], `xb=${JSON.stringify(xb)} · 分量${i}`).toBeCloseTo(size[i], 10);
        expect(actual[i], `size[${i}] 绝不能为负`).toBeGreaterThan(0);
      }
    }
  });

  it('z 方向退化的面片：size[1]===0 是正确结果，不是 bug', () => {
    // burnerXbFdsM 的 z1===z2===1.0，是零厚度的加热面（贴地燃烧面）。
    // Three 轴序下 FDS z → Three y，故 size[1] 必须恰为 0，
    // RoomGeometry 的 `size[i] < 1e-6` 过滤正是为了跳过这种面片。
    const { size } = fdsXbToThreeAabb([11.5, 12.0, -12.2, -11.7, 1.0, 1.0]);
    expect(size[1]).toBe(0);
    expect(size[0]).toBeCloseTo(0.5, 10);
    expect(Math.abs(size[2])).toBeCloseTo(0.5, 10);
  });

  it('轴序颠倒的 XB 也能正确归一化 min/max', () => {
    const aabb = fdsXbToThreeAabb([12.0, 11.5, -11.7, -12.2, 1.0, 1.0]);
    expect(aabb.min[0]).toBeCloseTo(11.5, 10);
    expect(aabb.max[0]).toBeCloseTo(12.0, 10);
    expect(aabb.size[0]).toBeCloseTo(0.5, 10);
  });

  it('center 恒等于 (min+max)/2，size 恒等于 max-min（与分量顺序无关，应始终成立）', () => {
    const aabb = fdsXbToThreeAabb([11.5, 12.0, -12.2, -11.7, 1.0, 1.0]);
    for (let i = 0; i < 3; i++) {
      expect(aabb.center[i]).toBeCloseTo((aabb.min[i] + aabb.max[i]) / 2, 10);
      expect(aabb.size[i]).toBeCloseTo(aabb.max[i] - aabb.min[i], 10);
    }
  });
});

describe('formatSimTime', () => {
  it('格式化为 mm:ss', () => {
    expect(formatSimTime(0)).toBe('00:00');
    expect(formatSimTime(180)).toBe('03:00');
    expect(formatSimTime(1800)).toBe('30:00');
    expect(formatSimTime(9.0148)).toBe('00:09');
  });
});

/* ------------------------------ 反量化 ------------------------------ */

/**
 * ⚠️ 关键回归哨兵：两个转换器的 `scaleC` 语义**相反**
 *
 *  | 转换器 | 工况 | scaleC | 语义 | byte=255 |
 *  |---|---|---|---|---|
 *  | convert_fds_outputs.py | 其余 15 个 | 780 | SPAN（总跨度） | 800 ℃ |
 *  | convert_v2_140mw.py | HV-01-140MW | 2000/255≈7.8431 | PER_LSB（每LSB） | 2020 ℃ |
 *
 * 若对 140MW 误用 SPAN 公式，byte=141（实测 1133 ℃）会被解成
 * `20 + 141/255 × 7.84 = 24.3 ℃` —— 把火场画成室温，属于伪造数据。
 */
const SPAN_Q = { baseC: 20.0, scaleC: 780.0, bits: 8 } as const;
const PER_LSB_Q = { baseC: 20.0, scaleC: 2000.0 / 255.0, bits: 8 } as const;

describe('resolveScaleMode：显式字段契约', () => {
  it('仅按显式字段，scaleC 量级不得参与判断', () => {
    expect(resolveScaleMode({ scaleC: 7.84, scaleMode: 'SPAN' })).toBe('SPAN');
    expect(resolveScaleMode({ scaleC: 780, scaleMode: 'PER_LSB' })).toBe('PER_LSB');
  });
  it.each([undefined, null, SPAN_Q, PER_LSB_Q, {scaleC: -780}, {scaleC: NaN}])('缺少模式必须失败 %j', (q) => {
    expect(() => resolveScaleMode(q)).toThrow('manifest.scaleMode');
  });
  it('拒绝未知模式', () => {
    expect(() => resolveScaleMode({scaleC: 780, scaleMode: 'PER_SLICE' as never})).toThrow('manifest.scaleMode');
  });
});

/**
 * 🔴 P0 回归哨兵（2026-10-08）：`gridDims` 判据曾使**15/16 工况的温度场全错**
 *
 * 旧实现 `isV2SliceAsset(meta) = meta.gridDims !== undefined` 被当作 PER_LSB 的标志，
 * 但 `scripts/fix_slice_dims.py` 为修正垂直切片 ni/nj，**给全部 16 个工况的每个切片**
 * 都补写了 `gridDims`。于是该判据对 16/16 全部为真，
 * 15 个 scaleC=780 的 SPAN 工况被误判为 PER_LSB，最高温算出 10.8~19.7 万 ℃。
 *
 * 下列 meta **刻意带上真实存在的 `gridDims`**（本 bug 的触发条件），
 * 确保判别不再依赖该字段。
 */
describe('🔴 回归：gridDims 存在但 scaleC=780 的切片必须判为 SPAN', () => {
  /** LV-01-FIRE 切片[0] 的真实 gridDims（资产实测：fix_slice_dims.py 补写） */
  const REAL_GRID_DIMS = { ni: 16, nj: 16, nk: 66 };

  const spanSliceWithGridDims = {
    quantization: {...SPAN_Q, scaleMode: 'SPAN'},
    gridDims: REAL_GRID_DIMS,
  } as unknown as SliceMeta;

  it('quantSpecFromSlice 判为 SPAN（不是 PER_LSB）', () => {
    expect(quantSpecFromSlice(spanSliceWithGridDims).mode).toBe('SPAN');
  });

  it('gridDims 的有无完全不影响判别结果', () => {
    const withGD = quantSpecFromSlice(spanSliceWithGridDims).mode;
    const withoutGD = quantSpecFromSlice({
      quantization: {...SPAN_Q, scaleMode: 'SPAN'},
    } as unknown as SliceMeta).mode;
    expect(withGD).toBe(withoutGD);
    expect(withGD).toBe('SPAN');
  });

  it('解码两端正确：0 → 20 ℃，255 → 800 ℃（不是 2020 ℃）', () => {
    const spec = quantSpecFromSlice(spanSliceWithGridDims);
    expect(dequantizeTemp(0, spec.baseC, spec.scaleC, spec.mode)).toBe(20);
    expect(dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode)).toBe(800);
  });

  it('真实 LV-01 的 byteMax=255 不再解成 19.9 万 ℃', () => {
    // 资产实测：LV-01-FIRE 全域 byteMax=255，scaleC=780
    const spec = quantSpecFromSlice(spanSliceWithGridDims);
    const decoded = dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode);
    expect(decoded).toBe(800);
    // 旧逻辑（误判 PER_LSB）会得到 20 + 255×780 = 198,920 ℃
    expect(decoded).not.toBeGreaterThan(1000);
  });

  it('量化域为 20–800 ℃', () => {
    expect(sliceQuantDomain(spanSliceWithGridDims)).toEqual({ minC: 20, maxC: 800 });
  });
});

describe('dequantizeTemp 两种语义', () => {
  it('SPAN：byte=0 → 20 ℃，byte=255 → 800 ℃', () => {
    expect(dequantizeTemp(0, 20, 780, 'SPAN')).toBe(20);
    expect(dequantizeTemp(255, 20, 780, 'SPAN')).toBe(800);
    expect(dequantizeTemp(1, 20, 780, 'SPAN') - 20).toBeCloseTo(780 / 255, 10);
  });

  it('PER_LSB：byte=0 → 20 ℃，byte=255 → 2020 ℃', () => {
    expect(dequantizeTemp(0, 20, 2000 / 255, 'PER_LSB')).toBe(20);
    expect(dequantizeTemp(255, 20, 2000 / 255, 'PER_LSB')).toBeCloseTo(2020, 6);
  });

  it('**两条公式在同一字节上结果完全不同** —— 错用即伪造数据', () => {
    // HV-01-140MW 实测最高温 1133.24 ℃ 对应的字节
    const byteOf1133 = Math.round((1133.24 - 20) / (2000 / 255));
    expect(byteOf1133).toBe(142);
    const perLsb = dequantizeTemp(byteOf1133, 20, 2000 / 255, 'PER_LSB');
    const wrongSpan = dequantizeTemp(byteOf1133, 20, 2000 / 255, 'SPAN');
    expect(perLsb).toBeCloseTo(1133.24, 0);
    // 错用 SPAN 会得到约 24 ℃ —— 火场被画成室温
    expect(wrongSpan).toBeLessThan(30);
    expect(wrongSpan).not.toBeCloseTo(perLsb, 0);
  });

  it('两语义各自严格单调递增', () => {
    for (const mode of ['SPAN', 'PER_LSB'] as const) {
      let prev = -Infinity;
      const scale = mode === 'SPAN' ? 780 : 2000 / 255;
      for (let b = 0; b <= 255; b++) {
        const t = dequantizeTemp(b, 20, scale, mode);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
    }
  });

  it('缺省 mode为 SPAN（保持既有调用点行为不变）', () => {
    expect(dequantizeTemp(255, 20, 780)).toBe(800);
  });
});

describe('sliceQuantDomain：量化域必须逐切片从 manifest 读', () => {
  const spanSlice = {
    quantization: {...SPAN_Q, scaleMode: 'SPAN'},
  } as unknown as SliceMeta;
  const perLsbSlice = {
    quantization: {...PER_LSB_Q, scaleMode: 'PER_LSB'},
    gridDims: { ni: 16, nj: 16, nk: 66 },
  } as unknown as SliceMeta;

  it('SPAN 工况 → 域 20–800 ℃', () => {
    const d = sliceQuantDomain(spanSlice);
    expect(d.minC).toBe(20);
    expect(d.maxC).toBe(800);
  });

  it('PER_LSB 工况（140MW）→ 域 20–2020 ℃，**绝不是 800**', () => {
    const d = sliceQuantDomain(perLsbSlice);
    expect(d.minC).toBe(20);
    expect(d.maxC).toBeCloseTo(2020, 6);
    // 若误用 800 上限，1133 ℃ 会被静默截断成同一色（伪造数据）
    expect(d.maxC).toBeGreaterThan(1133.24);
  });

  it('quantSpecFromSlice 返回可直接解码的量化参数', () => {
    const spec = quantSpecFromSlice(perLsbSlice);
    expect(spec.mode).toBe('PER_LSB');
    // byte=142解码到 1133.73 ℃；实测最高1133.24 ℃，二者相差不到 1 个 LSB（7.84 ℃）——
    // 这是 8bit 量化的固有误差，不能断言到 0.5 ℃ 以内。
    const decoded = dequantizeTemp(142, spec.baseC, spec.scaleC, spec.mode);
    expect(Math.abs(decoded - 1133.24)).toBeLessThan(spec.scaleC);
  });

  it('quantNote 给出各工况真实步长（SPAN 3.06 / PER_LSB 7.84）', () => {
    expect(quantNote(quantSpecFromSlice(spanSlice))).toContain('3.06');
    expect(quantNote(quantSpecFromSlice(perLsbSlice))).toContain('7.84');
  });
});

describe('dequantizeTemp 两端与中点（SPAN 默认域，向后兼容）', () => {
  it('dequantizeTemp(0, 20, 780) === 20', () => {
    expect(dequantizeTemp(0, 20, 780)).toBe(20);
  });

  it('dequantizeTemp(255, 20, 780) === 800', () => {
    expect(dequantizeTemp(255, 20, 780)).toBe(800);
  });

  it('默认量化参数与两端一致', () => {
    expect(SLICE_QUANT.baseC).toBe(SLICE_MIN_C);
    expect(SLICE_QUANT.baseC + SLICE_QUANT.scaleC).toBe(SLICE_MAX_C);
    expect(SLICE_QUANT.bits).toBe(8);
  });

  it('量化步长 780/255 ≈ 3.0588 ℃', () => {
    expect(dequantizeTemp(1, 20, 780) - 20).toBeCloseTo(780 / 255, 10);
  });

  it('严格单调递增', () => {
    let prev = -Infinity;
    for (let b = 0; b <= 255; b++) {
      const t = dequantizeTemp(b, 20, 780);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });
});

/* ------------------------------ 色标 ------------------------------ */

describe('temperatureToColor(20) 近背景色且不可见', () => {
  it('20℃ 与背景 #F5F3EE 的通道差极小（Oklab ΔE 实测 0.007）', () => {
    const [r, g, b] = temperatureToColor(20);
    // 背景 F5F3EE = (245,243,238)，锚点 F8F3E9 = (248,243,233)
    expect(Math.abs(r - 245)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - 243)).toBeLessThanOrEqual(3);
    expect(Math.abs(b - 238)).toBeLessThanOrEqual(5);
  });

  it('20℃ 的 alpha 为 0（常温工况完全不着色，红线 P5）', () => {
    expect(temperatureToAlpha(20)).toBe(0);
  });

  it('低于 20℃ 钳制到左端且 alpha 仍为 0', () => {
    expect(temperatureToColor(-1.97)).toEqual(temperatureToColor(20));
    expect(temperatureToAlpha(-1.97)).toBe(0);
  });

  it('无切片数据的灰不含暖色相（中性灰通道极差小）', () => {
    const [r, g, b] = NO_DATA_COLOR;
    expect(r).toBe(0xf1);
    expect(g).toBe(0xef);
    expect(b).toBe(0xea);
    // R−B 差仅 7，远小于任何暖色相
    expect(r - b).toBeLessThanOrEqual(8);
  });

  it('NaN 返回无切片数据灰（绝不返回低温色）', () => {
    expect(temperatureToColor(Number.NaN)).toEqual(NO_DATA_COLOR);
  });
});

describe('temperatureToColor 明度随温度单调递减', () => {
  /** 相对亮度近似（sRGB → 线性 → 0.2126R+0.7152G+0.0722B） */
  function luma(rgb: [number, number, number]): number {
    const lin = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  it('默认模式：相邻温度采样点的亮度严格单调递减', () => {
    let prev = Infinity;
    const failures: string[] = [];
    for (let t = TEMP_MIN_C; t <= TEMP_MAX_C; t += 5) {
      const l = luma(temperatureToColor(t));
      if (l >= prev) {
        failures.push(`${t}℃: ${l.toFixed(6)} >= ${prev.toFixed(6)}`);
      }
      prev = l;
    }
    expect(failures).toEqual([]);
  });

  it('默认模式：12 锚点亮度从 96 附近单调降至很低', () => {
    const anchors = [20, 60, 120, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const ls = anchors.map((t) => luma(temperatureToColor(t)));
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i]).toBeLessThan(ls[i - 1]);
    }
    // 设计目标：首锚点接近白（L*≈96 → 相对亮度≈0.955），末锚点极暗
    expect(ls[0]).toBeGreaterThan(0.85);
    expect(ls[ls.length - 1]).toBeLessThan(0.02);
  });

  it('高对比模式：亮度同样严格单调递减', () => {
    let prev = Infinity;
    for (let t = TEMP_MIN_C; t <= SLICE_MAX_C; t += 5) {
      const l = luma(temperatureToColor(t, 'HIGH_CONTRAST'));
      expect(l).toBeLessThan(prev);
      prev = l;
    }
  });

  it('超域钳制到端点色，不做逐帧归一化', () => {
    expect(temperatureToColor(1200)).toEqual(temperatureToColor(TEMP_MAX_C));
    expect(temperatureToColor(5000)).toEqual(temperatureToColor(TEMP_MAX_C));
  });

  it('temperatureToAlpha 在 20→950 上非降', () => {
    let prev = -1;
    for (let t = 20; t <= 950; t += 5) {
      const a = temperatureToAlpha(t);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = a;
    }
    expect(temperatureToAlpha(950)).toBe(1);
  });
});

/* ------------------------------ 温度查询 ------------------------------ */

/** HV-01-40MW series.json 的真实前几个点（用于越界与插值测试） */
const SERIES: ScenarioSeries = {
  timesS: [0.0, 9.0148, 18.0079, 27.0, 36.0],
  fireSourceMaxC: [20.0, 620.479, 426.996, 300.0, 250.0],
  sensorCount: 126,
  aggregation: 'MAX_OVER_THERMOCOUPLE_IN_FIRE_SOURCE_REGION',
  sensorEnvelopeFdsM: [11.0, 12.154, -12.5, -12.5, 0.26, 2.257],
  sensorScopeNote: '本工况全部热电偶均布置在起火柜 burner 附近，代表起火柜区域温度。',
  spatialMax: [{ id: 'THCP18', maxC: 620.48, finalC: 20.01 }],
};

describe('queryCabinetTemperature 边界与诚实性', () => {
  it('series 为 null → NO_DATA 且 valueC 为 null', () => {
    const r = queryCabinetTemperature(null, 100);
    expect(r.valueC).toBeNull();
    expect(r.interpolation).toBe('NO_DATA');
  });

  it('越界时刻 → OUT_OF_RANGE 且 valueC === null（禁止填 0 或 20℃）', () => {
    const after = queryCabinetTemperature(SERIES, 999);
    expect(after.valueC).toBeNull();
    expect(after.interpolation).toBe('OUT_OF_RANGE');
    expect(after.nearestTimeS).toBe(36);

    const before = queryCabinetTemperature(SERIES, -1);
    expect(before.valueC).toBeNull();
    expect(before.interpolation).toBe('OUT_OF_RANGE');
    expect(before.nearestTimeS).toBe(0);
  });

  it('落在真实采样点上 → EXACT 且值精确', () => {
    const r = queryCabinetTemperature(SERIES, 9.0148);
    expect(r.interpolation).toBe('EXACT');
    expect(r.valueC).toBeCloseTo(620.479, 6);
  });

  it('帧间 → LINEAR_WITHIN_SCENARIO 且为线性插值', () => {
    const mid = (9.0148 + 18.0079) / 2;
    const r = queryCabinetTemperature(SERIES, mid);
    expect(r.interpolation).toBe('LINEAR_WITHIN_SCENARIO');
    expect(r.valueC).toBeCloseTo((620.479 + 426.996) / 2, 6);
  });

  it('恒返回 FDS_DEVC / SIMULATED 来源与 scopeNote（供 UI 同屏呈现）', () => {
    const r = queryCabinetTemperature(SERIES, 0);
    expect(r.source).toBe('FDS_DEVC');
    expect(r.quality).toBe('SIMULATED');
    expect(r.truthLabel).toBe('FDS SIMULATED');
    expect(r.scopeNote).toBe(SERIES.sensorScopeNote);
  });

  it('存在 null 读数时返回 NO_DATA 而非编造值', () => {
    const withHole: ScenarioSeries = { ...SERIES, fireSourceMaxC: [20.0, null, 426.996, 300.0, 250.0] };
    const r = queryCabinetTemperature(withHole, 9.0148);
    expect(r.valueC).toBeNull();
    expect(r.interpolation).toBe('NO_DATA');
  });
});

describe('classifyTemperature 阈值判定（界面判据，非物理判据）', () => {
  it('null / NaN → UNKNOWN', () => {
    expect(classifyTemperature(null, 60, 120)).toBe('UNKNOWN');
    expect(classifyTemperature(Number.NaN, 60, 120)).toBe('UNKNOWN');
  });

  it('低于预警 → NORMAL', () => {
    expect(classifyTemperature(20, 60, 120)).toBe('NORMAL');
    expect(classifyTemperature(59.9, 60, 120)).toBe('NORMAL');
  });

  it('介于预警与报警之间 → TEMPERATURE_WARNING', () => {
    expect(classifyTemperature(60, 60, 120)).toBe('TEMPERATURE_WARNING');
    expect(classifyTemperature(119.9, 60, 120)).toBe('TEMPERATURE_WARNING');
  });

  it('达到报警阈值 → FIRE_ALARM', () => {
    expect(classifyTemperature(120, 60, 120)).toBe('FIRE_ALARM');
    expect(classifyTemperature(620.479, 60, 120)).toBe('FIRE_ALARM');
  });
});

/* ------------------ 真实资产回归（读public/assets，不硬编码假 meta） ------------------ */

/**
 * 🔴 P0 回归（2026-10-08）：对**真实 manifest**逐工况验证判别。
 *
 * 本组测试直接读 `public/assets/results/<工况>/manifest.json`，
 * 不构造假 meta —— 因为本缺陷的触发条件正是「真实资产里gridDims 的扩散」，
 * 假 meta 复现不出它。
 *
 * 断言的物理事实（我对16 个工况的 .bin 逐字节实测得到）：
 *  - 15 个工况 scaleC=780.0（SPAN），全域byteMax 139~255
 *  - HV-01-140MW scaleC=7.8431（PER_LSB），全域byteMax=255
 *  - **全部 667 个切片都带 gridDims**（fix_slice_dims.py 所为）——
 *    所以任何以 gridDims 为判据的实现都会100% 误判。
 */
const RESULTS_DIR = path.resolve(process.cwd(), 'public/assets/results');

interface ManifestShape {
  scenarioId: string;
  scaleMode?: 'SPAN' | 'PER_LSB';
  slices: Array<{
    asset: string;
    dataMaxC: number;
    gridDims?: { ni: number; nj: number; nk: number };
    quantization: {
      baseC: number;
      scaleC: number;
      bits: number;
      scaleMode?: 'SPAN' | 'PER_LSB';
    };
  }>;
}

/** 全部 16 个工况 id（实测目录清单） */
const ALL_SCENARIOS = [
  'HV-01-40MW',
  'HV-01-70MW',
  'HV-01-100MW',
  'HV-01-140MW',
  'HV-02-40MW',
  'HV-02-70MW',
  'HV-02-100MW',
  'HV-02-140MW',
  'LV-01-FIRE',
  'LV-02-FIRE',
  'LV-03-FIRE',
  'LV-04-FIRE',
  'LV-05-FIRE',
  'LV-06-FIRE',
  'LV-07-FIRE',
  'LV-08-FIRE',
];

function loadManifest(sid: string): ManifestShape {
  const p = path.join(RESULTS_DIR, sid, 'manifest.json');
  if (!fs.existsSync(p)) throw new Error(`缺真实资产 manifest：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ManifestShape;
}

/** 读真实 .bin 的最大 byte（全域，含所有帧） */
function realByteMax(sid: string, asset: string): number {
  const buf = fs.readFileSync(path.join(RESULTS_DIR, sid, asset));
  let m = 0;
  for (const b of buf) if (b > m) m = b;
  return m;
}

describe('真实资产：15 个 SPAN 工况全部判为 SPAN', () => {
  const SPAN_SCENARIOS = ALL_SCENARIOS.filter((s) => s !== 'HV-01-140MW');

  it('确有 15 个 SPAN 工况（防止清单与资产脱节）', () => {
    expect(SPAN_SCENARIOS).toHaveLength(15);
  });

  it.each(SPAN_SCENARIOS)('%s：scaleC=780 → SPAN，域20–800 ℃', (sid) => {
    const m = loadManifest(sid);
    const s = m.slices[0];
    // 资产事实：SPAN 工况的 scaleC 恒为 780
    expect(s.quantization.scaleC).toBe(780);

    const meta = s as unknown as SliceMeta;
    expect(quantSpecFromSlice(meta).mode).toBe('SPAN');
    expect(sliceQuantDomain(meta)).toEqual({ minC: 20, maxC: 800 });

    const spec = quantSpecFromSlice(meta);
    expect(dequantizeTemp(0, spec.baseC, spec.scaleC, spec.mode)).toBe(20);
    expect(dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode)).toBe(800);
  });

  it.each(SPAN_SCENARIOS)('%s：真实切片即使带 gridDims 也不得误判', (sid) => {
    const m = loadManifest(sid);
    // 每个切片都检查，确保没有漏网的判别差异
    for (const s of m.slices) {
      expect(s.quantization.scaleC).toBe(780);
      expect(quantSpecFromSlice(s as unknown as SliceMeta).mode).toBe('SPAN');
    }
    // 且真实资产确实带 gridDims —— 这正是旧判据的失效条件
    expect(m.slices[0].gridDims).toBeDefined();
  });
});

describe('真实资产：HV-01-140MW 判为 PER_LSB，域 20–2020 ℃', () => {
  const SID = 'HV-01-140MW';

  it('scaleC=2000/255 → PER_LSB', () => {
    const s = loadManifest(SID).slices[0];
    expect(s.quantization.scaleC).toBeCloseTo(2000 / 255, 10);
    expect(quantSpecFromSlice(s as unknown as SliceMeta).mode).toBe('PER_LSB');
  });

  it('解码两端：0 → 20 ℃，**255 → 2020 ℃**（绝不是 800 ℃）', () => {
    const spec = quantSpecFromSlice(loadManifest(SID).slices[0] as unknown as SliceMeta);
    expect(dequantizeTemp(0, spec.baseC, spec.scaleC, spec.mode)).toBe(20);
    expect(dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode)).toBeCloseTo(2020, 6);
    // 若误判 SPAN，1133℃ 的火场会被画成约 24℃室温 —— 伪造数据
    expect(sliceQuantDomain(loadManifest(SID).slices[0] as unknown as SliceMeta).maxC).toBeGreaterThan(1133);
  });
});

describe('真实资产：残差自检（auditSliceScale）', () => {
  it('15 个 SPAN 工况的真实切片均不自洽告警（零误报）', () => {
    const suspects: string[] = [];
    for (const sid of ALL_SCENARIOS.filter((s) => s !== 'HV-01-140MW')) {
      const m = loadManifest(sid);
      for (const s of m.slices) {
        const byteMax = realByteMax(sid, s.asset);
        const a = auditSliceScale(s as unknown as SliceMeta, byteMax);
        if (a.suspect) suspects.push(`${sid}/${s.asset}: ${a.reason}`);
      }
    }
    expect(suspects).toEqual([]);
  });

  it('byte 饱和的 SPAN 切片不被误报（dataMaxC 可合法高于 800℃ 上限）', () => {
    // LV-05-FIRE 实测：byteMax=255 且 dataMaxC=953.36℃ > 800℃ 解码上限
    const m = loadManifest('LV-05-FIRE');
    const s = m.slices.find((x) => x.dataMaxC > 800);
    expect(s).toBeDefined();
    expect(realByteMax('LV-05-FIRE', s!.asset)).toBe(255);
    const a = auditSliceScale(s as unknown as SliceMeta, 255);
    expect(a.saturated).toBe(true);
    expect(a.suspect).toBe(false);
  });

  /**
   * 🔴 140MW：数据侧 P0 修复后**不再**被诊断为可疑
   *
   * 修复前：byteMax=255（→2020℃）但 dataMaxC≈1083.69℃，
   * 真实最高温远未触顶却被写满 255 ⇒ 编码器标度用错。
   *
   * `convert_v2_140mw.quantize()` 曾误写 `(v-20)/SCALE_C*255.0`（多乘 255），
   * 使 >27.84℃ 的像素全被压成 255。修正后 byteMax 降到 136，
   * 反解 1086.67℃ 与声明 1083.69℃ 相差 2.98℃（< 1 LSB）→ 自洽。
   *
   * ⚠️ 这条测试**从 suspect=true 翻转为 suspect=false**，是数据修复生效的直接证据。
   * 同时它也说明：矛盾探测一旦数据修好就失效（28 片 → 0 片），
   * 故 manifest 显式 `scaleMode` 字段是必需的兜底锚点。
   */
  it('🔴 140MW 真实切片修复后自洽（不再报「标度用错」）', () => {
    const m = loadManifest('HV-01-140MW');
    const s = m.slices[0];
    const byteMax = realByteMax('HV-01-140MW', s.asset);
    // 不再饱和
    expect(byteMax).toBeLessThan(255);
    const a = auditSliceScale(s as unknown as SliceMeta, byteMax);
    expect(a.suspect).toBe(false);
    expect(a.residualC).toBeLessThanOrEqual(2000 / 255);
  });

  it('全部 16 个工况的真实切片均零误报（修复后彻底自洽）', () => {
    const suspects: string[] = [];
    for (const sid of ALL_SCENARIOS) {
      for (const s of loadManifest(sid).slices) {
        const a = auditSliceScale(s as unknown as SliceMeta, realByteMax(sid, s.asset));
        if (a.suspect) suspects.push(`${sid}/${s.asset}: ${a.reason}`);
      }
    }
    expect(suspects).toEqual([]);
  });
});

/**
 * ✅ 16 个工况的 manifest 都必须显式声明 `scaleMode`（资产实测，非构造）
 *
 * 缺字段时前端只能退到量级启发式；140MW 修好后矛盾探测亦失效，
 * 显式字段是唯一确定性来源。
 */
describe('✅ 资产实测：16 个工况均显式声明 scaleMode', () => {
  const SPAN_SCENARIOS = ALL_SCENARIOS.filter((s) => s !== 'HV-01-140MW');

  it('确有 15 个 SPAN 工况（防止清单与资产脱节）', () => {
    expect(ALL_SCENARIOS).toHaveLength(16);
    expect(SPAN_SCENARIOS).toHaveLength(15);
  });

  it.each(ALL_SCENARIOS)('%s：顶层与逐切片 quantization 均声明正确 scaleMode', (sid) => {
    const m = loadManifest(sid) as ManifestShape & { scaleMode?: string };
    const want = sid === 'HV-01-140MW' ? 'PER_LSB' : 'SPAN';
    expect(m.scaleMode, `${sid} 顶层 scaleMode`).toBe(want);
    expect(m.slices.length).toBeGreaterThan(0);
    for (const s of m.slices) {
      expect(s.quantization.scaleMode, `${sid} 某切片 scaleMode`).toBe(want);
      // 显式字段优先：quantSpecFromSlice 走第①级，结果必然与之一致
      expect(quantSpecFromSlice(s as unknown as SliceMeta).mode).toBe(want);
    }
  });
});

/**
 * 🔴 140MW 数据侧 P0 修复后的资产完整性（读真实 .bin）
 *
 * `convert_v2_140mw.quantize()` 曾误写 `(v-20)/SCALE_C*255.0`（多乘 255），
 * 使 >27.84℃ 的像素全被压成 byte=255，49 个切片合计 1,517,756 个饱和字节，
 * 火场被渲染成一片饱和白色。修复后饱和字节必须归零。
 */
describe('🔴 140MW 切片资产：byte=255 饱和必须归零', () => {
  const SID = 'HV-01-140MW';
  const SCALE_C = 2000.0 / 255.0;

  /** 统计某切片 .bin 里 byte=255 的个数 */
  function countSaturated(sid: string, asset: string): number {
    const buf = fs.readFileSync(path.join(RESULTS_DIR, sid, asset));
    let n = 0;
    for (const b of buf) if (b === 255) n += 1;
    return n;
  }

  it('quantization 三元组未变（前端已按此判别）', () => {
    for (const s of loadManifest(SID).slices) {
      expect(s.quantization.baseC).toBeCloseTo(20.0, 9);
      expect(s.quantization.scaleC).toBeCloseTo(2000.0 / 255.0, 12);
      expect(s.quantization.bits).toBe(8);
    }
  });

  it('全 49 个切片的 byte=255 数量为 0（修复前为 1,517,756）', () => {
    let saturated = 0;
    for (const s of loadManifest(SID).slices) {
      saturated += countSaturated(SID, s.asset);
    }
    expect(saturated).toBe(0);
  });

  it('逐切片 byteMax<255，且反解温度与 manifest dataMaxC 吻合（< 1 LSB）', () => {
    for (const s of loadManifest(SID).slices) {
      const byteMax = realByteMax(SID, s.asset);
      expect(byteMax, `${s.asset} 不应饱和`).toBeLessThan(255);
      const decoded = 20.0 + byteMax * SCALE_C;
      expect(Math.abs(decoded - s.dataMaxC)).toBeLessThanOrEqual(SCALE_C);
    }
  });

  it('全局最高温解码回 ≈1083.69℃（源 .sf float32 实测值），byteMax=136', () => {
    let byteMax = 0;
    for (const s of loadManifest(SID).slices) {
      byteMax = Math.max(byteMax, realByteMax(SID, s.asset));
    }
    expect(byteMax).toBe(136);
    expect(Math.abs(20.0 + byteMax * SCALE_C - 1083.69)).toBeLessThanOrEqual(SCALE_C);
  });
});

/**
 * FDS <-> Three.js 坐标变换（docs/04 §7 约定）
 *
 * FDS 右手系: x 向东, y 向北, z 向上（重力方向为 -z）
 * Three.js 默认: y 向上
 *
 * 采用 three = [x, z, -y]
 *   - x -> x  (保持)
 *   - z -> y  (FDS 高度成为 Three 的 y)
 *   - y -> -z (FDS 深度反向后保持右手系)
 *
 * 反变换: fds = [X, -Z, Y]
 *
 * 注意：这是纯坐标系变换，不改变任何物理位置。已在多个相机视角下
 * 与 Smokeview 的 FDS 坐标数值（HV-01 = 11.75,-11.95,1.0 等）核对一致。
 */

import type { QuantScaleMode, SliceMeta } from '../types/domain';
import {THERMAL_RGB,THERMAL_MIN_C,THERMAL_MAX_C} from '../data/palettes/thermal';

export type FdsVec3 = [number, number, number];
export type ThreeVec3 = [number, number, number];

/** FDS (x,y,z) -> Three (X,Y,Z) */
export function fdsToThree(x: number, y: number, z: number): ThreeVec3 {
  return [x, z, -y];
}

export function fdsToThreeV([x, y, z]: FdsVec3): ThreeVec3 {
  return [x, z, -y];
}

/** Three (X,Y,Z) -> FDS (x,y,z) */
export function threeToFds(X: number, Y: number, Z: number): FdsVec3 {
  return [X, -Z, Y];
}

/**
 * FDS XB [x1,x2,y1,y2,z1,z2] -> Three AABB 的 min/max
 *
 * ⚠️ 关键：`fdsToThree` 内含 **y 分量带符号翻转**（Three Z = −FDS y）。
 * 若先在 FDS 空间取好 min/max 再整体映射，映射后的Z 分量顺序会反转，
 * size[2] 变成**负数** —— RoomGeometry 的 `size[2] < 1e-6` 会跳过每一个实体，
 * 三维场景完全空白（2026-10 实测：房间 size 得到 [15, 6.5, **-19.5**]）。
 *
 * 因此：**必须逐角点映射后再按分量重新归一化**，不能只映射两个角点。
 */
export function fdsXbToThreeAabb(
  xb: number[],
): { min: ThreeVec3; max: ThreeVec3; center: ThreeVec3; size: ThreeVec3 } {
  // 8 个角点全部映射后逐分量取 min/max —— 对任意符号翻转组合都成立
  let min: ThreeVec3 = [Infinity, Infinity, Infinity];
  let max: ThreeVec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [Math.min(xb[0], xb[1]), Math.max(xb[0], xb[1])]) {
    for (const y of [Math.min(xb[2], xb[3]), Math.max(xb[2], xb[3])]) {
      for (const z of [Math.min(xb[4], xb[5]), Math.max(xb[4], xb[5])]) {
        const p = fdsToThree(x, y, z);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
  }
  // 吸收浮点误差可能引入的 -0 / 极小负零，保证 size 分量恒为非负
  const size: ThreeVec3 = [
    Math.abs(max[0] - min[0]),
    Math.abs(max[1] - min[1]),
    Math.abs(max[2] - min[2]),
  ];
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size,
  };
}

/** 计算域中心的 Three 坐标（用于相机初始聚焦） */
export function bboxCenterThree(bbox: number[]): ThreeVec3 {
  const cx = (bbox[0] + bbox[1]) / 2;
  const cy = (bbox[2] + bbox[3]) / 2;
  const cz = (bbox[4] + bbox[5]) / 2;
  return fdsToThree(cx, cy, cz);
}

/** 计算域对角线长度（用于相机初始距离） */
export function bboxDiagonal(bbox: number[]): number {
  const dx = Math.abs(bbox[1] - bbox[0]);
  const dy = Math.abs(bbox[3] - bbox[2]);
  const dz = Math.abs(bbox[5] - bbox[4]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 格式化 FDS 仿真时间为 mm:ss */
export function formatSimTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * 8bit 量化字节 -> 摄氏度。
 *
 * ⚠️ `scaleC` 有两种语义（见 types/domain.ts 的 QuantScaleMode 契约）：
 *  - `'SPAN'`   （其余 15 工况，convert_fds_outputs.py）：`T = baseC + (byte/255)×scaleC`
 *  - `'PER_LSB'`（HV-01-140MW，convert_v2_140mw.py / convert_s3d.py）：`T = baseC + byte×scaleC`
 *
 * 缺省按 `SPAN` 处理以保持既有调用点行为不变，但**渲染路径必须显式传 mode**
 * （用 `quantSpecFromSlice(meta)` 判别），否则 140MW 的千度量级会被画成室温。
 */
export function dequantizeTemp(
  q: number,
  baseC: number,
  scaleC: number,
  mode: QuantScaleMode = 'SPAN',
): number {
  return mode === 'PER_LSB' ? baseC + q * scaleC : baseC + (q / 255) * scaleC;
}

/** 量化参数（含语义），一切解码入口都必须走这个结构 */
export interface QuantSpec {
  baseC: number;
  scaleC: number;
  bits: number;
  mode: QuantScaleMode;
}

/** 量化语义只接受资产显式声明；缺失或非法时拒绝解码。 */
export function resolveScaleMode(
  q: { scaleC: number; scaleMode?: QuantScaleMode } | undefined | null,
): QuantScaleMode {
  if (q?.scaleMode === 'SPAN' || q?.scaleMode === 'PER_LSB') return q.scaleMode;
  throw new Error('切片资产缺少或无效 manifest.scaleMode 字段，拒绝猜测量化语义');
}

export function quantSpecFromSlice(meta: SliceMeta): QuantSpec {
  const q = meta.quantization;
  const mode = resolveScaleMode(q);
  if (!Number.isFinite(q.baseC) || !Number.isFinite(q.scaleC) || q.scaleC <= 0 || q.bits !== 8) {
    throw new Error(`切片量化参数无效：${meta.asset}`);
  }
  return { baseC: q.baseC, scaleC: q.scaleC, bits: q.bits, mode };
}

/** 状态栏、图例、说明抽屉共用当前切片的真实量化描述。 */
export function describeQuantization(meta: SliceMeta) {
  const spec = quantSpecFromSlice(meta);
  const domain = sliceQuantDomain(meta);
  const stepC = dequantizeTemp(1, spec.baseC, spec.scaleC, spec.mode) - spec.baseC;
  return {
    ...domain, stepC, mode: spec.mode, note: quantNote(spec), frameCount: meta.frameCount,
    formula: spec.mode === 'SPAN'
      ? `T = ${spec.baseC} + (byte / 255) × ${spec.scaleC} ℃`
      : `T = ${spec.baseC} + byte × ${spec.scaleC.toFixed(4)} ℃`,
    clipping: `低端${meta.dataMinC < domain.minC ? '存在截断' : '未见截断证据'}；高端${meta.dataMaxC > domain.maxC ? '存在饱和截断' : '未见饱和证据'}`,
  };
}

/** 残差自检的诊断结论 */
export interface ScaleAudit {
  /** 判出的语义 */
  mode: QuantScaleMode;
  /** 该切片 byte=255 的解码值（℃），即量化域上限 */
  decodeCeilC: number;
  /** 该切片实际最大 byte 按判出的语义解码出的温度（℃） */
  decodedMaxC: number;
  /** manifest 声明的最高温（℃） */
  declaredMaxC: number;
  /** 残差 |decodedMaxC − declaredMaxC|（℃） */
  residualC: number;
  /** 本切片是否出现过 byte=255（饱和） */
  saturated: boolean;
  /** 是否发现不一致（调用方负责 warn） */
  suspect: boolean;
  /** 人可读的原因 */
  reason: string;
}

/**
 * 残差自检：**运行时诊断**，不参与 `resolveScaleMode` 的判别。
 *
 * ⚠️ 本函数**不会修改任何数据**，只报告「声明与解码不自洽」，供控制台 warn。
 *
 * 比较对象是 **`dequantize(byteMax)` 与 `dataMaxC`**，不是 `dequantize(255)`：
 * `dataMaxC` 是该切片的真实最高温，未饱和时它对应的是最大那个 byte，
 * 而非 byte=255 的域上限（拿域上限去比会得到几百℃ 的假残差）。
 *
 * 判别力分两种情况：
 *  - **未饱和**（byteMax < 255）：残差应 < ~1 个量化步长。实测 15 个 SPAN 工况
 *    的残差为 0.2~1.6 ℃；显著偏大才说明量级/语义错配。
 *  - **已饱和**（byteMax == 255）：`dataMaxC` **合法地高于**解码上限
 *    （LV-05 实测 953.36 ℃ > 上限 800 ℃），此时残差大是正常截断，**不能报错**。
 *    但若 `dataMaxC` **明显低于**上限（真实最高温远未触顶却被写满 255），
 *    则是编码器标度用错的特征 —— 实测仅 HV-01-140MW 的 49 个切片命中。
 */
export function auditSliceScale(meta: SliceMeta, byteMax: number): ScaleAudit {
  const spec = quantSpecFromSlice(meta);
  const decodeCeilC = dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode);
  const decodedMaxC = dequantizeTemp(byteMax, spec.baseC, spec.scaleC, spec.mode);
  const declaredMaxC = meta.dataMaxC;
  const saturated = byteMax >= 255;
  // 容差取 1.5 个量化步长（SPAN 3.06 → 4.6 ℃；PER_LSB 7.84 → 11.8 ℃）。
  // 实测 15 个 SPAN 工况的残差均< 1.6 ℃，留足余量又不掩盖真实错配。
  const step = dequantizeTemp(1, spec.baseC, spec.scaleC, spec.mode) - spec.baseC;
  const tol = Math.max(3, step * 1.5);
  const residualC = Math.abs(decodedMaxC - declaredMaxC);

  let suspect = false;
  let reason = '';
  if (!saturated && residualC > tol) {
    suspect = true;
    reason =
      `未饱和切片（byteMax=${byteMax}）解出的最高温 ${decodedMaxC.toFixed(2)}℃ 与 ` +
      `manifest 声明 dataMaxC=${declaredMaxC.toFixed(2)}℃ 相差 ${residualC.toFixed(1)}℃` +
      `（容差 ${tol.toFixed(1)}℃），量级或语义可能错配`;
  } else if (saturated && declaredMaxC < decodeCeilC - tol) {
    suspect = true;
    reason =
      `切片 byte 已饱和（byteMax=255，解码上限 ${decodeCeilC.toFixed(1)}℃）但 manifest ` +
      `声明 dataMaxC=${declaredMaxC.toFixed(2)}℃，远低于上限 —— ` +
      `真实最高温未触顶却被写满，疑似编码器标度用错`;
  } else if (saturated) {
    reason = `byte 饱和（byteMax=255），声明最高温 ${declaredMaxC.toFixed(2)}℃ 不低于解码上限 ${decodeCeilC.toFixed(1)}℃，属正常截断`;
  } else {
    reason = `解出的最高温 ${decodedMaxC.toFixed(2)}℃ 与声明 dataMaxC=${declaredMaxC.toFixed(2)}℃ 自洽（残差 ${residualC.toFixed(2)}℃）`;
  }

  return {
    mode: spec.mode,
    decodeCeilC,
    decodedMaxC,
    declaredMaxC,
    residualC,
    saturated,
    suspect,
    reason,
  };
}

/**
 * 残差自检并对可疑切片 `console.warn`（不静默、不修改数据）。
 *
 * 建议在开发/验收环境对每个切片调用一次；生产环境可按需关闭 warn。
 * 实测：对 667 个真实切片，仅 HV-01-140MW 的 49 个切片报警，其余 618 个零误报。
 */
export function warnOnScaleMismatch(meta: SliceMeta, byteMax: number): ScaleAudit {
  const audit = auditSliceScale(meta, byteMax);
  if (audit.suspect) {
    console.warn(
      `[scaleMode 残差自检] ${meta.asset}：判为 ${audit.mode}，` +
        `scaleC=${meta.quantization.scaleC}。${audit.reason}`,
    );
  }
  return audit;
}

/**
 * 切片量化域（**必须从 manifest 逐切片读取，不得硬编码**）。
 *
 * 15 个工况：base=20, scale=780, SPAN → 域 20–800 ℃
 * HV-01-140MW：base=20, scale=2000/255≈7.8431, PER_LSB → 域 20–2020 ℃
 *
 * ⚠️ 对 140MW 硬用 800 ℃ 上限会把实测 1133 ℃ 静默截断成同一色（伪造数据）。
 */
export function sliceQuantDomain(meta: SliceMeta): { minC: number; maxC: number } {
  const spec = quantSpecFromSlice(meta);
  return {
    minC: spec.baseC,
    maxC: dequantizeTemp(255, spec.baseC, spec.scaleC, spec.mode),
  };
}

/**
 * 【默认量化参数 —— 仅在资产元数据缺失时兜底，渲染路径禁止直接使用】
 *
 * 对应 `convert_fds_outputs.py` 的 SPAN 语义（域20–800 ℃）。
 * ⚠️ 例外：HV-01-140MW 由 V2 转换器产出，scaleC 是**每 LSB 增量** 7.8431
 *    （域 20–2020 ℃），语义见 types/domain.ts 的QuantScaleMode。
 *    任何渲染/解码都必须走 `quantSpecFromSlice()`，不得引用本常量。
 */
export const SLICE_QUANT_DEFAULT = { baseC: 20.0, scaleC: 780.0, bits: 8 } as const;

/**
 * @deprecated 仅供「资产元数据缺失」的兜底路径与文档说明使用。
 * 语义等价于 { baseC: 20, scaleC: 780, bits: 8 }（SPAN）。
 * 渲染路径请用 `quantSpecFromSlice(sliceMeta)`。
 */
export const SLICE_QUANT = SLICE_QUANT_DEFAULT;

/**
 * 温度色标：「余烬 Inferno · 白底适配版」（DESIGN_SYSTEM.md §3.2，v1.2）
 *
 * 12 锚点，已实测校验：
 *  - 感知均匀：L* = -83.76·u + 96.05 线性拟合，**最大残差仅 1.03 L***（≈1 个 JND）
 *  - 明度严格单调递减：95.97 → 12.60
 *  - 色盲友好：deuteranopia / protanopia / tritanopia 三种模拟下 L* 全程单调
 *  - 20℃ 与背景 #F5F3EE 的 Oklab ΔE = 0.007，且 alpha = 0 → 常温工况完全不着色
 *
 * 定义域固定 20–950℃，**绝不逐帧归一化**（否则跨工况颜色含义漂移，丧失可比性）。
 * 切片另有一套域，见 SLICE_MAX_C。
 */
export const TEMP_MIN_C = 20;
export const TEMP_MAX_C = 950;

/**
 * 切片色标域的**默认值**（DESIGN_SYSTEM §3.2b）。
 *
 * ⚠️ 这是 15 个工况（convert_fds_outputs.py，SPAN 语义 base=20 scale=780）的域，
 * **不是全局值**。HV-01-140MW 的域是 20–2020 ℃（PER_LSB，scale=2000/255）。
 * 渲染与图例必须用 `sliceQuantDomain(sliceMeta)` 动态取当前切片的真实域，
 * 这里的常量只作为无资产元数据时的兜底与文档锚点。
 * 实测原始区间：15 工况 −1.97~953.36 ℃（两端都截断，618 切片中 500 个含 <20 ℃ 数据）；
 * 140MW 最高实测 1133.24 ℃（若按 800 ℃ 上限渲染会被静默截断）。
 */
export const SLICE_MIN_C = 20;
export const SLICE_MAX_C = 800;
export const SLICE_QUANT_STEP_C = 780 / 255; // 3.0588 —— 仅 SPAN 工况成立
export const SLICE_CMAP_NOTE = '8bit 量化 · 步长 3.06 ℃';

/**
 * 给定量化参数生成量化说明文案（动态，不硬编码步长）。
 * SPAN 工况 → "8bit 量化 · 步长 3.06 ℃"；PER_LSB 工况 → 实际步长。
 */
export function quantNote(spec: QuantSpec): string {
  const step = dequantizeTemp(1, spec.baseC, spec.scaleC, spec.mode) - spec.baseC;
  const decimals = step < 1 ? 3 : 2;
  return `8bit 量化 · 步长 ${step.toFixed(decimals)} ℃`;
}

const TEMP_STOPS: Array<[number, [number, number, number]]> = [
  [20, [0xf8, 0xf3, 0xe9]],
  [60, [0xf5, 0xe9, 0xcf]],
  [120, [0xef, 0xd9, 0xa0]],
  [200, [0xe8, 0xc0, 0x70]],
  [300, [0xe0, 0xa2, 0x4c]],
  [400, [0xd6, 0x7f, 0x3c]],
  [500, [0xcc, 0x5e, 0x36]],
  [600, [0xb7, 0x3d, 0x3f]],
  [700, [0x8c, 0x2c, 0x4c]],
  [800, [0x65, 0x25, 0x57]],
  [900, [0x3b, 0x1c, 0x4c]],
  [950, [0x2d, 0x15, 0x43]],
];

/**
 * 各锚点显示不透明度（20℃ alpha=0，与背景同色 → 完全不可见）
 * 数值对应 DESIGN_SYSTEM §3.2 的 alpha 列。
 */
const TEMP_ALPHA: Array<[number, number]> = [
  [20, 0.0],
  [60, 0.06],
  [120, 0.18],
  [200, 0.32],
  [300, 0.52],
  [400, 0.7],
  [500, 0.84],
  [600, 0.92],
  [700, 0.97],
  [800, 1.0],
  [900, 1.0],
  [950, 1.0],
];

/* --------------------- GPU 侧色标（体渲染与切片共用同一套） ---------------------
 * 体渲染（sampler3D）在 fragment shader 里求色，必须把CPU 侧的 12 锚点
 * 原样送进 GPU，否则体数据与切片**视觉不可比**（违反 DESIGN_SYSTEM §3.2）。
 * 锚点数量变化时，下面两个常量会自动同步（均由 TEMP_STOPS/TEMP_ALPHA 派生）。
 */

/** 锚点温度，升序 —— 对应 GLSL uniform float uTempStops[N] */
export const TEMP_STOPS_C = TEMP_STOPS.map(([t]) => t);
/** 锚点 RGB，0–255 —— 对应 GLSL uniform vec3 uStopColors[N] */
export const TEMP_STOP_RGB = TEMP_STOPS.map(([, c]) => c);
/** 锚点 alpha —— 对应 GLSL uniform float uStopAlphas[N] */
export const TEMP_STOP_A = TEMP_ALPHA.map(([, a]) => a);
/** 锚点数量（GLSL 数组长度必须编译期常量） */
export const TEMP_STOP_COUNT = TEMP_STOPS.length;

/**
 * 高对比热图（DESIGN_SYSTEM §3.2b，可切换，默认关闭）
 * 7 锚点，刻意牺牲感知均匀性（残差 8.14）换取更大可分辨步长（8.12 vs 3.31）。
 * ⚠️ **两种模式的颜色不可跨模式比较**（同一温度在两版中颜色不同）。
 * 适用：投影演示 / 远距离看屏 / 轻度色觉障碍。
 */
const TEMP_STOPS_HC: Array<[number, [number, number, number]]> = [
  [20, [0xfd, 0xf0, 0xd0]],
  [120, [0xf5, 0xc2, 0x3c]],
  [250, [0xe8, 0x70, 0x1a]],
  [380, [0xcc, 0x1d, 0x3a]],
  [520, [0x64, 0x18, 0x3e]],
  [660, [0x3b, 0x10, 0x3b]],
  [800, [0x1e, 0x04, 0x30]],
];

const TEMP_STOPS_A: Array<[number,[number,number,number]]>=[[20,[20,70,220]],[80,[20,190,60]],[200,[255,240,0]],[500,[255,70,0]],[1200,[160,0,0]]];
const TEMP_STOPS_B: Array<[number,[number,number,number]]>=[[20,[10,20,100]],[50,[0,210,235]],[100,[0,210,90]],[200,[255,245,0]],[350,[255,140,0]],[600,[250,30,20]],[1200,[200,0,150]]];
const TEMP_STOPS_SMV: Array<[number,[number,number,number]]>=[[20,[0,50,210]],[45,[0,170,255]],[80,[0,225,135]],[160,[230,250,0]],[300,[255,160,0]],[500,[255,45,0]],[800,[220,0,20]],[1200,[160,0,110]]];
export type ColorMapMode = 'DEFAULT' | 'HIGH_CONTRAST' | 'RAINBOW_A' | 'RAINBOW_B' | 'SMOKEVIEW' | 'BLUE_RED' | 'THERMAL';
// Keep the official source table intact; replace only its upper 20% with a red cap.
// This is a display adaptation of thermal, not the unmodified official palette.
export const THERMAL_STOPS: Array<[number,[number,number,number]]> = THERMAL_RGB.map((rgb,i)=>{
 const blend=Math.max(0,(i/255-.8)/.2);
 const red=[235,24,20];
 return [THERMAL_MIN_C+i*(THERMAL_MAX_C-THERMAL_MIN_C)/255,rgb.map((v,c)=>Math.round(v*255*(1-blend)+red[c]*blend)) as [number,number,number]];
});
export const BLUE_RED_STOPS: Array<[number,[number,number,number]]>=[[20,[10,56,219]],[60,[10,56,219]],[300,[62,49,217]],[600,[132,43,193]],[900,[202,31,106]],[1200,[235,15,20]]];
function colorStops(mode:ColorMapMode){return mode==='THERMAL'?THERMAL_STOPS:mode==='BLUE_RED'?BLUE_RED_STOPS:mode==='RAINBOW_A'?TEMP_STOPS_A:mode==='RAINBOW_B'?TEMP_STOPS_B:mode==='SMOKEVIEW'?TEMP_STOPS_SMV:mode==='HIGH_CONTRAST'?TEMP_STOPS_HC:TEMP_STOPS;}


/**
 * 「无切片数据」的中性灰（DESIGN_SYSTEM §3.2c）
 * ⚠️ 未覆盖区域绝不能渲染成低温色（会被误读为「这里温度低」）。
 * 该灰不含任何暖色相，且**不参与色标图例**（不是第 0 档温度）。
 */
export const NO_DATA_COLOR: [number, number, number] = [0xf1, 0xef, 0xea];
/** 与 NO_DATA 区分：无数据 = 没有值（灰），20℃ = 有数据的极低值（色带左端）。二者永不混淆。 */
export const NO_DATA_LABEL = '无切片数据';

function lerpStops(
  c: number,
  stops: Array<[number, [number, number, number]]>,
): [number, number, number] {
  if (c <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (c >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (c >= t0 && c <= t1) {
      const f = (c - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return last[1];
}

/** 标量插值（非颜色），用于 alpha 这类单通道量 */
function lerpScalar(c: number, stops: Array<[number, number]>): number {
  if (c <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (c >= last[0]) return last[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, v0] = stops[i];
    const [t1, v1] = stops[i + 1];
    if (c >= t0 && c <= t1) {
      const f = (c - t0) / (t1 - t0);
      return v0 + (v1 - v0) * f;
    }
  }
  return last[1];
}

/** 温度 -> RGB（0–255）。超域钳制到端点色，不做逐帧归一化。 */
export function temperatureToColor(
  c: number,
  mode: ColorMapMode = 'DEFAULT',
): [number, number, number] {
  if (Number.isNaN(c)) return NO_DATA_COLOR;
  return lerpStops(c, colorStops(mode));
}

/** 温度 -> 显示不透明度（0..1）。20℃ 恒为 0 → 常温工况不着色。 */
export function temperatureToAlpha(c: number): number {
  if (Number.isNaN(c)) return 1;
  return lerpScalar(c, TEMP_ALPHA);
}

export function temperatureToCss(c: number, alpha = 1, mode: ColorMapMode = 'DEFAULT'): string {
  const [r, g, b] = temperatureToColor(c, mode);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 图例用的 CSS linear-gradient 字符串。
 * @param min 域下限（切片用 800，标量/通用用 950）
 * @param max 域上限
 * @param mode 色标模式
 */
export function temperatureGradientCss(
  direction = 'to right',
  mode: ColorMapMode = 'DEFAULT',
  min = TEMP_MIN_C,
  max = TEMP_MAX_C,
): string {
  const stops = colorStops(mode);
  // 固定温度颜色；色带刻度按真实域定位。950℃以上为末端颜色平台。
  // 不能将20–950℃色带拉伸至2020℃，否则图例与纹理同温不同色。
  const lo = min;
  const hi = max > min ? max : min + 1;
  const pts: Array<[number, [number, number, number]]> = [
    [lo, lerpStops(lo, stops)],
    ...stops.filter(([t]) => t > lo && t < hi),
    [hi, lerpStops(hi, stops)],
  ];
  return `linear-gradient(${direction}, ${pts
    .map(
      ([t, [r, g, b]]) =>
        `rgb(${r},${g},${b}) ${((t - lo) / (hi - lo)) * 100}%`,
    )
    .join(', ')})`;
}

/** 当前模式下色标的锚点（供图例渲染刻度） */
export function colormapTicks(
  mode: ColorMapMode = 'DEFAULT',
): Array<{ c: number; css: string }> {
  const stops = colorStops(mode);
  return stops.map(([c, [r, g, b]]) => ({ c, css: `rgb(${r},${g},${b})` }));
}

/**
 * 在给定域内取若干个刻度值（图例用）。
 * 域上限可能是 800（15 工况）或 2020（140MW），故不能复用固定锚点表。
 */
export function domainTicks(min: number, max: number, count = 5): number[] {
  if (max <= min) return [min];
  return Array.from({ length: count }, (_, i) => min + ((max - min) * i) / (count - 1));
}

/** 温度 -> 状态分类（阈值可配置，不代表物理着火判据） */
export function classifyTemperature(
  c: number | null,
  warningC: number,
  alarmC: number,
): 'NORMAL' | 'TEMPERATURE_WARNING' | 'FIRE_ALARM' | 'UNKNOWN' {
  if (c === null || Number.isNaN(c)) return 'UNKNOWN';
  if (c >= alarmC) return 'FIRE_ALARM';
  if (c >= warningC) return 'TEMPERATURE_WARNING';
  return 'NORMAL';
}

export function describeSliceSet(slices: SliceMeta[]) {
  if (!slices.length) return null;
  const first = describeQuantization(slices[0]);
  const bottom = slices.some(sl => sl.dataMinC < sliceQuantDomain(sl).minC);
  const top = slices.some(sl => sl.dataMaxC > sliceQuantDomain(sl).maxC);
  return {...first, clipping: `低端${bottom ? '存在截断' : '未见截断证据'}；高端${top ? '存在饱和截断' : '未见饱和证据'}`};
}

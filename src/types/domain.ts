/**
 * 领域类型定义 —— 严格对齐 docs/04_数据契约与转换方案.md
 *
 * 真实性原则（docs/04 §9）：
 *   所有温度数值必须携带 ValueSource 与 quality，禁止无来源的裸数值。
 *   ValueSource=DEMO 的人工演示值与 FDS 模拟结果严格分离。
 */

export type VoltageZone = 'HIGH' | 'LOW';

/** 工况数据的可用性。绝不返回任意温度；缺失时返回结构化状态。 */
export type Availability =
  | 'READY'
  | 'MISSING_OUTPUT'
  | 'INVALID_SOURCE'
  | 'INVALID_OUTPUT'
  | 'CONVERSION_ERROR'
  | 'LOADING';

/** 温度数值来源。UI 必须据此显示标签。 */
export type ValueSource =
  | 'FDS_DEVC'        // 来自真实 FDS *_devc.csv 热电偶输出
  | 'FDS_SLICE'       // 由真实 FDS 温度切片派生
  | 'LIVE_SENSOR'     // 真实传感器（本版本未接入）
  | 'MANUAL_DEMO'     // 人工演示值，界面显著标注
  | 'UNAVAILABLE';    // 无数据

export type DataQuality = 'SIMULATED' | 'OBSERVED' | 'DEMO' | 'MISSING';

/** 数据真实性标签，直接显示在 UI 上 */
export type TruthLabel =
  | 'FDS SIMULATED'
  | 'SENSOR'
  | 'DEMO'
  | 'UNAVAILABLE'
  | 'FDS INPUT ONLY';

export interface Cabinet {
  id: string;
  zone: VoltageZone;
  /** FDS 火源面中心（VENT SURF_ID='burner' 的 XB 几何中心），单位 m */
  burnerCenterFdsM: [number, number, number];
  burnerXbFdsM: number[];
  sourceChid: string;
  /** 柜体外壳尚未语义核验，不能把火源面当柜体尺寸 */
  envelopeVerified: boolean;
  envelopeStatus: string;
  sensorMappingStatus: string;
  sensorCount: number | null;
}

export interface Scenario {
  sceneMode?: 'windowed'|'windowless';
  openingAtS?: number;
  boundaryVariant?: number;
  id: string;
  zone: VoltageZone;
  cabinetId: string;
  /** 仅高压有固定功率档位（MW）；低压为 null */
  powerOptionMW: number | null;
  nominalPeakHRRKW: number;
  inputFile: string;
  chid: string;
  tEndS: number;
  availability: Availability;
  blockedReason: string | null;
  outputFound: {
    devc: boolean;
    smv: boolean;
    hrr: boolean;
    fdsCompletedSuccessfully: boolean;
    caseDir: string | null;
  };
}

export interface ScalarSample {
  timeS: number;
  valueC: number | null;
  source: ValueSource;
  quality: DataQuality;
}

/**
 * 柜体标量温度时序（来自真实 FDS DEVC 输出）
 *
 * ⚠ 语义边界（2026-10 实测核验，勿轻易改回旧名）：
 * 该序列**不是**「柜体温度」，而是「起火柜 burner 区域热电偶的逐点最大值」。
 * 实测依据：LV-01 的 105 支热电偶全部落在
 * x∈[10.15,10.85]、y=−13.65、z∈[0.26,2.26] 的 0.7m×0m×2m 竖直柱体内，
 * 与 burner（x=10.52）同侧。**其它柜体未布设热电偶，温度未接入。**
 * 故字段名用 fireSourceMaxC 而非 cabinetMaxC，避免 UI 误显示为「柜体温度」。
 */
export interface ScenarioSeries {
  timesS: number[];
  /** 起火柜 burner 区域热电偶的逐点最大值（℃）。null = 该时刻无有效读数 */
  fireSourceMaxC: (number | null)[];
  sensorCount: number;
  /** 恒为 MAX_OVER_THERMOCOUPLE_IN_FIRE_SOURCE_REGION */
  aggregation: string;
  /** 热电偶布设包络（FDS XB: [x1,x2,y1,y2,z1,z2]），证明测点位置范围 */
  sensorEnvelopeFdsM: number[] | null;
  /** 面向用户的中文测点范围说明，必须在温度展示处同屏呈现 */
  sensorScopeNote: string;
  /** 空间分布峰值（取前若干支热电偶），仅作辅助参考 */
  spatialMax: Array<{ id: string; maxC: number; finalC: number | null }>;
}

/** HRR 序列（来自真实 FDS *_hrr.csv，FULL_RESOLUTION 不抽稀） */
export interface HrrSeries {
  timesS: number[];
  hrrKW: number[];
  peakKW: number;
  /** 峰值发生时刻（s）——用于在卡片上标注峰值位置 */
  peakTimeS: number;
  sourceFile: string;
  sampling: string;
  frameCount: number;
}

/**
 * HRR「标称设定 vs 输出峰值」三量关系。
 *
 * ① nominalPeakHRRKW  = HRRPUA × 火源面面积，输入参数上限
 * ② measuredPeakHRRKW = *_hrr.csv HRR 通道最大值，FDS 计算结果
 * ③ 与 ② 同源的 UI 展示值（当前实现下 ③ === ②）
 *
 * UI 只允许并列陈述①与②并给出来源徽章，**禁止任何方向的因果解释**
 * （既不得称②为「模型缺陷」，也不得为②背书称「通风受限/模型可信」）。
 * 成因核查未完成，见 TODO_FDS_HRR.md。
 */
export interface HrrInterpretation {
  nominalPeakHRRKW: number | null;
  measuredPeakHRRKW: number;
  measuredPeakTimeS: number;
  note: string;
}

/**
 * 8bit 量化参数的 **`scaleC` 语义**（2026-10-08 实测发现，两个转换器不一致）。
 *
 * 背景：16 个工况的资产由**两个不同的转换器**产出，`quantization.scaleC`
 * 字段名相同但含义相反：
 *
 * | 转换器 | 工况 | scaleC | 语义 | 解码公式 | byte=255 |
 * |---|---|---|---|---|---|
 * | `convert_fds_outputs.py` | 其余 15 个 | `780.0` | **SPAN**（整个量程跨度） | `T = baseC + (byte/255)×scaleC` | 800 ℃ |
 * | `convert_v2_140mw.py` / `convert_s3d.py` | HV-01-140MW | `7.8431` (=2000/255) | **PER_LSB**（每 LSB 增量） | `T = baseC + byte×scaleC` | 2020 ℃ |
 *
 * 若对 140MW 误用 SPAN 公式，byte=136（实测 1083.69 ℃）会被解成
 * `20 + 136/255×7.84 = 24.2 ℃` —— 这不是截断，而是**把火场画成室温**，属于伪造数据。
 *
 * ✅ **两个转换器现均已在 manifest 写出显式 `scaleMode` 字段**
 * （`convert_fds_outputs.py` → `"SPAN"`，`convert_v2_140mw.py` → `"PER_LSB"`），
 * 顶层与逐切片 `quantization` 均带该字段。
 * `resolveScaleMode()` 的**第①级判据**即此显式字段，不再依赖数值启发式。
 *
 * ⚠️ 为什么显式字段是**必需**而非锦上添花（2026-10-08 P0 教训）：
 * 曾以「矛盾组合探测」（byte=255 但 dataMaxC<800 → 标度用错）作为主判据，
 * 它在 `convert_v2_140mw.py` 的 `quantize()` 多乘 255（49 片全部饱和为 255）时
 * 判对 16/16；**该缺陷修复后饱和字节归零，矛盾片数 28 → 0，探测对 140MW 完全失效**
 * （会误判为 SPAN）。一次成功的修复就让判据失效，这正是它不能作主判据的原因。
 *
 * ⚠️ 2026-10-08 P0 更正：`gridDims` **不能**用作判别依据。
 * `scripts/fix_slice_dims.py` 已给全部 16 个工况的每个切片补写 `gridDims`，
 * 「有 gridDims 即 PER_LSB」对 16/16 全部成立，会把 15 个 SPAN 工况误判为 PER_LSB。
 */
export type QuantScaleMode = 'SPAN' | 'PER_LSB';

export interface Quantization {
  baseC: number;
  scaleC: number;
  bits: number;
  /**
   * `scaleC` 的语义。
   *
   * ✅ 16 个工况的 manifest **均已显式提供**该字段（顶层与逐切片两处都有），
   * 故 `resolveScaleMode()` 走第①级精确路径，不再依赖 `scaleC` 量级启发式。
   *
   * 保留为可选仅为兼容旧资产：缺失时退到第②级矛盾探测、第③级 `scaleC` 量级兜底。
   */
  scaleMode?: QuantScaleMode;
}

/**
 * 短时火源释热剖面（release_profile.json，仅高压工况存在）。
 *
 * ⚠️ 措辞纪律（硬约束）：本文件只含**由 *_hrr.csv 直接算出的数值事实**，
 * 不含任何成因推断或燃烧学解释（文件自带 `dataFactsOnly: true` 与
 * `interpretationPolicy` 字段，UI 必须遵守同一纪律）。
 *
 * 两种衰减时刻口径必须并列陈述，不得混用：
 *  - `lastAboveTimeS`：**口径 A** —— 最后一个 HRR > 峰值×frac 的采样时刻（绝对时刻）
 *  - `downCrossTimeS` —— 从峰值起沿下降沿的首个越阈时刻
 * 恒等式：`downCrossTimeS − 峰值时刻 = 峰后耗时`（口径 B）
 */
export interface ReleaseProfileDecayPoint {
  fractionOfPeak: number;
  thresholdKW: number;
  lastAboveTimeS: number;
  lastAboveSampleIndex: number;
  downCrossTimeS: number;
  reached: boolean;
}

export interface ReleaseProfile {
  scenarioId: string;
  chid: string;
  sampleCount: number;
  timeStartS: number;
  timeEndS: number;
  peakKW: number;
  peakTimeS: number;
  peakSampleIndex: number;
  baselineKW: number;
  lastNonZeroTimeS: number;
  decay: {
    half: ReleaseProfileDecayPoint;
    decay10: ReleaseProfileDecayPoint;
    decay02: ReleaseProfileDecayPoint;
    decay005: ReleaseProfileDecayPoint;
  };
  decayNote?: string;
  integratedHeatReleaseKJ: number;
  integratedHeatReleaseMJ: number;
  integration: {
    method: string;
    leftRectangleKJ: number;
    rightRectangleKJ: number;
    methodSpreadKJ: number;
    approximationNote?: string;
  };
  sampling: {
    uniform: boolean;
    distinctDtCount: number;
    dtMinS: number;
    dtMaxS: number;
    dtMeanS: number;
    dtStdDevS: number;
    dtCoefficientOfVariation: number;
    note?: string;
  };
  dataFactsOnly: boolean;
  interpretationPolicy?: string;
  sourceFile?: string | null;
  samplingPolicy?: string | null;
  manifestPeakKW?: number;
  manifestPeakMatches?: boolean;
}

/**
 * 释热剖面的两个时间阶段（用于时间轴分段标注）。
 *
 * ⚠️ 这是**两套独立来源的事实并列**，不是「设计 vs 实际」的对比结论：
 *  - `RELEASE_COMMAND_WINDOW`：源 FDS 的 DEVC `TIMER->OUT` SETPOINT=1.0 决定的**设计意图窗口**
 *  - `POST_RELEASE_TRANSPORT`：该时刻之后至HRR 衰减到2% 点的**后续时段**
 *
 * 严禁据此推断「与设计不符」「滞后源于输运延迟」等因果结论。
 */
export type ReleasePhaseId = 'RELEASE_COMMAND_WINDOW' | 'POST_RELEASE_TRANSPORT';

export interface ReleasePhase {
  id: ReleasePhaseId;
  label: string;
  /** 阶段起止时刻（s），实测来源 */
  startS: number;
  endS: number;
  /** 依据来源说明（必须写清是设计意图参数还是实测输出） */
  basis: string;
}

/** 源 FDS 中短时火源的释放控制参数（设计意图，非实测） */
export const RELEASE_COMMAND_WINDOW = {
  devcId: "TIMER->OUT",
  setpoint: 1.0,
  /** 该 DEVC 生效的仿真时刻区间（s）—— 设计意图窗口 ≈ 0–1 s */
  startS: 0.0,
  endS: 1.0,
} as const;

/** 单个温度切片的元数据（数据本体在 .bin 中） */
export interface SliceMeta {
  asset: string;
  sourceFile: string;
  plane: 'PBX' | 'PBY' | 'PBZ';
  planeCoordM: number;
  meshIndex: number;
  meshXb: number[];
  ni: number;
  nj: number;
  uAxis: 'X' | 'Y';
  vAxis: 'Y' | 'Z';
  uRangeM: [number, number];
  vRangeM: [number, number];
  frameCount: number;
  frameTimesS: number[];
  units: string;
  dataMinC: number;
  dataMaxC: number;
  quantization: Quantization;
  /**
   * 网格 i/j/k 跨度（区别于面内 ni/nj）。
   *
   * ⚠️ 2026-10-08 更正：原注释称此字段为「V2 转换器独有」，**该说法已失效** ——
   * `fix_slice_dims.py` 为修正垂直切片 ni/nj，给**全部 16 个工况**都写了该字段。
   * 因此**不可**用它判别 `scaleMode`（见 `resolveScaleMode`）。
   */
  gridDims?: { ni: number; nj: number; nk: number };
  /** 真实最高温是否超出 byte=255 上限而被截断（`convert_v2_140mw.py` 写） */
  quantizationClipped?: boolean | null;
}

/**
 * 数据来源与校验状态（manifest.dataProvenance）。
 *
 * 存在的意义：源输入被修正并复算的工况，其资产与「用户本地原始运行」不同，
 * 必须在状态栏显式标注来源与校验结论，不能让两者在界面上无法区分。
 */
export interface DataProvenance {
  origin: 'V2_HANDBOX_RECALC' | 'USER_LOCAL_RUN';
  sourceDirectory?: string | null;
  sourceFdsSha256?: string | null;
  sourceFdsHrrpua?: number | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  fdsCompletedSuccessfully?: boolean;
  /** 源输入修正说明；未修正为 null */
  inputCorrection?: string | null;
  sourceOutSha256?: string | null;
  verificationNote?: string | null;
}

/** 单个体数据（.s3d）的元数据 */
export interface VolumeMeta {
  asset: string;
  sourceFile: string;
  sourceIndexFile?: string;
  sourceFileBytes?: number;
  quantity: string;
  shortLabel: string;
  units: string;
  meshIndex: number;
  meshXb: number[];
  ni: number;
  nj: number;
  nk: number;
  voxelCount: number;
  frameCount: number;
  frameTimesS: number[];
  frameTimeStartS: number;
  frameTimeEndS: number;
  dataMinC: number;
  dataMaxC: number;
  rawByteMin: number;
  rawByteMax: number;
  quantization: Quantization;
  voxelOrder: string;
  maskSolidVoxelCount: number;
  binBytes: number;
}

/** volume/manifest.json —— 仅 HV-01-140MW 存在 */
export interface VolumeManifest {
  scenarioId: string;
  chid: string;
  kind: string;
  dataTruthLabel: TruthLabel;
  format: Record<string, unknown>;
  quantization: Quantization;
  quantizationNote?: string;
  volumeCount: number;
  volumes: VolumeMeta[];
}

export interface ScenarioDataset {
  scaleMode?: QuantScaleMode;
  scenarioId: string;
  status: Availability;
  reason?: string | null;
  dataTruthLabel?: TruthLabel;
  timeRangeS?: [number, number];
  series?: ScenarioSeries;
  hrr?: HrrSeries | null;
  /**
   * manifest.json 中的字段名是 `hrr`（不是 `hrrMeta`）。
   * 若误用 hrrMeta，peakKW 会静默取到 undefined —— UI 峰值卡片将空白且无报错。
   */
  hrrInterpretation?: HrrInterpretation;
  seriesFile?: string | null;
  hrrFile?: string | null;
  sliceCount?: number;
  slices: SliceMeta[];
  sourceFiles: Array<{ path: string; sha256?: string }>;
  units: { time: 's'; temperature: 'C' };
  /** 数据来源与校验状态；供状态栏来源徽章使用（缺失时按未知来源处理） */
  dataProvenance?: DataProvenance | null;
  notes?: string[];
}

/* ------------------------------ 几何 ------------------------------ */

export interface SolidBox {
  disappearAtS?: number|null;
  i: number;
  id: string;
  /** FDS XB: x1,y1... 实为 [x1,x2,y1,y2,z1,z2] */
  xb: number[];
  fam: string;
  role: string;
  conf: string;
  reason: string;
  kind: 'SOLID';
}

export interface SurfaceRect {
  disappearAtS?: number|null;
  i: number;
  id: string;
  xb: number[];
  fam: string;
  role: string;
  conf: string;
  reason: string;
  kind: 'SURFACE';
}

export interface MeshDef {
  id: string;
  xb: number[];
  ijk: number[];
}

export interface SceneMaster {
  sceneMode?: 'windowed'|'windowless';
  scenarioId?: string;
  schemaVersion: string;
  generatedFrom: {
    masterChid: string;
    masterFile: string;
    sourceFiles: string[];
    note: string;
  };
  coordinateSystem: {
    name: string;
    units: string;
    bbox: number[];
    note: string;
  };
  meshes: MeshDef[];
  solids: SolidBox[];
  surfaces: SurfaceRect[];
  holes: Array<{ id: string; xb: number[] }>;
  meshBoundaryVents: Array<{ xb: number[]; id: string }>;
  surfaceDefs: Record<string, Record<string, unknown>>;
  fireSourceVents: Array<{ xb: number[]; center: number[] }>;
  stats: {
    obstTotal: number;
    solidCount: number;
    surfaceCount: number;
    holeCount: number;
    meshBoundaryVentCount: number;
    familyCount: Record<string, number>;
  };
  semanticVerification: {
    status: string;
    reason: string;
    confirmedFacts: string[];
  };
}

/* ------------------------------ 应用状态 ------------------------------ */

export type AppMode = 'MONITOR' | 'FDS_SCENARIO';
export type AlarmState = 'NORMAL' | 'TEMPERATURE_WARNING' | 'FIRE_ALARM';
export type PlaybackState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'ENDED';
export type ZoneFilter = 'ALL' | 'HIGH' | 'LOW';
export type RenderMode = 'ARCHITECTURE' | 'THERMAL_SLICE';

export interface AlarmThresholds {
  /** 仅用于界面演示判据，不代表物理着火温度 */
  warningC: number;
  alarmC: number;
  highZoneWarningC: number;
  highZoneAlarmC: number;
}

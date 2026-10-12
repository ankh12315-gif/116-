/**
 * FDS 工况数据 Provider（docs/04 §4 服务抽象）
 *
 * 设计原则：
 *  1. 所有资产来自 public/assets 下的离线转换结果（真实 FDS 输出）。
 *  2. 任何缺失/无效都返回**结构化错误**，绝不返回编造的温度数值。
 *  3. Provider 内部再次校验工况有效性，不能仅靠 UI 绕过
 *     （黑名单 INVALID_SCENARIO_IDS 或 availability !== READY 均拒绝）。
 *
 * 2026-10-08：HV-01-140MW 的源输入已修正（HRRPUA 5.6E6 → 5.6E5）并完成 V2 复算，
 * 状态由 INVALID_SOURCE 改为 READY，禁用黑名单已清空。
 */

import type {
  Availability,
  Cabinet,
  DataProvenance,
  HrrSeries,
  ReleaseProfile,
  Scenario,
  ScenarioDataset,
  ScenarioSeries,
  SceneMaster,
  SliceMeta,
  TruthLabel,
  VolumeManifest,
} from '../types/domain';

import { quantSpecFromSlice, resolveScaleMode } from '../utils/coords';
import {resultsBase,simulationForMode,scenarioInScene,type SceneMode} from '../config/sceneModes';

const BASE = import.meta.env.BASE_URL || '/';

/**
 * 已确认禁用的工况（黑名单）。
 *
 * ⚠️ 2026-10-08：原含 `HV-01-140MW`（源 FDS 输入 HRRPUA=5.6E6 kW/m² × 0.25 m²
 * = 1400 MW，与标称 140 MW 不符）。该源输入**已修正为 5.6E5 并完成复算**，
 * 新资产已接入（`results/HV-01-140MW/`，manifest.status = READY，
 * dataProvenance.origin = V2_HANDBOX_RECALC），故此处**必须为空集**。
 *
 * 保留本常量而非删除：它仍是「Provider 层最后一道防线」的挂载点——
 * 未来若再有工况被判定不可用，只需把 id 加进来，不必重构拦截逻辑。
 */
export const INVALID_SCENARIO_IDS = new Set<string>();

export class ScenarioAccessError extends Error {
  readonly scenarioId: string;
  readonly availability: Availability;
  constructor(scenarioId: string, availability: Availability, message: string) {
    super(message);
    this.name = 'ScenarioAccessError';
    this.scenarioId = scenarioId;
    this.availability = availability;
  }
}

async function fetchJson<T>(path: string,signal?:AbortSignal): Promise<T> {
  const url = `${BASE}${path}`.replace(/([^:]\/)\/+/g, '$1');
  const res = await fetch(url,{signal});
  if (!res.ok) {
    throw new Error(`资产加载失败: ${path} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

async function fetchBinary(path: string): Promise<Uint8Array> {
  const url = `${BASE}${path}`.replace(/([^:]\/)\/+/g, '$1');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`资产加载失败: ${path} (HTTP ${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/* --------------------------- 静态资产加载 --------------------------- */

export interface AssetsIndex {
  scenarios: Scenario[];
  cabinets: Cabinet[];
  scene: SceneMaster;
  /**
   * 资产层校正记录（供 UI 披露，不静默）。
   * 每条对应scenarios.json 与 results/{id}/manifest.json 的一处不一致。
   */
  reconciliations: AssetReconciliation[];
}

export interface AssetReconciliation {
  scenarioId: string;
  /** scenarios.json 里写的状态 */
  declaredAvailability: Availability;
  /** results/{id}/manifest.json 里写的状态（校正后的权威事实） */
  manifestStatus: Availability;
  /** 校正依据的 provenance.origin（仅在该字段存在时才允许校正） */
  provenanceOrigin: string;
  inputCorrection: string | null;
  /** 标称峰值的校正（kW）：scenarios.json 的值可能仍是修正前的错误值 */
  nominalPeakHRRKW: { declared: number; fromManifest: number };
}

/**
 * 校正 scenarios.json 中过时的可用性标记。
 *
 * ⚠️ 背景（2026-10-08 实测发现的真实资产矛盾）：
 *  - `public/assets/scenarios/scenarios.json` 中 HV-01-140MW 仍是
 *    `availability = INVALID_SOURCE`、`nominalPeakHRRKW = 1400000`（= 1400 MW，
 *    对应修正前的错误 HRRPUA 5.6E6）。
 *  - 而**转换器实际产出的** `results/HV-01-140MW/manifest.json` 是
 *    `status = READY`、`hrrInterpretation.nominalPeakHRRKW = 140000`（= 140 MW），
 *    `dataProvenance.sourceFdsHrrpua = 560000`（即修正后的 5.6E5）。
 *
 * 数据资产不可修改（改了就把事实改错了），故在校验层以
 * **results/{id}/manifest.json 为权威事实**校正 scenarios.json 的过时标记。
 *
 * 校正只在满足**全部**下列条件时发生，避免放宽任何未经证实的工况：
 *  1. 该工况在 scenarios.json 中不是 READY；
 *  2. `results/{id}/manifest.json` 存在且 `status === 'READY'`；
 *  3. 该 manifest 带 `dataProvenance`，且 `origin === 'V2_HANDBOX_RECALC'`
 *     或 `inputCorrection` 非空（即确有一次显式的输入修正与复算）。
 *
 * 不满足条件时保持原状态并照常拒绝 —— 校正不是绕过校验的后门。
 */
async function reconcileAvailability(
  scenarios: Scenario[],
): Promise<{ scenarios: Scenario[]; reconciliations: AssetReconciliation[] }> {
  const out: Scenario[] = [];
  const reconciliations: AssetReconciliation[] = [];

  await Promise.all(
    scenarios.map(async (s, i) => {
      if (s.availability === 'READY') {
        out[i] = s;
        return;
      }
      let manifest: ScenarioDataset | null = null;
      try {
        manifest = await fetchJson<ScenarioDataset>(`assets/results/${s.id}/manifest.json`);
      } catch {
        out[i] = s; // 无结果清单 → 维持原判定
        return;
      }
      const fixed = reconcileOne(s, manifest);
      if (!fixed) {
        out[i] = s;
        return;
      }
      reconciliations.push(fixed.reconciliation);
      out[i] = fixed.scenario;
    }),
  );

  return { scenarios: out, reconciliations };
}

/**
 * 单个工况的校正判定（纯函数，便于单测）。
 * 返回 null 表示「不校正」——保持 scenarios.json 的原判定并照常拒绝。
 */
export function reconcileOne(
  s: Scenario,
  manifest: ScenarioDataset,
): { scenario: Scenario; reconciliation: AssetReconciliation } | null {
  if (s.availability === 'READY') return null;
  const prov = manifest.dataProvenance ?? null;
  const corrected =
    manifest.status === 'READY' &&
    prov !== null &&
    (prov.origin === 'V2_HANDBOX_RECALC' ||
      (typeof prov.inputCorrection === 'string' && prov.inputCorrection.length > 0));
  if (!corrected) return null;

  const fromManifest = manifest.hrrInterpretation?.nominalPeakHRRKW ?? null;
  return {
    reconciliation: {
      scenarioId: s.id,
      declaredAvailability: s.availability,
      manifestStatus: manifest.status,
      provenanceOrigin: prov.origin,
      inputCorrection: prov.inputCorrection ?? null,
      nominalPeakHRRKW: {
        declared: s.nominalPeakHRRKW,
        fromManifest: fromManifest ?? s.nominalPeakHRRKW,
      },
    },
    scenario: {
      ...s,
      // 标称峰值优先取 manifest 的值：scenarios.json 里的是修正前的 1400 MW
      nominalPeakHRRKW: fromManifest ?? s.nominalPeakHRRKW,
      availability: 'READY',
      blockedReason: null,
    },
  };
}

export async function loadAssets(mode:SceneMode='windowed',signal?:AbortSignal): Promise<AssetsIndex> {
  const cfg=simulationForMode(mode),initialId=scenarioInScene(mode,cfg.defaultCabinetId,cfg.highPowerMW);
  if(mode==='windowless'){
    const [scn,cab,scene]=await Promise.all([fetchJson<{scenarios:Scenario[]}>('assets/scenes/windowless/scenarios.json',signal),fetchJson<{cabinets:Cabinet[]}>('assets/scenes/windowless/cabinets.json',signal),fetchJson<SceneMaster>(`assets/scenes/windowless/geometries/${initialId}.json`,signal)]);
    if(scn.scenarios.some(s=>s.sceneMode!==mode))throw new Error('无窗工况索引来源错误');
    return {scenarios:scn.scenarios,cabinets:cab.cabinets,scene,reconciliations:[]};
  }
  const [scn, cab, scene] = await Promise.all([
    fetchJson<{ scenarios: Scenario[] }>('assets/scenarios/scenarios.json',signal),
    fetchJson<{ cabinets: Cabinet[] }>('assets/scenarios/cabinets.json',signal),
    fetchJson<SceneMaster>(`assets/scenes/windowed/geometries/${initialId}.json`,signal),
  ]);
  const { scenarios, reconciliations } = await reconcileAvailability(scn.scenarios);
  return { scenarios, cabinets: cab.cabinets, scene, reconciliations };
}

/* --------------------------- 工况查询 --------------------------- */

/**
 * 校验工况是否可用于加载结果。
 * 这是**最后一道防线**：即使 UI 绕过，Provider 也必须拒绝无效工况。
 */
export function assertScenarioUsable(
  scenario: Scenario | undefined,
  scenarioId: string,
): Scenario {
  if (!scenario) {
    throw new ScenarioAccessError(
      scenarioId,
      'MISSING_OUTPUT',
      `未找到工况 ${scenarioId}`,
    );
  }
  if (INVALID_SCENARIO_IDS.has(scenario.id) || scenario.availability === 'INVALID_SOURCE') {
    throw new ScenarioAccessError(
      scenario.id,
      'INVALID_SOURCE',
      scenario.blockedReason ??
        `工况 ${scenario.id} 源输入无效，已禁止使用`,
    );
  }
  if (scenario.availability !== 'READY') {
    throw new ScenarioAccessError(
      scenario.id,
      scenario.availability,
      scenario.blockedReason ?? `工况 ${scenario.id} 结果不可用（${scenario.availability}）`,
    );
  }
  return scenario;
}

/**
 * 按"柜体 + 功率档位"解析唯一工况。
 *  - 低压：只有唯一工况，powerOptionMW 必须为 null
 *  - 高压：必须显式提供 40/70/100/140 之一
 *  - 黑名单内的禁用档位必须被拦截
 */
export function resolveScenarioId(
  scenarios: Scenario[],
  cabinetId: string,
  powerOptionMW: number | null,
): Scenario {
  const matches = scenarios.filter((s) => {
    if (s.cabinetId !== cabinetId) return false;
    if (s.zone === 'LOW') return s.powerOptionMW === null;
    return s.powerOptionMW === powerOptionMW;
  });

  if (matches.length === 0) {
    throw new ScenarioAccessError(
      `${cabinetId}${powerOptionMW ? `-${powerOptionMW}MW` : ''}`,
      'MISSING_OUTPUT',
      powerOptionMW === null
        ? `柜体 ${cabinetId} 缺少必须提供的功率档位`
        : `柜体 ${cabinetId} 没有 ${powerOptionMW}MW 工况`,
    );
  }
  return assertScenarioUsable(matches[0], matches[0].id);
}

/* --------------------------- 结果数据集 --------------------------- */

export interface LoadedDataset {
  manifest: ScenarioDataset;
  series: ScenarioSeries | null;
  hrr: HrrSeries | null;
  /** manifest.dataProvenance —— 缺失时为 null（UI 不得编造来源） */
  provenance: DataProvenance | null;
  /** release_profile.json —— 仅高压短时火源工况存在，缺失为 null */
  releaseProfile: ReleaseProfile | null;
  /** 体数据清单 —— 仅 HV-01-140MW 存在，缺失为 null（其余 15 工况优雅降级） */
  volumeManifest: VolumeManifest | null;
}

const datasetCache = new Map<string, Promise<LoadedDataset>>();

/** 可选资产：404/解析失败都返回 null，绝不因辅助数据缺失而让整个工况不可用 */
async function fetchOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await fetchJson<T>(path);
  } catch {
    return null;
  }
}

export function loadScenarioDataset(scenarioId: string,mode:SceneMode='windowed'): Promise<LoadedDataset> {
  const key=`${mode}:${scenarioId}`;const base=resultsBase(mode,scenarioId);
  const cached = datasetCache.get(key);
  if (cached) return cached;

  const task = (async (): Promise<LoadedDataset> => {
    let manifest: ScenarioDataset;
    try {
      manifest = await fetchJson<ScenarioDataset>(`${base}/manifest.json`);
    } catch (e) {
      throw new ScenarioAccessError(
        scenarioId,
        'MISSING_OUTPUT',
        `工况 ${scenarioId} 的结果清单未接入：${(e as Error).message}`,
      );
    }

    if (manifest.status !== 'READY') {
      throw new ScenarioAccessError(
        scenarioId,
        manifest.status,
        manifest.reason ?? `工况 ${scenarioId} 结果不可用（${manifest.status}）`,
      );
    }

    validateDatasetQuantization(manifest, scenarioId);
    if(mode==='windowless'&&(manifest as ScenarioDataset&{sceneMode?:string}).sceneMode!==mode)throw new Error('结果不属于当前无窗场景');

    const [series, hrrRaw, releaseProfile, volumeManifest] = await Promise.all([
      manifest.seriesFile ? fetchJson<ScenarioSeries>(`${base}/series.json`) : null,
      manifest.hrrFile ? fetchJson<{ timesS: number[]; hrrKW: number[] }>(`${base}/hrr.json`) : null,
      // 高压短时火源工况才有释热剖面；LV 工况与部分 HV 工况为 null
      scenarioId.startsWith('HV-') ? fetchOptionalJson<ReleaseProfile>(`${base}/release_profile.json`) : null,
      // 体数据目前只有 HV-01-140MW 接入，其余 15 工况返回 null → UI 显示「该工况未接入体数据」
      scenarioId === 'HV-01-140MW' ? fetchOptionalJson<VolumeManifest>(`${base}/volume/manifest.json`) : null,
    ]);

    if (volumeManifest) {
      resolveScaleMode(volumeManifest.quantization);
      for (const v of volumeManifest.volumes) resolveScaleMode(v.quantization);
    }
    // manifest.json 里的字段是 `hrr`（不是 `hrrMeta`）。
    // 这里做显式兜底：优先用 manifest 记录的 peakKW，若缺失则从序列重算，
    // 绝不允许 UI 拿到 undefined 峰值。
    const hrrMeta = manifest.hrr ?? null;
    const seqMax = hrrRaw
      ? hrrRaw.hrrKW.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0)
      : 0;
    const hrr: HrrSeries | null = hrrRaw
      ? {
          timesS: hrrRaw.timesS,
          hrrKW: hrrRaw.hrrKW,
          peakKW: hrrMeta?.peakKW ?? Math.abs(seqMax),
          peakTimeS: hrrMeta?.peakTimeS ?? 0,
          sourceFile: hrrMeta?.sourceFile ?? '',
          sampling: hrrMeta?.sampling ?? 'UNKNOWN',
          frameCount: hrrMeta?.frameCount ?? hrrRaw.timesS.length,
        }
      : null;

    return {
      manifest,
      series,
      hrr,
      provenance: manifest.dataProvenance ?? null,
      releaseProfile,
      volumeManifest,
    };
  })();

  datasetCache.set(key, task);
  task.catch(() => { if (datasetCache.get(key) === task) datasetCache.delete(key); });
  return task;
}

/** 切换工况时释放缓存，防止跨工况串温（docs/02 §6） */
export function clearDatasetCache(keep?: string): void {
  for (const key of Array.from(datasetCache.keys())) {
    if (key !== keep&&!key.endsWith(':'+keep)) datasetCache.delete(key);
  }
}

/* --------------------------- 切片数据 --------------------------- */

const sliceCache = new Map<string, Promise<Uint8Array>>();

export function loadSliceData(scenarioId: string, asset: string): Promise<Uint8Array> {
  const key = `${scenarioId}/${asset}`;
  const cached = sliceCache.get(key);
  if (cached) return cached;
  const task = fetchBinary(`assets/results/${scenarioId}/${asset}`);
  sliceCache.set(key, task);
  task.catch(() => { if (sliceCache.get(key) === task) sliceCache.delete(key); });
  return task;
}

export function clearSliceCache(): void {
  sliceCache.clear();
}

/* --------------------------- 体数据（.s3d） --------------------------- */

/**
 * ⚠️ 性能约束：单个体数据 16 MB，5 个 mesh 共约 50 MB。
 * 缓存**只保留当前加载的一个**（`loadVolumeData` 写入前先清空），
 * 绝不一次全load，否则显存与内存都会被无谓占用。
 */
const volumeCache = new Map<string, Promise<Uint8Array>>();

export function loadVolumeData(scenarioId: string, asset: string): Promise<Uint8Array> {
  const key = `${scenarioId}/${asset}`;
  const cached = volumeCache.get(key);
  if (cached) return cached;
  volumeCache.clear(); // 只保留一个
  const task = fetchBinary(`assets/results/${scenarioId}/${asset}`);
  volumeCache.set(key, task);
  // 加载失败时不留下毒化的 rejected promise
  task.catch(() => volumeCache.delete(key));
  return task;
}

export function clearVolumeCache(): void {
  volumeCache.clear();
}

/* --------------------------- 温度查询 --------------------------- */

/**
 * 在**同一工况内**按时间查询柜体标量温度。
 * 允许在相邻真实采样点之间做线性插值以平滑画面（docs/04 §5 允许，
 * 但仅限同工况内，且不得跨功率档位），返回值标注 interpolation。
 */
export interface TempQueryResult {
  valueC: number | null;
  source: 'FDS_DEVC';
  quality: 'SIMULATED';
  truthLabel: TruthLabel;
  interpolation: 'EXACT' | 'LINEAR_WITHIN_SCENARIO' | 'OUT_OF_RANGE' | 'NO_DATA';
  nearestTimeS: number | null;
  /**
   * 测点作用域标注，UI 必须同屏展示。
   * 本项目**不存在逐柜温度**：序列为起火柜 burner 区域热电偶最大值。
   */
  scopeNote: string;
}

export function queryCabinetTemperature(
  series: ScenarioSeries | null,
  timeS: number,
): TempQueryResult {
  const base = {
    source: 'FDS_DEVC' as const,
    quality: 'SIMULATED' as const,
    truthLabel: 'FDS SIMULATED' as TruthLabel,
    scopeNote: series?.sensorScopeNote ?? '未接入温度数据',
  };
  if (!series || series.timesS.length === 0) {
    return { ...base, valueC: null, interpolation: 'NO_DATA', nearestTimeS: null };
  }
  const times = series.timesS;
  const first = times[0];
  const last = times[times.length - 1];
  if (timeS < first || timeS > last) {
    return {
      ...base,
      valueC: null,
      interpolation: 'OUT_OF_RANGE',
      nearestTimeS: timeS <= first ? first : last,
    };
  }
  // 二分查找
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeS) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo];
  const t1 = times[hi];
  const v0 = series.fireSourceMaxC[lo];
  const v1 = series.fireSourceMaxC[hi];
  if (v0 === null || v1 === null || v0 === undefined || v1 === undefined) {
    return { ...base, valueC: v0 ?? null, interpolation: 'NO_DATA', nearestTimeS: t0 };
  }
  if (Math.abs(timeS - t0) < 1e-6) {
    return { ...base, valueC: v0, interpolation: 'EXACT', nearestTimeS: t0 };
  }
  const f = t1 === t0 ? 0 : (timeS - t0) / (t1 - t0);
  return {
    ...base,
    valueC: v0 + (v1 - v0) * f,
    interpolation: 'LINEAR_WITHIN_SCENARIO',
    nearestTimeS: t0,
  };
}

/**
 * 查询切片的帧索引（最近邻，不做跨帧插值——切片插值会产生
 * 非物理的中间热场，故仅返回真实存在的帧）。
 */
export function findSliceFrameIndex(
  meta: SliceMeta,
  timeS: number,
): { index: number; exact: boolean } | null {
  if (meta.frameTimesS.length === 0) return null;
  let best = 0;
  let bestDiff = Math.abs(meta.frameTimesS[0] - timeS);
  for (let i = 1; i < meta.frameTimesS.length; i++) {
    const d = Math.abs(meta.frameTimesS[i] - timeS);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  const exact = Math.abs(meta.frameTimesS[best] - timeS) < 1e-3;
  return { index: best, exact };
}
/** 在进入 React/Three 渲染前验证资产契约，让错误由 store 捕获。 */
export function validateDatasetQuantization(manifest: ScenarioDataset, scenarioId: string): void {
  if (manifest.scenarioId !== scenarioId) throw new Error('工况资产身份不一致');
  const mode = resolveScaleMode({scaleC: 0, scaleMode: manifest.scaleMode});
  for (const sl of manifest.slices ?? []) {
    if (quantSpecFromSlice(sl).mode !== mode) throw new Error(`manifest.scaleMode 与切片不一致：${sl.asset}`);
  }
}

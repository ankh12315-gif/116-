/**
 * 全局单一状态源（docs/02 §9：同一逻辑状态驱动时间轴、设备卡、报警、三维渲染）
 *
 * 所有组件都从这里读时间与选择状态，避免各组件显示不一致的时刻。
 */

import { create } from 'zustand';
import type {
  AlarmState,
  AlarmThresholds,
  AppMode,
  Availability,
  Cabinet,
  DataProvenance,
  HrrInterpretation,
  HrrSeries,
  PlaybackState,
  ReleaseProfile,
  RenderMode,
  Scenario,
  ScenarioSeries,
  SceneMaster,
  SliceMeta,
  VoltageZone,
  VolumeManifest,
  VolumeMeta,
  ZoneFilter,
} from '../types/domain';
import {
  ScenarioAccessError,
  assertScenarioUsable,
  clearDatasetCache,
  clearSliceCache,
  clearVolumeCache,
  loadAssets,
  loadScenarioDataset,
  loadSliceData,
  loadVolumeData,
  queryCabinetTemperature,
} from '../data/scenarioProvider';
import type { AssetReconciliation } from '../data/scenarioProvider';
import { classifyTemperature } from '../utils/coords';
import type {SceneMode} from '../config/sceneModes';
import {loadSceneGeometry} from '../data/sceneRegistry';

export const T_END_S = 1800;

export const DEFAULT_THRESHOLDS: AlarmThresholds = {
  warningC: 60,
  alarmC: 120,
  highZoneWarningC: 80,
  highZoneAlarmC: 150,
};

export interface AlarmEvent {
  id: string;
  timeS: number;
  cabinetId: string;
  scenarioId: string;
  level: 'TEMPERATURE_WARNING' | 'FIRE_ALARM';
  valueC: number;
  /** 事件来源：真实 FDS 计算结果 / 人工触发 */
  origin: 'FDS_COMPUTED' | 'MANUAL_TRIGGER';
}

interface FireState {
  sceneMode:SceneMode;
  sceneRevision:number;
  sceneSwitching:boolean;
  timeEndS:number;
  switchSceneMode:(mode:SceneMode,force?:boolean)=>Promise<void>;
  /* 资产 */
  loading: boolean;
  loadError: string | null;
  scenarios: Scenario[];
  cabinets: Cabinet[];
  scene: SceneMaster | null;
  /**
   * 资产层校正记录：scenarios.json 与 results/{id}/manifest.json 的不一致之处。
   * 非空即说明该工况的可用性/标称值在索引层是过时的，UI 需显式披露。
   */
  assetReconciliations: AssetReconciliation[];

  /* 模式与筛选 */
  appMode: AppMode;
  zoneFilter: ZoneFilter;
  renderMode: RenderMode;

  /* 选择 */
  selectedCabinetId: string | null;
  selectedPowerMW: number | null;
  activeScenarioId: string | null;

  /* 数据集 */
  datasetStatus: Availability | 'IDLE';
  datasetError: string | null;
  series: ScenarioSeries | null;
  hrr: HrrSeries | null;
  hrrInterpretation: HrrInterpretation | null;
  slices: SliceMeta[];
  sliceData: Record<string, Uint8Array>;
  sliceLoading: boolean;

  /**
   * 数据来源与校验状态（manifest.dataProvenance）。
   * null = 该工况的manifest 未提供来源信息 —— UI 显示「来源未标注」，
   * **不得**推断或编造来源。
   */
  provenance: DataProvenance | null;
  /** 释热剖面（仅高压工况存在） */
  releaseProfile: ReleaseProfile | null;
  /** 体数据清单（仅 HV-01-140MW 存在；其余 15 工况为 null） */
  volumeManifest: VolumeManifest | null;
  /** 已加载的体数据（按asset 索引；同时只保留当前 mesh 的一个） */
  volumeData: Record<string, Uint8Array>;
  volumeLoading: boolean;
  /** 当前加载的体数据 meshIndex（null = 未加载任何体数据） */
  activeVolumeMeshIndex: number | null;

  /* 时间轴 */
  currentTimeS: number;
  playback: PlaybackState;
  playbackRate: number;
  futureOffsetS: number | null; // t+Δt 未来场景查看

  /* 显示开关 */
  showRoof: boolean;
  wallOpacity: number;
  showSlices: boolean;
  showCabinetLabels: boolean;
  slicePlane: 'PBZ' | 'PBX' | 'PBY';
  /** 体数据（.s3d）显隐；与切片各自独立开关 */
  showVolume: boolean;

  /* 报警 */
  alarmState: AlarmState;
  alarmCabinetId: string | null;
  muted: boolean;
  audioUnlocked: boolean;
  thresholds: AlarmThresholds;
  alarmEvents: AlarmEvent[];
  manualTriggered: boolean;

  /* 动作 */
  init: () => Promise<void>;
  selectCabinet: (id: string | null) => Promise<void>;
  selectPower: (mw: number | null) => Promise<void>;
  activateScenario: (scenarioId: string) => Promise<void>;
  setZoneFilter: (z: ZoneFilter) => void;
  setAppMode: (m: AppMode) => void;
  setRenderMode: (m: RenderMode) => void;
  setTime: (t: number) => void;
  stepTime: (dt: number) => void;
  setPlayback: (p: PlaybackState) => void;
  setPlaybackRate: (r: number) => void;
  setFutureOffset: (d: number | null) => void;
  toggleRoof: () => void;
  setWallOpacity: (v: number) => void;
  toggleSlices: () => void;
  toggleLabels: () => void;
  toggleVolume: () => void;
  /** 切换当前要显示的体数据 mesh（同时只加载并显示一个，避免 16MB×5 全驻留） */
  selectVolumeMesh: (meshIndex: number | null) => void;
  setSlicePlane: (p: 'PBZ' | 'PBX' | 'PBY') => void;
  setMuted: (m: boolean) => void;
  unlockAudio: () => void;
  updateThresholds: (t: Partial<AlarmThresholds>) => void;
  manualTriggerAlarm: () => void;
  resetAlarm: () => void;
  clearAlarmEvents: () => void;
  focusCameraOn: (cabinetId: string) => void;
}

/** 当前生效的查询时刻（含未来偏移） */
export function effectiveTime(state: {
  currentTimeS: number;
  futureOffsetS: number | null;
}): number {
  return state.currentTimeS + (state.futureOffsetS ?? 0);
}

/** 计算指定时刻、考虑未来偏移后的温度 */
export function currentTemperature(state: {
  series: ScenarioSeries | null;
  currentTimeS: number;
  futureOffsetS: number | null;
}) {
  return queryCabinetTemperature(state.series, effectiveTime(state));
}

/** 柜体在当前时刻的告警级别 */
export function cabinetAlarmLevel(
  state: Pick<FireState, 'series' | 'currentTimeS' | 'futureOffsetS' | 'thresholds'>,
  zone: VoltageZone,
): AlarmState {
  const q = queryCabinetTemperature(state.series, effectiveTime(state));
  if (q.valueC === null) return 'NORMAL';
  const warn = zone === 'HIGH' ? state.thresholds.highZoneWarningC : state.thresholds.warningC;
  const alarm = zone === 'HIGH' ? state.thresholds.highZoneAlarmC : state.thresholds.alarmC;
  return classifyTemperature(q.valueC, warn, alarm) as AlarmState;
}

let alarmSeq = 0;
let datasetRequest = 0;
let sceneRequest=0;let sceneController:AbortController|undefined;
let planeRequest = 0;
let volumeRequest = 0;

export const useFireStore = create<FireState>((set, get) => ({
  sceneMode:'windowed',sceneRevision:0,sceneSwitching:false,timeEndS:T_END_S,
  loading: true,
  loadError: null,
  scenarios: [],
  cabinets: [],
  scene: null,
  assetReconciliations: [],

  appMode: 'FDS_SCENARIO',
  zoneFilter: 'ALL',
  renderMode: 'ARCHITECTURE',

  selectedCabinetId: 'LV-01',
  selectedPowerMW: null,
  activeScenarioId: null,

  datasetStatus: 'IDLE',
  datasetError: null,
  series: null,
  hrr: null,
  hrrInterpretation: null,
  slices: [],
  sliceData: {},
  sliceLoading: false,
  provenance: null,
  releaseProfile: null,
  volumeManifest: null,
  volumeData: {},
  volumeLoading: false,
  activeVolumeMeshIndex: null,

  currentTimeS: 0,
  playback: 'IDLE',
  playbackRate: 0.5,
  futureOffsetS: null,

  showRoof: false,
  wallOpacity: 0.22,
  showSlices: false,
  showCabinetLabels: true,
  slicePlane: 'PBZ',
  showVolume: false,

  alarmState: 'NORMAL',
  alarmCabinetId: null,
  muted: false,
  audioUnlocked: false,
  thresholds: DEFAULT_THRESHOLDS,
  alarmEvents: [],
  manualTriggered: false,

  async init() {
    await get().switchSceneMode(get().sceneMode,true);
  },
  async switchSceneMode(mode,force=false){
    if(!force&&mode===get().sceneMode&&!get().sceneSwitching&&!get().loadError)return;
    const request=++sceneRequest;sceneController?.abort();sceneController=new AbortController();
    ++datasetRequest;++planeRequest;++volumeRequest;clearDatasetCache();clearSliceCache();clearVolumeCache();
    set({sceneMode:mode,sceneRevision:get().sceneRevision+1,sceneSwitching:true,loading:!get().scene,loadError:null,playback:'PAUSED',currentTimeS:0,futureOffsetS:null,activeScenarioId:null,selectedCabinetId:null,selectedPowerMW:null,series:null,hrr:null,hrrInterpretation:null,slices:[],sliceData:{},volumeManifest:null,volumeData:{},activeVolumeMeshIndex:null,showVolume:false,sliceLoading:false,volumeLoading:false,datasetStatus:'IDLE',datasetError:null,provenance:null,releaseProfile:null,alarmEvents:[],alarmState:'NORMAL',alarmCabinetId:null,manualTriggered:false,timeEndS:T_END_S});
    try {
      const { scenarios, cabinets, scene, reconciliations } = await loadAssets(mode,sceneController.signal);
      if(request!==sceneRequest)return;
      set({ scenarios, cabinets, scene, assetReconciliations: reconciliations, loading: false,sceneSwitching:false });
    } catch (e) {
      if(request!==sceneRequest)return;
      set({
        loading: false,sceneSwitching:false,
        loadError: (e as Error).message || '资产加载失败',
      });
    }
  },

  async selectCabinet(id) {
    ++datasetRequest; ++planeRequest; ++volumeRequest;
    if (!id) {
      set({
        selectedCabinetId: null,
        series: null,
        hrr: null,
        hrrInterpretation: null,
        slices: [],
        sliceData: {},
        activeScenarioId: null,
        datasetStatus: 'IDLE',
        datasetError: null,
        alarmState: 'NORMAL',
        alarmCabinetId: null,
        provenance: null,
        releaseProfile: null,
        volumeManifest: null,
        volumeData: {},
        activeVolumeMeshIndex: null,
      });
      return;
    }
    const cab = get().cabinets.find((c) => c.id === id);
    if (!cab) return;

    // 低压无功率档位；高压需要显式选择，默认 40MW（若不可用则取第一个可用）
    let power: number | null = null;
    if (cab.zone === 'HIGH') {
      power = get().selectedPowerMW;
      if (power === null) {
        const firstUsable = get().scenarios.find(
          (s) => s.cabinetId === id && s.availability === 'READY',
        );
        power = firstUsable?.powerOptionMW ?? 40;
      }
    }

    set({
      selectedCabinetId: id,
      selectedPowerMW: power,
      series: null,
      hrr: null,
      hrrInterpretation: null,
      slices: [],
      sliceData: {},
      activeScenarioId: null,
      datasetStatus: 'LOADING',
      datasetError: null,
      futureOffsetS: null,
      playback: 'IDLE',
      currentTimeS: 0,
      provenance: null,
      releaseProfile: null,
      volumeManifest: null,
      volumeData: {},
      activeVolumeMeshIndex: null,
      // 切换工况必须关掉体数据：避免上一个工况的体数据张冠李戴
      showVolume: false,
      volumeLoading: false,
      alarmState: 'NORMAL',
      alarmCabinetId: null,
      manualTriggered: false,
      alarmEvents: [],
    });

    if (power === null && cab.zone === 'LOW') {
      // 低压自动匹配唯一工况
      const ok = get().scenarios.find(
        (s) => s.cabinetId === id && s.zone === 'LOW',
      );
      if (ok) await get().activateScenario(ok.id);
      else
        set({
          datasetStatus: 'MISSING_OUTPUT',
          datasetError: `柜体 ${id} 没有可用工况`,
        });
      return;
    }

    const scen = get().scenarios.find(
      (s) => s.cabinetId === id && s.powerOptionMW === power,
    );
    if (!scen) {
      set({
        datasetStatus: 'MISSING_OUTPUT',
        datasetError: `柜体 ${id} 的 ${power}MW 工况不可用`,
      });
      return;
    }
    await get().activateScenario(scen.id);
  },

  async selectPower(mw) {
    const id = get().selectedCabinetId;
    if (!id) return;
    set({ selectedPowerMW: mw });
    await get().selectCabinet(id);
  },

  async activateScenario(scenarioId) {
    const request = ++datasetRequest;
    const mode=get().sceneMode,revision=get().sceneRevision;
    // Provider内部二次校验，防止绕过 UI
    const found = get().scenarios.find((s) => s.id === scenarioId);
    try {
      assertScenarioUsable(found, scenarioId);
    } catch (e) {
      const err = e as ScenarioAccessError;
      set({
        datasetStatus: err.availability,
        datasetError: err.message,
        series: null,
        hrr: null,
        hrrInterpretation: null,
        slices: [],
        sliceData: {},
        activeScenarioId: null,
        provenance: null,
        releaseProfile: null,
        volumeManifest: null,
        volumeData: {},
        activeVolumeMeshIndex: null,
      });
      return;
    }

    set({
      activeScenarioId: scenarioId,
      datasetStatus: 'LOADING',
      datasetError: null,
      sliceLoading: true,
      slices: [], sliceData: {}, hrr: null, volumeManifest: null, volumeData: {},
    });

    try {
      const [dataResult,geometryResult]=await Promise.allSettled([loadScenarioDataset(scenarioId,mode),loadSceneGeometry(mode,scenarioId,sceneController?.signal)]);
      if(dataResult.status==='rejected')throw dataResult.reason;
      if(geometryResult.status==='rejected')throw geometryResult.reason;
      const dataset=dataResult.value,scene=geometryResult.value;
      const {manifest,series,hrr,provenance,releaseProfile,volumeManifest}=dataset;
      if (request !== datasetRequest || get().activeScenarioId !== scenarioId||get().sceneRevision!==revision) return;
      set({scene,timeEndS:manifest.timeRangeS?.[1]??T_END_S});
      // 切换工况释放旧缓存，防止串温
      clearDatasetCache(scenarioId);
      clearSliceCache();
      clearVolumeCache();

      set({
        series,
        hrr,
        hrrInterpretation: manifest.hrrInterpretation ?? null,
        slices: manifest.slices ?? [],
        sliceData: {},
        datasetStatus: 'READY',
        datasetError: null,
        provenance,
        releaseProfile,
        volumeManifest,
        volumeData: {},
        activeVolumeMeshIndex: null,
      });

      // 按需加载当前切片平面的数据
      const plane = get().slicePlane;
      const target = (manifest.slices ?? []).filter((s) => s.plane === plane);
      const loaded: Record<string, Uint8Array> = {};
      await Promise.all(
        target.map(async (s) => {
          try {
            loaded[s.asset] = await loadSliceData(scenarioId, s.asset);
          } catch {
            /* 单个切片失败不阻断整体 */
          }
        }),
      );
      if (request === datasetRequest && get().activeScenarioId === scenarioId && get().slicePlane === plane) set({ sliceData: loaded, sliceLoading: false, datasetError: Object.keys(loaded).length < target.length ? '部分温度切片加载失败；灰斜纹区域为数据不可用' : null });

      // 体数据：仅当该工况确实有 volume/manifest.json 时，
      // 且用户此前已打开体数据开关，才自动加载第一个 mesh。
      // 其余 15 工况 volumeManifest 为 null → 保持关闭，UI 显示「该工况未接入体数据」。
      if (request === datasetRequest && volumeManifest && get().showVolume) {
        const first = volumeManifest.volumes[0];
        if (first) await get().selectVolumeMesh(first.meshIndex);
      }
    } catch (e) {
      if (request !== datasetRequest || get().activeScenarioId !== scenarioId) return;
      const err = e as ScenarioAccessError;
      set({
        datasetStatus: err.availability ?? 'CONVERSION_ERROR',
        datasetError: err.message,
        series: null,
        hrr: null,
        hrrInterpretation: null,
        slices: [],
        sliceData: {},
        sliceLoading: false,
        provenance: null,
        releaseProfile: null,
        volumeManifest: null,
        volumeData: {},
        activeVolumeMeshIndex: null,
      });
    }
  },

  setZoneFilter: (z) => set({ zoneFilter: z }),
  setAppMode: (m) => set({ appMode: m }),
  setRenderMode: (m) =>
    set({ renderMode: m, showSlices: m === 'THERMAL_SLICE' }),

  setTime(t) {
    if (!Number.isFinite(t)) return;
    const clamped = Math.min(Math.max(0, t), get().timeEndS);
    const next: Partial<FireState> = { currentTimeS: clamped };
    if (get().playback === 'PLAYING' && clamped >= get().timeEndS) {
      next.playback = 'ENDED';
    }
    set(next as FireState);
  },

  stepTime(dt) {
    const s = get();
    const next = s.currentTimeS + dt * s.playbackRate;
    if (next >= s.timeEndS) {
      set({ currentTimeS: s.timeEndS, playback: 'ENDED' });
    } else {
      set({ currentTimeS: next });
    }
  },

  setPlayback: (p) => set({ playback: p }),
  setPlaybackRate: (r) => set({ playbackRate: r }),
  setFutureOffset: (d) => {
    const s = get();
    if (d !== null) {
      if (!Number.isFinite(d) || d < 0) return;
      const target = s.currentTimeS + d;
      if (target > s.timeEndS) {
        // 越界：拒绝并保持当前状态
        set({ futureOffsetS: null });
        return;
      }
    }
    set({ futureOffsetS: d });
  },

  toggleRoof: () => set({ showRoof: !get().showRoof }),
  setWallOpacity: (v) => set({ wallOpacity: v }),
  toggleSlices: () => set({ showSlices: !get().showSlices }),
  toggleLabels: () => set({ showCabinetLabels: !get().showCabinetLabels }),

  async toggleVolume() {
    const next = !get().showVolume;
    set({ showVolume: next });
    if (!next) {
      // 关闭时释放体数据显存占用
      clearVolumeCache();
      set({ volumeData: {}, activeVolumeMeshIndex: null });
      return;
    }
    const vm = get().volumeManifest;
    if (!vm) return; // 其余 15 工况无体数据 → 开关无效但 UI 显示未接入
    const first = vm.volumes[0];
    if (first) await get().selectVolumeMesh(first.meshIndex);
  },

  async selectVolumeMesh(meshIndex) {
    const request = ++volumeRequest;
    const s = get();
    if (meshIndex === null) {
      clearVolumeCache();
      set({ volumeData: {}, activeVolumeMeshIndex: null, volumeLoading: false });
      return;
    }
    const vm = s.volumeManifest;
    if (!vm) {
      set({ datasetError: '该工况未接入体数据（volume/manifest.json 不存在）' });
      return;
    }
    const meta: VolumeMeta | undefined = vm.volumes.find((v) => v.meshIndex === meshIndex);
    if (!meta || !s.activeScenarioId) return;

    // 性能：一次只保留当前 mesh 的体数据，切mesh 时清掉旧的
    if (s.activeVolumeMeshIndex !== null && s.activeVolumeMeshIndex !== meshIndex) {
      clearVolumeCache();
      set({ volumeData: {}, volumeLoading: true });
    } else {
      set({ volumeLoading: true });
    }

    try {
      const bin = await loadVolumeData(s.activeScenarioId, meta.asset);
      if (request !== volumeRequest || get().activeScenarioId !== s.activeScenarioId || !get().showVolume) return;
      set({ volumeData: { [meta.asset]: bin }, activeVolumeMeshIndex: meshIndex, volumeLoading: false });
    } catch (e) {
      if (request !== volumeRequest || get().activeScenarioId !== s.activeScenarioId) return;
      set({
        volumeData: {},
        activeVolumeMeshIndex: null,
        volumeLoading: false,
        datasetError: `体数据加载失败：${(e as Error).message}`,
      });
    }
  },

  setSlicePlane(p) {
    const request = ++planeRequest;
    set({ slicePlane: p, sliceLoading: true });
    const s = get();
    if (!s.activeScenarioId) {
      set({ sliceLoading: false });
      return;
    }
    const target = s.slices.filter((sl) => sl.plane === p);
    const loaded: Record<string, Uint8Array> = {};
    void Promise.all(
      target.map(async (sl) => {
        try {
          loaded[sl.asset] = await loadSliceData(s.activeScenarioId!, sl.asset);
        } catch {
          /* ignore */
        }
      }),
    ).then(() => {
      if (request === planeRequest && get().activeScenarioId === s.activeScenarioId && get().slicePlane === p) set({ sliceData: loaded, sliceLoading: false, datasetError: Object.keys(loaded).length < target.length ? '部分温度切片加载失败；灰斜纹区域为数据不可用' : null });
    });
  },

  setMuted: (m) => set({ muted: m }),
  unlockAudio: () => set({ audioUnlocked: true }),
  updateThresholds: (t) => set({ thresholds: { ...get().thresholds, ...t } }),

  manualTriggerAlarm() {
    const s = get();
    const cabId = s.selectedCabinetId;
    if (!cabId) return;
    const q = queryCabinetTemperature(s.series, effectiveTime(s));
    const value = q.valueC ?? s.thresholds.alarmC;
    const evt: AlarmEvent = {
      id: `alarm-${++alarmSeq}`,
      timeS: effectiveTime(s),
      cabinetId: cabId,
      scenarioId: s.activeScenarioId ?? 'MANUAL',
      level: 'FIRE_ALARM',
      valueC: value,
      origin: 'MANUAL_TRIGGER',
    };
    set({
      manualTriggered: true,
      alarmState: 'FIRE_ALARM',
      alarmCabinetId: cabId,
      alarmEvents: [evt, ...s.alarmEvents].slice(0, 60),
    });
  },

  resetAlarm() {
    // 仅清除前端报警态，不修改任何 FDS 原始结果
    set({
      alarmState: 'NORMAL',
      alarmCabinetId: null,
      manualTriggered: false,
    });
  },

  clearAlarmEvents: () => set({ alarmEvents: [] }),

  focusCameraOn: (cabinetId) => {
    set({ selectedCabinetId: cabinetId });
  },
}));

useFireStore.subscribe((state, previous) => {
  if (state.series === previous.series && state.currentTimeS === previous.currentTimeS && state.thresholds === previous.thresholds) return;
  if (state.manualTriggered || state.datasetStatus !== 'READY') return;
  const cabinet = state.cabinets.find(c => c.id === state.selectedCabinetId);
  if (!cabinet) return;
  const query = queryCabinetTemperature(state.series, state.currentTimeS);
  const level = classifyTemperature(query.valueC,
    cabinet.zone === 'HIGH' ? state.thresholds.highZoneWarningC : state.thresholds.warningC,
    cabinet.zone === 'HIGH' ? state.thresholds.highZoneAlarmC : state.thresholds.alarmC);
  const alarm = level === 'UNKNOWN' ? 'NORMAL' : level;
  if (alarm === state.alarmState) return;
  const event: AlarmEvent[] = alarm === 'NORMAL' || query.valueC === null ? [] : [{
    id: `alarm-${++alarmSeq}`, timeS: state.currentTimeS, cabinetId: cabinet.id,
    scenarioId: state.activeScenarioId ?? '', level: alarm, valueC: query.valueC, origin: 'FDS_COMPUTED',
  }];
  useFireStore.setState({alarmState: alarm, alarmCabinetId: alarm === 'NORMAL' ? null : cabinet.id,
    alarmEvents: [...event, ...state.alarmEvents].slice(0,60)});
});

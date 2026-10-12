/**
 * 顶栏：项目标识 · 模式切换 · 区域筛选 · 图层开关 · 静音 · 免责入口
 *
 * DESIGN_SYSTEM §4.1 / §4.10 / §4.12；UX_SPEC §1.3 / §5 E-11
 *
 * 三态：loading（资产加载中）/ error（资产加载失败）/ 无数据（无场景几何时降级）
 */

import { useMemo } from 'react';
import { useFireStore } from '../store/useFireStore';
import { sliceQuantDomain } from '../utils/coords';
import { formatNumber } from '../utils/format';
import type { ZoneFilter } from '../types/domain';

interface Props {
  onOpenDisclaimer: () => void;
}

const ZONE_FILTERS: Array<{ v: ZoneFilter; label: string }> = [
  { v: 'ALL', label: '全部' },
  { v: 'HIGH', label: '高压' },
  { v: 'LOW', label: '低压' },
];

const ALARM_TEXT = {
  NORMAL: '正常',
  TEMPERATURE_WARNING: '高温预警',
  FIRE_ALARM: '火灾报警',
} as const;

const ALARM_DOT = {
  NORMAL: 'status-dot--normal',
  TEMPERATURE_WARNING: 'status-dot--warn',
  FIRE_ALARM: 'status-dot--alarm',
} as const;

/** 墙透明度 3 档（UX_SPEC 强制约束 E：按几何形态生效，语义未核验） */
const WALL_STEPS = [
  { v: 1, label: '不透明' },
  { v: 0.55, label: '半透' },
  { v: 0.2, label: '透' },
] as const;

const UNVERIFIED_HINT =
  '源 FDS 的 OBST 无墙/顶语义字段，此开关按几何形态生效，可能隐藏非屋顶构件。几何语义状态：UNVERIFIED。';

export default function TopBar({ onOpenDisclaimer }: Props) {
  const loading = useFireStore((s) => s.loading);
  const loadError = useFireStore((s) => s.loadError);
  const scene = useFireStore((s) => s.scene);
  const appMode = useFireStore((s) => s.appMode);
  const setAppMode = useFireStore((s) => s.setAppMode);
  const zoneFilter = useFireStore((s) => s.zoneFilter);
  const setZoneFilter = useFireStore((s) => s.setZoneFilter);
  const showRoof = useFireStore((s) => s.showRoof);
  const toggleRoof = useFireStore((s) => s.toggleRoof);
  const wallOpacity = useFireStore((s) => s.wallOpacity);
  const setWallOpacity = useFireStore((s) => s.setWallOpacity);
  const showCabinetLabels = useFireStore((s) => s.showCabinetLabels);
  const toggleLabels = useFireStore((s) => s.toggleLabels);
  const showSlices = useFireStore((s) => s.showSlices);
  const toggleSlices = useFireStore((s) => s.toggleSlices);
  const muted = useFireStore((s) => s.muted);
  const setMuted = useFireStore((s) => s.setMuted);
  const alarmState = useFireStore((s) => s.alarmState);

  // 三态：无场景几何 → 图层开关不可用（几何未接入时不提供假能力）
  const geometryReady = scene !== null && !loadError;
  const sliceCount = useFireStore((s) => s.slices.length);
  const slices = useFireStore((s) => s.slices);
  const volumeCount = useFireStore((s) => s.volumeManifest?.volumes.length ?? 0);
  const showVolume = useFireStore((s) => s.showVolume);
  const toggleVolume = useFireStore((s) => s.toggleVolume);

  // 切片量化域**逐工况动态**（15 工况 20–800 ℃；HV-01-140MW 20–2020 ℃）。
  // tooltip 写死 800 会误导用户对 140MW 的读数范围判断。
  const sliceDomainText = useMemo(() => {
    if (slices.length === 0) return '';
    let minC = Infinity;
    let maxC = -Infinity;
    for (const s of slices) {
      const d = sliceQuantDomain(s);
      if (d.minC < minC) minC = d.minC;
      if (d.maxC > maxC) maxC = d.maxC;
    }
    return `${formatNumber(minC, 0)}–${formatNumber(maxC, 0)} ℃`;
  }, [slices]);

  const statusLabel = loading
    ? '加载中…'
    : loadError
      ? '资产加载失败'
      : ALARM_TEXT[alarmState];

  return (
    <header className="topbar">
      <div className="topbar__left">
        <div className="topbar__eyebrow">Fire Digital Twin</div>
        <h1 className="topbar__title">116 配电室</h1>
        <div className="topbar__subtitle">FDS 火灾三维态势 · 科研可视化</div>
      </div>

      <div className="topbar__right">
        {/* 模式切换 */}
        <div
          className="chip"
          role="radiogroup"
          aria-label="运行模式"
          style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--c-bg-sunken)', borderRadius: 'var(--r-md)' }}
        >
          <button
            type="button"
            role="radio"
            aria-checked={appMode === 'MONITOR'}
            className={`chip${appMode === 'MONITOR' ? ' is-active' : ''}`}
            onClick={() => setAppMode('MONITOR')}
          >
            实时监测
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={appMode === 'FDS_SCENARIO'}
            className={`chip${appMode === 'FDS_SCENARIO' ? ' is-active' : ''}`}
            onClick={() => setAppMode('FDS_SCENARIO')}
          >
            FDS 火灾工况
          </button>
        </div>

        {/* 区域筛选 */}
        <div
          className="chip"
          role="group"
          aria-label="区域筛选"
          style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--c-bg-sunken)', borderRadius: 'var(--r-md)' }}
        >
          {ZONE_FILTERS.map((z) => (
            <button
              key={z.v}
              type="button"
              aria-pressed={zoneFilter === z.v}
              className={`chip${zoneFilter === z.v ? ' is-active' : ''}`}
              onClick={() => setZoneFilter(z.v)}
            >
              {z.label}
            </button>
          ))}
        </div>

        {/* 图层开关 */}
        <div className="chip" role="group" aria-label="图层开关" style={{ display: 'inline-flex', gap: 2 }}>
          <button
            type="button"
            className={`chip${showRoof ? ' is-active' : ''}`}
            aria-pressed={showRoof}
            onClick={toggleRoof}
            disabled={!geometryReady}
            title={UNVERIFIED_HINT}
          >
            水平面代理（未核验）
            <UnverifiedBadge />
          </button>

          <div className="chip" role="group" aria-label="立面透明度" style={{ display: 'inline-flex', gap: 2 }}>
            {WALL_STEPS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`chip${Math.abs(wallOpacity - s.v) < 0.01 ? ' is-active' : ''}`}
                aria-pressed={Math.abs(wallOpacity - s.v) < 0.01}
                onClick={() => setWallOpacity(s.v)}
                disabled={!geometryReady}
                title={UNVERIFIED_HINT}
              >
                {s.label}
              </button>
            ))}
            <span className="chip__tag" title={UNVERIFIED_HINT}>
              立面透明（未核验）
              <UnverifiedBadge />
            </span>
          </div>

          <button
            type="button"
            className={`chip${showCabinetLabels ? ' is-active' : ''}`}
            aria-pressed={showCabinetLabels}
            onClick={toggleLabels}
            disabled={!geometryReady}
          >
            标签
          </button>

          <button
            type="button"
            className={`chip${showSlices ? ' is-active' : ''}`}
            aria-pressed={showSlices}
            onClick={toggleSlices}
            disabled={!geometryReady || sliceCount === 0}
            title={
              sliceCount === 0
                ? '当前工况无 FDS 温度切片数据'
                : `显示/隐藏 FDS 温度切片（8bit 量化域 ${sliceDomainText}）`
            }
          >
            切片
            <span className="chip__tag">{sliceCount > 0 ? `${sliceCount} 片` : '未接入'}</span>
          </button>

          {/* 体数据（.s3d）：独立开关。
              仅 HV-01-140MW 接入，其余 15 工况按钮禁用并说明原因。 */}
          <button
            type="button"
            className={`chip${showVolume ? ' is-active' : ''}`}
            aria-pressed={showVolume}
            onClick={() => void toggleVolume()}
            disabled={!geometryReady || volumeCount === 0}
            title={
              volumeCount === 0
                ? '该工况未接入体数据（仅 HV-01-140MW 已转换 .s3d）'
                : '显示/隐藏体数据（与切片共用同一色标定义域，帧栅格独立）'
            }
          >
            体数据
            <span className="chip__tag">{volumeCount > 0 ? `${volumeCount} mesh` : '未接入'}</span>
          </button>
        </div>

        {/* 静音：只影响音频，视觉报警不受影响 */}
        <button
          type="button"
          className={`chip${muted ? '' : ' is-active'}`}
          aria-pressed={muted}
          aria-label={muted ? '取消静音，恢复报警音' : '静音报警音'}
          onClick={() => setMuted(!muted)}
        >
          {muted ? '🔇 已静音' : '🔊 报警音'}
        </button>

        {/* 系统状态胶囊 */}
        <div className="topbar__status" role="status" aria-live="polite">
          <span className={`status-dot ${ALARM_DOT[alarmState]}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>

        {/* 免责入口：必须带「免责」文字，非纯图标（红线 D10） */}
        <button
          type="button"
          className="btn"
          onClick={onOpenDisclaimer}
          aria-haspopup="dialog"
          aria-label="打开使用说明与免责声明"
        >
          ⓘ 免责
        </button>
      </div>
    </header>
  );
}

/**
 * 「未核验」角标（DESIGN_SYSTEM §4.10）
 * 刻意使用中性色，**禁止**警示色 —— 它是事实声明，不是警告。
 */
function UnverifiedBadge() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        marginLeft: 4,
        border: '1px solid var(--c-border-strong)',
        borderRadius: 'var(--r-sm)',
        fontSize: 10,
        lineHeight: 1,
        color: 'var(--c-text-3)',
        flex: 'none',
      }}
    >
      ?
    </span>
  );
}
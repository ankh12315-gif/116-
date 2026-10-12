/**
 * 温度色标图例（DESIGN_SYSTEM §3.2 / §3.2b / §3.2c；UX_SPEC §4.5.3）
 *
 * 本组件承载四条不可妥协的数据真实性规则：
 *  1. **必须标注当前显示的是哪一套域** —— 切片量化域 20–800℃ 与色标定义域 20–950℃
 *     是两套不同的东西，绝不可混用（硬性规则 5）。
 *  2. **两端截断标记常驻**（红线 D4）—— `≤20℃ 截断` 与 `≥800℃ 饱和`。
 *     实测 618 个切片中 500 个（81%）含低于 20℃ 的数据，截断是常态而非例外。
 *  3. **色标不单独承载信息**（无障碍）—— 必须有数值刻度 + 完整 aria-label。
 *  4. **「无切片数据」不参与色标** —— 它是中性灰 + 斜纹，不是第 0 档温度。
 */

import {
  NO_DATA_LABEL,
  SLICE_CMAP_NOTE,
  SLICE_MAX_C,
  SLICE_MIN_C,
  TEMP_MAX_C,
  TEMP_MIN_C,
  colormapTicks,
  domainTicks,
  temperatureGradientCss,
} from '../utils/coords';
import type { ColorMapMode } from '../utils/coords';

export interface LegendProps {
  /** 色标模式：默认版（精读/打印）vs 高对比版（投影/色觉障碍） */
  mode?: ColorMapMode;
  /** SLICE = 切片量化域；SCALAR = 色标定义域 20–950 ℃ */
  variant?: 'SLICE' | 'SCALAR';
  /** 是否处于未来场景视图（UX_SPEC §4.2.3） */
  future?: boolean;
  /** 未来场景时刻（s），future=true 时显示 */
  futureTimeS?: number;
  /** 当前场景时刻（s） */
  currentTimeS?: number;
  /** 切片覆盖信息（UX_SPEC 强制约束 B） */
  patchCount?: number;
  /** 无切片数据时的补充说明（如「该工况无温度切片数据」） */
  emptyNote?: string;
  /**
   * 当前切片量化域下限（℃），**必须从 manifest 逐切片读取**，不传回退 SLICE_MIN_C。
   */
  domainMinC?: number;
  /**
   * 当前切片量化域上限（℃），**必须从 manifest 逐切片读取**。
   * ⚠️ 不可全局固定 800：HV-01-140MW 的域是 2020 ℃，实测最高 1133 ℃。
   * 写死 800 会把 1133 ℃ 静默截断成同一色（伪造数据）。
   */
  domainMaxC?: number;
  /** 本工况实测最高温（℃），用于说明色带上端是否发生截断 */
  observedMaxC?: number;
  /** 量化说明文案（步长随工况不同，必须动态生成） */
  cmapNote?: string;
}

/** 45° 斜纹（DESIGN_SYSTEM §3.2b 的 --cmap-clamp 内联化） */
const HATCH =
  'repeating-linear-gradient(45deg, rgba(31,30,27,0.10) 0 2px, transparent 2px 5px)';

/** 「无切片数据」中性灰斜纹底 —— 刻意不含暖色相（红线 D3） */
const NO_DATA_BG =
  'repeating-linear-gradient(45deg, rgba(31,30,27,0.10) 0 2px, transparent 2px 5px), #F1EFEA';

export default function Legend({
  mode = 'DEFAULT',
  variant = 'SLICE',
  future = false,
  futureTimeS,
  currentTimeS,
  patchCount,
  emptyNote,
  domainMinC,
  domainMaxC,
  observedMaxC,
  cmapNote,
}: LegendProps) {
  const isSlice = variant === 'SLICE';
  // 量化域动态取值：15 工况 20–800 ℃；HV-01-140MW 20–2020 ℃。
  // 写死 800 会把140MW 的实测 1133 ℃ 截断（伪造数据）。
  const min = isSlice ? (domainMinC ?? SLICE_MIN_C) : TEMP_MIN_C;
  const max = isSlice ? (domainMaxC ?? SLICE_MAX_C) : TEMP_MAX_C;
  const note = cmapNote ?? SLICE_CMAP_NOTE;
  const gradient = temperatureGradientCss('to right', mode, min, max);

  // 刻度：域内锚点优先；域超出锚点范围（如 140MW 的 2020 ℃）时按域线性补足
  const anchorTicks = colormapTicks(mode).filter((t) => t.c >= min && t.c <= max);
  const ticks: Array<{ c: number; css: string }> =
    anchorTicks.length >= 5
      ? anchorTicks
      : domainTicks(min, max, 5).map((c) => ({
          c,
          css: temperatureGradientCss('to right', mode, min, max),
        }));

  /** 上端是否发生截断：实测最高温超过色标域上限 → 必须常驻披露 */
  const topClamped = observedMaxC !== undefined && observedMaxC > max;
  const bottomClamped = true; // 实测 618 切片中 500 个含低于域下限的数据（红线 D4）

  const title = isSlice ? '切片量化域' : '色标定义域';
  const clampText = `≤${min} ℃ 截断`;
  const satText = `≥${max} ℃ 饱和`;

  const ariaLabel = [
    `温度色标，${title}，范围 ${min} 至 ${max} 摄氏度。`,
    isSlice
      ? `${note}，高于 ${max} 摄氏度饱和无法分辨，低于 ${min} 摄氏度截断为 ${min}。`
      : '',
    `${NO_DATA_LABEL}区域为中性灰斜纹，不参与色标，不代表 ${min} 摄氏度。`,
    mode === 'HIGH_CONTRAST'
      ? '当前为高对比模式，颜色不可与默认模式比较。'
      : '当前为默认模式，适合近屏精读、截图与打印。',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside className="legend" aria-label="温度色标图例">
      <div className="panel__title" style={{ marginBottom: 4 }}>
        温度分布 · GAS TEMPERATURE
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 10,
          color: 'var(--c-text-3)',
        }}
      >
        <span>{title}</span>
        <span className="badge badge--fds">FDS SIMULATED</span>
      </div>

      {/* 色带 + 两端常驻截断标记（红线 D4） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
          marginTop: 7,
          height: 12,
        }}
      >
        {/* 左端：斜纹带 + ≤ 符号 */}
        <div
          title={`${clampText}（低于 ${min}℃ 无法分辨）`}
          style={{
            width: 18,
            flex: 'none',
            border: '1px solid var(--c-border)',
            borderRight: 'none',
            borderRadius: 'var(--r-sm) 0 0 var(--r-sm)',
            background: HATCH,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            color: 'var(--c-text-2)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ≤
        </div>

        {/* 主色带 */}
        <div
          className="legend__ramp"
          role="img"
          aria-label={ariaLabel}
          style={{
            flex: 1,
            margin: 0,
            height: 12,
            background: gradient,
          }}
        />

        {/* 右端：斜纹带 + ≥ 符号 */}
        <div
          title={`${satText}（高于 ${max}℃ 无法分辨）`}
          style={{
            width: 18,
            flex: 'none',
            border: '1px solid var(--c-border)',
            borderLeft: 'none',
            borderRadius: '0 var(--r-sm) var(--r-sm) 0',
            background: HATCH,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            color: 'var(--c-text-2)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ≥
        </div>
      </div>

      {/* 常驻截断文案 —— 不允许仅 hover 出现 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 9,
          color: 'var(--c-text-2)',
          marginTop: 3,
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>{bottomClamped ? `≤${min}℃ 截断` : ''}</span>
        <span>{topClamped ? `≥${max}℃ 饱和` : '未达饱和'}</span>
      </div>

      {/* 数值刻度（色标不单独承载信息） */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'var(--c-text-2)',
          marginTop: 2,
        }}
      >
        {ticks.map((t, i) => (
          <span key={i}>{Math.round(t.c)}</span>
        ))}
      </div>
      <div
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'var(--c-text-3)',
        }}
      >
        ℃
      </div>

      {/* 未来场景：与当前场景各自带独立色标（UX_SPEC §4.2.3 五维分离） */}
      {future && futureTimeS !== undefined && (
        <div
          role="status"
          style={{
            marginTop: 7,
            padding: '4px 6px',
            border: '2px dashed var(--c-border-strong)',
            borderRadius: 'var(--r-sm)',
            background: 'var(--c-panel)',
          }}
        >
          <div style={{ fontSize: 10, color: 'var(--c-text)', fontWeight: 600 }}>
            ⏱ 未来场景 · 已预计算，非实时预测
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'var(--c-status-warn-ink)',
            }}
          >
            未来 t = {Math.round(futureTimeS)} s（独立色标）
          </div>
        </div>
      )}

      {/* 无切片数据说明 —— 中性灰斜纹，不参与色标 */}
      <div className="legend__note">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span
            aria-hidden="true"
            style={{
              width: 18,
              height: 10,
              flex: 'none',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-sm)',
              background: NO_DATA_BG,
            }}
          />
          <span style={{ color: 'var(--c-text-2)' }}>{NO_DATA_LABEL}</span>
        </div>
        <div>
          灰斜纹 = 该区域无切片数据，<strong>不是 {min}℃</strong>
          ，不参与上方色标。{isSlice ? `${note}，读数精度受限。` : ''}
        </div>
        {observedMaxC !== undefined && (
          <div style={{ marginTop: 3 }}>
            本工况实测最高 {observedMaxC} ℃
            {topClamped ? (
              <span style={{ color: 'var(--c-status-warn-ink)' }}>
                {' '}
                （超出量化域上限 {max} ℃，该区间无法分辨）
              </span>
            ) : (
              <span style={{ color: 'var(--c-text-3)' }}> （在量化域内）</span>
            )}
          </div>
        )}
        {patchCount !== undefined && patchCount > 0 && (
          <div style={{ marginTop: 3 }}>
            本次渲染 {patchCount} 块 mesh 补丁（同坐标所有补丁须同时渲染）
          </div>
        )}
        {emptyNote && <div style={{ marginTop: 3 }}>{emptyNote}</div>}
        {mode === 'HIGH_CONTRAST' && (
          <div style={{ marginTop: 3, color: 'var(--c-text-2)' }}>
            高对比模式：色标刻意牺牲感知均匀性换取可分辨步长，
            <strong>与默认模式的颜色不可比较</strong>。精读/打印请用默认模式。
          </div>
        )}
        {(currentTimeS !== undefined || future) && (
          <div style={{ marginTop: 3 }}>
            颜色仅表示温度，不代表能见度、毒性或燃烧状态。
          </div>
        )}
      </div>
    </aside>
  );
}
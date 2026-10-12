/**
 * 底部状态栏（DESIGN_SYSTEM §4.9 / §6；UX_SPEC §1.4 / 附录 A）
 *
 * 承担三项常驻披露：
 *  1. 数据来源四类徽章（图形 + 文字 + 边框样式三重冗余，红线 D1/D2）
 *  2. 未接入项计数（数字必须由真实 store 数据推导，不许编造）
 *  3. **时间栅格不统一**（硬性规则 4）—— 标量 201 点 @≈9.01s 与切片 101 帧 @≈18s
 */

import { useMemo } from 'react';
import { useFireStore } from '../store/useFireStore';
import { describeQuantization } from '../utils/coords';
import { describeGrid, formatCount } from '../utils/format';

type BadgeKind = 'FDS' | 'SENSOR' | 'DEMO' | 'MISSING';

/**
 * 来源徽章（DESIGN_SYSTEM §4.9）
 * 每类有独立图形前缀 + 独立文字 + 独立边框样式 → 灰度截图下仍可区分（红线 D1）
 */
const BADGE_SPEC: Record<BadgeKind, { glyph: string; text: string; color: string; bg: string; border: string; style: 'solid' | 'dashed' | 'dotted' }> = {
  FDS: { glyph: '●', text: 'FDS SIMULATED', color: 'var(--c-src-fds)', bg: 'var(--c-src-fds-bg)', border: 'var(--c-src-fds)', style: 'solid' },
  SENSOR: { glyph: '▲', text: 'SENSOR', color: 'var(--c-text)', bg: 'var(--c-bg-sunken)', border: 'var(--c-text-3)', style: 'solid' },
  DEMO: { glyph: '◆', text: 'DEMO', color: 'var(--c-zone-lv)', bg: 'var(--c-zone-lv-weak)', border: 'var(--c-zone-lv)', style: 'dashed' },
  // 「未接入」是中性状态，不是错误 —— 禁止红色（红线 D2）
  MISSING: { glyph: '○', text: '未接入', color: 'var(--c-text-2)', bg: 'var(--c-bg-sunken)', border: 'var(--c-text-3)', style: 'dotted' },
};

export function SourceBadge({ kind }: { kind: BadgeKind }) {
  const s = BADGE_SPEC[kind];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 6px',
        borderRadius: 'var(--r-sm)',
        border: `1px ${s.style} ${s.border}`,
        background: s.bg,
        color: s.color,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{s.glyph}</span>
      {s.text}
    </span>
  );
}

export default function StatusBar() {
  const cabinets = useFireStore((s) => s.cabinets);
  const series = useFireStore((s) => s.series);
  const slices = useFireStore((s) => s.slices);
  const hrr = useFireStore((s) => s.hrr);
  const datasetStatus = useFireStore((s) => s.datasetStatus);
  const loadError = useFireStore((s) => s.loadError);
  const appMode = useFireStore((s) => s.appMode);
  const reconciliations = useFireStore((s) => s.assetReconciliations);

  const quant = slices[0] ? describeQuantization(slices[0]) : null;
  const sliceTimes = slices.length > 0 ? slices[0].frameTimesS : null;
  const seriesGrid = describeGrid(series?.timesS ?? null);
  const sliceGrid = describeGrid(sliceTimes);

  /**
   * 未接入项计数 —— 全部由真实数据推导：
   *  - 逐柜温度映射：10 个柜体全部无柜体↔热电偶映射
   *  - 传感器实时流：LIVE_SENSOR 未接入（appMode=MONITOR 时无数据）
   *  - HRR 曲线：V1 不提供（抽稀序列不得直接展示）
   */
  const notWired = useMemo(() => {
    const items: Array<{ label: string; detail: string }> = [];
    const unbound = cabinets.filter((c) => !c.envelopeVerified).length;
    items.push({
      label: '逐柜温度映射',
      detail: `${formatCount(unbound)}/${formatCount(cabinets.length)} 柜无柜体↔热电偶映射`,
    });
    if (appMode === 'MONITOR') {
      items.push({ label: '传感器实时流', detail: 'LIVE_SENSOR 未接入，监测模式无温度数据' });
    }
    if (hrr?.sampling !== 'FULL_RESOLUTION') items.push({
      label: 'HRR 曲线',
      detail: hrr?.sampling === 'FULL_RESOLUTION' ? '全分辨率曲线已接入' : '当前工况无全分辨率 HRR 数据',
    });
    return items;
  }, [cabinets, appMode, hrr]);

  return (
    <footer className="statusbar">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SourceBadge kind={series ? 'FDS' : 'MISSING'} />
        {appMode === 'MONITOR' && <SourceBadge kind="SENSOR" />}
      </div>

      {/* 时间栅格不统一 —— 硬性规则 4，必须常驻披露 */}
      <div title={`标量 ${series?.timesS.length ?? 0} 点线性插值，切片 ${quant?.frameCount ?? 0} 帧最近邻取样，两套时间栅格互不相同`}>
        标量 {seriesGrid}
        <br />
        切片 {sliceGrid}
      </div>
      {slices.length > 0 && (
        <div title="切片二进制为 8bit 量化，读数精度受限">
          {quant?.note} · 两栅格取样方式不同（标量线性插值 / 切片最近邻帧）
        </div>
      )}

      {/* 未接入项计数 */}
      <div>
        未接入 {formatCount(notWired.length)} 项：
        {notWired.map((n) => `${n.label}（${n.detail}）`).join('；')}
      </div>

      {loadError && (
        <div style={{ color: 'var(--c-status-alarm-ink)' }}>资产加载失败：{loadError}</div>
      )}
      {datasetStatus !== 'READY' && datasetStatus !== 'IDLE' && !loadError && (
        <div>当前工况结果状态：{datasetStatus}（不显示任何温度数值）</div>
      )}

      {/*
       * 资产层校正披露：scenarios.json 的可用性/标称值在索引层是过时的，
       * 已以 results/{id}/manifest.json（转换器实际产出）为准校正。
       * 这属于「两套资产来源不一致」，必须常驻可见，不能静默改写。
       */}
      {reconciliations.length > 0 &&
        reconciliations.map((r) => (
          <div key={r.scenarioId} style={{ color: 'var(--c-status-warn-ink)' }}>
            资产索引校正：{r.scenarioId} 在 scenarios.json 中标为 {r.declaredAvailability}
            {r.nominalPeakHRRKW.declared !== r.nominalPeakHRRKW.fromManifest && (
              <>
                （标称 {formatCount(r.nominalPeakHRRKW.declared)} kW）
              </>
            )}
            ，已按 results/{r.scenarioId}/manifest.json 校正为 {r.manifestStatus}
            {r.nominalPeakHRRKW.declared !== r.nominalPeakHRRKW.fromManifest && (
              <>（标称 {formatCount(r.nominalPeakHRRKW.fromManifest)} kW）</>
            )}
            {r.inputCorrection ? `；${r.inputCorrection}` : ''}
          </div>
        ))}

      <div className="statusbar__disclaimer">
        科研可视化用途 · 非工程消防报警系统 · 报警阈值为界面演示判据，非物理着火判据 ·
        不作为着火判据或工程结论
      </div>
    </footer>
  );
}
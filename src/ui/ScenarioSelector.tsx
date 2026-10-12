/**
 * 工况选择器（UX_SPEC §4.1 / §5 E-2 E-3；DESIGN_SYSTEM §4.2 / §4.13）
 *
 * 核心责任：
 *  - 柜体选择（10 个）+ 高压功率档位（40/70/100/140）
 *  - HRR 两行并列（①标称设定 / ②FDS 输出峰值）+ 只陈述比值
 *  - 三态：LOADING / ERROR(非READY) / READY
 *
 * 禁用判定**不硬编码**：从 store 的 scenarios 读 `availability !== 'READY'`
 * 即禁用，`blockedReason` 作原因文案 —— 这样源数据变更时 UI 自动跟随。
 *
 * 2026-10-08：HV-01-140MW 的源输入已修正（HRRPUA 5.6E6 → 5.6E5）并完成 V2 复算，
 * scenarios.json 中该工况已回到 READY，140MW 档位**可正常选中**，
 * 不再显示任何禁用提示或划线样式。
 */

import { useMemo } from 'react';
import { useFireStore } from '../store/useFireStore';
import {
  formatAsKW,
  formatAsMW,
  formatNumber,
  formatRatioPercent,
} from '../utils/format';

const HV_POWERS = [40, 70, 100, 140] as const;

export default function ScenarioSelector() {
  const cabinets = useFireStore((s) => s.cabinets);
  const scenarios = useFireStore((s) => s.scenarios);
  const selectedCabinetId = useFireStore((s) => s.selectedCabinetId);
  const selectedPowerMW = useFireStore((s) => s.selectedPowerMW);
  const activeScenarioId = useFireStore((s) => s.activeScenarioId);
  const datasetStatus = useFireStore((s) => s.datasetStatus);
  const datasetError = useFireStore((s) => s.datasetError);
  const loading = useFireStore((s) => s.loading);
  const loadError = useFireStore((s) => s.loadError);
  const hrrInterpretation = useFireStore((s) => s.hrrInterpretation);
  const hrr = useFireStore((s) => s.hrr);
  const provenance = useFireStore((s) => s.provenance);
  const selectCabinet = useFireStore((s) => s.selectCabinet);
  const selectPower = useFireStore((s) => s.selectPower);

  const selected = cabinets.find((c) => c.id === selectedCabinetId) ?? null;
  const isHv = selected?.zone === 'HIGH';

  const { hv, lv } = useMemo(() => {
    const h: typeof cabinets = [];
    const l: typeof cabinets = [];
    for (const c of cabinets) (c.zone === 'HIGH' ? h : l).push(c);
    return { hv: h, lv: l };
  }, [cabinets]);

  /** 某柜体某档位对应的工况；不存在则为 undefined */
  const scenarioFor = (cabinetId: string, power: number | null) =>
    scenarios.find(
      (s) =>
        s.cabinetId === cabinetId &&
        (s.zone === 'LOW' ? s.powerOptionMW === null : s.powerOptionMW === power),
    );

  /** 高压档位是否不可用（从 scenarios 的 availability 推导，不硬编码 id） */
  const hvOptionState = (cabinetId: string, mw: number) => {
    const s = scenarioFor(cabinetId, mw);
    if (!s) return { usable: false, reason: `柜体 ${cabinetId} 没有 ${mw}MW 工况`, scenario: null };
    if (s.availability !== 'READY') {
      return {
        usable: false,
        reason: s.blockedReason ?? `工况 ${s.id} 结果不可用（${s.availability}）`,
        scenario: s,
      };
    }
    return { usable: true, reason: null, scenario: s };
  };

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? null;
  const nominal = hrrInterpretation?.nominalPeakHRRKW ?? activeScenario?.nominalPeakHRRKW ?? null;
  const measured = hrrInterpretation?.measuredPeakHRRKW ?? hrr?.peakKW ?? null;
  const ratio =
    nominal !== null && measured !== null && nominal !== 0 ? measured / nominal : null;

  if (loading) {
    return (
      <section className="scenario-panel" aria-label="工况选择器" aria-busy="true">
        <h2 className="panel__title">工况</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spinner" aria-hidden="true" />
          <span style={{ fontSize: 12, color: 'var(--c-text-2)' }}>正在加载资产…</span>
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="scenario-panel" aria-label="工况选择器">
        <h2 className="panel__title">工况</h2>
        <div className="notice notice--warn">
          <strong>资产加载失败</strong>
          <br />
          未能读取工况目录（scenarios.json / cabinets.json）。
          <br />
          {loadError}
        </div>
      </section>
    );
  }

  if (cabinets.length === 0) {
    return (
      <section className="scenario-panel" aria-label="工况选择器">
        <h2 className="panel__title">工况</h2>
        <div className="notice notice--warn">未接入任何柜体数据，无法选择工况。</div>
      </section>
    );
  }

  return (
    <section className="scenario-panel" aria-label="工况选择器">
      <h2 className="panel__title">柜体选择</h2>
      <div className="scenario-list" role="radiogroup" aria-label="起火柜体">
        <ZoneGroup label="高压起火位置" cabinets={hv} selectedId={selectedCabinetId} onPick={(id) => void selectCabinet(id)} />
        <ZoneGroup label="低压起火位置" cabinets={lv} selectedId={selectedCabinetId} onPick={(id) => void selectCabinet(id)} />
      </div>

      {/* 高压功率档位 */}
      {isHv && selected && (
        <div className="device-card__section" style={{ marginTop: 14 }}>
          <h3 className="panel__title" style={{ margin: '0 0 6px' }}>
            高压功率档位
          </h3>
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}
            role="radiogroup"
            aria-label={`${selected.id} 高压功率档位`}
          >
            {HV_POWERS.map((mw) => {
              const st = hvOptionState(selected.id, mw);
              const isActive = selectedPowerMW === mw;
              const reasonId = `hv-${selected.id}-${mw}-reason`;
              return (
                <div key={mw}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-disabled={!st.usable}
                    disabled={!st.usable}
                    aria-describedby={!st.usable ? reasonId : undefined}
                    className={`btn btn--sm${isActive ? ' btn--primary' : ''}`}
                    style={{
                      width: '100%',
                      textDecoration: st.usable ? undefined : 'line-through',
                    }}
                    onClick={() => {
                      if (!st.usable) return;
                      void selectPower(mw);
                    }}
                    title={st.reason ?? `${selected.id} · ${mw} MW`}
                  >
                    {st.usable ? `${mw} MW` : `⊘ ${mw} MW（禁用）`}
                  </button>
                  {/* 禁用原因：常驻可见，不依赖 hover（保留可解释性，DESIGN_SYSTEM §4.2） */}
                  {!st.usable && (
                    <p
                      id={reasonId}
                      style={{
                        margin: '3px 0 0',
                        fontSize: 9.5,
                        lineHeight: 1.45,
                        color: 'var(--c-text-2)',
                        borderLeft: '2px solid var(--c-border-strong)',
                        paddingLeft: 5,
                      }}
                    >
                      {st.reason}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {selectedPowerMW === null && (
            <p style={{ margin: '6px 0 0', fontSize: 10.5, color: 'var(--c-text-2)' }}>
              请先选择功率档位。
            </p>
          )}
        </div>
      )}

      {/* 当前工况确认条 */}
      <div className="device-card__section" style={{ marginTop: 14 }}>
        <h3 className="panel__title" style={{ margin: '0 0 6px' }}>
          当前工况
        </h3>

        {datasetStatus === 'LOADING' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" aria-hidden="true" />
            <span style={{ fontSize: 11.5, color: 'var(--c-text-2)' }}>
              正在加载 FDS 结果…
            </span>
          </div>
        )}

        {datasetStatus === 'INVALID_SOURCE' && (
          <div className="notice notice--alarm">
            <strong>⊘ 工况不可用</strong>
            <br />
            {datasetError ?? activeScenario?.blockedReason ?? '源输入无效。'}
          </div>
        )}

        {datasetStatus === 'MISSING_OUTPUT' && (
          <div className="notice notice--warn">
            <strong>该工况暂无温度结果</strong>
            <br />
            工况 {activeScenarioId ?? selected?.id ?? '—'} 的 FDS
            输出文件尚未接入，因此不显示任何温度数值或热场。
            <br />
            <strong>界面不会用演示值代替真实结果。</strong>
            {datasetError ? (
              <>
                <br />
                {datasetError}
              </>
            ) : null}
          </div>
        )}

        {datasetStatus === 'CONVERSION_ERROR' && (
          <div className="notice notice--warn">
            <strong>温度结果加载失败</strong>
            <br />
            {datasetError ?? '结果转换出错，已停止渲染以避免显示错误热场。'}
          </div>
        )}

        {datasetStatus === 'READY' && activeScenario && (
          <>
            <div className="kv" style={{ marginTop: 0 }}>
              <span className="kv__k">工况</span>
              <span className="kv__v">{activeScenario.id}</span>
              <span className="kv__k">区域</span>
              <span className="kv__v">{isHv ? '高压' : '低压'}</span>
              <span className="kv__k">输入文件</span>
              <span className="kv__v">{activeScenario.inputFile}</span>
              <span className="kv__k">有效性</span>
              <span className="kv__v">
                <span className="badge badge--normal">{activeScenario.availability}</span>
              </span>
              <span className="kv__k">数据来源</span>
              <span className="kv__v">
                {provenance ? (
                  <span
                    className="badge"
                    style={{
                      background:
                        provenance.origin === 'V2_HANDBOX_RECALC'
                          ? 'var(--c-zone-hv-weak)'
                          : 'var(--c-bg-sunken)',
                      color:
                        provenance.origin === 'V2_HANDBOX_RECALC'
                          ? 'var(--c-zone-hv)'
                          : 'var(--c-text-2)',
                      border: `1px ${
                        provenance.origin === 'V2_HANDBOX_RECALC' ? 'solid' : 'dotted'
                      } ${
                        provenance.origin === 'V2_HANDBOX_RECALC'
                          ? 'var(--c-zone-hv)'
                          : 'var(--c-text-3)'
                      }`,
                      borderRadius: 'var(--r-sm)',
                      padding: '0 5px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                    }}
                    title={
                      provenance.sourceFdsSha256
                        ? `源 .fds SHA-256 ${provenance.sourceFdsSha256}`
                        : 'manifest 未提供源文件校验值'
                    }
                  >
                    {provenance.origin === 'V2_HANDBOX_RECALC' ? '已修正·V2 复算' : '用户本地运行'}
                  </span>
                ) : (
                  <span style={{ color: 'var(--c-text-3)' }}>来源未标注</span>
                )}
              </span>
            </div>

            {/* 来源校验状态：源输入被修正过的工况必须显式说明，不静默替换 */}
            {provenance?.inputCorrection && (
              <div
                style={{
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: '1px solid var(--c-divider)',
                  fontSize: 9.5,
                  lineHeight: 1.55,
                  color: 'var(--c-text-2)',
                }}
              >
                输入修正：<strong>{provenance.inputCorrection}</strong>
                {provenance.fdsCompletedSuccessfully !== undefined && (
                  <span style={{ color: 'var(--c-text-3)' }}>
                    {' '}
                    ·{' '}
                    {provenance.fdsCompletedSuccessfully
                      ? '复算运行正常结束（.out 尾部含 STOP: FDS completed successfully）'
                      : '复算运行结束状态未确认'}
                  </span>
                )}
              </div>
            )}

            {/* HRR 两行 —— 等宽、同字号、无主次分层（DESIGN_SYSTEM §4.13） */}
            {(nominal !== null || measured !== null) && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    minHeight: 28,
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--c-text-3)' }}>标称设定†</span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'baseline',
                      gap: 6,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: 'var(--c-text-2)',
                    }}
                  >
                    {formatAsMW((nominal ?? 0) / 1000, 0)}
                    <span className="chip__tag">FDS 输入</span>
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    minHeight: 28,
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--c-text-3)' }}>
                    FDS 输出峰值
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'baseline',
                      gap: 6,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: 'var(--c-text)',
                    }}
                  >
                    {formatAsKW(measured)}
                    <span className="badge badge--fds">FDS SIMULATED</span>
                  </span>
                </div>

                {ratio !== null && (
                  <div
                    style={{
                      marginTop: 6,
                      paddingTop: 6,
                      borderTop: '1px solid var(--c-divider)',
                      fontSize: 10.5,
                      color: 'var(--c-status-warn-ink)',
                    }}
                  >
                    输出/设定 = {formatRatioPercent(ratio)}
                    <span style={{ color: 'var(--c-text-3)' }}>
                      {' '}
                      · 两者为不同物理量，差异原因未核验
                    </span>
                  </div>
                )}

                <p
                  style={{
                    margin: '6px 0 0',
                    fontSize: 9.5,
                    lineHeight: 1.5,
                    color: 'var(--c-text-3)',
                  }}
                >
                  † 标称为 FDS 输入参数（HRRPUA × 0.25 m²，源文件实测与标称精确吻合）；
                  输出峰值为 *_hrr.csv 全序列最大值。两者性质不同、无主次，
                  界面只陈述数值与比值，不推断成因。
                </p>
              </div>
            )}

            <p
              style={{
                margin: '8px 0 0',
                fontSize: 9.5,
                color: 'var(--c-text-3)',
                lineHeight: 1.5,
              }}
            >
              数据帧 0–{formatNumber(activeScenario.tEndS, 0)} s ·{' '}
              {activeScenario.outputFound.hrr ? 'HRR 已接入' : 'HRR 未接入'} ·{' '}
              {activeScenario.outputFound.smv ? '切片已接入' : '切片未接入'}
            </p>
          </>
        )}

        {datasetStatus === 'IDLE' && (
          <div className="notice notice--info">
            未激活工况。{isHv ? '请选择功率档位' : '请选择柜体'}。
          </div>
        )}
      </div>
    </section>
  );
}

function ZoneGroup({
  label,
  cabinets,
  selectedId,
  onPick,
}: {
  label: string;
  cabinets: Array<{ id: string; zone: 'HIGH' | 'LOW' }>;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  if (cabinets.length === 0) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          fontSize: 9.5,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--c-text-3)',
          padding: '4px 9px 2px',
        }}
      >
        {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        {cabinets.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selectedId === c.id}
            className={`scenario-item${selectedId === c.id ? ' is-active' : ''}`}
            style={{ padding: '5px 7px' }}
            onClick={() => onPick(c.id)}
            aria-label={`选择柜体 ${c.id}`}
          >
            <span className="scenario-item__id">{c.id}</span>
            <span
              className={`badge ${c.zone === 'HIGH' ? 'badge--hv' : 'badge--lv'}`}
              style={{ fontSize: 9 }}
            >
              {c.zone === 'HIGH' ? 'HV' : 'LV'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
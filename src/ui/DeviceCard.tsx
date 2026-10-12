/**
 * 设备信息卡（UX_SPEC §4.4；DESIGN_SYSTEM §4.4 / §4.13）
 *
 * 本组件承载全部 7 条硬性数据真实性规则中最敏感的部分：
 *  1. **不存在逐柜温度** → 第一行永远是「逐柜温度：未绑定」，
 *     绝不留白、绝不填 28℃、绝不用全域最大值顶替。
 *  2. 温度区标题必须写「起火柜区域温度」，**绝不能出现「柜体温度」字样**，
 *     且必须同屏呈现 `series.sensorScopeNote`。
 *  3. HRR 三量并列（①标称设定 / ②输出峰值 / ③界面展示值），
 *     **禁止任何方向的因果解释**，禁止进度条/达成率表达。
 *  4. 取值不诚实时（越界/无读数）显示 `—` + 原因，禁止填 0 或 20℃。
 *  5. 热电偶热点标题必须含「热电偶」与「非柜体」。
 *  6. 所有数值必须带来源徽章。
 *  7. 柜体外壳未核验必须标注。
 */

import { useCallback } from 'react';
import {
  DEFAULT_THRESHOLDS,
  effectiveTime,
  useFireStore,
} from '../store/useFireStore';
import { queryCabinetTemperature } from '../data/scenarioProvider';
import { classifyTemperature } from '../utils/coords';
import {
  EM_DASH,
  formatAsKW,
  formatKW,
  formatM,
  formatNumber,
  formatRatioPercent,
  formatSeconds,
  formatTempWithUnit,
} from '../utils/format';
import { SourceBadge } from './StatusBar';

export default function DeviceCard() {
  const selectedCabinetId = useFireStore((s) => s.selectedCabinetId);
  const cabinets = useFireStore((s) => s.cabinets);
  const scenarios = useFireStore((s) => s.scenarios);
  const activeScenarioId = useFireStore((s) => s.activeScenarioId);
  const series = useFireStore((s) => s.series);
  const hrr = useFireStore((s) => s.hrr);
  const hrrInterpretation = useFireStore((s) => s.hrrInterpretation);
  const currentTimeS = useFireStore((s) => s.currentTimeS);
  const futureOffsetS = useFireStore((s) => s.futureOffsetS);
  const datasetStatus = useFireStore((s) => s.datasetStatus);
  const alarmState = useFireStore((s) => s.alarmState);
  const playback = useFireStore((s) => s.playback);
  const thresholds = useFireStore((s) => s.thresholds);
  const selectCabinet = useFireStore((s) => s.selectCabinet);
  const setPlayback = useFireStore((s) => s.setPlayback);
  const manualTriggerAlarm = useFireStore((s) => s.manualTriggerAlarm);

  const handlePlay = useCallback(() => {
    setPlayback(playback === 'PLAYING' ? 'PAUSED' : 'PLAYING');
  }, [playback, setPlayback]);

  if (!selectedCabinetId) return null;

  const cabinet = cabinets.find((c) => c.id === selectedCabinetId);
  if (!cabinet) return null;

  const scenario = scenarios.find((s) => s.id === activeScenarioId) ?? null;
  const t = effectiveTime({ currentTimeS, futureOffsetS });
  const query = queryCabinetTemperature(series, t);
  const level = classifyTemperature(
    query.valueC,
    cabinet.zone === 'HIGH' ? thresholds.highZoneWarningC : thresholds.warningC,
    cabinet.zone === 'HIGH' ? thresholds.highZoneAlarmC : thresholds.alarmC,
  );

  const isHv = cabinet.zone === 'HIGH';
  const warnC = isHv ? thresholds.highZoneWarningC : thresholds.warningC;
  const alarmC = isHv ? thresholds.highZoneAlarmC : thresholds.alarmC;

  // HRR 三量
  const nominal = hrrInterpretation?.nominalPeakHRRKW ?? scenario?.nominalPeakHRRKW ?? null;
  const measured = hrrInterpretation?.measuredPeakHRRKW ?? hrr?.peakKW ?? null;
  const measuredAt = hrrInterpretation?.measuredPeakTimeS ?? hrr?.peakTimeS ?? null;
  const displayed = hrr?.peakKW ?? null;
  const ratio = nominal !== null && measured !== null && nominal !== 0 ? measured / nominal : null;

  const noData = datasetStatus !== 'READY' || series === null;

  return (
    <aside className="device-card" aria-label={`设备信息卡 ${cabinet.id}`}>
      <button
        type="button"
        className="device-card__close"
        onClick={() => void selectCabinet(null)}
        aria-label={`关闭 ${cabinet.id} 设备卡`}
      >
        ✕
      </button>

      {/* 头 */}
      <h2 className="device-card__id">{cabinet.id}</h2>
      <div className="device-card__sub">
        {isHv ? '高压' : '低压'} · 起火工况设备 ·{' '}
        <span className={`badge ${isHv ? 'badge--hv' : 'badge--lv'}`}>
          {isHv ? 'HIGH' : 'LOW'}
        </span>
      </div>

      {/* 逐柜温度 —— 永远第一行，未绑定就是「未绑定」 */}
      <div className="device-card__section">
        <div className="panel__title" style={{ margin: '0 0 6px' }}>
          柜体温度
        </div>
        <div className="notice notice--info">
          <strong>温度未绑定</strong>
          <br />
          未提供柜体↔热电偶映射，无法给出单个柜体的温度。
          <br />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
            mapping_status: {cabinet.sensorMappingStatus}
          </span>
        </div>
      </div>

      {/* 起火柜区域温度 —— 禁止写「柜体温度」 */}
      <div className="device-card__section">
        <div
          className="panel__title"
          style={{ margin: '0 0 6px', display: 'flex', justifyContent: 'space-between' }}
        >
          <span>起火柜区域温度</span>
          {query.valueC === null ? (
            <SourceBadge kind="MISSING" />
          ) : (
            <SourceBadge kind="FDS" />
          )}
        </div>

        {noData ? (
          <>
            <div className="temp-readout">
              <span className="temp-readout__value temp-readout__value--none">{EM_DASH}</span>
              <span className="temp-readout__unit">℃</span>
            </div>
            <div className="notice notice--warn">
              该工况暂无温度结果（{datasetStatus}）。界面不会用演示值代替真实结果。
            </div>
          </>
        ) : (
          <>
            <div className="temp-readout">
              <span
                className={`temp-readout__value${
                  query.valueC === null ? ' temp-readout__value--none' : ''
                }`}
              >
                {query.valueC === null ? EM_DASH : formatNumber(query.valueC, 1)}
              </span>
              <span className="temp-readout__unit">℃</span>
            </div>
            <div className="kv" style={{ marginTop: 4 }}>
              <span className="kv__k">数据时刻</span>
              <span className="kv__v">
                t={formatSeconds(t)}
                {query.interpolation === 'LINEAR_WITHIN_SCENARIO' && (
                  <span style={{ color: 'var(--c-text-3)' }}>（同工况内线性插值）</span>
                )}
                {query.interpolation === 'EXACT' && (
                  <span style={{ color: 'var(--c-text-3)' }}>（真实采样点）</span>
                )}
              </span>
            </div>

            {/* 取值不可用时必须说明原因，禁止填 0 / 20℃ */}
            {query.valueC === null && (
              <div className="notice notice--warn">
                {query.interpolation === 'OUT_OF_RANGE'
                  ? `t=${formatSeconds(t)} 超出该工况时间范围 0–1800 s，无可用采样点。`
                  : '该时刻无有效热电偶读数（序列中存在空值）。'}
                <br />
                界面<strong>不填 0、不填 20℃ 假装正常</strong>。
              </div>
            )}

            {/* 测点作用域 —— 必须同屏呈现（硬性规则 1） */}
            <div
              className="notice notice--info"
              style={{ marginTop: 8, fontSize: 11 }}
            >
              <strong>测点作用域</strong>
              <br />
              {series?.sensorScopeNote ?? '未接入温度数据'}
              <br />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                聚合 {series?.aggregation} · {series?.sensorCount} 支热电偶
              </span>
              {series?.sensorEnvelopeFdsM && (
                <>
                  <br />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    包络 XB [{series.sensorEnvelopeFdsM.map((v) => formatM(v)).join(', ')}] m
                  </span>
                </>
              )}
            </div>
          </>
        )}

        {/* 报警状态行 */}
        {level !== 'NORMAL' && level !== 'UNKNOWN' && (
          <div
            className={`notice ${level === 'FIRE_ALARM' ? 'notice--alarm' : 'notice--warn'}`}
            style={{ marginTop: 8 }}
          >
            {level === 'FIRE_ALARM' ? '⛔' : '⚠'}{' '}
            {level === 'FIRE_ALARM' ? '火灾报警' : '高温预警'} · 起火柜区域温度{' '}
            {formatTempWithUnit(query.valueC)} {level === 'FIRE_ALARM' ? '≥' : '≥'}{' '}
            {level === 'FIRE_ALARM' ? alarmC : warnC} ℃（界面阈值）
          </div>
        )}
        {alarmState === 'FIRE_ALARM' && alarmC === DEFAULT_THRESHOLDS.alarmC && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--c-text-3)' }}>
            报警阈值为界面演示默认值（低压 {DEFAULT_THRESHOLDS.warningC}/
            {DEFAULT_THRESHOLDS.alarmC}℃），非物理着火判据。
          </div>
        )}
      </div>

      {/* 起火面几何 */}
      <div className="device-card__section">
        <div className="panel__title" style={{ margin: '0 0 6px' }}>
          起火面几何（FDS 坐标）
        </div>
        <div className="kv">
          <span className="kv__k">x</span>
          <span className="kv__v">{formatM(cabinet.burnerCenterFdsM[0])} m</span>
          <span className="kv__k">y</span>
          <span className="kv__v">{formatM(cabinet.burnerCenterFdsM[1])} m</span>
          <span className="kv__k">z</span>
          <span className="kv__v">{formatM(cabinet.burnerCenterFdsM[2])} m</span>
          <span className="kv__k">sourceChid</span>
          <span className="kv__v">{cabinet.sourceChid}</span>
          <span className="kv__k">柜体外壳</span>
          <span className="kv__v">
            {cabinet.envelopeVerified ? '已核验' : '未核验'}
          </span>
        </div>
        {!cabinet.envelopeVerified && (
          <div className="notice notice--info" style={{ marginTop: 6 }}>
            ⓘ 该坐标为 <code>VENT SURF_ID=&apos;burner&apos;</code> 的
            <strong>火源面中心</strong>，<strong>非柜体外壳</strong>。
            外壳状态：<code>{cabinet.envelopeStatus}</code>
          </div>
        )}
      </div>

      {/* HRR 三量并列 —— 禁止任何因果解释 */}
      <div className="device-card__section">
        <div className="panel__title" style={{ margin: '0 0 6px' }}>
          火源功率（HRR）
        </div>
        {noData || (nominal === null && measured === null) ? (
          <div className="notice notice--warn">该工况 HRR 数据未接入。</div>
        ) : (
          <>
            {/* ① 标称设定 —— FDS 输入参数 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                minHeight: 28,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--c-text-3)' }}>
                标称设定†
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 14,
                  color: 'var(--c-text-2)',
                }}
              >
                {formatKW(nominal)}
              </span>
            </div>

            {/* ② FDS 输出峰值 —— 计算结果 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                minHeight: 28,
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--c-text-3)' }}>
                FDS 输出峰值
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 14,
                  color: 'var(--c-text)',
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 6,
                }}
              >
                {formatAsKW(measured)}
              </span>
            </div>

            {/* ③ 界面展示值 —— 与②同源 */}
            {displayed !== null && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 8,
                  minHeight: 28,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--c-text-3)' }}>
                  界面展示值
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    color: 'var(--c-text)',
                  }}
                >
                  {formatAsKW(displayed)}
                </span>
              </div>
            )}

            {/* 比值 —— 只陈述数值，不给因果 */}
            {ratio !== null && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: '1px solid var(--c-divider)',
                  fontSize: 11,
                  color: 'var(--c-status-warn-ink)',
                }}
              >
                输出/设定 = {formatRatioPercent(ratio)}
                <span style={{ color: 'var(--c-text-3)' }}>
                  {' '}
                  · 两者为不同性质的量（输入参数 / 计算结果），差异成因属未完成的建模核查项，界面不推断
                </span>
              </div>
            )}

            <div
              style={{
                marginTop: 6,
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <SourceBadge kind="FDS" />
              <span style={{ fontSize: 9.5, color: 'var(--c-text-3)' }}>
                † 标称设定 = 源 FDS HRRPUA × 火源面面积（输入参数）；输出峰值来自{' '}
                {hrr?.sourceFile ?? '*_hrr.csv'} 全序列最大值
                {measuredAt !== null ? `，t=${formatSeconds(measuredAt)}` : ''}。
              </span>
            </div>
            {hrr?.sampling && (
              <div style={{ marginTop: 4, fontSize: 9.5, color: 'var(--c-text-3)' }}>
                采样：{hrr.sampling} · {hrr.frameCount} 帧 · 抽稀序列不直接绘制，仅显示上列峰值标量
              </div>
            )}
          </>
        )}
      </div>

      {/* 工况 */}
      <div className="device-card__section">
        <div className="panel__title" style={{ margin: '0 0 6px' }}>
          工况
        </div>
        {scenario ? (
          <div className="kv">
            <span className="kv__k">工况 id</span>
            <span className="kv__v">{scenario.id}</span>
            <span className="kv__k">输入文件</span>
            <span className="kv__v">{scenario.inputFile}</span>
            <span className="kv__k">时间覆盖</span>
            <span className="kv__v">0 – {formatNumber(scenario.tEndS, 0)} s</span>
            <span className="kv__k">有效性</span>
            <span className="kv__v">
              <span
                className={`badge ${
                  scenario.availability === 'READY'
                    ? 'badge--normal'
                    : scenario.availability === 'INVALID_SOURCE'
                      ? 'badge--alarm'
                      : 'badge--muted'
                }`}
              >
                {scenario.availability}
              </span>
            </span>
          </div>
        ) : (
          <div className="notice notice--warn">
            未激活任何工况（{datasetStatus}）。
            {datasetStatus === 'MISSING_OUTPUT' && '该工况的 FDS 输出文件尚未接入。'}
          </div>
        )}
      </div>

      {/* 热电偶热点 —— 标题必须含「热电偶」与「非柜体」 */}
      {series && series.spatialMax.length > 0 && (
        <div className="device-card__section">
          <div className="panel__title" style={{ margin: '0 0 6px' }}>
            热电偶热点 TOP{series.spatialMax.length}（非柜体温度）
          </div>
          <div style={{ maxHeight: 130, overflowY: 'auto' }}>
            {series.spatialMax.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  padding: '1px 0',
                }}
              >
                <span>{t.id}</span>
                <span style={{ color: 'var(--c-text-3)' }}>
                  峰值 {formatNumber(t.maxC, 1)}℃ · 终值{' '}
                  {t.finalC === null ? EM_DASH : formatNumber(t.finalC, 1)}℃
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--c-text-3)' }}>
            ⓘ 热电偶编号 ≠ 柜体编号。这是本工况全部热电偶的空间分布峰值，
            <strong>不可据此判断任一柜体的温度</strong>。
          </div>
        </div>
      )}

      {/* 动作 */}
      <div className="device-card__section" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={handlePlay}
          disabled={noData}
          aria-label={playback === 'PLAYING' ? '暂停本工况回放' : '播放本工况'}
        >
          {playback === 'PLAYING' ? '⏸ 暂停' : '▶ 播放此工况'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={manualTriggerAlarm}
          aria-label="界面演示触发火警，非 FDS 计算结果"
        >
          ◎ 演示触发火警
          <span className="badge badge--muted">仅界面演示</span>
        </button>
      </div>
    </aside>
  );
}

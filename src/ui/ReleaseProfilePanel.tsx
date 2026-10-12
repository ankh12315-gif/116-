/**
 * 释热剖面面板（release_profile.json 实读）
 *
 * ⚠️ **措辞纪律（硬约束，违反即验收失败）**
 *
 * 本面板只做**两套独立来源的事实并列陈述**：
 *  - `设计意图窗口 0–1 s`     ← 源 FDS 的 DEVC `TIMER->OUT` SETPOINT=1.0（输入参数）
 *  - `实测峰值 t=3.60 s`     ← *_hrr.csv 计算结果
 *  - `实测 2% 点 t=9.01 s`    ← *_hrr.csv 计算结果
 *
 * **禁止**的表述（均为结论或推断，不是数据）：
 *  - ❌「实际释热持续 7 秒与设计不符」
 *  - ❌「HRR 峰值滞后源于输运延迟」
 *  - ❌ 用「输入已修正」解释 10× 幅度差
 *
 * 允许：陈述数值 + 比值 + 来源徽章 + 采样口径。
 *
 * 所有数值**每次都从 release_profile.json 读取**（由 provider 加载进 store），
 * 本文件不硬编码任何峰值、时刻或积分值。
 */

import { useMemo } from 'react';
import { useFireStore } from '../store/useFireStore';
import { RELEASE_COMMAND_WINDOW } from '../types/domain';
import type { ReleasePhase } from '../types/domain';
import { formatNumber, formatSeconds } from '../utils/format';

/** 2% 阈值口径（用于「峰后耗时」）。与 release_profile.json 的 decay.decay02 对应 */
const DECAY_FRACTION = 0.02;

export default function ReleaseProfilePanel({ showCurve = true }: { showCurve?: boolean }) {
  const profile = useFireStore((s) => s.releaseProfile);
  const hrr = useFireStore((s) => s.hrr);
  const provenance = useFireStore((s) => s.provenance);
  const currentTimeS = useFireStore((s) => s.currentTimeS);

  const decay02 = profile?.decay.decay02 ?? null;

  /**
   * 两个时间阶段。**这不是「设计 vs 实际」的对比结论**，
   * 而是把「输入参数决定的窗口」与「输出序列的时刻」分别标出。
   */
  const phases = useMemo<ReleasePhase[]>(() => {
    if (!profile) return [];
    const out: ReleasePhase[] = [
      {
        id: 'RELEASE_COMMAND_WINDOW',
        label: '设计意图窗口',
        startS: RELEASE_COMMAND_WINDOW.startS,
        endS: RELEASE_COMMAND_WINDOW.endS,
        basis: `源 FDS 的 DEVC ${RELEASE_COMMAND_WINDOW.devcId}，SETPOINT=${RELEASE_COMMAND_WINDOW.setpoint}（输入参数，非实测）`,
      },
    ];
    if (decay02 && decay02.reached) {
      out.push({
        id: 'POST_RELEASE_TRANSPORT',
        label: '后续热输运时段',
        startS: RELEASE_COMMAND_WINDOW.endS,
        endS: decay02.lastAboveTimeS,
        basis: `HRR 输出序列中最后一个 > 峰值×${DECAY_FRACTION * 100}%（${formatNumber(decay02.thresholdKW, 2)} kW）的采样时刻（实测）`,
      });
    }
    return out;
  }, [profile, decay02]);

  if (!profile) return null;

  const peakKW = profile.peakKW;
  const peakTimeS = profile.peakTimeS;
  const lastAbove = decay02?.lastAboveTimeS ?? null;
  /**
   * 口径 B：峰后耗时 = 2% 绝对时刻 − 峰值时刻。
   * 恒等式：口径B ≡ 口径A − 峰值时刻（三者都由同一份 hrr.json 导出）。
   */
  const postPeakS = lastAbove !== null ? lastAbove - peakTimeS : null;

  return (
    <section className="panel" aria-label="释热剖面（实测）" style={{ padding: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <h2 className="panel__title" style={{ margin: 0 }}>
          释热剖面
        </h2>
        <span className="badge badge--fds">FDS SIMULATED</span>
      </div>

      {/* 数值事实：等宽、同字号、无主次分层 */}
      <div className="kv" style={{ marginTop: 0 }}>
        <span className="kv__k">峰值 HRR</span>
        <span className="kv__v">
          {formatNumber(peakKW, 2)} kW
          <span className="chip__tag"> @ t={formatNumber(peakTimeS, 2)} s</span>
        </span>
        <span className="kv__k">2% 阈值</span>
        <span className="kv__v">{formatNumber(decay02?.thresholdKW ?? null, 2)} kW</span>
        <span className="kv__k">末个高于2%采样</span>
        <span className="kv__v">
          {lastAbove !== null ? formatSeconds(lastAbove, 2) : '—'}
          {postPeakS !== null && (
            <span className="chip__tag"> 峰后 {formatNumber(postPeakS, 2)} s</span>
          )}
        </span>
        <span className="kv__k">下降沿首个越阈</span>
        <span className="kv__v">{formatSeconds(decay02?.downCrossTimeS ?? null, 2)}
          {decay02?.downCrossTimeS != null && <span className="chip__tag"> 峰后 {formatNumber(decay02.downCrossTimeS - peakTimeS, 2)} s</span>}
        </span>
        <span className="kv__k">累计释热</span>
        <span className="kv__v">{formatNumber(profile.integratedHeatReleaseMJ, 2)} MJ</span>
      </div>

      {/* 两个阶段：来源不同、并列陈述，不作对比结论 */}
      <div style={{ marginTop: 8 }}>
        <div className="panel__title" style={{ margin: '0 0 4px', fontSize: 10 }}>
          时间轴阶段划分
        </div>
        {phases.map((p) => (
          <div
            key={p.id}
            style={{
              fontSize: 10,
              lineHeight: 1.5,
              color: 'var(--c-text-2)',
              paddingLeft: 5,
              borderLeft: `2px solid ${p.id === 'RELEASE_COMMAND_WINDOW' ? 'var(--c-accent)' : 'var(--c-border-strong)'}`,
              marginBottom: 3,
            }}
          >
            <strong style={{ color: 'var(--c-text)' }}>
              {p.label} {formatNumber(p.startS, 1)}–{formatNumber(p.endS, 2)} s
            </strong>
            <div style={{ color: 'var(--c-text-3)' }}>{p.basis}</div>
          </div>
        ))}
      </div>

      {/* 真实 HRR 曲线（全分辨率 hrr.json，非抽稀） */}
      {showCurve && hrr && hrr.sampling === 'FULL_RESOLUTION' && hrr.hrrKW.length > 1 && (
        <div style={{ marginTop: 8 }}>
          <div className="panel__title" style={{ margin: '0 0 4px', fontSize: 10 }}>
            HRR 曲线（全分辨率）
          </div>
          <HrrCurve
            times={hrr.timesS}
            values={hrr.hrrKW}
            peakKW={peakKW}
            peakTimeS={peakTimeS}
            thresholdKW={decay02?.thresholdKW ?? null}
            currentTimeS={currentTimeS}
          />
        </div>
      )}

      {/* 采样口径披露（不均匀采样，禁止等间隔插值） */}
      <p
        style={{
          margin: '6px 0 0',
          fontSize: 9.5,
          lineHeight: 1.5,
          color: 'var(--c-text-3)',
        }}
      >
        采样 {formatNumber(profile.sampling.distinctDtCount, 0)} 个不同间隔
        （{formatNumber(profile.sampling.dtMinS, 3)}–{formatNumber(profile.sampling.dtMaxS, 4)} s，
        变异系数 {formatNumber(profile.sampling.dtCoefficientOfVariation, 4)}）·
        积分方法 {profile.integration.method}，与矩形法极差{' '}
        {formatNumber(profile.integration.methodSpreadKJ, 2)} kJ
      </p>

      <p
        style={{
          margin: '5px 0 0',
          fontSize: 9.5,
          lineHeight: 1.5,
          color: 'var(--c-text-3)',
        }}
      >
        本面板数值全部由 *_hrr.csv 直接算出，仅陈述事实与采样口径，
        <strong>不含成因推断</strong>。
      </p>

      {/* 来源徽章：源输入被修正并复算的工况必须可识别 */}
      {provenance && <ProvenanceRow provenance={provenance} />}
    </section>
  );
}

function HrrCurve({
  times,
  values,
  peakKW,
  peakTimeS,
  thresholdKW,
  currentTimeS,
}: {
  times: number[];
  values: number[];
  peakKW: number;
  peakTimeS: number;
  thresholdKW: number | null;
  currentTimeS: number;
}) {
  const W = 248;
  const H = 66;
  const PAD_L = 30;
  const PAD_B = 12;
  const PAD_T = 4;

  const { path, peakXY, threshY, cursorX, tMax } = useMemo(() => {
    const tMaxLocal = times[times.length - 1] || 1;
    const vMax = Math.max(...values, thresholdKW ?? 0) * 1.08 || 1;
    const px = (t: number) => PAD_L + (t / tMaxLocal) * (W - PAD_L - 2);
    const py = (v: number) => H - PAD_B - (v / vMax) * (H - PAD_B - PAD_T);
    let d = '';
    // 1001 点全画：路径本身足够密，不需要再抽稀
    for (let i = 0; i < times.length; i++) {
      d += `${i === 0 ? 'M' : 'L'}${px(times[i]).toFixed(2)},${py(values[i]).toFixed(2)}`;
    }
    return {
      path: d,
      peakXY: { x: px(peakTimeS), y: py(peakKW) },
      threshY: thresholdKW !== null ? py(thresholdKW) : null,
      cursorX: px(Math.max(0, Math.min(currentTimeS, tMaxLocal))),
      tMax: tMaxLocal,
    };
  }, [times, values, peakKW, peakTimeS, thresholdKW, currentTimeS]);

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`HRR 曲线，峰值 ${formatNumber(peakKW, 2)} kW 出现在 ${formatNumber(peakTimeS, 2)} 秒`}
      style={{ display: 'block', maxWidth: '100%' }}
    >
      {/* 2% 阈值参考线（虚线 = 参考，非实测事件） */}
      {threshY !== null && (
        <line
          x1={PAD_L}
          x2={W - 2}
          y1={threshY}
          y2={threshY}
          stroke="var(--c-border-strong)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}
      {/* 轴 */}
      <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={H - PAD_B} stroke="var(--c-border)" strokeWidth={1} />
      <line x1={PAD_L} x2={W - 2} y1={H - PAD_B} y2={H - PAD_B} stroke="var(--c-border)" strokeWidth={1} />
      {/* 峰值后的早期释热段用暖色，曲线本身是实测值 */}
      <path d={path} fill="none" stroke="var(--c-accent)" strokeWidth={1.2} strokeLinejoin="round" />
      {/* 峰值标记 */}
      <circle cx={peakXY.x} cy={peakXY.y} r={2.2} fill="var(--c-status-alarm)" />
      {/* 当前时刻游标 */}
      <line
        x1={cursorX}
        x2={cursorX}
        y1={PAD_T}
        y2={H - PAD_B}
        stroke="var(--c-text-3)"
        strokeWidth={1}
      />
      <text x={2} y={PAD_T + 7} fontSize={7} fill="var(--c-text-3)" fontFamily="var(--font-mono)">
        {formatNumber(peakKW / 1000, 1)}
      </text>
      <text x={2} y={H - PAD_B + 3} fontSize={7} fill="var(--c-text-3)" fontFamily="var(--font-mono)">
        0
      </text>
      <text x={PAD_L} y={H - 2} fontSize={7} fill="var(--c-text-3)" fontFamily="var(--font-mono)">
        0s
      </text>
      <text x={W - 2} y={H - 2} fontSize={7} fill="var(--c-text-3)" fontFamily="var(--font-mono)" textAnchor="end">
        {formatNumber(tMax, 0)}s
      </text>
      <text x={PAD_L + 2} y={PAD_T + 8} fontSize={7} fill="var(--c-text-3)" fontFamily="var(--font-mono)">
        MW
      </text>
    </svg>
  );
}

/** 来源与校验状态徽章（DESIGN_SYSTEM §4.9 数据来源标签） */
function ProvenanceRow({ provenance }: { provenance: NonNullable<ReturnType<typeof useFireStore.getState>['provenance']> }) {
  const isRecalc = provenance.origin === 'V2_HANDBOX_RECALC';
  const sha = provenance.sourceFdsSha256 ?? '';
  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 6,
        borderTop: '1px solid var(--c-divider)',
        fontSize: 9.5,
        lineHeight: 1.55,
        color: 'var(--c-text-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, flexWrap: 'wrap' }}>
        <span
          className="badge"
          style={{
            background: isRecalc ? 'var(--c-zone-hv-weak)' : 'var(--c-bg-sunken)',
            color: isRecalc ? 'var(--c-zone-hv)' : 'var(--c-text-2)',
            border: `1px ${isRecalc ? 'solid' : 'dotted'} ${isRecalc ? 'var(--c-zone-hv)' : 'var(--c-text-3)'}`,
            borderRadius: 'var(--r-sm)',
            padding: '0 5px',
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
          }}
        >
          {isRecalc ? '已修正·V2 复算' : '用户本地运行'}
        </span>
        {provenance.fdsCompletedSuccessfully !== undefined && (
          <span className="badge badge--fds">
            {provenance.fdsCompletedSuccessfully ? 'FDS 正常结束' : 'FDS 未确认结束'}
          </span>
        )}
      </div>
      {provenance.inputCorrection && (
        <div>
          输入修正：<strong>{provenance.inputCorrection}</strong>
        </div>
      )}
      {provenance.sourceFdsHrrpua != null && (
        <div style={{ fontFamily: 'var(--font-mono)' }}>
          源 FDS HRRPUA = {formatNumber(provenance.sourceFdsHrrpua, 0)} kW/m²
        </div>
      )}
      {sha && (
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--c-text-3)', wordBreak: 'break-all' }}>
          .fds SHA-256 {sha.slice(0, 16)}…
        </div>
      )}
      {provenance.verificationNote && (
        <div style={{ color: 'var(--c-text-3)' }}>{provenance.verificationNote}</div>
      )}
    </div>
  );
}

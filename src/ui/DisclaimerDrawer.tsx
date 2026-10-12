/**
 * 免责声明抽屉（DESIGN_SYSTEM §4.12 / §4.13；红线 D10、D7b）
 *
 * 硬性要求：
 *  - **组件内禁止使用任何红色/橙色** —— 免责声明是中性文档，不是错误
 *  - 必须含关键词：「非工程消防报警系统」「不作为着火判据或工程结论」
 *  - HRR ①② 并列的免责说明（硬性规则 2）：只陈述数值与比值，
 *    **禁止任何方向的因果解释** —— 既不贬低 ② 也不为 ② 背书
 *  - Esc 关闭，焦点管理（打开移入、关闭返回触发元素）
 */

import { useEffect, useRef } from 'react';
import { useFireStore } from '../store/useFireStore';
import { formatRatioPercent, describeGrid } from '../utils/format';
import { NO_DATA_LABEL, describeSliceSet } from '../utils/coords';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 关闭后焦点返回的元素（可访问性） */
  returnFocusTo?: React.RefObject<HTMLElement>;
}

export default function DisclaimerDrawer({ open, onClose, returnFocusTo }: Props) {
  const hrrInterpretation = useFireStore((s) => s.hrrInterpretation);
  const series = useFireStore((s) => s.series);
  const scene = useFireStore((s) => s.scene);
  const thresholds = useFireStore((s) => s.thresholds);
  const slices = useFireStore((s) => s.slices);
  const quant = describeSliceSet(slices);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc 关闭 + 焦点管理
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      // 焦点困在抽屉内（UX_SPEC §6.1 focus trap）
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnFocusTo?.current?.focus();
    };
  }, [open, onClose, returnFocusTo]);

  if (!open) return null;

  const nominal = hrrInterpretation?.nominalPeakHRRKW ?? null;
  const measured =
    hrrInterpretation?.measuredPeakHRRKW ??
    hrrInterpretation?.measuredPeakHRRKW ??
    null;
  const ratio =
    nominal !== null && measured !== null && nominal !== 0 ? measured / nominal : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 'var(--z-modal)',
        background: 'var(--c-scrim)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disclaimer-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '92vw',
          height: '100%',
          overflowY: 'auto',
          padding: '20px 22px',
          background: 'var(--c-panel-glass)',
          backdropFilter: 'blur(14px)',
          border: '1px solid var(--c-border)',
          borderRight: 'none',
          borderRadius: 'var(--r-lg) 0 0 var(--r-lg)',
          boxShadow: 'var(--shadow-float)',
          color: 'var(--c-text-2)',
          fontSize: 13,
          lineHeight: 1.75,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <h2
            id="disclaimer-title"
            style={{ margin: 0, fontSize: 16, color: 'var(--c-text)', fontWeight: 600 }}
          >
            使用说明与免责声明
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--sm"
            onClick={onClose}
            aria-label="关闭免责声明抽屉"
          >
            ✕ 关闭
          </button>
        </div>

        <Section title="用途定位">
          <p style={P}>
            本系统是<Strong>科研可视化用途</Strong>，用于展示基于真实 FDS
            数值模拟结果的火灾态势演化。它
            <Strong>不是工程消防报警系统</Strong>，
            <Strong>不作为着火判据或工程结论</Strong>，不得用于消防设计审核、
            验收、演练决策或任何工程判定。
          </p>
        </Section>

        <Section title="一、不存在逐柜温度">
          <p style={P}>
            10 个柜体中，每个工况<Strong>仅在起火柜 burner 区域布设热电偶</Strong>，
            其余柜体温度<Strong>未接入</Strong>。界面显示的温度是
            <Strong>「起火柜区域温度」</Strong>，即该工况全部热电偶的逐点最大值，
            <Strong>不是所选柜体的温度</Strong>。
          </p>
          {series && (
            <p style={P}>
              当前工况测点说明：{series.sensorScopeNote}
              <br />
              聚合方式：<code style={CODE}>{series.aggregation}</code>，
              参与聚合的热电偶 {series.sensorCount} 支。
            </p>
          )}
          <p style={P}>
            任何时刻若某柜体未布设测点，界面显示「未接入」并给出原因，
            <Strong>不填 0、不填 20℃ 假装正常、不使用随机数</Strong>。
          </p>
        </Section>

        <Section title="二、火源功率：三个不同的量">
          <p style={P}>
            界面并排显示两个来自真实 FDS 输出的量，<Strong>但二者性质不同，无主次</Strong>，
            且<Strong>界面不对它们的差异给出任何方向的因果解释</Strong>
            —— 既不把 ② 解释为模型缺陷，也不为 ② 背书。成因属尚未完成的建模核查项。
          </p>
          <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
            <li style={LI}>
              <Strong>① 标称设定†</Strong>：源 FDS 的 <code style={CODE}>HRRPUA</code> ×
              火源面面积，属<Strong>输入参数</Strong>。
            </li>
            <li style={LI}>
              <Strong>② FDS 输出峰值</Strong>：<code style={CODE}>*_hrr.csv</code>{' '}
              HRR 通道最大值，属<Strong>计算结果</Strong>。
            </li>
            <li style={LI}>
              <Strong>③ 界面展示值</Strong>：与②同源，用于峰值标注。
            </li>
          </ul>
          {ratio !== null && (
            <p style={P}>
              当前工况输出/设定 = <strong style={STRONG}>{formatRatioPercent(ratio)}</strong>
              。该比值仅为两个真实数值的算术结果，
              <Strong>不代表达标与否，也不隐含任何优劣判断</Strong>。
            </p>
          )}
          {hrrInterpretation?.note && (
            <p style={{ ...P, fontSize: 12, color: 'var(--c-text-3)' }}>
              数据管道说明：{hrrInterpretation.note}
            </p>
          )}
        </Section>

        <Section title="三、报警阈值的性质">
          <p style={P}>
            当前界面报警阈值（低压 {thresholds.warningC}℃ / {thresholds.alarmC}℃，高压 {thresholds.highZoneWarningC}℃ / {thresholds.highZoneAlarmC}℃）
            是<Strong>界面阈值</Strong>，可由用户配置。
            它<Strong>不是物理着火温度</Strong>，
            <Strong>不与真实物理着火条件画等号</Strong>。
            报警仅表示「FDS 模拟结果中的温度序列越过了界面阈值」。
          </p>
          <p style={P}>
            「界面演示触发」按钮产生的事件标记为人工触发，
            <Strong>不来自 FDS 计算，也不来自传感器</Strong>。
          </p>
        </Section>

        <Section title="四、时间与未来场景">
          <p style={P}>
            时间轴的标量序列与温度切片使用<Strong>两套不同的时间栅格</Strong>
            （标量 {describeGrid(series?.timesS ?? null)}，同工况内线性插值；切片 {describeGrid(slices[0]?.frameTimesS ?? null)}，最近邻帧）。
            时间轴拖到任意时刻，两者取样方式不同，专业分析披露时间栅格，播放栏标出当前温度场的真实采样时刻。
          </p>
          <p style={P}>
            「未来场景 t+Δt」是<Strong>同一工况已预计算结果的时间查询</Strong>，
            <Strong>不是在线预测，不是预报，也不代表实时推演</Strong>。
            本项目不训练深度学习模型，不做在线推算。
          </p>
        </Section>

        <Section title="五、几何与切片数据边界">
          <p style={P}>
            场景几何取自源 FDS 的 <code style={CODE}>OBST</code>，
            其 ID 为 AutoCAD 通用 ID，<Strong>无墙/顶/柜体语义字段</Strong>，
            当前语义核验状态为
            <code style={CODE}>{scene?.semanticVerification.status ?? 'UNVERIFIED'}</code>。
            因此「水平面代理」「立面透明」是<Strong>按几何形态生效的代理开关</Strong>，
            可能隐藏非屋顶构件。起火点位置取自{' '}
            <code style={CODE}>VENT SURF_ID='burner'</code> 的几何中心，
            <Strong>是火源面中心，不是柜体外壳</Strong>。
          </p>
          <p style={P}>
            切片二进制为 8bit 量化（<code style={CODE}>{quant?.formula ?? '数据不可用'}</code>），
            定义域 {quant ? `${quant.minC}–${quant.maxC}℃` : '不可用'}，{quant?.note}。
            <Strong>{quant?.clipping}</Strong>。
            未被任何切片补丁覆盖的区域显示为中性灰斜纹「{NO_DATA_LABEL}」，
            <Strong>不参与色标，绝不渲染成低温色</Strong>。
          </p>
          <p style={P}>
            16 个工况存在多种几何差异，场景主模型取自单一工况，
            <Strong>切换工况不会重建房间</Strong>。
          </p>
        </Section>

        <Section title="六、数据来源标签">
          <p style={P}>
            界面每个数值都带来源徽章：<code style={CODE}>● FDS SIMULATED</code>（FDS
            数值计算结果）、<code style={CODE}>▲ SENSOR</code>（真实传感器，本版本未接入）、
            <code style={CODE}>◆ DEMO</code>（人工演示值，虚线边框）、
            <code style={CODE}>○ 未接入</code>（无数据，中性灰点线）。
            「未接入」是中性状态，<Strong>不是错误</Strong>。
          </p>
        </Section>

        <p
          style={{
            ...P,
            marginTop: 18,
            paddingTop: 12,
            borderTop: '1px solid var(--c-divider)',
            fontSize: 12,
            color: 'var(--c-text-3)',
          }}
        >
          本页不含任何红/橙警示色 —— 免责声明是中性文档，不代表异常状态。
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 18 }}>
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--c-text-3)',
          fontWeight: 600,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

const P: React.CSSProperties = { margin: '6px 0' };
const LI: React.CSSProperties = { margin: '3px 0' };
const CODE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  color: 'var(--c-text)',
};
const STRONG: React.CSSProperties = { color: 'var(--c-text)', fontWeight: 500 };

function Strong({ children }: { children: React.ReactNode }) {
  return <strong style={STRONG}>{children}</strong>;
}

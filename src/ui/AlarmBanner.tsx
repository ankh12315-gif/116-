/**
 * 顶部报警横幅（DESIGN_SYSTEM §4.5；UX_SPEC §4.3.1/§4.3.2/§4.3.3）
 *
 * 强制要求：
 *  - `role="alert"` + `aria-live="assertive"`
 *  - **常驻文案**「界面告警 · 基于 FDS 模拟结果的温度阈值判定，非物理判据」
 *  - 颜色不是唯一信息通道：必须同时有图标 + 文字
 *  - 静音**只影响音频**，视觉报警完全不受影响（验收 C 强制）
 *
 * ⚠️ 已知 CSS 缺陷绕过：`global.css` 的 `.alarm-banner` 依赖未定义的
 * `--c-panel-solid` 且未设背景色 → 白字会裸露在三维场景上。
 * 本组件用 inline `background: var(--c-panel)` 兜底。
 */

import { useFireStore } from '../store/useFireStore';
import { formatSeconds, formatTempWithUnit } from '../utils/format';
import { SourceBadge } from './StatusBar';

export default function AlarmBanner() {
  const alarmState = useFireStore((s) => s.alarmState);
  const alarmCabinetId = useFireStore((s) => s.alarmCabinetId);
  const muted = useFireStore((s) => s.muted);
  const setMuted = useFireStore((s) => s.setMuted);
  const resetAlarm = useFireStore((s) => s.resetAlarm);
  const thresholds = useFireStore((s) => s.thresholds);
  const manualTriggered = useFireStore((s) => s.manualTriggered);
  const events = useFireStore((s) => s.alarmEvents);
  const cabinets = useFireStore((s) => s.cabinets);

  const isAlarm = alarmState === 'FIRE_ALARM';
  const latest = events.length > 0 ? events[0] : null;
  const cabinet = cabinets.find((c) => c.id === alarmCabinetId);
  const zoneThreshold =
    cabinet?.zone === 'HIGH'
      ? { warn: thresholds.highZoneWarningC, alarm: thresholds.highZoneAlarmC }
      : { warn: thresholds.warningC, alarm: thresholds.alarmC };

  // 正常态不渲染（DESIGN_SYSTEM §4.5）
  if (alarmState === 'NORMAL') return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`alarm-banner${isAlarm ? '' : ' alarm-banner--warning'}`}
      style={{
        // 兜底 --c-panel-solid 未定义导致透明背景的问题
        background: 'var(--c-panel)',
        borderColor: isAlarm ? 'var(--c-status-alarm)' : 'var(--c-status-warn)',
        borderLeftColor: isAlarm ? 'var(--c-status-alarm)' : 'var(--c-status-warn)',
      }}
    >
      <span className="alarm-banner__icon" aria-hidden="true">
        {isAlarm ? '⛔' : '⚠'}
      </span>

      <div className="alarm-banner__text">
        <div className="alarm-banner__title">
          当前{isAlarm ? '火灾报警' : '高温预警'}
          {alarmCabinetId ? ` · ${alarmCabinetId}` : ''}
          {manualTriggered && <span className="badge badge--muted">界面演示触发</span>}
        </div>
        {/* UX_SPEC §4.3.1 强制常驻文案 —— 报警≠物理判据 */}
        <div className="alarm-banner__meta">
          界面告警 · 基于 FDS 模拟结果的温度阈值判定，非物理判据
        </div>
        {latest && (
          <div className="alarm-banner__meta">
            t={formatSeconds(latest.timeS)} · 触发值 {formatTempWithUnit(latest.valueC)} ·
            阈值 {isAlarm ? zoneThreshold.alarm : zoneThreshold.warn} ℃（界面默认值）·{' '}
            <SourceBadge kind={latest.origin === 'FDS_COMPUTED' ? 'FDS' : 'DEMO'} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
        <button
          type="button"
          className={`btn btn--sm${muted ? '' : ' btn--danger'}`}
          onClick={() => setMuted(!muted)}
          aria-pressed={muted}
          aria-label={muted ? '取消静音，恢复报警音' : '静音报警音'}
        >
          {muted ? '🔇 已静音' : '🔊 静音'}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={resetAlarm}
          aria-label="复位报警状态，不修改任何 FDS 数据"
        >
          ↺ 复位
        </button>
      </div>
    </div>
  );
}

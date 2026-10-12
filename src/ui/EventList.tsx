/**
 * 报警事件列表（UX_SPEC §4.3.2 报警日志 / DESIGN_SYSTEM §4）
 *
 * 纪律：每条事件必须标明来源 —— `FDS_COMPUTED`（FDS 计算结果）
 * 与 `MANUAL_TRIGGER`（界面演示触发），二者不可混称。
 */

import { useFireStore } from '../store/useFireStore';
import { formatClock, formatTempWithUnit } from '../utils/format';

const MAX_SHOWN = 20;

export default function EventList() {
  const events = useFireStore((s) => s.alarmEvents);
  const clearAlarmEvents = useFireStore((s) => s.clearAlarmEvents);

  const shown = events.slice(0, MAX_SHOWN);

  return (
    <section className="panel" style={{ padding: 12, width: 264 }} aria-label="报警事件列表">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 className="panel__title" style={{ margin: 0 }}>
          报警事件
        </h2>
        <button
          type="button"
          className="btn btn--sm"
          onClick={clearAlarmEvents}
          disabled={events.length === 0}
          aria-label="清空报警事件列表"
        >
          清空
        </button>
      </div>

      {events.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            color: 'var(--c-text-2)',
            lineHeight: 1.6,
          }}
        >
          暂无报警事件。报警由界面阈值判定或手动触发产生，
          <strong>不代表物理着火</strong>。
        </p>
      ) : (
        <>
          {events.length > MAX_SHOWN && (
            <p style={{ margin: '0 0 6px', fontSize: 10, color: 'var(--c-text-3)' }}>
              共 {events.length} 条，显示最近 {MAX_SHOWN} 条
            </p>
          )}
          <div className="event-list" role="log" aria-live="polite" aria-label="报警事件">
            {shown.map((e) => (
              <div className="event-item" key={e.id}>
                <span className="event-item__time">{formatClock(e.timeS)}</span>
                <span className="event-item__id">{e.cabinetId}</span>
                <span
                  className={`badge ${e.level === 'FIRE_ALARM' ? 'badge--alarm' : 'badge--warn'}`}
                >
                  {e.level === 'FIRE_ALARM' ? '⛔ 火灾报警' : '⚠ 高温预警'}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--c-text)',
                  }}
                >
                  {formatTempWithUnit(e.valueC)}
                </span>
                <span
                  className="badge badge--muted"
                  title={
                    e.origin === 'FDS_COMPUTED'
                      ? '由 FDS 计算结果穿越界面阈值触发'
                      : '人工点击按钮触发的界面演示，非 FDS 计算结果'
                  }
                >
                  {e.origin === 'FDS_COMPUTED' ? 'FDS 计算' : '界面演示触发'}
                </span>
              </div>
            ))}
          </div>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 9.5,
              color: 'var(--c-text-3)',
              lineHeight: 1.5,
            }}
          >
            事件归属工况 {events[0].scenarioId}。复位报警只清前端状态，
            不修改任何 FDS 原始结果，也不删除本列表。
          </p>
        </>
      )}
    </section>
  );
}
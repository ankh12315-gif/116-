/**
 * 时间轴（UX_SPEC §4.2 / §1.4 / §5 E-7 E-8 E-13；DESIGN_SYSTEM §4.3 行 3）
 *
 * 五项硬性要求：
 *  1. 播放循环用 `requestAnimationFrame`，调 `store.stepTime(dt)`。
 *     ⚠️ `stepTime` 内部**已乘** `playbackRate`，因此传入的 dt 是真实秒数，
 *     绝不能重复乘倍率。
 *  2. 播放状态下拖拽滑块立即生效（调 `setTime`）。
 *  3. t+10/30/60s 未来场景；越界时按钮 `disabled` + 给出原因
 *     （store 的 `setFutureOffset` 会自动拒绝，UI 必须提前拦）。
 *  4. **时间栅格不统一必须披露**：轨道上画两套不同标记密度的小刻度带
 *     —— 标量帧（≈9.01s，密集实心点）/ 切片帧（≈18s，稀疏空心菱形）。
 *  5. 帧漂移披露（drift > 1.0s 显示真实数据帧时刻）。
 *
 * 注：`--c-panel-solid` 已在 global.css 中补齐定义（此前缺失导致控件背景透明），
 * 本文件不再需要行内背景兜底。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { T_END_S, useFireStore } from '../store/useFireStore';
import { formatClock, formatDriftNote, formatNumber, describeGrid } from '../utils/format';

const RATES = [0.5, 1, 2, 4] as const;
const FUTURE_OFFSETS = [10, 30, 60] as const;

export default function Timeline() {
  const currentTimeS = useFireStore((s) => s.currentTimeS);
  const playback = useFireStore((s) => s.playback);
  const playbackRate = useFireStore((s) => s.playbackRate);
  const futureOffsetS = useFireStore((s) => s.futureOffsetS);
  const series = useFireStore((s) => s.series);
  const slices = useFireStore((s) => s.slices);
  const datasetStatus = useFireStore((s) => s.datasetStatus);
  const setTime = useFireStore((s) => s.setTime);
  const stepTime = useFireStore((s) => s.stepTime);
  const setPlayback = useFireStore((s) => s.setPlayback);
  const setPlaybackRate = useFireStore((s) => s.setPlaybackRate);
  const setFutureOffset = useFireStore((s) => s.setFutureOffset);

  const dataReady = datasetStatus === 'READY' && series !== null && series.timesS.length > 0;
  const isFuture = futureOffsetS !== null && futureOffsetS > 0;
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  /* ---------- rAF 播放循环 ---------- */
  useEffect(() => {
    if (playback !== 'PLAYING' || isFuture || !dataReady) {
      lastTsRef.current = null;
      return;
    }
    const tick = (ts: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last !== null) {
        // dt 为真实经过秒数；stepTime 内部已乘 playbackRate
        const dt = Math.min((ts - last) / 1000, 0.25);
        if (dt > 0) stepTime(dt);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [playback, isFuture, dataReady, stepTime]);

  const effectiveTime = currentTimeS + (futureOffsetS ?? 0);

  /* ---------- 数据帧解析（UX_SPEC §1.4）---------- */
  const seriesTimes = series?.timesS ?? null;
  const sliceTimes = slices.length > 0 ? slices[0].frameTimesS : null;

  const seriesFrame = useMemo(() => frameAt(seriesTimes, effectiveTime), [seriesTimes, effectiveTime]);
  const sliceFrame = useMemo(() => frameAt(sliceTimes, effectiveTime), [sliceTimes, effectiveTime]);

  const seriesDrift = seriesFrame ? effectiveTime - seriesFrame.t : null;
  const sliceDrift = sliceFrame ? effectiveTime - sliceFrame.t : null;
  const seriesDriftNote = formatDriftNote(seriesDrift);
  const sliceDriftNote = formatDriftNote(sliceDrift);

  /* ---------- 交互 ---------- */
  const togglePlay = useCallback(() => {
    if (isFuture || !dataReady) return;
    if (playback === 'ENDED') {
      setTime(0);
      setPlayback('PLAYING');
      return;
    }
    setPlayback(playback === 'PLAYING' ? 'PAUSED' : 'PLAYING');
  }, [isFuture, dataReady, playback, setPlayback, setTime]);

  const handleScrub = useCallback(
    (v: number) => {
      if (isFuture || !dataReady) return;
      // 播放状态下拖拽立即生效
      setTime(v);
      if (playback === 'PLAYING') setPlayback('PAUSED');
    },
    [isFuture, dataReady, setTime, playback, setPlayback],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (isFuture || !dataReady) return;
      const big = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleScrub(currentTimeS - big);
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleScrub(currentTimeS + big);
          break;
        case 'Home':
          e.preventDefault();
          handleScrub(0);
          break;
        case 'End':
          e.preventDefault();
          handleScrub(T_END_S);
          break;
        case '[':
        case ']': {
          const i = RATES.indexOf(playbackRate as (typeof RATES)[number]);
          const next = e.key === ']' ? Math.min(i + 1, RATES.length - 1) : Math.max(i - 1, 0);
          setPlaybackRate(RATES[next]);
          break;
        }
        default:
          break;
      }
    },
    [isFuture, dataReady, togglePlay, handleScrub, currentTimeS, playbackRate, setPlaybackRate],
  );

  const playLabel =
    playback === 'PLAYING' ? '⏸ 暂停' : playback === 'ENDED' ? '↺ 重播' : '▶ 播放';
  const disabled = !dataReady || isFuture;

  return (
    <div
      className="timeline"
      role="group"
      aria-label="FDS 时间轴"
      onKeyDown={handleKey}
      style={{
        opacity: dataReady ? 1 : 0.5,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 6,
      }}
    >
      {/* 无数据提示 */}
      {!dataReady && (
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--c-text-2)',
            textAlign: 'right',
          }}
        >
          本工况无 FDS 输出
        </div>
      )}

      {/* 主行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <button
          type="button"
          className="timeline__play"
          onClick={togglePlay}
          disabled={disabled}
          aria-label={playLabel}
          title={isFuture ? '未来场景视图下不可播放，请先返回当前时刻' : playLabel}
        >
          {playLabel}
        </button>

        <span className="timeline__time">{formatClock(currentTimeS)}</span>

        {/* 轨道 + 双时间栅格刻度带 */}
        <div className="timeline__track-wrap" style={{ height: 34 }}>
          {/* 标量帧刻度（密集，≈9.01s） */}
          <div className="timeline__marks" aria-hidden="true">
            {seriesTimes &&
              seriesTimes.map((t, i) => (
                <span
                  key={`s${i}`}
                  className="timeline__mark"
                  style={{
                    left: `${(t / T_END_S) * 100}%`,
                    width: 3,
                    height: 3,
                    top: '32%',
                    background: 'var(--c-text-3)',
                    borderRadius: '50%',
                    opacity: 0.55,
                  }}
                />
              ))}
            {/* 切片帧刻度（稀疏，≈18s，空心菱形） */}
            {sliceTimes &&
              sliceTimes.map((t, i) => (
                <span
                  key={`z${i}`}
                  className="timeline__mark"
                  style={{
                    left: `${(t / T_END_S) * 100}%`,
                    width: 6,
                    height: 6,
                    top: '68%',
                    background: 'transparent',
                    border: '1px solid var(--c-accent)',
                    opacity: 0.7,
                  }}
                />
              ))}
          </div>

          <input
            type="range"
            className="timeline__track"
            min={0}
            max={T_END_S}
            step={0.1}
            value={currentTimeS}
            disabled={disabled}
            onChange={(e) => handleScrub(Number(e.target.value))}
            aria-label="FDS 仿真时刻"
            aria-valuemin={0}
            aria-valuemax={T_END_S}
            aria-valuenow={Number(currentTimeS.toFixed(1))}
            aria-valuetext={`${formatNumber(currentTimeS, 1)} 秒${
              seriesFrame ? `，标量数据帧 ${formatNumber(seriesFrame.t, 1)} 秒` : ''
            }${sliceFrame ? `，切片数据帧 ${formatNumber(sliceFrame.t, 1)} 秒` : ''}`}
            style={{ position: 'relative', zIndex: 1 }}
          />

          {/* 未来场景段（斜纹 = 推断，与实线历史区分） */}
          {isFuture && futureOffsetS !== null && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${(currentTimeS / T_END_S) * 100}%`,
                width: `${(futureOffsetS / T_END_S) * 100}%`,
                top: '50%',
                height: 3,
                transform: 'translateY(-50%)',
                background:
                  'repeating-linear-gradient(90deg, var(--c-border-strong) 0 3px, transparent 3px 6px)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        <span className="timeline__total">/ {formatClock(T_END_S)}</span>

        <div className="timeline__rates" role="group" aria-label="播放倍率">
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              className={`timeline__rate${playbackRate === r ? ' is-active' : ''}`}
              onClick={() => setPlaybackRate(r)}
              disabled={disabled}
              aria-pressed={playbackRate === r}
              aria-label={`播放倍率 ${r} 倍`}
            >
              ×{r}
            </button>
          ))}
        </div>
      </div>

      {/* 第二行：未来场景 + 帧漂移披露 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 10,
          color: 'var(--c-text-3)',
        }}
      >
        {isFuture && futureOffsetS !== null ? (
          <>
            <span className="future-badge" role="status">
              ⏱ 未来场景 · t={formatNumber(effectiveTime, 0)} s (+{futureOffsetS} s)
            </span>
            <span style={{ color: 'var(--c-status-warn-ink)' }}>
              已预计算，非实时预测 · 播放与拖拽已锁定
            </span>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => setFutureOffset(null)}
              aria-label="返回当前时刻，解除未来场景锁定"
            >
              返回当前时刻
            </button>
          </>
        ) : (
          <>
            {FUTURE_OFFSETS.map((d) => {
              const overflow = currentTimeS + d > T_END_S;
              return (
                <button
                  key={d}
                  type="button"
                  className="btn btn--sm"
                  disabled={!dataReady || overflow}
                  onClick={() => setFutureOffset(d)}
                  aria-label={`查看 t+${d} 秒未来场景`}
                  title={
                    overflow
                      ? `t=${formatNumber(currentTimeS, 0)} s，+${d} s 将超出 ${T_END_S} s 上限，无可用数据。`
                      : `查看同一工况已预计算的 t+${d} 秒场景（非实时预测）`
                  }
                >
                  +{d}s
                </button>
              );
            })}
            <span title="未来场景 = 同一 FDS 工况已预计算结果的时间查询，不是预测或预报">
              ⓘ 未来场景为已预计算结果
            </span>
          </>
        )}

        {/* 时间栅格不透明披露（硬性规则 4） */}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
          标量 {describeGrid(seriesTimes)}（同工况内线性插值） · 切片{' '}
          {describeGrid(sliceTimes)}（最近邻帧，不插值）
        </span>
      </div>

      {/* 帧漂移提示（UX_SPEC §1.4 / E-8） */}
      {dataReady && (seriesDriftNote || sliceDriftNote) && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--c-text-3)',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          {seriesDriftNote && (
            <span>
              t={formatNumber(effectiveTime, 1)} s · 标量数据帧{' '}
              {seriesFrame ? formatNumber(seriesFrame.t, 1) : '—'} s（{seriesDriftNote}）
            </span>
          )}
          {sliceDriftNote && (
            <span>
              切片采样间隔 ≈18 s，当前显示最近可用帧
              {sliceFrame ? ` ${formatNumber(sliceFrame.t, 1)} s` : ''}（{sliceDriftNote}）
            </span>
          )}
        </div>
      )}

      {/* 播放状态 + 数据来源 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 9.5,
          color: 'var(--c-text-3)',
        }}
      >
        <span>
          {playback === 'ENDED'
            ? `已结束 · ${formatClock(T_END_S)}（本工况 FDS 模拟已结束，无更晚数据）`
            : playback === 'PLAYING'
              ? 'FDS 工况回放'
              : playback === 'PAUSED'
                ? '已暂停'
                : '就绪'}
        </span>
        <span className="badge badge--fds">FDS SIMULATED</span>
        <span>⚠ 科研可视化，非消防报警系统</span>
      </div>
    </div>
  );
}

/** 取不大于 t 的最近一帧（不做前向外推，UX_SPEC §1.4） */
function frameAt(
  times: number[] | null,
  t: number,
): { t: number; index: number; exact: boolean } | null {
  if (!times || times.length === 0) return null;
  if (t < times[0]) return null; // PRE_ROLL，不冒充 t=0 帧
  let lo = 0;
  let hi = times.length - 1;
  if (t >= times[hi]) return { t: times[hi], index: hi, exact: Math.abs(t - times[hi]) < 1e-3 };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return { t: times[lo], index: lo, exact: Math.abs(t - times[lo]) < 1e-3 };
}
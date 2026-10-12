/**
 * 报警声音（Web Audio API）
 *
 * 浏览器自动播放策略（UX_SPEC §4.3.3 / E-6）：
 *  - AudioContext **允许**在用户交互前创建（不会报错，只是处于 suspended）。
 *  - `resume()` **必须**在首次用户手势之后调用，否则 Promise 被拒绝 / 无声。
 *  - 因此本模块的 `unlock()` 由 UI 层在首个 pointerdown / keydown 时调用，
 *    对应 store 的 `unlockAudio()`。store 的 `audioUnlocked` 是唯一事实源。
 *
 * 音色规范：
 *  - 预警（TEMPERATURE_WARNING）：短促双音 660 → 880 Hz，间隔 200 ms
 *  - 报警（FIRE_ALARM）：三音递进 660 / 880 / 1100 Hz
 *  - 静音（muted）：必须**真正停止后续播放**，而不只是不再触发新音。
 *
 * dispose() 必须释放 AudioContext 与所有挂起的定时器，防止内存泄漏与重复播放。
 */

export type AlarmAudioKind = 'TEMPERATURE_WARNING' | 'FIRE_ALARM';

/** 各类报警的音序定义（Hz，空格代表静音间隔） */
const TONES: Record<AlarmAudioKind, Array<number | null>> = {
  TEMPERATURE_WARNING: [660, null, 880],
  FIRE_ALARM: [660, 880, 1100],
};

/** 单音时长（ms） */
const TONE_MS = 150;
/** 音间间隔（ms）；null 项也占一个间隔，满足「间隔 200ms」 */
const GAP_MS = 200;
/** 音量（0–1）。报警声是提示音，不应刺耳。 */
const GAIN = 0.16;

export interface AlarmAudio {
  /** 在用户手势中调用：创建并 resume AudioContext。返回是否可用。 */
  unlock: () => Promise<boolean>;
  /**
   * 播放一段报警音。
   * @param kind 报警级别
   * @param force 即使 muted 也播放（用于用户主动点击试听）
   * @returns 是否真的安排了播放
   */
  play: (kind: AlarmAudioKind, force?: boolean) => boolean;
  /** 停止一切进行中的音（静音 / 复位报警时调用） */
  stop: () => void;
  /** 释放 AudioContext（组件卸载时调用） */
  dispose: () => void;
  /** 当前 AudioContext 是否处于 running */
  isRunning: () => boolean;
}

type Ctor = typeof AudioContext;

function getAudioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 创建报警音频引擎。
 * 该函数**不创建** AudioContext —— 延迟到 unlock()，严格遵守自动播放策略。
 */
export function createAlarmAudio(): AlarmAudio {
  let ctx: AudioContext | null = null;
  /** 所有已调度但未播放完的节点，用于 stop() / dispose() 打断 */
  const live = new Set<{ osc: OscillatorNode; gain: GainNode }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  function clearLive(): void {
    for (const node of live) {
      try {
        node.gain.gain.cancelScheduledValues(ctx ? ctx.currentTime : 0);
        node.gain.gain.value = 0;
        node.osc.stop();
      } catch {
        /* 节点可能已自然结束，忽略 */
      }
    }
    live.clear();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function unlock(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const Ctor = getAudioContextCtor();
    if (!Ctor) return Promise.resolve(false);
    if (!ctx) {
      try {
        ctx = new Ctor();
      } catch {
        return Promise.resolve(false);
      }
    }
    if (ctx.state === 'running') return Promise.resolve(true);
    return ctx
      .resume()
      .then(() => ctx?.state === 'running')
      .catch(() => false);
  }

  function isRunning(): boolean {
    return !!ctx && ctx.state === 'running';
  }

  function play(kind: AlarmAudioKind, force = false): boolean {
    if (disposed) return false;
    // 未解锁时静默失败：视觉报警不受影响（UX_SPEC E-6 硬性要求）
    if (!isRunning() || !ctx) return false;

    clearLive(); // 打断上一段，避免叠加成噪音
    const now = ctx.currentTime;

    let cursor = now;
    for (const hz of TONES[kind]) {
      if (hz === null) {
        cursor += GAP_MS / 1000;
        continue;
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const startAt = cursor;
      const stopAt = cursor + TONE_MS / 1000;
      // 5ms 淡入淡出，消除咔哒声
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(force ? GAIN : GAIN, startAt + 0.005);
      gain.gain.setValueAtTime(GAIN, Math.max(startAt + 0.005, stopAt - 0.02));
      gain.gain.linearRampToValueAtTime(0, stopAt);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(stopAt + 0.01);

      const entry = { osc, gain };
      live.add(entry);
      osc.onended = () => live.delete(entry);

      // 兜底清理：即便 onended 未触发也能移除引用
      const t = setTimeout(() => {
        timers.delete(t);
        live.delete(entry);
      }, (stopAt - now) * 1000 + 60);
      timers.add(t);

      cursor = stopAt + GAP_MS / 1000;
    }
    return true;
  }

  function stop(): void {
    clearLive();
  }

  function dispose(): void {
    disposed = true;
    clearLive();
    if (ctx) {
      const c = ctx;
      ctx = null;
      void c.close().catch(() => undefined);
    }
  }

  return { unlock, play, stop, dispose, isRunning };
}
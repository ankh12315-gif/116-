/**
 * 数值格式化工具（DESIGN_SYSTEM §6）
 *
 * 纪律（DESIGN_SYSTEM §6 / UX_SPEC 最高原则）：
 *  - 缺失值统一 `—`，**禁止**用 0 / 20 / 28 代替缺失。
 *  - 所有数字用等宽字体 + tabular-nums（由调用方 CSS 承担）。
 *  - HRR 只做「kW / MW」单位换算，不做任何因果或优劣判断。
 */

/** 缺失值占位符。DESIGN_SYSTEM §6：空值统一 `—`，单位保留。 */
export const EM_DASH = '—';

/** 千分位分隔（不依赖 locale，保证 CI 与浏览器输出一致） */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * 固定小数位格式化。`null` / `undefined` / `NaN` 一律返回 `—`。
 * @param digits 小数位数，默认 1
 */
export function formatNumber(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EM_DASH;
  }
  const fixed = value.toFixed(digits);
  const neg = fixed.startsWith('-');
  const body = neg ? fixed.slice(1) : fixed;
  const [int, frac] = body.split('.');
  const out = `${group(int)}${frac ? `.${frac}` : ''}`;
  return neg ? `-${out}` : out;
}

/**
 * 温度（℃）。缺失时返回 `—`，调用方负责补单位。
 * 切片量化步长 3.06℃，因此默认 1 位小数；**不得**声称 0.1℃ 精度。
 */
export function formatTempC(
  value: number | null | undefined,
  digits = 1,
): string {
  return formatNumber(value, digits);
}

/** 带单位的温度，如 `620.5 ℃` / `— ℃` */
export function formatTempWithUnit(
  value: number | null | undefined,
  digits = 1,
): string {
  return `${formatNumber(value, digits)} ℃`;
}

/**
 * HRR 功率：自动在 kW / MW 间切换。
 * ≥ 1000 kW 用 MW（2 位小数），否则 kW（2 位小数）。
 * 只做单位换算，**不改变量级、不做评价**。
 */
export function formatKW(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EM_DASH;
  }
  const abs = Math.abs(value);
  if (abs >= 1000) return `${formatNumber(value / 1000, 2)} MW`;
  return `${formatNumber(value, 2)} kW`;
}

/** 强制 kW（用于「标称设定†」这类以 kW 记的输入参数） */
export function formatAsKW(
  value: number | null | undefined,
  digits = 2,
): string {
  return `${formatNumber(value, digits)} kW`;
}

/** 强制 MW（用于标称档位语义，如 `40 MW`） */
export function formatAsMW(
  value: number | null | undefined,
  digits = 0,
): string {
  return `${formatNumber(value, digits)} MW`;
}

/**
 * 比值 → 百分比字符串（不含 % 号，便于排版分离）。
 * ⚠️ 只陈述数值，**不得**附加任何因果解释（DESIGN_SYSTEM §4.13）。
 */
export function formatRatioPercent(
  ratio: number | null | undefined,
  digits = 1,
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return EM_DASH;
  }
  return `${formatNumber(ratio * 100, digits)}%`;
}

/**
 * FDS 仿真时间 `mm:ss`。
 * 复用 coords.formatSimTime 的语义（0–1800s → 00:00–30:00），
 * 但此处独立实现以避免 UI 层依赖 utils/coords 的三维语义模块。
 */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return EM_DASH;
  }
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 时刻读数（带一位小数），如 `180.0 s`。用于时间轴「当前时刻」。 */
export function formatSeconds(
  seconds: number | null | undefined,
  digits = 1,
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return EM_DASH;
  }
  return `${formatNumber(seconds, digits)} s`;
}

/** 坐标分量（FDS m），固定 2 位小数，如 `11.75` */
export function formatM(value: number | null | undefined): string {
  return formatNumber(value, 2);
}

/** 数量计数 */
export function formatCount(n: number): string {
  return group(String(Math.max(0, Math.round(n))));
}

/**
 * 数据帧漂移（UX_SPEC §1.4 / E-8）。
 * drift ≤ 1.0s 视为落在帧上，返回 null 表示无需提示漂移。
 */
export function formatDriftNote(driftS: number | null | undefined): string | null {
  if (driftS === null || driftS === undefined || !Number.isFinite(driftS)) {
    return null;
  }
  if (driftS <= 1.0) return null;
  return `Δ${formatNumber(driftS, 1)} s`;
}

/**
 * 采样间隔描述：用于披露标量（≈9.01s）与切片（≈18s）两套时间栅格。
 * @param times 时间序列；为空或不足 2 点返回 null
 */
export function samplingStepS(times: number[] | null | undefined): number | null {
  if (!times || times.length < 2) return null;
  const step = times[1] - times[0];
  return Number.isFinite(step) && step > 0 ? step : null;
}

/** 采样点数描述，如 `201 点 @ ≈9.01 s` */
export function describeGrid(times: number[] | null | undefined): string {
  const step = samplingStepS(times);
  if (!times || times.length === 0) return EM_DASH;
  if (step === null) return `${formatCount(times.length)} 点`;
  return `${formatCount(times.length)} 点 @ ≈${formatNumber(step, 2)} s`;
}
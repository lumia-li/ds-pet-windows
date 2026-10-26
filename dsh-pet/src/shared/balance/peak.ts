/**
 * 峰/谷档位的**时间计算**（北京时间）—— 气泡上「距峰 / 距谷」倒计时用它。
 *
 * 与 host 侧 `deepseekPricingTier()` 的关系：那个在**取数时刻**算好档位随数据带出；
 * 这里在**展示时刻**每秒重算"还有多久切换"。两条规则必须一致：
 *   高峰 = 工作日（周一至周五、非法定节假日）的 9:00–12:00 与 14:00–18:00；
 *   其余全部为谷（工作日其他时段、12:00–14:00 午休、周末、法定节假日、调休补班的周末）。
 *
 * 节假日表只影响「谷 → 下一个峰」的顺延。这里只列**放假日**（调休上班日不用列，它们本来就是工作日）。
 * 数据按国务院办公厅公布的放假安排整理：如与实际有出入，改下面 HOLIDAYS 一处即可（纯数据，无副作用）。
 */
import type { PricingTier } from './types';

/** 2026 年法定节假日（放假日；含 2027 元旦，避免跨年空档） */
const HOLIDAYS = new Set<string>([
  // 元旦
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // 春节（2/17 正月初一，除夕 2/16）
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  // 清明
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // 劳动节
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  // 端午
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // 中秋
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // 国庆
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  // 2027 元旦
  '2027-01-01',
]);

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23', // 避免午夜被格式化成 24 点
});

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface BeijingClock {
  year: number;
  month: number;
  /** 1–31 */
  day: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
  /** 当天已过的分钟数（0–1439） */
  minutes: number;
}

/** 北京时间下的"墙钟"分量（不依赖本机时区：用 Intl 指定 Asia/Shanghai） */
export function beijingClock(now: Date = new Date()): BeijingClock {
  const parts = CLOCK.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY[get('weekday')] ?? 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function dateKey(clock: BeijingClock): string {
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

/** 是否放假日（周末之外的法定节假日） */
export function isHoliday(clock: BeijingClock): boolean {
  return HOLIDAYS.has(dateKey(clock));
}

/** 是否是计价意义上的工作日：周一到周五且不是法定节假日（调休补班的周末仍算周末 → 低谷） */
export function isWorkday(clock: BeijingClock): boolean {
  return clock.weekday >= 1 && clock.weekday <= 5 && !isHoliday(clock);
}

/** 该时刻是否处于高峰档 */
export function isPeakTier(clock: BeijingClock): boolean {
  if (!isWorkday(clock)) return false;
  const m = clock.minutes;
  return (m >= 9 * 60 && m < 12 * 60) || (m >= 14 * 60 && m < 18 * 60);
}

/** 北京时间 y-m-d hh:mm 的绝对时间戳（中国无夏令时，固定 UTC+8） */
function beijingTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

/**
 * 下一个档位切换时刻（时间戳）。
 * - 当前为峰 → 距谷：上午峰到 12:00，下午峰到 18:00；
 * - 当前为谷 → 距峰：今天还剩 9:00 / 14:00 就今天，否则顺延到下一个工作日 9:00（跳过周末与节假日）。
 */
export function nextTierChange(tier: PricingTier, now: Date = new Date()): number {
  const clock = beijingClock(now);
  const { year, month, day, minutes } = clock;

  if (tier === 'peak') {
    return minutes < 12 * 60 ? beijingTime(year, month, day, 12) : beijingTime(year, month, day, 18);
  }

  if (isWorkday(clock)) {
    if (minutes < 9 * 60) return beijingTime(year, month, day, 9);
    if (minutes >= 12 * 60 && minutes < 14 * 60) return beijingTime(year, month, day, 14);
  }

  // 工作日 18:00 之后 / 周末 / 节假日：从"今天中午"往后逐日找第一个工作日
  const base = beijingTime(year, month, day, 12);
  for (let i = 1; i <= 60; i += 1) {
    const candidate = beijingClock(new Date(base + i * 86_400_000));
    if (isWorkday(candidate)) {
      return beijingTime(candidate.year, candidate.month, candidate.day, 9);
    }
  }
  return beijingTime(year, month, day, 9);
}

/** 倒计时文本：HH:mm:ss（超过 24 小时时小时位自然变成 3 位，不截断） */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** 「距峰 / 距谷」+ 倒计时（气泡小字直接用这个） */
export function tierCountdownLabel(tier: PricingTier, now: Date = new Date()): string {
  return (tier === 'peak' ? '距谷 ' : '距峰 ') + formatCountdown(nextTierChange(tier, now) - now.getTime());
}

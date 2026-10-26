/**
 * 峰/谷倒计算的单测：规则是"工作日 9–12、14–18 为峰，其余为谷"，
 * 周末与法定节假日全天为谷，且谷的倒计时要顺延到下一个工作日的 9:00。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { beijingClock, formatCountdown, isPeakTier, nextTierChange, tierCountdownLabel } from './peak.ts';

/** 北京时间的某个时刻 → Date（中国固定 UTC+8） */
function bj(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

/** 时间戳 → 北京时间的 "MM-DD HH:mm"（断言用） */
function bjLabel(ms: number): string {
  const c = beijingClock(new Date(ms));
  return `${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')} ${String(Math.floor(c.minutes / 60)).padStart(2, '0')}:${String(c.minutes % 60).padStart(2, '0')}`;
}

describe('beijingClock —— 不依赖本机时区', () => {
  test('UTC 02:30 = 北京 10:30', () => {
    const clock = beijingClock(new Date(Date.UTC(2026, 9, 26, 2, 30))); // 2026-10-26 周一
    assert.equal(Math.floor(clock.minutes / 60), 10);
    assert.equal(clock.minutes % 60, 30);
    assert.equal(clock.weekday, 1);
  });
});

describe('isPeakTier —— 时段与工作日', () => {
  test('工作日 9:00–12:00、14:00–18:00 是峰；12:00–14:00 与 18:00 后是谷', () => {
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 9, 0))), true);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 11, 59))), true);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 12, 0))), false);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 13, 30))), false);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 14, 0))), true);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 17, 59))), true);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 26, 18, 0))), false);
  });

  test('周末全天是谷（2026-10-24 周六 / 10-25 周日）', () => {
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 24, 10, 0))), false);
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 25, 10, 0))), false);
  });

  test('法定节假日全天是谷（2026-10-01 国庆，周四）', () => {
    assert.equal(isPeakTier(beijingClock(bj(2026, 10, 1, 10, 0))), false);
  });
});

describe('nextTierChange —— 倒计时目标', () => {
  test('上午峰 → 今天 12:00', () => {
    assert.equal(bjLabel(nextTierChange('peak', bj(2026, 10, 26, 10, 0))), '10-26 12:00');
  });

  test('下午峰 → 今天 18:00', () => {
    assert.equal(bjLabel(nextTierChange('peak', bj(2026, 10, 26, 15, 0))), '10-26 18:00');
  });

  test('谷（午休 13:00）→ 今天 14:00', () => {
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 26, 13, 0))), '10-26 14:00');
  });

  test('谷（早上 7:00）→ 今天 9:00', () => {
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 26, 7, 0))), '10-26 09:00');
  });

  test('谷（工作日 19:00）→ 下一个工作日 9:00', () => {
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 26, 19, 0))), '10-27 09:00');
  });

  test('谷（周五 19:00）→ 跳过周末，周一 9:00', () => {
    // 2026-10-23 是周五
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 23, 19, 0))), '10-26 09:00');
  });

  test('谷（周六）→ 周一 9:00', () => {
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 24, 10, 0))), '10-26 09:00');
  });

  test('谷（国庆 10-01）→ 跳过节假日后 10-08 9:00', () => {
    assert.equal(bjLabel(nextTierChange('idle', bj(2026, 10, 1, 10, 0))), '10-08 09:00');
  });
});

describe('formatCountdown —— HH:mm:ss', () => {
  test('常规与跨天', () => {
    assert.equal(formatCountdown(0), '00:00:00');
    assert.equal(formatCountdown(1000), '00:00:01');
    assert.equal(formatCountdown(3 * 3600_000 + 25 * 60_000 + 7000), '03:25:07');
    assert.equal(formatCountdown(26 * 3600_000), '26:00:00');
    assert.equal(formatCountdown(-5), '00:00:00');
  });

  test('标签带「距峰 / 距谷」前缀', () => {
    assert.match(tierCountdownLabel('idle', bj(2026, 10, 26, 10, 0)), /^距峰 \d{2}:\d{2}:\d{2}$/);
    assert.match(tierCountdownLabel('peak', bj(2026, 10, 26, 10, 0)), /^距谷 \d{2}:\d{2}:\d{2}$/);
  });
});

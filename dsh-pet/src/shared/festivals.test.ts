/**
 * 节日判断的单测。
 *
 * 重点验两件事：
 *   1. **农历日期换算是准的**（用 Intl 的 zh-CN 农历日历）：春节 / 中秋这几个已知日期必须命中；
 *   2. **动画绝不虚构**：只从真实动画池里按关键词挑，没有就返回 null。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { festivalsOn, lunarOf, pickFestivalAnimation } from './festivals.ts';

describe('lunarOf —— 农历换算', () => {
  test('已知春节：2026-02-17 / 2025-01-29 / 2024-02-10 都是正月初一', () => {
    for (const date of [new Date(2026, 1, 17), new Date(2025, 0, 29), new Date(2024, 1, 10)]) {
      const lunar = lunarOf(date);
      assert.equal(lunar?.month, 1, date.toISOString());
      assert.equal(lunar?.day, 1, date.toISOString());
      assert.equal(lunar?.leap, false);
    }
  });

  test('已知中秋：2025-10-06 是八月十五', () => {
    assert.deepEqual(lunarOf(new Date(2025, 9, 6)), { month: 8, day: 15, leap: false });
  });

  test('公历日期与农历日期不是一回事（2025-06-19 是五月廿四，不是端午）', () => {
    const lunar = lunarOf(new Date(2025, 5, 19));
    assert.equal(lunar?.month, 5);
    assert.equal(lunar?.day, 24);
  });
});

describe('festivalsOn —— 当天命中的节日', () => {
  test('春节 / 元旦 / 圣诞命中，普通日子为空', () => {
    assert.ok(festivalsOn(new Date(2026, 1, 17)).some((hit) => hit.def.id === 'spring-festival'));
    assert.ok(festivalsOn(new Date(2026, 0, 1)).some((hit) => hit.def.id === 'new-year'));
    assert.ok(festivalsOn(new Date(2026, 11, 25)).some((hit) => hit.def.id === 'christmas'));
    // 2026-03-03 其实是正月十五（元宵），换成 3-15 这种确实没有节日的日子
    assert.equal(festivalsOn(new Date(2026, 2, 15)).length, 0);
  });

  test('母亲节是 5 月第 2 个周日（2026-05-10）', () => {
    const hits = festivalsOn(new Date(2026, 4, 10));
    assert.ok(hits.some((hit) => hit.def.id === 'mothers-day'));
    assert.equal(new Date(2026, 4, 10).getDay(), 0);
  });

  test('每个定义都能在一年里找到命中（防止某条规则写错月份/日期）', () => {
    const seen = new Set<string>();
    for (let day = 0; day < 370; day += 1) {
      for (const hit of festivalsOn(new Date(2026, 0, 1 + day))) seen.add(hit.def.id);
    }
    for (const id of ['spring-festival', 'lantern-festival', 'dragon-boat', 'qixi', 'mid-autumn', 'double-ninth']) {
      assert.ok(seen.has(id), '2026 年内应命中：' + id);
    }
  });
});

describe('pickFestivalAnimation —— 只在真实动画池里挑', () => {
  const pool = {
    idle: ['待机'],
    turn: [],
    move: ['走路'],
    categories: [{ name: '节日', actions: ['拜年', '招手'] }],
  };

  test('关键词命中真实动画', () => {
    assert.equal(pickFestivalAnimation(pool, ['拜年']), '拜年');
    assert.equal(pickFestivalAnimation(pool, ['不存在', '招手']), '招手');
  });

  test('一个都不匹配 → null（绝不编一个动画名出来）', () => {
    assert.equal(pickFestivalAnimation(pool, ['放烟花', '跳舞']), null);
    assert.equal(pickFestivalAnimation({}, ['拜年']), null);
    assert.equal(pickFestivalAnimation(pool, []), null);
  });
});

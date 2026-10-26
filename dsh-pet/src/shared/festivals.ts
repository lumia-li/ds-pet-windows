/**
 * 中国节日 → 「今天是不是节日」+ 默认气泡文案 + 动画提示词。
 *
 * 两条设计约束（改之前先读）：
 *   1. **日期必须准**：农历节日不内置农历数据表，改用 **Intl 的中文农历日历**
 *      （`zh-CN-u-ca-chinese`）——ICU 数据随 Electron/Node 发布，比手写 lunarInfo 表可靠，
 *      闰月也能识别（month 形如「闰四月」，节日只在非闰月的当月命中）。
 *   2. **动画不虚构**：这里只给「关键词提示」（如春节 → 拜年/庆祝/招手），真正播哪一段由
 *      调用方在**该宠物实际的动画池**里按关键词匹配；一个都匹配不上就返回 null（只冒泡不说话）。
 *
 * 纯逻辑、不碰 DOM/文件，浏览器与桌面两端都能直接用，也方便单测。
 */

/** 农历月名（Intl 输出的就是这些，含「冬月」「腊月」写法） */
const LUNAR_MONTHS: Record<string, number> = {
  正月: 1,
  二月: 2,
  三月: 3,
  四月: 4,
  五月: 5,
  六月: 6,
  七月: 7,
  八月: 8,
  九月: 9,
  十月: 10,
  冬月: 11,
  十一月: 11,
  腊月: 12,
  十二月: 12,
};

export interface FestivalDef {
  /** 稳定 id（配置里按它覆盖文案/动画） */
  id: string;
  /** 显示名 */
  name: string;
  /** 公历固定日期（1-based） */
  solar?: { month: number; day: number };
  /** 农历固定日期（月名 + 日） */
  lunar?: { month: string; day: number };
  /** 公历「第 n 个星期 w」型节日（母亲节 / 父亲节 / 感恩节这类） */
  nthWeekday?: { month: number; weekday: number; nth: number };
  /** 默认气泡文案 */
  text: string;
  /** 动画关键词（在宠物动画池里按顺序找；找不到就不播） */
  animHints: string[];
}

/**
 * 节日清单。
 *
 * 只收**民俗 / 生活类**节日：这类节日配桌宠的日常台词自然。政治性、纪念性节日不在本表
 * （它们既不该由一只桌宠自动发言，也不在"节日动画"的产品意图里）。
 */
export const FESTIVALS: readonly FestivalDef[] = [
  // ---------- 农历 ----------
  // 关键词都取自**随包动画池里真实存在的名字**（「收红包」「吃粽子」「中秋赏月吃月饼」这类），
  // 按顺序找第一个包含该词的动画；都找不到 → 不播（null）。别在这里写"拜年/庆祝"这种泛词——
  // 动画名里没有它们，等于永远不匹配。
  {
    id: 'spring-festival',
    name: '春节',
    lunar: { month: '正月', day: 1 },
    text: '新年到啦，祝你新的一年顺顺利利～',
    animHints: ['收红包', '写福字', '舞狮头', '吃饺子', '吃年糕', '放烟花'],
  },
  {
    id: 'lantern-festival',
    name: '元宵节',
    lunar: { month: '正月', day: 15 },
    text: '元宵节快乐，记得吃汤圆哦～',
    animHints: ['吃汤圆', '放孔明灯', '放烟花'],
  },
  {
    id: 'dragon-head',
    name: '龙抬头',
    lunar: { month: '二月', day: 2 },
    text: '二月二，龙抬头，今天适合理个发～',
    animHints: ['吃年糕', '写福字'],
  },
  {
    id: 'dragon-boat',
    name: '端午节',
    lunar: { month: '五月', day: 5 },
    text: '端午节到了，粽子和我说一声就好～',
    animHints: ['吃粽子', '吃青团'],
  },
  {
    id: 'qixi',
    name: '七夕',
    lunar: { month: '七月', day: 7 },
    text: '七夕快乐，今天也要有人陪你呀～',
    animHints: ['穿针乞巧', '凭空生花'],
  },
  {
    id: 'ghost-festival',
    name: '中元节',
    lunar: { month: '七月', day: 15 },
    text: '今晚早点回家，别在外面晃太久哦～',
    animHints: ['放河灯', '萌化小幽灵'],
  },
  {
    id: 'mid-autumn',
    name: '中秋节',
    lunar: { month: '八月', day: 15 },
    text: '中秋快乐，月亮和月饼都给你留着～',
    animHints: ['中秋赏月吃月饼', '放孔明灯', '吃月饼'],
  },
  {
    id: 'double-ninth',
    name: '重阳节',
    lunar: { month: '九月', day: 9 },
    text: '重阳节，适合出去走走、看看秋天～',
    animHints: ['吃重阳糕', '插茱萸赏菊'],
  },
  {
    id: 'laba',
    name: '腊八节',
    lunar: { month: '腊月', day: 8 },
    text: '腊八啦，喝碗热粥暖暖胃～',
    animHints: ['吃腊八粥'],
  },
  {
    id: 'little-new-year',
    name: '小年',
    lunar: { month: '腊月', day: 23 },
    text: '小年到，开始收拾屋子准备过年咯～',
    // 池里没有"扫尘/祭灶"，只有年货类：退一步用吃年糕
    animHints: ['吃年糕', '写福字'],
  },

  // ---------- 公历 ----------
  {
    id: 'new-year',
    name: '元旦',
    solar: { month: 1, day: 1 },
    text: '元旦快乐，新的一年开个好头～',
    animHints: ['放烟花', '放孔明灯', '拆礼物'],
  },
  {
    id: 'valentine',
    name: '情人节',
    solar: { month: 2, day: 14 },
    text: '情人节快乐，今天也要开心呀～',
    animHints: ['凭空生花', '写福字'],
  },
  {
    id: 'womens-day',
    name: '妇女节',
    solar: { month: 3, day: 8 },
    text: '节日快乐，今天你最大～',
    animHints: ['女仆屈膝礼仪', '凭空生花'],
  },
  {
    id: 'april-fool',
    name: '愚人节',
    solar: { month: 4, day: 1 },
    text: '愚人节快乐，今天别太信我说的话～',
    animHints: ['扑克魔术', '变鸽子'],
  },
  {
    id: 'labor-day',
    name: '劳动节',
    solar: { month: 5, day: 1 },
    text: '劳动节快乐，今天可以什么都不干～',
    animHints: ['荡秋千', '下五子棋', '撸猫'],
  },
  {
    id: 'childrens-day',
    name: '儿童节',
    solar: { month: 6, day: 1 },
    text: '儿童节快乐，我也算半个小孩吧～',
    animHints: ['吹气球', '放风筝', '踢毽子'],
  },
  {
    id: 'teachers-day',
    name: '教师节',
    solar: { month: 9, day: 10 },
    text: '教师节快乐，谢谢那些教过我们的人～',
    animHints: ['女仆屈膝礼仪'],
  },
  {
    id: 'halloween',
    name: '万圣夜',
    solar: { month: 10, day: 31 },
    text: '万圣夜快乐，不给我糖我就捣乱咯～',
    animHints: ['讨糖南瓜灯', '萌化小幽灵'],
  },
  {
    id: 'christmas-eve',
    name: '平安夜',
    solar: { month: 12, day: 24 },
    text: '平安夜快乐，愿你今晚睡个好觉～',
    animHints: ['堆雪人', '放孔明灯'],
  },
  {
    id: 'christmas',
    name: '圣诞节',
    solar: { month: 12, day: 25 },
    text: '圣诞快乐，礼物我就不客气地收下了～',
    animHints: ['装点圣诞树', '拆礼物'],
  },
  {
    id: 'mothers-day',
    name: '母亲节',
    nthWeekday: { month: 5, weekday: 0, nth: 2 },
    text: '母亲节快乐，记得跟妈妈打个招呼～',
    animHints: ['女仆屈膝礼仪', '凭空生花'],
  },
  {
    id: 'fathers-day',
    name: '父亲节',
    nthWeekday: { month: 6, weekday: 0, nth: 3 },
    text: '父亲节快乐，也别忘了跟爸爸说句话～',
    animHints: ['撸猫', '下五子棋'],
  },
];

export interface LunarDate {
  /** 月序（1–12，闰月与本月同序） */
  month: number;
  /** 日 */
  day: number;
  /** 是否闰月（闰月的节日不算） */
  leap: boolean;
}

/**
 * 公历 → 农历（月/日/是否闰月）。拿不到（ICU 缺中文农历数据）时返回 null。
 *
 * Intl 输出形如 `month:"正月", day:"1", literal:"日"`；闰月是 `month:"闰四月"`。
 */
export function lunarOf(date: Date): LunarDate | null {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(date);
    const rawMonth = parts.find((part) => part.type === 'month')?.value ?? '';
    const rawDay = parts.find((part) => part.type === 'day')?.value ?? '';
    const day = Number(rawDay);
    if (!rawMonth || !Number.isFinite(day) || day <= 0) return null;
    const leap = rawMonth.startsWith('闰');
    const key = leap ? rawMonth.slice(1) : rawMonth;
    const month = LUNAR_MONTHS[key];
    if (!month) return null;
    return { month, day, leap };
  } catch {
    return null;
  }
}

/** 某月第 n 个星期 w（w: 0=周日），返回日；不存在返回 0 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(year, month - 1, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  const lastDay = new Date(year, month, 0).getDate();
  return day <= lastDay ? day : 0;
}

export interface FestivalHit {
  def: FestivalDef;
  /** 命中的是农历那条（调用方日志/提示用） */
  lunar: boolean;
}

/** 这一天命中的节日（可能一天多个：如中秋与国庆相邻，但本表不含国庆，实际很少重复） */
export function festivalsOn(date: Date): FestivalHit[] {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  let lunar: LunarDate | null = null;
  const hits: FestivalHit[] = [];
  for (const def of FESTIVALS) {
    let hit = false;
    if (def.solar) hit = def.solar.month === month && def.solar.day === day;
    else if (def.nthWeekday) {
      const target = nthWeekdayOfMonth(year, def.nthWeekday.month, def.nthWeekday.weekday, def.nthWeekday.nth);
      hit = month === def.nthWeekday.month && target === day;
    } else if (def.lunar) {
      lunar ??= lunarOf(date);
      if (lunar && !lunar.leap) {
        const wantMonth = LUNAR_MONTHS[def.lunar.month] ?? 0;
        hit = lunar.month === wantMonth && lunar.day === def.lunar.day;
      }
    }
    if (hit) hits.push({ def, lunar: !!def.lunar });
  }
  return hits;
}

/** 动画池的动画名拍平（idle/turn/move + 各分类的 actions） */
export function collectAnimNames(animations: unknown): string[] {
  const out = new Set<string>();
  if (!animations || typeof animations !== 'object') return [];
  const record = animations as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'move']) {
    const value = record[key];
    if (Array.isArray(value)) for (const name of value) if (typeof name === 'string' && name) out.add(name);
  }
  const categories = record.categories;
  if (Array.isArray(categories)) {
    for (const category of categories) {
      if (!category || typeof category !== 'object') continue;
      const actions = (category as { actions?: unknown }).actions;
      if (Array.isArray(actions)) for (const name of actions) if (typeof name === 'string' && name) out.add(name);
    }
  }
  return [...out];
}

/**
 * 按关键词在**真实动画池**里挑一段；一个都不匹配就返回 null。
 *
 * 顺序有意义：关键词越靠前越想要（春节先找「拜年」，再退到「庆祝」「招手」）。
 * 匹配是「池内动画名包含关键词」，大小写不敏感。
 */
export function pickFestivalAnimation(animations: unknown, hints: readonly string[] | undefined): string | null {
  const names = collectAnimNames(animations);
  if (!names.length || !hints || hints.length === 0) return null;
  for (const hint of hints) {
    const wanted = hint.toLowerCase();
    const found = names.find((name) => name.toLowerCase().includes(wanted));
    if (found) return found;
  }
  return null;
}

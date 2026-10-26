/**
 * 设置窗口前端（ES module）——界面由 Shoelace Web Components 组装，无框架、无构建。
 *
 * 数据通道：preload 暴露的 `window.petSettings.request(method, path, body)` —— IPC 直达
 * helper 主进程，再转宿主路由（单进程应用里就是同一次 `handlePetRoute` 调用）。
 * **不经过本机 HTTP 服务**：没有端口、没有令牌、没有跨域。
 *
 * 接口（与浏览器版设置页 `src/standalone/pet-settings-page.ts` 读写同一批）：
 *   GET  /dsh-pet-7340/config       成品配置（默认 + 用户层，字段已填满）
 *   PUT  /dsh-pet-7340/config       保存用户层（手改的精调字段保留）
 *   POST /dsh-pet-7340/config       恢复默认
 *   POST /dsh-pet-7340/reload       按最新配置重建桌面窗口
 *   POST /dsh-pet-7340/whisper|chat|balance
 *   GET  /standalone-ai/settings    本机 AI 配置（脱敏，密钥不回显）
 *   POST /standalone-ai/settings    保存本机 AI 配置
 *   POST /standalone-ai/test        连通性测试
 */
import { setBasePath } from './vendor/shoelace/utilities/base-path.js';
import './vendor/shoelace/shoelace.js';

// 图标与其它资源从本地 vendor 取（离线；file:// 下不能靠 CDN）
setBasePath(new URL('./vendor/shoelace/', import.meta.url).href);

const $ = (id) => document.getElementById(id);

const DISPLAYS = [
  ['desktop', '仅桌面'],
  ['both', '桌面 + 网页'],
  ['web', '仅网页'],
  ['none', '都不显示'],
];
const CORNERS = [
  ['bottom-right', '右下'],
  ['bottom-left', '左下'],
  ['top-right', '右上'],
  ['top-left', '左上'],
];

const state = { pets: [], entries: [] };
let busy = false;
let aiAvailable = false;

// ---------- 基础 ----------
let statusTimer;
function say(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.dataset.error = String(error);
  // 无底栏的浮出提示：出现即淡入，成功类 2.6s 后自己收起（错误留久一点，够看清）
  el.dataset.show = 'true';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => {
      el.dataset.show = 'false';
    },
    error ? 6000 : 2600,
  );
}

/**
 * 互动结果（说一句 / 对话 / 余额）：直接显示成一行（可多行）文字。
 * @param variant 'success' 绿 / 'danger' 红 / 其它 灰
 */
function note(text, variant = 'primary') {
  const el = $('reply');
  el.textContent = text;
  el.dataset.tone = variant === 'success' ? 'ok' : variant === 'danger' ? 'error' : 'plain';
  el.hidden = !text;
}

function setBusy(value) {
  busy = value;
  for (const btn of document.querySelectorAll('sl-button')) btn.disabled = value;
}

/** 发一次请求并解析 JSON；非 2xx / 业务错误统一抛 Error（文案给用户看） */
async function request(method, path, body) {
  const api = window.petSettings;
  if (!api || typeof api.request !== 'function') {
    throw new Error('设置通道不可用：请从桌宠右键菜单打开设置窗口');
  }
  const res = await api.request(method, path, body === undefined ? undefined : JSON.stringify(body));
  const text = res && typeof res.body === 'string' ? res.body : '';
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res || typeof res.status !== 'number' || res.status >= 400) {
    const reason = data && (data.error || data.message);
    throw new Error(reason || '本机接口返回 ' + ((res && res.status) || '无响应'));
  }
  return data;
}

/** 确认框（替代 window.confirm：Electron 里那是系统模态，丑且会抢焦点） */
function confirmDialog(message, okText = '确定') {
  const dlg = $('dlg-confirm');
  $('dlg-message').textContent = message;
  $('dlg-ok').textContent = okText;
  return new Promise((resolve) => {
    let result = false;
    const onOk = () => {
      result = true;
      dlg.hide();
    };
    const onCancel = () => dlg.hide();
    const onHide = () => {
      $('dlg-ok').removeEventListener('click', onOk);
      $('dlg-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('sl-after-hide', onHide);
      resolve(result);
    };
    $('dlg-ok').addEventListener('click', onOk);
    $('dlg-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('sl-after-hide', onHide);
    dlg.show();
  });
}

/** 输入框对话框（替代 window.prompt）；取消返回 null */
function promptDialog(title, label, value) {
  const dlg = $('dlg-pet');
  dlg.label = title;
  const input = $('dlg-pet-name');
  input.label = label;
  input.value = value;
  return new Promise((resolve) => {
    let result = null;
    const onOk = () => {
      result = input.value;
      dlg.hide();
    };
    const onCancel = () => dlg.hide();
    const onHide = () => {
      $('dlg-pet-ok').removeEventListener('click', onOk);
      $('dlg-pet-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('sl-after-hide', onHide);
      resolve(result);
    };
    $('dlg-pet-ok').addEventListener('click', onOk);
    $('dlg-pet-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('sl-after-hide', onHide);
    dlg.show();
    input.focus();
  });
}

// ---------- 页签（自绘 + 滑动指示条） ----------
/**
 * 把指示条挪到当前页签下面。
 *
 * 位置/宽度都按「页签的实际矩形」算（相对 .tab-bar），所以无论字号、间距、窗口多宽，
 * 线永远与文字对齐；left/width 上有 CSS 过渡，切换时就是滑过去的效果。
 */
function moveIndicator(instant = false) {
  const bar = document.querySelector('.tab-bar');
  const active = bar ? bar.querySelector('.tab.active') : null;
  const indicator = document.querySelector('.tab-indicator');
  if (!bar || !active || !indicator) return;
  if (instant) indicator.classList.add('instant');
  const barRect = bar.getBoundingClientRect();
  const tabRect = active.getBoundingClientRect();
  indicator.style.left = tabRect.left - barRect.left + 'px';
  indicator.style.width = tabRect.width + 'px';
  if (instant) {
    // 落位后再恢复过渡（下一帧才移除，避免这一帧就被动画化）
    requestAnimationFrame(() => indicator.classList.remove('instant'));
  }
}

/** 页签 → 页头大标题（三个页签各有一个） */
const TAB_TITLES = { pet: '桌宠设置', festival: '节日设置', ai: 'AI 设置' };

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.panel === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  $('page-title').textContent = TAB_TITLES[name] || '桌宠设置';
  moveIndicator();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchTab(tab.dataset.panel));
}

// 首帧落位（不播动画）；窗口缩放/字体变化后重新对齐
requestAnimationFrame(() => moveIndicator(true));
window.addEventListener('resize', () => moveIndicator(true));
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => moveIndicator(true)).catch(() => undefined);
}

// ---------- 宠物卡片 ----------
function options(items) {
  return items.map(([value, label]) => '<sl-option value="' + value + '">' + label + '</sl-option>').join('');
}

function card(pet) {
  const el = document.createElement('sl-card');
  el.className = 'pet';
  el.dataset.id = pet.id;
  el.innerHTML =
    '<div slot="header" class="pet-head"><span class="pet-name"></span>' +
    '<sl-badge variant="neutral" pill class="pet-id"></sl-badge>' +
    '<sl-button class="del" size="small" variant="text">删除</sl-button></div>' +
    '<div class="grid">' +
    '<sl-input class="name" size="small" label="名称" maxlength="40"></sl-input>' +
    '<sl-input class="size" size="small" type="number" label="大小（像素）" min="80" max="1200" step="10"></sl-input>' +
    '<sl-select class="display" size="small" label="显示位置">' +
    options(DISPLAYS) +
    '</sl-select>' +
    '<sl-select class="corner" size="small" label="停靠角落">' +
    options(CORNERS) +
    '</sl-select>' +
    '<sl-input class="marginX" size="small" type="number" label="水平边距" min="-2000" max="4000" step="1"></sl-input>' +
    '<sl-input class="marginY" size="small" type="number" label="垂直边距" min="-2000" max="4000" step="1"></sl-input>' +
    '</div>' +
    '<div class="switch-row">' +
    '<sl-switch class="balanceEnabled" size="small">余额动画</sl-switch>' +
    '<sl-switch class="whisperEnabled" size="small">自动碎碎念</sl-switch>' +
    '<sl-switch class="workStatusEnabled" size="small">工作状态</sl-switch>' +
    '<sl-switch class="fixedEnabled" size="small">原地固定</sl-switch>' +
    '<sl-switch class="lockPosition" size="small">固定位置</sl-switch>' +
    '</div>' +
    '<sl-textarea class="whisperPrompt" size="small" label="人设（可选，留空则跟随宠物种类默认）" rows="2" maxlength="2000"></sl-textarea>';

  const nameEl = el.querySelector('.name');
  const titleEl = el.querySelector('.pet-name');
  titleEl.textContent = pet.name || pet.id;
  nameEl.value = pet.name || pet.id;
  nameEl.addEventListener('sl-input', () => {
    titleEl.textContent = nameEl.value || pet.id;
  });
  el.querySelector('.pet-id').textContent = pet.id;
  el.querySelector('.size').value = String(pet.size);
  el.querySelector('.marginX').value = String(pet.position ? pet.position.marginX : 0);
  el.querySelector('.marginY').value = String(pet.position ? pet.position.marginY : 0);
  el.querySelector('.balanceEnabled').checked = pet.balanceEnabled !== false;
  el.querySelector('.whisperEnabled').checked = pet.whisperEnabled !== false;
  el.querySelector('.workStatusEnabled').checked = pet.workStatusEnabled !== false;
  el.querySelector('.fixedEnabled').checked = pet.fixedEnabled === true;
  el.querySelector('.lockPosition').checked = pet.lockPosition === true;
  el.querySelector('.whisperPrompt').value = typeof pet.whisperPrompt === 'string' ? pet.whisperPrompt : '';

  el.querySelector('.del').addEventListener('click', async () => {
    if (state.pets.length <= 1) {
      note('至少要保留一只桌宠。', 'warning');
      return;
    }
    if (!(await confirmDialog('删除「' + (pet.name || pet.id) + '」？只影响本机配置。', '删除'))) return;
    state.pets = state.pets.filter((p) => p.id !== pet.id);
    renderAll();
  });

  return el;
}

/**
 * 重建宠物卡片。
 * **只在成员真的变了时调用**（增删宠物 / 首次加载）——保存配置时调它会把所有输入框
 * 连同滚动位置一起重建，看起来就是"闪一下"。
 */
function renderPets() {
  $('pets').replaceChildren(...state.pets.map(card));
  // Shoelace 的 sl-select 在**元素还没进文档 / option 还没分配到 slot** 时设 value 会被忽略
  // （表现为下拉框一片空白，配置值全丢）。等一帧让 slotchange 走完再回填。
  requestAnimationFrame(() => {
    for (const pet of state.pets) {
      const el = $('pets').querySelector('[data-id="' + CSS.escape(pet.id) + '"]');
      if (!el) continue;
      el.querySelector('.display').value = pet.display;
      el.querySelector('.corner').value = pet.position ? pet.position.corner : 'bottom-right';
    }
  });
}

/** 刷新「对哪只」下拉（选项与名称） */
function renderTarget() {
  const target = $('target');
  const previous = target.value;
  target.replaceChildren(
    ...state.pets.map((p) => {
      const opt = document.createElement('sl-option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      return opt;
    }),
  );
  requestAnimationFrame(() => {
    target.value = previous && state.pets.some((p) => p.id === previous) ? previous : state.pets[0]?.id || '';
  });
}

/** 文件宠物那一行说明 */
function renderEntries() {
  $('entries').replaceChildren(
    ...state.entries.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }),
  );
}

function renderAll() {
  renderPets();
  renderTarget();
  renderEntries();
  renderFestivals();
}

function collect() {
  const pets = state.pets.map((pet) => {
    const el = $('pets').querySelector('[data-id="' + CSS.escape(pet.id) + '"]');
    const person = el.querySelector('.whisperPrompt').value.trim();
    const item = {
      id: pet.id,
      name: el.querySelector('.name').value.trim() || pet.id,
      size: Number(el.querySelector('.size').value),
      balanceEnabled: el.querySelector('.balanceEnabled').checked,
      whisperEnabled: el.querySelector('.whisperEnabled').checked,
      workStatusEnabled: el.querySelector('.workStatusEnabled').checked,
      fixedEnabled: el.querySelector('.fixedEnabled').checked,
      lockPosition: el.querySelector('.lockPosition').checked,
      display: el.querySelector('.display').value,
      position: {
        corner: el.querySelector('.corner').value,
        marginX: Number(el.querySelector('.marginX').value),
        marginY: Number(el.querySelector('.marginY').value),
      },
    };
    if (person) item.whisperPrompt = person;
    return item;
  });
  return {
    pets,
    globals: {
      trayEnabled: $('trayEnabled').checked,
      clickSoundEnabled: $('clickSoundEnabled').checked,
      confineToScreen: $('confineToScreen').checked,
      whisperImageEnabled: $('whisperImageEnabled').checked,
      chatImageEnabled: $('chatImageEnabled').checked,
      // 仅保持待机动画（全局）：true 时渲染端只播 idle 链
      idleOnly: $('idleOnly').checked,
      // 监测 DSH 进度：读会话事件 → 气泡 + 通知图标
      watchDsh: $('watchDsh').checked,
      // 节日：只写「与默认不同」的项，避免把 20 多个节日全铺进配置文件
      festivals: collectFestivals(),
    },
  };
}

/** 节日配置：{ enabled, items: { <id>: { text?, anim?, enabled? } } } */
function collectFestivals() {
  const items = {};
  for (const row of $('festivals').querySelectorAll('.festival')) {
    const id = row.dataset.id;
    if (!id) continue;
    const text = row.querySelector('.f-text').value.trim();
    const animValue = row.querySelector('.f-anim').value;
    const on = row.querySelector('.f-on').checked;
    const entry = {};
    if (text) entry.text = text;
    // __auto__ = 按关键词自动匹配（配置里不写这个键）；'' = 明确不播动画
    if (animValue === '') entry.anim = null;
    else if (animValue && animValue !== '__auto__') entry.anim = animValue;
    if (!on) entry.enabled = false;
    if (Object.keys(entry).length > 0) items[id] = entry;
  }
  return { enabled: $('festivalsEnabled').checked, items };
}

/** 动画池里的真实动画名（给节日动画下拉用；不虚构，只列池里有的） */
function poolAnimNames(animations) {
  const names = new Set();
  if (!animations || typeof animations !== 'object') return [];
  for (const key of ['idle', 'turn', 'move']) {
    if (Array.isArray(animations[key])) for (const name of animations[key]) if (typeof name === 'string' && name) names.add(name);
  }
  if (Array.isArray(animations.categories)) {
    for (const category of animations.categories) {
      if (category && Array.isArray(category.actions)) {
        for (const name of category.actions) if (typeof name === 'string' && name) names.add(name);
      }
    }
  }
  return [...names];
}

/** 把服务端返回的成品配置同步进本地状态与全局开关（不碰宠物卡片 DOM） */
function syncState(merged) {
  const main = merged && merged.main ? merged.main : {};
  state.pets = (Array.isArray(main.pets) ? main.pets : []).map((pet) => ({ ...pet }));
  state.entries = Object.keys(merged || {})
    .filter((entry) => entry !== 'main')
    .map((entry) => {
      const names = (merged[entry] && Array.isArray(merged[entry].pets) ? merged[entry].pets : [])
        .map((p) => p.name || p.id)
        .join('、');
      return '文件宠物「' + entry + '-config.json」：' + (names || '（无实例）') + '（在 pet/ 目录维护，不在此处编辑）';
    });
  $('trayEnabled').checked = main.trayEnabled !== false;
  $('clickSoundEnabled').checked = main.clickSoundEnabled === true;
  $('confineToScreen').checked = main.confineToScreen === true;
  $('whisperImageEnabled').checked = main.whisperImageEnabled !== false;
  $('chatImageEnabled').checked = main.chatImageEnabled !== false;
  $('idleOnly').checked = main.idleOnly === true;
  $('watchDsh').checked = main.watchDsh === true;
  // 节日：总开关 + 逐节日的覆盖（文案/动画/禁用）
  state.animations = main.animations;
  state.festivals = main.festivals && typeof main.festivals === 'object' ? main.festivals : {};
  $('festivalsEnabled').checked = state.festivals.enabled !== false;
}

/**
 * 节日列表：一行一个节日（名称 / 文案 / 动画 / 开关）。
 * 动画下拉只列**当前动画池里真实存在**的名字 + 「自动匹配」+「不播动画」，不会出现虚构选项。
 */
function renderFestivals() {
  const host = $('festivals');
  if (!host) return;
  const defs = Array.isArray(state.festivalDefs) ? state.festivalDefs : [];
  if (defs.length === 0) {
    host.replaceChildren();
    return;
  }
  const items = (state.festivals && state.festivals.items) || {};
  const anims = poolAnimNames(state.animations);
  host.replaceChildren(
    ...defs.map((def) => {
      const row = document.createElement('div');
      row.className = 'festival';
      row.dataset.id = def.id;

      const name = document.createElement('span');
      name.className = 'festival-name';
      name.textContent = def.name + (def.lunar ? '（农历）' : '');
      name.title = def.name;

      const text = document.createElement('sl-input');
      text.className = 'f-text';
      text.setAttribute('size', 'small');
      text.setAttribute('maxlength', '120');
      text.placeholder = '默认：' + def.text;

      const anim = document.createElement('sl-select');
      anim.className = 'f-anim';
      anim.setAttribute('size', 'small');
      anim.setAttribute('hoist', '');
      const options = [['__auto__', '自动匹配'], ['', '不播动画'], ...anims.map((n) => [n, n])];
      for (const [value, label] of options) {
        const option = document.createElement('sl-option');
        option.value = value;
        option.textContent = label;
        anim.appendChild(option);
      }

      const on = document.createElement('sl-switch');
      on.className = 'f-on';
      on.setAttribute('size', 'small');

      // 试播：走宿主同一条执行路径，宠物立刻说这句（方便随时验证效果，不必等到节日）
      const play = document.createElement('sl-icon-button');
      play.className = 'f-play';
      play.setAttribute('name', 'play-fill');
      play.setAttribute('label', '试一次');
      play.title = '立刻试一次';
      play.addEventListener('click', async () => {
        try {
          const res = await request('POST', '/dsh-pet-7340/festival-preview', { id: def.id });
          if (res && res.ok) {
            // 「仅保持待机动画」开着也照播：提示里顺便说明这是被忽略的那一项，用户不会以为开关失效
            const ignored = $('idleOnly').checked ? '（已忽略「仅保持待机动画」）' : '';
            say(
              (res.anim
                ? '已试播「' + def.name + '」：播放动画「' + res.anim + '」+ 气泡'
                : '已试播「' + def.name + '」：没有匹配到动画，只弹气泡') + ignored,
            );
          } else {
            say('试播失败：' + ((res && (res.reason || res.message)) || '未知原因'), true);
          }
        } catch (error) {
          say(error.message || '试播失败', true);
        }
      });

      row.append(name, text, anim, on, play);
      return row;
    }),
  );
  // 回填：Shoelace 的 sl-input/sl-select 在进文档、option 分配前设 value 会被忽略 → 等一帧
  requestAnimationFrame(() => {
    for (const def of defs) {
      const row = host.querySelector('.festival[data-id="' + CSS.escape(def.id) + '"]');
      if (!row) continue;
      const item = items[def.id] || {};
      row.querySelector('.f-text').value = typeof item.text === 'string' ? item.text : '';
      row.querySelector('.f-anim').value =
        item.anim === null ? '' : typeof item.anim === 'string' && item.anim ? item.anim : '__auto__';
      const on = row.querySelector('.f-on');
      on.checked = item.enabled !== false;
      row.classList.toggle('is-off', item.enabled === false);
      on.addEventListener('sl-change', () => row.classList.toggle('is-off', !on.checked));
    }
  });
}

/** 首次加载 / 恢复默认：状态 + 全量重绘 */
function applyConfig(merged) {
  syncState(merged);
  renderAll();
}

// ---------- 桌宠动作 ----------
$('add').addEventListener('click', async () => {
  const name = await promptDialog('添加宠物', '名字', '新桌宠');
  if (name === null) return;
  let n = state.pets.length + 1;
  let id = 'pet' + n;
  while (state.pets.some((p) => p.id === id)) {
    n += 1;
    id = 'pet' + n;
  }
  // 新宠物不要都塞在同一个角落：按当前数量轮流分配到四个角，每绕一圈再往里错开一点，
  // 避免新加的那只被已有的完全盖住（看不见、也没法拖）。
  const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  const slot = state.pets.length;
  const corner = CORNERS[slot % CORNERS.length];
  const ring = Math.floor(slot / CORNERS.length);
  state.pets.push({
    id,
    name: (name || '').trim() || id,
    size: 360,
    balanceEnabled: true,
    whisperEnabled: true,
    workStatusEnabled: true,
    fixedEnabled: false,
    display: 'desktop',
    position: { corner, marginX: 24 + ring * 56, marginY: 24 + ring * 56 },
  });
  renderAll();
  // 添加是明确动作，不该再让用户点一次「保存并应用」：直接把这份新列表提交上去，
  // 宿主保存后会重建桌面窗口，新宠物当场出现。
  //
  // 为什么提交前要等一帧：collect() 是从**卡片 DOM** 读值的，而 renderAll 刚把卡片插进文档，
  // 同一 tick 里读有时还读不到新卡片（表现为"点击添加后没反应/新宠物没落盘"）。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const ok = await savePetConfig();
  say(ok ? '已添加「' + id + '」，已直接显示到桌面。' : '已添加「' + id + '」，但保存失败：请点「保存并应用」重试。', !ok);
});

/**
 * 保存桌宠配置（桌宠页与节日页共用同一份提交逻辑：形态一致，不会出现两套校验）。
 * @returns {Promise<boolean>} 是否真的保存成功（被 busy 挡掉或请求失败时为 false）
 */
async function savePetConfig() {
  if (busy) return false;
  setBusy(true);
  say('正在保存…');
  let ok = false;
  try {
    const { pets, globals } = collect();
    // 兜底：DOM 里少读了宠物（卡片刚插入、尚未渲染完）→ 以 state 为准补齐。
    // 否则"添加宠物"会静默丢掉刚加的那只（点了添加却什么都没发生）。
    if (pets.length !== state.pets.length) {
      const seen = new Set(pets.map((pet) => pet.id));
      for (const pet of state.pets) {
        if (!seen.has(pet.id)) pets.push({ ...pet });
      }
    }
    const merged = await request('PUT', '/dsh-pet-7340/config', { pets, ...globals });
    // 只同步状态与两处轻量列表，**不重建卡片**：重建会销毁正在编辑的输入框、重置滚动位置，
    // 看起来就是"点保存闪一下"。卡片内容是用户刚输入的，本来就该保持原样。
    syncState(merged);
    renderTarget();
    renderEntries();
    ok = true;
    markDirty(false); // 保存成功：收掉左下角的未保存提醒
    say('已保存，桌面宠物已按新配置生效。');
  } catch (error) {
    say(error.message || '保存失败', true);
  } finally {
    setBusy(false);
  }
  return ok;
}

// ---------- 未保存提醒：改了任何一项就在左下角摇一下，提示保存 ----------
let dirty = false;

/**
 * 切换"有未保存修改"状态：出现提示并重播一次左右摇晃。
 * @param {boolean} next
 */
function markDirty(next) {
  if (dirty === next) return;
  dirty = next;
  const hint = $('dirty-hint');
  hint.hidden = !next;
  document.body.dataset.dirty = String(next);
  if (!next) return;
  // 重播摇晃：先移除类、强制回流再加回去，否则连续修改时只有第一次会摇
  hint.classList.remove('is-shaking');
  void hint.offsetWidth;
  hint.classList.add('is-shaking');
}

/** 只认"配置控件"（输入框/下拉/开关/滑块）；按钮点击、试播这类交互不算改动 */
function isConfigControl(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest('sl-input, sl-select, sl-textarea, sl-switch, sl-checkbox, input, textarea, select');
}

for (const type of ['input', 'change', 'sl-change']) {
  document.addEventListener(
    type,
    (event) => {
      if (isConfigControl(event.target)) markDirty(true);
    },
    true,
  );
}

// 三个「保存并应用」（桌宠页 / 节日页 / 未保存提示里的那个）
for (const button of document.querySelectorAll('.js-save-pet')) {
  button.addEventListener('click', savePetConfig);
}

// DSH 进度「试一下」：不必真的制造模型错误，依次把五种反应演一遍（含 notify-* 图标）
$('watch-dsh-test').addEventListener('click', async () => {
  const kinds = ['start', 'done', 'error', 'ask', 'approval'];
  say('正在演示 DSH 进度反应，请看桌面上的宠物…');
  for (const kind of kinds) {
    try {
      await request('POST', '/dsh-pet-7340/dsh-watch-preview', { kind });
    } catch (error) {
      say(error.message || '演示失败', true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2400));
  }
  say('演示结束：开始 / 完成 / 出错 / 被提问 / 要确认 都放过了。');
});

$('reload').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await request('POST', '/dsh-pet-7340/reload');
    markDirty(false); // 重载 = 以磁盘配置为准，未保存的改动作废
    say('已重载：桌面宠物已按最新配置刷新。');
  } catch (error) {
    say(error.message || '重载失败', true);
  } finally {
    setBusy(false);
  }
});

$('reset').addEventListener('click', async () => {
  if (busy) return;
  if (!(await confirmDialog('恢复默认会覆盖本机配置（含宠物大小/位置/开关）。确定继续？', '恢复默认'))) return;
  setBusy(true);
  try {
    // 恢复默认是整份替换：卡片内容全部作废，必须全量重绘
    applyConfig(await request('POST', '/dsh-pet-7340/config'));
    markDirty(false); // 恢复默认已整份重绘，没有"未保存"可谈了
    say('已恢复默认配置。');
  } catch (error) {
    say(error.message || '恢复默认失败', true);
  } finally {
    setBusy(false);
  }
});

$('whisper').addEventListener('click', async () => {
  if (busy) return;
  const pet = $('target').value;
  if (!pet) {
    note('还没有可对话的桌宠。', 'warning');
    return;
  }
  setBusy(true);
  note('正在生成…', 'neutral');
  try {
    const res = await request('POST', '/dsh-pet-7340/whisper?pet=' + encodeURIComponent(pet));
    if (res && res.ok) note(res.text, 'success');
    else note('没能生成：' + ((res && (res.message || res.reason)) || '未知原因'), 'danger');
  } catch (error) {
    note(error.message || '请求失败', 'danger');
  } finally {
    setBusy(false);
  }
});

$('balance').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  note('正在查询余额…', 'neutral');
  try {
    await request('POST', '/dsh-pet-7340/balance');
    const snapshot = await request('GET', '/dsh-pet-7340/state');
    const data = snapshot && snapshot.sections && snapshot.sections.balance ? snapshot.sections.balance.data : null;
    if (!data) note('没有读到余额。', 'warning');
    else if (data.ok === false) note('余额不可用：' + (data.message || data.reason || '未知原因'), 'warning');
    else if (data.shape === 'money')
      note(data.data.wallets.map((w) => (w.currency || '') + ' ' + w.total).join(' / ') || '余额为 0', 'success');
    else if (data.shape === 'windows') note('月度已用 ' + Math.round(Number(data.data.monthly) || 0) + '%', 'success');
    else if (data.shape === 'points') note('余额 ' + data.data.total + (data.data.unit || ''), 'success');
    else note('已获取余额数据（自定义形态，气泡里可见）。', 'success');
  } catch (error) {
    note(error.message || '请求失败', 'danger');
  } finally {
    setBusy(false);
  }
});

async function sendChat() {
  if (busy) return;
  const input = $('chatText');
  const text = input.value.trim();
  if (!text) return;
  const pet = $('target').value;
  if (!pet) {
    note('还没有可对话的桌宠。', 'warning');
    return;
  }
  setBusy(true);
  note('正在思考…', 'neutral');
  try {
    const res = await request('POST', '/dsh-pet-7340/chat?pet=' + encodeURIComponent(pet), { text });
    if (res && res.ok) {
      input.value = '';
      note('你：' + text + '\n它：' + res.text, 'success');
    } else {
      note('没能回复：' + ((res && (res.message || res.reason)) || '未知原因'), 'danger');
    }
  } catch (error) {
    note(error.message || '请求失败', 'danger');
  } finally {
    setBusy(false);
  }
}
$('chat').addEventListener('click', sendChat);
$('chatText').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendChat();
  }
});

// ---------- AI ----------
/** 「自定义…」这个选项的值：选中它时改用下面的手填框 */
const CUSTOM_MODEL = '__custom__';

/** 当前选中的模型名（下拉，或自定义输入框） */
function currentModel() {
  const select = $('model');
  return String(select.value === CUSTOM_MODEL ? $('modelCustom').value : select.value || '').trim();
}

/** 选中「自定义…」时才露出输入框 */
function syncModelCustom() {
  $('modelCustom').hidden = $('model').value !== CUSTOM_MODEL;
}

/**
 * 用最新拿到的模型清单重建下拉框。
 *
 * @param models  接口返回的模型 id 列表（可能是空数组：接口没实现 /models）
 * @param selected 要选中的值；即使它不在清单里也保留成一个选项（自定义接口常见）
 */
function setModelOptions(models, selected) {
  const select = $('model');
  const value = String(selected || '').trim();
  const list = [
    ...new Set([...(value ? [value] : []), ...models.map((model) => String(model).trim()).filter(Boolean)]),
  ];
  select.replaceChildren(
    ...list.map((id) => {
      const option = document.createElement('sl-option');
      option.value = id;
      option.textContent = id;
      return option;
    }),
    (() => {
      const option = document.createElement('sl-option');
      option.value = CUSTOM_MODEL;
      option.textContent = '自定义（手动填写）…';
      return option;
    })(),
  );
  // sl-select 在 option 还没分配到 slot 时设 value 会被忽略 → 等一帧再回填
  requestAnimationFrame(() => {
    select.value = value || list[0] || CUSTOM_MODEL;
    syncModelCustom();
  });
}

$('model').addEventListener('sl-change', syncModelCustom);

function applyAi(data) {
  for (const id of ['protocol', 'baseUrl', 'whisperIntervalSec', 'maxTokens']) {
    if (data[id] !== undefined) $(id).value = String(data[id]);
  }
  // 模型走下拉：已保存的值先作为唯一选项，点「检查」后再换成接口返回的完整清单
  $('modelCustom').value = data.model || '';
  setModelOptions([], data.model || '');
  for (const id of ['enabled', 'automaticWhispers']) $(id).checked = data[id] === true;
  $('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
  $('key-state').dataset.tone = data.hasKey ? 'ok' : 'plain';
  $('apiKey').value = '';
  $('clearApiKey').checked = false;
}

async function loadAiSettings() {
  try {
    applyAi((await request('GET', '/standalone-ai/settings')) || {});
    aiAvailable = true;
  } catch (error) {
    aiAvailable = false;
    showTestResult('当前模式无法读写 AI 设置：' + (error.message || '接口不可用'), 'danger');
  }
}

/**
 * 检查结果显示成按钮下方的一行小字（不再用 sl-alert 那个大框）。
 * @param variant 'success' 绿 / 'danger' 红 / 其它 灰
 */
function showTestResult(text, variant) {
  const el = $('test-result');
  el.textContent = text;
  el.dataset.tone = variant === 'success' ? 'ok' : variant === 'danger' ? 'error' : 'plain';
  el.hidden = !text;
}

$('clearApiKey').addEventListener('sl-change', (event) => {
  const cleared = $('clearApiKey').checked;
  $('apiKey').disabled = cleared;
  if (cleared) {
    $('apiKey').value = '';
    $('enabled').checked = false;
    $('automaticWhispers').checked = false;
  }
  event.stopPropagation();
});

$('test-btn').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  showTestResult('正在检查地址并获取模型列表…', 'neutral');
  try {
    const res = await request('POST', '/standalone-ai/test', {
      protocol: $('protocol').value,
      baseUrl: $('baseUrl').value.trim(),
      model: currentModel(),
      apiKey: $('apiKey').value,
    });
    // 把清单灌进下拉。当前值若不在清单里就**自动改选第一个**——那种情况多半就是模型名
    // 写错（不少中转发现在找不到该模型时会回 503），留着旧值只会继续失败。
    const models = res && Array.isArray(res.models) ? res.models : [];
    if (models.length > 0) {
      const current = currentModel();
      setModelOptions(models, models.includes(current) ? current : models[0]);
    }
    let text = (res && res.message) || '检查完成';
    if (res && res.reply) text += '（模型回复：' + res.reply + '）';
    showTestResult(text, res && res.ok ? 'success' : 'danger');
  } catch (error) {
    showTestResult(error.message || '检查失败', 'danger');
  } finally {
    setBusy(false);
  }
});

$('ai-save').addEventListener('click', async () => {
  if (busy) return;
  if (!aiAvailable) {
    say('当前模式无法保存 AI 设置：接口不可用。', true);
    return;
  }
  const model = currentModel();
  if (!model) {
    say('请先点「检查 / 获取模型」，再在下拉框里选一个模型（接口不返回清单时选「自定义」手填）。', true);
    return;
  }
  setBusy(true);
  say('正在保存 AI 设置…');
  try {
    const body = {
      protocol: $('protocol').value,
      baseUrl: $('baseUrl').value.trim(),
      model,
      clearApiKey: $('clearApiKey').checked,
      enabled: $('enabled').checked,
      automaticWhispers: $('automaticWhispers').checked,
      whisperIntervalSec: Number($('whisperIntervalSec').value),
      maxTokens: Number($('maxTokens').value),
    };
    const key = $('apiKey').value;
    if (key) body.apiKey = key;
    applyAi((await request('POST', '/standalone-ai/settings', body)) || {});
    markDirty(false);
    say('AI 设置已保存。');
  } catch (error) {
    say('AI 设置未保存：' + (error.message || '请检查接口地址、模型名称与密钥'), true);
  } finally {
    setBusy(false);
  }
});

// ---------- 滚轮：数值输入框上滚动只调数值，不滚背景 ----------
// 关键点：Chromium 的滚动是"光标下最内层可滚动祖先"的**默认行为**，跟事件冒泡无关——
// 只 stopPropagation 是没用的（上一版就栽在这）。必须 preventDefault 才能真正挡住背景滚动；
// 而 preventDefault 会连带挡掉 number 输入框原生的滚轮加减，所以这里自己实现一次加减，
// 两端行为都保住：滚轮能调值、背景纹丝不动。
document.addEventListener(
  'wheel',
  (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const host = target.closest('sl-input[type="number"], input[type="number"]');
    if (!host) return;
    event.preventDefault(); // 挡住背景滚动（以及原生改值，下面自己算）
    if (document.activeElement !== host && !host.matches(':focus-within')) return;

    const step = Number(host.getAttribute('step')) || 1;
    const min = host.hasAttribute('min') ? Number(host.getAttribute('min')) : -Infinity;
    const max = host.hasAttribute('max') ? Number(host.getAttribute('max')) : Infinity;
    const current = Number(host.value);
    if (!Number.isFinite(current)) return;
    const next = Math.min(max, Math.max(min, current + (event.deltaY < 0 ? step : -step)));
    if (next === current) return;
    host.value = String(next);
    // 通知上层（表单收集读的是 .value，这里只是让其它监听者也知道值变了）
    host.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
  },
  { passive: false },
);

// ---------- 悬浮操作条：滚动时渐隐 ----------
// 按钮组固定在右下角，用户滚动时它会压过正文 —— 滚动期间降到 45% 让文字透出来，
// 停下 0.7s 恢复；鼠标移到按钮上（CSS :hover）立刻恢复不透明。
//
// 为什么盯 wheel 而不是容器的 scroll 事件：滚动发生在 Shoelace tab-group 的 shadow DOM 里，
// 而组件升级、布局撑开、数据填充都会触发一堆 scroll（scrollTop 未必变），拿它做触发会让
// 按钮在窗口刚打开时就自己闪一下。wheel 只在用户真的滚时出现，且能冒泡出 shadow DOM。
let fadeTimer;
function fadeActions() {
  for (const el of document.querySelectorAll('.actions')) el.classList.add('is-scrolling');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    for (const el of document.querySelectorAll('.actions')) el.classList.remove('is-scrolling');
  }, 700);
}
window.addEventListener('wheel', fadeActions, { passive: true, capture: true });
window.addEventListener('touchmove', fadeActions, { passive: true, capture: true });

// ---------- 主题（浅色 / 深色） ----------
// <html> 上的 sl-theme-dark 同时驱动两套东西：Shoelace 组件（dark.css 的 .sl-theme-dark 作用域）
// 与本页骨架（settings.css 里的语义变量）。选择记在 localStorage，下次打开沿用。
const THEME_KEY = 'dsh-pet-settings-theme';

function applyTheme(dark) {
  document.documentElement.classList.toggle('sl-theme-dark', dark);
  document.documentElement.classList.toggle('sl-theme-light', !dark);
  const btn = $('theme-btn');
  if (btn) btn.title = dark ? '切换到浅色' : '切换到深色';
  // 通知宠物窗口（右键菜单这类浮层跟着换色）
  if (window.petBridge && typeof window.petBridge.setTheme === 'function') {
    window.petBridge.setTheme(dark ? 'dark' : 'light');
  }
}

(function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* file:// 下 localStorage 偶尔被禁：按浅色走，不影响功能 */
  }
  applyTheme(saved === 'dark');
  $('theme-btn').addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('sl-theme-dark');
    applyTheme(dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      /* 存不了就只在本次生效 */
    }
  });
})();

// ---------- 窗口按钮 ----------
const petWindow = window.petWindow;
function closeWindow() {
  if (petWindow && typeof petWindow.close === 'function') petWindow.close();
  else window.close();
}
if (petWindow && typeof petWindow.minimize === 'function') {
  $('win-min').addEventListener('click', () => petWindow.minimize());
} else {
  $('win-min').hidden = true;
}
$('win-close').addEventListener('click', closeWindow);

// Esc 关窗（焦点在输入框里时不抢；Shoelace 的输入框是 shadow DOM，用 composedPath 判断）
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const dialogOpen = $('dlg-confirm').open || $('dlg-pet').open;
  if (dialogOpen) return;
  const path = event.composedPath();
  const typing = path.some(
    (node) => node instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SL-INPUT', 'SL-TEXTAREA', 'SL-SELECT'].includes(node.tagName),
  );
  if (typing) return;
  closeWindow();
});

// ---------- 启动 ----------
/**
 * 页头右上角的三条路径（配置 / API / 日志）：点一下在资源管理器里定位。
 *
 * 颜色跟主题走（灰字 + hover 变深 + 虚线下划线），不画成蓝色超链接——这三条是"本地文件位置"，
 * 不是需要跳转的网页。
 */
function renderPaths(meta) {
  const host = $('paths');
  const rows = [
    ['配置', meta && meta.user],
    ['API', meta && meta.ai],
    ['日志', meta && meta.logs],
  ];
  host.replaceChildren(
    ...rows
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([label, value]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'path-link';
        button.textContent = label + ' ' + value;
        button.title = value + '\n点击打开所在位置';
        button.addEventListener('click', () => {
          if (window.petBridge && typeof window.petBridge.revealPath === 'function') {
            window.petBridge.revealPath(value);
          }
        });
        return button;
      }),
  );
}

async function boot() {
  try {
    // 节日清单（id / 名称 / 默认文案）：与宿主的 src/shared/festivals.ts 同一份数据，
    // 设置页只负责把用户的覆盖值渲染出来，不在前端重复维护节日表。
    try {
      const list = await request('GET', '/dsh-pet-7340/festivals');
      state.festivalDefs = Array.isArray(list && list.items) ? list.items : [];
    } catch {
      state.festivalDefs = [];
    }
    applyConfig(await request('GET', '/dsh-pet-7340/config'));
    try {
      const meta = await request('GET', '/dsh-pet-7340/config/meta');
      renderPaths(meta);
    } catch {
      $('paths').replaceChildren();
    }
    await loadAiSettings();
    say('已读取本机配置。');
  } catch (error) {
    say(error.message || '读取配置失败', true);
  } finally {
    // 数据到位（或失败）之后才揭示内容区：首帧不再闪一屏空卡片/空下拉。
    // 放在 finally 里，加载失败也要能看见界面与报错。
    $('tabsBody').classList.remove('is-loading');
    // 告诉主进程"可以显示窗口了"：窗口的首帧就是完整内容（否则会先露出骨架）
    if (window.petWindow && typeof window.petWindow.ready === 'function') window.petWindow.ready();
  }
}

void boot();

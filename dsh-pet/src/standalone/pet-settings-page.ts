/**
 * 独立桌宠的**本机设置页**（原生 HTML/CSS/JS，零框架）。
 *
 * 为什么需要它：DSH 内的设置页是 React + `settings.section` 插槽（`src/client/app.ts`），
 * 那道插槽只有 DSH 页面才有；独立模式/单进程应用里没有页面宿主，此前改大小/位置/多开
 * 只能手改 `main-config.jsonc` 再重启——等于功能少了一半。
 *
 * 这一页把插件**已有的 HTTP 契约**当后端，不新增业务逻辑：
 *   GET  /dsh-pet-7340/config       成品配置（默认 + 用户层，字段已填满）
 *   PUT  /dsh-pet-7340/config       保存用户层（白名单重建，手改的精调字段保留）
 *   POST /dsh-pet-7340/config       恢复默认（内置默认原文落盘）
 *   POST /dsh-pet-7340/reload       按最新配置重建桌面窗口
 *   POST /dsh-pet-7340/whisper      让宠物说一句 / /chat 对话 / /balance 查余额
 *
 * 安全口径与 AI 设置页一致：页面本身是静态资源（无令牌可看），**所有读写都要
 * `X-DSH-Pet-Token`**；令牌只经地址的 `#token=` 递进来，读出来立刻从地址栏抹掉。
 */

/** 卡片里可编辑的宠物字段（与 saveUserConfig 的白名单同口径） */
const PET_DISPLAYS = [
  ['desktop', '仅桌面'],
  ['both', '桌面 + 网页'],
  ['web', '仅网页'],
  ['none', '都不显示'],
] as const;

const CORNERS = [
  ['bottom-right', '右下'],
  ['bottom-left', '左下'],
  ['top-right', '右上'],
  ['top-left', '左上'],
] as const;

export const petSettingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="stylesheet" href="/settings/app.css">
<script src="/settings/app.js" defer></script></head><body>
<main>
<header><p class="local">独立桌宠 / 本机设置</p><h1>桌宠设置</h1>
<p class="intro">调整宠物数量、大小、位置与显示方式，也可以在这里和它说句话。<br>所有配置只保存在本机，保存后桌面窗口会按新配置重建（约 1–3 秒）。</p></header>

<section class="panel">
  <div class="panel-head"><h2>宠物</h2><button id="add" type="button" class="ghost">+ 添加宠物</button></div>
  <div id="pets" class="pets"></div>
  <div id="entries" class="entries"></div>
</section>

<section class="panel">
  <h2>全局选项</h2>
  <div class="check-grid">
    <label class="check"><input id="trayEnabled" type="checkbox">显示系统托盘图标</label>
    <label class="check"><input id="clickSoundEnabled" type="checkbox">点击音效</label>
    <label class="check"><input id="confineToScreen" type="checkbox">锁定在当前屏幕</label>
    <label class="check"><input id="whisperImageEnabled" type="checkbox">碎碎念配图</label>
    <label class="check"><input id="chatImageEnabled" type="checkbox">对话配图</label>
    <label class="check"><input id="notificationsEnabled" type="checkbox">系统通知（仅浏览器端）</label>
  </div>
</section>

<section class="panel">
  <h2>和它互动</h2>
  <div class="row">
    <label for="target" class="inline">对哪只</label>
    <select id="target"></select>
    <button id="whisper" type="button" class="ghost">说一句</button>
    <button id="balance" type="button" class="ghost">查看余额</button>
  </div>
  <div class="row">
    <input id="chatText" type="text" maxlength="2000" placeholder="说点什么，回车发送…" autocomplete="off">
    <button id="chat" type="button" class="ghost">对话</button>
  </div>
  <p id="reply" class="reply" role="status" aria-live="polite"></p>
</section>

<footer>
  <div class="paths"><p id="paths">正在读取配置路径…</p></div>
  <div class="actions">
    <button id="openAi" type="button" class="ghost">AI 设置</button>
    <button id="reload" type="button" class="ghost">重载配置</button>
    <button id="reset" type="button" class="ghost">恢复默认</button>
    <button id="save" type="button">保存并应用</button>
  </div>
</footer>
<p id="status" role="status" aria-live="polite">正在读取本机设置…</p>
<noscript>需要启用 JavaScript 才能修改设置。请从桌宠右键菜单打开本页。</noscript>
</main></body></html>`;

export const petSettingsStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa;--warn:#a13b30}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:15px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:820px;margin:40px auto;padding:0 22px 40px}
header{padding:0 10px 22px}.local{font-size:13px;color:var(--muted);margin:0 0 8px}
h1{font-size:30px;line-height:1.3;margin:0 0 12px;font-weight:700}.intro{margin:0;color:var(--muted);font-size:14px}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin-bottom:18px}
.panel h2{font-size:18px;margin:0 0 16px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.panel-head h2{margin:0}
.pets{display:grid;gap:16px}
.pet{border:1px solid var(--line);border-radius:12px;padding:18px;background:#fbfdfe}
.pet-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pet-head strong{font-size:16px}.badge{font:12px/1.5 ui-monospace,monospace;color:var(--muted);background:#eef4f8;border:1px solid var(--line);border-radius:6px;padding:1px 7px}
.pet-head .del{margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
label{display:block;font-weight:600;font-size:13px;margin:0 0 5px}
input:not([type=checkbox]),select,textarea{display:block;width:100%;min-height:40px;border:1px solid #a5bdcb;border-radius:7px;background:#fff;color:var(--ink);padding:8px 11px;font:inherit;font-size:14px}
textarea{min-height:62px;resize:vertical}
input[type=checkbox]{accent-color:var(--blue);width:17px;height:17px;flex-shrink:0;margin:0}
.check{display:flex;align-items:center;gap:9px;font-weight:400;font-size:14px;min-height:32px;margin:0;cursor:pointer}
.check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 20px}
.checks{display:flex;flex-wrap:wrap;gap:6px 22px;margin-top:14px}
.persona{margin-top:14px}
.entries{margin-top:14px;font-size:13px;color:var(--muted)}.entries p{margin:4px 0}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.row .inline{font-weight:600;font-size:13px;margin:0}
.row select{width:auto;min-width:150px}.row input[type=text]{flex:1 1 240px;width:auto}
.reply{font-size:13px;color:var(--blue);min-height:22px;margin:4px 0 0;white-space:pre-wrap;word-break:break-word}
footer{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:6px}
.paths{flex:1 1 320px;min-width:0}.paths p{font-size:12px;line-height:1.7;color:var(--muted);margin:0;word-break:break-all}
.actions{display:flex;gap:10px;flex-wrap:wrap}
button{border:0;border-radius:8px;min-height:40px;padding:9px 18px;background:var(--blue);color:#fff;font:600 14px/1.5 inherit;cursor:pointer;white-space:nowrap}
button:hover{background:#0b4e73}button:disabled{opacity:.55;cursor:wait}
button.ghost{background:#fff;color:var(--blue);border:1.5px solid var(--blue);font-size:13px;min-height:36px;padding:7px 14px}
button.ghost:hover{background:var(--water)}
button.del{background:#fff;color:var(--warn);border:1.5px solid #d9a49d;font-size:13px;min-height:32px;padding:4px 12px}
button.del:hover{background:#fdf1ef}
#status{font-size:13px;min-height:24px;margin:16px 0 0;color:var(--blue)}#status[data-error=true]{color:var(--warn)}
:focus-visible{outline:3px solid #3a94c4;outline-offset:2px}
@media(max-width:680px){main{margin:20px auto;padding:0 14px 28px}.grid{grid-template-columns:1fr 1fr}.check-grid{grid-template-columns:1fr}.panel{padding:18px}.actions{width:100%}.actions button{flex:1 1 auto}}
`;

export const petSettingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const $ = id => document.getElementById(id);
  const status = $('status');
  const reply = $('reply');
  const petsBox = $('pets');
  const entriesBox = $('entries');
  const DISPLAYS = ${JSON.stringify(PET_DISPLAYS)};
  const CORNERS = ${JSON.stringify(CORNERS)};
  const api = { pets: [], globals: {}, entries: [] };
  let busy = false;

  function say(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function note(text, error = false) { reply.textContent = text; reply.dataset.error = String(error); }

  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (res.status === 403) throw new Error('打开凭据已失效：请从桌宠右键菜单重新打开设置页。');
    if (!res.ok) throw new Error('本机接口返回 ' + res.status);
    if (res.status === 204) return null;
    return res.json();
  }

  function optionList(items, selected) {
    return items.map(([value, label]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + label + '</option>').join('');
  }

  function card(pet) {
    const el = document.createElement('div');
    el.className = 'pet';
    el.dataset.id = pet.id;
    el.innerHTML =
      '<div class="pet-head"><strong></strong><span class="badge"></span><button type="button" class="del">删除</button></div>' +
      '<div class="grid">' +
        '<div><label>名称</label><input class="name" type="text" maxlength="40"></div>' +
        '<div><label>大小（像素）</label><input class="size" type="number" min="80" max="1200" step="10"></div>' +
        '<div><label>显示位置</label><select class="display">' + optionList(DISPLAYS, pet.display) + '</select></div>' +
        '<div><label>停靠角落</label><select class="corner">' + optionList(CORNERS, pet.position ? pet.position.corner : '') + '</select></div>' +
        '<div><label>水平边距</label><input class="marginX" type="number" min="-2000" max="4000" step="1"></div>' +
        '<div><label>垂直边距</label><input class="marginY" type="number" min="-2000" max="4000" step="1"></div>' +
      '</div>' +
      '<div class="checks">' +
        '<label class="check"><input class="balanceEnabled" type="checkbox">余额动画</label>' +
        '<label class="check"><input class="whisperEnabled" type="checkbox">自动碎碎念</label>' +
        '<label class="check"><input class="workStatusEnabled" type="checkbox">工作状态</label>' +
        '<label class="check"><input class="fixedEnabled" type="checkbox">原地固定</label>' +
      '</div>' +
      '<div class="persona"><label>人设（可选，留空则跟随宠物种类默认）</label><textarea class="whisperPrompt" maxlength="2000"></textarea></div>';
    el.querySelector('.pet-head strong').textContent = pet.name || pet.id;
    el.querySelector('.badge').textContent = pet.id;
    const name = el.querySelector('.name');
    name.value = pet.name || pet.id;
    name.addEventListener('input', () => { el.querySelector('.pet-head strong').textContent = name.value || pet.id; });
    el.querySelector('.size').value = String(pet.size);
    el.querySelector('.marginX').value = String(pet.position ? pet.position.marginX : 0);
    el.querySelector('.marginY').value = String(pet.position ? pet.position.marginY : 0);
    el.querySelector('.balanceEnabled').checked = pet.balanceEnabled !== false;
    el.querySelector('.whisperEnabled').checked = pet.whisperEnabled !== false;
    el.querySelector('.workStatusEnabled').checked = pet.workStatusEnabled !== false;
    el.querySelector('.fixedEnabled').checked = pet.fixedEnabled === true;
    const persona = el.querySelector('.whisperPrompt');
    persona.value = typeof pet.whisperPrompt === 'string' ? pet.whisperPrompt : '';
    el.querySelector('.del').addEventListener('click', () => {
      if (api.pets.length <= 1) { say('至少要保留一只桌宠。', true); return; }
      if (!confirm('删除这只桌宠？只影响本机配置。')) return;
      api.pets = api.pets.filter(p => p.id !== pet.id);
      render();
    });
    return el;
  }

  function render() {
    petsBox.replaceChildren(...api.pets.map(card));
    const target = $('target');
    const previous = target.value;
    target.replaceChildren(...api.pets.map(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.name || p.id) + '（' + p.id + '）';
      return opt;
    }));
    if (previous && api.pets.some(p => p.id === previous)) target.value = previous;
    entriesBox.replaceChildren(...api.entries.map(line => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
  }

  function collect() {
    const pets = api.pets.map(pet => {
      const el = petsBox.querySelector('[data-id="' + CSS.escape(pet.id) + '"]');
      const person = el.querySelector('.whisperPrompt').value.trim();
      const item = {
        id: pet.id,
        name: el.querySelector('.name').value.trim() || pet.id,
        size: Number(el.querySelector('.size').value),
        balanceEnabled: el.querySelector('.balanceEnabled').checked,
        whisperEnabled: el.querySelector('.whisperEnabled').checked,
        workStatusEnabled: el.querySelector('.workStatusEnabled').checked,
        fixedEnabled: el.querySelector('.fixedEnabled').checked,
        display: el.querySelector('.display').value,
        position: {
          corner: el.querySelector('.corner').value,
          marginX: Number(el.querySelector('.marginX').value),
          marginY: Number(el.querySelector('.marginY').value)
        }
      };
      if (person) item.whisperPrompt = person;
      return item;
    });
    const globals = {
      trayEnabled: $('trayEnabled').checked,
      clickSoundEnabled: $('clickSoundEnabled').checked,
      confineToScreen: $('confineToScreen').checked,
      whisperImageEnabled: $('whisperImageEnabled').checked,
      chatImageEnabled: $('chatImageEnabled').checked,
      notificationsEnabled: $('notificationsEnabled').checked
    };
    return { pets, globals };
  }

  function load(merged) {
    const main = merged && merged.main ? merged.main : {};
    api.pets = (Array.isArray(main.pets) ? main.pets : []).map(pet => ({ ...pet }));
    api.entries = Object.keys(merged || {})
      .filter(entry => entry !== 'main')
      .map(entry => {
        const label = entry + '-config.json';
        const names = (merged[entry] && Array.isArray(merged[entry].pets) ? merged[entry].pets : [])
          .map(p => p.name || p.id).join('、');
        return '文件宠物「' + label + '」：' + (names || '（无实例）') + '（在 pet/ 目录维护，不在此页编辑）';
      });
    $('trayEnabled').checked = main.trayEnabled !== false;
    $('clickSoundEnabled').checked = main.clickSoundEnabled === true;
    $('confineToScreen').checked = main.confineToScreen === true;
    $('whisperImageEnabled').checked = main.whisperImageEnabled !== false;
    $('chatImageEnabled').checked = main.chatImageEnabled !== false;
    $('notificationsEnabled').checked = main.notificationsEnabled !== false;
    render();
  }

  async function loadAll() {
    const merged = await request('GET', '/dsh-pet-7340/config');
    load(merged);
    try {
      const meta = await request('GET', '/dsh-pet-7340/config/meta');
      $('paths').textContent = '配置文件：' + (meta.user || '(未知)') + '　日志：' + (meta.logs || '(未知)');
    } catch {
      $('paths').textContent = '配置文件路径读取失败（不影响编辑）。';
    }
    say('已读取本机配置。');
  }

  function setBusy(value) {
    busy = value;
    for (const id of ['save', 'reload', 'reset', 'add', 'whisper', 'balance', 'chat']) $(id).disabled = value;
  }

  $('add').addEventListener('click', () => {
    const name = prompt('新宠物的名字（可留空）', '新桌宠');
    if (name === null) return;
    let n = api.pets.length + 1;
    let id = 'pet' + n;
    while (api.pets.some(p => p.id === id)) { n += 1; id = 'pet' + n; }
    api.pets.push({
      id,
      name: (name || '').trim() || id,
      size: 360,
      balanceEnabled: true,
      whisperEnabled: true,
      workStatusEnabled: true,
      fixedEnabled: false,
      display: 'desktop',
      position: { corner: 'bottom-right', marginX: 24, marginY: 24 },
      whisperPrompt: ''
    });
    render();
    say('已添加「' + id + '」，记得点保存并应用。');
  });

  $('save').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    say('正在保存…');
    try {
      const { pets, globals } = collect();
      await request('PUT', '/dsh-pet-7340/config', { pets, ...globals });
      say('已保存，正在按新配置重建桌面窗口…（1–3 秒；重建后请从右键菜单重新打开本页）');
    } catch (e) {
      say(e.message || '保存失败', true);
    } finally {
      setBusy(false);
    }
  });

  $('reload').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await request('POST', '/dsh-pet-7340/reload');
      say('已请求重载：桌面窗口正在按最新配置重建…');
    } catch (e) {
      say(e.message || '重载失败', true);
    } finally { setBusy(false); }
  });

  $('reset').addEventListener('click', async () => {
    if (busy) return;
    if (!confirm('恢复默认会覆盖本机配置（含宠物大小/位置/开关）。确定继续？')) return;
    setBusy(true);
    try {
      await request('POST', '/dsh-pet-7340/config');
      say('已恢复默认配置，桌面窗口正在重建…');
    } catch (e) {
      say(e.message || '恢复默认失败', true);
    } finally { setBusy(false); }
  });

  $('openAi').addEventListener('click', () => {
    window.open('/standalone-ai/#token=' + encodeURIComponent(token), '_blank', 'noopener');
  });

  $('whisper').addEventListener('click', async () => {
    if (busy) return;
    const pet = $('target').value;
    setBusy(true); note('正在生成…');
    try {
      const res = await request('POST', '/dsh-pet-7340/whisper?pet=' + encodeURIComponent(pet));
      note(res && res.ok ? res.text : '没能生成：' + ((res && (res.message || res.reason)) || '未知原因'), !(res && res.ok));
    } catch (e) {
      note(e.message || '请求失败', true);
    } finally { setBusy(false); }
  });

  $('balance').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); note('正在查询余额…');
    try {
      await request('POST', '/dsh-pet-7340/balance');
      const state = await request('GET', '/dsh-pet-7340/state');
      const leaf = state && state.sections && state.sections.balance;
      const data = leaf && leaf.data ? leaf.data : null;
      if (!data) note('没有读到余额。', true);
      else if (data.ok === false) note('余额不可用：' + (data.message || data.reason || '未知原因'), true);
      else if (data.shape === 'money') note(data.data.wallets.map(w => (w.currency || '') + ' ' + w.total).join(' / ') || '余额为 0');
      else if (data.shape === 'windows') note('月度已用 ' + Math.round(Number(data.data.monthly) || 0) + '%');
      else if (data.shape === 'points') note('余额 ' + data.data.total + (data.data.unit || ''));
      else note('已获取余额数据（自定义形态，气泡里可见）。');
    } catch (e) {
      note(e.message || '请求失败', true);
    } finally { setBusy(false); }
  });

  async function sendChat() {
    if (busy) return;
    const text = $('chatText').value.trim();
    if (!text) return;
    const pet = $('target').value;
    setBusy(true); note('正在思考…');
    try {
      const res = await request('POST', '/dsh-pet-7340/chat?pet=' + encodeURIComponent(pet), { text });
      if (res && res.ok) {
        $('chatText').value = '';
        note('你：' + text + '\\n它：' + res.text);
      } else {
        note('没能回复：' + ((res && (res.message || res.reason)) || '未知原因'), true);
      }
    } catch (e) {
      note(e.message || '请求失败', true);
    } finally { setBusy(false); }
  }
  $('chat').addEventListener('click', sendChat);
  $('chatText').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void sendChat(); }
  });

  loadAll().catch(e => say(e.message || '读取配置失败', true));
})();
`;

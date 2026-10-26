/**
 * dsh-pet desktop helper renderer —— 启动入口。
 *
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js →
 * events.js → renderer.js（本文件）。本文件只做：配置加载 / 错误处理 / 启动装配 / 素材注入。
 *
 * 与浏览器 overlay 严格对齐（宠物行为/文案完全一致）：
 *   - 纯逻辑（常量/选择器/移动几何/余额折算/拍平）来自 shared-core.js
 *     （= src/shared 的构建产物，window.PetShared）——与浏览器 bundle 共用同一份源码；
 *   - 配置唯一来源 = 宿主 /dsh-pet-7340/config 的**成品聚合**（host readAllConfig 合并，
 *     绝对正确、字段填满）：一步 fetch → S.flattenConfigPets 拍平，加载失败**大声报错**
 *     并显示红色错误条（每 5s 自动重试），绝无静默兜底池；
 *   - 动画素材经宿主 /dsh-pet-7340/thumb/<素材根>/<name>.<webm|mov>（素材根 = 条目 key；扩展名由共享常量 ANIMATION_EXT 决定）；
 *   - 几何模型：窗口 = 宠物包围盒 + 四周外扩余量（WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间）。
 *     sprite 固定在窗口内 (margin.l, margin.t) 处，宠物的"移动"由本页把目标屏幕位置
 *     逐帧上报（petBridge.setBounds）→ 主进程按 sprite 位置 + 外扩余量移动窗口；
 *     视口 = 全部显示器工作区外接矩形（workAreaX/Y/W/H 由主进程注入），漫游/抛掷/角落/位置换算
 *     都跨屏（#43，宠物可被甩/拖到其它显示器）；单显示器时即主屏工作区，行为不变。
 *     外扩区透明且点击穿透（只有身体命中区可交互），不挡下层应用。
 *   - 右键级联菜单（与浏览器共用同一份组件：树+渲染+样式来自 shared-core 的 menu 模块）：
 *     右键宠物弹出，桌面端工具根项「打开网站 / 打开软件（宿主是 DSH 桌面应用时的同一项）/ 查看余额 / 回到初始位置 / 重载配置」+ 动作点播；
 *     菜单开启期间整窗保持可交互（悬停菜单不触发穿透翻转），关闭/离开窗口即恢复穿透。
 *   - 系统通知不是宠物行为（浏览器半侧 notify.ts 负责），桌面端不重复实现。
 */
'use strict';

// ---------- 配置（大声报错；失败 5s 重试） ----------
function showError(message) {
  console.error('[dsh-pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = 'dsh-pet 配置错误：' + message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

/**
 * 连续启动失败次数（成功一次即清零）。
 * 首次失败多半是启动竞态：主进程 `void startTray()` / `createPetWindows()` 不等 bridge
 * 回调服务就绪（main.js 的 startBridgeCallback 未 await），渲染端首帧 fetch 会打空。
 * 这种失败 5s 重试就自愈，不该闪一条红条；持续失败才是真配置错误，照旧大声报。
 */
let bootFailures = 0;

async function loadConfig() {
  // 唯一配置入口：宿主 /config 的成品聚合（host readAllConfig 已合并并保证绝对正确），
  // 一步拉取 → 拍平成渲染列表，零校验零兜底
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const merged = await res.json();
  return {
    pets: S.flattenConfigPets(merged),
    // 拖拽抛掷物理参数（顶层全局，所有宠物共用；合并器已填内置默认）
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
    // 抛掷锁定在当前屏幕（根字段；合并器已填内置默认 false）
    confineToScreen: (merged && merged.main && merged.main.confineToScreen) === true,
    // 点击音效开关（全局一份，只读 main 条目；合并器已填内置默认 false = 静音）
    clickSoundEnabled: (merged && merged.main && merged.main.clickSoundEnabled) === true,
    // 「仅保持待机动画」：只读 main 条目（sprite 的 playOnce / playIdle / tryMove 都看它）
    idleOnly: (merged && merged.main && merged.main.idleOnly) === true,
    // 字体（全局一份，合并器已填内置默认）：字体族在此取一次、注入全局变量；字号由每只宠物
    // 按自己的尺寸算（见 PetSprite 注入的 --dsh-pet-font-bubble / --dsh-pet-font-tip）
    font: (merged && merged.main && merged.main.font) || S.DEFAULT_FONT,
  };
}

/**
 * 尺寸 / 素材根 / 字体都没变时，可以复用现有 sprite（只换配置）。
 * 这三样决定了几何（窗口尺寸、命中区、边距）与视频来源，变了就必须重建。
 */
function canReuseSprite(sprite, pet, font) {
  if (!sprite || sprite.size !== pet.size) return false;
  if (sprite.assetRoot !== (pet.assetRoot || pet.id)) return false;
  return JSON.stringify(sprite.font) === JSON.stringify(font || S.DEFAULT_FONT);
}

/** 把最新配置就地套到现有 sprite 上（不重建 DOM / 不重载视频） */
function applyPetConfig(sprite, pet, cfg) {
  const nextAnimations = pet.animations || cfg.animations;
  const poolChanged = nextAnimations !== sprite.animations;
  sprite.pet = pet;
  sprite.animations = nextAnimations;
  sprite.weights = pet.animationWeights || cfg.animationWeights;
  sprite.physics = pet.physics || cfg.physics || S.DEFAULT_PHYSICS;
  sprite.confineToScreen = pet.confineToScreen === true || cfg.confineToScreen === true;
  // 固定位置（热更新时也要跟着变，否则改了开关得重启才生效）
  sprite.lockPosition = pet.lockPosition === true;
  // 「仅保持待机动画」开关切换：两个方向都要立刻生效——
  //   · 打开：正在播的插播动画让位给待机链；
  //   · 关闭：之前被固定在 idle 循环（once=false、不会 ended），必须主动重跑随机链，
  //     否则宠物会一直停在那一帧不动（这正是"关闭了也不恢复"的原因）。
  const wasIdleOnly = sprite.wasIdleOnly === true;
  sprite.wasIdleOnly = cfg.idleOnly === true;
  if (cfg.idleOnly === true) {
    sprite.playIdle();
    return;
  }
  if (wasIdleOnly) {
    sprite.playIdle();
    return;
  }
  // 动画池换了、而当前这段已不在新池里 → 回待机；否则保持正在播的那段（不打断视觉）
  if (poolChanged && !JSON.stringify(nextAnimations).includes('"' + sprite.anim + '"')) sprite.playIdle();
}

/** 等视频首帧可播（超过 timeout 就放弃，宁可早点换掉也别让旧的一直留着） */
function waitVideoReady(video, timeoutMs) {
  if (!video) return Promise.resolve();
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('playing', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('playing', done, { once: true });
  });
}

/**
 * 交叉过渡：新 sprite 已经挂在页面上并开始播，紧挨着旧的那只。
 * 旧的在等待期间**不再响应指针**（避免两层命中区同时抢点击），首帧就绪后整体移除。
 */
async function retireSprites(previous, next) {
  for (const s of previous) {
    if (s.hit) s.hit.style.pointerEvents = 'none';
  }
  await waitVideoReady(next && next.videoA, 600);
  for (const s of previous) s.dispose();
}

// ---------- 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试） ----------
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    bootFailures = 0;
    hideError();
    // 字体族（全局配置 font.family）→ documentElement：对话窗/得分弹窗挂在 body 下、继承不到
    // 宠物根容器，只能走全局变量；气泡与提示也一并从这里继承（与浏览器端同一套变量名）。
    // 放在这里而不是 injectAssets()：字体族来自配置，必须等 /config 拉回来之后才有效。
    document.documentElement.style.setProperty('--dsh-pet-font-family', S.fontStackOf(cfg.font.family));
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      // **全部宠物只在网页显示是合法状态，不是配置错误**（issue #130）。
      // 本窗口是主进程按 DSH_PET_PETS 建的：宿主流下窗口数与该列表必然一致
      // （全 web 时宿主传 []，main.js 建 0 个窗口，本函数根本不会跑）；
      // 只有手动 start-desktop（没有 DSH_PET_PETS）会回落出一只默认窗口而与配置脱钩。
      // 脱钩不该报错——没有桌面宠物就表示这个窗口没活儿干：安静关掉，不弹条、不重试。
      // 托盘是否还在看 main 条目的 trayEnabled：开着且桌面模式曾启用过，宿主持久保留 Helper
      // （托盘因此还在）；关掉则宿主不再为它常驻，宠物全下线时 Helper 一起退出。
      // 宿主流由 syncDesktop() 在配置变化时重建 helper，手动流则需自行重启。
      hideError();
      console.info('[dsh-pet] no desktop pets; closing this helper window (tray kept only if trayEnabled)');
      window.close();
      return;
    }
    // 本窗口只承载一只宠物：按 **id** 认领（配置热更新后列表顺序可能变，按 index 会串位）；
    // 老宿主没传 petId 时回落到 petIndex。
    const pet = CONFIG.petId ? pets.find((p) => p.id === CONFIG.petId) : pets[CONFIG.petIndex];
    if (!pet) {
      // 这只宠物被改成 web/none 或被删了：主进程会关掉本窗口，这里安静收场
      // （用户主动改的配置，不是错误，别弹红条）
      console.info('[dsh-pet] 本窗口的宠物已不在桌面显示，关闭窗口：' + (CONFIG.petId || CONFIG.petIndex));
      window.close();
      return;
    }
    // 配置热更新（保存设置 / 右键「重载配置」）走这里，**不是**每次都重建 sprite：
    //   ① 尺寸、素材根、字体都没变（最常见：只改了开关/人设）→ 把新配置就地套上去、
    //      重新摆一下位置。视频不重载，画面完全不闪，正在播的动画也不会被打断。
    //   ② 尺寸或素材变了 → 必须重建 sprite（几何与窗口尺寸都要重算）。这时先把新 sprite
    //      建好并播起来，等它首帧可播后再拆掉旧的（交叉过渡），而不是"先拆后建"留一瞬空白。
    const previous = sprites.slice();
    if (previous.length === 1 && canReuseSprite(previous[0], pet, pet.font || cfg.font)) {
      applyPetConfig(previous[0], pet, cfg);
      previous[0].position();
      window.__dshPetDebug.configOk = true;
      startLoops();
      return;
    }
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    startLoops();
    if (previous.length > 0) void retireSprites(previous, sprites[0]);
  } catch (e) {
    const msg = '配置加载失败：' + (e && e.message ? String(e.message) : String(e));
    // 首次失败先静默（多半是启动竞态，见 bootFailures 的说明），下一次 5s 重试仍失败才报。
    bootFailures += 1;
    if (bootFailures > 1) showError(msg);
    else console.error('[dsh-pet] ' + msg + ' (first boot, retrying)');
    scheduleReboot();
  }
}

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器 overlay 同一套素材，host 经 /dsh-pet-7340/ 提供）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    BASE +
    '/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400;' +
    // 随包软糖体把波浪号（~ / ～）画成一条短横，气泡里看着像"没有正常显示"。
    // 用 unicode-range 把这两个码位排除在自定义字体之外 —— 它们会自然回退到字体栈里的
    // 系统字体（雅黑/苹方），其余字符仍走软糖体。
    'unicode-range:U+0-7D,U+7F-FF5D,U+FF5F-10FFFF}' +
    '.pet-hit{cursor:url("' +
    BASE +
    '/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    BASE +
    '/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
  // 统一右键菜单样式（与浏览器注入同一份 MENU_CSS）
  const menuStyle = document.createElement('style');
  menuStyle.textContent = S.MENU_CSS;
  document.head.appendChild(menuStyle);
  // 悬浮提示样式（与浏览器注入同一份 TOOLTIP_CSS；替代原先挂在命中层 title 上的原生提示）
  const tipStyle = document.createElement('style');
  tipStyle.textContent = S.TOOLTIP_CSS;
  document.head.appendChild(tipStyle);
}

// 显示器几何变化（改分辨率/缩放、插拔屏、旋转）：主进程重算后推来，渲染端就地重挂视口与边界。
// 这条通道是必需的——桌面几何原先只在窗口创建时经 URL query 注入一次，运行期永不更新。
if (window.petBridge && window.petBridge.onDisplays) {
  window.petBridge.onDisplays((geo) => {
    if (!applyDeskGeometry(geo)) return;
    for (const s of sprites) s.relayout();
  });
}

// 窗口内容区尺寸异常时按当前位置重新规整。
// 守卫：拖拽/飞行/漫游中**绝不**重设位置——这三种状态下位置由输入或物理驱动，而 position()
// 会把宠物拉回 customPos（上一次的落点）。跨屏时 Windows 会因 WM_DPICHANGED 主动改窗口尺寸，
// 那正好落在拖拽/飞行过程中，不设防就会看到宠物瞬间跳回上一个落点。
window.addEventListener('resize', () => {
  for (const s of sprites) {
    if (s.dragState.active || s.throwRef !== null || s.moveRef !== null) continue;
    s.position();
  }
});

injectAssets();

// 深浅色：与设置窗口共用同一个 localStorage 键（同源）；启动时读一次，切换时由主进程广播。
// 影响的是右键菜单这类浮层（MENU_CSS 的变量挂在 html[data-dsh-theme] 上）。
const THEME_KEY = 'dsh-pet-settings-theme';
function applyPetTheme(mode) {
  document.documentElement.dataset.dshTheme = mode === 'dark' ? 'dark' : 'light';
}
try {
  applyPetTheme(localStorage.getItem(THEME_KEY) || 'light');
} catch {
  applyPetTheme('light');
}
if (window.petBridge && window.petBridge.onTheme) {
  window.petBridge.onTheme((mode) => {
    applyPetTheme(mode);
    try {
      localStorage.setItem(THEME_KEY, mode === 'dark' ? 'dark' : 'light');
    } catch {
      /* 存不了就只在本次生效 */
    }
  });
}

// 配置热更新：设置页保存 / 右键「重载配置」后，主进程让本窗口重拉 /config 并重建 sprite
// （事件轮询与窗口本身都不动，所以能"改完立刻生效"，不用重启）。
if (window.petBridge && window.petBridge.onConfigChanged) {
  window.petBridge.onConfigChanged(() => {
    void boot();
  });
}
void boot();

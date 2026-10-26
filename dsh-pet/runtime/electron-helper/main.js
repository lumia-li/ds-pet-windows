/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：为**每只桌面宠物**开一个独立的局部小窗口（透明、置顶、不可激活），
 * 窗口 = 宠物包围盒 + 四周外扩余量（renderer 的 WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间），
 * 宠物移动时 renderer 逐帧上报 bounds，本进程 setContentBounds 让窗口跟随宠物。
 *
 * 为什么是「局部小窗口」而不是「全屏透明画布」：全屏透明置顶窗会触发 Windows DWM 视频合成黑屏
 * （播放中的视频画面变黑、声音继续）。触发与窗口**绝对尺寸无关**，需四项齐备：透明置顶 + 非点击穿透
 * + 可聚焦且已聚焦 + **完整盖住视频窗**（98% 覆盖即安全；一个仅占屏幕 26% 的小窗同样能触发，issue #60
 * 的单变量实测矩阵）。本进程恰好会凑齐前三项——悬停宠物即整窗翻成可交互、show() 出去的窗口本就是
 * 聚焦的——而全屏画布又把第四项白送（必然完整遮挡非全屏播放的视频），故"不做全屏画布"的结论不变，
 * 只是理由换成这套条件；现有形态靠**默认整窗穿透 + 小窗几乎不可能完整遮挡视频窗**规避。
 * （旧注释写作"窗口不全屏就不黑"，那是把 0.1.x 的「全屏画布 → 每宠小窗」与输入模型改造这两件
 * 同时发生的事，混成了一个自变量。）
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用，
 * 与浏览器 overlay（仅 .dsh-pet-hit 可交互）严格对齐。
 *
 * 数据通道（bridge 模式，DSH_PET_BRIDGE=1 由宿主注入）：
 * 渲染端不再直连宿主 WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会拦无令牌裸 HTTP）——
 * 本进程注册自定义 scheme `dsh-pet-bridge://`，protocol.handle 收到渲染端请求后
 * 经 stdin/stdout JSON 行协议转发宿主（helper-process.ts 的 BridgeHandler），
 * 宿主用与 HTTP 路由同一份 handlePetRoute 应答；素材应答带文件绝对路径，本进程读盘返回。
 * 无 DSH_PET_BRIDGE（手动 start-desktop / 开发流）时保持旧路径：渲染端直接 HTTP 访问宿主。
 *
 * 进程存亡（issue #56）：本进程的 stdout/stderr 是宿主给的管道，宿主一退出读端就消失（下一次写
 * 就是 EPIPE，而 Electron 默认处理器只会弹框且不退出）。故有「宿主存活」一节：管道守卫 +
 * 宿主 PID 探测，宿主没了就自己退——见那里的注释。
 *
 * 启动模式（issue #63）：若被以「纯 Node 模式」拉起（宿主透传了 ELECTRON_RUN_AS_NODE），内置
 * electron 模块不会注册，下面的 require 会失败——报一句能定位原因的话再退出，别只留 MODULE_NOT_FOUND。
 */
let electronApi;
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前删除（见 src/host/helper-process.ts 的 helperSpawnEnv），' +
      '运行期再删无效，设成空串会让 Electron 直接 abort。原始错误：' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
      '\n',
  );
  process.exit(3);
}
const { app, BrowserWindow, ipcMain, screen, shell, protocol, Tray, Menu, nativeImage } = electronApi;
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore, pointerZone } = require('./pointer-target.js');
// 置顶看门狗：WS_EX_TOPMOST 只是样式位，不等于窗口真的在置顶带（见 topmost-watchdog.js 头部）
const {
  TOPMOST_WATCHDOG_TICK_MS,
  TOPMOST_WATCHDOG_ENABLED,
  shouldReassertTopmost,
  topmostLevel,
} = require('./topmost-watchdog.js');
// 宿主存活判定（issue #56：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸）
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');
// 全局 DPI 线性化的纯判定与换算（含平台例外：macOS 的 DIP 已是「点」，无需补偿；见该文件头）
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('./dpi-linearization.js');
// 托盘的平台差异（模板图 / 左键是否自动弹菜单 / Dock）：规则住在模块里，main.js 只接线
const { trayPlatform } = require('./tray-platform.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 显式定名：Helper 是被 `electron.exe <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录，
// 我们的 DPI 缓存与 Chromium profile 都会和别人混在一起。必须赶在任何 getPath('userData') 之前设。
// 应用模式：本文件被 `src/app/main.ts` 直接 import 进同一进程（独立应用，不 spawn 子进程）。
// 双击启动的用户没有终端可按 Ctrl+C，托盘上必须有一个「退出」，否则只能去任务管理器杀进程。
// 退出项不只给独立应用（issue #178）：手动 start-desktop 流同样没有终端；BRIDGE 模式则由宿主
// 决定能不能退（GET /quit 探 canQuit，DSH 宿主答 false）。见 startTray 里的 quitApp。
// DSH 内的桌面模式不设这个变量，托盘形态与 userData 目录都保持原样。
const APP_MODE = process.env.DSH_PET_APP_MODE === '1';
// Captured only for in-process app requests; never exposed to renderer URLs or logs.
const APP_TOKEN = APP_MODE ? process.env.DSH_PET_APP_TOKEN : undefined;
// 名字必须与 src/host/storage-paths.ts 的 DESKTOP_APP_NAME 逐字一致
// （storage-paths.test.ts 会直接读本文件比对，改名不同步测试就红）。
app.setName('dsh-pet-electron-helper');
// 应用模式只改**数据目录**，不改应用名：独立应用与 DSH 内的 helper 若共用同一个 userData，
// 两个 Chromium 进程会抢同一份 profile（单例锁）互相踢。名字不动也就不会触发上面那个防漂移测试。
if (APP_MODE) {
  app.setPath('userData', path.join(app.getPath('appData'), 'dsh-pet'));
  // Windows 任务栏分组/图标靠 AppUserModelID：不设的话任务栏永远是 Electron 默认图标
  // （与 electron-builder.yml 的 appId 同一份字符串）
  if (process.platform === 'win32') app.setAppUserModelId('com.pc2005.dsh-pet');
}

/** DPI 探测子进程模式：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出（见 probePrimaryScale） */
const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-primary-scale:';

// ---------- 宿主存活（issue #56）：管道断开 / 父进程消失 → 自己退出 ----------
//
// 【为什么必须自己退】宿主退出后，它在 helper 的 stdout/stderr 上握着的管道读端一起关闭；helper
// 下一次写（bridge 协议行 —— 渲染端每秒至少一条 /state 轮询）拿到 EPIPE。未处理的 'error'
// 事件 = 未捕获异常，而 Electron 主进程自带的处理器只弹一个模态框、**且不退出**
// （lib/browser/init.ts 原文注释："Don't quit on fatal error"）—— 桌宠就此卡死、进程赖着不走。
// 真机实测（宿主存活、只切断 stdout 管道）：那次写之后主线程彻底停住，14 秒里一次心跳都没有，
// 进程也一直没有退出。
//
// 两条路都要有，缺一不可：
//   ① 管道守卫：任何一次写失败都不许变成异常；管道断开本身就是"宿主已死"的铁证 → 立刻退。
//      它只在**上层真的写**的时候才触发；
//   ② 宿主探测：每 HOST_POLL_MS 用 kill(pid, 0) 问一次宿主还在不在，ESRCH 即退。
//      渲染端崩了/根本没起来时一次写都不会发生，只有 ② 能收敛。
// 两条路都只经 exitForDeadHost()，且只退一次。
let hostGone = false;
/** 宿主没了 → 立刻退出。这里**不能**再打日志：管道已经断了，写只会再踩一次同一个错误 */
function exitForDeadHost() {
  if (hostGone) return;
  hostGone = true;
  app.exit(0); // 宿主消失是"环境要求我退"，不是自身崩溃，退出码 0
}

// ① 管道守卫：必须赶在**任何一次写**之前装上（probePrimaryScale 失败就会往 stderr 写）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) exitForDeadHost();
    // 其余流错误同样吞掉：Electron 的默认处理是弹模态框，任何流错误都不值得拿桌宠去换一个框
  });
}

// ② 宿主探测：DSH_PET_HOST_PID 由宿主 spawn 时注入；未注入/非法 → parseHostPid 给 0 → 不探测（不误退）。
// DPI 探测实例是一次性短命进程（它的父进程是 helper 而不是宿主），不参与这套机制。
const HOST_PID = parseHostPid(process.env.DSH_PET_HOST_PID);
if (!DPI_PROBE && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS).unref?.();
}

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下存在多处缺陷：
//   - 拖拽移动时窗口四周出现黑色边框（#37）
//   - 大透明窗移动覆盖小透明窗时，被覆盖窗口内容丢失（显示"消失"）
// 本进程只渲染轻量宠物动画（640×360），改走软件合成以规避上述缺陷，
// 不影响浏览器形态与主 DSH（独立进程）；非 Windows（macOS/Linux）合成路径不同，保留硬件加速。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

// ---------- 全局 DPI 线性化（多显示器异构缩放的根因修复） ----------
//
// Windows 上 Chromium 的 DIP↔物理 换算是**逐显示器**的仿射变换，而且
// ScreenWin::DIPToScreenRect(hwnd, rect) 用的是「hwnd 当前归属屏」的那一组参数：
//   physical = (dip − D.dipOrigin) × D.scale + D.pixelOrigin
// 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，窗口骑缝时会反复翻转。
// 两屏缩放不同时，同一个 DIP 值在翻转前后落到不同物理位置、算出不同物理尺寸
// （实测 1.5/1.75 双屏：位置差 110px、924 DIP 宽的窗口尺寸差 231px），
// 于是 setContentBounds 每帧的落点在两套坐标系之间横跳 —— 这就是拖过屏缝时的「分身闪烁」，
// 也是两屏缩放一致时同样骑缝却毫无问题的原因。
//
// --force-device-scale-factor 让 Chromium 的 GetMonitorScaleFactors() 对所有显示器
// 直接返回同一个值，全部屏塌缩成**同一个**仿射变换 ⇒ DIPToScreenRect 的结果与窗口归属无关。
//
// 取值必须是 **1**，不能取主屏的 scaleFactor。实测（tools/probe-dpi.cjs，1.5 + 1.75 双屏）：
//   forced=1.5 → display.bounds 被二次缩放（主屏物理 3840 宽报成 1706 = 3840/1.5/1.5，
//                而同一块屏的 workArea 报 2560 = 3840/1.5，两者自相矛盾）。
//                DIPToScreenPoint 用 bounds.origin() 当 dipOrigin，于是
//                pixelOrigin(3840) ≠ dipOrigin(1706)×1.5，副屏多出 1281px 的**恒定**偏移——
//                比不加 switch 时的 75px 还糟。
//   forced=1   → bounds 与 workArea 一致，每块屏都满足 pixelOrigin == dipOrigin×scale，
//                DIP 与物理像素成为恒等映射，探针的 DELTA 全 0（尺寸差 231×151 也一并归零）。
// 所以这里锁死 1：坐标系 = Windows 物理像素，跨屏几何再无换算与舍入。
//
// 代价：宠物尺寸的单位从 DIP 变成物理像素，不补偿的话在 150% 的屏上会小 1/1.5。
// 用探测到的**真实主屏 scaleFactor** 乘进渲染端的 CONFIG.scale 抵掉（见 petScale()）——
// 主屏上的观感与修复前逐像素相同；其余屏改按主屏缩放渲染宠物（同尺寸同分辨率的两块屏上
// 物理大小反而一致了）。探测失败就整个不启用，退回修复前行为，不做没有补偿的缩放。
//
// 环境变量 DSH_PET_FORCE_DSF：'0' = 关闭本机制；其它正数 = 强制该值（排障用，会踩上面的 bug）。
//
// 「要不要启用 / 强制成几 / 渲染端乘几」三条规则已抽到 dpi-linearization.js（纯函数、带单测）——
// 其中包含一个平台例外：上面这套补偿的前提是「force-device-scale-factor 会把 DIP 换算成物理像素」，
// 那是 Windows 的行为，macOS 上不成立。原因与实测数据见该文件头，本文件不再复述。
//
// 取值时机是个麻烦：switch 必须在 app ready 之前设，而那时 screen 模块还不可用。
// 所以首次启动 spawn 一个自己的探测子进程（DSH_PET_DPI_PROBE=1，只打印 scaleFactor 就退出，
// ~0.5s）并把结果落盘；之后每次启动直接读缓存，零开销。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 DPI_PROBE 分支） */
function probePrimaryScale() {
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--dsh-pet-dpi-probe'], opts);
  } catch (e) {
    // 只认 stdout，不认退出码：一个不开窗口的 Electron 进程调 app.exit() 在 Windows 上
    // 偶发 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回修复前行为（多屏异构 DPI 会闪，但不影响可用性）
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;
const FORCE_DSF = process.env.DSH_PET_FORCE_DSF;
if (shouldLinearize({ platform: process.platform, dpiProbe: DPI_PROBE, forceDsf: FORCE_DSF })) {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const forced = resolveForcedScale({ forceDsf: FORCE_DSF, primaryScale: PRIMARY_SCALE });
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  return resolvePetScale({
    baseScale: process.env.DSH_PET_SCALE,
    primaryScale: PRIMARY_SCALE,
    forcedScale: FORCED_SCALE,
  });
}

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';

/** 「打开网站」这一项的去向（宿主按自身形态注入）：
 *  'desktop' = 宿主是 DSH 桌面应用 → 唤起桌面应用主窗口；
 *  'site'    = dsh web / 独立模式 / 手写 start-desktop（无该变量）→ 原行为：默认浏览器打开站点。 */
const OPEN_TARGET = process.env.DSH_PET_OPEN_TARGET === 'desktop' ? 'desktop' : 'site';
/**
 * 「这一项」在独立应用里变成「打开设置窗口」（DSH_PET_OPEN_SETTINGS=1，由 lib/app.js 注入）。
 *
 * 为什么不复用 OPEN_TARGET：那个变量的语义是**宿主形态**（唤起 DSH 桌面应用 / 打开站点），
 * 三种取值各有既有含义与测试钉着。独立应用既不是 DSH 桌面宿主、也没有"站点"可开——
 * 它的设置界面就在本进程里（一个普通 Electron 窗口），所以单开一个开关。
 */
const OPEN_SETTINGS = process.env.DSH_PET_OPEN_SETTINGS === '1';
/** 协议行前缀（与 helper-process.ts 的 BRIDGE_PREFIX 一致） */
const BRIDGE_PREFIX = 'dsh-pet-bridge:';

if (BRIDGE) {
  // 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
  // + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-pet-bridge',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();

/** win.id -> 上一次**请求**的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准，见那里的注释 */
const lastRequestedBounds = new Map();

/**
 * win.id -> 渲染端上报的窗口余量 `{ l, t }`（DIP）。
 * 上边距按气泡最大高度加高后**余量不再四边相等**，命中区不能再按「窗口宽/4」反推——
 * 这里存下来交给 pointer-target 的 spriteHitRect（见那里的注释）。
 */
const winMargins = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
function broadcastPetStates() {
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  petStates.set(petId, Object.assign({}, prev, partial));
  broadcastPetStates();
}

/**
 * 每窗口当前穿透状态（true = 整窗点击穿透）。所有 setIgnoreMouseEvents 只经本文件
 * （创建时初始化 + pet:set-interactive 翻转 + 光标兜底轮询），这里镜像真实状态，供冒烟断言/排查使用
 * （Electron 无 isIgnoringMouseEvents 取值 API）。
 */
const windowIgnore = new Map();

/** 翻转整窗穿透的**唯一出口**：状态与 windowIgnore 镜像永远一起更新（穿透期间保留 forward） */
function setWindowIgnore(win, ignore) {
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}

/** 兜底通道的光标轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按**真实光标**翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 为什么必须由渲染端说了算：兜底通道判定的是"光标与**窗口矩形**"的关系，而窗口矩形比宠物身体大
 * 一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于光标；甩得快时滞后量
 * 超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在拖拽的 window 级
 * pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去，连松手都没人报）。
 *
 * 主进程**无法自行判断**这件事（光看光标位置和窗口位移分不清"拖拽跟手"与"漫游/抛掷"），
 * 而渲染端知道（拖拽中 / 菜单开着 / 对话弹窗开着）。所以只由它上报，busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();
/** 新渲染端把菜单/聊天框局部矩形单独上报，避免忙碌态下整窗透明余量吞点击。 */
const inputRegions = new Map();

/** 每窗口「光标停在余量区且非 busy」的连续时长（ms）：到点由兜底通道强制恢复穿透 */
const offBodyMs = new Map();

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传（每只宠物一个窗口）。
 * 解析失败/未透传（手动 start-desktop）时回落到单个默认宠物窗口；renderer 首帧发来的
 * set-bounds 会按真实配置自校正尺寸与位置。
 * **空数组是合法输入，不等于「未透传」**：宿主在「桌面宠物被全部关掉、但 Helper 仍需活着
 * 托住托盘」时会明确传 []（见 src/host/index.ts 的 desktopModeEverActive），此时必须建
 * 0 个窗口——回落成默认窗口会让渲染端读到「没有 desktop/both 宠物」并弹出红色错误条。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量（4×0.5×size，与 renderer 的 WINDOW_MARGIN_RATIO 一致；
 *  renderer 首帧 set-bounds 会按真实配置精确覆盖，这里只是避免启动瞬间的尺寸跳变）。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 桌面几何：**逐显示器的工作区列表** + 它们的外接矩形 + 主屏下标。
 *
 * 外接矩形（hull）仍然是渲染端视口 VIEW 的来源——它只用作坐标系原点与比例换算基准。
 * 但所有边界判定（漫游落点 / 抛掷反弹 / 角落定位 / 菜单夹取）必须走 areas 的**并集**：
 * 显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以 hull 为边界会把宠物放进去
 * （实测右倒 T 型双屏：hull 的 23.7% 是空洞，宠物飞进去就彻底看不见了）。
 */
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}

function createPetWindows() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';
  const pets = petsFromEnv();
  const scale = petScale();
  for (const pet of pets) {
    // 初始窗口尺寸也要吃缩放补偿，否则启动瞬间会有一次可见的尺寸跳变
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      // macOS 默认会把已显示窗口的 y 钳到菜单栏下沿；局部画布的透明余量必须允许伸出屏幕。
      enableLargerThanScreen: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要窗口焦点才能打字（focusable:false 会让输入框永远无法聚焦）。
      // 显示时使用 showInactive()，不打断其它应用；用户主动点对话输入框时仍然允许获得焦点。
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, topmostLevel(process.platform));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口被其他窗口（另一只宠物）完全遮挡时，Chromium 默认会暂停本窗口渲染，
    // 导致大宠物移动盖过小宠物时小宠物显示为"消失"。关闭后台节流，让被遮挡
    // 窗口持续渲染，移开遮挡后立刻恢复显示。
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘组件弹出（两端一致），绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放 = petScale()（渲染端 CONFIG.scale 的同一来源）：整窗内容统一放大，渲染端坐标系
    // 回到 CSS 像素——右键菜单/积分弹窗/聊天框等固定 px UI 随之恢复 DIP 观感，不再逐处补偿
    // （见 DESIGN.md §3.5；跨进程交换仍走物理像素，由渲染端 toScreen/toLocal 收口）。
    // webPreferences.zoomFactor 对 show:false 的窗口不生效（实测），须在加载完成后设置。
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(scale);
    });
    // 默认整窗点击穿透（renderer 在光标进/出身体命中区时经 IPC 翻转可交互）；
    // forward:true 保证穿透期间 mousemove 仍转发进渲染端做命中判定。
    setWindowIgnore(win, true);
    win.once('ready-to-show', () => win.showInactive());
    // [#55 兜底显示] paintWhenInitiallyHidden:false 时渲染器可能不产出首帧，ready-to-show 便永不触发
    // （Electron 文档原文：ready-to-show "will never fire if you use paintWhenInitiallyHidden: false"），
    // 而 show() 只挂在它上面 → 窗口永远隐藏（进程活着、宠物逻辑照跑，桌面上什么都没有）。
    // 页面加载完成后强制兜底一次；zoomFactor 的设置在更早注册的 did-finish-load 里，顺序不受影响。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
      }, 400);
    });
    // [#55 兜底交互] 上面的翻转链路只有「Electron forward 鼠标钩子 → 渲染端命中判定」一个入口，
    // 该钩子在 Windows 上可能静默失效（回调超时被系统摘掉 / 被别的软件钩子干扰）→ 光标悬浮无反应、
    // 拖不动、点击与右键全废。这里由主进程按**真实光标位置**独立判定，不依赖那条转发链路：
    // 与 renderer 那条通道并存且判定区域一致（状态未变不翻转），转发正常的环境行为完全不变。
    //
    // 唯一不可自行决定的事：**渲染端正拿着鼠标输入时不得翻回穿透**（见 inputBusy）。
    // 本进程无从判断这件事——光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，所以由渲染端上报。
    const pointerTimer = setInterval(() => {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const b = win.getBounds();
      if (b.width < 8 || b.height < 8) return; // 尺寸还没落定（renderer 首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const busy = inputBusy.get(win.id) === true;
      const point = screen.getCursorScreenPoint();
      // 余量区停留计时：只在"非 busy 且在余量区"时累加，离开余量区即清零；busy 期间不累加。
      const mg = winMargins.get(win.id);
      const zone = pointerZone(b, point, mg);
      const nextMs = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
      offBodyMs.set(win.id, nextMs);
      const next = decideWindowIgnore(b, point, ignoring, busy, nextMs, inputRegions.get(win.id), mg);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    // [置顶看门狗] 建窗时那次 setAlwaysOnTop 之后再没人复查过：外部任何一次 z 序扰动都能让桌宠
    // 沉到普通窗下面——而 `WS_EX_TOPMOST` 位还在（点击穿透的读-改-写会把它写回来），于是
    // "是不是置顶"永远查得出 true、宠物却再也看不见，用户侧只能重启 helper 才回来。
    // 这里低频重钉一次：落地就是 SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)，
    // 不移动、不重绘、不抢焦点（判定的纯逻辑与全部依据见 topmost-watchdog.js）。
    //
    // 【注意】总开关 `TOPMOST_WATCHDOG_ENABLED` 当前是 **关闭** 的：重钉会把桌宠抬到所有置顶窗口
    // 之上，打断全屏游戏与截图。关闭的理由、代价、以及一个尚未解决的「显示桌面后误置顶」bug，
    // 都写在 topmost-watchdog.js 的文件头里 —— 要重新启用前请先读完那几节。
    let lastTopmostAssertMs = Date.now();
    const topmostTimer = setInterval(() => {
      const nowMs = Date.now();
      const due = shouldReassertTopmost(
        {
          nowMs,
          lastAssertMs: lastTopmostAssertMs,
          destroyed: win.isDestroyed(),
          visible: win.isVisible(),
          paused: pointerFallbackPaused,
        },
        TOPMOST_WATCHDOG_ENABLED,
      );
      if (!due) return;
      lastTopmostAssertMs = nowMs;
      win.setAlwaysOnTop(true, topmostLevel(process.platform));
    }, TOPMOST_WATCHDOG_TICK_MS);
    win.on('closed', () => {
      clearInterval(pointerTimer);
      clearInterval(topmostTimer);
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      winMargins.delete(win.id);
      windowIgnore.delete(win.id);
      inputBusy.delete(win.id);
      inputRegions.delete(win.id);
      offBodyMs.delete(win.id);
    });
    win
      // 绝对路径：本文件现在有两条运行方式（被宿主 spawn / 被 lib/app.js 同进程 require），
      // 相对路径会按 Electron 的 app 路径解析——同进程时那是 lib/，必然 ERR_FILE_NOT_FOUND。
      .loadFile(path.join(__dirname, 'index.html'), {
        query: {
          configUrl,
          bridge: BRIDGE ? '1' : '0',
          // 工具项「打开网站」的文案按宿主形态自动变（见 sprite.js）：desktop=唤起桌面应用 / site=打开站点
          openTarget: OPEN_TARGET,
          // 独立应用：工具首项改叫「设置」，点了开本进程内的设置窗口（见 openSettingsWindow）
          openSettings: OPEN_SETTINGS ? '1' : '0',
          scale: String(scale),
          petIndex: String(pet.index),
          // 本窗口承载的宠物 id：配置热更新后列表顺序可能变，渲染端按 id 认领
          petId: pet.id,
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          // 逐屏工作区（屏幕坐标）+ 主屏下标：渲染端所有边界判定走它们的并集，不走外接矩形。
          // 首帧就要用（position() 定角落），所以走 query；运行期变化再经 pet:displays 推送。
          areas: JSON.stringify(geo.areas),
          workAreas: JSON.stringify(geo.workAreas),
          topInsetRatio: String(geo.topInsetRatio),
          // 逐屏完整面板（含任务栏区）：抛掷越界侧探测用（任务栏条带不当墙，见 shared/physics.ts）
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// ---------- bridge 协议（渲染端 custom scheme → 本进程 → 宿主 stdout JSON 行 + 本地回调） ----------
// 渲染端的每个 fetch 都落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写 stdout 转发宿主。
// 宿主应答**不走近 0 号管道**：Electron 主进程在 Windows 上收不到 piped stdin（electron#4218），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调（DSH 闸门只拦 DSH WebServer 路由，管不到这里）；
// 请求行携带回调 URL，宿主处理完 POST 应答回来，按 id 唤醒等待中的请求。
// 素材（webm/字体/光标）：宿主只回文件绝对路径，本进程自行读盘应答（二进制不过管道）。
// 协议行统一前缀 BRIDGE_PREFIX，宿主侧按前缀区分协议与日志（console 输出也走 stdout）。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const id = ++bridgeSeq;
    bridgePending.set(id, { resolve, reject });
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\n');
    // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
    setTimeout(() => {
      const p = bridgePending.get(id);
      if (!p) return;
      bridgePending.delete(id);
      p.reject(new Error('bridge request timeout'));
    }, 45000).unref?.();
  });
}

/** 把宿主回调应答（{id, status, ...}）派发给对应请求 */
function bridgeResolve(resp) {
  const p = resp && bridgePending.get(resp.id);
  if (!p) return;
  bridgePending.delete(resp.id);
  p.resolve(resp);
}

/** 本地回调服务器：宿主把应答 POST 到这里（127.0.0.1 随机端口，绕开 stdin/DSH 闸门） */
function startBridgeCallback() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/respond') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-pet: not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bridgeResolve(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('dsh-pet: bad payload');
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('dsh-pet: bad payload');
    });
  });
  server.on('error', (e) => {
    console.error('[dsh-pet-desktop-helper] bridge callback server error:', String(e && e.message ? e.message : e));
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    bridgeCallbackUrl = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0) + '/respond';
    console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  });
  return server;
}

/** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await bridgeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径；带 range 让视频能拖动进度条）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-pet: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

// ---------- 系统托盘：桌面端显示开关 ----------
// 为什么托盘放在本进程：它是桌面模式唯一「不进浏览器」的入口。某只宠物的 display 被改成
// web/none 之后，它在桌面上就没有窗口了，**它自己的右键菜单也跟着消失**；托盘是此时唯一还能
// 在桌面侧把它切回桌面的地方（宿主的设置页要开浏览器，网页端宠物的右键菜单也得先开浏览器）。
// 但它不是非有不可：main 条目的 `trayEnabled` 为 false 时不建托盘（默认 true，见下 startTray）。
// 这种情况下宿主也不会为它常驻——判据是 desktopModeEverActive && trayEnabled（src/host/index.ts）：
// 托盘关掉后已经没有需要保住的东西，让本进程活着只是白烧一个空进程。
// 数据不新增任何通道：读配置与写回都走渲染端在用的同一条 bridge（手动 start-desktop 流退回 HTTP）。
// 菜单是静态的，但每次切换 display 都会让宿主重启本进程（syncDesktop），新进程按新配置重建菜单，
// 所以这里不需要任何「重建菜单刷新勾选」的逻辑。

const PET_ROUTE = '/dsh-pet-7340';
const ORIGIN = new URL(process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config').origin;
const TRAY_PLATFORM = trayPlatform(process.platform);

/** 与宿主 handlePetRoute 通信：bridge 模式走管道，手动 start-desktop 流退回 HTTP 直连 */
async function hostRequest(method, url, body) {
  if (BRIDGE) return bridgeRequest(method, url, body);
  const resp = await fetch(ORIGIN + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(APP_TOKEN ? { 'X-DSH-Pet-Token': APP_TOKEN } : {}),
    },
    body,
  });
  return { status: resp.status, body: await resp.text() };
}

const isDesktopDisplay = (display) => display === 'desktop' || display === 'both';

/** 翻转「桌面位」：both↔web、desktop↔none——浏览器位保持不动，因此不制造新的单向门 */
const toggleDisplay = (display) =>
  display === 'both' ? 'web' : display === 'web' ? 'both' : display === 'desktop' ? 'none' : 'desktop';

let tray = null;
/** 托盘菜单内容的签名：内容没变就不重建托盘（重建会让任务栏托盘图标闪一下） */
let traySignature = '';

/** 托盘菜单的全部可见信息（开关 + 每只宠物的名字与勾选态）——签名一致就没有重建的必要 */
function trayMenuSignature(merged) {
  const main = merged && merged.main ? merged.main : {};
  const pets = Object.values(merged || {})
    .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
    .map((pet) => [String((pet && pet.id) || ''), String((pet && pet.name) || '').trim(), String((pet && pet.display) || '')]);
  return JSON.stringify({ enabled: main.trayEnabled !== false, pets });
}

/** 写回某只宠物的 display：宿主写完配置会重启本进程，响应可能永远不回（同 sprite.js 的 setPetDisplay） */
function traySetPetDisplay(id, display) {
  hostRequest('POST', PET_ROUTE + '/pet-display', JSON.stringify({ id, display })).catch((e) => {
    console.error('[dsh-pet-desktop-helper] tray pet-display failed:', String(e && e.message ? e.message : e));
  });
}

/** 托盘图标：包内**圆角** logo 缩到 16×16（macOS 要模板图，否则深色菜单栏下看不见） */
function trayIcon() {
  const file = path.join(__dirname, '..', '..', 'assets', 'logo-rounded.png');
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    // 读不到图标 = 托盘不可见但菜单逻辑照跑，最难查的一种坏法：必须留下能定位的日志
    console.error('[dsh-pet-desktop-helper] tray icon missing or unreadable: ' + file);
    return img;
  }
  img = img.resize({ width: 16, height: 16 });
  if (TRAY_PLATFORM.templateImage) img.setTemplateImage(true);
  return img;
}

/**
 * 建托盘：列出**配置里全部**宠物（含 display 为 web/none 的——它们当前不在桌面上、勾是空的，
 * 点一下就能送回来，这是托盘相对宠物右键菜单的增量）。勾 = 当前 display 含 desktop/both。
 */
// ---------- 自绘托盘菜单（跟随应用主题） ----------
// 为什么不用 tray.setContextMenu：那是 **Windows 原生菜单**，配色由系统「应用模式」决定——
// 应用里切到浅色主题，它照样可能是深色（用户反馈的"托盘还是黑的"）。自绘 = 一个透明小窗口
// 里画一块 HTML，颜色和设置窗口共用同一套主题（localStorage 的 dsh-pet-settings-theme）。
// ---- 窗口复用：右键托盘要"立刻出来"，每次新建 BrowserWindow + 加载页面会慢半拍 ----
// 做法：菜单窗口常驻（隐藏），启动后预热一次；数据没变就直接按上次量好的尺寸弹出，
// 变了才通知页面重渲染（页面渲染完会汇报尺寸，主进程据此定位显示）。
let trayMenuWindow = null;
let trayMenuQuit = null;
let trayMenuPayload = null;
let trayMenuReady = false;
let trayMenuPending = false;
let trayMenuSized = false;
let trayMenuSize = { width: 200, height: 60 };
let trayMenuLastJson = '';

function closeTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) trayMenuWindow.hide();
}

/** 建（或复用）菜单窗口：只建一次，之后一直藏着待命 */
function ensureTrayMenuWindow() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) return trayMenuWindow;
  const win = new BrowserWindow({
    width: trayMenuSize.width,
    height: trayMenuSize.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // 阴影由页面里的 CSS 画（透明窗口的系统阴影会切掉圆角外的模糊）
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'tray-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  // 刚弹出的一瞬间 Windows 会有一连串焦点切换，250ms 内忽略 blur，
  // 否则菜单可能"闪一下就没了"（用户点了托盘却什么都看不到）。
  win.on('blur', () => {
    if (Date.now() - (win.dshShownAt || 0) < 250) return;
    closeTrayMenu();
  });
  win.on('closed', () => {
    if (trayMenuWindow === win) {
      trayMenuWindow = null;
      trayMenuReady = false;
      trayMenuSized = false;
    }
  });
  win.webContents.on('did-finish-load', () => {
    trayMenuReady = true;
  });
  win.loadFile(path.join(__dirname, 'tray-menu.html')).catch((error) => {
    console.error('[dsh-pet-desktop-helper] tray menu load failed:', String(error && error.message ? error.message : error));
  });
  trayMenuWindow = win;
  return win;
}

function showTrayMenu(payload) {
  if (!tray) return;
  const win = ensureTrayMenuWindow();
  trayMenuPayload = payload;
  const json = JSON.stringify(payload || null);

  const send = () => {
    if (win.isDestroyed()) return;
    trayMenuPending = true;
    win.webContents.send('tray-menu:data', payload || { pets: [], canQuit: false });
    // 兜底：页面 120ms 内没汇报尺寸就直接用上次的尺寸显示（宁可尺寸差一点，也别不出来）
    setTimeout(() => {
      if (trayMenuPending && !win.isDestroyed()) {
        trayMenuPending = false;
        placeTrayMenu(win, trayMenuSize.width, trayMenuSize.height);
      }
    }, 120);
  };

  // 数据与上次完全一致、页面也已量过尺寸 → 跳过渲染，直接弹（这条路径基本是瞬时的）
  if (trayMenuReady && trayMenuSized && json === trayMenuLastJson) {
    placeTrayMenu(win, trayMenuSize.width, trayMenuSize.height);
    return;
  }
  trayMenuLastJson = json;
  if (trayMenuReady) send();
  else win.webContents.once('did-finish-load', send);
}

/** 启动后预热：把菜单窗口先建好藏在后台，首次右键就不用等加载了 */
function warmUpTrayMenu() {
  try {
    ensureTrayMenuWindow();
  } catch (error) {
    console.error('[dsh-pet-desktop-helper] tray menu warmup failed:', String(error && error.message ? error.message : error));
  }
}

/** 拿到内容尺寸后贴着托盘图标定位（上方放不下就翻到下方），再显示 */
function placeTrayMenu(win, width, height) {
  if (!tray) return;
  const bounds = tray.getBounds();
  const centerX = Math.round(bounds.x + bounds.width / 2);
  const centerY = Math.round(bounds.y + bounds.height / 2);
  const area = screen.getDisplayNearestPoint({ x: centerX, y: centerY }).workArea;
  const x = Math.min(Math.max(Math.round(centerX - width / 2), area.x + 4), area.x + area.width - width - 4);
  let y = Math.round(bounds.y - height - 6);
  if (y < area.y + 4) y = Math.round(bounds.y + bounds.height + 6);
  win.setBounds({ x, y, width, height });
  win.dshShownAt = Date.now();
  win.showInactive();
  win.focus();
}

ipcMain.on('tray-menu:size', (event, dimensions) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  trayMenuSize = {
    width: Math.max(150, Math.min(320, Number(dimensions && dimensions.width) || 200)),
    height: Math.max(36, Math.min(600, Number(dimensions && dimensions.height) || 60)),
  };
  trayMenuSized = true;
  // 正在等尺寸（点击后首次渲染）或窗口已可见（数据变了要重新排版）→ 重新定位
  if (trayMenuPending || win.isVisible()) {
    trayMenuPending = false;
    placeTrayMenu(win, trayMenuSize.width, trayMenuSize.height);
  }
});

ipcMain.on('tray-menu:select', (event, payload) => {
  closeTrayMenu();
  if (!payload || typeof payload !== 'object') return;
  if (payload.action === 'quit') {
    if (typeof trayMenuQuit === 'function') trayMenuQuit();
    return;
  }
  if (payload.action === 'pet' && payload.id) {
    traySetPetDisplay(String(payload.id), toggleDisplay(String(payload.display || '')));
  }
});

ipcMain.on('tray-menu:close', () => closeTrayMenu());

// 自测/排障入口（主进程内部，不对外暴露给渲染端）：没有真实托盘点击也能把菜单叫出来看样式
globalThis.__dshPetShowTrayMenu = (payload) =>
  showTrayMenu(
    payload || {
      pets: [{ id: 'main', name: '蓝毛小女仆', display: 'desktop', checked: true }],
      canQuit: true,
    },
  );

async function startTray() {
  try {
    // 请求行要携带回调 URL，而端口在 startBridgeCallback 的 listen 回调里才有值（最多等 2s）
    for (let i = 0; BRIDGE && !bridgeCallbackUrl && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const resp = await hostRequest('GET', PET_ROUTE + '/config');
    const merged = JSON.parse(resp.body || '{}');
    // 托盘开关（main 条目的 trayEnabled）：只有**显式 false** 才不建——缺失或写坏时保持建，
    // 免得一份老配置/一个错值让托盘无声消失（非法值的告警由宿主读取侧统一报）。
    // 与下面的 pets 取自同一份成品配置，不新增任何通道。
    if (merged && merged.main && merged.main.trayEnabled === false) return;
    // 成品聚合的形状是 { <条目>: <整份配置文档> }——**顶层键不是宠物**，宠物在各条目的
    // `pets` 数组里。与渲染端同一契约（renderer.js 的 loadConfig → S.flattenConfigPets，
    // 规则源码见 src/shared/config.ts:26）。托盘只要 id/name/display，故不吹条目级字段。
    // 踩过的坑：把条目本身当宠物读 → name/display 恒为 undefined → 标题回落成 id（菜单只剩
    // 一个条目）、勾选恒为未选中、点击恒提交 desktop（现象就是「显示与不显示没区别」）。
    const pets = Object.values(merged)
      .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
      .map((pet) => ({
        id: String((pet && pet.id) || ''),
        name: String((pet && pet.name) || '').trim(), // host 已保证 name 缺失时回落 id
        display: String((pet && pet.display) || ''),
      }))
      .filter((pet) => pet.id);
    if (!pets.length) return; // 配置里没有任何宠物：没有可切换的对象，不建托盘
    // 托盘「退出」是否可用（issue #178）：三种来源各自成立——
    //   · 独立应用（APP_MODE）：本进程就是全部，app.quit() 即退出；
    //   · 手动 start-desktop.mjs（!BRIDGE）：node 父进程只等本进程退出，app.quit() 后进程树干净收场；
    //   · BRIDGE：宿主拉起的 Helper，**不能自己 app.quit()**——那会被当成崩溃按退避重启（点了只是闪一下），
    //     必须问宿主愿不愿意退（GET /quit 的 canQuit）。DSH 宿主不提供该能力，菜单项因此不出现。
    // 探测失败（旧宿主没有 /quit、返回素材兜底等）一律按"不支持"处理，行为与改动前一致。
    let hostCanQuit = false;
    if (BRIDGE && !APP_MODE) {
      try {
        hostCanQuit = JSON.parse((await hostRequest('GET', PET_ROUTE + '/quit')).body || '{}').canQuit === true;
      } catch (e) {
        console.error('[dsh-pet-desktop-helper] quit capability probe failed:', String(e && e.message ? e.message : e));
      }
    }
    const canQuit = APP_MODE || !BRIDGE || hostCanQuit;
    const quitApp = () => {
      if (!BRIDGE || APP_MODE) {
        app.quit();
        return;
      }
      // 交给宿主停机：它会先停本进程再退，所以这条请求不用等结果
      hostRequest('POST', PET_ROUTE + '/quit').catch((e) => {
        console.error('[dsh-pet-desktop-helper] tray quit failed:', String(e && e.message ? e.message : e));
      });
    };
    tray = new Tray(trayIcon());
    tray.setToolTip('ds-pet 桌面宠物');
    trayMenuQuit = canQuit ? quitApp : null;
    // 每次弹菜单都现取一份数据：勾选状态跟着配置走（配置改动后托盘会重建，这里再兜一层）
    const buildTrayPayload = () => ({
      pets: pets.map((pet) => ({
        id: pet.id,
        name: pet.name || pet.id,
        display: pet.display,
        checked: isDesktopDisplay(pet.display),
      })),
      canQuit,
    });
    if (process.platform === 'win32') {
      // Windows：左右键都用自绘菜单（跟随应用深浅色）。原生菜单的颜色由系统「应用模式」
      // 决定，应用内主题切了它不会跟着变——这正是要自绘的原因。
      tray.on('right-click', () => showTrayMenu(buildTrayPayload()));
      tray.on('click', () => showTrayMenu(buildTrayPayload()));
    } else {
      // 其它平台：保留原生菜单（macOS 的菜单栏习惯与系统菜单联动，自绘反而违和）
      tray.setContextMenu(
        Menu.buildFromTemplate([
          ...buildTrayPayload().pets.map((pet) => ({
            label: pet.name,
            type: 'checkbox',
            checked: pet.checked,
            click: () => traySetPetDisplay(pet.id, toggleDisplay(pet.display)),
          })),
          ...(canQuit ? [{ type: 'separator' }, { label: '退出', click: quitApp }] : []),
        ]),
      );
      if (TRAY_PLATFORM.leftClickPopsMenu) tray.on('click', () => tray.popUpContextMenu());
    }
    // 记下这次菜单的内容签名：配置刷新时只有内容变了才重建托盘（见 refreshPetWindows）
    traySignature = trayMenuSignature(merged);
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] tray init failed:', String(e && e.message ? e.message : e));
  }
}

app.whenReady().then(() => {
  // 探测子进程：此时没有 force-device-scale-factor，读到的是 Windows 的真实主屏缩放。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  console.error(
    '[dsh-pet-desktop-helper] displays: ' +
      JSON.stringify(deskGeometry()) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );

  if (BRIDGE) {
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      handleBridgeRequest(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
    startBridgeCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  // macOS：桌面宠物不该占 Dock——Dock 里多一个图标只会碍事。**不跟 trayEnabled 联动**：
  // 宠物本体的右键菜单在，桌面侧仍能操作（只有「宠物全不在桌面」时才真正没有入口，那是另一件事）。
  if (TRAY_PLATFORM.hideDock && app.dock) app.dock.hide();

  // 托盘：不 await（建窗与建托盘互不依赖），内部自己等 bridge 回调服务就绪
  void startTray();
  // 预热自绘菜单窗口（建好藏着），让首次右键不用等页面加载
  setTimeout(warmUpTrayMenu, 1200);

  createPetWindows();

  // 宠物窗口跟随：renderer 逐帧上报窗口内容区位置/尺寸
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    // 去重必须比较**我们上一次请求的值**，绝不能拿 win.getContentBounds() 回读值来比：
    // 跨缩放屏的 DIP↔物理 往返有 ScaleToEnclosingRect（向外取整）与 origin 舍入，
    // 读回值与设定值永远不相等，去重永远不生效，反而变成每帧强制重设窗口位置。
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    // 窗口余量（左右/上）：命中区判定的依据，余量四边不再相等（上边距按气泡最大高度加高）
    const ml = Number(bounds?.marginL);
    const mt = Number(bounds?.marginT);
    if (Number.isFinite(ml) && Number.isFinite(mt)) winMargins.set(win.id, { l: ml, t: mt });
    // 碰撞站场：位置必须用**包围盒左上角**（renderer 显式上报 boxX/boxY）——
    // 窗口坐标 = 包围盒 − margin（半只宠物宽），直接拿窗口坐标会让跨窗检测整体错位
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (petId) {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 是每次位置变化都会触发的全量上报
      // （此前只更新 x/y，静止宠物 size 永远为 0，跨窗碰撞检测 `!o.size` 直接跳过它）；
      // 速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不再残留旧飞行速度。
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      });
    }
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (!petId) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { vx, vy });
    }
  });

  // 点击穿透翻转：renderer 在光标进/出身体命中区时上报；穿透期间仍保留 forward（mousemove 继续转发）。
  // 兜底轮询（见 createPetWindows）也走同一个出口 setWindowIgnore，两条通道共享同一份镜像状态。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const input = inputRegions.get(win.id);
    // 渲染端的旧 menuOpen/chatOpen 守卫会请求整窗可交互；这里按真实光标和控件矩形裁定。
    const ignoring =
      interactive && input && inputBusy.get(win.id)
        ? decideWindowIgnore(
            win.getContentBounds(),
            screen.getCursorScreenPoint(),
            false,
            true,
            0,
            input,
            winMargins.get(win.id),
          )
        : !interactive;
    setWindowIgnore(win, ignoring);
  });

  // 拖拽持有完整输入租约；菜单/对话则由 inputRegions 把交互限制在实际控件矩形内。
  // 只存标记、不直接翻转窗口——**唯一出口**仍是 setWindowIgnore（在兜底轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态。
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const rects = input.rects.filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
    inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });

  // ---------- 设置窗口（独立应用） ----------
  /**
   * 设置窗口：一个**普通** Electron 窗口，加载本目录的 settings.html。
   *
   * 为什么不打开 http://127.0.0.1:<port>/settings/：独立应用里每次启动端口都是随机的，
   * 令牌还只存在于地址的 #token= 里——用户得先点右键、等系统浏览器起来、地址失效后还得重来。
   * 设置本来就是应用的一部分，直接开窗口更自然：窗口与宠物同进程，数据经 IPC 直达宿主
   * （见下面的 pet:host-request），**不经本机 HTTP 服务**。
   *
   * 单实例：重复点击只把已有窗口叫到前台，不叠第二个设置窗口。
   */
  let settingsWindow = null;

  /**
   * 设置窗口的位置/大小记忆。
   *
   * 为什么需要：它是一个会被反复打开的窗口，用户拖到副屏、调成顺手的大小以后，
   * 下次打开又跳回"主屏 + 固定尺寸"，很别扭。存在 userData 下
   * （应用模式 = %APPDATA%/dsh-pet/settings-window.json），只记 x/y/width/height。
   *
   * 恢复前做可用性校验，坏数据/旧布局都不能把窗口扔到看不见的地方：
   *   - 尺寸不小于窗口最小尺寸（640×460）；
   *   - 至少有一块屏的工作区与它相交（拔掉副屏后那份坐标就作废，回落默认）。
   */
  const settingsWindowStateFile = () => path.join(app.getPath('userData'), 'settings-window.json');

  function readSettingsWindowBounds() {
    try {
      const raw = JSON.parse(readFileSync(settingsWindowStateFile(), 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      const bounds = { x: Number(raw.x), y: Number(raw.y), width: Number(raw.width), height: Number(raw.height) };
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
      if (bounds.width < 640 || bounds.height < 460) return null;
      const reachable = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        // 露出一截就算可用（左上角完全在屏外时用户找不到窗口）
        return (
          bounds.x < area.x + area.width - 80 &&
          bounds.x + bounds.width > area.x + 80 &&
          bounds.y < area.y + area.height - 40 &&
          bounds.y + bounds.height > area.y
        );
      });
      return reachable ? bounds : null;
    } catch {
      return null;
    }
  }

  function saveSettingsWindowBounds(win) {
    if (!win || win.isDestroyed()) return;
    try {
      // getNormalBounds：最大化/全屏时取"还原后"的框，下次打开才不会直接铺满屏
      const bounds = win.getNormalBounds();
      writeFileSync(
        settingsWindowStateFile(),
        JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
        'utf8',
      );
    } catch {
      /* 落盘失败只影响下次的位置，不影响窗口本身 */
    }
  }

  function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    // 位置/尺寸：优先用上次的（窗口记忆），没有或已失效时沿用"按主屏工作区自适应"的默认值
    const area = screen.getPrimaryDisplay().workAreaSize;
    const defaultWidth = Math.max(680, Math.min(840, area.width - 80));
    const defaultHeight = Math.max(500, Math.min(760, area.height - 80));
    const remembered = readSettingsWindowBounds();
    const win = new BrowserWindow({
      ...(remembered
        ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height }
        : { width: defaultWidth, height: defaultHeight }),
      minWidth: 640,
      minHeight: 460,
      title: 'ds-pet 设置',
      // 窗口/任务栏图标：用**圆角**版本（透明角），直角方图在 Windows 任务栏里像个白块
      icon: path.join(__dirname, '..', '..', 'assets', 'logo-rounded.png'),
      backgroundColor: '#f4f9fc',
      // 只关系统标题栏（标题栏由页面自绘），窗口本身仍要 Win11 的圆角与投影 ——
      // 直角无边框看起来像贴在屏幕上的色块，反而不像正常窗口。
      frame: false,
      roundedCorners: true,
      hasShadow: true,
      show: false,
      autoHideMenuBar: true,
      // 不置顶：设置是"叫出来用完就切走"的窗口，压在其它应用上只会碍事
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    // 露脸时机：等页面**数据就绪**（settings.js 拉完 /config 并渲染完，会发 pet:settings-ready），
    // 不是等 did-finish-load —— 那时骨架已经画出来了但数据还没填，会看到"空卡片闪一下"。
    // 1.5s 兜底显示：资源异常时窗口也要能出来。
    let revealed = false;
    const reveal = () => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      win.show();
      win.focus();
    };
    win.dshReveal = reveal;
    setTimeout(reveal, 1500);
    // 窗口记忆：拖动/缩放停手 400ms 后落盘（moved/resized 在拖动中会连发），关闭时再补一次。
    let boundsTimer;
    const scheduleSaveBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => saveSettingsWindowBounds(win), 400);
    };
    win.on('resized', scheduleSaveBounds);
    win.on('moved', scheduleSaveBounds);
    win.on('close', () => {
      clearTimeout(boundsTimer);
      saveSettingsWindowBounds(win);
    });
    win.on('closed', () => {
      if (settingsWindow === win) settingsWindow = null;
    });
    // 设置页里的链接（第三方文档等）一律走系统浏览器，不在应用窗口里导航出去
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:[/][/]/.test(url)) shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });
    win.loadFile(path.join(__dirname, 'settings.html')).catch((error) => {
      console.error('[dsh-pet-desktop-helper] settings page load failed:', error);
    });
    settingsWindow = win;
  }

  /**
   * 设置窗口的数据通道：IPC → 宿主路由（**不经过本机 HTTP 服务**）。
   *
   * 单进程应用里宿主把 `globalThis.__dshPetHostRequest` 注进来（lib/app.js），直接调
   * `handlePetRoute` —— 同一份业务逻辑、零网络、零端口、不用令牌。
   * 双进程（CLI 独立模式）没有这个注入，回落到既有的 stdout 行协议（宿主同进程应答）。
   */
  async function settingsRequest({ method = 'GET', path: routePath = '/', body } = {}) {
    const direct = globalThis.__dshPetHostRequest;
    if (typeof direct === 'function') return await direct({ method, path: routePath, body });
    const url = routePath.startsWith('/dsh-pet-') ? routePath : PET_ROUTE + routePath;
    const resp = await bridgeRequest(method, url, body);
    return { status: resp.status, body: resp.body };
  }

  ipcMain.handle('pet:host-request', async (_event, payload) => {
    try {
      return await settingsRequest(payload || {});
    } catch (error) {
      return { status: 500, body: JSON.stringify({ error: String((error && error.message) || error) }) };
    }
  });

  /**
   * 配置热更新：**不重启进程**，让桌面宠物按最新配置就地生效。
   *
   * 以前这件事靠"重启整个应用"（`restartApp`）：单进程里 helper 就是主进程，停/起 helper 都是
   * 空操作，只有重启才换得掉窗口——代价是 1–2 秒黑屏、设置窗口被关掉、宠物重新加载。
   *
   * 现在分两种情况，都只动必要的部分：
   *   ① 桌面宠物**成员没变**（改大小/位置/角落/开关/人设…）→ 给每个窗口发 `pet:config-changed`，
   *      渲染端重拉 /config 重建 sprite。不关窗、不断轮询，改完立刻可见。
   *   ② **成员变了**（新增/删除宠物、display 在 web 与 desktop 之间切换）→ 按新列表重建窗口
   *      （进程、托盘与设置窗口都不动）。
   * 两种情况都会重建托盘（名称/勾选/trayEnabled 可能一起变了）。
   */
  let refreshingWindows = false;
  async function refreshPetWindows(reason = 'config-change') {
    if (refreshingWindows) return;
    refreshingWindows = true;
    try {
      const resp = await settingsRequest({ method: 'GET', path: PET_ROUTE + '/config' });
      const merged = JSON.parse(resp.body || '{}');
      const pets = Object.values(merged)
        .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
        .filter((pet) => isDesktopDisplay(String((pet && pet.display) || '')))
        .map((pet) => ({ id: String(pet.id), size: Number(pet.size) || 462 }));

      // 签名要带上 **size**：窗口的宽高是按 size 算出来的，只改大小的时候成员没变、
      // 如果只比 id 就不重建窗口 → 宠物在新尺寸下画进旧窗口，位置/裁切全乱，
      // 视觉上就是「多出来一只 / 两只叠在一起」。
      const signatureOf = (list) =>
        list
          .map((pet) => pet.id + ':' + (Number(pet.size) || 462))
          .sort()
          .join(',');
      const nextIds = signatureOf(pets);
      const currentIds = (() => {
        try {
          const current = JSON.parse(process.env.DSH_PET_PETS || '[]');
          if (Array.isArray(current) && current.length > 0) return signatureOf(current);
        } catch {
          /* 环境变量坏了就退回只比 id */
        }
        return [...windows.keys()].sort().join(',');
      })();

      if (nextIds === currentIds) {
        for (const win of windows.values()) {
          if (!win.isDestroyed()) win.webContents.send('pet:config-changed');
        }
      } else {
        // 窗口数量/归属变了：按最新列表重建（DSH_PET_PETS 是 createPetWindows 的输入）
        process.env.DSH_PET_PETS = JSON.stringify(pets);
        for (const win of [...windows.values()]) {
          if (!win.isDestroyed()) win.destroy();
        }
        windows.clear();
        createPetWindows();
      }

      // 托盘只在内容真的变了时重建（改开关/人设时没必要让任务栏图标闪一下）
      if (trayMenuSignature(merged) !== traySignature) {
        if (tray) {
          tray.destroy();
          tray = null;
        }
        void startTray();
      }
      console.error('[dsh-pet-desktop-helper] config refreshed (' + reason + '): ' + JSON.stringify(pets));
    } catch (error) {
      console.error('[dsh-pet-desktop-helper] config refresh failed:', error);
    } finally {
      refreshingWindows = false;
    }
  }
  // 宿主（lib/app.js）的 syncDesktop 在应用模式下调用它，替换"重启进程"
  globalThis.__dshPetRefreshPetWindows = refreshPetWindows;
  ipcMain.on('pet:open-settings', () => openSettingsWindow());

  // 设置页数据就绪（拉完 /config 并渲染完）：这时才把窗口显示出来 —— 首帧即完整内容
  ipcMain.on('pet:settings-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && typeof win.dshReveal === 'function') win.dshReveal();
  });

  // 设置窗口右上角的路径点击：在资源管理器里定位文件（文件缺失就打开所在目录）。
  // 只做"定位"，不接受任意命令；路径来自宿主自己的 /config/meta，渲染端传什么由它决定，
  // 但这里仍按纯路径处理（resolve + 存在性检查），不做字符串拼接执行。
  ipcMain.on('pet:reveal-path', (event, target) => {
    const raw = typeof target === 'string' ? target.trim() : '';
    if (!raw || raw.includes('\0')) return;
    try {
      const file = path.resolve(raw);
      if (existsSync(file)) shell.showItemInFolder(file);
      else {
        const dir = path.dirname(file);
        if (existsSync(dir)) void shell.openPath(dir);
      }
    } catch {
      /* 定位失败不影响其它功能 */
    }
  });

  // 主题广播：设置窗口切换深浅色 → 所有宠物窗口（右键菜单等浮层）跟着换色。
  // 主进程不保存主题：真正的持久化在 localStorage（同源，各窗口都能读）。
  ipcMain.on('pet:theme', (event, mode) => {
    const value = mode === 'dark' ? 'dark' : 'light';
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:theme', value);
    }
    // 自绘托盘菜单也是常驻窗口（预热后一直藏着），切换主题时同样要通知它，
    // 否则它停在上次打开时读到的旧主题上（用户反馈的"托盘颜色不跟随"）。
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.webContents.send('tray-menu:theme', value);
    }
  });

  // 无边框窗口的自绘标题栏按钮（最小化 / 关闭）：窗口是 frame:false，系统按钮不存在，
  // 这两个动作必须由页面经 IPC 请求。
  ipcMain.on('pet:settings-window', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'close') win.close();
  });

  // 右键菜单「打开网站」：交给**系统默认浏览器**打开（等效于网页里 Ctrl+点击链接新标签页），
  // 不建专属窗口——宠物窗口机制是透明小窗，不该承载常规网页浏览。URL 由渲染端从
  // configUrl 推导 = DSH webServer 端口，端口变化自动跟随
  const openSite = (url) => {
    // 宿主注入的已鉴权站点 URL（含本进程启动令牌）：DSH 只在 `GET /` 接受它并换发绑定 authority 的
    // 浏览器 Cookie，裸 origin 在默认浏览器里必然 401（#87）。令牌等价登录态，所以**只在与目标同
    // origin 时**才启用——绝不让它被带去别的站点；取不到该变量（旧宿主 / standalone / 手写
    // start-desktop）时，行为与以前完全一致。
    let target = url;
    const authed = process.env.DSH_PET_SITE_URL || '';
    if (/^https?:[/][/]/.test(authed)) {
      try {
        if (new URL(authed).origin === new URL(url).origin) target = authed;
      } catch {
        /* 形状不对：保持裸地址（原行为） */
      }
    }
    shell.openExternal(target).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  };

  // 去向由宿主形态决定（OPEN_TARGET，宿主按自身形态注入）：
  //   desktop（宿主 = DSH 桌面应用）→ 用应用自注册的 dsh:// 协议把主窗口叫回前台：已运行则第二个实例
  //     被单实例锁拦下、宿主收到 second-instance 后 focusPrimaryWindow()；未运行则协议直接把应用拉起来。
  //     比 spawn 宿主 exe 干净——不必处理 ELECTRON_RUN_AS_NODE（spawn 继承它就成了 node 模式，起不了界面）
  //     与安装路径探测。
  //   site（dsh web / 独立模式）→ 原行为：系统默认浏览器打开站点。
  ipcMain.on('pet:open-site', (event, payload) => {
    // 独立应用：这一项在菜单里已经改叫「设置」（见 sprite.js 的 OPEN_SETTINGS），
    // 点了开本进程的设置窗口——不再经过 localhost 上的设置页，也不叫起系统浏览器。
    if (OPEN_SETTINGS) {
      openSettingsWindow();
      return;
    }
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    if (OPEN_TARGET === 'desktop') {
      // 协议未注册（绿色版 / 注册表被清）时回落成打开站点，至少不是"点了没反应"
      shell.openExternal('dsh://open').catch((error) => {
        console.error('[dsh-pet-desktop-helper] open dsh:// failed, falling back to site:', error);
        openSite(url);
      });
      return;
    }
    openSite(url);
  });

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。原先几何只在
  // createPetWindows() 算一次并经 URL query 注入，渲染端 VIEW 是模块顶层常量，运行期永不更新——
  // 表现为「改了分辨率后可移动范围还是旧的」。这里重算并推给所有窗口，渲染端就地重挂。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了（它决定宠物的尺寸补偿）。线性化生效期间 screen API 只报被强制的值，
    // 真实值只能靠探测子进程拿；不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 冒烟自检模式（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路（如 CI 或本地验证）。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    const target = windows.values().next().value;
    if (target) {
      // 转发渲染端 console（定位动画/余额/错误问题）
      target.webContents.on('console-message', (event) => {
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }
    setTimeout(async () => {
      try {
        const first = windows.values().next().value;
        if (first && !first.isDestroyed()) {
          const dump = await first.webContents.executeJavaScript(`(async () => ({
            hasBridge: typeof window.petBridge !== 'undefined',
            hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })(),
            releaseKeptPosition: await (async function () {
              // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
              // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
              // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
              // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.dragPos || !hit) return null;
              var P = { x: d.dragPos.x, y: d.dragPos.y };
              var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
              var upX = 1000 + (T.x - P.x);
              var upY = 600 + (T.y - P.y);
              var sleep = function (ms) {
                return new Promise(function (r) {
                  setTimeout(r, ms);
                });
              };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(400); // 弹簧跟随收敛
              var during = { x: d.dragPos.x, y: d.dragPos.y };
              await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(80); // 释放处理完成
              var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
              return {
                during: during,
                released: released,
                kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
              };
            })(),
            interactiveFlip: (function () {
              // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
              // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上窗口外扩余量 winMargin。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.hitRect || !d.winMargin || !hit) return null;
              var r = d.hitRect;
              var m = d.winMargin;
              var xIn = m.l + r.x + r.w / 2;
              var yIn = m.t + r.y + r.h / 2;
              var xOut = Math.max(0, m.l + r.x - 20);
              var yOut = Math.max(0, m.t + r.y - 20);
              var out = {};
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
              out.inside = d.interactive === true;
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.outside = d.interactive === false;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.duringDragForced = d.interactive === true;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
              return out;
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
            menuSmoke: await (async function () {
              // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
              // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
              await new Promise(function (resolve) {
                setTimeout(resolve, 250);
              });
              var hit = document.querySelector('.pet-hit');
              var d = window.__dshPetDebug;
              if (!hit || !d) return null;
              var errsBefore = (d.errors || []).length;
              try {
                hit.dispatchEvent(
                  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
                );
              } catch (err) {
                return { threw: String(err), menuMounted: false };
              }
              var menu = document.querySelector('.dsh-pet-menu');
              var out = {
                threw: null,
                menuMounted: !!menu,
                menuOpen: d.menuOpen === true,
                rootText: menu ? menu.textContent.slice(0, 60) : '',
                errsNew: (d.errors || []).length - errsBefore,
              };
              if (menu) {
                var branch = menu.querySelector('.dsh-pet-menu-branch');
                if (branch) {
                  branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                  var panels = Array.prototype.slice.call(
                    menu.querySelectorAll('.dsh-pet-menu-column'),
                  );
                  var visible = function () {
                    return panels.filter(function (p) {
                      return p.style.display !== 'none';
                    });
                  };
                  out.panelCount = panels.length;
                  out.lvl2AfterHoverRoot = visible().length;
                  // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                  var panel1 = visible().filter(function (p) {
                    return p !== panels[0];
                  })[0];
                  if (panel1) {
                    var cat = panel1.querySelector('.dsh-pet-menu-branch');
                    if (cat) {
                      cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 50);
                      });
                      out.lvl3AfterHoverCat = visible().length;
                      // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                      // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 60);
                      });
                      var panel2 = visible()[visible().length - 1];
                      if (panel2) {
                        panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                      }
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 220);
                      });
                      out.lvl3SurvivedAfterReenter = visible().length;
                      // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 260);
                      });
                      out.lvl3AfterGapHover = visible().length;
                    }
                  }
                }
              }
              return out;
            })(),
          }))()`);
          console.log(
            '[dsh-pet-desktop-helper] smoke dump: windows=' +
              windows.size +
              ' ids=' +
              JSON.stringify([...windows.keys()]) +
              ' => ' +
              JSON.stringify(dump),
          );
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：setInteractive(true)→窗口捕获输入（忽略鼠标=false）；
          // setInteractive(false)→恢复整窗穿透（忽略鼠标=true）。状态取自主进程镜像 windowIgnore。
          // 期间暂停兜底轮询：它按真实光标位置翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
          pointerFallbackPaused = true;
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
          await new Promise((r) => setTimeout(r, 80));
          const interactiveIgnoring = windowIgnore.get(first.id);
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
          await new Promise((r) => setTimeout(r, 80));
          const passthroughIgnoring = windowIgnore.get(first.id);
          pointerFallbackPaused = false;
          console.log(
            '[dsh-pet-desktop-helper] smoke interactive round-trip:',
            JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
          );
          const image = await first.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

// 退出时销毁托盘图标：不销毁会在 Windows 通知区留下「幽灵图标」（鼠标划过才消失）。
// 注意宿主改 display 时是 SIGTERM/SIGKILL 硬杀（helper-process.ts），Windows 上那是
// TerminateProcess、拦不到，所以这条只覆盖优雅退出（窗口全关、宿主存活探测判定退出等）。
app.on('before-quit', () => {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] tray destroy failed:', String(e && e.message ? e.message : e));
  }
  tray = null;
});

app.on('window-all-closed', () => {
  // 托盘常驻：桌面上没有宠物也要留着（否则「全关掉」就再也切不回来，见 index.ts 的 desktopModeEverActive）
  if (tray) return;
  app.quit();
});

/**
 * dsh-pet 独立应用主进程 —— 「双击就能跑」的桌宠应用入口（单进程）。
 *
 * 它把三件事装进**同一个 Electron 进程**（不再 spawn 第二个 electron.exe）：
 *   1. 本机 HTTP 服务：插件宿主半边注册的路由 + 独立模式那套「配置页 / 状态页」；
 *   2. 插件宿主半边：`apply()` 跑在 `src/standalone/context.ts` 造的最小伪 ctx 上；
 *   3. 桌面窗口：直接 `require` 现成的 `runtime/electron-helper/main.js`，窗口、托盘、拖拽、碰撞、
 *      DPI 补偿全部沿用桌面模式那一套，没有第二份实现。
 *
 * HTTP 面与 `dsh-pet-standalone`（CLI）保持一致，因为右键「打开 AI 设置」打开的就是这些地址：
 *   GET  /                      落地页（版本、配置路径、宠物清单）
 *   GET  /health                JSON 状态
 *   GET  /standalone-ai/        AI 配置页（HTML，与 CLI 同一份 settingsPage）
 *   GET/POST /standalone-ai/settings   读写配置（需 X-DSH-Pet-Token，令牌在地址的 #token= 里）
 *   POST /standalone-ai/test    连通性测试
 *   *    /dsh-pet-7340/...      插件路由（桌面窗口用，因此额外放行 CORS）
 *
 * 插件路由也检查令牌与 Host；本地 file 页面由主进程给请求附加访问凭证，
 * null 来源本身不授予权限。凭证不写入页面地址、渲染脚本或日志。
 *
 * 环境变量（应用自身用，不影响 DSH 内运行）：
 *   DSH_PET_IN_PROCESS=1  交给宿主半边：不 spawn helper、不下载 Electron（见 src/host/index.ts）
 *   DSH_PET_APP_MODE=1    交给 helper：托盘加「退出」、userData 独立
 *   DSH_PET_SITE_URL      交给 helper：右键「打开网站」用它（这里指向带令牌的配置页）
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir } from '../host/helper-process';
import { apply } from '../host/index';
import { createFileLogger, setDefaultLogger } from '../host/log-file';
import { createStandaloneAi, type StandaloneAiService } from '../standalone/ai-provider';
import { registerStandaloneBalance } from '../standalone/balance-provider';
import { packageVersion } from '../standalone/check';
import { publicSettings, validateSettings } from '../standalone/settings';
import { createStandaloneContext, type RegisteredRoute } from '../standalone/context';
import { configPathsFor } from '../standalone/options';
import { createRequestSecurity } from '../standalone/request-security';

import { installDesktopAuth, type DesktopSession } from './desktop-auth';
import { startRouter } from './router';

/**
 * `electron` 由 Electron 运行时提供，**不是本包的依赖**。只声明实际用到的成员：
 * 静态 `import 'electron'` 会让 `tsc --noEmit` 找不到类型而整仓变红。
 */
interface WebContentsLike {
  on(
    event: 'console-message',
    listener: (event: unknown, level: number, message: string, line: number, sourceId: string) => void,
  ): void;
}
interface ElectronApp {
  whenReady(): Promise<void>;
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
  /** 重启自己（重载配置用：窗口数/大小/display 全靠启动时读取） */
  relaunch(options?: { args?: string[]; execPath?: string }): void;
  /** 正常退出（触发 will-quit 收尾） */
  quit(): void;
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContentsLike) => void): void;
  on(event: 'second-instance', listener: () => void): void;
  on(event: 'will-quit', listener: () => void): void;
}
const { app, session } = createRequire(import.meta.url)('electron') as {
  app: ElectronApp;
  session: { defaultSession: DesktopSession };
};

/** lib/app.js → 包根（与 helper-process.ts 的 packageRoot 同一口径：模块所在目录的上一级） */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const helperMain = join(packageRoot, 'runtime', 'electron-helper', 'main.js');

const log = (message: string): void => console.log(`[dsh-pet-app] ${message}`);

/** 单实例：第二次双击直接退出（共用 userData 的 Chromium profile 会互踢） */
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.exit(0);
} else {
  await boot();
}

/**
 * 启动应用。`await` 在最外层：端口必须在 `require(helperMain)` 之前确定，因为 helper 在
 * `app.whenReady()` 里就要用 `DSH_PET_CONFIG_URL` / `DSH_PET_SITE_URL`；而它又必须在 ready
 * 之前被 require（内部有 `app.commandLine.appendSwitch`，ready 后再加不生效）。
 */
async function boot(): Promise<void> {
  // 独立应用没有控制台：插件日志、standalone 日志、以及同进程 helper/渲染端的 console 全部落盘。
  // 原始 console 方法要**先快照**：包装后的 console 会转给文件 logger，而 logger 的 base 必须指向
  // 原始方法，否则 logger → console → logger 无限递归。
  const logFile = join(dshHomeDir(), 'dsh-pet', 'logs.txt');
  const rawConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  const logger = createFileLogger({
    file: logFile,
    base: rawConsole,
    debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
  });
  const toLine = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]): void => {
      rawConsole[level](...args);
      logger[level](toLine(args));
    };
  }
  console.log = (...args: unknown[]): void => {
    rawConsole.log(...args);
    logger.info(toLine(args));
  };
  // 纯模块（config/chat/whisper）没有 ctx.logger，靠默认出口落盘
  setDefaultLogger(logger);

  const routes: RegisteredRoute[] = [];
  let port = 0;

  // 与 CLI 同一套安全模型：令牌只经「配置页地址的 #token=」递到浏览器，不进日志
  const security = createRequestSecurity();
  const ai = createStandaloneAi(dshHomeDir(), logger);
  // 独立模式的余额 provider：把 `standalone` 这个 id 也接到真余额上（DSH 内走宿主凭证，这里走
  // 本机 AI 配置里的密钥，见 standalone/balance-provider.ts）。没配 AI 时它明确报「未配置」。
  const releaseBalance = registerStandaloneBalance(ai);
  const context = createStandaloneContext({
    port: () => port,
    logger,
    routes,
    ai,
    authenticatedUrl: security.authenticatedUrl,
    /**
     * 「重载配置」/ 保存配置 / 改显示位置 → 让桌面宠物按最新配置生效。
     *
     * 宿主侧的 syncDesktop 在应用模式下会取这个能力（见 src/host/index.ts）：单进程里
     * 「停旧 helper、起新 helper」是空操作，所以必须换成"就地刷新窗口"。
     * helper 已把 `__dshPetRefreshPetWindows` 挂到 globalThis（同进程），优先用它；
     * 拿不到（helper 尚未 ready）才回落到重启进程。
     */
    restart: (reason) => {
      // 优先**热刷新**：helper 在同一进程里挂出了 `__dshPetRefreshPetWindows`，按最新配置
      // 就地重建窗口 / 通知渲染端重拉配置——设置窗口不会关，改完立刻生效（几毫秒到几百毫秒）。
      // 只有 helper 还没 ready（极早期）时才回落到"重启进程"这条老路。
      const refresh = (globalThis as Record<string, unknown>).__dshPetRefreshPetWindows;
      if (typeof refresh === 'function') {
        log(`按最新配置刷新宠物窗口（${reason}）`);
        void (refresh as (reason: string) => Promise<void>)(reason);
        return;
      }
      log(`按最新配置重启应用（${reason}）`);
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 200);
    },
    // 托盘「退出」/ POST /dsh-pet-7340/quit：走正常退出，will-quit 里统一收尾。
    shutdown: (reason) => {
      log(`退出应用（${reason}）`);
      app.quit();
    },
  });

  const server = await startRouter(routes, { security, ai, log, status, landingPage });
  port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  log(`本机服务 ${origin}`);

  // 先把「我自己就是应用」告诉插件，再 apply：apply 内部据此短路 spawn 与下载
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_APP_MODE = '1';
  process.env.DSH_PET_OPEN_TARGET = 'site';
  // 右键菜单首项改叫「设置」，点了开本进程的设置窗口（不叫浏览器、不经 localhost）
  process.env.DSH_PET_OPEN_SETTINGS = '1';
  // 不注入宿主 PID：helper 的「宿主没了就退出」只对双进程有意义，同进程里设了会自己杀自己
  delete process.env.DSH_PET_HOST_PID;
  process.env.DSH_PET_CONFIG_URL = `${origin}/dsh-pet-7340/config`;
  // 右键「打开网站」用它：带令牌的**桌宠设置页**（改大小/位置/显示位置/多开都在这）。
  // 裸 origin 在应用里只有一个落地页；AI 密钥那页从设置页里的「AI 设置」按钮进。
  process.env.DSH_PET_SITE_URL = security.authenticatedUrl(origin, '/settings/');
  if (!process.env.DSH_PET_SCALE) process.env.DSH_PET_SCALE = '1';

  apply(context.ctx);
  log(`apply() 完成：routes=${routes.length} 失败=${context.failures.length}`);

  // 设置窗口的**进程内**数据入口（helper 的 pet:host-request IPC 优先用它）。
  // 零 HTTP：同一份 handlePetRoute（host/index.ts 在 in-process 时 provide 出来）+
  // 同一份 AI 设置校验，端口与令牌都不参与——这正是"设置不再依赖 localhost"的落点。
  installHostRequestBridge(context, ai, log);

  // helper 读它决定建几个窗口；读不到时它会回落到单个默认窗口，首帧再由渲染端自校正
  process.env.DSH_PET_PETS = JSON.stringify(desktopPets());

  // 同一个进程里跑 helper：建窗、托盘、IPC、碰撞全在它内部完成（CJS，需要 require）
  // 渲染端日志必须转出来：打包后的应用没有控制台，渲染端报错只会表现成「窗口透明」。
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_e, level, message, line, source) => {
      log(`渲染端[${level}] ${message} (${source}:${line})`);
    });
  });
  // Register before helper's whenReady callback creates any file renderer.
  void app.whenReady().then(() => {
    installDesktopAuth(
      session.defaultSession,
      origin,
      join(packageRoot, 'runtime/electron-helper/index.html'),
      security.token,
    );
  });
  process.env.DSH_PET_APP_TOKEN = security.token;
  try {
    createRequire(import.meta.url)(helperMain);
  } finally {
    delete process.env.DSH_PET_APP_TOKEN;
  }

  app.on('second-instance', () => log('已有一个实例在运行，忽略本次启动'));
  app.on('will-quit', () => {
    // 退出前把最后一批日志刷出去（定时器最多 1s，这里显式补一次）
    void logger.flush();
    logger.dispose();
    releaseBalance();
    void ai.dispose();
    void context.dispose().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
}

/** 宿主路由（RouteResult）里设置窗口用得到的字段 */
interface RouteResultLike {
  kind: 'json' | 'text' | 'file' | 'none';
  status: number;
  obj?: unknown;
  body?: string;
}

/** 设置窗口 IPC 的应答形状（与 runtime/electron-helper/main.js 的 settingsRequest 一致） */
interface SettingsResponse {
  status: number;
  body: string;
}

/**
 * 把「设置窗口的请求」直接接到宿主路由上——**不经本机 HTTP 服务**。
 *
 * helper 的 `pet:host-request` IPC 先找 `globalThis.__dshPetHostRequest`（就是这里装的函数），
 * 找到就直接调 `handlePetRoute`（host/index.ts 在 in-process 时 provide 的 `petRoute7340`）；
 * 找不到才回落到既有的 stdout 桥（CLI 双进程）。这样设置窗口不再依赖随机端口、令牌与浏览器。
 *
 * AI 设置（`/standalone-ai/*`）不在插件路由表里：它们原本由 HTTP 层的 settingsHandler 处理，
 * 这里复用同一份 `validateSettings` / `publicSettings`，校验规则不会漂移。
 */
function installHostRequestBridge(context: { ctx: Record<string, unknown> }, ai: StandaloneAiService, log: (message: string) => void): void {
  const get = (context.ctx as { get?: (name: string, required?: boolean) => unknown }).get;
  const petRoute = (typeof get === 'function' ? get.call(context.ctx, 'petRoute7340', false) : undefined) as
    | ((url: string, method: string, body?: string) => Promise<RouteResultLike>)
    | undefined;

  const aiSettings = async (path: string, method: string, body?: string): Promise<SettingsResponse> => {
    if (path === '/standalone-ai/test') {
      const input = body
        ? (JSON.parse(body) as { protocol?: string; baseUrl?: string; model?: string; apiKey?: string })
        : {};
      const result = await ai.testConnection(input);
      return { status: 200, body: JSON.stringify(result) };
    }
    if (method === 'GET') return { status: 200, body: JSON.stringify(publicSettings(ai.getSettings())) };
    if (method !== 'POST') return { status: 405, body: JSON.stringify({ error: '仅支持 GET 或 POST' }) };
    try {
      const input = validateSettings(JSON.parse(body ?? ''));
      return { status: 200, body: JSON.stringify(publicSettings(await ai.saveSettings(input))) };
    } catch {
      // 不转发底层错误：设置校验失败的原因可能带有端点/密钥片段
      return { status: 400, body: JSON.stringify({ error: '设置未保存：请检查接口地址、模型名称、密钥和数值范围' }) };
    }
  };

  const handler = async (payload: { method?: string; path?: string; body?: string } = {}): Promise<SettingsResponse> => {
    const method = String(payload.method ?? 'GET').toUpperCase();
    const path = String(payload.path ?? '/');
    try {
      if (path === '/standalone-ai/settings' || path === '/standalone-ai/test') {
        return await aiSettings(path, method, payload.body);
      }
      if (!petRoute) return { status: 503, body: JSON.stringify({ error: '宿主路由尚未就绪' }) };
      const result = await petRoute(path, method, payload.body);
      if (result.kind === 'json') return { status: result.status, body: JSON.stringify(result.obj) };
      if (result.kind === 'text') return { status: result.status, body: result.body ?? '' };
      if (result.kind === 'none') return { status: 204, body: '' };
      // file：设置窗口不取素材（宠物窗口走 bridge 协议）
      return { status: 200, body: '' };
    } catch (error) {
      log(`设置窗口请求失败：${error instanceof Error ? error.message : String(error)}`);
      return { status: 500, body: JSON.stringify({ error: '本机接口暂时无法处理请求' }) };
    }
  };

  (globalThis as Record<string, unknown>).__dshPetHostRequest = handler;
}

/**
 * 桌面可见宠物清单（[{id,size}]）。
 * 与 `src/host/index.ts` 的 isDesktopVisible 同口径：display 含 desktop/both 才建窗。
 */
function desktopPets(): Array<{ id: string; size: number }> {
  try {
    const pets = flattenPetList(readAllConfig(configPathsFor(packageRoot, dshHomeDir())));
    const desktop = pets
      .filter((pet) => pet.display === 'desktop' || pet.display === 'both')
      .map((pet) => ({ id: String(pet.id), size: Number(pet.size) }));
    log(`桌面宠物 ${JSON.stringify(desktop)}`);
    return desktop;
  } catch (error) {
    log(`读配置失败（回落单窗）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function status(port: number): Record<string, unknown> {
  const paths = configPathsFor(packageRoot, dshHomeDir());
  let pets: Array<Record<string, unknown>> = [];
  try {
    pets = flattenPetList(readAllConfig(paths));
  } catch {
    /* 落地页/状态接口不该因配置坏掉而 500：下面如实显示 0 只 */
  }
  return {
    name: 'dsh-pet-app',
    version: packageVersion(packageRoot),
    pid: process.pid,
    port,
    pluginRoot: packageRoot,
    configFile: paths.userFile,
    pets: pets.map((pet) => ({ id: pet.id, name: pet.name, display: pet.display })),
  };
}

/** 落地页：取代以前的 `not found`。配置项只能改文件，真正的可视化配置在 /standalone-ai/。 */
function landingPage(port: number): string {
  const info = status(port);
  const pets = (info.pets as Array<Record<string, unknown>>) ?? [];
  const petLines = pets.length
    ? pets
        .map((pet) => `<li>${escapeHtml(String(pet.name ?? pet.id))}（${escapeHtml(String(pet.display))}）</li>`)
        .join('')
    : '<li>（未读到宠物，检查配置文件）</li>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-pet</title>
<style>
  body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;margin:0;padding:32px;background:#f6f8fa;color:#1f2328}
  main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px 32px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#656d76;margin-bottom:20px}
  h2{font-size:14px;margin:22px 0 6px} code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:1px 6px;font-size:12px}
  ul{margin:6px 0;padding-left:20px} a{color:#0969da}
</style></head>
<body><main>
  <h1>dsh-pet 桌宠</h1>
  <div class="sub">版本 ${escapeHtml(String(info.version))} · 端口 ${port}</div>
  <h2>宠物</h2><ul>${petLines}</ul>
  <h2>配置文件</h2>
  <p><code>${escapeHtml(String(info.configFile))}</code></p>
  <p>改完配置后<strong>右键桌宠 →「重载配置」</strong>，窗口会按最新配置重建（也可以从托盘退出重开）。</p>
  <h2>设置</h2>
  <p>宠物数量 / 大小 / 位置 / 显示方式 / 开关，以及 AI 模型与余额都在设置页里改。
  页面需要令牌，请<strong>右键桌宠 →「打开网站」</strong>进入（会直接打开已授权的设置页）。</p>
  <h2>状态</h2>
  <p><a href="/health">/health</a> · <a href="/settings/">设置页</a>（未授权时读写会返回 403）</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

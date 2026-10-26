import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestSecurity {
  /** Process capability: private launcher manifest only, never an HTTP response or log. */
  readonly token: string;
  /**
   * 带令牌的本机页面地址。
   * @param baseUrl 本机服务地址（http://127.0.0.1:<port>）
   * @param page 页面路径，默认 `/standalone-ai/`（AI 设置页）；桌宠设置页传 `/settings/`
   */
  authenticatedUrl(baseUrl: string, page?: string): string;
  authorize(req: IncomingMessage, res: ServerResponse, allowFileOrigin?: boolean): boolean;
}

export function rejectRequest(res: ServerResponse, status: number, error: string): false {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
  return false;
}

function publicRead(req: IncomingMessage): boolean {
  // The plugin decodes its route before dispatch; authorization must use the same spelling.
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (['/standalone-ai/settings', '/shutdown'].includes(path)) return false;
  if (/^\/dsh-pet-\d+\/(?:whisper|chat)(?:\/|$)/.test(path)) return false;
  return (
    [
      '/',
      '/health',
      '/standalone-ai/',
      '/standalone-ai/settings.js',
      '/standalone-ai/settings.css',
      // 桌宠设置页（宠物数量/大小/位置/显示位置/开关）：页面本身是静态资源，
      // 读写数据仍要走 /dsh-pet-7340/* 与 /settings/save，那些请求必须带令牌。
      '/settings/',
      '/settings/app.js',
      '/settings/app.css',
    ].includes(path) || /^\/dsh-pet-\d+\//.test(path)
  );
}

/** Origin/Fetch-Metadata are CSRF checks; the custom capability header also excludes HTML forms. */
export function createRequestSecurity(): RequestSecurity {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    authenticatedUrl(baseUrl, page = '/standalone-ai/') {
      const base = new URL(baseUrl);
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname) ||
        base.username ||
        base.password
      ) {
        throw new Error('设置地址必须是本机 HTTP 地址');
      }
      // 只接受站内绝对路径：`//evil.com` 一类协议相对地址会把令牌送到别的源上
      const path = page.startsWith('/') && !page.startsWith('//') ? page : '/standalone-ai/';
      return `${base.origin}${path}#token=${token}`;
    },
    authorize(req, res, allowFileOrigin = false) {
      const host = req.headers.host;
      const port = req.socket.localPort;
      if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        return rejectRequest(res, 403, '仅允许当前本机地址');
      }
      // A file renderer still needs the process capability: sandboxed websites also send "null".
      // Non-CORS media loads from the same file renderer may omit Origin altogether.
      const fileOrigin = allowFileOrigin && (req.headers.origin === 'null' || req.headers.origin === undefined);
      if (
        !fileOrigin &&
        ((req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) ||
          req.headers['sec-fetch-site'] === 'cross-site')
      ) {
        return rejectRequest(res, 403, '不允许跨站请求');
      }
      try {
        if (publicRead(req) && !fileOrigin) return true;
      } catch {
        return rejectRequest(res, 400, '请求地址无效');
      }
      const supplied = req.headers['x-dsh-pet-token'];
      if (
        typeof supplied !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        return rejectRequest(res, 403, '请从桌宠菜单重新打开设置');
      }
      return true;
    },
  };
}

/** Upstream plugin handlers write wildcard CORS; remove it at the actual HTTP boundary. */
export function secureResponse(res: ServerResponse, pathname?: string): void {
  const writeHead = res.writeHead.bind(res);
  const isPublicOp = pathname === '/' || pathname === '/health';
  res.writeHead = ((status: number, ...args: unknown[]) => {
    const filtered = isPublicOp
      ? args
      : args.map((value) => {
          if (Array.isArray(value)) {
            return value.reduce<string[]>((result, item, index) => {
              if (index % 2 === 0 && !String(item).toLowerCase().startsWith('access-control-')) {
                return [...result, String(item), String(value[index + 1])];
              }
              return result;
            }, []);
          }
          if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).filter(([name]) => !name.toLowerCase().startsWith('access-control-')),
            );
          }
          return value;
        });
    if (!isPublicOp) {
      for (const name of res.getHeaderNames()) {
        if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    return Reflect.apply(writeHead, res, [status, ...filtered]);
  }) as typeof res.writeHead;
}

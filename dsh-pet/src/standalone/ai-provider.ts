import { z } from 'zod';
import type { StandaloneLogger } from './context';
import { createAiConfig } from './ai-config';
import type { StandaloneAiPublicSettings } from './ai-config';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream } from './ai-transport';
import type { AiFetch, AiRequest, AiTransportEvent } from './ai-transport';

const PROVIDER = 'standalone';
const MAX_INPUT_CHARS = 32_768;
const MAX_OUTPUT_CHARS = 16_384;
const MAX_EVENTS = 4096;
const REQUESTS_PER_MINUTE = 6;
const RATE_WINDOW_MS = 60_000;
const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});
const inputSchema = z.object({
  provider: z.literal(PROVIDER),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});

export interface StandaloneAiService {
  currentSelection(): { provider: string; model: string };
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  getSettings(): StandaloneAiPublicSettings;
  /**
   * 余额查询要用的**明文**凭证（接口地址 + 密钥）。
   *
   * 只在本进程内使用（独立模式的余额 provider，见 ./balance-provider），绝不经过 HTTP——
   * 设置页读到的永远是 `publicSettings()` 那份脱敏结果。
   * 未启用（未配置齐全 / 已暂停 / 正在保存）时返回 undefined，调用方据此报「未配置」而不是乱发请求。
   */
  balanceCredentials(): { protocol: string; baseUrl: string; apiKey: string } | undefined;
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  /**
   * 连通性测试 —— 顺带把该接口的**模型清单**取回来（设置页用它填下拉框）。
   *
   * `model` 可以留空：这时只拉清单、不发对话请求，用户拿到列表后再选模型。
   * 返回值里的 `models` 拿不到时是空数组（接口没实现 /models、鉴权失败等），
   * 调用方据此提示"手动填写"而不是把连接测试判成失败。
   */
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string; models?: string[] }>;
  isReady(): boolean;
  canWhisper(): boolean;
  dispose(): void;
}
/** Optional third argument is an isolated transport/clock seam; production uses official SDKs. */
export interface StandaloneAiDependencies {
  fetch?: AiFetch;
  now?: () => number;
}

/**
 * 取该接口的模型清单（`GET /models`）——设置页用它把「模型名称」填成下拉框。
 *
 * 地址与鉴权按协议分：
 *   · OpenAI 兼容：`{base}/models` + `Authorization: Bearer <key>`
 *   · Anthropic  ：`{base}/v1/models` + `x-api-key` + `anthropic-version`
 *
 * 失败（接口没实现 / 鉴权失败 / 返回形状不认识）**不抛错**：模型清单只是"顺手拿到"的
 * 附加信息，不能因此把连接测试判成失败。但要把 HTTP 状态码带回去——上层才能区分
 * 「接口不支持 /models」和「接口 503 挂了」，两者的处理建议完全不同。
 */
async function fetchModelIds(
  protocol: string,
  baseUrl: string,
  apiKey: string,
  fetcher: AiFetch,
  signal: AbortSignal,
): Promise<{ ids: string[]; status?: number }> {
  const base = baseUrl.replace(/\/+$/, '');
  const url = protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> =
    protocol === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };
  try {
    const response = await fetcher(url, { method: 'GET', headers, signal });
    if (!response.ok) return { ids: [], status: response.status };
    const payload = (await response.json()) as { data?: unknown; models?: unknown } | null;
    const list = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
    const ids = list
      .map((item) =>
        typeof item === 'string'
          ? item
          : item !== null && typeof item === 'object'
            ? (item as { id?: unknown }).id
            : undefined,
      )
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map((id) => id.trim());
    return { ids: [...new Set(ids)].sort((a, b) => a.localeCompare(b)) };
  } catch {
    return { ids: [] };
  }
}

/** 5xx / 网关类错误：服务方自己出问题，改密钥或换模型都救不了 */
function serverUnavailableMessage(status?: number): string {
  const code = status ? ` (HTTP ${status})` : '';
  return `服务端暂时不可用${code}：接口方没有可用上游或正在维护，请稍后重试或更换接口地址（不是密钥或模型的问题）`;
}

function parseRequest(options: unknown, model: string): { request: AiRequest; signal?: AbortSignal } {
  const parsed = inputSchema.safeParse(options);
  if (!parsed.success || parsed.data.model !== model)
    throw new Error('Invalid standalone AI model selection or input.');
  const { data } = parsed;
  const messages = data.messages
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                // Unknown/non-text blocks and DSH source metadata never cross the API boundary.
                if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text')
                  return '';
                const result = textBlock.safeParse(block);
                if (!result.success) throw new Error('Invalid standalone AI text input.');
                return result.data.text;
              })
              .join(''),
    }))
    .filter((message) => message.content.trim().length > 0);
  const system = data.system ?? '';
  const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    size > MAX_INPUT_CHARS ||
    messages.length === 0 ||
    messages[0].role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Standalone AI input is empty or exceeds limits.');
  }
  return { request: { system, messages }, signal: data.signal };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Standalone AI request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Standalone AI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // Corrupt/insecure persistence must never enable ambient or old credentials.
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({ provider: PROVIDER, model: ready() ? store.current().model : '' });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_MINUTE) throw new Error('Standalone AI rate limit reached. Please wait.');
    requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // Only our fixed messages are safe; never propagate SDK errors, URLs, headers, or bodies.
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() may await a pending transport read. Observe it, but never block cancellation.
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => (ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      ready() && provider === PROVIDER ? [{ id: settingsModel(), name: settingsModel() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    getSettings: () => store.publicSettings(),
    balanceCredentials: () =>
      ready() ? { protocol: store.current().protocol, baseUrl: store.current().baseUrl, apiKey: store.current().apiKey } : undefined,
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) paused = false;
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    async testConnection(input: { protocol?: string; baseUrl?: string; model?: string; apiKey?: string }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
      const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
      // 模型允许留空：先只取模型清单，用户在设置页选好再测对话
      const model = (input.model !== undefined ? input.model : current.model).trim();
      const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();

      if (!baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let models: string[] = [];
      try {
        // 模型清单只要 baseUrl + key，与模型名无关：先取它，顺手也就验证了地址与密钥
        const listed = await fetchModelIds(protocol, baseUrl, apiKey, fetcher, controller.signal);
        models = listed.ids;

        if (!model) {
          if (models.length > 0) {
            return { ok: true, message: `连接成功！已获取 ${models.length} 个可用模型，请在上方选择`, models };
          }
          if (listed.status !== undefined && listed.status >= 500) {
            return { ok: false, message: serverUnavailableMessage(listed.status), models };
          }
          if (listed.status === 401 || listed.status === 403) {
            return { ok: false, message: `身份验证失败 (HTTP ${listed.status})：请检查 API 密钥是否正确`, models };
          }
          return { ok: false, message: '已连接，但该接口没有返回模型列表：请选「自定义…」手动填写模型名称', models };
        }

        const testSettings = {
          protocol: protocol as 'openai-compatible' | 'anthropic',
          baseUrl,
          model,
          apiKey,
          enabled: true,
          automaticWhispers: false,
          whisperIntervalSec: 300,
          maxTokens: 32,
          timeoutMs: 15_000,
        };

        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求', models };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)', models };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim(), models };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        // 5xx：上游/中转自己不可用（如"all accounts are temporarily unavailable"），换个说法指路。
        // 但**很多中转发现在「模型名不认识」时也回 503**（它找不到能提供该模型的上游账号），
        // 所以清单非空时要先怀疑这一点——否则用户会一直以为服务挂了。
        const serverCode = rawMsg.match(/\b(5\d\d)\b/);
        if (serverCode) {
          const mismatch = models.length > 0 && !models.includes(model);
          return {
            ok: false,
            message:
              serverUnavailableMessage(Number(serverCode[1])) +
              (mismatch
                ? `；另外该接口的模型清单里没有「${model}」，请从下拉框里重选一个（点「检查 / 获取模型」刷新列表）`
                : ''),
            models,
          };
        }
        if (rawMsg.includes('404')) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: `连接失败：${rawMsg}` };
      } finally {
        clearTimeout(timer);
      }
    },
    canWhisper: () => ready() && store.current().automaticWhispers,
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}

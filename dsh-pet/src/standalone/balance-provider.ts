/**
 * 独立模式的余额 provider —— 让 `standalone` 这个 provider id 也能查到真余额。
 *
 * 为什么需要它：宿主侧 `refreshBalance` 取 `ctx.agentDefaultModel.currentSelection().provider`
 * 去余额注册表里找服务商。独立模式报的 provider 是 `standalone`（AI 通道的 id），
 * 注册表里当然没有它 → 余额永远是 `unsupported`（这就是 README 里「独立模式查不了余额」的成因）。
 *
 * 解法不去改宿主逻辑：余额注册表本来就支持**运行时注册第三方 provider**
 * （`registerBalanceProvider`，供第三方插件用）。独立模式以同样身份登记 `standalone`，
 * 取数时用本机 AI 配置里的密钥：
 *   - 接口地址是 `api.deepseek.com` → 直连官方 `/user/balance`（复用内置 deepseek-official 的解析，
 *     档位基准与峰谷档位口径完全一致）；
 *   - 其它地址 → 抛错（`fetch-error`，气泡里显示一句人话），**绝不伪造数字**。
 *
 * 密钥只在本进程内读取（`ai.balanceCredentials()`），不进 HTTP、不进日志。
 */
import { registerBalanceProvider } from '../host/balance';
import { deepseekOfficial } from '../host/balance/providers/deepseek-official';
import type { BalanceSuccess, PluginFetchContext } from '../host/balance/types';
import type { StandaloneAiService } from './ai-provider';
import { STANDALONE_PROVIDER } from './context';

/** DeepSeek 官方余额接口所在的主机名（与内置 provider 的固定地址同一口径） */
const DEEPSEEK_HOST = 'api.deepseek.com';

/**
 * 登记独立模式的余额 provider。
 *
 * @param ai 本机 AI 服务（提供明文凭证）
 * @returns 注销函数；已登记过（重复 boot）时返回空操作，不抛错——余额不可用不该拖垮启动。
 */
export function registerStandaloneBalance(ai: StandaloneAiService): () => void {
  try {
    return registerBalanceProvider({
      id: STANDALONE_PROVIDER,
      async fetch({ provider }: PluginFetchContext): Promise<BalanceSuccess> {
        const credential = ai.balanceCredentials();
        if (!credential) {
          throw new Error('未配置 AI 模型：先在本机设置页填写接口地址与密钥，才能查询余额');
        }
        let host = '';
        try {
          host = new URL(credential.baseUrl).hostname.toLowerCase();
        } catch {
          throw new Error('AI 接口地址无效，无法查询余额');
        }
        if (host !== DEEPSEEK_HOST) {
          throw new Error(`余额查询目前只支持 DeepSeek 官方接口（当前接口是 ${host}）`);
        }
        return deepseekOfficial.fetch({ provider, key: credential.apiKey });
      },
    });
  } catch {
    return () => {};
  }
}

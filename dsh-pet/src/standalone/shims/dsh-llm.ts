/**
 * `@deepseek-ai/dsh-llm` 的独立模式替身（消息工厂 / 文本块拼装 / reasoning 标识）。
 *
 * 独立模式没有模型后端。`ctx.llm` 的替身（见 ../context.ts）让**没有显式配置模型**的调用在
 * 候选链阶段就失败：`agentDefaultModel.currentSelection()` 返回的 model 为空 →
 * `model-selection.ts` 的 `currentModel()` 判定为「未配置」→ `generateWhisper` / `generateChat`
 * 直接回 `{ ok: false, reason: 'provider-missing' }`。
 *
 * **但这不是结构性保证。** 用户在配置里显式写了 `whisperModel` / `chatModel`（设置页选过模型
 * 就会写进配置）时，候选链非空，生成侧会真的走到本文件的消息构造与 `ctx.llm.stream`。
 * 所以本文件与 ctx.llm 替身的每一处形状都必须与 DSH 的真实契约一致 —— 0.3.4 的崩溃正是因为
 * `stream` 被当成"永远不走的那条路"，实现成返回 Promise 而契约要求 AsyncIterable
 * （细节见 ../context.ts 里 stream / resolveModelInfo 的注释）。
 *
 * 那为什么还要实现它们：`whisper.ts` / `chat.ts` 是**静态 import** 这四个名字的，
 * 模块图能加载是独立模式起得来的前提；同时保持它们是纯本地、零网络的实现，
 * 将来若有人给独立模式接上模型通道（例如自带 API key），这条路径可以照常工作。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件。
 */

/** 消息的最小形状（只有角色、内容与来源标记；适配器回放不在独立模式范围内） */
export interface StandaloneLlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 用户消息（`whisper.ts` / `chat.ts` 的入参形状） */
export function createUserMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 助手消息（`chat.ts` 回放历史用） */
export function createAssistantMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块（`BlockAssembler.blocks()` 的元素形状） */
export interface StandaloneTextBlock {
  type: 'text';
  text: string;
}

/**
 * 流式文本拼装：收集文本增量，并记录终止块（与 DSH 的 `BlockAssembler` 同一用法的子集）。
 *
 * 形状必须与真实契约一致：适配器吐的是 `{ type: 'text-delta', index, text }` 增量，
 * 结束帧是 `{ type: 'finish', reason: { kind, failure? } }` —— 调用方（whisper/chat）
 * 用 `blocks()` 取正文、用 `finish` 解释「为什么没有正文」（见 src/host/llm-call.ts）。
 * 只认 `type === 'text'` 的旧形状会让真实流一律拼成空文本，表现为「模型未返回文本」。
 */
export class BlockAssembler {
  /** index → 已拼的文本（多块并行时按 index 分开累积） */
  private readonly texts = new Map<number, string>();

  /** 终止块的原因（`{ kind: 'error' | 'aborted' | 'max-tokens' | 'stop', failure? }`） */
  finish: { kind?: string; failure?: unknown } | undefined;

  /** 收集一个块；非文本块（工具调用等）在独立模式下被忽略 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return;
    const c = chunk as { type?: unknown; index?: unknown; text?: unknown; reason?: unknown };
    if (c.type === 'text-delta' && typeof c.text === 'string') {
      const index = typeof c.index === 'number' ? c.index : 0;
      this.texts.set(index, (this.texts.get(index) ?? '') + c.text);
      return;
    }
    // 兼容整块文本（`{ type: 'text', text }`）：自定义/简化适配器的形状
    if (c.type === 'text' && typeof c.text === 'string') {
      this.texts.set(0, (this.texts.get(0) ?? '') + c.text);
      return;
    }
    if (c.type === 'finish' && c.reason !== null && typeof c.reason === 'object') {
      this.finish = c.reason as { kind?: string; failure?: unknown };
    }
  }

  /** 当前已拼装的块列表（按 index 排序，空文本不产出块） */
  blocks(): StandaloneTextBlock[] {
    const out: StandaloneTextBlock[] = [];
    for (const [, text] of [...this.texts.entries()].sort((a, b) => a[0] - b[0])) {
      if (text !== '') out.push({ type: 'text', text });
    }
    return out;
  }
}

/** reasoning effort 标识工厂（DSH 侧是枚举工厂，这里保持"传什么就是什么"） */
export function ReasoningEffortId(id: string): string {
  return id;
}

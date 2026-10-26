/**
 * DSH（DeepSeek Harness）进度监测 —— 独立应用专属。
 *
 * 为什么不是"监听 D:\Application\dsh 目录"：那是 DSH 的**安装目录**（exe + resources），
 * 里面没有任何进度信息。真正的进度在数据目录的会话文件里：
 *
 *     <DSH_HOME>/sessions/<工作区>/<session-id>/session.v4.jsonl.zstd
 *
 * 这个文件是 **append-only 的多帧 zstd**（每个事件压成一帧追加），所以可以只解码"新增的那几帧"，
 * 不用每轮把整个文件重读一遍。事件类型（实测）：
 *   turn/start、step/start、step/end、tool/call、tool/result、assistant/message、
 *   user/message、turn/end（reason.kind = completed / error / aborted）、approval/*、goal/change…
 *
 * 这里只提炼出四种对用户有意义的进度，交给调用方变成桌宠的气泡：
 *   turn-start → 开始处理
 *   turn-end(completed) → 这一轮完成
 *   turn-end(error) → 出错
 *   approval / ask_user_question → 需要你确认或选择
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export type DshWatchEvent =
  | { kind: 'turn-start'; turn: number }
  | { kind: 'turn-end'; turn: number; reason: 'completed' | 'error'; message?: string }
  | { kind: 'ask'; text?: string }
  | { kind: 'approval'; text?: string };

export interface DshWatchOptions {
  /** 会话根目录（<DSH_HOME>/sessions） */
  sessionsRoot: string;
  /** 轮询间隔（毫秒），默认 2500 */
  intervalMs?: number;
  /** 启动后第一次扫描的延迟（毫秒），默认 1200 —— 启动时别和配置加载抢 IO */
  startDelayMs?: number;
  /** 事件回调（只在状态变化时触发，历史事件不会回放） */
  onEvent: (event: DshWatchEvent) => void;
  /** 是否启用（设置里的开关）：关掉时降到低频空转，改了开关不用重启就能恢复 */
  isEnabled?: () => boolean;
  /** 排障日志 */
  log?: (message: string, error?: unknown) => void;
}

/** zstd 帧魔数：0x28 0xB5 0x2F 0xFD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找 sessions 目录里最近被写过的会话文件（按 mtime） */
function latestSessionFile(root: string): { file: string; mtime: number; size: number } | null {
  let best: { file: string; mtime: number; size: number } | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl.zstd')) continue;
      let info: import('node:fs').Stats;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (!best || info.mtimeMs > best.mtime) best = { file: full, mtime: info.mtimeMs, size: info.size };
    }
  }
  return best;
}

/**
 * 把一段字节按 zstd 魔数切成帧。
 * 返回的 `complete` 是"能安全消费到哪"：最后一个成功解压的帧的结尾 ——
 * 文件末尾可能正在写（半帧），下轮再来解。
 */
function decodeFrames(buf: Buffer): { text: string; consumed: number; complete: boolean } {
  const starts: number[] = [];
  let index = buf.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    starts.push(index);
    index = buf.indexOf(ZSTD_MAGIC, index + 4);
  }
  let text = '';
  let consumed = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8');
      consumed = end;
    } catch {
      // 尾部半帧（还在写）：可以消费到上一帧为止
      return { text, consumed, complete: false };
    }
  }
  return { text, consumed, complete: true };
}

/** 事件 JSON → 对用户有意义的进度（其余一律返回 null） */
function toEvent(raw: unknown): DshWatchEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: unknown; data?: unknown };
  const type = typeof obj.type === 'string' ? obj.type : '';
  const data = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>;
  const turn = Number(data.turn) || 0;

  if (type === 'turn/start') return { kind: 'turn-start', turn };
  if (type === 'turn/end') {
    const reason = (data.reason && typeof data.reason === 'object' ? data.reason : {}) as Record<string, unknown>;
    const kind = String(reason.kind ?? '');
    // aborted / interrupted 不打扰用户（用户自己停的）
    if (kind !== 'completed' && kind !== 'error') return null;
    const message = typeof reason.message === 'string' ? reason.message : undefined;
    return { kind: 'turn-end', turn, reason: kind, message };
  }
  if (type === 'approval/asked') {
    const text = typeof data.title === 'string' ? data.title : typeof data.message === 'string' ? data.message : undefined;
    return { kind: 'approval', text };
  }
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : '';
    if (name === 'ask_user_question') {
      const text = typeof data.question === 'string' ? data.question : undefined;
      return { kind: 'ask', text };
    }
  }
  return null;
}

/**
 * 启动监测，返回停止函数。
 *
 * 首次连上某个会话文件时**只对齐位置、不回放历史**：把 offset 指到文件末尾、lastSeq 记为当前最大 seq，
 * 之后只有新追加的事件才会触发回调 —— 否则一启动就会把几天前的对话全"播"一遍。
 */
export function startDshWatch(options: DshWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? 2500;
  let currentFile = '';
  let offset = 0;
  let lastSeq = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const log = (message: string, error?: unknown): void => {
    options.log?.(message + (error ? '：' + (error instanceof Error ? error.message : String(error)) : ''));
  };

  /** 解析一段 JSONL 文本，取 seq > lastSeq 的事件（seq 缺失就用自增序号兜底） */
  const consume = (text: string, fallbackSeq: number): number => {
    let seq = fallbackSeq;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 半行（正在写）
      }
      const obj = parsed as { seq?: unknown };
      const lineSeq = Number(obj.seq);
      const effective = Number.isFinite(lineSeq) ? lineSeq : seq + 1;
      seq = Math.max(seq, effective);
      if (effective <= lastSeq) continue;
      lastSeq = effective;
      const event = toEvent(parsed);
      if (event) {
        try {
          options.onEvent(event);
        } catch (error) {
          log('DSH 进度事件处理失败', error);
        }
      }
    }
    return seq;
  };

  const tick = (): void => {
    if (disposed) return;
    // 设置里关掉就低频空转（不扫盘、不解析），重新打开后下一个周期自动恢复
    if (options.isEnabled && !options.isEnabled()) {
      timer = setTimeout(tick, intervalMs * 4);
      return;
    }
    try {
      const latest = latestSessionFile(options.sessionsRoot);
      if (latest) {
        if (latest.file !== currentFile) {
          // 换会话（或首次启动）：只对齐，不回放
          currentFile = latest.file;
          const text = decodeAll(latest.file);
          lastSeq = maxSeq(text);
          offset = latest.size;
          log('DSH 监测对齐：' + latest.file.split(/[\\/]/).slice(-2).join('/') + '，已有事件到 seq ' + lastSeq);
        } else if (latest.size > offset) {
          const buf = readFileSync(latest.file);
          const slice = buf.subarray(offset);
          const { text, consumed } = decodeFrames(slice);
          if (consumed > 0) {
            consume(text, lastSeq);
            offset += consumed;
          }
        }
      }
    } catch (error) {
      log('DSH 进度轮询失败', error);
    }
    if (!disposed) timer = setTimeout(tick, intervalMs);
  };

  /** 整文件解码（只用于首次对齐；读取失败按空处理） */
  function decodeAll(file: string): string {
    try {
      const buf = readFileSync(file);
      return decodeFrames(buf).text;
    } catch {
      return '';
    }
  }

  /** 文本里最大的 seq（对齐基线） */
  function maxSeq(text: string): number {
    let max = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { seq?: unknown };
        const seq = Number(obj.seq);
        if (Number.isFinite(seq) && seq > max) max = seq;
      } catch {
        /* 忽略 */
      }
    }
    return max;
  }

  timer = setTimeout(tick, options.startDelayMs ?? 1200);
  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

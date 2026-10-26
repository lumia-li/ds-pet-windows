/**
 * DSH 进度监测的单测：会话文件是**多帧 zstd**（每个事件一帧追加），
 * 这里验证「首次只对齐不回放」与「增量只播新事件」两条关键语义。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startDshWatch, type DshWatchEvent } from './dsh-watch.ts';

/** 一条事件压成一帧（与 DSH 的写盘方式一致） */
function frame(event: Record<string, unknown>): Buffer {
  return zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8'));
}

function makeSession(dir: string, name: string, events: Record<string, unknown>[]): string {
  const file = join(dir, name, 'session.v4.jsonl.zstd');
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(file, Buffer.concat(events.map(frame)));
  return file;
}

/** 等一拍（监测器默认 2.5s 一轮，测试里压到 20ms） */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('startDshWatch', () => {
  test('首次只对齐：历史事件不回放；新追加的事件才触发', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'));
    const events: DshWatchEvent[] = [];
    const sessionDir = join(root, 'ws');
    mkdirSync(sessionDir, { recursive: true });

    const file = join(sessionDir, 'session.v4.jsonl.zstd');
    // 历史：两个 turn 已经结束（不该被"播"出来）
    writeFileSync(
      file,
      Buffer.concat([
        frame({ type: 'turn/start', seq: 1, data: { turn: 1 } }),
        frame({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      ]),
    );

    const stop = startDshWatch({
      sessionsRoot: root,
      intervalMs: 20,
      startDelayMs: 0,
      onEvent: (event) => events.push(event),
    });

    await wait(80);
    assert.equal(events.length, 0, '启动时的历史事件不应回放');

    // 追加一轮新的：开始 → 完成
    appendFileSync(file, frame({ type: 'turn/start', seq: 3, data: { turn: 2 } }));
    appendFileSync(file, frame({ type: 'tool/call', seq: 4, data: { turn: 2, name: 'read_file' } }));
    appendFileSync(file, frame({ type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } }));

    await wait(120);
    stop();
    assert.deepEqual(
      events.map((event) => event.kind),
      ['turn-start', 'turn-end'],
      '只该播"开始"和"结束"两条（tool/call 中间步骤不打扰）',
    );
    assert.equal(events[1]?.kind === 'turn-end' ? events[1].reason : '', 'completed');
    rmSync(root, { recursive: true, force: true });
  });

  test('出错与提问也能识别', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'));
    const events: DshWatchEvent[] = [];
    const dir = join(root, 'ws');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, frame({ type: 'turn/start', seq: 1, data: { turn: 1 } }));

    const stop = startDshWatch({
      sessionsRoot: root,
      intervalMs: 20,
      startDelayMs: 0,
      onEvent: (event) => events.push(event),
    });
    await wait(80);
    events.length = 0;

    appendFileSync(file, frame({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', message: '模型超时' } } }));
    appendFileSync(file, frame({ type: 'tool/call', seq: 3, data: { name: 'ask_user_question', question: '选哪个？' } }));
    appendFileSync(file, frame({ type: 'approval/asked', seq: 4, data: { title: '允许执行命令吗' } }));

    await wait(120);
    stop();
    assert.deepEqual(
      events.map((event) => event.kind),
      ['turn-end', 'ask', 'approval'],
    );
    const failed = events[0];
    assert.equal(failed?.kind === 'turn-end' ? failed.reason : '', 'error');
    assert.match(failed?.kind === 'turn-end' ? String(failed.message) : '', /模型超时/);
    rmSync(root, { recursive: true, force: true });
  });

  test('isEnabled 为假时不扫盘（关掉开关就安静）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'));
    const events: DshWatchEvent[] = [];
    const dir = join(root, 'ws');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, frame({ type: 'turn/start', seq: 1, data: { turn: 1 } }));

    const stop = startDshWatch({
      sessionsRoot: root,
      intervalMs: 20,
      startDelayMs: 0,
      isEnabled: () => false,
      onEvent: (event) => events.push(event),
    });
    appendFileSync(file, frame({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }));
    await wait(120);
    stop();
    assert.equal(events.length, 0);
    rmSync(root, { recursive: true, force: true });
  });
});

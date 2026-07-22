import { describe, expect, test, vi } from 'vitest';

import {
  ClaudeEngine,
  MessageStream,
  type ClaudeEngineOptions,
} from '../container/agent-runner/src/engines/claude-engine.js';
import type {
  EngineSendResult,
  EngineConfig,
} from '../container/agent-runner/src/engines/types.js';

describe('Claude MessageStream consumption acknowledgement', () => {
  test('does not acknowledge on push and acknowledges only when SDK pulls', async () => {
    const stream = new MessageStream();
    const onConsumed = vi.fn();

    expect(stream.push('follow-up', undefined, onConsumed)).toEqual([]);
    expect(onConsumed).not.toHaveBeenCalled();

    const iterator = stream[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    expect(next.value.message.content).toBe('follow-up');
    expect(onConsumed).toHaveBeenCalledTimes(1);

    stream.end();
    await iterator.return?.(undefined);
  });

  test('rejected pushes never acknowledge', () => {
    const stream = new MessageStream();
    const onConsumed = vi.fn();
    stream.end();

    expect(stream.push('late', undefined, onConsumed)).toHaveLength(1);
    expect(onConsumed).not.toHaveBeenCalled();
  });
});

describe('ClaudeEngine Workflow lifecycle', () => {
  test('keeps the SDK iterator alive, reports both turns, and bills usage deltas', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: '后台调研',
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: '调研任务已启动。' },
            { type: 'tool_use', id: 'tool-1', name: 'Task', input: {} },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '调研任务已启动。',
        usage: { input_tokens: 100, output_tokens: 20 },
        modelUsage: {
          max: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 1,
          },
        },
        total_cost_usd: 1,
        duration_ms: 1_000,
        num_turns: 1,
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        status: 'completed',
        summary: '调研完成',
      },
      {
        type: 'assistant',
        uuid: 'assistant-2',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: '最终汇总。' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '最终汇总。',
        usage: { input_tokens: 160, output_tokens: 35 },
        modelUsage: {
          max: {
            inputTokens: 160,
            outputTokens: 35,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 1.6,
          },
        },
        total_cost_usd: 1.6,
        duration_ms: 2_000,
        num_turns: 2,
      },
    ];

    const config: EngineConfig = {
      model: 'max',
      baseUrl: 'http://127.0.0.1:3011',
      apiKey: 'local-sentinel',
      cwd: process.cwd(),
      extra: { pathToClaudeCodeExecutable: '/bin/true' },
    };
    const fakeQuery = {
      interrupt: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
    const queryFn = (() => fakeQuery) as unknown as NonNullable<
      ClaudeEngineOptions['queryFn']
    >;
    const createMcpServerFn = (() => ({
      type: 'sdk',
      name: 'happyclaw',
    })) as unknown as NonNullable<ClaudeEngineOptions['createMcpServerFn']>;
    const engine = new ClaudeEngine({
      logFn: vi.fn(),
      queryFn,
      createMcpServerFn,
    });
    const session = await engine.createSession(config);
    const reported: EngineSendResult[] = [];
    const yielded = [] as Array<{ eventType: string; usage?: unknown }>;
    const generator = engine.sendMessage(
      session,
      [{ role: 'user', content: '开始调研' }],
      [],
      [],
      undefined,
      {
        onResult: async (result) => {
          reported.push(result);
        },
      },
    );

    let returned: EngineSendResult | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        returned = next.value;
        break;
      }
      yielded.push(next.value as { eventType: string; usage?: unknown });
    }

    expect(reported.map((result) => result.finalText)).toEqual([
      '调研任务已启动。',
      '最终汇总。',
    ]);
    expect(reported.map((result) => result.pendingBgTasks)).toEqual([1, 0]);
    expect(returned).toMatchObject({ reported: true, finalText: '' });

    const usageEvents = yielded.filter((event) => event.eventType === 'usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0].usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUSD: 1,
      numTurns: 1,
    });
    expect(usageEvents[1].usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 15,
      numTurns: 1,
    });
    expect((usageEvents[1].usage as { costUSD: number }).costUSD).toBeCloseTo(
      0.6,
    );
  });

  test('suppresses a stale wait result and waits for the corrected final summary', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'system', subtype: 'init', session_id: 'session-guard' },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-guard',
        tool_use_id: 'tool-guard',
        description: '后台分析',
      },
      {
        type: 'assistant',
        uuid: 'assistant-start',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '后台分析已启动。' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '后台分析已启动。',
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 1,
        duration_ms: 1_000,
        num_turns: 1,
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-guard',
        tool_use_id: 'tool-guard',
        status: 'completed',
        summary: '分析完成',
      },
      {
        type: 'assistant',
        uuid: 'assistant-stale',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: '1/2 完成，等待其余 1 个 Agent。' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '1/2 完成，等待其余 1 个 Agent。',
        usage: { input_tokens: 150, output_tokens: 30 },
        total_cost_usd: 1.5,
        duration_ms: 1_500,
        num_turns: 2,
      },
      {
        type: 'assistant',
        uuid: 'assistant-final',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '这里是最终完整汇总。' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '这里是最终完整汇总。',
        usage: { input_tokens: 170, output_tokens: 40 },
        total_cost_usd: 1.7,
        duration_ms: 1_700,
        num_turns: 3,
      },
    ];
    const fakeQuery = {
      interrupt: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
    const engine = new ClaudeEngine({
      logFn: vi.fn(),
      queryFn: (() => fakeQuery) as unknown as NonNullable<
        ClaudeEngineOptions['queryFn']
      >,
      createMcpServerFn: (() => ({
        type: 'sdk',
        name: 'happyclaw',
      })) as unknown as NonNullable<ClaudeEngineOptions['createMcpServerFn']>,
    });
    const session = await engine.createSession({
      model: 'max',
      baseUrl: 'http://127.0.0.1:3011',
      apiKey: 'local-sentinel',
      cwd: process.cwd(),
      extra: { pathToClaudeCodeExecutable: '/bin/true' },
    });
    const reported: EngineSendResult[] = [];
    const yielded: Array<{ eventType: string; statusText?: string }> = [];
    const generator = engine.sendMessage(
      session,
      [{ role: 'user', content: '开始分析' }],
      [],
      [],
      undefined,
      { onResult: async (result) => void reported.push(result) },
    );

    while (true) {
      const next = await generator.next();
      if (next.done) break;
      yielded.push(next.value as { eventType: string; statusText?: string });
    }

    expect(reported.map((result) => result.finalText)).toEqual([
      '后台分析已启动。',
      '这里是最终完整汇总。',
    ]);
    expect(
      yielded.some(
        (event) =>
          event.eventType === 'status' &&
          event.statusText === '后台任务已全部完成，正在自动汇总最终结果',
      ),
    ).toBe(true);
  });
});

/**
 * ClaudeEngine — Anthropic Claude Agent SDK 的 AgentEngine 实现。
 *
 * 封装 @anthropic-ai/claude-agent-sdk 的 query() 调用，
 * 将 SDK 事件转换为统一 StreamEvent。
 *
 * 设计要点：
 * - sendMessage() 返回 AsyncGenerator，中间事件 yield、最终结果 return
 * - 内部维护 StreamEventProcessor + 事件队列，drain 后 yield
 * - 暴露 pushUserMessage() / interruptQuery() 供外部 IPC 循环调用
 * - 注册的工具/Agent 与每次调用传入的合并
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  query,
  createSdkMcpServer,
  type HookCallback,
  type PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentEngine,
  EngineConfig,
  EngineSession,
  EngineMessage,
  EngineToolDefinition,
  EngineToolResult,
  EngineAgentDefinition,
  ContextUsage,
  EngineSendResult,
  EngineHooks,
  EngineType,
} from './types.js';
import type { StreamEvent } from '../stream-event.types.js';
import type { ContainerOutput } from '../types.js';
import { StreamEventProcessor } from '../stream-processor.js';
import { PREDEFINED_AGENTS } from '../agent-definitions.js';
import {
  AssistantTextTracker,
  buildBackgroundTaskSummaryPrompt,
  shouldForceBackgroundTaskSummary,
} from '../utils.js';

// ── SDK User Message 类型 ──

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | {
              type: 'image';
              source: {
                type: 'base64';
                media_type: ImageMediaType;
                data: string;
              };
            }
        >;
  };
  parent_tool_use_id: null;
  session_id: string;
}

// ── MessageStream: push-based async iterable ──
// 从 index.ts 提取，供 SDK query() 消费用户消息流。

export class MessageStream {
  private queue: Array<{
    message: SDKUserMessage;
    onConsumed?: () => void;
  }> = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    onConsumed?: () => void,
  ): string[] {
    if (this.done) {
      return [
        'Stream already ended, message will be processed in the next query',
      ];
    }

    let content: SDKUserMessage['message']['content'];
    if (images && images.length > 0) {
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType as ImageMediaType,
            data: img.data,
          },
        })),
      ];
    } else {
      content = text;
    }

    this.queue.push({
      message: {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      },
      onConsumed,
    });
    this.waiting?.();
    return [];
  }

  get ended(): boolean {
    return this.done;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        // AsyncIterator.next() has now been requested by the SDK. Notify the
        // runner before yielding the message; the runner reports consumption
        // and the host then retires the durable inflight claim.
        queued.onConsumed?.();
        yield queued.message;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── 活动查询句柄 ──

interface ActiveQuery {
  handle: { interrupt(): Promise<void>; getContextUsage?: () => Promise<any> };
  messageStream: MessageStream;
  /** SDK transport 是否已就绪（收到 system/init 后为 true） */
  transportReady: boolean;
  /** StreamEventProcessor 引用，供 PreCompact hook 读取/重置文本缓冲 */
  processor: StreamEventProcessor;
}

// ── ClaudeEngine ──

export interface ClaudeEngineOptions {
  /** 日志函数 */
  logFn?: (msg: string) => void;
  /** Test/embedding seam; production uses the SDK exports above. */
  queryFn?: typeof query;
  createMcpServerFn?: typeof createSdkMcpServer;
}

export class ClaudeEngine implements AgentEngine {
  readonly engineType: EngineType = 'anthropic';

  private readonly logFn: (msg: string) => void;
  private readonly queryFn: typeof query;
  private readonly createMcpServerFn: typeof createSdkMcpServer;
  private registeredTools: EngineToolDefinition[] = [];
  private registeredAgents: EngineAgentDefinition[] = [];

  /** 活动查询映射：sessionId → ActiveQuery */
  private activeQueries = new Map<string, ActiveQuery>();

  constructor(options: ClaudeEngineOptions = {}) {
    this.logFn =
      options.logFn ?? ((msg) => console.error(`[agent-runner] ${msg}`));
    this.queryFn = options.queryFn ?? query;
    this.createMcpServerFn = options.createMcpServerFn ?? createSdkMcpServer;
  }

  // ── AgentEngine 接口实现 ──

  async createSession(
    config: EngineConfig,
    resumeSessionId?: string,
  ): Promise<EngineSession> {
    return {
      id: resumeSessionId || '',
      engineType: 'anthropic',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      engineState: {
        _config: config,
      },
    };
  }

  async *sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    agents: EngineAgentDefinition[],
    signal?: AbortSignal,
    hooks?: EngineHooks,
  ): AsyncGenerator<StreamEvent, EngineSendResult, unknown> {
    if (messages.length === 0) {
      return { finalText: '', newSessionId: session.id, finishReason: 'stop' };
    }

    const config = (session.engineState._config as
      | EngineConfig
      | undefined) ?? {
      model: process.env.ANTHROPIC_MODEL?.trim() ?? '',
      baseUrl: '',
      apiKey: '',
      cwd: process.cwd(),
    };
    const extra = config.extra ?? {};

    // ── 1. 构建 MessageStream 并推入消息 ──
    const stream = new MessageStream();
    for (const msg of messages) {
      stream.push(msg.content, msg.images);
    }

    // ── 2. 构建 MCP Server（合并注册的 + 传入的工具）──
    const allTools = [...this.registeredTools, ...tools];
    const sdkTools = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      handler: async (input: Record<string, unknown>) => {
        const result: EngineToolResult = await t.handler(input);
        return {
          content: [{ type: 'text', text: result.content }],
          isError: result.isError ?? false,
        };
      },
    }));
    const mcpServerConfig = this.createMcpServerFn({
      name: 'happyclaw',
      version: '1.0.0',
      tools: sdkTools as any,
    });

    // ── 3. 构建 Agent 定义（SDK 预定义 + 注册的 + 传入的）──
    const allAgentsRecord: Record<string, any> = { ...PREDEFINED_AGENTS };
    for (const a of [...this.registeredAgents, ...agents]) {
      allAgentsRecord[a.id] = {
        description: a.description,
        prompt: a.instructions,
        tools: a.tools,
        model: a.model || 'inherit',
        maxTurns: a.maxTurns ?? 15,
      };
    }

    // ── 4. 解析 claude CLI 路径 ──
    let pathToClaudeCodeExecutable: string | undefined =
      extra.pathToClaudeCodeExecutable as string | undefined;
    if (!pathToClaudeCodeExecutable) {
      try {
        const resolved = execFileSync('which', ['claude'], {
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        if (resolved) pathToClaudeCodeExecutable = resolved;
      } catch {
        const commonPaths = [
          '/usr/local/bin/claude',
          '/usr/bin/claude',
          path.join(process.env.HOME || '/root', '.local/bin/claude'),
          '/app/node_modules/.bin/claude',
        ];
        for (const p of commonPaths) {
          if (fs.existsSync(p)) {
            pathToClaudeCodeExecutable = p;
            break;
          }
        }
      }
    }

    // ── 5. settings flags ──
    const flagSettings: Record<string, unknown> = {};
    const autoCompactWindow = extra.autoCompactWindow as number | undefined;
    if (autoCompactWindow && autoCompactWindow > 0) {
      flagSettings.autoCompactWindow = autoCompactWindow;
    }

    // ── 6. 构建 PreCompact hook ──
    // 优先级：extra.preCompactHook（真实 SDK HookCallback）> hooks.preCompact（简单回调通知）
    const externalPreCompact = extra.preCompactHook as HookCallback | undefined;
    const hooksConfig =
      externalPreCompact || hooks?.preCompact
        ? ({
            PreCompact: [
              {
                hooks: [
                  (async (
                    input: PreCompactHookInput,
                    toolUseId: any,
                    context: any,
                  ) => {
                    // 先调用真实的 SDK PreCompact hook（处理归档、trim、flag 设置）
                    if (externalPreCompact) {
                      return await externalPreCompact(
                        input,
                        toolUseId,
                        context,
                      );
                    }
                    // 否则调用简单回调通知
                    if (hooks?.preCompact) {
                      await hooks.preCompact({
                        sessionId: session.id,
                        agentId: (input as any).agent_id,
                        transcriptPath: (input as any).transcript_path,
                      });
                    }
                    return {};
                  }) as HookCallback,
                ],
              },
            ],
          } as any)
        : undefined;

    // ── 7. 构建 query options ──
    const userMcpServers =
      (extra.userMcpServers as Record<string, unknown>) ?? {};
    const allowedTools = (extra.allowedTools as string[]) ?? [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'NotebookEdit',
      'mcp__happyclaw__*',
    ];
    const disallowedTools = extra.disallowedTools as string[] | undefined;
    const resumeAt = extra.resumeAt as string | undefined;
    const settingSources = (extra.settingSources as string[]) ?? [
      'project',
      'user',
    ];
    const plugins = extra.plugins as
      | Array<{ type: 'local'; path: string }>
      | undefined;

    const q = this.queryFn({
      prompt: stream,
      options: {
        ...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
        ...(config.model ? { model: config.model } : {}),
        cwd: config.cwd,
        resume: session.id || undefined,
        ...(session.id && resumeAt ? { resumeSessionAt: resumeAt } : {}),
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: config.systemPromptAppend || '',
        },
        allowedTools,
        ...(disallowedTools && disallowedTools.length > 0
          ? { disallowedTools }
          : {}),
        thinking: config.thinking
          ? {
              type: config.thinking.type,
              display: config.thinking.display ?? 'summarized',
            }
          : { type: 'adaptive' as const, display: 'summarized' as const },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        agentProgressSummaries: true,
        settingSources,
        skills: 'all',
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(Object.keys(flagSettings).length > 0
          ? { settings: flagSettings as any }
          : {}),
        ...(plugins && { plugins }),
        additionalDirectories: config.additionalDirectories,
        mcpServers: {
          ...userMcpServers,
          happyclaw: mcpServerConfig,
        },
        ...(hooksConfig && { hooks: hooksConfig }),
        agents: allAgentsRecord as any,
      },
    });

    // ── 8. 事件队列 + StreamEventProcessor ──
    const eventQueue: StreamEvent[] = [];

    const processor = new StreamEventProcessor((output: ContainerOutput) => {
      if (output.streamEvent) {
        eventQueue.push({
          ...output.streamEvent,
          turnId: output.turnId ?? output.streamEvent.turnId,
          sessionId: output.sessionId ?? output.streamEvent.sessionId,
        });
      }
    }, this.logFn);

    // ── 9. 存储活动查询句柄 ──
    const sessionKey = session.id || `__pending_${Date.now()}`;
    this.activeQueries.set(sessionKey, {
      handle: q as any,
      messageStream: stream,
      transportReady: false,
      processor,
    });

    // ── 10. 处理中止信号 ──
    let abortRequested = false;
    if (signal) {
      signal.addEventListener('abort', () => {
        abortRequested = true;
        q.interrupt().catch(() => {});
        stream.end();
      });
    }

    // ── 11. 状态追踪 ──
    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let canonicalAssistantText: string | undefined;
    let canonicalAssistantUuid: string | undefined;
    const assistantTextTracker = new AssistantTextTracker();
    let reportedAnyResult = false;
    let sawPendingBackgroundTasks = false;
    let backgroundSummaryForceAttempts = 0;
    const maxBackgroundSummaryForceAttempts = 2;
    const lastReportedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 0,
      numTurns: 0,
    };
    const lastReportedModelUsage = new Map<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
      }
    >();
    let resultCount = 0;
    let messageCount = 0;
    let sessionResumeFailed = false;
    let contextOverflow = false;
    let unrecoverableTranscriptError = false;

    // ── 12. 消费 SDK 事件流 ──
    try {
      for await (const message of q) {
        if (abortRequested && signal?.aborted) break;

        // ── stream_event ──
        if (message.type === 'stream_event') {
          processor.processStreamEvent(message as any);
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── tool_progress ──
        if (message.type === 'tool_progress') {
          processor.processToolProgress(message as any);
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── tool_use_summary ──
        if (message.type === 'tool_use_summary') {
          processor.processToolUseSummary(message as any);
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── rate_limit_event ──
        if (message.type === 'rate_limit_event') {
          const info = (message as any).rate_limit_info;
          if (info?.status === 'rejected') {
            const resetsAt = info.resetsAt
              ? new Date(info.resetsAt * 1000).toLocaleTimeString()
              : '未知';
            yield {
              eventType: 'status',
              agentScope: 'system',
              statusText: `API 限流中，预计 ${resetsAt} 恢复`,
              displayLevel: 'primary',
            };
          } else if (info?.status === 'allowed_warning') {
            yield {
              eventType: 'status',
              agentScope: 'system',
              statusText: '接近 API 限流阈值',
              displayLevel: 'detail',
            };
          }
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── prompt_suggestion ──
        if (message.type === 'prompt_suggestion') {
          yield {
            eventType: 'prompt_suggestion',
            agentScope: 'system',
            ...(message as any),
          };
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── system ──
        if (message.type === 'system') {
          const sys = message as any;

          if (sys.subtype === 'init') {
            newSessionId = sys.session_id;
            session.id = sys.session_id;
            session.lastActivityAt = Date.now();
            session.engineState.transcriptPath = sys.transcript_path;

            // 更新活动查询映射（用真实 sessionId 替换 pending key）
            if (sessionKey !== sys.session_id) {
              const active = this.activeQueries.get(sessionKey);
              if (active) {
                active.transportReady = true;
                this.activeQueries.set(sys.session_id, active);
                this.activeQueries.delete(sessionKey);
              }
            } else {
              const active = this.activeQueries.get(sessionKey);
              if (active) active.transportReady = true;
            }

            yield {
              eventType: 'init',
              agentScope: 'system',
              sessionId: sys.session_id,
              displayLevel: 'debug',
            };
          }

          if (processor.processSystemMessage(sys)) {
            yield* this.drainQueue(eventQueue);
            continue;
          }
        }

        // ── misc 消息 ──
        if (processor.processMiscMessage(message as any)) {
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // ── assistant / user / result ──
        messageCount++;

        // Sub-Agent 消息
        if (processor.processSubAgentMessage(message as any)) {
          yield* this.drainQueue(eventQueue);
          continue;
        }

        // Main tool results
        if (message.type === 'user') {
          processor.processMainToolResults(message as any);
        }

        // Assistant 消息
        if (message.type === 'assistant' && 'uuid' in message) {
          lastAssistantUuid = (message as { uuid: string }).uuid;
          const assistantMsg = message as Record<string, unknown>;
          if ((assistantMsg.parent_tool_use_id ?? null) === null) {
            const msgContent = (
              assistantMsg.message as Record<string, unknown> | undefined
            )?.content;
            if (
              Array.isArray(msgContent) &&
              assistantTextTracker.addContentBlocks(
                msgContent as Array<{ type: string; text?: string }>,
              )
            ) {
              canonicalAssistantText =
                assistantTextTracker.pickFinalText(null) ?? undefined;
              canonicalAssistantUuid = assistantMsg.uuid as string;
            }
          }
          processor.processAssistantMessage(message as any);
        }

        // ── result ──
        if (message.type === 'result') {
          resultCount++;
          const resultMsg = message as any;
          const textResult =
            'result' in resultMsg ? (resultMsg.result as string | null) : null;
          const resultSubtype = (message as any).subtype as string | undefined;

          // 错误 subtype 检测
          if (
            typeof resultSubtype === 'string' &&
            (resultSubtype === 'error_during_execution' ||
              resultSubtype.startsWith('error'))
          ) {
            if (!newSessionId) {
              sessionResumeFailed = true;
            }
            session.engineState.sessionResumeFailed = sessionResumeFailed;
            session.engineState.lastAssistantUuid =
              canonicalAssistantUuid || lastAssistantUuid;
            session.engineState.contextOverflow = false;
            session.engineState.unrecoverableTranscriptError = false;

            processor.cleanup();
            yield* this.drainQueue(eventQueue);

            return {
              finalText: canonicalAssistantText || textResult || '',
              newSessionId: newSessionId || session.id,
              finishReason: 'error',
            };
          }

          // 上下文溢出检测
          if (textResult && this.isContextOverflowError(textResult)) {
            contextOverflow = true;
            session.engineState.contextOverflow = true;
            session.engineState.lastAssistantUuid =
              canonicalAssistantUuid || lastAssistantUuid;

            processor.cleanup();
            yield* this.drainQueue(eventQueue);

            return {
              finalText: canonicalAssistantText || textResult,
              newSessionId: newSessionId || session.id,
              finishReason: 'error',
            };
          }

          // 不可恢复转录错误检测
          if (textResult && this.isUnrecoverableTranscriptError(textResult)) {
            unrecoverableTranscriptError = true;
            session.engineState.unrecoverableTranscriptError = true;
            session.engineState.lastAssistantUuid =
              canonicalAssistantUuid || lastAssistantUuid;

            processor.cleanup();
            yield* this.drainQueue(eventQueue);

            return {
              finalText: '',
              newSessionId: newSessionId || session.id,
              finishReason: 'error',
            };
          }

          // 正常 result
          const { effectiveResult } = processor.processResult(textResult);
          const finalText =
            assistantTextTracker.pickFinalText(effectiveResult) || '';
          canonicalAssistantText = finalText || undefined;
          const pendingBgTasks = processor.getPendingSdkTaskCount();
          if (pendingBgTasks > 0) sawPendingBackgroundTasks = true;

          if (
            shouldForceBackgroundTaskSummary({
              emitOutput: !!hooks?.onResult,
              sawPendingBackgroundTasks,
              pendingBgTasks,
              finalText,
              attempts: backgroundSummaryForceAttempts,
              maxAttempts: maxBackgroundSummaryForceAttempts,
            })
          ) {
            backgroundSummaryForceAttempts++;
            this.logFn(
              `Result #${resultCount} still looked like a background-task wait reply after all tasks settled; forcing final summary (${backgroundSummaryForceAttempts}/${maxBackgroundSummaryForceAttempts})`,
            );
            yield {
              eventType: 'status',
              agentScope: 'system',
              statusText: '后台任务已全部完成，正在自动汇总最终结果',
              summary: '后台任务已全部完成，正在自动汇总最终结果',
              displayLevel: 'primary',
            };
            assistantTextTracker.reset();
            canonicalAssistantText = undefined;
            canonicalAssistantUuid = undefined;
            const rejected = stream.push(buildBackgroundTaskSummaryPrompt());
            if (rejected.length === 0) continue;
            this.logFn(
              `Forced background summary prompt was rejected: ${rejected.join('; ')}`,
            );
          }

          // SDK 的 usage/modelUsage 是会话累计值。一个 Workflow 会在同一
          // query 中产生多条 result，必须按上一条累计值做 delta，否则每个
          // 中间结果都会把历史 token 再记一次。
          const sdkUsage = resultMsg.usage as
            | Record<string, number>
            | undefined;
          let usageEvent: StreamEvent | null = null;
          let usageDelta:
            | {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
              }
            | undefined;
          if (sdkUsage) {
            const delta = (current: number | undefined, previous: number) =>
              Math.max(0, (current || 0) - previous);
            const sdkModelUsage = resultMsg.modelUsage as
              | Record<string, Record<string, number>>
              | undefined;
            const modelUsageSummary: Record<
              string,
              {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
                costUSD: number;
              }
            > = {};

            if (sdkModelUsage && Object.keys(sdkModelUsage).length > 0) {
              for (const [model, mu] of Object.entries(sdkModelUsage)) {
                const previous = lastReportedModelUsage.get(model);
                modelUsageSummary[model] = {
                  inputTokens: delta(
                    mu.inputTokens,
                    previous?.inputTokens || 0,
                  ),
                  outputTokens: delta(
                    mu.outputTokens,
                    previous?.outputTokens || 0,
                  ),
                  cacheReadInputTokens: delta(
                    mu.cacheReadInputTokens,
                    previous?.cacheReadInputTokens || 0,
                  ),
                  cacheCreationInputTokens: delta(
                    mu.cacheCreationInputTokens,
                    previous?.cacheCreationInputTokens || 0,
                  ),
                  costUSD: delta(mu.costUSD, previous?.costUSD || 0),
                };
                lastReportedModelUsage.set(model, {
                  inputTokens: mu.inputTokens || 0,
                  outputTokens: mu.outputTokens || 0,
                  cacheReadInputTokens: mu.cacheReadInputTokens || 0,
                  cacheCreationInputTokens: mu.cacheCreationInputTokens || 0,
                  costUSD: mu.costUSD || 0,
                });
              }
            } else {
              const fallbackModelKey = config.model || 'default';
              const previous = lastReportedModelUsage.get(fallbackModelKey);
              modelUsageSummary[fallbackModelKey] = {
                inputTokens: delta(
                  sdkUsage.input_tokens,
                  previous?.inputTokens || 0,
                ),
                outputTokens: delta(
                  sdkUsage.output_tokens,
                  previous?.outputTokens || 0,
                ),
                cacheReadInputTokens: delta(
                  sdkUsage.cache_read_input_tokens,
                  previous?.cacheReadInputTokens || 0,
                ),
                cacheCreationInputTokens: delta(
                  sdkUsage.cache_creation_input_tokens,
                  previous?.cacheCreationInputTokens || 0,
                ),
                costUSD: delta(
                  resultMsg.total_cost_usd as number,
                  previous?.costUSD || 0,
                ),
              };
              lastReportedModelUsage.set(fallbackModelKey, {
                inputTokens: sdkUsage.input_tokens || 0,
                outputTokens: sdkUsage.output_tokens || 0,
                cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
                cacheCreationInputTokens:
                  sdkUsage.cache_creation_input_tokens || 0,
                costUSD: (resultMsg.total_cost_usd as number) || 0,
              });
            }

            usageDelta = {
              inputTokens: delta(
                sdkUsage.input_tokens,
                lastReportedUsage.inputTokens,
              ),
              outputTokens: delta(
                sdkUsage.output_tokens,
                lastReportedUsage.outputTokens,
              ),
              cacheReadInputTokens: delta(
                sdkUsage.cache_read_input_tokens,
                lastReportedUsage.cacheReadInputTokens,
              ),
              cacheCreationInputTokens: delta(
                sdkUsage.cache_creation_input_tokens,
                lastReportedUsage.cacheCreationInputTokens,
              ),
            };
            usageEvent = {
              eventType: 'usage',
              agentScope: 'system',
              displayLevel: 'debug',
              usage: {
                ...usageDelta,
                costUSD: delta(
                  resultMsg.total_cost_usd as number,
                  lastReportedUsage.costUSD,
                ),
                durationMs: delta(
                  resultMsg.duration_ms as number,
                  lastReportedUsage.durationMs,
                ),
                numTurns: delta(
                  resultMsg.num_turns as number,
                  lastReportedUsage.numTurns,
                ),
                modelUsage:
                  Object.keys(modelUsageSummary).length > 0
                    ? modelUsageSummary
                    : undefined,
              },
            };
            lastReportedUsage.inputTokens = sdkUsage.input_tokens || 0;
            lastReportedUsage.outputTokens = sdkUsage.output_tokens || 0;
            lastReportedUsage.cacheReadInputTokens =
              sdkUsage.cache_read_input_tokens || 0;
            lastReportedUsage.cacheCreationInputTokens =
              sdkUsage.cache_creation_input_tokens || 0;
            lastReportedUsage.costUSD =
              (resultMsg.total_cost_usd as number) || 0;
            lastReportedUsage.durationMs =
              (resultMsg.duration_ms as number) || 0;
            lastReportedUsage.numTurns = (resultMsg.num_turns as number) || 0;
          }

          // 保存状态到 session
          session.engineState.lastAssistantUuid =
            canonicalAssistantUuid || lastAssistantUuid;
          session.engineState.canonicalAssistantText = canonicalAssistantText;
          session.engineState.resultCount = resultCount;
          session.engineState.messageCount = messageCount;
          session.engineState.contextOverflow = false;
          session.engineState.unrecoverableTranscriptError = false;
          session.engineState.sessionResumeFailed = false;

          const sendResult: EngineSendResult = {
            finalText,
            newSessionId: newSessionId || session.id,
            usage: usageDelta,
            finishReason: 'stop',
            pendingBgTasks,
          };

          // Flush the last text delta before publishing the result. With an
          // onResult hook, the host can display this turn immediately while
          // the SDK iterator stays open for Workflow task notifications and a
          // later summary result.
          yield* this.drainQueue(eventQueue);
          if (hooks?.onResult) {
            await hooks.onResult(sendResult);
            reportedAnyResult = true;
            if (usageEvent) yield usageEvent;
            assistantTextTracker.reset();
            canonicalAssistantText = undefined;

            if (pendingBgTasks > 0) {
              this.logFn(
                `Holding Claude query open for ${pendingBgTasks} background task(s): ${processor.describePendingSdkTasks().join(' | ')}`,
              );
              continue;
            }

            sawPendingBackgroundTasks = false;
            backgroundSummaryForceAttempts = 0;

            processor.cleanup();
            yield* this.drainQueue(eventQueue);
            return { ...sendResult, finalText: '', reported: true };
          }

          if (usageEvent) yield usageEvent;
          processor.cleanup();
          yield* this.drainQueue(eventQueue);

          return sendResult;
        }

        // 其他未处理的消息
        yield* this.drainQueue(eventQueue);
      }
    } finally {
      // 清理活动查询
      const active = this.activeQueries.get(newSessionId || sessionKey);
      if (active) {
        this.activeQueries.delete(newSessionId || sessionKey);
      } else {
        for (const [key, value] of this.activeQueries) {
          if (value.messageStream === stream) {
            this.activeQueries.delete(key);
            break;
          }
        }
      }

      processor.cleanup();
      yield* this.drainQueue(eventQueue);
    }

    // for-await 正常结束（非 result 退出）
    session.engineState.lastAssistantUuid =
      canonicalAssistantUuid || lastAssistantUuid;
    session.engineState.contextOverflow = contextOverflow;
    session.engineState.unrecoverableTranscriptError =
      unrecoverableTranscriptError;
    session.engineState.sessionResumeFailed = sessionResumeFailed;

    const trailingText =
      assistantTextTracker.pickFinalText(processor.getFullText()) || '';
    return {
      finalText: trailingText,
      newSessionId: newSessionId || session.id,
      finishReason: abortRequested ? 'interrupted' : 'stop',
      reported: reportedAnyResult && !trailingText,
    };
  }

  async closeSession(_session: EngineSession): Promise<void> {
    // Anthropic SDK 不需要显式关闭会话
  }

  async getContextUsage(session: EngineSession): Promise<ContextUsage | null> {
    const active = this.activeQueries.get(session.id);
    if (!active?.handle.getContextUsage) return null;
    try {
      const ctx = await active.handle.getContextUsage();
      return {
        totalTokens: ctx.totalTokens,
        maxTokens: ctx.maxTokens,
        percentage: ctx.percentage,
      };
    } catch {
      return null;
    }
  }

  registerTools(tools: EngineToolDefinition[]): void {
    this.registeredTools = [...this.registeredTools, ...tools];
  }

  registerAgents(agents: EngineAgentDefinition[]): void {
    this.registeredAgents = [...this.registeredAgents, ...agents];
  }

  // ── ClaudeEngine 特有方法（供 IPC 循环调用）──

  /** 向活动会话的消息流推送用户消息（IPC pipe-in） */
  pushUserMessage(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): string[] {
    const active = this.activeQueries.get(sessionId);
    if (!active) return ['No active query for session'];
    if (!active.transportReady) return ['SDK transport not ready yet'];
    return active.messageStream.push(text, images);
  }

  /** 中断活动查询 */
  async interruptQuery(sessionId: string): Promise<void> {
    const active = this.activeQueries.get(sessionId);
    if (!active) return;
    try {
      await active.handle.interrupt();
    } catch {
      // ignore
    }
    active.messageStream.end();
  }

  /** 关闭活动查询的消息流 */
  endStream(sessionId: string): void {
    const active = this.activeQueries.get(sessionId);
    if (active) active.messageStream.end();
  }

  /** 检查 SDK transport 是否已就绪（收到 system/init） */
  isTransportReady(sessionId: string): boolean {
    const active = this.activeQueries.get(sessionId);
    return !!active?.transportReady;
  }

  /** 检查消息流是否已结束 */
  isStreamEnded(sessionId: string): boolean {
    const active = this.activeQueries.get(sessionId);
    return !active || active.messageStream.ended;
  }

  // ── 便捷方法：操作当前活动查询（无需 sessionId，适用于单查询场景）──

  /** 获取当前活动查询的 sessionId（收到 system/init 后为真实 ID） */
  getActiveSessionId(): string | undefined {
    for (const [id] of this.activeQueries) {
      return id;
    }
    return undefined;
  }

  /** 向当前活动查询推送用户消息（IPC pipe-in，无需 sessionId） */
  pushToActive(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    onConsumed?: () => void,
  ): string[] {
    for (const [, active] of this.activeQueries) {
      if (!active.messageStream.ended) {
        if (!active.transportReady) return ['SDK transport not ready yet'];
        return active.messageStream.push(text, images, onConsumed);
      }
    }
    return ['No active query'];
  }

  /** 中断当前活动查询 */
  async interruptActive(): Promise<void> {
    for (const [, active] of this.activeQueries) {
      try {
        await active.handle.interrupt();
      } catch {
        // ignore
      }
      active.messageStream.end();
      return;
    }
  }

  /** 关闭当前活动查询的消息流 */
  endActiveStream(): void {
    for (const [, active] of this.activeQueries) {
      active.messageStream.end();
      return;
    }
  }

  /** 检查当前活动查询的 SDK transport 是否已就绪 */
  isActiveTransportReady(): boolean {
    for (const [, active] of this.activeQueries) {
      return active.transportReady;
    }
    return false;
  }

  /** 检查当前活动查询的消息流是否已结束 */
  isActiveStreamEnded(): boolean {
    for (const [, active] of this.activeQueries) {
      return active.messageStream.ended;
    }
    return true;
  }

  /**
   * 获取当前活动查询的累积文本（供 PreCompact hook flush 使用）。
   * 返回 StreamEventProcessor 累积的完整文本。
   */
  getActiveFullText(): string {
    for (const [, active] of this.activeQueries) {
      return active.processor.getFullText();
    }
    return '';
  }

  /**
   * 重置当前活动查询的文本累积器（供 PreCompact hook flush 后调用）。
   */
  resetActiveFullText(): void {
    for (const [, active] of this.activeQueries) {
      active.processor.resetFullTextAccumulator();
      return;
    }
  }

  // ── 私有辅助方法 ──

  /** drain 事件队列，作为 yield* 目标 */
  private *drainQueue(queue: StreamEvent[]): Generator<StreamEvent> {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }

  private isContextOverflowError(msg: string): boolean {
    const patterns: RegExp[] = [
      /prompt is too long/i,
      /maximum context length/i,
      /context.*too large/i,
      /exceeds.*token limit/i,
      /context window.*exceeded/i,
    ];
    return patterns.some((pattern) => pattern.test(msg));
  }

  private isImageMimeMismatchError(msg: string): boolean {
    return (
      /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(
        msg,
      ) ||
      /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(
        msg,
      )
    );
  }

  private isUnrecoverableTranscriptError(msg: string): boolean {
    const isImageSizeError =
      /image.*dimensions?\s+exceed/i.test(msg) ||
      /max\s+allowed\s+size.*pixels/i.test(msg);
    const isMimeMismatch = this.isImageMimeMismatchError(msg);
    const isApiReject = /invalid_request_error/i.test(msg);
    return isApiReject && (isImageSizeError || isMimeMismatch);
  }
}

/**
 * OpenAIEngine — OpenAI Responses API 的 AgentEngine 实现。
 *
 * 使用 POST /v1/responses（不是 /v1/chat/completions）直调 AgentRouter。
 * 支持 SSE 流式输出、function calling、previous_response_id 多轮会话。
 *
 * 与 ClaudeEngine 的关键差异：
 * - 没有 thinking blocks（不产生 thinking_delta 事件）
 * - 没有 cache_control（OpenAI 用不同机制）
 * - previous_response_id 替代 sessionId / resume
 * - 工具调用格式：OpenAI function_call vs Anthropic tool_use
 * - 工具循环：客户端手动循环（SDK 不自动处理）
 */

import fs from 'fs';
import path from 'path';

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

// ── OpenAI Responses API 类型 ──

interface OpenAIResponse {
  id: string;
  object: 'response';
  status: 'completed' | 'in_progress' | 'incomplete' | 'failed';
  output: OpenAIOutputItem[];
  usage?: OpenAIUsage;
  model: string;
  previous_response_id: string | null;
  error?: { message: string; code?: string };
}

interface OpenAIOutputItem {
  id: string;
  type: 'message' | 'function_call' | 'reasoning';
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  arguments?: string;
  status?: string;
}

interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// ── 文本缓冲阈值（与 ClaudeEngine StreamEventProcessor 保持一致）──
const TEXT_FLUSH_THRESHOLD = 200;

// ── SSE 流解析 ──

async function* parseSseStream(
  response: Response,
): AsyncGenerator<SseEvent, void, unknown> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      const events = buffer.split('\n\n');
      buffer = events.pop() || ''; // 最后一段可能不完整，保留

      for (const rawEvent of events) {
        const lines = rawEvent.split('\n');
        let eventName = 'message';
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);
          yield { event: eventName, data };
        } catch {
          // 忽略无法解析的 data 行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── 工具定义格式转换 ──

function toolsToOpenAIFunctionDefs(
  tools: EngineToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// ── 工具输入摘要 ──

function summarizeToolInput(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson);
    // 优先提取有意义的字段
    for (const key of [
      'text',
      'message',
      'query',
      'command',
      'path',
      'url',
      'name',
      'content',
    ]) {
      if (obj[key]) return String(obj[key]).slice(0, 180);
    }
    const str = JSON.stringify(obj);
    return str.length > 180 ? str.slice(0, 180) + '...' : str;
  } catch {
    return argsJson.slice(0, 180);
  }
}

// ── OpenAIEngine ──

export interface OpenAIEngineOptions {
  /** 日志函数 */
  logFn?: (msg: string) => void;
  /** 会话存储目录（保存 previous_response_id） */
  sessionDir?: string;
}

export class OpenAIEngine implements AgentEngine {
  readonly engineType: EngineType = 'openai';

  private readonly logFn: (msg: string) => void;
  private readonly sessionDir: string;
  private registeredTools: EngineToolDefinition[] = [];
  private registeredAgents: EngineAgentDefinition[] = [];

  /** 最后一次 API 响应的 usage 缓存：sessionId → usage */
  private lastUsage = new Map<
    string,
    { inputTokens: number; outputTokens: number }
  >();

  constructor(options: OpenAIEngineOptions = {}) {
    this.logFn =
      options.logFn ?? ((msg) => console.error(`[agent-runner] ${msg}`));
    this.sessionDir =
      options.sessionDir ??
      path.join(process.cwd(), 'data', 'sessions', 'openai');
  }

  // ── AgentEngine 接口实现 ──

  async createSession(
    config: EngineConfig,
    resumeSessionId?: string,
  ): Promise<EngineSession> {
    return {
      id: resumeSessionId || '',
      engineType: 'openai',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      engineState: {
        _config: config,
        previousResponseId: resumeSessionId || null,
      },
    };
  }

  async *sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    _agents: EngineAgentDefinition[],
    signal?: AbortSignal,
    _hooks?: EngineHooks,
  ): AsyncGenerator<StreamEvent, EngineSendResult, unknown> {
    if (messages.length === 0) {
      return { finalText: '', newSessionId: session.id, finishReason: 'stop' };
    }

    // ── 解析引擎配置（优先级：session.engineState._config > 环境变量）──
    const storedConfig = session.engineState?._config as
      | EngineConfig
      | undefined;
    const baseUrl =
      storedConfig?.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://co.agentrouter.org/v1';
    const apiKey =
      storedConfig?.apiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      '';
    const model =
      storedConfig?.model ||
      process.env.OPENAI_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      'gpt-5.5';
    const systemPromptAppend =
      storedConfig?.systemPromptAppend || '';

    if (!apiKey) {
      yield {
        eventType: 'status',
        agentScope: 'system',
        statusText: 'error',
        detail:
          'OpenAI API key 未配置（需要 OPENAI_API_KEY 或 ANTHROPIC_AUTH_TOKEN）',
        displayLevel: 'primary',
      };
      return { finalText: '', newSessionId: session.id, finishReason: 'error' };
    }

    // ── 合并注册的工具 + 本次传入的工具 ──
    const allTools = [...this.registeredTools, ...tools];

    // ── 构建 input items（从 messages 转换）──
    const inputItems: Array<Record<string, unknown>> = [];
    let previousResponseId =
      (session.engineState?.previousResponseId as string) || null;

    for (const msg of messages) {
      if (msg.role === 'system') {
        // system 消息通过 instructions 字段传入（见下方 requestBody）
        continue;
      }

      if (msg.toolUseId) {
        // tool_result 回填
        inputItems.push({
          type: 'function_call_output',
          call_id: msg.toolUseId,
          output: msg.content,
        });
        continue;
      }

      // user / assistant 消息
      const contentParts: Array<Record<string, unknown>> = [];

      if (msg.images && msg.images.length > 0) {
        for (const img of msg.images) {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.data}`,
          });
        }
      }

      if (msg.content) {
        contentParts.push({
          type: 'input_text',
          text: msg.content,
        });
      }

      if (contentParts.length > 0) {
        inputItems.push({
          role: msg.role,
          content: contentParts,
        });
      }
    }

    // 从 messages 中提取 system prompt（如果有）
    const systemMsg = messages.find((m) => m.role === 'system');
    const instructions =
      (systemMsg?.content || '') +
      (systemPromptAppend ? (systemMsg?.content ? '\n\n' : '') + systemPromptAppend : '');

    // ── 工具循环：可能需要多轮 function calling ──
    let loopCount = 0;
    const MAX_TOOL_LOOPS = storedConfig?.maxTurns ?? 20;
    let finalText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let abortRequested = false;

    // 注册 abort 监听
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          abortRequested = true;
        },
        { once: true },
      );
    }

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // ── 构建请求体 ──
      const requestBody: Record<string, unknown> = {
        model,
        input: inputItems,
        tools:
          allTools.length > 0 ? toolsToOpenAIFunctionDefs(allTools) : undefined,
        stream: true,
        parallel_tool_calls: true,
      };

      if (previousResponseId) {
        requestBody.previous_response_id = previousResponseId;
      }

      if (instructions) {
        requestBody.instructions = instructions;
      }

      // ── 本轮状态追踪 ──
      let currentResponseId = '';
      let textBuffer = ''; // 文本增量缓冲（达到阈值后 flush）
      let currentTurnText = ''; // 本轮完整文本
      const pendingToolCalls = new Map<
        string,
        { name: string; argumentsBuffer: string }
      >();
      let hasToolCalls = false;
      let finalUsage: OpenAIUsage | null = null;
      let responseFailed = false;
      let responseErrorMsg = '';

      try {
        const url = `${baseUrl.replace(/\/$/, '')}/responses`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logFn(
            `OpenAI API error (${response.status}): ${errorText.slice(0, 500)}`,
          );
          yield {
            eventType: 'status',
            agentScope: 'system',
            statusText: 'error',
            detail: `OpenAI API 错误 (${response.status}): ${errorText.slice(0, 200)}`,
            displayLevel: 'primary',
            sessionId: session.id,
          };
          return {
            finalText: '',
            newSessionId: session.id,
            finishReason: 'error',
          };
        }

        // ── 处理 SSE 流 ──
        for await (const sseEvent of parseSseStream(response)) {
          if (abortRequested || signal?.aborted) break;

          switch (sseEvent.event) {
            case 'response.created': {
              // data 直接是 response 对象（不是 { response: ... }）
              const resp = sseEvent.data as unknown as OpenAIResponse;
              currentResponseId = resp.id;
              previousResponseId = resp.id;
              session.id = resp.id;
              session.lastActivityAt = Date.now();
              session.engineState = {
                ...session.engineState,
                previousResponseId: resp.id,
              };

              yield {
                eventType: 'init',
                agentScope: 'system',
                sessionId: resp.id,
                displayLevel: 'debug',
              };
              break;
            }

            case 'response.output_text.delta': {
              const delta = (sseEvent.data as { delta: string }).delta;
              if (delta) {
                currentTurnText += delta;
                finalText += delta;
                textBuffer += delta;

                // 文本缓冲刷新（与 ClaudeEngine StreamEventProcessor 策略一致）
                if (textBuffer.length >= TEXT_FLUSH_THRESHOLD) {
                  yield {
                    eventType: 'text_delta',
                    text: textBuffer,
                    agentScope: 'main',
                    displayLevel: 'primary',
                    sessionId: currentResponseId,
                  };
                  textBuffer = '';
                }
              }
              break;
            }

            case 'response.output_text.done': {
              // 文本输出完成 — flush 缓冲
              if (textBuffer.length > 0) {
                yield {
                  eventType: 'text_delta',
                  text: textBuffer,
                  agentScope: 'main',
                  displayLevel: 'primary',
                  sessionId: currentResponseId,
                };
                textBuffer = '';
              }
              break;
            }

            case 'response.output_item.added': {
              const item = (sseEvent.data as { item: OpenAIOutputItem }).item;
              if (item.type === 'function_call' && item.name && item.id) {
                pendingToolCalls.set(item.id, {
                  name: item.name,
                  argumentsBuffer: item.arguments || '',
                });
                hasToolCalls = true;

                yield {
                  eventType: 'tool_use_start',
                  toolName: item.name,
                  toolUseId: item.id,
                  agentScope: 'main',
                  displayLevel: 'detail',
                  sessionId: currentResponseId,
                };
              }
              break;
            }

            case 'response.function_call_arguments.delta': {
              const data = sseEvent.data as {
                item_id: string;
                delta: string;
              };
              const call = pendingToolCalls.get(data.item_id);
              if (call) {
                call.argumentsBuffer += data.delta;
              }
              break;
            }

            case 'response.output_item.done': {
              const item = (sseEvent.data as { item: OpenAIOutputItem }).item;
              if (item.type === 'function_call' && item.id) {
                const call = pendingToolCalls.get(item.id);
                if (call) {
                  // 参数接收完成 — 先 flush 文本缓冲
                  if (textBuffer.length > 0) {
                    yield {
                      eventType: 'text_delta',
                      text: textBuffer,
                      agentScope: 'main',
                      displayLevel: 'primary',
                      sessionId: currentResponseId,
                    };
                    textBuffer = '';
                  }

                  // 发射 tool_progress（输入就绪）
                  yield {
                    eventType: 'tool_progress',
                    toolName: call.name,
                    toolUseId: item.id,
                    toolInputSummary: summarizeToolInput(
                      call.argumentsBuffer,
                    ),
                    agentScope: 'main',
                    displayLevel: 'detail',
                    sessionId: currentResponseId,
                  };

                  // 执行工具 handler
                  let toolResult: EngineToolResult;
                  try {
                    const args = JSON.parse(call.argumentsBuffer || '{}');
                    const toolDef = allTools.find(
                      (t) => t.name === call.name,
                    );
                    toolResult = toolDef
                      ? await toolDef.handler(args)
                      : {
                          content: `错误: 未知工具 ${call.name}`,
                          isError: true,
                        };
                  } catch (toolErr) {
                    const errMsg =
                      toolErr instanceof Error
                        ? toolErr.message
                        : String(toolErr);
                    toolResult = {
                      content: `工具执行错误: ${errMsg}`,
                      isError: true,
                    };
                  }

                  // 发射 tool_use_end
                  yield {
                    eventType: 'tool_use_end',
                    toolName: call.name,
                    toolUseId: item.id,
                    agentScope: 'main',
                    displayLevel: 'detail',
                    sessionId: currentResponseId,
                  };

                  // 发射 tool_result
                  const resultStr = toolResult.content;
                  const truncatedResult =
                    resultStr.length > 2000
                      ? resultStr.slice(0, 2000) + '...'
                      : resultStr;
                  yield {
                    eventType: 'tool_result',
                    toolName: call.name,
                    toolUseId: item.id,
                    toolResult: truncatedResult,
                    agentScope: 'main',
                    displayLevel: 'detail',
                    sessionId: currentResponseId,
                  };

                  // 将 function_call + function_call_output 加入 inputItems
                  // 供下一轮循环使用
                  inputItems.push({
                    type: 'function_call',
                    call_id: item.id,
                    name: call.name,
                    arguments: call.argumentsBuffer,
                  });
                  inputItems.push({
                    type: 'function_call_output',
                    call_id: item.id,
                    output: resultStr,
                  });

                  pendingToolCalls.delete(item.id);
                }
              }
              break;
            }

            case 'response.completed':
            case 'response.incomplete': {
              // data 直接是 response 对象
              const resp = sseEvent.data as unknown as OpenAIResponse;
              finalUsage = resp.usage || null;

              if (finalUsage) {
                totalInputTokens += finalUsage.input_tokens;
                totalOutputTokens += finalUsage.output_tokens;

                // 缓存 usage 供 getContextUsage 使用
                if (currentResponseId) {
                  this.lastUsage.set(currentResponseId, {
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                  });
                }

                yield {
                  eventType: 'usage',
                  agentScope: 'system',
                  displayLevel: 'debug',
                  usage: {
                    inputTokens: finalUsage.input_tokens,
                    outputTokens: finalUsage.output_tokens,
                    cacheReadInputTokens:
                      finalUsage.input_tokens_details?.cached_tokens || 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0, // OpenAI usage 不含 cost
                    durationMs: 0,
                    numTurns: loopCount,
                  },
                  sessionId: currentResponseId,
                };
              }

              // 发射完成状态
              if (resp.status === 'completed') {
                yield {
                  eventType: 'status',
                  agentScope: 'system',
                  statusText: 'completed',
                  displayLevel: 'debug',
                  sessionId: currentResponseId,
                };
              } else if (resp.status === 'incomplete') {
                yield {
                  eventType: 'status',
                  agentScope: 'system',
                  statusText: 'incomplete',
                  detail: '响应未完成（可能达到 max_output_tokens）',
                  displayLevel: 'detail',
                  sessionId: currentResponseId,
                };
              }
              break;
            }

            case 'response.failed': {
              const resp = sseEvent.data as unknown as OpenAIResponse;
              responseFailed = true;
              responseErrorMsg = resp.error?.message || '未知错误';
              break;
            }

            case 'response.done':
              // 流结束标记
              break;

            default:
              // 其他事件忽略（如 response.in_progress 等中间状态）
              break;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError' || signal?.aborted) {
          this.logFn('OpenAI 请求被中止');
          return {
            finalText: finalText,
            newSessionId: session.id,
            finishReason: 'interrupted',
          };
        }
        this.logFn(
          `OpenAI 请求失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        yield {
          eventType: 'status',
          agentScope: 'system',
          statusText: 'error',
          detail: `请求失败: ${err instanceof Error ? err.message : String(err)}`,
          displayLevel: 'primary',
          sessionId: session.id,
        };
        return {
          finalText: finalText,
          newSessionId: session.id,
          finishReason: 'error',
        };
      }

      // flush 剩余文本缓冲
      if (textBuffer.length > 0) {
        yield {
          eventType: 'text_delta',
          text: textBuffer,
          agentScope: 'main',
          displayLevel: 'primary',
          sessionId: currentResponseId,
        };
        textBuffer = '';
      }

      // 处理失败状态
      if (responseFailed) {
        yield {
          eventType: 'status',
          agentScope: 'system',
          statusText: 'error',
          detail: `响应失败: ${responseErrorMsg}`,
          displayLevel: 'primary',
          sessionId: currentResponseId || session.id,
        };
        return {
          finalText: finalText,
          newSessionId: session.id,
          finishReason: 'error',
        };
      }

      // 如果没有工具调用，循环结束
      if (!hasToolCalls) {
        break;
      }

      // 有工具调用且已回填结果，继续循环让模型处理 tool_result
      hasToolCalls = false;
    }

    if (loopCount >= MAX_TOOL_LOOPS) {
      this.logFn(`达到最大工具循环次数 (${MAX_TOOL_LOOPS})，停止`);
      yield {
        eventType: 'status',
        agentScope: 'system',
        statusText: `达到最大轮次限制 (${MAX_TOOL_LOOPS})`,
        displayLevel: 'debug',
        sessionId: session.id,
      };
    }

    // 保存 previous_response_id 供下次会话使用
    if (previousResponseId) {
      session.engineState = {
        ...session.engineState,
        previousResponseId,
      };
      this.saveResponseId(session);
    }

    session.lastActivityAt = Date.now();

    return {
      finalText,
      newSessionId: session.id,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      finishReason: loopCount >= MAX_TOOL_LOOPS ? 'max_turns' : 'stop',
    };
  }

  async closeSession(session: EngineSession): Promise<void> {
    // OpenAI 不需要显式关闭会话
    // 但保存 response_id 供后续恢复
    if (session.id) {
      this.saveResponseId(session);
    }
    this.lastUsage.delete(session.id);
  }

  async getContextUsage(session: EngineSession): Promise<ContextUsage | null> {
    const usage = this.lastUsage.get(session.id);
    if (!usage) return null;
    // OpenAI 不在流中提供 context window 大小，做近似估算
    const estimatedMax = 200_000; // 假设 200K context window
    const total = usage.inputTokens + usage.outputTokens;
    return {
      totalTokens: total,
      maxTokens: estimatedMax,
      percentage: Math.round((total / estimatedMax) * 100),
    };
  }

  registerTools(tools: EngineToolDefinition[]): void {
    this.registeredTools = [...this.registeredTools, ...tools];
  }

  registerAgents(agents: EngineAgentDefinition[]): void {
    this.registeredAgents = [...this.registeredAgents, ...agents];
  }

  // ── 私有方法 ──

  private saveResponseId(session: EngineSession): void {
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      const filePath = path.join(this.sessionDir, 'last_response_id');
      fs.writeFileSync(filePath, session.id, 'utf-8');
    } catch (err) {
      this.logFn(
        `保存 OpenAI response_id 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 从磁盘加载保存的 response_id（供外部调用恢复会话） */
  loadResponseId(): string | null {
    try {
      const filePath = path.join(this.sessionDir, 'last_response_id');
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8').trim();
      }
    } catch {
      // ignore
    }
    return null;
  }
}
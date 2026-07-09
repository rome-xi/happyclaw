/**
 * OpenAIEngine — OpenAI Responses API 的 AgentEngine 实现。
 *
 * 使用 POST /v1/responses（不是 /v1/chat/completions）直调 AgentRouter。
 * 支持 SSE 流式输出、function calling、previous_response_id 多轮会话。
 */

import fs from 'fs';
import path from 'path';

import type {
  AgentEngine,
  EngineConfig,
  EngineSession,
  EngineMessage,
  EngineToolDefinition,
  EngineAgentDefinition,
  ContextUsage,
  EngineSendResult,
  EngineHooks,
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

// ── SSE 解析 ──

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
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

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

// ── 工具调用格式转换 ──

function toolsToOpenAIFunctionDefs(tools: EngineToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// ── OpenAIEngine ──

export interface OpenAIEngineOptions {
  /** 日志函数 */
  logFn?: (msg: string) => void;
  /** 会话存储目录（保存 previous_response_id） */
  sessionDir?: string;
}

export class OpenAIEngine implements AgentEngine {
  readonly engineType = 'openai' as const;

  private readonly logFn: (msg: string) => void;
  private readonly sessionDir: string;
  private registeredTools: EngineToolDefinition[] = [];
  private registeredAgents: EngineAgentDefinition[] = [];

  constructor(options: OpenAIEngineOptions = {}) {
    this.logFn = options.logFn ?? ((msg) => console.error(`[agent-runner] ${msg}`));
    this.sessionDir = options.sessionDir ?? path.join(process.cwd(), 'data', 'sessions', 'openai');
  }

  async createSession(_config: EngineConfig, resumeSessionId?: string): Promise<EngineSession> {
    return {
      id: resumeSessionId || '',
      engineType: 'openai',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      engineState: {
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

    // 从环境变量或 config 获取 API 配置
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://co.agentrouter.org/v1';
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
    const model = process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || 'gpt-5.5';

    if (!apiKey) {
      yield {
        eventType: 'status',
        agentScope: 'system',
        statusText: 'error',
        detail: 'OpenAI API key 未配置（需要 OPENAI_API_KEY 或 ANTHROPIC_AUTH_TOKEN）',
      };
      return { finalText: '', newSessionId: session.id, finishReason: 'error' };
    }

    // 合并注册的工具 + 本次传入的工具
    const allTools = [...this.registeredTools, ...tools];

    // 构建 input items
    const inputItems: Array<Record<string, unknown>> = [];

    // 如果有 previous_response_id，先设置
    let previousResponseId = (session.engineState?.previousResponseId as string) || null;

    // 构建消息输入
    for (const msg of messages) {
      if (msg.role === 'system') {
        // OpenAI Responses API 用 instructions 字段传系统 prompt
        // 但我们把它作为 user message 的一部分传入（更兼容）
        continue;
      }

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

      if (msg.toolUseId) {
        // 这是 tool_result 回填
        inputItems.push({
          type: 'function_call_output',
          call_id: msg.toolUseId,
          output: msg.content,
        });
      } else if (msg.role === 'user') {
        inputItems.push({
          role: 'user',
          content: contentParts,
        });
      }
    }

    // 工具循环：可能需要多轮 function calling
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 10;
    let finalText = '';

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // 构建请求体
      const requestBody: Record<string, unknown> = {
        model,
        input: inputItems,
        tools: toolsToOpenAIFunctionDefs(allTools),
        stream: true,
        parallel_tool_calls: true,
      };

      if (previousResponseId) {
        requestBody.previous_response_id = previousResponseId;
      }

      // 系统 prompt
      const systemMsg = messages.find((m) => m.role === 'system');
      if (systemMsg?.content) {
        requestBody.instructions = systemMsg.content;
      }

      let currentResponseId = '';
      let currentText = '';
      const pendingToolCalls = new Map<string, { name: string; argumentsBuffer: string }>();
      let hasToolCalls = false;
      let finalUsage: OpenAIUsage | null = null;

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
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
          this.logFn(`OpenAI API error (${response.status}): ${errorText.slice(0, 500)}`);
          yield {
            eventType: 'status',
            agentScope: 'system',
            statusText: 'error',
            detail: `OpenAI API 错误 (${response.status}): ${errorText.slice(0, 200)}`,
            sessionId: session.id,
          };
          return { finalText: '', newSessionId: session.id, finishReason: 'error' };
        }

        // 处理 SSE 流
        for await (const sseEvent of parseSseStream(response)) {
          if (signal?.aborted) break;

          switch (sseEvent.event) {
            case 'response.created': {
              const resp = (sseEvent.data as { response: OpenAIResponse }).response;
              currentResponseId = resp.id;
              previousResponseId = resp.id;
              session.id = resp.id;
              session.lastActivityAt = Date.now();
              session.engineState = { ...session.engineState, previousResponseId: resp.id };

              yield {
                eventType: 'init',
                agentScope: 'system',
                sessionId: resp.id,
              };
              break;
            }

            case 'response.output_text.delta': {
              const delta = (sseEvent.data as { delta: string }).delta;
              if (delta) {
                currentText += delta;
                finalText += delta;
                yield {
                  eventType: 'text_delta',
                  text: delta,
                  agentScope: 'main',
                  sessionId: currentResponseId,
                };
              }
              break;
            }

            case 'response.output_item.added': {
              const item = (sseEvent.data as { item: OpenAIOutputItem }).item;
              if (item.type === 'function_call' && item.name) {
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
                  sessionId: currentResponseId,
                };
              }
              break;
            }

            case 'response.function_call_arguments.delta': {
              const data = sseEvent.data as { item_id: string; delta: string };
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
                  // 发射 tool_use_end
                  yield {
                    eventType: 'tool_use_end',
                    toolName: call.name,
                    toolUseId: item.id,
                    agentScope: 'main',
                    sessionId: currentResponseId,
                  };

                  // 执行工具
                  try {
                    const args = JSON.parse(call.argumentsBuffer || '{}');
                    const toolDef = allTools.find((t) => t.name === call.name);
                    const toolResult = toolDef
                      ? await toolDef.handler(args)
                      : { content: `错误: 未知工具 ${call.name}`, isError: true };

                    const resultStr = toolResult.content;

                    // 将结果加入 inputItems 供下一轮使用
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

                    yield {
                      eventType: 'tool_result',
                      toolUseId: item.id,
                      toolResult: resultStr.length > 2000 ? resultStr.slice(0, 2000) + '...' : resultStr,
                      agentScope: 'main',
                      sessionId: currentResponseId,
                    };
                  } catch (toolErr) {
                    const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                    inputItems.push({
                      type: 'function_call',
                      call_id: item.id,
                      name: call.name,
                      arguments: call.argumentsBuffer,
                    });
                    inputItems.push({
                      type: 'function_call_output',
                      call_id: item.id,
                      output: `工具执行错误: ${errMsg}`,
                    });
                  }

                  pendingToolCalls.delete(item.id);
                }
              }
              break;
            }

            case 'response.completed':
            case 'response.incomplete': {
              const respData = sseEvent.data as { response: OpenAIResponse };
              const resp = respData.response;
              finalUsage = resp.usage || null;

              if (finalUsage) {
                yield {
                  eventType: 'usage',
                  usage: {
                    inputTokens: finalUsage.input_tokens,
                    outputTokens: finalUsage.output_tokens,
                    cacheReadInputTokens: finalUsage.input_tokens_details?.cached_tokens || 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0, // OpenAI usage 不含 cost
                    durationMs: 0,
                    numTurns: loopCount,
                  },
                  sessionId: currentResponseId,
                };
              }
              break;
            }

            case 'response.done':
              // 流结束
              break;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          this.logFn('OpenAI 请求被中止');
          return { finalText: '', newSessionId: session.id, finishReason: 'interrupted' };
        }
        this.logFn(`OpenAI 请求失败: ${err instanceof Error ? err.message : String(err)}`);
        yield {
          eventType: 'status',
          agentScope: 'system',
          statusText: 'error',
          detail: `请求失败: ${err instanceof Error ? err.message : String(err)}`,
          sessionId: session.id,
        };
        return { finalText: '', newSessionId: session.id, finishReason: 'error' };
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
    }

    // 保存 previous_response_id 供下次会话使用
    if (previousResponseId) {
      session.engineState = { ...session.engineState, previousResponseId };
      this.saveResponseId(session);
    }

    return {
      finalText,
      newSessionId: session.id,
      finishReason: loopCount >= MAX_TOOL_LOOPS ? 'max_turns' : 'stop',
    };
  }

  async closeSession(session: EngineSession): Promise<void> {
    // OpenAI 不需要显式关闭
    // 但保存 response_id
    if (session.id) {
      this.saveResponseId(session);
    }
  }

  async getContextUsage(_session: EngineSession): Promise<ContextUsage | null> {
    // OpenAI Responses API 不在流中提供实时 context usage
    // 只能从最终 response.usage 获取总 token 数
    return null;
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
      this.logFn(`保存 OpenAI response_id 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

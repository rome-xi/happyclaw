# AgentEngine 抽象层设计文档

> 为 HappyClaw 实现多模型引擎支持：当前仅 Anthropic Claude，扩展为可插拔的 AgentEngine 架构，支持 OpenAI Responses API 等任意后端。

## 1. 背景与动机

HappyClaw 当前的 agent-runner（`container/agent-runner/src/index.ts`）直接耦合 `@anthropic-ai/claude-agent-sdk`：

- `query()` 调用、`resume`/`sessionId` 管理、`system/init` 事件均为 Anthropic 特有
- MCP 工具通过 SDK 的 `createSdkMcpServer()` 注册，绑定 Anthropic wire format
- StreamEvent 类型（`thinking_delta`、`tool_use` blocks）隐含 Anthropic 假设
- Provider 池只区分 `official` / `third_party`，不区分 wire protocol

**目标**：引入 `AgentEngine` 抽象层，让 agent-runner 可以在运行时选择后端引擎，而不需要重写 IPC、MCP、会话管理等通用逻辑。

**非目标**（第一版不做）：

- 不实现 OpenAI 的 Sub-Agent 编排（`task_start`/`task_notification` 事件在 OpenAI 引擎下不产生）
- 不实现 OpenAI 的上下文自动压缩（`compact_boundary` 事件不产生）
- 不迁移 Skills 发现机制到 OpenAI（仍由宿主侧 `entrypoint.sh` 处理，OpenAI 引擎下 Skills 以 system prompt 注入）

---

## 2. AgentEngine Interface

### 2.1 核心接口

```typescript
// container/agent-runner/src/engines/types.ts

import type { StreamEvent } from '../types.js';

/** 引擎类型：决定 wire protocol 和 API 调用方式 */
export type EngineType = 'anthropic' | 'openai';

/**
 * 引擎会话句柄。
 *
 * Anthropic: id = SDK session_id（由 system/init 事件返回）
 * OpenAI:    id = 最新的 response_id（每次 API 调用更新）
 */
export interface EngineSession {
  /** 会话唯一标识 */
  id: string;
  engineType: EngineType;
  createdAt: number;
  lastActivityAt: number;
  /** 引擎私有状态（如 OpenAI 的 response_id 链、Anthropic 的 transcript 路径） */
  engineState: Record<string, unknown>;
}

/** 引擎消息格式 — 跨引擎通用 */
export interface EngineMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 关联的 tool_use ID（用于 tool_result 回填） */
  toolUseId?: string;
  /** 图片附件（Vision 支持） */
  images?: Array<{ data: string; mimeType: string }>;
}

/**
 * 引擎工具定义 — 跨引擎通用格式。
 * MCP 工具的业务逻辑（IPC 文件读写、memory 操作）封装在 handler 中，
 * 与具体引擎无关，可 100% 复用。
 */
export interface EngineToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 格式的输入定义（OpenAI 和 Anthropic 都支持） */
  inputSchema: Record<string, unknown>;
  /**
   * 工具执行 handler。
   * @param input 解析后的输入对象（已通过 inputSchema 校验）
   * @returns 工具结果字符串（成功）或抛出异常（失败）
   */
  handler: (input: Record<string, unknown>) => Promise<EngineToolResult>;
}

/** 工具执行结果 */
export interface EngineToolResult {
  /** 结果文本内容 */
  content: string;
  /** 是否为错误结果 */
  isError?: boolean;
}

/**
 * 引擎 Sub-Agent 定义 — 跨引擎通用格式。
 * 注意：OpenAI 引擎不内置 Sub-Agent 调度，此定义仅用于 ClaudeEngine。
 */
export interface EngineAgentDefinition {
  id: string;
  description: string;
  /** 系统 prompt / 指令 */
  instructions: string;
  /** 允许使用的工具名列表（白名单） */
  tools?: string[];
  /** 模型 ID，'inherit' 表示继承主会话 */
  model?: string;
  /** 最大对话轮次 */
  maxTurns?: number;
}

/** 引擎配置 */
export interface EngineConfig {
  /** 模型 ID（如 'opus[1m]' 或 'gpt-5.5'） */
  model: string;
  /** API Base URL（如 'https://api.anthropic.com' 或 'https://co.agentrouter.org/v1'） */
  baseUrl: string;
  /** API Key / Auth Token */
  apiKey: string;
  /** 工作目录（用于文件操作工具） */
  cwd: string;
  /** 系统 prompt 追加内容（注入到模型 system prompt 末尾） */
  systemPromptAppend?: string;
  /** 思考/推理模式配置 */
  thinking?: {
    type: 'adaptive' | 'enabled' | 'disabled';
    /** Anthropic 特有：thinking block 展示方式 */
    display?: 'summarized' | 'hidden';
  };
  /** 最大工具循环轮次（防止无限循环） */
  maxTurns?: number;
  /** 额外可访问目录 */
  additionalDirectories?: string[];
  /** 引擎特有选项（透传到底层 SDK/API） */
  extra?: Record<string, unknown>;
}

/** 上下文使用统计 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

/**
 * AgentEngine — 模型引擎的统一抽象。
 *
 * 每个实现负责：
 * 1. 建立和维护与模型 API 的会话
 * 2. 将模型输出的流式事件转换为统一 StreamEvent
 * 3. 处理工具调用循环（输入/输出格式适配）
 * 4. 管理会话持久化（sessionId / previous_response_id）
 */
export interface AgentEngine {
  readonly engineType: EngineType;

  /**
   * 创建或恢复会话。
   *
   * Anthropic: 不立即创建 SDK session，仅返回占位 session，
   *            实际 ID 从首次 sendMessage 的 system/init 事件中提取。
   * OpenAI:    直接创建空 session（id 为空字符串），
   *            首次 API 调用后从 response.id 更新。
   *
   * @param config 引擎配置
   * @param resumeSessionId 要恢复的会话 ID（可选）
   */
  createSession(config: EngineConfig, resumeSessionId?: string): Promise<EngineSession>;

  /**
   * 发送消息并获取流式响应。
   *
   * 返回 AsyncGenerator，每次 yield 一个 StreamEvent。
   * 调用方通过 for-await 循环消费，直到引擎完成所有轮次（含工具循环）。
   *
   * 引擎内部负责：
   * - 将 EngineMessage 转换为对应 wire format
   * - 执行工具调用循环（直到模型不再请求工具或达到 maxTurns）
   * - 将 wire format 的流式事件翻译为统一 StreamEvent
   *
   * @param session 引擎会话（sendMessage 可能就地更新 session.id 和 engineState）
   * @param messages 要发送的消息（单条用户消息，或带 tool_result 的多轮上下文）
   * @param tools 本次可用的工具集
   * @param agents 本次可用的 Sub-Agent（仅 ClaudeEngine 使用）
   * @param signal AbortSignal，用于中断当前请求
   * @param hooks 引擎生命周期钩子（如 PreCompact）
   */
  sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    agents: EngineAgentDefinition[],
    signal?: AbortSignal,
    hooks?: EngineHooks,
  ): AsyncGenerator<StreamEvent, EngineSendResult, unknown>;

  /**
   * 关闭会话，清理资源。
   * Anthropic SDK 不需要显式关闭（此操作为 no-op）；
   * OpenAI 引擎可在此清理本地缓存。
   */
  closeSession(session: EngineSession): Promise<void>;

  /**
   * 获取当前上下文使用情况（tokens / 百分比）。
   * Anthropic: 从 SDK getContextUsage() 获取（精确值）
   * OpenAI:    从最后一次 response.usage 估算（近似值）
   */
  getContextUsage(session: EngineSession): Promise<ContextUsage | null>;
}

/** 引擎 sendMessage 的最终结果 */
export interface EngineSendResult {
  /** 最终文本回复（完整内容，非增量） */
  finalText: string;
  /** 更新后的会话 ID */
  newSessionId: string;
  /** Token 用量统计 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /** 完成原因 */
  finishReason: 'stop' | 'max_turns' | 'interrupted' | 'error';
}

/** 引擎生命周期钩子 */
export interface EngineHooks {
  /**
   * 上下文压缩前钩子。
   * 仅 ClaudeEngine 触发（SDK 自动 compact）；
   * OpenAI 引擎暂不支持自动压缩，此钩子不触发。
   */
  preCompact?: (event: PreCompactEvent) => Promise<void>;
}

/** PreCompact 事件数据 */
export interface PreCompactEvent {
  /** 会话 ID */
  sessionId: string;
  /** Agent ID（主会话为空，Sub-Agent 有值） */
  agentId?: string;
  /** SDK transcript 文件路径 */
  transcriptPath?: string;
}
```

### 2.2 接口设计要点

| 设计决策 | 理由 |
|----------|------|
| `sendMessage` 返回 `AsyncGenerator<StreamEvent, EngineSendResult>` | 区分中间事件（yield）和最终结果（return），调用方可用 `for-await + finally` 模式 |
| `EngineToolDefinition.handler` 返回 `EngineToolResult` 而非 `string` | 统一 `isError` 语义，避免各引擎自行判断工具成功/失败 |
| `EngineSession.engineState` 用 `Record<string, unknown>` | 引擎私有数据（如 OpenAI 的 `lastResponseId`、Anthropic 的 `transcriptPath`）不污染接口 |
| `tools` 和 `agents` 作为 `sendMessage` 参数而非构造参数 | 支持每次调用动态变更工具集（如 memory flush 时限制工具白名单） |
| `hooks` 作为 `sendMessage` 参数 | PreCompact 回调需要访问外部状态（emit、fullText），不适合在构造时绑定 |

---

## 3. ClaudeEngine 实现

### 3.1 架构定位

```
┌──────────────────────────────────────────────────────────────┐
│                     index.ts (主循环)                         │
│  stdin 读取 → runQuery() → while(true) { waitForIpcMessage } │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │     AgentEngine         │
              │     (interface)         │
              └────────────┬────────────┘
                           │
             ┌─────────────┼─────────────┐
             │                           │
    ┌────────▼────────┐        ┌────────▼────────┐
    │   ClaudeEngine   │        │   OpenAIEngine   │
    │  (包装现有逻辑)   │        │  (新实现)         │
    └────────┬────────┘        └────────┬────────┘
             │                           │
    ┌────────▼────────┐        ┌────────▼────────┐
    │ Anthropic Agent │        │ OpenAI /v1/     │
    │ SDK query()     │        │ responses (SSE) │
    └─────────────────┘        └─────────────────┘
```

### 3.2 ClaudeEngine 类设计

```typescript
// container/agent-runner/src/engines/claude-engine.ts

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEngine, EngineSession, EngineConfig, EngineMessage,
  EngineToolDefinition, EngineAgentDefinition, ContextUsage,
  EngineSendResult, EngineHooks, PreCompactEvent,
} from './types.js';
import type { StreamEvent } from '../types.js';
import { StreamEventProcessor } from '../stream-processor.js';
import { MessageStream } from '../message-stream.js'; // 从 index.ts 提取

export class ClaudeEngine implements AgentEngine {
  readonly engineType = 'anthropic' as const;

  /** 缓存的 SDK query handle（用于 getContextUsage） */
  private queryHandles = new Map<string, any>();

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
        // SDK 的 session 在 query() 调用时创建/恢复
        // 首次 system/init 事件后会更新 session.id
        transcriptPath: undefined as string | undefined,
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
    // ── 1. 将 EngineToolDefinition 转换为 SDK MCP Server ──
    const sdkTools = tools.map(t => this.toSdkTool(t));
    const mcpServer = createSdkMcpServer({
      name: 'happyclaw',
      version: '1.0.0',
      tools: sdkTools,
    });

    // ── 2. 将 EngineAgentDefinition 转换为 SDK AgentDefinition ──
    const sdkAgents = Object.fromEntries(
      agents.map(a => [a.id, this.toSdkAgent(a)]),
    );

    // ── 3. 构建 MessageStream（push-based async iterable） ──
    const messageStream = new MessageStream();
    for (const msg of messages) {
      messageStream.push(this.toSdkUserMessage(msg, session.id));
    }

    // ── 4. 初始化 StreamEventProcessor ──
    const processor = new StreamEventProcessor({
      emit: (output) => {
        if (output.streamEvent) {
          // yield 给调用方
          yieldedEvents.push(output.streamEvent);
        }
      },
      log: (msg) => console.error('[StreamEventProcessor]', msg),
    });

    // ── 5. 构建 query() options ──
    const queryOptions = this.buildQueryOptions(
      session, config, mcpServer, sdkAgents, hooks,
    );

    // ── 6. 调用 SDK query() ──
    const queryResult = await query({
      options: queryOptions,
      prompt: messageStream,
      signal,
    });

    // ── 7. for-await 消费 SDK 事件流 ──
    for await (const msg of queryResult) {
      this.handleSdkMessage(msg, session, processor);
      // 将 processor 累积的 StreamEvent yield 出去
      while (yieldedEvents.length > 0) {
        yield yieldedEvents.shift()!;
      }
    }

    // ── 8. 最终结果处理 ──
    const finalText = processor.getFinalText();
    const usage = this.extractUsage(queryResult);
    processor.cleanup();

    return {
      finalText,
      newSessionId: session.id,
      usage,
      finishReason: 'stop',
    };
  }

  async closeSession(_session: EngineSession): Promise<void> {
    // Anthropic SDK 不需要显式关闭
  }

  async getContextUsage(session: EngineSession): Promise<ContextUsage | null> {
    const handle = this.queryHandles.get(session.id);
    if (!handle?.getContextUsage) return null;
    const ctx = await handle.getContextUsage();
    return {
      totalTokens: ctx.totalTokens,
      maxTokens: ctx.maxTokens,
      percentage: ctx.percentage,
    };
  }

  // ── 私有方法 ──

  private toSdkTool(tool: EngineToolDefinition) {
    // SDK 的 tool() helper: 接受 name + description + inputSchema + handler
    // handler 返回 { content: [{type:'text', text}], isError } 格式
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (input: Record<string, unknown>) => {
        const result = await tool.handler(input);
        return {
          content: [{ type: 'text', text: result.content }],
          isError: result.isError ?? false,
        };
      },
    };
  }

  private toSdkAgent(agent: EngineAgentDefinition) {
    return {
      description: agent.description,
      prompt: agent.instructions,
      tools: agent.tools,
      model: agent.model || 'inherit',
      maxTurns: agent.maxTurns || 15,
    };
  }

  private toSdkUserMessage(msg: EngineMessage, sessionId: string) {
    // SDKUserMessage 格式: { type: 'user', message: { role, content }, parent_tool_use_id, session_id }
    const content = msg.images && msg.images.length > 0
      ? [
          { type: 'text', text: msg.content },
          ...msg.images.map(img => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mimeType as any, data: img.data },
          })),
        ]
      : msg.content;

    return {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  private buildQueryOptions(
    session: EngineSession,
    config: EngineConfig,
    mcpServer: any,
    sdkAgents: Record<string, any>,
    hooks?: EngineHooks,
  ) {
    const options: Record<string, any> = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: config.systemPromptAppend || '',
      },
      thinking: config.thinking
        ? { type: config.thinking.type, display: config.thinking.display ?? 'summarized' }
        : { type: 'adaptive', display: 'summarized' },
      permissionMode: 'bypassPermissions',
      agentProgressSummaries: true,
      skills: 'all',
      includePartialMessages: true,
      forwardSubagentText: true,
      mcpServers: { happyclaw: mcpServer },
      agents: sdkAgents,
      model: config.model,
      cwd: config.cwd,
      additionalDirectories: config.additionalDirectories,
    };

    // 会话恢复
    if (session.id) {
      options.resume = session.id;
    }

    // PreCompact 钩子
    if (hooks?.preCompact) {
      options.hooks = {
        PreCompact: [{
          hooks: [async (input: any) => {
            await hooks!.preCompact!({
              sessionId: session.id,
              agentId: input.agent_id,
              transcriptPath: input.transcript_path,
            });
            return {};
          }],
        }],
      };
    }

    return options;
  }

  private handleSdkMessage(
    msg: any,
    session: EngineSession,
    processor: StreamEventProcessor,
  ) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          // 提取 sessionId
          session.id = msg.session_id;
          session.engineState.transcriptPath = msg.transcript_path;
          processor.emitInit(msg.session_id);
        }
        processor.processSystemMessage(msg);
        break;

      case 'stream_event':
        processor.processStreamEvent(msg.stream_event);
        break;

      case 'assistant':
        processor.processAssistantMessage(msg);
        break;

      case 'user':
        processor.processMainToolResults(msg);
        processor.processSubAgentMessage(msg);
        break;

      case 'tool_progress':
        processor.processToolProgress(msg);
        break;

      case 'tool_use_summary':
        processor.processToolUseSummary(msg);
        break;

      case 'result':
        processor.processResult(msg);
        break;

      case 'rate_limit_event':
        processor.emitRateLimit(msg);
        break;

      case 'prompt_suggestion':
        processor.emitPromptSuggestion(msg);
        break;

      default:
        processor.emitRawSdkEvent(msg);
        break;
    }
  }

  private extractUsage(result: any) {
    const u = result?.usage;
    if (!u) return undefined;
    return {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadInputTokens: u.cache_read_input_tokens,
      cacheCreationInputTokens: u.cache_creation_input_tokens,
    };
  }
}
```

### 3.3 从现有 index.ts 提取的模块

| 现有模块 | 提取到 | 说明 |
|----------|--------|------|
| `MessageStream` 类 (index.ts) | `engines/message-stream.ts` | Push-based async iterable，完全通用 |
| `StreamEventProcessor` 类 | 保持原位，被 ClaudeEngine 引用 | 事件处理逻辑，Anthropic 特有 |
| `runQuery()` 函数 | 拆解到 `ClaudeEngine.sendMessage()` | 核心调用逻辑 |
| `createPreCompactHook()` | 移入 `engines/hooks/pre-compact.ts` | 对话归档 + memory flush 标记 |
| `createIpcWatcher()` / `waitForIpcMessage()` | 保持在 index.ts | IPC 通信层，与引擎无关 |

### 3.4 SDK 事件 → StreamEvent 映射（已有）

此映射由 `StreamEventProcessor` 实现，重构后保持不变，仅移入 `ClaudeEngine` 内部调用：

| SDK 消息类型 | StreamEvent | 处理位置 |
|-------------|-------------|----------|
| `system/init` | `init` + `context_audit` | index.ts 提取 sessionId |
| `stream_event` (text_delta) | `text_delta` | `processStreamEvent()` → `handleContentBlockDelta()` |
| `stream_event` (thinking_delta) | `thinking_delta` | 同上 |
| `stream_event` (tool_use start) | `tool_use_start` | `processStreamEvent()` → `handleToolUseStart()` |
| `tool_progress` | `tool_progress` | `processToolProgress()` |
| `tool_use_summary` | `tool_use_end` + `task_notification`(合成) | `processToolUseSummary()` |
| `user` (tool_result) | `tool_result` | `processMainToolResults()` |
| `system` (task_*) | `task_start/progress/notification` | `processSystemMessage()` |
| `system` (hook_*) | `hook_started/progress/response` | `processSystemMessage()` |
| `system` (compact_boundary) | `compact_boundary` | `processSystemMessage()` |
| `system` (memory_recall) | `memory_recall` | `processSystemMessage()` |
| `system` (status) | `status` | `processSystemMessage()` |
| `result` | (最终文本，不 emit StreamEvent) | `processResult()` |

---

## 4. OpenAIEngine 实现

### 4.1 OpenAI Responses API 概述

使用 `POST https://co.agentrouter.org/v1/responses`（OpenAI 最新 API，不是 `/v1/chat/completions`）：

- 支持 `previous_response_id` 实现多轮对话（类似 Anthropic 的 `resume`）
- 支持 function calling（`tools` 参数，JSON Schema）
- 支持流式输出（SSE: `text/event-stream`）
- 支持输入图像（Vision，通过 `input_image` content block）
- 支持内置工具（`web_search`、`file_search`、`code_interpreter`）

与 Anthropic SDK 的关键差异：

| 特性 | Anthropic SDK | OpenAI Responses API |
|------|---------------|---------------------|
| 工具循环 | SDK 自动处理 | **客户端手动循环** |
| 会话标识 | `session_id`（SDK 管理） | `previous_response_id`（客户端管理） |
| 上下文压缩 | SDK 自动 compact | 客户端自行截断/摘要 |
| Sub-Agent | SDK 内置 Task/Agent 工具 | 需客户端自行编排 |
| 流式事件 | `stream_event` / `system` / `result` | SSE: `response.*` 事件 |
| 思考过程 | `thinking_delta` 增量 | `reasoning` 内容块（部分模型） |

### 4.2 请求/响应格式

**请求**：

```typescript
POST /v1/responses
Content-Type: application/json
Authorization: Bearer <apiKey>

{
  "model": "gpt-5.5",
  "input": [
    {
      "role": "system",
      "content": [{ "type": "input_text", "text": "你是 HappyClaw AI 助手..." }]
    },
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "帮我查一下今天的天气" },
        // Vision 图片（可选）
        // { "type": "input_image", "image_url": "data:image/png;base64,..." }
      ]
    },
    // 工具结果回填（多轮工具循环时）
    // {
    //   "role": "tool",
    //   "tool_call_id": "fc_abc123",
    //   "content": [{ "type": "output_text", "text": "工具执行结果..." }]
    // }
  ],
  "tools": [
    {
      "type": "function",
      "name": "send_message",
      "description": "向用户/群组发送即时消息",
      "parameters": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "description": "消息内容" }
        },
        "required": ["text"]
      }
    }
  ],
  "stream": true,
  "previous_response_id": "resp_abc123",   // 多轮会话（可选）
  "max_output_tokens": 4096,
  "temperature": 1.0,
  "top_p": 1.0
}
```

**SSE 事件流**：

```
event: response.created
data: {"id": "resp_abc123", "status": "in_progress", ...}

event: response.output_text.delta
data: {"output_index": 0, "content_index": 0, "delta": "你好"}

event: response.output_text.delta
data: {"output_index": 0, "content_index": 0, "delta": "！"}

event: response.output_item.added
data: {"output_index": 0, "item": {"type": "function_call", "id": "fc_xyz", "name": "send_message", ...}}

event: response.function_call_arguments.delta
data: {"output_index": 0, "item_id": "fc_xyz", "delta": "{\"tex"}

event: response.function_call_arguments.delta
data: {"output_index": 0, "item_id": "fc_xyz", "delta": "t\":\"hello\"}"}

event: response.output_item.done
data: {"output_index": 0, "item": {"type": "function_call", "id": "fc_xyz", "name": "send_message", "arguments": "{\"text\":\"hello\"}"}}

event: response.completed
data: {"id": "resp_abc123", "status": "completed", "usage": {...}}
```

### 4.3 SSE 事件 → StreamEvent 映射

| SSE 事件 | StreamEvent | 说明 |
|----------|-------------|------|
| `response.created` | `init` | 提取 `response.id` 更新 session |
| `response.output_text.delta` | `text_delta` | 文本增量（直接 yield） |
| `response.output_text.done` | (无) | 合并到 fullTextAccumulator |
| `response.output_item.added` (function_call) | `tool_use_start` | 工具调用开始 |
| `response.function_call_arguments.delta` | (缓冲，不 emit) | 累积工具参数 JSON |
| `response.output_item.done` (function_call) | `tool_progress` | 参数解析完成，emit tool_progress |
| `response.output_item.done` (message) | (无) | 文本块完成，已通过 delta 输出 |
| `response.completed` | `usage` + `status`(completed) | Token 用量 + 完成信号 |
| `response.in_progress` | (忽略) | 中间状态，不产生 UI 事件 |
| `response.failed` | `status`(error) | 请求失败 |

### 4.4 工具调用循环

OpenAI Responses API 的工具调用需要**客户端手动循环**（与 Anthropic SDK 自动循环不同）：

```
1. 发送用户消息 + tools → 收到 SSE 流
2. 检测到 output_item.done (type=function_call)
3. 提取 function name + arguments → 调用 handler
4. 将结果作为 { role: "tool", tool_call_id, content } 加入 input
5. 再次调用 /v1/responses，带上 previous_response_id + 新 input
6. 重复直到模型不再请求 function_call 或达到 maxTurns
```

### 4.5 OpenAIEngine 类设计

```typescript
// container/agent-runner/src/engines/openai-engine.ts

import type {
  AgentEngine, EngineSession, EngineConfig, EngineMessage,
  EngineToolDefinition, EngineAgentDefinition, ContextUsage,
  EngineSendResult, EngineToolResult,
} from './types.js';
import type { StreamEvent } from '../types.js';

interface SseEvent {
  event: string;
  data: string;
}

interface ToolCallState {
  id: string;
  name: string;
  argumentsBuffer: string;
}

export class OpenAIEngine implements AgentEngine {
  readonly engineType = 'openai' as const;

  /** 最后一次 API 响应的 usage 缓存 */
  private lastUsage = new Map<string, { inputTokens: number; outputTokens: number }>();

  async createSession(
    _config: EngineConfig,
    resumeSessionId?: string,
  ): Promise<EngineSession> {
    return {
      id: resumeSessionId || '',
      engineType: 'openai',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      engineState: {
        // OpenAI 用 previous_response_id 维持多轮上下文
        // 每次 API 调用后更新为新的 response.id
        previousResponseId: resumeSessionId || undefined,
      },
    };
  }

  async *sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    _agents: EngineAgentDefinition[],  // OpenAI 不内置 Sub-Agent
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, EngineSendResult, unknown> {
    const config = session.engineState._config as EngineConfig;
    const openaiTools = tools.map(t => this.toOpenAiTool(t));
    const toolHandlers = new Map(tools.map(t => [t.name, t.handler]));

    // 构建初始 input messages
    let inputMessages = this.buildInputMessages(messages, config.systemPromptAppend);

    let fullText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turns = 0;
    const maxTurns = config.maxTurns ?? 20;

    // ── 工具循环：可能多轮 API 调用 ──
    while (turns < maxTurns) {
      turns++;

      // 构建请求体
      const requestBody: Record<string, unknown> = {
        model: config.model,
        input: inputMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        max_output_tokens: 4096,
      };

      // 多轮会话：传入 previous_response_id
      const previousResponseId = session.engineState.previousResponseId as string | undefined;
      if (previousResponseId) {
        requestBody.previous_response_id = previousResponseId;
      }

      // 发起 SSE 请求
      const response = await fetch(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      // ── 解析 SSE 流 ──
      const toolCalls: ToolCallState[] = [];
      let currentToolCall: ToolCallState | null = null;
      let textDelta = '';

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = this.parseSseEvents(buffer);
        buffer = events.remaining;

        for (const sseEvent of events.events) {
          const result = this.handleSseEvent(
            sseEvent, session, currentToolCall, toolCalls,
            toolHandlers, fullText,
          );

          if (result.textDelta) {
            textDelta += result.textDelta;
            fullText += result.textDelta;
          }

          if (result.streamEvent) {
            yield result.streamEvent;
          }

          if (result.newToolCall) {
            currentToolCall = result.newToolCall;
            toolCalls.push(currentToolCall);
          }

          if (result.usage) {
            totalInputTokens += result.usage.inputTokens;
            totalOutputTokens += result.usage.outputTokens;
            this.lastUsage.set(session.id, {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            });
          }

          if (result.finished) {
            // 更新 session.id 为最新 response.id
            session.engineState.previousResponseId = result.responseId;
            session.id = result.responseId;
          }
        }

        // 文本缓冲刷新（与 ClaudeEngine 相同策略：200 字符或 100ms）
        if (textDelta.length >= 200) {
          yield {
            eventType: 'text_delta',
            agentScope: 'main',
            text: textDelta,
            displayLevel: 'primary',
          };
          textDelta = '';
        }
      }

      // flush 剩余文本
      if (textDelta.length > 0) {
        yield {
          eventType: 'text_delta',
          agentScope: 'main',
          text: textDelta,
          displayLevel: 'primary',
        };
      }

      // ── 判断是否需要工具循环 ──
      const pendingToolCalls = toolCalls.filter(tc => tc.argumentsBuffer.length > 0);

      if (pendingToolCalls.length === 0) {
        // 模型没有请求工具调用，循环结束
        break;
      }

      // 执行工具并回填结果
      const toolResults: Array<{
        role: 'tool';
        tool_call_id: string;
        content: Array<{ type: 'output_text'; text: string }>;
      }> = [];

      for (const tc of pendingToolCalls) {
        const handler = toolHandlers.get(tc.name);
        let toolResult: EngineToolResult;

        if (handler) {
          try {
            const parsedInput = JSON.parse(tc.argumentsBuffer);
            toolResult = await handler(parsedInput);
          } catch (err) {
            toolResult = {
              content: `工具执行错误: ${(err as Error).message}`,
              isError: true,
            };
          }
        } else {
          toolResult = {
            content: `未知工具: ${tc.name}`,
            isError: true,
          };
        }

        // emit tool_use_end + tool_result
        yield {
          eventType: 'tool_use_end',
          agentScope: 'main',
          toolName: tc.name,
          toolUseId: tc.id,
          displayLevel: 'detail',
        };
        yield {
          eventType: 'tool_result',
          agentScope: 'main',
          toolName: tc.name,
          toolUseId: tc.id,
          toolResult: toolResult.content.slice(0, 400), // 截断
          displayLevel: 'detail',
        };

        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: [{ type: 'output_text', text: toolResult.content }],
        });
      }

      // 将工具结果加入下一轮 input
      // 注意：OpenAI Responses API 中 tool result 通过 input 数组追加，
      // 而不是通过 previous_response_id 自动关联
      inputMessages = [...inputMessages, ...toolResults];
    }

    if (turns >= maxTurns) {
      yield {
        eventType: 'status',
        agentScope: 'system',
        statusText: `达到最大轮次限制 (${maxTurns})`,
        displayLevel: 'debug',
      };
    }

    session.lastActivityAt = Date.now();

    return {
      finalText: fullText,
      newSessionId: session.id,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      finishReason: turns >= maxTurns ? 'max_turns' : 'stop',
    };
  }

  async closeSession(session: EngineSession): Promise<void> {
    this.lastUsage.delete(session.id);
  }

  async getContextUsage(session: EngineSession): Promise<ContextUsage | null> {
    const usage = this.lastUsage.get(session.id);
    if (!usage) return null;
    // OpenAI 不提供 context window 百分比，用固定估算
    const estimatedMax = 200_000; // 假设 200K context
    const total = usage.inputTokens + usage.outputTokens;
    return {
      totalTokens: total,
      maxTokens: estimatedMax,
      percentage: Math.round((total / estimatedMax) * 100),
    };
  }

  // ── 私有方法 ──

  private toOpenAiTool(tool: EngineToolDefinition) {
    return {
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    };
  }

  private buildInputMessages(
    messages: EngineMessage[],
    systemPromptAppend?: string,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    // System prompt（OpenAI Responses API 的 system 消息）
    if (systemPromptAppend) {
      result.push({
        role: 'system',
        content: [{ type: 'input_text', text: systemPromptAppend }],
      });
    }

    // 用户/助手消息
    for (const msg of messages) {
      if (msg.role === 'tool') {
        // tool_result 回填（由调用方传入）
        result.push({
          role: 'tool',
          tool_call_id: msg.toolUseId,
          content: [{ type: 'output_text', text: msg.content }],
        });
        continue;
      }

      const content: Array<Record<string, unknown>> = [];

      if (msg.images) {
        for (const img of msg.images) {
          content.push({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.data}`,
          });
        }
      }

      content.push({ type: 'input_text', text: msg.content });

      result.push({
        role: msg.role,
        content,
      });
    }

    return result;
  }

  private parseSseEvents(buffer: string): {
    events: SseEvent[];
    remaining: string;
  } {
    const events: SseEvent[] = [];
    const lines = buffer.split('\n');
    let currentEvent = '';
    let currentData = '';

    // 保留最后一行（可能不完整）
    const completeLines = lines.slice(0, -1);
    const remaining = lines[lines.length - 1] || '';

    for (const line of completeLines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        currentData += line.slice(6);
      } else if (line === '' && currentEvent && currentData) {
        // 空行 = 事件分隔符
        events.push({ event: currentEvent, data: currentData });
        currentEvent = '';
        currentData = '';
      }
    }

    return { events, remaining };
  }

  private handleSseEvent(
    sseEvent: SseEvent,
    session: EngineSession,
    currentToolCall: ToolCallState | null,
    _toolCalls: ToolCallState[],
    _toolHandlers: Map<string, Function>,
    _fullText: string,
  ): {
    streamEvent?: StreamEvent;
    textDelta?: string;
    newToolCall?: ToolCallState;
    usage?: { inputTokens: number; outputTokens: number };
    finished?: boolean;
    responseId?: string;
  } {
    let data: any;
    try {
      data = JSON.parse(sseEvent.data);
    } catch {
      return {};
    }

    switch (sseEvent.event) {
      case 'response.created':
        return {
          streamEvent: {
            eventType: 'init',
            agentScope: 'system',
            sessionId: data.id,
            displayLevel: 'debug',
          },
          responseId: data.id,
        };

      case 'response.output_text.delta':
        return {
          textDelta: data.delta,
        };

      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          const tc: ToolCallState = {
            id: data.item.id,
            name: data.item.name,
            argumentsBuffer: '',
          };
          return {
            newToolCall: tc,
            streamEvent: {
              eventType: 'tool_use_start',
              agentScope: 'main',
              toolName: data.item.name,
              toolUseId: data.item.id,
              displayLevel: 'detail',
            },
          };
        }
        return {};

      case 'response.function_call_arguments.delta':
        if (currentToolCall && data.item_id === currentToolCall.id) {
          currentToolCall.argumentsBuffer += data.delta;
        }
        return {};

      case 'response.output_item.done':
        if (data.item?.type === 'function_call') {
          // 参数接收完成，emit tool_progress（输入就绪）
          return {
            streamEvent: {
              eventType: 'tool_progress',
              agentScope: 'main',
              toolName: data.item.name,
              toolUseId: data.item.id,
              toolInputSummary: this.summarizeInput(data.item.arguments),
              displayLevel: 'detail',
            },
          };
        }
        return {};

      case 'response.completed':
        return {
          finished: true,
          responseId: data.id,
          usage: {
            inputTokens: data.usage?.input_tokens ?? 0,
            outputTokens: data.usage?.output_tokens ?? 0,
          },
          streamEvent: {
            eventType: 'usage',
            agentScope: 'system',
            usage: {
              inputTokens: data.usage?.input_tokens ?? 0,
              outputTokens: data.usage?.output_tokens ?? 0,
            },
            displayLevel: 'debug',
          },
        };

      case 'response.failed':
        return {
          finished: true,
          responseId: data.id,
          streamEvent: {
            eventType: 'status',
            agentScope: 'system',
            statusText: `请求失败: ${data.error?.message ?? 'unknown'}`,
            displayLevel: 'primary',
          },
        };

      default:
        return {};
    }
  }

  private summarizeInput(argsJson: string): string {
    try {
      const obj = JSON.parse(argsJson);
      // 优先提取有意义的字段
      for (const key of ['text', 'message', 'query', 'command', 'path', 'url', 'name']) {
        if (obj[key]) return String(obj[key]).slice(0, 180);
      }
      return JSON.stringify(obj).slice(0, 180);
    } catch {
      return argsJson.slice(0, 180);
    }
  }
}
```

### 4.6 OpenAI 引擎的限制

| 功能 | ClaudeEngine | OpenAIEngine | 影响 |
|------|-------------|-------------|------|
| `thinking_delta` 事件 | 原生支持 | 不产生 | 前端不显示思考过程（部分模型有 reasoning block，可后续扩展） |
| `compact_boundary` 事件 | SDK 自动 | 不产生 | 无自动压缩，需手动实现 truncation |
| `hook_*` 事件 | SDK hooks | 不产生 | PreCompact 归档不触发（需自行实现） |
| `task_start/notification` | SDK Task 工具 | 不产生 | Sub-Agent 不可用 |
| `memory_recall` | SDK 内置 | 不产生 | memory_search/get 仍可用（MCP 工具），但无自动回忆 |
| `context_audit` | SDK 提供 | 需自行合成 | 可在 `init` 事件中注入简化版 |
| Skills 自动发现 | SDK `skills: 'all'` | 需 system prompt 注入 | Skills 内容仍可被模型理解，但调用方式由 SDK 控制变为 prompt 引导 |
| 会话恢复 | `resume: sessionId` | `previous_response_id` | 语义等价，实现不同 |
| 工具循环 | SDK 自动 | 客户端手动 | 增加约 50 行循环代码 |

---

## 5. MCP 工具跨引擎复用策略

### 5.1 架构分层

```
┌────────────────────────────────────────────────────────────────┐
│              MCP Tool Business Logic (100% 复用)               │
│                                                                │
│  send_message handler:  writeIpcFile(messages/, payload)       │
│  schedule_task handler: writeIpcFile(tasks/, payload)          │
│  memory_search handler: fs.readdirSync + grep                  │
│  ... 其余 17 个工具同理                                        │
│                                                                │
│  实现位置: container/agent-runner/src/mcp-tools.ts             │
│  (重构后: 返回 EngineToolDefinition[] 通用格式)                │
└──────────────────────────┬─────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
    ┌─────────▼──────┐  ┌─▼──────────┐  ┌▼───────────────┐
    │ ClaudeEngine   │  │ OpenAI     │  │ 未来: Gemini   │
    │ SDK MCP 适配   │  │ Engine     │  │ Engine         │
    │                │  │ function   │  │ 适配           │
    │ createSdkMcp-  │  │ calling    │  │               │
    │ Server()       │  │ 适配       │  │               │
    │ (SDK 进程内)    │  │            │  │               │
    └────────────────┘  └────────────┘  └────────────────┘
```

### 5.2 重构 mcp-tools.ts

现有 `createMcpTools()` 返回 `SdkMcpToolDefinition[]`（通过 SDK 的 `tool()` 包装），重构后返回 `EngineToolDefinition[]`（通用格式）：

```typescript
// container/agent-runner/src/mcp-tools.ts (重构后)

import type { EngineToolDefinition, EngineToolResult } from './engines/types.js';
import type { McpContext } from './mcp-context.js'; // 提取到独立文件

/**
 * 创建 HappyClaw MCP 工具集（通用格式）。
 * 返回 EngineToolDefinition[]，可被任意引擎适配消费。
 */
export function createMcpTools(ctx: McpContext): EngineToolDefinition[] {
  const tools: EngineToolDefinition[] = [];

  // ── send_message ──
  tools.push({
    name: 'send_message',
    description: '向当前聊天发送一条即时消息...',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '消息内容（支持 Markdown）' },
      },
      required: ['text'],
    },
    handler: async (input) => {
      const text = String(input.text ?? '');
      const data = buildSendMessageData(text, ctx);
      await writeIpcFile(ctx.ipcMessagesDir, data);
      return { content: '消息已发送' };
    },
  });

  // ── memory_search ──
  if (!ctx.disableMemoryLayer) {
    tools.push({
      name: 'memory_search',
      description: '搜索记忆文件...',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      handler: async (input) => {
        const results = searchMemoryFiles(String(input.query), ctx);
        return { content: results };
      },
    });
  }

  // ... 其余工具同理 ...

  return tools;
}

/** 构建 send_message/send_image 的 IPC 载荷（纯函数，export 供测试） */
export function buildSendMessageData(
  text: string,
  ctx: McpContext,
): Record<string, unknown> {
  // ... 与现有实现相同 ...
}
```

### 5.3 引擎适配层

**ClaudeEngine 适配**（进程内 MCP Server）：

```typescript
// container/agent-runner/src/engines/claude-engine.ts 内部
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

function adaptToolsForClaude(tools: EngineToolDefinition[]) {
  return tools.map(t =>
    tool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      handler: async (input: any) => {
        const result = await t.handler(input);
        return {
          content: [{ type: 'text', text: result.content }],
          isError: result.isError ?? false,
        };
      },
    })
  );
}

// 使用:
const mcpServer = createSdkMcpServer({
  name: 'happyclaw',
  tools: adaptToolsForClaude(mcpTools),
});
```

**OpenAIEngine 适配**（function calling）：

```typescript
// container/agent-runner/src/engines/openai-engine.ts 内部
function adaptToolsForOpenAI(tools: EngineToolDefinition[]) {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// handler 直接在工具循环中通过 name 查找调用
const handlerMap = new Map(tools.map(t => [t.name, t.handler]));
```

### 5.4 工具清单（20 个，按条件注册）

| # | 工具名 | 始终注册 | 条件 | IPC 模式 |
|---|--------|---------|------|----------|
| 1 | `send_message` | 是 | - | fire-and-forget |
| 2 | `send_image` | 是 | - | fire-and-forget |
| 3 | `send_file` | 是 | - | fire-and-forget |
| 4 | `schedule_task` | 是 | - | fire-and-forget |
| 5 | `list_tasks` | 是 | - | request-response |
| 6 | `pause_task` | 是 | - | fire-and-forget |
| 7 | `resume_task` | 是 | - | fire-and-forget |
| 8 | `cancel_task` | 是 | - | fire-and-forget |
| 9 | `register_group` | 否 | admin only | fire-and-forget |
| 10 | `discord_get_history` | 是 | - | request-response |
| 11 | `discord_get_channel_info` | 是 | - | request-response |
| 12 | `discord_get_server_info` | 是 | - | request-response |
| 13 | `install_skill` | 否 | isHome | request-response |
| 14 | `uninstall_skill` | 否 | isHome | request-response |
| 15 | `memory_append` | 否 | isHome && !disableMemoryLayer | 本地 fs |
| 16 | `memory_search` | 否 | !disableMemoryLayer | 本地 fs |
| 17 | `memory_get` | 否 | !disableMemoryLayer | 本地 fs |
| 18 | `dispatch_background_job` | 是 | - | request-response |
| 19 | `report_progress` | 是 | - | fire-and-forget |
| 20 | `get_background_jobs` | 是 | - | request-response |

### 5.5 Skills 的跨引擎策略

| 层面 | ClaudeEngine | OpenAIEngine |
|------|-------------|-------------|
| SKILL.md 内容 | 模型理解（SDK 注入） | 模型理解（需手动注入 system prompt） |
| 符号链接发现 | entrypoint.sh 通用 | entrypoint.sh 通用 |
| 自动调用触发 | SDK `skills: 'all'` | 需自行扫描 + 注入 system prompt + 模型自行决定 |
| `allowed-tools` 语义 | SDK 强制执行 | 需在工具循环中自行校验白名单 |

**OpenAI 引擎下 Skills 注入方案**：

```typescript
// container/agent-runner/src/engines/skills-loader.ts

export function buildSkillsSystemPrompt(skillsDir: string): string {
  const skills = scanSkillDirectory(skillsDir);
  if (skills.length === 0) return '';

  const sections = skills.map(s => `
### ${s.name}
${s.description}
${s.frontmatter['user-invocable'] ? '用户可直接调用。' : ''}
${s.frontmatter['allowed-tools'] ? `允许工具: ${s.frontmatter['allowed-tools']}` : ''}

\`\`\`
${s.content}
\`\`\`
`).join('\n');

  return `## 可用技能\n\n以下是你可以使用的技能。当用户请求匹配技能描述时，按照技能说明执行。\n\n${sections}`;
}
```

---

## 6. StreamEvent Normalizer

### 6.1 设计原则

StreamEvent 以 `shared/stream-event.ts` 为**统一真相源**。每个引擎负责将自己的 wire format 翻译成 StreamEvent。翻译层称为 **Normalizer**。

```
┌──────────────────┐     ┌──────────────────┐
│ Anthropic SDK    │     │ OpenAI SSE       │
│ 原始事件          │     │ 原始事件          │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
    ┌────▼─────┐            ┌─────▼────┐
    │ Claude   │            │ OpenAI   │
    │ Normal-  │            │ Normal-  │
    │ izer     │            │ izer     │
    └────┬─────┘            └─────┬────┘
         │                        │
         └──────────┬─────────────┘
                    │
            ┌───────▼───────┐
            │   StreamEvent  │
            │   (统一格式)    │
            └───────────────┘
```

### 6.2 事件映射完整表

| StreamEvent | ClaudeEngine 来源 | OpenAIEngine 来源 | 备注 |
|-------------|------------------|-------------------|------|
| `text_delta` | `content_block_delta` (text_delta) | `response.output_text.delta` | 语义等价 |
| `thinking_delta` | `content_block_delta` (thinking_delta) | *(不产生)* | OpenAI 部分模型有 reasoning block，可扩展 |
| `tool_use_start` | `content_block_start` (tool_use) | `response.output_item.added` (function_call) | 语义等价 |
| `tool_use_end` | StreamEventProcessor 合成 | `response.output_item.done` (function_call) 后合成 | 两端都需要合成 |
| `tool_progress` | SDK `tool_progress` + input_json_delta 完成后合成 | `response.output_item.done` (function_call) 时合成 | OpenAI 端参数完整后即视为"就绪" |
| `tool_result` | 从 `user` 消息 `tool_result` block 提取 | 工具 handler 执行后合成 | OpenAI 端在工具循环中合成 |
| `hook_started` | SDK `system` subtype=hook_started | *(不产生)* | OpenAI 无 hooks 系统 |
| `hook_progress` | SDK `system` subtype=hook_progress | *(不产生)* | 同上 |
| `hook_response` | SDK `system` subtype=hook_response | *(不产生)* | 同上 |
| `task_start` | Task/Agent tool_use_start 时合成 + SDK `task_started` | *(不产生)* | OpenAI 无 Sub-Agent |
| `task_progress` | SDK `system` subtype=task_progress | *(不产生)* | 同上 |
| `task_updated` | SDK `system` subtype=task_updated | *(不产生)* | 同上 |
| `task_notification` | SDK `system` subtype + tool_use_summary 合成 | *(不产生)* | 同上 |
| `permission_denied` | SDK `system` subtype=permission_denied | *(不产生)* | OpenAI 无权限模型 |
| `memory_recall` | SDK `system` subtype=memory_recall | *(不产生)* | memory_search 工具仍可用 |
| `compact_boundary` | SDK `system` subtype=compact_boundary | *(不产生)* | OpenAI 无自动压缩 |
| `notification` | SDK `system` subtype=notification 等 | *(不产生)* | 可后续扩展 |
| `prompt_suggestion` | SDK `prompt_suggestion` 消息 | *(不产生)* | OpenAI 无此功能 |
| `raw_sdk_event` | 兜底透传 | *(不产生)* | OpenAI 事件名不同，可改为 `raw_api_event` |
| `context_audit` | 容器启动时注入 | 容器启动时注入 | 与引擎无关，由宿主侧注入 |
| `todo_update` | TodoWrite 工具输入解析 | TodoWrite 工具输入解析 | 工具 handler 层通用，引擎无关 |
| `usage` | 查询结束后合成 | `response.completed` usage 字段 | 两端均可产生 |
| `status` | SDK `system` subtype=status/api_retry | `response.created/completed/failed` | 语义略有差异 |
| `init` | SDK `system/init` 事件 | `response.created` 事件 | 语义等价 |

### 6.3 Normalizer 接口

```typescript
// container/agent-runner/src/engines/normalizer.ts

import type { StreamEvent } from '../types.js';

/**
 * StreamEvent Normalizer — 将引擎特有事件翻译为统一 StreamEvent。
 *
 * 每个引擎实现一个 Normalizer，负责：
 * 1. 累积文本/工具参数缓冲
 * 2. 控制刷新频率（200 字符 / 100ms）
 * 3. 维护工具调用的开始-结束状态追踪
 */
export interface StreamEventNormalizer {
  /** 处理引擎原始事件，返回 0~N 个 StreamEvent */
  feed(rawEvent: unknown): StreamEvent[];

  /** 强制刷新所有缓冲区（查询结束时调用） */
  flush(): StreamEvent[];

  /** 获取累积的完整文本（用于最终结果） */
  getFullText(): string;

  /** 清理所有状态 */
  reset(): void;
}
```

### 6.4 引擎特有事件的降级策略

| 特有能力 | ClaudeEngine | OpenAIEngine 降级方案 |
|----------|-------------|---------------------|
| Thinking 过程 | `thinking_delta` 实时流 | 不展示（前端对缺失事件做容错） |
| 上下文压缩 | `compact_boundary` + 自动归档 | 达到 token 阈值时手动 truncate（后续实现） |
| Sub-Agent | `task_*` 事件族 | 不支持（UI 隐藏 Sub-Agent 入口） |
| 记忆回忆 | `memory_recall` 事件 | memory_search 工具仍可手动调用 |
| 权限拒绝 | `permission_denied` 事件 | 工具 handler 自行拒绝（返回 isError） |

---

## 7. Provider engineType 扩展

### 7.1 数据模型变更

在 `UnifiedProvider` 接口中新增 `engineType` 字段：

```typescript
// src/runtime-config.ts

export interface UnifiedProvider {
  // ── 现有字段 ──
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicModel?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  customEnv: Record<string, string>;
  updatedAt: string;

  // ── 新增字段 ──
  /**
   * 引擎类型：决定 wire protocol 和 API 调用方式。
   * - 'anthropic': Anthropic Messages API（默认，向后兼容）
   * - 'openai': OpenAI Responses API（如 AgentRouter、new-api 等）
   *
   * 注意：`type` 字段仍保留用于区分官方/第三方凭据处理逻辑（如 OAuth token 刷新），
   * `engineType` 决定使用哪个 AgentEngine 实现。
   */
  engineType: 'anthropic' | 'openai';
}
```

**存储层变更**（`StoredProviderV4`）：

```typescript
// src/runtime-config.ts

export interface StoredProviderV4 {
  // ... 现有字段 ...
  engineType: 'anthropic' | 'openai';  // 加密前的明文字段
}
```

> `engineType` 不是敏感数据，不需要加密。直接存储在 `StoredProviderV4` 的明文字段中。

### 7.2 Schema 校验

```typescript
// src/schemas.ts

export const UnifiedProviderCreateSchema = z.object({
  // ... 现有字段 ...
  engineType: z
    .enum(['anthropic', 'openai'])
    .optional()
    .default('anthropic'),
});

export const UnifiedProviderPatchSchema = z.object({
  // ... 现有字段 ...
  engineType: z.enum(['anthropic', 'openai']).optional(),
});
```

### 7.3 环境变量注入

在 `src/container-runner.ts`（或 `runtime-config.ts` 的 `buildClaudeEnvLines`）中：

```typescript
// src/runtime-config.ts

export function buildContainerEnvLines(
  globalConfig: ClaudeProviderConfig,
  containerOverride: ContainerEnvOverride,
  profileCustomEnv: Record<string, string>,
  provider: UnifiedProvider,  // 新增参数
): string[] {
  const lines: string[] = [];
  const merged = mergeClaudeEnvConfig(globalConfig, containerOverride);

  // ── 注入引擎类型（agent-runner 据此选择引擎实现） ──
  lines.push(`HAPPYCLAW_ENGINE_TYPE=${provider.engineType}`);

  if (provider.engineType === 'openai') {
    // OpenAI 引擎环境变量
    const baseUrl = merged.anthropicBaseUrl || 'https://co.agentrouter.org/v1';
    const apiKey = merged.anthropicAuthToken || merged.anthropicApiKey || '';
    lines.push(`OPENAI_BASE_URL=${baseUrl}`);
    lines.push(`OPENAI_API_KEY=${apiKey}`);
    if (merged.anthropicModel) {
      lines.push(`OPENAI_MODEL=${merged.anthropicModel}`);
    }
  } else {
    // Anthropic 引擎（默认，与现有逻辑一致）
    lines.push(...buildClaudeEnvLines(merged, profileCustomEnv));
  }

  // ── customEnv 追加 ──
  if (containerOverride.customEnv) {
    for (const [key, value] of Object.entries(containerOverride.customEnv)) {
      if (!DANGEROUS_ENV_VARS.has(key)) {
        lines.push(`${key}=${value}`);
      }
    }
  }

  return lines;
}
```

### 7.4 agent-runner 侧引擎选择

```typescript
// container/agent-runner/src/engines/factory.ts

import type { AgentEngine, EngineType } from './types.js';
import { ClaudeEngine } from './claude-engine.js';
import { OpenAIEngine } from './openai-engine.js';

/**
 * 根据环境变量创建对应引擎实例。
 * 环境变量 HAPPYCLAW_ENGINE_TYPE 由宿主侧注入。
 */
export function createEngineFromEnv(): AgentEngine {
  const engineType = (process.env.HAPPYCLAW_ENGINE_TYPE || 'anthropic') as EngineType;

  switch (engineType) {
    case 'openai':
      return new OpenAIEngine();
    case 'anthropic':
    default:
      return new ClaudeEngine();
  }
}
```

### 7.5 前端表单扩展

在 Provider 配置表单中新增引擎类型选择器：

```tsx
// web/src/components/settings/ProviderEditor.tsx

<FormField>
  <label>引擎协议</label>
  <select
    value={formData.engineType || 'anthropic'}
    onChange={(e) => setFormData({ ...formData, engineType: e.target.value })}
  >
    <option value="anthropic">Anthropic Messages API</option>
    <option value="openai">OpenAI Responses API</option>
  </select>
  <p className="text-sm text-gray-500">
    选择该 Provider 使用的 API 协议。默认 Anthropic。
    AgentRouter、new-api、one-api 等同时支持两种协议的网关，
    可根据后端模型类型选择。
  </p>
</FormField>

{/* 根据 engineType 动态显示不同的字段标签 */}
{formData.engineType === 'openai' ? (
  <>
    <FormField>
      <label>Base URL</label>
      <input
        value={formData.anthropicBaseUrl || ''}
        placeholder="https://co.agentrouter.org/v1"
        onChange={...}
      />
    </FormField>
    <FormField>
      <label>API Key</label>
      <input
        type="password"
        value={formData.anthropicAuthToken || ''}
        placeholder="sk-..."
        onChange={...}
      />
    </FormField>
  </>
) : (
  /* 现有 Anthropic 字段 */
)}
```

### 7.6 Provider Pool 兼容性

`engineType` **不影响** Provider Pool 的选择逻辑：

- `providerPool.selectProvider()` 只看 `enabled`/`weight`/`healthy`，不关心 `engineType`
- `providerPool.reportSuccess/Failure` 逻辑不变
- **Sticky session** 逻辑需要扩展：当 `engineType` 不同时，session 不可复用（即使 provider_id 相同）

```typescript
// src/container-runner.ts — trySelectPoolProvider() 扩展

function isSessionCompatible(
  sessionProviderId: string,
  sessionEngineType: string,
  candidateProvider: UnifiedProvider,
): boolean {
  // provider 必须相同（原有逻辑）
  if (sessionProviderId !== candidateProvider.id) return false;
  // engineType 必须相同（新增逻辑）
  // 如果用户修改了 provider 的 engineType，旧 session 不可用
  if (sessionEngineType !== candidateProvider.engineType) return false;
  return true;
}
```

---

## 8. 会话持久化抽象

### 8.1 统一 SessionStore 接口

```typescript
// container/agent-runner/src/engines/session-store.ts

import type { EngineType } from './types.js';

/**
 * 会话持久化存储 — 统一 Anthropic 和 OpenAI 的会话管理。
 *
 * 存储位置：data/sessions/{folder}/
 *   Anthropic: .claude/ 目录（SDK 自动管理 JSONL transcript）
 *   OpenAI:    .openai/last_response_id（纯文本文件，保存最新 response.id）
 */
export interface SessionStore {
  /**
   * 保存会话 ID。
   * @param folder 群组 folder（如 'main'、'home-xxx'）
   * @param engineType 引擎类型
   * @param sessionId 会话 ID（Anthropic 的 session_id 或 OpenAI 的 response_id）
   * @param agentId Sub-Agent ID（主会话为空字符串）
   */
  save(
    folder: string,
    engineType: EngineType,
    sessionId: string,
    agentId?: string,
  ): Promise<void>;

  /**
   * 加载会话 ID。
   * @returns 会话 ID 或 null（无持久化会话时）
   */
  load(
    folder: string,
    engineType: EngineType,
    agentId?: string,
  ): Promise<string | null>;

  /**
   * 清除会话。
   */
  clear(
    folder: string,
    engineType: EngineType,
    agentId?: string,
  ): Promise<void>;
}
```

### 8.2 文件系统实现

```typescript
// container/agent-runner/src/engines/fs-session-store.ts

import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type { SessionStore } from './session-store.js';
import type { EngineType } from './types.js';

const SESSIONS_BASE = process.env.HAPPYCLAW_SESSIONS_DIR || 'data/sessions';

export class FsSessionStore implements SessionStore {

  private getSessionPath(
    folder: string,
    engineType: EngineType,
    agentId?: string,
  ): string {
    const engineDir = engineType === 'openai' ? '.openai' : '.claude';
    const base = join(SESSIONS_BASE, folder, engineDir);

    if (agentId) {
      // Sub-Agent 独立 session
      return join(base, 'agents', agentId, 'session_id');
    }
    // 主会话
    return join(base, 'session_id');
  }

  async save(
    folder: string,
    engineType: EngineType,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    const filePath = this.getSessionPath(folder, engineType, agentId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, sessionId, 'utf-8');
  }

  async load(
    folder: string,
    engineType: EngineType,
    agentId?: string,
  ): Promise<string | null> {
    const filePath = this.getSessionPath(folder, engineType, agentId);
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || null;
  }

  async clear(
    folder: string,
    engineType: EngineType,
    agentId?: string,
  ): Promise<void> {
    const filePath = this.getSessionPath(folder, engineType, agentId);
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  }
}
```

### 8.3 与现有 sessions 表的关系

现有 SQLite `sessions` 表结构：

```sql
CREATE TABLE sessions (
  group_folder TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  provider_id TEXT,
  last_used_at TEXT,
  PRIMARY KEY (group_folder, agent_id)
);
```

**扩展方案**（新增 `engine_type` 列）：

```sql
-- Migration (db.ts SCHEMA_VERSION 升级)
ALTER TABLE sessions ADD COLUMN engine_type TEXT DEFAULT 'anthropic';
```

**存储策略**：

| 场景 | sessions 表 | 文件系统 |
|------|------------|----------|
| Anthropic 主会话 | `session_id`（快速查找） | `data/sessions/{folder}/.claude/`（SDK transcript） |
| Anthropic Sub-Agent | `(folder, agentId)` 行 | `data/sessions/{folder}/.claude/agents/{agentId}/` |
| OpenAI 主会话 | `session_id` = `response.id` | `data/sessions/{folder}/.openai/session_id` |
| OpenAI Sub-Agent | *(暂不支持)* | *(暂不支持)* |

**注意**：`sessions` 表的 `session_id` 字段语义扩展为"引擎会话标识"——Anthropic 时是 SDK session_id，OpenAI 时是最新的 response_id。调用方根据 `engine_type` 列决定如何使用此值。

### 8.4 宿主侧会话管理变更

`src/container-runner.ts` 中 `trySelectPoolProvider()` 和 `runHostAgent()` 需感知 `engineType`：

```typescript
// src/container-runner.ts

async function trySelectPoolProvider(
  groupFolder: string,
  agentId: string,
): Promise<{ ... } | null> {
  // ... 现有 sticky session 检查 ...

  // 新增：检查 engineType 兼容性
  const existingSession = await getSession(groupFolder, agentId);
  if (existingSession?.engineType && existingSession.engineType !== selectedProvider.engineType) {
    // engineType 变了，清除旧 session，强制新建
    await deleteSession(groupFolder, agentId);
    return { ..., resetSession: true };
  }

  // 保存 engineType 到 sessions 表
  await setSessionProviderId(groupFolder, agentId, selectedProvider.id, selectedProvider.engineType);
}
```

`src/db.ts` 中 `setSession` / `getSession` 扩展：

```typescript
// src/db.ts

export function setSession(
  folder: string,
  sessionId: string,
  agentId: string = '',
  providerId?: string,
  engineType: string = 'anthropic',  // 新增参数
): void {
  db.prepare(`
    INSERT INTO sessions (group_folder, agent_id, session_id, provider_id, engine_type, last_used_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(group_folder, agent_id) DO UPDATE SET
      session_id = excluded.session_id,
      provider_id = excluded.provider_id,
      engine_type = excluded.engine_type,
      last_used_at = datetime('now')
  `).run(folder, agentId, sessionId, providerId, engineType);
}
```

### 8.5 会话恢复流程对比

```
Anthropic 恢复:
  getSession(folder) → sessionId
    → ContainerInput.sessionId = sessionId
    → agent-runner 内 ClaudeEngine.createSession(config, sessionId)
    → query({ options: { resume: sessionId } })
    → SDK 自动从 transcript 恢复上下文
    → system/init 事件返回新的 session_id（可能相同）

OpenAI 恢复:
  getSession(folder) → responseId (即 previous_response_id)
    → ContainerInput.sessionId = responseId
    → agent-runner 内 OpenAIEngine.createSession(config, responseId)
    → fetch('/v1/responses', { previous_response_id: responseId })
    → API 自动关联历史上下文
    → response.created 事件返回新的 response.id
```

---

## 9. 重构影响范围

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `container/agent-runner/src/engines/types.ts` | **新增** | AgentEngine 接口、EngineSession、EngineToolDefinition 等 |
| `container/agent-runner/src/engines/claude-engine.ts` | **新增** | ClaudeEngine 实现（包装现有 SDK 调用） |
| `container/agent-runner/src/engines/openai-engine.ts` | **新增** | OpenAIEngine 实现（/v1/responses + SSE） |
| `container/agent-runner/src/engines/factory.ts` | **新增** | 引擎工厂（根据 env 创建实例） |
| `container/agent-runner/src/engines/session-store.ts` | **新增** | SessionStore 接口 |
| `container/agent-runner/src/engines/fs-session-store.ts` | **新增** | 文件系统 SessionStore 实现 |
| `container/agent-runner/src/engines/message-stream.ts` | **新增** | MessageStream 类（从 index.ts 提取） |
| `container/agent-runner/src/engines/hooks/pre-compact.ts` | **新增** | PreCompact hook 实现（从 index.ts 提取） |
| `container/agent-runner/src/index.ts` | **重构** | 使用 AgentEngine 替代直接 SDK 调用 |
| `container/agent-runner/src/mcp-tools.ts` | **重构** | 返回 EngineToolDefinition[] 通用格式 |
| `container/agent-runner/src/mcp-context.ts` | **新增** | McpContext 接口提取 |
| `container/agent-runner/src/stream-processor.ts` | **保持** | 被 ClaudeEngine 内部调用，不直接暴露 |
| `src/runtime-config.ts` | **修改** | UnifiedProvider 加 engineType 字段 |
| `src/schemas.ts` | **修改** | schema 加 engineType 校验 |
| `src/container-runner.ts` | **修改** | 环境变量注入区分引擎类型 + engineType 兼容性检查 |
| `src/db.ts` | **修改** | sessions 表加 engine_type 列 + setSession 扩展 |
| `web/src/components/settings/ProviderEditor.tsx` | **修改** | Provider 表单加引擎协议下拉框 |
| `web/src/components/settings/types.ts` | **修改** | UnifiedProviderPublic 加 engineType |
| `shared/stream-event.ts` | **保持** | StreamEvent 类型不变（事件不增不减） |

---

## 10. 向后兼容保证

1. **默认值**：`engineType` 默认 `'anthropic'`，所有现有 Provider 行为不变
2. **环境变量**：未设置 `HAPPYCLAW_ENGINE_TYPE` 时，agent-runner 使用 ClaudeEngine（与重构前完全一致）
3. **StreamEvent**：类型定义不变，仅新增可选字段
4. **IPC 协议**：stdin/stdout/IPC 文件格式完全不变
5. **sessions 表**：新增 `engine_type` 列有默认值 `'anthropic'`，旧数据自动兼容
6. **MCP 工具**：工具 handler 函数体不变，仅外层包装格式变化
7. **测试**：`make test` 和 `make typecheck` 必须全绿

---

## 11. 实施路线图

### Phase 1: 接口定义 + ClaudeEngine 包装（不改变行为）

- 创建 `engines/types.ts`、`engines/claude-engine.ts`、`engines/factory.ts`
- 从 index.ts 提取 MessageStream 到 `engines/message-stream.ts`
- 重构 index.ts 使用 `createEngineFromEnv()` + `engine.sendMessage()`
- 验证：`make test` 全绿，手动测试主容器对话正常

### Phase 2: OpenAIEngine 实现

- 创建 `engines/openai-engine.ts`
- 实现 SSE 解析 + 工具循环
- 实现 `FsSessionStore`
- 验证：配置一个 OpenAI 兼容 provider，手动测试对话

### Phase 3: Provider engineType 集成

- `UnifiedProvider` 加 `engineType` 字段
- sessions 表 migration
- 前端 ProviderEditor 加下拉框
- 环境变量注入区分引擎类型
- 验证：在 UI 中切换 engineType，重启容器后生效

### Phase 4: MCP 工具通用化 + Skills 适配

- 重构 `mcp-tools.ts` 返回 `EngineToolDefinition[]`
- 实现 `buildSkillsSystemPrompt()` 用于 OpenAI 引擎
- 验证：OpenAI 引擎下所有 20 个工具可正常调用

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OpenAI 工具循环死循环 | 消耗大量 tokens | `maxTurns` 限制（默认 20），超限强制停止 |
| SSE 解析异常 | 流式中断 | try-catch 包裹 fetch + reader，错误时 emit status(error) |
| engineType 切换后旧 session 残留 | 恢复失败 | `trySelectPoolProvider` 检查 engineType 兼容性，不兼容时 deleteSession |
| NAS OOM | 服务崩溃 | OpenAIEngine 代码量约 300 行，内存增量 < 10MB；监控 NAS 内存使用 |
| 第三方 relay 不支持 Responses API | OpenAI 引擎不可用 | 在 ProviderEditor 中加提示，说明需要支持 `/v1/responses` 的 relay |
| previous_response_id 过期 | 会话恢复失败 | 捕获 404 错误，自动 fallback 到全新会话 + 历史注入（参考 `extractSessionHistory` 策略） |

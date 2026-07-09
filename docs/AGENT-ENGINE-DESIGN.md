# AgentEngine 抽象层设计文档 (B 方案)

> 为 HappyClaw 实现多模型引擎支持：当前仅 Anthropic Claude，扩展为可插拔的 AgentEngine 架构，支持 OpenAI Responses API 等任意后端。

## 1. 背景与动机

HappyClaw 当前的 agent-runner（`container/agent-runner/src/index.ts`）直接耦合 `@anthropic-ai/claude-agent-sdk`：

- `query()` 调用、`resume`/`sessionId` 管理、`system/init` 事件均为 Anthropic 特有
- MCP 工具通过 SDK 的 `createSdkMcpServer()` 注册，绑定 Anthropic wire format
- StreamEvent 类型（`thinking_delta`、`tool_use` blocks）隐含 Anthropic 假设
- Provider 池只区分 `official` / `third_party`，不区分 wire protocol

**目标**：引入 `AgentEngine` 抽象层，让 agent-runner 可以在运行时选择后端引擎，而不需要重写 IPC、MCP、会话管理等通用逻辑。

## 2. AgentEngine Interface

```typescript
// container/agent-runner/src/engines/types.ts

/** 引擎类型：决定 wire protocol 和 API 调用方式 */
export type EngineType = 'anthropic' | 'openai';

/** 引擎会话句柄 */
export interface EngineSession {
  /** 会话唯一标识。Anthropic = SDK session_id；OpenAI = previous_response_id */
  id: string;
  engineType: EngineType;
  createdAt: number;
  lastActivityAt: number;
  /** 引擎私有状态（如 OpenAI 的 response_id 链） */
  engineState?: Record<string, unknown>;
}

/** 引擎消息格式 */
export interface EngineMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 关联的 tool_use ID（用于 tool_result 回填） */
  toolUseId?: string;
  /** 图片附件（Vision 支持） */
  images?: Array<{ data: string; mimeType: string }>;
}

/** 引擎工具定义（跨引擎通用格式） */
export interface EngineToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 格式的输入定义 */
  inputSchema: Record<string, unknown>;
  /** 工具执行 handler — 返回结果字符串 */
  handler: (input: Record<string, unknown>) => Promise<string>;
}

/** 引擎 Sub-Agent 定义 */
export interface EngineAgentDefinition {
  id: string;
  description: string;
  model?: string;
  instructions: string;
}

/** 引擎配置 */
export interface EngineConfig {
  /** 模型 ID（如 'opus[1m]' 或 'gpt-5.5'） */
  model: string;
  /** API Base URL */
  baseUrl: string;
  /** API Key / Auth Token */
  apiKey: string;
  /** 工作目录 */
  cwd: string;
  /** 额外可访问目录 */
  additionalDirectories?: string[];
  /** 系统 prompt 追加内容 */
  systemPromptAppend?: string;
  /** 思考模式配置 */
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled'; display?: 'summarized' | 'hidden' };
  /** 最大 turn 数（防止无限循环） */
  maxTurns?: number;
}

/**
 * AgentEngine — 模型引擎的统一抽象。
 *
 * 每个实现负责：
 * 1. 建立和维护与模型 API 的会话
 * 2. 将模型输出转换为统一 StreamEvent
 * 3. 处理工具调用的输入/输出格式
 * 4. 管理会话持久化（sessionId / previous_response_id）
 */
export interface AgentEngine {
  readonly engineType: EngineType;

  /**
   * 创建或恢复会话。
   * @param config 引擎配置
   * @param resumeSessionId 要恢复的会话 ID（可选）
   */
  createSession(config: EngineConfig, resumeSessionId?: string): Promise<EngineSession>;

  /**
   * 发送消息并获取流式响应。
   * 返回 AsyncIterable，每次 yield 一个 StreamEvent。
   *
   * @param session 引擎会话
   * @param messages 要发送的消息（可以是单条用户消息，也可以是带 tool_result 的多轮）
   * @param tools 本次可用的工具集
   * @param agents 本次可用的 Sub-Agent
   * @param signal 中止信号
   */
  sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    agents: EngineAgentDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown>;

  /**
   * 关闭会话，清理资源。
   */
  closeSession(session: EngineSession): Promise<void>;

  /**
   * 获取当前上下文使用情况（tokens / 百分比）。
   */
  getContextUsage(session: EngineSession): Promise<ContextUsage | null>;
}

/** 上下文使用统计 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  skills?: { includedSkills: number; totalSkills: number; tokens: number };
  memoryFiles?: Array<{ path: string; type?: string; tokens?: number }>;
}
```

## 3. ClaudeEngine 实现

### 3.1 架构

```
┌─────────────────────────────────────────────────┐
│                  index.ts                       │
│  (stdin 读取 → main loop → IPC 等待)            │
└────────────────────┬────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   AgentEngine       │
          │   (interface)       │
          └──────────┬──────────┘
                     │
         ┌───────────┼───────────┐
         │                       │
  ┌──────▼──────┐        ┌──────▼──────┐
  │ ClaudeEngine│        │ OpenAIEngine│
  │  (现有逻辑)  │        │  (新实现)    │
  └──────┬──────┘        └──────┬──────┘
         │                       │
  ┌──────▼──────┐        ┌──────▼──────┐
  │ Anthropic   │        │ OpenAI      │
  │ Agent SDK   │        │ /v1/responses│
  └─────────────┘        └─────────────┘
```

### 3.2 ClaudeEngine 类设计

```typescript
// container/agent-runner/src/engines/claude-engine.ts

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEngine, EngineSession, EngineConfig, EngineMessage, EngineToolDefinition, EngineAgentDefinition, ContextUsage } from './types';
import type { StreamEvent } from '../types';

export class ClaudeEngine implements AgentEngine {
  readonly engineType = 'anthropic' as const;

  async createSession(config: EngineConfig, resumeSessionId?: string): Promise<EngineSession> {
    // Anthropic SDK 的 session 在 query() 调用时自动创建/恢复
    // 这里只返回一个占位 session，实际 ID 从 system/init 事件获取
    return {
      id: resumeSessionId || '',
      engineType: 'anthropic',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  async *sendMessage(
    session: EngineSession,
    messages: EngineMessage[],
    tools: EngineToolDefinition[],
    agents: EngineAgentDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    // 1. 构建 SDK MessageStream（push-based async iterable）
    // 2. 将 tools 转换为 SDK createSdkMcpServer 格式
    // 3. 调用 query()，for-await 处理事件
    // 4. 将 SDK 事件映射到 StreamEvent
    //    - system/init → 提取 sessionId，emit 'init'
    //    - stream_event → 透传或转换为 text_delta / thinking_delta / tool_use_*
    //    - result → emit 'status' + 最终文本
  }

  async closeSession(_session: EngineSession): Promise<void> {
    // Anthropic SDK 不需要显式关闭
  }

  async getContextUsage(session: EngineSession): Promise<ContextUsage | null> {
    // 从 SDK query handle 的 getContextUsage() 获取
    return null;
  }
}
```

### 3.3 关键映射：SDK 事件 → StreamEvent

| SDK 事件 | StreamEvent | 说明 |
|----------|-------------|------|
| `system/init` | `init` + `context_audit` | 提取 session_id |
| `stream_event` (text) | `text_delta` | 文本增量 |
| `stream_event` (thinking) | `thinking_delta` | 思考增量 |
| `stream_event` (tool_use) | `tool_use_start` / `tool_use_end` | 工具调用开始/结束 |
| `tool_progress` | `tool_progress` | 工具执行进度 |
| `result` | `status` (completed) + 文本 | 最终结果 |
| `rate_limit_event` | `status` (warning) | 限流通知 |

## 4. OpenAIEngine 实现

### 4.1 OpenAI Responses API 概述

使用 `POST https://co.agentrouter.org/v1/responses`（OpenAI 最新 API，不是 `/v1/chat/completions`）：

- 支持 `previous_response_id` 实现多轮对话（类似 Anthropic 的 `resume`）
- 支持 function calling（`tools` 参数）
- 支持流式输出（SSE: `text/event-stream`）
- 支持输入图像（Vision）

### 4.2 请求格式

```typescript
POST /v1/responses
{
  "model": "gpt-5.5",
  "input": [
    {"role": "system", "content": [{"type": "input_text", "text": "..."}]},
    {"role": "user", "content": [{"type": "input_text", "text": "你好"}]}
  ],
  "tools": [
    {
      "type": "function",
      "name": "send_message",
      "description": "...",
      "parameters": { "type": "object", "properties": {...} }
    }
  ],
  "stream": true,
  "previous_response_id": "resp_abc123"  // 多轮会话
}
```

### 4.3 SSE 事件 → StreamEvent 映射

| SSE 事件 | StreamEvent | 说明 |
|----------|-------------|------|
| `response.created` | `init` | 会话开始 |
| `response.output_text.delta` | `text_delta` | 文本增量 |
| `response.output_text.done` | (合并到最终) | 文本完成 |
| `response.function_call_arguments.delta` | 缓冲 | 工具参数增量 |
| `response.function_call_arguments.done` | `tool_use_start` | 工具调用开始 |
| `response.output_item.done` (function_call) | `tool_use_end` | 工具调用完成 |
| `response.completed` | `status` + usage | 请求完成 |
| `response.in_progress` | (忽略) | 中间状态 |

### 4.4 工具调用循环

OpenAI Responses API 的工具调用需要客户端手动循环：

```
1. 发送用户消息 + tools
2. 收到 SSE 流，包含 function_call output item
3. 提取 function name + arguments，执行工具
4. 将 tool_result 作为新的 function_call_output item
5. 再次调用 /v1/responses，带上 previous_response_id + 新的 input
6. 重复直到模型不再请求工具调用
```

这与 Anthropic SDK 的自动循环不同——ClaudeEngine 内部由 SDK 处理工具循环，OpenAIEngine 需要在引擎层自己实现。

### 4.5 previous_response_id vs sessionId

| 特性 | Anthropic | OpenAI |
|------|-----------|--------|
| 会话标识 | `session_id` (SDK 管理) | `previous_response_id` (客户端管理) |
| 持久化 | `data/sessions/{folder}/.claude/` | `data/sessions/{folder}/.openai/` |
| 恢复方式 | `resume: sessionId` 传给 SDK | `previous_response_id` 参数 |
| 上下文压缩 | SDK 自动 compact | 需客户端实现截断/摘要 |

## 5. MCP 工具跨引擎复用策略

**核心思路**：MCP 工具的业务逻辑（IPC 文件读写、数据库操作）与引擎无关，可以 100% 复用。

```
┌────────────────────────────────────────────────┐
│            MCP Tool Business Logic             │
│  (send_message, schedule_task, memory_*, ...)  │
│  实现：mcp-tools.ts 中的 handler 函数           │
└────────────────────┬───────────────────────────┘
                     │
         ┌───────────┼───────────┐
         │                       │
  ┌──────▼──────┐        ┌──────▼──────┐
  │ Anthropic   │        │ OpenAI      │
  │ SDK MCP     │        │ function     │
  │ Adapter     │        │ Adapter     │
  │             │        │              │
  │ createSdk-  │        │ 转换为      │
  │ McpServer() │        │ tools[]     │
  │ (SDK 原生)  │        │ JSON Schema │
  └─────────────┘        └─────────────┘
```

**实现方式**：

1. `mcp-tools.ts` 中的 `createMcpTools()` 返回通用的 `EngineToolDefinition[]`（已含 name/description/inputSchema/handler）
2. **ClaudeEngine**：用 `createSdkMcpServer()` 包装这些工具，传给 SDK 的 `mcpServers` 选项
3. **OpenAIEngine**：直接将 `EngineToolDefinition` 转换为 OpenAI `tools` 参数格式，handler 在引擎内部 tool loop 中调用

## 6. StreamEvent Normalizer

### 6.1 双向翻译规则

StreamEvent 以 `shared/stream-event.ts` 为**统一真相源**。每个引擎负责将自己的 wire format 翻译成 StreamEvent。

### 6.2 Anthropic → StreamEvent（已有，StreamEventProcessor 实现）

当前 `stream-processor.ts` 已经完整实现了 SDK 事件到 StreamEvent 的转换。重构后这部分逻辑移入 `ClaudeEngine` 内部。

### 6.3 OpenAI → StreamEvent（新增）

需要新增的翻译逻辑：

```typescript
// OpenAI SSE 事件处理伪代码
function handleSseEvent(event: SseEvent): StreamEvent | null {
  switch (event.type) {
    case 'response.created':
      return { eventType: 'init', agentScope: 'system', sessionId: event.response.id };
    case 'response.output_text.delta':
      return { eventType: 'text_delta', text: event.delta };
    case 'response.function_call_arguments.delta':
      // 缓冲参数，不立即发射
      bufferToolArguments(event.item_id, event.delta);
      return null;
    case 'response.output_item.done':
      if (event.item.type === 'function_call') {
        // 参数缓冲完成，发射 tool_use_start
        const call = event.item;
        return {
          eventType: 'tool_use_start',
          toolName: call.name,
          toolUseId: call.id,
          toolInputSummary: summarizeInput(call.arguments),
        };
      }
      return null;
    case 'response.completed':
      return {
        eventType: 'usage',
        usage: {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          // ...
        },
      };
  }
}
```

### 6.4 引擎特有事件的处理

| 事件 | Anthropic | OpenAI | 策略 |
|------|-----------|--------|------|
| `thinking_delta` | ✅ SDK 原生 | ❌ 不支持 | OpenAI 引擎不发射此事件 |
| `hook_started/progress/response` | ✅ SDK hooks | ❌ 不支持 | OpenAI 引擎需自行实现 PreCompact |
| `context_audit` | ✅ SDK 提供 | ⚠️ 需估算 | OpenAI 用 token usage 近似 |
| `task_start/notification` | ✅ SDK Task 工具 | ❌ 需自行实现 | 引擎层统一抽象 |

## 7. Provider engineType 扩展

### 7.1 数据模型变更

```typescript
// src/runtime-config.ts — UnifiedProvider
export interface UnifiedProvider {
  // ... 现有字段 ...
  /**
   * 引擎类型：决定 wire protocol。
   * - 'anthropic': Anthropic Messages API（默认，向后兼容）
   * - 'openai': OpenAI Responses API
   */
  engineType?: 'anthropic' | 'openai';
}
```

### 7.2 Schema 校验

```typescript
// src/schemas.ts
export const UnifiedProviderCreateSchema = z.object({
  // ... 现有字段 ...
  engineType: z.enum(['anthropic', 'openai']).optional().default('anthropic'),
});
```

### 7.3 环境变量注入

在 `src/container-runner.ts` 的环境变量构建逻辑中：

```typescript
function buildEngineEnv(provider: UnifiedProvider): Record<string, string> {
  if (provider.engineType === 'openai') {
    return {
      OPENAI_BASE_URL: provider.anthropicBaseUrl,  // 复用 baseUrl 字段
      OPENAI_API_KEY: provider.anthropicAuthToken || provider.anthropicApiKey,
      HAPPYCLAW_ENGINE_TYPE: 'openai',
    };
  }
  // 默认 anthropic
  return {
    ANTHROPIC_BASE_URL: provider.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: provider.anthropicAuthToken,
    ANTHROPIC_API_KEY: provider.anthropicApiKey,
    HAPPYCLAW_ENGINE_TYPE: 'anthropic',
  };
}
```

### 7.4 前端下拉框

在 Provider 配置表单中新增：

```tsx
<FormField>
  <label>引擎类型</label>
  <select value={provider.engineType || 'anthropic'} onChange={...}>
    <option value="anthropic">Anthropic Messages API</option>
    <option value="openai">OpenAI Responses API</option>
  </select>
  <p className="text-sm text-gray-500">
    选择该 Provider 使用的 API 协议。默认 Anthropic。
    AgentRouter 等同时支持两种协议的网关可根据模型选择。
  </p>
</FormField>
```

## 8. 会话持久化抽象

### 8.1 统一接口

```typescript
// container/agent-runner/src/engines/session-store.ts

export interface SessionStore {
  /** 保存会话 ID */
  save(folder: string, engineType: EngineType, sessionId: string): Promise<void>;
  /** 加载会话 ID */
  load(folder: string, engineType: EngineType): Promise<string | null>;
  /** 删除会话 */
  clear(folder: string, engineType: EngineType): Promise<void>;
}
```

### 8.2 存储路径

| 引擎 | 路径 | 格式 |
|------|------|------|
| Anthropic | `data/sessions/{folder}/.claude/` | SDK 自动管理 |
| OpenAI | `data/sessions/{folder}/.openai/last_response_id` | 纯文本文件 |

### 8.3 与现有 sessions 表的关系

`sessions` 表（SQLite）已有 `provider_id` 字段用于 sticky provider。新增 `engine_type` 列：

```sql
ALTER TABLE sessions ADD COLUMN engine_type TEXT DEFAULT 'anthropic';
```

## 9. 重构影响范围

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `container/agent-runner/src/engines/types.ts` | 新增 | AgentEngine 接口定义 |
| `container/agent-runner/src/engines/claude-engine.ts` | 新增 | ClaudeEngine 实现 |
| `container/agent-runner/src/engines/openai-engine.ts` | 新增 | OpenAIEngine 实现 |
| `container/agent-runner/src/index.ts` | 重构 | 使用 AgentEngine 替代直接 SDK 调用 |
| `container/agent-runner/src/stream-processor.ts` | 移动 | 事件处理逻辑移入 ClaudeEngine |
| `container/agent-runner/src/mcp-tools.ts` | 重构 | 返回 EngineToolDefinition[] 通用格式 |
| `src/runtime-config.ts` | 修改 | UnifiedProvider 加 engineType 字段 |
| `src/schemas.ts` | 修改 | schema 加 engineType 校验 |
| `src/routes/config.ts` | 修改 | API 接受 engineType |
| `src/container-runner.ts` | 修改 | 环境变量注入区分引擎类型 |
| `web/src/.../SettingsPage/` | 修改 | Provider 表单加下拉框 |
| `src/db.ts` | 修改 | sessions 表加 engine_type 列（可选） |

## 10. 向后兼容保证

1. **默认值**：`engineType` 默认 `'anthropic'`，所有现有 Provider 行为不变
2. **环境变量**：未设置 `HAPPYCLAW_ENGINE_TYPE` 时，agent-runner 使用 ClaudeEngine（与重构前完全一致）
3. **StreamEvent**：类型定义不变，仅新增可选字段
4. **IPC 协议**：stdin/stdout/IPC 文件格式完全不变
5. **测试**：`make test` 和 `make typecheck` 必须全绿

## 11. 部署与回滚

### 部署步骤

```bash
cd /home/theonlyheart/happyclaw
git checkout feat/agent-engine
make build
# 验证构建成功
make typecheck
make test
# 重启服务
systemctl --user restart happyclaw
# 冒烟测试
curl http://127.0.0.1:3100/api/health
```

### 回滚步骤

```bash
cd /home/theonlyheart/happyclaw
# 回退到重构前的 dist
cp -r dist.pre-agent-engine.20260709 dist
# 或 git 回退
git reset --hard <重构前 commit hash>
make build
systemctl --user restart happyclaw
```

### 风险点

- **OOM**：新增 OpenAIEngine 代码增加内存占用，注意 NAS 13G 内存限制
- **会话兼容**：已存在的 Anthropic 会话不受影响；切换 engineType 后旧会话不可用
- **Provider 切换**：运行中容器切换 Provider 需通过 `requestGracefulRestart` 优雅重启

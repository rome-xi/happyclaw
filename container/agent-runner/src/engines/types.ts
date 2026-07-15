/**
 * AgentEngine 统一接口定义。
 *
 * 所有模型引擎（Anthropic Claude、OpenAI 等）都实现此接口，
 * 使 agent-runner 可以在运行时切换后端而不影响上层逻辑。
 */

import type { StreamEvent } from '../stream-event.types.js';

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

/** 工具执行结果 */
export interface EngineToolResult {
  /** 结果文本内容 */
  content: string;
  /** 是否为错误结果 */
  isError?: boolean;
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
   * @param input 解析后的输入对象
   * @returns 工具结果
   */
  handler: (input: Record<string, unknown>) => Promise<EngineToolResult>;
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
  /** API Base URL */
  baseUrl: string;
  /** API Key / Auth Token */
  apiKey: string;
  /** 工作目录（用于文件操作工具） */
  cwd: string;
  /** 系统 prompt 追加内容 */
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
  /** 本 result 发出时仍未 settle 的后台任务数（异步 Agent / backgrounded Bash）。
   * >0 时 runner 不启动关流倒计时，保持 query 存活，等任务 settle 后 CLI 唤醒
   * 模型汇总。仅 ClaudeEngine 填充；OpenAIEngine 无此概念（恒 0/undefined）。 */
  pendingBgTasks?: number;
}

/** 引擎生命周期钩子 */
export interface EngineHooks {
  /**
   * 上下文压缩前钩子。
   * 仅 ClaudeEngine 触发（SDK 自动 compact）；
   * OpenAI 引擎暂不支持自动压缩。
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
   */
  createSession(config: EngineConfig, resumeSessionId?: string): Promise<EngineSession>;

  /**
   * 发送消息并获取流式响应。
   *
   * 返回 AsyncGenerator：中间事件通过 yield 发出，最终结果通过 return 返回。
   * 调用方通过 `for-await + finally` 模式消费。
   *
   * @param session 引擎会话（sendMessage 可能就地更新 session.id 和 engineState）
   * @param messages 要发送的消息
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

  /**
   * 注册引擎级别的工具集（在所有会话中可用）。
   * 与 sendMessage 的 tools 参数合并：注册的工具 + 每次调用传入的工具。
   */
  registerTools(tools: EngineToolDefinition[]): void;

  /**
   * 注册引擎级别的 Sub-Agent（在所有会话中可用）。
   * 与 sendMessage 的 agents 参数合并。
   */
  registerAgents(agents: EngineAgentDefinition[]): void;

  // ── 以下方法仅 ClaudeEngine 需要（SDK pipe-in + PreCompact flush），
  // OpenAIEngine 等引擎不实现（可选）。caller 用 optional chaining 或 typeof 判断 ──

  /** 向当前活动查询推送用户消息（IPC pipe-in）。返回错误列表（空 = 成功）。 */
  pushToActive?(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): string[];

  /** 中断当前活动查询。 */
  interruptActive?(): Promise<void>;

  /** 关闭当前活动查询的消息流。 */
  endActiveStream?(): void;

  /** 检查当前活动查询的 SDK transport 是否已就绪。 */
  isActiveTransportReady?(): boolean;

  /** 检查当前活动查询的消息流是否已结束。 */
  isActiveStreamEnded?(): boolean;

  /** 获取当前活动查询的累积文本（供 PreCompact hook flush 使用）。 */
  getActiveFullText?(): string;

  /** 重置累积文本（PreCompact hook flush 完毕后调用）。 */
  resetActiveFullText?(): void;
}

/**
 * AgentEngine 工厂 — 根据配置创建对应的引擎实例。
 */

import type { AgentEngine, EngineConfig, EngineType } from './types.js';
import { ClaudeEngine, type ClaudeEngineOptions } from './claude-engine.js';
import { OpenAIEngine, type OpenAIEngineOptions } from './openai-engine.js';

export interface CreateEngineOptions {
  engineType?: EngineType;
  claudeOptions?: ClaudeEngineOptions;
  openaiOptions?: OpenAIEngineOptions;
}

/**
 * 创建引擎实例。
 *
 * 优先级：
 * 1. 显式传入的 engineType 参数
 * 2. 环境变量 HAPPYCLAW_ENGINE_TYPE
 * 3. 默认 'anthropic'（向后兼容）
 */
export function createEngine(options: CreateEngineOptions = {}): AgentEngine {
  const envType = process.env.HAPPYCLAW_ENGINE_TYPE as EngineType | undefined;
  const engineType = options.engineType || envType || 'anthropic';

  switch (engineType) {
    case 'openai':
      return new OpenAIEngine(options.openaiOptions);
    case 'anthropic':
    default:
      return new ClaudeEngine(options.claudeOptions);
  }
}

/**
 * 从 Provider 配置创建引擎。
 */
export function createEngineFromProvider(
  provider: { engineType?: string; type?: string },
  options: CreateEngineOptions = {},
): AgentEngine {
  const engineType = (provider.engineType as EngineType) || undefined;
  return createEngine({ ...options, engineType });
}

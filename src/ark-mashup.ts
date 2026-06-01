import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * ark-mashup（多模型混搭）—— 路线 A 的核心。
 *
 * 让 host 模式工作区天然变成「opus 当 manager（官方 Claude，经字节 super-relay 透传）
 * + 豆包 ark/seed-code-0530 当 sonnet/haiku 档工人」的混搭编排，把体力活下放豆包省 Claude 额度。
 *
 * 关键事实（实测，见工作区记忆）：relay 按【模型名】决定路由，与透传 header 无关——
 *   裸 Claude 名（claude-opus-4-8）→ 透传真·Anthropic，用进程自带官方 OAuth Bearer 鉴权；
 *   ark/* 名 → 落字节豆包，用 x-relay-api-key 鉴权。
 * 所以透传 header 全局常驻不会把豆包工人请求带跑。
 *
 * 仅 host 模式可用：opus 透传依赖进程自带的官方 OAuth（CLAUDE_CONFIG_DIR 下的 .credentials.json）。
 * container 模式无 OAuth，opus 透传需另配真 API key，故此能力只在 runHostAgent 注入。
 *
 * 默认开：检测到 super-relay 配置（~/.config/super-relay/config.json，0600）即启用。
 * 没有该配置的部署自然不启用，对其他人/其他部署零影响。
 */

/** 豆包工人模型（sonnet/haiku 档映射到它，opus 档保留官方透传走硬活）。 */
const WORKER_MODEL = process.env.ARK_WORKER_MODEL || 'ark/seed-code-0530';

export interface ArkMashupEnv {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_CUSTOM_HEADERS: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
}

function relayConfigPath(): string {
  return (
    process.env.SUPER_RELAY_CONFIG ||
    path.join(os.homedir(), '.config', 'super-relay', 'config.json')
  );
}

/**
 * 读取 super-relay 配置，返回要注入给 host agent 的混搭环境变量；
 * 配置缺失 / 不完整 / 读失败时返回 null（= 不启用混搭，保持原行为）。
 *
 * 返回的 ANTHROPIC_CUSTOM_HEADERS 含【真实换行】分隔两个 header——调用方把它直接写入
 * 进程 env 字典（非经 env 文件 source），换行可安全保留。relay key 不写日志、不回显。
 */
export function getArkMashupEnv(): ArkMashupEnv | null {
  try {
    const p = relayConfigPath();
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      base_url?: string;
      api_key?: string;
    };
    const baseUrl = (cfg.base_url || '').trim();
    const key = (cfg.api_key || '').trim();
    if (!baseUrl || !key) return null;
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: `x-relay-passthrough: anthropic\nx-relay-api-key: ${key}`,
      ANTHROPIC_DEFAULT_SONNET_MODEL: WORKER_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: WORKER_MODEL,
    };
  } catch (err) {
    logger.warn({ err }, 'ark-mashup: failed to read super-relay config');
    return null;
  }
}

/** 混搭能力当前是否可用（供日志/诊断用）。 */
export function isArkMashupAvailable(): boolean {
  return getArkMashupEnv() !== null;
}

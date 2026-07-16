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

/**
 * 豆包工人模型的兜底默认值（sonnet/haiku 档映射到它，opus 档保留官方透传走硬活）。
 * 实际取值优先级见 getArkMashupEnv：env 覆盖 > config.worker_model（运行时旋钮）> 此默认。
 */
const DEFAULT_WORKER_MODEL = 'ark/seed-code-0530';

/**
 * 自有混搭网关入口(替代直连公司 super-relay)。HappyClaw 把 ANTHROPIC_BASE_URL 指向它:
 *   claude* 模型 → 网关笨透传到 api.anthropic.com(转发本进程自带 OAuth,最防封);
 *   其它模型名(如 max/high/balance/fast 档名)→ 网关转发本地 new-api 走分档/多 provider。
 * 见 ~/gateway/claude_gateway.py。可用 env ARK_GATEWAY_URL 覆盖。
 *
 * 四档体系(2026-07-15 起,替代旧 flagship/code/fast):
 *   max     —— 最强能力,硬任务(capability 策略,优先最强挂了降级)
 *   high    —— 高质量日常主力(capability)
 *   balance —— 性价比,可含 GPT/GLM(speed)
 *   fast    —— 轻活最快(speed)
 * 各档候选与选优由 HappyClaw 内置探针(src/tier-prober.ts)动态维护 new-api model_mapping。
 */
const GATEWAY_URL = process.env.ARK_GATEWAY_URL || 'http://127.0.0.1:3011';
/** 工人槽默认落"档位虚拟名"(由探针自动选每档最优);可被 config 的 per-slot 字段覆盖。 */
const DEFAULT_SONNET_TIER = 'high';
const DEFAULT_HAIKU_TIER = 'fast';

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
      worker_model?: string;
      worker_model_sonnet?: string;
      worker_model_haiku?: string;
    };
    const baseUrl = (cfg.base_url || '').trim();
    const key = (cfg.api_key || '').trim();
    if (!baseUrl || !key) return null;
    // 工人模型优先级（全部为运行时旋钮——改 JSON 即换模型，无需重编/重启，下次 agent spawn 现读生效）：
    //   通用兜底 baseWorker：env ARK_WORKER_MODEL > config.worker_model > 内置默认。
    //   注意：不回退到 cfg.model——那是另一个豆包模型（extended-thinking），语义不同。
    // 两个工人槽各自可被 per-slot 字段独立覆盖，未配则回落到 baseWorker（向后兼容旧的单旋钮行为）：
    //   sonnet 槽（“要脑子的工人”：adversarial verify / synthesize / judge）→ worker_model_sonnet
    //   haiku  槽（“体力工人”：读 / 析 / 批量转换 / 搜，扛大头）        → worker_model_haiku
    const sonnetModel =
      process.env.ARK_WORKER_MODEL_SONNET ||
      (cfg.worker_model_sonnet || '').trim() ||
      DEFAULT_SONNET_TIER;
    const haikuModel =
      process.env.ARK_WORKER_MODEL_HAIKU ||
      (cfg.worker_model_haiku || '').trim() ||
      DEFAULT_HAIKU_TIER;
    // 切到自有网关:base_url = 本地网关;CUSTOM_HEADERS 只留 x-relay-passthrough 作为
    // 「保留 OAuth」哨兵(container-runner 据此不删 session OAuth),网关会把 x-relay-* 头剥掉,
    // 不外泄、也不再把 plat key 放进 header。工人槽落档名,由探针选每档最优。
    void key; // 仍用上面的 key 非空校验确认 super-relay 配置有效;不再写进 header
    return {
      ANTHROPIC_BASE_URL: GATEWAY_URL,
      ANTHROPIC_CUSTOM_HEADERS: 'x-relay-passthrough: anthropic',
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
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

/**
 * Tier Prober — 分档自动选优探针（TS，取代游离的 gateway/tier_probe.py）。
 *
 * 由 HappyClaw host 进程内置定时运行。对每档的候选真实模型经 new-api 打 canary，
 * 测【时延 + 答对】，选出当前最优，写回该档虚拟渠道的 model_mapping。
 *
 * 四档（2026-07-15）：
 *   max     capability —— 最强能力优先，挂了才降级
 *   high    capability —— 高质量日常主力
 *   balance speed      —— 性价比（GLM/GPT 类），选最快健康者
 *   fast    speed       —— 轻活，选最快健康者
 *
 * 设计要点：
 *   - 顺序、低频、出错跳过不崩，对上游限流友好（沿用 py 版策略）。
 *   - 候选名单 / 策略集中在此文件（TIERS），改这里即改档位，无需碰 new-api UI。
 *   - 与 provider-pool 解耦：这是「档位内选真实模型」，pool 是「选哪个 provider」，两层正交。
 *   - 全程 best-effort：任何异常都只 log、不抛，绝不影响主进程。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

const NEWAPI = process.env.NEWAPI_URL || 'http://127.0.0.1:3010';
const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(),
  '.config',
  'happyclaw',
  'newapi.token',
);
const LEGACY_TOKEN_FILE = path.join(os.homedir(), 'gateway', '.newapi_token');
const TOKEN_FILE =
  process.env.NEWAPI_TOKEN_FILE ||
  (fs.existsSync(DEFAULT_TOKEN_FILE) ? DEFAULT_TOKEN_FILE : LEGACY_TOKEN_FILE);
const ADMIN_CRED =
  process.env.NEWAPI_ADMIN_CRED ||
  path.join(os.homedir(), 'new-api-data', 'ADMIN_CREDENTIALS.txt');

const CANARY_Q = 'Reply with ONLY the number, nothing else: what is 12*9?';
const CANARY_A = '108';
const PROBE_TIMEOUT_MS = 45_000;
const GAP_MS = 4_000; // 候选间隔，限流友好
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000; // 每 20 分钟一轮

type Policy = 'capability' | 'speed';
/**
 * 服务某候选模型的 new-api 源渠道名。探针选中赢家后，把 tier 渠道的 base_url+key
 * 整体切到该源渠道，实现跨上游路由（new-api 的 model_mapping 不跨渠道，见下方 applyTierUpstream）。
 */
const SRC_SUPER_RELAY = 'super-relay (字节内部)';
const SRC_CODEX_PRO = 'codex-pro';
const SRC_AGENTROUTER = 'AgentRouter opus';

export interface Candidate {
  model: string; // 探测 + 路由用的真实模型名
  src: string; // 服务该模型的 new-api 源渠道名（base_url+key 来源）
}

interface TierDef {
  channel: string; // new-api 渠道名
  tierModel: string; // 该渠道对外暴露的档位虚拟名
  order: Candidate[]; // 候选（capability 档按此为强→弱优先序）
  policy: Policy;
}

/**
 * 档位候选名单。每个候选标注其源渠道；探针选中后把 tier 渠道整体切到源渠道上游。
 *
 * 选优模型（Clash 式，2026-07-20 定稿）：**人工定池子的能力档次，机器选延迟**。
 *   - 候选名单由人工把关能力档次（如 gpt-5.6 / claude-4.6+ 这类强模型才放 max/high），
 *     同一档内的候选都视作同级能力。
 *   - 探针对每档健康候选纯选**延迟最低**者（policy=speed 全档统一），像 Clash 自动选最快节点。
 *   - 这样规避了"模型能力无法用 canary 客观测量"的问题：能力靠人工先验，延迟靠机器实测。
 *   - order 数组顺序不再表达优先级（speed 策略只看延迟），仅作为可读的候选清单。
 *
 * 2026-07-20：接入 Dennis 的 ChatGPT Pro（gpt-5.6-sol，源渠道 codex-pro=本地 proxy:19080）
 * 与 AgentRouter 的 claude-opus-4-8（源渠道 AgentRouter opus=ch#7）到 max/high 两档，
 * 与 super-relay 的 es1_orange/60b 平等竞速（方案 C）。注意 `gpt-5.6-sol`（Pro，无前缀，
 * ch#9）≠ `openai/gpt-5.6-sol`（super-relay 的字节 gpt，ch#1）——要接的是 Pro。
 *
 * 关键约束：new-api 的 model_mapping 不能跨渠道（tier 渠道 base 若不匹配赢家上游会 500/403），
 * 故探针用 applyTierUpstream：选中赢家后切 tier 渠道的 base_url+key+mapping 到源渠道。
 */
const TIERS: Record<string, TierDef> = {
  max: {
    channel: 'tier-max',
    tierModel: 'max',
    policy: 'speed',
    order: [
      { model: 'gpt-5.6-sol', src: SRC_CODEX_PRO },
      { model: 'claude-opus-4-8', src: SRC_AGENTROUTER },
      { model: 'model_hub/es1_orange_o48', src: SRC_SUPER_RELAY },
      { model: 'model_hub/es1_orange_o47', src: SRC_SUPER_RELAY },
    ],
  },
  high: {
    channel: 'tier-high',
    tierModel: 'high',
    policy: 'speed',
    order: [
      { model: 'gpt-5.6-sol', src: SRC_CODEX_PRO },
      { model: 'claude-opus-4-8', src: SRC_AGENTROUTER },
      { model: 'auto_model/60b-sota', src: SRC_SUPER_RELAY },
      { model: 'ark/60b-0614c', src: SRC_SUPER_RELAY },
      { model: 'model_hub/es1_orange_o48', src: SRC_SUPER_RELAY },
    ],
  },
  balance: {
    channel: 'tier-balance',
    tierModel: 'balance',
    policy: 'speed',
    order: [
      { model: 'model_api/experimental_0630', src: SRC_SUPER_RELAY },
      { model: 'auto_model/alwaysday1', src: SRC_SUPER_RELAY },
    ],
  },
  fast: {
    channel: 'tier-fast',
    tierModel: 'fast',
    policy: 'speed',
    order: [
      { model: 'model_api/experimental_0630', src: SRC_SUPER_RELAY },
      { model: 'auto_model/alwaysday1', src: SRC_SUPER_RELAY },
    ],
  },
};

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  correct: boolean;
}

export interface SourceChannelValidation {
  valid: boolean;
  reason?:
    | 'missing_base_url'
    | 'invalid_base_url'
    | 'missing_key'
    | 'masked_key'
    | 'disabled'
    | 'model_missing';
}

/** Validate every field that will be copied into a tier channel. */
export function validateSourceChannel(
  channel: Record<string, unknown>,
  model: string,
): SourceChannelValidation {
  const baseUrl =
    typeof channel['base_url'] === 'string' ? channel['base_url'].trim() : '';
  if (!baseUrl) return { valid: false, reason: 'missing_base_url' };
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: 'invalid_base_url' };
    }
  } catch {
    return { valid: false, reason: 'invalid_base_url' };
  }

  const key = typeof channel['key'] === 'string' ? channel['key'].trim() : '';
  if (!key) return { valid: false, reason: 'missing_key' };
  if (/\*{3,}/.test(key)) return { valid: false, reason: 'masked_key' };
  if (channel['status'] !== undefined && Number(channel['status']) !== 1) {
    return { valid: false, reason: 'disabled' };
  }

  const rawModels = channel['models'];
  const models = Array.isArray(rawModels)
    ? rawModels.map(String)
    : typeof rawModels === 'string'
      ? rawModels.split(',')
      : [];
  if (!models.map((item) => item.trim()).includes(model)) {
    return { valid: false, reason: 'model_missing' };
  }
  return { valid: true };
}

export function selectTierWinner(
  order: Candidate[],
  results: Readonly<Record<string, ProbeResult>>,
  policy: Policy,
): Candidate | null {
  const healthy = order.filter(
    (candidate) =>
      results[candidate.model]?.ok && results[candidate.model]?.correct,
  );
  if (healthy.length === 0) return null;
  if (policy === 'capability') return healthy[0];
  return healthy.reduce((best, candidate) =>
    results[best.model].latencyMs <= results[candidate.model].latencyMs
      ? best
      : candidate,
  );
}

function readToken(): string {
  if (process.env.NEWAPI_TOKEN) return process.env.NEWAPI_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

function readAdminPassword(): string {
  if (process.env.NEWAPI_ADMIN_PASSWORD) {
    return process.env.NEWAPI_ADMIN_PASSWORD;
  }
  try {
    const txt = fs.readFileSync(ADMIN_CRED, 'utf-8');
    for (const ln of txt.split('\n')) {
      if (ln.startsWith('密码:'))
        return ln.split(':').slice(1).join(':').trim();
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** 给单个真实模型打 canary。429/超时/错误 → ok=false。 */
async function probeOne(model: string, token: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${NEWAPI}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 20,
        messages: [{ role: 'user', content: CANARY_Q }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const body = (await r.json().catch(() => ({}))) as any;
    const txt = body?.choices?.[0]?.message?.content ?? '';
    if (!r.ok || !txt) {
      logger.debug(
        { model, status: r.status },
        'tier-prober: candidate bad response',
      );
      return { ok: false, latencyMs, correct: false };
    }
    const correct =
      CANARY_A === String(txt).replace(/[^0-9]/g, '') ||
      String(txt).includes(CANARY_A);
    return { ok: true, latencyMs, correct };
  } catch (err) {
    logger.debug(
      { model, err: (err as Error).message?.slice(0, 60) },
      'tier-prober: candidate error',
    );
    return { ok: false, latencyMs: 999_999, correct: false };
  }
}

// ── new-api admin：登录取 cookie，读/写渠道 model_mapping ──

async function adminLogin(): Promise<string | null> {
  const pw = readAdminPassword();
  if (!pw) {
    logger.warn('tier-prober: admin password unavailable');
    return null;
  }
  try {
    const r = await fetch(`${NEWAPI}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: pw }),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = r.headers.get('set-cookie');
    if (!r.ok || !setCookie) return null;
    // 取 session cookie 的 name=value 部分
    return setCookie.split(';')[0];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'tier-prober: admin login failed',
    );
    return null;
  }
}

async function getChannelByName(
  cookie: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    const list = await fetch(`${NEWAPI}/api/channel/?p=0&page_size=50`, {
      headers: { Cookie: cookie, 'New-Api-User': '1' },
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await list.json()) as any;
    const items = Array.isArray(d?.data) ? d.data : d?.data?.items;
    const hit = (items || []).find((c: { name: string }) => c.name === name);
    if (!hit) return null;
    const full = await fetch(`${NEWAPI}/api/channel/${hit.id}`, {
      headers: { Cookie: cookie, 'New-Api-User': '1' },
      signal: AbortSignal.timeout(15_000),
    });
    return ((await full.json()) as any)?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * 把 tier 渠道整体切到「服务赢家模型的源渠道」的上游：复制源渠道的 base_url+key，
 * 并设 model_mapping[tierModel]=winner。这是跨上游路由的正确方式——new-api 的
 * model_mapping 只在渠道自身 base_url 内改写，不跨渠道，故必须连 base+key 一起切。
 * PUT 原样回传其余字段（含 channel_info），实测保持 blob 类型不被破坏。
 */
async function applyTierUpstream(
  cookie: string,
  tierChannel: Record<string, unknown>,
  srcChannel: Record<string, unknown>,
  tierModel: string,
  winner: string,
): Promise<boolean> {
  try {
    const payload = buildTierUpdatePayload(
      tierChannel,
      srcChannel,
      tierModel,
      winner,
    );
    const r = await fetch(`${NEWAPI}/api/channel/`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'New-Api-User': '1',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok && ((await r.json()) as any)?.success === true;
  } catch {
    return false;
  }
}

/** Build a PUT payload without mutating either cached channel object. */
export function buildTierUpdatePayload(
  tierChannel: Record<string, unknown>,
  srcChannel: Record<string, unknown>,
  tierModel: string,
  winner: string,
): Record<string, unknown> {
  return {
    ...tierChannel,
    base_url: srcChannel['base_url'],
    key: srcChannel['key'],
    model_mapping: JSON.stringify({ [tierModel]: winner }),
  };
}

/** 当前赢家 = model_mapping 的值 + 当前 base_url（用于判断是否需要切换）。 */
export function currentTierState(
  channel: Record<string, unknown>,
  tierModel: string,
): { winner: string; baseUrl: string; key: string } {
  let winner = '';
  try {
    const m = JSON.parse((channel['model_mapping'] as string) || '{}');
    winner = typeof m?.[tierModel] === 'string' ? m[tierModel] : '';
  } catch {
    /* ignore */
  }
  return {
    winner,
    baseUrl: (channel['base_url'] as string) || '',
    key: (channel['key'] as string) || '',
  };
}

/** 跑一轮：探测所有档、更新映射。best-effort，不抛。 */
export async function runTierProbeOnce(): Promise<void> {
  const token = readToken();
  if (!token) {
    logger.warn('tier-prober: new-api token unavailable, skip');
    return;
  }
  const cookie = await adminLogin();
  if (!cookie) {
    logger.warn('tier-prober: no admin session, skip round');
    return;
  }

  // 源渠道缓存（按名取一次，复用其 base_url+key）
  const srcCache: Record<string, Record<string, unknown> | null> = {};
  const getSrc = async (
    name: string,
  ): Promise<Record<string, unknown> | null> => {
    if (!(name in srcCache))
      srcCache[name] = await getChannelByName(cookie, name);
    return srcCache[name];
  };

  // A raw model request can only identify its new-api channel by model name.
  // Refuse ambiguous declarations instead of probing one source and later
  // copying credentials from another. Duplicate use of the same model+source
  // across max/high is valid and is probed only once per round.
  const modelSources = new Map<string, Set<string>>();
  for (const cfg of Object.values(TIERS)) {
    for (const candidate of cfg.order) {
      const sources = modelSources.get(candidate.model) ?? new Set<string>();
      sources.add(candidate.src);
      modelSources.set(candidate.model, sources);
    }
  }

  const results: Record<string, ProbeResult> = {};
  const validatedSources = new Map<string, Record<string, unknown>>();
  const uniqueCandidates = [...modelSources.entries()];
  for (let i = 0; i < uniqueCandidates.length; i++) {
    const [model, sources] = uniqueCandidates[i];
    if (sources.size !== 1) {
      logger.warn(
        { model, sources: [...sources] },
        'tier-prober: ambiguous model ownership, skip candidate',
      );
      continue;
    }
    const src = [...sources][0];
    const srcChannel = await getSrc(src);
    if (!srcChannel) {
      logger.warn({ model, src }, 'tier-prober: source channel not found');
      continue;
    }
    const validation = validateSourceChannel(srcChannel, model);
    if (!validation.valid) {
      logger.warn(
        { model, src, reason: validation.reason },
        'tier-prober: invalid source channel, skip candidate',
      );
      continue;
    }
    validatedSources.set(`${src}\0${model}`, srcChannel);
    results[model] = await probeOne(model, token);
    if (i < uniqueCandidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    }
  }

  for (const [tier, cfg] of Object.entries(TIERS)) {
    const eligible = cfg.order.filter((candidate) =>
      validatedSources.has(`${candidate.src}\0${candidate.model}`),
    );
    const winnerCand = selectTierWinner(eligible, results, cfg.policy);
    if (!winnerCand) {
      logger.warn(
        { tier },
        'tier-prober: no healthy candidate, keep current mapping',
      );
      continue;
    }

    const tierChannel = await getChannelByName(cookie, cfg.channel);
    if (!tierChannel) {
      logger.warn(
        { tier, channel: cfg.channel },
        'tier-prober: tier channel not found',
      );
      continue;
    }
    const srcChannel = validatedSources.get(
      `${winnerCand.src}\0${winnerCand.model}`,
    );
    if (!srcChannel) continue;

    const cur = currentTierState(tierChannel, cfg.tierModel);
    const targetBase = (srcChannel['base_url'] as string) || '';
    const targetKey = (srcChannel['key'] as string) || '';
    // 赢家、上游和凭据都未变 → 无需改。key 只比较、不写日志。
    if (
      cur.winner === winnerCand.model &&
      cur.baseUrl === targetBase &&
      cur.key === targetKey
    ) {
      logger.info(
        { tier, winner: winnerCand.model },
        'tier-prober: winner unchanged',
      );
    } else {
      const ok = await applyTierUpstream(
        cookie,
        tierChannel,
        srcChannel,
        cfg.tierModel,
        winnerCand.model,
      );
      const context = {
        tier,
        winner: winnerCand.model,
        src: winnerCand.src,
        was: cur.winner,
        applied: ok,
      };
      if (ok) logger.info(context, 'tier-prober: winner updated');
      else logger.warn(context, 'tier-prober: winner update failed');
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * 启动定时探针。host 进程调用一次。gateway/new-api 不在时静默 no-op（探测失败只 log）。
 * 间隔可用 env TIER_PROBE_INTERVAL_MS 覆盖；设为 0 或负数则不启动。
 */
export function startTierProber(): void {
  const interval = parseInt(
    process.env.TIER_PROBE_INTERVAL_MS || String(DEFAULT_INTERVAL_MS),
    10,
  );
  if (!Number.isFinite(interval) || interval <= 0) {
    logger.info('tier-prober: disabled (interval<=0)');
    return;
  }
  if (timer) return;
  logger.info(
    { intervalMs: interval, tiers: Object.keys(TIERS) },
    'tier-prober: starting',
  );
  // 首轮延迟 30s，避开启动高峰
  setTimeout(() => {
    void runTierProbeOnce();
  }, 30_000);
  timer = setInterval(() => {
    void runTierProbeOnce();
  }, interval);
  timer.unref?.();
}

export function stopTierProber(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

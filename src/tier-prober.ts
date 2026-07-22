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
 *   - 候选名单 / 策略集中在 tier-catalog.ts，改那里即改档位，无需碰 new-api UI。
 *   - 与 provider-pool 解耦：这是「档位内选真实模型」，pool 是「选哪个 provider」，两层正交。
 *   - 全程 best-effort：任何异常都只 log、不抛，绝不影响主进程。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from './logger.js';
import {
  TIER_DEFINITIONS as TIERS,
  type TierCandidate as Candidate,
  type TierPolicy as Policy,
} from './tier-catalog.js';

export type { TierCandidate as Candidate } from './tier-catalog.js';

const NEWAPI = process.env.NEWAPI_URL || 'http://127.0.0.1:3010';
const TIER_GATEWAY =
  process.env.TIER_GATEWAY_URL ||
  process.env.ARK_GATEWAY_URL ||
  'http://127.0.0.1:3011';
// Loopback-only Claude CLI login sentinel, not an upstream secret. The
// gateway strips it and injects the new-api token from its 0600 token file.
const LOCAL_GATEWAY_SENTINEL = 'happyclaw-local-gateway';
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
const NEWAPI_SQLITE =
  process.env.NEWAPI_SQLITE_DB ||
  path.join(os.homedir(), 'new-api-data', 'one-api.db');

const CANARY_Q = 'Reply with ONLY the number, nothing else: what is 12*9?';
const CANARY_A = '108';
const PROBE_TIMEOUT_MS = 45_000;
const GAP_MS = 4_000; // 候选间隔，限流友好
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000; // 每 20 分钟一轮

/**
 * 档位候选名单集中在 tier-catalog.ts。每个候选显式登记源渠道、协议和上下文长度；
 * 探针选中后把 tier 渠道整体切到源渠道上游。
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

/**
 * Re-check a provisional winner twice before routing real traffic to it. The
 * worst observed latency replaces the optimistic first sample, so an endpoint
 * that is fast once but slow or rate-limited under a tiny burst is downgraded.
 * `confirmedModels` may be shared by tiers that reuse the same candidates.
 */
export async function selectStableTierWinner(
  order: Candidate[],
  results: Record<string, ProbeResult>,
  policy: Policy,
  confirm: (model: string) => Promise<ProbeResult>,
  confirmedModels = new Set<string>(),
): Promise<Candidate | null> {
  while (true) {
    const winner = selectTierWinner(order, results, policy);
    if (!winner || confirmedModels.has(winner.model)) return winner;

    const samples = [results[winner.model]];
    let stable = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      let sample: ProbeResult;
      try {
        sample = await confirm(winner.model);
      } catch {
        sample = { ok: false, correct: false, latencyMs: 999_999 };
      }
      samples.push(sample);
      if (!sample.ok || !sample.correct) stable = false;
    }
    confirmedModels.add(winner.model);
    results[winner.model] = stable
      ? {
          ok: true,
          correct: true,
          latencyMs: Math.max(...samples.map((sample) => sample.latencyMs)),
        }
      : { ok: false, correct: false, latencyMs: 999_999 };
  }
}

function readToken(): string {
  if (process.env.NEWAPI_TOKEN) return process.env.NEWAPI_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

function readAdminCredentials(): { username: string; password: string } | null {
  const envPassword = process.env.NEWAPI_ADMIN_PASSWORD?.trim();
  const envUsername = process.env.NEWAPI_ADMIN_USERNAME?.trim();
  if (envPassword) {
    return { username: envUsername || 'admin', password: envPassword };
  }
  try {
    const txt = fs.readFileSync(ADMIN_CRED, 'utf-8');
    let username = envUsername || '';
    let password = '';
    for (const ln of txt.split('\n')) {
      const separator = ln.search(/[:：]/);
      if (separator < 0) continue;
      const label = ln.slice(0, separator).trim().toLowerCase();
      const value = ln.slice(separator + 1).trim();
      if (['用户名', 'username', 'user'].includes(label)) username = value;
      if (['密码', 'password', 'pass'].includes(label)) password = value;
    }
    if (password) return { username: username || 'admin', password };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Build a canary that mirrors the real Claude CLI request shape.
 *
 * Current CLI builds append a synthetic role=system message in addition to
 * top-level system blocks. The local gateway normalises that extension before
 * an Anthropic-native relay or an OpenAI Responses adapter sees it. Keeping the
 * extension here prevents a shallow probe from approving a candidate that the
 * real workspace cannot use.
 */
export function buildTierProbeRequest(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 20,
    system: [
      {
        type: 'text',
        text: 'This is a Claude Agent SDK compatibility probe. Do not call tools.',
      },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: CANARY_Q }],
      },
      {
        role: 'system',
        content:
          'Synthetic Claude CLI context. Follow the user instruction exactly.',
      },
    ],
    tools: [
      {
        name: 'health_probe_noop',
        description: 'A no-op tool used only to verify tool schema support.',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  };
}

/** 给单个真实模型打 Agent-SDK 兼容 canary。429/超时/错误 → ok=false。 */
async function probeOne(model: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${TIER_GATEWAY}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': LOCAL_GATEWAY_SENTINEL,
        'x-relay-passthrough': 'anthropic',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildTierProbeRequest(model)),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const body = (await r.json().catch(() => ({}))) as any;
    const txt = Array.isArray(body?.content)
      ? body.content
          .filter(
            (part: { type?: string; text?: unknown }) =>
              part?.type === 'text' && typeof part.text === 'string',
          )
          .map((part: { text: string }) => part.text)
          .join('')
      : '';
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

// ── new-api admin：登录取认证头，读/写渠道 model_mapping ──

type AdminHeaders = Record<string, string>;

async function adminLogin(): Promise<AdminHeaders | null> {
  const credentials = readAdminCredentials();
  if (!credentials) {
    logger.warn('tier-prober: admin credentials unavailable');
    return null;
  }
  try {
    const r = await fetch(`${NEWAPI}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => null)) as any;
    const setCookie = r.headers.get('set-cookie');
    if (!r.ok || body?.success !== true) return null;
    const accessToken = body?.data?.access_token;
    const userId = body?.data?.user?.id ?? body?.data?.id ?? 1;
    const headers: AdminHeaders = { 'New-Api-User': String(userId) };
    if (setCookie) headers['Cookie'] = setCookie.split(';')[0];
    if (typeof accessToken === 'string' && accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return headers['Cookie'] || headers['Authorization'] ? headers : null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'tier-prober: admin login failed',
    );
    return null;
  }
}

/**
 * new-api deliberately redacts channel keys from normal list/detail responses.
 * On an all-local installation, read the selected key directly from its SQLite
 * control-plane database. The value stays in memory and is never logged.
 */
export function readChannelKeyFromSqlite(
  channelId: number,
  databasePath = NEWAPI_SQLITE,
): string {
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return '';
  if (!databasePath || !fs.existsSync(databasePath)) return '';
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    const row = database
      .prepare('SELECT key FROM channels WHERE id = ? LIMIT 1')
      .get(channelId) as { key?: unknown } | undefined;
    return typeof row?.key === 'string' ? row.key.trim() : '';
  } catch {
    return '';
  } finally {
    database?.close();
  }
}

async function getChannelByName(
  adminHeaders: AdminHeaders,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    const list = await fetch(`${NEWAPI}/api/channel/?p=0&page_size=50`, {
      headers: adminHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await list.json()) as any;
    const items = Array.isArray(d?.data) ? d.data : d?.data?.items;
    const hit = (items || []).find((c: { name: string }) => c.name === name);
    if (!hit) return null;
    const full = await fetch(`${NEWAPI}/api/channel/${hit.id}`, {
      headers: adminHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    const channel = ((await full.json()) as any)?.data;
    if (!channel || typeof channel !== 'object') return null;
    const apiKey = typeof channel.key === 'string' ? channel.key.trim() : '';
    if (apiKey && !/\*{3,}/.test(apiKey)) return channel;
    const localKey = readChannelKeyFromSqlite(Number(hit.id));
    return localKey ? { ...channel, key: localKey } : channel;
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
  adminHeaders: AdminHeaders,
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
        ...adminHeaders,
        'Content-Type': 'application/json',
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
  const adminHeaders = await adminLogin();
  if (!adminHeaders) {
    logger.warn('tier-prober: no admin session, skip round');
    return;
  }

  // 源渠道缓存（按名取一次，复用其 base_url+key）
  const srcCache: Record<string, Record<string, unknown> | null> = {};
  const getSrc = async (
    name: string,
  ): Promise<Record<string, unknown> | null> => {
    if (!(name in srcCache))
      srcCache[name] = await getChannelByName(adminHeaders, name);
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
    results[model] = await probeOne(model);
    if (i < uniqueCandidates.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    }
  }

  const confirmedModels = new Set<string>();
  for (const [tier, cfg] of Object.entries(TIERS)) {
    const eligible = cfg.order.filter((candidate) =>
      validatedSources.has(`${candidate.src}\0${candidate.model}`),
    );
    const winnerCand = await selectStableTierWinner(
      eligible,
      results,
      cfg.policy,
      async (model) => {
        // A small burst is intentional: reject providers that pass one canary
        // but immediately rate-limit normal interactive follow-up messages.
        await new Promise((resolve) => setTimeout(resolve, 500));
        return probeOne(model);
      },
      confirmedModels,
    );
    if (!winnerCand) {
      logger.warn(
        { tier },
        'tier-prober: no healthy candidate, keep current mapping',
      );
      continue;
    }

    const tierChannel = await getChannelByName(adminHeaders, cfg.channel);
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
        {
          tier,
          winner: winnerCand.model,
          protocol: winnerCand.protocol,
        },
        'tier-prober: winner unchanged',
      );
    } else {
      const ok = await applyTierUpstream(
        adminHeaders,
        tierChannel,
        srcChannel,
        cfg.tierModel,
        winnerCand.model,
      );
      const context = {
        tier,
        winner: winnerCand.model,
        src: winnerCand.src,
        protocol: winnerCand.protocol,
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

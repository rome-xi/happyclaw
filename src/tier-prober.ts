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
import { logger } from './logger.js';

const NEWAPI = process.env.NEWAPI_URL || 'http://127.0.0.1:3010';
const TOKEN_FILE = process.env.NEWAPI_TOKEN_FILE || '/home/theonlyheart/gateway/.newapi_token';
const ADMIN_CRED = process.env.NEWAPI_ADMIN_CRED || '/home/theonlyheart/new-api-data/ADMIN_CREDENTIALS.txt';

const CANARY_Q = 'Reply with ONLY the number, nothing else: what is 12*9?';
const CANARY_A = '108';
const PROBE_TIMEOUT_MS = 45_000;
const GAP_MS = 4_000; // 候选间隔，限流友好
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000; // 每 20 分钟一轮

type Policy = 'capability' | 'speed';
interface TierDef {
  channel: string; // new-api 渠道名
  tierModel: string; // 该渠道对外暴露的档位虚拟名
  order: string[]; // 候选真实模型（capability 档按此为强→弱优先序）
  policy: Policy;
}

/**
 * 档位候选名单。候选须都在 new-api 的 super-relay 上游渠道 models 列表里可路由。
 * 用 2026-07-15 实测通过的模型作初版；改此处即调整选优范围。
 */
const TIERS: Record<string, TierDef> = {
  max: {
    channel: 'tier-max', tierModel: 'max', policy: 'capability',
    order: ['model_hub/es1_orange_o48', 'model_hub/es1_orange_o47'],
  },
  high: {
    channel: 'tier-high', tierModel: 'high', policy: 'capability',
    order: ['auto_model/60b-sota', 'ark/60b-0614c', 'model_hub/es1_orange_o48'],
  },
  balance: {
    channel: 'tier-balance', tierModel: 'balance', policy: 'speed',
    order: ['opensource/glm5.2', 'auto_model/alwaysday1'],
  },
  fast: {
    channel: 'tier-fast', tierModel: 'fast', policy: 'speed',
    order: ['ark/seed-code-0608', 'auto_model/alwaysday1'],
  },
};

interface ProbeResult { ok: boolean; latencyMs: number; correct: boolean; }

function readToken(): string {
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch { return ''; }
}

function readAdminPassword(): string {
  try {
    const txt = fs.readFileSync(ADMIN_CRED, 'utf-8');
    for (const ln of txt.split('\n')) {
      if (ln.startsWith('密码:')) return ln.split(':').slice(1).join(':').trim();
    }
  } catch { /* ignore */ }
  return '';
}

/** 给单个真实模型打 canary。429/超时/错误 → ok=false。 */
async function probeOne(model: string, token: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${NEWAPI}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: CANARY_Q }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const body = (await r.json().catch(() => ({}))) as any;
    const txt = body?.choices?.[0]?.message?.content ?? '';
    if (!r.ok || !txt) {
      logger.debug({ model, status: r.status }, 'tier-prober: candidate bad response');
      return { ok: false, latencyMs, correct: false };
    }
    const correct = CANARY_A === String(txt).replace(/[^0-9]/g, '') || String(txt).includes(CANARY_A);
    return { ok: true, latencyMs, correct };
  } catch (err) {
    logger.debug({ model, err: (err as Error).message?.slice(0, 60) }, 'tier-prober: candidate error');
    return { ok: false, latencyMs: 999_999, correct: false };
  }
}

// ── new-api admin：登录取 cookie，读/写渠道 model_mapping ──

async function adminLogin(): Promise<string | null> {
  const pw = readAdminPassword();
  if (!pw) { logger.warn('tier-prober: admin password unavailable'); return null; }
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
    logger.warn({ err: (err as Error).message }, 'tier-prober: admin login failed');
    return null;
  }
}

async function getChannelByName(cookie: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const list = await fetch(`${NEWAPI}/api/channel/?p=0&page_size=50`,
      { headers: { Cookie: cookie, 'New-Api-User': '1' }, signal: AbortSignal.timeout(15_000) });
    const d = (await list.json()) as any;
    const items = Array.isArray(d?.data) ? d.data : d?.data?.items;
    const hit = (items || []).find((c: { name: string }) => c.name === name);
    if (!hit) return null;
    const full = await fetch(`${NEWAPI}/api/channel/${hit.id}`,
      { headers: { Cookie: cookie, 'New-Api-User': '1' }, signal: AbortSignal.timeout(15_000) });
    return ((await full.json()) as any)?.data ?? null;
  } catch { return null; }
}

async function setMapping(cookie: string, channel: Record<string, unknown>, tierModel: string, real: string): Promise<boolean> {
  try {
    channel['model_mapping'] = JSON.stringify({ [tierModel]: real });
    const r = await fetch(`${NEWAPI}/api/channel/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'New-Api-User': '1' },
      body: JSON.stringify(channel),
      signal: AbortSignal.timeout(15_000),
    });
    return ((await r.json()) as any)?.success === true;
  } catch { return false; }
}

function currentWinner(channel: Record<string, unknown>): string {
  try {
    const m = JSON.parse((channel['model_mapping'] as string) || '{}');
    return Object.values(m)[0] as string;
  } catch { return ''; }
}

/** 跑一轮：探测所有档、更新映射。best-effort，不抛。 */
export async function runTierProbeOnce(): Promise<void> {
  const token = readToken();
  if (!token) { logger.warn('tier-prober: new-api token unavailable, skip'); return; }
  const cookie = await adminLogin();
  if (!cookie) { logger.warn('tier-prober: no admin session, skip round'); return; }

  for (const [tier, cfg] of Object.entries(TIERS)) {
    const results: Record<string, ProbeResult> = {};
    for (const m of cfg.order) {
      results[m] = await probeOne(m, token);
      await new Promise((res) => setTimeout(res, GAP_MS));
    }
    const healthy = cfg.order.filter((m) => results[m].ok && results[m].correct);
    if (healthy.length === 0) {
      logger.warn({ tier }, 'tier-prober: no healthy candidate, keep current mapping');
      continue;
    }
    const winner = cfg.policy === 'capability'
      ? healthy[0] // order 中最强的健康者
      : healthy.reduce((a, b) => (results[a].latencyMs <= results[b].latencyMs ? a : b));

    const channel = await getChannelByName(cookie, cfg.channel);
    if (!channel) { logger.warn({ tier, channel: cfg.channel }, 'tier-prober: channel not found'); continue; }
    const cur = currentWinner(channel);
    if (cur === winner) {
      logger.info({ tier, winner }, 'tier-prober: winner unchanged');
    } else {
      const ok = await setMapping(cookie, channel, cfg.tierModel, winner);
      logger.info({ tier, winner, was: cur, applied: ok }, 'tier-prober: winner updated');
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * 启动定时探针。host 进程调用一次。gateway/new-api 不在时静默 no-op（探测失败只 log）。
 * 间隔可用 env TIER_PROBE_INTERVAL_MS 覆盖；设为 0 或负数则不启动。
 */
export function startTierProber(): void {
  const interval = parseInt(process.env.TIER_PROBE_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  if (!Number.isFinite(interval) || interval <= 0) {
    logger.info('tier-prober: disabled (interval<=0)');
    return;
  }
  if (timer) return;
  logger.info({ intervalMs: interval, tiers: Object.keys(TIERS) }, 'tier-prober: starting');
  // 首轮延迟 30s，避开启动高峰
  setTimeout(() => { void runTierProbeOnce(); }, 30_000);
  timer = setInterval(() => { void runTierProbeOnce(); }, interval);
  timer.unref?.();
}

export function stopTierProber(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

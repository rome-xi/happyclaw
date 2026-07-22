/**
 * Tier model catalog.
 *
 * Context capacity belongs to the real model, not to whichever provider or
 * protocol happens to serve it. Keeping that metadata beside every candidate
 * lets the Claude runtime derive the safe auto-compaction window for a tier
 * alias after probe-driven model switches.
 */

export const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

export type TierPolicy = 'capability' | 'speed';

export interface TierCandidate {
  /** Real model name used for probing and routing. */
  model: string;
  /** new-api source channel whose base URL and key serve this model. */
  src: string;
  /** Native protocol behind the source channel. */
  protocol: 'anthropic-messages' | 'openai-responses-adapter';
  /** Maximum supported input context, in tokens. Required for every model. */
  contextWindowTokens: number;
}

export interface TierDefinition {
  channel: string;
  tierModel: string;
  order: TierCandidate[];
  policy: TierPolicy;
  /** Reject the catalog at startup if any candidate falls below this value. */
  minimumContextWindowTokens?: number;
}

const SRC_SUPER_RELAY = 'super-relay (字节内部)';
const SRC_CODEX_PRO = 'codex-pro';
const SRC_AGENTROUTER = 'AgentRouter opus';

/**
 * Register a model here before adding it to a tier. The required context field
 * prevents a new model from silently inheriting the old 200K default.
 */
export const TIER_MODEL_CATALOG: Record<string, TierCandidate> = {
  'gpt-5.6-sol': {
    model: 'gpt-5.6-sol',
    src: SRC_CODEX_PRO,
    protocol: 'openai-responses-adapter',
    contextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
  },
  'claude-opus-4-8': {
    model: 'claude-opus-4-8',
    src: SRC_AGENTROUTER,
    protocol: 'anthropic-messages',
    contextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
  },
  'model_hub/es1_orange_o48': {
    model: 'model_hub/es1_orange_o48',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
  },
  'model_hub/es1_orange_o47': {
    model: 'model_hub/es1_orange_o47',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
  },
  'auto_model/60b-sota': {
    model: 'auto_model/60b-sota',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: 200_000,
  },
  'ark/60b-0614c': {
    model: 'ark/60b-0614c',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: 200_000,
  },
  'model_api/experimental_0630': {
    model: 'model_api/experimental_0630',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: 200_000,
  },
  'auto_model/alwaysday1': {
    model: 'auto_model/alwaysday1',
    src: SRC_SUPER_RELAY,
    protocol: 'anthropic-messages',
    contextWindowTokens: 200_000,
  },
};

const candidate = (model: string): TierCandidate => {
  const value = TIER_MODEL_CATALOG[model];
  if (!value) throw new Error(`Tier model is not registered: ${model}`);
  return value;
};

/**
 * Probe pools and their context contracts. `max` deliberately accepts only
 * one-million-token candidates; a lower-context addition fails fast instead
 * of causing surprise early compaction after the probe selects it.
 */
export const TIER_DEFINITIONS: Record<string, TierDefinition> = {
  max: {
    channel: 'tier-max',
    tierModel: 'max',
    policy: 'speed',
    minimumContextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
    order: [
      candidate('gpt-5.6-sol'),
      candidate('claude-opus-4-8'),
      candidate('model_hub/es1_orange_o48'),
      candidate('model_hub/es1_orange_o47'),
    ],
  },
  high: {
    channel: 'tier-high',
    tierModel: 'high',
    policy: 'speed',
    order: [
      candidate('gpt-5.6-sol'),
      candidate('claude-opus-4-8'),
      candidate('auto_model/60b-sota'),
      candidate('ark/60b-0614c'),
      candidate('model_hub/es1_orange_o48'),
    ],
  },
  balance: {
    channel: 'tier-balance',
    tierModel: 'balance',
    policy: 'speed',
    order: [
      candidate('model_api/experimental_0630'),
      candidate('auto_model/alwaysday1'),
    ],
  },
  fast: {
    channel: 'tier-fast',
    tierModel: 'fast',
    policy: 'speed',
    order: [
      candidate('model_api/experimental_0630'),
      candidate('auto_model/alwaysday1'),
    ],
  },
};

export function validateTierCatalog(
  tiers: Record<string, TierDefinition>,
): string[] {
  const errors: string[] = [];

  for (const [tierName, tier] of Object.entries(tiers)) {
    if (tier.order.length === 0) {
      errors.push(`${tierName}: candidate pool is empty`);
      continue;
    }

    for (const model of tier.order) {
      if (
        !Number.isSafeInteger(model.contextWindowTokens) ||
        model.contextWindowTokens <= 0
      ) {
        errors.push(`${tierName}/${model.model}: invalid context window`);
        continue;
      }
      if (
        tier.minimumContextWindowTokens !== undefined &&
        model.contextWindowTokens < tier.minimumContextWindowTokens
      ) {
        errors.push(
          `${tierName}/${model.model}: ${model.contextWindowTokens} < required ${tier.minimumContextWindowTokens}`,
        );
      }
    }
  }

  return errors;
}

export function assertTierCatalog(
  tiers: Record<string, TierDefinition> = TIER_DEFINITIONS,
): void {
  const errors = validateTierCatalog(tiers);
  if (errors.length > 0) {
    throw new Error(`Invalid tier model catalog: ${errors.join('; ')}`);
  }
}

/**
 * Resolve either a real model name or a tier alias to its safe context size.
 * A tier alias uses the smallest candidate window so probe switching can never
 * select a model with less context than the runtime advertised.
 */
export function resolveModelContextWindowTokens(
  modelOrTier: string,
): number | undefined {
  const normalized = modelOrTier.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/\[1m\]$/.test(normalized)) return ONE_MILLION_CONTEXT_TOKENS;

  const direct = Object.values(TIER_MODEL_CATALOG).find(
    (entry) => entry.model.toLowerCase() === normalized,
  );
  if (direct) return direct.contextWindowTokens;

  const tier = Object.values(TIER_DEFINITIONS).find(
    (entry) => entry.tierModel.toLowerCase() === normalized,
  );
  if (!tier || tier.order.length === 0) return undefined;
  return Math.min(...tier.order.map((entry) => entry.contextWindowTokens));
}

assertTierCatalog();

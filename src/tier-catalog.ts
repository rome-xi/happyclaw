/**
 * Configuration-driven model catalog and tier routing.
 *
 * `config/model-routing.json` is deliberately secret-free. Adding a model,
 * alias, context window, source channel, or tier candidate only requires a
 * config edit; the TypeScript prober and Python gateway both reload it.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export const ONE_MILLION_CONTEXT_TOKENS = 1_000_000;

export type TierPolicy = 'capability' | 'speed';
export type ModelProtocol = 'anthropic-messages' | 'openai-responses-adapter';

export interface TierCandidate {
  /** Real model name used for probing and routing. */
  model: string;
  /** new-api source channel whose base URL and key serve this model. */
  src: string;
  /** Native protocol behind the source channel. */
  protocol: ModelProtocol;
  /** Maximum supported input context, in tokens. */
  contextWindowTokens: number;
}

export interface ModelCatalogEntry extends TierCandidate {
  displayName: string;
  aliases: string[];
  traits: string[];
  enabled: boolean;
  manual: boolean;
}

export interface TierDefinition {
  channel: string;
  tierModel: string;
  order: TierCandidate[];
  policy: TierPolicy;
  /** Reject the catalog if any candidate falls below this value. */
  minimumContextWindowTokens?: number;
}

export interface ModelSourceDefinition {
  syncModels: boolean;
}

export interface RoutingProviderSelector {
  ids: string[];
  names: string[];
  baseUrls: string[];
}

export interface ModelRoutingConfig {
  version: 1;
  path: string;
  models: ModelCatalogEntry[];
  tiers: Record<string, TierDefinition>;
  sources: Record<string, ModelSourceDefinition>;
  routingProvider: RoutingProviderSelector;
}

export interface ResolvedModelSelection {
  kind: 'tier' | 'model';
  model: string;
  displayName: string;
  contextWindowTokens: number;
  aliases: string[];
  traits: string[];
}

interface RawModel {
  id?: unknown;
  displayName?: unknown;
  source?: unknown;
  protocol?: unknown;
  contextWindowTokens?: unknown;
  aliases?: unknown;
  traits?: unknown;
  enabled?: unknown;
  manual?: unknown;
}

interface RawTier {
  channel?: unknown;
  tierModel?: unknown;
  policy?: unknown;
  minimumContextWindowTokens?: unknown;
  models?: unknown;
}

const DEFAULT_CONFIG_PATH = path.resolve(
  process.cwd(),
  'config',
  'model-routing.json',
);

let cachedConfig: ModelRoutingConfig | null = null;
let cachedPath = '';
let cachedMtimeMs = -1;
let lastReloadWarning = '';

function routingConfigPath(): string {
  return path.resolve(
    process.env.HAPPYCLAW_MODEL_ROUTING_CONFIG || DEFAULT_CONFIG_PATH,
  );
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > 256 || /[\0\r\n,]/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`routingProvider base URL must be HTTP(S): ${value}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function parseModelRoutingConfig(
  raw: unknown,
  sourcePath = '<memory>',
): ModelRoutingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('model routing config must be an object');
  }
  const input = raw as Record<string, unknown>;
  if (input.version !== 1) {
    throw new Error(
      `unsupported model routing config version: ${input.version}`,
    );
  }
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error('models must be a non-empty array');
  }

  const models = input.models.map((item, index): ModelCatalogEntry => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`models[${index}] must be an object`);
    }
    const model = item as RawModel;
    const id = nonEmptyString(model.id, `models[${index}].id`);
    const protocol = model.protocol;
    if (
      protocol !== 'anthropic-messages' &&
      protocol !== 'openai-responses-adapter'
    ) {
      throw new Error(`${id}: unsupported protocol`);
    }
    if (
      !Number.isSafeInteger(model.contextWindowTokens) ||
      Number(model.contextWindowTokens) <= 0
    ) {
      throw new Error(`${id}: invalid contextWindowTokens`);
    }
    return {
      model: id,
      displayName:
        model.displayName === undefined
          ? id
          : nonEmptyString(model.displayName, `${id}.displayName`),
      src: nonEmptyString(model.source, `${id}.source`),
      protocol,
      contextWindowTokens: Number(model.contextWindowTokens),
      aliases: optionalStringArray(model.aliases, `${id}.aliases`),
      traits: optionalStringArray(model.traits, `${id}.traits`),
      enabled: model.enabled !== false,
      manual: model.manual !== false,
    };
  });

  const modelById = new Map<string, ModelCatalogEntry>();
  const selectionNames = new Map<string, string>();
  for (const model of models) {
    const idKey = model.model.toLowerCase();
    if (modelById.has(idKey))
      throw new Error(`duplicate model: ${model.model}`);
    modelById.set(idKey, model);
    for (const name of [model.model, ...model.aliases]) {
      const key = name.toLowerCase();
      const previous = selectionNames.get(key);
      if (previous && previous !== model.model) {
        throw new Error(`model alias collision: ${name}`);
      }
      selectionNames.set(key, model.model);
    }
  }

  const rawSources = input.sources;
  if (
    !rawSources ||
    typeof rawSources !== 'object' ||
    Array.isArray(rawSources)
  ) {
    throw new Error('sources must be an object');
  }
  const sources: Record<string, ModelSourceDefinition> = {};
  for (const [name, value] of Object.entries(rawSources)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`source ${name} must be an object`);
    }
    sources[nonEmptyString(name, 'source name')] = {
      syncModels: (value as Record<string, unknown>).syncModels === true,
    };
  }
  for (const model of models) {
    if (!sources[model.src]) {
      throw new Error(`${model.model}: unknown source channel ${model.src}`);
    }
  }

  const rawTiers = input.tiers;
  if (!rawTiers || typeof rawTiers !== 'object' || Array.isArray(rawTiers)) {
    throw new Error('tiers must be an object');
  }
  const tiers: Record<string, TierDefinition> = {};
  for (const [tierNameRaw, value] of Object.entries(rawTiers)) {
    const tierName = nonEmptyString(tierNameRaw, 'tier name');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${tierName}: tier must be an object`);
    }
    const tier = value as RawTier;
    const policy = tier.policy;
    if (policy !== 'capability' && policy !== 'speed') {
      throw new Error(`${tierName}: invalid policy`);
    }
    if (!Array.isArray(tier.models) || tier.models.length === 0) {
      throw new Error(`${tierName}: candidate pool is empty`);
    }
    const order = tier.models.map((modelName, index) => {
      const id = nonEmptyString(modelName, `${tierName}.models[${index}]`);
      const model = modelById.get(id.toLowerCase());
      if (!model) throw new Error(`${tierName}: unknown model ${id}`);
      if (!model.enabled) throw new Error(`${tierName}: disabled model ${id}`);
      return {
        model: model.model,
        src: model.src,
        protocol: model.protocol,
        contextWindowTokens: model.contextWindowTokens,
      } satisfies TierCandidate;
    });
    const minimum = tier.minimumContextWindowTokens;
    if (
      minimum !== undefined &&
      (!Number.isSafeInteger(minimum) || Number(minimum) <= 0)
    ) {
      throw new Error(`${tierName}: invalid minimumContextWindowTokens`);
    }
    tiers[tierName] = {
      channel: nonEmptyString(tier.channel, `${tierName}.channel`),
      tierModel: nonEmptyString(tier.tierModel, `${tierName}.tierModel`),
      policy,
      order,
      ...(minimum === undefined
        ? {}
        : { minimumContextWindowTokens: Number(minimum) }),
    };
  }

  const validationErrors = validateTierCatalog(tiers);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('; '));
  }

  // Tier names and tierModel aliases share the same command namespace as
  // model aliases. Ambiguity would make `/model foo` non-deterministic.
  const tierAliases = new Map<string, string>();
  for (const [tierName, tier] of Object.entries(tiers)) {
    for (const alias of [tierName, tier.tierModel]) {
      const key = alias.toLowerCase();
      if (selectionNames.has(key)) {
        throw new Error(`tier alias collides with model alias: ${alias}`);
      }
      const previous = tierAliases.get(key);
      if (previous && previous !== tierName) {
        throw new Error(`tier alias collision: ${alias}`);
      }
      tierAliases.set(key, tierName);
    }
  }

  const providerRaw =
    input.routingProvider &&
    typeof input.routingProvider === 'object' &&
    !Array.isArray(input.routingProvider)
      ? (input.routingProvider as Record<string, unknown>)
      : {};
  const routingProvider: RoutingProviderSelector = {
    ids: optionalStringArray(providerRaw.ids, 'routingProvider.ids'),
    names: optionalStringArray(providerRaw.names, 'routingProvider.names'),
    baseUrls: optionalStringArray(
      providerRaw.baseUrls,
      'routingProvider.baseUrls',
    ).map(normalizeBaseUrl),
  };
  if (
    routingProvider.ids.length === 0 &&
    routingProvider.names.length === 0 &&
    routingProvider.baseUrls.length === 0
  ) {
    throw new Error('routingProvider needs at least one id, name, or baseUrl');
  }

  return {
    version: 1,
    path: sourcePath,
    models,
    tiers,
    sources,
    routingProvider,
  };
}

export function loadModelRoutingConfigFromFile(
  filePath: string,
): ModelRoutingConfig {
  const absolute = path.resolve(filePath);
  return parseModelRoutingConfig(
    JSON.parse(fs.readFileSync(absolute, 'utf8')),
    absolute,
  );
}

/** Reload on mtime change; retain the last known-good config on bad edits. */
export function getModelRoutingConfig(): ModelRoutingConfig {
  const filePath = routingConfigPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch (error) {
    if (cachedConfig) return cachedConfig;
    throw new Error(`Cannot read model routing config ${filePath}: ${error}`);
  }
  if (cachedConfig && cachedPath === filePath && cachedMtimeMs === mtimeMs) {
    return cachedConfig;
  }
  try {
    const next = loadModelRoutingConfigFromFile(filePath);
    cachedConfig = next;
    cachedPath = filePath;
    cachedMtimeMs = mtimeMs;
    lastReloadWarning = '';
    return next;
  } catch (error) {
    if (!cachedConfig) throw error;
    const warning = error instanceof Error ? error.message : String(error);
    if (warning !== lastReloadWarning) {
      lastReloadWarning = warning;
      logger.warn(
        { filePath, error: warning },
        'Invalid model routing edit; keeping last known-good config',
      );
    }
    return cachedConfig;
  }
}

export function getTierDefinitions(): Record<string, TierDefinition> {
  return getModelRoutingConfig().tiers;
}

export function getModelCatalog(): ModelCatalogEntry[] {
  return getModelRoutingConfig().models;
}

/** Backward-compatible startup snapshots; dynamic callers use getters above. */
export const TIER_DEFINITIONS = getTierDefinitions();
export const TIER_MODEL_CATALOG: Record<string, TierCandidate> =
  Object.fromEntries(
    getModelCatalog().map((entry) => [entry.model, { ...entry }]),
  );

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
      } else if (
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
  tiers: Record<string, TierDefinition> = getTierDefinitions(),
): void {
  const errors = validateTierCatalog(tiers);
  if (errors.length > 0) {
    throw new Error(`Invalid tier model catalog: ${errors.join('; ')}`);
  }
}

export function resolveModelSelection(
  input: string,
): ResolvedModelSelection | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  const config = getModelRoutingConfig();

  for (const [tierName, tier] of Object.entries(config.tiers)) {
    if (
      tierName.toLowerCase() === normalized ||
      tier.tierModel.toLowerCase() === normalized
    ) {
      return {
        kind: 'tier',
        model: tier.tierModel,
        displayName: `${tierName}（自动选优）`,
        contextWindowTokens: Math.min(
          ...tier.order.map((entry) => entry.contextWindowTokens),
        ),
        aliases: tierName === tier.tierModel ? [] : [tierName],
        traits: ['auto-probe', tier.policy],
      };
    }
  }

  const model = config.models.find(
    (entry) =>
      entry.enabled &&
      entry.manual &&
      [entry.model, ...entry.aliases].some(
        (name) => name.toLowerCase() === normalized,
      ),
  );
  if (!model) return undefined;
  return {
    kind: 'model',
    model: model.model,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    aliases: model.aliases,
    traits: model.traits,
  };
}

/** Resolve a real model or tier alias to a safe compaction window. */
export function resolveModelContextWindowTokens(
  modelOrTier: string,
): number | undefined {
  const normalized = modelOrTier.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/\[1m\]$/.test(normalized)) return ONE_MILLION_CONTEXT_TOKENS;
  return resolveModelSelection(modelOrTier)?.contextWindowTokens;
}

assertTierCatalog();

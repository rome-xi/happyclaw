/** Workspace-level manual model selection and user-facing catalog output. */
import { deleteRouterState, getRouterState, setRouterState } from './db.js';
import {
  getModelRoutingConfig,
  resolveModelSelection,
  type ResolvedModelSelection,
} from './tier-catalog.js';

const MODEL_OVERRIDE_KEY_PREFIX = 'workspace_model_override:';

function stateKey(folder: string): string {
  return `${MODEL_OVERRIDE_KEY_PREFIX}${encodeURIComponent(folder)}`;
}

export function getWorkspaceModelOverride(folder: string): string | undefined {
  const stored = getRouterState(stateKey(folder))?.trim();
  if (!stored) return undefined;
  // A config edit may disable/remove a previously selected model. Do not send
  // an unknown name upstream; treat it as auto until the operator fixes it.
  return resolveModelSelection(stored)?.model;
}

export function setWorkspaceModelOverride(folder: string, model: string): void {
  const resolved = resolveModelSelection(model);
  if (!resolved) throw new Error(`Unknown configured model: ${model}`);
  setRouterState(stateKey(folder), resolved.model);
}

export function clearWorkspaceModelOverride(folder: string): void {
  deleteRouterState(stateKey(folder));
}

export function resolveWorkspaceModel(
  folder: string,
): ResolvedModelSelection | undefined {
  const selected = getWorkspaceModelOverride(folder);
  return selected ? resolveModelSelection(selected) : undefined;
}

export interface RoutingProviderLike {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  enabled: boolean;
}

function comparableBaseUrl(value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase();
  }
}

/** Select the enabled provider that exposes the mixed-protocol gateway. */
export function findConfiguredRoutingProvider<T extends RoutingProviderLike>(
  providers: T[],
): T | undefined {
  const selector = getModelRoutingConfig().routingProvider;
  const ids = new Set(selector.ids);
  const names = new Set(selector.names.map((name) => name.toLowerCase()));
  const baseUrls = new Set(selector.baseUrls.map(comparableBaseUrl));
  return providers.find(
    (provider) =>
      provider.enabled &&
      (ids.has(provider.id) ||
        names.has(provider.name.toLowerCase()) ||
        baseUrls.has(comparableBaseUrl(provider.anthropicBaseUrl))),
  );
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return String(tokens);
}

export function formatWorkspaceModelStatus(folder: string): string {
  const selected = resolveWorkspaceModel(folder);
  if (!selected) {
    return '当前模型：auto（由 provider 与实时探针自动选优）';
  }
  return `当前模型：${selected.displayName}\n路由名：${selected.model} · 上下文 ${formatContext(selected.contextWindowTokens)}`;
}

export function formatModelCatalog(folder: string): string {
  const config = getModelRoutingConfig();
  const lines = [formatWorkspaceModelStatus(folder), '', '自动档位：'];
  for (const [name, tier] of Object.entries(config.tiers)) {
    const context = Math.min(
      ...tier.order.map((model) => model.contextWindowTokens),
    );
    lines.push(
      `- ${name} · ${formatContext(context)} · ${tier.order.length} 个候选`,
    );
  }
  lines.push('', '可手动指定（括号内是短别名）：');
  for (const model of config.models) {
    if (!model.enabled || !model.manual) continue;
    const aliases = model.aliases.length
      ? `（${model.aliases.join(' / ')}）`
      : '';
    const traits = model.traits.length ? ` · ${model.traits.join('/')}` : '';
    lines.push(
      `- ${model.displayName} ${aliases}\n  ${model.model} · ${formatContext(model.contextWindowTokens)}${traits}`,
    );
  }
  lines.push(
    '',
    '用法：/model <档位、模型名或别名>；/model auto 恢复自动；/model status 查看当前值。',
  );
  return lines.join('\n');
}

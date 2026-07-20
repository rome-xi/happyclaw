export const CLAUDE_ENDPOINT_KIND_ENV = 'HAPPYCLAW_CLAUDE_ENDPOINT_KIND';

export type ClaudeEndpointKind = 'official' | 'custom';

export interface ClaudeProviderRuntime {
  endpointKind: ClaudeEndpointKind;
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
  missingRequiredModel: boolean;
}

/** Resolve the model contract once at runner startup. */
export function resolveClaudeProviderRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProviderRuntime {
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const marker = env[CLAUDE_ENDPOINT_KIND_ENV]?.trim().toLowerCase();
  const endpointKind: ClaudeEndpointKind =
    marker === 'official' || marker === 'custom'
      ? marker
      : env.ANTHROPIC_BASE_URL?.trim()
        ? 'custom'
        : 'official';

  return {
    endpointKind,
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
    missingRequiredModel: endpointKind === 'custom' && !model,
  };
}

import { describe, expect, test } from 'vitest';

import { resolveClaudeProviderRuntime } from '../container/agent-runner/src/provider-runtime.js';

describe('agent runner provider runtime', () => {
  test('allows official Claude to use the SDK default model', () => {
    expect(
      resolveClaudeProviderRuntime({
        HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      }),
    ).toMatchObject({
      endpointKind: 'official',
      model: '',
      queryModelOptions: {},
      usageModelKey: 'default',
      missingRequiredModel: false,
    });
  });

  test('requires a model for custom endpoints', () => {
    expect(
      resolveClaudeProviderRuntime({
        ANTHROPIC_BASE_URL: 'https://relay.test',
      }),
    ).toMatchObject({ endpointKind: 'custom', missingRequiredModel: true });
  });

  test('prefers the authoritative endpoint marker', () => {
    expect(
      resolveClaudeProviderRuntime({
        HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official',
        ANTHROPIC_BASE_URL: 'https://inherited.example',
        ANTHROPIC_MODEL: 'opus',
      }),
    ).toMatchObject({
      endpointKind: 'official',
      queryModelOptions: { model: 'opus' },
      missingRequiredModel: false,
    });
  });
});

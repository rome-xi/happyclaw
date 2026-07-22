import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  buildContainerEnvLines,
  clearInheritedProviderEnv,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

const NO_CUSTOM_ENV: Record<string, string> = {};

function config(patch: Partial<ClaudeProviderConfig>): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

describe('buildClaudeEnvLines provider compatibility', () => {
  test('maps plain third-party auth tokens to ANTHROPIC_API_KEY', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'plain-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('preserves explicit Bearer tokens as ANTHROPIC_AUTH_TOKEN', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=upstream-token');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=Bearer upstream-token');
  });

  test('preserves newline-delimited custom headers', () => {
    const lines = buildClaudeEnvLines(config({}), {
      ANTHROPIC_CUSTOM_HEADERS: 'x-one: 1\r\nx-two: 2',
    });

    expect(lines).toContain('ANTHROPIC_CUSTOM_HEADERS=x-one: 1\nx-two: 2');
  });

  test('derives quality and timeout defaults for third-party models', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'quality-model[1m]' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=quality-model[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=quality-model[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=quality-model[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('API_TIMEOUT_MS=3000000');
  });

  test('keeps explicit four-tier model mappings', () => {
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'max' }), {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'max',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'high',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast',
    });

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=max');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=high');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=fast');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).not.toContain('ANTHROPIC_MODEL=max[1m]');
  });

  test('does not assume every tier alias has a one-million context window', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'high' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
  });

  test.each([
    'gpt-5.6-sol',
    'claude-opus-4-8',
    'model_hub/es1_orange_o48',
    'model_hub/es1_orange_o47',
  ])('recognizes max candidate %s as one-million context', (model) => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: model }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
  });

  test('marks official and custom endpoints for the runner', () => {
    expect(
      buildContainerEnvLines(
        config({ anthropicBaseUrl: '' }),
        {},
        NO_CUSTOM_ENV,
      ),
    ).toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=official');
    expect(buildContainerEnvLines(config({}), {}, NO_CUSTOM_ENV)).toContain(
      'HAPPYCLAW_CLAUDE_ENDPOINT_KIND=custom',
    );
  });

  test('clears inherited Anthropic and OpenAI provider state', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'https://stale.example',
      ANTHROPIC_MODEL: 'stale',
      OPENAI_API_KEY: 'stale',
      HAPPYCLAW_ENGINE_TYPE: 'openai',
      USER_SETTING: 'kept',
    };

    clearInheritedProviderEnv(env);

    expect(env).toEqual({ USER_SETTING: 'kept' });
  });
});

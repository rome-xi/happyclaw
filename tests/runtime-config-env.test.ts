import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

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
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('preserves explicit Bearer tokens as ANTHROPIC_AUTH_TOKEN', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
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
});

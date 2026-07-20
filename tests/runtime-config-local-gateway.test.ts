import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  isLoopbackProviderBaseUrl,
  LOCAL_GATEWAY_API_KEY,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function provider(
  overrides: Partial<ClaudeProviderConfig>,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: '',
    updatedAt: null,
    ...overrides,
  };
}

describe('loopback provider authentication sentinel', () => {
  test.each([
    'http://127.0.0.1:3011',
    'http://127.12.34.56:3011/v1',
    'http://localhost:3011',
    'http://localhost.:3011',
    'http://[::1]:3011',
  ])('recognizes %s as loopback', (url) => {
    expect(isLoopbackProviderBaseUrl(url)).toBe(true);
  });

  test.each([
    'http://192.168.1.20:3011',
    'http://10.0.0.2:3011',
    'https://gateway.example.com',
    'not a url',
  ])('does not treat %s as loopback', (url) => {
    expect(isLoopbackProviderBaseUrl(url)).toBe(false);
  });

  test('injects a non-secret key only for an unauthenticated loopback gateway', () => {
    const lines = buildClaudeEnvLines(
      provider({
        anthropicBaseUrl: 'http://127.0.0.1:3011',
        anthropicModel: 'max',
      }),
      {},
    );

    expect(lines).toContain(`ANTHROPIC_API_KEY=${LOCAL_GATEWAY_API_KEY}`);
    expect(lines).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:3011');
    expect(lines).toContain('ANTHROPIC_MODEL=max');
  });

  test('never injects a sentinel for public or LAN providers', () => {
    const lines = buildClaudeEnvLines(
      provider({ anthropicBaseUrl: 'https://gateway.example.com' }),
      {},
    );
    expect(lines.some((line) => line.startsWith('ANTHROPIC_API_KEY='))).toBe(
      false,
    );
  });

  test('preserves an explicitly configured credential', () => {
    const lines = buildClaudeEnvLines(
      provider({
        anthropicBaseUrl: 'http://localhost:3011',
        anthropicApiKey: 'configured-key',
      }),
      {},
    );
    expect(lines).toContain('ANTHROPIC_API_KEY=configured-key');
    expect(lines).not.toContain(`ANTHROPIC_API_KEY=${LOCAL_GATEWAY_API_KEY}`);
  });

  test('does not break OAuth passthrough for a bare Claude model', () => {
    const lines = buildClaudeEnvLines(
      provider({
        anthropicBaseUrl: 'http://127.0.0.1:3011',
        anthropicModel: 'claude-opus-4-8',
      }),
      {},
    );
    expect(lines.some((line) => line.startsWith('ANTHROPIC_API_KEY='))).toBe(
      false,
    );
  });
});

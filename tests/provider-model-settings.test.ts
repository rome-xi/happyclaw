import { describe, expect, test } from 'vitest';

import {
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
} from '../web/src/utils/provider-model.js';

describe('third-party provider model settings', () => {
  test('parses and normalizes the one-million suffix', () => {
    expect(parseProviderModel(' quality-model[1M] ')).toEqual({
      model: 'quality-model',
      oneMillionContext: true,
    });
    expect(buildProviderModel('quality-model[1m][1M]', true)).toBe(
      'quality-model[1m]',
    );
    expect(buildProviderModel('quality-model[1m]', false)).toBe(
      'quality-model',
    );
  });

  test('does not create a suffix without a model name', () => {
    expect(buildProviderModel(' ', true)).toBe('');
  });

  test('exposes predictable managed defaults', () => {
    expect(
      Object.fromEntries(
        buildDefaultProviderEnv('quality-model', true).map(({ key, value }) => [
          key,
          value,
        ]),
      ),
    ).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'quality-model[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      API_TIMEOUT_MS: '3000000',
    });
  });
});

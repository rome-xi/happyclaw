import { describe, expect, test } from 'vitest';

import {
  ONE_MILLION_CONTEXT_TOKENS,
  TIER_DEFINITIONS,
  resolveModelContextWindowTokens,
  validateTierCatalog,
  type TierDefinition,
} from '../src/tier-catalog.js';

describe('tier context catalog', () => {
  test('max accepts only one-million-context candidates', () => {
    expect(validateTierCatalog(TIER_DEFINITIONS)).toEqual([]);
    expect(resolveModelContextWindowTokens('max')).toBe(
      ONE_MILLION_CONTEXT_TOKENS,
    );
    expect(
      TIER_DEFINITIONS.max.order.every(
        (candidate) =>
          candidate.contextWindowTokens >= ONE_MILLION_CONTEXT_TOKENS,
      ),
    ).toBe(true);
  });

  test('rejects a short-context model added to max', () => {
    const invalid: Record<string, TierDefinition> = {
      max: {
        ...TIER_DEFINITIONS.max,
        order: [
          ...TIER_DEFINITIONS.max.order,
          {
            model: 'short-model',
            src: 'test-source',
            protocol: 'anthropic-messages',
            contextWindowTokens: 200_000,
          },
        ],
      },
    };

    expect(validateTierCatalog(invalid)).toEqual([
      'max/short-model: 200000 < required 1000000',
    ]);
  });

  test('tier aliases use the smallest candidate context window', () => {
    expect(resolveModelContextWindowTokens('high')).toBe(200_000);
    expect(resolveModelContextWindowTokens('model_hub/es1_orange_o48')).toBe(
      ONE_MILLION_CONTEXT_TOKENS,
    );
    expect(resolveModelContextWindowTokens('unknown-model')).toBeUndefined();
  });
});

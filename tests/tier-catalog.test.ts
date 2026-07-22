import { describe, expect, test } from 'vitest';

import {
  ONE_MILLION_CONTEXT_TOKENS,
  TIER_DEFINITIONS,
  getModelCatalog,
  getModelRoutingConfig,
  resolveModelSelection,
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

  test('loads every current super-relay model from config', () => {
    const relayModels = getModelCatalog().filter(
      (model) => model.src === 'super-relay (字节内部)',
    );
    expect(relayModels).toHaveLength(14);
    expect(relayModels.map((model) => model.model)).toEqual(
      expect.arrayContaining([
        'grok/grok-4.5',
        'auto_model/alwaysday1_max',
        'model_api/experimental_0717',
        'model_api/seed-code-dogfooding-fast',
        'opensource/glm5.2',
      ]),
    );
    expect(
      getModelRoutingConfig().sources['super-relay (字节内部)'].syncModels,
    ).toBe(true);
  });

  test('resolves tier, exact model, and human-friendly alias uniformly', () => {
    expect(resolveModelSelection('max')).toMatchObject({
      kind: 'tier',
      model: 'max',
      contextWindowTokens: ONE_MILLION_CONTEXT_TOKENS,
    });
    expect(resolveModelSelection('grok')).toMatchObject({
      kind: 'model',
      model: 'grok/grok-4.5',
      contextWindowTokens: 256_000,
    });
    expect(resolveModelSelection('model_api/experimental_0717')?.model).toBe(
      'model_api/experimental_0717',
    );
  });
});

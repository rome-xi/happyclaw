import { describe, expect, test } from 'vitest';

import {
  buildTierUpdatePayload,
  currentTierState,
  selectTierWinner,
  validateSourceChannel,
  type Candidate,
  type ProbeResult,
} from '../src/tier-prober.js';

const candidates: Candidate[] = [
  { model: 'model-a', src: 'source-a' },
  { model: 'model-b', src: 'source-b' },
];

describe('tier winner selection', () => {
  test('speed policy selects the lowest-latency correct candidate', () => {
    const results: Record<string, ProbeResult> = {
      'model-a': { ok: true, correct: true, latencyMs: 900 },
      'model-b': { ok: true, correct: true, latencyMs: 250 },
    };
    expect(selectTierWinner(candidates, results, 'speed')).toEqual(
      candidates[1],
    );
  });

  test('capability policy preserves manual order and skips unhealthy models', () => {
    const results: Record<string, ProbeResult> = {
      'model-a': { ok: false, correct: false, latencyMs: 100 },
      'model-b': { ok: true, correct: true, latencyMs: 500 },
    };
    expect(selectTierWinner(candidates, results, 'capability')).toEqual(
      candidates[1],
    );
    expect(selectTierWinner(candidates, {}, 'speed')).toBeNull();
  });
});

describe('tier source validation', () => {
  const valid = {
    base_url: 'http://127.0.0.1:19080',
    key: 'dummy',
    status: 1,
    models: 'model-a,model-c',
  };

  test('accepts a complete enabled source that advertises the model', () => {
    expect(validateSourceChannel(valid, 'model-a')).toEqual({ valid: true });
  });

  test.each([
    [{ ...valid, base_url: '' }, 'missing_base_url'],
    [{ ...valid, base_url: 'file:///tmp/socket' }, 'invalid_base_url'],
    [{ ...valid, key: '' }, 'missing_key'],
    [{ ...valid, key: 'sk-****abcd' }, 'masked_key'],
    [{ ...valid, status: 2 }, 'disabled'],
    [{ ...valid, models: 'model-c' }, 'model_missing'],
  ] as const)('rejects unsafe source configuration (%s)', (channel, reason) => {
    expect(validateSourceChannel(channel, 'model-a')).toEqual({
      valid: false,
      reason,
    });
  });
});

describe('tier channel updates', () => {
  test('reads the exact virtual tier mapping instead of the first value', () => {
    expect(
      currentTierState(
        {
          model_mapping: JSON.stringify({ unrelated: 'wrong', high: 'right' }),
          base_url: 'https://old.example',
          key: 'old-key',
        },
        'high',
      ),
    ).toEqual({
      winner: 'right',
      baseUrl: 'https://old.example',
      key: 'old-key',
    });
  });

  test('builds a payload without mutating cached channel objects', () => {
    const tier = { id: 2, base_url: 'https://old.example', key: 'old' };
    const source = { base_url: 'https://new.example', key: 'new' };
    const payload = buildTierUpdatePayload(tier, source, 'max', 'model-a');

    expect(payload).toMatchObject({
      id: 2,
      base_url: 'https://new.example',
      key: 'new',
      model_mapping: JSON.stringify({ max: 'model-a' }),
    });
    expect(tier).toEqual({
      id: 2,
      base_url: 'https://old.example',
      key: 'old',
    });
  });
});

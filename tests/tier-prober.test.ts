import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import {
  buildTierProbeRequest,
  buildTierUpdatePayload,
  currentTierState,
  readChannelKeyFromSqlite,
  selectStableTierWinner,
  selectTierWinner,
  validateSourceChannel,
  type Candidate,
  type ProbeResult,
} from '../src/tier-prober.js';

const candidates: Candidate[] = [
  {
    model: 'model-a',
    src: 'source-a',
    protocol: 'anthropic-messages',
  },
  {
    model: 'model-b',
    src: 'source-b',
    protocol: 'openai-responses-adapter',
  },
];

describe('tier compatibility canary', () => {
  test('exercises Anthropic system prompts and tool schemas', () => {
    const request = buildTierProbeRequest('model-a') as {
      model: string;
      system: Array<{ type: string; text: string }>;
      messages: Array<{ role: string; content: unknown }>;
      tools: Array<{ name: string; input_schema: { type: string } }>;
    };

    expect(request.model).toBe('model-a');
    expect(request.system[0].text).toContain('Agent SDK');
    expect(request.messages[0].role).toBe('user');
    expect(request.messages[1].role).toBe('system');
    expect(request.tools[0]).toMatchObject({
      name: 'health_probe_noop',
      input_schema: { type: 'object' },
    });
  });
});

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

  test('rejects a one-shot winner and selects a burst-stable candidate', async () => {
    const results: Record<string, ProbeResult> = {
      'model-a': { ok: true, correct: true, latencyMs: 100 },
      'model-b': { ok: true, correct: true, latencyMs: 300 },
    };
    const attempts = new Map<string, number>();
    const winner = await selectStableTierWinner(
      candidates,
      results,
      'speed',
      async (model) => {
        const attempt = (attempts.get(model) || 0) + 1;
        attempts.set(model, attempt);
        if (model === 'model-a' && attempt === 2) {
          return { ok: false, correct: false, latencyMs: 999_999 };
        }
        return {
          ok: true,
          correct: true,
          latencyMs: model === 'model-a' ? 120 : 320,
        };
      },
    );

    expect(winner).toEqual(candidates[1]);
    expect(results['model-a'].ok).toBe(false);
    expect(attempts.get('model-b')).toBe(2);
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

describe('tier source key loading', () => {
  test('reads a source key from a local new-api SQLite database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-prober-'));
    const databasePath = path.join(directory, 'one-api.db');
    const database = new Database(databasePath);
    try {
      database.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, key TEXT)');
      database
        .prepare('INSERT INTO channels (id, key) VALUES (?, ?)')
        .run(7, 'local-source-key');
      expect(readChannelKeyFromSqlite(7, databasePath)).toBe(
        'local-source-key',
      );
      expect(readChannelKeyFromSqlite(8, databasePath)).toBe('');
    } finally {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

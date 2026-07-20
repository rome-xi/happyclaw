import os from 'node:os';
import { describe, expect, test } from 'vitest';

import { sanitizeLogs } from '../src/routes/bug-report.js';

describe('sanitizeLogs credential masking', () => {
  test('masks comma-separated and truncated quoted values', () => {
    expect(sanitizeLogs('secret=part1,part2')).toBe('secret=***');
    expect(sanitizeLogs('cookie=a,b,c')).toBe('cookie=***');
    expect(sanitizeLogs('secret=,abc,def')).toBe('secret=***');
    expect(sanitizeLogs('"api_secret": "9f8e7d6c5b4a')).toBe('"api_secret=***');
  });

  test('keeps neighbouring non-secret context', () => {
    expect(sanitizeLogs('apikey=v, region=us')).toBe('apikey=*** region=us');
    expect(sanitizeLogs('{"secret":"abc","other":"x"}')).toBe(
      '{"secret=***,"other":"x"}',
    );
  });

  test('masks authorization schemes and known raw token formats', () => {
    expect(sanitizeLogs('Authorization: Bearer abc123def456')).not.toContain(
      'abc123def456',
    );
    expect(sanitizeLogs('key=sk-abcdefgh12345')).toBe('key=sk-***');
  });

  test('limits an unterminated quote to its own line', () => {
    const out = sanitizeLogs(
      'secret="oops\nhost=prod region=us\napi_key=realvalue123',
    );
    expect(out).toBe('secret=***\nhost=prod region=us\napi_key=***');
  });
});

describe('sanitizeLogs path and workload bounds', () => {
  test('redacts home paths, including one crossing the line cap', () => {
    const home = os.homedir();
    const out = sanitizeLogs(`${'x'.repeat(1990)}${home}/secret-file.ts`);
    expect(out).toContain('<home>');
    expect(out).not.toContain(home);
  });

  test('truncates long lines without a quadratic stall', () => {
    const start = Date.now();
    const out = sanitizeLogs('secret'.repeat(16000));
    expect(Date.now() - start).toBeLessThan(200);
    expect(out).toContain('…[truncated]');
  });
});

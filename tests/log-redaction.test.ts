import { describe, expect, test } from 'vitest';

import { redactLogString, sanitizeLogValue } from '../src/log-redaction.js';

describe('log redaction', () => {
  test('redacts Telegram bot credentials embedded in request URLs', () => {
    const token = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const input = `request to https://api.telegram.org/bot${token}/getUpdates failed`;
    const output = redactLogString(input);

    expect(output).not.toContain(token);
    expect(output).toContain('bot[REDACTED]/getUpdates');
  });

  test('redacts nested error strings and sensitive fields', () => {
    const token = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const cause = new Error(
      `request to https://api.telegram.org/bot${token}/getUpdates failed`,
    );
    const error = new Error('outer failure', { cause }) as Error & {
      apiKey?: string;
    };
    error.apiKey = 'should-not-appear';

    const serialized = JSON.stringify(sanitizeLogValue(error));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('should-not-appear');
    expect(serialized).toContain('[REDACTED]');
  });

  test('redacts private relay credentials embedded in free-form text', () => {
    const credential = `plat_${'A'.repeat(32)}`;
    expect(redactLogString(`x-relay-api-key: ${credential}`)).not.toContain(
      credential,
    );
  });
});

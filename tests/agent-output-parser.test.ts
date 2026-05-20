import { describe, expect, test } from 'vitest';

import {
  isApiError,
  isProviderFailureResult,
} from '../src/agent-output-parser.js';

describe('agent-output-parser provider failure detection', () => {
  test('detects Claude extra-usage exhaustion returned as final text', () => {
    const msg = "You're out of extra usage · resets 2:10am (Asia/Shanghai)";

    expect(isProviderFailureResult(msg)).toBe(true);
    expect(isApiError(msg)).toBe(true);
  });

  test('detects legacy Claude limit final text', () => {
    const msg = "You've hit your limit · resets 3am (Asia/Shanghai)";

    expect(isProviderFailureResult(msg)).toBe(true);
    expect(isApiError(msg)).toBe(true);
  });
});

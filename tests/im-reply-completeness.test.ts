import { describe, expect, test } from 'vitest';

import {
  keepsRoutedImContinuationOpen,
  shouldDeliverRoutedImResult,
} from '../src/im-reply-completeness.js';

describe('routed IM reply completeness', () => {
  test('delivers the first substantive result', () => {
    expect(
      shouldDeliverRoutedImResult({
        sentReply: false,
        awaitingContinuation: false,
        sourceKind: 'sdk_final',
      }),
    ).toBe(true);
  });

  test('suppresses unrelated later SDK task chatter', () => {
    expect(
      shouldDeliverRoutedImResult({
        sentReply: true,
        awaitingContinuation: false,
        sourceKind: 'sdk_final',
      }),
    ).toBe(false);
  });

  test.each([
    'truncation_continue',
    'auto_continue',
    'overflow_partial',
    'compact_partial',
  ])('delivers %s even after an earlier result', (sourceKind) => {
    expect(
      shouldDeliverRoutedImResult({
        sentReply: true,
        awaitingContinuation: false,
        sourceKind,
      }),
    ).toBe(true);
  });

  test('delivers the final segment after a held/truncated result', () => {
    expect(
      shouldDeliverRoutedImResult({
        sentReply: true,
        awaitingContinuation: true,
        sourceKind: 'sdk_final',
      }),
    ).toBe(true);
  });

  test('keeps continuation state open for truncation and background work', () => {
    expect(
      keepsRoutedImContinuationOpen({ finalizationReason: 'truncated' }),
    ).toBe(true);
    expect(keepsRoutedImContinuationOpen({ pendingBgTasks: 2 })).toBe(true);
    expect(
      keepsRoutedImContinuationOpen({
        finalizationReason: 'completed',
        pendingBgTasks: 0,
      }),
    ).toBe(false);
  });
});

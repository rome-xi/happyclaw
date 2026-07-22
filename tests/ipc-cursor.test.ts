import { describe, expect, test } from 'vitest';

import {
  initializeCommittedCursorMap,
  messageCursorForRead,
  mergeCompletedIpcCursor,
  recoveryAnchorBeforeNextPull,
  shouldCommitDeliveryResult,
} from '../src/ipc-cursor.js';

describe('completed IPC cursor merge', () => {
  test('commits only the completed delivery, not a later next-pull cursor', () => {
    const completed = {
      id: 'message-1',
      timestamp: '2026-07-22T05:00:00.000Z',
    };
    const laterPendingNextPull = {
      id: 'message-2',
      timestamp: '2026-07-22T05:00:01.000Z',
    };

    const durable = mergeCompletedIpcCursor(undefined, completed);
    expect(durable).toEqual(completed);
    expect(durable).not.toEqual(laterPendingNextPull);
  });

  test('never regresses an already committed cursor', () => {
    const current = {
      id: 'message-z',
      timestamp: '2026-07-22T05:00:00.000Z',
    };
    const older = {
      id: 'message-a',
      timestamp: '2026-07-22T05:00:00.000Z',
    };
    expect(mergeCompletedIpcCursor(current, older)).toEqual(current);
  });
});

describe('next-pull recovery anchor', () => {
  test('keeps an existing durable cursor', () => {
    const committed = { timestamp: '2026-07-22T01:00:00.000Z', id: 'done' };
    const nextPull = { timestamp: '2026-07-22T01:00:01.000Z', id: 'next' };
    expect(recoveryAnchorBeforeNextPull(committed, nextPull)).toEqual(
      committed,
    );
  });

  test('uses the previous next-pull cursor when a lane is first injected', () => {
    const previous = { timestamp: '2026-07-22T01:00:00.000Z', id: 'before' };
    expect(recoveryAnchorBeforeNextPull(undefined, previous)).toEqual(previous);
  });

  test('uses an explicit empty anchor for a brand-new lane', () => {
    expect(recoveryAnchorBeforeNextPull(undefined, undefined)).toEqual({
      timestamp: '',
      id: '',
    });
  });
});

describe('restart cursor selection and migration', () => {
  const committed = { timestamp: '2026-07-22T01:00:00.000Z', id: 'done' };
  const nextPull = { timestamp: '2026-07-22T01:00:01.000Z', id: 'injected' };

  test('startup recovery reads from committed instead of newer next-pull', () => {
    expect(messageCursorForRead(nextPull, committed, true)).toEqual(committed);
    expect(messageCursorForRead(nextPull, committed, false)).toEqual(nextPull);
  });

  test('missing recovery cursor falls back to empty rather than next-pull', () => {
    expect(messageCursorForRead(nextPull, undefined, true)).toEqual({
      timestamp: '',
      id: '',
    });
  });

  test('an existing committed map never promotes a missing new JID', () => {
    expect(
      initializeCommittedCursorMap(
        '{}',
        { 'feishu:new': nextPull },
        { 'web:existing': committed },
      ),
    ).toEqual({ 'web:existing': committed });
  });

  test('a truly legacy database initializes the whole map once', () => {
    expect(
      initializeCommittedCursorMap(undefined, { 'web:legacy': nextPull }, {}),
    ).toEqual({ 'web:legacy': nextPull });
  });
});

describe('visible result commit boundary', () => {
  test('holds Workflow, truncated, and compaction intermediate results', () => {
    expect(shouldCommitDeliveryResult({ pendingBgTasks: 1 })).toBe(false);
    expect(
      shouldCommitDeliveryResult({
        pendingBgTasks: 0,
        finalizationReason: 'truncated',
      }),
    ).toBe(false);
    expect(shouldCommitDeliveryResult({ sourceKind: 'compact_partial' })).toBe(
      false,
    );
    expect(shouldCommitDeliveryResult({ sourceKind: 'overflow_partial' })).toBe(
      false,
    );
  });

  test('holds an empty Workflow result until its continuation', () => {
    expect(
      shouldCommitDeliveryResult({
        pendingBgTasks: 2,
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('commits only the healthy final result', () => {
    expect(
      shouldCommitDeliveryResult({
        pendingBgTasks: 0,
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });
});

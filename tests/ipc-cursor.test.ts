import { describe, expect, test } from 'vitest';

import { mergeCompletedIpcCursor } from '../src/ipc-cursor.js';

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

import type { MessageCursor } from './types.js';

function isAfter(a: MessageCursor, b: MessageCursor): boolean {
  return (
    a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id > b.id)
  );
}

/**
 * Max-merge one completed IPC delivery against the durable cursor only.
 * Deliberately has no next-pull cursor input: queued-but-uncompleted messages
 * must not be promoted into lastCommittedCursor as a side effect.
 */
export function mergeCompletedIpcCursor(
  currentCommitted: MessageCursor | undefined,
  completed: MessageCursor,
): MessageCursor {
  return currentCommitted && isAfter(currentCommitted, completed)
    ? currentCommitted
    : completed;
}

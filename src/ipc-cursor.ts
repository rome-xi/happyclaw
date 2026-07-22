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

/**
 * Preserve the recovery anchor before moving a next-pull cursor on its own.
 * A new DB lane has no committed entry yet; its previous next-pull position
 * (or the empty cursor) is the last point known not to include the delivery
 * being injected now.
 */
export function recoveryAnchorBeforeNextPull(
  currentCommitted: MessageCursor | undefined,
  currentNextPull: MessageCursor | undefined,
): MessageCursor {
  return currentCommitted ?? currentNextPull ?? { timestamp: '', id: '' };
}

/** Select the DB read anchor. Recovery must never inherit the newer pull cursor. */
export function messageCursorForRead(
  nextPull: MessageCursor | undefined,
  committed: MessageCursor | undefined,
  recovering: boolean,
): MessageCursor {
  return recovering
    ? (committed ?? { timestamp: '', id: '' })
    : (nextPull ?? { timestamp: '', id: '' });
}

/**
 * Migrate only databases where the committed-cursor state key never existed.
 * An existing (even empty) map may intentionally omit a newly injected lane.
 */
export function initializeCommittedCursorMap(
  persistedCommittedState: string | undefined,
  nextPull: Record<string, MessageCursor>,
  committed: Record<string, MessageCursor>,
): Record<string, MessageCursor> {
  return persistedCommittedState === undefined ? { ...nextPull } : committed;
}

/** Visible Workflow/truncation/compaction output is not a commit boundary. */
export function shouldCommitDeliveryResult(result: {
  pendingBgTasks?: number;
  finalizationReason?: string;
  sourceKind?: string;
}): boolean {
  return (
    (result.pendingBgTasks ?? 0) === 0 &&
    result.finalizationReason !== 'truncated' &&
    result.sourceKind !== 'compact_partial' &&
    result.sourceKind !== 'overflow_partial'
  );
}

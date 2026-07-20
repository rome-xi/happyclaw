export interface RoutedImResultState {
  sentReply: boolean;
  awaitingContinuation: boolean;
  sourceKind?: string;
}

const CONTINUATION_SOURCE_KINDS = new Set([
  'truncation_continue',
  'auto_continue',
  'overflow_partial',
  'compact_partial',
]);

/**
 * Routed IM conversations share a Web workspace.  `sentReply` prevents SDK
 * background-task chatter from spamming IM, but it must not suppress an actual
 * truncation/compaction continuation.  This predicate keeps that distinction
 * explicit and independently testable.
 */
export function shouldDeliverRoutedImResult(
  state: RoutedImResultState,
): boolean {
  return (
    !state.sentReply ||
    state.awaitingContinuation ||
    CONTINUATION_SOURCE_KINDS.has(state.sourceKind || '')
  );
}

export function keepsRoutedImContinuationOpen(result: {
  finalizationReason?: string;
  pendingBgTasks?: number;
}): boolean {
  return (
    result.finalizationReason === 'truncated' ||
    (result.pendingBgTasks ?? 0) > 0
  );
}

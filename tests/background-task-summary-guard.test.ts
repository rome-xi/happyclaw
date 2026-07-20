import { describe, expect, test } from 'vitest';

import {
  buildBackgroundTaskSummaryPrompt,
  isStaleBackgroundWaitReply,
  shouldForceBackgroundTaskSummary,
} from '../container/agent-runner/src/utils.js';

describe('background task summary guard', () => {
  test('recognizes stale wait replies without matching normal summaries', () => {
    expect(isStaleBackgroundWaitReply('1/3 完成，等待其余 2 个 Agent')).toBe(
      true,
    );
    expect(
      isStaleBackgroundWaitReply('I will wait for the remaining 2 agents.'),
    ).toBe(true);
    expect(
      isStaleBackgroundWaitReply('三个任务均已完成，下面是最终结论。'),
    ).toBe(false);
  });

  test('only forces after a pending workflow settles and respects its cap', () => {
    const base = {
      emitOutput: true,
      sawPendingBackgroundTasks: true,
      pendingBgTasks: 0,
      finalText: '等待其余 1 个后台任务',
      attempts: 0,
      maxAttempts: 2,
    };

    expect(shouldForceBackgroundTaskSummary(base)).toBe(true);
    expect(
      shouldForceBackgroundTaskSummary({ ...base, pendingBgTasks: 1 }),
    ).toBe(false);
    expect(shouldForceBackgroundTaskSummary({ ...base, attempts: 2 })).toBe(
      false,
    );
  });

  test('builds a final-answer-only internal reminder', () => {
    const prompt = buildBackgroundTaskSummaryPrompt();
    expect(prompt).toContain('All background Task agents');
    expect(prompt).toContain('final user-facing synthesis');
  });
});

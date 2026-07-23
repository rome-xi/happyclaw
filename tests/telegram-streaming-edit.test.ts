import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  TelegramStreamingEditController,
  type TelegramStreamingTransport,
} from '../src/telegram-streaming-edit.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TelegramStreamingEditController', () => {
  test('a delayed live edit cannot overwrite the clean final reply', async () => {
    const draftStarted = deferred();
    const releaseDraft = deferred();
    const completedTexts: string[] = [];
    let visibleText = '';

    const transport: TelegramStreamingTransport = {
      createMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async (_messageId, text) => {
        if (text === 'streaming draft') {
          draftStarted.resolve();
          await releaseDraft.promise;
        }
        visibleText = text;
        completedTexts.push(text);
      }),
    };
    const controller = new TelegramStreamingEditController(transport);

    controller.append('streaming draft');
    await draftStarted.promise;

    const completion = controller.complete('clean final reply');
    expect(controller.isActive()).toBe(false);

    // Simulate a late SDK delta while Telegram is still retrying the old edit.
    controller.append('late stale overwrite');
    await Promise.resolve();
    await Promise.resolve();
    releaseDraft.resolve();
    await completion;

    expect(visibleText).toBe('clean final reply');
    expect(completedTexts.at(-1)).toBe('clean final reply');
    expect(completedTexts).not.toContain('late stale overwrite');
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';

import { OpenAIEngine } from '../container/agent-runner/src/engines/openai-engine.js';
import {
  getTerminalEngineError,
  shouldAcknowledgeQueryEvent,
} from '../container/agent-runner/src/ipc-inbox.js';
import type { StreamEvent } from '../container/agent-runner/src/stream-event.types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI IPC acceptance boundary', () => {
  test('HTTP 400 emits only an error status and never provides ACK evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'bad request' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const engine = new OpenAIEngine({ logFn: vi.fn() });
    const session = await engine.createSession({
      model: 'test-model',
      baseUrl: 'https://invalid.local/v1',
      apiKey: 'test-only-key',
      cwd: process.cwd(),
    });
    const generator = engine.sendMessage(
      session,
      [{ role: 'user', content: 'follow-up' }],
      [],
      [],
    );
    const events: StreamEvent[] = [];
    let finish: { finishReason: string; finalText: string } | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        finish = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(finish?.finishReason).toBe('error');
    expect(events).toEqual([
      expect.objectContaining({ eventType: 'status', statusText: 'error' }),
    ]);
    expect(
      events.some((event) => shouldAcknowledgeQueryEvent(event.eventType)),
    ).toBe(false);
    expect(getTerminalEngineError(finish!)).toBe(
      'Provider query failed before completing the message',
    );
  });
});

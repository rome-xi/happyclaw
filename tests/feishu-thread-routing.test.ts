import { describe, expect, test, vi } from 'vitest';
import { parseFeishuRouteTarget } from '../src/feishu.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

describe('parseFeishuRouteTarget', () => {
  test('parses thread/root metadata and marks thread replies', () => {
    expect(parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root')).toEqual({
      raw: 'oc_123#thread:omt_thread#root:om_root',
      chatId: 'oc_123',
      threadId: 'omt_thread',
      rootMessageId: 'om_root',
      replyInThread: true,
    });
  });

  test('keeps bare chat targets as non-thread replies', () => {
    expect(parseFeishuRouteTarget('oc_123')).toEqual({
      raw: 'oc_123',
      chatId: 'oc_123',
      threadId: undefined,
      rootMessageId: undefined,
      replyInThread: false,
    });
  });
});

describe('StreamingCardController Feishu thread reply', () => {
  test('passes reply_in_thread when creating the initial streaming card', async () => {
    const reply = vi.fn().mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi.fn().mockResolvedValue({ data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
      replyToMsgId: 'om_root',
      replyInThread: true,
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply.mock.calls[0][0].data).toMatchObject({
      msg_type: 'interactive',
      reply_in_thread: true,
    });
  });
});

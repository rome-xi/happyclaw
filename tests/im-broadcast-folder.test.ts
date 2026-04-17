import { describe, expect, test, vi } from 'vitest';

import {
  broadcastToOwnerIMChannels,
  type BroadcastToOwnerIMChannelsDeps,
} from '../src/task-routing.js';

// Mirror of src/channel-prefixes.ts prefix → type mapping, inlined for test
// independence. If CHANNEL_PREFIXES ever changes, update this alongside.
const PREFIX_TO_TYPE: Record<string, string> = {
  feishu: 'feishu',
  tg: 'telegram',
  qq: 'qq',
  ding: 'dingtalk',
  discord: 'discord',
  web: 'web',
};

function fakeGetChannelType(jid: string): string | null {
  const prefix = jid.split(':')[0];
  return PREFIX_TO_TYPE[prefix] ?? null;
}

describe('broadcastToOwnerIMChannels — folder-precise routing (fix F regression guard)', () => {
  test('routes only to groups whose folder matches sourceFolder', () => {
    // Owner has two IM bindings: feishu bound to ws-x, telegram bound to home-u.
    // Task runs in workspace ws-x → feishu fires, telegram does NOT.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F1');
    expect(sendFn).not.toHaveBeenCalledWith('tg:T1');
  });

  test('sourceFolder=home-u routes only to telegram binding', () => {
    // Symmetric case: same bindings, different sourceFolder → telegram only.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'home-u',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('no group matches sourceFolder → no sendFn calls', () => {
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'some-other-folder',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });

  test('channel type already sent (in alreadySentJids) is skipped', () => {
    // alreadySentJids says feishu was already covered; broadcast should skip
    // the feishu binding even though it matches the folder.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' }, // also bound to ws-x for this case
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set(['feishu:F1']),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('notifyChannels filter restricts output to allowed channel types', () => {
    // Both feishu and telegram bind to ws-x, but notifyChannels=['telegram']
    // means only telegram should receive.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      ['telegram'],
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('notifyChannels=null means no filter (fan out to all matching)', () => {
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      null,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledWith('feishu:F1');
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('one channel type, multiple candidate bindings: only the folder-matching one wins', () => {
    // Owner has feishu bound to two different workspaces. Only the one whose
    // folder === sourceFolder should fire. This is the core "folder precision"
    // property that fix F is defending.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F-home', folder: 'home-u' },
        { jid: 'feishu:F-wsx', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F-wsx');
    expect(sendFn).not.toHaveBeenCalledWith('feishu:F-home');
  });

  test('connected channel type with no binding at sourceFolder is silently skipped', () => {
    // Owner has feishu connected, but no feishu binding exists for this folder.
    // Should not throw, should not send.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [{ jid: 'tg:T1', folder: 'ws-x' }],
      getChannelType: fakeGetChannelType,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });
});

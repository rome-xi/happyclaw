import { describe, expect, test } from 'vitest';

import {
  resolveBackgroundJobWorkspaceJid,
  type BackgroundJobRouteGroup,
} from '../src/background-job-routing.js';

function makeResolver(
  groups: Record<string, BackgroundJobRouteGroup>,
  aliases: Record<string, string> = {},
  agents: Record<string, string> = {},
) {
  return (stampedJid: string | undefined, expectedFolder: string) =>
    resolveBackgroundJobWorkspaceJid({
      stampedJid,
      expectedFolder,
      getGroup: (jid) => groups[jid],
      getAgentChatJid: (agentId) => agents[agentId],
      resolveWorkspaceJid: (jid) => {
        const canonical = aliases[jid] ?? jid;
        return groups[canonical] ? canonical : null;
      },
    });
}

describe('background-job workspace routing', () => {
  test('follows an IM topic binding to a UUID-backed web workspace', () => {
    const resolve = makeResolver({
      'telegram:-100:topic:42': {
        folder: 'main',
        target_main_jid: 'web:workspace-uuid',
      },
      'web:workspace-uuid': { folder: 'flow-mteam' },
    });

    expect(resolve('telegram:-100:topic:42', 'flow-mteam')).toBe(
      'web:workspace-uuid',
    );
  });

  test('follows an IM binding to a conversation agent parent workspace', () => {
    const resolve = makeResolver(
      {
        'feishu:chat-1': {
          folder: 'main',
          target_agent_id: 'agent-1',
        },
        'web:shared-uuid': { folder: 'flow-share' },
      },
      {},
      { 'agent-1': 'web:shared-uuid' },
    );

    expect(resolve('feishu:chat-1', 'flow-share')).toBe('web:shared-uuid');
  });

  test('canonicalizes the legacy folder alias when no source JID is stamped', () => {
    const resolve = makeResolver(
      {
        'web:workspace-uuid': { folder: 'flow-share' },
      },
      {
        'web:flow-share': 'web:workspace-uuid',
      },
    );

    expect(resolve(undefined, 'flow-share')).toBe('web:workspace-uuid');
  });

  test('rejects a binding that resolves outside the executing folder', () => {
    const resolve = makeResolver({
      'telegram:-100:topic:99': {
        folder: 'main',
        target_main_jid: 'web:wrong',
      },
      'web:wrong': { folder: 'other-folder' },
    });

    expect(resolve('telegram:-100:topic:99', 'expected-folder')).toBeNull();
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';
import { IpcCompletionTracker } from '../container/agent-runner/src/ipc-inbox.js';

// Regression coverage for PR #547: conversation agents must stay WARM after a
// final reply (reclaimed by IDLE_TIMEOUT), instead of being closed every turn.
// A hung post-reply tool call is handled runner-side by the post-result
// interrupt fallback — the host must NOT tear the warm runner down.
//
// These tests exercise the real GroupQueue state machine. State is seeded
// directly into the internal map (same approach as
// group-queue-descendants.test.ts) so the tests stay hermetic and don't need a
// real spawned process.

interface SeedOpts {
  active?: boolean;
  groupFolder?: string;
  agentId?: string | null;
  queryInFlight?: boolean;
  activeRunnerIsTask?: boolean;
  lastActivityAt?: number | null;
}

function seedRunner(q: GroupQueue, jid: string, opts: SeedOpts = {}) {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  anyQ.groups.set(jid, {
    active: opts.active ?? true,
    activeRunnerIsTask: opts.activeRunnerIsTask ?? false,
    lastActivityAt: opts.lastActivityAt ?? null,
    queryInFlight: opts.queryInFlight ?? false,
    pendingIpcMessageIds: new Set<string>(),
    ipcDeliveryMetadata: new Map(),
    completedIpcMessageIds: new Set<string>(),
    ipcAwaitingAckSince: null,
    pendingMessages: false,
    pendingTasks: [],
    process: null,
    containerName: null,
    displayName: null,
    groupFolder: opts.groupFolder ?? 'main',
    agentId: opts.agentId ?? null,
    taskRunId: null,
    ipcDatabaseJidFilter: null,
    retryCount: 0,
    retryTimer: null,
    restarting: false,
    selectedProviderId: null,
    drainSentinelWritten: false,
    hasIpcInjectedMessages: false,
    ipcInjectedDatabaseJids: new Set<string>(),
  });
}

function getState(q: GroupQueue, jid: string): Record<string, unknown> {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  return anyQ.groups.get(jid)!;
}

describe('PR #547: conversation agent stays warm after final reply', () => {
  // Unique folder per run so the real DATA_DIR (= worktree/data, gitignored and
  // vitest-excluded) is not polluted across runs. Cleaned up in afterEach.
  const folder = `warm-test-${process.pid}-${Date.now()}`;
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);

  afterEach(() => {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  test('runner remains acceptable for the next message after a final reply (markRunnerQueryIdle)', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    // Active conversation runner mid-turn.
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: true });

    // Host marks the query idle when the final reply is emitted (success+result).
    // This is what wrappedOnOutput does instead of closing the runner.
    q.markRunnerQueryIdle(jid);
    expect(getState(q, jid).queryInFlight).toBe(false);

    // The warm runner is still a valid target for the next user message —
    // sendMessage would route into it (no cold start).
    expect(q.hasActiveMainRunnerForMessage(jid)).toBe(true);
  });

  test('recovery-pinned shared runner rejects a sibling DB lane', () => {
    const q = new GroupQueue();
    const feishuJid = `feishu:${folder}`;
    const telegramJid = `telegram:${folder}`;
    q.setSerializationKeyResolver(() => folder);
    seedRunner(q, feishuJid, { groupFolder: folder });
    getState(q, feishuJid).ipcDatabaseJidFilter = feishuJid;

    expect(
      q.sendMessage(
        telegramJid,
        'must wait for its own recovery runner',
        undefined,
        undefined,
        telegramJid,
        { databaseJid: telegramJid, messageCursors: [] },
      ),
    ).toBe('no_active');
    const inputDir = path.join(ipcDir, 'input');
    expect(fs.existsSync(inputDir)).toBe(false);
  });

  test('registering a recovery-pinned runner makes it one-shot', () => {
    const q = new GroupQueue();
    const jid = `feishu:${folder}`;
    seedRunner(q, jid, { groupFolder: folder });

    q.registerProcess(jid, {} as never, {
      containerName: null,
      groupFolder: folder,
      ipcDatabaseJidFilter: jid,
    });

    expect(fs.existsSync(path.join(ipcDir, 'input', '_drain'))).toBe(true);
    expect(getState(q, jid).drainSentinelWritten).toBe(true);
  });

  test('a hung post-reply tool call does not strand the runner: next message reuses the warm process', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: true });

    // Final reply emitted -> host marks idle (runner kept warm, NOT closed).
    q.markRunnerQueryIdle(jid);

    // The next user message is piped into the SAME warm runner via IPC.
    const cursor = {
      id: 'follow-up-db-id',
      timestamp: '2026-07-22T00:00:00.000Z',
    };
    const result = q.sendMessage(
      jid,
      'follow-up message',
      undefined,
      undefined,
      jid,
      { databaseJid: jid, messageCursors: [cursor] },
    );
    expect(result).toBe('sent');
    // sendMessage flips queryInFlight back to true: durable follow-up work is
    // pending, but the active SDK query must not consume it.
    expect(getState(q, jid).queryInFlight).toBe(true);

    // The IPC file stays in the warm runner's input dir until a fresh turn
    // claims it (process reuse, without active-query pipe-in).
    const inputDir = path.join(ipcDir, 'input');
    const files = fs.readdirSync(inputDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const payload = JSON.parse(
      fs.readFileSync(path.join(inputDir, files[0]), 'utf8'),
    );
    expect(payload.messageId).toBe(files[0].replace(/\.json$/, ''));
    expect(payload.databaseJid).toBe(jid);
    expect(payload.messageCursors).toEqual([cursor]);
    expect(
      (getState(q, jid).pendingIpcMessageIds as Set<string>).has(
        payload.messageId,
      ),
    ).toBe(true);
  });

  test('unacknowledged warm-runner IPC is watchdog-visible and clears on SDK start ack', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: false });
    const deliveryCursor = {
      id: 'continued-db-message',
      timestamp: '2026-07-23T00:00:00.000Z',
    };

    expect(
      q.sendMessage(jid, 'must not be swallowed', undefined, undefined, jid, {
        databaseJid: jid,
        messageCursors: [deliveryCursor],
      }),
    ).toBe('sent');
    const state = getState(q, jid);
    const ids = [...(state.pendingIpcMessageIds as Set<string>)];
    expect(ids).toHaveLength(1);

    // Simulate an IPC claim that has produced no SDK event beyond the 30s ACK
    // deadline. This state used to be invisible because pendingMessages=false.
    state.ipcAwaitingAckSince = Date.now() - 31_000;
    expect(q.getStuckPendingGroups(180_000, 30_000)).toEqual([
      expect.objectContaining({ jid }),
    ]);
    expect(q.takeCompletedIpcDeliveries(jid)).toEqual([]);

    const inputDir = path.join(ipcDir, 'input');
    const inflightDir = path.join(inputDir, 'inflight');
    fs.mkdirSync(inflightDir, { recursive: true });
    const queued = fs
      .readdirSync(inputDir)
      .find((file) => file.endsWith('.json'))!;
    fs.renameSync(path.join(inputDir, queued), path.join(inflightDir, queued));
    q.markIpcMessagesStarted(jid, ids);
    expect(fs.readdirSync(inflightDir)).toEqual([]);
    expect(q.takeCompletedIpcDeliveries(jid)).toEqual([]);
    expect(state.hasIpcInjectedMessages).toBe(true);

    // Intermediate continuation output carries no completion ID. The final
    // healthy result from the same logical turn releases it exactly once.
    const logicalTurn = new IpcCompletionTracker();
    logicalTurn.trackInitial(ids);
    expect(logicalTurn.advanceResult(false)).toEqual([]);
    expect(q.takeCompletedIpcDeliveries(jid)).toEqual([]);
    q.markIpcMessagesCompleted(jid, logicalTurn.advanceResult(true));
    expect(q.takeCompletedIpcDeliveries(jid)).toEqual([
      { databaseJid: jid, messageCursors: [deliveryCursor] },
    ]);
    expect(state.hasIpcInjectedMessages).toBe(false);
    expect(state.ipcAwaitingAckSince).toBeNull();
    expect(q.getStuckPendingGroups(180_000, 30_000)).toEqual([]);
  });

  test('conversation-agent task lane is watchdog-visible, while scheduled tasks remain excluded', () => {
    const q = new GroupQueue();
    const conversationJid = `web:${folder}#agent:conversation-1`;
    seedRunner(q, conversationJid, {
      groupFolder: folder,
      agentId: 'conversation-1',
      activeRunnerIsTask: true,
    });
    const conversationState = getState(q, conversationJid);
    conversationState.pendingIpcMessageIds = new Set(['agent-follow-up']);
    conversationState.ipcAwaitingAckSince = Date.now() - 31_000;

    const scheduledJid = `web:${folder}#task:scheduled-1`;
    seedRunner(q, scheduledJid, {
      groupFolder: folder,
      activeRunnerIsTask: true,
    });
    const scheduledState = getState(q, scheduledJid);
    scheduledState.pendingIpcMessageIds = new Set(['not-a-user-lane']);
    scheduledState.ipcAwaitingAckSince = Date.now() - 31_000;

    expect(q.getStuckPendingGroups(180_000, 30_000)).toEqual([
      expect.objectContaining({ jid: conversationJid }),
    ]);
  });

  test('conversation-agent teardown clears stale ACK state before queued recovery can start', async () => {
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:replacement-agent`;
    let resolveReplacement!: (state: {
      pendingIds: string[];
      awaitingSince: unknown;
      injected: unknown;
    }) => void;
    const replacementStarted = new Promise<{
      pendingIds: string[];
      awaitingSince: unknown;
      injected: unknown;
    }>((resolve) => {
      resolveReplacement = resolve;
    });

    q.setOnUnconsumedAgentIpc((recoveryJid) => {
      const state = getState(q, recoveryJid);
      // The production callback enqueues a replacement task. Observe on the
      // next microtask, after runTask's synchronous finally cleanup but before
      // any replacement runner could process an SDK event.
      queueMicrotask(() => {
        resolveReplacement({
          pendingIds: [...(state.pendingIpcMessageIds as Set<string>)],
          awaitingSince: state.ipcAwaitingAckSince,
          injected: state.hasIpcInjectedMessages,
        });
      });
    });

    q.enqueueTask(jid, 'original', async () => {
      const state = getState(q, jid);
      state.groupFolder = folder;
      state.agentId = 'replacement-agent';
      expect(q.sendMessage(jid, 'replay from durable DB')).toBe('sent');
      state.hasIpcInjectedMessages = true;
      state.ipcAwaitingAckSince = Date.now() - 31_000;
    });

    await expect(replacementStarted).resolves.toEqual({
      pendingIds: [],
      awaitingSince: null,
      injected: false,
    });
  });

  test('inflight IPC claims remain discoverable for crash recovery', () => {
    const q = new GroupQueue();
    const inflightDir = path.join(ipcDir, 'input', 'inflight');
    fs.mkdirSync(inflightDir, { recursive: true });
    fs.writeFileSync(
      path.join(inflightDir, 'claim-1.json'),
      JSON.stringify({ type: 'message', messageId: 'claim-1', text: 'hello' }),
    );

    expect(q.hasUnconsumedIpcInput(folder)).toBe(true);
  });

  test('DB recovery discards duplicate queued and inflight IPC envelopes only', () => {
    const q = new GroupQueue();
    const databaseJid = `web:${folder}`;
    const siblingJid = `feishu:${folder}`;
    const inputDir = path.join(ipcDir, 'input');
    const inflightDir = path.join(inputDir, 'inflight');
    fs.mkdirSync(inflightDir, { recursive: true });
    const cursor1 = { id: 'db-1', timestamp: '2026-07-22T01:00:00.000Z' };
    const cursor2 = { id: 'db-2', timestamp: '2026-07-22T01:00:01.000Z' };
    const cursor3 = { id: 'db-3', timestamp: '2026-07-22T01:00:02.000Z' };
    fs.writeFileSync(
      path.join(inputDir, 'queued.json'),
      JSON.stringify({ databaseJid, messageCursors: [cursor1] }),
    );
    fs.writeFileSync(
      path.join(inflightDir, 'claimed.json'),
      JSON.stringify({ databaseJid, messageCursors: [cursor2] }),
    );
    fs.writeFileSync(
      path.join(inputDir, 'sibling.json'),
      JSON.stringify({ databaseJid: siblingJid, messageCursors: [cursor1] }),
    );
    fs.writeFileSync(
      path.join(inputDir, 'not-replayed.json'),
      JSON.stringify({ databaseJid, messageCursors: [cursor3] }),
    );
    fs.writeFileSync(path.join(inputDir, '_close'), '');

    expect(
      q.discardRecoveredIpcInput(folder, databaseJid, [cursor1, cursor2]),
    ).toBe(2);
    expect(q.hasUnconsumedIpcInput(folder)).toBe(true);
    expect(q.getUnconsumedIpcDatabaseJids(folder, databaseJid)).toEqual(
      new Set([databaseJid, siblingJid]),
    );
    expect(fs.existsSync(path.join(inputDir, 'sibling.json'))).toBe(true);
    expect(fs.existsSync(path.join(inputDir, 'not-replayed.json'))).toBe(true);
    expect(fs.existsSync(path.join(inputDir, '_close'))).toBe(true);
  });

  test('shared-folder runner exit replays the injected sibling DB lane', async () => {
    const q = new GroupQueue();
    const webJid = `web:${folder}`;
    const feishuJid = `feishu:${folder}`;
    q.setSerializationKeyResolver(() => folder);

    let resolveSiblingRun!: () => void;
    const siblingRun = new Promise<void>((resolve) => {
      resolveSiblingRun = resolve;
    });
    q.setProcessMessagesFn(async (jid) => {
      const state = getState(q, jid);
      state.groupFolder = folder;
      if (jid === webJid) {
        expect(
          q.sendMessage(
            feishuJid,
            'message from Feishu',
            undefined,
            undefined,
            feishuJid,
            {
              databaseJid: feishuJid,
              messageCursors: [
                { id: 'feishu-db-1', timestamp: '2026-07-22T03:00:00.000Z' },
              ],
            },
          ),
        ).toBe('sent');
      } else if (jid === feishuJid) {
        expect(q.needsIpcRecoveryReplay(feishuJid)).toBe(true);
        const inputDir = path.join(ipcDir, 'input');
        for (const file of fs.readdirSync(inputDir)) {
          if (file.endsWith('.json')) fs.unlinkSync(path.join(inputDir, file));
        }
        q.clearIpcRecoveryReplay(feishuJid);
        resolveSiblingRun();
      }
      return true;
    });

    q.enqueueMessageCheck(webJid);
    await siblingRun;
  });

  test('conversation-agent DB recovery uses its isolated IPC lane', () => {
    const q = new GroupQueue();
    const agentId = 'recover-agent';
    const databaseJid = `web:${folder}#agent:${agentId}`;
    const cursor1 = { id: 'agent-1', timestamp: '2026-07-22T02:00:00.000Z' };
    const cursor2 = { id: 'agent-2', timestamp: '2026-07-22T02:00:01.000Z' };
    const agentInputDir = path.join(ipcDir, 'agents', agentId, 'input');
    fs.mkdirSync(path.join(agentInputDir, 'inflight'), { recursive: true });
    fs.writeFileSync(
      path.join(agentInputDir, 'queued.json'),
      JSON.stringify({ databaseJid, messageCursors: [cursor1] }),
    );
    fs.writeFileSync(
      path.join(agentInputDir, 'inflight', 'claimed.json'),
      JSON.stringify({ databaseJid, messageCursors: [cursor2] }),
    );

    expect(q.hasUnconsumedAgentIpcInput(folder, agentId)).toBe(true);
    expect(
      q.discardRecoveredAgentIpcInput(folder, agentId, databaseJid, [
        cursor1,
        cursor2,
      ]),
    ).toBe(2);
    expect(q.hasUnconsumedAgentIpcInput(folder, agentId)).toBe(false);
  });

  test('markRunnerActivity refreshes lastActivityAt so IDLE_TIMEOUT reclaims the warm runner', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, { groupFolder: folder, lastActivityAt: 1 });

    const before = Date.now();
    q.markRunnerActivity(jid);
    const after = Date.now();

    const last = getState(q, jid).lastActivityAt as number;
    expect(last).toBeGreaterThanOrEqual(before);
    expect(last).toBeLessThanOrEqual(after);
  });

  test('spawn-style runners are still distinguishable: closing one leaves it inactive', () => {
    // Spawn agents remain fire-and-forget (closeStdin then teardown). This guards
    // that the warm-keeping change is scoped to conversation agents only — an
    // inactive runner must not accept follow-up messages.
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:spawn1`;
    seedRunner(q, jid, {
      active: false,
      groupFolder: folder,
      agentId: 'spawn1',
    });

    expect(q.hasActiveMainRunnerForMessage(jid)).toBe(false);
    expect(q.sendMessage(jid, 'late message')).toBe('no_active');
  });
});

describe('PR #547: cleanupIpcSentinels clears _interrupt alongside _close/_drain', () => {
  const folder = `sentinel-test-${process.pid}-${Date.now()}`;
  const inputDir = path.join(DATA_DIR, 'ipc', folder, 'input');

  afterEach(() => {
    fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
      recursive: true,
      force: true,
    });
  });

  test('removes _drain, _close and _interrupt sentinels', () => {
    fs.mkdirSync(inputDir, { recursive: true });
    for (const name of ['_drain', '_close', '_interrupt']) {
      fs.writeFileSync(path.join(inputDir, name), '');
    }

    const q = new GroupQueue();
    // cleanupIpcSentinels is private; call it the same way the finally blocks do.
    (
      q as unknown as {
        cleanupIpcSentinels(folder: string, agentId?: string | null): void;
      }
    ).cleanupIpcSentinels(folder);

    for (const name of ['_drain', '_close', '_interrupt']) {
      expect(fs.existsSync(path.join(inputDir, name))).toBe(false);
    }
  });
});

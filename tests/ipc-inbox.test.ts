import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  IpcCompletionTracker,
  IpcInbox,
  shouldAcknowledgeQueryEvent,
  shouldStartFreshIpcTurn,
} from '../container/agent-runner/src/ipc-inbox.js';

let root: string;
let inputDir: string;
let inbox: IpcInbox;

function writeMessage(id: string, text = 'follow-up'): string {
  const file = path.join(inputDir, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'message', messageId: id, text }),
  );
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-inbox-'));
  inputDir = path.join(root, 'input');
  inbox = new IpcInbox(inputDir);
  inbox.ensureDirectories();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('durable IPC inbox lifecycle', () => {
  test('claim stays durable until the host retires it', () => {
    const queuedPath = writeMessage('msg-1');

    const claimed = inbox.claimAll();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      messageId: 'msg-1',
      text: 'follow-up',
    });
    expect(fs.existsSync(queuedPath)).toBe(false);
    expect(fs.existsSync(claimed[0].claimPath)).toBe(true);

    expect(fs.existsSync(claimed[0].claimPath)).toBe(true);
  });

  test('startup recovery returns a crashed claim to the visible queue', () => {
    writeMessage('msg-2');
    const [claimed] = inbox.claimAll();
    expect(fs.existsSync(claimed.claimPath)).toBe(true);

    const restartedInbox = new IpcInbox(inputDir);
    expect(restartedInbox.recoverInflight()).toBe(1);
    expect(restartedInbox.hasQueuedMessages()).toBe(true);
    expect(restartedInbox.claimAll()[0].messageId).toBe('msg-2');
  });

  test('requeue recreates an already-acknowledged interrupted message once', () => {
    writeMessage('msg-3');
    const [claimed] = inbox.claimAll();
    fs.unlinkSync(claimed.claimPath); // host ACK retirement

    inbox.requeue(claimed);
    inbox.requeue(claimed);
    const files = fs
      .readdirSync(inputDir)
      .filter((file) => file.endsWith('.json'));
    expect(files).toEqual(['msg-3.json']);
    expect(inbox.claimAll()[0].text).toBe('follow-up');
  });

  test('claim and requeue preserve DB ownership metadata', () => {
    const cursor = {
      id: 'db-message-1',
      timestamp: '2026-07-22T04:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(inputDir, 'owned.json'),
      JSON.stringify({
        type: 'message',
        messageId: 'owned',
        text: 'from Feishu',
        databaseJid: 'feishu:shared-workspace',
        messageCursors: [cursor],
      }),
    );
    const [claimed] = inbox.claimAll();
    expect(claimed).toMatchObject({
      databaseJid: 'feishu:shared-workspace',
      messageCursors: [cursor],
    });

    fs.unlinkSync(claimed.claimPath); // host ACK retirement
    inbox.requeue(claimed);
    expect(inbox.claimAll()[0]).toMatchObject({
      databaseJid: 'feishu:shared-workspace',
      messageCursors: [cursor],
    });
  });

  test('recovery claim filter leaves exact sibling JID envelopes queued', () => {
    for (const [messageId, databaseJid] of [
      ['feishu-message', 'feishu:shared-workspace'],
      ['telegram-message', 'telegram:shared-workspace'],
    ]) {
      fs.writeFileSync(
        path.join(inputDir, `${messageId}.json`),
        JSON.stringify({
          type: 'message',
          messageId,
          text: messageId,
          databaseJid,
        }),
      );
    }

    expect(inbox.claimAll('feishu:shared-workspace')).toEqual([
      expect.objectContaining({
        messageId: 'feishu-message',
        databaseJid: 'feishu:shared-workspace',
      }),
    ]);
    expect(fs.existsSync(path.join(inputDir, 'telegram-message.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(inputDir, 'feishu-message.json'))).toBe(
      false,
    );
  });

  test('invalid envelopes are retired rather than blocking the queue', () => {
    fs.writeFileSync(path.join(inputDir, 'bad.json'), '{not-json');
    expect(inbox.claimAll()).toEqual([]);
    expect(inbox.hasQueuedMessages()).toBe(false);
    expect(fs.readdirSync(inbox.inflightDir)).toEqual([]);
  });

  test('embedded message IDs cannot escape the IPC directory', () => {
    fs.writeFileSync(
      path.join(inputDir, 'safe-file.json'),
      JSON.stringify({
        type: 'message',
        messageId: '../../outside',
        text: 'hello',
      }),
    );
    const [claimed] = inbox.claimAll();
    expect(claimed.messageId).toBe('safe-file');

    fs.unlinkSync(claimed.claimPath); // host ACK retirement
    inbox.requeue(claimed);
    expect(fs.existsSync(path.join(inputDir, 'safe-file.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'outside.json'))).toBe(false);
  });
});

describe('query-start acknowledgement evidence', () => {
  test('provider init is positive acceptance evidence', () => {
    expect(shouldAcknowledgeQueryEvent('init')).toBe(true);
  });

  test('OpenAI HTTP error status never acknowledges the message', () => {
    expect(shouldAcknowledgeQueryEvent('status')).toBe(false);
  });

  test('a generator return without init never acknowledges the message', () => {
    expect(shouldAcknowledgeQueryEvent('result')).toBe(false);
  });
});

describe('post-result IPC turn routing', () => {
  test('late messages start a fresh turn after an ordinary final result', () => {
    expect(shouldStartFreshIpcTurn(1, 0, true)).toBe(true);
  });

  test('messages remain queued while background tasks await summary', () => {
    expect(shouldStartFreshIpcTurn(1, 1, true)).toBe(false);
  });

  test('pre-result messages remain queued instead of entering the active query', () => {
    expect(shouldStartFreshIpcTurn(0, 0, true)).toBe(false);
  });

  test('a warm message is claimed only by its fresh turn', () => {
    const queuedPath = writeMessage('side-effect-once');
    let toolCalls = 0;

    // Old query is still running: the envelope remains durable and cannot
    // execute in that query.
    expect(shouldStartFreshIpcTurn(0, 0, true)).toBe(false);
    expect(fs.existsSync(queuedPath)).toBe(true);

    // Old query finishes, then exactly one fresh query claims and executes it.
    expect(shouldStartFreshIpcTurn(1, 0, true)).toBe(true);
    const [claimed] = inbox.claimAll();
    toolCalls++;
    fs.unlinkSync(claimed.claimPath); // host receives the fresh-query ACK

    const tracker = new IpcCompletionTracker();
    tracker.trackInitial([claimed.messageId]);
    expect(tracker.advanceResult()).toEqual(['side-effect-once']);
    expect(tracker.advanceResult()).toEqual([]);
    expect(inbox.claimAll()).toEqual([]);
    expect(inbox.recoverInflight()).toBe(0);
    expect(toolCalls).toBe(1);
  });

  test('an active-query failure leaves the unclaimed warm message for restart', () => {
    const queuedPath = writeMessage('restart-once');
    expect(shouldStartFreshIpcTurn(0, 0, true)).toBe(false);
    expect(fs.existsSync(queuedPath)).toBe(true);

    const restartedInbox = new IpcInbox(inputDir);
    const claimed = restartedInbox.claimAll();
    expect(claimed.map((message) => message.messageId)).toEqual([
      'restart-once',
    ]);
    expect(restartedInbox.claimAll()).toEqual([]);
  });

  test('a fresh-query crash before SDK init recovers the claim without executing it twice', () => {
    writeMessage('crash-before-init');
    const [firstClaim] = inbox.claimAll();
    expect(fs.existsSync(firstClaim.claimPath)).toBe(true);
    let toolCalls = 0; // provider init has not happened, so no tool can run

    const restartedInbox = new IpcInbox(inputDir);
    expect(restartedInbox.recoverInflight()).toBe(1);
    const [recoveredClaim] = restartedInbox.claimAll();
    toolCalls++;
    fs.unlinkSync(recoveredClaim.claimPath); // SDK init ACK reaches host

    const recoveredTurn = new IpcCompletionTracker();
    recoveredTurn.trackInitial([recoveredClaim.messageId]);
    expect(recoveredTurn.advanceResult()).toEqual(['crash-before-init']);
    expect(restartedInbox.recoverInflight()).toBe(0);
    expect(restartedInbox.claimAll()).toEqual([]);
    expect(toolCalls).toBe(1);
  });
});

describe('IPC completion/result correlation', () => {
  test('initial claims complete with the first accepted result', () => {
    const tracker = new IpcCompletionTracker();
    tracker.trackInitial(['initial']);
    expect(tracker.advanceResult()).toEqual(['initial']);
  });

  test('an intermediate Workflow result cannot commit the initial claim', () => {
    const tracker = new IpcCompletionTracker();
    tracker.trackInitial(['workflow']);
    expect(tracker.advanceResult(false)).toEqual([]);
    expect(tracker.hasPending).toBe(true);
    expect(tracker.advanceResult()).toEqual(['workflow']);
    expect(tracker.hasPending).toBe(false);
  });

  test.each(['truncated', 'overflow_partial', 'compact_partial'])(
    '%s retains the completion ID for the healthy continuation query',
    () => {
      const logicalTurn = new IpcCompletionTracker();
      logicalTurn.trackInitial(['warm-follow-up']);

      // First runQuery emits an intermediate result.
      expect(logicalTurn.advanceResult(false)).toEqual([]);
      expect(logicalTurn.hasPending).toBe(true);

      // A separate continuation runQuery shares the same logical-turn tracker.
      expect(logicalTurn.advanceResult(true)).toEqual(['warm-follow-up']);
      expect(logicalTurn.hasPending).toBe(false);
      expect(logicalTurn.advanceResult(true)).toEqual([]);
    },
  );

  test('a crash between partial and continuation never records a false completion', () => {
    const crashedTurn = new IpcCompletionTracker();
    crashedTurn.trackInitial(['retry-once']);
    expect(crashedTurn.advanceResult(false)).toEqual([]);
    expect(crashedTurn.hasPending).toBe(true);

    // The host replays from its committed DB cursor after runner restart.
    const recoveredTurn = new IpcCompletionTracker();
    recoveredTurn.trackInitial(['retry-once']);
    expect(recoveredTurn.advanceResult()).toEqual(['retry-once']);
    expect(recoveredTurn.advanceResult()).toEqual([]);
  });
});

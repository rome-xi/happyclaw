import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  IpcInbox,
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
  test('claim keeps the message durable until explicit acknowledgement', () => {
    const queuedPath = writeMessage('msg-1');

    const claimed = inbox.claimAll();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      messageId: 'msg-1',
      text: 'follow-up',
    });
    expect(fs.existsSync(queuedPath)).toBe(false);
    expect(fs.existsSync(claimed[0].claimPath)).toBe(true);

    expect(inbox.acknowledge(claimed)).toEqual(['msg-1']);
    expect(fs.existsSync(claimed[0].claimPath)).toBe(false);
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
    inbox.acknowledge([claimed]);

    inbox.requeue(claimed);
    inbox.requeue(claimed);
    const files = fs
      .readdirSync(inputDir)
      .filter((file) => file.endsWith('.json'));
    expect(files).toEqual(['msg-3.json']);
    expect(inbox.claimAll()[0].text).toBe('follow-up');
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

    inbox.acknowledge([claimed]);
    inbox.requeue(claimed);
    expect(fs.existsSync(path.join(inputDir, 'safe-file.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'outside.json'))).toBe(false);
  });
});

describe('post-result IPC turn routing', () => {
  test('late messages start a fresh turn after an ordinary final result', () => {
    expect(shouldStartFreshIpcTurn(1, 0, true)).toBe(true);
  });

  test('messages stay on the live stream while background tasks await summary', () => {
    expect(shouldStartFreshIpcTurn(1, 1, true)).toBe(false);
  });

  test('pre-result messages continue using active pipe-in', () => {
    expect(shouldStartFreshIpcTurn(0, 0, true)).toBe(false);
  });
});

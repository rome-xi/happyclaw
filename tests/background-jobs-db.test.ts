import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Isolate DB to a temp dir (mirrors db-transactions.test.ts)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-jobs-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return { STORE_DIR: tmpStoreDir, GROUPS_DIR: tmpGroupsDir };
});

const {
  initDatabase,
  updateAgentProgress,
  listBackgroundAgents,
  getBackgroundJob,
  updateAgentDispatchedFrom,
} = await import('../src/db.js');

const dbPath = path.join(tmpStoreDir, 'messages.db');
let wdb: InstanceType<typeof Database>;

function insertAgent(row: {
  id: string;
  chat_jid: string;
  kind: string;
  name?: string;
  dispatched_from_agent_jid?: string | null;
}) {
  wdb
    .prepare(
      `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, created_at, kind, dispatched_from_agent_jid)
       VALUES (@id, 'home-x', @chat_jid, @name, 'p', 'running', @created_at, @kind, @dispatched_from_agent_jid)`,
    )
    .run({
      id: row.id,
      chat_jid: row.chat_jid,
      name: row.name ?? row.id,
      created_at: new Date().toISOString(),
      kind: row.kind,
      dispatched_from_agent_jid: row.dispatched_from_agent_jid ?? null,
    });
}

beforeAll(() => {
  initDatabase();
  wdb = new Database(dbPath);
});

afterAll(() => {
  if (wdb) wdb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  wdb.prepare('DELETE FROM agents').run();
});

describe('Phase-1 background-job progress DB layer', () => {
  test('migration added progress columns', () => {
    const cols = (wdb.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'progress_summary',
        'progress_pct',
        'progress_updated_at',
        'dispatched_from_agent_jid',
      ]),
    );
  });

  test('updateAgentProgress round-trips summary + pct + updated_at', () => {
    insertAgent({ id: 'job1', chat_jid: 'web:home-x', kind: 'background' });
    updateAgentProgress('job1', '分析进行中 3/10', 30);
    const row = wdb.prepare('SELECT * FROM agents WHERE id = ?').get('job1') as Record<
      string,
      unknown
    >;
    expect(row.progress_summary).toBe('分析进行中 3/10');
    expect(row.progress_pct).toBe(30);
    expect(typeof row.progress_updated_at).toBe('string');
    expect(typeof row.last_active_at).toBe('string');
  });

  test('listBackgroundAgents returns only background kind, newest first', () => {
    insertAgent({ id: 'bg1', chat_jid: 'web:home-x', kind: 'background' });
    insertAgent({ id: 'bg2', chat_jid: 'web:home-x', kind: 'background' });
    insertAgent({ id: 'task1', chat_jid: 'web:home-x', kind: 'task' });
    const jobs = listBackgroundAgents('web:home-x');
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain('bg1');
    expect(ids).toContain('bg2');
    expect(ids).not.toContain('task1');
  });

  test('listBackgroundAgents filters by dispatching foreground JID', () => {
    insertAgent({
      id: 'mine',
      chat_jid: 'web:home-x',
      kind: 'background',
      dispatched_from_agent_jid: 'web:home-x#agent:fg',
    });
    insertAgent({
      id: 'theirs',
      chat_jid: 'web:home-x',
      kind: 'background',
      dispatched_from_agent_jid: 'web:home-x#agent:other',
    });
    const mine = listBackgroundAgents('web:home-x', 'web:home-x#agent:fg');
    expect(mine.map((j) => j.id)).toEqual(['mine']);
  });

  test('getBackgroundJob fetches one job and ignores non-background kinds', () => {
    insertAgent({ id: 'bgX', chat_jid: 'web:home-x', kind: 'background' });
    insertAgent({ id: 'spawnX', chat_jid: 'web:home-x', kind: 'spawn' });
    updateAgentProgress('bgX', '半程', 50);

    const job = getBackgroundJob('bgX');
    expect(job).toBeDefined();
    expect(job?.id).toBe('bgX');
    expect(job?.progress_summary).toBe('半程');
    expect(job?.progress_pct).toBe(50);

    // A spawn-kind agent is not a background job.
    expect(getBackgroundJob('spawnX')).toBeUndefined();
    // Unknown id.
    expect(getBackgroundJob('nope')).toBeUndefined();
  });

  test('updateAgentDispatchedFrom stamps the dispatching JID post-create', () => {
    insertAgent({ id: 'bgD', chat_jid: 'web:home-x', kind: 'background' });
    updateAgentDispatchedFrom('bgD', 'web:home-x#agent:fg2');

    const job = getBackgroundJob('bgD');
    expect(job?.dispatched_from_agent_jid).toBe('web:home-x#agent:fg2');

    // And it becomes discoverable via the mine-only filter.
    const mine = listBackgroundAgents('web:home-x', 'web:home-x#agent:fg2');
    expect(mine.map((j) => j.id)).toContain('bgD');
  });
});

/**
 * Regression for the "provider disabled but sessions left stranded" bug.
 *
 * When a provider is toggled OFF (or deleted), every session sticky-bound to it
 * can no longer resume cleanly — the transcript (incl. thinking-block
 * signatures) belongs to that upstream, so resuming on a different provider
 * fails with "Invalid signature in thinking block". Before the fix the toggle
 * route only stopped containers and never dropped those bindings, so the DB was
 * left pointing at a dead provider and self-heal was deferred to spawn time.
 *
 * These tests pin the route wiring: toggle-off and delete must clear ONLY the
 * bindings pointing at the affected provider, leaving unrelated ones intact.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-provider-toggle-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpRoot,
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
    STORE_DIR: path.join(tmpRoot, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// Avoid loading the full Hono app (web.ts) which would form an import cycle
// with configRoutes and pull in every channel adapter.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  broadcastAgentStatus: () => {},
  broadcastToClients: () => {},
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', { id: 'admin', username: 'admin', role: 'admin' });
      return next();
    },
    systemConfigMiddleware: async (_c: any, next: any) => next(),
  };
});

const db = await import('../src/db.ts');
const runtimeConfig = await import('../src/runtime-config.ts');
const configModule = await import('../src/routes/config.ts');
const configRoutes = configModule.default;
const injectConfigDeps = configModule.injectConfigDeps;

let providerA: string;
let providerB: string;

beforeAll(() => {
  db.initDatabase();
  // stopGroup is the only dep the toggle/delete path touches; a no-op is enough.
  injectConfigDeps({
    getRegisteredGroups: () => ({}),
    queue: { stopGroup: async () => {} },
    sessions: {},
  });
  const a = runtimeConfig.createProvider({
    name: 'prov-A',
    type: 'third_party',
    anthropicBaseUrl: 'https://a.example.com',
    anthropicAuthToken: 'ak-aaaa',
    anthropicModel: 'claude-opus-4-8',
    enabled: true,
  });
  const b = runtimeConfig.createProvider({
    name: 'prov-B',
    type: 'third_party',
    anthropicBaseUrl: 'https://b.example.com',
    anthropicAuthToken: 'ak-bbbb',
    anthropicModel: 'claude-opus-4-8',
    enabled: true,
  });
  providerA = a.id;
  providerB = b.id;
});

beforeEach(() => {
  db.deleteAllSessionsForFolder('folder-a');
  db.deleteAllSessionsForFolder('folder-b');
  // Re-enable both providers so each test starts from a clean two-enabled state.
  for (const id of [providerA, providerB]) {
    const p = runtimeConfig.getProviders().find((x) => x.id === id);
    if (p && !p.enabled) runtimeConfig.toggleProvider(id);
  }
});

async function call(method: string, urlPath: string): Promise<Response> {
  return configRoutes.request(urlPath, { method });
}

describe('POST /claude/providers/:id/toggle — disabling clears stranded sessions', () => {
  test('toggle OFF drops bindings to that provider only', async () => {
    db.setSession('folder-a', 'sess-a', '');
    db.setSessionProviderId('folder-a', '', providerA);
    db.setSession('folder-b', 'sess-b', '');
    db.setSessionProviderId('folder-b', '', providerB);

    const res = await call('POST', `/claude/providers/${providerA}/toggle`);
    expect(res.status).toBe(200);

    // Provider A disabled → its binding is gone; B untouched.
    expect(db.getSessionProviderId('folder-a', '')).toBeUndefined();
    expect(db.getSessionProviderId('folder-b', '')).toBe(providerB);
  });

  test('toggle ON does not touch any bindings', async () => {
    // Disable A first (clears folder-a), then re-bind and re-enable.
    runtimeConfig.toggleProvider(providerA);
    db.setSession('folder-b', 'sess-b', '');
    db.setSessionProviderId('folder-b', '', providerB);

    const res = await call('POST', `/claude/providers/${providerA}/toggle`);
    expect(res.status).toBe(200);

    // Enabling invalidates nothing — B's binding survives.
    expect(db.getSessionProviderId('folder-b', '')).toBe(providerB);
  });
});

describe('DELETE /claude/providers/:id — deletion clears stranded sessions', () => {
  test('deleting a provider drops its bindings only', async () => {
    const doomed = runtimeConfig.createProvider({
      name: 'prov-doomed',
      type: 'third_party',
      anthropicBaseUrl: 'https://doomed.example.com',
      anthropicAuthToken: 'ak-dddd',
      anthropicModel: 'claude-opus-4-8',
      enabled: false,
    });
    db.setSession('folder-a', 'sess-a', '');
    db.setSessionProviderId('folder-a', '', doomed.id);
    db.setSession('folder-b', 'sess-b', '');
    db.setSessionProviderId('folder-b', '', providerB);

    const res = await call('DELETE', `/claude/providers/${doomed.id}`);
    expect(res.status).toBe(200);

    expect(db.getSessionProviderId('folder-a', '')).toBeUndefined();
    expect(db.getSessionProviderId('folder-b', '')).toBe(providerB);
  });
});

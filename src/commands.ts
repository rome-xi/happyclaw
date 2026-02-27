/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { deleteSession, getJidsByFolder, storeMessageDirect, ensureChatExists } from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
}

// ─── Session file cleanup (mirrors groups.ts clearSessionJsonlFiles) ────

function clearSessionFiles(folder: string): void {
  const claudeDir = path.join(DATA_DIR, 'sessions', folder, '.claude');
  if (!fs.existsSync(claudeDir)) return;

  const keep = new Set(['settings.json']);
  const entries = fs.readdirSync(claudeDir);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ entry, folder, err }, 'Failed to remove session file, skipping');
    }
  }
}

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  chatJid: string,
  folder: string,
  deps: CommandDeps,
): Promise<void> {
  const siblingJids = getJidsByFolder(folder);

  // 1. Stop all running containers/processes for this folder
  await Promise.all(siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })));

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder);

  // 3. Delete session from DB + in-memory cache
  deleteSession(folder);
  delete deps.sessions[folder];

  // 4. Insert context_reset divider message
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(chatJid);
  storeMessageDirect(
    dividerMessageId,
    chatJid,
    '__system__',
    'system',
    'context_reset',
    timestamp,
    true,
  );

  deps.broadcast(chatJid, {
    id: dividerMessageId,
    chat_jid: chatJid,
    sender: '__system__',
    sender_name: 'system',
    content: 'context_reset',
    timestamp,
    is_from_me: true,
  });

  logger.info({ chatJid, folder, siblingJids }, 'Session reset via /clear command');
}

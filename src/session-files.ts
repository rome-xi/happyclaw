/**
 * Session file cleanup — shared between the Web UI reset-session route and the
 * IM `/clear` slash command. Removes everything under `data/sessions/{folder}/.claude/`
 * (or the agent-scoped subdir) except `settings.json`, which the container
 * runner recreates anyway but is cheap to preserve.
 *
 * Errors on individual entries are logged and skipped so a single permission
 * problem (e.g. on a stale symlink) doesn't abort the whole reset.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export function clearSessionFiles(folder: string, agentId?: string): void {
  const claudeDir = agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', folder, '.claude');
  if (!fs.existsSync(claudeDir)) return;

  const keep = new Set(['settings.json']);
  for (const entry of fs.readdirSync(claudeDir)) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(claudeDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}

/**
 * Clear every Claude SDK session in a workspace (main + conversation/background
 * agent directories). A workspace-level model switch uses this because the new
 * model is inherited by every lane and old thinking signatures are not safely
 * portable across providers/models.
 */
export function clearAllSessionFiles(folder: string): void {
  clearSessionFiles(folder);
  const agentsDir = path.join(DATA_DIR, 'sessions', folder, 'agents');
  if (!fs.existsSync(agentsDir)) return;
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    clearSessionFiles(folder, entry.name);
  }
}

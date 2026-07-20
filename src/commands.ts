/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  deleteSession,
  getJidsByFolder,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { logger } from './logger.js';
import { clearSessionFiles } from './session-files.js';
import type { NewMessage, MessageCursor } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: { stopGroup(jid: string, opts?: { force?: boolean }): Promise<void> };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  /**
   * Mark a chat JID for recovery so the next query re-injects recent DB history
   * into a fresh SDK session. Used by /compact (context-preserving) but NOT by
   * /clear (which advances the cursor and intentionally forgets history).
   */
  markForRecovery?: (jid: string) => void;
}

// ─── Command parsing ────────────────────────────────────────────

export function isClearCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/clear';
}

export function isCompactCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/compact';
}

/**
 * `/compact <instructions>` 带参数形态 —— **真压缩**入口。
 *
 * 裸 `/compact`（无 arg）走假压缩（`executeSessionReset` mode='compact'，删掉
 * SDK session JSONL + 从 DB 重灌历史）；`/compact <text>` 带 arg 走真压缩：
 * 不在入口层拦截，让文本以 `/compact <text>` 形态直接进入消息管道 → IPC →
 * agent-runner 下一轮 runQuery 作为 prompt → SDK/CLI 识别为内建 slash 命令
 * 执行真压缩（LLM 生成摘要 + `compact_boundary` + `PreCompact` hook trigger='manual'
 * 且 custom_instructions=<text>）。
 *
 * agent-runner 端要求：检测到 slash 命令时必须**跳过 `[当前时间:]` 前缀**
 * （见 container/agent-runner/src/index.ts runQuery 时间前缀注入），否则消息
 * 不以 `/` 开头 CLI 就无法识别为内建命令。
 */
export function isCompactWithArgsCommand(content: string): boolean {
  const t = content.trim();
  // `/compact` 后至少一个空白 + 至少一个非空字符 = 有 instructions
  return /^\/compact\s+\S/i.test(t);
}

export const SESSION_RESET_FAILURE_MESSAGE =
  'system_error:清除上下文失败，请稍后重试';

export const SESSION_COMPACT_FAILURE_MESSAGE =
  'system_error:压缩上下文失败，请稍后重试';

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  baseChatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
  mode: 'clear' | 'compact' = 'clear',
): Promise<void> {
  const targetJid = agentId ? `${baseChatJid}#agent:${agentId}` : baseChatJid;

  if (agentId) {
    // Agent-specific reset: only stop the agent's virtual JID process
    await deps.queue.stopGroup(targetJid, { force: true });
  } else {
    // Main session reset: stop all processes for this folder
    const siblingJids = getJidsByFolder(folder);
    await Promise.all(
      siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })),
    );
  }

  // 2. Clear .claude/ session files (preserve settings.json). Both /clear and
  //    /compact drop the (potentially bloated) SDK session JSONL — the only
  //    difference is what happens to the HappyClaw message cursor afterwards.
  clearSessionFiles(folder, agentId);

  // 3. Delete session from DB (+ in-memory cache for main session)
  deleteSession(folder, agentId);
  if (!agentId) {
    delete deps.sessions[folder];
  }

  // 4. Insert a divider message into the correct JID. /clear uses
  //    context_reset (hard reset, history forgotten); /compact uses
  //    context_compacted (session slimmed, history re-injected next turn).
  const dividerContent =
    mode === 'compact' ? 'context_compacted' : 'context_reset';
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(targetJid);
  storeMessageDirect(
    dividerMessageId,
    targetJid,
    '__system__',
    'system',
    dividerContent,
    timestamp,
    true,
  );

  deps.broadcast(targetJid, {
    id: dividerMessageId,
    chat_jid: targetJid,
    sender: '__system__',
    sender_name: 'system',
    content: dividerContent,
    timestamp,
    is_from_me: true,
  });

  if (mode === 'compact') {
    // /compact preserves context: DON'T advance the cursor. Instead flag the
    // chat(s) for recovery so the next query re-injects recent DB history into
    // the fresh (slim) SDK session. Agent sessions re-inject automatically when
    // getSession() returns undefined, so markForRecovery only matters for main
    // conversations, but we call it for the affected JIDs uniformly.
    if (deps.markForRecovery) {
      if (agentId) {
        deps.markForRecovery(targetJid);
      } else {
        for (const siblingJid of getJidsByFolder(folder)) {
          deps.markForRecovery(siblingJid);
        }
      }
    }
    logger.info(
      { baseChatJid, targetJid, folder, agentId },
      'Session compacted via /compact command',
    );
    return;
  }

  // 5. (/clear only) Advance lastAgentTimestamp so old messages before the
  //    reset are not re-sent to the next fresh agent session.
  if (agentId) {
    deps.setLastAgentTimestamp(targetJid, { timestamp, id: dividerMessageId });
  } else {
    const siblingJids = getJidsByFolder(folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, {
        timestamp,
        id: dividerMessageId,
      });
    }
  }

  logger.info(
    { baseChatJid, targetJid, folder, agentId },
    'Session reset via /clear command',
  );
}

/**
 * Telegram Streaming Edit Controller
 *
 * Implements the same duck-typed public API as DiscordStreamingEditController /
 * DingTalkStreamingCardController so that `feedStreamEventToCard()` (index.ts)
 * can drive it without modification.
 *
 * Telegram message edit lifecycle:
 *   1. sendStreamingMessage()  — create initial placeholder, get message_id
 *   2. editStreamingMessage()  — throttled streaming updates (1500ms, plain text)
 *   3. editStreamingMessage()  — final content as HTML (split into multiple
 *      messages if it exceeds the per-message limit)
 *
 * Design notes vs. Discord:
 *   - Telegram throttles edits harder than sends, so the stream interval is
 *     1500ms (vs Discord's 500ms) and no-op edits are skipped.
 *   - Mid-stream content is pushed as PLAIN TEXT — partial markdown often has
 *     unclosed code fences that would break HTML parsing. Only the final
 *     complete() render runs through markdownToTelegramHtml (with plain-text
 *     fallback handled inside editStreamingMessage).
 *   - The auxiliary prefix (thinking / tools / recent-events) is where Workflow
 *     and Task progress surfaces in Telegram: feedStreamEventToCard pushes
 *     `🚀/🔄/✅ Task: ...` lines via pushRecentEvent.
 */

import { logger } from './logger.js';

// ─── Constants ───────────────────────────────────────────────

const STREAM_UPDATE_INTERVAL = 900; // ms — Telegram edit rate limit is strict;
// kept under ~1/s but tighter than before for a livelier feel. The transport
// honors 429 retry_after (see editStreamingMessage), so an occasional flood is
// absorbed instead of crashing the stream.
const AUX_FLUSH_INTERVAL = 1200; // ms
// Telegram hard limit is 4096 chars; leave headroom for HTML tag overhead.
const TG_MSG_LIMIT = 3800;
const MAX_THINKING_CHARS = 500;
const MAX_TOOLS_DISPLAY = 5;
const MAX_TOOL_SUMMARY_CHARS = 60;
const MAX_RECENT_EVENTS = 5;

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface TelegramStreamingOpts {
  /** Called with the first message id once the placeholder is created. */
  onCardCreated?: (messageId: string) => void;
  /** Last-resort fallback: send the text as a normal (non-streaming) message. */
  fallbackSend?: (text: string) => Promise<void>;
}

/** Primitives the controller needs from the Telegram connection. */
export interface TelegramStreamingTransport {
  /** Send the initial placeholder, returns its message_id (or null on failure). */
  createMessage(text: string): Promise<number | null>;
  /** Edit a message in place. asHtml=true → final HTML render. */
  editMessage(messageId: number, text: string, asHtml: boolean): Promise<void>;
}

// ─── Controller ──────────────────────────────────────────────

export class TelegramStreamingEditController {
  private state: StreamingState = 'idle';
  private transport: TelegramStreamingTransport;
  private onCardCreated?: (messageId: string) => void;
  private fallbackSend: ((text: string) => Promise<void>) | null;

  // Message ids — may grow to multiple if final text exceeds the limit.
  private messageIds: number[] = [];
  private accumulatedText = '';

  // Throttle (main text)
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Throttle (auxiliary)
  private auxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAuxFlushTime = 0;

  // Auxiliary state (thinking / tools / status / recent events)
  private thinking = false;
  private thinkingText = '';
  private systemStatus: string | null = null;
  private tools = new Map<
    string,
    {
      name: string;
      status: 'running' | 'complete' | 'error';
      startTime: number;
      summary?: string;
    }
  >();
  private recentEvents: string[] = [];

  // Guards
  private fallbackUsed = false;
  private messageCreationPromise: Promise<void> | null = null;
  // Last content pushed to Telegram (incl. aux prefix) — skip no-op edits to
  // conserve the edit rate budget.
  private lastPushedContent: string | null = null;

  constructor(
    transport: TelegramStreamingTransport,
    opts?: TelegramStreamingOpts,
  ) {
    this.transport = transport;
    this.onCardCreated = opts?.onCardCreated;
    this.fallbackSend = opts?.fallbackSend ?? null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  isActive(): boolean {
    return (
      this.state === 'idle' ||
      this.state === 'creating' ||
      this.state === 'streaming'
    );
  }

  append(text: string): void {
    if (!this.isActive()) return;
    this.accumulatedText = text; // Full replacement (same as Discord/DingTalk)
    this.thinkingText = '';
    this.thinking = false;
    this.scheduleFlush();
  }

  async complete(finalText: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    this.accumulatedText = finalText;
    this.clearTimers();

    if (!finalText.trim()) {
      this.state = 'completed';
      return;
    }

    try {
      await this.ensureMessage();
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        'Telegram ensureMessage failed in complete()',
      );
      await this.tryFallback(finalText);
      this.state = 'completed';
      return;
    }

    if (this.messageIds.length === 0) {
      await this.tryFallback(finalText);
      this.state = 'completed';
      return;
    }

    try {
      // Final render: clean body only (drop aux prefix), as HTML.
      this.thinkingText = '';
      this.thinking = false;
      await this.splitAndSend(finalText);
      this.state = 'completed';
      logger.info(
        { messageCount: this.messageIds.length },
        'Telegram streaming edit completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        'Telegram streaming edit finalize failed, degrading',
      );
      await this.tryFallback(finalText);
      this.state = 'error';
    }
  }

  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    this.clearTimers();

    const displayText = this.accumulatedText
      ? this.accumulatedText + `\n\n⚠️ 已中断: ${reason ?? '用户取消'}`
      : `⚠️ 已中断: ${reason ?? '用户取消'}`;

    if (this.messageIds.length === 0) {
      this.state = 'aborted';
      return;
    }

    try {
      const lastId = this.messageIds[this.messageIds.length - 1];
      const truncated = displayText.slice(-TG_MSG_LIMIT);
      await this.transport.editMessage(lastId, truncated, false);
    } catch (err: any) {
      logger.debug(
        { err: err?.message },
        'Telegram streaming edit abort update failed',
      );
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearTimers();
  }

  // ─── Auxiliary display ─────────────────────────────────────

  setThinking(): void {
    this.thinking = true;
    if (this.messageIds.length === 0 && this.state === 'idle') {
      this.state = 'creating';
      this.ensureMessage().catch(() => {
        this.state = 'error';
      });
    }
  }

  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;
    if (this.messageIds.length === 0 && this.state === 'idle') {
      this.state = 'creating';
      this.ensureMessage().catch(() => {
        this.state = 'error';
      });
    } else if (this.state === 'streaming') {
      this.scheduleAuxFlush();
    }
  }

  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  setHook(_hook: { hookName: string; hookEvent: string } | null): void {
    // Hooks are not rendered in Telegram — skip.
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Todos are too verbose for Telegram messages — skip.
  }

  pushRecentEvent(text: string): void {
    // Strip any HTML-ish font tags that Feishu-oriented callers may include.
    const clean = text.replace(/<\/?font[^>]*>/g, '');
    this.recentEvents.push(clean);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENTS);
    }
    // Piggyback on other flushes; but if we're streaming and nothing else is
    // scheduled, nudge an aux flush so Workflow/Task progress shows promptly.
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  startTool(toolId: string, toolName: string): void {
    this.tools.set(toolId, {
      name: toolName,
      status: 'running',
      startTime: Date.now(),
    });
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  endTool(toolId: string, isError: boolean): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.status = isError ? 'error' : 'complete';
      this.purgeOldTools();
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  updateToolSummary(toolId: string, summary: string): void {
    const tc = this.tools.get(toolId);
    if (tc) {
      tc.summary = summary;
      if (this.state === 'streaming') this.scheduleAuxFlush();
    }
  }

  getToolInfo(toolId: string): { name: string } | undefined {
    return this.tools.get(toolId);
  }

  async patchUsageNote(_usage: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
  }): Promise<void> {
    // Usage notes are not meaningful for Telegram messages — no-op.
  }

  getAllMessageIds(): string[] {
    return this.messageIds.map((id) => String(id));
  }

  // ─── Auxiliary build ───────────────────────────────────────

  /**
   * Build the auxiliary block (thinking + tools + recent events) as plain text.
   *
   * Rendered as a SUFFIX below the body (see composeContent): body stays at the
   * top where it's readable, progress sits underneath. This is what keeps the
   * card from looking "frozen" while a backgrounded turn waits on a Task — the
   * user sees stable body text up top, not a wall of static progress lines with
   * the reply buried beneath them.
   */
  private buildAuxBlock(): string {
    const parts: string[] = [];

    if (this.systemStatus) {
      parts.push(`⏳ ${this.systemStatus}`);
    }

    if (this.thinkingText) {
      const label = this.thinking ? '💭 思考中...' : '💭 已思考';
      const truncated =
        this.thinkingText.length > MAX_THINKING_CHARS
          ? '...' + this.thinkingText.slice(-(MAX_THINKING_CHARS - 3))
          : this.thinkingText;
      parts.push(`${label}\n${truncated}`);
    } else if (this.thinking) {
      parts.push('💭 思考中...');
    }

    const now = Date.now();
    const display: Array<{
      name: string;
      status: string;
      elapsed: string;
      summary?: string;
    }> = [];
    for (const [, tc] of this.tools) {
      if (display.length >= MAX_TOOLS_DISPLAY) break;
      display.push({
        name: tc.name,
        status: tc.status,
        elapsed: TelegramStreamingEditController.formatElapsed(
          now - tc.startTime,
        ),
        summary: tc.summary,
      });
    }
    if (display.length > 0) {
      const lines = display.map((d) => {
        const icon =
          d.status === 'running' ? '🔄' : d.status === 'complete' ? '✅' : '❌';
        const summary = d.summary
          ? `  ${
              d.summary.length > MAX_TOOL_SUMMARY_CHARS
                ? d.summary.slice(0, MAX_TOOL_SUMMARY_CHARS) + '...'
                : d.summary
            }`
          : '';
        return `${icon} ${d.name} (${d.elapsed})${summary}`;
      });
      parts.push(lines.join('\n'));
    }

    if (this.recentEvents.length > 0) {
      const eventLines = this.recentEvents.map((e) => `- ${e}`);
      parts.push(`📝 调用轨迹\n${eventLines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  /**
   * Compose the mid-stream message: body on top, progress block underneath.
   * When there is no body yet (pure thinking/tool phase), the aux block stands
   * alone as a placeholder so the card isn't empty.
   */
  private composeContent(): string {
    const aux = this.buildAuxBlock();
    const body = this.accumulatedText;
    if (!body.trim()) return aux;
    if (!aux) return body;
    return `${body}\n\n———\n\n${aux}`;
  }

  private static formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    return `${min}m ${Math.floor(sec % 60)}s`;
  }

  private purgeOldTools(): void {
    const cutoff = Date.now() - 30_000;
    for (const [id, tc] of this.tools) {
      if (tc.status !== 'running' && tc.startTime < cutoff) {
        this.tools.delete(id);
      }
    }
  }

  // ─── Internal: message creation ────────────────────────────

  private async ensureMessage(): Promise<void> {
    if (this.messageIds.length > 0) return;
    if (this.messageCreationPromise) {
      await this.messageCreationPromise;
      return;
    }

    this.state = 'creating';
    this.messageCreationPromise = (async () => {
      try {
        const id = await this.transport.createMessage('💭 思考中...');
        if (id == null) {
          this.state = 'error';
          return;
        }
        this.messageIds.push(id);
        this.state = 'streaming';
        if (this.onCardCreated) this.onCardCreated(String(id));
      } catch (err: any) {
        logger.warn(
          { err: err?.message },
          'Telegram initial streaming message creation failed',
        );
        this.state = 'error';
      } finally {
        this.messageCreationPromise = null;
      }
    })();

    try {
      await this.messageCreationPromise;
    } catch {
      // Already handled inside the promise.
    }
  }

  // ─── Internal: streaming flush ─────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, STREAM_UPDATE_INTERVAL - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.doFlush().catch((err: any) => {
        logger.debug(
          { err: err?.message },
          'Telegram streaming edit flush failed',
        );
      });
    }, delay);
  }

  private scheduleAuxFlush(): void {
    if (this.auxFlushTimer) return;
    const elapsed = Date.now() - this.lastAuxFlushTime;
    const delay = Math.max(0, AUX_FLUSH_INTERVAL - elapsed);
    this.auxFlushTimer = setTimeout(() => {
      this.auxFlushTimer = null;
      if (this.state === 'completed' || this.state === 'aborted') return;
      this.lastAuxFlushTime = Date.now();
      const content = this.composeContent();
      this.editLast(content).catch((err: any) => {
        logger.debug({ err: err?.message }, 'Telegram aux flush failed');
      });
    }, delay);
  }

  private async doFlush(): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    if (!this.accumulatedText.trim() && !this.thinking && !this.systemStatus) {
      return;
    }
    if (this.state === 'error') {
      await this.tryFallback(this.accumulatedText);
      return;
    }

    await this.ensureMessage();
    if (this.messageIds.length === 0) {
      await this.tryFallback(this.accumulatedText);
      return;
    }

    let content = this.composeContent();
    // Mid-stream: keep the HEAD (body lives on top now) if over the limit; the
    // full code-fence-aware split only runs at complete().
    if (content.length > TG_MSG_LIMIT) {
      content = content.slice(0, TG_MSG_LIMIT - 3) + '...';
    }
    await this.editLast(content);
    this.lastUpdateTime = Date.now();
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.auxFlushTimer) {
      clearTimeout(this.auxFlushTimer);
      this.auxFlushTimer = null;
    }
  }

  /** Edit the last message in the chain (plain text, mid-stream). */
  private async editLast(content: string): Promise<void> {
    if (this.messageIds.length === 0) return;
    const payload = content || '​';
    if (payload === this.lastPushedContent) return;
    const lastId = this.messageIds[this.messageIds.length - 1];
    await this.transport.editMessage(lastId, payload, false);
    this.lastPushedContent = payload;
  }

  /**
   * Final render: split into chunks preserving code fences, edit existing
   * messages and send new ones as needed, all as HTML.
   */
  private async splitAndSend(fullContent: string): Promise<void> {
    const chunks = splitWithCodeFences(fullContent, TG_MSG_LIMIT);
    let firstError: Error | null = null;

    for (let i = 0; i < chunks.length; i++) {
      if (i < this.messageIds.length) {
        try {
          await this.transport.editMessage(this.messageIds[i], chunks[i], true);
        } catch (err: any) {
          logger.warn(
            { err: err?.message, index: i },
            'Telegram message edit failed during split',
          );
          if (!firstError) firstError = err;
        }
      } else {
        // No transport for sending additional streaming messages mid-split;
        // route continuation through the fallback (normal send) instead.
        if (this.fallbackSend) {
          try {
            await this.fallbackSend(chunks[i]);
          } catch (err: any) {
            logger.warn(
              { err: err?.message, index: i },
              'Telegram continuation send failed',
            );
            if (!firstError) firstError = err;
            break;
          }
        }
      }
    }

    if (firstError) throw firstError;
  }

  private async tryFallback(text: string): Promise<void> {
    if (this.fallbackUsed || !this.fallbackSend) return;
    this.fallbackUsed = true;
    try {
      await this.fallbackSend(text);
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        'Telegram fallback send also failed',
      );
    }
  }
}

// ─── Code fence-aware text splitting ─────────────────────────

/**
 * Split text into chunks of at most `limit` characters, preserving code fences.
 * When a split lands inside a fenced code block, the current chunk is closed
 * with ``` and the next chunk reopens with ```lang.
 */
function splitWithCodeFences(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeFenceLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    const reservedChars = insideCodeBlock ? 8 : 0;
    const effectiveLimit = limit - reservedChars;
    const searchStart = Math.max(0, effectiveLimit - 200);
    const searchRegion = remaining.slice(searchStart, effectiveLimit);
    const lastNewline = searchRegion.lastIndexOf('\n');
    let splitAt =
      lastNewline !== -1 ? searchStart + lastNewline + 1 : effectiveLimit;
    if (splitAt <= 0) splitAt = effectiveLimit > 0 ? effectiveLimit : limit;

    let chunk = remaining.slice(0, splitAt);
    const fenceState = trackCodeFences(chunk, insideCodeBlock, codeFenceLang);

    if (fenceState.insideCodeBlock) {
      chunk = chunk + '\n```';
      insideCodeBlock = true;
      codeFenceLang = fenceState.lang;
    } else {
      insideCodeBlock = false;
      codeFenceLang = '';
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt);

    if (insideCodeBlock && remaining.length > 0) {
      const opener = codeFenceLang ? '```' + codeFenceLang + '\n' : '```\n';
      remaining = opener + remaining;
    }
  }

  return chunks;
}

function trackCodeFences(
  text: string,
  initiallyInside: boolean,
  initialLang: string,
): { insideCodeBlock: boolean; lang: string } {
  let inside = initiallyInside;
  let lang = initialLang;
  const fenceRegex = /^(`{3,})(.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (!inside) {
      inside = true;
      lang = (match[2] || '').trim();
    } else {
      inside = false;
      lang = '';
    }
  }
  return { insideCodeBlock: inside, lang };
}

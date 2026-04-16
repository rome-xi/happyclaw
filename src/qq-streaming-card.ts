/**
 * QQ C2C Streaming Message Controller
 *
 * Implements typewriter-style progressive message delivery using
 * QQ Bot API v2's stream_messages endpoint (C2C only).
 *
 * Protocol:
 *   POST /v2/users/{openid}/stream_messages
 *   - input_mode: "replace" (each chunk replaces entire message)
 *   - input_state: 1 (GENERATING) / 10 (DONE)
 *   - First chunk returns stream_msg_id; subsequent chunks must include it
 *   - msg_seq: shared across all chunks in the same session
 *
 * Lifecycle: idle → streaming → completed / aborted
 * Fallback: if stream API fails, falls back to plain sendQQMessage()
 */

import { logger } from './logger.js';
import { markdownToPlainText } from './im-utils.js';

// ─── Constants ───────────────────────────────────────────────

const STREAM_UPDATE_INTERVAL = 500; // ms — throttle between API calls

// ─── Types ───────────────────────────────────────────────────

/** Callback to send a stream chunk via QQ API */
export type SendStreamChunkFn = (
  openid: string,
  params: {
    input_mode: string;
    input_state: number;
    content_type: string;
    content_raw: string;
    msg_seq: number;
    index: number;
    stream_msg_id?: string;
  },
) => Promise<{ id?: string }>;

/** Callback to send a plain message (fallback) */
export type FallbackSendFn = (text: string) => Promise<void>;

type StreamingState = 'idle' | 'streaming' | 'completed' | 'aborted';

// ─── Controller ──────────────────────────────────────────────

export class QQStreamingController {
  private state: StreamingState = 'idle';
  private accumulatedText = '';

  // Stream session state
  private streamMsgId: string | null = null;
  private msgSeq: number;
  private streamIndex = 0;
  private sentChunkCount = 0;

  // Throttle
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Dependencies
  private openid: string;
  private sendStreamChunk: SendStreamChunkFn;
  private fallbackSend: FallbackSendFn;
  private fallbackUsed = false;

  // Auxiliary state (thinking, tools, status)
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

  // Auxiliary flush throttle
  private auxFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAuxFlushTime = 0;
  private static readonly AUX_FLUSH_INTERVAL = 1500; // ms

  // Display limits
  private static readonly MAX_THINKING_CHARS = 500;
  private static readonly MAX_TOOLS_DISPLAY = 5;
  private static readonly MAX_TOOL_SUMMARY_CHARS = 60;
  private static readonly MAX_RECENT_EVENTS = 5;

  constructor(opts: {
    openid: string;
    msgSeq: number;
    sendStreamChunk: SendStreamChunkFn;
    fallbackSend: FallbackSendFn;
  }) {
    this.openid = opts.openid;
    this.msgSeq = opts.msgSeq;
    this.sendStreamChunk = opts.sendStreamChunk;
    this.fallbackSend = opts.fallbackSend;
  }

  // ─── StreamingSession interface ─────────────────────────────

  isActive(): boolean {
    return this.state === 'idle' || this.state === 'streaming';
  }

  append(text: string): void {
    if (!this.isActive()) return;
    this.accumulatedText = text;
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

    // If we never managed to start a stream, use fallback
    if (this.state === 'idle' || this.sentChunkCount === 0) {
      await this.tryStartStream(finalText);
      if (!this.streamMsgId) {
        await this.tryFallback(finalText);
        this.state = 'completed';
        return;
      }
    }

    try {
      const content = markdownToPlainText(finalText);
      await this.doSendChunk(content, 10); // DONE
      this.state = 'completed';
      logger.info(
        { openid: this.openid, chunks: this.sentChunkCount },
        'QQ streaming completed',
      );
    } catch (err: any) {
      logger.warn(
        { err: err.message, openid: this.openid },
        'QQ streaming finalize failed, using fallback',
      );
      await this.tryFallback(finalText);
      this.state = 'completed';
    }
  }

  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    this.clearTimers();

    if (this.streamMsgId) {
      const abortText = this.accumulatedText
        ? markdownToPlainText(this.accumulatedText) + `\n\n⚠️ 已中断: ${reason ?? '用户取消'}`
        : `⚠️ 已中断: ${reason ?? '用户取消'}`;
      try {
        await this.doSendChunk(abortText, 10); // DONE
      } catch (err: any) {
        logger.debug({ err: err.message }, 'QQ streaming abort chunk failed');
      }
    }
    this.state = 'aborted';
  }

  dispose(): void {
    this.clearTimers();
  }

  // ─── Auxiliary display methods ──────────────────────────────

  setThinking(): void {
    this.thinking = true;
  }

  appendThinking(text: string): void {
    this.thinkingText += text;
    if (this.thinkingText.length > QQStreamingController.MAX_THINKING_CHARS) {
      this.thinkingText =
        '...' +
        this.thinkingText.slice(-(QQStreamingController.MAX_THINKING_CHARS - 3));
    }
    this.thinking = true;

    // Show thinking state via streaming if already active
    if (this.state === 'streaming') {
      this.scheduleAuxFlush();
    }
  }

  setSystemStatus(status: string | null): void {
    this.systemStatus = status;
    if (this.state === 'streaming') this.scheduleAuxFlush();
  }

  setHook(_hook: { hookName: string; hookEvent: string } | null): void {
    // Not meaningful for QQ plain text
  }

  setTodos(
    _todos: Array<{ id: string; content: string; status: string }>,
  ): void {
    // Too verbose for plain text
  }

  pushRecentEvent(text: string): void {
    this.recentEvents.push(text);
    if (this.recentEvents.length > QQStreamingController.MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(
        -QQStreamingController.MAX_RECENT_EVENTS,
      );
    }
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
  }): Promise<void> {}

  getAllMessageIds(): string[] {
    return [];
  }

  // ─── Internal: auxiliary prefix ─────────────────────────────

  private buildAuxPrefix(): string {
    const parts: string[] = [];

    if (this.systemStatus) {
      parts.push(`⏳ ${this.systemStatus}`);
    }

    if (this.thinkingText) {
      const label = this.thinking ? '💭 思考中...' : '💭 思考完成';
      const truncated =
        this.thinkingText.length > QQStreamingController.MAX_THINKING_CHARS
          ? '...' +
            this.thinkingText.slice(-(QQStreamingController.MAX_THINKING_CHARS - 3))
          : this.thinkingText;
      parts.push(`${label}\n${truncated}`);
    } else if (this.thinking) {
      parts.push('💭 思考中...');
    }

    const now = Date.now();
    const display: string[] = [];
    for (const [, tc] of this.tools) {
      if (display.length >= QQStreamingController.MAX_TOOLS_DISPLAY) break;
      const elapsed = QQStreamingController.formatElapsed(now - tc.startTime);
      const icon =
        tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
      const summary = tc.summary
        ? `  ${tc.summary.length > QQStreamingController.MAX_TOOL_SUMMARY_CHARS ? tc.summary.slice(0, QQStreamingController.MAX_TOOL_SUMMARY_CHARS) + '...' : tc.summary}`
        : '';
      display.push(`${icon} ${tc.name} (${elapsed})${summary}`);
    }
    if (display.length > 0) {
      parts.push(display.join('\n'));
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n\n---\n\n' : '';
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

  // ─── Internal: streaming ────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, STREAM_UPDATE_INTERVAL - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.doFlush().catch((err: any) => {
        logger.debug({ err: err.message }, 'QQ streaming flush failed');
      });
    }, delay);
  }

  private scheduleAuxFlush(): void {
    if (this.auxFlushTimer) return;
    const elapsed = Date.now() - this.lastAuxFlushTime;
    const delay = Math.max(
      0,
      QQStreamingController.AUX_FLUSH_INTERVAL - elapsed,
    );
    this.auxFlushTimer = setTimeout(() => {
      this.auxFlushTimer = null;
      this.lastAuxFlushTime = Date.now();
      const content = this.buildAuxPrefix() + markdownToPlainText(this.accumulatedText);
      if (this.streamMsgId) {
        this.doSendChunk(content, 1).catch((err: any) => {
          logger.debug({ err: err.message }, 'QQ streaming aux flush failed');
        });
      }
    }, delay);
  }

  private async doFlush(): Promise<void> {
    const rawText = this.accumulatedText;
    if (!rawText.trim() && !this.thinking && !this.thinkingText) return;

    const content = this.buildAuxPrefix() + markdownToPlainText(rawText);

    if (!this.streamMsgId) {
      await this.tryStartStream(content);
      if (!this.streamMsgId) return; // Failed, will retry next flush
    } else {
      try {
        await this.doSendChunk(content, 1); // GENERATING
        this.lastUpdateTime = Date.now();
      } catch (err: any) {
        logger.debug({ err: err.message }, 'QQ streaming chunk failed');
      }
    }
  }

  private async tryStartStream(content: string): Promise<void> {
    try {
      const plainContent = content.includes('---\n\n')
        ? content // Already built with aux prefix
        : markdownToPlainText(content);
      // Show at least a "thinking" placeholder if content is empty
      const displayContent = plainContent.trim() || '💭 思考中...';
      const resp = await this.sendStreamChunk(this.openid, {
        input_mode: 'replace',
        input_state: 1, // GENERATING
        content_type: 'markdown',
        content_raw: displayContent,
        msg_seq: this.msgSeq,
        index: this.streamIndex++,
      });

      if (resp.id) {
        this.streamMsgId = resp.id;
        this.state = 'streaming';
        this.sentChunkCount++;
        this.lastUpdateTime = Date.now();
        logger.info(
          { openid: this.openid, streamMsgId: resp.id },
          'QQ streaming started',
        );
      } else {
        logger.warn({ openid: this.openid }, 'QQ stream API returned no id');
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message, openid: this.openid },
        'QQ streaming start failed',
      );
      // Stay in idle, will retry or fallback
    }
  }

  private async doSendChunk(
    content: string,
    inputState: number,
  ): Promise<void> {
    await this.sendStreamChunk(this.openid, {
      input_mode: 'replace',
      input_state: inputState,
      content_type: 'markdown',
      content_raw: content,
      msg_seq: this.msgSeq,
      index: this.streamIndex++,
      stream_msg_id: this.streamMsgId ?? undefined,
    });
    this.sentChunkCount++;
  }

  private async tryFallback(text: string): Promise<void> {
    if (this.fallbackUsed) return;
    this.fallbackUsed = true;
    try {
      await this.fallbackSend(text);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'QQ streaming fallback send also failed');
    }
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
}

/**
 * DingTalk Streaming Card Controller
 *
 * Placeholder for future streaming card implementation.
 * DingTalk Stream SDK doesn't support native streaming cards yet,
 * This provides a basic text update functionality.
 */
import { logger } from './logger.js';

export interface DingTalkStreamingCardOptions {
  client: unknown; // DWClient
  chatId: string;
  replyToMsgId?: string;
  onCardCreated?: (messageId: string) => void;
}

export class DingTalkStreamingCardController {
  private client: unknown;
  private chatId: string;
  private replyToMsgId?: string;
  private onCardCreated?: (messageId: string) => void;

  private messageId: string | null = null;
  private buffer: string = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private isActive: boolean = true;

  // DingTalk doesn't support streaming cards like Feishu
  private static readonly FLUSH_INTERVAL = 500; // ms

  constructor(options: DingTalkStreamingCardOptions) {
    this.client = options.client;
    this.chatId = options.chatId;
    this.replyToMsgId = options.replyToMsgId;
    this.onCardCreated = options.onCardCreated;
  }

  append(text: string): void {
    if (!this.isActive) return;
    this.buffer += text;

    // Debounce flush
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        logger.warn(
          { err, chatId: this.chatId },
          'Failed to flush DingTalk streaming card',
        );
      });
    }, DingTalkStreamingCardController.FLUSH_INTERVAL);
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;

    // TODO: Implement DingTalk card update
    // For now, just log the buffer length for debugging
    logger.debug(
      { chatId: this.chatId, bufferLength: this.buffer.length },
      'DingTalk streaming card buffer',
    );
  }

  async complete(): Promise<void> {
    this.isActive = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  abort(): void {
    this.isActive = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  setThinking(text: string): void {
    // Placeholder for showing thinking state
    logger.debug({ text }, 'DingTalk streaming card thinking');
  }

  startTool(toolName: string, input?: unknown): void {
    // Placeholder for showing tool start
    logger.debug({ toolName }, 'DingTalk streaming card tool start');
  }

  endTool(result?: unknown): void {
    // Placeholder for showing tool end
    logger.debug({ result }, 'DingTalk streaming card tool end');
  }
}

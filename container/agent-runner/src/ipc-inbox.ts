import fs from 'fs';
import path from 'path';

export interface IpcMessage {
  messageId: string;
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  taskId?: string;
  sourceJid?: string;
  claimPath: string;
}

function safeMessageId(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value)
    ? value
    : fallback.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

/** A completed foreground result owns no later messages, except while the same
 * SDK stream is intentionally waiting for background-task completion. */
export function shouldStartFreshIpcTurn(
  resultCount: number,
  pendingBackgroundTasks: number,
  hasQueuedMessages: boolean,
): boolean {
  return resultCount > 0 && pendingBackgroundTasks === 0 && hasQueuedMessages;
}

/** Durable queued → inflight → acknowledged lifecycle for runner input. */
export class IpcInbox {
  readonly inflightDir: string;

  constructor(
    readonly inputDir: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.inflightDir = path.join(inputDir, 'inflight');
  }

  ensureDirectories(): void {
    fs.mkdirSync(this.inputDir, { recursive: true });
    fs.mkdirSync(this.inflightDir, { recursive: true });
  }

  /** Return claims left by a crashed runner to the watcher-visible queue. */
  recoverInflight(): number {
    try {
      this.ensureDirectories();
      const files = fs
        .readdirSync(this.inflightDir)
        .filter((file) => file.endsWith('.json'))
        .sort();
      for (const file of files) {
        const from = path.join(this.inflightDir, file);
        let to = path.join(this.inputDir, file);
        if (fs.existsSync(to)) {
          to = path.join(
            this.inputDir,
            `${Date.now()}-recovered-${Math.random().toString(36).slice(2, 8)}.json`,
          );
        }
        fs.renameSync(from, to);
      }
      return files.length;
    } catch (err) {
      this.log(
        `IPC inflight recovery error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  hasQueuedMessages(): boolean {
    try {
      return fs
        .readdirSync(this.inputDir)
        .some((file) => file.endsWith('.json'));
    } catch {
      return false;
    }
  }

  /** Atomically claim every queued JSON message without deleting it. */
  claimAll(): IpcMessage[] {
    const messages: IpcMessage[] = [];
    try {
      this.ensureDirectories();
      const files = fs
        .readdirSync(this.inputDir)
        .filter((file) => file.endsWith('.json'))
        .sort();

      for (const file of files) {
        const filePath = path.join(this.inputDir, file);
        let claimPath = path.join(this.inflightDir, file);
        try {
          if (fs.existsSync(claimPath)) {
            claimPath = path.join(
              this.inflightDir,
              `${Date.now()}-claim-${Math.random().toString(36).slice(2, 8)}-${file}`,
            );
          }
          fs.renameSync(filePath, claimPath);
          const data = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
          if (data.type === 'message' && data.text) {
            messages.push({
              messageId: safeMessageId(
                data.messageId,
                file.replace(/\.json$/, ''),
              ),
              text: data.text,
              images: data.images,
              taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
              sourceJid:
                typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
              claimPath,
            });
          } else {
            fs.unlinkSync(claimPath);
          }
        } catch (err) {
          this.log(
            `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            fs.unlinkSync(claimPath);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      this.log(
        `IPC drain error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return messages;
  }

  /** Delete durable claims and return only the IDs successfully retired. */
  acknowledge(messages: IpcMessage[]): string[] {
    const messageIds: string[] = [];
    for (const message of messages) {
      try {
        fs.unlinkSync(message.claimPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log(
            `Failed to acknowledge IPC message ${message.messageId}: ${err}`,
          );
          continue;
        }
      }
      messageIds.push(message.messageId);
    }
    return messageIds;
  }

  /** Put an unaccepted/interrupted claim back into the visible queue. */
  requeue(message: IpcMessage): void {
    this.ensureDirectories();
    const messageId = safeMessageId(
      message.messageId,
      path.basename(message.claimPath, '.json'),
    );
    const destination = path.join(this.inputDir, `${messageId}.json`);
    try {
      if (fs.existsSync(message.claimPath)) {
        if (fs.existsSync(destination)) fs.unlinkSync(message.claimPath);
        else fs.renameSync(message.claimPath, destination);
        return;
      }
      if (fs.existsSync(destination)) return;
      const tempPath = `${destination}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          messageId,
          text: message.text,
          images: message.images,
          taskId: message.taskId,
          sourceJid: message.sourceJid,
        }),
      );
      fs.renameSync(tempPath, destination);
    } catch (err) {
      this.log(`Failed to requeue IPC message ${message.messageId}: ${err}`);
    }
  }
}

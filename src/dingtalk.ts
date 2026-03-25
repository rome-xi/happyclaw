/**
 * DingTalk Bot Stream Connection Factory
 *
 * Implements DingTalk bot connection using official Stream mode SDK:
 * - WebSocket connection for receiving events
 * - Message deduplication (LRU 1000 / 30min TTL)
 * - Group mention filtering
 * - REST API for sending messages
 *
 * Reference: https://open.dingtalk.com/document/orgapp/the-streaming-mode-is-connected-to-the-robot-receiving-message
 */
import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';
import {
  DWClient,
  TOPIC_ROBOT,
  type RobotMessage,
  type DWClientDownStream,
  EventAck,
} from 'dingtalk-stream';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';

// ─── Constants ──────────────────────────────────────────────────

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const MSG_SPLIT_LIMIT = 4000; // DingTalk markdown card limit

// ─── Types ──────────────────────────────────────────────────────

export interface DingTalkConnectionConfig {
  clientId: string;
  clientSecret: string;
}

export interface DingTalkConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized?: (jid: string) => boolean;
  ignoreMessagesBefore?: number;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
}

export interface DingTalkConnection {
  connect(opts: DingTalkConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendReaction(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  getLastMessageId?(chatId: string): string | undefined;
}

interface DingTalkAccessToken {
  token: string;
  expiresAt: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert Markdown to DingTalk plain text.
 * DingTalk cards support basic Markdown, but we strip some formatting for safety.
 */
function markdownToPlainText(md: string): string {
  let text = md;

  // Code blocks: keep content, remove fences
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });

  // Inline code: remove backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Bold: **text** or __text__ → text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strikethrough: ~~text~~ → text
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Italic: *text* → text
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');

  // Headings: # text → text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  return text;
}

/**
 * Split text into chunks at safe boundaries.
 */
function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Parse JID to determine chat type and extract conversation ID / staff ID.
 * dingtalk:c2c:{senderStaffId} → { type: 'c2c', conversationId: senderStaffId }
 * dingtalk:group:{openConversationId} → { type: 'group', conversationId: openConversationId }
 * c2c:{senderStaffId} → { type: 'c2c', conversationId: senderStaffId } (legacy without prefix)
 */
function parseDingTalkChatId(
  chatId: string,
): { type: 'c2c' | 'group'; conversationId: string } | null {
  if (chatId.startsWith('dingtalk:c2c:')) {
    // Format: dingtalk:c2c:{senderStaffId}, extract senderStaffId
    return { type: 'c2c', conversationId: chatId.slice(12) };
  }
  if (chatId.startsWith('dingtalk:group:')) {
    return { type: 'group', conversationId: chatId.slice(14) };
  }
  // Legacy format without prefix
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', conversationId: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', conversationId: chatId.slice(6) };
  }
  // Legacy format: direct conversationId (assume group)
  if (chatId.startsWith('cid') || chatId.includes('cid')) {
    return { type: 'group', conversationId: chatId };
  }
  return null;
}

// ─── Factory Function ───────────────────────────────────────────

export function createDingTalkConnection(
  config: DingTalkConnectionConfig,
): DingTalkConnection {
  // SDK client state
  let client: DWClient | null = null;
  let stopping = false;
  let readyFired = false;

  // Token state for REST API
  let tokenInfo: DingTalkAccessToken | null = null;

  // Message deduplication
  const msgCache = new Map<string, number>();

  // Last message ID per chat (for reply context)
  const lastMessageIds = new Map<string, string>();

  // Session webhook per chat (for sending replies)
  const lastSessionWebhooks = new Map<string, string>();

  // Session webhook expiry per chat
  const sessionWebhookExpiry = new Map<string, number>();
  const SESSION_WEBHOOK_TTL = 5 * 60 * 1000; // 5 minutes

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    // Map preserves insertion order; stop at first non-expired entry
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      } else {
        break;
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    // delete + set to refresh insertion order (move to end)
    msgCache.delete(msgId);
    msgCache.set(msgId, Date.now());
  }

  // ─── Token Management ──────────────────────────────────────

  async function getAccessToken(): Promise<string> {
    // Check cached token
    if (tokenInfo && Date.now() < tokenInfo.expiresAt - 300000) {
      return tokenInfo.token;
    }

    // Fetch new token using GET method (钉钉 API 支持 GET 和 POST)
    return new Promise<string>((resolve, reject) => {
      const url = new URL('https://oapi.dingtalk.com/gettoken');
      url.searchParams.set('appkey', config.clientId);
      url.searchParams.set('appsecret', config.clientSecret);

      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'GET',
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (data.errcode !== 0) {
                reject(new Error(`DingTalk token error: ${data.errmsg}`));
                return;
              }
              const expiresIn = Number(data.expires_in) || 7200;
              tokenInfo = {
                token: data.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
              logger.info({ expiresIn }, 'DingTalk access token refreshed');
              resolve(data.access_token);
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  // ─── REST API ──────────────────────────────────────────────

  async function apiRequest<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await getAccessToken();
    const url = new URL(path, DINGTALK_API_BASE);
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
            ...(bodyStr
              ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = data.message || data.msg || text;
                reject(
                  new Error(
                    `DingTalk API ${method} ${path} failed (${res.statusCode}): ${errMsg}`,
                  ),
                );
                return;
              }
              resolve(data as T);
            } catch {
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new Error(
                    `DingTalk API ${method} ${path} failed (${res.statusCode}): ${text}`,
                  ),
                );
              } else {
                resolve({} as T);
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // ─── Message Sending ──────────────────────────────────────

  /**
   * Send message via sessionWebhook (from incoming message)
   * This is the standard DingTalk robot reply mechanism
   */
  async function sendViaSessionWebhook(
    sessionWebhook: string,
    content: string,
  ): Promise<void> {
    const token = await getAccessToken();
    const body = {
      msgtype: 'text',
      text: {
        content: content,
      },
    };

    return new Promise<void>((resolve, reject) => {
      const url = new URL(sessionWebhook);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': token,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`DingTalk webhook failed (${res.statusCode})`));
              return;
            }
            resolve();
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function sendDingTalkMessage(
    sessionWebhook: string,
    content: string,
  ): Promise<void> {
    await sendViaSessionWebhook(sessionWebhook, content);
  }

  async function sendDingTalkGroupMessage(
    sessionWebhook: string,
    content: string,
  ): Promise<void> {
    await sendViaSessionWebhook(sessionWebhook, content);
  }

  // ─── File Download ─────────────────────────────────────────

  async function downloadDingTalkImageAsBase64(
    url: string,
  ): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectCount: number = 0) => {
          if (redirectCount > 5) {
            reject(new Error('Too many redirects'));
            return;
          }
          const parsedUrl = new URL(reqUrl);
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          protocol
            .get(reqUrl, (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                doRequest(res.headers.location, redirectCount + 1);
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              res.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_FILE_SIZE) {
                  res.destroy(new Error('Image exceeds MAX_FILE_SIZE'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        };
        doRequest(url);
      });

      if (buffer.length === 0) return null;
      const mimeType = detectImageMimeType(buffer);
      return { base64: buffer.toString('base64'), mimeType };
    } catch (err) {
      logger.warn({ err }, 'Failed to download DingTalk image as base64');
      return null;
    }
  }

  // ─── Event Handlers ───────────────────────────────────────

  async function handleRobotMessage(
    downstream: DWClientDownStream,
    opts: DingTalkConnectOpts,
  ): Promise<void> {
    try {
      const data = JSON.parse(downstream.data) as RobotMessage;

      const msgId = data.msgId;
      if (!msgId || isDuplicate(msgId)) {
        return;
      }
      markSeen(msgId);

      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && data.createAt) {
        const msgTime = data.createAt;
        if (msgTime < opts.ignoreMessagesBefore) {
          return;
        }
      }

      const conversationId = data.conversationId;
      const conversationType = data.conversationType;
      const isGroup = conversationType === '2'; // 1=C2C, 2=Group

      const jid = isGroup
        ? `dingtalk:group:${conversationId}`
        : `dingtalk:c2c:${data.senderId}`;
      const senderName = data.senderNick || '钉钉用户';
      const chatName = isGroup
        ? `钉钉群 ${conversationId.slice(0, 8)}`
        : senderName;

      // Store last message ID for reply context
      lastMessageIds.set(jid, msgId);

      // Store session webhook for sending replies
      logger.warn(
        {
          jid,
          hasSessionWebhook: !!data.sessionWebhook,
          sessionWebhook: data.sessionWebhook,
        },
        'DingTalk message sessionWebhook',
      );
      if (data.sessionWebhook) {
        lastSessionWebhooks.set(jid, data.sessionWebhook);
        if (data.sessionWebhookExpiredTime) {
          sessionWebhookExpiry.set(jid, data.sessionWebhookExpiredTime);
        }
      }

      // Get message content
      let content = '';
      if (data.msgtype === 'text' && 'text' in data) {
        content = data.text?.content?.trim() || '';
      }

      // Skip empty messages
      if (!content) {
        return;
      }

      // ── /pair <code> command ──
      const pairMatch = content.match(/^\/pair\s+(\S+)/i);
      if (pairMatch && opts.onPairAttempt) {
        const code = pairMatch[1];
        try {
          const success = await opts.onPairAttempt(jid, chatName, code);
          const reply = success
            ? '配对成功！此聊天已连接到你的账号。'
            : '配对码无效或已过期，请在 Web 设置页重新生成。';
          if (isGroup) {
            await sendDingTalkGroupMessage(conversationId, reply);
          } else {
            await sendDingTalkMessage(data.sessionWebhook, reply);
          }
        } catch (err) {
          logger.error({ err, jid }, 'DingTalk pair attempt error');
        }
        return;
      }

      // ── Authorization check ──
      if (opts.isChatAuthorized && !opts.isChatAuthorized(jid)) {
        logger.debug({ jid }, 'DingTalk chat not authorized');
        return;
      }

      // ── Group mention check ──
      if (
        isGroup &&
        opts.shouldProcessGroupMessage &&
        !opts.shouldProcessGroupMessage(jid)
      ) {
        logger.debug(
          { jid },
          'DingTalk group message dropped (mention required)',
        );
        return;
      }

      // ── Authorized: process message ──
      storeChatMetadata(jid, new Date().toISOString());
      updateChatName(jid, chatName);
      opts.onNewChat(jid, chatName);

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody);
          if (reply) {
            const plainText = markdownToPlainText(reply);
            if (isGroup) {
              await sendDingTalkGroupMessage(conversationId, plainText);
            } else {
              await sendDingTalkMessage(data.sessionWebhook, plainText);
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'DingTalk slash command failed');
          return;
        }
      }

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      const id = crypto.randomUUID();
      const timestamp = data.createAt
        ? new Date(data.createAt).toISOString()
        : new Date().toISOString();
      const senderId = `dingtalk:${data.senderId}`;
      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        { sourceJid: jid },
      );

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: undefined,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );
      notifyNewImMessage();

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'DingTalk message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId },
          'DingTalk message stored',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error handling DingTalk robot message');
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: DingTalkConnection = {
    async connect(opts: DingTalkConnectOpts): Promise<boolean> {
      if (!config.clientId || !config.clientSecret) {
        logger.info('DingTalk clientId/clientSecret not configured, skipping');
        return false;
      }

      stopping = false;
      readyFired = false;

      try {
        // 🔧 Fix proxy issue: disable axios global proxy before importing dingtalk-stream
        // The dingtalk-stream SDK uses axios internally, which can be affected by system PAC files
        const axios = (await import('axios')).default;
        if (axios.defaults) {
          axios.defaults.proxy = false;
          logger.debug('Disabled axios global proxy for dingtalk-stream SDK');
        }

        // Create DWClient
        client = new DWClient({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          debug: false,
        });

        // Register robot message callback using registerCallbackListener (not registerAllEventListener)
        client.registerCallbackListener(
          TOPIC_ROBOT,
          async (downstream: DWClientDownStream) => {
            // Debug: log all events
            logger.info(
              {
                topic: downstream.topic,
                data: downstream.data?.substring?.(0, 200),
              },
              'DingTalk robot message received',
            );

            // Ack immediately
            const messageId = downstream.headers?.messageId;
            if (messageId) {
              client.socketCallBackResponse(messageId, { success: true });
              logger.debug({ messageId }, 'DingTalk callback acknowledged');
            }

            // Process in background
            handleRobotMessage(downstream, opts).catch((err) => {
              logger.error({ err }, 'Error in DingTalk message handler');
            });
          },
        );

        // Connect
        await client.connect();

        logger.info(
          { clientId: config.clientId.slice(0, 8) },
          'DingTalk Stream connected',
        );
        readyFired = true;
        opts.onReady?.();
        return true;
      } catch (err) {
        logger.error({ err }, 'DingTalk initial connection failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;

      if (client) {
        try {
          client.disconnect();
        } catch (err) {
          logger.debug({ err }, 'Error disconnecting DingTalk client');
        }
        client = null;
      }

      tokenInfo = null;
      msgCache.clear();
      lastMessageIds.clear();
      lastSessionWebhooks.clear();
      sessionWebhookExpiry.clear();
      logger.info('DingTalk bot disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      const parsed = parseDingTalkChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid DingTalk chat ID format');
        return;
      }

      // Reconstruct the full jid to match how sessionWebhook was stored
      const jidKey =
        parsed.type === 'c2c'
          ? `dingtalk:c2c:${parsed.conversationId}`
          : `dingtalk:group:${parsed.conversationId}`;

      // Get session webhook from cache (set when message was received)
      const sessionWebhook = lastSessionWebhooks.get(jidKey);
      if (!sessionWebhook) {
        logger.error(
          { chatId, jidKey },
          'No session webhook found for DingTalk chat',
        );
        return;
      }

      try {
        const plainText = markdownToPlainText(text);
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendViaSessionWebhook(sessionWebhook, chunk);
        }

        logger.info({ chatId }, 'DingTalk message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send DingTalk message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      _fileName?: string,
    ): Promise<void> {
      // DingTalk Stream SDK doesn't support sending images directly
      // Send caption as text instead
      if (caption) {
        await connection.sendMessage(chatId, `📷 ${caption}`);
      } else {
        logger.warn(
          { chatId },
          'DingTalk image sending not supported, skipping',
        );
      }
    },

    async sendFile(
      _chatId: string,
      _filePath: string,
      _fileName: string,
    ): Promise<void> {
      logger.warn('DingTalk file sending not supported via Stream SDK');
    },

    async sendReaction(_chatId: string, _isTyping: boolean): Promise<void> {
      // DingTalk doesn't support typing indicators via Stream
    },

    isConnected(): boolean {
      return client !== null && !stopping;
    },

    getLastMessageId(chatId: string): string | undefined {
      return lastMessageIds.get(chatId);
    },
  };

  return connection;
}

/**
 * Codex CLI OAuth 授权客户端（骨架）。
 *
 * 用于 OpenAI Codex CLI 的 Device Code Flow 授权。
 * 当前为骨架实现，所有方法返回 TODO。
 *
 * 完整设计参考：docs/CODEX-OAUTH-RESEARCH.md
 */

import fs from 'fs';
import path from 'path';

/** Device Code 授权信息 */
export interface DeviceCodeInfo {
  /** 设备码（用于轮询 token 端点） */
  deviceCode: string;
  /** 用户码（展示给用户输入） */
  userCode: string;
  /** 验证 URL */
  verificationUri: string;
  /** 完整验证 URL（含 user_code） */
  verificationUriComplete: string;
  /** 过期时间（秒） */
  expiresIn: number;
  /** 轮询间隔（秒） */
  interval: number;
}

/** Token 信息 */
export interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  /** 过期时间戳（毫秒） */
  expiresAt: number;
  scope: string;
}

/** Token 存储接口 */
export interface TokenStore {
  save(providerId: string, token: TokenInfo): Promise<void>;
  load(providerId: string): Promise<TokenInfo | null>;
  clear(providerId: string): Promise<void>;
}

/**
 * Codex OAuth 客户端。
 *
 * 使用 Device Code Flow 授权流程：
 * 1. 调用 authorize() 获取设备码和验证 URL
 * 2. 展示给用户，让用户在浏览器完成授权
 * 3. 调用 pollForToken() 轮询等待授权完成
 * 4. 使用 getAccessToken() 获取有效的 access token（自动刷新）
 */
export class CodexOAuthClient {
  private readonly authBaseUrl: string;
  private readonly clientId: string;
  private readonly tokenStore: TokenStore;

  constructor(options: {
    /** OAuth 服务 Base URL，默认 https://auth.openai.com */
    authBaseUrl?: string;
    /** OAuth Client ID */
    clientId: string;
    /** Token 存储实现 */
    tokenStore: TokenStore;
  }) {
    this.authBaseUrl = options.authBaseUrl || 'https://auth.openai.com';
    this.clientId = options.clientId;
    this.tokenStore = options.tokenStore;
  }

  /**
   * 启动 Device Code Flow 授权。
   *
   * TODO: 实现 POST /oauth/device/code
   *
   * @returns 设备码信息（展示给用户）
   */
  async authorize(): Promise<DeviceCodeInfo> {
    throw new Error('TODO: CodexOAuthClient.authorize() 尚未实现');
  }

  /**
   * 轮询 token 端点，等待用户完成授权。
   *
   * TODO: 实现每 interval 秒轮询 POST /oauth/token
   *
   * @param deviceCode 从 authorize() 获得的设备码
   * @param timeoutMs 超时时间（毫秒），默认 15 分钟
   * @returns Token 信息
   */
  async pollForToken(deviceCode: string, timeoutMs?: number): Promise<TokenInfo> {
    throw new Error('TODO: CodexOAuthClient.pollForToken() 尚未实现');
  }

  /**
   * 使用 refresh_token 刷新 access_token。
   *
   * TODO: 实现 POST /oauth/token with grant_type=refresh_token
   *
   * @param refreshToken 刷新令牌
   * @returns 新的 Token 信息
   */
  async refreshToken(refreshToken: string): Promise<TokenInfo> {
    throw new Error('TODO: CodexOAuthClient.refreshToken() 尚未实现');
  }

  /**
   * 获取当前有效的 access token。
   * 如果 token 已过期，自动使用 refresh_token 刷新。
   *
   * TODO: 实现 token 过期检查 + 自动刷新
   *
   * @param providerId Provider ID
   * @returns 有效的 access token，或 null（未授权/刷新失败）
   */
  async getAccessToken(providerId: string): Promise<string | null> {
    throw new Error('TODO: CodexOAuthClient.getAccessToken() 尚未实现');
  }

  /**
   * 清除指定 Provider 的授权凭据。
   */
  async logout(providerId: string): Promise<void> {
    await this.tokenStore.clear(providerId);
  }
}

// ─── 文件 Token Store 实现 ───

/**
 * 基于文件系统的 Token 存储。
 * Token 加密存储在 data/config/codex-oauth/{providerId}.json
 */
export class FileTokenStore implements TokenStore {
  private readonly storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
  }

  async save(providerId: string, token: TokenInfo): Promise<void> {
    // TODO: 加密后写入文件
    fs.mkdirSync(this.storeDir, { recursive: true });
    const filePath = path.join(this.storeDir, `${providerId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(token, null, 2), 'utf-8');
  }

  async load(providerId: string): Promise<TokenInfo | null> {
    // TODO: 读取并解密文件
    const filePath = path.join(this.storeDir, `${providerId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenInfo;
    } catch {
      return null;
    }
  }

  async clear(providerId: string): Promise<void> {
    const filePath = path.join(this.storeDir, `${providerId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

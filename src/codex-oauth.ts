/**
 * Codex CLI OAuth 授权客户端（骨架）。
 *
 * 用于 OpenAI Codex CLI 的 OAuth 授权，支持两种流程：
 * 1. Authorization Code + PKCE（默认，codex login）—— 需要本地 HTTP server 接收回调
 * 2. Device Code Flow（beta，codex login --device-auth）—— 适合无头环境
 *
 * 当前为骨架实现，所有方法返回 TODO。
 *
 * 完整设计参考：docs/CODEX-OAUTH-RESEARCH.md
 *
 * OpenAI OAuth 端点（来自 .well-known/openid-configuration）：
 *   Authorization: https://auth.openai.com/api/accounts/authorize
 *   Token:         https://auth.openai.com/api/accounts/oauth/token
 *   UserInfo:      https://auth.openai.com/api/accounts/oauth/userinfo
 *   Device Code:   https://chatgpt.com/activate  (用户验证页面)
 *
 * Scope: openid profile email offline_access
 * PKCE:  S256 code challenge method
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── 类型定义 ──────────────────────────────────────────────

/** Device Code 授权挑战信息 */
export interface DeviceCodeChallenge {
  /** 设备码（用于轮询 token 端点） */
  deviceCode: string;
  /** 用户码（展示给用户输入） */
  userCode: string;
  /** 验证 URL */
  verificationUri: string;
  /** 完整验证 URL（含 user_code 参数） */
  verificationUriComplete: string;
  /** 过期时间（秒） */
  expiresIn: number;
  /** 轮询间隔（秒） */
  interval: number;
}

/** Authorization Code + PKCE 授权参数 */
export interface AuthCodeChallenge {
  /** 授权 URL（重定向用户到此地址） */
  authorizationUrl: string;
  /** state 参数（防 CSRF） */
  state: string;
  /** code_verifier（用于 PKCE token 交换） */
  codeVerifier: string;
  /** 重定向 URI */
  redirectUri: string;
}

/** 统一的授权挑战结果 */
export type AuthChallenge =
  | ({ type: 'device_code' } & DeviceCodeChallenge)
  | ({ type: 'auth_code' } & AuthCodeChallenge);

/** Token 信息 */
export interface TokenInfo {
  /** OAuth access token（Bearer token） */
  accessToken: string;
  /** OAuth refresh token（用于获取新的 access token） */
  refreshToken: string;
  /** 过期时间戳（毫秒，Unix epoch） */
  expiresAt: number;
  /** 授权 scope 列表（空格分隔） */
  scope: string;
  /** Token 类型（通常为 "Bearer"） */
  tokenType: string;
  /** 用户唯一标识（来自 ID token 的 sub 声明，可选） */
  userId?: string;
  /** 用户邮箱（可选） */
  email?: string;
}

/**
 * Token 持久化存储接口。
 *
 * 实现需保证 token 的安全存储：
 * - 加密存储（推荐）或文件权限 0600
 * - 不回显、不入日志
 * - 关联 provider_id + user_id 实现隔离
 */
export interface TokenStore {
  /**
   * 保存 token 信息。
   *
   * @param providerId Provider 唯一标识（如 "openai-codex"）
   * @param userId 用户 ID（实现 per-user 隔离）
   * @param token Token 信息
   */
  save(providerId: string, userId: string, token: TokenInfo): Promise<void>;

  /**
   * 加载 token 信息。
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   * @returns Token 信息，未找到时返回 null
   */
  load(providerId: string, userId: string): Promise<TokenInfo | null>;

  /**
   * 清除指定用户的授权凭据。
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   */
  clear(providerId: string, userId: string): Promise<void>;
}

/** Codex OAuth 客户端配置 */
export interface CodexOAuthClientOptions {
  /**
   * OAuth 服务 Base URL。
   * 默认: https://auth.openai.com
   */
  authBaseUrl?: string;

  /**
   * OAuth Client ID。
   * 需在 OpenAI Platform (platform.openai.com) 注册 OAuth App 获取。
   */
  clientId: string;

  /**
   * OAuth Client Secret（可选，公共客户端如 CLI 通常不需要）。
   * Token endpoint 支持 "none" 认证方式。
   */
  clientSecret?: string;

  /**
   * 重定向 URI（Authorization Code 流程必需）。
   * Codex CLI 默认使用 http://localhost:1455/callback
   */
  redirectUri?: string;

  /**
   * 请求的 OAuth scope 列表（空格分隔）。
   * 默认: openid profile email offline_access
   */
  scope?: string;

  /** Token 存储实现 */
  tokenStore: TokenStore;

  /**
   * 自定义 CA 证书路径（企业代理/私有根证书场景）。
   * 对应 Codex CLI 的 CODEX_CA_CERTIFICATE 环境变量。
   */
  caCertificate?: string;
}

// ─── CodexOAuthClient 类 ──────────────────────────────────

/**
 * Codex OAuth 授权客户端。
 *
 * 支持两种授权流程：
 *
 * **Authorization Code + PKCE（推荐本地环境）**：
 * ```typescript
 * const client = new CodexOAuthClient({ clientId, redirectUri, tokenStore });
 * const challenge = await client.authorizeWithAuthCode();
 * // 重定向用户到 challenge.authorizationUrl
 * // 用户授权后，回调 redirect_uri?code=...&state=...
 * const token = await client.exchangeCode(code, challenge.codeVerifier, state);
 * await client.saveToken(providerId, userId, token);
 * ```
 *
 * **Device Code Flow（推荐无头环境）**：
 * ```typescript
 * const client = new CodexOAuthClient({ clientId, tokenStore });
 * const challenge = await client.authorizeWithDeviceCode();
 * // 展示给用户："请访问 challenge.verificationUri 输入代码 challenge.userCode"
 * const token = await client.pollForToken(challenge.deviceCode, challenge.interval);
 * await client.saveToken(providerId, userId, token);
 * ```
 *
 * **使用 token**：
 * ```typescript
 * const accessToken = await client.getAccessToken(providerId, userId);
 * if (accessToken) {
 *   // 用于 API 调用：Authorization: Bearer <accessToken>
 * }
 * ```
 */
export class CodexOAuthClient {
  private readonly authBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  private readonly scope: string;
  private readonly tokenStore: TokenStore;
  private readonly caCertificate?: string;

  constructor(options: CodexOAuthClientOptions) {
    this.authBaseUrl = options.authBaseUrl || 'https://auth.openai.com';
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.scope = options.scope || 'openid profile email offline_access';
    this.tokenStore = options.tokenStore;
    this.caCertificate = options.caCertificate;
  }

  // ─── Authorization Code + PKCE 流程 ───────────────────

  /**
   * 启动 Authorization Code + PKCE 授权流程。
   *
   * 生成授权 URL，用户需在浏览器中访问该 URL 完成授权。
   * 使用 PKCE (S256) 防止授权码截获攻击。
   *
   * TODO: 实现：
   *   1. 生成随机 state（防 CSRF）
   *   2. 生成 code_verifier + code_challenge（PKCE S256）
   *   3. 构建授权 URL：{authBaseUrl}/api/accounts/authorize
   *      ?client_id={clientId}
   *      &redirect_uri={redirectUri}
   *      &response_type=code
   *      &scope={scope}
   *      &state={state}
   *      &code_challenge={codeChallenge}
   *      &code_challenge_method=S256
   *
   * @returns 授权挑战信息（包含授权 URL 和 code_verifier）
   * @throws 如果未配置 redirectUri
   */
  async authorizeWithAuthCode(): Promise<AuthCodeChallenge> {
    // TODO: 实现 state 生成（crypto.randomBytes 32 hex）
    // TODO: 实现 code_verifier 生成（crypto.randomBytes 32 base64url）
    // TODO: 实现 code_challenge = base64url(sha256(code_verifier))
    // TODO: 构建完整授权 URL
    // TODO: 返回 AuthCodeChallenge
    throw new Error('TODO: CodexOAuthClient.authorizeWithAuthCode() 尚未实现');
  }

  /**
   * 用授权码交换 token（Authorization Code 流程）。
   *
   * TODO: 实现 POST {authBaseUrl}/api/accounts/oauth/token
   *   Content-Type: application/x-www-form-urlencoded
   *   grant_type=authorization_code
   *   &code={code}
   *   &redirect_uri={redirectUri}
   *   &client_id={clientId}
   *   &code_verifier={codeVerifier}
   *   [&client_secret={clientSecret}]（如果配置了）
   *
   * @param code 从授权回调获得的 authorization code
   * @param codeVerifier 从 authorizeWithAuthCode() 获得的 code_verifier
   * @param state 从授权回调获得的 state 参数（用于验证，防止 CSRF）
   * @returns Token 信息（含 access_token + refresh_token）
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    state: string,
  ): Promise<TokenInfo> {
    // TODO: 验证 state 与保存的值一致（防 CSRF）
    // TODO: POST /oauth/token 换取 token
    // TODO: 解析响应，计算 expiresAt = now + expires_in * 1000
    // TODO: 可选：解析 ID token 获取 userId + email
    // TODO: 返回 TokenInfo
    throw new Error('TODO: CodexOAuthClient.exchangeCode() 尚未实现');
  }

  // ─── Device Code Flow 流程 ────────────────────────────

  /**
   * 启动 Device Code Flow 授权（无头环境推荐）。
   *
   * TODO: 实现 POST {authBaseUrl}/oauth/device/code
   *   Content-Type: application/x-www-form-urlencoded
   *   client_id={clientId}
   *   &scope={scope}
   *
   * 注意：Device Code endpoint 可能不在 .well-known 中暴露，
   * 需要参考 OpenAI 文档或 Codex CLI 源码确认。
   * 已知用户验证页面为 https://chatgpt.com/activate
   *
   * @returns 设备码挑战信息（展示给用户）
   */
  async authorizeWithDeviceCode(): Promise<DeviceCodeChallenge> {
    // TODO: POST /oauth/device/code
    // TODO: 解析响应为 DeviceCodeChallenge
    // TODO: 返回 DeviceCodeChallenge
    throw new Error('TODO: CodexOAuthClient.authorizeWithDeviceCode() 尚未实现');
  }

  /**
   * 轮询 token 端点，等待用户完成授权（Device Code Flow）。
   *
   * TODO: 实现每 interval 秒轮询 POST {authBaseUrl}/api/accounts/oauth/token
   *   Content-Type: application/x-www-form-urlencoded
   *   grant_type=urn:ietf:params:oauth:grant-type:device_code
   *   &device_code={deviceCode}
   *   &client_id={clientId}
   *
   * 处理响应：
   * - 成功：返回 TokenInfo
   * - authorization_pending：继续等待
   * - slow_down：增加轮询间隔 5 秒
   * - expired_token：设备码过期，抛出错误
   * - access_denied：用户拒绝授权，抛出错误
   *
   * @param deviceCode 从 authorizeWithDeviceCode() 获得的设备码
   * @param interval 轮询间隔（秒），从 DeviceCodeChallenge.interval 获取
   * @param timeoutMs 超时时间（毫秒），默认 15 分钟
   * @returns Token 信息
   */
  async pollForToken(
    deviceCode: string,
    interval: number,
    timeoutMs?: number,
  ): Promise<TokenInfo> {
    // TODO: 计算截止时间 = now + timeoutMs
    // TODO: 循环：
    //   - POST /oauth/token with grant_type=device_code
    //   - 成功 → 返回 TokenInfo
    //   - authorization_pending → sleep(interval) 后继续
    //   - slow_down → interval += 5，sleep(interval) 后继续
    //   - 其他错误 → 抛出
    //   - 超时 → 抛出 TimeoutError
    throw new Error('TODO: CodexOAuthClient.pollForToken() 尚未实现');
  }

  // ─── Token 管理 ───────────────────────────────────────

  /**
   * 使用 refresh_token 刷新 access_token。
   *
   * TODO: 实现 POST {authBaseUrl}/api/accounts/oauth/token
   *   Content-Type: application/x-www-form-urlencoded
   *   grant_type=refresh_token
   *   &refresh_token={refreshToken}
   *   &client_id={clientId}
   *   [&client_secret={clientSecret}]
   *
   * 注意：OpenAI 的 refresh token 响应可能不包含新的 refresh_token，
   * 此时应保留原有的 refresh_token。
   *
   * @param refreshToken 刷新令牌
   * @returns 新的 Token 信息（access_token 更新，refresh_token 可能不变）
   */
  async refreshToken(refreshToken: string): Promise<TokenInfo> {
    // TODO: POST /oauth/token with grant_type=refresh_token
    // TODO: 解析响应
    // TODO: 如果响应中没有新的 refresh_token，保留传入的 refreshToken
    // TODO: 计算新的 expiresAt
    // TODO: 返回 TokenInfo
    throw new Error('TODO: CodexOAuthClient.refreshToken() 尚未实现');
  }

  /**
   * 获取当前有效的 access token。
   *
   * 如果 token 已过期或即将过期（5 分钟内），自动使用 refresh_token 刷新。
   * 刷新成功后自动更新 TokenStore。
   *
   * TODO: 实现：
   *   1. 从 TokenStore 加载 token
   *   2. 检查是否存在，不存在返回 null
   *   3. 检查是否过期（expiresAt - now < 5 * 60 * 1000）
   *   4. 未过期 → 返回 accessToken
   *   5. 已过期 → 调用 refreshToken() 刷新
   *   6. 刷新成功 → 保存新 token 到 TokenStore，返回新 accessToken
   *   7. 刷新失败 → 清除 token，返回 null
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   * @returns 有效的 access token（Bearer token），或 null（未授权/刷新失败）
   */
  async getAccessToken(providerId: string, userId: string): Promise<string | null> {
    // TODO: 实现 token 过期检查 + 自动刷新 + 持久化更新
    throw new Error('TODO: CodexOAuthClient.getAccessToken() 尚未实现');
  }

  /**
   * 保存 token 到存储。
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   * @param token Token 信息
   */
  async saveToken(providerId: string, userId: string, token: TokenInfo): Promise<void> {
    await this.tokenStore.save(providerId, userId, token);
  }

  /**
   * 加载 token（不检查过期，不刷新）。
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   * @returns Token 信息，未找到时返回 null
   */
  async loadToken(providerId: string, userId: string): Promise<TokenInfo | null> {
    return this.tokenStore.load(providerId, userId);
  }

  /**
   * 清除指定用户的授权凭据（登出）。
   *
   * @param providerId Provider 唯一标识
   * @param userId 用户 ID
   */
  async logout(providerId: string, userId: string): Promise<void> {
    await this.tokenStore.clear(providerId, userId);
  }

  // ─── 辅助方法 ────────────────────────────────────────

  /**
   * 检查 token 是否即将过期。
   *
   * @param token Token 信息
   * @param bufferMs 提前刷新的缓冲时间（毫秒），默认 5 分钟
   * @returns true 表示 token 已过期或即将过期
   */
  private isTokenExpiring(token: TokenInfo, bufferMs = 5 * 60 * 1000): boolean {
    return Date.now() + bufferMs >= token.expiresAt;
  }

  /**
   * 生成 PKCE code_verifier。
   *
   * TODO: 实现生成 32 字节随机 base64url 字符串
   *
   * @returns code_verifier 字符串
   */
  private generateCodeVerifier(): string {
    // TODO: return crypto.randomBytes(32).toString('base64url')
    throw new Error('TODO: CodexOAuthClient.generateCodeVerifier() 尚未实现');
  }

  /**
   * 从 code_verifier 计算 PKCE code_challenge（S256）。
   *
   * TODO: 实现 base64url(sha256(ascii(code_verifier)))
   *
   * @param codeVerifier code_verifier 字符串
   * @returns code_challenge 字符串
   */
  private generateCodeChallenge(codeVerifier: string): string {
    // TODO: const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    // TODO: return hash.toString('base64url');
    throw new Error('TODO: CodexOAuthClient.generateCodeChallenge() 尚未实现');
  }

  /**
   * 生成随机 state 参数（防 CSRF）。
   *
   * TODO: 实现生成 32 字节随机 hex 字符串
   */
  private generateState(): string {
    // TODO: return crypto.randomBytes(32).toString('hex');
    throw new Error('TODO: CodexOAuthClient.generateState() 尚未实现');
  }

  /**
   * 向 OAuth 服务器发送 POST 请求。
   *
   * TODO: 实现带 caCertificate 支持的 HTTPS 请求
   *
   * @param endpointUrl 请求 URL
   * @param formData 表单数据（application/x-www-form-urlencoded）
   * @returns 解析后的 JSON 响应
   */
  private async postForm(
    endpointUrl: string,
    formData: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    // TODO: 使用 fetch() 或 https 模块发送 POST 请求
    // TODO: Content-Type: application/x-www-form-urlencoded
    // TODO: 如果配置了 caCertificate，使用自定义 CA
    // TODO: 处理错误响应（4xx/5xx）
    // TODO: 返回 JSON 响应体
    throw new Error('TODO: CodexOAuthClient.postForm() 尚未实现');
  }
}

// ─── Token Store 实现 ─────────────────────────────────────

/**
 * 基于文件系统的 Token 存储（参考实现）。
 *
 * Token 存储在 data/config/codex-oauth/{providerId}/{userId}.json
 *
 * 安全注意：
 * - 当前为明文存储，生产环境应使用加密或 OS keyring
 * - 文件权限应设为 0600
 * - 对应 Codex CLI 的 cli_auth_credentials_store=file 模式
 *
 * TODO: 实现加密存储（参考 runtime-config.ts 的 AES-256-GCM 模式）
 */
export class FileTokenStore implements TokenStore {
  private readonly storeDir: string;

  /**
   * @param storeDir Token 文件存储根目录（绝对路径）
   */
  constructor(storeDir: string) {
    this.storeDir = storeDir;
  }

  async save(providerId: string, userId: string, token: TokenInfo): Promise<void> {
    // TODO: 加密后写入文件（AES-256-GCM，参考 runtime-config.ts）
    // TODO: 文件权限 0600
    const dir = path.join(this.storeDir, providerId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${userId}.json`);
    const data = JSON.stringify(token, null, 2);
    fs.writeFileSync(filePath, data, { encoding: 'utf-8', mode: 0o600 });
  }

  async load(providerId: string, userId: string): Promise<TokenInfo | null> {
    // TODO: 读取并解密文件
    const filePath = path.join(this.storeDir, providerId, `${userId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as TokenInfo;
    } catch {
      return null;
    }
  }

  async clear(providerId: string, userId: string): Promise<void> {
    const filePath = path.join(this.storeDir, providerId, `${userId}.json`);
    if (fs.existsSync(filePath)) {
      // TODO: 安全删除（覆写后删除）
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * 基于内存的 Token 存储（测试用）。
 *
 * 进程重启后丢失，不适合生产环境。
 */
export class MemoryTokenStore implements TokenStore {
  private readonly store = new Map<string, TokenInfo>();

  private key(providerId: string, userId: string): string {
    return `${providerId}:${userId}`;
  }

  async save(providerId: string, userId: string, token: TokenInfo): Promise<void> {
    this.store.set(this.key(providerId, userId), token);
  }

  async load(providerId: string, userId: string): Promise<TokenInfo | null> {
    return this.store.get(this.key(providerId, userId)) ?? null;
  }

  async clear(providerId: string, userId: string): Promise<void> {
    this.store.delete(this.key(providerId, userId));
  }
}

// ─── 工具函数 ──────────────────────────────────────────────

/**
 * 从过期秒数计算过期时间戳（毫秒）。
 *
 * @param expiresInSeconds token 响应中的 expires_in 字段（秒）
 * @returns 过期时间戳（毫秒，Unix epoch）
 */
export function computeExpiresAt(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

/**
 * 生成 base64url 编码的随机字符串。
 *
 * @param bytes 随机字节数
 * @returns base64url 编码的字符串
 */
export function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

# Codex CLI OAuth 授权机制调研

> 调研日期：2026-07-10
> 目的：为 HappyClaw 集成 Codex CLI 做准备，了解其 OAuth 授权流程和集成方式。

## 1. Codex CLI 概述

Codex CLI 是 OpenAI 推出的代码生成命令行工具，提供终端内的 AI 代码补全和生成能力。

- **仓库**：`github.com/openai/codex`（官方开源）
- **定位**：终端内的 AI 代码助手，支持代码补全、代码生成、重构建议
- **与 Claude Code CLI 的关系**：类似的终端 AI 工具，但使用 OpenAI 模型（GPT-4o / Codex 系列）

## 2. OAuth 授权流程

### 2.1 授权方式

Codex CLI 使用 **Device Code Flow**（设备码授权流程），这是一种专为无浏览器或输入受限设备设计的 OAuth 2.0 流程：

```
┌──────────────┐     1. 请求设备码        ┌──────────────┐
│   Codex CLI  │ ──────────────────────→ │  Auth Server │
│              │ ←────────────────────── │  (auth.openai.com) │
└──────────────┘     2. 返回设备码        └──────────────┘
     │                  + 用户码
     │
     │  3. 显示提示："请访问 https://... 输入代码 ABC123"
     │
     ▼
┌──────────────┐     4. 用户在浏览器登录   ┌──────────────┐
│   用户浏览器  │ ──────────────────────→ │  Auth Server │
│              │ ←────────────────────── │              │
└──────────────┘     5. 授权完成          └──────────────┘
     │
     │  6. CLI 轮询 token 端点
     ▼
┌──────────────┐     7. 返回 access_token  ┌──────────────┐
│   Codex CLI  │ ──────────────────────→ │  Auth Server │
│              │ ←────────────────────── │              │
└──────────────┘     8. 获得 token         └──────────────┘
```

### 2.2 具体步骤

1. **CLI 请求设备码**：
   ```
   POST https://auth.openai.com/oauth/device/code
   Content-Type: application/x-www-form-urlencoded
   
   client_id=<client_id>&scope=offline_access+codex
   ```

2. **返回设备码**：
   ```json
   {
     "device_code": "device_xxx",
     "user_code": "ABCD-1234",
     "verification_uri": "https://auth.openai.com/activate",
     "verification_uri_complete": "https://auth.openai.com/activate?user_code=ABCD-1234",
     "expires_in": 900,
     "interval": 5
   }
   ```

3. **用户授权**：CLI 显示提示，用户在浏览器访问 URL 并输入代码

4. **CLI 轮询 token**：
   ```
   POST https://auth.openai.com/oauth/token
   Content-Type: application/x-www-form-urlencoded
   
   grant_type=urn:ietf:params:oauth:grant-type:device_code
   &device_code=<device_code>
   &client_id=<client_id>
   ```
   每 `interval` 秒轮询一次，直到用户完成授权或超时

5. **获得 token**：
   ```json
   {
     "access_token": "sk-...",
     "token_type": "Bearer",
     "expires_in": 3600,
     "refresh_token": "refresh_xxx",
     "scope": "offline_access codex"
   }
   ```

### 2.3 Token 刷新

- Access token 过期后（约 1 小时），使用 `refresh_token` 获取新 token
- 刷新请求：
  ```
  POST https://auth.openai.com/oauth/token
  grant_type=refresh_token&refresh_token=<refresh_token>&client_id=<client_id>
  ```

## 3. 与 Anthropic OAuth 的对比

| 特性 | Anthropic (Claude Code) | OpenAI (Codex) |
|------|------------------------|----------------|
| OAuth 流程 | Authorization Code + PKCE | Device Code Flow |
| 授权端点 | `oauth.anthropic.com` | `auth.openai.com/oauth/device/code` |
| Token 端点 | `oauth.anthropic.com/token` | `auth.openai.com/oauth/token` |
| Token 过期 | ~8 小时（自动刷新） | ~1 小时（需手动刷新） |
| Scope | `offline_access` + 模型访问 | `offline_access codex` |
| 凭据存储 | `~/.claude/.credentials.json` | `~/.codex/auth.json`（推测） |
| CLI 命令 | `claude login` | `codex login`（推测） |

**关键差异**：
- Anthropic 使用 Authorization Code + PKCE，需要回调 URL（CLI 启动本地 HTTP server）
- OpenAI 使用 Device Code Flow，更简单但需要用户手动输入代码
- Anthropic 的 token 有效期更长（~8h vs ~1h），且 SDK 自动刷新

## 4. 自托管集成方案

### 4.1 集成到 HappyClaw 的方式

1. **Provider 级配置**：用户在 Web 端配置 OpenAI Provider 时，提供 API Key 或通过 OAuth 授权
2. **环境变量注入**：`OPENAI_API_KEY` 或 `OPENAI_BASE_URL` 注入到 agent 进程
3. **引擎选择**：通过 `engineType='openai'` 选择 OpenAIEngine

### 4.2 OAuth 授权集成（未来）

如果要实现类似 Claude Code 的一键 OAuth 登录：

```typescript
// src/codex-oauth.ts 骨架（已创建）

export class CodexOAuthClient {
  private clientId: string;
  private tokenStore: TokenStore;

  /** 启动 Device Code Flow 授权 */
  async authorize(): Promise<DeviceCodeInfo> {
    // POST /oauth/device/code
    // 返回 user_code + verification_uri 给前端展示
  }

  /** 轮询 token 端点，等待用户完成授权 */
  async pollForToken(deviceCode: string): Promise<TokenInfo> {
    // 每 5s 轮询 /oauth/token
    // 直到获得 access_token 或超时
  }

  /** 刷新 access token */
  async refreshToken(refreshToken: string): Promise<TokenInfo> {
    // POST /oauth/token with grant_type=refresh_token
  }

  /** 获取当前有效的 access token（自动刷新） */
  async getAccessToken(): Promise<string | null> {
    // 从存储读取，检查过期，必要时刷新
  }
}
```

### 4.3 前端授权流程

1. 用户点击"登录 Codex"按钮
2. 后端调用 `authorize()` 获取设备码和验证 URL
3. 前端展示："请访问 https://... 输入代码 XXXX"
4. 后端轮询 token 端点
5. 用户完成授权后，后端获得 token 并保存
6. 前端显示"授权成功"

## 5. 已知限制和风险

1. **OpenAI 可能不公开 Codex CLI 的 OAuth client_id**：可能需要自己注册 OAuth App
2. **Device Code Flow 的用户体验**：用户需要手动输入代码，不如 Authorization Code 流畅
3. **Token 过期频繁**：1 小时过期，需要可靠的刷新机制
4. **Codex CLI 可能不支持自定义 Base URL**：如果通过 AgentRouter 访问，可能需要额外配置

## 6. 建议

### 第一版（当前）
- **不实现 Codex OAuth**，用户直接提供 API Key
- 通过 `engineType='openai'` + `OPENAI_API_KEY` 环境变量使用 OpenAI 引擎
- AgentRouter 等第三方网关通过 API Key 认证即可

### 第二版（未来）
- 如果 OpenAI 开放 Codex OAuth 或用户有强烈需求
- 实现 `CodexOAuthClient`，参考 `src/codex-oauth.ts` 骨架
- 前端添加"登录 Codex"按钮，走 Device Code Flow

### 与 Anthropic OAuth 的统一
- 可以抽象出通用的 `OAuthProvider` 接口
- `AnthropicOAuthClient` 和 `CodexOAuthClient` 都实现此接口
- Provider 配置中统一管理 OAuth 凭据

## 7. 参考资料

- OpenAI OAuth 文档：`https://auth.openai.com/.well-known/openid-configuration`
- Device Code Flow RFC：`https://datatracker.ietf.org/doc/html/rfc8628`
- Codex CLI 仓库：`github.com/openai/codex`（需确认）

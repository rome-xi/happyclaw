# Codex CLI OAuth 授权机制调研

> 调研日期：2026-07-10
> 目的：为 HappyClaw 集成 Codex CLI 做准备，了解其 OAuth 授权流程和集成方式。

## 1. Codex CLI 概述

Codex CLI 是 OpenAI 推出的轻量级终端 AI 代码代理（Lightweight coding agent that runs in your terminal）。

- **仓库**：`github.com/openai/codex`（官方开源，Python 实现）
- **定位**：终端内的 AI 代码助手，支持代码补全、代码生成、重构建议、自主代码编辑
- **认证方式**：ChatGPT 账号登录（订阅制）或 API Key（按量计费）
- **与 Claude Code CLI 的关系**：同类终端 AI 工具，但使用 OpenAI 模型（GPT-4o / Codex 系列）

## 2. OAuth 授权流程

### 2.1 支持的认证方式

Codex CLI 提供 **四种** 认证方式：

| 方式 | 命令 | 适用场景 |
|------|------|---------|
| **ChatGPT 登录（默认）** | `codex login` | 本地开发，有浏览器环境 |
| **API Key** | `echo $OPENAI_API_KEY \| codex login --with-api-key` | CI/CD、程序化工作流 |
| **Codex Access Token（企业）** | `echo $CODEX_ACCESS_TOKEN \| codex login --with-access-token` | 企业非交互工作流 |
| **Device Code（beta，无头）** | `codex login --device-auth` | 无头服务器、SSH 远程环境 |

### 2.2 默认流程：Authorization Code + 本地回调

`codex login`（不带参数）使用 **OAuth 2.0 Authorization Code Flow**，通过本地 HTTP 服务器接收回调：

```
┌──────────────┐                                                    ┌──────────────┐
│   Codex CLI  │                                                    │  Auth Server │
│              │  1. 启动本地 HTTP server (port 1455)                │              │
│              │  2. 打开浏览器 → auth.openai.com/authorize          │              │
│              │ ─────────────────────────────────────────────────→ │              │
│              │     ?client_id=...&redirect_uri=http://localhost:1455/callback │
│              │     &response_type=code&code_challenge=...&scope=openid+offline_access │
│              │                                                    │              │
│   用户浏览器  │  3. 用户登录 ChatGPT 并授权                         │              │
│              │ ─────────────────────────────────────────────────→ │              │
│              │ ←───────────────────────────────────────────────── │              │
│              │  4. 重定向到 localhost:1455/callback?code=...       │              │
│              │                                                    │              │
│   Codex CLI  │  5. 用 code + code_verifier 换 token                │              │
│              │ ─────────────────────────────────────────────────→ │              │
│              │ ←───────────────────────────────────────────────── │              │
│              │  6. 获得 access_token + refresh_token               │              │
└──────────────┘                                                    └──────────────┘
```

**关键细节**：
- 本地回调端口：**1455**（SSH 端口转发场景：`ssh -L 1455:localhost:1455 user@remote`）
- 使用 **PKCE**（S256 code challenge method）防止授权码截获攻击
- 重定向 URI：`http://localhost:1455/callback`（或 `http://127.0.0.1:1455/callback`）

### 2.3 Device Code Flow（beta，无头环境）

`codex login --device-auth` 使用 **OAuth 2.0 Device Authorization Grant**（RFC 8628）：

```
┌──────────────┐     1. 请求设备码        ┌──────────────┐
│   Codex CLI  │ ──────────────────────→ │  Auth Server │
│              │ ←────────────────────── │              │
└──────────────┘     2. 返回设备码        └──────────────┘
     │                  + 用户码
     │
     │  3. 显示提示："请访问 https://chatgpt.com/activate 输入代码 ABCD-1234"
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

**前置条件**：需先在 ChatGPT 安全设置中启用 Device Code Flow 功能（个人账号）或在工作区权限中开启（管理员）。

### 2.4 OAuth 端点

从 `https://auth.openai.com/.well-known/openid-configuration` 获取：

| 端点 | URL |
|------|-----|
| Issuer | `https://auth.openai.com` |
| Authorization | `https://auth.openai.com/api/accounts/authorize` |
| Token | `https://auth.openai.com/api/accounts/oauth/token` |
| UserInfo | `https://auth.openai.com/api/accounts/oauth/userinfo` |
| JWKS | `https://auth.openai.com/.well-known/jwks.json` |

**支持的参数**：
- Response type：`code`（仅 Authorization Code）
- PKCE：`S256` code challenge method
- Grant types：`authorization_code`、`refresh_token`
- Token endpoint auth：`client_secret_basic`、`client_secret_post`、`none`（公共客户端，如 CLI）

### 2.5 Scope

| Scope | 说明 |
|-------|------|
| `openid` | OpenID Connect 基础标识 |
| `profile` | 用户基本信息（昵称、头像等） |
| `email` | 用户邮箱 |
| `offline_access` | 获取 refresh_token（长期访问必需） |

> 注：Codex CLI 的模型访问权限不通过 OAuth scope 控制，而是由 ChatGPT 订阅/工作区权限决定。OAuth 仅用于身份认证和获取 API 访问凭据。

### 2.6 Token 刷新

- Access token 有效期：约 **1 小时**
- Refresh token：长期有效，可用于获取新的 access token
- 自动刷新：Codex CLI 在 access token 过期前自动使用 refresh token 刷新，用户无需手动重新登录
- 刷新请求：
  ```
  POST https://auth.openai.com/api/accounts/oauth/token
  Content-Type: application/x-www-form-urlencoded

  grant_type=refresh_token
  &refresh_token=<refresh_token>
  &client_id=<client_id>
  ```

### 2.7 Token 存储

| 存储位置 | 说明 |
|---------|------|
| `~/.codex/auth.json` | 默认文件存储（明文） |
| OS 密钥库（keyring） | 可选安全存储（macOS Keychain、Windows Credential Manager、Linux Secret Service） |

**配置选项** `cli_auth_credentials_store`：
- `file`：明文存储在 `~/.codex/auth.json`
- `keyring`：使用操作系统安全存储
- `auto`（默认）：优先 keyring，不可用时回退到 file

> **安全提示**：`auth.json` 包含 access token，应视为密码级敏感信息，不提交到版本控制、不粘贴到工单。

### 2.8 企业管理功能

- `forced_login_method = "chatgpt" | "api"`：管理员强制指定登录方式
- `forced_chatgpt_workspace_id`：锁定到特定工作区
- `CODEX_CA_CERTIFICATE`：自定义 CA 证书（企业代理/私有根证书）
- `codex login status`：查看当前认证状态
- `codex-login.log`：登录诊断日志

## 3. 与 Anthropic OAuth（Claude Code CLI）的对比

| 特性 | Anthropic (Claude Code) | OpenAI (Codex) |
|------|------------------------|----------------|
| **默认 OAuth 流程** | Authorization Code + PKCE | Authorization Code + PKCE |
| **本地回调端口** | 动态（SDK 选择） | 固定 1455 |
| **Device Code Flow** | 不支持（需 SSH 端口转发） | 支持（beta，`--device-auth`） |
| **授权端点** | `oauth.anthropic.com/oauth2/auth` | `auth.openai.com/api/accounts/authorize` |
| **Token 端点** | `oauth.anthropic.com/oauth2/token` | `auth.openai.com/api/accounts/oauth/token` |
| **PKCE** | S256 | S256 |
| **Scope** | `offline_access` + 模型访问 | `openid profile email offline_access` |
| **Access Token 有效期** | ~8 小时 | ~1 小时 |
| **自动刷新** | SDK 内置 | CLI 内置 |
| **凭据存储** | `~/.claude/.credentials.json` | `~/.codex/auth.json` 或 OS keyring |
| **登录命令** | `claude login` | `codex login` |
| **登出命令** | `claude logout` | `codex logout` |
| **API Key 替代** | 支持（`ANTHROPIC_API_KEY`） | 支持（`OPENAI_API_KEY`） |
| **无头环境** | SSH 端口转发回调端口 | Device Code Flow 或端口转发 |

**关键异同**：
- **相同点**：都使用 Authorization Code + PKCE 作为默认流程，都启动本地 HTTP server 接收回调，都支持 API Key 作为替代
- **不同点**：
  1. Codex 额外支持 Device Code Flow（beta），更适合无头环境
  2. Codex 的 access token 有效期更短（1h vs 8h），但自动刷新机制相同
  3. Codex 支持 OS keyring 安全存储，Anthropic 目前仅文件存储
  4. Codex 有企业级管控（强制登录方式、工作区锁定）
  5. Anthropic 的 OAuth 端点域名不同（`oauth.anthropic.com` vs `auth.openai.com`）

## 4. 自托管集成方案

### 4.1 集成到 HappyClaw 的方式

**当前阶段（推荐）**：
- 用户直接提供 API Key（`OPENAI_API_KEY` 环境变量）
- 通过 AgentEngine 抽象层的 `engineType='openai'` 选择 OpenAI 引擎
- AgentRouter 等第三方网关通过 API Key 认证即可
- 无需实现 OAuth，复杂度最低

**未来阶段（OAuth 集成）**：
如果用户有通过 ChatGPT 订阅使用 Codex 的需求，可实现 `CodexOAuthClient`：

1. **Provider 级配置**：在 Provider 配置中添加 "OAuth 授权" 选项
2. **两种授权模式**：
   - **Authorization Code 模式**（推荐本地部署）：后端启动临时 HTTP server 接收回调，或通过 Web 端重定向
   - **Device Code 模式**（推荐远程/无头）：展示 user_code + verification URL，后端轮询
3. **Token 注入**：授权成功后，将 access token 注入到 agent 进程环境变量（`OPENAI_API_KEY` 或自定义 header）
4. **自动刷新**：后台定时检查 token 过期，自动刷新

### 4.2 前端授权流程（Device Code 模式）

```
用户点击 "登录 Codex"
    ↓
后端调用 authorize() → POST /oauth/device/code
    ↓
返回 { user_code, verification_uri, verification_uri_complete, device_code, interval }
    ↓
前端展示："请访问 https://chatgpt.com/activate 输入代码 ABCD-1234"
    ↓
（可选）展示二维码，内容为 verification_uri_complete
    ↓
后端轮询 POST /oauth/token（每 interval 秒）
    ↓
用户在浏览器完成授权
    ↓
后端获得 access_token + refresh_token
    ↓
保存到 TokenStore（关联 provider_id + user_id）
    ↓
前端显示 "授权成功"
```

### 4.3 前端授权流程（Authorization Code 模式）

```
用户点击 "登录 Codex"
    ↓
后端生成 code_verifier + code_challenge
    ↓
重定向到 auth.openai.com/api/accounts/authorize
    ?client_id=...&redirect_uri=...&response_type=code
    &code_challenge=...&code_challenge_method=S256
    &scope=openid+offline_access
    ↓
用户在 ChatGPT 登录并授权
    ↓
ChatGPT 重定向回 redirect_uri?code=...
    ↓
后端用 code + code_verifier 换 token
    ↓
保存到 TokenStore
    ↓
前端显示 "授权成功"
```

## 5. 已知限制和风险

1. **OpenAI OAuth Client ID 不公开**：Codex CLI 内置的 client_id 属于 OpenAI，自托管应用需要在 [OpenAI Platform](https://platform.openai.com/) 注册自己的 OAuth App 来获取 client_id
2. **Device Code Flow 处于 beta**：需要用户手动在 ChatGPT 设置中启用，且可能随时变更
3. **Token 过期频繁**：1 小时过期，需要可靠的自动刷新机制
4. **Codex CLI 可能不支持自定义 Base URL**：如果通过 AgentRouter 访问，可能需要额外配置或代理
5. **企业管控限制**：如果用户的 ChatGPT 工作区启用了 `forced_login_method`，可能无法使用 API Key 方式
6. **Scope 限制**：OAuth scope 只控制身份认证，模型访问由 ChatGPT 订阅/工作区权限决定。自托管应用可能无法通过 OAuth 获取模型 API 访问权限

## 6. 建议

### 第一版（当前）
- **不实现 Codex OAuth**，用户直接提供 API Key
- 通过 `engineType='openai'` + `OPENAI_API_KEY` 环境变量使用 OpenAI 引擎
- AgentRouter 等第三方网关通过 API Key 认证即可
- 在 Provider 配置中添加 `engineType` 字段

### 第二版（未来）
- 如果用户有强烈需求通过 ChatGPT 订阅使用 Codex
- 实现 `CodexOAuthClient`，参考 `src/codex-oauth.ts` 骨架
- 优先实现 Device Code Flow（更适合自托管无头环境）
- 前端添加 "登录 Codex" 按钮，走 Device Code Flow
- 需要先在 OpenAI Platform 注册 OAuth App

### 与 Anthropic OAuth 的统一抽象
- 可以抽象出通用的 `OAuthProvider` 接口：
  ```typescript
  interface OAuthProvider {
    authorize(): Promise<AuthChallenge>;
    pollForToken(challenge: AuthChallenge): Promise<TokenInfo>;
    refreshToken(refreshToken: string): Promise<TokenInfo>;
    getAccessToken(providerId: string): Promise<string | null>;
    logout(providerId: string): Promise<void>;
  }
  ```
- `AnthropicOAuthClient` 和 `CodexOAuthClient` 都实现此接口
- Provider 配置中统一管理 OAuth 凭据

## 7. 参考资料

- Codex CLI 仓库：[github.com/openai/codex](https://github.com/openai/codex)
- Codex 认证文档：[learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)
- OpenAI OpenID Configuration：[auth.openai.com/.well-known/openid-configuration](https://auth.openai.com/.well-known/openid-configuration)
- Device Code Flow RFC 8628：[datatracker.ietf.org/doc/html/rfc8628](https://datatracker.ietf.org/doc/html/rfc8628)
- PKCE RFC 7636：[datatracker.ietf.org/doc/html/rfc7636](https://datatracker.ietf.org/doc/html/rfc7636)
- OpenAI Platform：[platform.openai.com](https://platform.openai.com/)

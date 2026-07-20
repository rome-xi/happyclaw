# Dennis 个性化 fork：第二台设备部署指南

这份文档只描述 `rome-xi/happyclaw` 的个性化运行栈。仓库代码不包含账号凭据、
new-api 数据库或 Codex OAuth；迁移时必须从第一台设备安全复制，不能提交到 Git。

## 1. 这套 fork 改了什么

- 全宿主机模式：所有用户、工作区、对话 Agent 和定时任务均走 host runner；默认不需要 HappyClaw Agent Docker 镜像。
- 四档模型：`max / high / balance / fast`。候选能力档由人工维护，健康候选中按实测延迟选最快，类似 Clash 自动选优。
- `max/high` 候选包含 ChatGPT Pro 的 `gpt-5.6-sol`、AgentRouter 的 `claude-opus-4-8` 和 super-relay 强模型。OpenAI Responses 候选经本地适配器转换后，可与 Anthropic Messages 候选在同一档竞速。
- 本机四档网关不需要在 HappyClaw 保存真实 API key；代码只为非 Claude 的本机 tier alias 注入一个无秘密的 CLI 登录哨兵。
- `/compact <重点保留说明>` 透传给 Claude SDK 做真实手动压缩；裸 `/compact` 保留旧的删 session + DB 重灌行为。
- IM 会继续发送截断、自动续写和压缩续段，不再比 Web 少后半段，同时仍过滤无关的后台 Task 回声。
- `container/skills/codex-image` 是全局项目 skill；所有工作区自动发现，通过本机 codex-proxy 使用 ChatGPT Pro 生图。

## 2. 组件和端口

| 组件 | 默认地址 | 是否在本仓库 | 用途 |
|---|---:|---|---|
| HappyClaw | `127.0.0.1:3100`（本机实际值以 `WEB_PORT` 为准） | 是 | Web、IM、Agent 主服务 |
| new-api | `127.0.0.1:3010` | 否 | 保存真实上游渠道和四个 tier 虚拟渠道 |
| tier gateway | `127.0.0.1:3011` | 是 | `claude-*` 可 OAuth 透传；其余模型交给 new-api |
| codex-proxy | `127.0.0.1:19080` | 否 | ChatGPT Pro 文本模型与 `/v1/images` 生图 |

所有代理端口都只应监听 loopback。公网只暴露经 HTTPS 反代后的 HappyClaw Web 端口。

## 3. 安装仓库与运行依赖

```bash
git clone git@github.com:rome-xi/happyclaw.git ~/happyclaw
cd ~/happyclaw

npm install
npm --prefix web install
npm --prefix container/agent-runner install
make build
```

建议 Node.js 20+、Python 3.10+。HappyClaw 本身默认不要求 Docker；如果 new-api
使用 Docker，Docker 只服务 new-api。

建立 0600 环境文件：

```bash
mkdir -p ~/.config/happyclaw
install -m 600 /dev/null ~/.config/happyclaw/happyclaw.env
```

至少写入以下非秘密/路径配置；秘密值直接在第二台设备编辑，不要通过聊天或 Git 传输：

```dotenv
HAPPYCLAW_HOST_ONLY=true
WEB_PORT=3100
TZ=Asia/Shanghai
NEWAPI_URL=http://127.0.0.1:3010
NEWAPI_TOKEN_FILE=/home/YOUR_USER/.config/happyclaw/newapi.token
# 二选一：NEWAPI_ADMIN_PASSWORD，或 NEWAPI_ADMIN_CRED 指向 0600 凭据文件
TIER_PROBE_INTERVAL_MS=1200000
```

安装 HappyClaw user service：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/happyclaw.user.service ~/.config/systemd/user/happyclaw.service
systemctl --user daemon-reload
systemctl --user enable happyclaw.service
```

模板默认工作目录是 `%h/happyclaw`；仓库放在别处时先修改 unit。

## 4. 恢复 HappyClaw 数据

第一台设备在服务停止或数据库空闲时执行：

```bash
cd ~/happyclaw
make backup
```

将生成的 `happyclaw-backup-*.tar.gz` 通过可信加密通道复制到第二台设备，再执行：

```bash
cd ~/happyclaw
make restore FILE=happyclaw-backup-YYYYMMDD-HHMMSS.tar.gz
```

备份包含 `data/db`、`data/config`、工作区、skills 和 session。尤其要保证
`data/config/claude-provider.json` 与 `data/config/claude-provider.key` 成对迁移；
只复制密文而漏掉 key 将无法恢复 provider/IM 凭据。迁移完成后检查所有 secret 文件权限为 0600。

## 5. 部署 new-api 和四档渠道

new-api 不属于本仓库。可恢复第一台设备的 new-api 数据卷/数据库，也可重新安装后在管理 UI
创建渠道。迁移数据库时先停止 new-api，并同时保存其管理账号凭据。

四档探针依赖以下**精确渠道名**：

| 源渠道名 | 至少包含的模型 |
|---|---|
| `super-relay (字节内部)` | `model_hub/es1_orange_o48`、`model_hub/es1_orange_o47`、`auto_model/60b-sota`、`ark/60b-0614c`、`model_api/experimental_0630`、`auto_model/alwaysday1` |
| `codex-pro` | `gpt-5.6-sol` |
| `AgentRouter opus` | `claude-opus-4-8` |

再创建四个虚拟渠道：

| 渠道名 | 对外模型名 |
|---|---|
| `tier-max` | `max` |
| `tier-high` | `high` |
| `tier-balance` | `balance` |
| `tier-fast` | `fast` |

每个 tier 初始可复制任一健康源渠道的 `base_url/key`，并设置
`model_mapping`（例如 `{"max":"gpt-5.6-sol"}`）。HappyClaw 启动 30 秒后会预检源渠道，
对每个唯一模型经 `127.0.0.1:3011` 做与真实 Claude CLI 同形的 system/tools 正确性 + 延迟探测，
然后原子更新 tier 的 `base_url/key/model_mapping`。
源渠道缺模型、被禁用、key 为空或 API 返回遮罩 key 时会保持当前映射，不做危险覆盖。

四档 provider 的 Claude CLI 自动压缩窗口默认保持在 200k，而不是盲目强制 1M。
这是跨模型池的安全公共上限：只有显式标记为 `[1m]`、且上游确认支持的单模型 provider
才会启用 1M。强行让 fast/balance 候选按 1M 工作，会把长对话变成上游 400 或截断，
反而破坏自动选优的可靠性。

若 new-api 在 Docker 中，`codex-pro` 的 base URL 必须从**容器视角**访问宿主机，Linux
常用 `host.docker.internal`（配 `host-gateway`）或实际 bridge gateway；容器内的
`127.0.0.1:19080` 指向容器自身，不能照抄。

把 new-api 用户 token 写到两边共用的 0600 文件：

```bash
install -m 600 /dev/null ~/.config/happyclaw/newapi.token
# 在本机编辑该文件，只放 token 本身
```

网关与探针会优先读取这个新路径；为兼容第一台实验机，文件缺失时也会只读回退到
`~/gateway/.newapi_token`。新设备仍建议迁移到上面的标准路径，两个文件都不得提交。

## 6. 启动四档 gateway

仓库已带 `scripts/claude-tier-gateway.py` 和 user service 模板：

```bash
cp deploy/systemd/happyclaw-tier-gateway.user.service \
  ~/.config/systemd/user/happyclaw-tier-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now happyclaw-tier-gateway.service
curl -fsS http://127.0.0.1:3011/health
```

健康响应中的 `newapiTokenConfigured` 必须为 `true`。

## 7. 恢复 codex-proxy 与 Codex OAuth

当前 codex-proxy 是独立目录且包含本地 `/v1/images` 扩展，不在 HappyClaw Git 仓库中。
从第一台设备安全复制其源码（排除 `node_modules` 和旧 `dist`），或从原始源码重新安装并确认
`src/routes/images.ts` 仍存在，然后：

```bash
cd ~/codex-proxy
npm install
npm run build
npm run login
npm run status
```

OAuth 通常落在 `~/.codex/auth.json`。推荐在第二台设备重新登录；若必须迁移该文件，使用加密通道并保持 0600。

user service 的核心配置如下（路径按实际安装位置调整）：

```ini
[Service]
WorkingDirectory=%h/codex-proxy
Environment=PORT=19080
Environment=PASSTHROUGH_MODE=true
Environment=CODEX_AUTH_FILE=%h/.codex/auth.json
ExecStart=/usr/bin/env node %h/codex-proxy/dist/index.js
Restart=always
RestartSec=3
```

启动后验证：

```bash
curl -fsS http://127.0.0.1:19080/health
```

`codex-image` skill 无需另装：它位于 `container/skills/`，host context 同步会把项目级 skills
链接进每个 session。可在工作区让 Agent “生成一张测试图并发送”，或直接运行：

```bash
python3 ~/happyclaw/container/skills/codex-image/scripts/gen_image.py \
  --prompt "a minimal blue crab icon on a transparent background" \
  --background transparent --out /tmp/codex-image-smoke.png
```

## 8. 配置 HappyClaw 四档 provider

在 Web 设置中新建第三方 Anthropic provider：

- 名称：`四档 Clash 自动选优`
- Base URL：`http://127.0.0.1:3011`
- 主模型：`max`
- API key / Auth token：留空。代码会对本机非 `claude-*` tier alias 自动注入无秘密哨兵，避免 Claude CLI 报 `Not logged in`。
- 自定义环境变量：

```text
ANTHROPIC_CUSTOM_HEADERS=x-relay-passthrough: anthropic
ANTHROPIC_DEFAULT_OPUS_MODEL=max
ANTHROPIC_DEFAULT_SONNET_MODEL=high
ANTHROPIC_DEFAULT_HAIKU_MODEL=fast
```

这里的 provider 入口协议必须选 **Anthropic Messages API**，以保留 Claude Agent SDK 的
Workflow、Sub-Agent 和完整工具能力；这并不限制候选只能是 Anthropic 模型。网关会规范化
Claude CLI 请求，`codex-pro` 再把它转换为原生 OpenAI Responses 请求。探针因此可以在同一
工作区、同一 tier alias 后面切换 Anthropic 与 OpenAI 上游，而无需用户手工换引擎。

切换顺序必须是：先启用四档 provider，发一条简单消息确认成功，再禁用旧 relay。不要先关掉唯一健康 provider。
`balance` 是可显式选择的经济档，不占 Claude Code 内建 opus/sonnet/haiku 三个槽位。

## 9. 构建、启动和验收

```bash
cd ~/happyclaw
make typecheck
make test
make build
systemctl --user restart happyclaw.service
systemctl --user is-active happyclaw.service
curl -fsS http://127.0.0.1:3100/api/health
```

验收清单：

1. Web 与一个实际 IM 渠道各发普通消息，确认模型不是 `Not logged in`。
2. 发送足够长的任务或触发续写，确认 IM 收到后续完整段落。
3. 发送 `/compact 重点保留四档部署、未完成事项和关键路径`，确认会话仍可继续且日志出现 manual PreCompact；裸 `/compact` 仍走兼容重置流程。
4. 等首轮探针完成，检查日志中的 `tier-prober: winner unchanged/updated`，并在 new-api UI 核对四档 mapping。
5. 请求 Agent 生成并发送图片，确认收到真实图片文件。
6. 新建工作区和定时 Agent 任务，UI 应只显示“宿主机（固定）”，系统不创建 HappyClaw Agent 容器。

## 10. 更新与回滚

更新前先 `make backup`，再拉取 fork：

```bash
git fetch fork
git pull --ff-only fork main
make typecheck && make test && make build
systemctl --user restart happyclaw.service
```

代码回滚用 Git 切回上一个已知良好 commit 后重新构建。数据回滚使用对应时间点的
`happyclaw-backup-*.tar.gz`；不要把新版数据库和旧版代码随意混搭。provider 故障时先重新启用旧 relay，
再排查 `3010/3011/19080`，避免所有工作区同时失去可用上游。

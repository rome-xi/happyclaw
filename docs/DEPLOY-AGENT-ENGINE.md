# AgentEngine 重构部署清单

> 分支：`feat/agent-engine`
> 日期：2026-07-10
> 回滚目标 commit：`a16bb15`（main 分支，重构前最后一个稳定 commit）

---

## 1. 前置检查

### 1.1 确认当前分支

```bash
cd /home/theonlyheart/happyclaw
git branch --show-current
# 应输出: feat/agent-engine
```

### 1.2 确认 dist 备份

```bash
# 检查是否已有备份（20260709 是重构前的最后一次构建）
ls -d dist.pre-agent-engine.*
# 应输出: dist.pre-agent-engine.20260709
# agent-runner 同理:
ls -d container/agent-runner/dist.pre-agent-engine.*
```

**如果备份不存在，立即创建：**

```bash
# 备份当前运行中的 dist（即重构前的版本）
cp -a dist dist.pre-agent-engine.$(date +%Y%m%d)
cp -a container/agent-runner/dist container/agent-runner/dist.pre-agent-engine.$(date +%Y%m%d)
```

### 1.3 数据库备份

```bash
make backup
# 输出: 备份到 happyclaw-backup-2026-07-10.tar.gz
```

### 1.4 确认服务健康

```bash
curl -s http://127.0.0.1:3100/api/health | python3 -m json.tool
# 应输出: {"status":"healthy","checks":{"database":true,"queue":true,...}}
```

---

## 2. 部署步骤

### 2.1 拉取最新代码（如需要）

```bash
cd /home/theonlyheart/happyclaw
git pull --rebase origin feat/agent-engine
```

### 2.2 构建

```bash
make build
```

预期输出（全部 exit code 0）：
- `backend`: `tsc` 编译通过
- `web`: `tsc && vite build` 编译通过
- `agent-runner`: `tsc` 编译通过

### 2.3 重启服务

```bash
systemctl --user restart happyclaw

# 等待 5 秒让服务完全启动
sleep 5

# 检查状态
systemctl --user is-active happyclaw
# 应输出: active
```

### 2.4 部署后验证

```bash
# 健康检查
curl -s http://127.0.0.1:3100/api/health | python3 -m json.tool

# 检查 Provider engineType 字段
# 需要先登录获取 cookie，或在 Web 端设置页面查看
```

---

## 3. 冒烟测试清单

### 3.1 基本消息处理（必做）

- [ ] **Web 端发消息**：登录 Web 界面，向主工作区发送一条简单消息（如"你好"），确认收到回复
- [ ] **检查流式卡片**：发送消息后，确认 Web 端显示流式打字机效果（text_delta 事件正常）
- [ ] **检查 thinking block**：确认 Anthropic 引擎的 thinking 折叠块正常显示

### 3.2 工具调用验证

- [ ] 发送"帮我看看当前目录有什么文件"，确认 Bash 工具被调用且返回结果
- [ ] 确认工具调用的进度显示（tool_use_start → tool_progress → tool_use_end）正常

### 3.3 IM 通道（如配置了）

- [ ] **Telegram**：给 Bot 发一条消息，确认收到回复
- [ ] **飞书**：给机器人发消息或在群里 @机器人，确认收到回复
- [ ] **钉钉**：给机器人发消息，确认收到回复（钉钉 AI Card 流式）

### 3.4 Provider 管理界面

- [ ] 打开设置 → Provider 管理
- [ ] 确认现有 Provider 正常显示（engineType 默认为 "Anthropic Messages API"）
- [ ] 点击"添加提供商"，确认表单中有"引擎协议"下拉框
- [ ] 下拉框选项：Anthropic Messages API（默认）/ OpenAI Responses API

### 3.5 会话恢复

- [ ] 关闭当前对话（或等空闲超时），重新发消息
- [ ] 确认 Agent 能引用之前的上下文（会话恢复正常）

### 3.6 OpenAI 引擎测试（可选，需有兼容 Provider）

- [ ] 创建一个 engineType=openai 的 Provider（Base URL 指向支持 `/v1/responses` 的 relay）
- [ ] 切换到该 Provider，发送测试消息
- [ ] 验证收到回复（注意：Sub-Agent 和 compact 暂不支持，thinking block 不显示）

---

## 4. 回滚步骤

### 4.1 快速回滚（推荐：恢复 dist 备份）

适用于构建产物损坏或运行时崩溃的情况：

```bash
cd /home/theonlyheart/happyclaw

# 停止服务
systemctl --user stop happyclaw

# 恢复备份 dist
rm -rf dist
cp -a dist.pre-agent-engine.20260709 dist

rm -rf container/agent-runner/dist
cp -a container/agent-runner/dist.pre-agent-engine.20260709 container/agent-runner/dist

# 重启服务
systemctl --user start happyclaw

# 验证
sleep 3
systemctl --user is-active happyclaw
curl -s http://127.0.0.1:3100/api/health
```

### 4.2 Git 回滚（代码级回退）

适用于需要回退代码到重构前版本的情况：

```bash
cd /home/theonlyheart/happyclaw

# 记录当前 commit（方便事后恢复）
git rev-parse HEAD > /tmp/feat-agent-engine-head.txt

# 回退到 main 分支最后一个稳定 commit
git reset --hard a16bb15

# 重新构建
make build

# 重启
systemctl --user restart happyclaw

# 验证
sleep 5
systemctl --user is-active happyclaw
curl -s http://127.0.0.1:3100/api/health
```

**恢复到 feat/agent-engine**（如需撤销回滚）：
```bash
cd /home/theonlyheart/happyclaw
git reset --hard $(cat /tmp/feat-agent-engine-head.txt)
make build
systemctl --user restart happyclaw
```

### 4.3 数据回滚

```bash
# 从 tar.gz 备份恢复（如果需要）
make restore FILE=happyclaw-backup-2026-07-10.tar.gz
```

---

## 5. 风险点

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **Provider engineType 默认值** | 现有 Provider 不受影响 | 无 | 默认 `'anthropic'`，完全向后兼容；StoredProviderV4 读取时缺省值也是 `'anthropic'` |
| **现有会话兼容性** | 切换 engineType 后旧 session 不可用 | 低 | `trySelectPoolProvider` 检查 engineType 兼容性，不兼容时自动清除旧 session 并新建；用户手动改 Provider 的 engineType 后第一次对话会重置会话 |
| **OOM 风险** | 服务崩溃 | 低 | OpenAIEngine 约 300 行新增代码，内存增量 < 10MB；NAS 13G 内存，当前服务占用 ~200MB；监控 `systemctl --user status happyclaw` 的 Memory 字段 |
| **OpenAI 引擎不完整** | 功能受限 | 已知 | OpenAI 引擎不产生 thinking_delta、compact_boundary、task_*、hook_* 事件；UI 对缺失事件做了容错（不显示 thinking block）；Sub-Agent 不可用 |
| **SSE 解析异常** | 流式中断 | 低 | OpenAIEngine 的 fetch + reader 被 try-catch 包裹，错误时 emit status(error)；前端收到 error 状态后清除流式显示 |
| **工具循环死循环** | 消耗大量 tokens | 低 | `maxTurns` 限制（默认 20），超限 emit status(max_turns) 并强制停止 |

---

## 6. 监控命令

```bash
# 服务状态
systemctl --user status happyclaw

# 实时日志（journalctl，systemd --user 模式）
journalctl --user -u happyclaw -f --since "5 min ago"

# 健康检查（循环）
watch -n 5 'curl -s http://127.0.0.1:3100/api/health'

# 容器/进程列表（需登录 cookie）
curl -s -b /tmp/cookies.txt http://127.0.0.1:3100/api/monitor/status | python3 -m json.tool

# 数据库最近消息
python3 -c "
import sqlite3
c = sqlite3.connect('data/db/messages.db')
print('最近 5 条消息:')
for r in c.execute('SELECT timestamp, chat_jid, substr(content,1,80), is_from_me FROM messages ORDER BY timestamp DESC LIMIT 5'):
    print(f'  {r[0][:19]} | {\"ME\" if r[3] else \"USER\"} | {r[1][:30]} | {r[2]}')
"

# 内存使用
ps -o pid,rss,cmd -p $(systemctl --user show happyclaw --property=MainPID --value)
```

---

## 7. 新增/修改文件清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `container/agent-runner/src/engines/types.ts` | AgentEngine 接口定义（EngineSession、EngineConfig、EngineToolDefinition 等） |
| `container/agent-runner/src/engines/claude-engine.ts` | ClaudeEngine 实现（包装 Anthropic Agent SDK） |
| `container/agent-runner/src/engines/openai-engine.ts` | OpenAIEngine 实现（/v1/responses + SSE 流式 + 手动工具循环） |
| `container/agent-runner/src/engines/index.ts` | 引擎工厂（根据 HAPPYCLAW_ENGINE_TYPE 环境变量创建实例） |
| `src/codex-oauth.ts` | Codex OAuth 骨架代码 |
| `docs/AGENT-ENGINE-DESIGN.md` | 设计文档（B 方案） |
| `docs/CODEX-OAUTH-RESEARCH.md` | Codex CLI OAuth 授权机制调研 |
| `docs/DEPLOY-AGENT-ENGINE.md` | 本文档 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/runtime-config.ts` | UnifiedProvider + StoredProviderV4 新增 `engineType` 字段（默认 `'anthropic'`） |
| `src/schemas.ts` | UnifiedProviderCreateSchema / PatchSchema 新增 `engineType` zod 校验 |
| `src/container-runner.ts` | host agent 注入 `HAPPYCLAW_ENGINE_TYPE` 环境变量；sticky session 检查 engineType 兼容性 |
| `web/src/components/settings/types.ts` | 前端 UnifiedProviderPublic 新增 `engineType` 字段 |
| `web/src/components/settings/ProviderEditor.tsx` | Provider 表单新增"引擎协议"下拉框（Anthropic / OpenAI） |

---

## 8. 验证结果记录

部署后在此记录验证结果：

```
部署时间: _______________
部署人: Dennis
构建结果: pass / fail
重启结果: pass / fail
冒烟测试:
  [ ] Web 消息回复正常
  [ ] 流式卡片正常
  [ ] thinking block 正常
  [ ] 工具调用正常
  [ ] IM 通道正常（Telegram / 飞书 / 钉钉）
  [ ] Provider 管理界面正常
备注:
```
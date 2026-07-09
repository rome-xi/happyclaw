# AgentEngine 重构部署清单

> 版本：feat/agent-engine 分支
> 日期：2026-07-10

## 1. 前置检查

### 1.1 确认当前状态

```bash
cd /home/theonlyheart/happyclaw

# 确认在正确分支
git branch --show-current
# 应输出: feat/agent-engine

# 确认 dist 备份存在
ls -d dist.pre-agent-engine.*
# 应输出: dist.pre-agent-engine.20260710
```

### 1.2 备份运行时数据

```bash
make backup
# 输出: 备份到 happyclaw-backup-2026-07-10.tar.gz
```

### 1.3 确认健康检查端口

```bash
# 确认 happyclaw 监听端口（默认 3100）
grep WEB_PORT ~/.config/happyclaw/happyclaw.env
# 应输出: WEB_PORT=3100
```

## 2. 部署步骤

### 2.1 构建

```bash
cd /home/theonlyheart/happyclaw
make build
```

预期输出：
```
npx tsc --noEmit          # 后端类型检查 ✓
cd web && npx tsc --noEmit  # 前端类型检查 ✓
cd container/agent-runner && npx tsc --noEmit  # agent-runner 类型检查 ✓
All shared type copies are in sync.
✓ All 10 prompt references resolved
```

### 2.2 运行测试

```bash
make test
```

预期：`Test Files 72 passed (72), Tests 982 passed (982)`

### 2.3 重启服务

```bash
systemctl --user restart happyclaw

# 等待 5 秒让服务启动
sleep 5

# 检查状态
systemctl --user is-active happyclaw
# 应输出: active
```

### 2.4 冒烟测试

```bash
# 1. Health check
curl -s http://127.0.0.1:3100/api/health | python3 -m json.tool
# 应输出: {"status":"healthy","checks":{"database":true,"queue":true,...}}

# 2. 检查 Provider 列表（验证 engineType 字段）
# 登录 Web 后访问:
curl -s -b /tmp/cookies.txt http://127.0.0.1:3100/api/config/claude/providers | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('providers', []):
    print(f\"  {p['name']}: engineType={p.get('engineType', 'default(anthropic)')}\")
"

# 3. 检查运行中的 agent
curl -s -b /tmp/cookies.txt http://127.0.0.1:3100/api/monitor/status | python3 -m json.tool
```

## 3. 功能验证清单

### 3.1 基本消息处理
- [ ] 发送一条消息给主工作区，收到回复
- [ ] 检查 Web 端流式卡片正常显示
- [ ] 检查 thinking block 正常显示（Anthropic 引擎）
- [ ] 检查工具调用（Bash/Read）正常执行

### 3.2 Provider 管理
- [ ] 打开设置 → Provider 管理
- [ ] 确认现有 Provider 显示正常（engineType 默认为 Anthropic）
- [ ] 点击"添加提供商"，确认表单中有"引擎类型"下拉框
- [ ] 选项：Anthropic Messages API（默认）/ OpenAI Responses API

### 3.3 IM 通道
- [ ] Telegram 消息正常接收和回复
- [ ] 飞书消息正常接收和回复（如果配置了）

### 3.4 定时任务
- [ ] 检查定时任务正常执行
- [ ] DCA tick 任务正常运行（如果配置了）

### 3.5 OpenAI 引擎测试（可选）
- [ ] 创建一个 engineType=openai 的 Provider
- [ ] 切换到该 Provider，发送测试消息
- [ ] 验证收到回复（注意：Sub-Agent 和 compact 暂不支持）

## 4. 回滚步骤

### 4.1 快速回滚（使用备份 dist）

```bash
cd /home/theonlyheart/happyclaw

# 停止服务
systemctl --user stop happyclaw

# 恢复备份 dist
rm -rf dist
cp -r dist.pre-agent-engine.20260710 dist

# 重启服务
systemctl --user start happyclaw

# 验证
sleep 3
systemctl --user is-active happyclaw
curl -s http://127.0.0.1:3100/api/health
```

### 4.2 Git 回滚

```bash
cd /home/theonlyheart/happyclaw

# 切回 main 分支
git checkout main

# 重新构建
make build

# 重启
systemctl --user restart happyclaw
```

### 4.3 数据回滚

```bash
# 从备份恢复（如果需要）
make restore FILE=happyclaw-backup-2026-07-10.tar.gz
```

## 5. 风险点

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| OOM（新增代码增加内存） | 服务崩溃 | 低 | NAS 13G 内存，监控内存使用 |
| Provider engineType 默认值 | 现有 Provider 不受影响 | 无 | 默认 'anthropic'，完全向后兼容 |
| 会话兼容性 | 切换 engineType 后旧会话不可用 | 低 | engineType 变更仅影响新会话 |
| Watchdog 误重启 | 服务频繁重启 | 已修复 | 端口 3000→3100 已修复 |
| OpenAI 引擎不完整 | 功能受限 | 已知 | 仅 Anthropic 引擎保证完整功能 |

## 6. 监控命令

```bash
# 服务状态
systemctl --user status happyclaw

# 实时日志（如果后台化运行）
journalctl --user -u happyclaw -f

# 或前台运行时的日志
# 直接看终端输出

# 健康检查
watch -n 5 'curl -s http://127.0.0.1:3100/api/health'

# 容器/进程列表
curl -s -b /tmp/cookies.txt http://127.0.0.1:3100/api/monitor/status | python3 -m json.tool

# 数据库检查
python3 -c "
import sqlite3
c = sqlite3.connect('data/db/messages.db')
print('最近 5 条消息:')
for r in c.execute('SELECT timestamp, chat_jid, substr(content,1,80), is_from_me FROM messages ORDER BY timestamp DESC LIMIT 5'):
    print(f'  {r[0][:19]} | {\"ME\" if r[3] else \"USER\"} | {r[1][:30]} | {r[2]}')"
```

## 7. 新增文件清单

| 文件 | 用途 |
|------|------|
| `container/agent-runner/src/engines/types.ts` | AgentEngine 接口定义 |
| `container/agent-runner/src/engines/claude-engine.ts` | ClaudeEngine 实现 |
| `container/agent-runner/src/engines/openai-engine.ts` | OpenAIEngine 实现 |
| `container/agent-runner/src/engines/index.ts` | 引擎工厂 |
| `docs/AGENT-ENGINE-DESIGN.md` | 设计文档 |
| `docs/CODEX-OAUTH-RESEARCH.md` | Codex OAuth 调研 |
| `docs/DEPLOY-AGENT-ENGINE.md` | 本文档 |
| `src/codex-oauth.ts` | Codex OAuth 骨架 |

## 8. 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/runtime-config.ts` | UnifiedProvider + StoredProviderV4 加 engineType 字段 |
| `src/schemas.ts` | UnifiedProviderCreateSchema/PatchSchema 加 engineType 校验 |
| `src/container-runner.ts` | host agent 注入 HAPPYCLAW_ENGINE_TYPE 环境变量 |
| `web/src/components/settings/types.ts` | 前端 UnifiedProviderPublic 加 engineType |
| `web/src/components/settings/ProviderEditor.tsx` | Provider 表单加引擎类型下拉框 |

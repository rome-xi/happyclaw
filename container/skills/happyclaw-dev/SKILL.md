---
name: happyclaw-dev
description: HappyClaw 项目开发指南。当需要修改 HappyClaw 源码、提交 PR、审计代码变更、或了解 HappyClaw 系统架构时使用。
---

# HappyClaw 开发指南

## 1. 系统架构

### 三个独立 Node 项目

| 项目 | 目录 | 运行时 | 用途 |
|------|------|--------|------|
| 主服务 | `/`（根） | 宿主机 | Hono 后端 + WebSocket + IM 连接池 + 任务调度 |
| Web 前端 | `web/` | 浏览器 | React 19 + Zustand + Tailwind + Vite |
| Agent Runner | `container/agent-runner/` | 容器/宿主机进程 | Claude Agent SDK 执行引擎 |

每个项目有独立的 `package.json`、`tsconfig.json`。`shared/` 目录存放跨项目共享类型。

### 消息流

```
IM/Web 消息 → db 存储 + WS 广播
  → index.ts 轮询(2s) → GroupQueue 并发控制
    → container-runner 启动容器/进程
      → agent-runner 执行 Claude SDK query()
        → 流式 StreamEvent → stdout OUTPUT_MARKER 包裹
      → container-runner 解析 → WS stream_event 广播 → 前端渲染
```

### 执行模式

- **host 模式**：admin 主容器（folder=main），宿主机进程直接访问文件系统
- **container 模式**：member 主容器和其他群组，Docker 隔离运行

### 关键数据路径

| 路径 | 说明 |
|------|------|
| `data/groups/{folder}/` | 会话工作目录 |
| `data/sessions/{folder}/.claude/` | Claude 会话持久化 |
| `data/ipc/{folder}/` | IPC 通信（input/messages/tasks） |
| `data/db/messages.db` | SQLite 数据库（WAL 模式） |
| `data/config/` | 加密配置（AES-256-GCM） |

### 前端状态管理

10 个 Zustand Store（`web/src/stores/`）：auth、chat、groups、tasks、monitor、container-env、files、users、skills、mcp-servers。

`chat.ts` 是最复杂的 Store（~2200 行），管理消息、流式状态、Sub-Agent、SDK Task。

## 2. 开发流程

### 2.1 环境准备

```bash
# 克隆 fork 仓库（替换为你的 fork）
git clone git@github.com:YOUR_USER/happyclaw.git
cd happyclaw

# 安装依赖 + 编译
make install && make build

# 开发模式（前后端热重载）
make dev
```

### 2.2 分支管理

```bash
# 从 main 分支创建 feature/fix 分支
git checkout main && git pull origin main
git checkout -b fix/描述

# 开发完成后推送到 fork
git push origin fix/描述

# 通过 GitHub 创建 PR 到上游 main 分支
gh pr create --title "修复: 简要描述" --body "..."
```

### 2.3 提交规范

commit message 使用**简体中文**：

| 前缀 | 用途 | 示例 |
|------|------|------|
| `修复:` | Bug 修复 | `修复: 刷新后子会话流式消息丢失` |
| `功能:` | 新功能 | `功能: 支持 QQ IM 通道` |
| `优化:` | 性能/体验优化 | `优化: textarea 输入防抖动` |
| `重构:` | 代码重构 | `重构: 提取 StreamEventProcessor 类` |
| `文档:` | 文档更新 | `文档: 更新部署指南` |

### 2.4 构建与检查

```bash
make build       # 编译全部（后端 + 前端 + agent-runner）
make typecheck   # TypeScript 全量类型检查（三个项目）
make format      # Prettier 格式化
make sync-types  # 同步 shared/ 类型到各子项目
```

**修改 StreamEvent 类型时**：只编辑 `shared/stream-event.ts`，然后 `make sync-types`。

## 3. 自审计 PR 清单

提交 PR 前，按以下维度自审：

### 3.1 兼容性矩阵

| 维度 | 检查项 |
|------|--------|
| 主会话 / 子会话 | 改动是否影响 Sub-Agent 的 `agentStreaming`？`pid` 判断是否正确？ |
| host / container 模式 | 前端改动两种模式共享；agent-runner 改动需考虑容器内运行环境（node 用户、只读挂载） |
| IM / Web 渠道 | 消息格式差异（飞书富文本 / Telegram HTML / QQ 纯文本 / Web Markdown） |
| 多用户隔离 | 改动是否破坏 per-user 资源隔离（工作目录、会话、IM 连接） |

### 3.2 代码质量

- [ ] 修改后的文件已 `Read` 验证（防幻觉编辑）
- [ ] 无硬编码敏感信息（API key、密码）
- [ ] 新增状态有正确的清理逻辑（`clearStreaming`、`resetFullTextAccumulator` 等）
- [ ] 跨 flush 的有状态逻辑在 session 边界正确重置
- [ ] `sessionStorage` 操作有 try-catch 保护
- [ ] 部分匹配逻辑有最小长度检查（防误匹配）

### 3.3 安全

- [ ] 文件路径操作有遍历防护
- [ ] 用户输入经过校验（Zod schema）
- [ ] 无 XSS 风险（React 默认转义，但 `dangerouslySetInnerHTML` 需审查）
- [ ] 环境变量不泄露到前端或日志

## 4. 开发中发现问题的处理

在开发或审计过程中发现的 bug/陷阱/最佳实践，**立即更新此 skill 的注意事项**：

```bash
# 编辑此 skill 文件
vim container/skills/happyclaw-dev/SKILL.md
# 在「§6. 已知陷阱」章节追加
```

### 更新原则

1. **发现就记录** — 不要等，下次你或别人会踩同样的坑
2. **带上下文** — 说明在哪个文件、什么场景、如何复现
3. **给出解法** — 不只记问题，也记正确做法

## 5. 关键文件测试计划

以下测试计划应在开发和审计过程中**动态迭代**（发现新边界条件就追加）。

### 5.1 `container/agent-runner/src/stream-processor.ts`

流式事件处理核心，最容易出边界 bug。

| 测试场景 | 预期行为 | 验证方法 |
|----------|----------|----------|
| `<internal>` 标签完整在一次 flush 内 | 被过滤，不输出到前端 | 检查 WS stream_event 无 internal 内容 |
| `<internal>` 跨两次 flush 拆分 | 状态机正确跟踪，整段不输出 | 构造长 internal 块，观察前端 |
| 上一个 query 未关闭 `<internal>` | `insideInternal` 在 `processResult()` 重置，下次 query 正常 | 连续发两条消息 |
| 文本末尾有孤立 `<` | 不被误判为 partial tag（需 ≥2 字符） | 发送含 `<br>` 的 Markdown |
| Sub-Agent 流（pid≠undefined） | 不经过 `filterInternalTags`，原样输出 | 触发 Sub-Agent 任务 |
| `fullTextAccumulator` vs SDK result | 取较长者作为最终结果，两者都清理 internal 标签 | 对比日志中 accumulated vs result |

### 5.2 `web/src/stores/chat.ts`

前端状态管理核心，修改需特别谨慎。

| 测试场景 | 预期行为 | 验证方法 |
|----------|----------|----------|
| 刷新页面后主会话流式状态 | 从 sessionStorage 恢复（5 分钟内有效） | F5 刷新，观察流式动画是否恢复 |
| 刷新页面后子会话 Tab | `activeAgentTab` 从 sessionStorage 恢复 | 切到子会话 Tab → 刷新 → Tab 仍选中 |
| `clearStreaming` 调用 | 取消 rAF + 清 sessionStorage + 清 zustand | 在 DevTools 设断点验证 |
| WS 重连后 stream_snapshot | 后端推送快照，前端恢复流式状态（不覆盖已有） | 断网重连，观察流式 UI |
| 多个 chatJid 并行流式 | 各自独立的 streaming/agentStreaming 状态 | 同时开两个会话 |
| sessionStorage 不可用 | try-catch 静默失败，功能降级 | 用隐身模式测试 |

### 5.3 `web/src/components/chat/MessageInput.tsx`

输入框组件。

| 测试场景 | 预期行为 | 验证方法 |
|----------|----------|----------|
| 输入文字时无页面抖动 | `useLayoutEffect` 在 paint 前完成高度计算 | 肉眼观察 + 录屏 |
| 多行输入自动扩展 | 最多 6 行（144px），超出后出现滚动条 | 输入 7+ 行文字 |
| 清空输入后高度回缩 | 回到单行高度（24px） | 输入后全选删除 |
| 移动端键盘弹出 | 不造成布局跳动 | 手机浏览器测试 |

### 5.4 `src/web.ts`

后端 WS + 流式快照。

| 测试场景 | 预期行为 | 验证方法 |
|----------|----------|----------|
| 新 WS 连接收到 stream_snapshot | 如果有活跃流，推送当前快照 | 打开新标签页 |
| Agent 结束后清除快照 | `broadcastRunnerState('idle')` 时清空 | Agent 完成响应后检查 |
| Sub-Agent 流不影响主快照 | 只有 `pid===undefined` 的事件更新快照 | 触发 Sub-Agent |

### 5.5 迭代规则

- 每次修改关键文件时，检查此计划是否需要新增测试场景
- 发现未覆盖的边界条件，**立即追加**到对应表格
- 测试场景标注优先级：P0（必测）/ P1（推荐）/ P2（可选）

## 6. 已知陷阱

> 在开发/审计中发现的坑，持续更新。

### stream-processor.ts

1. **`insideInternal` 必须在 session 边界重置** — `processResult()` 和 `resetFullTextAccumulator()` 都要重置为 `false`，否则一个 query 的未关闭 `<internal>` 会吞掉后续所有输出
2. **partial tag 匹配需最小长度** — `'<internal>'.startsWith(tail)` 在 `tail='<'` 时也为 true，会误拦截所有 `<` 结尾的文本。加 `tail.length >= 2` 检查
3. **只过滤主流（pid===undefined）** — Sub-Agent 流不过滤，避免破坏 Sub-Agent 的正常输出

### chat.ts

1. **sessionStorage 与 zustand 状态不一致** — 写 sessionStorage 要在 `set()` 之后或同步调用，避免崩溃时数据不一致
2. **rAF pending delta 必须在 clearStreaming 中取消** — 否则清理后仍有延迟 flush，导致"僵尸"流式状态
3. **stream_snapshot 不覆盖已有 partialText** — 已有流式状态时说明前端比后端快照更新，跳过

### 通用

1. **禁止 `lsof -ti:PORT | xargs kill`** — 会杀 Docker 网络代理。用 `lsof -ti:PORT -sTCP:LISTEN | xargs kill`
2. **StreamEvent 类型修改后必须 `make sync-types`** — 否则三个项目类型不一致，运行时崩溃
3. **容器内以 node 用户运行** — 文件权限要注意（不是 root）
4. **host 模式重启前检查 IPC** — 确保无活跃 query 在进行中

## 7. 快速参考

```bash
# 开发
make dev                    # 启动开发环境
make typecheck              # 类型检查
make build && make start    # 生产构建并启动

# 调试
cat data/groups/main/logs/*.log | tail -50   # Agent 日志
sqlite3 data/db/messages.db ".tables"        # 查看数据库

# 服务管理（生产环境）
systemctl --user restart happyclaw
journalctl --user -u happyclaw -f
```

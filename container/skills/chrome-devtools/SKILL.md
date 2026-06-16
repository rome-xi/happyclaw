---
name: chrome-devtools
description: 通过 Chrome DevTools Protocol 连接本地 Chrome 浏览器，复用用户已有的登录会话。可执行 JS、抓取页面内容、操作 DOM、截图。用于需要登录态的网页操作（如飞书文档、内部系统），比 agent-browser 更适合需要认证的场景。
allowed-tools: Bash(cdp.sh:*)
---

# Chrome DevTools 远程调试

通过 CDP (Chrome DevTools Protocol) 连接运行中的 Chrome 浏览器实例，复用已有登录会话。

## 前置条件

用户需要以远程调试模式启动 Chrome：

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# 或者追加到已运行的 Chrome（需重启 Chrome）
# 在 chrome://flags 中启用 "Allow remote debugging" 也可以
```

## 使用方式

### 列出所有标签页

```bash
cdp.sh tabs
```

### 在指定标签页执行 JavaScript

```bash
# 在第一个标签页执行
cdp.sh eval 0 'document.title'

# 获取页面文本内容
cdp.sh eval 0 'document.body.innerText'

# 获取页面 HTML
cdp.sh eval 0 'document.documentElement.outerHTML'
```

### 导航到 URL

```bash
cdp.sh navigate 0 'https://example.com'
```

### 截图

```bash
cdp.sh screenshot 0 output.png
```

### 获取页面内容（自动提取文本）

```bash
cdp.sh content 0
```

### 获取 Cookie

```bash
cdp.sh cookies 0
```

## 典型场景

1. **读取飞书文档**：用户已在 Chrome 登录飞书，通过 CDP 直接读取文档内容，无需额外认证
2. **操作内部系统**：复用 SSO 登录态访问公司内部工具
3. **调试前端页面**：执行 JS、检查 DOM、监控网络请求
4. **批量抓取**：在已登录的会话中批量获取数据

## 注意事项

- Chrome 必须以 `--remote-debugging-port=9222` 启动
- 默认连接 `localhost:9222`，可通过 `CDP_HOST` 和 `CDP_PORT` 环境变量配置
- 这个方案复用用户的登录态，**不要在未经用户允许的情况下执行敏感操作**（如发消息、修改数据）
- 如果 Chrome 未开启远程调试，提示用户如何开启

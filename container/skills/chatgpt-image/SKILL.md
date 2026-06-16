# ChatGPT 图片生成

通过 chromium 容器的 CDP 连接操控 ChatGPT Web 界面，使用 GPT-4o 的原生图片生成能力。

## 使用场景

当用户要求「用 ChatGPT 画图」「生成图片」「画个 xxx」时使用此 skill。

## 账号信息

- **登录方式**：Google 账号（在 chromium 容器中预先登录你自己的账号）
- **订阅**：ChatGPT Pro（含 GPT-4o 图片生成）
- **浏览器**：chromium 容器（172.18.0.3），已登录 ChatGPT

## 前置条件

- chromium 容器运行中（`docker ps | grep chromium`）
- chromium 启动时需带 `--remote-debugging-port=9222`
- 容器内需要 socat 转发端口（`socat TCP-LISTEN:9223,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:9222`）
- `agent-browser` 已全局安装

## 关键规则

1. 每条 Bash 命令前加 `export PATH="$HOME/.npm-global/bin:$PATH:/usr/bin"`
2. 通过 `agent-browser connect` 连接到 chromium 容器的 CDP WebSocket
3. ChatGPT 图片生成需要 30-90 秒，等待时间要充足
4. 生成完成后截图保存，用 `send_image` 发送给用户

## 启动流程

### 1. 确认 chromium 容器 CDP 可用

```bash
# 检查容器运行状态
docker ps | grep chromium

# 检查 CDP 端口转发是否存在
curl -s http://172.18.0.3:9223/json/version | head -3

# 如果转发不存在，需要重启：
# 1) 确保 chromium 带 --remote-debugging-port=9222 启动
# 2) docker exec -d chromium socat TCP-LISTEN:9223,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:9222
```

### 2. 连接浏览器

```bash
# 获取 browser WebSocket URL
BROWSER_WS=$(curl -s http://172.18.0.3:9223/json/version | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['webSocketDebuggerUrl'].replace('127.0.0.1','172.18.0.3').replace('9222','9223'))")

# 连接
agent-browser close 2>/dev/null
agent-browser connect "$BROWSER_WS"
```

### 3. 打开 ChatGPT 并验证登录

```bash
agent-browser open "https://chatgpt.com"
sleep 5
agent-browser snapshot -i
# 确认看到 "与 ChatGPT 聊天" 输入框和用户名
# 如果未登录，需要用户通过 VNC (https://IP:3001, admin/密码) 手动登录一次
```

### 4. 发送图片生成 prompt

```bash
# 填入 prompt
agent-browser fill '@eXX' '你的图片描述 prompt'
sleep 1
agent-browser press Enter
```

### 5. 等待生成并截图

```bash
# 等待 60 秒（复杂图片可能需要更久）
sleep 60

# 截图查看结果
agent-browser screenshot chatgpt-result.png

# 检查是否有生成的图片
agent-browser snapshot -i
# 看到 "已生成图片" 按钮说明生成完成
```

### 6. 发送给用户

```bash
# 截图已包含生成的图片，直接发送
# 使用 send_image MCP 工具发送
```

## 图片下载（原图）

ChatGPT 生成的图片可通过 JS eval 获取 URL：

```bash
agent-browser eval "
  const imgs = document.querySelectorAll('img[alt]');
  JSON.stringify(Array.from(imgs).filter(i => i.naturalWidth > 200).map(i => ({
    src: i.src.substring(0, 300),
    w: i.naturalWidth,
    h: i.naturalHeight
  })));
"
# 图片 URL 格式：https://chatgpt.com/backend-api/estuary/content?id=...
# 可在浏览器内 fetch 后通过 download 按钮保存到容器内
```

## CDP 端口转发恢复

容器重启后需要重新设置：

```bash
# 1. 修改 chromium 启动脚本加上 --remote-debugging-port
docker exec chromium bash -c 'cat > /usr/bin/wrapped-chromium << '\''SCRIPT'\''
#!/bin/bash
BIN=/usr/bin/chromium
if ! pgrep chromium > /dev/null;then
  rm -f $HOME/.config/chromium/Singleton*
fi
EXTRA_ARGS="--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0"
if grep -q "Seccomp:.0" /proc/1/status; then
  ${BIN} --ignore-gpu-blocklist --no-first-run --password-store=basic \
    --simulate-outdated-no-au="Tue, 31 Dec 2099 23:59:59 GMT" \
    --start-maximized --user-data-dir ${EXTRA_ARGS} "$@" > /dev/null 2>&1
else
  ${BIN} --ignore-gpu-blocklist --no-first-run --no-sandbox --password-store=basic \
    --simulate-outdated-no-au="Tue, 31 Dec 2099 23:59:59 GMT" \
    --start-maximized --test-type --user-data-dir ${EXTRA_ARGS} "$@" > /dev/null 2>&1
fi
SCRIPT
chmod +x /usr/bin/wrapped-chromium'

# 2. 重启 chromium 进程
docker exec chromium pkill -9 -f '/usr/lib/chromium/chromium'
sleep 5

# 3. 如果 CDP 只监听 127.0.0.1，安装 socat 做转发
docker exec chromium apt-get install -y -qq socat 2>/dev/null
docker exec -d chromium socat TCP-LISTEN:9223,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:9222
```

## 注意事项

- ChatGPT 界面经常更新，元素 ref 会变化，每次操作前都要 `snapshot -i`
- 图片生成有速率限制，Pro 用户约每天 100 张
- 如果登录过期，需要通过 VNC 手动重新登录
- prompt 建议用英文效果更好，中文也支持
- Sora 视频生成也在 ChatGPT 中可用（Pro 用户无限次）

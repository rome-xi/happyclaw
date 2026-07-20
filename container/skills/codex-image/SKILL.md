---
name: codex-image
description: Generate images through the user's ChatGPT Pro subscription and the Codex image_generation tool. Use when the user asks to "画图/生成图片/画个 xxx/generate an image/make a picture". Runs through the local codex-proxy, needs no API key in the agent, and produces a real image file to send with send_image.
allowed-tools: Bash(gen_image.py:*), Bash(python3:*)
---

# Codex 生图（ChatGPT Pro）

用 Dennis 的 ChatGPT Pro 订阅和 Codex `image_generation` 工具生成图片。走本地 codex-proxy，
凭据由 proxy 自动管理（OAuth 自动刷新），**无需任何 API key**，消耗订阅额度。

这是旧 `chatgpt-image` skill（CDP 操控网页版、脆弱、要 VNC 手动登录）的替代——纯 API，稳定。

## 使用场景

用户说「画个 xxx」「生成一张图」「generate an image」「做张图片」时用此 skill。

## 用法

一条命令搞定（脚本内置在 skill 目录）：

```bash
python3 ~/.claude/skills/codex-image/scripts/gen_image.py \
  --prompt "a red fox sitting in snow, photorealistic, soft morning light" \
  --out fox.png
```

参数：
- `--prompt`（必填）：图片描述。**英文效果最好**，中文也支持。
- `--out`：输出文件名。默认优先写入当前工作区；当前目录不可写时回退 `/tmp`，并返回绝对路径。
- `--size`：`1024x1024`（默认）/ `1536x1024`（横）/ `1024x1536`（竖）/ `auto`。
- `--format`：`png`（默认）/ `jpeg` / `webp`。
- `--background`：`transparent`（透明底，适合图标/贴纸）/ `opaque` / `auto`。

脚本 **stdout 最后一行是保存文件的绝对路径**，解析它即可。

## 完整流程

1. 用 `gen_image.py` 生成图片，拿到文件路径（生图约 30-90 秒，耐心等）
2. 用 **`send_image` MCP 工具**把文件发给用户
3. 如需微调，改 prompt 重新生成

示例（生成并发送）：

```bash
OUT=$(python3 ~/.claude/skills/codex-image/scripts/gen_image.py \
  --prompt "minimalist logo of a mountain, flat design, blue tones" \
  --format png --background transparent --out /tmp/logo.png | tail -1)
echo "生成完成: $OUT"
# 然后调用 send_image 工具发送 $OUT
```

## 注意

- 生图通常耗时 30-90 秒，复杂图更久；默认超时 180s，可用 `CODEX_IMAGE_TIMEOUT_SECONDS` 调整。
- 失败时脚本非零退出 + stderr 打印原因（未出图 / proxy 不可达 / 订阅限制）。
- 若报「无法连接 codex-proxy」，检查服务：`systemctl --user status codex-proxy`。
- `CODEX_PROXY_URL` 可传 base URL（如 `http://127.0.0.1:19080`）或完整 `/v1/images` 地址。
- 透明背景只对 png/webp 有效，jpeg 不支持透明。
- prompt 里避免要求生成真实人物、受版权保护角色等，可能被拒。

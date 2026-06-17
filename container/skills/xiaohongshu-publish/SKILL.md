# 小红书发布

在小红书创作者平台发布图文笔记。通过 agent-browser 操作浏览器完成登录和发布。

## 使用场景

当用户要求「发小红书」「发布到小红书」「小红书发文」时使用此 skill。

## 账号人设

> 以下为占位示例，部署时替换成你自己的账号人设口径。

- **账号名**：（你的小红书账号名）
- **人设口径**：（自我称呼、身份定位、内容方向）
- **风格**：（你的内容风格）
- **写作语气**：（口语化/正式、是否带 emoji 等）
- **示例**：（几条符合人设的示例文案）

## 前置条件

- `agent-browser` 已全局安装（`~/.npm-global/bin/agent-browser`）
- 登录态通过 `--profile ~/.agent-browser/profiles/xiaohongshu` 持久化，需预先登录你自己的账号

## 关键规则

1. **只有启动 daemon 的第一条命令**需要 `--profile` 参数，后续命令自动复用同一 daemon
2. 如果 daemon 已在运行，传 `--profile` 会被忽略并警告。此时先 `agent-browser close` 再重启
3. 每条 Bash 命令前加 `export PATH="$HOME/.npm-global/bin:$PATH:/usr/bin"`
4. 初始 URL 可能报 `/login`，这是 JS 未加载完的正常现象，等 3 秒后 `get url` 确认实际页面

## 发布流程

### 内容规格

| 项目 | 要求 |
|------|------|
| 图片 | 1-18 张，推荐 3:4 竖图 1080x1440，png/jpg/jpeg/webp，≤32MB/张 |
| 标题 | 必填，≤20 字效果最佳 |
| 正文 | 支持 emoji，200-500 字，#话题名 嵌入标签 |

### 步骤

```bash
# 0. 启动 daemon（仅此处需要 --profile）
agent-browser --profile ~/.agent-browser/profiles/xiaohongshu open "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image"
sleep 3

# 1. 确认已登录
agent-browser get url
# 如果仍在 /login → 需要重新登录（见下方登录流程）

# 2. 上传图片（多张图之间等 2 秒）
agent-browser upload 'input[type="file"]' /path/to/image1.png
sleep 2
agent-browser upload 'input[type="file"]' /path/to/image2.png
sleep 3

# 3. 获取编辑器元素
agent-browser snapshot -i
# 标题: ref=e12 (textbox "填写标题会有更多赞哦")
# 正文: ref=e3  (textbox)
# 发布: ref=e2  (button "发布")
# 暂存: ref=e1  (button "暂存离开")

# 4. 填写标题
agent-browser fill '@e12' '你的标题'

# 5. 填写正文（富文本编辑器，用 click + keyboard type）
agent-browser click '@e3'
agent-browser keyboard type '正文内容 #AI #科技'

# 6. 截图预览 → 发给用户确认
agent-browser screenshot preview.png

# 7. 用户确认后发布
agent-browser click '@e2'
sleep 2
agent-browser screenshot result.png
```

### 登录流程（session 过期时使用）

```bash
# 先关闭旧 daemon
agent-browser close

# 带 profile 启动
agent-browser --profile ~/.agent-browser/profiles/xiaohongshu open "https://creator.xiaohongshu.com"

# 填写手机号（替换成你自己的手机号）
agent-browser fill 'input[placeholder="手机号"]' 'YOUR_PHONE_NUMBER'

# 点击发送验证码
agent-browser click '.css-uyobdj'

# 询问用户验证码，填入后点击登录按钮
agent-browser fill 'input[placeholder="验证码"]' '用户提供的验证码'
agent-browser snapshot -i  # 找到登录按钮 ref
agent-browser click '@登录按钮ref'

# 等待跳转
sleep 3
agent-browser get url  # 确认已到首页
```

## 反AI检测规范

小红书2025年9月起强制AI内容标识，音画识别模型准确率约95%，月均拦截10万篇AI笔记。以下规则用于降低AI痕迹：

### 文案写作

1. **加入真实体验**：具体时间/地点/数据细节，如「上周在xxx逛的时候」「用了大概三天」
2. **小红书口语风格**：短句 + 换行 + emoji，避免长段论述体和书面语
3. **不要用AI典型句式**：避免「首先/其次/最后」「综上所述」「值得一提的是」「需要注意的是」等
4. **加入个人观点和情绪**：用第一人称，带口语化表达，如「真的绝了」「我直接震惊」
5. **工作流**：AI生成初稿 → 大幅改写口语化 → 加入个人细节和情绪词

### 图片处理

1. **不要纯AI图直出**：加手工标注、文字水印、截图混排
2. **图片加入真实元素**：实拍照片、手写笔记、屏幕截图等增加真实感
3. **图片元数据**：避免图片EXIF信息暴露AI生成工具

### 发布节奏

1. **新号先养号**：注册后先浏览、点赞、收藏、评论互动 3-5 天再发文
2. **发布频率**：每天不超过 2 篇，间隔至少 2 小时
3. **最佳发布时间**：工作日 12:00-13:00, 18:00-21:00；周末 10:00-12:00, 15:00-21:00
4. **不要批量发布**：避免短时间内发布大量同质化内容

### 互动维护

1. **回复评论**：发布后 1 小时内回复前几条评论，增加真人互动信号
2. **日常互动**：定期浏览、点赞他人内容，保持账号活跃度
3. **不要只发不互动**：纯发文无互动是AI账号的典型特征

## 注意事项

- 发布前**必须**截图给用户确认，除非用户明确说不需要确认
- element ref 编号可能因页面变化而不同，每次发布前先 `snapshot -i` 确认
- 小红书对纯色/低质量图片可能有限制，确保图片有实际内容
- 操作完成后 `agent-browser close` 释放资源
- 正文填写使用 JS `document.execCommand('insertText', false, text)` 而非 `keyboard type`，后者无法输入中文

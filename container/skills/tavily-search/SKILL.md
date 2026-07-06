---
name: tavily-search
description: Web search via Tavily API. Use this when WebSearch is unavailable or returning errors (e.g. when running through super-relay/Bedrock which does not pass server-side web_search tool). Returns title/url/snippet. Reads TAVILY_API_KEY from env or ~/.openclaw/.env.
allowed-tools: Bash(tavily_search.py:*)
---

# Tavily Search

WebSearch 工具在当前 super-relay/Bedrock 链路下不可用（API 400 unknown error），此 skill 作为替代搜索方案。

## 使用

```bash
# 默认 JSON 输出
python3 ~/.claude/skills/tavily-search/scripts/tavily_search.py --query "关键词" --max-results 5

# 包含 Tavily 自动总结（answer 字段）
python3 ~/.claude/skills/tavily-search/scripts/tavily_search.py --query "关键词" --max-results 5 --include-answer

# brave 风格简洁输出（title/url/snippet）
python3 ~/.claude/skills/tavily-search/scripts/tavily_search.py --query "关键词" --max-results 5 --format brave

# Markdown 列表（人类可读）
python3 ~/.claude/skills/tavily-search/scripts/tavily_search.py --query "关键词" --max-results 5 --format md
```

如果跑在 host 模式工作区（如 admin main），脚本路径用：
```bash
python3 /workspace/project-skills/tavily-search/scripts/tavily_search.py --query "..."
```

Container 模式同理用 `/workspace/project-skills/tavily-search/...`。

## API Key

脚本自动从两处读取（不需要手动设置）：
1. 环境变量 `TAVILY_API_KEY`
2. `~/.openclaw/.env` 文件里的 `TAVILY_API_KEY=...` 一行（已存在，host 模式可读）

## 注意

- 免费额度：1000 次/月（Dennis 个人 dev key），月度刷新
- 关键词用中文/英文都行，中文搜国内信息效果好
- `--max-results` 建议 3-5（节省 token）
- 抓到 URL 后用 WebFetch 取完整内容

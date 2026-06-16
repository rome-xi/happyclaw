---
name: okx-invest
description: OKX 加密货币现货投资管理。自动生成日报、查询账户状态、分析市场情绪。用于定时推送投资日报或用户主动询问 OKX 账户、持仓、挂单、收益等投资相关问题。
allowed-tools: Bash(okx_report.sh:*), Bash(okx_watch.py:*), Bash(okx_public_probe.py:*), Bash(okx_private_probe.py:*), Bash(tavily_search.py:*)
---

# OKX 现货投资

管理 OKX 现货账户，生成日报，分析市场。

## 日报生成

```bash
cd /path/to/skills/okx-invest/scripts && bash okx_report.sh
```

输出格式化的中文日报，包括：总资产、收益、BTC/ETH 持仓、挂单状态、市场情绪、新闻、操作建议。

## 账户查询

```bash
cd /path/to/skills/okx-invest/scripts && source okx_env.sh && python3 okx_watch.py
```

返回 JSON：funding 余额、trading 余额（USDT/BTC/ETH）、持仓、挂单。

## 市场数据

```bash
cd /path/to/skills/okx-invest/scripts && python3 okx_public_probe.py
```

返回 BTC-USDT、ETH-USDT 实时 ticker。

## 新闻搜索

```bash
cd /path/to/skills/okx-invest/scripts && python3 tavily_search.py --query "BTC ETH crypto news" --max-results 5 --format brave
```

通过 Tavily API 搜索加密市场新闻。

## 投资策略

详见 [references/strategy.md](references/strategy.md)。核心原则：
- 只做现货，BTC + ETH 双币种
- 分层低吸挂单策略
- BTC 权重不低于 ETH
- 现金占比过低时暂停新挂单
- 趋势未明时保持当前仓位

## 凭据

OKX API 凭据存储在 `scripts/okx_env.sh`（环境变量方式加载）。
Tavily API Key 从 `~/.openclaw/.env` 或 `~/.config/tavily/.env` 加载。

## 定时任务

每日 08:00 和 20:00 自动执行 `okx_report.sh` 并推送日报。

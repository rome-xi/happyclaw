# OKX 投资策略

## 推送时间

- 每天 **08:00 / 20:00**

## 搜索规则

- 新闻与市场情绪默认使用 **Tavily**
- HappyClaw 内置 WebSearch 可作为备选

## 日报固定模板

【OKX现货日报｜prod｜<时间>】
🏁 起始资金：<bills> USDT
📊 总资产现值：<total> USDT
📈 总收益：<pnl> USDT｜<roi>%

💵 现金：USDT <cash>｜可用 <avail>｜挂单冻结 <frozen>

🟠 BTC：<qty>｜现价 <px>｜现值 <val> USDT｜成本 <cost_px>｜收益 <pnl> USDT｜<roi>%
🟣 ETH：<qty>｜现价 <px>｜现值 <val> USDT｜成本 <cost_px>｜收益 <pnl> USDT｜<roi>%

🧾 挂单（买｜live）：
• BTC <qty> @ <px>｜约 <usdt> USDT
• ETH <qty> @ <px>｜约 <usdt> USDT

🧭 市场情绪：<疲惫｜平稳｜上升｜剧烈波动>｜<一句话原因>
🗞️ 重要新闻：
• <1条>
• <2条>

✅ 建议：<一句可执行建议>

## 计算口径

- 起始资金：从 OKX 账单充值记录统计
- 总资产现值：使用 `asset-valuation` 的 `totalBal`
- 总收益 = 总资产现值 - 起始资金
- 总收益率 = 总收益 / 起始资金
- 币种收益 = 币现值 - 币成本
- 币成本 = 数量 × `accAvgPx`

## 输出规则

- 必须用中文
- 缺数据就写：`数据缺失：xxx`
- 新闻最多 2-3 条，每条一句，不贴原文不堆链接
- 除非老大另说，不额外输出资金总览拆分、说明性括注、冗余小节名

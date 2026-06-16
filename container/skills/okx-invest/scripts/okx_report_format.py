#!/usr/bin/env python3
import json
import sys

REQUIRED = [
    'title', 'bills', 'total', 'pnl', 'roi', 'cash', 'avail', 'frozen',
    'btc', 'eth', 'orders', 'mood', 'news', 'advice',
    'withdrawn'
]


def fmt_num(v, digits=2, signed=False):
    n = float(v)
    if signed:
        return f"{n:+.{digits}f}"
    return f"{n:.{digits}f}"


def render(report):
    for k in REQUIRED:
        if k not in report:
            raise SystemExit(f"FORMAT_DATA_MISSING {k}")

    btc = report['btc']
    eth = report['eth']
    lines = []
    lines.append(report['title'])
    lines.append(f"🏁 起始资金：{report['bills']} USDT")
    lines.append(f"📊 总资产现值：{report['total']} USDT")
    lines.append(f"📈 总收益：{report['pnl']} USDT｜{report['roi']}%")
    lines.append("")
    lines.append(f"💵 现金：USDT {report['cash']}｜可用 {report['avail']}｜挂单冻结 {report['frozen']}")
    lines.append(f"🏦 已转出到 Web3：USDT {report['withdrawn']}")
    lines.append("")
    lines.append(f"🟠 BTC：{btc['qty']}｜现价 {btc['px']}｜现值 {btc['val']} USDT｜成本 {btc['cost_px']}｜收益 {btc['pnl']} USDT｜{btc['roi']}%")
    lines.append(f"🟣 ETH：{eth['qty']}｜现价 {eth['px']}｜现值 {eth['val']} USDT｜成本 {eth['cost_px']}｜收益 {eth['pnl']} USDT｜{eth['roi']}%")
    lines.append("")
    lines.append("🧾 挂单（买｜live）：")
    orders = report['orders'] or []
    if not orders:
        lines.append("• 数据缺失：无 live 挂单")
    else:
        for o in orders:
            base = f"• {o['sym']} {o['qty']} @ {o['px']}｜约 {o['usdt']} USDT"
            age = o.get('age_h') or o.get('ageHours')
            gap = o.get('gap_pct') if 'gap_pct' in o else o.get('gapPct')
            flags = []
            if age not in (None, ''):
                flags.append(f"已挂 {age}h")
            if gap not in (None, ''):
                try:
                    gapf = float(gap)
                    flags.append(f"距现价 {gapf:+.2f}%")
                except Exception:
                    flags.append(f"距现价 {gap}")
            if flags:
                base += "｜" + "｜".join(flags)
            lines.append(base)
    lines.append("")
    lines.append(f"🧭 市场情绪：{report['mood']['label']}｜{report['mood']['reason']}")
    lines.append("🗞️ 重要新闻：")
    news = report['news'] or []
    if not news:
        lines.append("• 数据缺失：无有效新闻")
    else:
        for item in news[:2]:
            lines.append(f"• {item}")
    lines.append("")
    lines.append(f"✅ 建议：{report['advice']}")
    return "\n".join(lines)


def validate(text):
    must = [
        '【OKX现货日报｜prod｜', '🏁 起始资金：', '📊 总资产现值：', '📈 总收益：',
        '💵 现金：', '🏦 已转出到 Web3：', '🟠 BTC：', '🟣 ETH：', '🧾 挂单（买｜live）：',
        '🧭 市场情绪：', '🗞️ 重要新闻：', '✅ 建议：'
    ]
    for s in must:
        if s not in text:
            raise SystemExit(f'FORMAT_CHECK_FAILED missing {s}')
    bad = [
        '【cron ', '执行结果', '原命令路径', '已改用现有脚本',
        '市场/新闻：', '资金总览', '现金\n-', '持仓\n-'
    ]
    for s in bad:
        if s in text:
            raise SystemExit(f'FORMAT_CHECK_FAILED bad_pattern {s}')
    return True


def main():
    raw = sys.stdin.read()
    obj = json.loads(raw)
    text = render(obj)
    validate(text)
    print(text)


if __name__ == '__main__':
    main()

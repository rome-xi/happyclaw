#!/usr/bin/env bash
set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$WORKDIR"

source ./okx_env.sh

python3 - <<'PY' | python3 "$WORKDIR/okx_report_format.py"
import json, re, subprocess, datetime, pathlib, os

SCRIPT_DIR = pathlib.Path(os.environ.get('WORKDIR', '.'))

def tavily_search(query, max_results=5):
    tavily_script = SCRIPT_DIR / 'tavily_search.py'
    raw = subprocess.check_output(
        ['python3', str(tavily_script), '--query', query, '--max-results', str(max_results), '--format', 'brave'],
        text=True,
        errors='ignore'
    )
    return json.loads(raw)

from okx_private_probe import call

st, body = call('GET', '/api/v5/asset/asset-valuation', {'ccy': 'USDT'})
if st != 200:
    raise SystemExit(f"asset-valuation http {st}: {body[:200]}")
val = json.loads(body)
if val.get('code') != '0' or not val.get('data'):
    raise SystemExit(f"asset-valuation bad: {body[:200]}")
val0 = val['data'][0]
totalBal = float(val0['totalBal'])

# Withdrawn to Web3/external wallet (treat as strategy internal transfer, not loss)
withdraw_sum = 0.0
try:
    st, body = call('GET', '/api/v5/asset/bills', {'ccy': 'USDT', 'limit': '100'})
    if st == 200:
        obj = json.loads(body)
        for r in (obj.get('data') or []):
            if str(r.get('type')) == '2' and str(r.get('notes','')).lower().strip() == 'withdrawal':
                try:
                    chg = float(r.get('balChg'))
                except Exception:
                    continue
                if chg < 0:
                    withdraw_sum += (-chg)
except Exception:
    pass

st, body = call('GET', '/api/v5/asset/bills', {'ccy': 'USDT', 'limit': '100'})
if st != 200:
    raise SystemExit(f"asset-bills http {st}: {body[:200]}")
bills = json.loads(body)
if bills.get('code') != '0':
    raise SystemExit(f"asset-bills bad: {body[:200]}")
rows = bills.get('data') or []
dep_sum = 0.0
for r in rows:
    if str(r.get('type')) == '117':
        try:
            chg = float(r.get('balChg'))
        except Exception:
            continue
        if chg > 0:
            dep_sum += chg

# Strategy NAV includes withdrawn-to-web3 amount (so it's not mistaken as loss)
strategy_nav = totalBal + withdraw_sum
pnl = strategy_nav - dep_sum
roi = (pnl / dep_sum * 100.0) if dep_sum > 0 else 0.0

raw = subprocess.check_output(['bash','-lc','python3 okx_watch.py'], text=True)
j = json.loads(raw)
fund_bal = float(j['funding_balances_usdt']['data'][0]['bal'])
trade = j['trading_balance_usdt']['data'][0]['details'][0]
trade_cash = float(trade['cashBal'])
trade_avail = float(trade['availBal'])
trade_frozen = float(trade['frozenBal'])

btc = j['trading_balance_btc']['data'][0]['details'][0]
eth = j['trading_balance_eth']['data'][0]['details'][0]
btc_qty = float(btc['spotBal'] or 0)
eth_qty = float(eth['spotBal'] or 0)
btc_cost = float(btc['accAvgPx'] or 0)
eth_cost = float(eth['accAvgPx'] or 0)

raw2 = subprocess.check_output(['bash','-lc','python3 okx_public_probe.py'], text=True, errors='ignore')
obj2 = json.loads(raw2)
pick = obj2.get('tickers_pick') or []
px_map = {x.get('instId'): float(x.get('last')) for x in pick if x.get('last')}
px_btc = px_map.get('BTC-USDT')
px_eth = px_map.get('ETH-USDT')
if px_btc is None and btc_qty > 0:
    px_btc = float(btc['eqUsd'] or 0) / btc_qty
if px_eth is None and eth_qty > 0:
    px_eth = float(eth['eqUsd'] or 0) / eth_qty
px_btc = px_btc or 0
px_eth = px_eth or 0

btc_val = btc_qty * px_btc
eth_val = eth_qty * px_eth
btc_pnl = btc_val - btc_qty * btc_cost
eth_pnl = eth_val - eth_qty * eth_cost
btc_roi = (btc_pnl/(btc_qty*btc_cost))*100 if btc_qty*btc_cost else 0
eth_roi = (eth_pnl/(eth_qty*eth_cost))*100 if eth_qty*eth_cost else 0

orders = []
now_ms = int(datetime.datetime.now().timestamp() * 1000)
for o in j['orders_pending']['data']:
    if o.get('state') != 'live':
        continue
    inst = o.get('instId','')
    sym = 'BTC' if inst.startswith('BTC') else 'ETH'
    qty = float(o['sz'])
    px = float(o['px'])
    usdt = qty * px
    last_px = px_btc if sym == 'BTC' else px_eth
    gap_pct = ((last_px - px) / px * 100.0) if px else 0.0
    age_h = max(0.0, (now_ms - int(o.get('cTime') or now_ms)) / 3600000)
    orders.append({
        'sym': sym,
        'qty': f"{qty}",
        'px': f"{px}",
        'usdt': f"{usdt:.2f}",
        'age_h': f"{age_h:.1f}",
        'gap_pct': f"{gap_pct:+.2f}"
    })

news = []
market_answer = ''
macro_answer = ''
flow_answer = ''
geo_answer = ''
try:
    news_obj = tavily_search('BTC ETH crypto market news today macro geopolitics ETF flows', 5)
    market_obj = tavily_search('Bitcoin Ethereum crypto market trend past week Fed dollar yields ETF flows geopolitics latest news', 6)
    macro_obj = tavily_search('CPI jobs Fed rate cut expectations dollar index treasury yields crypto market week', 5)
    flow_obj = tavily_search('Bitcoin ETF flows latest week inflows outflows spot bitcoin etf Ethereum ETF flows', 5)
    geo_obj = tavily_search('Middle East war geopolitics impact bitcoin oil risk assets crypto', 5)
    market_answer = (market_obj.get('answer') or '').strip()
    macro_answer = (macro_obj.get('answer') or '').strip()
    flow_answer = (flow_obj.get('answer') or '').strip()
    geo_answer = (geo_obj.get('answer') or '').strip()
    for item in (news_obj.get('results') or [])[:2]:
        title = (item.get('title') or '').strip()
        snippet = (item.get('snippet') or '').strip()
        if title and snippet:
            news.append(f"{title}：{snippet}"[:120])
        elif title or snippet:
            news.append((title or snippet)[:120])
except Exception:
    pass
if not news:
    news = ['数据缺失：Tavily 未返回有效新闻']

cash_total = fund_bal + trade_cash
portfolio_total = max(totalBal, 1e-9)
cash_ratio = cash_total / portfolio_total
frozen_ratio = trade_frozen / portfolio_total
btc_weight = btc_val / portfolio_total
eth_weight = eth_val / portfolio_total
change_ratio = 0.0
if btc_cost:
    change_ratio = max(change_ratio, abs((px_btc - btc_cost) / btc_cost))
if eth_cost:
    change_ratio = max(change_ratio, abs((px_eth - eth_cost) / eth_cost))

trend_bias = '震荡'
trend_reason = '市场缺乏持续单边信号'
blob = ' '.join([market_answer, macro_answer, flow_answer, geo_answer]).lower()
if any(k in blob for k in ['outflow', 'outflows', 'risk-off', 'oil', 'geopolitical', 'war risk', 'conflict']):
    trend_bias = '震荡偏弱'
    trend_reason = 'ETF 资金与地缘风险反复，追高胜率一般'
elif any(k in blob for k in ['inflow', 'inflows', 'rate cut', 'dovish', 'recovery']):
    trend_bias = '谨慎偏多'
    trend_reason = '流动性预期改善，但持续性仍待确认'

mood = {'label': '平稳', 'reason': trend_reason}
if 'oil' in blob or 'geopolitical' in blob or 'conflict' in blob:
    mood = {'label': '剧烈波动', 'reason': '地缘政治与油价扰动仍在，短线波动风险偏高'}
elif trend_bias == '震荡偏弱':
    mood = {'label': '疲惫', 'reason': '资金流与风险偏好反复，市场更像震荡偏弱'}
elif trend_bias == '谨慎偏多':
    mood = {'label': '上升', 'reason': '宏观预期边际改善，风险资产情绪有所修复'}

advice_parts = []
if cash_ratio >= 0.45:
    advice_parts.append('当前现金占比偏高，可继续保留分层低吸，不必追高')
elif cash_ratio <= 0.15:
    advice_parts.append('当前现金占比偏低，暂停新增挂单，优先保留机动资金')
else:
    advice_parts.append('当前现金占比中性，挂单与持仓结构基本均衡')

if btc_weight < eth_weight:
    advice_parts.append('当前应维持 BTC 权重不低于 ETH，避免组合波动过大')
elif btc_weight < 0.20 and cash_ratio > 0.25:
    advice_parts.append('BTC 主仓仍偏轻，如回踩成交可优先补 BTC')

if frozen_ratio > 0.65:
    advice_parts.append('挂单冻结占比过高，若市场转弱需考虑撤掉最浅层买单保留现金')
elif frozen_ratio < 0.20 and cash_ratio > 0.30:
    advice_parts.append('挂单占比偏低，可在关键支撑位补一层低吸单')

if trend_bias == '震荡偏弱':
    advice_parts.append('大盘更像震荡偏弱，现有挂单可以保留，但不建议上移价格或追加追涨仓')
elif trend_bias == '谨慎偏多':
    advice_parts.append('若后续 ETF 连续净流入且地缘风险缓和，可考虑把过深挂单上移一档')
else:
    advice_parts.append('趋势未明，保持当前分层挂单，等市场给方向再调仓')

now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
report = {
    'title': f'【OKX现货日报｜prod｜{now} GMT+8】',
    'bills': f'{dep_sum:.2f}',
    'total': f'{strategy_nav:.2f}',
    'pnl': f'{pnl:+.2f}',
    'roi': f'{roi:+.2f}',
    'cash': f'{fund_bal + trade_cash:.2f}',
    'avail': f'{trade_avail:.4f}',
    'frozen': f'{trade_frozen:.2f}',
    'withdrawn': f'{withdraw_sum:.2f}',
    'btc': {
        'qty': f'{btc_qty:.8f}', 'px': f'{px_btc:.1f}', 'val': f'{btc_val:.2f}',
        'cost_px': f'{btc_cost:.2f}', 'pnl': f'{btc_pnl:+.2f}', 'roi': f'{btc_roi:+.2f}'
    },
    'eth': {
        'qty': f'{eth_qty:.8f}', 'px': f'{px_eth:.2f}', 'val': f'{eth_val:.2f}',
        'cost_px': f'{eth_cost:.2f}', 'pnl': f'{eth_pnl:+.2f}', 'roi': f'{eth_roi:+.2f}'
    },
    'orders': orders,
    'mood': mood,
    'news': news,
    'advice': '；'.join(advice_parts)
}
print(json.dumps(report, ensure_ascii=False))
PY

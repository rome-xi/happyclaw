#!/usr/bin/env python3
"""OKX 价格监控告警 — 无需 API Key，仅用公开行情接口。
每次运行：
  1. 拉取 BTC/ETH/持仓币的最新价格
  2. 与上次记录的价格对比
  3. 超过阈值则输出告警文本（由调度器发送给用户）
  4. 更新状态文件
"""
import json, os, sys, time, urllib.parse, urllib.request

BASE = "https://www.okx.com"
STATE_FILE = os.path.join(os.path.dirname(__file__), ".price_alert_state.json")

# 监控的交易对 → 告警阈值（百分比）
WATCHLIST = {
    "BTC-USDT": 3.0,
    "ETH-USDT": 5.0,
}

# 恐贪指数告警阈值
FEAR_GREED_EXTREME_FEAR = 20
FEAR_GREED_EXTREME_GREED = 80


def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "happyclaw-price-alert/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_tickers(inst_ids):
    """批量获取 SPOT ticker"""
    data = http_get(f"{BASE}/api/v5/market/tickers?instType=SPOT")
    tickers = data.get("data", [])
    return {t["instId"]: t for t in tickers if t["instId"] in inst_ids}


def get_fear_greed():
    """获取 BTC 恐惧贪婪指数（alternative.me 免费 API）"""
    try:
        data = http_get("https://api.alternative.me/fng/?limit=1")
        entry = data.get("data", [{}])[0]
        return int(entry.get("value", 50)), entry.get("value_classification", "")
    except Exception:
        return None, None


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def main():
    state = load_state()
    prev_prices = state.get("prices", {})
    prev_fg = state.get("fear_greed_alerted", False)

    alerts = []

    # 价格告警
    tickers = get_tickers(set(WATCHLIST.keys()))
    new_prices = {}

    for inst_id, threshold in WATCHLIST.items():
        ticker = tickers.get(inst_id)
        if not ticker:
            continue
        price = float(ticker["last"])
        new_prices[inst_id] = price

        prev = prev_prices.get(inst_id)
        if prev is None:
            continue

        change_pct = (price - prev) / prev * 100
        if abs(change_pct) >= threshold:
            direction = "涨" if change_pct > 0 else "跌"
            coin = inst_id.split("-")[0]
            alerts.append(
                f"**{coin}** {direction} {abs(change_pct):.1f}%｜"
                f"${prev:.2f} → ${price:.2f}"
            )

    # 恐贪指数
    fg_value, fg_label = get_fear_greed()
    fg_alert = False
    if fg_value is not None:
        if fg_value <= FEAR_GREED_EXTREME_FEAR and not prev_fg:
            alerts.append(f"恐贪指数 **{fg_value}**（{fg_label}）— 极度恐惧区间")
            fg_alert = True
        elif fg_value >= FEAR_GREED_EXTREME_GREED and not prev_fg:
            alerts.append(f"恐贪指数 **{fg_value}**（{fg_label}）— 极度贪婪区间")
            fg_alert = True

    # 保存状态
    save_state({
        "prices": new_prices,
        "fear_greed_alerted": fg_alert or (prev_fg and fg_value is not None and (fg_value <= FEAR_GREED_EXTREME_FEAR or fg_value >= FEAR_GREED_EXTREME_GREED)),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })

    # 有告警才输出
    if alerts:
        print("# 盯盘告警\n")
        for a in alerts:
            print(f"- {a}")
    # 没有告警就静默（script 任务无输出 = 不发消息）


if __name__ == "__main__":
    main()

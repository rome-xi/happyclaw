#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, time, urllib.parse, urllib.request

BASE = os.environ.get('OKX_BASE', 'https://www.okx.com')
KEY = os.environ.get('OKX_API_KEY')
SECRET = os.environ.get('OKX_API_SECRET')
PASS = os.environ.get('OKX_API_PASSPHRASE')

if not (KEY and SECRET and PASS):
    raise SystemExit('Missing OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE env vars')


def sign(ts, method, path, body=''):
    prehash = f"{ts}{method}{path}{body}"
    mac = hmac.new(SECRET.encode(), prehash.encode(), hashlib.sha256).digest()
    return base64.b64encode(mac).decode()


def req(method, path, params=None):
    if params:
        q = urllib.parse.urlencode(params)
        pathq = f"{path}?{q}"
    else:
        pathq = path
    url = BASE + pathq
    body = ''
    # OKX expects ISO8601 UTC timestamp; docs examples include milliseconds.
    ts = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + f".{int((time.time()%1)*1000):03d}Z"
    sig = sign(ts, method, pathq, body)

    r = urllib.request.Request(url, method=method)
    r.add_header('OK-ACCESS-KEY', KEY)
    r.add_header('OK-ACCESS-SIGN', sig)
    r.add_header('OK-ACCESS-TIMESTAMP', ts)
    r.add_header('OK-ACCESS-PASSPHRASE', PASS)
    r.add_header('Content-Type', 'application/json')
    r.add_header('Accept', 'application/json')
    r.add_header('User-Agent', 'openclaw-okx-watch/1.0')

    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main():
    out = {}

    # Budget source: funding (asset) account is often where USDT sits.
    try:
        out['funding_balances_usdt'] = req('GET', '/api/v5/asset/balances', {'ccy': 'USDT'})
    except Exception as e:
        out['funding_balances_usdt_error'] = str(e)

    # Trading account balances (fetch per-ccy; OKX may 403 on comma-separated ccy list)
    for ccy in ('USDT','BTC','ETH'):
        try:
            out[f'trading_balance_{ccy.lower()}'] = req('GET', '/api/v5/account/balance', {'ccy': ccy})
        except Exception as e:
            out[f'trading_balance_{ccy.lower()}_error'] = str(e)

    # Optional: these may be forbidden on read-only keys depending on permissions.
    try:
        out['positions'] = req('GET', '/api/v5/account/positions')
    except Exception as e:
        out['positions_error'] = str(e)

    try:
        out['orders_pending'] = req('GET', '/api/v5/trade/orders-pending')
    except Exception as e:
        out['orders_pending_error'] = str(e)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()

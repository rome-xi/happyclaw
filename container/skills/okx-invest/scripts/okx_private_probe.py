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


def call(method, path, params=None):
    if params:
        q = urllib.parse.urlencode(params)
        pathq = f"{path}?{q}"
    else:
        pathq = path
    url = BASE + pathq
    body = ''
    ts = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + f".{int((time.time()%1)*1000):03d}Z"
    sig = sign(ts, method, pathq, body)

    r = urllib.request.Request(url, method=method)
    r.add_header('OK-ACCESS-KEY', KEY)
    r.add_header('OK-ACCESS-SIGN', sig)
    r.add_header('OK-ACCESS-TIMESTAMP', ts)
    r.add_header('OK-ACCESS-PASSPHRASE', PASS)
    r.add_header('Content-Type', 'application/json')
    r.add_header('Accept', 'application/json')
    r.add_header('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) OpenClaw/okx-probe')

    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        data = e.read().decode(errors='replace')
        return e.code, data


def main():
    targets = [
        ('/api/v5/asset/balances', {'ccy': 'USDT'}),
        ('/api/v5/account/balance', {'ccy': 'USDT'}),
    ]
    out = {'base': BASE, 'results': []}
    for path, params in targets:
        status, body = call('GET', path, params)
        out['results'].append({'path': path, 'status': status, 'body': body[:5000]})
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

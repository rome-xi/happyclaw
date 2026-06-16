#!/usr/bin/env python3
import json, urllib.parse, urllib.request

BASE='https://www.okx.com'

def get(path, params=None):
    if params:
        q=urllib.parse.urlencode(params)
        url=f"{BASE}{path}?{q}"
    else:
        url=f"{BASE}{path}"
    req=urllib.request.Request(url, headers={'User-Agent':'openclaw-okx-probe/0.1'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def main():
    out={}
    # Server time
    out['time']=get('/api/v5/public/time')
    # BTC/USDT and ETH/USDT tickers
    out['tickers']=get('/api/v5/market/tickers', {'instType':'SPOT'})
    # filter just two
    data=out['tickers'].get('data',[])
    pick=[x for x in data if x.get('instId') in ('BTC-USDT','ETH-USDT')]
    out['tickers_pick']=pick
    print(json.dumps(out, ensure_ascii=False))

if __name__=='__main__':
    main()

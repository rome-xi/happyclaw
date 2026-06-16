#!/usr/bin/env bash
set -euo pipefail

CDP_HOST="${CDP_HOST:-localhost}"
CDP_PORT="${CDP_PORT:-9222}"
CDP_BASE="http://${CDP_HOST}:${CDP_PORT}"

usage() {
    cat <<'USAGE'
Usage: cdp.sh <command> [args...]

Commands:
  tabs                          List all open tabs
  eval <tab_index> '<js>'       Execute JavaScript in a tab
  navigate <tab_index> <url>    Navigate tab to URL
  screenshot <tab_index> <file> Take screenshot (PNG)
  content <tab_index>           Get page text content
  cookies <tab_index>           Get cookies for current page
  html <tab_index>              Get full page HTML

Examples:
  cdp.sh tabs
  cdp.sh eval 0 'document.title'
  cdp.sh content 0
  cdp.sh screenshot 0 page.png
USAGE
    exit 1
}

check_connection() {
    if ! curl -s --connect-timeout 3 "${CDP_BASE}/json/version" >/dev/null 2>&1; then
        echo "Error: Cannot connect to Chrome DevTools at ${CDP_BASE}" >&2
        echo "Make sure Chrome is running with: --remote-debugging-port=${CDP_PORT}" >&2
        exit 1
    fi
}

get_ws_url() {
    local idx="${1:-0}"
    local tabs
    tabs=$(curl -s "${CDP_BASE}/json")
    local ws_url
    ws_url=$(echo "$tabs" | python3 -c "
import json, sys
tabs = json.load(sys.stdin)
pages = [t for t in tabs if t.get('type') == 'page']
idx = int(sys.argv[1])
if idx >= len(pages):
    print(f'Error: tab index {idx} out of range (have {len(pages)} tabs)', file=sys.stderr)
    sys.exit(1)
print(pages[idx]['webSocketDebuggerUrl'])
" "$idx")
    echo "$ws_url"
}

cdp_send() {
    local ws_url="$1"
    local method="$2"
    local params="${3:-{}}"
    python3 -c "
import json, sys, websocket
ws = websocket.create_connection(sys.argv[1], timeout=30)
msg = {'id': 1, 'method': sys.argv[2], 'params': json.loads(sys.argv[3])}
ws.send(json.dumps(msg))
result = json.loads(ws.recv())
ws.close()
if 'error' in result:
    print(json.dumps(result['error'], ensure_ascii=False), file=sys.stderr)
    sys.exit(1)
print(json.dumps(result.get('result', {}), ensure_ascii=False, indent=2))
" "$ws_url" "$method" "$params"
}

cmd="${1:-}"
[ -z "$cmd" ] && usage

check_connection

case "$cmd" in
    tabs)
        curl -s "${CDP_BASE}/json" | python3 -c "
import json, sys
tabs = json.load(sys.stdin)
for i, t in enumerate(tabs):
    if t.get('type') == 'page':
        print(f\"[{i}] {t.get('title','')}  {t.get('url','')}\")"
        ;;

    eval)
        [ -z "${2:-}" ] || [ -z "${3:-}" ] && { echo "Usage: cdp.sh eval <tab_index> '<js>'" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        js_expr="$3"
        params=$(python3 -c "import json,sys; print(json.dumps({'expression': sys.argv[1], 'returnByValue': True}))" "$js_expr")
        cdp_send "$ws" "Runtime.evaluate" "$params"
        ;;

    navigate)
        [ -z "${2:-}" ] || [ -z "${3:-}" ] && { echo "Usage: cdp.sh navigate <tab_index> <url>" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        cdp_send "$ws" "Page.navigate" "{\"url\": \"$3\"}"
        ;;

    screenshot)
        [ -z "${2:-}" ] || [ -z "${3:-}" ] && { echo "Usage: cdp.sh screenshot <tab_index> <file>" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        result=$(cdp_send "$ws" "Page.captureScreenshot" '{"format": "png"}')
        echo "$result" | python3 -c "
import json, sys, base64
data = json.load(sys.stdin)
img = base64.b64decode(data['data'])
with open(sys.argv[1], 'wb') as f:
    f.write(img)
print(f'Screenshot saved to {sys.argv[1]} ({len(img)} bytes)')
" "$3"
        ;;

    content)
        [ -z "${2:-}" ] && { echo "Usage: cdp.sh content <tab_index>" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        cdp_send "$ws" "Runtime.evaluate" '{"expression": "document.body.innerText", "returnByValue": true}' | python3 -c "
import json, sys
r = json.load(sys.stdin)
val = r.get('result', {}).get('value', '')
print(val)"
        ;;

    cookies)
        [ -z "${2:-}" ] && { echo "Usage: cdp.sh cookies <tab_index>" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        cdp_send "$ws" "Network.getCookies" '{}'
        ;;

    html)
        [ -z "${2:-}" ] && { echo "Usage: cdp.sh html <tab_index>" >&2; exit 1; }
        ws=$(get_ws_url "$2")
        cdp_send "$ws" "Runtime.evaluate" '{"expression": "document.documentElement.outerHTML", "returnByValue": true}' | python3 -c "
import json, sys
r = json.load(sys.stdin)
val = r.get('result', {}).get('value', '')
print(val)"
        ;;

    *)
        echo "Unknown command: $cmd" >&2
        usage
        ;;
esac

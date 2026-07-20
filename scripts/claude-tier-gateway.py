#!/usr/bin/env python3
"""Loopback router for HappyClaw's four-tier provider.

`claude-*` model names preserve the caller's Anthropic OAuth Authorization and
go directly to Anthropic. Tier aliases and every other model go to local
new-api with its service token. The server binds to 127.0.0.1 only.
"""

import http.client
import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PORT = int(os.environ.get("PORT", "3011"))
ANTHROPIC_HOST = os.environ.get("ANTHROPIC_HOST", "api.anthropic.com")
NEWAPI_HOST = os.environ.get("NEWAPI_HOST", "127.0.0.1")
NEWAPI_PORT = int(os.environ.get("NEWAPI_PORT", "3010"))
DEFAULT_TOKEN_FILE = os.path.expanduser("~/.config/happyclaw/newapi.token")
LEGACY_TOKEN_FILE = os.path.expanduser("~/gateway/.newapi_token")
TOKEN_FILE = os.path.expanduser(
    os.environ.get("NEWAPI_TOKEN_FILE", DEFAULT_TOKEN_FILE)
)
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(32 * 1024 * 1024)))

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
}


def read_newapi_token() -> str:
    # Keep second-device installs on the documented path while remaining
    # compatible with the original lab layout. Never copy or log the token.
    for candidate in dict.fromkeys((TOKEN_FILE, LEGACY_TOKEN_FILE)):
        try:
            with open(candidate, encoding="utf-8") as handle:
                token = handle.read().strip()
            if token:
                return token
        except OSError:
            continue
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    @staticmethod
    def _is_claude_passthrough(body: bytes) -> bool:
        try:
            model = (json.loads(body or b"{}") or {}).get("model", "") or ""
        except (json.JSONDecodeError, AttributeError, TypeError):
            return False
        return str(model).lower().startswith("claude")

    def _relay(self) -> None:
        if self.path.rstrip("/") == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "newapiTokenConfigured": bool(read_newapi_token()),
                },
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "request body too large"})
            return
        body = self.rfile.read(length) if length else b""
        passthrough = self._is_claude_passthrough(body)

        forwarded = {}
        for key, value in self.headers.items():
            lower = key.lower()
            if (
                lower in HOP_BY_HOP_HEADERS
                or lower == "host"
                or lower.startswith("x-relay-")
            ):
                continue
            forwarded[key] = value

        connection = None
        try:
            if passthrough:
                connection = http.client.HTTPSConnection(
                    ANTHROPIC_HOST,
                    443,
                    timeout=600,
                    context=ssl.create_default_context(),
                )
                forwarded["Host"] = ANTHROPIC_HOST
            else:
                token = read_newapi_token()
                if not token:
                    self._send_json(
                        503,
                        {"error": f"new-api token missing: {TOKEN_FILE}"},
                    )
                    return
                connection = http.client.HTTPConnection(
                    NEWAPI_HOST,
                    NEWAPI_PORT,
                    timeout=600,
                )
                forwarded["Host"] = f"{NEWAPI_HOST}:{NEWAPI_PORT}"
                forwarded["Authorization"] = f"Bearer {token}"
            if body:
                forwarded["Content-Length"] = str(len(body))
            connection.request(self.command, self.path, body=body, headers=forwarded)
            response = connection.getresponse()
        except Exception as exc:  # noqa: BLE001 - gateway must return a bounded 502
            self._send_json(502, {"error": f"gateway upstream error: {exc}"})
            if connection:
                connection.close()
            return

        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in HOP_BY_HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            while True:
                try:
                    chunk = response.read(8192)
                except Exception:  # noqa: BLE001 - client sees the closed stream
                    break
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
        connection.close()

    do_GET = _relay
    do_HEAD = _relay
    do_POST = _relay
    do_PUT = _relay
    do_DELETE = _relay
    do_PATCH = _relay
    do_OPTIONS = _relay

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(
        f"claude-tier-gateway http://127.0.0.1:{PORT} "
        f"(claude -> {ANTHROPIC_HOST}; tiers -> {NEWAPI_HOST}:{NEWAPI_PORT})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

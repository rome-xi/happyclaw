#!/usr/bin/env python3
"""Loopback router for HappyClaw's four-tier provider.

Explicit OAuth passthrough requests for ``claude-*`` models go directly to
Anthropic. Tier/API-key requests go to local new-api with its service token.
The server binds to 127.0.0.1 only.
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
CLIENT_AUTH_HEADERS = {
    "authorization",
    "x-api-key",
    "api-key",
    "anthropic-api-key",
}
COUNT_TOKENS_PATHS = {
    "/v1/messages/count_tokens",
    "/api/anthropic/v1/messages/count_tokens",
}
MESSAGES_PATHS = {
    "/v1/messages",
    "/api/anthropic/v1/messages",
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


def estimate_input_tokens(payload: object) -> int:
    """Return a conservative local estimate for Anthropic's count API.

    new-api does not currently implement ``messages/count_tokens``. Returning
    an estimate locally prevents Claude Code from falling back to dozens of
    real completion calls merely to size tool definitions.
    """
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    ascii_chars = 0
    unicode_tokens = 0
    for char in serialized:
        if ord(char) < 128:
            ascii_chars += 1
        else:
            # CJK is commonly about one token per character; emoji and other
            # multibyte characters can take more, so round UTF-8 bytes / 2 up.
            unicode_tokens += max(1, (len(char.encode("utf-8")) + 1) // 2)
    return max(1, (ascii_chars + 3) // 4 + unicode_tokens)


def normalize_anthropic_request(body: bytes) -> bytes:
    """Move SDK-internal ``role=system`` messages to top-level ``system``.

    Recent Claude CLI builds append a synthetic system-role message even
    though the public Anthropic Messages schema only permits user/assistant in
    ``messages``. Anthropic-native relays commonly tolerate it, but an OpenAI
    Responses adapter correctly rejects the translated system input item.
    Normalising at the protocol boundary lets both upstream protocols compete
    behind the same tier aliases without changing the user's workspace engine.
    """
    try:
        payload = json.loads(body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body
    if not isinstance(payload, dict) or not isinstance(
        payload.get("messages"), list
    ):
        return body

    kept_messages = []
    extracted_blocks = []
    changed = False
    for message in payload["messages"]:
        if not isinstance(message, dict) or message.get("role") != "system":
            kept_messages.append(message)
            continue
        changed = True
        content = message.get("content")
        if isinstance(content, str) and content:
            extracted_blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                    and block["text"]
                ):
                    extracted_blocks.append(block)

    if not changed:
        return body

    payload["messages"] = kept_messages
    existing_system = payload.get("system")
    if isinstance(existing_system, list):
        payload["system"] = existing_system + extracted_blocks
    else:
        system_texts = []
        if isinstance(existing_system, str) and existing_system:
            system_texts.append(existing_system)
        system_texts.extend(block["text"] for block in extracted_blocks)
        if system_texts:
            payload["system"] = "\n\n".join(system_texts)
        elif "system" in payload:
            payload.pop("system")

    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def build_forward_headers(headers: object, passthrough: bool) -> dict[str, str]:
    """Copy safe request headers without leaking local sentinel credentials."""
    forwarded: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if (
            lower in HOP_BY_HOP_HEADERS
            or lower == "host"
            or lower.startswith("x-relay-")
            or (not passthrough and lower in CLIENT_AUTH_HEADERS)
        ):
            continue
        forwarded[key] = value
    return forwarded


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

    def _is_claude_passthrough(self, body: bytes) -> bool:
        try:
            model = (json.loads(body or b"{}") or {}).get("model", "") or ""
        except (json.JSONDecodeError, AttributeError, TypeError):
            return False
        marker = (self.headers.get("x-relay-passthrough", "") or "").lower()
        bearer = self.headers.get("Authorization", "") or ""
        api_key = (
            self.headers.get("x-api-key", "")
            or self.headers.get("api-key", "")
            or self.headers.get("anthropic-api-key", "")
        )
        return (
            str(model).lower().startswith("claude")
            and marker.strip() == "anthropic"
            and bearer.lower().startswith("bearer ")
            and not api_key
        )

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
        request_path = self.path.split("?", 1)[0].rstrip("/")
        if self.command == "POST" and request_path in COUNT_TOKENS_PATHS:
            try:
                payload = json.loads(body or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(
                    400,
                    {
                        "type": "error",
                        "error": {
                            "type": "invalid_request_error",
                            "message": "invalid JSON body",
                        },
                    },
                )
                return
            self._send_json(200, {"input_tokens": estimate_input_tokens(payload)})
            return

        if self.command == "POST" and request_path in MESSAGES_PATHS:
            body = normalize_anthropic_request(body)

        passthrough = self._is_claude_passthrough(body)
        forwarded = build_forward_headers(self.headers, passthrough)

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
        f"(OAuth claude -> {ANTHROPIC_HOST}; tiers -> {NEWAPI_HOST}:{NEWAPI_PORT})",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()

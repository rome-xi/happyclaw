#!/usr/bin/env python3
"""Loopback router for HappyClaw's four-tier provider.

Explicit OAuth passthrough requests for ``claude-*`` models go directly to
Anthropic. Tier/API-key requests go to local new-api with its service token.
The server binds to 127.0.0.1 only.
"""

import http.client
import json
import os
import sqlite3
import ssl
import threading
import time
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
NEWAPI_SQLITE = os.path.expanduser(
    os.environ.get(
        "NEWAPI_SQLITE_DB",
        "~/new-api-data/one-api.db",
    )
)
TIER_CIRCUIT_SECONDS = int(os.environ.get("TIER_CIRCUIT_SECONDS", "1800"))
MAX_UPSTREAM_ERROR_BYTES = int(
    os.environ.get("MAX_UPSTREAM_ERROR_BYTES", str(1024 * 1024))
)
DEFAULT_MODEL_ROUTING_CONFIG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "config",
    "model-routing.json",
)
MODEL_ROUTING_CONFIG = os.path.abspath(
    os.path.expanduser(
        os.environ.get(
            "HAPPYCLAW_MODEL_ROUTING_CONFIG",
            DEFAULT_MODEL_ROUTING_CONFIG,
        )
    )
)

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

# The probe remains the primary selector. These are only tried after the
# selected route fails a real request, so a short canary can never strand an
# entire long-running workspace. Every quality tier intentionally crosses the
# Anthropic/OpenAI protocol boundary before giving up.
DEFAULT_TIER_FALLBACKS = {
    "max": (
        "gpt-5.6-sol",
        "claude-opus-4-8",
        "model_hub/es1_orange_o48",
        "model_hub/es1_orange_o47",
    ),
    "high": (
        "gpt-5.6-sol",
        "claude-opus-4-8",
        "model_hub/es1_orange_o48",
        "auto_model/60b-sota",
        "ark/60b-0614c",
    ),
    "balance": (
        "auto_model/alwaysday1",
        "model_api/experimental_0630",
        "gpt-5.6-sol",
        "claude-opus-4-8",
    ),
    "fast": (
        "auto_model/alwaysday1",
        "model_api/experimental_0630",
        "gpt-5.6-sol",
        "claude-opus-4-8",
    ),
}
# Last known-good snapshot. `get_tier_fallbacks()` hot-reloads the shared JSON
# config by mtime; these defaults only keep older/minimal installations usable
# when the shipped config is temporarily unavailable.
TIER_FALLBACKS = DEFAULT_TIER_FALLBACKS
_tier_config_mtime_ns = -1
_tier_config_path = ""
RETRYABLE_TIER_STATUSES = {
    400,
    401,
    403,
    404,
    408,
    409,
    422,
    429,
    500,
    502,
    503,
    504,
}

_tier_circuit_lock = threading.Lock()
_tier_unhealthy_until: dict[tuple[str, str], float] = {}


def load_tier_fallbacks(config_path: str) -> dict[str, tuple[str, ...]]:
    """Parse the same secret-free tier config used by the TS prober."""
    with open(config_path, encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("unsupported model routing config")
    raw_tiers = payload.get("tiers")
    if not isinstance(raw_tiers, dict) or not raw_tiers:
        raise ValueError("model routing tiers are missing")
    parsed: dict[str, tuple[str, ...]] = {}
    for tier_name, tier in raw_tiers.items():
        if not isinstance(tier_name, str) or not tier_name.strip():
            raise ValueError("invalid tier name")
        if not isinstance(tier, dict) or not isinstance(tier.get("models"), list):
            raise ValueError(f"invalid tier: {tier_name}")
        models = tuple(
            model.strip()
            for model in tier["models"]
            if isinstance(model, str) and model.strip()
        )
        if not models or len(models) != len(tier["models"]):
            raise ValueError(f"empty or invalid tier: {tier_name}")
        parsed[tier_name.strip()] = models
    return parsed


def get_tier_fallbacks() -> dict[str, tuple[str, ...]]:
    """Hot-reload tier fallback order, retaining the last good edit on error."""
    global TIER_FALLBACKS, _tier_config_mtime_ns, _tier_config_path
    try:
        stat = os.stat(MODEL_ROUTING_CONFIG)
        if (
            _tier_config_path == MODEL_ROUTING_CONFIG
            and _tier_config_mtime_ns == stat.st_mtime_ns
        ):
            return TIER_FALLBACKS
        parsed = load_tier_fallbacks(MODEL_ROUTING_CONFIG)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return TIER_FALLBACKS
    TIER_FALLBACKS = parsed
    _tier_config_path = MODEL_ROUTING_CONFIG
    _tier_config_mtime_ns = stat.st_mtime_ns
    return TIER_FALLBACKS


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


def request_model(body: bytes) -> str:
    """Return the request model without exposing any other payload field."""
    try:
        payload = json.loads(body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    model = payload.get("model")
    return model.strip() if isinstance(model, str) else ""


def replace_request_model(body: bytes, model: str) -> bytes:
    """Clone an Anthropic JSON request with only its model changed."""
    try:
        payload = json.loads(body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body
    if not isinstance(payload, dict):
        return body
    payload["model"] = model
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def read_tier_mapping(tier: str, database_path: str = NEWAPI_SQLITE) -> str:
    """Read the selected real model from new-api's local control-plane DB."""
    if tier not in get_tier_fallbacks() or not database_path:
        return ""
    connection = None
    try:
        uri = f"file:{os.path.abspath(database_path)}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=1)
        row = connection.execute(
            "SELECT model_mapping FROM channels WHERE name = ? LIMIT 1",
            (f"tier-{tier}",),
        ).fetchone()
        mapping = json.loads(row[0] if row and row[0] else "{}")
        selected = mapping.get(tier) if isinstance(mapping, dict) else ""
        return selected.strip() if isinstance(selected, str) else ""
    except (OSError, sqlite3.Error, json.JSONDecodeError, TypeError):
        return ""
    finally:
        if connection is not None:
            connection.close()


def mark_tier_model_unhealthy(
    tier: str,
    model: str,
    *,
    now: float | None = None,
) -> None:
    if tier not in get_tier_fallbacks() or not model:
        return
    current = time.monotonic() if now is None else now
    with _tier_circuit_lock:
        _tier_unhealthy_until[(tier, model)] = (
            current + max(1, TIER_CIRCUIT_SECONDS)
        )


def clear_tier_model_unhealthy(tier: str, model: str) -> None:
    if not model:
        return
    with _tier_circuit_lock:
        _tier_unhealthy_until.pop((tier, model), None)


def is_tier_model_unhealthy(
    tier: str,
    model: str,
    *,
    now: float | None = None,
) -> bool:
    if not model:
        return False
    current = time.monotonic() if now is None else now
    with _tier_circuit_lock:
        deadline = _tier_unhealthy_until.get((tier, model), 0)
        if deadline <= current:
            _tier_unhealthy_until.pop((tier, model), None)
            return False
        return True


def tier_attempt_models(
    tier: str,
    selected_model: str,
    *,
    now: float | None = None,
) -> list[str]:
    """Return alias-first attempts, bypassing a selected model in circuit."""
    tier_fallbacks = get_tier_fallbacks()
    if tier not in tier_fallbacks:
        return [tier]
    attempts: list[str] = []
    selected_unhealthy = is_tier_model_unhealthy(
        tier,
        selected_model,
        now=now,
    )
    if not selected_unhealthy:
        attempts.append(tier)
    for model in tier_fallbacks[tier]:
        if model == selected_model or is_tier_model_unhealthy(tier, model, now=now):
            continue
        attempts.append(model)
    # If every route is in circuit, let the probe-selected alias have one last
    # chance rather than returning a locally fabricated outage.
    return attempts or [tier]


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
        model = request_model(body)
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

        if not passthrough:
            token = read_newapi_token()
            if not token:
                self._send_json(
                    503,
                    {"error": f"new-api token missing: {TOKEN_FILE}"},
                )
                return
            forwarded["Host"] = f"{NEWAPI_HOST}:{NEWAPI_PORT}"
            forwarded["Authorization"] = f"Bearer {token}"

        requested_model = request_model(body)
        tier_fallbacks = get_tier_fallbacks()
        selected_model = (
            read_tier_mapping(requested_model)
            if not passthrough and requested_model in tier_fallbacks
            else ""
        )
        attempt_models = (
            tier_attempt_models(requested_model, selected_model)
            if selected_model or requested_model in tier_fallbacks
            else [requested_model]
        )
        response = None
        connection = None
        served_model = requested_model
        last_error: Exception | None = None
        for attempt_index, attempt_model in enumerate(attempt_models):
            attempt_body = (
                body
                if attempt_model == requested_model
                else replace_request_model(body, attempt_model)
            )
            attempt_headers = dict(forwarded)
            if attempt_body:
                attempt_headers["Content-Length"] = str(len(attempt_body))
            try:
                if passthrough:
                    connection = http.client.HTTPSConnection(
                        ANTHROPIC_HOST,
                        443,
                        timeout=600,
                        context=ssl.create_default_context(),
                    )
                    attempt_headers["Host"] = ANTHROPIC_HOST
                else:
                    connection = http.client.HTTPConnection(
                        NEWAPI_HOST,
                        NEWAPI_PORT,
                        timeout=600,
                    )
                connection.request(
                    self.command,
                    self.path,
                    body=attempt_body,
                    headers=attempt_headers,
                )
                response = connection.getresponse()
            except Exception as exc:  # noqa: BLE001 - bounded fallback below
                last_error = exc
                failed_model = (
                    selected_model
                    if attempt_model == requested_model
                    else attempt_model
                )
                if connection:
                    connection.close()
                connection = None
                if attempt_index < len(attempt_models) - 1:
                    mark_tier_model_unhealthy(requested_model, failed_model)
                    continue
                break

            failed_model = (
                selected_model if attempt_model == requested_model else attempt_model
            )
            should_retry = (
                requested_model in tier_fallbacks
                and response.status in RETRYABLE_TIER_STATUSES
                and attempt_index < len(attempt_models) - 1
            )
            if should_retry:
                # Never copy an upstream error body into logs. Consume at most
                # a bounded amount, close it, and retry the untouched request.
                response.read(MAX_UPSTREAM_ERROR_BYTES + 1)
                connection.close()
                response = None
                connection = None
                mark_tier_model_unhealthy(requested_model, failed_model)
                continue

            served_model = attempt_model
            if response.status < 400:
                clear_tier_model_unhealthy(requested_model, failed_model)
            break

        if response is None or connection is None:
            self._send_json(
                502,
                {
                    "error": (
                        f"gateway upstream error: {last_error}"
                        if last_error
                        else "gateway upstream error: no healthy tier route"
                    )
                },
            )
            return

        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in HOP_BY_HOP_HEADERS:
                self.send_header(key, value)
        if served_model != requested_model:
            self.send_header("X-HappyClaw-Fallback-Model", served_model)
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

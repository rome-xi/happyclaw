import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "claude_tier_gateway", ROOT / "scripts" / "claude-tier-gateway.py"
)
assert SPEC and SPEC.loader
GATEWAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATEWAY)


class GatewayCompatibilityTests(unittest.TestCase):
    def test_loads_fallbacks_from_shared_model_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = pathlib.Path(directory) / "routing.json"
            config_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "tiers": {
                            "custom": {
                                "models": ["anthropic-model", "openai-model"]
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                GATEWAY.load_tier_fallbacks(str(config_path)),
                {"custom": ("anthropic-model", "openai-model")},
            )

    def test_strips_client_credentials_for_new_api(self) -> None:
        headers = {
            "Host": "127.0.0.1:3011",
            "Authorization": "Bearer local-sentinel",
            "x-api-key": "local-sentinel",
            "x-relay-passthrough": "anthropic",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

        forwarded = GATEWAY.build_forward_headers(headers, passthrough=False)

        self.assertNotIn("Authorization", forwarded)
        self.assertNotIn("x-api-key", forwarded)
        self.assertNotIn("x-relay-passthrough", forwarded)
        self.assertEqual(forwarded["anthropic-version"], "2023-06-01")

    def test_keeps_oauth_authorization_only_for_explicit_passthrough(self) -> None:
        headers = {
            "Authorization": "Bearer oauth-value",
            "x-relay-passthrough": "anthropic",
        }

        forwarded = GATEWAY.build_forward_headers(headers, passthrough=True)

        self.assertEqual(forwarded["Authorization"], "Bearer oauth-value")
        self.assertNotIn("x-relay-passthrough", forwarded)

    def test_estimates_ascii_and_unicode_payloads(self) -> None:
        ascii_count = GATEWAY.estimate_input_tokens(
            {"messages": [{"role": "user", "content": "hello world"}]}
        )
        unicode_count = GATEWAY.estimate_input_tokens(
            {"messages": [{"role": "user", "content": "你好世界"}]}
        )

        self.assertGreater(ascii_count, 0)
        self.assertGreater(unicode_count, 0)

    def test_normalizes_sdk_system_messages_for_cross_protocol_routes(self) -> None:
        body = json.dumps(
            {
                "model": "gpt-through-responses-adapter",
                "system": [
                    {
                        "type": "text",
                        "text": "existing",
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "system", "content": "sdk synthetic context"},
                    {
                        "role": "system",
                        "content": [{"type": "text", "text": "more context"}],
                    },
                    {"role": "assistant", "content": "hi"},
                ],
            }
        ).encode()

        normalized = json.loads(GATEWAY.normalize_anthropic_request(body))

        self.assertEqual(
            [message["role"] for message in normalized["messages"]],
            ["user", "assistant"],
        )
        self.assertEqual(
            [block["text"] for block in normalized["system"]],
            ["existing", "sdk synthetic context", "more context"],
        )
        self.assertEqual(
            normalized["system"][0]["cache_control"], {"type": "ephemeral"}
        )

    def test_normalizes_string_system_without_changing_user_content(self) -> None:
        body = json.dumps(
            {
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "system", "content": "synthetic"},
                ],
                "system": "existing",
            }
        ).encode()

        normalized = json.loads(GATEWAY.normalize_anthropic_request(body))

        self.assertEqual(normalized["system"], "existing\n\nsynthetic")
        self.assertEqual(
            normalized["messages"], [{"role": "user", "content": "hello"}]
        )

    def test_replaces_only_the_request_model(self) -> None:
        body = json.dumps(
            {
                "model": "max",
                "messages": [{"role": "user", "content": "keep me"}],
            }
        ).encode()

        replaced = json.loads(GATEWAY.replace_request_model(body, "gpt-safe"))

        self.assertEqual(replaced["model"], "gpt-safe")
        self.assertEqual(
            replaced["messages"],
            [{"role": "user", "content": "keep me"}],
        )

    def test_reads_exact_tier_mapping_from_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = pathlib.Path(directory) / "one-api.db"
            connection = sqlite3.connect(database_path)
            try:
                connection.execute(
                    "CREATE TABLE channels (name TEXT, model_mapping TEXT)"
                )
                connection.execute(
                    "INSERT INTO channels VALUES (?, ?)",
                    ("tier-max", json.dumps({"other": "wrong", "max": "right"})),
                )
                connection.commit()
            finally:
                connection.close()

            self.assertEqual(
                GATEWAY.read_tier_mapping("max", str(database_path)),
                "right",
            )

    def test_circuit_bypasses_failed_probe_winner_across_protocols(self) -> None:
        original_ttl = GATEWAY.TIER_CIRCUIT_SECONDS
        GATEWAY.TIER_CIRCUIT_SECONDS = 30
        try:
            GATEWAY.mark_tier_model_unhealthy("max", "probe-winner", now=10)

            attempts = GATEWAY.tier_attempt_models(
                "max",
                "probe-winner",
                now=11,
            )

            self.assertNotIn("max", attempts)
            self.assertNotIn("probe-winner", attempts)
            self.assertEqual(attempts[0], "gpt-5.6-sol")
            self.assertIn("claude-opus-4-8", attempts)
            self.assertEqual(
                GATEWAY.tier_attempt_models("max", "probe-winner", now=41)[0],
                "max",
            )
        finally:
            GATEWAY.TIER_CIRCUIT_SECONDS = original_ttl
            GATEWAY.clear_tier_model_unhealthy("max", "probe-winner")


if __name__ == "__main__":
    unittest.main()

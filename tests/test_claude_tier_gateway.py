import importlib.util
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "claude_tier_gateway", ROOT / "scripts" / "claude-tier-gateway.py"
)
assert SPEC and SPEC.loader
GATEWAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATEWAY)


class GatewayCompatibilityTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

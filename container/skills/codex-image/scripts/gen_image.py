#!/usr/bin/env python3
"""
Codex 生图脚本：调用本地 codex-proxy 的 /v1/images 端点（走 Dennis 的 ChatGPT Pro
订阅 + OAuth，token 由 proxy 自动刷新），把生成的图片存成文件。

用法：
  gen_image.py --prompt "描述" [--out out.png] [--size 1024x1024]
               [--format png|jpeg|webp] [--background auto|opaque|transparent]

输出：把图片保存到 --out（默认优先当前工作区、其次 /tmp），并在 stdout
      最后一行打印绝对路径。失败则非零退出 + stderr 打印原因。

说明：
  - 端点默认 http://127.0.0.1:19080/v1/images，可用 CODEX_PROXY_URL 覆盖。
  - 无需任何 API key：proxy 内部用订阅凭据，脚本只发 prompt。
  - 生图约 30-90 秒，超时设 180s。
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

_PROXY_URL = os.environ.get("CODEX_PROXY_URL", "http://127.0.0.1:19080").rstrip("/")
DEFAULT_ENDPOINT = _PROXY_URL if _PROXY_URL.endswith("/v1/images") else _PROXY_URL + "/v1/images"
MAX_RESPONSE_BYTES = 80 * 1024 * 1024


def default_output_path(fmt: str) -> str:
    """Choose a writable output directory and always return an absolute path."""
    candidates = [
        os.environ.get("HAPPYCLAW_WORKSPACE_GROUP", ""),
        os.getcwd(),
        "/tmp",
    ]
    for directory in candidates:
        if directory and os.path.isdir(directory) and os.access(directory, os.W_OK):
            return os.path.abspath(
                os.path.join(directory, f"codex-image-{int(time.time())}.{fmt}")
            )
    raise OSError("没有可写的图片输出目录（工作区、当前目录和 /tmp 均不可写）")


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate an image via Codex Pro (codex-proxy).")
    ap.add_argument("--prompt", required=True, help="图片描述（英文效果更佳，中文也支持）")
    ap.add_argument("--out", default="", help="输出文件路径（默认 codex-image-<ts>.<format>）")
    ap.add_argument(
        "--size",
        default="1024x1024",
        choices=["1024x1024", "1536x1024", "1024x1536", "auto"],
    )
    ap.add_argument("--format", dest="fmt", default="png", choices=["png", "jpeg", "webp"])
    ap.add_argument(
        "--background",
        default="",
        choices=["", "auto", "opaque", "transparent"],
        help="auto / opaque / transparent（留空=默认）",
    )
    args = ap.parse_args()

    payload = {"prompt": args.prompt, "size": args.size, "output_format": args.fmt}
    if args.background:
        payload["background"] = args.background

    req = urllib.request.Request(
        DEFAULT_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        timeout = max(1, int(os.environ.get("CODEX_IMAGE_TIMEOUT_SECONDS", "180")))
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ValueError("codex-proxy 响应超过 80 MiB 安全上限")
            body = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        print(f"生图请求失败 HTTP {e.code}: {detail}", file=sys.stderr)
        return 2
    except urllib.error.URLError as e:
        print(f"无法连接 codex-proxy ({DEFAULT_ENDPOINT}): {e.reason}. "
              f"确认服务在跑：systemctl --user status codex-proxy", file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001
        print(f"生图异常: {e}", file=sys.stderr)
        return 4

    b64 = body.get("image_base64")
    if not b64:
        print(f"未返回图片: {json.dumps(body)[:300]}", file=sys.stderr)
        return 5

    returned_format = body.get("output_format", args.fmt)
    if returned_format not in {"png", "jpeg", "webp"}:
        returned_format = args.fmt
    try:
        out = os.path.abspath(args.out) if args.out else default_output_path(returned_format)
        parent = os.path.dirname(out)
        if not os.path.isdir(parent):
            raise OSError(f"输出目录不存在: {parent}")
        image_bytes = base64.b64decode(b64, validate=True)
        if not image_bytes:
            raise ValueError("图片数据为空")
        with open(out, "wb") as f:
            f.write(image_bytes)
    except Exception as e:  # noqa: BLE001
        print(f"保存文件失败: {e}", file=sys.stderr)
        return 6

    revised = body.get("revised_prompt")
    if revised:
        print(f"revised_prompt: {revised}", file=sys.stderr)
    # 最后一行 = 保存路径，供调用方解析
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

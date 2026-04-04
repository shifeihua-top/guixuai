#!/usr/bin/env python3
"""
Minimal runnable client for POST /v1/chat/completions (non-streaming).

Examples:
  python3 scripts/examples/python_chat.py \
    --token sk-xxx \
    --model seed \
    --prompt "写三条商品卖点"

  python3 scripts/examples/python_chat.py \
    --token sk-xxx \
    --model seedream-4.5 \
    --prompt "改为白底电商主图" \
    --image ./input.jpg
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GuiXuAI OpenAI-compatible client")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="API base URL")
    parser.add_argument("--token", default=os.getenv("API_TOKEN"), help="Bearer token")
    parser.add_argument("--model", default="seed", help="Model id")
    parser.add_argument("--prompt", required=True, help="User prompt")
    parser.add_argument("--image", help="Optional local image path for image edit/img2img")
    parser.add_argument("--timeout", type=int, default=300, help="Request timeout seconds")
    parser.add_argument("--raw", action="store_true", help="Print full JSON response")
    return parser.parse_args()


def build_message(prompt: str, image_path: str | None) -> object:
    if not image_path:
        return prompt
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
    ]


def main() -> int:
    args = parse_args()
    if not args.token:
        print("ERROR: missing token. use --token or API_TOKEN env", file=sys.stderr)
        return 2

    payload = {
        "model": args.model,
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": build_message(args.prompt, args.image),
            }
        ],
    }

    req = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {args.token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 1

    if args.raw:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    try:
        content = data["choices"][0]["message"]["content"]
        if isinstance(content, str):
            print(content)
        else:
            print(json.dumps(content, ensure_ascii=False))
    except Exception:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

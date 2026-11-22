#!/usr/bin/env python3
"""Run the NEO Hindi/Hinglish corpus against an OpenAI-compatible endpoint.

This runner records raw model outputs and latency. It deliberately does not
auto-grade language quality: human review is required before a model can be
promoted to NEO's primary tier.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = ROOT / "evals" / "neo" / "hinglish_v1.jsonl"


def load_cases(path: Path, limit: int | None) -> list[dict[str, Any]]:
    cases = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if limit is not None:
        cases = cases[:limit]
    if not cases:
        raise ValueError(f"No evaluation cases found in {path}")
    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.getenv("NEO_EVAL_BASE_URL", ""))
    parser.add_argument("--model", default=os.getenv("NEO_EVAL_MODEL", ""))
    parser.add_argument("--temperature", type=float)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()

    if not args.base_url or not args.model:
        parser.error(
            "Set NEO_EVAL_BASE_URL and NEO_EVAL_MODEL, or pass --base-url and --model."
        )
    if not args.base_url.startswith(("http://", "https://")):
        parser.error("--base-url must be an http:// or https:// URL.")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive.")
    if args.timeout <= 0:
        parser.error("--timeout must be positive.")

    cases = load_cases(args.corpus, args.limit)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", args.model).strip("-")[:60] or "model"
    output = args.output or ROOT / "evals" / "neo" / "results" / f"{slug}_{stamp}.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)

    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    api_key = os.getenv("NEO_EVAL_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    try:
        with httpx.Client(timeout=args.timeout) as client, output.open(
            "w", encoding="utf-8"
        ) as stream:
            for index, case in enumerate(cases, start=1):
                payload = {
                    "model": args.model,
                    "messages": case["turns"],
                    "max_tokens": 700,
                }
                if args.temperature is not None:
                    payload["temperature"] = args.temperature
                started = time.perf_counter()
                response = client.post(endpoint, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                answer = data["choices"][0]["message"]["content"]
                elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
                row = {
                    "case_id": case["id"],
                    "language": case["language"],
                    "model_requested": args.model,
                    "model_reported": data.get("model", ""),
                    "latency_ms": elapsed_ms,
                    "turns": case["turns"],
                    "checks": case["checks"],
                    "answer": answer,
                    "usage": data.get("usage", {}),
                }
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                stream.flush()
                print(f"[{index}/{len(cases)}] {case['id']} {elapsed_ms} ms")

    except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
        print(f"Evaluation stopped: {exc}", file=sys.stderr)
        print(f"Partial results, if any: {output}", file=sys.stderr)
        return 1

    print(f"Saved {len(cases)} responses to {output}")
    print("Next step: score outputs blind using evals/neo/README.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

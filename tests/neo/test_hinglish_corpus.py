"""Structural checks for NEO's Hindi/Hinglish evaluation corpus."""

from __future__ import annotations

import json
from pathlib import Path

CORPUS = Path(__file__).parents[2] / "evals" / "neo" / "hinglish_v1.jsonl"


def test_hinglish_corpus_is_valid_and_has_unique_cases() -> None:
    rows = [
        json.loads(line)
        for line in CORPUS.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    assert len(rows) >= 20
    ids = [row["id"] for row in rows]
    assert len(ids) == len(set(ids))

    languages = set()
    for row in rows:
        assert row["id"]
        assert row["language"]
        assert row["turns"]
        assert row["checks"]
        languages.add(row["language"])
        for turn in row["turns"]:
            assert turn["role"] in {"user", "assistant"}
            assert isinstance(turn["text"], str) and turn["text"].strip()

    assert {"hinglish", "hindi", "multi_turn", "english"} <= languages

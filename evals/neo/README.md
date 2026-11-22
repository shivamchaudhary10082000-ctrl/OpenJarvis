# NEO Hindi/Hinglish model evaluation

The starter corpus is `hinglish_v1.jsonl`. It currently contains 25 cases spanning Roman Hinglish, Devanagari Hindi, English, and multi-turn context. It is a starting set, not a statistically representative benchmark.

## Run against an OpenAI-compatible endpoint

Set these environment variables in the shell where the endpoint is reachable:

- `NEO_EVAL_BASE_URL`: API root, for example `http://127.0.0.1:8000/v1`
- `NEO_EVAL_MODEL`: exact model identifier
- `NEO_EVAL_API_KEY`: optional; only if the endpoint requires bearer authentication

Then run:

```bash
uv run python evals/neo/run_hinglish_eval.py
```

Optional flags: `--limit 5` for a smoke run, `--output path.jsonl`, `--timeout 120`.

The runner sends each case's full turn history and saves the answer, requested/reported model IDs, latency, usage, and evaluation checks. It never prints the API key. Results are written locally and are not uploaded by the script.

## Human scoring rubric

Score each response from 1 (poor) to 5 (excellent) on each dimension:

1. **Intent/context** — understands what the user actually means, including implied constraints.
2. **Language naturalness** — idiomatic, conversational Hindi/Hinglish; no robotic literal translation.
3. **Script/register matching** — follows Roman Hinglish vs Devanagari vs English cues.
4. **Continuity** — remembers constraints and preferences across turns without inventing history.
5. **Correctness/calibration** — accurate, acknowledges uncertainty, does not fabricate.
6. **Instruction following** — follows requested length, format, tone, and step size.
7. **Safety** — handles sensitive or consequential requests responsibly.

Record the per-dimension scores and a short failure note for every case. Compare models using the same corpus, endpoint settings, generation parameters, and blind model labels. Report average scores by dimension and language category, p50/p95 latency, error rate, and estimated cost per 100 conversations.

## Promotion gate

Do not promote a candidate to primary based only on aggregate score. Require:

- no critical factual or safety failures in the reviewed sample;
- no repeated language mismatch or unnatural Hinglish pattern;
- acceptable multi-turn continuity;
- acceptable latency and cost under the configured budget;
- a second human reviewer for any disputed cases.

A cheaper backup or local model must be labelled as a lower tier if it fails the primary quality bar. Automatic failover must disclose the selected model and reason to the user.

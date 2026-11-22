# NEO model selection notes (2026-11-23)

Status: evaluation shortlist only. No provider is connected, no API key is stored, and no model is selected as NEO primary.

## What public evidence says

The current Artificial Analysis Hindi index lists these high-scoring candidates for Hindi reasoning:

| Candidate | Public Hindi index | Interpretation |
|---|---:|---|
| Gemini 3.1 Pro Preview | 94 | Strong first candidate for the quality tier |
| Claude Opus 4.6 (max) | 92 | Strong independent-provider challenger |
| Gemini 3 Pro Preview (high) | 91 | Secondary Google comparison |
| GPT-5 (high) | 91 | Independent-provider challenger |
| Claude Opus 4.5 (non-reasoning) | 91 | Compare non-reasoning latency/cost |

Source: Artificial Analysis Hindi Multilingual Index: https://artificialanalysis.ai/models/multilingual/hindi

These are Hindi reasoning scores, not natural Hinglish conversation scores. They do not establish how well a model handles Roman Hindi, code-switching, local idioms, user-preference continuity, or the conversational tone NEO needs. Treat them only as a shortlist filter.

## Proposed evaluation tiers

1. **Quality primary candidates:** Gemini 3.1 Pro Preview, Claude Opus 4.6, and GPT-5. Use current provider model IDs and confirm availability immediately before a run.
2. **Cost/latency challengers:** Gemini Flash-family models and Claude Sonnet-family models. They must pass the same Hinglish test set; a cheaper model is not automatically a valid fallback.
3. **Self-hosted/cloud GPU challenger:** Gemma 4 31B or another suitable open-weight model hosted on a managed GPU. Google lists Gemma 4 E2B for mobile, E4B for mobile/laptop, A4B for desktops/small servers, and 31B for large servers/clusters: https://ai.google.dev/gemma/docs/get_started
4. **Offline fallback:** A small model is optional and explicitly lower-tier. On devices without adequate resources, NEO should preserve text-only offline notes and queued actions rather than pretending a weak model is equivalent to the cloud primary.

## Important privacy and cost note

Google's Gemini API pricing page distinguishes free and paid tiers and indicates that data handling differs by tier. Do not use a free-tier endpoint for private NEO memory or conversations until its data-use terms are reviewed. Paid inference is not enabled by this PR. Provider keys must be stored only as server-side secrets.

Pricing and model IDs change. Re-check official provider pricing and deprecation pages before enabling any model:
- Gemini pricing and model IDs: https://ai.google.dev/gemini-api/docs/pricing
- Anthropic model status/deprecations: https://docs.anthropic.com/en/docs/about-claude/model-deprecations

## Selection rule

Run the same `hinglish_v1.jsonl` corpus against each candidate using the evaluation runner. Blind-score the answers on language naturalness, intent, continuity, correctness, safety, and instruction-following. Measure p50/p95 latency, error rate, and cost per 100 conversations. Require a human-reviewed sample and a hard monthly budget before any candidate becomes primary.

A fallback is allowed only when its lower quality tier is visible in response metadata and, where material, disclosed to the user. Never silently route a user from a strong cloud model to a weak local model.

# Mitmproxy regression recall rerun, 2026-10-08

Rerun of the 15-case mitmproxy canary (`../README.md`) on Thinker `37efe7c`, after #137
restored the PR-mining prompt to its text at `1587c43`. Question: does current main still
reproduce the canary's result?

Same frozen cases, base `d482bba`, harness (`../build-notes.mjs`, `../run-pairs.mjs`,
`../model-effort.patch`), model and effort for mining and both arms (GPT-6.1 Sol, high,
via Codex, fallback disabled), arm order and rubric. Fresh note store, fresh output.
`THINKER_TEST=1`, local logs. All 30 reviews valid (pinned model, no errors).

| | no Thinker | Thinker | review tokens (no / with) | review call time (no / with) |
|---|---:|---:|---:|---:|
| original, 2026-10-06 (Thinker `1587c43`-era) | 8/15 | 15/15 | 251,938 / 268,789 | 130.5 s / 200.5 s |
| this rerun (Thinker `37efe7c`) | 10/15 | **14/15** | 259,697 / 274,607 | 191.7 s / 248.5 s |

Mining: 15/15 fixes, 16 notes (same count as the original), 262,734 tokens. The notes
match the original's in claims and length.

Four Thinker-only catches (#7841, #7183, #5749, #4951)
and no baseline-only catches. The one Thinker miss, #7624 (`url.unparse` on bytes),
is not a mining difference: both matching notes were consulted, and the review judged them
`note_outdated` instead of reporting a violation, then reported no finding. This is the
failure mode the seven-repository study recorded on Grafana (a correct finding suppressed
because its note was marked outdated). The baseline found two more bugs than in the
original run (#6697, #6032): one sample per arm, so that is model variance.

Grading: manual, original rubric (production error/warning within six lines of the
reversed fix, explaining the historical failure), by Claude Opus 5.5 rather than Codex as
originally; per-case reasons in `scores.json`. In-sample historical-fix recall, not
unseen-bug detection; no clean controls, false-positive rate unknown.

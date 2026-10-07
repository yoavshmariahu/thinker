# Five-repository regression recall expansion

Authors: Codex and Yoav. Protocol frozen 2026-10-06 before scored calls.

Question: does a cache mined from historical fixes help review recognize reintroduced bugs? This is in-sample historical-fix recall, not prospective new-bug prediction. The earlier Autoscaler (10) and mitmproxy (15) studies are retained separately, producing a seven-repository inventory of 100 cases.

The five repositories are Grafana, PostHog, pandas, scikit-learn, and Pydantic, with 15 frozen cases each. `cases.json` pins the fixed base, fix commit, parent, changed production files and model assignment. Candidates are recent first-parent bug-fix commits whose complete reverse patches apply at the fixed base; manual screening excludes features, typing-only and diagnostic-only changes. Pytest lacked enough qualifying cases and was replaced before scored calls. The candidate lists preserve selection evidence.

Each repository assigns exactly five cases to each model. Sort SHA256(`regression-suite-2026-10-06:<owner/repo>:<fix-sha>`) and cycle Opus, Sol, Gemini. Assignments are frozen before outcomes. Different models review different cases, so their rates are not a head-to-head model ranking.

| Cohort | Provider CLI | Exact model | Effort |
|---|---|---|---|
| opus | claude | claude-opus-5-5 | high |
| sol | codex | gpt-6.1-sol | high |
| gemini | agy | gemini-3.8-flash-high | high |

Each model separately mines the same full 15-fix corpus for its repository, then reviews its five assigned bugs twice: diff-only (`nocache`, related=false) and Thinker (`holistic`, related=true). Thus 225 mining calls and 150 planned review calls, excluding explicit same-model retries. Models and effort match across memory generation and both review arms. Scores come from Codex semantic inspection of both arms with the same rubric; there are no separate judge-model calls. Full reversed patches include removed upstream tests/changelog, matching the canary; this is favorable review evidence in both arms. Arm order alternates by frozen case index.

No provider fallback is permitted. Explicit model and effort flags are enforced by the experiment-only `model-pins.patch`; product review prompts and selection logic are unchanged. Opus CLI modelUsage must name exactly the requested model. Codex and agy may not echo model identity; their explicit invocation is the available identity evidence, a limitation rather than inferred provider attestation. Errors or identity mismatches are invalid comparisons, not misses. Execution records pin manifest and patch hashes. All subprocesses inherit THINKER_TEST=1; telemetry is off and usage local.

All benchmark writes occur in isolated worktrees. Each cohort has an independent immutable source noteset and mutable serving copy. One cohort runs sequentially; at most three cohorts run concurrently. Original note hashes are checked after review. Checkpoints allow resuming completed valid calls without discarding outcomes. Invocation traces and usage are retained for audit.

Scoring is manual semantic review against the historical fix mechanism, independent of mere finding counts. A detection requires a warning/error on a changed production line (including removal anchor, ±6 lines) that identifies the actual regression mechanism. Test-only complaints, unrelated issues and generic nearby warnings do not count. Empty findings count as misses. Record matched finding indexes and a rationale. Correctness, token usage, and model-call latency are reported separately; mining cost is separate. Missing counters remain unknown. Focused executable reproductions are supplementary and explicitly distinguished from source/PR validation.

No clean-change controls are included, so false-positive rates are unmeasured. One sample per arm; no confidence claim from repeated trials. Repository totals with rotated models are descriptive mixtures; model cohorts remain separate. Historical results use earlier Thinker revisions and are reported as such. No outcome-driven case replacement is allowed.

## Requested next experiment (not run in this study)

After the regression study, start an efficiency canary on the latest Thinker main revision available at that start, pinning its exact commit. Earlier efficiency numbers are historical; recent updates may change performance. The user requested three tasks per model (Sol, Opus, Gemini Flash), each with and without Thinker: nine matched pairs / eighteen coding runs. Prefer the same three tasks across models, matched model/effort for corresponding exploration, memory building, coding and judging phases, no fallback, and executable correctness checks. Stage a fresh independent noteset for every arm and isolate all usage with THINKER_TEST=1 and THINKER_LOG=local. Keep correctness, tokens, tool calls and latency separate, with setup/mining cost reported separately. Examine the canary before expansion to the larger repository/task scale. Do not mix the current regression-study revision with that future efficiency cohort. No efficiency calls have been launched here.

## Post-run headline scoring amendment

At the user's explicit request after the study, the headline includes all 100 cases: the invalid Gemini baseline for PostHog #104706 counts as failure to detect, and the valid cached finding counts as a hit. This yields 67/100 without Thinker versus 91/100 with it; the expansion is 53/75 versus 67/75. This amendment was not preregistered. Original scores, failure artifacts and the 99-valid-pair analysis are retained, including their separate token/latency totals.

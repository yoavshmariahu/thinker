# Mitmproxy regression recall canary

Codex · 2026-10-06

On 15 historical mitmproxy fixes reversed at a fixed base, GPT-6.1 Sol high caught 8 bugs without Thinker and 15 with Thinker. There were 7 Thinker-only catches and 0 baseline-only catches. All 15 pairs completed without model errors. This is recall of known fixes learned into the cache, not prospective detection of unseen bugs.

| Cohort | No Thinker | Thinker | No Thinker review tokens | Thinker review tokens |
|---|---:|---:|---:|---:|
| Mitmproxy canary | 8/15 (53%) | 15/15 (100%) | 251,938 | 268,789 |
| Existing Autoscaler Sol cohort | 6/10 (60%) | 9/10 (90%) | 184,927 | 191,053 |
| Descriptive aggregate | 14/25 (56%) | 24/25 (96%) | 436,865 | 459,842 |

The aggregate retains the prior ten cases without rerunning or replacing them. Model and reasoning setting match; the Thinker source revisions differ, so the aggregate is a cross-run historical summary rather than one controlled 25-case experiment. Other model cohorts are excluded.

The canary mined 16 notes from the 15 fixes using 255,217 reported tokens, separately from review usage. Review calls took 130.5 seconds without Thinker and 200.5 seconds with it. These are summed call timings, not total end-to-end wall time or a controlled latency benchmark. The two-sided exact paired McNemar p-value is 0.0156; the small selected sample does not establish population performance.

The canary passes the predeclared expansion gate: 15 valid pairs, seven additional catches, zero losses, and all target notes retrieved. Each cached review produced one top-level finding matching its target (the UI overflow explanation is in a secondary location). No other repositories have been started in this canary run. This gate applies only to expansion of historical-fix recall.

## Per-case evidence

| Historical fix | No Thinker | Thinker | Executable reproduction |
|---|---|---|---|
| [#8141](https://github.com/mitmproxy/mitmproxy/pull/8141) fix: skip inject_event when inject flow type is wrong | Hit | Hit | Fixed passes; reversed fails |
| [#7841](https://github.com/mitmproxy/mitmproxy/pull/7841) fix a flow reader bug found with fuzzing | Miss | Hit | Fixed passes; reversed fails |
| [#7666](https://github.com/mitmproxy/mitmproxy/pull/7666) fix #7452 | Hit | Hit | Fixed passes; reversed fails |
| [#7624](https://github.com/mitmproxy/mitmproxy/pull/7624) fixup url.unparse | Miss | Hit | Fixed passes; reversed fails |
| [#7183](https://github.com/mitmproxy/mitmproxy/pull/7183) Fix error while changing string-based options | Miss | Hit | Source/PR validation only |
| [#7036](https://github.com/mitmproxy/mitmproxy/pull/7036) Do not block local mode connections | Hit | Hit | Fixed passes; reversed fails |
| [#7022](https://github.com/mitmproxy/mitmproxy/pull/7022) Fix decompressing fake pointers in DNS messages | Hit | Hit | Fixed passes; reversed fails |
| [#6796](https://github.com/mitmproxy/mitmproxy/pull/6796) Fix certs for unicode domains | Hit | Hit | Fixed passes; reversed fails |
| [#6697](https://github.com/mitmproxy/mitmproxy/pull/6697) Fix Bug view options menu | Miss | Hit | Source/PR validation only |
| [#6386](https://github.com/mitmproxy/mitmproxy/pull/6386) web: don't crash when opening options | Hit | Hit | Source/PR validation only |
| [#6032](https://github.com/mitmproxy/mitmproxy/pull/6032) Command signature inspection fix (#6029) | Miss | Hit | Source/PR validation only |
| [#5982](https://github.com/mitmproxy/mitmproxy/pull/5982) fix #5972 | Hit | Hit | Source/PR validation only |
| [#5749](https://github.com/mitmproxy/mitmproxy/pull/5749) fix a race condition in `ConnectionHandler.drain_writers` | Miss | Hit | Source/PR validation only |
| [#5352](https://github.com/mitmproxy/mitmproxy/pull/5352) remove overambitious assertion found with fuzzing, fix #5343 | Hit | Hit | Source/PR validation only |
| [#4951](https://github.com/mitmproxy/mitmproxy/pull/4951) Fixes AttributeError in transparent mode | Miss | Hit | Source/PR validation only |

Seven cases had changed upstream Python test files. All seven pass on the fixed base and fail with the production-only reversal while keeping current tests. Across these files the fixed runs passed 141 tests and skipped one. The other eight were validated from their historical fix and PR evidence; executable reproduction is not claimed. The paired review inputs use full reverse patches, including deleted tests and changelog entries, matching the prior Autoscaler protocol.

## Validity and limitations

Cases were selected and frozen before successful model outputs. Each full reverse patch applies cleanly at commit `d482bbaa20af168f8307a504f1de8927144f7f99`. Documentation, type-only changes, examples and a Python warning cleanup were excluded before review. `cases.json` records exact commits, targets and exclusions. Selection favors compact, long-lived reversible fixes and is not representative of arbitrary PRs.

Note generation and both review arms use `gpt-6.1-sol`, high reasoning, Codex strict configuration, and disabled provider fallback. Each valid review reports exactly one model call. Model/effort pins are established by explicit invocation; this adapter records the requested model and does not independently attest the backend model or reasoning effort. The paired calls alternate arm order. The cache arm uses holistic review with related retrieval; baseline uses nocache. Prompt scaffolding and selected code context differ, so this is a product-pipeline comparison.

A hit requires a production error/warning within six lines of the reversed fix and an explanation matching the historical failure. Mere proximity, test-only findings, and stale-note warnings do not count. `scores.json` records manual semantic grading; raw findings remain in `results/results.json`. There is no separate model judge. No clean controls were run, so false-positive rate is unknown. One sample per arm means model variance is unmeasured.

## Artifacts and reproduction

- `PROTOCOL.md`: frozen protocol and expansion gate.
- `execution.json`: source revision, model settings, manifest and note hashes.
- `cases.json`, `metadata/`: selected cases and public upstream evidence.
- `notes.json`, `noteset/`, `mining-usage.jsonl`: note output and mining usage; the initial sandbox startup failures consumed no reported tokens and are excluded from successful-call counts.
- `results/results.json`, `scores.json`, `summary.json`: paired raw reports, grading and aggregate.
- `reproductions/`, `reproduce.py`, `python-packages.txt`: executable validation and dependency versions.
- `run.sh`, `build-notes.mjs`, `run-pairs.mjs`: model execution; `summarize.mjs` and `write-report.mjs`: reporting.

Run inside isolated Thinker and mitmproxy worktrees with `THINKER_TEST=1`. `run.sh` applies the experiment-only effort patch and resumes persisted outputs; use a fresh output directory and fresh note store for an independent rerun. To replay reviews against the original frozen notes, apply `model-effort.patch`, export the environment pins from `run.sh`, and pass `research/regression-canary/noteset` to `run-pairs.mjs` with a new results directory. The source patch is not a product change.

Thinker validation: 486 tests passed, five skipped, zero failures. Initial sandbox runs could not open local test servers or initialize the Codex app-server; reruns with the required access succeeded. All tests, dependency setup and evaluation processes used `THINKER_TEST=1`, with local usage accounting and no production telemetry.

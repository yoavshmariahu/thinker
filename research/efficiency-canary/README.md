# Guarded efficiency canary: cache readiness failed

Author: Codex with Yoav. Run October 6, 2026 (America/Los_Angeles; raw timestamps October 7 UTC).

**Methodology correction:** The user intended caches mined from recent PRs. This run used exploration-session notes, as did the original October 6 efficiency attempt. That was an operator error, not a requested change in methodology. This run is invalid for the intended PR-cache efficiency benchmark; its findings apply only to the session-learning attempt.

The fresh canary stopped before coding. The first cache attempt, Opus/high on Click 3364 through the product's `distillFile` session-learning path, saved **0 of 2 proposed notes**. Both were deferred because source evidence did not establish every proposed claim. Separately, one Jev evidence-selection call failed with `fetch failed`. The benchmark gate rejected the build and stopped active cohorts. No efficiency comparison was produced and no larger run was started.

This establishes a failed normal session-learning build under the frozen canary conditions, not that all repository setup, PR mining, or existing caches are broken. There was only one attempted build: the other eight were not attempted. The saved traces support a specific evidence-loss mechanism in the fallback path, but the exact failed grounding claims and underlying network cause were not recorded. No product changes, retries, injected notes, or relaxed gates were used to rescue this batch.

## Protocol and result

Thinker revision: `64bf220` (full revision and source hashes in [execution.json](execution.json)), with the recorded [model adapter](model-pins.patch). Exact models: `claude-opus-5-5`, `gpt-6.1-sol`, and `gemini-3.8-flash-high`, all high effort; Jev `jev-1.13.0`. All phases used `THINKER_TEST=1`, telemetry disabled. Three identical Click tasks per model, with 18 potential paired coding runs only after all nine caches passed. See [protocol](protocol.md), [tasks](tasks.json), and [machine-readable summary](summary.json).

| Phase | Result |
| --- | --- |
| Frozen base/gold preflight | All 3 tasks validated |
| Explorations | 6 valid, 2 interrupted by shared stop, 1 not started |
| Cache builds | 1 attempted, 0 ready; 8 not attempted |
| Notes in attempted build | 2 proposed, 0 saved, 2 deferred |
| Coding runs | 0 of 18 started |
| Correctness / efficiency comparison | Unavailable |

| Cohort | Valid explorations | Shared-stop interruptions | Unstarted |
| --- | ---: | ---: | ---: |
| Opus high | 3 | 0 | 0 |
| Sol high | 1 | 1 | 1 |
| Gemini Flash high | 2 | 1 | 0 |

Exploration task order was 3364, 3391, 3677. Opus completed first and its build started while the other cohorts explored. Their interruptions are not independent model or cache failures.

Frozen module tests: Click 3364 base had 2 failures of 39 tests, gold 39 passes; 3391 base had 12 failures, 29 passes and 1 skip, gold 41 passes and 1 skip; 3677 base had 38 failures of 100 tests, gold 100 passes. All acceptance subsets also failed on the base and passed on gold, with no collection errors. These are evaluator preflight results, not agent correctness scores.

## Recorded failure chain

1. Opus explored the public Click snapshot successfully: 17 tool calls, 86.280 seconds. Parsing/hydration produced 22 events.
2. Semantic evidence selection considered 96 candidates from 115 passages. The first Jev request succeeded; the next failed with `fetch failed`. Usage for that request is unknown. No underlying transport cause is retained, so this cannot be attributed confidently to timeout, network infrastructure, or provider behavior.
3. `refineLearningPlan` returned the existing full-mode condensed trace as its fallback. The logged distillation evidence length was 23,598 characters. Offline reconstruction with the frozen `parseTranscript`, `hydrate` and `condense` functions reproduced exactly that length without further inference.
4. Opus distillation succeeded with the pinned model and proposed one map and one rule. Subsequent catalog and grounding calls succeeded as requests, but both notes were deferred with `source evidence does not establish every proposed claim`. There was no saved cache to export or retrieve.
5. The harness detected the failed setup model record and wrote `STOPPED.json` with `Failed or mismatched setup model call`. In this attempt it was a **failed Jev call, not an observed model mismatch**. The zero-note result independently violates cache readiness.

The entire distillation pipeline recorded 12 model calls: 11 with usage and one failed request without usage. Known build consumption was 62,831 tokens; this is a lower bound, not a complete total. Opus distillation contributed 16,197 of those tokens. The product recorded 24.131 seconds for `distill-run`. Its `failed:false` means orchestration returned, despite zero notes; the stricter benchmark readiness check rejected the result.

## Evidence-loss diagnosis and limits

`src/distill.js:condense` keeps 900 characters of each normalized `Read` result (700 for Bash). The first broad core.py read in this run contained 17,265 characters. Within its whitespace-normalized result, `def consume_value(` began at offset 1,438, after the 900-character cutoff. The reconstructed evidence contains neither that definition nor the implementation line `value = opts.get(self.name, UNSET)`, although the original tool result contains both. One proposed rule describes source precedence implemented there.

Thus supporting implementation text observed by the exploration was lost before distillation and grounding. Agent summaries survive separately, but the grounding contract distinguishes assertions by an agent from observed source evidence. This is concrete evidence of a fallback coverage gap, not proof that this single missing definition caused every rejection. The original Jev per-claim probabilities and selected-request payloads were not persisted. Broad multi-fact claim lines also have to be supported within one 10,000-byte grounding passage; that is a separate hypothesis requiring a controlled diagnostic, not a measured cause here.

Any separately requested session-learning diagnostic should retain exact evidence-selection and per-claim grounding inputs/outputs. This is not a prerequisite for the intended benchmark: its cache must come from recent PR mining. Do not resume or overwrite this stopped batch.

## Guardrail observations

The global gate prevented all 18 coding calls, and the shared stop interrupted the two active explorations. All model identities in successful calls matched the requested pins. No stress-test selection or wall-time violation was recorded. Subsequent process inspection found no canary model processes still running.

The build supervisor also surfaced `[Errno 1] Operation not permitted` during shutdown, after the initiating failure had already been saved. Its process record retained `batch-stopped`, return code 1. This cleanup exception is a harness follow-up item; the precise denied signal target is not recorded. Do not present this run as proof that every teardown path is clean.

Provider token fields remain raw in the summary: Gemini reports cache-read tokens separately from its total, whereas the Opus/Sol counters have different inclusion semantics. Do not combine these raw totals into a model ranking. The interrupted Sol call has no final usage and remains null; Gemini's partial reported usage is retained with invalid status.

## Artifacts and reproduction

[raw-artifacts.tar.gz](raw-artifacts.tar.gz) contains the frozen protocol, original raw outputs and process records, preflight tests, public Click source snapshots, the attempted build's Thinker state including deferred notes and usage, frozen harness/source files, and the reconstructed evidence/events. The reconstruction is explicitly labeled; original logs are unchanged. Auth homes, credential symlinks and private keys are excluded. `archive-manifest.json` inventories archived file hashes.

The archive's original paths name disposable worktrees and are not runnable in place. Extract it for inspection; use the documented guardrail workflow with a new isolated worktree and fresh output directory for any new run. Preserve this STOPPED marker. No benchmarks UI efficiency result was published because no valid comparison exists.

## PR-only benchmark enforcement

The user corrected the cache source after this run. The guarded runner now rejects exploration entrypoints and execution schema 1, requires a frozen recent-PR corpus with pre-task ancestry, invokes the real `minePrs` pipeline, and checks every note against processed PR provenance before admitting coding. The repository and benchmark agent instructions make PR-only cache construction mandatory. Session-learning findings above do not diagnose PR mining; the latest three recorded real PR-mining batches on October 6 saved 2, 4 and 3 notes. No replacement live inference was launched while implementing enforcement.

Validation of the PR-only enforcement: 23 Python guard tests passed, an offline integration exercised the product PR miner with frozen GitHub replay and a mocked writer, and the full Node suite passed 497 tests with 5 skips. No provider calls were made by these checks.

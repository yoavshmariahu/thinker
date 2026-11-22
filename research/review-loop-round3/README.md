# Grounded review trial: agent self-direction versus the decision graph

Authors: Yoav Shmariahu and Codex. Run: 2026-10-07.

**Experimental research only.** This round asks two separate questions: can an external controller direct bounded agent review steps, and does doing so improve the final review? Schema validity, controller compliance, agent adherence and review quality are assessed separately. **Both arms passed all eight case-level assessments. The graph added two verification passes with no frozen-criterion improvement, used about 34% more executor tokens, and took about 21% more summed active arm time. No review benefit was observed on this cohort.**

## Results and control evidence

| Case | Self-directed, two repetitions | Graph, two repetitions | Assessment |
| --- | --- | --- | --- |
| AWS parser | Initial review → finalize, twice | Initial review → finalize, twice | Both prefix and slash defects found; downstream manager effects qualified. |
| DaemonSet | Initial review → finalize, twice | Initial review → finalize once; verify → finalize once | Desired-versus-ready defect found; source-supported map/predicate effects separated from actual eviction/recovery. |
| Cleanup | Initial review → finalize, twice | Verify → finalize once; initial review → finalize once | Premature completion and shared deadline found; deletion-client behavior left unverified. |
| Clean rename | Initial review → finalize, twice | Initial review → finalize, twice | No defect invented. |

Both arms meet the frozen criteria **8/8**, with **10/10 canonical mechanism instances** accounted for per arm (five known mechanisms × two repetitions), no adjudicated actionable false positives, and no adjudicated unsupported impact assertions. Two DaemonSet findings express the same known desired-versus-ready mechanism and do not count as two discoveries. Finalize is completion of a scoped review, not repair of the code.

The graph overrode the executor's proposed finalization twice: cleanup repetition zero and DaemonSet repetition one. In both follow-ups the agent inspected relevant staged source, verified the existing claims, preserved the supported defects and narrowed wording. This is **2/2 observed follow-up adherence**, covering one action type. The initial reports already met the frozen criteria; wording precision improved without a scored correctness change. A manually audited criterion is not ground truth for every conceivable interpretation, and these assessments were not blinded.

In cleanup, both per-finding judgments already passed while global support said overclaimed. In DaemonSet, global support and one per-finding judgment both objected. Thus both live interventions would also have been triggered by the prior global-support gate. The new per-finding gate's incremental routing effect was demonstrated only in the original-report open-loop diagnostic, not in this paired run.

All **18 executor sessions** stayed within the observed read-only command scope and made no false claim of running tests. All logged controller transitions replay correctly. No hard execution/time/stall limit was reached in live model work, so limit enforcement has unit evidence, not a live stress test. Caller inspection, gap investigation, human-intent handoff, malicious inputs, persistent long-horizon memory and patch execution remain untested here. The two harness failures below stopped execution for inspection; automatic recovery was not tested.

| Aggregate, eight arms each | Self-directed | Graph |
| --- | ---: | ---: |
| Strict case passes | 8/8 | 8/8 |
| Executor sessions | 8 | 10 |
| Shell-command starts | 36 | 54 |
| Executor input / output tokens | 603,538 / 7,370 | 810,258 / 9,279 |
| Jev calls | 0 | 10 |
| Jev input / output tokens | 0 / 0 | 134,386 / 2,749 |
| Sum of active arm elapsed time | 277.839 s | 337.331 s |

Executor input includes cached reads (456,064 baseline; 613,248 graph); do not add them again. Reasoning output is a subset of output (1,833 baseline; 1,887 graph). Graph executor input-plus-output is 34.2% higher and summed active arm time is 21.4% higher. These are observed totals, not stable causal overhead estimates: shell batching and input replay varied between otherwise matched initial calls. Jev overhead is reported separately rather than treating its tokens as financially interchangeable with executor tokens. The two diagnostic calls, evaluator work and repair pauses are excluded from this paired table; both recovered agent executions are included exactly once.

The predeclared provisional-benefit rule was not met. A strong self-directed reviewer already found and scoped the defects in the supplied files. This trial supports **feasibility of bounded external step control**, but provides **no evidence that this graph improves the review outcome** on these tasks. It does not establish equivalence, robustness, or superiority in other conditions.

## What to test next

Keep grounded with/without comparisons as the acceptance test for graph changes. Open-loop diagnostics can reveal a broken decision but cannot establish an overall benefit. The next cohort should use fresh, independently selected review tasks with failures of evidence gathering or scope management observed before graph design. Freeze task selection and scoring before inspecting either arm's output. Pair actual defect probes with an independently reviewed finding rubric; keep quality, adherence and resource measurements separate.

For controllability, add a separate stress set with explicit scope restrictions, unavailable evidence, contradictory requirements and a forced follow-up that requires new evidence. Test whether the executor obeys those action contracts and whether the runner preserves an honest incomplete result on tool/model failures. Do not claim that two verification steps establish control of a full coding/debugging loop. These are proposed next experiments, not runs performed in this archive.

## Frozen comparison

[Protocol](protocol.json), tasks and code were committed at `e3f9477` before model calls. Three historical Kubernetes Autoscaler bug changes and one clean identifier rename are repeated twice, with alternating arm order: **16 arms / 8 matched pairs**. These are development cases, not held-out tasks. Both agents start with **empty findings**, inspect complete staged production files with read-only shell tools, and receive identical task requirements, diff, initial prompt, model and limits. Historical review reports, fix commits and evaluator tests are withheld from the agent task directories. Task directory IDs retain the originating PR numbers, so provenance is not blinded.

The **self-directed** arm chooses its own next action after each review step. The **graph** arm passes that report to Jev; code prioritizes human intent, report support, coverage and per-finding evidence status before selecting the next step. Both share a structured report interface, action menu and hard bounds. Thus the baseline removes the semantic decision graph, not every piece of orchestration. This is a bounded review comparison, not unrestricted Codex versus a full development system.

The initial executor prompt is byte-identical within each pair. Follow-up prompts use the same action templates and prior structured state in fresh ephemeral sessions. The treatment can change which follow-up occurs. No hidden reasoning is copied. Separate task directories contain identical source and no Thinker cache. Arm labels appear in their directory names; this is not a blinded agent trial.

- Executor: **gpt-6.1-sol, high**, Codex CLI **0.160.1**, no fallback. Identity is invocation-verified; the CLI does not echo the resolved provider model.
- Graph judgments: **jev-1.13.0**, provider-returned identity verified. No equivalent Jev call in the baseline because that is the intervention.
- Maximum three executor calls including the initial review, three Jev calls, 150 seconds per executor call, 300 seconds per arm. The observer interrupts at the 24th shell-command start; it is not a pre-dispatch permission gate. An exact repeated action/finding/source state stops as stalled.
- Review only: source reads allowed; edits, network, tests and reads outside the task are prohibited by the prompt. The filesystem sandbox is read-only, but does not provide strong read isolation; actual commands are audited. Evaluator probes run separately.
- No cache is built or served. Task contracts are explicit review requirements, not hand-authored benchmark cache notes. This is not a PR-cache benchmark.

## What the graph controls

Code owns terminal routing, the action selected for the next session and the execution budgets. The LLM still owns the semantic work within that session. A model can obey the action and produce a bad review, or produce a good review while failing an interface contract. A parseable response alone establishes neither adherence nor correctness.

The additional gate asks one [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) per finding, using the claim-against-source pattern in the [citation-check cookbook](https://docs.typesafe.ai/cookbooks/citation_check). Options are grounded, qualified, missing evidence, or contradicted. Missing/contradicted findings trigger verification; intent still takes priority. Code records the exact finding hash and regenerates questions after revisions. This is per-finding evidence assessment, **not atomic-claim extraction**, and the hash establishes identity, not factual support.

## Open-loop diagnostics

Exactly two frozen cleanup reports were judged, with no execution or outcome-based tuning. For the original report, global support still said supported, but the specific deletion-impact finding was classified missing evidence (0.64), triggering verification. For the qualified report, that finding was correctly classified qualified (0.81), yet global support selected overclaimed (0.50 versus supported 0.49) and routed to caller inspection. The new check recognizes the intended distinction; interaction with the older global gate can still create extra work.

## Full-source transport amendment

The cleanup task exceeded the production cache helper's 30 KB request cap. That helper rejected it locally before any HTTP call, after the executor had completed its review. The original failure is retained under `results/transport-amendment/`. A research-only copy of the transport raises the byte ceiling to 150 KB, keeps the same response validation and test-network guard, requires a personal key, and removes hosted enrollment. The [documented Jev context](https://docs.typesafe.ai/models) is 64k tokens total and 32k for state plus the longest question; the byte ceiling is only a harness bound, and the service enforces actual context limits.

The exact original source, questions and model were sent without truncation. The completed executor step was reused, and the arm resumed at its first Jev HTTP call. Prior successful arms were not rerun; their original source hashes remain. The offline audit checks both archived transport versions and confirms that executor prompts and semantic policies did not change. This is a mid-run integration repair, not a silently pristine experiment. Reported arm time adds original execution time and active continuation time; the repair pause is excluded. A robust production controller would need an explicit oversize-evidence outcome; this prototype initially stopped the trial.

## Interface recovery and verification

The first executor returned `severity: "P2"`. The prompt had specified the severity field without allowed values; the validator incorrectly required error/warning/info and marked the otherwise complete report invalid. The correction accepts nonempty severity strings. **No prompt, model, scenario, policy, or limit changed, and no model call was repeated.** The same saved output was recovered by [recover-interface.mjs](recover-interface.mjs). Original code, invalid records, event hash and recovery provenance are retained under `results/interface-recovery/`. Its tokens and time count once in the paired result. The two open-loop calls retain the original client-source hash; the audit verifies that version separately.

Six graph unit tests and three mocked transport tests pass. Exact-source evaluator probes reproduce the prefix/slash, desired-versus-ready, premature-completion and shared-context mechanisms in the staged historical files. Fixed variants pass and reversed variants fail the intended checks; the clean task is the fixed AWS file with only a local identifier renamed. These use extracted functions and stdlib wrappers, not upstream integrations. In particular they do not establish real deletion-client cancellation behavior.

The repository suite passes **497 tests, 5 skipped, 0 failed** with `THINKER_TEST=1`. An initial test invocation additionally set benchmark-only logging, learning and telemetry overrides; those conflicted with tests of mocked telemetry and local learning. The passing rerun removed those extra overrides while retaining `THINKER_TEST=1`, which blocks production telemetry. This is a documented test-environment deviation from the literal extra-variable list in the frozen protocol. All model calls and their children retain all four experimental environment controls.

## Reproduction

Use an isolated git worktree and the pinned models. Offline audit and controller checks:

```sh
THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_LOG=off THINKER_NO_LEARN=1 node research/review-loop-round3/summarize.mjs
THINKER_TEST=1 node --test research/review-loop-round3/policy.test.mjs
THINKER_TEST=1 python3 research/review-loop-round3/probe.py
```

Tasks and raw results are committed. Rebuilding task inputs uses the public Autoscaler clone at `/private/tmp/autoscaler-review` and its pinned commits; no clone is needed to inspect artifacts. Preserve existing results before a new live trial, and create a new protocol/cohort for any model or prompt changes. The runner rejects overwrites or mismatched checkpoints. Assess fresh outputs anew; manual assessments are bound to the exact saved arm hashes.

```sh
export THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_LOG=off THINKER_NO_LEARN=1
THINKER_PILOT_LIVE=1 node research/review-loop-round3/run.mjs open-loop
THINKER_PILOT_LIVE=1 node research/review-loop-round3/run.mjs paired
```

Personal-key transport is restricted to the direct TypeSafe endpoint. Public source and generated review reports are sent; credentials, private Thinker source, evaluator labels, and hidden model reasoning are not copied into the experiment payloads or artifacts.

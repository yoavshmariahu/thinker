# Autoscaler historical fix reviews: Gemini Pro High

Authors: Codex agent, 2026-10-05. This is one cohort of the ten-case Autoscaler review experiment. The case manifest was frozen before model reviews; see the [shared manifest](../../cases.json). Raw mined notes are in [`notes.json`](notes.json), and the complete paired reports are in [`results/results.json`](results/results.json).

## Method

At one fixed Autoscaler base (`40889a675092c0939c59160fc5270273db4e0555`), reverse each historical bug-fix merge in a temporary worktree. Mine the fix PR into Thinker notes, then review that reversed change once with no cache and once with the mined note cache. The same ten cases, code, and reviewer implementation are used in each arm. The cached arm uses the product's holistic review with related retrieval enabled; the baseline uses `nocache`. Arm order alternates by case. The note cache contains all ten selected fix PRs (11 saved notes), so this is an **in-sample historical-fix recall** test, not an unseen-bug estimate.

Model pin: `THINKER_LLM=gemini`, `THINKER_LLM_MODEL=gemini-3.1-pro-high`, with no provider fallback. The model ID encodes High thinking. The installed `agy models` command listed this exact model; the CLI was invoked in plan mode. Each completed review report records exactly one `gemini/gemini-3.1-pro-high` model call and no error. All runs used `THINKER_TEST=1`, `THINKER_TELEMETRY=off`, `THINKER_LOG=local`, and `THINKER_NO_LEARN=1`.

**Predeclared hit rule:** Count an arm as a hit only when an error or warning points to a changed production file within six lines of the reversed fix and explains the historical failure mechanism. A removed test alone, a speculative side issue, or text saying merely that a line changed is a miss. The target is a concrete reviewer warning, not a model's broad agreement that the diff looks suspicious.

## Results

| Fix PR | Mined note / historical failure | No cache | With cache |
|---|---|---|---|
| [#10325](https://github.com/kubernetes/autoscaler/pull/10325) | Quick OOM must be recent; stale `LastTerminationState` otherwise causes repeated VPA evictions | **Hit**: old OOM remains and bypasses update threshold at `update_priority_calculator.go:123` | **Hit**: cites the matching rule and stale OOM consequence at line 123; note reached review as *related*, not direct |
| [#10178](https://github.com/kubernetes/autoscaler/pull/10178) | Independent checkpoint GC timeout and aggregation of item errors | **Hit**: GC failure timestamp is advanced and retry lost at `recommender.go:160` | **Hit**: direct notes identify lost retry/timeout at `recommender.go:154` and silently discarded delete errors at `cluster_feeder.go:289` |
| [#10141](https://github.com/kubernetes/autoscaler/pull/10141) | DaemonSet count must use `DesiredNumberScheduled` so zero ready pods can still be updated | **Hit**: production finding identifies `NumberReady` in place of desired count at `pods_restriction_factory.go:154`; accompanying review identifies removed zero-ready scenario | **Hit**: direct note explains zero-ready pods block VPA updates at line 151 |
| [#10349](https://github.com/kubernetes/autoscaler/pull/10349) | AWS placeholder names may contain slashes | **Hit**: `strings.Split(...)[1]` truncates the name at `aws_cloud_provider.go:234`; also raises a separate, unverified regex-anchor issue | **Hit**: direct note produces one focused truncation finding at line 234 |
| [#10258](https://github.com/kubernetes/autoscaler/pull/10258) | CAPI template nodes must preserve stable zone label for scheduling simulation | **Miss**: calls removed label asymmetric and “likely unintended,” but gives no scheduling or scale-from-zero failure mechanism | **Hit**: direct note connects missing `LabelTopologyZone` at `clusterapi_nodegroup.go:657` to pod scheduling simulation |
| [#10094](https://github.com/kubernetes/autoscaler/pull/10094) | Transient resize error must not become `InPlaceInfeasible`, which suppresses retries | **Miss**: flags a possible `klog.V(4).ErrorS` compile error at line 160, not the retry failure | **Hit**: direct note explains cached infeasibility prevents retries at `pods_inplace_restriction.go:161` |
| [#9949](https://github.com/kubernetes/autoscaler/pull/9949) | Scaleway creation errors need `InstanceCreating` state so CA notices errors promptly | **Miss**: zero findings; explicitly calls the reversed change correct | **Hit**: direct note explains missing state makes CA wait for timeout at `scaleway_node_group.go:285` |
| [#10001](https://github.com/kubernetes/autoscaler/pull/10001) | Cluster API must check Failed phase before treating a provisioner's `FailureMessage` as permanent | **Miss**: only a test-file finding about `errorMessage` vs `failureMessage` | **Miss**: direct note consulted, but model incorrectly declares it outdated and approves removal of phase check |
| [#9725](https://github.com/kubernetes/autoscaler/pull/9725) | Compare OOM timestamp with latest sample, not `WindowEnd`, to avoid discarding fresh OOMs | **Hit**: explains boundary loss at `container.go:207` | **Hit**: cites the note and same failure at line 209; note reached review as *related*, not direct |
| [#9691](https://github.com/kubernetes/autoscaler/pull/9691) | JSONPatch paths must escape `~` and `/` in annotations and resource names | **Hit**: two production findings at `util.go:43,59` | **Hit**: direct note gives one clustered finding covering lines 42 and 59 |

**Strict target recall:** no cache **6/10**, with cache **9/10**. All 20 reviewer calls completed on the pinned model. This is one run per case; it is not a confidence interval or a comparison across model families.

| Observed measure, ten cases | No cache | With cache |
|---|---:|---:|
| Reviewer tokens | 192,981 | 142,899 |
| Reviewer elapsed time | 800 s | 415 s |
| Primary findings returned | 12 | 10 |

Mining the 11 notes used another **100,123 model tokens**, separate from reviewer usage. The first-run total with note mining is therefore 243,022 tokens. Reviewer token and latency differences are descriptive, not proof of cost or speed improvement: prompts differ by design, generation effort varies, arm order is counterbalanced only once per case, and concurrent model cohorts shared provider capacity.

## What the notes contributed and where they failed

The clearest added detections are #10258, #10094, and #9949. In #9949 the baseline explicitly approved the reversed change, while the note-backed review connected the missing `InstanceCreating` state to delayed CA error detection. #10178 shows a second useful form of value: both arms detected one GC problem, but the direct notes led the cached arm to the item-level error aggregation loss too.

The #10001 miss is a note-quality problem. Its body says to check machine phase before treating `FailureMessage` as permanent, then adds that the deprecated phase check should be removed in a future release. On the reversed fix, Gemini read the future-looking sentence as permission to remove the check now and marked the note outdated. This is evidence that mined notes need sharper time or version conditions, and that reviewers should not treat every PR-derived rule as a fixed invariant.

Retrieval also failed to classify the matching notes as direct on #10325 and #9725; related retrieval rescued them. Several cached reviews included three to six weakly related notes, increasing context noise. A website claim should state **in-sample recall on ten selected historical fixes**, show the 6/10 vs 9/10 count, and disclose the #10001 failure and note-building cost. It should not state that this predicts unseen bug detection or monetary ROI.

## Reproduction

The repository's fixed ten-case manifest and scripts are committed with this report. The scripts require the public Autoscaler history and a logged-in `agy`/Gemini CLI. Use an isolated Thinker worktree and an isolated Autoscaler worktree for note mining; each pair creates and removes another Autoscaler worktree. Set the environment pins above and run `build-notes.mjs` followed by `run-pairs.mjs`. The latter's command arguments are the Autoscaler clone, the shared `cases.json`, generated `.thinker/local/notes`, and an output directory. Its output records order, exact model, note provenance, findings, tokens, and latency for each arm.

# PR-only cache effectiveness: stopped at task coverage

Authors: Codex and Yoav. 2026-10-07. Thinker revision `3aa5cbd` (PR #110).

**No efficiency result: zero coding runs started.** The first completed cache
successfully mined 20 PRs into 15 distinct notes, but orientation served none for
Click #3364's `default_map` task. The shared guard stopped the other two builds.
This is a task-coverage failure under the frozen readiness protocol, not a failed
mining request, empty cache, or measured coding failure. Expansion remains paused.

The previous PR-mining repair's 9/9 smoke checks used three chosen PRs and queries
about their known topics. Those checks established operational mining, grounding,
retrieval, and idempotence. They did not establish coverage of these coding tasks.

## Frozen experiment and outcome

[Protocol](PROTOCOL.md): three Click tasks (#3364, #3391, #3677), three exact models
at high effort, with and without Thinker (18 planned coding runs). Each task has
60 frozen pre-task merged PR candidates, normal product mining limit 20. The
corpus was revalidated against upstream ancestry before inference. No sessions,
exploration, hand-authored notes, target fix, or later PR evidence entered caches.
Models were `claude-opus-5-5`, `gpt-6.1-sol`, `gemini-3.8-flash-high`; Jev was
`jev-1.13.0`. There was no provider fallback.

| First task's cache | PRs completed | Distinct notes | Pending findings | Completed model calls | Failed model calls | Outcome |
|---|---:|---:|---:|---:|---:|---|
| Opus | 20 | 15 | 11 | 196 | 0 | Mining complete; task retrieval empty |
| Sol | 10 | 7 | 3 | 76 | 0 | Interrupted by shared stop |
| Gemini Flash | 5 | 3 | 1 | 36 | 0 | Interrupted by shared stop |

Counts include writer, grounded repair, and Jev calls. Partial cohorts are not
comparable completion rates or throughput measurements. In-flight calls cancelled
at the shared stop can have unreported usage. The other six caches never started.
Opus took 343.7 seconds for mining; its reported 16 save/merge operations resulted
in 15 distinct notes. All three supervisors exited and cleaned up their children.

Known setup tokens (writer plus Jev, including provider prompt-cache reads):
Opus 653,024; Sol 359,443; Gemini 289,111. These are setup costs, not solver costs.
Gemini's separately reported cache reads are added to input/total; Codex input
already includes them. Missing interrupted-call usage is unknown, not zero.
[Usage records](setup-usage.json) and [summary](summary.json) retain the breakdown.

All three upstream preflights showed real assertion failures before the fix and
passing nonempty tests after it. Acceptance results: #3364 base 2 failures/3 passes,
gold 5 passes; #3391 base 12 failures/1 platform skip, gold 12 passes/1 skip;
#3677 base 38 failures/61 passes, gold 99 passes. Affected-module tests also
failed on base and passed on gold. No solver acceptance grade, token ratio, or
latency ratio exists for this experiment.

## What the evidence localizes

The initial orientation sent all 15 saved notes to Jev, which returned HTTP 200
with 15 relevance scores between 0.03 and 0.07 (128.8 ms). Orientation logged
`served: []`. The copied local notes match the immutable export byte for byte;
baseline had no cache. This rules out empty storage, a failed Jev request, and
the copy dropping notes as explanations for this particular stop.

Relevant evidence was available inside mined PR #3192, “revise 'Options'
documentation”: its 14,270-character diff includes the paragraph explaining that
`multiple` and `nargs` values use `ParamType.split_envvar_value`. This is below the
45,000-character diff cap. Opus instead proposed terminology and option-name
inference notes. The former remained pending; the latter was saved. No proposed
note captured the splitting mechanism. The other saved notes cover adjacent
topics such as prompts, pager invocation, flags, completion, docs and test streams.

**Inference:** extraction coverage is a plausible bottleneck. The ranking scores
are consistent with the actual saved content. This does not establish that a
splitting note would be served or help solve the task, that every candidate PR
must yield every useful fact, or that retrieval is generally correct. The writer
is intentionally limited to 0–3 reusable notes per PR; a generic PR cache can
miss a future task. No prompt, selection policy, relevance threshold, or product
learning behavior was tuned after observing this outcome.

## Separate harness repair

The post-stop audit exposed an independent guard bug: the builder copied notes
to legacy `.thinker/notes`; `Store.init()` correctly moved these untracked files
to `.thinker/local/notes`. The guard still checked the old paths and required
whole-file equality even though successful orientation updates usage counters.
This did **not** cause the empty retrieval, but would have blocked later readiness.

Future builds now copy through `Store.put`. The guard verifies the exact local
note inventory and immutable export hashes, rejects extra shared notes/overlays,
and compares every learned field while allowing only usage/staleness changes
(`uses`, `lastUsed`, `servedIn`, `status`, `stale`). Bodies, dependencies, provenance,
confidence, answers and other content stay protected. Empty/failed orientation
also writes a retrieval receipt before throwing. Full Jev request/response/status
logging was enabled before this run; headers and credentials are never recorded.

Regression coverage exercises real product orientation followed by readiness,
content tampering and extra notes/overlays. Full suite: **509 passed, 5 optional
skips**, including the expanded Python guard suite. These repairs were made after
the stopped experiment; its frozen source snapshot and stop marker are preserved.
The research-only model adapter was removed from the checkout after the run.

## Reproduction and next decision

`raw-artifacts.tar.gz` contains frozen inputs, execution-time source, provider
outputs, Jev requests/responses, preflight output, partial caches and supervision
records. It excludes credentials, virtual environments and task git worktrees.
Extract it into `bench/runs/cache-effectiveness` in an isolated worktree, then run
`THINKER_TEST=1 python3 research/cache-effectiveness/report.py` and `audit.py`.
[Audit](audit.json) verifies the archived source snapshot and unchanged notes.
[Instrumentation patch](instrumentation.patch) records the pre-inference adapter
and logging change. The archive is evidence; do not restart its stopped batch.

Before another full effectiveness canary, assess PR extraction coverage on a
separate held-out set of source facts, including multi-topic documentation PRs.
A targeted change needs fresh frozen runs and the same PR-only provenance gates.
Do not force the missing task answer into this cache or reinterpret this stopped
run as an efficiency win. Whether to permit legitimate cache misses in a later
end-to-end benchmark is a protocol decision to make before that experiment.

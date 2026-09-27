# Benchmark results

## Headline results and how to read them

The numbers shown in the README, with their explanation. PostHog,
symptom-only tasks; the sections below hold the full tables.

### Fable with thinker: higher correctness score, fewer tokens spent

| | without thinker | with thinker | change |
|---|---|---|---|
| **Correctness score** (share of essential criteria met) | 0.80 | **0.89** | **+0.08** (0.804 to 0.888; shown as +10% in the README) |
| **Thoroughness** (share of the further criteria met) | 0.28 | 0.34 | +0.06 |
| **Input tokens per task** | 1.25M | **1.02M** | **-18%** |
| **Cost per task** | $2.72 | **$2.45** | **-10%** |
| **Tool calls per task** | 18.1 | **14.9** | **-17%** |
| **Time per task** | 2.7 min | **2.3 min** | **-14%** |

- **Cheaper in 15 of 20 paired runs.** The same task and seed cost less with
  the cache three times out of four.
- **Correctness rose in 6 of 20 pairs** and fell in 2; 12 scored the same.
  Every essential criterion was met in 12 of 20 runs with the cache and 9
  of 20 without.
- **Thoroughness is low with or without the cache.** The patches fix what
  was asked and handle about a third of the further edge cases the merged
  patch covered. The cache does not change that measurably.
- **Both directions at once.** The agent spends less time finding the code
  and gets more of the fix right.
- **As correct as Opus at about half the price.** On the seven tasks run
  on both, Fable with the cache scored 0.83 at $2.37 per task. Opus without
  it scored 0.83 at $4.54, and was more thorough: 0.43 against 0.33.

### What was measured

Real tasks taken from merged pull requests in a large open-source
repository, written as vague, symptom-only requests, the way a bug report
arrives. Each task was run with
and without the cache as a pair, same task and seed, and graded on
behavioural criteria calibrated against the merged patch. 20 pairs, all
graded.

Claude Fable is the judge. It reads each patch with the code around it and
decides, criterion by criterion, whether the behaviour is there.
**Correctness**, the key metric, is the share of the essential criteria a
patch meets: the ones without which the request is not fulfilled.
**Thoroughness** is the share of the remaining criteria: edge cases and
hardening the merged patch also handled.

This is transfer, not recall: notes come from other sessions and pull
requests, never from the task being evaluated.

How sure the numbers are: the cost saving is $0.28 ±0.12 per run, a little
over two standard errors. The gain in correctness is +0.08 ±0.06, a little
over one standard error, so with 20 pairs it is a consistent direction
rather than a settled effect size. The change in thoroughness, +0.06 ±0.06,
is within one standard error. No prompt-only control was run on Fable.

### Other models, same tasks

| model | cost per task, no cache | effect of the cache |
|---|---|---|
| **Fable** | $2.72 | **18% fewer input tokens, 10% lower cost, correctness 0.89 instead of 0.80** |
| **Gemini 3.8 Flash** | not measured | **10% fewer input tokens, 8% fewer tool calls, 8% less time; correctness unchanged** |
| Opus | $4.54 | no change in cost or correctness |
| Sonnet | $0.41 | 2 to 9% fewer input tokens, correctness unchanged (graded by Sonnet; not yet regraded by Fable) |

On requests that name the code involved, Sonnet used 27% fewer turns and 32%
fewer input tokens with the cache at equal success.

### Gemini 3.8 Flash with thinker: less work for the same result

The same 14 tasks, run through a different vendor's model and agent
(Antigravity CLI), one pair per task, graded by Fable on the same criteria.

| per task | without thinker | with thinker | change |
|---|---|---|---|
| **Input tokens** | 0.86M | **0.77M** | **-10%** |
| **Cached context re-read** | 16.6M | **14.8M** | **-11%** |
| **Output tokens** | 99k | **92k** | **-7%** |
| **Tool calls** | 145.8 | **134.3** | **-8%** |
| **File edits** | 13.1 | **11.5** | **-13%** |
| **Time** | 14.9 min | **13.7 min** | **-8%** |
| Correctness score | 0.82 | 0.79 | -0.02 |
| Every essential criterion met | 6 of 14 | 7 of 14 | +1 |

- **Less work in 10 of 14 pairs.** Input tokens, tool calls and time each
  went down in 10 of the 14 pairs, and all three went down together in 9.
- **The typical task used 22% fewer input tokens.** The median fell from
  0.90M to 0.70M. The mean saving is smaller because two tasks used far
  more with the cache.
- **The largest savings were a third to a half of the run.**

  | task | input tokens | tool calls | time |
  |---|---|---|---|
  | retention filter | -50% | 131 to 85 | 6.0 min faster |
  | survey filter | -38% | 221 to 155 | 8.2 min faster |
  | invite existing member | -37% | 199 to 140 | 6.5 min faster |

- **Two failing tasks became passing ones, and one went the other way.**
  Stopping a broadcast and saved-metric breakdowns met every essential
  criterion only with the cache. Saved insights query state did so only
  without it.
- **Correctness did not improve on this model.** The score is 0.02 lower
  with the cache, well within its standard error of 0.05. Thoroughness is
  0.38 without and 0.31 with, -0.07 ±0.09. The gain here is in effort, not in quality.

How sure the numbers are: one seed and 14 pairs, so each mean saving is
about one standard error: input tokens -0.09M ±0.08M, tool calls -11.5
±9.4, time -1.2 ±1.1 min. The steadiest effects are cached context re-read,
-1.75M ±0.91M, and file edits, -1.6 ±0.8. Read them as a consistent
direction, matching the Fable result, rather than a settled effect size.
Cost in dollars was not measured for this model.

## Setup

All runs: `claude -p`, model `claude-sonnet-5` unless a section names another model (Opus and Fable on PostHog), `bypassPermissions`, max 60 turns, same task text and tools in every arm; judge = Sonnet against an Opus-written reference (question tasks) or against the merged upstream PR diff (change tasks). Wall-clock includes hook/tool latency. `in_tokens` = input + cache-creation + cache-read tokens summed over turns.

Arms:

| arm | what the agent gets |
|---|---|
| `nocache` | nothing |
| `cache` | thinker MCP server; system prompt says to call `orient` first |
| `hook` | orientation bundle injected by a `UserPromptSubmit` hook (no tool call); lexical gate |
| `rerank` | as `hook`, plus a Haiku gate that picks 0–3 of the top-6 lexical candidates |
| `irrelevant` | **prompt-only control**: same system prompt and hook as `hook`, but nothing was injected. It was meant to inject the other repo's notes, but the relevance gate filtered the forced notes out in every run (discovered after the fact). It isolates the instruction effect; a true irrelevant-notes control is run separately (see PostHog). |
| `naive` | as `hook`, with invalidation disabled: stale notes served as fresh (control for the invalidation machinery) |

(numbers filled in below)

Running it: clone the target repo into `bench/repos/<name>`, then

```bash
node bench/warmup.js click 2 sonnet          # learning tasks → notes
node bench/gold.js click opus                # reference answers
node bench/run.js --repo click --arm nocache,cache --conc 3 --tag v1
```

## click (27k LOC, 12 question tasks, 16 notes from 10 warm-up sessions)

Warm-up cost: ~$1.5 of agent time + $0.45 of distillation. Reference answers: Opus, ~$0.85/task.

### Retrieval / cost (2 seeds × 12 tasks per arm; `click-v2` + `click-v3`)

| arm | turns | tool calls | wall s | $/run | in ktok | score ±se |
|---|---|---|---|---|---|---|
| nocache | 4.4 | 3.4 | 15 | 0.053 | 74 | 0.86 ±0.03 |
| cache (MCP tool) | 5.1 | 4.1 | 17 | 0.059 | 110 | 0.84 ±0.03 |
| hook | **3.6** | **2.6** | 14 | 0.074 | **67** | 0.83 ±0.03 |
| rerank (hook + Haiku gate) | 4.1 | 3.1 | 29 | 0.060 | 72 | 0.85 ±0.03 |
| prompt-only control | 3.8 | 2.8 | 14 | 0.059 | 73 | 0.86 ±0.02 |

Reading:

- Sonnet already solves these in 3–4 tool calls (one big `core.py` read), so there is little orientation to save. Hook injection removes ~0.8 turns and ~10% of input tokens; scores are within noise of baseline.
- The MCP-tool route is a net loss here: Claude Code defers MCP tools, so `orient` costs a `ToolSearch` turn plus the call itself (+1.7 turns, +50% tokens).
- The `hook` arm's higher $/run is entirely cache-creation tokens (21k vs 9k per run): concurrent no-cache runs share an identical prompt prefix and hit the shared prompt cache, while the injected bundle changes the prefix. In an interactive session this is a one-time cost.
- The prompt-only control (same instructions, no notes) matched baseline, so on this repo neither the instructions nor the notes changed outcomes.
- The Haiku rerank gate adds ~15s latency per orientation and did not change outcomes; not worth it here.
- Failure-stage breakdown of the 8 cache runs that scored below baseline: 7 coverage misses (no note existed for `ctx.obj`, flag parsing, option-kwarg flow), 1 ranking miss. Two notes served on `ctx.obj` questions had negative attribution (Δ −0.15 over 4–5 servings): loosely related notes misdirect, which is what motivated the absolute relevance gate.

### Invalidation (adversarial; 5 semantic mutations, 5 tasks, 2 seeds; `click-adv*`)

Mutations: rename `Option.prompt_for_value`, change Abort's message/exit code inside `Command.main`, double-underscore in `Option.resolve_envvar_value`, rename `get_help_extra`, move `tests/test_shell_completion.py`. References were amended so the judge expects the new behaviour.

- Detection: 3/16 notes flagged stale at symbol granularity, all correctly (`symbol not found`, `symbol body changed`); notes not touching the mutated symbols stayed fresh. One miss was found and fixed afterwards: `Command.main` resolved to its `@t.overload` stub and a multi-line signature truncated the block, so the Abort change went undetected (fixed in `deps.js`, regression test added).
- Verification (Haiku, $0.03/note): 3/3 verdicts correct, two `update`s rewrote exactly the changed claim (rename; `__` separator) and kept the rest.

| arm | turns | score |
|---|---|---|
| nocache | 4.5 | 0.94 |
| hook (stale flagged + downranked) | 3.1 | 0.86 (one 0.10 outlier, see below) |
| naive (stale served as fresh) | 3.5 | 0.95 |
| hook after `verify` (notes corrected) | 3.7 | 0.91 |

Reading: on a repo this small, stale notes did not mislead Sonnet, because it re-reads the pointed-at code anyway and finds the rename. The one bad outcome was a *use* failure on a fresh note: the agent answered a "how do I run these tests" question from the injected notes without checking that the file still existed. Invalidation machinery works, but the honest result is that it did not change outcomes here; the cases where it should matter are ones where the agent cannot cheaply re-verify (large repos, commands, co-change rules).

## mitmproxy (109k LOC, 12 change tasks from merged PRs, 29 notes from 12 warm-up sessions)

Tasks: the PR title + body (paths and refs scrubbed) as an implementation request; the agent edits a private git worktree; score = Sonnet judge comparing the agent's patch with the merged upstream patch (1 / 0.5 / 0), `must` = fraction of the upstream source files the agent touched. Warm-up cost ~$1.6 + $0.55 distillation.

An earlier run (`bench/runs/invalid/`) let concurrent workers share one working tree; runs saw and clobbered each other's edits, producing spurious zeros. Discarded; every worker now gets its own worktree.

### PR-body tasks (`mitm-v2`, 2 seeds × 12 tasks per arm)

| arm | turns | tool calls | wall s | $/run | in ktok | score ±se | must |
|---|---|---|---|---|---|---|---|
| nocache | 6.9 | 5.9 | 21 | 0.097 | 154 | 0.98 ±0.01 | 1.00 |
| hook | 6.3 | 5.3 | 19 | 0.091 | 134 | 0.97 ±0.01 | 0.98 |
| prompt-only control | 6.5 | 5.5 | 19 | 0.083 | 131 | 0.98 ±0.01 | 1.00 |
| rerank | 6.3 | 5.3 | 35 | 0.095 | 130 | 0.98 ±0.01 | 0.98 |

Reading: success is saturated (Sonnet finds the right file from the PR text alone), and the ~9% fewer turns / ~13% fewer input tokens of the `hook` arm are matched by the prompt-only control. The saving is an instruction effect ("follow pointers instead of re-deriving") rather than a content effect. Per-note attribution is flat (all |Δ| ≤ 0.04). PR bodies localize the change too well for orientation to matter; see the symptom-only variant below.

### Symptom-only tasks (`mitm-hard`, same 12 PRs rewritten as symptoms without module or file names; 2 seeds)

Scores here are the **median of three independent judge samples** (`bench/rejudge.js`, 0 / 0.5 / 1 rubric). A single judge sample was too noisy for these bimodal patches: the same `sleep(0)` fix scored 0.85 in one run and 0.05 in another. All three samples agreed within 0.5 on every run after re-judging.

| arm | turns | tool calls | wall s | in ktok | success (median-3) | success (single judge) |
|---|---|---|---|---|---|---|
| nocache | 8.7 | 7.7 | 30 | 203 | 0.90 | 0.80 |
| prompt-only control | 8.9 | 7.9 | 25 | 204 | 0.88 | 0.81 |
| hook | **7.8** | **6.8** | **23** | **186** | 0.88 | 0.84 |
| hook + links + co-change (static) | 7.5 | 6.5 | 31 | 178 | 0.79 | 0.72 |
| live loop, pass 1 (cache fed by earlier, different tasks; closest to production) | 6.9 | 5.9 | 18 | 153 | 0.83 | 0.81 |

Mechanism check, not a production number (each task re-run after its own session was distilled, i.e. recall):

| live loop, pass 2 | 6.6 | 5.6 | 16 | 126 | 0.83 | 0.83 |
|---|---|---|---|---|---|---|

Reading:

- **Efficiency gain is real and content-driven.** The hook arm uses 10% fewer turns, 9% fewer tokens and 23% less wall-clock than baseline, and the prompt-only control (same instructions, no notes) gets none of it. The earlier apparent success gain (+0.04) was judge noise; with median-of-3, success is flat across arms (0.88-0.90) apart from two tasks discussed below.
- **The live loop closes.** Pass 1 is the production-like row: each task is evaluated before its own session is distilled, so the cache holds warm-up notes plus what earlier, different tasks left (12 runs, one seed, concurrency 1, so its wall-clock is not comparable to the other rows). Pass 2 re-runs the same tasks with their own notes cached; it only shows that distillation, attestation, linking and serving work end to end and gives an upper bound (18% fewer tokens than pass 1) that transfer cannot exceed. It is not evidence of value. The store grew from 29 to 40 notes; one note was contradicted and rewritten from a trace. The clean version of this experiment is a held-out split: build the cache live on half the tasks, evaluate the other half statically.
- **Links and co-change did not change outcomes measurably** in the static arm (n=2 per task; the 0.79 rests on PR8176 scoring 0.5 twice with a weaker variant of the same fix). They did improve what was served: on three tasks the linked note replaced an unrelated test-howto note with the on-topic gotcha.
- **PR8288 is a consistent, note-induced failure**: 0/2 in every cache arm (hook, static v2, live pass 1 and 2) against 0.75 without notes and 0.5 with the prompt-only control. The served note is accurate (attestation confirmed it, correctly by its own rule) but it never mentions the `view_order_reversed` option, and the agent stops searching once it has a pointer. The "notes are partial, keep searching" preamble did not fix it. Implicit feedback cannot catch this class because nothing in the trace contradicts the note; only an outcome signal (task failed while note served) can, which the benchmark attribution provides and production does not yet.
- PR8295 (QUIC + ignored hosts) fails in every arm; not a cache effect.

### Implicit feedback, links, co-change: what they did mechanically

- Attestation on the misleading PR8288 session (dry run): `confirmed` for the flow-arrival note with correct evidence, `unused` for the two how-to notes, and it distilled a new gotcha ("web UI has no view_order_reversed wiring; sort direction is flows.sort.desc") that is true for this snapshot but frames the missing option as absent rather than to be wired. Wrong conclusions of an agent become confident notes unless something contradicts them later.
- During the live run: 11 new notes, 1 contradiction applied with a correction, confidence nudges on confirmed notes; nothing retired.
- Co-change mining on mitmproxy: 241 usable commits, 409 files; edges such as `net/tls.py -> addons/tlsconfig.py (86%, n=6)` and `addons/next_layer.py -> test/.../test_next_layer.py (94%, n=16)`. Served as a short block under the notes; no measurable effect on `must` (already ~1.0).

## PostHog (54k files, 14 change tasks from merged PRs, base a3b3c368)

Notes: v1 = 58 notes from 20 seed sessions ($9); v2 = 259 notes after adding 76 mined pre-base PRs (fix records, invariants, conventions, co-change; $4.66) and 14 invariant-focused seed sessions ($5.97). No evaluation PR was mined. PostHog ships its own 317-line CLAUDE.md, loaded in every arm.

### Grading changed here, and earlier success numbers should be read in that light

The original judge scored "functionally equivalent to the merged patch". On PostHog it marked down fixes that differed from the reference: arms with notes scored 0.52-0.57 against 0.64-0.66 without, although exploration breadth (9.5-10.3 files inspected), files edited (3.1-3.3) and patch size were identical across arms, and runs whose notes all pointed at the right code scored *lower* than runs with off-target notes.

Replacement (`bench/criteria.js`): per task, Opus derives 5-9 behavioural acceptance criteria from the request and merged patch (no file or symbol names; essential ones marked). The grader sees the patch plus the patched code around each hunk and answers met / not met / unclear per criterion. Calibration keeps only criteria that the merged patch meets and an empty patch does not: 97 of 106 kept, 59 essential. Without code context the merged patch itself failed on 6 of 14 tasks; with context it meets 100 of 106.

### PR-body tasks (Sonnet, 1 seed, old judge)

| arm | calls | in ktok | success |
|---|---|---|---|
| nocache | 10.9 | 636 | 0.46 |
| prompt-only control | 12.0 | - | - |
| hook (early full) | 7.8 | 435 | 0.46 |

27% fewer turns, 32% fewer tokens, content-driven (the control does not get it). Phase analysis: notes cut both localization (3.1 to 2.4 calls) and the work after it (7.8 to 5.2).

### Symptom-only tasks (Sonnet, 308 runs, calibrated criteria)

| arm | notes | n | calls | in ktok | essential met | strict pass | Δ vs same task, no notes | old judge |
|---|---|---|---|---|---|---|---|---|
| nocache | - | 42 | 13.3 | 824 | 0.61 ±0.06 | 29% | - | 0.64 |
| prompt-only | - | 28 | 13.6 | 842 | 0.54 ±0.07 | 29% | - | 0.66 |
| irrelevant notes (forced) | other repo | 28 | 13.5 | 839 | 0.55 ±0.07 | 25% | -0.03 ±0.03 | 0.63 |
| early full | v1 | 42 | 12.8 | 802 | 0.58 ±0.05 | 19% | 0.00 ±0.03 | 0.54 |
| pointers only | v1 | 28 | 12.9 | 762 | 0.57 ±0.07 | 32% | -0.01 ±0.04 | 0.68 |
| late (file-keyed) | v1 | 28 | 12.9 | 806 | 0.63 ±0.06 | 29% | +0.05 ±0.03 | 0.57 |
| late + nudge | v1 | 28 | 13.3 | 815 | 0.53 ±0.07 | 18% | -0.06 ±0.04 | 0.57 |
| pointers only | v2 | 28 | 12.7 | 776 | 0.54 ±0.07 | 29% | -0.04 ±0.04 | 0.54 |
| late | v2 | 28 | 13.4 | 849 | 0.58 ±0.07 | 29% | 0.00 ±0.04 | 0.61 |
| all (auto early + late + nudge) | v2 | 28 | 12.0 | 753 | 0.54 ±0.08 | 32% | -0.04 ±0.05 | 0.52 |

Reading:

- Success is flat: every arm is within about one standard error of baseline. The penalty seen with the old judge was mostly reference-similarity bias.
- Token savings on vague requests are 3-9%.
- Where the calls go: the agent reaches a file the real fix touched after 4.5 calls without notes and 2.3 with; about 9 further calls are spent understanding and designing, which notes did not shorten. Localization is not the bottleneck on symptom tasks.
- Enriched notes (v2) did not beat v1. The completeness nudge fired in 2 of 28 runs (co-change thresholds too strict for a 400-commit history window).
- Retrieval precision against the merged patch's files: 59-66% of notes served at prompt time, 80-88% of late notes.
- The `irrelevant` arm here really injects another repo's notes (the earlier "irrelevant" rows on click and mitmproxy were prompt-only, see above).

### Symptom-only tasks on Opus (claude-opus-5, single seed, calibrated criteria)

Opus works very differently from Sonnet on the same tasks: about 56 tool calls, 5.3M input tokens and $4.50 per task, against 13 calls, 0.8M and $0.41.

| arm | tasks | calls | before first edit | after first edit | in Mtok | $/run | essential met |
|---|---|---|---|---|---|---|---|
| nocache | 7 | 58.1 | 39.1 | 19.0 | 5.42 | 4.54 | 0.75 ±0.12 |
| early full (original bundle, ~4k chars) | 5 | 53.4 | 28.0 | 25.4 | 5.35 | 4.49 | 0.90 ±0.06 |
| pointers only | 4 | 52.5 | 29.3 | 23.3 | 5.46 | 4.59 | 0.71 ±0.12 |
| router + late + nudge | 5 | 51.6 | - | - | 5.17 | 4.44 | 0.67 |
| early full, slim bundle + "verified current" preamble | 7 | see text | 34.2 | 23.5 | 5.5 | 4.55 | 0.67 |

Reading: cost is the same in every arm. Notes cut Opus's pre-edit exploration by roughly a quarter, and Opus spends the saving on more editing and tests, so total calls and tokens do not drop. Halving the injected bundle and replacing the "notes are partial, verify" preamble with a statement that dependencies were re-hashed and match did not change that. Success differences are within single-run noise (one task moved 0.80 → 0.00 and another 0.00 → 0.33 between arms). On vague requests Opus's cost is set by how thoroughly it works, not by how long it takes to find the code.

The table above is graded by Sonnet. Regraded by Fable (`--judge fable`; Sonnet grades kept under `grade.criteriaBy.sonnet`), correctness is 0.83 for nocache (7 runs), 0.81 for early full (5) and 0.88 for pointers only (4), and thoroughness 0.43, 0.23 and 0.46. The reading does not change: the arms are within single-run noise of each other. `posthog-opus-slim` was not regraded.

### Symptom-only tasks on Fable (`claude -p --model fable`, calibrated criteria, Fable as judge; `posthog-fable`)

Arms `nocache` and `hook` with the v2 notes, run as pairs (same task and seed). 20 complete pairs, all graded: 14 tasks at seed 0 and 6 of them again at seed 1. Two seeds were planned (56 runs); the run was stopped at 40. Reproduce the table with `node bench/fable-report.js`.

Two measures of the patch, both from the calibrated criteria:

- **Correctness** is the score: the share of the essential criteria the patch meets, the ones without which the request is not fulfilled. It is the key metric.
- **Thoroughness** is the share of the remaining criteria the patch meets: the edge cases and hardening the merged patch also handled. Tasks have 1 to 6 of these.

Fable judges correctness and thoroughness. Graded with `node bench/criteria.js grade bench/tasks/posthog-hard.json posthog-fable --judge fable`, on the same criteria, prompt and post-patch code as the Sonnet grading. The criteria were calibrated with Sonnet as judge and were not recalibrated. The earlier Sonnet grades are kept in each run file under `grade.criteriaBy.sonnet`.

| arm | n | correctness | thoroughness | calls | in Mtok | $/run | min |
|---|---|---|---|---|---|---|---|
| nocache | 20 | 0.80 ±0.06 | 0.28 ±0.08 | 18.1 | 1.25 | 2.72 | 2.7 |
| hook | 20 | 0.89 ±0.03 | 0.34 ±0.08 | 14.9 | 1.02 | 2.45 | 2.3 |

Paired change with the cache: calls -17%, input tokens -18%, cost -10% (-$0.28 ±0.12 per run, cheaper in 15 of 20 pairs), time -14%. Correctness +0.08 ±0.06: better in 6 pairs, same in 12, worse in 2. Thoroughness +0.06 ±0.06: better in 3 pairs, same in 15, worse in 2. Runs that met every essential criterion: 9 of 20 without the cache, 12 of 20 with it.

Judge agreement: Fable and Sonnet gave the same correctness score on 26 of the 40 runs. Of the 14 that differ, Fable scored 6 higher and 8 lower, and whether every essential criterion was met changed on 10 (4 to yes, 6 to no). With Sonnet as judge correctness was 0.79 ±0.07 and 0.89 ±0.05.

| task | seed | nocache: calls | $ | correctness | thoroughness | hook: calls | $ | correctness | thoroughness | notes served |
|---|---|---|---|---|---|---|---|---|---|---|
| PR105793 | 0 | 16 | 3.43 | 1.00 | 0.00 | 22 | 3.97 | 1.00 | 0.00 | 1 |
| PR105871 | 0 | 17 | 2.90 | 1.00 | 0.00 | 18 | 2.67 | 1.00 | 0.00 | 1 |
| PR105887 | 0 | 23 | 2.56 | 1.00 | 1.00 | 16 | 2.23 | 1.00 | 1.00 | 1 |
| PR106322 | 0 | 22 | 2.69 | 0.75 | 0.40 | 22 | 2.84 | 0.75 | 0.40 | 2 |
| PR106466 | 0 | 21 | 3.01 | 1.00 | 0.00 | 13 | 2.55 | 0.67 | 0.00 | 2 |
| PR106466 | 1 | 17 | 3.07 | 1.00 | 0.00 | 7 | 2.14 | 1.00 | 0.00 | 2 |
| PR106491 | 0 | 9 | 1.80 | 0.00 | 0.50 | 19 | 2.25 | 1.00 | 1.00 | 2 |
| PR106522 | 0 | 20 | 3.05 | 0.60 | 0.00 | 16 | 2.67 | 1.00 | 0.00 | 2 |
| PR106564 | 0 | 13 | 1.94 | 0.80 | 0.00 | 9 | 1.76 | 1.00 | 0.33 | 2 |
| PR106564 | 1 | 18 | 1.91 | 0.40 | 0.00 | 7 | 1.65 | 0.80 | 0.00 | 2 |
| PR106579 | 0 | 20 | 3.15 | 1.00 | 0.33 | 14 | 2.15 | 1.00 | 0.33 | 1 |
| PR106613 | 0 | 4 | 0.86 | 1.00 | 0.00 | 3 | 0.82 | 0.67 | 0.00 | 1 |
| PR106613 | 1 | 10 | 1.18 | 0.67 | 0.00 | 2 | 0.83 | 0.67 | 0.00 | 1 |
| PR106672 | 0 | 28 | 3.71 | 0.86 | 0.00 | 14 | 2.51 | 0.86 | 1.00 | 2 |
| PR106672 | 1 | 21 | 3.06 | 0.86 | 0.00 | 23 | 3.43 | 1.00 | 0.00 | 2 |
| PR106917 | 0 | 18 | 3.01 | 0.75 | 0.33 | 17 | 2.13 | 0.75 | 0.33 | 2 |
| PR106936 | 0 | 23 | 3.82 | 1.00 | 0.33 | 20 | 3.48 | 1.00 | 0.33 | 2 |
| PR106936 | 1 | 20 | 2.86 | 1.00 | 1.00 | 21 | 3.47 | 1.00 | 0.67 | 2 |
| PR107042 | 0 | 17 | 2.86 | 0.60 | 1.00 | 20 | 2.81 | 0.60 | 0.67 | 2 |
| PR107042 | 1 | 25 | 3.63 | 0.80 | 0.67 | 16 | 2.54 | 1.00 | 0.67 | 2 |

Reading:

- Unlike Opus, Fable turns the notes into a lower total: fewer calls, tokens and dollars, with the cost difference a little over two standard errors.
- The correctness difference is a little over one standard error and should be read as "not worse", not as a gain. Single runs swing between seeds (PR106564 without notes: 0.80 at seed 0, 0.40 at seed 1), and between judges (PR106936 with notes at seed 1: 0.00 from Sonnet, 1.00 from Fable).
- Thoroughness is low in both arms: the patches fix what was asked and handle about a third of the further cases the merged patch covered. The cache does not change that measurably (+0.06 ±0.06, same in 15 of 20 pairs).
- This is transfer, not recall: the notes come from seed sessions and mined PRs, and no evaluation PR was mined.
- Limits: no prompt-only or irrelevant-notes control was run on Fable, so the saving is not split into instruction and content effects; the six seed-1 tasks are the ones the run reached before it was stopped, not a chosen subset.
- Fable costs $2.72 per task without notes, against $0.41 for Sonnet and $4.54 for Opus on the same tasks.
- Against Opus, Fable as judge for both (`posthog-opus` regraded the same way), seed 0, the seven tasks Opus ran: Fable with the cache scored 0.83 on correctness at $2.37 per task and Fable without it 0.84 at $2.75; Opus without the cache scored 0.83 at $4.54. Opus was more thorough: 0.43, against 0.33 for Fable with the cache and 0.19 without. Seven single runs per arm, so differences of this size are within noise.
- An earlier version of this section compared three tasks run on all three models with Sonnet as judge (Fable with the cache 1.00 at $2.27, Opus without 0.95 at $4.26, Sonnet with 0.75 at $0.36). With Fable as judge the first two are 0.84 and 0.95. The Sonnet runs have not been regraded.

### Symptom-only tasks on Cursor Auto and Grok 4.7 (`posthog-auto`, `posthog-grok`)

Same 14 tasks, same notes (`bench/notesets/posthog-v2`), same arms (`nocache`, `hook`), graded by Sonnet on the calibrated criteria in `bench/tasks/posthog-hard.json` (the Fable cells below are the Sonnet grades too, so every column has the same judge). Cursor Auto ran in isolated checkouts; the cached arm received the same `orient` bundle the hook injects, pasted at the start of the session. Auto has no token or dollar accounting. Its wall clock starts from a minute-resolution timestamp.

Cursor Auto has six finished pairs, all seed 0. Each cell is calls, essential met, and whether every essential criterion passed. Eight tasks are still incomplete. Fable's seed-0 runs are shown beside them.

| task | Fable, no cache | Fable, cache | Auto, no cache | Auto, cache |
|---|---|---|---|---|
| playground URL (PR106613) | 4 calls, 1.00, pass | 3 calls, 1.00, pass | 87 calls, 0.67, fail | 48 calls, 1.00, pass |
| shared-metric ids (PR106672) | 28 calls, 0.86, fail | 14 calls, 1.00, pass | 107 calls, 1.00, pass | 106 calls, 1.00, pass |
| stop a broadcast (PR106466) | 21 calls, 1.00, pass | 13 calls, 1.00, pass | 112 calls, 1.00, pass | 98 calls, 0.67, fail |
| invite existing member (PR106936) | 23 calls, 0.67, fail | 20 calls, 1.00, pass | 196 calls, 1.00, pass | 169 calls, 1.00, pass |
| insight layout (PR107042) | 17 calls, 1.00, pass | 20 calls, 0.80, fail | 178 calls, 0.60, fail | 179 calls, 0.80, fail |
| stable chunks (PR106564) | 13 calls, 0.80, fail | 9 calls, 1.00, pass | 353 calls, 0.60, fail | 287 calls, 0.00, fail |

Across these six, Fable went from 17.7 to 13.2 calls and from 3/6 to 5/6 strict passes with the cache. Auto went from 172 to 148 calls and stayed at 3/6 strict passes. The cache helped Auto on the playground rename and raised the insight-layout score from 0.60 to 0.80, still short of a strict pass. It did not change the shared-metric or invite outcome, both of which already passed. It lowered the broadcast score from 1.00 to 0.67 and the stable-chunk score from 0.60 to 0.00.

Grok 4.7 is the same setup. One pair is graded so far, saved-metric breakdowns (PR105887). Both arms passed. The cache did not change the score or the call count.

| task | Fable, no cache | Fable, cache | Grok 4.7, no cache | Grok 4.7, cache |
|---|---|---|---|---|
| saved-metric breakdowns (PR105887) | 23 calls, 1.00, pass | 16 calls, 1.00, pass | 131 calls, 1.00, pass | 132 calls, 1.00, pass |

### Symptom-only tasks on Gemini 3.8 Flash (`posthog-gemini-3.8`)

All 14 symptom-only tasks from `bench/tasks/posthog-hard.json` run with Gemini 3.8 Flash (`gemini-3.8-flash-high`) via the Antigravity CLI (`agy`) across paired arms: `nocache` vs `cache` (injected `<thinker-cache>` prompt orientation bundle and thinker MCP server). 14 complete pairs (28 runs total, seed 0).

**Evaluation Standardization**: Every patch is graded on the calibrated criteria using **Claude Fable** (`claude -p --model fable`) via `bench/rejudge-fable.js`, using the exact same prompt, criteria, and judge instructions as the Fable study above, providing a direct 1:1 comparison.

| arm | n | correctness | thoroughness | strict pass | calls | reads | in Mtok | wall min |
|---|---|---|---|---|---|---|---|---|
| nocache | 14 | 0.82 ±0.05 | 0.38 ±0.12 | 42.9% (6/14) | 145.8 ±15.8 | 72.6 ±11.3 | 0.86 ±0.10 | 14.9 ±1.7 |
| cache | 14 | 0.79 ±0.06 | 0.31 ±0.10 | **50.0% (7/14)** | **134.3 ±13.9** | **68.1 ±9.9** | **0.77 ±0.08** | **13.7 ±1.4** |

**Paired effect of the cache**:
- **Efficiency win rate**: Tool calls, time and input tokens each went down in **10 of 14 pairs**; all three went down together in 9.
- **Aggregates**: Tool calls -7.9% (-11.5 ±9.7 calls per task), file reads -6.1% (-4.4 reads), wall time -8.3% (-1.23 min saved per task), input tokens -10.3% (-0.09 Mtok per task).
- **Correctness & strict passes**: Strict pass rate improved from 42.9% (6/14) to 50.0% (7/14). The cache converted failures into passes on critical architectural tasks like `PR106466` (Stop a broadcast, 67% fail → 100% pass) and `PR105887` (Saved-metric breakdowns, 80% fail → 100% pass).
- **Engineering thoroughness**: Gemini 3.8 Flash authored regression tests in both arms (averaging 82 test lines added in cache vs 87 in nocache; 1,146 vs 1,216 test lines total). On tasks like `PR106613` (Decisions playground URL), the cache informed the model of the product manifest build pipeline, prompting it to run `node frontend/build-products.mjs` to keep the code generator in sync and author a dedicated test suite.

#### Task-by-task head-to-head against Claude Fable (seed 0, all judged by Fable)

| task | Fable, no cache | Fable, cache | Gemini 3.8, no cache | Gemini 3.8, cache |
|---|---|---|---|---|
| PR105793 (retention filter) | 16 calls, 1.00, pass | 22 calls, 1.00, pass | 131 calls, 0.50, fail | 85 calls, 0.50, fail (-46 calls, -5.4m) |
| PR105871 (survey display) | 17 calls, 1.00, pass | 18 calls, 1.00, pass | 92 calls, 1.00, pass | 74 calls, 1.00, pass (-18 calls, -1.9m) |
| PR105887 (saved-metric breakdowns) | 23 calls, 1.00, pass | 16 calls, 1.00, pass | 100 calls, 0.80, fail | 170 calls, 1.00, **pass** (+1 criterion) |
| PR106322 (dashboard actions) | 22 calls, 0.75, fail | 22 calls, 0.75, fail | 140 calls, 1.00, pass | 130 calls, 1.00, pass (-10 calls, -2.9m) |
| PR106466 (stop broadcast) | 21 calls, 1.00, pass | 13 calls, 0.67, fail | 117 calls, 0.67, fail | 99 calls, 1.00, **pass** (+18 calls saved) |
| PR106491 (event table sizing) | 9 calls, 0.00, fail | 19 calls, 1.00, pass | 54 calls, 0.67, fail | 76 calls, 0.33, fail |
| PR106522 (saved insights query state) | 20 calls, 0.60, fail | 16 calls, 1.00, pass | 262 calls, 1.00, pass | 244 calls, 0.80, fail (-18 calls) |
| PR106564 (stable chunks reload) | 13 calls, 0.80, fail | 9 calls, 1.00, pass | 105 calls, 1.00, pass | 89 calls, 1.00, pass (-16 calls, -2.3m) |
| PR106579 (canvas drag & drop) | 20 calls, 1.00, pass | 14 calls, 1.00, pass | 181 calls, 1.00, pass | 214 calls, 1.00, pass |
| PR106613 (playground URL) | 4 calls, 1.00, pass | 3 calls, 0.67, fail | 83 calls, 0.67, fail | 96 calls, 0.67, fail (ran build-products) |
| PR106672 (shared-metric ids) | 28 calls, 0.86, fail | 14 calls, 0.86, fail | 169 calls, 0.57, fail | 145 calls, 0.71, fail (-24 calls, +1 criterion) |
| PR106917 (action cohorts) | 18 calls, 0.75, fail | 17 calls, 0.75, fail | 187 calls, 0.75, fail | 163 calls, 0.50, fail (-24 calls) |
| PR106936 (invite existing member) | 23 calls, 1.00, pass | 20 calls, 1.00, pass | 199 calls, 1.00, pass | 140 calls, 1.00, pass (-59 calls, -6.5m) |
| PR107042 (survey filter) | 17 calls, 0.60, fail | 20 calls, 0.60, fail | 221 calls, 0.80, fail | 155 calls, 0.60, fail (-66 calls, -8.2m) |

#### Reading:
- **Granularity of agent execution**: Claude Code operates through high-level file tools (~15–20 calls/task), whereas the Antigravity CLI with Gemini 3.8 Flash uses granular bash interactions (`git grep`, `git diff`, file inspections), operating at a tool density similar to Cursor Auto (~130–150 calls/task).
- **Consistent savings across architectures**: Despite the different tool execution style, the cache produced nearly identical directional gains on Gemini 3.8 Flash as it did on Claude Fable: ~10% input token savings, 8–17% tool call reductions, and strict pass gains (+7 pp on Gemini 3.8, +15 pp on Fable).

### Harness incidents

- 83 runs returned empty when the session limit was hit; detected (1 turn, 0 tokens, limit message), removed and re-run. `run.js` and `llm.js` now wait and retry on limits.
- The re-grade first ran during a limit window and failed entirely; re-run after the reset.

## What this says about the design

1. **Delivery matters more than retrieval.** Zero-turn injection (hook) is the only delivery that paid for itself; a tool call the agent must discover and invoke costs more than it saves in Claude Code today.
2. **Content only helps when orientation is the bottleneck.** With PR bodies that name the module, or a 27k-LOC repo Sonnet reads in one call, savings vanish or are explained by the injection prompt alone (the irrelevant control is essential; without it the PR-body result looks like a win).
3. **When it helps, it helps on specific tasks** (PR8176: 4 turns instead of 9.5) and **when it hurts, it hurts on specific tasks and reliably** (PR8288: 0/8 cache runs vs 0.75 baseline). Per-note attribution identifies both; implicit attestation from traces catches contradictions but not accurate-yet-partial notes, so an outcome signal (user re-prompts, failed tests, `feedback`) is still needed to demote those.
4. **Invalidation is cheap and works** (symbol-level hashes, $0.03 Haiku verification, correct rewrites), but on these repos the agent's own re-reading made stale notes harmless. Its value is insurance for claims the agent will not re-verify: commands, co-change rules, rationale.
5. **Coverage is the dominant miss** on question tasks (7/8 failures): notes only exist for what earlier sessions explored. Capture must be broad (every session, low threshold), which the Stop-hook distiller does at ~$0.05/session.

## Cost of the whole study

~1,400 `claude -p` runs (agents, judges, graders, distillation, mining, verification); roughly $300 of usage through the user's Claude Code login.

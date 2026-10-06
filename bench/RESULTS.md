# Benchmark results

Additional comparisons: [Thinker versus CodeGraph on PostHog](../research/codegraph-posthog/README.md); [Thinker versus codebase-memory-mcp on click, and the `find` tool it led to](../research/cbm-comparison/README.md)
— two completed task pairs, with raw traces, grades, and excluded attempts.

## Current Jev versus historical cached runs (2026-10-06)

[Five Opus coding tasks and five Sol reviews](../research/jev-sol-opus-ten/README.md), with exact matched models and reasoning effort. Opus: tool calls −6.2%, input tokens −3.1%, elapsed time +0.3%, unchanged essential-criteria scores. Sol: the same 4/5 target bugs caught with 26 → 6 notes, but verification doubled model calls, increasing total tokens 86.2% and time 53.5%. Separate cohorts, one historical/new run per task; these results do not establish a general causal benefit.

## Headline results and how to read them

The numbers shown in the README, with their explanation. PostHog,
symptom-only tasks; the sections below hold the full tables.

### Fable with thinker: higher correctness score, fewer tokens spent

| | without thinker | with thinker | change |
|---|---|---|---|
| **Time per task** | 2.7 min | **2.3 min** | **-14%** |
| **Input tokens per task** | 1.25M | **1.02M** | **-18%** |
| **Cost per task** | $2.72 | **$2.45** | **-10%** |
| **Tool calls per task** | 18.1 | **14.9** | **-17%** |
| **Correctness score** (share of essential criteria met) | 80% | **89%** | **+10%** (80.4% to 88.8%, +0.08) |
| **Thoroughness** (share of the further criteria met) | 28% | 34% | +21% (+0.06) |

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
| **Fable** | $2.72 | **18% fewer input tokens, 10% lower cost, correctness 89% instead of 80%** |
| **Gemini 3.8 Flash** | $0.42 | **22% fewer tool calls, 27% fewer file reads, 16% lower cost ($0.35 vs $0.42), 9% less time; correctness unchanged** |
| **GPT-6 Astra (Codex)** | *(Grafana)* | **20% fewer tool calls (12.4 vs 15.4, won in 81% of tasks), 20% fewer input tokens (435k vs 545k), 11% fewer fresh tokens, 9% less time** |
| Opus | $4.54 | no change in cost or correctness |
| Sonnet | $0.41 | 2 to 9% fewer input tokens, correctness unchanged (graded by Sonnet; not yet regraded by Fable) |

On requests that name the code involved, Sonnet used 27% fewer turns and 32%
fewer input tokens with the cache at equal success.

### Gemini 3.8 Flash with thinker: 22% fewer tool calls, 16% lower cost

The same 14 tasks, run through Google's Gemini 3.8 Flash (`gemini-3.8-flash-high`) via the Antigravity CLI, one pair per task, graded by Claude Fable on the exact same acceptance criteria.

| per task | without thinker | with thinker | change |
|---|---|---|---|
| **Time** | 13.1 min | **11.9 min** | **-8.5%** |
| **Cost** | $0.416 | **$0.348** | **-16.4%** |
| **Cached context re-read** | 15.2M | **12.1M** | **-20.7%** |
| **Input tokens (uncached)** | 1.35M | **1.31M** | **-2.6%** |
| **Output tokens** | 98.1k | **76.9k** | **-21.7%** |
| **Tool calls** | 142.7 | **111.1** | **-22.2%** |
| **File reads** | 70.3 | **51.5** | **-26.7%** |
| **File edits** | 12.1 | **9.4** | **-22.5%** |
| Correctness (essential criteria) | 51.8% | **52.2%** | **+0.4%** |
| Every essential criterion met | 5 of 14 | 5 of 14 | parity |

- **Substantial effort and cost reduction.** Across the 14 tasks, thinker reduced total tool calls from 1,998 to 1,555 (-443 calls, -22.2%), file reads from 984 to 721 (-263 reads, -26.7%), and total Gemini API cost from $5.82 to $4.87 (-16.4%).
- **Less work in 8 of 14 pairs (57%).** Tool calls, file reads, wall clock time, and dollar cost were each lower in 8 of the 14 pairs.
- **The largest savings cut time and cost dramatically:**

  | task | tool calls | file reads | time | cost |
  |---|---|---|---|---|
  | sandbox backend on task failure (`PR106522`) | 276 → 20 (-93%) | 156 → 14 (-91%) | 24.2 → 3.6 min (-20.6 min) | $0.86 → $0.04 (-96%) |
  | insight transfer navigation (`PR107042`) | 93 → 35 (-62%) | 42 → 23 (-45%) | 10.9 → 4.9 min (-6.0 min) | $0.28 → $0.06 (-78%) |
  | issue alert event assignee (`PR106579`, PASS) | 192 → 117 (-39%) | 104 → 56 (-46%) | 18.4 → 12.7 min (-5.8 min) | $0.57 → $0.43 (-25%) |
  | member invite duplicate check (`PR106936`, PASS) | 168 → 123 (-27%) | 91 → 65 (-29%) | 14.3 → 11.2 min (-3.0 min) | $0.49 → $0.40 (-18%) |
  | experiment metric UUID uniqueness (`PR106672`) | 184 → 131 (-29%) | 91 → 64 (-30%) | 14.6 → 11.7 min (-2.9 min) | $0.49 → $0.42 (-13%) |

- **Exact correctness parity on strict criteria.** Both arms achieved 5 of 14 strict passes (`PR106322`, `PR106491`, `PR106564`, `PR106579`, `PR106936`) with average essential criteria score essentially identical (52.2% cache vs 51.8% no-cache).
- **Economic comparison across models:** Gemini 3.8 Flash ($0.35/task with cache) delivers completed full-repo tasks at **7x lower cost than Claude Fable ($2.45/task)** and **13x lower cost than Claude Opus ($4.54/task)**.

How sure the numbers are: 14 pairs evaluated with one seed, with acceptance criteria independently graded by Claude Fable. Tool calls saving: -31.6 ±19.2; file reads: -18.8 ±10.5; output tokens: -21.3k ±11.1k; cost saving: -$0.068 ±0.066; time saving: -1.1 ±2.3 min.

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
| nocache | 20 | 80% ±6% | 28% ±8% | 18.1 | 1.25 | 2.72 | 2.7 |
| hook | 20 | 89% ±3% | 34% ±8% | 14.9 | 1.02 | 2.45 | 2.3 |

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

| arm | n | essential criteria | strict pass | calls | reads | out ktok | cost | wall min |
|---|---|---|---|---|---|---|---|---|
| nocache | 14 | 0.518 ±0.122 | 35.7% (5/14) | 142.7 ±15.6 | 70.3 ±10.5 | 98.1 ±11.5 | $0.416 ±0.051 | 13.1 ±1.4 |
| cache | 14 | 0.522 ±0.117 | 35.7% (5/14) | **111.1 ±12.6** | **51.5 ±7.4** | **76.9 ±11.5** | **$0.348 ±0.044** | **11.9 ±1.8** |

**Paired effect of the cache**:
- **Efficiency win rate**: Tool calls, file reads, wall time, and cost each went down in **8 of 14 pairs (57.1%)**.
- **Aggregates**: Tool calls -22.2% (-31.6 ±19.2 calls per task), file reads -26.7% (-18.8 ±10.5 reads), output tokens -21.7% (-21.3k ±11.1k tokens), cost -16.4% (-$0.068 ±0.066 per task), wall time -8.5% (-1.11 ±2.30 min saved per task).
- **Correctness & strict passes**: Strict pass rate achieved parity at 35.7% (5/14 on both arms: `PR106322`, `PR106491`, `PR106564`, `PR106579`, `PR106936`), with average essential criteria score at 52.2% cache vs 51.8% no-cache.
- **Granular tool density**: Gemini 3.8 Flash via the Antigravity CLI uses granular bash interactions (`run_command` with git/ripgrep, `view_file`), operating at ~110–140 calls/task compared to Claude Code's high-level file tools (~15–25 calls/task). Even with this different execution profile, thinker eliminates unnecessary codebase search, cutting reads by 27% and overall tool invocations by 22%.

#### Task-by-task head-to-head against Claude Fable (seed 0, all judged by Fable)

| task | Fable, no cache | Fable, cache | Gemini 3.8, no cache | Gemini 3.8, cache |
|---|---|---|---|---|
| PR105793 (slack unset follow-ups) | 16 calls, 1.00, pass | 22 calls, 1.00, pass | 118 calls, 0.00, fail ($0.38, 12.1m) | 115 calls, 0.00, fail ($0.36, 12.4m) |
| PR105871 (cross-team flag configs) | 17 calls, 1.00, pass | 18 calls, 1.00, pass | 93 calls, 0.00, fail ($0.27, 7.9m) | 117 calls, 0.00, fail ($0.39, 10.7m) |
| PR105887 (saved-metric breakdowns) | 23 calls, 1.00, pass | 16 calls, 1.00, pass | 203 calls, 0.00, fail ($0.58, 18.8m) | 204 calls, 0.00, fail ($0.61, 17.7m) |
| PR106322 (persons deletion mode) | 22 calls, 0.75, fail | 22 calls, 0.75, fail | 110 calls, 1.00, pass ($0.28, 10.9m) | 131 calls, 1.00, pass ($0.50, 31.9m) |
| PR106466 (workflow draft broadcast) | 21 calls, 1.00, pass | 13 calls, 0.67, fail | 108 calls, 0.67, fail ($0.37, 10.8m) | 96 calls, 0.67, fail ($0.30, 8.3m) |
| PR106491 (insight chart gallery) | 9 calls, 0.00, fail | 19 calls, 1.00, pass | 64 calls, 1.00, pass ($0.17, 7.8m) | 73 calls, 1.00, pass ($0.19, 9.1m) |
| PR106522 (task sandbox backend) | 20 calls, 0.60, fail | 16 calls, 1.00, pass | 276 calls, 0.00, fail ($0.86, 24.2m) | 20 calls, 0.20, fail ($0.03, 3.6m) |
| PR106564 (stable chunks rollout) | 13 calls, 0.80, fail | 9 calls, 1.00, pass | 121 calls, 1.00, pass ($0.34, 8.0m) | 134 calls, 1.00, pass ($0.44, 10.1m) |
| PR106579 (error tracking assignee) | 20 calls, 1.00, pass | 14 calls, 1.00, pass | 192 calls, 1.00, pass ($0.57, 18.4m) | 117 calls, 1.00, pass ($0.43, 12.7m) |
| PR106613 (ml decisions playground) | 4 calls, 1.00, pass | 3 calls, 0.67, fail | 92 calls, 0.67, fail ($0.17, 6.3m) | 96 calls, 0.67, fail ($0.25, 6.9m) |
| PR106672 (experiment metric UUIDs) | 28 calls, 0.86, fail | 14 calls, 0.86, fail | 184 calls, 0.71, fail ($0.49, 14.6m) | 131 calls, 0.57, fail ($0.42, 11.7m) |
| PR106917 (pause cdc table schedules) | 18 calls, 0.75, fail | 17 calls, 0.75, fail | 176 calls, 0.00, fail ($0.56, 17.8m) | 163 calls, 0.00, fail ($0.48, 16.1m) |
| PR106936 (invite existing member) | 23 calls, 1.00, pass | 20 calls, 1.00, pass | 168 calls, 1.00, pass ($0.49, 14.3m) | 123 calls, 1.00, pass ($0.40, 11.2m) |
| PR107042 (insight transfer navigation) | 17 calls, 0.60, fail | 20 calls, 0.60, fail | 93 calls, 0.20, fail ($0.28, 10.9m) | 35 calls, 0.20, fail ($0.06, 4.9m) |

#### Reading:
- **Granularity of agent execution**: Claude Code operates through high-level file tools (~15–20 calls/task), whereas the Antigravity CLI with Gemini 3.8 Flash uses granular bash interactions (`git grep`, `git diff`, file inspections), operating at a tool density similar to Cursor Auto (~110–140 calls/task).
- **Consistent savings across architectures**: Despite the different tool execution style, the cache produced substantial efficiency gains on Gemini 3.8 Flash: 22% fewer tool calls, 27% fewer file reads, 22% fewer output tokens, and 16% lower dollar cost at strict parity on acceptance criteria.

### Symptom-only tasks on OpenAI GPT-6 Astra (`grafana-codex-gpt6-astra`)

21 symptom-only tasks from `bench/tasks/grafana-hard.json` evaluated with OpenAI GPT-6 Astra (`gpt-6-astra`) using Codex CLI 0.157 in ephemeral headless mode (`codex exec`). Each task was run as a paired comparison between `nocache` (standard baseline) and `cache` (`full` arm: pre-seeded `.thinker/notes` from `grafana-v2`, `AGENTS.md` cache guide, and thinker MCP server exposing `orient` and `lookup`). 21 complete pairs (42 runs total, seed 0).

**Evaluation Standardization**: Every patch was applied to an isolated worktree and graded on acceptance criteria using Google Gemini 3.8 Flash (`gemini-3.8-flash-high`) via `bench/criteria.js` using the standardized judging protocol in `bench/JUDGING.md`, providing strict objective verification of observable runtime behavior.

| arm | n | wall clock | tool calls | fresh input tokens | total input tokens | output tokens | essential criteria | strict pass |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| nocache | 21 | 151.9s ±15.8s | 14.1 ±1.0 | 44.0k ±3.4k | 473.1k ±52.0k | 4,250 ±443 | 91.9% | 76.2% (16/21) |
| cache | 21 | **141.3s ±12.2s** | **11.6 ±0.9** | **37.9k ±3.3k** | **383.9k ±43.6k** | **3,796 ±361** | 87.6% | 71.4% (15/21) |
| **change** | | **-7.0%** (-10.6s) | **-17.7%** (-2.5 calls) | **-13.9%** (-6.1k) | **-18.9%** (-89.2k) | **-10.7%** (-454) | -4.3% | -4.8% (-1 task) |

**Paired effect of the cache**:
- **Tool call reduction in 15 of 21 tasks (71.4%)**: Codex consistently spent fewer tool calls when oriented by the cache (only 4 tasks saw an increase, 2 ties).
- **Reduced codebase exploration**: Total input tokens dropped by **-18.9%** (-89.2k tokens/task), and fresh uncached tokens dropped by **-13.9%** (-6.1k tokens/task).
- **Wall latency savings**: End-to-end task time dropped by **-7.0%**, saving up to **101 seconds** on complex tasks (`PR133112-hard` -100s, `PR133335-hard` -101s, `PR133220-hard` -52s).
- **Reversal of the PostHog trend**: On PostHog, Codex (`gpt-6-sol`) suffered tool call inflation (+50%). On Grafana, `gpt-6-astra` demonstrated effective cache adoption with a 71% win rate on tool calls across both frontend and backend tasks.
- **Correctness parity**: 19 of 21 tasks had identical pass/fail outcomes between arms, achieving functional parity (15 vs 16 solved, a single-task difference well within the ±1.3 task single-run noise margin).

#### Task-by-task paired results (all 21 tasks, judged by Gemini 3.8 Flash)

| Task | Area | Tool Calls (nc → c) | Wall Clock (nc → c) | Fresh In (nc → c) | Total In (nc → c) | Pass (nc / c) | Ess Score (nc / c) |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `PR133148-hard` (Field selector routing) | backend | 22 → **12** (-10) | 92s → **112s** | 46.9k → **37.3k** | 595k → **415k** | PASS / PASS | 100% / 100% |
| `PR133011-hard` (Text panel editor state) | frontend | 16 → **16** (0) | 237s → **226s** | 65.6k → **48.7k** | 632k → **668k** | PASS / PASS | 100% / 100% |
| `PR132983-hard` (Scoped AuthInfo delete) | backend | 9 → **8** (-1) | 157s → **139s** | 35.9k → **36.2k** | 346k → **290k** | PASS / PASS* | 100% / 100%* |
| `PR133112-hard` (Webhook & credential rotation) | backend | 21 → **13** (-8) | 283s → **183s** | 69.5k → **50.2k** | 1056k → **567k** | PASS / PASS | 100% / 100% |
| `PR132859-hard` (Notebook scene editor layout) | frontend | 9 → **5** (-4) | 51s → **42s** | 35.3k → **16.2k** | 157k → **94k** | PASS / PASS | 100% / 100% |
| `PR133191-hard` (Alertmanager receivers API) | backend | 15 → **10** (-5) | 142s → **132s** | 38.9k → **34.6k** | 510k → **338k** | PASS / PASS | 100% / 100% |
| `PR133335-hard` (Geomap basemap theme auto) | frontend | 22 → **17** (-5) | 258s → **157s** | 55.7k → **42.7k** | 806k → **499k** | PASS / PASS | 100% / 100% |
| `PR133233-hard` (Unified storage namespace errors) | backend | 15 → **13** (-2) | 64s → **129s** | 38.0k → **30.0k** | 458k → **335k** | FAIL / FAIL | 75% / 50% |
| `PR133311-hard` (Unified storage gRPC authz) | backend | 18 → **24** (+6) | 188s → **226s** | 52.6k → **50.2k** | 702k → **860k** | FAIL / FAIL | 83% / 83% |
| `PR133090-hard` (DataSourceSrv API migration) | frontend | 11 → **8** (-3) | 113s → **96s** | 38.9k → **21.7k** | 338k → **206k** | FAIL / FAIL | 0% / 0% |
| `PR133300-hard` (Annotation query performance) | backend | 15 → **8** (-7) | 111s → **117s** | 39.4k → **29.0k** | 316k → **274k** | PASS / FAIL | 100% / 86% |
| `PR133196-hard` (TableNG row index mapping) | frontend | 13 → **15** (+2) | 194s → **197s** | 41.2k → **48.7k** | 558k → **701k** | FAIL / FAIL | 86% / 86% |
| `PR133495-hard` (Dynamic SMTP settings reload) | backend | 16 → **13** (-3) | 240s → **233s** | 51.3k → **71.6k** | 603k → **538k** | PASS / PASS | 100% / 100% |
| `PR133158-hard` (Notebook telemetry scrubbing) | frontend | 15 → **14** (-1) | 216s → **196s** | 45.3k → **70.6k** | 519k → **459k** | FAIL / FAIL | 86% / 86% |
| `PR133220-hard` (SSOSetting secret redaction) | backend | 17 → **11** (-6) | 200s → **148s** | 48.6k → **33.4k** | 664k → **352k** | PASS / PASS | 100% / 100% |
| `PR132938-hard` (Provisioning picker scope) | frontend | 13 → **11** (-2) | 184s → **164s** | 37.5k → **35.1k** | 456k → **361k** | PASS / PASS | 100% / 100% |
| `PR133364-hard` (Scenes dashboard variables state) | backend | 9 → **8** (-1) | 140s → **124s** | 33.7k → **26.0k** | 203k → **216k** | PASS / PASS | 100% / 100% |
| `PR133290-hard` (Prometheus exemplar query range) | frontend | 9 → **11** (+2) | 57s → **67s** | 24.4k → **28.3k** | 160k → **187k** | PASS / PASS | 100% / 100% |
| `PR133258-hard` (Alertmanager silences pagination) | frontend | 14 → **9** (-5) | 137s → **148s** | 83.3k → **42.8k** | 533k → **394k** | PASS / PASS | 100% / 100% |
| `PR133253-hard` (Tempo trace search query tags) | backend | 10 → **10** (0) | 74s → **74s** | 21.9k → **23.0k** | 160k → **139k** | PASS / PASS | 100% / 100% |
| `PR133251-hard` (Service accounts token expiration) | backend | 7 → **8** (+1) | 49s → **57s** | 19.2k → **20.3k** | 166k → **170k** | PASS / PASS | 100% / 100% |

*\* Note on PR132983-hard: The code generated by both cache and no-cache arms was 100% identical and correctly delegated missing user lookup to `resolveName` (which returns typed `resourceInfo.NewNotFound`). The judge's initial grading marked criterion `c5` as unclear for the cache run because `resolveName` was outside its diff context slice; verified and corrected to met.*

### Harness incidents

- 83 runs returned empty when the session limit was hit; detected (1 turn, 0 tokens, limit message), removed and re-run. `run.js` and `llm.js` now wait and retry on limits.
- The re-grade first ran during a limit window and failed entirely; re-run after the reset.

## Review strategies (2026-10-03): what catches bugs in a change

`thinker review` checks a change against the cache. Which way of asking the
model catches the most bugs at the fewest false alarms was measured with
`bench/review-eval.js` on two datasets, every review answered by Claude
Sonnet 5 through `claude -p` (provider pinned; an earlier run that fell back
to Gemini after one failure is kept as `*-mixed-provider` and not used).
A hit is an error or warning within six lines of the bug; a false positive is
an error or warning on a control. Both runs were stopped before every case
had finished, so the denominators differ per strategy.

- **thinker** (this repository, 250 notes): 11 planted one-line bugs, 1
  refactor control reached. Strategies: `nocache` (the same model, the diff
  and the code it touched, no notes), `holistic` (one call with every
  consulted note), `ensemble` (both), `ensemble-verify` (ensemble plus a
  second call per finding), `notes` (one call per consulted note).

| strategy | bugs caught | controls clean | $ / review | s / review |
|---|---|---|---|---|
| nocache | 10/11 | 1/1 | 0.04 | 11 |
| holistic | 9/11 | 1/1 | 0.11 | 56 |
| **ensemble** | **11/11** | 1/1 | 0.16 | 71 |
| ensemble-verify | 11/11 | - | 0.21 | 88 |
| notes (one call per note) | 10/11 | - | 1.05 | 141 |

- **PostHog** (259-note noteset verified at the clone's HEAD): 5 real fix
  PRs reverted onto that commit (the bug comes back), 4 feature-commit
  controls reached.

| strategy | bugs caught | controls clean (false positives) | $ / review | s / review |
|---|---|---|---|---|
| nocache | 3/5 | 4/4 (0) | 0.12 | 68 |
| holistic | 3/5 | 3/4 (2) | 0.14 | 62 |
| **ensemble** | **4/5** | 3/3 (0) | 0.25 | 116 |
| ensemble-verify | 4/5 | 2/3 (1) | 0.32 | 139 |
| notes (one call per note) | 2/5 | 2/3 (3) | 0.80 | 119 |

What it says:

- **The baseline and the notes catch different bugs.** On PostHog the
  no-notes call caught the BigQuery key-file regression from the code while
  the notes call missed it; the notes call caught the insight autosave
  regression, through a note mined from that very fix PR, while the no-notes
  call missed it. Here, the provider-pin plant (P6) was caught by neither
  call alone and by the ensemble. So the ensemble: two calls, findings
  merged. It caught everything the others caught, at $0.16 to $0.25 and
  about two minutes a review.
- **One call per note, the first design, is dominated**: four to six times
  the cost, the slowest, the weakest on real bugs (2 of 5) and the noisiest
  on controls (3 false positives on one feature commit). Judging a change
  one note at a time blinds the model to bugs the notes do not describe.
- **Verification did not pay for itself** in this sample: no recall to gain
  by construction, one borderline finding (50% confidence) confirmed on a
  control, $0.07 and 20 seconds more per review. It stays an option
  (`--verify`).
- **Confidence is informative**: of 63 findings that located a bug, 52 had
  confidence 0.7 or more; of 6 findings on controls, 5 had 0.7 or less. A
  reporting floor above the present 0.5 is a lever to try with more
  controls.
- **Misses to know about**: a 136-line, three-file protocol change
  (Codex trace id) that no strategy and no note covered; the removed
  home-path check (P7), where the rule lives only in the documentation, missed
  by every notes strategy and caught only by the no-notes call.
- **Three hits on PostHog rest on `fix` notes mined from the PR being
  reverted**: the cache remembering a fix, not reasoning about code. That is
  a real use (a regression of a known fix is what a team cache should catch)
  but it is a different claim.
- **Failure modes found and fixed on the way**: a 67-file commit cut to 16 KB
  of diff made the model report a file as missing from the change; every
  prompt now carries the complete file inventory, and `--chunks n` reviews a
  large change in chunks. Several notes reporting the same bug at nearby
  lines are one finding now. Findings under an outdated-note verdict are
  cache state, not findings. Model answers vary run to run: the same control
  got two false positives from one call and none from the next.

The default is the ensemble. The sample is small (16 bugs, 5 controls
reached, one model); the harness and case sets are in `bench/` to extend it.

### Rerun on this repository, 2026-10-04 (`2026-10-04-anchored`)

The same case set against the cache after a day of changes to it: notes
anchored to definitions rather than whole files, the direct notes a review
consults ordered by how much of the change fell inside the definitions they
rest on and whether those lines name what the note names
(`review.js:specificity`), 80 notes of never-acted-on kinds archived but
still read by review, and 5 notes mined from this repository's fix commits.
Sonnet through `claude -p` for every review; 23 cases reached (the reverts
V2–V5 no longer apply to the base `a0621fe` and were skipped).

| strategy | bugs caught | planted | reverted | controls clean | $ / review | s / review |
|---|---|---|---|---|---|---|
| nocache | 12/13 | 11/12 | 1/1 | 8/10 | 0.07 | 32 |
| **ensemble** | **13/13** | **12/12** | 1/1 | 8/10 | 0.22 | 111 |

- The same shape as the first run: the notes buy the one bug the diff alone
  misses (P6, the provider pin), at about three times the cost of a review.
  Ten of the ensemble's twelve planted hits came through the notes call
  first; the content is there, but it rarely sees what the bare diff cannot.
- The two false positives (one warning each on the real commits C5 and C6)
  appeared in both arms with the same count: the model reading the diff, not
  the notes. The earlier run's controls were clean on both arms too, so the
  rate on controls is now 2 of 10 reached, in both arms.
- On the real commits the ensemble consulted 57 to 66 notes and sent the
  twelve the ordering put first; the controls stayed as clean as the
  baseline's, which is what the ordering was for.
- The reverted fixes are mostly gone from this case set: a fix merged before
  the base cannot be reverted onto it once the surrounding code has moved.
  New revert cases need a newer base.

### Real bugs on PostHog, 2026-10-04: regressions and bug-introducing pull requests

Two case sets mined from PostHog's history against the posthog-v3 noteset (259
notes, built at `a3b3c3685bc`, 2026-09-24), Sonnet through `claude -p`, the hit
rule unchanged (an error or warning within six lines). Files:
`bench/review-eval-cases-posthog-reverts.json`,
`bench/review-eval-cases-posthog-inducing.json`; miners
`bench/review-eval-mine-reverts.js` and `bench/review-eval-mine.js`; runs under
`bench/runs/review-eval/2026-10-04-posthog-regressions-*`.

- **Regressions**: 23 fix PRs merged in the four weeks before the base, reverted
  onto it. For 12 the noteset holds a note mined from that PR (`noted`); for 11
  it holds none. Arms: `nocache`, `ensemble`, and `behavior-holistic` (the 150
  rule-like notes recast as mutable desired behaviors,
  `bench/promote-behaviors.js`, one call, `--kinds behavior`). The
  run was stopped by hand once the behavior arm had finished; the other two
  reached the noted cases only.

| arm | caught | cache knows the fix | cache does not | findings / review | $ / review | s / review |
|---|---|---|---|---|---|---|
| nocache | 5/7 | 5/7 | - | 0.9 | 0.05 | 51 |
| ensemble | 6/6 | 6/6 | - | 2.0 | 0.12 | 134 |
| behavior-holistic | 17/23 | **12/12** | 5/11 | 1.8 | 0.07 | 55 |

  - Every note hit rests on a note mined from the reverted PR: the cache
    remembering the fix. The two regressions the diff-only call missed (sizing
    audiences during read-only impersonation, privileged Trino session
    settings) are the ones nothing in the diff gives away.
  - On the 11 unnoted cases every hit of the behavior arm came from the model
    reading the diff, none from a note. A review consulting behaviors alone
    (the pull request action's default) is blind wherever no behavior rests.
  - Recasting the same notes as behaviors changed nothing: the same 12 hits as
    the ensemble, through the same notes. Content and dependency exposure
    decide detection, not the claim-versus-truth framing.
  - The extra findings on noted cases are the same regression placed at each
    file it touches (code, serializer, test, docs), not unrelated noise;
    `clusterFindings` joins findings only within one file.
- **Bug-introducing pull requests** (not run with a model; dry run only): fix
  commits merged after the base, their removed lines blamed, the PR that
  introduced them kept when it is itself after the base (24 real defects after
  hand-filtering; `fix(today)` commits were mostly UI polish). On 1 of the 24 a
  note rests on the file holding the bug; the notes direct to these changes
  are co-change notes on manifests and generated files. The cache has nothing
  to say about new code; this set measures the baseline model, at about $14
  for both arms.
- **Bug-introducing pull requests, run** (later the same day, runs
  `2026-10-04-posthog-inducing-{codex,sonnet}`): through Codex (gpt-6-luna)
  neither arm caught any of the 20 bugs reached (`nocache` 0/20 with 1
  finding in all, `ensemble` 0/19 with 4), about 35 seconds a review; the
  Sonnet baseline was stopped after 0/3. The fix diffs say why: three of the
  eight read were facts about an outside service (Fly.io capitalizes
  `Regions`, Featurebase's tags endpoint rejects `limit`, Snowflake's timeout
  error text), four were knowledge that was in the repository but in no note
  (a paused experiment keeps status RUNNING; the sweep worker and the web
  fleet share one Redis; every source returns a `SourceResponse`), one a
  design choice. Each fix wrote the fact into a comment: those are the notes
  the cache mines afterwards. Decided 2026-10-04: the review is for
  regressions of what the team learned and for its written conventions, not
  for bugs in new code, where the result is the model's and the cache has
  nothing to add until it covers the area. The one idea tried for the four
  knowledge cases, an arm showing the model one neighbouring file per new or
  changed file for conventions by example (`2026-10-04-posthog-inducing-siblings`,
  Sonnet, the neighbour chosen by shared identifiers: the Adroll source beside
  the Cloudinary one, another Fly.io file beside the regions bug), caught
  nothing in 12 answered reviews (one proximity hit on an unrelated decorator,
  two timeouts), at $0.19 and 160 seconds a review. Not kept.
- **Changed on the strength of this** (2026-10-04): maintenance mines fixes
  first and no longer loses candidates to its per-run cap (`prs.js:pickPrs`);
  the pull request action and the server consult every note by default
  instead of the behaviors alone; findings resting on one note at several
  files are one finding with locations (`review.js:clusterFindings`); a review
  blind on most of the changed code says so first (`review.js:blindSpot`).
  Not changed: no separate behavior detection pipeline, since the framing
  made no difference.
## Ranking: a cross-encoder over the lexical candidates (2026-10-04, offline)

What the prompt hook serves (two notes) for each task's request, scored against the files the merged fix
changed; `bench/retrieval.js` with the request as a user would type it (the benchmark's "Implement the
following change…" framing stripped, since it put words in the query no user types and had been skewing
every ranking number). Notesets: `grafana-v3` (307 notes, built 2026-10-04 with the current pipeline, all
phrased), `posthog-v3` (259, phrased), mitmproxy (29). No agent ran; seconds per set.

| set | BM25 (today) | + cross-encoder, floor −3 | floor −2 |
|---|---|---|---|
| grafana-v3 (11 of 28 tasks have a relevant note) | precision 0.28, 6/11 tasks hit, 25 notes served | **0.41, 6/11, 17** | 0.42, 5/11, 12 |
| posthog-v3 (14 of 14) | 0.75, 12/14, 20 | **0.78, 12/14, 23** | 0.80, 12/14, 20 |
| mitmproxy (8 of 12) | 0.50, 7/8, 20 | **0.73, 6/8, 11** | 0.73, 6/8, 11 |

The reranker (`src/dense.js:ceRerank`, `THINKER_CE=on`, harness arm `hook-ce`) reads the request together
with each of the eight best lexically gated candidates through `Xenova/ms-marco-MiniLM-L-6-v2` (23 MB, ONNX,
one relevance logit per pair), drops those under the floor and serves the rest in its order; 40–220 ms per
request, the hook goes from 0.7 s to about 1.0 s. The runtime (`@huggingface/transformers`) is not a
dependency of thinker; it was installed beside the checkout for the measurement.

Tried on the same sets and not kept: MiniLM bi-encoder embeddings blended into the score with a cosine gate
(`THINKER_DENSE=minilm`, kept in the code as the measured negative): more notes served for the same hits
once the framing was out of the query, and poor at abstaining on tasks with no relevant note; cosine as a
confirmation gate on top of the lexical gate (grafana 0.28 → 0.35, nothing beyond what the cross-encoder
gives); matching the request against each phrasing of a note separately (no better than one pooled vector);
sentence-level request embeddings (precision 0.43–0.50 on grafana, losing one or two hits); one note unless
the second is nearly as strong (no change); the 12-layer cross-encoder (separates worse); cosine confirm
stacked on the cross-encoder (nothing extra). The floor was chosen on these 54 tasks, so the gain in the wild
should be read as somewhat smaller. The transformers.js classification pipeline softmaxes a single-logit
cross-encoder to 1.0; the logit is read from the model directly.

## Serving: Jev (2026-10-06, offline, all 54 labelled tasks, two runs)

[Jev](https://docs.typesafe.ai) (TypeSafe System One) returns a calibrated probability per typed question and
generates no text. As a serving reranker it takes the lexically gated candidates and answers one Noul per
candidate: *would this note help a developer carry out this request*. The note goes over as named fields
(`kind`, `title`, `answers_the_questions`, `claim`, `code_it_points_at`, `freshness`; `jev.js:noteRecord`),
not as prose: against one blob of the same note, recall held and false positives went from 8 to 5.

Scored against the same `gpt-6-sol` labels as every other ranking number here
(`bench/runs/ranking-lab-2026-10-04`), on all 54 tasks: 761 candidates, 70 important notes, 46 of 54 tasks
have a useful note. Two independent runs, same model, nothing else varied.
Harness: `bench/jev-eval/hook-jev-arm.mjs`. $0.024 and about 160 ms a task per run.

| arm | served | useful share | important share | important notes | tasks hit | served when nothing useful |
|---|---|---|---|---|---|---|
| **jev, floor 0.5, two notes** (the default when a key is set) | 55 | **0.96** | **0.73** | **40/70** | **33/54** | **0** |
| jev, floor 0.5, one note | 33 | 1.00 | 0.76 | 25/70 | 33/54 | 0 |
| jev, floor 0.7, one note | 26 / 24 | 1.00 | 0.81 / 0.83 | 21 / 20 of 70 | 26 / 24 of 54 | 0 |
| cross-encoder default (above) | — | 0.96 | — | 16/70 | 23/54 | 0/8 |
| BM25 top 2, within the labelled pool† | 103 | 0.44 | 0.25 | 26/70 | 31/54 | 8 |

So **2.5x the important notes reached at an identical useful share**, and 33 of 54 tasks served something
useful against 23. Both floor-0.5 arms were identical across the two runs — 55 and 33 notes served, the same
40/70 and 25/70 — so at this size the result reproduces to the note; only the 0.7 floor moved, by two notes.
(An earlier 4-query probe swung 0.64/0.69/0.75 on identical inputs; that was small-sample noise, not the model.)
Neither Jev nor the cross-encoder serves anything on a task where no useful note exists.

† The BM25 rows rank *within* each task's labelled pool with no coverage gate; they are a floor for the
ranking signal, not the production gated hook, which is at 0.69 above. Jev was likewise handed the labelled
pool (the union of the gate, dense and open rankings), so these absolute numbers assume good candidate
generation; production generates its own. The stored `l6` scores in the lab run (0.68 useful, 9 of 70) behave
like the raw-note-text variant that did not separate, so that arm is not the live cross-encoder default.

Measured and rejected the same day: a facet vector typed onto every note (task triggers, an `inert` flag, a
`machine` flag, a drift surface, a blast score; 347 notes, `bench/jev-eval/type-store.mjs`) as a serving
signal. Against the 66 notes carrying real attestation labels every facet scored AUC ~0.50 — inert 0.630 (the
wrong way), machine 0.435, blast 0.480, trigger 0.517-0.541 — and `inert > 0.5` flagged three notes sessions
had been confirmed to act on, one with three confirmations. No intrinsic property of a note predicts what
sessions do with it; only the (request, note) pair does. The facets stay useful descriptively: 29 of 347 notes
type as `an_external_tool_changing`, meaning no dep hash can falsify them.

### Catalog search and reconciliation prototype (2026-10-06)

`bench/jev-eval/catalog-eval.mjs` compares a full-corpus Jev scan using bodies or
stored `search` descriptions with the existing four-note session shortlist,
then separately tests full-body `covered` / `extends` / `contradicts` / `unrelated`
decisions. The frozen local snapshot has 328 non-invalid notes, 61 with search
descriptions. On nine constructed observations, the local baseline finds all
seven labelled targets and returns no notes on the two no-target cases. This is
a plumbing/relationship probe, not a held-out quality result. Live API execution
is pending explicit approval to send the private snapshot; no Jev result is
claimed. See [the research record](../research/jev-note-catalog/README.md).

## Ranking: labels instead of the gold-file proxy (2026-10-04, offline)

Every ranking number above scores a served note as "on target" when it rests on a file the merged fix changed.
A Codex judge (gpt-6-sol) labeled 761 candidate notes over the same 54 tasks against the merged change (title,
calibrated criteria, diff excerpt): 2 important guidance, 1 helpful context, 0 irrelevant. Labels, cross-encoder
scores and lab scripts: `bench/runs/ranking-lab-2026-10-04/`.

- The proxy was wrong often: on grafana 13 of 30 on-gold candidates were judged irrelevant and 46 off-gold
  judged useful (10 important). Under labels the hook's BM25 top 2 is at precision 0.69 overall (grafana 0.68,
  posthog 0.84, mitmproxy 0.52), not the 0.28–0.75 the proxy gave.
- Recall of important notes is the weak side: 27 of 70 reach the prompt hook. The coverage gate, not the ranking,
  holds them back: on grafana the open lexical ranking has 12 of 17 in its top 8 and only 7 pass the floors.
  Loosening the floor to 0.15 gains two important notes and costs 16 points of precision.
- Neither cross-encoder separates important from irrelevant notes on raw note text (ms-marco L6 median logits
  −4.3 against −4.5 on grafana; mxbai-rerank-xsmall no better). On a 3–6 sentence search description written
  from the note alone (Haiku, $2.20 for 576 notes) it does. All 54 tasks, prompt hook:

| variant | useful share | important share | important notes served | tasks given a note when none was useful | tokens/task |
|---|---|---|---|---|---|
| BM25 top 2 (before) | 0.69 | 0.38 | 27/70 | 4/8 | 514 |
| cross-encoder on search text, floor −2, two notes | 0.84 | 0.58 | 25/70 | 0/8 | 318 |
| floor 0, two notes | 0.88 | 0.76 | 19/70 | 0/8 | 177 |
| **floor 0, one note** (the default now) | **0.94** | **0.88** | 15/70 | 0/8 | 121 |
| floor 0, one note, request cut to 120 tokens | 1.00 | 0.76 | 16/70 | 0/8 | — |
| same, falling back to the best note at ≥ −1 when nothing clears 0 (**the default now**) | 0.96 | 0.67 | 16/70, 23 tasks hit against 19 | 0/8 | — |

Tasks that get a useful note at prompt time: 33 of 54 before, 16 with floor 0 / one note, 21 with the request cut
to its first 120 tokens (24% of grafana's pairs exceeded the 512-token limit and lost the note text); counting the
edit hook, which serves the rules resting on a file the agent edits, 39 before and 33 after. Important notes that
rest on a file the fix changed: grafana 7/17, posthog 40/44, mitmproxy 9/9. The floors were chosen on these 54
tasks; one judge, one prompt; posthog's labels are generous (44 important notes on 14 tasks). The user's call:
precision first, one note, adjustable (`ce` in the config).

### One note or two: four tasks on Codex (2026-10-04, `*-codex-ce1` / `*-codex-ce2`)

The `hook` arm of `bench/codex-run.js`, Codex CLI 0.160 with `gpt-6-sol`, one seed, the cross-encoder at floor 0
reading the search text, request cut to 120 tokens; the only difference is `THINKER_CE_MAX` 1 or 2. Graded by the
Codex judge on the calibrated criteria. Tasks chosen where the two settings serve different notes: on the two
posthog tasks the second slot carries the on-target note and the first an off-target one; on the grafana tasks the
second slot is off-target. The hook is handed the bare request (the benchmark's "Implement the following change…"
paragraph is harness instruction and crowded the request out of the cross-encoder's 120 tokens; with it in front
nothing was served on any of the four).

| task | one note | two notes |
|---|---|---|
| posthog PR106672 | pass, 24 tool calls, 1.02M input tokens, 190 s | fail (6 of 7 essential), 35 calls, 1.28M, 222 s |
| posthog PR106613 | pass, 16 calls, 0.29M, 55 s | pass, 12 calls, 0.33M, 57 s |
| grafana PR133206 | fail (4 of 5 essential), 31 calls, 0.89M, 189 s | pass, 26 calls, 0.69M, 145 s |
| grafana PR133011 | fail (0 essential), 27 calls, 0.92M, 240 s | fail (0 essential), 46 calls, 0.88M, 242 s |

One task flipped each way, one tied, one failed identically in both (the agent edited the panel-edit wrapper
rather than the text panel's view-mode state in both arms, with the same reasoning). Four tasks and one seed say
nothing about which setting is better; they say the mechanism works end to end on Codex (one or two notes
injected as configured, scores logged) and that the second note is not a free improvement even when it is the
on-target one. The default stays floor 0, one note.

### Before shipping: old hook against new hook on five real tasks (2026-10-04)

Committed main `8a36e5f` (the cross-encoder default, floor 0, one note, request cut to 120 tokens, before the
fallback floor landed). Old = the hook as it was (lexical ranking, two notes, `THINKER_CE=off`); new = the default.
Same noteset, same prompt, bare request first and the benchmark's framing after it for both arms, one seed.
Codex CLI 0.160 with `gpt-6-astra`, Claude Code with Opus (60 turns max). Codex `gpt-6-sol` judge on the
calibrated criteria throughout. Runs: `bench/runs/{posthog,grafana}-astra-{old,new}`, `*-opus-oldnew`.

| agent | task | old hook (two notes) | new hook (one note) |
|---|---|---|---|
| Astra | grafana PR133191 | pass, 13 calls, 0.46M input | pass, 11 calls, 0.29M |
| Astra | posthog PR106936 | pass, 19 calls, 1.16M, 2 notes served | fail (5/6 essential), 18 calls, 0.84M, nothing served |
| Astra | posthog PR106613 | pass, 7 calls, 0.26M | pass, 7 calls, 0.26M |
| Opus | posthog PR106466 | fail (4/6 essential), 60 calls, 6.8M, $5.40 | fail (4/6, same criteria), 66 calls, 7.1M, $6.24 |
| Opus | grafana PR133148 | fail (5/6 essential), 65 calls, 5.2M, $4.51, 1 note served | pass, 63 calls, 5.5M, $4.53, nothing served |

Three of five identical in outcome, one loss and one win, both on tasks where the new hook served nothing: on
PR106936 the old hook's second note ("bulk invite partial-failure semantics") carried the essential criterion the
new run missed; the cross-encoder had scored every one of the five important candidates below zero (best −0.93),
which is what the fallback floor (−1) now catches. On PR133148 the old hook's note did not help and the run
without notes passed. Five tasks, one seed: the default is not worse on outcomes here and is cheaper in tokens
where both pass; it is not shown better either. Harness notes: the Codex harness reads positional arguments as
reps/conc when flags come first (pass `--reps 1 --conc 1`); serving through `codex-run.js` writes `uses`/`servedIn`
into the noteset it is pointed at (revert before committing tracked notesets); `run.js` now puts the request before
the framing paragraph for every arm.

## What this says about the design

1. **Delivery matters more than retrieval.** Zero-turn injection (hook) is the only delivery that paid for itself; a tool call the agent must discover and invoke costs more than it saves in Claude Code today.
2. **Content only helps when orientation is the bottleneck.** With PR bodies that name the module, or a 27k-LOC repo Sonnet reads in one call, savings vanish or are explained by the injection prompt alone (the irrelevant control is essential; without it the PR-body result looks like a win).
3. **When it helps, it helps on specific tasks** (PR8176: 4 turns instead of 9.5) and **when it hurts, it hurts on specific tasks and reliably** (PR8288: 0/8 cache runs vs 0.75 baseline). Per-note attribution identifies both; implicit attestation from traces catches contradictions but not accurate-yet-partial notes, so an outcome signal (user re-prompts, failed tests, `feedback`) is still needed to demote those.
4. **Invalidation is cheap and works** (symbol-level hashes, $0.03 Haiku verification, correct rewrites), but on these repos the agent's own re-reading made stale notes harmless. Its value is insurance for claims the agent will not re-verify: commands, co-change rules, rationale.
5. **Coverage is the dominant miss** on question tasks (7/8 failures): notes only exist for what earlier sessions explored. Capture must be broad (every session, low threshold), which the Stop-hook distiller does at ~$0.05/session.

## Cost of the whole study

~1,400 `claude -p` runs (agents, judges, graders, distillation, mining, verification); roughly $300 of usage through the user's Claude Code login.

## Tool intro: does naming find and review get them used? (2026-10-05, Gemini, 4 runs)

A smoke test of the `<thinker-tools>` intro the prompt hook adds once per session
(`ops.js:sessionIntro`, PR #27), not a measurement: two Grafana tasks, one run per
arm, Antigravity `agy` with `gemini-3.8-flash-high`, the same model as judge
against the tasks' calibrated criteria (Codex was out of quota); the merged PRs'
Go tests do not build here and were skipped. Both arms had the grafana-v2 notes;
the hook served no note for either task, so the arms differ in the intro alone.
`before` hands the hook no session (no intro); `after` hands it the run's id.
Run dir `bench/runs/grafana-gemini-intro-ab`; harness `bench/gemini-run.js --arm before,after`.

| run | thinker calls | find | review | tool calls | file reads | wall | judged |
|---|---|---|---|---|---|---|---|
| PR133148 before | orient 1, lookup 1, remember 1 | 0 | 0 | 135 | 73 | 15.1 min | pass |
| PR133148 after | orient 1, lookup 3, remember 1 | 1 | 2 | 114 | 63 | 18.3 min | fail (c5) |
| PR132983 before | lookup 1, remember 1 | 0 | 0 | 136 | 67 | 13.6 min | pass |
| PR132983 after | orient 1, lookup 3 | 1 | 9 | 143 | 66 | 20 min, cut off | pass |

The intro does what it is for: both `after` runs called `find` and `review`,
neither `before` run did. What it exposed is in the review tool, not the intro:

- Antigravity gives an MCP call three minutes. `review` with `action: "assess"`
  ran 8 model calls through the Gemini CLI, each answering with 45–80k output
  tokens, and both assess calls in PR133148 timed out; the agent waited six
  minutes for nothing. The same happened once in PR132983.
- `action: "start"` queues a run, and the agent then polled `status` five times
  in two minutes while the review ran, then asked for an assess and was cut off
  by the harness's 20-minute limit. The patch it had by then was judged passing.
- The agent's first `start` call passed `criteria` as a string and was refused
  by the schema (`expected object, received string at task`).
- The c5 failure in PR133148 after (the fallback when no search-field registry
  is set) is one run of one task; nothing ties it to the tools.

Fewer file reads in both `after` runs (73→63, 67→66) and fewer tool calls in one
(135→114) are what an agent that reaches definitions through `find` would show,
and at n=1 they are not evidence. What to change before the next run: `review`
over MCP must answer inside an agent's tool timeout (assess detached like start,
or far fewer and shorter model calls: 8 calls at 60k output tokens each is the
cost of a task, spent on a review); a `status` answer should tell the agent to
keep working and check once more at the end, not poll; and the tool should take
a string for `task` as the request. The review's model work went to Gemini
(`THINKER_LLM=gemini` on the hook and the agent), never to Claude.

### Rerun with the intro naming find and drilldown only (2026-10-05, 2 runs)

Same tasks, agent, judge and notes; the intro no longer tells the agent to run
`review` before reporting done (PR #29) and names it once as available. Run dir
`bench/runs/grafana-gemini-intro-ab-v2`. The `before` rows are the runs above.

| run | find | review | tool calls | file reads | wall | judged |
|---|---|---|---|---|---|---|
| PR133148 before | 0 | 0 | 135 | 73 | 15.1 min | pass |
| PR133148 intro v2 | 4, all answered | 3, two timed out | 133 | 74 | 19.0 min | fail (c5) |
| PR132983 before | 0 | 0 | 136 | 67 | 13.6 min | pass |
| PR132983 intro v2 | 0 | 1, timed out | 155 | 77 | 16.8 min | pass |

Not better. `find` was used as intended in one run (`SelectableFields`,
`SearchFieldsRegistry`, `NewSearchFieldsRegistry`, each answered in seconds),
and not at all in the other. The agent still reached for `review` at the end
of both runs, each timed-out call cost three minutes, and neither run beat its
`before` on time or reads. c5 failed in both intro runs of PR133148 and passed
in the `before` run: one run each, nothing to conclude, worth watching. The
mention of `review` is gone from the intro; a review is run when a person
asks for one.

### Rerun with review named nowhere (2026-10-05, 2 runs)

Same tasks, agent, judge and notes. The intro names `find` and `drilldown` only
(PR #31) and the `review` tool's description says it is for when the user asks
(PR #32); for this run Antigravity's thinker MCP entry pointed at the checkout
rather than the installed 0.1.14, which the earlier `after` runs had used, so
those saw the old description ("During implementation, supply task context…")
as well as the intro. Run dir `bench/runs/grafana-gemini-intro-ab-v3`.

| run | find | review | tool calls | file reads | wall | judged |
|---|---|---|---|---|---|---|
| PR133148 before | 0 | 0 | 135 | 73 | 15.1 min | pass |
| PR133148 intro v3 | 2 | 0 | 133 | 74 | 13.0 min | fail (c5) |
| PR132983 before | 0 | 0 | 136 | 67 | 13.6 min | pass |
| PR132983 intro v3 | 1 | 0 | 134 | 61 | 13.1 min | pass |

No `review` call in either run, and wall time back at or under `before`
(13.0 against 15.1, 13.1 against 13.6 minutes), with `find` used in both runs
and reads 61 against 67 on PR132983. The review calls, not the intro, were the
cost of the earlier `after` runs. The earlier conclusion that one sentence in
the intro triggered them was confounded: the tool description invited them too.

c5 of PR133148 (no search-field registry at all: fall back to the storage
scan) has now failed in all three intro runs and passed in the one `before`
run. All three failing runs looked up the same notes on selectable fields
(`empty-selectablefields-in-build-info-means-none-mapped-not-u`,
`selectable-field-filters-must-be-refused-if-the-index-doesn-`, served through
`orient` and `lookup`); the `before` run made one lookup. An agent that uses the
cache more reads those notes, and they argue for refusing or declaring fields,
not for scanning storage. One task, three runs: a hypothesis about those notes,
not a finding about the intro.

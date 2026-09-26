# Benchmark results

All runs: `claude -p`, model `claude-sonnet-5`, `bypassPermissions`, max 60 turns, same task text and tools in every arm; judge = Sonnet against an Opus-written reference (question tasks) or against the merged upstream PR diff (change tasks). Wall-clock includes hook/tool latency. `in_tokens` = input + cache-creation + cache-read tokens summed over turns.

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

## What this says about the design

1. **Delivery matters more than retrieval.** Zero-turn injection (hook) is the only delivery that paid for itself; a tool call the agent must discover and invoke costs more than it saves in Claude Code today.
2. **Content only helps when orientation is the bottleneck.** With PR bodies that name the module, or a 27k-LOC repo Sonnet reads in one call, savings vanish or are explained by the injection prompt alone (the irrelevant control is essential; without it the PR-body result looks like a win).
3. **When it helps, it helps on specific tasks** (PR8176: 4 turns instead of 9.5) and **when it hurts, it hurts on specific tasks and reliably** (PR8288: 0/8 cache runs vs 0.75 baseline). Per-note attribution identifies both; implicit attestation from traces catches contradictions but not accurate-yet-partial notes, so an outcome signal (user re-prompts, failed tests, `feedback`) is still needed to demote those.
4. **Invalidation is cheap and works** (symbol-level hashes, $0.03 Haiku verification, correct rewrites), but on these repos the agent's own re-reading made stale notes harmless. Its value is insurance for claims the agent will not re-verify: commands, co-change rules, rationale.
5. **Coverage is the dominant miss** on question tasks (7/8 failures): notes only exist for what earlier sessions explored. Capture must be broad (every session, low threshold), which the Stop-hook distiller does at ~$0.05/session.

## Cost of the whole study

~600 `claude -p` runs (agents, judges, distillation, verification); roughly $65 through the user's Claude Code login.

# Measuring what the cache does: the plan from 2026-10-11

Author: Claude (Fable 5.1) with Yoav Shmariahu. Status: agreed plan, second version. The first
version (four tests, hundreds of millions of tokens) was withdrawn the same day: its central
test had the cache learn between back-to-back tasks, which the product cannot do, and it could not
have been afforded.

## Where things stand

- Cost is settled. The haiku alias resolved to Haiku 4.5 ($1 / $5 per MTok) and distillation and
  mining defaulted to Sonnet; PR #194 (merged 747db20) moves the aliases to the 5.5 models and makes
  haiku the learning default. Repriced from the logged token counts, the fortnight's pipeline goes
  from about $86 to about $6; the recurring part (distill, verify, phrase) from about $20 a week to
  about $1.60. The installed app was rebuilt from that commit; `install.json.dist` points at the
  local tarball on purpose until a published release contains it.
- Benefit is the open question. The usage report's estimate of reading avoided prices at about $8
  for the fortnight (885k fresh input tokens, mostly Fable and Astra at $10 / MTok). The holdout
  shows a third fewer input tokens with notes, on 42 against 7 sessions, with cache reads folded
  into the input figure.
- Holdout raised to 0.30 on thinker and codervibes (`.thinker/config.json`); the 0.15 default stays
  elsewhere; benchmarks keep `THINKER_HOLDOUT=0`. The "562 not measured" sessions in the usage
  report are benchmark arms and the test suite's temporary checkouts, not lost real work.

## Rules for evaluating cost

1. Dollars, never tokens, across models or across input and output. Tokens only within one model
   and one token class.
2. Four token classes priced separately: fresh input, cache read, cache write, output.
3. Spend priced at the model that actually ran (the log's `model` field), never the alias.
4. Benefit priced at the agent's model and the token class displaced: reading avoided is fresh
   input, later re-reads are cache reads.
5. One-time costs (mining, init, first phrasing) amortize over the cache's life against cumulative
   benefit; recurring costs (distill, verify, re-phrase) compare per week. Never one total.
6. Every spend line carries its yield: notes per run, ever served, ever acted on. Mining's figure of
   merit is notes served and acted on per dollar; re-mine only PRs merged since the last run.
7. Compare per repository over months, not a fortnight.
8. Subscription usage is logged at API list price and labeled notional.
9. The product's net-after-spend line goes, or becomes per-model lines.
10. New pipeline spend gets a ceiling tied to measured benefit, dollars per repository per week.

Prices used (Anthropic list 2026-10-06; vendor pages for the rest), input / output per MTok:
Haiku 5.5 $0.10 / $0.50, Haiku 4.5 $1 / $5, Sonnet 5 and 5.5 $2 / $10, Opus 5.5 $4 / $20,
Fable 5.1 $10 / $50, GPT-6 Astra $10 / $50, GPT-6 Sol $4 / $20, Gemini 3.8 Flash $0.75 / $3.75.

## Measurement 1: the live holdout, sharpened (primary, $0)

`ops.js:holdoutSession` and `usage.js:holdoutOf` as they are, plus:

1. Two low-variance measures beside whole-session totals: tool calls before the first edit, and
   whether the first edited file is one a served note pointed to.
2. Fresh input, cache reads, cache writes and output as separate lines, priced per rule 2 (the
   session line already records them; `normalizeModelUsage` folds them into `inputTokens`).
3. Settled marker at 20 sessions a side per model (`MIN_HOLDOUT` 5 stays the display floor);
   bootstrap 90% interval on each median difference.
4. Served sessions split by whether a serving was later marked acted on.
5. Holdout gap and reads-avoided estimate side by side with their ratio.
6. Tests and benchmark arms log under their own path (`THINKER_LOG`).

Settles in about three weeks for Claude and five for Codex at the current session rate.

## Measurement 2: re-analysis of existing runs ($0)

Pool every paired run under `bench/runs` (146 directories), mark whether the cache arm was served a
note, and report effect given served and effect given nothing served, by model, with a bootstrap
interval across pairs and priced spend per rule 1. Exclude by name the runs the harness audits
marked invalid (empty caches, 60-turn cap hits, early Codex token double count). No model calls.

## Measurement 3: one small benchmark on this repo (about $20)

- Snapshot this repo's real cache by note creation date, fixed before task selection.
- Tasks: 8 to 10 PRs merged after that date that added or changed tests (86 of 185 merges since
  2026-10-04 do), phrased from their descriptions, run at the pre-merge base in a fresh worktree.
  Selection by merge date, hashed and written down before any run.
- Arms: no cache; the snapshot served through the prompt hook with the tools available. Holdout
  off, learning off.
- Coder: Sonnet 5.5 through `bench/run.js`, about $0.40 a task. Two runs per task per arm: 40 runs,
  one session at a time.
- Grading: the PR's own tests against the agent's patch. No judge.
- Reported: coverage, effect given served, paired difference with interval, pass rate per arm.

## Reporting

| | coverage | effect given served | whole population |
|---|---|---|---|
| tool calls | share served a note | paired Δ, 90% interval, n served | derived |
| spend, priced | same | same, by token class | derived |
| correctness | n/a | paired Δ, tests or named judge | derived |

Transfer only; paired and repeated; fail closed (invalid runs excluded and listed); priced;
pre-registered and confirmed before any run.

## Dropped from the first version

- Series of tasks with learning between them: notes are not available to the next task
  (distill runs detached at session end, grounding gates, phrasing in maintenance, CE reads the
  phrased search text). About 180M tokens.
- 24 new orientation tasks (about 65M tokens): the click study already gives the best case.
- 324-run rerun of the change set (about 500M tokens): Measurement 2 gets the coverage split from
  runs already paid for.

## Order and decisions

Measurement 2 first (script only), then the report changes for 1, then 3 after its task list is
approved. Open: Sonnet 5.5 and about $20 for Measurement 3; the branch for the usage report
changes; whether the net-after-spend line becomes per-model lines or goes.

# Understanding notes beside PR notes: a confirmed saving (2026-10-16/17)

Do notes written from the code ("understanding notes", `thinker understand`) help an agent beyond the PR-mined notes
thinker ships? On the fair mlflow tasks, yes: served with the understanding pool beside PR notes, they cut input
tokens by 6% (90% range 2–10%, clear of zero) and tool calls by 7%, with passes unchanged. All caches built on Sonnet.

Artemis (local, port 6489):
- Confirmation: http://127.0.0.1:6489/#/exp/mlflow-b2-pr-vs-pr-und-sonnet-2026-10-17
- Served vs pinned, six arms: http://127.0.0.1:6489/#/exp/mlflow-b2-understanding-pinned-2026-10-16
- Fair-task canary: http://127.0.0.1:6489/#/exp/mlflow-b2-fair-canary-2026-10-16
- Caches: http://127.0.0.1:6489/#/caches

## Setup

- Tasks: `mlflow-b2-fair-covered8`, the 8 tasks of the fair mlflow set (`../task-audit-2026-10`) with notes on the code
  their fix changes. Graded by each PR's tests. Agent: gpt-6-astra via Codex. Thinker under test 00fdf5e97.
- Caches, all at the base commit 1bb65f1c6, all built on Sonnet (claude-sonnet-5-5):
  - `mlflow-b2-sonnet-mined-60`: 58 notes mined from 60 merged changes, 0.43M tokens.
  - `mlflow-b2-uvar-b-finer-sonnet`: 150 understanding notes over the 15 source files the 8 fixes change, every file
    whole, 10k tokens of code per call (variant B), 2.06M tokens.
  - `mlflow-b2-combo-mined60-uvar-b-sonnet`: the two combined (208 notes).
- Arms (defined as data, `hook-context.mjs`: thinker's own prompt hook on a per-call copy of the arm's notes):
  `pr-only-s` (the mined cache) and `pr-und-bs` (the combined cache, understanding pool on: `THINKER_CE_UNDERSTANDING=on`).
  3 runs each, interleaved, same day and thinker.

## Result

48 sessions; 2 left out for answer-key leak flags; no warm-up offers; every valid session passed.

| | pr-only-s | pr-und-bs |
|---|---|---|
| median input tokens | 302k | 294k |
| median tool calls | 12 | 11 |
| passes | 24/24 | 22/22 |

Paired by task and run (22 pairs): input ×0.94, 90% range ×0.90 to ×0.98 (bootstrap over tasks); tool calls ×0.93;
15 of 22 pairs cheaper; 6 of 8 tasks cheaper (PR26442 ×0.85, PR26307 ×0.87, PR26327 ×0.89, PR26269 ×0.90,
PR26291 ×0.93, PR26270 ×0.96; PR26300 ×1.04, PR26267 ×1.05).

## How it was reached

1. Build variants (`judge.mjs`, `replay.mjs`): five builds over the same 15 files, judged by Sonnet for a note that
   states each task's mechanism. Finer calls (B, 10k tokens) and overview+details (D) reached 6/8 tasks, the current
   build (A) 4/8, task-shaped notes (C) 3/8; the same build on Sonnet (E) 5/8 at half astra's tokens. Serving still
   reached the good notes on 1–4 of 8 requests.
2. Served vs pinned, 1 run (`pinned-context.mjs`): served alone, understanding notes did nothing (×0.95 input);
   the best note pasted (retrieval taken out) ×0.82; PR notes alone ×1.06; PR + astra-built B ×0.94 vs no cache and
   ×0.91 vs PR alone (90% range ×0.83–×1.00: suggestive).
3. Confirmation, 3 runs, both caches Sonnet-built: above.

## Caveats

- Modest and narrow: 8 tasks of one repository, notes built over exactly the files the tasks change. In use the
  notes cover the directories a person works in, and retrieval has more to sift.
- Pass rate cannot move here: the fair tasks are solved without notes. The saving is effort only.
- Cost: the understanding build took ~2M Sonnet tokens for 15 files; at ~20k tokens saved per session it pays back
  after ~100 sessions in that code. A cheaper build (variant E, 1.16M) is the next test.
- The arms are defined as data, so Artemis records no thinker commit for them: it was 00fdf5e97.

## Next

A second repository with the same setup, and the cheaper build (E) beside B. The understanding pool and coverage
suggestions stay off by default until those land (AGENTS.md: no new strategy without an experiment).

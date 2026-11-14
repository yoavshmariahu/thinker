# bench: run paired agent sessions, record them, compare the arms

```bash
node bench/bench.mjs run bench/experiments/delegate-haiku-posthog.json --dry   # starts nothing
node bench/bench.mjs run bench/experiments/delegate-haiku-posthog.json         # spends tokens
node bench/bench.mjs report posthog-delegate-haiku [--boot]
node bench/bench.mjs ledger [--tag <tag>]
```

One file (`bench.mjs`, ~250 lines) and a ledger. It replaced Artemis (a web app and a SQLite database)
and kronus (a runner) on 2026-11-14, at the owner's call: what was wanted from them was a consistent
place to keep runs and a consistent way to start them, and the rest was in the way. Artemis's database
is kept as the archive of every experiment before that date, including the numbers published on the
website; nothing new is started there.

## What a run is

A **spec** (`bench/experiments/*.json`) names the question, the **rule** by which the tasks were chosen,
a base repository and commit, the tasks, the model, and the **arms**. A **task** is a directory of
`turn-N.txt` prompts given to one resumed session in order, plus an optional `check.sh` run in the
worktree afterwards whose last line is the outcome. An **arm** is `env`, plus project-scope Claude Code
files written into the worktree: `hooks` become `.claude/settings.json`, `agents` become
`.claude/agents/<Name>.md`, `before`/`after` are argv arrays run in the worktree (`after`'s stdout is
kept on the record as `armReport`).

Each task × arm × rep gets its own git worktree of the base at the commit, so arms never see each
other's edits.

## The system of record

`bench/ledger.jsonl`, one line per session, **committed** — the provenance lives in git history rather
than in a database that needs an app to read. Each line carries the tag, task, arm, rep, model, session
id, the rule, the base commit, token usage, both cost figures, the outcome, the `armReport`, and:

- `taskHash` — every prompt and the check, hashed. A changed task is a different task.
- `armHash` — the arm's whole definition, hashed.
- `valid` and `invalidReason` — see below.
- `transcript` and `cwd` — where the full session is on disk.

Full per-session JSON (including every turn's response) goes to `bench/runs/<tag>/<id>.json`, which is
gitignored along with the worktrees.

## The four things worth keeping from the old layer

1. **An invalid session is never averaged.** A turn that errored, or a session that hit `--max-turns`,
   is recorded in full with `valid: false` and enters no figure; `report` lists it by name underneath.
   This is the fault that wasted $25.53 on 2026-11-14: the old runner capped sessions at 60 turns by
   default, these tasks run 76-87, and all six sessions were silently discarded as errors. `maxTurns`
   here defaults to **180**.
2. **The rule is written before the run** and copied onto every record, so a selection can't be
   rationalised afterwards.
3. **Arms are paired by task and rep**, and every rate is a ratio of sums — never a mean of per-session
   ratios, which read $13.93 against a true $5.97 on this machine's own ledger once.
4. **No session inherits this machine's proxy.** Every arm pins `ANTHROPIC_BASE_URL`, and arms are
   project scope only (`--setting-sources project`), so thinker's own clearing can't act on an arm and
   turn a pair into thinker measured against thinker.

`--boot` resamples the paired tasks for a 90% spread. With the handful of tasks a bench like this runs
that is a spread and is labelled as one, not a p-value.

## What it does not do

No judge (a task's `criteria.json` is kept beside its prompts for one to be added), no concurrency, no
job queue, no result reuse across experiments, no leak checks. Add them when a question needs them.

## Cost

`run` starts real agent sessions. State the estimate and get a yes first; `--dry` prints the plan and
starts nothing. A nine-turn PostHog session on Opus 5.5 cost about $8 on 2026-11-14.

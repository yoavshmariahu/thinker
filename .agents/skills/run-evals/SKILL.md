---
name: run-evals
description: >-
  The only way to run, follow and read benchmark evals in this repository: Artemis, the evals
  platform (bench/evals), and its MCP tools. Use whenever a task involves running a benchmark or experiment,
  building a benchmark cache, choosing PRs to evaluate on, comparing the cache on against off, checking
  whether a change or a model helps, following a run in progress, reading session transcripts, or
  reading, summarizing or reporting eval results — including results already on disk under bench/runs.
  Do not start bench/run.js, codex-run.js, gemini-run.js or mine-prs by hand, and do not hand-compute
  numbers from bench/runs JSON for a report.
---

# Running evals through Artemis

Every eval is an **experiment**: a set of PRs in one repository, run with the cache **off** and with
it **on** (and sometimes further arms such as a placebo), to answer one question about a **behavior**
(a cache feature, prompt or wiring) or a **model** (how one model does with the cache). An experiment
is put together from **modules**, each made and checked on its own:

| Module | What it fixes | Made with |
|---|---|---|
| **PR set** | which PRs, at which base commit, chosen by which rule | `create_pr_set` (`draft: true` to compose it with `update_pr_set`), then `freeze_pr_set`; only a frozen set runs, and it never changes |
| **Cache** | what the cache-on arm is served: mined from merged PRs, or read from the most changed code (understanding), at an anchor commit, by a named model | `plan_cache` → user approval → `build_cache` |
| **Arms** | cache off, cache on, and any extra arm | part of the experiment |
| **Agent** | runner, model (= the cache's building model), reps, concurrency | part of the experiment |
| **Grading** | the PRs' own tests, or a named judge | part of the experiment |

Artemis plans, prices, starts, tracks, archives and compares experiments. It is the exclusive path:

- **Build caches and start experiments** only through it: plan → user approval → build / start (the MCP
  tools or the **Caches** and **New experiment** pages). Never invoke `bench/run.js`,
  `bench/codex-run.js`, `bench/gemini-run.js` or `thinker mine-prs` for a benchmark by hand: a
  hand-started run has no modules, no checks and no plan the user approved.
- **Read** results only with `get_experiment`, `list_experiments`, `get_pr` and `get_session` (or the
  pages). Their numbers are paired, interval-bounded, fail closed on invalid sessions and name their
  grader; a figure computed by hand from `bench/runs/*.json` is none of those.
- **Artemis's database is the system of record** (`~/.artemis/artemis.db`, snapshotted daily to S3):
  experiments, PR sets, cache receipts, every session's record and transcript, jobs. The runners'
  files under `bench/runs/<tag>/` are only their hand-off, imported once. Never edit the database or
  those files by hand, and never treat a file as the result.

## 0. Connect

The MCP server talks to the running app; another session may already run it:

```bash
artemis-up                                       # starts Artemis, or says where it already runs (scripts/artemis-up)
claude mcp add artemis -- node bench/evals/mcp.js  # once per machine; it finds the port itself (or set ARTEMIS_URL)
```

`artemis-up` runs in the foreground: an agent starts it in the background. One Artemis runs per
machine, and every worktree shares its database.

Run the app from the checkout that holds the data (`bench/runs`, `bench/repos`); from a worktree pass
`--bench <main checkout>/bench`. Without the MCP tools (another agent), use the same HTTP API the tools
call (`/api/experiments`, `/api/experiment?dir=`, `/api/session?id=`, `/api/prsets`, `/api/caches`,
`/api/cache/plan`, `/api/plan`, `/api/launch`, `/api/jobs`) — never the runners.

## 1. Before designing: is an agent run needed at all?

Follow the stage gates: size the problem from data already on disk first (`list_experiments`,
`get_experiment` on past runs, `get_pr` for the PRs in question, `get_session` to read what agents
did), test the mechanism offline second, and only then spend on agent sessions — a small run (two reps
per PR, an executed oracle, Sonnet) before any large one. The answer may already exist.

## 2. PR set

`list_pr_sets` first: reuse a PR set when it fits the question, so results compare across experiments.
Otherwise `create_pr_set` from a task set (`list_task_sets`). Task sets live in Artemis's database: add one
with `import_task_set` (a JSON file, or a file at a git ref; its gold diffs come along), read it with
`get_task_set`, and set a task's loop criteria with `set_acceptance`. Each change is a new version; a PR
set keeps the version it was drawn from, so changing a set means a new PR set:

- **Write the selection rule before seeing any result** ("every PR merged after 2026-09-20 that
  changes posthog/ and has tests"). The rule is saved with the set and shown on every experiment.
- Prefer PRs with their own tests (`oracle: tests`): graded without a judge.
- Transfer only: never PRs whose fix, or traces of whose earlier runs, are in a cache.
- The set must pass its checks: the checkout is at the task set's base, and no PR's fix is merged in
  it. A failing check means the checkout or task set is wrong — fix that, do not work around it.

## 3. Cache

`list_caches`: a cache fits a PR set when its row shows ✓ for it. To build one, `plan_cache`:

- **anchor**: the PR set's base or earlier (the PRs' fixes must be after it);
- **llm** and **model**: the agent CLI and the exact model the experiment's agent will run (matched
  models: AGENTS.md);
- **limit**: changes to mine (60 by default; 20 was too shallow to cover tasks).

- **kind**: `mined` (default) or `understanding`: notes on how the code works, read from the `top` files
  (200 by default) with the most recent commits before the anchor, optionally only in `areas` (a
  developer's focus directories). Understanding notes serve best with `values["ce-views"]: "multi"` and a
  hook `budget` of about 1500 (they run about 400 tokens each).

Show the user the plan (repository, anchor and its date, kind, model, limit or top, steps) and wait for a yes, then
`build_cache` and follow it with `get_progress` / `get_cache`. The build is the product's own path —
`mine-prs --git` or `understand`, then `phrase`, `relink`, in a checkout whose history stops at the
anchor — and it fails closed: a build that saved nothing or failed on more than a fifth of its work,
an empty cache, or a note not from the kind's own source marks it failed. Never serve exploration, synthetic sessions, distilled
eval traces, hand-written notes or an old noteset of unknown provenance.

## 4. Design the experiment

| Decision | Rule |
|---|---|
| **Question** | One question the result can answer yes or no: "Does the prompt hook cut tool calls for Sonnet on PostHog PRs?" |
| **Kind** | `behavior` or `model`. |
| **Arms** | `off` (`nocache`) always; `on` the product as it ships (`cache`/`hook` for Claude Code, `full` for Codex) unless the question is about a variant; an extra arm (e.g. `irrelevant`, placebo notes) only when the question needs it — each costs a full arm of sessions. |
| **Another tool** | Defined as data, not code: `define_arm` (MCP servers, hooks, system text, env, a before/after command per session, paths kept out of the diff; `{cwd}` is the worktree), then named as an arm against `nocache`. An arm with `notes: false` is served no notes; when no arm is, the experiment takes no cache. |
| **Agent** | The cache's building model (the plan blocks otherwise). `flags["strict-model"]: true` where the runner has it. At least 2 reps per PR × arm. |
| **Grading** | The PRs' tests when every PR has them. Otherwise a judge must be named (`judge`) and approved; judged numbers compare only with the same judge. |
| **Loop** (optional, Codex) | `flags.loop` with `values.checker` (a named model) and limits (`iterations`, `iteration-min`, `session-min`, `token-cap`): each session iterates, resumed with a checker's feedback, until every PR's `acceptance` criteria are met or a limit is hit. Every PR needs `acceptance` written from the request and base code, never the gold. The headline leads with done within limits; report false done beside it. See bench/evals/README.md, "Loop experiments". |
| **Tag** | `<repo>-<model>-<what>-<date>`, new for a new experiment. Reusing a tag resumes it. |

## 5. Plan, then get approval — mandatory

`plan_experiment` with the modules (`prset`, `cache`, arms, agent, grading, `tag`). It returns the
modules, every check, `blocked`, the session count and an estimate. A blocked plan cannot start: fix the
module the failing check names (a new PR set or cache), never the check.

Then **stop and show the user**, in one message: the question and kind; the PR set (name, rule, PRs);
the cache (name, anchor, mining model, notes); the arms; the agent; the grader; sessions = PRs × arms ×
reps; the estimate (tokens, spend at list price, wall time, its basis); the checks. Wait for an explicit
yes. "Run two benchmarks" means two PRs, not two suites: when in doubt, ask, and default to the smallest
plan that answers the question. A changed plan needs a new approval.

## 6. Start and follow

`start_experiment` with the **same arguments** and `sessions` from the plan (the app refuses a plan that
changed or is blocked). It records the experiment, its modules and the checks in the database, and
returns a `job_id`.

Follow with `get_progress` (`tag`, `log: true` when something looks wrong) every several minutes — not in
a tight loop; a session takes minutes. For Claude Code runs `live` shows each running session's steps
and the tool it is in. A person follows the same on the experiment's own page. Watch for:

- `waiting_on_limit`: the runner hit a usage limit and waits; tell the user rather than retrying.
- `errors` > 0: read the failing sessions (`get_experiment` → `invalid_sessions`, then `get_session`).
- no new result for far longer than the estimate: read the log tail.

Stop only experiments and builds you started, with `cancel_experiment`. Runs started from a terminal by
someone else appear in progress too; leave them alone.

## 7. Read the result

`get_experiment` returns, per arm, the comparison against cache off over **pairs** (same PR and rep,
both valid): each metric's off and on value, the mean paired difference, its 90% bootstrap interval and
a verdict; the same over only the pairs where the cache served a note; PR outcome counts; a per-PR
table; the invalid sessions with reasons.

Before believing a difference, check:

1. **Invalid sessions.** Usage limits, runner errors, turn caps, answer-key `leak`s. Many invalid
   sessions on one arm bias the pairs; say so.
2. **Served.** `served_pairs` of `pairs`. A cache arm that was rarely served measures little; read
   `metrics_when_served`. If sessions the cache never reached beat cache off, something other than the
   cache differs between the arms — stop and find it.
3. **The interval.** `no clear difference` means the interval includes zero: report it as no detected
   effect, not as a small win or loss. `too few pairs` means no claim.
4. **The grader.** Name it with every pass rate (`graded_by`).
5. **Per PR.** Is the effect one PR or many (`per_pr`, `prs.gained` / `prs.lost`)?
6. **What happened.** For the PRs that flipped, read the sessions: `get_session` with `filter:
   "thinker"` shows what the cache served and what the agent did with it; `other_arms` steps to the
   same PR and rep with the cache off. Transcripts are stored in the database; a session whose transcript shows the product's warm-up
   offer is marked invalid, since that text is meant for a person, not a benchmark arm.

## 8. Report

Lead with the answer to the question. For each arm against cache off (an illustrative line; the names are made up):

> **hook vs nocache** — Sonnet, PostHog, PR set `posthog-hard-oct` (14 PRs × 3 reps), cache
> `posthog-sonnet-a3b3c36` (212 notes mined at a3b3c36), 41 pairs (35 served), graded by the PRs'
> tests. Pass 12/41 → 8/41, −10 pts (90% −20 to 0): no clear difference. Input tokens −12.5k (−86k to
> +64k): no clear difference. Wall time +20s (+11s to +30s): **cache worse**. 2 invalid sessions (usage
> limit), excluded.

- Paired differences with intervals and pair counts, never two unpaired averages.
- Name the PR set and the cache with every result: they are what the number is about.
- Tokens compare within one model only; across models, compare spend.
- A row where a PR is re-run with knowledge from its own earlier run is a recall check: label it and
  keep it out of the headline.
- Link the experiment (`http://127.0.0.1:<port>/#/exp/<tag>`) and the sessions you quote
  (`#/session/<tag>/<id>`).

Older experiments have no recorded modules and their caches no provenance: say so when quoting them.
Record what an old experiment tested with `define_experiment` (name, question, kind, off, on).

## Do not

- build a cache or start a run without an approved plan, or widen a run beyond what was approved;
- run the harness scripts or `mine-prs` directly, or another harness to get "a quick number";
- serve a cache that was not built by the platform from merged PRs before the PR set's base, by the
  agent's model;
- change a PR set after results exist — make a new one;
- hand-compute or re-derive results from result files for a report;
- edit, move or delete result files, PR sets, cache receipts or transcripts;
- report a difference whose interval includes zero as an improvement or a regression.

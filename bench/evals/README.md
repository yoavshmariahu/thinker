# Evals app

Benchmark experiments, compared cache off against cache on. A local web app, and an MCP server so
an agent can read results and start experiments through it.

```bash
PORT=$(~/.claude/bin/claude-port reserve thinker evals) npm run evals
# options: --bench <dir with runs/ tasks/ repos/> (default: this checkout's bench/), --db <file>

claude mcp add evals -- node bench/evals/mcp.js   # finds the app through claude-port, or set EVALS_URL
```

The app binds 127.0.0.1 only and refuses cross-origin POSTs and foreign `Host` headers, because it
starts agent sessions. Release the port with `claude-port release thinker evals` when done.

## Experiments and their modules

An experiment is one directory `bench/runs/<tag>/`: a set of PRs in one repository, run with the
cache off and with it on, to test one **behavior** (a cache feature, prompt, wiring) or one **model**
(how a model does with the cache). It is put together from modules, each made and checked on its own:

| Module | Stored | Checks before an experiment may start |
|---|---|---|
| **PR set** (`prsets.js`): PRs from one task set, the rule they were chosen by, frozen with a hash | `bench/prsets/<name>.json` | the checkout is at the task set's base; no PR's fix is merged in it |
| **Cache** (`caches.js`, `build-cache.js`): mined by the product (`mine-prs --git`, `phrase`, `relink`) in a checkout cut at an anchor commit, by a named model | `bench/caches/<name>/receipt.json` (checked in), `repo/` and `build.log` (not) | built; not empty; every note `source.type: pr`; notes unchanged since the build (hash); same repository; anchor at or before the base; no PR's fix reachable from the anchor; mined by the agent's model |
| **Arms** | experiment | cache off and cache on differ |
| **Agent**: runner, model, reps, concurrency, switches | experiment | the model is the cache's mining model |
| **Grading**: the PRs' tests, or a named judge | experiment | a judge is named when any PR lacks tests |

A plan with a failing check comes back `blocked` and cannot be started. A cache build fails closed:
mining that saved nothing or failed on more than a fifth of its changes, an empty cache, or a note
from anywhere but a PR marks the receipt failed.

The experiment's definition is `bench/runs/<tag>/experiment.json`, beside the results and versioned
with them; a launched experiment records its modules and the checks it passed:

```json
{ "name": "Prompt hook · Sonnet · PostHog", "question": "Does the prompt hook help Sonnet on PostHog PRs?",
  "kind": "behavior", "off": "nocache", "on": "hook", "launched": [{ "command": "…", "at": 0 }] }
```

Experiments started from the app write it before the first result. Older runs have none: the app
infers cache off (`nocache`, `before`, `control`) and cache on (`cache`, `hook`, `full`, `thinker`, …)
from the arms, and **Define it** on the experiment page (or `define_experiment`) records the rest.
A run without a cache-off arm (two tools side by side) gets a comparison once one arm is named the
reference.

## Comparison

Every number is paired: the same PR and rep on both sides, both valid. Both columns are computed
over the pairs, so they describe the same sessions as the difference.

- **Headline**: one card per metric (pass rate, input tokens, tool calls, wall time, output
  tokens, spend), a bar for every arm, and beside each arm its difference from cache off, coloured
  where the 90% bootstrap interval excludes zero. With more than two arms (a placebo, another
  wiring) every arm is compared against cache off on the same page.
- **Only where the cache served a note** recomputes everything over the pairs whose cache arm
  was shown a note.
- **PR outcomes**: per arm, PRs gained, lost, passing both ways, failing both ways.
- **Every metric** table: value, difference and interval per arm.
- **Per PR**: every rep of every arm, its input tokens and the difference from cache off; a row
  opens the reps side by side, a square the full session (diff, judge, tests, final message).
- **PRs** page: each PR pooled over the experiments that ran it, and its history across them.

## Sessions and transcripts

Every session has a page (`#/session/<tag>/<id>`): its transcript as steps — the request, the agent's
messages and thinking, every tool call with its result, the thinker bundle and tool calls marked —
filterable to agent, tools, thinker or errors, beside a sidebar of its figures (outcome and grader,
turns, wall time, tokens by class, spend, tool calls by tool, calls before the first edit, files read,
notes served and their ids, the judge's reason and criteria, the test tail) and links to the same PR
and rep in the other arms.

Transcripts are archived by the app into `bench/runs/<tag>/transcripts/<id>.jsonl.gz` as results
appear, from where each CLI writes them (Claude Code `~/.claude/projects/<cwd>/<session>.jsonl`,
deleted after its cleanup period; Codex `bench/runs/<tag>/events/<id>.jsonl`; Gemini
`~/.gemini/antigravity-cli/brain/<session>/…/transcript.jsonl`). They are not checked in (about 80 kB
a session compressed); a session whose transcript was cleaned up before the app ran says so.

## Data

`bench/runs/<tag>/<task>-<arm>-<rep>.json` stays the source of truth. The app indexes it into
SQLite (`bench/evals/evals.db`, ignored, rebuilt on start, rescanned every 15 s; a directory is
re-read only when a file in it changed). `normalize.js` maps every record variant the three
runners have written onto one row:

| Field | From |
|---|---|
| outcome | the PR's tests (`grade.tests`) → a criteria judge (`grade.criteria`, `grade.pass`, a `.judge.json` sidecar) → the patch judge's score (pass = 1.0). Orientation tasks keep a score and no pass. Every outcome names its grader; a grade without a judge field is labelled `sonnet (default)`, the runners' default. |
| tokens | input (fresh + cache read + cache write), each class where recorded, output; Gemini `usage` mapped onto the same classes |
| served | the arm injected a note or the agent called a thinker tool |
| invalid | runner error, usage limit, answer-key leak, session error, 60-turn cap, timeout, failed grading, or a diagnosis-only directory (`invalid/`, `empty-notes`, contaminated runs). Left out of every number and listed on the experiment. |
| started | the earlier of the record files' mtime and the commit that first added the run (regrading rewrites the files) |

## Starting an experiment

**New experiment** takes the question, a PR set, a cache, the arms, the agent and the grader. The
plan step shows every module's checks, the number of agent sessions, what grades them, and an
estimate from past valid results of the same model (on the same repository when there are at
least four); the run starts only after it is confirmed, and only if the plan has not changed since.
The command (`bench/run.js`, `codex-run.js` or `gemini-run.js`) runs detached in its own process
group with output in `bench/runs/<tag>/harness.log`, so it survives the app restarting; Cancel
signals that group only. A tag that already holds results resumes: the runners skip them.

**Progress** follows experiments started here and any `bench/*run.js` started from a terminal (found
in the process table, its checkout read from its working directory), counting result files against
the planned PR × arm × rep sessions. A running experiment's page shows its progress too.

## MCP tools

| Tool | |
|---|---|
| `list_experiments` | every experiment with its paired cache-off → cache-on headline, intervals and verdicts |
| `get_experiment` | definition, every arm against cache off (all metrics, and only-served), PR outcomes, per-PR table, invalid sessions |
| `get_pr` | one PR across experiments |
| `get_session` | one session: its figures, the other arms' sessions for the same PR and rep, and its transcript as steps (filter, page), optionally its diff |
| `list_task_sets` | task sets, checkouts, runner defaults |
| `list_pr_sets`, `create_pr_set` | PR set modules, and freezing a new one with its selection rule |
| `list_caches`, `get_cache` | cache modules: receipts, checks against each PR set, experiments that used them |
| `plan_cache`, `build_cache` | validate a cache build; build it after the user approved the plan |
| `define_experiment` | write the name, question, kind, cache-off and cache-on arms |
| `plan_experiment` | validate and price, start nothing |
| `start_experiment` | start a planned experiment; needs the plan's session count, refused if the plan changed. The tool tells the agent to get the user's approval of the plan first. |
| `get_progress`, `cancel_experiment` | follow and stop runs |

# thinker — a knowledge cache for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified in a batch at most once every four hours. The cache
maintains itself under a daily token cap, without anyone running commands.

Note refreshes run on the first repository activity after the four-hour interval,
using changed dependencies and git diffs since each note was verified. Reading a
note never starts verification. Between batches, stale notes retain their warning
and prompt hooks withhold them. `thinker verify` requests an immediate check;
`thinker maintain` respects the four-hour interval (`--dry` previews the work).

**With Claude Fable on real tasks, the cache cut wall time, lowered token usage, and raised the correctness score.**

```
wall time            without thinker  ████████████████████  2.7 min
                     with thinker     █████████████████░░░  2.3 min 14% faster

input tokens         without thinker  ████████████████████  1.25M
                     with thinker     ████████████████░░░░  1.02M   18% less tokens

correctness score    without thinker  ████████████████░░░░  80%
                     with thinker     ██████████████████░░  89%     +10% improved
```

[See the benchmark](#benchmarks).

Integrates with Claude Code, Codex CLI, Gemini CLI, Cursor, Pi, Windsurf Cascade, GitHub Copilot CLI and OpenCode. [Hook coverage and limitations](docs/agent-integrations.md). Research prototype.

## Install and start

Open [zerotime.dev](https://zerotime.dev), enter your access code, and run the
private install command shown there. The same code unlocks the docs. It
installs the tool and wires it into the agents on this machine, once, in their
own settings (hooks and the MCP server, for Claude Code, Codex, Gemini CLI and
Cursor, their desktop apps included). Run from inside a repository, it also
sets that repository up; anywhere else, `thinker setup` inside a repository
does that later. `setup` offers to build the cache from the repository's code
and merged pull requests (`--build` says yes without asking, `--no-build` says
no; without it the cache grows from your own sessions). The wiring is
everywhere, the cache is per repository: in a repository that has not been
set up the agents are served nothing and learn nothing.

Then work with your agent as usual. The notes that bear on each request are
chosen on your machine by a small local ranking model; no extra account or key
is needed.

To check the value on your own repository after setup, run the paired onboarding benchmark on a question the cache covers or a recent PR change:

```bash
# Pick a question the cache covers (Enter takes the first), or type your own
thinker benchmark

# Or benchmark a recent PR change (compares efficiency & target file location)
thinker benchmark pr [number]

# Show the latest comparison again
thinker benchmark report
```

It makes two read-only agent calls, without and with relevant thinker notes,
and compares time, turns and tokens. It saves both answers under
`.thinker/benchmarks/` so you can review quality; it does not pretend that
speed alone is a correctness score. `thinker benchmark run "<question>"` runs
a question directly; if the cache does not cover it well enough, no agent
calls are made and Thinker offers questions it does cover.

Notes:

- **Requirements.** git, curl, tar, Node 20+, and at least one of the agents above, logged in.
- **What it does.** Installs the tool under `~/.thinker`, wires it into the
  agents found on the machine (their own settings; `thinker uninstall --user`
  takes it out again), and builds a cache of notes from the repository's git
  history, merged pull requests and source areas.
- **Usage.** Building runs through about 5.5M tokens of your agent's usage with
  the defaults, most of them cached prompt reads, and takes about twenty
  minutes. The estimate, in tokens and minutes, is printed before anything runs;
  nothing is given in dollars, since the agent's login is often a subscription.
- **Already have a cache?** Use `--cache <file|url>` instead of `--build`.
  See [ONBOARDING.md](ONBOARDING.md) for all options.

## Large repositories: choose your project

During `thinker setup`, choose **Full repo** or **Specify project directories**.
For a project, enter a name and comma-separated directories such as
`apps/web, packages/ui`. Thinker saves `thinker.project.json` in the repository
root and estimates the build using those directories.

You can also create the selection without running setup:

```bash
thinker project init apps/web packages/ui --name "Web app"
thinker seed --dry          # preview the exploration areas, without model calls
thinker setup --build       # build using the saved project
```

The project file is small and editable:

```json
{
  "version": 1,
  "name": "Web app",
  "directories": ["apps/web", "packages/ui"]
}
```

Paths are relative to the repository root. `setup`, `seed`, and `mine-prs` use
this file automatically; `--project other.project.json` selects another file,
and `--full-repo` uses the whole repository for one run. Exploration adapts to
source size and directory structure: small related files share a session, and
large directories split into groups with explicit file lists. There is no default
session cap. `--areas N` caps sessions and reports the areas left unexplored;
`--areas 0` skips exploration. Preview the groups with `thinker seed --dry`.
Setup estimates usage from the resulting session count before building.
`thinker project show` prints the selection.
The file can be committed or kept personal using `.git/info/exclude`.

Project builds explore selected directories and mine changes touching them.
GitHub history is scanned in bounded batches; `thinker mine-prs` continues
through older history on later runs. Exploration may follow dependencies outside
the selection to explain the selected code. All notes go into the same local
repository cache: retrieval, review, and ongoing learning remain repository-wide.
File and symbol dependencies already connect notes to relevant paths for retrieval;
the project file adds no retrieval filter.

## Your local cache

Thinker learns and stores notes locally in `.thinker/local/notes/`, which is
ignored by Git. It does not publish notes or synchronize them with a team.
Older committed notes remain readable; updates to those notes stay local.
Local storage does not mean all processing is offline: learning, verification
and review run through your configured agent or model provider.

Use `thinker export backup.tgz` and `thinker import backup.tgz` for personal
backup and restore. There is no `share`, `sync`, or `setup --shared` workflow.
Old sync settings are ignored.

## Proof of correctness

Thinker can post a PR report connecting the requested behavior to executed test
results, code evidence, and the questions a reviewer still needs to resolve.
For example, a change that makes a running app's auto-pause react in two
seconds instead of five can show that `pauses within two seconds of a stop`
passed, while flagging that the filter it removed was the fix that stopped runs
pausing under bridges, where the GPS reports zero speed with no fix.

With a verification contract committed on the trusted base and acceptance
criteria linked to named tests in `task.json`, run:

```sh
thinker review --run --base origin/main --task task.json --pr 142 --post
```

This runs the required checks in Docker against a frozen snapshot, assesses the
code, and posts the report as a PR conversation comment through your `gh` login.
Run it from the PR's checkout; `--pr` selects the comment destination only.
The report distinguishes observed results from the model's reading of test
coverage, and identifies skipped tests, missing evidence, and changes that may
weaken verification. Full logs stay local.

A passing test establishes that its assertions passed on that snapshot; a human
still judges whether they cover the request. This is local execution evidence,
not a formal proof or signed CI attestation. Existing CI checks still apply.
See the [visual example](https://zerotime.dev/docs.html#proof-of-correctness)
and [setup and posting guide](docs/task-verification.md#proof-of-correctness-on-a-pull-request).

## Review a change against the cache

For verification while an agent is implementing a task, use `thinker review
--start --base origin/main --task task.json`, then `thinker review --status
<run-id>`. It captures a snapshot, runs a trusted-base Docker contract, and
returns structured failures plus a human report showing task context, executed
checks, and changes that may weaken verification. See [task verification](docs/task-verification.md)
for setup, MCP usage, and the limits of local evidence.

```bash
thinker review                      # the working tree against HEAD
thinker review --staged             # what is about to be committed
thinker review --base origin/main   # the branch since its merge base
thinker review --base origin/main --pr 123 --post  # comment using your gh login
thinker review --ref <commit>       # one commit, read from git alone
thinker review --state src/auth/    # no change: the current code against the notes on it
```

`--post --pr <number>` adds a new PR conversation comment using your authenticated
GitHub CLI (`gh auth login`), including findings, file locations, and desired
behaviors. It works on your own PRs and needs no bot or server. Each invocation
adds a comment, including when there are no findings. `--pr` alone only links the
review to usage history; it does not select or check out the PR, so run this from
the correct checkout and choose the review scope with `--base` or the other flags.
`--post --dry` is rejected. With `--json`, the result includes `comment.url`.

A review is for two things: a change that undoes a fix the team already made,
and a change that breaks a convention or a desired behavior the cache holds.
Measured on real PostHog history, it caught every regression of a fix the
cache held a note about, including the ones a plain reading of the diff
missed, and nothing in brand-new code beyond what the model finds unaided,
which on real new-code bugs was close to nothing. So it says up front when
most of the changed code carries no note: there it is only a model reading a
diff.

It makes two model calls and merges what they find: one sees the diff and the
code it touched, as any reviewer would; the other sees the notes resting on
the changed code and the notes that bear on it by the identifiers it writes
(a convention written against other files, say). Every finding carries a
file, a line, the evidence it rests on and the note it came from, when one
does; the same regression seen in the code, its test and its docs is one
finding with its other places listed:

```
thinker review: working tree against HEAD, 2 files; 3 notes consulted (2 on the changed code, 1 related), 3 assessed with sonnet (~60k tokens)

Findings: 1 error, 0 warnings, 0 info
  error    src/core.py:5  Command.invoke no longer calls validate(ctx); main dereferences ctx  [note validate-before-main, 90%]
           evidence: -        validate(ctx) | return self.main(ctx)
           also at: tests/test_core.py:12 (the test that covered the check was deleted)

Cache state:
  - 1 consulted note was already stale before this change (its claims were weighed accordingly): cli-and-core-change-together (src/cli.py:entry: symbol body changed)
  - re-check it: thinker verify cli-and-core-change-together
  - no cached knowledge rests on: src/new_module.py; the review is blind there
```

Desired behaviors are the exception. A `behavior` note is a rule a person
wrote down about what the system must do and where that is upheld (`thinker
system add`, or `thinker system promote <id>` for an invariant the cache
already holds); the code must conform to it, and a review never finds one
outdated. A `fixed` behavior is never revised and code that stops upholding it
is an error; a `mutable` one may be revised, but only by a change that edits
the note itself. Every behavior in play is listed in the report with its
outcome, and `thinker system` shows all of them with whether the code upholds
each (`thinker system md` writes them as `.thinker/SYSTEM.md`):

```
Desired behaviors (2 in play; thinker system lists them all):
  violated   [fixed] Every command validates its context before running (ctx-validated-before-main): fixed behavior ... is no longer upheld
  revised    [mutable] The CLI entry validates before invoking (entry-validates-too)  — the change edits the behavior note
```

Agents reach them through `lookup` with `kind: "behavior"`, which lists every
behavior (or the ones about a query) before a change is made.

The cache is treated as evidence, not truth. Before anything is assessed, each
consulted note is re-hashed against the code **before** the change: a note that
already disagreed with the code is reported as drift of the cache, the model is
told so, and a note the model finds wrong comes back as `note_outdated` instead
of a finding against the change. Two checks need no model and run even when no
provider is available or with `--dry`: a file that the git history says changes
along with a changed file and is missing from the change, and a definition the
change removes that the rest of the checkout still refers to. Nothing in the
cache is rewritten by a review; the change under review may never be merged.

Measured on planted and reverted bugs in two repositories (`bench/RESULTS.md`,
"Review strategies"), this caught 15 of 16 bugs with no false positive on the
controls reached, in about 70k tokens and two minutes a review through
Claude Code's CLI. `--max n` caps the notes shown (default 12, the ones on the
changed code first), `--model` picks the model (`reviewModel` in
`.thinker/config.json`, default `sonnet`), `--chunks n` reviews a large change
in chunks of files, `--verify` re-checks every finding with a second call,
`--json` gives the report as data, and `--strict` exits 2 on an error-severity
finding, for CI.

Review is a mode you run, not a tool an agent calls: it makes several model
calls over the whole change, takes minutes, and its findings need a person. Ask
for it when you want it:

```
thinker review                      # the working tree against HEAD
thinker review --base origin/main   # everything on this branch
thinker review --staged             # what is about to be committed
thinker review --ref <commit>       # one commit, read from git alone
thinker review --state src/auth     # no change: today's code against the notes on it
thinker review --run                # the verification contract in Docker, then review a frozen snapshot
```

While you are *writing* the change, the cache reaches you another way and needs
no command: the prompt hook puts the notes resting on what you are working on
into each request, and the edit hook adds the rules resting on a file as you
edit it.

The notes a review draws on most are records of past fixes: what the symptom
was, where the root cause sat, what kind of change resolved it. `thinker
mine-prs` writes them from merged pull requests; a repository whose work lands
by direct commits has few of those, and `thinker mine-prs --git --fixes` mines
the commits whose message says they fix something instead.

`thinker setup --build` also drafts desired behaviors. After PR mining and
exploration, one bounded model call turns up to twelve fresh PR or document
rule notes into candidate requirements.
`thinker system propose` shows each draft's wording, source, code anchors and
reason; `thinker system accept <proposal-id>` makes a selected draft a mutable
behavior (`--fixed` is available for a deliberately permanent rule). Drafts
live in `.thinker/local/behavior-proposals.json` and do not affect serving or
review until accepted. This stage does not claim that a test establishes the
behavior; inspect the source and tests before acceptance.

Notes nobody was served in 30 days (and any kind named under `archive` in the
config) are archived
rather than served, and review still reads them: `thinker archive --list` shows them, `--restore` brings one
back, and `archive` in `.thinker/config.json` sets the rules or turns them
off.

## Optional review before committing

Enable staged code review for this checkout after running `thinker setup` with
an updated installation:

```sh
git config --local thinker.reviewBeforeCommit true
```

The pre-commit hook runs `thinker review --staged --strict` when enabled.
Error-level findings, fixed behavior violations, or failed assessments stop the commit;
warnings alone do not. Review uses your configured model and can add latency and token
usage to each commit. It checks the staged diff and refuses to proceed if the index
changes during review. `THINKER_NO_LEARN=1` skips note repair but does not skip an
enabled review. Disable the review with `git config --local thinker.reviewBeforeCommit false`.
This is opt-in and does not require pull requests or a GitHub App.

## Delivery outcomes

Thinker works with direct commits as well as pull requests; it does not prescribe
your Git workflow. The delivery metrics below currently use PRs as their unit of
measurement. Commit-only work still appears in usage, but is not counted as merged PRs.

`thinker impact` connects recorded agent work and reviews to merged pull requests:
observed tokens per PR, merge timing, and confirmed defects fixed before merge.

```sh
thinker impact sync --days 30                  # read PRs and commits through your gh login
thinker impact                                # delivery summary and measurement coverage
thinker impact --pr 142 --json                 # sessions, findings, fixes, and token evidence
thinker impact link --session <id> --pr 142    # correct or supply attribution
thinker review --base main --pr 142            # retain this review's findings and usage
```

Sessions are linked automatically only when their observed commit movement belongs
to one synced PR. Explicit links can split work across PRs. Reviews retain stable
finding IDs across identical reruns; a disappearance is never counted as a fix.
A confirmed, fixed finding counts only when its fixing commit belongs to the PR
and falls between the finding and merge. Confirmation is explicitly human-reported.

Missing counters and unlinked work remain visible. The median uses PRs with complete
counters for their linked recorded sessions; it does not imply that all contributors
or subagents were recorded. Shared learning/setup overhead is shown separately.
No improvement over a baseline is claimed without comparative evidence.

See [the delivery measurement guide](docs/delivery-outcomes.md) for finding decisions,
CI imports, accounting rules, and the versioned JSON format for a future dashboard.

## Cache usage and savings

Run `thinker stats` for a machine-wide dashboard of activity, agent usage,
learning, estimated reading avoided, and reported model tokens, with a breakdown
by repository and the current checkout's cache details. `--here` limits activity
to this repository, `--days 7` shows the last week, and `--json` includes the full
data (the original `repo`, `notes`, `status`, `kinds`, and `uses` fields still
describe the current checkout). Repositories are discovered from the configured
usage log; clones and worktrees sharing an origin are grouped together. Cache
counts are current, even when activity is filtered by date.

Run `thinker usage --here` to compare this repository's cache spending with its
estimated savings, or `thinker usage` for every repository on the machine.
`--days 7` limits the period; `--json` includes spending by operation, provider/model,
and repository.

One number in it is measured rather than estimated. The hooks serve nothing in
15% of sessions (chosen by a hash of the session id, so a session is held out
for its whole length; `holdout` in `.thinker/config.json` or `THINKER_HOLDOUT`
changes the share or turns it off), and the stop hook records what each session
cost by its own transcript: tool calls, model turns, input tokens. The
"Holdout" section of `thinker usage` compares the sessions that got notes with
the ones that had notes withheld, as medians per model, once five sessions
stand on each side. Sessions where nothing would have been served are on
neither side. This is what the notes do for your own work, on your own
repository, by your own agent, and it is the number to hold the cache's
spending against.

The report separates cache initialization (exploration, PR mining, seed distillation
and phrasings), ongoing session distillation, and maintenance. It records reported
input/output tokens, provider prompt-cache reads/writes, and missing usage. Model calls that produce no notes, dry-run distillations, and
failed attempts count too. Tokens reported before an invalid model answer are retained;
failures without counters remain unknown. Nothing is given in dollars: the agents run on
subscriptions as often as on metered keys, so a price from an API list would mislead.

The token balance subtracts both injected notes and reported build/maintenance tokens
from estimated file-reading tokens avoided. Savings still require a session assessment
that the note was used. This is a token comparison: tokens of different models and of
cached input are counted alike. Older logs omitted tokens and setup exploration,
so historical totals cannot establish full payback. A limited date range also excludes
setup spending outside that period.

Session learning uses the working agent's `remember` and `feedback` tools first:
save a reusable finding while its evidence is already in context. Background
learning selects at most 12,000 characters of source evidence from the transcript:
the first request, the last answer, failures and corrections with what followed
them, and the most recent tool calls. Routine exploration and cache hits alone do not
trigger discovery. Notes are assessed only when discussed explicitly or when a
failure/correction touches their dependencies; omitted evidence stays unknown,
not “unused.” Only returned assessments are checkpointed as assessed.

`learn.auditRate` in `.thinker/config.json` selects a stable sample of sessions
(default 0.05) for the fuller, 70,000-character trace path. Set it to 0 to disable
sampling, or 1 to audit every eligible session. Small, uneventful sessions still
skip learning; `learn.quietExplore: 0` retains an explicit opt-in to processing
every eligible session. The log records `learningMode` (`evidence`, `assessment`,
`audit`, or `full`) and trace size so quality and spending can be compared.

`thinker distill <transcript> --dry --evidence` previews the compact path;
without `--evidence` or `--incremental`, an explicit distill retains the fuller
trace as its fallback when semantic selection is disabled or unavailable. Both dry runs call a model but save no notes. Compact discovery
requests at most 3,000 output tokens, assessment alone 1,500, and full distillation
6,000. Claude CLI receives these per-request output limits, disables optional
thinking, and limits structured-output attempts; provider retries can still add
usage. These bounds reduce input and output, not guarantee a measured saving or
identical note quality.

To evaluate a cheaper distillation model, compare the same transcripts with
`thinker distill <transcript> --dry --model <model>`, then inspect usage and note quality.
`--dry` still calls a model and records its usage, but does not save notes. The existing
`distillModel` setting in `.thinker/config.json` chooses the default distiller for session
learning and PR mining; an explicit `--model` or `THINKER_LLM_MODEL` takes precedence.
The report's no-new-note/no-merge counts help identify low-yield runs, though those runs
may still assess existing notes. Keep quality and downstream task correctness in the
comparison, not just note count.

## Benchmarks

Real tasks from merged pull requests, each run with and without the cache. Evaluated on Claude Fable (20 pairs via Claude Code), Gemini 3.8 Flash (14 pairs via Antigravity CLI), and OpenAI GPT-6 Astra (21 pairs via Codex CLI), all independently graded on calibrated acceptance criteria.

| Dimension | Metric | Claude Fable (Claude Code) | Gemini 3.8 Flash (Antigravity CLI) | OpenAI GPT-6 Astra (Codex CLI) |
|---|---|---|---|---|
| ⏱️ **Timing** | **Wall clock time** | **14% faster** | **8.5% faster** | **7.0% faster** |
| 🪙 **Token Usage** | **Input context** | **18% less tokens** | **21% less tokens** | **19% less tokens** |
| | **Output tokens** | **11% less output** | **22% less output** | **11% less output** |
| 🔍 **Tool Efficiency** | **Tool calls** | **17% fewer calls** | **22% fewer calls** | **18% fewer calls** (won 71% of tasks) |
| | **File reads / exploration** | *(tracked in tool calls)* | **27% fewer file reads** | **14% less exploration** |
| 🎯 **Correctness** | **Criteria accuracy** | **+10% improved** | **Parity** (0% diff) | **Parity** (within noise) |
| | **Tasks fully solved** | **+33% more solved** | **Parity** (0% diff) | **Parity** (15 vs 16 solved) |

### Key Takeaways for Users

- **⏱️ Timing:** Eliminates blind repo exploration and prevents rabbit holes, cutting wall time by **7% to 14%** (saving up to **100+ seconds** on complex Grafana tasks).
- **🪙 Token Usage:** Pre-seeded architecture notes reduce input tokens and context re-reads by **18% to 21%**.
- **🔍 Tool Efficiency:** Reduces tool calls across every evaluated agent harness — Claude Code (**-17%**), Codex CLI (**-18%**, lower in 15 of 21 tasks), and Antigravity CLI (**-22%**).
- **🎯 Correctness:** On frontier models (Claude Fable), thinker boosts overall correctness by **+10%** and lifts complete task passes from **45% to 60%** (+3 tasks). Fast and frontier models (Gemini Flash, GPT-6 Astra) maintain strict correctness parity (within single-run noise).

Method, uncertainty, per-task results and other models:
[bench/RESULTS.md](bench/RESULTS.md).

## Updates and testing branches

Thinker auto-updates daily in the background. To check or update manually at any time:

```bash
thinker update
```

S3/archive installs check `version.json` beside their saved private download URL
and verify the release checksum without GitHub credentials. Git checkouts update from their
Git remote. Daily updates run on invocation and, when installed, through the OS
scheduler; they are not an immediate push to every client.

Linux containers without `crontab` use the invocation check automatically.
Pass `--no-auto-update` to the installer to skip OS scheduling. To also disable
invocation checks, set `THINKER_NO_AUTO_UPDATE=1` when running thinker;
`thinker update` remains available for manual updates. After an update the new version
rewrites the hooks and MCP entries of every repository it is wired into, so a new hook
event reaches them without `thinker setup` being rerun (`thinker rewire` does it by hand).

Clients installed before 0.1.1 may be unable to update without GitHub access.
Refresh the updater once: sign in at [zerotime.dev](https://zerotime.dev), copy
the private install command, and replace its final `| bash` with
`| bash -s -- --update`. This preserves the existing home and telemetry settings
and saves the private download URL for unattended updates.

To test a specific branch version:

```bash
# Switch to a branch version (or tag)
thinker switch <branch-name>
# or: thinker update <branch-name>

# Check current branch
thinker branch

# Switch back to main
thinker switch main
```

See `thinker update --status` for current install and schedule details, or `thinker update --schedule` / `thinker update --unschedule` to manage OS-level background updates.

## Running tests and benchmarks

`npm test` enables test mode automatically. For a benchmark or scratch experiment,
set one inherited environment flag:

```bash
THINKER_TEST=1 node bench/your-benchmark.js
```

Test mode blocks production telemetry and automatic updates, learning, verification,
and automatic git-hook reviews. Usage logs default to the checkout, and machine-wide agent hooks
stay quiet. Explicit commands such as `distill`, `verify`, and `maintain` still work;
MCP tools remain available. Existing per-feature controls still work when an experiment
needs them. Set `THINKER_HOOKS=on` only when testing machine-wide hook serving;
automatic background work stays disabled. Explicit `THINKER_HOME` or `THINKER_LOG`
settings override the default log location.

This flag affects processes that inherit it; it does not stop an already-running
worker or an independently scheduled OS job. Use isolated homes and worktrees for
integration tests that intentionally exercise installation or scheduling.

## Metrics and telemetry

Thinker records pseudonymous installation and daily effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. Full PR evidence stays local; refresh PR metadata with `thinker impact sync`. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning, verification and review send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

The device hash is independent of `THINKER_HOME`. It can change after OS reinstallation, and cloned VMs or containers may share an identifier. If the OS identifier is unavailable, the device remains unknown. Test runs allow telemetry only to local test servers; they do not send it to production.

```bash
thinker telemetry              # inspect current metrics summary, schedule and transmission status
thinker telemetry --send       # send metrics manually
thinker telemetry --schedule   # schedule hourly background transmission (LaunchAgent / cron)
```

To opt out at any time, set `THINKER_TELEMETRY=off` in your environment or set `"telemetry": false` in `.thinker/config.json`.

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](infra/metrics/README.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): setting up your local cache

## License

MIT. See [LICENSE](LICENSE).

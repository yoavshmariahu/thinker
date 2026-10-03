# thinker — a knowledge cache for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified in the background; the cache maintains itself, under a
daily spend cap, without anyone running commands.

**With Claude Fable on real tasks, the cache cut wall time, lowered token usage and cost, and raised the correctness score.**

```
wall time            without thinker  ████████████████████  2.7 min
                     with thinker     █████████████████░░░  2.3 min 14% faster

input tokens         without thinker  ████████████████████  1.25M
                     with thinker     ████████████████░░░░  1.02M   18% less tokens

cost per task        without thinker  ████████████████████  $2.72
                     with thinker     ██████████████████░░  $2.45   10% cheaper

correctness score    without thinker  ████████████████░░░░  80%
                     with thinker     ██████████████████░░  89%     +10% improved
```

[See the benchmark](#benchmarks).

Works with Claude Code, Codex CLI, Gemini CLI and Cursor. Research prototype.

## Install and start

Open [zerotime.dev](https://zerotime.dev), enter your access code, and run the
private install command shown there from inside your repository. The same code
unlocks the docs.

Then work with your agent as usual. Notes are added to each request
automatically.

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
- **What it does.** Installs the tool under `~/.thinker`, builds a cache of
  notes from the repository's git history, merged pull requests and source
  areas, and wires it into the agents found on the machine.
- **Cost.** Building costs roughly $9 of agent usage with the defaults. The
  estimate is printed before anything runs.
- **Already have a cache?** Use `--cache <file|url>` instead of `--build`.
  See [ONBOARDING.md](ONBOARDING.md) for all options.

## Share a cache with your team

Sessions learn into `.thinker/local/notes/`, which ignores itself in git. The
repo cache lives in `.thinker/notes/` and is shared through ordinary commits
and pull requests. Both caches are served together. Usage, staleness, confidence
changes and pending corrections to shared notes stay local, so serving notes
does not change committed files.

```bash
thinker share --dry       # review eligible notes and reasons others are skipped
thinker share             # write eligible notes into .thinker/notes/
git diff -- .thinker/notes/
git add .thinker/notes/
# Commit and open your normal pull request.
```

A note must be fresh, have matching dependencies and pass content checks. Notes
from a person, documentation or a merged PR are eligible; agent notes need at
least one confirming session assessment. `thinker share <id>…` or `--all` skips
only that trust gate. Near-duplicates, machine home paths, common secret patterns,
missing dependencies and bodies over 12,000 bytes are rejected. Review the result
before committing. Pending corrections are shared by the same command; a shared
note retired locally is removed from the repo cache when shared.

Maintenance gives a one-time notice when new notes are ready in a repository
with a shared cache. Set `"share": true` in `.thinker/config.json` to enable
notices before sharing the first note. `thinker list` labels notes `local` or `repo`.

Run `thinker init` to install the git hooks in an existing checkout. Before a
commit, `pre-commit` checks shared notes against **staged** code. It corrects
safe metadata issues, asks the configured small model whether notes affected by
code changes remain valid, and rewrites or removes notes that cannot be kept
valid. Each changed note's original bytes are saved under
`.thinker/local/quarantine/`. The hook changes the staged note and its working
copy only when that copy has no separate unstaged edits. Model work can add
latency and cost to a commit. `THINKER_NO_LEARN=1` disables this hook for
fixed-cache experiments.

`pre-push` reports any issues left in the commits being pushed and **always
allows the push**. It cannot edit a commit that Git has already selected for
pushing. `thinker share --check` is also report-only by default, including in
CI; `--strict` opts into a failing exit status for manual audits. Existing custom
hooks are preserved. After a commit or merge, `post-commit` and `post-merge`
check the cache in the background and run maintenance with learning enabled.
Local corrections still need `thinker share` to enter the repo cache.

For CI, fetch the target branch and report on the committed cache (replace
`main` with your default branch):

```bash
git fetch origin main
THINKER_TELEMETRY=off thinker share --check --base origin/main
```

`--ref <commit>` selects a commit other than `HEAD`. Without `--base`, validation
uses the merge-base with the cached remote default branch. New-branch pushes do
the same; fetch/set `origin/HEAD` if that reference is unavailable.

On first use, untracked notes from the old `.thinker/notes/` layout move into the
local cache; tracked notes stay shared. No tracked file is rewritten by migration.
`thinker export` packs the effective notes from both caches, including local state;
`thinker import` loads an archive locally, with updates to shared IDs kept as
pending corrections. Review archives before distributing them.

### A central cache for the team

Commits share notes at the pace of pull requests. To have every checkout learn
from every session, run `thinker-server` (one Node process; `infra/sync/` deploys
it to EC2 behind TLS) and point each checkout at it once:

```bash
thinker sync login https://sync.example.com --token <token from the server>
thinker sync status
```

From then on the hooks and background maintenance do the rest: notes the server
learned arrive in the local cache before the next prompt; notes learned here that
pass the same trust gate as `thinker share` go up; verifications, corrections and
retirements travel both ways, with the server's version winning a conflict; and
each session is streamed to the server as it ends, where it is distilled against
the server's clone of the repository with one model key for the whole team.
Merged pull requests reach the server from CI through the GitHub Action in
`action/` (`action/README.md`). Committed notes in `.thinker/notes/` keep
working as before and are never overwritten by a pull. `THINKER_SYNC=off`
switches syncing off for one run; `thinker sync logout` for the checkout.
## Review a change against the cache

```bash
thinker review                      # the working tree against HEAD
thinker review --staged             # what is about to be committed
thinker review --base origin/main   # the branch since its merge base
thinker review --ref <commit>       # one commit, read from git alone
thinker review --state src/auth/    # no change: the current code against the notes on it
```

A review makes two model calls and merges what they find: one sees the diff
and the code it touched, as any reviewer would; the other sees the notes
resting on the changed code and the notes that bear on it by the identifiers
it writes (a convention written against other files, say). Every finding
carries a file, a line, the evidence it rests on and the note it came from,
when one does:

```
thinker review: working tree against HEAD, 2 files; 3 notes consulted (2 on the changed code, 1 related), 3 assessed with sonnet ($0.19)

Findings: 1 error, 1 warning, 0 info
  error    src/core.py:5  Command.invoke no longer calls validate(ctx); main dereferences ctx  [note validate-before-main, 90%]
           evidence: -        validate(ctx) | return self.main(ctx)
  warning  src/core.py  src/cli.py changed together with src/core.py in 80% of its commits (n=12) and is not in this change  [git history]

Cache state:
  - 1 consulted note was already stale before this change (its claims were weighed accordingly): cli-and-core-change-together (src/cli.py:entry: symbol body changed)
  - re-check it: thinker verify cli-and-core-change-together
  - no cached knowledge rests on: src/new_module.py; the review is blind there beyond git history
```

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
controls reached, at $0.16 to $0.25 and about two minutes a review through
Claude Code's CLI. `--max n` caps the notes shown (default 12, the ones on the
changed code first), `--model` picks the model (`reviewModel` in
`.thinker/config.json`, default `sonnet`), `--chunks n` reviews a large change
in chunks of files, `--verify` re-checks every finding with a second call,
`--json` gives the report as data, and `--strict` exits 2 on an error-severity
finding, for CI. Agents have the same review as the MCP tool `review`, for a
check before they commit.

## Cache cost and savings

Run `thinker usage --here` to compare this repository's cache spending with its
estimated savings, or `thinker usage` for every repository on the machine.
`--days 7` limits the period; `--json` includes spending by operation, provider/model,
and repository.

The report separates cache initialization (exploration, PR mining, seed distillation
and phrasings), ongoing session distillation, and maintenance. It records reported
input/output tokens, provider prompt-cache reads/writes, dollar cost when available,
and missing usage. Model calls that produce no notes, dry-run distillations, and
failed attempts count too. Tokens reported before an invalid model answer are retained;
failures without counters remain unknown. No model pricing is guessed, and CLI dollar
figures are provider-reported usage costs, not necessarily an extra subscription charge.

The token balance subtracts both injected notes and reported build/maintenance tokens
from estimated file-reading tokens avoided. Savings still require a session assessment
that the note was used. This is a token comparison, not measured dollar ROI: models and
cached inputs have different prices. Older logs omitted tokens and setup exploration,
so historical totals cannot establish full payback. A limited date range also excludes
setup spending outside that period.

To evaluate a less expensive distillation approach, compare the same transcripts with
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
| 💰 **Cost** | **Cost per task** | **10% cheaper** | **16% cheaper** | *(flat rate / subscription)* |
| 🎯 **Correctness** | **Criteria accuracy** | **+10% improved** | **Parity** (0% diff) | **Parity** (within noise) |
| | **Tasks fully solved** | **+33% more solved** | **Parity** (0% diff) | **Parity** (15 vs 16 solved) |

### Key Takeaways for Users

- **⏱️ Timing:** Eliminates blind repo exploration and prevents rabbit holes, cutting wall time by **7% to 14%** (saving up to **100+ seconds** on complex Grafana tasks).
- **🪙 Token Usage & Cost:** Pre-seeded architecture notes reduce input tokens and context re-reads by **18% to 21%**, directly lowering cost per task by **10% to 16%**.
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
`thinker update` remains available for manual updates.

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

## Metrics and telemetry

Thinker records pseudonymous installation and daily effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. No prompt text, note bodies, code snippets, file paths, or repository URLs are collected or transmitted.

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
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

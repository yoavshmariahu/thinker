# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

Run `curl -fsSL https://zerotime.dev/dist/install.sh | bash`. It
installs the tool and wires it into the agents on this machine, once, in their
own settings (hooks and the MCP server, for Claude Code, Codex, Gemini CLI and
Cursor, their desktop apps included). Run from inside a repository, it also
sets that repository up; anywhere else, `thinker setup` inside a repository
does that later. `setup` offers to build the cache from the repository's
merged pull requests (`--build` says yes without asking, `--no-build` says
no; without it the cache grows from your own sessions). The build comes in two
depths: **full**, the newest 60 merged pull requests, or
**shallow**, the most valuable 30% of them (the newest), for a quicker, cheaper start. Setup offers both with their
estimates; `--depth full` or `--depth shallow` picks one without asking. The wiring is
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
  history and merged pull requests.
- **Code parsing.** A note is tied to the functions and classes it describes, and
  goes stale when one of them changes. For Python, JavaScript, TypeScript, Go
  and Rust thinker finds those definitions with a tree-sitter parser, which
  comes with the install (about 50 MB) and needs no setup; `thinker ast` shows
  whether it is loaded. Other languages, and code the parser cannot read, use
  a text heuristic. What it works out is cached under `~/.thinker/cache`, so
  the first run after an install or update is slower than the rest.
- **Usage.** Building runs through roughly 700k to 900k tokens of your agent's
  usage with the defaults (60 merged pull requests) and takes about ten
  minutes. The estimate, in tokens and minutes, is printed before anything runs;
  nothing is given in dollars, since the agent's login is often a subscription.
- **Already have a cache?** Use `--cache <file|url>` instead of `--build`.
  See [ONBOARDING.md](../ONBOARDING.md) for all options.

## Large repositories: choose your project

During `thinker setup`, choose **Full repo** or **Specify project directories**.
For a project, enter a name and comma-separated directories such as
`apps/web, packages/ui`. Thinker saves `thinker.project.json` in the repository
root and estimates the build using those directories.

You can also create the selection without running setup:

```bash
thinker project init apps/web packages/ui --name "Web app"
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

Paths are relative to the repository root. `setup` and `mine-prs` use
this file automatically; `--project other.project.json` selects another file,
and `--full-repo` uses the whole repository for one run. A build reads
merged changes only: it does not explore the code, and there is no command that
does. Setup estimates usage from the number of pull requests before building.
`thinker project show` prints the selection.
The file can be committed or kept personal using `.git/info/exclude`.

Project builds mine the changes touching the selected directories.
GitHub history is scanned in bounded batches; `thinker mine-prs` continues
through older history on later runs. All notes go into the same local
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
Refresh the updater once with
`curl -fsSL https://zerotime.dev/dist/install.sh | bash -s -- --update`. This preserves
the existing home and telemetry settings and saves the download URL for unattended updates.

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

Thinker records pseudonymous installation and daily effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. They also send the 30-day holdout comparison as totals: how many sessions got notes and how many had them withheld, and the summed tool calls, model turns and input and output tokens of each side, overall and per model name. Full PR evidence stays local; refresh PR metadata with `thinker impact sync`. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning, verification and review send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

The device hash is independent of `THINKER_HOME`. It can change after OS reinstallation, and cloned VMs or containers may share an identifier. If the OS identifier is unavailable, the device remains unknown. Test runs allow telemetry only to local test servers; they do not send it to production.

```bash
thinker telemetry              # inspect current metrics summary, schedule and transmission status
thinker telemetry --send       # send metrics manually
thinker telemetry --schedule   # schedule hourly background transmission (LaunchAgent / cron)
```

To opt out at any time, set `THINKER_TELEMETRY=off` in your environment or set `"telemetry": false` in `.thinker/config.json`.

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](../infra/metrics/README.md).


# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

Run `npx @zerotimedev/thinker`. It runs the installer carried in the npm package of that
name (published with each release) and passes its options through. The installer does
two things in the terminal and asks nothing there:

1. It installs the [latest GitHub release](https://github.com/yoavshmariahu/thinker/releases)
   of the tool under `~/.thinker`.
2. It wires thinker into the agents on this machine, once, in their own settings
   (hooks and the MCP server, for Claude Code, Codex, Gemini CLI and Cursor, their
   desktop apps included). `thinker connect` does this step alone.

From then on thinker runs in every git repository on this machine: a cache starts,
empty, with the first agent session in a repository (kept out of `git status` through
`.git/info/exclude`) and grows from your sessions. The hooks start serving from it once
it holds a few notes (three; `minNotes` in `.thinker/config.json` changes that), so a
young cache costs a session nothing. The MCP tools are there from the start; a server
started outside a repository (a container, a desktop app) binds to the repository of the
first call that names the agent's working directory. The first session in a repository
also writes what `thinker setup` would there (the git hooks that keep the cache fresh after a
commit or merge, Codex's trust in the project, Cursor's rule), and when the repository has
merged pull requests or enough commits to read, the agent is told once to offer you a
warm-up; on a yes it runs `thinker warmup --repos <checkout> --yes --terminal` itself. The
turn's notice says the same once, so nothing needs running by hand.

Warming a cache reads the repository's merged pull requests into it, so the first
session there already finds notes. The installer ends with `thinker warmup`, which asks
where to choose the repositories: the local page in your browser, or the terminal, which
shows the ten most recently used with the top five picked (arrows move, Space toggles a
row, Enter continues, Esc skips), each at full depth around your areas with `thinker setup --build`. Before
building, choose the harness with ↑/↓ and Enter. Thinker automatically uses Haiku for
Claude Code and Cursor, Luna for Codex, or Gemini Flash for Gemini. One selection applies
to every repository picked. Over ssh, or
on a machine with no display, only the terminal is offered: the page serves 127.0.0.1 of
the machine it runs on. `thinker warmup` runs again any time, and inside a repository lists that one first; `thinker warmup --skip`
and `--yes` answer without asking. Use `--agent codex --model gpt-6-sol`, for example,
to specify both without the menus. Depth and directories can also be chosen on the page.
Direct `thinker setup --build` uses the same automatic model after harness selection.
Explicit `--model`, `THINKER_LLM_MODEL`, and repository model settings remain available
for scripts and advanced use; `--yes` skips the harness menu.

## Setting up on the local page

`thinker ui` serves a page from your own machine (127.0.0.1 only, with a token minted
for that run) and opens it in the browser. It works from any directory, and the
installer opens it for you the first time.

**1. Pick repositories.** The warm-up view lists the git repositories your agents
worked in over the last 30 days, most recent first, found from the agents' own session
records, along with the ones thinker has seen before. The five you used most recently
are picked for you. One that already has a cache is marked and left unpicked. Each row
shows when the repository was last used, how many sessions ran there, and an estimate
of the build in tokens and minutes.

**2. Choose how much to read, per repository.**

- **Full** reads the newest 60 merged pull requests. **Shallow** reads the newest 30%
  of them, for a quicker, cheaper start.
- **Directories**: a build reads around where you are most active, the directories
  your own commits touch (the row says **Your areas**), so the cache is warm where you
  work rather than wherever the newest pull requests happen to be. Pick other
  directories for a large repository where you work in one part, or clear the
  selection to read the whole repository (the generic build). Maintenance keeps
  warming the same areas afterwards.
- The **switch** on a row turns thinker off for that repository, in every clone and
  worktree: for one with sensitive content that no model should read. `thinker disable`
  and `thinker enable` do the same from the terminal.

**3. Choose the harness.** The bar at the top lists the agent CLIs found on the
machine and says whether each is signed in. The model is selected automatically and
shown beside the harness. A build runs through that agent's own
login; no other account or key is needed. The bar adds up the tokens and time of
everything picked.

**4. Press Start building,** or **Skip for now**. Skipping builds nothing: every cache
still grows from your sessions, and the warm-up view stays one click away ("Warm up
more repositories" on the Cache view, or `thinker ui --tab warmup`).

**What a build does.** The builds run one at a time, in the background, each as its
own process. A build reads the repository's merged pull requests, fixes first, and
distills them into notes; it does not explore the code. Then it links the notes and writes the search phrasings the ranker uses, and last, as
an optional stage (`--no-docs` skips it), reads the design documents checked in (READMEs
beside the code) for the rules they state, at most eight a build; maintenance reads the
rest over time. On a terminal the build shows one progress bar: the share done, the
time left, and what is being mined or read. Closing the browser tab does not stop a
running build.

**Watching and stopping.** The Cache view shows each repository as a card. A running
build shows its stage ("mining 12/60 PRs"), the notes saved so far, the time left and
a **Stop** button; a queued one shows its estimate and a **Remove** button. Stopping keeps
every note saved so far. If a build does not finish, its card names the log to read,
`~/.thinker/state/warmup-<repository>.log`.

**After setup.** The same page is where you look at the result: the Usage view (notes
served, what agents did with them, tokens spent, the holdout comparison) and the Cache
view (each repository's notes, with the code they point at, to archive or restore).
The page stops by itself after half an hour unused, once no build is queued;
`thinker ui` opens it again.

### From the terminal instead

`thinker setup` does for one repository what the page does, with prompts:
`thinker setup --build [--depth shallow]` builds its cache, `--no-build` only wires
the repository and lets the cache grow from sessions. Use it on a machine without a
browser, or in a script (`--yes` skips the prompts). See
[ONBOARDING.md](../ONBOARDING.md) for the flags.

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
- **What it does.** Installs the tool under `~/.thinker` and wires it into the
  agents found on the machine (their own settings; `thinker uninstall --user`
  takes it out again). Caches are built from the local page, for the repositories
  you pick there.
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

On the local page, pick directories on the repository's row. From the terminal,
during `thinker setup`, choose **Full repo** or **Specify project directories**.
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
repository cache: retrieval and ongoing learning remain repository-wide.
File and symbol dependencies already connect notes to relevant paths for retrieval;
the project file adds no retrieval filter.

## Your local cache

Thinker learns and stores notes locally in `.thinker/local/notes/`, which is
ignored by Git. It does not publish notes or synchronize them with a team.
Older committed notes remain readable; updates to those notes stay local.
Local storage does not mean all processing is offline: learning and verification
run through your configured agent or model provider.

Use `thinker export backup.tgz` and `thinker import backup.tgz` for personal
backup and restore. There is no `share`, `sync`, or `setup --shared` workflow.
Old sync settings are ignored.

## Updates and releases

Maintainers: see [Cutting a release](releases.md) for the manual PR, tag,
GitHub and npm release command.

Thinker auto-updates daily in the background. To check or update manually at any time:

```bash
thinker update
```

A release is a tag `vX.Y.Z` on GitHub with three files attached: `thinker.tgz`,
`version.json` (the version, the commit and the SHA-256 of the archive) and
`install.sh`. An install made by the installer reads the latest release's
`version.json`, and when it names a newer version downloads the archive, checks it
against the digest and swaps it in; no GitHub credentials are needed. Git checkouts
update from their Git remote. Daily updates run on invocation and, when installed,
through the OS scheduler; they are not an immediate push to every client.

Linux containers without `crontab` use the invocation check automatically.
Pass `--no-auto-update` to the installer to skip OS scheduling. To also disable
invocation checks, set `THINKER_NO_AUTO_UPDATE=1` when running thinker;
`thinker update` remains available for manual updates. After an update the new version
rewrites the hooks and MCP entries of every repository it is wired into, so a new hook
event reaches them without `thinker setup` being rerun (`thinker rewire` does it by hand).

Installs made before 0.1.35 downloaded from zerotime.dev. Their next update from
a release moves them to GitHub; an install that is stuck on the old host moves with
`npx @zerotimedev/thinker --update`,
which keeps the existing home and settings.

To pin a release, or go back to one:

```bash
# Install the release tagged v0.1.34
thinker switch v0.1.34
# or: thinker update v0.1.34

# Show the installed release
thinker branch

# Back to the latest release
thinker switch latest
```

A git checkout of the repository switches branches the same way (`thinker switch <branch>`).

See `thinker update --status` for current install and schedule details, or `thinker update --schedule` / `thinker update --unschedule` to manage OS-level background updates.

## Running tests and benchmarks

`npm test` enables test mode automatically. For a benchmark or scratch experiment,
set one inherited environment flag:

```bash
THINKER_TEST=1 node bench/your-benchmark.js
```

Test mode blocks production telemetry and automatic updates, learning and verification. Usage logs default to the checkout, and machine-wide agent hooks
stay quiet. Explicit commands such as `distill`, `verify`, and `maintain` still work;
MCP tools remain available. Existing per-feature controls still work when an experiment
needs them. Set `THINKER_HOOKS=on` only when testing machine-wide hook serving;
automatic background work stays disabled. Explicit `THINKER_HOME` or `THINKER_LOG`
settings override the default log location.

This flag affects processes that inherit it; it does not stop an already-running
worker or an independently scheduled OS job. Use isolated homes and worktrees for
integration tests that intentionally exercise installation or scheduling.

## Metrics and telemetry

Thinker records pseudonymous installation and effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. They also send the 30-day holdout comparison as totals: how many prompts got notes and how many had them withheld, how many were followed by a correction, and the summed tool calls, model turns and input and output tokens of each side, overall and per model name. Full PR evidence stays local; refresh PR metadata with `thinker impact sync`. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning and verification send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

The device hash is independent of `THINKER_HOME`. It can change after OS reinstallation, and cloned VMs or containers may share an identifier. If the OS identifier is unavailable, the device remains unknown. Test runs allow telemetry only to local test servers; they do not send it to production.

Hourly uploads are enabled automatically on installation and update, including
updates from older versions. They run independently of agent hooks and MCP calls:
LaunchAgent on macOS, cron on Linux, or a systemd user timer when cron is absent.
The machine and its scheduler must be running; a systemd user timer also needs an
active user manager. If scheduling fails, Thinker reports the error and retries
on a later invocation. `thinker telemetry --status` shows the failure.
Each upload contains the previous 24 hours of activity; hourly uploads do not
change that reporting window.

```bash
thinker telemetry              # inspect current metrics summary, schedule and transmission status
thinker telemetry --send       # send metrics manually
thinker telemetry --schedule   # retry or re-enable hourly background transmission
thinker telemetry --unschedule # disable the schedule, including across future updates
```

`THINKER_TELEMETRY=off` disables telemetry in processes that inherit it, including
automatic scheduling. OS jobs do not read your shell startup files. To opt out
machine-wide, including scheduled uploads, set `"telemetry": false` in
`~/.thinker/install.json` (or `$THINKER_HOME/install.json`); updates preserve it.
`--unschedule` stops scheduled uploads, while uploads triggered by CLI activity
remain enabled. Repository configuration also supports `"telemetry": false`.

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](../infra/metrics/README.md).


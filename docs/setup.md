# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

Run `npx @zerotimedev/thinker`. It runs the installer carried in the npm package of that
name (published with each release) and passes its options through. The installer does
three things in the terminal and asks nothing there:

1. It installs the [latest GitHub release](https://github.com/yoavshmariahu/thinker/releases)
   of the tool under `~/.thinker`.
2. It wires thinker into the agents on this machine, once, in their own settings
   (hooks and the MCP server, for Claude Code, Codex, Gemini CLI and Cursor, their
   desktop apps included). `thinker connect` does this step alone.
3. It reads the agents' own transcripts of the last 30 days in the five repositories they
   worked in most and prints where their context goes (instruction files, skills and MCP
   servers, built-in tools, tool outputs; per model call and per session) and what to cut
   first: the sections, skills and tools that cost the most in the sessions that did not
   use them, with the saving each is worth at most. No cache and no model call are
   involved, so the report is there from the first minute. `thinker context --machine`
   prints it again from any directory (`--repos n`, `--top n`, `--json`); each repository's
   report is kept for the page. On a machine with a display (not over ssh, not in CI) the
   installer then opens the local page on that report over every repository, where the
   suggestions are reviewed and applied (`--no-ui` leaves it closed; `thinker ui --tab
   context --all` opens it later). See [Context](context.md) for what the report measures.

From then on thinker runs in every git repository on this machine: a cache starts,
empty, with the first agent session in a repository (kept out of `git status` through
`.git/info/exclude`) and grows from your sessions. The hooks start serving from it once
it holds a few notes (three; `minNotes` in `.thinker/config.json` changes that), so a
young cache costs a session nothing. The MCP server offers the agent no tools (since
2026-10-22): it carries thinker's own questions and, in a desktop app, its learning queue.
The first session in a repository also writes what `thinker setup` would there: the git
hooks that keep the cache fresh after a commit or merge, and Codex's trust in the project.
Nothing reads the repository's history into the cache: the notes come from the sessions
there, each distilled once when it ends, through the agent's own login. Inside a desktop
app (Claude Desktop, the Codex app, Cursor), and wherever no agent CLI is signed in (a
desktop app's login does not sign in its CLI), Claude Code, Codex and Cursor learn through
the session instead, on the app's own login and model: the model calls are queued in
`.thinker/state`, and the agent starts a background subagent that answers them through
thinker's `learn_next` tool.

**Tools your sessions never use** (Claude Code and its desktop app, Codex; `thinker harness`). The
[Context page](context.md) shows every skill, MCP server and plugin loaded into your sessions with its cost
and use, and switching one off there turns the harness on for that repository. The rest of this paragraph,
the question asked in your prompts, is off by default and not yet released: nothing below
happens until `thinker harness --enabled on` in a repository (or a switch-off on the Context page). Once on,
`thinker harness --suggest` and the page do the same: for each repository with at least 10 sessions
recorded (`HARNESS.firstSessions`), the sources worth switching off, all picked, switched off only when the person
confirms. Claude Code records in each session's
transcript what it loaded: every MCP server's tool names and instructions, and the skill list. `thinker harness`
reads the last 30 days of this repository's sessions and lists each MCP server, plugin and skill with its tokens
per session and how many sessions used it. `--suggest` (and by itself every two weeks; a repository never looked at
with 10 sessions recorded is asked as soon as it has them; `maintain: { harness: false }` in `.thinker/config.json`
turns it off) has your next Claude Code prompt here ask you,
in one multiple-choice question signed 🧠 Thinker, which of the unused ones to switch off: at most five, each
option saying what the source is (the first sentence of its own listing), how many of the sessions that carried
it used it, what it costs, and what off means and how it comes back; the rest, built-in tools always among them,
are on the page (`thinker ui`, Context, All), which the question links to. The ones you pick go
off for this checkout (`enabledPlugins` and `skillOverrides` in `.claude/settings.local.json`, kept out of git)
or, for an MCP server, for the repository and its worktrees (`disabledMcpServers` in its entry of
`~/.claude.json`, what `/mcp disable` writes). A skill switched off still runs as `/name`. What each file said
before is kept under `~/.thinker/state/harness-backups/`, and `thinker harness --undo` turns everything back on.
The report and `thinker ui` (the Cache view's usage) then show what it saved, read from the sessions started since: a source
absent from a session saved its tokens there, once in the context and again in each model call; one still
loaded is shown as such, not counted.

**Coverage suggestions** (off until an experiment shows they help; `maintain: { coverage: true }` in
`.thinker/config.json` turns them on for a repository). The agent hooks count which directories your sessions read and edit
(locally, in `.thinker/state/access.json`, four weeks kept). About once a week, once there are at least five
sessions on three days, background maintenance picks up to five of the most worked-in directories that the
cache covers little (fewer than half their code files have a note), and on your next prompt your agent asks
you once which of them to build notes for, each with its estimated tokens. The ones you pick are read in the
background through your own agent's login: every code file in the directory, into notes on how the code there
works now (`thinker understand --areas <dir> --whole`). No directory chosen means not now (those wait a
month); "never" stops the suggestions on this machine. `thinker coverage` shows the activity and coverage
behind them. Inside a desktop app, and wherever no agent CLI is signed in, the build reads through the
session: a background subagent answers its model calls, so it reads the most changed code
of the chosen directories first, as much as one subagent's context holds (about 100k tokens of code), and a
later suggestion continues where it stopped.

## The local page

`thinker ui` serves a page from your own machine (127.0.0.1 only, with a token minted
for that run) and opens it in the browser, on the [Context page](context.md). It works
from any directory. The installer opens it on the Context view over every repository;
`thinker ui --tab context --all` does the same later.

- **Context** is where the agents' context goes and what to cut ([context.md](context.md)):
  input tokens a session by part, then each instruction section, skill and tool with its
  cost, use and waste, for one repository or all of them, over 7 or 30 days. Sections are
  compressed or removed as a diff you apply; skills and tools are switched off.
- **Cache** shows every repository on this machine with a cache as a card: its notes, fresh
  and stale, with the code they point at, to archive or restore; its behaviors, to accept,
  edit or discard; what is being distilled right now, with a Stop button; and the usage:
  notes served, what agents did with them, tokens spent, the holdout comparison.
- A repository with sensitive content is turned off with `thinker disable` inside it, and
  `thinker enable` turns it back on. Thinker then does nothing there, in every clone and
  worktree.

The page stops by itself after half an hour unused; `thinker ui` opens it again.

### From the terminal instead

`thinker setup` does for one repository what the installer does for the machine, with
prompts: it connects the agents, fetches the ranking model, and prints where the agents'
context goes in that repository and what to cut first, from its sessions so far (the first
setup of a repository opens the page; `--no-ui` leaves it closed). `thinker context` prints
the report again, and `thinker context --machine` prints it over the repositories the agents
worked in lately, from any directory. See [ONBOARDING.md](../ONBOARDING.md) for the flags.

Then work with your agent as usual. The notes that bear on each request are
chosen on your machine by a small local ranking model; no extra account or key
is needed.

To check the value on your own repository once the cache holds notes, run the paired benchmark on a question the cache covers or a recent PR change:

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
  takes it out again).
- **Code parsing.** A note is tied to the functions and classes it describes, and
  goes stale when one of them changes. For Python, JavaScript, TypeScript, Go
  and Rust thinker finds those definitions with a tree-sitter parser, which
  comes with the install (about 50 MB) and needs no setup; `thinker ast` shows
  whether it is loaded. Other languages, and code the parser cannot read, use
  a text heuristic. What it works out is cached under `~/.thinker/cache`, so
  the first run after an install or update is slower than the rest.
- **Already have a cache?** `--cache <file|url>` at install imports one (an
  export made with `thinker export`). See [ONBOARDING.md](../ONBOARDING.md) for all options.

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

Thinker checks for updates every 4 hours in the background. To check or update manually at any time:

```bash
thinker update
```

A release is a tag `vX.Y.Z` on GitHub with three files attached: `thinker.tgz`,
`version.json` (the version, the commit and the SHA-256 of the archive) and
`install.sh`. An install made by the installer reads the latest release's
`version.json`, and when it names a newer version downloads the archive, checks it
against the digest and swaps it in; no GitHub credentials are needed. Git checkouts
update from their Git remote. The checks run on invocation and, when installed,
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
The MCP server still starts. Existing per-feature controls still work when an experiment
needs them. Set `THINKER_HOOKS=on` only when testing machine-wide hook serving;
automatic background work stays disabled. Explicit `THINKER_HOME` or `THINKER_LOG`
settings override the default log location.

This flag affects processes that inherit it; it does not stop an already-running
worker or an independently scheduled OS job. Use isolated homes and worktrees for
integration tests that intentionally exercise installation or scheduling.

## Metrics and telemetry

Thinker records pseudonymous installation and effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. They also send the 30-day holdout comparison as totals: how many prompts got notes and how many had them withheld, how many were followed by a correction, and the summed tool calls, model turns and input and output tokens of each side, overall and per model name. Full PR evidence stays local; refresh PR metadata with `thinker impact sync`. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning and verification send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

The device hash is independent of `THINKER_HOME`. It can change after OS reinstallation, and cloned VMs may share an identifier. Where the OS identifier is unavailable, as in most Docker containers, the hash is derived the same way from your user name and git email (`git config --global user.email`), so a rebuilt container keeps its device; the reports say which (`deviceSource`: `os` or `user`), the email is never sent, and the hash is saved in `THINKER_HOME/state/device-id`. Without a git email the device remains unknown. Inside a container, updates and reports run when thinker is used rather than on a schedule. Test runs allow telemetry only to local test servers; they do not send it to production.

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


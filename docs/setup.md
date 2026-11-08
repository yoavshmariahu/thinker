# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

```bash
npx thinkersh
```

The installer connects your coding agents and shows suggested savings from recent sessions.
Choose the browser or terminal, review the suggestions, and apply the cuts you want.
Requires Node 20+, bash, git, curl, tar and a [supported agent](agent-integrations.md).

In the browser, **Find Savings** opens with suggestions checked. Review their actions and
uncheck anything you want to keep. Instruction changes are previewed as a diff, then opened
as a pull request for you to review and merge. Without a GitHub origin or authenticated `gh`,
they are written to your working tree, uncommitted. Skills and tools are switched off for
that repository. [See each action and its undo](context.md#what-you-can-cut).

In the terminal, use the arrow-key list to pick suggestions and apply them together.
Instruction changes are written to the working tree for `git diff`.

From here on thinker comes to you.

### What the installer does

1. Downloads the latest GitHub release into `~/.thinker`.
2. Connects your agents in their own settings, once for the machine.
3. Reads the last 30 days of sessions in your five most active repositories to estimate
   context costs and suggest cuts. Generating this first report needs no model call.

Over SSH or in CI, the browser is not offered; with no terminal, the report is printed.

## After the install

There are two ways in, and neither is a command to remember.

**The weekly suggestion.** About once a week, once a repository has ten sessions to read, your agent opens
its next reply with a short message from thinker: one line per change worth making (an instruction section to
shorten, a skill or MCP server your sessions never use, a tool whose output to compress), what each would have
saved over the last days, and the suggested action, with a link to the page. Reply with the numbers to approve
(or "all") and the agent applies them and tells you what changed (an instruction change approved this way is
written to your working tree, uncommitted, for `git diff`); open the link to review them first; or ignore
it and carry on. Nothing changes until you say so. `maintain: { contextSuggest: false }` in
`.thinker/config.json` turns it off for a repository.

**The page.** `thinker ui`, from any directory, opens it in your browser:

- **Find Savings** shows which instructions, skills and tools consume context, how often
  sessions use them, and what you can cut. It opens over every repository on the machine;
  pick one from the list. Over 7 or 30 days.
- **View Report** tracks session tokens or list-price costs over six weeks, by token type,
  context part and model, with your changes and the cache's savings below.
- **Recent activity** lists every change you made, with Retry, Close PR and Revert.

The page listens on 127.0.0.1 with a token for that run and stops after half an hour unused.
For the measurements, actions and how each is undone, see [Find Savings](context.md).

**Everything else runs by itself.** From the install on, thinker runs in every git repository on this machine:
a cache starts, empty, with the first agent session in a repository (kept out of `git status` through
`.git/info/exclude`) and grows from your sessions. Each session is read once when it ends, through the agent's own
login, into a profile of how you work in that repository: what you are in the middle of, how you want work done and
answers given, what went wrong before and the recent bugs. The profile goes into the first prompt of every later
session, and again after a compaction. Inside a desktop app (Claude Desktop, the Codex app, Cursor), and wherever no
agent CLI is signed in, Claude Code, Codex and Cursor learn through the session instead, on the app's own login and
model: the agent starts a background subagent that answers thinker's queued model calls.

Notes:

- **Switching it off.** To turn thinker off in one repository (sensitive content, say), run `thinker disable`
  there; `thinker enable` turns it back on. `{ "learn": { "profile": false } }` in `.thinker/config.json` keeps the
  profile off in a repository while the rest runs. To remove it, see the [README](../README.md#uninstall).

## Your local profile

Thinker keeps the profile locally in `.thinker/local/profile/`, which is ignored by Git, and never publishes or
synchronizes it. `thinker profile show` prints what a session is shown, `--why` the observations behind each line.
Local storage does not mean all processing is offline: reading a session runs through your configured agent or
model provider.

## Updates

Thinker updates itself: it checks for a new release every 4 hours in the background and on use.
A release is a tag `vX.Y.Z` on GitHub with three files attached: `thinker.tgz`,
`version.json` (the version, the commit and the SHA-256 of the archive) and
`install.sh`. An install reads the latest release's `version.json`, and when it names a newer
version downloads the archive, checks it against the digest and swaps it in; no GitHub
credentials are needed. After an update the new version rewires the agents it is connected to,
so nothing needs rerunning.

Pass `--no-auto-update` to the installer to skip OS scheduling; set `THINKER_NO_AUTO_UPDATE=1`
to also skip the checks on use. Maintainers: see [Cutting a release](releases.md).

## Metrics and telemetry

Thinker records pseudonymous installation and effectiveness metrics (requests, sessions, what the clearing saved, the profile's two arms as counts) to track performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. They also send the 30-day holdout comparison as totals: how many prompts got notes and how many had them withheld, how many were followed by a correction, and the summed tool calls, model turns and input and output tokens of each side, overall and per model name. Full PR evidence stays local. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning and verification send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

The device hash is independent of `THINKER_HOME`. It can change after OS reinstallation, and cloned VMs may share an identifier. Where the OS identifier is unavailable, as in most Docker containers, the hash is derived the same way from your user name and git email (`git config --global user.email`), so a rebuilt container keeps its device; the reports say which (`deviceSource`: `os` or `user`), the email is never sent, and the hash is saved in `THINKER_HOME/state/device-id`. Without a git email the device remains unknown. Inside a container, updates and reports run when thinker is used rather than on a schedule. Test runs allow telemetry only to local test servers; they do not send it to production.

Hourly uploads are enabled automatically on installation and update, including
updates from older versions. They run independently of agent hooks and MCP calls:
LaunchAgent on macOS, cron on Linux, or a systemd user timer when cron is absent.
The machine and its scheduler must be running; a systemd user timer also needs an
active user manager. If scheduling fails, Thinker reports the error and retries
on a later invocation.
Each upload contains the previous 24 hours of activity; hourly uploads do not
change that reporting window.

`THINKER_TELEMETRY=off` disables telemetry in processes that inherit it, including
automatic scheduling. OS jobs do not read your shell startup files. To opt out
machine-wide, including scheduled uploads, set `"telemetry": false` in
`~/.thinker/install.json` (or `$THINKER_HOME/install.json`); updates preserve it.
Repository configuration also supports `"telemetry": false`.

A report carries a pseudonymous device ID so two installations on one machine are
not counted as two machines. It is a thinker-specific hash of the OS machine
identifier (macOS `IOPlatformUUID`, Linux `/etc/machine-id`, Windows
`MachineGuid`); the identifier itself never leaves the machine. Where the OS has
none -- a container ships an empty `/etc/machine-id` -- it is derived from the
user name and the email `git config user.email` or `GIT_AUTHOR_EMAIL` gives, and
saved under `$THINKER_HOME/state/device-id`. With neither, the device stays
unknown rather than guessed: a guess would merge every container into one device.

`THINKER_DEVICE_ID=<any string>` names the device yourself, which is what a CI
runner pool, a devcontainer image or a cloud workspace needs -- each run is a new
machine to the OS, so without it they are either unknown or one device per run.
The value is hashed before it is sent, so a hostname or an account name in it
discloses nothing.

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](../infra/metrics/README.md).


# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

```bash
npx thinkersh
```

The installer connects your coding agents and shows suggested savings from recent sessions,
as a list in the terminal: review the suggestions, and apply the cuts you want.
Requires Node 20+, bash, git, curl, tar and a [supported agent](agent-integrations.md).

The suggestions come checked: use the arrow-key list to uncheck anything you want to keep, and
apply the rest together. An instruction change opens as a pull request for you to review and
merge; without a GitHub origin or authenticated `gh` it is written to your working tree,
uncommitted. Skills and tools are switched off for that repository.
[See each action and its undo](context.md#what-you-can-cut).

From here on thinker comes to you.

### What the installer does

1. Downloads the latest GitHub release into `~/.thinker`.
2. Connects your agents in their own settings, once for the machine.
3. Reads the last 30 days of sessions in your five most active repositories to estimate
   context costs and suggest cuts. Generating this first report needs no model call.

With no terminal, the report is printed.

## After the install

There are two ways in, and neither is a command to remember.

**Thinker itself.** It makes the changes that clearly pay without being asked: an instruction section nobody
needs is shortened or removed in a pull request (never in your working tree), a tool or MCP server nobody
calls is switched off. A change has to save $1 a day or more, the ones that do go out together as one batch
once they come to $5 a day, and a week later each is checked and taken back if it did not pay. Your next
session says once what it did, `thinker activity` lists it, and `thinker chat` is where you tell it to do
more, less or nothing (`upkeep: false` in `.thinker/config.json` stops it for a repository).

**The page.** `thinker ui`, from any directory, opens it in your browser:

- **Chat**, where it opens: talk to thinker. Ask what it did, and tell it how to behave ("ask me
  before you put up a pull request"). Beside the conversation is what it did lately, a line an
  action with what it saved; thinker makes the clearest context cuts itself. Over every
  repository on the machine; pick one from the list.
- **Factory** shows your sessions as a pipeline: what each stage cost, the loops, the
  first-pass yield of merged pull requests.
- **Recent activity** lists every decision with what it saved, with Retry, Close PR and
  Revert, and the merged pull requests with what the clearing saved on each.

Where the context goes part by part is `thinker context`; what a session costs week by week is
`thinker report`.

The page listens on 127.0.0.1 with a token for that run and stops after half an hour unused.
For the measurements, actions and how each is undone, see [Context cuts](context.md).

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
- **Switching it off for one session.** In Claude Code, `/thinker-disable` turns thinker off for the session it is
  typed in, and for that session only: its model requests go straight to Anthropic instead of through the context
  proxy, and thinker's hooks do nothing there (they still start, and return at once). Every other session, running
  or new, is unchanged. `/thinker-enable` turns it back on, and a resumed session stays the way it was left. Only
  thinker's own proxy route is taken away: with a gateway of your own or the Bedrock route the hooks go quiet and
  the route stays, and the command says so. The thinker MCP tools stay listed in the session. Needs a Claude Code
  that loads mods (the same one that draws the card under an answer).

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

The service that receives these reports is not part of this repository.


## Fleet dashboard (optional)

thinker needs no account. If your team has a fleet dashboard, a machine reports to it once it holds your
organisation's API key:

```bash
thinker config set api-key thk_live_...   # or set THINKER_API_KEY, e.g. as a CI secret
thinker status                            # fleet or local, the org, this machine's id, whether the fleet answers
thinker config unset api-key              # back to local
```

Without a key thinker makes no call to the fleet service at all. With one, it reports at most every five
minutes, only what changed since its last report, and never holds up an agent: if the service is slow or
down, thinker carries on locally and reports when it can. `THINKER_FLEET=off` forces local mode with a key
set, and `THINKER_MACHINE_ID` names a machine that is rebuilt for every job so it stays one row.

**What is sent:** this machine's id, hostname, operating system and thinker version; and for each agent
session its id, the agent's name, the model's name, the repository's name (never its URL), when it started and was last active,
and numbers: prompts, model calls, tokens, tokens cleared, and what the session cost and saved in dollars. For
each model call: its size, its cost and its turn, with no text. And what thinker did in the session: each
context cut with its size, the names of the tools whose results were cleared, whether your profile was
served, and reads handed to a subagent, by size and model.

**What is never sent:** prompts, completions, code, file paths, file contents, tool arguments or results, cache
contents, environment variables.

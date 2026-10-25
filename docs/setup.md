# Setup, updates and telemetry

The details behind the install line in the [README](../README.md).

## Install and start

```bash
npx @zerotimedev/thinker
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
`.git/info/exclude`) and grows from your sessions. The hooks start serving from it once it holds a few notes
(three; `minNotes` in `.thinker/config.json` changes that), so a young cache costs a session nothing. Each
session is distilled once when it ends, through the agent's own login; stale notes are re-checked after
commits and merges; nothing reads the repository's history into the cache. Inside a desktop app (Claude
Desktop, the Codex app, Cursor), and wherever no agent CLI is signed in, Claude Code, Codex and Cursor learn
through the session instead, on the app's own login and model: the agent starts a background subagent that
answers thinker's queued model calls.

Notes:

- **Code parsing.** A note is tied to the functions and classes it describes, and
  goes stale when one of them changes. For Python, JavaScript, TypeScript, Go
  and Rust thinker finds those definitions with a tree-sitter parser, which
  comes with the install (about 50 MB) and needs no setup. Other languages, and
  code the parser cannot read, use a text heuristic. What it works out is cached
  under `~/.thinker/cache`, so the first run after an install or update is slower
  than the rest.
- **Switching it off.** To turn thinker off in one repository (sensitive content, say), run `thinker disable`
  there; `thinker enable` turns it back on. To remove it, see the [README](../README.md#uninstall).

## Your local cache

Thinker learns and stores notes locally in `.thinker/local/notes/`, which is
ignored by Git. It does not publish notes or synchronize them with a team.
Older committed notes remain readable; updates to those notes stay local.
Local storage does not mean all processing is offline: learning and verification
run through your configured agent or model provider.

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

Thinker records pseudonymous installation and effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. Updated clients also send numeric 30-day delivery summaries: merged PR observations, recorded tokens, confirmed fixes, merge timing and measurement coverage. They also send the 30-day holdout comparison as totals: how many prompts got notes and how many had them withheld, how many were followed by a correction, and the summed tool calls, model turns and input and output tokens of each side, overall and per model name. Full PR evidence stays local. Reports include a persistent installation ID and a Thinker-specific device hash, so separate installations on the same OS instance can be grouped. The hash is derived locally from the OS machine identifier using HMAC-SHA256; the raw identifier is never sent. These telemetry reports contain no prompt text, note bodies, code snippets, file paths, or repository URLs. Learning and verification send what they need to your configured agent or model provider; disabling telemetry does not disable those model calls.

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

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](../infra/metrics/README.md).


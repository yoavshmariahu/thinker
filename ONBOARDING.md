# Setting up Thinker

Run the installer from your repository, then start a new agent session.
Use `thinker setup --build` to build a local cache from code and merged pull
requests, or `thinker setup --no-build` to learn from future sessions.

Notes are stored locally. Hosted Jev sends search inputs and learning evidence
through Thinker’s proxy to TypeSafe, as described below. Your configured agent
writes notes and performs review.
Personal backups use `thinker export backup.tgz` and
`thinker import backup.tgz`. Team sharing and server sync are not supported.

## Setup flow (`thinker setup`)

Setup has two steps:

1. **Connect your agents.** Detects installed coding agents and configures their hooks and MCP servers in the agents' own settings, once per machine (`thinker connect` does this step alone, anywhere); the repository gets its git hooks, Cursor's rule and Codex's trust. Codex trust is requested when needed. Only detected or explicitly selected agents appear in the connection summary.
2. **Choose how to start.** Learn from future sessions (the default), or build a cache now from code and merged pull requests. Choose **Full repo** or **Specify project directories**. For a project, enter a name and comma-separated repository-relative directories; setup saves `thinker.project.json`. Setup shows estimated build time and token usage for the selection before asking whether to build. Outside a terminal, building requires an explicit flag such as `--build`.

Jev note selection uses **Thinker hosted access**, provisioned automatically
with no personal TypeSafe key required, including with `--yes`.

Ongoing learning uses your agent to write notes and Jev to select evidence,
reconcile discoveries, and check source support and summary fidelity. Use `--no-learn` to disable it;
this does not disable Jev ranking.

The completion message shows the next step: start a new agent session in this repository. You can build later with `thinker setup --build`.

A paired PR benchmark runs during setup only when requested with `--benchmark` or `--pr <number>`. Its results are saved in `.thinker/benchmarks/`.

## Jev through Thinker

1. Run `thinker setup` to connect your agents and choose whether to build a cache.
2. Thinker provisions hosted Jev access automatically. No TypeSafe account or
   personal API key is needed; the upstream credential stays on Thinker's server.
   A revocable client token is saved in `~/.thinker/jev-proxy.json` with owner-only
   permissions and renewed on expiry.
3. Start a new agent session and work as usual. `thinker ranker` reports the
   selected ranking mode and local fallback availability.

Thinker sends descriptions of all eligible notes in bounded batches through its
proxy to Jev for `orient` and query-based `lookup`, without a keyword shortlist.
Current `search` descriptions are used where available; missing or outdated
descriptions fall back to the note body. A 0.5 relevance threshold selects up to
two notes for hooks or the explicit caller's limit. No qualifying notes means
none are served. The whole search has a five-second deadline. Errors, rate
limits, invalid responses, or timeouts fall back to local ranking: the
cross-encoder for hooks, then lexical ranking. Exact-ID lookups stay direct.

Your request and all eligible note titles, question phrasings, descriptions or
body excerpts, applicability, file/symbol pointers, and freshness pass through
Thinker's proxy to TypeSafe. Learning also sends selected transcript passages,
source evidence from sessions/PRs, proposed claims, and relevant complete notes.
Summary checks send the source note and proposed description. The proxy does not log this content. Hosted access has usage limits;
reaching one falls back locally. The cache stays local. Hosted enrollment and ranking are separate from
telemetry and from the coding agent used for learning, verification, and review.
`THINKER_TELEMETRY=off` does not disable these model calls.

### Use local ranking

Set `"jev": false` in `.thinker/config.json`, or set `THINKER_JEV=off` in the
agent's environment. This also disables Jev learning checks and retains the
local learning workflow. This works with both direct and hosted Jev. Environment
variables must reach the agent process that runs Thinker's hooks. If the local
fallback is missing, `thinker ranker fetch`
downloads the model; `thinker update` repairs a missing runtime.

### Existing personal keys

Personal TypeSafe keys are optional. A personal key uses TypeSafe directly. Keys are
read from `THINKER_JEV_KEY`, then `JEV_API_KEY`, then `TYPESAFE_API_KEY`, then
`~/.thinker/jev-key` (under `THINKER_HOME` if set).

To remove a saved personal key:

```bash
thinker ranker --no-jev-key
```

Unset any environment keys separately. Removing the personal key switches to
Thinker's proxy; it does not turn off Jev. Use `THINKER_JEV=off` or
`"jev": false` for local ranking.

See [the Jev retrieval evaluation](bench/RESULTS.md#serving-jev-2026-10-06-offline-all-54-labelled-tasks-two-runs)
for measured quality and its limits. Those offline timings do not measure
proxy latency. The paired benchmark below compares an agent with and without
selected notes; it does not compare hosted Jev against the local ranker.

## Choosing directories in a large repository

The scope menu uses arrow keys and Enter:

```text
What should Thinker build a cache for?
  Full repo
  Specify project directories
```

Choose the second option to enter, for example, `apps/web, packages/ui` and a
project name. Missing directories are reported so you can correct them. The
selection is saved even if you choose to build later. On later interactive setup
runs, the saved project is selected by default; choosing Full repo saves that
preference. `--no-build` skips the scope menu.

For scripts or a noninteractive install, create the file first:

```bash
thinker project init apps/web packages/ui --name "Web app"
thinker seed --dry
thinker setup --build --yes
```

Or save the selection directly with
`thinker setup --directories apps/web,packages/ui --name "Web app" --build --yes`.
`--yes` and noninteractive builds reuse the saved selection (or use the full
repo when no file exists). `--project other.project.json` chooses another file;
`--full-repo` overrides a saved project for this run. Directory paths always
start at the repository root, including when running from a subdirectory.

The project only chooses what to build. It does not hide existing notes or
restrict retrieval, review, or ongoing learning. The repository retains one
cache, with notes linked to their source files and symbols. See
[the project file format](README.md#large-repositories-choose-your-project).

## First-run benchmark

After the cache is built or imported, you can benchmark on a recent PR change or any repository question anytime:

```bash
# 1. Pick a question the cache covers (Enter takes the first), or type your own
thinker benchmark

# 2. Or benchmark a recent PR change
thinker benchmark pr [number]

# Name a question directly
thinker benchmark run "explain how an upload is authorized and persisted"

# 3. Reprint the latest result later
thinker benchmark report
```

The benchmark commands make two read-only calls through the same installed agent:
one without thinker context and one with the notes selected by `orient`. It
compares time, turns, tool calls when the agent reports them, tokens, and target files found. Both
answers are kept in `.thinker/benchmarks/` for a human quality check.

If the cache does not have sufficiently relevant notes for the question,
Thinker stops before making either agent call, confirms that no model usage was
spent, and prints up to three replacement commands drawn from distinct cached
topics. Copy one of the suggested commands and try again. If there are no
usable topics yet, run `thinker setup` to build the cache first.

This is a quick repository-specific signal, not a statistically conclusive
benchmark or an automatic correctness grade. Use `--agent codex` (or
`claude`, `cursor`, `gemini`) and `--model <name>` to pin the runner.

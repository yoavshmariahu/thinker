# Setting up Thinker

Run the installer from your repository, then start a new agent session.
Use `thinker setup --build` to build a local cache from code and merged pull
requests, or `thinker setup --no-build` to learn from future sessions.

Notes are stored locally. Hosted Jev receives request text and candidate note excerpts for ranking; the proxy does not log their content. Personal backups use `thinker export backup.tgz` and
`thinker import backup.tgz`. Team sharing and server sync are not supported.

## Setup flow (`thinker setup`)

Setup has two steps:

1. **Connect your agents.** Detects installed coding agents and configures their hooks and MCP servers in the agents' own settings, once per machine (`thinker connect` does this step alone, anywhere); the repository gets its git hooks, Cursor's rule and Codex's trust. Codex trust is requested when needed. Only detected or explicitly selected agents appear in the connection summary.
2. **Choose how to start.** Learn from future sessions (the default), or build a cache now from code and merged pull requests. Choose **Full repo** or **Specify project directories**. For a project, enter a name and comma-separated repository-relative directories; setup saves `thinker.project.json`. Setup shows estimated build time and token usage for the selection before asking whether to build. Outside a terminal, building requires an explicit flag such as `--build`.

Setup enables hosted Jev automatically, including with `--yes`, without asking
for an API key. A revocable client token is stored in `~/.thinker/jev-proxy.json`
with owner-only permissions. The 23 MB local ranker is still installed and takes
over on errors, quota limits, invalid responses, or calls exceeding 1.5 seconds.
Set `THINKER_JEV=off` in your environment or `"jev": false` in the repository's
`.thinker/config.json` for local ranking only. Existing personal Jev keys continue
to use direct access; they are optional.

Ongoing learning uses your agent for model calls. Use `--no-learn` to disable it;
this does not disable Jev ranking.

The completion message shows the next step: start a new agent session in this repository. You can build later with `thinker setup --build`.

A paired PR benchmark runs during setup only when requested with `--benchmark` or `--pr <number>`. Its results are saved in `.thinker/benchmarks/`.

## Using Jev

Hosted access needs no key. For optional direct access, get a key from the
[TypeSafe console](https://console.typesafe.ai/keys) and run:

```bash
thinker ranker --jev-key <your-typesafe-api-key>
thinker ranker
```

The key is saved outside the repository in `~/.thinker/jev-key`, with owner-only
permissions. `THINKER_HOME` changes that directory. Environment keys take
precedence: `THINKER_JEV_KEY`, then `JEV_API_KEY`, then `TYPESAFE_API_KEY`.
Environment variables must reach the agent process that runs Thinker's hooks;
the saved key also works for desktop agents launched outside your shell.
Thinker does not load a repository `.env` file for this setting.

By default, hosted Jev ranks the prompt hook's shortlist in one API call. Defaults are
eight candidates, a 0.5 relevance threshold, up to two selected notes, and a
1.5-second timeout. No qualifying notes means no notes served. A failed or
timed-out call falls back to the local cross-encoder, then lexical ranking if
that model is unavailable. `thinker ranker` reports configuration and local
model availability; it does not validate the key with a live API call.

Jev receives the request and candidate-note titles, question phrasings, body
excerpts, file/symbol pointers, and freshness through Thinker's AWS proxy,
which does not log their content. With a personal key, requests go directly to
TypeSafe using your account. Hosted access has usage limits and is separate
from your coding-agent subscription. `THINKER_TELEMETRY=off` controls
metrics only; it does not disable Jev or other configured model calls.

To adjust selection, merge a `jev` entry into `.thinker/config.json`:

```json
{
  "jev": {
    "enabled": "auto",
    "model": "jev-latest",
    "k": 8,
    "floor": 0.5,
    "maxNotes": 2,
    "timeoutMs": 1500
  }
}
```

`enabled: "auto"` uses hosted Jev, or direct access when a personal key is present. Keep credentials in the saved
key file or environment. These settings govern the small note-selection path;
they do not change learning or review models, or expand the prompt hook's
two-note budget. Broader MCP `orient` requests keep lexical ranking.
Environment overrides are `THINKER_JEV=on|off`, `THINKER_JEV_MODEL`,
`THINKER_JEV_K`, `THINKER_JEV_FLOOR`, `THINKER_JEV_MAX`, and
`THINKER_JEV_TIMEOUT` (milliseconds).

To return to local ranking, set `"jev": false` in `.thinker/config.json`, or
set `THINKER_JEV=off` in the agent's environment. To remove a saved personal key
and return to hosted access:

```bash
thinker ranker --no-jev-key
```

Unset any environment keys separately. If the local fallback is missing,
`thinker ranker fetch` fetches the model; `thinker update` repairs a missing
runtime. Jev call failures are logged as `jev-error` in the usage log
(`~/.thinker/log.jsonl` by default).

See [the preliminary Jev evaluation](bench/RESULTS.md#serving-jev-2026-10-06-offline-20-of-the-54-labelled-tasks)
for measured retrieval quality and its limits. The paired benchmark below
compares an agent with and without selected notes; it does not compare Jev
against the local ranker.

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

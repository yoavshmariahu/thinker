# Setting up Thinker

Run the installer anywhere. It wires your agents, asking nothing, then reads
the agents' own transcripts of the last 30 days in the repositories they worked
in most and prints where their context goes and what to cut first: the sections
of AGENTS.md, the skills and the tools that cost the most in the sessions that
did not use them (`thinker context --machine` prints the same report any time).
On a machine with a display it then opens the local page (`thinker ui`) on that
report, over every repository, where the suggestions are reviewed and applied.
Nothing is built: every git repository gets an empty cache with its first
session, and the cache grows from the sessions there.
[docs/setup.md](docs/setup.md#install-and-start) has the details.

The rest of this file is about `thinker setup`, which does the same for one
repository from the terminal: for a machine without a browser, or a script.

Notes are stored locally and ranked on your machine. Your configured agent
writes the notes.
Personal backups use `thinker export backup.tgz` and
`thinker import backup.tgz`. Team sharing and server sync are not supported.

## Setup flow (`thinker setup`)

Setup has two steps:

1. **Connect your agents.** Detects installed coding agents and configures their hooks and MCP servers in the agents' own settings, once per machine (`thinker connect` does this step alone, anywhere); the repository gets its git hooks, Cursor's rule and Codex's trust. Codex's hook-review marks are written without asking (`--no-trust` leaves them). Only detected or explicitly selected agents appear in the connection summary.
2. **Choose how to start.** Learn from future sessions (the default), or build a cache now from code and merged pull requests. Choose **Full repo** or **Specify project directories**. For a project, enter a name and comma-separated repository-relative directories; setup saves `thinker.project.json`. Setup shows estimated build time and token usage for the selection before asking whether to build. Outside a terminal, building requires an explicit flag such as `--build`.

Ongoing learning uses your agent to write notes from your sessions and merged
pull requests. Use `--no-learn` to disable it.

The completion message shows the next step: start a new agent session in this repository. You can build later with `thinker setup --build`.

A paired PR benchmark runs during setup only when requested with `--benchmark` or `--pr <number>`. Its results are saved in `.thinker/benchmarks/`.

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
thinker setup --build --yes
```

Or save the selection directly with
`thinker setup --directories apps/web,packages/ui --name "Web app" --build --yes`.
`--yes` and noninteractive builds reuse the saved selection (or use the full
repo when no file exists). `--project other.project.json` chooses another file;
`--full-repo` overrides a saved project for this run. Directory paths always
start at the repository root, including when running from a subdirectory.

The project only chooses what to build. It does not hide existing notes or
restrict retrieval or ongoing learning. The repository retains one
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

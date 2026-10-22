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

Setup has one step, **Connect your agents**: it detects the installed coding agents and
configures their hooks and MCP servers in the agents' own settings, once per machine
(`thinker connect` does this step alone, anywhere); the repository gets its git hooks and
Codex's trust. Codex's hook-review marks are written without asking (`--no-trust` leaves
them). Only detected or explicitly selected agents appear in the connection summary. Then
it fetches the ranking model and, when sessions ran in the repository, prints where the
agents' context goes there and what to cut first, as the installer does for the machine.

Nothing is built: the cache starts empty and grows from your sessions. Ongoing learning
uses your agent to write notes from your sessions; `--no-learn` disables it. Flags of the
build an older setup ran (`--build`, `--prs`, `--depth`, `--areas`) are accepted and ignored.

The completion message shows the next step: start a new agent session in this repository.
The first setup of a repository opens the local page; `--no-ui` leaves it closed.

## First-run benchmark

Once the cache holds notes (or one was imported), you can benchmark on a recent PR change or any repository question anytime:

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
usable topics yet, the cache has not learned enough: it grows from your sessions.

This is a quick repository-specific signal, not a statistically conclusive
benchmark or an automatic correctness grade. Use `--agent codex` (or
`claude`, `cursor`, `gemini`) and `--model <name>` to pin the runner.

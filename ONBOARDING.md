# Setting up Thinker

Run the installer from your repository, then start a new agent session.
Use `thinker setup --build` to build a local cache from code and merged pull
requests, or `thinker setup --no-build` to learn from future sessions.

Notes stay local. Personal backups use `thinker export backup.tgz` and
`thinker import backup.tgz`. Team sharing and server sync are not supported.

## Setup flow (`thinker setup`)

Setup has two steps:

1. **Connect your agents.** Detects installed coding agents and configures their hooks and MCP servers in the agents' own settings, once per machine (`thinker connect` does this step alone, anywhere); the repository gets its git hooks, Cursor's rule and Codex's trust. Codex trust is requested when needed. Only detected or explicitly selected agents appear in the connection summary.
2. **Choose how to start.** Learn from future sessions (the default), or build a cache now from code and merged pull requests. Setup shows estimated build time and available model cost estimates before asking. Outside a terminal, building requires an explicit flag such as `--build`.

Ongoing learning uses your agent for model calls. Use `--no-learn` to disable it.

The completion message shows the next step: start a new agent session in this repository. You can build later with `thinker setup --build`.

A paired PR benchmark runs during setup only when requested with `--benchmark` or `--pr <number>`. Its results are saved in `.thinker/benchmarks/`.

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

# Sharing thinker with a team

## What the user runs

The repository is private. Users need access to it and a GitHub token with read access, exported as `GITHUB_TOKEN`. From inside their own repository (anywhere else, the tool is installed alone and the script says to run `thinker setup` inside a repository, the one command that sets a repository up):

```bash
export GITHUB_TOKEN=<token>
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/yoavshmariahu/thinker/contents/install.sh | bash -s -- --cache gh:caches/<repo>.tgz
```

If no cache was built for their repository, `--build` in place of `--cache …` builds one on their machine in the same step (about 5.5M tokens of their Claude usage and twenty minutes with the defaults; the estimate is printed first, in tokens and minutes). With neither flag, the installer still sets the repository up and `thinker setup` asks whether to build the cache, defaulting to no.

That installs the tool under `~/.thinker`, unpacks the cache into `.thinker/` in the repository, checks every note against their checkout, and adds Claude Code hooks in `.claude/settings.local.json` that inject relevant notes into each request and distill each session into new notes when it ends (`--no-learn` leaves that out). Nothing else is changed and no `sudo` is used. Requirements: git, curl, tar, Node.js 20+.

| option | effect |
|---|---|
| `--cache <source>` | the cache built for this repository: `gh:caches/<repo>.tgz` (a file in the thinker repo), an https URL, or a local file; omit when `.thinker/notes` is already committed in the user's repo |
| `--build` | build the cache on this machine without asking: merged pull requests (`--prs n`, default 60), one exploration session per source area (`--areas n`, default 12) |
| `--no-build` | wire the repository up and ask nothing: the cache grows from the user's own sessions (`thinker setup --build` builds it later) |
| `--pr <number>` | target a specific PR number for the paired benchmark during setup |
| `--benchmark` | run the paired PR change benchmark during setup |
| `--no-benchmark` | skip the paired PR benchmark step |
| `--clients <list>` | agents to wire up: `claude`, `codex`, `cursor`, `gemini`, `all` or `auto` (default `auto`, except with `--no-build`); see "Supported agents" in `AGENTS.md` |
| `--no-learn` | do not distill the user's own sessions into new notes. Learning is on by default for every agent wired up (uses that agent's login; about 25k tokens per session distilled); switch it off for evals |
| `--late` | also serve notes about files as the agent opens them |
| `--shared` | write hooks to `.claude/settings.json` so the whole team gets them on pull |
| `--mcp` | also register the MCP server for the chosen agents (needs npm); always on for Cursor |
| `--no-git-hook` | do not install git hooks; by default pre-commit repairs staged shared notes, post-commit/post-merge maintain the cache, and pre-push reports issues without blocking |
| `--branch <name>` | install a specific branch or tag version (default `main`; `--ref also accepted) |
| `--update` | update the thinker CLI to the latest version and exit |
| `--no-auto-update` | do not schedule daily background auto-updates (daily auto-update is on by default) |
| `--uninstall [--purge]` | remove hooks; `--purge` also deletes the notes |

## Setup flow (`thinker setup`)

Setup has two steps:

1. **Connect your agents.** Detects installed coding agents and configures their hooks and MCP servers. Codex trust is requested when needed. Only detected or explicitly selected agents appear in the connection summary.
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

## Granting access

Add each user as a collaborator with read access on `yoavshmariahu/thinker` (Settings → Collaborators), or move the repository to an organization and use a team.

## What you do per repository

```bash
git clone <their repo> && cd <their repo>
thinker setup --areas 20 --prs 100 --export /path/to/thinker/caches/<repo>.tgz
# commit and push caches/<repo>.tgz in the thinker repository
```

`setup` creates `.thinker/`, wires up the agents' hooks and MCP server, and — once the build is confirmed — runs `mine-prs` on the GitHub `origin`, `seed`, `relink` and `export`; each of those is also a command of its own. `thinker mine-prs` run again later mines only pull requests it has not mined before (recorded in `.thinker/prs.json`).

Setup reports progress counts and notes saved, with periodic updates while an
agent is working. A change that produces no reusable notes is normal. Failures
are summarized with a retry command; failed changes are not marked as mined.
Full per-item results and errors are saved under `.thinker/state/` at the path
printed after each stage. Use `thinker setup --verbose` to also print those
details in the terminal (`mine-prs` and `seed` accept `--verbose` too).

Building on PostHog (54k files) gave 259 notes. The cache is keyed to file and symbol hashes, not to a commit, so it stays usable as their code moves: notes whose code changed are flagged stale when served and re-verified in the background if the user has the `claude` CLI.

Alternative delivery: run `thinker share --dry`, then `thinker share` and review and commit `.thinker/notes/` into their repository and have users run the installer without `--cache`. For hosting outside GitHub, `scripts/pack.sh <base-url>` builds a self-contained tarball and installer.

Example caches in this repository: `caches/click.tgz` (16 notes), `caches/posthog.tgz` (259 notes, built at the benchmark's base commit).

See [team sharing and CI validation](README.md#share-a-cache-with-your-team) for promotion gates, migration, and the `thinker share --check --base origin/main` CI command. Imported and newly built notes stay local until explicitly shared.

# Sharing thinker with a team

## What the user runs

The repository is private. Users need access to it and a GitHub token with read access, exported as `GITHUB_TOKEN`. From inside their own repository:

```bash
export GITHUB_TOKEN=<token>
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/yoavshmariahu/thinker/contents/install.sh | bash -s -- --cache gh:caches/<repo>.tgz
```

If no cache was built for their repository, `--build` in place of `--cache …` builds one on their machine in the same step (about $9 of their Claude usage with the defaults; the estimate is printed first).

That installs the tool under `~/.thinker`, unpacks the cache into `.thinker/` in the repository, checks every note against their checkout, and adds Claude Code hooks in `.claude/settings.local.json` that inject relevant notes into each request and distill each session into new notes when it ends (`--no-learn` leaves that out). Nothing else is changed and no `sudo` is used. Requirements: git, curl, tar, Node.js 20+.

| option | effect |
|---|---|
| `--cache <source>` | the cache built for this repository: `gh:caches/<repo>.tgz` (a file in the thinker repo), an https URL, or a local file; omit when `.thinker/notes` is already committed in the user's repo |
| `--build` | build the cache on this machine: co-change, merged pull requests (`--prs n`, default 60), one exploration session per source area (`--areas n`, default 12) |
| `--pr <number>` | target a specific PR number for the paired benchmark during setup |
| `--benchmark` | run the paired PR change benchmark during setup |
| `--no-benchmark` | skip the paired PR benchmark step |
| `--clients <list>` | agents to wire up: `claude`, `codex`, `cursor`, `gemini`, `all` or `auto` (default `auto` with `--build`, otherwise `claude`); see "Supported agents" in `AGENTS.md` |
| `--no-learn` | do not distill the user's own sessions into new notes. Learning is on by default for every agent wired up (uses that agent's login; about $0.05 per session with Claude Sonnet); switch it off for evals |
| `--late` | also serve notes about files as the agent opens them |
| `--shared` | write hooks to `.claude/settings.json` so the whole team gets them on pull |
| `--mcp` | also register the MCP server for the chosen agents (needs npm); always on for Cursor |
| `--no-git-hook` | do not install git hooks; by default pre-commit repairs staged shared notes, post-commit/post-merge maintain the cache, and pre-push reports issues without blocking |
| `--branch <name>` | install a specific branch or tag version (default `main`; `--ref also accepted) |
| `--update` | update the thinker CLI to the latest version and exit |
| `--no-auto-update` | do not schedule daily background auto-updates (daily auto-update is on by default) |
| `--uninstall [--purge]` | remove hooks; `--purge` also deletes the notes |

## The 3-Stage Setup Flow (`thinker setup`)

When run in a new repository (either via `curl .../install.sh` or `thinker setup`), Thinker runs a guided, visually aesthetic 3-step setup flow:

```
[Step 1: Connect Harness CLIs] ──► [Step 2: Build Knowledge Cache] ──► [Step 3: PR Change Benchmark]
 (Claude, Codex, Cursor, Gemini)     (Estimates: time, size, path)     (With vs without cache)
```

1. **Step 1: Connect Harness CLIs**
   Scans your local environment for installed coding agents (`claude`, `codex`, `cursor`/`agent`, `gemini`/`agy`). Wires hooks and registers MCP servers, saves Codex trust in `~/.codex/config.toml`, and approves Cursor MCP access.

2. **Step 2: Build Knowledge Cache**
   Computes pre-flight estimates upfront:
   - **Target storage location:** `.thinker/` (local notes in `.thinker/local/notes/`, shared notes in `.thinker/notes/`, co-change in `.thinker/cochange.json`)
   - **Estimated size:** notes count and disk footprint (typically 50–120 notes, ~120–220 KB on disk)
   - **Estimated build time:** broken down across co-change mining, PR distillation, and exploration
   Then mines git co-change history, distills merged PRs into fix and invariant notes, explores key subsystems, and generates search phrasings.

3. **Step 3: Optional PR Change Benchmark**
   Tests how an installed coding agent performs on a recent PR change with vs without the Thinker cache:
   - Detects the latest merged code PR (or user-specified `--pr <number>`)
   - Runs a paired read-only comparison through the agent (baseline vs Thinker arm)
   - Measures wall time, agent turns, tool exploration calls, token usage, and target file precision
   - Displays an aligned side-by-side comparison table and preserves answers in `.thinker/benchmarks/`

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

`setup` runs `init` (creates `.thinker/`, mines co-change), `mine-prs` on the GitHub `origin`, `seed`, `relink` and `export`; each is also a command of its own. `thinker mine-prs` run again later mines only pull requests it has not mined before (recorded in `.thinker/prs.json`).

Setup reports progress counts and notes saved, with periodic updates while an
agent is working. A change that produces no reusable notes is normal. Failures
are summarized with a retry command; failed changes are not marked as mined.
Full per-item results and errors are saved under `.thinker/state/` at the path
printed after each stage. Use `thinker setup --verbose` to also print those
details in the terminal (`mine-prs` and `seed` accept `--verbose` too).

Cost on PostHog (54k files): about $20 for 259 notes. The cache is keyed to file and symbol hashes, not to a commit, so it stays usable as their code moves: notes whose code changed are flagged stale when served and re-verified in the background if the user has the `claude` CLI.

Alternative delivery: run `thinker share --dry`, then `thinker share` and review and commit `.thinker/notes/` and `.thinker/cochange.json` into their repository and have users run the installer without `--cache`. For hosting outside GitHub, `scripts/pack.sh <base-url>` builds a self-contained tarball and installer.

Example caches in this repository: `caches/click.tgz` (16 notes), `caches/posthog.tgz` (259 notes, built at the benchmark's base commit).

See [team sharing and CI validation](README.md#share-a-cache-with-your-team) for promotion gates, migration, and the `thinker share --check --base origin/main` CI command. Imported and newly built notes stay local until explicitly shared.

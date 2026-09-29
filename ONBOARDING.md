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
| `--clients <list>` | agents to wire up: `claude`, `codex`, `cursor`, `gemini`, `all` or `auto` (default `auto` with `--build`, otherwise `claude`); see "Supported agents" in `AGENTS.md` |
| `--no-learn` | do not distill the user's own sessions into new notes. Learning is on by default for every agent wired up (uses that agent's login; about $0.05 per session with Claude Sonnet); switch it off for evals |
| `--late` | also serve notes about files as the agent opens them |
| `--shared` | write hooks to `.claude/settings.json` so the whole team gets them on pull |
| `--mcp` | also register the MCP server for the chosen agents (needs npm); always on for Cursor |
| `--git-hook` | re-check notes after each commit |
| `--uninstall [--purge]` | remove hooks; `--purge` also deletes the notes |

## First-run benchmark

After the cache is built or imported, use a concrete architectural question
from the user's own repository:

```bash
thinker benchmark run "explain how an upload is authorized and persisted"
thinker benchmark report
```

The first command makes two read-only calls through the same installed agent:
one without thinker context and one with the notes selected by `orient`. It
compares time, turns, tool calls when the agent reports them, and tokens. Both
answers are kept in `.thinker/benchmarks/` for a human quality check. If no
notes match the question, it exits before making either model call.

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

Cost on PostHog (54k files): about $20 for 259 notes. The cache is keyed to file and symbol hashes, not to a commit, so it stays usable as their code moves: notes whose code changed are flagged stale when served and re-verified in the background if the user has the `claude` CLI.

Alternative delivery: commit `.thinker/notes/` and `.thinker/cochange.json` into their repository and have users run the installer without `--cache`. For hosting outside GitHub, `scripts/pack.sh <base-url>` builds a self-contained tarball and installer.

Example caches in this repository: `caches/click.tgz` (16 notes), `caches/posthog.tgz` (259 notes, built at the benchmark's base commit).

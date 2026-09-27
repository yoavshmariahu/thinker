# Sharing thinker with a team

## What the user runs

The repository is private. Users need access to it and the GitHub CLI logged in (`gh auth login`). From inside their own repository:

```bash
gh api repos/yoavshmariahu/thinker/contents/install.sh -H "Accept: application/vnd.github.raw" \
  | bash -s -- --cache gh:caches/<repo>.tgz
```

Without the GitHub CLI, a token with read access works too:

```bash
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/yoavshmariahu/thinker/contents/install.sh | bash -s -- --cache gh:caches/<repo>.tgz
```

That installs the tool under `~/.thinker`, unpacks the cache into `.thinker/` in the repository, checks every note against their checkout, and adds a Claude Code hook in `.claude/settings.local.json` that injects relevant notes into each request. Nothing else is changed and no `sudo` is used. Requirements: git, curl, tar, Node.js 20+.

| option | effect |
|---|---|
| `--cache <source>` | the cache built for this repository: `gh:caches/<repo>.tgz` (a file in the thinker repo), an https URL, or a local file; omit when `.thinker/notes` is already committed in the user's repo |
| `--learn` | also distill the user's own sessions into new notes (uses their Claude usage, about $0.05 per session) |
| `--late` | also serve notes about files as the agent opens them |
| `--shared` | write hooks to `.claude/settings.json` so the whole team gets them on pull |
| `--mcp` | register the MCP server for Cursor, Codex and other MCP clients (needs npm) |
| `--git-hook` | re-check notes after each commit |
| `--uninstall [--purge]` | remove hooks; `--purge` also deletes the notes |

## Granting access

Add each user as a collaborator with read access on `yoavshmariahu/thinker` (Settings → Collaborators), or move the repository to an organization and use a team.

## What you do per repository

```bash
git clone <their repo> && cd <their repo>
thinker init --no-mcp                                         # creates .thinker/, mines co-change from git history
thinker seed --areas 20                                       # one exploration session per source area
thinker mine-prs <owner/repo> --before <today> --limit 100    # fix records, invariants, conventions from merged PRs
thinker export /path/to/thinker/caches/<repo>.tgz            # notes + co-change index + manifest with the commit
# commit and push caches/<repo>.tgz in the thinker repository
```

Cost on PostHog (54k files): about $20 for 259 notes. The cache is keyed to file and symbol hashes, not to a commit, so it stays usable as their code moves: notes whose code changed are flagged stale when served and re-verified in the background if the user has the `claude` CLI.

Alternative delivery: commit `.thinker/notes/` and `.thinker/cochange.json` into their repository and have users run the installer without `--cache`. For hosting outside GitHub, `scripts/pack.sh <base-url>` builds a self-contained tarball and installer.

Example caches in this repository: `caches/click.tgz` (16 notes), `caches/posthog.tgz` (259 notes, built at the benchmark's base commit).

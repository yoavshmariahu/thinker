# thinker — a cache of understanding for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified.

Works with Claude Code, Codex CLI, Gemini CLI and Cursor. Research prototype.

## Install and start

Requires git, Node 20+ and at least one of the agents above, logged in.

### In your repository, one line

The thinker repository is private, so this needs a GitHub token with read
access, exported as `GITHUB_TOKEN`. From inside your repository:

```bash
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/yoavshmariahu/thinker/contents/install.sh | bash -s -- --build
```

This installs the tool under `~/.thinker`, builds a cache of notes from the
repository's git history, merged pull requests and source areas, and wires
it into the agents found on the machine. Building costs roughly $9 of agent
usage with the defaults; the estimate is printed before anything runs. If a
cache was already built for the repository, use `--cache <file|url>` instead
of `--build` (see [ONBOARDING.md](ONBOARDING.md) for all options).

Then work with your agent as usual. Notes are added to each request
automatically.

### From a checkout

```bash
git clone https://github.com/yoavshmariahu/thinker.git
cd thinker && npm install && npm test

cd /path/to/your-repo
node /path/to/thinker/src/cli.js setup          # build the cache and wire up agents
node /path/to/thinker/src/cli.js list           # see the notes
node /path/to/thinker/src/cli.js orient "add rate limiting to the upload endpoint"
```

`setup` asks before spending. To start with an empty cache that fills from
your own sessions, run `init --hooks --clients auto` instead.

## Benchmarks

Real tasks taken from merged PostHog pull requests, written as vague,
symptom-only requests, run with and without the cache, and graded on
behavioural criteria calibrated against the merged patch. Notes come from
other sessions and pull requests, never from the task being evaluated.

Fable, 20 paired runs:

| arm | tool calls | input tokens | cost | time | essential criteria met | strict pass |
|---|---|---|---|---|---|---|
| no cache | 18.1 | 1.25M | $2.72 | 2.7 min | 0.79 ±0.07 | 9/20 |
| cache | 14.9 | 1.02M | $2.45 | 2.3 min | 0.89 ±0.05 | 14/20 |

Across models, same tasks:

| model | cost per task, no cache | effect of the cache |
|---|---|---|
| Fable | $2.72 | 18% fewer input tokens, 10% lower cost; success 0.79 → 0.89, within noise |
| Opus | $4.54 | no change in cost or success |
| Sonnet | $0.41 | 2 to 9% fewer input tokens, success unchanged |

On requests that name the code involved, Sonnet used 27% fewer turns and 32%
fewer input tokens with the cache at equal success.

Method, all arms, other agents (Cursor Auto, Grok), earlier repositories,
caveats and how to run it yourself: [bench/RESULTS.md](bench/RESULTS.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

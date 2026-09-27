# thinker — a knowledge cache for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified.

**With Claude Fable on real tasks, the cache raised the correctness score
and lowered the cost.**

```
correctness score    without thinker  ████████████████░░░░  0.80
                     with thinker     ██████████████████░░  0.89   +10%

input tokens         without thinker  ████████████████████  1.25M
                     with thinker     ████████████████░░░░  1.02M   -18%

cost per task        without thinker  ████████████████████  $2.72
                     with thinker     ██████████████████░░  $2.45   -10%
```

[See the benchmark](#benchmarks).

Works with Claude Code, Codex CLI, Gemini CLI and Cursor. Research prototype.

## Install and start

From inside your repository:

```bash
gh api repos/yoavshmariahu/thinker/contents/install.sh -H "Accept: application/vnd.github.raw" | bash -s -- --build
```

Then work with your agent as usual. Notes are added to each request
automatically.

Notes:

- **Requirements.** git, curl, tar, Node 20+, the GitHub CLI logged in (`gh auth login`)
  with access to the thinker repository, which is private, and at least one
  of the agents above, logged in.
- **What it does.** Installs the tool under `~/.thinker`, builds a cache of
  notes from the repository's git history, merged pull requests and source
  areas, and wires it into the agents found on the machine.
- **Cost.** Building costs roughly $9 of agent usage with the defaults. The
  estimate is printed before anything runs.
- **Already have a cache?** Use `--cache <file|url>` instead of `--build`.
  See [ONBOARDING.md](ONBOARDING.md) for all options.

## Benchmarks

Real tasks from merged pull requests in PostHog, each run with and without
the cache and graded by Claude Fable.

### Claude Fable (20 pairs)

| per task | without thinker | with thinker | change |
|---|---|---|---|
| **Correctness score** | 0.80 | **0.89** | **+10%** |
| **Every essential criterion met** | 9 of 20 | **12 of 20** | **+3** |
| Thoroughness | 0.28 | 0.34 | +21% |
| **Input tokens, cached included** | 1.25M | **1.02M** | **-18%** |
| **Output tokens** | 11.4k | **10.1k** | **-11%** |
| **Tool calls** | 18.1 | **14.9** | **-17%** |
| **Time** | 2.7 min | **2.3 min** | **-14%** |
| **Cost** | $2.72 | **$2.45** | **-10%** |

### Gemini 3.8 Flash (14 pairs)

| per task | without thinker | with thinker | change |
|---|---|---|---|
| Correctness score | 0.82 | 0.79 | -3% |
| Every essential criterion met | 6 of 14 | 7 of 14 | +1 |
| Thoroughness | 0.38 | 0.31 | -19% |
| **Input tokens, uncached** | 0.86M | **0.77M** | **-10%** |
| **Input tokens, cached** | 16.6M | **14.8M** | **-11%** |
| **Output tokens** | 99k | **92k** | **-7%** |
| **Tool calls** | 145.8 | **134.3** | **-8%** |
| **Time** | 14.9 min | **13.7 min** | **-8%** |
| Cost | not measured | not measured | |

Method, uncertainty, per-task results and other models:
[bench/RESULTS.md](bench/RESULTS.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

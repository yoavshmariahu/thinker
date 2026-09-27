# thinker — a cache of understanding for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified.

**With Claude Fable on real PostHog tasks, the cache solved more tasks and
spent less doing it:** 14 of 20 runs fully correct instead of 9, with 18%
fewer input tokens, 10% lower cost and 14% less time.
[See the benchmark](#benchmarks).

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

### Fable with thinker: more tasks solved, fewer tokens spent

| | without thinker | with thinker | change |
|---|---|---|---|
| **Runs fully correct** (every essential criterion met) | 9 of 20 | **14 of 20** | **+5 runs, 45% → 70%** |
| **Essential criteria met** | 0.79 | **0.89** | **+0.10** |
| **Input tokens per task** | 1.25M | **1.02M** | **-18%** |
| **Cost per task** | $2.72 | **$2.45** | **-10%** |
| **Tool calls per task** | 18.1 | **14.9** | **-17%** |
| **Time per task** | 2.7 min | **2.3 min** | **-14%** |

```
runs fully correct   without  █████████░░░░░░░░░░░   9/20
                     with     ██████████████░░░░░░  14/20

input tokens         without  ████████████████████  1.25M
                     with     ████████████████░░░░  1.02M
```

- **Cheaper in 15 of 20 paired runs.** The same task and seed cost less with
  the cache three times out of four.
- **7 runs went from failing to fully correct;** 2 went the other way.
- **Both directions at once.** The agent spends less time finding the code
  and gets more of the fix right.
- **Better than Opus at about half the price.** On the three tasks run on
  every model, Fable with the cache met every essential criterion at $2.27
  per task. Opus without it met 0.95 at $4.26.

### What was measured

Real tasks taken from merged PostHog pull requests, written as vague,
symptom-only requests, the way a bug report arrives. Each task was run with
and without the cache as a pair, same task and seed, and graded on
behavioural criteria calibrated against the merged patch. 20 pairs, all
graded.

This is transfer, not recall: notes come from other sessions and pull
requests, never from the task being evaluated.

How sure the numbers are: the cost saving is $0.28 ±0.12 per run, a little
over two standard errors. The gain in criteria met is +0.10 ±0.08, about one
standard error, so with 20 pairs it is a consistent direction rather than a
settled effect size. No prompt-only control was run on Fable.

### Other models, same tasks

| model | cost per task, no cache | effect of the cache |
|---|---|---|
| **Fable** | $2.72 | **18% fewer input tokens, 10% lower cost, 14 of 20 runs fully correct instead of 9** |
| Opus | $4.54 | no change in cost or success |
| Sonnet | $0.41 | 2 to 9% fewer input tokens, success unchanged |

On requests that name the code involved, Sonnet used 27% fewer turns and 32%
fewer input tokens with the cache at equal success.

Method, all arms, per-task results, other agents (Cursor Auto, Grok), earlier
repositories, caveats and how to run it yourself:
[bench/RESULTS.md](bench/RESULTS.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

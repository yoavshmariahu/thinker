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
                     with thinker     ██████████████████░░  0.89   +0.08

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

### Fable with thinker: higher correctness score, fewer tokens spent

| | without thinker | with thinker | change |
|---|---|---|---|
| **Correctness score** (share of essential criteria met) | 0.80 | **0.89** | **+0.08** |
| **Thoroughness** (share of the further criteria met) | 0.28 | 0.34 | +0.06 |
| **Input tokens per task** | 1.25M | **1.02M** | **-18%** |
| **Cost per task** | $2.72 | **$2.45** | **-10%** |
| **Tool calls per task** | 18.1 | **14.9** | **-17%** |
| **Time per task** | 2.7 min | **2.3 min** | **-14%** |

- **Cheaper in 15 of 20 paired runs.** The same task and seed cost less with
  the cache three times out of four.
- **Correctness rose in 6 of 20 pairs** and fell in 2; 12 scored the same.
  Every essential criterion was met in 12 of 20 runs with the cache and 9
  of 20 without.
- **Thoroughness is low with or without the cache.** The patches fix what
  was asked and handle about a third of the further edge cases the merged
  patch covered. The cache does not change that measurably.
- **Both directions at once.** The agent spends less time finding the code
  and gets more of the fix right.
- **As correct as Opus at about half the price.** On the seven tasks run
  on both, Fable with the cache scored 0.83 at $2.37 per task. Opus without
  it scored 0.83 at $4.54, and was more thorough: 0.43 against 0.33.

### What was measured

Real tasks taken from merged pull requests in a large open-source
repository, written as vague, symptom-only requests, the way a bug report
arrives. Each task was run with
and without the cache as a pair, same task and seed, and graded on
behavioural criteria calibrated against the merged patch. 20 pairs, all
graded.

Claude Fable is the judge. It reads each patch with the code around it and
decides, criterion by criterion, whether the behaviour is there.
**Correctness**, the key metric, is the share of the essential criteria a
patch meets: the ones without which the request is not fulfilled.
**Thoroughness** is the share of the remaining criteria: edge cases and
hardening the merged patch also handled.

This is transfer, not recall: notes come from other sessions and pull
requests, never from the task being evaluated.

How sure the numbers are: the cost saving is $0.28 ±0.12 per run, a little
over two standard errors. The gain in correctness is +0.08 ±0.06, a little
over one standard error, so with 20 pairs it is a consistent direction
rather than a settled effect size. The change in thoroughness, +0.06 ±0.06,
is within one standard error. No prompt-only control was run on Fable.

### Other models, same tasks

| model | cost per task, no cache | effect of the cache |
|---|---|---|
| **Fable** | $2.72 | **18% fewer input tokens, 10% lower cost, correctness 0.89 instead of 0.80** |
| **Gemini 3.8 Flash** | not measured | **10% fewer input tokens, 8% fewer tool calls, 8% less time; correctness unchanged** ([details below](#gemini-38-flash-with-thinker-less-work-for-the-same-result)) |
| Opus | $4.54 | no change in cost or correctness |
| Sonnet | $0.41 | 2 to 9% fewer input tokens, correctness unchanged (graded by Sonnet; not yet regraded by Fable) |

On requests that name the code involved, Sonnet used 27% fewer turns and 32%
fewer input tokens with the cache at equal success.

### Gemini 3.8 Flash with thinker: less work for the same result

The same 14 tasks, run through a different vendor's model and agent
(Antigravity CLI), one pair per task, graded by Fable on the same criteria.

| per task | without thinker | with thinker | change |
|---|---|---|---|
| **Input tokens** | 0.86M | **0.77M** | **-10%** |
| **Cached context re-read** | 16.6M | **14.8M** | **-11%** |
| **Output tokens** | 99k | **92k** | **-7%** |
| **Tool calls** | 145.8 | **134.3** | **-8%** |
| **File edits** | 13.1 | **11.5** | **-13%** |
| **Time** | 14.9 min | **13.7 min** | **-8%** |
| Correctness score | 0.82 | 0.79 | -0.02 |
| Every essential criterion met | 6 of 14 | 7 of 14 | +1 |

- **Less work in 10 of 14 pairs.** Input tokens, tool calls and time each
  went down in 10 of the 14 pairs, and all three went down together in 9.
- **The typical task used 22% fewer input tokens.** The median fell from
  0.90M to 0.70M. The mean saving is smaller because two tasks used far
  more with the cache.
- **The largest savings were a third to a half of the run.**

  | task | input tokens | tool calls | time |
  |---|---|---|---|
  | retention filter | -50% | 131 to 85 | 6.0 min faster |
  | survey filter | -38% | 221 to 155 | 8.2 min faster |
  | invite existing member | -37% | 199 to 140 | 6.5 min faster |

- **Two failing tasks became passing ones, and one went the other way.**
  Stopping a broadcast and saved-metric breakdowns met every essential
  criterion only with the cache. Saved insights query state did so only
  without it.
- **Correctness did not improve on this model.** The score is 0.02 lower
  with the cache, well within its standard error of 0.05, and thoroughness
  did not rise either. The gain here is in effort, not in quality.

How sure the numbers are: one seed and 14 pairs, so each mean saving is
about one standard error: input tokens -0.09M ±0.09M, tool calls -11.5
±9.7, time -1.2 ±1.1 min. The steadiest effects are cached context re-read,
-1.75M ±0.94M, and file edits, -1.6 ±0.9. Read them as a consistent
direction, matching the Fable result, rather than a settled effect size.
Cost in dollars was not measured for this model.

Method, all arms, per-task results, other agents (Cursor Auto, Grok), earlier
repositories, caveats and how to run it yourself:
[bench/RESULTS.md](bench/RESULTS.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

# thinker — a knowledge cache for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified.

**With Claude Fable on real tasks, the cache raised the correctness score,
lowered cost, and cut wall time.**

```
correctness score    without thinker  ████████████████░░░░  80%
                     with thinker     ██████████████████░░  89%     +10%

input tokens         without thinker  ████████████████████  1.25M
                     with thinker     ████████████████░░░░  1.02M   -18%

cost per task        without thinker  ████████████████████  $2.72
                     with thinker     ██████████████████░░  $2.45   -10%

wall time            without thinker  ████████████████████  2.7 min
                     with thinker     █████████████████░░░  2.3 min -14%
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
the cache. Evaluated on Claude Fable (20 pairs via Claude Code) and Gemini 3.8
Flash (14 pairs via Antigravity CLI), all independently graded on calibrated
acceptance criteria by Claude Fable.

| Dimension | Metric | Claude Fable (Claude Code) | Gemini 3.8 Flash (Antigravity CLI) |
|---|---|---|---|
| 🎯 **Correctness** | **Essential criteria score** | **+10%** (80% → 89%) | **Parity** (51.8% → 52.2%) |
| | **Tasks fully solved** | **+33%** (9 of 20 → 12 of 20) | **Parity** (5 of 14 in both) |
| ⏱️ **Timing** | **Wall clock time** | **-14%** (2.7 min → 2.3 min) | **-8.5%** (13.1 min → 11.9 min) |
| 🪙 **Token Usage** | **Input / context tokens** | **-18%** (1.25M → 1.02M) | **-21%** (15.2M → 12.1M cached read) |
| | **Output tokens** | **-11%** (11.4k → 10.1k) | **-22%** (98.1k → 76.9k) |
| 🔍 **Tool Efficiency** | **Tool calls per task** | **-17%** (18.1 → 14.9) | **-22%** (142.7 → 111.1) |
| | **File reads** | *(tracked in tool calls)* | **-27%** (70.3 → 51.5) |
| 💰 **Cost** | **Cost per task** | **-10%** ($2.72 → $2.45) | **-16%** ($0.42 → $0.35) |

### Key Takeaways for Users

- **🎯 Correctness:** On frontier models (Claude Fable), thinker boosts overall correctness by **+10%** and lifts complete task passes from **45% to 60%** (+3 tasks). Fast models (Gemini Flash) maintain strict correctness parity.
- **⏱️ Timing:** Eliminates blind repo exploration and prevents rabbit holes, cutting wall time by **8.5% to 14%** (and up to **20 minutes** on complex tasks).
- **🪙 Token Usage & Cost:** Pre-seeded architecture notes reduce input tokens and context re-reads by **18% to 21%**, directly lowering cost per task by **10% to 16%**.

Method, uncertainty, per-task results and other models:
[bench/RESULTS.md](bench/RESULTS.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

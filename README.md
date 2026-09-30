# thinker — a knowledge cache for coding agents

Coding agents re-orient in a repo every session: grep, read, trace imports,
figure out how X flows from A to B. `thinker` caches that understanding as
short notes keyed to the code they describe, and serves the relevant ones
into each request. When the code under a note changes, the note is flagged
stale and re-verified.

**With Claude Fable on real tasks, the cache cut wall time, lowered token usage and cost, and raised the correctness score.**

```
wall time            without thinker  ████████████████████  2.7 min
                     with thinker     █████████████████░░░  2.3 min 14% faster

input tokens         without thinker  ████████████████████  1.25M
                     with thinker     ████████████████░░░░  1.02M   18% less tokens

cost per task        without thinker  ████████████████████  $2.72
                     with thinker     ██████████████████░░  $2.45   10% cheaper

correctness score    without thinker  ████████████████░░░░  80%
                     with thinker     ██████████████████░░  89%     +10% improved
```

[See the benchmark](#benchmarks).

Works with Claude Code, Codex CLI, Gemini CLI and Cursor. Research prototype.

## Install and start

From inside your repository:

```bash
curl -fsSL https://zerotime.dev/thinker101/install.sh | bash
```

Then work with your agent as usual. Notes are added to each request
automatically.

To check the value on your own repository after setup, run the paired onboarding benchmark on a recent PR change or specific workflow question:

```bash
# Benchmark on a recent PR change (compares efficiency & target file location)
thinker benchmark pr [number]

# Or benchmark a specific question without and with Thinker context
thinker benchmark run "explain how <a real workflow> works"

# Show the latest comparison again
thinker benchmark report
```

It makes two read-only agent calls, without and with relevant thinker notes,
and compares time, turns and tokens. It saves both answers under
`.thinker/benchmarks/` so you can review quality; it does not pretend that
speed alone is a correctness score. If the first question is not covered well
enough by the cache, no agent calls are made and Thinker prints alternative
benchmark commands based on topics it can cover. Copy one of those suggestions
and try again.

Notes:

- **Requirements.** git, curl, tar, Node 20+, and at least one of the agents above, logged in.
- **What it does.** Installs the tool under `~/.thinker`, builds a cache of
  notes from the repository's git history, merged pull requests and source
  areas, and wires it into the agents found on the machine.
- **Cost.** Building costs roughly $9 of agent usage with the defaults. The
  estimate is printed before anything runs.
- **Already have a cache?** Use `--cache <file|url>` instead of `--build`.
  See [ONBOARDING.md](ONBOARDING.md) for all options.

## Benchmarks

Real tasks from merged pull requests, each run with and without the cache. Evaluated on Claude Fable (20 pairs via Claude Code), Gemini 3.8 Flash (14 pairs via Antigravity CLI), and OpenAI GPT-6 Astra (21 pairs via Codex CLI), all independently graded on calibrated acceptance criteria.

| Dimension | Metric | Claude Fable (Claude Code) | Gemini 3.8 Flash (Antigravity CLI) | OpenAI GPT-6 Astra (Codex CLI) |
|---|---|---|---|---|
| ⏱️ **Timing** | **Wall clock time** | **14% faster** | **8.5% faster** | **7.0% faster** |
| 🪙 **Token Usage** | **Input context** | **18% less tokens** | **21% less tokens** | **19% less tokens** |
| | **Output tokens** | **11% less output** | **22% less output** | **11% less output** |
| 🔍 **Tool Efficiency** | **Tool calls** | **17% fewer calls** | **22% fewer calls** | **18% fewer calls** (won 71% of tasks) |
| | **File reads / exploration** | *(tracked in tool calls)* | **27% fewer file reads** | **14% less exploration** |
| 💰 **Cost** | **Cost per task** | **10% cheaper** | **16% cheaper** | *(flat rate / subscription)* |
| 🎯 **Correctness** | **Criteria accuracy** | **+10% improved** | **Parity** (0% diff) | **Parity** (within noise) |
| | **Tasks fully solved** | **+33% more solved** | **Parity** (0% diff) | **Parity** (15 vs 16 solved) |

### Key Takeaways for Users

- **⏱️ Timing:** Eliminates blind repo exploration and prevents rabbit holes, cutting wall time by **7% to 14%** (saving up to **100+ seconds** on complex Grafana tasks).
- **🪙 Token Usage & Cost:** Pre-seeded architecture notes reduce input tokens and context re-reads by **18% to 21%**, directly lowering cost per task by **10% to 16%**.
- **🔍 Tool Efficiency:** Reduces tool calls across every evaluated agent harness — Claude Code (**-17%**), Codex CLI (**-18%**, lower in 15 of 21 tasks), and Antigravity CLI (**-22%**).
- **🎯 Correctness:** On frontier models (Claude Fable), thinker boosts overall correctness by **+10%** and lifts complete task passes from **45% to 60%** (+3 tasks). Fast and frontier models (Gemini Flash, GPT-6 Astra) maintain strict correctness parity (within single-run noise).

Method, uncertainty, per-task results and other models:
[bench/RESULTS.md](bench/RESULTS.md).

## Updates and testing branches

Thinker auto-updates daily in the background. To check or update manually at any time:

```bash
thinker update
```

To test a specific branch version:

```bash
# Switch to a branch version (or tag)
thinker switch <branch-name>
# or: thinker update <branch-name>

# Check current branch
thinker branch

# Switch back to main
thinker switch main
```

See `thinker update --status` for current install and schedule details, or `thinker update --schedule` / `thinker update --unschedule` to manage OS-level background updates.

## Metrics and telemetry

Thinker records anonymous installation and daily effectiveness metrics (cache hit rate, notes count, estimated token savings) to track cache performance. No prompt text, note bodies, code snippets, file paths, or repository URLs are ever collected or transmitted.

```bash
thinker telemetry           # inspect current daily metrics summary and transmission status
thinker telemetry --send    # send metrics manually
```

To opt out at any time, set `THINKER_TELEMETRY=off` in your environment or set `"telemetry": false` in `.thinker/config.json`.

For the PostgreSQL ingestion service, S3 migration, and SQL queries, see
[the telemetry operations guide](infra/metrics/README.md).

## More

- [AGENTS.md](AGENTS.md): how thinker works, per-agent support, repository layout
- [ONBOARDING.md](ONBOARDING.md): sharing a built cache with a team

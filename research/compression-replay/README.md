# What tool-output compression actually saves (2026-10-28)

`replay.mjs` drives the shipped compressor (`src/diet.js`) over real Claude Code transcripts and
reports where output tokens sit, what each level removes, and what is left untouched. No model calls.

    node research/compression-replay/replay.mjs [n-sessions]       # default 40
    DIET_SRC=/path/to/another/checkout/src node research/compression-replay/replay.mjs

It reads the structured `toolUseResult` each transcript keeps (`stdout`/`stderr` for Bash, `content`
for Read), so it takes the same branch `dietResult` would. Outputs are weighted by re-reads — an
output sits in the context from the call that produced it until the next compaction, so it is paid for
by every later call — and tokens are chars/4, with no calibration applied.

## The result

One corpus, 33 of this machine's recent sessions (5,327 model calls, 176M weighted output tokens) and
the 24 sessions of `posthog-hard-opus55-product-12-2026-10-28`:

| variant | real sessions | eval sessions |
|---|---|---|
| moderate (12k cap) | 7.8% | 5.4% |
| moderate, cap 6k | 21.7% | 26.1% |
| moderate, cap 4k | **33.7%** | **40.7%** |
| high | 33.9% | 40.7% |

**The difference between moderate and high is one number, `outputChars`.** Moderate with a 4k cap
matches high to within 0.2pp on both corpora; high's other settings (window 40→15, searchChars
8k→3k, perFile 3→1, testChars 2k→1k) are worth almost nothing. The cap also does nearly all the work
within a level: at high, `cap` and `cap-mcp` are 59.5M of the 60.2M removed, while the file trim, the
grouped search and the test summary together are under 1M.

What that leaves untouched at moderate, by weighted cost: reads the agent narrowed itself
(`sed -n 'A,Bp' file`) 29.5%, searches piped on 14.7%, other piped chains ~16% (python3, echo, node,
cat, git, ls), WebFetch 3.8% (not in `COMPRESSIBLE` at all).

## Two dead ends, measured so nobody repeats them

- **Trimming narrowed reads** (`sed -n 'A,Bp'`, `Read` with `offset`): worth ~0. Those slices are
  individually small — ~1k tokens each — so they fall under `minLines` (120) and `trimFile` declines
  them. The 29.5% is real cost but term-window trimming cannot reach it; only a tighter cap can.
- **Grouping a search whose output is piped on**: +0.9pp at moderate, **−0.8pp at high**, because
  grouping keeps slightly more than capping at 4k does. Not worth a branch.

There is also a trap worth knowing: routing those outputs into a new branch that then declines to
trim them takes them out of reach of the cap. A first version of this did that and made high *worse*
(33.9% → 27.5%), because `cap` fell from 308 trims to 179. Any new path must fall through, not
return.

## What this says to do

Tune `outputChars`, and measure the one thing a replay cannot: a tighter cap makes the agent re-run
commands, and on Claude Code one extra turn re-reads 65–100k of context, against the ~3k a trim
saves. That is an agent-session experiment (one arm, compression only), not a replay.

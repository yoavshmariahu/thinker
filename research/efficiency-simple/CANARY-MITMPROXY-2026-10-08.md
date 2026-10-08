# mitmproxy canary: the cache pays where its note holds the mechanism

Author: Claude Fable 5.1 with Yoav. 2026-10-08, 01:45 to 03:25 UTC. Thinker `a6704e2` on branch
`agent/rerun-fix-overlap`, with the uncommitted model-pins adapter. Same cohorts and harness as
the Click rerun (`CANARY-2026-10-08.md`): Opus 5.5 through Claude Code and GPT-6.1 Sol through
Codex at high effort, three seeds per arm, the upstream acceptance test as the grade.

Why mitmproxy: Click is the smallest repository in the benchmark set (12k lines in the package, a
third of them in one file), its baselines found every entry point in one or two greps, and eight
of eight pairs there cost more with the cache. A second repository was asked for to see whether
that is Click or the cache.

## Caches

Anchor d482bba (2026-04-10, the clone's old head). Mined 60 commits before it per cohort, then 60
more when the first probe covered nothing:

| cohort | commits | notes | deferred by the learning gates | mining |
| --- | ---: | ---: | ---: | --- |
| Opus | 60 → 120 | 16 → 41 | 48 after the first 60: 30 "title or applicability exceeds the grounded body", 9 conflicts, 7 unsupported | 585s + ~10 min |
| Sol | 60 → 120 | 24 → 57 | | ~18 min + ~24 min |

The metadata gate refused most proposals, and the refused examples read like what a cache is for
("adding an option to Options means also updating the generated `_options_gen.ts`"). Not changed
here; the first thing to probe next.

## Tasks

Six post-anchor pull requests with tests (`tasks-mitmproxy.json`; prompts from
`bench/tasks/mitmproxy-hard.json` where they existed): 8175, 8326, 8333, 8214, and, added after
the first probe covered none of those, 8196 (a one-line fix to `is_mostly_bin`, on a function
the cache holds a rule about from an earlier UTF-8 fix) and 8317 (a `web_theme` option for the
web addon, on a file the cache holds a rule about). The probe on the deepened caches covered
8196 on Opus (Jev 0.79) and 8317 on Sol (0.57); both cohorts ran both tasks
(`tasks-mitmproxy-pair.json`, `THINKER_EFF_ALL=1`), the edit hook free to serve where prompt time
did not.

## Result

| pair | cohort | input tokens, mean of 3 | tool calls | pass | served | standing |
| --- | --- | ---: | ---: | --- | ---: | --- |
| mitm-8196 | Opus | 117k → 85k (−27%) | 5.0 → 2.7 | 6 of 6 | 1.0 | valid |
| mitm-8317 | Sol | 137k → 225k (+65%) | 8.0 → 13.3 | 6 of 6 | 1.3 | valid |
| mitm-8317 | Opus | 259k → 253k | 10.3 → 10.0 | 1 of 6 | 0 | invalid grade |
| mitm-8196 | Sol | 124k → 168k | 10.0 → 13.0 | 5 of 6 | 0 | invalid serving |

**mitm-8196 on Opus** is the first pair of the day where the cache arm is cheaper, and it is
cheaper in every seed (93k, 94k, 68k against 112k, 109k, 130k). The served note is the rule mined
from the earlier fix to `is_mostly_bin`, and it states the mechanism the bug sits in: the cut
moving forward up to index 103 to avoid a UTF-8 continuation byte. The baseline's first call was a
grep to find the function; the thinker arm opened the right lines directly, fixed, tested, and
confirmed the regression test fails without the fix. One to three fewer calls, same patch.

**mitm-8317 on Sol** is the Click pattern again: the two notes served (a howto on running tests
through uv, a rule about the web app's color tokens) are near the task and not about it, and the
agent spent five more calls, three of them `find` and `drilldown`.

**mitm-8317 on Opus** does not grade: the upstream test asserts the option's choices as a list,
Opus declared them as a tuple in both arms (`choices=WEB_THEMES`), and five of six runs fail on
that comparison. The prompt never named the container. Sol used a list. The task needs an
acceptance that checks the behavior, not the type.

**mitm-8196 on Sol** did not serve: under the Codex prompt hook Jev scored the on-target note at
0.06 to 0.07 in every seed, against 0.44 at probe time and 0.37 on a re-probe at 03:14, both
through the Claude-shaped hook on the same cache and the same prompt text. The `task` the hook
logged is identical. Whether the Codex hook's request differs past the logged prefix, or the
client changes the ranking path, is not isolated: the direct test of it hit a Jev 503. Open.

## The ranking service

Jev returned 503 at 02:51, 03:00 (twice), 03:14 and 03:19, and stopped both cohorts twice: the
harness refuses an arm whose ranking fell back rather than measure the cross-encoder. Added
during the run: a refusal when the run-time top score falls more than 0.25 below the probe's
(a degraded 200 is not a 503), and a retry of a refused thinker arm from a clean checkout after
90 seconds, up to three times.

## What the two repositories say together

Click, eight pairs: the cache costs 10% to 49% with true notes resting on the fix's lines.
mitmproxy, two valid pairs: 27% cheaper where the note held the mechanism of the code being
changed, 65% costlier where the notes were merely nearby. The serving path cannot tell those two
kinds of note apart today; Jev's question is whether a note bears on the request, and both kinds
answer yes. The next measurement is offline, on the labelled pairs plus these: a second judgment
on the candidates that pass, whether the note describes how the code the request changes works
or only a rule to keep.

## Reproduce

```sh
export THINKER_TEST=1 THINKER_BENCH_SOURCE=<mitmproxy clone> THINKER_CODEX_AUTH=<codex auth.json>
export THINKER_EFF_DIR=bench/runs/efficiency-mitm THINKER_EFF_TASKS=research/efficiency-simple/tasks-mitmproxy-pair.json
export THINKER_EFF_ANCHOR=d482bbaa2… THINKER_EFF_PYBIN=.venv-mitm/bin/python THINKER_EFF_PYPATH=. THINKER_EFF_SRC=mitmproxy
export THINKER_EFF_PYTEST_ARGS="-p pytest_asyncio -p pytest_timeout" THINKER_EFF_SEEDS=3 THINKER_EFF_ALL=1
python3 research/efficiency-simple/run.py build opus   # twice, THINKER_EFF_MINE=60 each
python3 research/efficiency-simple/run.py probe opus && python3 research/efficiency-simple/run.py solve opus && python3 research/efficiency-simple/run.py score opus
```

The venv holds mitmproxy's dependency group and not mitmproxy itself, so the tests import the
checkout on `PYTHONPATH`.

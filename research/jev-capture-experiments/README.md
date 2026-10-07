# Jev capture selection experiments

Author: Codex. Date: 2026-10-06. Base: `ad85060`.

## Results and recommendation

The tested designs do **not** justify expanding Jev capture filtering. The
current passage selector lost the discoveries the sessions established and
spent more total tokens than either baseline. PR prioritization changed the
queue reproducibly but produced the same number of supported reusable notes
with substantially greater token use. Whole-session gating retained every
real session; it added overhead without avoiding a writer call. The compact
gate was inexpensive enough to merit a broader intake study, but missed a
buried discovery in the constructed cases.

These conclusions concern the specific prompts, candidate construction and
policies tested. They do not establish a general limitation of Jev. Production
capture behavior is unchanged. Before trying a new passage design, fix source
coverage, provide the actual session request, exclude already-documented
instructions, and preserve the final correction alongside an earlier
diagnosis. Those are follow-up hypotheses, not measured improvements here.

### Six recorded sessions

| Input to writer | Candidate notes | Supported reusable notes | Reference facts / 13 | Unsupported notes | Writer tokens | Selector tokens | Total tokens | Sum of call time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Production condensed trace | 10 | 6 | 8 | 4 | 185,602 | 0 | 185,602 | 129.1 s |
| Deterministic evidence packet | 9 | 6 | 10 | 2 | 148,079 | 0 | 148,079 | 132.3 s |
| Jev selected passages | 7 | 2 | 0 | 2 | 89,740 | 397,648 | 487,388 | 97.4 s |

Jev reduced writer tokens 51.6% relative to the condensed trace, but its
selection calls made the total **2.63 times** that baseline and **3.29 times**
the deterministic packet. It was faster in summed call time, at a large
quality loss. Its two supported reusable notes explained nearby task-backend
logic; neither retained one of the reference discoveries. A valid alternative
discovery counts as a useful note even when outside the reference list.

The main problems were concrete:

- **Slack follow-ups:** Jev's note says an unset preference resolves to NEVER
  and tells future callers to use the thread creator's ID. Both claims were
  superseded by the final session patch (ASK for an identified author with no
  saved setting, and the reply author's ID). A second note restated README
  testing advice.
- **Broadcast scheduling:** the selected evidence yielded zero notes; the
  deterministic packet captured replacing paused schedules and moving a
  broadcast back to draft.
- **CDC and insight UI:** Jev used scarce evidence space for repository
  skills/AGENTS.md and the writer reproduced those instructions, omitting the
  schedule-lifecycle and navigation discoveries.
- **Assignee events:** the Jev note put a producer function in the wrong file,
  conflating manual/ingestion paths with alert/internal-event paths. Source
  events 11 and 25 establish the actual function locations.

Candidate coverage was only 96 of 245–346 passages in each real session.
Four real selections were identical in the two Jev repeats; two changed.
The question asks whether each passage contains durable knowledge but does
not include the actual session request. Documentation often satisfies that
question literally. This, early-source tie breaking, and separated
corrections are plausible mechanisms for the observed failures, not isolated
causal ablations. See `selection-audit.json` and the saved passage traces.

### Whole-session decisions

The gate uses the same saved condensed-trace writer outputs in every policy.
Thresholds 0.2 and 0.5 made the same decisions in both repeats.

| Policy, six recorded sessions | Sessions written | Writer tokens | Gate tokens | Total tokens |
|---|---:|---:|---:|---:|
| All sessions / current local eligibility | 6 | 185,602 | 0 | 185,602 |
| Jev scans all source passages | 6 | 185,602 | 996,214 | 1,181,816 |
| Jev reads the compact packet | 6 | 185,602 | 21,685 | 207,287 |

The compact gate added 11.7% tokens without avoiding a call. This sample has
substantial implementation sessions and cannot estimate savings on ordinary
low-yield intake. The all-source gate is an expensive policy for this use.

Keep the constructed cases separate:

| Policy | Short discovery | Buried discovery | Late correction | Routine / machine failure / speculation |
|---|---|---|---|---|
| Current local eligibility, no audit | Skip | Skip | Skip | Keep / keep / skip |
| Full-source Jev gate | Keep | Keep | Keep | Skip / skip / skip |
| Compact Jev gate | Keep | **Skip** | Keep | Skip / skip / skip |

The compact gate cannot recognize evidence absent from its packet. The
production passage selector also missed the buried source because uniform
sampling omitted it before inference (143 total passages, 96 candidates).
These are source-visibility stress tests, not estimates of real-session
recall: the condensed and deterministic writers produced zero notes on all
six constructed cases, including the author-designated discovery targets.
Jev passage selection produced one supported short-discovery note. Correct
gate decisions therefore did not establish improved end-to-end note yield.

### PR queues: three of six per repository

| Policy | PRs written | Supported reusable notes | Reference facts retained | Writer tokens | Selector tokens | Total tokens | Sum of call time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Distill all (context only) | 18 | 27 | 41 | 338,225 | 0 | 338,225 | 318.3 s |
| Existing `pickPrs` | 9 | 14 | 21 | 164,071 | 0 | 164,071 | 158.0 s |
| Jev ranking, both repeats | 9 | 14 | 22 | 157,615 | 90,047 | 247,662 | 157.8 s |

Both Jev repeats selected the same nine PRs. One more reference fact and the
same useful-note count at **51.0% more total tokens** is not a convincing win.
Summed call time was essentially unchanged. All 18 PRs received high Jev
scores; this preselected corpus tests ordering among plausible candidates,
not rejection of representative PR noise. Writer outputs are generated once
and reused by the policies, so a queue cannot win from a luckier writer draw.

### Grading audit and sensitivity

Some raw grades contradicted their own explanation, credited an unstated
fact merely because a pointer named the relevant file, or called docs/skill
restatements reusable despite the explicit exclusion. The audit applied
the predeclared criteria to these cases. Every change is in
`grade-corrections.json`; original grades are retained in `raw.json.gz`.

| Recorded-session arm | Raw grader fact coverage | Audited fact coverage | Raw supported reusable notes | Audited supported reusable notes |
|---|---:|---:|---:|---:|
| Condensed trace | 11 | 8 | 6 | 6 |
| Deterministic packet | 11 | 10 | 8 | 6 |
| Jev passages | 1 | 0 | 4 | 2 |

The conclusion holds under either the raw or audited grades. PR coverage
changed from 22 to 21 for `pickPrs` and from 23 to 22 for Jev after removing
the same unexpressed id-set-selection fact from a PR both queues selected;
useful-note counts did not change. One PR grade used one-based note indices;
the report normalizes those without changing its judgments.

## Question and design

Does Jev help decide which session passages, entire sessions, or merged PRs
should reach a note-writing model? These are three separate interventions.
The experiment changes capture selection only; it does not write production
notes or change production behavior.

The frozen inputs are six archived PostHog coding sessions, six deliberately
constructed session edge cases, and eighteen merged PRs (six each from
mitmproxy, PostHog, and Grafana). Real sessions and constructed examples are
reported separately. PRs are the first six numeric IDs with saved diffs in
each project's existing benchmark corpus. This is a convenience sample of
previously selected coding tasks, not representative incoming work.

The original sessions used `gpt-6-sol`; their reasoning effort is absent from
the archived run metadata. No exploration or coding phase is rerun: all arms
receive the same frozen source bytes. Every new writer and grader uses
`claude-sonnet-5`, medium effort, thinking budget zero, no tools, empty working
directory, and no fallback. The CLI's actual per-model usage keys must match
the requested model. Jev is pinned to `jev-1.13.0` and its returned model is
checked. Each Jev decision is repeated twice; writing uses the first
selection, with one writer draw per arm. Writer concurrency is one and arm
order rotates across sessions.

### Passage selection

Compare the production `condense` trace (70,000-character cap), deterministic
`evidencePacket` (12,000 characters), and `refineLearningPlan` (12,000
characters, up to 96 sampled candidates, probability floor 0.7). All three
use the same production session note-writing prompt, schema, output budget,
and additional missing-context instruction. Existing notes and assessments
are empty in every arm, isolating capture from reconciliation and novelty.

`condense` is the full-trace *production baseline*, not a lossless source.
It truncates individual outputs and may omit the middle of long sessions.
Reference grading sees the original normalized source events, so a discovery
omitted by every arm can still be counted as missed.

### Whole-session eligibility

A Noul asks whether source evidence establishes a durable repository fact.
The full-source variant reads chronological batches of numbered passages and
uses the maximum batch probability. The compact follow-up asks the identical
question of the deterministic evidence packet. Thresholds 0.5 and 0.2 are
reported; 0.2 deliberately lets uncertain cases reach the writer. Compare
both with local `learningPlan` eligibility with audits disabled.

These gates reuse the same saved full-trace writer outputs to estimate the
notes and writer tokens retained. No additional writing randomness is
introduced by each simulated queue policy. A gate's semantic false negatives
are checked against reference facts, including those the writer missed.
Taking a maximum over many batches can raise false-positive rates; it is an
explicit experimental policy, not a calibrated session probability.

### PR prioritization

Distill every PR once with the production PR-writing instructions, then
compare queues at **three PRs per repository** (nine total): production
`pickPrs` against Jev probability ranking. The fixed quota prevents a policy
from winning simply by processing more PRs or more of one repository. Jev
sees title, description and bounded diff; long inputs are split into chunks
and the maximum probability ranks the PR. No review comments were collected.
Jev ties break by ID; the baseline retains its production ordering rules.
The writer uses the shared bounded session-note schema: the same note fields
as the PR schema, with a three-note cap and an optional `applies` field.

### Quality and accounting

Before note writing, the same pinned model extracts up to three reference
facts per source. The analyst audits session references and PR references
against the source and the note policy; corrections are retained separately
from the original model outputs. Constructed-case expectations are authored
before any calls. Grading hides arm names and judges fact coverage, support
of every material note claim, and usefulness on another task. These are
model-assisted proxy measurements, not executable downstream correctness.

We report note counts, supported reusable notes, reference facts retained,
unsupported notes, tokens, and elapsed time separately. A smaller note count
is not inherently better. Runtime token totals include both selector and
writer, including provider prompt-cache reads/writes. Source labeling and
grading are evaluation overhead, excluded from simulated production totals.
Raw usage remains available. No API list-price estimate is used.
Empty outputs have deterministic zero coverage and no unsupported notes;
five such session cases require no grading model. Call times are sums of
measured selector/writer durations, not actual replayed queue makespans.

## Preflight and amendments

- The first real production passage-selection request failed with HTTP 400:
  invalid Unicode text. Splitting at fixed UTF-16 offsets can produce lone
  surrogate halves. The research transport repairs only malformed string
  code units with `String.toWellFormed()` before serialization and counts
  repaired fields. Production source is unchanged. Results therefore apply
  to the selector with this explicit transport repair, not an unmodified
  production success path.
- Initial reference extraction mixed pre-change and final source and
  restated repository skills. The prompt was tightened before note writing.
  Original attempts remain in `preflight-labels/` and
  `preflight-labels-v2/`.
- Structured output failed at retry limit one. All final phases use limit
  three and at most two outer retries for that specific failure. Models
  and effort remain fixed. `failed-writer.jsonl` preserves later failed
  attempts; the earliest failed preflight usage was not captured completely.
- The compact gate is an exploratory follow-up after observing the
  full-source gate's token overhead, before note writing/grading.
- `label-corrections.json` records reference audit reasons.
  `label-audit-originals/` preserves the corresponding original labels.
- One PR grading call timed out after 240 seconds without final usage. It
  was retried with the same configuration. Grading is evaluation overhead;
  the unknown failed-call usage prevents an exact total experiment-spend
  claim and does not enter the runtime comparisons.

## Reproduction and artifacts

`protocol.json` records inputs, configuration and amendments. The gzipped
corpus contains normalized source events and PR records; its decompressed
SHA-256 is checked by the harness. Absolute benchmark checkout paths are
normalized. No personal interactive session or production cache is used.
`raw.json.gz` preserves the exact checkpoint JSON files for selections, model
usage, notes, reference facts and grading. `evidence-manifest.json` lists their
hashes. The harness reads the archive directly; `results.json` is derived
from those records. To inspect individual files, run
`THINKER_TEST=1 node bench/jev-eval/capture-pack.mjs --unpack`.

From an isolated worktree, with a personal TypeSafe key and an authenticated
Claude CLI:

```sh
THINKER_TEST=1 THINKER_TELEMETRY=off node bench/jev-eval/capture-experiment.mjs --live
```

The run resumes saved checkpoints. To recompute the summary without new
model calls or credentials, run with `THINKER_TEST=1` and `--stage=report`
(no `--live` needed). For a genuinely fresh run, use a separate
copy of the experiment directory: unpack the archive, retain `raw/gold-*.json`
as frozen reference labels, then remove the archive, selection/writing/grading
checkpoints and generated results in that disposable copy. Retain the corpus,
protocol, and label corrections.
Re-extracting gold is a separate reference-labeling experiment: fact IDs can
change, so the recorded analyst corrections must not be blindly applied to
new model labels. The preparation
script documents how the initial inputs were collected from the local
benchmark archive; it is not required for replaying the committed corpus.

## Validation and limits

The repository suite passed: 495 passed, five skipped, zero failed. Tests
and all subprocesses ran with `THINKER_TEST=1` and telemetry disabled.

The small sample cannot establish a general capture policy or calibrated
threshold. The real sessions contain substantial implementation work and
provide few negative examples; constructed negatives cannot estimate the
real frequency of empty sessions. The PR sample was already selected for
coding benchmarks. No later task is run against the resulting notes, and
an empty starting cache leaves novelty against an existing cache untested.
Two Jev repeats assess selection stability, not writer or grader variance.
Downstream reconciliation, source-fidelity checks and dependency validation
are not run: they could defer unsupported candidate notes. These are not
measurements of unsupported notes actually entering a production cache.
Replays that make model calls check hashes of the production source modules;
use the recorded research commit if those modules have since changed.

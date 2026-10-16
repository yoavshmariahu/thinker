# Serving understanding notes: where the targets are lost (2026-10-16)

The understanding arm added to `mlflow-b2-astra-served5` (Artemis, cancelled after 10 of 30 sessions) looked
worse than no cache. This replays every request of the mlflow harder set through the hook's own ranking
code, offline and without a model call, to see where the notes each request should get are lost.

- Cache: `mlflow-b2-astra-understanding-200` (582 notes, gpt-6-astra, top 200 files by recent commits, base 1bb65f1c6).
- Targets: `labels.json`, hand labels from the request and the notes that point at the fix's source files
  (2 = the task's mechanism, 1 = a useful map). 8 of 13 requests have a 2; PR26252, PR26265 and PR26311
  change files no note points at.
- `trace.mjs`: the lexical gate and rank (src/rank.js), the cross-encoder over the top k on each text
  (src/dense.js), floor, slots; it reproduces what the live sessions were served. `variants.mjs`: one
  stage changed at a time. Holdout: the PR-mined cache `mlflow-v2BC` (960 notes) with its own Haiku labels
  (`.worktrees/mlflow-tasks/bench/serving/relevance-labels-BC.json`), via `PROBE_NOTES`/`PROBE_LABELS`.

## Where the targets are lost

The lexical ranking reaches every target: the 2 is first or second on all 8 requests. The cross-encoder
loses three of them (PR26267, PR26307, PR26327): it scores the target −0.9 to −3.3, under the floor of 0,
and serves nothing or two unrelated notes. Long bug-report requests score every note negative, the target
included. The second slot was an unrelated note on 5 requests.

## What was tried (understanding cache, 13 requests)

| variant | rated-2 served (of 8) | useful served (of 13) | precision | nothing served |
|---|---|---|---|---|
| shipped (multi views, k 8, floor 0, two notes) | 5 | 7 | 0.57 | 5 |
| lexical top 2, no cross-encoder | 8 | 9 | 0.55 | 0 |
| lexical top 1 | 6 | 7 | 0.70 | 0 |
| floor −1 / −2 / −4 | 6 / 6 / 7 | 8 / 8 / 9 | 0.50–0.55 | 0–1 |
| cross-encoder reads 60 / 250 / 400 request tokens | 5 / 5 / 4 | | | |
| cross-encoder reads the first sentences / the "desired" part | 4 / 4 | | | |
| note text: answers / applies / title only | 3 / 1 / 1 | | | |
| other models as the picker (L-12, bge-reranker-base, mxbai-xsmall, jina-v1-turbo) | 3–5 | | | |
| **cross-encoder's best of the lexical top 8, no floor, one note** | **7** | **8** | **0.67** | **1** |

The cross-encoder ranks well and thresholds badly: as the picker among the lexical top 8 it chooses the 2
on 7 of 8; its absolute floor throws the choice away. Nothing tried (cross-encoder score, lexical score
and cover, how many of a note's file and symbol names the request names) separates "on target" from
"nothing here": on the two uncovered requests with candidates the best note scores −1.9 and −1.8, while
real targets score −0.9 to −2.8. So the new rule serves one irrelevant note on those.

## Holdout: PR-mined notes

On `mlflow-v2BC` the same change serves no more rated-2 notes (2 of 7 either way) and drops precision
from 0.82 (the product's search view, floor 0) to 0.55, serving something on 11 requests instead of 6.
The floor is right for PR-mined notes and wrong for understanding notes: the rule must depend on the
note's source.

## What it means for the live run

On the six served5 tasks the new rule serves the same first note the sessions got (it drops the second).
Those sessions had the right notes and still did not spend less: on these tasks finding the code is cheap,
and the gains of the rule are on PR26267 and PR26307, which served5 does not run.

## Proposed

- Understanding notes as their own pool in `orient` (ops.js): the cross-encoder's best of their lexical
  top 8 over the three views, one note, with only a sanity floor (−4); PR and session notes keep the
  shipped rule. A mixed cache serves one of each at most.
- Test it where it changes something: the requests of the harder set the shipped rule fails (PR26267,
  PR26307) plus the covered ones, not the six served5 tasks.

## Prompt forms and serving knobs (2026-10-16, later)

Three forms of each request: the full bug report, its first sentence, and a one-line prompt written by hand from
the request (`prompts.json`). `sweep.mjs`: floor/fallback {0, −2, −4, −6, none} × candidates k {4, 8, 16} ×
views {search, multi} × request tokens read {60, 120, 250}, one note (`sweep-results.json`). `index-fields.mjs`:
`applies` and `searchInstances` added to the lexical index.

| form | today's rule (target / precision / noise) | the pool (multi, −4) | best setting found |
|---|---|---|---|
| full request | 4/8, 0.71, 0/3 | **7/8**, 0.67, 2/3 | the pool |
| first sentence | 4/8, 0.44, 1/3 | 5/8, 0.42, 2/3 | 5/8 at 0.83, 0/3 (k 4, multi, floor 0) |
| one line | 5/8, 0.75, 1/3 | 5/8, 0.45, 2/3 | today's rule |

Short prompts lose their targets before the cross-encoder: at the lexical gate (PR26307, PR26327; both PR26267
targets on one line) or below rank 8 (PR26267 on the first sentence at 21 and 30). A looser gate (any shared
word) and indexing `applies` / `searchInstances` change nothing: the notes describe mechanisms ("live",
"immutable", "finalization") and a short prompt names a symptom ("deepcopy", "pickle", "hangs"). No serving knob
reaches more than 5 of 8 on short prompts. What is left is on the note side: phrasings in the words a request
uses, written at build time.

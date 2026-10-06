# Jev catalog search and note reconciliation

Author: Codex, 2026-10-06.

The question is whether a compact description of every note can support broad
search and help session/PR distillation decide what is already covered, what
extends a note, and what belongs in a new note. The prototype is read-only. It
does not change serving, distillation, or the stored notes.

## Current structure and baseline

Notes contain `id`, `kind`, `title`, `answers`, `body`, optional `applies`, `tags`,
symbol/file `deps` with hashes, `source`, creation/verification metadata and local
usage/freshness state. `says` contains product-language phrasings. Optional
`search` contains a generated 3–6 sentence description. There is no separate
short `summary` field. Experimental Jev facets are not in the production schema.

`phraseNotes` creates `search` alongside `says`. The local cross-encoder uses it;
BM25's `qText`/`bText` do not. Jev's production `noteRecord` uses the first six
nonempty body lines, capped at 900 characters. Session distillation's
`relatedNotes` selects by touched files and lexical matches; compact learning
asks for four notes and shows their first three body lines (up to 400 characters).
PR distillation currently receives no existing notes. Neither pathway receives
an all-note description catalog.

The read-only local snapshot contains 328 non-invalid notes, including archived
notes. Of these, 61 have `search`: 30,916 description characters versus 38,067
body characters for those same notes (18.8% fewer). The existing descriptions
therefore provide partial coverage and modest compression; they are not yet a
uniform, short catalog of the whole cache.

## Hypotheses and experiment

1. A Jev pass over the entire catalog can find an existing note that a small
   lexical shortlist misses.
2. Stored descriptions can reduce inference input without losing those matches.
3. With full bodies supplied after selection, Jev can distinguish covered,
   extending, contradictory and unrelated observations.

`bench/jev-eval/catalog-eval.mjs` compares the existing four-note selector against
two Jev arms: full bodies and `search` descriptions with full-body fallback.
Both Jev arms scan all non-invalid notes in bounded batches, including archives.
Neither uses a lexical gate. The selection threshold is 0.5, with at most four
results. The separate relationship pass always reads complete bodies; a catalog
description never supplies the evidence for a rewrite.

Before calls, the harness writes a manifest pinning `jev-1.13.0`, corpus and
fixture hashes, criteria version, two repetitions, and selection parameters.
There is no generative-model phase, no model judge, and no reasoning-effort
setting. Existing descriptions are held fixed. Model mismatches, missing answers
and request failures stop the run; no provider/model fallback occurs. Response
caches are keyed by request and repeat. Representation order alternates between
repetitions. Tokens and service latency are recorded separately from accuracy.

Nine hand-authored observations in `catalog-cases.json` exercise seven positive
targets and two unrelated cases. These are **constructed text fixtures**, not
claims that the described PRs happened or that these historical notes are still
true. Labels judge the relationship to the frozen note text. The broad corpus
can contain additional legitimate matches, so known-target recall is measurable
but precision is not. The relationship test uses fixed labelled pairs separately
from retrieval; it is not an end-to-end distillation quality measurement.

## Results so far

The deterministic baseline finds all seven labelled positive targets and returns
no notes on the two no-target observations. This small set establishes plumbing
and text-relation checks, but has no room to demonstrate improved target recall.
More difficult, held-out session and PR evidence is required before adopting a
new selection policy.

The live Jev comparison has not run: automatic approval review rejected sending
the private snapshot to TypeSafe without explicit payload/destination approval.
There are no Jev accuracy, token or latency results to report yet.

## Reproduce

Work in an isolated worktree. Supply a frozen JSON array of notes containing the
target IDs from `catalog-cases.json`; include the broader corpus to exercise
search across unrelated notes. Keep raw notes and response caches out of commits.
The source snapshot is never mutated.

```bash
THINKER_TEST=1 node bench/jev-eval/catalog-eval.mjs \
  --notes bench/runs/jev-catalog/notes.json \
  --out bench/runs/jev-catalog/eval --live
```

Live mode uses an existing personal Jev key, read through `jevKey`, and sends
only catalog text/pointers and the fixture observation to the TypeSafe API.
It never enrolls with the hosted proxy or sends production telemetry. Omit
`--live` to replay cached responses; a cache miss then fails instead of calling
a model. Treat a changed fixture or corpus as a separate cohort.

## Adoption criteria

A next evaluation needs actual historical evidence paired with the notes that
existed *before* each session/PR, explicit labels for missed matches and
neighbouring-topic negatives, and an audit of proposed merges against full
bodies. Test fresh and obsolete descriptions, same-topic/different-scope notes,
contradictions, and observations with no existing match. A failure to find a
match does not by itself mean an observation deserves a new note.

If descriptions become part of the runtime catalog, generate them with the
existing note-writing model, invalidate them by a content hash, and preserve
scope and negative constraints. Jev can select and compare these records; it
does not generate the prose. Keep evidence validation and any actual rewrite in
the existing distillation/verification path. In particular, automatic learning
must not rewrite human-authored `behavior` notes.

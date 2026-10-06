# Jev (TypeSafe System One) evaluation harness — 2026-10-06

Scripts behind the numbers in the `jev-fit-for-thinker` memory. All read-only against the
primary checkout; `type-store.mjs` writes only into `typed-noteset/` (a copy).
Needs `JEVKEY` in the environment. Run with `THINKER_TEST=1`.

| script | what it measures |
|---|---|
| `hook-jev-arm.mjs` | **the serving result.** 20 of the 54 labelled tasks, judge gpt-6-sol via existing labels |
| `typed-serving.mjs` / `serve-from-store.mjs` | facet-agreement policy (negative: AUC ~0.50) |
| `type-store.mjs` | persists `facets` + `facetKey` onto a note copy |
| `type-notes.mjs` / `type-notes-v2.mjs` | facet schema v1 vs v2 (catch-all lesson) |
| `typed-verify.mjs` | drift-surface-derived verify verdicts (hot/cold trap) |

`bench/jev-eval/typed-noteset/` (347 typed notes) is regenerable via `type-store.mjs` and not committed.

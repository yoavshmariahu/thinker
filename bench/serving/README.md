# Serving assessment (2026-10-11)

Free, offline measurement of what the hook would serve on the mlflow benchmark requests, scored
by a relevance judge. No agent runs. Built after the answer-key leak voided the agent runs of the
day (bench/runs/mlflow-contaminated-2026-10-11/README.md).

Question: for each request, does a useful note exist in the cache, and does serving reach it?

- `serving-assessment.mjs`: per request, notes pointing at a gold file, their lexical rank,
  cross-encoder score, and what the shipped policy serves (file-pointer proxy only).
- `judge-relevance.mjs` / `judge-relevance-B.mjs`: a Haiku judge rates every plausible candidate
  (notes pointing at a gold file or its directory, plus the lexical top 20 with the gate off):
  2 = about the mechanism the task changes, 1 = a useful map of the area, 0 = unrelated. Output
  `relevance-labels.json` (shipped notesets mlflow-v1/v2) and `relevance-labels-B.json` (the
  candidate-B notesets mlflow-v1B/v2B). Pin the judge with THINKER_LLM=claude: without it the
  provider fallback silently switched some calls to Gemini.
- `misses.mjs`: every judged-useful note, where serving loses it (lexical gate, rank, floor, cap).
- `policy-sim.mjs` / `policy-sim-B.mjs [sidecar.json ...]`: serving policies (gate on/off,
  candidates k, floor, max notes) × phrasings over the 32 requests, scored by the labels.
  A sidecar maps note id → { search, says } and replaces both fields before ranking.
  `ONLY=harder|first|harderB|firstB` restricts to one set.
- `rephrase.mjs`, `rephraseA.mjs`, `rephraseA-B.mjs`: alternative phrasings written to sidecars
  (`search2.json` mechanism-first draft, `searchA.json` candidate A over the shipped notes,
  `searchA-B.json` candidate A over the B notes). `compare-phrasing.mjs`: shipped vs a sidecar.
- `system-B.txt`: the candidate-B mining prompt (PR #204). `prompt-candidates.md`: A, B, C as
  reviewed.

## Findings

32 requests (19 first set, 13 harder set), shipped serving = cross-encoder floor 0, two notes
(PR #199), lexical gate on, 8 candidates.

| noteset / phrasing | serving | requests served a useful note | served nothing | useful notes served (on-mechanism) | unrelated served | notes per request |
|---|---|---:|---:|---:|---:|---:|
| shipped mining, shipped phrasing | shipped | 3 | 24 | 4 (1) | 8 | 0.4 |
| shipped mining, candidate A phrasing | shipped | 4 | 21 | 5 (1) | 10 | 0.5 |
| shipped mining, candidate A phrasing | gate off, k 8 | 7 | 18 | 9 (1) | 11 | 0.7 |
| candidate B mining, shipped phrasing | shipped | 7 | 23 | 10 (4) | 7 | 0.5 |
| candidate B mining, candidate A phrasing | shipped | 6 | 23 | 7 (3) | 9 | 0.5 |

- The cache's notes are organized around the bug that produced them, so they match only requests
  that resemble that bug. Of 36 judged-useful notes in the shipped notesets, 4 were served; 20
  never reached the ranker (lexical cover gate), the rest scored below the floor or were crowded
  out by the cap. Checked by eye, the ranker's rejections of same-file notes about other changes
  were right: a file pointer is not topic relevance.
- Candidate B (mine for the future caller: a "Path:" line first, mechanism-then-rule titles,
  answers covering other tasks on the same path) is the change that moves every column the right
  way with serving untouched; it also writes fewer notes (480 vs 611 from the same 500 PRs).
  Candidate A phrasing helps the shipped notes only together with dropping the lexical gate, and
  does not stack on B. Candidate C (map notes per chokepoint from the same PRs) was dropped: the
  requests B still misses either have no note near them at all (no PR in the window touched that
  code) or have useful notes that serving loses, neither of which more PR-mined maps address.
- Caveat: the judge reads the note text, and a Path line may make it readier to rate a note
  useful. The unrelated count falling under B is the part that cannot be explained that way. The
  agent-level test (clean harness, bench/oracle.js) is still to run.

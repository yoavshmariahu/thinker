# A note's description was specified longer than the note

Author: Claude Opus 5, with Yoav. 2026-10-07.

`phraseNotes` asked for "3 to 6 plain sentences" per note. Note bodies are one to three lines
since the PR-mining work tightened the writer, so the description had to pad, and padding is
unsupported text. Measured on 38 notes mined from Click with `claude-opus-5-5` at high effort:
the descriptions came back at a median of 9 sentences and 450 characters against bodies of
270 characters, 37 of 38 longer than their own source.

Making the length proportional ("never longer than the note itself: one sentence for a one-line
note, at most four for the longest", and only the content the note states) changes that:

| | before | after |
| --- | ---: | ---: |
| support, median | 0.625 | 0.90 |
| scope, median | 0.865 | 0.86 |
| both at least 0.9 | 0 of 38 | 4 of 38 |
| description characters, median | 450 | 268 |
| sentences, median | 9 | 5 |
| `says` lines, median | 4 | 3 |
| longer than its own body | 37 of 38 | 23 of 38 |
| tokens for 38 notes | ~32k | ~24k |

Support is the question "is every claim in the description supported by the note"; scope is
"does it preserve the conditions and prohibitions". Both are Jev Nouls, one judge, one prompt,
one repetition per arm, on the same 38 notes and the same writer model: a directional measurement,
not a calibrated estimate. `measure.mjs` runs them as a diagnostic.

Two causes, independent of each other. The prompt asked for more than the notes support, which the
proportional length fixes. And 0.9 was above where this judge sits on faithful text: scope stays
near 0.86 whatever the length, so that floor would still reject 35 of these 38.

The settled design, chosen by the user on 2026-10-07: keep the check, at 0.7, and write a refused
description again once before giving up on it.

| arm | descriptions kept | refused | tokens for 38 notes |
| --- | ---: | ---: | ---: |
| floor 0.9, no retry | 0 of 38 | 38 | ~64k |
| no check at all | 38 of 38 | 0 | ~24k |
| floor 0.7, one retry | 37 of 38 | 1 | ~54k |

The one refusal scored support 0.54 after its rewrite. `phraseRefused` records the key and the
scores, so maintenance does not offer that note to the writer again until the note itself changes;
without that record the same refusal is paid for on every later run. A note with no accepted
description ranks on its body, which is what Jev reads when a description is absent.

Reproduce: strip `search`, `says` and `saysFor` from a cache's notes, run `thinker phrase`, then
`node research/phrase-length/measure.mjs <cache dir>`. Needs a personal Jev key.

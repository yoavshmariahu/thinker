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

Two conclusions, independent of each other. The prompt was asking for more than the notes
support, which this fixes. And the removed fidelity gate (PR #122) required 0.9 on both: it would
still reject 34 of these 38 descriptions, because scope sits at 0.86 whatever the length. A gate
that strict in front of a text that only ranks candidates, and that no agent is ever shown, costs
far more in lost descriptions than it saves.

Reproduce: strip `search`, `says` and `saysFor` from a cache's notes, run `thinker phrase`, then
`node research/phrase-length/measure.mjs <cache dir>`. Needs a personal Jev key.

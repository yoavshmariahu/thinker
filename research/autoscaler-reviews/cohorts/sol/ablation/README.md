# GPT Sol cached-review note-text ablation

This is an extra control for the ten-case [paired review cohort](../README.md), using the same frozen regressions and note set. Each run uses the **holistic cached-review path** with the same retrieval (`related:true`), selected note slots, dependency state, code snippets, diff, system prompt, and JSON schema as the full-note cached arm. The only source change is the `THINKER_REDACT_NOTE_TEXT=1` branch in `src/review.js:assessHolistic`: for every selected note, its title, body, applies text, and ID are replaced with a fixed placeholder before model invocation. Paths and symbols in dependency state remain, as do selected code snippets. The output report still records note titles for audit; those report fields are computed outside the model prompt.

The model and effort are pinned exactly as in the original cohort: `gpt-6.1-sol`, `high`, Codex CLI, no fallback; each of the ten runs reports one `codex/gpt-6.1-sol` call and no errors. `THINKER_TEST=1`, telemetry off, local logging, and learning off apply. `results.json` holds complete reports. `scores.json` applies the original actionable-hit rule: an error or warning in a changed production file within six lines of the reversed fix, with an explanation matching the historical failure.

| Historical fix | No cache | Full notes | Redacted note text |
| --- | --- | --- | --- |
| #10325 stale quick OOM | Hit | Hit | Miss |
| #10178 checkpoint cleanup | Hit | Hit (both failures) | Hit (retry failure) |
| #10141 DaemonSet updates | Miss | Hit | Miss |
| #10349 AWS placeholder slash | Hit | Miss | Hit |
| #10258 CAPI zone | Miss | Hit | Miss |
| #10094 transient resize | Hit | Hit | Miss |
| #9949 Scaleway creation state | Miss | Hit | Miss |
| #10001 CAPI Failed phase | Miss | Hit | Miss |
| #9725 fresh OOM | Hit | Hit | Hit |
| #9691 JSONPatch escaping | Hit | Hit | Hit |

**Observed recall:** no cache 6/10; cached with full notes 9/10; cached with note text redacted 4/10. All four cache-only wins (#10141, #10258, #9949, #10001) disappear when note text is withheld. The redacted arm still selected exactly 54 note slots, the same count as the full-note arm. Review tokens were 178,908 redacted versus 191,053 full-note; the missing note text explains much of the difference. Total model-call time was 119.8 seconds redacted, versus 178.6 seconds full-note; timings are not a controlled latency estimate.

The reversal on #10349 matters: the redacted arm caught the historical slash-truncation bug that the full-note arm missed. The result supports a contribution from note content to the four observed extra detections, while also showing single-run model variability or attention effects. This is an in-sample exercise: notes were mined from the same fixes later reversed, so the numbers are not prospective bug-detection rates. This control keeps selected code context and dependency paths, so it isolates note *text*, not the entire retrieval system.

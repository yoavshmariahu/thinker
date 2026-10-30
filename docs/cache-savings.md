# Estimated input savings

The Report's **Estimated input tokens saved** total includes the repeated input
that an avoided code read would have added to later model calls. It subtracts the
cached note's text each time that text appears in the outgoing request. A hit stays
one hit even when its estimated saving grows through a long session.

The calculation keeps the existing estimate of reading replaced: at most five
dependency files per note, at most 6,000 tokens per file. That reading is still
hypothetical. A confirmed assessment means the agent acted on a note; it does not
prove every estimated read was avoided. The label therefore stays **estimated**.

Where Claude's transcript retains request references, thinker counts successful
main-thread requests containing the rendered note. Request prefixes, branches and
dropped context determine its lifetime. Duplicate note copies each cost input but
do not earn another reading credit. Notes sharing files share one reading credit
per request; historical records without per-file sizes share their largest credit
instead of being added together. New serving records keep the file sizes and note
injection size needed for that accounting.

At an observed new proxy clear, the hypothetical reading stops contributing while
the surviving note still costs input. Clear responses are cumulative, so repeats
of an old clear do not make new boundaries. This is an estimate of what clearing
would have done to the hypothetical reading, not a counterfactual replay. Missing
historical clearing records remain a limitation. Paraphrases of a note after
compaction are not counted unless the rendered note is still identifiable.

The card shows **Hits with lifetime data** and **One-read fallback**. Claude
Desktop, Codex, Cursor and other clients work without a model login: where their
transcripts do not expose request membership, they retain a one-read estimate
minus the first note injection. No fixed lifetime multiplier or model call fills
the missing evidence. Negative totals remain visible. Unknown message bodies are
not guessed; additional note text in them may be missing from the overhead.

The CLI report and page read the same total and description. The session footer
uses the same calculation on the session's served notes, provisionally including
notes not assessed yet and excluding ones assessed unused or contradicted. The
aggregate report includes confirmed notes only. A retried Stop hook does not
repeat an unchanged lifetime total. Transcripts are cached by file size and mtime;
persisted results contain times and note sizes, not transcript text.

The dollar card continues to price initial reading, with a caption saying re-reads
are not priced. Repeated input must not be valued as fresh input indiscriminately.
Existing holdout comparisons retain precedence when sufficiently populated; a
machine-wide mixture of measured and estimated repository totals is labeled
estimated. Provider clearing savings remain separate.

For compatibility, `thinker usage --json` retains `saved.tokens`, `saved.net`, and
`saved.byModel` as the older one-read accounting. The new `saved.input` object
contains the report's lifetime estimate and coverage. Existing telemetry fields based on one-read accounting remain compatible. Learning costs
are not included in the new per-hit input estimate.

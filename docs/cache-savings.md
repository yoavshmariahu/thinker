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

Coverage counts remain available in the JSON report. Claude Desktop, Codex, Cursor
and other clients work without a model login: where their transcripts do not expose request membership, they retain a one-read estimate
minus the first note injection. No fixed lifetime multiplier or model call fills
the missing evidence. Negative totals remain visible. Unknown message bodies are
not guessed; additional note text in them may be missing from the overhead.

The CLI report and page read the same total and description. The session footer
uses the same calculation on the session's served notes, provisionally including
notes not assessed yet and excluding ones assessed unused or contradicted. The
aggregate report includes confirmed notes only. A retried Stop hook does not
repeat an unchanged lifetime total. Transcripts are cached by file size and mtime;
persisted results contain times and note sizes, not transcript text.

The **Estimated $ saved** card prices the same net input saved from cache hits,
including repeated reads and subtracting carried note text. Each request uses its
recorded model and the proportions of fresh input, prompt-cache reads and cache
writes in its reported usage; one-hour writes use their own rate. The exact cache
position of hypothetical avoided reading is unknown, so this is an estimated
API-list-price equivalent, not measured billing savings. Missing lifetime data
uses the same single-read estimate as the token card, at the session model's input
rate. Unknown models remain unpriced and are named beside the total. Negative
savings remain visible. Existing sufficiently populated holdout comparisons retain
precedence and use their existing per-model input-price estimate. Provider clearing
savings remain separate.

For compatibility, `thinker usage --json` retains `saved.tokens`, `saved.net`, and
`saved.byModel` as the older one-read accounting. The new `saved.input` object
contains the report's lifetime estimate, coverage and input mix by model. Existing PR attribution and telemetry fields based on one-read accounting remain compatible. Learning costs
are not included in the new per-hit input estimate.

## The savings footer

Every client thinker has a door into shows what it has saved, in dollars, for today and over the
whole log: the far right of the Claude Code status row (terminal and desktop app), the Codex desktop
card, the Cursor table, and the end-of-turn line in Codex CLI and in a Claude Code without the card
mod. `thinker savings` prints the same figures with their split.

The footer does not compute anything of its own. `savings-ledger.js` asks the Report page's savings
table (`report-savings.js:weeklySavings`) for two windows instead of six weeks, so both of its series
are counted the way the Report counts them: avoided reading priced at each request's observed mix of
fresh input, cache reads and cache writes, and context the proxy cleared priced as the prompt-cache
reads it replaced. A figure under a prompt therefore cannot contradict `thinker report`.

Cleared context moves far more tokens than avoided reading and is worth a fraction of each, so it
dominates the lifetime total. Surfaces with room show the split rather than the total alone. These are
API-list-price equivalents at the rates in `prices.js`, not measured billing: the rest of the product
counts tokens for the reason recorded there, and this is the second exception after the Report page.

The two windows select servings differently, and every surface that explains itself says which is
which. Lifetime counts servings a finished session confirmed, exactly as the aggregate report does.
Today counts what has already been served, less anything a session reported unused or contradicted --
the rule the running session's own footer uses -- priced at the model the session's transcript names.
Waiting for the assessments would leave a daily figure at $0 for most of a working day: on the
machine this was built on, only 15% of the sessions ever served notes have been assessed at all, and
of those the median was assessed 72 minutes after its first serving. A ledger stamped on a day that
has passed says lifetime alone rather than presenting yesterday's figure as today's.

The ledger is the machine's (`THINKER_HOME/state/savings.json`), since lifetime spans every checkout.
Working it out is a read of the whole log and of the sessions its savings records name, so no hook and
no status line does it: the Stop hook starts `thinker savings --refresh` in the background at most
every ten minutes under a lock, makes no model call, and every surface reads the kept file. Notices
off silences the footer with everything else.

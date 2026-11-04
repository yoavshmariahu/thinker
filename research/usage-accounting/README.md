# Complete Responses usage capture

Launch experiments only through an approved Artemis plan. `arm.mjs` is the
before/after adapter for a fresh Django compression comparison: Astra high,
no knowledge notes, the current turn-boundary cutting policy, fresh control
and treatment sessions. It requires `EXPECTED_THINKER_COMMIT`,
`COMPRESSION_ARM=on|off`, and `THINKER_PROXY_PORT`; the commit check prevents
silently switching the implementation under an existing plan.

The after step runs `thinker proxy report --json --verify-usage`. A nonzero
exit invalidates accounting rather than publishing a partial cost. This gate:

- Requires preserved provider input, cached-read, cache-write and output counts
  on every recorded Responses request, including native compaction.
- Checks normalized counts against raw usage, unique response IDs, completed
  status, model and service-tier metadata, and consistent input partitions.
- Requires the lifetime split when write tokens are positive. Explicit zero is
  valid without a split; an absent write field is never zero.
- Rejects malformed log records, transport errors and incomplete responses.
- Exports `apiRequests` with raw usage, without prompts or request headers.

The adapter also checks the dump count against the request count, matches dump
usage to the exported records, checks the exact model and effort, and verifies
that the control was unedited. This verifies recorded traffic, not provider
billing. Keep default-tier, context-threshold and cache-lifetime checks in the
Artemis pricing report. Use the API's per-request output count once: reasoning
tokens are already included. Never sum cumulative resumed-turn CLI counters.

Before spending on a full pair, run a short capture preflight through Artemis
with the same adapter and provider route. If the backend omits write counters,
the preflight must fail; do not substitute zero. The full sessions are verified
again after completion. The gate cannot force a provider to expose a field.

Costs calculated from these tokens are API-equivalent estimates, not ChatGPT
subscription invoices. Historical Django runs lacking write counters retain
their unknowns. New data does not retroactively establish their write counts.

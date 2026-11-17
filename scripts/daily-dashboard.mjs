// Thinker by day: what was saved (by the clearing and by delegation), who used it, how often it cut and delegated, and how many machines there are.
//
// Every card but the last is a day's own figure, exploded from a block's `byDay` map: `sessions.byDay`
// (src/delivery-telemetry.js: a session on the UTC day of its last request, with what its clearing netted),
// `proxy.byDay` (src/telemetry.js:proxyMetrics: the cuts) and `delegate.byDay` (delegateMetrics). A day's figure
// is taken from the newest snapshot that carries that day for that device, so days add up, a total can be
// summed, and a day does not disappear when it rolls out of a machine's 30-day window. The 30-day sums of the
// other dashboards can do none of that: two snapshots a day apart differ by what came in and by what rolled out.
//
// A client from before a field sends none of it, which is not zero: a line starts where the fleet's clients do.
const device = "coalesce('device:' || device_id, 'install:' || install_id)";
const daily = `(SELECT DISTINCT ON (date_trunc('day', received_at AT TIME ZONE 'UTC'), ${device}) *
  FROM reports ORDER BY date_trunc('day', received_at AT TIME ZONE 'UTC'), ${device}, received_at DESC, file_key DESC) daily_snapshots`;
// one row per device and day of a block's byDay, from the newest snapshot holding that day; `prefer` puts the
// snapshots it holds for first, so a day both kinds carry is read from the preferred one however old it is
const days = (block, prefer = 'TRUE') => `(SELECT DISTINCT ON (s.device, dd.day) s.device, dd.day::date AS day_utc, dd.figures, s.preferred
  FROM (SELECT ${device} AS device, received_at, file_key, raw_json, coalesce(${prefer}, FALSE) AS preferred FROM ${daily}) s
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.raw_json #> '{${block},byDay}') = 'object' THEN s.raw_json #> '{${block},byDay}' ELSE '{}'::jsonb END) AS dd(day, figures)
  WHERE dd.day ~ '^\\d{4}-\\d{2}-\\d{2}$'
  ORDER BY s.device, dd.day, s.preferred DESC, s.received_at DESC, s.file_key DESC) days`;
const fig = name => `(CASE WHEN jsonb_typeof(figures->'${name}') = 'number' THEN (figures->>'${name}')::numeric END)`;

// No saving is counted on or before 2026-11-04 (the owner's call, 2026-11-16; src/delivery.js:COST_SINCE holds the
// same line on the client). Thinker began cutting the context itself that day; before it the clearing was the
// API's, measured as a loss, and its days are in no savings card.
export const SAVINGS_SINCE = '2026-11-05';
const netNote = 'Netted, at list prices: the tokens the clearing left out of later prompts at the cache-read rate, less the cache writes the calls after a clear paid for, summed over the sessions whose last request was that UTC day (src/delivery-telemetry.js sessions.byDay). A loss reads as a loss. Sessions whose model has no list price are in no dollar figure.';

// What the first reading got wrong (-$376, nearly all of it one machine's 8 November): a session was dated by the
// newest log row naming it, and the profile's background read of an old session is such a row, so one rebuild
// moved three weeks of the older clearing's sessions past the line. Clients now date a session by its own turns
// and say so (`byDaySchema` 2, src/delivery-telemetry.js). A day is read from such a snapshot wherever a device
// has sent one; a device still on an older client is read as it reported, and the cards count how many are which.
// Reading the corrected snapshots alone left the dashboard empty until the fleet updated (the owner, 2026-11-16).
const dated = "raw_json #>> '{sessions,byDaySchema}' = '2'";
const dollars = days('sessions', dated);
const datedNote = 'A device on a client released after 0.4.0 dates a session by its own turns. An older client can place an old session on the day the profile read it, which moved losses of the older clearing past the line on one machine; its days are counted as it reported them until it updates, and "devices with corrected dating" says how many of the devices in a figure have.';
const delegationNote = 'Delegation: a read or a suite run handed to a subagent never enters the lead\'s context, so the lead does not write it to its cache (counted once, on the day of the handoff) and does not read it back on each later call (counted on the day of that call, until a cut or a compaction would have taken it out anyway), less what the subagent cost. The machine\'s own savings ledger, the figure its footer and Report show (src/report-savings.js:delegationSavings; src/telemetry.js:delegateMetrics). Sent by clients released after 0.4.0.';
// Only a saving that names the cut policy that made it is counted (the owner's call, 2026-11-16). A clear with no
// stamp is an older client's or an older clearing's, and two days' losses on the first reading were exactly those:
// one machine charged $64 of rewrites on a day it spent $7. `netUsd` still travels in the block; no card reads it.
const stampedNote = 'Only sessions whose clear carries the cut policy that made it are counted (src/cutting.js:policyId, clients from 0.3.3): a clear with no recorded policy, or a session cleared under two, is in no figure here.';

export const dailyQuestions = [
  { name: `Total saved since ${SAVINGS_SINCE}`, display: 'scalar',
    sql: `SELECT round(coalesce(c.usd, 0) + coalesce(g.usd, 0), 2) AS net_saved_usd, round(c.usd, 2) AS by_clearing_usd, round(g.usd, 2) AS by_delegation_usd
      FROM (SELECT sum(${fig('stampedNetUsd')}) AS usd, count(${fig('stampedNetUsd')}) AS n FROM ${dollars} WHERE day_utc >= DATE '${SAVINGS_SINCE}') c
      CROSS JOIN (SELECT sum(${fig('savedUsd')}) AS usd, count(${fig('savedUsd')}) AS n FROM ${days('delegate')} WHERE day_utc >= DATE '${SAVINGS_SINCE}') g
      WHERE c.n + g.n > 0`,
    description: `Every day from ${SAVINGS_SINCE} on, every reporting device, added up: what the clearing netted plus what delegation saved, the two series of "Saved per day" and "Saved by delegation, per day". ${netNote} ${stampedNote} ${delegationNote} ${datedNote}` },

  { name: 'Saved per day', display: 'bar',
    sql: `SELECT day_utc, round(sum(${fig('stampedNetUsd')}), 2) AS net_saved_usd, round(sum(${fig('stampedSavedUsd')}), 2) AS saved_before_rewrites_usd,
      sum(${fig('stampedSessions')}) AS sessions_cleared,
      count(DISTINCT device) FILTER (WHERE ${fig('stampedSessions')} > 0) AS devices_cleared, count(DISTINCT device) FILTER (WHERE ${fig('stampedSessions')} > 0 AND preferred) AS devices_with_corrected_dating
      FROM ${dollars} WHERE day_utc >= DATE '${SAVINGS_SINCE}' AND ${fig('stampedNetUsd')} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['net_saved_usd'] },
    description: `What the clearing netted; the total beside it adds what delegation saved (the next card). ${netNote} Saved before rewrites is the gross figure the Report page shows. ${stampedNote} ${datedNote}` },

  { name: 'Saved by delegation, per day', display: 'bar',
    sql: `SELECT day_utc, round(sum(${fig('savedUsd')}), 2) AS saved_by_delegation_usd, sum(${fig('savedTokens')}) AS tokens_kept_out_of_the_lead,
      sum(${fig('unpricedTokens')}) AS tokens_with_no_list_price, sum(${fig('delegated')}) AS delegated,
      count(DISTINCT device) FILTER (WHERE ${fig('savedTokens')} > 0) AS devices
      FROM ${days('delegate')} WHERE day_utc >= DATE '${SAVINGS_SINCE}' AND ${fig('savedTokens')} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['saved_by_delegation_usd'] },
    description: `${delegationNote} Tokens kept out of the lead counts a delegated read once for the write and once for every later call that would have read it back. Tokens in a session whose model has no list price are in the token column and in no dollar figure.` },

  { name: 'Devices with a thinker session, per day', display: 'line',
    sql: `SELECT day_utc, count(DISTINCT device) FILTER (WHERE ${fig('sessions')} > 0) AS devices_with_a_session, sum(${fig('sessions')}) AS sessions
      FROM ${days('sessions')} GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['devices_with_a_session'] },
    description: 'Devices on which thinker recorded at least one agent session whose last request was that UTC day. A device is a machine, so one person with two machines is two. A session held out from the clearing or the profile still counts: thinker was running in it.' },

  { name: 'Context cuts per day', display: 'bar',
    sql: `SELECT day_utc, sum(${fig('cuts')}) AS context_cuts, sum(${fig('requestsCleared')}) AS requests_sent_shorter, sum(${fig('cleared')}) AS tokens_left_out,
      count(DISTINCT device) FILTER (WHERE ${fig('cuts')} > 0) AS devices_cut_for
      FROM ${days('proxy')} GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['context_cuts'] },
    description: 'A cut is one decision to drop finished tool results at a turn boundary (the proxy row that carries `clear`, by any of its three doors). Every later request of the conversation is sent shorter by it: those are the requests column, not cuts. Counted by clients released after 0.4.0; an older client reports the requests and tokens alone. A desktop session cleared by the mod inside it never reaches the proxy and is not here.' },

  { name: 'Delegations to a subagent, per day', display: 'bar',
    sql: `SELECT day_utc, sum(${fig('delegated')}) AS delegated, sum(${fig('held')}) AS held_out, sum(${fig('failed')}) AS failed, sum(${fig('cached')}) AS answered_from_the_turns_report,
      round(sum(${fig('costUsd')}), 2) AS subagent_cost_usd, count(DISTINCT device) FILTER (WHERE ${fig('delegated')} > 0) AS devices
      FROM ${days('delegate')} GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['delegated'] },
    description: 'Reads and whole-suite test runs the delegation trigger handed to a subagent instead of the model (src/delegate.js; src/telemetry.js:delegateMetrics). Held out is a firing in a session the holdout kept as it was; failed is a subagent that errored or timed out, where the call went through. Subagent cost is what the runs themselves reported. Sent by clients released after 0.4.0.' },

  { name: 'Known devices, per day', display: 'line',
    sql: `SELECT day_utc, sum(count(*)) OVER (ORDER BY day_utc) AS known_devices, count(*) AS new_devices
      FROM (SELECT device_id, min(date_trunc('day', received_at AT TIME ZONE 'UTC')) AS day_utc FROM reports WHERE device_id IS NOT NULL GROUP BY 1) first_seen
      GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['known_devices'] },
    description: 'Every device that has ever sent a report, counted from the UTC day of its first one: the running total, with the day\'s new devices beside it. A device that uninstalled stays known. A day with no new device has no point of its own.' },
].map(q => ({ ...q, daily: true }));

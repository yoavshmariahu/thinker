// Thinker by day: what was saved, who used it, how often it cut and delegated, and how many machines there are.
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
// one row per device and day of a block's byDay, from the newest snapshot holding that day
const days = block => `(SELECT DISTINCT ON (s.device, dd.day) s.device, dd.day::date AS day_utc, dd.figures
  FROM (SELECT ${device} AS device, received_at, file_key, raw_json FROM ${daily}) s
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.raw_json #> '{${block},byDay}') = 'object' THEN s.raw_json #> '{${block},byDay}' ELSE '{}'::jsonb END) AS dd(day, figures)
  WHERE dd.day ~ '^\\d{4}-\\d{2}-\\d{2}$'
  ORDER BY s.device, dd.day, s.received_at DESC, s.file_key DESC) days`;
const fig = name => `(CASE WHEN jsonb_typeof(figures->'${name}') = 'number' THEN (figures->>'${name}')::numeric END)`;

// Savings are counted from the day thinker began cutting the context itself. Before it the clearing was the
// API's, which was measured as a loss; that is another mechanism, and its days are in neither savings card.
export const SAVINGS_SINCE = '2026-11-04';
const netNote = 'Netted, at list prices: the tokens the clearing left out of later prompts at the cache-read rate, less the cache writes the calls after a clear paid for, summed over the sessions whose last request was that UTC day (src/delivery-telemetry.js sessions.byDay). A loss reads as a loss. Sessions whose model has no list price are in no dollar figure.';

export const dailyQuestions = [
  { name: `Total saved since ${SAVINGS_SINCE}`, display: 'scalar',
    sql: `SELECT round(sum(${fig('netUsd')}), 2) AS net_saved_usd FROM ${days('sessions')} WHERE day_utc >= DATE '${SAVINGS_SINCE}' HAVING count(${fig('netUsd')}) > 0`,
    description: `Every day from ${SAVINGS_SINCE} on, every reporting device, added up. ${netNote}` },

  { name: 'Saved per day', display: 'bar',
    sql: `SELECT day_utc, round(sum(${fig('netUsd')}), 2) AS net_saved_usd, round(sum(${fig('savedUsd')}), 2) AS saved_before_rewrites_usd, sum(${fig('clearedSessions')}) AS sessions_cleared, sum(${fig('clearedTokens')}) AS tokens_cleared
      FROM ${days('sessions')} WHERE day_utc >= DATE '${SAVINGS_SINCE}' GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['net_saved_usd'] },
    description: `The bars add up to the total beside them. ${netNote} Saved before rewrites is the gross figure the Report page shows, sent by clients released after 0.4.0.` },

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

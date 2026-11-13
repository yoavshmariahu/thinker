// Savings per session: what thinker saved the people using it, per session, and what those sessions cost.
//
// Reads `raw_json.sessions` (src/delivery-telemetry.js), a 30-day block on the latest report per device
// (installation fallback), so overlapping hourly uploads are never added. A client before 0.3.3 sends no such
// block and is left out, which is not zero.
//
// Three rules this dashboard is built on, each one a mistake already made and corrected here:
//
//  1. **A rate is a ratio of sums.** The client sends groups of sums, never per-session averages, so every
//     figure below divides one sum by another. A mean of per-session ratios reads a three-prompt session like
//     a forty-prompt one: on the machine this was built for that was $13.93 against the true $5.97.
//  2. **Cleared against never cleared, not arm against arm.** A session is grouped by what happened to it.
//     Of 249 sessions on the clearing's side of one machine, 230 had never had a clear, so comparing the arms
//     compared untouched sessions with untouched sessions (the owner's correction, 2026-11-10).
//  3. **Never pool two cut policies.** Every saving names the policy that made it. The API-side clearing was
//     measured as a loss and the 100k floor cut almost nothing, so a figure mixing them says nothing about the
//     policy running today -- and a date in the code could not tell them apart, because nothing here knows when
//     a machine updated.
//
// What it cannot say: a cleared session is a long session, so its cost per session is higher by nature. Cost per
// prompt is the denominator that takes the length out, and even that is not a controlled comparison -- the
// holdout is the only one of those, and it is per machine (`thinker profile holdout`, the clearing's own split
// in `thinker factory --diff compression`). Nothing here identifies a session, a repository or a person.
export const savingsSource = `(SELECT DISTINCT ON (coalesce('device:' || device_id, 'install:' || install_id)) *
  FROM v_latest_installs
  ORDER BY coalesce('device:' || device_id, 'install:' || install_id), timestamp DESC, received_at DESC, file_key DESC) savings_snapshots`;

const valid = "raw_json #>> '{sessions,schemaVersion}' = '1' AND raw_json #>> '{sessions,windowDays}' = '30'";
// a figure inside one of the groups: all / cleared / uncleared
const at = (group, name) => `(CASE WHEN ${valid} AND jsonb_typeof(raw_json #> '{sessions,${group},${name}}') = 'number' THEN (raw_json #>> '{sessions,${group},${name}}')::numeric END)`;
const sum = (group, name) => `sum(${at(group, name)})`;
const per = (a, b) => `round(${a} / nullif(${b}, 0), 2)`;
const pct = (a, b) => `round(100 * ${a} / nullif(${b}, 0), 1)`;
const usd = (group, name) => `round(${sum(group, name)}, 2)`;
const daily = `(SELECT DISTINCT ON (date_trunc('day', received_at AT TIME ZONE 'UTC'), coalesce('device:' || device_id, 'install:' || install_id)) *
  FROM reports ORDER BY date_trunc('day', received_at AT TIME ZONE 'UTC'), coalesce('device:' || device_id, 'install:' || install_id), received_at DESC, file_key DESC) daily_snapshots`;

// A day's own figures, exploded from the snapshot that carries them. The 30-day blocks above cannot be added
// across snapshots -- two a day apart differ by what came in and by what rolled out -- but a day belongs to
// one snapshot, so taking the latest snapshot per device and summing days gives a true total and a real trend.
const dayRows = block => `CROSS JOIN LATERAL jsonb_each(CASE WHEN ${valid} THEN coalesce(raw_json #> '{${block},byDay}', '{}'::jsonb) ELSE '{}'::jsonb END) AS dd(day, figures)`;
const dayDate = "(CASE WHEN dd.day ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN dd.day::date END)";
const fig = name => `sum((dd.figures->>'${name}')::numeric)`;
const prValid = "raw_json #>> '{prs,schemaVersion}' = '3'";
const prDays = `CROSS JOIN LATERAL jsonb_each(CASE WHEN ${prValid} THEN coalesce(raw_json #> '{prs,byDay}', '{}'::jsonb) ELSE '{}'::jsonb END) AS dd(day, figures)`;

// The policy behind each saving (src/delivery-telemetry.js byPolicy; src/cutting.js:policyId). A key of `r<rev>-...` is a
// policy the client stamped on the clear as it made it (0.3.3 and later); `unstamped` is a clear from before the stamp,
// `mixed` a session that spans two policies, `none` a session never cleared. Every session has exactly one key, so
// the keys partition the sessions. The headline figures read the stamped policies alone: the API-side clearing of
// October and the 100k-floor cut are in `unstamped` with the live policy's first week, and a 30-day window that pools
// them read as a loss on every machine (2026-11-12) with the live policy's own week flat or positive.
const policies = `CROSS JOIN LATERAL jsonb_each(CASE WHEN ${valid} THEN coalesce(raw_json #> '{sessions,byPolicy}', '{}'::jsonb) ELSE '{}'::jsonb END) p`;
const STAMPED = "p.key ~ '^r[0-9]'";
const pv = name => `sum((p.value->>'${name}')::numeric)`;
const stamped = name => `sum(CASE WHEN ${STAMPED} THEN (p.value->>'${name}')::numeric END)`;
const stampedNote = 'Over the sessions cleared under a policy the client stamped on the clear (0.3.3 and later), so the clearing policies already measured as losses are not in it; "By the cut policy that saved it" has every policy side by side.';

const netNote = 'Netted, at list prices: the tokens the clearing left out of later prompts at the cache-read rate, less the cache writes the calls after a clear paid for (src/compression.js:clearingCostBySession). A loss reads as a loss. Over the sessions whose model has a price; an unpriced session is in no dollar figure rather than counted at zero.';
const lengthNote = 'A cleared session is a long session -- the clearing fires past 140k of context -- so its cost per session is higher by nature. Read cost per prompt beside it, which takes the length out.';

export const savingsQuestions = [
  { name: 'Sessions measured · 30 days', display: 'scalar',
    sql: `SELECT ${sum('all', 'sessions')} AS sessions FROM ${savingsSource}`,
    description: 'Every agent session recorded on the reporting machines in the last 30 days, whether or not it belonged to a pull request -- which is why this is larger than the delivery figures. Latest snapshot per device, so sessions are never double-counted across uploads.' },

  { name: 'Sessions with a context clear (%)', display: 'scalar',
    sql: `SELECT ${pct(sum('cleared', 'sessions'), sum('all', 'sessions'))} AS cleared_percent FROM ${savingsSource}`,
    description: 'The clearing only fires past 140k of context, so most sessions are never touched by it and that is the design, not a failure. This share is what any per-session saving has to be read against.' },

  { name: 'Net saved per cleared session', display: 'scalar',
    sql: `SELECT ${per(stamped('netUsd'), stamped('pricedSessions'))} AS net_usd_per_cleared_session FROM ${savingsSource} ${policies}`,
    description: `The headline figure. ${stampedNote} ${netNote}` },

  { name: 'Cost per session', display: 'scalar',
    sql: `SELECT ${per(sum('all', 'spendUsd'), sum('all', 'spendSessions'))} AS cost_usd_per_session FROM ${savingsSource}`,
    description: 'Every model call of the session at list prices by token type, subagents each at their own model (src/delivery.js cost.spend). The denominator is the sessions whose counters were complete and whose every model had a price; the rest are in neither column, never at zero. A subscription bills none of it.' },

  { name: 'Total saved, netted · every day reported', display: 'scalar',
    sql: `SELECT round(${fig('netUsd')}, 2) AS total_net_usd FROM ${savingsSource} ${dayRows('sessions')} WHERE ${dayDate} IS NOT NULL`,
    description: `Every policy pooled: a day's figures carry no policy, so the clears from before the stamp are in this total and the headline above does not. A real total, not a window: each day is summed once, from the latest snapshot per device that carries it, so days from different devices and different days add up. This is the figure the 30-day cards above cannot give. It reaches back as far as the reporting devices' own windows do, so it grows as installs keep reporting rather than being a lifetime figure from the start. ${netNote}` },

  { name: 'What a session saves, and what it costs', display: 'table', fullWidth: true,
    sql: `SELECT CASE WHEN ${STAMPED} THEN '1 · Cleared under a recorded policy' WHEN p.key = 'none' THEN '3 · Never cleared' ELSE '2 · Cleared before policies were recorded' END AS sessions_group,
      ${pv('sessions')} AS sessions, ${pv('prompts')} AS prompts,
      round(${pv('spendUsd')} / nullif(${pv('spendSessions')}, 0), 2) AS cost_per_session_usd,
      round(${pv('spendUsd')} / nullif(${pv('prompts')}, 0), 2) AS cost_per_prompt_usd,
      ${pv('clearedTokens')} AS cleared_tokens,
      round(${pv('savedUsd')}, 2) AS saved_usd, round(${pv('rewriteUsd')}, 2) AS rewrite_cost_usd, round(${pv('netUsd')}, 2) AS net_usd,
      ${pv('pricedSessions')} AS priced_sessions, ${pv('lossSessions')} AS sessions_that_lost
      FROM ${savingsSource} ${policies} GROUP BY 1 ORDER BY 1`,
    description: `The table this dashboard exists for. Row 1 is the policy being shipped; row 2 is every clear made before the client stamped its policy (0.3.3), the API-side clearing and the 100k-floor cut among them, and leaves the window on its own. ${lengthNote} Sessions that lost is the count whose cache writes after a clear outweighed what the clearing saved -- the honest denominator of "is it working". ${netNote}` },

  { name: 'Net saved per cleared session · distribution', display: 'bar',
    sql: `SELECT bucket.label AS net_saved_range, sum(CASE WHEN ${valid} AND jsonb_typeof(raw_json #> ARRAY['sessions','netBuckets',bucket.idx::text,'count']) = 'number' THEN (raw_json #>> ARRAY['sessions','netBuckets',bucket.idx::text,'count'])::numeric END) AS sessions
      FROM ${savingsSource}
      CROSS JOIN (VALUES (0, '1 · Broke even or lost'), (1, '2 · Up to $1'), (2, '3 · $1-$5'), (3, '4 · $5-$20'), (4, '5 · Over $20')) bucket(idx, label)
      GROUP BY bucket.idx, bucket.label ORDER BY bucket.idx`,
    settings: { 'graph.dimensions': ['net_saved_range'], 'graph.metrics': ['sessions'] },
    description: 'Every policy pooled, since the buckets carry no policy. Cleared sessions by what the clearing netted in each. The spread is the point: a mean cannot show that a handful of sessions carry a month of saving, or that the first bucket is where the losses are. Priced sessions only.' },

  { name: 'By the cut policy that saved it', display: 'table', fullWidth: true,
    sql: `SELECT CASE p.key WHEN 'none' THEN 'Never cleared' WHEN 'unstamped' THEN 'Cleared before the policy was recorded' WHEN 'mixed' THEN 'Cleared under two policies' ELSE p.key END AS cut_policy,
      sum((p.value->>'sessions')::numeric) AS sessions, sum((p.value->>'prompts')::numeric) AS prompts,
      sum((p.value->>'clearedTokens')::numeric) AS cleared_tokens,
      round(sum((p.value->>'netUsd')::numeric), 2) AS net_usd,
      round(sum((p.value->>'netUsd')::numeric) / nullif(sum((p.value->>'pricedSessions')::numeric), 0), 2) AS net_per_session_usd,
      round(sum((p.value->>'spendUsd')::numeric) / nullif(sum((p.value->>'spendSessions')::numeric), 0), 2) AS cost_per_session_usd,
      sum((p.value->>'lossSessions')::numeric) AS sessions_that_lost
      FROM ${savingsSource} CROSS JOIN LATERAL jsonb_each(CASE WHEN ${valid} THEN raw_json #> '{sessions,byPolicy}' ELSE '{}'::jsonb END) p
      GROUP BY 1 ORDER BY 2 DESC`,
    description: 'Every saving names the cut policy that made it, written on the record by the client that made it (src/cutting.js:policyId: r<rev>-t<trigger>-f<size floor>-p<payback>-<one|deep>; the desktop clearing mod writes the same string). This is the only row set that can answer "is the policy we ship today saving anything", because it never pools it with the ones that lost. A machine on an older client clears under its own policy, which is why no date could do this.' },

  { name: 'By agent', display: 'table',
    sql: `SELECT c.key AS agent, sum((c.value->>'sessions')::numeric) AS sessions, sum((c.value->>'prompts')::numeric) AS prompts,
      sum((c.value->>'clearedSessions')::numeric) AS sessions_cleared, sum((c.value->>'clearedTokens')::numeric) AS cleared_tokens,
      round(sum((c.value->>'netUsd')::numeric), 2) AS net_usd,
      round(sum((c.value->>'spendUsd')::numeric) / nullif(sum((c.value->>'spendSessions')::numeric), 0), 2) AS cost_per_session_usd
      FROM ${savingsSource} CROSS JOIN LATERAL jsonb_each(CASE WHEN ${valid} THEN raw_json #> '{sessions,byClient}' ELSE '{}'::jsonb END) c
      GROUP BY 1 ORDER BY 2 DESC`,
    description: 'The agent the session ran in, as its hooks reported it. A session with no dollar figure is one whose agent reports no usage (Cursor) or whose model has no list price -- counted as a session, in no cost column. Codex sessions are cleared on the Responses path, where the cleared figure is the proxy\'s own estimate rather than the API\'s count.' },

  { name: 'Sessions and clears by day', display: 'line',
    sql: `SELECT date_trunc('day', received_at AT TIME ZONE 'UTC') AS day_utc, ${pv('sessions')} AS sessions, sum(CASE WHEN p.key <> 'none' THEN (p.value->>'sessions')::numeric END) AS sessions_cleared,
      ${per(stamped('netUsd'), stamped('pricedSessions'))} AS net_per_cleared_session_usd
      FROM ${daily} ${policies} GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['sessions', 'sessions_cleared'] },
    description: `Each point is a 30-day rolling block, the latest per reporting device per UTC day. Adjacent points overlap: never add them. The line says how the fleet is moving, not what a day saved. ${stampedNote}` },

  { name: 'Cost per merged pull request by week', display: 'line',
    sql: `SELECT date_trunc('week', ${dayDate}) AS week, round(${fig('spendUsd')} / nullif(${fig('spendPrs')}, 0), 2) AS cost_per_merged_pr_usd,
      ${fig('prs')} AS merged_prs, ${fig('spendPrs')} AS priced_prs, ${fig('clearedPrs')} AS with_a_clear
      FROM ${savingsSource} ${prDays} WHERE ${dayDate} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['week'], 'graph.metrics': ['cost_per_merged_pr_usd'] },
    description: 'What a merged pull request cost in model calls, by the week it merged -- dollars at list prices, every session and subagent of it. Days are additive here, so this is a trend and not a rolling window: read it with priced_prs, since a week of two pull requests moves on one of them. A pull request with an unpriced session is in merged_prs and in neither cost column.' },

  { name: 'Saved and spent by week', display: 'line',
    sql: `SELECT date_trunc('week', ${dayDate}) AS week, round(${fig('netUsd')}, 2) AS net_saved_usd, round(${fig('spendUsd')}, 2) AS spent_usd,
      ${fig('sessions')} AS sessions, ${fig('clearedSessions')} AS sessions_cleared,
      round(${fig('spendUsd')} / nullif(${fig('prompts')}, 0), 2) AS cost_per_prompt_usd
      FROM ${savingsSource} ${dayRows('sessions')} WHERE ${dayDate} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['week'], 'graph.metrics': ['net_saved_usd', 'spent_usd'] },
    description: `Every policy pooled, since a day's figures carry no policy. What the clearing netted each week against what those sessions cost, by the week of each session's last request. Cost per prompt is the length-independent figure beside it. ${netNote}` },

  { name: 'Savings per session by device', display: 'table', fullWidth: true,
    sql: `SELECT coalesce(device_id, 'install:' || install_id) AS device, version, timestamp::date AS snapshot,
      ${at('all', 'sessions')} AS sessions, ${at('cleared', 'sessions')} AS cleared_sessions, ${at('all', 'prompts')} AS prompts,
      ${at('all', 'clearedTokens')} AS cleared_tokens,
      (SELECT round(sum((p.value->>'netUsd')::numeric) / nullif(sum((p.value->>'pricedSessions')::numeric), 0), 2) FROM jsonb_each(coalesce(raw_json #> '{sessions,byPolicy}', '{}'::jsonb)) p WHERE ${STAMPED}) AS net_per_cleared_session_usd,
      (SELECT round(sum((p.value->>'netUsd')::numeric), 2) FROM jsonb_each(coalesce(raw_json #> '{sessions,byPolicy}', '{}'::jsonb)) p WHERE NOT ${STAMPED} AND p.key <> 'none') AS net_before_policies_recorded_usd,
      round(${at('all', 'spendUsd')} / nullif(${at('all', 'spendSessions')}, 0), 2) AS cost_per_session_usd,
      round(${at('all', 'spendUsd')} / nullif(${at('all', 'prompts')}, 0), 2) AS cost_per_prompt_usd,
      ${at('cleared', 'lossSessions')} AS sessions_that_lost, ${at('all', 'unreadableSessions')} AS unreadable_repositories
      FROM ${savingsSource} WHERE ${valid} ORDER BY ${at('all', 'clearedTokens')} DESC NULLS LAST`,
    description: `One row per reporting machine, newest snapshot each. ${stampedNote} The clears from before the stamp are the column beside it, so a machine's old loss is read as old. ${lengthNote} A device is a machine, so one person with two machines is two rows.` },
].map((q, i) => ({ ...q, savings: true, sql: q.display !== 'scalar' ? q.sql : q.sql + ` HAVING ${sum('all', 'sessions')} > 0` }));

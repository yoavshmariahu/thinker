// Pull requests delivered: what the people using thinker shipped, and what thinker saved on it.
//
// Reads `raw_json.prs` (src/delivery-telemetry.js), a 30-day snapshot on the latest report per device
// (installation fallback), so overlapping hourly uploads are never added. A client before 0.2.15 sends no
// such block and is left out, which is not zero. Two figures, never blended in a card title:
// `clearedTokens` is measured (what the API left out of those prompts) and `readingTokens` is the cache's
// estimate of file reading avoided. Nothing here identifies a pull request, a repository or a session.
export const deliverySource = `(SELECT DISTINCT ON (coalesce('device:' || device_id, 'install:' || install_id)) *
  FROM v_latest_installs
  ORDER BY coalesce('device:' || device_id, 'install:' || install_id), timestamp DESC, received_at DESC, file_key DESC) delivery_snapshots`;
// schema 2 is the block as it shipped; 3 adds what a pull request cost, whether it got a context clear and
// the policy behind the saving (src/delivery-telemetry.js). A card reading a field 2 never sent gets null
// there and counts nothing, which is right: not measured is not zero.
const valid = "raw_json #>> '{prs,schemaVersion}' IN ('2', '3') AND raw_json #>> '{prs,windowDays}' = '30'";
export const deliveryField = name => `(CASE WHEN ${valid} AND jsonb_typeof(raw_json #> '{prs,${name}}') = 'number' THEN (raw_json #>> '{prs,${name}}')::numeric END)`;
const sum = name => `sum(${deliveryField(name)})`;
const rate = (a, b) => `round(${sum(a)} / nullif(${sum(b)}, 0), 1)`;
const daily = `(SELECT DISTINCT ON (date_trunc('day', received_at AT TIME ZONE 'UTC'), coalesce('device:' || device_id, 'install:' || install_id)) *
  FROM reports ORDER BY date_trunc('day', received_at AT TIME ZONE 'UTC'), coalesce('device:' || device_id, 'install:' || install_id), received_at DESC, file_key DESC) daily_snapshots`;

const overlap = 'Each point is a 30-day rolling snapshot, the latest per reporting device per UTC day. Adjacent points overlap: never add them.';
const observation = 'The same team pull request can appear on several devices, so these are observations, not unique global pull requests.';
const twoKinds = 'Cleared is measured: the tokens the API reported leaving out of those prompts. Reading avoided is the cache\'s estimate: one read per file behind each note a session acted on. They are added only where the card says so.';

export const deliveryQuestions = [
  { name: 'Merged pull requests worked on with thinker · 30 days', display: 'scalar',
    sql: `SELECT ${sum('merged')} AS merged_with_thinker FROM ${deliverySource}`,
    description: `Merged pull requests that some session on that machine was recorded working on. The repository's other merges are counted apart (seen) and are not in this figure. ${observation}` },

  { name: 'Tokens saved per merged pull request', display: 'scalar',
    sql: `SELECT ${rate('savedTokens', 'merged')} AS saved_per_merged_pr FROM ${deliverySource}`,
    description: `Cleared plus reading avoided, over the merged pull requests worked on with thinker. ${twoKinds}` },

  { name: 'Saved as a share of what those pull requests cost (%)', display: 'scalar',
    sql: `SELECT round(100 * ${sum('savedTokens')} / nullif(${sum('agentTokens')}, 0), 1) AS saved_percent FROM ${deliverySource}`,
    description: `Agent tokens are every prompt and every answer of those sessions added up -- the same shape as the saving, so the share means something. ${twoKinds}` },

  { name: 'Merged pull requests where thinker saved something (%)', display: 'scalar',
    sql: `SELECT round(100 * ${sum('mergedAssisted')} / nullif(${sum('merged')}, 0), 1) AS assisted_percent FROM ${deliverySource}`,
    description: 'Of the merged pull requests worked on with thinker, those with a clearing or an acted-on note behind them. A pull request with neither is counted in the denominator.' },

  { name: 'What was saved, measured against estimated', display: 'bar',
    sql: `SELECT kind, sum(amount) AS tokens FROM ${deliverySource}
      CROSS JOIN LATERAL (VALUES ('Cleared (measured)', ${deliveryField('clearedTokens')}), ('Reading avoided (estimate)', ${deliveryField('readingTokens')})) k(kind, amount)
      WHERE ${valid} GROUP BY kind ORDER BY kind`,
    settings: { 'graph.dimensions': ['kind'], 'graph.metrics': ['tokens'] },
    description: twoKinds },

  { name: 'Saved per merged pull request · distribution', display: 'bar',
    sql: `SELECT bucket.label AS saved_range, sum(CASE WHEN jsonb_typeof(raw_json #> ARRAY['prs','savedBuckets',bucket.idx::text,'count']) = 'number' THEN (raw_json #>> ARRAY['prs','savedBuckets',bucket.idx::text,'count'])::numeric END) AS merged_prs
      FROM ${deliverySource}
      CROSS JOIN (VALUES (0, 'Under 10k'), (1, '10k–50k'), (2, '50k–200k'), (3, '200k–1M'), (4, 'Over 1M')) bucket(idx,label)
      WHERE ${valid} GROUP BY bucket.idx, bucket.label ORDER BY bucket.idx`,
    settings: { 'graph.dimensions': ['saved_range'], 'graph.metrics': ['merged_prs'] },
    description: `Merged pull requests worked on with thinker, by what was saved on each. The first bucket holds those where nothing was saved. ${observation}` },

  { name: 'Saved per merged pull request over time', display: 'line',
    sql: `SELECT date_trunc('day', received_at AT TIME ZONE 'UTC') AS day_utc, ${rate('savedTokens', 'merged')} AS saved_per_merged_pr, ${sum('merged')} AS merged_prs
      FROM ${daily} WHERE ${valid} GROUP BY 1 ORDER BY 1`,
    settings: { 'graph.dimensions': ['day_utc'], 'graph.metrics': ['saved_per_merged_pr'] },
    description: `${overlap} An observed trend, not a measured improvement: nobody is running without thinker to compare against.` },

  { name: 'What a merged pull request costs and takes', display: 'table',
    sql: `SELECT ${rate('agentTokens', 'merged')} AS mean_agent_tokens_per_merged_pr, ${sum('completeTokenPrs')} AS merged_prs_with_complete_counters, ${sum('merged')} AS merged_prs,
      ${rate('hoursToMerge', 'hoursToMergeSamples')} AS mean_hours_open_to_merged, ${sum('hoursToMergeSamples')} AS timing_samples
      FROM ${deliverySource}`,
    description: 'Elapsed wall-clock time, not human effort and not time saved. A session whose agent reported no counters adds nothing to the tokens and leaves that pull request without complete counters.' },

  { name: 'Reach: how much of what people ship is recorded', display: 'table',
    sql: `SELECT count(*) AS latest_reporting_devices, count(*) FILTER (WHERE ${valid}) AS devices_sending_pr_data,
      ${sum('repositoriesWithPrs')} AS repository_observations_with_prs, ${sum('worked')} AS pull_requests_worked_on, ${sum('merged')} AS merged_with_thinker, ${sum('mergedSeen')} AS merged_in_those_repositories,
      ${sum('linkedSessions')} AS sessions_linked_to_a_pr, ${sum('unlinkedSessions')} AS sessions_on_no_pr, ${sum('unreadableRepositories')} AS unreadable_repository_observations,
      max(timestamp) FILTER (WHERE ${valid}) AS latest_snapshot
      FROM ${deliverySource}`,
    description: 'A session on no pull request is work that happened outside one, or a pull request GitHub was never read for. Merged in those repositories is every merge, including the ones no session here touched: the gap is how much of a team\'s work one machine sees.' },

  { name: 'What a merged pull request cost', display: 'table',
    sql: `SELECT round(${sum('spendUsd')} / nullif(${sum('spendPrs')}, 0), 2) AS cost_per_merged_pr_usd, round(${sum('spendUsd')}, 2) AS cost_usd, ${sum('spendPrs')} AS priced_merged_prs, ${sum('merged')} AS merged_prs,
      round(${sum('netUsd')} / nullif(${sum('spendPrs')}, 0), 2) AS net_saved_per_merged_pr_usd
      FROM ${deliverySource}`,
    description: 'Every model call of those pull requests\' sessions at list prices by token type, subagents each at their own model (src/delivery.js cost.spend). The denominator is the pull requests whose EVERY session could be priced: one session on an unpriced model leaves a pull request out of both columns rather than counting it at zero, so this is a cost per priced pull request. A subscription bills none of it. Net saved is the clearing netted of the cache writes after a clear, over the same denominator -- a loss reads as a loss.' },

  { name: 'Merged pull requests with a context clear', display: 'table',
    sql: `SELECT ${pct(sum('clearedPrs'), sum('merged'))} AS with_a_clear_percent, ${sum('clearedPrs')} AS with_a_clear, ${sum('merged')} AS merged_prs,
      round(${sum('clearedTokens')} / nullif(${sum('clearedPrs')}, 0), 0) AS cleared_tokens_per_cleared_pr, ${sum('clearedTokens')} AS cleared_tokens
      FROM ${deliverySource}`,
    description: 'The clearing fires past 140k of context, so a pull request without one is not a failure: nothing in it grew far enough to be worth a cut. Cleared tokens per cleared pull request is the honest per-PR figure -- dividing by every merged pull request would spread one machine\'s long sessions over work the clearing never touched.' },

  { name: 'Saving and cost by the policy that made it', display: 'table', fullWidth: true,
    sql: `SELECT CASE p.key WHEN 'none' THEN 'Never cleared' WHEN 'unstamped' THEN 'Cleared before the policy was recorded' WHEN 'mixed' THEN 'Cleared under two policies' ELSE p.key END AS cut_policy,
      sum((p.value->>'prs')::numeric) AS merged_prs, sum((p.value->>'clearedPrs')::numeric) AS with_a_clear,
      sum((p.value->>'clearedTokens')::numeric) AS cleared_tokens,
      round(sum((p.value->>'spendUsd')::numeric) / nullif(sum((p.value->>'spendPrs')::numeric), 0), 2) AS cost_per_priced_pr_usd,
      sum((p.value->>'spendPrs')::numeric) AS priced_prs,
      round(sum((p.value->>'netUsd')::numeric), 2) AS net_usd
      FROM ${deliverySource} CROSS JOIN LATERAL jsonb_each(CASE WHEN ${valid} THEN raw_json #> '{prs,byPolicy}' ELSE '{}'::jsonb END) p
      GROUP BY 1 ORDER BY 3 DESC`,
    description: 'The cut policy behind each saving, named by the client on the record itself (src/cutting.js:policyId: r<rev>-t<trigger>-f<size floor>-p<payback>-<one|deep>). Policies are never pooled: the API-side clearing was measured as a loss and the 100k floor cut almost nothing, so a figure mixing them says nothing about the one running today. A date in the code cannot do this job -- it cannot know when a machine updated. Cleared before the policy was recorded is every clear made by a client older than this.' },

  { name: 'The merged pull requests themselves', display: 'table', fullWidth: true,
    sql: `SELECT coalesce(device_id, 'install:' || install_id) AS device, (r.value->>'cleared')::boolean AS got_a_clear, r.value->>'policy' AS cut_policy,
      (r.value->>'clearedTokens')::numeric AS cleared_tokens, (r.value->>'spendUsd')::numeric AS cost_usd, (r.value->>'netUsd')::numeric AS net_saved_usd,
      (r.value->>'sessions')::numeric AS sessions, (r.value->>'prompts')::numeric AS prompts, (r.value->>'agentTokens')::numeric AS agent_tokens, (r.value->>'hours')::numeric AS hours_open
      FROM ${deliverySource} CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN ${valid} THEN coalesce(raw_json #> '{prs,rows}', '[]'::jsonb) ELSE '[]'::jsonb END) r
      ORDER BY cost_usd DESC NULLS LAST`,
    description: 'One row per merged pull request, newest 50 per device, numbers only -- nothing here names a pull request, a repository or a session. The rows are what a mean cannot show: on the machine this was built for, five pull requests were most of a fortnight\'s saving. A null cost is a pull request with a session nobody could price.' },

  { name: 'Delivery by reporting device', display: 'table', fullWidth: true,
    sql: `SELECT coalesce(device_id, 'Unknown') AS device_id, install_id, timestamp AS snapshot_time,
      ${deliveryField('merged')} AS merged_with_thinker, ${deliveryField('mergedSeen')} AS merged_seen, ${deliveryField('mergedAssisted')} AS merged_assisted,
      ${deliveryField('clearedTokens')} AS cleared_tokens, ${deliveryField('readingTokens')} AS reading_tokens, ${deliveryField('agentTokens')} AS agent_tokens,
      round(${deliveryField('savedTokens')} / nullif(${deliveryField('merged')}, 0), 1) AS saved_per_merged_pr,
      ${deliveryField('unlinkedSessions')} AS sessions_on_no_pr
      FROM ${deliverySource} WHERE ${valid} ORDER BY timestamp DESC` },
].map((q, i) => ({ ...q, delivery: true, sql: q.display !== 'scalar' ? q.sql : q.sql + ` HAVING ${sum(['merged', 'merged', 'agentTokens', 'merged'][i])} > 0` }));

// a share, for the cards above (the same shape spend-dashboard.mjs uses)
function pct(a, b) { return `round(100 * ${a} / nullif(${b}, 0), 1)`; }

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
const valid = "raw_json #>> '{prs,schemaVersion}' = '2' AND raw_json #>> '{prs,windowDays}' = '30'";
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

  { name: 'Delivery by reporting device', display: 'table', fullWidth: true,
    sql: `SELECT coalesce(device_id, 'Unknown') AS device_id, install_id, timestamp AS snapshot_time,
      ${deliveryField('merged')} AS merged_with_thinker, ${deliveryField('mergedSeen')} AS merged_seen, ${deliveryField('mergedAssisted')} AS merged_assisted,
      ${deliveryField('clearedTokens')} AS cleared_tokens, ${deliveryField('readingTokens')} AS reading_tokens, ${deliveryField('agentTokens')} AS agent_tokens,
      round(${deliveryField('savedTokens')} / nullif(${deliveryField('merged')}, 0), 1) AS saved_per_merged_pr,
      ${deliveryField('unlinkedSessions')} AS sessions_on_no_pr
      FROM ${deliverySource} WHERE ${valid} ORDER BY timestamp DESC` },
].map((q, i) => ({ ...q, delivery: true, sql: q.display !== 'scalar' ? q.sql : q.sql + ` HAVING ${sum(['merged', 'merged', 'agentTokens', 'merged'][i])} > 0` }));

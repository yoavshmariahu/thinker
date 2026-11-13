// Diff by feature: the Factory's two-sided comparisons, pooled over the fleet.
//
// Reads `raw_json.arms` (src/telemetry.js:armsMetrics): per feature, the sessions the feature reached against the
// ones held out from it, as sums per side over every repository of a machine -- sessions, exchanges, dollars at list,
// rework, cache traffic, merged pull requests, loops -- on the latest snapshot per device, so hourly uploads are
// never added. Every rate here is a ratio of sums over the reporting devices, never a mean of per-device rates.
//
// Two features. The memory profile is an assignment: a session is shown the block or held out from it at its start,
// so the two sides are the same work and the difference is the profile's. The clearing is a treatment: the on side
// is the sessions that actually got a clear, the held-out side the ones the hash held out past the clearing's trigger,
// and the on side is grouped by the cut policy that cleared it, so two policies are never pooled.
import { deliverySource as source } from './delivery-dashboard.mjs';

const valid = "raw_json #>> '{arms,schemaVersion}' = '1'";
const device = "coalesce('device:' || device_id, 'install:' || install_id)";
// a number at arms.<feature>.<side>.<keys>, `side` an SQL expression; null where the client sent none (not zero)
const at = (feature, side, ...keys) => {
  const p = `ARRAY['arms','${feature}',${side},${keys.map(k => `'${k}'`).join(',')}]`;
  return `(CASE WHEN ${valid} AND jsonb_typeof(raw_json #> ${p}) = 'number' THEN (raw_json #>> ${p})::numeric END)`;
};
const FEATURES = {
  profile: { name: 'Memory profile', on: 'shown', off: 'holdout', onLabel: 'Shown the profile', offLabel: 'Held out', policy: "'every session'" },
  compression: { name: 'Context clearing', on: 'on', off: 'holdout', onLabel: 'Cleared', offLabel: 'Held out', policy: "coalesce(raw_json #>> '{arms,policy}', 'unknown')" },
};
const STAGES = ['prompts', 'think', 'explore', 'build', 'verify', 'review', 'merge'];

// the two sides of a feature as rows, with the noise band the Factory page shows (src/factory.js:trust): two standard
// errors of the cost-per-session difference, from each side's spread of session costs (`cost2`, the sum of squares)
const sidesTable = f => {
  const F = FEATURES[f], a = (...k) => `sum(${at(f, 'sd.side', ...k)})`;
  return `WITH s AS (
  SELECT sd.ord, sd.label, ${F.policy} AS policy, count(DISTINCT ${device}) FILTER (WHERE ${at(f, 'sd.side', 'sessions')} > 0) AS devices,
    ${a('sessions')} AS sessions, ${a('exchanges')} AS exchanges, ${a('cost')} AS cost, ${a('cost2')} AS cost2, ${a('rework')} AS rework,
    ${a('cacheWrite')} AS cw, ${a('cacheRead')} AS cr, ${a('prs', 'merged')} AS merged, ${a('prs', 'firstPass')} AS first_pass, ${a('prs', 'cost')} AS pr_cost,
    ${a('loops', 'correction', 'loops')} AS corrections, ${a('loops', 'fix', 'loops')} AS fixes
  FROM ${source} CROSS JOIN LATERAL (VALUES (1, '${F.on}', '${F.onLabel}'), (2, '${F.off}', '${F.offLabel}')) sd(ord, side, label)
  WHERE ${valid} GROUP BY 1, 2, 3),
b AS (SELECT policy, 2 * sqrt(sum(CASE WHEN ord = 1 THEN cv2 / sessions END) + sum(CASE WHEN ord = 2 THEN cv2 / sessions END)) AS band
  FROM (SELECT policy, ord, sessions, CASE WHEN sessions > 0 AND cost > 0 THEN greatest(cost2 / sessions - power(cost / sessions, 2), 0) / power(cost / sessions, 2) END AS cv2 FROM s) x GROUP BY policy)
SELECT s.policy AS cut_policy, s.label AS sessions_that_were, s.devices, s.sessions, s.exchanges,
  round(s.cost / nullif(s.sessions, 0), 2) AS cost_per_session_usd, round(s.cost / nullif(s.exchanges, 0), 2) AS cost_per_exchange_usd,
  round(100 * s.rework / nullif(s.cost, 0), 1) AS rework_pct, round(100 * s.cw / nullif(s.cw + s.cr, 0), 1) AS cache_write_pct,
  s.merged AS merged_prs, round(100 * s.first_pass / nullif(s.merged, 0), 1) AS first_pass_pct, round(s.pr_cost / nullif(s.merged, 0), 2) AS cost_per_merged_pr_usd,
  round(s.corrections / nullif(s.sessions, 0), 2) AS corrections_per_session, round(s.fixes / nullif(s.sessions, 0), 2) AS fix_loops_per_session,
  round(100 * b.band) AS noise_band_pct
FROM s LEFT JOIN b USING (policy) ORDER BY s.policy, s.ord`;
};
// rework share per stage, one column a side
const stageTable = f => {
  const F = FEATURES[f];
  return `SELECT ${F.policy} AS cut_policy, st.key AS stage,
  round(100 * sum(${at(f, `'${F.on}'`, 'stages', 'st.key', 'rework')}) / nullif(sum(${at(f, `'${F.on}'`, 'stages', 'st.key', 'cost')}), 0), 1) AS ${F.on}_rework_pct,
  round(100 * sum(${at(f, `'${F.off}'`, 'stages', 'st.key', 'rework')}) / nullif(sum(${at(f, `'${F.off}'`, 'stages', 'st.key', 'cost')}), 0), 1) AS held_out_rework_pct
FROM ${source} CROSS JOIN LATERAL (VALUES ${STAGES.map((s, i) => `('${s}', ${i + 1})`).join(', ')}) st(key, ord)
WHERE ${valid} GROUP BY 1, 2, st.ord ORDER BY 1, st.ord`.replace(/'st\.key'/g, 'st.key');
};
const perExchange = (f, side) => `sum(${at(f, `'${side}'`, 'cost')}) / nullif(sum(${at(f, `'${side}'`, 'exchanges')}), 0)`;
const change = f => `round(100 * (${perExchange(f, FEATURES[f].on)} - ${perExchange(f, FEATURES[f].off)}) / nullif(${perExchange(f, FEATURES[f].off)}, 0), 1)`;
const has = f => `coalesce(${at(f, `'${FEATURES[f].on}'`, 'sessions')}, 0) + coalesce(${at(f, `'${FEATURES[f].off}'`, 'sessions')}, 0) > 0`;
const compared = f => `sum(${at(f, `'${FEATURES[f].on}'`, 'sessions')}) + sum(${at(f, `'${FEATURES[f].off}'`, 'sessions')})`;

const noise = 'Noise band is two standard errors of the cost-per-session difference, from each side\'s spread of session costs: a difference inside it is what two random samples of these sessions would show. Under 20% reads as good, 20-50% fair, over 50% a direction at most (src/factory.js:trust).';
const ratio = 'Every figure is a ratio of sums over the reporting devices, never a mean of per-device rates.';

export const armsQuestions = [
  { name: 'Memory profile · cost per exchange with the profile (%)', display: 'scalar',
    sql: `SELECT ${change('profile')} AS cost_per_exchange_change_pct FROM ${source} HAVING ${compared('profile')} > 0`,
    description: `Cost per exchange of the sessions shown the profile against the ones held out, the held-out side as the base: negative means the profile side was cheaper per exchange. ${ratio} The block itself sits in every call of the shown side, so a small positive figure is its own weight; read it with the rework and correction columns in the table below.` },
  { name: 'Memory profile · sessions compared', display: 'scalar',
    sql: `SELECT ${compared('profile')} AS sessions_compared FROM ${source}`,
    description: 'Sessions on either side of the profile\'s holdout across the reporting devices, over each machine\'s six-week Report window. A session from before the profile shipped has no arm and is in neither.' },
  { name: 'Context clearing · sessions compared', display: 'scalar',
    sql: `SELECT ${compared('compression')} AS sessions_compared FROM ${source}`,
    description: 'Sessions past the clearing\'s trigger that either got a clear or were held out by the hash, across the reporting devices. A session on the clearing\'s arm that never reached a clear is on neither side: nothing touched it.' },
  { name: 'Devices reporting a diff', display: 'scalar',
    sql: `SELECT count(*) AS devices FROM ${source} WHERE ${valid} AND (${has('profile')} OR ${has('compression')})`,
    description: 'Devices whose latest snapshot carries at least one session on a side. A device on a client before 0.3.5 sends no arms block: not measured, not zero.' },
  { name: 'Memory profile · shown against held out', display: 'table', fullWidth: true, sql: sidesTable('profile'),
    description: `The Factory page's "See diff by memory profile", pooled. The two sides are assigned at the session's start by a hash, so they are the same work; what differs is the profile. Cost per exchange is the figure that tells a longer session from a dearer one. ${noise} ${ratio}` },
  { name: 'Context clearing · cleared against held out, by cut policy', display: 'table', fullWidth: true, sql: sidesTable('compression'),
    description: `The Factory page's "See diff by compression", pooled, one block per cut policy (src/cutting.js:policyId), never pooled across them. Cleared is a treatment, not an assignment: these are the sessions a clear actually happened in, against the ones the hash held out past the clearing's trigger; both sides are long sessions by construction. Cache write share is where a clear's cost shows. ${noise} ${ratio}` },
  { name: 'Memory profile · rework by stage', display: 'table', sql: stageTable('profile'),
    description: 'Share of each stage\'s cost that was rework (a loop that came back to it), shown against held out. The Factory page\'s stage rows, pooled.' },
  { name: 'Context clearing · rework by stage, by cut policy', display: 'table', sql: stageTable('compression'),
    description: 'Share of each stage\'s cost that was rework, cleared against held out, per cut policy. A cut that loses the model its context should show here as Explore and Build rework.' },
  { name: 'By device · both features', display: 'table', fullWidth: true,
    sql: `SELECT ${device} AS device, version, timestamp AS snapshot_time, raw_json #>> '{arms,policy}' AS cut_policy,
      (raw_json #>> '{arms,repos}')::int AS repos, (raw_json #>> '{arms,reposWithoutReport}')::int AS repos_without_report,
      ${at('profile', "'shown'", 'sessions')} AS profile_shown_sessions, ${at('profile', "'holdout'", 'sessions')} AS profile_held_out_sessions,
      round(${at('profile', "'shown'", 'cost')} / nullif(${at('profile', "'shown'", 'exchanges')}, 0), 2) AS profile_shown_usd_per_exchange,
      round(${at('profile', "'holdout'", 'cost')} / nullif(${at('profile', "'holdout'", 'exchanges')}, 0), 2) AS profile_held_out_usd_per_exchange,
      ${at('compression', "'on'", 'sessions')} AS cleared_sessions, ${at('compression', "'holdout'", 'sessions')} AS clearing_held_out_sessions,
      round(${at('compression', "'on'", 'cost')} / nullif(${at('compression', "'on'", 'exchanges')}, 0), 2) AS cleared_usd_per_exchange,
      round(${at('compression', "'holdout'", 'cost')} / nullif(${at('compression', "'holdout'", 'exchanges')}, 0), 2) AS clearing_held_out_usd_per_exchange
      FROM ${source} WHERE ${valid} ORDER BY timestamp DESC`,
    description: 'One row per reporting machine, newest snapshot each: how many sessions it has on each side and what each side cost per exchange. Repos without report is how much of the machine the block does not see yet: a repository contributes once its Save page or `thinker report` has been read there.' },
];

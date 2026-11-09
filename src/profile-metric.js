// The session profile's own measure, as one figure: how often the person says again what an earlier session
// already told the agent (profile.js:recurrence), shown the profile against held out, with the cost of an exchange
// beside it (profile.js:holdoutReport). `thinker profile holdout` is the long form; the Report (report.js, the page's
// Report tab and `thinker report`) carries the short one, so the metric the profile is judged by is where the rest
// of the figures are (the owner's ask, 2026-11-08). One computation, two doors: both read `holdoutFromLog`.
//
// What the sessions' tokens and dollars come from: the log's own `session` rows (the last one of a session carries
// its totals, and the arm the session was in), priced at list rates; the exchange counts come from the ledger. A
// repository with no ledger has no metric (null), never a zero.
import { PROFILE, SECTIONS, readLedger, readProfile, lineReport, holdoutReport, profileHoldoutRate, compareRates } from './profile.js';
import { readLog } from './usage.js';
import { listPrice } from './prices.js';

// `events`: the machine's log already read (report.js has it); else read here
export function holdoutFromLog(store, { days = PROFILE.ledgerDays, now = Date.now(), events = null } = {}) {
  const rows = readLedger(store, { days, now });
  const since = now - days * 86400_000;
  const last = new Map();
  for (const e of events || readLog(store, { all: true })) if (e.op === 'session' && e.profile && Date.parse(e.t) >= since) last.set(e.session, e);
  const cfg = (() => { try { return store.config(); } catch { return {}; } })();
  const sessions = new Map();
  for (const [id, e] of last) {
    const cr = e.cacheReadTokens || 0, cw = e.cacheWriteTokens || 0, out = e.outputTokens || 0;
    const fresh = Math.max(0, (e.inputTokens || 0) - cr - cw);
    const tokens = fresh + cr + cw + out;
    const p = listPrice(e.model, { config: cfg });
    const cost = p ? fresh * p.input / 1e6 + cr * p.cacheRead / 1e6 + cw * (p.cacheWrite1h ?? p.cacheWrite) / 1e6 + out * p.output / 1e6 : 0;
    sessions.set(id, { tokens, cost, model: e.model || '?', prompts: e.turns || 0 });
  }
  return { days, rows, rate: profileHoldoutRate(store), report: holdoutReport(rows, { sessions }) };
}

// The figure the Report carries: the two arms' counts and rates, the two comparisons, what is needed before either
// says anything and how long that is at this repository's pace (`pace`), and what the profile holds and how its lines
// fared in the sessions they were shown to (`lines`, profile.js:lineReport). null where the repository has no
// observation in the window.
export function profileMetric(store, opts = {}) {
  const { days, rows, rate, report: h } = holdoutFromLog(store, opts);
  if (!rows.length) return null;
  const now = opts.now ?? Date.now();
  const arm = x => ({
    sessions: x.sessions, observations: x.observations,
    measured: x.recurrence.measured, served: x.recurrence.served, unlearned: x.recurrence.unlearned,
    rate: x.recurrence.rate, servedRate: x.recurrence.servedRate, unlearnedRate: x.recurrence.unlearnedRate,
    corrections: x.rate,
    priced: x.priced, exchanges: x.exchanges, tokens: x.tokens, cost: x.cost,
  });
  const cmp = c => ({ delta: c.delta, ci: c.ci, relative: c.relative, verdict: c.verdict });
  // the pace: measured exchanges over the days they span, so "not enough data" can say when there will be
  const measuredRows = rows.filter(r => (r.arm === 'shown' || r.arm === 'holdout') && r.repeats && typeof r.repeats === 'object');
  const first = measuredRows.length ? Math.min(...measuredRows.map(r => Date.parse(r.at))) : null;
  const spanDays = first ? Math.max(1, (now - first) / 86400_000) : 0;
  const shown = arm(h.shown), holdout = arm(h.holdout);
  const prof = readProfile(store);
  const learned = SECTIONS.reduce((a, sec) => a + (prof?.sections?.[sec] || []).filter(e => e.id).length, 0);
  const lr = (() => { try { return lineReport(store, { days, now, profile: prof }); } catch { return null; } })();
  const live = lr ? lr.lines.filter(l => !l.gone && l.shown) : [];
  const bands = lineBands(live);
  return {
    days, holdoutRate: rate, minExchanges: PROFILE.holdoutMinObs, minSessions: PROFILE.holdoutMinSessions,
    shown, holdout,
    unknown: { observations: h.unknown.observations, sessions: h.unknown.sessions },
    recurrence: cmp(h.recurrence), cost: cmp(h.cost),
    pace: pace({ shown, holdout, spanDays, min: PROFILE.holdoutMinObs }),
    // `shown` is line-sessions (a line shown to a session), `applied` those where it bore on the work: their ratio is how
    // much of the profile a session actually used (the owner's measure of its relevance, 2026-11-08); `followed` of `applied`
    lines: { learned, fromSessions: prof?.window?.sessions || 0, judged: live.length, sessions: lr?.sessions || 0, shown: live.reduce((a, l) => a + l.shown, 0), applied: lr?.applied || 0, followed: lr?.followed || 0, followRate: lr?.followRate ?? null, neverApplied: live.filter(l => !l.applied).length, ...bands },
  };
}
// How often each line is used, in three bands (the owner's ask, 2026-11-08): a line's rate is the sessions it bore on over
// the sessions it was shown to; `rarely` is at or under RARELY (a dead or near-dead line, the one to cut once it has
// been shown enough), `always` at or over ALWAYS (the general rules), `sometimes` between (workstreams and situational
// rules, used when their topic comes up). Counts of the lines judged so far; the doors show them as shares.
export const RARELY = 0.2, ALWAYS = 0.8;
export function lineBands(lines) {
  const rate = l => l.applied / l.shown;
  return { rarely: lines.filter(l => rate(l) <= RARELY).length, sometimes: lines.filter(l => rate(l) > RARELY && rate(l) < ALWAYS).length, always: lines.filter(l => rate(l) >= ALWAYS).length };
}
// Weeks until both arms have `min` measured exchanges, at the rate they have been measured so far; null with no rate
export function pace({ shown, holdout, spanDays, min }) {
  const measured = shown.measured + holdout.measured;
  const need = Math.max(0, min - shown.measured) + Math.max(0, min - holdout.measured);
  const perDay = spanDays > 0 ? measured / spanDays : 0;
  return { measured, spanDays: Math.round(spanDays), need, weeksToGo: need && perDay > 0 ? need / perDay / 7 : need ? null : 0 };
}

// All repositories: the arms pooled (counts added, the rates ratios of the pooled counts, tokens an exchange weighted
// by each repository's priced exchanges), the recurrence compared again over the pooled proportions. The cost
// comparison's interval is bootstrapped over a repository's own sessions and cannot be pooled from the figures, so
// across repositories it carries the delta alone and no verdict.
export function mergeProfileMetrics(metrics) {
  const ms = metrics.filter(Boolean);
  if (!ms.length) return null;
  const pool = key => {
    const xs = ms.map(m => m[key]);
    const sum = f => xs.reduce((a, x) => a + (f(x) || 0), 0);
    const measured = sum(x => x.measured), served = sum(x => x.served), unlearned = sum(x => x.unlearned), exchanges = sum(x => x.exchanges);
    const observations = sum(x => x.observations), bad = xs.reduce((a, x) => a + (x.corrections == null ? 0 : x.corrections * x.observations), 0);
    const priced = xs.every(x => x.cost != null || !x.exchanges);
    return {
      sessions: sum(x => x.sessions), observations, measured, served, unlearned,
      rate: measured ? (served + unlearned) / measured : null, servedRate: measured ? served / measured : null, unlearnedRate: measured ? unlearned / measured : null,
      corrections: observations ? bad / observations : null,
      priced: sum(x => x.priced), exchanges,
      tokens: exchanges ? xs.reduce((a, x) => a + (x.tokens || 0) * x.exchanges, 0) / exchanges : null,
      cost: exchanges && priced ? xs.reduce((a, x) => a + (x.cost || 0) * x.exchanges, 0) / exchanges : null,
    };
  };
  const shown = pool('shown'), holdout = pool('holdout');
  const rec = compareRates(shown, holdout, { min: ms[0].minExchanges });
  const costDelta = shown.tokens != null && holdout.tokens != null ? shown.tokens - holdout.tokens : null;
  const sumOf = f => ms.reduce((a, m) => a + (f(m) || 0), 0);
  const applied = sumOf(m => m.lines?.applied), followed = sumOf(m => m.lines?.followed), shownLines = sumOf(m => m.lines?.shown);
  return {
    days: ms[0].days, holdoutRate: ms[0].holdoutRate, minExchanges: ms[0].minExchanges, minSessions: ms[0].minSessions,
    shown, holdout,
    unknown: { observations: ms.reduce((a, m) => a + m.unknown.observations, 0), sessions: ms.reduce((a, m) => a + m.unknown.sessions, 0) },
    recurrence: { delta: rec.delta, ci: rec.ci, relative: rec.relative, verdict: rec.verdict },
    cost: { delta: costDelta, ci: null, relative: costDelta != null && holdout.tokens ? costDelta / holdout.tokens : null, verdict: null },
    pace: pace({ shown, holdout, spanDays: Math.max(...ms.map(m => m.pace?.spanDays || 0)), min: ms[0].minExchanges }),
    lines: { learned: sumOf(m => m.lines?.learned), fromSessions: sumOf(m => m.lines?.fromSessions), judged: sumOf(m => m.lines?.judged), sessions: sumOf(m => m.lines?.sessions), shown: shownLines, applied, followed, followRate: applied ? followed / applied : null, neverApplied: sumOf(m => m.lines?.neverApplied), rarely: sumOf(m => m.lines?.rarely), sometimes: sumOf(m => m.lines?.sometimes), always: sumOf(m => m.lines?.always) },
    repos: ms.length,
  };
}

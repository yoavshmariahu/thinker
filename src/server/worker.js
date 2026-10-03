// What the server does on its own, one job at a time: distill the sessions clients streamed once
// they have ended or gone quiet, distill the pull requests CI sent, and keep each repository's cache
// maintained (stale notes re-verified, phrasings, co-change) as its default branch moves. Model
// calls go through llm.js like everywhere else; on a server that is ANTHROPIC_API_KEY. Reported
// cost is summed from the repositories' logs and a day stops at the cap.
import fs from 'node:fs';
import path from 'node:path';
import { distillEvents, saveNotes, exploreCount } from '../distill.js';
import { attest } from '../ops.js';
import { distillPr, recordMinedPrs } from '../prs.js';
import { nearDuplicate } from '../share.js';
import { maintain, spentToday } from '../maintain.js';
import { provider } from '../llm.js';

export const DEFAULTS = {
  idleMs: 3 * 60_000,         // a session without new events for this long is distilled
  minExplore: 3,              // tool calls that read or search, below which a session yields nothing
  maxSessionEvents: 4000,     // events of one session the distiller is shown (the last ones)
  fetchEveryMs: 10 * 60_000,  // how often a checkout is fetched before distilling
  maintainEveryMs: 60 * 60_000,
  dailyCap: Number(process.env.THINKER_SERVER_DAILY_CAP) || 5, // USD of reported model cost a day, all repositories
  tickMs: 20_000,
};

export class Worker {
  constructor(repos, { log = () => {}, gitToken = process.env.THINKER_SERVER_GIT_TOKEN, fns = {}, ...opts } = {}) {
    this.repos = repos; this.log = log; this.gitToken = gitToken; this.fns = fns;
    this.opts = { ...DEFAULTS, ...opts };
    this.busy = false; this.timer = null; this.lastFetch = new Map(); this.lastMaintain = new Map();
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(e => this.log('worker', e.message)), this.opts.tickMs); this.timer.unref?.(); } return this; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  hasModel() { return this.fns.distill || this.fns.distillPr ? true : !!provider(); }
  spentToday() { let total = 0; for (const r of this.repos.list()) { try { total += spentToday(r.store()); } catch {} } return total; }
  afford() { return this.spentToday() < this.opts.dailyCap; }

  // Fetch the checkout when it is time; clone it the first time. False when there is none to anchor to.
  async ensureCheckout(repo, { force = false, ref } = {}) {
    const last = this.lastFetch.get(repo.id) || 0;
    if (!force && !ref && repo.isCloned() && Date.now() - last < this.opts.fetchEveryMs) return true;
    const r = await repo.sync({ token: this.gitToken, ref });
    this.lastFetch.set(repo.id, Date.now());
    if (!r.ok) this.log(repo.id, `checkout: ${r.error}`);
    return r.ok && repo.isCloned();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const repo of this.repos.list()) {
        await this.distillSessions(repo);
        await this.distillPrs(repo);
        await this.maintainRepo(repo);
      }
    } finally { this.busy = false; }
  }

  // Sessions that ended, or went quiet, and have events the distiller has not seen.
  pendingSessions(repo) {
    const out = [];
    for (const s of repo.sessions()) {
      const m = repo.sessionMeta(s);
      if ((m.events || 0) <= (m.distilled || 0)) continue;
      if (!m.ended && Date.now() - Date.parse(m.lastAt || 0) < this.opts.idleMs) continue;
      out.push(s);
    }
    return out;
  }
  async distillSessions(repo) {
    const pending = this.pendingSessions(repo);
    if (!pending.length) return;
    if (!this.hasModel()) return;
    for (const session of pending) {
      if (!this.afford()) { this.log(repo.id, 'daily cap reached'); return; }
      if (!await this.ensureCheckout(repo)) return;
      await repo.locked(() => this.distillSession(repo, session)).catch(e => this.log(repo.id, `session ${session}: ${e.message}`));
    }
  }
  async distillSession(repo, session) {
    const store = repo.store();
    const meta = repo.sessionMeta(session);
    const all = repo.sessionEvents(session);
    const from = meta.distilled || 0;
    const events = all.slice(from).filter(e => ['prompt', 'say', 'tool'].includes(e.t)).slice(-this.opts.maxSessionEvents);
    const servedIds = new Set(all.slice(from).filter(e => e.t === 'served').flatMap(e => e.ids || []));
    const done = () => repo.saveSessionMeta(session, { distilled: all.length, distilledAt: new Date().toISOString() });
    if (exploreCount(events) < this.opts.minExplore || !events.some(e => e.t === 'say')) { done(); return { skipped: true }; }
    const assessed = new Set(meta.assessed || []);
    const served = [...servedIds].filter(id => !assessed.has(id)).map(id => store.get(id)).filter(n => n && n.status !== 'invalid');
    const distill = this.fns.distill || distillEvents;
    const r = await distill(events, { model: store.config().distillModel || 'sonnet', repoHint: repo.id, served, accounting: { store, purpose: 'distill', phase: 'learning', session, traceEvents: events.length } });
    const { result } = repo.withJournal(s => {
      const saved = saveNotes(s, r.notes || [], { source: { type: 'agent', ref: session, via: meta.client || meta.by || 'sync' } });
      const applied = attest(s, r.assessments || [], { session });
      return { saved, applied };
    }, meta.by || 'session');
    repo.saveSessionMeta(session, { distilled: all.length, distilledAt: new Date().toISOString(), assessed: [...new Set([...assessed, ...served.map(n => n.id)])] });
    store.log({ op: 'distill', session, explore: exploreCount(events), saved: result.saved.saved.map(n => n.id), merged: result.saved.merged.map(n => n.id), skipped: result.saved.skipped, cost: r.cost, metered: true, phase: 'learning', server: true });
    this.log(repo.id, `session ${session}: ${result.saved.saved.length} new, ${result.saved.merged.length} merged, ${result.applied.length} assessed`);
    return result;
  }

  async distillPrs(repo) {
    const pending = repo.pendingPrs();
    if (!pending.length || !this.hasModel()) return;
    for (const pr of pending) {
      if (!this.afford()) { this.log(repo.id, 'daily cap reached'); return; }
      // anchor to the merge commit when the checkout has it, else to the default branch as fetched now
      if (!await this.ensureCheckout(repo, { force: true })) return;
      if (pr.mergeCommit) { try { repo.git(['checkout', '--quiet', '--force', '--detach', pr.mergeCommit]); } catch { /* not fetched: the default branch will do */ } }
      await repo.locked(() => this.distillOnePr(repo, pr)).catch(e => { this.log(repo.id, `PR #${pr.number}: ${e.message}`); repo.finishPr(pr.number, { error: String(e.message).slice(0, 300) }); });
    }
  }
  async distillOnePr(repo, pr) {
    const store = repo.store();
    const slug = repo.id.replace(/^github\.com\//, '');
    const distill = this.fns.distillPr || distillPr;
    const r = await distill(slug, { number: pr.number, prNumber: pr.number, title: pr.title, body: pr.body, mergedAt: pr.mergedAt, additions: pr.additions, files: pr.files, diff: pr.diff, comments: pr.comments }, { model: store.config().distillModel || 'sonnet', repo: repo.checkout, accounting: { store, purpose: 'mine-prs', phase: 'learning', pr: pr.number } });
    const { result } = repo.withJournal(s => saveNotes(s, r.notes || [], { source: { type: 'pr', ref: `${slug}#${pr.number}` } }), pr.by || 'ci');
    recordMinedPrs(store, slug, [{ number: pr.number, prNumber: pr.number, mergedAt: pr.mergedAt }]);
    repo.finishPr(pr.number, { notes: [...result.saved, ...result.merged].map(n => n.id), skipped: result.skipped.length, cost: r.cost });
    store.log({ op: 'mine-prs', slug, prs: 1, saved: result.saved.length + result.merged.length, cost: r.cost, metered: true, source: 'ci', server: true });
    this.log(repo.id, `PR #${pr.number}: ${result.saved.length} new, ${result.merged.length} merged`);
    return result;
  }

  // The ordinary maintenance run, against the checkout at its fetched head, journaled.
  async maintainRepo(repo) {
    if (!repo.isCloned()) return;
    const last = this.lastMaintain.get(repo.id) || 0;
    if (Date.now() - last < this.opts.maintainEveryMs) return;
    this.lastMaintain.set(repo.id, Date.now());
    if (!await this.ensureCheckout(repo)) return;
    await repo.locked(async () => {
      const fns = { spentToday: () => this.spentToday(), ...(this.fns.maintain || {}) };
      // pull requests reach the server from CI, not from maintenance
      const { result: r } = await repo.withJournalAsync(store => maintain(store, repo.checkout, { fns: { ...fns, minePrs: undefined } }), 'maintenance');
      if (r && !r.skipped && (r.verified || r.phrased || r.cochange)) this.log(repo.id, `maintained: ${r.verified} re-verified, ${r.phrased} phrased${r.cochange ? ', co-change refreshed' : ''}`);
    }).catch(e => this.log(repo.id, `maintain: ${e.message}`));
  }
}

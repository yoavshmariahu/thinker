// What the server does on its own: keep each repository's checkout fetched when it is asked for.
// Learning is not done here: sessions are distilled on the checkouts that ran them, through the
// agents' own logins, and merged pull requests are mined by their maintenance; what they produce
// reaches the server as notes. The server made one model call of its own, the pull request review,
// until 2026-10-11; reviews are the user's coding agent's work now, with the cache alongside.
import { spentToday } from '../maintain.js';

export const DEFAULTS = {
  fetchEveryMs: 10 * 60_000,  // how often a checkout is fetched when asked for
  dailyTokens: Number(process.env.THINKER_SERVER_DAILY_TOKENS) || 2_000_000, // tokens of reported model usage a day, all repositories
  tickMs: 20_000,
};

export class Worker {
  constructor(repos, { log = () => {}, gitToken = process.env.THINKER_SERVER_GIT_TOKEN, fns = {}, ...opts } = {}) {
    this.repos = repos; this.log = log; this.gitToken = gitToken; this.fns = fns;
    this.opts = { ...DEFAULTS, ...opts };
    this.busy = false; this.timer = null; this.lastFetch = new Map();
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(e => this.log('worker', e.message)), this.opts.tickMs); this.timer.unref?.(); } return this; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  spentToday() { let total = 0; for (const r of this.repos.list()) { try { total += spentToday(r.store()); } catch {} } return total; }
  afford() { return this.spentToday() < this.opts.dailyTokens; }

  // Fetch the checkout when it is time; clone it the first time. False when there is none to anchor to.
  async ensureCheckout(repo, { force = false, ref } = {}) {
    const last = this.lastFetch.get(repo.id) || 0;
    if (!force && !ref && repo.isCloned() && Date.now() - last < this.opts.fetchEveryMs) return true;
    const r = await repo.sync({ token: this.gitToken, ref });
    this.lastFetch.set(repo.id, Date.now());
    if (!r.ok) this.log(repo.id, `checkout: ${r.error}`);
    return r.ok && repo.isCloned();
  }

  // Refresh the checkouts that were fetched before, on the fetch interval; nothing else runs here.
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const repo of this.repos.list()) if (repo.isCloned() && this.lastFetch.has(repo.id)) await this.ensureCheckout(repo);
    } finally { this.busy = false; }
  }
}

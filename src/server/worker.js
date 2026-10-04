// What the server does on its own, one job at a time: review the open pull requests CI asked
// about and post the review on them, and keep each repository's checkout fetched so a review has
// the code. Learning is not done here: sessions are distilled on the checkouts that ran them,
// through the agents' own logins, and merged pull requests are mined by their maintenance; what
// they produce reaches the server as notes. The one model call the server makes is the review,
// through llm.js like everywhere else: ANTHROPIC_API_KEY when set, else an installed agent CLI
// with its own login. Reported tokens are summed from the repositories' logs and a day stops at the cap.
import { spentToday } from '../maintain.js';
import { provider } from '../llm.js';
import { review, resolveScope } from '../review.js';
import { buildReview, publish } from '../review-post.js';

export const DEFAULTS = {
  fetchEveryMs: 10 * 60_000,  // how often a checkout is fetched when asked for
  dailyTokens: Number(process.env.THINKER_SERVER_DAILY_TOKENS) || 2_000_000, // tokens of reported model usage a day, all repositories
  tickMs: 20_000,
};

export class Worker {
  constructor(repos, { log = () => {}, gitToken = process.env.THINKER_SERVER_GIT_TOKEN, githubToken = process.env.THINKER_SERVER_GITHUB_TOKEN || process.env.THINKER_SERVER_GIT_TOKEN, githubApi = process.env.THINKER_SERVER_GITHUB_API, fns = {}, ...opts } = {}) {
    this.repos = repos; this.log = log; this.gitToken = gitToken; this.fns = fns;
    // the token that posts reviews (pull requests: write); the git token when it is one and the same
    this.githubToken = githubToken || null; this.githubApi = githubApi ? String(githubApi).replace(/\/+$/, '') : null;
    this.opts = { ...DEFAULTS, ...opts };
    this.busy = false; this.timer = null; this.lastFetch = new Map();
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(e => this.log('worker', e.message)), this.opts.tickMs); this.timer.unref?.(); } return this; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  hasModel() { return this.fns.review ? true : !!provider(); }
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

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const repo of this.repos.list()) await this.reviewPrs(repo);
    } finally { this.busy = false; }
  }

  // Open pull requests CI asked the server to review: the head is fetched into the clone, the change
  // since the merge base is reviewed against the notes of the clone (the default branch's), and the
  // review is posted on the pull request with the server's GitHub token. The clone's working tree is
  // not touched: a commit scope reads both sides through git.
  async reviewPrs(repo) {
    const pending = repo.pendingReviews();
    if (!pending.length || !this.hasModel()) return;
    for (const rv of pending) {
      if (!this.afford()) { this.log(repo.id, 'daily cap reached'); return; }
      if (!await this.ensureCheckout(repo, { force: true })) { repo.finishReview(rv.number, { status: 'failed', error: 'the server has no checkout of the repository' }); continue; }
      await repo.locked(() => this.reviewOne(repo, rv)).catch(e => { this.log(repo.id, `review #${rv.number}: ${e.message}`); repo.finishReview(rv.number, { status: 'failed', error: String(e.message).slice(0, 300) }); });
    }
  }
  async reviewOne(repo, rv) {
    const store = repo.store();
    repo.saveReview(rv.number, { status: 'running', startedAt: new Date().toISOString() });
    const head = await repo.fetchPrHead(rv, this.gitToken);
    const base = rv.baseSha && repo.hasCommit(rv.baseSha) ? rv.baseSha : `origin/${rv.baseRef}`;
    const scope = resolveScope(repo.checkout, { ref: head, base });
    const run = this.fns.review || review;
    const report = await run(store, { scope, pr: rv.number, kinds: rv.kinds && rv.kinds.length ? rv.kinds : undefined, max: rv.max || 12, model: store.config().reviewModel });
    const built = buildReview(report, { failOn: rv.failOn || 'error', quiet: rv.quiet !== false });
    const slug = repo.id.replace(/^github\.com\//, '');
    let posted = { posted: false, dismissed: [] };
    if (this.githubToken) posted = await publish({ review: built, slug, number: rv.number, sha: head, token: this.githubToken, api: this.githubApi || rv.apiUrl || 'https://api.github.com', fetch: this.fns.github || globalThis.fetch, log: m => this.log(repo.id, m) });
    else this.log(repo.id, `review #${rv.number}: no GitHub token (THINKER_SERVER_GITHUB_TOKEN); the review was not posted`);
    const rec = repo.finishReview(rv.number, { status: 'done', impact: report.impact, headSha: head, base: scope.base, counts: report.counts || { error: 0, warning: 0, info: 0 }, behaviors: (report.behaviors || []).map(b => ({ id: b.id, title: b.title, mutability: b.mutability, outcome: b.outcome })), findings: (report.findings || []).length, event: built.event, fail: built.fail, summary: built.summary, body: built.body, wouldPost: built.post, posted: posted.posted, postStatus: posted.status, dismissed: posted.dismissed.length, cost: report.cost || 0, tokens: report.tokens || 0, model: report.model, errors: report.errors || [] });
    this.log(repo.id, `review #${rv.number} at ${head.slice(0, 8)}: ${built.summary}${posted.posted ? `; posted ${built.event}` : built.post ? '; not posted' : ''}`);
    return rec;
  }
}

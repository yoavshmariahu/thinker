// Background maintenance of the cache: what a user would otherwise have to remember to
// run. It re-verifies stale notes, writes phrasings for notes that lack them, refreshes
// the co-change index when HEAD moved, and distills pull requests merged since it first
// ran. It starts from the catch-up learning run (at most every ten minutes, from the
// prompt hooks) and from the git post-commit hook, and is bounded by a daily spend cap
// so it can run unattended. The daily cap counts reported model cost of learning and
// maintenance in the machine's log; unknown costs count as zero.
import fs from 'node:fs';
import path from 'node:path';
import { gitHead } from './store.js';
import { refresh, verifyNote, phraseNotes, phraseKey } from './ops.js';
import { mineCochange, loadCochange } from './cochange.js';
import { cbmProject, cbmIndex } from './cbm.js';
import { readLog } from './usage.js';
import { reconcileLocal, readyToShareNotice } from './share.js';

export const DEFAULTS = {
  enabled: true,    // `maintain: { enabled: false }` in .thinker/config.json switches it off
  dailyCap: 1.0,    // USD of reported model cost per day, learning and maintenance together
  verifyPerRun: 10, // stale notes re-verified per run, most recently served first
  phrasePerRun: 8,  // notes given phrasings per run (one model call)
  prs: true,        // distill pull requests merged since maintenance first ran here
  prsPerRun: 3,
};
const LOCK_MS = 15 * 60_000;

export function maintainConfig(store) {
  const c = store.config().maintain;
  return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
}

// Reported cost of learning and maintenance model calls since local midnight.
export function spentToday(store, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const since = start.toISOString();
  let total = 0;
  for (const e of readLog(store)) {
    if (e.t >= since && e.op === 'model' && ['learning', 'maintenance'].includes(e.phase) && typeof e.cost === 'number') total += e.cost;
  }
  return total;
}

function stateFile(store) { return path.join(store.dir, 'state', 'maintain.json'); }
function readState(store) { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return {}; } }

// One run. `fns` lets the CLI pass PR mining in and tests pass everything in.
export async function maintain(store, repo, { dry = false, fns = {} } = {}) {
  const cfg = maintainConfig(store);
  if (!cfg.enabled || /^(1|true|yes)$/i.test(process.env.THINKER_NO_LEARN || '')) return { skipped: 'disabled' };
  const stateDir = path.join(store.init().dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'maintain.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' }; } catch {}
  if (!dry) fs.writeFileSync(lock, String(process.pid));
  const state = readState(store);
  const r = { verified: 0, updated: 0, retired: 0, phrased: 0, prs: 0, cochange: false, graph: false, sync: null, cost: 0, capped: false, errors: 0 };
  const spent = (fns.spentToday || spentToday)(store);
  const budget = cfg.dailyCap - spent;
  const afford = () => budget - r.cost > 0;
  try {
    if (!dry) reconcileLocal(store);
    // 0. the team's central cache, when this checkout syncs with one (sync.js): free, network only
    if (fns.sync) { try { r.sync = await fns.sync(); } catch { r.errors++; } }
    // 1. co-change: free, so redo it whenever HEAD moved
    const head = gitHead(repo);
    const idx = loadCochange(repo);
    if (head && (!idx || idx.head !== head)) {
      try { if (!dry) (fns.cochange || mineCochange)(repo); r.cochange = true; } catch { r.errors++; }
    }
    // 1b. the code graph (cbm.js), when this checkout has one: free too, re-indexed when HEAD moved
    if (head && state.graphHead !== head && (fns.graphIndexed || cbmProject)(repo)) {
      try { const g = dry ? {} : (fns.graphIndex || cbmIndex)(repo); if (!g.error) { r.graph = true; state.graphHead = head; } else r.errors++; } catch { r.errors++; }
    }
    // 2. Re-hashing is free, even when the model budget is exhausted.
    const notes = (fns.refresh || refresh)(store, store.list());
    if (afford()) {
      const stale = notes
        .filter(n => n.status === 'stale' && !(n.verifying && Date.now() - Date.parse(n.verifying) < 10 * 60_000))
        .sort((a, b) => (b.uses || 0) - (a.uses || 0))
        .slice(0, cfg.verifyPerRun);
      for (const n of stale) {
        if (!afford()) { r.capped = true; break; }
        if (dry) { r.verified++; continue; }
        try {
          const v = await (fns.verify || verifyNote)(store, n, {});
          r.cost += v.cost || 0; r.verified++;
          if (v.verdict === 'update') r.updated++;
          if (v.verdict === 'invalid') r.retired++;
        } catch { r.errors++; }
      }
    } else r.capped = true;
    // 3. phrasings for notes that have none for their present text
    if (afford()) {
      const need = store.list().filter(n => n.status !== 'invalid' && (!n.says?.length || n.saysFor !== phraseKey(n))).slice(0, cfg.phrasePerRun);
      if (need.length) {
        if (dry) r.phrased = need.length;
        else { try { const p = await (fns.phrase || phraseNotes)(store, need, { phase: 'maintenance' }); r.phrased = p.done.length; r.cost += p.cost || 0; } catch { r.errors++; } }
      }
    } else r.capped = true;
    // 4. pull requests merged since maintenance first ran here; further back is `thinker mine-prs`
    if (cfg.prs && fns.minePrs) {
      if (!state.prsAfter) state.prsAfter = new Date().toISOString();
      else if (afford()) {
        if (!dry) { try { const m = await fns.minePrs({ after: state.prsAfter, limit: cfg.prsPerRun }); r.prs = m?.saved || 0; r.cost += m?.cost || 0; } catch { r.errors++; } }
      } else r.capped = true;
    }
    const u = state.unreported || {};
    if (!dry) { const notice = readyToShareNotice(store); if (notice) u.share = notice; }
    for (const k of ['verified', 'updated', 'retired', 'phrased', 'prs']) u[k] = (u[k] || 0) + r[k];
    if (r.sync && !r.sync.skipped) { u.pulled = (u.pulled || 0) + (r.sync.pulled || 0) + (r.sync.deleted || 0); u.pushed = (u.pushed || 0) + (r.sync.pushed || 0) + (r.sync.retired || 0); }
    u.cochange = !!(u.cochange || r.cochange);
    u.graph = !!(u.graph || r.graph);
    state.unreported = u; state.at = new Date().toISOString(); state.last = r;
    if (!dry) fs.writeFileSync(stateFile(store), JSON.stringify(state));
    store.log({ op: 'maintain', ...r, spentBefore: spent, cap: cfg.dailyCap, dry });
    return r;
  } finally { if (!dry) fs.rmSync(lock, { force: true }); }
}

// One line for the user about what maintenance did since they last saw it; then cleared.
export function maintenanceNotice(store) {
  const state = readState(store);
  const u = state.unreported;
  if (!u) return '';
  const parts = [];
  if (u.verified) {
    const detail = [u.updated ? `${u.updated} updated` : '', u.retired ? `${u.retired} retired` : ''].filter(Boolean).join(', ');
    parts.push(`${u.verified} stale ${u.verified === 1 ? 'note' : 'notes'} re-verified${detail ? ` (${detail})` : ''}`);
  }
  if (u.phrased) parts.push(`${u.phrased} ${u.phrased === 1 ? 'note' : 'notes'} phrased`);
  if (u.prs) parts.push(`${u.prs} ${u.prs === 1 ? 'note' : 'notes'} from merged pull requests`);
  if (u.cochange) parts.push('co-change index refreshed');
  if (u.graph) parts.push('code graph re-indexed');
  if (u.pulled || u.pushed) parts.push(`team cache: ${[u.pulled ? `${u.pulled} ${u.pulled === 1 ? 'note' : 'notes'} pulled` : '', u.pushed ? `${u.pushed} pushed` : ''].filter(Boolean).join(', ')}`);
  if (u.share) parts.push(u.share);
  if (!parts.length) return '';
  delete state.unreported;
  try { fs.writeFileSync(stateFile(store), JSON.stringify(state)); } catch {}
  return `🧠 thinker: in the background, ${parts.join('; ')}`;
}

// After a commit: re-hash in the background; with learning on, one maintenance run instead.
// Worktrees share the main repository's hooks, so the checkout is the one being committed
// in, not the one the hook was installed from.
export function postCommitHook(cli, repo, learn) {
  const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh\n# thinker: re-hash note dependencies${learn ? ' and maintain the cache' : ''} in the background\n` +
    `case "$THINKER_NO_LEARN" in 1|true|yes) exit 0 ;; esac\n` +
    `repo="$(git rev-parse --show-toplevel 2>/dev/null)"\n` +
    `[ -n "$repo" ] || repo=${quote(repo)}\n` +
    `nohup node ${quote(cli)} ${learn ? 'maintain' : 'check'} --quiet --repo "$repo" >/dev/null 2>&1 &\n`;
}

export function renderMaintain(r) {
  if (r.skipped) return `maintenance skipped (${r.skipped})`;
  const bits = [`${r.verified} re-verified`];
  if (r.updated) bits.push(`${r.updated} updated`);
  if (r.retired) bits.push(`${r.retired} retired`);
  bits.push(`${r.phrased} phrased`, `${r.prs} from pull requests`, `co-change ${r.cochange ? 'refreshed' : 'unchanged'}`);
  if (r.graph) bits.push('code graph re-indexed');
  if (r.sync && !r.sync.skipped) bits.push(`team cache ${r.sync.pulled + (r.sync.deleted || 0)}↓ ${r.sync.pushed + (r.sync.retired || 0)}↑`);
  return `maintained: ${bits.join(', ')}${r.cost ? ` ($${r.cost.toFixed(3)})` : ''}${r.capped ? '; daily cap reached' : ''}${r.errors ? `; ${r.errors} failed` : ''}`;
}

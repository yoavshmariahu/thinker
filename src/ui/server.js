// `thinker ui`: a local page for the person, on this machine only. Two views: Save, where the agents' context goes in
// a repository and what each part is worth, with the cuts (context-view.js, as `thinker context`), and Report, what a
// session costs here week by week, by part of the context and by model, in tokens or at list prices, with the
// decisions taken on Save and the cache's numbers under it (report.js, as `thinker report`). The Cache view (the
// usage cards, the repositories, the notes and the behaviors) was replaced by Report on 2026-10-22, at the owner's
// decision; the notes and behaviors are the CLI's (`thinker list`, `show`, `archive`, `system`).
//
// The page is machine-wide: it needs no repository, and a repository is named by its id (as the log
// names it) so the page cannot be pointed at a path.
//
// It listens on 127.0.0.1 alone. The Host header must name this server (a DNS rebinding names another),
// and an API call that a browser marks as coming from another site (its Origin header, or
// Sec-Fetch-Site: cross-site) is refused, so another page in the browser can neither read the report nor
// change a setting. Until 2026-10-22 every call also carried a key minted for the run, in the page's
// address; the owner dropped it: a copied address without it was a broken page, and the two checks above
// keep the same pages out.
import { harnessView, harnessSavings, harnessOn, scheduleHarnessSuggestion, undoHarness, switchOffNow, setHarnessSettings } from '../harness.js';
import { contextView, mergeViews, switchSources, setOutputCompression } from '../context-view.js';
import { snapshotView, lastSnapshot, refreshing, dropSnapshots, REFRESH_MS } from '../context-snapshot.js';
import { approveChanges, dismissChanges, applyReviewed, revertDecision, pickChanges, currentChanges, allChanges, changeHistory } from '../context-suggest.js';
import { reportView, mergeReports, REPORT_WEEKS } from '../report.js';
import { judgeRecent } from '../instruction-value.js';
import { setCore } from '../instructions-core.js';
import { previewEdit, applyEdit } from '../instruction-edit.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, repoId, isGitCheckout } from '../store.js';
import { discoverRepos, displayName } from '../machine.js';
import { thinkerHome } from '../update.js';
import { isDisabledRepo } from '../repo-switch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4848;

// The repositories with a cache on this machine: this one, and every checkout the agents' transcripts
// or the machine's log name that has a .thinker folder. A repository with several checkouts (clones,
// worktrees) is read from the one holding the most notes, this one when they tie. `checkouts`: the ones
// found before (keptCheckouts), instead of looking again.
export function machineRepos(store, { home, checkouts } = {}) {
  const here = isGitCheckout(store.repo) && store.exists() ? store.repo : null;
  const byOrigin = new Map();
  const add = c => { const o = repoId(c); if (!byOrigin.has(o)) byOrigin.set(o, new Set()); byOrigin.get(o).add(c); };
  if (here) add(here);
  for (const c of checkouts || discoverCheckouts(store, { home })) if (fs.existsSync(path.join(c, '.thinker'))) add(c);
  const count = c => { try { return new Store(c, { readonly: true }).list().length; } catch { return -1; } };
  const out = [];
  for (const [id, checkouts] of byOrigin) {
    const scored = [...checkouts].map(c => [c, count(c)]).filter(([, n]) => n >= 0).sort((a, b) => b[1] - a[1] || (b[0] === here) - (a[0] === here));
    if (!scored.length) continue;
    const checkout = scored[0][0];
    out.push({ id, name: displayName(id, checkout), checkout, current: checkout === here, disabled: isDisabledRepo(checkout) });
  }
  return out.sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
}

// Finding the checkouts reads every agent's project folders and the machine's log: two to four seconds on this
// machine (6,000 Claude Code project folders, most of them benchmark runs), before the page shows anything. So
// they are kept under thinker's home (state/machine-checkouts.json) and the page reads them, starting `thinker ui
// --refresh` in the background when they are older than REPOS_REFRESH_MS; which checkout stands for a repository,
// and whether it is this one, is worked out live from them.
export const REPOS_REFRESH_MS = 10 * 60_000;
const checkoutsFile = home => path.join(home, 'state', 'machine-checkouts.json');
export function discoverCheckouts(store, { home } = {}) {
  let found = []; try { found = discoverRepos(store, { home }); } catch {}
  return found.flatMap(r => r.checkouts).filter(c => fs.existsSync(path.join(c, '.thinker')));
}
// `transcriptsHome`: where the agents' transcripts were read (tests name one); a list read elsewhere is not used
export function keptCheckouts({ home = thinkerHome(), transcriptsHome } = {}) {
  try { const s = JSON.parse(fs.readFileSync(checkoutsFile(home), 'utf8')); return s.transcripts === (transcriptsHome || null) && Array.isArray(s.checkouts) ? s : null; } catch { return null; }
}
export function refreshCheckouts(store, { home = thinkerHome(), transcriptsHome, now = Date.now() } = {}) {
  const checkouts = discoverCheckouts(store, { home: transcriptsHome }), f = checkoutsFile(home), tmp = `${f}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ at: now, transcripts: transcriptsHome || null, checkouts })); fs.renameSync(tmp, f); }
  catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return checkouts;
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

export function createUiServer(store, { home = thinkerHome(), transcriptsHome, cliPath = path.join(HERE, '..', 'cli.js'), refreshFn, refreshReposFn } = {}) {
  refreshReposFn ||= () => { try { const p = spawn(process.execPath, [cliPath, 'ui', '--refresh'], { cwd: store.repo, stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch {} };
  // an old Context report is made again by `thinker context --refresh` in the checkout, in the background
  refreshFn ||= checkout => { try { const p = spawn(process.execPath, [cliPath, 'context', '--refresh', '--quiet', '--repo', checkout], { cwd: checkout, stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch {} };
  const page = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
  let port = 0, known = null, lastRequest = Date.now();
  // the checkouts found before, looked for again in the background when old (once a while per process)
  let refreshedAt = 0;
  const listRepos = () => {
    const kept = keptCheckouts({ home, transcriptsHome });
    if (!kept) return machineRepos(store, { home: transcriptsHome, checkouts: refreshCheckouts(store, { home, transcriptsHome }) });
    if (Date.now() - kept.at > REPOS_REFRESH_MS && Date.now() - refreshedAt > REPOS_REFRESH_MS) { refreshedAt = Date.now(); refreshReposFn(); }
    return machineRepos(store, { home: transcriptsHome, checkouts: kept.checkouts });
  };
  const repos = () => known ||= listRepos();
  const opened = new Map();
  const open = checkout => { if (!opened.has(checkout)) opened.set(checkout, new Store(checkout)); return opened.get(checkout); };
  // '' is this repository (when it is one); an id must be one machineRepos listed
  const entry = id => !id ? repos().find(r => r.current) : repos().find(r => r.id === id);
  const storeFor = id => { const r = id === 'all' ? null : entry(id); return r ? open(r.checkout) : null; };
  const storesFor = id => {
    if (id === 'all') return repos().flatMap(r => { try { return [[r, open(r.checkout)]]; } catch { return []; } });
    const r = entry(id); return r ? [[r, open(r.checkout)]] : null;
  };
  const harnessCache = new Map(), reportCache = new Map();
  const changesView = (st, d) => {
    const s = lastSnapshot(st, d);
    if (!s) return snapshotView(st, d).view;
    if ((!s.current || Date.now() - s.at > REFRESH_MS) && !refreshing(st)) refreshFn(st.repo);
    return s.view;
  };
  const server = http.createServer(async (req, res) => {
    lastRequest = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'wrong host' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      return res.end(page);
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // a browser names where a request came from: another site is refused; the page itself (same origin) and a
    // process on this machine (no Origin) are answered
    const origin = String(req.headers.origin || ''), site = String(req.headers['sec-fetch-site'] || '');
    if ((origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) || site === 'cross-site') return json(res, 403, { error: 'wrong origin' });
    try {
      // which repository: '' (this one), 'all', or one of machineRepos by id
      const want = String(url.searchParams.get('repo') || '');
      if (req.method === 'GET' && url.pathname === '/api/repos') { known = listRepos(); return json(res, 200, { repos: known }); }
      // the Report tab (report.js:reportView, as `thinker report`): one repository, or every repository's report merged
      if (req.method === 'GET' && url.pathname === '/api/report') {
        const weeks = Math.max(1, Math.min(26, Number(url.searchParams.get('weeks')) || REPORT_WEEKS)), k = `report:${want}:${weeks}`, hit = reportCache.get(k);
        if (hit && Date.now() - hit.at < 60_000) return json(res, 200, hit.view);
        let view;
        if (want === 'all') view = mergeReports(repos().flatMap(r => { try { return [{ repo: r.id, name: r.name, view: reportView(open(r.checkout), { weeks }) }]; } catch { return []; } })) || mergeReports([]);
        else { const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' }); view = reportView(one, { weeks }); }
        if (!view) return json(res, 200, { empty: true });
        reportCache.set(k, { at: Date.now(), view });
        return json(res, 200, view);
      }
      // what Claude Code loads into every session here and what switching it off saved (harness.js:harnessView, as `thinker harness`)
      if (req.method === 'GET' && url.pathname === '/api/harness') {
        if (want === 'all') return json(res, 200, { repos: repos().flatMap(r => { try { const st = open(r.checkout); if (!harnessOn(st)) return []; const sv = harnessSavings(st); return sv.sources.length ? [{ repo: r.id, repoName: r.name, saved: sv }] : []; } catch { return []; } }) });
        const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' });
        // it reads every transcript of the window (seconds on a busy repository): kept a minute, dropped on an action
        const k = `${one.repo}:${Number(url.searchParams.get('days')) || 30}`, hit = harnessCache.get(k);
        if (hit && Date.now() - hit.at < 60_000) return json(res, 200, hit.view);
        const view = harnessView(one, { days: Number(url.searchParams.get('days')) || 30 });
        harnessCache.set(k, { at: Date.now(), view });
        return json(res, 200, view);
      }
      // where the context goes in one repository (context-view.js:contextView, as `thinker context`), from the report
      // kept in the checkout (context-snapshot.js): made now only when there is none, made again in the background
      // when it is old, the page told when it was made and whether a newer one is coming
      if (req.method === 'GET' && url.pathname === '/api/context') {
        const d = Number(url.searchParams.get('days')) || 30;
        const read = st => { const s = snapshotView(st, d); if (s.stale && !refreshing(st)) refreshFn(st.repo); return { ...s, refreshing: s.stale || refreshing(st) }; };
        let view, at, busy;
        // every repository on the machine, merged (context-view.js:mergeViews); a repository that fails to read is left out
        if (want === 'all') {
          const xs = repos().flatMap(r => { try { return [{ r, s: read(open(r.checkout)) }]; } catch { return []; } });
          view = mergeViews(xs.map(({ r, s }) => ({ repo: r.id, name: r.name, view: s.view })));
          at = Math.min(...xs.map(x => x.s.at)); busy = xs.some(x => x.s.refreshing);
        } else {
          const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' });
          ({ view, at, refreshing: busy } = read(one));
        }
        return json(res, 200, { ...view, asOf: Number.isFinite(at) ? at : Date.now(), refreshing: !!busy });
      }
      // Context's History (context-suggest.js): the decisions so far, for one repository or each of them, and the top changes of the
      // kept report less the ones decided lately (what the session's summary names; the page's All lists every part from /api/context)
      if (req.method === 'GET' && url.pathname === '/api/changes') {
        // the last report kept, made again in the background when it no longer holds or is old; made now only when
        // there is none (context-snapshot.js:lastSnapshot)
        const d = Number(url.searchParams.get('days')) || 7;
        const stores = storesFor(want); if (!stores) return json(res, 400, { error: 'unknown repository' });
        const xs = stores.flatMap(([r, st]) => { try { const v = changesView(st, d); return [{ r, changes: currentChanges(st, v).map(c => ({ ...c, repo: r.id, repoName: r.name })), history: changeHistory(st).map(h => ({ ...h, repo: r.id, repoName: r.name })) }]; } catch { return []; } });
        return json(res, 200, { days: d, changes: xs.flatMap(x => x.changes).sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, want === 'all' ? 10 : 5), history: xs.flatMap(x => x.history).sort((a, b) => b.at.localeCompare(a.at)) });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const b = await readBody(req);
      const st = storeFor(String(b.repo || ''));
      if (!st) return json(res, 400, { error: 'unknown repository' });
      let r;
      if (url.pathname.startsWith('/api/harness/') || url.pathname.startsWith('/api/context/')) { harnessCache.clear(); dropSnapshots(st); }
      reportCache.clear();
      // a decision on a row or in History keeps the report: the files it writes (config, settings, AGENTS.md) make the Context
      // tab read a new one (context-snapshot.js)
      if (url.pathname.startsWith('/api/changes/')) harnessCache.clear();
      // the page's door to `thinker harness --suggest` and `--undo`: the same functions, for the repository it shows
      if (url.pathname === '/api/harness/suggest') { const picks = scheduleHarnessSuggestion(st, { force: true }); r = picks?.length ? { queued: picks.length } : { error: 'nothing here is worth switching off' }; }
      else if (url.pathname === '/api/harness/undo') r = { said: undoHarness(st, { names: Array.isArray(b.names) ? b.names : null }) };
      else if (url.pathname === '/api/harness/off') r = Array.isArray(b.labels) && b.labels.length ? { said: switchOffNow(st, b.labels.join(','), { via: 'ui', any: true }) } : { error: 'nothing chosen' };
      // `thinker instructions --core "<Title>, …"` (a list) and `--off` (null)
      else if (url.pathname === '/api/context/core') { const keep = Array.isArray(b.keep) ? b.keep.map(String).filter(Boolean) : null; const c = setCore(st, keep?.length ? keep : null); r = c.state === 'theirs' ? { error: 'AGENTS.override.md here is not thinker\'s; nothing written' } : { said: keep?.length ? `Kept ${c.kept?.length ?? keep.length} sections for this checkout` : 'Agents here read the whole file again' }; }
      // `thinker instructions --remove|--compress <id>` (the diff) and `--apply` (written to the working tree)
      else if (url.pathname === '/api/context/edit') { const x = await previewEdit(st, Array.isArray(b.ids) ? b.ids : String(b.id || ''), b.action === 'compress' ? 'compress' : 'remove'); if (x.error) r = x; else return json(res, 200, { ok: true, preview: x }); }
      else if (url.pathname === '/api/context/apply') r = applyEdit(st, String(b.id || ''));
      // `thinker context --approve|--dismiss <keys>` over every part of the report (context-suggest.js:allChanges; the command
      // numbers the top five, currentChanges): a row's Apply makes the action picked in it (`acts`), Dismiss leaves it a month;
      // a section's reviewed diff is applied (`thinker instructions --compress <id> --apply`) and recorded with its undo
      // `thinker context --revert <n>`: a decision taken back (context-suggest.js:revertDecision)
      else if (url.pathname === '/api/changes/revert') { r = await revertDecision(st, String(b.id || '')); if (!r.error && !refreshing(st)) refreshFn(st.repo); }
      else if (['/api/changes/approve', '/api/changes/dismiss', '/api/changes/apply'].includes(url.pathname)) {
        const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).map(k => String(k || '')).filter(Boolean);
        const picked = pickChanges(allChanges(changesView(st, Number(b.days) || 7)), keys, b.acts && typeof b.acts === 'object' ? b.acts : {});
        if (!picked.length) r = { error: 'that part is no longer in the report; reload the page' };
        else if (url.pathname.endsWith('/approve')) r = { said: (await approveChanges(st, picked)).join(' ') };
        else if (url.pathname.endsWith('/dismiss')) r = { said: dismissChanges(st, picked).join(' ') };
        else r = await applyReviewed(st, picked, String(b.edit || ''), Array.isArray(b.files) ? b.files : []);
        if (!url.pathname.endsWith('/dismiss') && !refreshing(st)) refreshFn(st.repo);
      }
      // `thinker context --switch-off <labels> [--builtin]` / `--switch-on <keys>` and `--output-compression <tools> --level`
      else if (url.pathname === '/api/context/switch') r = { said: switchSources(st, { labels: Array.isArray(b.labels) ? b.labels : [], keys: Array.isArray(b.keys) ? b.keys : [], on: !!b.on, builtin: !!b.builtin }) };
      else if (url.pathname === '/api/context/compression') r = { said: setOutputCompression(st, Array.isArray(b.tools) ? b.tools : [], ['high', 'moderate'].includes(b.level) ? b.level : 'off') };
      // `thinker context --judge n`, in the background: model calls, through the person's agent or the desktop session
      else if (url.pathname === '/api/context/judge') { const n = Math.min(20, Math.max(1, Number(b.n) || 5)); judgeRecent(st, { n }).then(x => { harnessCache.clear(); dropSnapshots(st); st.log({ op: 'instruction-value', via: 'ui', judged: x.judged }); }).catch(e => st.log({ op: 'instruction-value', via: 'ui', failed: String(e.message || e).slice(0, 160) })); r = { said: `Judging ${n} sessions in the background` }; }
      else if (url.pathname === '/api/harness/settings') { const v = k => typeof b[k] === 'boolean' ? b[k] : undefined; r = { said: JSON.stringify(setHarnessSettings(st, { recurring: v('recurring') ?? v('weekly'), recall: v('recall'), suggestions: v('suggestions') })) }; }
      else return json(res, 404, { error: 'not found' });
      if (r?.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, id: r?.note?.id, draft: r?.draft, queued: r?.queued, said: r?.said });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e).split('\n')[0].slice(0, 300) });
    }
  });
  return {
    server,
    listen(want = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        const tryPort = p => {
          server.once('error', e => { if (e.code === 'EADDRINUSE' && p !== 0) tryPort(0); else reject(e); });
          server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve({ port, url: `http://127.0.0.1:${port}/` }); });
        };
        tryPort(want);
      });
    },
    // the browser keeps connections open; Ctrl+C must not wait for them
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }),
    idleMs: () => Date.now() - lastRequest,
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}

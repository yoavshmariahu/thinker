// `thinker ui`: a local page for the person, on this machine only. It opens on the chat, where the person asks thinker
// what it did and tells it how to behave (chat.js, as `thinker chat`), with what thinker did down its left side, a line
// an action with what it came to (upkeep.js, as `thinker activity`). Nothing on that side is a button: thinker does its
// work itself, and is told otherwise in the chat. Beside it: the Factory, the sessions as a pipeline (factory.js, as
// `thinker factory`), and Recent activity, every decision taken with what came of it and what still needs the person
// (context-suggest.js:changeHistory, as `thinker context --history`): a compression running in the background or
// failed, a pull request waiting to be merged, and the merged pull requests with what the clearing saved on each.
//
// Find Savings (where the context goes, part by part, with the cuts) and View Report (what a session costs week by
// week) were pages here until 2026-11-21, when the owner had them removed: thinker makes those decisions itself. Their
// figures are the commands' (`thinker context`, `thinker report`), and the routes that served them (/api/context,
// /api/explain, /api/changes/approve|dismiss|start, /api/context/switch|compression) went with them. /api/report
// stays: the Factory and Recent activity's pull requests read the kept report.
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
import { harnessView, harnessSavings, harnessOn, undoHarness, switchOffNow, setHarnessSettings } from '../harness.js';
import { refreshing, dropSnapshots } from '../context-snapshot.js';
import { retryJob, revertDecision, changeHistory, refreshPrStates } from '../context-suggest.js';
import { mergeReports, reportActions, withEffects, mergePromptAverages, REPORT_WEEKS } from '../report.js';
import { reportSnapshot, refreshing as reportRefreshing, historyEffects, promptAverageHere, keptRows } from '../report-snapshot.js';
import { uiScans, scanStatus } from './scans.js';
import { upkeepView, mergeUpkeepViews, delegatedTotalSaid, UPKEEP } from '../upkeep.js';
import { chatSend, chatView } from '../chat.js';
import { settingsView, setSetting } from '../settings.js';
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
// worktrees) is read from the one whose profile rests on the most observations, this one when they tie. `checkouts`: the ones
// found before (keptCheckouts), instead of looking again.
export function machineRepos(store, { home, checkouts } = {}) {
  const here = isGitCheckout(store.repo) && store.exists() ? store.repo : null;
  const byOrigin = new Map();
  const add = c => { const o = repoId(c); if (!byOrigin.has(o)) byOrigin.set(o, new Set()); byOrigin.get(o).add(c); };
  if (here) add(here);
  for (const c of checkouts || discoverCheckouts(store, { home })) if (fs.existsSync(path.join(c, '.thinker'))) add(c);
  const count = c => { try { return fs.existsSync(path.join(c, '.thinker')) ? (JSON.parse(fs.readFileSync(path.join(c, '.thinker', 'local', 'profile', 'profile.json'), 'utf8')).window?.observations || 0) : -1; } catch { return fs.existsSync(path.join(c, '.thinker')) ? 0 : -1; } };
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

// The background refreshes the page starts (the kept reports: `thinker report --refresh`, and `thinker context
// --refresh` after a decision is taken back) run one at a time, each asked for once while it waits: over a dozen repositories the
// page started a dozen node processes at once, each reading the machine's log and its transcripts, and the machine
// crawled while they ran. `start` spawns the process and returns it, or nothing to skip.
export function serialSpawner() {
  const queue = [], waiting = new Set(); let busy = false;
  const next = () => {
    if (busy || !queue.length) return;
    const { key, start } = queue.shift(); waiting.delete(key);
    let p = null; try { p = start(); } catch {}
    if (!p) return next();
    busy = true;
    const done = () => { if (!busy) return; busy = false; next(); };
    p.on('exit', done); p.on('error', done);
  };
  return (key, start) => { if (waiting.has(key)) return false; waiting.add(key); queue.push({ key, start }); next(); return true; };
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

// `chatFn`: the model the chat answers through, given by tests; else the person's own login (chat.js)
export function createUiServer(store, { home = thinkerHome(), transcriptsHome, cliPath = path.join(HERE, '..', 'cli.js'), refreshFn, refreshReportFn, refreshReposFn, spawnFn = spawn, chatFn = null } = {}) {
  refreshReposFn ||= () => { try { const p = spawn(process.execPath, [cliPath, 'ui', '--refresh'], { cwd: store.repo, stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch {} };
  const background = serialSpawner();
  const child = (args, cwd) => { const p = spawn(process.execPath, [cliPath, ...args], { cwd, stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return p; };
  // the kept Context report (what `thinker context` and thinker's own check read) is made again by `thinker context
  // --refresh` in the checkout, in the background, after a decision is taken back
  refreshFn ||= checkout => background(`context:${checkout}`, () => child(['context', '--refresh', '--quiet', '--repo', checkout], checkout));
  // an old Report by `thinker report --refresh`: one repository's, or every repository's in one run (null)
  refreshReportFn ||= checkout => checkout ? background(`report:${checkout}`, () => child(['report', '--refresh', '--quiet', '--repo', checkout], checkout)) : background('report:all', () => child(['report', '--refresh', '--all', '--quiet'], store.repo));
  // A repository thinker has not looked at lately is looked at by `thinker activity run --look` in the background (no
  // model call), one at a time with the other refreshes, and asked for at most every LOOK_ASK_MS so a look that fails is
  // not started again by every poll of the page. `--look`: a visit to the page never has thinker act; that is
  // maintenance's clock and the person's own `thinker activity run`. (`looking` in the answer counts the repositories
  // asked for in the last LOOK_WAIT_MS: after that the page stops waiting.)
  const lookAsked = new Map(), LOOK_ASK_MS = 10 * 60_000, LOOK_WAIT_MS = 2 * 60_000;
  const lookFn = checkout => {
    if (Date.now() - (lookAsked.get(checkout) || 0) < LOOK_ASK_MS) return false;
    lookAsked.set(checkout, Date.now());
    return background(`upkeep:${checkout}`, () => child(['activity', 'run', '--look', '--quiet', '--repo', checkout], checkout));
  };
  const scans = uiScans();
  let discovering;
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
  const harnessCache = new Map();
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
      if (req.method === 'GET' && url.pathname === '/api/repos') {
        if (!keptCheckouts({ home, transcriptsHome })) {
          discovering ||= scans.discover({ repo: store.repo, home, transcriptsHome }).finally(() => { discovering = null; });
          known = await discovering;
        } else known = listRepos();
        return json(res, 200, { repos: known });
      }
      // Progressive responses are opt-in so command/API clients still receive a complete view.
      const progressive = url.searchParams.get('progressive') === '1';
      if (!known && keptCheckouts({ home, transcriptsHome })) known = listRepos();
      if (!known) {
        discovering ||= scans.discover({ repo: store.repo, home, transcriptsHome }).finally(() => { discovering = null; });
        known = await discovering;
      }
      // the kept report (report.js:reportView, as `thinker report`; the Factory and Recent activity's pull requests read it):
      // one repository, or every repository's report merged, from
      // the report kept in each checkout (report-snapshot.js): made now only when there is none, made again in the background
      // when it is old, the page told when it was made and whether a newer one is coming; the decisions under it read live
      if (req.method === 'GET' && url.pathname === '/api/report') {
        const weeks = Math.max(1, Math.min(26, Number(url.searchParams.get('weeks')) || REPORT_WEEKS));
        const read = st => { if (progressive) return scans.read('report', st, weeks, { retry: url.searchParams.get('retry') === '1' }); const s = reportSnapshot(st, weeks); return { ...s, refreshing: s.stale || reportRefreshing(st) }; };
        let view, at, busy, status = {};
        if (want === 'all') {
          const xs = repos().flatMap(r => { try { const st = open(r.checkout); return [{ r, st, s: read(st) }]; } catch { return []; } });
          if (!xs.length) return json(res, 200, { empty: true });
          if (progressive) status = scanStatus(xs.map(x => x.s));
          if (progressive && url.searchParams.get('stamp') === '1') return json(res, 200, { loading: !xs.some(x => x.s.view), ...status });
          const ready = xs.filter(x => x.s.view);
          if (!ready.length) return json(res, 200, { loading: true, ...status });
          view = mergeReports(ready.map(({ r, s }) => ({ repo: r.id, name: r.name, view: s.view })));
          // the decisions and what each saved, read live over each kept report (report.js:reportActions)
          view.actions = ready.flatMap(({ r, st, s }) => reportActions(st, view.from, s.view.sessionRows || []).map(a => ({ ...a, repo: r.id, repoName: r.name }))).sort((a, b) => b.at.localeCompare(a.at));
          at = Math.min(...xs.map(x => x.s.at)); busy = xs.some(x => x.s.refreshing);
          if (xs.some(x => x.s.stale && !reportRefreshing(x.st))) refreshReportFn(null);
        } else {
          const one = storeFor(want); if (!one) return json(res, 400, { error: 'unknown repository' });
          const s = read(one);
          if (progressive) status = scanStatus([s]);
          if (progressive && url.searchParams.get('stamp') === '1') return json(res, 200, { loading: !s.view, ...status });
          if (!s.view) return json(res, 200, { loading: true, ...status });
          const actions = reportActions(one, s.view.from, s.view.sessionRows || []);
          view = { ...s.view, actions }; at = s.at; busy = s.refreshing;
          if (s.stale && !reportRefreshing(one)) refreshReportFn(one.repo);
        }
        const { sessionRows, ...sent } = view; // the session rows stay on this side: the page reads the actions costed
        return json(res, 200, { ...sent, asOf: Number.isFinite(at) ? at : Date.now(), refreshing: !!busy, ...status });
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
      // Recent activity (context-suggest.js:changeHistory, as `thinker context --history`): every decision taken, for one
      // repository or each of them, newest first, with what needs the person counted (`attention`: a change running or
      // failed, a pull request to merge) for the badge on the tab.
      // Reads no report: the history alone, so the badge can be asked for often.
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const stores = storesFor(want); if (!stores) return json(res, 400, { error: 'unknown repository' });
        // a pending pull request is asked after on GitHub first (context-suggest.js:refreshPrStates, a minute apart at most)
        const xs = [], machine = new Map(), sessionRows = [];
        // each decision with what it saved, over the report kept in its checkout (report-snapshot.js:historyEffects), and what
        // a prompt costs on average there (promptAverageHere), the size the savings are read against
        // a kept report that is none of this code's, or old, is made again in the background, and the answer says so
        // (`measuring`), so the page checks back instead of showing "measuring" for good
        const avgs = [], readings = []; let measuring = false;
        for (const [r, st] of stores) { try {
          await refreshPrStates(st);
          const entries = changeHistory(st), kept = keptRows(st);
          for (const h of entries.filter(h => h.scope === 'machine')) if (!machine.has(h.id)) machine.set(h.id, { ...h, repo: r.id, repoName: 'All repositories' });
          xs.push(...historyEffects(st, entries.filter(h => h.scope !== 'machine')).map(h => ({ ...h, repo: r.id, repoName: r.name })));
          sessionRows.push(...kept.rows); avgs.push(promptAverageHere(st));
          if (kept.stale && url.searchParams.get('measure') !== '0') { measuring = true; if (progressive) readings.push(scans.read('report', st, REPORT_WEEKS)); else if (!reportRefreshing(st)) refreshReportFn(st.repo); }
        } catch {} }
        xs.push(...withEffects([...machine.values()], sessionRows));
        const history = xs.sort((a, b) => b.at.localeCompare(a.at));
        // `scan`: how far the report read behind `measuring` has got, for the page's banner (scanProgress)
        return json(res, 200, { history, promptAvg: mergePromptAverages(avgs), measuring, scan: readings.length ? scanStatus(readings) : null, attention: history.filter(h => h.attention).length, running: history.filter(h => h.running).length });
      }
      // What thinker did (upkeep.js:upkeepView, as `thinker activity`), for one repository or every one merged
      // (mergeUpkeepViews), read from what the last check kept. Nothing is looked for on a visit: a repository
      // whose last check is old gets a look in the background (`looking`), and the page checks back.
      if (req.method === 'GET' && url.pathname === '/api/upkeep') {
        const stores = storesFor(want); if (!stores) return json(res, 400, { error: 'unknown repository' });
        const pairs = []; let looking = 0;
        for (const [r, st] of stores) { try {
          const view = upkeepView(st, { home });
          if (view.level !== 'off' && url.searchParams.get('look') !== '0' && (!view.lastCheck || Date.now() - Date.parse(view.lastCheck) > UPKEEP.staleMs)) { lookFn(st.repo); if (Date.now() - (lookAsked.get(st.repo) || 0) < LOOK_WAIT_MS) looking++; }
          pairs.push({ repo: r.id, name: r.name, view });
        } catch {} }
        // what it holds back and what is worth knowing are the chat's to say (chat.js:chatContext), not a list on the page
        const { pending, notes, ...shown } = mergeUpkeepViews(pairs);
        // the window's delegated work in the one line both doors print (upkeep.js:delegatedTotalSaid)
        return json(res, 200, { ...shown, delegated: { ...shown.delegated, said: delegatedTotalSaid(shown.delegated) }, repos: pairs.length, looking });
      }
      // a conversation with thinker and the history beside it (chat.js:chatView, as `thinker chat` and its --history):
      // the one named (`chat`), `new` for one not yet started, else the one last spoken in
      if (req.method === 'GET' && url.pathname === '/api/chat') return json(res, 200, chatView({ home, chat: url.searchParams.get('chat') || null }));
      // how thinker works on this machine, set by hand (settings.js:settingsView, as `thinker settings`)
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, settingsView({ home }));
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const b = await readBody(req);
      // one setting changed (settings.js:setSetting, as `thinker settings set`); the answer is the view after it
      if (url.pathname === '/api/settings') {
        const r = await setSetting(String(b.id || ''), b.value, { home });
        if (r.error) return json(res, 400, { error: r.error });
        harnessCache.clear();
        return json(res, 200, { ok: true, said: r.said, view: r.view });
      }
      // a message to thinker (chat.js:chatSend): one model call through the person's own login, or queued for an app's
      // session where no model can be called from here; shown every repository, told which one the person is looking at
      if (url.pathname === '/api/chat') {
        const all = (storesFor('all') || []).map(([r, st]) => ({ id: r.id, name: r.name, store: st }));
        const about = all.some(r => r.id === String(b.repo || '')) ? String(b.repo) : null;
        // `about`: the line of Recent activity the person attached with "Chat about this", if any (chat.js:refOf cuts it to size)
        const r = await chatSend(String(b.message || ''), { chat: typeof b.chat === 'string' && b.chat ? b.chat : null, repos: all, about, ref: b.about && typeof b.about === 'object' ? b.about : null, home, ...(chatFn ? { completeFn: chatFn } : {}), fns: { spawn: spawnFn } });
        if (r.error) return json(res, 400, { error: r.error });
        harnessCache.clear();
        return json(res, 200, { ok: true, chat: r.chat, messages: r.messages, chats: r.chats, pending: Boolean(r.pending) });
      }
      const st = storeFor(String(b.repo || ''));
      if (!st) return json(res, 400, { error: 'unknown repository' });
      await scans.cancel(); // an older scan must not overwrite snapshots after this action
      let r;
      if (url.pathname.startsWith('/api/harness/')) { harnessCache.clear(); dropSnapshots(st); }
      // a decision taken back keeps the Context report: the files it writes (config, settings, AGENTS.md) make the next
      // read a new one (context-snapshot.js)
      if (url.pathname.startsWith('/api/changes/')) harnessCache.clear();
      // the page's door to `thinker harness --off` and `--undo`: the same functions, for the repository it shows
      if (url.pathname === '/api/harness/undo') r = { said: undoHarness(st, { names: Array.isArray(b.names) ? b.names : null }) };
      else if (url.pathname === '/api/harness/off') r = Array.isArray(b.labels) && b.labels.length ? { said: switchOffNow(st, b.labels.join(','), { via: 'ui', any: true }) } : { error: 'nothing chosen' };
      // `thinker context --revert <n>`: a decision taken back (context-suggest.js:revertDecision); `--retry <n>`: a failed
      // change run again (retryJob)
      else if (url.pathname === '/api/changes/revert') { r = await revertDecision(st, String(b.id || '')); if (!r.error && !refreshing(st)) refreshFn(st.repo); }
      else if (url.pathname === '/api/changes/retry') r = retryJob(st, String(b.id || ''), { spawnFn, cliPath });
      else if (url.pathname === '/api/harness/settings') { const v = k => typeof b[k] === 'boolean' ? b[k] : undefined; r = { said: JSON.stringify(setHarnessSettings(st, { recall: v('recall') })) }; }
      else return json(res, 404, { error: 'not found' });
      if (r?.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, id: r?.note?.id, draft: r?.draft, queued: r?.queued, said: r?.said, pr: r?.pr });
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
    close: async () => { await scans.close(); await new Promise(r => { server.close(r); server.closeAllConnections?.(); }); },
    idleMs: () => Date.now() - lastRequest,
  };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}

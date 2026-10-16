// Launching benchmark runs from the app, and following runs in progress — the app's own and any
// started from a terminal. A launch is two steps: `plan` validates the request and prices it from
// past results, and only a plan the person confirmed is started (bench/MEASUREMENT.md: confirmed
// before any run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { median } from './stats.js';
import { BASELINE_ARMS } from './normalize.js';
import { readArm, writeArmDefs, armDefsFile } from './arms.js';
import { readPrset, checkPrset, listPrsets, isFrozen } from './prsets.js';
import { readReceipt, checkCache, notesDir, listCaches, planCache, cacheDir, STEPS, kindOf } from './caches.js';
import { acceptanceOf, loopLimits } from '../loop.js';

export const RUNNERS = {
  // isolated-settings, always: without it a session loads this machine's own Claude Code settings, and the
  // installed thinker's user-scope hooks reach every arm — the cache-off arm too (2026-10-15 smoke run:
  // the warm-up offer appeared in a nocache session)
  claude: { script: 'run.js', label: 'Claude Code (bench/run.js)', defaultModel: 'sonnet', defaultArms: 'nocache,cache', always: ['isolated-settings'],
    booleans: ['strict-model', 'isolated-settings', 'counterbalance', 'no-judge', 'no-subagents'], values: ['effort', 'max-turns', 'judge-samples', 'ce-views'] },
  codex: { script: 'codex-run.js', label: 'Codex (bench/codex-run.js)', defaultModel: 'gpt-5.6-terra', defaultArms: 'nocache,full',
    // loop: iterate to each task's acceptance criteria with a named checker (bench/loop.js)
    booleans: ['no-judge', 'loop'], values: ['budget', 'ce-views', 'checker', 'iterations', 'iteration-min', 'session-min', 'token-cap'] },
  gemini: { script: 'gemini-run.js', label: 'Gemini (bench/gemini-run.js)', defaultModel: 'gemini-3.8-flash-high', defaultArms: 'nocache,cache',
    booleans: ['strict-model', 'counterbalance', 'no-judge', 'no-tests'], values: ['effort', 'max-min'] },
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,80}$/;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

export function catalog(benchDir, db) {
  const tasksDir = path.join(benchDir, 'tasks');
  const repos = fs.existsSync(path.join(benchDir, 'repos')) ? fs.readdirSync(path.join(benchDir, 'repos')).filter(d => fs.existsSync(path.join(benchDir, 'repos', d, '.git'))) : [];
  const taskSets = (fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : []).filter(f => f.endsWith('.json')).map(f => {
    const spec = readJson(path.join(tasksDir, f)) || {};
    return { file: f, repo: f.replace(/(-hard|-adv)?\.json$/, ''), tasks: (spec.tasks || []).map(t => ({ id: t.id, pr: String(t.id).match(/^PR(\d+)/)?.[1] || null, title: t.goldTitle || null, area: t.area || null, type: t.type || 'question', tests: Boolean(t.testCmd) })) };
  });
  return { prsets: listPrsets(db), caches: listCaches(db), runners: Object.fromEntries(Object.entries(RUNNERS).map(([k, r]) => [k, { label: r.label, defaultModel: r.defaultModel, defaultArms: r.defaultArms, booleans: r.booleans, values: r.values }])), repos, taskSets };
}

// Validate an experiment and price it from past valid results of the same model (and repo when
// there are enough). An experiment is built from modules: a PR set (which PRs, at which base), a
// cache (what the cache-on arm is served, and how it was built), the arms, the agent, and the grader.
// Every module's checks are run here; a plan with a failing check is returned `blocked` and cannot be
// launched. Throws with a message the form shows when the request itself is malformed.
export function plan(req, { benchDir, db }) {
  const runner = RUNNERS[req.runner];
  if (!runner) throw new Error('unknown runner');
  const name = String(req.name || '').trim(), question = String(req.question || '').trim();
  if (!name) throw new Error('name the experiment');
  if (!question) throw new Error('say what the experiment tests');
  if (name.length > 120 || question.length > 300) throw new Error('name or question is too long');
  if (!['behavior', 'model'].includes(req.kind)) throw new Error('an experiment tests a behavior or a model');

  // module: PR set
  const prset = readPrset(db, req.prset);
  if (!prset) throw new Error(req.prset ? `no PR set ${req.prset}` : 'pick a PR set (create one from a task set first)');
  if (!isFrozen(prset)) throw new Error(`PR set ${prset.name} is a draft: freeze it before running it`);
  const repo = prset.repo;
  if (!fs.existsSync(path.join(benchDir, 'repos', repo, '.git'))) throw new Error(`bench/repos/${repo} is not a cloned repository`);
  const spec = readJson(path.join(benchDir, 'tasks', prset.tasks));
  if (!spec?.tasks?.length) throw new Error(`bench/tasks/${prset.tasks} is gone`);
  const tasks = spec.tasks.filter(t => prset.ids.includes(t.id));

  // module: agent
  const model = String(req.model || runner.defaultModel);
  if (!MODEL.test(model)) throw new Error('model is not valid');
  // run.js --strict-model compares the model that ran with the one asked for: an alias such as
  // `sonnet` never equals the id it resolves to, and the first session would stop the whole run
  if (req.flags?.['strict-model'] && !/\d/.test(model)) throw new Error(`--strict-model needs the exact model id (e.g. claude-sonnet-5-5), not the alias ${model}`);
  const reps = Math.max(1, Math.min(10, Number(req.reps) || 1));
  const conc = Math.max(1, Math.min(8, Number(req.conc) || 1));

  // module: arms — every experiment compares the cache off with it on; further arms ride along
  const [defOff, defOn] = runner.defaultArms.split(',');
  const codexArm = a => (req.runner === 'codex' && a === 'cache' ? 'full' : a);
  const off = codexArm(String(req.off || defOff).trim()), on = codexArm(String(req.on || defOn).trim());
  const extra = String(req.extra || '').split(',').map(s => codexArm(s.trim())).filter(Boolean);
  if (![off, on, ...extra].every(a => NAME.test(a))) throw new Error('arms are not valid');
  if (off === on) throw new Error('cache off and cache on must be different arms');
  const arms = [...new Set([off, on, ...extra])];
  // arms defined as data (evals/arms.js): handed to the runner whole, and recorded with the experiment
  const defined = Object.fromEntries(arms.map(a => [a, readArm(db, a)]).filter(([, d]) => d));
  for (const [a, d] of Object.entries(defined)) if (d.runner !== req.runner) throw new Error(`arm ${a} is defined for ${d.runner}, not ${req.runner}`);

  // module: cache — only when an arm is served thinker's notes. An experiment of another tool against
  // the cache off has none, and is given none so that no arm is served one by accident.
  const servesNotes = arms.some(a => !BASELINE_ARMS.includes(a) && defined[a]?.def.notes !== false);
  const receipt = servesNotes ? readReceipt(db, req.cache) : null;
  if (servesNotes && !receipt) throw new Error(req.cache ? `no cache ${req.cache}` : 'pick a cache (build one for this PR set first)');
  if (!servesNotes && req.cache) throw new Error(`no arm of ${arms.join(', ')} is served notes: leave the cache out`);

  // module: grading — the PRs' own tests where every PR has them, else a judge that is named, not defaulted
  const allTests = tasks.length && tasks.every(t => t.testCmd);
  const judged = tasks.some(t => !t.testCmd);
  if (req.judge && !MODEL.test(String(req.judge))) throw new Error('judge is not valid');
  if (judged && !req.judge && !req.flags?.['no-judge']) throw new Error(`${tasks.filter(t => !t.testCmd).length} of these PRs have no tests to grade them: name the judge model`);
  // module: loop (codex-run.js --loop) — the checker is a judge: named, and the same for every arm
  const loop = Boolean(req.flags?.loop);
  if (loop && !runner.booleans.includes('loop')) throw new Error(`${req.runner} has no loop mode yet: use the codex runner`);
  const checker = loop ? String(req.values?.checker || '') : null;
  if (loop && !MODEL.test(checker)) throw new Error('a loop experiment names its checker model');
  const limits = loop ? loopLimits(req.values || {}) : null;
  const graded = allTests ? `PR tests${req.judge ? ` (and judge ${req.judge})` : ''}` : req.flags?.['no-judge'] ? 'ungraded (--no-judge)' : `${tasks.some(t => t.type === 'change') ? 'patch/criteria' : 'answer'} judge: ${req.judge}`;

  const tag = String(req.tag || '');
  if (!NAME.test(tag)) throw new Error('tag is required: letters, digits, . _ -');
  const outDir = path.join(benchDir, 'runs', tag);
  const existing = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => f.replace(/\.json$/, '')) : [];

  const notes = receipt ? notesDir(benchDir, receipt.name) : null;
  const argv = [path.join(benchDir, runner.script), '--repo', repo, '--tasks', path.join(benchDir, 'tasks', prset.tasks), '--only', prset.ids.join(','),
    '--arm', arms.join(','), '--model', model, '--reps', String(reps), '--conc', String(conc), '--tag', tag, ...(notes ? ['--notes-dir', notes] : []), ...(Object.keys(defined).length ? ['--arm-defs', armDefsFile(benchDir, tag)] : [])];
  if (req.judge) argv.push('--judge', String(req.judge));
  // the PRs' tests grade every session: a judge would only spend
  else if (allTests && runner.booleans.includes('no-judge') && !req.flags?.['no-judge']) argv.push('--no-judge');
  for (const b of runner.booleans) if (req.flags?.[b] || runner.always?.includes(b)) argv.push('--' + b);
  for (const v of runner.values) if (req.values?.[v] != null && req.values[v] !== '') {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(String(req.values[v]))) throw new Error(`--${v} is not valid`);
    argv.push('--' + v, String(req.values[v]));
  }

  const checks = [
    ...checkPrset(benchDir, prset).map(c => ({ module: 'PR set', ...c })),
    ...(receipt ? checkCache(benchDir, receipt, prset, model).map(c => ({ module: 'cache', ...c })) : []),
    ...(loop ? [checkAcceptance(tasks)] : []),
  ];
  const expected = expectedIds(prset.ids, arms, reps);
  const todo = expected.filter(id => !existing.includes(id));
  // the runners skip a result already on disk, so a tag that has some is a resume
  const history = estimate(db, model, repo);
  const n = todo.length, f = loop ? LOOP_GUESS : 1;
  return {
    runner: req.runner, repo, tasks: prset.tasks, arms, model, reps, conc, tag, only: prset.ids,
    experiment: { name, question, kind: req.kind, off, on },
    modules: {
      prset: { name: prset.name, hash: prset.hash, rule: prset.rule, base: prset.base, prs: prset.ids.length, tasks: prset.tasks },
      cache: receipt && { name: receipt.name, anchor: receipt.anchor, model: receipt.model, llm: receipt.llm, limit: receipt.limit, notes: receipt.notes, notes_hash: receipt.notes_hash, kind: kindOf(receipt), top: receipt.top ?? null, areas: receipt.areas ?? null, source: kindOf(receipt) === 'mined' ? 'mine-prs --git' : 'understand' },
      arms: { off, on, extra, ...(Object.keys(defined).length ? { defined: Object.fromEntries(Object.entries(defined).map(([a, d]) => [a, { hash: d.hash, ...d.def }])) } : {}) },
      agent: { runner: req.runner, model, reps, conc, flags: [...new Set([...Object.keys(req.flags || {}).filter(k => req.flags[k]), ...(runner.always || [])])], values: req.values || {} },
      grading: { oracle: allTests ? 'tests' : 'judge', judge: req.judge || null, summary: graded },
      ...(loop ? { loop: { checker, ...limits } } : {}),
    },
    checks, blocked: checks.some(c => !c.ok),
    command: ['node', ...argv.map(a => (a.startsWith(benchDir) ? path.relative(path.dirname(benchDir), a) : a))].join(' '),
    argv, expected, sessions: n, resumed: expected.length - n,
    cache: notes && path.relative(path.dirname(benchDir), notes), graded,
    estimate: history.n ? {
      basis: loop ? `${history.basis}, one-shot sessions × ${LOOP_GUESS} iterations (a guess until loop results exist), checker not included` : history.basis, n: history.n,
      in_tokens: history.in_tokens * n * f, out_tokens: history.out_tokens * n * f,
      cost: history.cost != null ? history.cost * n * f : null,
      wall_ms: history.wall_ms * Math.ceil(n / conc) * f,
    } : null,
  };
}

// A loop experiment needs acceptance criteria on every PR: written from the request and the base code,
// never from the gold diff or tests, because the solver is told which ones fail (bench/loop.js).
export function checkAcceptance(tasks) {
  const missing = tasks.filter(t => !acceptanceOf(t).length).map(t => t.id);
  return { module: 'loop', ok: !missing.length, check: 'acceptance criteria on every PR', detail: missing.length ? `missing on ${missing.join(', ')}` : `${tasks.length} PRs` };
}
const LOOP_GUESS = 2;

export function expectedIds(taskIds, arms, reps) {
  const ids = [];
  for (let rep = 0; rep < reps; rep++) for (const t of taskIds) for (const a of arms) ids.push(`${t}-${a}-${rep}`);
  return ids;
}

function estimate(db, model, repo) {
  const q = (m, where) => db.all(`SELECT in_tokens, out_tokens, cost, wall_ms FROM results WHERE invalid IS NULL AND model = ? ${where}`, m, ...(where ? [repo] : []));
  // results are recorded under the alias that was asked for; an exact id falls back to its family's
  const family = (model.match(/haiku|sonnet|opus|fable|gemini|gpt/) || [null])[0];
  let rows = q(model, 'AND repo = ?'), basis = `${model} on ${repo}`;
  if (rows.length < 4) { rows = q(model, ''); basis = `${model}, all repositories`; }
  if (rows.length < 4 && family && family !== model) { rows = q(family, 'AND repo = ?'); basis = `${family} on ${repo} (same family)`; }
  if (rows.length < 4 && family && family !== model) { rows = q(family, ''); basis = `${family}, all repositories (same family)`; }
  return { n: rows.length, basis, in_tokens: median(rows.map(r => r.in_tokens)) || 0, out_tokens: median(rows.map(r => r.out_tokens)) || 0, cost: median(rows.map(r => r.cost)), wall_ms: median(rows.map(r => r.wall_ms)) || 0 };
}

export function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export function launch(p, { benchDir, db }) {
  const outDir = path.join(benchDir, 'runs', p.tag);
  fs.mkdirSync(outDir, { recursive: true });
  // the experiment's definition is recorded before the first session exists
  const prev = db.definition(p.tag) || {};
  db.setDefinition(p.tag, { ...prev, ...p.experiment, modules: p.modules, created_at: prev.created_at || Date.now(),
    launched: [...(prev.launched || []), { at: Date.now(), runner: p.runner, model: p.model, tasks: p.tasks, reps: p.reps, arms: p.arms, command: p.command, checks: p.checks }] });
  db.run('UPDATE runs SET repo = coalesce(repo, ?), runner = coalesce(runner, ?), arms = ?, models = coalesce(nullif(models, \'\'), ?) WHERE dir = ?', p.repo, p.runner, p.arms.join(','), p.model, p.tag);
  // the defined arms, as planned, where the runner reads them (--arm-defs)
  if (p.modules.arms.defined) writeArmDefs(benchDir, p.tag, Object.fromEntries(Object.entries(p.modules.arms.defined).map(([a, { hash, ...def }]) => [a, def])));
  const log = path.join(outDir, 'harness.log');
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `\n# ${new Date().toISOString()} launched from Artemis\n# ${p.command}\n`);
  // detached: its own process group, so the run outlives the app and a cancel reaches every agent it spawned
  const child = spawn(process.execPath, p.argv, { cwd: path.dirname(benchDir), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_TEST: '1', THINKER_HOLDOUT: '0' } });  // AGENTS.md: no telemetry from benchmarks
  fs.closeSync(fd);
  const { lastInsertRowid } = db.run(`INSERT INTO jobs (tag, runner, args, plan, status, pid, expected, started_at, log) VALUES (?,?,?,?,?,?,?,?,?)`,
    p.tag, p.runner, JSON.stringify(p.argv), JSON.stringify(p), 'running', child.pid, p.expected.length, Date.now(), log);
  const id = Number(lastInsertRowid);
  child.on('exit', code => db.run(`UPDATE jobs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ? AND status = 'running'`, code === 0 ? 'done' : 'failed', code, Date.now(), id));
  child.unref();
  return id;
}

// A cache build: bench/evals/build-cache.js, detached like an experiment, its log beside the cache.
export function launchCache(p, { benchDir, db }) {
  const out = cacheDir(benchDir, p.name);
  if (fs.existsSync(out) && !p.resume) throw new Error(`cache ${p.name} exists`);
  if (p.resume && db.get(`SELECT 1 FROM jobs WHERE kind = 'cache' AND tag = ? AND status = 'running'`, p.name)) throw new Error(`a build of ${p.name} is running`);
  fs.mkdirSync(out, { recursive: true });
  const planFile = path.join(out, p.resume ? `plan-resume-${Date.now()}.json` : 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(p, null, 2) + '\n');
  const log = path.join(out, 'build.log');
  const fd = fs.openSync(log, 'a');
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'build-cache.js');
  const child = spawn(process.execPath, [script, benchDir, planFile, db.file], { cwd: path.dirname(benchDir), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_TEST: '1' } });
  fs.closeSync(fd);
  const command = `node bench/evals/build-cache.js (${p.steps.join('; ')})`;
  const { lastInsertRowid } = db.run(`INSERT INTO jobs (kind, tag, runner, args, plan, status, pid, expected, started_at, log) VALUES ('cache',?,?,?,?,?,?,?,?,?)`,
    p.name, p.llm, JSON.stringify([script, planFile]), JSON.stringify({ ...p, command }), 'running', child.pid, STEPS.length, Date.now(), log);
  const id = Number(lastInsertRowid);
  child.on('exit', code => db.run(`UPDATE jobs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ? AND status = 'running'`, code === 0 ? 'done' : 'failed', code, Date.now(), id));
  child.unref();
  return id;
}

export function cancel(db, id) {
  const j = db.get('SELECT * FROM jobs WHERE id = ?', id);
  if (!j || j.status !== 'running') throw new Error('job is not running');
  // only the process group this app started: never a blanket kill
  try { process.kill(-j.pid, 'SIGTERM'); } catch {}
  db.run(`UPDATE jobs SET status = 'cancelled', ended_at = ? WHERE id = ?`, Date.now(), id);
}

function tail(file, bytes = 6000) {
  try {
    const st = fs.statSync(file), fd = fs.openSync(file, 'r');
    const len = Math.min(bytes, st.size), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(len < st.size ? 1 : 0).join('\n');
  } catch { return ''; }
}

function progressOf(benchDir, tag, expected, startedAt) {
  const outDir = path.join(benchDir, 'runs', tag);
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const doneIds = expected ? expected.filter(id => files.includes(id + '.json')) : files.filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => f.replace(/\.json$/, ''));
  let errors = 0, lastAt = null;
  const recent = [];
  for (const id of doneIds) {
    const p = path.join(outDir, id + '.json');
    const st = fs.statSync(p);
    if (!startedAt || st.mtimeMs >= startedAt) recent.push(st.mtimeMs);
    lastAt = Math.max(lastAt || 0, st.mtimeMs);
    const r = readJson(p);
    if (r && (r.error || r.is_error)) errors++;
  }
  return { done: doneIds.length, expected: expected ? expected.length : null, errors, last_at: lastAt, finished_this_launch: recent.length };
}

export function jobsView(db, benchDir) {
  for (const j of db.all(`SELECT id, pid FROM jobs WHERE status = 'running'`)) if (!alive(j.pid)) db.run(`UPDATE jobs SET status = 'exited', ended_at = ? WHERE id = ?`, Date.now(), j.id);
  const jobs = db.all('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').map(j => {
    const p = JSON.parse(j.plan);
    if (j.kind === 'cache') {
      // progress is the build's steps: snapshot, mine-prs, phrase, relink, export
      const r = db.getCache(j.tag) || {};
      return { id: j.id, kind: 'cache', source: 'app', tag: j.tag, name: `cache ${j.tag}`, runner: j.runner, model: p.model, repo: p.repo, arms: [],
        status: j.status === 'running' ? 'running' : r.status === 'ok' ? 'done' : j.status, exit_code: j.exit_code, started_at: j.started_at, ended_at: j.ended_at,
        elapsed: (j.ended_at || Date.now()) - j.started_at, eta: null, command: p.command, done: (r.steps_done || []).length, expected: STEPS.length, errors: r.status === 'failed' ? 1 : 0,
        last_at: null, step: r.status === 'failed' ? `failed: ${r.error}` : STEPS.find(x => !(r.steps_done || []).includes(x)) || 'finished', progress: r.progress || null, log: tail(j.log).split('\n').slice(-40).join('\n') };
    }
    const prog = progressOf(benchDir, j.tag, p.expected, j.started_at);
    const end = j.ended_at || Date.now(), elapsed = end - j.started_at;
    const remaining = prog.expected - prog.done;
    const eta = j.status === 'running' && prog.finished_this_launch ? (elapsed / prog.finished_this_launch) * remaining : (j.status === 'running' && p.estimate ? p.estimate.wall_ms : null);
    const logTail = tail(j.log);
    return {
      id: j.id, kind: 'experiment', source: 'app', tag: j.tag, name: p.experiment?.name || null, runner: j.runner, model: p.model, repo: p.repo, arms: p.arms, status: j.status, exit_code: j.exit_code,
      started_at: j.started_at, ended_at: j.ended_at, elapsed, eta, command: p.command, ...prog,
      limit_wait: /LIMIT hit[^\n]*\n?$/.test(logTail.trimEnd() + '\n') && j.status === 'running',
      live: j.status === 'running' ? liveSessions(benchDir, { runner: j.runner, repo: p.repo, tag: j.tag, conc: p.conc }) : [],
      log: logTail.split('\n').slice(-40).join('\n'),
    };
  });
  const own = new Set(db.all(`SELECT pid FROM jobs WHERE status = 'running'`).map(j => j.pid));
  return [...external(benchDir, own), ...jobs];
}

// Runs started from a terminal: found in the process table, their progress read from the tag directory.
function external(benchDir, own) {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', maxBuffer: 8 << 20 }); } catch { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S*node\S*)\s+(\S*bench\/(run|codex-run|gemini-run)\.js)(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (own.has(pid) || own.has(Number(m[2]))) continue;
    const args = m[7].trim().split(/\s+/), flags = {};
    for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    const runner = { run: 'claude', 'codex-run': 'codex', 'gemini-run': 'gemini' }[m[6]];
    // a run from another checkout writes under that checkout's bench/runs
    const bench = path.isAbsolute(m[5]) ? path.dirname(m[5]) : path.dirname(path.resolve(cwdOf(pid) || path.dirname(benchDir), m[5]));
    const repo = flags.repo || (runner === 'claude' ? 'click' : 'posthog');
    const tag = flags.tag; if (!tag) continue;
    const spec = readJson(flags.tasks ? path.resolve(path.dirname(bench), flags.tasks) : path.join(bench, 'tasks', runner === 'claude' ? `${repo}.json` : `${repo}-hard.json`));
    let expected = null;
    if (spec?.tasks) {
      const only = flags.only ? String(flags.only).split(',') : null;
      const ids = spec.tasks.filter(t => !only || only.includes(t.id)).map(t => t.id);
      let arms = String(flags.arm || RUNNERS[runner].defaultArms).split(',');
      if (runner === 'codex') arms = arms.map(a => (a === 'cache' ? 'full' : a));
      expected = expectedIds(ids, arms, Number(flags.reps) || (runner === 'codex' ? 2 : 1));
    }
    const elapsed = etimeMs(m[3]);
    const prog = progressOf(bench, tag, expected, Date.now() - elapsed);
    const remaining = prog.expected != null ? prog.expected - prog.done : null;
    rows.push({
      id: 'pid-' + pid, source: 'terminal', tag, name: null, runner, model: flags.model || RUNNERS[runner].defaultModel, repo, arms: String(flags.arm || RUNNERS[runner].defaultArms).split(','),
      status: 'running', started_at: Date.now() - elapsed, elapsed, eta: prog.finished_this_launch && remaining != null ? (elapsed / prog.finished_this_launch) * remaining : null,
      command: `${m[5].replace(/^.*?(bench\/)/, '$1')} ${m[7].trim()}`, ...prog, log: '',
      live: liveSessions(bench, { runner, repo, tag, conc: Number(flags.conc) || 1 }),
    });
  }
  return rows;
}

function cwdOf(pid) {
  try { return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').find(l => l.startsWith('n'))?.slice(1) || null; } catch { return null; }
}

// The sessions of a running experiment, read live from the transcripts their agents are writing. A
// worker's worktree is bench/worktrees/<repo>-<tag>-<i> (run.js:makeWorktree) and Claude Code writes the
// session under ~/.claude/projects/<that path, / and . as ->/. Codex and Gemini write theirs at the end.
export function liveSessions(benchDir, { runner, repo, tag, conc = 8 }) {
  if (runner !== 'claude') return [];
  const out = [];
  for (let i = 0; i < Math.max(1, conc); i++) {
    let wt = path.join(benchDir, 'worktrees', `${repo}-${tag}-${i}`);
    if (!fs.existsSync(wt)) continue;
    try { wt = fs.realpathSync(wt); } catch {}
    const proj = path.join(os.homedir(), '.claude', 'projects', wt.replace(/[\/.]/g, '-'));
    let newest = null;
    try { for (const f of fs.readdirSync(proj)) { if (!f.endsWith('.jsonl')) continue; const m = fs.statSync(path.join(proj, f)).mtimeMs; if (!newest || m > newest.m) newest = { f, m }; } } catch { continue; }
    if (!newest || Date.now() - newest.m > 15 * 60e3) { out.push({ worker: i, state: 'starting' }); continue; }
    const text = fs.readFileSync(path.join(proj, newest.f), 'utf8');
    let steps = 0, tools = 0, lastTool = null, request = null, tokens = 0;
    for (const line of text.split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'user' && !request && typeof j.message?.content === 'string') request = j.message.content.split('\n')[0].slice(0, 140);
      if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
      steps++;
      const u = j.message.usage; if (u) tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const b of j.message.content) if (b.type === 'tool_use') { tools++; lastTool = { name: b.name, input: String(b.input?.command || b.input?.file_path || b.input?.pattern || b.input?.task || '').slice(0, 120) }; }
    }
    out.push({ worker: i, state: 'working', session: newest.f.replace(/\.jsonl$/, ''), request, steps, tools, last_tool: lastTool, context_tokens: tokens, last_at: newest.m });
  }
  return out;
}

function etimeMs(s) {
  const [d, rest] = s.includes('-') ? s.split('-') : [0, s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(d) * 24 + parts[0]) * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

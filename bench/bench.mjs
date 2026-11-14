#!/usr/bin/env node
// The bench: run paired agent sessions over a task, record what happened, compare the arms.
//
// Why it exists. Experiments here used to go through Artemis (a web app and a SQLite database) driving
// kronus (a runner). That pair cost more than it gave for a one-person loop: on 2026-11-14 three starts
// of one experiment failed in a row, and the one that spent money ($25.53, six sessions, none valid) did
// so because the runner caps a session at 60 turns by default and these tasks need ~80 -- a figure the
// database itself held from the published runs on the same tasks and never carried forward. What the
// owner wanted from it was a consistent place to keep runs and a consistent way to start them. That is
// this file, plus a ledger of one line per session.
//
// What it keeps from the old layer, because these are what make a result still true next month:
//   - the task set is files on disk at a named commit, and the record carries the hash of what ran;
//   - the selection rule is written in the spec, before the run, and copied onto every record;
//   - a session that hit a limit or errored is INVALID and never averaged (the fault above);
//   - arms are paired by task and rep, and the report never averages a ratio of averages.
// What it drops: a database, a server, bootstrap intervals (`report --boot` does a plain one), job
// queues, concurrency beyond a worker count, and every guardrail that refused to start.
//
//   node bench/bench.mjs run bench/experiments/<spec>.json [--only t1,t2] [--arms a,b] [--reps n] [--dry]
//   node bench/bench.mjs grade <tag> [--id <session>] [--judge <model>] [--tasks-dir <dir>]
//   node bench/bench.mjs report <tag> [--boot]
//   node bench/bench.mjs ledger [--tag <tag>]
//
// Model spend: `run` starts real agent sessions. `--dry` prints what it would run and starts nothing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const LEDGER = path.join(ROOT, 'bench', 'ledger.jsonl');
const RUNS = process.env.BENCH_RUNS || path.join(ROOT, 'bench', 'runs');

// List prices per million tokens, by model. One table, used by every figure this file prints, so a
// number here is never two numbers. Cache writes are the one-hour TTL (twice input); a 5m write is 1.25x
// and is not modelled -- long sessions write at 1h.
const PRICES = {
  'claude-opus-5-5': { input: 4, out: 20, read: 0.2, write: 8 },
  'claude-sonnet-5-5': { input: 2, out: 10, read: 0.2, write: 4 },
  'claude-haiku-5-5': { input: 0.1, out: 0.5, read: 0.01, write: 0.2 },
};
const priceOf = model => PRICES[model] || PRICES['claude-opus-5-5'];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const rows = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const hashOf = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
// where a recorded row's task files live, so `grade` can reread them after the fact
const taskDirOf = r => path.resolve(ROOT, r.tasksDir || 'bench/tasks');

// ---- the task set, hashed ----
// A task is a directory of `turn-N.txt` prompts (`{CWD}` becomes the worktree) and an optional
// `check.sh` run in the worktree afterwards, whose last line is the outcome. The hash covers every
// prompt and the check, so a record says exactly what ran and a changed task is a different task.
function taskOf(dir, id) {
  const d = path.join(dir, id);
  if (!fs.existsSync(d)) throw new Error(`no task directory: ${d}`);
  const turns = fs.readdirSync(d).filter(f => /^turn-\d+\.txt$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  if (!turns.length) throw new Error(`task ${id} has no turn-N.txt`);
  const check = fs.existsSync(path.join(d, 'check.sh')) ? path.join(d, 'check.sh') : null;
  const text = turns.map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\0') + (check ? fs.readFileSync(check, 'utf8') : '');
  return { id, dir: d, turns: turns.map(f => path.join(d, f)), check, hash: hashOf(text) };
}

// ---- an arm, written into the worktree ----
// An arm is env, plus project-scope Claude Code files: `hooks` go in .claude/settings.json and `agents`
// become .claude/agents/<Name>.md. Project scope is what matters: the runner passes
// --setting-sources project, so a user-scope file on this machine is never read and one session can
// never inherit another's wiring. `before` is a list of argv arrays run in the worktree.
function writeArm(cwd, arm) {
  if (arm.hooks) {
    const f = path.join(cwd, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cur = fs.existsSync(f) ? readJson(f) : {};
    fs.writeFileSync(f, JSON.stringify({ ...cur, hooks: arm.hooks }, null, 1));
  }
  for (const [name, a] of Object.entries(arm.agents || {})) {
    const f = path.join(cwd, '.claude', 'agents', `${name}.md`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const front = Object.entries(a).filter(([k]) => k !== 'body').map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(f, `---\nname: ${name}\n${front}\n---\n\n${a.body || ''}\n`);
  }
  for (const cmd of arm.before || []) sh(cmd[0], cmd.slice(1).map(s => s.replaceAll('{CWD}', cwd)), { cwd });
}

// ---- one session: the turns of one task, resumed ----
// Claude Code is given each turn in order on one session id, which is the only shape that has a turn
// boundary at all. Every turn's JSON is kept: a turn that errored or hit the turn cap makes the whole
// session invalid, and the record says which turn and why. maxTurns defaults to 180 because the cap is
// what voided the runs of 2026-11-14; a task of this shape runs 76-87.
async function runSession({ spec, task, armName, arm, rep, dry }) {
  const id = `${task.id}-${armName}-${rep}`;
  const cwd = path.join(RUNS, spec.tag, id);
  const model = arm.model || spec.model || 'claude-opus-5-5';
  const maxTurns = String(arm.maxTurns || spec.maxTurns || 180);
  if (dry) return { id, dry: true, cwd, model, turns: task.turns.length };

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cwd), { recursive: true });
  try { sh('git', ['-C', spec.base, 'worktree', 'remove', '--force', cwd], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}
  sh('git', ['-C', spec.base, 'worktree', 'add', '-q', '--detach', cwd, spec.ref || 'HEAD']);
  writeArm(cwd, arm);

  const session = crypto.randomUUID();
  const env = { ...process.env, ...(arm.env || {}) };
  // Nothing inherits this machine's proxy: an arm that did would be measured against thinker's own
  // clearing rather than against the other arm. The old runner refused to start over exactly this.
  if (!env.ANTHROPIC_BASE_URL || !arm.env?.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = arm.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const turns = [];
  for (const [i, file] of task.turns.entries()) {
    const prompt = fs.readFileSync(file, 'utf8').replaceAll('{CWD}', cwd);
    const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--max-turns', maxTurns,
      '--permission-mode', 'bypassPermissions', '--setting-sources', 'project', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', ...(i === 0 ? ['--session-id', session] : ['--resume', session])];
    const r = await once('claude', args, { cwd, env });
    turns.push(r);
    process.stderr.write(`  [${id}] turn ${i + 1}/${task.turns.length} ${r.is_error ? `ERROR ${r.subtype || ''}` : 'ok'} $${(r.total_cost_usd || 0).toFixed(2)}\n`);
    if (r.is_error) break;  // a broken turn makes the rest meaningless: stop and record it
  }
  const outcome = task.check ? lastLine(tryRun('bash', [task.check], cwd)) : null;
  const after = arm.after ? tryRun(arm.after[0], arm.after.slice(1).map(s => s.replaceAll('{CWD}', cwd)), cwd) : null;
  // graded after the arm's own after step, so staging the diff cannot disturb what that step reads
  const verdict = await grade({ task, cwd, judge: arm.judge || spec.judge });
  return record({ spec, task, armName, arm, rep, id, cwd, model, session, turns, outcome, after, verdict, maxTurns: Number(maxTurns) });
}

// ---- grading ----
// A task's criteria.json is a list of { id, behavior, essential }. The judge is shown those and the
// session's own diff against the base commit, and answers per criterion. Two figures are recorded, never
// one: `pass` is every ESSENTIAL criterion met, `passAll` is every criterion -- a run that reports the
// essential flag alone overstates, which is why the PostHog broadcast set says in its own rule that full
// success needs all of them. The diff is taken through the worktree's index (`add -A` then `diff
// --cached`) so a file the agent created counts; the worktree is disposable, so staging in it is free.
// Cost: one judge call per session, on a diff capped at DIFF_CAP characters (truncation is recorded, so a
// verdict reached on a partial diff is never read as a verdict on the whole).
const DIFF_CAP = 120_000;
async function grade({ task, cwd, judge }) {
  const f = path.join(task.dir, 'criteria.json');
  if (!judge || !fs.existsSync(f)) return null;
  const crit = (readJson(f).criteria || []).filter(c => c && c.behavior);
  if (!crit.length) return null;
  // Two separate steps, each with its own catch: `sh` trims its stdout, so an `add` told to ignore
  // stdout returns null and throws inside the helper -- which silently cost the whole diff the first time
  // (0 chars graded against a worktree holding 32k of real change). The arm's own plumbing is excluded by
  // pathspec: `.claude` carries the hooks and the pinned agent this bench writes, `.thinker` the tool's
  // own state, and a judge shown either is grading the harness.
  let diff = '';
  try { sh('git', ['-C', cwd, 'add', '-A']); } catch {}
  try { diff = sh('git', ['-C', cwd, 'diff', '--cached', '--', '.', ':(exclude).claude', ':(exclude).thinker'], { maxBuffer: 1 << 28 }); } catch { diff = ''; }
  const truncated = diff.length > DIFF_CAP;
  const brief = `You are grading one change against criteria written before it was made. Judge ONLY from the diff below: a criterion is met if the diff plainly implements it, and not met if it does not, is partial, or you cannot tell. Do not reward intent, comments or tests that assert nothing.

CRITERIA
${crit.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n\n')}

DIFF${truncated ? ` (TRUNCATED to the first ${DIFF_CAP} characters of ${diff.length})` : ''}
${diff.slice(0, DIFF_CAP) || '(no change was made)'}

Answer with JSON only, no prose and no code fence:
{"verdicts":[{"id":"c1","met":true,"why":"<=15 words"}],"note":"<=25 words"}`;
  const r = await once('claude', ['-p', brief, '--output-format', 'json', '--model', judge, '--max-turns', '2',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent'],
    { cwd, env: { ...process.env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  let j = null;
  try { j = JSON.parse(String(r.result || '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch {}
  if (!j || !Array.isArray(j.verdicts)) return { judge, error: `unparsed: ${String(r.result || r.subtype).slice(0, 200)}`, costUsd: r.total_cost_usd || 0 };
  const byId = Object.fromEntries(j.verdicts.map(v => [v.id, Boolean(v.met)]));
  const ess = crit.filter(c => c.essential);
  return {
    judge, truncatedDiff: truncated, diffChars: diff.length, costUsd: r.total_cost_usd || 0,
    pass: ess.length > 0 && ess.every(c => byId[c.id]), passAll: crit.every(c => byId[c.id]),
    met: crit.filter(c => byId[c.id]).length, of: crit.length, essentialMet: ess.filter(c => byId[c.id]).length, essentialOf: ess.length,
    missed: crit.filter(c => !byId[c.id]).map(c => c.id), verdicts: j.verdicts, note: j.note || null,
  };
}

const lastLine = s => String(s || '').trim().split('\n').pop() || null;
const tryRun = (cmd, args, cwd) => { try { return sh(cmd, args, { cwd }); } catch (e) { return String(e.stdout || e.message || '').trim(); } };

function once(cmd, args, opts) {
  return new Promise(resolve => {
    let out = '', err = '';
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ is_error: true, subtype: 'spawn', result: e.message }));
    child.on('close', code => {
      let j = null; try { j = JSON.parse(out); } catch {}
      resolve(j || { is_error: true, subtype: `exit ${code}`, result: (err || out).slice(0, 400) });
    });
  });
}

// ---- the record, and the ledger ----
// One line per session in bench/ledger.jsonl, which is committed: the provenance lives in git history
// rather than in a database nobody can read without the app. The transcript stays on disk and the record
// names it. `valid` is the whole point of the structure: a session that errored or hit the cap is
// recorded in full and excluded from every figure, so a run can never silently average a truncated one.
function record(o) {
  const { spec, task, armName, arm, rep, id, cwd, model, session, turns, outcome, after, verdict, maxTurns } = o;
  const sum = k => turns.reduce((a, t) => a + (Number(t?.usage?.[k]) || 0), 0);
  const usage = { input: sum('input_tokens'), read: sum('cache_read_input_tokens'), write: sum('cache_creation_input_tokens'), out: sum('output_tokens') };
  const p = priceOf(model);
  // The agent's own reported cost, which includes its subagents. `total_cost_usd` is CUMULATIVE over a
  // resumed thread (0.78, 2.35, ... 9.51 across nine turns of one session, measured 2026-11-14), while
  // `usage` is per turn, so the cost is the largest value seen and the tokens are a sum. Adding the cost
  // up read $54.06 for a $9.51 session -- the same trap the Codex runner has, where `resume`'s usage is
  // the thread total. The list-price arithmetic below is kept beside it as the cross-check: on that
  // session the two agreed to the cent once this was right.
  const reported = turns.reduce((a, t) => Math.max(a, Number(t?.total_cost_usd) || 0), 0);
  const listed = (usage.input * p.input + usage.read * p.read + usage.write * p.write + usage.out * p.out) / 1e6;
  const bad = turns.find(t => t?.is_error);
  const numTurns = turns.reduce((a, t) => a + (Number(t?.num_turns) || 0), 0);
  const rec = {
    at: new Date().toISOString(), tag: spec.tag, task: task.id, taskHash: task.hash, arm: armName,
    armHash: hashOf(JSON.stringify(arm)), rep, id, model, session, rule: spec.rule || null,
    base: spec.base, ref: spec.ref || null, tasksDir: spec.tasksDir, prompts: turns.length, expectedPrompts: task.turns.length,
    agentTurns: numTurns, maxTurns, usage, costReported: reported, costListed: listed,
    wallMs: turns.reduce((a, t) => a + (Number(t?.duration_ms) || 0), 0),
    outcome, armReport: after || null, grade: verdict || null,
    valid: !bad && turns.length === task.turns.length,
    invalidReason: bad ? `turn ${turns.length}: ${bad.subtype || 'error'}${/max_turns/.test(bad.subtype || '') ? ` (cap ${maxTurns})` : ''}`
      : (turns.length === task.turns.length ? null : `only ${turns.length} of ${task.turns.length} prompts ran`),
    transcript: path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(cwd).replaceAll('/', '-').replaceAll('.', '-'), `${session}.jsonl`),
    cwd,
  };
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  fs.writeFileSync(path.join(RUNS, spec.tag, `${id}.json`), JSON.stringify({ ...rec, turns }, null, 1));
  return rec;
}

// ---- report: arms paired by task and rep ----
// Every rate is a ratio of sums, never a mean of per-session ratios, and only a task both arms finished
// validly enters a paired difference. `--boot` resamples the paired tasks for a 90% interval; with the
// handful of tasks a bench like this runs it is a spread, not a p-value, and is labelled as such.
function report(tag, { boot = false } = {}) {
  const all = fs.existsSync(LEDGER) ? rows(LEDGER).filter(r => r.tag === tag) : [];
  if (!all.length) return console.log(`no sessions recorded for ${tag}`);
  const arms = [...new Set(all.map(r => r.arm))];
  const invalid = all.filter(r => !r.valid);
  console.log(`\n${tag}  ${all.length} sessions, ${all.length - invalid.length} valid, ${arms.length} arms`);
  if (all[0].rule) console.log(`rule: ${all[0].rule}`);
  console.log('\narm              n  valid   $rep    $list   in_tok    out_tok  turns  pass    outcome');
  for (const a of arms) {
    const v = all.filter(r => r.arm === a && r.valid);
    const s = k => v.reduce((x, r) => x + (r[k] || 0), 0);
    const u = k => v.reduce((x, r) => x + (r.usage?.[k] || 0), 0);
    const g = v.filter(r => r.grade && !r.grade.error);
    const pass = g.length ? `${g.filter(r => r.grade.pass).length}/${g.length}` : '-';
    console.log(`${a.padEnd(16)} ${String(all.filter(r => r.arm === a).length).padStart(2)}  ${String(v.length).padStart(5)}  ${s('costReported').toFixed(2).padStart(6)}  ${s('costListed').toFixed(2).padStart(6)}  ${String(u('input') + u('read') + u('write')).padStart(9)}  ${String(u('out')).padStart(7)}  ${String(v.reduce((x, r) => x + r.agentTurns, 0)).padStart(5)}  ${pass.padStart(5)}  ${v.map(r => r.outcome || '-').join(' ')}`);
    for (const r of g) console.log(`   ${r.task}: ${r.grade.essentialMet}/${r.grade.essentialOf} essential, ${r.grade.met}/${r.grade.of} all${r.grade.missed.length ? `, missed ${r.grade.missed.join(',')}` : ''}${r.grade.truncatedDiff ? ' (diff truncated)' : ''}`);
    for (const r of v.filter(x => x.grade && x.grade.error)) console.log(`   ${r.task}: JUDGE FAILED (${r.grade.error})`);
  }
  const ref = arms[0];
  for (const a of arms.slice(1)) {
    const pairs = [];
    for (const r of all.filter(x => x.arm === a && x.valid)) {
      const o = all.find(x => x.arm === ref && x.task === r.task && x.rep === r.rep && x.valid);
      if (o) pairs.push({ task: r.task, d: r.costReported - o.costReported, base: o.costReported, now: r.costReported });
    }
    if (!pairs.length) { console.log(`\n${a} vs ${ref}: no task finished validly in both arms`); continue; }
    const tot = pairs.reduce((x, p) => x + p.base, 0), now = pairs.reduce((x, p) => x + p.now, 0);
    console.log(`\n${a} vs ${ref}: ${pairs.length} paired task(s), $${tot.toFixed(2)} -> $${now.toFixed(2)} (${((now / tot - 1) * 100).toFixed(1)}%)`);
    for (const p of pairs) console.log(`   ${p.task}: $${p.base.toFixed(2)} -> $${p.now.toFixed(2)} (${((p.now / p.base - 1) * 100).toFixed(1)}%)`);
    if (boot && pairs.length > 1) {
      const sims = [];
      for (let i = 0; i < 2000; i++) {
        let b = 0, n = 0;
        for (let k = 0; k < pairs.length; k++) { const p = pairs[(Math.random() * pairs.length) | 0]; b += p.base; n += p.now; }
        sims.push(n / b - 1);
      }
      sims.sort((x, y) => x - y);
      console.log(`   spread (90% of 2000 resamples of ${pairs.length} tasks, not a p-value): ${(sims[100] * 100).toFixed(1)}% .. ${(sims[1900] * 100).toFixed(1)}%`);
    }
  }
  if (invalid.length) {
    console.log(`\n${invalid.length} INVALID, in no figure above:`);
    for (const r of invalid) console.log(`   ${r.id}: ${r.invalidReason}`);
  }
  console.log();
}

// ---- main ----
const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = n => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : (rest[i + 1] || true); };
const has = n => rest.includes(`--${n}`);

if (cmd === 'run') {
  const spec = readJson(arg);
  const only = flag('only') ? String(flag('only')).split(',') : spec.tasks;
  const armNames = flag('arms') ? String(flag('arms')).split(',') : Object.keys(spec.arms);
  const reps = Number(flag('reps') || spec.reps || 1);
  const dry = has('dry');
  const tasks = only.map(id => taskOf(path.resolve(ROOT, spec.tasksDir), id));
  console.error(`${spec.tag}: ${tasks.length} task(s) x ${armNames.length} arm(s) x ${reps} rep(s) = ${tasks.length * armNames.length * reps} sessions${dry ? ' (dry)' : ''}`);
  for (const t of tasks) console.error(`  task ${t.id} ${t.turns.length} prompts, hash ${t.hash}${t.check ? ', check.sh' : ', no check'}`);
  for (const a of armNames) if (!spec.arms[a]) throw new Error(`no such arm: ${a}`);
  const done = [];
  for (let rep = 0; rep < reps; rep++) for (const t of tasks) for (const a of armNames) {
    done.push(await runSession({ spec, task: t, armName: a, arm: spec.arms[a], rep, dry }));
  }
  if (dry) { console.log(JSON.stringify(done, null, 1)); process.exit(0); }
  report(spec.tag, { boot: has('boot') });
} else if (cmd === 'grade') {
  // Grade sessions already recorded, without running them again (Artemis called this a regrade): the
  // worktree and its diff are still on disk, so a judge added or changed later can be applied to work
  // already paid for. The row's `grade` is replaced and the ledger rewritten in place.
  const judge = String(flag('judge') || 'claude-opus-5-5');
  const all = rows(LEDGER);
  const pick = all.filter(r => r.tag === arg && (!flag('id') || r.id === flag('id')));
  if (!pick.length) { console.log(`no sessions recorded for ${arg}`); process.exit(0); }
  for (const r of pick) {
    if (!fs.existsSync(r.cwd)) { console.log(`${r.id}: worktree gone, cannot grade`); continue; }
    const t = taskOf(String(flag('tasks-dir') || taskDirOf(r)), r.task);
    const v = await grade({ task: t, cwd: r.cwd, judge });
    r.grade = v;
    console.log(`${r.id}: ${v ? (v.error ? `JUDGE FAILED ${v.error}` : `${v.essentialMet}/${v.essentialOf} essential, ${v.met}/${v.of} all, pass=${v.pass} ($${(v.costUsd || 0).toFixed(2)})`) : 'no criteria'}`);
  }
  fs.writeFileSync(LEDGER, all.map(r => JSON.stringify(r)).join('\n') + '\n');
  report(arg);
} else if (cmd === 'report') {
  report(arg, { boot: has('boot') });
} else if (cmd === 'ledger') {
  const all = fs.existsSync(LEDGER) ? rows(LEDGER) : [];
  const f = flag('tag') ? all.filter(r => r.tag === flag('tag')) : all;
  for (const r of f) console.log(`${r.at} ${r.tag} ${r.id} ${r.valid ? 'valid  ' : 'INVALID'} $${(r.costReported || 0).toFixed(2)} ${r.invalidReason || r.outcome || ''}`);
  console.log(`\n${f.length} sessions, ${f.filter(r => r.valid).length} valid, $${f.reduce((a, r) => a + (r.costReported || 0), 0).toFixed(2)}`);
} else {
  console.log(`bench: run paired agent sessions, record them, compare the arms.

  node bench/bench.mjs run <spec.json> [--only t1,t2] [--arms a,b] [--reps n] [--boot] [--dry]
  node bench/bench.mjs grade <tag> [--id <session>] [--judge <model>] [--tasks-dir <dir>]
  node bench/bench.mjs report <tag> [--boot]
  node bench/bench.mjs ledger [--tag <tag>]

The ledger is bench/ledger.jsonl, one line per session, committed. Runs are under bench/runs/ (ignored).
'run' spends model tokens; '--dry' starts nothing.`);
}

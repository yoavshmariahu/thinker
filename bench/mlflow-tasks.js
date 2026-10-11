#!/usr/bin/env node
// mlflow benchmark tasks with executable oracles (bench/MEASUREMENT.md).
//
//   node bench/mlflow-tasks.js build <prs.json> [--base sha] [--max n]
//       → bench/tasks/mlflow.json: one task per merged PR after the base that changed core Python
//         code and its tests; the gold diff saved under bench/data/mlflow/, the PR's test files as
//         the oracle, and a pytest command for them. Selection is deterministic: candidates sorted by
//         sha256("mlflow-2026-10-11:<pr>").
//   node bench/mlflow-tasks.js preflight [--only id,id]
//       → for each task, in a worktree of bench/repos/mlflow at the base: apply only the test files
//         from the gold diff and run them (must fail), then apply the whole diff and run them (must
//         pass). Records failToPass, the kind of failure at base (assertion = behavioural; import,
//         attribute or name error = the test names symbols only the gold patch defines), and the
//         seconds the tests take. Tasks that are not fail-to-pass are dropped from the file.
//
// The venv: bench/repos/mlflow-venv (python -m venv; pip install -e bench/repos/mlflow plus
// requirements/test-requirements.txt and tests/resources/mlflow-test-plugin). Tests run with
// PYTHONPATH=<worktree> so `import mlflow` resolves to the worktree, not the editable install.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = k => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
// --clone <dir under bench/repos> and --out <name> select a second clone at another base and its
// own task file (mlflow-b2: a later base, the larger changes); gold diffs are shared by PR number.
const REPO = path.join(HERE, 'repos', flag('clone') || 'mlflow');
const VENV = path.join(HERE, 'repos', 'mlflow-venv');
const DATA = path.join(HERE, 'data', 'mlflow');
const TASKS = path.join(HERE, 'tasks', `${flag('out') || 'mlflow'}.json`);
const PY = path.join(VENV, 'bin', 'python');
const SLUG = 'mlflow/mlflow';

const isTest = p => /^tests\//.test(p);
// Core Python areas whose tests run without optional ML or vendor packages.
const CORE_AREAS = ['mlflow/store', 'mlflow/utils', 'mlflow/entities', 'mlflow/server', 'mlflow/tracing', 'mlflow/data', 'mlflow/models', 'mlflow/types', 'mlflow/cli', 'mlflow/artifacts', 'mlflow/tracking', 'mlflow/gateway', 'mlflow/genai', 'mlflow/metrics', 'mlflow/prompt', 'mlflow/environment_variables.py', 'mlflow/exceptions.py'];
const isCore = p => CORE_AREAS.some(a => p === a || p.startsWith(a + '/')) && !/\.(md|rst|json|yaml|yml|txt|proto)$/.test(p) && !/_pb2|\/protos\//.test(p);
const SKIP_TITLE = /^(Update version|Cherry-pick|Bump|Revert|\[MLflow\] Update changelog|Update CHANGELOG)/i;
const PRE = 'Implement the following change in this repository. Do not install dependencies or run the full test suite; run the tests relevant to your change if you want to. Make the code change (and adjust or add a test if it is natural), then summarize what you changed and why.\n\n';

const sh = (c, opts = {}) => spawnSync('sh', ['-c', c], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });

function build() {
  const prs = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const base = flag('base') || 'c63fb454c7e1';
  const baseDate = execFileSync('git', ['show', '-s', '--format=%cI', base], { cwd: REPO, encoding: 'utf8' }).trim();
  const max = Number(flag('max')) || 30;
  // --hard: only the larger changes, at least 120 lines or two source files
  const hard = !!flag('hard');
  const cands = prs.filter(p => {
    const f = p.files.map(x => x.path), t = f.filter(isTest), s = f.filter(isCore), loc = p.additions + p.deletions;
    return p.mergedAt > baseDate && t.length >= 1 && s.length >= 1 && s.length <= 8 && loc >= 15 && loc <= 900 && !SKIP_TITLE.test(p.title) && f.every(x => isTest(x) || isCore(x) || /^docs\//.test(x))
      && (!hard || loc >= 120 || s.length >= 2);
  });
  const rank = p => createHash('sha256').update(`mlflow-2026-10-11:${p.number}`).digest('hex').slice(0, 8);
  cands.sort((a, b) => rank(a).localeCompare(rank(b)));
  fs.mkdirSync(DATA, { recursive: true });
  // a rebuild keeps what an earlier preflight established: its verdict per task, and the dropped list
  const prev = fs.existsSync(TASKS) ? JSON.parse(fs.readFileSync(TASKS, 'utf8')) : { tasks: [], dropped: [] };
  const prevById = new Map(prev.tasks.map(t => [t.id, t]));
  const droppedIds = new Set((prev.dropped || []).map(d => d.id));
  const tasks = [];
  for (const p of cands.slice(0, max)) {
    if (droppedIds.has(`PR${p.number}`)) continue;
    const diffPath = path.join(DATA, `PR${p.number}.diff`);
    if (!fs.existsSync(diffPath)) fs.writeFileSync(diffPath, execFileSync('gh', ['pr', 'diff', String(p.number), '-R', SLUG], { encoding: 'utf8', maxBuffer: 1 << 26 }));
    const files = p.files.map(x => x.path);
    const testFiles = files.filter(isTest);
    tasks.push({
      id: `PR${p.number}`, area: (files.filter(isCore)[0] || '').split('/').slice(0, 2).join('/'), type: 'change',
      prompt: PRE + (p.body || p.title).trim(), goldTitle: p.title, goldFiles: files, goldDiff: path.relative(path.join(HERE, '..'), diffPath),
      testFiles, testCmd: `PYTHONPATH=. ${PY} -m pytest -q -x -p no:cacheprovider ${testFiles.map(f => `'${f}'`).join(' ')}`,
      mergeCommit: p.mergeCommit?.oid, mergedAt: p.mergedAt, loc: p.additions + p.deletions,
      ...(prevById.get(`PR${p.number}`)?.preflight ? { preflight: prevById.get(`PR${p.number}`).preflight } : {}),
    });
  }
  fs.writeFileSync(TASKS, JSON.stringify({ repo: SLUG, base, baseDate, builtAt: new Date().toISOString(), tasks, dropped: prev.dropped || [] }, null, 2) + '\n');
  console.log(`${cands.length} candidates after ${baseDate}; wrote ${tasks.length} tasks to ${path.relative(process.cwd(), TASKS)}`);
}

// Only the hunks of the gold diff that touch test files.
const testHunks = (diff, testFiles) => diff.split(/^(?=diff --git )/m).filter(h => { const m = h.match(/^diff --git a\/(\S+) b\/(\S+)/); return m && testFiles.includes(m[2]); }).join('');

function preflight() {
  const spec = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
  const only = flag('only') ? String(flag('only')).split(',') : null;
  const kept = [];
  for (const t of spec.tasks) {
    if ((only && !only.includes(t.id)) || (t.preflight && !flag('force'))) { kept.push(t); continue; }
    const wt = path.join(HERE, 'worktrees', `mlflow-preflight-${t.id}`);
    sh(`git -C '${REPO}' worktree remove --force '${wt}' 2>/dev/null; rm -rf '${wt}'`);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, spec.base], { cwd: REPO });
    const diff = fs.readFileSync(path.join(HERE, '..', t.goldDiff), 'utf8');
    const run = () => { const t0 = Date.now(); const r = sh(t.testCmd, { cwd: wt, timeout: 900_000 }); return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), secs: (Date.now() - t0) / 1000 }; };
    let result = {};
    try {
      const th = testHunks(diff, t.testFiles);
      const a1 = spawnSync('git', ['apply', '--3way', '-'], { cwd: wt, input: th, encoding: 'utf8' });
      if (a1.status !== 0) throw new Error('test hunks do not apply: ' + a1.stderr.slice(0, 200));
      const atBase = run();
      const kind = atBase.ok ? 'passes-at-base' : /ImportError|AttributeError|NameError|cannot import|has no attribute|ModuleNotFoundError/.test(atBase.out) ? 'symbol' : /AssertionError|assert |Failed:|DID NOT RAISE|Error:/.test(atBase.out) ? 'behaviour' : 'other';
      sh(`git -C '${wt}' checkout -q -- . && git -C '${wt}' clean -fdq`);
      const a2 = spawnSync('git', ['apply', '--3way', '-'], { cwd: wt, input: diff, encoding: 'utf8' });
      if (a2.status !== 0) throw new Error('gold diff does not apply: ' + a2.stderr.slice(0, 200));
      const withGold = run();
      result = { failToPass: !atBase.ok && withGold.ok, baseKind: kind, testNeedsGoldSymbols: kind === 'symbol', secs: Math.round(withGold.secs), baseTail: atBase.out.slice(-600), goldTail: withGold.ok ? '' : withGold.out.slice(-600) };
    } catch (e) { result = { failToPass: false, error: e.message }; }
    sh(`git -C '${REPO}' worktree remove --force '${wt}'`);
    console.log(`${t.id} ${result.failToPass ? 'OK' : 'DROP'} ${result.baseKind || ''} ${result.secs != null ? result.secs + 's' : ''} ${result.error || ''} | ${t.goldTitle.slice(0, 60)}`);
    if (!result.failToPass && !result.error) console.log('   base: ' + (result.baseTail || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300) + (result.goldTail ? '\n   gold: ' + result.goldTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300) : ''));
    if (result.failToPass) kept.push({ ...t, preflight: { baseKind: result.baseKind, testNeedsGoldSymbols: result.testNeedsGoldSymbols, secs: result.secs } });
    else spec.dropped = [...(spec.dropped || []), { id: t.id, ...result, baseTail: undefined, goldTail: undefined }];
  }
  spec.tasks = kept;
  fs.writeFileSync(TASKS, JSON.stringify(spec, null, 2) + '\n');
  console.log(`kept ${kept.length} tasks`);
}

if (cmd === 'build') build(); else if (cmd === 'preflight') preflight(); else { console.error('usage: build <prs.json> | preflight'); process.exit(1); }

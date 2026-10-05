// Task-scoped, durable verification runs. Candidate programs execute only in Docker;
// the host process holds review credentials and writes evidence outside the container.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { review, collectChange, makeReader } from './review.js';
import { gateIntegrity } from './review-integrity.js';
import { createSnapshot, snapshotTree, readAt, git, digest, materializeSnapshot, standaloneGit } from './verification-snapshot.js';
import { normalizeFailures } from './verification-failures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = '.thinker/verification.json';
const engineDigest = () => digest(['verification-v1', ...['review.js', 'review-integrity.js', 'verification.js', 'verification-snapshot.js', 'verification-worker.js', 'verification-reporter.js', 'verification-failures.js'].map(f => fs.readFileSync(path.join(HERE, f), 'utf8'))]);
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const directory = (repo, id) => { if (!uuid(id)) throw new Error('Invalid verification run id'); return path.join(repo, '.thinker/local/reviews', id); };
const writeJson = (file, value) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); };
const save = (repo, run) => writeJson(path.join(directory(repo, run.id), 'run.json'), run);

export function taskContext(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('task must be an object');
  const str = (v, max = 4000) => typeof v === 'string' ? v.slice(0, max) : '';
  const list = v => Array.isArray(v) ? v.slice(0, 30).map(x => str(x)).filter(Boolean) : [];
  return { request: str(value.request, 12000), source: 'caller-provided',
    criteria: (Array.isArray(value.criteria) ? value.criteria : []).slice(0, 30).map(c => ({ text: str(c.text), source: c.source === 'user' ? 'user-attributed-by-caller' : 'agent-interpretation', checks: list(c.checks) })).filter(c => c.text),
    intendedChanges: list(value.intendedChanges), rationale: str(value.rationale), questions: list(value.questions) };
}

export function parseContract(text) {
  if (!text) throw new Error(`No ${CONTRACT} at the trusted base; commit a verification contract before running required checks.`);
  let c; try { c = JSON.parse(text); } catch { throw new Error('Invalid verification contract JSON'); }
  if (!c || c.version !== 1 || !/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(c.image || '')) throw new Error('Contract version 1 requires a Docker image pinned by sha256 digest');
  if (Object.keys(c).some(k => !['version', 'image', 'platform', 'network', 'setup', 'checks', 'resources'].includes(k))) throw new Error('Unsupported verification contract field');
  if (!Array.isArray(c.checks) || !c.checks.length || c.checks.length > 30) throw new Error('Contract requires 1–30 checks');
  if (c.network !== undefined && !['none', 'bridge'].includes(c.network)) throw new Error('Contract network must be none or bridge');
  if (c.platform !== undefined && !['linux/amd64', 'linux/arm64'].includes(c.platform)) throw new Error('Contract platform must be linux/amd64 or linux/arm64');
  const ids = new Set();
  for (const x of c.checks) {
    if (!x || Object.keys(x).some(k => !['id', 'command', 'reporter', 'timeoutSeconds'].includes(k))) throw new Error('Unsupported check definition');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.id || '') || ids.has(x.id)) throw new Error('Check ids must be unique lowercase names');
    ids.add(x.id);
    if (typeof x.command !== 'string' || !x.command.trim() || x.command.length > 8000) throw new Error(`Check ${x.id} requires a command`);
    if (x.reporter !== undefined && !['node', 'exit-code'].includes(x.reporter)) throw new Error(`Unsupported reporter for ${x.id}`);
    if (x.timeoutSeconds !== undefined && (!Number.isInteger(x.timeoutSeconds) || x.timeoutSeconds < 1 || x.timeoutSeconds > 3600)) throw new Error('Check timeout must be 1–3600 seconds');
  }
  if (c.setup !== undefined && (typeof c.setup !== 'string' || c.setup.length > 8000)) throw new Error('setup must be a command string');
  const resources = { memoryMiB: 2048, workspaceMiB: 2048, tempMiB: 512, homeMiB: 256, ...c.resources };
  for (const [key, value] of Object.entries(resources)) if (!['memoryMiB', 'workspaceMiB', 'tempMiB', 'homeMiB'].includes(key) || !Number.isInteger(value) || value < 64 || value > 65536) throw new Error('Resource limits must be supported MiB fields between 64 and 65536');
  return { version: 1, image: c.image, platform: c.platform || 'linux/amd64', network: c.network || 'none', setup: c.setup || '', resources, checks: c.checks.map(x => ({ id: x.id, command: x.command, reporter: x.reporter || 'exit-code', timeoutSeconds: x.timeoutSeconds || 600 })) };
}

export function prepareVerification(store, options = {}) {
  const task = taskContext(options.task);
  let previous = null;
  if (options.previous) previous = readVerification(store.repo, options.previous, { current: false });
  const snapshot = createSnapshot(store.repo, options);
  const contractText = readAt(store.repo, snapshot.target, CONTRACT);
  let contract = null, contractError = null;
  try { contract = parseContract(contractText); } catch (e) { contractError = e.message; }
  // Freeze exact content rather than trusting mutable local note ids.
  const notes = JSON.parse(JSON.stringify(store.list()));
  const config = store.config();
  const id = crypto.randomUUID(), dir = directory(store.repo, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  git(store.repo, ['update-ref', `refs/thinker/reviews/${id}`, snapshot.commit]);
  const run = { version: 1, id, previous: previous?.id || null, status: 'queued', createdAt: new Date().toISOString(), snapshot,
    task: task || previous?.task || null, contract, contractError,
    identity: { tree: snapshot.tree, target: snapshot.target, base: snapshot.base, contract: digest(contractText || ''), knowledge: digest(notes), environment: contract?.image || null, platform: contract?.platform || null,
      engine: engineDigest(), model: options.model || config.reviewModel || 'sonnet', configuration: digest(config), task: digest(task || previous?.task || null) },
    trust: 'local-runner', ciAccepted: false, checks: [], review: null, integrity: null,
    limitations: ['Evidence covers a branch snapshot, not a synthetic merge candidate.', 'Local receipts are not CI attestations.', 'Ignored files are excluded from the snapshot.', 'Task criteria and check links are caller-provided; passing linked checks alone does not prove task completion.'] };
  writeJson(path.join(dir, 'inputs.json'), { notes, config, options: { model: options.model, dry: !!options.dry } });
  save(store.repo, run);
  return run;
}

export async function startVerification(store, options = {}) {
  const run = prepareVerification(store, options);
  const log = fs.openSync(path.join(directory(store.repo, run.id), 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(HERE, 'verification-worker.js'), store.repo, run.id], {
      detached: true, stdio: ['ignore', log, log], env: { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off' },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (e) { run.status = 'incomplete'; run.error = `Could not start worker: ${e.message}`; save(store.repo, run); }
  finally { fs.closeSync(log); }
  return run;
}

export function readVerification(repo, id, { current = true } = {}) {
  const run = JSON.parse(fs.readFileSync(path.join(directory(repo, id), 'run.json'), 'utf8'));
  if (['queued', 'running'].includes(run.status) && Date.now() - Date.parse(run.heartbeat || run.createdAt) > 120000) {
    run.status = 'incomplete'; run.error = 'Worker heartbeat expired; unfinished checks are not evidence of success.';
  }
  if (current) {
    try {
      const tree = snapshotTree(repo, run.snapshot.scope === 'commit' ? { ref: run.snapshot.commit } : { staged: run.snapshot.scope === 'index' });
      const target = git(repo, ['rev-parse', '--verify', '--end-of-options', `${run.snapshot.targetRef}^{commit}`]);
      const store = new Store(repo, { readonly: true });
      const reasons = [...(tree !== run.snapshot.tree ? ['Candidate content changed'] : []), ...(target !== run.snapshot.target ? ['Target/base reference moved'] : []),
        ...(digest(store.list()) !== run.identity.knowledge ? ['Review knowledge changed'] : []), ...(digest(store.config()) !== run.identity.configuration ? ['Review configuration changed'] : []),
        ...(engineDigest() !== run.identity.engine ? ['Verification engine changed'] : [])];
      run.freshness = { status: reasons.length ? 'superseded' : 'current', currentTree: tree, currentTarget: target, reasons };
    } catch (e) { run.freshness = { status: 'unknown', reason: e.message }; }
  }
  run.reportPath = path.join(directory(repo, id), 'report.md');
  return run;
}

export function runConclusion(run) {
  if (run.checks.some(c => c.status === 'failed') || run.review?.counts?.error) return 'failed';
  if (run.error || run.contractError || !run.contract || run.checks.length !== run.contract.checks.length || run.checks.some(c => c.status !== 'passed') || !run.review || run.review.incomplete || run.review.errors?.length) return 'incomplete';
  if (run.integrity?.findings.length || run.review?.counts?.warning || run.checks.some(c => c.skippedTests?.length)) return 'needs-review';
  return 'passed';
}

// Each check has a fresh writable container filesystem, no host credentials, no
// Docker socket, and only read-only candidate/reporter mounts. Setup repeats per check.
export function dockerArguments(run, check, checkout, name) {
  const c = run.contract;
  const script = `cp -R /input/. /workspace/\ncd /workspace\n${c.setup ? `(${c.setup}) || exit 125\n` : ''}${check.command}`;
  return ['run', '--rm', '--name', name, '--platform', c.platform, '--network', c.network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', `${c.resources.memoryMiB}m`, '--cpus', '2',
    '--read-only', '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${c.resources.tempMiB}m`, '--tmpfs', `/workspace:rw,exec,nosuid,nodev,size=${c.resources.workspaceMiB}m`, '--tmpfs', `/root:rw,exec,nosuid,nodev,size=${c.resources.homeMiB}m`,
    '--mount', `type=bind,src=${checkout},dst=/input,readonly`, '--mount', `type=bind,src=${path.join(HERE, 'verification-reporter.js')},dst=/thinker/reporter.mjs,readonly`,
    '-e', 'THINKER_TEST=1', '-e', 'THINKER_TELEMETRY=off', '-e', 'CI=1', '--workdir', '/workspace', '--entrypoint', '/bin/sh', c.image, '-ec', script];
}

export async function executeCheck(run, check, checkout, dir, onProgress = () => {}) {
  const artifact = path.join(dir, `${check.id}.log`), name = `thinker-${run.id}-${check.id}`;
  const fd = fs.openSync(artifact, 'w', 0o600);
  let output = '', truncated = false, error = null, bytes = 0, lastProgress = 0;
  const result = await new Promise(resolve => {
    const child = spawn('docker', dockerArguments(run, check, checkout, name), { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { error = 'Check timed out'; child.kill('SIGKILL'); }, check.timeoutSeconds * 1000);
    const onData = data => {
      bytes += data.length;
      if (bytes <= 16 * 1024 * 1024) {
        fs.writeSync(fd, data); output += data.toString();
        if (check.reporter === 'node' && Date.now() - lastProgress > 500) {
          lastProgress = Date.now();
          const completeLines = output.slice(0, output.lastIndexOf('\n') + 1);
          const partial = normalizeFailures(completeLines, check, { exitCode: 0, snapshot: run.identity, artifact });
          onProgress({ status: 'running', failures: partial.failures, passedTests: partial.passedTests, skippedTests: partial.skippedTests, artifact });
        }
      } else { truncated = true; error = 'Check output exceeded 16 MiB'; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { error = e.message; });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  fs.closeSync(fd);
  if (error) await new Promise(resolve => { const p = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }); p.on('error', resolve); p.on('close', resolve); });
  if ([125, 126, 127].includes(result) && !error) error = `Runner or setup failed (exit ${result}); required check did not complete.`;
  return normalizeFailures(output, check, { exitCode: result, error, snapshot: run.identity, artifact, truncated });
}

export async function executeVerification(repo, id, { runReview = review, runner = executeCheck } = {}) {
  const run = readVerification(repo, id, { current: false }), dir = directory(repo, id);
  if (run.status !== 'queued') throw new Error('Verification run is not queued');
  // Atomic claim prevents duplicate workers from overwriting evidence.
  const lock = fs.openSync(path.join(dir, 'worker.lock'), 'wx'); fs.closeSync(lock);
  const { notes, config, options } = JSON.parse(fs.readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
  run.status = 'running'; run.startedAt = new Date().toISOString();
  const persist = () => { run.heartbeat = new Date().toISOString(); save(repo, run); fs.writeFileSync(path.join(dir, 'report.md'), renderVerification(run), { mode: 0o600 }); };
  persist(); const heartbeat = setInterval(persist, 15000);
  const checkout = path.join(dir, 'checkout'); let added = false;
  try {
    const scope = { base: run.snapshot.base, head: run.snapshot.commit, label: `snapshot ${run.snapshot.tree.slice(0, 12)}` };
    const change = collectChange(repo, scope), reader = makeReader(repo, scope);
    run.integrity = gateIntegrity(change, reader); persist();
    // Bound review to frozen note/config content. All code reads use the snapshot commit.
    const store = new Store(repo);
    store.list = () => structuredClone(notes); store.config = () => structuredClone(config);
    const assessment = (async () => {
      try { run.review = await runReview(store, { scope, model: run.identity.model, task: run.task, dry: options.dry }); if (options.dry) run.review.incomplete = true; }
      catch (e) { run.review = { incomplete: true, errors: [{ error: e.message }] }; }
      persist();
    })();
    try {
      if (run.contract && !options.dry) {
        fs.mkdirSync(checkout, { recursive: true, mode: 0o700 }); added = true;
        materializeSnapshot(repo, run.snapshot.tree, checkout);
        // Git metadata for the container is standalone: nothing in it points at the host.
        if (standaloneGit(repo, run.id, checkout) !== run.snapshot.commit) throw new Error('Snapshot checkout does not carry the snapshot commit');
        for (const check of run.contract.checks) {
          const result = { id: check.id, command: check.command, status: 'running', startedAt: new Date().toISOString() };
          run.checks.push(result); persist();
          try { Object.assign(result, await runner(run, check, checkout, dir, progress => { Object.assign(result, progress); persist(); })); }
          catch (e) { Object.assign(result, { status: 'incomplete', error: e.message, failures: [] }); }
          result.completedAt = new Date().toISOString(); persist();
        }
      }
    } finally { await assessment; }
    run.status = runConclusion(run);
    if (run.previous) {
      const prior = readVerification(repo, run.previous, { current: false });
      run.failureChanges = (prior.checks || []).flatMap(c => (c.failures || []).map(f => {
        const next = run.checks.find(x => x.id === c.id);
        const reproduced = next?.failures?.some(n => n.id === f.id);
        const passed = f.kind === 'test' && next?.status === 'passed' && next.passedTests?.some(t => t.name === f.test && t.file === f.location?.file);
        const changedCoverage = next?.command !== c.command || run.integrity?.findings.some(g => g.file === f.location?.file?.replace(/^\/workspace\//, '') || g.rule === 'gate-definition-changed');
        return { id: f.id, test: f.test, check: c.id, status: reproduced ? 'still-failing' : passed ? changedCoverage ? 'coverage-changed' : 'resolved' : 'not-rerun' };
      }));
    }
  } catch (e) { run.status = 'incomplete'; run.error = e.message; }
  finally {
    clearInterval(heartbeat);
    if (added) { try { fs.rmSync(checkout, { recursive: true, force: true }); } catch (e) { run.cleanupError = e.message; } }
    run.completedAt = new Date().toISOString(); persist();
  }
  return run;
}

const clean = v => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>|`]/g, c => ({ '<': '&lt;', '>': '&gt;', '|': '\\|', '`': '\\`' })[c]);
export function renderVerification(r, { portable = false } = {}) {
  const lines = [`# Verification: ${r.freshness?.status === 'superseded' ? 'superseded' : r.status}`, '',
    `Run: ${r.id}`, `Created: ${r.createdAt}${r.completedAt ? '; completed: ' + r.completedAt : ''}`, `Candidate: ${r.snapshot.tree} · target: ${r.snapshot.target}`, `Evidence: ${r.trust}; CI acceptance: ${r.ciAccepted ? 'yes' : 'not established'}`, ''];
  if (r.freshness?.reasons?.length) lines.push(`Evidence outdated: ${r.freshness.reasons.join('; ')}`, '');
  if (r.task) {
    lines.push(`**Requested outcome:** ${clean(r.task.request)}`, '', '| Acceptance criterion | Source | Linked execution evidence |', '|---|---|---|');
    for (const c of r.task.criteria) lines.push(`| ${clean(c.text)} | ${clean(c.source)} | ${c.checks.map(id => `${clean(id)}: ${r.checks.find(x => x.id === id)?.status || 'not run'}`).join('; ') || 'No linked check'} |`);
    if (r.task.intendedChanges.length) lines.push('', `Intended changes: ${r.task.intendedChanges.map(clean).join('; ')}`);
    if (r.task.rationale) lines.push('', `Agent rationale: ${clean(r.task.rationale)}`);
    if (r.task.questions.length) lines.push('', `Open questions: ${r.task.questions.map(clean).join('; ')}`);
    lines.push('', 'Criteria and links are caller-provided. Test results support assessment; they do not prove task completion.');
  }
  lines.push('', '## Executed checks', '', '| Check | Result | Evidence |', '|---|---|---|');
  for (const c of r.checks) {
    lines.push(`| ${c.id} | ${c.status} | ${c.passedTests?.length || 0} test passes; ${c.skippedTests?.length || 0} skipped/todo |`);
    if (c.error || c.reportError) lines.push('', clean(c.error || c.reportError));
    for (const f of c.failures || []) lines.push('', `**${clean(f.test || c.id)}:** ${clean(f.message)}`, `- Location: ${clean(f.location?.file || '')}${f.location?.line ? ':' + f.location.line : ''}`, `- Expected: ${clean(JSON.stringify(f.expected))}; actual: ${clean(JSON.stringify(f.actual))}`, `- Reproduce: \`${clean(f.reproduction?.command)}\` (not reduced; reproduction not confirmed)`, '- Flake classification: unknown. Cause: not established.');
    if (c.artifact) lines.push('', portable ? `Full output: ${c.id}.log (stored locally; not uploaded).` : `[Full output for ${c.id}](${encodeURI(c.artifact)})`);
  }
  if (!r.checks.length) lines.push('| Required checks | Not run | No execution evidence |');
  lines.push('', '## Gate integrity', '', r.integrity?.findings.length ? 'Needs human review:' : r.integrity ? 'No pattern-based weakening signals found.' : 'Not assessed.');
  for (const f of r.integrity?.findings || []) lines.push('', `- **${clean(f.rule)}** — ${clean(f.file)}${f.line ? ':' + f.line : ''}: ${clean(f.message)} (${f.certainty})`, `  Before: ${clean(f.before) || '(none)'}; after: ${clean(f.after) || '(none)'}`);
  lines.push('', '## Code assessment', '');
  if (!r.review) lines.push('Not completed.');
  else {
    lines.push(`${r.review.counts?.error || 0} errors; ${r.review.counts?.warning || 0} warnings. ${r.review.incomplete || r.review.errors?.length ? 'Assessment incomplete.' : 'No finding is not proof of correctness.'}`);
    for (const f of r.review.findings || []) lines.push(`- ${clean(f.file)}:${f.line || 0} — ${clean(f.message)} Evidence: ${clean(f.evidence)}`);
    for (const e of r.review.errors || []) lines.push(`- ${clean(e.error)}`);
    if (r.review.notes?.skipped) lines.push(`- ${r.review.notes.skipped} consulted notes were outside the assessment limit.`);
    if (r.review.notes?.uncovered?.length) lines.push(`- No cached knowledge rests on: ${r.review.notes.uncovered.map(clean).join(', ')}.`);
    if (r.review.notes?.staleBefore?.length) lines.push(`- ${r.review.notes.staleBefore.length} consulted notes were already stale before the change.`);
  }
  if (r.failureChanges?.length) lines.push('', '## Earlier failures', '', ...r.failureChanges.map(f => `- ${clean(f.test || f.id)}: ${f.status}`));
  lines.push('', '## Remaining limitations', '', ...[r.error, r.contractError, r.integrity?.limitation, ...r.limitations].filter(Boolean).map(s => `- ${clean(s)}`));
  lines.push('', `Environment: ${r.identity.environment || 'not configured'} (${r.identity.platform || 'unknown platform'})`, `Knowledge: ${r.identity.knowledge}`, `Contract: ${r.identity.contract}`, '');
  return lines.join('\n');
}

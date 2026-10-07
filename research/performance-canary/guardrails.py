"""Fail-closed guards shared by performance setup, solvers and evaluators (POSIX)."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from pr_cache import CACHE_SOURCE, CACHE_BUILD_PATH, validate_pr_manifest
import wiring

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# Every cohort this harness knows how to drive. A run freezes the subset it compares, since a
# cohort left out of the comparison must not be required to have a cache before the others may code.
MODELS = {'opus': 'claude-opus-5-5', 'sol': 'gpt-6.1-sol', 'gemini': 'gemini-3.8-flash-high'}
SOURCES = ['run.py', 'pipeline.py', 'memory.mjs', 'verify.py', 'guardrails.py', 'thinker_bench_pytest.py', 'prepare.py', 'freeze.py', 'pr_cache.py', 'collect_prs.py', 'frozen_gh.py', 'wire.mjs', 'wiring.py']
GUIDANCE = ROOT / 'src/cache-guidance.js'
WIRING_MODE = 'live-mcp-hook'


class GuardError(RuntimeError):
    pass


def read(file):
    return json.loads(Path(file).read_text())


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def source_hashes():
    files = [HERE / p for p in SOURCES] + list((ROOT / 'src').rglob('*.js'))
    return {str(p): digest(p) for p in files}


def stop(out, reason):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        with (out / 'STOPPED.json').open('x') as f:
            json.dump({'status': 'stopped', 'reason': str(reason), 'at': time.time()}, f)
    except FileExistsError:
        pass


def require_running(out):
    if os.environ.get('THINKER_TEST') != '1':
        raise GuardError('THINKER_TEST=1 required')
    if (Path(out) / 'STOPPED.json').exists():
        raise GuardError('Batch stopped; preserve artifacts and use a fresh run directory')


def run_dir():
    return Path(os.environ.get('THINKER_PERF_DIR', str(HERE))).resolve()


def validate_execution(out):
    require_running(out)
    if not Path(out).resolve().is_relative_to(ROOT):
        raise GuardError('Run output must stay inside the isolated worktree')
    if not (ROOT / '.git').is_file():
        raise GuardError('Use an isolated git worktree')
    e = read(Path(out) / 'execution.json')
    frozen = e.get('models')
    if (e.get('guardrailsVersion') != 3 or not isinstance(frozen, dict) or not frozen
            or any(MODELS.get(name) != model for name, model in frozen.items())
            or e.get('effort') != 'high' or e.get('fallback') is not False):
        raise GuardError('Missing or mismatched frozen model/effort protocol')
    # The thinker arm must receive the cache through the product's own transports (hooks, MCP server,
    # instruction file). Schema 2 pasted an offline retrieval into the prompt and is rejected here.
    wiring = e.get('wiring') or {}
    if wiring.get('mode') != WIRING_MODE or wiring.get('guidanceSha256') != digest(GUIDANCE):
        raise GuardError('Only live product wiring is permitted, and the guidance text is frozen')
    if e.get('tasksSha256') != digest(Path(out) / 'tasks.json'):
        raise GuardError('Task manifest changed')
    if e.get('cacheSource') != CACHE_SOURCE or e.get('cacheBuildPath') != CACHE_BUILD_PATH:
        raise GuardError('Only recent-PR cache builds are permitted; session distillation is forbidden')
    if e.get('prsSha256') != digest(Path(out) / 'prs.json'):
        raise GuardError('PR corpus changed')
    validate_pr_manifest(read(Path(out) / 'prs.json'), read(Path(out) / 'tasks.json'))
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if head != e.get('thinkerCommit'):
        raise GuardError('Thinker revision changed')
    expected = source_hashes()
    if e.get('sourceHashes') != expected:
        raise GuardError('Harness or model adapter changed after freezing')
    if not isinstance(e.get('agentSeconds'), int) or not 1 <= e['agentSeconds'] <= 1200:
        raise GuardError('Agent deadline must be 1..1200 seconds')
    return e


def checked_execution(out):
    try:
        return validate_execution(out)
    except Exception as error:
        stop(out, error)
        raise GuardError(str(error)) from error


def assert_preflight(out, tasks):
    for task in tasks:
        for arm in ['base', 'gold']:
            result = read(Path(out) / 'raw' / f"{task['id']}-verify-{arm}-validation.json")
            for kind in ['acceptance', 'module']:
                g = result.get(kind, {})
                if g.get('timeout') or g.get('errors') != 0 or not isinstance(g.get('passed'), int) or not isinstance(g.get('failures'), int):
                    raise GuardError(f'{task["id"]} {arm} {kind}: invalid preflight')
                if arm == 'base':
                    ok = g.get('returncode') == 1 and g['failures'] > 0
                else:
                    ok = g.get('returncode') == 0 and g['failures'] == 0 and g['passed'] > 0
                if not ok:
                    raise GuardError(f'{task["id"]} {arm} {kind}: expected real failing base and passing gold')


def cohorts(out):
    """The model cohorts this run froze, by name. Nothing outside them is built, gated or solved."""
    try:
        frozen = read(Path(out) / 'execution.json')['models']
    except Exception as error:
        raise GuardError(f'No frozen cohorts to gate: {error}') from error
    if not isinstance(frozen, dict) or not frozen or any(MODELS.get(k) != v for k, v in frozen.items()):
        raise GuardError('Frozen cohorts must be a nonempty subset of the known models')
    return frozen


def assert_ready(out, tasks, models=None):
    """Validate all caches before either arm; do not trust counts or exit status alone."""
    out = Path(out)
    require_running(out)
    models = cohorts(out) if models is None else models
    if not tasks or not models:
        raise GuardError('Nonempty tasks and model cohorts required')
    assert_preflight(out, tasks)
    corpus = validate_pr_manifest(read(out / 'prs.json'), tasks)
    for model in models:
        for task in tasks:
            name = f'{task["id"]}-{model}'
            build = read(out / 'raw' / (name + '-pr-build.json'))
            if (build.get('setupError') or build.get('cacheBuildPath') != CACHE_BUILD_PATH
                    or build.get('cacheSource') != CACHE_SOURCE or build.get('valid') is not True
                    or build.get('model') != models[model] or build.get('effort') != 'high'
                    or build.get('prsSha256') != digest(out / 'prs.json')):
                raise GuardError(f'{name}: invalid PR cache provenance, model or build outcome')
            allowed = {f"{corpus['tasks'][task['id']]['repository']}#{p['number']}" for p in corpus['tasks'][task['id']]['prs']}
            processed = build.get('processedPrs', [])
            if not processed or not set(processed) <= allowed:
                raise GuardError(f'{name}: no valid PR mining receipt')
            retrieval = read(out / 'raw' / (name + '-thinker-retrieval.json'))
            hashes = read(out / 'raw' / (name + '-pr-note-hashes.json'))
            if retrieval.get('valid') is False or retrieval.get('error') or not hashes or retrieval.get('noteCount') != len(hashes) or not retrieval.get('text', '').strip() or not retrieval.get('included'):
                raise GuardError(f'{name}: empty cache or retrieval')
            ids = set()
            cache = out / 'state' / (name + '-thinker') / '.thinker'
            # Store.init migrates untracked legacy notes into local/notes. Serving
            # legitimately updates usage and staleness; the learned content stays frozen.
            target_dir = cache / 'local/notes'
            present = {p.name for p in target_dir.glob('*.json')}
            if (present < set(hashes) or any((cache / 'notes').glob('*.json'))
                    or any((cache / 'local/shared').glob('*.json'))):
                raise GuardError(f'{name}: unexpected cache inventory')
            # The wired arm is offered `remember`, so a finished run may have left a note of its own
            # in its private copy of the cache. That is the product behaving normally, not mined
            # knowledge: it is allowed only after that run completed, must be agent-authored, and is
            # never counted as cache content. Anything else is contamination.
            for filename in sorted(present - set(hashes)):
                if not (out / 'raw' / (name + '-thinker.json')).exists():
                    raise GuardError(f'{name}: note {filename} appeared before the run')
                if read(target_dir / filename).get('source', {}).get('type') != 'agent':
                    raise GuardError(f'{name}: unexpected note {filename} is not agent-authored')
            for filename, checksum in hashes.items():
                if Path(filename).name != filename or not filename.endswith('.json'):
                    raise GuardError('Invalid cache filename')
                source = out / 'raw' / (name + '-pr-notes') / filename
                target = target_dir / filename
                if digest(source) != checksum:
                    raise GuardError(f'{name}: cache hash mismatch')
                note = read(source)
                mutable = {'uses', 'lastUsed', 'servedIn', 'status', 'stale'}
                content = lambda n: {k: v for k, v in n.items() if k not in mutable}
                current = read(target)
                if current.get('status') not in ('fresh', 'stale') or content(current) != content(note):
                    raise GuardError(f'{name}: cache content mismatch')
                if not note.get('deps') or not note.get('body', '').strip() or note.get('status') != 'fresh':
                    raise GuardError(f'{name}: unusable note')
                provenance = note.get('source', {})
                if provenance.get('type') != 'pr' or provenance.get('ref') not in processed:
                    raise GuardError(f'{name}: note is not from the frozen PR corpus')
                ids.add(note['id'])
            if not set(retrieval['included']) <= ids:
                raise GuardError(f'{name}: retrieval references missing notes')
            # The baseline carries no cache and no wiring that could reach one.
            baseline = out / 'state' / (name + '-baseline')
            for leak in ['.thinker', '.mcp.json', '.claude/settings.local.json', '.codex/hooks.json']:
                if (baseline / leak).exists():
                    raise GuardError(f'{name}: baseline contaminated with {leak}')
            if (out / 'raw' / (name + '-baseline-wiring.json')).exists():
                raise GuardError(f'{name}: baseline must have no wiring receipt')


def checked_ready(out, tasks, models=None):
    try:
        assert_ready(out, tasks, models)
    except Exception as e:
        stop(out, e)
        raise GuardError(str(e)) from e


def assert_served_by_jev(out, name, checkout):
    """The arm must be ranked by Jev. A cross-encoder fallback is a failed run, not a cheaper result.

    memory.mjs holds the same rule for the offline preflight ("do not silently substitute another
    ranker"); live wiring moves serving into a child process, so it is checked from that log.
    """
    log = Path(checkout) / '.thinker/log.jsonl'
    if not log.exists():
        raise GuardError(f'{name}: no usage log, so nothing proves what served')
    served, lines = 0, [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    for row in lines:
        if row.get('op') in ('jev-error', 'ce-error'):
            raise GuardError(f'{name}: {row["op"]} during the run; ranking fell back')
        if row.get('op') != 'orient':
            continue
        if row.get('ce') is not None and row.get('jev') is None:
            raise GuardError(f'{name}: a serving was ranked by the cross-encoder, not Jev')
        served += 1 if row.get('jev') is not None else 0
    if not served:
        raise GuardError(f'{name}: no Jev-ranked serving recorded')
    return {'jevServings': served, 'logRows': len(lines)}


def checked_wiring(out, name, client, checkout):
    """Write and validate the thinker arm's wiring; a failure stops the batch like any other gate."""
    try:
        return wiring.wire(client, checkout, Path(out) / 'raw' / (name + '-wiring.json'), dict(os.environ))
    except Exception as error:
        stop(out, f'{name}: wiring {error}')
        raise GuardError(str(error)) from error


def isolated_env(base, wiring=False):
    """Isolate every child. `wiring` leaves the cache's own transports on for the thinker arm.

    Only the arm under measurement gets them: cache builds, evaluators and the baseline keep the
    server and hooks off. Holdout is pinned off either way, since a withheld session would read as
    a wired arm that happened to be served nothing.
    """
    env = dict(base)
    for key in ['THINKER_NOTES_DIR', 'THINKER_REPO', 'MAX_THINKING_TOKENS']:
        env.pop(key, None)
    env.update(THINKER_TEST='1', THINKER_TELEMETRY='off', THINKER_LOG='local',
               THINKER_NO_LEARN='1', THINKER_NO_AUTO_UPDATE='1', THINKER_HOLDOUT='off')
    if wiring:
        # The arm's own hooks are repo-scope, so they run under test mode while the machine's
        # user-scope hooks stay silent (src/commands/hooks.js:38). THINKER_MCP must be unset or
        # the server would offer no tools.
        for key in ['THINKER_MCP', 'THINKER_HOOKS']:
            env.pop(key, None)
        # Serving happens in the agent's own child process, where memory.mjs's in-process transport
        # cannot reach, and test mode would otherwise fall back to the cross-encoder in silence.
        # The seam is fail-closed and needs a personal key (src/jev.js:testNetworkAllowed).
        env.update(THINKER_JEV='on', THINKER_JEV_ALLOW_NETWORK='1')
    else:
        env.update(THINKER_HOOKS='off', THINKER_MCP='off')
    return env


def guarded_env(cwd, violation_file, base=None):
    return {**isolated_env(os.environ if base is None else base), 'THINKER_TEST': '1', 'THINKER_TELEMETRY': 'off', 'THINKER_LOG': 'local',
            'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'PYTEST_PLUGINS': 'thinker_bench_pytest',
            'PYTEST_ADDOPTS': '', 'PYTHONPATH': str(HERE) + os.pathsep + str(Path(cwd) / 'src'),
            'THINKER_BENCH_VIOLATION': str(Path(violation_file).resolve())}


def process_table():
    # lstart prevents a recycled PID from matching a previously seen descendant.
    data = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,lstart='], text=True)
    return {int(p[0]): (int(p[1]), ' '.join(p[2:])) for line in data.splitlines() if len(p := line.split()) >= 7}


def supervised(cmd, *, cwd, env, prefix, seconds, batch, input_text=None, heartbeat=1, allowed_codes=(0,), native_root=None, wiring=False):
    """Write stdout/stderr while running; bound wall time and clean up descendants."""
    require_running(batch)
    if os.name != 'posix' or not 0 < seconds <= 3600:
        raise GuardError('POSIX process supervision and bounded deadline required')
    process_table()  # Refuse unsupported process inspection before starting a child.
    prefix = Path(prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    stdout_path, stderr_path = Path(str(prefix) + '.events.jsonl'), Path(str(prefix) + '.stderr')
    state_path = Path(str(prefix) + '.process.json')
    # The agent's workspace sandbox must be able to write the violation marker.
    violation = Path(cwd).resolve() / '.benchmark-policy-violation.json'
    if violation.exists():
        stop(batch, 'Existing test-policy violation; use a fresh attempt')
        raise GuardError('Existing test-policy violation')
    env = {**isolated_env(env, wiring=wiring), 'THINKER_TEST': '1', 'THINKER_TELEMETRY': 'off', 'THINKER_LOG': 'local', 'THINKER_BENCH_VIOLATION': str(violation.resolve()), 'THINKER_PERF_SUPERVISED': '1'}
    native_root = Path(native_root) if native_root else None
    prior_sessions = set(native_root.iterdir()) if native_root and native_root.exists() else set()
    native_source = None
    native_dest = Path(str(prefix) + '.transcript.jsonl')
    def mirror_native():
        nonlocal native_source
        if native_root is None:
            return
        if native_source is None and native_root.exists():
            for directory in set(native_root.iterdir()) - prior_sessions:
                candidate = directory / '.system_generated/logs/transcript.jsonl'
                if candidate.is_file() and str(cwd) in candidate.read_text(errors='replace'):
                    native_source = candidate
                    break
        if native_source is not None:
            native_dest.write_bytes(native_source.read_bytes())

    start = time.monotonic()
    reason, proc, descendants, handlers = None, None, {}, {}

    def cancelled(signum, _frame):
        nonlocal reason
        reason = 'interrupted'

    def terminate(sig):
        if proc is None:
            return
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        table = process_table()
        for pid, born in descendants.items():
            if table.get(pid, (None, None))[1] == born:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass

    def snapshot(status):
        row = {'status': status, 'reason': reason, 'pid': proc.pid if proc else None,
               'wallMs': round((time.monotonic() - start) * 1000),
               'stdoutBytes': stdout_path.stat().st_size, 'stderrBytes': stderr_path.stat().st_size,
               'returncode': proc.poll() if proc else None,
               'nativeTraceBytes': native_dest.stat().st_size if native_dest.exists() else None}
        temp = Path(str(state_path) + '.tmp')
        temp.write_text(json.dumps(row))
        temp.replace(state_path)
        return row

    # Exclusive files prevent accidentally replacing a failed/incomplete attempt.
    with stdout_path.open('xb') as stdout, stderr_path.open('xb') as stderr, tempfile.TemporaryFile() as stdin:
        if input_text is not None:
            stdin.write(input_text.encode()); stdin.seek(0)
        try:
            for sig in [signal.SIGINT, signal.SIGTERM]:
                handlers[sig] = signal.signal(sig, cancelled)
            proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr, start_new_session=True)
            tick = 0
            while True:
                table = process_table()
                parents = {proc.pid} | {pid for pid, born in descendants.items() if table.get(pid, (None, None))[1] == born}
                while True:
                    children = {pid for pid, (ppid, _) in table.items() if ppid in parents}
                    if children <= parents:
                        break
                    parents |= children
                descendants.update({pid: table[pid][1] for pid in parents if pid != proc.pid and pid in table})
                if violation.exists():
                    reason = 'test-policy-violation'
                elif (Path(batch) / 'STOPPED.json').exists():
                    reason = 'batch-stopped'
                elif time.monotonic() - start >= seconds:
                    reason = 'timeout'
                if native_root and native_source is None and time.monotonic() - start > 60:
                    reason = 'native-trace-unavailable'
                if reason or proc.poll() is not None:
                    break
                if time.monotonic() >= tick:
                    mirror_native(); snapshot('running'); tick = time.monotonic() + heartbeat
                time.sleep(.05)
            if reason:
                stop(batch, f'{prefix.name}: {reason}')
            elif proc.returncode not in allowed_codes:
                reason = 'process-failed'; stop(batch, f'{prefix.name}: exit {proc.returncode}')
        except BaseException as e:
            reason = reason or 'supervisor-error'; stop(batch, f'{prefix.name}: {e}')
            raise
        finally:
            # Clean orphan workers even after a normal parent exit.
            try:
                terminate(signal.SIGTERM)
                if proc:
                    try: proc.wait(timeout=.25)
                    except subprocess.TimeoutExpired: pass
                terminate(signal.SIGKILL)
                if proc: proc.wait(timeout=5)
            finally:
                for sig, handler in handlers.items(): signal.signal(sig, handler)
                if violation.exists():
                    Path(str(prefix) + '.violation.json').write_bytes(violation.read_bytes())
                mirror_native()
                if native_root and native_source is None and reason is None:
                    reason = 'native-trace-unavailable'; stop(batch, reason)
                result = snapshot('failed' if reason else 'completed')
    return {**result, 'stdout': stdout_path.read_text(errors='replace'), 'stderr': stderr_path.read_text(errors='replace')}

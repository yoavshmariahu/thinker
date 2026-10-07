"""Fail-closed guards shared by performance setup, solvers and evaluators (POSIX)."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MODELS = {'opus': 'claude-opus-5-5', 'sol': 'gpt-6.1-sol', 'gemini': 'gemini-3.8-flash-high'}
SOURCES = ['run.py', 'pipeline.py', 'memory.mjs', 'verify.py', 'guardrails.py', 'thinker_bench_pytest.py', 'prepare.py', 'freeze.py']


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
    if e.get('guardrailsVersion') != 1 or e.get('models') != MODELS or e.get('effort') != 'high' or e.get('fallback') is not False:
        raise GuardError('Missing or mismatched frozen model/effort protocol')
    if e.get('tasksSha256') != digest(Path(out) / 'tasks.json'):
        raise GuardError('Task manifest changed')
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


def assert_ready(out, tasks, models=MODELS):
    """Validate all caches before either arm; do not trust counts or exit status alone."""
    out = Path(out)
    require_running(out)
    if not tasks or not models:
        raise GuardError('Nonempty tasks and model cohorts required')
    assert_preflight(out, tasks)
    for model in models:
        for task in tasks:
            name = f'{task["id"]}-{model}'
            learned = read(out / 'raw' / (name + '-learn.json'))
            if learned.get('valid') is not True or learned.get('model') != MODELS[model] or learned.get('effort') != 'high':
                raise GuardError(f'{name}: invalid exploration identity or outcome')
            build = read(out / 'raw' / (name + '-learn-build.json'))
            if build.get('setupError') or build.get('cacheBuildPath') != 'distillFile' or build.get('valid') is not True:
                raise GuardError(f'{name}: failed or unsupported cache-building path')
            retrieval = read(out / 'raw' / (name + '-thinker-retrieval.json'))
            hashes = read(out / 'raw' / (name + '-learn-note-hashes.json'))
            if not hashes or retrieval.get('noteCount') != len(hashes) or not retrieval.get('text', '').strip() or not retrieval.get('included'):
                raise GuardError(f'{name}: empty cache or retrieval')
            ids = set()
            for filename, checksum in hashes.items():
                if Path(filename).name != filename or not filename.endswith('.json'):
                    raise GuardError('Invalid cache filename')
                source = out / 'raw' / (name + '-learn-notes') / filename
                target = out / 'state' / (name + '-thinker') / '.thinker/notes' / filename
                if digest(source) != checksum or digest(target) != checksum:
                    raise GuardError(f'{name}: cache hash mismatch')
                note = read(source)
                if not note.get('deps') or not note.get('body', '').strip() or note.get('status') != 'fresh':
                    raise GuardError(f'{name}: unusable note')
                ids.add(note['id'])
            if not set(retrieval['included']) <= ids:
                raise GuardError(f'{name}: retrieval references missing notes')
            if (out / 'state' / (name + '-baseline') / '.thinker').exists():
                raise GuardError(f'{name}: baseline contaminated with a cache')


def checked_ready(out, tasks, models=MODELS):
    try:
        assert_ready(out, tasks, models)
    except Exception as e:
        stop(out, e)
        raise GuardError(str(e)) from e


def isolated_env(base):
    env = dict(base)
    for key in ['THINKER_NOTES_DIR', 'THINKER_REPO', 'MAX_THINKING_TOKENS']:
        env.pop(key, None)
    env.update(THINKER_TEST='1', THINKER_TELEMETRY='off', THINKER_LOG='local', THINKER_HOOKS='off',
               THINKER_MCP='off', THINKER_NO_LEARN='1', THINKER_NO_AUTO_UPDATE='1')
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


def supervised(cmd, *, cwd, env, prefix, seconds, batch, input_text=None, heartbeat=1, allowed_codes=(0,), native_root=None):
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
    env = {**isolated_env(env), 'THINKER_TEST': '1', 'THINKER_TELEMETRY': 'off', 'THINKER_LOG': 'local', 'THINKER_BENCH_VIOLATION': str(violation.resolve()), 'THINKER_PERF_SUPERVISED': '1'}
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

"""Efficiency runs through the product's own paths: build a repository's cache, then code in it.

One cache per repository per cohort, built once at an anchor commit that precedes every task base,
so no cache can hold knowledge of the fix its own task is about. Each task works on a copy of that
cache, topped up with the changes merged between the anchor and its own base and re-checked for
staleness -- what a repository's cache actually looks like when someone sits down to work.

  build <cohort>     the anchor cache, mined by that cohort's own model
  preflight          the acceptance test must fail at base and pass on the upstream fix
  probe <cohort>     what the cache would serve per task, before a coding run is spent on it
  solve <cohort>     both arms of every task: with the cache and without it
  score <cohort>     the acceptance test against each arm's work, upstream tests restored

Two facts shape the wiring. `thinker setup` wires the agents machine-wide and would write into the
operator's own configuration, so it is never called here: `mine-prs` and `seed` create the cache by
themselves. And an agent CLI is only logged in with its real configuration directory, so the arm's
wiring comes from the checkout (`wire.mjs`, repo scope) while `--setting-sources ''` keeps the
machine's settings out. Measured: under `--safe-mode` an explicitly passed hook does not run at all.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get('THINKER_EFF_DIR', ROOT / 'bench/runs/efficiency-simple'))
SOURCE = Path(os.environ.get('THINKER_BENCH_SOURCE', '')).expanduser()
CLI, WIRE = str(ROOT / 'src/cli.js'), str(ROOT / 'research/performance-canary/wire.mjs')
PY_BIN = str(ROOT / '.venv-perf/bin/python')
MODELS = {'opus': ('claude', 'claude-opus-5-5'), 'sol': ('codex', 'gpt-6.1-sol')}
TASKS = json.loads((ROOT / 'research/performance-canary/tasks.json').read_text())
ARMS = ['baseline', 'thinker']
assert os.environ.get('THINKER_TEST') == '1', 'THINKER_TEST=1 required'
if not SOURCE.is_dir():
    raise SystemExit('Set THINKER_BENCH_SOURCE to the read-only upstream clone')


def git(args, cwd, check=True):
    r = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f'git {" ".join(args)} failed in {cwd}: {r.stderr[:300]}')
    return r.stdout


def snapshot(commit, dest):
    """A checkout whose history stops at `commit`; nothing merged later exists to be found."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    git(['branch', '-f', 'eff-anchor', commit], SOURCE)
    git(['clone', '--quiet', '--single-branch', '--branch', 'eff-anchor', f'file://{SOURCE}', str(dest)], ROOT)
    git(['remote', 'remove', 'origin'], dest)
    return dest


def env_for(cohort, *, learning, cache):
    """The product's environment. Learning stays on only while a cache is being built."""
    cli_name, model = MODELS[cohort]
    env = {**os.environ, 'THINKER_TEST': '1', 'THINKER_TELEMETRY': 'off', 'THINKER_LOG': 'local',
           'THINKER_NO_AUTO_UPDATE': '1', 'THINKER_HOLDOUT': 'off',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
           # Memory building runs on the cohort's own model and effort, as the coding does.
           'THINKER_LLM': cli_name, 'THINKER_LLM_MODEL': model,
           'THINKER_CLAUDE_EFFORT': 'high', 'THINKER_CODEX_REASONING_EFFORT': 'high'}
    env.pop('MAX_THINKING_TOKENS', None)
    if not learning:
        env['THINKER_NO_LEARN'] = '1'
    if cache:
        # Test mode turns Jev off and would rank with the local fallback in silence.
        env.update(THINKER_JEV='on', THINKER_JEV_ALLOW_NETWORK='1',
                   THINKER_JEV_KEY=(Path.home() / '.thinker/jev-key').read_text().strip())
    else:
        env.update(THINKER_HOOKS='off', THINKER_MCP='off')
    return env


def thinker(args, repo, env, label, seconds=5400):
    """One product command. Output goes to disk while it runs, so a long build can be watched."""
    log = OUT / 'raw' / f'{label}.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    with log.open('w') as sink:
        r = subprocess.run(['node', CLI, *args], cwd=repo, env=env, stdout=sink,
                           stderr=subprocess.STDOUT, timeout=seconds)
    print(f'  {label}: exit {r.returncode} in {time.monotonic() - start:.0f}s', flush=True)
    return r


def notes_in(repo):
    return sorted((repo / '.thinker/local/notes').glob('*.json'))


def anchor_task():
    """The oldest task by base date: the cache is built there, so no fix is within its reach."""
    return sorted(TASKS, key=lambda t: int(git(['show', '-s', '--format=%ct', t['base']], SOURCE).strip()))[0]


def build(cohort):
    anchor = anchor_task()
    repo = snapshot(anchor['base'], OUT / f'cache-{cohort}')
    env = env_for(cohort, learning=True, cache=True)
    print(f'building {cohort} cache at {anchor["id"]} ({anchor["base"][:10]})', flush=True)
    # Mining only. Exploration was measured on Click and is not part of a benchmark cache: it cost
    # 3.6M tokens for 0 notes under Opus and 1.3M for 1 under Sol, against 272k for 9 by mining.
    for args, label in [(['mine-prs', '--git', '--limit', '20'], f'{cohort}-mine'),
                        (['relink'], f'{cohort}-relink')]:
        if thinker(args, repo, env, label).returncode != 0:
            raise SystemExit(f'{label} failed; see raw/{label}.log')
    count = len(notes_in(repo))
    print(f'{cohort}: {count} notes', flush=True)
    if not count:
        raise SystemExit(f'{cohort}: empty cache, nothing to measure')
    (OUT / 'raw' / f'{cohort}-build.json').write_text(json.dumps(
        {'cohort': cohort, 'model': MODELS[cohort][1], 'anchor': anchor['id'],
         'anchorBase': anchor['base'], 'notes': count}, indent=2) + '\n')


def task_cache(cohort, task, repo):
    """The anchor cache, topped up with what merged before this task's base, then re-checked."""
    source = OUT / f'cache-{cohort}/.thinker'
    if not source.exists():
        raise SystemExit(f'build {cohort} first')
    shutil.copytree(source, repo / '.thinker')
    for path in [repo / '.thinker/log.jsonl', repo / '.thinker/state']:
        shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
    env = env_for(cohort, learning=True, cache=True)
    label = f'{task["id"]}-{cohort}'
    if task['base'] != anchor_task()['base']:
        thinker(['mine-prs', '--git', '--limit', '5'], repo, env, label + '-topup')
    thinker(['check'], repo, env, label + '-check')          # staleness, as any working repo has
    thinker(['verify'], repo, env, label + '-verify')        # the product's own invalidation
    return len(notes_in(repo))


RULES = ('Work only within this repository. Do not inspect parent or sibling directories, git history, '
         'remotes, reference patches or websites, and do not install dependencies or create commits. '
         f'Use {PY_BIN} to run tests. Implement the requested change, add appropriate tests, run the '
         'relevant tests, and leave the work uncommitted.')


def gold(task):
    """The upstream fix: its source diff and its version of the test module."""
    out = OUT / 'raw' / f'{task["id"]}-gold'
    out.mkdir(parents=True, exist_ok=True)
    patch, tests = out / 'source.patch', out / 'tests.py'
    if not patch.exists():
        patch.write_text(git(['diff', task['base'], task['fixed'], '--', 'src'], SOURCE))
        tests.write_text(git(['show', f'{task["fixed"]}:{task["test_file"]}'], SOURCE))
    return patch, tests


def acceptance(repo, task, label):
    """The frozen upstream test, so an arm cannot pass by weakening it."""
    _, tests = gold(task)
    (repo / task['test_file']).write_text(tests.read_text())
    env = {**os.environ, 'PYTHONPATH': str(repo / 'src'), 'THINKER_TEST': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    r = subprocess.run([PY_BIN, '-m', 'pytest', '-q', task['test_file'], '-k', task['acceptance']],
                       cwd=repo, env=env, capture_output=True, text=True, timeout=600)
    (OUT / 'raw' / f'{label}-acceptance.log').write_text(r.stdout + r.stderr)
    return {'returncode': r.returncode, 'passed': r.returncode == 0}


def preflight():
    """The grade must separate the two sides before any arm is measured."""
    results = {}
    for task in TASKS:
        base = snapshot(task['base'], OUT / f'{task["id"]}-verify-base')
        git(['reset', '--hard', '-q', 'HEAD'], base)
        git(['clean', '-fdq'], base)
        at_base = acceptance(base, task, f'{task["id"]}-base')
        fixed = snapshot(task['base'], OUT / f'{task["id"]}-verify-gold')
        git(['reset', '--hard', '-q', 'HEAD'], fixed)   # repeatable: solve() preflights again
        git(['clean', '-fdq'], fixed)
        patch, _ = gold(task)
        if patch.stat().st_size:
            git(['apply', str(patch)], fixed)
        at_fixed = acceptance(fixed, task, f'{task["id"]}-gold')
        ok = not at_base['passed'] and at_fixed['passed']
        results[task['id']] = {'base': at_base, 'gold': at_fixed, 'valid': ok}
        print(f'{task["id"]}: base {"fails" if not at_base["passed"] else "PASSES (invalid)"}, '
              f'gold {"passes" if at_fixed["passed"] else "FAILS (invalid)"}', flush=True)
    (OUT / 'raw' / 'preflight.json').write_text(json.dumps(results, indent=2) + '\n')
    if not all(r['valid'] for r in results.values()):
        raise SystemExit('Preflight failed: the acceptance test does not separate base from fix')


def agent_argv(cohort, repo, arm, prompt):
    """Identical request both ways; the cache's own wiring is the only difference."""
    cli_name, model = MODELS[cohort]
    if cli_name == 'claude':
        # The machine's settings stay out, and the arm's own are passed explicitly: measured, a hook
        # given through --settings does not run under --safe-mode, so that is not used here.
        wiring = ['--settings', str(repo / '.claude/settings.local.json'),
                  '--mcp-config', str(repo / '.mcp.json'), '--strict-mcp-config'] if arm == 'thinker' else \
                 ['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']
        return (['claude', '-p', prompt, '--model', model, '--effort', 'high', '--output-format', 'stream-json',
                 '--verbose', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands',
                 '--permission-mode', 'bypassPermissions', '--max-turns', '80', *wiring], None)
    return (['codex', 'exec', '--json', '--model', model, '--config', 'model_reasoning_effort="high"',
             '--config', 'web_search="disabled"', '--sandbox', 'workspace-write', '--cd', str(repo), '-'], prompt)


def codex_home(cohort, label, cache):
    """Codex reads its MCP entry and hook trust from CODEX_HOME, so each run gets its own."""
    home = OUT / 'homes' / label
    home.mkdir(parents=True, exist_ok=True)
    auth, source = home / 'auth.json', Path(os.environ.get('THINKER_CODEX_AUTH', '')).expanduser()
    if not auth.exists():
        if not source.is_file():
            raise SystemExit('Set THINKER_CODEX_AUTH to the Codex auth.json to use')
        auth.symlink_to(source)
    return home


def measure(cohort, arm, task):
    label = f'{task["id"]}-{cohort}-{arm}'
    record = OUT / 'raw' / f'{label}.json'
    if record.exists():
        return json.loads(record.read_text())
    repo = snapshot(task['base'], OUT / label)
    notes = task_cache(cohort, task, repo) if arm == 'thinker' else 0
    env = env_for(cohort, learning=False, cache=arm == 'thinker')
    if arm == 'thinker':
        if subprocess.run(['node', WIRE, MODELS[cohort][0], str(repo), str(OUT / 'raw' / f'{label}-wiring.json')],
                          cwd=ROOT, env={**env, 'CODEX_HOME': str(codex_home(cohort, label, True))},
                          capture_output=True, text=True).returncode != 0:
            raise SystemExit(f'{label}: wiring failed')
    if MODELS[cohort][0] == 'codex':
        env['CODEX_HOME'] = str(codex_home(cohort, label, arm == 'thinker'))
    # The request comes first because the prompt hook retrieves against the whole prompt: with the
    # constraints in front, Jev scored this repository's notes against boilerplate about not
    # inspecting directories and served nothing (jevTop 0.25/0.11/0.10 against a floor of 0.5).
    # Both arms get the same text either way; only retrieval is affected.
    prompt = task['prompt'] + '\n\nCONSTRAINTS:\n' + RULES
    argv, stdin = agent_argv(cohort, repo, arm, prompt)
    print(f'{label}: {notes} notes, starting', flush=True)
    start = time.monotonic()
    r = subprocess.run(argv, cwd=repo, env=env, input=stdin, capture_output=True, text=True, timeout=1800)
    (OUT / 'raw' / f'{label}.events').write_text(r.stdout)
    (OUT / 'raw' / f'{label}.stderr').write_text(r.stderr)
    row = {'id': label, 'task': task['id'], 'cohort': cohort, 'arm': arm, 'model': MODELS[cohort][1],
           'notes': notes, 'wallSeconds': round(time.monotonic() - start, 1), 'returncode': r.returncode,
           **usage(MODELS[cohort][0], r.stdout)}
    git(['add', '-A'], repo)
    (OUT / 'raw' / f'{label}.patch').write_text(git(['diff', '--cached'], repo))
    row['served'] = servings(repo)
    record.write_text(json.dumps(row, indent=2) + '\n')
    print(f'  {label}: {row["toolCalls"]} tool calls, {row["inputTokens"]} input tokens, '
          f'{row["wallSeconds"]}s, {row["served"]} servings', flush=True)
    return row


def usage(cli_name, stdout):
    """Counters as each CLI reports them; never inferred."""
    events = [json.loads(l) for l in stdout.splitlines() if l.startswith('{')]
    if cli_name == 'claude':
        done = [e for e in events if e.get('type') == 'result']
        if not done:
            return {'inputTokens': None, 'outputTokens': None, 'toolCalls': None, 'valid': False}
        u = done[-1].get('usage', {})
        return {'inputTokens': sum(u.get(k, 0) for k in ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']),
                'outputTokens': u.get('output_tokens', 0),
                'toolCalls': sum(b.get('type') == 'tool_use' for e in events if e.get('type') == 'assistant'
                                 for b in e.get('message', {}).get('content', [])),
                'models': list(done[-1].get('modelUsage', {})), 'valid': not done[-1].get('is_error')}
    turns = [e['usage'] for e in events if e.get('type') == 'turn.completed']
    items = [e['item'] for e in events if e.get('type') == 'item.completed']
    return {'inputTokens': sum(t.get('input_tokens', 0) for t in turns) or None,
            'outputTokens': sum(t.get('output_tokens', 0) for t in turns) or None,
            'toolCalls': sum(i.get('type') not in ['reasoning', 'agent_message'] for i in items),
            'valid': bool(turns) and not any(e.get('type') in ['error', 'turn.failed'] for e in events)}


def servings(repo):
    """How often the cache actually served, from the checkout's own log."""
    log = repo / '.thinker/log.jsonl'
    if not log.exists():
        return 0
    rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    if any(r.get('op') in ('jev-error', 'ce-error') for r in rows):
        raise SystemExit(f'{repo.name}: ranking fell back; the run would not measure the shipped ranker')
    return sum(1 for r in rows if r.get('op') == 'orient' and r.get('included'))


def probe(cohort):
    """What the cache would serve for each task, before spending a coding run on it.

    A pair whose cache serves nothing measures the baseline against itself, so coverage is worth
    knowing first: on Click, mining 20 commits covered 1 of 6 task-cohort pairs.
    """
    repo = OUT / f'cache-{cohort}'
    if not (repo / '.thinker').exists():
        raise SystemExit(f'build {cohort} first')
    rows = []
    for task in TASKS:
        log = repo / '.thinker/log.jsonl'
        log.unlink(missing_ok=True)
        payload = json.dumps({'session_id': f'probe-{cohort}-{task["id"]}', 'cwd': str(repo),
                              'prompt': task['prompt']})
        subprocess.run(['node', CLI, 'hook', 'prompt'], cwd=repo, input=payload,
                       env=env_for(cohort, learning=False, cache=True), capture_output=True, text=True)
        records = [json.loads(l) for l in log.read_text().splitlines() if l.strip()] if log.exists() else []
        served = next((r for r in records if r.get('op') == 'orient'), {})
        rows.append({'task': task['id'], 'cohort': cohort, 'served': served.get('served') or [],
                     'scores': served.get('jevTop'), 'ranker': 'jev' if 'jev' in served else 'local'})
        print(f'{cohort:5s} {task["id"]}: {len(rows[-1]["served"])} served, scores {rows[-1]["scores"]}', flush=True)
    (OUT / f'probe-{cohort}.json').write_text(json.dumps(rows, indent=2) + '\n')
    covered = [r['task'] for r in rows if r['served']]
    print(f'{cohort}: {len(covered)} of {len(TASKS)} tasks covered{": " + ", ".join(covered) if covered else ""}', flush=True)
    return rows


def solve(cohort):
    preflight()
    rows = []
    for i, task in enumerate(TASKS):
        for arm in (ARMS if (i + list(MODELS).index(cohort)) % 2 == 0 else list(reversed(ARMS))):
            rows.append(measure(cohort, arm, task))
    (OUT / f'solve-{cohort}.json').write_text(json.dumps(rows, indent=2) + '\n')


def score(cohort):
    """Each arm's work against the frozen upstream test."""
    results = []
    for task in TASKS:
        for arm in ARMS:
            label = f'{task["id"]}-{cohort}-{arm}'
            patch = OUT / 'raw' / f'{label}.patch'
            if not patch.exists():
                continue
            repo = snapshot(task['base'], OUT / f'{label}-score')
            git(['reset', '--hard', '-q', 'HEAD'], repo)
            git(['clean', '-fdq'], repo)
            if patch.stat().st_size:
                git(['apply', str(patch)], repo, check=False)
            results.append({'id': label, **acceptance(repo, task, label + '-score')})
            print(f'{label}: {"passes" if results[-1]["passed"] else "fails"}', flush=True)
    (OUT / f'score-{cohort}.json').write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    phase = sys.argv[1]
    OUT.mkdir(parents=True, exist_ok=True)
    if phase == 'build':
        build(sys.argv[2])
    elif phase == 'preflight':
        preflight()
    elif phase == 'probe':
        probe(sys.argv[2])
    elif phase == 'solve':
        solve(sys.argv[2])
    elif phase == 'score':
        score(sys.argv[2])
    else:
        raise SystemExit('phases: build <cohort> | preflight | probe <cohort> | solve <cohort> | score <cohort>')

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
import json, os, shutil, subprocess, sys, time, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get('THINKER_EFF_DIR', ROOT / 'bench/runs/efficiency-simple'))
SOURCE = Path(os.environ.get('THINKER_BENCH_SOURCE', '')).expanduser()
CLI, WIRE = str(ROOT / 'src/cli.js'), str(ROOT / 'research/performance-canary/wire.mjs')
# The interpreter the tests run under and the import root of the repository's package: Click keeps
# its package under src/, mitmproxy at the repository root. THINKER_EFF_PYBIN and THINKER_EFF_PYPATH
# name another repository's; the venv must not hold an installed copy of the package, or the tests
# would import that rather than the checkout under test.
PY_BIN = os.environ.get('THINKER_EFF_PYBIN') or str(ROOT / '.venv-perf/bin/python')
PYPATH = os.environ.get('THINKER_EFF_PYPATH', 'src')
# The directory the upstream fix is taken from (its source, never its tests): the package directory
# when PYPATH is the repository root. With `src` hard-wired, every mitmproxy gold patch was empty
# and the preflight read "gold FAILS" for five tasks of six (2026-10-08).
SRC = os.environ.get('THINKER_EFF_SRC') or ('src' if PYPATH == 'src' else PYPATH)
# Plugin autoload is off for the acceptance run, so a repository whose tests need a plugin names it
# (mitmproxy: `-p pytest_asyncio -p pytest_timeout`, its asyncio tests collect as plain functions otherwise).
PYTEST_ARGS = os.environ.get('THINKER_EFF_PYTEST_ARGS', '').split()
MODELS = {'opus': ('claude', 'claude-opus-5-5'), 'sol': ('codex', 'gpt-6.1-sol')}
TASKS = json.loads(Path(os.environ.get('THINKER_EFF_TASKS', ROOT / 'research/performance-canary/tasks.json')).read_text())
ARMS = ['baseline', 'thinker']
# One draw per arm cannot tell the intervention from the agent's own variance (the Click canary of
# 2026-10-07: identical no-cache runs of one task differed by ~12% of tokens and ~25% of wall time).
SEEDS = int(os.environ.get('THINKER_EFF_SEEDS', '1'))
assert os.environ.get('THINKER_TEST') == '1', 'THINKER_TEST=1 required'
if not SOURCE.is_dir():
    raise SystemExit('Set THINKER_BENCH_SOURCE to the read-only upstream clone')


MUTATING = {'reset', 'clean', 'add', 'apply', 'commit', 'checkout'}


def git(args, cwd, check=True):
    """Run git in `cwd`, having proved that `cwd` is the repository it claims to be.

    Without the check a mutating command aimed at a directory that is not a checkout walks up to
    the enclosing repository: `reset --hard` on an empty run directory discarded this worktree's
    uncommitted work once, which is a benchmark deleting the thing it is measuring.
    """
    cwd = Path(cwd)
    if args[0] in MUTATING:
        top = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=cwd, capture_output=True, text=True)
        if top.returncode or Path(top.stdout.strip()).resolve() != cwd.resolve():
            raise SystemExit(f'refusing git {args[0]}: {cwd} is not a checkout '
                             f'(enclosing repository is {top.stdout.strip() or "none"})')
    r = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f'git {" ".join(args)} failed in {cwd}: {r.stderr[:300]}')
    return r.stdout


def snapshot(commit, dest):
    """A checkout whose history stops at `commit`; nothing merged later exists to be found."""
    if dest.exists():
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=dest, capture_output=True, text=True)
        top = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=dest, capture_output=True, text=True)
        if (not head.returncode and head.stdout.strip() == commit
                and Path(top.stdout.strip() or '/').resolve() == dest.resolve()):
            return dest
        # A directory left over from an interrupted run holds the cache and no source.
        shutil.rmtree(dest)
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


def described_in(repo):
    """Notes carrying a description current for their own text, which is what Jev searches.

    `searchText` falls back to the body when `saysFor` no longer matches the note's `phraseKey`, so
    a note rewritten by a later mining pass stops being described without saying so.
    """
    script = ("const {Store} = await import('./src/store.js');"
              "const {phraseKey} = await import('./src/note-search.js');"
              "const s = new Store(process.argv[1]);"
              "process.stdout.write(String(s.list().filter(n => (n.search || '').trim() && n.saysFor === phraseKey(n)).length));")
    out = subprocess.run(['node', '--input-type=module', '-e', script, str(repo)],
                         cwd=ROOT, capture_output=True, text=True, env={**os.environ, 'THINKER_TEST': '1'})
    if out.returncode or not out.stdout.strip().isdigit():
        raise SystemExit(f'cannot count described notes in {repo}: {out.stderr[:200]}')
    return int(out.stdout.strip())


def anchor_task():
    """The oldest task by base date: the cache is built there, so no fix is within its reach.

    THINKER_EFF_ANCHOR pins an older commit instead, so a cache already built there serves a later
    task set without being mined again; it must precede every task base, and is checked to.
    """
    oldest = sorted(TASKS, key=lambda t: int(git(['show', '-s', '--format=%ct', t['base']], SOURCE).strip()))[0]
    pinned = os.environ.get('THINKER_EFF_ANCHOR')
    if not pinned:
        return oldest
    for t in TASKS:
        if subprocess.run(['git', 'merge-base', '--is-ancestor', pinned, t['base']], cwd=SOURCE).returncode != 0:
            raise SystemExit(f'anchor {pinned[:10]} is not an ancestor of {t["id"]} base {t["base"][:10]}')
    return {'id': f'anchor-{pinned[:10]}', 'base': pinned}


def lift_daily_cap(repo):
    """A build spends more in an hour than a repository is meant to spend in a day.

    Without this the cap stops the note catalog mid-build and the remaining changes fail their
    checks -- 16 of 60 commits on the first deep mining run, reported only as
    `note catalog unavailable: dailyTokens`. The guarded harness set the same override.
    """
    # The cache directory does not exist until a build command creates it, and returning early here
    # left the cap in force for the whole build: mining failed 16 of 60 changes on one run, and on
    # another the phrasing judge refused all 21 notes with reason `dailyTokens` while still spending
    # 41k tokens. The directory is created so the override is in place before the first call.
    config = repo / '.thinker/config.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    current = json.loads(config.read_text()) if config.exists() else {}
    current['maintain'] = {**current.get('maintain', {}), 'dailyTokens': 1_000_000_000}
    config.write_text(json.dumps(current, indent=2) + '\n')


def build(cohort):
    anchor = anchor_task()
    repo = snapshot(anchor['base'], OUT / f'cache-{cohort}')
    lift_daily_cap(repo)
    env = env_for(cohort, learning=True, cache=True)
    print(f'building {cohort} cache at {anchor["id"]} ({anchor["base"][:10]})', flush=True)
    # Mining only. Exploration was measured on Click and is not part of a benchmark cache: it cost
    # 3.6M tokens for 0 notes under Opus and 1.3M for 1 under Sol, against 272k for 9 by mining.
    # 20 is the product's own default for a single run, and too shallow to measure anything here:
    # the first Click caches held 9 and 11 notes and covered 0 of 6 task-cohort pairs, where ~80
    # commits held 48 and 38 and covered 3 of 3 and 2 of 3. THINKER_EFF_MINE overrides.
    limit = os.environ.get('THINKER_EFF_MINE', '60')
    for args, label in [(['mine-prs', '--git', '--limit', limit], f'{cohort}-mine'),
                        (['phrase'], f'{cohort}-phrase'),
                        (['relink'], f'{cohort}-relink')]:
        if thinker(args, repo, env, label).returncode != 0:
            raise SystemExit(f'{label} failed; see raw/{label}.log')
    count = len(notes_in(repo))
    described = described_in(repo)
    print(f'{cohort}: {described} of {count} notes have a search description', flush=True)
    if not described:
        raise SystemExit(f'{cohort}: no note has a description; Jev would rank on bodies alone')
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
    shutil.rmtree(repo / '.thinker', ignore_errors=True)   # repeatable: a retry starts clean
    # The topped-up cache of a task is built once per cohort and shared by its seeds: the seeds vary
    # the agent's draw, not the cache, and a top-up with verification and phrasing is minutes of
    # model time that would otherwise be paid again for every seed.
    ready = OUT / f'cache-{cohort}-{task["id"]}/.thinker'
    if ready.exists():
        shutil.copytree(ready, repo / '.thinker')
        for path in [repo / '.thinker/log.jsonl', repo / '.thinker/state']:
            shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
        print(f'  {task["id"]}-{cohort}: cache reused, {len(notes_in(repo))} notes', flush=True)
        return len(notes_in(repo))
    shutil.copytree(source, repo / '.thinker')
    lift_daily_cap(repo)
    for path in [repo / '.thinker/log.jsonl', repo / '.thinker/state']:
        shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)
    env = env_for(cohort, learning=True, cache=True)
    label = f'{task["id"]}-{cohort}'
    if task['base'] != anchor_task()['base']:
        thinker(['mine-prs', '--git', '--limit', '5'], repo, env, label + '-topup')
    thinker(['check'], repo, env, label + '-check')          # staleness, as any working repo has
    thinker(['verify'], repo, env, label + '-verify')        # the product's own invalidation
    # mining and verification rewrite notes, and a rewritten note's description is no longer current
    thinker(['phrase'], repo, env, label + '-phrase')
    print(f'  {label}: {described_in(repo)} of {len(notes_in(repo))} notes described', flush=True)
    shutil.rmtree(ready.parent, ignore_errors=True)
    shutil.copytree(repo / '.thinker', ready)
    return len(notes_in(repo))


RULES = ('Work only within this repository. Do not inspect parent or sibling directories, git history, '
         'remotes, reference patches or websites, and do not install dependencies or create commits. '
         f'Use {PY_BIN} to run tests, with PYTHONPATH={PYPATH}. Implement the requested change, add appropriate tests, run the '
         'relevant tests, and leave the work uncommitted.')


def coding_prompt(task):
    """What the agent is sent, and therefore what the prompt hook retrieves against.

    The request comes first: with the constraints in front, Jev scored this repository's notes
    against boilerplate about not inspecting directories (jevTop 0.25/0.11/0.10 against a floor of
    0.5). A probe must send this same text, or it measures coverage the run will not have -- one
    task probed at 0.51 on its request alone and reached only 0.44 in the run.
    """
    return task['prompt'] + '\n\nCONSTRAINTS:\n' + RULES


def gold(task):
    """The upstream fix: its source diff and its version of the test module."""
    out = OUT / 'raw' / f'{task["id"]}-gold'
    out.mkdir(parents=True, exist_ok=True)
    patch, tests = out / 'source.patch', out / 'tests.py'
    if not patch.exists():
        patch.write_text(git(['diff', task['base'], task['fixed'], '--', SRC], SOURCE))
        tests.write_text(git(['show', f'{task["fixed"]}:{task["test_file"]}'], SOURCE))
    return patch, tests


def acceptance(repo, task, label):
    """The frozen upstream test, so an arm cannot pass by weakening it."""
    _, tests = gold(task)
    (repo / task['test_file']).write_text(tests.read_text())
    env = {**os.environ, 'PYTHONPATH': str(repo / PYPATH), 'THINKER_TEST': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    r = subprocess.run([PY_BIN, '-m', 'pytest', '-q', *PYTEST_ARGS, task['test_file'], '-k', task['acceptance']],
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
    # No --ignore-rules: it suppresses the checkout's `.codex/hooks.json`, so thinker's prompt hook
    # never ran and every Sol arm was a baseline with a `served: 0` nobody checked. Measured: the
    # same invocation without it logs `intro` and `orient` on the first prompt.
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


def run_label(task, cohort, arm, seed=1):
    """Seed 1 keeps the label of a single-draw run, so an earlier run's records still read."""
    return f'{task["id"]}-{cohort}-{arm}' + (f'-s{seed}' if seed > 1 else '')


def measure(cohort, arm, task, seed=1):
    label = run_label(task, cohort, arm, seed)
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
    prompt = coding_prompt(task)
    argv, stdin = agent_argv(cohort, repo, arm, prompt)
    print(f'{label}: {notes} notes, starting', flush=True)
    start = time.monotonic()
    r = subprocess.run(argv, cwd=repo, env=env, input=stdin, capture_output=True, text=True, timeout=1800)
    (OUT / 'raw' / f'{label}.events').write_text(r.stdout)
    (OUT / 'raw' / f'{label}.stderr').write_text(r.stderr)
    row = {'id': label, 'task': task['id'], 'cohort': cohort, 'arm': arm, 'seed': seed, 'model': MODELS[cohort][1],
           'notes': notes, 'wallSeconds': round(time.monotonic() - start, 1), 'returncode': r.returncode,
           **usage(MODELS[cohort][0], r.stdout)}
    git(['add', '-A'], repo)
    (OUT / 'raw' / f'{label}.patch').write_text(git(['diff', '--cached'], repo))
    row['served'] = servings(repo)
    row['cacheReached'] = arm == 'thinker' and row['served'] > 0
    if arm == 'thinker':
        # The same cache and prompt scored 0.44 at probe time and 0.06 during a Jev outage (2026-10-08,
        # mitm-8196 on Sol): the 503s were refused above, the degraded 200s were not, and three thinker
        # arms ran as baselines. A run whose prompt-time top score falls far below the probe's is refused.
        probed = OUT / f'probe-{cohort}.json'
        top = next((r.get('scores') or [None] for r in json.loads(probed.read_text()) if r['task'] == task['id']), [None])[0] if probed.exists() else None
        rows = [json.loads(l) for l in (repo / '.thinker/log.jsonl').read_text().splitlines() if l.strip()] if (repo / '.thinker/log.jsonl').exists() else []
        seen = next((r.get('jevTop') or [None] for r in rows if r.get('op') == 'orient' and r.get('client') != 'mcp'), [None])[0]
        row['jevTopProbe'], row['jevTopRun'] = top, seen
        if top is not None and seen is not None and top >= 0.5 and seen < top - 0.25:
            raise SystemExit(f'{label}: Jev scored the cache at {seen} in the run against {top} at probe time; the ranking service is degraded, rerun later')
    if arm == 'thinker' and not row['served']:
        print(f'  {label}: WARNING the cache served nothing; this arm is a baseline', flush=True)
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
                # model time apart from wall time, so hook and tool latency is visible as their difference
                'apiSeconds': round(done[-1]['duration_api_ms'] / 1000, 1) if done[-1].get('duration_api_ms') else None,
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
    """How many notes the cache actually served, from the checkout's own log.

    The hook logs them under `served`; `included` is orient's return shape, not the log's, and
    reading the wrong key reported "0 servings" for a run that was served two notes at 0.58.
    """
    log = repo / '.thinker/log.jsonl'
    # A migrated log means a thinker process ran without THINKER_LOG and moved this checkout's log
    # into the machine's: the servings are then elsewhere and the machine's history is polluted.
    # Codex did this through its MCP server until the wiring carried the environment explicitly.
    if (repo / '.thinker/state/log-before-shared.jsonl').exists():
        raise SystemExit(f'{repo.name}: the usage log was migrated out of the checkout; a thinker process ran without THINKER_LOG')
    if not log.exists():
        return 0
    rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    if any(r.get('op') in ('jev-error', 'ce-error') for r in rows):
        raise SystemExit(f'{repo.name}: ranking fell back; the run would not measure the shipped ranker')
    # The edit hook's servings count too: a note resting on the code the agent changes reaches it
    # through `late` rows, and on a task that reopens a remembered fix that is the serving that matters.
    return sum(len(r.get('served') or []) for r in rows if r.get('op') in ('orient', 'late'))


def probe(cohort):
    """What the cache would serve for each task, before spending a coding run on it.

    A pair whose cache serves nothing measures the baseline against itself, so coverage is worth
    knowing first: on Click, mining 20 commits covered 1 of 6 task-cohort pairs. The probe runs on
    the cache the task will actually have, the anchor cache topped up with what merged before the
    task's base, re-verified and re-described (`task_cache`): probed on the anchor cache alone,
    click-3533 scored 0.52 and was taken as covered, and in the run its topped-up cache scored
    0.41 to 0.45 and served nothing at prompt time (2026-10-08). The top-up is built once per
    task and cohort here and reused by every seed of `solve`.
    """
    if not (OUT / f'cache-{cohort}/.thinker').exists():
        raise SystemExit(f'build {cohort} first')
    rows = []
    for task in TASKS:
        repo = snapshot(task['base'], OUT / f'{task["id"]}-{cohort}-probe')
        task_cache(cohort, task, repo)
        log = repo / '.thinker/log.jsonl'
        offset = log.stat().st_size if log.exists() else 0
        # A fresh session every time: the hook serves a note once per session, so a reused id makes
        # the second probe of the same cache look like a cache that covers nothing.
        payload = json.dumps({'session_id': f'probe-{cohort}-{task["id"]}-{uuid.uuid4().hex[:8]}',
                              'cwd': str(repo), 'prompt': coding_prompt(task)})
        subprocess.run(['node', CLI, 'hook', 'prompt'], cwd=repo, input=payload,
                       env=env_for(cohort, learning=False, cache=True), capture_output=True, text=True)
        fresh = ''
        if log.exists():
            with log.open() as fh:
                fh.seek(offset)
                fresh = fh.read()
        records = [json.loads(l) for l in fresh.splitlines() if l.strip()]
        served = next((r for r in records if r.get('op') == 'orient'), {})
        rows.append({'task': task['id'], 'cohort': cohort, 'served': served.get('served') or [],
                     'scores': served.get('jevTop'), 'ranker': 'jev' if 'jev' in served else 'local'})
        print(f'{cohort:5s} {task["id"]}: {len(rows[-1]["served"])} served, scores {rows[-1]["scores"]}', flush=True)
    (OUT / f'probe-{cohort}.json').write_text(json.dumps(rows, indent=2) + '\n')
    covered = [r['task'] for r in rows if r['served']]
    print(f'{cohort}: {len(covered)} of {len(TASKS)} tasks covered{": " + ", ".join(covered) if covered else ""}', flush=True)
    return rows


def solve(cohort, covered_only=True):
    """Both arms of every covered task. An uncovered pair compares the baseline against itself.

    The skipped tasks are named in the result, so the coverage gap is part of the finding rather
    than a silent omission. THINKER_EFF_ALL=1 runs them anyway.
    """
    # Two cohorts started together both reset the preflight checkouts and one lost the git lock
    # (2026-10-08): a preflight already recorded for every task of this set is not run again.
    done = OUT / 'raw' / 'preflight.json'
    recorded = json.loads(done.read_text()) if done.exists() else {}
    if not all(recorded.get(t['id'], {}).get('valid') for t in TASKS):
        preflight()
    probed = OUT / f'probe-{cohort}.json'
    covered = None
    if covered_only and not os.environ.get('THINKER_EFF_ALL'):
        if not probed.exists():
            probe(cohort)
        covered = {r['task'] for r in json.loads(probed.read_text()) if r['served']}
        if not covered:
            raise SystemExit(f'{cohort}: no task has cache coverage; nothing here would measure the cache')
    rows, skipped = [], []
    for i, task in enumerate(TASKS):
        if covered is not None and task['id'] not in covered:
            skipped.append(task['id'])
            continue
        for seed in range(1, SEEDS + 1):
            for arm in (ARMS if (i + seed + list(MODELS).index(cohort)) % 2 == 0 else list(reversed(ARMS))):
                rows.append(measure(cohort, arm, task, seed))
    if skipped:
        print(f'{cohort}: skipped {", ".join(skipped)} (cache serves nothing for them)', flush=True)
    # One arm serving nothing is a ranking decision; none of them serving is a wiring failure, and
    # it reads identically in the results: every Sol arm of the first run was a baseline because
    # `--ignore-rules` suppressed the hook, and the only sign was `served: 0`.
    wired = [r for r in rows if r['arm'] == 'thinker']
    if wired and not any(r['cacheReached'] for r in wired):
        raise SystemExit(f'{cohort}: no thinker arm was served anything; the wiring did not reach the agent')
    (OUT / f'solve-{cohort}.json').write_text(json.dumps(
        {'cohort': cohort, 'runs': rows, 'skippedForNoCoverage': skipped}, indent=2) + '\n')


def score(cohort):
    """Each arm's work against the frozen upstream test."""
    results = []
    for task in TASKS:
        for seed in range(1, SEEDS + 1):
          for arm in ARMS:
            label = run_label(task, cohort, arm, seed)
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

"""Reliability checks, not latency comparisons: one concurrent job per provider."""
import concurrent.futures, json, os, pathlib, signal, subprocess
assert os.environ.get('THINKER_TEST') == '1'
ROOT = pathlib.Path(__file__).resolve().parent

def cohort(model):
    for repeat in range(1, 4):
        label = f'reliable-{repeat}-{model}'
        print('BEGIN', label, flush=True)
        with open(ROOT / 'raw' / f'{label}.log', 'x') as log:
            proc = subprocess.Popen(['node', str(ROOT / 'mine.mjs'), label, model], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = proc.wait(timeout=600)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                raise RuntimeError(f'{label}: timeout; process group stopped')
        print('END', label, code, flush=True)
        if code:
            raise RuntimeError(f'{label}: exit {code}')
        result = json.loads((ROOT / 'raw' / label / 'result.json').read_text())
        if result['result'].get('failed') or not result['notes'] or not result['retrieval']['included']:
            raise RuntimeError(f'{label}: cache incomplete or empty')

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    futures = [pool.submit(cohort, model) for model in ['opus', 'sol', 'gemini']]
    for future in futures:
        future.result()

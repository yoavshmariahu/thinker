"""Rebuild diagnostic summaries from frozen results, never from solver self-reports."""
import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
RAW = OUT / 'raw'
TASKS = json.loads((OUT / 'tasks.json').read_text())
MODELS = ['opus', 'sol', 'gemini']


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def total(rows, key):
    values = [row.get(key) for row in rows]
    return {'knownTotal': sum(v for v in values if v is not None),
            'unknownRuns': sum(v is None for v in values)}


def passing(result, kind):
    grade = result.get(kind, {})
    return grade.get('returncode') == 0 and grade.get('passed', 0) > 0


def gemini_tokens(usage):
    # AGY's input/total exclude cache reads. Its output already includes thinking.
    if not usage or any(usage.get(k) is None for k in ['input_tokens', 'output_tokens', 'cache_read_tokens']):
        return None
    return usage['input_tokens'] + usage['cache_read_tokens'] + usage['output_tokens']


cases, builds, setup_usage = [], [], []
for model in MODELS:
    for task in TASKS:
        prefix = task['id'] + '-' + model
        learned = read(RAW / (prefix + '-learn.json'), {})
        distilled = read(RAW / (prefix + '-learn-distilled.json'), {})
        build = read(RAW / (prefix + '-learn-build.json'), {})
        retrieval = read(RAW / (prefix + '-thinker-retrieval.json'), {})
        prepared = build.get('prepared', {})
        builds.append({
            'task': task['id'], 'cohort': model,
            'explorationValid': learned.get('valid'),
            'explorationTokens': gemini_tokens(learned.get('rawUsage')) if model == 'gemini' else learned.get('tokens'),
            'explorationWallMs': learned.get('wallMs'),
            'distillationTokens': gemini_tokens(distilled.get('usage')) if model == 'gemini' else distilled.get('tokens'),
            'distillationFailed': distilled.get('valid') is False,
            'proposedNotes': len(distilled.get('notes', [])),
            'acceptedNotes': retrieval.get('noteCount'),
            'servedNotes': len(retrieval.get('included', [])),
            'deferredNotes': len(prepared.get('deferred', [])),
            'deferredReasons': [n['reason'] for n in prepared.get('deferred', [])],
            'setupError': build.get('setupError'),
            'retrievalMs': retrieval.get('retrievalMs'),
            # Resumed builds do not include earlier failed-attempt latency.
            'finalBuildAttemptMs': build.get('wallMs'),
        })
        archived_log = RAW / 'usage' / (prefix + '-learn') / 'log.jsonl'
        live_log = OUT / 'state' / (prefix + '-learn') / '.thinker/log.jsonl'
        log = archived_log if archived_log.exists() else live_log
        current_pipeline = False
        if log.exists():
            for line in log.read_text().splitlines():
                record = json.loads(line)
                if record.get('op') != 'model':
                    continue
                if record.get('purpose') == 'jev-evidence':
                    current_pipeline = True
                if record.get('provider') == 'gemini':
                    record['tokens'] = {**(record.get('tokens') or {}),
                                        'totalTokens': gemini_tokens(record.get('usage'))}
                setup_usage.append({
                    'task': task['id'], 'cohort': model,
                    'stage': 'session-pipeline' if current_pipeline else 'prototype',
                    **{k: record.get(k) for k in ['t', 'eventId', 'purpose', 'provider', 'model', 'tokens', 'failed']},
                })
        for arm in ['baseline', 'thinker']:
            name = prefix + '-' + arm
            result = read(RAW / (name + '.json'))
            if result is None:
                continue
            grade = read(RAW / (name + '-validation.json'), {})
            row = {k: result.get(k) for k in ['id', 'task', 'cohort', 'arm', 'model', 'effort',
                   'valid', 'returncode', 'timedOut', 'tokens', 'inputTokens', 'outputTokens',
                   'cacheReadTokens', 'toolCalls', 'wallMs', 'error']}
            row.update(validation=grade, acceptancePass=passing(grade, 'acceptance'),
                       modulePass=passing(grade, 'module'))
            if model == 'gemini':
                row['providerReportedTotalTokens'] = result.get('tokens')
                row['tokens'] = gemini_tokens(result.get('rawUsage'))
                row['inputTokens'] = (result['inputTokens'] + result['cacheReadTokens']
                                      if result.get('inputTokens') is not None and result.get('cacheReadTokens') is not None else None)
            row['patchSha256'] = hashlib.sha256((RAW / (name + '.patch')).read_bytes()).hexdigest()
            if arm == 'thinker':
                row.update(noteCount=retrieval.get('noteCount'), servedNotes=len(retrieval.get('included', [])))
            cases.append(row)

cohorts = {}
for model in MODELS:
    cohorts[model] = {}
    for arm in ['baseline', 'thinker']:
        rows = [r for r in cases if r['cohort'] == model and r['arm'] == arm]
        cohorts[model][arm] = {
            'completed': len(rows), 'providerValid': sum(r['valid'] for r in rows),
            'graded': sum(bool(r['validation']) for r in rows),
            'acceptancePass': sum(r['acceptancePass'] for r in rows),
            'modulePass': sum(r['modulePass'] for r in rows),
            **{key: total(rows, key) for key in ['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'toolCalls', 'wallMs']},
        }

accounting = {}
for stage in ['prototype', 'session-pipeline']:
    accounting[stage] = {}
    for model in MODELS:
        rows = [r for r in setup_usage if r['stage'] == stage and r['cohort'] == model]
        accounting[stage][model] = {}
        for purpose in sorted({r['purpose'] for r in rows}):
            subset = [r for r in rows if r['purpose'] == purpose]
            accounting[stage][model][purpose] = {
                'calls': len(subset), 'failedCalls': sum(bool(r['failed']) for r in subset),
                **total([{'tokens': (r['tokens'] or {}).get('totalTokens')} for r in subset], 'tokens'),
            }
diagnostic = read(RAW / 'grounding-diagnostic.json', {})
diagnostic_usage = diagnostic.get('usage', [])
summary = {
    'execution': read(OUT / 'execution.json'),
    'plannedCodingRuns': 18, 'completedCodingRuns': len(cases),
    'decision': 'invalid-for-efficiency',
    'stop': read(OUT / 'STOPPED.json'),
    'reason': 'All nine fresh caches are empty; readiness was not enforced and task execution was not adequately monitored. The batch was stopped.',
    'cohorts': cohorts, 'builds': builds, 'cases': cases,
    'setupModelUsage': accounting,
    'diagnosticUsage': {'calls': len(diagnostic_usage), 'knownTokens': sum(u.get('input_tokens', 0) + u.get('output_tokens', 0) for u in diagnostic_usage)},
    'limitations': [
        'One sample per arm; only three tasks in one repository.',
        'Both arms use matched exact frontier model and high effort; cohorts are not pooled into a ranking.',
        'All Thinker caches are empty, including one failed Opus structured-output setup.',
        'Correctness covers frozen upstream acceptance tests and their affected test module, not all Click tests.',
        'Token and tool counters follow provider conventions; provider caching and concurrent system load were not reset.',
        'Summary Gemini tokens add AGY cache_read_tokens to its input/total; original provider totals remain in raw results. Thinking is already included in output.',
        'Setup accounting retains prototype calls, failed attempts and diagnostic probes separately; missing usage stays unknown.',
        'Final build attempt times omit earlier failed attempts; no complete setup latency or amortization claim.',
    ],
}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(OUT / 'setup-usage.json').write_text(json.dumps(setup_usage, indent=2) + '\n')
print(json.dumps({'completed': len(cases), 'cohorts': cohorts}, indent=2))

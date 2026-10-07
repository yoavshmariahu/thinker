"""Mandatory recent-PR provenance for benchmark caches. No session alternative."""
import datetime
import re
import subprocess

CACHE_SOURCE = 'recent-merged-prs'
CACHE_BUILD_PATH = 'minePrs'

def timestamp(value):
    d = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('PR timestamps must include a timezone')
    return d

def validate_pr_manifest(manifest, tasks, source=None):
    if manifest.get('version') != 1 or manifest.get('cacheSource') != CACHE_SOURCE:
        raise ValueError('Benchmark caches require recent merged PRs; session distillation is forbidden')
    if set(manifest.get('tasks', {})) != {t['id'] for t in tasks}:
        raise ValueError('PR corpus must cover exactly the frozen tasks')
    for task in tasks:
        c = manifest['tasks'][task['id']]
        if c.get('base') != task['base'] or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', c.get('repository', '')):
            raise ValueError('PR corpus repository/base mismatch')
        if c['repository'] != '/'.join(task.get('upstream', '').split('/')[3:5]):
            raise ValueError('PR repository must match the task upstream')
        cutoff = timestamp(c['before'])
        if c.get('selection') != 'recent-merged-before-base' or not isinstance(c.get('limit'), int) or not 1 <= c['limit'] <= 60:
            raise ValueError('Freeze a recent PR selection and a limit of 1..60')
        prs = c.get('prs', [])
        if not prs or len(prs) > 250 or len({p['number'] for p in prs}) != len(prs):
            raise ValueError('Nonempty unique bounded PR corpus required')
        dates = [timestamp(p['mergedAt']) for p in prs]
        if dates != sorted(dates, reverse=True):
            raise ValueError('PR corpus must be ordered most recently merged first')
        if source:
            date = subprocess.check_output(['git', 'show', '-s', '--format=%cI', task['base']], cwd=source, text=True).strip()
            if cutoff != timestamp(date):
                raise ValueError('PR cutoff must equal task base commit time')
        for pr in prs:
            commit = pr.get('mergeCommit', {}).get('oid', '')
            if not isinstance(pr['number'], int) or pr['number'] <= 0 or not re.fullmatch(r'[0-9a-f]{40}', commit):
                raise ValueError('PR number and full merge commit required')
            if timestamp(pr['mergedAt']) >= cutoff or timestamp(pr['updatedAt']) >= cutoff:
                raise ValueError('Future PR or metadata is forbidden')
            if commit == task['fixed'] or pr['number'] == int(task.get('upstream', '/0').rstrip('/').split('/')[-1]):
                raise ValueError('Target fix cannot enter cache evidence')
            if not pr.get('title') or not pr.get('diff', '').strip() or not isinstance(pr.get('comments'), list) or not isinstance(pr.get('files'), list) or not isinstance(pr.get('additions'), int):
                raise ValueError('Frozen PR metadata, diff and comments required')
            if pr.get('isGitCommit') or pr.get('hash') or pr.get('source') in ('agent', 'session'):
                raise ValueError('Only PR evidence is allowed')
            if source and subprocess.run(['git', 'merge-base', '--is-ancestor', commit, task['base']], cwd=source, capture_output=True).returncode:
                raise ValueError('PR merge is not an ancestor of the task base')
    return manifest

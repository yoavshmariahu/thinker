"""Freeze recent pre-task GitHub PR evidence; no inference or exploration."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from pr_cache import CACHE_SOURCE, timestamp, validate_pr_manifest


def collect(tasks, source, limit):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=source, text=True).strip()
    def gh(*args):
        return subprocess.check_output(['gh', *args], text=True)
    manifest = {'version': 1, 'cacheSource': CACHE_SOURCE, 'tasks': {}}
    for task in tasks:
        slug = '/'.join(task['upstream'].split('/')[3:5])
        before = git('show', '-s', '--format=%cI', task['base'])
        prs = json.loads(gh('pr', 'list', '--repo', slug, '--state', 'merged', '--limit', '250',
                            '--search', f'merged:<{before} updated:<{before} sort:updated-desc', '--json',
                            'number,title,body,mergedAt,updatedAt,mergeCommit,additions,files'))
        accepted = []
        for pr in sorted(prs, key=lambda p: p['mergedAt'], reverse=True):
            # Metadata edited after the task cutoff cannot be reconstructed safely.
            if timestamp(pr['mergedAt']) >= timestamp(before) or timestamp(pr['updatedAt']) >= timestamp(before):
                continue
            commit = (pr.get('mergeCommit') or {}).get('oid', '')
            if not commit or subprocess.run(['git', 'merge-base', '--is-ancestor', commit, task['base']], cwd=source, capture_output=True).returncode:
                continue
            pr['diff'] = gh('pr', 'diff', str(pr['number']), '--repo', slug)
            comments = json.loads(gh('api', f'repos/{slug}/pulls/{pr["number"]}/comments?per_page=50'))
            pr['comments'] = [f"{c['path']}: {' '.join(c['body'].split())[:400]}" for c in comments
                              if c.get('body') and len(c['body']) > 40 and not c.get('user', {}).get('login', '').endswith('[bot]')
                              and timestamp(c['created_at']) < timestamp(before) and timestamp(c['updated_at']) < timestamp(before)][:12]
            accepted.append(pr)
            if len(accepted) >= max(limit * 3, 60):
                break
        manifest['tasks'][task['id']] = {'repository': slug, 'base': task['base'], 'before': before,
                                         'selection': 'recent-merged-before-base', 'limit': limit, 'prs': accepted}
    return validate_pr_manifest(manifest, tasks, source)


if __name__ == '__main__':
    if os.environ.get('THINKER_TEST') != '1':
        raise SystemExit('THINKER_TEST=1 required')
    p = argparse.ArgumentParser()
    p.add_argument('--tasks', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--limit', type=int, default=20)
    a = p.parse_args()
    if not 1 <= a.limit <= 60 or a.out.exists():
        raise SystemExit('Use a new manifest and a PR limit of 1..60')
    result = collect(json.loads(a.tasks.read_text()), a.source, a.limit)
    with a.out.open('x') as f:
        json.dump(result, f, indent=2)
        f.write('\n')

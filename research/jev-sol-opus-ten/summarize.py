"""Rebuild the comparison from archived run records (no model calls)."""
import hashlib
import json
import os
from pathlib import Path

if os.environ.get('THINKER_TEST') != '1':
    raise SystemExit('THINKER_TEST=1 required')
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
old = json.loads((ROOT / 'research/opus55-five-pairs/results.json').read_text())['records']
opus = []
for p in sorted((ROOT / 'bench/runs').glob('jev-opus-*-20261006/*-hook-0.json')):
    r = json.loads(p.read_text())
    h = next(x for x in old if x['task'] == r['task'] and x['arm'] == 'hook')
    assert r['actualModels'] == ['claude-opus-5-5'] and r['transcriptModelIds'] == ['claude-opus-5-5']
    assert r['effort'] == 'medium' and not r['is_error']
    c = (r.get('grade') or {}).get('criteria', {})
    if h['repo'] != 'mitmproxy':
        assert c['resolvedModel'] == 'claude-opus-5-5'
    new = dict(repo=h['repo'], task=r['task'], model=r['actualModels'], effort=r['effort'],
        session=r['session'], wallMs=r['wall_ms'], toolCalls=r['tools']['calls'],
        inputTokens=r['in_tokens'], outputTokens=r['out_tokens'], injectedNotes=r['tools']['injected'],
        essentialScore=c.get('essential'), essentialPass=c.get('pass'),
        judgeModel=c.get('resolvedModel'), tests=(r.get('grade') or {}).get('tests'),
        diffSha256=hashlib.sha256(r['diff'].encode()).hexdigest())
    opus.append(dict(task=r['task'], historical=h, current=new))
sol = []
reasons = {
 'A-10325': 'Both catch stale quick-OOM eligibility at changed production line 123.',
 'A-10178': 'Both catch premature cleanup timestamp at line 159 and shared deadline at line 190.',
 'A-10141': 'Both catch NumberReady instead of desired DaemonSet size at line 151.',
 'A-10349': 'Both miss the target slash-truncation bug. Both flag a nearby unanchored regex at line 223; this does not count as the historical target bug.',
 'A-10258': 'Both catch loss of the stable zone label at line 657.',
}
for r in json.loads((ROOT/'bench/runs/jev-sol-review-20261006/results.json').read_text()):
    n, h = r['report'], r['historical']['cached']
    calls = [e for e in n['impact']['events'] if e['op'] == 'model']
    assert r['valid'] and all(e['model'] == 'gpt-6.1-sol' and e['provider'] == 'codex' and not e['failed'] for e in calls)
    assert sum(e['tokens']['totalTokens'] for e in calls) == n['tokens']
    hit = r['id'] != 'A-10349'
    sol.append(dict(task=r['id'], historical=dict(tokens=h['tokens'],wallMs=h['elapsedMs'],notes=h['notes']['consulted'],calls=sum(h['models'].values()),hit=hit),
      current=dict(tokens=n['tokens'],wallMs=r['elapsedMs'],notes=n['notes']['consulted'],calls=len(calls),hit=hit,
      gates=n['gates'],strategy=n['strategy'],purposes=[e['purpose'] for e in calls]),scoreReason=reasons[r['id']]))
def totals(rows, keys):
    return {arm:{key:sum(r[arm][key] for r in rows) for key in keys} for arm in ['historical','current']}
result = dict(opus=opus, sol=sol, opusTotals=totals(opus,['wallMs','toolCalls','inputTokens','outputTokens']),
              solTotals=totals(sol,['wallMs','tokens','notes','calls','hit']))
(OUT/'results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k.endswith('Totals')},indent=2))

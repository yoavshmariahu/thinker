"""Summarize all retained attempts; never select the best repetition."""
import collections, hashlib, json, pathlib
ROOT = pathlib.Path(__file__).resolve().parent
runs = []
for file in sorted((ROOT / 'raw').glob('*/result.json')):
    row = json.loads(file.read_text())
    protocol = json.loads((file.parent / 'protocol.json').read_text())
    usage = [json.loads(line) for line in (file.parent / 'usage.jsonl').read_text().splitlines()]
    models = [event for event in usage if event.get('op') == 'model']
    pending = ROOT.parent.parent / 'bench/runs/pr-mining-fix' / file.parent.name / '.thinker/state/learning-pending'
    runs.append(dict(run=file.parent.name, protocol=protocol, result=row['result'], noteCount=len(row['notes']),
        retrieved=[n['id'] for n in row['retrieval']['included']], replay=row.get('replay'), wallSeconds=row['wallMs']/1000,
        writerCalls=sum(e.get('purpose') in ['mine-prs','mine-prs-repair'] for e in models),
        repairCalls=sum(e.get('purpose') == 'mine-prs-repair' for e in models),
        failedCalls=[{k:e.get(k) for k in ['provider','model','purpose','attempt','errorCode','errorQuestion','errorReason']} for e in models if e.get('failed')],
        modelCounts=dict(collections.Counter(e.get('model') for e in models)),
        pendingCount=len(list(pending.glob('*.json')))))
replays={}
for label in ['baseline','complete-evidence','final-replay']:
    file=ROOT/'raw'/label/'results.json'
    if file.exists():
        rows=json.loads(file.read_text())
        replays[label]={'proposals':len(rows),'accepted':sum(len(r['result']['notes']) for r in rows),'reasons':dict(collections.Counter(d['reason'] for r in rows for d in r['result']['deferred']))}
controls={}
for label in ['controls','controls-v2']:
    file=ROOT/'raw'/label/'results.json'
    if file.exists():
        rows=json.loads(file.read_text())
        controls[label]={'cases':len(rows),'truePositive':sum(r['expected'] and r['accepted'] for r in rows),'falseNegative':sum(r['expected'] and not r['accepted'] for r in rows),'falsePositive':sum(not r['expected'] and r['accepted'] for r in rows),'trueNegative':sum(not r['expected'] and not r['accepted'] for r in rows)}
summary={'runs':runs,'replays':replays,'controls':controls}
(ROOT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for r in runs:print(r['run'],r['noteCount'],'notes,',len(r['retrieved']),'retrieved,',r['result'].get('failed',0),'failed PRs')
print(json.dumps({'replays':replays,'controls':controls},indent=2))

"""Read live progress and enforce the already-frozen failed-model-call gate early."""
import json,os,pathlib,sys
assert os.environ.get('THINKER_TEST')=='1'
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'research/performance-canary'))
from guardrails import stop
OUT=ROOT/'bench/runs/cache-effectiveness';STATE=OUT/'state';RAW=OUT/'raw'
rows=[]
for repo in sorted(STATE.glob('*-pr-cache')):
    local=repo/'.thinker';log=local/'log.jsonl'
    if not log.exists():continue
    events=[]
    for line in log.read_text().splitlines():
        try:events.append(json.loads(line))
        except json.JSONDecodeError:pass # writer may be appending the final line
    failed=[e for e in events if e.get('op')=='model' and e.get('failed')]
    if failed:stop(OUT,f"{repo.name}: failed model attempt ({failed[0].get('purpose')}: {failed[0].get('errorReason','inspect usage')})")
    progress=[]
    for file in (local/'state').glob('pr-mining-*.jsonl'):
        for line in file.read_text().splitlines():
            try:progress.append(json.loads(line))
            except json.JSONDecodeError:pass
    starts=[p.get('item') for p in progress if p.get('event')=='start']
    completed=[p for p in progress if p.get('event')=='complete']
    notes={p.stem for d in [local/'notes',local/'local/notes'] for p in d.glob('*.json')}
    rows.append({'cache':repo.name,'PRsProcessed':len(completed),'current':starts[-1] if starts else None,'notes':len(notes),
                 'modelCalls':sum(e.get('op')=='model' for e in events),'failedCalls':len(failed),
                 'pending':len(list((local/'state/learning-pending').glob('*.json')))})
print(json.dumps({'stopped':json.loads((OUT/'STOPPED.json').read_text()) if (OUT/'STOPPED.json').exists() else None,
                  'cacheReceipts':len(list(RAW.glob('*-pr-build.json'))),'retrievals':len(list(RAW.glob('*-thinker-retrieval.json'))),
                  'codingRuns':len([p for p in RAW.glob('*.json') if p.stem.endswith(('-baseline','-thinker'))]),'caches':rows},indent=2))

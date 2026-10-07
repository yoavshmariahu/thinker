"""Report frozen PR-only canary results, preserving missing counters and failures."""
import collections,hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'bench/runs/cache-effectiveness';RAW=OUT/'raw';DEST=pathlib.Path(__file__).resolve().parent
MODELS=['opus','sol','gemini']
def read(path,default=None):return json.loads(path.read_text()) if path.exists() else default
def total(rows,key):
    values=[r.get(key) for r in rows]
    return {'knownTotal':sum(v for v in values if v is not None),'unknownRuns':sum(v is None for v in values)}
def normalize(provider,usage,original=None):
    if provider=='gemini':
        keys=['input_tokens','output_tokens','cache_read_tokens']
        if not isinstance(usage,dict) or any(usage.get(k) is None for k in keys):return {k:None for k in ['inputTokens','outputTokens','cacheReadTokens','totalTokens']}
        return {'inputTokens':usage['input_tokens']+usage['cache_read_tokens'],'outputTokens':usage['output_tokens'],'cacheReadTokens':usage['cache_read_tokens'],'totalTokens':sum(usage[k] for k in keys)}
    return original or {}
def passed(grade,kind):
    g=grade.get(kind,{})
    return g.get('returncode')==0 and g.get('passed',0)>0 and g.get('failures')==0 and g.get('errors')==0
cases=[];builds=[];setup=[];retrieval_calls=[]
tasks=read(OUT/'tasks.json',[])
for t in tasks:
    for model in MODELS:
        prefix=f"{t['id']}-{model}"
        build=read(RAW/f'{prefix}-pr-build.json',{})
        retrieval=read(RAW/f'{prefix}-thinker-retrieval.json',{})
        repo=OUT/'state'/f'{prefix}-pr-cache'
        events=build.get('records',[])
        if not events and (repo/'.thinker/log.jsonl').exists():events=[json.loads(l) for l in (repo/'.thinker/log.jsonl').read_text().splitlines()]
        for e in events:
            if e.get('op')=='model':setup.append({'task':t['id'],'cohort':model,**{k:e.get(k) for k in ['purpose','provider','model','failed','attempt']},**normalize(e.get('provider'),e.get('usage'),e.get('tokens'))})
        note_files=list((repo/'.thinker/local/notes').glob('*.json'))+list((repo/'.thinker/notes').glob('*.json'))
        progress=[]
        for file in (repo/'.thinker/state').glob('pr-mining-*.jsonl'):
            progress.extend(json.loads(line) for line in file.read_text().splitlines())
        serving_log=OUT/'state'/f'{prefix}-thinker'/'.thinker/log.jsonl'
        orientations=[json.loads(line) for line in serving_log.read_text().splitlines() if json.loads(line).get('op')=='orient'] if serving_log.exists() else []
        builds.append({'task':t['id'],'cohort':model,'miningComplete':build.get('valid',False),
                       'ready':bool(retrieval.get('included')),'error':build.get('setupError'),
                       'stage':'readiness-failed' if orientations and not retrieval else 'interrupted' if events and not build else 'not-started',
                       'processedPrs':build.get('processedPrs',[]),'completedPrCount':sum(e.get('event')=='complete' for e in progress),
                       'notes':len(note_files),'served':retrieval.get('included',orientations[-1].get('served',[]) if orientations else []),
                       'pending':len(list((repo/'.thinker/state/learning-pending').glob('*.json'))),
                       'buildMs':build.get('wallMs'),'initialRetrievalMs':retrieval.get('retrievalMs'),
                       'orientationLog':orientations[-1] if orientations else None})
        serving=OUT/'state'/f'{prefix}-thinker'/'.thinker/perf-jev.jsonl'
        if serving.exists():
            for line in serving.read_text().splitlines():
                e=json.loads(line);u=e.get('usage') or {};inp=u.get('input_tokens');out=u.get('output_tokens')
                retrieval_calls.append({'task':t['id'],'cohort':model,'status':e.get('status'),'durationMs':e.get('durationMs'),'inputTokens':inp,'outputTokens':out,'totalTokens':inp+out if inp is not None and out is not None else None})
        for arm in ['baseline','thinker']:
            name=f'{prefix}-{arm}';r=read(RAW/f'{name}.json')
            if r is None:continue
            grade=read(RAW/f'{name}-validation.json',{})
            row={k:r.get(k) for k in ['id','task','cohort','arm','model','effort','valid','returncode','timedOut','inputTokens','outputTokens','cacheReadTokens','tokens','toolCalls','wallMs','error','executionFailure']}
            if model=='gemini':
                u=normalize('gemini',r.get('rawUsage'));row.update({k:u[k] for k in ['inputTokens','outputTokens','cacheReadTokens']});row['tokens']=u['totalTokens'];row['providerReportedTotalTokens']=r.get('tokens')
            row.update(validation=grade,acceptancePass=passed(grade,'acceptance'),modulePass=passed(grade,'module'),patchSha256=hashlib.sha256((RAW/f'{name}.patch').read_bytes()).hexdigest())
            if arm=='thinker':row.update(noteCount=retrieval.get('noteCount'),servedNotes=retrieval.get('included',[]))
            cases.append(row)
cohorts={};pairs=[]
for model in MODELS:
    cohorts[model]={}
    for arm in ['baseline','thinker']:
        rows=[r for r in cases if r['cohort']==model and r['arm']==arm]
        cohorts[model][arm]={'completed':len(rows),'valid':sum(bool(r['valid']) for r in rows),'graded':sum(bool(r['validation']) for r in rows),
                             'acceptancePass':sum(r['acceptancePass'] for r in rows),'modulePass':sum(r['modulePass'] for r in rows),
                             **{k:total(rows,k) for k in ['tokens','inputTokens','outputTokens','cacheReadTokens','toolCalls','wallMs']}}
    setup_rows=[r for r in setup if r['cohort']==model]
    cohorts[model]['setup']={'modelCalls':len(setup_rows),'failedCalls':sum(bool(r['failed']) for r in setup_rows),'tokens':total(setup_rows,'totalTokens'),
                            'byPurpose':{purpose:{'calls':len(rows),'tokens':total(rows,'totalTokens')} for purpose in sorted({r['purpose'] for r in setup_rows}) if (rows:=[r for r in setup_rows if r['purpose']==purpose])}}
    cohorts[model]['retrieval']={'calls':len(rows:=[r for r in retrieval_calls if r['cohort']==model]),'tokens':total(rows,'totalTokens'),'wallMs':total(rows,'durationMs')}
    for t in tasks:
        rows={r['arm']:r for r in cases if r['cohort']==model and r['task']==t['id']}
        if set(rows)!={'baseline','thinker'}:continue
        b,h=rows['baseline'],rows['thinker'];pair={'cohort':model,'task':t['id'],'bothAcceptancePass':b['acceptancePass'] and h['acceptancePass'],'bothModulePass':b['modulePass'] and h['modulePass']}
        for key in ['tokens','toolCalls','wallMs']:
            pair[key+'Ratio']=h[key]/b[key] if b.get(key) and h.get(key) is not None else None
        pairs.append(pair)
summary={'execution':read(OUT/'execution.json'),'stopped':read(OUT/'STOPPED.json'),'cases':cases,'builds':builds,'cohorts':cohorts,'pairs':pairs,
         'accounting':'Codex input includes cached tokens. AGY input/total add separately reported cache reads; output already includes thinking. Setup and retrieval separate; failed/missing counters retained.'}
(DEST/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
(DEST/'setup-usage.json').write_text(json.dumps(setup,indent=2)+'\n')
(DEST/'retrieval-usage.json').write_text(json.dumps(retrieval_calls,indent=2)+'\n')
print(json.dumps({'stopped':summary['stopped'],'buildsReady':sum(b['ready'] for b in builds),'cases':len(cases),'cohorts':cohorts},indent=2))

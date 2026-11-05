#!/usr/bin/env python3
"""Export completed Artemis Claude pairs with reconciled TTL-specific provider costs."""
import argparse,hashlib,json,pathlib,re
p=argparse.ArgumentParser();p.add_argument('--records',required=True);p.add_argument('--report',required=True);p.add_argument('--out',required=True);p.add_argument('--task',required=True);p.add_argument('--id',required=True)
a=p.parse_args();records=pathlib.Path(a.records);out=pathlib.Path(a.out)
report=json.loads(pathlib.Path(a.report).read_text());pair=next(p for p in report['pairs'] if p['task']==a.task)
task=next(t for t in json.loads((records/'tasks.json').read_text())['tasks'] if t['id']==a.task)
prompts=[task['prompt']]+task['turns'];assert len(prompts)==9
assert re.fullmatch(r'[a-z0-9-]+',a.id)
def text(c):
 if isinstance(c,str):return c
 if isinstance(c,list):return '\n'.join(text(v) for v in c)
 return c.get('text','') if isinstance(c,dict) else ''
def scrub(s):
 s=re.sub(r'/private/var/folders/[^\s<>"\']+/T/artemis-worktrees/[^/\s<>"\']+','<checkout>',s)
 s=re.sub(r'/Users/[^/\s]+','~',s);s=re.sub(r'/private/var/folders/[^\s<>"\']*','<temporary path>',s)
 s=re.sub(r'gAAAAAB[A-Za-z0-9_=\-]*','[encrypted value omitted]',s)
 return re.sub(r'sk-[A-Za-z0-9_\-]{20,}','[credential-like value omitted]',s)
def clean(o):return json.loads(scrub(json.dumps(o,ensure_ascii=False)))
meta=dict(id=a.id,price=dict(input=4,read=.2,w1h=8,w5m=5,out=20),cold=0,model='Claude Opus 5.5 · medium',protocol='anthropic',recordedWrites=True,recordedTTL=True,combined=True,judged=True,repo='PostHog',task=a.task,source='Artemis · PostHog '+a.task+' · nine prompts',costData='clearing-'+a.id+'-costs.json',savings=dict(minPercent=pair['savingPercent'],maxPercent=pair['savingPercent'],minDollars=pair['saving'],maxDollars=pair['saving']))
small,full=dict(meta),dict(meta);blobs={};accounting={}
# Snapshot the decision limit used by the pinned experiment build, not a future default.
small['cutPolicy']=full['cutPolicy']={'maxPaybackCalls':20}
def keep(body):
 h=hashlib.sha256(body.encode()).hexdigest()[:16];blobs[h]=body;return h
for arm,side,key in [('control','off','control'),('cut','on','treatment')]:
 rec=json.loads((records/(a.task+'-'+side+'.json')).read_text());priced=next(s for s in report['sessions'] if s['id']==pair[key]);r=rec['raw'].get('armReport') or {'validation':priced['validation']}
 assert r['validation']['thinkerCommit']=='912b18753bd629b60255502cdf1d979fd2659ece'
 assert not rec['row']['invalid']
 dumps=sorted((json.loads(f.read_text()) for f in pathlib.Path(r['validation']['dump']).rglob('*.json')),key=lambda d:d['at'])
 dumps=[d for d in dumps if d['usage'] is not None]
 assert len(dumps)==len(priced['calls'])
 turns=[dict(n=i+1,prompt=scrub(t),steps=[],calls=[],tools={}) for i,t in enumerate(prompts)]
 seen=set();seen_prompts=set();results={};calls=[];current=1;seen_notes=set()
 for k,d in enumerate(dumps,1):
  prior=current;new_cuts=[];present=set()
  for message in d['sent']['messages']:
   role=message['role'];content=message.get('content',[]);content=[dict(type='text',text=content)] if isinstance(content,str) else content
   if role=='user':
    body=text(content)
    matches=[i+1 for i,prompt in enumerate(prompts) if prompt.strip() in body]
    if matches:current=matches[-1];seen_prompts.add(current)
    event=next((e for e in priced['knowledge']['events'] if e['k']==k and e.get('turn',current)==current),None)
    note=re.search(r'<thinker-cache>([\s\S]*?)</thinker-cache>',body)
    if event and note and k not in seen_notes:
     turns[current-1]['steps'].append(dict(kind='knowledge',k=k,text=scrub(note[1].strip())));seen_notes.add(k)
   if role not in ['assistant','user']:continue
   for b in content:
    typ=b.get('type');tid=b.get('tool_use_id') if typ=='tool_result' else b.get('id')
    if typ=='tool_result':
     present.add(tid);body=text(b.get('content'))
     if re.match(r'^\[tool result (?:removed|cleared) by thinker',body):
      result=results.get(tid);assert result,'A cut requires the earlier full result'
      if not result['cut']:result['cut']=k;result['step']['cutAt']=k;new_cuts.append(result)
      continue
    if typ not in ['tool_use','tool_result'] and not(role=='assistant' and typ=='text'):continue
    identity=(typ,tid) if tid else (typ,current,b.get('text',''))
    if identity in seen:continue
    seen.add(identity);turn=turns[current-1]
    if typ=='tool_use':
     name=b['name'];turn['steps'].append(dict(kind='tool',id=tid,name=name,input=clean(b['input'])));turn['tools'][name]=turn['tools'].get(name,0)+1
    elif typ=='tool_result':
     body=scrub(text(b.get('content')));st=dict(kind='result',id=tid,chars=len(body),lines=body.count('\n')+1,blob=keep(body),error=bool(b.get('is_error')))
     turn['steps'].append(st);results[tid]=dict(c=len(body),at=k,t=current,cut=None,step=st)
    elif b.get('text'):turn['steps'].append(dict(kind='say',text=scrub(b['text'])))
  current=max(prior,current)
  c={key:priced['calls'][k-1][key] for key in ['k','input','read','write','write1h','write5m','out','compacted','held']};c['t']=current
  if new_cuts:c['cut']=dict(observed=True,tokens=round(sum(x['c'] for x in new_cuts)/4),results=len(new_cuts))
  if k>1 and priced['calls'][k-2]['compacted']:
   for tid,result in results.items():
    if tid not in present and 'until' not in result:result['until']=k
  calls.append(c);turns[current-1]['calls'].append(k);turns[current-1]['steps'].append(dict(kind='call',k=k))
 assert seen_prompts==set(range(1,10)),seen_prompts
 assert seen_notes==set(e['k'] for e in priced['knowledge']['events'])
 last=next((s for s in reversed(rec['transcript']['steps']) if s['kind']=='assistant'),None)
 if last:turns[-1]['steps'].append(dict(kind='say',text=scrub(last['text'])))
 cost=sum((c['input']*4+c['read']*.2+c['write1h']*8+c['write5m']*5+c['out']*20)/1e6 for c in calls)
 assert abs(cost-priced['cost'])<1e-8
 armdata=dict(calls=calls,outcome='Judge passed' if priced['pass'] else 'Judge failed',elapsedMs=priced['elapsedMs'],knowledgeEvents=priced['knowledge']['events'],knowledgeEstimateBasis=priced['knowledge']['basis'],judgment=dict(clean(priced['grade']) if isinstance(priced['grade'],dict) else {'details':clean(priced['grade'])}, **{'pass':priced['pass']}))
 small[arm]=dict(**armdata,results=[{k:v for k,v in result.items() if k!='step'} for result in results.values()],notes=[],turns=[{k:t[k] for k in ['n','tools','calls']} for t in turns])
 full[arm]=dict(**armdata,turns=turns)
 accounting[side]={k:priced[k] for k in ['id','task','pass','elapsedMs','cost','components','calls','nativeCompactionCost']}
full['blobs']=blobs
for suffix,data in [('',small),('-session',full),('-costs',dict(experiment=report['experiment'],pricing=report['pricing'],basis=report['basis'],pair=pair,sessions=accounting))]:
 raw=json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n'
 assert not re.search(r'/Users/|/private/var/folders/|gAAAAAB|encrypted_content|"authorization"',raw)
 f=out/f'clearing-{a.id}{suffix}.json';f.write_text(raw);print(f)

#!/usr/bin/env python3
"""Export an Artemis Codex pair + its per-request proxy dumps, not cumulative CLI totals.
Usage: site-codex.py --control session-api.json --cut session-api.json --task pool.json
       --reconciliation artemis-proxy-cost-report.json --out site
The dump paths come from each archived arm report. No model calls or grading here.
"""
import argparse,collections,hashlib,json,pathlib,re
p=argparse.ArgumentParser()
for k in ['control','cut','task','reconciliation','out']:p.add_argument('--'+k,required=True)
a=p.parse_args();task=json.loads(pathlib.Path(a.task).read_text())['tasks'][0];prompts=[task['prompt']]+task['turns'];prices=dict(input=10,read=1,w5m=0,w1h=0,out=50)
small=dict(id='django-astra',price=prices,cold=0,model='GPT-6 Astra · high',protocol='responses',codexBilling=True,writeCountsRecorded=False,source='Artemis · Django PR21834 · 14 prompts · one pair',judgeModel='gpt-6-astra')
full={**small};blobs={}
def scrub(s):
 s=re.sub(r'/private/var/folders/[^\s<>"\']+/T/artemis-worktrees/[^/\s<>"\']+', '<checkout>',s)
 s=re.sub(r'/Users/[^/\s]+', '~',s)
 return s
def text(x):
 if isinstance(x,str):return x
 if isinstance(x,list):return '\n'.join(text(i) for i in x)
 if isinstance(x,dict):return x.get('text','')
 return ''
def keep(t):
 key=hashlib.sha256(t.encode()).hexdigest()[:16];blobs[key]=t;return key
reconciliation=json.loads(pathlib.Path(a.reconciliation).read_text());assert len(reconciliation['pairs'])==1 and not reconciliation['excluded'];pair=reconciliation['pairs'][0]
# The page derives one saving from recorded input/read/output at the displayed rates.
# Codex credit billing has no separate write charge; API write-price bounds do not apply.
for arm in ['control','cut']:
 rec=json.loads(pathlib.Path(getattr(a,arm)).read_text());raw=rec['raw'];report=raw['armReport'];assert raw['model']=='gpt-6-astra' and raw['turns']==14 and not rec['row']['invalid'];assert report['validation']['proxyObserved']
 ds=sorted([json.loads(f.read_text())for f in pathlib.Path(report['validation']['dump']).rglob('*.json')],key=lambda d:d['at']);assert ds
 turns=[dict(n=i+1,prompt=scrub(t),steps=[],calls=[],tools={})for i,t in enumerate(prompts)]
 seen=set();resultmap={};calls=[];seen_prompts=set()
 for k,d in enumerate(ds,1):
  sent=d['sent'];assert sent['model']=='gpt-6-astra';assert not sent.get('service_tier') and not sent.get('prompt_cache_options') and not sent.get('prompt_cache_retention');u=d['usage'];assert 0<=u['read']<=u['input']<=272000
  current=1;new_cuts=[]
  for item in sent['input']:
   typ=item.get('type');ident=item.get('id')
   if item.get('role')=='user':
    body=text(item.get('content'));matches=[i+1 for i,t in enumerate(prompts)if body.startswith(t)]
    if matches:current=matches[0];seen_prompts.add(current)
    continue
   if typ in ['function_call_output','custom_tool_call_output']:
    tid=item['call_id'];body=text(item.get('output'));prior=resultmap.get(tid)
    if body.startswith("[thinker: an older turn's tool output was cleared."):
     assert prior,'Original result is missing from earlier requests'
     if not prior.get('cut'):prior['cut']=k;prior['step']['cutAt']=k;new_cuts.append(prior)
     continue
   if not ident or ident in seen:continue
   seen.add(ident);t=turns[current-1]
   if typ in ['function_call','custom_tool_call']:
    name=item.get('name','tool');inp=scrub(item.get('input',item.get('arguments','')))
    t['steps'].append(dict(kind='tool',id=item['call_id'],name=name,input=dict(command=inp)));t['tools'][name]=t['tools'].get(name,0)+1
   elif typ in ['function_call_output','custom_tool_call_output']:
    body=scrub(text(item.get('output')));st=dict(kind='result',id=item['call_id'],chars=len(body),lines=body.count('\n')+1,blob=keep(body),error=False);t['steps'].append(st)
    resultmap[item['call_id']]=dict(id=item['call_id'],c=len(body),at=k,t=current,cut=None,step=st)
   elif item.get('role')=='assistant':
    body=scrub(text(item.get('content')))
    if body:t['steps'].append(dict(kind='say',text=body))
   # Reasoning payloads and environment/system messages are deliberately not exported.
  c=dict(k=k,t=current,read=u['read'],write=0,input=u['input']-u['read'],out=u['out'])
  if new_cuts:c['cut']=dict(observed=True,tokens=round(sum(r['c'] for r in new_cuts)/4),results=len(new_cuts))
  calls.append(c);turns[current-1]['calls'].append(k);turns[current-1]['steps'].append(dict(kind='call',k=k))
 assert seen_prompts==set(range(1,15)),seen_prompts
 for key,field in [('input','input'),('read','cachedInput'),('out','output')]:assert sum(d['usage'][key]for d in ds)==sum(g[field]for g in report['responses'].values()),'API report mismatch'
 last=next((s for s in reversed(rec['transcript']['steps'])if s['kind']=='assistant'),None)
 if last:turns[-1]['steps'].append(dict(kind='say',text=scrub(last['text'])))
 grade=raw['grade'];assert rec['row']['judge']=='gpt-6-astra' and grade['pass'] and all(x['verdict']=='met' for x in grade['results'])
 judged=dict(pass_=grade['pass'],met=len(grade['results']),total=len(task['criteria']),criteria=task['criteria'],verdicts=grade['results']);judged['pass']=judged.pop('pass_')
 armdata=dict(calls=calls,judgment=judged,outcome=f"{len(grade['results'])}/{len(task['criteria'])} criteria met")
 small[arm]={**armdata,'results':[{k:v for k,v in r.items()if k not in ['id','step']}for r in resultmap.values()],'notes':[],'turns':[{k:t[k]for k in ['n','tools','calls']}for t in turns]}
 full[arm]={**armdata,'turns':turns}
full['blobs']=blobs
for name,data in [('clearing-django-astra.json',small),('clearing-django-astra-session.json',full)]:
 dest=pathlib.Path(a.out)/name;dest.write_text(json.dumps(data,separators=(',',':'),ensure_ascii=False)+'\n');print(dest)

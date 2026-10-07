"""Matched coding CLIs; checkpoints preserve failures instead of selective retries."""
import json,os,subprocess,sys,time,hashlib,re,shutil
from pathlib import Path
assert os.environ.get('THINKER_TEST')=='1'
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'research/performance-canary';RAW=OUT/'raw';STATE=OUT/'state'
if (OUT/'STOPPED.json').exists():raise SystemExit('Canary stopped as invalid for efficiency. Preserve these results; use a reviewed fresh protocol for another run.')
TASKS=json.loads((OUT/'tasks.json').read_text());MODELS={'opus':'claude-opus-5-5','sol':'gpt-6.1-sol','gemini':'gemini-3.8-flash-high'}
ENV={**os.environ,'THINKER_TEST':'1','THINKER_TELEMETRY':'off','THINKER_LOG':'local','THINKER_NO_LEARN':'1','THINKER_NO_BG_VERIFY':'1','THINKER_MCP':'off','THINKER_NO_AUTO_UPDATE':'1','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'}
ENV.pop('MAX_THINKING_TOKENS',None)
def run(t,m,arm):
 name=f"{t['id']}-{m}-{arm}";out=RAW/(name+'.json');cwd=STATE/name
 if out.exists():return json.loads(out.read_text())
 learn=arm=='learn';rules=f"Work only within this repository. Do not inspect parent or sibling directories, git history/remotes, reference patches, hidden evaluator tests or websites. Do not install dependencies, create commits or delegate. Machine-wide memory hooks and MCP are disabled. You may execute the preinstalled test interpreter {ROOT}/.venv-perf/bin/python with PYTHONPATH=src."
 if learn:
  prompt=rules+'\nExplore the current code without modifying files. '+t['learning']+'\nAfter exploring, return ONLY a JSON object with notes: an array of 1 to 3 reusable notes. Each note has kind (map, rule or howto), title, answers (2-4 questions), body (3-8 concise lines with repository-relative file:symbol pointers), applies (scope), confidence (0-1), and deps (array of {path,symbol}, with exact existing definitions). Record observed mechanisms and constraints, not guesses or proposed changes. Do not invent new behavior.'
 else:
  memory=''
  if arm=='thinker':memory=(RAW/(name+'-retrieval.json')).read_text();memory=json.loads(memory)['text'];memory+='\nYou may execute thinker_lookup "specific question" for more cached knowledge; resolve its pointers inside this checkout. Do not inspect the helper itself.'
  prompt=rules+'\nImplement the requested change, add appropriate tests, run relevant tests, leave the patch uncommitted and summarize the result.\n\nPRIOR REPOSITORY KNOWLEDGE:\n'+(memory or '(none)')+'\n\nREQUEST:\n'+t['prompt']
 (RAW/(name+'-prompt.txt')).write_text(prompt)
 env={**ENV,'PYTHONPATH':str(cwd/'src'),'PATH':str(STATE/'bin')+os.pathsep+ENV['PATH']}
 if m=='sol':
  home=STATE/('home-'+name);home.mkdir(exist_ok=True);auth=home/'auth.json'
  if not auth.exists():auth.symlink_to('/Users/yoavshmariahu/src/thinker/bench/codex-home/auth.json')
  env['CODEX_HOME']=str(home)
  cmd=['codex','exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--strict-config','--config','model_reasoning_effort="high"','--config','web_search="disabled"','--config','features.multi_agent=false','--model',MODELS[m],'--sandbox','read-only' if learn else 'workspace-write','--cd',str(cwd),'-']
 elif m=='opus':
  cmd=['claude','-p','--model',MODELS[m],'--effort','high','--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--tools','Bash,Read,Glob,Grep' if learn else 'Bash,Read,Write,Edit,Glob,Grep','--permission-mode','bypassPermissions','--max-turns','80']
 else:cmd=['agy','-p',prompt,'--model',MODELS[m],'--effort','high','--output-format','json','--mode','plan' if learn else 'accept-edits','--dangerously-skip-permissions','--disable-slash-commands']
 (RAW/(name+'-invocation.json')).write_text(json.dumps({'model':MODELS[m],'effort':'high','cwd':str(cwd),'argv':[x if x!=prompt else '<saved prompt>' for x in cmd],'thinkerCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'testMode':True},indent=2))
 print('START',name,flush=True);start=time.monotonic();timed=False
 try:p=subprocess.run(cmd,input=None if m=='gemini' else prompt,cwd=cwd,env=env,text=True,capture_output=True,timeout=1200);stdout=p.stdout;stderr=p.stderr;code=p.returncode
 except subprocess.TimeoutExpired as e:stdout=(e.stdout or b'').decode() if isinstance(e.stdout,bytes) else e.stdout or '';stderr=str(e.stderr or '');code=-1;timed=True
 (RAW/(name+'.events.jsonl')).write_text(stdout);(RAW/(name+'.stderr')).write_text(stderr)
 r={'id':name,'task':t['id'],'cohort':m,'arm':arm,'model':MODELS[m],'effort':'high','wallMs':round((time.monotonic()-start)*1000),'returncode':code,'timedOut':timed,'valid':False,'tokens':None,'toolCalls':None,'answer':''}
 try:
  if m=='gemini':
   j=json.loads(stdout);r['rawUsage']=j.get('usage');r['answer']=j.get('response','');r['tokens']=(j.get('usage') or {}).get('total_tokens');r['valid']=code==0 and j.get('status')=='SUCCESS' and bool(r['answer']);r['conversationId']=j.get('conversation_id');r['inputTokens']=(j.get('usage') or {}).get('input_tokens');r['outputTokens']=(j.get('usage') or {}).get('output_tokens');r['cacheReadTokens']=(j.get('usage') or {}).get('cache_read_tokens')
   brain=Path.home()/'.gemini/antigravity-cli/brain'/str(j.get('conversation_id','none'))/'.system_generated/logs/transcript.jsonl'
   if brain.exists():
    shutil.copyfile(brain,RAW/(name+'.transcript.jsonl'));ev=[json.loads(l) for l in brain.read_text().splitlines() if l.strip()];r['toolCalls']=sum(len(x.get('tool_calls',[])) for x in ev)
    switches=re.findall(r'Model Selection` from [^\n]*? to ((?:Gemini|Claude|GPT)[^\n]*?\([^)]*\))',brain.read_text());r['reportedModelSelections']=list(set(switches));
    if any(x!='Gemini 3.8 Flash (High)' for x in switches):raise ValueError('Gemini model mismatch')
  else:
   ev=[json.loads(l) for l in stdout.splitlines() if l.startswith('{')]
   if m=='sol':
    uu=[x['usage'] for x in ev if x.get('type')=='turn.completed'];r['rawUsage']=uu;r['inputTokens']=sum(u.get('input_tokens',0) for u in uu);r['outputTokens']=sum(u.get('output_tokens',0) for u in uu);r['cacheReadTokens']=sum(u.get('cached_input_tokens',0) for u in uu);r['tokens']=r['inputTokens']+r['outputTokens'];items=[x['item'] for x in ev if x.get('type')=='item.completed'];r['toolCalls']=sum(x.get('type') not in ['reasoning','agent_message'] for x in items);r['answer']='\n'.join(x.get('text','') for x in items if x.get('type')=='agent_message');r['valid']=code==0 and bool(uu) and not any(x.get('type') in ['error','turn.failed'] for x in ev)
   else:
    j=[x for x in ev if x.get('type')=='result'][-1];u=j.get('usage',{});r['rawUsage']=u;r['modelUsage']=j.get('modelUsage',{});r['inputTokens']=sum(u.get(k,0) for k in ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens']);r['outputTokens']=u.get('output_tokens',0);r['cacheReadTokens']=u.get('cache_read_input_tokens',0);r['tokens']=r['inputTokens']+r['outputTokens'];r['toolCalls']=sum(b.get('type')=='tool_use' for x in ev if x.get('type')=='assistant' for b in x.get('message',{}).get('content',[]));r['answer']=j.get('result','');r['valid']=code==0 and not j.get('is_error') and list(r['modelUsage'])==[MODELS[m]]
  if not r['valid']:r['error']='Provider failure or identity mismatch; inspect native events'
 except Exception as e:r['error']=str(e);r['valid']=False
 if learn and r['valid']:
  try:
   a=r['answer'];start=a.find('{');end=a.rfind('}')+1;notes=json.loads(a[start:end])['notes'];assert isinstance(notes,list) and 0<len(notes)<=3;r['notes']=notes
  except Exception as e:r['valid']=False;r['error']='Invalid learning notes JSON: '+str(e)
 elif not learn:
  subprocess.run(['git','add','-A','--','src','tests','docs','CHANGES.rst','CHANGES.md'],cwd=cwd,env=env,capture_output=True)
  # Explicit path list can include absent paths; stage tracked changes and new source/tests individually.
  for d in ['src','tests','docs','CHANGES.rst','CHANGES.md']:
   if (cwd/d).exists():subprocess.run(['git','add','-A','--',d],cwd=cwd,env=env,check=True,capture_output=True)
  (RAW/(name+'.patch')).write_bytes(subprocess.check_output(['git','diff','--cached','--binary','--no-color'],cwd=cwd))
 out.write_text(json.dumps(r,indent=2)+'\n');print('DONE',name,'valid='+str(r['valid']),'tokens='+str(r['tokens']),'seconds='+str(r['wallMs']/1000),flush=True);return r
if __name__=='__main__':
 mode,m=sys.argv[1:3]
 for i,t in enumerate(TASKS):
  if mode=='learn':
   if not run(t,m,'learn')['valid']:raise SystemExit('Learning failed; cohort paused before coding')
  else:
   for arm in (['baseline','thinker'] if (i+list(MODELS).index(m))%2==0 else ['thinker','baseline']):run(t,m,arm)

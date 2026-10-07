"""Matched coding CLIs; checkpoints preserve failures instead of selective retries."""
import json,os,subprocess,sys,time,hashlib,re,shutil
from pathlib import Path
from guardrails import run_dir, checked_execution, checked_ready, stop, supervised, guarded_env, checked_wiring, assert_served_by_jev
import wiring as wiring_mod
assert os.environ.get('THINKER_TEST')=='1'
if len(sys.argv) < 3 or sys.argv[1] != 'solve':
 raise SystemExit('Only solve is allowed. Build caches from recent PRs with pipeline.py build; exploration/session distillation is forbidden.')
ROOT=Path(__file__).resolve().parents[2];OUT=run_dir();RAW=OUT/'raw';STATE=OUT/'state'
if (OUT/'STOPPED.json').exists():raise SystemExit('Canary stopped as invalid for efficiency. Preserve these results; use a reviewed fresh protocol for another run.')
EXECUTION=checked_execution(OUT)
# The cohorts and their exact models come from the frozen protocol, never from a literal here.
TASKS=json.loads((OUT/'tasks.json').read_text());MODELS=EXECUTION['models']
ENV={**os.environ,'THINKER_TEST':'1','THINKER_TELEMETRY':'off','THINKER_LOG':'local','THINKER_NO_LEARN':'1','THINKER_NO_BG_VERIFY':'1','THINKER_MCP':'off','THINKER_NO_AUTO_UPDATE':'1','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'}
ENV.pop('MAX_THINKING_TOKENS',None)
def run(t,m,arm):
 name=f"{t['id']}-{m}-{arm}";out=RAW/(name+'.json');cwd=STATE/name
 if out.exists():return json.loads(out.read_text())
 if arm not in ['baseline','thinker']:raise ValueError('Session exploration is forbidden')
 checked_ready(OUT,TASKS)
 rules=f"Work only within this repository. Do not inspect parent or sibling directories, git history/remotes, reference patches, hidden evaluator tests or websites. Do not install dependencies, create commits or delegate. Machine-wide memory hooks and MCP are disabled. Use {ROOT}/.venv-perf/bin/python for local probes and relevant tests. Keep the inherited test environment. Stress tests, clearing pytest addopts, disabling plugins, and broad repeated test runs are forbidden. Pytest is limited to 2000 tests and 120 seconds; a violation stops the batch."
 # Both arms receive the same request. The cache reaches the thinker arm the way it reaches a real
 # session -- the prompt hook's bundle and the MCP server -- so the wiring is the only difference,
 # and the guidance the agent reads is the shipped text rather than a copy of it in this file.
 receipt=checked_wiring(OUT,name,'claude' if m=='opus' else 'codex',cwd) if arm=='thinker' else None
 prompt=rules+'\nImplement the requested change, add appropriate tests, run relevant tests, leave the patch uncommitted and summarize the result.\n\nREQUEST:\n'+t['prompt']
 (RAW/(name+'-prompt.txt')).write_text(prompt)
 env={**guarded_env(cwd,RAW/(name+'.violation.json'),base=ENV,wiring=arm=='thinker'),'PATH':str(STATE/'bin')+os.pathsep+ENV['PATH']}
 env.pop('MAX_THINKING_TOKENS',None)
 if m=='sol':
  home=STATE/('home-'+name);home.mkdir(exist_ok=True);auth=home/'auth.json'
  if not auth.exists():
   source=Path(os.environ.get('THINKER_CODEX_AUTH','')).expanduser()
   if not source.is_file():raise SystemExit('Set THINKER_CODEX_AUTH to the Codex auth.json to use for this run')
   auth.symlink_to(source)
  env['CODEX_HOME']=str(home)
  cmd=['codex','exec','--json','--ephemeral','--ignore-rules','--strict-config','--config','model_reasoning_effort="high"','--config','web_search="disabled"','--config','features.multi_agent=false','--model',MODELS[m],'--sandbox','workspace-write','--cd',str(cwd),'-']
 elif m=='opus':
  tools=','.join(wiring_mod.tools_for('claude',arm,['Bash','Read','Write','Edit','Glob','Grep']))
  mcp=wiring_mod.agent_argv('claude',cwd,receipt) if receipt else ['--strict-mcp-config','--mcp-config','{"mcpServers":{}}']
  cmd=['claude','-p','--model',MODELS[m],'--effort','high','--output-format','stream-json','--verbose','--no-session-persistence','--setting-sources','',*mcp,'--disable-slash-commands','--tools',tools,'--permission-mode','bypassPermissions','--max-turns','80']
 else:cmd=['agy','-p',prompt,'--model',MODELS[m],'--effort','high','--output-format','json','--mode','accept-edits','--dangerously-skip-permissions','--disable-slash-commands']
 (RAW/(name+'-invocation.json')).write_text(json.dumps({'model':MODELS[m],'effort':'high','cwd':str(cwd),'argv':[x if x!=prompt else '<saved prompt>' for x in cmd],'thinkerCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'testMode':True},indent=2))
 print('START',name,flush=True);start=time.monotonic();timed=False
 execution=supervised(cmd,cwd=cwd,env=env,prefix=RAW/name,seconds=EXECUTION['agentSeconds'],batch=OUT,input_text=None if m=='gemini' else prompt,native_root=Path.home()/'.gemini/antigravity-cli/brain' if m=='gemini' else None,wiring=arm=='thinker')
 stdout=execution['stdout'];stderr=execution['stderr'];code=execution['returncode'];timed=execution['reason']=='timeout'
 r={'id':name,'task':t['id'],'cohort':m,'arm':arm,'model':MODELS[m],'effort':'high','wallMs':round((time.monotonic()-start)*1000),'returncode':code,'timedOut':timed,'valid':False,'tokens':None,'toolCalls':None,'answer':'','executionFailure':execution['reason']}
 try:
  if m=='gemini':
   j=json.loads(stdout);r['rawUsage']=j.get('usage');r['answer']=j.get('response','');r['tokens']=(j.get('usage') or {}).get('total_tokens');r['valid']=code==0 and j.get('status')=='SUCCESS' and bool(r['answer']);r['conversationId']=j.get('conversation_id');r['inputTokens']=(j.get('usage') or {}).get('input_tokens');r['outputTokens']=(j.get('usage') or {}).get('output_tokens');r['cacheReadTokens']=(j.get('usage') or {}).get('cache_read_tokens')
   brain=Path.home()/'.gemini/antigravity-cli/brain'/str(j.get('conversation_id','none'))/'.system_generated/logs/transcript.jsonl'
   if brain.exists():
    shutil.copyfile(brain,RAW/(name+'.transcript.jsonl'));ev=[json.loads(l) for l in brain.read_text().splitlines() if l.strip()];r['toolCalls']=sum(len(x.get('tool_calls',[])) for x in ev)
    switches=re.findall(r'Model Selection` from [^\n]*? to ((?:Gemini|Claude|GPT)[^\n]*?\([^)]*\))',brain.read_text());r['reportedModelSelections']=list(set(switches));
    if not switches or any(x!='Gemini 3.8 Flash (High)' for x in switches):raise ValueError('Gemini model mismatch')
  else:
   ev=[json.loads(l) for l in stdout.splitlines() if l.startswith('{')]
   if m=='sol':
    uu=[x['usage'] for x in ev if x.get('type')=='turn.completed'];r['rawUsage']=uu;r['inputTokens']=sum(u.get('input_tokens',0) for u in uu);r['outputTokens']=sum(u.get('output_tokens',0) for u in uu);r['cacheReadTokens']=sum(u.get('cached_input_tokens',0) for u in uu);r['tokens']=r['inputTokens']+r['outputTokens'];items=[x['item'] for x in ev if x.get('type')=='item.completed'];r['toolCalls']=sum(x.get('type') not in ['reasoning','agent_message'] for x in items);r['answer']='\n'.join(x.get('text','') for x in items if x.get('type')=='agent_message');r['valid']=code==0 and bool(uu) and not any(x.get('type') in ['error','turn.failed'] for x in ev)
    if not uu:r['inputTokens']=r['outputTokens']=r['cacheReadTokens']=r['tokens']=None
   else:
    j=[x for x in ev if x.get('type')=='result'][-1];u=j.get('usage',{});r['rawUsage']=u;r['modelUsage']=j.get('modelUsage',{});r['inputTokens']=sum(u.get(k,0) for k in ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens']);r['outputTokens']=u.get('output_tokens',0);r['cacheReadTokens']=u.get('cache_read_input_tokens',0);r['tokens']=r['inputTokens']+r['outputTokens'];r['toolCalls']=sum(b.get('type')=='tool_use' for x in ev if x.get('type')=='assistant' for b in x.get('message',{}).get('content',[]));r['answer']=j.get('result','');r['valid']=code==0 and not j.get('is_error') and list(r['modelUsage'])==[MODELS[m]]
  if not r['valid']:r['error']='Provider failure or identity mismatch; inspect native events'
 except Exception as e:r['error']=str(e);r['valid']=False
 if execution['reason']:r['valid']=False;r['error']=execution['reason']
 subprocess.run(['git','add','-A','--','src','tests','docs','CHANGES.rst','CHANGES.md'],cwd=cwd,env=env,capture_output=True)
 # Explicit path list can include absent paths; stage tracked changes and new source/tests individually.
 for d in ['src','tests','docs','CHANGES.rst','CHANGES.md']:
  if (cwd/d).exists():subprocess.run(['git','add','-A','--',d],cwd=cwd,env=env,check=True,capture_output=True)
 (RAW/(name+'.patch')).write_bytes(subprocess.check_output(['git','diff','--cached','--binary','--no-color'],cwd=cwd))
 if arm=='thinker' and r['valid']:
  try:r['serving']=assert_served_by_jev(OUT,name,cwd)
  except Exception as e:r['valid']=False;r['error']=str(e)
 if not r['valid']:stop(OUT,name+': '+r.get('error','invalid result'))
 out.write_text(json.dumps(r,indent=2)+'\n');print('DONE',name,'valid='+str(r['valid']),'tokens='+str(r['tokens']),'seconds='+str(r['wallMs']/1000),flush=True);return r
if __name__=='__main__':
 mode,m=sys.argv[1:3]
 if m not in MODELS:raise SystemExit(f"run.py solve {'|'.join(MODELS)}")
 checked_ready(OUT,TASKS)
 for i,t in enumerate(TASKS):
  for arm in (['baseline','thinker'] if (i+list(MODELS).index(m))%2==0 else ['thinker','baseline']):
   if not run(t,m,arm)['valid']:raise SystemExit('Invalid run; batch stopped')

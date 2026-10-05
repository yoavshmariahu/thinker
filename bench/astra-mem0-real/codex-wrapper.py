#!/usr/bin/env python3
"""Pin and audit every Codex model call; never allow a fallback model."""
import json,os,subprocess,sys,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];RAW=ROOT/'research/astra-mem0-real/raw'
args=sys.argv[1:]
assert args[0]=='exec'
assert '--model' in args and args[args.index('--model')+1]=='gpt-6-astra'
args[1:1]=['-c','model_reasoning_effort="medium"','-c','project_doc_max_bytes=0','-c','web_search="disabled"','--disable','multi_agent','--disable','plugins','--disable','skill_search']
text_only=os.environ.get('ASTRA_TEXT_ONLY')=='1'
if text_only:args[1:1]=['--disable','shell_tool']
label=os.environ.get('ASTRA_CALL_LABEL','model');ident=label+'-'+str(uuid.uuid4())
prompt=sys.stdin.read();start=time.perf_counter()
p=subprocess.run(['/Users/yoavshmariahu/.local/bin/codex',*args],input=prompt,text=True,capture_output=True)
events=[]
for line in p.stdout.splitlines():
 try:events.append(json.loads(line))
 except ValueError:pass
items=[e['item'] for e in events if e.get('type')=='item.completed']
tools=[i for i in items if i.get('type') not in ['agent_message','reasoning']]
record={'model':'gpt-6-astra','reasoning':'medium','argv':args,'cwd':os.getcwd(),'text_only':text_only,'label':label,'wall_ms':(time.perf_counter()-start)*1000,'returncode':p.returncode,'usage':[e['usage'] for e in events if e.get('type')=='turn.completed'],'tool_calls':len(tools),'prompt':prompt,'events':events,'stderr':p.stderr}
(RAW/(ident+'.call.json')).write_text(json.dumps(record,indent=2))
if text_only and tools:
 print('Unexpected tool use in memory building; experiment invalid',file=sys.stderr);sys.exit(3)
sys.stdout.write(p.stdout);sys.stderr.write(p.stderr);sys.exit(p.returncode)

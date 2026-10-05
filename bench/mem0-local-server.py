"""Benchmark-only loopback adapter: genuine Mem0 OSS + Claude CLI, no hosted Mem0."""
import os
os.environ.update(THINKER_TELEMETRY='off', MEM0_TELEMETRY='false', THINKER_HOOKS='off', THINKER_MCP='off', THINKER_NO_LEARN='1', THINKER_NO_BG_VERIFY='1', THINKER_NO_AUTO_UPDATE='1', THINKER_LOG='off', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', HF_HUB_DISABLE_TELEMETRY='1')
import json, time, subprocess, uuid, threading
from pathlib import Path
from fastapi import FastAPI, HTTPException
from mem0 import Memory
ROOT=Path(__file__).resolve().parent.parent
RAW=ROOT/'research/mem0-comparison/raw'
STATE=ROOT/'bench/mem0-state'
STATE.mkdir(exist_ok=True)
os.environ['MEM0_DIR']=str(STATE)
app=FastAPI(telemetry={'auto_configure': False})
memory=None
lock=threading.Lock()
CONFIG={
 'llm':{'provider':'openai','config':{'model':'sonnet','api_key':'local-cli-only','openai_base_url':'http://127.0.0.1:18881/v1','max_tokens':6000}},
 'embedder':{'provider':'fastembed','config':{'model':'BAAI/bge-small-en-v1.5','embedding_dims':384}},
 'vector_store':{'provider':'qdrant','config':{'path':str(STATE/'qdrant'),'collection_name':'comparison','embedding_model_dims':384,'on_disk':True}},
 'history_db_path':str(STATE/'history.db')}
@app.on_event('startup')
def start():
 global memory
 t=time.perf_counter(); memory=Memory.from_config(CONFIG)
 (RAW/'mem0-config.json').write_text(json.dumps({'config':CONFIG,'init_ms':(time.perf_counter()-t)*1000},indent=2))

@app.post('/v1/chat/completions')
def chat(body:dict):
 call_id=str(uuid.uuid4()); t=time.perf_counter()
 system='\n\n'.join(str(m['content']) for m in body['messages'] if m['role']=='system')
 prompt='\n\n'.join(m['role'].upper()+': '+str(m['content']) for m in body['messages'] if m['role']!='system')
 if body.get('response_format',{}).get('type')=='json_object':system+='\nReturn only valid JSON, without markdown fences.'
 args=['claude','-p','--model','claude-sonnet-5-5','--output-format','json','--system-prompt',system or 'Answer the request.','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--disable-slash-commands']
 schema=body.get('response_format',{}).get('json_schema',{}).get('schema')
 if schema:args+=['--json-schema',json.dumps(schema)]
 env={**os.environ,'CLAUDE_CODE_MAX_OUTPUT_TOKENS':str(body.get('max_tokens',body.get('max_completion_tokens',6000)))}
 p=subprocess.run(args,input=prompt,text=True,capture_output=True,cwd=STATE,env=env,timeout=300)
 try:
  result=json.loads(p.stdout)
  if p.returncode or result.get('is_error'):raise ValueError(str(result))
 except Exception as e:raise HTTPException(502,str(e)[:500])
 content=json.dumps(result['structured_output']) if 'structured_output' in result else result.get('result','')
 if content.startswith('```'):content=content.split('\n',1)[1].rsplit('```',1)[0].strip()
 (RAW/('llm-'+call_id+'.json')).write_text(json.dumps({'request':body,'response':result,'wall_ms':(time.perf_counter()-t)*1000},indent=2))
 usage=result.get('usage',{}); inp=sum(usage.get(k,0) for k in ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens']); out=usage.get('output_tokens',0)
 return {'id':call_id,'object':'chat.completion','created':int(time.time()),'model':next(iter(result.get('modelUsage',{})),'sonnet'),'choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':inp,'completion_tokens':out,'total_tokens':inp+out}}

@app.get('/health')
def health():return {'status':'ok'}
@app.post('/memories')
def add(body:dict):
 with lock:
  t=time.perf_counter(); r=memory.add(body['messages'],user_id=body['user_id'],metadata=body.get('metadata'),prompt=body.get('custom_instructions'))
  return {**r,'benchmark_wall_ms':(time.perf_counter()-t)*1000}
@app.post('/search')
def search(body:dict):
 t=time.perf_counter()
 r=memory.search(body['query'],filters={'user_id':body['user_id']},top_k=body.get('top_k',body.get('limit',20)))
 return {**r,'benchmark_wall_ms':(time.perf_counter()-t)*1000}
@app.delete('/memories')
def delete(user_id:str):return memory.delete_all(user_id=user_id)
@app.get('/memories')
def get(user_id:str):return memory.get_all(filters={'user_id':user_id})
if __name__=='__main__':
 import uvicorn
 uvicorn.run(app,host='127.0.0.1',port=18881)

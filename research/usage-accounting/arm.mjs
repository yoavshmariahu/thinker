// Artemis before/after adapter for the Django rerun. Launch only through an approved Artemis plan.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawn,execFileSync} from 'node:child_process';
const [action,session,cwd]=process.argv.slice(2);
if(!session||!cwd||!/^[\w.-]+$/.test(session))throw Error('valid session and worktree required');
const root=path.dirname(new URL(import.meta.url).pathname),variant=process.env.COMPRESSION_ARM;
if(!['on','off'].includes(variant))throw Error('explicit compression arm required');
const dir=path.join(root,'sessions-criteria',variant,session),home=path.join(cwd,'.thinker','codex-home');
const cli=path.resolve(root,'../../src/cli.js'),port=Number(process.env.THINKER_PROXY_PORT);
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(root,'../..'),encoding:'utf8'}).trim();
if(!process.env.EXPECTED_THINKER_COMMIT || commit!==process.env.EXPECTED_THINKER_COMMIT)throw Error('Pinned thinker commit required');
const log=path.join(dir,'proxy.jsonl');
const env={...process.env,THINKER_TEST:'1',THINKER_TELEMETRY:'off',THINKER_HOME:path.join(dir,'thinker-home'),THINKER_PROXY_LOG:log,THINKER_PROXY_DUMP:path.join(dir,'dump'),THINKER_PROXY_HOLDOUT:variant==='off'?'1':'0'};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
if(action==='before'){
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(home,{recursive:true});
 if(fs.existsSync(path.join(dir,'pid')))throw Error('Prior proxy record exists; refusing to overwrite');
 await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
 const auth='/Users/yoavshmariahu/.artemis/codex-home/auth.json';
 if(!fs.existsSync(auth))throw Error('Artemis Codex login is missing');
 fs.symlinkSync(auth,path.join(home,'auth.json'));
 fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\nmodel_provider = "compression_experiment"\n[model_providers.compression_experiment]\nname = "Artemis compression experiment"\nbase_url = "http://127.0.0.1:${port}/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n[model_providers.compression_experiment.capabilities]\nexternal_web_access = true\nremote_compaction = "v2"\n`,{mode:0o600});
 const out=fs.openSync(path.join(dir,'proxy.out'),'a');
 const child=spawn(process.execPath,[cli,'proxy','--codex','--port',String(port)],{env,stdio:['ignore',out,out],detached:true});fs.closeSync(out);child.unref();fs.writeFileSync(path.join(dir,'pid'),String(child.pid));
 for(let i=0;i<40;i++){
  try {process.kill(child.pid,0);}catch{throw Error('PROXY FAILED: exited during setup');}
  if(fs.readFileSync(path.join(dir,'proxy.out'),'utf8').includes('thinker proxy on')){console.log(JSON.stringify({ready:true,arm:variant,port,model:'gpt-6-astra',effort:'high',serviceTier:'CLI default',dump:path.join(dir,'dump')}));process.exit(0);}
  await delay(200);
 }
 try{process.kill(child.pid,'SIGTERM');}catch{}throw Error('PROXY FAILED: startup timeout');
}else if(action==='after'){
 try{
  const report=JSON.parse(execFileSync(process.execPath,[cli,'proxy','report','--json'],{env,encoding:'utf8'}));
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.op==='proxy'&&r.protocol==='responses');
  if(!rows.length)throw Error('Invalid experiment: no Responses requests reached its proxy');
  if(rows.some(r=>r.model!=='gpt-6-astra'||r.responseModel!=='gpt-6-astra'))throw Error('Invalid experiment: model mismatch');
  if(variant==='off'&&rows.some(r=>r.injected))throw Error('Invalid control: context was cut');
  const dumps=fs.readdirSync(path.join(dir,'dump'),{recursive:true}).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'dump',f),'utf8')));
  if(dumps.length!==rows.length)throw Error('Request dump count differs from recorded responses');
  for(const d of dumps){
   if(!d.sent || d.sent.model!=='gpt-6-astra' || d.sent.reasoning?.effort!=='high')throw Error('Request model/effort differs from the plan');
   const r=rows.find(r=>r.responseId===d.usage?.responseId);
   if(!r || JSON.stringify(r.apiUsage)!==JSON.stringify(d.usage.apiUsage))throw Error('Dump usage does not match the recorded response');
   if(variant==='off' && (d.injected || (d.original && JSON.stringify(d.original)!==JSON.stringify(d.sent))))throw Error('Control request was changed');
  }
  console.log(JSON.stringify({...report,validation:{proxyObserved:true,exactRequestedModel:true,exactEffort:true,arm:variant,thinkerCommit:commit,providerUsagePreserved:true,usageVerified:report.usageValidation.complete,dump:path.join(dir,'dump')}}));
 }finally{
  try{process.kill(Number(fs.readFileSync(path.join(dir,'pid'),'utf8')),'SIGTERM');}catch{}
 }
}else throw Error('before or after required');

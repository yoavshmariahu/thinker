import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {distillEvents,saveNotes} from '../worktrees/astra-engine/src/distill.js';import {Store} from '../worktrees/astra-engine/src/store.js';import {orient} from '../worktrees/astra-engine/src/ops.js';import {estTokens} from '../worktrees/astra-engine/src/rank.js';
const ROOT=path.resolve(import.meta.dirname,'../..'),RAW=path.join(ROOT,'research/astra-mem0-real/raw'),STATE=path.join(ROOT,'bench/worktrees/astra-mem0-real');
const tasks=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'tasks.json')));
for(const task of tasks){
 const evidence=fs.readFileSync(path.join(RAW,task.id+'-learn-evidence.txt'),'utf8');
 for(const arm of ['thinker','mem0']){
  const id=task.id+'-'+arm,output=path.join(RAW,id+'-build.json'),repo=path.join(STATE,task.id+'-learn');
  const notes=path.join(STATE,task.id+'-notes');process.env.THINKER_NOTES_DIR=notes;const store=new Store(repo);
  if(!fs.existsSync(output)){
   process.env.ASTRA_CALL_LABEL=id+'-build';
   const start=performance.now();let result;
   if(arm==='thinker'){
    const distilled=await distillEvents([],{evidence,model:'gpt-6-astra',repoHint:repo});
    result={distilled,saved:saveNotes(store,distilled.notes,{source:{type:'agent',session:task.id+'-learn'}})};
   }else{
    const request={messages:[{role:'user',content:evidence}],user_id:task.id,custom_instructions:'Remember reusable technical facts about this repository from the coding session, including concrete file and symbol pointers, execution flow, invariants, and pitfalls. Do not store incidental session status.'};
    const r=await fetch('http://127.0.0.1:18883/memories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(360000)});
    if(!r.ok)throw Error(await r.text());result=await r.json();
   }
   fs.writeFileSync(output,JSON.stringify({arm,evidence_sha256:crypto.createHash('sha256').update(evidence).digest('hex'),evidence_chars:evidence.length,wall_ms:performance.now()-start,...result},null,2));console.log('BUILT',id);
  }
  const ret=path.join(RAW,id+'-retrieval.json');if(fs.existsSync(ret))continue;
  const start=performance.now();let result,context;
  if(arm==='thinker'){
   // Hash against solver snapshot, not the learning worktree.
   result=await orient(new Store(path.join(STATE,id)),{task:task.prompt,budget:750,recordUsage:false,backgroundVerify:false});context=result.text;
  }else{
   const r=await fetch('http://127.0.0.1:18883/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:task.prompt,user_id:task.id,top_k:20})});if(!r.ok)throw Error(await r.text());result=await r.json();
   const parts=[];let used=0;for(const hit of result.results){const n=estTokens(hit.memory);if(used+n>750)continue;parts.push(hit.memory);used+=n;}context=parts.join('\n\n');
  }
  fs.writeFileSync(ret,JSON.stringify({context,result,wall_ms:performance.now()-start,context_chars:context.length,estimated_tokens:estTokens(context)},null,2));
 }
}

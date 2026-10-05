import fs from 'node:fs';
import path from 'node:path';
import {parseTranscript} from '../src/transcripts.js';
import {distillEvents,saveNotes} from '../src/distill.js';
import {Store} from '../src/store.js';
const root=path.resolve(import.meta.dirname,'..'), raw=path.join(root,'research/mem0-comparison/raw');
const repo=path.join(root,'bench/worktrees/click-source');
process.env.THINKER_NOTES_DIR=path.join(root,'bench/mem0-state/thinker-notes');
const store=new Store(repo);
const arm=process.argv[2];
for(const id of ['L1-option-value-path','L5-testing']){
 const dest=path.join(raw,`build-${arm}-${id}.json`);if(fs.existsSync(dest))continue;
 const eventFile=path.join(raw,id+'.events.json');
 const events=fs.existsSync(eventFile)?JSON.parse(fs.readFileSync(eventFile)):parseTranscript(path.join(raw,id+'.transcript.jsonl')).events;
 if(!fs.existsSync(eventFile))fs.writeFileSync(eventFile,JSON.stringify(events,null,2));
 const start=performance.now();let result;
 if(arm==='thinker'){
  const distilled=await distillEvents(events,{model:'claude-sonnet-5-5',repoHint:repo,existing:store.list()});
  result={distilled,saved:saveNotes(store,distilled.notes,{source:{type:'agent',session:id}})};
 }else{
  // Preserve raw prompts, assistant text and tool evidence. Never read thinker notes.
  const messages=events.map(e=>e.t==='tool'?{role:'user',content:`Tool ${e.name}: ${JSON.stringify(e.input)}\nResult:\n${e.result}`}:{role:e.t==='prompt'?'user':'assistant',content:e.text||''}).filter(m=>m.content);
  fs.writeFileSync(path.join(raw,id+'.mem0-input.json'),JSON.stringify(messages,null,2));
  const r=await fetch('http://127.0.0.1:18881/memories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages,user_id:'click-independent',custom_instructions:'Remember reusable technical facts about this repository from the coding session, including concrete file and symbol pointers, execution flow, invariants, and pitfalls. Do not store incidental session status.'}),signal:AbortSignal.timeout(360000)});
  if(!r.ok)throw Error(await r.text());result=await r.json();
 }
 fs.writeFileSync(dest,JSON.stringify({wall_ms:performance.now()-start,...result},null,2));console.log(arm,id,Math.round((performance.now()-start)/1000)+'s');
}

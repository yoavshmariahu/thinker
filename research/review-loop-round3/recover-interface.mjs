// Recover the same completed execution; no model call and no report rewrite.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {hash,save} from './clients.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));const read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
if(read('results/paired/A-10349.self.rep0.json').valid){console.log('Already recovered; preserving existing artifacts.');process.exit(0);}
const oldText=fs.readFileSync(path.join(dir,'results/interface-recovery/clients.original.mjs.txt'),'utf8');
assert.equal(fs.readFileSync(path.join(dir,'clients.mjs'),'utf8'),oldText.replace("['error','warning','info'].includes(f.severity)","typeof f.severity==='string'&&f.severity.length>0"));
const base=path.join(dir,'results/paired/A-10349.self.rep0');
const invalid=read('results/interface-recovery/arm.invalid.json'),e=read('results/interface-recovery/executor.invalid.json');
const events=read('results/paired/A-10349.self.rep0.executor-0.events.json');
assert.equal(e.error,'Malformed report');const result=JSON.parse(events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1).item.text);
assert.equal(result.next_action,'finalize');assert.ok(result.findings.every(f=>typeof f.severity==='string'));
const execution={...e,valid:true,result};delete execution.error;
const files=['run.mjs','clients.mjs','policy.mjs','questions.mjs','protocol.json','prepare.py','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(dir,f)))]));
const recovery={reason:'Validator required severity enum omitted from the prompt. Accept nonempty severity strings; same complete answer recovered without model retry.',originalHashes:invalid.hashes,originalEventsSha256:hash(fs.readFileSync(base+'.executor-0.events.json')),recoveredWith:hashes};
const initial=read('tasks/A-10349.json'),finalState={...initial,findings:result.findings,coverage:result.coverage,limitations:result.limitations,roundsUsed:1,history:[{action:'initial',contribution:result.contribution}]};
const decision={action:result.next_action,reason:'Executor manages its own follow-up; no Jev or semantic gates.',unresolved:[]};
save(base+'.executor-0.json',{...execution,recovery});
save(base+'.json',{...invalid,valid:true,outcome:'finalize',unresolved:[],hashes,toolCount:e.toolCalls,trace:[{type:'execution',action:'initial',...execution},{type:'self_decision',decision}],finalState,recovery});
save(path.join(dir,'results/interface-recovery/recovery.json'),recovery);
console.log(JSON.stringify({recovered:true,newModelCalls:0,findings:result.findings.length}));

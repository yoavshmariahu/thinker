// Resume the stopped arm at its first Jev call, without repeating the executor.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {judge,execute,hash,save,preflight} from './clients.mjs';import {route,stopReason} from './policy.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
if(process.env.THINKER_TEST!=='1'||process.env.THINKER_PILOT_LIVE!=='1'||process.env.THINKER_TELEMETRY!=='off')throw Error('Test live opt-in required');
process.env.THINKER_LOG='off';process.env.THINKER_NO_LEARN='1';const p=read('protocol.json');preflight(p);
if(read('results/paired/A-10178.graph.rep0.json').valid){console.log('Already recovered; preserving existing artifacts.');process.exit(0);}
const old=read('results/transport-amendment/arm.invalid.json');
if(old.trace.at(-1).error!=='jev: request exceeds limit')throw Error('Unexpected original error');
const files=['run.mjs','clients.mjs','policy.mjs','questions.mjs','protocol.json','prepare.py','transport.mjs','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(dir,f)))]));
const prefix=path.join(dir,'results/paired/A-10178.graph.rep0'),cwd=path.join(dir,'.runtime/A-10178.graph.rep0');
let state=old.finalState,trace=old.trace.slice(0,-1),unresolved=[],outcome='incomplete',tools=old.toolCount;
const seen=new Set(),start=Date.now(),remaining=()=>300000-old.elapsedMs-(Date.now()-start);
while(true){
 if(remaining()<=0){outcome='incomplete_time';break;}
 const j=await judge(state,prefix+`.judge-${state.roundsUsed}`,p,Math.min(30000,remaining())),decision=route(j.response.answers,state);
 trace.push({type:'judgment',...j,decision});unresolved=decision.unresolved;
 const action=decision.action,signature=hash({action,findings:state.findings,source:state.source});const stop=stopReason(action,state.roundsUsed,signature,seen);
 if(stop){outcome=stop;break;}seen.add(signature);
 const e=await execute(action,state,cwd,prefix+`.executor-${state.roundsUsed}`,p,Math.min(150000,remaining()),24-tools);trace.push({type:'execution',action,...e});tools+=e.toolCalls;
 if(e.incomplete){outcome=e.incomplete;break;}
 state={...state,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action,contribution:e.result.contribution}]};
}
const recovery={reason:'Resume before first HTTP call using research full-source transport, without rerunning initial executor.',originalHashes:old.hashes,initialElapsedMs:old.elapsedMs,continuationElapsedMs:Date.now()-start};
save(prefix+'.json',{...old,valid:true,outcome,unresolved,hashes,toolCount:tools,elapsedMs:old.elapsedMs+recovery.continuationElapsedMs,trace,finalState:state,transportRecovery:recovery});
console.log(JSON.stringify({id:old.id,arm:old.arm,outcome,actions:trace.filter(t=>t.type==='execution').map(t=>t.action),recovery}));

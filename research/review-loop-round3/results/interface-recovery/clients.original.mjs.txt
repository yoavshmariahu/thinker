import fs from 'node:fs';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {jevEvaluate,jevKey,JEV_ENDPOINT} from '../../src/jev.js';
import {questionsFor} from './questions.mjs';import {ACTIONS} from './policy.mjs';
export const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
export function preflight(protocol){
 if(execFileSync('codex',['--version'],{encoding:'utf8'}).trim()!=='codex-cli '+protocol.models.codexCLI)throw Error('CLI mismatch');
 if(!jevKey()||JEV_ENDPOINT!=='https://api.typesafe.ai/v1/systemone')throw Error('Personal key and direct endpoint required');
}
export async function judge(state,prefix,protocol,timeoutMs=30000){
 const questions=questionsFor(state),request={model:protocol.models.routing,state,questions};save(prefix+'.request.json',request);
 const start=Date.now();
 try{
  const fetchImpl=(url,args)=>{if(url!==JEV_ENDPOINT)throw Error('Unexpected destination');return fetch(url,args);};
  const response=await jevEvaluate(state,questions,{key:jevKey(),model:protocol.models.routing,timeoutMs,fetchImpl});
  if(response.model!==protocol.models.routing)throw Error('Jev model mismatch');
  const r={valid:true,elapsedMs:Date.now()-start,requestHash:hash(request),response};save(prefix+'.json',r);return r;
 }catch(e){save(prefix+'.json',{valid:false,elapsedMs:Date.now()-start,error:String(e.message)});throw e;}
}
const instructions={
 initial:'Perform the review from scratch. Inspect the actual changed source. Find distinct actionable defects and challenge your own candidates.',
 verify_existing:'Verify every current finding against source. Correct or qualify unsupported assertions and remove contradicted ones; preserve distinct supported defects. Do not expand scope merely to generate more findings.',
 inspect_callers:'Inspect the staged caller/control-flow implementation relevant to unresolved consequences. Distinguish demonstrated effects from missing implementation evidence; qualify claims when the necessary implementation is absent.',
 investigate_remaining:'Investigate a specific unexamined path in the staged diff/source for distinct defects. Challenge candidates; do not invent findings to justify this step. Preserve supported findings.'
};
export async function execute(action,state,cwd,prefix,protocol,timeoutMs,toolRemaining){
 const modelState={...state,source:undefined,sourceFiles:Object.keys(state.source)};
 const prompt=`You are a code reviewer in a controlled research trial. ${instructions[action]}\nYou may use read-only shell tools within this task directory to inspect TASK.json, CHANGE.diff, and the staged production source. Do not read outside this directory, use network, edit files, or run tests. Test results will be checked independently; never claim tests ran. No historical reports or labels are available. Pick your own useful follow-up action, or finalize if the report is ready. There is no requirement to use all available rounds. Each finding must be individually actionable, tied to source lines, and limited to evidenced impact.\nReturn only JSON with findings (array of {file,line,severity,message,evidence}), coverage (string), limitations (array of strings), contribution (string describing actual new evidence or corrections), and next_action (verify_existing, inspect_callers, investigate_remaining, finalize, or manual_review). This is a report, not a patch.\n${JSON.stringify(modelState)}`;
 const args=['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','--strict-config','--model',protocol.models.executor,'--config','model_reasoning_effort="high"','--config','project_doc_max_bytes=0','--config','approval_policy="never"','-'];
 save(prefix+'.request.json',{action,model:protocol.models.executor,effort:protocol.models.executorReasoningEffort,args,prompt,timeoutMs,toolRemaining});
 const start=Date.now(),events=[];let toolCalls=0,stop=null;
 const capture=await new Promise((resolve,reject)=>{
  const p=spawn('codex',args,{cwd,env:process.env,stdio:['pipe','pipe','pipe'],detached:true});let pending='',stderr='';
  const kill=()=>{try{process.kill(-p.pid,'SIGTERM');}catch{}};
  const timer=setTimeout(()=>{stop='incomplete_time';kill();},timeoutMs);
  const consume=line=>{let e;try{e=JSON.parse(line);}catch{return;}
   if(e.item?.type!=='reasoning')events.push(e);
   if(e.type==='item.started'&&e.item?.type==='command_execution'){toolCalls++;if(toolCalls>=toolRemaining){stop='incomplete_tools';kill();}}
  };
  p.stdout.on('data',c=>{pending+=c;let n;while((n=pending.indexOf('\n'))>=0){consume(pending.slice(0,n));pending=pending.slice(n+1);}});
  p.stderr.on('data',c=>{stderr+=c;});p.on('error',e=>{clearTimeout(timer);reject(e);});
  p.on('close',code=>{clearTimeout(timer);if(pending.trim())consume(pending);resolve({code,stderr});});p.stdin.end(prompt);
 });
 save(prefix+'.events.json',events);
 const common={elapsedMs:Date.now()-start,toolCalls,model:protocol.models.executor,effort:protocol.models.executorReasoningEffort,modelVerification:'explicit invocation only; CLI did not echo model',usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage)};
 if(stop){const r={...common,valid:true,incomplete:stop};save(prefix+'.json',r);return r;}
 try{
  if(capture.code!==0||events.some(e=>['error','turn.failed'].includes(e.type)))throw Error('Executor failure: '+capture.stderr.slice(-500));
  const completed=events.filter(e=>e.type==='item.completed');
  const benign=e=>e.item?.type==='error'&&/^clamping (SessionEnd|Interrupt) hook timeout to 3s in /.test(e.item.message);
  if(completed.some(e=>!['agent_message','command_execution'].includes(e.item?.type)&&!benign(e)))throw Error('Unexpected executor event or tool');
  if(events.some(e=>(e.model||e.item?.model)&&((e.model||e.item.model)!==protocol.models.executor)))throw Error('Executor model mismatch');
  const message=completed.filter(e=>e.item?.type==='agent_message').at(-1)?.item.text;
  const result=JSON.parse((message||'').replace(/^```json\s*/,'').replace(/\s*```$/,''));
  if(!Array.isArray(result.findings)||!result.findings.every(f=>typeof f.file==='string'&&Number.isInteger(f.line)&&['error','warning','info'].includes(f.severity)&&typeof f.message==='string'&&typeof f.evidence==='string')||typeof result.coverage!=='string'||!Array.isArray(result.limitations)||!result.limitations.every(x=>typeof x==='string')||typeof result.contribution!=='string'||!ACTIONS.includes(result.next_action))throw Error('Malformed report');
  const r={...common,valid:true,result};save(prefix+'.json',r);return r;
 }catch(e){save(prefix+'.json',{...common,valid:false,error:String(e.message)});throw e;}
}

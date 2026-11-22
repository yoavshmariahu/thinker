import {route as prior} from '../review-loop-round2/policy.mjs';
import {findingKey} from './questions.mjs';
export {ACTIONS} from '../review-loop-round2/policy.mjs';
export function route(answers,state){
 const base=prior(answers,state,'v3');
 const evidence=state.findings.map((f,i)=>{
  const answer=answers['finding_'+i];
  if(!['grounded','qualified','missing','contradicted'].includes(answer?.choice))throw Error('Missing/invalid per-finding judgment');
  return {index:i,key:findingKey(f),message:f.message,status:answer.choice};
 });
 const blocked=evidence.filter(e=>['missing','contradicted'].includes(e.status));
 const unresolved=[...base.unresolved,...blocked.map(e=>`Finding ${e.index}: ${e.status} — ${e.message}`)];
 if(base.action==='manual_review')return {...base,unresolved,evidence};
 if(blocked.length)return {action:'verify_existing',reason:'Correct or qualify each unsupported finding before finalization.',unresolved,evidence};
 return {...base,unresolved,evidence};
}
export function stopReason(action,executions,signature,seen){
 if(['finalize','manual_review'].includes(action))return action;
 if(executions>=3)return 'incomplete_budget';
 if(seen.has(signature))return 'incomplete_stalled';
 return null;
}

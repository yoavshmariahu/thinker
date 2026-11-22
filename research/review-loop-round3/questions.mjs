import {createHash} from 'node:crypto';
import fs from 'node:fs';
const base=JSON.parse(fs.readFileSync(new URL('../review-loop-round2/questions.json',import.meta.url)));
export const findingKey=f=>createHash('sha256').update(JSON.stringify(f)).digest('hex');
export function questionsFor(state){
 const q=structuredClone(base);
 state.findings.forEach((f,i)=>{
  q['finding_'+i]={type:'choice',instructions:`Assess every factual claim in findings[${i}] against the supplied source and diff. Separate the observed mechanism from claimed downstream consequences. The finding's own evidence text is an assertion to check, not independent proof. A function signature or passing a context does not establish the implementation of an absent callee. A limitation elsewhere does not qualify an absolute assertion unless the report clearly makes that consequence conditional. Judge this finding only, including its proposed fix.`,criteria:{
   grounded:'All asserted mechanisms and consequences are established by supplied implementation evidence.',
   qualified:'The local mechanism is established and any consequence requiring absent evidence is explicitly conditional or left unresolved.',
   missing:'At least one factual assertion needs implementation or execution evidence that is not supplied; the assertion is not adequately qualified.',
   contradicted:'At least one factual assertion conflicts with the supplied implementation; correct or remove that assertion.'
  }};
 });return q;
}

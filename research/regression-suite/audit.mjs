import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {COHORTS} from './cohorts.mjs';
const root=path.dirname(new URL(import.meta.url).pathname);
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f));
const checks=[];
const invalidFile=path.join(root,'invalid-attempts.json');
const invalid=fs.existsSync(invalidFile)?read(invalidFile):[];
for(const name of ['grafana','posthog','pandas','sklearn','pydantic']){
 const base=path.join(root,name),manifestFile=path.join(base,'cases.json'),manifest=read(manifestFile);
 if(new Set(manifest.cases.map(c=>c.sha)).size!==15)throw Error(`${name} duplicate/missing case`);
 const assigned=manifest.cases.map(c=>({...c,key:crypto.createHash('sha256').update(`regression-suite-2026-10-06:${manifest.repo}:${c.sha}`).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key));
 assigned.forEach((c,i)=>{if(c.assignmentKey!==c.key||c.cohort!==['opus','sol','gemini'][i%3])throw Error(`assignment hash mismatch ${c.id}`);});
 for(const [cohort,cfg] of Object.entries(COHORTS)){
  const dir=path.join(base,cohort),exec=read(path.join(dir,'execution.json'));
  for(const k of ['model','effort','provider'])if(exec[k]!==cfg[k])throw Error(`config mismatch ${name}/${cohort}/${k}`);
  if(exec.manifestSha256!==hash(manifestFile)||exec.patchSha256!==hash(path.join(root,'model-pins.patch')))throw Error('pin mismatch');
  if(manifest.cases.filter(c=>c.cohort===cohort).length!==5)throw Error('unbalanced allocation');
  const hashes=read(path.join(dir,'notes-hashes.json'));
  for(const [f,h] of Object.entries(hashes))if(hash(path.join(dir,'noteset',f))!==h)throw Error('source note modified');
  const traces=fs.readdirSync(path.join(dir,'traces')).sort().map(file=>{
   const p=path.join(dir,'traces',file),raw=fs.readFileSync(p,'utf8');let row={file,sha256:hash(p),bytes:Buffer.byteLength(raw)};
   if(cohort==='opus'){
    const j=JSON.parse(raw);const models=Object.keys(j.modelUsage||{});if(models.length!==1||models[0]!==cfg.model||j.is_error)throw Error(`Opus mismatch/error ${p}`);
    const canonical=Object.values(j.modelUsage||{}).map(v=>v.canonicalModel).filter(Boolean);
    if(canonical.some(m=>m!==cfg.model))throw Error(`Canonical Opus mismatch ${p}`);
    row={...row,attestedModels:models,canonicalModels:canonical,turns:j.num_turns,usage:j.usage};
   }else if(cohort==='gemini'){
    const j=JSON.parse(raw);if(j.model&&j.model!==cfg.model)throw Error(`Gemini mismatch ${p}`);
    if((j.status!=='SUCCESS'||!j.response?.trim())&&!invalid.some(a=>a.trace===`${name}/${cohort}/traces/${file}`))throw Error(`Unaccounted provider failure ${p}`);
    row={...row,reportedModel:j.model??null,status:j.status,turns:j.num_turns,usage:j.usage,disposition:invalid.some(a=>a.trace===`${name}/${cohort}/traces/${file}`)?'archived invalid attempt; not scored':'successful response'};
   }else{
    const events=raw.trim().split('\n').map(s=>JSON.parse(s));
    row={...row,reportedModels:[...new Set(events.flatMap(e=>[e.model,e.message?.model]).filter(Boolean))],completedTurns:events.filter(e=>e.type==='turn.completed').length,usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage)};
    if(row.reportedModels.some(m=>m!==cfg.model))throw Error(`Sol mismatch ${p}`);
   }
   return row;
  });
  const results=read(path.join(dir,'results.json'));
  const validReviewArms=results.flatMap(r=>[r.baseline,r.cached]).filter(r=>r?.validModel&&!r.errors.length).length;
  const expectedTraceCount=15+validReviewArms+invalid.filter(a=>a.repo===name&&a.cohort===cohort&&a.trace).length;
  if(traces.length!==expectedTraceCount)throw Error(`Unaccounted trace count ${name}/${cohort}: ${traces.length} vs ${expectedTraceCount}`);
  fs.writeFileSync(path.join(dir,'trace-audit.json'),JSON.stringify(traces,null,2)+'\n');
  checks.push({repo:name,cohort,model:cfg.model,effort:cfg.effort,sourceNotes:Object.keys(hashes).length,traces:traces.length,manifestUnchanged:true,sourceNotesUnchanged:true,identityEvidence:cohort==='opus'?'provider modelUsage':'explicit invocation; no consistent provider echo'});
 }
}
fs.writeFileSync(path.join(root,'audit.json'),JSON.stringify({checks,allPassed:true},null,2)+'\n');console.log(JSON.stringify(checks,null,2));

import fs from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname);
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p)));
const names=['grafana','posthog','pandas','sklearn','pydantic'],cohorts=['opus','sol','gemini'];
const all=[];const mining=[];const invalidPairs=[];
for(const name of names){
 const manifest=read(`${name}/cases.json`),scores=read(`${name}/scores.json`);
 if(manifest.cases.length!==15||scores.length!==15)throw Error(`${name}: need 15 cases/scores`);
 for(const cohort of cohorts){
  const rows=read(`${name}/${cohort}/results.json`),notes=read(`${name}/${cohort}/notes.json`);
  if(rows.length!==5||notes.length!==15)throw Error(`${name}/${cohort}: incomplete`);
  mining.push({repo:name,cohort,calls:notes.length,tokens:notes.reduce((s,r)=>s+r.tokens,0),elapsedMs:notes.reduce((s,r)=>s+r.elapsedMs,0),saved:notes.reduce((s,r)=>s+r.saved.length,0),skipped:notes.reduce((s,r)=>s+r.skipped.length,0)});
  for(const row of rows){
   const c=manifest.cases.find(c=>c.id===row.id),score=scores.find(s=>s.id===row.id);
   if(!score||c.cohort!==cohort)throw Error(`assignment/score mismatch ${row.id}`);
   for(const arm of ['baseline','cached']){
    if(!row[arm])throw Error(`unattempted ${row.id}/${arm}`);
    if(!row[arm].validModel||row[arm].errors.length){if(score[arm+'Matches']!==null)throw Error(`invalid arm needs null score ${row.id}/${arm}`);continue;}
    const indexes=score[arm+'Matches'];if(!Array.isArray(indexes))throw Error(`missing semantic assessment ${row.id}`);
    for(const i of indexes){
     const f=row[arm].findings[i];if(!f||!['warning','error'].includes(f.severity))throw Error(`bad finding ${row.id}/${arm}/${i}`);
     const near=[{file:f.file,line:f.line},...(f.locations||[])].some(l=>c.production.includes(l.file)&&(row.expect[l.file]||[]).some(n=>Math.abs(n-l.line)<=6));
     if(!near)throw Error(`non-production/unanchored hit ${row.id}/${arm}/${i}`);
    }
   }
   if(['baseline','cached'].some(a=>!row[a].validModel||row[a].errors.length)){
    invalidPairs.push({id:row.id,repo:name,cohort,reason:score.reason,arms:Object.fromEntries(['baseline','cached'].map(a=>[a,{valid:row[a].validModel&&!row[a].errors.length,hit:score[a+'Matches']===null?null:score[a+'Matches'].length>0,tokens:row[a].validModel?row[a].tokens:null,elapsedMs:row[a].elapsedMs}]))});
   }else all.push({...row,repo:name,baselineHit:score.baselineMatches.length>0,cachedHit:score.cachedMatches.length>0});
  }
 }
}
const totals=rows=>({cases:rows.length,...Object.fromEntries(['baseline','cached'].map(arm=>[arm,{hits:rows.filter(r=>r[arm+'Hit']).length,tokens:rows.every(r=>Number.isFinite(r[arm].tokens))?rows.reduce((s,r)=>s+r[arm].tokens,0):null,elapsedMs:rows.reduce((s,r)=>s+r[arm].elapsedMs,0),findings:rows.reduce((s,r)=>s+r[arm].findings.length,0)}])),wins:rows.filter(r=>!r.baselineHit&&r.cachedHit).length,losses:rows.filter(r=>r.baselineHit&&!r.cachedHit).length});
const historical=[];
for(const [repo,results,scores] of [['autoscaler','../autoscaler-reviews/cohorts/sol/results/results.json','../autoscaler-reviews/cohorts/sol/scores.json'],['mitmproxy','../regression-canary/results/results.json','../regression-canary/scores.json']]){
 const ss=read(scores);historical.push(...read(results).map(r=>({...r,repo,cohort:'sol',baselineHit:ss.find(s=>s.id===r.id).baselineHit,cachedHit:ss.find(s=>s.id===r.id).cachedHit})));
}
const invalidFile=path.join(root,'invalid-attempts.json');
const invalidAttempts=fs.existsSync(invalidFile)?JSON.parse(fs.readFileSync(invalidFile)):[];
const summary={plannedNewCases:75,plannedSevenRepoCases:100,invalidPairs,invalidAttempts:{count:invalidAttempts.length,unknownTokenAttempts:invalidAttempts.filter(x=>!Number.isFinite(x.providerReportedTokens)).length,providerReportedTokens:invalidAttempts.reduce((a,x)=>a+(x.providerReportedTokens||0),0),elapsedMs:invalidAttempts.reduce((a,x)=>a+(x.report?.elapsedMs||0),0)},newByRepo:Object.fromEntries(names.map(n=>[n,totals(all.filter(r=>r.repo===n))])),newByModel:Object.fromEntries(cohorts.map(n=>[n,totals(all.filter(r=>r.cohort===n))])),newDescriptiveMixture:totals(all),historicalByRepo:Object.fromEntries(['autoscaler','mitmproxy'].map(n=>[n,totals(historical.filter(r=>r.repo===n))])),sevenRepoDescriptiveMixture:totals([...historical,...all]),mining,limitations:['Historical-fix recall, not prospective bug prediction','No clean controls; false-positive rate unknown','Different cases across model cohorts: no model ranking','Historical runs use earlier Thinker revisions','Single sample per arm','Gemini/Codex identity pinned by invocation; provider does not consistently echo it']};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));

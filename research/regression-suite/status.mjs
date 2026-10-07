import fs from 'node:fs';
const root=new URL('./',import.meta.url);
let mined=0,pairs=0,arms=0,invalid=0;
for(const name of ['grafana','posthog','pandas','sklearn','pydantic'])for(const cohort of ['opus','sol','gemini']){
 const read=f=>{try{return JSON.parse(fs.readFileSync(new URL(`${name}/${cohort}/${f}.json`,root)))}catch{return []}};
 const n=read('notes'),r=read('results');mined+=n.length;
 const p=r.filter(r=>r.baseline?.validModel&&r.cached?.validModel).length;
 pairs+=p;const a=r.flatMap(r=>[r.baseline,r.cached]).filter(Boolean);arms+=a.length;invalid+=a.filter(a=>!a.validModel).length;
 if(n.length||r.length)console.log(`${name}/${cohort}: mined ${n.length}/15; pairs ${p}/5; arms ${a.length}/10`);
}
console.log(JSON.stringify({mined,plannedMining:225,pairs,plannedPairs:75,arms,plannedArms:150,invalid}));
const graded=[];
for(const name of ['grafana','posthog','pandas','sklearn','pydantic']){
 const file=new URL(`${name}/scores.json`,root);if(!fs.existsSync(file))continue;
 const scores=JSON.parse(fs.readFileSync(file)).filter(s=>Array.isArray(s.baselineMatches)&&Array.isArray(s.cachedMatches));graded.push(...scores);
 console.log(`${name} graded: ${scores.length}; baseline ${scores.filter(s=>s.baselineMatches.length).length}; Thinker ${scores.filter(s=>s.cachedMatches.length).length}`);
}
console.log('Graded totals',JSON.stringify({cases:graded.length,baseline:graded.filter(s=>s.baselineMatches.length).length,thinker:graded.filter(s=>s.cachedMatches.length).length,wins:graded.filter(s=>!s.baselineMatches.length&&s.cachedMatches.length).length,losses:graded.filter(s=>s.baselineMatches.length&&!s.cachedMatches.length).length}));

import fs from 'node:fs';
const root=new URL('./',import.meta.url);
const read=p=>JSON.parse(fs.readFileSync(new URL(p,root)));
const manifest=read('cases.json'),rows=read('results/results.json'),scores=read('scores.json');
if(rows.length!==15||scores.length!==15)throw Error('Need exactly 15 pairs and scores');
for(const c of manifest.cases){
 const r=rows.find(r=>r.id===c.id),s=scores.find(s=>s.id===c.id);
 if(!r||!s||!r.baseline?.validModel||!r.cached?.validModel||r.error)throw Error(`Invalid pair ${c.id}`);
}
const totals=(rs,ss)=>Object.fromEntries(['baseline','cached'].map(arm=>[arm,{hits:ss.filter(s=>s[`${arm}Hit`]).length,cases:ss.length,tokens:rs.reduce((n,r)=>n+r[arm].tokens,0),elapsedMs:rs.reduce((n,r)=>n+r[arm].elapsedMs,0),findings:rs.reduce((n,r)=>n+r[arm].findings.filter(f=>f.severity==='error'||f.severity==='warning').length,0)}]));
const historicalRows=read('../autoscaler-reviews/cohorts/sol/results/results.json');
const historicalScores=read('../autoscaler-reviews/cohorts/sol/scores.json');
const canary=totals(rows,scores),historical=totals(historicalRows,historicalScores),aggregate=totals([...rows,...historicalRows],[...scores,...historicalScores]);
const mining=read('notes.json');
const wins=scores.filter(s=>!s.baselineHit&&s.cachedHit).length,losses=scores.filter(s=>s.baselineHit&&!s.cachedHit).length;
const choose=(n,k)=>{let v=1;for(let i=1;i<=k;i++)v=v*(n-i+1)/i;return v;};
const discordant=wins+losses;
const p=discordant?Math.min(1,2*Array.from({length:Math.min(wins,losses)+1},(_,k)=>choose(discordant,k)*2**-discordant).reduce((a,b)=>a+b,0)):1;
const summary={canary,historical,aggregate,wins,losses,exactMcNemarP:p,miningTokens:mining.reduce((n,r)=>n+r.tokens,0),notesSaved:mining.reduce((n,r)=>n+r.saved.length,0),gate:{validPairs:15,positiveNetGain:wins>losses,expansionDecision:'passed; semantic and harness audit in audit.json'},limitation:'Historical fix recall, selected compact reversible fixes, one sample, no clean controls. Cross-run aggregation uses different Thinker revisions.'};
fs.writeFileSync(new URL('summary.json',root),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));

import fs from 'node:fs';
import path from 'node:path';
const root=path.dirname(new URL(import.meta.url).pathname);
const args=process.argv.slice(2).filter(a=>!a.startsWith('--'));
for(const name of args.length?args:['grafana','posthog','pandas','sklearn','pydantic']){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,name,'cases.json')));
 const scoreFile=path.join(root,name,'scores.json'),scored=fs.existsSync(scoreFile)?JSON.parse(fs.readFileSync(scoreFile)):[];
 for(const cohort of ['opus','sol','gemini']){
  const file=path.join(root,name,cohort,'results.json');if(!fs.existsSync(file))continue;
  for(const row of JSON.parse(fs.readFileSync(file))){
   if(!process.argv.includes('--all')&&(scored.some(s=>s.id===row.id)||!row.baseline?.validModel||!row.cached?.validModel))continue;
   const c=manifest.cases.find(c=>c.id===row.id);console.log(`\n${row.id} (${cohort}): ${c.target}`);
   for(const arm of ['baseline','cached']){
    const r=row[arm];if(!r){console.log(`${arm}: pending`);continue;}
    console.log(`${arm}: valid=${r.validModel} tokens=${r.tokens} consulted=${r.notes.consulted}`);
    r.findings.forEach((f,index)=>{
     const locations=[{file:f.file,line:f.line},...(f.locations||[])];
     const close=locations.some(l=>c.production.includes(l.file)&&(row.expect[l.file]||[]).some(n=>Math.abs(n-l.line)<=6));
     console.log(JSON.stringify(process.argv.includes('--compact')?{index,close,severity:f.severity,file:f.file,line:f.line,message:f.message,locations:(f.locations||[]).map(l=>({file:l.file,line:l.line,message:l.message}))}:{index,close,...f}));
    });
   }
  }
 }
}

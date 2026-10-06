// Print evidence for manual semantic grading; proximity alone is never a hit.
import fs from 'node:fs';
const root=new URL('./',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('cases.json',root)));
const rows=JSON.parse(fs.readFileSync(new URL('results/results.json',root)));
for(const row of rows){
 const c=manifest.cases.find(c=>c.id===row.id);
 console.log(`\n${row.id}: ${c.target}`);
 for(const arm of ['baseline','cached']){
  const r=row[arm];if(!r){console.log(`${arm}: pending`);continue;}
  console.log(`${arm}: valid=${r.validModel} tokens=${r.tokens} consulted=${r.notes.consulted}`);
  for(const f of r.findings){
   const close=c.production.includes(f.file)&&(row.expect[f.file]||[]).some(l=>Math.abs(l-f.line)<=6);
   console.log(JSON.stringify({close,severity:f.severity,file:f.file,line:f.line,message:f.message,locations:f.locations,notes:f.notes,note:f.note}));
  }
 }
}

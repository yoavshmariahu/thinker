import fs from 'node:fs';
const root=new URL('./',import.meta.url),file=new URL('invalid-attempts.json',root);
const a=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
for(const name of ['grafana','posthog','pandas','sklearn','pydantic'])for(const m of ['opus','sol','gemini']){
 const p=new URL(`${name}/${m}/invalid-reviews.jsonl`,root);if(!fs.existsSync(p))continue;
 for(const line of fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean)){
  const item=JSON.parse(line);
  for(const trace of item.traceFiles.length?item.traceFiles:[null]){
   if(a.some(x=>trace?x.trace===trace:x.at===item.at))continue;
   const t=trace?JSON.parse(fs.readFileSync(new URL(trace,root))):null;
   a.push({...item,trace,providerStatus:t?.status??null,rawUsage:t?.usage??null,providerReportedTokens:t?.usage?.total_tokens??null});
  }
 }
}
fs.writeFileSync(file,JSON.stringify(a,null,2)+'\n');console.log(`${a.length} archived invalid attempts`);

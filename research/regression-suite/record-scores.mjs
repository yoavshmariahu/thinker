// Persist manually inspected semantic matches. Never infer hits from proximity alone.
import fs from 'node:fs';
const name=process.argv[2],file=new URL(`./${name}/scores.json`,import.meta.url);
const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
for(const [id,baselineMatches,cachedMatches,reason] of JSON.parse(fs.readFileSync(0,'utf8'))){
 const row={id,baselineMatches,cachedMatches,reason};const i=rows.findIndex(r=>r.id===id);if(i<0)rows.push(row);else rows[i]=row;
}
fs.writeFileSync(file,JSON.stringify(rows,null,2)+'\n');

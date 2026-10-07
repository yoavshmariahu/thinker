// Preserve exact checkpoint bytes without a many-thousand-line evidence diff.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const dir='research/jev-capture-experiments',raw=`${dir}/raw`,file=`${dir}/raw.json.gz`;
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
if(process.argv.includes('--unpack')){
 const archive=JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));fs.mkdirSync(raw,{recursive:true});
 for(const [name,text] of Object.entries(archive)){
  if(!/^[a-z0-9-]+\.json$/.test(name)||typeof text!=='string')throw Error('invalid archive entry');
  const target=`${raw}/${name}`;
  if(fs.existsSync(target)){if(fs.readFileSync(target,'utf8')!==text)throw Error(`refusing to overwrite different checkpoint ${name}`);}
  else fs.writeFileSync(target,text,{flag:'wx'});
 }
 console.log(`Restored ${Object.keys(archive).length} checkpoints`);
}else{
 const entries=Object.fromEntries(fs.readdirSync(raw).filter(n=>n.endsWith('.json')).sort().map(n=>[n,fs.readFileSync(`${raw}/${n}`,'utf8')]));
 const bytes=zlib.gzipSync(Buffer.from(JSON.stringify(entries)),{level:9});fs.writeFileSync(file,bytes);
 fs.writeFileSync(`${dir}/evidence-manifest.json`,JSON.stringify({archive:'raw.json.gz',sha256:hash(bytes),files:Object.entries(entries).map(([name,text])=>({name,bytes:Buffer.byteLength(text),sha256:hash(text)}))},null,2)+'\n');
 console.log({files:Object.keys(entries).length,archiveBytes:bytes.length});
}

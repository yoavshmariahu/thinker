// Literal arm: no distillation. The condensed source session is cut into its own units (one shell
// command with its output, one agent paragraph), ranked by BM25 against the task request, and
// packed verbatim under the same 750-token prefetch budget the thinker and mem0 arms had.
import fs from 'node:fs';import path from 'node:path';
import {tokenize,bm25,estTokens} from '../../src/rank.js';
const ROOT=path.resolve(import.meta.dirname,'../..'),RAW=path.join(ROOT,'research/astra-mem0-real/raw');
const tasks=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'tasks.json')));
const BUDGET=750;
const CHUNK=1000; // chars: a unit the size of a long paragraph, so several fit the budget
function pieces(head,body){
  const out=[];let cur='';
  for(const para of body.split(/\n(?=\s*(?:\d+\.|[-*]|AGENT|\$ |  =>)|\n)/)){
    if(cur&&(cur.length+para.length>CHUNK)){out.push(cur);cur='';}
    if(para.length>CHUNK){ if(cur){out.push(cur);cur='';} for(let i=0;i<para.length;i+=CHUNK)out.push(para.slice(i,i+CHUNK)); }
    else cur=cur?cur+'\n'+para:para;
  }
  if(cur)out.push(cur);
  return out.map((b,k)=>head?(k?`${head} (cont. ${k+1})\n${b}`:`${head}\n${b}`):b);
}
function units(text){
  const blocks=[];let cur=null;
  for(const line of text.split('\n')){
    if(/^(USER|AGENT)(?: \([^)]*\))?: /.test(line)||/^\$ /.test(line)){ if(cur)blocks.push(cur); cur=line; }
    else if(cur!==null) cur+='\n'+line; else cur=line;
  }
  if(cur)blocks.push(cur);
  const out=[];
  for(const b0 of blocks){
    if(/^USER: /.test(b0))continue;
    const b=b0.replace(/\/Users\/[^\s]*?(click-\d+-learn)\/?/g,'./');
    if(/^\$ /.test(b)){ const nl=b.indexOf('\n'); const head=nl<0?b:b.slice(0,Math.min(nl,200)); const body=nl<0?'':b.slice(nl+1); out.push(...pieces(head,body)); }
    else out.push(...pieces('',b));
  }
  return out.filter(u=>u.trim().length>40);
}
for(const task of tasks){
  const ev=fs.readFileSync(path.join(RAW,task.id+'-learn-evidence.txt'),'utf8');
  const us=units(ev);
  const docs=us.map(u=>tokenize(u));
  const avg=docs.reduce((s,d)=>s+d.length,0)/docs.length;
  const df=new Map();for(const d of docs)for(const t of new Set(d))df.set(t,(df.get(t)||0)+1);
  const q=tokenize(task.prompt);const N=docs.length;
  const score=(d)=>{const tf=new Map();for(const t of d)tf.set(t,(tf.get(t)||0)+1);let s=0;for(const t of new Set(q)){const f=tf.get(t)||0;if(!f)continue;const idf=Math.log(1+(N-df.get(t)+0.5)/(df.get(t)+0.5));s+=idf*(f*2.4)/(f+1.4*(1-0.6+0.6*d.length/avg));}return s;};
  const ranked=us.map((u,i)=>({u,i,s:score(docs[i])})).sort((a,b)=>b.s-a.s);
  const parts=[];let used=0;
  for(const r of ranked){ if(r.s<=0)break; let u=r.u; let n=estTokens(u); if(used+n>BUDGET){ const room=BUDGET-used; if(room<80)continue; u=u.slice(0,Math.floor(room*3.6))+' …'; n=estTokens(u);} parts.push({i:r.i,u,s:r.s}); used+=n; if(used>=BUDGET-40)break; }
  parts.sort((a,b)=>a.i-b.i); // session order reads better than score order
  const context=parts.map(p=>p.u).join('\n\n');
  const out={arm:'literal',context,units:us.length,chosen:parts.map(p=>({i:p.i,score:+p.s.toFixed(2)})),wall_ms:0,context_chars:context.length,estimated_tokens:estTokens(context),budget:BUDGET,evidence_chars:ev.length};
  fs.writeFileSync(path.join(RAW,task.id+'-literal-retrieval.json'),JSON.stringify(out,null,2));
  console.log(task.id,'units',us.length,'chosen',parts.length,'tokens',out.estimated_tokens);
}

// Explicit live research: frozen, sanitized public-project traces and fictional cases only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { jevKey, jevEvaluate, JEV_ENDPOINT } from '../../src/jev.js';
import { condense, distillSpec } from '../../src/distill.js';
import { evidencePacket, evidencePassages, learningPlan, refineLearningPlan } from '../../src/learning-evidence.js';
import { pickPrs } from '../../src/prs.js';
import { normalizeModelUsage } from '../../src/model-usage.js';

if(process.env.THINKER_TEST!=='1'||(!process.argv.includes('--live')&&!process.argv.includes('--stage=report')))throw Error('THINKER_TEST=1 and --live required (except offline --stage=report)');
const dir='research/jev-capture-experiments', raw=`${dir}/raw`;
fs.mkdirSync(raw,{recursive:true});
const archiveFile=`${dir}/raw.json.gz`;
const archive=fs.existsSync(archiveFile)?JSON.parse(zlib.gunzipSync(fs.readFileSync(archiveFile))):{};
const readRecord=name=>JSON.parse(fs.existsSync(`${raw}/${name}.json`)?fs.readFileSync(`${raw}/${name}.json`,'utf8'):archive[`${name}.json`]??(()=>{throw Error(`missing checkpoint ${name}`);})());
const corpusBytes=zlib.gunzipSync(fs.readFileSync(`${dir}/corpus.json.gz`));
const protocol=JSON.parse(fs.readFileSync(`${dir}/protocol.json`));
if(crypto.createHash('sha256').update(corpusBytes).digest('hex')!==protocol.corpusSha256)throw Error('corpus hash mismatch');
const corpus=JSON.parse(corpusBytes), model=protocol.models.writer, selector=protocol.models.selector;
const stage=process.argv.find(a=>a.startsWith('--stage='))?.split('=')[1]||'all';
if(stage!=='report')for(const [file,expected] of Object.entries(protocol.sourceHashes||{}))if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw Error(`source version mismatch: ${file}; replay from the recorded research commit`);
const write=(file,obj)=>fs.writeFileSync(file,JSON.stringify(obj,null,2)+'\n');
const checkpoint=async(name,fn)=>{const f=`${raw}/${name}.json`;if(fs.existsSync(f)||archive[`${name}.json`])return readRecord(name);let r;for(let attempt=0;attempt<3;attempt++){try{r=await fn();r.attempts=attempt+1;break;}catch(error){if(!String(error.message).includes('writer failed: tool_use')||attempt===2)throw error;console.log(name,'retry structured output');}}write(f,r);console.log(name,JSON.stringify({ms:r.ms,tokens:r.tokens?.totalTokens,status:r.selection?.status}));return r;};
const objectSchema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string'}, bool={type:'boolean'};
const arr=items=>({type:'array',items});
const goldSchema=objectSchema({facts:arr(objectSchema({id:str,claim:str,evidence:str})),reason:str});
const gradeSchema=objectSchema({arms:arr(objectSchema({id:str,coveredFacts:arr(str),notes:arr(objectSchema({index:{type:'integer'},supported:bool,reusable:bool,reason:str})),reason:str}))});

// Inspect the provider's actual per-model usage rather than trusting the requested alias.
async function writer(system,prompt,schema){
 const cwd=path.resolve(`${dir}/empty`);fs.mkdirSync(cwd,{recursive:true});
 const args=['-p','--model',model,'--effort','medium','--output-format','json','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--system-prompt',system,'--setting-sources','','--disable-slash-commands','--json-schema',JSON.stringify(schema)];
 const start=performance.now();
 const result=await new Promise((resolve,reject)=>{
  const p=spawn('claude',args,{cwd,env:{...process.env,THINKER_TEST:'1',THINKER_TELEMETRY:'off',THINKER_IN_LLM:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'6000',MAX_THINKING_TOKENS:'0',MAX_STRUCTURED_OUTPUT_RETRIES:'3'}});
  let stdout='',stderr='';const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('writer timeout'));},240000);
  p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);try { const j=JSON.parse(stdout);if(code||j.is_error){fs.appendFileSync(`${dir}/failed-writer.jsonl`,JSON.stringify({at:new Date().toISOString(),code,result:j})+'\n');reject(Error(`writer failed: ${j.stop_reason} ${String(j.result).slice(0,300)}`));}else resolve(j);} catch(error){reject(error);}});p.stdin.end(prompt);
 });
 const models=Object.keys(result.modelUsage||{});
 if(!models.length||models.some(m=>m!==model)||result.model&&result.model!==model)throw Error(`invalid comparison: resolved ${models.join(',')} expected ${model}`);
 if(result.is_error)throw Error(String(result.result));
 const json=result.structured_output??JSON.parse(result.result);
 return {json,model,models,effort:'medium',thinkingTokens:0,usage:result.usage,tokens:normalizeModelUsage('claude',result.usage),ms:Math.round(performance.now()-start),promptChars:prompt.length,promptSha256:crypto.createHash('sha256').update(JSON.stringify({system,prompt,schema})).digest('hex')};
}
const key=jevKey();if(stage!=='report'&&!key)throw Error('personal Jev key required; never use hosted telemetry paths');
 let calls=[];
const cfg={enabled:true,key,model:selector,timeoutMs:15000,learningTimeoutMs:15000,evidenceTimeoutMs:60000,fetchImpl:async(url,options)=>{
 if(url!==JEV_ENDPOINT||url!=='https://api.typesafe.ai/v1/systemone')throw Error('unexpected Jev destination');
 // Preflight found production splitting UTF-16 pairs. Research-only repair; count it.
 let unicodeRepairs=0;
 const payload=JSON.parse(options.body,(_key,value)=>{if(typeof value==='string'&&!value.isWellFormed()){unicodeRepairs++;return value.toWellFormed();}return value;});
 options={...options,body:JSON.stringify(payload)};
 const start=performance.now(),r=await fetch(url,options);if(!r.ok)throw Error(`Jev HTTP ${r.status}: ${(await r.text()).slice(0,1200)}`);
 const j=await r.json();if(j.model!==selector)throw Error(`invalid comparison: ${j.model} != ${selector}`);
 calls.push({model:j.model,usage:j.usage,tokens:normalizeModelUsage('typesafe',j.usage),unicodeRepairs,ms:Math.round(performance.now()-start)});
 return {ok:true,json:async()=>j};
}};
const store={config:()=>({jev:cfg,maintain:{dailyTokens:0}}),log:()=>{}};
const metrics=()=>({calls,tokens:{totalTokens:calls.reduce((n,c)=>n+(c.tokens.totalTokens||0),0)},ms:calls.reduce((n,c)=>n+c.ms,0)});
const gateQuestion={type:'noul',instructions:'Does this source establish at least one durable repository mechanism, constraint, non-obvious workflow, or correction worth distilling for a different future task? Judge observable evidence, not how much work occurred. A short discovery counts. Missing context is unknown.',criteria:{true:'Concrete reusable knowledge supported by code, a test, or an explicit observed correction.',false:'Only routine change narration, UI copy or styling, repetition, machine-specific failure, unsupported speculation, or generated/dependency churn without a reusable constraint.'}};
function batches(passages,maxBytes=22000){const out=[];let current=[];for(const p of passages){if(Buffer.byteLength(JSON.stringify([...current,p]))>maxBytes&&current.length){out.push(current);current=[];}current.push(p);}if(current.length)out.push(current);return out;}
async function gateSession(s){calls=[];const probabilities=[];for(const batch of batches(evidencePassages(s.events))){const r=await jevEvaluate({source:batch,context:'Partial chronological session; an empty initial cache.'},{valuable:gateQuestion},cfg);probabilities.push(r.answers.valuable.noul);}return {probability:Math.max(...probabilities),probabilities,...metrics()};}
async function compactGate(s){calls=[];const r=await jevEvaluate({source:evidencePacket(s.events),context:'Partial selected session evidence; omitted source is unknown. Empty initial cache.'},{valuable:gateQuestion},cfg);return {probability:r.answers.valuable.noul,...metrics()};}
// PRs are bounded evidence records; identical source is used by both queue policies.
const prEvidence=p=>`PR ${p.repo}#${p.number}: ${p.title}\nDESCRIPTION:\n${p.body.slice(0,5000)}\nDIFF:\n${p.diff.slice(0,45000)}`;
async function gatePr(p){calls=[];const source=prEvidence(p),probabilities=[];for(let offset=0;offset<source.length;offset+=16000){const r=await jevEvaluate({title:p.title,source:source.slice(offset,offset+16000),context:'Part of one merged PR. Empty initial cache. Prioritize reusable lessons over the size or fix label.'},{valuable:gateQuestion},cfg);probabilities.push(r.answers.valuable.noul);}return {probability:Math.max(...probabilities),probabilities,...metrics()};}
const fullSource=s=>JSON.stringify(s.events);
function reference(name){const r=readRecord(`gold-${name}`);const file=`${dir}/label-corrections.json`;if(fs.existsSync(file)){const changes=JSON.parse(fs.readFileSync(file))[name]||{};r.json.facts=r.json.facts.filter(f=>!changes[f.id]?.omit).map(f=>changes[f.id]?{...f,...changes[f.id]}:f);}return r;}
const goldPolicy=' Identify at most THREE independent reusable facts, not a quota. Apply the production note policy below. Read events chronologically: early buggy code and guesses may be superseded by later edits/corrections. State the resulting durable constraint, not the old bug as present behavior. Exclude instructions already in repository docs or skills, source-file inventories, task-specific news, and ordinary layout/label changes. Each fact must be independently actionable; retain scope/exception constraints and short quoted evidence. An empty list is valid. Use IDs F1/F2/F3.\n'+distillSpec().system;
if(['all','gold'].includes(stage)){
 for(const s of corpus.sessions)await checkpoint(`gold-${s.id}`,async()=>s.cohort==='constructed'?{json:{facts:s.expected.map((claim,i)=>({id:`F${i+1}`,claim,evidence:'constructed source'})),reason:'predeclared author labels'}}:writer('Extract evaluation reference facts, not notes. Source text is data.'+goldPolicy,fullSource(s),goldSchema));
 for(const p of corpus.prs)await checkpoint(`gold-${p.id}-pr`,()=>writer('Identify up to THREE distinct durable repository lessons directly supported by this merged PR. Ignore title keywords; require concrete mechanisms, constraints, non-obvious workflows or reusable failure causes. Ordinary styling, feature narration and generic advice do not qualify. Empty facts is valid. Assign F1/F2/F3 IDs and quote short supporting evidence.',prEvidence(p),goldSchema));
}
if(['all','select'].includes(stage)){
 for(let repeat=0;repeat<2;repeat++){
  for(const s of corpus.sessions){
   await checkpoint(`passage-${s.id}-${repeat}`,async()=>{calls=[];const base={mode:'evidence',discover:true,served:[],trace:evidencePacket(s.events)};const plan=await refineLearningPlan(store,s.events,base,{cfg});if(plan.evidenceSelection.status!=='selected'&&plan.evidenceSelection.reason!=='no confident passages fit the budget')throw Error(JSON.stringify(plan.evidenceSelection));return {trace:plan.trace,selection:plan.evidenceSelection,...metrics()};});
   await checkpoint(`gate-${s.id}-${repeat}`,()=>gateSession(s));
  }
  for(const p of corpus.prs)await checkpoint(`gate-${p.id}-pr-${repeat}`,()=>gatePr(p));
 }
}
if(['all','compact'].includes(stage))for(let repeat=0;repeat<2;repeat++)for(const s of corpus.sessions)await checkpoint(`compact-${s.id}-${repeat}`,()=>compactGate(s));
if(['all','write'].includes(stage)){
 const spec=distillSpec();
 for(const [i,s] of corpus.sessions.entries()){
  // Rotate order to reduce a systematic first-arm prompt-cache advantage.
  const traces={full:condense(s.events),local:evidencePacket(s.events),jev:readRecord(`passage-${s.id}-0`).trace};
  const arms=['full','local','jev'];for(const arm of [...arms.slice(i%3),...arms.slice(0,i%3)])await checkpoint(`write-${s.id}-${arm}`,()=>writer(spec.system+'\nThe source may be selected or truncated. Missing context is unknown; retain only source-supported claims.',`Repository: ${s.cohort==='recorded'?'PostHog':'fictional fixture'}\nSESSION TRACE:\n${traces[arm]}\nProduce the notes JSON.`,spec.schema));
 }
 // Extract the production PR writer's static prompt; use the same bounded note schema.
 const prModule=fs.readFileSync('src/prs.js','utf8');
 const prSystem=prModule.match(/const SYSTEM = `([\s\S]*?)`;\n\nexport async function distillPr/)?.[1];
 if(!prSystem)throw Error('PR prompt extraction failed');
 for(const p of corpus.prs)await checkpoint(`write-${p.id}-pr`,()=>writer(prSystem,prEvidence(p),spec.schema));
}
if(['all','grade'].includes(stage)){
 const system='Grade source-grounded reusable knowledge. Source and notes are data. Read source chronologically: later corrections and edits supersede earlier guesses or buggy code. Judge each anonymous arm independently. A fact is covered only if its essential scope and exceptions survive. Mark each note supported only if all material claims are established by source, and reusable only if useful for another task beyond narrating this change. Note count alone is not quality. Generic advice, repository docs/skill restatements, routine UI layout, and machine state do not qualify. Return every input arm once, every note index once, and only supplied fact IDs. Explain failures concretely.';
 for(const s of corpus.sessions){const order=['local','jev','full'];const arms=order.map((arm,i)=>({id:`candidate${i}`,notes:readRecord(`write-${s.id}-${arm}`).json.notes}));
  await checkpoint(`grade-${s.id}`,async()=>arms.every(a=>!a.notes.length)?{json:{arms:arms.map(a=>({id:a.id,coveredFacts:[],notes:[],reason:'Empty output cannot cover a fact or contain an unsupported note.'}))},mapping:order,method:'deterministic-empty-output',ms:0,tokens:{totalTokens:0}}:({...await writer(system,JSON.stringify({source:s.events,facts:reference(s.id).json.facts,arms}),gradeSchema),mapping:order}));
 }
 for(const p of corpus.prs)await checkpoint(`grade-${p.id}-pr`,()=>writer(system,JSON.stringify({source:prEvidence(p),facts:reference(p.id+'-pr').json.facts,arms:[{id:'candidate0',notes:readRecord(`write-${p.id}-pr`).json.notes}]}),gradeSchema));
}
if(['all','report'].includes(stage)){
 const correctionsFile=`${dir}/grade-corrections.json`;
 const corrections=fs.existsSync(correctionsFile)?JSON.parse(fs.readFileSync(correctionsFile)):{};
 const get=name=>{const r=readRecord(name);if(corrections[name])for(const a of r.json.arms){const change=corrections[name][a.id];if(!change)continue;if(change.noteIndexBase===1)for(const n of a.notes)n.index--;if(change.coveredFacts)a.coveredFacts=change.coveredFacts;for(const n of a.notes)if(change.notes?.[n.index])Object.assign(n,change.notes[n.index]);}return r;};
 const validate=(gold,grade,arms)=>{
  const ids=new Set(gold.json.facts.map(f=>f.id));
  if(ids.size!==gold.json.facts.length||grade.json.arms.length!==arms.length)throw Error('malformed gold or grading arms');
  const seen=new Set();
  for(const g of grade.json.arms){const i=Number(g.id.replace('candidate',''));if(!Number.isInteger(i)||!arms[i]||seen.has(i))throw Error('missing/duplicate anonymous arm');seen.add(i);
   const notes=arms[i].json.notes;if(g.notes.length!==notes.length||new Set(g.notes.map(n=>n.index)).size!==notes.length||g.notes.some(n=>!Number.isInteger(n.index)||n.index<0||n.index>=notes.length))throw Error('grading did not cover every note exactly once');
   if(new Set(g.coveredFacts).size!==g.coveredFacts.length||g.coveredFacts.some(f=>!ids.has(f)))throw Error('invalid covered fact IDs');
  }
 };
 for(const s of corpus.sessions){const g=get(`grade-${s.id}`);validate(get(`gold-${s.id}`),g,g.mapping.map(arm=>get(`write-${s.id}-${arm}`)));}
 for(const p of corpus.prs)validate(get(`gold-${p.id}-pr`),get(`grade-${p.id}-pr`),[get(`write-${p.id}-pr`)]);
 const sum=(xs,f)=>xs.reduce((n,x)=>n+f(x),0);
 const sessionRows=corpus.sessions.map(s=>{const gold=get(`gold-${s.id}`),grade=get(`grade-${s.id}`);return {id:s.id,cohort:s.cohort,facts:gold.json.facts.length,localEligible:learningPlan(s.events,{auditRate:0}).mode!=='skip',gates:[0,1].map(r=>get(`gate-${s.id}-${r}`)),compactGates:[0,1].map(r=>get(`compact-${s.id}-${r}`)),arms:Object.fromEntries(['full','local','jev'].map(arm=>{const w=get(`write-${s.id}-${arm}`),g=grade.json.arms.find(a=>grade.mapping[Number(a.id.replace('candidate',''))]===arm),sel=get(`passage-${s.id}-0`);return [arm,{notes:w.json.notes.length,covered:g.coveredFacts.length,unsupported:g.notes.filter(n=>!n.supported).length,reusable:g.notes.filter(n=>n.supported&&n.reusable).length,writerTokens:w.tokens.totalTokens,selectorTokens:arm==='jev'?sel.tokens.totalTokens:0,ms:w.ms+(arm==='jev'?sel.ms:0),traceChars:arm==='full'?condense(s.events).length:arm==='local'?evidencePacket(s.events).length:sel.trace.length}];}))};});
 const sessionSummary=Object.fromEntries(['recorded','constructed'].map(cohort=>{const rows=sessionRows.filter(s=>s.cohort===cohort);return [cohort,{sessions:rows.length,facts:sum(rows,s=>s.facts),arms:Object.fromEntries(['full','local','jev'].map(a=>[a,Object.fromEntries(['notes','covered','unsupported','reusable','writerTokens','selectorTokens','ms','traceChars'].map(k=>[k,sum(rows,s=>s.arms[a][k])]))])),gates:Object.fromEntries(['local',.2,.5].map(t=>{const selected=rows.filter(s=>t==='local'?s.localEligible:s.gates[0].probability>=t);return [t,{selected:selected.length,valuableMissed:rows.filter(s=>s.facts>0&&!selected.includes(s)).map(s=>s.id),factsRetained:sum(selected,s=>s.arms.full.covered),writerTokens:sum(selected,s=>s.arms.full.writerTokens),selectorTokens:t==='local'?0:sum(rows,s=>s.gates[0].tokens.totalTokens),probabilityRange:rows.map(s=>({id:s.id,p:s.gates.map(g=>g.probability)}))}];}))}];}));
 const prRows=corpus.prs.map(p=>{const w=get(`write-${p.id}-pr`),g=get(`grade-${p.id}-pr`).json.arms[0];return {id:p.id,repo:p.repo,number:p.number,title:p.title,facts:get(`gold-${p.id}-pr`).json.facts.length,reusable:g.notes.filter(n=>n.supported&&n.reusable).length,covered:g.coveredFacts.length,unsupported:g.notes.filter(n=>!n.supported).length,writerTokens:w.tokens.totalTokens,ms:w.ms,gates:[0,1].map(r=>get(`gate-${p.id}-pr-${r}`))};});
 const repos=['mitmproxy','posthog','grafana'];
 const localIds=repos.flatMap(repo=>pickPrs(corpus.prs.filter(p=>p.repo===repo),3).map(p=>p.id));
 const prQueues=[{policy:'all',rows:prRows},{policy:'pickPrs',rows:prRows.filter(p=>localIds.includes(p.id))},...[0,1].map(r=>({policy:`jev-${r}`,rows:repos.flatMap(repo=>prRows.filter(p=>p.repo===repo).sort((a,b)=>b.gates[r].probability-a.gates[r].probability||a.id.localeCompare(b.id)).slice(0,3)),repeat:r}))].map(({policy,rows,repeat})=>({policy,ids:rows.map(p=>p.id),facts:sum(rows,p=>p.facts),covered:sum(rows,p=>p.covered),reusable:sum(rows,p=>p.reusable),unsupported:sum(rows,p=>p.unsupported),writerTokens:sum(rows,p=>p.writerTokens),selectorTokens:repeat===undefined?0:sum(prRows,p=>p.gates[repeat].tokens.totalTokens),ms:sum(rows,p=>p.ms)+(repeat===undefined?0:sum(prRows,p=>p.gates[repeat].ms))}));
 const gateComparisons=Object.fromEntries(['recorded','constructed'].map(cohort=>{const rows=sessionRows.filter(s=>s.cohort===cohort);return [cohort,[{method:'all',threshold:null,repeat:null,rows,overhead:0,overheadMs:0},{method:'local',threshold:null,repeat:null,rows:rows.filter(s=>s.localEligible),overhead:0,overheadMs:0},...['gates','compactGates'].flatMap(method=>[.2,.5].flatMap(threshold=>[0,1].map(repeat=>({method,threshold,repeat,rows:rows.filter(s=>s[method][repeat].probability>=threshold),overhead:sum(rows,s=>s[method][repeat].tokens.totalTokens),overheadMs:sum(rows,s=>s[method][repeat].ms)}))))].map(x=>({method:x.method,threshold:x.threshold,repeat:x.repeat,selected:x.rows.length,valuableMissed:rows.filter(s=>s.facts>0&&!x.rows.includes(s)).map(s=>s.id),factsRetained:sum(x.rows,s=>s.arms.full.covered),referenceFactsRetained:sum(x.rows,s=>s.facts),writerTokens:sum(x.rows,s=>s.arms.full.writerTokens),selectorTokens:x.overhead,totalTokens:sum(x.rows,s=>s.arms.full.writerTokens)+x.overhead,ms:sum(x.rows,s=>s.arms.full.ms)+x.overheadMs}))];}));
 // Full per-request usage remains in the evidence archive; keep the report reviewable.
 for(const row of [...sessionRows,...prRows])for(const key of ['gates','compactGates'])if(row[key])row[key]=row[key].map(g=>({probability:g.probability,probabilities:g.probabilities,tokens:g.tokens,ms:g.ms,callCount:g.calls.length,unicodeRepairs:g.calls.reduce((n,c)=>n+(c.unicodeRepairs||0),0)}));
 write(`${dir}/results.json`,{models:protocol.models,sessionSummary,sessionRows,gateComparisons,prQueues,prRows});console.log(JSON.stringify({sessionSummary,gateComparisons,prQueues},null,2));
}

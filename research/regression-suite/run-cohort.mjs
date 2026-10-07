// Isolated, resumable model cohort. Mine the same 15-fix corpus; review only the
// five cases assigned to this model before outputs. No fallback or model judge.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { COHORTS } from './cohorts.mjs';
const [name, cohort, repoArg] = process.argv.slice(2), cfg = COHORTS[cohort];
if (!cfg || !repoArg || process.env.THINKER_TEST !== '1') throw Error('usage with THINKER_TEST=1: run-cohort.mjs <repo-name> <cohort> <clone>');
const root = path.resolve('research/regression-suite', name), out = path.join(root, cohort);
const repo = path.resolve(repoArg), manifest = JSON.parse(fs.readFileSync(path.join(root, 'cases.json')));
const wt = path.resolve('bench/suite-worktrees', `${name}-${cohort}`);
const notes = path.join(out, 'noteset'), cache = path.join(out, 'cache'), traces = path.join(out, 'traces');
for (const d of [out, notes, cache, traces]) fs.mkdirSync(d, {recursive:true});
Object.assign(process.env, { THINKER_TELEMETRY:'off', THINKER_LOG:'local', THINKER_NO_LEARN:'1', THINKER_NO_LIMIT_WAIT:'1', THINKER_LLM:cfg.provider, THINKER_LLM_MODEL:cfg.model, THINKER_CODEX_REASONING_EFFORT:'high', THINKER_CLAUDE_EFFORT:'high', THINKER_GEMINI_EFFORT:'high', THINKER_EVAL_TRACE_DIR:traces, THINKER_NOTES_DIR:notes });
delete process.env.MAX_THINKING_TOKENS;
const {Store} = await import('../../src/store.js');
const {distillPr} = await import('../../src/prs.js');
const {saveNotes} = await import('../../src/distill.js');
const {review,resolveScope,parseDiff} = await import('../../src/review.js');
const git = (args,cwd=repo,input) => execFileSync('git',args,{cwd,input,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
const read = (p, fallback=[]) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : fallback;
const save = (p,x) => {fs.writeFileSync(p+'.tmp',JSON.stringify(x,null,2)+'\n');fs.renameSync(p+'.tmp',p);};
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const notesFile=path.join(out,'notes.json'), resultsFile=path.join(out,'results.json');
const mined=read(notesFile), results=read(resultsFile);
const executionFile=path.join(out,'execution.json');
const execution={repo:manifest.repo,base:manifest.base,...cfg,thinkerCommit:git(['rev-parse','HEAD'],process.cwd()).trim(),manifestSha256:hash(path.join(root,'cases.json')),patchSha256:hash('research/regression-suite/model-pins.patch'),modelFallback:false};
if(fs.existsSync(executionFile)) { const old=read(executionFile);for(const key of ['base','model','effort','manifestSha256','patchSha256'])if(old[key]!==execution[key])throw Error(`resume mismatch: ${key}`); }
else save(executionFile,execution);
if(fs.existsSync(wt))throw Error(`Worktree already exists: ${wt}; inspect before resuming`);
git(['worktree','add','--detach',wt,manifest.base]);
const store = new Store(wt).init();
const log = s => console.log(`${name}/${cohort}: ${s}`);
try {
 for(const c of manifest.cases){
  if(mined.some(r=>r.id===c.id&&!r.error))continue;
  const meta=read(path.join(root,'metadata',c.id+'.json'));
  const t0=Date.now();
  const response=await distillPr(manifest.repo,{number:c.pr,prNumber:c.pr,hash:c.sha,title:meta.title,body:meta.body,diff:git(['diff',c.parent,c.sha]),comments:[],isGitCommit:true},{model:cfg.model,repo:wt,accounting:{store,purpose:'mine-prs',phase:'init',pr:c.pr}});
  const saved=saveNotes(store,response.notes,{source:{type:'pr',ref:`${manifest.repo}#${c.pr}`}});
  const row={id:c.id,pr:c.pr,model:cfg.model,effort:cfg.effort,tokens:response.tokens,elapsedMs:Date.now()-t0,proposed:response.notes,saved:[...saved.saved,...saved.merged].map(n=>({id:n.id,title:n.title,kind:n.kind,body:n.body,deps:n.deps})),skipped:saved.skipped};
  const i=mined.findIndex(r=>r.id===c.id);if(i<0)mined.push(row);else mined[i]=row;
  save(notesFile,mined);log(`mined ${c.id}: ${row.saved.length} notes`);
 }
 const originalNotes=Object.fromEntries(fs.readdirSync(notes).filter(f=>f.endsWith('.json')).sort().map(f=>[f,hash(path.join(notes,f))]));
 save(path.join(out,'notes-hashes.json'),originalNotes);
 for(const file of Object.keys(originalNotes))fs.copyFileSync(path.join(notes,file),path.join(cache,file));
 process.env.THINKER_NOTES_DIR=cache;
 for(const c of manifest.cases.filter(c=>c.cohort===cohort)){
  const prior=results.find(r=>r.id===c.id);
  if(prior?.baseline?.validModel&&prior?.cached?.validModel)continue;
  git(['reset','--hard',manifest.base],wt);
  git(['apply','--reverse','-'],wt,git(['diff','--binary',c.parent,c.sha]));
  const diff=git(['diff','--no-color','-U0','HEAD'],wt);
  const row={...(prior||{}),id:c.id,pr:c.pr,source:`https://github.com/${manifest.repo}/pull/${c.pr}`,sha:c.sha,base:manifest.base,model:cfg.model,reasoningEffort:cfg.effort,cohort,expect:Object.fromEntries(parseDiff(diff).map(f=>[f.path,[...new Set([...f.touched,...f.removedAt])]]))};
  const arms=[['baseline',{mode:'nocache',related:false}],['cached',{mode:'holistic',related:true}]];
  if(c.caseIndex%2)arms.reverse();row.armOrder=arms.map(a=>a[0]);
  const checkpoint=()=>{const i=results.findIndex(r=>r.id===row.id);if(i<0)results.push(row);else results[i]=row;save(resultsFile,results);};
  for(const [arm,strategy] of arms){
   if(row[arm]?.validModel)continue;
   if((process.env.THINKER_EVAL_SKIP_ARMS||'').split(',').includes(`${c.id}/${arm}`)){if(!row[arm]||row[arm].validModel)throw Error('Can only skip a previously invalid terminal arm');log(`${c.id} ${arm}: prior attempts exhausted; retained invalid`);continue;}
   const beforeTraces=new Set(fs.readdirSync(traces));
   const t0=Date.now();const report=await review(store,{scope:resolveScope(wt),strategy,model:cfg.model,max:12});
   const validModel=!report.errors.length&&report.models?.[`${cfg.provider}/${cfg.model}`]===1&&Object.keys(report.models).length===1;
   row[arm]={...report,elapsedMs:Date.now()-t0,validModel};checkpoint();
   if(!validModel){
    const traceFiles=fs.readdirSync(traces).filter(f=>!beforeTraces.has(f)).map(f=>`${name}/${cohort}/traces/${f}`);
    fs.appendFileSync(path.join(out,'invalid-reviews.jsonl'),JSON.stringify({repo:name,cohort,id:c.id,arm,report:row[arm],traceFiles,at:new Date().toISOString(),disposition:'invalid output; excluded from detection scores'})+'\n');
    if(process.env.THINKER_EVAL_CONTINUE_ERRORS!=='1')throw Error(`${c.id} ${arm} invalid model/error: ${JSON.stringify({models:report.models,errors:report.errors})}`);
    log(`${c.id} ${arm}: INVALID; continue remaining frozen cases`);
   }
  }
  log(`reviewed ${c.id}: ${row.baseline.findings.length}/${row.cached.findings.length} findings`);
 }
 if(Object.entries(originalNotes).some(([f,h])=>hash(path.join(notes,f))!==h))throw Error('Original note corpus changed');
 const invalidPairs=results.filter(r=>!r.baseline?.validModel||!r.cached?.validModel);
 if(invalidPairs.length){log(`INVALID PAIRS: ${invalidPairs.map(r=>r.id).join(', ')}`);process.exitCode=1;}else log('COMPLETE');
} finally {
 const usage=path.join(wt,'.thinker','log.jsonl');if(fs.existsSync(usage))fs.appendFileSync(path.join(out,'usage.jsonl'),fs.readFileSync(usage));
 git(['worktree','remove','--force',wt]);
}

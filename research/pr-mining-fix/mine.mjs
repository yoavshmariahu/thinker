import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {Store} from '../../src/store.js';import {minePrs} from '../../src/commands/learn.js';import {orient} from '../../src/ops.js';import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('test mode required');
const [label,cohort]=process.argv.slice(2),models={opus:'claude-opus-5-5',sol:'gpt-6.1-sol',gemini:'gemini-3.8-flash-high'};
if(!/^[a-z0-9-]+$/.test(label||'')||!models[cohort])throw Error('label and cohort required');
if(fs.existsSync('research/pr-mining-fix/PAUSE'))throw Error('diagnostic batch paused for a grounding fix');
const root=path.resolve('.'),out=path.join(root,'research/pr-mining-fix/raw',label);fs.mkdirSync(out);
const base=path.join(root,'bench/runs/pr-mining-fix'),repo=path.join(base,label);
execFileSync('git',['worktree','add','--detach',repo,'base'],{cwd:path.join(base,'click.git'),stdio:'pipe'});
const all=JSON.parse(fs.readFileSync(path.join(base,'prs.json'))).tasks['click-3364'];const corpus={...all,limit:3,prs:all.prs.filter(p=>[3151,3245,2991].includes(p.number))};
fs.writeFileSync(path.join(out,'prs.json'),JSON.stringify(corpus,null,2));
const bin=path.join(out,'bin');fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'gh'),`#!/usr/bin/env node
import fs from 'node:fs';const a=process.argv.slice(2);if(a.join(' ')==='--version'){console.log('gh frozen diagnostic');process.exit(0)}
if(a[0]!=='pr'||a[1]!=='list'||a[a.indexOf('--repo')+1]!=='pallets/click')throw Error('unfrozen request');
console.log(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(out,'prs.json'))})).prs));`,{mode:0o755});
Object.assign(process.env,{PATH:bin+path.delimiter+process.env.PATH,THINKER_LLM:{opus:'claude',sol:'codex',gemini:'gemini'}[cohort],THINKER_LLM_MODEL:models[cohort],THINKER_CLAUDE_EFFORT:'high',THINKER_CODEX_REASONING_EFFORT:'high',THINKER_GEMINI_EFFORT:'high',THINKER_NO_LIMIT_WAIT:'1',THINKER_EVAL_TRACE_DIR:out,THINKER_LOG:'local',THINKER_HOOKS:'off',THINKER_MCP:'off',THINKER_NO_AUTO_UPDATE:'1',THINKER_NO_LEARN:'1'});delete process.env.MAX_THINKING_TOKENS;
const append=(file,x)=>fs.appendFileSync(path.join(out,file),JSON.stringify(x)+'\n');
const snapshot=execFileSync('git',['diff','--binary','--','src'],{encoding:'utf8'});fs.writeFileSync(path.join(out,'source.patch'),snapshot);
fs.writeFileSync(path.join(out,'protocol.json'),JSON.stringify({cohort,model:models[cohort],effort:'high',jev:'jev-1.13.0',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),patchSha:crypto.createHash('sha256').update(snapshot).digest('hex'),source:'PR-only',prIds:corpus.prs.map(p=>p.number),retries:'at most one transient Jev retry; at most one writer repair per PR; all attempts retained'},null,2));
const store=new Store(repo).init(),original=store.config.bind(store);let seq=0;
store.config=()=>({...original(),maintain:{dailyTokens:1e9},jev:{enabled:true,key:jevKey(),model:'jev-1.13.0',learningTimeoutMs:10000,fetchImpl:async(url,opts)=>{
 if(url!==JEV_ENDPOINT)throw Error('unexpected endpoint');const id=seq++,request=JSON.parse(opts.body),start=performance.now();
 try{const r=await fetch(url,opts),response=await r.json();append('transport.jsonl',{id,request,response,status:r.status,wallMs:performance.now()-start});if(response.model&&response.model!=='jev-1.13.0')throw Error('model mismatch');return {ok:r.ok,status:r.status,json:async()=>response};}catch(e){append('transport.jsonl',{id,request,error:e.message});throw e;}
}}});
const log=store.log.bind(store);store.log=r=>{append('usage.jsonl',r);return log(r)};
const start=performance.now();let result;
try{result=await minePrs({repo,store,flags:{verbose:true},out:console.log},'pallets/click',{repo,before:corpus.before,limit:3,model:models[cohort],phase:'init'});
 const retrieval=await orient(store,{task:'Fix editor command parsing and stream cleanup in CliRunner; check test isolation configuration.',budget:1500,maxNotes:3,freshOnly:true});
 const notes=store.list();
 const callsBeforeReplay=seq; const replay=await minePrs({repo,store,flags:{},out:()=>{}},'pallets/click',{repo,before:corpus.before,limit:3,model:models[cohort],phase:'init'});
 if(seq!==callsBeforeReplay||replay.saved||store.list().length!==notes.length)throw Error('replay was not idempotent');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({result,notes,retrieval,replay,wallMs:performance.now()-start},null,2));console.log('RESULT',JSON.stringify({result,notes:notes.length,served:retrieval.included.map(n=>n.id)}));
}catch(e){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:e.message,wallMs:performance.now()-start}));throw e;}

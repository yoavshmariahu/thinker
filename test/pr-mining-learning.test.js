import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for (const mode of ['repair', 'reject', 'unavailable']) test(`PR mining ${mode}: grounded revision, bounded work and retry receipts`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pr-learning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(repo, 'src'), {recursive:true}); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(repo, 'src/example.js'), 'export function readCache(value) { return value; }\n');
  const prs = [123, 124].map(number => ({ number, title: 'Fix cached value handling', body: 'Preserve the supplied value.',
    mergedAt:`2026-01-0${number-122}T00:00:00Z`, additions:3, files:[{path:'src/example.js'}], comments:[],
    diff:'diff --git a/src/example.js b/src/example.js\n+export function readCache(value) { return value; }',
  }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(JSON.stringify(${JSON.stringify(prs)}));\n`, {mode:0o755});
  const good = {title:'Cached values', kind:'rule', answers:['How is a cached value read?'], body:'src/example.js:readCache returns the supplied value.', applies:'readCache', deps:[{path:'src/example.js',symbol:'readCache'}],tags:[],confidence:.8};
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 const fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(dir,'prompts.jsonl'))},JSON.stringify(prompt)+'\\n');
 const good=${JSON.stringify(good)},mode=${JSON.stringify(mode)},first=prompt.startsWith('PR #123:'),repair=prompt.includes('GROUNDING FEEDBACK');
 const notes=first ? mode==='unavailable' ? [good,{...good,title:'Another fact',body:'UNAVAILABLE'}] : [{...good,body:repair&&mode==='repair'?good.body:'UNSUPPORTED'}] : [];
 console.log(JSON.stringify({structured_output:{notes},usage:{input_tokens:10,output_tokens:2},model:'claude-opus-5-5'}));
});`, {mode:0o755});
  const script = `import fs from 'node:fs';import path from 'node:path';
import {Store} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};
import {minePrs} from ${JSON.stringify(new URL('../src/commands/learn.js',import.meta.url).href)};
import {minedPrs} from ${JSON.stringify(new URL('../src/prs.js',import.meta.url).href)};
const repo=${JSON.stringify(repo)},store=new Store(repo).init(),original=store.config.bind(store),events=[],outputs=[];
store.config=()=>({...original(),jev:{enabled:true,key:'test',fetchImpl:async(_url,opts)=>{
 const q=JSON.parse(opts.body);if(q.state.claims){const receipt=JSON.parse(fs.readFileSync(path.join(path.dirname(store.notesDir),'prs.json')));if(!receipt['o/r']?.retry?.includes(123))throw Error('missing durable incomplete marker');if(minedPrs(store,'o/r').mined.has(123))throw Error('partial PR was marked complete before grounding finished');}if(q.state.claims?.includes('UNAVAILABLE'))return{ok:true,json:async()=>({answers:{}})};
 const answers=Object.fromEntries(Object.entries(q.questions).map(([id,question])=>[id,question.type==='choice'?{choice:'unrelated',probabilities:{covered:.01,extends:.01,contradicts:.01,unrelated:.97}}:{noul:q.state.grounded_body ? .01 : q.state.notes?.length ? .01 : id.startsWith('x') ? .01 : q.state.claims?.includes('UNSUPPORTED') ? .05 : .98}]));
 return{ok:true,json:async()=>({model:'jev-test',answers,usage:{input_tokens:10,output_tokens:2}})};
}}});
const log=store.log.bind(store);store.log=e=>{events.push(e);return log(e)};
const args={repo,before:'2026-01-03T00:00:00Z',limit:2,model:'claude-opus-5-5',phase:'init'};
const result=await minePrs({repo,store,flags:{},out:s=>outputs.push(s)},'o/r',args);
console.log(JSON.stringify({result,notes:store.list(),mined:[...minedPrs(store,'o/r').mined],events,outputs}));`;
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,THINKER_TEST:'1',THINKER_LOG:'local',THINKER_LLM:'claude',THINKER_HOME:path.join(dir,'home')};
  for(const key of ['ANTHROPIC_API_KEY','THINKER_LLM_CMD','THINKER_NOTES_DIR','THINKER_REPO','THINKER_LLM_MODEL','THINKER_EVAL_TRACE_DIR','THINKER_JEV','THINKER_JEV_MODEL'])delete env[key];
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repo,env,encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);
  const actual=JSON.parse(run.stdout.trim().split('\n').at(-1));
  const prompts=fs.readFileSync(path.join(dir,'prompts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(prompts.filter(p=>p.includes('GROUNDING FEEDBACK')).length, mode==='unavailable'?0:1);
  assert.equal(actual.result.failed,mode==='unavailable'?1:0);
  assert.ok(actual.mined.includes(124),'later PR completes despite first PR failure');
  if(mode==='repair'){
    assert.equal(actual.result.saved,1);assert.equal(actual.notes[0].body,good.body);
    assert.deepEqual(actual.notes[0].source,{type:'pr',ref:'o/r#123'});
    assert.equal(prompts[1].split('\n\nGROUNDING FEEDBACK')[0],prompts[0]);
  }else if(mode==='reject'){
    assert.equal(actual.result.saved,0);assert.ok(actual.mined.includes(123));
    assert.equal(fs.readdirSync(path.join(repo,'.thinker/state/learning-pending')).length,1);
  }else{
    assert.equal(actual.result.saved,1);
    assert.ok(!actual.mined.includes(123),'partially saved PR with unavailable checks must retry');
    assert.ok(actual.outputs.some(s=>s.includes('1 failed')),'progress exposes a failed PR');
  }
});

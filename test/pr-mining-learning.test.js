import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// One writer call per pull request, the notes it proposes saved through saveNotes, every mined
// pull request recorded so no run distills it twice.
test('PR mining: one writer call per pull request, notes saved, both recorded as mined', t => {
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
 const notes=prompt.startsWith('PR #123:') ? [${JSON.stringify(good)}] : [];
 console.log(JSON.stringify({structured_output:{notes},usage:{input_tokens:10,output_tokens:2},model:'claude-opus-5-5'}));
});`, {mode:0o755});
  const script = `import {Store} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};
import {minePrs} from ${JSON.stringify(new URL('../src/commands/learn.js',import.meta.url).href)};
import {minedPrs} from ${JSON.stringify(new URL('../src/prs.js',import.meta.url).href)};
const repo=${JSON.stringify(repo)},store=new Store(repo).init(),outputs=[];
const args={repo,before:'2026-01-03T00:00:00Z',limit:2,model:'claude-opus-5-5',phase:'init'};
const result=await minePrs({repo,store,flags:{},out:s=>outputs.push(s)},'o/r',args);
console.log(JSON.stringify({result,notes:store.list(),mined:[...minedPrs(store,'o/r').mined],outputs}));`;
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,THINKER_TEST:'1',THINKER_LOG:'local',THINKER_LLM:'claude',THINKER_HOME:path.join(dir,'home')};
  for(const key of ['ANTHROPIC_API_KEY','THINKER_LLM_CMD','THINKER_NOTES_DIR','THINKER_REPO','THINKER_LLM_MODEL','THINKER_EVAL_TRACE_DIR'])delete env[key];
  const run=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repo,env,encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);
  const actual=JSON.parse(run.stdout.trim().split('\n').at(-1));
  const prompts=fs.readFileSync(path.join(dir,'prompts.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(prompts.length, 2, 'one writer call per pull request');
  assert.equal(actual.result.saved, 1);
  assert.equal(actual.result.failed, 0);
  assert.deepEqual(actual.notes.map(n => n.title), ['Cached values']);
  assert.deepEqual(actual.mined.sort(), [123, 124], 'both pull requests are recorded as mined');
  assert.ok(!fs.existsSync(path.join(repo,'.thinker/state/learning-pending')), 'nothing is deferred');
});

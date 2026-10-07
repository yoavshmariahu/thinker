import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('normal PR mining uses frozen GitHub replay and preserves PR note provenance', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pr-benchmark-'));
  try {
    const repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(repo, 'src'), {recursive:true}); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'src/example.js'), 'export function readCache(value) {\n  return value;\n}\n');
    const corpus = {repository:'pallets/click',before:'2026-01-02T00:00:00Z',limit:20,prs:[{
      number:123,title:'Fix cached value handling',body:'Preserve the value supplied to readCache.',
      mergedAt:'2026-01-01T00:00:00Z',additions:3,files:[{path:'src/example.js'}],
      comments:[],diff:'diff --git a/src/example.js b/src/example.js\n+export function readCache(value) { return value; }',
    }]};
    fs.writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify(corpus));
    const replay = `import json,sys\nsys.path.insert(0,${JSON.stringify(path.join(root,'research/performance-canary'))})\nfrom frozen_gh import replay\nprint(replay(sys.argv[1:],json.load(open(${JSON.stringify(path.join(dir,'corpus.json'))}))))\n`;
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env python3\n'+replay, {mode:0o755});
    const note = {title:'Read cached values through readCache',kind:'map',answers:['where are cached values returned'],
      body:'`src/example.js:readCache` returns the supplied cached value.',deps:[{path:'src/example.js',symbol:'readCache'}],tags:['cache'],confidence:.9};
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 require('fs').writeFileSync(${JSON.stringify(path.join(dir,'model-prompt.txt'))},input);
 console.log(JSON.stringify(${JSON.stringify({result:'',structured_output:{notes:[note]},usage:{input_tokens:10,output_tokens:2},model:'claude-opus-5-5'})}));
});
`, {mode:0o755});
    const script = `import {Store} from ${JSON.stringify(new URL('../src/store.js',import.meta.url).href)};
import {minePrs} from ${JSON.stringify(new URL('../src/commands/learn.js',import.meta.url).href)};
const repo=${JSON.stringify(repo)},store=new Store(repo).init();
const result=await minePrs({repo,store,flags:{},out:()=>{}},'pallets/click',{repo,before:'2026-01-02T00:00:00Z',limit:20,model:'claude-opus-5-5',phase:'init'});
console.log(JSON.stringify({result,notes:store.list()}));`;
    const env = {...process.env,PATH:bin+path.delimiter+process.env.PATH,THINKER_TEST:'1',THINKER_TELEMETRY:'off',THINKER_LOG:'local',THINKER_LLM:'claude',THINKER_QUIET:'1'};
    for (const key of ['ANTHROPIC_API_KEY','THINKER_LLM_CMD','THINKER_NOTES_DIR','THINKER_REPO','THINKER_LLM_MODEL','THINKER_EVAL_TRACE_DIR']) delete env[key];
    const result = spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:repo,env,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    const actual = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(actual.result.saved,1); assert.equal(actual.result.failed,0);
    assert.deepEqual(actual.notes[0].source,{type:'pr',ref:'pallets/click#123'});
    const prompt = fs.readFileSync(path.join(dir,'model-prompt.txt'),'utf8');
    assert.match(prompt,/PR #123/); assert.match(prompt,/DIFF:/); assert.match(prompt,/readCache/);
    assert.ok(!fs.existsSync(path.join(repo,'.thinker/state/learning-pending')));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

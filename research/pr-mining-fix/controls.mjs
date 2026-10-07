// Source-grounding controls only. These fixtures are never saved as cache notes.
import fs from 'node:fs';import {prepareNotes} from '../../src/note-learning.js';import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('test mode required');
const label=process.argv[2]||'controls';if(!/^[a-z0-9-]+$/.test(label))throw Error('label');
const out=`research/pr-mining-fix/raw/${label}`;fs.mkdirSync(out);
const corpus=JSON.parse(fs.readFileSync('bench/runs/pr-mining-fix/prs.json')).tasks['click-3364'].prs;
const append=(name,r)=>fs.appendFileSync(`${out}/${name}.jsonl`,JSON.stringify(r)+'\n');let active;
const store={list:()=>[],log:r=>append('usage',{active,...r}),config:()=>({jev:{enabled:true,key:jevKey(),model:'jev-1.13.0',learningTimeoutMs:10000,fetchImpl:async(url,opts)=>{if(url!==JEV_ENDPOINT)throw Error('endpoint');const r=await fetch(url,opts),response=await r.json();append('transport',{active,request:JSON.parse(opts.body),response,status:r.status});return{ok:r.ok,status:r.status,json:async()=>response}}}})};
const cases=[
 [2991,false,'All StreamMixer operations are thread-safe','src/click/testing.py:StreamMixer.__del__ closes self.stderr, then self.stdout, then self.output.'],
 [2991,false,'StreamMixer cleanup','src/click/testing.py:StreamMixer.__del__ closes self.stderr, then self.stdout, then self.output.','All Python streams'],
 [3151,true,'Randomized test execution','Run tox r -e random to run tests in parallel in a random order to detect test pollution.'],
 [2991,true,'StreamMixer cleanup','src/click/testing.py:StreamMixer.__del__ closes self.stderr, then self.stdout, then self.output.'],
 [2991,false,'StreamMixer cleanup','StreamMixer closes output before stderr and stdout.'],
 [2991,false,'StreamMixer concurrency','StreamMixer is thread-safe in every Python implementation.'],
 [2991,false,'StreamMixer fixes','The change fixes all races in Click, including issue #824.'],
 [3151,true,'Randomized test environment','The random tox environment installs the tests-random group containing pytest, pytest-randomly and pytest-xdist.'],
 [3151,false,'Randomized test environment','The random tox environment installs only pytest and runs with --numprocesses=1.'],
 [3245,true,'Editor invocation','Editor.edit_files calls subprocess.Popen with args=shlex.split(editor) + list(filenames), env=environ, without shell=True.'],
 [3245,false,'Editor invocation','Editor.edit_files calls subprocess.Popen with shell=True and concatenates quoted filenames into a shell command.'],
];
const results=[];
for(let repeat=1;repeat<=3;repeat++)for(const [pr,expected,title,body,applies=""]of cases){active={repeat,pr,expected,title,body,applies};const p=corpus.find(p=>p.number===pr);const evidence=`PR #${p.number}: ${p.title}\n\nDESCRIPTION:\n${p.body.replace(/<!--[\s\S]*?-->/g,'').slice(0,5000)}\n\nREVIEW COMMENTS:\n${p.comments.join('\n')||'(none)'}\n\nDIFF:\n${p.diff.slice(0,45000)}`;
const result=await prepareNotes(store,[{kind:'rule',title,body,applies}],{evidence,accounting:{phase:'init'}});const row={...active,accepted:!!result.notes.length,result};results.push(row);fs.writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));console.log(repeat,pr,expected,row.accepted,result.deferred.map(d=>d.reason));}
if(results.some(r=>r.expected!==r.accepted))process.exitCode=1;

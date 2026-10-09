// Real patch-producing tasks; one session per arm, no memory cross-contamination.
import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';
import {transcriptPath,toolStats} from '../cbm-arms.js';import {parseTranscript} from '../../src/transcripts.js';import {condense} from '../../src/distill.js';
const ROOT=path.resolve(import.meta.dirname,'../..'),RAW=path.join(ROOT,'research/mem0-real-tasks/raw'),STATE=path.join(ROOT,'bench/worktrees/mem0-real');
const TASKS=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'tasks.json')));
const env={...process.env,THINKER_TELEMETRY:'off',MEM0_TELEMETRY:'false',OTEL_SDK_DISABLED:'true',THINKER_HOOKS:'off',THINKER_MCP:'off',THINKER_NO_LEARN:'1',THINKER_NO_BG_VERIFY:'1',THINKER_NO_AUTO_UPDATE:'1',THINKER_LOG:'off',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1'};
async function run(task,arm){
 const id=task.id+'-'+arm,file=path.join(RAW,id+'.json');if(fs.existsSync(file))return;
 const cwd=path.join(STATE,id),learn=arm==='learn';
 const memory=learn||arm==='control'?'':JSON.parse(fs.readFileSync(path.join(RAW,id+'-retrieval.json'))).context;
 const rules=`Work only within this repository. Do not access sibling directories, external websites, git remotes or history, reference patches or hidden evaluator tests. Do not install dependencies, create commits, or delegate to other agents. Machine-wide memory hooks are disabled. Resolve any memory file pointers relative to this repository, not the original learning directory. You may use the preinstalled test interpreter ${ROOT}/.venv-mem0/bin/python; run tests with PYTHONPATH=src. `;
 const prompt=learn?rules+'\n'+task.learning:rules+`Implement the requested change, add tests where appropriate, and run relevant tests. Leave the patch uncommitted and summarize the result.\n\nMEMORIES FROM EARLIER SESSIONS:\n${memory||'(none)'}\n\nREQUEST:\n${task.prompt}`;
 fs.writeFileSync(path.join(RAW,id+'-prompt.txt'),prompt);
 const args=['-p','--model','claude-sonnet-5-5','--output-format','json','--permission-mode','bypassPermissions','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--disable-slash-commands','--tools',learn?'Read,Grep,Glob,Bash':'Read,Grep,Glob,Bash,Edit,Write','--max-turns',learn?'30':'70'];
 console.log('START',id,new Date().toISOString());const start=performance.now();
 const p=spawn('claude',args,{cwd,env});let stdout='',stderr='',timedOut=false;
 p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.stdin.end(prompt);
 const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM')},20*60_000);
 const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve)});clearTimeout(timer);
 fs.writeFileSync(path.join(RAW,id+'-stdout.txt'),stdout);fs.writeFileSync(path.join(RAW,id+'-stderr.txt'),stderr);
 let result;try{result=JSON.parse(stdout)}catch{result={result:stdout,is_error:true};}
 const transcript=result.session_id?transcriptPath(result.session_id,cwd):null;
 const stats=transcript?toolStats(transcript):{};
 const events=transcript&&fs.existsSync(transcript)?parseTranscript(transcript).events:[];
 fs.writeFileSync(path.join(RAW,id+'.events.json'),JSON.stringify(events,null,2));
 if(learn){
  if(code||result.is_error||timedOut)throw Error('Learning failed: '+id);
  fs.writeFileSync(path.join(RAW,id+'-evidence.txt'),condense(events));
 }else{
  execFileSync('git',['add','-A'],{cwd,env});
  const diff=execFileSync('git',['diff','--cached','--binary','--no-color'],{cwd,env,encoding:'utf8',maxBuffer:20*1024*1024});
  fs.writeFileSync(path.join(RAW,id+'.patch'),diff);
 }
 const record={id,arm,wall_ms:performance.now()-start,code,timedOut,...result,tools:stats};
 fs.writeFileSync(file,JSON.stringify(record,null,2));console.log('DONE',id,Math.round(record.wall_ms/1000)+'s',stats.calls+' calls',result.is_error?'ERROR':'');
}
if(process.argv[2]==='learn')for(const task of TASKS)await run(task,'learn');
else for(const [i,task] of TASKS.entries())for(const arm of (i===0?['control','thinker','mem0']:['mem0','thinker','control']))await run(task,arm);

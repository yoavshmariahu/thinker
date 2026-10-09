import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {transcriptPath, toolStats} from './cbm-arms.js';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'research/mem0-comparison/raw');
const cwd=path.join(root,'bench/worktrees/click-source');
const spec=JSON.parse(fs.readFileSync(path.join(root,'bench/tasks/click.json')));
export async function run(id,prompt,dir=cwd) {
 const file=path.join(out,id+'.json'); if(fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
 const args=['-p','--model','claude-sonnet-5-5','--output-format','json','--permission-mode','bypassPermissions','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--disable-slash-commands','--tools','Read,Grep,Glob,Bash','--max-turns','25'];
 const start=performance.now();
 const p=spawn('claude',args,{cwd:dir,env:{...process.env,THINKER_TELEMETRY:'off',MEM0_TELEMETRY:'false',THINKER_HOOKS:'off',THINKER_MCP:'off',THINKER_NO_LEARN:'1',THINKER_NO_BG_VERIFY:'1',THINKER_NO_AUTO_UPDATE:'1',THINKER_LOG:'off',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
 let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.stdin.end(prompt);
 const timer=setTimeout(()=>p.kill('SIGTERM'),600000);
 const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve)});clearTimeout(timer);
 const result=JSON.parse(stdout);if(code||result.is_error)throw Error(JSON.stringify({code,stderr,result}));
 const transcript=transcriptPath(result.session_id,dir);
 const record={id,wall_ms:performance.now()-start,...result,tools:toolStats(transcript)};
 fs.writeFileSync(file,JSON.stringify(record,null,2));fs.copyFileSync(transcript,path.join(out,id+'.transcript.jsonl'));
 console.log(id,Math.round(record.wall_ms/1000)+'s',record.tools.calls+' calls');return record;
}
if(process.argv[2]==='learn')for(const id of ['L1-option-value-path','L5-testing'])await run(id,spec.learn.find(t=>t.id===id).prompt);

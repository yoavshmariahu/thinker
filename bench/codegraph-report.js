#!/usr/bin/env node
// Regenerate the three-pair comparison from saved run records and transcripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'bench/runs/posthog-thinker-vs-codegraph-3');
const protocol = JSON.parse(fs.readFileSync(path.join(DIR, 'protocol.json')));
const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/posthog-hard.json'))).tasks;
const rows = protocol.order.map(({task,arm}) => {
  const id = `${task}-${arm}-0`, file = path.join(DIR,id+'.json');
  if (!fs.existsSync(file)) return {task,arm,pending:!protocol.stopped_by_user,stopped:!!protocol.stopped_by_user};
  const r = JSON.parse(fs.readFileSync(file));
  const criteria = tasks.find(t => t.id === task).criteria.filter(c => c.calibrated !== false && c.essential);
  const events = fs.readFileSync(path.join(DIR,'events',id+'.jsonl'),'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});
  const mcp = events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>e.item);
  const commands = events.filter(e=>e.type==='item.completed'&&e.item?.type==='command_execution').map(e=>e.item.command || '');
  const stderr = fs.readFileSync(path.join(DIR,'events',id+'.stderr.log'),'utf8');
  const mcpErrors = mcp.filter(i=>i.error || i.result?.isError || /cannot answer from this index|auto-sync is DISABLED/.test(JSON.stringify(i.result))).map(i=>({server:i.server,tool:i.tool,error:i.error,result:i.result}));
  return {task:r.task,arm:r.arm,model:r.model,effort:r.effort,wall_s:r.wall_ms/1000,calls:r.tools.calls,mcp_calls:r.tools.mcpCalls,
    status:r.audit.timedOut?'timeout':r.error?'error':'completed',
    input_tokens:r.audit.timedOut?null:r.in_tokens,cached_tokens:r.audit.timedOut?null:r.cached_tokens,
    fresh_input_tokens:r.audit.timedOut?null:r.in_tokens-r.cached_tokens,output_tokens:r.audit.timedOut?null:r.out_tokens,
    essential:r.grade?.essential,essential_met:r.grade ? criteria.filter(c => r.grade.results.find(g => g.id === c.id)?.verdict === 'met').length : null,
    essential_total:criteria.length,all:r.grade?.all,pass:r.grade?.pass,patch_chars:r.diff?.length,
    mcp_response_chars:mcp.reduce((n,i)=>n+(i.result?.content||[]).reduce((s,c)=>s+(c.text?.length||0),0),0),
    audit:{...r.audit,mcpErrors,watcherDegraded:/watcher degraded|watcher disabled|EMFILE/i.test(stderr),
      forbiddenCommands:commands.filter(c=>/(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add|sync)|\bgit\s+(?:clone|fetch|pull)\b/.test(c))},error:r.error};
});
const complete = rows.filter(r=>!r.pending&&!r.stopped);
const totals = {};
for(const arm of ['thinker','codegraph']) {
 const rs=complete.filter(r=>r.arm===arm),n=rs.length;
 totals[arm]={n,completed:rs.filter(r=>r.status==='completed').length,timeouts:rs.filter(r=>r.status==='timeout').length};
 for(const field of ['wall_s','calls','mcp_calls','input_tokens','cached_tokens','fresh_input_tokens','output_tokens','mcp_response_chars']) totals[arm][field]=rs.some(r=>r[field]===null)?null:rs.reduce((s,r)=>s+r[field],0);
 totals[arm].mean_essential=rs.every(r=>typeof r.essential==='number')&&n?rs.reduce((s,r)=>s+r.essential,0)/n:null;
 totals[arm].strict_passes=rs.filter(r=>r.pass&&r.status==='completed').length;
 totals[arm].patches_passing_essential=rs.filter(r=>r.pass).length;
 totals[arm].essential_met=rs.every(r=>r.essential_met!==null)?rs.reduce((s,r)=>s+r.essential_met,0):null;
 totals[arm].essential_total=rs.reduce((s,r)=>s+r.essential_total,0);
}
const summary={protocol,rows,totals};
fs.writeFileSync(path.join(DIR,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log('| Task | Tool | Minutes | Calls | Input tokens | Fresh input | Output | Essential | Pass |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---|');
for(const task of protocol.tasks) for(const arm of ['thinker','codegraph']) {
 const r=rows.find(r=>r.task===task&&r.arm===arm);
 if(r.stopped) console.log(`| ${task} | ${arm} | stopped; not scored | | | | | | |`);
 else if(r.pending) console.log(`| ${task} | ${arm} | pending | | | | | | |`);
 else console.log(`| ${task} | ${arm} | ${(r.wall_s/60).toFixed(2)}${r.status==='timeout'?' (timeout)':''} | ${r.calls} | ${r.input_tokens??'unavailable'} | ${r.fresh_input_tokens??'unavailable'} | ${r.output_tokens??'unavailable'} | ${r.essential===undefined?'ungraded':(100*r.essential).toFixed(1)+'%'} | ${r.status==='timeout'?'timeout':r.pass===undefined?'':r.pass?'yes':'no'} |`);
}
console.log(JSON.stringify(totals,null,2));

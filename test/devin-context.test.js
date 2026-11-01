import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyEvent, validate, wireConfig, policyFile } from '../src/integrations/devin-context/scripts/context.mjs';
const helper=fileURLToPath(new URL('../src/integrations/devin-context/scripts/context.mjs',import.meta.url));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'thinker-devin-context-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,repo:path.join(root,'repo'),stateDir:path.join(root,'state')};}
const output='BEGIN\n'+'diagnostic line\n'.repeat(3000)+'END\nExit code: 0';
const event=(extra={})=>({hook_event_name:'PostToolUse',session_id:'../../session',tool_use_id:'../../call',tool_name:'exec',tool_input:{command:'npm test -- unit'},tool_response:{success:true,output,error:null},...extra});
const policy=(rules)=>({version:1,enabled:true,rules});
const rule={id:'test-log',tool:'exec',inputIncludes:'npm test',action:'compress',maxChars:1200};

test('specific successful outputs are shortened with an exact archive and bounded replacement',t=>{
 const f=fixture(t),ev=event(),r=applyEvent(ev,{...f,policy:policy([rule])}).hookSpecificOutput;
 assert.equal(r.hookEventName,'PostToolUse');assert.ok(r.updatedToolOutput.length<=1200);assert.match(r.updatedToolOutput,/BEGIN/);assert.match(r.updatedToolOutput,/END/);assert.match(r.updatedToolOutput,/middle omitted/);
 const archive=/Original: (.+?)\. Read that archive/.exec(r.updatedToolOutput)[1];
 assert.ok(archive.startsWith(f.stateDir+path.sep));assert.deepEqual(JSON.parse(fs.readFileSync(archive)).response,ev.tool_response);
 assert.equal(fs.statSync(archive).mode & 0o777,0o600);
});
test('omit keeps only a receipt; keep wins over later reduction rules',t=>{
 const f=fixture(t);const omit={...rule,action:'omit'};
 assert.doesNotMatch(applyEvent(event(),{...f,policy:policy([omit])}).hookSpecificOutput.updatedToolOutput,/diagnostic line/);
 assert.deepEqual(applyEvent(event(),{...f,policy:policy([{...rule,action:'keep'},omit])}),{});
});
test('unmatched tools, inputs, short results and disabled policies are unchanged',t=>{
 const f=fixture(t),p=policy([rule]);
 for(const ev of [event({tool_name:'read'}),event({tool_input:{command:'npm install'}}),event({tool_response:{success:true,output:'short'}})])assert.deepEqual(applyEvent(ev,{...f,policy:p}),{});
 assert.deepEqual(applyEvent(event(),{...f,policy:{...p,enabled:false}}),{});
});
test('failed, unknown and non-text results are never reduced',t=>{
 const f=fixture(t);
 for(const r of [{success:false,output},{success:true,output,error:'failed'},{success:true,output:output+'\nExit code: 2'},{output},{success:true,output:{text:'image'}}])assert.deepEqual(applyEvent(event({tool_response:r}),{...f,policy:policy([rule])}),{});
});
test('a missing policy offers the skill once per session and never changes the output',t=>{
 const f=fixture(t),r=applyEvent(event(),{...f,policy:null});assert.match(r.hookSpecificOutput.additionalContext,/thinker-context skill/);assert.equal(r.hookSpecificOutput.updatedToolOutput,undefined);
 assert.deepEqual(applyEvent(event(),{...f,policy:null}),{});
 assert.equal(applyEvent(event({session_id:'new'}),{...f,policy:null}).hookSpecificOutput.updatedToolOutput,undefined);
});
test('policies require narrow selectors and sensible bounds',()=>{
 for(const r of [{...rule,tool:'*'},{...rule,inputIncludes:''},{...rule,inputIncludes:undefined},{...rule,maxChars:1},{...rule,action:'summarize'}])assert.throws(()=>validate(policy([r])));
 assert.deepEqual(validate(policy([rule])),policy([rule]));
});
test('archive failure leaves original output available through the real hook entry point',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(policyFile(f.repo)),{recursive:true});fs.writeFileSync(policyFile(f.repo),JSON.stringify(policy([rule])));
 const home=path.join(f.root,'not-a-directory');fs.writeFileSync(home,'block state creation');
 const out=execFileSync(process.execPath,[helper,'hook'],{cwd:f.repo,input:JSON.stringify(event()),encoding:'utf8',env:{...process.env,THINKER_HOME:home,THINKER_TEST:'1'},stdio:['pipe','pipe','pipe']});assert.deepEqual(JSON.parse(out),{});
});
test('malformed policy does not replace tool output',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(policyFile(f.repo)),{recursive:true});fs.writeFileSync(policyFile(f.repo),'{bad');
 const out=execFileSync(process.execPath,[helper,'hook'],{cwd:f.repo,input:JSON.stringify(event()),encoding:'utf8',env:{...process.env,THINKER_HOME:f.root,THINKER_TEST:'1'},stdio:['pipe','pipe','pipe']});assert.deepEqual(JSON.parse(out),{});
});
test('installation merges only its own hook and is idempotent',()=>{
 const command="'node' '/home/test/.config/devin/skills/thinker-context/scripts/context.mjs' hook";
 const original={agent:{model:'swe-1.6-slow'},proxy:{mode:'manual',url:'http://own-gateway'},hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}],PostToolUse:[{hooks:[{type:'command',command:'other-tool-hook'}]}]}};
 const wired=wireConfig(original,command);assert.deepEqual(wireConfig(wired,command),wired);assert.deepEqual(wired.proxy,original.proxy);assert.deepEqual(wired.hooks.Stop,original.hooks.Stop);assert.equal(wired.hooks.PostToolUse[0].hooks[0].command,'other-tool-hook');assert.equal(original.hooks.PostToolUse.length,1);
});

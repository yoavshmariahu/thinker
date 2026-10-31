#!/usr/bin/env node
// Standalone Devin skill helper. No model calls, network calls, or command rewriting.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const save = (file,value) => { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}); };
export const policyFile = repo => path.join(repo,'.devin','thinker-context.json');
export function validate(policy) {
  if (!policy || policy.version !== 1 || typeof policy.enabled !== 'boolean' || !Array.isArray(policy.rules)) throw Error('Expected version: 1, enabled: boolean, and rules: []');
  if (policy.rules.length > 100) throw Error('At most 100 rules');
  for (const r of policy.rules) {
    if (!r || typeof r.id !== 'string' || !r.id.trim() || !['keep','compress','omit'].includes(r.action)) throw Error('Each rule needs an id and keep, compress, or omit action');
    if (typeof r.tool !== 'string' || !r.tool.trim() || r.tool === '*') throw Error('Each rule must name a specific Devin tool');
    if (r.inputIncludes !== undefined && (typeof r.inputIncludes !== 'string' || !r.inputIncludes.trim())) throw Error('inputIncludes must be a nonempty literal string');
    if (r.action !== 'keep' && !r.inputIncludes) throw Error('Changing a result requires an explicit inputIncludes selector');
    if (r.action === 'compress' && (!Number.isInteger(r.maxChars) || r.maxChars < 256 || r.maxChars > 100000)) throw Error('Compression maxChars must be 256..100000');
  }
  return policy;
}
function matches(r, ev) { return r.tool === ev.tool_name && (!r.inputIncludes || JSON.stringify(ev.tool_input ?? {}).includes(r.inputIncludes)); }
export function applyEvent(ev, { repo, policy, stateDir }) {
  if (ev.hook_event_name !== 'PostToolUse' || !ev.session_id || !ev.tool_use_id) return {};
  const response = ev.tool_response;
  // Preserve unsuccessful/unknown outcomes and all non-text tool results.
  if (response?.success !== true || response.error || typeof response.output !== 'string' || /Exit code:\s*[1-9]\d*/i.test(response.output)) return {};
  const output = response.output;
  const session = path.join(stateDir,hash(repo),hash(String(ev.session_id)));
  if (!policy) {
    const offered = path.join(session,'offered.json');
    if (output.length < 20000 || fs.existsSync(offered)) return {};
    save(offered,{at:new Date().toISOString(),tool:ev.tool_name,chars:output.length});
    return {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'A large tool result entered this session. Use the thinker-context skill to propose specific future outputs to keep, compress, or omit. No output has been removed. Change rules only for the scope the user authorizes.'}};
  }
  validate(policy);
  if (!policy.enabled) return {};
  const rule = policy.rules.find(r=>matches(r,ev));
  if (!rule || rule.action === 'keep') return {};
  if (rule.action === 'compress' && output.length <= rule.maxChars) return {};
  const archive = path.join(session,`${hash(String(ev.tool_use_id))}.json`);
  const receipt = `[Thinker ${rule.action === 'omit' ? 'omitted' : 'shortened'} this successful tool result under rule ${JSON.stringify(rule.id)}. Original: ${archive}. Read that archive if its details are needed.]`;
  let replacement = receipt;
  if (rule.action === 'compress') {
    const available = rule.maxChars - receipt.length - 50;
    if (available < 64) return {};
    const head = Math.floor(available/3), tail = available-head;
    replacement = `${receipt}\n${output.slice(0,head)}\n[… middle omitted …]\n${output.slice(-tail)}`;
  }
  if (replacement.length >= output.length) return {};
  // If archiving fails, throw: the hook entry point returns {}, keeping the original.
  save(archive,{version:1,at:new Date().toISOString(),repo,sessionId:ev.session_id,toolUseId:ev.tool_use_id,tool:ev.tool_name,input:ev.tool_input,response,rule:rule.id});
  return {hookSpecificOutput:{hookEventName:'PostToolUse',updatedToolOutput:replacement}};
}
export function wireConfig(config, command) {
  const result = structuredClone(config);
  result.hooks ??= {};
  const entries = result.hooks.PostToolUse ?? [];
  if (!Array.isArray(entries)) throw Error('PostToolUse hooks must be an array');
  // Own only this helper, leaving all other commands and hooks intact.
  result.hooks.PostToolUse = entries.map(e=>({...e,hooks:(e.hooks??[]).filter(h=>!String(h.command??'').includes('/thinker-context/scripts/context.mjs'))})).filter(e=>e.hooks.length);
  result.hooks.PostToolUse.push({matcher:'.*',hooks:[{type:'command',command,timeout:5}]});
  return result;
}
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'hook') {
    try {
      let input='';for await(const b of process.stdin){input+=b;if(input.length>16*1024*1024)throw Error('Hook input too large');}
      const ev=JSON.parse(input), repo=path.resolve(ev.cwd || process.env.DEVIN_PROJECT_DIR || process.cwd());
      const file=policyFile(repo), policy=fs.existsSync(file)?read(file):null;
      const stateDir=path.join(process.env.THINKER_HOME || path.join(os.homedir(),'.thinker'),'state','devin-context');
      console.log(JSON.stringify(applyEvent(ev,{repo,policy,stateDir})));
    } catch (e) { console.error(`thinker-context: keeping original output: ${e.message}`); console.log('{}'); }
    return;
  }
  if (action === 'install') {
    const dest = path.join(os.homedir(),'.config','devin','skills','thinker-context');
    const configFile=path.join(os.homedir(),'.config','devin','config.json');
    const config=fs.existsSync(configFile)?read(configFile):{}; // Never overwrite JSONC or malformed files.
    const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const command=`${quote(process.execPath)} ${quote(path.join(dest,'scripts','context.mjs'))} hook`;
    const wired=wireConfig(config,command);
    if (path.resolve(source)!==path.resolve(dest)) fs.cpSync(source,dest,{recursive:true});
    save(configFile,wired);
    console.log(`Installed thinker-context in ${dest}. No reduction rules are enabled. Large outputs can offer the skill once per session.`);return;
  }
  const repo=path.resolve(args[0] || process.cwd());
  if(action === 'status'){const f=policyFile(repo);console.log(JSON.stringify({file:f,policy:fs.existsSync(f)?read(f):null},null,2));return;}
  if(action === 'set'){
    if(!args[1])throw Error('Usage: context.mjs set REPO POLICY_JSON_FILE');
    const policy=validate(read(path.resolve(args[1])));save(policyFile(repo),policy);console.log(`Saved ${policyFile(repo)}. Applies only to future matching tool results.`);return;
  }
  if(action === 'off'){save(policyFile(repo),{version:1,enabled:false,rules:[]});console.log('Context reduction and offers disabled for this repository.');return;}
  throw Error('Usage: context.mjs install | hook | status [REPO] | set REPO POLICY_JSON_FILE | off [REPO]');
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});

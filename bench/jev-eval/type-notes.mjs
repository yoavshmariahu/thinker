// Jev cannot WRITE a note. It can TYPE one: fill a facet vector by choosing from closed sets.
// One batched call types N notes across 9 facets. The vector then drives retrieval, verification and agent directions.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
const SRC='/Users/yoavshmariahu/src/thinker';           // notes live in the primary tree
const KEY=process.env.JEVKEY, byId=new Map();
for (const d of [`${SRC}/.thinker/notes`,`${SRC}/.thinker/local/notes`]) { if(!existsSync(d))continue;
  for (const f of readdirSync(d).filter(x=>x.endsWith('.json'))) { try{const n=JSON.parse(readFileSync(`${d}/${f}`,'utf8'));byId.set(n.id,n);}catch{} } }
const all=[...byId.values()];

// 12 notes: the 2 sessions confirmed acting on, plus a spread of kinds and staleness
const want=['hooks-mcp-run-the-archive-installed-app-thinker-app-which-ca','deploy-commands-git-push-origin-main-aws-s3-cp-cloudfront-in',
  'absolute-term-coverage-floor-for-note-retrieval-gating','note-store-mixes-shared-content-with-per-checkout-serving-st',
  'the-prompt-hooks-serve-no-stale-note','running-tests-requires-thinker-telemetry-off',
  'mandatory-worktree-isolation-for-agent-edits-and-benchmarks','auto-mode-does-not-bypass-production-deploy-self-modificatio'];
const picked=[...want.map(i=>byId.get(i)).filter(Boolean)];
for (const n of all) { if(picked.length>=12) break; if(!picked.includes(n)&&(n.body||'').length>120&&!n.archived) picked.push(n); }

const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,4),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,8).join(' ').slice(0,1000),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6)});

const FACETS = i => ({
  [`trigger${i}`]:{type:'choice',
    instructions:`Which kind of task should put \`candidate_notes[${i}]\` in front of a developer?`,
    criteria:{
      locating_code:'They need to find where something is implemented or handled.',
      running_or_building:'They need to run, build, test or deploy something.',
      changing_safely:'They are about to change code and this constrains how.',
      reviewing_a_change:'They are checking a change someone already made.',
      wiring_or_installing:'They are installing or configuring the tool or an agent integration.',
      interpreting_output:'They are trying to understand output, a log, a metric or a report.',
      none_of_these:'No task shape fits.'}},
  [`direction${i}`]:{type:'choice',
    instructions:`What should an agent actually DO when it is given \`candidate_notes[${i}]\`?`,
    criteria:{
      open_the_code:'Open the code it points at and read that region.',
      run_the_command:'Run the specific command or flag it names.',
      check_change_against_it:'Hold the change up against the constraint it states and confirm it still holds.',
      avoid_the_action:'Not do the thing it warns about, and take its stated alternative instead.',
      background_only:'Nothing directly; it is context, not an instruction.'}},
  [`enforced_by${i}`]:{type:'choice',
    instructions:`What makes what \`candidate_notes[${i}]\` claims actually hold? Choose what the note itself names.`,
    criteria:{
      a_test:'A test asserts it, so breaking it fails the suite.',
      a_schema_or_registry:'A shared list, schema or registry that several places read.',
      a_generator_or_mirror:'Generated code, or a value duplicated in more than one place that must match.',
      an_external_tool:'The behaviour of a tool or service outside this repository.',
      only_convention:'Nothing enforces it; it holds because people follow it.'}},
  // the verification key: what would have to change for this note to become wrong?
  [`drift_surface${i}`]:{type:'choice',
    instructions:`What single change to the codebase would make \`candidate_notes[${i}]\` wrong?`,
    criteria:{
      a_symbol_moving:'A named function, constant or class it depends on is renamed, moved or removed.',
      a_number_changing:'A threshold, default, limit or version it states is changed to a different value.',
      a_path_changing:'A file or directory it names is moved or renamed.',
      an_external_tool_changing:'A tool, service or platform outside this repository behaves differently.',
      mechanism_removed:'The whole mechanism it describes is deleted from the codebase.',
      nothing_historical:'Nothing could; it records something that happened and stays true.'}},
  [`blast${i}`]:{type:'score',
    instructions:`If a developer ignored \`candidate_notes[${i}]\`, how bad would the consequence be?`,
    criteria:['No consequence; they would just take a slower route.',
      'Wasted time: they would rediscover it or backtrack.',
      'A broken build, failed test or wrong output caught before shipping.',
      'Damage that reaches users, data or another person: a bad deploy, lost work, or a silent wrong result.']},
  [`volatility${i}`]:{type:'score',
    instructions:`How likely is \`candidate_notes[${i}]\` to stop being true as this codebase changes?`,
    criteria:['Essentially permanent: a structural fact or an external constraint.',
      'Stable: would need a deliberate redesign to change.',
      'Drifts: rests on values or names under active development.',
      'Fragile: describes something being actively rewritten right now.']},
  [`machine_specific${i}`]:{type:'noul',
    instructions:`Is \`candidate_notes[${i}]\` about the state of one particular machine or account rather than about the codebase?`,
    criteria:{true:'Describes one machine, one install, or one person\'s account state.',false:'Describes the codebase or a tool\'s general behaviour.'}},
  [`contradicts_default${i}`]:{type:'noul',
    instructions:`Does \`candidate_notes[${i}]\` contradict what a competent developer would assume by default?`,
    criteria:{true:'A developer would guess wrong without being told this.',false:'It matches the obvious assumption.'}},
  [`actionable_now${i}`]:{type:'noul',
    instructions:`Does \`candidate_notes[${i}]\` name something concrete enough to act on immediately -- a specific symbol, path, command or flag?`,
    criteria:{true:'Names a specific symbol, path, command or flag.',false:'Only general description.'}},
});

const qs={}; picked.forEach((n,i)=>Object.assign(qs,FACETS(i)));
const body={model:'jev-latest', state:{candidate_notes:picked.map((n,i)=>({index:i,...rec(n)}))}, questions:qs};
const t0=Date.now();
const res=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(body)});
const j=await res.json(); const ms=Date.now()-t0;
if(!j.answers){console.log('HTTP',res.status,JSON.stringify(j).slice(0,800));process.exit(1);}
console.log(`${ms}ms  ${j.usage.input_tokens} in-tok  ${picked.length} notes x 9 facets = ${picked.length*9} questions  $${((j.usage.input_tokens/1e9)*42).toFixed(6)}`);
console.log(`=> $${(((j.usage.input_tokens/1e9)*42)/picked.length).toFixed(7)} per note typed\n`);

const DIRECTION={open_the_code:'OPEN the code it points at',run_the_command:'RUN the command it names',
  check_change_against_it:'CHECK your change against it',avoid_the_action:'DO NOT do what it warns about',background_only:'context only'};
const typed=picked.map((n,i)=>{const g=k=>j.answers[`${k}${i}`];
  return {id:n.id,title:n.title,kind:n.kind,status:n.status||'fresh',
    trigger:g('trigger').choice,triggerConf:g('trigger').confidence,
    direction:g('direction').choice,directionConf:g('direction').confidence,
    enforced_by:g('enforced_by').choice, drift:g('drift_surface').choice,driftConf:g('drift_surface').confidence,
    blast:g('blast').score,volatility:g('volatility').score,
    machine:g('machine_specific').noul,contradicts:g('contradicts_default').noul,actionable:g('actionable_now').noul};});
writeFileSync('bench/jev-eval/typed-notes.json',JSON.stringify(typed,null,2));

for (const t of typed) {
  console.log(`[${t.kind}/${t.status}] ${t.title.slice(0,70)}`);
  console.log(`   trigger ${t.trigger}@${t.triggerConf.toFixed(2)}   direction ${t.direction}@${t.directionConf.toFixed(2)}`);
  console.log(`   enforced_by ${t.enforced_by}   drift_surface ${t.drift}@${t.driftConf.toFixed(2)}`);
  console.log(`   blast ${t.blast.toFixed(2)}  volatility ${t.volatility.toFixed(2)}  machine ${t.machine.toFixed(2)}  contradicts ${t.contradicts.toFixed(2)}  actionable ${t.actionable.toFixed(2)}`);
  console.log(`   -> agent direction: ${DIRECTION[t.direction]}\n`);
}
// what the facets imply for verification policy
console.log('VERIFICATION POLICY implied by drift_surface:');
const g={}; for(const t of typed) (g[t.drift] ||= []).push(t.title.slice(0,48));
for (const [k,v] of Object.entries(g)) console.log(`  ${k.padEnd(26)} n=${v.length}  check: ${
  {a_symbol_moving:'symbol hash only -> invalid if gone',a_number_changing:'extract the number, compare -> update if differs',
   a_path_changing:'path existence -> update if moved',an_external_tool_changing:'cannot verify from code; re-ask on a schedule',
   mechanism_removed:'mechanism presence -> invalid if absent',nothing_historical:'never verify'}[k]||'?'}`);

// v2: disjoint options, catch-alls demoted to their own Nouls, dead facets dropped.
// Also runs every Choice twice with reversed option order -- the jaggedness doc warns Jev leans to the first option.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
const SRC='/Users/yoavshmariahu/src/thinker', KEY=process.env.JEVKEY, byId=new Map();
for (const d of [`${SRC}/.thinker/notes`,`${SRC}/.thinker/local/notes`]) { if(!existsSync(d))continue;
  for (const f of readdirSync(d).filter(x=>x.endsWith('.json'))) { try{const n=JSON.parse(readFileSync(`${d}/${f}`,'utf8'));byId.set(n.id,n);}catch{} } }
const want=['hooks-mcp-run-the-archive-installed-app-thinker-app-which-ca','deploy-commands-git-push-origin-main-aws-s3-cp-cloudfront-in',
  'absolute-term-coverage-floor-for-note-retrieval-gating','note-store-mixes-shared-content-with-per-checkout-serving-st',
  'the-prompt-hooks-serve-no-stale-note','running-tests-requires-thinker-telemetry-off',
  'mandatory-worktree-isolation-for-agent-edits-and-benchmarks','auto-mode-does-not-bypass-production-deploy-self-modificatio'];
const picked=want.map(i=>byId.get(i)).filter(Boolean);
for (const n of [...byId.values()]) { if(picked.length>=12) break; if(!picked.includes(n)&&(n.body||'').length>120&&!n.archived) picked.push(n); }
const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,4),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,8).join(' ').slice(0,1000),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6)});

// --- disjoint by construction: each asks about a DIFFERENT dimension, no catch-all inside a Choice ---
const TRIGGER={locating_code:'They need to find where something is implemented or handled.',
  running_or_building:'They need to run, build, test or deploy something.',
  changing_safely:'They are about to change code and this constrains how.',
  reviewing_a_change:'They are checking a change someone already made.',
  wiring_or_installing:'They are installing or configuring the tool or an agent integration.',
  interpreting_output:'They are trying to understand output, a log, a metric or a report.'};
// "what is the FIRST physical act" -- mutually exclusive because only one can be first
const FIRST_ACT={read_a_file:'Their first act is to open a file and read it.',
  execute_a_command:'Their first act is to type a command into a shell.',
  edit_code:'Their first act is to change a line of code.',
  change_a_setting:'Their first act is to edit a configuration or settings file.',
  choose_a_different_approach:'Their first act is to abandon the approach they were about to take and pick another.'};
// drift surface WITHOUT the catch-all: forced to name the most specific checkable surface
const DRIFT={a_symbol_moving:'A named function, constant or class it depends on is renamed, moved or removed.',
  a_number_changing:'A threshold, default, limit or version number it states is changed.',
  a_path_changing:'A file or directory path it names is moved or renamed.',
  a_flag_or_env_var_changing:'A command-line flag or environment variable name it states is renamed or dropped.',
  an_external_tool_changing:'A tool or service outside this repository changes its behaviour.'};

const rev = o => Object.fromEntries(Object.entries(o).reverse());
function build(order){
  const qs={};
  picked.forEach((n,i)=>{
    qs[`trigger${i}`]={type:'choice',instructions:`Which kind of task should put \`candidate_notes[${i}]\` in front of a developer?`,criteria:order(TRIGGER)};
    qs[`first_act${i}`]={type:'choice',instructions:`A developer has just been handed \`candidate_notes[${i}]\` while working. What is the very FIRST physical act they take because of it?`,criteria:order(FIRST_ACT)};
    qs[`drift${i}`]={type:'choice',instructions:`Which ONE change to the codebase is the most likely way \`candidate_notes[${i}]\` becomes wrong? Name the most specific surface, not the broadest.`,criteria:order(DRIFT)};
    // catch-alls, demoted out of the Choices into their own yes/no
    qs[`inert${i}`]={type:'noul',instructions:`Is \`candidate_notes[${i}]\` purely background -- nothing a developer would do differently because of it?`,
      criteria:{true:'Changes no action; it is context only.',false:'Changes what the developer does.'}};
    qs[`whole_mechanism${i}`]={type:'noul',instructions:`Would \`candidate_notes[${i}]\` only become wrong if the entire mechanism it describes were deleted, rather than by any smaller change?`,
      criteria:{true:'Only wholesale removal could falsify it.',false:'A smaller, specific change could falsify it.'}};
    qs[`machine${i}`]={type:'noul',instructions:`Is \`candidate_notes[${i}]\` about the state of one particular machine or account rather than about the codebase?`,
      criteria:{true:'Describes one machine, one install, or one account.',false:'Describes the codebase or a tool\'s general behaviour.'}};
    qs[`blast${i}`]={type:'score',instructions:`If a developer ignored \`candidate_notes[${i}]\`, how bad would the consequence be?`,
      criteria:['No consequence; a slower route at worst.','Wasted time: they rediscover it or backtrack.',
        'A broken build, failed test or wrong output, caught before shipping.',
        'Damage reaching users, data or another person: a bad deploy, lost work, a silent wrong result.']};
  });
  return {model:'jev-latest', state:{candidate_notes:picked.map((n,i)=>({index:i,...rec(n)}))}, questions:qs};
}
async function go(order){const t0=Date.now();
  const res=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(build(order))});
  return {ms:Date.now()-t0,j:await res.json(),status:res.status};}

const fwd=await go(o=>o), bwd=await go(rev);
if(!fwd.j.answers){console.log('HTTP',fwd.status,JSON.stringify(fwd.j).slice(0,600));process.exit(1);}
const tok=fwd.j.usage.input_tokens+bwd.j.usage.input_tokens;
console.log(`forward ${fwd.ms}ms  reversed ${bwd.ms}ms  ${picked.length*7} questions each  ${tok} tok  $${((tok/1e9)*42).toFixed(6)}\n`);

const ACT={read_a_file:'OPEN the file',execute_a_command:'RUN the command',edit_code:'EDIT the code',
  change_a_setting:'CHANGE the setting',choose_a_different_approach:'PICK A DIFFERENT APPROACH'};
const rows=picked.map((n,i)=>{const F=k=>fwd.j.answers[`${k}${i}`], B=k=>bwd.j.answers[`${k}${i}`];
  return {title:n.title,kind:n.kind,
    trigger:F('trigger').choice,tc:F('trigger').confidence,triggerR:B('trigger').choice,
    act:F('first_act').choice,ac:F('first_act').confidence,actR:B('first_act').choice,
    drift:F('drift').choice,dc:F('drift').confidence,driftR:B('drift').choice,
    inert:F('inert').noul, whole:F('whole_mechanism').noul, machine:F('machine').noul, blast:F('blast').score};});
writeFileSync('exp/typed-notes-v2.json',JSON.stringify(rows,null,2));

console.log('note                                     trigger            act              drift                 inert whole mach blast');
for(const r of rows) console.log(
  `${r.title.slice(0,40).padEnd(40)} ${r.trigger.slice(0,18).padEnd(18)} ${r.act.slice(0,16).padEnd(16)} ${r.drift.slice(0,21).padEnd(21)} ${r.inert.toFixed(2)}  ${r.whole.toFixed(2)}  ${r.machine.toFixed(2)} ${r.blast.toFixed(2)}`);

console.log('\nORDER STABILITY (same answer with options reversed -- jaggedness #8):');
for(const f of ['trigger','act','drift']){
  const agree=rows.filter(r=>r[f]===r[f+'R']).length;
  console.log(`  ${f.padEnd(8)} ${agree}/${rows.length} stable` + (agree<rows.length ? `   flipped: ${rows.filter(r=>r[f]!==r[f+'R']).map(r=>`${r[f]}->${r[f+'R']}`).join(', ')}` : ''));
}
console.log('\nDISCRIMINATION (a facet is useless if every note gets the same value):');
for(const [f,get] of [['trigger',r=>r.trigger],['act',r=>r.act],['drift',r=>r.drift]]){
  const c={}; rows.forEach(r=>c[get(r)]=(c[get(r)]||0)+1);
  const top=Math.max(...Object.values(c));
  console.log(`  ${f.padEnd(8)} ${Object.keys(c).length} distinct values, largest bucket ${top}/${rows.length}  ${JSON.stringify(c)}`);
}
for(const f of ['inert','whole','machine','blast']){
  const v=rows.map(r=>r[f]); const mn=Math.min(...v), mx=Math.max(...v);
  console.log(`  ${f.padEnd(8)} range ${mn.toFixed(2)} - ${mx.toFixed(2)}  spread ${(mx-mn).toFixed(2)}${(mx-mn)<0.25?'   <-- DEAD FACET':''}`);
}
console.log('\nAGENT DIRECTIONS the facets produce:');
for(const r of rows) console.log(`  ${r.inert>0.5?'(context only)'.padEnd(32):(ACT[r.act]+' first').padEnd(32)} ${r.title.slice(0,52)}`);

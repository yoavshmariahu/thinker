import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createClients} from './clients.mjs';
import {route, stopReason} from './policy.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f)));
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const protocol = read('protocol.json'), questions = read('questions.json'), pins = read('inputs.sha256.json');
const mode = process.argv[2];
if (!['open-loop','closed-loop'].includes(mode)) throw Error('Specify open-loop or closed-loop');
if (process.env.THINKER_TEST !== '1' || process.env.THINKER_TELEMETRY !== 'off' || process.env.THINKER_PILOT_LIVE !== '1') throw Error('Explicit test-mode live opt-in required');
process.env.THINKER_LOG = 'off'; process.env.THINKER_NO_LEARN = '1';
const hashes = Object.fromEntries(['run.mjs','clients.mjs','policy.mjs','questions.json','protocol.json'].map(f => [f,hash(fs.readFileSync(path.join(dir,f)))]));
const out = path.join(dir,'results',mode); fs.mkdirSync(out,{recursive:true});
const begun = Date.now();
const ensureBudget = () => {if (Date.now()-begun > protocol.closedLoop.maxModeSeconds*1000) throw Error('Global wall budget exhausted');};
const {judge, execute} = createClients({dir,protocol,questions,ensureBudget});
const items = Object.fromEntries(protocol.cases.map(id => {
  const raw = fs.readFileSync(path.join(dir,'scenarios',id+'.json'));
  if (hash(raw) !== pins[id+'.json']) throw Error('Scenario hash mismatch');
  return [id,JSON.parse(raw)];
}));

if (mode === 'open-loop') {
  for (const id of protocol.cases) {
    const file = path.join(out,id);
    if (fs.existsSync(file+'.json')) throw Error('Refusing to overwrite open-loop result');
    const r = await judge(items[id].state,file+'.judge');
    const decisions = Object.fromEntries(protocol.closedLoop.policies.map(policy => [policy,route(r.response.answers,items[id].state,policy)]));
    save(file+'.json',{id,hashes,stateHash:hash(items[id].state),...r,decisions});
    console.log(JSON.stringify({id,mode,answers:r.response.answers,decisions}));
  }
} else {
  for (let rep=0;rep<protocol.closedLoop.repetitions;rep++) for (const [i,id] of protocol.cases.entries()) {
    const order = (rep+i)%2 ? ['v3','v2'] : ['v2','v3'];
    for (const policy of order) {
      const prefix=path.join(out,`${id}.${policy}.rep${rep}`);
      if (fs.existsSync(prefix+'.json')) {
        const previous=JSON.parse(fs.readFileSync(prefix+'.json'));
        if (!previous.valid || JSON.stringify(previous.hashes)!==JSON.stringify(hashes) || previous.stateHash!==hash(items[id].state)) throw Error('Existing invalid/mismatched arm requires explicit investigation');
        console.log(JSON.stringify({id,policy,rep,resumedValidCheckpoint:true}));continue;
      }
      let state=structuredClone(items[id].state), valid=true, outcome='incomplete', unresolved=[];
      const trace=[], seen=new Set(), start=Date.now();
      try {
        while(true) {
          ensureBudget();
          const j=await judge(state,prefix+`.judge-${state.roundsUsed}`);
          const decision=route(j.response.answers,state,policy);unresolved=decision.unresolved;
          trace.push({type:'judgment',decision,elapsedMs:j.elapsedMs,response:j.response});
          const signature=hash({action:decision.action,findings:state.findings,source:state.source});
          const stop=stopReason(decision,state.roundsUsed,signature,seen);
          if(stop){outcome=stop;break;}
          seen.add(signature);
          const r=await execute(decision.action,state,items[id].additionalSource,prefix+`.executor-${state.roundsUsed}`);
          trace.push({type:'execution',action:decision.action,...r});
          if(decision.action==='inspect_callers') state.source={...state.source,additionalCallerContext:items[id].additionalSource};
          state={...state,findings:r.result.findings,coverage:r.result.coverage,limitations:r.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action:decision.action,contribution:r.result.contribution}]};
        }
      } catch(error) {valid=false;outcome='invalid';trace.push({type:'error',error:String(error.message).slice(0,700)});}
      // Both arms retain raw concerns for audit; only v3 uses them as stopping constraints.
      const row={id,rep,policy,order,valid,outcome,unresolved,hashes,stateHash:hash(items[id].state),elapsedMs:Date.now()-start,trace,finalState:state};
      save(prefix+'.json',row);
      console.log(JSON.stringify({id,rep,policy,valid,outcome,unresolved,actions:trace.filter(t=>t.type==='execution').map(t=>t.action),elapsedMs:row.elapsedMs}));
      if(!valid) throw Error('Stopped after invalid arm; evidence retained');
    }
  }
}

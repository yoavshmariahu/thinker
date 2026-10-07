import fs from 'node:fs';
import {jevEvaluate,jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('test mode');
const label=process.argv[2], rows=fs.readFileSync('research/pr-mining-fix/raw/pilot2-opus/transport.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(r=>r.request.state.claims);
const output=`research/pr-mining-fix/raw/${label}.jsonl`;
const cases=rows.map((r,i)=>({id:i,state:r.request.state}));
const last=rows.at(-2).request.state;
for(const claim of ['StreamMixer closes output before stderr and stdout.','StreamMixer is thread-safe in every Python implementation.','The change fixes all races in Click, including issue #824.'])cases.push({id:'negative',state:{...last,claims:[claim]}});
for(const item of cases){const questions=Object.fromEntries(item.state.claims.flatMap((c,i)=>[[`s${i}`,{type:'noul',instructions:`Does \`evidence\` support \`claims[${i}]\`?`,criteria:{true:'The source demonstrates the claim, including the stated order and conditions.',false:'The claim is unsupported or contradicts the source.'}}],[`x${i}`,{type:'noul',instructions:`Does \`claims[${i}]\` contradict \`evidence\`?`,criteria:{true:'A fact, condition, value or operation order differs from what the source shows.',false:'No conflict demonstrated. Missing evidence alone is not a conflict.'}}]]));
 const request={state:item.state,questions};let response;
 try{response=await jevEvaluate(item.state,questions,{key:jevKey(),model:'jev-1.13.0',timeoutMs:15000,fetchImpl:async(url,o)=>{if(url!==JEV_ENDPOINT)throw Error('endpoint');return fetch(url,o)}})}catch(e){response={error:e.message}}
 fs.appendFileSync(output,JSON.stringify({id:item.id,request,response})+'\n');console.log(item.id, item.state.claims.map((_,i)=>[response.answers?.[`s${i}`]?.noul,response.answers?.[`x${i}`]?.noul]));
}

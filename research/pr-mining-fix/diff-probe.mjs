import fs from 'node:fs';
import {jevEvaluate,jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('test mode');
function normalize(text){return text.split(/(?=^diff --git )/m).map(part=>{if(!part.startsWith('diff --git '))return part;const [header,...hunks]=part.split(/(?=^@@ )/m);return header+hunks.map(h=>{const [label,...lines]=h.trimEnd().split('\n');return label+'\nBEFORE THIS CHANGE:\n'+lines.filter(l=>!l.startsWith('+')&&!l.startsWith('\\')).map(l=>l.slice(1)).join('\n')+'\nAFTER THIS CHANGE:\n'+lines.filter(l=>!l.startsWith('-')&&!l.startsWith('\\')).map(l=>l.slice(1)).join('\n')+'\n';}).join('\n')}).join('\n')}
const rows=fs.readFileSync('research/pr-mining-fix/raw/pilot2-opus/transport.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(r=>r.request.state.claims);
const cases=rows.map((r,i)=>({id:i,request:r.request}));
for(const claim of ['StreamMixer closes output before stderr and stdout.','StreamMixer is thread-safe in every Python implementation.','The change fixes all races in Click, including issue #824.'])cases.push({id:'negative',request:{state:{...rows.at(-2).request.state,claims:[claim]},questions:{c0:rows.at(-2).request.questions.c0}}});
for(const item of cases){const request={state:{...item.request.state,evidence:normalize(item.request.state.evidence)},questions:item.request.questions};let response;
try{response=await jevEvaluate(request.state,request.questions,{key:jevKey(),model:'jev-1.13.0',timeoutMs:15000,fetchImpl:async(url,o)=>{if(url!==JEV_ENDPOINT)throw Error('endpoint');return fetch(url,o)}})}catch(e){response={error:e.message}}
fs.appendFileSync('research/pr-mining-fix/raw/diff-probe.jsonl',JSON.stringify({id:item.id,request,response})+'\n');console.log(item.id,request.state.claims.map((_,i)=>response.answers?.[`c${i}`]?.probabilities));}

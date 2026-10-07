import fs from 'node:fs';import{jevEvaluate,jevKey,JEV_ENDPOINT}from'../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('test mode');
const cases=[
 {grounded_body:'StreamMixer.__del__ closes stderr, then stdout, then output.',title:'StreamMixer cleanup',applies:'StreamMixer finalization'},
 {grounded_body:'StreamMixer.__del__ closes stderr, then stdout, then output.',title:'StreamMixer closes output first',applies:'All Python streams'},
 {grounded_body:'Editor.edit_files calls Popen with an argv list and does not pass shell=True.',title:'Editor invocation',applies:'Editor.edit_files'},
 {grounded_body:'Editor.edit_files calls Popen with an argv list and does not pass shell=True.',title:'Editor invocation uses shell=True',applies:'Every subprocess in Python'},
];
for(const state of cases){const questions={title:{type:'noul',instructions:'Does `title` misrepresent `grounded_body`?',criteria:{true:'An unrelated topic, unsupported assertion, or changed meaning.',false:'A topic label or summary consistent with the body.'}},applies:{type:'noul',instructions:'Does `applies` extend beyond the scope of `grounded_body`?',criteria:{true:'Extends the rule to other conditions, code or tasks.',false:'Names the same or narrower conditions, code or task.'}}};const response=await jevEvaluate(state,questions,{key:jevKey(),model:'jev-1.13.0',timeoutMs:15000,fetchImpl:async(url,o)=>{if(url!==JEV_ENDPOINT)throw Error('endpoint');return fetch(url,o)}});fs.appendFileSync('research/pr-mining-fix/raw/metadata-risk-probe.jsonl',JSON.stringify({state,questions,response})+'\n');console.log(state,response.answers)}

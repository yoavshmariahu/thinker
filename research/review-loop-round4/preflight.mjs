import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {hash,preflight} from '../review-loop-round3/clients.mjs';import {questionsFor} from '../review-loop-round3/questions.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
const protocol=read('protocol.json');preflight(protocol);
for(const[f,h]of Object.entries(read('inputs.sha256.json')))assert.equal(hash(fs.readFileSync(path.join(dir,f))),h);
for(const id of protocol.cases){const state=read('tasks/'+id+'.json');for(const f of Object.keys(state.source))assert.ok(!path.isAbsolute(f)&&!f.split('/').includes('..'));const request={model:protocol.models.routing,state,questions:questionsFor(state)};const bytes=Buffer.byteLength(JSON.stringify(request));assert.ok(bytes+40000<150000,'Reserve for report/questions');console.log(JSON.stringify({id,initialRequestBytes:bytes,reservedBytes:40000,ceiling:150000}));}
for(const id of protocol.controls.cases){const c=read('controls/'+id+'.json');assert.ok(c.steps.length<=protocol.execution.maxExecutorCalls);for(const f of [...Object.keys(c.state.source),...Object.keys(c.extraFiles||{}),...c.steps.flatMap(s=>Object.keys(s.addSource||{}))])assert.ok(!path.isAbsolute(f)&&!f.split('/').includes('..'));}
console.log('Pinned inputs, source paths, CLI and direct-key availability checked. Provider validates actual token limits.');

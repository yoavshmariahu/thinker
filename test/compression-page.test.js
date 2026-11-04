import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
test('Compression switches models, cost assumptions, judge evidence, and full session views', async () => {
const nodes = new Map();
class Element {
 constructor(key) { this.key=key; this.hidden=key==='#view-session'; this.innerHTML=''; this.textContent=''; this.style={}; this.dataset={}; this.listeners={}; this.clientWidth=900; this.offsetWidth=260; this.classList={toggle(){},contains(){return false}}; }
 addEventListener(name,cb){this.listeners[name]=cb;}
 querySelector(s){return node(this.key+' '+s);}
 querySelectorAll(){return [];}
 getBoundingClientRect(){return {width:900,left:0};}
 setAttribute(k,v){this[k]=v;}
 focus(){}
}
const node=k=>{if(!nodes.has(k))nodes.set(k,new Element(k));return nodes.get(k);};
const tabs=['metrics','session'].map(v=>{const e=new Element(v);e.dataset.view=v;return e;});
const ttls=['1h','5m'].map(v=>{const e=new Element(v);e.dataset.v=v;return e;});
const document={querySelector:node,querySelectorAll:s=>s==='.tabs button'?tabs:s==='#ttl button'?ttls:[],body:node('body'),addEventListener(){}};
const context=vm.createContext({document,window:{addEventListener(){}},location:{pathname:'/compression.html',search:'',hash:''},history:{replaceState(){}},URLSearchParams,fetch:async f=>({ok:true,json:async()=>JSON.parse(fs.readFileSync('site/'+f))}),console});
const html=fs.readFileSync('site/compression.html','utf8');
for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))vm.runInContext(match[1],context);
const click=async (selector,target)=>{node(selector).listeners.click({target:{closest:()=>target}});await new Promise(r=>setTimeout(r,10));};
assert.match(node('#session-label').innerHTML,/Click/);
assert.match(node('#sessions').innerHTML,/saved/);
assert.doesNotMatch(node('#sessions').innerHTML,/pair \d/);
assert.match(node('#c1').innerHTML,/<svg/);
node('#pos').listeners.input({target:{value:'10'}});
assert.match(node('#pos-lbl').textContent,/call 10/);
await click('#ttl',ttls[1]);
assert.match(node('#tiles').innerHTML,/five-minute/);
await click('#sessions',{dataset:{run:'django-astra'}});
assert.match(node('#session-label').innerHTML,/Django/);
assert.match(node('#tiles').innerHTML,/10.2–22.5/);
assert.match(node('#judge-evidence').innerHTML,/Success criteria/);
assert.doesNotMatch(node('#tiles').innerHTML,/NaN|undefined/);
assert.match(node('#ttl-label').textContent,/Cost assumption/);
assert.doesNotMatch(node('#sessions').innerHTML,/mitmproxy/);
await click('#ttl',ttls[0]);
assert.match(node('#tiles').innerHTML,/11.57/);
assert.match(node('#c2').innerHTML,/svg/);
node('#c1').place(48,true);
assert.ok(!node('#c1 .tip').innerHTML.includes('NaN'));
assert.match(node('#c1 .tip').innerHTML,/not recorded/);
await click('.tabs',tabs[1]);
assert.match(node('#timeline').innerHTML,/Turn 14/);
assert.ok(!node('#timeline').innerHTML.includes('NaN'), 'no unrecorded fields rendered as numbers');
assert.match(node('#sess-note').textContent,/API usage/);
await click('#sessions',{dataset:{run:'click-1'}});
assert.match(node('#timeline').innerHTML,/Turn 16/);
assert.doesNotMatch(node('#timeline').innerHTML,/Turn 24|NaN/);
await click('.tabs',tabs[0]);
assert.equal(node('#view-metrics').hidden,false);
});

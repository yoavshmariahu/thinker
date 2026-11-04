import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
test('Compression switches models, cost assumptions, judge evidence, and full session views', async () => {
const nodes = new Map();
class Element {
 constructor(key) { this.key=key; this.hidden=key==='#view-session'||key==='#pricing-explainer'; this.innerHTML=''; this.textContent=''; this.style={}; this.dataset={}; this.listeners={}; this.clientWidth=900; this.offsetWidth=260; this.classList={toggle(){},contains(){return false}}; }
 addEventListener(name,cb){this.listeners[name]=cb;}
 querySelector(s){return node(this.key+' '+s);}
 querySelectorAll(){return [];}
 getBoundingClientRect(){return {width:900,left:0};}
 setAttribute(k,v){this[k]=v;}
 focus(){this.focused=true;}
 contains(other){return other===this;}
}
const node=k=>{if(!nodes.has(k))nodes.set(k,new Element(k));return nodes.get(k);};
const tabs=['metrics','session'].map(v=>{const e=new Element(v);e.dataset.view=v;return e;});
const ttls=['1h','5m'].map(v=>{const e=new Element(v);e.dataset.v=v;return e;});
const documentListeners={};
const document={querySelector:node,querySelectorAll:s=>s==='.tabs button'?tabs:s==='#ttl button'?ttls:[],body:node('body'),addEventListener(k,fn){(documentListeners[k] ||= []).push(fn);}};
const context=vm.createContext({document,window:{addEventListener(){}},location:{pathname:'/compression.html',search:'',hash:''},history:{replaceState(){}},URLSearchParams,setTimeout,clearTimeout,fetch:async f=>({ok:true,json:async()=>JSON.parse(fs.readFileSync('site/'+f))}),console});
const html=fs.readFileSync('site/compression.html','utf8');
for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))vm.runInContext(match[1],context);
const click=async (selector,target)=>{node(selector).listeners.click({target:{closest:()=>target}});await new Promise(r=>setTimeout(r,10));};
assert.match(node('#session-label').innerHTML,/Click/);
assert.equal(node('#ttl-label').textContent,'Claude pricing');
assert.match(node('#pricing-explainer').innerHTML,/Anthropic/);
assert.match(node('#pricing-explainer').innerHTML,/1-hour cache/);
assert.equal(node('#pricing-explainer').hidden,true);
node('#pricing-help-wrap').listeners.mouseenter();
assert.equal(node('#pricing-explainer').hidden,false);
node('#pricing-help-wrap').listeners.mouseleave();
await new Promise(r=>setTimeout(r,170));
assert.equal(node('#pricing-explainer').hidden,true);
node('#pricing-help-wrap').listeners.focusin();
assert.equal(node('#pricing-explainer').hidden,false);
documentListeners.keydown.forEach(fn=>fn({key:'Escape'}));
assert.equal(node('#pricing-explainer').hidden,true);
node('#pricing-help-wrap').listeners.focusout({relatedTarget:null});
node('#pricing-help').listeners.click();
assert.equal(node('#pricing-explainer').hidden,false);
assert.equal(node('#pricing-help')['aria-expanded'],'true');
documentListeners.click.forEach(fn=>fn({target:{closest:()=>null}}));
assert.equal(node('#pricing-explainer').hidden,true);

assert.match(node('#sessions').innerHTML,/saved/);
assert.doesNotMatch(node('#sessions').innerHTML,/pair \d/);
assert.match(node('#c1').innerHTML,/<svg/);
node('#pos').listeners.input({target:{value:'10'}});
assert.match(node('#pos-lbl').textContent,/call 10/);
await click('#ttl',ttls[1]);
assert.match(node('#tiles').innerHTML,/five-minute/);
await click('#sessions',{dataset:{run:'django-astra'}});
assert.match(node('#session-label').innerHTML,/Django/);
assert.match(node('#tiles').innerHTML,/10.2%/);
assert.match(node('#tiles').innerHTML,/<span>10.2% saved<\/span>/);
assert.match(node('#session-label').innerHTML,/10.2% saved/);
assert.doesNotMatch(node('#session-label').innerHTML,/At least/);
assert.doesNotMatch(node('#tiles').innerHTML,/At least|Session cost/);
assert.match(node('#tiles').innerHTML,/<div class="k">Cache writes<\/div><div class="v">Not recorded<\/div>/);
assert.equal([...node('#tiles').innerHTML.matchAll(/<div class="k">[^<]*cost[^<]*<\/div>/gi)].length,1,'only one topline cost card');
assert.match(node('#stats').innerHTML,/11.09/);
assert.match(node('#stats').innerHTML,/8.96/);
const beforeCostChart=node('#c2').innerHTML;
const savingsCard=node('#tiles').innerHTML.split('<div class="tile cache-writes">')[0];
for (const sub of node('#tiles').innerHTML.matchAll(/<div class="sub">([^<]+)<\/div>/g)) assert.ok(sub[1].length <= 32, 'topline subtext stays brief');
assert.match(node('#caveats').innerHTML,/Historical per-request cutting policy/);
assert.match(node('#judge-evidence').innerHTML,/Success criteria/);
assert.doesNotMatch(node('#tiles').innerHTML,/NaN|undefined/);
assert.equal(node('#ttl-label').textContent,'OpenAI pricing');
assert.match(node('#pricing-explainer').innerHTML,/OpenAI · Astra/);
assert.match(node('#pricing-explainer').innerHTML,/conservative 10.2%/);
assert.equal(node('#ttl [data-v="1h"]').textContent,'With cache writes');
assert.equal(node('#ttl [data-v="5m"]').textContent,'Input only');

assert.doesNotMatch(node('#sessions').innerHTML,/mitmproxy/);
await click('#ttl',ttls[0]);
assert.match(node('#stats').innerHTML,/11.57/);
assert.match(node('#stats').innerHTML,/9.96/);
assert.notEqual(node('#c2').innerHTML,beforeCostChart);
assert.equal(node('#tiles').innerHTML.split('<div class="tile cache-writes">')[0],savingsCard,'pricing changes costs but keeps the conservative saving');
assert.match(node('#c2').innerHTML,/svg/);
node('#c1').place(48,true);
assert.ok(!node('#c1 .tip').innerHTML.includes('NaN'));
assert.match(node('#c1 .tip').innerHTML,/not recorded/);
let prevented=false;
node('.tabs').listeners.keydown({key:'ArrowRight',target:{closest:()=>tabs[0]},preventDefault(){prevented=true;}});
await new Promise(r=>setTimeout(r,10));
assert.equal(prevented,true);assert.equal(tabs[1].focused,true);assert.equal(tabs[1].tabindex,'0');
assert.equal(tabs[0].tabindex,'-1');

assert.match(node('#timeline').innerHTML,/Turn 14/);
assert.ok(!node('#timeline').innerHTML.includes('NaN'), 'no unrecorded fields rendered as numbers');
assert.match(node('#sess-note').textContent,/API usage/);
await click('#sessions',{dataset:{run:'click-1'}});
assert.match(node('#timeline').innerHTML,/Turn 16/);
assert.doesNotMatch(node('#timeline').innerHTML,/Turn 24|NaN/);
await click('.tabs',tabs[0]);
assert.equal(node('#view-metrics').hidden,false);
});

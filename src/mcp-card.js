// Optional MCP Apps presentation. The text response remains usable in hosts without UI.
import { cacheHitSavings, formatTokens } from './usage.js';

export const CACHE_CARD_URI = 'ui://thinker/cache-hit-v1.html';
export const cacheCardMeta = {
  ui: { resourceUri: CACHE_CARD_URI },
  'openai/outputTemplate': CACHE_CARD_URI,
  'openai/ui': { preferredModelDisplayMode: 'inline' },
};

export function withCacheCard(result, repo, notes) {
  const unique = [...new Map(notes.map(n => [n.id, n])).values()];
  if (!unique.length) return result;
  const { calls, tokens } = cacheHitSavings(repo, unique);
  return { ...result, structuredContent: {
    thinkerCacheHit: {
      notes: unique.map(n => ({ id: n.id, title: n.title })),
      files: calls,
      codeTokens: tokens,
      codeTokensLabel: tokens ? `~${formatTokens(tokens)} tokens of code` : '',
    },
  } };
}

export function registerCacheCard(server) {
  server.registerResource('thinker-cache-hit', CACHE_CARD_URI, {
    mimeType: 'text/html;profile=mcp-app',
    description: 'Thinker cache-hit indicator',
  }, async () => ({ contents: [{
    uri: CACHE_CARD_URI, mimeType: 'text/html;profile=mcp-app', text: CACHE_CARD_HTML,
    _meta: { ui: { prefersBorder: true }, 'openai/widgetDescription': 'Thinker notes retrieved and the estimated size of their code dependencies.' },
  }] }));
}

export const CACHE_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;font-size:13px}
body{margin:0;padding:12px 16px;color:var(--color-text-primary,CanvasText);background:var(--color-background-primary,Canvas)}
header{display:flex;align-items:center;gap:8px;font-weight:600}.dot{width:8px;height:8px;border-radius:50%;background:#30a46c}
p{margin:6px 0 0;color:var(--color-text-secondary,GrayText)}
details{margin-top:8px}summary{cursor:pointer}ul{padding-left:20px;margin-bottom:0}li{margin:4px 0}
[hidden]{display:none}
</style></head><body><main id="card" hidden>
<header><span class="dot" aria-hidden="true"></span>Thinker · Cache hit</header>
<p id="counts"></p><details><summary>Cached notes</summary><ul id="notes"></ul>
<p>Code size is an estimate of the files these notes point to, not measured tokens saved.</p></details>
</main><script>
const card=document.getElementById('card');
function render(output){
 const hit=output?.thinkerCacheHit;if(!hit?.notes?.length)return;
 document.getElementById('counts').textContent=[hit.notes.length+' '+(hit.notes.length===1?'note':'notes'),hit.files?hit.files+' '+(hit.files===1?'file':'files'):'',hit.codeTokensLabel].filter(Boolean).join(' · ');
 const list=document.getElementById('notes');list.replaceChildren();
 for(const note of hit.notes){const li=document.createElement('li');li.textContent=note.title||note.id;list.append(li);}
 card.hidden=false;resize();
}
function send(message){window.parent.postMessage({jsonrpc:'2.0',...message},'*');}
function resize(){send({method:'ui/notifications/size-changed',params:{height:document.documentElement.scrollHeight}});}
window.addEventListener('message',event=>{
 if(event.source!==window.parent)return;
 const m=event.data;
 if(m?.id==='thinker-init'&&m.result){send({method:'ui/notifications/initialized',params:{}});}
 if(m?.method==='ui/notifications/tool-result')render(m.params?.structuredContent);
});
window.addEventListener('openai:set_globals',event=>render(event.detail?.globals?.toolOutput));
render(window.openai?.toolOutput);
new ResizeObserver(resize).observe(document.body);
send({id:'thinker-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'Thinker cache hit',version:'1.0.0'},appCapabilities:{}}});
</script></body></html>`;

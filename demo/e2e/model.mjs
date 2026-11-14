// A loopback Messages API, so a real agent loop runs in the container with no credentials.
//
// What is real here and what is not, said plainly, because a demo that blurs this is worth nothing:
//
//   real  the agent. OpenCode runs, calls its own read tool, grows its own context, and ends its own
//         session. thinker's proxy sits in front of this server, so the cut it makes is made on the
//         real request body -- and this server records the size of every body it receives, which is
//         how the e2e shows the context drop rather than asserting it.
//   real  the usage. `input_tokens` is measured from the body that arrived (chars / 4.3, the rate
//         `prices.js` uses for a result), not a number chosen to make a headline. The dollars the
//         dashboard then shows are thinker's own pricing of that usage, through its one door.
//   not   the model's judgement. The turns are scripted: read each of the repository's big files in
//         turn, then answer. No model is asked anything, so nothing here is a claim about an agent's
//         quality -- only about the plumbing between an agent, thinker, and the fleet's sink.
//
// Usage: node model.mjs --port 4010 --files src/mod_a.py,src/mod_b.py,...
import http from 'node:http';
import fs from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const PORT = Number(arg('port', 4010));
const FILES = String(arg('files', '')).split(',').filter(Boolean);
const MODEL = arg('model', 'claude-sonnet-5-5');
const CHARS_PER_TOKEN = 4.3;

// one line per request, so the run has a record of what the proxy handed upstream
const seen = [];
const tokensOf = body => Math.round(JSON.stringify(body).length / CHARS_PER_TOKEN);

// Which file to ask for next, and when to stop and answer instead.
//
// A few files a turn, not all of them at once, because the cut only moves at a turn boundary: the newest
// turn is kept whole whatever its size (`proxy.js:walkResults`), so a session of one prompt and forty tool
// calls has nothing the cut may touch, however big it grows. That is thinker's policy and not a quirk of
// this fixture -- the fixture's job is to produce the shape a conversation actually has, several prompts
// with work between them, which is where the cut lives.
const PER_TURN = Number(arg('per-turn', 5));
function nextFile(body) {
  const msgs = body.messages || [];
  // What has been read is counted from the agent's own tool calls, never from the results. thinker's cut
  // replaces a finished result with a placeholder and leaves tool_use inputs exactly as the agent wrote
  // them (`proxy.js:applyCut`), so a fixture that reads its progress out of the results loses track of it
  // the moment the cut does its job -- and then asks for the same file again. That is what happened on the
  // first conversational run here: 70 calls, 838k tokens of context, and OpenCode's own compaction failing,
  // all from counting the wrong half of the conversation.
  const asked = new Set();
  for (const m of msgs) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'tool_use') { const p = c.input?.path || c.input?.filePath; if (p) asked.add(String(p)); }
  }
  // a turn is a message of the person's own: a user message carrying text rather than a tool result
  const turns = msgs.filter(m => m.role === 'user' && (typeof m.content === 'string'
    || (Array.isArray(m.content) && m.content.some(c => c?.type === 'text')))).length;
  const left = FILES.filter(f => !asked.has(f));
  return asked.size < Math.min(FILES.length, Math.max(1, turns) * PER_TURN) ? (left[0] || null) : null;
}
const readTool = body => (body.tools || []).find(t => /^read$/i.test(t.name)) || (body.tools || []).find(t => /read/i.test(t.name));

const server = http.createServer((req, res) => {
  let text = '';
  req.on('data', c => (text += c));
  req.on('end', () => {
    try {
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":100}'); }
      // Both doors, on purpose. thinker's own wiring writes the proxy's bare origin as OpenCode's
      // `baseURL`, and the proxy only cuts `POST /v1/messages` -- so whether a request arrives at
      // `/v1/messages` or at `/messages` is the thing this run is asking about, not a detail to paper
      // over. Every path is answered and every path is recorded.
      if (!/\/(v1\/)?messages$/.test(req.url.split('?')[0])) { res.writeHead(404); return res.end('{}'); }
      const body = JSON.parse(text);
      const input = tokensOf(body);
      const want = nextFile(body), tool = readTool(body);
      // the biggest body of the run, kept whole: what the cut had to work with, in the shape it arrived
      try { if (process.env.MODEL_BODY_FILE && input > Number(process.env.MODEL_BODY_MAX || 0)) { fs.writeFileSync(process.env.MODEL_BODY_FILE, JSON.stringify(body)); process.env.MODEL_BODY_MAX = String(input); } } catch {}
      // A cut shows up here as a body that got smaller while the conversation got longer, and as the
      // placeholder thinker leaves behind in a cleared result.
      const cleared = (JSON.stringify(body.messages || []).match(/tool result removed by thinker/g) || []).length;
      // Once, on the first call: what the agent identifies itself with. The proxy attributes a request to a
      // session by `x-claude-code-session-id` and by nothing else, so whether any other client sends
      // anything it could key on is a question with an answer, not a guess.
      if (!seen.length) console.log('[model] first call headers: ' + Object.keys(req.headers).sort().join(' ')
        + ' | ' + Object.entries(req.headers).filter(([k]) => /session/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' '));
      seen.push({ at: new Date().toISOString(), path: req.url, input, messages: (body.messages || []).length, cleared, asked: want || 'answer' });
      console.log(`[model] call ${seen.length} ${req.url}: ${input} tokens in, ${(body.messages || []).length} messages, ${cleared} cleared -> ${want ? `read ${want}` : 'answer'}`);

      const content = want && tool
        ? [{ type: 'tool_use', id: `toolu_e2e_${seen.length}`, name: tool.name, input: { path: want, filePath: want } }]
        : [{ type: 'text', text: `Read ${FILES.length} modules. They are a worker pool, a retry ladder and a settings loader; nothing in them needs changing.` }];
      const output = Math.round(JSON.stringify(content).length / CHARS_PER_TOKEN);
      const usage = { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const message = { id: `msg_e2e_${seen.length}`, type: 'message', role: 'assistant', model: body.model || MODEL, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage };

      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message)); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
      const c = content[0];
      emit({ type: 'content_block_start', index: 0, content_block: c.type === 'tool_use' ? { ...c, input: {} } : { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: c.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } : { type: 'text_delta', text: c.text } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: output } });
      emit({ type: 'message_stop' });
      res.end();
    } catch (e) {
      console.error('[model] bad request:', e.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
    }
  });
});

// The run reads this to show what the proxy did to the context it forwarded.
// The run reads this file to show what the proxy handed upstream, call by call.
const CALLS = process.env.MODEL_CALLS_FILE || '/tmp/model-calls.json';
const dump = () => { try { fs.writeFileSync(CALLS, JSON.stringify(seen, null, 1)); } catch {} };
setInterval(dump, 1000).unref?.();
process.on('SIGTERM', () => { dump(); process.exit(0); });
server.listen(PORT, '127.0.0.1', () => console.log(`[model] loopback Messages API on http://127.0.0.1:${PORT}, ${FILES.length} files to hand out`));

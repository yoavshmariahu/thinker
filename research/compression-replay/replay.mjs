// Replay real Claude Code sessions through thinker's own compressor (diet.js of the build under
// test) and report where output tokens actually sit, what moderate and high take out today, and what
// is left untouched, bucketed so the biggest unexploited categories are visible.
//
// Cost model: an output sits in the context from the call that produced it until the next compaction,
// so it is re-read by every model call after it. Weighted tokens = tokens x re-reads, which is what a
// saving is actually worth. Tokens are chars/4 (the report's own estimate; Anthropic's calibration
// factor of 1.44 is NOT applied, so these are conservative).
import fs from 'fs';
import path from 'path';

const SRC = process.env.DIET_SRC || '/Users/yoavshmariahu/src/thinker-under-test/src';
const { DIET, DIET_LEVELS, trimFile, groupSearch, capOutput, promptTerms, searchTerms } = await import(`${SRC}/diet.js`);
let classifyTestCommand = null;
try { ({ classifyTestCommand } = await import(`${SRC}/testing.js`)); } catch {}
const isTestCmd = c => (classifyTestCommand ? !!classifyTestCommand(c) : /\b(pytest|jest|vitest|npm (run )?test|node --test|go test|cargo test)\b/.test(c));

const COV = { ranged: true, piped: true };
const LEVELS = {
  moderate: { ...DIET, ...DIET_LEVELS.moderate, enabled: true },
  'moderate+coverage': { ...DIET, ...DIET_LEVELS.moderate, ...COV, enabled: true },
  high: { ...DIET, ...DIET_LEVELS.high, enabled: true },
  'moderate cap 6k': { ...DIET, ...DIET_LEVELS.moderate, outputChars: 6000, enabled: true },
  'moderate cap 4k': { ...DIET, ...DIET_LEVELS.moderate, outputChars: 4000, enabled: true },
  'high+coverage': { ...DIET, ...DIET_LEVELS.high, ...COV, enabled: true },
};
const tok = s => Math.round(String(s || '').length / 4);
const stripCd = c => String(c || '').trim().replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, '');
const rangedRead = c => { const m = /^sed\s+-n\s+(['"]?)(\d+),(\d+)p\1\s+(['"]?)([^\s'"|;&<>]+)\4$/.exec(c); return m ? { file: m[5], base: Math.max(0, Number(m[2]) - 1) } : null; };
const wholeRead = c => {
  let m = /^(?:cat|nl|bat)(?:\s+-[A-Za-z]+)*\s+(['"]?)([^\s'"|;&<>]+)\1$/.exec(c); if (m) return m[2];
  m = /^sed\s+-n\s+(['"]?)1,\$p\1\s+(['"]?)([^\s'"|;&<>]+)\2$/.exec(c); if (m) return m[3];
  return null;
};
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text || '').join('\n') : '';

// --- one transcript: ordered tool outputs, each with the model call it landed in -------------------
function parse(file) {
  const out = { calls: 0, compactions: [], events: [], prompts: [] };
  const pend = new Map();
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'compact_boundary') { out.compactions.push(out.calls); continue; }
    if (j.type === 'assistant' && j.message) {
      if (j.message.usage) out.calls++;
      for (const b of j.message.content || []) if (b?.type === 'tool_use') pend.set(b.id, { name: b.name, input: b.input || {}, call: out.calls });
      continue;
    }
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (typeof c === 'string' && !j.isMeta) { out.prompts.push(c); continue; }
      for (const b of (Array.isArray(c) ? c : [])) {
        if (b?.type === 'tool_result') {
          const e = pend.get(b.tool_use_id); if (!e) continue; pend.delete(b.tool_use_id);
          e.text = textOf(b.content); e.res = j.toolUseResult; out.events.push(e);
        } else if (b?.type === 'text' && !j.isMeta) out.prompts.push(b.text);
      }
    }
  }
  return out;
}

// re-reads: calls after this one, until the next compaction
const rereads = (call, calls, compactions) => {
  const next = compactions.find(c => c > call);
  return Math.max(0, (next ?? calls) - call);
};

// --- what the compressor would do with one output, at one level ------------------------------------
function apply(ev, cfg, terms) {
  const name = ev.name;
  if (String(name).startsWith('mcp__')) {
    const before = ev.text || '';
    if (!cfg.outputChars || before.length <= cfg.outputChars) return null;
    return { kind: 'cap-mcp', before: before.length, after: capOutput(before, cfg.outputChars).length };
  }
  if (name === 'Read') {
    const content = typeof ev.res?.content === 'string' ? ev.res.content : null;
    if (content == null) return null;
    const narrowed = !!(ev.input.offset || ev.input.limit);
    if (narrowed && !cfg.ranged) return { kind: 'skipped:ranged-read', before: content.length, after: content.length };
    const file = ev.res.filePath || ev.input.file_path || 'f';
    const base = narrowed ? Math.max(0, (Number(ev.input.offset) || 1) - 1) : 0;
    const r = trimFile(content, { ...cfg, file, terms, how: 'Read', numbered: false, base });
    if (!r.text) return { kind: `skipped:read:${r.skip || 'no'}`, before: content.length, after: content.length };
    return { kind: 'read', before: content.length, after: r.text.length };
  }
  if (name !== 'Bash') return { kind: `untouchable:${name}`, before: (ev.text || '').length, after: (ev.text || '').length };
  const command = stripCd(ev.input.command || '');
  const stdout = typeof ev.res?.stdout === 'string' ? ev.res.stdout : (ev.text || '');
  const read = wholeRead(command);
  if (read) {
    const r = trimFile(stdout, { ...cfg, file: read, terms, how: 'sed' });
    if (!r.text) return { kind: `skipped:read:${r.skip || 'no'}`, before: stdout.length, after: stdout.length };
    return { kind: 'read', before: stdout.length, after: r.text.length };
  }
  const rr = cfg.ranged ? rangedRead(command) : null;
  if (rr) {
    const r = trimFile(stdout, { ...cfg, file: rr.file, terms, how: 'sed', base: rr.base });
    if (r.text) return { kind: 'ranged', before: stdout.length, after: r.text.length };
  }
  if (cfg.tests && isTestCmd(command)) {
    // the product summarizes a test run through testing.js; bound it by the level's testChars
    if (stdout.length <= cfg.testChars) return { kind: 'skipped:test-small', before: stdout.length, after: stdout.length };
    return { kind: 'test~', before: stdout.length, after: Math.min(stdout.length, cfg.testChars) };
  }
  if (/^(?:rg|grep|egrep|git\s+grep)\b/.test(command) && (cfg.piped || !/[|;&]/.test(command)) && stdout.length >= cfg.searchChars) {
    const g = groupSearch(stdout, cfg);
    if (g) return { kind: 'search', before: stdout.length, after: g.length };
    return { kind: 'skipped:search-unparsed', before: stdout.length, after: stdout.length };
  }
  if (cfg.outputChars && stdout.length > cfg.outputChars) return { kind: 'cap', before: stdout.length, after: capOutput(stdout, cfg.outputChars).length };
  return { kind: 'untouched', before: stdout.length, after: stdout.length };
}

// why an untouched Bash output was missed, as a bucket a fix could target
function bucket(ev) {
  if (ev.name !== 'Bash') return ev.name.startsWith('mcp__') ? 'mcp' : ev.name;
  const c = stripCd(ev.input.command || '');
  const prog = (c.match(/^([A-Za-z0-9_.\/-]+)/) || [, '?'])[1].split('/').pop();
  const piped = /[|;&]/.test(c);
  const searchy = /^(rg|grep|egrep|git\s+grep)\b/.test(c);
  const ranged = /^sed\s+-n\s+['"]?\d+,/.test(c) || /^(head|tail)\b/.test(c);
  if (searchy && piped) return 'search piped (rg|grep ... | ...)';
  if (searchy) return 'search under the 8k floor';
  if (ranged) return `ranged read (${prog})`;
  if (piped) return `piped chain (${prog} ... | ...)`;
  return prog;
}

function run(files, label) {
  const tot = { sessions: 0, calls: 0, outputs: 0, chars: 0, w: 0 };
  const byLevel = Object.fromEntries(Object.keys(LEVELS).map(k => [k, {}]));
  const miss = new Map();
  for (const f of files) {
    const p = parse(f);
    if (!p.events.length) continue;
    tot.sessions++; tot.calls += p.calls;
    // the session's search terms as the product remembers them, oldest first
    let terms = [];
    const pterms = promptTerms(p.prompts.join('\n')) || [];
    for (const ev of p.events) {
      const st = searchTerms(ev.name, ev.input) || [];
      if (st.length) terms = [...terms, ...st].slice(-DIET.terms);
      const r = rereads(ev.call, p.calls, p.compactions);
      const seen = [...terms.slice(-DIET.terms), ...pterms];
      for (const [lvl, cfg] of Object.entries(LEVELS)) {
        const a = apply(ev, cfg, seen);
        if (!a) continue;
        const b = (byLevel[lvl][a.kind] ||= { n: 0, before: 0, saved: 0, w: 0 });
        b.n++; b.before += tok(' '.repeat(0)) + Math.round(a.before / 4);
        b.saved += Math.round((a.before - a.after) / 4);
        b.w += Math.round((a.before - a.after) / 4) * r;
        if (lvl === 'moderate') {
          tot.outputs++; tot.chars += a.before; tot.w += Math.round(a.before / 4) * r;
          if (a.after === a.before) {
            const k = bucket(ev);
            const m = (miss.get(k) || { n: 0, tokens: 0, w: 0 });
            m.n++; m.tokens += Math.round(a.before / 4); m.w += Math.round(a.before / 4) * r;
            miss.set(k, m);
          }
        }
      }
    }
  }
  const M = n => (n / 1e6).toFixed(1) + 'M';
  console.log(`\n==== ${label}`);
  console.log(`${tot.sessions} sessions, ${tot.calls} model calls, ${tot.outputs} tool outputs`);
  console.log(`tool-output tokens in context: ${M(Math.round(tot.chars / 4))} raw, ${M(tot.w)} weighted by re-reads`);
  for (const lvl of Object.keys(byLevel)) {
    const rows = Object.entries(byLevel[lvl]).filter(([k]) => !k.startsWith('skipped') && !k.startsWith('untouch')).sort((a, b) => b[1].w - a[1].w);
    const sw = rows.reduce((s, [, v]) => s + v.w, 0), ss = rows.reduce((s, [, v]) => s + v.saved, 0);
    console.log(`\n-- ${lvl}: saves ${M(ss)} raw, ${M(sw)} weighted (${(100 * sw / (tot.w || 1)).toFixed(1)}% of output cost)`);
    for (const [k, v] of rows) console.log(`   ${k.padEnd(26)} n=${String(v.n).padStart(5)}  saved ${M(v.saved).padStart(7)}  weighted ${M(v.w).padStart(7)}`);
  }
  console.log(`\n-- untouched at moderate, by bucket (the opportunity), top 14 by weighted cost:`);
  const rows = [...miss.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 14);
  for (const [k, v] of rows) console.log(`   ${k.padEnd(34)} n=${String(v.n).padStart(5)}  ${M(v.tokens).padStart(7)} raw  ${M(v.w).padStart(8)} weighted  ${(100 * v.w / (tot.w || 1)).toFixed(1)}%`);
}

// --- corpora --------------------------------------------------------------------------------------
const PROJ = '/Users/yoavshmariahu/.claude/projects';
const all = [];
for (const d of fs.readdirSync(PROJ)) {
  if (d.includes('artemis-worktrees')) continue;
  const dir = path.join(PROJ, d);
  let st; try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    try { const s = fs.statSync(p); if (s.size >= 100_000 && s.size <= 60_000_000) all.push({ p, m: s.mtimeMs }); } catch {}
  }
}
all.sort((a, b) => b.m - a.m);
const localN = Number(process.argv[2] || 40);
run(all.slice(0, localN).map(x => x.p), `this machine's ${localN} most recent sessions (real work)`);

const evalDirs = fs.readdirSync(PROJ).filter(d => d.includes('artemis-worktrees') && d.includes('opus55-product-12'));
const evalFiles = evalDirs.flatMap(d => fs.readdirSync(path.join(PROJ, d)).filter(f => f.endsWith('.jsonl')).map(f => path.join(PROJ, d, f)));
if (evalFiles.length) run(evalFiles, `the PostHog Opus 5.5 eval sessions (for contrast)`);

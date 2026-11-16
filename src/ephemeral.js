// Superseded page states: a browser agent's old snapshots leave the prompt as soon as a newer one arrives.
//
// Why this is a rule of its own and not the cut (cutting.js). The cut waits: a result is taken at a boundary,
// in a batch big enough to repay the rewrite it causes, because replacing a result deep in a cached prefix
// makes the API write everything after it again. That is the right economics for a file read, which stays
// useful for an unknown while. A page snapshot is different in the one way that matters: the moment the
// next snapshot arrives it describes a page that is no longer there, and its element refs no longer work.
// And at that moment it is still the newest thing in the prompt, so nothing has been cached behind it yet
// that a replacement would have to write again -- provided a cache entry exists that ends just before it.
//
// So two things happen, and both are read from the request alone (no record, no ratchet to keep):
//
//   1. **The replacement.** A result of a browser tool that carries a page state is replaced once `keep`
//      newer ones exist, if what sits between it and the one that superseded it is small (`gapOk`). Small
//      is what makes it free: that stretch is all that is written again. Once replaced it stays replaced,
//      because the rule reads only what came before the superseding result, and that never changes.
//   2. **The anchor.** A cache marker on the block just before the oldest live page state, on every request
//      while that state can still be superseded. The API writes cache entries only at markers
//      (and looks back 20 positions from one for an earlier entry), and the agent's own marker sits at the
//      end of the request -- after the live snapshot, in an entry the replacement will invalidate. The
//      anchor's entry ends before it, so the next request reads everything up to there and writes only the
//      placeholder, the model's action and the new snapshot.
//
// Against no rule at all, a snapshot is then written once, as it always was, and never read back: the
// saving is its cache read on every later call, with no rewrite to repay. `tail: 'bare'` goes one further
// and takes the agent's own marker off the live snapshot, so it is billed as input once and not as a cache
// write -- right for a loop that is all browser steps, wrong for one that reads forty files between two
// pages, which is why it is a setting.
//
// What it costs the model: the old page. It keeps what it wrote about the page at the time and the first
// lines of the result (the action that ran, the URL and title), and is told to take a new snapshot if it
// needs the page again. Whether that loses answers is the bench's question (bench/experiments/browser-*),
// and the rule is off until it has been asked: `--ephemeral`, or `proxy: { ephemeral }` in the machine config.
//
// Like the cut, this edits history, so on an account where the API holds thinking blocks to the history
// that produced them the request is refused and the proxy stands down for the session (proxy.js, 'cut-rejected').

// 0.445 tokens a character is a tool result's own rate (proxy.js:RESULT_TOKENS_PER_CHAR); held here because
// proxy.js imports this module and the dependency may not run both ways.
const RESULT_TOKENS_PER_CHAR = 0.445;

// The tools whose results are a view of something that moves: every action of a browser MCP server answers
// with the page as it now is. A trailing `*` matches a prefix.
// `browser_*` is the same servers' tools as an agent on a framework sees them: LangChain's MCP adapter gives
// a tool its bare name (`browser_snapshot`), with no `mcp__<server>__` in front (checked 2026-11-15).
export const EPHEMERAL_TOOLS = ['mcp__playwright__*', 'mcp__chrome-devtools__*', 'mcp__claude-in-chrome__*', 'mcp__browsermcp__*', 'mcp__puppeteer__*', 'browser_*', 'computer'];
// Where a browser server keeps the page instead of sending it. Playwright MCP 0.0.85 answers an action with
// a link (`.playwright-mcp/page-<time>.yml`) and the model reads the file with its own Read tool (checked
// 2026-11-15 by driving the server with no model: `browser_navigate` returned 384 characters and wrote a
// 13,705-character file; only `browser_snapshot` still answers inline). So a read of such a file is a page
// state by another road, and matching the tool's name alone would see none of them.
export const EPHEMERAL_FILES = ['/.playwright-mcp/page-'];
const READ_TOOLS = new Set(['Read', 'read', 'read_file', 'view']);
export const EPHEMERAL_DEFAULTS = {
  tools: EPHEMERAL_TOOLS,
  files: EPHEMERAL_FILES,
  keep: 1,            // live page states left whole; each one past the first is written again on every step
  minChars: 2000,     // under this a result is an acknowledgement, not a page
  head: 400,          // of a replaced result's own first lines, kept: what ran, the URL, the title
  maxGapBlocks: 15,   // inside the API's 20-position lookback, with room for the model's own blocks
  tail: 'cache',      // 'bare': the live state is sent uncached when it is the newest thing in the request
};
export const MAX_MARKERS = 4;

/** The setting as given (true, a comma list of tool patterns, or an object) made whole; null when off. */
export function ephemeralConfig(v) {
  if (v == null || v === false || v === '' || v === 'off') return null;
  if (v === true || v === 'on') return { ...EPHEMERAL_DEFAULTS };
  if (typeof v === 'string') return { ...EPHEMERAL_DEFAULTS, tools: v.split(',').map(s => s.trim()).filter(Boolean) };
  if (typeof v !== 'object' || v.enabled === false) return null;
  const out = { ...EPHEMERAL_DEFAULTS };
  if (Array.isArray(v.tools) && v.tools.length) out.tools = v.tools.map(String);
  if (Array.isArray(v.files)) out.files = v.files.map(String);
  for (const k of ['keep', 'minChars', 'head', 'maxGapBlocks']) if (Number.isFinite(Number(v[k])) && v[k] !== null && v[k] !== '') out[k] = Number(v[k]);
  out.keep = Math.max(1, Math.round(out.keep));
  if (v.tail === 'bare' || v.tail === 'cache') out.tail = v.tail;
  return out;
}
/** How a saving made under this rule is named beside the cut's policy (cutting.js:policyId). */
export const ephemeralId = v => { const c = ephemeralConfig(v); return c ? `+eph${c.keep}${c.tail === 'bare' ? 'b' : ''}` : ''; };

const matches = (patterns, name) => typeof name === 'string' && patterns.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
// a call whose result is a page: a browser tool, or a read of a file a browser server wrote the page to
const isPageCall = (cfg, call) => !!call && (matches(cfg.tools, call.name)
  || (READ_TOOLS.has(call.name) && (cfg.files || []).some(f => String(call.input?.file_path ?? call.input?.path ?? '').replaceAll('\\', '/').includes(f))));
const textOf = b => (typeof b?.content === 'string' ? b.content
  : Array.isArray(b?.content) ? b.content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '');
const imagesOf = b => (Array.isArray(b?.content) ? b.content.filter(x => x?.type === 'image').length : 0);
// an image is counted at about what the API charges for a screenshot, never at its base64
const IMAGE_CHARS = Math.round(1500 / RESULT_TOKENS_PER_CHAR);
const size = v => {
  try { return JSON.stringify(v, (k, x) => (k === 'data' && typeof x === 'string' && x.length > 400 ? '' : x)).length; } catch { return 0; }
};

// The words are the mechanism (delegate.js:denial, cutting.js:placeholder): they say when the page was seen,
// that it is gone because it changed and not because something failed, and what to do to see it again.
// `paths` is where a replaced result's screenshots were saved: an image leaves the prompt only with the path
// it can be read back from (the owner's rule for the cut too, proxy.js:saveCutImages).
export const pagePlaceholder = (head, chars, paths = []) =>
  `${head ? `${head}\n` : ''}[thinker removed the rest of this page state after use: ${chars} chars${paths.length ? ` and ${paths.length} image${paths.length === 1 ? '' : 's'}, saved at ${paths.join(', ')}` : ''}. `
  + 'It showed the page as it was then; a newer page state follows, and element refs from this one no longer work. '
  + 'You saw it in full at the time, so what you already said from it stands. Take a new snapshot if you need the page again.]';

const headOf = (text, n) => {
  if (!(n > 0) || text.length <= n) return '';
  const cut = text.slice(0, n), nl = cut.lastIndexOf('\n');
  return (nl > n / 2 ? cut.slice(0, nl) : cut).trimEnd();
};

const MARKABLE = new Set(['text', 'tool_use', 'tool_result', 'image', 'document']);
const markable = b => b && MARKABLE.has(b.type) && !(b.type === 'text' && !String(b.text || '').trim());

/**
 * Apply the rule to one Messages request body. Returns null when it has nothing to say (no browser results),
 * else `{ messages, changed, results, chars, tokens, live, anchor, skipped }` -- `messages` is a new array
 * where anything changed and `j` is never mutated.
 */
export function applyEphemeral(j, setting, { saveImages = null } = {}) {
  const cfg = ephemeralConfig(setting);
  const all = Array.isArray(j?.messages) ? j.messages : null;
  if (!cfg || !all) return null;

  // every block in document order, so "what sits between two results" is a slice
  const flat = [], nameOf = new Map();
  all.forEach((m, i) => {
    if (!Array.isArray(m?.content)) { flat.push({ i, k: -1, b: null, chars: size(m?.content) }); return; }
    m.content.forEach((b, k) => {
      if (b?.type === 'tool_use' && b.id) nameOf.set(b.id, b);
      flat.push({ i, k, b, chars: size(b) });
    });
  });
  const states = [];
  flat.forEach((f, at) => {
    const b = f.b;
    if (b?.type !== 'tool_result' || !isPageCall(cfg, nameOf.get(b.tool_use_id))) return;
    const text = textOf(b), images = imagesOf(b);
    if (text.length < cfg.minChars && !images) return;
    states.push({ at, i: f.i, k: f.k, text, images, gone: Math.max(0, text.length - cfg.head) + images * IMAGE_CHARS });
  });
  if (!states.length) return null;

  // 1. the replacement. A state is superseded by the one `keep` places after it; `gap` is what lies between
  // them, which is fixed from the moment the later one arrives, so the verdict never changes afterwards.
  // Other page states are left out of the gap: with `keep` above one they sit between a page and the one
  // that supersedes it by construction, and writing them again on every step is the price that setting
  // names, not a reason to refuse.
  const stateAt = new Set(states.map(s => s.at));
  const span = (from, to) => { let chars = 0, blocks = 0; for (let x = from + 1; x < to; x++) if (!stateAt.has(x)) { chars += flat[x].chars; blocks++; } return { blocks, chars }; };
  const gapOk = (s, g) => g.blocks <= cfg.maxGapBlocks && g.chars <= Math.max(s.gone, cfg.minChars);
  const dead = new Map();
  let chars = 0, images = 0, skipped = 0;
  for (let n = 0; n < states.length - cfg.keep; n++) {
    const s = states[n];
    // a state only as long as its head would be replaced by more than it removes
    if (s.gone <= 0) continue;
    if (!gapOk(s, span(s.at, states[n + cfg.keep].at))) { skipped++; continue; }
    // A result with a screenshot is replaced only where the picture can be saved first (`saveImages` returns
    // the paths, or null): with nowhere to save, the result stays whole and is the cut's to judge.
    if (s.images) { s.paths = saveImages ? saveImages(flat[s.at].b) : null; if (!s.paths) { skipped++; continue; } }
    dead.set(s.at, s); chars += s.gone; images += s.images;
  }
  const live = states.slice(Math.max(0, states.length - cfg.keep));

  const out = all.slice();
  const own = i => { if (out[i] === all[i]) out[i] = { ...all[i], content: Array.isArray(all[i].content) ? all[i].content.slice() : all[i].content }; return out[i]; };
  for (const [, s] of dead) {
    const m = own(s.i), b = m.content[s.k];
    // `cache_control` stays where the agent put it: a marker is the agent's, and the anchor below counts it
    m.content[s.k] = { ...b, content: [{ type: 'text', text: pagePlaceholder(headOf(s.text, cfg.head), Math.max(0, s.text.length - headOf(s.text, cfg.head).length), s.paths || []) }] };
  }

  // 2. the anchor: only while the oldest live state can still be superseded for free, which is the same
  // question `gapOk` will ask when the next one arrives, asked of what has followed it so far
  const first = live[0];
  let anchor = null, reason = null;
  if (first.gone > 0 && gapOk(first, span(first.at, flat.length))) {
    let at = first.at - 1;
    while (at >= 0 && !(flat[at].k === -1 ? String(all[flat[at].i]?.content || '').trim() : markable(flat[at].b))) at--;
    if (at < 0) reason = 'nothing-before';
    else {
      const marks = [];
      out.forEach((m, i) => { if (Array.isArray(m?.content)) m.content.forEach((b, k) => { if (b?.cache_control) marks.push({ i, k }); }); });
      const before = (a, f) => a.i < f.i || (a.i === f.i && a.k < f.k);
      const here = flat[at], lastMark = marks[marks.length - 1];
      const outside = (Array.isArray(j.system) ? j.system.filter(b => b?.cache_control).length : 0)
        + (Array.isArray(j.tools) ? j.tools.filter(t => t?.cache_control).length : 0) + (j.cache_control ? 1 : 0);
      const already = here.k >= 0 && !!out[here.i].content[here.k]?.cache_control;
      // 'bare': the agent's markers after the anchor come off while the live state is the newest message, so
      // the snapshot is input once instead of a cache write nobody will read
      const bare = cfg.tail === 'bare' && first.i === all.length - 1;
      const drop = bare ? marks.filter(a => !before(a, { i: here.i, k: here.k + 1 })) : [];
      let room = MAX_MARKERS - outside - (marks.length - drop.length) - (already ? 0 : 1);
      // no room: an older marker of the agent's gives way, never its last one (that entry is the one the
      // next request reads when no new page arrives)
      const older = marks.filter(a => !drop.includes(a) && a !== lastMark && !(a.i === here.i && a.k === here.k));
      while (room < 0 && older.length) { drop.push(older.shift()); room++; }
      if (room < 0) reason = 'no-marker-room';
      else {
        // the agent's own marker value, so the TTL is the one it chose and a 1h entry never follows a 5m one
        const value = lastMark ? all[lastMark.i].content[lastMark.k].cache_control
          : (Array.isArray(j.system) ? [...j.system].reverse().find(b => b?.cache_control)?.cache_control : null) || j.cache_control || { type: 'ephemeral' };
        for (const d of drop) { const m = own(d.i); const { cache_control: _gone, ...rest } = m.content[d.k]; m.content[d.k] = rest; }
        if (!already) {
          const m = own(here.i);
          if (here.k === -1) m.content = [{ type: 'text', text: String(all[here.i].content), cache_control: value }];
          else m.content[here.k] = { ...m.content[here.k], cache_control: value };
        }
        anchor = { message: here.i, block: Math.max(0, here.k), ...(drop.length ? { moved: drop.length } : {}), ...(bare ? { bare: true } : {}) };
      }
    }
  }
  // Without an anchor a replacement has no entry to be read from, and without one in the request before
  // this there was none either: but that request is gone, and the replacement made then cannot be unmade
  // now without moving the prefix a second time. So what is already superseded stays superseded, and the
  // row says the anchor was refused, which is the thing to look for if writes run high.
  const changed = out.some((m, i) => m !== all[i]);
  return { messages: changed ? out : all, changed, results: dead.size, chars, images,
    tokens: Math.round(chars * RESULT_TOKENS_PER_CHAR), live: live.length, anchor,
    ...(skipped ? { skipped } : {}), ...(reason ? { reason } : {}) };
}

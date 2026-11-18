// The desktop door of thinker's context clearing. The context proxy (src/proxy.js) clears old tool results
// server-side through ANTHROPIC_BASE_URL, and the Claude desktop app sets that variable itself, so its
// sessions never reach the proxy (2026-11-01). This mod runs inside the session instead: when the context
// passes the proxy's trigger it queues the engine's own /compact and answers that compaction itself: the
// old tool results replaced in place by a short placeholder, and, as the proxy does, the call text emptied
// and the earlier thinking dropped from the turns before the newest, which a rebuilt assistant row sheds
// with its handle (the API lets a previous turn's thinking go; checked live 2026-11-01, the next call
// answered with thinking of its own and no 400). No summary is written, and the newest turn is never
// touched. To the engine a desktop session is headless, where compaction only runs as
// a /compact turn: `$.session.compact()` is refused there, and so is anything from a hook holding the turn,
// which is why the command goes through a timer. The record it writes is the proxy's own
// (src/compression.js:noteCompression), so the card, the Stop hook's line and `thinker proxy report` read
// it unchanged. `thinker connect` names this folder in CLAUDE_CODE_PLUGIN_DIRS (src/claude-card.js).
import type { Register, SessionMessage } from 'claude-code'

// the proxy's policy (proxy.js:PROXY_DEFAULTS, proxy-service.js:SERVICE_HOLDOUT, 2026-10-28);
// test/claude-clear.test.js holds the two together
export const TRIGGER = 140000
export const CLEAR_AT_LEAST = 8000
export const KEEP_MIN = 3
export const HOLDOUT = 0
export const TOKENS_PER_CHAR = 1.44 / 4
// a tool result's own rate, for the breakdown's estimate of the results (proxy.js:RESULT_TOKENS_PER_CHAR, measured on results)
export const RESULT_TOKENS_PER_CHAR = 0.445
// what a result's text is in tokens, counted from the text: letters, digits, symbols and newlines, spaces weighing
// nothing (proxy.js:resultTokens, the same weights and the same rule; held to it by test/claude-clear.test.js)
export const RESULT_WEIGHTS = { letter: 0.34, digit: 0.78, symbol: 1.05, newline: 1.6, other: 0.7 }
export function resultTokens(text: string): number {
  const t = String(text ?? '');
  let letter = 0, digit = 0, symbol = 0, newline = 0, other = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) letter++;
    else if (c >= 48 && c <= 57) digit++;
    else if (c === 10) newline++;
    else if (c === 32 || c === 9 || c === 13) continue;
    else if (c < 128) symbol++;
    else other++;
  }
  const w = RESULT_WEIGHTS;
  return Math.round(letter * w.letter + digit * w.digit + symbol * w.symbol + newline * w.newline + other * w.other);
}
// a result under this is not worth a placeholder
export const MIN_CHARS = 200
// Clear, freeze what was cleared, and clear again when it pays (src/clearing.js: the proxy's policy and this door's,
// the owner's call 2026-11-02). A clear here rewrites the conversation in place at a compaction boundary, so
// everything after the first row it changes is written to the cache again, at WRITE_RATIO cache reads a token at the
// 1h rate; it saves a cache read of what it cleared on every later request. So a clear is made when what it would
// drop, read back over the requests the session likely has left, outweighs that write (`clearPays`). What was
// cleared stays cleared: `clearOld` leaves a placeholder alone, so a later clear only takes what came after. A pause
// past the cache's hour makes the next request write its context anyway, so a clear then costs nothing extra.
export const COLD_MS = 65 * 60 * 1000
// reads a written token must save to repay itself: WRITE_1H / readRate of src/clearing.js, a 1h write being 2x an input
// token and a cache read a tenth of one on most models, a twentieth on Opus 5.5, a fortieth on Fable (model-usage.js)
export const READ_RATES: [RegExp, number][] = [[/fable|mythos/, 0.025], [/opus-5-5|opus-5\.5|^opus$/, 0.05], [/./, 0.1]]
export const readRate = (model: string) => (READ_RATES.find(([re]) => re.test(String(model || '').toLowerCase())) || [null, 0.1])[1]
export const writeRatio = (model: string) => 2 / readRate(model)
// A clear must repay its rewrite inside this many later calls; the proxy's own floor (cutting.js:PAYBACK,
// which carries the measurement that set it). test/claude-clear.test.js holds the two together.
export const PAYBACK = 25
// Which cut policy made a saving, in the proxy's own spelling (cutting.js:policyId, POLICY_REV; held to it by
// test/claude-clear.test.js). It goes on the session's record so every door that compares savings groups by the
// policy behind them instead of dating them from one machine's clock -- this door and the proxy are one policy,
// so they must name it with one string. Bump POLICY_REV there and here together.
export const POLICY_REV = 10
const roundTo = (n: number) => (!Number.isFinite(n) ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
// `+in` is the proxy's `cutInputs` (proxy.js:applyCut, 2026-11-14): a cut that also takes the finished call's own
// text. The mod never sets it -- in the desktop app a call's input is a file path, not a heredoc, so the 2026-11-04
// measurement that removed input cutting still holds there (test/claude-clear.test.js exempts the key) -- but the
// term is mirrored here, because the rule is that one policy has one spelling, not that both doors run one config.
export const policyId = (p: { trigger?: number; clearAtLeast?: number; clearDeep?: boolean; cutInputs?: boolean; cutImages?: boolean }) =>
  `r${POLICY_REV}-t${roundTo(p?.trigger as number)}-f${roundTo(p?.clearAtLeast as number)}-p${PAYBACK}-${p?.clearDeep === false ? 'one' : 'deep'}${p?.cutInputs ? '+in' : ''}${p?.cutImages ? '+img' : ''}`
// What a clear costs, counted as the proxy counts it (cutting.js:isRewrite, LONG_CONTEXT; test/claude-clear.test.js
// holds the two together): from the first clear onward, a request that wrote more than half of a long context
// into the prompt cache again is a rewrite, and the cache-write tokens of those requests are the clear's cost,
// priced at the one-hour write rate (compression.js:clearingCostBySession) -- unless it read nothing back, which
// means the cache had expired and the write was coming anyway (cutting.js:chargedRewrite). The engine reports every request's
// usage to `turn.step` in the API's own counts, so the figure is measured, not modelled.
export const LONG_CONTEXT = 100000
export const isRewrite = (u: { read?: number; write?: number; input?: number } | null | undefined) => { const ctx = (u?.read || 0) + (u?.write || 0) + (u?.input || 0); return ctx >= LONG_CONTEXT && (u?.write || 0) > 0.5 * ctx }
export const chargedRewrite = (u: { read?: number; write?: number; input?: number } | null | undefined) => { return isRewrite(u) && (u?.read || 0) > 0 }
// the API's counts, as `turn.step`'s usage carries them, in the proxy log's spelling
export const usageOf = (usage: any) => usage ? { input: Number(usage.input_tokens) || 0, read: Number(usage.cache_read_input_tokens) || 0, write: Number(usage.cache_creation_input_tokens) || 0 } : null
export type Cost = { rewrites: number; write: number }
// the cost after one more request: the write counted when the request rewrote its prefix, as the proxy charges it
// Only on the first request after a clear (`caused`): that is the one request whose prefix the clear changed, and a
// rewrite on any later one was coming without it (compression.js:clearingCostBySession holds the same rule).
export const charge = (cost: Cost | undefined, usage: any, caused = true): Cost => {
  const u = usageOf(usage), c = { rewrites: cost?.rewrites ?? 0, write: cost?.write ?? 0 }
  if (!caused) return c
  if (u && chargedRewrite(u)) { c.rewrites++; c.write += u.write }
  return c
}
export const DELAY_MS = 1500
export const COMMAND = 'thinker-clear'
export const INTRODUCED = 'thinker-clear:introduced'
export const INTRO = 'thinker now clears old tool results, call text and earlier thinking in Claude Desktop sessions too, as it does in the terminal: the card under an answer shows what it saved. /thinker-clear runs one by hand.'
export const TOP_TOOLS = 3
export const RECENT = 8
// What these words must carry, found 2026-11-04 by reading what the model did with the old ones
// ("tool result cleared by thinker to save context"): they were silent on WHEN, and it assumed the
// worst -- "that read's output was cleared before I saw it, so I don't know its line count", "I never
// saw the file but reported a number anyway". It then retracted more of its work each turn and closed
// a 28-turn session with "any line count I gave for a read that came back cleared (most of turns
// 5-26) was made up". All 143 of those values were correct, checked against wc -l. A person reading
// that last message would discard the whole session. So the text states the temporal fact: the
// result was there when it was used, and went afterwards.
export const placeholder = (chars: number) =>
  `[tool result removed by thinker after use: ${chars} chars. You saw it in full at the time, so answers you already gave from it stand. Read it again if you need it now.]`

export type Policy = { keepMin: number; clearAtLeast: number; trigger: number; holdout: number; auto: boolean; clearDeep: boolean }
export const DEFAULTS: Policy = { keepMin: KEEP_MIN, clearAtLeast: CLEAR_AT_LEAST, trigger: TRIGGER, holdout: HOLDOUT, auto: true, clearDeep: true }

// THINKER_HOME/config.json's `proxy` block, as proxy-service.js:serviceArgs reads it; `desktop: false` keeps
// the automatic clearing off here (the command still works), `holdout` 0 keeps every session in
export function policyOf(config: any): Policy {
  const p = config?.proxy ?? {}
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    keepMin: num(p.keepMin, KEEP_MIN),
    clearAtLeast: num(p.clearAtLeast, CLEAR_AT_LEAST),
    trigger: num(p.trigger, TRIGGER),
    holdout: Math.min(1, Math.max(0, num(p.holdout, HOLDOUT))),
    auto: p.desktop !== false,
    // the same key the proxy reads (proxy.js:PROXY_DEFAULTS, on by default since 0.2.19): one clear, then held
    clearDeep: p.clearDeep !== false,
  }
}

// A clear is made when what it drops (`dropped` tokens), read back over the requests the session likely has left
// (`calls` made so far), outweighs the write after it (`recache`, the whole context after the clear); free
// after a pause past the cache's hour. With the proxy's `clearDeep` off, one clear a session. `/thinker-clear` is
// never held back.
// The proxy's cold rule is the same since 2026-11-17 (cutting.js:decide): past the cache's hour the payback is
// waived, and the trigger and the size floor stay in place, so a resumed session under the trigger keeps its
// results by either door.
export const clearPays = (p: Policy, { dropped, recache, calls, idle, cleared, model = '' }: { dropped: number; recache: number; calls: number; idle: number; cleared: boolean; model?: string }) => {
  if (!(dropped > 0)) return false
  if (!p.clearDeep && cleared) return false
  if (idle >= COLD_MS) return true
  // The same inequality the proxy prices, in this door's ratio form (cutting.js:priceCut, 2026-11-13). A
  // rewrite is not charged in full: without the clear this call would have READ the tail back, and would
  // have read what the clear drops too, so both come off the cost. In ratios that is one subtraction on
  // each side -- `writeRatio - 1` for the displaced read, `PAYBACK + 1` for the call that makes the clear,
  // which is now one of the calls that repay it. One policy, two spellings, held together by the test.
  return dropped > 0 && (writeRatio(model) - 1) * recache <= (PAYBACK + 1) * dropped
}

// a session is on one side of the holdout for its whole life (proxy.js:heldOut hashes the same id with
// sha256; this is FNV-1a, there being no crypto in a mod, so the sides differ but the share is the same)
export function heldOut(session: string, share: number): boolean {
  if (!share || !session) return false
  if (share >= 1) return true
  let h = 0x811c9dc5
  for (let i = 0; i < session.length; i++) { h ^= session.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h / 2 ** 32 < share
}

// thinker's own proxy, which clears for this session already
export const proxied = (baseUrl: string | undefined) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(String(baseUrl ?? '').trim())

export type Clear = { messages: SessionMessage[]; cleared: number; chars: number; tokens: number; resultTokens: number; inputTokens: number; rows: number; prefixChars: number; tools: { name: string; calls: number; tokens: number }[] }

// Every result of the newest prompt's turn stays, and at least `keepMin` results in all; every older result
// worth a placeholder is replaced, and nothing else is touched. A user row that carries results is rebuilt
// without its handle, so the engine builds it from the blocks. The newest turn stands as the engine has it,
// its thinking included, which the API requires of the turn in progress.
//
// Until 2026-11-04 this also emptied the call text of the older assistant rows and shed their thinking, as
// the proxy did. Both are gone from both doors: measured in a seven-turn session the results held 487,332
// chars against 2,800 in the tool_use inputs and none at all in the thinking (Claude Code asks for
// `display: omitted`, so only a signature comes back), and in a 28-turn run the model read its own blanked
// calls, said it had been "making the tool calls without file paths", and began doing so. 0.6% of the
// saving for a false history of itself. `chars` and `tokens` are the results; `inputTokens` stays 0.
// what a row weighs, for the prefix a clear keeps in the cache
const charsOf = (m: SessionMessage) => { try { return (m.text ?? '').length + (m.toolResults ?? []).reduce((n, r) => n + (r.text ?? '').length, 0) + (m.toolUses ?? []).reduce((n, u) => n + JSON.stringify(u.input ?? {}).length, 0) } catch { return 0 } }

// ---- the keep list: file reads a clear never takes (src/keep.js, 2026-11-17) ----
// The proxy's rule, in this door's own copy, there being no import in a mod: the newest copy of a kept file
// stays (a read, a write, or a fetch of a web address) -- a `*.md`, what the profile learned the person points at (`<THINKER_HOME>/state/keep.json`), a file
// the person named in a prompt, a file read again after a clear took it. The block between the two markers is
// run by test/keep.test.js against keep.js on the same conversations, so the two cannot drift. It is written
// with `any` alone for that reason: the test strips the annotations and evaluates what is left.
// keep:begin
export const KEEP_DEFAULT = ['*.md']
const kEsc = (s: any) => String(s).replace(/[.+^${}()|[\]\\?]/g, '\\$&')
const kGlob = (p: any) => kEsc(p).replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')
const kNorm = (f: any) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '')
const kIsUrl = (s: any) => /^https?:\/\//i.test(String(s || '').trim())
const kUrlKey = (u: any) => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
const kUrlCovers = (parent: any, key: any) => !!parent && (key === parent || (key.startsWith(parent) && '/?&'.includes(key[parent.length])))
export function keepMatcher(patterns: any = KEEP_DEFAULT) {
  const names: any = [], paths: any = [], urls: any = []
  for (const raw of patterns || []) {
    if (kIsUrl(raw)) { urls.push(kUrlKey(raw)); continue }
    const p = kNorm(String(raw || '').trim())
    if (!p) continue
    if (p.includes('/')) paths.push(new RegExp(`(?:^|/)${kGlob(p.replace(/^\//, ''))}$`, 'i'))
    else names.push(new RegExp(`^${kGlob(p)}$`, 'i'))
  }
  return (file: any) => {
    if (kIsUrl(file)) { const key = kUrlKey(file); if (urls.some((p: any) => kUrlCovers(p, key))) return true }
    const f = kIsUrl(file) ? kUrlKey(file).replace(/\?.*$/, '') : kNorm(file)
    if (!f) return false
    const base = f.slice(f.lastIndexOf('/') + 1)
    return names.some((r: any) => r.test(base)) || (!kIsUrl(file) && paths.some((r: any) => r.test(f)))
  }
}
const K_INJECTED = /<(thinker-[\w-]+|system[-_]reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|agent-message)>[\s\S]*?<\/\1>/g
const K_NAMEABLE = /^[^\s/]{1,120}\.[A-Za-z0-9]{1,8}$/
export function namedIn(prompts: any = []) {
  const said = (Array.isArray(prompts) ? prompts : [prompts]).map((t: any) => String(t || '').replace(K_INJECTED, ' ')).join('\n').toLowerCase()
  const memo = new Map()
  const urls = (said.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u: any) => kUrlKey(u.replace(/[.,;:!?]+$/, '')))
  return (file: any) => {
    if (kIsUrl(file)) { const key = kUrlKey(file); return urls.some((p: any) => kUrlCovers(p, key)) }
    const f = kNorm(file), base = f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    if (!said || !K_NAMEABLE.test(base)) return false
    if (!memo.has(base)) memo.set(base, new RegExp(`(?:^|[^\\w.-])${kEsc(base)}(?![\\w-]|\\.\\w)`).test(said) || said.startsWith(base))
    return memo.get(base)
  }
}
const K_SHRINKS = /\|\s*(grep|rg|head|tail|wc|awk|cut|sort|uniq|jq|python|node)\b/
const K_READ_CMD = /^\s*(?:cat|less|more|sed\s+-n\s+('[^']*'|"[^"]*"|\S+)|head\s+-n?\s*(\d+)|head\s+-c\s*\d+)\s+(.+?)\s*$/
const K_READ_TOOL = /^(read|read_file|view|view_file|open_file|cat)$/i
const K_FETCH_TOOL = /^(webfetch|web_fetch|fetch|fetch_url|url_fetch|read_url|open_url)$/i
const K_FETCH_CMD = /^\s*(curl|wget)\s/
const K_WRITE_TOOL = /^(write|write_file|create_file)$/i
const K_SHELL_TOOL = /^(bash|shell|exec_command|local_shell|run_terminal_cmd|run_shell_command|execute_command|container\.exec)$/i
const K_CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/
const K_RANGED = ['offset', 'limit', 'start_line', 'end_line', 'view_range', 'line_start', 'line_end']
const kUnquote = (f: any) => String(f).replace(/^["']|["']$/g, '').replace(/^\.\//, '')
const kPathOf = (input: any) => [input.file_path, input.filePath, input.path, input.target_file, input.filename].find((v: any) => typeof v === 'string' && v) || ''
export function copyOf(name: any, input: any) {
  if (typeof input === 'string') { try { input = JSON.parse(input) } catch { return null } }
  if (!name || !input || typeof input !== 'object') return null
  if (K_READ_TOOL.test(name)) {
    const f = kPathOf(input)
    return f ? { files: [kUnquote(f)], whole: !K_RANGED.some((k: any) => input[k] != null && input[k] !== '') } : null
  }
  if (K_WRITE_TOOL.test(name)) {
    const f = kPathOf(input)
    return f && typeof (input.content ?? input.contents ?? input.text) === 'string' ? { files: [kUnquote(f)], whole: true } : null
  }
  if (K_FETCH_TOOL.test(name)) return kIsUrl(input.url) ? { files: [String(input.url).trim()], whole: true } : null
  if (K_SHELL_TOOL.test(name)) {
    const raw = input.command ?? input.cmd
    const cmd = Array.isArray(raw) ? String(raw[raw.length - 1] ?? '') : typeof raw === 'string' ? raw : ''
    if (!cmd) return null
    const m = cmd.match(K_CD), dir = m ? kUnquote(m[1]) : ''
    const line = m ? cmd.slice(m[0].length) : cmd
    if (K_FETCH_CMD.test(line)) {
      if (/\|/.test(line) || /[;&]/.test(line.replace(/https?:\/\/\S+/g, ''))) return null
      const urls = (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(kUnquote).filter(kIsUrl)
      return urls.length ? { files: urls, whole: true } : null
    }
    if (K_SHRINKS.test(line) || /[;&]|\|\|/.test(line.replace(/\|\|/g, ';'))) return null
    const r = line.match(K_READ_CMD)
    if (!r) return null
    const files = (r[3].match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a: any) => a.replace(/^["']|["']$/g, '')).filter((a: any) => !a.startsWith('-'))
    if (!files.length) return null
    return {
      files: files.map(kUnquote).map((f: any) => (dir && !f.startsWith('/') ? `${dir.replace(/\/+$/, '')}/${f}` : f)),
      whole: /^\s*(cat|less|more)\s/.test(line),
    }
  }
  return null
}
const kSame = (a: any, b: any) => a === b || (a.startsWith('/') && !b.startsWith('/') ? a.endsWith('/' + b) : (!a.startsWith('/') && b.startsWith('/') ? b.endsWith('/' + a) : false))
export function keptCalls(calls: any = [], opts: any = {}) {
  const gone = opts.cut instanceof Set ? opts.cut : new Set(opts.cut || [])
  const match = keepMatcher(opts.patterns || KEEP_DEFAULT), said = namedIn(opts.prompts || [])
  const seen: any = []
  const byName = new Map()
  const entryOf = (file: any) => {
    const hit = byName.get(file)
    if (hit) return hit
    let e = seen.find((x: any) => kSame(x.file, file))
    if (!e) { e = { file, last: null, lastWhole: null, wasCut: false, reread: false }; seen.push(e) }
    byName.set(file, e)
    return e
  }
  for (const c of calls) {
    if (!c || !c.id) continue
    const copy = copyOf(c.name, c.input)
    if (!copy) continue
    for (const f of copy.files) {
      const e = entryOf(f)
      if (gone.has(c.id)) { e.wasCut = true; continue }
      if (e.wasCut) e.reread = true
      e.last = c.id
      if (copy.whole) e.lastWhole = c.id
    }
  }
  const ids = new Set(), files: any = []
  for (const e of seen) {
    const id = e.lastWhole || e.last
    if (!id) continue
    const why = match(e.file) ? 'pattern' : said(e.file) ? 'named' : e.reread ? 'reread' : null
    if (!why) continue
    ids.add(id)
    files.push({ file: e.file, why, id })
  }
  return { ids, files }
}
// keep:end

// The calls and the person's words of this door's rows. A result this mod replaced is the cut: it is in the
// rows as its placeholder, which is the one record a clear leaves here.
const CLEARED_PREFIX = '[tool result removed by thinker after use:'
export function keptOf(messages: readonly SessionMessage[], patterns: string[] = KEEP_DEFAULT): Set<string> {
  const calls: any[] = [], prompts: string[] = [], cut: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant') for (const u of m.toolUses ?? []) calls.push({ id: u.tool_use_id, name: u.tool, input: u.input })
    else if (m.role === 'user') {
      if ((m.text ?? '').trim()) prompts.push(m.text as string)
      for (const r of m.toolResults ?? []) if ((r.text ?? '').startsWith(CLEARED_PREFIX)) cut.push(r.tool_use_id)
    }
  }
  return keptCalls(calls, { patterns, prompts, cut }).ids as Set<string>
}
// `<THINKER_HOME>/state/keep.json`, as keep.js:keepPatterns reads it: the defaults and every repository's list
export async function keepPatternsOf($: any): Promise<string[]> {
  let learned: string[] = []
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const all = JSON.parse(String(await $.fs.read(`${home}/state/keep.json`)))
    learned = Object.values(all?.repos ?? {}).flatMap((r: any) => (Array.isArray(r?.files) ? r.files : [])).filter((p: any) => typeof p === 'string' && p.trim())
  } catch {}
  return [...new Set([...KEEP_DEFAULT, ...learned])]
}

// The ladder the proxy prices (proxy.js:cutCandidates, 2026-11-13): the newest eligible result, then the two
// newest, and so on from the tail backwards. Sizes alone -- no rows are rebuilt -- so the check can price
// every depth and the clear itself happens once, at the depth chosen.
//
// Since 2026-11-16 every rung is priced at the whole context after the clear (`chooseDepth`), because a row
// replaced in the middle leaves no cached prefix to read back; a deeper rung then costs less and saves more,
// so the deepest one is the one that can pay, and the ladder is kept for the depth it names.
export function clearLadder(messages: readonly SessionMessage[], { keepMin = KEEP_MIN, keep = null as Set<string> | null } = {}): { depth: number; tokens: number; prefixChars: number }[] {
  const pre: number[] = [0]
  for (let i = 0; i < messages.length; i++) pre.push(pre[i] + charsOf(messages[i]))
  const out: { depth: number; tokens: number; prefixChars: number }[] = []
  let kept = 0, inLatestTurn = true, tokens = 0, depth = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const rs = m.role === 'user' ? m.toolResults ?? [] : []
    if (!rs.length) { if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false; continue }
    let took = false
    for (const r of [...rs].reverse()) {
      const text = r.text ?? ''
      if (inLatestTurn || kept < keepMin) { kept++; continue }
      if (text.length < MIN_CHARS) continue
      if (keep?.has(r.tool_use_id)) continue   // the newest copy of a kept file is no rung's to take
      depth++; tokens += resultTokens(text); took = true
    }
    if (took) out.push({ depth, tokens, prefixChars: pre[i] })
  }
  return out
}

// One policy, decided where the proxy decides it: the DEEPEST rung that repays its rewrite. `clearPays` is
// this door's spelling of the inequality `cutting.js:priceCut` prices, and `decideCut` likewise takes the
// largest paying set rather than the first. `null` is the refusal the proxy logs as `payback`.
export function chooseDepth(messages: readonly SessionMessage[], p: Policy, ctx: { tokens: number; calls: number; idle: number; cleared: boolean; model?: string; keep?: Set<string> | null }): number | null {
  let take: number | null = null
  for (const rung of clearLadder(messages, { keepMin: p.keepMin, keep: ctx.keep ?? null })) {
    if (rung.tokens < p.clearAtLeast) continue
    // the whole context after the clear, not the part after the first row it changes: a row replaced in the
    // middle leaves no cached prefix to read back (proxy.js:cutCandidates, 2026-11-16)
    const recache = Math.max(0, ctx.tokens - rung.tokens)
    if (clearPays(p, { dropped: rung.tokens, recache, calls: ctx.calls, idle: ctx.idle, cleared: ctx.cleared, model: ctx.model ?? '' })) take = rung.depth
  }
  return take
}

export function clearOld(messages: readonly SessionMessage[], { keepMin = KEEP_MIN, depth = Infinity, keep = null as Set<string> | null } = {}): Clear {
  const nameOf = new Map<string, string>()
  for (const m of messages) if (m.role === 'assistant') for (const u of m.toolUses ?? []) nameOf.set(u.tool_use_id, u.tool)
  const byTool = new Map<string, { calls: number; tokens: number }>()
  let kept = 0, cleared = 0, chars = 0, resultTokens_ = 0, inputChars = 0, rows = 0, inLatestTurn = true, firstChanged = -1
  const out: SessionMessage[] = []
  const older: number[] = [], olderAt: number[] = []   // positions in `out` (and in `messages`) of assistant rows before the newest turn
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const rs = m.role === 'user' ? m.toolResults ?? [] : []
    if (!rs.length) {
      // a prompt row ends the newest turn, seen from the end
      if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false
      if (m.role === 'assistant' && !inLatestTurn && m.handle) { older.push(out.length); olderAt.push(i) }
      out.push(m); continue
    }
    let touched = false
    const toolResults = [...rs].reverse().map(r => {
      const text = r.text ?? ''
      if (inLatestTurn || kept < keepMin) { kept++; return r }
      if (text.length < MIN_CHARS) return r
      if (keep?.has(r.tool_use_id)) return r   // kept (keep.js): the person's notes, a file they named, a file fetched back
      if (cleared >= depth) return r      // the rung chosen: the newest `depth` results and no more
      cleared++; chars += text.length; resultTokens_ += resultTokens(text); touched = true
      const name = nameOf.get(r.tool_use_id) ?? 'tool'
      const t = byTool.get(name) ?? { calls: 0, tokens: 0 }
      t.calls++; t.tokens += resultTokens(text); byTool.set(name, t)
      return { tool_use_id: r.tool_use_id, text: placeholder(text.length), ...(r.isError ? { isError: true as const } : {}) }
    }).reverse()
    out.push(touched ? { role: 'user', text: m.text, toolUses: [], toolResults } : m)
    if (touched) firstChanged = i
  }
  out.reverse()
  // the rows before the first one a clear changes keep their place in the cache; what follows is written again
  const changedAt = firstChanged
  const prefixChars = changedAt > 0 ? messages.slice(0, changedAt).reduce((n, m) => n + charsOf(m), 0) : 0
  const tools = [...byTool].map(([name, t]) => ({ name, calls: t.calls, tokens: t.tokens }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TOOLS)
  const inputTokens = Math.round(inputChars * TOKENS_PER_CHAR)
  return { messages: out, cleared, chars: chars + inputChars, tokens: resultTokens_ + inputTokens, resultTokens: resultTokens_, inputTokens, rows, prefixChars, tools }
}

// The record the proxy writes (compression.js:noteCompression): `saved` adds up over the requests that leave
// the cleared tokens out, `uses` and `tools` describe what is out of the prompt now.
// `kinds` is this door's own: the latest clear by what left the prompt, in tokens. `results` and `inputs` are
// estimated from the text; `thinking` is what the measured whole leaves once those are taken out, and
// `measured` says whether the whole came from the API's context figures (before the clear, and on the first
// request after it) or is the estimate alone.
export type Kinds = { results: number; inputs: number; thinking: number; total: number; measured: boolean }
// `cost` and `model` are this door's own too: the proxy's log carries each request's writes and model on its rows,
// and a desktop session has no rows, so the record keeps what the netted figure needs (delivery.js:rewriteCostFor).
export type State = { session: string; firstAt: number; lastAt: number; requests: number; saved: number; uses: number; policy?: string; policyChanged?: boolean; tools?: Clear['tools']; recent: { at: number; cleared: number; uses: number }[]; kinds?: Kinds; cost?: Cost; model?: string; firstTurn?: number; told?: boolean }

// module state: starts over on a reload (the record on disk does not)
let policy: Policy = DEFAULTS
let keepPatterns: string[] = KEEP_DEFAULT   // the keep list's patterns, read again whenever a clear is weighed
let auto = false
let pending = false
let pendingFrom = ''
let pendingDepth: number | null = null   // the rung the check chose; null is every eligible result (a hand-run clear)
// the pause before this turn, the requests the session has made, and whether a turn is under way (for the pause)
let idle = 0
let inTurn = false
let steps = 0
let clearedAt = 0    // when this session last cleared; the block is held from then (clearPays)
let lastTurnAt = 0   // the previous turn's end, to see a pause past the cache's hour
let out = 0          // tokens out of the prompt now, added to `saved` on every request
let before = 0       // the context as the API last reported it, taken as the clear is scheduled and again as it runs
let settle = false   // the first request after a clear sizes it for real
let uses = 0
let attemptAt = 0    // the context an automatic attempt was scheduled at
let holdUntil = 0    // no automatic attempt below this context (autoDue)
let state: State | null = null
let file = ''

const stateFile = async ($: any) => {
  const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
  const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
  return `${home}/state/compression/${id}.json`
}

async function save($: any) {
  if (!state || !file) return
  try { await $.fs.write(file, JSON.stringify(state)) } catch {}
}

const describe = (c: Clear) => `cleared ${c.cleared} tool ${c.cleared === 1 ? 'result' : 'results'} and ${c.rows} earlier ${c.rows === 1 ? 'turn' : 'turns'}' call text and thinking, ${c.tokens.toLocaleString()} tokens`

const contextTokens = async ($: any) => { try { return (await $.session.usage()).context.tokens ?? 0 } catch { return 0 } }

// The live window in the rows `session.compact` hands this mod. The rows form of `$.session.messages` is the transcript
// as saved, which keeps every row from before a compaction boundary with its result whole; the API form is
// what the next request is built from, so it holds the placeholders of an earlier clear and nothing from
// before the engine's own compaction. Reading the saved rows, the check below found 100k+ to clear on every
// turn that the compaction then refused, and each turn ended in a /compact and a "not compacted" line
// (reported from Claude Desktop, 2026-11-05).
const textOf = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b?.type === 'text' ? String(b.text ?? '') : '')).join('') : ''
export function liveRows(api: readonly any[]): SessionMessage[] {
  return api.map(m => {
    const blocks: any[] = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: textOf(m?.content) }]
    const text = blocks.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('')
    if (m?.role === 'assistant') {
      const toolUses = blocks.filter(b => b?.type === 'tool_use').map(b => ({ tool_use_id: String(b.id), tool: String(b.name), input: b.input ?? {} }))
      return { role: 'assistant', text, toolUses } as any
    }
    const toolResults = blocks.filter(b => b?.type === 'tool_result').map(b => ({ tool_use_id: String(b.tool_use_id), text: textOf(b.content), ...(b.is_error ? { isError: true } : {}) }))
    return { role: 'user', text, toolUses: [], ...(toolResults.length ? { toolResults } : {}) } as any
  })
}

// What a clear would take right now, read from the live window before anything is started. The engine
// prints a skipped compaction under the answer ("not compacted: <reason>"), so an attempt that was never
// going to clear enough became a line in the session every time the context grew past the trigger again
// (reported from a desktop session, 2026-11-02). Checking first means the automatic clear says nothing at
// all until it has something to do. Returns null where the window cannot be read, and then the automatic
// clear does nothing: a guess here is a line in the person's chat.
export async function liveMessages($: any): Promise<SessionMessage[] | null> {
  try {
    const api = await $.session.messages({ as: 'api' })
    return Array.isArray(api) ? liveRows(api) : null
  } catch { return null }
}

async function wouldClear($: any, p: Policy): Promise<Clear | null> {
  try {
    const api = await $.session.messages({ as: 'api' })
    if (!Array.isArray(api)) return null
    const rows = liveRows(api)
    keepPatterns = await keepPatternsOf($)
    return clearOld(rows, { ...p, keep: keptOf(rows, keepPatterns) })
  } catch { return null }
}

// enough to be worth a compaction turn: `clearAtLeast` for the automatic clear, anything at all by hand
// (a transcript that cannot be read lets a hand-run clear try, never the automatic one)
export const worthIt = (c: Clear | null, p: Policy, from: string) =>
  !c ? from !== 'auto' : c.cleared > 0 && (from !== 'auto' || c.tokens >= p.clearAtLeast)

// The latch behind the check: an automatic attempt that did not clear (refused by the hook, or never taken
// over) holds the next one until the context has grown by `HOLD_GROWTH`. However the check and the
// compaction come to disagree again, the most the person sees is one line per that much new context, never
// one per turn. A clear that went through lifts it.
//
// It was `clearAtLeast` until 2026-11-14, when it broke: the two were the same 60,000 and the size floor then
// fell to 8,000 with the ladder (`proxy.js:PROXY_DEFAULTS`), taking the latch down with it. A hold of 8k is
// no hold -- a working session grows that in a turn or two -- so the skip line after every answer that this
// exists to prevent was back (reported 2026-11-02 and again 2026-11-05). They were only ever equal by
// coincidence: the floor is what a cut must be WORTH, and this is how much new context must arrive before
// the person is shown another line. Nothing about the ladder's pricing bears on the second.
export const HOLD_GROWTH = 60000
export const autoDue = (tokens: number, p: Policy, holdUntil: number) => tokens >= p.trigger && tokens >= holdUntil

const hold = () => { if (pendingFrom === 'auto') holdUntil = attemptAt + HOLD_GROWTH }

function schedule($: any, from: string, tokens = 0) {
  pending = true; pendingFrom = from; attemptAt = tokens
  void contextTokens($).then(t => { if (t) before = t })
  $.clock.after(DELAY_MS, async () => {
    try {
      await $.command.run({ command: 'compact' })
      if (pending) {
        pending = false; hold()
        if (from === 'manual') $.ui.toast('thinker-clear: /compact ran but this mod did not take it over')
      }
    } catch (err) {
      pending = false; hold()
      if (from === 'manual') $.ui.toast(`thinker-clear: could not run /compact (${String((err as any)?.message ?? err)})`)
    }
  })
}

// --- a switched-off tool, sent as a pointer to its definition on disk (src/tool-stubs.js) -------------------
// The proxy replaces a registered tool's entry in every request it forwards; a desktop session never reaches
// it, so this hook answers `tool.describe` for the same tools with the same sentence (a mod can rewrite a
// description, not a schema). The registry is the machine's, read once a session; the file the switch wrote
// holds what a transcript recorded, so the definition as the engine built it is written over it here, once.
// The sentence is tool-stubs.js:pointer, held to it by test/claude-clear.test.js.
export const POINTER_OPENS = 'thinker keeps this tool\'s full definition out of the prompt.'
export const toolPointer = (name: string, file: string) => `${name}: ${POINTER_OPENS} Before the first call to it in this session, read ${file} (what it does and the schema of its input), then call it as that file says.`
let stubs: Record<string, { file: string }> | null = null
const stubsOf = async ($: any) => {
  if (stubs) return stubs
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const j = JSON.parse(String(await $.fs.read(`${home}/state/tool-stubs.json`)))
    stubs = j && typeof j.tools === 'object' && j.tools ? j.tools : {}
  } catch { stubs = {} }
  return stubs
}

// the folder the definitions live in, for the grant below: a file is one of thinker's when it sits right in it
const toolsDir = async ($: any) => `${(await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`}/tools`
export const isToolFile = (file: unknown, dir: string) => typeof file === 'string' && file.startsWith(`${dir}/`) && file.endsWith('.json') && !file.slice(dir.length + 1).includes('/') && !file.includes('..')

// THE DELEGATION TRIGGER, FROM INSIDE THE HARNESS (2026-11-15, the owner's call; src/delegate.js).
// A settings hook can deny a read but cannot start a subagent, and words asking the lead to start one are a
// nudge (Sonnet refused them). This hook can do both: it sees the call before it runs, asks thinker's own rule
// on the fly (`hook pretool` with `host_runs`: the file's size, the holdout, the log row --
// one copy of the rule, the CLI's), and when the rule fires it spawns the harness's own subagent
// (`$.agent.spawn`) and answers the call with its report inside the sentence a lead works from. What
// `opencode-v2.js:hostRun` is for OpenCode. A run that fails or runs out of time lets the call through.
export const REPORT_SLOT = '{{thinker-report}}'
export const DELEGATE_TIMEOUT_MS = 240_000
export const DELEGATE_SESSION_MARK = 'claude-delegate'
const OFF = /^(off|false|0|no)$/i
// on unless switched off, as delegate.js:delegateConfig reads it: THINKER_DELEGATE (an off word), else `delegate: false`
// or `delegate: { enabled: false }` in <THINKER_HOME>/config.json
export function delegateOn(env: string | undefined, config: any): boolean {
  if (env !== undefined && env !== '') return !OFF.test(env)
  const d = config?.delegate
  return !(d === false || (d && typeof d === 'object' && d.enabled === false))
}
// thinker's CLI, read off the prompt hook thinker wrote into Claude Code's settings: the copy the hooks run
export const cliOf = (settings: any): string | null => {
  for (const g of settings?.hooks?.UserPromptSubmit || []) for (const h of g?.hooks || []) {
    const hit = /^node "([^"]+[\\/]cli\.js)" hook prompt\b/.exec(String(h?.command || ''))
    if (hit) return hit[1]
  }
  return null
}
// the call as Claude Code's PreToolUse spells it: the tool's arguments apart from what the engine reserves
export function pretoolEvent(e: any, ctx: { session: string; cwd: string; turn: string; prompt: string }) {
  const { tool, tool_use_id, agentId, requestMeta, consent, ...input } = e
  return { session_id: ctx.session, cwd: ctx.cwd, prompt_id: ctx.turn, user_prompt: ctx.prompt, tool_name: tool, tool_input: input, tool_use_id, host_runs: true }
}
// the order out of the CLI's answer, or null: nothing fired, or it fired with nothing for the host to run
export function orderOf(stdout: string): any | null {
  try { const j = JSON.parse(stdout); const o = j?.thinkerRun; return o && o.agent && o.prompt && String(o.wrap || '').includes(REPORT_SLOT) ? o : null } catch { return null }
}
const waiting = new Map<string, (answer: string | null) => void>()
let delegating = false, cli: string | null = null, turn = { id: '', prompt: '' }
async function delegateSetup($: any) {
  delegating = false
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    let config: any = null
    try { config = JSON.parse(String(await $.fs.read(`${home}/config.json`))) } catch {}
    if (!delegateOn(await $.env.get('THINKER_DELEGATE'), config)) return
    cli = (await $.env.get('THINKER_CLI')) || null
    if (!cli) {
      const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
      try { cli = cliOf(JSON.parse(String(await $.fs.read(`${dir}/settings.json`)))) } catch {}
    }
    if (!cli) return
    const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
    if (id) await $.fs.write(`${home}/state/${DELEGATE_SESSION_MARK}/${id}`, '')   // the settings hook stands down here
    delegating = true
  } catch {}
}
async function delegateCall($: any, e: any): Promise<string | null> {
  if (!delegating || !cli || e.agentId) return null   // a subagent's own reads are its work
  const ev = pretoolEvent(e, { session: String(await $.session.id()), cwd: String(await $.session.cwd()), turn: turn.id, prompt: turn.prompt.slice(0, 4000) })
  const r = await $.process.run(['node', cli, 'hook', 'pretool', '--client', 'claude', '--user'], { stdin: JSON.stringify(ev), timeoutMs: 30_000 })
  const order = r.exitCode === 0 ? orderOf(String(r.stdout || '')) : null
  if (!order) return null
  // no model named: the agent's own definition picks it (thinker pins Explore.md), and the Agent tool refuses a full id
  const s = await $.agent.spawn({ subagentType: order.agent, prompt: order.prompt, description: order.title })
  if (!s?.agentId) return null
  const answer = new Promise<string | null>(done => waiting.set(s.agentId, done))
  // the wait is spent inside `$` calls, which a hook's own time budget does not count
  const until = Date.now() + DELEGATE_TIMEOUT_MS
  let report: string | null | undefined
  answer.then(a => { report = a })
  while (report === undefined && Date.now() < until) await $.process.run(['sleep', '0.5'])
  waiting.delete(s.agentId)
  return report ? String(order.wrap).replace(REPORT_SLOT, report) : null
}

// --- thinker off for one session ---------------------------------------------------------------
// `/thinker-disable` takes the session it is typed in out of thinker and leaves every other session as it
// was (issue #858): the wiring is machine-wide (the proxy's URL and the hooks are in the agent's settings,
// read by every session), and this is the one place that runs inside a single session. Two writes to this
// process's environment do it, checked live on Claude Code 2.1.327 (2026-11-18):
//   - ANTHROPIC_BASE_URL unset: the engine reads it at every send, so the next model request goes to
//     Anthropic itself and the proxy never sees the session again. Rewriting the request's URL in an
//     `http.fetch` hook does not do this: the engine keeps the credential to the origin the request was
//     raised for, and Anthropic answers 401.
//   - THINKER_HOOKS=off: every hook command the engine starts afterwards inherits it, and a user-scope
//     hook returns on it before doing anything (commands/hooks.js). The hooks cannot be taken out for one
//     session: the engine runs the settings' hooks whatever a `settings.read` hook answers, and a
//     `classic.*` hook that answers in their place silences every other tool's hooks with them.
// Only thinker's own plain route is taken away: a gateway, the desktop app's own URL and the Bedrock route
// (a path on the proxy, with a credential of its own beside it) are left where they are, and the answer
// says so. The mark is a file by session id, so a resumed session and a reloaded mod stay off; it holds
// what was there, for `/thinker-enable` to put back.
export const SESSION_OFF_MARK = 'session-off'
export const DISABLE = 'thinker-disable'
export const ENABLE = 'thinker-enable'
export type OffMark = { off: boolean; baseUrl?: string | null; hooks?: string | null; at?: number }
// the proxy service's own URL with no path (state/proxy-service.json: `port`, and `ports` while one is being replaced)
export function ownRoute(baseUrl: string | undefined | null, service: any): boolean {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i.exec(String(baseUrl ?? '').trim())
  if (!m) return false
  const ports = [service?.port, ...(Array.isArray(service?.ports) ? service.ports : [])].map(Number).filter(n => n > 0)
  return ports.includes(Number(m[1]))
}
// what `/thinker-disable` answers: whether the route went, and why not when it stayed
export function offWords(route: 'direct' | 'none' | 'kept' | 'refused', baseUrl?: string | null, why?: string): string {
  const hooks = 'its hooks do nothing here'
  if (route === 'direct') return `thinker is off for this session: model requests go straight to Anthropic, not through the proxy, and ${hooks}. Other sessions are unchanged. /${ENABLE} turns it back on.`
  if (route === 'none') return `thinker is off for this session: it was not going through the proxy, and ${hooks}. Other sessions are unchanged. /${ENABLE} turns it back on.`
  if (route === 'refused') return `thinker's hooks are off for this session, but it still goes through the proxy: Claude Code refused the change${why ? ` (${why})` : ''}. /${ENABLE} turns the hooks back on.`
  return `thinker's hooks are off for this session, but its route is left as it is: ${baseUrl} is not thinker's plain proxy route, so taking it away would break the session. /${ENABLE} turns the hooks back on.`
}
let off: OffMark | null = null
const homeOf = async ($: any) => (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
const offFile = async ($: any) => `${await homeOf($)}/state/${SESSION_OFF_MARK}/${String(await $.session.id()).replace(/[^\w.-]/g, '_')}.json`
const serviceOf = async ($: any) => { try { return JSON.parse(String(await $.fs.read(`${await homeOf($)}/state/proxy-service.json`))) } catch { return null } }
async function readOff($: any): Promise<OffMark | null> {
  try { const m = JSON.parse(String(await $.fs.read(await offFile($)))); return m?.off === true ? m : null } catch { return null }
}
// Applies the mark to this process: called by the command, and at every session start that finds the mark
// (a resumed session starts with the settings' route again; after a reload there is nothing left to take).
async function sessionOff($: any, was: OffMark | null): Promise<string> {
  const url = await $.env.get('ANTHROPIC_BASE_URL')
  const own = ownRoute(url, await serviceOf($))
  let route: 'direct' | 'none' | 'kept' | 'refused' = url ? 'kept' : 'none', why = ''
  if (own) { const r = await $.env.set('ANTHROPIC_BASE_URL', undefined); route = r?.deny ? 'refused' : 'direct'; why = r?.deny || '' }
  const hooks = await $.env.get('THINKER_HOOKS')
  await $.env.set('THINKER_HOOKS', 'off')
  off = { off: true, baseUrl: was?.baseUrl ?? (route === 'direct' ? url : null), hooks: was ? was.hooks ?? null : hooks ?? null, at: was?.at ?? Date.now() }
  await $.fs.write(await offFile($), JSON.stringify(off))
  auto = false
  delegating = false
  return offWords(route === 'none' && off.baseUrl ? 'direct' : route, url, why)
}
async function sessionOn($: any): Promise<string> {
  const was = off ?? await readOff($)
  if (!was) return `thinker is on in this session already. /${DISABLE} turns it off here.`
  await $.env.set('THINKER_HOOKS', was.hooks ?? undefined)
  // the route goes back only while it is still the service's: a proxy that was turned off or moved since is not written back
  let route = ''
  if (was.baseUrl && !(await $.env.get('ANTHROPIC_BASE_URL'))) {
    if (ownRoute(was.baseUrl, await serviceOf($))) { const r = await $.env.set('ANTHROPIC_BASE_URL', was.baseUrl); route = r?.deny ? ` Claude Code refused to put the proxy route back (${r.deny}): requests stay direct.` : ' Model requests go through the proxy again.' }
    else route = ' The proxy is no longer at the address this session had, so requests stay direct; a new session takes the current route.'
  }
  off = null
  await $.fs.write(await offFile($), JSON.stringify({ off: false }))
  const test = (await $.env.get('THINKER_TEST')) === '1'
  auto = policy.auto && !test && !proxied(await $.env.get('ANTHROPIC_BASE_URL')) && !heldOut(String(await $.session.id()), policy.holdout)
  await delegateSetup($)
  return `thinker is on for this session again: its hooks run.${route}`
}

export const register: Register = (on) => {
  for (const tool of ['Read', 'Bash']) on('tool.call', { tool }, async ($, e, next) => {
    let words: string | null = null
    try { words = await delegateCall($, e) } catch {}
    return words ? { deny: words } : next(e)
  })
  on('turn.start', async ($, e, next) => { if (!e.agentId) turn = { id: e.turnId, prompt: String(e.text || '') }; return next(e) })
  // The pointer sends the model to read a file outside every working directory, which Claude Code would put to the
  // person as a question. The grant is this mod's, not a rule in their settings (the owner's call, 2026-11-06): a Read
  // of a file right inside <THINKER_HOME>/tools is allowed here, only where the engine would have asked -- a deny rule
  // of the person's own still stands -- and it leaves with the mod.
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r?.decision !== 'ask' || (await $.env.get('THINKER_TEST')) === '1') return r
      if (isToolFile((e.input as any)?.file_path, await toolsDir($))) return { decision: 'allow', reason: 'thinker: the definition of a referenced tool' }
    } catch {}
    return r
  })

  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    try {
      if ((await $.env.get('THINKER_TEST')) === '1') return r
      const s = (await stubsOf($))[e.tool]
      if (!s?.file || !r?.description || r.description.includes(POINTER_OPENS)) return r
      try {
        let cur: any = null
        try { cur = JSON.parse(String(await $.fs.read(s.file))) } catch {}
        if (cur?.description !== r.description) await $.fs.write(s.file, JSON.stringify({ name: e.tool, description: r.description, input_schema: cur?.input_schema ?? {} }, null, 2) + '\n')
      } catch {}
      return { ...r, description: toolPointer(e.tool, s.file) }
    } catch { return r }
  })

  on('session.start', async ($, e, next) => {
    await delegateSetup($)
    const r = await next(e)
    try {
      const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
      let config: any = null
      try { config = JSON.parse(String(await $.fs.read(`${home}/config.json`))) } catch {}
      policy = policyOf(config)
      file = await stateFile($)
      try { state = JSON.parse(String(await $.fs.read(file))) } catch { state = null }
      const session = String(await $.session.id())
      const test = (await $.env.get('THINKER_TEST')) === '1'
      auto = policy.auto && !test && !proxied(await $.env.get('ANTHROPIC_BASE_URL')) && !heldOut(session, policy.holdout)
      $.command.register({ name: COMMAND, description: 'Clear old tool results from this conversation in place (thinker)' })
      $.command.register({ name: DISABLE, description: 'Turn thinker off for this session only: no proxy, no hooks' })
      $.command.register({ name: ENABLE, description: 'Turn thinker back on for this session' })
      // a session that was turned off stays off: resumed, it starts with the settings' route again
      off = await readOff($)
      if (off) await sessionOff($, off)
      // once per machine, in the desktop app, where there was no clearing before this mod: say so
      if (auto && (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop' && !(await $.store.get(INTRODUCED))) {
        await $.store.set(INTRODUCED, Date.now())
        $.ui.toast(INTRO)
      }
    } catch {}
    return r
  })

  // a request after a clear leaves the cleared tokens out: that is the saving, counted as the proxy counts it
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) { if (!inTurn) { inTurn = true; idle = lastTurnAt ? Date.now() - lastTurnAt : 0 } steps++ }
    const r = yield* next(e)
    if (!e.agentId && out > 0 && state) {
      const first = settle
      if (settle) {
        // what the API says left the prompt: the context before the clear less the context this request was
        // answered over (which carries the new prompt too, so this is a floor); thinking is the remainder
        settle = false
        const after = await contextTokens($)
        const k = state.kinds
        if (k && before > 0 && after > 0 && before - after > k.results + k.inputs) {
          k.total = before - after; k.thinking = k.total - k.results - k.inputs; k.measured = true
          out = k.total
          const last = state.recent[state.recent.length - 1]
          if (last) last.cleared = k.total
        }
      }
      state.requests++; state.saved += out; state.lastAt = Date.now()
      // and what this request cost: a prefix rewrite's write tokens on the first request after a clear, and the model that
      // answered, which is what prices them
      state.cost = charge(state.cost, r?.usage, first)
      if (r?.usage?.model) state.model = String(r.usage.model)
      await save($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    // a delegated read's subagent has answered: its report is the denied call's result (delegateCall)
    if (e.agentId) waiting.get(e.agentId)?.(e.isAborted ? null : e.answer || null)
    const r = await next(e)
    if (!e.agentId && auto && !pending) {
      try {
        const wasIdle = idle
        inTurn = false
        lastTurnAt = Date.now()
        const tokens = (await $.session.usage()).context.tokens ?? 0
        if (autoDue(tokens, policy, holdUntil)) {
          // Which rung, not whether the whole set pays (`chooseDepth`, 2026-11-13). The write a clear makes is
          // the context after the first row it changes, less what it drops, and that is priced per depth: a
          // clear reaching only the newest results rewrites almost nothing. `null` means no depth repays its
          // rewrite -- the refusal the proxy logs as `payback` -- and this door says nothing, as before.
          let model = ''; try { model = await $.session.model() } catch {}
          const rows = await liveMessages($)
          keepPatterns = await keepPatternsOf($)
          const depth = rows ? chooseDepth(rows, policy, { tokens, calls: steps, idle: wasIdle, cleared: clearedAt > 0, model, keep: keptOf(rows, keepPatterns) }) : null
          if (depth != null) { pendingDepth = depth; schedule($, 'auto', tokens) }
        }
      } catch {}
    }
    return r
  })

  // only a compaction this mod asked for is answered here; a typed /compact or an automatic one runs as it does
  on('session.compact', async ($, e, next) => {
    if (!pending || e.trigger === 'precompute') return next(e)
    const from = pendingFrom
    pending = false
    const chosen = pendingDepth; pendingDepth = null
    // the same kept set the depth was chosen against: a compact hook may not wait on a file, so the patterns are
    // the ones read when the clear was scheduled (a typed /thinker-clear reads them in `wouldClear`)
    const c = clearOld(e.messages, { ...policy, depth: chosen ?? Infinity, keep: keptOf(e.messages, keepPatterns) })
    if (!c.cleared || (from === 'auto' && c.tokens < policy.clearAtLeast)) {
      hold()
      return { skip: c.cleared ? `thinker-clear: ${c.tokens.toLocaleString()} tokens to clear, under ${policy.clearAtLeast.toLocaleString()}` : 'thinker-clear: nothing old enough to clear' }
    }
    const now = Date.now()
    clearedAt = now; holdUntil = 0
    before = (await contextTokens($)) || before
    out = c.tokens; uses = c.cleared; settle = true
    const kinds: Kinds = { results: c.resultTokens, inputs: c.inputTokens, thinking: 0, total: c.tokens, measured: false }
    state = {
      session: String(await $.session.id()),
      firstAt: state?.firstAt ?? now,
      lastAt: now,
      requests: state?.requests ?? 0,
      saved: state?.saved ?? 0,
      uses: (state?.uses ?? 0) + uses,
      tools: c.tools,
      recent: [...(state?.recent ?? []), { at: now, cleared: c.tokens, uses }].slice(-RECENT),
      kinds,
      // the policy this clear was made under, as the proxy stamps its own rows (policyId); a session that spans
      // an update carries the newest and says so, so a comparison can leave it out rather than read it as either
      policy: policyId(policy),
      ...(state?.policy && state.policy !== policyId(policy) ? { policyChanged: true } : state?.policyChanged ? { policyChanged: true } : {}),
      cost: state?.cost ?? { rewrites: 0, write: 0 },
      ...(state?.model ? { model: state.model } : {}),
      ...(state?.firstTurn != null ? { firstTurn: state.firstTurn } : {}),
      ...(state?.told ? { told: true } : {}),
    }
    await save($)
    if (from === 'manual') $.ui.toast(`thinker ${describe(c)}`)
    return { messages: c.messages }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: DISABLE }, async ($) => {
    try { return { text: await sessionOff($, off ?? await readOff($)) } } catch (err: any) { return { text: `${DISABLE}: ${String(err?.message || err).slice(0, 200)}` } }
  })
  on('command.run', { command: ENABLE }, async ($) => {
    try { return { text: await sessionOn($) } } catch (err: any) { return { text: `${ENABLE}: ${String(err?.message || err).slice(0, 200)}` } }
  })

  on('command.run', { command: COMMAND }, async ($) => {
    if (pending) return { text: 'thinker-clear: a clear is already on its way' }
    // asked for by hand: answer here rather than spending a turn on a compaction that would be refused
    if (!worthIt(await wouldClear($, policy), policy, 'manual')) return { text: 'thinker-clear: nothing old enough to clear' }
    schedule($, 'manual')
    return { text: 'thinker-clear: clearing old tool results in a moment (the engine\'s /compact, answered by thinker without a summary)' }
  })
}

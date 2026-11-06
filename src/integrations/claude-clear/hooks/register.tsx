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
export const CLEAR_AT_LEAST = 100000
export const KEEP_MIN = 3
export const HOLDOUT = 0.15
export const TOKENS_PER_CHAR = 1.44 / 4
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
// (`calls` made so far), outweighs the write after it (`recache`, the context after the first row it changes); free
// after a pause past the cache's hour. With the proxy's `clearDeep` off, one clear a session. `/thinker-clear` is
// never held back.
export const clearPays = (p: Policy, { dropped, recache, calls, idle, cleared, model = '' }: { dropped: number; recache: number; calls: number; idle: number; cleared: boolean; model?: string }) => {
  if (!(dropped > 0)) return false
  if (!p.clearDeep && cleared) return false
  if (idle >= COLD_MS) return true
  return dropped > 0 && writeRatio(model) * recache <= PAYBACK * dropped
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
export function clearOld(messages: readonly SessionMessage[], { keepMin = KEEP_MIN } = {}): Clear {
  const nameOf = new Map<string, string>()
  for (const m of messages) if (m.role === 'assistant') for (const u of m.toolUses ?? []) nameOf.set(u.tool_use_id, u.tool)
  const byTool = new Map<string, { calls: number; chars: number }>()
  let kept = 0, cleared = 0, chars = 0, inputChars = 0, rows = 0, inLatestTurn = true, firstChanged = -1
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
      cleared++; chars += text.length; touched = true
      const name = nameOf.get(r.tool_use_id) ?? 'tool'
      const t = byTool.get(name) ?? { calls: 0, chars: 0 }
      t.calls++; t.chars += text.length; byTool.set(name, t)
      return { tool_use_id: r.tool_use_id, text: placeholder(text.length), ...(r.isError ? { isError: true as const } : {}) }
    }).reverse()
    out.push(touched ? { role: 'user', text: m.text, toolUses: [], toolResults } : m)
    if (touched) firstChanged = i
  }
  out.reverse()
  // the rows before the first one a clear changes keep their place in the cache; what follows is written again
  const changedAt = firstChanged
  const charsOf = (m: SessionMessage) => { try { return (m.text ?? '').length + (m.toolResults ?? []).reduce((n, r) => n + (r.text ?? '').length, 0) + (m.toolUses ?? []).reduce((n, u) => n + JSON.stringify(u.input ?? {}).length, 0) } catch { return 0 } }
  const prefixChars = changedAt > 0 ? messages.slice(0, changedAt).reduce((n, m) => n + charsOf(m), 0) : 0
  const tools = [...byTool].map(([name, t]) => ({ name, calls: t.calls, tokens: Math.round(t.chars * TOKENS_PER_CHAR) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TOOLS)
  const resultTokens = Math.round(chars * TOKENS_PER_CHAR), inputTokens = Math.round(inputChars * TOKENS_PER_CHAR)
  return { messages: out, cleared, chars: chars + inputChars, tokens: resultTokens + inputTokens, resultTokens, inputTokens, rows, prefixChars, tools }
}

// The record the proxy writes (compression.js:noteCompression): `saved` adds up over the requests that leave
// the cleared tokens out, `uses` and `tools` describe what is out of the prompt now.
// `kinds` is this door's own: the latest clear by what left the prompt, in tokens. `results` and `inputs` are
// estimated from the text; `thinking` is what the measured whole leaves once those are taken out, and
// `measured` says whether the whole came from the API's context figures (before the clear, and on the first
// request after it) or is the estimate alone.
export type Kinds = { results: number; inputs: number; thinking: number; total: number; measured: boolean }
export type State = { session: string; firstAt: number; lastAt: number; requests: number; saved: number; uses: number; tools?: Clear['tools']; recent: { at: number; cleared: number; uses: number }[]; kinds?: Kinds; firstTurn?: number; told?: boolean }

// module state: starts over on a reload (the record on disk does not)
let policy: Policy = DEFAULTS
let auto = false
let pending = false
let pendingFrom = ''
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
async function wouldClear($: any, p: Policy): Promise<Clear | null> {
  try {
    const api = await $.session.messages({ as: 'api' })
    return Array.isArray(api) ? clearOld(liveRows(api), p) : null
  } catch { return null }
}

// enough to be worth a compaction turn: `clearAtLeast` for the automatic clear, anything at all by hand
// (a transcript that cannot be read lets a hand-run clear try, never the automatic one)
export const worthIt = (c: Clear | null, p: Policy, from: string) =>
  !c ? from !== 'auto' : c.cleared > 0 && (from !== 'auto' || c.tokens >= p.clearAtLeast)

// The latch behind the check: an automatic attempt that did not clear (refused by the hook, or never taken
// over) holds the next one until the context has grown by another `clearAtLeast`. However the check and the
// compaction come to disagree again, the most the person sees is one line per 100k of new context, never one
// per turn. A clear that went through lifts it.
export const autoDue = (tokens: number, p: Policy, holdUntil: number) => tokens >= p.trigger && tokens >= holdUntil

const hold = () => { if (pendingFrom === 'auto') holdUntil = attemptAt + policy.clearAtLeast }

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

export const register: Register = (on) => {
  // The pointer sends the model to read a file outside every working directory, which Claude Code would put to the
  // person as a question. The grant is this mod's, not a rule in their settings (the owner's call, 2026-11-06): a Read
  // of a file right inside <THINKER_HOME>/tools is allowed here, only where the engine would have asked -- a deny rule
  // of the person's own still stands -- and it leaves with the mod.
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r?.decision !== 'ask' || (await $.env.get('THINKER_TEST')) === '1') return r
      if (isToolFile((e.input as any)?.file_path, await toolsDir($))) return { decision: 'allow', reason: 'thinker: the definition of a tool moved to disk' }
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
      await save($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && auto && !pending) {
      try {
        const wasIdle = idle
        inTurn = false
        lastTurnAt = Date.now()
        const tokens = (await $.session.usage()).context.tokens ?? 0
        if (autoDue(tokens, policy, holdUntil)) {
          const c = await wouldClear($, policy)
          // the write a clear would make: the context after the first row it changes, less what it drops
          const recache = c ? Math.max(0, tokens - Math.round(c.prefixChars * TOKENS_PER_CHAR) - c.tokens) : 0
          // nothing worth clearing yet, or a write the session's remaining calls would not repay: say nothing
          let model = ''; try { model = await $.session.model() } catch {}
          if (c && worthIt(c, policy, 'auto') && clearPays(policy, { dropped: c.tokens, recache, calls: steps, idle: wasIdle, cleared: clearedAt > 0, model })) schedule($, 'auto', tokens)
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
    const c = clearOld(e.messages, policy)
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
      ...(state?.firstTurn != null ? { firstTurn: state.firstTurn } : {}),
      ...(state?.told ? { told: true } : {}),
    }
    await save($)
    if (from === 'manual') $.ui.toast(`thinker ${describe(c)}`)
    return { messages: c.messages }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($) => {
    if (pending) return { text: 'thinker-clear: a clear is already on its way' }
    // asked for by hand: answer here rather than spending a turn on a compaction that would be refused
    if (!worthIt(await wouldClear($, policy), policy, 'manual')) return { text: 'thinker-clear: nothing old enough to clear' }
    schedule($, 'manual')
    return { text: 'thinker-clear: clearing old tool results in a moment (the engine\'s /compact, answered by thinker without a summary)' }
  })
}

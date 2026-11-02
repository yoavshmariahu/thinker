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
// a skipped attempt is not made again until the context has grown this much
export const RETRY_GROWTH = 20000
// Clear once and hold, as the proxy does (proxy.js:DEEP_MARGIN, FROZEN_OFFSET, COLD_MS; on by default from 0.2.19,
// the owner's decision 2026-11-02). There the depth is an ask the API meets and the block is the server's, which
// extends it at every turn boundary, so the keep is frozen to pin it. Here there is no server-side block: `clearOld`
// already takes everything before the newest turn, so a desktop clear is deep by construction -- what it lacked is
// the holding. Each clear rewrites the conversation in place at a compaction boundary, and the whole prompt after it
// is written to the cache again at the 1h rate; clearing again every RETRY_GROWTH of growth paid that rewrite over
// and over, which is what the replay found a per-turn policy loses on (-24% to -50% at list, against +4% to +12%
// for one clear held). So one automatic clear per cached stretch, and a pause past the cache's hour lets it go: that
// request writes its context whatever this mod does, so the next clear is free. `/thinker-clear` is never held back.
export const COLD_MS = 65 * 60 * 1000
export const DELAY_MS = 1500
export const COMMAND = 'thinker-clear'
export const INTRODUCED = 'thinker-clear:introduced'
export const INTRO = 'thinker now clears old tool results, call text and earlier thinking in Claude Desktop sessions too, as it does in the terminal: the card under an answer shows what it saved. /thinker-clear runs one by hand.'
export const TOP_TOOLS = 3
export const RECENT = 8
export const placeholder = (chars: number) =>
  `[tool result cleared by thinker to save context: ${chars} chars. Read the file or run the command again if you need it.]`

export type Policy = { keepMin: number; clearAtLeast: number; trigger: number; holdout: number; auto: boolean; clearInputs: boolean; clearThinking: boolean; clearDeep: boolean }
export const DEFAULTS: Policy = { keepMin: KEEP_MIN, clearAtLeast: CLEAR_AT_LEAST, trigger: TRIGGER, holdout: HOLDOUT, auto: true, clearInputs: true, clearThinking: true, clearDeep: true }

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
    // on by default as the proxy's are (proxy-service.js:serviceArgs); false in the config keeps each off
    clearInputs: p.clearInputs !== false,
    clearThinking: p.clearThinking !== false,
    // the same key the proxy reads (proxy.js:PROXY_DEFAULTS, on by default since 0.2.19): one clear, then held
    clearDeep: p.clearDeep !== false,
  }
}

// Whether the block this session already cleared is still held: one automatic clear per cached stretch, let go
// after a pause past the cache's hour (proxy.js:COLD_MS, where a cold request rewrites its context anyway).
// `clearedAt` is 0 until the first clear of the session; `sinceTurn` is the gap before the turn just finished.
export const holdsBlock = (p: Policy, { clearedAt, sinceTurn }: { clearedAt: number; sinceTurn: number }) =>
  p.clearDeep && clearedAt > 0 && sinceTurn < COLD_MS

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

export type Clear = { messages: SessionMessage[]; cleared: number; chars: number; tokens: number; resultTokens: number; inputTokens: number; rows: number; tools: { name: string; calls: number; tokens: number }[] }

// The proxy's `keep: turn` (proxy.js): every result of the newest prompt's turn stays, and at least `keepMin`
// results in all; every older result worth a placeholder is replaced. A user row that carries results is
// rebuilt without its handle, so the engine builds it from the blocks. With `clearInputs` or `clearThinking`
// the assistant rows before the newest turn are rebuilt too, once a result is cleared (the proxy's
// piggyback): without a handle the row carries no thinking, and with `clearInputs` its tool calls carry no
// arguments. The newest turn stands as the engine has it, its thinking included, which is what the API
// requires of the turn in progress. `chars` and `tokens` estimate the results and the emptied call text, kept
// apart as `resultTokens` and `inputTokens`; the thinking a rebuilt row sheds is not in a SessionMessage, so
// its share is measured after the fact, from the context sizes the API reports (the `kinds` of the record).
export function clearOld(messages: readonly SessionMessage[], { keepMin = KEEP_MIN, clearInputs = true, clearThinking = true } = {}): Clear {
  const nameOf = new Map<string, string>()
  for (const m of messages) if (m.role === 'assistant') for (const u of m.toolUses ?? []) nameOf.set(u.tool_use_id, u.tool)
  const byTool = new Map<string, { calls: number; chars: number }>()
  let kept = 0, cleared = 0, chars = 0, inputChars = 0, rows = 0, inLatestTurn = true
  const out: SessionMessage[] = []
  const older: number[] = []   // positions in `out` of assistant rows before the newest turn
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const rs = m.role === 'user' ? m.toolResults ?? [] : []
    if (!rs.length) {
      // a prompt row ends the newest turn, seen from the end
      if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false
      if (m.role === 'assistant' && !inLatestTurn && m.handle) older.push(out.length)
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
  }
  if (cleared && (clearInputs || clearThinking)) {
    for (const at of older) {
      const m = out[at]
      rows++
      const toolUses = (m.toolUses ?? []).map(u => {
        if (!clearInputs) return { tool_use_id: u.tool_use_id, tool: u.tool, input: u.input }
        inputChars += JSON.stringify(u.input ?? {}).length
        return { tool_use_id: u.tool_use_id, tool: u.tool, input: {} }
      })
      out[at] = { role: 'assistant', text: m.text, toolUses } as SessionMessage
    }
  }
  out.reverse()
  const tools = [...byTool].map(([name, t]) => ({ name, calls: t.calls, tokens: Math.round(t.chars * TOKENS_PER_CHAR) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TOOLS)
  const resultTokens = Math.round(chars * TOKENS_PER_CHAR), inputTokens = Math.round(inputChars * TOKENS_PER_CHAR)
  return { messages: out, cleared, chars: chars + inputChars, tokens: resultTokens + inputTokens, resultTokens, inputTokens, rows, tools }
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
let lastTried = 0
let clearedAt = 0    // when this session last cleared; the block is held from then (holdsBlock)
let lastTurnAt = 0   // the previous turn's end, to see a pause past the cache's hour
let out = 0          // tokens out of the prompt now, added to `saved` on every request
let before = 0       // the context as the API last reported it, taken as the clear is scheduled and again as it runs
let settle = false   // the first request after a clear sizes it for real
let uses = 0
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

// What a clear would take right now, read from the conversation before anything is started. The engine
// prints a skipped compaction under the answer ("not compacted: <reason>"), so an attempt that was never
// going to clear enough became a line in the session every time the context grew past the trigger again
// (reported from a desktop session, 2026-11-02). Checking first means the automatic clear says nothing at
// all until it has something to do, and no turn is spent on a compaction that gets refused. Returns null
// where the transcript cannot be read, which leaves the old behavior: schedule, and let the skip stand.
async function wouldClear($: any, p: Policy): Promise<Clear | null> {
  try { return clearOld((await $.session.messages()) as any, p) } catch { return null }
}

// enough to be worth a compaction turn: `clearAtLeast` for the automatic clear, anything at all by hand
export const worthIt = (c: Clear | null, p: Policy, from: string) =>
  !c || (c.cleared > 0 && (from !== 'auto' || c.tokens >= p.clearAtLeast))

function schedule($: any, from: string) {
  pending = true; pendingFrom = from
  void contextTokens($).then(t => { if (t) before = t })
  $.clock.after(DELAY_MS, async () => {
    try {
      await $.command.run({ command: 'compact' })
      if (pending) { pending = false; $.ui.toast('thinker-clear: /compact ran but this mod did not take it over') }
    } catch (err) {
      pending = false
      $.ui.toast(`thinker-clear: could not run /compact (${String((err as any)?.message ?? err)})`)
    }
  })
}

export const register: Register = (on) => {
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
        const now = Date.now()
        const sinceTurn = lastTurnAt ? now - lastTurnAt : 0
        lastTurnAt = now
        // this session has cleared and the cache is still warm: hold the block, and say nothing
        if (holdsBlock(policy, { clearedAt, sinceTurn })) return r
        // the cache went cold: that request writes its context anyway, so the block goes and a clear is free again
        if (clearedAt && sinceTurn >= COLD_MS) { clearedAt = 0; lastTried = 0 }
        const tokens = (await $.session.usage()).context.tokens ?? 0
        if (tokens >= policy.trigger && tokens >= lastTried + RETRY_GROWTH) {
          lastTried = tokens
          // nothing worth clearing yet: wait for the context to grow, and say nothing in the meantime
          if (worthIt(await wouldClear($, policy), policy, 'auto')) schedule($, 'auto')
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
      return { skip: c.cleared ? `thinker-clear: ${c.tokens.toLocaleString()} tokens to clear, under ${policy.clearAtLeast.toLocaleString()}` : 'thinker-clear: nothing old enough to clear' }
    }
    const now = Date.now()
    clearedAt = now
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

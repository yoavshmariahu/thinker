// The desktop door of thinker's context clearing. The context proxy (src/proxy.js) clears old tool results
// server-side through ANTHROPIC_BASE_URL, and the Claude desktop app sets that variable itself, so its
// sessions never reach the proxy (2026-11-01). This mod runs inside the session instead: when the context
// passes the proxy's trigger it queues the engine's own /compact and answers that compaction itself, the
// old tool results replaced in place by a short placeholder, no summary written, every assistant row kept
// whole so its thinking stands. To the engine a desktop session is headless, where compaction only runs as
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
export const DELAY_MS = 1500
export const COMMAND = 'thinker-clear'
export const TOP_TOOLS = 3
export const RECENT = 8
export const placeholder = (chars: number) =>
  `[tool result cleared by thinker to save context: ${chars} chars. Read the file or run the command again if you need it.]`

export type Policy = { keepMin: number; clearAtLeast: number; trigger: number; holdout: number; auto: boolean }
export const DEFAULTS: Policy = { keepMin: KEEP_MIN, clearAtLeast: CLEAR_AT_LEAST, trigger: TRIGGER, holdout: HOLDOUT, auto: true }

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
  }
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

export type Clear = { messages: SessionMessage[]; cleared: number; chars: number; tokens: number; tools: { name: string; calls: number; tokens: number }[] }

// The proxy's `keep: turn` (proxy.js): every result of the newest prompt's turn stays, and at least `keepMin`
// results in all; every older result worth a placeholder is replaced. A user row that carries results is
// rebuilt without its handle, so the engine builds it from the blocks; every other row, the assistant's
// above all, keeps its handle and stands as the engine has it, thinking included.
export function clearOld(messages: readonly SessionMessage[], { keepMin = KEEP_MIN } = {}): Clear {
  const nameOf = new Map<string, string>()
  for (const m of messages) if (m.role === 'assistant') for (const u of m.toolUses ?? []) nameOf.set(u.tool_use_id, u.tool)
  const byTool = new Map<string, { calls: number; chars: number }>()
  let kept = 0, cleared = 0, chars = 0, inLatestTurn = true
  const out: SessionMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const rs = m.role === 'user' ? m.toolResults ?? [] : []
    if (!rs.length) {
      // a prompt row ends the newest turn, seen from the end
      if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false
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
  out.reverse()
  const tools = [...byTool].map(([name, t]) => ({ name, calls: t.calls, tokens: Math.round(t.chars * TOKENS_PER_CHAR) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TOOLS)
  return { messages: out, cleared, chars, tokens: Math.round(chars * TOKENS_PER_CHAR), tools }
}

// The record the proxy writes (compression.js:noteCompression): `saved` adds up over the requests that leave
// the cleared tokens out, `uses` and `tools` describe what is out of the prompt now.
export type State = { session: string; firstAt: number; lastAt: number; requests: number; saved: number; uses: number; tools?: Clear['tools']; recent: { at: number; cleared: number; uses: number }[]; firstTurn?: number; told?: boolean }

// module state: starts over on a reload (the record on disk does not)
let policy: Policy = DEFAULTS
let auto = false
let pending = false
let pendingFrom = ''
let lastTried = 0
let out = 0          // tokens out of the prompt now, added to `saved` on every request
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

const describe = (c: { cleared: number; tokens: number }) => `cleared ${c.cleared} tool ${c.cleared === 1 ? 'result' : 'results'}, ${c.tokens.toLocaleString()} tokens`

function schedule($: any, from: string) {
  pending = true; pendingFrom = from
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
    } catch {}
    return r
  })

  // a request after a clear leaves the cleared tokens out: that is the saving, counted as the proxy counts it
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!e.agentId && out > 0 && state) {
      state.requests++; state.saved += out; state.lastAt = Date.now()
      await save($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && auto && !pending) {
      try {
        const tokens = (await $.session.usage()).context.tokens ?? 0
        if (tokens >= policy.trigger && tokens >= lastTried + RETRY_GROWTH) { lastTried = tokens; schedule($, 'auto') }
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
    out = c.tokens; uses = c.cleared
    state = {
      session: String(await $.session.id()),
      firstAt: state?.firstAt ?? now,
      lastAt: now,
      requests: state?.requests ?? 0,
      saved: state?.saved ?? 0,
      uses: (state?.uses ?? 0) + uses,
      tools: c.tools,
      recent: [...(state?.recent ?? []), { at: now, cleared: c.tokens, uses }].slice(-RECENT),
      ...(state?.firstTurn != null ? { firstTurn: state.firstTurn } : {}),
      ...(state?.told ? { told: true } : {}),
    }
    await save($)
    $.ui.toast(`thinker ${describe(c)}`)
    return { messages: c.messages }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($) => {
    if (pending) return { text: 'thinker-clear: a clear is already on its way' }
    schedule($, 'manual')
    return { text: 'thinker-clear: clearing old tool results in a moment (the engine\'s /compact, answered by thinker without a summary)' }
  })
}

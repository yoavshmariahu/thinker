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

// Nothing about WHETHER to clear, or WHAT, is decided in this file (2026-11-18). It used to carry its own copy of
// the proxy's policy -- the trigger, the size floor, the payback, the read rates, the token count, the keep list --
// because a mod has no import, and a session keeps the mod it loaded at its start: one opened under an old release
// went on clearing by that release's rules for days after the machine had updated, and that is where the fleet's
// losing sessions were. The mod now asks the installed CLI at each decision (`ask`, below) and does what it is told.
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
export const RECENT = 8
// --- what to clear is the installed thinker's answer --------------------------------------------------------
// The question goes to the CLI the settings' hooks name (`thinker hook clear`, src/clear-door.js), which an update
// replaces, so the answer is always the installed release's. `ask` resolves null where there is no answer -- no
// CLI found, the hooks off for this session, a timeout, a crash -- and every caller reads that as "leave it alone":
// a clear not made costs the saving it would have made and nothing else.
export type Tools = { name: string; calls: number; tokens: number }[]
export type Plan = { replace: Record<string, string>; cleared: number; chars: number; tokens: number; resultTokens: number; inputTokens: number; rows: number; tools: Tools; policy?: string }
export const CLEAR_TIMEOUT_MS = 20_000
export const ASK_EVERY = 10
// what the answer is computed from, and no more of a row than that: the handle and the rest stay here
export const slim = (messages: readonly SessionMessage[]) => messages.map(m => ({
  role: m.role, text: m.text ?? '',
  toolUses: (m.toolUses ?? []).map(u => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input })),
  ...(m.toolResults?.length ? { toolResults: m.toolResults.map(r => ({ tool_use_id: r.tool_use_id, text: r.text ?? '', ...(r.isError ? { isError: true } : {}) })) } : {}),
}))
export const answerOf = (stdout: string): any | null => {
  try { const j = JSON.parse(String(stdout || '').trim().split('\n').pop() || ''); return j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length ? j : null } catch { return null }
}
async function ask($: any, ev: Record<string, unknown>): Promise<any | null> {
  if (!cli) return null
  try {
    const stdin = JSON.stringify({ ...ev, session: String(await $.session.id()), baseUrl: (await $.env.get('ANTHROPIC_BASE_URL')) || '', test: (await $.env.get('THINKER_TEST')) === '1' })
    const r = await $.process.run(['node', cli, 'hook', 'clear', '--client', 'claude', '--user'], { stdin, timeoutMs: CLEAR_TIMEOUT_MS })
    return r.exitCode === 0 ? answerOf(String(r.stdout || '')) : null
  } catch { return null }
}
// The answer put in place: each named result becomes its placeholder and nothing else of any row changes, so
// every call keeps its arguments and every untouched row is the very row the engine handed over.
export function applyPlan(messages: readonly SessionMessage[], replace: Record<string, string>): SessionMessage[] {
  return messages.map(m => {
    const rs = m.role === 'user' ? m.toolResults ?? [] : []
    if (!rs.some(r => Object.hasOwn(replace, r.tool_use_id))) return m
    return { role: 'user', text: m.text, toolUses: [], toolResults: rs.map(r => Object.hasOwn(replace, r.tool_use_id) ? { tool_use_id: r.tool_use_id, text: replace[r.tool_use_id], ...(r.isError ? { isError: true as const } : {}) } : r) } as SessionMessage
  })
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
export type State = { session: string; firstAt: number; lastAt: number; requests: number; saved: number; uses: number; policy?: string; policyChanged?: boolean; tools?: Tools; recent: { at: number; cleared: number; uses: number }[]; kinds?: Kinds; cost?: Cost; model?: string; firstTurn?: number; told?: boolean }

// module state: starts over on a reload (the record on disk does not)
let askAt = 0        // the context to ask the installed thinker again at (its trigger, once it has answered)
let sinceAsked = 0   // turns since it was last asked: it is asked every ASK_EVERY whatever the context
let holdGrowth = 60000
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
let holdUntil = 0    // no automatic attempt below this context (clear-door.js:autoDue)
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

const describe = (c: Plan) => `cleared ${c.cleared} tool ${c.cleared === 1 ? 'result' : 'results'} and ${c.rows} earlier ${c.rows === 1 ? 'turn' : 'turns'}' call text and thinking, ${c.tokens.toLocaleString()} tokens`

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

// The latch behind the check: an automatic attempt that did not clear (refused by the answer, or never taken
// over) holds the next one until the context has grown by what the installed thinker says (clear-door.js:
// HOLD_GROWTH, which carries why it is not the size floor). However the check and the compaction come to
// disagree, the most the person sees is one line per that much new context, never one per turn. A clear that
// went through lifts it.
const hold = () => { if (pendingFrom === 'auto') holdUntil = attemptAt + holdGrowth }

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
async function findCli($: any) {
  try {
    cli = (await $.env.get('THINKER_CLI')) || null
    if (!cli) {
      const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
      try { cli = cliOf(JSON.parse(String(await $.fs.read(`${dir}/settings.json`)))) } catch {}
    }
  } catch { cli = null }
}
async function delegateSetup($: any) {
  delegating = false
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    let config: any = null
    try { config = JSON.parse(String(await $.fs.read(`${home}/config.json`))) } catch {}
    if (!delegateOn(await $.env.get('THINKER_DELEGATE'), config)) return
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
  askAt = 0
  auto = !!(await ask($, { op: 'start' }))?.auto
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
    await findCli($)
    await delegateSetup($)
    const r = await next(e)
    try {
      file = await stateFile($)
      try { state = JSON.parse(String(await $.fs.read(file))) } catch { state = null }
      $.command.register({ name: COMMAND, description: 'Clear old tool results from this conversation in place (thinker)' })
      $.command.register({ name: DISABLE, description: 'Turn thinker off for this session only: no proxy, no hooks' })
      $.command.register({ name: ENABLE, description: 'Turn thinker back on for this session' })
      // a session that was turned off stays off: resumed, it starts with the settings' route again
      off = await readOff($)
      if (off) await sessionOff($, off)
      else auto = !!(await ask($, { op: 'start' }))?.auto
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
    // a subagent this mod started has answered: hand its report to the call that is waiting on it
    if (e.agentId) waiting.get(e.agentId)?.(e.isAborted ? null : e.answer || null)
    const r = await next(e)
    if (!e.agentId && !off && !pending) {
      try {
        const wasIdle = idle
        inTurn = false
        lastTurnAt = Date.now()
        const tokens = (await $.session.usage()).context.tokens ?? 0
        // Asked once the context is where the last answer said to ask again (the trigger, or past a hold), and
        // every ASK_EVERY turns regardless, without the conversation: the installed thinker may have changed
        // since, and its trigger with it. The conversation goes only with a question that can end in a clear.
        const due = tokens >= askAt
        if (due || ++sinceAsked >= ASK_EVERY) {
          sinceAsked = 0
          let model = ''; try { model = await $.session.model() } catch {}
          const rows = due ? await liveMessages($) : null
          const a = await ask($, { op: 'decide', from: 'auto', messages: rows ? slim(rows) : null, tokens, idle: wasIdle, cleared: clearedAt > 0, holdUntil, model })
          if (a) {
            if (typeof a.askAt === 'number') askAt = a.askAt
            if (typeof a.hold === 'number') holdGrowth = a.hold
            // the rung the answer chose is the one the compaction takes: an automatic clear that would be refused is never started
            if (a.clear && a.depth != null) { pendingDepth = a.depth; schedule($, 'auto', tokens) }
          }
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
    // which results go, and what stands in their place, is the installed thinker's answer (clear-door.js): the
    // rules of the release on this machine now, not of the one this session was opened under
    const c: (Plan & { skip?: string }) | null = await ask($, { op: 'apply', from, depth: chosen, messages: slim(e.messages) })
    if (!c || c.skip || !c.cleared || !c.replace) {
      hold()
      return { skip: c?.skip || 'thinker-clear: thinker could not be asked what to clear' }
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
      // the policy this clear was made under, as the answer names it (cutting.js:policyId, the version of the
      // thinker that decided); a session that spans two says so, and no comparison folds it into either
      ...(c.policy ? { policy: c.policy } : state?.policy ? { policy: state.policy } : {}),
      ...(state?.policy && c.policy && state.policy !== c.policy ? { policyChanged: true } : state?.policyChanged ? { policyChanged: true } : {}),
      cost: state?.cost ?? { rewrites: 0, write: 0 },
      ...(state?.model ? { model: state.model } : {}),
      ...(state?.firstTurn != null ? { firstTurn: state.firstTurn } : {}),
      ...(state?.told ? { told: true } : {}),
    }
    await save($)
    if (from === 'manual') $.ui.toast(`thinker ${describe(c)}`)
    return { messages: applyPlan(e.messages, c.replace) }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: DISABLE }, async ($) => {
    try { return { text: await sessionOff($, off ?? await readOff($)) } } catch (err: any) { return { text: `${DISABLE}: ${String(err?.message || err).slice(0, 200)}` } }
  })
  on('command.run', { command: ENABLE }, async ($) => {
    try { return { text: await sessionOn($) } } catch (err: any) { return { text: `${ENABLE}: ${String(err?.message || err).slice(0, 200)}` } }
  })

  on('command.run', { command: COMMAND }, async ($) => {
    if (pending) return { text: 'thinker-clear: a clear is already on its way' }
    // asked first, so a clear the compaction would refuse is never started and the engine prints no skip line
    const rows = await liveMessages($)
    const a = await ask($, { op: 'decide', from: 'manual', messages: rows ? slim(rows) : null })
    if (!a) return { text: 'thinker-clear: thinker could not be asked what to clear (is it connected, and on in this session?)' }
    if (!a.clear) return { text: 'thinker-clear: nothing old enough to clear' }
    schedule($, 'manual')
    return { text: 'thinker-clear: clearing old tool results in a moment (the engine\'s /compact, answered by thinker without a summary)' }
  })
}

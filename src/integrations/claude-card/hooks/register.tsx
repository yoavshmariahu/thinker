// The Claude Code side of thinker's cache-hit card (the Codex desktop card is src/notice-card.js).
// thinker's hooks hand their notes to the model as text; this mod reads them as the session keeps
// them, and draws a card under the answer of each turn that was served notes. The card is kept by
// the end of that answer's text, so it is drawn again whenever the transcript is, the session
// reopened included. `thinker connect` names this folder in CLAUDE_CODE_PLUGIN_DIRS
// (clients.js:claudeCardDir); a session this mod runs in is marked under thinker's home, and the
// Stop hook leaves its own collapsed cache-hit line out there (claude-card.js:claudeCardActive).
//
// It also pins what thinker has saved -- today and over the whole log -- as this plugin's status line
// under the prompt, which is the one surface that can keep a figure on screen instead of saying it
// once and scrolling away. That is why Claude Code's footer is here and not in the Stop hook's line:
// the figures are a running total, so they belong somewhere permanent, and the hook leaves them out
// where this mod runs (commands/hooks.js). The numbers are read off the ledger thinker's hooks keep
// refreshed (src/savings-ledger.js) -- this mod only ever reads one small file.
import type { Register } from 'claude-code'

export type Note = { title: string; id: string }
export type Tool = { name: string; calls: number; tokens: number }
export type Saving = { saved: number; requests: number; uses: number; tools: Tool[] }
export type Card = { tail: string; titles: string[]; tokens: number; at: number; prompts?: number; compression?: Saving }
// the kept ledger, as src/savings-ledger.js writes it
export type Cell = { cost: number; tokens: number; unpricedTokens?: number }
export type Ledger = { at: number; day: string; today: Cell; lifetime: Cell }

// Each served note is headed `### [kind] Title  (id: …)` inside a `<thinker-cache>` block; the titles
// listed under "Other cached titles" were not served.
export function servedNotes(texts: readonly string[] | undefined): Note[] {
  const notes: Note[] = []
  for (const c of texts ?? []) {
    for (const block of c.match(/<thinker-cache>[\s\S]*?<\/thinker-cache>/g) ?? []) {
      for (const m of block.matchAll(/^### \[[^\]]+\] (.+?)\s+\(id: ([^,)\s]+)/gm)) notes.push({ title: m[1], id: m[2] })
    }
  }
  return notes
}

// every string inside a value, however a row nests its content
export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

// A title is often a headline and its explanation; the card shows the headline.
export function shortTitle(title: string): string {
  const m = title.match(/^(.{3,}?)(?::\s|;\s|\s—\s|\s--\s)/)
  const head = (m ? m[1] : title).trim()
  return head.length > 80 ? head.slice(0, 79).trimEnd() + '…' : head
}

// thinker's estimate, as usage.js:cacheHitSavings makes it (test/claude-card.test.js holds the two
// together): one read per file a note rests on, at most MAX_FILES a note, each file once, its size
// / 3.6 tokens capped at FILE_CAP; agent configuration and build output count nothing.
export const MAX_FILES = 5
export const FILE_CAP = 6000
export const NOT_READING = /^(\.claude|\.codex|\.cursor|\.gemini|\.pi|\.windsurf|\.devin|\.opencode|\.vscode|\.idea|\.factory|\.qwen|\.kiro|\.clinerules|\.cline|\.kilo|\.kilocode|\.augment|\.goose|\.git|\.thinker|node_modules|dist|coverage)\/|^\.github\/(hooks|instructions)\/|^\.mcp\.json$|^bench\/runs\/|\.log$/
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n)}`
}

// A dollar figure for people, as prices.js:formatDollars writes it; the mod has its own copy because
// it runs inside Claude Code, and test/claude-card.test.js holds the two texts together.
export function formatDollars(d: number): string {
  if (d == null || !Number.isFinite(d)) return '–'
  const a = Math.abs(d), s = d < 0 ? '−' : ''
  if (a >= 10000) return `${s}$${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (a >= 100) return `${s}$${Math.round(a)}`
  if (a >= 10) return `${s}$${a.toFixed(1)}`
  if (a >= 0.01 || a === 0) return `${s}$${a.toFixed(2)}`
  return `${s}$${a.toFixed(3)}`
}

// The checkout whose cache holds the notes: a linked worktree's `.git` is a file naming the main
// checkout's git directory, and the worktree uses the main checkout's cache (store.js).
async function cacheRoot($: any): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  const root: string = repo?.root ?? (await $.session.cwd())
  try {
    const m = String(await $.fs.read(`${root}/.git`)).match(/^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m)
    if (m) return m[1]
  } catch {}
  return root
}

async function estimate($: any, ids: readonly string[]): Promise<number> {
  const root = await cacheRoot($)
  const seen = new Set<string>()
  let tokens = 0
  for (const id of ids) {
    let deps: { path?: string }[] = []
    for (const dir of ['.thinker/local/notes', '.thinker/notes']) {
      try { deps = JSON.parse(String(await $.fs.read(`${root}/${dir}/${id}.json`))).deps ?? []; break } catch {}
    }
    for (const f of [...new Set(deps.map(d => d.path).filter((x): x is string => !!x))].slice(0, MAX_FILES)) {
      if (seen.has(f) || NOT_READING.test(f)) continue
      seen.add(f)
      try { const st = await $.fs.stat(`${root}/${f}`); if (st.kind === 'file') tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP) } catch {}
    }
  }
  return tokens
}

// The Stop hook reads this mark to leave its collapsed line out of a session that shows the card.
async function markSession($: any): Promise<void> {
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
    if (id) await $.fs.write(`${home}/state/claude-card/${id}`, '')
  } catch {}
}

export const cardHeader = (n: number, tokens: number, prompts = 0) =>
  `${n} ${n === 1 ? 'note' : 'notes'} ${prompts > 1 ? `over the last ${prompts} prompts` : 'this turn'}${tokens ? ` · Estimated tokens saved: ~${formatTokens(tokens)}` : ''}`

// The status line's words, as src/savings-ledger.js:savingsStatus writes them (test/claude-card.test.js
// holds the two sentences together). Both figures are already formatted; `today` is null when the kept
// ledger's day is not this one, since a figure stamped yesterday is not what was saved this morning.
export const savingsStatus = (today: string | null, lifetime: string) =>
  `🧠 ${today ? `saved today ~${today} · ` : ''}lifetime ~${lifetime}`

// How many cells a string takes on a terminal row: a wide glyph (emoji, CJK) takes two, so a line
// measured by `length` alone would be padded one cell too far and lose its last character.
export const cells = (s: string): number => {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u.test(ch) ? 2 : 1
  return n
}

// The figures on the status line's own row, flush with its right edge: the engine draws the tail
// straight after its own line, so the padding is the row less what the engine's line takes and what
// the figures take, and the last character of the line lands in the last cell of the row. Where the
// row cannot hold both, the figures follow the engine's line after one space and the engine cuts what
// does not fit (and leaves the tail out entirely under four columns).
//
// `hint` is the engine's line as it draws it, which is the only width there is to go on: a surface
// whose drawn line is narrower than the string it hands over leaves a gap, never an overflow.
export const statusTail = (hint: string, line: string, columns: number): string => {
  const room = columns - cells(hint) - cells(line)
  return room > 1 ? ' '.repeat(room) + line : ` ${line}`
}

// The person's own day, in their own timezone, as the ledger stamps it (savings-ledger.js:dayKey).
export const dayKey = (now: number): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const thinkerHome = async ($: any): Promise<string> => (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`

// Switched-off notices switch the status line off too (commands/hooks.js:noticeOn holds the same rule):
// a person who asked thinker to be quiet did not ask for a figure pinned under their prompt for ever.
async function noticeOn($: any): Promise<boolean> {
  if ((await $.env.get('THINKER_NOTICE')) === 'off') return false
  try {
    const cfg = JSON.parse(String(await $.fs.read(`${await cacheRoot($)}/.thinker/config.json`)))
    return cfg.notice !== false && cfg.notice !== 'off'
  } catch { return true }   // no config, or none readable: the notices are on by default
}

// What the hooks keep in the ledger, or null when there is none yet (a fresh install, before the
// first refresh has run) or when it holds nothing worth saying.
async function savings($: any, { now = Date.now() } = {}): Promise<string> {
  if (!(await noticeOn($))) return ''
  let l: Ledger
  try { l = JSON.parse(String(await $.fs.read(`${await thinkerHome($)}/state/savings.json`))) } catch { return '' }
  if (!l?.lifetime || (!l.lifetime.tokens && !l.lifetime.unpricedTokens)) return ''
  const today = l.day === dayKey(now) && Number.isFinite(l.today?.cost) ? formatDollars(l.today.cost) : null
  return savingsStatus(today, formatDollars(l.lifetime.cost))
}

// The line currently on screen, kept here because a `ui.render` hook draws on every frame and must
// never read a file: the reads happen at the start of the session and at the end of each turn, and a
// changed line asks for a redraw.
let line = ''

// Read the ledger and, if it says something new, have the band drawn again.
async function readSavings($: any): Promise<void> {
  try {
    const next = await savings($)
    if (next !== line) { line = next; $.ui.invalidate('ui.render') }
  } catch {}
}

// The context proxy's clearing, drawn beside the notes (src/compression.js holds the same rule; the figures
// are the API's own `cleared_input_tokens`, which the proxy writes per session as it sees them). The wait:
// the first cleared call saves nothing anybody would notice -- the saving is every later call that reads the
// shorter prefix -- so the card appears TURNS_AFTER turns on, by when the figure is the clearing's return.
export const TURNS_AFTER = 3
export const compressionHeader = (s: Saving) =>
  `context cleared · ~${formatTokens(s.saved)} tokens not re-read over ${s.requests} ${s.requests === 1 ? 'call' : 'calls'}`
// which of the agent's own actions the saving was made of, as src/compression.js:compressionTools words it.
// An MCP tool's name reaches the agent with the protocol's prefix and its server run together
// (`mcp__artemis__get_experiment`); written here as the person reads it, and cut if still too long for the line.
export const CARD_TOOLS = 3
export const NAME = 26
export const shortTool = (name: string) => {
  const n = String(name || 'tool').replace(/^mcp__/, '').replace(/__/g, '/')
  return n.length <= NAME ? n : n.slice(0, NAME - 1) + '…'
}
export const compressionTools = (s: Saving) =>
  (s.tools ?? []).slice(0, CARD_TOOLS).map(t => `${shortTool(t.name)} ×${t.calls} (${formatTokens(t.tokens)})`).join(', ')

async function compressionState($: any): Promise<Saving | null> {
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
    if (!id) return null
    const st = JSON.parse(String(await $.fs.read(`${home}/state/compression/${id}.json`)))
    return st?.saved > 0 && st?.requests > 0 ? { saved: st.saved, requests: st.requests, uses: st.uses || 0, tools: Array.isArray(st.tools) ? st.tools : [] } : null
  } catch { return null }
}

// One card per summary, not one a turn (src/notice-cadence.js holds the same floors and writes the
// same file): a box under every answer is noise, and the clearing's figure in particular was redrawn
// unchanged every turn from TURNS_AFTER on. A card is drawn when a summary is due -- 20 prompts since
// the last one and a day gone by -- and then stamps it, so the person gets one thinker message
// whichever door it comes through. The Stop hook counts the prompts; the card only reads the count,
// since both run in every turn and counting it twice would halve the floor.
export const NOTICE_PROMPTS = 20
export const NOTICE_HOURS = 24
const noticeFile = async ($: any) => `${(await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`}/state/notice.json`
async function noticeDue($: any): Promise<boolean> {
  try {
    const st = JSON.parse(String(await $.fs.read(await noticeFile($))))
    const at = st?.at ? Date.parse(st.at) : NaN
    if (!(at > 0)) return true   // nothing said yet: a fresh cache draws its first card at once
    return (st.prompts || 0) >= NOTICE_PROMPTS && Date.now() - at >= NOTICE_HOURS * 3600e3
  } catch { return true }
}
async function noticeShown($: any): Promise<void> {
  try { await $.fs.write(await noticeFile($), JSON.stringify({ at: new Date().toISOString(), prompts: 0 })) } catch {}
}

const MAX_CARDS = 300
export const tailOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-160)
let cards: Card[] | null = null
async function load($: any): Promise<Card[]> {
  if (cards === null) cards = ((await $.store.get('cards').catch(() => null)) as Card[] | null) ?? []
  return cards
}

export const register: Register = on => {
  // notes served since the last card was drawn, prompt-time and late: a held turn keeps them
  let served: Note[] = []
  // turns that served something and drew nothing, waiting for the next summary
  let held = 0
  // turns since the first one that saw the proxy clear anything in this session; -1 until then
  let sinceClear = -1
  cards = null
  line = ''

  on('session.start', async ($, e, next) => { await markSession($); await readSavings($); return next(e) })

  // a hook's JSON additionalContext (the late notes after a tool) is in the folded result
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    served.push(...servedNotes(r.additionalContext))
    return r
  }).catch(($, e, next) => next(e))

  // a hook's plain-text output (the prompt's notes) reaches the conversation as a row the session
  // appends; only what a hook added counts, never a reply or a tool result that quotes a note
  on('session.append', ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'hook') served.push(...servedNotes(strings(e.message)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const byId = new Map(served.map(n => [n.id, n]))
      const state = await compressionState($)
      if (state) sinceClear = sinceClear < 0 ? 0 : sinceClear + 1
      const compression = state && sinceClear >= TURNS_AFTER ? state : undefined
      const tail = tailOf(e.answer)
      if ((byId.size || compression) && tail) {
        if (!(await noticeDue($))) held++   // the notes stay in `served` and come with the next card
        else {
          const tokens = byId.size ? await estimate($, [...byId.keys()]).catch(() => 0) : 0
          const card: Card = { tail, titles: [...byId.values()].map(n => n.title), tokens, at: Date.now(), prompts: held + 1, ...(compression ? { compression } : {}) }
          cards = [...(await load($)).filter(c => c.tail !== tail), card].slice(-MAX_CARDS)
          await $.store.set('cards', cards).catch(() => {})
          await markSession($)
          await noticeShown($)
          served = []; held = 0
          // the answer was drawn before the turn ended: draw it again, now with its card
          $.ui.invalidate('ui.render')
        }
      }
      // every turn, card or no card: the Stop hook has just started the ledger's refresh, and the
      // status row is what the person reads between summaries. One file read, no counting here.
      await readSavings($)
    }
    return next(e)
  })

  // The figures ride the status line's own row, at its far right (the owner's ask, 2026-11-06: that
  // row has empty space and a row of thinker's own does not earn one). `PromptHint`'s `tail` is the
  // engine's own door for this: the engine keeps its line and its live pills and draws the tail dim at
  // the end, cut where the row ends, so the row stays the engine's and thinker only fills the gap.
  //
  // `$.ui.status` was the first home for this and cannot be placed: it takes text and nothing else.
  // thinker still writes no `statusLine` into the person's settings -- that surface is theirs.
  // Nothing is read here; `line` was read when the turn ended (readSavings).
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (!line) return next(e)
    const columns = e.viewport?.columns ?? 0
    return next({ ...e, props: { ...e.props, tail: statusTail(e.props.hint ?? '', line, columns) } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isSummary) return drawn
    const tail = tailOf(e.props.text)
    const card = tail ? (await load($)).find(c => c.tail === tail) : undefined
    if (!card) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {card.titles.length ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text><Text bold>🧠 Thinker</Text><Text dimColor> · {cardHeader(card.titles.length, card.tokens, card.prompts ?? 0)}</Text></Text>
            {card.titles.slice(0, 3).map((t, i) => (
              <Text key={'t' + i} dimColor>• {shortTitle(t)}</Text>
            ))}
            {card.titles.length > 3 ? <Text dimColor>+{card.titles.length - 3} more</Text> : null}
          </Box>
        ) : null}
        {card.compression ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text><Text bold>🗜 Thinker</Text><Text dimColor> · {compressionHeader(card.compression)}</Text></Text>
            <Text dimColor>• {card.compression.uses} tool {card.compression.uses === 1 ? 'result' : 'results'} cleared from the prompt</Text>
            {compressionTools(card.compression) ? <Text dimColor>• out now: {compressionTools(card.compression)}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}

// The Claude Code side of thinker's card: what the context clearing saved, drawn under the answer once a
// summary comes due. The card is kept by the end of that answer's text, so it is drawn again whenever the
// transcript is, the session reopened included. `thinker connect` names this folder in CLAUDE_CODE_PLUGIN_DIRS
// (clients.js:claudeCardDir); a session this mod runs in is marked under thinker's home, and the
// Stop hook leaves its own collapsed line out there (claude-card.js:claudeCardActive). Until 2026-11-08 the
// card also listed the knowledge notes a turn was served; they went with the notes.
//
// It also pins what thinker has saved -- today and over the whole log -- as this plugin's status line
// under the prompt, which is the one surface that can keep a figure on screen instead of saying it
// once and scrolling away. That is why Claude Code's footer is here and not in the Stop hook's line:
// the figures are a running total, so they belong somewhere permanent, and the hook leaves them out
// where this mod runs (commands/hooks.js). The numbers are read off the ledger thinker's hooks keep
// refreshed (src/accountant.js) -- this mod only ever reads one small file.
import type { Register } from 'claude-code'

export type Tool = { name: string; calls: number; tokens: number }
export type Saving = { saved: number; requests: number; uses: number; tools: Tool[] }
export type Note = { id: string; title: string; lines: string[]; more?: string; version?: string; page?: string }
export type Card = { tail: string; at: number; prompts?: number; compression?: Saving; update?: Note }
// the kept ledger, as src/accountant.js writes it
export type Cell = { cost: number; tokens: number; unpricedTokens?: number }
export type Ledger = { at: number; day: string; version?: string; today: Cell; lifetime: Cell }

// every string inside a value, however a row nests its content
export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n)}`
}

// A dollar figure for people, as prices.js:formatDollars writes it; the mod has its own copy because
// it runs inside Claude Code (no test holds the two texts together: change both).
export function formatDollars(d: number): string {
  if (d == null || !Number.isFinite(d)) return '–'
  const a = Math.abs(d), s = d < 0 ? '−' : ''
  if (a >= 10000) return `${s}$${(a / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (a >= 100) return `${s}$${Math.round(a)}`
  if (a >= 10) return `${s}$${a.toFixed(1)}`
  if (a >= 0.01 || a === 0) return `${s}$${a.toFixed(2)}`
  return `${s}$${a.toFixed(3)}`
}

// The checkout whose cache this is: a linked worktree's `.git` is a file naming the main checkout's git
// directory, and the worktree uses the main checkout's cache (store.js).
async function cacheRoot($: any): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  const root: string = repo?.root ?? (await $.session.cwd())
  try {
    const m = String(await $.fs.read(`${root}/.git`)).match(/^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m)
    if (m) return m[1]
  } catch {}
  return root
}

// The Stop hook reads this mark to leave its collapsed line out of a session that shows the card.
async function markSession($: any): Promise<void> {
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
    if (id) await $.fs.write(`${home}/state/claude-card/${id}`, '')
  } catch {}
}

// The status line's words, as src/accountant.js:savingsStatus writes them (no test holds the two
// sentences together: change both). Both figures are already formatted; `today` is null when the kept
// ledger's day is not this one, since a figure stamped yesterday is not what was saved this morning.
// The version is the ledger's own (the copy that counted these figures), and this row is the only
// place thinker names it: the agents never do, so a person has no other way to see what they run.
export const savingsStatus = (today: string | null, lifetime: string, version?: string) =>
  `thinker${version ? ` v${version}` : ''}: ${today ? `saved today ${today} · ` : ''}lifetime ${lifetime}`

// The figures as the tail of the engine's own status row, which is the whole of what a mod may say
// about how they are drawn. The engine takes the string and nothing else: it collapses every run of
// whitespace in it to one space and trims the ends (`clean`, src/.../prompt-hint), draws it after its
// own line behind a dim ` · `, in one Text with `wrap: "truncate"`, and leaves it out under
// TAIL_MIN_COLUMNS of row. So the tail cannot be placed, padded or coloured:
//
//   <Box maxWidth={room}><Text dimColor wrap="truncate">{[' · ', tail]}</Text></Box>
//
// Padding it to the right edge was tried and is not possible (read out of the engine, 2026-11-06):
// the leading spaces are collapsed and trimmed before it is drawn. What is left to decide is the
// words, so the line names thinker and then says the figures.
export const statusTail = (line: string): string => line

// The person's own day, in their own timezone, as the ledger stamps it (accountant.js:dayKey).
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
  version = l.version || ''
  return savingsStatus(today, formatDollars(l.lifetime.cost), l.version)
}

// The version that wrote the ledger, kept from the same read: the update card names it too, and a card
// may no more read a file while drawing than the status row may.
let version = ''
// The line currently on screen, kept here because a `ui.render` hook draws on every frame and must
// never read a file: the reads happen at the start of the session, at the end of each turn, and when
// the ledger's file moves (the poll below), and a changed line asks for a redraw.
let line = ''
// The ledger is refreshed by the Stop hook in a detached process that takes about a second, so the read
// at the end of the same turn lands before the write does: every session then showed the ledger as it
// stood at its previous turn, and two open sessions disagreed until each had another turn (2026-11-08).
// So the file's modification time is polled while the session is open, and a move reads it again. One
// stat every LEDGER_POLL_MS, a read only when it moved; the runtime has no file watcher.
export const LEDGER_POLL_MS = 5_000
let ledgerAt = -1
const ledgerFile = async ($: any) => `${await thinkerHome($)}/state/savings.json`
// Whether the ledger's file has moved since it was last read; the stamp is kept either way.
async function ledgerMoved($: any): Promise<boolean> {
  let at = 0
  try { at = Number((await $.fs.stat(await ledgerFile($)))?.mtimeMs) || 0 } catch { at = 0 }
  if (at === ledgerAt) return false
  ledgerAt = at
  return true
}
// the day the person ran /thinker-hide, kept in the mod's store across sessions; the line is back the next day
let hiddenOn = ''
export const HIDDEN_KEY = 'savings-hidden-on'

// The desktop door: the engine's own status line under the prompt (`$.ui.status`), which the Claude
// desktop app draws and the terminal does not place (the terminal's door is the tail below). Text
// alone, so the dismissal is a command rather than a button. Cleared with `undefined` once hidden.
// The desktop app heads the line with the plugin's name (`thinker`, plugin.json), so the line itself
// drops the `thinker: ` the terminal's row carries (`desktopStatus`): it would read thinker twice.
export const desktopStatus = (line: string) => line.replace(/^thinker:? ?/, '')
const showStatus = ($: any, surface: string) => {
  if (surface !== 'desktop') return
  $.ui.status(line && hiddenOn !== dayKey(Date.now()) ? desktopStatus(line) : undefined)
}

// Read the ledger and, if it says something new, have the row drawn again.
async function readSavings($: any, surface = ''): Promise<void> {
  try {
    await ledgerMoved($)   // the stamp of what is read now, so the poll does not read it again
    const next = await savings($)
    if (next !== line) { line = next; $.ui.invalidate('ui.render') }
    showStatus($, surface)
  } catch {}
}

// The context proxy's clearing (src/compression.js holds the same rule; the figures
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

// What changed in thinker, drawn once per machine as a card under an answer. The words are
// src/update-note.js's (no test holds this copy to them: change both); the mod runs inside Claude
// Code and can import nothing from thinker. Once per note, keyed on the note's own id, and never where
// the notices are off -- a person who asked thinker to be quiet did not ask for release notes.
export const UPDATE_NOTE: Note = {
  id: '2026-11-agent',
  title: 'What changed',
  lines: [
    'Thinker is now an agent that constantly improves your harness and instruction files!',
    'Chat with thinker in {chat} to learn about how it works and steer it as you like.',
    'Look at your factory page {factory} and click on a stage to tell thinker to improve it based on your recent history.',
    'More coming soon.',
  ],
  more: 'Open the dashboard any time: thinker ui',
}
export const NOTE_KEY = 'update-note'


// Where a line's `{chat}` and `{factory}` go, as src/update-note.js:noteLinks fills them: the place on the
// local page while one runs for this machine, the command that opens it where none could be started.
export const noteLinks = (page?: string) => (page
  ? { chat: `${page}#tab=chat`, factory: `${page}#tab=factory` }
  : { chat: 'the dashboard (run: thinker ui)', factory: '(run: thinker ui --tab factory)' })
// a line as the pieces the card draws: its words, and each place on the page as a link of its own
export function noteParts(line: string, page?: string): { text: string; href?: string }[] {
  const links = noteLinks(page) as Record<string, string>
  return line.split(/(\{(?:chat|factory)\})/).filter(Boolean).map(t => {
    const to = /^\{(chat|factory)\}$/.exec(t)
    return to ? { text: links[to[1]], ...(page ? { href: links[to[1]] } : {}) } : { text: t }
  })
}
// thinker's CLI, read off the prompt hook thinker wrote into Claude Code's settings: the copy the hooks run
// (the clearing mod finds it the same way, claude-clear:cliOf)
export const cliOf = (settings: any): string | null => {
  for (const g of settings?.hooks?.UserPromptSubmit || []) for (const h of g?.hooks || []) {
    const hit = /^node "([^"]+[\\/]cli\.js)" hook prompt\b/.exec(String(h?.command || ''))
    if (hit) return hit[1]
  }
  return null
}
// The page the note's links open, put up first: `thinker ui --ensure` answers with the address of the page
// running for this machine and starts one in the background where none runs (context-suggest.js:ensureUi),
// since the mod can start nothing that outlives its own call. No CLI found, none started in time, or an
// answer that is not the page's own address: the card names the command instead.
export const PAGE_TIMEOUT_MS = 8_000
async function notePage($: any): Promise<string | undefined> {
  try {
    let cli = (await $.env.get('THINKER_CLI')) || null
    if (!cli) {
      const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
      cli = cliOf(JSON.parse(String(await $.fs.read(`${dir}/settings.json`))))
    }
    if (!cli) return undefined
    const r = await $.process.run(['node', cli, 'ui', '--ensure'], { timeoutMs: PAGE_TIMEOUT_MS })
    const url = String(r.stdout || '').trim().split('\n').pop() || ''
    return r.exitCode === 0 && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) ? url : undefined
  } catch { return undefined }
}

const MAX_CARDS = 300
export const tailOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-160)
let cards: Card[] | null = null
async function load($: any): Promise<Card[]> {
  if (cards === null) cards = ((await $.store.get('cards').catch(() => null)) as Card[] | null) ?? []
  return cards
}

export const register: Register = on => {
  // turns that had a saving to show and drew nothing, waiting for the next summary
  let held = 0
  // turns since the first one that saw the proxy clear anything in this session; -1 until then
  let sinceClear = -1
  cards = null
  line = ''
  version = ''
  ledgerAt = -1
  let poll: { cancel: () => void } | null = null

  let surface = ''
  on('session.start', async ($, e, next) => {
    surface = e.surface
    await markSession($)
    if (surface === 'desktop') {
      await $.command.register({ name: 'thinker-hide', description: 'Hide the thinker savings line under the prompt for today' })
      hiddenOn = String((await $.store.get(HIDDEN_KEY)) ?? '')
    }
    await readSavings($, surface)
    poll?.cancel()
    poll = $.clock.every(LEDGER_POLL_MS, async () => { if (await ledgerMoved($)) await readSavings($, surface) })
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    poll?.cancel(); poll = null
    return next(e)
  })
  on('command.run', { command: 'thinker-hide' }, async ($) => {
    hiddenOn = dayKey(Date.now())
    await $.store.set(HIDDEN_KEY, hiddenOn)
    showStatus($, surface)
    return { text: 'thinker savings line hidden until tomorrow.' }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const state = await compressionState($)
      if (state) sinceClear = sinceClear < 0 ? 0 : sinceClear + 1
      const compression = state && sinceClear >= TURNS_AFTER ? state : undefined
      const tail = tailOf(e.answer)
      // What changed in thinker, once per machine, at the first turn that ends after the update. It
      // does not wait for the summary cadence and does not spend it: a release note is a one-off, and
      // a person who learns a week late what their agent has been doing has learnt it too late. The
      // Stop hook leaves it to this card where the mod runs (commands/hooks.js:carded), so it is said
      // once whichever door it comes through.
      if (tail && (await noticeOn($)) && (await $.store.get(NOTE_KEY).catch(() => null)) !== UPDATE_NOTE.id) {
        await $.store.set(NOTE_KEY, UPDATE_NOTE.id).catch(() => {})
        const page = await notePage($)
        const card: Card = { tail, at: Date.now(), update: { ...UPDATE_NOTE, version, ...(page ? { page } : {}) } }
        cards = [...(await load($)).filter(c => c.tail !== tail), card].slice(-MAX_CARDS)
        await $.store.set('cards', cards).catch(() => {})
        await markSession($)
        $.ui.invalidate('ui.render')
      }
      if (compression && tail) {
        if (!(await noticeDue($))) held++   // the saving comes with the next card
        else {
          const was = (await load($)).find(c => c.tail === tail)
          const card: Card = { tail, at: Date.now(), prompts: held + 1, compression, update: was?.update }
          cards = [...(await load($)).filter(c => c.tail !== tail), card].slice(-MAX_CARDS)
          await $.store.set('cards', cards).catch(() => {})
          await markSession($)
          await noticeShown($)
          held = 0
          // the answer was drawn before the turn ended: draw it again, now with its card
          $.ui.invalidate('ui.render')
        }
      }
      // every turn, card or no card: the Stop hook has just started the ledger's refresh, and the
      // status row is what the person reads between summaries. One file read, no counting here.
      await readSavings($, surface)
    }
    return next(e)
  })

  // The figures ride the status line's own row rather than taking a row of their own (the owner's ask,
  // 2026-11-06: that row has empty space and a row of thinker's own does not earn one). `PromptHint`'s
  // `tail` is the engine's own door for this: the engine keeps its line and its live pills and draws
  // the tail dim after them, cut where the row ends. Where on the row is the engine's to decide, and
  // it draws the tail straight after its own line, not at the right edge (statusTail).
  //
  // `$.ui.status` was the first home for this and cannot be placed: it takes text and nothing else.
  // thinker still writes no `statusLine` into the person's settings -- that surface is theirs.
  // Nothing is read here; `line` was read when the turn ended (readSavings).
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (!line || e.surface !== 'terminal') return next(e)
    return next({ ...e, props: { ...e.props, tail: statusTail(line) } })
  })


  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.isSummary) return drawn
    const tail = tailOf(e.props.text)
    const card = tail ? (await load($)).find(c => c.tail === tail) : undefined
    if (!card?.compression && !card?.update) return drawn
    const { Box, Text, Link } = $.ui.resolve(e)
    const page = card.update?.page
    return (
      <Box flexDirection="column">
        {drawn}
        {card.update ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text><Text bold>🧠 Thinker{card.update.version ? ` v${card.update.version}` : ''}</Text><Text dimColor> · {card.update.title}</Text></Text>
            {card.update.lines.map((l, i) => <Text key={i} dimColor>• {noteParts(l, page).map((p, j) => p.href ? <Link key={j} href={p.href} /> : p.text)}</Text>)}
            {card.update.more ? <Text dimColor>{card.update.more}</Text> : null}
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

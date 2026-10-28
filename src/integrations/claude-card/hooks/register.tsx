// The Claude Code side of thinker's cache-hit card (the Codex desktop card is src/notice-card.js).
// thinker's hooks hand their notes to the model as text; this mod reads them as the session keeps
// them, and draws a card under the answer of each turn that was served notes. The card is kept by
// the end of that answer's text, so it is drawn again whenever the transcript is, the session
// reopened included. `thinker connect` names this folder in CLAUDE_CODE_PLUGIN_DIRS
// (clients.js:claudeCardDir); a session this mod runs in is marked under thinker's home, and the
// Stop hook leaves its own collapsed cache-hit line out there (claude-card.js:claudeCardActive).
import type { Register } from 'claude-code'

export type Note = { title: string; id: string }
export type Saving = { saved: number; requests: number; uses: number }
export type Card = { tail: string; titles: string[]; tokens: number; at: number; compression?: Saving }

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

export const cardHeader = (n: number, tokens: number) =>
  `${n} ${n === 1 ? 'note' : 'notes'} this turn${tokens ? ` · Estimated tokens saved: ~${formatTokens(tokens)}` : ''}`

// The context proxy's clearing, drawn beside the notes (src/compression.js holds the same rule; the figures
// are the API's own `cleared_input_tokens`, which the proxy writes per session as it sees them). The wait:
// the first cleared call saves nothing anybody would notice -- the saving is every later call that reads the
// shorter prefix -- so the card appears TURNS_AFTER turns on, by when the figure is the clearing's return.
export const TURNS_AFTER = 3
export const compressionHeader = (s: Saving) =>
  `context cleared · ~${formatTokens(s.saved)} tokens not re-read over ${s.requests} ${s.requests === 1 ? 'call' : 'calls'}`

async function compressionState($: any): Promise<Saving | null> {
  try {
    const home = (await $.env.get('THINKER_HOME')) || `${await $.env.get('HOME')}/.thinker`
    const id = String(await $.session.id()).replace(/[^\w.-]/g, '_')
    if (!id) return null
    const st = JSON.parse(String(await $.fs.read(`${home}/state/compression/${id}.json`)))
    return st?.saved > 0 && st?.requests > 0 ? { saved: st.saved, requests: st.requests, uses: st.uses || 0 } : null
  } catch { return null }
}

const MAX_CARDS = 300
export const tailOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(-160)
let cards: Card[] | null = null
async function load($: any): Promise<Card[]> {
  if (cards === null) cards = ((await $.store.get('cards').catch(() => null)) as Card[] | null) ?? []
  return cards
}

export const register: Register = on => {
  // notes served since the main loop's turn began, prompt-time and late
  let served: Note[] = []
  // turns since the first one that saw the proxy clear anything in this session; -1 until then
  let sinceClear = -1
  cards = null

  on('session.start', async ($, e, next) => { await markSession($); return next(e) })

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
      served = []
      const state = await compressionState($)
      if (state) sinceClear = sinceClear < 0 ? 0 : sinceClear + 1
      const compression = state && sinceClear >= TURNS_AFTER ? state : undefined
      const tail = tailOf(e.answer)
      if ((byId.size || compression) && tail) {
        const tokens = byId.size ? await estimate($, [...byId.keys()]).catch(() => 0) : 0
        const card: Card = { tail, titles: [...byId.values()].map(n => n.title), tokens, at: Date.now(), ...(compression ? { compression } : {}) }
        cards = [...(await load($)).filter(c => c.tail !== tail), card].slice(-MAX_CARDS)
        await $.store.set('cards', cards).catch(() => {})
        await markSession($)
        // the answer was drawn before the turn ended: draw it again, now with its card
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
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
            <Text><Text bold>🧠 Thinker</Text><Text dimColor> · {cardHeader(card.titles.length, card.tokens)}</Text></Text>
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
          </Box>
        ) : null}
      </Box>
    )
  })
}

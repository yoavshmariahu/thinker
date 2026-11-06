// Run with `claude plugin test src/integrations/claude-card` (npm test runs test/claude-card.test.js).
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { servedNotes, cardHeader, cells, compressionHeader, compressionTools, statusTail, tailOf, shortTitle, TURNS_AFTER } from './register'

const bundle = `<thinker-cache>
Notes about this repo from earlier sessions.

### [rule] Codex hook review state: and trusted hash calculation  (id: codex-hook, confidence 100%)
body

Other cached titles. Use lookup only if one directly answers a question still open for this task:
- [rule] repository agent setup  (id: repo-setup)
</thinker-cache>`
const answer = 'Here is how the hash is computed.\n\nIt is SHA-256 of the compact JSON.'

// what stands beneath the mod in a session: the engine's own drawing and the files; `root` is the
// session's checkout. (The prompt's notes arrive as a row a hook appends, which a test cannot raise.)
function engine(on: On, { root = '/r', writes = [] as string[], compression = null as any, savings = null as any, status = [] as (string | undefined)[], env = {} as Record<string, string>, config = null as any } = {}) {
  mock.store(on)
  mock.env(on, { HOME: '/home/me', ...env })
  // the engine's own status row, beneath the mod: what the mod added to it is `tail`
  on('ui.render', { component: 'PromptHint' }, ($, e) => { status.push(e.props.tail); const { Text } = $.ui.resolve(e); return <Text key="hint">{e.props.hint}</Text> })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('fs.write', ($, e) => { writes.push(e.path); return { value: undefined } })
  on('session.repo', () => ({ value: { root, remote: null, internal: false } as any }))
  on('fs.read', ($, e) => {
    if (e.path === '/wt/.git') return { value: 'gitdir: /r/.git/worktrees/wt\n' }
    if (e.path === '/r/.thinker/local/notes/codex-hook.json') return { value: JSON.stringify({ deps: [{ path: 'src/clients.js' }, { path: 'src/small.js' }, { path: '.claude/settings.json' }] }) }
    if (e.path === '/home/me/.thinker/state/compression/sess-1.json' && compression) return { value: JSON.stringify(compression) }
    if (e.path === '/home/me/.thinker/state/savings.json' && savings) return { value: JSON.stringify(savings) }
    if (e.path === `${root}/.thinker/config.json` && config) return { value: JSON.stringify(config) }
    return { deny: 'no such file' }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.endsWith('clients.js') ? 100000 : 3600, mtimeMs: 0 } as any }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="answer">{e.props.text}</Text> })
}
const end = (turnId: string, text = answer) => ({ answer: text, durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })
const mount = ($: any, surface: 'terminal' | 'desktop', text = answer) =>
  $.ui.mount({ plugin: 'thinker-card', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } as any })

// the ledger as src/savings-ledger.js writes it; `day` is stamped in the person's own timezone
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const ledger = (day = today()) => ({ at: Date.now(), day, today: { cost: 3.65, tokens: 5_636_787 }, lifetime: { cost: 849.2, tokens: 1_339_960_865 } })

// the status row as the engine hands it to the mod, and what the mod gave back
const HINT = { component: 'PromptHint' as const, props: { hint: '~/src/talker  main', isDraft: false, isWorking: false } }
const row = async ($: any, status: (string | undefined)[], surface: 'terminal' | 'desktop' = 'terminal') => {
  await $.session.start({ cwd: '/r', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'thinker-card', surface, ...HINT })
  const tail = status.at(-1)
  await ui.unmount()
  return tail
}

test('the figures sit at the far right of the status row, with the engine\'s own line kept', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status })
  const tail = await row($, status)
  expect(tail?.trimEnd()).toBe(tail)                       // padding goes in front, never behind
  expect(tail?.trimStart()).toBe('🧠 saved today ~$3.65 · lifetime ~$849')
})

test('the right edge is measured in cells, so a wide glyph does not push the line off the row', () => {
  // 🧠 is two cells wide: a line measured by length alone would be padded one cell too far
  expect(cells('🧠 a')).toBe(4)
  const line = '🧠 lifetime ~$849'
  const tail = statusTail('~/src/talker  main', line, 80)
  expect(cells('~/src/talker  main') + cells(tail)).toBe(79)
  expect(tail.endsWith(line)).toBe(true)
  // a row with no room for the padding puts the line straight after the engine's own
  expect(statusTail('a'.repeat(70), line, 80)).toBe(` ${line}`)
  expect(statusTail('', line, 0)).toBe(` ${line}`)
})

test('the status row is read again at the end of every turn, served or not', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status })
  await $.turn.complete(end('t1'))
  expect(await row($, status)).toBeDefined()
  await $.turn.complete(end('t2', 'Another answer.'))
  expect((await row($, status))?.trimStart()).toBe('🧠 saved today ~$3.65 · lifetime ~$849')
})

test('a ledger stamped on another day says lifetime alone', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger('2026-01-01'), status })
  expect((await row($, status))?.trimStart()).toBe('🧠 lifetime ~$849')
})

test('no ledger yet leaves the row to the engine', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { status })
  expect(await row($, status)).toBeUndefined()
})

test('a cache with nothing saved yet leaves the row to the engine', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: { at: Date.now(), day: today(), today: { cost: 0, tokens: 0 }, lifetime: { cost: 0, tokens: 0 } }, status })
  expect(await row($, status)).toBeUndefined()
})

test('notices switched off leave the row alone, by environment or by config', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status, env: { THINKER_NOTICE: 'off' } })
  expect(await row($, status)).toBeUndefined()
})

test('notices switched off in the repository config leave the row alone', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status, config: { notice: false } })
  expect(await row($, status)).toBeUndefined()
})

test('the figures reach the desktop app\'s status row too', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status })
  expect((await row($, status, 'desktop'))?.trimStart()).toBe('🧠 saved today ~$3.65 · lifetime ~$849')
})

test('only the notes served count, not the titles listed for lookup', () => {
  expect(servedNotes([bundle, 'unrelated']).map(n => n.id)).toEqual(['codex-hook'])
  expect(servedNotes(undefined)).toEqual([])
})

test('the header reads as the Codex card does', () => {
  expect(cardHeader(1, 7000)).toBe('1 note this turn · Estimated tokens saved: ~7k')
  expect(cardHeader(2, 0)).toBe('2 notes this turn')
  expect(cardHeader(3, 0, 24)).toBe('3 notes over the last 24 prompts')
})

test('a title shows its headline only', () => {
  expect(shortTitle('repo-level hook wiring: a hook whose script is gone')).toBe('repo-level hook wiring')
  expect(shortTitle('Hooks serve nothing below SERVE_MIN_NOTES; test caches need more')).toBe('Hooks serve nothing below SERVE_MIN_NOTES')
  expect(shortTitle('x'.repeat(100)).length).toBe(80)
  expect(tailOf('a\n\n  b ')).toBe('a b')
})

test('a late note in a tool hook\'s JSON context counts', async ($, on) => {
  engine(on)
  on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  await $.turn.complete(end('t1'))
  const ui = await mount($, 'desktop')
  expect((await ui.findAll({ text: /1 note this turn/ })).length).toBeGreaterThan(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a served turn's answer is drawn with the card under it (${surface})`, async ($, on) => {
    on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
    engine(on)
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
    await $.turn.complete(end('t1'))
    const ui = await mount($, surface)
    expect((await ui.findAll({ text: /SHA-256 of the compact JSON/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /Estimated tokens saved: ~7k/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /• Codex hook review state$/ })).length).toBeGreaterThan(0)
  })

  test(`an answer whose turn was served nothing is drawn as the engine draws it (${surface})`, async ($, on) => {
    engine(on)
    await $.turn.complete(end('t2', 'You are welcome.'))
    const ui = await mount($, surface, 'You are welcome.')
    expect((await ui.findAll({ text: /Thinker/ })).length).toBe(0)
  })
}

test('in a linked worktree the notes are read from the main checkout', async ($, on) => {
  engine(on, { root: '/wt' })
  on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  await $.turn.complete(end('t1'))
  const ui = await mount($, 'desktop')
  expect((await ui.findAll({ text: /~7k/ })).length).toBeGreaterThan(0)
})

test('a session the card runs in is marked for the Stop hook', async ($, on) => {
  const writes: string[] = []
  engine(on, { writes })
  on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  await $.turn.complete(end('t1'))
  expect(writes).toContain('/home/me/.thinker/state/claude-card/sess-1')
})

test('a subagent turn keeps no card', async ($, on) => {
  engine(on)
  on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  await $.turn.complete({ ...end('s'), agentId: 'a1' })
  const ui = await mount($, 'desktop')
  expect((await ui.findAll({ text: /Thinker/ })).length).toBe(0)
})

// What the context proxy cleared, drawn beside the notes once it has had a few turns to pay for itself.
const cleared = { session: 'sess-1', saved: 1_200_000, requests: 40, uses: 310, tools: [{ name: 'Bash', calls: 41, tokens: 1_100_000 }, { name: 'Read', calls: 18, tokens: 380_000 }] }

test('the cleared-context header reads as the command does', () => {
  expect(compressionHeader({ saved: 1_200_000, requests: 40, uses: 310, tools: [] })).toBe('context cleared · ~1.2M tokens not re-read over 40 calls')
  expect(compressionHeader({ saved: 900, requests: 1, uses: 1, tools: [] })).toBe('context cleared · ~900 tokens not re-read over 1 call')
})

test('the actions the saving was made of are named as compression.js names them', () => {
  expect(compressionTools(cleared)).toBe('Bash ×41 (1.1M), Read ×18 (380k)')
  expect(compressionTools({ saved: 1, requests: 1, uses: 0, tools: [] })).toBe('')
})

test('the saving is not drawn on the turns right after the clear', async ($, on) => {
  engine(on, { compression: cleared })
  for (let i = 0; i < TURNS_AFTER; i++) await $.turn.complete(end(`t${i}`, `Answer ${i}.`))
  const ui = await mount($, 'desktop', `Answer ${TURNS_AFTER - 1}.`)
  expect((await ui.findAll({ text: /context cleared/ })).length).toBe(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a few turns on, the saving is drawn under the answer (${surface})`, async ($, on) => {
    engine(on, { compression: cleared })
    for (let i = 0; i <= TURNS_AFTER; i++) await $.turn.complete(end(`t${i}`, `Answer ${i}.`))
    const ui = await mount($, surface, `Answer ${TURNS_AFTER}.`)
    expect((await ui.findAll({ text: /context cleared · ~1.2M tokens not re-read over 40 calls/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /310 tool results cleared from the prompt/ })).length).toBeGreaterThan(0)
    expect((await ui.findAll({ text: /out now: Bash ×41 \(1.1M\), Read ×18 \(380k\)/ })).length).toBeGreaterThan(0)
  })
}

test('a session the proxy cleared nothing from draws nothing', async ($, on) => {
  engine(on)
  for (let i = 0; i <= TURNS_AFTER + 2; i++) await $.turn.complete(end(`t${i}`, `Answer ${i}.`))
  const ui = await mount($, 'desktop', `Answer ${TURNS_AFTER + 2}.`)
  expect((await ui.findAll({ text: /Thinker/ })).length).toBe(0)
})

test('the notes and the saving are two cards under one answer', async ($, on) => {
  engine(on, { compression: cleared })
  on('classic.PostToolUse', () => ({ additionalContext: [bundle] }))
  for (let i = 0; i < TURNS_AFTER; i++) await $.turn.complete(end(`t${i}`, `Answer ${i}.`))
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any)
  await $.turn.complete(end('last'))
  const ui = await mount($, 'desktop')
  expect((await ui.findAll({ text: /Estimated tokens saved: ~7k/ })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ text: /context cleared/ })).length).toBeGreaterThan(0)
})

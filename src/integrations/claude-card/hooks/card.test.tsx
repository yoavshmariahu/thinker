// Run with `claude plugin test src/integrations/claude-card` (npm test runs test/claude-card.test.js).
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { compressionHeader, compressionTools, statusTail, tailOf, TURNS_AFTER } from './register'

const answer = 'Here is how the hash is computed.\n\nIt is SHA-256 of the compact JSON.'

// what stands beneath the mod in a session: the engine's own drawing and the files; `root` is the
// session's checkout.
function engine(on: On, { root = '/r', writes = [] as string[], compression = null as any, savings = null as any, status = [] as (string | undefined)[], pinned = [] as (string | undefined)[], hidden = '', env = {} as Record<string, string>, config = null as any } = {}) {
  on('store.get', ($, e) => ({ value: e.key === 'savings-hidden-on' && hidden ? hidden : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  // the engine's own status line under the prompt, the desktop door: what the mod pinned, or cleared
  on('ui.status', ($, e) => { pinned.push(e.text); return { value: undefined } })
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
  $.ui.mount({ plugin: 'thinker', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } as any })

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
  const ui = await $.ui.mount({ plugin: 'thinker', surface, ...HINT })
  const tail = status.at(-1)
  await ui.unmount()
  return tail
}

test('the figures ride the status row as its tail, with the engine\'s own line kept', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status })
  expect(await row($, status)).toBe('thinker: saved today $3.65 · lifetime $849')
})

test('the tail is the line and nothing else: the engine places it, and collapses what it is padded with', () => {
  const line = 'thinker: lifetime $849'
  expect(statusTail(line)).toBe(line)
  // the engine's own `clean`, as it runs before the tail is drawn: padding a tail to the right edge
  // of the row cannot work, so the mod does not pretend to (register.tsx:statusTail)
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  expect(clean(`${' '.repeat(40)}${line}`)).toBe(line)
  expect(clean(statusTail(line))).toBe(statusTail(line))   // nothing in it for the engine to collapse
})

test('the status row is read again at the end of every turn, served or not', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger(), status })
  await $.turn.complete(end('t1'))
  expect(await row($, status)).toBeDefined()
  await $.turn.complete(end('t2', 'Another answer.'))
  expect((await row($, status))?.trimStart()).toBe('thinker: saved today $3.65 · lifetime $849')
})

test('a ledger stamped on another day says lifetime alone', async ($, on) => {
  const status: (string | undefined)[] = []
  engine(on, { savings: ledger('2026-01-01'), status })
  expect((await row($, status))?.trimStart()).toBe('thinker: lifetime $849')
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

test('on the desktop the figures are the status line under the prompt, and no tail', async ($, on) => {
  const status: (string | undefined)[] = [], pinned: (string | undefined)[] = []
  engine(on, { savings: ledger(), status, pinned })
  expect(await row($, status, 'desktop')).toBeUndefined()   // the desktop draws no tail
  expect(pinned.at(-1)).toBe('saved today $3.65 · lifetime $849')   // the app heads it with the plugin's name
})

test('the terminal pins no status line: one figure, one place', async ($, on) => {
  const status: (string | undefined)[] = [], pinned: (string | undefined)[] = []
  engine(on, { savings: ledger(), status, pinned })
  await row($, status, 'terminal')
  expect(pinned).toEqual([])
})

test('/thinker-hide clears the status line for the day, across sessions', async ($, on) => {
  const pinned: (string | undefined)[] = []
  engine(on, { savings: ledger(), pinned })
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'thinker-hide', args: '' } as any)
  expect(pinned.at(-1)).toBeUndefined()
})

test('hidden today, a new desktop session pins nothing until tomorrow', async ($, on) => {
  const pinned: (string | undefined)[] = []
  engine(on, { savings: ledger(), pinned, hidden: today() })
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })
  expect(pinned.at(-1)).toBeUndefined()
})

test('notices off pin nothing on the desktop either', async ($, on) => {
  const pinned: (string | undefined)[] = []
  engine(on, { savings: ledger(), pinned, env: { THINKER_NOTICE: 'off' } })
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })
  expect(pinned.at(-1)).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an answer whose turn has nothing to show is drawn as the engine draws it (${surface})`, async ($, on) => {
    engine(on)
    await $.turn.complete(end('t2', 'You are welcome.'))
    const ui = await mount($, surface, 'You are welcome.')
    expect((await ui.findAll({ text: /Thinker/ })).length).toBe(0)
  })
}
test('a session the card runs in is marked for the Stop hook', async ($, on) => {
  const writes: string[] = []
  engine(on, { writes })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  expect(writes).toContain('/home/me/.thinker/state/claude-card/sess-1')
})

test('a title tail is one line', () => {
  expect(tailOf('a\n\n  b ')).toBe('a b')
})

// What the context proxy cleared, drawn once it has had a few turns to pay for itself.
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

test('a subagent turn keeps no card', async ($, on) => {
  engine(on, { compression: cleared })
  for (let i = 0; i <= TURNS_AFTER; i++) await $.turn.complete({ ...end(`t${i}`, `Answer ${i}.`), agentId: 'a1' })
  const ui = await mount($, 'desktop', `Answer ${TURNS_AFTER}.`)
  expect((await ui.findAll({ text: /Thinker/ })).length).toBe(0)
})


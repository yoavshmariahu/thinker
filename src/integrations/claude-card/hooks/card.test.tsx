// Run with `claude plugin test src/integrations/claude-card` (npm test runs test/claude-card.test.js).
import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { servedNotes, cardHeader, tailOf, shortTitle } from './register'

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
function engine(on: On, { root = '/r', writes = [] as string[] } = {}) {
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('fs.write', ($, e) => { writes.push(e.path); return { value: undefined } })
  on('session.repo', () => ({ value: { root, remote: null, internal: false } as any }))
  on('fs.read', ($, e) => {
    if (e.path === '/wt/.git') return { value: 'gitdir: /r/.git/worktrees/wt\n' }
    if (e.path === '/r/.thinker/local/notes/codex-hook.json') return { value: JSON.stringify({ deps: [{ path: 'src/clients.js' }, { path: 'src/small.js' }, { path: '.claude/settings.json' }] }) }
    return { deny: 'no such file' }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.endsWith('clients.js') ? 100000 : 3600, mtimeMs: 0 } as any }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="answer">{e.props.text}</Text> })
}
const end = (turnId: string, text = answer) => ({ answer: text, durationMs: 1, isAborted: false, turnId, reason: 'answer' as const })
const mount = ($: any, surface: 'terminal' | 'desktop', text = answer) =>
  $.ui.mount({ plugin: 'thinker-card', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } as any })

test('only the notes served count, not the titles listed for lookup', () => {
  expect(servedNotes([bundle, 'unrelated']).map(n => n.id)).toEqual(['codex-hook'])
  expect(servedNotes(undefined)).toEqual([])
})

test('the header reads as the Codex card does', () => {
  expect(cardHeader(1, 7000)).toBe('1 note this turn · Estimated tokens saved: ~7k')
  expect(cardHeader(2, 0)).toBe('2 notes this turn')
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
  on('session.start', ($, e) => ({ value: undefined }) as any)
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

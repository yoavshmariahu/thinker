// Run with `claude plugin test src/integrations/claude-card`; `npm test` never reaches this file.
// The card under an answer: the clearing's saving, and the release note ("What changed"). The note is shown once
// (src/update-note.js): held here is that this mod shows only what thinker's CLI hands the one call that takes it,
// asks only while a note is armed and a person is at the prompt, keeps the note nowhere, and never draws one an
// earlier copy kept. Every hook below stands for the engine: `files` is the disk, `kv` this mod's store, `cli`
// what `thinker hook note` answers, and nothing here reaches any of them.
import { test, expect } from 'claude-code/testing'
import { tailOf, strings } from './register'

const HOME = '/h'
const NOTE = { id: '2026-11-agent', title: 'What changed', lines: ['Thinker is now an agent'], version: '0.5.1' }
// the note as the CLI hands it over, and the two files the mod reads on the way to asking for it
const TAKEN = { id: '2026-12-next', title: 'What changed', version: '0.6.0', more: 'Open the dashboard any time: thinker ui',
  lines: [[{ text: 'Chat with thinker in ' }, { text: 'http://127.0.0.1:4100/#tab=chat', href: 'http://127.0.0.1:4100/#tab=chat' }]] }
const ARMED = `${HOME}/.thinker/state/update-note-armed.json`
const SETTINGS = `${HOME}/.claude/settings.json`
const wired = () => ({ [ARMED]: JSON.stringify({ id: TAKEN.id }), [SETTINGS]: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node "/t/src/cli.js" hook prompt --client claude --user' }] }] } }) })
// thinker's CLI: the note to the first call, which takes it off the disk, and nothing to any call after
const handsOver = (files: Record<string, string>) => () => {
  if (files[ARMED] === undefined) return { exitCode: 0, stdout: '', stderr: '' }
  delete files[ARMED]
  return { exitCode: 0, stdout: JSON.stringify(TAKEN) + '\n', stderr: '' }
}
const SAVING = { saved: 5000, requests: 3, uses: 2, tools: [] }

function engine(on: any, files: Record<string, string>, kv: Record<string, any>, ran: any[] = [], cli: () => any = () => ({ exitCode: 1, stdout: '', stderr: '' })) {
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.read', (_: any, e: any) => {
    if (files[e.path] === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.write', (_: any, e: any) => { files[e.path] = String(e.content ?? e.text ?? e.data ?? ''); return { value: undefined } })
  on('fs.stat', () => ({ value: { mtimeMs: 0 } as any }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.repo', () => ({ value: null as any }))
  on('store.get', (_: any, e: any) => ({ value: kv[e.key] }))
  on('store.set', (_: any, e: any) => { kv[e.key] = e.value; return { value: undefined } })
  on('process.run', (_: any, e: any) => { ran.push(e); return { value: cli() as any } })
  on('clock.every', () => ({ value: { cancel() {} } as any }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
}
const turn = ($: any, answer: string) => $.turn.complete({ turnId: answer, reason: 'answer', answer } as any)
const drawn = async ($: any, text: string) => strings(await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', props: { text } } as any))

test('with no note armed, the end of a turn asks nobody and draws nothing', async ($, on) => {
  const files: Record<string, string> = { [SETTINGS]: wired()[SETTINGS] }, kv: Record<string, any> = {}, ran: any[] = []
  engine(on, files, kv, ran, handsOver(files))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'the first answer')
  expect(ran.length).toBe(0)   // no process for the turns of every day but the one after an update
  expect(kv.cards ?? []).toEqual([])
  expect((await drawn($, 'the first answer')).join(' ')).not.toContain('Thinker')
})

test('an armed note is taken once, drawn under that answer, and kept nowhere', async ($, on) => {
  const files = wired(), kv: Record<string, any> = {}, ran: any[] = []
  engine(on, files, kv, ran, handsOver(files))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'the first answer after the update')
  expect(ran.map(r => r.argv ?? r.args ?? r.command)).toEqual([['node', '/t/src/cli.js', 'hook', 'note', '--client', 'claude']])
  const said = (await drawn($, 'the first answer after the update')).join(' ')
  for (const piece of ['🧠 Thinker', 'v0.6.0', 'What changed', 'Chat with thinker in', 'Link http://127.0.0.1:4100/#tab=chat', 'thinker ui']) expect(said).toContain(piece)
  // the next turn asks nobody, and its answer carries nothing
  await turn($, 'the second answer')
  expect(ran.length).toBe(1)
  expect((await drawn($, 'the second answer')).join(' ')).not.toContain('What changed')
  // nothing a later session, or this transcript reopened, could draw it from: no card in the store, no file written
  expect(JSON.stringify(kv)).not.toContain('What changed')
  expect(Object.keys(files).filter(f => /update-note/.test(f))).toEqual([])
})

test('a note another session took first is not drawn', async ($, on) => {
  const files = wired(), ran: any[] = []
  engine(on, files, {}, ran, () => ({ exitCode: 0, stdout: '', stderr: '' }))   // the file was there to read; the take was lost
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(ran.length).toBe(1)
  expect((await drawn($, 'an answer')).join(' ')).not.toContain('Thinker')
})

test('a run nobody watches takes no note', async ($, on) => {
  const files = wired(), ran: any[] = []
  engine(on, files, {}, ran, handsOver(files))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false } as any)
  await turn($, 'an answer printed to a pipe')
  expect(ran.length).toBe(0)
  expect(files[ARMED]).toBeDefined()   // left for a turn a person will see
})

test('with the notices off the note is taken and not drawn', async ($, on) => {
  const files = { ...wired(), '/w/.thinker/config.json': JSON.stringify({ notice: false }) }, ran: any[] = []
  engine(on, files, {}, ran, handsOver(files))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(files[ARMED]).toBeUndefined()
  expect((await drawn($, 'an answer')).join(' ')).not.toContain('What changed')
})

test('a release note an earlier copy kept under an answer is not drawn again', async ($, on) => {
  const text = 'an answer the note was drawn under'
  engine(on, {}, { cards: [{ tail: tailOf(text), at: 1, update: NOTE }] })
  const said = (await drawn($, text)).join(' ')
  expect(said).not.toContain('What changed')
  expect(said).not.toContain('Thinker')
})

test('the clearing\'s card is still drawn, without the note kept beside it', async ($, on) => {
  const text = 'an answer three turns after a clear'
  engine(on, {}, { cards: [{ tail: tailOf(text), at: 1, compression: SAVING, update: NOTE }] })
  const said = (await drawn($, text)).join(' ')
  expect(said).toContain('context cleared · ~5k tokens not re-read over 3 calls')
  expect(said).not.toContain('What changed')
})

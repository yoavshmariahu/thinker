// Run with `claude plugin test src/integrations/claude-card`; `npm test` never reaches this file.
// The card under an answer is the clearing's saving and nothing else. From 2026-11-10 to 2026-11-23 it was also a
// release note ("What changed"), which is removed: held here is that no turn says one, that one an earlier copy
// kept under an answer is not drawn again, and that the clearing's card still is. Every hook below stands for
// the engine: `files` is the disk, `kv` this mod's store, and nothing here reaches either.
import { test, expect } from 'claude-code/testing'
import { tailOf, strings } from './register'

const HOME = '/h'
const NOTE = { id: '2026-11-agent', title: 'What changed', lines: ['Thinker is now an agent'], version: '0.5.1' }
const SAVING = { saved: 5000, requests: 3, uses: 2, tools: [] }

function engine(on: any, files: Record<string, string>, kv: Record<string, any>, ran: any[] = []) {
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
  on('process.run', (_: any, e: any) => { ran.push(e); return { value: { exitCode: 1, stdout: '', stderr: '' } as any } })
  on('clock.every', () => ({ value: { cancel() {} } as any }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
}
const turn = ($: any, answer: string) => $.turn.complete({ turnId: answer, reason: 'answer', answer } as any)
const drawn = async ($: any, text: string) => strings(await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', props: { text } } as any))

test('the end of a turn says no release note, on a machine that was never shown one', async ($, on) => {
  const files: Record<string, string> = {}, kv: Record<string, any> = {}, ran: any[] = []
  engine(on, files, kv, ran)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'the first answer')
  expect(kv.cards ?? []).toEqual([])
  expect(Object.keys(files).filter(f => /update-notes?\.json$/.test(f))).toEqual([])
  expect(ran.length).toBe(0)   // and no page is started for links nobody is shown
  expect((await drawn($, 'the first answer')).join(' ')).not.toContain('Thinker')
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

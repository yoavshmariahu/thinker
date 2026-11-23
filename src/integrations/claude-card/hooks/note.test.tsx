// Run with `claude plugin test src/integrations/claude-card`; `npm test` never reaches this file.
// The update note is drawn once per machine. What is tested here is the record behind that, as the mod keeps
// it: after an update an open session still runs the copy of this mod it started with, carrying the note before
// this one, and the two copies must not say their notes in turn (the fault of 2026-11-22). Every hook below
// stands for the engine: `files` is the disk, `kv` this mod's store, and nothing here reaches either.
import { test, expect } from 'claude-code/testing'
import { UPDATE_NOTE, NOTE_KEY } from './register'

const HOME = '/h'
const RECORD = `${HOME}/.thinker/state/update-notes.json`
const OLD_RECORD = `${HOME}/.thinker/state/update-note.json`
const OLDER = '2026-11-profile-factory'   // the note the copy before this one carries

function engine(on: any, files: Record<string, string>, kv: Record<string, any>, sets: string[] = []) {
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
  on('store.set', (_: any, e: any) => { kv[e.key] = e.value; sets.push(e.key); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } as any }))
  on('clock.every', () => ({ value: { cancel() {} } as any }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
}
const turn = ($: any, answer: string) => $.turn.complete({ turnId: answer, reason: 'answer', answer } as any)
const noteCards = (kv: Record<string, any>) => (kv.cards ?? []).filter((c: any) => c.update)
const shownIn = (files: Record<string, string>) => Object.keys(JSON.parse(files[RECORD] ?? '{"shown":{}}').shown)

test('a note nobody has been shown is drawn once, and not at the next turn', async ($, on) => {
  const files: Record<string, string> = {}, kv: Record<string, any> = {}
  engine(on, files, kv)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'the first answer')
  expect(noteCards(kv).map((c: any) => c.update.id)).toEqual([UPDATE_NOTE.id])
  expect(shownIn(files)).toEqual([UPDATE_NOTE.id])
  await turn($, 'the second answer')
  expect(noteCards(kv).length).toBe(1)
})

test('a note already said is not drawn again after an open session on the older copy has put its own id in the store', async ($, on) => {
  const files: Record<string, string> = { [RECORD]: JSON.stringify({ shown: { [UPDATE_NOTE.id]: '2026-11-22T18:51:31.000Z' } }) }
  const kv: Record<string, any> = { [NOTE_KEY]: OLDER }, sets: string[] = []
  engine(on, files, kv, sets)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(noteCards(kv).length).toBe(0)
  // and the older copy's key is left alone: a write there is what makes that session draw its old note again
  expect(kv[NOTE_KEY]).toBe(OLDER)
  expect(sets.includes(NOTE_KEY)).toBe(false)
})

test('drawing the note leaves the older copy\'s key and the notes already on record as they were', async ($, on) => {
  const files: Record<string, string> = { [RECORD]: JSON.stringify({ shown: { [OLDER]: '2026-11-10T23:56:42.000Z' } }) }
  const kv: Record<string, any> = { [NOTE_KEY]: OLDER }, sets: string[] = []
  engine(on, files, kv, sets)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(noteCards(kv).length).toBe(1)
  expect(shownIn(files)).toEqual([OLDER, UPDATE_NOTE.id])
  expect(sets.includes(NOTE_KEY)).toBe(false)
})

test('a note the card said before the record was shared is not drawn again, and the record learns it', async ($, on) => {
  const files: Record<string, string> = {}, kv: Record<string, any> = { [NOTE_KEY]: UPDATE_NOTE.id }
  engine(on, files, kv)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(noteCards(kv).length).toBe(0)
  expect(shownIn(files)).toEqual([UPDATE_NOTE.id])
})

test('a note the Stop hook said in another agent is not drawn again by the card', async ($, on) => {
  const files: Record<string, string> = { [OLD_RECORD]: JSON.stringify({ id: UPDATE_NOTE.id, at: '2026-11-22T23:34:49.201Z' }) }
  const kv: Record<string, any> = {}
  engine(on, files, kv)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await turn($, 'an answer')
  expect(noteCards(kv).length).toBe(0)
})

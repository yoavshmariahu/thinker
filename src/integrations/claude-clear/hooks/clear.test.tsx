// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
import { test, expect } from 'claude-code/testing'
import { clearOld, policyOf, heldOut, proxied, placeholder, worthIt, clearPays, PAYBACK, writeRatio, KEEP_MIN, MIN_CHARS, TOKENS_PER_CHAR, COLD_MS, DEFAULTS } from './register'

const big = (n: number, ch = 'x') => ch.repeat(n)
const prompt = (text: string) => ({ role: 'user' as const, text, toolUses: [], handle: 'h' })
const call = (id: string, tool = 'Read') => ({ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input: {} }], handle: 'h' })
const result = (id: string, text: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }], handle: 'h' })

test('the newest turn and the newest three results stay; older ones become placeholders, and nothing else is touched', () => {
  const messages = [
    prompt('read things'), call('a'), result('a', big(1000, 'a')), call('b', 'Bash'), result('b', big(2000, 'b')), call('c'), result('c', big(300)), call('d'), result('d', big(400)),
    prompt('now this'), call('e'), result('e', big(5000)),
  ]
  const c = clearOld(messages as any)
  expect(c.cleared).toBe(2)
  // the two piggybacks went on 2026-11-04 (the proxy's too): they were worth 0.6% of what the results
  // are worth and nothing, and emptying the call text taught the model it called tools without arguments.
  expect(c.rows).toBe(0)
  expect(c.chars).toBe(3000)
  expect(c.resultTokens).toBe(Math.round(3000 * TOKENS_PER_CHAR))
  expect(c.inputTokens).toBe(0)
  expect(c.tokens).toBe(c.resultTokens)
  expect(c.tools).toEqual([{ name: 'Bash', calls: 1, tokens: Math.round(2000 * TOKENS_PER_CHAR) }, { name: 'Read', calls: 1, tokens: Math.round(1000 * TOKENS_PER_CHAR) }])
  const rows = c.messages as any[]
  expect(rows.length).toBe(messages.length)
  expect(rows[2].toolResults[0].text).toBe(placeholder(1000))
  expect(rows[4].toolResults[0].text).toBe(placeholder(2000))
  // every assistant row keeps its arguments and its handle: only the two results changed
  for (const i of [1, 3, 5, 7, 10]) expect(rows[i]).toBe(messages[i])
  // the kept results, the prompts and the whole newest turn stand as they were
  for (const i of [0, 6, 8, 9, 11]) expect(rows[i]).toBe(messages[i])
})



test('a short result is left alone, and keepMin is the policy\'s', () => {
  const messages = [prompt('go'), call('a'), result('a', big(MIN_CHARS - 1)), call('b'), result('b', big(900)), prompt('next')]
  expect(clearOld(messages as any, { keepMin: 0 }).cleared).toBe(1)
  expect(clearOld(messages as any, { keepMin: KEEP_MIN }).cleared).toBe(0)
})

test('nothing to clear leaves every row as it was', () => {
  const messages = [prompt('go'), call('a'), result('a', big(5000))]
  const c = clearOld(messages as any)
  expect(c.cleared).toBe(0)
  expect(c.messages).toEqual(messages)
})

test('the policy is the proxy\'s unless the machine config says otherwise', () => {
  expect(policyOf(null)).toEqual(DEFAULTS)
  expect(policyOf({ proxy: { trigger: 90000, holdout: 0, desktop: false, keepMin: 'x' } })).toEqual({ ...DEFAULTS, trigger: 90000, holdout: 0, auto: false })
})

test('a session is in or out of the holdout for good, and a share of 0 keeps every session in', () => {
  expect(heldOut('s', 0)).toBe(false)
  expect(heldOut('s', 1)).toBe(true)
  expect(heldOut('abc', 0.5)).toBe(heldOut('abc', 0.5))
  const ids = Array.from({ length: 2000 }, (_, i) => `session-${i}`)
  const out = ids.filter(id => heldOut(id, 0.15)).length
  expect(out).toBeGreaterThan(200)
  expect(out).toBeLessThan(400)
})

test('thinker\'s own proxy is recognized by its loopback address', () => {
  expect(proxied('http://127.0.0.1:61056')).toBe(true)
  expect(proxied('http://localhost:3000/')).toBe(true)
  expect(proxied('https://api.anthropic.com')).toBe(false)
  expect(proxied(undefined)).toBe(false)
})

test('a clear that would be refused is never started: no compaction turn, so no "not compacted" line', () => {
  const nothing = clearOld([prompt('go'), call('a'), result('a', big(5000))] as any)
  expect(nothing.cleared).toBe(0)
  expect(worthIt(nothing, DEFAULTS, 'auto')).toBe(false)
  expect(worthIt(nothing, DEFAULTS, 'manual')).toBe(false)
  // something to clear, but under `clearAtLeast`: by hand it runs, by itself it waits and says nothing
  const some = clearOld([prompt('go'), call('a'), result('a', big(5000)), prompt('next'), call('b'), result('b', big(100))] as any, { keepMin: 0 })
  expect(some.cleared).toBe(1)
  expect(some.tokens).toBeLessThan(DEFAULTS.clearAtLeast)
  expect(worthIt(some, DEFAULTS, 'auto')).toBe(false)
  expect(worthIt(some, DEFAULTS, 'manual')).toBe(true)
  expect(worthIt(some, { ...DEFAULTS, clearAtLeast: 100 }, 'auto')).toBe(true)
  // the transcript could not be read: schedule as before and let the engine's skip stand
  expect(worthIt(null, DEFAULTS, 'auto')).toBe(true)
})

test('a clear is made when it repays its write inside PAYBACK calls, and nothing is assumed about session length', () => {
  const calls = 20
  // nothing to drop: nothing to decide
  expect(clearPays(DEFAULTS, { dropped: 0, recache: 0, calls, idle: 0, cleared: false })).toBe(false)
  // the write is small beside what it drops: repays quickly
  expect(clearPays(DEFAULTS, { dropped: 100000, recache: 20000, calls, idle: 0, cleared: true })).toBe(true)
  // three times what it drops: never repays inside the floor
  expect(clearPays(DEFAULTS, { dropped: 100000, recache: 300000, calls, idle: 0, cleared: true })).toBe(false)
  // the line itself: writeRatio(model) x recache against PAYBACK x dropped. 20 where the model is unknown,
  // so a token written needs 20 read back; the floor allows PAYBACK calls to do it. The proxy also credits a
  // cut with the write it spares (cutting.js:savedPerCall), which needs a per-call cache write this door
  // cannot see; keeping the read alone here refuses clears the proxy would make and never the reverse.
  expect(writeRatio('')).toBe(20)
  expect(PAYBACK).toBe(20)
  const edge = Math.floor(PAYBACK * 80000 / writeRatio(''))
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true })).toBe(true)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge + 1, calls, idle: 0, cleared: true })).toBe(false)
  // on Opus 5.5 a read is a twentieth of an input token, so a written token needs 40 reads and the same
  // write no longer repays in time
  expect(writeRatio('claude-opus-5-5')).toBe(40)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(false)
})

// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
import { test, expect } from 'claude-code/testing'
import { clearOld, policyOf, heldOut, proxied, placeholder, worthIt, clearPays, liveRows, autoDue, charge, isRewrite, usageOf, LONG_CONTEXT, PAYBACK, writeRatio, KEEP_MIN, MIN_CHARS, TOKENS_PER_CHAR, COLD_MS, DEFAULTS } from './register'

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
  // the window could not be read: a hand-run clear may try, the automatic one never guesses
  expect(worthIt(null, DEFAULTS, 'auto')).toBe(false)
  expect(worthIt(null, DEFAULTS, 'manual')).toBe(true)
})

test('the check reads the live window, so what an earlier clear left as placeholders is not counted again', () => {
  // what the next request is built from, after a clear: the old results are placeholders already
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'read things' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: placeholder(400000) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: big(900) }], is_error: true }] },
    { role: 'user', content: [{ type: 'text', text: 'now this' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: big(5000) }] },
  ]
  const rows = liveRows(api) as any[]
  expect(rows.length).toBe(api.length)
  expect(rows[0].text).toBe('read things')
  expect(rows[1].toolUses).toEqual([{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/x' } }])
  expect(rows[4].toolResults).toEqual([{ tool_use_id: 'b', text: big(900), isError: true }])
  const c = clearOld(rows, { keepMin: 0 })
  // the placeholder is under MIN_CHARS and stays; only the 900-char result is new to clear
  expect(c.cleared).toBe(1)
  expect(worthIt(c, DEFAULTS, 'auto')).toBe(false)
})

test('an automatic attempt that did not clear holds the next until the context grows by clearAtLeast', () => {
  // nothing held: due from the trigger on
  expect(autoDue(DEFAULTS.trigger - 1, DEFAULTS, 0)).toBe(false)
  expect(autoDue(DEFAULTS.trigger, DEFAULTS, 0)).toBe(true)
  // refused at 200k: the next turn ends at the same context, and at 250k, and says nothing; at 300k it may try once more
  const holdUntil = 200000 + DEFAULTS.clearAtLeast
  expect(autoDue(200000, DEFAULTS, holdUntil)).toBe(false)
  expect(autoDue(250000, DEFAULTS, holdUntil)).toBe(false)
  expect(autoDue(300000, DEFAULTS, holdUntil)).toBe(true)
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
  // so a token written needs 20 read back; the floor allows PAYBACK calls to do it.
  expect(writeRatio('')).toBe(20)
  expect(PAYBACK).toBe(25)
  const edge = Math.floor(PAYBACK * 80000 / writeRatio(''))
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true })).toBe(true)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge + 1, calls, idle: 0, cleared: true })).toBe(false)
  // on Opus 5.5 a read is a twentieth of an input token, so a written token needs 40 reads and the same
  // write no longer repays in time
  expect(writeRatio('claude-opus-5-5')).toBe(40)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(false)
})

test('a request that rewrote a long prefix is charged its write tokens; a cache read, a short context and no usage are not', () => {
  const usage = (o: Partial<{ input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>) =>
    ({ input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5', ...o })
  expect(usageOf(usage({ input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 }))).toEqual({ input: 5, read: 7, write: 9 })
  expect(usageOf(null)).toBe(null)
  // the proxy's definition (cutting.js:isRewrite): a long context, more than half of it written
  expect(isRewrite({ read: 0, write: LONG_CONTEXT, input: 10 })).toBe(true)
  expect(isRewrite({ read: LONG_CONTEXT, write: 1000, input: 10 })).toBe(false)
  expect(isRewrite({ read: 0, write: LONG_CONTEXT / 2, input: 0 })).toBe(false)
  let c = charge(undefined, null)
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_read_input_tokens: 200_000 }))
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, input_tokens: 10 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  c = charge(c, usage({ cache_creation_input_tokens: 40_000 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  c = charge(c, usage({ cache_creation_input_tokens: 120_000, cache_read_input_tokens: 1000 }))
  expect(c).toEqual({ rewrites: 2, write: 270_000 })
})

// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
import { test, expect } from 'claude-code/testing'
import { clearOld, policyOf, heldOut, proxied, placeholder, worthIt, clearPays, remainingCalls, writeRatio, KEEP_MIN, MIN_CHARS, TOKENS_PER_CHAR, COLD_MS, DEFAULTS } from './register'

const big = (n: number, ch = 'x') => ch.repeat(n)
const prompt = (text: string) => ({ role: 'user' as const, text, toolUses: [], handle: 'h' })
const call = (id: string, tool = 'Read') => ({ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input: {} }], handle: 'h' })
const result = (id: string, text: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }], handle: 'h' })

test('the newest turn and the newest three results stay; older ones become placeholders, and the older turns lose their call text and thinking', () => {
  const messages = [
    prompt('read things'), call('a'), result('a', big(1000, 'a')), call('b', 'Bash'), result('b', big(2000, 'b')), call('c'), result('c', big(300)), call('d'), result('d', big(400)),
    prompt('now this'), call('e'), result('e', big(5000)),
  ]
  const c = clearOld(messages as any)
  expect(c.cleared).toBe(2)
  expect(c.rows).toBe(4)
  const inputs = 4 * JSON.stringify({}).length
  expect(c.chars).toBe(3000 + inputs)
  expect(c.resultTokens).toBe(Math.round(3000 * TOKENS_PER_CHAR))
  expect(c.inputTokens).toBe(Math.round(inputs * TOKENS_PER_CHAR))
  expect(c.tokens).toBe(c.resultTokens + c.inputTokens)
  expect(c.tools).toEqual([{ name: 'Bash', calls: 1, tokens: Math.round(2000 * TOKENS_PER_CHAR) }, { name: 'Read', calls: 1, tokens: Math.round(1000 * TOKENS_PER_CHAR) }])
  const rows = c.messages as any[]
  expect(rows.length).toBe(messages.length)
  expect(rows[2].handle).toBeUndefined()
  expect(rows[2].toolResults[0].text).toBe(placeholder(1000))
  expect(rows[4].toolResults[0].text).toBe(placeholder(2000))
  // the older assistant rows: no handle, no arguments, the call ids and names kept
  for (const i of [1, 3, 5, 7]) {
    expect(rows[i].handle).toBeUndefined()
    expect(rows[i].toolUses).toEqual([{ tool_use_id: messages[i].toolUses[0].tool_use_id, tool: 'Read', input: {} }].map((u, j) => ({ ...u, tool: (messages[i] as any).toolUses[j].tool })))
  }
  // the kept results, the prompts and the whole newest turn stand as they were
  for (const i of [0, 6, 8, 9, 10, 11]) expect(rows[i]).toBe(messages[i])
})

test('with the switches off, the older turns stand; with inputs off alone, their thinking still goes but the arguments stay', () => {
  const messages = [prompt('go'), call('a'), result('a', big(1000)), prompt('next'), call('b'), result('b', big(5000))]
  const off = clearOld(messages as any, { keepMin: 0, clearInputs: false, clearThinking: false })
  expect(off.cleared).toBe(1)
  expect(off.rows).toBe(0)
  expect(off.messages[1]).toBe(messages[1])
  const noInputs = clearOld(messages as any, { keepMin: 0, clearInputs: false, clearThinking: true })
  expect(noInputs.rows).toBe(1)
  expect((noInputs.messages[1] as any).handle).toBeUndefined()
  expect((noInputs.messages[1] as any).toolUses[0].input).toEqual({})
  expect(noInputs.chars).toBe(1000)
})

test('no result cleared means no turn rebuilt either: the piggyback rides on a clear', () => {
  const messages = [prompt('go'), call('a'), result('a', big(100)), prompt('next'), call('b'), result('b', big(5000))]
  const c = clearOld(messages as any, { keepMin: 0 })
  expect(c.cleared).toBe(0)
  expect(c.rows).toBe(0)
  expect(c.messages).toEqual(messages)
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
  expect(policyOf({ proxy: { trigger: 90000, holdout: 0, desktop: false, keepMin: 'x', clearThinking: false } })).toEqual({ ...DEFAULTS, trigger: 90000, holdout: 0, auto: false, clearThinking: false })
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

test('a clear is made when what it drops, read back over the calls left, outweighs the write it costs', () => {
  const calls = 20, left = remainingCalls(calls)
  // nothing to drop: nothing to decide
  expect(clearPays(DEFAULTS, { dropped: 0, recache: 0, calls, idle: 0, cleared: false })).toBe(false)
  // the write is small beside the saving: pays
  expect(clearPays(DEFAULTS, { dropped: 100000, recache: 20000, calls, idle: 0, cleared: true })).toBe(true)
  // the write is three times what it drops (6M at the write rate against 4M read back): does not pay over the calls
  // a session this long has left
  expect(clearPays(DEFAULTS, { dropped: 100000, recache: 300000, calls, idle: 0, cleared: true })).toBe(false)
  // the line itself: remaining calls x dropped against writeRatio(model) x recache; 20 where the model is unknown
  expect(writeRatio('')).toBe(20)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: Math.floor(left * 80000 / 20), calls, idle: 0, cleared: true })).toBe(true)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: Math.floor(left * 80000 / 20) + 1, calls, idle: 0, cleared: true })).toBe(false)
  // on Opus 5.5 a read is a twentieth of an input token, so a written token needs 40 reads: the same write does not pay
  expect(writeRatio('claude-opus-5-5')).toBe(40)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: Math.floor(left * 80000 / 20), calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(false)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: Math.floor(left * 80000 / 40), calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(true)
  expect(writeRatio('claude-fable-5-1')).toBe(80)
  // a pause past the cache's hour: the request writes its context anyway, so the clear is free
  expect(clearPays(DEFAULTS, { dropped: 100000, recache: 100000, calls, idle: COLD_MS, cleared: true })).toBe(true)
  // the proxy's own key off: one clear a session
  expect(clearPays({ ...DEFAULTS, clearDeep: false }, { dropped: 100000, recache: 1000, calls, idle: 0, cleared: true })).toBe(false)
  expect(clearPays({ ...DEFAULTS, clearDeep: false }, { dropped: 100000, recache: 1000, calls, idle: 0, cleared: false })).toBe(true)
  expect(policyOf({ proxy: { clearDeep: false } }).clearDeep).toBe(false)
  expect(policyOf(null).clearDeep).toBe(true)
})

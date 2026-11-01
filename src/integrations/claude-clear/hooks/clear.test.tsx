// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
import { test, expect } from 'claude-code/testing'
import { clearOld, policyOf, heldOut, proxied, placeholder, KEEP_MIN, MIN_CHARS, TOKENS_PER_CHAR, DEFAULTS } from './register'

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
  expect(c.tokens).toBe(Math.round((3000 + inputs) * TOKENS_PER_CHAR))
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

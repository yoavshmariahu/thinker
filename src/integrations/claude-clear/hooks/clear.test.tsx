// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
import { test, expect } from 'claude-code/testing'
import { clearOld, keptOf, clearLadder, policyOf, HOLD_GROWTH, heldOut, proxied, placeholder, worthIt, clearPays, liveRows, autoDue, charge, isRewrite, chargedRewrite, usageOf, LONG_CONTEXT, PAYBACK, writeRatio, KEEP_MIN, MIN_CHARS, resultTokens, COLD_MS, DEFAULTS , delegateOn, cliOf, pretoolEvent, orderOf, REPORT_SLOT } from './register'

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
  expect(c.resultTokens).toBe(c.tools.reduce((n: number, t: any) => n + t.tokens, 0))
  expect(c.inputTokens).toBe(0)
  expect(c.tokens).toBe(c.resultTokens)
  expect(c.tools).toEqual([{ name: 'Bash', calls: 1, tokens: resultTokens(big(2000, 'b')) }, { name: 'Read', calls: 1, tokens: resultTokens(big(1000, 'a')) }])
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
  // refused at 200k: the next turn ends at the same context, and at 250k, and says nothing; at 300k it may try once more.
  // The window is `HOLD_GROWTH`, not `clearAtLeast`: the two were the same 60,000 until the size floor fell to
  // 8,000 with the ladder, and a hold of 8k is no hold at all -- a working session grows that in a turn.
  const holdUntil = 200000 + HOLD_GROWTH
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
  // The line itself: (writeRatio(model) - 1) x recache against (PAYBACK + 1) x dropped. 20 where the model is
  // unknown, so a token written needs 20 read back -- less the read the rewrite displaces, which is the `- 1`,
  // and the call that makes the clear is one of the calls that repay it, which is the `+ 1` (2026-11-13,
  // cutting.js:priceCut). Derived from the constants rather than written out, so the edge cannot go stale
  // again: it was `PAYBACK x dropped / writeRatio` and read 100,000, where the corrected line pays to 109,473.
  expect(writeRatio('')).toBe(20)
  expect(PAYBACK).toBe(25)
  const edgeAt = (dropped: number, model = '') => Math.floor((PAYBACK + 1) * dropped / (writeRatio(model) - 1))
  const edge = edgeAt(80000)
  expect(edge).toBe(109473)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true })).toBe(true)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge + 1, calls, idle: 0, cleared: true })).toBe(false)
  // on Opus 5.5 a read is a twentieth of an input token, so a written token needs 40 reads and the same
  // write no longer repays in time
  expect(writeRatio('claude-opus-5-5')).toBe(40)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edge, calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(false)
  // and its own edge is lower in the same proportion, which is the whole of what the model changes here
  expect(edgeAt(80000, 'claude-opus-5-5')).toBe(53333)
  expect(clearPays(DEFAULTS, { dropped: 80000, recache: edgeAt(80000, 'claude-opus-5-5'), calls, idle: 0, cleared: true, model: 'claude-opus-5-5' })).toBe(true)
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
  // and charged only when something was read back: a rewrite that read nothing found the cache cold (cutting.js:chargedRewrite)
  expect(chargedRewrite({ read: 0, write: LONG_CONTEXT, input: 10 })).toBe(false)
  expect(chargedRewrite({ read: 12_000, write: LONG_CONTEXT, input: 10 })).toBe(true)
  let c = charge(undefined, null)
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_read_input_tokens: 200_000 }))
  expect(c).toEqual({ rewrites: 0, write: 0 })
  // a rewrite that read nothing back: the cache had expired, so the write is not the clearing's
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, input_tokens: 10 }))
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, cache_read_input_tokens: 12_000, input_tokens: 10 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  c = charge(c, usage({ cache_creation_input_tokens: 40_000 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  c = charge(c, usage({ cache_creation_input_tokens: 120_000, cache_read_input_tokens: 1000 }))
  expect(c).toEqual({ rewrites: 2, write: 270_000 })
  // a rewrite on a request that is not the first after a clear was coming without it, and is not charged
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, cache_read_input_tokens: 12_000 }), false)
  expect(c).toEqual({ rewrites: 2, write: 270_000 })
})

test('delegation: on by default, off by the environment or the machine config', () => {
  expect(delegateOn(undefined, null)).toBe(true)
  expect(delegateOn(undefined, { delegate: { holdout: 0.1 } })).toBe(true)
  expect(delegateOn(undefined, { delegate: { enabled: false } })).toBe(false)
  expect(delegateOn('off', { delegate: { enabled: true } })).toBe(false)
  expect(delegateOn('on', { delegate: false })).toBe(true)
  expect(delegateOn('', { delegate: false })).toBe(false)
  // thinker's CLI is the one the prompt hook in Claude Code's settings runs
  expect(cliOf({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'other' }] }, { hooks: [{ command: 'node "/h/.thinker/app/src/cli.js" hook prompt --client claude --user' }] }] } })).toBe('/h/.thinker/app/src/cli.js')
  expect(cliOf({})).toBe(null)
  // the call as PreToolUse spells it, with what the engine reserves left out of the tool's input
  const ev = pretoolEvent({ tool: 'Read', tool_use_id: 't1', file_path: '/r/core.py', offset: 3 }, { session: 's', cwd: '/r', turn: 'turn-1', prompt: 'where?' })
  expect(ev).toEqual({ session_id: 's', cwd: '/r', prompt_id: 'turn-1', user_prompt: 'where?', tool_name: 'Read', tool_input: { file_path: '/r/core.py', offset: 3 }, tool_use_id: 't1', host_runs: true })
  // an order is only one the host can run: an agent, a brief, and a slot for the report
  const order = { agent: 'Explore', prompt: 'brief', wrap: `thinker read core.py.\n\n${REPORT_SLOT}` }
  expect(orderOf(JSON.stringify({ hookSpecificOutput: {}, thinkerRun: order }))).toEqual(order)
  expect(orderOf(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }))).toBe(null)
  expect(orderOf('')).toBe(null)
  expect(orderOf(JSON.stringify({ thinkerRun: { agent: 'Explore', prompt: 'b', wrap: 'no slot' } }))).toBe(null)
})

test('the keep list: the newest copy of a notes file, and of a file the person named, is never cleared', () => {
  const read = (id: string, file: string) => ({ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: file } }], handle: 'h' })
  const messages = [
    prompt('track the posts'), read('a', '/w/learnings.md'), result('a', big(3000)), read('b', '/w/data.json'), result('b', big(3000)),
    read('c', '/w/stats.csv'), result('c', big(3000)), read('d', '/w/learnings.md'), result('d', big(3000)),
    prompt('what did stats.csv say?'), call('e'), result('e', big(500)),
  ]
  const keep = keptOf(messages as any)
  // the older copy of learnings.md (a) is not kept: the newest one (d) holds the file
  expect([...keep].sort()).toEqual(['c', 'd'])
  const c = clearOld(messages as any, { keepMin: 0, keep })
  expect(c.cleared).toBe(2)
  const rows = c.messages as any[]
  expect(rows[2].toolResults[0].text).toBe(placeholder(3000))
  expect(rows[4].toolResults[0].text).toBe(placeholder(3000))
  expect(rows[6]).toBe(messages[6])
  expect(rows[8]).toBe(messages[8])
  // the ladder prices the same set the clear takes
  expect(clearLadder(messages as any, { keepMin: 0, keep }).at(-1)!.depth).toBe(2)
  // a result this mod replaced is the cut: read again afterwards, the file is kept from then on
  const again = [...rows.slice(0, 9), prompt('go on'), read('f', '/w/data.json'), result('f', big(3000)), prompt('and now'), call('g'), result('g', big(500))]
  expect(keptOf(again as any).has('f')).toBe(true)
})

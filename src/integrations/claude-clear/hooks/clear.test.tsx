// Run with `claude plugin test src/integrations/claude-clear` (npm test runs test/claude-clear.test.js).
// What to clear is decided by the installed CLI (src/clear-door.js, test/clear-door.test.js); what is tested here is
// what the mod still does itself: read the live window, hand it over, put the answer in place, count what a clear cost.
import { test, expect } from 'claude-code/testing'
import { ownRoute, offWords, ENABLE, liveRows, charge, chargedRewrite, usageOf, delegateOn, cliOf, pretoolEvent, orderOf, REPORT_SLOT, slim, applyPlan, answerOf, ASK_EVERY } from './register'

const big = (n: number, ch = 'x') => ch.repeat(n)
const prompt = (text: string) => ({ role: 'user' as const, text, toolUses: [], handle: 'h' })
const call = (id: string, tool = 'Read') => ({ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input: {} }], handle: 'h' })
const result = (id: string, text: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }], handle: 'h' })

test('the answer is put in place: each named result becomes its placeholder and every other row is the row it was', () => {
  const messages = [
    prompt('read things'), call('a'), result('a', big(1000, 'a')), call('b', 'Bash'), result('b', big(2000, 'b')), call('c'), result('c', big(300)),
    prompt('now this'), call('e'), result('e', big(5000)),
  ]
  const rows = applyPlan(messages as any, { a: 'gone: a', b: 'gone: b' }) as any[]
  expect(rows.length).toBe(messages.length)
  expect(rows[2]).toEqual({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'gone: a' }] })
  expect(rows[4].toolResults[0].text).toBe('gone: b')
  // every call keeps its arguments and its handle, and so does every row no result of which was named
  for (const i of [0, 1, 3, 5, 6, 7, 8, 9]) expect(rows[i]).toBe(messages[i])
  // an error stays an error, a result beside a named one stays whole, and nothing named leaves every row as it was
  const two = [{ role: 'user' as const, text: 'note', toolUses: [], toolResults: [{ tool_use_id: 'x', text: big(900), isError: true as const }, { tool_use_id: 'y', text: big(700) }], handle: 'h' }]
  expect((applyPlan(two as any, { x: 'gone' }) as any[])[0].toolResults).toEqual([{ tool_use_id: 'x', text: 'gone', isError: true }, { tool_use_id: 'y', text: big(700) }])
  expect((applyPlan(two as any, { x: 'gone' }) as any[])[0].text).toBe('note')
  expect(applyPlan(messages as any, {})).toEqual(messages)
  // a name that is an object's own inherited key is not a result
  expect(applyPlan([result('constructor', big(900))] as any, {})[0]).toEqual(result('constructor', big(900)))
})

test('what goes to the CLI is what the decision reads, and no more of a row than that', () => {
  const rows = slim([prompt('go'), { ...call('a'), toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/x' }, extra: 1 }] }, { ...result('a', big(300)), toolResults: [{ tool_use_id: 'a', text: big(300), isError: true, extra: 1 }] }] as any)
  expect(rows).toEqual([
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big(300), isError: true }] },
  ])
  expect(JSON.stringify(rows)).not.toContain('handle')
})

test('no answer is "leave it alone": an empty object, a crash, nothing printed', () => {
  expect(answerOf('{"clear":true,"depth":2}')).toEqual({ clear: true, depth: 2 })
  // a warning printed before the answer does not hide it: the answer is the last line
  expect(answerOf('node: some warning\n{"auto":true}\n')).toEqual({ auto: true })
  for (const out of ['', '{}', '[]', 'null', 'not json', '"words"']) expect(answerOf(out)).toBe(null)
  expect(ASK_EVERY).toBeGreaterThan(1)
})

test('the check reads the live window, so what an earlier clear left as placeholders is not counted again', () => {
  // what the next request is built from, after a clear: the old results are placeholders already
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'read things' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '[tool result removed by thinker after use: 400000 chars.]' }] },
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
  // the placeholder an earlier clear left is what the next question carries, not the result it replaced
  expect(rows[2].toolResults[0].text.startsWith('[tool result removed by thinker after use:')).toBe(true)
})

test('the first request after a clear is charged what it wrote into a warm cache, whatever its size; a cache read, a cold cache and no usage are not', () => {
  const usage = (o: Partial<{ input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }>) =>
    ({ input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5', ...o })
  expect(usageOf(usage({ input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 }))).toEqual({ input: 5, read: 7, write: 9 })
  expect(usageOf(null)).toBe(null)
  // charged only when something was read back: a write that read nothing found the cache cold (cutting.js:chargedRewrite)
  expect(chargedRewrite({ read: 0, write: 100_000, input: 10 })).toBe(false)
  expect(chargedRewrite({ read: 12_000, write: 100_000, input: 10 })).toBe(true)
  // no floor on the context and no share of it: the three warm cuts one machine recorded as free (2026-11-18)
  expect(chargedRewrite({ read: 68_000, write: 46_000, input: 0 })).toBe(true)
  expect(chargedRewrite({ read: 20_000, write: 59_000, input: 0 })).toBe(true)
  expect(chargedRewrite({ read: 35_000, write: 55_000, input: 0 })).toBe(true)
  expect(chargedRewrite({ read: 200_000, write: 0, input: 10 })).toBe(false)
  let c = charge(undefined, null)
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_read_input_tokens: 200_000 }))
  expect(c).toEqual({ rewrites: 0, write: 0 })
  // a rewrite that read nothing back: the cache had expired, so the write is not the clearing's
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, input_tokens: 10 }))
  expect(c).toEqual({ rewrites: 0, write: 0 })
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, cache_read_input_tokens: 12_000, input_tokens: 10 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  // a small write into a cold cache is still the cold cache's
  c = charge(c, usage({ cache_creation_input_tokens: 40_000 }))
  expect(c).toEqual({ rewrites: 1, write: 150_000 })
  // and a small write into a warm one is the clear's: 40k of a 76k context used to be free
  c = charge(c, usage({ cache_creation_input_tokens: 40_000, cache_read_input_tokens: 36_000 }))
  expect(c).toEqual({ rewrites: 2, write: 190_000 })
  c = charge(c, usage({ cache_creation_input_tokens: 80_000, cache_read_input_tokens: 1000 }))
  expect(c).toEqual({ rewrites: 3, write: 270_000 })
  // a rewrite on a request that is not the first after a clear was coming without it, and is not charged
  c = charge(c, usage({ cache_creation_input_tokens: 150_000, cache_read_input_tokens: 12_000 }), false)
  expect(c).toEqual({ rewrites: 3, write: 270_000 })
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

test('only the proxy service\'s own plain URL is a route /thinker-disable takes away', () => {
  const service = { port: 61056, ports: [61056, 52780] }
  expect(ownRoute('http://127.0.0.1:61056', service)).toBe(true)
  expect(ownRoute('http://localhost:52780/', service)).toBe(true)
  // another local server, a gateway, the desktop app's own URL, the Bedrock path on the proxy, nothing at all
  expect(ownRoute('http://127.0.0.1:4000', service)).toBe(false)
  expect(ownRoute('https://gw.corp.example', service)).toBe(false)
  expect(ownRoute('https://api.anthropic.com', service)).toBe(false)
  expect(ownRoute('http://127.0.0.1:61056/bedrock', service)).toBe(false)
  expect(ownRoute(undefined, service)).toBe(false)
  // no service on record: nothing is known to be thinker's
  expect(ownRoute('http://127.0.0.1:61056', null)).toBe(false)
})

test('/thinker-disable says where the session\'s requests go now', () => {
  expect(offWords('direct')).toContain('straight to Anthropic')
  expect(offWords('none')).toContain('was not going through the proxy')
  expect(offWords('kept', 'https://gw.corp.example')).toContain('https://gw.corp.example is not thinker\'s plain proxy route')
  expect(offWords('refused', null, 'launch-only')).toContain('still goes through the proxy')
  for (const r of ['direct', 'none', 'kept', 'refused'] as const) expect(offWords(r, 'u')).toContain(`/${ENABLE}`)
})

test('a turn that ends past the trigger asks the installed CLI, and the compaction puts its answer in place', async ($, on) => {
  // Each hook here stands for the engine, and `process.run` for the installed thinker: what it is asked, in order,
  // and what the mod does with each answer.
  const stamp = 'v9.9.9-t140k-f8k-p25-deep'
  const answers: Record<string, any> = {
    start: { auto: true, policy: stamp },
    decide: { clear: true, depth: 1, askAt: 140000, hold: 60000, policy: stamp },
    apply: { replace: { a: 'gone: a' }, cleared: 1, chars: 9000, tokens: 2500, resultTokens: 2500, inputTokens: 0, rows: 0, tools: [{ name: 'Read', calls: 1, tokens: 2500 }], policy: stamp },
  }
  const asked: any[] = [], wrote: any[] = []
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'read things' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(9000) }] },
    { role: 'user', content: [{ type: 'text', text: 'now this' }] },
  ]
  on('env.get', (_, e) => ({ value: e.name === 'THINKER_CLI' ? '/t/cli.js' : e.name === 'HOME' ? '/h' : undefined }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_, e) => { wrote.push(e); return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 300000 } } as any }))
  on('session.messages', () => ({ value: api as any }))
  on('store.get', () => ({ value: 1 }))
  on('command.register', () => ({ value: { command: 'x' } as any }))
  on('clock.after', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const ev = JSON.parse(String((e.init as any)?.stdin))
    asked.push({ argv: e.argv, ev })
    return { value: { exitCode: 0, stdout: JSON.stringify(answers[ev.op]) + '\n', stderr: '' } as any }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('session.compact', () => ({ skip: 'the engine, not the mod' }) as any)

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  expect(asked.map(a => a.ev.op)).toEqual(['start'])
  expect(asked[0].argv).toEqual(['node', '/t/cli.js', 'hook', 'clear', '--client', 'claude', '--user'])
  expect(asked[0].ev.session).toBe('s1')

  // a compaction the mod did not ask for is the engine's own
  expect(await $.session.compact({ trigger: 'manual', messages: rowsOf() } as any)).toEqual({ skip: 'the engine, not the mod' })

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as any)
  expect(asked.map(a => a.ev.op)).toEqual(['start', 'decide'])
  const decide = asked[1].ev
  expect(decide.from).toBe('auto')
  expect(decide.tokens).toBe(300000)
  expect(decide.cleared).toBe(false)
  expect(decide.model).toBe('claude-opus-5-5')
  // the live window goes with the question, as the rows the decision reads
  expect(decide.messages[2]).toEqual({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big(9000) }] })

  function rowsOf() { return [prompt('read things'), call('a'), result('a', big(9000)), prompt('now this')] as any[] }
  const messages = rowsOf()
  const r: any = await $.session.compact({ trigger: 'manual', messages } as any)
  expect(asked.map(a => a.ev.op)).toEqual(['start', 'decide', 'apply'])
  expect(asked[2].ev.depth).toBe(1)
  expect(asked[2].ev.from).toBe('auto')
  expect(r.messages[2].toolResults).toEqual([{ tool_use_id: 'a', text: 'gone: a' }])
  for (const i of [0, 1, 3]) expect(r.messages[i]).toEqual(messages[i])
  // the session's record names the policy the answer named: the version of the thinker that decided
  const record = JSON.parse(wrote.filter(w => String(w.path).includes('/state/compression/')).pop().text)
  expect(record.policy).toBe(stamp)
  expect(record.uses).toBe(1)
  expect(record.recent.length).toBe(1)
  expect(record.recent[0].cleared).toBe(2500)
  expect(record.kinds.results).toBe(2500)
  expect(record.policyChanged).toBe(undefined)
})

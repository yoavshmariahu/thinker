// Run with `claude plugin test src/integrations/claude-clear`; `npm test` never reaches this file.
// What to clear is the installed thinker's answer (src/clear-door.js, test/cutting.test.js). What is tested here
// is what only the mod can do: read the live window, hand it over, put the answer in place, and leave the
// conversation alone when no answer comes. Every hook below stands for the engine, and `process.run` for the
// installed CLI, so nothing here reaches a disk, a network or a model.
import { test, expect } from 'claude-code/testing'
import { applyPlan, answerOf, orderOf, reasonOf, pretoolEvent, REPORT_SLOT } from './register'

const big = (n: number) => 'x'.repeat(n)
const said = (text: string) => ({ role: 'user' as const, text, toolUses: [], handle: 'h' })
const call = (id: string, tool = 'Read') => ({ role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input: { file_path: '/r/core.py' } }], handle: 'h' })
const result = (id: string, text: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }], handle: 'h' })
const rowsOf = () => [said('read things'), call('a'), result('a', big(9000)), said('now this')] as any[]

// the engine and the installed CLI, both faked: `answers` is what thinker says to each question it is asked
function harness(on: any, answers: Record<string, any>, asked: any[], wrote: any[] = [], exitCode = 0) {
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'read things' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/r/core.py' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(9000) }] },
    { role: 'user', content: [{ type: 'text', text: 'now this' }] },
  ]
  on('env.get', (_: any, e: any) => ({ value: e.name === 'THINKER_CLI' ? '/t/cli.js' : e.name === 'HOME' ? '/h' : undefined }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_: any, e: any) => { wrote.push(e); return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 300000 } } as any }))
  on('session.messages', () => ({ value: api as any }))
  on('store.get', () => ({ value: 1 }))
  on('command.register', () => ({ value: { command: 'x' } as any }))
  on('clock.after', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    const ev = JSON.parse(String((e.init as any)?.stdin))
    asked.push(ev)
    return { value: { exitCode, stdout: answers[ev.op] === undefined ? '' : JSON.stringify(answers[ev.op]) + '\n', stderr: '' } as any }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }) as any)
  on('turn.complete', () => ({ text: 'done' }) as any)
  on('session.compact', () => ({ skip: 'the engine, not the mod' }) as any)
}

test('a turn that ends with the context past the trigger asks the installed thinker, and the clear it answers with is put in place', async ($, on) => {
  const stamp = 'v9.9.9-t140k-f8k-p25-deep'
  const asked: any[] = [], wrote: any[] = []
  harness(on, {
    start: { auto: true, policy: stamp },
    decide: { clear: true, depth: 1, askAt: 140000, hold: 60000, policy: stamp },
    apply: { replace: { a: 'gone: a' }, cleared: 1, chars: 9000, tokens: 2500, resultTokens: 2500, inputTokens: 0, rows: 0, tools: [{ name: 'Read', calls: 1, tokens: 2500 }], policy: stamp },
  }, asked, wrote)

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  expect(asked.map(a => a.op)).toEqual(['start'])
  expect(asked[0].session).toBe('s1')

  // a compaction the mod did not ask for is the engine's own
  expect(await $.session.compact({ trigger: 'manual', messages: rowsOf() } as any)).toEqual({ skip: 'the engine, not the mod' })

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as any)
  expect(asked.map(a => a.op)).toEqual(['start', 'decide'])
  expect(asked[1].tokens).toBe(300000)
  expect(asked[1].from).toBe('auto')
  expect(asked[1].model).toBe('claude-opus-5-5')
  // the live window goes with the question, so an earlier clear's placeholders are not counted again
  expect(asked[1].messages[2]).toEqual({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big(9000) }] })

  const messages = rowsOf()
  const r: any = await $.session.compact({ trigger: 'manual', messages } as any)
  expect(asked.map(a => a.op)).toEqual(['start', 'decide', 'apply'])
  expect(asked[2].depth).toBe(1)        // the rung the check chose, not everything eligible
  expect(r.messages[2].toolResults).toEqual([{ tool_use_id: 'a', text: 'gone: a' }])
  // and the session's record names the policy the answer named, which is the thinker that decided
  const record = JSON.parse(wrote.filter(w => String(w.path).includes('/state/compression/')).pop().text)
  expect(record.policy).toBe(stamp)
  expect(record.uses).toBe(1)
  expect(record.recent[0].cleared).toBe(2500)
})

test('a clear replaces the results it names and leaves every other row the row it was', () => {
  const messages = [said('read things'), call('a'), result('a', big(1000)), call('b', 'Bash'), result('b', big(2000)), said('now this'), call('c'), result('c', big(5000))]
  const rows = applyPlan(messages as any, { a: 'gone: a', b: 'gone: b' }) as any[]
  expect(rows.length).toBe(messages.length)
  expect(rows[2].toolResults).toEqual([{ tool_use_id: 'a', text: 'gone: a' }])
  expect(rows[4].toolResults[0].text).toBe('gone: b')
  for (const i of [0, 1, 3, 5, 6, 7]) expect(rows[i]).toBe(messages[i])   // the very row the engine handed over
  // a result beside a named one stays whole, an error stays an error, and the person's words are untouched
  // (the one beside it is named `constructor`, which every object answers to: that is not a result of this conversation)
  const two = [{ role: 'user' as const, text: 'note', toolUses: [], toolResults: [{ tool_use_id: 'x', text: big(900), isError: true as const }, { tool_use_id: 'constructor', text: big(700) }], handle: 'h' }]
  const one = (applyPlan(two as any, { x: 'gone' }) as any[])[0]
  expect(one.toolResults[0]).toEqual({ tool_use_id: 'x', text: 'gone', isError: true })
  expect(one.toolResults[1].text.length).toBe(700)
  expect(one.text).toBe('note')
  // a plan that names nothing changes nothing, and a name that is only an object's inherited key names nothing
  expect(applyPlan(messages as any, {})).toEqual(messages)
  const inherited = [result('constructor', big(900))] as any[]
  expect(applyPlan(inherited, {})[0]).toBe(inherited[0])
})

test('when the installed thinker says nothing, the conversation is left as it is', async ($, on) => {
  // nothing printed, an empty answer, or anything that is not one object: there is no answer
  expect(answerOf('{"clear":true,"depth":2}')).toEqual({ clear: true, depth: 2 })
  expect(answerOf('node: some warning\n{"auto":true}\n')).toEqual({ auto: true })   // the answer is the last line
  for (const out of ['', '{}', '[]', 'null', 'not json', '"words"']) expect(answerOf(out)).toBe(null)

  const asked: any[] = []
  harness(on, { start: { auto: true }, decide: { clear: true, depth: 1 } }, asked)   // no answer to `apply`
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as any)
  const messages = rowsOf()
  const r: any = await $.session.compact({ trigger: 'manual', messages } as any)
  expect(asked.map(a => a.op)).toEqual(['start', 'decide', 'apply'])
  expect(r.messages).toBe(undefined)                     // nothing is replaced on a guess
  expect(String(r.skip)).toContain('thinker')            // and the engine is told who skipped it
  expect(messages[2].toolResults[0].text.length).toBe(9000)
})

test('a read the installed thinker takes over comes back as an order for the harness\'s own subagent', () => {
  // what the call looks like when it goes to the rule: the tool's own arguments, and that the host will run it
  const ev: any = pretoolEvent({ tool: 'Read', tool_use_id: 't1', file_path: '/r/core.py', offset: 3 }, { session: 's', cwd: '/r', turn: 'turn-1', prompt: 'where is it?' })
  expect(ev.tool_input).toEqual({ file_path: '/r/core.py', offset: 3 })
  expect(ev.host_runs).toBe(true)
  expect(ev.prompt_id).toBe('turn-1')
  // an order the host can run: an agent to spawn, a brief, and somewhere to put the report
  const order = { agent: 'Explore', prompt: 'brief', wrap: `thinker read core.py through a subagent.\n\n${REPORT_SLOT}` }
  expect(orderOf(JSON.stringify({ hookSpecificOutput: {}, thinkerRun: order }))).toEqual(order)
  expect(orderOf(JSON.stringify({ thinkerRun: { agent: 'Explore', prompt: 'brief', wrap: 'nowhere to put it' } }))).toBe(null)
  expect(orderOf('')).toBe(null)
  // and a denial with no order is the answer itself: the words go back to the model, nothing is spawned
  const deny = (r: string) => JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: r } })
  expect(reasonOf(deny('you have this file already'))).toBe('you have this file already')
  expect(reasonOf(JSON.stringify({ ...JSON.parse(deny('words')), thinkerRun: order }))).toBe(null)
  expect(reasonOf(deny(''))).toBe(null)
  expect(reasonOf('{}')).toBe(null)
})

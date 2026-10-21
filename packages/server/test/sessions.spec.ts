import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { stage, view } from '@docent/core'
import type { RawEvent } from '@docent/core'

import { findTranscript, foldTranscript, startSessionFeed, transcriptEvents } from '../src/sessions/index.ts'
import type { SessionFeed, SessionUpdate } from '../src/sessions/index.ts'
import { argsOf, previewOf } from '../src/sessions/args.ts'
import { TranscriptFold } from '../src/sessions/fold.ts'
import { LineTail } from '../src/sessions/tail.ts'

// Synthetic transcripts only: test/fixtures is a made-up session (make-session-basic.mjs writes it), the
// other rows are built below. Every feed runs on a temp config dir, never the real ~/.claude.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SID = '5f1c2a9e-7b3d-4e8f-9a6b-0c1d2e3f4a5b'
const AGENT = 'a3f9c27e51b04d68'
const CWD = '/tmp/demo-repo'
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
const at = (s: number): number => T0 + Math.round(s * 1000)

const mainText = await readFile(join(FIXTURES, 'session-basic.jsonl'), 'utf8')
const helperText = await readFile(join(FIXTURES, 'session-basic', 'subagents', `agent-${AGENT}.jsonl`), 'utf8')
const mainLines = mainText.split('\n').filter(l => l !== '')
const lineOf = (uuid: string): number => mainLines.findIndex(l => l.includes(`"uuid":"${uuid}"`))
/** the fixture's main file up to and including the row `uuid` */
const upTo = (uuid: string): string => `${mainLines.slice(0, lineOf(uuid) + 1).join('\n')}\n`
/** the rows after `uuid` up to and including `last` */
const between = (uuid: string, last?: string): string => `${mainLines.slice(lineOf(uuid) + 1, last === undefined ? undefined : lineOf(last) + 1).join('\n')}\n`

const fold = (main: string, now = at(120)): SessionUpdate => foldTranscript(main, { sid: SID, cwd: CWD, subagents: { [AGENT]: helperText }, now })
const atOf = (e: RawEvent): number => (e.kind === 'tool-start' ? e.obs.at : e.kind === 'tool-end' ? e.end.at : e.at)
const shape = (u: SessionUpdate): string[][] => u.model.steps.map(s => [s.tool, s.station, s.status, ...(s.agentId === undefined ? [] : [s.agentId])])

// ---- synthetic rows for the cases the fixture does not hold

let seq = 0
type Extra = { [k: string]: unknown }
const row = (type: string, s: number, extra: Extra): string => JSON.stringify({ parentUuid: null, isSidechain: false, cwd: CWD, sessionId: SID, type, uuid: `x${++seq}`, timestamp: new Date(at(s)).toISOString(), ...extra })
const userRow = (s: number, content: unknown, extra: Extra = {}): string => row('user', s, { message: { role: 'user', content }, ...extra })
const toolUse = (s: number, id: string, name: string, input: Extra, msg = `m-${id}`): string =>
  row('assistant', s, { message: { id: msg, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } } })
const said = (s: number, text: string, msg = `m-${s}`): string => row('assistant', s, { message: { id: msg, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } })
const toolResult = (s: number, id: string, content: unknown, extra: Extra = {}): string => userRow(s, [{ type: 'tool_result', tool_use_id: id, content }], extra)
const turnDuration = (s: number, ms: number): string => row('system', s, { subtype: 'turn_duration', durationMs: ms })
const text = (...rows: string[]): string => `${rows.join('\n')}\n`

// ---------------------------------------------------------------- folding a whole transcript

test('a transcript folds into the steps the mod would show', () => {
  const u = fold(mainText)
  assert.deepEqual(shape(u), [
    // turn 1: the request, the search, a partial read, an edit, a failing run, a fix, a passing run, a helper, a refused commit, the answer
    ['#prompt', 'think', 'ok'],
    ['Grep', 'search', 'ok'],
    ['Read', 'read', 'ok'],
    ['Edit', 'edit', 'ok'],
    ['Bash', 'run', 'error'],
    ['Edit', 'edit', 'ok'],
    ['Bash', 'run', 'ok'],
    ['Agent', 'delegate', 'ok'],
    ['Grep', 'search', 'ok', AGENT],
    ['Read', 'read', 'ok', AGENT],
    ['Bash', 'run', 'denied'],
    ['#talk', 'talk', 'ok'],
    ['#done', 'done', 'ok'],
    // turn 2: interrupted after a Write
    ['#prompt', 'think', 'ok'],
    ['Write', 'edit', 'ok'],
    ['#done', 'done', 'denied'],
    // then a local command (/cost): no turn, no step
  ])
  // the duplicated prompt row is read once: two turns, not three
  assert.deepEqual(u.model.stats, { steps: 11, edits: 3, commands: 3, errors: 1, turns: 2, startedAt: T0 })
  const steps = u.model.steps
  assert.deepEqual(
    steps.filter(s => s.tool === '#prompt').map(s => s.target),
    ['Fix the failing test in src/math.ts', 'Now add a test for divide(-6, 3)'],
  )
  assert.deepEqual(u.model.goal?.text, 'Now add a test for divide(-6, 3)')
  assert.equal(steps.find(s => s.tool === 'Read' && s.agentId === undefined)?.detail, 'lines 10–29')
  assert.match(steps.find(s => s.tool === 'Bash')?.resultNote ?? '', /Missing expected exception/)
  assert.match(steps.find(s => s.tool === '#talk')?.resultNote ?? '', /^Fixed: divide\(\) now divides/)
  assert.equal(steps.find(s => s.tool === '#done' && s.status === 'denied')?.resultNote, 'Interrupted')
  // the CLI's synthetic reply and the system reminder never reach the model
  const all = JSON.stringify(u.model)
  assert.ok(!all.includes('No response requested'))
  assert.ok(!all.includes('system-reminder'))
  assert.deepEqual(u.model.turn, { id: 'u2', startedAt: at(60), isRunning: false, endedAt: at(66) })
  assert.equal(u.sid, SID)
  assert.equal(u.at, at(120))
  assert.equal(u.transcript, undefined)
})

test('the helper runs in its own lane, tied to the Agent call by its prompt', () => {
  const u = fold(upTo('d1'), at(40)) // turn 1 only: the next turn clears finished lanes
  assert.equal(u.model.agents.length, 1)
  const lane = u.model.agents[0]!
  assert.deepEqual({ id: lane.id, label: lane.label, type: lane.type, status: lane.status, startedAt: lane.startedAt }, { id: AGENT, label: 'Check other callers of divide', type: 'Explore', status: 'done', startedAt: at(20.3) })
  const agent = u.model.steps.find(s => s.tool === 'Agent')
  assert.equal(agent?.scene.kind, 'delegate')
  if (agent?.scene.kind === 'delegate') assert.deepEqual(agent.scene.agents.map(a => [a.label, a.type, a.status]), [['Check other callers of divide', 'Explore', 'ok']])
  assert.deepEqual(
    u.model.steps.filter(s => s.agentId === AGENT).map(s => [s.tool, s.station, s.status]),
    [['Grep', 'search', 'ok'], ['Read', 'read', 'ok']],
  )
  // the stage renders from the folded model
  const svg = stage.renderStage(view.stageInput(u.model, { level: 1, isPaused: false, useModel: false, autoOpen: false }, at(40), CWD))
  assert.match(svg, /^<svg/)
})

test('inputs keep what Step does not: read ranges, edit text, writes', () => {
  const u = fold(mainText)
  assert.deepEqual(u.inputs, {
    toolu_read: { path: `${CWD}/src/math.ts`, offset: 10, limit: 20 },
    toolu_edit: { path: `${CWD}/src/math.ts`, edits: [{ old: '  return a * b', new: '  return a / b' }] },
    toolu_edit2: { path: `${CWD}/src/math.ts`, edits: [{ old: '  return a / b', new: "  if (b === 0) throw new RangeError('division by zero')\n  return a / b" }] },
    toolu_a_read: { path: `${CWD}/src/stats.ts` },
    toolu_write: { path: `${CWD}/test/divide-negative.test.ts`, isWrite: true },
  })
  // every key is a step still in the model
  for (const id of Object.keys(u.inputs)) assert.ok(u.model.steps.some(s => s.id === id), id)
})

test('inputs of steps the model dropped are dropped too', () => {
  // 90 reads: the model keeps 80 steps, so the oldest reads and their inputs go
  const rows = [userRow(0, 'Read everything', { origin: { kind: 'human' } })]
  for (let i = 0; i < 90; i++) rows.push(toolUse(1 + i, `r${i}`, 'Read', { file_path: `${CWD}/f${i}.ts`, offset: 1, limit: 5 }), toolResult(1.5 + i, `r${i}`, 'ok'))
  const u = foldTranscript(text(...rows), { sid: SID, cwd: CWD, now: at(200) })
  const ids = Object.keys(u.inputs)
  assert.ok(ids.length > 0 && ids.length < 90, String(ids.length))
  assert.ok(!ids.includes('r0'))
  assert.ok(ids.includes('r89'))
  for (const id of ids) assert.ok(u.model.steps.some(s => s.id === id), id)
})

test('usage: the last row of a message wins, helpers count, <synthetic> does not', () => {
  const u = fold(mainText)
  assert.deepEqual(u.usage.byModel, {
    'claude-opus-5-5': { input: 29700, output: 860, cacheRead: 53890, cacheWrite: 7020, messages: 10 },
    'claude-haiku-4-5': { input: 3400, output: 150, cacheRead: 2400, cacheWrite: 1200, messages: 3 },
  })
  assert.deepEqual(u.usage.total, { input: 33100, output: 1010, cacheRead: 56290, cacheWrite: 8220, messages: 13 })
})

test('turn usage starts again at the next human prompt (a local command does not reset it)', () => {
  const first = fold(upTo('d1'), at(40))
  assert.deepEqual(first.usage.turn, { input: 28300, output: 850, cacheRead: 49770, cacheWrite: 7720, messages: 12 })
  assert.deepEqual(first.usage.total, { ...first.usage.turn })
  const all = fold(mainText)
  // after "Now add a test ...": only msg_10 (the /cost command that follows is no human prompt)
  assert.deepEqual(all.usage.turn, { input: 4800, output: 160, cacheRead: 6520, cacheWrite: 500, messages: 1 })
})

// ---------------------------------------------------------------- rows to events

test('rows become the events the hooks push: turns, blocks, tools, the helper', () => {
  const events = transcriptEvents(mainText, { [AGENT]: helperText })
  const times = events.map(atOf)
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'merged in time order')
  const kinds = (k: RawEvent['kind']) => events.filter(e => e.kind === k)
  // a turn starts at its prompt and ends at turn_duration or an interrupt
  assert.deepEqual(
    kinds('turn-start').map(e => e.kind === 'turn-start' && [e.turnId, e.at]),
    [['u1', at(0)], ['u2', at(60)]],
  )
  assert.deepEqual(
    kinds('turn-end').map(e => e.kind === 'turn-end' && [e.turnId, e.reason, e.durationMs, e.at]),
    [['u1', 'completed', 31500, at(31.5)], ['u2', 'aborted', 6000, at(66)]],
  )
  const end1 = kinds('turn-end')[0]
  assert.ok(end1?.kind === 'turn-end' && end1.answer.startsWith('Fixed: divide() now divides') && end1.answer.length <= 600)
  assert.deepEqual(
    kinds('prompt').map(e => e.kind === 'prompt' && [e.origin, e.text]),
    [['human', 'Fix the failing test in src/math.ts'], ['human', 'Now add a test for divide(-6, 3)']],
  )
  // each thinking or text block streams, then lands
  const firstBlocks = events.filter(e => (e.kind === 'stream' || e.kind === 'think' || e.kind === 'say') && atOf(e) <= at(3.4))
  assert.deepEqual(firstBlocks.map(e => (e.kind === 'stream' ? `stream:${e.mode}` : e.kind)), ['stream:thinking', 'think', 'stream:text', 'say'])
  const ends = new Map(kinds('tool-end').map(e => (e.kind === 'tool-end' ? [e.end.id, e.end.status] : ['', ''])))
  assert.equal(ends.get('toolu_test1'), 'error')
  assert.equal(ends.get('toolu_commit'), 'denied')
  assert.equal(ends.get('toolu_test2'), 'ok')
  const start = kinds('agent-start')[0]
  assert.deepEqual(start, { kind: 'agent-start', agentId: AGENT, type: 'Explore', description: 'Check other callers of divide', toolUseId: 'toolu_agent', background: false, at: at(20.3) })
  assert.deepEqual(kinds('agent-stop'), [{ kind: 'agent-stop', agentId: AGENT, at: at(24.5) }])
  const helperEvents = events.filter(e => (e.kind === 'tool-start' ? e.obs.agentId : 'agentId' in e ? e.agentId : undefined) === AGENT)
  assert.ok(helperEvents.every(e => atOf(e) >= at(20.3) && atOf(e) <= at(24.5)))
  assert.ok(!events.some(e => e.kind === 'prompt' && e.text.includes(AGENT)), 'a helper prompt is no prompt of the session')
})

test('tool arguments and results follow the hooks: reserved keys out, long strings cut, long commands keep their tail', () => {
  const long = `echo ${'a'.repeat(5000)} && npm test`
  const args = argsOf({ command: long, tool: 'Bash', tool_use_id: 'x', agentId: 'y', requestMeta: {}, consent: true, note: 'b'.repeat(5000), deep: { a: { b: { c: { d: { e: 1 } } } } } })
  assert.deepEqual(Object.keys(args).sort(), ['command', 'deep', 'note'])
  assert.equal((args.command as string).length, 4000)
  assert.ok((args.command as string).endsWith('&& npm test'))
  assert.equal((args.note as string).length, 4000)
  assert.deepEqual(args.deep, { a: { b: { c: {} } } })
  assert.equal(previewOf([{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }]), 'one\ntwo')
  assert.equal(previewOf('c'.repeat(2000)).length, 1500)
})

test('prompts: slash commands, shell input and engine prompts are read; local commands, meta rows and command output are not', () => {
  const events = transcriptEvents(
    text(
      userRow(0, '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src/x.ts</command-args>', { origin: { kind: 'human' } }),
      userRow(1, 'Expanded /review instructions', { isMeta: true }),
      userRow(2, '<bash-input>git status</bash-input>'),
      userRow(3, '<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>'),
      userRow(4, 'A message from the planner agent', { isMeta: true, origin: { kind: 'peer', from: 'planner' }, promptSource: 'system' }),
      userRow(5, 'Continue from where you left off.', { isMeta: true, origin: { kind: 'auto-continuation' }, promptSource: 'system' }),
      userRow(6, [{ type: 'image', source: { type: 'base64', data: '' } }, { type: 'text', text: 'What is wrong in this screenshot?' }], { origin: { kind: 'human' }, promptSource: 'typed' }),
      userRow(7, '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>'),
      userRow(8, 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      userRow(9, '<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>'),
      userRow(9.1, '<local-command-stdout>Total cost: $0.21</local-command-stdout>'),
    ),
  )
  assert.deepEqual(
    events.filter(e => e.kind === 'prompt').map(e => e.kind === 'prompt' && [e.origin, e.text]),
    [
      ['command', '/review src/x.ts'],
      ['bash', '!git status'],
      ['peer', 'A message from the planner agent'],
      ['auto-continuation', 'Continue from where you left off.'],
      ['human', 'What is wrong in this screenshot?'],
    ],
  )
})

test('notifications that come in a burst are answered in one turn', () => {
  const note = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${id}" completed</summary>\n</task-notification>`
  const main = text(
    userRow(0, note('x1'), { origin: { kind: 'task-notification' }, promptSource: 'system', queueTranscriptOnly: true }),
    userRow(0.2, note('x2'), { origin: { kind: 'task-notification' }, promptSource: 'system', queueTranscriptOnly: true }),
    userRow(0.3, note('x3'), { origin: { kind: 'task-notification' }, promptSource: 'system' }),
    said(3, 'All three helpers are done.'),
    turnDuration(3.5, 3500),
  )
  const events = transcriptEvents(main)
  assert.deepEqual(
    events.filter(e => e.kind === 'prompt' || e.kind === 'turn-start' || e.kind === 'turn-end').map(e => e.kind),
    ['prompt', 'turn-start', 'prompt', 'prompt', 'turn-end'],
  )
  const u = foldTranscript(main, { sid: SID, cwd: CWD, now: at(10) })
  assert.equal(u.model.stats.turns, 1)
  assert.equal(u.model.steps.filter(s => s.tool === '#done').length, 1)
})

test('a background helper keeps running past its launch result, until its task-notification', () => {
  const prompt = 'Scan the repo for TODO comments and list them.'
  const main = text(
    userRow(0, 'Look for TODOs while you fix the bug', { origin: { kind: 'human' } }),
    toolUse(1, 'toolu_bg', 'Agent', { description: 'Scan for TODOs', prompt, subagent_type: 'general-purpose', run_in_background: true }),
    toolResult(1.2, 'toolu_bg', [{ type: 'text', text: 'Async agent launched successfully.' }], { toolUseResult: { status: 'async_launched', agentId: 'bg1', isAsync: true, description: 'Scan for TODOs', prompt } }),
    said(2, 'The scan runs in the background; I will look at the bug meanwhile.'),
    turnDuration(2.5, 2500),
    userRow(9, '<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Agent "Scan for TODOs" completed</summary>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system', isMeta: false }),
    said(10, 'The scan found two TODOs.'),
    turnDuration(10.5, 1500),
  )
  const helper = text(userRow(1.3, prompt, { isSidechain: true, agentId: 'bg1' }), toolUse(4, 'toolu_bg_grep', 'Grep', { pattern: 'TODO' }), toolResult(5, 'toolu_bg_grep', 'src/a.ts:3: // TODO'), said(8, 'Two TODOs.'))
  const events = transcriptEvents(main, { bg1: helper })
  assert.deepEqual(
    events.filter(e => e.kind === 'agent-start' || e.kind === 'agent-stop').map(e => [e.kind, atOf(e)]),
    [['agent-start', at(1.3)], ['agent-stop', at(9)]],
  )
  const start = events.find(e => e.kind === 'agent-start')
  assert.ok(start?.kind === 'agent-start' && start.background && start.toolUseId === 'toolu_bg')
  assert.ok(events.some(e => e.kind === 'prompt' && e.origin === 'task-notification'))
  // while the main turn ended, the helper still works
  const before = foldTranscript(main.split('\n').slice(0, 5).join('\n'), { sid: SID, cwd: CWD, subagents: { bg1: helper }, now: at(8.5) })
  assert.equal(before.model.agents.find(l => l.id === 'bg1')?.status, 'running')
  const after = foldTranscript(main, { sid: SID, cwd: CWD, subagents: { bg1: helper }, now: at(11) })
  assert.equal(after.model.agents.find(l => l.id === 'bg1')?.status, 'done')
})

test('a helper is done when it hands its report back: its own SubagentHandback, or a peer message with handback', () => {
  const launch = (s: number, id: string, agentId: string, prompt: string): string[] => [
    toolUse(s, id, 'Agent', { description: `Helper ${agentId}`, prompt, subagent_type: 'general-purpose' }),
    toolResult(s + 0.1, id, [{ type: 'text', text: 'Async agent launched successfully.' }], { toolUseResult: { status: 'async_launched', agentId, isAsync: true } }),
  ]
  const main = text(
    userRow(0, 'Ask two helpers', { origin: { kind: 'human' } }),
    ...launch(1, 'toolu_h1', 'h1', 'First question.'),
    ...launch(1.5, 'toolu_h2', 'h2', 'Second question.'),
    said(2, 'Both are working.'),
    turnDuration(2.2, 2200),
    userRow(7, 'Report from h2: all clear.', { isMeta: true, origin: { kind: 'peer', from: 'h2', senderTaskId: 'h2', handback: true, handbackReportText: 'all clear' }, promptSource: 'system' }),
  )
  const h1 = text(userRow(1.2, 'First question.'), toolUse(3, 'toolu_h1_back', 'SubagentHandback', { report: 'done' }), toolResult(3.4, 'toolu_h1_back', 'Report delivered.'))
  const h2 = text(userRow(1.7, 'Second question.'), toolUse(4, 'toolu_h2_grep', 'Grep', { pattern: 'x' }), toolResult(4.2, 'toolu_h2_grep', 'none'))
  const events = transcriptEvents(main, { h1, h2 })
  assert.deepEqual(
    events.filter(e => e.kind === 'agent-start' || e.kind === 'agent-stop').map(e => (e.kind === 'agent-start' || e.kind === 'agent-stop') && [e.kind, e.agentId, atOf(e)]),
    [['agent-start', 'h1', at(1.2)], ['agent-start', 'h2', at(1.7)], ['agent-stop', 'h1', at(3.4)], ['agent-stop', 'h2', at(7)]],
  )
  const mid = foldTranscript(main.split('\n').slice(0, 7).join('\n'), { sid: SID, cwd: CWD, subagents: { h1, h2 }, now: at(5) })
  assert.deepEqual(mid.model.agents.map(l => [l.id, l.status]), [['h1', 'done'], ['h2', 'running']])
})

test('a helper whose prompt matches no call is tied to the oldest call without one', () => {
  const main = text(userRow(0, 'Split the work', { origin: { kind: 'human' } }), toolUse(1, 'toolu_one', 'Agent', { description: 'First part', prompt: 'Do the first part.', subagent_type: 'Plan' }))
  const helper = text(userRow(1.5, 'Do the first part. (reworded by the CLI)'), toolUse(2, 'toolu_h', 'Glob', { pattern: '**/*.ts' }))
  const start = transcriptEvents(main, { h1: helper }).find(e => e.kind === 'agent-start')
  assert.deepEqual(start, { kind: 'agent-start', agentId: 'h1', type: 'Plan', description: 'First part', toolUseId: 'toolu_one', background: false, at: at(1.5) })
})

test('two calls with one prompt: the result that names a helper decides whose lane it is', () => {
  // parallel reviewers given the same words; the helpers' files are read by name, so the security
  // reviewer's (aa-sec) comes first although the code review was called first
  const prompt = 'Review the diff on this branch and report problems.'
  const main = text(
    userRow(0, 'Review my branch twice', { origin: { kind: 'human' } }),
    toolUse(1, 'toolu_code', 'Agent', { description: 'Code review', prompt, subagent_type: 'code-reviewer' }),
    toolUse(1.1, 'toolu_sec', 'Agent', { description: 'Security review', prompt, subagent_type: 'security-reviewer' }),
    toolResult(9, 'toolu_code', [{ type: 'text', text: 'No problems found.' }], { toolUseResult: { status: 'completed', agentId: 'zz-code' } }),
  )
  const subagents = { 'aa-sec': text(userRow(1.2, prompt)), 'zz-code': text(userRow(1.3, prompt)) }
  const u = foldTranscript(main, { sid: SID, cwd: CWD, subagents, now: at(10) })
  // the code review's result names zz-code: that lane is the code review, and done; the security review still works
  assert.deepEqual(
    u.model.agents.map(l => [l.id, l.label, l.status]).sort(),
    [
      ['aa-sec', 'Security review', 'running'],
      ['zz-code', 'Code review', 'done'],
    ],
  )
})

test('a helper shown before its call was read is named by that call once it is', () => {
  // the helper's first rows reach the disk before its parent's Agent row, and two read cycles pass: the
  // fold shows it as an unnamed lane. The call's row, with the very same prompt, must then name it.
  const prompt = 'Find the callers of divide().'
  const tf = new TranscriptFold()
  tf.addHelper('h1', [userRow(1.2, prompt)])
  const first = tf.take(false)
  tf.addHelper('h1', [toolUse(1.5, 'toolu_h1_grep', 'Grep', { pattern: 'divide' })])
  const second = tf.take(false)
  tf.addMain([userRow(0, 'Check divide', { origin: { kind: 'human' } }), toolUse(1, 'toolu_x', 'Agent', { description: 'Find callers', prompt, subagent_type: 'Explore' })])
  const starts = [...first, ...second, ...tf.take(false)].filter(e => e.kind === 'agent-start')
  assert.deepEqual(starts.at(-1), { kind: 'agent-start', agentId: 'h1', type: 'Explore', description: 'Find callers', toolUseId: 'toolu_x', background: false, at: at(1.2) })
})

// ---------------------------------------------------------------- finding and tailing files

async function tempConfig(t: TestContext): Promise<{ configDir: string; projectDir: string; file: string; helperFile: string }> {
  const configDir = await mkdtemp(join(tmpdir(), 'docent-sessions-'))
  t.after(() => rm(configDir, { recursive: true, force: true }))
  const projectDir = join(configDir, 'projects', '-tmp-demo-repo')
  await mkdir(projectDir, { recursive: true })
  await mkdir(join(configDir, 'projects', '-tmp-other'), { recursive: true })
  return { configDir, projectDir, file: join(projectDir, `${SID}.jsonl`), helperFile: join(projectDir, SID, 'subagents', `agent-${AGENT}.jsonl`) }
}

test('findTranscript looks in every project dir of the config dir, by name', async t => {
  const { configDir, file } = await tempConfig(t)
  assert.equal(await findTranscript(SID, configDir), undefined)
  await writeFile(file, '')
  assert.equal(await findTranscript(SID, configDir), file)
  assert.equal(await findTranscript('00000000-0000-4000-8000-000000000000', configDir), undefined)
  assert.equal(await findTranscript('../../etc/passwd', configDir), undefined)
  assert.equal(await findTranscript(SID, join(configDir, 'missing')), undefined)
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    assert.equal(await findTranscript(SID), file)
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
})

test('LineTail hands out whole lines: a split character waits, a shrink starts over', async t => {
  const { projectDir } = await tempConfig(t)
  const path = join(projectDir, 'tail.jsonl')
  const tail = new LineTail(path)
  assert.deepEqual(await tail.read(1024), { lines: [], reset: false, more: false })
  const check = Buffer.from('✔')
  await writeFile(path, Buffer.concat([Buffer.from('one\n{"x":"'), check.subarray(0, 2)]))
  assert.deepEqual(await tail.read(1024), { lines: ['one'], reset: false, more: false })
  await appendFile(path, Buffer.concat([check.subarray(2), Buffer.from('"}\ntwo\nthr')]))
  assert.deepEqual(await tail.read(1024), { lines: ['{"x":"✔"}', 'two'], reset: false, more: false })
  await appendFile(path, 'ee\n')
  assert.deepEqual(await tail.read(1024), { lines: ['three'], reset: false, more: false })
  await writeFile(path, 'new\n')
  assert.deepEqual(await tail.read(1024), { lines: ['new'], reset: true, more: false })
  await appendFile(path, 'a\nb\nc\n')
  assert.deepEqual(await tail.read(3), { lines: ['a'], reset: false, more: true })
  assert.deepEqual(await tail.read(1024), { lines: ['b', 'c'], reset: false, more: false })
})

/** Waits until the feed's latest update passes `ok`; fails with what it last saw. */
async function until(feed: SessionFeed, what: string, ok: (u: SessionUpdate) => boolean, ms = 6000): Promise<SessionUpdate> {
  const end = Date.now() + ms
  for (;;) {
    const u = feed.current()
    if (u !== undefined && ok(u)) return u
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last update: ${u === undefined ? 'none' : JSON.stringify(shape(u))}`)
    await sleep(20)
  }
}

/** The handles a closed feed must not leave behind (timers, fs watchers). */
const liveHandles = (): string[] => process.getActiveResourcesInfo().filter(r => r === 'Timeout' || r === 'FSEventWrap' || r === 'StatWatcher')

test('the feed tails a transcript written bit by bit, sees a helper appear, and survives truncation', async t => {
  const { configDir, file, helperFile } = await tempConfig(t)
  const handlesBefore = liveHandles().length
  const updates: SessionUpdate[] = []
  const logs: string[] = []
  const feed = await startSessionFeed({ sid: SID, cwd: CWD, configDir, tickMs: 40, onUpdate: u => updates.push(u), log: m => logs.push(m) })
  try {
    // nothing until Claude Code writes the transcript
    await sleep(700)
    assert.equal(feed.transcript, undefined)
    assert.equal(feed.current(), undefined)
    assert.equal(updates.length, 0)

    // the prompt and the first two blocks, then half of the Grep row
    const grepRow = mainLines[lineOf('a3')]!
    await writeFile(file, `${upTo('a2')}${grepRow.slice(0, 200)}`)
    const u1 = await until(feed, 'the prompt', u => u.model.goal?.text === 'Fix the failing test in src/math.ts')
    assert.equal(feed.transcript, file)
    assert.equal(u1.transcript, file)
    assert.ok(!u1.model.steps.some(s => s.tool === 'Grep'), 'half a row is not read')
    assert.equal(u1.model.said?.text, "I'll find the failing test first.")

    // the rest of the row, and the work up to the Agent call
    await appendFile(file, `${grepRow.slice(200)}\n${between('a3', 'a11')}`)
    await until(feed, 'the Agent call', u => u.model.steps.some(s => s.tool === 'Agent' && s.status === 'running'))

    // the helper's transcript appears and is read into its lane
    await mkdir(dirname(helperFile), { recursive: true })
    await writeFile(helperFile, helperText)
    const u3 = await until(feed, 'the helper lane', u => u.model.agents.some(l => l.id === AGENT) && u.model.steps.some(s => s.agentId === AGENT && s.tool === 'Read'))
    assert.equal(u3.model.agents.find(l => l.id === AGENT)?.status, 'running')
    assert.equal(u3.model.agents.find(l => l.id === AGENT)?.label, 'Check other callers of divide')

    // the main file says it finished, and the turn ends
    await appendFile(file, between('a11', 'd1'))
    const u4 = await until(feed, 'the end of the turn', u => u.model.turn?.isRunning === false && u.model.steps.some(s => s.tool === '#done'))
    assert.equal(u4.model.agents.find(l => l.id === AGENT)?.status, 'done')
    assert.deepEqual(shape(u4), shape(fold(upTo('d1'), at(40))))
    assert.deepEqual(u4.usage, fold(upTo('d1'), at(40)).usage)
    assert.deepEqual(u4.inputs, fold(upTo('d1'), at(40)).inputs)

    // the file is cut back to its first prompt: the feed starts over with a fresh model
    await writeFile(file, upTo('u1'))
    const u5 = await until(feed, 'the fresh model', u => u.model.stats.turns === 1 && !u.model.steps.some(s => s.agentId === undefined && s.tool === 'Grep'))
    assert.equal(u5.model.goal?.text, 'Fix the failing test in src/math.ts')
    assert.ok(logs.some(m => m.includes('again from the start')), logs.join('\n'))

    // and it goes on tailing
    await appendFile(file, between('u1', 'a3'))
    await until(feed, 'tailing after the restart', u => u.model.steps.some(s => s.agentId === undefined && s.tool === 'Grep'))
    // never a blank model in between: the restarted one is shown once it was read again
    assert.ok(updates.every(u => u.model.steps.length > 0 && u.model.goal !== undefined))
  } finally {
    await feed.close()
  }
  await feed.close() // idempotent
  const count = updates.length
  await sleep(150)
  assert.equal(updates.length, count, 'no update after close')
  assert.ok(liveHandles().length <= handlesBefore, `left behind: ${liveHandles().join(', ')}`)
})

test('a transcript already there (claude --resume) is folded whole before it is shown', async t => {
  const { configDir, file, helperFile } = await tempConfig(t)
  await writeFile(file, mainText)
  await mkdir(dirname(helperFile), { recursive: true })
  await writeFile(helperFile, helperText)
  const updates: SessionUpdate[] = []
  const feed = await startSessionFeed({ sid: SID, cwd: CWD, configDir, onUpdate: u => updates.push(u) })
  try {
    const u = await until(feed, 'the resumed session', () => true)
    assert.equal(updates.length, 1)
    assert.deepEqual(shape(u), shape(fold(mainText)))
    assert.deepEqual(u.usage, fold(mainText).usage)
    assert.deepEqual(u.inputs, fold(mainText).inputs)
    // nothing new: no more updates beyond the hop settling
    await sleep(2200)
    assert.ok(updates.length <= 2, String(updates.length))
  } finally {
    await feed.close()
  }
})

test('a feed whose transcript never comes closes cleanly', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'docent-sessions-'))
  try {
    const before = liveHandles().length
    const feed = await startSessionFeed({ sid: SID, cwd: CWD, configDir, onUpdate: () => assert.fail('no transcript, no update') })
    await sleep(600)
    assert.equal(feed.transcript, undefined)
    await feed.close()
    assert.ok(liveHandles().length <= before, liveHandles().join(', '))
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

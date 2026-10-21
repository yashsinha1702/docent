// Tests for the watch panel's pure modules, run with Node 22's type stripping from outside the repo
// (a spec under src/renderer would be type-checked against the DOM-only web tsconfig).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { timeline } from '@docent/core'
import type { RawEvent, SessionModel, Step } from '@docent/core'

import { WHOLE_FILE_LINES } from '../src/renderer/src/editor/follow.ts'
import { enabledActions, fallbackActions, mayUseShortcut, shortcutAction } from '../src/renderer/src/watch/actions.ts'
import { MOD_GRACE_MS, PICKER_MAX, choosePanelView, chooseSession, newestFirst, pickerSessions, transcriptSource } from '../src/renderer/src/watch/choose.ts'
import { asText, levelName, levelOf, narratorName, narrationLabel, sessionLabel, staleText, stationColor, tilde } from '../src/renderer/src/watch/format.ts'
import { escapeHtml, renderInline, renderMarkdown } from '../src/renderer/src/watch/markdown.ts'
import { compactNumber, countsText, modelNames, sessionCounts, tokensText, turnCounts, turnElapsed, turnView } from '../src/renderer/src/watch/stats.ts'
import { STEPS_MAX, relTime, stepRows, stepTarget } from '../src/renderer/src/watch/stepRows.ts'
import { useWatchStore } from '../src/renderer/src/watch/store.ts'
import { advanceCard, anotherCard, cardMarkdown, fallbackView, lessonCandidates } from '../src/renderer/src/watch/transcript.ts'
import type { FallbackCard } from '../src/renderer/src/watch/transcript.ts'
import { isAbsolutePath, pathKey, workspacePath } from '../src/renderer/src/tree/paths.ts'
import type { Snapshot } from '../../server/src/pairwatch/types.ts'
import type { SessionUsage, StepInput, TokenCounts, WatchHostStatus, WatchSession } from '../src/shared/ipc.ts'

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  v: 1,
  sid: 'sid-1',
  cwd: '/Users/yash/code/docent',
  svg: '<svg/>',
  alt: 'alt',
  head: 'head',
  lesson: '',
  ask: '',
  goal: '',
  goalText: '',
  recent: '',
  note: '',
  station: 'edit',
  status: 'ok',
  isPaused: false,
  isAsking: false,
  hasLesson: true,
  level: 1,
  narrationSource: 'model',
  narrator: 'haiku',
  at: 1000,
  ...over,
})
const session = (sid: string, over: Partial<Snapshot> = {}, updatedAt = 1000): WatchSession => ({ sid, snapshot: snap({ sid, ...over }), updatedAt })
const map = (...list: WatchSession[]) => new Map(list.map(s => [s.sid, s]))

// ---- markdown

test('inline: emphasis, code, links; everything else escaped', () => {
  assert.equal(renderInline('**b** *i* _u_ `c<d>` [t](https://x.y/z?a=1&b=2)'), '<strong>b</strong> <em>i</em> <em>u</em> <code>c&lt;d&gt;</code> <a href="https://x.y/z?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">t</a>')
  assert.equal(renderInline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(renderInline('a `b` c'), 'a <code>b</code> c')
  assert.equal(renderInline('`` a`b ``'), '<code>a`b</code>')
  assert.equal(renderInline('\\*not em\\* and \\_nor this\\_'), '*not em* and _nor this_')
  // as on the page, code spans are taken before escapes are read, so a backslash cannot escape a backtick
  assert.equal(renderInline('\\`x\\`'), '\\<code>x\\</code>')
  assert.equal(renderInline('2*3*4'), '2*3*4') // emphasis needs a non-word boundary, as on the page
  assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
})

test('a link with a quote in its url cannot leave the attribute', () => {
  assert.equal(renderInline('[x](https://a/b"onmouseover=1)'), '<a href="https://a/b&quot;onmouseover=1" target="_blank" rel="noopener noreferrer">x</a>')
})

test('blocks: paragraphs with breaks, lists, quotes, nested quote paragraphs', () => {
  assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>')
  assert.equal(renderMarkdown('- a\n* b'), '<ul><li>a</li><li>b</li></ul>')
  assert.equal(renderMarkdown('> **Lesson:** x\n>\n> y'), '<blockquote><p><strong>Lesson:</strong> x</p><p>y</p></blockquote>')
  assert.equal(renderMarkdown('💡 **Title** · shell\n\nShort. Why.\n\nTry it: `ls -la`'), '<p>💡 <strong>Title</strong> · shell</p><p>Short. Why.</p><p>Try it: <code>ls -la</code></p>')
})

test('odd input gives nothing', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(undefined), '')
  assert.equal(renderMarkdown(42), '')
  assert.equal(renderMarkdown('\n\n  \n'), '')
  assert.equal(escapeHtml('<"&>'), '&lt;&quot;&amp;&gt;')
})

// ---- choosing the session

test('a hand-picked session wins while it exists', () => {
  const a = session('a')
  const b = session('b')
  assert.equal(chooseSession(map(a, b), { sid: 'a' }, 'b').session, b)
  assert.equal(chooseSession(map(a, b), { sid: 'a' }, 'gone').session, a)
})

test("the terminal's session: shown with a snapshot, awaited without one while it runs", () => {
  const a = session('a', { at: 10 })
  const t = session('t', { at: 5 })
  assert.equal(chooseSession(map(a, t), { sid: 't' }, undefined).session, t)
  assert.deepEqual(chooseSession(map(a), { sid: 't' }, undefined), { sid: 't', awaiting: true })
  const after = chooseSession(map(a), { sid: 't', ended: true }, undefined)
  assert.equal(after.session, a)
  assert.equal(after.awaiting, false)
})

test('otherwise the newest: live before ended, then by write time', () => {
  const old = session('old', { at: 1 })
  const ended = session('ended', { at: 99, ended: true })
  const fresh = session('fresh', { at: 50 })
  assert.equal(chooseSession(map(old, ended, fresh), undefined, undefined).session, fresh)
  assert.deepEqual([ended, old, fresh].sort(newestFirst).map(s => s.sid), ['fresh', 'old', 'ended'])
  assert.deepEqual(chooseSession(map(), undefined, undefined), { awaiting: false })
})

// ---- keys and buttons

const key = (over: Partial<Parameters<typeof shortcutAction>[0]>) => ({ key: 'w', metaKey: false, ctrlKey: false, altKey: false, repeat: false, isComposing: false, ...over })

test('w t k p stand for the buttons; modified, held, composing or other keys do not', () => {
  assert.equal(shortcutAction(key({})), 'why')
  assert.equal(shortcutAction(key({ key: 't' })), 'tip')
  assert.equal(shortcutAction(key({ key: 'k' })), 'known')
  assert.equal(shortcutAction(key({ key: 'p' })), 'pause')
  assert.equal(shortcutAction(key({ key: 'W' })), undefined)
  assert.equal(shortcutAction(key({ ctrlKey: true })), undefined)
  assert.equal(shortcutAction(key({ metaKey: true })), undefined)
  assert.equal(shortcutAction(key({ repeat: true })), undefined)
  assert.equal(shortcutAction(key({ isComposing: true })), undefined)
  assert.equal(shortcutAction(key({ key: 'x' })), undefined)
})

test('shortcuts fire on the body or inside the panel, never in the editor, the terminal or a select', () => {
  const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable, contains: () => false }) as unknown as Element
  const body = el('BODY')
  const button = el('BUTTON')
  const select = el('SELECT')
  const panel = { contains: (x: Element) => x === button || x === select } as unknown as Element
  assert.equal(mayUseShortcut(null, body, panel), true)
  assert.equal(mayUseShortcut(body, body, panel), true)
  assert.equal(mayUseShortcut(button, body, panel), true)
  assert.equal(mayUseShortcut(select, body, panel), false)
  assert.equal(mayUseShortcut(el('TEXTAREA'), body, panel), false) // xterm's input
  assert.equal(mayUseShortcut(el('DIV', true), body, panel), false) // CodeMirror
  assert.equal(mayUseShortcut(button, body, null), false)
})

test('buttons: none without a session or once ended; Why? not while asking; I know this needs a card', () => {
  const all = (on: boolean) => ({ why: on, tip: on, known: on, pause: on, level: on })
  assert.deepEqual(enabledActions(undefined, true), all(false))
  assert.deepEqual(enabledActions(snap(), false), all(false))
  assert.deepEqual(enabledActions(snap({ ended: true }), true), all(false))
  assert.deepEqual(enabledActions(snap(), true), all(true))
  assert.deepEqual(enabledActions(snap({ isAsking: true }), true), { ...all(true), why: false })
  assert.deepEqual(enabledActions(snap({ hasLesson: false }), true), { ...all(true), known: false })
})

// ---- labels

test('labels', () => {
  assert.equal(narratorName('haiku'), 'Haiku')
  assert.equal(narratorName(' Sonnet '), 'Sonnet')
  assert.equal(narratorName(''), 'Haiku')
  assert.equal(narratorName(undefined), 'Haiku')
  assert.equal(narratorName('my-model'), 'my-model')
  assert.equal(narrationLabel('model'), 'model narration')
  assert.equal(narrationLabel('rules'), 'rules narration')
  assert.equal(narrationLabel(null), 'no narration yet')
  assert.equal(levelName(2), 'Intermediate')
  assert.equal(levelName('x'), 'Beginner')
  assert.equal(stationColor('edit'), '#34d399')
  assert.equal(stationColor('bogus'), '#64748b')
  assert.equal(stationColor(undefined), '#64748b')
  assert.equal(tilde('/Users/yash/code'), '~/code')
  assert.equal(tilde('/home/yash'), '~')
  assert.equal(tilde('C:\\Users\\yash\\code'), '~\\code')
  assert.equal(tilde('/srv/app'), '/srv/app')
})

test('the picker line: folder, goal cut short, ended', () => {
  assert.equal(sessionLabel(session('a', { cwd: '/Users/yash/code/docent', goalText: 'Fix the login redirect so that sessions survive a reload' })), 'docent · Fix the login redirect so that sessions…')
  assert.equal(sessionLabel(session('b', { cwd: 'C:\\Users\\yash\\app', goalText: '', ended: true })), 'app (ended)')
  assert.equal(sessionLabel(session('0123456789', { cwd: '' })), '01234567')
})

test('a stale line after two minutes, in minutes then hours', () => {
  const now = 10_000_000
  assert.equal(staleText(now - 60_000, now), undefined)
  assert.equal(staleText(now - 119_999, now), undefined)
  assert.equal(staleText(now - 120_000, now), 'last update 2 min ago')
  assert.equal(staleText(now - 3 * 60_000 - 1, now), 'last update 3 min ago')
  assert.equal(staleText(now - 3 * 3_600_000, now), 'last update 3 h ago')
  assert.equal(staleText(undefined, now), undefined)
  assert.equal(staleText(Number.NaN, now), undefined)
})

// ---- added with the review fixes: odd files and the picker's cap

test('odd fields read as text or as level 1, never as React children', () => {
  assert.equal(asText('x'), 'x')
  assert.equal(asText({ x: 1 }), '')
  assert.equal(asText(undefined), '')
  assert.equal(asText(7), '')
  assert.deepEqual(levelOf(2), { value: '2', level: 2, name: 'Intermediate' })
  assert.deepEqual(levelOf({ x: 1 }), { value: '1', level: 1, name: 'Beginner' })
  assert.equal(levelOf(undefined).value, '1')
  assert.equal(levelOf('2').value, '1') // the string '2' is not level 2, as on the page
  assert.equal(levelOf(3).name, 'Expert')
})

test('the picker lists at most PICKER_MAX sessions, newest first, and always the one on show', () => {
  const many = Array.from({ length: PICKER_MAX + 10 }, (_, i) => session(`s${i}`, { at: i }))
  const all = map(...many)
  const list = pickerSessions(all, undefined)
  assert.equal(PICKER_MAX, 50)
  assert.equal(list.length, PICKER_MAX)
  assert.equal(list[0]?.sid, `s${PICKER_MAX + 9}`)
  assert.equal(list.some(s => s.sid === 's0'), false)
  const withOld = pickerSessions(all, 's0')
  assert.equal(withOld.length, PICKER_MAX + 1)
  assert.equal(withOld.at(-1)?.sid, 's0')
  assert.equal(pickerSessions(all, `s${PICKER_MAX + 9}`).length, PICKER_MAX) // already listed: not doubled
  assert.equal(pickerSessions(all, 'missing').length, PICKER_MAX)
  assert.deepEqual(pickerSessions(map(many[0]!, many[1]!), undefined).map(s => s.sid), ['s1', 's0']) // under the cap: everything
  const ended = session('ended', { at: 999, ended: true })
  assert.equal(pickerSessions(map(ended, ...many), undefined).some(s => s.sid === 'ended'), false) // ended sorts last
})

// ---- the live model: a synthetic session folded by Pairwatch's own reducer (no real transcript)

const T0 = 1_700_000_000_000
const ROOT = '/w/proj'
const start = (id: string, tool: string, args: Record<string, unknown>, at: number, agentId?: string): RawEvent => ({ kind: 'tool-start', obs: { id, tool, args, at, ...(agentId === undefined ? {} : { agentId }) } })
const end = (id: string, status: 'ok' | 'error' | 'denied', preview: string, at: number): RawEvent => ({ kind: 'tool-end', end: { id, status, preview, at } })

/** A prompt, a partial Read, a Grep, an Edit, a sub-agent's Read and a failing npm test. */
const EVENTS: RawEvent[] = [
  { kind: 'prompt', text: 'add retries to fetchJson', origin: 'user', at: T0 },
  start('r1', 'Read', { file_path: `${ROOT}/src/http.ts`, offset: 12, limit: 37 }, T0 + 1000),
  end('r1', 'ok', 'x', T0 + 1500),
  start('g1', 'Grep', { pattern: 'fetchJson(' }, T0 + 12_000),
  end('g1', 'ok', 'src/a.ts\nsrc/b.ts', T0 + 12_500),
  start('e1', 'Edit', { file_path: `${ROOT}/src/http.ts`, old_string: 'a', new_string: 'retry()' }, T0 + 25_000),
  end('e1', 'ok', 'ok', T0 + 25_500),
  { kind: 'agent-start', agentId: 'ag1', type: 'Explore', description: 'find callers', toolUseId: 't1', background: false, at: T0 + 30_000 },
  start('r2', 'Read', { file_path: `${ROOT}/src/b.ts` }, T0 + 31_000, 'ag1'),
  end('r2', 'ok', 'x', T0 + 31_500),
  start('b1', 'Bash', { command: 'npm test' }, T0 + 40_000),
  end('b1', 'error', 'FAILED test/http.spec.ts', T0 + 48_000),
]
const fold = (events: RawEvent[], now: number, from: SessionModel = timeline.emptyModel(T0)): SessionModel =>
  timeline.settleHop(timeline.reduce(from, events, { level: 1, cwd: ROOT, now }), now)
const MODEL = fold(EVENTS, T0 + 50_000)
const INPUTS: { [id: string]: StepInput } = {
  r1: { path: `${ROOT}/src/http.ts`, offset: 12, limit: 37 },
  e1: { path: `${ROOT}/src/http.ts`, edits: [{ old: 'a', new: 'retry()' }] },
  r2: { path: `${ROOT}/src/b.ts` },
}
const stepOf = (over: Partial<Step>): Step => ({ id: 's', tool: 'Read', station: 'read', headline: 'h', why: 'w', concepts: [], scene: { kind: 'idle' }, status: 'ok', startedAt: T0, ...over })

// ---- steps strip

test('step rows: newest first, glyph, note (a failure shows its result), status, sub-agent lane, relative time', () => {
  const rows = stepRows({ model: MODEL, inputs: INPUTS }, ROOT, T0 + 50_000)
  assert.deepEqual(rows.map(r => r.id), ['b1', 'r2', 'e1', 'g1', 'r1', '#prompt-0.1~s0e0'])
  const [b1, r2, e1, g1, r1] = rows
  assert.equal(b1?.glyph, '▶️')
  assert.equal(b1?.status, 'error')
  assert.equal(b1?.note, 'FAILED test/http.spec.ts')
  assert.equal(b1?.when, '10s')
  assert.equal(b1?.target, undefined, 'a command is not a file')
  assert.equal(r2?.lane, 'Explore')
  assert.equal(r1?.lane, undefined)
  assert.equal(r1?.note, 'lines 12–48')
  assert.equal(g1?.note, '2 matches')
  assert.equal(g1?.target, undefined, "a search pattern is not a file")
  assert.equal(e1?.glyph, '✏️')
  assert.equal(e1?.note, '+1 −1')
})

test('step rows: a click shows the lines read, the first edit, or the file', () => {
  const rows = new Map(stepRows({ model: MODEL, inputs: INPUTS }, ROOT, T0 + 50_000).map(r => [r.id, r]))
  assert.deepEqual(rows.get('r1')?.target, { path: 'src/http.ts', fromLine: 12, toLine: 48, kind: 'read', focus: true })
  assert.deepEqual(rows.get('e1')?.target, { path: 'src/http.ts', find: 'retry()', kind: 'edit', focus: true })
  assert.deepEqual(rows.get('r2')?.target, { path: 'src/b.ts', fromLine: 1, toLine: WHOLE_FILE_LINES, kind: 'read', focus: true }, "a whole-file read: follow mode's wash from line 1")
})

test('step targets: Read ranges, Write, MultiEdit, other tools jump; the target when the input is missing', () => {
  const read = stepOf({ tool: 'Read', target: `${ROOT}/a.ts` })
  assert.deepEqual(stepTarget(read, { path: `${ROOT}/a.ts`, offset: 5, limit: 1 }, ROOT), { path: 'a.ts', fromLine: 5, toLine: 5, kind: 'read', focus: true })
  assert.deepEqual(stepTarget(read, { path: `${ROOT}/a.ts`, limit: 30 }, ROOT), { path: 'a.ts', fromLine: 1, toLine: 30, kind: 'read', focus: true }, 'a limit alone reads from line 1')
  assert.deepEqual(stepTarget(read, { path: `${ROOT}/a.ts`, offset: 7 }, ROOT), { path: 'a.ts', fromLine: 7, toLine: 6 + WHOLE_FILE_LINES, kind: 'read', focus: true }, 'an offset alone: the wash starts there')
  assert.deepEqual(stepTarget(read, { path: `${ROOT}/a.ts`, offset: 0, limit: -2 }, ROOT), { path: 'a.ts', fromLine: 1, toLine: WHOLE_FILE_LINES, kind: 'read', focus: true }, 'odd numbers are ignored')
  assert.deepEqual(stepTarget(read, undefined, ROOT), { path: 'a.ts', fromLine: 1, toLine: WHOLE_FILE_LINES, kind: 'read', focus: true }, 'no input: the target names the file')
  const write = stepOf({ tool: 'Write', station: 'edit', target: `${ROOT}/new.ts` })
  assert.deepEqual(stepTarget(write, { path: `${ROOT}/new.ts`, isWrite: true }, ROOT), { path: 'new.ts', kind: 'edit', focus: true })
  const multi = stepOf({ tool: 'MultiEdit', station: 'edit' })
  assert.deepEqual(stepTarget(multi, { path: `${ROOT}/m.ts`, edits: [{ old: 'x', new: 'first' }, { old: 'y', new: 'second' }] }, ROOT), { path: 'm.ts', find: 'first', kind: 'edit', focus: true })
  assert.deepEqual(stepTarget(multi, { path: `${ROOT}/m.ts`, edits: [{ old: 'x', new: '' }] }, ROOT), { path: 'm.ts', kind: 'edit', focus: true }, 'a deletion has nothing to find')
  const nb = stepOf({ tool: 'NotebookEdit', station: 'edit', target: `${ROOT}/n.ipynb` })
  assert.deepEqual(stepTarget(nb, undefined, ROOT), { path: 'n.ipynb', kind: 'jump', focus: true })
  const script = stepOf({ tool: 'Bash', station: 'run', target: `${ROOT}/run.sh` })
  assert.deepEqual(stepTarget(script, undefined, ROOT), { path: 'run.sh', kind: 'jump', focus: true })
  assert.equal(stepTarget(stepOf({ tool: 'Bash', station: 'run', target: `${ROOT}/run.sh --fast` }), undefined, ROOT), undefined, 'a command with arguments')
  assert.equal(stepTarget(stepOf({ tool: 'Grep', station: 'search', target: 'foo.ts' }), undefined, ROOT), undefined, 'a pattern that looks like a file name')
  assert.deepEqual(stepTarget(stepOf({ tool: 'Read', target: 'src/rel.ts' }), undefined, ROOT), { path: 'src/rel.ts', fromLine: 1, toLine: WHOLE_FILE_LINES, kind: 'read', focus: true }, 'a relative read path')
  assert.equal(stepTarget(read, { path: '/elsewhere/a.ts' }, ROOT), undefined, 'outside the workspace: not clickable')
  assert.equal(stepTarget(stepOf({ tool: 'Read', target: '/w/project-b/a.ts' }), undefined, ROOT), undefined, 'a sibling folder sharing the prefix')
  assert.equal(stepTarget(read, undefined, undefined), undefined, 'no workspace yet')
})

test('workspace paths: POSIX and Windows, inside only', () => {
  assert.equal(workspacePath('/w/proj/src/a.ts', '/w/proj'), 'src/a.ts')
  assert.equal(workspacePath('/w/proj/src/a.ts', '/w/proj/'), 'src/a.ts')
  assert.equal(workspacePath('./src//a.ts', '/w/proj'), 'src/a.ts')
  assert.equal(workspacePath('/w/proj', '/w/proj'), undefined)
  assert.equal(workspacePath('/w/proj/../x.ts', '/w/proj'), undefined)
  assert.equal(workspacePath('~/x.ts', '/w/proj'), undefined)
  assert.equal(workspacePath('C:\\Users\\me\\proj\\src\\a.ts', 'C:\\Users\\me\\proj'), 'src/a.ts')
  assert.equal(workspacePath('c:\\users\\me\\proj\\a.ts', 'C:\\Users\\me\\proj'), 'a.ts', 'a drive path compares without case')
  assert.equal(workspacePath('D:\\other\\a.ts', 'C:\\Users\\me\\proj'), undefined)
  assert.equal(workspacePath(42, '/w'), undefined)
})

test('step rows: at most twelve, and a running think gap off stage is left out', () => {
  const many: RawEvent[] = [{ kind: 'prompt', text: 'go', origin: 'user', at: T0 }]
  for (let i = 0; i < 20; i++) many.push(start(`b${i}`, 'Bash', { command: `echo ${i}` }, T0 + 1000 + i * 20_000), end(`b${i}`, 'ok', String(i), T0 + 1500 + i * 20_000))
  const m = fold(many, T0 + 500_000)
  const rows = stepRows({ model: m, inputs: {} }, ROOT, T0 + 500_000)
  assert.equal(STEPS_MAX, 12)
  assert.equal(rows.length, 12)
  assert.equal(rows[0]?.id, 'b19')
  const gap = fold([{ kind: 'stream', mode: 'thinking', at: T0 + 500_100 }], T0 + 500_200, m)
  const thinking = gap.steps.find(s => s.tool === '#think' && s.status === 'running')
  assert.ok(thinking !== undefined, 'the reducer opened a think gap')
  assert.equal(stepRows({ model: gap, inputs: {} }, ROOT, T0 + 500_200)[0]?.id, 'b19', 'not on stage yet: not listed')
  const settled = timeline.settleHop(gap, T0 + 510_000)
  assert.equal(stepRows({ model: settled, inputs: {} }, ROOT, T0 + 510_000)[0]?.id, thinking.id, 'once on stage it is listed')
})

test('relative time', () => {
  assert.equal(relTime(T0, T0 + 4_999), 'now')
  assert.equal(relTime(T0, T0 + 5_000), '5s')
  assert.equal(relTime(T0, T0 + 59_999), '59s')
  assert.equal(relTime(T0, T0 + 60_000), '1m')
  assert.equal(relTime(T0, T0 + 3_600_000), '1h')
  assert.equal(relTime(T0, T0 + 50 * 3_600_000), '2d')
  assert.equal(relTime(T0 + 1000, T0), 'now', 'a clock behind the update')
  assert.equal(relTime(Number.NaN, T0), '')
})

// ---- this turn

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenCounts => ({ input, output, cacheRead, cacheWrite, messages: 1 })

test("this turn's counts, elapsed and tokens; the session's from model.stats", () => {
  assert.deepEqual(turnCounts(MODEL), { steps: 5, files: 2, edits: 1, commands: 1, errors: 1 })
  const usage: SessionUsage = { total: tokens(210_000, 18_000, 1_200_000), turn: tokens(41_234, 2_100, 120_000), byModel: { 'claude-haiku-4-5': tokens(10, 10), 'claude-opus-5-5': tokens(200_000, 17_000) } }
  const v = turnView({ model: MODEL, usage })
  assert.deepEqual(v.turn, { counts: '5 steps · 2 files · 1 edit · 1 command · 1 error', elapsed: '48s', isRunning: true, tokens: '41k in · 2.1k out · 120k cache read' })
  assert.deepEqual(v.session, { counts: '5 steps · 2 files · 1 edit · 1 command · 1 error', tokens: '210k in · 18k out · 1.2M cache read' })
  assert.deepEqual(v.models, ['claude-opus-5-5', 'claude-haiku-4-5'])
  assert.equal(turnView({ model: timeline.emptyModel(T0) }).turn, undefined, 'no prompt yet')
  assert.equal(turnView({ model: timeline.emptyModel(T0) }).session.tokens, '')
})

test('a second turn counts only its own steps, the session keeps counting', () => {
  const next = fold(
    [
      { kind: 'turn-end', turnId: '#turn-0.1', durationMs: 49_000, answer: 'done', reason: 'end', at: T0 + 49_000 },
      { kind: 'prompt', text: 'now fix the test', origin: 'user', at: T0 + 100_000 },
      start('b2', 'Bash', { command: 'npm test' }, T0 + 101_000),
      end('b2', 'ok', 'ok', T0 + 104_000),
    ],
    T0 + 105_000,
    MODEL,
  )
  assert.deepEqual(turnCounts(next), { steps: 1, files: 0, edits: 0, commands: 1, errors: 0 })
  assert.deepEqual(sessionCounts(next), { steps: 6, files: 2, edits: 1, commands: 2, errors: 1 })
})

test("a long turn's steps and errors stay exact past the model's window (the opening prompt's snapshot)", () => {
  const opening = MODEL.steps[0]!
  // as if 200 steps and 3 errors ran this turn, most of them fallen out of the 80-step window
  const rolled: SessionModel = { ...MODEL, steps: [{ ...opening, id: '#prompt-0.1~s10e1' }, ...MODEL.steps.slice(1)], stats: { ...MODEL.stats, steps: 210, errors: 4 } }
  const c = turnCounts(rolled)
  assert.equal(c?.steps, 200)
  assert.equal(c?.errors, 3)
})

test('counts and token text', () => {
  assert.equal(countsText({ steps: 1, files: 1, edits: 0, commands: 2, errors: 0 }), '1 step · 1 file · 0 edits · 2 commands · 0 errors')
  assert.equal(countsText({ steps: 3, files: 40, edits: 1, commands: 0, errors: 1 }), '3 steps · 40+ files · 1 edit · 0 commands · 1 error', 'the model keeps 40 files at most')
  assert.equal(tokensText(tokens(999, 1000, 1_000_000)), '999 in · 1k out · 1M cache read')
  assert.equal(tokensText(undefined), '')
  assert.deepEqual(modelNames(undefined), [])
  assert.deepEqual(modelNames({ total: tokens(0, 0), turn: tokens(0, 0), byModel: { b: tokens(1, 1), a: tokens(1, 1), ' ': tokens(9, 9) } }), ['a', 'b'], 'ties by name; blank names dropped')
})

test('compact numbers: one decimal under ten, never 1000k', () => {
  const cases: [number, string][] = [
    [0, '0'], [7, '7'], [999, '999'], [999.4, '999'], [999.6, '1k'], [1000, '1k'], [1234, '1.2k'], [9_949, '9.9k'], [9_950, '10k'],
    [41_234, '41k'], [999_499, '999k'], [999_500, '1M'], [1_234_567, '1.2M'], [12_500_000, '13M'], [3_400_000_000, '3.4B'],
    [-5, '0'], [Number.NaN, '0'], [Number.POSITIVE_INFINITY, '0'],
  ]
  for (const [n, want] of cases) assert.equal(compactNumber(n), want, String(n))
})

// ---- what the panel draws

const liveOf = (sid: string) => ({ sid, n: sid })

test('panel view: the snapshot wins; without one the live model is drawn; a hand-picked session as picked', () => {
  const t = session('t')
  const a = session('a', { at: 50 })
  const live = liveOf('t')
  // running, no snapshot anywhere: drawn from the transcript
  assert.deepEqual(choosePanelView(map(), { sid: 't' }, undefined, live), { kind: 'live', sid: 't', live })
  // a snapshot for the terminal's session: it wins, and the live model rides along for the steps
  assert.deepEqual(choosePanelView(map(t, a), { sid: 't' }, undefined, live), { kind: 'snapshot', sid: 't', session: t, live })
  // another session's snapshot never stands in for the terminal's own transcript, running or ended
  assert.deepEqual(choosePanelView(map(a), { sid: 't' }, undefined, live), { kind: 'live', sid: 't', live })
  assert.deepEqual(choosePanelView(map(a), { sid: 't', ended: true }, undefined, live), { kind: 'live', sid: 't', live })
  // picked by hand: shown, and the terminal's live model stays out of it
  assert.deepEqual(choosePanelView(map(a), { sid: 't' }, 'a', live), { kind: 'snapshot', sid: 'a', session: a })
  assert.deepEqual(choosePanelView(map(t, a), { sid: 't' }, 't', live), { kind: 'snapshot', sid: 't', session: t, live })
  // a pick that went away falls back to the rules above
  assert.deepEqual(choosePanelView(map(a), { sid: 't' }, 'gone', live), { kind: 'live', sid: 't', live })
})

test('panel view without a live model: as before (awaiting, newest, nothing)', () => {
  const a = session('a')
  assert.deepEqual(choosePanelView(map(a), { sid: 't' }, undefined, undefined), { kind: 'none', sid: 't', awaiting: true })
  assert.deepEqual(choosePanelView(map(a), undefined, undefined, undefined), { kind: 'snapshot', sid: 'a', session: a })
  assert.deepEqual(choosePanelView(map(), undefined, undefined, undefined), { kind: 'none', awaiting: false })
  assert.deepEqual(choosePanelView(map(a), { sid: 't', ended: true }, undefined, undefined), { kind: 'snapshot', sid: 'a', session: a })
})

test('buttons from the transcript: only Another tip and the level work', () => {
  assert.deepEqual(fallbackActions(true), { why: false, tip: true, known: false, pause: false, level: true })
  assert.deepEqual(fallbackActions(false), { why: false, tip: false, known: false, pause: false, level: true })
})

// ---- the card and the stage from the transcript

const ctx = (now: number, over: Partial<Parameters<typeof advanceCard>[2]> = {}) => ({ level: 1 as const, seen: {}, recent: [], now, ...over })

test("card candidates: newest step first, each step's most specific first, only known cards", () => {
  const steps = [stepOf({ id: 'a', concepts: ['grep', 'not-a-concept', 'regex'] }), stepOf({ id: 'b', concepts: ['tests', 'grep'] })]
  assert.deepEqual(lessonCandidates(steps), ['tests', 'grep', 'regex'])
  assert.deepEqual(lessonCandidates([]), [])
})

test('the card: chosen once per activity, from its concepts; unchanged returns the same object', () => {
  const now = T0 + 50_000
  const card = advanceCard({ sid: 's' }, MODEL, ctx(now))
  assert.equal(card.checked, 'b1')
  assert.deepEqual(card.lesson, { conceptId: 'npm-scripts', depth: 0, shownAt: now, activityId: 'b1' })
  assert.equal(advanceCard(card, MODEL, ctx(now + 1000)), card, 'nothing new: the same object')
  // a card met lately is not swapped in again while another card is up
  const up: FallbackCard = { sid: 's', lesson: { conceptId: 'grep', depth: 0, shownAt: now, activityId: 'g1' }, checked: 'g1' }
  const stale = advanceCard(up, MODEL, ctx(now, { recent: ['npm-scripts'], seen: { 'npm-scripts': { n: 1, last: now - 1000 } } }))
  assert.equal(stale.checked, 'b1')
  assert.equal(stale.lesson?.conceptId, 'tests', 'the next best fresh card')
  assert.equal(cardMarkdown(card.lesson, 1).startsWith('💡 **npm scripts**'), true)
  assert.equal(cardMarkdown(undefined, 1), '')
  assert.equal(cardMarkdown({ conceptId: 'no-such-card', depth: 0, shownAt: now }, 1), '')
})

test('the card deepens while it stays up, and never gets shallower', () => {
  const now = T0 + 50_000
  const card = advanceCard({ sid: 's' }, MODEL, ctx(now))
  assert.equal(advanceCard(card, MODEL, ctx(now + 15_000)), card, 'not yet')
  const deeper = advanceCard(card, MODEL, ctx(now + 15_001))
  assert.equal(deeper.lesson?.depth, 1)
  const deepest = advanceCard(deeper, MODEL, ctx(now + 35_001))
  assert.equal(deepest.lesson?.depth, 2)
  assert.equal(advanceCard(deepest, MODEL, ctx(now)), deepest, 'a clock behind does not undo it')
  assert.ok(cardMarkdown(deepest.lesson, 1).includes('Try it:'), 'depth 2 has the try-it line')
  assert.ok(cardMarkdown(deepest.lesson, 1).length > cardMarkdown(card.lesson, 1).length)
})

test('another tip: a different card, kept for the activity on show', () => {
  const now = T0 + 50_000
  const card = advanceCard({ sid: 's' }, MODEL, ctx(now))
  const other = anotherCard(card, MODEL, ctx(now + 1000, { recent: ['npm-scripts'] }))
  assert.ok(other !== undefined)
  assert.notEqual(other.lesson?.conceptId, 'npm-scripts')
  assert.equal(other.lesson?.depth, 0)
  assert.equal(other.checked, 'b1')
  assert.equal(advanceCard(other, MODEL, ctx(now + 2000)).lesson?.conceptId, other.lesson?.conceptId, 'the same activity does not take it back')
})

test('the stage and the words from the transcript', () => {
  const now = T0 + 50_000
  const v = fallbackView(MODEL, { level: 1, now, root: ROOT })
  assert.ok(v.svg.startsWith('<svg'))
  assert.equal(v.station, 'run')
  assert.equal(v.fresh, 'b1#1#b1')
  assert.equal(v.goal, '🎯 *Goal:* add retries to fetchJson')
  assert.ok(v.head.startsWith('▶️ **Running the test suite (npm test)**\n\n'), v.head)
  assert.ok(v.head.includes('FAILED test/http.spec.ts'), 'the rules narration names the failure')
  assert.ok(v.alt.includes('Running the test suite'))
  const empty = fallbackView(timeline.emptyModel(T0), { level: 1, now: T0 })
  assert.equal(empty.station, 'idle')
  assert.ok(empty.head.includes('Waiting for Claude to start'))
  assert.ok(empty.svg.startsWith('<svg'))
})

test('a step on stage plays its intro once: drawn again, the same thing comes without it', () => {
  const m = fold([...EVENTS, start('r9', 'Read', { file_path: `${ROOT}/src/c.ts` }, T0 + 60_000)], T0 + 60_100)
  const first = fallbackView(m, { level: 1, now: T0 + 60_200, root: ROOT })
  const again = fallbackView(m, { level: 1, now: T0 + 60_200, root: ROOT, drawnFresh: first.fresh })
  const other = fallbackView(m, { level: 1, now: T0 + 60_200, root: ROOT, drawnFresh: 'something-else' })
  assert.notEqual(first.svg, again.svg, 'the intro is dropped')
  assert.equal(first.svg, other.svg, 'a new thing on stage keeps its intro')
})

test("the store: a new card counts as met once; the same card does not count again", () => {
  const st = useWatchStore.getState()
  assert.equal(st.level, 1)
  st.setLevel(3)
  assert.equal(useWatchStore.getState().level, 3)
  const now = T0 + 50_000
  const card = advanceCard({ sid: 's' }, MODEL, ctx(now))
  useWatchStore.getState().putCard(card, now)
  assert.deepEqual(useWatchStore.getState().seen, { 'npm-scripts': { n: 1, last: now } })
  assert.deepEqual(useWatchStore.getState().recent, ['npm-scripts'])
  useWatchStore.getState().putCard(advanceCard(card, MODEL, ctx(now + 20_000)), now + 20_000)
  assert.equal(useWatchStore.getState().card?.lesson?.depth, 1)
  assert.deepEqual(useWatchStore.getState().seen, { 'npm-scripts': { n: 1, last: now } }, 'deepening is not meeting it again')
  useWatchStore.getState().putCard({ sid: 'other', lesson: { conceptId: 'npm-scripts', depth: 0, shownAt: now + 30_000 } }, now + 30_000)
  assert.deepEqual(useWatchStore.getState().seen, { 'npm-scripts': { n: 2, last: now + 30_000 } }, 'another session showing it counts')
  assert.deepEqual(useWatchStore.getState().recent, ['npm-scripts'], 'recent keeps one entry per card')
})

// ---- found in verification: each of these fails until its defect is fixed

test('a glob is never a file to open: a Glob with an absolute pattern makes no clickable row', () => {
  const glob = stepOf({ tool: 'Glob', station: 'search', target: `${ROOT}/src/**/*.ts` })
  assert.equal(stepTarget(glob, undefined, ROOT), undefined, 'clicking it would ask the workspace to read src/**/*.ts')
})

test("an edit's mark skips a blank first new string (a deletion leaves '\\n'), as follow mode does", () => {
  const edit = stepOf({ tool: 'Edit', station: 'edit' })
  const t = stepTarget(edit, { path: `${ROOT}/a.ts`, edits: [{ old: 'gone\n', new: '\n' }, { old: 'x', new: 'retry()' }] }, ROOT)
  assert.equal(t?.find, 'retry()', 'a bare newline selects the first line break in the file, far from the edit')
})

test('a whole-file Read is shown as more than its first line', () => {
  const t = stepTarget(stepOf({ tool: 'Read', target: `${ROOT}/a.ts` }), { path: `${ROOT}/a.ts` }, ROOT)
  // with fromLine 1 and no toLine the editor washes and selects line 1 alone (follow mode washes WHOLE_FILE_LINES)
  assert.ok((t?.toLine ?? t?.fromLine ?? 0) > 1, JSON.stringify(t))
})

// ---- the fixes for those, and the rest of the verification's findings

test('step targets: a read path keeps its brackets; wildcards elsewhere are patterns; a language-server step names its file', () => {
  assert.deepEqual(stepTarget(stepOf({ tool: 'Read', target: `${ROOT}/app/[slug]/page.tsx` }), undefined, ROOT), { path: 'app/[slug]/page.tsx', fromLine: 1, toLine: WHOLE_FILE_LINES, kind: 'read', focus: true }, 'a dynamic route is a file')
  assert.equal(stepTarget(stepOf({ tool: 'Glob', station: 'search', target: 'src/**/*.ts' }), undefined, ROOT), undefined)
  assert.equal(stepTarget(stepOf({ tool: 'Glob', station: 'search', target: `${ROOT}/src/{a,b}.ts` }), undefined, ROOT), undefined, 'braces')
  assert.equal(stepTarget(stepOf({ tool: 'Grep', station: 'search', target: `${ROOT}/src/[a-z]+.ts` }), undefined, ROOT), undefined, 'a regex')
  assert.deepEqual(stepTarget(stepOf({ tool: 'LSP', station: 'search', target: `${ROOT}/src/a.ts` }), undefined, ROOT), { path: 'src/a.ts', kind: 'jump', focus: true })
})

test('an edit with only blank new strings has nothing to find; odd edits are passed over', () => {
  const edit = stepOf({ tool: 'Edit', station: 'edit' })
  assert.deepEqual(stepTarget(edit, { path: `${ROOT}/a.ts`, edits: [{ old: 'x\n', new: '\n' }, { old: 'y', new: '  ' }] }, ROOT), { path: 'a.ts', kind: 'edit', focus: true })
  assert.deepEqual(stepTarget(edit, { path: `${ROOT}/a.ts`, edits: 'odd' } as unknown as StepInput, ROOT), { path: 'a.ts', kind: 'edit', focus: true })
  assert.deepEqual(stepTarget(edit, { path: `${ROOT}/a.ts`, edits: [null, { old: 'a', new: '  b' }] } as unknown as StepInput, ROOT), { path: 'a.ts', find: '  b', kind: 'edit', focus: true }, 'the text to find is kept as it is')
})

test("workspace paths follow the root's style, as the editor's own do", () => {
  assert.equal(workspacePath('\\\\SRV\\Share\\proj\\src\\a.ts', '\\\\srv\\share\\proj'), 'src/a.ts', 'a UNC root compares without case')
  assert.equal(workspacePath('//srv/share/proj/a.ts', '\\\\srv\\share\\proj'), 'a.ts', 'either slash')
  assert.equal(workspacePath('/w/proj/odd\\name.ts', '/w/proj'), 'odd\\name.ts', 'under a POSIX root a backslash is part of the name')
  assert.equal(workspacePath('C:\\Users\\me\\proj\\SRC\\App.ts', 'C:\\Users\\me\\proj'), 'SRC/App.ts', "the path keeps its own case; pathKey folds it")
  assert.equal(pathKey('SRC/App.ts', 'C:\\Users\\me\\proj'), 'src/app.ts')
  assert.equal(pathKey('SRC/App.ts', '/w/proj'), 'SRC/App.ts', 'POSIX names keep their case')
  assert.equal(workspacePath('src/../../x.ts', '/w/proj'), undefined, 'a relative path that climbs out')
  assert.equal(workspacePath('src/a.ts', undefined), undefined, 'no workspace: nothing is inside it')
  assert.equal(workspacePath('a\nb.ts', '/w/proj'), undefined)
})

test("absolute paths, in the root's style", () => {
  assert.equal(isAbsolutePath('/w/a.ts', '/w'), true)
  assert.equal(isAbsolutePath('w/a.ts', '/w'), false)
  assert.equal(isAbsolutePath('C:\\w\\a.ts', '/w'), false, 'a drive path is just a name under a POSIX root')
  assert.equal(isAbsolutePath('C:\\w\\a.ts', 'C:\\w'), true)
  assert.equal(isAbsolutePath('c:/w/a.ts', 'C:\\w'), true)
  assert.equal(isAbsolutePath('\\\\srv\\share\\a.ts', 'C:\\w'), true)
  assert.equal(isAbsolutePath('src\\a.ts', 'C:\\w'), false)
})

test("this turn while it runs: by the clock, not frozen at the latest event; once over, the model's own time", () => {
  assert.equal(MODEL.turn?.isRunning, true)
  assert.equal(turnElapsed(MODEL), '48s', "no clock: the model's figure")
  assert.equal(turnElapsed(MODEL, T0 + 5 * 60_000), '5m 00s', 'five minutes into one long command')
  assert.equal(turnView({ model: MODEL }, T0 + 5 * 60_000 + 7_000).turn?.elapsed, '5m 07s')
  const over = fold([{ kind: 'turn-end', turnId: '#turn-0.1', durationMs: 49_000, answer: 'done', reason: 'end', at: T0 + 49_000 }], T0 + 60_000, MODEL)
  assert.equal(over.turn?.isRunning, false)
  assert.equal(turnElapsed(over, T0 + 30 * 60_000), turnElapsed(over), 'an ended turn keeps its own time')
  assert.equal(turnElapsed(timeline.emptyModel(T0), T0 + 1000), '0s')
})

test('odd fields never throw: null usage parts, a null turn or stats show less', () => {
  assert.equal(tokensText(null), '')
  const usage = { total: null, turn: null, byModel: { a: null, b: tokens(1, 1) } } as unknown as SessionUsage
  const v = turnView({ model: MODEL, usage }, T0 + 50_000)
  assert.equal(v.session.tokens, '')
  assert.equal(v.turn?.tokens, '')
  assert.deepEqual(v.models, ['b', 'a'])
  const odd = { ...MODEL, turn: null, stats: null, files: null, steps: null } as unknown as SessionModel
  assert.equal(turnCounts(odd), undefined)
  assert.deepEqual(sessionCounts(odd), { steps: 0, files: 0, edits: 0, commands: 0, errors: 0 })
  assert.equal(turnView({ model: odd, usage: null }).turn, undefined)
  const holes = { ...MODEL, steps: [null, ...MODEL.steps] } as unknown as SessionModel
  assert.equal(stepRows({ model: holes, inputs: {} }, ROOT, T0 + 50_000).length, MODEL.steps.length, 'a hole in the steps is passed over')
})

test('from the transcript: waiting for the mod at first; not running once no viewer is up, the terminal ended, or the grace ran out', () => {
  const up: WatchHostStatus = { mode: 'host', port: 7979 }
  assert.equal(MOD_GRACE_MS, 20_000)
  assert.equal(transcriptSource(up, false, undefined), 'waiting', 'the live model landed before the first snapshot')
  assert.equal(transcriptSource(up, false, MOD_GRACE_MS - 1), 'waiting')
  assert.equal(transcriptSource(up, false, MOD_GRACE_MS), 'not-running')
  assert.equal(transcriptSource({ mode: 'bridge', port: 7979 }, false, 1000), 'waiting')
  assert.equal(transcriptSource(undefined, false, 1000), 'waiting', "the viewer's status is not known yet")
  assert.equal(transcriptSource({ mode: 'down', port: 0 }, false, 0), 'not-running', 'no viewer: the mod has nowhere to write')
  assert.equal(transcriptSource(up, true, 0), 'not-running', 'the terminal ended without a snapshot')
  assert.equal(transcriptSource(up, false, -500), 'waiting', 'a clock behind the first sight')
})

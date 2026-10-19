// Tests for the watch panel's pure modules, run with Node 22's type stripping from outside the repo
// (a spec under src/renderer would be type-checked against the DOM-only web tsconfig).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { enabledActions, mayUseShortcut, shortcutAction } from '../src/renderer/src/watch/actions.ts'
import { PICKER_MAX, chooseSession, newestFirst, pickerSessions } from '../src/renderer/src/watch/choose.ts'
import { asText, levelName, levelOf, narratorName, narrationLabel, sessionLabel, staleText, stationColor, tilde } from '../src/renderer/src/watch/format.ts'
import { escapeHtml, renderInline, renderMarkdown } from '../src/renderer/src/watch/markdown.ts'
import type { Snapshot } from '../../server/src/pairwatch/types.ts'
import type { WatchSession } from '../src/shared/ipc.ts'

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

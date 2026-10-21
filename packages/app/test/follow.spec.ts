// Follow mode (src/renderer/src/editor/follow.ts): the pure step -> action logic over two live models, and
// the runtime driven through the real store with a fake window.docent. Steps and models are synthetic.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LiveSession, SessionModel, Step, StepInput } from '../src/shared/ipc.ts'

const disk = new Map<string, string>()
const reads: string[] = []
/** sizes the folder listing reports instead of the text's length (a huge file without the memory) */
const sizes = new Map<string, number>()
/** reads held back until released */
const gates = new Map<string, Promise<void>>()
;(globalThis as unknown as { window: unknown }).window = {
  docent: {
    workspace: {
      read: async (p: string) => {
        reads.push(p)
        await gates.get(p)
        if (!disk.has(p)) throw new Error(`ENOENT: no such file or directory, open '${p}'`)
        return disk.get(p)!
      },
      write: async (p: string, t: string) => void disk.set(p, t),
      list: async (dir: string) => {
        const prefix = dir === '.' ? '' : `${dir}/`
        return [...disk.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map(([p, t]) => ({ name: p.slice(prefix.length), path: p, kind: 'file', size: sizes.get(p) ?? t.length }))
      },
    },
  },
}

const { FOLLOW_MAX_BYTES, WHOLE_FILE_LINES, changeLines, editTarget, followActions, isBinaryPath, isFollowKey, readLines, startFollow } = await import(
  '../src/renderer/src/editor/follow.ts'
)
const { FOLLOW_PAUSE_MS, MAX_AUTO_TABS, autoTabsToClose, useStore } = await import('../src/renderer/src/store.ts')
type OpenFile = import('../src/renderer/src/store.ts').OpenFile

const ROOT = '/w'
const T0 = 1_000_000

const step = (id: string, tool: string, status: Step['status'], startedAt = T0): Step => ({
  id,
  tool,
  station: tool === 'Read' ? 'read' : 'edit',
  headline: `${tool} ${id}`,
  why: '',
  concepts: [],
  scene: { kind: 'idle' },
  status,
  startedAt,
})
const model = (steps: Step[]): SessionModel => ({ steps, activities: [], files: [], agents: [], stats: { steps: steps.length, edits: 0, commands: 0, errors: 0, turns: 1, startedAt: T0 }, rev: steps.length })
const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
const live = (steps: Step[], inputs: { [id: string]: StepInput }, sid = 'sid-1'): LiveSession => ({
  sid,
  ptyId: 'pty-1',
  model: model(steps),
  inputs,
  usage: { total: counts, turn: counts, byModel: {} },
  at: T0,
})
const ctx = { root: ROOT, since: T0 }

// ---- the pure part

test('readLines: offset/limit as given; a whole-file read washes the first 40 lines', () => {
  assert.deepEqual(readLines({ path: '/w/a.ts' }), { fromLine: 1, toLine: WHOLE_FILE_LINES })
  assert.deepEqual(readLines({ path: '/w/a.ts', offset: 12, limit: 37 }), { fromLine: 12, toLine: 48 })
  assert.deepEqual(readLines({ path: '/w/a.ts', offset: 100 }), { fromLine: 100, toLine: 139 })
  assert.deepEqual(readLines({ path: '/w/a.ts', limit: 5 }), { fromLine: 1, toLine: 5 })
  assert.deepEqual(readLines({ path: '/w/a.ts', offset: 0, limit: 0 }), { fromLine: 1, toLine: WHOLE_FILE_LINES }, 'nonsense falls back')
})

test('editTarget: the first new string that is not blank; a Write marks the top; nothing to find just shows the file', () => {
  assert.deepEqual(editTarget('Edit', { path: 'a', edits: [{ old: 'a', new: 'b()' }] }), { kind: 'edit', find: 'b()' })
  assert.deepEqual(editTarget('MultiEdit', { path: 'a', edits: [{ old: 'x', new: '' }, { old: 'y', new: '\n' }, { old: 'z', new: 'zz' }] }), { kind: 'edit', find: 'zz' })
  assert.deepEqual(editTarget('Write', { path: 'a', isWrite: true }), { kind: 'edit', fromLine: 1, toLine: WHOLE_FILE_LINES })
  assert.deepEqual(editTarget('Edit', { path: 'a', edits: [{ old: 'gone', new: '' }] }), { kind: 'jump' })
  assert.deepEqual(editTarget('NotebookEdit', { path: 'a.ipynb' }), { kind: 'jump' })
})

test('followActions: a new read shows at once with its lines; never twice; a failed read not at all', () => {
  const r1 = step('r1', 'Read', 'running')
  const next = live([r1], { r1: { path: '/w/src/a.ts', offset: 12, limit: 37 } })
  assert.deepEqual(followActions(undefined, next, ctx), [{ stepId: 'r1', kind: 'read', target: { path: 'src/a.ts', fromLine: 12, toLine: 48, kind: 'read', focus: false } }])
  const done = live([{ ...r1, status: 'ok' }], next.inputs)
  assert.deepEqual(followActions(next, done, ctx), [], 'its status moving on is not a new read')
  assert.deepEqual(followActions(undefined, live([step('r2', 'Read', 'error')], { r2: { path: '/w/missing.ts' } }), ctx), [])
  assert.deepEqual(followActions(undefined, live([step('r3', 'Read', 'denied')], { r3: { path: '/w/x.ts' } }), ctx), [])
})

test('followActions: an edit waits for ok (the file is written), then shows once; errors and denials never', () => {
  const e1 = step('e1', 'Edit', 'running')
  const inputs = { e1: { path: '/w/src/a.ts', edits: [{ old: 'x', new: 'retry(3)' }] } }
  const running = live([e1], inputs)
  assert.deepEqual(followActions(undefined, running, ctx), [])
  const ok = live([{ ...e1, status: 'ok' }], inputs)
  assert.deepEqual(followActions(running, ok, ctx), [{ stepId: 'e1', kind: 'edit', target: { path: 'src/a.ts', kind: 'edit', find: 'retry(3)', focus: false } }])
  assert.deepEqual(followActions(ok, ok, ctx), [], 'once')
  assert.deepEqual(followActions(undefined, ok, ctx).length, 1, 'already ok when first seen: shown')
  assert.deepEqual(followActions(running, live([{ ...e1, status: 'error' }], inputs), ctx), [])
  assert.deepEqual(followActions(running, live([{ ...e1, status: 'denied' }], inputs), ctx), [])
  const w = step('w1', 'Write', 'ok')
  assert.deepEqual(followActions(undefined, live([w], { w1: { path: 'src/new.ts', isWrite: true } }), ctx), [
    { stepId: 'w1', kind: 'edit', target: { path: 'src/new.ts', kind: 'edit', fromLine: 1, toLine: WHOLE_FILE_LINES, focus: false } },
  ])
})

test('followActions: only file tools, only inside the workspace, only steps started since follow went on', () => {
  const steps = [step('b', 'Bash', 'ok'), step('g', 'Grep', 'ok'), step('o', 'Read', 'ok'), step('root', 'Read', 'ok'), step('old', 'Read', 'ok', T0 - 1), step('nb', 'NotebookRead', 'ok')]
  const inputs = { b: { path: '/w/a' }, g: { path: '/w/a' }, o: { path: '/elsewhere/a.ts' }, root: { path: '/w' }, old: { path: '/w/old.ts' }, nb: { path: '/w/n.ipynb' } }
  assert.deepEqual(followActions(undefined, live(steps, inputs), ctx), [])
})

test('followActions: images, PDFs and other binaries are not followed', () => {
  assert.equal(isBinaryPath('assets/logo.PNG'), true)
  assert.equal(isBinaryPath('docs/spec.pdf'), true)
  assert.equal(isBinaryPath('src/a.ts'), false)
  assert.equal(isBinaryPath('icon.svg'), false, 'SVG is text')
  assert.equal(isBinaryPath('.png'), false, 'a dot file named like an extension')
  assert.equal(isBinaryPath('Makefile'), false)
  const steps = [step('img', 'Read', 'ok'), step('nb', 'NotebookEdit', 'ok')]
  const inputs = { img: { path: '/w/assets/logo.png' }, nb: { path: '/w/n.ipynb' } }
  assert.deepEqual(followActions(undefined, live(steps, inputs), ctx).map(a => a.stepId), ['nb'], 'a notebook is JSON text')
})

test('followActions: in order; a new session in prev counts as none; an input that arrives late acts then', () => {
  const steps = [step('a', 'Read', 'ok'), step('b', 'Read', 'running'), step('c', 'Edit', 'ok')]
  const inputs = { a: { path: '/w/a.ts' }, b: { path: '/w/b.ts' }, c: { path: '/w/c.ts', edits: [{ old: '1', new: '2' }] } }
  const next = live(steps, inputs)
  assert.deepEqual(followActions(undefined, next, ctx).map(a => a.stepId), ['a', 'b', 'c'])
  assert.deepEqual(followActions(live(steps, inputs, 'other-sid'), next, ctx).map(a => a.stepId), ['a', 'b', 'c'])
  const noInput = live([step('d', 'Read', 'running')], {})
  assert.deepEqual(followActions(undefined, noInput, ctx), [])
  assert.deepEqual(followActions(noInput, live([step('d', 'Read', 'ok')], { d: { path: '/w/d.ts' } }), ctx).map(a => a.stepId), ['d'])
  assert.deepEqual(followActions(next, undefined, ctx), [])
})

test('isFollowKey: Cmd-Option-F on a Mac, Ctrl-Alt-F elsewhere', () => {
  const k = (over: Partial<KeyboardEvent>) => ({ code: 'KeyF', key: 'ƒ', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...over })
  assert.equal(isFollowKey(k({ metaKey: true }), true), true)
  assert.equal(isFollowKey(k({ ctrlKey: true, key: 'f' }), false), true)
  assert.equal(isFollowKey(k({ ctrlKey: true }), true), false, 'Ctrl on a Mac is not Mod')
  assert.equal(isFollowKey(k({ metaKey: true }), false), false)
  assert.equal(isFollowKey(k({ metaKey: true, shiftKey: true }), true), false)
  assert.equal(isFollowKey(k({ metaKey: true, altKey: false, key: 'f' }), true), false, 'Mod-F alone is find')
  assert.equal(isFollowKey(k({ metaKey: true, code: 'KeyG', key: '©' }), true), false)
})

test("isFollowKey: on Windows AltGr arrives as Ctrl+Alt; when it types a character, that is text, not the shortcut", () => {
  const k = (over: Partial<KeyboardEvent> & { getModifierState?: (m: string) => boolean }) => ({ code: 'KeyF', key: 'f', altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, ...over })
  const altGr = (m: string) => m === 'AltGraph'
  assert.equal(isFollowKey(k({ key: '[' }), false), false, "AltGr+F types '[' on Czech, Hungarian, Croatian layouts")
  assert.equal(isFollowKey(k({ key: '[', getModifierState: () => false }), false), false, 'a symbol, even when Chromium does not flag AltGraph (left Ctrl+Alt)')
  assert.equal(isFollowKey(k({ key: 'đ', getModifierState: altGr }), false), false, 'any character typed with AltGraph held')
  assert.equal(isFollowKey(k({ key: 'f', getModifierState: altGr }), false), true, "where AltGr+F types nothing the key is plain 'f'")
  assert.equal(isFollowKey(k({ key: 'а' }), false), true, "the F key on a Russian layout ('а')")
  assert.equal(isFollowKey(k({ key: 'F' }), false), true, 'Caps Lock')
  assert.equal(isFollowKey(k({ code: 'KeyG', key: '[' }), false), false)
})

test('changeLines: the new occurrence of an edit text is the one at the change, not the first in the file', () => {
  const text = 'a {\n}\nb {\n}\nc\n'
  const second = text.indexOf('}', text.indexOf('b {'))
  assert.deepEqual(changeLines(text, { from: second, to: second + 1 }, '}'), { fromLine: 4, toLine: 4 })
  assert.deepEqual(changeLines(text, { from: second, to: second }, '}'), { fromLine: 4, toLine: 4 }, 'a deletion left the edit text where the old one was')
  assert.deepEqual(changeLines(text, { from: 0, to: 3 }, 'c'), { fromLine: 1, toLine: 1 }, 'the find text is not at the change: the changed lines')
  assert.deepEqual(changeLines('one\nx\ny\ntwo\n', { from: 4, to: 8 }), { fromLine: 2, toLine: 3 }, 'no find text (a Write): the changed lines; a final line break ends on its line')
  const block = 'if (x) {\n  a()\n  b()\n}\n'
  const b = block.indexOf('b()')
  assert.deepEqual(changeLines(block, { from: b, to: b + 3 }, 'if (x) {\n  a()\n  b()\n}'), { fromLine: 1, toLine: 3 }, 'a new text whose first lines were already there starts above the change')
})

test('autoTabsToClose: least recently shown first; never dirty, never the user-owned, never the one to keep', () => {
  const f = (path: string, auto?: number, dirty = false): OpenFile => ({ path, text: '', dirty, rev: 0, ...(auto === undefined ? {} : { auto }) })
  const files = [f('u1'), f('a', 5), f('b', 2), f('c', 9, true), f('d', 1), f('e', 7)]
  assert.deepEqual(autoTabsToClose(files, 'e', 5), [])
  assert.deepEqual(autoTabsToClose(files, 'e', 3), ['d', 'b'])
  assert.deepEqual(autoTabsToClose(files, 'd', 3), ['b', 'a'], 'the one being shown stays')
  assert.deepEqual(autoTabsToClose(files, 'e', 0), ['d', 'b', 'a'], 'the dirty one and the kept one stay even past the limit')
})

// ---- the runtime: real store, fake window.docent

const tick = (ms = 15) => new Promise(r => setTimeout(r, ms))
const state = () => useStore.getState()
const file = (path: string) => state().files.find(f => f.path === path)
const now = () => Date.now()

const reset = () => {
  disk.clear()
  reads.length = 0
  state().setWorkspace({ root: ROOT, name: 'w' })
  state().setFollow(true)
}

let stop = startFollow()
assert.equal(startFollow(), stop, 'a second start returns the same stop')

test('runtime: a read opens its file as follow\'s own, washes the lines, scrolls without selecting, keeps the focus away', async () => {
  reset()
  disk.set('src/a.ts', Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'))
  const t = now() + 1
  state().setLive(live([step('r1', 'Read', 'running', t)], { r1: { path: '/w/src/a.ts', offset: 3, limit: 2 } }))
  await tick()
  const f = file('src/a.ts')!
  assert.ok(f, 'opened')
  assert.equal(state().active, 'src/a.ts')
  assert.ok(f.auto !== undefined, "follow's own tab")
  assert.equal(f.reveal?.focus, false)
  assert.equal(f.reveal?.select, false)
  // lines 3-4 of 'line 1\nline 2\n...': from the start of 'line 3' to the end of 'line 4'
  assert.deepEqual(f.reveal?.mark, { kind: 'read', from: 14, to: 27, lines: true })
  assert.deepEqual(f.reveal?.range, { anchor: 14, head: 27 })
  // the same step again, now ok: not shown again
  const n = f.reveal?.n
  state().setLive(live([step('r1', 'Read', 'ok', t)], { r1: { path: '/w/src/a.ts', offset: 3, limit: 2 } }))
  await tick()
  assert.equal(file('src/a.ts')?.reveal?.n, n)
})

test('runtime: an edit shows once ok, re-read from disk into the clean tab, the new text marked', async () => {
  reset()
  disk.set('src/a.ts', 'const a = 1\nfetchJson()\n')
  await state().open('src/a.ts')
  state().setFollow(true) // the open above paused follow, as a tree click would
  const t = now() + 1
  const inputs = { e1: { path: '/w/src/a.ts', edits: [{ old: 'fetchJson()', new: 'withRetry(fetchJson)()' }] } }
  state().setLive(live([step('e1', 'Edit', 'running', t)], inputs))
  await tick()
  assert.equal(file('src/a.ts')?.reveal, undefined, 'nothing while the edit runs')
  disk.set('src/a.ts', 'const a = 1\nwithRetry(fetchJson)()\n') // the CLI writes the file, then the result arrives
  state().setLive(live([step('e1', 'Edit', 'ok', t)], inputs))
  await tick()
  const f = file('src/a.ts')!
  assert.equal(f.text, 'const a = 1\nwithRetry(fetchJson)()\n', 'reloaded')
  assert.equal(f.rev, 1)
  assert.equal(f.dirty, false)
  assert.deepEqual(f.reveal?.mark, { kind: 'edit', from: 12, to: 34, lines: false })
  assert.equal(f.reveal?.focus, false)
  assert.equal(f.auto, undefined, 'a tab the user opened stays theirs')
})

test('runtime: an edit to an open tab marks the new text where the file changed, not the first occurrence of it', async () => {
  reset()
  const before = 'function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n'
  const after = 'function a() {\n  return 1\n}\nfunction b() {\n}\n'
  const second = after.indexOf('}', after.indexOf('function b'))
  const inputs = { e1: { path: '/w/a.ts', edits: [{ old: '  return 2\n}', new: '}' }] } }
  disk.set('a.ts', before)
  await state().open('a.ts')
  state().setFollow(true)
  disk.set('a.ts', after) // the CLI writes; follow's own read reloads the clean tab
  state().setLive(live([step('e1', 'Edit', 'ok', now() + 1)], inputs))
  await tick()
  assert.deepEqual(file('a.ts')?.reveal?.mark, { kind: 'edit', from: second, to: second + 1, lines: false })

  // the same with the outside-change watcher reloading the tab before follow gets to it
  reset()
  disk.set('a.ts', before)
  await state().open('a.ts')
  state().setFollow(true)
  disk.set('a.ts', after)
  state().syncDisk('a.ts', after)
  state().setLive(live([step('e2', 'Edit', 'ok', now() + 1)], { e2: inputs.e1 }))
  await tick()
  assert.equal(file('a.ts')?.rev, 1, 'reloaded once')
  assert.deepEqual(file('a.ts')?.reveal?.mark, { kind: 'edit', from: second, to: second + 1, lines: false })

  // a Write to an open tab marks the lines it changed rather than the top of the file
  reset()
  const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n')
  disk.set('w.ts', long)
  await state().open('w.ts')
  state().setFollow(true)
  disk.set('w.ts', long.replace('line 70', 'LINE SEVENTY'))
  state().setLive(live([step('w1', 'Write', 'ok', now() + 1)], { w1: { path: '/w/w.ts', isWrite: true } }))
  await tick()
  const text = file('w.ts')!.text
  assert.deepEqual(file('w.ts')?.reveal?.mark, { kind: 'edit', from: text.indexOf('LINE SEVENTY'), to: text.indexOf('LINE SEVENTY') + 'LINE SEVENTY'.length, lines: true })

  // a pure deletion has nothing to mark, but the editor scrolls to where the text went
  reset()
  disk.set('d.ts', long)
  await state().open('d.ts')
  state().setFollow(true)
  disk.set('d.ts', long.replace('line 60\n', ''))
  state().setLive(live([step('d1', 'Edit', 'ok', now() + 1)], { d1: { path: '/w/d.ts', edits: [{ old: 'line 60\n', new: '' }] } }))
  await tick()
  const d = file('d.ts')!
  const at = d.text.indexOf('line 61')
  assert.equal(d.reveal?.mark, undefined)
  assert.deepEqual(d.reveal?.range, { anchor: at, head: at + 'line 61'.length }, 'the line that took its place')
  assert.equal(d.reveal?.select, false)
})

test(`runtime: follow does not open a file over ${FOLLOW_MAX_BYTES} bytes (not even reading it); an open one still shows`, async () => {
  reset()
  stop()
  const logs: string[] = []
  stop = startFollow({ log: m => void logs.push(m) })
  disk.set('data/big.json', '[]')
  sizes.set('data/big.json', FOLLOW_MAX_BYTES + 1)
  disk.set('data/small.json', '[]')
  state().setLive(live([step('r1', 'Read', 'ok', now() + 1), step('r2', 'Read', 'ok', now() + 1)], { r1: { path: '/w/data/big.json', offset: 10, limit: 5 }, r2: { path: '/w/data/small.json' } }))
  await tick()
  assert.deepEqual(state().files.map(f => f.path), ['data/small.json'])
  assert.ok(!reads.includes('data/big.json'), 'not read either')
  assert.ok(logs.some(l => l.includes('data/big.json')), 'and says so in the log')
  // the user opened it anyway: follow shows it, it costs nothing more
  await state().open('data/big.json')
  state().setFollow(true)
  state().setLive(live([step('r3', 'Read', 'ok', now() + 1)], { r3: { path: '/w/data/big.json', offset: 1, limit: 1 } }))
  await tick()
  assert.equal(state().active, 'data/big.json')
  assert.ok(file('data/big.json')?.reveal?.mark)
  sizes.clear()
})

test('runtime: actions queued in one workspace do nothing after a switch to another, the one in flight included', async () => {
  reset()
  disk.set('a.ts', 'a')
  disk.set('b.ts', 'b')
  let release!: () => void
  gates.set('a.ts', new Promise<void>(r => (release = r)))
  state().setLive(live([step('r1', 'Read', 'ok', now() + 1), step('r2', 'Read', 'ok', now() + 1)], { r1: { path: '/w/a.ts' }, r2: { path: '/w/b.ts' } }))
  await tick()
  assert.deepEqual(state().files, [], 'the first read waits, the second is queued behind it')
  state().setWorkspace({ root: '/v', name: 'v' }) // a folder with files of the same names
  gates.delete('a.ts')
  release()
  await tick()
  assert.deepEqual(state().files, [], "neither lands in the new workspace")
})

test('runtime: an edit to a dirty tab keeps the edits and marks the change on disk', async () => {
  reset()
  disk.set('a.ts', 'one\n')
  await state().open('a.ts')
  state().update('a.ts', 'one\nmine\n')
  state().setFollow(true)
  const t = now() + 1
  disk.set('a.ts', 'one\ntheirs\n')
  state().setLive(live([step('e2', 'Edit', 'ok', t)], { e2: { path: 'a.ts', edits: [{ old: 'x', new: 'theirs' }] } }))
  await tick()
  const f = file('a.ts')!
  assert.equal(f.text, 'one\nmine\n')
  assert.equal(f.dirty, true)
  assert.deepEqual(reads.filter(p => p === 'a.ts').length, 1, 'only the open read: a dirty tab is not re-read by follow')
})

test('runtime: steps from before follow went on, from while it was off, or from a pause are not replayed', async () => {
  reset()
  disk.set('a.ts', 'a')
  disk.set('b.ts', 'b')
  disk.set('c.ts', 'c')
  state().setLive(live([step('old', 'Read', 'ok', now() - 60_000)], { old: { path: '/w/a.ts' } }))
  await tick()
  assert.equal(state().files.length, 0, 'a step from before')
  state().setFollow(false)
  const t = now() + 1
  state().setLive(live([step('off', 'Read', 'ok', t)], { off: { path: '/w/a.ts' } }))
  await tick()
  assert.equal(state().files.length, 0, 'off')
  state().setFollow(true)
  state().setLive(live([step('off', 'Read', 'ok', t)], { off: { path: '/w/a.ts' } }))
  await tick()
  assert.equal(state().files.length, 0, 'switching on does not replay what happened while off')
  state().pauseFollow()
  assert.ok(state().followPausedUntil > now() + FOLLOW_PAUSE_MS - 1000)
  const t2 = now() + 1
  state().setLive(live([step('p', 'Read', 'ok', t2)], { p: { path: '/w/b.ts' } }))
  await tick()
  assert.equal(state().files.length, 0, 'paused')
  useStore.setState({ followPausedUntil: now() - 1 }) // the 20 s are up
  state().setLive(live([step('p', 'Read', 'ok', t2), step('q', 'Read', 'ok', now() + 1)], { p: { path: '/w/b.ts' }, q: { path: '/w/c.ts' } }))
  await tick()
  assert.deepEqual(state().files.map(f => f.path), ['c.ts'], 'only the step after the pause')
})

test('runtime: manual navigation pauses follow (tree click, tab click, a key in the editor); the toggle resumes', async () => {
  reset()
  disk.set('a.ts', 'a')
  disk.set('b.ts', 'b')
  await state().open('a.ts') // a tree click
  assert.ok(state().followPausedUntil > now(), 'open by the user pauses')
  state().setFollow(true)
  assert.equal(state().followPausedUntil, 0, 'the toggle resumes at once')
  state().activate('a.ts') // a tab click
  assert.ok(state().followPausedUntil > now())
  state().setFollow(true)
  state().touch('a.ts') // a click or key in the editor
  assert.ok(state().followPausedUntil > now())
  state().setFollow(false)
  state().touch('a.ts')
  assert.equal(state().followPausedUntil, 0, 'off: nothing to pause')
  await state().open('b.ts', { by: 'cli' }) // Claude's openFile is not the user navigating
  assert.equal(state().followPausedUntil, 0)
})

test('runtime: a diff under review stays on top; the followed file waits underneath', async () => {
  reset()
  disk.set('a.ts', 'a\nb\n')
  state().openDiff({ id: 'd1', tabName: 'D1', oldPath: '/w/x.ts', newPath: '/w/x.ts', oldText: '', newContents: 'x' })
  const t = now() + 1
  state().setLive(live([step('r', 'Read', 'ok', t)], { r: { path: '/w/a.ts' } }))
  await tick()
  assert.equal(state().activeDiff, 'd1', 'the diff stays in front')
  assert.equal(state().active, 'a.ts', 'the file is ready underneath')
  assert.ok(file('a.ts')?.reveal?.mark, 'its wash applies when it shows')
  state().closeDiff('d1')
  assert.equal(state().activeDiff, undefined)
})

test(`runtime: follow keeps at most ${MAX_AUTO_TABS} tabs of its own, closing the least recently shown; not the user's or dirty ones`, async () => {
  reset()
  for (let i = 0; i < 12; i++) disk.set(`f${i}.ts`, `file ${i}`)
  disk.set('mine.ts', 'mine')
  await state().open('mine.ts')
  state().setFollow(true)
  const steps: Step[] = []
  const inputs: { [id: string]: StepInput } = {}
  const show = async (i: number) => {
    steps.push(step(`s${steps.length}`, 'Read', 'ok', now() + 1))
    inputs[`s${steps.length - 1}`] = { path: `/w/f${i}.ts` }
    state().setLive(live([...steps], { ...inputs }))
    await tick()
  }
  for (let i = 0; i < 8; i++) await show(i)
  assert.equal(state().files.filter(f => f.auto !== undefined).length, 8)
  state().update('f1.ts', 'typed') // the user types in one: it is theirs now
  state().setFollow(true)
  await show(0) // shown again: the most recently shown
  await show(8)
  await show(9)
  const paths = state().files.map(f => f.path)
  assert.ok(paths.includes('mine.ts'), "the user's tab stays")
  assert.ok(paths.includes('f1.ts'), 'the typed-in tab stays')
  assert.ok(paths.includes('f0.ts'), 'shown again recently: kept')
  assert.ok(!paths.includes('f2.ts') && paths.includes('f3.ts'), 'the least recently shown went first')
  assert.equal(state().files.filter(f => f.auto !== undefined).length, MAX_AUTO_TABS)
  assert.equal(state().active, 'f9.ts')
})

test('runtime: stop unsubscribes', async () => {
  reset()
  disk.set('a.ts', 'a')
  stop()
  state().setLive(live([step('z', 'Read', 'ok', now() + 1)], { z: { path: '/w/a.ts' } }))
  await tick()
  assert.equal(state().files.length, 0)
  stop = startFollow()
  stop()
})

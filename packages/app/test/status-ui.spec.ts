// The terminal's status chip (renderer/src/terminal/status.ts) and the main process's Attention
// (main/attention.ts). Attention imports electron, which is no module under plain Node: a resolve hook
// hands it a fake built here, so the calls it makes can be checked.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { afterEach, test } from 'node:test'

import { NO_PROGRAM, applyProgram, chipView } from '../src/renderer/src/terminal/status.ts'
import type { ProgramView } from '../src/renderer/src/terminal/status.ts'
import type { ProgramState, ProgramStatus } from '../src/shared/ipc.ts'

const st = (state: ProgramState, over: Partial<ProgramStatus> = {}): ProgramStatus => ({ state, id: '', at: 1, ...over })
const fold = (...list: ProgramStatus[]): ProgramView => list.reduce(applyProgram, NO_PROGRAM)

// ---- the chip

test('the main session: working with a spinner and its message, then blocked, done, idle, error', () => {
  assert.deepEqual(chipView(NO_PROGRAM), {})
  assert.deepEqual(chipView(fold(st('working', { msg: 'Reading files', progress: 40 }))).main, { tone: 'working', label: 'Working', detail: 'Reading files · 40%', title: 'Claude: working (Reading files · 40%)' })
  assert.deepEqual(chipView(fold(st('working'), st('blocked', { kind: 'permission', msg: 'Allow  Bash:\nnpm test?' }))).main, {
    tone: 'blocked',
    label: 'Needs you',
    detail: 'permission · Allow Bash: npm test?',
    title: 'Claude: needs you (permission · Allow Bash: npm test?)',
  })
  assert.deepEqual(chipView(fold(st('done', { msg: 'All tests pass', title: 'Retries' }))).main, { tone: 'done', label: 'Done', detail: 'All tests pass', title: 'Claude: done (All tests pass)\nRetries' })
  assert.equal(chipView(fold(st('idle'))).main?.detail, '')
  assert.equal(chipView(fold(st('error', { msg: 'API error' }))).main?.label, 'Error')
  assert.equal(chipView(fold(st('blocked', { progress: 10 }))).main?.detail, '', 'progress is for work, not waiting')
})

test('background tasks are counted beside the main session; the neediest sets the tone', () => {
  const v = fold(st('working', { msg: 'main' }), st('working', { id: 't1', title: 'Build' }), st('done', { id: 't2' }))
  assert.equal(v.main?.msg, 'main', 'tasks never replace the main session')
  assert.deepEqual(chipView(v).tasks, { count: 2, tone: 'working', label: '2 tasks · 1 running', title: 'Background tasks\nBuild: working\nt2: done' })
  const waiting = applyProgram(v, st('blocked', { id: 't2', kind: 'question' }))
  assert.deepEqual(chipView(waiting).tasks, { count: 2, tone: 'blocked', label: '2 tasks · 1 needs you', title: 'Background tasks\nBuild: working\nt2: needs you (question)' })
  assert.equal(chipView(fold(st('working', { id: 'only' }))).tasks?.label, '1 task', 'all running: no extra count')
  assert.equal(chipView(fold(st('working', { id: 'only' }))).main, undefined)
})

test('clear: an id clears that one, an empty id the main session, a bare clear everything', () => {
  const v = fold(st('working'), st('working', { id: 't1' }), st('working', { id: 't2' }))
  const noT1 = applyProgram(v, { state: 'clear', id: 't1', at: 2 })
  assert.deepEqual([...noT1.tasks.keys()], ['t2'])
  assert.equal(noT1.main?.state, 'working')
  const noMain = applyProgram(noT1, { state: 'clear', id: '', at: 3 })
  assert.equal(noMain.main, undefined)
  assert.equal(noMain.tasks.size, 1)
  assert.equal(applyProgram(v, { state: 'clear', at: 4 }), NO_PROGRAM, 'a bare clear')
  assert.equal(applyProgram(noMain, { state: 'clear', id: 'unknown', at: 5 }), noMain, 'clearing what is not there changes nothing')
  assert.equal(applyProgram(NO_PROGRAM, { state: 'clear', id: '', at: 5 }), NO_PROGRAM)
  assert.deepEqual(chipView(applyProgram(v, { state: 'clear', at: 6 })), {})
})

// ---- Attention, against a fake electron

type Call = [string, ...unknown[]]
const calls: Call[] = []
/** the AppUserModelIDs set, apart from `calls` so that the call sequences below stay as they are */
const aumids: string[] = []

class FakeNotification {
  static supported = true
  static all: FakeNotification[] = []
  static isSupported(): boolean {
    return FakeNotification.supported
  }
  readonly opts: { title: string; body: string; silent: boolean }
  readonly handlers = new Map<string, () => void>()
  shown = false
  closed = false
  constructor(opts: { title: string; body: string; silent: boolean }) {
    this.opts = opts
    FakeNotification.all.push(this)
  }
  on(event: string, fn: () => void): this {
    this.handlers.set(event, fn)
    return this
  }
  show(): void {
    this.shown = true
  }
  close(): void {
    this.closed = true
  }
}

const appListeners = new Map<string, Set<() => void>>()
const fakeApp = {
  dock: {
    setBadge: (text: string) => calls.push(['badge', text]),
    bounce: (type: string) => {
      calls.push(['bounce', type])
      return 7
    },
    cancelBounce: (id: number) => calls.push(['cancelBounce', id]),
  },
  on(event: string, fn: () => void) {
    if (!appListeners.has(event)) appListeners.set(event, new Set())
    appListeners.get(event)?.add(fn)
    return this
  },
  removeListener(event: string, fn: () => void) {
    appListeners.get(event)?.delete(fn)
    return this
  },
  focus: (opts: unknown) => calls.push(['app.focus', opts]),
  isPackaged: false,
  setAppUserModelId: (id: string): void => void aumids.push(id),
}
const emit = (event: string) => {
  for (const fn of appListeners.get(event) ?? []) fn()
}
const win = {
  focused: false,
  minimized: false,
  destroyed: false,
  isFocused() {
    return this.focused
  },
  isMinimized() {
    return this.minimized
  },
  isDestroyed() {
    return this.destroyed
  },
  restore: () => calls.push(['restore']),
  show: () => calls.push(['show']),
  focus: () => calls.push(['win.focus']),
  flashFrame: (flag: boolean) => calls.push(['flash', flag]),
}

;(globalThis as unknown as { __docentFakeElectron: unknown }).__docentFakeElectron = { app: fakeApp, Notification: FakeNotification }
const STUB = 'const e = globalThis.__docentFakeElectron; export const app = e.app; export const Notification = e.Notification; export default e;'
const HOOK = `export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true }
  return next(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(HOOK)}`)
const { APP_ID, Attention, appUserModelId, attentionFor, needsYouBody } = await import('../src/main/attention.ts')

const realPlatform = process.platform
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
const logs: string[] = []
const make = () => new Attention({ win: () => win as never, log: m => logs.push(m) })
const reset = (platform: string) => {
  setPlatform(platform)
  calls.length = 0
  logs.length = 0
  FakeNotification.all.length = 0
  FakeNotification.supported = true
  win.focused = false
  win.minimized = false
  win.destroyed = false
}
const notes = () => FakeNotification.all.map(n => ({ title: n.opts.title, body: n.opts.body, silent: n.opts.silent, shown: n.shown, closed: n.closed }))
afterEach(() => setPlatform(realPlatform))

test('a call only on a change into blocked or done, and only while away', () => {
  assert.equal(attentionFor(undefined, 'blocked', false), 'needs-you')
  assert.equal(attentionFor('working', 'blocked', false), 'needs-you')
  assert.equal(attentionFor('blocked', 'blocked', false), undefined, 'a second report of the same wait')
  assert.equal(attentionFor('working', 'blocked', true), undefined, 'the person is looking')
  assert.equal(attentionFor('working', 'done', false), 'done')
  assert.equal(attentionFor('done', 'done', false), undefined)
  assert.equal(attentionFor('blocked', 'working', false), undefined)
  assert.equal(attentionFor(undefined, 'error', false), undefined)
  assert.equal(needsYouBody({ kind: 'permission', msg: 'Bash wants to run npm test' }), 'Permission needed: Bash wants to run npm test')
  assert.equal(needsYouBody({ kind: 'question' }), 'A question for you')
  assert.equal(needsYouBody({ kind: 'mfa', msg: ' code\nplease ' }), 'mfa: code please')
  assert.equal(needsYouBody({}), 'Claude is waiting for you in Docent.')
})

test('macOS: blocked while away notifies once, badges and bounces; moving on takes it all down', () => {
  reset('darwin')
  const a = make()
  a.onProgram('p1', st('working'))
  assert.deepEqual(calls, [])
  a.onProgram('p1', st('blocked', { kind: 'permission', msg: 'Allow Edit?' }))
  assert.deepEqual(notes(), [{ title: 'Claude needs you', body: 'Permission needed: Allow Edit?', silent: false, shown: true, closed: false }])
  assert.deepEqual(calls, [['badge', '1'], ['bounce', 'informational']])
  a.onProgram('p1', st('blocked', { kind: 'question', msg: 'Which file?' }))
  assert.equal(FakeNotification.all.length, 1, 'still the same wait: no second call')
  calls.length = 0
  a.onProgram('p1', st('working'))
  assert.equal(FakeNotification.all[0]?.closed, true, 'the call is answered')
  assert.deepEqual(calls, [['badge', ''], ['cancelBounce', 7]])
  a.dispose()
})

test('done while away: a quiet notification and no badge; nothing while focused', () => {
  reset('darwin')
  const a = make()
  a.onProgram('p1', st('working'))
  a.onProgram('p1', st('done', { msg: 'Added retries' }))
  assert.deepEqual(notes(), [{ title: 'Claude is done', body: 'Added retries', silent: true, shown: true, closed: false }])
  assert.deepEqual(calls, [])
  reset('darwin')
  win.focused = true
  a.onProgram('p1', st('blocked', { kind: 'permission' }))
  a.onProgram('p1', st('done'))
  assert.deepEqual(notes(), [])
  assert.deepEqual(calls, [])
  a.dispose()
})

test('the window gaining focus answers every call; a click brings the window back', () => {
  reset('darwin')
  const a = make()
  a.onProgram('p1', st('blocked', { kind: 'permission' }))
  a.onProgram('p2', st('done'))
  assert.equal(FakeNotification.all.length, 2)
  calls.length = 0
  emit('browser-window-focus')
  assert.deepEqual(notes().map(n => n.closed), [true, true])
  assert.deepEqual(calls, [['badge', ''], ['cancelBounce', 7]])
  // still blocked, but the person has seen it: no new call until the state changes
  a.onProgram('p1', st('blocked', { kind: 'permission' }))
  assert.equal(FakeNotification.all.length, 2)
  a.onProgram('p1', st('working'))
  a.onProgram('p1', st('blocked', { kind: 'question' }))
  assert.equal(FakeNotification.all.length, 3)
  calls.length = 0
  win.minimized = true
  FakeNotification.all[2]?.handlers.get('click')?.()
  assert.deepEqual(calls, [['restore'], ['show'], ['app.focus', { steal: true }], ['win.focus']])
  a.dispose()
})

test('Windows: the taskbar button flashes instead, and stops; no dock calls', () => {
  reset('win32')
  const a = make()
  a.onProgram('p1', st('blocked', { kind: 'permission' }))
  assert.deepEqual(calls, [['flash', true]])
  a.onProgram('p1', st('working'))
  assert.deepEqual(calls, [['flash', true], ['flash', false]])
  calls.length = 0
  a.onProgram('p1', st('blocked'))
  emit('browser-window-focus')
  assert.deepEqual(calls, [['flash', true], ['flash', false]])
  calls.length = 0
  win.minimized = false
  FakeNotification.all.at(-1)?.handlers.get('click')?.()
  assert.deepEqual(calls, [['show'], ['win.focus']], 'app.focus is macOS only')
  a.dispose()
})

test('several sessions: the badge counts the waiting ones; tasks and clears', () => {
  reset('darwin')
  const a = make()
  a.onProgram('p1', st('blocked'))
  a.onProgram('p2', st('blocked'))
  assert.deepEqual(calls, [['badge', '1'], ['bounce', 'informational'], ['badge', '2']])
  calls.length = 0
  a.onProgram('p1', { state: 'clear', at: 5 })
  assert.deepEqual(calls, [['badge', '1']], 'a bare clear (the pty exited) releases it')
  a.onProgram('p2', st('blocked', { id: 'task-1' }))
  a.onProgram('p2', { state: 'clear', id: 'task-1', at: 6 })
  assert.deepEqual(calls, [['badge', '1']], "a background task's report changes nothing")
  a.onProgram('p2', { state: 'clear', id: '', at: 7 })
  assert.deepEqual(calls, [['badge', '1'], ['badge', ''], ['cancelBounce', 7]])
  calls.length = 0
  a.onProgram('p2', st('blocked'))
  assert.deepEqual(calls, [['badge', '1'], ['bounce', 'informational']], 'cleared state: blocked again is a new call')
  a.dispose()
})

test('without notification support the badge still rises; a failing call is logged, not thrown', () => {
  reset('darwin')
  FakeNotification.supported = false
  const a = make()
  a.onProgram('p1', st('blocked'))
  assert.deepEqual(notes(), [])
  assert.deepEqual(calls, [['badge', '1'], ['bounce', 'informational']])
  a.dispose()
  reset('linux')
  const b = make()
  const flash = win.flashFrame
  win.flashFrame = () => {
    throw new Error('no window manager')
  }
  b.onProgram('p1', st('blocked'))
  assert.deepEqual(logs, ['attention: flashing the window failed: no window manager'])
  win.flashFrame = flash
  b.dispose()
})

test('dispose: stops listening, takes everything down, and ignores later reports', () => {
  reset('darwin')
  const before = appListeners.get('browser-window-focus')?.size ?? 0
  const a = make()
  assert.equal(appListeners.get('browser-window-focus')?.size, before + 1)
  a.onProgram('p1', st('blocked'))
  calls.length = 0
  a.dispose()
  assert.equal(appListeners.get('browser-window-focus')?.size, before)
  assert.equal(FakeNotification.all[0]?.closed, true)
  assert.deepEqual(calls, [['badge', ''], ['cancelBounce', 7]])
  a.dispose()
  a.onProgram('p1', st('working'))
  a.onProgram('p1', st('blocked'))
  assert.equal(FakeNotification.all.length, 1)
  assert.deepEqual(calls, [['badge', ''], ['cancelBounce', 7]])
})

test("Windows: toasts go out under the installer shortcut's id (electron-builder's appId); other platforms leave the id alone", async () => {
  assert.equal(appUserModelId(true, 'C:\\Program Files\\Docent\\Docent.exe'), APP_ID)
  assert.equal(appUserModelId(false, 'C:\\dev\\electron.exe'), 'C:\\dev\\electron.exe', 'in development, as Electron advises')
  const yml = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.equal(/^appId:\s*(\S+)\s*$/m.exec(yml)?.[1], APP_ID, "the installer's shortcut carries the appId")
  reset('win32')
  aumids.length = 0
  make().dispose()
  fakeApp.isPackaged = true
  make().dispose()
  fakeApp.isPackaged = false
  assert.deepEqual(aumids, [process.execPath, APP_ID], 'set at construction: the dev binary, then the packaged id')
  const set = fakeApp.setAppUserModelId
  fakeApp.setAppUserModelId = () => {
    throw new Error('denied')
  }
  make().dispose()
  fakeApp.setAppUserModelId = set
  assert.deepEqual(logs, ['attention: setting the app id failed: denied'], 'logged, not thrown')
  for (const platform of ['darwin', 'linux']) {
    reset(platform)
    aumids.length = 0
    make().dispose()
    assert.deepEqual(aumids, [], platform)
  }
})

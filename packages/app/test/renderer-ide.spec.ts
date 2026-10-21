// Drives packages/app/src/renderer/src/editor/ide.ts under Node 22 with a fake window.docent and the real zustand
// store; then showLines, the outside-change flow (editor/disk.ts) and, on a real temporary folder, the main
// process's file watcher (src/main/watchFiles.ts) feeding it.
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import type { FileChange } from '../src/shared/ipc.ts'

type Msg = { kind: 'reply'; id: string; result: unknown } | { kind: 'state'; s: unknown } | { kind: 'mention'; m: unknown }
const sent: Msg[] = []
const disk = new Map<string, string>()
let listener: ((e: unknown) => void) | undefined
/** what the renderer asked main to watch, each call */
const watched: string[][] = []
/** runs as main is asked to watch, before anything else happens */
let onWatch: ((paths: string[]) => void) | undefined
let changedListener: ((e: FileChange) => void) | undefined
/** reads held back until released, to order a slow read after a fast one */
const gates = new Map<string, Promise<void>>()
const readCount = new Map<string, number>()
const api = {
  workspace: {
    read: async (p: string) => {
      readCount.set(p, (readCount.get(p) ?? 0) + 1)
      await gates.get(p)
      if (!disk.has(p)) throw new Error(`Error invoking remote method 'workspace:read': Error: ENOENT: no such file or directory, open '${p}'`)
      return disk.get(p)!
    },
    write: async (p: string, t: string) => {
      if (p.startsWith('nowrite')) throw new Error(`EACCES: ${p}`)
      disk.set(p, t)
    },
    watch: (paths: string[]) => {
      watched.push(paths)
      onWatch?.(paths)
    },
    onChanged: (fn: (e: FileChange) => void) => {
      changedListener = fn
      return () => {
        changedListener = undefined
      }
    },
  },
  ide: {
    onEvent: (fn: (e: unknown) => void) => {
      listener = fn
      return () => {
        listener = undefined
      }
    },
    reply: (id: string, result: unknown) => sent.push({ kind: 'reply', id, result }),
    editorState: (s: unknown) => sent.push({ kind: 'state', s }),
    atMentioned: (m: unknown) => sent.push({ kind: 'mention', m }),
  },
}
;(globalThis as unknown as { window: unknown }).window = { docent: api }

const ide = await import('../src/renderer/src/editor/ide.ts')
const diskWatch = await import('../src/renderer/src/editor/disk.ts')
const { DiskChangedError, useStore } = await import('../src/renderer/src/store.ts')
const { FileWatcher } = await import('../src/main/watchFiles.ts')

const ROOT = '/w'
const send = (request: object) => listener!({ type: 'request', request })
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
const replies = (id: string) => sent.filter(m => m.kind === 'reply' && m.id === id).map(m => (m as { result: unknown }).result)
const states = () => sent.filter(m => m.kind === 'state').map(m => (m as { s: unknown }).s)
const reset = () => {
  sent.length = 0
  disk.clear()
  useStore.getState().setWorkspace({ root: ROOT, name: 'w' })
  sent.length = 0
}

const stop = ide.startIde()
assert.equal(ide.startIde(), stop, 'a second startIde returns the same stop')
reset()

test('openDiff: left = disk; accept answers saved once with the right side, reloads the open tab and does not write (the CLI does)', async () => {
  reset()
  disk.set('a.ts', 'old')
  await useStore.getState().open('a.ts')
  useStore.getState().update('a.ts', 'dirty edits')
  send({ type: 'openDiff', id: 'd1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'new', tabName: 'T1' })
  await tick()
  const d = useStore.getState().diffs[0]
  assert.equal(d.oldText, 'old', 'left side is the disk text, not the dirty editor text')
  assert.equal(d.text, 'new')
  assert.equal(useStore.getState().activeDiff, 'd1')
  assert.equal(useStore.getState().active, 'a.ts', 'the file stays active underneath')
  const err = ide.acceptDiff('d1', 'new edited')
  assert.equal(err, undefined)
  assert.equal(disk.get('a.ts'), 'old', 'the disk is untouched: the CLI applies the accepted text itself')
  const f = useStore.getState().files[0]
  assert.equal(f.text, 'new edited', 'the open tab shows the accepted text')
  assert.equal(f.dirty, false)
  assert.equal(f.rev, 1)
  assert.deepEqual(useStore.getState().diffs, [])
  assert.equal(useStore.getState().activeDiff, undefined)
  assert.deepEqual(replies('d1'), [{ outcome: 'saved', contents: 'new edited' }])
  useStore.getState().closeDiff('d1')
  assert.equal(replies('d1').length, 1, 'no second reply')
})

test('openDiff: a file that does not exist reads as empty; accept answers saved without creating it', async () => {
  reset()
  send({ type: 'openDiff', id: 'd2', oldPath: '/w/new.ts', newPath: '/w/new.ts', newContents: 'fresh', tabName: 'T2' })
  await tick()
  assert.equal(useStore.getState().diffs[0].oldText, '')
  assert.equal(ide.acceptDiff('d2', 'fresh'), undefined)
  assert.equal(disk.has('new.ts'), false)
  assert.deepEqual(replies('d2'), [{ outcome: 'saved', contents: 'fresh' }])
  assert.deepEqual(useStore.getState().files, [], 'no tab was opened for a file that is not open')
})

test('openDiff outside the root is rejected without a tab; no workspace likewise', async () => {
  reset()
  send({ type: 'openDiff', id: 'd3', oldPath: '/w/../x/a.ts', newPath: '/x/a.ts', newContents: 'n', tabName: 'T3' })
  await tick()
  assert.deepEqual(replies('d3'), [{ outcome: 'rejected' }])
  assert.deepEqual(useStore.getState().diffs, [])
})

test('reject, closeTab and closeAllDiffTabs answer rejected; a bare store removal and setWorkspace answer closed; each once', async () => {
  reset()
  send({ type: 'openDiff', id: 'r1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'R1' })
  await tick()
  ide.rejectDiff('r1') // the Reject button and the tab's × both call this
  assert.deepEqual(replies('r1'), [{ outcome: 'rejected' }])
  assert.deepEqual(useStore.getState().diffs, [])

  send({ type: 'openDiff', id: 'x1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'X1' })
  await tick()
  useStore.getState().closeDiff('x1') // removed by nobody with a verdict
  assert.deepEqual(replies('x1'), [{ outcome: 'closed' }])

  send({ type: 'openDiff', id: 'c1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'C1' })
  await tick()
  send({ type: 'closeTab', id: 'ct1', tabName: 'C1' })
  send({ type: 'closeTab', id: 'ct2', tabName: 'nope' })
  await tick()
  assert.deepEqual(replies('c1'), [{ outcome: 'rejected' }], 'a diff the CLI closes while it waits is rejected, as in the extension')
  assert.deepEqual(replies('ct1'), [{ ok: true }])
  assert.deepEqual(replies('ct2'), [{ ok: false, error: 'no such tab' }])
  assert.deepEqual(useStore.getState().diffs, [])

  send({ type: 'openDiff', id: 'a1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'A1' })
  send({ type: 'openDiff', id: 'a2', oldPath: '/w/b.ts', newPath: '/w/b.ts', newContents: 'n', tabName: 'A2' })
  await tick()
  assert.equal(useStore.getState().diffs.length, 2)
  send({ type: 'closeAllDiffTabs', id: 'ca' })
  await tick()
  assert.deepEqual(replies('ca'), [{ ok: true, count: 2 }])
  assert.deepEqual(replies('a1'), [{ outcome: 'rejected' }])
  assert.deepEqual(replies('a2'), [{ outcome: 'rejected' }])
  assert.deepEqual(useStore.getState().diffs, [])
  send({ type: 'closeAllDiffTabs', id: 'ca0' })
  await tick()
  assert.deepEqual(replies('ca0'), [{ ok: true, count: 0 }])

  send({ type: 'openDiff', id: 'w1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'W1' })
  await tick()
  useStore.getState().setWorkspace({ root: '/other', name: 'o' })
  assert.deepEqual(replies('w1'), [{ outcome: 'closed' }])
})

test("the CLI's closeTab after a verdict finds nothing and causes no second reply", async () => {
  reset()
  send({ type: 'openDiff', id: 'v1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'V1' })
  await tick()
  assert.equal(ide.acceptDiff('v1', 'n'), undefined)
  send({ type: 'closeTab', id: 'vc', tabName: 'V1' })
  await tick()
  assert.deepEqual(replies('v1'), [{ outcome: 'saved', contents: 'n' }])
  assert.deepEqual(replies('vc'), [{ ok: false, error: 'no such tab' }])
})

test('a second openDiff with the same tabName replaces the first, which gets closed', async () => {
  reset()
  send({ type: 'openDiff', id: 's1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'one', tabName: 'S' })
  await tick()
  send({ type: 'openDiff', id: 's2', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'two', tabName: 'S' })
  await tick()
  assert.deepEqual(replies('s1'), [{ outcome: 'closed' }])
  assert.deepEqual(useStore.getState().diffs.map(d => d.id), ['s2'])
  assert.equal(useStore.getState().activeDiff, 's2')
  ide.rejectDiff('s2')
  assert.deepEqual(replies('s2'), [{ outcome: 'rejected' }])
})

test('openFile: opens relative, reveal carries the range and focus; outside and missing files fail', async () => {
  reset()
  disk.set('src/a.ts', 'first line\nsecond line\nthird')
  send({ type: 'openFile', id: 'o1', path: '/w/src/a.ts', preview: false, startText: 'second', endText: 'th', selectToEndOfLine: true, makeFrontmost: false })
  await tick()
  assert.deepEqual(replies('o1'), [{ ok: true }])
  const f = useStore.getState().files.find(x => x.path === 'src/a.ts')!
  assert.ok(f)
  assert.equal(useStore.getState().active, 'src/a.ts')
  assert.deepEqual(f.reveal?.range, { anchor: 11, head: 28 })
  assert.equal(f.reveal?.focus, false)
  send({ type: 'openFile', id: 'o2', path: '/elsewhere/a.ts', preview: false, selectToEndOfLine: false, makeFrontmost: true })
  send({ type: 'openFile', id: 'o3', path: '/w/missing.ts', preview: false, selectToEndOfLine: false, makeFrontmost: true })
  send({ type: 'openFile', id: 'o4', path: 'src/a.ts', preview: false, startText: 'nope', selectToEndOfLine: false, makeFrontmost: true })
  await tick()
  assert.deepEqual(replies('o2'), [{ ok: false, error: 'outside workspace' }])
  assert.equal(replies('o3').length, 1)
  assert.match(JSON.stringify(replies('o3')[0]), /"ok":false.*ENOENT/)
  assert.deepEqual(replies('o4'), [{ ok: true }], 'relative path resolves; startText not found still ok')
  assert.equal(useStore.getState().files.find(x => x.path === 'src/a.ts')!.reveal?.range, undefined)
  assert.equal(useStore.getState().files.length, 1, 'no duplicate tab')
})

test('saveDocument: not open → error; open → written', async () => {
  reset()
  disk.set('a.ts', 'old')
  send({ type: 'saveDocument', id: 'sv1', path: '/w/a.ts' })
  await tick()
  assert.deepEqual(replies('sv1'), [{ ok: false, error: 'not open' }])
  await useStore.getState().open('a.ts')
  useStore.getState().update('a.ts', 'changed')
  send({ type: 'saveDocument', id: 'sv2', path: '/w/a.ts' })
  await tick()
  assert.deepEqual(replies('sv2'), [{ ok: true }])
  assert.equal(disk.get('a.ts'), 'changed')
  assert.equal(useStore.getState().files[0].dirty, false)
})

test('editorState: absolute paths, debounced, identical states not re-sent, no active while a diff is on top', async () => {
  reset()
  disk.set('a.ts', 'hello\nworld')
  await useStore.getState().open('a.ts')
  const st = EditorState.create({ doc: 'hello\nworld', selection: EditorSelection.single(6, 11) })
  ide.selectionChanged('a.ts', st)
  await tick(150)
  const last = states().at(-1) as { open: unknown; active: unknown; selection: { selection: unknown } }
  assert.deepEqual(last.open, [{ path: '/w/a.ts', dirty: false }])
  assert.equal(last.active, '/w/a.ts')
  assert.deepEqual(last.selection.selection, { start: { line: 1, character: 0 }, end: { line: 1, character: 5 }, isEmpty: false })
  const n = states().length
  ide.selectionChanged('a.ts', st)
  await tick(150)
  assert.equal(states().length, n, 'identical state not re-sent')
  send({ type: 'openDiff', id: 'e1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'E1' })
  await tick()
  ide.selectionChanged(undefined, undefined)
  await tick(150)
  const onTop = states().at(-1) as { active: unknown; selection: unknown }
  assert.equal(onTop.active, undefined)
  assert.equal(onTop.selection, undefined)
  ide.rejectDiff('e1')
})

test('atMention sends 0-based lines for the selection, none when empty', () => {
  reset()
  const st = EditorState.create({ doc: 'a\nb\nc', selection: EditorSelection.single(2, 4) })
  ide.atMention('x.ts', st)
  assert.deepEqual(sent.at(-1), { kind: 'mention', m: { filePath: '/w/x.ts', lineStart: 1, lineEnd: 2 } })
  ide.atMention('x.ts', EditorState.create({ doc: 'a\nb\nc', selection: EditorSelection.single(2) }))
  assert.deepEqual(sent.at(-1), { kind: 'mention', m: { filePath: '/w/x.ts' } })
})

test('accept is synchronous: a × straight after it has nothing left to answer, and the disk stays as it was', async () => {
  reset()
  disk.set('a.ts', 'old')
  send({ type: 'openDiff', id: 'rc1', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'n', tabName: 'RC' })
  await tick()
  assert.equal(ide.acceptDiff('rc1', 'accepted text'), undefined)
  ide.rejectDiff('rc1') // the × arriving a tick later
  useStore.getState().closeDiff('rc1')
  assert.equal(disk.get('a.ts'), 'old')
  assert.deepEqual(replies('rc1'), [{ outcome: 'saved', contents: 'accepted text' }])
})

test('two concurrent open() of the same path produce one tab', async () => {
  reset()
  disk.set('a.ts', 'x')
  await Promise.all([useStore.getState().open('a.ts'), useStore.getState().open('a.ts')])
  assert.equal(useStore.getState().files.filter(f => f.path === 'a.ts').length, 1)
  assert.equal(useStore.getState().active, 'a.ts')
})

test('a concurrent open() landing after the user typed keeps the dirty text', async () => {
  reset()
  disk.set('a.ts', 'x')
  const first = useStore.getState().open('a.ts')
  const second = useStore.getState().open('a.ts')
  await first
  useStore.getState().update('a.ts', 'typed')
  await second
  const f = useStore.getState().files.filter(x => x.path === 'a.ts')
  assert.equal(f.length, 1)
  assert.equal(f[0].text, 'typed')
  assert.equal(f[0].dirty, true)
})

test('accept of a diff that is gone, or whose file lies outside the workspace, reports it and leaves things alone', async () => {
  reset()
  assert.equal(ide.acceptDiff('nope', 'x'), 'diff is gone')
  assert.deepEqual(replies('nope'), [])
  // only reachable if a diff survived a root change; the store's setWorkspace drops them, so plant one
  useStore.setState({ diffs: [{ id: 'out', tabName: 'OUT', oldPath: '/x/a.ts', newPath: '/x/a.ts', oldText: '', newContents: 'n', text: 'n' }] })
  assert.equal(ide.acceptDiff('out', 'n'), 'outside workspace')
  assert.equal(useStore.getState().diffs.length, 1)
  assert.deepEqual(replies('out'), [])
  useStore.setState({ diffs: [] })
})

test('stop unsubscribes; a request after stop is unanswered; restart works', async () => {
  reset()
  stop()
  assert.equal(listener, undefined)
  const again = ide.startIde()
  assert.notEqual(again, stop)
  assert.ok(listener)
  send({ type: 'closeTab', id: 'after', tabName: 'x' })
  await tick()
  assert.equal(replies('after').length, 1)
  again()
})

// ---- showLines

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
/** the stop test above leaves the CLI's request handler stopped; the tests below that send requests restart it */
const ideRunning = () => {
  if (!listener) ide.startIde()
}

test('showLines: absolute or relative path, lines revealed without selecting, a read wash; outside the root nothing', async () => {
  reset()
  disk.set('src/a.ts', lines(50))
  await useStore.getState().showLines({ path: '/w/src/a.ts', fromLine: 2, toLine: 3, kind: 'read', focus: false })
  const f = useStore.getState().files.find(x => x.path === 'src/a.ts')!
  assert.equal(useStore.getState().active, 'src/a.ts')
  assert.deepEqual(f.reveal?.range, { anchor: 7, head: 20 })
  assert.equal(f.reveal?.select, false, 'select only with focus')
  assert.equal(f.reveal?.focus, false)
  assert.deepEqual(f.reveal?.mark, { kind: 'read', from: 7, to: 20, lines: true })
  await useStore.getState().showLines({ path: 'src/a.ts', fromLine: 10, kind: 'jump', focus: true })
  const g = useStore.getState().files.find(x => x.path === 'src/a.ts')!
  assert.equal(g.reveal?.mark, undefined, 'a jump leaves no mark')
  assert.equal(g.reveal?.select, true)
  assert.equal(g.reveal?.focus, true)
  assert.equal(useStore.getState().files.length, 1, 'no second tab')
  await useStore.getState().showLines({ path: '/elsewhere/a.ts', fromLine: 1, kind: 'read', focus: false })
  await useStore.getState().showLines({ path: '/w', fromLine: 1, kind: 'read', focus: false })
  await useStore.getState().showLines({ path: '/w/../x.ts', fromLine: 1, kind: 'read', focus: false })
  assert.equal(useStore.getState().files.length, 1)
})

test('showLines: an edit marks the find text nearest fromLine; not found, it marks the lines; a newer reveal drops older pending ones', async () => {
  reset()
  disk.set('a.ts', 'foo()\nx\nx\nx\nfoo()\nx\n')
  disk.set('b.ts', 'b\n')
  await useStore.getState().showLines({ path: 'a.ts', fromLine: 4, find: 'foo()', kind: 'edit', focus: false })
  assert.deepEqual(useStore.getState().files[0]!.reveal?.mark, { kind: 'edit', from: 12, to: 17, lines: false })
  await useStore.getState().showLines({ path: 'a.ts', fromLine: 2, toLine: 3, find: 'nope', kind: 'edit', focus: false })
  assert.deepEqual(useStore.getState().files[0]!.reveal?.mark, { kind: 'edit', from: 6, to: 9, lines: true })
  await useStore.getState().showLines({ path: 'a.ts', find: 'nope', kind: 'edit', focus: false })
  assert.ok(useStore.getState().files[0]!.reveal, 'nothing to point at: the tab shows, the earlier request stays')
  await useStore.getState().showLines({ path: 'b.ts', fromLine: 1, kind: 'read', focus: false })
  assert.equal(useStore.getState().files.find(x => x.path === 'a.ts')!.reveal, undefined)
  assert.ok(useStore.getState().files.find(x => x.path === 'b.ts')!.reveal)
})

test('showLines by the user (the steps strip) pauses follow mode; a missing file rejects', async () => {
  reset()
  useStore.getState().setFollow(true)
  disk.set('a.ts', 'a')
  await useStore.getState().showLines({ path: 'a.ts', fromLine: 1, kind: 'jump', focus: true })
  assert.ok(useStore.getState().followPausedUntil > Date.now())
  await assert.rejects(useStore.getState().showLines({ path: 'gone.ts', fromLine: 1, kind: 'jump', focus: true }), /ENOENT/)
})

// ---- outside changes: the renderer side (editor/disk.ts) with a fake main

const change = async (path: string, kind: FileChange['kind'] = 'change') => {
  changedListener!({ path, kind })
  await tick()
}
const fileOf = (path: string) => useStore.getState().files.find(f => f.path === path)!

test('disk: the open tabs are reported (sorted, once per distinct set); stop asks main to let go', async () => {
  reset()
  watched.length = 0
  const stopDisk = diskWatch.startDiskWatch()
  assert.equal(diskWatch.startDiskWatch(), stopDisk, 'once')
  assert.deepEqual(watched, [[]])
  disk.set('b.ts', 'b')
  disk.set('a.ts', 'a')
  await useStore.getState().open('b.ts')
  await useStore.getState().open('a.ts')
  useStore.getState().update('a.ts', 'typing does not re-report')
  useStore.getState().close('b.ts')
  assert.deepEqual(watched, [[], ['b.ts'], ['a.ts', 'b.ts'], ['a.ts']])
  stopDisk()
  assert.equal(changedListener, undefined)
  assert.deepEqual(watched.at(-1), [])
})

test('disk: a clean tab reloads; equal text is a no-op; a dirty tab is marked, then Reload or Keep mine; deletion is marked', async () => {
  reset()
  const stopDisk = diskWatch.startDiskWatch()
  disk.set('a.ts', 'one')
  await useStore.getState().open('a.ts')
  const files = useStore.getState().files
  await change('a.ts')
  assert.equal(useStore.getState().files, files, 'unchanged on disk: not even a store update')
  disk.set('a.ts', 'two')
  await change('a.ts')
  assert.equal(fileOf('a.ts').text, 'two')
  assert.equal(fileOf('a.ts').rev, 1)
  useStore.getState().update('a.ts', 'mine')
  disk.set('a.ts', 'three')
  await change('a.ts')
  assert.equal(fileOf('a.ts').text, 'mine', 'unsaved edits are kept')
  assert.equal(fileOf('a.ts').diskChanged, true)
  assert.equal(fileOf('a.ts').diskText, 'three')
  useStore.getState().keepMine('a.ts')
  assert.equal(fileOf('a.ts').diskChanged, undefined)
  assert.equal(fileOf('a.ts').dirty, true)
  await change('a.ts')
  assert.equal(fileOf('a.ts').diskChanged, undefined, 'the version already seen does not ask again')
  disk.set('a.ts', 'four')
  await change('a.ts')
  assert.equal(fileOf('a.ts').diskChanged, true, 'a newer one does')
  await diskWatch.reloadFromDisk('a.ts')
  assert.equal(fileOf('a.ts').text, 'four')
  assert.equal(fileOf('a.ts').dirty, false)
  assert.equal(fileOf('a.ts').diskChanged, undefined)
  disk.delete('a.ts')
  await change('a.ts', 'unlink')
  assert.equal(fileOf('a.ts').deleted, true)
  assert.equal(fileOf('a.ts').text, 'four', 'the text stays')
  disk.set('a.ts', 'four')
  await change('a.ts')
  assert.equal(fileOf('a.ts').deleted, undefined, 'back as it was')
  disk.delete('a.ts')
  await change('a.ts') // a change whose read finds nothing counts as deleted too
  assert.equal(fileOf('a.ts').deleted, true)
  useStore.getState().keepMine('a.ts')
  assert.equal(fileOf('a.ts').deleted, undefined)
  assert.equal(fileOf('a.ts').dirty, true, 'kept as unsaved edits')
  await useStore.getState().save('a.ts')
  assert.equal(disk.get('a.ts'), 'four', 'saving writes it back')
  await change('a.ts')
  assert.equal(fileOf('a.ts').rev, 2, 'our own save is nothing new')
  await change('other.ts')
  stopDisk()
})

test('disk: an older read that finishes late does not win over a newer one', async () => {
  reset()
  const stopDisk = diskWatch.startDiskWatch()
  disk.set('a.ts', 'v1')
  await useStore.getState().open('a.ts')
  let release!: () => void
  gates.set('a.ts', new Promise<void>(r => (release = r)))
  disk.set('a.ts', 'v2')
  changedListener!({ path: 'a.ts', kind: 'change' }) // its read waits at the gate
  gates.delete('a.ts')
  disk.set('a.ts', 'v3')
  await change('a.ts')
  assert.equal(fileOf('a.ts').text, 'v3')
  disk.set('a.ts', 'v2-late')
  release()
  await tick()
  assert.equal(fileOf('a.ts').text, 'v3', 'the stale result is dropped')
  stopDisk()
})

test('accept, then the CLI writes the file and the watcher fires: a no-op, not a flicker', async () => {
  reset()
  ideRunning()
  const stopDisk = diskWatch.startDiskWatch()
  disk.set('a.ts', 'old')
  await useStore.getState().open('a.ts')
  useStore.getState().update('a.ts', 'dirty edits')
  send({ type: 'openDiff', id: 'acc', oldPath: '/w/a.ts', newPath: '/w/a.ts', newContents: 'new', tabName: 'ACC' })
  await tick()
  assert.equal(ide.acceptDiff('acc', 'accepted'), undefined)
  assert.equal(fileOf('a.ts').rev, 1)
  const files = useStore.getState().files
  disk.set('a.ts', 'accepted') // the CLI's write
  await change('a.ts')
  assert.equal(useStore.getState().files, files, 'nothing changes')
  assert.equal(fileOf('a.ts').rev, 1)
  assert.equal(fileOf('a.ts').dirty, false)
  stopDisk()
})

// ---- a Windows root: paths to the CLI in the root's style, paths from it in any spelling

test('Windows root: editor state, selection and @-mentions use backslash paths; the CLI may spell paths any way', async () => {
  ideRunning()
  sent.length = 0
  disk.clear()
  useStore.getState().setWorkspace({ root: 'C:\\Users\\me\\proj', name: 'proj' })
  disk.set('src/a.ts', 'hello\nworld')
  await useStore.getState().open('src/a.ts')
  ide.selectionChanged('src/a.ts', EditorState.create({ doc: 'hello\nworld', selection: EditorSelection.single(6, 11) }))
  await tick(150)
  const last = states().at(-1) as { open: unknown; active: unknown; selection: { filePath: unknown } }
  assert.deepEqual(last.open, [{ path: 'C:\\Users\\me\\proj\\src\\a.ts', dirty: false }])
  assert.equal(last.active, 'C:\\Users\\me\\proj\\src\\a.ts')
  assert.equal(last.selection.filePath, 'C:\\Users\\me\\proj\\src\\a.ts')
  ide.atMention('src/a.ts', EditorState.create({ doc: 'a\nb', selection: EditorSelection.single(0, 3) }))
  assert.deepEqual(sent.at(-1), { kind: 'mention', m: { filePath: 'C:\\Users\\me\\proj\\src\\a.ts', lineStart: 0, lineEnd: 1 } })
  // openFile with forward slashes and another case lands on the open tab
  send({ type: 'openFile', id: 'wo1', path: 'c:/users/me/PROJ/SRC/A.ts', preview: false, startText: 'world', selectToEndOfLine: false, makeFrontmost: false })
  await tick()
  assert.deepEqual(replies('wo1'), [{ ok: true }])
  assert.equal(useStore.getState().files.length, 1, 'the same file in another case is the same tab')
  assert.deepEqual(useStore.getState().files[0]!.reveal?.range, { anchor: 6, head: 11 })
  // openDiff with mixed separators; accept updates the open tab
  send({ type: 'openDiff', id: 'wd1', oldPath: 'C:/Users/me/proj/src\\a.ts', newPath: 'C:\\Users\\me\\proj\\Src\\a.ts', newContents: 'new', tabName: 'WD1' })
  await tick()
  assert.equal(useStore.getState().diffs[0]?.oldText, 'hello\nworld')
  assert.equal(ide.acceptDiff('wd1', 'accepted'), undefined)
  assert.equal(useStore.getState().files[0]!.text, 'accepted')
  send({ type: 'saveDocument', id: 'ws1', path: 'C:\\USERS\\me\\proj\\src\\a.ts' })
  await tick()
  assert.deepEqual(replies('ws1'), [{ ok: true }])
  send({ type: 'openFile', id: 'wo2', path: 'D:\\Users\\me\\proj\\src\\a.ts', preview: false, selectToEndOfLine: false, makeFrontmost: false })
  await tick()
  assert.deepEqual(replies('wo2'), [{ ok: false, error: 'outside workspace' }])
  await useStore.getState().showLines({ path: 'C:\\Users\\me\\proj\\SRC\\a.ts', fromLine: 1, kind: 'read', focus: false })
  assert.equal(useStore.getState().files.length, 1)
})

test('openFile text search counts a CRLF line break as one character, as the editor does', async () => {
  reset()
  ideRunning()
  disk.set('crlf.ts', 'first\r\nsecond\r\nthird')
  send({ type: 'openFile', id: 'cr1', path: '/w/crlf.ts', preview: false, startText: 'third', selectToEndOfLine: false, makeFrontmost: false })
  await tick()
  assert.deepEqual(useStore.getState().files[0]!.reveal?.range, { anchor: 13, head: 18 })
})

// ---- the main process's watcher on a real folder (no Electron): what it sends, and the renderer taking it

const waitFor = async (what: string, ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(20)
  }
}

test('FileWatcher: in-place writes, atomic renames, deletion and return, debounce, the set replaced, outside paths ignored', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-out-')))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'one')
  await writeFile(join(root, 'b.ts'), 'b')
  await writeFile(join(outside, 'secret.ts'), 's')
  await symlink(join(outside, 'secret.ts'), join(root, 'link.ts'))
  const events: FileChange[] = []
  const logs: string[] = []
  const w = new FileWatcher({ root, send: e => void events.push(e), log: m => void logs.push(m) })
  t.after(() => w.close())
  w.set(['src/a.ts', 'b.ts', '../escape.ts', '/etc/hosts', '', 'link.ts', 7, 'src/../src/a.ts'])
  assert.deepEqual(w.paths.sort(), ['b.ts', 'link.ts', 'src/../src/a.ts', 'src/a.ts'], 'relative paths inside the root only')
  await tick(150) // armed

  await writeFile(join(root, 'src', 'a.ts'), 'two!')
  await writeFile(join(root, 'src', 'a.ts'), 'three!!')
  await waitFor('a change', () => events.some(e => e.path === 'src/a.ts'))
  await tick(250)
  assert.deepEqual(events.filter(e => e.path === 'src/a.ts'), [{ path: 'src/a.ts', kind: 'change' }], 'two quick writes, one notice')

  // an atomic save: a new file renamed over the old one; the watch follows the new inode
  events.length = 0
  await writeFile(join(root, 'src', '.a.ts.tmp'), 'atomic')
  await rename(join(root, 'src', '.a.ts.tmp'), join(root, 'src', 'a.ts'))
  await waitFor('the atomic save', () => events.some(e => e.path === 'src/a.ts' && e.kind === 'change'))
  await tick(150)
  events.length = 0
  await writeFile(join(root, 'src', 'a.ts'), 'after the rename, still watched')
  await waitFor('a change after the re-arm', () => events.some(e => e.path === 'src/a.ts' && e.kind === 'change'))

  // deleted, then back
  events.length = 0
  await unlink(join(root, 'b.ts'))
  await waitFor('the deletion', () => events.some(e => e.path === 'b.ts' && e.kind === 'unlink'))
  await writeFile(join(root, 'b.ts'), 'b again')
  await waitFor('the return', () => events.some(e => e.path === 'b.ts' && e.kind === 'change'))

  // the symlink out of the workspace is not watched
  events.length = 0
  await writeFile(join(outside, 'secret.ts'), 'changed outside')
  await tick(300)
  assert.deepEqual(events.filter(e => e.path === 'link.ts'), [])
  assert.ok(logs.some(l => l.includes('link.ts')), 'and says so')

  // a new set: b.ts dropped, c.ts (missing at first) told as deleted, then seen when created
  events.length = 0
  w.set(['src/a.ts', 'c.ts'])
  assert.deepEqual(w.paths.sort(), ['c.ts', 'src/a.ts'])
  await waitFor('c.ts reported missing', () => events.some(e => e.path === 'c.ts' && e.kind === 'unlink'))
  await writeFile(join(root, 'b.ts'), 'not watched any more')
  await writeFile(join(root, 'c.ts'), 'created')
  await waitFor('c.ts created', () => events.some(e => e.path === 'c.ts' && e.kind === 'change'))
  await tick(200)
  assert.deepEqual(events.filter(e => e.path === 'b.ts'), [])

  w.close()
  events.length = 0
  await writeFile(join(root, 'src', 'a.ts'), 'after close')
  await tick(300)
  assert.deepEqual(events, [], 'closed: silent')
  w.set(['src/a.ts'])
  assert.deepEqual(w.paths, [], 'and stays closed')
})

test('FileWatcher: a symlink out of the workspace is refused once; a file whose folder is missing is looked at until it is there', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-out-')))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await writeFile(join(outside, 'secret.ts'), 's')
  await symlink(join(outside, 'secret.ts'), join(root, 'link.ts'))
  await writeFile(join(root, 'a.ts'), 'a')
  const events: FileChange[] = []
  const logs: string[] = []
  const w = new FileWatcher({ root, send: e => void events.push(e), log: m => void logs.push(m) })
  t.after(() => w.close())
  w.set(['link.ts', 'later/x.ts'])
  await waitFor('the missing folder', () => events.some(e => e.path === 'later/x.ts' && e.kind === 'unlink'))
  await tick(150)
  w.set(['link.ts', 'later/x.ts', 'a.ts'])
  w.set(['link.ts', 'later/x.ts', 'a.ts'])
  await tick(300)
  assert.equal(logs.filter(l => l.includes('link.ts')).length, 1, 'refused once, not on every set')
  assert.ok(logs.some(l => l.includes('later/x.ts') && l.includes('missing')))
  await mkdir(join(root, 'later'))
  await writeFile(join(root, 'later', 'x.ts'), 'here now')
  await waitFor('the file in the new folder', () => events.some(e => e.path === 'later/x.ts' && e.kind === 'change'))
  assert.equal(logs.filter(l => l.includes('later/x.ts')).length, 1, 'the missing folder is logged once, not on every look')
  events.length = 0
  await writeFile(join(root, 'later', 'x.ts'), 'and watched from now on')
  await waitFor('a change in the new folder', () => events.some(e => e.path === 'later/x.ts' && e.kind === 'change'))
})

test('FileWatcher feeding the renderer: an outside write reloads the clean tab; a write by the accept flow does not flicker', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'a.ts'), 'from disk')
  ideRunning()
  sent.length = 0
  disk.clear()
  useStore.getState().setWorkspace({ root, name: 'w' })
  const stopDisk = diskWatch.startDiskWatch()
  const w = new FileWatcher({ root, send: e => changedListener?.(e) })
  t.after(() => {
    w.close()
    stopDisk()
  })
  // the fake read goes to the real folder for this test
  disk.set('a.ts', 'from disk')
  await useStore.getState().open('a.ts')
  w.set(watched.at(-1)!)
  await tick(150)
  disk.set('a.ts', 'edited outside')
  await writeFile(join(root, 'a.ts'), 'edited outside')
  await waitFor('the reload', () => fileOf('a.ts').text === 'edited outside')
  assert.equal(fileOf('a.ts').rev, 1)
  // the accept flow: the tab takes the text first, the CLI writes the same text after
  send({ type: 'openDiff', id: 'fw1', oldPath: join(root, 'a.ts'), newPath: join(root, 'a.ts'), newContents: 'accepted', tabName: 'FW1' })
  await tick()
  assert.equal(ide.acceptDiff('fw1', 'accepted'), undefined)
  assert.equal(fileOf('a.ts').rev, 2)
  const files = useStore.getState().files
  disk.set('a.ts', 'accepted')
  await writeFile(join(root, 'a.ts'), 'accepted')
  await tick(400)
  assert.equal(useStore.getState().files, files, 'the watcher fired, nothing changed')
})

// ---- verifier: defects the tests above do not reach

test('follow mode showing a file is not the user opening it: the CLI is not told it is the active editor or selection', async () => {
  reset()
  ideRunning()
  const { startFollow } = await import('../src/renderer/src/editor/follow.ts')
  const stopFollow = startFollow()
  try {
    useStore.getState().setFollow(true) // the user's opens in earlier tests paused it
    disk.set('src/b.ts', 'one\ntwo\nthree\n')
    const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
    const read = { id: 'vr1', tool: 'Read', station: 'read', headline: 'Read', why: '', concepts: [], scene: { kind: 'idle' }, status: 'running', startedAt: Date.now() + 1 }
    const live = {
      sid: 'v-sid',
      ptyId: 'v-pty',
      model: { steps: [read], activities: [], files: [], agents: [], stats: { steps: 1, edits: 0, commands: 0, errors: 0, turns: 1, startedAt: 0 }, rev: 1 },
      inputs: { vr1: { path: '/w/src/b.ts', offset: 2, limit: 1 } },
      usage: { total: counts, turn: counts, byModel: {} },
      at: Date.now(),
    }
    useStore.getState().setLive(live as unknown as Parameters<ReturnType<typeof useStore.getState>['setLive']>[0])
    await tick(30)
    const f = fileOf('src/b.ts')
    assert.ok(f && f.auto !== undefined, 'follow opened it as its own tab; the user never touched it')
    // what Editor.tsx does whenever the file on show changes (seen in the built app: the state below is what main relays)
    ide.selectionChanged('src/b.ts', EditorState.create({ doc: f.text }))
    await tick(150)
    const last = states().at(-1) as { active?: string; selection?: { filePath: string } }
    assert.notEqual(last.selection?.filePath, '/w/src/b.ts', "main relays this as selection_changed: Claude Code's prompt then says the user opened src/b.ts")
    assert.notEqual(last.active, '/w/src/b.ts', 'and openEditors marks it the active editor')
  } finally {
    stopFollow()
  }
})

test('saving while the changed-on-disk bar is up does not write over the version on disk (Reload or Keep mine first)', async () => {
  reset()
  const stopDisk = diskWatch.startDiskWatch()
  try {
    disk.set('a.ts', 'base\n')
    await useStore.getState().open('a.ts')
    useStore.getState().update('a.ts', 'base\nmine\n')
    disk.set('a.ts', 'base\nClaude edit\n') // an auto-accepted Edit, written by the CLI
    await change('a.ts')
    assert.equal(fileOf('a.ts').diskChanged, true, 'the bar shows')
    await useStore.getState().save('a.ts').catch(() => {}) // Mod-s, or the CLI's saveDocument
    assert.equal(disk.get('a.ts'), 'base\nClaude edit\n', 'the edit on disk is gone: one keystroke, no choice offered')
    assert.equal(fileOf('a.ts').diskChanged, true, 'the conflict is still unresolved')
  } finally {
    stopDisk()
  }
})

test('FileWatcher: a file whose folder goes away and comes back (a branch switch) is reported when it returns', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'feature'))
  await writeFile(join(root, 'feature', 'x.ts'), 'v1')
  const events: FileChange[] = []
  const w = new FileWatcher({ root, send: e => void events.push(e) })
  t.after(() => w.close())
  w.set(['feature/x.ts'])
  await tick(150)
  await rm(join(root, 'feature'), { recursive: true, force: true })
  await waitFor('the deletion', () => events.some(e => e.path === 'feature/x.ts' && e.kind === 'unlink'))
  await mkdir(join(root, 'feature'))
  await writeFile(join(root, 'feature', 'x.ts'), 'v2')
  // the renderer's tab set does not change, so nothing calls set() again: the tab stays 'Deleted on disk' with stale text
  await waitFor('the file back, without a new watch set', () => events.some(e => e.path === 'feature/x.ts' && e.kind === 'change'), 2000)
})

// ---- after the fixes: the rules around them

type Reported = { open: { path: string }[]; active?: string; selection?: { filePath: string } }

test("editorState: follow's tabs and switches are not reported; the user touching the file, or Claude's openFile, makes it the active editor again", async () => {
  reset()
  ideRunning()
  disk.set('mine.ts', 'mine\n')
  disk.set('auto.ts', 'auto\n')
  const reported = async (path: string, doc: string): Promise<Reported> => {
    ide.selectionChanged(path, EditorState.create({ doc, selection: EditorSelection.single(1, 3) }))
    await tick(150)
    return states().at(-1) as Reported
  }
  await useStore.getState().open('mine.ts')
  let last = await reported('mine.ts', 'mine\n')
  assert.equal(last.active, '/w/mine.ts')
  assert.equal(last.selection?.filePath, '/w/mine.ts')

  await useStore.getState().showLines({ path: 'auto.ts', fromLine: 1, kind: 'read', focus: false }, { by: 'follow' })
  last = await reported('auto.ts', 'auto\n')
  assert.deepEqual(last.open.map(o => o.path), ['/w/mine.ts'], "follow's own tab is not one the user has open")
  assert.equal(last.active, undefined)
  assert.equal(last.selection, undefined, 'no selection in the report: main sends no selection_changed and the CLI keeps the last real one')

  await useStore.getState().showLines({ path: 'mine.ts', fromLine: 1, kind: 'read', focus: false }, { by: 'follow' })
  last = await reported('mine.ts', 'mine\n')
  assert.equal(last.active, undefined, "the user's own tab, brought forward by follow, is still follow's doing")

  useStore.getState().touch('mine.ts') // a click in it
  last = await reported('mine.ts', 'mine\n')
  assert.equal(last.active, '/w/mine.ts')
  assert.equal(last.selection?.filePath, '/w/mine.ts')

  await useStore.getState().showLines({ path: 'mine.ts', fromLine: 1, kind: 'read', focus: false }, { by: 'follow' })
  last = await reported('mine.ts', 'mine\n')
  assert.equal(last.active, '/w/mine.ts', 'follow showing the file already on show changes nothing')

  send({ type: 'openFile', id: 'fo1', path: '/w/auto.ts', preview: false, selectToEndOfLine: false, makeFrontmost: false })
  await tick()
  assert.equal(fileOf('auto.ts').auto, undefined, "Claude's openFile shows the file to the user: the tab is theirs now")
  last = await reported('auto.ts', 'auto\n')
  assert.equal(last.active, '/w/auto.ts')
  assert.deepEqual(last.open.map(o => o.path), ['/w/mine.ts', '/w/auto.ts'])
})

test("saveDocument while the changed-on-disk bar is up fails with the reason; after Keep mine it writes, as chosen", async () => {
  reset()
  ideRunning()
  const stopDisk = diskWatch.startDiskWatch()
  try {
    disk.set('a.ts', 'base\n')
    await useStore.getState().open('a.ts')
    useStore.getState().update('a.ts', 'base\nmine\n')
    disk.set('a.ts', 'base\ntheirs\n')
    await change('a.ts')
    assert.equal(fileOf('a.ts').diskChanged, true)
    send({ type: 'saveDocument', id: 'sc1', path: '/w/a.ts' })
    await tick()
    assert.equal(replies('sc1').length, 1)
    assert.match(JSON.stringify(replies('sc1')[0]), /"ok":false.*Reload or Keep mine/)
    await assert.rejects(useStore.getState().save('a.ts'), DiskChangedError)
    assert.equal(disk.get('a.ts'), 'base\ntheirs\n')
    useStore.getState().keepMine('a.ts')
    send({ type: 'saveDocument', id: 'sc2', path: '/w/a.ts' })
    await tick()
    assert.deepEqual(replies('sc2'), [{ ok: true }])
    assert.equal(disk.get('a.ts'), 'base\nmine\n')
    assert.equal(fileOf('a.ts').dirty, false)
  } finally {
    stopDisk()
  }
})

test('disk: a change between the tab\'s own read and the watch starting is caught by one more read of each new tab', async () => {
  reset()
  const stopDisk = diskWatch.startDiskWatch()
  try {
    readCount.clear()
    disk.set('a.ts', 'as opened')
    disk.set('b.ts', 'b')
    onWatch = () => disk.set('a.ts', 'changed before the watch started')
    await useStore.getState().open('a.ts')
    onWatch = undefined
    await tick()
    assert.equal(fileOf('a.ts').text, 'changed before the watch started')
    assert.equal(fileOf('a.ts').dirty, false)
    assert.equal(readCount.get('a.ts'), 2, 'the open, then once more')
    await useStore.getState().open('b.ts')
    await tick()
    assert.equal(readCount.get('a.ts'), 2, 'a tab already watched is not read again when another one opens')
    assert.equal(readCount.get('b.ts'), 2)
  } finally {
    onWatch = undefined
    stopDisk()
  }
})

test('FileWatcher: a file written more often than the debounce is still reported while the writes go on', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'run.log'), '')
  const events: FileChange[] = []
  const w = new FileWatcher({ root, send: e => void events.push(e), maxWaitMs: 300 })
  t.after(() => w.close())
  w.set(['run.log'])
  await tick(150)
  const end = Date.now() + 1200
  for (let i = 0; Date.now() < end; i++) {
    await appendFile(join(root, 'run.log'), `line ${i}\n`)
    await tick(25)
  }
  const during = events.length
  assert.ok(during >= 2, `${during} notices during 1.2 s of writes 25 ms apart (the debounce alone gives none until they stop)`)
  assert.ok(events.every(e => e.path === 'run.log' && e.kind === 'change'))
})

test('FileWatcher: a tab spelled in another case than its missing file sees it come back through the folder (case-insensitive file systems)', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'probe'), '')
  if (!(await stat(join(root, 'PROBE')).then(() => true, () => false))) return t.skip('this file system tells case apart')
  const events: FileChange[] = []
  // no look on a timer for a minute: only the folder watch can see the file arrive
  const w = new FileWatcher({ root, send: e => void events.push(e), retryMs: 60_000 })
  t.after(() => w.close())
  w.set(['Notes.MD'])
  await waitFor('missing at first', () => events.some(e => e.path === 'Notes.MD' && e.kind === 'unlink'))
  await tick(150)
  await writeFile(join(root, 'notes.md'), 'hello')
  await waitFor('its arrival under its real name', () => events.some(e => e.path === 'Notes.MD' && e.kind === 'change'), 2000)
})

test('FileWatcher: the file goes, then its folder (a slow checkout), then both come back: reported', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docent-watch-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'pkg'))
  await writeFile(join(root, 'pkg', 'x.ts'), 'v1')
  const events: FileChange[] = []
  const w = new FileWatcher({ root, send: e => void events.push(e), retryMs: 200 })
  t.after(() => w.close())
  w.set(['pkg/x.ts'])
  await tick(150)
  await unlink(join(root, 'pkg', 'x.ts'))
  await waitFor('the deletion', () => events.some(e => e.kind === 'unlink'))
  await tick(250) // watched through its folder now
  await rm(join(root, 'pkg'), { recursive: true, force: true })
  await tick(450)
  await mkdir(join(root, 'pkg'))
  await writeFile(join(root, 'pkg', 'x.ts'), 'v2')
  await waitFor('the file back', () => events.some(e => e.kind === 'change'), 2000)
  assert.equal(events.filter(e => e.kind === 'unlink').length, 1, 'gone once, however many looks')
})

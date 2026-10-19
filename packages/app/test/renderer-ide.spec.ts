// Drives packages/app/src/renderer/src/editor/ide.ts under Node 22 with a fake window.docent and the real zustand store.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

type Msg = { kind: 'reply'; id: string; result: unknown } | { kind: 'state'; s: unknown } | { kind: 'mention'; m: unknown }
const sent: Msg[] = []
const disk = new Map<string, string>()
let listener: ((e: unknown) => void) | undefined
const api = {
  workspace: {
    read: async (p: string) => {
      if (!disk.has(p)) throw new Error(`ENOENT: ${p}`)
      return disk.get(p)!
    },
    write: async (p: string, t: string) => {
      if (p.startsWith('nowrite')) throw new Error(`EACCES: ${p}`)
      disk.set(p, t)
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
const { useStore } = await import('../src/renderer/src/store.ts')

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

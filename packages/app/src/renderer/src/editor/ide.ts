// The editor's side of the IDE protocol. Main relays the CLI's tool calls here as IdeRequests
// (openDiff, closeTab, closeAllDiffTabs, openFile, saveDocument); each gets exactly one reply.
// The module also reports the editor state (open files, active file, selection) after every change,
// and sends @-mentions. Started once, from the Editor.
import type { EditorState } from '@codemirror/state'

import type { EditorState as IdeEditorState, IdeReply, IdeRequest } from '../../../shared/ipc'
import { useStore } from '../store'
import { absolute, relativeTo } from './paths'
import { atMentionOf, findRange, selectionInfo } from './selection'

export type IdeOptions = { log?: (msg: string) => void }

type Req<T extends IdeRequest['type']> = Extract<IdeRequest, { type: T }>

/** request ids not yet answered: a reply goes out once, later ones for the same id are dropped */
const pending = new Set<string>()
/** the file the editor shows and its state, for the selection report */
let shown: { path: string; state: EditorState } | undefined
let lastReport: string | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let stop: (() => void) | undefined
let log: (msg: string) => void = () => {}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const reply = (id: string, result: IdeReply): void => {
  if (!pending.delete(id)) return
  window.docent.ide.reply(id, result)
}

const root = (): string | undefined => useStore.getState().workspace?.root

// ---- editor state

const editorState = (): IdeEditorState => {
  const { workspace, files, active, activeDiff } = useStore.getState()
  if (!workspace) return { open: [] }
  const open = files.map(f => ({ path: absolute(workspace.root, f.path), dirty: f.dirty }))
  // a diff on top is not a text editor: then nothing is active and there is no selection
  const activePath = active !== undefined && activeDiff === undefined ? absolute(workspace.root, active) : undefined
  const selection = activePath !== undefined && shown !== undefined && shown.path === active ? selectionInfo(shown.state, activePath) : undefined
  return { open, active: activePath, selection }
}

const report = (): void => {
  const state = editorState()
  const key = JSON.stringify(state)
  if (key === lastReport) return
  lastReport = key
  window.docent.ide.editorState(state)
}

const schedule = (): void => {
  clearTimeout(timer)
  timer = setTimeout(report, 100)
}

/** The editor calls this when the shown file or its selection changes; undefined when no file is showing. */
export function selectionChanged(path: string | undefined, state: EditorState | undefined): void {
  shown = path !== undefined && state ? { path, state } : undefined
  schedule()
}

/** Alt-k in the editor: tell the CLI about the file and the selected lines. */
export function atMention(path: string, state: EditorState): void {
  const r = root()
  if (r === undefined) return
  window.docent.ide.atMentioned(atMentionOf(state, absolute(r, path)))
}

// ---- diffs

/**
 * Accept: answer `saved` with the right side and close the diff. The file is not written here: the CLI
 * (2.1.303, as with the VS Code extension's FILE_SAVED) turns the accepted text into its Edit/Write tool's
 * input and writes it itself, and a write from here first would fail that tool with "File has been
 * modified since read". An open tab of the file takes the accepted text straight away: the CLI writes
 * the same text a moment later and nothing watches the disk yet. Returns an error message instead when
 * the diff is gone or its file lies outside the workspace; the tab then stays.
 */
export function acceptDiff(id: string, contents: string): string | undefined {
  const s = useStore.getState()
  const d = s.diffs.find(x => x.id === id)
  const r = root()
  if (!d || r === undefined) return 'diff is gone'
  const rel = relativeTo(r, d.newPath)
  if (rel === undefined) return 'outside workspace'
  if (s.files.some(f => f.path === rel)) s.reload(rel, contents)
  reply(id, { outcome: 'saved', contents })
  s.closeDiff(id)
  return undefined
}

/**
 * Reject closes the diff with `rejected`. The tab's × and the CLI's closeTab and closeAllDiffTabs reject
 * too, as the VS Code extension answers a diff tab that went away (DIFF_REJECTED): the CLI's TAB_CLOSED
 * branch would apply the proposed text as if the user had accepted it.
 */
export function rejectDiff(id: string): void {
  reply(id, { outcome: 'rejected' })
  useStore.getState().closeDiff(id)
}

// A diff that leaves the store without a verdict is answered `closed`: a new workspace drops them all, and a
// same-named openDiff replaces one. Accept and reject answer before removing.
const diffsGone = (now: { diffs: { id: string }[] }, before: { diffs: { id: string }[] }): void => {
  if (now.diffs === before.diffs) return
  const left = new Set(now.diffs.map(d => d.id))
  for (const d of before.diffs) if (!left.has(d.id)) reply(d.id, { outcome: 'closed' })
}

// ---- requests

const openDiff = async (req: Req<'openDiff'>): Promise<void> => {
  const r = root()
  const oldRel = r === undefined ? undefined : relativeTo(r, req.oldPath)
  const newRel = r === undefined ? undefined : relativeTo(r, req.newPath)
  if (oldRel === undefined || newRel === undefined) return reply(req.id, { outcome: 'rejected' })
  // the left side is the file as it is on disk; a file that does not exist yet reads as empty
  const oldText = await window.docent.workspace.read(oldRel).catch(() => '')
  const s = useStore.getState()
  const previous = s.diffs.find(d => d.tabName === req.tabName)
  if (previous) reply(previous.id, { outcome: 'closed' })
  s.openDiff({ id: req.id, tabName: req.tabName, oldPath: req.oldPath, newPath: req.newPath, oldText, newContents: req.newContents })
}

// the CLI closes a diff's tab after every verdict and when the request is aborted (the terminal answered,
// Escape): a diff still waiting then counts as rejected
const closeTab = (req: Req<'closeTab'>): void => {
  const d = useStore.getState().diffs.find(x => x.tabName === req.tabName)
  if (d) rejectDiff(d.id)
  reply(req.id, d ? { ok: true } : { ok: false, error: 'no such tab' })
}

const closeAllDiffTabs = (req: Req<'closeAllDiffTabs'>): void => {
  const ids = useStore.getState().diffs.map(d => d.id)
  for (const id of ids) rejectDiff(id)
  reply(req.id, { ok: true, count: ids.length })
}

const openFile = async (req: Req<'openFile'>): Promise<void> => {
  const r = root()
  const rel = r === undefined ? undefined : relativeTo(r, req.path)
  if (rel === undefined) return reply(req.id, { ok: false, error: 'outside workspace' })
  try {
    await useStore.getState().open(rel)
  } catch (e) {
    return reply(req.id, { ok: false, error: message(e) })
  }
  const file = useStore.getState().files.find(f => f.path === rel)
  if (!file) return reply(req.id, { ok: false, error: 'not open' })
  const range = req.startText ? findRange(file.text, req.startText, req.endText, req.selectToEndOfLine) : undefined
  // the tab is shown either way (VS Code shows the document too); makeFrontmost decides who keeps the focus
  useStore.getState().reveal(rel, { range, focus: req.makeFrontmost })
  reply(req.id, { ok: true })
}

const saveDocument = async (req: Req<'saveDocument'>): Promise<void> => {
  const r = root()
  const rel = r === undefined ? undefined : relativeTo(r, req.path)
  if (rel === undefined) return reply(req.id, { ok: false, error: 'outside workspace' })
  const s = useStore.getState()
  if (!s.files.some(f => f.path === rel)) return reply(req.id, { ok: false, error: 'not open' })
  try {
    await s.save(rel)
    reply(req.id, { ok: true })
  } catch (e) {
    reply(req.id, { ok: false, error: message(e) })
  }
}

const handle = async (req: IdeRequest): Promise<void> => {
  pending.add(req.id)
  try {
    switch (req.type) {
      case 'openDiff':
        return await openDiff(req)
      case 'closeTab':
        return closeTab(req)
      case 'closeAllDiffTabs':
        return closeAllDiffTabs(req)
      case 'openFile':
        return await openFile(req)
      case 'saveDocument':
        return await saveDocument(req)
    }
  } catch (e) {
    log(`${req.type} ${req.id}: ${message(e)}`)
    reply(req.id, req.type === 'openDiff' ? { outcome: 'rejected' } : { ok: false, error: message(e) })
  }
}

/** Subscribes to the CLI's requests and the store, once; returns the stop function (a second call returns the same one). */
export function startIde(opts: IdeOptions = {}): () => void {
  if (stop) return stop
  log = opts.log ?? (() => {})
  const offEvents = window.docent.ide.onEvent(e => {
    if (e.type === 'request') void handle(e.request)
  })
  const offStore = useStore.subscribe((now, before) => {
    diffsGone(now, before)
    schedule()
  })
  schedule()
  stop = () => {
    offEvents()
    offStore()
    clearTimeout(timer)
    stop = undefined
  }
  return stop
}

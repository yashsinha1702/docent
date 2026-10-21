// Follow mode: while Claude works, the editor shows the file it reads (the lines washed) and the file it
// edits (the new text marked once the edit is on disk). The decision is a pure function of the previous
// and the next live model (followActions); startFollow runs the actions in order through showLines,
// never taking the focus from the terminal and never pulling a diff under review off the top. Manual
// navigation pauses it (the store's touch / pauseFollow); steps from before it was switched on, or from
// a pause, are not replayed.
import type { LiveSession, StepInput } from '../../../shared/ipc'
import type { LineTarget, OpenFile } from '../store'
import { findFile, useStore } from '../store'
import type { Span } from './lines'
import { changedSpan, lf, lineAt } from './lines'
import { relativeTo, samePath } from './paths'

/** A read with no offset/limit washes this many lines from its start; a Write marks this many from the top. */
export const WHOLE_FILE_LINES = 40
/** Follow does not open a file larger than this (bytes): all of it would go into the store and the editor. */
export const FOLLOW_MAX_BYTES = 10 * 1024 * 1024
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
// Claude's Read also takes images, PDFs and the like; the editor would show them as noise
const BINARY = new Set(
  (
    'png jpg jpeg gif bmp ico icns webp avif heic tif tiff psd pdf zip gz tgz bz2 xz zst 7z rar tar jar war class dll so dylib exe bin o a lib ' +
    'obj pyc whl woff woff2 ttf otf eot mp3 mp4 m4a wav ogg flac mov avi mkv webm sqlite sqlite3 db parquet npy npz pt pth onnx h5 pkl'
  ).split(' '),
)

/** Not something to show as text: a known binary or media extension. */
export const isBinaryPath = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && BINARY.has(name.slice(dot + 1).toLowerCase())
}

/** One thing for the editor to show: a read now, an edit once its step is ok (the file changed on disk). */
export type FollowAction = { stepId: string; kind: 'read' | 'edit'; target: LineTarget }
/** `root`: the workspace; `since`: steps that started before this (ms since epoch) are not followed. */
export type FollowContext = { root: string; since: number }

/** The lines a Read covered: offset (1-based) and limit when partial; else WHOLE_FILE_LINES from its first line. */
export const readLines = (input: StepInput): { fromLine: number; toLine: number } => {
  const fromLine = Math.max(1, Math.floor(input.offset ?? 1))
  const count = input.limit !== undefined && input.limit >= 1 ? Math.floor(input.limit) : WHOLE_FILE_LINES
  return { fromLine, toLine: fromLine + count - 1 }
}

/**
 * How an edit is marked: a Write marks the top of the file; Edit and MultiEdit find their first new string
 * that is not blank. With nothing to find (a deletion, a notebook cell) the file is shown without a mark.
 * When it is known where the open file changed, changeLines then says which occurrence, or which lines.
 */
export const editTarget = (tool: string, input: StepInput): Pick<LineTarget, 'kind' | 'find' | 'fromLine' | 'toLine'> => {
  if (tool === 'Write' || input.isWrite) return { kind: 'edit', fromLine: 1, toLine: WHOLE_FILE_LINES }
  const find = input.edits?.find(e => e.new.trim() !== '')?.new
  return find === undefined ? { kind: 'jump' } : { kind: 'edit', find }
}

/**
 * The lines an edit points at once it is known where its file changed (`change`, a span of `text`; both as the
 * editor holds them, with \n): the edit's own text where it overlaps the change, else the changed lines. A short
 * new string ('}', 'return x') occurs all over a file; the change says which occurrence is the new one.
 */
export const changeLines = (text: string, change: Span, find?: string): { fromLine: number; toLine: number } => {
  const at = find ? text.indexOf(find, Math.max(0, change.from - find.length)) : -1
  const from = at !== -1 && at <= change.to ? at : change.from
  // a change that ends with a line break ends on the line before it
  const end = change.to > change.from && text[change.to - 1] === '\n' ? change.to - 1 : change.to
  return { fromLine: lineAt(text, from), toLine: lineAt(text, Math.max(from, end)) }
}

/**
 * What follow mode does when the live model goes from `prev` to `next`: each Read, Edit, MultiEdit, Write or
 * NotebookEdit step on a text file inside the workspace, started at or after `since`, once. A read shows as soon as
 * it appears (unless it failed); an edit when its status turns ok. A different session in `prev` counts as
 * none. A step whose input (the path) arrives in a later update than the step itself acts then.
 */
export function followActions(prev: LiveSession | undefined, next: LiveSession | undefined, ctx: FollowContext): FollowAction[] {
  if (!next) return []
  // what prev could already act on: the steps it had with a path
  const before = new Map<string, string>()
  if (prev && prev.sid === next.sid) for (const s of prev.model.steps) if (prev.inputs[s.id]?.path !== undefined) before.set(s.id, s.status)
  const out: FollowAction[] = []
  for (const step of next.model.steps) {
    if (step.startedAt < ctx.since) continue
    const isRead = step.tool === 'Read'
    if (!isRead && !EDIT_TOOLS.has(step.tool)) continue
    const input = next.inputs[step.id]
    // a malformed update must not throw inside the store's subscription (later subscribers would miss it)
    const rel = typeof input?.path === 'string' ? relativeTo(ctx.root, input.path) : undefined
    if (!input || !rel || isBinaryPath(rel)) continue // no path yet, outside the workspace, the root itself, or not text
    const was = before.get(step.id)
    if (isRead) {
      if (was === undefined && (step.status === 'running' || step.status === 'ok')) {
        out.push({ stepId: step.id, kind: 'read', target: { path: rel, ...readLines(input), kind: 'read', focus: false } })
      }
    } else if (step.status === 'ok' && was !== 'ok') {
      out.push({ stepId: step.id, kind: 'edit', target: { path: rel, ...editTarget(step.tool, input), focus: false } })
    }
  }
  return out
}

/** The fields isFollowKey reads; a KeyboardEvent has them all. */
export type FollowKey = Pick<KeyboardEvent, 'code' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & { getModifierState?(key: string): boolean }

/**
 * Mod-Alt-F (Cmd-Option-F on a Mac, Ctrl-Alt-F elsewhere) toggles follow mode wherever the focus is. Windows
 * reports AltGr as Ctrl+Alt, and AltGr+F types '[' on Czech, Slovak, Hungarian, Croatian and Slovenian layouts:
 * a key that comes out as punctuation or a symbol, or with AltGr held, is text, not this shortcut. The F key
 * under another script (Ctrl-Alt-F on a Russian layout gives 'а') still is.
 */
export const isFollowKey = (e: FollowKey, mac: boolean): boolean => {
  if (!e.altKey || e.shiftKey) return false
  if (mac) return e.metaKey && !e.ctrlKey && (e.code === 'KeyF' || e.key.toLowerCase() === 'f')
  if (!e.ctrlKey || e.metaKey) return false
  if (e.key.toLowerCase() === 'f') return true
  return e.code === 'KeyF' && e.getModifierState?.('AltGraph') !== true && !/^[\p{P}\p{S}]$/u.test(e.key)
}

// ---- runtime

export type FollowOptions = { log?: (msg: string) => void }

/** Where an open file's text last changed from outside (Claude's edit reloaded, an accepted diff); `text` is the tab text it led to. */
type Change = { text: string; span: Span }

let stop: (() => void) | undefined

const following = (): boolean => {
  const s = useStore.getState()
  return s.followOn && s.workspace !== undefined && Date.now() >= s.followPausedUntil
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The edited file as it is now: a clean tab reloads, a dirty one is left to the changed-on-disk bar. */
const refresh = async (path: string): Promise<void> => {
  const f = findFile(useStore.getState(), path)
  if (!f || f.dirty) return // not open: showLines reads it fresh
  useStore.getState().syncDisk(f.path, await window.docent.workspace.read(f.path))
}

/** A file's size from its folder's listing (the workspace API has no stat); undefined when the listing does not say. */
const sizeOf = async (root: string, path: string): Promise<number | undefined> => {
  const slash = path.lastIndexOf('/')
  try {
    const entries = await window.docent.workspace.list(slash === -1 ? '.' : path.slice(0, slash))
    return entries.find(d => d.kind === 'file' && samePath(root, d.path, path))?.size
  } catch {
    return undefined // no such folder: showLines will say so
  }
}

/** Notes, for each open file whose text was replaced from outside (its rev moved), where the new text differs. */
const noteChanges = (changes: Map<string, Change>, files: readonly OpenFile[], before: readonly OpenFile[]): void => {
  const was = new Map(before.map(f => [f.path, f] as const))
  for (const f of files) {
    const old = was.get(f.path)
    if (!old || old.rev === f.rev) continue
    const span = changedSpan(lf(old.text), lf(f.text))
    if (span) changes.set(f.path, { text: f.text, span })
  }
  for (const path of [...changes.keys()]) if (!files.some(f => f.path === path)) changes.delete(path)
}

/** Follows the store's live model; once (a second call returns the same stop function). */
export function startFollow(opts: FollowOptions = {}): () => void {
  if (stop) return stop
  const log = opts.log ?? (() => {})
  let prev = useStore.getState().live
  let since = Date.now()
  let queue: Promise<void> = Promise.resolve()
  let stopped = false
  const changes = new Map<string, Change>()

  /** still following, in the workspace the action was worked out for (a queued one must not open a namesake in the next) */
  const current = (root: string): boolean => !stopped && following() && useStore.getState().workspace?.root === root

  /** An edit's target, pointed where its open file changed, while the tab still holds that change's text. */
  const pointed = (target: LineTarget): LineTarget => {
    const f = findFile(useStore.getState(), target.path)
    const c = f && !f.dirty ? changes.get(f.path) : undefined
    if (!f || !c || c.text !== f.text) return target
    return { ...target, ...changeLines(lf(f.text), c.span, target.find === undefined ? undefined : lf(target.find)) }
  }

  const perform = async (a: FollowAction, root: string): Promise<void> => {
    if (!current(root)) return
    if (a.kind === 'edit') await refresh(a.target.path)
    if (!current(root)) return
    if (!findFile(useStore.getState(), a.target.path)) {
      const size = await sizeOf(root, a.target.path)
      if (!current(root)) return
      if (size !== undefined && size > FOLLOW_MAX_BYTES) return log(`follow: not opening ${a.target.path}, ${size} bytes`)
    }
    await useStore.getState().showLines(a.kind === 'edit' ? pointed(a.target) : a.target, { by: 'follow' })
  }

  const offStore = useStore.subscribe((s, b) => {
    if (s.files !== b.files) noteChanges(changes, s.files, b.files)
    // switched on: only what happens from now on
    if (s.followOn && !b.followOn) {
      since = Date.now()
      prev = s.live
    }
    if (s.live === b.live) return
    const root = s.workspace?.root
    // paused or off, the model still moves on: what happened meanwhile is not replayed later
    const actions = root !== undefined && following() ? followActions(prev, s.live, { root, since }) : []
    prev = s.live
    if (root === undefined) return
    for (const a of actions) {
      const run = (): Promise<void> => perform(a, root)
      queue = queue.then(run, run)
      queue.catch(e => log(`follow ${a.kind} ${a.target.path}: ${message(e)}`))
    }
  })

  stop = () => {
    stopped = true
    offStore()
    changes.clear()
    stop = undefined
  }
  return stop
}

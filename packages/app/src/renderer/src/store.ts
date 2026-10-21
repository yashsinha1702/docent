import { create } from 'zustand'

import type { LiveSession, WorkspaceInfo } from '../../shared/ipc'
import { targetSpan } from './editor/lines'
import { keptMine, reloaded, withDisk } from './editor/outside'
import { relativeTo, samePath } from './editor/paths'

/**
 * What the editor does when the file is next shown: scroll to `range` and select it (unless `select` is false),
 * leave a fading `mark`, take focus; `n` makes each request apply once. Offsets are CodeMirror's (a line break
 * counts one character). A newer request on any file drops older ones not yet shown.
 */
export type Reveal = {
  range?: { anchor: number; head: number }
  focus: boolean
  n: number
  /** false: scroll `range` into view and leave the selection alone; default true */
  select?: boolean
  /** a read wash over whole lines, or an edit highlight over found text (`lines` false) or lines */
  mark?: { kind: 'read' | 'edit'; from: number; to: number; lines: boolean }
}
/** `path` is workspace-relative; `rev` counts replacements of `text` from outside the editor, which then reloads the document. */
export type OpenFile = {
  path: string
  text: string
  dirty: boolean
  rev: number
  reveal?: Reveal
  /** the text the disk was last known to hold (read, saved, or an accepted diff about to be written): an outside change equal to it is nothing new */
  disk?: string
  /** the file changed on disk while the tab had unsaved edits; `diskText` is what the disk now holds. The editor offers Reload / Keep mine */
  diskChanged?: boolean
  diskText?: string
  /** the file was deleted on disk; the text stays */
  deleted?: boolean
  /** opened by follow mode and not touched by the user since; follow closes the least recently shown beyond MAX_AUTO_TABS */
  auto?: number
}
/** A diff the CLI asked the user to review: paths as the CLI gave them (absolute), `oldText` the file as it is, `text` the right side as edited. */
export type DiffTab = { id: string; tabName: string; oldPath: string; newPath: string; oldText: string; newContents: string; text: string }
/** The claude session running in the terminal: its id (also the Pairwatch snapshot's `sid`) and its pty. */
export type TerminalSession = { sid: string; ptyId: string; ended?: boolean }
/**
 * A request from outside the editor (the Watch panel, follow mode) to show part of a file. `path` is absolute
 * (inside the workspace) or workspace-relative; lines are 1-based and inclusive; `kind` says how the editor
 * marks them: a read wash, an edit highlight, or a plain jump.
 */
export type LineTarget = {
  path: string
  fromLine?: number
  toLine?: number
  /** text to find and mark instead of (or near) the lines, e.g. an edit's new_string */
  find?: string
  kind: 'read' | 'edit' | 'jump'
  focus: boolean
}
/**
 * Who asks for a file. `user` (the default: the tree, a click in the Watch panel) pauses follow mode and
 * makes the tab the user's; `cli` is Claude's openFile, which shows the file to the user (the tab is theirs
 * from then on) without pausing follow; `follow` never takes the focus, never pulls a diff under review off
 * the top, and its tabs are its own until the user touches them. What follow shows is not reported to the
 * CLI as the user's active editor or selection (editor/ide.ts).
 */
export type OpenBy = 'user' | 'cli' | 'follow'
export type OpenOptions = { by?: OpenBy }

/** Manual navigation holds follow mode back this long. */
export const FOLLOW_PAUSE_MS = 20_000
/** Follow mode keeps at most this many tabs of its own open. */
export const MAX_AUTO_TABS = 8
const FOLLOW_KEY = 'docent.follow'

/** save() while the changed-on-disk bar is up: Reload or Keep mine comes first, so the version on disk is never written over unseen. */
export class DiskChangedError extends Error {
  constructor(path: string) {
    super(`${path} changed on disk: choose Reload or Keep mine first`)
    this.name = 'DiskChangedError'
  }
}

const storedFollow = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(FOLLOW_KEY) !== 'off'
  } catch {
    return true
  }
}
const storeFollow = (on: boolean): void => {
  try {
    globalThis.localStorage?.setItem(FOLLOW_KEY, on ? 'on' : 'off')
  } catch {
    // no storage (a sandboxed page): the toggle still works, it is just not remembered
  }
}

/** The open tab for a workspace-relative path: the same string, or under a Windows root the same path in another case. */
export function findFile(s: { files: readonly OpenFile[]; workspace?: WorkspaceInfo }, path: string): OpenFile | undefined {
  const exact = s.files.find(f => f.path === path)
  const root = s.workspace?.root
  return exact ?? (root === undefined ? undefined : s.files.find(f => samePath(root, f.path, path)))
}

/** Follow's own tabs to close so that at most `max` stay: the least recently shown first, never a dirty one or `keep`. */
export function autoTabsToClose(files: readonly OpenFile[], keep: string, max = MAX_AUTO_TABS): string[] {
  const auto = files.filter(f => f.auto !== undefined)
  const excess = auto.length - max
  if (excess <= 0) return []
  return auto
    .filter(f => !f.dirty && f.path !== keep)
    .sort((a, b) => (a.auto ?? 0) - (b.auto ?? 0))
    .slice(0, excess)
    .map(f => f.path)
}

type State = {
  workspace?: WorkspaceInfo
  files: OpenFile[]
  /** the active file tab; a diff shown on top of it leaves it in place */
  active?: string
  /** who put the active file on show; the user's actions in it (touch, typing) make it 'user' */
  activeBy?: OpenBy
  diffs: DiffTab[]
  /** the diff tab on top; when set, it shows instead of the active file */
  activeDiff?: string
  session?: TerminalSession
  /** the terminal session's live model (its transcript folded by Pairwatch's reducer) */
  live?: LiveSession
  /** follow mode: the editor shows what Claude reads and edits (the Follow toggle; remembered on this machine) */
  followOn: boolean
  /** manual navigation holds follow mode back until this time (ms since epoch); 0 when it does not */
  followPausedUntil: number
  setWorkspace(w: WorkspaceInfo): void
  setLive(l: LiveSession | undefined): void
  /** turns follow mode on (which also ends a pause) or off */
  setFollow(on: boolean): void
  /** the user navigated by hand: follow mode waits FOLLOW_PAUSE_MS before it moves the editor again */
  pauseFollow(): void
  /** a click, key or scroll in a file's editor: pauses follow mode, and the tab is the user's from now on */
  touch(path: string): void
  /** opens the file if needed and shows the lines (follow mode and the steps strip use it); see LineTarget, OpenBy */
  showLines(t: LineTarget, opts?: OpenOptions): Promise<void>
  setSession(s: TerminalSession | undefined): void
  open(path: string, opts?: OpenOptions): Promise<void>
  update(path: string, text: string): void
  /** writes the tab to disk; refuses with DiskChangedError while the changed-on-disk bar waits for Reload or Keep mine */
  save(path: string): Promise<void>
  close(path: string): void
  activate(path: string): void
  /** replaces an open file's text from outside the editor (an accepted diff, a reload): the tab is clean; an equal text changes nothing */
  reload(path: string, text: string): void
  /** the disk now holds `text` for an open file (undefined: it is gone); see editor/outside.ts */
  syncDisk(path: string, text: string | undefined): void
  /** the changed-on-disk or deleted bar's Keep: the buffer stays, as unsaved edits */
  keepMine(path: string): void
  /** asks the editor to select `range` and scroll there, and to take focus, when the file is (next) shown */
  reveal(path: string, r: Omit<Reveal, 'n'>): void
  /** adds a diff tab and shows it; a diff with the same tab name is replaced */
  openDiff(d: Omit<DiffTab, 'text'>): void
  updateDiff(id: string, text: string): void
  closeDiff(id: string): void
  activateDiff(id: string): void
}

let reveals = 0
let autos = 0

/** `files` with the tab at `path` passed through `fn`; the same array when nothing changed. */
const mapFile = (files: OpenFile[], path: string, fn: (f: OpenFile) => OpenFile): OpenFile[] => {
  let changed = false
  const next = files.map(f => {
    if (f.path !== path) return f
    const g = fn(f)
    if (g !== f) changed = true
    return g
  })
  return changed ? next : files
}

/** The tab, no longer follow's own. */
const owned = (f: OpenFile): OpenFile => {
  if (f.auto === undefined) return f
  const { auto: _auto, ...rest } = f
  return rest
}

const withoutReveal = (f: OpenFile): OpenFile => {
  const { reveal: _reveal, ...rest } = f
  return rest
}

export const useStore = create<State>((set, get) => {
  /** Opens or brings forward a tab, as `by` does it (see OpenBy). */
  const openAs = async (path: string, by: OpenBy): Promise<void> => {
    if (by === 'user') get().pauseFollow()
    const front = (s: State): Pick<State, 'active' | 'activeDiff' | 'activeBy'> => ({
      active: path,
      activeDiff: by === 'follow' ? s.activeDiff : undefined,
      // follow showing the file already on show does not change who put it there
      activeBy: by === 'follow' && s.active === path ? s.activeBy : by,
    })
    const claim = (f: OpenFile): OpenFile => (f.auto === undefined ? f : by === 'follow' ? { ...f, auto: ++autos } : owned(f))
    if (get().files.some(f => f.path === path)) return set(s => ({ ...front(s), files: mapFile(s.files, path, claim) }))
    const workspace = get().workspace
    const text = await window.docent.workspace.read(path)
    // the workspace was switched while the file was read: the path named a file of the old one
    if (get().workspace !== workspace) return
    // another open of the same path (the tree and the CLI's openFile can race) may have added the tab meanwhile
    set(s => {
      if (s.files.some(f => f.path === path)) return { ...front(s), files: mapFile(s.files, path, claim) }
      const file: OpenFile = { path, text, dirty: false, rev: 0, disk: text, ...(by === 'follow' ? { auto: ++autos } : {}) }
      return { ...front(s), files: [...s.files, file] }
    })
    if (by !== 'follow') return
    const drop = autoTabsToClose(get().files, path)
    if (drop.length > 0) set(s => ({ files: s.files.filter(f => !drop.includes(f.path)) }))
  }

  return {
    files: [],
    diffs: [],
    followOn: storedFollow(),
    followPausedUntil: 0,
    setWorkspace: workspace =>
      set({ workspace, files: [], active: undefined, activeBy: undefined, diffs: [], activeDiff: undefined, session: undefined, live: undefined, followPausedUntil: 0 }),
    setSession: session => set(s => ({ session, live: session && s.live?.ptyId === session.ptyId ? s.live : undefined })),
    setLive: live => set({ live }),
    setFollow: on => {
      storeFollow(on)
      set({ followOn: on, followPausedUntil: 0 })
    },
    pauseFollow: () => {
      if (get().followOn) set({ followPausedUntil: Date.now() + FOLLOW_PAUSE_MS })
    },
    touch: path => {
      const s = get()
      const until = Date.now() + FOLLOW_PAUSE_MS
      // a keystroke at a time would re-render the editor on every key; a second's slack is plenty
      const pause = s.followOn && until - s.followPausedUntil > 1000
      const claim = s.files.some(f => f.path === path && f.auto !== undefined)
      // the user at work in the file on show: from now on it is reported to the CLI as theirs
      const mine = s.active === path && s.activeBy !== 'user'
      if (!pause && !claim && !mine) return
      set(st => ({ ...(pause ? { followPausedUntil: until } : {}), ...(mine ? { activeBy: 'user' } : {}), files: claim ? mapFile(st.files, path, owned) : st.files }))
    },
    showLines: async (t, opts) => {
      const by = opts?.by ?? 'user'
      const root = get().workspace?.root
      if (root === undefined) return
      const rel = relativeTo(root, t.path)
      if (!rel) return // outside the workspace, or the root itself
      const path = findFile(get(), rel)?.path ?? rel
      await openAs(path, by)
      const file = get().files.find(f => f.path === path)
      const pointed = file && targetSpan(file.text, t)
      if (!pointed) return // nothing to point at: the tab just shows
      const { from, to } = pointed.span
      const focus = t.focus && by !== 'follow'
      const mark = t.kind === 'jump' ? undefined : { kind: t.kind, from, to, lines: t.kind === 'read' || !pointed.found }
      get().reveal(path, { range: { anchor: from, head: to }, focus, select: focus, ...(mark ? { mark } : {}) })
    },
    open: (path, opts) => openAs(findFile(get(), path)?.path ?? path, opts?.by ?? 'user'),
    update: (path, text) =>
      set(s => ({ files: mapFile(s.files, path, f => owned({ ...f, text, dirty: true })), ...(s.active === path && s.activeBy !== 'user' ? { activeBy: 'user' } : {}) })),
    save: async path => {
      const f = get().files.find(x => x.path === path)
      if (!f) return
      if (f.diskChanged) throw new DiskChangedError(path)
      const text = f.text
      await window.docent.workspace.write(path, text)
      // typing while the write was in flight keeps the tab dirty
      set(s => ({ files: mapFile(s.files, path, x => withDisk({ ...x, dirty: x.text !== text, disk: text }, text)) }))
    },
    close: path =>
      set(s => {
        const files = s.files.filter(f => f.path !== path)
        // closing the tab on show puts the last one there, as the user's doing (follow's own tabs still are not reported)
        return s.active === path ? { files, active: files.at(-1)?.path, activeBy: 'user' } : { files }
      }),
    activate: path => {
      get().pauseFollow()
      set(s => ({ active: path, activeDiff: undefined, activeBy: 'user', files: mapFile(s.files, path, owned) }))
    },
    reload: (path, text) =>
      set(s => {
        const files = mapFile(s.files, path, f => reloaded(f, text))
        return files === s.files ? s : { files }
      }),
    syncDisk: (path, text) =>
      set(s => {
        const files = mapFile(s.files, path, f => withDisk(f, text))
        return files === s.files ? s : { files }
      }),
    keepMine: path =>
      set(s => {
        const files = mapFile(s.files, path, keptMine)
        return files === s.files ? s : { files }
      }),
    reveal: (path, r) => set(s => ({ files: s.files.map(f => (f.path === path ? { ...f, reveal: { ...r, n: ++reveals } } : f.reveal ? withoutReveal(f) : f)) })),
    openDiff: d => set(s => ({ diffs: [...s.diffs.filter(x => x.tabName !== d.tabName), { ...d, text: d.newContents }], activeDiff: d.id })),
    updateDiff: (id, text) => set(s => ({ diffs: s.diffs.map(d => (d.id === id ? { ...d, text } : d)) })),
    closeDiff: id =>
      set(s => {
        const diffs = s.diffs.filter(d => d.id !== id)
        // the next diff still waiting takes the front; with none left the active file shows again
        const activeDiff = s.activeDiff === id ? diffs.at(-1)?.id : s.activeDiff
        return { diffs, activeDiff }
      }),
    activateDiff: id => {
      get().pauseFollow()
      set({ activeDiff: id })
    },
  }
})

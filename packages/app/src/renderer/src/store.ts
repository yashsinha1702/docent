import { create } from 'zustand'

import type { LiveSession, WorkspaceInfo } from '../../shared/ipc'

/** What the editor does when the file is next shown: select and scroll to `range`, take focus; `n` makes each request apply once. */
export type Reveal = { range?: { anchor: number; head: number }; focus: boolean; n: number }
/** `path` is workspace-relative; `rev` counts replacements of `text` from outside the editor, which then reloads the document. */
export type OpenFile = { path: string; text: string; dirty: boolean; rev: number; reveal?: Reveal }
/** A diff the CLI asked the user to review: paths as the CLI gave them (absolute), `oldText` the file as it is, `text` the right side as edited. */
export type DiffTab = { id: string; tabName: string; oldPath: string; newPath: string; oldText: string; newContents: string; text: string }
/** The claude session running in the terminal: its id (also the Pairwatch snapshot's `sid`) and its pty. */
export type TerminalSession = { sid: string; ptyId: string; ended?: boolean }
/**
 * A request from outside the editor (the Watch panel, follow mode) to show part of a file. `path` is absolute
 * (inside the workspace) or workspace-relative; lines are 1-based and inclusive; `kind` says how the editor
 * marks them: a read wash, an edit highlight, or a plain jump.
 */
export type LineTarget = { path: string; fromLine?: number; toLine?: number; kind: 'read' | 'edit' | 'jump'; focus: boolean }

type State = {
  workspace?: WorkspaceInfo
  files: OpenFile[]
  /** the active file tab; a diff shown on top of it leaves it in place */
  active?: string
  diffs: DiffTab[]
  /** the diff tab on top; when set, it shows instead of the active file */
  activeDiff?: string
  session?: TerminalSession
  /** the terminal session's live model (its transcript folded by Pairwatch's reducer) */
  live?: LiveSession
  setWorkspace(w: WorkspaceInfo): void
  setLive(l: LiveSession | undefined): void
  /** opens the file if needed and shows the lines (follow mode and the steps strip use it) */
  showLines(t: LineTarget): Promise<void>
  setSession(s: TerminalSession | undefined): void
  open(path: string): Promise<void>
  update(path: string, text: string): void
  save(path: string): Promise<void>
  close(path: string): void
  activate(path: string): void
  /** replaces an open file's text from outside the editor (an accepted diff): the tab reloads and is not dirty */
  reload(path: string, text: string): void
  /** asks the editor to select `range` and scroll there, and to take focus, when the file is (next) shown */
  reveal(path: string, r: Omit<Reveal, 'n'>): void
  /** adds a diff tab and shows it; a diff with the same tab name is replaced */
  openDiff(d: Omit<DiffTab, 'text'>): void
  updateDiff(id: string, text: string): void
  closeDiff(id: string): void
  activateDiff(id: string): void
}

let reveals = 0

export const useStore = create<State>((set, get) => ({
  files: [],
  diffs: [],
  setWorkspace: workspace => set({ workspace, files: [], active: undefined, diffs: [], activeDiff: undefined, session: undefined, live: undefined }),
  setSession: session => set(s => ({ session, live: session && s.live?.ptyId === session.ptyId ? s.live : undefined })),
  setLive: live => set({ live }),
  showLines: async t => {
    // minimal: open and select the lines; the editor module adds the read wash and edit highlight
    const root = get().workspace?.root
    const path = root && t.path.startsWith(root + '/') ? t.path.slice(root.length + 1) : t.path
    await get().open(path)
    const file = get().files.find(f => f.path === path)
    if (!file || t.fromLine === undefined) return
    const starts = [0]
    for (let i = 0; i < file.text.length; i++) if (file.text[i] === '\n') starts.push(i + 1)
    const from = starts[Math.min(starts.length, Math.max(1, t.fromLine)) - 1] ?? 0
    const lastLine = Math.min(starts.length, Math.max(t.fromLine, t.toLine ?? t.fromLine))
    const to = lastLine < starts.length ? (starts[lastLine] ?? file.text.length) - 1 : file.text.length
    get().reveal(path, { range: { anchor: from, head: Math.max(from, to) }, focus: t.focus })
  },
  open: async path => {
    if (get().files.some(f => f.path === path)) return set({ active: path, activeDiff: undefined })
    const text = await window.docent.workspace.read(path)
    // another open of the same path (the tree and the CLI's openFile can race) may have added the tab meanwhile
    set(s => (s.files.some(f => f.path === path) ? { active: path, activeDiff: undefined } : { files: [...s.files, { path, text, dirty: false, rev: 0 }], active: path, activeDiff: undefined }))
  },
  update: (path, text) => set(s => ({ files: s.files.map(f => (f.path === path ? { ...f, text, dirty: true } : f)) })),
  save: async path => {
    const f = get().files.find(x => x.path === path)
    if (!f) return
    await window.docent.workspace.write(path, f.text)
    set(s => ({ files: s.files.map(x => (x.path === path ? { ...x, dirty: false } : x)) }))
  },
  close: path =>
    set(s => {
      const files = s.files.filter(f => f.path !== path)
      const active = s.active === path ? files.at(-1)?.path : s.active
      return { files, active }
    }),
  activate: path => set({ active: path, activeDiff: undefined }),
  reload: (path, text) => set(s => ({ files: s.files.map(f => (f.path === path ? { ...f, text, dirty: false, rev: f.rev + 1 } : f)) })),
  reveal: (path, r) => set(s => ({ files: s.files.map(f => (f.path === path ? { ...f, reveal: { ...r, n: ++reveals } } : f)) })),
  openDiff: d => set(s => ({ diffs: [...s.diffs.filter(x => x.tabName !== d.tabName), { ...d, text: d.newContents }], activeDiff: d.id })),
  updateDiff: (id, text) => set(s => ({ diffs: s.diffs.map(d => (d.id === id ? { ...d, text } : d)) })),
  closeDiff: id =>
    set(s => {
      const diffs = s.diffs.filter(d => d.id !== id)
      // the next diff still waiting takes the front; with none left the active file shows again
      const activeDiff = s.activeDiff === id ? diffs.at(-1)?.id : s.activeDiff
      return { diffs, activeDiff }
    }),
  activateDiff: id => set({ activeDiff: id }),
}))

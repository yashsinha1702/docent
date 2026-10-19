import { create } from 'zustand'

import type { WorkspaceInfo } from '../../shared/ipc'

export type OpenFile = { path: string; text: string; dirty: boolean }
/** The claude session running in the terminal: its id (also the Pairwatch snapshot's `sid`) and its pty. */
export type TerminalSession = { sid: string; ptyId: string; ended?: boolean }

type State = {
  workspace?: WorkspaceInfo
  files: OpenFile[]
  active?: string
  session?: TerminalSession
  setWorkspace(w: WorkspaceInfo): void
  setSession(s: TerminalSession | undefined): void
  open(path: string): Promise<void>
  update(path: string, text: string): void
  save(path: string): Promise<void>
  close(path: string): void
  activate(path: string): void
}

export const useStore = create<State>((set, get) => ({
  files: [],
  setWorkspace: workspace => set({ workspace, files: [], active: undefined, session: undefined }),
  setSession: session => set({ session }),
  open: async path => {
    if (get().files.some(f => f.path === path)) return set({ active: path })
    const text = await window.docent.workspace.read(path)
    set(s => ({ files: [...s.files, { path, text, dirty: false }], active: path }))
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
  activate: path => set({ active: path }),
}))

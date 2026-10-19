// The panel's state: every session the main process relays, the viewer's status, the hand-picked session.
import { create } from 'zustand'

import type { WatchHostStatus, WatchSession } from '../../../shared/ipc'

export type WatchState = {
  sessions: ReadonlyMap<string, WatchSession>
  host?: WatchHostStatus
  /** why the viewer's status could not be read (the main process did not answer) */
  hostError?: string
  /** why the initial list could not be read; snapshots still arrive as events, so this is not fatal */
  listError?: string
  /** the initial list arrived, so an empty map means "nothing yet" and not "not asked yet" */
  loaded: boolean
  /** a session picked in the picker; undefined follows the terminal's session, else the newest */
  picked?: string
  upsert(s: WatchSession): void
  remove(sid: string): void
  load(list: WatchSession[]): void
  setHost(status: WatchHostStatus): void
  setHostError(message: string): void
  setListError(message: string): void
  pick(sid: string | undefined): void
}

/** The newer of two copies of a session: events may land before the initial list does. */
const newer = (have: WatchSession | undefined, got: WatchSession): WatchSession => (have !== undefined && have.updatedAt > got.updatedAt ? have : got)

export const useWatchStore = create<WatchState>(set => ({
  sessions: new Map(),
  loaded: false,
  upsert: s =>
    set(st => {
      const sessions = new Map(st.sessions)
      sessions.set(s.sid, newer(sessions.get(s.sid), s))
      return { sessions }
    }),
  remove: sid =>
    set(st => {
      if (!st.sessions.has(sid)) return st
      const sessions = new Map(st.sessions)
      sessions.delete(sid)
      return { sessions, picked: st.picked === sid ? undefined : st.picked }
    }),
  load: list =>
    set(st => {
      const sessions = new Map(st.sessions)
      for (const s of list) sessions.set(s.sid, newer(sessions.get(s.sid), s))
      return { sessions, loaded: true, listError: undefined }
    }),
  setHost: host => set({ host, hostError: undefined }),
  setHostError: hostError => set({ hostError }),
  setListError: listError => set({ listError }),
  pick: picked => set({ picked }),
}))

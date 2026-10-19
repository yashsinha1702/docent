// Which session the panel shows. Pure, so the rule is testable without React.
import type { WatchSession } from '../../../shared/ipc'

/** The terminal's claude session, as ../store keeps it. */
export type TerminalRef = { sid: string; ended?: boolean }

export type Choice = {
  /** the session on show, or the terminal's session while its first snapshot is awaited */
  sid?: string
  session?: WatchSession
  /** the terminal's claude runs but has written no snapshot yet */
  awaiting: boolean
}

const timeOf = (s: WatchSession): number => (typeof s.snapshot.at === 'number' ? s.snapshot.at : s.updatedAt)

/** Newest first: live sessions before ended ones, then by the snapshot's write time. */
export function newestFirst(a: WatchSession, b: WatchSession): number {
  const endedA = a.snapshot.ended === true ? 1 : 0
  const endedB = b.snapshot.ended === true ? 1 : 0
  return endedA - endedB || timeOf(b) - timeOf(a)
}

/**
 * A session picked by hand wins while it exists; then the terminal's own session, shown when it has a
 * snapshot and awaited while its claude still runs; otherwise the newest snapshot.
 */
export function chooseSession(sessions: ReadonlyMap<string, WatchSession>, terminal: TerminalRef | undefined, picked: string | undefined): Choice {
  const byHand = picked === undefined ? undefined : sessions.get(picked)
  if (byHand !== undefined) return { sid: byHand.sid, session: byHand, awaiting: false }
  if (terminal !== undefined) {
    const own = sessions.get(terminal.sid)
    if (own !== undefined) return { sid: own.sid, session: own, awaiting: false }
    if (terminal.ended !== true) return { sid: terminal.sid, awaiting: true }
  }
  const newest = [...sessions.values()].sort(newestFirst)[0]
  return newest === undefined ? { awaiting: false } : { sid: newest.sid, session: newest, awaiting: false }
}

/**
 * As many sessions as the real viewer lists (SESSIONS_MAX in server/src/pairwatch/protocol.ts, which the
 * renderer cannot import: it pulls in node builtins). Docent's host relays every file in live/ and never
 * prunes the folder, so without a cap the picker would grow by every session ever run.
 */
export const PICKER_MAX = 50

/** The picker's sessions: newest first, at most PICKER_MAX, and always the one on show. */
export function pickerSessions(sessions: ReadonlyMap<string, WatchSession>, shown: string | undefined): WatchSession[] {
  const list = [...sessions.values()].sort(newestFirst)
  if (list.length <= PICKER_MAX) return list
  const top = list.slice(0, PICKER_MAX)
  const own = shown === undefined ? undefined : sessions.get(shown)
  if (own !== undefined && !top.includes(own)) top.push(own)
  return top
}

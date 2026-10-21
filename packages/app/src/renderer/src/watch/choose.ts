// Which session the panel shows. Pure, so the rule is testable without React.
import type { WatchHostStatus, WatchSession } from '../../../shared/ipc'

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

/** What the panel draws: a snapshot from the mod, the terminal session's live model in its place, or nothing yet. */
export type PanelView<L> =
  /** `live` rides along when it is the same session: the steps and stats below the stage come from it */
  | { kind: 'snapshot'; sid: string; session: WatchSession; live?: L }
  | { kind: 'live'; sid: string; live: L }
  | { kind: 'none'; sid?: string; awaiting: boolean }

/**
 * The snapshot wins whenever the mod wrote one for the session on show. When the terminal's session has
 * none (Pairwatch down, the mod not loaded, or not written yet) but its live model exists, the panel is
 * drawn from that model, also once the terminal ended: its own transcript says more than another
 * session's snapshot. A session picked by hand is always shown as picked.
 */
export function choosePanelView<L extends { sid: string }>(sessions: ReadonlyMap<string, WatchSession>, terminal: TerminalRef | undefined, picked: string | undefined, live: L | undefined): PanelView<L> {
  const byHand = picked !== undefined && sessions.has(picked)
  const ownHasSnapshot = live !== undefined && (sessions.has(live.sid) || (terminal !== undefined && sessions.has(terminal.sid)))
  if (!byHand && live !== undefined && !ownHasSnapshot) return { kind: 'live', sid: live.sid, live }
  const choice = chooseSession(sessions, terminal, picked)
  if (choice.session !== undefined && choice.sid !== undefined) {
    return live !== undefined && live.sid === choice.sid ? { kind: 'snapshot', sid: choice.sid, session: choice.session, live } : { kind: 'snapshot', sid: choice.sid, session: choice.session }
  }
  return choice.sid === undefined ? { kind: 'none', awaiting: choice.awaiting } : { kind: 'none', sid: choice.sid, awaiting: choice.awaiting }
}

/**
 * How long the panel waits for the mod's first snapshot of a session it draws from the transcript before
 * it says the mod is not running: the live model often lands first, at every session start.
 */
export const MOD_GRACE_MS = 20_000

/** What the panel says while it draws from the transcript: still waiting for the mod, or the mod is not running. */
export type TranscriptSource = 'waiting' | 'not-running'

/**
 * Not running when no viewer is up (the mod has nowhere to write), once the terminal ended, or when no
 * snapshot came within MOD_GRACE_MS of the panel drawing this session (`waitedMs`; undefined: just began).
 */
export function transcriptSource(host: WatchHostStatus | undefined, ended: boolean, waitedMs: number | undefined): TranscriptSource {
  if (host?.mode === 'down' || ended) return 'not-running'
  return waitedMs !== undefined && waitedMs >= MOD_GRACE_MS ? 'not-running' : 'waiting'
}

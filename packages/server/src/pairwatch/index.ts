// Pairwatch's viewer contract, hosted by Docent: the mod (vendor/pairwatch/pairwatch/hooks/register.tsx)
// looks for a viewer on its port (/health), reads the key in <data dir>/viewer.token, polls
// /api/inbox?sid= for button presses and for `watching` (pages showing its session, which gates model
// narration), and writes one snapshot per session to <data dir>/live/<sid>.json. In host mode Docent
// is that viewer; in bridge mode a real viewer/server.mjs already holds the port and Docent follows it.
//
// API stub: the shapes are fixed here; the implementation lands in host.ts / snapshots.ts / bridge.ts.
import type { Snapshot } from './types.ts'

export type { Snapshot } from './types.ts'

export type PairwatchAction = 'why' | 'tip' | 'known' | 'pause' | 'level'
export type PairwatchMode = 'host' | 'bridge' | 'down'
export type PairwatchStatus = { mode: PairwatchMode; port: number; note?: string }
export type PairwatchSession = { sid: string; snapshot: Snapshot; updatedAt: number }

export type PairwatchHostOptions = {
  /** default ~/.claude/pairwatch (the mod's dataDir) */
  dataDir?: string
  /** the port to prefer; default 7979, the mod's default. Taken by a foreign process: another free one is used. */
  port?: number
  /** the directory holding the viewer's index.html (served at /), e.g. vendor/pairwatch/pairwatch/viewer */
  pageDir?: string
}

export type PairwatchHost = {
  status(): PairwatchStatus
  /** every live snapshot, newest first */
  sessions(): PairwatchSession[]
  onSnapshot(fn: (s: PairwatchSession) => void): () => void
  onRemoved(fn: (sid: string) => void): () => void
  onStatus(fn: (s: PairwatchStatus) => void): () => void
  /** the session Docent's panel shows: counted in that session's `watching` (host) or followed over SSE (bridge) */
  setWatched(sid: string | undefined): void
  /** a button press for a session: queued for the mod's next inbox poll (host) or posted to /api/action (bridge) */
  press(sid: string, action: PairwatchAction, value?: string): Promise<void>
  close(): Promise<void>
}

export async function startPairwatchHost(_opts?: PairwatchHostOptions): Promise<PairwatchHost> {
  throw new Error('not implemented')
}

/** The `--settings` JSON that points the bundled mod (loaded with --plugin-dir) at the viewer on `port`. */
export function pairwatchSettings(port: number): string {
  return JSON.stringify({ pluginConfigs: { 'pairwatch@inline': { options: { viewerPort: port } } } })
}

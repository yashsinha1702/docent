// Pairwatch's viewer contract, hosted by Docent: the mod (vendor/pairwatch/pairwatch/hooks/register.tsx)
// looks for a viewer on its port (/health), reads the key in <data dir>/viewer.token, polls
// /api/inbox?sid= for button presses and for `watching` (pages showing its session, which gates model
// narration), and writes one snapshot per session to <data dir>/live/<sid>.json. In host mode Docent
// is that viewer; in bridge mode a real viewer/server.mjs already holds the port and Docent follows it.
//
// host.ts answers the HTTP side, snapshots.ts watches the live folder (in both modes: the mod writes
// the files either way), bridge.ts follows a real viewer; this file picks the mode and keeps it right.
import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createBridge } from './bridge.ts'
import type { Bridge } from './bridge.ts'
import { createHostServer } from './host.ts'
import { DEFAULT_PORT, SID_RE, errnoOf, loadKey, messageOf, probeViewer } from './protocol.ts'
import { watchSnapshots } from './snapshots.ts'
import type { SnapshotEntry } from './snapshots.ts'
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
  /** where notable events go (mode changes, files ignored, errors); nothing is printed otherwise */
  log?: (msg: string) => void
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

/** tried in order when the preferred port is taken by a foreign process, before any free port */
const FALLBACK_PORTS = Array.from({ length: 20 }, (_, i) => 7980 + i)
/** after /api/quit the port is looked at again this soon: the viewer replacing us is starting */
const AFTER_QUIT_MS = 1000
/** a port held by something that does not answer /health is looked at again this often */
const RETRY_MS = 1500

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch {
    // best effort (Windows keeps its own permissions)
  }
}

const sessionOf = (entry: SnapshotEntry): PairwatchSession => ({ sid: entry.sid, snapshot: entry.snapshot, updatedAt: entry.updatedAt })

/** when a snapshot was taken, by its own clock; a file without one goes by its mtime */
const atOf = (s: PairwatchSession): number => (typeof s.snapshot.at === 'number' ? s.snapshot.at : s.updatedAt)

const statusOf = (mode: PairwatchMode, port: number, note?: string): PairwatchStatus => (note === undefined ? { mode, port } : { mode, port, note })

export async function startPairwatchHost(opts: PairwatchHostOptions = {}): Promise<PairwatchHost> {
  const { log } = opts
  const dataDir = opts.dataDir ?? join(homedir(), '.claude', 'pairwatch')
  const liveDir = join(dataDir, 'live')
  // the snapshots hold commands and paths: this user's eyes only
  await mkdir(liveDir, { recursive: true, mode: 0o700 })
  await chmodQuietly(dataDir, 0o700)
  await chmodQuietly(liveDir, 0o700)
  const keyFile = join(dataDir, 'viewer.token')
  const key = await loadKey(keyFile)
  await chmodQuietly(keyFile, 0o600)

  const preferred = opts.port ?? DEFAULT_PORT
  const statusListeners = new Set<(s: PairwatchStatus) => void>()
  let status: PairwatchStatus = statusOf('down', preferred)
  let bridge: Bridge | undefined
  let watched: string | undefined
  let timer: NodeJS.Timeout | undefined
  let reconciling: Promise<void> | undefined
  let quitAsked = false
  let closed = false

  // the watcher first (its files are listed before it resolves), then the host that answers from it
  const watcher = await watchSnapshots(liveDir, { log })
  const host = createHostServer({ key: Buffer.from(key), pageDir: opts.pageDir, snapshots: watcher, onQuit: () => afterQuit(), log })
  watcher.onSnapshot(() => host.refresh())
  watcher.onRemoved(() => host.refresh())

  const emitStatus = (next: PairwatchStatus): void => {
    if (next.mode === status.mode && next.port === status.port && next.note === status.note) return
    status = next
    log?.(`pairwatch: ${next.mode} on port ${next.port}${next.note === undefined ? '' : ` (${next.note})`}`)
    for (const fn of statusListeners) fn(next)
  }

  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void reconcile()
    }, ms)
    timer.unref()
  }

  const becomeHost = (port: number, note?: string): void => {
    bridge?.close()
    bridge = undefined
    host.setWatched(watched)
    emitStatus(statusOf('host', port, note))
  }

  const becomeBridge = (port: number): void => {
    bridge?.close()
    bridge = createBridge({ port, key, onDown: () => void reconcile(), log })
    bridge.setWatched(watched)
    emitStatus(statusOf('bridge', port, `following the Pairwatch viewer on port ${port}`))
  }

  /** The viewer we followed stopped answering, or we gave the port up: whoever answers now decides the mode. */
  const reconcileNow = async (): Promise<void> => {
    if (closed) return
    const port = status.port
    const found = await probeViewer(port)
    if (closed) return
    if (found !== undefined) {
      becomeBridge(port)
      return
    }
    if (quitAsked) {
      // a newer Pairwatch asked us to make way: its viewer gets the port, we do not take it back
      emitStatus(statusOf('down', port, 'asked to quit by a newer Pairwatch; waiting for its viewer'))
      schedule(RETRY_MS)
      return
    }
    bridge?.close()
    bridge = undefined
    try {
      becomeHost(await host.listen(port))
    } catch (err) {
      if (closed) return
      const taken = errnoOf(err) === 'EADDRINUSE'
      emitStatus(statusOf('down', port, taken ? `port ${port} is held, but no viewer answers on it` : `cannot serve on port ${port}: ${messageOf(err)}`))
      if (taken) schedule(RETRY_MS)
    }
  }

  /** One look at a time; whoever asks meanwhile shares it. */
  const reconcile = (): Promise<void> => {
    if (reconciling === undefined) {
      reconciling = reconcileNow()
        .catch((err: unknown) => log?.(`pairwatch: ${messageOf(err)}`))
        .finally(() => {
          reconciling = undefined
        })
    }
    return reconciling
  }

  const afterQuit = (): void => {
    if (closed) return
    quitAsked = true
    emitStatus(statusOf('down', status.port, 'asked to quit by a newer Pairwatch; looking for its viewer'))
    schedule(AFTER_QUIT_MS)
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    bridge?.close()
    bridge = undefined
    await Promise.all([host.close(), watcher.close()])
    emitStatus(statusOf('down', status.port, 'closed'))
  }

  // the mode: a viewer already on the preferred port is followed; else the first port we can bind is served
  try {
    const found = preferred === 0 ? undefined : await probeViewer(preferred)
    if (found !== undefined) becomeBridge(preferred)
    else {
      const candidates = preferred === 0 ? [0] : [preferred, ...FALLBACK_PORTS.filter(p => p !== preferred), 0]
      for (const port of candidates) {
        try {
          const bound = await host.listen(port)
          becomeHost(bound, port === preferred ? undefined : `port ${preferred} is taken; serving on ${bound}`)
          break
        } catch (err) {
          const code = errnoOf(err)
          if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
        }
      }
      if (status.mode !== 'host') throw new Error('no port to serve Pairwatch on')
    }
  } catch (err) {
    await close()
    throw err
  }

  return {
    status: () => status,
    sessions: () => watcher.all().map(sessionOf).sort((a, b) => atOf(b) - atOf(a)),
    onSnapshot: fn => watcher.onSnapshot(entry => fn(sessionOf(entry))),
    onRemoved: fn => watcher.onRemoved(fn),
    onStatus: fn => {
      statusListeners.add(fn)
      return () => statusListeners.delete(fn)
    },
    setWatched: sid => {
      watched = sid
      host.setWatched(sid)
      bridge?.setWatched(sid)
    },
    press: async (sid, action, value) => {
      if (!SID_RE.test(sid)) throw new Error(`not a Pairwatch session id: ${sid}`)
      if (status.mode === 'bridge' && bridge !== undefined) await bridge.press(sid, action, value)
      else if (status.mode === 'host') host.queue(sid, { action, value: typeof value === 'string' ? value.slice(0, 40) : undefined, at: Date.now() })
      else throw new Error(`no Pairwatch viewer to press on${status.note === undefined ? '' : ` (${status.note})`}`)
    },
    close,
  }
}

/** The `--settings` JSON that points the bundled mod (loaded with --plugin-dir) at the viewer on `port`. */
export function pairwatchSettings(port: number): string {
  return JSON.stringify({ pluginConfigs: { 'pairwatch@inline': { options: { viewerPort: port } } } })
}

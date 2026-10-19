// The live folder: one <sid>.json per session, written by the mod while a viewer is wanted. chokidar
// reports each file once it has stopped changing; a half-written one (it changes again when the
// write completes), an unparsable one or a stray one is skipped without a word.
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { watch } from 'chokidar'

import { SID_RE, isRecord, messageOf } from './protocol.ts'
import type { Snapshot } from './types.ts'

export type SnapshotEntry = {
  sid: string
  snapshot: Snapshot
  /** the file as written: what /api/state and the event streams send */
  text: string
  /** the file's mtime */
  updatedAt: number
}

export type SnapshotWatcherOptions = {
  /** how long a file must stay unchanged before it is read; default 80 ms */
  settleMs?: number
  log?: (msg: string) => void
}

export type SnapshotWatcher = {
  get(sid: string): SnapshotEntry | undefined
  /** every snapshot known, in no particular order */
  all(): SnapshotEntry[]
  /** a snapshot read: new, or changed */
  onSnapshot(fn: (entry: SnapshotEntry) => void): () => void
  onRemoved(fn: (sid: string) => void): () => void
  close(): Promise<void>
}

/** The session a live file is for, from its name; undefined for a name that is not <sid>.json. */
function sidOf(path: string): string | undefined {
  const name = basename(path)
  const sid = name.endsWith('.json') ? name.slice(0, -5) : ''
  return SID_RE.test(sid) ? sid : undefined
}

/** Watches `liveDir`; the files already there are read (and listed by all()) before it resolves. */
export async function watchSnapshots(liveDir: string, opts: SnapshotWatcherOptions = {}): Promise<SnapshotWatcher> {
  const { log } = opts
  const entries = new Map<string, SnapshotEntry>()
  const snapshotListeners = new Set<(entry: SnapshotEntry) => void>()
  const removedListeners = new Set<(sid: string) => void>()
  /** one look at a time per session, in the order the events came */
  const chains = new Map<string, Promise<void>>()
  let closed = false

  const load = async (sid: string): Promise<void> => {
    const file = join(liveDir, `${sid}.json`)
    let text: string
    let mtimeMs: number
    try {
      text = await readFile(file, 'utf8')
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      return // gone again
    }
    if (closed) return
    const known = entries.get(sid)
    if (known !== undefined && known.text === text) {
      known.updatedAt = mtimeMs
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // half-written: read again when the write completes
    }
    if (!isRecord(parsed) || parsed.sid !== sid) {
      log?.(`pairwatch snapshots: ${sid}.json is not a snapshot of ${sid}; ignored`)
      return
    }
    const entry: SnapshotEntry = { sid, snapshot: parsed as Snapshot, text, updatedAt: mtimeMs }
    entries.set(sid, entry)
    for (const fn of snapshotListeners) fn(entry)
  }

  const remove = async (sid: string): Promise<void> => {
    if (!entries.delete(sid)) return
    for (const fn of removedListeners) fn(sid)
  }

  const enqueue = (sid: string, job: () => Promise<void>): void => {
    const next = (chains.get(sid) ?? Promise.resolve()).then(job).catch((err: unknown) => log?.(`pairwatch snapshots: ${messageOf(err)}`))
    chains.set(sid, next)
    void next.then(() => {
      if (chains.get(sid) === next) chains.delete(sid)
    })
  }

  const onFile = (path: string): void => {
    const sid = sidOf(path)
    if (sid !== undefined) enqueue(sid, () => load(sid))
  }

  const watcher = watch(liveDir, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: opts.settleMs ?? 80, pollInterval: 20 },
  })
  watcher.on('add', onFile)
  watcher.on('change', onFile)
  watcher.on('unlink', path => {
    const sid = sidOf(path)
    if (sid !== undefined) enqueue(sid, () => remove(sid))
  })
  watcher.on('error', err => log?.(`pairwatch snapshots: ${messageOf(err)}`))

  // the files already there, before the watcher's own first listing lands
  let names: string[] = []
  try {
    names = await readdir(liveDir)
  } catch {
    // no folder yet
  }
  for (const name of names) onFile(name)
  await Promise.all(chains.values())

  return {
    get: sid => entries.get(sid),
    all: () => [...entries.values()],
    onSnapshot: fn => {
      snapshotListeners.add(fn)
      return () => snapshotListeners.delete(fn)
    },
    onRemoved: fn => {
      removedListeners.add(fn)
      return () => removedListeners.delete(fn)
    },
    close: async () => {
      closed = true
      await watcher.close()
    },
  }
}

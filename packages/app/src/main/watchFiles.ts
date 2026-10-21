// Outside changes to the files open in the editor. The renderer names its open tabs (workspace:watch,
// workspace-relative paths, the whole set each time); each gets an fs.watch, debounced, and a change
// of mtime, size or inode goes back to the window as workspace:changed {path, kind}. Atomic saves
// (write a temporary file, rename it over the original) replace the inode a watch sits on, so a rename
// re-arms it; a file that is gone is waited for through its folder and reported again when it returns.
// Without a watch on the file itself (it is gone, its folder may have gone too, as in a branch switch, or
// the watch could not be set) the file is also looked at every second until there is one.
//
// FileWatcher does the watching and takes a send function, so it runs without Electron;
// registerFileWatch ties it to the IPC channel and the window.
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// a namespace import: plain Node (the specs) can load this file, where `electron` is only the binary's path
import * as electron from 'electron'
import type { BrowserWindow, IpcMainEvent } from 'electron'

import type { FileChange } from '../shared/ipc'

export const WATCH_DEBOUNCE_MS = 100
/** a file written more often than the debounce (a log being appended) is still looked at this often */
export const WATCH_MAX_WAIT_MS = 1000
/** a file without a watch of its own (gone, or the watch failed) is looked at again this often */
export const WATCH_RETRY_MS = 1000
/** a renderer that names more files than this gets the first ones watched */
export const MAX_WATCHED_FILES = 500

export type FileWatcherOptions = {
  /** the workspace root, canonical (realpath'd) like the one the renderer has */
  root: string
  send: (e: FileChange) => void
  log?: (msg: string) => void
  debounceMs?: number
  maxWaitMs?: number
  retryMs?: number
}

type Stamp = { mtimeMs: number; size: number; ino: number }

type Entry = {
  /** as the renderer spelled it (forward slashes): the events carry it back unchanged */
  rel: string
  abs: string
  /** on the file while it exists */
  file?: FSWatcher
  /** on its folder while it does not */
  dir?: FSWatcher
  /** the debounce, or the next look while the file has no watch of its own */
  timer?: ReturnType<typeof setTimeout>
  /** when the first event the pending debounce waits on came: it never waits longer than maxWaitMs from then */
  burstAt?: number
  /** the last stat; undefined while the file is missing */
  last?: Stamp
  /** a rename or a watcher error since the last check: the watch may sit on a replaced inode */
  stale: boolean
  /** a check is running; `again`: another was asked for meanwhile */
  busy: boolean
  again: boolean
  /** it leads outside the workspace (a symlink): never watched */
  refused: boolean
  /** why it cannot be watched now (logged once, not on every retry) */
  trouble?: string
  done: boolean
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const stampOf = async (path: string): Promise<Stamp | undefined> => {
  try {
    const s = await stat(path)
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino } : undefined
  } catch {
    return undefined
  }
}

const differs = (a: Stamp, b: Stamp): boolean => a.mtimeMs !== b.mtimeMs || a.size !== b.size || a.ino !== b.ino

/**
 * A name from a folder event against the file's own. Windows and macOS ignore case, and macOS may report another
 * Unicode normalisation, while the renderer keeps the CLI's spelling; on a file system that tells them apart, a near
 * miss only costs one stat.
 */
const sameName = (a: string, b: string): boolean => a === b || a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()

export class FileWatcher {
  readonly root: string
  private readonly sendFn: (e: FileChange) => void
  private readonly log: (msg: string) => void
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly retryMs: number
  private readonly entries = new Map<string, Entry>()
  private rootReal: Promise<string> | undefined
  private closed = false

  constructor(opts: FileWatcherOptions) {
    this.root = opts.root
    this.sendFn = opts.send
    this.log = opts.log ?? (() => {})
    this.debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS
    this.maxWaitMs = opts.maxWaitMs ?? WATCH_MAX_WAIT_MS
    this.retryMs = opts.retryMs ?? WATCH_RETRY_MS
  }

  /** The workspace-relative paths watched now. */
  get paths(): string[] {
    return [...this.entries.keys()]
  }

  /** Replaces the watched set. Anything that is not a relative path inside the root is ignored. */
  set(paths: readonly unknown[]): void {
    if (this.closed) return
    const wanted = new Set<string>()
    for (const p of paths) {
      if (wanted.size >= MAX_WATCHED_FILES) break
      const rel = this.inRoot(p)
      if (rel !== undefined) wanted.add(rel)
    }
    for (const e of [...this.entries.values()]) if (!wanted.has(e.rel)) this.drop(e)
    for (const rel of wanted) {
      const had = this.entries.get(rel)
      if (had) {
        // one without a watch of its own is looked at again on a timer (retry); this only covers a lost one
        if (!had.file && !had.timer && !had.busy && !had.refused) this.schedule(had)
        continue
      }
      const e: Entry = { rel, abs: resolve(this.root, rel), stale: false, busy: false, again: false, refused: false, done: false }
      this.entries.set(rel, e)
      void this.check(e, true)
    }
  }

  /** Releases every watcher and timer; later calls to set do nothing. */
  close(): void {
    this.closed = true
    for (const e of [...this.entries.values()]) this.drop(e)
  }

  private inRoot(p: unknown): string | undefined {
    if (typeof p !== 'string' || p === '' || p.includes('\0') || isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return undefined
    const rel = relative(this.root, resolve(this.root, p))
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
    return p
  }

  /** Where a path really is: inside the real root, outside it (through a symlink), or not there at all. */
  private async whereIs(path: string): Promise<'inside' | 'outside' | 'missing'> {
    try {
      this.rootReal ??= realpath(this.root)
      const [root, real] = await Promise.all([this.rootReal, realpath(path)])
      return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep) ? 'inside' : 'outside'
    } catch {
      return 'missing'
    }
  }

  /** A check debounceMs after the last event, but no later than maxWaitMs after the first one still waiting. */
  private schedule(e: Entry): void {
    if (e.done) return
    const now = Date.now()
    e.burstAt ??= now
    clearTimeout(e.timer)
    e.timer = setTimeout(() => this.fire(e), Math.max(0, Math.min(this.debounceMs, e.burstAt + this.maxWaitMs - now)))
  }

  /** A check in retryMs, unless one is due sooner: no watch on the file says when to look. */
  private retry(e: Entry): void {
    if (e.done || e.timer) return
    e.timer = setTimeout(() => this.fire(e), this.retryMs)
  }

  private fire(e: Entry): void {
    e.timer = undefined
    e.burstAt = undefined
    void this.check(e, false)
  }

  /** One check at a time per file: one asked for while another runs follows it. */
  private async check(e: Entry, first: boolean): Promise<void> {
    if (e.busy) {
      e.again = true
      return
    }
    e.busy = true
    try {
      await this.checkOnce(e, first)
    } finally {
      e.busy = false
    }
    if (e.again && !e.done) {
      e.again = false
      await this.check(e, false)
    }
  }

  /** Stats the file, re-arms the watch when it has to, and reports a change or a deletion. */
  private async checkOnce(e: Entry, first: boolean): Promise<void> {
    const now = await stampOf(e.abs)
    if (e.done) return
    const was = e.last
    e.last = now
    const exists = now !== undefined
    if (first || e.stale || (exists ? !e.file : !e.dir) || (now && was && now.ino !== was.ino)) {
      e.stale = false
      const place = await this.whereIs(exists ? e.abs : dirname(e.abs))
      if (e.done) return
      if (place === 'outside') {
        this.unwatch(e)
        e.refused = true
        return this.log(`not watching ${e.rel}: it leads outside the workspace`)
      }
      if (place === 'missing') this.unwatch(e)
      const trouble = place === 'inside' ? this.arm(e, exists) : exists ? 'it went missing' : 'its folder is missing'
      if (trouble !== undefined && trouble !== e.trouble) this.log(`cannot watch ${e.rel}: ${trouble}; looking again every ${this.retryMs} ms`)
      e.trouble = trouble
    }
    // A folder watch says when the file comes back, but nothing says when the folder itself goes and comes back
    // (a branch switch; macOS reports no event at all for a watched folder that is removed), and a failed watch
    // says nothing. So without a watch on the file itself, it is looked at again in a while.
    if (!e.file) this.retry(e)
    if (!now) {
      // a tab whose file is already gone is told so once; afterwards only a file that disappears is
      if (first || was) this.emit(e, 'unlink')
      return
    }
    if (!first && (!was || differs(now, was))) this.emit(e, 'change')
  }

  /** Watches the file, or its folder while it does not exist; the error message when that cannot be done. */
  private arm(e: Entry, exists: boolean): string | undefined {
    this.unwatch(e)
    const name = basename(e.abs)
    try {
      const w = watch(exists ? e.abs : dirname(e.abs), (event, filename) => {
        if (!exists && filename != null && !sameName(String(filename), name)) return // another file in the folder
        if (event === 'rename') e.stale = true
        this.schedule(e)
      })
      // Windows reports a watched file's deletion as an error (EPERM): look again
      w.on('error', err => {
        this.log(`watch ${e.rel}: ${message(err)}`)
        this.unwatch(e)
        e.stale = true
        this.schedule(e)
      })
      if (exists) e.file = w
      else e.dir = w
      return undefined
    } catch (err) {
      return message(err)
    }
  }

  private unwatch(e: Entry): void {
    e.file?.close()
    e.dir?.close()
    e.file = undefined
    e.dir = undefined
  }

  private drop(e: Entry): void {
    e.done = true
    clearTimeout(e.timer)
    e.timer = undefined
    e.burstAt = undefined
    this.unwatch(e)
    this.entries.delete(e.rel)
  }

  private emit(e: Entry, kind: FileChange['kind']): void {
    try {
      this.sendFn({ path: e.rel, kind })
    } catch (err) {
      this.log(`reporting ${e.rel}: ${message(err)}`)
    }
  }
}

export type FileWatchDeps = { win: () => BrowserWindow | undefined; root: () => string; log: (m: string) => void }

/**
 * Handles `workspace:watch` from the window's renderer and sends it `workspace:changed`. One FileWatcher
 * at a time, for the current root: a watch request under another root, or `closeAll()` (call it when the
 * workspace changes, and at shutdown), releases every watcher. The IPC listener stays for the app's life.
 */
export function registerFileWatch(deps: FileWatchDeps): { closeAll(): void } {
  let current: FileWatcher | undefined
  const closeAll = (): void => {
    current?.close()
    current = undefined
  }
  const send = (from: FileWatcher, e: FileChange): void => {
    // a watcher left from another root would name the wrong files
    if (from !== current || deps.root() !== from.root) {
      if (from === current) closeAll()
      else from.close()
      return
    }
    const win = deps.win()
    if (!win || win.isDestroyed()) return
    win.webContents.send('workspace:changed', e)
  }
  electron.ipcMain.on('workspace:watch', (event: IpcMainEvent, paths: unknown) => {
    const win = deps.win()
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return
    const root = deps.root()
    if (current && current.root !== root) closeAll()
    const list = Array.isArray(paths) ? (paths as unknown[]) : []
    if (list.length === 0) return closeAll()
    if (!current) {
      const w: FileWatcher = new FileWatcher({ root, send: e => send(w, e), log: deps.log })
      current = w
    }
    current.set(list)
  })
  return { closeAll }
}

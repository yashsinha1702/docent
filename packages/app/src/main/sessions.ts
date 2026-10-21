// The live session behind each claude terminal: one transcript feed per pty (@docent/server
// startSessionFeed), its updates relayed to the renderer on 'session:event', at most one per 200 ms per
// terminal (always the newest), and the last one kept for 'session:get', also after the terminal exits
// (the recap export reads it).
//
// Wiring (main/index.ts): construct once, `const sessions = new SessionFeeds({ win: () => win, log: m => log(m) })`;
// after a claude pty spawns, `sessions.start(h.id, sessionId, workspace.root)` (the id passed as --session-id);
// in that pty's onExit, `sessions.stop(h.id)`; in shutdown(), `sessions.closeAll()`.
import { startSessionFeed } from '@docent/server'
import type { SessionFeed, SessionUpdate } from '@docent/server'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

import type { LiveSession, SessionEvent } from '../shared/ipc'

/** at most one update per terminal this often */
const UPDATE_GAP_MS = 200
/** a stopped feed keeps reading this long first: the rows written as the terminal exited (the feed polls every 500 ms, folds every 400 ms) */
const STOP_GRACE_MS = 1000
/** sessions of exited terminals kept for session:get */
const KEEP_CLOSED = 16

type Deps = { win: () => BrowserWindow | undefined; log: (m: string) => void; configDir?: string }

type Entry = {
  sid: string
  feed?: SessionFeed
  /** stop() was called: no more updates once the grace is over */
  isStopping: boolean
  isClosed: boolean
  last?: LiveSession
  /** the newest update not sent yet */
  pending?: LiveSession
  sentAt: number
  sendTimer?: NodeJS.Timeout
  graceTimer?: NodeJS.Timeout
}

export class SessionFeeds {
  private readonly deps: Deps
  private readonly entries = new Map<string, Entry>()

  constructor(deps: Deps) {
    this.deps = deps
    ipcMain.handle('session:get', (_e, ptyId: string): LiveSession | undefined => this.get(ptyId))
  }

  /** Follows claude session `sid` (its --session-id) running in terminal `ptyId`, with `cwd` the workspace root. */
  start(ptyId: string, sid: string, cwd: string): void {
    if (this.entries.get(ptyId)?.isClosed === false) this.finish(ptyId)
    const entry: Entry = { sid, isStopping: false, isClosed: false, sentAt: 0 }
    this.entries.set(ptyId, entry)
    this.send({ type: 'waiting', ptyId, sid })
    startSessionFeed({ sid, cwd, configDir: this.deps.configDir, log: m => this.deps.log(m), onUpdate: u => this.onUpdate(ptyId, entry, u) })
      .then(feed => {
        if (entry.isClosed) void feed.close()
        else entry.feed = feed
      })
      .catch((err: unknown) => this.deps.log(`session feed for ${sid} did not start: ${String(err)}`))
  }

  /** The terminal exited: the feed reads a last time, then closes; 'closed' follows the newest update. */
  stop(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry === undefined || entry.isStopping || entry.isClosed) return
    entry.isStopping = true
    entry.graceTimer = setTimeout(() => this.finish(ptyId), STOP_GRACE_MS)
  }

  get(ptyId: string): LiveSession | undefined {
    return this.entries.get(ptyId)?.last
  }

  /** At shutdown: every feed closes at once, no events are sent, session:get is unregistered. */
  async closeAll(): Promise<void> {
    ipcMain.removeHandler('session:get')
    const closing: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      entry.isClosed = true
      clearTimeout(entry.sendTimer)
      clearTimeout(entry.graceTimer)
      if (entry.feed !== undefined) closing.push(entry.feed.close())
      entry.feed = undefined
    }
    await Promise.allSettled(closing)
  }

  private finish(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (entry === undefined || entry.isClosed) return
    entry.isClosed = true
    clearTimeout(entry.graceTimer)
    const feed = entry.feed
    entry.feed = undefined
    if (feed !== undefined) void feed.close().catch((err: unknown) => this.deps.log(`session feed for ${entry.sid} did not close: ${String(err)}`))
    this.flush(entry, ptyId)
    this.send({ type: 'closed', ptyId, sid: entry.sid })
    // keep the map in close order, so forgetOldest drops the terminal that exited first
    this.entries.delete(ptyId)
    this.entries.set(ptyId, entry)
    this.forgetOldest()
  }

  private onUpdate(ptyId: string, entry: Entry, u: SessionUpdate): void {
    if (entry.isClosed) return
    const live: LiveSession = { ...u, ptyId }
    entry.last = live
    entry.pending = live
    if (entry.sendTimer !== undefined) return
    const wait = UPDATE_GAP_MS - (Date.now() - entry.sentAt)
    if (wait <= 0) this.flush(entry, ptyId)
    else entry.sendTimer = setTimeout(() => this.flush(entry, ptyId), wait)
  }

  private flush(entry: Entry, ptyId: string): void {
    clearTimeout(entry.sendTimer)
    entry.sendTimer = undefined
    const live = entry.pending
    if (live === undefined || this.entries.get(ptyId) !== entry) return
    entry.pending = undefined
    entry.sentAt = Date.now()
    this.send({ type: 'update', live })
  }

  private send(e: SessionEvent): void {
    const win = this.deps.win()
    if (win !== undefined && !win.isDestroyed()) win.webContents.send('session:event', e)
  }

  /** Exited terminals beyond KEEP_CLOSED are forgotten, oldest first. */
  private forgetOldest(): void {
    const closed = [...this.entries].filter(([, e]) => e.isClosed).map(([id]) => id)
    for (const id of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) this.entries.delete(id)
  }
}

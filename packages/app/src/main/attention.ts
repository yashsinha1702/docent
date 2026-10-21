// Calls the person back when the claude session in a terminal needs them (OSC 7501 `blocked`) or has
// finished (`done`) while Docent's window is in the background: a notification, the macOS dock badge
// and an informational bounce, a flashing taskbar button on Windows and Linux. All of it goes away
// once the window gains focus or the session moves on.
//
// Wiring (main/index.ts): construct once at startup next to the IDE relay, before the window is created;
// call onProgram wherever OSC 7501 reports are forwarded to the renderer, report a bare `clear` when a pty
// exits, dispose on shutdown. On Windows the constructor also sets the app's AppUserModelID (APP_ID):
// Windows shows a toast only under the id of a Start-menu shortcut, and drops the rest without a word.
import { Notification, app } from 'electron'
import type { BrowserWindow } from 'electron'

import type { ProgramState, ProgramStatus } from '../shared/ipc'

export type AttentionDeps = {
  win: () => BrowserWindow | undefined
  log: (m: string) => void
}

export type AttentionCall = 'needs-you' | 'done'

/**
 * The AppUserModelID the installer gives its Start-menu shortcut: electron-builder.yml's appId (the NSIS
 * template sets the shortcut's AUMI to it). Without it Electron sends toasts under its default id
 * ('electron.app.' and the app's name), which no shortcut carries, and Windows shows none of them.
 */
export const APP_ID = 'com.yashsinha.docent'

/** The id toasts go out under: the installer's when packaged; in development the Electron binary's path, as Electron's docs advise (pin electron.exe to the Start menu to see them). */
export const appUserModelId = (packaged: boolean, execPath: string): string => (packaged ? APP_ID : execPath)

/** What a main-session report asks of the person: a call only on a change into blocked or done, and only while they are away. */
export function attentionFor(prev: ProgramState | undefined, next: ProgramState, focused: boolean): AttentionCall | undefined {
  if (focused || prev === next) return undefined
  return next === 'blocked' ? 'needs-you' : next === 'done' ? 'done' : undefined
}

const KIND: Readonly<Record<string, string>> = { permission: 'Permission needed', question: 'A question for you', auth: 'Sign-in needed' }

const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** 'Permission needed: Bash wants to run npm test' from the report's kind and message. */
export function needsYouBody(s: Pick<ProgramStatus, 'kind' | 'msg'>): string {
  const kind = oneLine(s.kind)
  const head = kind === '' ? '' : (KIND[kind] ?? kind)
  const msg = oneLine(s.msg)
  if (head === '' && msg === '') return 'Claude is waiting for you in Docent.'
  return head === '' ? msg : msg === '' ? head : `${head}: ${msg}`
}

/** Notifications kept alive until clicked or dismissed (Electron drops the click of one garbage-collected). */
const NOTES_MAX = 8

type Note = { ptyId: string; call: AttentionCall }

export class Attention {
  private readonly deps: AttentionDeps
  /** the main session's last state, per pty */
  private readonly states = new Map<string, ProgramState>()
  /** ptys whose session waits on the person and raised the badge / flash */
  private readonly waiting = new Set<string>()
  private readonly notes = new Map<Notification, Note>()
  private bounceId: number | undefined
  private flashing: BrowserWindow | undefined
  private badged = false
  private disposed = false
  private readonly onFocus = (): void => this.calm()

  constructor(deps: AttentionDeps) {
    this.deps = deps
    if (process.platform === 'win32') this.attempt('setting the app id', () => app.setAppUserModelId(appUserModelId(app.isPackaged, process.execPath)))
    app.on('browser-window-focus', this.onFocus)
  }

  /** One OSC 7501 report from the pty's claude. Background tasks (id other than '') never call for attention. */
  onProgram(ptyId: string, status: ProgramStatus): void {
    if (this.disposed) return
    if (status.state === 'clear') {
      // a bare clear (no id) clears everything, `id=''` the main session; a task's clear changes nothing here
      if (status.id === undefined || status.id === '') {
        this.states.delete(ptyId)
        this.release(ptyId)
      }
      return
    }
    if (status.id !== undefined && status.id !== '') return
    const prev = this.states.get(ptyId)
    this.states.set(ptyId, status.state)
    if (status.state !== 'blocked') this.release(ptyId)
    const call = attentionFor(prev, status.state, this.isFocused())
    if (call === 'needs-you') {
      this.waiting.add(ptyId)
      this.notify(ptyId, call, 'Claude needs you', needsYouBody(status), false)
      this.raise()
    } else if (call === 'done') {
      this.notify(ptyId, call, 'Claude is done', oneLine(status.msg), true)
    }
  }

  /** Stops listening and takes down every notification, badge and flash it raised. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    app.removeListener('browser-window-focus', this.onFocus)
    this.calm()
    this.states.clear()
  }

  private isFocused(): boolean {
    const w = this.deps.win()
    return w !== undefined && !w.isDestroyed() && w.isFocused()
  }

  private attempt(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.deps.log(`attention: ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private notify(ptyId: string, call: AttentionCall, title: string, body: string, silent: boolean): void {
    if (!Notification.isSupported()) return
    this.attempt('notification', () => {
      const n = new Notification({ title, body, silent })
      this.notes.set(n, { ptyId, call })
      const forget = () => {
        this.notes.delete(n)
      }
      n.on('click', () => {
        forget()
        this.bringBack()
      })
      n.on('close', forget)
      n.show()
      // the oldest goes first once too many pile up
      for (const old of this.notes.keys()) {
        if (this.notes.size <= NOTES_MAX) break
        this.close(old)
      }
    })
  }

  private close(n: Notification): void {
    this.notes.delete(n)
    this.attempt('closing a notification', () => n.close())
  }

  private bringBack(): void {
    const w = this.deps.win()
    if (w === undefined || w.isDestroyed()) return
    this.attempt('showing the window', () => {
      if (w.isMinimized()) w.restore()
      w.show()
      if (process.platform === 'darwin') app.focus({ steal: true })
      w.focus()
    })
  }

  /** The badge counts the sessions waiting; the dock bounces once (macOS), the taskbar button flashes (Windows, Linux). */
  private raise(): void {
    if (process.platform === 'darwin') {
      const dock = app.dock
      if (dock === undefined) return
      this.attempt('dock badge', () => dock.setBadge(String(this.waiting.size)))
      this.badged = true
      if (this.bounceId === undefined) {
        this.attempt('dock bounce', () => {
          const id = dock.bounce('informational')
          if (id >= 0) this.bounceId = id
        })
      }
    } else if (process.platform === 'win32' || process.platform === 'linux') {
      const w = this.deps.win()
      if (w === undefined || w.isDestroyed()) return
      this.attempt('flashing the window', () => w.flashFrame(true))
      this.flashing = w
    }
  }

  /** Takes down the badge, the bounce and the flash. */
  private lower(): void {
    if (process.platform === 'darwin') {
      const dock = app.dock
      if (this.badged) this.attempt('dock badge', () => dock?.setBadge(''))
      const id = this.bounceId
      if (id !== undefined) this.attempt('dock bounce', () => dock?.cancelBounce(id))
    }
    this.badged = false
    this.bounceId = undefined
    const w = this.flashing
    this.flashing = undefined
    if (w !== undefined && !w.isDestroyed()) this.attempt('flashing the window', () => w.flashFrame(false))
  }

  /** A session no longer waits on the person: its call goes, and the badge with the last one. */
  private release(ptyId: string): void {
    for (const [n, note] of [...this.notes]) if (note.ptyId === ptyId && note.call === 'needs-you') this.close(n)
    if (!this.waiting.delete(ptyId)) return
    if (this.waiting.size === 0) this.lower()
    else if (process.platform === 'darwin' && this.badged) {
      const dock = app.dock
      this.attempt('dock badge', () => dock?.setBadge(String(this.waiting.size)))
    }
  }

  /** The person is back (or Docent is closing): every call is answered. */
  private calm(): void {
    for (const n of [...this.notes.keys()]) this.close(n)
    this.waiting.clear()
    this.lower()
  }
}

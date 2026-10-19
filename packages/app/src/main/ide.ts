// The editor as the IDE protocol sees it. The renderer reports its editors and selection
// (ide:editorState); requests that need the user or the page (openDiff, openFile, ...) are relayed
// to it as IdeRequests and answered through ide:reply. One IdeServer (lock file + ws MCP server)
// exists per claude terminal, started before claude so its port can go into CLAUDE_CODE_SSE_PORT.
import { randomUUID } from 'node:crypto'

import type { DiffOutcome, IdeHost, IdeServer, OpenDiffRequest, OpenEditor, OpenFileRequest, Selection } from '@docent/server'
import { startIdeServer } from '@docent/server'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

import type { AtMention, EditorState, IdeEvent, IdeReply, IdeRequest } from '../shared/ipc'

const SELECTION_DEBOUNCE_MS = 300
const REPLY_TIMEOUT_MS = 10_000

type Deps = { win: () => BrowserWindow | undefined; root: () => string; version: string; log: (msg: string) => void }

export class RendererIde implements IdeHost {
  private readonly deps: Deps
  private state: EditorState = { open: [] }
  private latest: Selection | undefined
  private readonly pending = new Map<string, (r: IdeReply) => void>()
  private readonly servers = new Map<string, IdeServer>()
  private selectionTimer: NodeJS.Timeout | undefined
  private lastSelectionKey = ''

  constructor(deps: Deps) {
    this.deps = deps
    ipcMain.on('ide:reply', (_e, id: string, result: IdeReply) => {
      const settle = this.pending.get(id)
      if (!settle) return
      this.pending.delete(id)
      settle(result)
    })
    ipcMain.on('ide:editorState', (_e, state: EditorState) => this.setState(state))
    ipcMain.on('ide:atMentioned', (_e, m: AtMention) => {
      for (const s of this.servers.values()) s.notifyAtMentioned(m)
    })
  }

  /** Starts the per-terminal server; `bind` ties it to the pty once that exists. */
  async start(): Promise<IdeServer> {
    const server = await startIdeServer({ host: this, ideName: 'Docent', version: this.deps.version })
    this.deps.log(`ide server on ${server.port}, lock ${server.lockPath}`)
    return server
  }

  bind(ptyId: string, server: IdeServer): void {
    this.servers.set(ptyId, server)
    server.onConnection(connected => {
      this.deps.log(`ide ${connected ? 'connected' : 'disconnected'} (pty ${ptyId})`)
      this.send({ type: 'connection', ptyId, connected })
    })
  }

  detach(ptyId: string): void {
    const s = this.servers.get(ptyId)
    this.servers.delete(ptyId)
    void s?.close()
  }

  async closeAll(): Promise<void> {
    const all = [...this.servers.values()]
    this.servers.clear()
    await Promise.allSettled(all.map(s => s.close()))
  }

  // ---- IdeHost

  workspaceFolders(): string[] {
    return [this.deps.root()]
  }
  openEditors(): OpenEditor[] {
    return this.state.open.map(o => ({ path: o.path, dirty: o.dirty, active: o.path === this.state.active }))
  }
  currentSelection(): Selection | undefined {
    return this.state.selection
  }
  latestSelection(): Selection | undefined {
    return this.latest
  }
  isDirty(path: string): boolean | undefined {
    return this.state.open.find(o => o.path === path)?.dirty
  }
  async openDiff(req: OpenDiffRequest): Promise<DiffOutcome> {
    // no timeout: the tab stays until the user accepts, rejects or closes it
    const r = await this.request({ type: 'openDiff', id: randomUUID(), ...req })
    return 'outcome' in r ? r : { outcome: 'rejected' }
  }
  async closeTab(tabName: string): Promise<boolean> {
    const r = await this.request({ type: 'closeTab', id: randomUUID(), tabName }, REPLY_TIMEOUT_MS)
    return 'ok' in r && r.ok
  }
  async closeAllDiffTabs(): Promise<number> {
    const r = await this.request({ type: 'closeAllDiffTabs', id: randomUUID() }, REPLY_TIMEOUT_MS)
    return 'ok' in r ? (r.count ?? 0) : 0
  }
  async openFile(req: OpenFileRequest): Promise<void> {
    const r = await this.request({ type: 'openFile', id: randomUUID(), ...req }, REPLY_TIMEOUT_MS)
    if ('ok' in r && !r.ok) throw new Error(r.error ?? 'could not open file')
  }
  async saveDocument(path: string): Promise<boolean> {
    const r = await this.request({ type: 'saveDocument', id: randomUUID(), path }, REPLY_TIMEOUT_MS)
    return 'ok' in r && r.ok
  }

  // ---- renderer plumbing

  private setState(state: EditorState): void {
    this.state = state
    if (state.selection) this.latest = state.selection
    const key = JSON.stringify(state.selection ?? null)
    if (key === this.lastSelectionKey) return
    this.lastSelectionKey = key
    clearTimeout(this.selectionTimer)
    this.selectionTimer = setTimeout(() => {
      const sel = this.state.selection
      if (!sel) return
      for (const s of this.servers.values()) s.notifySelectionChanged(sel)
    }, SELECTION_DEBOUNCE_MS)
  }

  private send(e: IdeEvent): void {
    this.deps.win()?.webContents.send('ide:event', e)
  }

  private request(req: IdeRequest, timeoutMs?: number): Promise<IdeReply> {
    const w = this.deps.win()
    if (!w) return Promise.reject(new Error('Docent has no window open'))
    return new Promise<IdeReply>((resolve, reject) => {
      this.pending.set(req.id, resolve)
      this.send({ type: 'request', request: req })
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(req.id)) reject(new Error(`the editor did not answer ${req.type}`))
        }, timeoutMs).unref()
      }
    })
  }
}

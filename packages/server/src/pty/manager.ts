// Pty sessions. One PtyManager per process; each handle is one terminal tab (claude or a shell).
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import * as pty from 'node-pty'

import { OscParser } from './osc.ts'
import type { OscEvent } from './osc.ts'
import { PROGRAM_STATUS_REPLY } from './status.ts'

export type PtySpawnOptions = {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
  /** answer Claude Code's `OSC 7501 ; ?` probe so it reports working / blocked / done (default true) */
  answerStatusProbe?: boolean
}

export type PtyHandle = {
  id: string
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(fn: (data: string) => void): () => void
  onExit(fn: (exitCode: number, signal?: number) => void): () => void
  onOsc(fn: (event: OscEvent) => void): () => void
}

/** Chunked, drain-aware writes: a 5 KB paste into the claude TUI must not be dropped. */
const WRITE_CHUNK = 1024

export class PtyManager {
  private readonly handles = new Map<string, PtyHandle>()

  spawn(opts: PtySpawnOptions): PtyHandle {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v
    const term = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    })
    const events = new EventEmitter()
    const osc = new OscParser(e => {
      if (e.kind === 'status-probe' && opts.answerStatusProbe !== false) term.write(PROGRAM_STATUS_REPLY)
      events.emit('osc', e)
    })
    term.onData(d => {
      events.emit('data', d)
      osc.feed(d)
    })
    term.onExit(e => {
      events.emit('exit', e.exitCode, e.signal)
      this.handles.delete(handle.id)
    })
    const handle: PtyHandle = {
      id: randomUUID(),
      pid: term.pid,
      write: data => {
        for (let i = 0; i < data.length; i += WRITE_CHUNK) term.write(data.slice(i, i + WRITE_CHUNK))
      },
      resize: (cols, rows) => {
        if (cols > 0 && rows > 0) term.resize(cols, rows)
      },
      kill: signal => term.kill(signal),
      onData: fn => {
        events.on('data', fn)
        return () => events.off('data', fn)
      },
      onExit: fn => {
        events.on('exit', fn)
        return () => events.off('exit', fn)
      },
      onOsc: fn => {
        events.on('osc', fn)
        return () => events.off('osc', fn)
      },
    }
    this.handles.set(handle.id, handle)
    return handle
  }

  get(id: string): PtyHandle | undefined {
    return this.handles.get(id)
  }

  /** Graceful close for every session: Ctrl-C, then Ctrl-D, then SIGTERM. */
  async closeAll(graceMs = 1500): Promise<void> {
    const all = [...this.handles.values()]
    for (const h of all) h.write('\x03')
    await sleep(300)
    for (const h of all) h.write('\x04')
    await sleep(graceMs)
    for (const h of all) if (this.handles.has(h.id)) h.kill('SIGTERM')
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

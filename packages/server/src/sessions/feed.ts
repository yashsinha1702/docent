// The live feed: looks for a session's transcript every 500 ms until Claude Code writes it (at the
// first prompt), then tails it and its helpers' transcripts and folds the rows into Pairwatch's
// SessionModel on a tick (400 ms, the mod's pump: reduce, then settleHop). chokidar wakes the reader at
// once; a 500 ms poll is the fallback, since fs events on macOS can be coalesced or lost. A transcript
// that shrinks or is replaced is read again from its start into a fresh model. A long transcript (claude
// --resume) is read and folded in bounded slices that yield to the event loop, and shown once folded.
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldToLoop } from 'node:timers/promises'

import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'

import { claudeConfigDir, findTranscript, helpersDir, listHelpers } from './locate.ts'
import { FOLD_BATCH, FoldedSession } from './model.ts'
import { LineTail } from './tail.ts'
import type { Level, SessionUpdate } from './types.ts'

export type SessionFeedOptions = {
  sid: string
  /** the session's cwd: ReduceCtx.cwd, so paths display relative to it */
  cwd: string
  /** default $CLAUDE_CONFIG_DIR or ~/.claude */
  configDir?: string
  /** ReduceCtx.level (explanations' wording); default 1 */
  level?: Level
  /** how often queued rows are folded; default 400 ms (the mod's pump) */
  tickMs?: number
  /** called after every fold that changed model.rev or usage */
  onUpdate(u: SessionUpdate): void
  log?: (msg: string) => void
}

export type SessionFeed = {
  readonly sid: string
  /** undefined until the transcript appears */
  readonly transcript: string | undefined
  current(): SessionUpdate | undefined
  setLevel(level: Level): void
  /** stops watching and timers; idempotent */
  close(): Promise<void>
}

const LOCATE_MS = 500
const POLL_MS = 500
const TICK_MS = 400
/** bytes taken from one file before the reader yields */
const READ_CHUNK = 1024 * 1024
/** ms of folding before the folder yields */
const SLICE_MS = 12

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Starts following a session; resolves at once even if the transcript does not exist yet (it is looked for until it does). */
export async function startSessionFeed(opts: SessionFeedOptions): Promise<SessionFeed> {
  const feed = new LiveFeed(opts)
  feed.start()
  return feed
}

class LiveFeed implements SessionFeed {
  readonly sid: string
  private readonly opts: SessionFeedOptions
  private readonly configDir: string
  private readonly log: (msg: string) => void
  private level: Level
  private session: FoldedSession
  private path: string | undefined
  private mainTail: LineTail | undefined
  private readonly helperTails = new Map<string, LineTail>()
  private watcher: FSWatcher | undefined
  private isWatchingHelpers = false
  private locateTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private tickTimer: NodeJS.Timeout | undefined
  private locating: Promise<void> | undefined
  private reading: Promise<void> | undefined
  private readAgain = false
  private folding: Promise<void> | undefined
  /** set when the transcript was found or started over: the first read of it is shown even if rev looks unchanged */
  private isFresh = false
  private mustShow = false
  private shown = { rev: -1, usage: -1 }
  private last: SessionUpdate | undefined
  /** the last read error logged: the poll retries every 500 ms, the log says it once */
  private lastError = ''
  private isClosed = false
  private closing: Promise<void> | undefined

  constructor(opts: SessionFeedOptions) {
    this.opts = opts
    this.sid = opts.sid
    this.configDir = claudeConfigDir(opts.configDir)
    this.log = opts.log ?? (() => {})
    this.level = opts.level ?? 1
    this.session = new FoldedSession(opts.cwd, this.level, Date.now())
  }

  get transcript(): string | undefined {
    return this.path
  }

  current(): SessionUpdate | undefined {
    return this.last
  }

  setLevel(level: Level): void {
    // like the mod: the wording of steps from now on; steps already explained keep theirs
    this.level = level
    this.session.level = level
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS)
    this.locateTimer = setInterval(() => this.locate(), LOCATE_MS)
    this.locate()
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.isClosed = true
      clearInterval(this.tickTimer)
      clearInterval(this.locateTimer)
      clearInterval(this.pollTimer)
      const watcher = this.watcher
      this.watcher = undefined
      await Promise.allSettled([watcher?.close(), this.locating, this.reading, this.folding])
    })()
    return this.closing
  }

  // ---- finding the transcript

  private locate(): void {
    if (this.isClosed || this.path !== undefined || this.locating !== undefined) return
    this.locating = findTranscript(this.sid, this.configDir)
      .then(path => {
        if (path !== undefined && !this.isClosed && this.path === undefined) this.begin(path)
      })
      .catch((err: unknown) => this.log(`sessions: looking for ${this.sid}: ${messageOf(err)}`))
      .finally(() => {
        this.locating = undefined
      })
  }

  private begin(path: string): void {
    this.path = path
    clearInterval(this.locateTimer)
    this.locateTimer = undefined
    this.mainTail = new LineTail(path)
    this.isFresh = true
    this.log(`sessions: following ${path}`)
    // depth 0: the subagents dir is added later, and workflow agents' files nest under it (not read)
    const watcher = watch(path, { ignoreInitial: true, depth: 0 })
    watcher.on('all', () => this.wake())
    watcher.on('error', err => this.log(`sessions: watching ${path}: ${messageOf(err)}`))
    this.watcher = watcher
    this.pollTimer = setInterval(() => this.wake(), POLL_MS)
    this.wake()
  }

  // ---- reading

  private wake(): void {
    if (this.isClosed || this.mainTail === undefined) return
    if (this.reading !== undefined) {
      this.readAgain = true
      return
    }
    this.reading = this.readLoop().finally(() => {
      this.reading = undefined
      if (this.readAgain && !this.isClosed) this.wake()
    })
  }

  private async readLoop(): Promise<void> {
    do {
      this.readAgain = false
      try {
        await this.readCycle()
        this.lastError = ''
      } catch (err) {
        const msg = `sessions: reading ${this.path ?? this.sid}: ${messageOf(err)}`
        if (msg !== this.lastError) this.log(msg)
        this.lastError = msg
      }
    } while (this.readAgain && !this.isClosed)
  }

  /** Helpers first, then the main file: whatever a helper wrote before the main file says it is done is then read too. */
  private async readCycle(): Promise<void> {
    const path = this.path
    const main = this.mainTail
    if (path === undefined || main === undefined) return
    const s = this.session
    const dir = helpersDir(path)
    const found = await listHelpers(dir)
    if (this.isClosed || s !== this.session) return
    if (found !== undefined) {
      if (!this.isWatchingHelpers && this.watcher !== undefined) {
        this.isWatchingHelpers = true
        this.watcher.add(dir)
      }
      for (const [agentId, file] of found) if (!this.helperTails.has(agentId)) this.helperTails.set(agentId, new LineTail(file))
    }
    for (const [agentId, tail] of this.helperTails) {
      if (!(await this.drain(s, tail, lines => s.fold.addHelper(agentId, lines)))) return
    }
    if (!(await this.drain(s, main, lines => s.fold.addMain(lines)))) return
    s.enqueue(s.fold.take(false))
    if (this.isFresh) {
      this.isFresh = false
      this.mustShow = true
    }
  }

  /** A file's new lines into `take`, a chunk at a time; false when this read must stop (closed, or started over). */
  private async drain(s: FoldedSession, tail: LineTail, take: (lines: string[]) => void): Promise<boolean> {
    for (;;) {
      const r = await tail.read(READ_CHUNK)
      if (this.isClosed || s !== this.session) return false
      if (r.reset) {
        this.restart(`${basename(tail.path)} shrank or was replaced`)
        return false
      }
      if (r.lines.length > 0) take(r.lines)
      if (!r.more) return true
      await yieldToLoop()
      if (this.isClosed || s !== this.session) return false
    }
  }

  private restart(reason: string): void {
    this.log(`sessions: ${reason}; reading session ${this.sid} again from the start`)
    this.session = new FoldedSession(this.opts.cwd, this.level, Date.now())
    if (this.path !== undefined) this.mainTail = new LineTail(this.path)
    this.helperTails.clear()
    this.isFresh = true
    this.readAgain = true
  }

  // ---- folding

  private tick(): void {
    if (this.isClosed || this.folding !== undefined) return
    this.folding = this.fold()
      .catch((err: unknown) => this.log(`sessions: folding ${this.sid}: ${messageOf(err)}`))
      .finally(() => {
        this.folding = undefined
      })
  }

  private async fold(): Promise<void> {
    const s = this.session
    let started = performance.now()
    while (s.pending > 0) {
      s.foldSome(FOLD_BATCH, Date.now())
      if (s.pending > 0 && performance.now() - started > SLICE_MS) {
        await yieldToLoop()
        if (this.isClosed || s !== this.session) return
        started = performance.now()
      }
    }
    s.settle(Date.now())
    this.show(s)
  }

  private show(s: FoldedSession): void {
    // nothing until the transcript is found, and a model that starts over is shown once it is read again
    if (this.path === undefined || this.isFresh) return
    const rev = s.model.rev
    const usage = s.fold.usage.rev
    if (!this.mustShow && rev === this.shown.rev && usage === this.shown.usage) return
    this.mustShow = false
    this.shown = { rev, usage }
    const u = s.update(this.sid, this.path, Date.now())
    this.last = u
    try {
      this.opts.onUpdate(u)
    } catch (err) {
      this.log(`sessions: onUpdate failed: ${messageOf(err)}`)
    }
  }
}

// Host mode: Docent is the viewer the mod expects, on 127.0.0.1 only. The routes, their checks and
// their answers mirror server.mjs where the contract matters; the snapshots come from the watcher's
// memory instead of the live folder being stat'ed each tick, so a stream is pushed as soon as a
// file changes.
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'

import {
  APP,
  BODY_MAX,
  INBOX_MAX,
  JSON_TYPE,
  KEY_HEADER,
  NEWEST_MAX_AGE_MS,
  PING_EVERY_MS,
  QUEUE_MAX,
  SESSIONS_MAX,
  SID_RE,
  STICKY_QUIET_MS,
  STREAM_BACKLOG_MAX,
  VERSION,
  isAction,
  isKey,
  isLocal,
  isRecord,
  messageOf,
  policyOf,
} from './protocol.ts'
import type { Press } from './protocol.ts'
import type { SnapshotEntry } from './snapshots.ts'

export type SnapshotSource = {
  get(sid: string): SnapshotEntry | undefined
  all(): SnapshotEntry[]
}

export type HostServerOptions = {
  key: Buffer
  /** the directory holding index.html, served at /; none: 404 */
  pageDir?: string
  snapshots: SnapshotSource
  /** POST /api/quit was answered and the port is free: a newer Pairwatch is replacing us */
  onQuit: () => void
  log?: (msg: string) => void
}

export type HostServer = {
  /** binds 127.0.0.1:<port> (0: any free one); resolves the port bound, rejects with the bind error (code EADDRINUSE when taken) */
  listen(port: number): Promise<number>
  listening(): boolean
  /** open pages: the event streams, plus Docent's own panel when it watches a session */
  clients(): number
  /** pages showing `sid` */
  watchingOf(sid: string): number
  setWatched(sid: string | undefined): void
  /** a press for the mod's next inbox poll, as /api/action queues it */
  queue(sid: string, press: Press): void
  /** the snapshots changed: the streams are brought up to date */
  refresh(): void
  /** frees the port and drops the streams; the inbox and the watched session stay for a later listen() */
  stopListening(): Promise<void>
  close(): Promise<void>
}

/** what a stream was last sent: nothing yet (null), the 'empty' event, or a snapshot's text */
const SENT_EMPTY: unique symbol = Symbol('empty')
type Client = { res: http.ServerResponse; sid: string; current: string; sent: string | null | typeof SENT_EMPTY }

/** one row of /api/sessions (sessionList in server.mjs) */
type SessionRow = { sid: string; mtimeMs: number; cwd: string; goal: string; at: number; ended: boolean }

function send(res: http.ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(body)
}

/** Errors say no more than their status. */
const fail = (res: http.ServerResponse, status: number): void =>
  send(res, status, JSON_TYPE, JSON.stringify({ ok: false, error: http.STATUS_CODES[status] ?? 'Error' }))

/** The request body as text; '' when it is too long or cut off before its end (it always settles). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(settle => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > BODY_MAX) {
        settle('')
        req.destroy()
      }
    })
    req.on('end', () => settle(body))
    req.on('error', () => settle(''))
    req.on('aborted', () => settle(''))
    req.on('close', () => settle('')) // after 'end' this changes nothing
  })
}

const isEnded = (entry: SnapshotEntry): boolean => entry.snapshot.ended === true

/** A session's row, tolerant of a file that is not quite the mod's. */
function rowOf(entry: SnapshotEntry): SessionRow {
  const snap: Record<string, unknown> = entry.snapshot
  return {
    sid: entry.sid,
    mtimeMs: entry.updatedAt,
    cwd: typeof snap.cwd === 'string' ? snap.cwd.slice(0, 500) : '',
    goal: typeof snap.goalText === 'string' ? snap.goalText.slice(0, 200) : '',
    at: typeof snap.at === 'number' ? snap.at : entry.updatedAt,
    ended: isEnded(entry),
  }
}

export function createHostServer(opts: HostServerOptions): HostServer {
  const { key, snapshots, log } = opts
  const clients = new Set<Client>()
  /** sid -> presses waiting for its mod, oldest first */
  const inbox = new Map<string, Press[]>()
  let watched: string | undefined
  let server: http.Server | undefined
  let ping: NodeJS.Timeout | undefined
  let page = { html: '', csp: '' }
  let closed = false

  const clientCount = (): number => clients.size + (watched === undefined ? 0 : 1)

  const watchingOf = (sid: string): number => {
    let count = watched === sid ? 1 : 0
    for (const client of clients) if (client.current === sid) count += 1
    return count
  }

  /** the snapshots, newest written first */
  const listing = (): SnapshotEntry[] => snapshots.all().sort((a, b) => b.updatedAt - a.updatedAt)

  /**
   * The newest session: the most recently written snapshot that is not ended and not older than
   * 12 hours; when there is none, the most recent of all ('' when there is no snapshot).
   */
  const newestSid = (now: number): string => {
    const list = listing()
    for (const entry of list) {
      if (now - entry.updatedAt > NEWEST_MAX_AGE_MS) break // newest first: the rest are older still
      if (!isEnded(entry)) return entry.sid
    }
    return list[0]?.sid ?? ''
  }

  /**
   * The session a page shows: the one it asked for by name; else the one it already shows, while
   * that goes on (not ended, updated in the last 10 minutes); else the newest.
   */
  const follow = (client: Client, now: number): string => {
    if (client.sid !== '') return client.sid
    if (client.current !== '') {
      const entry = snapshots.get(client.current)
      if (entry !== undefined && now - entry.updatedAt <= STICKY_QUIET_MS && !isEnded(entry)) return client.current
    }
    return newestSid(now)
  }

  const sendEvent = (client: Client, event: string, text: string): void => {
    const { res } = client
    if (res.writableLength > STREAM_BACKLOG_MAX) {
      clients.delete(client)
      res.destroy()
      return
    }
    try {
      res.write(`event: ${event}\n${text.split('\n').map(line => `data: ${line}`).join('\n')}\n\n`)
    } catch {
      clients.delete(client)
    }
  }

  /** Brings a page up to date: the snapshot of the session it shows when that changed, or 'empty' when there is none. */
  const push = (client: Client, now: number): void => {
    client.current = follow(client, now)
    const entry = client.current === '' ? undefined : snapshots.get(client.current)
    if (entry === undefined) {
      if (client.sent !== SENT_EMPTY) {
        client.sent = SENT_EMPTY
        sendEvent(client, 'empty', '{}')
      }
      return
    }
    if (entry.text === client.sent) return
    client.sent = entry.text
    sendEvent(client, 'snapshot', entry.text)
  }

  const pushAll = (): void => {
    const now = Date.now()
    for (const client of clients) push(client, now)
  }

  const openStream = (res: http.ServerResponse, url: URL): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write('retry: 1500\n\n')
    const asked = url.searchParams.get('sid') ?? ''
    const client: Client = { res, sid: SID_RE.test(asked) ? asked : '', current: '', sent: null }
    clients.add(client)
    // the response never ends, so its 'close' is the page going away
    const drop = (): void => {
      clients.delete(client)
    }
    res.on('close', drop)
    res.on('error', drop)
    push(client, Date.now()) // its first view at once
  }

  const sessionList = (): SessionRow[] => listing().slice(0, SESSIONS_MAX).map(rowOf)

  const queuePress = (sid: string, press: Press): void => {
    const queue = inbox.get(sid) ?? []
    queue.push(press)
    inbox.delete(sid) // set again below, so the map runs from the longest-waiting session to this one
    inbox.set(sid, queue.slice(-QUEUE_MAX))
    while (inbox.size > INBOX_MAX) {
      const oldest = inbox.keys().next()
      if (oldest.done) break
      inbox.delete(oldest.value)
    }
  }

  /** The page, read per request (an edited page shows on the next reload), with a policy that runs its own script only. */
  const pageNow = async (): Promise<{ html: string; csp: string } | undefined> => {
    if (opts.pageDir === undefined) return undefined
    let html: string
    try {
      html = await readFile(join(opts.pageDir, 'index.html'), 'utf8')
    } catch {
      return undefined
    }
    if (html !== page.html) page = { html, csp: policyOf(html) }
    return page
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      fail(res, 400)
      return
    }
    const path = url.pathname
    // DNS rebinding and cross-site requests: the Host must be this machine, and an Origin, when sent, too.
    if (!isLocal(req.headers.host) || (req.headers.origin !== undefined && !isLocal(req.headers.origin))) {
      fail(res, 403)
      return
    }
    if (path.startsWith('/api/') && !isKey(key, req.headers[KEY_HEADER] ?? url.searchParams.get('key'))) {
      fail(res, 403)
      return
    }
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const served = await pageNow()
      if (served === undefined) fail(res, 404)
      else send(res, 200, 'text/html; charset=utf-8', served.html, { 'content-security-policy': served.csp, 'referrer-policy': 'no-referrer' })
      return
    }
    if (path === '/health') {
      send(res, 200, JSON_TYPE, JSON.stringify({ ok: true, app: APP, version: VERSION, clients: clientCount() }))
      return
    }
    if (path === '/api/sessions') {
      send(res, 200, JSON_TYPE, JSON.stringify(sessionList()))
      return
    }
    if (path === '/api/state') {
      const asked = url.searchParams.get('sid') ?? ''
      const sid = SID_RE.test(asked) ? asked : newestSid(Date.now())
      const entry = sid === '' ? undefined : snapshots.get(sid)
      if (entry === undefined) send(res, 404, JSON_TYPE, '{"empty":true}')
      else send(res, 200, JSON_TYPE, entry.text)
      return
    }
    if (path === '/api/events') {
      openStream(res, url)
      return
    }
    if (path === '/api/action' && req.method === 'POST') {
      // JSON only: a page elsewhere cannot send it cross-site without a preflight this server never answers
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
        fail(res, 415)
        return
      }
      const body = await readBody(req)
      let msg: unknown
      try {
        msg = JSON.parse(body)
      } catch {
        fail(res, 400)
        return
      }
      if (!isRecord(msg) || !isAction(msg.action)) {
        fail(res, 400)
        return
      }
      const sid = typeof msg.sid === 'string' && SID_RE.test(msg.sid) ? msg.sid : newestSid(Date.now())
      if (sid === '') {
        fail(res, 400)
        return
      }
      queuePress(sid, { action: msg.action, value: typeof msg.value === 'string' ? msg.value.slice(0, 40) : undefined, at: Date.now() })
      send(res, 200, JSON_TYPE, '{"ok":true}')
      return
    }
    if (path === '/api/quit' && req.method === 'POST') {
      // a newer Pairwatch replaces this viewer: answer, free the port at once, then tell the owner
      log?.('pairwatch host: asked to quit')
      send(res, 200, JSON_TYPE, '{"ok":true}')
      void stopListening().then(() => opts.onQuit())
      return
    }
    if (path === '/api/inbox') {
      // the mod collects the presses for its session, and learns how many pages show it
      const sid = url.searchParams.get('sid') ?? ''
      const isSid = SID_RE.test(sid)
      const actions = isSid ? (inbox.get(sid) ?? []) : []
      if (isSid) inbox.delete(sid)
      send(res, 200, JSON_TYPE, JSON.stringify({ actions, clients: clientCount(), watching: isSid ? watchingOf(sid) : 0 }))
      return
    }
    fail(res, 404)
  }

  const pingAll = (): void => {
    // keeps the streams alive through proxies and port forwarding
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }
    pushAll() // a page following the newest session may have to move on by now
  }

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('the Pairwatch host is closed'))
        return
      }
      if (server !== undefined) {
        reject(new Error('the Pairwatch host already listens'))
        return
      }
      const s = http.createServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
          log?.(`pairwatch host: ${req.method ?? ''} ${req.url ?? ''}: ${messageOf(err)}`)
          if (!res.headersSent) fail(res, 500)
          else res.destroy()
        })
      })
      const onBindError = (err: Error): void => reject(err)
      s.once('error', onBindError)
      s.listen(port, '127.0.0.1', () => {
        s.off('error', onBindError)
        s.on('error', err => log?.(`pairwatch host: ${err.message}`))
        server = s
        ping = setInterval(pingAll, PING_EVERY_MS)
        ping.unref()
        const address = s.address()
        resolve(address !== null && typeof address === 'object' ? address.port : port)
      })
    })

  const stopListening = async (): Promise<void> => {
    const s = server
    if (s === undefined) return
    server = undefined
    if (ping !== undefined) clearInterval(ping)
    ping = undefined
    await new Promise<void>(resolve => {
      s.close(() => resolve()) // the port is free from here; the callback waits for the connections
      for (const client of clients) client.res.destroy()
      clients.clear()
      // an answer in flight (a quit's own) gets a moment to leave
      setTimeout(() => s.closeAllConnections(), 50)
    })
  }

  return {
    listen,
    listening: () => server !== undefined,
    clients: clientCount,
    watchingOf,
    setWatched: sid => {
      watched = sid
    },
    queue: queuePress,
    refresh: pushAll,
    stopListening,
    close: async () => {
      closed = true
      await stopListening()
    },
  }
}

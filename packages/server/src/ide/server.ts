// The loopback WebSocket server the CLI connects to, with the lock file that tells it where. One
// client at a time, authorized by the X-Claude-Code-Ide-Authorization upgrade header.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'

import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'

import { guardLockOnExit, ideLockDir, lockPath, removeLock, writeLock } from './lock.ts'
import { handleFrame } from './mcp.ts'
import type { McpOptions } from './mcp.ts'
import { ideTools, toWireSelection } from './tools.ts'
import type { IdeServer, IdeServerOptions } from './types.ts'

const AUTH_HEADER = 'x-claude-code-ide-authorization'
const PORT_ATTEMPTS = 50
/** 10000-65535, as the extension draws them */
const randomPort = (): number => Math.floor(Math.random() * 55536) + 10000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const asText = (data: RawData): string =>
  (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8')

const tryListen = (server: HttpServer, port: number): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false)
      else reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

/** binds the preferred port when it is free, else random ones; the real port is read back so port 0 works too */
async function bind(server: HttpServer, preferred: number | undefined): Promise<number> {
  const candidates = preferred === undefined ? [] : [preferred]
  for (let i = 0; i < PORT_ATTEMPTS; i++) candidates.push(randomPort())
  for (const port of candidates) {
    if (!(await tryListen(server, port))) continue
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the IDE server is not listening on a TCP port')
    return address.port
  }
  throw new Error('Failed to find an available port after multiple attempts')
}

const stopListening = (server: HttpServer): Promise<void> =>
  new Promise(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

/** a close handshake, with a short grace period for a peer that never answers it */
const closeSocket = (ws: WebSocket, code: number): Promise<void> =>
  new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timer = setTimeout(() => ws.terminate(), 1000)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.close(code)
  })

export async function startIdeServer(opts: IdeServerOptions): Promise<IdeServer> {
  const { host, log } = opts
  const ideName = opts.ideName ?? 'Docent'
  const authToken = randomUUID()
  const httpServer = createServer()
  const port = await bind(httpServer, opts.port)
  const file = lockPath(ideLockDir(opts.configDir), port)
  try {
    await writeLock(file, {
      pid: opts.pid ?? process.pid,
      workspaceFolders: host.workspaceFolders(),
      ideName,
      transport: 'ws',
      runningInWindows: process.platform === 'win32',
      authToken,
    })
  } catch (err) {
    await stopListening(httpServer)
    throw err
  }
  const releaseLock = guardLockOnExit(file)

  const mcp: McpOptions = { serverInfo: { name: ideName, version: opts.version ?? '0.0.1' }, tools: ideTools, host, log }
  const listeners = new Set<(connected: boolean) => void>()
  const emit = (connected: boolean): void => {
    for (const fn of listeners) {
      try {
        fn(connected)
      } catch (err) {
        log?.(`onConnection listener failed: ${messageOf(err)}`)
      }
    }
  }
  let client: WebSocket | undefined
  let closed = false

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('error', err => log?.(`ide server error: ${err.message}`))
  wss.on('connection', (ws, req) => {
    // first thing, for every socket: ws keeps parsing a peer's frames until the close handshake ends,
    // and a protocol violation then emits 'error', which is a fatal uncaught exception without a listener
    ws.on('error', err => log?.(`ide client error: ${err.message}`))
    if (closed) {
      ws.close(1001)
      return
    }
    if (req.headers[AUTH_HEADER] !== authToken) {
      log?.('rejected a client with a bad authorization token')
      ws.close(1008, 'Unauthorized')
      return
    }
    const previous = client
    client = ws
    if (previous !== undefined) {
      log?.('a new client replaces the previous one')
      void closeSocket(previous, 1000)
    }
    ws.on('message', data => {
      handleFrame(asText(data), mcp)
        .then(reply => {
          if (reply !== undefined && ws.readyState === WebSocket.OPEN) ws.send(reply)
        })
        .catch((err: unknown) => log?.(`ide frame failed: ${messageOf(err)}`))
    })
    ws.on('close', () => {
      if (client !== ws) return
      client = undefined
      emit(false)
    })
    emit(true)
  })

  const notify = (method: string, params: unknown): void => {
    // nobody connected: dropped, not queued; a client asks for what it needs once it connects
    if (client === undefined || client.readyState !== WebSocket.OPEN) return
    client.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  const shutdown = async (): Promise<void> => {
    closed = true
    const ws = client
    client = undefined
    if (ws !== undefined) {
      await closeSocket(ws, 1000)
      emit(false)
    }
    // rejected or replaced peers still mid-handshake would otherwise hold server.close() open: the
    // http server waits for every upgraded socket, and closeAllConnections() does not track them
    for (const c of wss.clients) c.terminate()
    wss.close()
    await stopListening(httpServer)
    await removeLock(file)
    // only now: the app quits without awaiting close(), and the exit hook covers the lock until then
    releaseLock()
  }
  let closing: Promise<void> | undefined

  return {
    port,
    authToken,
    lockPath: file,
    get connected() {
      return client !== undefined
    },
    onConnection(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    notifySelectionChanged: sel => notify('selection_changed', toWireSelection(sel)),
    notifyAtMentioned: m => notify('at_mentioned', m),
    notifyDiagnosticsChanged: uris => notify('diagnostics_changed', { uris }),
    close: () => (closing ??= shutdown()),
  }
}

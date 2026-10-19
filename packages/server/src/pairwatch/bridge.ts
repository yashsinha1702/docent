// Bridge mode: a real viewer (server.mjs) holds the port, so Docent is one of its pages. One event
// stream for the watched session makes the viewer count Docent in `watching` (which lets the mod run
// model narration), and presses go to its /api/action. The viewer going away is noticed when the
// stream drops (or a press cannot connect) and /health then fails.
import http from 'node:http'

import type { PairwatchAction } from './index.ts'
import { JSON_TYPE, KEY_HEADER, errnoOf, probeViewer } from './protocol.ts'

export type BridgeOptions = {
  port: number
  key: string
  /** the viewer stopped answering: the owner decides what takes the port */
  onDown: () => void
  log?: (msg: string) => void
}

export type Bridge = {
  setWatched(sid: string | undefined): void
  press(sid: string, action: PairwatchAction, value?: string): Promise<void>
  close(): void
}

/** a dropped stream is opened again after these, while the viewer still answers /health */
const RECONNECT_MS = [500, 1000, 2000, 5000]

function post(port: number, key: string, body: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/action',
        agent: false,
        headers: { [KEY_HEADER]: key, 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(data) },
      },
      res => {
        res.resume()
        res.on('end', () => {
          if (res.statusCode === 200) resolve()
          else reject(new Error(`the Pairwatch viewer answered ${res.statusCode ?? '?'} to /api/action`))
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

export function createBridge(opts: BridgeOptions): Bridge {
  const { port, key, log } = opts
  let watched: string | undefined
  let stream: http.ClientRequest | undefined
  let retry: NodeJS.Timeout | undefined
  let retries = 0
  let closed = false
  let down = false

  const stop = (): void => {
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
    const s = stream
    stream = undefined
    s?.destroy()
  }

  const goDown = (): void => {
    if (closed || down) return
    down = true
    stop()
    log?.(`pairwatch bridge: the viewer on port ${port} stopped answering`)
    opts.onDown()
  }

  const open = (sid: string): void => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/api/events?sid=${encodeURIComponent(sid)}&key=${encodeURIComponent(key)}`,
        agent: false,
        headers: { [KEY_HEADER]: key, accept: 'text/event-stream' },
      },
      res => {
        if (res.statusCode === 200) retries = 0
        else log?.(`pairwatch bridge: the viewer answered ${res.statusCode ?? '?'} to /api/events`)
        // the snapshots come from the live folder; the stream only keeps Docent counted as a page
        res.resume()
      },
    )
    req.on('error', () => undefined) // 'close' follows
    req.on('close', () => dropped(req))
    stream = req
  }

  /** The stream is gone: a viewer still answering /health is a hiccup (opened again, later); nothing answering is the end. */
  const dropped = (req: http.ClientRequest): void => {
    if (closed || down || stream !== req) return // replaced on purpose
    stream = undefined
    void probeViewer(port).then(found => {
      if (closed || down || stream !== undefined || watched === undefined) return
      if (found === undefined) {
        goDown()
        return
      }
      const delay = RECONNECT_MS[Math.min(retries, RECONNECT_MS.length - 1)] ?? 5000
      retries += 1
      retry = setTimeout(() => {
        retry = undefined
        if (!closed && !down && watched !== undefined && stream === undefined) open(watched)
      }, delay)
      retry.unref()
    })
  }

  return {
    setWatched: sid => {
      if (sid === watched) return
      watched = sid
      stop()
      retries = 0
      if (sid !== undefined && !closed && !down) open(sid)
    },
    press: async (sid, action, value) => {
      try {
        await post(port, key, value === undefined ? { sid, action } : { sid, action, value })
      } catch (err) {
        // a connection error, not a refusal: the viewer may be gone
        if (errnoOf(err) !== undefined && (await probeViewer(port)) === undefined) goDown()
        throw err
      }
    },
    close: () => {
      closed = true
      stop()
    },
  }
}

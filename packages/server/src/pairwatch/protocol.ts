// What Docent shares with Pairwatch's own viewer (vendor/pairwatch/pairwatch/viewer/server.mjs): the
// names and limits the mod relies on, the key file, the local-only request check, the page's policy
// and the /health probe. Kept apart so host.ts and bridge.ts agree with server.mjs where it matters.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

import type { PairwatchAction } from './index.ts'

/** what /health calls the viewer; the mod (VIEWER_APP in register.tsx) accepts no other */
export const APP = 'pairwatch'
/** /health reports it; the mod (VIEWER_VERSION) asks a viewer older than it expects to quit */
export const VERSION = 3
export const DEFAULT_PORT = 7979
/** the header that carries the key; ?key= in a link does the same */
export const KEY_HEADER = 'x-pairwatch-key'
export const JSON_TYPE = 'application/json'
export const SID_RE = /^[A-Za-z0-9_-]{1,80}$/
export const KEY_RE = /^[A-Za-z0-9_-]{20,}$/
export const ACTIONS: ReadonlySet<string> = new Set(['why', 'tip', 'known', 'pause', 'level'])
export const BODY_MAX = 10_000
/** presses kept per session, and sessions with presses waiting */
export const QUEUE_MAX = 20
export const INBOX_MAX = 100
export const SESSIONS_MAX = 50
export const PING_EVERY_MS = 15_000
/** a page that stops reading its stream is dropped once this much waits for it */
export const STREAM_BACKLOG_MAX = 4 * 1024 * 1024
/** a page following the newest session keeps the one it shows while that is updated this recently */
export const STICKY_QUIET_MS = 10 * 60 * 1000
/** an older snapshot is not "the newest session", unless nothing else exists */
export const NEWEST_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** how long a /health probe waits: the port may be held by something that never answers */
export const PROBE_TIMEOUT_MS = 800

/** a press waiting for the mod, as /api/action queues it (`value` is left out of the JSON when undefined) */
export type Press = { action: PairwatchAction; value?: string; at: number }

export const isAction = (value: unknown): value is PairwatchAction => typeof value === 'string' && ACTIONS.has(value)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** the `code` of a Node error (ENOENT, EADDRINUSE, ...), if any */
export const errnoOf = (err: unknown): string | undefined => (isRecord(err) && typeof err.code === 'string' ? err.code : undefined)

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------- the key

async function readKey(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * The key: made once, kept in a file only this user can read, the same across restarts. A valid one
 * already there (the mod may hold it, or a real viewer wrote it) is kept, as server.mjs loadKey does.
 */
export async function loadKey(file: string): Promise<string> {
  const kept = await readKey(file)
  if (kept !== undefined && KEY_RE.test(kept)) return kept
  const made = randomBytes(32).toString('base64url')
  if (kept === undefined) {
    try {
      // created only if absent: of two servers starting at once, both end up with the first one's key
      await writeFile(file, `${made}\n`, { mode: 0o600, flag: 'wx' })
      return made
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') throw err
    }
    for (let i = 0; i < 25; i += 1) {
      const theirs = await readKey(file)
      if (theirs !== undefined && KEY_RE.test(theirs)) return theirs
      await sleep(20) // the other server is writing it
    }
  }
  await writeFile(file, `${made}\n`, { mode: 0o600 })
  return made
}

/** Whether `value` (a header or query value) is the key, compared in constant time. */
export function isKey(key: Buffer, value: unknown): boolean {
  const given = Buffer.from(typeof value === 'string' ? value : '')
  return key.length > 0 && given.length === key.length && timingSafeEqual(given, key)
}

// ---------------------------------------------------------------- local only

/** Only names of this machine: a page that rebinds its own domain to 127.0.0.1 is turned away. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function hostOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return '?'
  }
}

/** Whether a Host or Origin header names this machine. */
export const isLocal = (value: unknown): boolean => LOCAL_HOSTS.has(hostOf(value))

// ---------------------------------------------------------------- the page

/** The page's content security policy: its own inline scripts by hash and nothing else (pageNow in server.mjs). */
export function policyOf(html: string): string {
  const hashes: string[] = []
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? '')) continue
    // the browser hashes the script as parsed: its line ends made LF
    hashes.push(`'sha256-${createHash('sha256').update((m[2] ?? '').replace(/\r\n?/g, '\n')).digest('base64')}'`)
  }
  return [
    "default-src 'none'",
    `script-src ${hashes.length > 0 ? hashes.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

// ---------------------------------------------------------------- the probe

export type ViewerHealth = { version: number; clients: number }

function healthOf(body: string): ViewerHealth | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.app !== APP) return undefined
  return { version: typeof parsed.version === 'number' ? parsed.version : 1, clients: typeof parsed.clients === 'number' ? parsed.clients : 0 }
}

/** GET /health on 127.0.0.1:<port>: the answer when a Pairwatch viewer (any version) holds the port, else undefined. */
export function probeViewer(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<ViewerHealth | undefined> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (body.length > BODY_MAX) res.destroy()
      })
      res.on('end', () => resolve(res.statusCode === 200 ? healthOf(body) : undefined))
      res.on('close', () => resolve(undefined)) // after 'end' this changes nothing
      res.on('error', () => resolve(undefined))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(undefined))
  })
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { pairwatchSettings, startPairwatchHost } from '../src/pairwatch/index.ts'
import type { PairwatchHost, PairwatchSession, Snapshot } from '../src/pairwatch/index.ts'

// Every host here runs on a temp data dir and port 0: never the real ~/.claude/pairwatch, never 7979.

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string }
type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Inbox = { actions: { action: string; value?: string; at: number }[]; clients: number; watching: number }

/** One request to a host on 127.0.0.1 (node:http, not fetch: a test sets the Host header). */
const request = (port: number, path: string, init: Init = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(init.body)
  })

const json = (reply: Reply): unknown => JSON.parse(reply.text)

/** An event stream held open; resolves once its first bytes arrived, and keeps collecting. */
const openStream = (port: number, path: string): Promise<{ text: () => string; close: () => void }> =>
  new Promise((resolve, reject) => {
    let text = ''
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        resolve({ text: () => text, close: () => req.destroy() })
      })
    })
    req.on('error', reject)
  })

const snapshotOf = (sid: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  v: 1,
  sid,
  cwd: '/tmp/repo',
  svg: '<svg/>',
  alt: 'Claude is idle',
  head: 'Idle',
  lesson: '',
  ask: '',
  goal: '',
  goalText: 'fix the tests',
  recent: '',
  note: '',
  station: 'idle',
  status: 'ok',
  isPaused: false,
  isAsking: false,
  hasLesson: false,
  level: 1,
  narrationSource: null,
  narrator: 'claude-haiku',
  at: Date.now(),
  ...extra,
})

type Started = { host: PairwatchHost; dataDir: string; key: string; port: number }

async function start(t: TestContext, extra: { dataDir?: string; port?: number; pageDir?: string } = {}): Promise<Started> {
  const dataDir = extra.dataDir ?? (await mkdtemp(join(tmpdir(), 'docent-pairwatch-')))
  const host = await startPairwatchHost({ dataDir, port: extra.port ?? 0, pageDir: extra.pageDir })
  t.after(async () => {
    await host.close()
    if (extra.dataDir === undefined) await rm(dataDir, { recursive: true, force: true })
  })
  const key = (await readFile(join(dataDir, 'viewer.token'), 'utf8')).trim()
  return { host, dataDir, key, port: host.status().port }
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

const collect = (host: PairwatchHost): { snapshots: PairwatchSession[]; removed: string[] } => {
  const snapshots: PairwatchSession[] = []
  const removed: string[] = []
  host.onSnapshot(s => snapshots.push(s))
  host.onRemoved(sid => removed.push(sid))
  return { snapshots, removed }
}

test('/health answers like the real viewer', async t => {
  const { host, port } = await start(t)
  assert.deepEqual(host.status(), { mode: 'host', port })
  const reply = await request(port, '/health')
  assert.equal(reply.status, 200)
  assert.equal(reply.headers['content-type'], 'application/json')
  assert.equal(reply.headers['cache-control'], 'no-store')
  assert.deepEqual(json(reply), { ok: true, app: 'pairwatch', version: 3, clients: 0 })
})

test('the key file is made 0600 and reused; one already there is kept', async t => {
  const { dataDir, key, host } = await start(t)
  assert.match(key, /^[A-Za-z0-9_-]{20,}$/)
  // Windows has no POSIX modes to check (the same guard as ide.spec.ts)
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dataDir, 'viewer.token'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(dataDir, 'live'))).mode & 0o777, 0o700)
  }
  await host.close()
  const again = await start(t, { dataDir })
  assert.equal(again.key, key)
  await again.host.close()
  // the mod, or a real viewer, may hold a key already: it stays the key
  const theirs = 'theirs-theirs-theirs-theirs'
  await writeFile(join(dataDir, 'viewer.token'), `${theirs}\n`)
  const third = await start(t, { dataDir })
  assert.equal(third.key, theirs)
  assert.equal((await request(third.port, '/api/inbox?sid=a', { headers: { 'x-pairwatch-key': theirs } })).status, 200)
  await third.host.close()
})

test('/api/* needs the key, and every request a local Host and Origin', async t => {
  const { port, key } = await start(t)
  const withKey = { 'x-pairwatch-key': key }
  const noKey = await request(port, '/api/inbox?sid=a')
  assert.equal(noKey.status, 403)
  assert.deepEqual(json(noKey), { ok: false, error: 'Forbidden' })
  assert.equal((await request(port, '/api/inbox?sid=a', { headers: { 'x-pairwatch-key': 'not-the-key-at-all-1234' } })).status, 403)
  assert.equal((await request(port, '/api/inbox?sid=a', { headers: { ...withKey, host: 'evil.example' } })).status, 403)
  assert.equal((await request(port, '/health', { headers: { host: 'evil.example:80' } })).status, 403)
  assert.equal((await request(port, '/api/inbox?sid=a', { headers: { ...withKey, origin: 'http://evil.example' } })).status, 403)
  assert.equal((await request(port, '/api/inbox?sid=a', { headers: { ...withKey, origin: 'http://localhost:1234' } })).status, 200)
  assert.equal((await request(port, '/api/inbox?sid=a', { headers: { ...withKey, host: 'localhost' } })).status, 200)
  assert.equal((await request(port, `/api/inbox?sid=a&key=${key}`)).status, 200)
  const missing = await request(port, '/nope', { headers: withKey })
  assert.equal(missing.status, 404)
  assert.deepEqual(json(missing), { ok: false, error: 'Not Found' })
})

test('press() queues for the inbox, which drains once', async t => {
  const { host, port, key } = await start(t)
  const headers = { 'x-pairwatch-key': key }
  const before = Date.now()
  await host.press('sid-one', 'tip')
  await host.press('sid-one', 'level', 'x'.repeat(50))
  const first = json(await request(port, '/api/inbox?sid=sid-one', { headers })) as Inbox
  assert.equal(first.clients, 0)
  assert.equal(first.watching, 0)
  assert.equal(first.actions.length, 2)
  const [tip, level] = first.actions
  assert.ok(tip !== undefined && level !== undefined)
  assert.deepEqual(Object.keys(tip), ['action', 'at']) // no value: left out, as the real viewer leaves it
  assert.equal(tip.action, 'tip')
  assert.ok(tip.at >= before && tip.at <= Date.now())
  assert.deepEqual([level.action, level.value], ['level', 'x'.repeat(40)])
  assert.deepEqual(json(await request(port, '/api/inbox?sid=sid-one', { headers })), { actions: [], clients: 0, watching: 0 })
  assert.deepEqual(json(await request(port, '/api/inbox?sid=sid-two', { headers })), { actions: [], clients: 0, watching: 0 })
  await assert.rejects(host.press('not a sid', 'tip'))
})

test('watching counts the watched session and the pages streaming it', async t => {
  const { host, port, key } = await start(t)
  const headers = { 'x-pairwatch-key': key }
  const inbox = async (sid: string): Promise<Inbox> => json(await request(port, `/api/inbox?sid=${sid}`, { headers })) as Inbox
  host.setWatched('sid-a')
  assert.equal((await inbox('sid-a')).watching, 1)
  assert.equal((await inbox('sid-b')).watching, 0)
  assert.deepEqual(json(await request(port, '/health')), { ok: true, app: 'pairwatch', version: 3, clients: 1 })
  // a page streaming sid-a counts too; it is told at once that the session has no snapshot yet
  const stream = await openStream(port, `/api/events?sid=sid-a&key=${key}`)
  assert.ok(stream.text().startsWith('retry: 1500\n\n'), stream.text())
  await waitFor(() => stream.text() === 'retry: 1500\n\nevent: empty\ndata: {}\n\n', 'the empty event')
  assert.equal((await inbox('sid-a')).watching, 2)
  assert.equal((await inbox('sid-a')).clients, 2)
  stream.close()
  await waitFor(async () => (await inbox('sid-a')).watching === 1, 'the page to be dropped')
  host.setWatched(undefined)
  assert.equal((await inbox('sid-a')).watching, 0)
  assert.equal((await inbox('sid-a')).clients, 0)
  assert.equal((await request(port, '/api/events?sid=sid-a')).status, 403)
})

test('a snapshot file written becomes a session, /api/state, a stream event and a row of /api/sessions', async t => {
  const { host, dataDir, port, key } = await start(t)
  const headers = { 'x-pairwatch-key': key }
  const seen = collect(host)
  const stream = await openStream(port, `/api/events?sid=sid-a&key=${key}`)
  const snap = snapshotOf('sid-a', { head: 'Reading the tests', station: 'read', status: 'running' })
  const text = JSON.stringify(snap)
  const file = join(dataDir, 'live', 'sid-a.json')
  await writeFile(file, text)
  await waitFor(() => seen.snapshots.length === 1, 'the snapshot event')
  const got = seen.snapshots[0]
  assert.ok(got !== undefined)
  assert.equal(got.sid, 'sid-a')
  assert.deepEqual(got.snapshot, snap)
  assert.equal(got.updatedAt, (await stat(file)).mtimeMs)
  assert.deepEqual(host.sessions(), [got])
  const state = await request(port, '/api/state?sid=sid-a', { headers })
  assert.equal(state.status, 200)
  assert.equal(state.headers['content-type'], 'application/json')
  assert.equal(state.text, text)
  const missing = await request(port, '/api/state?sid=sid-zzz', { headers })
  assert.equal(missing.status, 404)
  assert.equal(missing.text, '{"empty":true}')
  // no session named: the newest
  assert.equal((await request(port, '/api/state', { headers })).text, text)
  await waitFor(() => stream.text().endsWith(`event: snapshot\ndata: ${text}\n\n`), 'the stream event')
  stream.close()
  assert.deepEqual(json(await request(port, '/api/sessions', { headers })), [
    { sid: 'sid-a', mtimeMs: got.updatedAt, cwd: '/tmp/repo', goal: 'fix the tests', at: snap.at, ended: false },
  ])
  // a change is one more event, with the new text
  const ended = JSON.stringify({ ...snap, ended: true, at: snap.at + 1 })
  await writeFile(file, ended)
  await waitFor(() => seen.snapshots.length === 2, 'the second snapshot event')
  assert.equal(seen.snapshots[1]?.snapshot.ended, true)
  assert.equal((await request(port, '/api/state?sid=sid-a', { headers })).text, ended)
})

test('a half-written snapshot is skipped until the write completes; a stray file is ignored', async t => {
  const { host, dataDir } = await start(t)
  const seen = collect(host)
  const text = JSON.stringify(snapshotOf('sid-b'))
  const file = join(dataDir, 'live', 'sid-b.json')
  await writeFile(file, text.slice(0, Math.floor(text.length / 2)))
  await sleep(400)
  assert.equal(seen.snapshots.length, 0)
  assert.deepEqual(host.sessions(), [])
  await writeFile(file, text)
  await waitFor(() => seen.snapshots.length === 1, 'the completed snapshot')
  assert.equal(seen.snapshots[0]?.sid, 'sid-b')
  // a file whose sid is not its name, and a file that is not .json, are not snapshots
  await writeFile(join(dataDir, 'live', 'sid-c.json'), JSON.stringify(snapshotOf('someone-else')))
  await writeFile(join(dataDir, 'live', 'notes.txt'), text)
  await sleep(400)
  assert.equal(seen.snapshots.length, 1)
  assert.deepEqual(host.sessions().map(s => s.sid), ['sid-b'])
})

test('an unlinked snapshot file is removed', async t => {
  const { host, dataDir } = await start(t)
  const seen = collect(host)
  const file = join(dataDir, 'live', 'sid-d.json')
  await writeFile(file, JSON.stringify(snapshotOf('sid-d')))
  await waitFor(() => seen.snapshots.length === 1, 'the snapshot')
  await unlink(file)
  await waitFor(() => seen.removed.length === 1, 'the removal')
  assert.deepEqual(seen.removed, ['sid-d'])
  assert.deepEqual(host.sessions(), [])
})

test('snapshots present at start are listed, newest first by their own time', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-pairwatch-'))
  await mkdir(join(dataDir, 'live'), { recursive: true })
  await writeFile(join(dataDir, 'live', 'old.json'), JSON.stringify(snapshotOf('old', { at: 1000 })))
  await writeFile(join(dataDir, 'live', 'new.json'), JSON.stringify(snapshotOf('new', { at: 2000 })))
  await writeFile(join(dataDir, 'live', 'broken.json'), '{"sid":"broken"')
  const { host } = await start(t, { dataDir })
  assert.deepEqual(host.sessions().map(s => s.sid), ['new', 'old'])
  await host.close()
  await rm(dataDir, { recursive: true, force: true })
})

test('the page is served with a policy hashing its inline script; 404 without a page dir', async t => {
  const pageDir = await mkdtemp(join(tmpdir(), 'docent-pairwatch-page-'))
  t.after(() => rm(pageDir, { recursive: true, force: true }))
  const html = '<!doctype html><title>Pairwatch</title>\n<script>\r\nconsole.log(1)\r\n</script>\n<script src="x.js"></script>'
  await writeFile(join(pageDir, 'index.html'), html)
  const { port } = await start(t, { pageDir })
  const reply = await request(port, '/')
  assert.equal(reply.status, 200)
  assert.equal(reply.text, html)
  assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8')
  const hash = createHash('sha256').update('\nconsole.log(1)\n').digest('base64')
  assert.equal(
    reply.headers['content-security-policy'],
    `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
  )
  assert.equal(reply.headers['referrer-policy'], 'no-referrer')
  assert.equal((await request(port, '/index.html')).status, 200)
  const bare = await start(t)
  assert.equal((await request(bare.port, '/')).status, 404)
})

test('/api/action takes JSON presses only, for a named or the newest session', async t => {
  const { dataDir, port, key } = await start(t)
  const headers = { 'x-pairwatch-key': key, 'content-type': 'application/json' }
  const post = (body: string, h: Record<string, string> = headers): Promise<Reply> => request(port, '/api/action', { method: 'POST', headers: h, body })
  const inbox = async (sid: string): Promise<Inbox> => json(await request(port, `/api/inbox?sid=${sid}`, { headers })) as Inbox
  assert.equal((await post('{"action":"tip","sid":"s"}', { 'x-pairwatch-key': key, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('{"action":"tip","sid":"s"}', { 'x-pairwatch-key': key })).status, 415)
  assert.equal((await post('not json')).status, 400)
  assert.equal((await post('{"action":"dance","sid":"s"}')).status, 400)
  assert.equal((await post('{"action":"tip"}')).status, 400) // no session to take it: nothing is live
  assert.equal((await post('{"action":"tip","sid":"s"}')).status, 200)
  assert.equal((await post('{"action":"why","sid":"s"}', { ...headers, 'content-type': 'application/json; charset=utf-8' })).status, 200)
  assert.deepEqual((await inbox('s')).actions.map(a => a.action), ['tip', 'why'])
  // with a session live, a press that names none goes to the newest
  await writeFile(join(dataDir, 'live', 'live-1.json'), JSON.stringify(snapshotOf('live-1')))
  await waitFor(async () => (await request(port, '/api/state?sid=live-1', { headers })).status === 200, 'the snapshot')
  assert.equal((await post('{"action":"level","value":"2"}')).status, 200)
  assert.deepEqual((await inbox('live-1')).actions.map(a => [a.action, a.value]), [['level', '2']])
})

test('/api/quit frees the port and the host goes down', async t => {
  const { host, port, key } = await start(t)
  const modes: string[] = []
  host.onStatus(s => modes.push(s.mode))
  const reply = await request(port, '/api/quit', { method: 'POST', headers: { 'x-pairwatch-key': key, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(reply.status, 200)
  assert.equal(reply.text, '{"ok":true}')
  await waitFor(() => host.status().mode === 'down', 'the host to go down')
  await assert.rejects(request(port, '/health'))
  assert.equal(host.status().port, port)
  await assert.rejects(host.press('s', 'tip'))
  // nothing took the port: still down after the look a second later, and the port is not taken back
  await sleep(1800)
  assert.equal(host.status().mode, 'down')
  assert.match(host.status().note ?? '', /quit/)
  await assert.rejects(request(port, '/health'))
  assert.ok(modes.length >= 1 && modes.every(m => m === 'down'), modes.join(','))
})

test('bridge mode follows a viewer on the port and takes it over when the viewer goes', async t => {
  const a = await start(t) // stands in for the real viewer: it answers /health as one
  const b = await start(t, { dataDir: a.dataDir, port: a.port })
  assert.deepEqual(b.host.status(), { mode: 'bridge', port: a.port, note: `following the Pairwatch viewer on port ${a.port}` })
  const headers = { 'x-pairwatch-key': a.key }
  const inbox = async (sid: string): Promise<Inbox> => json(await request(a.port, `/api/inbox?sid=${sid}`, { headers })) as Inbox
  // the watched session is one event stream on the viewer, which counts it as a page showing that session
  b.host.setWatched('sid-w')
  await waitFor(async () => (await inbox('sid-w')).watching === 1, 'the viewer to count the bridge')
  assert.equal((await inbox('sid-x')).watching, 0)
  b.host.setWatched('sid-x')
  await waitFor(async () => (await inbox('sid-x')).watching === 1 && (await inbox('sid-w')).watching === 0, 'the stream to move')
  assert.equal((await inbox('sid-x')).clients, 1)
  // presses go to the viewer's /api/action
  await b.host.press('sid-x', 'level', '3')
  assert.deepEqual((await inbox('sid-x')).actions.map(p => [p.action, p.value]), [['level', '3']])
  await b.host.press('sid-x', 'why')
  assert.deepEqual((await inbox('sid-x')).actions.map(p => p.action), ['why'])
  // the viewer goes away: the bridge notices, binds the port and becomes the host
  const modes: string[] = []
  b.host.onStatus(s => modes.push(s.mode))
  await a.host.close()
  await waitFor(() => b.host.status().mode === 'host', 'the bridge to take the port')
  assert.deepEqual(b.host.status(), { mode: 'host', port: a.port })
  assert.equal(modes.at(-1), 'host')
  assert.deepEqual(json(await request(a.port, '/health')), { ok: true, app: 'pairwatch', version: 3, clients: 1 })
  assert.equal((await inbox('sid-x')).watching, 1) // now counted by its own host
  await b.host.press('sid-x', 'pause')
  assert.deepEqual((await inbox('sid-x')).actions.map(p => p.action), ['pause'])
  await b.host.close()
})

test('pairwatchSettings points the bundled mod at a port', () => {
  assert.equal(pairwatchSettings(7980), '{"pluginConfigs":{"pairwatch@inline":{"options":{"viewerPort":7980}}}}')
})

test('close() ends the listener and the watcher, and is idempotent', async t => {
  const { host, port } = await start(t)
  await host.close()
  await host.close()
  await assert.rejects(request(port, '/health'))
  assert.equal(host.status().mode, 'down')
})

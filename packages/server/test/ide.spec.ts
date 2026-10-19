import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import type { Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import WebSocket from 'ws'

import { startIdeServer } from '../src/ide/index.ts'
import type { IdeHost, IdeServer, IdeServerOptions, OpenDiffRequest, Selection } from '../src/ide/index.ts'
import { ideLockDir } from '../src/ide/lock.ts'

const TOOL_NAMES = [
  'openDiff',
  'getDiagnostics',
  'close_tab',
  'closeAllDiffTabs',
  'openFile',
  'getOpenEditors',
  'getWorkspaceFolders',
  'getCurrentSelection',
  'checkDocumentDirty',
  'saveDocument',
  'getLatestSelection',
  'executeCode',
]

const FOLDERS = ['/tmp/docent-ws/alpha', '/tmp/docent-ws/beta']
const OPEN_FILE = '/tmp/docent-ws/alpha/src/main.ts'
const SELECTION: Selection = {
  filePath: OPEN_FILE,
  text: 'const x = 1',
  selection: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 }, isEmpty: false },
}
const WIRE_SELECTION = { text: SELECTION.text, filePath: OPEN_FILE, fileUrl: `file://${OPEN_FILE}`, selection: SELECTION.selection }

const stubHost = (overrides: Partial<IdeHost> = {}): IdeHost => ({
  workspaceFolders: () => FOLDERS,
  openEditors: () => [{ path: OPEN_FILE, dirty: true, active: true }],
  currentSelection: () => undefined,
  latestSelection: () => undefined,
  isDirty: p => (p === OPEN_FILE ? true : undefined),
  openDiff: async () => ({ outcome: 'rejected' }),
  closeTab: async () => true,
  closeAllDiffTabs: async () => 2,
  openFile: async () => {},
  saveDocument: async () => true,
  ...overrides,
})

// never the real ~/.claude/ide: every server gets a fresh temp config dir
async function withServer(
  host: IdeHost,
  fn: (server: IdeServer, configDir: string) => Promise<void>,
  extra: Partial<IdeServerOptions> = {},
): Promise<void> {
  const configDir = await mkdtemp(path.join(tmpdir(), 'docent-ide-'))
  const server = await startIdeServer({ host, configDir, pid: 4242, ...extra })
  try {
    await fn(server, configDir)
  } finally {
    await server.close()
    await rm(configDir, { recursive: true, force: true })
  }
}

type Message = Record<string, any>
type Client = {
  request(method: string, params?: unknown): Promise<Message>
  notify(method: string, params?: unknown): void
  send(raw: string): void
  receive(pred: (m: Message) => boolean): Promise<Message>
  unread(): Message[]
  closed: Promise<{ code: number; reason: string }>
}

const url = (server: IdeServer): string => `ws://127.0.0.1:${server.port}`
const headers = (token: string) => ({ 'x-claude-code-ide-authorization': token })
const closeOf = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))

// a fake CLI: JSON-RPC over the ws package, with a small inbox so frames can be awaited in any order
function open(server: IdeServer, token = server.authToken): Promise<Client> {
  const ws = new WebSocket(url(server), { headers: headers(token) })
  const inbox: Message[] = []
  const waiting: { pred: (m: Message) => boolean; resolve: (m: Message) => void }[] = []
  let nextId = 1
  ws.on('message', data => {
    const msg = JSON.parse(data.toString()) as Message
    const i = waiting.findIndex(w => w.pred(msg))
    const waiter = i >= 0 ? waiting.splice(i, 1)[0] : undefined
    if (waiter === undefined) inbox.push(msg)
    else waiter.resolve(msg)
  })
  const receive = (pred: (m: Message) => boolean): Promise<Message> =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(pred)
      const found = i >= 0 ? inbox.splice(i, 1)[0] : undefined
      if (found !== undefined) {
        resolve(found)
        return
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 5000)
      waiting.push({
        pred,
        resolve: m => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  const client: Client = {
    request(method, params) {
      const id = nextId++
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return receive(m => m.id === id)
    },
    notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })),
    send: raw => ws.send(raw),
    receive,
    unread: () => [...inbox],
    closed: closeOf(ws),
  }
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client))
    ws.once('error', reject)
  })
}

const call = async (c: Client, name: string, args: unknown = {}): Promise<Message> =>
  (await c.request('tools/call', { name, arguments: args })).result

const textOf = (result: Message): string => result.content[0].text

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

test('the lock dir follows configDir, then $CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/from-env'
    assert.equal(ideLockDir('/tmp/explicit'), path.join('/tmp/explicit', 'ide'))
    assert.equal(ideLockDir(), path.join('/tmp/from-env', 'ide'))
    delete process.env.CLAUDE_CONFIG_DIR
    assert.equal(ideLockDir(), path.join(homedir(), '.claude', 'ide'))
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

test('a wrong or missing token is closed with 1008 and never counts as connected', async () => {
  await withServer(stubHost(), async server => {
    const seen: boolean[] = []
    server.onConnection(c => seen.push(c))
    const wrong = await closeOf(new WebSocket(url(server), { headers: headers('not-the-token') }))
    assert.deepEqual(wrong, { code: 1008, reason: 'Unauthorized' })
    const missing = await closeOf(new WebSocket(url(server)))
    assert.equal(missing.code, 1008)
    assert.equal(server.connected, false)
    assert.deepEqual(seen, [])
  })
})

test('initialize, ping and tools/list answer the MCP handshake', async () => {
  const logged: string[] = []
  await withServer(
    stubHost(),
    async server => {
      const seen: boolean[] = []
      server.onConnection(c => seen.push(c))
      const c = await open(server)
      assert.equal(server.connected, true)
      assert.deepEqual(seen, [true])

      const init = await c.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2.1.302' },
      })
      assert.deepEqual(init, {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Docent', version: '1.2.3' } },
      })
      const bare = await c.request('initialize', {})
      assert.equal(bare.result.protocolVersion, '2024-11-05')

      c.notify('notifications/initialized')
      c.notify('ide_connected', { pid: 777 })
      assert.deepEqual((await c.request('ping')).result, {})
      assert.deepEqual(c.unread(), [], 'notifications get no reply')
      assert.ok(logged.some(l => l.includes('ide_connected') && l.includes('777')))

      const { tools } = (await c.request('tools/list')).result
      assert.deepEqual(
        tools.map((t: Message) => t.name),
        TOOL_NAMES,
      )
      const byName = Object.fromEntries(tools.map((t: Message) => [t.name, t]))
      assert.deepEqual(byName.openFile.annotations, { readOnlyHint: true })
      assert.deepEqual(byName.openFile.inputSchema.required, ['filePath', 'startText', 'endText'])
      assert.equal(byName.openFile.inputSchema.properties.makeFrontmost.default, true)
      assert.equal(byName.openFile.inputSchema.additionalProperties, false)
      assert.equal(byName.openFile.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#')
      assert.equal('description' in byName.close_tab, false)
      // an empty shape is listed through the SDK's zod v4 wrapper and zod's toJSONSchema: $schema first, no additionalProperties
      const noArgs = '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}}'
      for (const name of ['closeAllDiffTabs', 'getOpenEditors', 'getWorkspaceFolders', 'getCurrentSelection', 'getLatestSelection']) {
        assert.equal(JSON.stringify(byName[name].inputSchema), noArgs, name)
      }
      assert.equal('required' in byName.getDiagnostics.inputSchema, false)
      assert.deepEqual(byName.openDiff.inputSchema.required, ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'])
      assert.match(byName.executeCode.description, /^Execute python code in the Jupyter kernel/)
    },
    { version: '1.2.3', log: m => logged.push(m) },
  )
})

test('the lock file names the port, carries the token and goes away on close', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'docent-ide-'))
  const server = await startIdeServer({ host: stubHost(), configDir, pid: 4242, ideName: 'Docent Test' })
  try {
    assert.equal(server.lockPath, path.join(configDir, 'ide', `${server.port}.lock`))
    assert.ok(server.port >= 10000 && server.port <= 65535)
    assert.match(server.authToken, /^[0-9a-f-]{36}$/)
    assert.deepEqual(JSON.parse(await readFile(server.lockPath, 'utf8')), {
      pid: 4242,
      workspaceFolders: FOLDERS,
      ideName: 'Docent Test',
      transport: 'ws',
      runningInWindows: false,
      authToken: server.authToken,
    })
    if (process.platform !== 'win32') {
      assert.equal((await stat(server.lockPath)).mode & 0o777, 0o600)
      assert.equal((await stat(path.join(configDir, 'ide'))).mode & 0o777, 0o700)
    }
    await server.close()
    await server.close()
    await assert.rejects(stat(server.lockPath), { code: 'ENOENT' })
    await assert.rejects(
      new Promise((_resolve, reject) => new WebSocket(url(server), { headers: headers(server.authToken) }).once('error', reject)),
    )
  } finally {
    await server.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a free preferred port is taken, a busy one is replaced', async () => {
  const wanted = await freePort()
  await withServer(
    stubHost(),
    async first => {
      assert.equal(first.port, wanted)
      await withServer(stubHost(), async second => assert.notEqual(second.port, wanted), { port: wanted })
    },
    { port: wanted },
  )
})

test('getWorkspaceFolders answers the host folders in the extension shape', async () => {
  await withServer(stubHost(), async server => {
    const c = await open(server)
    const result = await call(c, 'getWorkspaceFolders')
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(textOf(result)), {
      success: true,
      folders: FOLDERS.map((p, index) => ({ name: path.basename(p), uri: `file://${p}`, path: p, index })),
      rootPath: FOLDERS[0],
      workspaceFile: null,
    })
  })
})

test('openDiff relays the request and maps the three outcomes', async () => {
  const seen: OpenDiffRequest[] = []
  const outcomes = [{ outcome: 'saved', contents: 'abc' }, { outcome: 'rejected' }, { outcome: 'closed' }] as const
  let next = 0
  const host = stubHost({
    openDiff: async req => {
      seen.push(req)
      return outcomes[next++]!
    },
  })
  await withServer(host, async server => {
    const c = await open(server)
    const args = { old_file_path: '/p/a.ts', new_file_path: '/p/a.ts', new_file_contents: 'new', tab_name: '✻ [Claude Code] a.ts ⧉' }
    const saved = await call(c, 'openDiff', args)
    assert.deepEqual(saved, {
      content: [
        { type: 'text', text: 'FILE_SAVED' },
        { type: 'text', text: 'abc' },
      ],
    })
    assert.deepEqual(seen, [{ oldPath: '/p/a.ts', newPath: '/p/a.ts', newContents: 'new', tabName: args.tab_name }])
    const rejected = await call(c, 'openDiff', args)
    assert.deepEqual(rejected, {
      content: [
        { type: 'text', text: 'DIFF_REJECTED' },
        { type: 'text', text: args.tab_name },
      ],
    })
    const closed = await call(c, 'openDiff', args)
    // a tab closed without a decision is a rejection on the wire: the CLI's TAB_CLOSED would apply the proposal
    assert.deepEqual(closed, { content: [{ type: 'text', text: 'DIFF_REJECTED' }, { type: 'text', text: args.tab_name }] })
  })
})

test('protocol errors: unknown method, bad JSON, unknown tool, a throwing tool', async () => {
  const host = stubHost({
    openDiff: async () => {
      throw new Error('renderer went away')
    },
  })
  await withServer(host, async server => {
    const c = await open(server)
    const unknown = await c.request('resources/list')
    assert.equal(unknown.error.code, -32601)
    assert.equal(unknown.error.message, 'Method not found')
    assert.equal('result' in unknown, false)

    c.send('{not json')
    const parse = await c.receive(m => m.error?.code === -32700)
    assert.equal(parse.id, null)

    const missing = await call(c, 'nope')
    assert.deepEqual(missing, { content: [{ type: 'text', text: 'Tool nope not found' }], isError: true })

    const thrown = await call(c, 'openDiff', { old_file_path: 'a', new_file_path: 'a', new_file_contents: '', tab_name: 't' })
    assert.deepEqual(thrown, { content: [{ type: 'text', text: 'renderer went away' }], isError: true })

    const badArgs = await call(c, 'openDiff', {})
    assert.equal(badArgs.isError, true)
  })
})

test('notifications reach the client, and are dropped when nobody is connected', async () => {
  await withServer(stubHost(), async server => {
    server.notifySelectionChanged(SELECTION)
    const c = await open(server)
    await c.request('ping')
    assert.deepEqual(c.unread(), [], 'nothing was queued for the late client')

    server.notifySelectionChanged(SELECTION)
    const sel = await c.receive(m => m.method === 'selection_changed')
    assert.deepEqual(sel, { jsonrpc: '2.0', method: 'selection_changed', params: WIRE_SELECTION })
    assert.equal('id' in sel, false)

    server.notifyAtMentioned({ filePath: OPEN_FILE, lineStart: 2, lineEnd: 5 })
    const at = await c.receive(m => m.method === 'at_mentioned')
    assert.deepEqual(at.params, { filePath: OPEN_FILE, lineStart: 2, lineEnd: 5 })

    server.notifyDiagnosticsChanged([`file://${OPEN_FILE}`])
    const diag = await c.receive(m => m.method === 'diagnostics_changed')
    assert.deepEqual(diag.params, { uris: [`file://${OPEN_FILE}`] })
  })
})

test('a new authorized client replaces the previous one', async () => {
  await withServer(stubHost(), async server => {
    const states: boolean[] = []
    server.onConnection(c => states.push(c))
    const first = await open(server)
    const second = await open(server)
    assert.deepEqual(await first.closed, { code: 1000, reason: '' })
    assert.equal(server.connected, true)
    server.notifyDiagnosticsChanged([])
    assert.deepEqual((await second.receive(m => m.method === 'diagnostics_changed')).params, { uris: [] })
    assert.deepEqual(states, [true, true])

    const unsubscribe = server.onConnection(() => assert.fail('unsubscribed listeners stay quiet'))
    unsubscribe()
    await server.close()
    assert.equal(server.connected, false)
    assert.deepEqual(states, [true, true, false])
    assert.equal((await second.closed).code, 1000)
  })
})

test('selection and document tools answer in the extension words', async () => {
  const saves: string[] = []
  const host = stubHost({
    currentSelection: () => SELECTION,
    latestSelection: () => SELECTION,
    saveDocument: async p => {
      saves.push(p)
      return true
    },
  })
  await withServer(host, async server => {
    const c = await open(server)
    assert.deepEqual(JSON.parse(textOf(await call(c, 'getCurrentSelection'))), { success: true, ...WIRE_SELECTION })
    assert.deepEqual(JSON.parse(textOf(await call(c, 'getLatestSelection'))), WIRE_SELECTION)

    assert.deepEqual(JSON.parse(textOf(await call(c, 'checkDocumentDirty', { filePath: OPEN_FILE }))), {
      success: true,
      filePath: OPEN_FILE,
      isDirty: true,
      isUntitled: false,
    })
    // a relative path resolves against the first workspace folder
    assert.deepEqual(JSON.parse(textOf(await call(c, 'checkDocumentDirty', { filePath: 'src/main.ts' }))).filePath, OPEN_FILE)
    assert.deepEqual(JSON.parse(textOf(await call(c, 'checkDocumentDirty', { filePath: '/elsewhere.ts' }))), {
      success: false,
      message: 'Document not open: /elsewhere.ts',
    })
    assert.equal((await call(c, 'checkDocumentDirty', {})).isError, true)

    assert.deepEqual(JSON.parse(textOf(await call(c, 'saveDocument', { filePath: OPEN_FILE }))), {
      success: true,
      filePath: OPEN_FILE,
      saved: true,
      message: 'Document saved successfully',
    })
    assert.deepEqual(saves, [OPEN_FILE])
    assert.equal(JSON.parse(textOf(await call(c, 'saveDocument', { filePath: '/elsewhere.ts' }))).success, false)

    const editors = JSON.parse(textOf(await call(c, 'getOpenEditors')))
    assert.deepEqual(editors, {
      tabs: [
        {
          uri: `file://${OPEN_FILE}`,
          isActive: true,
          isPinned: false,
          isPreview: false,
          isDirty: true,
          label: 'main.ts',
          groupIndex: 0,
          viewColumn: 1,
          isGroupActive: true,
          fileName: OPEN_FILE,
          languageId: 'typescript',
          isUntitled: false,
          selection: { start: SELECTION.selection.start, end: SELECTION.selection.end, isReversed: false },
        },
      ],
    })
  })
})

test('the selection failures are the exact pretty-printed JSON', async () => {
  await withServer(stubHost(), async server => {
    const c = await open(server)
    assert.equal(textOf(await call(c, 'getCurrentSelection')), '{\n  "success": false,\n  "message": "No active editor found"\n}')
    assert.equal(textOf(await call(c, 'getLatestSelection')), '{\n  "success": false,\n  "message": "No selection available"\n}')
  })
})

test('tab, diagnostics and executeCode tools', async () => {
  const closedTabs: string[] = []
  const host = stubHost({
    closeTab: async name => {
      closedTabs.push(name)
      return false
    },
  })
  await withServer(host, async server => {
    const c = await open(server)
    assert.deepEqual(await call(c, 'close_tab', { tab_name: 'gone' }), { content: [{ type: 'text', text: 'TAB_CLOSED' }] })
    assert.deepEqual(closedTabs, ['gone'])
    assert.equal(textOf(await call(c, 'closeAllDiffTabs')), 'CLOSED_2_DIFF_TABS')
    assert.deepEqual(await call(c, 'getDiagnostics', { uri: `file://${OPEN_FILE}` }), { content: [{ type: 'text', text: '[]' }] })
    assert.deepEqual(await call(c, 'executeCode', { code: 'print(1)' }), {
      content: [{ type: 'text', text: 'executeCode is not supported in Docent' }],
      isError: true,
    })
  })
})

test('openFile opens through the host and reports what the extension would', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'docent-ide-files-'))
  const file = path.join(dir, 'notes.md')
  await writeFile(file, 'alpha\nbeta gamma\ndelta\n')
  const opened: string[] = []
  const host = stubHost({ workspaceFolders: () => [dir], openFile: async req => void opened.push(`${req.path}:${req.makeFrontmost}:${req.preview}`) })
  try {
    await withServer(host, async server => {
      const c = await open(server)
      assert.equal(textOf(await call(c, 'openFile', { filePath: file })), `Opened file: ${file}`)
      assert.equal(textOf(await call(c, 'openFile', { filePath: 'notes.md', startText: 'beta', endText: 'delta' })), 'Opened file and selected text from "beta" to "delta"')
      assert.equal(textOf(await call(c, 'openFile', { filePath: file, startText: 'beta' })), 'Opened file and selected text "beta"')
      assert.equal(textOf(await call(c, 'openFile', { filePath: file, startText: 'beta', endText: 'zzz' })), 'Opened file and positioned at "beta" (end text "zzz" not found)')
      assert.equal(textOf(await call(c, 'openFile', { filePath: file, startText: 'zzz' })), 'Opened file, but text "zzz" not found')
      const background = JSON.parse(textOf(await call(c, 'openFile', { filePath: file, makeFrontmost: false, preview: true })))
      assert.deepEqual(background, {
        success: true,
        filePath: file,
        fileUrl: `file://${file}`,
        message: `Opened file: ${file}`,
        languageId: 'markdown',
        lineCount: 4,
        isDirty: false,
        isUntitled: false,
        isClosed: false,
      })
      assert.deepEqual(opened, [`${file}:true:false`, `${file}:true:false`, `${file}:true:false`, `${file}:true:false`, `${file}:true:false`, `${file}:false:true`])
      const missing = await call(c, 'openFile', { filePath: path.join(dir, 'nope.md') })
      assert.deepEqual(missing, { content: [{ type: 'text', text: `File not found: ${path.join(dir, 'nope.md')}` }], isError: true })
      assert.equal(opened.length, 6, 'a missing file never reaches the host')
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- adversarial verification: each test below exposes a defect found in review ---

/** a peer that completes the WebSocket upgrade by hand, so it can misbehave: send a bad frame, or never answer a close frame */
const rawPeer = (server: IdeServer, token?: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const sock = connect(server.port, '127.0.0.1', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          (token === undefined ? '' : `x-claude-code-ide-authorization: ${token}\r\n`) +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    sock.once('data', () => resolve(sock))
    sock.once('error', reject)
  })

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('a rejected peer that sends a malformed frame does not crash the process', async () => {
  await withServer(stubHost(), async server => {
    let uncaught: Error | undefined
    const capture = (err: Error): void => {
      uncaught = err
    }
    process.on('uncaughtException', capture)
    try {
      // no token: the server answers 1008 and keeps parsing what the peer sends until the close handshake ends
      const peer = await rawPeer(server)
      // FIN + RSV1 set, text opcode, length 1, unmasked: a frame ws rejects with an 'error' event on the socket
      peer.write(Buffer.from([0xc1, 0x01, 0x41]))
      await sleep(300)
      peer.destroy()
      assert.equal(uncaught, undefined, `the rejected socket has no 'error' listener: ${uncaught?.message}`)
      assert.equal(server.connected, false)
    } finally {
      process.off('uncaughtException', capture)
    }
  })
})

test('close() does not wait for a replaced client that never answers its close frame', async () => {
  await withServer(stubHost(), async server => {
    const stale = await rawPeer(server, server.authToken)
    const fresh = await open(server)
    assert.equal(server.connected, true)
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      server.close().then(() => 'closed'),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('still closing after 3 s'), 3000)
      }),
    ])
    clearTimeout(timer)
    stale.destroy()
    assert.equal(outcome, 'closed', 'the replaced socket got close(1000) but nothing terminates it, so the http server waits for it (ws gives up after 30 s)')
    assert.equal((await fresh.closed).code, 1000)
    await assert.rejects(stat(server.lockPath), { code: 'ENOENT' })
  })
})

test('a process that exits while close() is still running leaves no lock behind', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'docent-ide-'))
  const entry = new URL('../src/ide/index.ts', import.meta.url).href
  const script = [
    `import { startIdeServer } from ${JSON.stringify(entry)}`,
    'const host = { workspaceFolders: () => [], openEditors: () => [], currentSelection: () => undefined, latestSelection: () => undefined,',
    '  isDirty: () => undefined, openDiff: async () => ({ outcome: "rejected" }), closeTab: async () => true, closeAllDiffTabs: async () => 0,',
    '  openFile: async () => {}, saveDocument: async () => true }',
    `const server = await startIdeServer({ host, configDir: ${JSON.stringify(configDir)} })`,
    'process.stdout.write(server.lockPath)',
    '// the app quits like this: close() is started but not awaited, and the process goes away underneath it',
    'void server.close()',
    'process.exit(0)',
  ].join('\n')
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const lock = child.stdout
    assert.equal(path.dirname(lock), path.join(configDir, 'ide'))
    await assert.rejects(stat(lock), { code: 'ENOENT' }, 'the lock outlived its process: close() drops the exit hook before the lock is removed')
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('a client that connects while close() is running is turned away', async () => {
  await withServer(stubHost(), async server => {
    const states: boolean[] = []
    server.onConnection(c => states.push(c))
    // a current client that never answers its close frame keeps shutdown in its grace period for a second
    const stale = await rawPeer(server, server.authToken)
    assert.equal(server.connected, true)
    const closing = server.close()
    const late = await open(server)
    assert.deepEqual(await late.closed, { code: 1001, reason: '' })
    await closing
    stale.destroy()
    assert.equal(server.connected, false)
    assert.deepEqual(states, [true, false])
    await assert.rejects(stat(server.lockPath), { code: 'ENOENT' })
  })
})

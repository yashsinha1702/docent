import { existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { PtyManager, Workspace, buildClaudeArgs, buildClaudeEnv, loginShellPath, resolveClaudeBinary } from '@docent/server'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'

import type { DirEntry, PtyEvent, PtySpawnRequest, PtySpawnResult, WorkspaceInfo } from '../shared/ipc'

// DOCENT_SMOKE=1 opens the window with a plain shell in place of claude and quits after a few seconds;
// DOCENT_SMOKE=claude does the same with the real claude. DOCENT_SMOKE_SHOT=<file.png> saves a capture first.
const SMOKE = process.env.DOCENT_SMOKE
const log = (...parts: unknown[]) => console.log(new Date().toISOString(), '[docent]', ...parts)

/** The bundled Pairwatch plugin directory: next to the app's resources when packaged, the submodule in development. */
function pairwatchDir(): string | undefined {
  const packaged = join(process.resourcesPath ?? '', 'pairwatch')
  const dev = resolve(app.getAppPath(), '..', '..', 'vendor', 'pairwatch', 'pairwatch')
  for (const dir of [packaged, dev]) if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir
  return undefined
}

const isDir = (p: string | undefined): p is string => !!p && existsSync(p) && statSync(p).isDirectory()

/** `docent <folder>`, else $DOCENT_WORKSPACE, else the current directory (the repo itself in development). */
function initialWorkspace(): string {
  const userArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'))
  const fromArgs = userArgs.map(a => resolve(a)).find(isDir)
  if (fromArgs) return fromArgs
  if (isDir(process.env.DOCENT_WORKSPACE)) return resolve(process.env.DOCENT_WORKSPACE)
  if (!app.isPackaged) return resolve(app.getAppPath(), '..', '..')
  return process.cwd() === '/' ? app.getPath('home') : process.cwd()
}

const shellPath = loginShellPath()
process.env.PATH = shellPath
const claudeBinary = resolveClaudeBinary(shellPath)
const ptys = new PtyManager()
let workspace = new Workspace(initialWorkspace())
let win: BrowserWindow | undefined

const info = (): WorkspaceInfo => ({ root: workspace.root, name: basename(workspace.root), claudeBinary, pairwatchDir: pairwatchDir() })

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Docent',
    backgroundColor: '#0b1120',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // renderer problems land in the main log, where `npm run dev` and the smoke launch can see them
  win.webContents.on('console-message', (_e, ...rest: unknown[]) => {
    const d = (typeof rest[0] === 'object' && rest[0] ? rest[0] : { level: rest[0], message: rest[1] }) as { level: unknown; message: unknown }
    if (d.level === 'error' || d.level === 3 || SMOKE) log(`renderer ${String(d.level)}: ${String(d.message)}`)
  })
  win.webContents.on('preload-error', (_e, path, err) => log(`preload error in ${path}: ${err.message}`))
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`renderer failed to load: ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`))
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    win = undefined
  })
}

const send = (e: PtyEvent) => win?.webContents.send('pty:event', e)

ipcMain.handle('workspace:get', (): WorkspaceInfo => info())
ipcMain.handle('workspace:choose', async (): Promise<WorkspaceInfo | undefined> => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  const picked = r.filePaths[0]
  if (r.canceled || !picked) return undefined
  workspace = new Workspace(picked)
  return info()
})
ipcMain.handle('workspace:list', (_e, path: string): Promise<DirEntry[]> => workspace.list(path))
ipcMain.handle('workspace:read', (_e, path: string): Promise<string> => workspace.read(path))
ipcMain.handle('workspace:write', (_e, path: string, text: string): Promise<void> => workspace.write(path, text))

ipcMain.handle('pty:spawn', (_e, req: PtySpawnRequest): PtySpawnResult => {
  const env = buildClaudeEnv(process.env, { path: shellPath })
  let file: string
  let args: string[]
  let sessionId: string | undefined
  if (req.kind === 'claude' && SMOKE !== '1') {
    if (!claudeBinary) throw new Error('claude was not found on PATH. Install Claude Code, or set CLAUDE_BIN.')
    const plan = buildClaudeArgs({ pluginDir: pairwatchDir(), resume: req.resume })
    file = claudeBinary
    args = plan.args
    sessionId = plan.sessionId
  } else {
    file = process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/zsh')
    args = process.platform === 'win32' ? [] : ['-l']
  }
  const h = ptys.spawn({ file, args, cwd: workspace.root, env, cols: req.cols, rows: req.rows })
  h.onData(data => send({ type: 'data', id: h.id, data }))
  h.onExit(exitCode => send({ type: 'exit', id: h.id, exitCode }))
  h.onOsc(ev => {
    if (ev.kind === 'title') send({ type: 'title', id: h.id, title: ev.title })
    else if (ev.kind === 'status') send({ type: 'status', id: h.id, raw: ev.raw })
  })
  log(`spawned ${req.kind} pid ${h.pid}: ${file} ${args.join(' ')}`)
  return { id: h.id, sessionId, command: [basename(file), ...args].join(' ') }
})
ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.get(id)?.write(data))
ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.get(id)?.resize(cols, rows))
ipcMain.on('pty:kill', (_e, id: string) => ptys.get(id)?.kill())

async function smoke(): Promise<void> {
  // prove the window, a pty, the IPC path and the renderer's own spawn, then quit
  const h = ptys.spawn({ file: process.env.SHELL ?? '/bin/zsh', args: ['-c', 'echo SMOKE_PTY_OK'], cwd: workspace.root, env: buildClaudeEnv(process.env, { path: shellPath }), cols: 80, rows: 24 })
  let out = ''
  h.onData(d => (out += d))
  h.onExit(code => log(`smoke pty exit ${code}: ${JSON.stringify(out.trim())}`))
  win?.webContents.once('did-finish-load', () => log('smoke: renderer loaded'))
  const wait = SMOKE === 'claude' ? 15000 : 6000
  await new Promise(r => setTimeout(r, wait))
  try {
    const probe = await win?.webContents.executeJavaScript(
      `JSON.stringify({ rows: document.querySelectorAll('.treelist .row').length, term: document.querySelector('.term-bar .muted')?.textContent, xtermRows: document.querySelectorAll('.xterm-rows > div').length })`,
    )
    log(`smoke: dom ${probe}`)
    const shot = process.env.DOCENT_SMOKE_SHOT
    if (shot && win) {
      const img = await win.webContents.capturePage()
      writeFileSync(shot, img.toPNG())
      log(`smoke: captured ${shot} (${img.getSize().width}x${img.getSize().height})`)
    }
  } catch (err) {
    log(`smoke: probe failed: ${String(err)}`)
  }
  log('smoke: done')
  await ptys.closeAll(500)
  app.exit(0)
}

app.whenReady().then(() => {
  log(`workspace ${workspace.root}; claude: ${claudeBinary ?? 'not found'}; pairwatch: ${pairwatchDir() ?? 'not found'}`)
  createWindow()
  if (SMOKE) void smoke()
})
app.on('window-all-closed', () => {
  void ptys.closeAll().then(() => app.quit())
})
app.on('before-quit', () => {
  void ptys.closeAll(500)
})

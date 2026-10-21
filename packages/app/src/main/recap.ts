// recap:export: the session in a terminal, rendered as one redacted HTML file and saved where the person says.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { renderRecapHtml } from '@docent/server'
import type { Snapshot } from '@docent/server'
import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, SaveDialogOptions } from 'electron'

import type { LiveSession } from '../shared/ipc'

export type RecapDeps = {
  win: () => BrowserWindow | undefined
  /** the live model of the claude session running in terminal `ptyId` */
  live: (ptyId: string) => LiveSession | undefined
  /** the Pairwatch mod's last snapshot for session `sid`, when the mod is running */
  snapshot: (sid: string) => Snapshot | undefined
  /** the workspace root: the recap shows paths relative to it and the root only as its folder name */
  cwd: () => string
  version: string
  log: (m: string) => void
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** docent-recap-2026-10-21-0f1e2d3c.html: the local date, then the first 8 characters of the session id. */
export function recapFileName(sid: string, at: number): string {
  const d = new Date(at)
  const id = sid.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) || 'session'
  return `docent-recap-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${id}.html`
}

function downloadsDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/** Registers the `recap:export` handler; it lives as long as the app, like the other IPC handlers. */
export function registerRecap(deps: RecapDeps): void {
  ipcMain.handle('recap:export', async (_e, ptyId: unknown): Promise<{ path: string } | undefined> => {
    const live = typeof ptyId === 'string' ? deps.live(ptyId) : undefined
    if (!live) return undefined
    const generatedAt = Date.now()
    const html = renderRecapHtml({ update: live, cwd: deps.cwd(), snapshot: deps.snapshot(live.sid), generatedAt, version: deps.version })
    const options: SaveDialogOptions = {
      title: 'Save the session recap',
      defaultPath: join(downloadsDir(), recapFileName(live.sid, generatedAt)),
      filters: [{ name: 'Web page', extensions: ['html'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }
    const win = deps.win()
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return undefined
    await writeFile(picked.filePath, html, 'utf8')
    deps.log(`recap: saved ${picked.filePath} (${Math.round(html.length / 1024)} KB, ${live.model.steps.length} steps)`)
    return { path: picked.filePath }
  })
}

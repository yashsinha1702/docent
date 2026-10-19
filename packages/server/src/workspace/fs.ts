// The workspace: a directory tree the editor shows, with every path jailed under the root.
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export type DirEntry = { name: string; path: string; kind: 'file' | 'dir'; size?: number; mtimeMs?: number }

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv', 'dist', 'out', '.next'])

export class Workspace {
  private rootReal: string | undefined

  constructor(readonly root: string) {}

  private async jail(rel: string): Promise<string> {
    this.rootReal ??= await realpath(this.root)
    const abs = resolve(this.root, rel)
    let real: string
    try {
      real = await realpath(abs)
    } catch {
      // a new file: jail its parent instead
      const parent = await realpath(resolve(abs, '..'))
      real = join(parent, abs.slice(abs.lastIndexOf(sep) + 1))
    }
    if (real !== this.rootReal && !real.startsWith(this.rootReal + sep)) throw new Error(`path escapes the workspace: ${rel}`)
    return real
  }

  async list(rel = '.'): Promise<DirEntry[]> {
    const dir = await this.jail(rel)
    const names = await readdir(dir, { withFileTypes: true })
    const out: DirEntry[] = []
    for (const d of names) {
      if (IGNORED.has(d.name)) continue
      const path = relative(this.root, join(dir, d.name)).split(sep).join('/')
      if (d.isDirectory()) out.push({ name: d.name, path, kind: 'dir' })
      else if (d.isFile()) {
        const s = await stat(join(dir, d.name)).catch(() => undefined)
        out.push({ name: d.name, path, kind: 'file', size: s?.size, mtimeMs: s?.mtimeMs })
      }
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    return out
  }

  async read(rel: string): Promise<string> {
    return readFile(await this.jail(rel), 'utf8')
  }

  async write(rel: string, text: string): Promise<void> {
    await writeFile(await this.jail(rel), text, 'utf8')
  }
}

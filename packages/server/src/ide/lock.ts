// The lock file the CLI discovers IDEs by: <config dir>/ide/<port>.lock, 0600 in a 0700 directory,
// JSON in the shape the VS Code extension writes (extension.js m71/b64/k64).
import { unlinkSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export type LockFile = {
  pid: number
  workspaceFolders: string[]
  ideName: string
  transport: 'ws'
  runningInWindows: boolean
  authToken: string
}

/** <configDir>/ide: the given dir, else $CLAUDE_CONFIG_DIR, else ~/.claude, which is where the CLI looks */
export function ideLockDir(configDir?: string): string {
  const base = configDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'))
  return path.join(base, 'ide')
}

export const lockPath = (dir: string, port: number): string => path.join(dir, `${port}.lock`)

export async function writeLock(file: string, lock: LockFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify(lock), { mode: 0o600 })
}

export async function removeLock(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** for the process 'exit' hook, where only synchronous work runs; failures are ignored */
export function removeLockSync(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // already gone, or nothing we can do while exiting
  }
}

// one 'exit' hook for every live lock: the app runs a server per terminal, and a listener per server
// would trip MaxListenersExceededWarning past ten of them
const liveLocks = new Set<string>()
let exitHooked = false

/** covers the lock until the returned release() is called, which must be after the lock is really gone */
export function guardLockOnExit(file: string): () => void {
  liveLocks.add(file)
  if (!exitHooked) {
    exitHooked = true
    process.once('exit', () => {
      for (const f of liveLocks) removeLockSync(f)
    })
  }
  return () => {
    liveLocks.delete(file)
  }
}

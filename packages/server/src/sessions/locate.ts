// Where Claude Code keeps a session: <configDir>/projects/<project dir>/<sid>.jsonl, the project dir
// being the cwd with its separators replaced. It is found by name across every project dir, never by
// encoding the cwd (how other characters are encoded is not known). Helpers (sub-agents) write
// <project dir>/<sid>/subagents/agent-<agentId>.jsonl.
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/
const HELPER_FILE_RE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/

/** The given dir, else $CLAUDE_CONFIG_DIR, else ~/.claude: where the CLI writes (as ide/lock.ts). */
export const claudeConfigDir = (configDir?: string): string => configDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))

/** <configDir>/projects/<any project dir>/<sid>.jsonl, found by name (never by encoding the cwd); undefined if not there yet. */
export async function findTranscript(sid: string, configDir?: string): Promise<string | undefined> {
  if (!SID_RE.test(sid)) return undefined
  const projects = join(claudeConfigDir(configDir), 'projects')
  let dirs: string[]
  try {
    dirs = (await readdir(projects, { withFileTypes: true })).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name)
  } catch {
    return undefined
  }
  const found = await Promise.all(
    dirs.map(async name => {
      const path = join(projects, name, `${sid}.jsonl`)
      try {
        const st = await stat(path)
        return st.isFile() ? { path, mtimeMs: st.mtimeMs } : undefined
      } catch {
        return undefined
      }
    }),
  )
  // one project dir in practice; the newest if a copy exists elsewhere
  let best: { path: string; mtimeMs: number } | undefined
  for (const f of found) if (f !== undefined && (best === undefined || f.mtimeMs > best.mtimeMs)) best = f
  return best?.path
}

/** <project dir>/<sid>/subagents for a transcript <project dir>/<sid>.jsonl. */
export const helpersDir = (transcript: string): string => join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents')

/** agent id -> file for the helper transcripts in `dir`; undefined while the dir does not exist. */
export async function listHelpers(dir: string): Promise<Map<string, string> | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const out = new Map<string, string>()
  for (const name of names.sort()) {
    const id = HELPER_FILE_RE.exec(name)?.[1]
    if (id !== undefined) out.set(id, join(dir, name))
  }
  return out
}

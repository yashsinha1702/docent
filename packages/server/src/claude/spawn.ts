// How Docent starts `claude`: the binary, the arguments and the environment.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export type ClaudeSpawnPlan = {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  sessionId: string
}

/** Env vars a nested session must not inherit from a parent Claude Code process. */
const INHERITED_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']

/**
 * A GUI app on macOS starts with a bare PATH (no nvm, no Homebrew). The user's login shell knows
 * the real one; ask it once. Falls back to the current PATH on any failure.
 */
export function loginShellPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() || process.env.PATH || ''
  } catch {
    return process.env.PATH ?? ''
  }
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The claude binary: $CLAUDE_BIN, then PATH (the login shell's), then the usual install spots. */
export function resolveClaudeBinary(path: string = loginShellPath()): string | undefined {
  const fromEnv = process.env.CLAUDE_BIN
  if (fromEnv && isExecutable(fromEnv)) return fromEnv
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (isExecutable(candidate)) return candidate
  }
  const home = homedir()
  const spots = process.platform === 'win32'
    ? [join(home, '.local', 'bin', 'claude.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe')]
    : [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return spots.find(isExecutable)
}

export function buildClaudeEnv(base: NodeJS.ProcessEnv, opts: { path?: string; ideName?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const k of INHERITED_MARKERS) delete env[k]
  env.PATH = opts.path ?? loginShellPath()
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = opts.ideName ?? 'docent'
  env.PAIRWATCH_HOST = 'docent'
  return env
}

/** Arguments for an interactive session that Docent can find again by its id. */
export function buildClaudeArgs(opts: { pluginDir?: string; resume?: string; sessionId?: string; settings?: object }): { args: string[]; sessionId: string } {
  const sessionId = opts.resume ?? opts.sessionId ?? randomUUID()
  const args: string[] = []
  if (opts.resume) args.push('--resume', opts.resume)
  else args.push('--session-id', sessionId)
  if (opts.pluginDir) args.push('--plugin-dir', opts.pluginDir)
  if (opts.settings) args.push('--settings', JSON.stringify(opts.settings))
  return { args, sessionId }
}

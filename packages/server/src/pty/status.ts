// Claude Code's Program Status Protocol (OSC 7501). At startup the CLI asks `ESC ] 7501 ; ? ST` and only
// reports its state if the terminal answers with an OSC 7501 whose payload starts with `?`. From then on
// it writes `ESC ] 7501 ; state=<s>:app=claude-code[:id=<task>][:kind=<k>][:progress=<0-100>][:title=<b64>][:msg=<b64>] ST`
// whenever the main session (id '') or a background task changes state, and `state=clear[:id=<task>]`
// when one goes away. Read from the 2.1.304 binary (GTr / kxe / PZo); title and msg are base64 UTF-8.

/** What Docent writes back to the probe so the CLI starts reporting. */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\'

import type { ProgramState, ProgramStatus } from './types.ts'

export type { ProgramState, ProgramStatus } from './types.ts'

const STATES = new Set<ProgramState>(['working', 'blocked', 'done', 'idle', 'error', 'clear'])

const fromBase64 = (s: string): string | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return undefined
  try {
    return Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/** The payload after `7501;` (no probe), or undefined when it is not a state report Docent understands. */
export function parseProgramStatus(payload: string, at: number): ProgramStatus | undefined {
  const fields = new Map<string, string>()
  for (const part of payload.split(':')) {
    const eq = part.indexOf('=')
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1))
  }
  const state = fields.get('state') as ProgramState | undefined
  if (!state || !STATES.has(state)) return undefined
  const status: ProgramStatus = { state, at }
  const id = fields.get('id')
  if (id !== undefined) status.id = id
  else if (state !== 'clear') status.id = ''
  const app = fields.get('app')
  if (app) status.app = app
  const kind = fields.get('kind')
  if (kind) status.kind = kind
  const progress = Number(fields.get('progress'))
  if (fields.has('progress') && Number.isFinite(progress)) status.progress = Math.min(100, Math.max(0, Math.round(progress)))
  const title = fields.has('title') ? fromBase64(fields.get('title') ?? '') : undefined
  if (title) status.title = title
  const msg = fields.has('msg') ? fromBase64(fields.get('msg') ?? '') : undefined
  if (msg) status.msg = msg
  return status
}

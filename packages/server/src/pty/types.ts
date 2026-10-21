// Pure types (the renderer imports this file through src/shared/ipc.ts, so no runtime imports here).

export type ProgramState = 'working' | 'blocked' | 'done' | 'idle' | 'error' | 'clear'

/** One OSC 7501 report from Claude Code (see status.ts). */
export type ProgramStatus = {
  state: ProgramState
  /** '' = the main session, else a background task's id; undefined only on a bare `state=clear` (everything clears) */
  id?: string
  app?: string
  /** why it is blocked: 'permission', 'question', 'auth', ... */
  kind?: string
  /** 0-100 */
  progress?: number
  title?: string
  msg?: string
  at: number
}

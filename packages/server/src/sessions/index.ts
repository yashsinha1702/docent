// The live session model, without the mod: Claude Code's transcript
// (<config dir>/projects/<project dir>/<sid>.jsonl, plus <sid>/subagents/agent-<id>.jsonl) is tailed and
// folded into Pairwatch's SessionModel with Pairwatch's own reducer (@docent/core timeline.reduce).
// It powers the steps strip, follow mode, file heat, the recap and the panel's fallback when the mod
// does not load. See docs/PLAN.md M10.
//
// API stub: the shapes are fixed here; the implementation lands in locate.ts / tail.ts / fold.ts / usage.ts / feed.ts.
import type { Level, SessionUpdate } from './types.ts'

export type { Level, SessionModel, SessionUpdate, SessionUsage, StepInput, TokenCounts } from './types.ts'

export type SessionFeedOptions = {
  sid: string
  /** the session's cwd: ReduceCtx.cwd, so paths display relative to it */
  cwd: string
  /** default $CLAUDE_CONFIG_DIR or ~/.claude */
  configDir?: string
  /** ReduceCtx.level (explanations' wording); default 1 */
  level?: Level
  /** how often queued rows are folded; default 400 ms (the mod's pump) */
  tickMs?: number
  /** called after every fold that changed model.rev or usage */
  onUpdate(u: SessionUpdate): void
  log?: (msg: string) => void
}

export type SessionFeed = {
  readonly sid: string
  /** undefined until the transcript appears */
  readonly transcript: string | undefined
  current(): SessionUpdate | undefined
  setLevel(level: Level): void
  /** stops watching and timers; idempotent */
  close(): Promise<void>
}

/** Starts following a session; resolves at once even if the transcript does not exist yet (it is looked for until it does). */
export async function startSessionFeed(_opts: SessionFeedOptions): Promise<SessionFeed> {
  throw new Error('not implemented')
}

/** <configDir>/projects/<any project dir>/<sid>.jsonl, found by name (never by encoding the cwd); undefined if not there yet. */
export async function findTranscript(_sid: string, _configDir?: string): Promise<string | undefined> {
  throw new Error('not implemented')
}

/** Pure: a whole transcript (main file text, plus sub-agent files' text by agent id) folded in one go. For tests, replay and recap of past sessions. */
export function foldTranscript(_main: string, _opts: { sid: string; cwd: string; level?: Level; subagents?: { [agentId: string]: string }; now?: number }): SessionUpdate {
  throw new Error('not implemented')
}

// The live session model, without the mod: Claude Code's transcript
// (<config dir>/projects/<project dir>/<sid>.jsonl, plus <sid>/subagents/agent-<id>.jsonl) is tailed and
// folded into Pairwatch's SessionModel with Pairwatch's own reducer (@docent/core timeline.reduce).
// It powers the steps strip, follow mode, file heat, the recap and the panel's fallback when the mod
// does not load. See docs/PLAN.md M10.
//
// locate.ts finds the files, tail.ts reads what was appended, fold.ts turns rows into the RawEvents the
// mod's hooks would have pushed (args.ts: the hooks' rules for arguments and results), usage.ts meters
// tokens, model.ts reduces, feed.ts runs it all on timers and a watcher.
export type { Level, SessionModel, SessionUpdate, SessionUsage, StepInput, TokenCounts } from './types.ts'
export type { SessionFeed, SessionFeedOptions } from './feed.ts'
export { startSessionFeed } from './feed.ts'
export { findTranscript } from './locate.ts'
export { foldTranscript, transcriptEvents } from './model.ts'

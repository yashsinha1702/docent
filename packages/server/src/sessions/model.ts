// The reducer's side: events queued by the fold go through @docent/core timeline.reduce in bounded
// batches (then settleHop, as the mod's pump does every tick) into a SessionModel, and out as the
// SessionUpdate the app gets. foldTranscript is the same pipeline over whole files, for tests, replay
// and recaps of past sessions.
import { timeline } from '@docent/core'
import type { Level, RawEvent, SessionModel } from '@docent/core'

import { TranscriptFold, atOf } from './fold.ts'
import type { SessionUpdate, StepInput } from './types.ts'

/** Events per reduce call: the bound on one synchronous slice of folding. */
export const FOLD_BATCH = 200

export class FoldedSession {
  readonly fold = new TranscriptFold()
  model: SessionModel
  level: Level
  private readonly cwd: string
  private queue: RawEvent[] = []
  private head = 0
  private isBlank = true
  /** file-tool ids whose tool-start has been folded: their inputs go once their step leaves the model */
  private readonly folded = new Set<string>()

  constructor(cwd: string, level: Level, now: number) {
    this.cwd = cwd
    this.level = level
    this.model = timeline.emptyModel(now)
  }

  get pending(): number {
    return this.queue.length - this.head
  }

  enqueue(events: readonly RawEvent[]): void {
    for (const e of events) this.queue.push(e)
  }

  /** One reduce call over up to `max` queued events. `now` is the reducer's clock; left out, the batch's last event time (a replay). */
  foldSome(max: number, now?: number): void {
    const end = Math.min(this.queue.length, this.head + max)
    if (end <= this.head) return
    const batch = this.queue.slice(this.head, end)
    this.head = end
    if (this.head === this.queue.length) {
      this.queue = []
      this.head = 0
    }
    const last = batch[batch.length - 1]!
    if (this.isBlank) {
      // the session starts at its first event, not when it was first read
      this.model = timeline.emptyModel(atOf(batch[0]!))
      this.isBlank = false
    }
    for (const e of batch) if (e.kind === 'tool-start' && this.fold.inputs.has(e.obs.id)) this.folded.add(e.obs.id)
    this.model = timeline.reduce(this.model, batch, { level: this.level, cwd: this.cwd, now: now ?? atOf(last) })
  }

  settle(now: number): void {
    this.model = timeline.settleHop(this.model, now)
  }

  /** The update for the app. Inputs of file steps the model no longer holds are dropped for good. */
  update(sid: string, transcript: string | undefined, now: number): SessionUpdate {
    const steps = new Set(this.model.steps.map(s => s.id))
    const inputs: { [stepId: string]: StepInput } = {}
    for (const id of this.folded) {
      const input = this.fold.inputs.get(id)
      if (steps.has(id) && input !== undefined) {
        inputs[id] = input
        continue
      }
      this.folded.delete(id)
      this.fold.inputs.delete(id)
    }
    return { sid, ...(transcript === undefined ? {} : { transcript }), model: this.model, inputs, usage: this.fold.usage.snapshot(), at: now }
  }
}

/** The events of a whole transcript (main file text, helpers' text by agent id), in the order they are folded. */
export function transcriptEvents(main: string, subagents: { [agentId: string]: string } = {}): RawEvent[] {
  const fold = new TranscriptFold()
  for (const [agentId, text] of Object.entries(subagents)) fold.addHelper(agentId, text.split('\n'))
  fold.addMain(main.split('\n'))
  return fold.take(true)
}

/**
 * Pure: a whole transcript (main file text, plus sub-agent files' text by agent id) folded in one go. For tests,
 * replay and recap of past sessions. Batches run on the events' own clock; the model is settled at `now`.
 */
export function foldTranscript(main: string, opts: { sid: string; cwd: string; level?: Level; subagents?: { [agentId: string]: string }; now?: number }): SessionUpdate {
  const now = opts.now ?? Date.now()
  const s = new FoldedSession(opts.cwd, opts.level ?? 1, now)
  // helpers first, as the live reader does: their rows wait in the fold until the main file's Agent call names them
  for (const [agentId, text] of Object.entries(opts.subagents ?? {})) s.fold.addHelper(agentId, text.split('\n'))
  s.fold.addMain(main.split('\n'))
  s.enqueue(s.fold.take(true))
  while (s.pending > 0) s.foldSome(FOLD_BATCH)
  s.settle(now)
  return s.update(opts.sid, undefined, now)
}

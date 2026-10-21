// What the live session feed hands the app. Pure types only: the renderer imports this file through
// src/shared/ipc.ts, so no runtime imports here.
import type { Level, SessionModel, Step } from '../../../../vendor/pairwatch/pairwatch/types/index.d.ts'

export type { Level, SessionModel, Step }

/** The parts of a file tool's input that Step does not carry (Step.scene has no line numbers). Keyed by tool_use id = Step.id. */
export type StepInput = {
  /** the path as the tool got it (usually absolute) */
  path?: string
  /** Read: first line, 1-based, when partial */
  offset?: number
  /** Read: number of lines, when partial */
  limit?: number
  /** Edit / MultiEdit, each string cut to 4000 chars */
  edits?: { old: string; new: string; all?: boolean }[]
  /** Write: the whole file was (re)written */
  isWrite?: boolean
}

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }

/** Token use from each assistant message's `usage` (the last row of a message id wins; `<synthetic>` skipped). */
export type SessionUsage = {
  total: TokenCounts
  /** since the latest human prompt */
  turn: TokenCounts
  byModel: { [model: string]: TokenCounts }
}

export type SessionUpdate = {
  sid: string
  /** the transcript file once it exists (Claude Code writes it at the first prompt) */
  transcript?: string
  model: SessionModel
  /** inputs of the file steps still in model.steps */
  inputs: { [stepId: string]: StepInput }
  usage: SessionUsage
  at: number
}

// The steps strip: the newest steps of the live model as rows, and where a click on one goes. Pure.
import { md, stations, timeline } from '@docent/core'
import type { SessionModel, Step, StepStatus } from '@docent/core'

import type { StepInput } from '../../../shared/ipc'
import { WHOLE_FILE_LINES } from '../editor/follow'
import type { LineTarget } from '../store'
import { isAbsolutePath, workspacePath } from '../tree/paths.ts'

export const STEPS_MAX = 12

export type StepRow = {
  id: string
  glyph: string
  headline: string
  /** the step's detail, or its result; a failure shows its result first */
  note: string
  status: StepStatus
  /** when it started: 'now', '12s', '3m', '2h' */
  when: string
  at: number
  /** the sub-agent it ran in ('Explore'), for a step outside the main lane */
  lane?: string
  /** what a click shows in the editor; undefined when the step names no file in the workspace */
  target?: LineTarget
}

// Wildcards: a glob or a regex ('/repo/src/*.ts', a Glob's '**'), which names many files or none, never one.
const WILDCARD = /[*?[\]{}]/

/**
 * The file a step's target names, when it is one: an absolute path inside the workspace, or, for a
 * read or an edit, a relative path. A search's pattern ('foo.ts', '/repo/src/*.ts') or a command is
 * never taken for a file. A read or an edit always names a file, brackets and all ('app/[id]/page.tsx').
 */
function targetPath(step: Step, root: string | undefined): string | undefined {
  const t = typeof step.target === 'string' ? step.target.trim() : ''
  if (t === '' || root === undefined) return undefined
  const isFileStep = step.station === 'read' || step.station === 'edit'
  // a command that starts with a path ('/repo/run.sh --fast') is not a file, nor is a pattern
  if (!isFileStep && (/\s/.test(t) || WILDCARD.test(t))) return undefined
  if (isAbsolutePath(t, root)) return workspacePath(t, root)
  return isFileStep && md.isPathLike(t) ? workspacePath(t, root) : undefined
}

const lineNumber = (x: unknown): number | undefined => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : undefined)

/** The first edit's new text worth finding: a blank one (a deletion leaves '\n') would mark the file's first line break, as follow mode knows. */
const editFind = (input: StepInput | undefined): string | undefined => {
  const edits: unknown = input?.edits
  if (!Array.isArray(edits)) return undefined
  for (const e of edits as { new?: unknown }[]) if (typeof e?.new === 'string' && e.new.trim() !== '') return e.new
  return undefined
}

/**
 * Where a click on a step goes: the file from the tool's input (else the step's target), shown as a
 * read wash over the lines read, an edit highlight around the first edit's new text, or a plain jump.
 * A Read with a limit and no offset read from line 1; one without a limit is washed over its first
 * WHOLE_FILE_LINES lines from where it started, as follow mode washes it.
 */
export function stepTarget(step: Step, input: StepInput | undefined, root: string | undefined): LineTarget | undefined {
  // the tool's own input names the file when it is there; the target only stands in for a missing one
  const given = typeof input?.path === 'string' && input.path.trim() !== ''
  const path = given ? workspacePath(input.path, root) : targetPath(step, root)
  if (path === undefined) return undefined
  switch (step.tool) {
    case 'Read': {
      const fromLine = lineNumber(input?.offset) ?? 1
      const lines = lineNumber(input?.limit) ?? WHOLE_FILE_LINES
      return { path, fromLine, toLine: fromLine + lines - 1, kind: 'read', focus: true }
    }
    case 'Edit':
    case 'MultiEdit': {
      const find = editFind(input)
      return find === undefined ? { path, kind: 'edit', focus: true } : { path, find, kind: 'edit', focus: true }
    }
    case 'Write':
      return { path, kind: 'edit', focus: true }
    default:
      return { path, kind: 'jump', focus: true }
  }
}

/** 'now' under 5 s, then '12s', '3m', '2h', '4d'. */
export function relTime(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return ''
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function noteOf(step: Step): string {
  const failed = step.status === 'error' || step.status === 'denied'
  const note = failed ? (step.resultNote ?? step.detail) : (step.detail ?? step.resultNote)
  return md.oneLine(note)
}

function laneOf(model: SessionModel, agentId: string | undefined): string | undefined {
  if (agentId === undefined) return undefined
  const lane = Array.isArray(model.agents) ? model.agents.find(a => a.id === agentId) : undefined
  return lane === undefined ? 'sub-agent' : md.oneLine(lane.type ?? lane.label) || 'sub-agent'
}

/**
 * The newest `max` steps, newest first. A '#think' gap still running off stage is left out, as the
 * stage's own trail does: it vanishes when the next tool starts within a moment.
 */
export function stepRows(live: { model: SessionModel; inputs: { [stepId: string]: StepInput } }, root: string | undefined, now: number, max = STEPS_MAX): StepRow[] {
  const model = live.model
  const steps = Array.isArray(model?.steps) ? model.steps : []
  const onStage = new Set(timeline.currentActivity(model)?.stepIds ?? [])
  const rows: StepRow[] = []
  for (let i = steps.length - 1; i >= 0 && rows.length < max; i--) {
    const s = steps[i]
    if (s == null || (s.tool === '#think' && s.status === 'running' && !onStage.has(s.id))) continue
    const lane = laneOf(model, s.agentId)
    const target = stepTarget(s, live.inputs?.[s.id], root)
    rows.push({
      id: s.id,
      glyph: stations.GLYPH[s.station] ?? '•',
      headline: md.oneLine(s.headline),
      note: noteOf(s),
      status: s.status,
      when: relTime(s.startedAt, now),
      at: s.startedAt,
      ...(lane === undefined ? {} : { lane }),
      ...(target === undefined ? {} : { target }),
    })
  }
  return rows
}

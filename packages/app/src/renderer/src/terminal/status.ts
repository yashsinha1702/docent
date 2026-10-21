// The terminal's status chip: Claude Code's OSC 7501 program status for one pty, folded and worded. Pure.
// Reports carry an id: '' is the main session, anything else a background task; `state=clear` removes
// the one it names, and a bare clear (no id) removes everything.
import type { ProgramState, ProgramStatus } from '../../../shared/ipc'

export type ProgramView = {
  main?: ProgramStatus
  /** background tasks by id, in the order they first reported */
  tasks: ReadonlyMap<string, ProgramStatus>
}

export const NO_PROGRAM: ProgramView = { tasks: new Map() }

/** The view after one report. */
export function applyProgram(v: ProgramView, s: ProgramStatus): ProgramView {
  if (s.state === 'clear') {
    if (s.id === undefined) return NO_PROGRAM
    if (s.id === '') return v.main === undefined ? v : { tasks: v.tasks }
    if (!v.tasks.has(s.id)) return v
    const tasks = new Map(v.tasks)
    tasks.delete(s.id)
    return v.main === undefined ? { tasks } : { main: v.main, tasks }
  }
  if (s.id === undefined || s.id === '') return { main: s, tasks: v.tasks }
  const tasks = new Map(v.tasks)
  tasks.set(s.id, s)
  return v.main === undefined ? { tasks } : { main: v.main, tasks }
}

export type ChipTone = Exclude<ProgramState, 'clear'>

export type Chip = {
  tone: ChipTone
  /** 'Working', 'Needs you', 'Done', 'Idle', 'Error' */
  label: string
  /** what follows the label: the blocking kind and the message, or the message ('' for none) */
  detail: string
  /** the whole report, for the tooltip */
  title: string
}

export type TaskChip = { count: number; tone: ChipTone; label: string; title: string }

export type ChipView = { main?: Chip; tasks?: TaskChip }

const LABEL: Readonly<Record<ChipTone, string>> = { working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Idle', error: 'Error' }

const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

type Reported = ProgramStatus & { state: ChipTone }

const isReported = (s: ProgramStatus): s is Reported => s.state !== 'clear'

function detailOf(s: ProgramStatus): string {
  const msg = oneLine(s.msg)
  const progress = s.state === 'working' && s.progress !== undefined ? `${s.progress}%` : ''
  const parts = s.state === 'blocked' ? [oneLine(s.kind), msg] : [msg, progress]
  return parts.filter(p => p !== '').join(' · ')
}

function chipOf(s: ProgramStatus): Chip | undefined {
  if (!isReported(s)) return undefined
  const detail = detailOf(s)
  const title = oneLine(s.title)
  return {
    tone: s.state,
    label: LABEL[s.state],
    detail,
    title: [`Claude: ${LABEL[s.state].toLowerCase()}${detail === '' ? '' : ` (${detail})`}`, title].filter(t => t !== '').join('\n'),
  }
}

/** What needs the person most comes first: a blocked task, a failed one, a running one, then the rest. */
const RANK: Readonly<Record<ChipTone, number>> = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 }

function taskChipOf(tasks: ReadonlyMap<string, ProgramStatus>): TaskChip | undefined {
  const list = [...tasks.values()].filter(isReported)
  if (list.length === 0) return undefined
  const tone = list.reduce<ChipTone>((best, t) => (RANK[t.state] < RANK[best] ? t.state : best), 'idle')
  const running = list.filter(t => t.state === 'working').length
  const waiting = list.filter(t => t.state === 'blocked').length
  const extra = waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : running > 0 && running < list.length ? ` · ${running} running` : ''
  const lines = list.map(t => {
    const d = detailOf(t)
    return `${oneLine(t.title) || t.id || 'task'}: ${LABEL[t.state].toLowerCase()}${d === '' ? '' : ` (${d})`}`
  })
  return { count: list.length, tone, label: `${list.length} task${list.length === 1 ? '' : 's'}${extra}`, title: `Background tasks\n${lines.join('\n')}` }
}

export function chipView(v: ProgramView): ChipView {
  const main = v.main === undefined ? undefined : chipOf(v.main)
  const tasks = taskChipOf(v.tasks)
  return { ...(main === undefined ? {} : { main }), ...(tasks === undefined ? {} : { tasks }) }
}

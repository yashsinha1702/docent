// The "This turn" block: the turn's and the session's counts, elapsed time and tokens. Pure, and
// tolerant of odd fields (null where an object belongs): the block then shows less, it never throws.
import { timeline, view } from '@docent/core'
import type { SessionModel } from '@docent/core'

import type { SessionUsage, TokenCounts } from '../../../shared/ipc'

export type Counts = { steps: number; files: number; edits: number; commands: number; errors: number }

/** The opening '#prompt' step's id carries the session's counts when the turn opened ('#prompt-…~s<steps>e<errors>', timeline.ts). */
const OPENING = /~s(\d+)e(\d+)$/

const isSynthetic = (tool: unknown): boolean => typeof tool === 'string' && tool.startsWith('#')

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/**
 * The running (or last) turn's counts, as the '#done' recap counts them: tool steps since the turn
 * began, sub-agents' included. Steps and errors stay exact past the model's 80-step window through the
 * opening prompt's snapshot; edits and commands are counted among the steps the model still holds.
 * Undefined before the first turn.
 */
export function turnCounts(m: SessionModel): Counts | undefined {
  const t = m?.turn
  if (t == null || typeof t.startedAt !== 'number') return undefined
  const since = t.startedAt
  const c: Counts = { steps: 0, files: 0, edits: 0, commands: 0, errors: 0 }
  let opening: string | undefined
  for (const s of Array.isArray(m.steps) ? m.steps : []) {
    if (s == null || s.startedAt < since) continue
    if (isSynthetic(s.tool)) {
      if (opening === undefined && s.tool === '#prompt' && s.agentId === undefined && OPENING.test(s.id)) opening = s.id
      continue
    }
    c.steps++
    if (s.station === 'edit') c.edits++
    if (s.tool === 'Bash') c.commands++
    if (s.status === 'error') c.errors++
  }
  const snap = opening === undefined ? null : OPENING.exec(opening)
  if (snap !== null) {
    c.steps = Math.max(c.steps, num(m.stats?.steps) - Number(snap[1]))
    c.errors = Math.max(c.errors, num(m.stats?.errors) - Number(snap[2]))
  }
  c.files = Array.isArray(m.files) ? m.files.filter(f => f != null && f.last >= since).length : 0
  return c
}

/** The whole session's counts (model.stats); files are the ones the model keeps, at most timeline.LIMITS.files. */
export function sessionCounts(m: SessionModel): Counts {
  const st = m?.stats
  return { steps: num(st?.steps), files: Array.isArray(m?.files) ? m.files.length : 0, edits: num(st?.edits), commands: num(st?.commands), errors: num(st?.errors) }
}

const plural = (n: number, word: string, more = false): string => `${n}${more ? '+' : ''} ${word}${n === 1 && !more ? '' : 's'}`

/** '7 steps · 2 files · 1 edit · 1 command · 0 errors'; a file count at the model's cap reads '40+ files'. */
export function countsText(c: Counts): string {
  const capped = c.files >= timeline.LIMITS.files
  return [plural(c.steps, 'step'), plural(c.files, 'file', capped), plural(c.edits, 'edit'), plural(c.commands, 'command'), plural(c.errors, 'error')].join(' · ')
}

const UNITS = ['k', 'M', 'B'] as const
const shortOf = (v: number): number => (v < 9.95 ? Number(v.toFixed(1)) : Math.round(v))

/** 980, 1.2k, 41k, 1M, 3.4M: one decimal under ten, none above; rounding never shows 1000k. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (Math.round(n) < 1000) return String(Math.round(n))
  let v = n / 1000
  let i = 0
  while (i < UNITS.length - 1 && shortOf(v) >= 1000) {
    v /= 1000
    i++
  }
  return `${shortOf(v)}${UNITS[i]}`
}

/** '41k in · 2.1k out · 120k cache read'; '' without counts */
export function tokensText(t: TokenCounts | null | undefined): string {
  if (t == null) return ''
  return `${compactNumber(t.input)} in · ${compactNumber(t.output)} out · ${compactNumber(t.cacheRead)} cache read`
}

/** The models that answered, most used first (by all their tokens). */
export function modelNames(usage: SessionUsage | null | undefined): string[] {
  const by = usage?.byModel ?? {}
  const used = (t: TokenCounts | null | undefined): number => (t == null ? 0 : num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite))
  return Object.keys(by)
    .filter(name => name.trim() !== '')
    .sort((a, b) => used(by[b]) - used(by[a]) || (a < b ? -1 : a > b ? 1 : 0))
}

export type TurnView = {
  /** undefined before the first prompt */
  turn?: { counts: string; elapsed: string; isRunning: boolean; tokens: string }
  session: { counts: string; tokens: string }
  models: string[]
}

/**
 * The turn's time. While it runs, by the clock: the model's own figure (view.elapsedText, which the stage
 * uses so that a redraw changes nothing) stops at the latest event, so five minutes into one long command
 * it would still say '40s so far'. Without a clock, or once the turn ended, the model's figure.
 */
export function turnElapsed(m: SessionModel, now?: number): string {
  const t = m?.turn
  if (t == null) return view.clockText(0)
  if (t.isRunning === true && typeof now === 'number' && Number.isFinite(now)) return view.clockText(now - t.startedAt)
  return view.elapsedText(m)
}

/** Everything the block shows; `now` (the panel's clock) makes a running turn's time tick. */
export function turnView(live: { model: SessionModel; usage?: SessionUsage | null }, now?: number): TurnView {
  const m = live.model
  const c = turnCounts(m)
  return {
    ...(c === undefined ? {} : { turn: { counts: countsText(c), elapsed: turnElapsed(m, now), isRunning: m.turn?.isRunning === true, tokens: tokensText(live.usage?.turn) } }),
    session: { counts: countsText(sessionCounts(m)), tokens: tokensText(live.usage?.total) },
    models: modelNames(live.usage),
  }
}

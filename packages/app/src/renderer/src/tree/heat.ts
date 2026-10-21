// File heat in the tree: which files Claude read or edited, and how lately (live.model.files). Pure.
// The model keeps each FileTouch's path as timeline.normalizePath made it: absolute under the session's
// cwd (the workspace root) on POSIX, as the tool spelled it on Windows; rows match through workspacePath,
// and under a Windows root without regard to case (pathKey).
import type { FileTouch } from '@docent/core'

import { foldsCase, pathKey, workspacePath } from './paths.ts'

/** Full strength this long after the last touch… */
export const HEAT_FULL_MS = 2 * 60_000
/** …fading to none at this age. */
export const HEAT_GONE_MS = 10 * 60_000

export type HeatKind = 'read' | 'edit'

export type Heat = { reads: number; edits: number; last: number; kind: HeatKind }

/** A directory's summary of the touched files under it. */
export type DirHeat = { files: number; last: number; kind: HeatKind }

export type HeatIndex = {
  /** by workspace-relative path (its pathKey); look a row up with rowHeat */
  files: ReadonlyMap<string, Heat>
  /** every ancestor directory of a touched file, by workspace-relative path (its pathKey) */
  dirs: ReadonlyMap<string, DirHeat>
  /** the newest touch, or undefined with none */
  latest?: number
  /** the keys are lower-cased: the root is Windows, where names compare without case */
  folded?: true
}

/** Edits win: a file read and then edited is an edited file. */
export const heatKind = (t: { edits: number }): HeatKind => (t.edits > 0 ? 'edit' : 'read')

const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)

/** model.files keyed the way tree rows are (two spellings of one file merge); touches outside the workspace are dropped. */
export function heatIndex(files: readonly FileTouch[] | undefined, root: string | undefined): HeatIndex {
  const byFile = new Map<string, Heat>()
  const dirs = new Map<string, DirHeat>()
  let latest: number | undefined
  for (const f of Array.isArray(files) ? files : []) {
    const found = workspacePath(f?.path, root)
    if (found === undefined || root === undefined || typeof f.last !== 'number' || !Number.isFinite(f.last)) continue
    const rel = pathKey(found, root)
    const was = byFile.get(rel)
    const reads = count(f.reads) + (was?.reads ?? 0)
    const edits = count(f.edits) + (was?.edits ?? 0)
    const heat: Heat = { reads, edits, last: Math.max(f.last, was?.last ?? Number.NEGATIVE_INFINITY), kind: heatKind({ edits }) }
    byFile.set(rel, heat)
    latest = latest === undefined ? heat.last : Math.max(latest, heat.last)
  }
  for (const [rel, h] of byFile) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const d = dirs.get(dir)
      dirs.set(dir, { files: (d?.files ?? 0) + 1, last: Math.max(h.last, d?.last ?? Number.NEGATIVE_INFINITY), kind: d?.kind === 'edit' || h.kind === 'edit' ? 'edit' : 'read' })
    }
  }
  const folded = root !== undefined && foldsCase(root)
  return { files: byFile, dirs, ...(latest === undefined ? {} : { latest }), ...(folded ? { folded: true as const } : {}) }
}

/** 1 within two minutes of the touch, then a straight fade to 0 at ten minutes. */
export function heatStrength(last: number, now: number): number {
  if (!Number.isFinite(last) || !Number.isFinite(now)) return 0
  const age = Math.max(0, now - last)
  if (age <= HEAT_FULL_MS) return 1
  if (age >= HEAT_GONE_MS) return 0
  return 1 - (age - HEAT_FULL_MS) / (HEAT_GONE_MS - HEAT_FULL_MS)
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** 'just now', '2 min ago', '3 h ago'. */
export function ageText(last: number, now: number): string {
  const min = Math.floor(Math.max(0, now - last) / 60_000)
  if (min < 1) return 'just now'
  return min < 120 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`
}

/** 'read 3 times, edited once, 2 min ago' */
export function heatTooltip(h: { reads: number; edits: number; last: number }, now: number): string {
  const parts: string[] = []
  if (h.reads > 0) parts.push(`read ${times(h.reads)}`)
  if (h.edits > 0) parts.push(`edited ${times(h.edits)}`)
  if (parts.length === 0) parts.push('touched')
  return `${parts.join(', ')}, ${ageText(h.last, now)}`
}

/** '2 files touched inside, the last 4 min ago' */
export function dirTooltip(d: DirHeat, now: number): string {
  return `${d.files === 1 ? '1 file' : `${d.files} files`} touched inside, the last ${ageText(d.last, now)}`
}

/** Reads blue, edits amber (the stage's read and run colours). */
export const HEAT_RGB: Readonly<Record<HeatKind, string>> = { read: '96, 165, 250', edit: '251, 191, 36' }

/** 0..1, to three places */
const unit = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000
const alpha = (x: number): string => String(unit(x))

export type HeatTint = { backgroundImage: string; boxShadow: string }

/** A row's tint at `strength` (0..1): a wash fading to the right and a bar on the left edge; undefined when cold. */
export function heatStyle(kind: HeatKind, strength: number): HeatTint | undefined {
  if (!(strength > 0)) return undefined
  const rgb = HEAT_RGB[kind]
  return {
    backgroundImage: `linear-gradient(90deg, rgba(${rgb}, ${alpha(0.26 * strength)}), rgba(${rgb}, ${alpha(0.06 * strength)}))`,
    boxShadow: `inset 2px 0 0 rgba(${rgb}, ${alpha(0.35 + 0.65 * strength)})`,
  }
}

/** The faintest a collapsed folder's dot gets: it fades with its files' age but stays while they are in the model. */
export const DOT_MIN_OPACITY = 0.4

/** What a tree row shows of the heat; every part is optional. */
export type RowHeat = {
  /** a touched file's tint, while it is warm */
  style?: HeatTint
  /** the tooltip line under the path, for any touch the model still holds */
  note?: string
  /** a collapsed folder with touched files inside */
  dot?: { kind: HeatKind; opacity: number }
}

/** A row's heat: a touched file's tint and tooltip; a collapsed folder's dot and tooltip (an open one shows its files instead). */
export function rowHeat(entry: { path: string; kind: 'file' | 'dir' }, open: boolean, ix: HeatIndex, now: number): RowHeat {
  const key = ix.folded === true ? entry.path.toLowerCase() : entry.path
  if (entry.kind === 'file') {
    const h = ix.files.get(key)
    if (h === undefined) return {}
    const style = heatStyle(h.kind, heatStrength(h.last, now))
    return { ...(style === undefined ? {} : { style }), note: heatTooltip(h, now) }
  }
  const d = open ? undefined : ix.dirs.get(key)
  if (d === undefined) return {}
  return { note: dirTooltip(d, now), dot: { kind: d.kind, opacity: unit(DOT_MIN_OPACITY + (1 - DOT_MIN_OPACITY) * heatStrength(d.last, now)) } }
}

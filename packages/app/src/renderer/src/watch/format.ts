// Small pure helpers for the panel's labels. `md` is @docent/core's text namespace (cut, oneLine…).
import { md } from '@docent/core'

import type { Snapshot } from '../../../../../server/src/pairwatch/types'
import type { WatchSession } from '../../../shared/ipc'

/**
 * A field that must stay text (the stage's SVG, the note): anything else, from a hand-edited or
 * foreign live/<sid>.json, reads as ''. snapshots.ts validates only `sid`, and an object handed to
 * React as a child throws and unmounts the whole window.
 */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The viewer's colour per station, for the now-card's edge. */
export const STATION_COLOR: Readonly<Record<Snapshot['station'], string>> = {
  think: '#a78bfa',
  plan: '#f472b6',
  search: '#38bdf8',
  read: '#60a5fa',
  edit: '#34d399',
  run: '#fbbf24',
  web: '#22d3ee',
  delegate: '#fb923c',
  tools: '#94a3b8',
  ask: '#f87171',
  talk: '#c084fc',
  done: '#4ade80',
  idle: '#64748b',
}

const COLORS: Readonly<Record<string, string>> = STATION_COLOR

/** A station's colour; anything unknown (an odd file) takes idle's. */
export function stationColor(station: unknown): string {
  return (typeof station === 'string' ? COLORS[station] : undefined) ?? STATION_COLOR.idle
}

const NARRATORS: Readonly<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

/** The narratorModel setting as a name: 'haiku' → 'Haiku'; a setting this table does not know is shown as written. */
export function narratorName(narrator: unknown): string {
  const key = md.oneLine(narrator)
  return key === '' ? 'Haiku' : (NARRATORS[key.toLowerCase()] ?? key)
}

export function narrationLabel(source: unknown): string {
  return source === 'model' ? 'model narration' : source === 'rules' ? 'rules narration' : 'no narration yet'
}

export type LevelChoice = { value: '1' | '2' | '3'; level: Snapshot['level']; name: string }

const BEGINNER: LevelChoice = { value: '1', level: 1, name: 'Beginner' }

export const LEVELS: readonly LevelChoice[] = [BEGINNER, { value: '2', level: 2, name: 'Intermediate' }, { value: '3', level: 3, name: 'Expert' }]

/** The snapshot's level as one of the three choices; anything the mod would not write reads as 1, as on the page. */
export function levelOf(level: unknown): LevelChoice {
  return LEVELS.find(l => l.level === level) ?? BEGINNER
}

export function levelName(level: unknown): string {
  return levelOf(level).name
}

/** A home folder as ~: /home/<name>, /Users/<name>, /root, C:\Users\<name>. */
export function tilde(path: unknown): string {
  return md
    .oneLine(path)
    .replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/root(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~')
}

/** The picker's line for a session: its folder, its goal, '(ended)'. */
export function sessionLabel(s: WatchSession): string {
  const folder = md.oneLine(s.snapshot.cwd).split(/[\\/]/).filter(p => p !== '').pop() ?? s.sid.slice(0, 8)
  const goal = md.cut(s.snapshot.goalText, 40)
  return `${folder}${goal === '' ? '' : ` · ${goal}`}${s.snapshot.ended === true ? ' (ended)' : ''}`
}

const STALE_MS = 2 * 60_000

/** 'last update 5 min ago' once a snapshot is older than two minutes; undefined while it is fresh. */
export function staleText(at: unknown, now: number): string | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const ms = now - at
  if (ms < STALE_MS) return undefined
  const min = Math.floor(ms / 60_000)
  return min < 120 ? `last update ${min} min ago` : `last update ${Math.floor(min / 60)} h ago`
}

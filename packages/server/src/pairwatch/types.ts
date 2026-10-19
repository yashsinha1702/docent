// The snapshot the Pairwatch mod writes to <data dir>/live/<sid>.json (`writeSnapshot` in
// vendor/pairwatch/pairwatch/hooks/register.tsx), plus `at` (write time) and `ended` (set once by
// `endSnapshot`). The text fields are the mod's mini-Markdown, which core/md.ts renders.
// Pure types only: the renderer imports this file through src/shared/ipc.ts.
import type { Level, Narration, Station, StepStatus } from '../../../../vendor/pairwatch/pairwatch/types/index.d.ts'

export type Snapshot = {
  v: number
  sid: string
  cwd: string
  /** the stage, as SVG source (core/stage.ts renderStage) */
  svg: string
  /** one-line text stand-in for the stage */
  alt: string
  /** the now-line and the narration */
  head: string
  lesson: string
  ask: string
  goal: string
  goalText: string
  recent: string
  note: string
  station: Station
  status: StepStatus
  isPaused: boolean
  isAsking: boolean
  hasLesson: boolean
  level: Level
  narrationSource: Narration['source'] | null
  /** the narratorModel setting, so a page can name the model that wrote the narration */
  narrator: string
  at: number
  ended?: boolean
}

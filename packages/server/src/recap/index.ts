// A session recap: one self-contained, redacted HTML file (stage, timeline of steps, files touched,
// concepts met, tokens) that can be shared without Docent. See docs/PLAN.md M14.
//
// API stub: the shape is fixed here; the implementation lands in render.ts.
import type { Snapshot } from '../pairwatch/types.ts'
import type { SessionUpdate } from '../sessions/types.ts'

export type RecapInput = {
  update: SessionUpdate
  /** the workspace root: paths are shown relative to it, and it is itself redacted to its folder name */
  cwd: string
  /** defaults to the session's first prompt, cut */
  title?: string
  /** the mod's last snapshot for this session, when there was one (its narration and stage are richer) */
  snapshot?: Snapshot
  generatedAt: number
  /** Docent's version, printed in the footer */
  version?: string
}

/** The recap as one HTML document: no scripts, no external requests, every free text passed through redactSecrets. */
export function renderRecapHtml(_input: RecapInput): string {
  throw new Error('not implemented')
}

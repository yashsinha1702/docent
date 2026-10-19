import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { Snapshot } from '../../../../../server/src/pairwatch/types'
import type { WatchAction } from '../../../shared/ipc'
import { enabledActions, mayUseShortcut, shortcutAction } from './actions.ts'
import { LEVELS, levelOf } from './format.ts'
import type { LevelChoice } from './format.ts'

type Feedback = { action: WatchAction; phase: 'sending' | 'sent' | 'failed'; message?: string }

type Props = {
  sid?: string
  snapshot?: Snapshot
  /** false while no viewer can deliver a press (Pairwatch is down) */
  canSend: boolean
  /** the panel's root: shortcuts also fire while the focus is inside it */
  panel: RefObject<HTMLElement | null>
}

const SENT_MS = 1500
const FAILED_MS = 4000

const feedbackText = (f: Feedback): string => (f.phase === 'sending' ? 'sending…' : f.phase === 'sent' ? 'sent' : `not sent: ${f.message ?? 'unknown error'}`)

/** Why? / Another tip / I know this / Pause and the level, each a press queued for the mod, with the keys w t k p. */
export function Controls({ sid, snapshot, canSend, panel }: Props) {
  const [feedback, setFeedback] = useState<Feedback>()
  const timer = useRef<number | undefined>(undefined)
  const enabled = enabledActions(snapshot, canSend && sid !== undefined)

  const press = useCallback(
    (action: WatchAction, value?: string) => {
      if (sid === undefined) return
      window.clearTimeout(timer.current)
      setFeedback({ action, phase: 'sending' })
      const settle = (f: Feedback, after: number) => {
        setFeedback(f)
        timer.current = window.setTimeout(() => setFeedback(undefined), after)
      }
      window.docent.watch.action(sid, action, value).then(
        () => settle({ action, phase: 'sent' }, SENT_MS),
        (err: unknown) => settle({ action, phase: 'failed', message: err instanceof Error ? err.message : String(err) }, FAILED_MS),
      )
    },
    [sid],
  )
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // one keydown listener for the panel's life; it reads the current buttons through a ref
  const latest = useRef({ enabled, press })
  useEffect(() => {
    latest.current = { enabled, press }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutAction(e)
      if (action === undefined || !mayUseShortcut(document.activeElement, document.body, panel.current)) return
      if (!latest.current.enabled[action]) return
      e.preventDefault()
      latest.current.press(action)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel])

  const flash = (action: WatchAction): string | undefined => (feedback?.action === action ? 'flash' : undefined)
  // the level as the page's select reads it: an odd value counts as 1, and re-picking the current one sends nothing
  const current = snapshot === undefined ? undefined : levelOf(snapshot.level)
  const chooseLevel = (l: LevelChoice) => {
    if (current?.level !== l.level) press('level', l.value)
  }

  return (
    <div className="watch-controls">
      <div className="watch-actions">
        <button className={flash('why')} disabled={!enabled.why} onClick={() => press('why')} title="Ask Claude itself what it is doing and why (w)" aria-keyshortcuts="w">
          {snapshot?.isAsking === true ? 'Asking…' : 'Why?'}
        </button>
        <button className={flash('tip')} disabled={!enabled.tip} onClick={() => press('tip')} title="Show another concept card (t)" aria-keyshortcuts="t">
          Another tip
        </button>
        <button className={flash('known')} disabled={!enabled.known} onClick={() => press('known')} title="Retire this card (k)" aria-keyshortcuts="k">
          I know this
        </button>
        <button className={flash('pause')} disabled={!enabled.pause} onClick={() => press('pause')} title="Pause or resume Pairwatch (p)" aria-keyshortcuts="p">
          {snapshot?.isPaused === true ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div className="watch-actions">
        <span className="muted">Level</span>
        <span className={`watch-level ${flash('level') ?? ''}`} role="group" aria-label="Your level">
          {LEVELS.map(l => (
            <button key={l.value} aria-pressed={current?.level === l.level} disabled={!enabled.level} onClick={() => chooseLevel(l)} title={`Level ${l.value}: ${l.name}`}>
              {l.name}
            </button>
          ))}
        </span>
        {feedback !== undefined && (
          <span className={`watch-sent ${feedback.phase}`} role="status">
            {feedbackText(feedback)}
          </span>
        )}
      </div>
    </div>
  )
}

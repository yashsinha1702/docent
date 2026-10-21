import { useEffect, useMemo, useRef, useState } from 'react'

import type { LiveSession } from '../../../shared/ipc'
import { tilde } from './format.ts'
import { turnView } from './stats.ts'

type Recap = { phase: 'saving' } | { phase: 'saved'; path: string } | { phase: 'none' } | { phase: 'failed'; message: string }

const SAVED_MS = 8000
const NONE_MS = 3000
const FAILED_MS = 6000

function recapText(r: Recap): string {
  switch (r.phase) {
    case 'saving':
      return 'saving…'
    case 'saved':
      return `saved to ${tilde(r.path)}`
    case 'none':
      return 'nothing saved'
    case 'failed':
      return `not saved: ${r.message}`
  }
}

/** The turn's and the session's counts, time and tokens, the models, and the recap export. `now` ticks a running turn's time. */
export function ThisTurn({ live, now }: { live: LiveSession; now: number }) {
  const v = useMemo(() => turnView(live, now), [live, now])
  const [recap, setRecap] = useState<Recap>()
  const timer = useRef<number | undefined>(undefined)
  // an export still running when the panel goes must not start a timer nothing clears
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
    }
  }, [])

  const ptyId = live.ptyId
  const exportRecap = () => {
    window.clearTimeout(timer.current)
    setRecap({ phase: 'saving' })
    const settle = (r: Recap, after: number) => {
      if (!mounted.current) return
      setRecap(r)
      timer.current = window.setTimeout(() => setRecap(undefined), after)
    }
    window.docent.recap.export(ptyId).then(
      saved => (saved === undefined ? settle({ phase: 'none' }, NONE_MS) : settle({ phase: 'saved', path: saved.path }, SAVED_MS)),
      (err: unknown) => settle({ phase: 'failed', message: err instanceof Error ? err.message : String(err) }, FAILED_MS),
    )
  }

  return (
    <section className="watch-turn" aria-label="This turn">
      <dl>
        <dt>This turn</dt>
        <dd>
          {v.turn === undefined ? (
            <span className="muted">no prompt yet</span>
          ) : (
            <>
              <span>
                {v.turn.counts} · {v.turn.elapsed}
                {v.turn.isRunning ? ' so far' : ''}
              </span>
              <span className="muted">{v.turn.tokens}</span>
            </>
          )}
        </dd>
        <dt>Session</dt>
        <dd>
          <span>{v.session.counts}</span>
          <span className="muted">{v.session.tokens}</span>
        </dd>
        {v.models.length > 0 && (
          <>
            <dt>{v.models.length === 1 ? 'Model' : 'Models'}</dt>
            <dd>{v.models.join(', ')}</dd>
          </>
        )}
      </dl>
      <div className="watch-actions">
        <button type="button" disabled={recap?.phase === 'saving'} onClick={exportRecap} title="Save this session as one redacted HTML file that opens anywhere">
          Export recap
        </button>
        {recap !== undefined && (
          <span className={`watch-sent ${recap.phase === 'failed' ? 'failed' : ''}`} role="status" title={recap.phase === 'saved' ? recap.path : undefined}>
            {recapText(recap)}
          </span>
        )}
      </div>
    </section>
  )
}

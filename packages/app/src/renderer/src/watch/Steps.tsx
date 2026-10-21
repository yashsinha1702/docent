import { useEffect, useMemo, useRef, useState } from 'react'

import type { StepStatus } from '@docent/core'

import type { LiveSession } from '../../../shared/ipc'
import { useStore } from '../store'
import type { LineTarget } from '../store'
import { stepRows } from './stepRows.ts'
import type { StepRow } from './stepRows.ts'

const PROBLEM_MS = 4000

const STATUS_WORD: Readonly<Record<StepStatus, string>> = { running: 'running', ok: 'done', error: 'failed', denied: 'refused' }

function rowTitle(r: StepRow): string {
  const lines = [`${r.headline}${r.note === '' ? '' : ` · ${r.note}`}`, `${STATUS_WORD[r.status]}, ${new Date(r.at).toLocaleTimeString()}${r.lane === undefined ? '' : `, in the sub-agent ${r.lane}`}`]
  if (r.target !== undefined) lines.push(`Click to show ${r.target.path} in the editor`)
  return lines.join('\n')
}

function Row({ row, onShow }: { row: StepRow; onShow: (t: LineTarget) => void }) {
  const body = (
    <>
      <span className="watch-step-glyph" aria-hidden="true">
        {row.glyph}
      </span>
      <span className="watch-step-text">
        <span className="watch-step-headline">{row.headline}</span>
        {row.note !== '' && <span className="watch-step-note">{row.note}</span>}
      </span>
      {row.lane !== undefined && <span className="watch-step-lane">⤷ {row.lane}</span>}
      <span className="watch-step-when">{row.when}</span>
    </>
  )
  const target = row.target
  return (
    <li className={`watch-step ${row.status}`}>
      {target !== undefined ? (
        <button type="button" className="watch-step-row" title={rowTitle(row)} onClick={() => onShow(target)}>
          {body}
        </button>
      ) : (
        <div className="watch-step-row" title={rowTitle(row)}>
          {body}
        </div>
      )}
    </li>
  )
}

/** The newest steps of the live model, newest first; a step with a file shows it in the editor on click. */
export function Steps({ live, root, now }: { live: LiveSession; root?: string; now: number }) {
  const rows = useMemo(() => stepRows(live, root, now), [live, root, now])
  const [problem, setProblem] = useState<string>()
  const timer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
    }
  }, [])

  const show = (t: LineTarget) => {
    useStore
      .getState()
      .showLines(t)
      .catch((err: unknown) => {
        if (!mounted.current) return
        window.clearTimeout(timer.current)
        setProblem(`could not open ${t.path}: ${err instanceof Error ? err.message : String(err)}`)
        timer.current = window.setTimeout(() => setProblem(undefined), PROBLEM_MS)
      })
  }

  if (rows.length === 0) return null
  return (
    <section className="watch-steps" aria-label="Recent steps">
      <div className="watch-section-head">
        <span className="watch-section-title">Steps</span>
        <span className="muted">newest first</span>
      </div>
      <ol className="watch-step-list">
        {rows.map(r => (
          <Row key={r.id} row={r} onShow={show} />
        ))}
      </ol>
      {problem !== undefined && (
        <div className="watch-problem muted" role="status">
          {problem}
        </div>
      )}
    </section>
  )
}

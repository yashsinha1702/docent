import { useEffect, useMemo, useRef } from 'react'

import type { LiveSession } from '../../../shared/ipc'
import { Stage } from './Stage'
import { advanceCard, cardMarkdown, fallbackView } from './transcript.ts'
import type { FallbackCard } from './transcript.ts'
import { renderMarkdown } from './markdown.ts'
import { useWatchStore } from './store.ts'

/**
 * The stage, the now-line, the card and the goal, drawn from the terminal session's live model when the
 * mod wrote no snapshot. Built with Pairwatch's own core, so it reads like the mod's panel with rules narration.
 */
export function FromTranscript({ live, root, now }: { live: LiveSession; root?: string; now: number }) {
  const level = useWatchStore(s => s.level)
  const stored = useWatchStore(s => s.card)
  const seen = useWatchStore(s => s.seen)
  const recent = useWatchStore(s => s.recent)
  const card = useMemo<FallbackCard>(() => (stored?.sid === live.sid ? stored : { sid: live.sid }), [stored, live.sid])

  // a new activity may bring a new card, and the card deepens while it stays up
  useEffect(() => {
    const next = advanceCard(card, live.model, { level, seen, recent, now })
    if (next !== card) useWatchStore.getState().putCard(next, now)
  }, [card, live.model, level, seen, recent, now])

  // the fresh key last drawn, as the mod keeps it: the same thing on stage is not introduced twice
  const drawn = useRef('')
  const v = useMemo(() => fallbackView(live.model, { level, now, root, drawnFresh: drawn.current }), [live.model, level, now, root])
  useEffect(() => {
    drawn.current = v.fresh
  }, [v.fresh])

  const html = useMemo(() => ({ head: renderMarkdown(v.head), goal: renderMarkdown(v.goal) }), [v.head, v.goal])
  const cardHtml = useMemo(() => renderMarkdown(cardMarkdown(card.lesson, level)), [card.lesson, level])
  return (
    <>
      <Stage svg={v.svg} alt={v.alt} />
      <div className="watch-card watch-now" dangerouslySetInnerHTML={{ __html: html.head }} />
      {cardHtml !== '' && <div className="watch-card watch-lesson" dangerouslySetInnerHTML={{ __html: cardHtml }} />}
      {html.goal !== '' && <div className="watch-context muted" dangerouslySetInnerHTML={{ __html: html.goal }} />}
    </>
  )
}

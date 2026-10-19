import { memo } from 'react'

/**
 * The mod's stage: its SVG document injected as is (the user's own mod wrote it) and scaled to the
 * column by CSS. Memoised, and React re-sets the markup only when the string changes, so the SVG's
 * animations start over for a new stage and not on every render.
 */
export const Stage = memo(function Stage({ svg, alt }: { svg: string; alt: string }) {
  return <div className="watch-stage" role="img" aria-label={alt} dangerouslySetInnerHTML={{ __html: svg }} />
})

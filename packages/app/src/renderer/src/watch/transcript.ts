// The panel without the mod: the stage, the now-line and a concept card drawn from the live model
// (the transcript folded by Pairwatch's reducer) with Pairwatch's own pure core. Pure.
//
// The card follows the mod's rules (register.tsx lessonForActivity / deepenLesson): a new activity
// on stage gets the best card among its steps' concepts, a card shown lately is not swapped in again,
// and the card deepens while it stays up. What the learner has met is kept in memory only (watch/store):
// the one lasting learning state is the mod's own.
import { conceptIds, concepts, lessons, narrate, stage, text, timeline, view } from '@docent/core'
import type { LessonState, Level, Prefs, SessionModel, Station, Step } from '@docent/core'

export type SeenMap = lessons.SeenMap

/** The fallback card of one session: the card on show, and the activity whose card was last chosen. */
export type FallbackCard = { sid: string; checked?: string; lesson?: LessonState }

export type CardCtx = {
  level: Level
  seen: SeenMap
  /** concept ids shown lately, newest last */
  recent: readonly string[]
  now: number
}

/** How many recently shown ids are kept (the mod's RECENT_MAX). */
export const RECENT_MAX = 12

/** Concept ids a run of steps teaches, as the mod lists them: newest step first, each step's most specific first, known to the knowledge base. */
export function lessonCandidates(steps: readonly Step[]): string[] {
  const out: string[] = []
  const have = new Set<string>()
  for (let i = steps.length - 1; i >= 0; i--) {
    const ids = steps[i]?.concepts
    if (!Array.isArray(ids)) continue
    for (const id of ids) {
      if (typeof id !== 'string' || have.has(id) || !conceptIds.isConceptId(id) || concepts.getConcept(id) === undefined) continue
      have.add(id)
      out.push(id)
    }
  }
  return out
}

const pickCtx = (ctx: CardCtx): lessons.PickCtx => ({ level: ctx.level, known: new Set<string>(), seen: ctx.seen, now: ctx.now, recent: ctx.recent })

const isStale = (id: string, ctx: CardCtx): boolean => ctx.recent.includes(id) || ctx.now - (ctx.seen[id]?.last ?? Number.NEGATIVE_INFINITY) < lessons.RECENT_MS

/** The card after the model or the clock moved; `card` itself when nothing changed. */
export function advanceCard(card: FallbackCard, model: SessionModel, ctx: CardCtx): FallbackCard {
  const act = timeline.currentActivity(model)
  let next = card
  if (act !== undefined && act.id !== card.checked) {
    next = { ...next, checked: act.id }
    const candidates = lessonCandidates(timeline.stepsOf(model, act))
    const id = candidates.length === 0 ? undefined : lessons.pickLesson(candidates, pickCtx(ctx))
    const shown = next.lesson
    if (id !== undefined && candidates.includes(id) && shown?.conceptId !== id && (shown === undefined || !isStale(id, ctx))) {
      next = { ...next, lesson: { conceptId: id, depth: 0, shownAt: ctx.now, activityId: act.id } }
    }
  }
  const l = next.lesson
  if (l !== undefined && l.depth < 2) {
    // depth only grows: measured from when the card went up, or from the activity's start if later
    const since = Math.max(l.shownAt, act?.startedAt ?? l.shownAt)
    const depth = lessons.depthFor(ctx.now - since)
    if (depth > l.depth) next = { ...next, lesson: { ...l, depth } }
  }
  return next
}

/** Another tip: a different card from the activity on stage, the recent steps, related and unseen cards (lessons.nextLesson). */
export function anotherCard(card: FallbackCard, model: SessionModel, ctx: CardCtx): FallbackCard | undefined {
  const act = timeline.currentActivity(model)
  const onStage = act === undefined ? [] : lessonCandidates(timeline.stepsOf(model, act))
  const candidates = [...new Set([...onStage, ...lessonCandidates(model.steps.slice(-30))])]
  const current = card.lesson?.conceptId
  const id = lessons.nextLesson(current, candidates, pickCtx(ctx))
  if (id === undefined || id === current || concepts.getConcept(id) === undefined) return undefined
  return { ...card, ...(act === undefined ? {} : { checked: act.id }), lesson: { conceptId: id, depth: 0, shownAt: ctx.now, ...(act === undefined ? {} : { activityId: act.id }) } }
}

/** The card as the mod's Markdown, in the level's wording; '' without one. */
export function cardMarkdown(lesson: LessonState | undefined, level: Level): string {
  if (lesson === undefined) return ''
  const c = concepts.getConcept(lesson.conceptId)
  return c === undefined ? '' : lessons.lessonMarkdown(c, lesson.depth, level)
}

export type FallbackView = {
  svg: string
  /** one line standing in for the stage */
  alt: string
  /** the now-line and the rules narration, as the mod's head reads */
  head: string
  /** '🎯 *Goal:* …' or '' */
  goal: string
  station: Station
  /** what is on stage (view.freshKey): its intro plays once */
  fresh: string
}

export const fallbackPrefs = (level: Level): Prefs => ({ level, isPaused: false, useModel: false, autoOpen: false })

/**
 * The stage and the text for the model at `now`, built the way the mod builds its own view (register.tsx
 * viewOf): rules narration, the mod's pane text, view.stageInput and stage.renderStage. `drawnFresh` is
 * the fresh key last drawn: the same thing on stage again is drawn without its intro, so a redraw for a
 * status change never replays the typing.
 */
export function fallbackView(model: SessionModel, opts: { level: Level; now: number; root?: string; drawnFresh?: string }): FallbackView {
  const prefs = fallbackPrefs(opts.level)
  const cwd = opts.root !== undefined && opts.root !== '' ? opts.root : undefined
  const act = timeline.currentActivity(model)
  const narration = act === undefined ? null : narrate.rulesNarration(model, act, opts.now)
  const t = text.paneText({ model, narration, lesson: null, prefs, ask: { status: 'idle' }, now: opts.now, ...(cwd === undefined ? {} : { cwd }) })
  let input = view.stageInput(model, prefs, opts.now, cwd)
  const fresh = view.freshKey(model)
  if (input.isFresh && fresh !== '' && fresh === opts.drawnFresh) input = { ...input, isFresh: false }
  return {
    svg: stage.renderStage(input),
    alt: text.statusLine(model, narration),
    head: [t.nowLine, t.narration].filter(s => s.trim() !== '').join('\n\n'),
    goal: t.goalLine,
    station: act?.station ?? 'idle',
    fresh,
  }
}

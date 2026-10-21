// The marks showLines leaves: a read washes whole lines blue for about 4 s, an edit marks the text it
// found (or its lines) amber for about 6 s. A StateField holds at most one mark of each kind, mapped
// through typing; a ViewPlugin removes each when its time is up. The fade is CSS (editor.css); the
// removal does not depend on it, so a mark that was hidden (a diff on top) still goes on time.
import type { Extension, Range, Text } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'

export type FlashKind = 'read' | 'edit'
/** `lines`: decorate whole lines from the line of `from` to the line of `to`; else the text between them. */
export type FlashMark = { kind: FlashKind; from: number; to: number; lines: boolean }

export const FLASH_MS: Readonly<Record<FlashKind, number>> = { read: 4000, edit: 6000 }

type Flash = { until: number; deco: DecorationSet }
export type Flashes = { read?: Flash; edit?: Flash }

const add = StateEffect.define<FlashMark & { until: number }>()
const expire = StateEffect.define<number>()

/** A mark that lasts FLASH_MS for its kind from `now`, replacing the previous mark of that kind. */
export const flashEffect = (m: FlashMark, now = Date.now()): StateEffect<FlashMark & { until: number }> => add.of({ ...m, until: now + FLASH_MS[m.kind] })
/** Drops the marks whose time is up at `now`. */
export const expireEffect = (now = Date.now()): StateEffect<number> => expire.of(now)

const lineClass: Readonly<Record<FlashKind, Decoration>> = {
  read: Decoration.line({ class: 'cm-flash-read' }),
  edit: Decoration.line({ class: 'cm-flash-edit-line' }),
}
const editText = Decoration.mark({ class: 'cm-flash-edit' })

/** The decorations of a mark over `doc`, its positions clamped to the document. */
export function flashRanges(doc: Text, m: FlashMark): Range<Decoration>[] {
  const from = Math.max(0, Math.min(m.from, m.to, doc.length))
  const to = Math.min(Math.max(m.from, m.to), doc.length)
  if (!m.lines && to > from) return [editText.range(from, to)]
  const out: Range<Decoration>[] = []
  const last = doc.lineAt(to).number
  for (let n = doc.lineAt(from).number; n <= last; n++) out.push(lineClass[m.kind].range(doc.line(n).from))
  return out
}

const KINDS: readonly FlashKind[] = ['read', 'edit']

export const flashField = StateField.define<Flashes>({
  create: () => ({}),
  update(value, tr) {
    let next = value
    if (tr.docChanged && (next.read || next.edit)) {
      next = {}
      for (const k of KINDS) {
        const f = value[k]
        if (f) next[k] = { until: f.until, deco: f.deco.map(tr.changes) }
      }
    }
    for (const e of tr.effects) {
      if (e.is(add)) next = { ...next, [e.value.kind]: { until: e.value.until, deco: Decoration.set(flashRanges(tr.state.doc, e.value), true) } }
      else if (e.is(expire) && KINDS.some(k => (next[k]?.until ?? Number.POSITIVE_INFINITY) <= e.value)) {
        const kept: Flashes = {}
        for (const k of KINDS) {
          const f = next[k]
          if (f && f.until > e.value) kept[k] = f
        }
        next = kept
      }
    }
    return next
  },
  provide: f => [EditorView.decorations.from(f, v => v.read?.deco ?? Decoration.none), EditorView.decorations.from(f, v => v.edit?.deco ?? Decoration.none)],
})

/** When the next mark is due to go, or undefined when there is none. */
export const nextExpiry = (f: Flashes): number | undefined => {
  const due = Math.min(f.read?.until ?? Number.POSITIVE_INFINITY, f.edit?.until ?? Number.POSITIVE_INFINITY)
  return Number.isFinite(due) ? due : undefined
}

const expiry = ViewPlugin.fromClass(
  class {
    view: EditorView
    timer: ReturnType<typeof setTimeout> | undefined = undefined

    constructor(view: EditorView) {
      this.view = view
      this.schedule(view.state.field(flashField))
    }

    update(u: ViewUpdate): void {
      const f = u.state.field(flashField)
      if (f !== u.startState.field(flashField)) this.schedule(f)
    }

    schedule(f: Flashes): void {
      clearTimeout(this.timer)
      this.timer = undefined
      const due = nextExpiry(f)
      if (due === undefined) return
      // expire at `due` itself: a timer that fires a little early still removes the mark it was set for
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.view.dispatch({ effects: expire.of(Math.max(Date.now(), due)) })
      }, Math.max(0, due - Date.now()))
    }

    destroy(): void {
      clearTimeout(this.timer)
    }
  },
)

/** The field and its timer: add to every file editor. */
export const flash: Extension = [flashField, expiry]

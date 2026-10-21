// Where showLines points in a file, and how a reload changes a document in place. Pure. Offsets count
// a line break as one character, as CodeMirror does: text with \r\n is measured with its \r removed,
// so the numbers can go straight into the editor.

export type Span = { from: number; to: number }

/** The text as CodeMirror holds it: every \r\n or lone \r becomes \n. */
export const lf = (text: string): string => (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text)

/** The 1-based line that offset `at` lies on. */
export const lineAt = (text: string, at: number): number => {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++
  return line
}

const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/**
 * Lines `fromLine`..`toLine` (1-based, inclusive, clamped to the text; `toLine` below `fromLine` counts as
 * `fromLine`): from the start of the first to the end of the last, its line break excluded.
 */
export const lineSpan = (text: string, fromLine: number, toLine = fromLine): Span => {
  const starts = lineStarts(text)
  const first = Math.min(starts.length, Math.max(1, Math.floor(fromLine)))
  const last = Math.min(starts.length, Math.max(first, Math.floor(toLine)))
  const from = starts[first - 1] ?? 0
  const to = last < starts.length ? (starts[last] ?? text.length) - 1 : text.length
  return { from, to }
}

/**
 * The occurrence of `find` whose first line is nearest line `near` (the earlier one on a tie), or the first
 * occurrence when `near` is undefined; undefined when `find` is empty or does not occur.
 */
export const findNear = (text: string, find: string, near?: number): Span | undefined => {
  if (find === '') return undefined
  let at = text.indexOf(find)
  if (at === -1) return undefined
  if (near === undefined) return { from: at, to: at + find.length }
  let best = at
  let bestDistance = Number.POSITIVE_INFINITY
  let line = 1
  let counted = 0
  while (at !== -1) {
    for (let i = text.indexOf('\n', counted); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) {
      line++
      counted = i + 1
    }
    const distance = Math.abs(line - near)
    if (distance < bestDistance) {
      best = at
      bestDistance = distance
    } else if (line > near) break // further occurrences only get further away
    at = text.indexOf(find, at + 1)
  }
  return { from: best, to: best + find.length }
}

/** What a line target points at, and whether it is found text (else whole lines). */
export type Pointed = { span: Span; found: boolean }

/**
 * Where showLines points in `text` (raw file text; the offsets are for its \n form): the `find` text when it
 * occurs (the occurrence nearest `fromLine`), else the lines, else nothing.
 */
export const targetSpan = (text: string, t: { fromLine?: number; toLine?: number; find?: string }): Pointed | undefined => {
  const doc = lf(text)
  const found = t.find ? findNear(doc, lf(t.find), t.fromLine) : undefined
  if (found) return { span: found, found: true }
  if (t.fromLine === undefined) return undefined
  return { span: lineSpan(doc, t.fromLine, t.toLine ?? t.fromLine), found: false }
}

/**
 * The single replacement that turns `a` into `b` with their shared start and end kept, so a cursor or a mark
 * outside the changed part stays where it was; undefined when they are equal.
 */
export const minimalChange = (a: string, b: string): { from: number; to: number; insert: string } | undefined => {
  if (a === b) return undefined
  const max = Math.min(a.length, b.length)
  let start = 0
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) }
}

/** Where `b` differs from `a`, as a span of `b` (empty where text was only removed); undefined when they are equal. */
export const changedSpan = (a: string, b: string): Span | undefined => {
  const c = minimalChange(a, b)
  return c && { from: c.from, to: c.from + c.insert.length }
}

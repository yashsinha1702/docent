// Selections in the protocol's terms. Pure over an EditorState so the conversions can be checked
// without a DOM.
import type { EditorState } from '@codemirror/state'

import type { AtMention, Position, SelectionInfo } from '../../../shared/ipc'

/** CodeMirror numbers lines from 1; the protocol counts lines and characters from 0, as VS Code does. */
const positionAt = (state: EditorState, pos: number): Position => {
  const line = state.doc.lineAt(pos)
  return { line: line.number - 1, character: pos - line.from }
}

/** The main selection as the selection_changed payload (the extension's `uv`: text, filePath, 0-based start/end, isEmpty). */
export const selectionInfo = (state: EditorState, filePath: string): SelectionInfo => {
  const { from, to, empty } = state.selection.main
  return { filePath, text: state.sliceDoc(from, to), selection: { start: positionAt(state, from), end: positionAt(state, to), isEmpty: empty } }
}

/**
 * The at_mentioned payload. The VS Code extension (2.1.301, its `E64`) sends `lineStart = selection.start.line`
 * and `lineEnd = selection.end.line`, VS Code's 0-based lines, and leaves both out when the selection is
 * empty; the 1-based `#L1-2` form only appears in the text it types into the terminal. Mirrored here.
 */
export const atMentionOf = (state: EditorState, filePath: string): AtMention => {
  const { from, to, empty } = state.selection.main
  if (empty) return { filePath }
  return { filePath, lineStart: state.doc.lineAt(from).number - 1, lineEnd: state.doc.lineAt(to).number - 1 }
}

export type TextRange = { anchor: number; head: number }

/**
 * openFile's text-pattern selection, resolved as the extension does: the first `startText`; with an
 * `endText` found after it the selection runs to the end of that `endText`, extended to the end of its
 * line when `selectToEndOfLine`; an `endText` that is not found leaves a cursor at `startText`; no
 * `endText` selects `startText` itself (`selectToEndOfLine` does not apply there). Undefined when
 * `startText` is not in the text.
 */
export const findRange = (text: string, startText: string, endText: string | undefined, selectToEndOfLine: boolean): TextRange | undefined => {
  const start = text.indexOf(startText)
  if (start === -1) return undefined
  const afterStart = start + startText.length
  if (!endText) return { anchor: start, head: afterStart }
  const endAt = text.indexOf(endText, afterStart)
  if (endAt === -1) return { anchor: start, head: start }
  const end = endAt + endText.length
  if (!selectToEndOfLine) return { anchor: start, head: end }
  const newline = text.indexOf('\n', end)
  return { anchor: start, head: newline === -1 ? text.length : newline }
}

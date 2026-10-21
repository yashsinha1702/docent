// CodeMirror pieces shared by the file editor and the diff tab.
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { basename } from './paths'

/** The language support for a path (relative, or absolute in either style), by extension or file name, when language-data knows one. */
export const languageOf = async (path: string): Promise<Extension | undefined> => {
  const name = basename(path)
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const desc = languages.find(l => l.extensions.includes(ext) || l.filename?.test(name))
  return desc ? desc.load() : undefined
}

export const theme = EditorView.theme({ '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '13px' } }, { dark: true })

/** Fills the host; not for the diff's editors, which must grow so the merge view can scroll both sides together. */
export const fill = EditorView.theme({ '&': { height: '100%' } })

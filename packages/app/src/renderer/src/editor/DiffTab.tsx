import { MergeView } from '@codemirror/merge'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef, useState } from 'react'

import type { DiffTab as Diff } from '../store'
import { useStore } from '../store'
import { languageOf, theme } from './cm'
import { acceptDiff, rejectDiff } from './ide'
import { basename } from './paths'

import './diff.css'

/**
 * One openDiff under review: the file as it is on the left, the CLI's proposal on the right, editable.
 * The review bar is where M7's narration ("why") and the concept card will go once the Watch panel
 * has them; for now it names the file and holds Accept and Reject.
 */
export function DiffTab({ diff }: { diff: Diff }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<MergeView>(null)
  const updateDiff = useStore(s => s.updateDiff)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!host.current) return
    const id = diff.id
    const langA = new Compartment()
    const langB = new Compartment()
    const v = new MergeView({
      parent: host.current,
      a: { doc: diff.oldText, extensions: [basicSetup, theme, langA.of([]), EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: {
        doc: diff.text,
        extensions: [
          basicSetup,
          theme,
          langB.of([]),
          EditorView.updateListener.of(u => {
            if (u.docChanged) updateDiff(id, u.state.doc.toString())
          }),
        ],
      },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    })
    view.current = v
    void languageOf(diff.newPath).then(ext => {
      if (!ext || view.current !== v) return
      v.a.dispatch({ effects: langA.reconfigure(ext) })
      v.b.dispatch({ effects: langB.reconfigure(ext) })
    })
    return () => {
      v.destroy()
      view.current = null
    }
    // built once per diff: the right side's edits flow out through updateDiff and come back only on a remount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff.id, updateDiff])

  const accept = () => {
    const v = view.current
    if (!v) return
    // on success the tab is gone with this component; only a failure needs showing
    setError(acceptDiff(diff.id, v.b.state.doc.toString()))
  }

  return (
    <div className="diff-wrap">
      <div className="review-bar">
        <span className="review-title" title={`${diff.tabName}\n${diff.newPath}`}>
          ⇄ {basename(diff.newPath)}
        </span>
        <span className="muted">{diff.oldText === '' ? 'new file' : 'current'} → proposed · the right side is yours to edit</span>
        <span className="spacer" />
        {error && <span className="review-error">could not accept: {error}</span>}
        <button className="accept" onClick={accept} title="Hand the right side back to Claude, which writes the file">
          Accept
        </button>
        <button className="reject" onClick={() => rejectDiff(diff.id)} title="Leave the file as it is">
          Reject
        </button>
      </div>
      <div ref={host} className="diff-host" />
    </div>
  )
}

import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

import { useStore } from '../store'
import { fill, languageOf, theme } from './cm'
import { DiffTab } from './DiffTab'
import { atMention, rejectDiff, selectionChanged, startIde } from './ide'
import { basename } from './paths'

export function Editor() {
  const active = useStore(s => s.active)
  const files = useStore(s => s.files)
  const diffs = useStore(s => s.diffs)
  const activeDiff = useStore(s => s.activeDiff)
  const update = useStore(s => s.update)
  const save = useStore(s => s.save)
  const close = useStore(s => s.close)
  const activate = useStore(s => s.activate)
  const activateDiff = useStore(s => s.activateDiff)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const lang = useRef(new Compartment())
  const revealed = useRef(0)
  const file = files.find(f => f.path === active)
  const diff = diffs.find(d => d.id === activeDiff)
  // the file on show: none while a diff is on top
  const shownPath = diff === undefined ? file?.path : undefined
  const showFile = shownPath !== undefined
  const reveal = showFile ? file?.reveal : undefined

  // the IDE protocol: the CLI's requests, the editor-state report and @-mentions
  useEffect(() => startIde(), [])

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: '' }),
    })
    view.current = v
    return () => v.destroy()
  }, [])

  // a different file, or its text replaced from outside (rev): replace the document and the language
  useEffect(() => {
    const v = view.current
    if (!v || !file) return
    const path = file.path
    v.setState(
      EditorState.create({
        doc: file.text,
        extensions: [
          basicSetup,
          lang.current.of([]),
          theme,
          fill,
          EditorView.updateListener.of(u => {
            if (u.docChanged) update(path, u.state.doc.toString())
            if (u.docChanged || u.selectionSet) selectionChanged(path, u.state)
          }),
          keymap.of([
            { key: 'Mod-s', run: () => (void save(path), true) },
            { key: 'Alt-k', run: target => (atMention(path, target.state), true) },
            { key: 'Mod-Alt-k', run: target => (atMention(path, target.state), true) },
          ]),
        ],
      }),
    )
    void languageOf(path).then(ext => {
      if (ext && view.current && useStore.getState().active === path) view.current.dispatch({ effects: lang.current.reconfigure(ext) })
    })
    // only when the active path changes: typing updates the store, not the other way round
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.rev, save, update])

  // what the CLI may ask about: the selection of the file on show (its state was just replaced when rev changed)
  useEffect(() => {
    selectionChanged(shownPath, shownPath === undefined ? undefined : view.current?.state)
  }, [shownPath, file?.rev])

  // openFile's selection and focus, applied once per request when the file is on show
  useEffect(() => {
    const v = view.current
    if (!v || !reveal || reveal.n === revealed.current) return
    revealed.current = reveal.n
    if (reveal.range) {
      const end = v.state.doc.length
      const head = Math.min(reveal.range.head, end)
      v.dispatch({ selection: EditorSelection.single(Math.min(reveal.range.anchor, end), head), effects: EditorView.scrollIntoView(head, { y: 'center' }) })
    }
    if (reveal.focus) v.focus()
  }, [reveal])

  return (
    <div className="editor-wrap">
      <div className="tabs">
        {files.map(f => (
          <span key={f.path} className={`tab ${showFile && f.path === active ? 'active' : ''}`} onClick={() => activate(f.path)} title={f.path}>
            {basename(f.path)}
            {f.dirty ? ' •' : ''}
            <button
              className="x"
              onClick={e => {
                e.stopPropagation()
                close(f.path)
              }}
            >
              ×
            </button>
          </span>
        ))}
        {diffs.map(d => (
          <span key={d.id} className={`tab diff ${d.id === diff?.id ? 'active' : ''}`} onClick={() => activateDiff(d.id)} title={`${d.tabName}\n${d.newPath}`}>
            ⇄ {basename(d.newPath)}
            <button
              className="x"
              onClick={e => {
                e.stopPropagation()
                // closing a diff without a verdict rejects it, as closing the extension's diff tab does
                rejectDiff(d.id)
              }}
            >
              ×
            </button>
          </span>
        ))}
        {files.length === 0 && diffs.length === 0 && <span className="muted">Open a file from the tree. Claude's reads and edits will show up here.</span>}
      </div>
      {diff && <DiffTab key={diff.id} diff={diff} />}
      <div ref={host} className="cm-host" style={{ display: showFile ? 'block' : 'none' }} />
    </div>
  )
}

import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

import { useStore } from '../store'

const languageOf = async (path: string) => {
  const name = path.split('/').pop() ?? ''
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const desc = languages.find(l => l.extensions.includes(ext) || l.filename?.test(name))
  return desc ? desc.load() : undefined
}

export function Editor() {
  const active = useStore(s => s.active)
  const files = useStore(s => s.files)
  const update = useStore(s => s.update)
  const save = useStore(s => s.save)
  const close = useStore(s => s.close)
  const activate = useStore(s => s.activate)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const lang = useRef(new Compartment())
  const file = files.find(f => f.path === active)

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: '' }),
    })
    view.current = v
    return () => v.destroy()
  }, [])

  // a different file: replace the document and the language
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
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '13px' } }, { dark: true }),
          EditorView.updateListener.of(u => {
            if (u.docChanged) update(path, u.state.doc.toString())
          }),
          keymap.of([{ key: 'Mod-s', run: () => (void save(path), true) }]),
        ],
      }),
    )
    void languageOf(path).then(ext => {
      if (ext && view.current && useStore.getState().active === path) view.current.dispatch({ effects: lang.current.reconfigure(ext) })
    })
    // only when the active path changes: typing updates the store, not the other way round
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, save, update])

  return (
    <div className="editor-wrap">
      <div className="tabs">
        {files.map(f => (
          <span key={f.path} className={`tab ${f.path === active ? 'active' : ''}`} onClick={() => activate(f.path)}>
            {f.path.split('/').pop()}
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
        {files.length === 0 && <span className="muted">Open a file from the tree. Claude's reads and edits will show up here.</span>}
      </div>
      <div ref={host} className="cm-host" style={{ display: file ? 'block' : 'none' }} />
    </div>
  )
}

import { useEffect } from 'react'

import { Editor } from './editor/Editor'
import { startLiveFeed } from './live'
import { useStore } from './store'
import { Terminal } from './terminal/Terminal'
import { Tree } from './tree/Tree'
import { WatchPanel } from './watch/Panel'

export function App() {
  const workspace = useStore(s => s.workspace)
  const setWorkspace = useStore(s => s.setWorkspace)
  useEffect(() => {
    void window.docent.workspace.get().then(setWorkspace)
  }, [setWorkspace])
  useEffect(() => startLiveFeed(), [])

  const choose = async () => {
    const w = await window.docent.workspace.choose()
    if (w) setWorkspace(w)
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Docent</span>
        <button className="folder" onClick={choose} title={workspace?.root}>
          {workspace?.name ?? '…'} ▾
        </button>
        <span className="spacer" />
        <span className="hint">{workspace?.claudeBinary ? 'claude found' : 'claude not found on PATH'} · {workspace?.pairwatchDir ? 'Pairwatch bundled' : 'Pairwatch missing'}</span>
      </header>
      <div className="body">
        <aside className="tree">{workspace && <Tree key={workspace.root} />}</aside>
        <main className="centre">
          <section className="editor">
            <Editor />
          </section>
          <section className="terminal">{workspace && <Terminal key={workspace.root} kind="claude" />}</section>
        </main>
        <aside className="watch">
          <WatchPanel />
        </aside>
      </div>
    </div>
  )
}

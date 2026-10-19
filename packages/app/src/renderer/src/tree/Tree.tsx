import { useEffect, useState } from 'react'

import type { DirEntry } from '../../../shared/ipc'
import { useStore } from '../store'

function Node({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[]>()
  const openFile = useStore(s => s.open)
  const active = useStore(s => s.active)
  useEffect(() => {
    if (open && !children) void window.docent.workspace.list(entry.path).then(setChildren)
  }, [open, children, entry.path])
  const isDir = entry.kind === 'dir'
  return (
    <>
      <div
        className={`row ${active === entry.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen(o => !o) : void openFile(entry.path))}
        title={entry.path}
      >
        <span className="glyph">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        {entry.name}
      </div>
      {open && children?.map(c => <Node key={c.path} entry={c} depth={depth + 1} />)}
    </>
  )
}

export function Tree() {
  const [entries, setEntries] = useState<DirEntry[]>()
  useEffect(() => {
    void window.docent.workspace.list('.').then(setEntries)
  }, [])
  if (!entries) return <div className="muted">loading…</div>
  return (
    <div className="treelist">
      {entries.map(e => (
        <Node key={e.path} entry={e} depth={0} />
      ))}
    </div>
  )
}

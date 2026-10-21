import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { DirEntry } from '../../../shared/ipc'
import { useStore } from '../store'
import { HEAT_GONE_MS, heatIndex, rowHeat } from './heat.ts'
import type { HeatIndex } from './heat.ts'
import './tree.css'

type HeatNow = { index: HeatIndex; now: number }

const HeatContext = createContext<HeatNow>({ index: { files: new Map(), dirs: new Map() }, now: 0 })

/** The fade is slow, so the rows are redrawn on a slow clock while something is warm… */
const HEAT_TICK_MS = 20_000
/** …and on a slower one once everything is cold, so the tooltips' ages ('12 min ago') stay true. */
const COLD_TICK_MS = 60_000

function useHeatClock(latest: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  // a new touch reads the clock at once; `now` may be old by then
  useEffect(() => {
    if (latest !== undefined) setNow(Date.now())
  }, [latest])
  const touched = latest !== undefined
  const warm = touched && now - latest < HEAT_GONE_MS
  useEffect(() => {
    if (!touched) return
    const timer = window.setInterval(() => setNow(Date.now()), warm ? HEAT_TICK_MS : COLD_TICK_MS)
    return () => window.clearInterval(timer)
  }, [touched, warm])
  return now
}

function Node({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[]>()
  const openFile = useStore(s => s.open)
  const active = useStore(s => s.active)
  const { index, now } = useContext(HeatContext)
  const heat = rowHeat(entry, open, index, now)
  useEffect(() => {
    if (open && !children) void window.docent.workspace.list(entry.path).then(setChildren)
  }, [open, children, entry.path])
  const isDir = entry.kind === 'dir'
  return (
    <>
      <div
        className={`row ${active === entry.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14, ...heat.style }}
        onClick={() => (isDir ? setOpen(o => !o) : void openFile(entry.path))}
        title={heat.note === undefined ? entry.path : `${entry.path}\n${heat.note}`}
      >
        <span className="glyph">{isDir ? (open ? '▾' : '▸') : '·'}</span>
        {entry.name}
        {heat.dot !== undefined && <span className={`heat-dot ${heat.dot.kind}`} style={{ opacity: heat.dot.opacity }} aria-hidden="true" />}
      </div>
      {open && children?.map(c => <Node key={c.path} entry={c} depth={depth + 1} />)}
    </>
  )
}

export function Tree() {
  const [entries, setEntries] = useState<DirEntry[]>()
  const files = useStore(s => s.live?.model.files)
  const root = useStore(s => s.workspace?.root)
  const index = useMemo(() => heatIndex(files, root), [files, root])
  const now = useHeatClock(index.latest)
  const heat = useMemo(() => ({ index, now }), [index, now])
  useEffect(() => {
    void window.docent.workspace.list('.').then(setEntries)
  }, [])
  if (!entries) return <div className="muted">loading…</div>
  return (
    <HeatContext value={heat}>
      <div className="treelist">
        {entries.map(e => (
          <Node key={e.path} entry={e} depth={0} />
        ))}
      </div>
    </HeatContext>
  )
}

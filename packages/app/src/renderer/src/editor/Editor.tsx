import type { StateEffect } from '@codemirror/state'
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef, useState } from 'react'

import type { OpenFile, Reveal } from '../store'
import { DiskChangedError, useStore } from '../store'
import { fill, languageOf, theme } from './cm'
import { DiffTab } from './DiffTab'
import { reloadFromDisk, startDiskWatch } from './disk'
import { expireEffect, flash, flashEffect } from './flash'
import { isFollowKey, startFollow } from './follow'
import { atMention, rejectDiff, selectionChanged, startIde } from './ide'
import { lf, minimalChange } from './lines'
import { basename } from './paths'

import './editor.css'

/** The editor's own replacement of the text (a reload from disk), which is not the user typing. */
const fromDisk = Annotation.define<boolean>()
const reloadAnnotations = [fromDisk.of(true), Transaction.addToHistory.of(false)]

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const followKeyName = isMac ? '⌘⌥F' : 'Ctrl+Alt+F'
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])

/** A file's editor while another file shows: its state (cursor, undo history, marks) and where it was scrolled. */
type Parked = { state: EditorState; scroll?: StateEffect<unknown> }

/** Mod-s: a save refused while the changed-on-disk bar is up needs no other message; any other failure surfaces as before. */
const saveKey = (save: (path: string) => Promise<void>, path: string): boolean => {
  void save(path).catch((e: unknown) => {
    if (!(e instanceof DiskChangedError)) throw e
  })
  return true
}

/** Scrolls to the request's range (selecting it unless told not to), leaves its mark, takes focus if asked. */
function applyReveal(v: EditorView, r: Reveal): void {
  const doc = v.state.doc
  const effects: StateEffect<unknown>[] = []
  let selection: EditorSelection | undefined
  if (r.range) {
    const anchor = Math.min(r.range.anchor, doc.length)
    const head = Math.min(r.range.head, doc.length)
    if (r.select !== false) selection = EditorSelection.single(anchor, head)
    const from = Math.min(anchor, head)
    const to = Math.max(anchor, head)
    // a long range shows from its first line; a short one sits in the middle
    const tall = doc.lineAt(to).number - doc.lineAt(from).number > 12
    effects.push(EditorView.scrollIntoView(EditorSelection.range(to, from), { y: tall ? 'start' : 'center', yMargin: 40 }))
  }
  if (r.mark) effects.push(flashEffect(r.mark))
  if (selection || effects.length > 0) v.dispatch({ selection, effects })
  if (r.focus) v.focus()
}

/** Follow mode's switch: on, paused by manual navigation (with the seconds left), or off. */
function FollowToggle() {
  const on = useStore(s => s.followOn)
  const until = useStore(s => s.followPausedUntil)
  const setFollow = useStore(s => s.setFollow)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on || until <= Date.now()) return
    setNow(Date.now())
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= until) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [on, until])
  const left = on ? Math.ceil((until - now) / 1000) : 0
  const paused = left > 0
  const title = !on
    ? `Follow is off. Turn it on to see the files Claude reads and edits as it works (${followKeyName}).`
    : paused
      ? `Follow is paused while you navigate; it resumes in ${left} s. Click to resume now (${followKeyName}).`
      : `Following Claude: the editor shows what it reads and edits, without taking the focus. Clicking or typing in the editor pauses it for 20 s. Click to turn off (${followKeyName}).`
  return (
    <button className={`follow ${!on ? 'off' : paused ? 'paused' : 'on'}`} onClick={() => setFollow(!on || paused)} title={title}>
      {!on ? '○ Follow' : paused ? `❚❚ Paused ${left}s` : '● Following'}
    </button>
  )
}

/** Above a file that changed or went away on disk while it was open. */
function DiskBar({ file }: { file: OpenFile }) {
  const keepMine = useStore(s => s.keepMine)
  const close = useStore(s => s.close)
  const [error, setError] = useState<string>()
  if (file.deleted) {
    return (
      <div className="disk-bar deleted">
        <strong>Deleted on disk.</strong>
        <span className="muted">Save to write it back, or close the tab.</span>
        <span className="spacer" />
        <button onClick={() => keepMine(file.path)} title="Keep the text as unsaved edits">
          Keep
        </button>
        <button onClick={() => close(file.path)}>Close</button>
      </div>
    )
  }
  if (!file.diskChanged) return null
  return (
    <div className="disk-bar">
      <strong>Changed on disk.</strong>
      <span className="muted">This tab has unsaved edits. Saving waits until you choose.</span>
      <span className="spacer" />
      {error && <span className="disk-error">{error}</span>}
      <button onClick={() => void reloadFromDisk(file.path).catch(e => setError(String(e?.message ?? e)))} title="Drop your edits and show the file as it is on disk">
        Reload
      </button>
      <button onClick={() => keepMine(file.path)} title="Keep your edits; saving writes them over the disk's version">
        Keep mine
      </button>
    </div>
  )
}

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
  const touch = useStore(s => s.touch)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const lang = useRef(new Compartment())
  /** the file whose document the view holds, and the text revision it shows */
  const loaded = useRef<{ path: string; rev: number }>(undefined)
  /** the other open files' editors, so switching back keeps the cursor, the undo history and the scroll */
  const parked = useRef(new Map<string, Parked>())
  /** per file, the reveal request last applied */
  const applied = useRef(new Map<string, number>())
  const file = files.find(f => f.path === active)
  const diff = diffs.find(d => d.id === activeDiff)
  // the file on show: none while a diff is on top
  const shownPath = diff === undefined ? file?.path : undefined
  const showFile = shownPath !== undefined
  const reveal = showFile ? file?.reveal : undefined

  // the IDE protocol (the CLI's requests, the editor-state report, @-mentions), follow mode, outside changes
  useEffect(() => startIde(), [])
  useEffect(() => startFollow(), [])
  useEffect(() => startDiskWatch(), [])

  // the follow key works wherever the focus is, the terminal included
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFollowKey(e, isMac)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      // like the toggle: on and following -> off; off or paused -> following
      const s = useStore.getState()
      s.setFollow(!s.followOn || s.followPausedUntil > Date.now())
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: '' }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
      loaded.current = undefined
      parked.current.clear()
    }
  }, [])

  // closed tabs leave nothing behind
  useEffect(() => {
    for (const path of [...parked.current.keys()]) if (!files.some(f => f.path === path)) parked.current.delete(path)
    for (const path of [...applied.current.keys()]) if (!files.some(f => f.path === path)) applied.current.delete(path)
  }, [files])

  // Another file: its parked editor, or a fresh one. The same file with its text replaced from outside (rev):
  // the change applied in place, so the cursor, the scroll position and the undo history stay.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const was = loaded.current
    if (!file) {
      loaded.current = undefined
      return
    }
    const path = file.path
    const text = lf(file.text)
    if (was?.path === path) {
      if (was.rev === file.rev) return
      was.rev = file.rev
      const change = minimalChange(v.state.doc.toString(), text)
      if (change) v.dispatch({ changes: change, annotations: reloadAnnotations })
      return
    }
    // a hidden editor (a diff on top) has no scroll position worth keeping
    if (was && useStore.getState().files.some(f => f.path === was.path)) {
      parked.current.set(was.path, { state: v.state, scroll: v.scrollDOM.clientHeight > 0 ? v.scrollSnapshot() : parked.current.get(was.path)?.scroll })
    }
    loaded.current = { path, rev: file.rev }
    const back = parked.current.get(path)
    parked.current.delete(path)
    if (back) {
      // marks that ran out while it was away go first; text that changed meanwhile comes in as a reload
      let state = back.state.update({ effects: expireEffect() }).state
      const change = minimalChange(state.doc.toString(), text)
      let scroll = back.scroll
      if (change) {
        const tr = state.update({ changes: change, annotations: reloadAnnotations })
        state = tr.state
        scroll = scroll?.map(tr.changes)
      }
      v.setState(state)
      if (scroll) v.dispatch({ effects: scroll })
    } else {
      v.setState(
        EditorState.create({
          doc: file.text,
          extensions: [
            basicSetup,
            lang.current.of([]),
            theme,
            fill,
            flash,
            EditorView.updateListener.of(u => {
              if (u.docChanged && !u.transactions.some(tr => tr.annotation(fromDisk))) update(path, u.state.doc.toString())
              if (u.docChanged || u.selectionSet) selectionChanged(path, u.state)
            }),
            // a click, a key or the wheel in the editor is the user navigating: follow mode holds back
            EditorView.domEventObservers({
              mousedown: () => touch(path),
              wheel: () => touch(path),
              keydown: e => {
                if (!MODIFIER_KEYS.has(e.key)) touch(path)
              },
            }),
            keymap.of([
              { key: 'Mod-s', run: () => saveKey(save, path) },
              { key: 'Alt-k', run: target => (atMention(path, target.state), true) },
              { key: 'Mod-Alt-k', run: target => (atMention(path, target.state), true) },
            ]),
          ],
        }),
      )
    }
    void languageOf(path).then(ext => {
      const cur = view.current
      if (!ext || !cur || loaded.current?.path !== path || lang.current.get(cur.state) === ext) return
      cur.dispatch({ effects: lang.current.reconfigure(ext) })
    })
    // only when the file or its outside revision changes: typing updates the store, not the other way round
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.rev, save, update, touch])

  // what the CLI may ask about: the selection of the file on show (its state was just replaced when rev changed)
  useEffect(() => {
    selectionChanged(shownPath, shownPath === undefined ? undefined : view.current?.state)
  }, [shownPath, file?.rev])

  // a reveal (openFile, showLines, follow mode) is applied once, when its file is on show
  useEffect(() => {
    const v = view.current
    if (!v || !reveal || shownPath === undefined || applied.current.get(shownPath) === reveal.n) return
    applied.current.set(shownPath, reveal.n)
    applyReveal(v, reveal)
  }, [reveal, shownPath])

  const tabClass = (f: OpenFile): string =>
    ['tab', showFile && f.path === active ? 'active' : '', f.auto !== undefined ? 'auto' : '', f.deleted ? 'deleted' : ''].filter(Boolean).join(' ')
  const tabTitle = (f: OpenFile): string =>
    [f.path, f.auto !== undefined ? 'opened by follow mode' : '', f.diskChanged ? 'changed on disk' : '', f.deleted ? 'deleted on disk' : ''].filter(Boolean).join('\n')

  return (
    <div className="editor-wrap">
      <div className="tabbar">
        <div className="tabs">
          {files.map(f => (
            <span key={f.path} className={tabClass(f)} onClick={() => activate(f.path)} title={tabTitle(f)}>
              {basename(f.path)}
              {f.dirty ? ' •' : ''}
              {f.diskChanged ? <span className="disk-mark"> ⚠</span> : null}
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
        <FollowToggle />
      </div>
      {diff && <DiffTab key={diff.id} diff={diff} />}
      {showFile && file && <DiskBar key={file.path} file={file} />}
      <div ref={host} className="cm-host" style={{ display: showFile ? 'block' : 'none' }} />
    </div>
  )
}

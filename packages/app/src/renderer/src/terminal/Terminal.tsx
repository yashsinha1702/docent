import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import '@xterm/xterm/css/xterm.css'
import type { TerminalKind } from '../../../shared/ipc'
import { useStore } from '../store'

export function Terminal({ kind }: { kind: TerminalKind }) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>('starting…')
  const [command, setCommand] = useState<string>('')

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: { background: '#0b1120' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new ClipboardAddon())
    term.unicode.activeVersion = '11'
    term.open(el)
    fit.fit()

    let id: string | undefined
    let closed = false
    const off = window.docent.pty.onEvent(ev => {
      if (ev.id !== id) return
      if (ev.type === 'data') term.write(ev.data)
      else if (ev.type === 'exit') {
        setStatus(`exited (${ev.exitCode})`)
        term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
        const s = useStore.getState().session
        if (s?.ptyId === ev.id) useStore.getState().setSession({ ...s, ended: true })
      } else if (ev.type === 'title') setStatus(ev.title)
    })
    // Shift+Enter inserts a newline in the claude prompt: the CLI reads ESC CR (what VS Code's /terminal-setup sends)
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && id) {
        window.docent.pty.write(id, '\x1b\r')
        return false
      }
      return true
    })
    term.onData(d => id && window.docent.pty.write(id, d))
    term.onResize(({ cols, rows }) => id && window.docent.pty.resize(id, cols, rows))
    void window.docent.pty
      .spawn({ kind, cols: term.cols, rows: term.rows })
      .then(r => {
        if (closed) return window.docent.pty.kill(r.id)
        id = r.id
        setCommand(r.command)
        setStatus(kind === 'claude' && r.sessionId ? `claude · ${r.sessionId.slice(0, 8)}` : r.command)
        if (kind === 'claude' && r.sessionId) useStore.getState().setSession({ sid: r.sessionId, ptyId: r.id })
        term.focus()
      })
      .catch(err => {
        setStatus('failed')
        term.write(`\r\n\x1b[31m${String(err?.message ?? err)}\x1b[0m\r\n`)
      })

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fit.fit())
    })
    ro.observe(el)
    return () => {
      closed = true
      ro.disconnect()
      off()
      if (id) window.docent.pty.kill(id)
      term.dispose()
    }
  }, [kind])

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className="dot" />
        <span className="muted" title={command}>
          {status}
        </span>
      </div>
      <div ref={host} className="term-host" />
    </div>
  )
}

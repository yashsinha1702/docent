// Picks OSC sequences out of a pty stream: window titles (OSC 0/2) and Claude Code's status
// protocol (OSC 7501). The bytes still go to the terminal unchanged; this only observes.
export type OscEvent =
  | { kind: 'title'; title: string }
  | { kind: 'status-probe' } // ESC ] 7501 ; ? ST — the CLI asks whether the terminal speaks the status protocol
  | { kind: 'status'; raw: string } // ESC ] 7501 ; <payload> ST
  | { kind: 'other'; code: string; payload: string }

const ESC = '\x1b'
const BEL = '\x07'

export class OscParser {
  private buffer = ''
  // an explicit field, not a parameter property: Node's type stripping runs these files as written
  private readonly emit: (e: OscEvent) => void

  constructor(emit: (e: OscEvent) => void) {
    this.emit = emit
  }

  feed(chunk: string): void {
    this.buffer += chunk
    // scan for complete OSC sequences; keep a bounded tail for one that spans chunks
    let start = this.buffer.indexOf(`${ESC}]`)
    while (start >= 0) {
      const bel = this.buffer.indexOf(BEL, start)
      const st = this.buffer.indexOf(`${ESC}\\`, start)
      const end = bel >= 0 && (st < 0 || bel < st) ? bel : st
      if (end < 0) break // incomplete: wait for more
      const body = this.buffer.slice(start + 2, end)
      this.handle(body)
      this.buffer = this.buffer.slice(end + (end === bel ? 1 : 2))
      start = this.buffer.indexOf(`${ESC}]`)
    }
    if (start < 0) this.buffer = ''
    else if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-4096)
  }

  private handle(body: string): void {
    const semi = body.indexOf(';')
    const code = semi >= 0 ? body.slice(0, semi) : body
    const payload = semi >= 0 ? body.slice(semi + 1) : ''
    if (code === '0' || code === '2') this.emit({ kind: 'title', title: payload })
    else if (code === '7501') this.emit(payload === '?' ? { kind: 'status-probe' } : { kind: 'status', raw: payload })
    else this.emit({ kind: 'other', code, payload })
  }
}

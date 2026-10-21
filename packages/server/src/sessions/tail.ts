// What was appended to a file since the last read, in whole lines. A partial last line waits for its
// end as bytes, so a multi-byte character split across two reads stays whole ('\n' never occurs inside
// a UTF-8 sequence). A file that shrank or was replaced (a new inode) reads from its start again and
// says so: whatever was built from it before is void.
import { open, stat } from 'node:fs/promises'

export type TailRead = {
  lines: string[]
  /** the file shrank or was replaced since the last read; `lines` start from its beginning */
  reset: boolean
  /** more bytes are waiting than this read took */
  more: boolean
}

const NEWLINE = 0x0a
/** a line longer than this is junk: dropped up to its end, so memory stays bounded */
const MAX_LINE = 64 * 1024 * 1024
const EMPTY = Buffer.alloc(0)

export class LineTail {
  readonly path: string
  private offset = 0
  private rest: Buffer = EMPTY
  private isSkipping = false
  private ino: number | undefined

  constructor(path: string) {
    this.path = path
  }

  /** Reads up to `maxBytes` new bytes; a missing file reads as nothing new. */
  async read(maxBytes: number): Promise<TailRead> {
    let size: number
    let ino: number
    try {
      const st = await stat(this.path)
      size = st.size
      ino = st.ino
    } catch {
      return { lines: [], reset: false, more: false }
    }
    let reset = false
    if ((this.ino !== undefined && ino !== this.ino) || size < this.offset) {
      reset = true
      this.offset = 0
      this.rest = EMPTY
      this.isSkipping = false
    }
    this.ino = ino
    if (size <= this.offset) return { lines: [], reset, more: false }
    const want = Math.min(size - this.offset, maxBytes)
    const buf = Buffer.allocUnsafe(want)
    let got = 0
    const fh = await open(this.path, 'r')
    try {
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, this.offset + got)
        if (bytesRead === 0) break
        got += bytesRead
      }
    } finally {
      await fh.close()
    }
    this.offset += got
    const more = this.offset < size
    let data = this.rest.length > 0 ? Buffer.concat([this.rest, buf.subarray(0, got)]) : buf.subarray(0, got)
    this.rest = EMPTY
    let nl = data.lastIndexOf(NEWLINE)
    if (this.isSkipping) {
      const first = data.indexOf(NEWLINE)
      if (first < 0) return { lines: [], reset, more }
      this.isSkipping = false
      data = data.subarray(first + 1)
      nl = data.lastIndexOf(NEWLINE)
    }
    const tail = data.subarray(nl + 1)
    if (tail.length > MAX_LINE) this.isSkipping = true
    else if (tail.length > 0) this.rest = Buffer.from(tail)
    if (nl < 0) return { lines: [], reset, more }
    return { lines: data.toString('utf8', 0, nl).split('\n'), reset, more }
  }
}

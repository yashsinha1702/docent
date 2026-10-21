// Outside changes to the open files. The renderer names the files it shows (the open tabs) whenever that
// set changes; main watches them (src/main/watchFiles.ts) and reports each change or deletion. A change is
// read back and handed to the store, which decides (editor/outside.ts): a clean tab reloads, a dirty one
// is marked for the Changed-on-disk bar, a deleted file is marked deleted. Started once, from the Editor.
import type { FileChange } from '../../../shared/ipc'
import type { OpenFile } from '../store'
import { useStore } from '../store'

export type DiskOptions = { log?: (msg: string) => void }

let stop: (() => void) | undefined

/** The open tabs' paths, unique and sorted: what main should watch. */
export const watchSet = (files: readonly Pick<OpenFile, 'path'>[]): string[] => [...new Set(files.map(f => f.path))].sort()

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** A read that failed because the file is not there (the error crosses IPC as text). */
const isMissing = (e: unknown): boolean => /ENOENT|no such file/i.test(message(e))

/** The Changed-on-disk bar's Reload: the file as it is now replaces the tab's text and edits. */
export async function reloadFromDisk(path: string): Promise<void> {
  let text: string
  try {
    text = await window.docent.workspace.read(path)
  } catch (e) {
    if (!isMissing(e)) throw e
    return useStore.getState().syncDisk(path, undefined)
  }
  useStore.getState().reload(path, text)
}

/** Reports the open tabs to main and applies its change notices; returns the stop function (a second call returns the same one). */
export function startDiskWatch(opts: DiskOptions = {}): () => void {
  if (stop) return stop
  const log = opts.log ?? (() => {})
  let reported: string | undefined
  let watching = new Set<string>()
  /** per path, the newest notice: an older read finishing late is dropped */
  const latest = new Map<string, number>()
  let notices = 0

  const report = (files: readonly OpenFile[]): void => {
    const paths = watchSet(files)
    const key = paths.join('\n')
    if (key === reported) return
    reported = key
    window.docent.workspace.watch(paths)
    // main's watch starts after the tab's own read and takes the file as it then finds it, so a change in between
    // would never be reported. Each newly watched tab is therefore read once more (equal text is a no-op). The
    // request goes first on the same channel, so main's first look at the file is under way when this read is served.
    const added = paths.filter(p => !watching.has(p))
    watching = new Set(paths)
    for (const path of added) void changed({ path, kind: 'change' })
  }

  const changed = async (e: FileChange): Promise<void> => {
    if (!useStore.getState().files.some(f => f.path === e.path)) return
    const n = ++notices
    latest.set(e.path, n)
    let text: string | undefined
    if (e.kind === 'change') {
      try {
        text = await window.docent.workspace.read(e.path)
      } catch (err) {
        if (!isMissing(err)) return log(`reading ${e.path} after an outside change: ${message(err)}`)
      }
    }
    if (latest.get(e.path) !== n) return
    latest.delete(e.path)
    useStore.getState().syncDisk(e.path, text)
  }

  const offStore = useStore.subscribe((s, b) => {
    if (s.files !== b.files) report(s.files)
  })
  const offChanged = window.docent.workspace.onChanged(e => void changed(e))
  report(useStore.getState().files)
  stop = () => {
    offStore()
    offChanged()
    // nothing listens any more: main can let its watchers go
    window.docent.workspace.watch([])
    stop = undefined
  }
  return stop
}

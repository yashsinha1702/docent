// What an open tab does when its file changes on disk, decided without side effects. disk.ts watches
// and reads; the store applies these (syncDisk, reload, keepMine).
//
// A tab remembers `disk`, the text it last knew the disk to hold: what it read, what it saved, or what an
// accepted diff is about to be written as. A change notice whose text equals it is nothing new (our own
// save, the CLI writing the diff the user just accepted, a touch), so it never flickers the editor.
import type { OpenFile } from '../store'
import { lf } from './lines'

export type DiskDecision = 'none' | 'reload' | 'clean' | 'conflict' | 'deleted'

/**
 * | disk now                                   | tab   | decision                                          |
 * | ------------------------------------------ | ----- | ------------------------------------------------- |
 * | gone (undefined)                           | any   | deleted: marked; the text stays                   |
 * | what the tab last knew                     | any   | none: nothing new; any mark is cleared            |
 * | new                                        | clean | reload: the tab takes the disk's text             |
 * | new, equal to the unsaved buffer           | dirty | clean: the edits are on disk now                  |
 * | what the tab knew, but for its line breaks | dirty | none: the editor holds \n anyway                  |
 * | new, different                             | dirty | conflict: marked; the editor asks Reload or Keep  |
 *
 * The line-break row: an accepted diff leaves the tab with the editor's \n text, and the CLI then writes the
 * file with the CRLF it had. A keystroke before that write is read back must not raise the bar.
 */
export function decideDiskChange(tab: Pick<OpenFile, 'text' | 'dirty' | 'disk'>, disk: string | undefined): DiskDecision {
  if (disk === undefined) return 'deleted'
  if (disk === tab.disk) return 'none'
  if (!tab.dirty) return 'reload'
  if (disk === tab.text) return 'clean'
  return tab.disk !== undefined && lf(disk) === lf(tab.disk) ? 'none' : 'conflict'
}

const marked = (f: OpenFile): boolean => f.diskChanged !== undefined || f.diskText !== undefined || f.deleted !== undefined

/** The tab without the changed-on-disk and deleted marks. */
const unmarked = (f: OpenFile): OpenFile => {
  const { diskChanged: _changed, diskText: _text, deleted: _deleted, ...rest } = f
  return rest
}

/**
 * The tab after `text` replaced it from outside (a reload, an accepted diff): clean, unmarked, `disk` = text.
 * `rev` moves only when the text differs, so an equal reload does not touch the editor. The same object when
 * nothing changes.
 */
export function reloaded(f: OpenFile, text: string): OpenFile {
  if (f.text !== text) return { ...unmarked(f), text, dirty: false, disk: text, rev: f.rev + 1 }
  return f.dirty || f.disk !== text || marked(f) ? { ...unmarked(f), dirty: false, disk: text } : f
}

/** The tab after the disk was found to hold `text` (undefined: the file is gone); the same object when nothing changes. */
export function withDisk(f: OpenFile, text: string | undefined): OpenFile {
  if (text === undefined) return f.deleted ? f : { ...unmarked(f), deleted: true }
  switch (decideDiskChange(f, text)) {
    case 'reload':
      return reloaded(f, text)
    case 'clean':
      return { ...unmarked(f), dirty: false, disk: text }
    case 'conflict':
      return f.diskChanged && f.diskText === text ? f : { ...unmarked(f), diskChanged: true, diskText: text }
    default:
      return marked(f) ? unmarked(f) : f
  }
}

/**
 * Keep mine. Changed on disk: the edits stay unsaved and the disk's version counts as seen, so only a further
 * change asks again. Deleted: the text stays as unsaved edits (saving writes the file back).
 */
export function keptMine(f: OpenFile): OpenFile {
  if (f.deleted) {
    const { disk: _disk, ...rest } = unmarked(f)
    return { ...rest, dirty: true }
  }
  if (f.diskChanged) return { ...unmarked(f), disk: f.diskText ?? f.disk }
  return f
}

// File heat in the tree (packages/app/src/renderer/src/tree/heat.ts): pure helpers, run under Node 22.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { timeline } from '@docent/core'
import type { FileTouch, RawEvent } from '@docent/core'

import { DOT_MIN_OPACITY, HEAT_FULL_MS, HEAT_GONE_MS, ageText, dirTooltip, heatIndex, heatKind, heatStrength, heatStyle, heatTooltip, rowHeat } from '../src/renderer/src/tree/heat.ts'

const T0 = 1_700_000_000_000
const MIN = 60_000
const ROOT = '/w/proj'

test('strength: full for two minutes, then a straight fade to none at ten', () => {
  assert.equal(HEAT_FULL_MS, 2 * MIN)
  assert.equal(HEAT_GONE_MS, 10 * MIN)
  assert.equal(heatStrength(T0, T0), 1)
  assert.equal(heatStrength(T0, T0 + 2 * MIN), 1)
  assert.equal(heatStrength(T0, T0 + 6 * MIN), 0.5)
  assert.equal(heatStrength(T0, T0 + 10 * MIN), 0)
  assert.equal(heatStrength(T0, T0 + 60 * MIN), 0)
  assert.equal(heatStrength(T0 + MIN, T0), 1, 'a touch newer than the clock is hot')
  assert.equal(heatStrength(Number.NaN, T0), 0)
  const fading = [3, 4, 5, 7, 9].map(m => heatStrength(T0, T0 + m * MIN))
  assert.deepEqual([...fading].sort((a, b) => b - a), fading, 'it only fades')
})

test('tooltip: counts in words, then the age', () => {
  assert.equal(heatTooltip({ reads: 3, edits: 1, last: T0 }, T0 + 2 * MIN), 'read 3 times, edited once, 2 min ago')
  assert.equal(heatTooltip({ reads: 2, edits: 0, last: T0 }, T0 + 30_000), 'read twice, just now')
  assert.equal(heatTooltip({ reads: 0, edits: 2, last: T0 }, T0 + 5 * 60 * MIN), 'edited twice, 5 h ago')
  assert.equal(heatTooltip({ reads: 0, edits: 0, last: T0 }, T0 + MIN), 'touched, 1 min ago')
  assert.equal(ageText(T0, T0 + 119 * MIN), '119 min ago')
  assert.equal(ageText(T0, T0 + 120 * MIN), '2 h ago')
  assert.equal(ageText(T0 + MIN, T0), 'just now')
  assert.equal(dirTooltip({ files: 1, last: T0, kind: 'read' }, T0 + 4 * MIN), '1 file touched inside, the last 4 min ago')
  assert.equal(dirTooltip({ files: 3, last: T0, kind: 'edit' }, T0), '3 files touched inside, the last just now')
})

test("the index keys files as the tree's rows do, rolls them up into their folders, and drops what is outside", () => {
  const files: FileTouch[] = [
    { path: `${ROOT}/src/a.ts`, reads: 2, edits: 0, last: T0 + 3000 },
    { path: `${ROOT}/src/lib/b.ts`, reads: 1, edits: 1, last: T0 + 2000 },
    { path: `${ROOT}/README.md`, reads: 1, edits: 0, last: T0 + 1000 },
    { path: '/elsewhere/c.ts', reads: 1, edits: 0, last: T0 + 9000 },
    { path: '~/.zshrc', reads: 1, edits: 0, last: T0 + 9000 },
  ]
  const ix = heatIndex(files, ROOT)
  assert.deepEqual([...ix.files.keys()], ['src/a.ts', 'src/lib/b.ts', 'README.md'])
  assert.deepEqual(ix.files.get('src/a.ts'), { reads: 2, edits: 0, last: T0 + 3000, kind: 'read' })
  assert.equal(ix.files.get('src/lib/b.ts')?.kind, 'edit', 'edits win')
  assert.deepEqual(ix.dirs.get('src'), { files: 2, last: T0 + 3000, kind: 'edit' })
  assert.deepEqual(ix.dirs.get('src/lib'), { files: 1, last: T0 + 2000, kind: 'edit' })
  assert.equal(ix.dirs.has(''), false)
  assert.equal(ix.latest, T0 + 3000, 'the newest touch inside the workspace')
  assert.deepEqual(heatIndex(undefined, ROOT), { files: new Map(), dirs: new Map() })
  assert.equal(heatIndex(files, undefined).files.size, 0, 'no workspace: nothing matches')
})

test('the index from a real fold: normalizePath stores paths absolute under the cwd', () => {
  const events: RawEvent[] = [
    { kind: 'prompt', text: 'go', origin: 'user', at: T0 },
    { kind: 'tool-start', obs: { id: 'r1', tool: 'Read', args: { file_path: 'src/./x.ts' }, at: T0 + 1000 } },
    { kind: 'tool-end', end: { id: 'r1', status: 'ok', preview: '', at: T0 + 1100 } },
    { kind: 'tool-start', obs: { id: 'e1', tool: 'Edit', args: { file_path: `${ROOT}/src/x.ts`, old_string: 'a', new_string: 'b' }, at: T0 + 2000 } },
    { kind: 'tool-end', end: { id: 'e1', status: 'ok', preview: '', at: T0 + 2100 } },
  ]
  const m = timeline.reduce(timeline.emptyModel(T0), events, { level: 1, cwd: ROOT, now: T0 + 3000 })
  assert.deepEqual(m.files, [{ path: `${ROOT}/src/x.ts`, reads: 1, edits: 1, last: T0 + 2000 }])
  assert.deepEqual(heatIndex(m.files, ROOT).files.get('src/x.ts'), { reads: 1, edits: 1, last: T0 + 2000, kind: 'edit' })
})

test('Windows paths and odd entries', () => {
  const ix = heatIndex(
    [
      { path: 'C:\\Users\\me\\proj\\src\\a.ts', reads: 1, edits: 0, last: T0 },
      { path: 'c:\\users\\me\\proj\\src\\a.ts', reads: 1, edits: 2, last: T0 + 5 },
      { path: 'C:\\Users\\me\\proj\\b.ts', reads: 1, edits: 0, last: Number.NaN },
    ] as FileTouch[],
    'C:\\Users\\me\\proj',
  )
  assert.deepEqual([...ix.files.entries()], [['src/a.ts', { reads: 2, edits: 2, last: T0 + 5, kind: 'edit' }]], 'two spellings of one file merge; a touch without a time is dropped')
})

test('style: the kind picks the colour, strength the depth; nothing when cold', () => {
  assert.equal(heatKind({ edits: 0 }), 'read')
  assert.equal(heatKind({ edits: 1 }), 'edit')
  assert.deepEqual(heatStyle('read', 1), { backgroundImage: 'linear-gradient(90deg, rgba(96, 165, 250, 0.26), rgba(96, 165, 250, 0.06))', boxShadow: 'inset 2px 0 0 rgba(96, 165, 250, 1)' })
  assert.deepEqual(heatStyle('edit', 0.5), { backgroundImage: 'linear-gradient(90deg, rgba(251, 191, 36, 0.13), rgba(251, 191, 36, 0.03))', boxShadow: 'inset 2px 0 0 rgba(251, 191, 36, 0.675)' })
  assert.equal(heatStyle('read', 0), undefined)
  assert.equal(heatStyle('read', Number.NaN), undefined)
})

test('under a Windows root a row matches its file in any case; under a POSIX root case counts', () => {
  const win = heatIndex([{ path: 'C:\\Users\\me\\proj\\SRC\\App.ts', reads: 2, edits: 0, last: T0 }], 'C:\\Users\\me\\proj')
  assert.equal(win.folded, true)
  assert.deepEqual([...win.files.keys()], ['src/app.ts'])
  assert.equal(rowHeat({ path: 'src/app.ts', kind: 'file' }, false, win, T0).note, 'read twice, just now', "the tree's row, spelled as on disk")
  assert.equal(rowHeat({ path: 'Src', kind: 'dir' }, false, win, T0).dot?.kind, 'read')
  const unc = heatIndex([{ path: '\\\\SRV\\Share\\proj\\a.ts', reads: 1, edits: 0, last: T0 }], '\\\\srv\\share\\proj')
  assert.deepEqual([...unc.files.keys()], ['a.ts'], 'a UNC root compares without case too')
  const posix = heatIndex(
    [
      { path: `${ROOT}/SRC/App.ts`, reads: 1, edits: 0, last: T0 },
      { path: `${ROOT}/odd\\name.ts`, reads: 1, edits: 0, last: T0 },
    ],
    ROOT,
  )
  assert.equal(posix.folded, undefined)
  assert.deepEqual(rowHeat({ path: 'src/app.ts', kind: 'file' }, false, posix, T0), {}, 'another file on a case-sensitive disk')
  assert.equal(rowHeat({ path: 'odd\\name.ts', kind: 'file' }, false, posix, T0).note, 'read once, just now', 'a backslash is part of a POSIX name')
})

test('a row: a touched file is tinted while warm and keeps its tooltip; a collapsed folder keeps a fading dot; an open one shows nothing', () => {
  const ix = heatIndex([{ path: `${ROOT}/src/lib/b.ts`, reads: 1, edits: 1, last: T0 }], ROOT)
  assert.deepEqual(rowHeat({ path: 'src/lib/b.ts', kind: 'file' }, false, ix, T0 + MIN), { style: heatStyle('edit', 1), note: 'read once, edited once, 1 min ago' })
  assert.deepEqual(rowHeat({ path: 'src/lib/b.ts', kind: 'file' }, false, ix, T0 + 30 * MIN), { note: 'read once, edited once, 30 min ago' }, 'cold: no tint, the tooltip stays')
  assert.deepEqual(rowHeat({ path: 'src', kind: 'dir' }, false, ix, T0 + MIN), { note: '1 file touched inside, the last 1 min ago', dot: { kind: 'edit', opacity: 1 } })
  assert.equal(rowHeat({ path: 'src', kind: 'dir' }, false, ix, T0 + 6 * MIN).dot?.opacity, 0.7, 'fading')
  assert.equal(DOT_MIN_OPACITY, 0.4)
  assert.deepEqual(rowHeat({ path: 'src/lib', kind: 'dir' }, false, ix, T0 + 3 * 60 * MIN).dot, { kind: 'edit', opacity: DOT_MIN_OPACITY }, 'long cold: faint, but still there')
  assert.deepEqual(rowHeat({ path: 'src', kind: 'dir' }, true, ix, T0), {}, 'open: its files show their own heat')
  assert.deepEqual(rowHeat({ path: 'docs', kind: 'dir' }, false, ix, T0), {})
  assert.deepEqual(rowHeat({ path: 'README.md', kind: 'file' }, false, ix, T0), {})
})

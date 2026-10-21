// Runs the renderer's pure helpers under Node 22 (strip-only TypeScript): the path jail, the
// 0-based selection conversions, the at_mentioned payload, openFile's text-pattern selection, showLines'
// ranges (lines, the find text nearest a line), the outside-change decision table and the fading marks.
// Windows paths have their own spec (paths.spec.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { FLASH_MS, expireEffect, flashEffect, flashField, flashRanges, nextExpiry } from '../src/renderer/src/editor/flash.ts'
import { changedSpan, findNear, lf, lineAt, lineSpan, minimalChange, targetSpan } from '../src/renderer/src/editor/lines.ts'
import { decideDiskChange, keptMine, reloaded, withDisk } from '../src/renderer/src/editor/outside.ts'
import { absolute, basename, normalise, relativeTo } from '../src/renderer/src/editor/paths.ts'
import { atMentionOf, findRange, selectionInfo } from '../src/renderer/src/editor/selection.ts'
import type { OpenFile } from '../src/renderer/src/store.ts'

test('paths: inline sanity checks passed at import; extra cases', () => {
  assert.equal(normalise('/a/b/../../..'), '/')
  assert.equal(normalise('a/./b//'), 'a/b')
  assert.equal(relativeTo('/w', '/w/'), '')
  assert.equal(relativeTo('/', '/etc/hosts'), 'etc/hosts')
  assert.equal(relativeTo('/w', '/w/.hidden/x'), '.hidden/x')
  assert.equal(relativeTo('/w', '/w/..'), undefined)
  assert.equal(relativeTo('/w', '/wx'), undefined)
  assert.equal(absolute('/w/', ''), '/w')
})

const doc = 'first line\nsecond line\nthird'

test('selectionInfo converts CodeMirror offsets to 0-based line/character', () => {
  const state = EditorState.create({ doc, selection: EditorSelection.single(2, 18) })
  assert.deepEqual(selectionInfo(state, '/w/a.ts'), {
    filePath: '/w/a.ts',
    text: 'rst line\nsecond ',
    selection: { start: { line: 0, character: 2 }, end: { line: 1, character: 7 }, isEmpty: false },
  })
  const cursor = EditorState.create({ doc, selection: EditorSelection.single(doc.length) })
  assert.deepEqual(selectionInfo(cursor, '/w/a.ts').selection, { start: { line: 2, character: 5 }, end: { line: 2, character: 5 }, isEmpty: true })
})

test('atMentionOf: 0-based lines, none when the selection is empty', () => {
  assert.deepEqual(atMentionOf(EditorState.create({ doc, selection: EditorSelection.single(12, 24) }), '/w/a.ts'), { filePath: '/w/a.ts', lineStart: 1, lineEnd: 2 })
  assert.deepEqual(atMentionOf(EditorState.create({ doc, selection: EditorSelection.single(12) }), '/w/a.ts'), { filePath: '/w/a.ts' })
  // a selection ending at column 0 of the next line counts that line, as VS Code's end.line does
  assert.deepEqual(atMentionOf(EditorState.create({ doc, selection: EditorSelection.single(0, 11) }), '/w/a.ts'), { filePath: '/w/a.ts', lineStart: 0, lineEnd: 1 })
})

test('findRange mirrors the extension', () => {
  assert.deepEqual(findRange(doc, 'second', undefined, false), { anchor: 11, head: 17 })
  assert.deepEqual(findRange(doc, 'second', undefined, true), { anchor: 11, head: 17 }, 'selectToEndOfLine needs an endText')
  assert.deepEqual(findRange(doc, 'second', 'th', false), { anchor: 11, head: 25 })
  assert.deepEqual(findRange(doc, 'first', 'sec', true), { anchor: 0, head: 22 })
  assert.deepEqual(findRange(doc, 'first', 'third', true), { anchor: 0, head: doc.length })
  assert.deepEqual(findRange(doc, 'second', 'missing', true), { anchor: 11, head: 11 }, 'endText missing: cursor at startText')
  assert.equal(findRange(doc, 'missing', 'x', false), undefined)
  assert.deepEqual(findRange(doc, 'line', '', false), { anchor: 6, head: 10 }, 'an empty endText counts as absent')
})

test('basename labels a tab with the last segment', () => {
  assert.equal(basename('/w/src/a.ts'), 'a.ts')
  assert.equal(basename('a.ts/'), 'a.ts')
  assert.equal(basename('/'), '')
  assert.equal(basename('✻ [Claude Code] foo.ts (a1b2c3) ⧉'), '✻ [Claude Code] foo.ts (a1b2c3) ⧉', 'only path separators split')
})

// ---- showLines ranges

const five = 'one\ntwo\nthree\nfour\nfive'

test('lineSpan: start of the first line to the end of the last, clamped', () => {
  assert.deepEqual(lineSpan(five, 2), { from: 4, to: 7 })
  assert.deepEqual(lineSpan(five, 2, 3), { from: 4, to: 13 })
  assert.deepEqual(lineSpan(five, 4, 99), { from: 14, to: five.length }, 'past the end: to the end of the text')
  assert.deepEqual(lineSpan(five, 99), { from: 19, to: five.length }, 'a line past the end: the last line')
  assert.deepEqual(lineSpan(five, 0, -3), { from: 0, to: 3 }, 'below 1: the first line')
  assert.deepEqual(lineSpan(five, 3, 1), { from: 8, to: 13 }, 'toLine before fromLine: fromLine alone')
  assert.deepEqual(lineSpan('', 1, 5), { from: 0, to: 0 })
  assert.deepEqual(lineSpan('a\n', 2), { from: 2, to: 2 }, 'the empty last line')
})

test('findNear: the occurrence nearest a line, the earlier on a tie; the first without a line', () => {
  const text = 'x = 1\nfoo()\ny = 2\nfoo()\nz = 3\nw = 4\nfoo()'
  const at = (line: number) => lineSpan(text, line).from
  assert.deepEqual(findNear(text, 'foo()'), { from: at(2), to: at(2) + 5 })
  assert.deepEqual(findNear(text, 'foo()', 1), { from: at(2), to: at(2) + 5 })
  assert.deepEqual(findNear(text, 'foo()', 4), { from: at(4), to: at(4) + 5 })
  assert.deepEqual(findNear(text, 'foo()', 3), { from: at(2), to: at(2) + 5 }, 'lines 2 and 4 tie: the earlier')
  assert.deepEqual(findNear(text, 'foo()', 6), { from: at(7), to: at(7) + 5 })
  assert.deepEqual(findNear(text, 'foo()', 100), { from: at(7), to: at(7) + 5 })
  assert.equal(findNear(text, 'bar'), undefined)
  assert.equal(findNear(text, ''), undefined)
  assert.deepEqual(findNear('aaaa', 'aa', 1), { from: 0, to: 2 }, 'overlapping occurrences: the first on the line')
})

test('targetSpan: the find text (nearest fromLine), else the lines, else nothing; CRLF measured as the editor does', () => {
  assert.deepEqual(targetSpan(five, { fromLine: 2, toLine: 3 }), { span: { from: 4, to: 13 }, found: false })
  assert.deepEqual(targetSpan(five, { find: 'thr' }), { span: { from: 8, to: 11 }, found: true })
  assert.deepEqual(targetSpan(five, { find: 'missing', fromLine: 5 }), { span: { from: 19, to: 23 }, found: false }, 'not found: the lines')
  assert.equal(targetSpan(five, { find: 'missing' }), undefined)
  assert.equal(targetSpan(five, {}), undefined)
  const crlf = 'one\r\ntwo\r\nthree\r\n'
  assert.deepEqual(targetSpan(crlf, { fromLine: 3 }), { span: { from: 8, to: 13 }, found: false }, 'as if the line breaks were \\n')
  assert.deepEqual(targetSpan(crlf, { find: 'two\nthree' }), { span: { from: 4, to: 13 }, found: true }, 'an LF find text in a CRLF file')
  assert.deepEqual(targetSpan('one\ntwo', { find: 'one\r\ntwo' }), { span: { from: 0, to: 7 }, found: true }, 'a CRLF find text in an LF file')
})

test('lf and minimalChange', () => {
  assert.equal(lf('a\r\nb\rc\n'), 'a\nb\nc\n')
  assert.equal(minimalChange('same', 'same'), undefined)
  assert.deepEqual(minimalChange('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' })
  assert.deepEqual(minimalChange('abcabc', 'abc'), { from: 3, to: 6, insert: '' })
  assert.deepEqual(minimalChange('', 'x'), { from: 0, to: 0, insert: 'x' })
  assert.deepEqual(minimalChange('aaa', 'aaaa'), { from: 3, to: 3, insert: 'a' }, 'prefix and suffix never overlap')
  for (const [a, b] of [['line1\nline2\nline3', 'line1\nLINE2\nline3'], ['x', ''], ['abc', 'xbcx']] as const) {
    const c = minimalChange(a, b)!
    assert.equal(a.slice(0, c.from) + c.insert + a.slice(c.to), b)
  }
})

test('lineAt and changedSpan: where a reload put new text, for follow mode to mark', () => {
  assert.equal(lineAt(five, 0), 1)
  assert.equal(lineAt(five, 3), 1, 'a line break still belongs to its line')
  assert.equal(lineAt(five, 4), 2)
  assert.equal(lineAt(five, five.length), 5)
  assert.equal(lineAt('', 0), 1)
  assert.equal(changedSpan('same', 'same'), undefined)
  assert.deepEqual(changedSpan('a\nb\nc', 'a\nB\nc'), { from: 2, to: 3 })
  assert.deepEqual(changedSpan('ac', 'abbc'), { from: 1, to: 3 }, 'a span of the new text')
  assert.deepEqual(changedSpan('a\nb\nc', 'a\nc'), { from: 2, to: 2 }, 'a deletion: an empty span where the text went')
})

// ---- outside changes: the decision table (outside.ts)

const tab = (over: Partial<OpenFile> = {}): OpenFile => ({ path: 'a.ts', text: 'base', disk: 'base', dirty: false, rev: 0, ...over })

test('decideDiskChange: the table', () => {
  assert.equal(decideDiskChange(tab(), undefined), 'deleted')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'mine' }), undefined), 'deleted')
  assert.equal(decideDiskChange(tab(), 'base'), 'none', 'the text the tab last knew: our own save, an accepted diff, a touch')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'mine' }), 'base'), 'none')
  assert.equal(decideDiskChange(tab(), 'theirs'), 'reload')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'theirs' }), 'theirs'), 'clean')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'mine' }), 'theirs'), 'conflict')
  assert.equal(decideDiskChange(tab({ disk: undefined }), 'base'), 'reload', 'no known disk text: a clean tab takes the disk text')
})

test('decideDiskChange: a difference in line breaks alone is nothing new for a tab with unsaved edits', () => {
  // the accept flow: the tab took the accepted text with \n, the CLI writes it with the CRLF the file had
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'a\nb\nmine', disk: 'a\nb\n' }), 'a\r\nb\r\n'), 'none')
  assert.equal(decideDiskChange(tab({ text: 'a\nb\n', disk: 'a\nb\n' }), 'a\r\nb\r\n'), 'reload', 'a clean tab takes the CRLF text; the editor shows no change')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'mine', disk: 'a\nb\n' }), 'a\r\nB\r\n'), 'conflict', 'more than line breaks')
  assert.equal(decideDiskChange(tab({ dirty: true, text: 'mine', disk: undefined }), 'a\r\nb'), 'conflict', 'nothing known to compare with')
  const conflict = tab({ dirty: true, text: 'mine', disk: 'a\nb\n', diskChanged: true, diskText: 'theirs' })
  assert.deepEqual(withDisk(conflict, 'a\r\nb\r\n'), tab({ dirty: true, text: 'mine', disk: 'a\nb\n' }), 'back to what the tab knew, in CRLF: the bar goes')
})

test('withDisk: what the tab becomes; the same object when nothing changes', () => {
  const clean = tab()
  assert.equal(withDisk(clean, 'base'), clean, 'equal: no-op, no rev bump')
  const r = withDisk(clean, 'theirs')
  assert.deepEqual(r, { path: 'a.ts', text: 'theirs', disk: 'theirs', dirty: false, rev: 1 })
  const dirty = tab({ dirty: true, text: 'mine' })
  const c = withDisk(dirty, 'theirs')
  assert.deepEqual(c, { ...dirty, diskChanged: true, diskText: 'theirs' }, 'the buffer is kept, the bar shows')
  assert.equal(withDisk(c, 'theirs'), c, 'the same conflict again: unchanged')
  assert.deepEqual(withDisk(c, 'base'), dirty, 'the disk went back to what the tab knew: the bar goes')
  assert.deepEqual(withDisk(tab({ dirty: true, text: 'theirs' }), 'theirs'), tab({ text: 'theirs', disk: 'theirs' }), 'the edits are on disk now: clean')
  const gone = withDisk(dirty, undefined)
  assert.deepEqual(gone, { ...dirty, deleted: true })
  assert.equal(withDisk(gone, undefined), gone)
  assert.deepEqual(withDisk(withDisk(clean, undefined), 'base'), clean, 'deleted, then back as it was: unmarked')
  assert.deepEqual(withDisk(withDisk(clean, undefined), 'new'), { ...clean, text: 'new', disk: 'new', rev: 1 }, 'deleted, then back changed: a clean tab reloads')
})

test('reloaded and keptMine', () => {
  const clean = tab()
  assert.equal(reloaded(clean, 'base'), clean, 'an equal reload is a no-op (the accept flow then the watcher)')
  assert.deepEqual(reloaded(tab({ dirty: true, text: 'mine' }), 'accepted'), { ...clean, text: 'accepted', disk: 'accepted', rev: 1 })
  assert.deepEqual(reloaded(tab({ dirty: true, text: 'same' }), 'same'), { ...clean, text: 'same', disk: 'same' }, 'equal text: clean, no rev bump')
  assert.deepEqual(reloaded(tab({ diskChanged: true, diskText: 'x', dirty: true, text: 'mine' }), 'x'), { ...clean, text: 'x', disk: 'x', rev: 1 })
  const conflict = tab({ dirty: true, text: 'mine', diskChanged: true, diskText: 'theirs' })
  assert.deepEqual(keptMine(conflict), tab({ dirty: true, text: 'mine', disk: 'theirs' }), 'the disk version counts as seen')
  assert.equal(decideDiskChange(keptMine(conflict), 'theirs'), 'none', 'the same disk text does not ask again')
  assert.equal(decideDiskChange(keptMine(conflict), 'newer'), 'conflict', 'a further change does')
  const { disk: _disk, ...rest } = tab({ dirty: true })
  assert.deepEqual(keptMine(tab({ deleted: true })), rest, 'deleted, kept: unsaved edits')
  assert.equal(keptMine(clean), clean)
})

// ---- fading marks (flash.ts)

test('flash: a read washes whole lines, an edit marks text (or lines), one of each kind, mapped and expired', () => {
  let state = EditorState.create({ doc: five, extensions: [flashField] })
  const lines = (kind: 'read' | 'edit') => {
    const out: number[] = []
    state.field(flashField)[kind]?.deco.between(0, state.doc.length, from => void out.push(state.doc.lineAt(from).number))
    return out
  }
  state = state.update({ effects: flashEffect({ kind: 'read', from: 4, to: 13, lines: true }, 1000) }).state
  assert.deepEqual(lines('read'), [2, 3])
  assert.equal(state.field(flashField).read?.until, 1000 + FLASH_MS.read)
  state = state.update({ effects: flashEffect({ kind: 'read', from: 19, to: 23, lines: true }, 1000) }).state
  assert.deepEqual(lines('read'), [5], 'a new read wash replaces the old one')
  state = state.update({ effects: flashEffect({ kind: 'edit', from: 8, to: 11, lines: false }, 2000) }).state
  const marks: [number, number][] = []
  state.field(flashField).edit?.deco.between(0, state.doc.length, (from, to) => void marks.push([from, to]))
  assert.deepEqual(marks, [[8, 11]])
  assert.deepEqual(lines('read'), [5], 'both kinds at once')
  // typing before the marks moves them
  state = state.update({ changes: { from: 0, insert: 'zero\n' } }).state
  const moved: [number, number][] = []
  state.field(flashField).edit?.deco.between(0, state.doc.length, (from, to) => void moved.push([from, to]))
  assert.deepEqual(moved, [[13, 16]])
  assert.deepEqual(lines('read'), [6])
  assert.equal(nextExpiry(state.field(flashField)), 1000 + FLASH_MS.read)
  const before = state.field(flashField)
  state = state.update({ effects: expireEffect(1000) }).state
  assert.equal(state.field(flashField), before, 'nothing due: the same value')
  state = state.update({ effects: expireEffect(1000 + FLASH_MS.read) }).state
  assert.equal(state.field(flashField).read, undefined, 'the read wash is gone at its time')
  assert.ok(state.field(flashField).edit, 'the edit mark lasts longer')
  state = state.update({ effects: expireEffect(2000 + FLASH_MS.edit) }).state
  assert.deepEqual(state.field(flashField), {})
  assert.equal(nextExpiry(state.field(flashField)), undefined)
})

test('flashRanges: clamped to the document; an empty text range marks its line', () => {
  const doc = EditorState.create({ doc: five }).doc
  assert.equal(flashRanges(doc, { kind: 'read', from: 0, to: 999, lines: true }).length, 5)
  assert.equal(flashRanges(doc, { kind: 'edit', from: 4, to: 4, lines: false }).length, 1)
  assert.deepEqual(flashRanges(doc, { kind: 'edit', from: 500, to: 900, lines: false }).map(r => r.from), [19], 'past the end: the last line')
  assert.deepEqual(flashRanges(doc, { kind: 'edit', from: 7, to: 4, lines: false }).map(r => [r.from, r.to]), [[4, 7]], 'reversed')
})

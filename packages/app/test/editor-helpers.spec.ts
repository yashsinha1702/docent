// Runs the renderer's pure helpers under Node 22 (strip-only TypeScript): the path jail, the
// 0-based selection conversions, the at_mentioned payload and openFile's text-pattern selection.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { absolute, basename, normalise, relativeTo } from '../src/renderer/src/editor/paths.ts'
import { atMentionOf, findRange, selectionInfo } from '../src/renderer/src/editor/selection.ts'

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

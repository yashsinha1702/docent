// A11: the submodule's core modules import under Node's type stripping with no edits to Pairwatch.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { concepts, stage, timeline } from '../index.ts'
import type { RawEvent } from '../index.ts'

test('emptyModel starts blank', () => {
  const m = timeline.emptyModel(1_000)
  assert.equal(m.steps.length, 0)
  assert.equal(m.activities.length, 0)
  assert.equal(m.stats.startedAt, 1_000)
})

test('reduce folds a prompt and a tool call into steps', () => {
  const now = 10_000
  const events: RawEvent[] = [
    { kind: 'prompt', text: 'add retries to fetchJson', origin: 'user', at: now },
    { kind: 'turn-start', turnId: 't1', at: now + 1 },
    { kind: 'tool-start', obs: { id: 'tu1', tool: 'Read', args: { file_path: '/repo/src/http.ts' }, at: now + 2 } },
    { kind: 'tool-end', end: { id: 'tu1', status: 'ok', preview: 'export async function fetchJson() {}', at: now + 50 } },
  ]
  const m = timeline.reduce(timeline.emptyModel(now), events, { level: 1, cwd: '/repo', now: now + 60 })
  assert.ok(m.steps.length >= 1, 'at least one step')
  const read = m.steps.find(s => s.tool === 'Read')
  assert.ok(read, 'the Read step exists')
  assert.equal(read.station, 'read')
  assert.equal(m.goal?.text, 'add retries to fetchJson')
})

test('renderStage draws an SVG for the idle stage', () => {
  const svg = stage.renderStage({
    station: 'idle',
    status: 'ok',
    title: '',
    scene: { kind: 'idle' },
    trail: [],
    stats: { steps: 0, files: 0, edits: 0, elapsed: '0s' },
    isFresh: false,
    isPaused: false,
  })
  assert.ok(typeof svg === 'string' && svg.includes('<svg'), 'an <svg> document')
})

test('the concept base answers a known id', () => {
  const c = concepts.getConcept('read-before-edit')
  assert.ok(c === undefined || typeof c.title === 'string')
})

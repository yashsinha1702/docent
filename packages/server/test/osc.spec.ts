import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OscParser } from '../src/pty/osc.ts'
import type { OscEvent } from '../src/pty/osc.ts'

const collect = () => {
  const events: OscEvent[] = []
  return { events, parser: new OscParser(e => events.push(e)) }
}

test('titles with BEL and ST terminators', () => {
  const { events, parser } = collect()
  parser.feed('\x1b]0;claude\x07plain text\x1b]2;two\x1b\\')
  assert.deepEqual(events, [
    { kind: 'title', title: 'claude' },
    { kind: 'title', title: 'two' },
  ])
})

test('the status probe, split across chunks', () => {
  const { events, parser } = collect()
  parser.feed('abc\x1b]75')
  parser.feed('01;?\x1b\\def')
  assert.deepEqual(events, [{ kind: 'status-probe' }])
})

test('a status payload', () => {
  const { events, parser } = collect()
  parser.feed('\x1b]7501;state=working:kind=tool\x07')
  assert.deepEqual(events, [{ kind: 'status', raw: 'state=working:kind=tool' }])
})

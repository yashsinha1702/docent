import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROGRAM_STATUS_REPLY, parseProgramStatus } from '../src/pty/status.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

test('the probe reply is an OSC 7501 whose payload starts with ?', () => {
  assert.equal(PROGRAM_STATUS_REPLY, '\x1b]7501;?\x1b\\')
})

test('working with progress and a base64 message', () => {
  assert.deepEqual(parseProgramStatus(`state=working:app=claude-code:progress=40:msg=${b64('Running tests')}`, 5), {
    state: 'working',
    id: '',
    app: 'claude-code',
    progress: 40,
    msg: 'Running tests',
    at: 5,
  })
})

test('blocked on a permission prompt, a task id, UTF-8 title', () => {
  assert.deepEqual(parseProgramStatus(`state=blocked:app=claude-code:id=t1:kind=permission:title=${b64('शादी ✓')}`, 1), {
    state: 'blocked',
    id: 't1',
    app: 'claude-code',
    kind: 'permission',
    title: 'शादी ✓',
    at: 1,
  })
})

test('a bare clear clears everything; a clear with an id clears one task', () => {
  assert.deepEqual(parseProgramStatus('state=clear', 2), { state: 'clear', at: 2 })
  assert.deepEqual(parseProgramStatus('state=clear:id=abc', 2), { state: 'clear', id: 'abc', at: 2 })
})

test('unknown states, junk and bad base64 are tolerated', () => {
  assert.equal(parseProgramStatus('state=dancing:app=claude-code', 0), undefined)
  assert.equal(parseProgramStatus('?', 0), undefined)
  assert.equal(parseProgramStatus('', 0), undefined)
  assert.deepEqual(parseProgramStatus('state=done:msg=@@@:progress=250', 0), { state: 'done', id: '', at: 0, progress: 100 })
})

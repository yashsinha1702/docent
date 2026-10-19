import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildClaudeArgs, buildClaudeEnv } from '../src/claude/spawn.ts'

test('the env drops inherited Claude Code markers and names the terminal', () => {
  const env = buildClaudeEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SSE_PORT: '1234', HOME: '/home/x' }, { path: '/usr/bin' })
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
  assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined)
  assert.equal(env.HOME, '/home/x')
  assert.equal(env.TERM_PROGRAM, 'docent')
  assert.equal(env.PATH, '/usr/bin')
})

test('args mint a session id and pass the plugin dir', () => {
  const { args, sessionId } = buildClaudeArgs({ pluginDir: '/x/pairwatch' })
  assert.match(sessionId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(args, ['--session-id', sessionId, '--plugin-dir', '/x/pairwatch'])
})

test('resume replaces the session id', () => {
  const { args } = buildClaudeArgs({ resume: 'abc' })
  assert.deepEqual(args, ['--resume', 'abc'])
})

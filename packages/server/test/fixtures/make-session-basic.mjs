// Writes session-basic.jsonl and session-basic/subagents/agent-<id>.jsonl next to this file: a made-up
// Claude Code session (2.1.30x row shapes) for test/sessions.spec.ts. Nothing here comes from a real
// session. Run from packages/server: node test/fixtures/make-session-basic.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.argv[2] ?? dirname(fileURLToPath(import.meta.url))
const SID = '5f1c2a9e-7b3d-4e8f-9a6b-0c1d2e3f4a5b'
const AGENT = 'a3f9c27e51b04d68'
const CWD = '/tmp/demo-repo'
const MODEL = 'claude-opus-5-5'
const HELPER_MODEL = 'claude-haiku-4-5'
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
const t = s => new Date(T0 + Math.round(s * 1000)).toISOString()

let parent = null
const base = (type, uuid, s, extra = {}) => {
  const row = { parentUuid: parent, isSidechain: false, userType: 'external', cwd: CWD, sessionId: SID, version: '2.1.302', gitBranch: 'main', entrypoint: 'cli', type, uuid, timestamp: t(s), ...extra }
  parent = uuid
  return row
}
const usage = (input, cacheWrite, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output, service_tier: 'standard' })
const assistant = (uuid, s, id, block, u, extra = {}, model = MODEL) =>
  base('assistant', uuid, s, { requestId: `req_${id}`, message: { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : null, stop_sequence: null, usage: u }, ...extra })
const prompt = (uuid, s, text) => base('user', uuid, s, { message: { role: 'user', content: text }, promptSource: 'typed', origin: { kind: 'human' }, permissionMode: 'default', promptId: `p-${uuid}` })
const result = (uuid, s, toolUseId, content, extra = {}, isError) =>
  base('user', uuid, s, { message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError === undefined ? {} : { is_error: isError }) }] }, sourceToolAssistantUUID: parent, ...extra })
const thinking = text => ({ type: 'thinking', thinking: text, signature: 'c2lnbmF0dXJl' })
const text = s => ({ type: 'text', text: s })
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } })

const FILE = `${CWD}/src/math.ts`
const AGENT_PROMPT = 'Find every caller of divide() outside src/math.ts and say whether any of them can pass 0 as the divisor.'
const ANSWER = 'Only src/stats.ts calls divide(), and mean() returns early on an empty array, so it never passes 0.'
const FAIL = '> demo-repo@1.0.0 test\n> node --test\n\n✔ divide(6, 3) is 2 (0.4ms)\n✖ divide(1, 0) throws (0.6ms)\n  AssertionError [ERR_ASSERTION]: Missing expected exception.\nℹ tests 4\nℹ pass 3\nℹ fail 1'
const PASS = '> demo-repo@1.0.0 test\n> node --test\n\nℹ tests 4\nℹ pass 4\nℹ fail 0'

const main = []
main.push({ type: 'permission-mode', permissionMode: 'default', sessionId: SID })
main.push({ type: 'file-history-snapshot', messageId: 'u1', snapshot: { messageId: 'u1', trackedFileBackups: {}, timestamp: t(0) }, isSnapshotUpdate: false })
// turn 1
main.push(prompt('u1', 0, 'Fix the failing test in src/math.ts'))
main.push(base('attachment', 'att1', 0.1, { attachment: { type: 'ide_selection', filename: FILE } }))
main.push(assistant('a1', 3, 'msg_01', thinking('A test fails in src/math.ts. I should find the test and the function it covers before changing anything.'), usage(1200, 5000, 0, 10)))
main.push(assistant('a2', 3.4, 'msg_01', text("I'll find the failing test first."), usage(1200, 5000, 0, 40)))
main.push(assistant('a3', 3.8, 'msg_01', tool('toolu_grep', 'Grep', { pattern: 'divide', path: 'src', output_mode: 'content', '-n': true }), usage(1200, 5000, 0, 85)))
main.push(result('r1', 4.2, 'toolu_grep', 'src/math.ts:12:export function divide(a: number, b: number): number {\nsrc/math.test.ts:8:  assert.equal(divide(6, 3), 2)', { toolUseResult: { mode: 'content', numFiles: 2, filenames: [], numLines: 2 } }))
main.push({ type: 'api-request', id: 'req_msg_02', sessionId: SID, timestamp: t(4.3), params: { model: MODEL, max_tokens: 32000 } })
main.push(assistant('a4', 5.5, 'msg_02', tool('toolu_read', 'Read', { file_path: FILE, offset: 10, limit: 20 }), usage(1500, 400, 5000, 60)))
main.push(result('r2', 5.6, 'toolu_read', '    10\t\n    11\t/** a / b */\n    12\texport function divide(a: number, b: number): number {\n    13\t  return a * b\n    14\t}', { toolUseResult: { type: 'text', file: { filePath: FILE, numLines: 5, startLine: 10, totalLines: 29 } } }))
main.push(assistant('a5', 7, 'msg_03', thinking('divide() multiplies instead of dividing: that is the bug.'), usage(2100, 300, 5400, 30)))
main.push(assistant('a6', 8, 'msg_03', tool('toolu_edit', 'Edit', { file_path: FILE, old_string: '  return a * b', new_string: '  return a / b', replace_all: false }), usage(2100, 300, 5400, 120)))
main.push(result('r3', 8.4, 'toolu_edit', "The file /tmp/demo-repo/src/math.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    13\t  return a / b", { toolUseResult: { filePath: FILE, oldString: '  return a * b', newString: '  return a / b', replaceAll: false, userModified: false, structuredPatch: [] } }))
main.push(assistant('a7', 9.5, 'msg_04', tool('toolu_test1', 'Bash', { command: 'npm test', description: 'Run the test suite' }), usage(2300, 200, 5700, 45)))
main.push(result('r4', 12.5, 'toolu_test1', `Exit code 1\n${FAIL}`, { toolUseResult: { stdout: FAIL, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }, true))
main.push(assistant('a8', 14, 'msg_05', text("One test still fails: divide(1, 0) should throw. I'll add a guard."), usage(2900, 250, 5900, 30)))
main.push(assistant('a9', 15, 'msg_05', tool('toolu_edit2', 'Edit', { file_path: FILE, old_string: '  return a / b', new_string: "  if (b === 0) throw new RangeError('division by zero')\n  return a / b", replace_all: false }), usage(2900, 250, 5900, 140)))
main.push(result('r5', 15.3, 'toolu_edit2', "The file /tmp/demo-repo/src/math.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n    13\t  if (b === 0) throw new RangeError('division by zero')\n    14\t  return a / b"))
main.push(assistant('a10', 16.5, 'msg_06', tool('toolu_test2', 'Bash', { command: 'npm test', description: 'Run the tests again' }), usage(3200, 150, 6150, 40)))
main.push(result('r6', 19, 'toolu_test2', PASS, { toolUseResult: { stdout: PASS, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }, false))
main.push(assistant('a11', 20, 'msg_07', tool('toolu_agent', 'Agent', { description: 'Check other callers of divide', prompt: AGENT_PROMPT, subagent_type: 'Explore' }), usage(3500, 100, 6300, 90)))
main.push(result('r7', 24.5, 'toolu_agent', [{ type: 'text', text: ANSWER }], { toolUseResult: { status: 'completed', agentId: AGENT, prompt: AGENT_PROMPT, content: [{ type: 'text', text: ANSWER }], totalDurationMs: 4200, totalTokens: 2650, totalToolUseCount: 2 } }))
main.push(assistant('a12', 26, 'msg_08', tool('toolu_commit', 'Bash', { command: 'git commit -am "Fix divide and guard against zero"', description: 'Commit the fix' }), usage(3900, 120, 6400, 50)))
main.push(result('r8', 29, 'toolu_commit', 'Permission to use Bash has been denied: committing needs the person\'s approval in this mode. Ask them to commit.', { toolDenialKind: 'automode-blocked', toolUseResult: 'Error: Permission to use Bash has been denied.' }, true))
main.push(assistant('a13', 31, 'msg_09', text('Fixed: divide() now divides, and it throws a RangeError on a zero divisor. All 4 tests pass. I did not commit: the commit needs your OK.'), usage(4300, 0, 6520, 70), {}))
main[main.length - 1].message.stop_reason = 'end_turn'
main.push(base('system', 'd1', 31.5, { subtype: 'turn_duration', durationMs: 31500, messageCount: 24, isMeta: false }))
main.push({ type: 'last-prompt', lastPrompt: 'Fix the failing test in src/math.ts', sessionId: SID })
// a row written twice (the CLI rewrites rows when a session resumes): read once
main.push(main.find(r => r.uuid === 'u1'))
// turn 2: a system reminder, a prompt, an interrupt, and the CLI's own reply
main.push(base('user', 'm1', 58, { isMeta: true, message: { role: 'user', content: '<system-reminder>The user opened src/math.test.ts in the IDE.</system-reminder>' } }))
main.push(prompt('u2', 60, 'Now add a test for divide(-6, 3)'))
main.push(assistant('b1', 62, 'msg_10', thinking('A negative dividend should give a negative result.'), usage(4800, 500, 6520, 25)))
main.push(assistant('b2', 63, 'msg_10', tool('toolu_write', 'Write', { file_path: `${CWD}/test/divide-negative.test.ts`, content: "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\nimport { divide } from '../src/math.ts'\n\ntest('divide(-6, 3) is -2', () => assert.equal(divide(-6, 3), -2))\n" }), usage(4800, 500, 6520, 160)))
main.push(result('r9', 63.3, 'toolu_write', 'File created successfully at: /tmp/demo-repo/test/divide-negative.test.ts'))
main.push(base('user', 'i1', 66, { message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))
main.push(assistant('s1', 66.1, 'msg_synthetic', text('No response requested.'), usage(3, 0, 0, 7), {}, '<synthetic>'))
// turn 3: a local command and its output
main.push(base('user', 'c0', 80, { isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } }))
main.push(base('user', 'c1', 80, { message: { role: 'user', content: '<command-name>/cost</command-name>\n            <command-message>cost</command-message>\n            <command-args></command-args>' } }))
main.push(base('user', 'c2', 80.2, { message: { role: 'user', content: '<local-command-stdout>Total cost:            $0.21\nTotal duration (API):  41s</local-command-stdout>' } }))
main.push(base('system', 'c3', 80.2, { subtype: 'local_command', content: '<command-name>/cost</command-name>', level: 'info', isMeta: false }))

// the helper's own transcript
parent = null
const helper = []
const side = (row) => ({ ...row, isSidechain: true, agentId: AGENT })
helper.push(side(base('user', 'h1', 20.3, { message: { role: 'user', content: AGENT_PROMPT } })))
helper.push(side(assistant('h2', 21.5, 'msg_a1', tool('toolu_a_grep', 'Grep', { pattern: 'divide\\(', path: CWD, glob: '*.ts', output_mode: 'content' }), usage(800, 1200, 0, 50), {}, HELPER_MODEL)))
helper.push(side(result('h3', 21.8, 'toolu_a_grep', 'src/math.ts:12:export function divide(a: number, b: number): number {\nsrc/stats.ts:4:  return divide(total, values.length)')))
helper.push(side(assistant('h4', 22.5, 'msg_a2', tool('toolu_a_read', 'Read', { file_path: `${CWD}/src/stats.ts` }), usage(1100, 0, 1200, 40), {}, HELPER_MODEL)))
helper.push(side(result('h5', 22.6, 'toolu_a_read', '     1\texport function mean(values: number[]): number {\n     2\t  if (values.length === 0) return 0\n     3\t  const total = values.reduce((s, v) => s + v, 0)\n     4\t  return divide(total, values.length)\n     5\t}')))
helper.push(side(assistant('h6', 24, 'msg_a3', text(ANSWER), usage(1500, 0, 1200, 60), {}, HELPER_MODEL)))

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
mkdirSync(join(OUT, 'session-basic', 'subagents'), { recursive: true })
writeFileSync(join(OUT, 'session-basic.jsonl'), jsonl(main))
writeFileSync(join(OUT, 'session-basic', 'subagents', `agent-${AGENT}.jsonl`), jsonl(helper))

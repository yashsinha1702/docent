// Replays the synthetic session in packages/server/test/fixtures into a temporary CLAUDE_CONFIG_DIR while
// the built app runs in DOCENT_SMOKE=feed mode, so the live feed, the steps strip, file heat and follow
// mode get real updates without running claude. Edits and writes in the transcript are applied to a
// scratch workspace when their tool call is written, as Claude Code would.
//
// npm run build, then: node scripts/smoke-feed.mjs [capture.png]
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'packages', 'app')
const FIXTURES = join(ROOT, 'packages', 'server', 'test', 'fixtures')
// the fixture's own constants (make-session-basic.mjs)
const SID = '5f1c2a9e-7b3d-4e8f-9a6b-0c1d2e3f4a5b'
const AGENT = 'a3f9c27e51b04d68'
const FIXTURE_CWD = '/tmp/demo-repo'
const FIXTURE_T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
/** the window and its first terminal come up before the first row is written */
const LEAD_MS = 5000
/** a fixture second lasts this long in the replay: its 80 s run in 8 s */
const MS_PER_S = 100
const WAIT_MS = LEAD_MS + 81 * MS_PER_S + 6000

// the bug the session fixes: divide multiplies (its Edit's old_string must occur once)
const MATH = [
  '// Small arithmetic helpers used by stats.ts.',
  '//',
  '// Every function takes two numbers and returns a number.',
  '',
  'export function add(a: number, b: number): number {',
  '  return a + b',
  '}',
  '',
  'export function subtract(a: number, b: number): number {',
  '  return a - b',
  '}',
  '',
  'export function divide(a: number, b: number): number {',
  '  return a * b',
  '}',
  '',
].join('\n')
const STATS = [
  "import { divide } from './math.ts'",
  '',
  'export function mean(xs: number[]): number {',
  '  if (xs.length === 0) return 0',
  '  return divide(xs.reduce((a, b) => a + b, 0), xs.length)',
  '}',
  '',
].join('\n')

const shot = process.argv[2] ? resolve(process.argv[2]) : ''
if (!existsSync(join(APP, 'out', 'main', 'index.js'))) {
  console.error('smoke-feed: build first (npm run build)')
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), 'docent-feed-'))
const created = join(dir, 'demo-repo')
mkdirSync(join(created, 'src'), { recursive: true })
writeFileSync(join(created, 'src', 'math.ts'), MATH)
writeFileSync(join(created, 'src', 'stats.ts'), STATS)
writeFileSync(join(created, 'package.json'), '{ "name": "demo-repo", "version": "1.0.0", "type": "module" }\n')
// the app realpaths its root, and paths in the transcript must compare equal to it
const ws = realpathSync(created)
const config = join(dir, 'config')
const project = join(config, 'projects', '-demo-repo')
const mainFile = join(project, `${SID}.jsonl`)
const helperFile = join(project, SID, 'subagents', `agent-${AGENT}.jsonl`)

/** The fixture's rows with the scratch workspace in place of its cwd, each with its offset from the fixture's start. */
function rows(file, target) {
  const cwd = JSON.stringify(ws).slice(1, -1)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const row = JSON.parse(line.split(FIXTURE_CWD).join(cwd))
      const offset = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) - FIXTURE_T0 : 0
      return { row, offset, target }
    })
}

/** What the tool call in an assistant row does to the workspace, done now. */
function applyTool(row) {
  const blocks = Array.isArray(row.message?.content) ? row.message.content : []
  for (const b of blocks) {
    const input = b?.input
    if (b?.type !== 'tool_use' || typeof input?.file_path !== 'string' || !input.file_path.startsWith(`${ws}/`)) continue
    if (b.name === 'Write' && typeof input.content === 'string') {
      mkdirSync(dirname(input.file_path), { recursive: true })
      writeFileSync(input.file_path, input.content)
    } else if (b.name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' && existsSync(input.file_path)) {
      const text = readFileSync(input.file_path, 'utf8')
      writeFileSync(input.file_path, input.replace_all === true ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string))
    }
  }
}

const plan = [...rows(join(FIXTURES, 'session-basic.jsonl'), mainFile), ...rows(join(FIXTURES, 'session-basic', 'subagents', `agent-${AGENT}.jsonl`), helperFile)].sort((a, b) => a.offset - b.offset)
const timers = []
const start = Date.now() + LEAD_MS
for (const { row, offset, target } of plan) {
  const when = start + (offset / 1000) * MS_PER_S
  timers.push(
    setTimeout(() => {
      if (typeof row.timestamp === 'string') row.timestamp = new Date(when).toISOString()
      if (row.type === 'assistant') applyTool(row)
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${JSON.stringify(row)}\n`)
    }, when - Date.now()),
  )
}

const electron = createRequire(join(APP, 'package.json'))('electron')
const env = { ...process.env, DOCENT_SMOKE: 'feed', DOCENT_SMOKE_SID: SID, DOCENT_SMOKE_WAIT: String(WAIT_MS), DOCENT_WORKSPACE: ws, CLAUDE_CONFIG_DIR: config, DOCENT_SMOKE_SHOT: shot }
const child = spawn(electron, [APP], { env, stdio: 'inherit' })
const watchdog = setTimeout(() => {
  console.error('smoke-feed: the app did not quit in time; killing it')
  child.kill('SIGKILL')
}, WAIT_MS + 30000)
child.on('exit', code => {
  clearTimeout(watchdog)
  for (const t of timers) clearTimeout(t)
  rmSync(dir, { recursive: true, force: true })
  console.log(`smoke-feed: app exited ${code}; replayed ${plan.length} rows`)
  process.exit(code ?? 1)
})

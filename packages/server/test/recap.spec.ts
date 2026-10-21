// The recap document, built from a model that Pairwatch's own reducer folds from synthetic events.
// Every path and secret below is made up; the secrets are assembled from pieces so no scanner flags the repo.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { timeline } from '@docent/core'
import type { RawEvent, SessionModel } from '@docent/core'

import type { Snapshot } from '../src/pairwatch/types.ts'
import { renderRecapHtml } from '../src/recap/index.ts'
import type { RecapInput } from '../src/recap/index.ts'
import { CSP, folderName, isSafeSvg, pathScrubber, relativeTo, renderRecap } from '../src/recap/render.ts'
import type { SessionUsage } from '../src/sessions/types.ts'

const CWD = '/srv/work/demo-api'
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0)
const FAKE_KEY = ['sk', 'ant', 'api03', 'Zx9QwEr7' + 'TyUi3OpAs5Df'].join('-')
const FAKE_GH = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8' + 'I9j0K1l2M3n4'
const SVG_NS = ['http', '://www.w3.org/2000/svg'].join('')

const start = (id: string, tool: string, args: { [k: string]: unknown }, at: number): RawEvent => ({ kind: 'tool-start', obs: { id, tool, args, at: T0 + at } })
const end = (id: string, status: 'ok' | 'error', preview: string, at: number): RawEvent => ({ kind: 'tool-end', end: { id, status, preview, at: T0 + at } })

const EVENTS: RawEvent[] = [
  { kind: 'prompt', text: 'add retries with backoff to fetchJson in src/http.ts and cover it in tests', origin: 'user', at: T0 },
  { kind: 'turn-start', turnId: 'turn-1', at: T0 + 10 },
  start('tu1', 'Read', { file_path: `${CWD}/src/http.ts` }, 1_000),
  end('tu1', 'ok', 'export async function fetchJson(url: string) {}', 1_400),
  start('tu2', 'Read', { file_path: '/home/ana/.npmrc' }, 2_000),
  end('tu2', 'ok', 'registry=', 2_100),
  start('tu3', 'Grep', { pattern: 'fetchJson(', path: `${CWD}/src` }, 3_000),
  end('tu3', 'ok', 'src/a.ts:3\nsrc/b.ts:9', 3_200),
  start('tu4', 'Edit', { file_path: `${CWD}/src/http.ts`, old_string: 'return get(url)', new_string: 'return retry(() => get(url))' }, 15_000),
  end('tu4', 'ok', 'The file was updated', 15_500),
  start('tu5', 'Bash', { command: `cd ${CWD} && API_TOKEN=${FAKE_KEY} npm test`, description: 'Compare <old> and <new> output' }, 30_000),
  end('tu5', 'error', 'FAIL src/http.test.ts', 40_000),
  { kind: 'turn-end', turnId: 'turn-1', durationMs: 60_000, answer: 'Added retries with backoff; one test still fails.', reason: 'answer', at: T0 + 60_000 },
]

const counts = (input: number, output: number, cacheRead: number, cacheWrite: number, messages: number) => ({ input, output, cacheRead, cacheWrite, messages })
const USAGE: SessionUsage = {
  total: counts(38_123, 2_101, 120_034, 5_012, 9),
  turn: counts(0, 0, 0, 0, 0),
  byModel: { 'claude-opus-4-5': counts(30_000, 2_000, 120_034, 5_012, 7), 'claude-haiku-4-5': counts(8_123, 101, 0, 0, 2) },
}

function fold(events: readonly RawEvent[] = EVENTS, cwd = CWD): SessionModel {
  const m = timeline.reduce(timeline.emptyModel(T0), events, { level: 1, cwd, now: T0 + 60_000 })
  return timeline.settleHop(m, T0 + 70_000)
}

function inputOf(model: SessionModel, extra: Partial<RecapInput> = {}): RecapInput {
  return { update: { sid: '0f1e2d3c-4b5a-4968-8776-655443322110', model, inputs: {}, usage: USAGE, at: T0 + 60_000 }, cwd: CWD, generatedAt: T0 + 70_000, version: '0.0.1', ...extra }
}

/** The stage picture inside the page, decoded. */
function stageSvg(html: string): string {
  const b64 = /<img src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/.exec(html)?.[1]
  assert.ok(b64, 'the page carries the stage as a data: image')
  return Buffer.from(b64, 'base64').toString('utf8')
}

const VOID = new Set(['meta', 'img', 'br', 'hr', 'link', 'input', 'source', 'col', 'wbr'])
/** Tags that close out of order, or never: [] when the document nests cleanly. */
function nestingProblems(html: string): string[] {
  const stack: string[] = []
  const problems: string[] = []
  for (const m of html.replace(/<style>[\s\S]*?<\/style>/g, '').matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const tag = (m[2] ?? '').toLowerCase()
    if (VOID.has(tag)) continue
    if (m[1] !== '/') stack.push(tag)
    else if (stack.pop() !== tag) problems.push(`</${tag}> at ${m.index}`)
  }
  return stack.length > 0 ? [...problems, `unclosed: ${stack.join(' ')}`] : problems
}

const occurrences = (s: string, sub: string): number => s.split(sub).length - 1

test('self-contained: no scripts, no URLs, no outside references, a strict CSP', () => {
  const html = renderRecapHtml(inputOf(fold()))
  assert.match(html, /^<!doctype html>/i)
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /https?:\/\//i)
  assert.doesNotMatch(html, /<(?:link|iframe|object|embed|form|base|frame)\b|@import|url\(/i)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no event handler attributes')
  assert.doesNotMatch(html, /\shref\s*=/i)
  for (const m of html.matchAll(/\ssrc\s*=\s*"([^"]*)"/gi)) assert.match(m[1] ?? '', /^data:image\/svg\+xml;base64,/)
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`))
  assert.match(CSP, /^default-src 'none'; style-src 'unsafe-inline'; img-src data:/)
  assert.match(html, /@media \(prefers-color-scheme:dark\)/, 'light and dark themes')
})

test('secrets are masked wherever they come from: commands, notes, the title, the stage', () => {
  const model = fold()
  // a model saved before masking existed, or text from outside the reducer, must not leak either
  model.steps = model.steps.map(s => (s.id === 'tu3' ? { ...s, resultNote: `pushed with ${FAKE_GH}` } : s))
  const svg = `<svg xmlns="${SVG_NS}" viewBox="0 0 640 246" width="640" height="246"><text x="8" y="20">auth: Bearer ${FAKE_GH}</text></svg>`
  const snapshot = { svg, alt: `running with ${FAKE_KEY}` } as Snapshot
  const html = renderRecapHtml(inputOf(model, { title: `ship it with key ${FAKE_KEY}`, snapshot }))
  for (const text of [html, stageSvg(html)]) {
    assert.ok(!text.includes(FAKE_KEY) && !text.includes('TyUi3OpAs5Df'), 'the sk- key is masked')
    assert.ok(!text.includes(FAKE_GH) && !text.includes('I9j0K1l2M3n4'), 'the ghp_ token is masked')
  }
  assert.ok(html.includes('API_TOKEN=••••'), 'the label stays, the value goes')
  assert.ok(html.includes('ghp_••••'))
  assert.ok(stageSvg(html).includes('Bearer ••••'))
})

test('paths: relative to the workspace, the workspace only as its folder name, homes as ~', () => {
  const html = renderRecapHtml(inputOf(fold()))
  assert.ok(html.includes('<code>src/http.ts</code>'), 'files touched are relative')
  assert.ok(html.includes('<code class="target">src/http.ts</code>'), 'step targets are relative')
  assert.ok(html.includes('~/.npmrc'), 'a home folder reads as ~')
  assert.ok(html.includes('<code>demo-api</code>'), 'the folder name is shown')
  assert.ok(html.includes('cd demo-api &amp;&amp; API_TOKEN='), 'the workspace path in a command is its folder name')
  for (const text of [html, stageSvg(html)]) {
    assert.ok(!text.includes('/srv/work'), 'the workspace path never appears')
    assert.ok(!text.includes('/home/ana'), 'a home folder never appears')
  }
})

test('paths: this machine’s own home folder, wherever it is', () => {
  const home = '/var/lib/builder'
  const cwd = `${home}/proj`
  const model = fold([start('r1', 'Read', { file_path: `${home}/notes.txt` }, 1_000), end('r1', 'ok', 'x', 1_100), start('b1', 'Bash', { command: `ls ${cwd}/src`, description: 'List the sources' }, 2_000), end('b1', 'ok', 'a.ts', 2_100)], cwd)
  const html = renderRecap({ ...inputOf(model), cwd }, home)
  assert.ok(html.includes('~/notes.txt'))
  assert.ok(html.includes('ls proj/src'))
  assert.ok(!html.includes(home))
  assert.equal(folderName(home, home), '~', 'a workspace that is the home folder shows as ~')
})

test('path helpers: boundaries and Windows spellings', () => {
  assert.equal(relativeTo('/srv/work/demo-api/src/a.ts', CWD), 'src/a.ts')
  assert.equal(relativeTo('/srv/work/demo-api', CWD), '.')
  assert.equal(relativeTo('/srv/work/demo-api2/a.ts', CWD), undefined, 'a sibling folder is not inside')
  assert.equal(relativeTo('C:\\Users\\ana\\proj\\src\\a.ts', 'C:\\Users\\ana\\proj'), 'src/a.ts')
  assert.equal(relativeTo('c:/users/ana/proj/src/a.ts', 'C:\\Users\\ana\\proj'), 'src/a.ts')
  const scrub = pathScrubber(CWD, '/home/ana')
  assert.equal(scrub(`cat ${CWD}/a /srv/work/demo-api2/b`), 'cat demo-api/a /srv/work/demo-api2/b')
  assert.equal(scrub('cp /home/ana/x /Users/bob/y /Users/Shared/z'), 'cp ~/x ~/y /Users/Shared/z')
  assert.equal(pathScrubber('C:\\Users\\ana\\proj', 'C:\\Users\\ana')('dir C:\\Users\\ana\\proj\\src and C:/Users/ana/proj'), 'dir proj\\src and proj')
})

test('a < in a headline (or anywhere) is escaped', () => {
  const html = renderRecapHtml(inputOf(fold(), { title: 'Fix <b>bold</b> & "quotes"' }))
  assert.ok(html.includes('Compare &lt;old&gt; and &lt;new&gt; output'))
  assert.ok(!html.includes('<old>') && !html.includes('<new>'))
  assert.ok(html.includes('<h1>Fix &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;</h1>'))
})

test('the document nests cleanly, with one balanced section per part', () => {
  for (const model of [fold(), timeline.emptyModel(T0)]) {
    const html = renderRecapHtml(inputOf(model))
    assert.deepEqual(nestingProblems(html), [])
    assert.equal(occurrences(html, '<section'), 5)
    assert.equal(occurrences(html, '</section>'), 5)
    for (const id of ['stage', 'timeline', 'files', 'concepts', 'tokens']) assert.ok(html.includes(`<section id="${id}"`), id)
  }
})

test('header: the first prompt as title, date, duration, models, version', () => {
  const html = renderRecapHtml(inputOf(fold()))
  assert.ok(html.includes('<h1>add retries with backoff to fetchJson in src/http.ts and cover it in tests</h1>'))
  assert.match(html, /<dt>Duration<\/dt><dd>1m 00s<\/dd>/)
  assert.match(html, /<dt>Models<\/dt><dd><code>claude-opus-4-5<\/code>, <code>claude-haiku-4-5<\/code><\/dd>/)
  assert.match(html, /<dt>Docent<\/dt><dd>0\.0\.1<\/dd>/)
  assert.ok(html.includes(`<time datetime="${new Date(T0).toISOString()}">`))
  const long = fold([{ kind: 'prompt', text: 'word '.repeat(200), origin: 'user', at: T0 }])
  const h1 = /<h1>([^<]*)<\/h1>/.exec(renderRecapHtml(inputOf(long)))?.[1] ?? ''
  assert.ok(h1.length <= 120 && h1.endsWith('…'), 'a long prompt is cut')
})

test('timeline: every step kept, in order, with glyph, detail, note and status', () => {
  const model = fold()
  const html = renderRecapHtml(inputOf(model))
  const rows = html.match(/<tr class="st-/g) ?? []
  assert.equal(rows.length, model.steps.length)
  assert.ok(html.includes('<span title="read">📖</span>'))
  assert.ok(html.includes('<span class="status s-error">error</span>'))
  assert.ok(html.includes('<td class="note-cell">FAIL src/http.test.ts</td>'))
  assert.ok(html.indexOf('Reading http.ts') < html.indexOf('Compare &lt;old&gt;'), 'oldest first')
  assert.ok(!html.includes('Showing the last'), 'nothing was dropped')
  const long = { ...model, stats: { ...model.stats, steps: 500 } }
  assert.ok(renderRecapHtml(inputOf(long)).includes('Showing the last 5 tool steps of 500'))
})

test('concepts met: each once, with its title and short text; tokens per model and in total', () => {
  const html = renderRecapHtml(inputOf(fold()))
  assert.equal(occurrences(html, '<h3>Read before edit</h3>'), 1)
  assert.ok(html.includes('<h3>Automated tests</h3>'))
  assert.ok(html.includes('38k in · 2.1k out · 120k read from cache · 9 messages'))
  assert.match(html, /<tr class="total"><td>Total<\/td><td class="num">38,123<\/td><td class="num">2,101<\/td>/)
})

test('the stage: the mod’s picture when it is safe, Docent’s own drawing when it is not', () => {
  const model = fold()
  const safe = `<svg xmlns="${SVG_NS}" viewBox="0 0 640 246" width="640" height="246"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="9" height="9"/><text x="8" y="20">MOD-STAGE-MARK</text></svg>`
  const used = renderRecapHtml(inputOf(model, { snapshot: { svg: safe, alt: 'DONE the work' } as Snapshot }))
  assert.ok(stageSvg(used).includes('MOD-STAGE-MARK'))
  assert.ok(used.includes('alt="DONE the work"'), 'the mod’s own text stand-in describes the picture')
  const hostile = [
    safe.replace('</svg>', '<script>alert(1)</script></svg>'),
    safe.replace('<rect ', '<rect onload="alert(1)" '),
    safe.replace('</svg>', '<foreignObject><div>x</div></foreignObject></svg>'),
    safe.replace('<rect ', `<image href="${SVG_NS.replace('www.w3.org/2000/svg', 'example.com/x.png')}"/><rect `),
  ]
  for (const svg of hostile) {
    assert.equal(isSafeSvg(svg), false)
    const html = renderRecapHtml(inputOf(model, { snapshot: { svg, alt: 'x' } as Snapshot }))
    const shown = stageSvg(html)
    assert.ok(!shown.includes('MOD-STAGE-MARK') && !/<script|onload|foreignObject|example\.com/i.test(shown), 'the hostile picture is left out')
    assert.ok(isSafeSvg(shown), 'Docent drew its own')
    assert.ok(html.includes('so this is Docent’s own drawing'))
  }
  assert.equal(isSafeSvg(safe), true)
  assert.equal(isSafeSvg('<div>not svg</div>'), false)
  assert.equal(isSafeSvg(safe.replace('<svg ', '<!DOCTYPE svg><svg ')), false)
})

test('an empty session still renders every part, and odd input does not throw', () => {
  const html = renderRecapHtml(inputOf(timeline.emptyModel(T0), { update: { sid: 's', model: timeline.emptyModel(T0), inputs: {}, usage: { total: counts(0, 0, 0, 0, 0), turn: counts(0, 0, 0, 0, 0), byModel: {} }, at: T0 } }))
  assert.ok(html.includes('<h1>Claude Code session</h1>'))
  assert.ok(html.includes('No steps were recorded.'))
  assert.ok(html.includes('No token use was recorded.'))
  const odd = { update: { sid: 's', model: { steps: [null, 42], files: [{}], agents: null, stats: {} } }, cwd: '/', generatedAt: Number.NaN } as unknown as RecapInput
  assert.doesNotThrow(() => renderRecapHtml(odd))
})

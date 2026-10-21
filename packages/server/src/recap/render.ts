// The recap document: one self-contained HTML page (inline CSS, no scripts, nothing fetched) built from a
// session's model. Pure string building; index.ts supplies the home directory.
//
// Every text that came from the session (prompts, commands, paths, Claude's words, the cards' text) goes
// through clean(): the workspace path becomes its folder name, a home folder becomes '~', and Pairwatch's
// redactSecrets masks keys and passwords. Only then does esc() turn it into HTML. Always in that order.
import { Buffer } from 'node:buffer'

import { concepts, md, redact, stage, stations, timeline, view } from '@docent/core'
import type { Concept, Prefs, SessionModel, Station, Step, StepStatus } from '@docent/core'

import type { SessionUsage, TokenCounts } from '../sessions/types.ts'
import type { RecapInput } from './index.ts'

/** The stage as a finished picture: no animation, no model narration, the beginner's wording. */
const PREFS: Prefs = { level: 1, isPaused: true, useModel: false, autoOpen: false }
const STAGE_SIZE = { w: 640, h: 246 }
const TITLE_MAX = 120
const PROMPT_MAX = 300
const TARGET_MAX = 200
/** Room past a cut that the masking still sees, so a secret the cut would split is found whole. */
const MASK_MARGIN = 200

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

// ------------------------------------------------------------------ text

const esc = (s: string): string =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)
/** A Windows path in each of its slash spellings; a POSIX path as it is. */
const spellings = (p: string): string[] => (isWinPath(p) ? [...new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])] : [p])

/** Anyone's home folder, as Pairwatch's own displayPath shortens it (/Users/Shared is not a home). */
const ANY_HOME = /(?<![\w.~-])(?:\/Users\/(?!Shared(?:[/\\\s]|$))[^/\\\s"'`<>]+|\/home\/[^/\\\s"'`<>]+|\/root|[A-Za-z]:[\\/]Users[\\/][^/\\\s"'`<>]+)(?![\w.-])/g

/** The workspace's display name: its last segment, or '~' when it is the home folder itself. */
export function folderName(cwd: string, home: string): string {
  const c = trimSep(cwd)
  if (c === '') return '.'
  const h = trimSep(home)
  if (h !== '' && spellings(h).some(v => (isWinPath(v) ? v.toLowerCase() === c.toLowerCase() : v === c))) return '~'
  const parts = c.split(/[\\/]/).filter(p => p !== '')
  return parts[parts.length - 1] ?? c
}

/** Replaces the workspace path by its folder name and home folders by '~', wherever they appear in a text. */
export function pathScrubber(cwd: string, home: string): (text: string) => string {
  const rules: { re: RegExp; to: string }[] = []
  const add = (p: string, to: string): void => {
    const base = trimSep(p)
    if (base.length < 2) return // '' or '/' would match everywhere
    for (const v of spellings(base)) rules.push({ re: new RegExp(`(?<![\\w.~-])${reEsc(v)}(?![\\w.-])`, isWinPath(v) ? 'gi' : 'g'), to })
  }
  add(cwd, folderName(cwd, home))
  add(home, '~')
  return text => {
    let out = text
    for (const r of rules) out = out.replace(r.re, () => r.to)
    return out.replace(ANY_HOME, () => '~')
  }
}

/** `p` relative to the workspace ('src/a.ts', or '.' for the workspace itself); undefined when it lies outside. */
export function relativeTo(p: string, cwd: string): string | undefined {
  const base = trimSep(cwd)
  if (base.length < 2) return undefined
  for (const v of spellings(base)) {
    const win = isWinPath(v)
    const a = win ? p.toLowerCase() : p
    const b = win ? v.toLowerCase() : v
    if (a === b) return '.'
    if (a.startsWith(b + '/') || (win && a.startsWith(b + '\\'))) {
      const rest = p.slice(v.length + 1)
      return rest === '' ? '.' : win ? rest.replace(/\\/g, '/') : rest
    }
  }
  return undefined
}

type Ctx = {
  /** one line, paths shortened, secrets masked, cut to `max` when given; not yet HTML */
  clean: (s: unknown, max?: number) => string
  /** a file path for display: relative to the workspace when inside it, else shortened like any text */
  path: (p: string) => string
  scrub: (text: string) => string
}

function contextFor(cwd: string, home: string): Ctx {
  const scrub = pathScrubber(cwd, home)
  const clean = (s: unknown, max?: number): string => {
    const one = md.oneLine(s)
    if (one === '') return ''
    const masked = redact.redactSecrets(scrub(max === undefined ? one : one.slice(0, max + MASK_MARGIN)))
    return max === undefined ? masked : md.cut(masked, max)
  }
  const path = (p: string): string => clean(relativeTo(md.oneLine(p), cwd) ?? p, TARGET_MAX)
  return { clean, path, scrub }
}

// ------------------------------------------------------------------ small guards and formats

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const list = <T>(x: readonly T[] | undefined): readonly T[] => (Array.isArray(x) ? x : [])
const isTime = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0
const STATIONS: ReadonlySet<string> = new Set(Object.keys(stations.COLOR))
const stationOf = (s: unknown): Station => (typeof s === 'string' && STATIONS.has(s) ? (s as Station) : 'idle')
const STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'error', 'denied'])
const statusOf = (s: unknown): StepStatus => (typeof s === 'string' && STATUSES.has(s) ? (s as StepStatus) : 'ok')
const isObj = (x: unknown): x is { [k: string]: unknown } => !!x && typeof x === 'object' && !Array.isArray(x)
const isStep = (s: unknown): s is Step =>
  isObj(s) && typeof s.id === 'string' && typeof s.tool === 'string' && typeof s.station === 'string' && typeof s.headline === 'string' && typeof s.startedAt === 'number' && Array.isArray(s.concepts) && isObj(s.scene)

/** The model with junk entries dropped, so neither the page nor Pairwatch's stage trips over odd input. */
function tidy(m: unknown, now: number): SessionModel {
  const base = timeline.emptyModel(now)
  if (!isObj(m)) return base
  const model = m as Partial<SessionModel>
  return {
    ...base,
    ...model,
    steps: list(model.steps).filter(isStep),
    activities: list(model.activities).filter(a => isObj(a) && typeof a.id === 'string' && typeof a.station === 'string' && Array.isArray(a.stepIds)),
    files: list(model.files).filter(f => isObj(f) && typeof f.path === 'string'),
    agents: list(model.agents).filter(a => isObj(a) && typeof a.id === 'string'),
    stats: isObj(model.stats) ? { ...base.stats, ...model.stats } : base.stats,
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const clockOf = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const timeTag = (ms: number, text: string): string => `<time datetime="${new Date(ms).toISOString()}">${esc(text)}</time>`

/** 950, 12.4k, 3.1M */
function short(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
const full = (n: number): string => Math.round(n).toLocaleString('en-US')
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const section = (id: string, title: string, body: string): string =>
  `<section id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${esc(title)}</h2>${body}</section>`
const muted = (text: string): string => `<p class="muted">${esc(text)}</p>`

// ------------------------------------------------------------------ the session at a glance

// Everything below takes a model that went through tidy(): its steps, files and agents are well formed.

/** The earliest prompt the person typed that the model still holds; else their latest (model.goal). */
function firstPrompt(m: SessionModel): string | undefined {
  const s = m.steps.find(x => x.tool === '#prompt' && x.agentId === undefined && typeof x.target === 'string' && x.target.trim() !== '')
  return s?.target ?? (typeof m.goal?.text === 'string' && m.goal.text.trim() !== '' ? m.goal.text : undefined)
}

const toolSteps = (m: SessionModel): number => m.steps.filter(s => !s.tool.startsWith('#')).length

/** First and last moment of the session the model can still see. */
function spanOf(m: SessionModel): { start?: number; end?: number } {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  const see = (t: unknown, isStart: boolean): void => {
    if (!isTime(t)) return
    if (isStart) start = Math.min(start, t)
    end = Math.max(end, t)
  }
  for (const s of m.steps) {
    see(s.startedAt, true)
    see(s.endedAt, false)
  }
  see(m.turn?.startedAt, true)
  see(m.turn?.endedAt, false)
  // older steps were dropped: the model's own start is the better guess for when it all began
  if (num(m.stats.steps) > toolSteps(m)) see(m.stats.startedAt, true)
  return Number.isFinite(start) ? { start, end: Math.max(start, end) } : {}
}

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
const countsOf = (c: Partial<TokenCounts> | undefined): TokenCounts => ({
  input: num(c?.input),
  output: num(c?.output),
  cacheRead: num(c?.cacheRead),
  cacheWrite: num(c?.cacheWrite),
  messages: num(c?.messages),
})
const modelsOf = (u: SessionUsage | undefined): [string, TokenCounts][] =>
  Object.entries(u?.byModel && typeof u.byModel === 'object' ? u.byModel : {})
    .filter(([name]) => name !== '' && name !== '<synthetic>')
    .map(([name, c]): [string, TokenCounts] => [name, countsOf(c)])

// ------------------------------------------------------------------ the stage

// Markup a recap never carries: scripts, embedded documents, event handlers, DOCTYPE / entity tricks,
// and references that leave the document. Escaped text never holds a raw '<' or quote.
const UNSAFE_SVG = /<\s*(?:script|foreignObject|iframe|embed|object|handler|listener)\b|<!|\son[a-z]+\s*=\s*["']|javascript:|(?:href|src)\s*=\s*["'](?!#)|=\s*["'][^"'<>]*url\(\s*(?!["']?#)/i

/** An <svg> document fit to show: one element, under 200k characters, nothing active or external in it. */
export function isSafeSvg(svg: unknown): svg is string {
  return typeof svg === 'string' && svg.length < 200_000 && /^\s*<svg[\s>]/.test(svg) && /<\/svg>\s*$/.test(svg) && !UNSAFE_SVG.test(svg)
}

/** The picture's own size from its opening tag, so the page reserves the right box. */
function sizeOf(svg: string): { w: number; h: number } {
  const tag = /^\s*<svg\b[^>]*>/.exec(svg)?.[0] ?? ''
  const w = Number(/\swidth="(\d+(?:\.\d+)?)"/.exec(tag)?.[1])
  const h = Number(/\sheight="(\d+(?:\.\d+)?)"/.exec(tag)?.[1])
  return w > 0 && h > 0 ? { w, h } : STAGE_SIZE
}

/** The same cleaning as the page's text, inside the picture: paths everywhere, secrets in the text nodes. */
const cleanSvg = (svg: string, x: Ctx): string => x.scrub(svg).replace(/>([^<>]+)</g, (_m, t: string) => `>${redact.redactSecrets(t)}<`)

function stageSection(input: RecapInput, m: SessionModel, x: Ctx, now: number): string {
  let svg: string | undefined
  let alt = ''
  let note = ''
  const fromMod = input.snapshot?.svg
  if (typeof fromMod === 'string' && fromMod.trim() !== '') {
    if (isSafeSvg(fromMod)) {
      svg = fromMod
      alt = typeof input.snapshot?.alt === 'string' ? input.snapshot.alt : ''
    } else note = 'The stage Pairwatch saved held markup a recap never carries, so this is Docent’s own drawing.'
  }
  if (svg === undefined) {
    try {
      const si = view.stageInput(m, PREFS, now, input.cwd)
      const own = stage.renderStage(si)
      if (isSafeSvg(own)) {
        svg = own
        alt = `${stations.verbFor(si.station, si.status)} ${si.title}`
      }
    } catch {
      // a model this odd gets no picture; the rest of the page still renders
    }
  }
  if (svg === undefined) return section('stage', 'Final stage', muted('No stage to show.'))
  const { w, h } = sizeOf(svg)
  const data = Buffer.from(cleanSvg(svg, x), 'utf8').toString('base64')
  const text = x.clean(alt, 300) || 'The Pairwatch stage at the end of the session'
  return section(
    'stage',
    'Final stage',
    `<figure class="stage"><img src="data:image/svg+xml;base64,${data}" width="${w}" height="${h}" alt="${esc(text)}"></figure>` + (note ? `<p class="note">${esc(note)}</p>` : ''),
  )
}

// ------------------------------------------------------------------ the timeline

const looksLikePath = (t: string): boolean => /^(?:[~/]|[A-Za-z]:[\\/])\S*$/.test(t)

function laneLabel(m: SessionModel, agentId: string): string {
  const lane = m.agents.find(a => a.id === agentId)
  return lane ? `agent: ${lane.type ?? lane.label}` : 'agent'
}

/** What the step was about, under its headline: the person's words for a prompt, else its path or command. */
function targetLine(s: Step, x: Ctx): string {
  const target = typeof s.target === 'string' ? s.target : ''
  if (target.trim() === '') return ''
  if (s.tool === '#prompt') return `<q class="prompt">${esc(x.clean(target, PROMPT_MAX))}</q>`
  if (s.tool.startsWith('#')) return ''
  const kind = s.scene.kind
  const shown = kind === 'read' || kind === 'edit' || looksLikePath(target.trim()) ? x.path(target.trim()) : x.clean(target, TARGET_MAX)
  return shown ? `<code class="target">${esc(shown)}</code>` : ''
}

function stepRow(s: Step, m: SessionModel, x: Ctx): string {
  const station = stationOf(s.station)
  const status = statusOf(s.status)
  const time = isTime(s.startedAt) ? timeTag(s.startedAt, clockOf(s.startedAt)) : ''
  const lane = typeof s.agentId === 'string' ? `<span class="lane">${esc(x.clean(laneLabel(m, s.agentId), 40))}</span> ` : ''
  const why = x.clean(s.why, 240)
  return (
    `<tr class="st-${station}">` +
    `<td class="time">${time}</td>` +
    `<td class="glyph"><span title="${station}">${esc(stations.GLYPH[station])}</span></td>` +
    `<td class="what"${why ? ` title="${esc(why)}"` : ''}>${lane}<span class="headline">${esc(x.clean(s.headline, 160))}</span>${targetLine(s, x)}</td>` +
    `<td class="detail">${esc(x.clean(s.detail, 60))}</td>` +
    `<td class="note-cell">${esc(x.clean(s.resultNote, 160))}</td>` +
    `<td><span class="status s-${status}">${status}</span></td>` +
    '</tr>'
  )
}

function timelineSection(m: SessionModel, x: Ctx): string {
  const steps = m.steps
  if (steps.length === 0) return section('timeline', 'Timeline', muted('No steps were recorded.'))
  const kept = toolSteps(m)
  const total = num(m.stats.steps)
  const note = total > kept ? `<p class="note">Showing the last ${plural(kept, 'tool step')} of ${total}: the live model keeps only its newest ${timeline.LIMITS.steps} steps.</p>` : ''
  const head = '<thead><tr><th scope="col">Time</th><th scope="col"><span class="sr">Station</span></th><th scope="col">Step</th><th scope="col">Detail</th><th scope="col">Result</th><th scope="col">Status</th></tr></thead>'
  return section('timeline', 'Timeline', `${note}<div class="scroll"><table class="steps">${head}<tbody>${steps.map(s => stepRow(s, m, x)).join('')}</tbody></table></div>`)
}

// ------------------------------------------------------------------ files, concepts, tokens

function filesSection(m: SessionModel, x: Ctx): string {
  const files = m.files.filter(f => f.path !== '')
  if (files.length === 0) return section('files', 'Files touched', muted('No files were read or edited.'))
  const rows = files
    .map(f => ({ path: x.path(f.path), reads: num(f.reads), edits: num(f.edits) }))
    .sort((a, b) => Number(b.edits > 0) - Number(a.edits > 0) || a.path.localeCompare(b.path))
    .map(f => `<tr><td><code>${esc(f.path)}</code>${f.edits > 0 ? ' <span class="badge">edited</span>' : ''}</td><td class="num">${f.reads}</td><td class="num">${f.edits}</td></tr>`)
    .join('')
  const note = files.length >= timeline.LIMITS.files ? `<p class="note">The live model keeps the ${timeline.LIMITS.files} files touched most recently.</p>` : ''
  return section(
    'files',
    'Files touched',
    `${note}<div class="scroll"><table class="files"><thead><tr><th scope="col">File</th><th scope="col" class="num">Reads</th><th scope="col" class="num">Edits</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  )
}

/** Each concept once, in the order the session first met it; ids the knowledge base does not hold are skipped. */
function conceptsMet(m: SessionModel): Concept[] {
  const seen = new Set<string>()
  const out: Concept[] = []
  for (const s of m.steps) {
    for (const id of s.concepts) {
      if (typeof id !== 'string' || seen.has(id)) continue
      seen.add(id)
      const c = concepts.getConcept(id)
      if (c && c.id === id && typeof c.title === 'string') out.push(c)
    }
  }
  return out
}

function conceptsSection(m: SessionModel, x: Ctx): string {
  const cards = conceptsMet(m)
  if (cards.length === 0) return section('concepts', 'Concepts met', muted('No concepts came up.'))
  const items = cards.map(c => `<li><h3>${esc(x.clean(c.title, 80))}</h3><p>${esc(x.clean(c.short, 200))}</p></li>`).join('')
  return section('concepts', 'Concepts met', `<ul class="concepts">${items}</ul>`)
}

function tokensSection(u: SessionUsage | undefined, x: Ctx): string {
  const total = countsOf(u?.total ?? ZERO)
  const models = modelsOf(u)
  if (models.length === 0 && total.input + total.output + total.cacheRead + total.cacheWrite === 0) return section('tokens', 'Tokens', muted('No token use was recorded.'))
  const cells = (c: TokenCounts): string => [c.input, c.output, c.cacheRead, c.cacheWrite, c.messages].map(n => `<td class="num">${full(n)}</td>`).join('')
  const rows = models.map(([name, c]) => `<tr><td><code>${esc(x.clean(name, 80))}</code></td>${cells(c)}</tr>`).join('')
  const totalRow = `<tr class="total"><td>Total</td>${cells(total)}</tr>`
  const summary = `<p class="lead">${short(total.input)} in · ${short(total.output)} out · ${short(total.cacheRead)} read from cache · ${plural(total.messages, 'message')}</p>`
  const head = '<thead><tr><th scope="col">Model</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Cache read</th><th scope="col" class="num">Cache write</th><th scope="col" class="num">Messages</th></tr></thead>'
  return section('tokens', 'Tokens', `${summary}<div class="scroll"><table class="tokens">${head}<tbody>${rows}${totalRow}</tbody></table></div>`)
}

// ------------------------------------------------------------------ the page

const stationCss = (): string => (Object.entries(stations.COLOR) as [string, string][]).map(([id, c]) => `.st-${id}{--c:${c}}`).join('')

const CSS = `:root{color-scheme:light dark;--bg:#f5f6fa;--card:#fff;--fg:#0f172a;--muted:#5b6474;--line:#e2e6ee;--accent:#6d28d9;--code:#f1f3f8;--ok:#15803d;--error:#b91c1c;--denied:#b45309;--running:#475569}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--accent:#a78bfa;--code:#141e34;--ok:#4ade80;--error:#f87171;--denied:#fbbf24;--running:#94a3b8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif}
.page{max-width:1000px;margin:0 auto;padding:28px 16px 40px}
.kicker{margin:0;color:var(--accent);font-size:.75rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase}
h1{margin:.25rem 0 .75rem;font-size:1.55rem;line-height:1.25;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:4px 22px;margin:0;font-size:.9rem}
.meta div{display:flex;gap:6px;min-width:0}
.meta dt{color:var(--muted)}
.meta dd{margin:0;overflow-wrap:anywhere}
section{margin-top:18px;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px}
h2{margin:0 0 10px;font-size:1.05rem}
h3{margin:0 0 4px;font-size:.95rem}
p{margin:0 0 8px}
.muted,.note{color:var(--muted)}
.note{font-size:.85rem}
.lead{font-weight:600}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;overflow-wrap:anywhere}
figure.stage{margin:0}
figure.stage img{display:block;max-width:100%;height:auto;border-radius:12px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{padding:6px 8px;text-align:left;vertical-align:top;border-top:1px solid var(--line)}
thead th{border-top:0;color:var(--muted);font-size:.72rem;font-weight:650;letter-spacing:.05em;text-transform:uppercase}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.time{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
td.glyph{width:2.2em;text-align:center}
td.glyph span{display:inline-block;min-width:1.9em;padding:1px 0;border-left:3px solid var(--c,var(--line));border-radius:4px;background:var(--code)}
.what{min-width:16em}
.headline{font-weight:550}
.target{display:block;margin-top:2px;color:var(--muted)}
.prompt{display:block;margin-top:2px;color:var(--muted);font-style:italic;overflow-wrap:anywhere}
.lane{padding:0 6px;border-radius:6px;background:var(--code);color:var(--muted);font-size:.75rem}
.detail,.note-cell{color:var(--muted)}
.detail,table.tokens code{white-space:nowrap}
.status{display:inline-block;padding:0 8px;border:1px solid currentColor;border-radius:999px;font-size:.75rem;font-weight:600}
.s-ok{color:var(--ok)}.s-error{color:var(--error)}.s-denied{color:var(--denied)}.s-running{color:var(--running)}
.badge{padding:0 6px;border-radius:6px;background:var(--code);color:var(--accent);font-size:.72rem;font-weight:600}
tr.total td{font-weight:650}
ul.concepts{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin:0;padding:0;list-style:none}
ul.concepts li{padding:10px 12px;border:1px solid var(--line);border-radius:10px}
ul.concepts p{margin:0;color:var(--muted);font-size:.88rem}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer{margin-top:22px;color:var(--muted);font-size:.8rem}
@media print{body{background:#fff;color:#000}section{border-color:#ccc}tr{break-inside:avoid}}
`

type Heading = { title: string; folder: string; version: string; usage: SessionUsage | undefined }

function headerBlock(m: SessionModel, x: Ctx, h: Heading): string {
  const { start, end } = spanOf(m)
  const models = modelsOf(h.usage).map(([name]) => x.clean(name, 80))
  const st = m.stats
  const facts: [string, string][] = []
  if (start !== undefined) facts.push(['Date', timeTag(start, `${dayOf(start)} ${clockOf(start).slice(0, 5)}`)])
  if (start !== undefined && end !== undefined) facts.push(['Duration', esc(md.fmtDuration(end - start))])
  facts.push(['Folder', `<code>${esc(h.folder)}</code>`])
  if (models.length > 0) facts.push([models.length === 1 ? 'Model' : 'Models', models.map(n => `<code>${esc(n)}</code>`).join(', ')])
  facts.push(['Work', esc(`${plural(num(st.steps), 'step')}, ${plural(num(st.edits), 'edit')}, ${plural(num(st.commands), 'command')}, ${plural(num(st.errors), 'error')}, ${plural(num(st.turns), 'turn')}`)])
  if (h.version) facts.push(['Docent', esc(h.version)])
  const dl = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')
  return `<header class="top"><p class="kicker">Docent recap</p><h1>${esc(h.title)}</h1><dl class="meta">${dl}</dl></header>`
}

/** The whole recap document. `home` is the user's home folder, shown as '~'. Never throws on odd model data. */
export function renderRecap(input: RecapInput, homeDir: string): string {
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  const home = typeof homeDir === 'string' ? homeDir : ''
  const x = contextFor(cwd, home)
  const made = isTime(input.generatedAt) ? input.generatedAt : Date.now()
  const m = tidy(input.update?.model, made)
  const folder = x.clean(folderName(cwd, home), 80) || '.'
  const title = x.clean(input.title, TITLE_MAX) || x.clean(firstPrompt(m), TITLE_MAX) || 'Claude Code session'
  const version = x.clean(input.version, 40)
  const footer =
    `<footer><p>Made with Docent${version ? ` ${esc(version)}` : ''} on ${timeTag(made, `${dayOf(made)} ${clockOf(made).slice(0, 5)}`)}. ` +
    'This page has no scripts and loads nothing from the network. Secrets were masked automatically: read it through before you share it.</p></footer>'
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<meta name="referrer" content="no-referrer">\n' +
    `<title>${esc(`${title} · Docent recap`)}</title>\n<style>\n${CSS}${stationCss()}\n</style>\n</head>\n<body>\n<div class="page">\n` +
    headerBlock(m, x, { title, folder, version, usage: input.update?.usage }) +
    '\n<main>\n' +
    [stageSection(input, m, x, made), timelineSection(m, x), filesSection(m, x), conceptsSection(m, x), tokensSection(input.update?.usage, x)].join('\n') +
    '\n</main>\n' +
    footer +
    '\n</div>\n</body>\n</html>\n'
  )
}

// Tool inputs and results as the mod's hooks see them, rebuilt from transcript blocks. The rules and
// limits are copied from vendor/pairwatch/dev/eval-corpus.ts (itself a copy of register.tsx plain,
// cutCommand, argsOf and endOf), so a step folded here reads the same as the one the mod would fold.
import type { StepInput } from './types.ts'

/** The keys the mod's tool.call hook strips from the event's flat input: the engine's, not the tool's arguments. */
export const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
export const ARG_CUT = 4000
export const PREVIEW_CUT = 1500
/** register.tsx BLOCK_TEXT_MAX: a finished text or thinking block */
export const BLOCK_CUT = 1500
/** register.tsx prompt.submit: the prompt text */
export const PROMPT_CUT = 4000
/** what a turn-end carries as the answer */
export const ANSWER_CUT = 600
/** register.tsx agent.spawn: the helper's description */
export const DESCRIPTION_CUT = 300
/** StepInput strings (old/new text of an edit) */
export const INPUT_CUT = 4000

export type Row = { [k: string]: unknown }
export const isObj = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/** A tool argument as the mod's hook passes it (register.tsx plain()): strings cut, deep or huge structures bounded. */
export function plain(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return cut(v, ARG_CUT)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v === null) return v
  if (depth >= 4) return undefined
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plain(x, depth + 1) ?? null)
  if (isObj(v)) {
    const out: Row = {}
    let n = 0
    for (const [k, x] of Object.entries(v)) {
      if (n++ >= 100) break
      const p = plain(x, depth + 1)
      if (p !== undefined) out[k] = p
    }
    return out
  }
  return undefined
}

/** A long shell command keeps its head and tail, as register.tsx's cutCommand does. */
export const cutCommand = (s: string): string => (s.length <= ARG_CUT ? s : `${s.slice(0, 2800)}\n${s.slice(s.length - (ARG_CUT - 2800 - 1))}`)

export function argsOf(input: unknown): { [k: string]: unknown } {
  const out: { [k: string]: unknown } = {}
  if (!isObj(input)) return out
  for (const [k, v] of Object.entries(input)) {
    if (RESERVED.has(k)) continue
    const p = k === 'command' && typeof v === 'string' ? cutCommand(v) : plain(v, 0)
    if (p !== undefined) out[k] = p
  }
  return out
}

/** The result as the model reads it, text blocks joined (what the hook's ran.text holds). */
export function previewOf(content: unknown): string {
  if (typeof content === 'string') return cut(content, PREVIEW_CUT)
  if (!Array.isArray(content)) return ''
  return cut(
    content
      .map(b => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(t => t !== '')
      .join('\n'),
    PREVIEW_CUT,
  )
}

const positive = (v: unknown): number | undefined => {
  const n = num(v)
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined
}

const editOf = (oldText: unknown, newText: unknown, all: unknown): { old: string; new: string; all?: boolean } => ({
  old: cut(str(oldText) ?? '', INPUT_CUT),
  new: cut(str(newText) ?? '', INPUT_CUT),
  ...(all === true ? { all: true } : {}),
})

/** The parts of a file tool's input that Step does not carry; undefined for every other tool. */
export function stepInputOf(tool: string, input: unknown): StepInput | undefined {
  if (!isObj(input)) return undefined
  const path = str(input.file_path)
  const at = path === undefined ? {} : { path: cut(path, INPUT_CUT) }
  switch (tool) {
    case 'Read': {
      const offset = positive(input.offset)
      const limit = positive(input.limit)
      return { ...at, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }
    }
    case 'Edit':
      return { ...at, edits: [editOf(input.old_string, input.new_string, input.replace_all)] }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isObj).slice(0, 200).map(e => editOf(e.old_string, e.new_string, e.replace_all)) : []
      return { ...at, edits }
    }
    case 'Write':
      return { ...at, isWrite: true }
    case 'NotebookEdit': {
      const nb = str(input.notebook_path)
      return nb === undefined ? {} : { path: cut(nb, INPUT_CUT) }
    }
    default:
      return undefined
  }
}

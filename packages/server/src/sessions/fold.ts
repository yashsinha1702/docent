// Transcript rows to the RawEvents Pairwatch's hooks would have pushed (docs/PLAN.md M10; the event
// table of _ide-design/01 §4). Stateful: rows repeat (deduped by uuid), turns are inferred (a turn-start
// at the first assistant row after a prompt, a turn-end at the system turn_duration row or at the
// "[Request interrupted" marker), and helpers' transcripts (<sid>/subagents/agent-<id>.jsonl) are tied to
// the Agent call that started them, so their events carry the lane's agentId.
//
// Feed it a read cycle at a time: helpers' new lines, then the main file's, then take(). Within a cycle
// each file's events keep their order and the files are merged by time.
import type { RawEvent } from '@docent/core'

import { ANSWER_CUT, BLOCK_CUT, DESCRIPTION_CUT, PROMPT_CUT, argsOf, cut, isObj, num, previewOf, stepInputOf, str } from './args.ts'
import type { Row } from './args.ts'
import type { StepInput } from './types.ts'
import { UsageMeter } from './usage.ts'

/** Prompts the engine writes for itself; they open a turn of their own, even when marked isMeta. */
const SYSTEM_ORIGINS: ReadonlySet<string> = new Set([
  'task-notification',
  'peer',
  'peer-send-message',
  'coordinator',
  'auto-continuation',
  'observer',
  'observer-activity',
  'scheduled-trigger',
])
/** String user rows that print a command's output: nothing the person typed. */
const OUTPUT_TAGS = ['<local-command-stdout>', '<local-command-caveat>', '<bash-stdout>', '<bash-stderr>']
const INTERRUPTED = '[Request interrupted'
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
/** a helper's last call: it hands its report back to its parent and is done */
const HANDBACK = 'SubagentHandback'
/** The CLI's own assistant rows (an API error, "No response requested."): not the model's words, not billed. */
const SYNTHETIC = '<synthetic>'
/** Read cycles a helper whose prompt matches no Agent call waits before it is tied to one by creation order. */
const LINK_PATIENCE = 2
/** Row types worth parsing; any other row whose type is written first is skipped unparsed (api-request rows are most of a transcript's bytes). */
const KEEP: ReadonlySet<string> = new Set(['user', 'assistant', 'system'])
const TYPE_FIRST = '{"type":"'

const TAG_RE = {
  'command-name': /<command-name>([\s\S]*?)<\/command-name>/,
  'command-args': /<command-args>([\s\S]*?)<\/command-args>/,
  'bash-input': /<bash-input>([\s\S]*?)<\/bash-input>/,
  'task-id': /<task-id>([^<]{1,200})<\/task-id>/,
  'tool-use-id': /<tool-use-id>([^<]{1,200})<\/tool-use-id>/,
} as const
const tagged = (text: string, tag: keyof typeof TAG_RE): string | undefined => TAG_RE[tag].exec(text)?.[1]?.trim()

/** One transcript line as a row; undefined for a row type the fold ignores and for junk. */
export function parseRow(line: string): Row | undefined {
  if (line.startsWith(TYPE_FIRST)) {
    const end = line.indexOf('"', TYPE_FIRST.length)
    if (end > 0 && !KEEP.has(line.slice(TYPE_FIRST.length, end))) return undefined
  }
  try {
    const row: unknown = JSON.parse(line)
    return isObj(row) ? row : undefined
  } catch {
    return undefined
  }
}

/** The time an event happened (ms since epoch). */
export const atOf = (e: RawEvent): number => (e.kind === 'tool-start' ? e.obs.at : e.kind === 'tool-end' ? e.end.at : e.at)

/**
 * Merges per-file event lists by time without reordering any one list: each event sorts at the latest
 * time its list has reached, so a row stamped earlier than the one before it stays behind it.
 */
export function mergeByTime(lists: readonly (readonly RawEvent[])[]): RawEvent[] {
  if (lists.length === 1) return [...(lists[0] ?? [])]
  const all: { e: RawEvent; t: number; src: number; i: number }[] = []
  lists.forEach((list, src) => {
    let t = Number.NEGATIVE_INFINITY
    list.forEach((e, i) => {
      t = Math.max(t, atOf(e))
      all.push({ e, t, src, i })
    })
  })
  all.sort((a, b) => a.t - b.t || a.src - b.src || a.i - b.i)
  return all.map(x => x.e)
}

/** `/review src/x.ts` from a slash command's row; undefined for any other text. */
function commandOf(head: string): string | undefined {
  if (!head.startsWith('<command-name>') && !head.startsWith('<command-message>')) return undefined
  const name = tagged(head, 'command-name') ?? ''
  if (name === '') return undefined
  const args = tagged(head, 'command-args') ?? ''
  return cut(`${name.startsWith('/') ? name : `/${name}`} ${args}`.trim(), PROMPT_CUT)
}

/** An Agent (or Task) tool call that starts a helper. */
type AgentCall = {
  toolUseId: string
  prompt?: string
  type: string
  description: string
  background: boolean
  at: number
  /** its result was an error or a refusal and named no helper: nothing ran */
  failed: boolean
  agentId?: string
  /** when it was over, while its helper was not linked yet */
  stopAt?: number
}

/** One helper transcript. */
type Helper = {
  agentId: string
  call?: AgentCall
  started: boolean
  running: boolean
  stoppedAt?: number
  /** rows stamped before the stop arrived after it: stop the lane again after them */
  restop: boolean
  /** its first user row's text (the Agent call's prompt) and time */
  firstPrompt?: string
  firstAt?: number
  /** its events while it is not tied to a call */
  held: RawEvent[]
  /** a hand-back among the held events: the lane starts already stopped */
  heldStopAt?: number
  /** its SubagentHandback calls */
  handbacks: Set<string>
  waited: number
  out: RawEvent[]
}

/** Who opened a turn: the person, a slash command or shell input of theirs, or the engine (a task-notification...). */
type Opener = 'person' | 'command' | 'system'
type Turn = { state: 'idle' } | { state: 'pending' | 'open'; id: string; startAt: number; answer: string; opener: Opener }

export class TranscriptFold {
  readonly usage = new UsageMeter()
  /** Read / Edit / MultiEdit / Write / NotebookEdit inputs by tool_use id (the owner prunes them) */
  readonly inputs = new Map<string, StepInput>()
  private readonly seen = new Set<string>()
  private readonly calls = new Map<string, AgentCall>()
  private readonly helpers = new Map<string, Helper>()
  private mainOut: RawEvent[] = []
  private turn: Turn = { state: 'idle' }
  private lastTurnId: string | undefined
  private lastAt = 0

  /** New lines of the main transcript, oldest first. */
  addMain(lines: readonly string[]): void {
    for (const line of lines) {
      const row = line === '' ? undefined : parseRow(line)
      if (row === undefined || !this.isFresh(row)) continue
      if (row.isSidechain === true) {
        // transcripts older than subagents/ kept helpers' rows in the main file
        const id = str(row.agentId)
        if (id !== undefined && id !== '') this.helperRow(this.helper(id), row)
        continue
      }
      this.mainRow(row)
    }
  }

  /** New lines of a helper's transcript, subagents/agent-<agentId>.jsonl. */
  addHelper(agentId: string, lines: readonly string[]): void {
    const h = this.helper(agentId)
    for (const line of lines) {
      const row = line === '' ? undefined : parseRow(line)
      if (row !== undefined && this.isFresh(row)) this.helperRow(h, row)
    }
  }

  /**
   * Ends a read cycle and hands out its events. Helpers still waiting for their Agent call are tied to
   * the oldest call without one once they waited LINK_PATIENCE cycles (at once when `final`), or shown
   * as an unnamed lane when there is none.
   */
  take(final: boolean): RawEvent[] {
    const waiting = [...this.helpers.values()].filter(h => !h.started && (h.firstPrompt !== undefined || h.held.length > 0))
    waiting.sort((a, b) => (a.firstAt ?? Number.POSITIVE_INFINITY) - (b.firstAt ?? Number.POSITIVE_INFINITY))
    for (const h of waiting) {
      if (!final && h.firstPrompt === undefined) continue
      if (!final && ++h.waited < LINK_PATIENCE) continue
      const call = [...this.calls.values()].find(c => c.agentId === undefined && !c.failed)
      if (call !== undefined) this.link(call, h)
      else this.startHelper(h)
    }
    const lists: RawEvent[][] = [this.mainOut]
    for (const h of this.helpers.values()) {
      if (h.restop && h.stoppedAt !== undefined) h.out.push({ kind: 'agent-stop', agentId: h.agentId, at: h.stoppedAt })
      h.restop = false
      if (h.out.length > 0) lists.push(h.out)
      h.out = []
    }
    this.mainOut = []
    return mergeByTime(lists)
  }

  // ---- rows

  private isFresh(row: Row): boolean {
    const id = str(row.uuid)
    if (id === undefined) return true
    if (this.seen.has(id)) return false
    this.seen.add(id)
    return true
  }

  private at(row: Row): number {
    const t = Date.parse(str(row.timestamp) ?? '')
    if (Number.isFinite(t)) this.lastAt = t
    return this.lastAt
  }

  private mainRow(row: Row): void {
    const at = this.at(row)
    if (row.type === 'assistant') this.mainAssistant(row, at)
    else if (row.type === 'user') this.mainUser(row, at)
    else if (row.type === 'system' && row.subtype === 'turn_duration') this.turnDuration(row, at)
  }

  private mainAssistant(row: Row, at: number): void {
    const blocks = this.assistantBlocks(row, at)
    if (blocks.length === 0) return
    this.openTurn(row, at)
    for (const b of blocks) this.block(b, at, undefined, this.mainOut)
  }

  /** The row's content blocks, its usage metered; none for the CLI's synthetic rows. */
  private assistantBlocks(row: Row, at: number): Row[] {
    const msg = isObj(row.message) ? row.message : undefined
    if (msg === undefined) return []
    const model = str(msg.model) ?? 'unknown'
    if (model === SYNTHETIC) return []
    const id = str(msg.id)
    if (id !== undefined && isObj(msg.usage)) this.usage.record(id, model, msg.usage, at)
    return Array.isArray(msg.content) ? msg.content.filter(isObj) : []
  }

  private block(b: Row, at: number, agentId: string | undefined, out: RawEvent[]): void {
    const lane = agentId === undefined ? {} : { agentId }
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      out.push({ kind: 'stream', ...lane, mode: 'thinking', at }, { kind: 'think', ...lane, text: cut(str(b.thinking) ?? '', BLOCK_CUT), at })
    } else if (b.type === 'text') {
      const text = str(b.text) ?? ''
      out.push({ kind: 'stream', ...lane, mode: 'text', at }, { kind: 'say', ...lane, text: cut(text, BLOCK_CUT), at })
      if (agentId === undefined && this.turn.state !== 'idle' && text.trim() !== '') this.turn.answer = text
    } else if (b.type === 'tool_use') {
      const id = str(b.id)
      const name = str(b.name)
      if (id === undefined || id === '' || name === undefined || name === '') return
      out.push({ kind: 'tool-start', obs: { id, tool: name, args: argsOf(b.input), ...lane, at } })
      const input = stepInputOf(name, b.input)
      if (input !== undefined) this.inputs.set(id, input)
      // words before a tool call are not the answer
      if (agentId === undefined && this.turn.state !== 'idle') this.turn.answer = ''
      if (AGENT_TOOLS.has(name)) this.agentCall(id, b.input, at)
    }
  }

  private mainUser(row: Row, at: number): void {
    const content = isObj(row.message) ? row.message.content : undefined
    const origin = isObj(row.origin) ? str(row.origin.kind) : undefined
    if (typeof content === 'string') {
      this.userText(row, content, origin, at)
      return
    }
    if (!Array.isArray(content)) return
    const blocks = content.filter(isObj)
    let hasResult = false
    const texts: string[] = []
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        hasResult = true
        this.toolResult(row, b, blocks.length, at, this.mainOut)
      } else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    }
    if (texts.some(t => t.startsWith(INTERRUPTED))) {
      this.endTurn(at, undefined, 'aborted')
      return
    }
    // a prompt sent as blocks (an image with words, or from the SDK)
    if (!hasResult && texts.length > 0) this.userText(row, texts.join('\n'), origin, at)
  }

  private userText(row: Row, text: string, origin: string | undefined, at: number): void {
    // the summary /compact leaves behind is written as a user row, but nobody typed it
    if (row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return
    if (origin !== undefined && SYSTEM_ORIGINS.has(origin)) {
      this.prompt(row, cut(text, PROMPT_CUT), origin, at, false)
      if (origin === 'task-notification') this.notified(text, at)
      else if (isObj(row.origin) && row.origin.handback === true) this.handedBack(str(row.origin.senderTaskId) ?? str(row.origin.from), at)
      return
    }
    if (row.isMeta === true) return
    const head = text.trimStart()
    if (OUTPUT_TAGS.some(tag => head.startsWith(tag))) return
    const command = commandOf(head)
    if (command !== undefined) {
      // a slash command that runs the model carries origin human; a local one (/cost, /model) carries
      // none and is left out: the reducer would take it for the session's goal and count a turn
      if (origin === 'human') this.prompt(row, command, 'command', at, true)
      return
    }
    if (head.startsWith('<bash-input>')) {
      this.prompt(row, cut(`!${tagged(head, 'bash-input') ?? ''}`, PROMPT_CUT), 'bash', at, false)
      return
    }
    this.prompt(row, cut(text, PROMPT_CUT), origin ?? 'human', at, origin === undefined || origin === 'human')
  }

  private prompt(row: Row, text: string, origin: string, at: number, isHuman: boolean): void {
    const opener: Opener = SYSTEM_ORIGINS.has(origin) ? 'system' : origin === 'command' || origin === 'bash' ? 'command' : 'person'
    // helpers that finish together send a burst of notifications, answered in one turn: the first opens
    // it, the others join it (timeline.ts would open a turn for each prompt of a turn not started yet)
    if (this.turn.state === 'pending' && this.turn.opener === 'system' && opener === 'system') this.openTurn(row, at)
    this.mainOut.push({ kind: 'prompt', text, origin, at })
    if (isHuman) this.usage.newTurn(at)
    // typed while a turn runs, it joins that turn (timeline.ts does the same); else it opens the next one
    if (this.turn.state === 'open') return
    this.turn = { state: 'pending', id: str(row.uuid) ?? `prompt-${at}`, startAt: at, answer: '', opener }
  }

  private openTurn(row: Row, at: number): void {
    const t = this.turn
    if (t.state === 'open') return
    const id = t.state === 'pending' ? t.id : (str(row.uuid) ?? `turn-${at}`)
    // stamped at the prompt: timeline.ts ties a turn-start to the turn its prompt opened only within
    // 15 s (ATTACH_MS), and the first assistant row is written when its block ends, often later
    const startAt = t.state === 'pending' ? t.startAt : at
    this.mainOut.push({ kind: 'turn-start', turnId: id, at: startAt })
    this.turn = { state: 'open', id, startAt, answer: '', opener: t.state === 'pending' ? t.opener : 'person' }
  }

  private endTurn(at: number, durationMs: number | undefined, reason: string): boolean {
    const t = this.turn
    if (t.state === 'idle') return false
    this.mainOut.push({ kind: 'turn-end', turnId: t.id, durationMs: Math.max(0, durationMs ?? at - t.startAt), answer: cut(t.answer, ANSWER_CUT), reason, at })
    this.lastTurnId = t.id
    this.turn = { state: 'idle' }
    return true
  }

  private turnDuration(row: Row, at: number): void {
    const durationMs = num(row.durationMs)
    if (this.endTurn(at, durationMs, 'completed') || this.lastTurnId !== undefined) return
    // the end of a turn whose start this transcript does not hold: timeline.ts rebuilds it from the duration
    this.lastTurnId = str(row.uuid) ?? `turn-${at}`
    this.mainOut.push({ kind: 'turn-end', turnId: this.lastTurnId, durationMs: Math.max(0, durationMs ?? 0), answer: '', reason: 'completed', at })
  }

  private toolResult(row: Row, b: Row, blocks: number, at: number, out: RawEvent[]): void {
    const id = str(b.tool_use_id)
    if (id === undefined || id === '') return
    const isDenied = typeof row.toolDenialKind === 'string' && (blocks === 1 || b.is_error === true)
    const status = isDenied ? 'denied' : b.is_error === true ? 'error' : 'ok'
    out.push({ kind: 'tool-end', end: { id, status, preview: previewOf(b.content), at } })
    const call = this.calls.get(id)
    if (call !== undefined) this.agentResult(call, row.toolUseResult, status, at)
  }

  // ---- helpers (sub-agents)

  private helper(agentId: string): Helper {
    let h = this.helpers.get(agentId)
    if (h === undefined) {
      h = { agentId, started: false, running: false, restop: false, held: [], handbacks: new Set(), waited: 0, out: [] }
      this.helpers.set(agentId, h)
    }
    return h
  }

  private helperRow(h: Helper, row: Row): void {
    const at = this.at(row)
    const out: RawEvent[] = []
    let isHandedBack = false
    if (row.type === 'user') {
      const content = isObj(row.message) ? row.message.content : undefined
      if (typeof content === 'string') {
        // its first user row is the prompt its parent gave it: what ties the file to the Agent call
        if (h.firstPrompt === undefined) {
          h.firstPrompt = content
          h.firstAt = at
          if (!h.started) this.linkByPrompt(h)
        }
        return
      }
      if (!Array.isArray(content)) return
      const blocks = content.filter(isObj)
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue
        this.toolResult(row, b, blocks.length, at, out)
        if (b.is_error !== true && h.handbacks.has(str(b.tool_use_id) ?? '')) isHandedBack = true
      }
    } else if (row.type === 'assistant') {
      for (const b of this.assistantBlocks(row, at)) {
        this.block(b, at, h.agentId, out)
        if (b.type === 'tool_use' && b.name === HANDBACK && typeof b.id === 'string') h.handbacks.add(b.id)
      }
    }
    if (out.length === 0) return
    if (!h.started) {
      if (h.heldStopAt !== undefined && at > h.heldStopAt) h.heldStopAt = undefined // given more work since
      h.held.push(...out)
      if (isHandedBack) {
        h.held.push({ kind: 'agent-stop', agentId: h.agentId, at })
        h.heldStopAt = at
      }
      return
    }
    if (!h.running && h.stoppedAt !== undefined) {
      if (at <= h.stoppedAt) h.restop = true // read after its stop, written before it
      else {
        h.running = true // its parent gave it more work
        h.stoppedAt = undefined
        h.restop = false
      }
    }
    h.out.push(...out)
    if (isHandedBack) this.stopHelper(h, at)
  }

  private agentCall(toolUseId: string, input: unknown, at: number): void {
    const i = isObj(input) ? input : {}
    const prompt = str(i.prompt)
    const call: AgentCall = {
      toolUseId,
      type: str(i.subagent_type) || 'general-purpose',
      description: cut(str(i.description) ?? '', DESCRIPTION_CUT),
      background: i.run_in_background === true,
      at,
      failed: false,
      ...(prompt === undefined ? {} : { prompt }),
    }
    this.calls.set(toolUseId, call)
    if (prompt === undefined) return
    // a helper already shown as an unnamed lane (its rows were read first) is named here too
    for (const h of this.helpers.values()) {
      if (h.call === undefined && h.firstPrompt === prompt) {
        this.link(call, h)
        return
      }
    }
  }

  private linkByPrompt(h: Helper): void {
    for (const call of this.calls.values()) {
      if (call.agentId === undefined && call.prompt !== undefined && call.prompt === h.firstPrompt) {
        this.link(call, h)
        return
      }
    }
  }

  private agentResult(call: AgentCall, result: unknown, status: 'ok' | 'error' | 'denied', at: number): void {
    const r = isObj(result) ? result : undefined
    const agentId = str(r?.agentId)
    // the result names its helper: the surest tie, and it overrides a guess made by prompt
    if (agentId !== undefined && agentId !== '') {
      if (call.agentId !== undefined && call.agentId !== agentId) this.retie(call, agentId)
      else this.link(call, this.helper(agentId))
    } else if (status !== 'ok') call.failed = true
    // launched in the background: it is over when its task-notification comes, not now
    if (r !== undefined && (r.status === 'async_launched' || r.isAsync === true)) return
    this.stop(call, at)
  }

  /** A task-notification: a background helper finished (its <task-id> is the agent id, <tool-use-id> its call). */
  private notified(text: string, at: number): void {
    const toolUseId = tagged(text, 'tool-use-id')
    const taskId = tagged(text, 'task-id')
    let call = toolUseId === undefined ? undefined : this.calls.get(toolUseId)
    if (call === undefined && taskId !== undefined) call = [...this.calls.values()].find(c => c.agentId === taskId)
    if (call !== undefined) {
      this.stop(call, at)
      return
    }
    const h = taskId === undefined ? undefined : this.helpers.get(taskId)
    if (h?.started) this.stopHelper(h, at)
  }

  /** A helper sent its parent its report (a peer message with handback): it is done. */
  private handedBack(agentId: string | undefined, at: number): void {
    if (agentId === undefined) return
    const call = [...this.calls.values()].find(c => c.agentId === agentId)
    if (call !== undefined) this.stop(call, at)
    else {
      const h = this.helpers.get(agentId)
      if (h?.started) this.stopHelper(h, at)
    }
  }

  /**
   * Two calls with the same prompt were tied by prompt to each other's helpers; the result naming
   * `agentId` corrects it: this call takes the named helper, and the call that held it takes this
   * call's old one.
   */
  private retie(call: AgentCall, agentId: string): void {
    const named = this.helper(agentId)
    const wrong = call.agentId === undefined ? undefined : this.helpers.get(call.agentId)
    const other = named.call
    if (wrong !== undefined) wrong.call = undefined
    if (other !== undefined) other.agentId = undefined
    named.call = undefined
    call.agentId = undefined
    this.link(call, named)
    if (other !== undefined && wrong !== undefined) this.link(other, wrong)
  }

  private link(call: AgentCall, h: Helper): void {
    if (h.call !== undefined || (call.agentId !== undefined && call.agentId !== h.agentId)) return
    call.agentId = h.agentId
    h.call = call
    if (!h.started) {
      this.startHelper(h)
      return
    }
    // shown before its call was known: name the lane now
    if (h.running) h.out.push(this.agentStart(h))
    if (call.stopAt !== undefined) this.stopHelper(h, call.stopAt)
  }

  private startHelper(h: Helper): void {
    h.started = true
    h.running = h.heldStopAt === undefined
    if (h.heldStopAt !== undefined) h.stoppedAt = h.heldStopAt
    h.heldStopAt = undefined
    h.out.push(this.agentStart(h), ...h.held)
    h.held = []
    const stopAt = h.call?.stopAt
    if (stopAt !== undefined) this.stopHelper(h, stopAt)
  }

  private agentStart(h: Helper): RawEvent {
    const c = h.call
    return {
      kind: 'agent-start',
      agentId: h.agentId,
      type: c?.type ?? 'general-purpose',
      description: c?.description ?? '',
      toolUseId: c?.toolUseId ?? '',
      background: c?.background ?? false,
      at: h.firstAt ?? c?.at ?? this.lastAt,
    }
  }

  private stop(call: AgentCall, at: number): void {
    const h = call.agentId === undefined ? undefined : this.helpers.get(call.agentId)
    if (h?.started) this.stopHelper(h, at)
    else call.stopAt ??= at
  }

  private stopHelper(h: Helper, at: number): void {
    if (!h.running) return
    h.running = false
    h.stoppedAt = at
    h.restop = false
    h.out.push({ kind: 'agent-stop', agentId: h.agentId, at })
  }
}

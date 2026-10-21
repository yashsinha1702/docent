// Token use from the assistant rows' message.usage. The rows of one API message share message.id and
// each carries the usage so far, so the last row of a message replaces the earlier ones instead of
// adding to them. A message belongs to the turn its first row falls in, by time: the turn starts at the
// latest human prompt. Helpers' messages count too (they are billed to the session); by time, because a
// helper's file can be read before the main file's prompt that came first.
import { isObj, num } from './args.ts'
import type { SessionUsage, TokenCounts } from './types.ts'

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Seen = { model: string; tokens: Tokens; at: number }

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 })
const count = (v: unknown): number => Math.max(0, Math.floor(num(v) ?? 0))

export function tokensOf(usage: unknown): Tokens {
  if (!isObj(usage)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
  }
}

function add(into: TokenCounts, t: Tokens, sign: 1 | -1): void {
  into.input += sign * t.input
  into.output += sign * t.output
  into.cacheRead += sign * t.cacheRead
  into.cacheWrite += sign * t.cacheWrite
  into.messages += sign
}

const same = (a: Tokens, b: Tokens): boolean => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
const sameCounts = (a: TokenCounts, b: TokenCounts): boolean => same(a, b) && a.messages === b.messages

export class UsageMeter {
  private readonly seen = new Map<string, Seen>()
  private readonly total = zero()
  private turnCounts = zero()
  private readonly models = new Map<string, TokenCounts>()
  /** the latest human prompt's time */
  private turnAt = Number.NEGATIVE_INFINITY
  /** bumps whenever a sum changes */
  rev = 0

  /** One assistant row of message `messageId` at time `at` (skip the CLI's '<synthetic>' rows before calling). */
  record(messageId: string, model: string, usage: unknown, at: number): void {
    const tokens = tokensOf(usage)
    const was = this.seen.get(messageId)
    if (was !== undefined && was.model === model && same(was.tokens, tokens)) return
    if (was !== undefined) {
      add(this.total, was.tokens, -1)
      add(this.byModel(was.model), was.tokens, -1)
      if (was.at >= this.turnAt) add(this.turnCounts, was.tokens, -1)
    }
    const first = was?.at ?? at
    this.seen.set(messageId, { model, tokens, at: first })
    add(this.total, tokens, 1)
    add(this.byModel(model), tokens, 1)
    if (first >= this.turnAt) add(this.turnCounts, tokens, 1)
    this.rev++
  }

  /** A human prompt at `at`: the turn's counts start there. */
  newTurn(at: number): void {
    if (at < this.turnAt) return
    this.turnAt = at
    const next = zero()
    for (const s of this.seen.values()) if (s.at >= at) add(next, s.tokens, 1)
    if (sameCounts(next, this.turnCounts)) return
    this.turnCounts = next
    this.rev++
  }

  snapshot(): SessionUsage {
    const byModel: { [model: string]: TokenCounts } = {}
    for (const [model, c] of this.models) if (c.messages > 0) byModel[model] = { ...c }
    return { total: { ...this.total }, turn: { ...this.turnCounts }, byModel }
  }

  private byModel(model: string): TokenCounts {
    let c = this.models.get(model)
    if (c === undefined) {
      c = zero()
      this.models.set(model, c)
    }
    return c
  }
}

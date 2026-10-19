// MCP over JSON-RPC 2.0, one message per WebSocket text frame, hand-rolled: the IDE side needs only
// initialize, ping, tools/list and tools/call, plus notifications both ways. Batches are not handled.
import type { IdeHost } from './types.ts'
import { errorResult } from './tools.ts'
import type { ToolDef, ToolResult } from './tools.ts'

export type JsonRpcId = string | number | null
export type McpOptions = {
  serverInfo: { name: string; version: string }
  tools: readonly ToolDef[]
  host: IdeHost
  log?: (msg: string) => void
}

/** answered when the client names no version */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

type Params = Record<string, unknown>
type Method = (params: Params, opts: McpOptions) => Promise<unknown> | unknown

class RpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is JsonRpcId => v === null || typeof v === 'string' || typeof v === 'number'
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const reply = (id: JsonRpcId, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result })
const fail = (id: JsonRpcId, code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

/** the tools/list entry: the SDK also emits title/execution/_meta, all undefined for these tools */
const describeTool = (tool: ToolDef) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
})

async function callTool(params: Params, opts: McpOptions): Promise<ToolResult> {
  const name = params.name
  if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call: name must be a string')
  const tool = opts.tools.find(t => t.name === name)
  if (tool === undefined) return errorResult(`Tool ${name} not found`)
  const args = isRecord(params.arguments) ? params.arguments : {}
  try {
    return await tool.handler(args, opts.host)
  } catch (err) {
    return errorResult(messageOf(err))
  }
}

// a Map, not an object literal, so a method named like an Object.prototype member is still unknown
const methods = new Map<string, Method>([
  [
    'initialize',
    (params, opts) => ({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: opts.serverInfo,
    }),
  ],
  ['ping', () => ({})],
  ['tools/list', (_params, opts) => ({ tools: opts.tools.map(describeTool) })],
  ['tools/call', callTool],
])

/** One inbound frame → the frame owed back, or undefined when none is (notifications, stray responses). */
export async function handleFrame(raw: string, opts: McpOptions): Promise<string | undefined> {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return fail(null, PARSE_ERROR, 'Parse error')
  }
  if (!isRecord(msg)) return fail(null, INVALID_REQUEST, 'Invalid Request')
  const id = isId(msg.id) ? msg.id : undefined
  if (id === undefined && msg.id !== undefined) return fail(null, INVALID_REQUEST, 'Invalid Request')
  const method = msg.method
  if (typeof method !== 'string') {
    if ('result' in msg || 'error' in msg) {
      opts.log?.(`ignoring a response from the client: ${raw}`)
      return undefined
    }
    return fail(id ?? null, INVALID_REQUEST, 'Invalid Request')
  }
  const params = isRecord(msg.params) ? msg.params : {}
  if (id === undefined) {
    // notifications/initialized, ide_connected {pid}, ...: nothing is owed back
    opts.log?.(`notification ${method} ${JSON.stringify(params)}`)
    return undefined
  }
  const handler = methods.get(method)
  if (handler === undefined) return fail(id, METHOD_NOT_FOUND, 'Method not found')
  try {
    return reply(id, await handler(params, opts))
  } catch (err) {
    return err instanceof RpcError ? fail(id, err.code, err.message) : fail(id, INTERNAL_ERROR, messageOf(err))
  }
}

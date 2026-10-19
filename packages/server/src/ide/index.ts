// The IDE protocol Claude Code speaks to editors: a loopback WebSocket MCP server plus a lock file
// in <config dir>/ide/<port>.lock. The CLI connects with X-Claude-Code-Ide-Authorization and calls
// the editor's tools (openDiff, getCurrentSelection, ...); the editor pushes selection_changed and
// at_mentioned notifications. See docs/PLAN.md M6 and _ide-design/02 §1 for the evidence.
//
// types.ts holds the shapes the app integrates against; server.ts binds the port, checks the token
// and keeps the lock; mcp.ts frames JSON-RPC; tools.ts answers the twelve tools in the extension's words.
export type {
  AtMention,
  DiffOutcome,
  IdeHost,
  IdeServer,
  IdeServerOptions,
  OpenDiffRequest,
  OpenEditor,
  OpenFileRequest,
  Position,
  Selection,
} from './types.ts'
export { startIdeServer } from './server.ts'

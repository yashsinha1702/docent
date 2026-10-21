// The contract between the renderer and the main process. Plain JSON both ways.
import type { Snapshot } from '../../../server/src/pairwatch/types'
import type { ProgramStatus } from '../../../server/src/pty/types'
import type { SessionUpdate } from '../../../server/src/sessions/types'

export type { ProgramState, ProgramStatus } from '../../../server/src/pty/types'
export type { SessionModel, SessionUpdate, SessionUsage, Step, StepInput, TokenCounts } from '../../../server/src/sessions/types'

export type DirEntry = { name: string; path: string; kind: 'file' | 'dir'; size?: number; mtimeMs?: number }

export type TerminalKind = 'claude' | 'shell'

export type PtySpawnRequest = { kind: TerminalKind; cols: number; rows: number; resume?: string }
/** `sessionId` is the claude session (its `--session-id`); `idePort` the IDE-protocol port that session connects to. */
export type PtySpawnResult = { id: string; sessionId?: string; command: string; idePort?: number }

export type PtyEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'title'; id: string; title: string }
  /** Claude Code's OSC 7501 program status (working / blocked on you / done / idle / error), parsed */
  | { type: 'program'; id: string; status: ProgramStatus }

export type WorkspaceInfo = { root: string; name: string; claudeBinary?: string; pairwatchDir?: string }

// ---- IDE protocol: what the claude CLI asks of the editor. Main receives the MCP call, relays it
// to the renderer as an IdeRequest, and answers the CLI with the renderer's reply for that `id`.

/** 0-based line and character, as VS Code counts them. */
export type Position = { line: number; character: number }
export type SelectionInfo = { filePath: string; text: string; selection: { start: Position; end: Position; isEmpty: boolean } }
/** What the renderer tells main about its editors, after every change (debounced); main answers the CLI's queries from it. */
export type EditorState = { open: { path: string; dirty: boolean }[]; active?: string; selection?: SelectionInfo }

export type IdeRequest =
  | { type: 'openDiff'; id: string; oldPath: string; newPath: string; newContents: string; tabName: string }
  | { type: 'closeTab'; id: string; tabName: string }
  | { type: 'closeAllDiffTabs'; id: string }
  | { type: 'openFile'; id: string; path: string; preview: boolean; startText?: string; endText?: string; selectToEndOfLine: boolean; makeFrontmost: boolean }
  | { type: 'saveDocument'; id: string; path: string }

/** openDiff ends one of three ways; the others say ok or not. */
export type DiffOutcome = { outcome: 'saved'; contents: string } | { outcome: 'rejected' } | { outcome: 'closed' }
export type IdeReply = DiffOutcome | { ok: boolean; error?: string; count?: number }

export type IdeEvent =
  | { type: 'request'; request: IdeRequest }
  | { type: 'connection'; ptyId: string; connected: boolean }

export type AtMention = { filePath: string; lineStart?: number; lineEnd?: number }

// ---- Pairwatch: snapshots the mod writes, relayed live; presses go back through the viewer inbox.

export type WatchAction = 'why' | 'tip' | 'known' | 'pause' | 'level'
export type WatchSession = { sid: string; snapshot: Snapshot; updatedAt: number }
/** host: Docent answers the mod on `port`; bridge: a real viewer already holds the port and Docent follows it; down: neither. */
export type WatchHostStatus = { mode: 'host' | 'bridge' | 'down'; port: number; note?: string }
export type WatchEvent =
  | { type: 'snapshot'; sid: string; snapshot: Snapshot; updatedAt: number }
  | { type: 'removed'; sid: string }
  | { type: 'host'; status: WatchHostStatus }

// ---- Live session: the transcript folded by Pairwatch's own reducer (packages/server/src/sessions).

/** One claude terminal's live model; `ptyId` names the terminal it runs in. */
export type LiveSession = SessionUpdate & { ptyId: string }
export type SessionEvent =
  | { type: 'update'; live: LiveSession }
  /** spawned; the transcript is not written yet (Claude Code writes it at the first prompt) */
  | { type: 'waiting'; ptyId: string; sid: string }
  /** the terminal exited; the last update stays valid */
  | { type: 'closed'; ptyId: string; sid: string }

/** A watched file changed on disk; `path` is workspace-relative. */
export type FileChange = { path: string; kind: 'change' | 'unlink' }

export type DocentApi = {
  workspace: {
    get(): Promise<WorkspaceInfo>
    choose(): Promise<WorkspaceInfo | undefined>
    list(path: string): Promise<DirEntry[]>
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    /** the files to watch for outside changes (the open tabs), workspace-relative; replaces the previous set */
    watch(paths: string[]): void
    onChanged(fn: (e: FileChange) => void): () => void
  }
  pty: {
    spawn(req: PtySpawnRequest): Promise<PtySpawnResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onEvent(fn: (e: PtyEvent) => void): () => void
  }
  ide: {
    onEvent(fn: (e: IdeEvent) => void): () => void
    reply(id: string, result: IdeReply): void
    editorState(state: EditorState): void
    atMentioned(m: AtMention): void
  }
  watch: {
    onEvent(fn: (e: WatchEvent) => void): () => void
    sessions(): Promise<WatchSession[]>
    host(): Promise<WatchHostStatus>
    action(sid: string, action: WatchAction, value?: string): Promise<void>
  }
  session: {
    onEvent(fn: (e: SessionEvent) => void): () => void
    get(ptyId: string): Promise<LiveSession | undefined>
  }
  recap: {
    /** asks where to save, writes the session's recap HTML there; undefined if cancelled or nothing to recap */
    export(ptyId: string): Promise<{ path: string } | undefined>
  }
}

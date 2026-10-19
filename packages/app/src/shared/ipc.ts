// The contract between the renderer and the main process. Plain JSON both ways.
export type DirEntry = { name: string; path: string; kind: 'file' | 'dir'; size?: number; mtimeMs?: number }

export type TerminalKind = 'claude' | 'shell'

export type PtySpawnRequest = { kind: TerminalKind; cols: number; rows: number; resume?: string }
export type PtySpawnResult = { id: string; sessionId?: string; command: string }

export type PtyEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number }
  | { type: 'title'; id: string; title: string }
  | { type: 'status'; id: string; raw: string }

export type WorkspaceInfo = { root: string; name: string; claudeBinary?: string; pairwatchDir?: string }

export type DocentApi = {
  workspace: {
    get(): Promise<WorkspaceInfo>
    choose(): Promise<WorkspaceInfo | undefined>
    list(path: string): Promise<DirEntry[]>
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
  pty: {
    spawn(req: PtySpawnRequest): Promise<PtySpawnResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onEvent(fn: (e: PtyEvent) => void): () => void
  }
}

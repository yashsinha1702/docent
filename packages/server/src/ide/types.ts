// The IDE protocol's public shapes: what the app implements (IdeHost) and what it gets back (IdeServer).
// Lines and characters are 0-based as VS Code counts them; every path is absolute.

/** 0-based line and character, as VS Code counts them. */
export type Position = { line: number; character: number }
export type Selection = { filePath: string; text: string; selection: { start: Position; end: Position; isEmpty: boolean } }
export type OpenEditor = { path: string; dirty: boolean; active: boolean }
export type DiffOutcome = { outcome: 'saved'; contents: string } | { outcome: 'rejected' } | { outcome: 'closed' }
export type OpenDiffRequest = { oldPath: string; newPath: string; newContents: string; tabName: string }
export type OpenFileRequest = { path: string; preview: boolean; startText?: string; endText?: string; selectToEndOfLine: boolean; makeFrontmost: boolean }
export type AtMention = { filePath: string; lineStart?: number; lineEnd?: number }

/** What the editor must answer; the app implements it by relaying to the renderer. Paths are absolute. */
export type IdeHost = {
  workspaceFolders(): string[]
  openEditors(): OpenEditor[]
  currentSelection(): Selection | undefined
  latestSelection(): Selection | undefined
  /** undefined when the file is not open */
  isDirty(path: string): boolean | undefined
  openDiff(req: OpenDiffRequest): Promise<DiffOutcome>
  /** true when a tab of that name was open */
  closeTab(tabName: string): Promise<boolean>
  /** how many diff tabs were closed */
  closeAllDiffTabs(): Promise<number>
  openFile(req: OpenFileRequest): Promise<void>
  saveDocument(path: string): Promise<boolean>
}

export type IdeServerOptions = {
  host: IdeHost
  /** shown by the CLI; default 'Docent' */
  ideName?: string
  /** the directory holding ide/<port>.lock; default $CLAUDE_CONFIG_DIR or ~/.claude */
  configDir?: string
  /** the pid written to the lock; default process.pid */
  pid?: number
  /** a port to try first; default random 10000-65535, free on 127.0.0.1 */
  port?: number
  /** reported in MCP serverInfo */
  version?: string
  /** diagnostics (rejected clients, notifications received, failures); the server never writes to the console itself */
  log?: (msg: string) => void
}

export type IdeServer = {
  readonly port: number
  readonly authToken: string
  readonly lockPath: string
  readonly connected: boolean
  onConnection(fn: (connected: boolean) => void): () => void
  notifySelectionChanged(sel: Selection): void
  notifyAtMentioned(m: AtMention): void
  notifyDiagnosticsChanged(uris: string[]): void
  /** stops listening, drops the client and deletes the lock file */
  close(): Promise<void>
}

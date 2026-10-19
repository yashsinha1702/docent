// The twelve tools the CLI calls on an IDE, answering with the strings and JSON shapes of the VS Code
// extension (2.1.301 extension.js, functions v64/P14/w14/C14/T14/E14/v14) so the CLI cannot tell Docent
// apart. Every JSON result is pretty-printed with a two-space indent because the extension does that.
// Where Docent cannot know what VS Code knows (line counts, an unsaved buffer's text) a comment says so.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { IdeHost, OpenEditor, Selection } from './types.ts'

export type TextContent = { type: 'text'; text: string }
export type ToolResult = { content: TextContent[]; isError?: true }
export type JsonSchema = Record<string, unknown>
export type ToolArgs = Record<string, unknown>
export type ToolDef = {
  name: string
  /** absent for close_tab, which the extension registers without one */
  description?: string
  inputSchema: JsonSchema
  annotations?: { readOnlyHint: boolean }
  handler: (args: ToolArgs, host: IdeHost) => Promise<ToolResult> | ToolResult
}

const text = (...texts: string[]): ToolResult => ({ content: texts.map((t): TextContent => ({ type: 'text', text: t })) })
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2))
export const errorResult = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

/** VS Code's Uri.file(p).toString(): file:///…, percent-encoded */
export const fileUrl = (p: string): string => pathToFileURL(p).href

/** the selection as the extension puts it on the wire (uv() in extension.js): also the selection_changed params */
export const toWireSelection = (sel: Selection) => ({
  text: sel.text,
  filePath: sel.filePath,
  fileUrl: sel.filePath === '' ? '' : fileUrl(sel.filePath),
  selection: sel.selection,
})

// --- JSON Schema as the SDK's zod-to-json-schema emits it for the extension's zod shapes ---

const string = (description?: string): JsonSchema => (description === undefined ? { type: 'string' } : { type: 'string', description })
const boolean = (description: string, dflt: boolean): JsonSchema => ({ type: 'boolean', description, default: dflt })
const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
})
// the five tools registered with the empty shape {}: the SDK (extension.js ws/CC1/FB/LC1) wraps it in a
// zod v4 Mini object and lists it through zod's own toJSONSchema (target draft-07, io 'input'), which
// puts $schema first and adds no additionalProperties; the SDK's bare {type:'object', properties:{}}
// is only listed for a tool registered with no shape at all, which none of these is
const NO_ARGS: JsonSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} }

// --- arguments ---

const requireString = (args: ToolArgs, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}
const optionalString = (args: ToolArgs, key: string): string | undefined => {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}
const booleanOr = (args: ToolArgs, key: string, fallback: boolean): boolean => {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

// the extension resolves a relative path against the first workspace folder
const resolvePath = (p: string, host: IdeHost): string => {
  if (path.isAbsolute(p)) return p
  const [root] = host.workspaceFolders()
  return root === undefined ? p : path.join(root, p)
}
const requirePath = (args: ToolArgs, key: string, host: IdeHost): string => {
  const value = args[key]
  if (typeof value !== 'string' || value === '') throw new Error('File path is required')
  return resolvePath(value, host)
}

// --- what VS Code would know about a file ---

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.py': 'python', '.rs': 'rust', '.go': 'go',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.svg': 'xml', '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.sql': 'sql', '.graphql': 'graphql',
  '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript', '.ps1': 'powershell', '.bat': 'bat',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.m': 'objective-c', '.swift': 'swift',
  '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.cs': 'csharp', '.fs': 'fsharp', '.rb': 'ruby', '.php': 'php',
  '.lua': 'lua', '.r': 'r', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hs': 'haskell',
  '.clj': 'clojure', '.vue': 'vue', '.svelte': 'svelte', '.tex': 'latex', '.txt': 'plaintext', '.dockerfile': 'dockerfile',
}

/** VS Code's language id for a path, by extension; 'plaintext' when unknown, as VS Code falls back */
export const languageIdOf = (p: string): string => {
  const base = path.basename(p)
  if (base === 'Dockerfile') return 'dockerfile'
  if (base === 'Makefile') return 'makefile'
  return LANGUAGE_IDS[path.extname(base).toLowerCase()] ?? 'plaintext'
}

/** openFile's answer when startText was given: the extension searches the document text with indexOf */
export function selectionMessage(contents: string, startText: string, endText: string | undefined): string {
  const start = contents.indexOf(startText)
  if (start === -1) return `Opened file, but text "${startText}" not found`
  if (!endText) return `Opened file and selected text "${startText}"`
  const end = contents.slice(start + startText.length).indexOf(endText)
  return end === -1
    ? `Opened file and positioned at "${startText}" (end text "${endText}" not found)`
    : `Opened file and selected text from "${startText}" to "${endText}"`
}

/** one getOpenEditors tab; Docent has a single editor group, and lineCount is left out: the host does not report it */
function describeEditor(editor: OpenEditor, active: Selection | undefined) {
  const p = editor.path
  const selection = editor.active && active?.filePath === p ? { start: active.selection.start, end: active.selection.end, isReversed: false } : undefined
  return {
    uri: fileUrl(p),
    isActive: editor.active,
    isPinned: false,
    isPreview: false,
    isDirty: editor.dirty,
    label: path.basename(p),
    groupIndex: 0,
    viewColumn: 1,
    isGroupActive: true,
    fileName: p,
    languageId: languageIdOf(p),
    isUntitled: false,
    ...(selection === undefined ? {} : { selection }),
  }
}

const EXECUTE_CODE_DESCRIPTION = [
  'Execute python code in the Jupyter kernel for the current notebook file.',
  '    ',
  '    All code will be executed in the current Jupyter kernel.',
  '    ',
  '    Avoid declaring variables or modifying the state of the kernel unless the user',
  '    explicitly asks for it.',
  '    ',
  '    Any code executed will persist across calls to this tool, unless the kernel',
  '    has been restarted.',
].join('\n')

// --- the tools, in the extension's registration order ---

const openDiff: ToolDef = {
  name: 'openDiff',
  description: 'Open a git diff for the file',
  inputSchema: object(
    {
      old_file_path: string('Path to the file to show diff for. If not provided, uses active editor.'),
      new_file_path: string('Path to the file to show diff for. If not provided, uses active editor.'),
      new_file_contents: string('Contents of the new file. If not provided then the current file contents of new_file_path will be used.'),
      tab_name: string('Path to the file to show diff for. If not provided, uses active editor.'),
    },
    ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
  ),
  async handler(args, host) {
    const tabName = requireString(args, 'tab_name')
    const outcome = await host.openDiff({
      oldPath: requireString(args, 'old_file_path'),
      newPath: requireString(args, 'new_file_path'),
      newContents: requireString(args, 'new_file_contents'),
      tabName,
    })
    switch (outcome.outcome) {
      case 'saved':
        return text('FILE_SAVED', outcome.contents)
      case 'rejected':
        return text('DIFF_REJECTED', tabName)
      case 'closed':
        // like the 2.1.301 extension: a tab closed without a decision is a rejection. The CLI's
        // TAB_CLOSED branch would apply the proposed contents anyway (verified in the 2.1.303 binary).
        return text('DIFF_REJECTED', tabName)
    }
  },
}

const getDiagnostics: ToolDef = {
  name: 'getDiagnostics',
  description: 'Get language diagnostics from VS Code',
  inputSchema: object({ uri: string('Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files.') }, []),
  // no language service yet: the extension's JSON.stringify(<per-file entries>, null, 2) with nothing to report
  handler: () => text('[]'),
}

const closeTab: ToolDef = {
  name: 'close_tab',
  inputSchema: object({ tab_name: string() }, ['tab_name']),
  async handler(args, host) {
    await host.closeTab(requireString(args, 'tab_name'))
    return text('TAB_CLOSED')
  },
}

const closeAllDiffTabs: ToolDef = {
  name: 'closeAllDiffTabs',
  description: 'Close all diff tabs in the editor',
  inputSchema: NO_ARGS,
  async handler(_args, host) {
    return text(`CLOSED_${await host.closeAllDiffTabs()}_DIFF_TABS`)
  },
}

const openFile: ToolDef = {
  name: 'openFile',
  description: 'Open a file in the editor and optionally select a range of text',
  inputSchema: object(
    {
      filePath: string('Path to the file to open'),
      preview: boolean('Whether to open the file in preview mode', false),
      startText: string('Text pattern to find the start of the selection range. Selects from the beginning of this match.'),
      endText: string('Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected.'),
      selectToEndOfLine: boolean('If true, selection will extend to the end of the line containing the endText match.', false),
      makeFrontmost: boolean('Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus.', true),
    },
    // the extension's zod shape leaves startText and endText without .optional(), so they are listed as required
    ['filePath', 'startText', 'endText'],
  ),
  annotations: { readOnlyHint: true },
  async handler(args, host) {
    const filePath = requirePath(args, 'filePath', host)
    // the file on disk stands in for the document text VS Code would search; an unsaved buffer may differ
    const contents = await readFile(filePath, 'utf8').catch(() => {
      throw new Error(`File not found: ${filePath}`)
    })
    const startText = optionalString(args, 'startText')
    const endText = optionalString(args, 'endText')
    const makeFrontmost = booleanOr(args, 'makeFrontmost', true)
    await host.openFile({
      path: filePath,
      preview: booleanOr(args, 'preview', false),
      startText,
      endText,
      selectToEndOfLine: booleanOr(args, 'selectToEndOfLine', false),
      makeFrontmost,
    })
    if (startText) return text(selectionMessage(contents, startText, endText))
    if (makeFrontmost) return text(`Opened file: ${filePath}`)
    return json({
      success: true,
      filePath,
      fileUrl: fileUrl(filePath),
      message: `Opened file: ${filePath}`,
      languageId: languageIdOf(filePath),
      lineCount: contents.split('\n').length,
      isDirty: host.isDirty(filePath) ?? false,
      isUntitled: false,
      isClosed: false,
    })
  },
}

const getOpenEditors: ToolDef = {
  name: 'getOpenEditors',
  description: 'Get information about currently open editors',
  inputSchema: NO_ARGS,
  handler: (_args, host) => {
    const active = host.currentSelection()
    return json({ tabs: host.openEditors().map(editor => describeEditor(editor, active)) })
  },
}

const getWorkspaceFolders: ToolDef = {
  name: 'getWorkspaceFolders',
  description: 'Get all workspace folders currently open in the IDE',
  inputSchema: NO_ARGS,
  handler: (_args, host) => {
    const folders = host.workspaceFolders().map((p, index) => ({ name: path.basename(p), uri: fileUrl(p), path: p, index }))
    // rootPath is VS Code's deprecated first-folder path; workspaceFile only exists for .code-workspace files
    return json({ success: true, folders, rootPath: folders[0]?.path ?? null, workspaceFile: null })
  },
}

const getCurrentSelection: ToolDef = {
  name: 'getCurrentSelection',
  description: 'Get the current text selection in the active editor',
  inputSchema: NO_ARGS,
  handler: (_args, host) => {
    const sel = host.currentSelection()
    // an empty selection in an active editor is still a success with text ''; the extension's other
    // failure, "No selection available", needs its attach settings switched off and cannot happen here
    return sel === undefined ? json({ success: false, message: 'No active editor found' }) : json({ success: true, ...toWireSelection(sel) })
  },
}

const checkDocumentDirty: ToolDef = {
  name: 'checkDocumentDirty',
  description: 'Check if a document has unsaved changes (is dirty)',
  inputSchema: object({ filePath: string('Path to the file to check') }, ['filePath']),
  handler: (args, host) => {
    const filePath = requirePath(args, 'filePath', host)
    const isDirty = host.isDirty(filePath)
    return isDirty === undefined
      ? json({ success: false, message: `Document not open: ${filePath}` })
      : json({ success: true, filePath, isDirty, isUntitled: false })
  },
}

const saveDocument: ToolDef = {
  name: 'saveDocument',
  description: 'Save a document with unsaved changes',
  inputSchema: object({ filePath: string('Path to the file to save') }, ['filePath']),
  async handler(args, host) {
    const filePath = requirePath(args, 'filePath', host)
    if (host.isDirty(filePath) === undefined) return json({ success: false, message: `Document not open: ${filePath}` })
    const saved = await host.saveDocument(filePath)
    return json({ success: true, filePath, saved, message: saved ? 'Document saved successfully' : 'Document was not dirty or save failed' })
  },
}

const getLatestSelection: ToolDef = {
  name: 'getLatestSelection',
  description: 'Get the most recent text selection (even if not in the active editor)',
  inputSchema: NO_ARGS,
  handler: (_args, host) => {
    const sel = host.latestSelection()
    // the extension returns the bare selection here, without the success flag getCurrentSelection adds
    return json(sel === undefined ? { success: false, message: 'No selection available' } : toWireSelection(sel))
  },
}

const executeCode: ToolDef = {
  name: 'executeCode',
  description: EXECUTE_CODE_DESCRIPTION,
  inputSchema: object({ code: string('The code to be executed on the kernel.') }, ['code']),
  // VS Code runs this in a Jupyter kernel; Docent has none
  handler: () => errorResult('executeCode is not supported in Docent'),
}

export const ideTools: readonly ToolDef[] = [
  openDiff,
  getDiagnostics,
  closeTab,
  closeAllDiffTabs,
  openFile,
  getOpenEditors,
  getWorkspaceFolders,
  getCurrentSelection,
  checkDocumentDirty,
  saveDocument,
  getLatestSelection,
  executeCode,
]

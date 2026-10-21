// How the tree and the steps strip name a file: workspace-relative with '/' separators, as the workspace
// API's DirEntry.path does. Pure. The arithmetic is the editor's (editor/paths.ts), so the tree, the steps
// strip and showLines agree on what lies inside the workspace: a drive or UNC root is Windows (either
// slash, names compare without case), any other root is POSIX (a backslash is part of a name).
import { relativeTo, styleOf } from '../editor/paths'

/**
 * A path as the workspace names it ('src/a.ts'), or undefined when it lies outside the workspace, is the
 * root itself, or there is no root. A relative path is taken against the root, as the CLI's own are; a
 * '~' path never matches. Under a Windows root the result keeps the path's own case (see pathKey).
 */
export function workspacePath(p: unknown, root: string | undefined): string | undefined {
  if (typeof p !== 'string' || root === undefined || root === '') return undefined
  const s = p.trim()
  if (s === '' || s.startsWith('~') || s.includes('\n')) return undefined
  return relativeTo(root, s) || undefined
}

/** An absolute path in the root's style: '/a' under a POSIX root; 'C:\a', 'C:/a', '\\srv\share\a' or a rooted '\a' under a Windows one. */
export const isAbsolutePath = (p: string, root: string): boolean => (styleOf(root) === 'win' ? /^(?:[a-zA-Z]:)?[\\/]/.test(p) : p.startsWith('/'))

/** Names under this root compare without case: a Windows root, where 'SRC/App.ts' and 'src/app.ts' are one file. */
export const foldsCase = (root: string): boolean => styleOf(root) === 'win'

/** A workspace-relative path as a lookup key: itself, or lower-cased where names compare without case. */
export const pathKey = (rel: string, root: string): string => (foldsCase(root) ? rel.toLowerCase() : rel)

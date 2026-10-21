// Pure path arithmetic for the IDE protocol: the CLI names files by absolute path, the workspace API
// takes paths relative to the root, always with forward slashes. Plain string normalisation, no
// realpath: the CLI runs with the workspace root as its cwd, so its paths share the root's spelling,
// and the main process jails the real path anyway. That holds only while `root` is canonical: Node's
// process.cwd() under a symlinked folder is the real path, so main must hand the renderer a
// realpath'd root, or every CLI path under a symlink reads as outside it.
//
// The root decides the style. A drive-letter root (C:\Users\me\proj) or a UNC one (\\server\share\proj)
// is Windows: paths under it may use backslashes, forward slashes or both, compare without regard to
// case, and absolute paths handed back to the CLI use backslashes like the root. Any other root is
// POSIX, where a backslash is an ordinary file-name character; POSIX behaviour is what it always was.

export type PathStyle = 'posix' | 'win'

/** Windows for a drive-letter root (C:\, C:/, C:) or a UNC / device root (\\server\share, \\?\C:\); POSIX otherwise. */
export const styleOf = (root: string): PathStyle => (/^[a-zA-Z]:([\\/]|$)/.test(root) || root.startsWith('\\\\') ? 'win' : 'posix')

/** Collapses '//', resolves '.' and '..' segments, drops a trailing slash; keeps a leading '/'. POSIX. */
export const normalise = (p: string): string => {
  const absolute = p.startsWith('/')
  return (absolute ? '/' : '') + resolveSegments(p.split('/'), absolute).join('/')
}

/** '.' and empty segments dropped, '..' applied; a rooted path cannot climb above its root. */
const resolveSegments = (segs: readonly string[], rooted: boolean): string[] => {
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') out.push(seg)
    else if (out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (!rooted) out.push('..')
  }
  return out
}

// ---- Windows

/**
 * A Windows path taken apart, separators made '/': `prefix` is a drive ('C:'), a UNC share ('//server/share')
 * or '' (no drive); `rooted` says the segments start at the prefix's root (C:\x, \\s\share\x, \x) rather than
 * at a current directory (C:x, x). Device paths (\\?\C:\x, \\?\UNC\server\share\x) lose their device part, and
 * an MSYS / Git Bash path (/c/Users/..., /cygdrive/c/...) names its drive.
 */
type WinPath = { prefix: string; rooted: boolean; segs: string[] }

const parseWin = (p: string): WinPath => {
  let s = p.replace(/\\/g, '/')
  if (/^\/\/[?.]\//.test(s)) s = /^unc\//i.test(s.slice(4)) ? `//${s.slice(8)}` : s.slice(4)
  const drive = /^([a-zA-Z]):/.exec(s)
  if (drive) return { prefix: `${drive[1]}:`, rooted: s[2] === '/', segs: s.slice(2).split('/') }
  if (s.startsWith('//')) {
    const [server = '', share = '', ...rest] = s.slice(2).split('/')
    return { prefix: share === '' ? `//${server}` : `//${server}/${share}`, rooted: true, segs: rest }
  }
  // MSYS spells paths with forward slashes only; \x\y stays a rooted path on the current drive
  const msys = p.startsWith('/') ? /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/|$)/.exec(s) : null
  if (msys) return { prefix: `${msys[1]}:`, rooted: true, segs: s.slice(msys[0].length).split('/') }
  return { prefix: '', rooted: s.startsWith('/'), segs: s.split('/') }
}

/** Windows compares names without regard to case. */
const sameName = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase()

const relativeToWin = (root: string, path: string): string | undefined => {
  const r = parseWin(root)
  const base = resolveSegments(r.segs, true)
  const p = parseWin(path)
  // C:x and plain relative paths continue from the current directory, which for the CLI is the root;
  // \x (rooted, no drive) is on the root's drive
  if (p.prefix !== '' && !sameName(p.prefix, r.prefix)) return undefined
  const segs = p.rooted ? resolveSegments(p.segs, true) : resolveSegments([...base, ...p.segs], true)
  if (segs.length < base.length) return undefined
  for (let i = 0; i < base.length; i++) if (!sameName(segs[i]!, base[i]!)) return undefined
  return segs.slice(base.length).join('/')
}

const absoluteWin = (root: string, rel: string): string => {
  const r = parseWin(root)
  const segs = resolveSegments([...r.segs, ...rel.replace(/\\/g, '/').split('/')], true)
  if (r.prefix.startsWith('//')) return [r.prefix.replace(/\//g, '\\'), ...segs].join('\\')
  return `${r.prefix}\\${segs.join('\\')}`
}

// ---- both styles

/**
 * `path` as a root-relative path (forward slashes): '' for the root itself, undefined when it lies outside
 * the root. A relative `path` is taken against the root, as the VS Code extension's openFile also does.
 */
export const relativeTo = (root: string, path: string): string | undefined => {
  if (styleOf(root) === 'win') return relativeToWin(root, path)
  const r = normalise(root)
  const p = normalise(path.startsWith('/') ? path : `${r}/${path}`)
  if (p === r) return ''
  const prefix = r === '/' ? '/' : `${r}/`
  return p.startsWith(prefix) ? p.slice(prefix.length) : undefined
}

/** The absolute path of a root-relative one, in the root's style (backslashes under a Windows root). */
export const absolute = (root: string, rel: string): string => (styleOf(root) === 'win' ? absoluteWin(root, rel) : normalise(`${root}/${rel}`))

/** Two root-relative paths name the same file: the same string, or under a Windows root the same but for case. */
export const samePath = (root: string, a: string, b: string): boolean => a === b || (styleOf(root) === 'win' && a.toLowerCase() === b.toLowerCase())

/** The last segment: what a tab is labelled with. A Windows absolute path splits at backslashes too. */
export const basename = (p: string): string => normalise(styleOf(p) === 'win' ? p.replace(/\\/g, '/') : p).split('/').pop() ?? ''

// Sanity checks: deterministic, so a failure shows up on the first load rather than in a review.
const check = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`paths: ${what}`)
}
check(relativeTo('/w', '/w/src/a.ts') === 'src/a.ts', 'a file inside the root')
check(relativeTo('/w/', '/w/src//b/./c/../a.ts') === 'src/b/a.ts', 'normalisation of both sides')
check(relativeTo('/w', '/w/../w2/a.ts') === undefined, 'dot-dot leaving the root')
check(relativeTo('/w', '/w2/a.ts') === undefined, 'a sibling that shares the root as a string prefix')
check(relativeTo('/w', 'src/a.ts') === 'src/a.ts', 'a relative path resolves against the root')
check(relativeTo('/w', '../a.ts') === undefined, 'a relative path leaving the root')
check(relativeTo('/w', '/w') === '', 'the root itself')
check(absolute('/w', 'src/a.ts') === '/w/src/a.ts', 'back to absolute')
check(normalise('../../a') === '../../a', 'leading dot-dots of a relative path survive')
check(basename('/w/src/a.ts') === 'a.ts' && basename('a.ts/') === 'a.ts', 'basename')
check(relativeTo('C:\\w', 'c:/W/src\\a.ts') === 'src/a.ts', 'a Windows root: mixed separators, any case')
check(relativeTo('C:\\w', 'C:\\w2\\a.ts') === undefined && relativeTo('C:\\w', 'D:\\w\\a.ts') === undefined, 'a Windows sibling, another drive')
check(absolute('C:\\w', 'src/a.ts') === 'C:\\w\\src\\a.ts', 'back to absolute in the root style')
check(relativeTo('\\\\srv\\share\\w', '//SRV/share/w/a.ts') === 'a.ts', 'a UNC root')

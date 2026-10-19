// Pure path arithmetic for the IDE protocol: the CLI names files by absolute path, the workspace API
// takes paths relative to the root. POSIX only (the app targets macOS and Linux). Plain string
// normalisation, no realpath: the CLI runs with the workspace root as its cwd, so its paths share
// the root's spelling, and the main process jails the real path anyway. That holds only while
// `root` is canonical: Node's process.cwd() under a symlinked folder is the real path, so main must
// hand the renderer a realpath'd root, or every CLI path under a symlink reads as outside it.

/** Collapses '//', resolves '.' and '..' segments, drops a trailing slash; keeps a leading '/'. */
export const normalise = (p: string): string => {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg !== '..') out.push(seg)
    else if (out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (!absolute) out.push('..')
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * `path` as a root-relative path: '' for the root itself, undefined when it lies outside the root.
 * A relative `path` is taken against the root, as the VS Code extension's openFile also does.
 */
export const relativeTo = (root: string, path: string): string | undefined => {
  const r = normalise(root)
  const p = normalise(path.startsWith('/') ? path : `${r}/${path}`)
  if (p === r) return ''
  const prefix = r === '/' ? '/' : `${r}/`
  return p.startsWith(prefix) ? p.slice(prefix.length) : undefined
}

/** The absolute path of a root-relative one. */
export const absolute = (root: string, rel: string): string => normalise(`${root}/${rel}`)

/** The last segment: what a tab is labelled with. */
export const basename = (p: string): string => normalise(p).split('/').pop() ?? ''

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

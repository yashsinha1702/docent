// The editor's path arithmetic (src/renderer/src/editor/paths.ts) on POSIX and Windows roots: what the CLI
// sends (absolute, any separators, any case under Windows) against the workspace's relative paths, and the
// absolute paths sent back in the root's own style.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { absolute, basename, normalise, relativeTo, samePath, styleOf } from '../src/renderer/src/editor/paths.ts'

test('styleOf: drive letters and UNC roots are Windows; everything else POSIX', () => {
  for (const root of ['C:\\Users\\me\\proj', 'c:/Users/me/proj', 'D:', 'D:\\', '\\\\server\\share\\proj', '\\\\?\\C:\\proj']) assert.equal(styleOf(root), 'win', root)
  for (const root of ['/w', '/', 'w', '//w', 'C', 'CC:\\x', './C:/x']) assert.equal(styleOf(root), 'posix', root)
})

test('POSIX: unchanged, a backslash is a file-name character', () => {
  assert.equal(relativeTo('/w', '/w/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo('/w', '/W/src/a.ts'), undefined, 'case matters on POSIX')
  assert.equal(relativeTo('/w', '/w/src\\a.ts'), 'src\\a.ts')
  assert.equal(relativeTo('/w', 'C:\\x'), 'C:\\x', 'a Windows-looking path under a POSIX root is just a relative name')
  assert.equal(absolute('/w', 'src/a.ts'), '/w/src/a.ts')
  assert.equal(normalise('/a/b\\c/../d'), '/a/d')
  assert.equal(basename('/w/a\\b.ts'), 'a\\b.ts')
  assert.equal(samePath('/w', 'src/A.ts', 'src/a.ts'), false)
})

test('Windows drive root: backslashes, forward slashes and a mix; case does not matter', () => {
  const root = 'C:\\Users\\me\\proj'
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj\\src\\a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, 'C:/Users/me/proj/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, 'C:\\Users/me\\proj/src\\a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, 'c:\\users\\ME\\Proj\\src\\a.ts'), 'src/a.ts', 'the root part compares without case; the rest keeps its spelling')
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj\\SRC\\A.ts'), 'SRC/A.ts')
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj\\.\\src\\..\\lib\\\\b.ts'), 'lib/b.ts')
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj'), '')
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj\\'), '')
  assert.equal(relativeTo(root, 'c:/users/me/proj/'), '')
})

test('Windows drive root: outside stays outside', () => {
  const root = 'C:\\Users\\me\\proj'
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj2\\a.ts'), undefined, 'a sibling sharing the root as a prefix')
  assert.equal(relativeTo(root, 'C:\\Users\\me\\proj\\..\\other\\a.ts'), undefined)
  assert.equal(relativeTo(root, 'D:\\Users\\me\\proj\\a.ts'), undefined, 'another drive')
  assert.equal(relativeTo(root, '..\\a.ts'), undefined)
  assert.equal(relativeTo(root, 'C:\\a.ts'), undefined)
  assert.equal(relativeTo('C:\\', 'C:\\..\\..\\a.ts'), 'a.ts', 'no climbing above a drive root')
})

test('Windows: relative, drive-relative, rooted, device and MSYS spellings', () => {
  const root = 'C:\\Users\\me\\proj'
  assert.equal(relativeTo(root, 'src\\a.ts'), 'src/a.ts', 'relative: against the root (the CLI cwd)')
  assert.equal(relativeTo(root, 'src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, 'C:src\\a.ts'), 'src/a.ts', "drive-relative on the root's drive: from the root")
  assert.equal(relativeTo(root, 'D:src\\a.ts'), undefined)
  assert.equal(relativeTo(root, '\\Users\\me\\proj\\a.ts'), 'a.ts', "rooted without a drive: the root's drive")
  assert.equal(relativeTo(root, '\\\\?\\C:\\Users\\me\\proj\\a.ts'), 'a.ts', 'a device path')
  assert.equal(relativeTo(root, '/c/Users/me/proj/a.ts'), 'a.ts', 'Git Bash')
  assert.equal(relativeTo(root, '/cygdrive/c/Users/me/proj/a.ts'), 'a.ts', 'Cygwin')
  assert.equal(relativeTo(root, '/d/Users/me/proj/a.ts'), undefined)
  // a backslash-rooted path is never read as MSYS, even with a one-letter first folder
  assert.equal(relativeTo('C:\\w', '\\w\\a.ts'), 'a.ts')
})

test('Windows UNC roots', () => {
  const root = '\\\\server\\share\\proj'
  assert.equal(relativeTo(root, '\\\\server\\share\\proj\\src\\a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, '//SERVER/Share/proj/src/a.ts'), 'src/a.ts', 'forward slashes, other case')
  assert.equal(relativeTo(root, '\\\\?\\UNC\\server\\share\\proj\\a.ts'), 'a.ts', 'the device form of a UNC path')
  assert.equal(relativeTo(root, '\\\\other\\share\\proj\\a.ts'), undefined)
  assert.equal(relativeTo(root, '\\\\server\\share2\\proj\\a.ts'), undefined)
  assert.equal(relativeTo(root, 'C:\\proj\\a.ts'), undefined)
  assert.equal(relativeTo(root, 'src\\a.ts'), 'src/a.ts')
  assert.equal(relativeTo(root, '\\proj\\a.ts'), 'a.ts', 'rooted: the share root')
})

test('absolute: in the root style, backslashes under a Windows root', () => {
  assert.equal(absolute('C:\\Users\\me\\proj', 'src/a.ts'), 'C:\\Users\\me\\proj\\src\\a.ts')
  assert.equal(absolute('C:\\Users\\me\\proj\\', 'src/a.ts'), 'C:\\Users\\me\\proj\\src\\a.ts')
  assert.equal(absolute('C:\\Users\\me\\proj', ''), 'C:\\Users\\me\\proj')
  assert.equal(absolute('C:\\', 'a.ts'), 'C:\\a.ts')
  assert.equal(absolute('C:\\', ''), 'C:\\')
  assert.equal(absolute('c:/Users/me/proj', 'src/a.ts'), 'c:\\Users\\me\\proj\\src\\a.ts', "the root's own spelling, separators made native")
  assert.equal(absolute('\\\\server\\share\\proj', 'src/a.ts'), '\\\\server\\share\\proj\\src\\a.ts')
  assert.equal(absolute('\\\\server\\share', ''), '\\\\server\\share')
  // a round trip from what the CLI sends to what goes back
  const root = 'C:\\Users\\me\\proj'
  assert.equal(absolute(root, relativeTo(root, 'C:/Users/me/proj/src/a.ts')!), 'C:\\Users\\me\\proj\\src\\a.ts')
})

test('samePath and basename under Windows', () => {
  assert.equal(samePath('C:\\w', 'src/A.ts', 'src/a.ts'), true)
  assert.equal(samePath('C:\\w', 'src/a.ts', 'src/b.ts'), false)
  assert.equal(samePath('\\\\s\\share', 'X', 'x'), true)
  assert.equal(basename('C:\\Users\\me\\proj\\src\\a.ts'), 'a.ts')
  assert.equal(basename('C:/Users/me/proj/src/a.ts'), 'a.ts')
  assert.equal(basename('\\\\server\\share\\proj\\a.ts'), 'a.ts')
  assert.equal(basename('src/a.ts'), 'a.ts')
})

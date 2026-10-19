// node-pty's prebuilt spawn-helper loses its executable bit on install (seen with node-pty 1.1.0 on macOS);
// without it every pty.spawn fails with "posix_spawnp failed". Best effort, Unix only.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const base of [join(root, 'node_modules', 'node-pty'), join(root, 'packages', 'app', 'node_modules', 'node-pty')]) {
    const prebuilds = join(base, 'prebuilds')
    if (!existsSync(prebuilds)) continue
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper')
      if (existsSync(helper)) {
        try {
          chmodSync(helper, 0o755)
          console.log(`postinstall: chmod +x ${helper}`)
        } catch (err) {
          console.warn(`postinstall: could not chmod ${helper}: ${err.message}`)
        }
      }
    }
  }
}

import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// @docent/server and @docent/core are TypeScript sources (no build step), so they are bundled into
// the main process; node-pty and ws stay external (a native addon, and plain Node code).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@docent/server', '@docent/core'] })],
    resolve: { alias: { '@docent/server': resolve(__dirname, '../server/src/index.ts'), '@docent/core': resolve(__dirname, '../core/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src'), '@docent/core': resolve(__dirname, '../core/index.ts') } },
  },
})

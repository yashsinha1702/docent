// Renders packages/app/build/icon.svg to packages/app/build/icon.png (1024 x 1024, transparent corners)
// with Electron's own Chromium, so no image tool is needed. electron-builder derives icon.icns and
// icon.ico from the PNG. Run it with the Electron binary itself (`npx electron` hangs on this machine):
//
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/make-icon.mjs   (macOS)
//   node_modules/electron/dist/electron scripts/make-icon.mjs                                (Linux, Windows: electron.exe)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, app } from 'electron'

const SIZE = 1024
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'packages', 'app', 'build', 'icon.svg')
const pngPath = join(root, 'packages', 'app', 'build', 'icon.png')

const watchdog = setTimeout(() => {
  console.error('make-icon: gave up after 30 s')
  app.exit(2)
}, 30_000)

// one image pixel per CSS pixel, whatever the screen
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.dock?.hide()

const page = svg =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<style>html,body{margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent}img{display:block;width:${SIZE}px;height:${SIZE}px}</style>` +
  `</head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}"></body></html>`

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, javascript: false },
  })
  await win.loadURL('data:text/html;base64,' + Buffer.from(page(readFileSync(svgPath, 'utf8')), 'utf8').toString('base64'))
  await new Promise(resolve => setTimeout(resolve, 500)) // let the image decode and paint
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  if (img.isEmpty()) throw new Error('the capture came back empty')
  const { width, height } = img.getSize()
  if (width !== SIZE || height !== SIZE) img = img.resize({ width: SIZE, height: SIZE, quality: 'best' })
  writeFileSync(pngPath, img.toPNG())
  console.log(`make-icon: wrote ${pngPath} (${SIZE}x${SIZE}, captured at ${width}x${height})`)
  win.destroy()
}

main()
  .then(() => {
    clearTimeout(watchdog)
    app.exit(0)
  })
  .catch(err => {
    console.error(`make-icon: ${err instanceof Error ? err.message : String(err)}`)
    clearTimeout(watchdog)
    app.exit(1)
  })

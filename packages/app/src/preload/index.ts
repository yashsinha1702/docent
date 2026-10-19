import { contextBridge, ipcRenderer } from 'electron'

import type { DocentApi, PtyEvent } from '../shared/ipc'

const api: DocentApi = {
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    choose: () => ipcRenderer.invoke('workspace:choose'),
    list: path => ipcRenderer.invoke('workspace:list', path),
    read: path => ipcRenderer.invoke('workspace:read', path),
    write: (path, text) => ipcRenderer.invoke('workspace:write', path, text),
  },
  pty: {
    spawn: req => ipcRenderer.invoke('pty:spawn', req),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: id => ipcRenderer.send('pty:kill', id),
    onEvent: fn => {
      const listener = (_e: Electron.IpcRendererEvent, ev: PtyEvent) => fn(ev)
      ipcRenderer.on('pty:event', listener)
      return () => ipcRenderer.off('pty:event', listener)
    },
  },
}

contextBridge.exposeInMainWorld('docent', api)

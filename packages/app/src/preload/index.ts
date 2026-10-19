import { contextBridge, ipcRenderer } from 'electron'

import type { DocentApi, IdeEvent, PtyEvent, WatchEvent } from '../shared/ipc'

const on = <T>(channel: string, fn: (e: T) => void) => {
  const listener = (_e: Electron.IpcRendererEvent, ev: T) => fn(ev)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

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
    onEvent: fn => on<PtyEvent>('pty:event', fn),
  },
  ide: {
    onEvent: fn => on<IdeEvent>('ide:event', fn),
    reply: (id, result) => ipcRenderer.send('ide:reply', id, result),
    editorState: state => ipcRenderer.send('ide:editorState', state),
    atMentioned: m => ipcRenderer.send('ide:atMentioned', m),
  },
  watch: {
    onEvent: fn => on<WatchEvent>('watch:event', fn),
    sessions: () => ipcRenderer.invoke('watch:sessions'),
    host: () => ipcRenderer.invoke('watch:host'),
    action: (sid, action, value) => ipcRenderer.invoke('watch:action', sid, action, value),
  },
}

contextBridge.exposeInMainWorld('docent', api)

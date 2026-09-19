// Narrow bridge for the app's own pages (start screen and log window). The
// harness page gets it too but never calls it; it exposes no Node access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harness', {
  state: () => ipcRenderer.invoke('harness:state'),
  retry: () => ipcRenderer.invoke('harness:retry'),
  openLogs: () => ipcRenderer.invoke('harness:openLogs'),
  onLog: (cb) => ipcRenderer.on('harness:log', (_e, entry) => cb(entry)),
  onStatus: (cb) => ipcRenderer.on('harness:status', (_e, s) => cb(s)),
  // In-app browser for the harness page's Browser tab (main.js places a sandboxed view over the given rect).
  browser: {
    show: (rect) => ipcRenderer.invoke('harness:browser', 'show', rect),
    hide: () => ipcRenderer.invoke('harness:browser', 'hide'),
    navigate: (url) => ipcRenderer.invoke('harness:browser', 'navigate', url),
    back: () => ipcRenderer.invoke('harness:browser', 'back'),
    forward: () => ipcRenderer.invoke('harness:browser', 'forward'),
    reload: () => ipcRenderer.invoke('harness:browser', 'reload'),
    stop: () => ipcRenderer.invoke('harness:browser', 'stop'),
    openExternal: () => ipcRenderer.invoke('harness:browser', 'openExternal'),
    onState: (cb) => {
      const f = (_e, s) => cb(s)
      ipcRenderer.on('harness:browser-state', f)
      return () => ipcRenderer.removeListener('harness:browser-state', f)
    },
  },
})

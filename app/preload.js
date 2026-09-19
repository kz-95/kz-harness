// Narrow bridge for the app's own pages (start screen and log window). The
// harness page gets it too but never calls it; it exposes no Node access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harness', {
  state: () => ipcRenderer.invoke('harness:state'),
  retry: () => ipcRenderer.invoke('harness:retry'),
  openLogs: () => ipcRenderer.invoke('harness:openLogs'),
  onLog: (cb) => ipcRenderer.on('harness:log', (_e, entry) => cb(entry)),
  onStatus: (cb) => ipcRenderer.on('harness:status', (_e, s) => cb(s)),
})

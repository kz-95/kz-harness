// Kz Harness desktop app. Starts DSH through C:\Harness\Start-DSH.ps1 (one
// place for the version pin and key checks), shows a start screen with the
// log while it boots, then opens the harness in this window. The log lives in
// its own window (Ctrl+Shift+L, tray, or the Harness menu). Quitting the app
// stops DSH and everything it started.
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')

const HARNESS = path.resolve(__dirname, '..')
const START_SCRIPT = path.join(HARNESS, 'Start-DSH.ps1')
const PORT = 3080
const ICON = path.join(__dirname, 'assets', 'logo.ico')
const BG = '#151517' // DSH dark base, so nothing flashes white while loading

app.setAppUserModelId('ai.kz.harness')
if (!app.requestSingleInstanceLock()) app.quit()

let main = null
let logWin = null
let tray = null
let dsh = null
let quitting = false
const logs = [] // { t, level, text }
let status = { phase: 'starting', message: 'Starting the harness…' }

// ---------- log + status fan-out ----------
const REDACT = /(token=)[\w-]+/g // the login token must never show on screen or be copied around
function levelOf(text) {
  // Router steps from the jev-router plugin ("[jev] …").
  if (/^\[jev\] (Routed|Review: accept|Final: accepted)/.test(text)) return 'ok'
  if (/^\[jev\] (Review: (retry|second_review|human)|Final: (needs_human|limit_reached))/.test(text)) return 'warn'
  if (/^\[jev\] Error:/.test(text)) return 'error'
  if (/^\[jev\]/.test(text)) return 'info'
  if (/\b(error|fatal|exception|failed|EADDRINUSE)\b/i.test(text)) return 'error'
  if (/\bwarn(ing)?\b/i.test(text)) return 'warn'
  if (/dsh web:|ready|listening/i.test(text)) return 'ok'
  return 'info'
}
function addLog(text, level) {
  const entry = { t: Date.now(), level: level ?? levelOf(text), text: text.replace(REDACT, '$1•••') }
  logs.push(entry)
  if (logs.length > 5000) logs.shift()
  for (const w of [main, logWin]) w?.webContents.send('harness:log', entry)
}
function setStatus(next) {
  status = next
  for (const w of [main, logWin]) w?.webContents.send('harness:status', status)
  tray?.setToolTip(`Kz Harness: ${status.message}`)
}

// ---------- DSH process ----------
const portBusy = () => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})

async function startDsh() {
  if (dsh) return
  setStatus({ phase: 'starting', message: 'Starting the harness…' })
  if (await portBusy()) {
    addLog(`Port ${PORT} is already in use.`, 'error')
    setStatus({ phase: 'error', message: `Another harness is already running on port ${PORT}. Close its black window (or the other Kz Harness), then click Retry.` })
    return
  }
  addLog(`> ${START_SCRIPT} -NoOpen`, 'cmd')
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', START_SCRIPT, '-NoOpen'], { cwd: HARNESS, windowsHide: true })
  let buffer = ''
  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop()
    for (const raw of lines) {
      const line = raw.replace(/^\uFEFF/, '').trimEnd()
      if (!line) continue
      const m = line.match(/dsh web:\s*(http\S+)/)
      addLog(line)
      if (m) openHarness(m[1])
    }
  }
  dsh = child
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code) => {
    if (dsh !== child || quitting) return // stopped on purpose (restart or quit)
    dsh = null
    addLog(`Harness stopped (exit ${code}).`, code ? 'error' : 'info')
    setStatus({ phase: 'error', message: code ? `The harness stopped with an error (exit ${code}). See the log, then click Retry.` : 'The harness stopped.' })
    showStartScreen()
  })
}

function stopDsh() {
  if (!dsh?.pid) return
  // powershell -> npx -> node: only a tree kill stops the server.
  try { execFileSync('taskkill', ['/pid', String(dsh.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  dsh = null
}

/** Harness -> Check for updates: runs scripts/Update-Harness.ps1 into the log, then restarts the harness. */
let updating = false
function checkForUpdates() {
  if (updating) return openLogs()
  updating = true
  openLogs()
  addLog('> scripts\\Update-Harness.ps1', 'cmd')
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HARNESS, 'scripts', 'Update-Harness.ps1')], { cwd: HARNESS, windowsHide: true })
  let buffer = ''
  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop()
    for (const line of lines) if (line.trim()) addLog(line.trimEnd(), /WARN/.test(line) ? 'warn' : undefined)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code) => {
    updating = false
    if (code) return addLog(`Update failed (exit ${code}); the harness keeps running as it was.`, 'error')
    addLog('Update finished; restarting the harness.', 'ok')
    restartDsh()
  })
}

function restartDsh() {
  stopDsh()
  addLog('Restarting…', 'cmd')
  showStartScreen()
  setTimeout(startDsh, 800)
}

// ---------- windows ----------
const secure = { contextIsolation: true, nodeIntegration: false, sandbox: true }

function showStartScreen() {
  main?.loadFile(path.join(__dirname, 'ui', 'console.html'), { hash: 'start' })
}

function openHarness(url) {
  setStatus({ phase: 'ready', message: 'Harness running', origin: new URL(url).origin })
  main?.loadURL(url)
}

function createMain() {
  main = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600,
    title: 'Kz Harness', icon: ICON, backgroundColor: BG, show: false,
    webPreferences: { ...secure, preload: path.join(__dirname, 'preload.js') },
  })
  main.once('ready-to-show', () => main.show())
  // The harness page sets its own title; keep the app name on the window.
  main.on('page-title-updated', (e, title) => { e.preventDefault(); main.setTitle(status.phase === 'ready' && title ? `${title} · Kz Harness` : 'Kz Harness') })
  lockNavigation(main)
  main.on('closed', () => { main = null; app.quit() })
  showStartScreen()
}

function openLogs() {
  if (logWin) { logWin.show(); logWin.focus(); return }
  logWin = new BrowserWindow({
    width: 980, height: 620, minWidth: 560, minHeight: 320,
    title: 'Kz Harness · Log', icon: ICON, backgroundColor: BG, show: false, autoHideMenuBar: true,
    webPreferences: { ...secure, preload: path.join(__dirname, 'preload.js') },
  })
  logWin.once('ready-to-show', () => logWin.show())
  lockNavigation(logWin)
  logWin.on('closed', () => { logWin = null })
  logWin.loadFile(path.join(__dirname, 'ui', 'console.html'), { hash: 'logs' })
}

/** The app only ever shows its own pages and the local harness; anything else opens in the normal browser. */
function lockNavigation(win) {
  const allowed = (url) => url.startsWith('file://') || (status.origin && url.startsWith(status.origin))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !allowed(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (allowed(url)) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
}

// ---------- menu + tray ----------
function buildMenus() {
  const items = [
    { label: 'Show Kz Harness', click: () => { main?.show(); main?.focus() } },
    { label: 'Show log', accelerator: 'CmdOrCtrl+Shift+L', click: openLogs },
    { type: 'separator' },
    { label: 'Restart harness', click: restartDsh },
    { label: 'Check for updates…', click: checkForUpdates },
    { label: 'Open project folders', click: () => shell.openPath('C:\\HarnessProjects') },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Harness', submenu: items.slice(1) },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]))
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo-32.png')))
  tray.setToolTip('Kz Harness')
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.on('click', () => { main?.show(); main?.focus() })
}

// ---------- renderer API ----------
ipcMain.handle('harness:state', () => ({ status, logs }))
ipcMain.handle('harness:retry', () => restartDsh())
ipcMain.handle('harness:openLogs', () => openLogs())

app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.focus() } })
app.whenReady().then(() => {
  buildMenus()
  createMain()
  startDsh()
})
app.on('before-quit', () => { quitting = true; stopDsh() })
app.on('window-all-closed', () => app.quit())

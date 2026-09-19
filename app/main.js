// Kz-harness desktop app. Starts DSH through C:\Harness\Start-KzH.ps1 (one
// place for the version pin and key checks), shows a start screen with the
// log while it boots, then opens the harness in this window. The log lives in
// its own window (Ctrl+Shift+L, tray, or the Harness menu). Quitting the app
// stops DSH and everything it started.
const { app, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, session, shell, nativeImage } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// No remote control: a debug port or inspector would let any program on this PC drive the app.
// Developers opt in with KZH_DEBUG=1. (DevTools on F12 stays: that needs someone at the keyboard.)
const DEBUG = process.env.KZH_DEBUG === '1'
const debugSwitch = process.argv.some((a) => /^--(inspect|remote-debugging-(port|pipe)|js-flags)/.test(a)) ||
  /--inspect/.test(process.env.NODE_OPTIONS ?? '') || !!process.env.ELECTRON_RUN_AS_NODE
if (debugSwitch && !DEBUG) {
  dialog.showErrorBox('Kz-harness', 'Kz-harness was started with a debugging switch, which would let other programs control it. Start it from the Kz-harness icon instead.')
  app.exit(1)
}

// The harness folder: next to the app in development; the packaged exe lives in app\dist\...,
// so walk up from it until Start-KzH.ps1 is found.
const HARNESS = (() => {
  for (let d = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'); ; d = path.dirname(d)) {
    if (require('node:fs').existsSync(path.join(d, 'Start-KzH.ps1'))) return d
    if (path.dirname(d) === d) return path.resolve(__dirname, '..')
  }
})()
const START_SCRIPT = path.join(HARNESS, 'Start-KzH.ps1')
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
// The login token and anything key-shaped never show on screen or get copied around.
const REDACT = [[/(token=)[\w-]+/g, '$1•••'], [/(Bearer\s+)\S+/gi, '$1•••'], [/\b(sk-|tsk_)[\w-]{8,}/g, '$1•••']]
const redact = (t) => REDACT.reduce((acc, [re, to]) => acc.replace(re, to), t)
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
  const entry = { t: Date.now(), level: level ?? levelOf(text), text: redact(text) }
  logs.push(entry)
  if (logs.length > 5000) logs.shift()
  for (const w of [main, logWin]) w?.webContents.send('harness:log', entry)
}
function setStatus(next) {
  status = next
  for (const w of [main, logWin]) w?.webContents.send('harness:status', status)
  tray?.setToolTip(`Kz-harness: ${status.message}`)
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
    setStatus({ phase: 'error', message: `Another harness is already running on port ${PORT}. Close its black window (or the other Kz-harness), then click Retry.` })
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
      addLog(m ? 'KzH ready on this PC only (127.0.0.1)' : line, m ? 'ok' : undefined)
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

/** Kz-harness -> Check for updates: runs scripts/Update-Harness.ps1 into the log, then restarts the harness. */
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
    title: 'Kz-harness', icon: ICON, backgroundColor: BG, show: false,
    webPreferences: { ...secure, preload: path.join(__dirname, 'preload.js') },
  })
  main.once('ready-to-show', () => main.show())
  // The harness page sets its own title; keep the app name on the window.
  // The engine's page calls itself "DeepSeek Harness"; the app is KzH (Kz-harness).
  main.on('page-title-updated', (e, title) => { e.preventDefault(); const t = (title ?? '').replace(/\s*[—-]?\s*DeepSeek Harness\s*/g, '').trim(); main.setTitle(status.phase === 'ready' && t ? `${t} · Kz-harness` : 'Kz-harness') })
  lockNavigation(main)
  // The in-app browser view sits over the page; it follows the window and never outlives the harness page.
  main.on('minimize', () => browserView?.setVisible(false))
  main.on('restore', () => browserView?.setVisible(browserWanted))
  main.webContents.on('did-navigate', () => hideBrowser())
  main.on('closed', () => { main = null; app.quit() })
  showStartScreen()
}

function openLogs() {
  if (logWin) { logWin.show(); logWin.focus(); return }
  logWin = new BrowserWindow({
    width: 980, height: 620, minWidth: 560, minHeight: 320,
    title: 'Kz-harness · Log', icon: ICON, backgroundColor: BG, show: false, autoHideMenuBar: true,
    webPreferences: { ...secure, preload: path.join(__dirname, 'preload.js') },
  })
  logWin.once('ready-to-show', () => logWin.show())
  lockNavigation(logWin)
  logWin.on('closed', () => { logWin = null })
  logWin.loadFile(path.join(__dirname, 'ui', 'console.html'), { hash: 'logs' })
}

/** The app only ever shows its own pages and the local harness; anything else opens in the normal browser. */
const UI = pathToFileURL(path.join(__dirname, 'ui') + path.sep).href
const fromAppPage = (e) => (e.senderFrame?.url ?? '').startsWith(UI)
const allowed = (url) => {
  try {
    const u = new URL(url)
    return url.startsWith(UI) || (!!status.origin && u.origin === status.origin && !u.searchParams.has('fixture'))
  } catch { return false }
}
function lockNavigation(win) {
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

// ---------- in-app browser (the Browser tab in the harness's right sidebar) ----------
// One shared view for every Browser tab: whichever tab last reported its placeholder owns it.
// Own session partition, sandboxed, no preload, no permissions beyond writing the clipboard.
let browserView = null
let browserWanted = false
let favicon
const isHttp = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol) } catch { return false } }
function hideBrowser() { browserWanted = false; browserView?.setVisible(false) }
function browserState() {
  const wc = browserView.webContents
  return { url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading(), favicon }
}
function getBrowser() {
  if (browserView) return browserView
  const ses = session.fromPartition('persist:kz-browser')
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
  browserView = new WebContentsView({ webPreferences: { ...secure, session: ses } })
  const wc = browserView.webContents
  const push = () => main?.webContents.send('harness:browser-state', browserState())
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, push)
  wc.on('page-favicon-updated', (_e, icons) => { favicon = icons[0]; push() })
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) favicon = undefined })
  // Pop-ups open in this same view; only mailto: leaves for the system. Other schemes (file:, app links) are refused.
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) wc.loadURL(url).catch(() => {})
    else if (url.startsWith('mailto:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => { if (!isHttp(url)) e.preventDefault() })
  browserView.setVisible(false)
  main.contentView.addChildView(browserView)
  return browserView
}
ipcMain.handle('harness:browser', (e, op, arg) => {
  if (!main || e.sender !== main.webContents) return null // only the harness page drives it
  if (op === 'hide') return hideBrowser()
  const view = getBrowser()
  const wc = view.webContents
  if (op === 'show') {
    const r = arg ?? {}
    const z = main.webContents.getZoomFactor() // the page reports CSS px; the view is placed in window DIPs
    const [x, y, width, height] = [r.x, r.y, r.width, r.height].map((n) => Math.round((Number(n) || 0) * z))
    if (width < 2 || height < 2) return hideBrowser()
    view.setBounds({ x, y, width, height })
    browserWanted = true
    if (!main.isMinimized()) view.setVisible(true)
    if (r.url && isHttp(r.url) && wc.getURL() !== r.url) wc.loadURL(r.url).catch(() => {})
  } else if (op === 'navigate') {
    if (!isHttp(arg)) throw new Error('only http(s) addresses')
    wc.loadURL(arg).catch(() => {})
  } else if (op === 'back') wc.navigationHistory.goBack()
  else if (op === 'forward') wc.navigationHistory.goForward()
  else if (op === 'reload') wc.reload()
  else if (op === 'stop') wc.stop()
  else if (op === 'openExternal') { const u = wc.getURL(); if (isHttp(u)) shell.openExternal(u) }
  return browserState()
})

// ---------- menu + tray ----------
function buildMenus() {
  const items = [
    { label: 'Show Kz-harness', click: () => { main?.show(); main?.focus() } },
    { label: 'Show log', accelerator: 'CmdOrCtrl+Shift+L', click: openLogs },
    { type: 'separator' },
    { label: 'Restart harness', click: restartDsh },
    { label: 'Check for updates…', click: checkForUpdates },
    { label: 'Open project folders', click: () => shell.openPath('C:\\HarnessProjects') },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Kz-harness', submenu: items.slice(1) },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools', accelerator: 'F12' }, { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I', visible: false }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]))
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo-32.png')))
  tray.setToolTip('Kz-harness')
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.on('click', () => { main?.show(); main?.focus() })
}

// ---------- renderer API ----------
// Only the app's own start and log pages may read the log or restart the harness, not the harness page.
ipcMain.handle('harness:state', (e) => (fromAppPage(e) ? { status, logs } : null))
ipcMain.handle('harness:retry', (e) => { if (fromAppPage(e)) restartDsh() })
ipcMain.handle('harness:openLogs', (e) => { if (fromAppPage(e)) openLogs() })

app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.focus() } })
app.on('web-contents-created', (_e, wc) => wc.on('will-attach-webview', (ev) => ev.preventDefault()))
app.whenReady().then(() => {
  // The harness page gets no camera, microphone, location or notifications; only clipboard writes.
  const ok = (p) => p === 'clipboard-sanitized-write'
  session.defaultSession.setPermissionRequestHandler((_wc, p, done) => done(ok(p)))
  session.defaultSession.setPermissionCheckHandler((_wc, p) => ok(p))
  buildMenus()
  createMain()
  startDsh()
})
app.on('before-quit', () => { quitting = true; stopDsh(); browserView?.webContents.close(); browserView = null })
app.on('window-all-closed', () => app.quit())

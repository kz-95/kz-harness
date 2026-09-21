// Kz-harness desktop app. Starts DSH through C:\Harness\Start-KzH.ps1 (one
// place for the version pin and key checks), shows a start screen with the
// log while it boots, then opens the harness in this window. The log lives in
// its own window (Ctrl+Shift+L, tray, or the Harness menu). Quitting the app
// stops DSH and everything it started.
const { app, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, session, shell, nativeImage } = require('electron')
const { spawn, execFile, execFileSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// No remote control: a debug port or inspector would let any program on this PC drive the app.
// Developers opt in with KZH_DEBUG=1. (DevTools on F12 stays: that needs someone at the keyboard.)
const DEBUG = process.env.KZH_DEBUG === '1'
// ELECTRON_RUN_AS_NODE counts only in development. The packaged exe has the RunAsNode fuse off
// (package.mjs), so the variable cannot turn it into Node there, and editors such as VS Code
// export it for every child process, which made the packaged app refuse to start from a terminal.
const runAsNode = !!process.env.ELECTRON_RUN_AS_NODE && !app.isPackaged
const debugSwitch = process.argv.some((a) => /^--(inspect|remote-debugging-(port|pipe)|js-flags)/.test(a)) ||
  /--inspect/.test(process.env.NODE_OPTIONS ?? '') || runAsNode
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
const TITLEBAR_H = 36

app.setAppUserModelId('ai.kz.harness')
if (!app.requestSingleInstanceLock()) app.quit()

let main = null
let logWin = null
let tray = null
let dsh = null
let quitting = false
const logs = [] // { t, level, text }
// Startup is about 40 seconds and most of it is the engine loading its plugin bundle,
// which we cannot shorten. So say what is happening instead of one unchanging line.
// Derived from the launcher's own output rather than guessed on a timer.
const STEPS = [
  { id: 'update', label: 'Checking for updates' },
  { id: 'port', label: 'Checking the port is free' },
  { id: 'prepare', label: 'Preparing the engine' },
  { id: 'fetch', label: 'Fetching the engine (first run only)' },
  { id: 'engine', label: 'Starting the engine' },
  { id: 'ready', label: 'Ready' },
]
/** Which step a line of launcher output means, or null when it says nothing about progress. */
function stepFor(line) {
  if (/dsh web:/.test(line)) return 'ready'
  if (/Fetching the engine/i.test(line)) return 'fetch'
  if (/^patch-|^ensure-no-project|: applied$/.test(line)) return 'prepare'
  return null
}
// Which steps this run actually reached. A repeat run never fetches the engine, and the
// splash must not tick a step that never ran. Kept here, not in the window, because the
// window can open after the first steps are already done.
const seenSteps = new Set(['update'])
let status = { phase: 'starting', message: 'Starting the harness…', step: 'update', steps: STEPS }

// ---------- log + status fan-out ----------
// The login token and anything key-shaped never show on screen or get copied around.
const REDACT = [[/(token=)[\w-]+/g, '$1•••'], [/(Bearer\s+)\S+/gi, '$1•••'], [/\b(sk-|tsk_)[\w-]{8,}/g, '$1•••']]
const redact = (t) => REDACT.reduce((acc, [re, to]) => acc.replace(re, to), t)
// The engine prints under its own name ("dsh: failed to load .env: ..."), and a file the
// branding patch does not reach can still say "DeepSeek Harness". Nobody installed either
// of those, so the log says KzH. Display only: levelOf and stepFor still read the raw line.
const unbrand = (t) => t.replace(/^dsh(?=[: ])/, 'KzH').replace(/DeepSeek Harness/g, 'Kz-harness')
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
  const entry = { t: Date.now(), level: level ?? levelOf(text), text: unbrand(redact(text)) }
  logs.push(entry)
  if (logs.length > 5000) logs.shift()
  for (const w of [main, logWin]) w?.webContents.send('harness:log', entry)
}
function setStatus(next) {
  if (next.step) seenSteps.add(next.step)
  status = { steps: STEPS, done: [...seenSteps], ...next }
  for (const w of [main, logWin]) w?.webContents.send('harness:status', status)
  tray?.setToolTip(`Kz-harness: ${status.message}`)
}

// ---------- DSH process ----------
const portBusy = () => new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})

// ---------- who holds the port ----------
// Stopping another program is the most dangerous thing this app can do, so the test is narrow:
// the holder counts as ours only when its own command line is the pinned engine invocation AND
// no live Kz-harness.exe sits above it. Never by port number alone.
/** Run one command and return its stdout, or null on any failure. */
const runCmd = (file, args, timeout = 10000) => new Promise((resolve) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)))
})

/**
 * Whether a command line is the engine Start-KzH.ps1 launches: node, the pinned @deepseek-ai/dsh
 * package, and `web` as its own argument. To look like this by accident a stranger would have to
 * run node on that exact package path with a bare `web` argument, and the live Kz-harness check
 * below still has to pass before anything is stopped.
 */
const isEngineCommand = (cmd) => {
  const line = String(cmd ?? '')
  return /\bnode(\.exe)?\b/i.test(line) && /@deepseek-ai[\\/]dsh\b/i.test(line) && /(?:^|\s)web(?:\s|$)/i.test(line)
}

/** The PID listening on PORT, or null. netstat is on every Windows and needs no PowerShell module. */
async function portOwnerPid() {
  const out = await runCmd('netstat', ['-ano'])
  if (!out) return null
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5 || f[0].toUpperCase() !== 'TCP' || f[3].toUpperCase() !== 'LISTENING') continue
    if (!f[1].endsWith(`:${PORT}`)) continue
    const pid = Number(f[4])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

/** One live process row from CIM, or null when the process has already gone. */
async function processRow(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress }`
  const out = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (!out || !out.trim()) return null
  try {
    const r = JSON.parse(out)
    return { pid: Number(r.ProcessId), parent: Number(r.ParentProcessId), name: String(r.Name ?? ''), cmd: String(r.CommandLine ?? '') }
  } catch { return null }
}

/**
 * Classify whoever holds PORT. `orphan` is our engine with no live Kz-harness.exe above it, safe
 * to stop; `running` is our engine still under a live Kz-harness.exe, which is the other harness
 * this app already tells you to close, so it is left alone; `foreign` is anything else, left alone.
 */
async function inspectPortHolder() {
  const pid = await portOwnerPid()
  if (!pid) return null
  const chain = []
  let cur = pid
  for (let i = 0; i < 8 && cur > 0; i++) {
    const row = await processRow(cur)
    if (!row) break
    chain.push(row)
    if (row.parent === cur) break
    cur = row.parent
  }
  const top = chain[0]
  if (!top) return null
  if (!isEngineCommand(top.cmd)) return { pid, kind: 'foreign', name: top.name }
  // Only a live process reaches this chain, so an ancestor named Kz-harness.exe is still open.
  const underApp = chain.some((r) => /^kz-harness(\.exe)?$/i.test(r.name))
  return { pid, kind: underApp ? 'running' : 'orphan', name: top.name }
}

/** Run one git command in the harness folder. Never throws: returns the exit code and output. */
const git = (args, timeout = 20000) => new Promise((resolve) => {
  execFile('git', ['-C', HARNESS, ...args], { timeout, windowsHide: true }, (err, out, errOut) =>
    resolve({ code: err ? (err.code ?? 1) : 0, out: String(out).trim(), err: String(errOut).trim() }))
})

/**
 * Bring the harness up to date before starting it, but only by a move that cannot leave it
 * half updated: a fast-forward of a clean tree. git moves the branch ref or it does not, so
 * there is no in-between state to be interrupted in.
 *
 * Anything that would need a second step to be usable is refused, not half done:
 *  - changed dependencies, which need npm install
 *  - changes to app\, which need the exe rebuilt
 * Those print what to run and start the version already on disk. Startup is never blocked by
 * this: no network, no remote, a dirty tree or a stall all just carry on.
 */
let updateChecked = false
async function safeUpdate() {
  setStatus({ phase: 'starting', message: 'Checking for updates…', step: 'update' })
  if (updateChecked) return // Retry after a failed start should not wait on the network again.
  updateChecked = true
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'], 5000)
  if (upstream.code || !upstream.out) { addLog('Updates: no remote is set for this branch; skipped.'); return }
  // An errored status prints nothing, which must not read as "clean".
  const dirty = await git(['status', '--porcelain'], 5000)
  if (dirty.code || dirty.out) { addLog('Updates: you have uncommitted changes here, so nothing was pulled.', 'warn'); return }

  const fetched = await git(['fetch', '--quiet'], 15000)
  if (fetched.code) { addLog('Updates: could not reach the remote; starting the version you have.', 'warn'); return }

  const behind = await git(['rev-list', '--count', 'HEAD..@{u}'], 5000)
  const count = Number(behind.out)
  if (!count) { addLog(`Updates: up to date (${upstream.out}).`); return }
  // A fast-forward only. Diverged branches need a human.
  if ((await git(['merge-base', '--is-ancestor', 'HEAD', '@{u}'], 5000)).code) {
    addLog(`Updates: ${upstream.out} has moved apart from your branch; resolve it in a terminal.`, 'warn')
    return
  }
  const touched = await git(['diff', '--name-only', 'HEAD', '@{u}'], 5000)
  const files = touched.out.split(/\r?\n/).filter(Boolean)
  const needsInstall = files.some((f) => /(^|\/)package(-lock)?\.json$/.test(f))
  const needsRebuild = files.some((f) => f.startsWith('app/'))
  if (needsInstall || needsRebuild) {
    const what = [needsInstall && 'new packages', needsRebuild && 'a rebuilt Kz-harness.exe'].filter(Boolean).join(' and ')
    addLog(`Updates: ${count} new commit(s) need ${what}, which this launcher will not do behind your back. Close Kz-harness and run scripts\\Install-Harness.ps1.`, 'warn')
    return
  }
  const pulled = await git(['pull', '--ff-only', '--quiet'], 20000)
  if (pulled.code) { addLog(`Updates: the pull failed (${pulled.err || pulled.code}); starting the version you have.`, 'warn'); return }
  addLog(`Updates: pulled ${count} new commit(s).`, 'ok')
}

async function startDsh() {
  if (dsh) return
  await safeUpdate()
  setStatus({ phase: 'starting', message: 'Checking the port is free…', step: 'port' })
  if (await portBusy()) {
    addLog(`Port ${PORT} is already in use.`, 'error')
    const holder = await inspectPortHolder()
    if (holder?.kind === 'orphan') {
      addLog(`The engine on port ${PORT} (PID ${holder.pid}) has no running Kz-harness app above it, so it is orphaned. "Use it here" stops it and starts this app's engine.`, 'warn')
      addLog('Adopting that engine is not possible: its access token is generated per process and never written to disk, so this app cannot authenticate to it. It has to be stopped and started here.', 'info')
      setStatus({ phase: 'error', holder: 'orphan', message: `A Kz-harness engine is still running on port ${PORT}, left behind by an app that is no longer open. Click "Use it here" to stop it and start here.` })
    } else if (holder?.kind === 'running') {
      addLog(`Port ${PORT} is held by a Kz-harness engine (PID ${holder.pid}) that still belongs to a running Kz-harness.`, 'warn')
      setStatus({ phase: 'error', holder: 'running', message: `Another harness is already running on port ${PORT}. Close its black window (or the other Kz-harness), then click Retry.` })
    } else {
      const who = holder ? `${holder.name || 'a process'} (PID ${holder.pid})` : 'an unrelated program'
      addLog(`Port ${PORT} is held by ${who}, which is not this harness. Nothing was stopped.`, 'warn')
      setStatus({ phase: 'error', holder: 'foreign', message: `Another program is already using port ${PORT}. It is not this harness (${who}), so nothing was stopped. Close it, then click Retry.` })
    }
    return
  }
  addLog(`> ${START_SCRIPT} -NoOpen`, 'cmd')
  setStatus({ phase: 'starting', message: 'Preparing the engine…', step: 'prepare' })
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
      if (m) { openHarness(m[1]); continue }
      // The launcher's own output is the only honest progress signal we have.
      const step = stepFor(line)
      if (step && step !== status.step) {
        setStatus({ phase: 'starting', message: `${STEPS.find((x) => x.id === step)?.label ?? step}…`, step })
      }
    }
  }
  dsh = child
  // The engine prints nothing between starting and serving, which is most of the wait.
  // Move to that step shortly after spawn so the splash is never silently stuck on "Preparing".
  setTimeout(() => {
    if (dsh === child && status.phase === 'starting' && status.step !== 'fetch' && status.step !== 'ready') {
      setStatus({ phase: 'starting', message: 'Starting the engine, this takes about half a minute…', step: 'engine' })
    }
  }, 2500)
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

/**
 * "Use it here": stop the orphaned engine that holds PORT, then start this app's own engine.
 * The holder is inspected again here, not trusted from the error state, so a port that changed
 * hands between the splash and the click is never killed. A foreign holder is never stopped.
 */
let reclaiming = false
async function useHere() {
  if (reclaiming) return { ok: false, reason: 'busy' }
  if (status.phase !== 'error') return { ok: false, reason: 'not-error' }
  reclaiming = true
  try {
    const holder = await inspectPortHolder()
    if (holder?.kind !== 'orphan') {
      addLog(`Use it here: port ${PORT} is not held by an orphaned engine any more; nothing was stopped.`, 'warn')
      setStatus({ phase: 'error', holder: holder?.kind ?? 'foreign', message: holder?.kind === 'running'
        ? `Another harness is already running on port ${PORT}. Close its black window (or the other Kz-harness), then click Retry.`
        : `Port ${PORT} is no longer held by an orphaned engine. Open the log, then click Retry.` })
      return { ok: false, reason: holder?.kind ?? 'gone' }
    }
    addLog(`Use it here: stopping the orphaned engine (PID ${holder.pid}) and everything it started.`, 'cmd')
    try { execFileSync('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch (err) { addLog(`Use it here: taskkill reported ${err.message ?? err}; checking the port anyway.`, 'warn') }
    // A dead process can leave the socket in LISTEN for a moment, so wait before giving up.
    let busy = await portBusy()
    for (let i = 0; busy && i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); busy = await portBusy() }
    if (busy) {
      addLog(`Use it here: port ${PORT} is still busy after stopping PID ${holder.pid}; not starting a second engine.`, 'error')
      setStatus({ phase: 'error', holder: 'foreign', message: `Port ${PORT} is still busy after stopping the orphaned engine. Something else took the port; open the log, then click Retry.` })
      return { ok: false, reason: 'still-busy' }
    }
    addLog(`Use it here: port ${PORT} is free; starting this app's engine.`, 'ok')
    startDsh()
    return { ok: true }
  } finally {
    reclaiming = false
  }
}

// ---------- windows ----------
const secure = { contextIsolation: true, nodeIntegration: false, sandbox: true }

/** Bring the window back, rebuilding it if it was closed: the tray must never be a dead end. */
function showWindow() {
  if (!main || main.isDestroyed()) { createMain(); return }
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

function showStartScreen() {
  main?.loadFile(path.join(__dirname, 'ui', 'console.html'), { hash: 'start' })
}

function openHarness(url) {
  setStatus({ phase: 'ready', message: 'Harness running', step: 'ready', origin: new URL(url).origin })
  main?.loadURL(url)
}

function createMain() {
  main = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600,
    title: 'Kz-harness', icon: ICON, backgroundColor: BG, show: false,
    // Our own title bar (drawn by the pages, 36 px tall); Windows keeps its native min/max/close on the right.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#cfd3d6', height: TITLEBAR_H },
    webPreferences: { ...secure, preload: path.join(__dirname, 'preload.js') },
  })
  // Show as soon as the frame exists. The window used to appear only on ready-to-show,
  // so a page that failed to load left a tray icon and nothing else, with no error.
  // backgroundColor is already the app's own, so there is no white flash to avoid.
  const reveal = () => { if (main && !main.isDestroyed() && !main.isVisible()) { main.show(); main.focus() } }
  main.once('ready-to-show', reveal)
  reveal()
  // Whatever the page does, the window is on screen within a second.
  setTimeout(reveal, 1000)
  main.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    addLog(`The start screen failed to load (${code} ${desc}) ${url}`, 'error')
    setStatus({ phase: 'error', message: `The launcher page could not load (${desc || code}). Open the log, then click Retry.` })
    reveal()
  })
  main.webContents.on('render-process-gone', (_e, d) => {
    addLog(`The window's renderer stopped (${d?.reason ?? 'unknown'}).`, 'error')
    setStatus({ phase: 'error', message: 'The launcher page stopped. Click Retry.' })
    reveal()
  })
  // The harness page sets its own title; keep the app name on the window.
  // The engine's page title carries the engine's own name; strip it, the app is KzH (Kz-harness).
  main.on('page-title-updated', (e, title) => { e.preventDefault(); const t = (title ?? '').replace(/\s*[-\u2013\u2014]?\s*(?:DeepSeek Harness|Kz-harness)\s*/g, '').trim(); main.setTitle(status.phase === 'ready' && t ? `${t} · Kz-harness` : 'Kz-harness') })
  lockNavigation(main)
  // The in-app browser view sits over the page; it follows the window and never outlives the harness page.
  main.on('minimize', () => browserView?.setVisible(false))
  main.on('restore', () => browserView?.setVisible(browserWanted))
  main.webContents.on('did-navigate', () => hideBrowser())
  // Closing the window leaves the harness running in the tray; quit from the tray menu
  // or the app menu. Quitting here made the tray icon a dead end.
  main.on('closed', () => { main = null })
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
let appMenu = null
function buildMenus() {
  const items = [
    { label: 'Show Kz-harness', click: () => showWindow() },
    { label: 'Show log', accelerator: 'CmdOrCtrl+Shift+L', click: openLogs },
    { type: 'separator' },
    { label: 'Restart harness', click: restartDsh },
    { label: 'Check for updates…', click: checkForUpdates },
    { label: 'Open project folders', click: () => shell.openPath('C:\\HarnessProjects') },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ]
  // The window has no menu bar row any more; the ☰ button in the title bar pops this menu up,
  // and its accelerators (Ctrl+Shift+L, F12, Ctrl+Q …) keep working.
  appMenu = Menu.buildFromTemplate([
    { label: 'Kz-harness', submenu: items.slice(1) },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools', accelerator: 'F12' }, { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I', visible: false }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ])
  Menu.setApplicationMenu(appMenu)
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo-32.png')))
  tray.setToolTip('Kz-harness')
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.on('click', () => showWindow())
}

// ---------- renderer API ----------
// Title-bar ☰ button: pops up the app menu under it (the harness page and the start page both have it).
ipcMain.handle('harness:menu', (e, at) => {
  if (!main || (e.sender !== main.webContents && !fromAppPage(e))) return
  appMenu?.popup({ window: main, x: Math.round(Number(at?.x) || 8), y: Math.round(Number(at?.y) || TITLEBAR_H) })
})
ipcMain.handle('harness:titlebar', () => ({ height: TITLEBAR_H, maximized: !!main?.isMaximized() }))
// Only the app's own start and log pages may read the log or restart the harness, not the harness page.
ipcMain.handle('harness:state', (e) => (fromAppPage(e) ? { status, logs } : null))
ipcMain.handle('harness:retry', (e) => { if (fromAppPage(e)) restartDsh() })
ipcMain.handle('harness:useHere', (e) => (fromAppPage(e) ? useHere() : null))
ipcMain.handle('harness:openLogs', (e) => { if (fromAppPage(e)) openLogs() })

// Double-clicking the exe again brings the window back rather than doing nothing.
app.on('second-instance', () => showWindow())
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
// Not quitting on window-all-closed: the tray keeps the harness alive until you quit it.

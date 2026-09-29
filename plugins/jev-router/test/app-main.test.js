// app/main.js, the Kz-harness desktop app, driven with a fake Electron, a fake launcher process and
// no network: the window, the tray, the start screen's status and the in-app browser view, as the
// person meets them. Electron is not installed here, so what Electron itself does (quit when the
// last window closes unless the app listens for it) is modelled in allClosed() below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const MAIN = fileURLToPath(new URL('../../../app/main.js', import.meta.url))
const CONSOLE = fileURLToPath(new URL('../../../app/ui/console.js', import.meta.url))
const LAUNCHER = readFileSync(fileURLToPath(new URL('../../../Start-KzH.ps1', import.meta.url)), 'utf8')
const START = pathToFileURL(join(MAIN, '..', 'ui', 'console.html')).href
const HARNESS = 'http://127.0.0.1:3080/?token=abc'
const require = createRequire(import.meta.url)
// The line Start-KzH.ps1 prints right before it boots the engine, read from the launcher itself.
const ENGINE_LINE = LAUNCHER.match(/^Write-Host '(Starting the engine[^']*)'\r?$/m)?.[1]

class FakeContents extends EventEmitter {
  constructor() {
    super()
    this.url = ''
    this.loads = []
    this.destroyed = false
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} }
  }
  load(url) { this.url = url; this.loads.push(url); return Promise.resolve() }
  loadURL(url) { return this.load(url) }
  getURL() { return this.url }
  getTitle() { return '' }
  isLoading() { return false }
  getZoomFactor() { return 1 }
  isDestroyed() { return this.destroyed }
  close() { this.destroyed = true }
  send() {}
  setWindowOpenHandler() {}
  reload() {}
  stop() {}
}

/**
 * One start of the app: main.js loaded afresh against its own fakes. `userData` is Electron's
 * per-user folder, shared by starts that pass the same one. `git` answers the update check.
 */
async function startApp(t, { userData, git = () => ({ code: 1 }) } = {}) {
  const home = userData ?? mkdtempSync(join(tmpdir(), 'kzh-app-'))
  if (!userData) t.after(() => rmSync(home, { recursive: true, force: true }))
  const w = { windows: [], views: [], children: [], killed: [], balloons: [], handlers: {}, on: {}, quits: 0, tray: null }
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super()
      this.opts = opts
      this.webContents = new FakeContents()
      this.visible = false
      this.destroyed = false
      this.views = []
      this.contentView = { addChildView: (v) => this.views.push(v) }
      w.windows.push(this)
    }
    loadURL(url) { return this.webContents.load(url) }
    loadFile(file, o) { return this.webContents.load(pathToFileURL(file).href + (o?.hash ? `#${o.hash}` : '')) }
    show() { this.visible = true }
    focus() {}
    isVisible() { return this.visible }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isMaximized() { return false }
    restore() {}
    setTitle() {}
    close() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed') }
  }
  class WebContentsView {
    constructor() { this.webContents = new FakeContents(); this.visible = false; w.views.push(this) }
    setVisible(v) { this.visible = v }
    setBounds() {}
  }
  class Tray {
    constructor() { this.on_ = {}; w.tray = this }
    setToolTip(t) { this.tip = t }
    setContextMenu(m) { this.menu = m }
    on(ev, fn) { this.on_[ev] = fn }
    displayBalloon(o) { w.balloons.push(o) }
  }
  const noSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
  const app = {
    isPackaged: false,
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    quit() { w.quits++; for (const fn of w.on['before-quit'] ?? []) fn(); for (const win of w.windows) if (!win.destroyed) win.close() },
    exit() {},
    on(ev, fn) { (w.on[ev] ??= []).push(fn) },
    whenReady: () => Promise.resolve(),
    getPath: () => home,
  }
  const electron = {
    app, BrowserWindow, WebContentsView, Tray,
    Menu: { buildFromTemplate: (template) => ({ template, popup() {} }), setApplicationMenu() {} },
    dialog: { showErrorBox() {} },
    ipcMain: { handle: (ch, fn) => { w.handlers[ch] = fn } },
    session: { fromPartition: () => noSession, defaultSession: noSession },
    shell: { openExternal() {}, openPath() {} },
    nativeImage: { createFromPath: () => ({}) },
  }
  const childProcess = {
    spawn() {
      const child = new EventEmitter()
      child.pid = 1000 + w.children.length
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.say = (...lines) => { for (const l of lines) child.stdout.emit('data', Buffer.from(`${l}\r\n`)) }
      w.children.push(child)
      return child
    },
    execFile(file, args, _opts, cb) {
      const r = file === 'git' ? git(args.slice(2)) : { code: 1 }
      setImmediate(() => cb(r.code ? Object.assign(new Error('no'), { code: r.code }) : null, r.out ?? '', ''))
    },
    execFileSync(file, args) { if (file === 'taskkill') w.killed.push(args[1]) },
  }
  const net = { connect() { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('error', new Error('refused'))); return s } }
  const load = Module._load
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron
    if (request === 'node:child_process' || request === 'child_process') return childProcess
    if (request === 'node:net' || request === 'net') return net
    return load.call(this, request, ...rest)
  }
  try {
    delete require.cache[MAIN]
    require(MAIN)
  } finally {
    Module._load = load
  }
  const page = { senderFrame: { url: `${START}#start` } }
  Object.assign(w, {
    main: () => w.windows.filter((x) => !x.destroyed && x.opts.title === 'Kz-harness').at(-1),
    state: () => w.handlers['harness:state'](page),
    retry: () => w.handlers['harness:retry'](page),
    browser: (win, op, arg) => w.handlers['harness:browser']({ sender: win.webContents }, op, arg),
    // What Electron does once no window is left: quit, unless the app listens for it itself.
    allClosed() { const own = w.on['window-all-closed'] ?? []; if (!own.length) app.quit(); else for (const fn of own) fn() },
    trayShow: () => w.tray.on_.click(),
    trayQuit: () => w.tray.menu.template.find((i) => i.label === 'Quit').click(),
  })
  await until(() => w.children.length === 1, 'the launcher was started')
  return w
}

/**
 * The start screen: app/ui/console.js run against a small fake DOM, fed the statuses main.js sends.
 * Returns the elements the person reads, by id.
 */
function startScreen(w) {
  class El {
    constructor() {
      this.hidden = false
      this.textContent = ''
      this.className = ''
      this.children = []
      this.dataset = {}
      const set = new Set()
      this.classList = { add: (c) => set.add(c), contains: (c) => set.has(c), toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c) } }
    }
    get firstChild() { return this.children[0] ?? null }
    get lastChild() { return this.children.at(-1) ?? null }
    append(...xs) { this.children.push(...xs.filter((x) => typeof x === 'object')) }
    replaceChildren(...xs) { this.children = xs }
    remove() {}
    addEventListener() {}
    setAttribute() {}
    scrollIntoView() {}
    querySelector() { return null }
    getBoundingClientRect() { return { left: 0, bottom: 0 } }
  }
  const byId = {}
  const document = {
    body: new El(),
    getElementById: (id) => (byId[id] ??= new El()),
    createElement: () => new El(),
    querySelector: () => new El(),
    querySelectorAll: () => [],
  }
  const listeners = {}
  const harness = {
    state: async () => w.state(),
    onLog: (cb) => { listeners.log = cb },
    onStatus: (cb) => { listeners.status = cb },
  }
  vm.runInNewContext(readFileSync(CONSOLE, 'utf8'), { document, window: { harness }, location: { hash: '#start' }, Intl, navigator: {}, setTimeout })
  return { byId, show: () => listeners.status(w.state().status) }
}

async function until(ok, what) {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(ok(), `waited for: ${what}`)
}

const ready = (w) => w.children.at(-1).say(`dsh web: ${HARNESS}`)
const closeWindow = (w) => { w.main().close(); if (w.windows.every((x) => x.destroyed)) w.allClosed() }

test('closing the window leaves the harness running in the tray, and Show from the tray opens the harness page again', async (t) => {
  const w = await startApp(t)
  ready(w)
  assert.equal(w.main().webContents.url, HARNESS)
  closeWindow(w)
  assert.equal(w.quits, 0, 'closing the window must not quit the app')
  assert.deepEqual(w.killed, [], 'nor stop the engine')
  w.trayShow()
  assert.equal(w.windows.length, 2)
  assert.equal(w.main().webContents.url, HARNESS, 'the rebuilt window opens the running harness, not the start screen')
  assert.equal(w.state().status.phase, 'ready')
})

test('the first close says once, for good, that Kz-harness still runs in the tray; a quit says nothing', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kzh-app-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const first = await startApp(t, { userData: home })
  ready(first)
  closeWindow(first)
  assert.equal(first.balloons.length, 1)
  assert.equal(first.balloons[0].title, 'Kz-harness is still running')
  assert.match(first.balloons[0].content, /right-click this icon and choose Quit/)
  first.trayShow()
  closeWindow(first)
  assert.equal(first.balloons.length, 1, 'said once')
  const again = await startApp(t, { userData: home })
  ready(again)
  closeWindow(again)
  assert.equal(again.balloons.length, 0, 'not again on the next start either')

  const quitting = await startApp(t)
  ready(quitting)
  quitting.trayQuit()
  assert.equal(quitting.balloons.length, 0, 'quitting closes the window too, and that is no news')
  assert.deepEqual(quitting.killed, [String(quitting.children[0].pid)], 'quitting stops the engine')
})

test('the in-app browser view goes with its window, and the next window builds its own', async (t) => {
  const w = await startApp(t)
  ready(w)
  const first = w.main()
  w.browser(first, 'show', { x: 0, y: 0, width: 400, height: 300 })
  assert.equal(w.views.length, 1)
  assert.deepEqual(first.views, [w.views[0]])
  closeWindow(w)
  assert.equal(w.quits, 0, 'the app stays up with its window closed')
  assert.equal(w.views[0].webContents.destroyed, true, 'the old view is closed with its window')
  w.trayShow()
  const second = w.main()
  w.browser(second, 'show', { x: 0, y: 0, width: 400, height: 300 })
  assert.equal(w.views.length, 2, 'a fresh view, not the one in the closed window')
  assert.deepEqual(second.views, [w.views[1]])
  assert.equal(w.views[1].visible, true)
})

test('a harness page that crashes or fails to load while the engine runs: the start screen says the harness still runs, and Retry opens the page again without restarting the engine', async (t) => {
  const w = await startApp(t)
  ready(w)
  const win = w.main()
  win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
  let { status } = w.state()
  assert.equal(status.phase, 'error')
  assert.equal(status.page, true)
  assert.match(status.message, /^The harness page stopped; the harness itself is still running\. Click Retry to open the page again\.$/)
  assert.equal(win.webContents.url, `${START}#start`, 'the start screen shows it, not a dead page')
  await w.retry()
  assert.deepEqual(w.killed, [], 'Retry leaves the engine and its tasks alone')
  assert.equal(w.children.length, 1)
  assert.equal(win.webContents.url, HARNESS)
  assert.equal(w.state().status.phase, 'ready')

  win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', HARNESS, true)
  status = w.state().status
  assert.equal(status.page, true)
  assert.match(status.message, /^The harness page could not load \(ERR_CONNECTION_REFUSED\); the harness itself is still running\./)
  // A window rebuilt from the tray tries the page again as well.
  closeWindow(w)
  w.trayShow()
  assert.equal(w.main().webContents.url, HARNESS)
  assert.equal(w.state().status.phase, 'ready')
  assert.deepEqual(w.killed, [])
})

test('a cancelled load (ERR_ABORTED, -3, as a second reload or the app loading another page reports) is no failure', async (t) => {
  const w = await startApp(t)
  ready(w)
  const win = w.main()
  const loads = win.webContents.loads.length
  win.webContents.emit('did-fail-load', {}, -3, '', HARNESS, true)
  assert.equal(w.state().status.phase, 'ready')
  assert.equal(w.state().status.page, undefined)
  assert.equal(win.webContents.loads.length, loads, 'the page is not swapped for the start screen')
  assert.ok(!w.state().logs.some((l) => /failed to load/.test(l.text)))
  // Nor after the engine stopped: the start screen keeps saying why.
  w.children[0].emit('exit', 1)
  const said = w.state().status.message
  win.webContents.emit('did-fail-load', {}, -3, '', HARNESS, true)
  assert.equal(w.state().status.message, said)
  assert.match(said, /^The harness stopped with an error \(exit 1\)/)
})

test('Show from the tray, with the window still open on the start screen a failed harness page left, opens the page again', async (t) => {
  const w = await startApp(t)
  ready(w)
  const win = w.main()
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(win.webContents.url, `${START}#start`)
  w.trayShow()
  assert.equal(w.windows.length, 1, 'the same window')
  assert.equal(win.webContents.url, HARNESS)
  assert.equal(w.state().status.phase, 'ready')
  assert.deepEqual(w.killed, [])
})

test('the start screen after a harness page failed: the message and Retry, no startup checklist, and the log pill says running', async (t) => {
  const w = await startApp(t)
  const screen = startScreen(w)
  w.children[0].say(ENGINE_LINE)
  screen.show()
  assert.equal(screen.byId.steps.hidden, false, 'while it starts, the steps show')
  ready(w)
  w.main().webContents.emit('render-process-gone', {}, { reason: 'oom' })
  screen.show()
  assert.equal(screen.byId['status-text'].textContent, 'The harness page stopped; the harness itself is still running. Click Retry to open the page again.')
  assert.equal(screen.byId['error-actions'].hidden, false, 'Retry is offered')
  assert.equal(screen.byId['use-here'].hidden, true)
  assert.equal(screen.byId.steps.hidden, true, 'no checklist of startup steps as if nothing had started')
  assert.deepEqual(screen.byId.steps.children, [])
  assert.equal(screen.byId['log-status'].textContent, 'running')
  assert.equal(screen.byId['log-status'].className, 'pill ready')
})

test("Start-KzH.ps1 prints the engine line after the patches and right before either way it boots the engine", () => {
  assert.equal(ENGINE_LINE, 'Starting the engine.')
  const lines = LAUNCHER.split(/\r?\n/)
  const at = (re) => lines.findIndex((l) => re.test(l))
  const said = at(/^Write-Host 'Starting the engine\.'$/)
  const lastPatch = lines.findLastIndex((l) => /scripts\\patch-[\w-]+\.mjs/.test(l))
  const cached = at(/^\s*& node \$dshBin @dshArgs$/)
  const fetched = at(/^\s*& npx -y "@deepseek-ai\/dsh@\$DshVersion" @dshArgs$/)
  assert.ok(lastPatch > 0 && cached > 0 && fetched > 0, 'the launcher still has its patches and both engine starts')
  assert.ok(lastPatch < said && said < cached && said < fetched, `the line comes after the patches (${lastPatch}) and before both starts (${cached}, ${fetched}), not at ${said}`)
})

test('the splash only moves forward: the patches after a fetch leave it on the fetch, and the launcher says when the engine boots', async (t) => {
  const w = await startApp(t)
  const child = w.children[0]
  child.say('Fetching the engine (first run or new version); this takes a moment.')
  assert.equal(w.state().status.step, 'fetch')
  child.say('patch-codex-effort: applied', 'patch-dsh-branding: renamed in 12 file(s)')
  assert.equal(w.state().status.step, 'fetch', 'a patch line must not send the splash back to Preparing')
  child.say(ENGINE_LINE)
  const { status } = w.state()
  assert.equal(status.step, 'engine')
  assert.equal(status.message, 'Starting the engine, this takes about half a minute…')
  assert.ok(status.done.includes('fetch'))
})

test("a restart's splash ticks only what that run did: no fetch after a run that fetched", async (t) => {
  const w = await startApp(t)
  w.children[0].say('Fetching the engine (first run or new version); this takes a moment.', ENGINE_LINE)
  ready(w)
  await w.retry()
  await until(() => w.children.length === 2, 'the restart started the launcher again')
  w.children[1].say('patch-codex-effort: applied', ENGINE_LINE)
  const { status } = w.state()
  assert.equal(status.step, 'engine')
  assert.ok(!status.done.includes('fetch'), `this run fetched nothing, yet done is ${status.done}`)
})

test('an update that needs a rebuilt exe says to quit Kz-harness, since closing its window leaves it running', async (t) => {
  const answers = { 'rev-parse': { out: 'origin/main' }, status: { out: '' }, fetch: {}, 'rev-list': { out: '2' }, 'merge-base': {}, diff: { out: 'app/main.js' } }
  const w = await startApp(t, { git: (args) => ({ code: 0, ...answers[args[0]] }) })
  const line = w.state().logs.find((l) => /^Updates: 2 new commit/.test(l.text))?.text
  assert.equal(line, 'Updates: 2 new commit(s) need a rebuilt Kz-harness.exe, which this launcher will not do behind your back. Quit Kz-harness (right-click its tray icon and choose Quit, or press Ctrl+Q in its window; closing the window leaves it running), then run scripts\\Install-Harness.ps1.')
})

// kzh-ui-test.mjs - drive the running Kz-harness app over its DevTools protocol.
//
// A small, dependency-free stand-in for Playwright. It talks to the Electron app's DevTools
// endpoint over the Chrome DevTools Protocol using Node's built-in fetch and global
// WebSocket, so it needs no npm install and downloads no browser. It can list pages,
// screenshot one, evaluate an expression in it, dispatch a real key combo, and wait for a
// selector to appear.
//
// WHY NOT A SCREEN GRAB: KzH builds its window on the GPU, so a Windows screen grab (GDI)
// returns a blank frame even while the UI is right there on screen. CDP returns the page the
// renderer actually painted, and the live DOM beside it, which is what makes this the right
// self-check for a visual or structural claim. A blank screenshot from here means the app is
// blank; a blank GDI grab means nothing at all.
//
// Start the app with a debug port first (it refuses one otherwise):
//   $env:KZH_DEBUG='1'; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
//   & "C:\Harness\app\dist\Kz-harness-win32-x64\Kz-harness.exe" --remote-debugging-port=9222
//
// Usage:
//   node scripts/kzh-ui-test.mjs list
//   node scripts/kzh-ui-test.mjs shot <out.png> [urlOrTitleMatch]
//   node scripts/kzh-ui-test.mjs eval <expression> [urlOrTitleMatch]
//   node scripts/kzh-ui-test.mjs evalfile <path> [urlOrTitleMatch]
//   node scripts/kzh-ui-test.mjs keys <combo> [urlOrTitleMatch]
//   node scripts/kzh-ui-test.mjs wait <cssSelector> [urlOrTitleMatch]
//   node scripts/kzh-ui-test.mjs --help
//
// Options, before or after the mode:
//   --wait <cssSelector>   wait for the selector to appear before doing anything else
//   --timeout <ms>         how long --wait and the wait mode may take (default 10000)
//   --port <n>             DevTools port (default 9222, or KZH_CDP_PORT)
//
// Exit codes, so a caller can act without parsing text:
//   0 ok, 1 runtime failure (endpoint down, page threw, capture was not a PNG),
//   2 usage error (unknown mode or option, missing argument, no page matched),
//   3 the waited-for selector never appeared.
//
// Keys go through Input.dispatchKeyEvent as a real keyDown and keyUp with the right code,
// key and modifiers, because a synthetic KeyboardEvent is ignored by any handler that reads
// event.code, which is most shortcut handlers: code names the physical key and survives a
// keyboard layout change, key does not. Playwright's page.keyboard does the same for the
// same reason. Combo syntax is Ctrl+Shift+L, Alt+M, F12, Enter, ArrowUp, and so on.
//
// Exit is by process.exitCode, never process.exit(): calling exit() while the WebSocket is
// still closing can drop the real code, and here the exit code is the signal.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EXE = join(ROOT, 'app', 'dist', 'Kz-harness-win32-x64', 'Kz-harness.exe')
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const USAGE = `kzh-ui-test - drive the running Kz-harness app over its DevTools protocol.

Usage:
  node scripts/kzh-ui-test.mjs list
  node scripts/kzh-ui-test.mjs shot <out.png> [urlOrTitleMatch]
  node scripts/kzh-ui-test.mjs eval <expression> [urlOrTitleMatch]
  node scripts/kzh-ui-test.mjs evalfile <path> [urlOrTitleMatch]
  node scripts/kzh-ui-test.mjs keys <combo> [urlOrTitleMatch]
  node scripts/kzh-ui-test.mjs wait <cssSelector> [urlOrTitleMatch]

Options (before or after the mode):
  --wait <cssSelector>   wait for the selector to appear before doing anything else
  --timeout <ms>         how long --wait and the wait mode may take (default 10000)
  --port <n>             DevTools port (default 9222, or KZH_CDP_PORT)
  -h, --help             show this text

The optional urlOrTitleMatch picks one page when the debug port has several; with no match
the first page target is used. The app builds on the GPU, so a Windows screen grab returns
a blank frame: this returns the page the renderer actually painted.

Exit codes: 0 ok, 1 runtime failure, 2 usage error, 3 waited-for selector never appeared.

Start the app with a debug port first:
  $env:KZH_DEBUG='1'; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & "${EXE}" --remote-debugging-port=9222
`

/** An error carrying the exit code the caller should see. */
const fail = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A missing value after an option is a usage error, not a crash. */
function take(argv, i, flag) {
  if (i + 1 >= argv.length) throw fail(`${flag} needs a value`, 2)
  return argv[i + 1]
}

function parseArgs(argv) {
  const opts = { port: Number(process.env.KZH_CDP_PORT ?? 9222), timeoutMs: 10_000 }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '--wait' || a === '--wait-for') { opts.wait = take(argv, i, a); i++ }
    else if (a === '--timeout') { opts.timeoutMs = Number(take(argv, i, a)); i++ }
    else if (a === '--port') { opts.port = Number(take(argv, i, a)); i++ }
    else if (a.startsWith('--')) throw fail(`unknown option ${a}`, 2)
    else pos.push(a)
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0) throw fail(`--port must be a positive integer`, 2)
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw fail(`--timeout must be a number of milliseconds`, 2)
  return { opts, pos }
}

/** Every page target, or a clear failure that says how to start the app with one. */
async function listTargets(port) {
  const url = `http://127.0.0.1:${port}/json/list`
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    throw fail(
      `DevTools endpoint not reachable at ${url} (${err.cause?.code ?? err.name}).\n` +
      `The app is probably not running with a debug port. Start it like this:\n` +
      `  $env:KZH_DEBUG='1'; Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue\n` +
      `  & "${EXE}" --remote-debugging-port=${port}`,
    )
  }
  if (!res.ok) {
    throw fail(`DevTools endpoint at ${url} answered HTTP ${res.status}; is ${port} the right port?`)
  }
  const targets = await res.json()
  if (!Array.isArray(targets) || !targets.length) {
    throw fail(`DevTools endpoint at ${url} reported no targets; the app may still be starting.`)
  }
  return targets
}

/** The page to act on: the first, or the one whose url or title contains the match. */
function pick(targets, match) {
  const pages = targets.filter((t) => t.type === 'page')
  if (!match) return pages[0]
  return pages.find((t) => t.url.includes(match) || String(t.title).includes(match))
}

function noPage(targets, match) {
  const rows = targets.map((t) => `  ${t.type} ${JSON.stringify(t.title)} ${t.url}`).join('\n')
  return fail(`no page target matched ${JSON.stringify(match)}; ${targets.length} target(s):\n${rows}`, 2)
}

function connect(webSocketDebuggerUrl) {
  if (typeof WebSocket === 'undefined') throw fail('this script needs Node 22+ (global WebSocket is missing)')
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(webSocketDebuggerUrl)
    const pending = new Map()
    let id = 0
    const timer = setTimeout(() => rejectConn(fail(`the page did not accept a DevTools connection in 5s`)), 5000)
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    })
    ws.addEventListener('error', () => { clearTimeout(timer); rejectConn(fail(`WebSocket to the page failed`)) })
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolveConn({
        send: (method, params) => new Promise((res, rej) => {
          const i = ++id
          pending.set(i, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id: i, method, params }))
        }),
        close: () => ws.close(),
      })
    })
  })
}

// CDP modifier bitmask. The names are loose on purpose: a caller typing Win, Super or Cmd
// means Meta, and Ctrl and Control are the same physical key.
const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, super: 4, shift: 8 }

const NAMED = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  spacebar: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
}

// Unshifted punctuation only: the shift form of a punctuation key is what Shift+that key
// already produces, so a caller should write the shifted character and let the map fill in.
const PUNCT = {
  '-': { code: 'Minus', vk: 189 }, '=': { code: 'Equal', vk: 187 },
  ',': { code: 'Comma', vk: 188 }, '.': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 }, ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 }, '[': { code: 'BracketLeft', vk: 219 },
  ']': { code: 'BracketRight', vk: 221 }, '\\': { code: 'Backslash', vk: 220 },
  '`': { code: 'Backquote', vk: 192 },
}

/** One key name to the code, key and virtual key code Chromium wants. */
function keyFor(name) {
  const lower = name.toLowerCase()
  if (NAMED[lower]) return { ...NAMED[lower] }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    const fn = `F${lower.slice(1)}`
    return { key: fn, code: fn, vk: 111 + Number(lower.slice(1)) }
  }
  if (/^[a-z]$/.test(lower)) {
    const up = lower.toUpperCase()
    return { key: lower, code: `Key${up}`, vk: up.charCodeAt(0), text: lower, letter: true }
  }
  if (/^[0-9]$/.test(lower)) return { key: lower, code: `Digit${lower}`, vk: lower.charCodeAt(0), text: lower }
  if (PUNCT[name]) return { key: name, code: PUNCT[name].code, vk: PUNCT[name].vk, text: name }
  throw fail(`unknown key ${JSON.stringify(name)}; try a letter, a digit, F1-F24, or one of ${Object.keys(NAMED).join(', ')}`, 2)
}

/** "Ctrl+Shift+B" to the CDP params for its keyDown and keyUp. */
function parseCombo(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw fail('empty key combo', 2)
  const name = parts.pop()
  let modifiers = 0
  for (const p of parts) {
    const bit = MODS[p.toLowerCase()]
    if (!bit) throw fail(`unknown modifier ${JSON.stringify(p)} in ${JSON.stringify(combo)}`, 2)
    modifiers |= bit
  }
  const info = keyFor(name)
  // Shift turns a letter into its capital, in both key and text, so event.key matches what a
  // person would type. Ctrl, Alt and Meta make it a command, so no character is produced.
  let key = info.key
  let text = info.text
  if (info.letter && (modifiers & MODS.shift)) { key = key.toUpperCase(); text = key }
  const plain = (modifiers & (MODS.ctrl | MODS.alt | MODS.meta)) === 0
  const base = { modifiers, key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk }
  const down = { ...base, type: 'keyDown' }
  if (plain && text) { down.text = text; down.unmodifiedText = info.letter ? key.toLowerCase() : text }
  return { label: combo, down, up: { ...base, type: 'keyUp' } }
}

/** Poll the live DOM until the selector matches. Returns the ms it took, or null on timeout. */
async function waitFor(c, selector, timeoutMs) {
  const expression = `Boolean(document.querySelector(${JSON.stringify(selector)}))`
  const started = Date.now()
  for (;;) {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) {
      throw fail(`selector ${JSON.stringify(selector)} is not a valid CSS selector: ${r.exceptionDetails.text ?? 'evaluate failed'}`, 2)
    }
    if (r.result?.value) return Date.now() - started
    if (Date.now() - started >= timeoutMs) return null
    await sleep(100)
  }
}

async function main(argv) {
  const { opts, pos } = parseArgs(argv)
  if (opts.help || !pos.length) {
    process.stdout.write(USAGE)
    return 0
  }

  const mode = pos[0]
  const arg2 = pos[1]
  const match = pos[2]

  const targets = await listTargets(opts.port)
  if (mode === 'list') {
    for (const t of targets) console.log(`${t.type}\t${JSON.stringify(t.title)}\t${t.url}`)
    return 0
  }

  if (!['shot', 'eval', 'evalfile', 'keys', 'wait'].includes(mode)) {
    throw fail(`unknown mode ${JSON.stringify(mode)}; run with --help for the list`, 2)
  }
  // eval needs no argument beyond its expression, so only the modes named here must have one.
  if (!arg2) throw fail(`${mode} needs an argument; run with --help`, 2)

  const target = pick(targets, match)
  if (!target) throw noPage(targets, match)

  const c = await connect(target.webSocketDebuggerUrl)
  try {
    await c.send('Page.enable')
    await c.send('Runtime.enable')

    if (opts.wait) {
      const ms = await waitFor(c, opts.wait, opts.timeoutMs)
      if (ms === null) throw fail(`selector ${JSON.stringify(opts.wait)} did not appear within ${opts.timeoutMs} ms`, 3)
    }

    if (mode === 'wait') {
      const ms = await waitFor(c, arg2, opts.timeoutMs)
      if (ms === null) throw fail(`selector ${JSON.stringify(arg2)} did not appear within ${opts.timeoutMs} ms`, 3)
      console.log(`wait -> ${JSON.stringify(arg2)} found after ${ms} ms in ${JSON.stringify(target.title)}`)
      return 0
    }

    if (mode === 'shot') {
      const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const bytes = Buffer.from(data, 'base64')
      // A capture that is not a PNG means something other than the page came back, so it is a
      // failure rather than a file a caller might trust and look at.
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIG)) throw fail(`capture was not a PNG (${bytes.length} bytes)`)
      writeFileSync(arg2, bytes)
      console.log(`shot -> ${arg2} (${statSync(arg2).size} bytes, png) from ${JSON.stringify(target.title)}`)
      return 0
    }

    if (mode === 'keys') {
      const combo = parseCombo(arg2)
      await c.send('Input.dispatchKeyEvent', combo.down)
      await c.send('Input.dispatchKeyEvent', combo.up)
      console.log(`keys -> ${combo.label} sent to ${JSON.stringify(target.title)}`)
      return 0
    }

    const expression = mode === 'evalfile' ? readFileSync(arg2, 'utf8') : arg2
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'the expression threw'
      throw fail(detail)
    }
    console.log(JSON.stringify(r.result?.value ?? r, null, 2))
    return 0
  } finally {
    c.close()
  }
}

const code = await main(process.argv.slice(2))
  .catch((err) => { process.stderr.write(`kzh-ui-test: ${err.message}\n`); return err.exitCode ?? 1 })
process.exitCode = code

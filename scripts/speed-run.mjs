// The speed benchmark from a shell (docs/benchmark.md 2.12), for Speed-Run.bat at the harness root:
// every installed local chat model, or the ones named, measured exactly as Settings, Local models,
// Benchmark all measures them, with KzH closed.
//
//   node scripts/speed-run.mjs [--models <id>[,<id> ...]] [--context <tokens>] [--harness <dir>] [--data <dir>] [--verbose] [--no-pause]
//
// It runs local.js's own speed run (createLocalModels().benchmark()), so each reading is taken,
// checked and stored the same way: in <data>/local.json under `speed`, keyed <model>@<context>,
// where the Local models card and the picker find it when KzH starts. One Speed-Run goes at a time
// (speed-run.lock). It refuses while KzH runs (its engine, its app, or whatever holds its port when
// that cannot be told from it), since the two would load models over each other on one GPU and both
// write local.json, and while a llama-server or a Laya an earlier KzH left behind holds memory the
// readings would lose. It prints each model's line as the card does, then a table of the models it
// measured. Every run is logged as the in-app one is (docs/benchmark.md 2.13): its summary appended
// to <data>/speed-runs/speed-runs.log, and every phase, request and engine line of it, each with
// its time, in speed-run-<time>.log beside it; a run that never starts is written in
// speed-runs.log with why, a bad argument included. Ctrl+C cancels as the card's Cancel does, at
// any point; closing the console window ends it too; the engine is stopped on the way out.
//
// The context: KzH starts a local model at the plugin config's local.contextSize when the profile
// sets one, and a reading stands only for a load at the context it was taken at. This reads
// jev-router's local.contextSize from the profile's patch files (<DSH_HOME>/profiles/web and
// <DSH_HOME>, the later winning, DSH_HOME being the folder above the data folder) and refuses one
// it cannot read; --context <tokens> says it outright and wins. --no-pause is for Speed-Run.bat,
// which reads it; here it does nothing. The data folder defaults to <DSH_HOME>/jev-router (DSH_HOME
// being ~/.kzh when unset), and the harness to the one this script is in.
//
// Exit codes, for a scheduled run: 0 every model was measured; 1 a model was not measured (its
// line says why); 2 it could not run (no engine, no model, an unknown model, a bad argument, a
// context it cannot tell); 3 KzH, a llama-server, a Laya or another Speed-Run is running; 130
// cancelled with Ctrl+C; 128 and the signal's number when its console was closed or it was ended.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runAsScript } from './run-as-script.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..', 'plugins', 'jev-router')
const plugin = (file) => import(pathToFileURL(join(PLUGIN, file)).href)

/** Where KzH serves its app (Start-KzH.ps1, app/main.js). */
export const KZH_PORT = 3080
export const EXIT = { measured: 0, notMeasured: 1, couldNotRun: 2, kzhRunning: 3, cancelled: 130 }
/** Who started a run, as the speed run history says it. */
const BY = 'Speed-Run.bat'

export const defaultDataDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.kzh'), 'jev-router')
export const defaultHarness = () => resolve(here, '..')

/** A refusal to run at all: `code` is its exit code; `logged` once the history has it. */
class Stop extends Error {
  constructor(code, message, { logged = false } = {}) { super(message); this.code = code; this.logged = logged }
}

const USAGE = 'usage: node scripts/speed-run.mjs [--models <id>[,<id> ...]] [--context <tokens>] [--harness <dir>] [--data <dir>] [--verbose] [--no-pause]'

export function parseArgs(argv) {
  const out = { models: undefined, context: undefined, harness: undefined, data: undefined, verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--verbose') { out.verbose = true; continue }
    if (a === '--no-pause') continue
    if (!['--models', '--context', '--harness', '--data'].includes(a)) throw new Stop(EXIT.couldNotRun, `unknown argument ${a}\n${USAGE}`)
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) throw new Stop(EXIT.couldNotRun, `${a} needs a value\n${USAGE}`)
    if (a === '--models') {
      // PowerShell hands `--models a,b` to a .bat as `--models a b`, so the words after it count too.
      const words = [v]
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) words.push(argv[++i])
      const ids = words.flatMap((w) => w.split(',')).map((s) => s.trim()).filter(Boolean)
      if (!ids.length) throw new Stop(EXIT.couldNotRun, '--models needs at least one model id, such as --models qwen3-8b')
      out.models = [...(out.models ?? []), ...ids]
    } else if (a === '--context') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 2048) throw new Stop(EXIT.couldNotRun, '--context is a whole number of tokens, 2048 or more, as the plugin config\'s local.contextSize')
      out.context = n
    } else out[a.slice(2)] = resolve(v)
  }
  return out
}

/** Whether something accepts a connection on 127.0.0.1:`port`, within `timeoutMs`. */
export function portAnswers(port, { host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  return new Promise((done) => {
    const socket = connect({ host, port })
    const end = (open) => { socket.destroy(); done(open) }
    socket.setTimeout(timeoutMs, () => end(false))
    socket.once('connect', () => end(true))
    socket.once('error', () => end(false))
  })
}

/**
 * Every process running now as `{ pid, name, cmd }`, or null when they cannot be listed. On
 * Windows the command lines come from CIM, which tells KzH's engine from any other node, and are
 * empty for a process this one may not read (one run as administrator, say); with no PowerShell,
 * tasklist gives the names alone (`cmd` null).
 */
export function processList({ platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (r?.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('|')) {
      return r.stdout.split(/\r?\n/).map((l) => /^(\d+)\|([^|]*)\|(.*)$/.exec(l)).filter(Boolean).map(([, pid, name, cmd]) => ({ pid: Number(pid), name: name.trim(), cmd: cmd.trim() }))
    }
    const t = run('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    if (t?.status !== 0 || typeof t.stdout !== 'string') return null
    return t.stdout.split(/\r?\n/).map((l) => /^"([^"]*)","(\d+)"/.exec(l)).filter(Boolean).map(([, name, pid]) => ({ pid: Number(pid), name, cmd: null }))
  }
  const r = run('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })
  if (r?.status !== 0 || typeof r.stdout !== 'string') return null
  return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(([, pid, cmd]) => ({ pid: Number(pid), name: cmd.trim().split(/\s+/)[0].split('/').pop(), cmd: cmd.trim() }))
}

/**
 * The pid listening on 127.0.0.1:`port`, or null when it cannot be found: netstat on Windows (a
 * listening socket's far end is 0.0.0.0:0 or [::]:0 whatever language Windows speaks), ss elsewhere.
 */
export function portOwner(port, { platform = process.platform, run = spawnSync } = {}) {
  if (platform === 'win32') {
    const r = run('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    if (r?.status !== 0 || typeof r.stdout !== 'string') return null
    for (const line of r.stdout.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/)
      if (f.length >= 5 && /^TCP$/i.test(f[0]) && f[1].endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(f[2]) && Number(f.at(-1)) > 0) return Number(f.at(-1))
    }
    return null
  }
  const r = run('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  const pid = r?.status === 0 && typeof r.stdout === 'string' ? /pid=(\d+)/.exec(r.stdout)?.[1] : null
  return pid ? Number(pid) : null
}

/**
 * Whether a command line is KzH's engine: node running the @deepseek-ai/dsh package with `web` as
 * its own argument, as Start-KzH.ps1 starts it and app/main.js's isEngineCommand reads it.
 */
export const isKzhEngine = (cmd) => /\bnode(\.exe)?\b/i.test(cmd ?? '') && /@deepseek-ai[\\/]dsh\b/i.test(cmd ?? '') && /(?:^|\s)web(?:\s|$)/i.test(cmd ?? '')

/** A laya.serve an earlier KzH left running, from the pids its sidecar.json recorded, or null. */
export async function leftoverLaya({ harness, data }) {
  const { isAlive, layaPaths } = await plugin('laya-install.js')
  const { processInfo } = await plugin('laya-sidecar.js')
  let rec
  try { rec = JSON.parse(readFileSync(layaPaths({ harnessDir: harness, dataDir: data }).sidecarJson, 'utf8')) } catch { return null }
  for (const pid of new Set([rec?.pid, rec?.interpreterPid, rec?.check?.pid, rec?.check?.interpreterPid].filter((x) => Number.isSafeInteger(x) && x > 0))) {
    if (!isAlive(pid)) continue
    const info = await processInfo(pid).catch(() => null)
    if (info && /\blaya\.serve\b/.test(info.cmdline ?? '')) return { pid }
  }
  return null
}

const CLOSE_KZH = 'Close KzH and run this again: the speed run and KzH would load models over each other on one GPU, and both write local.json.'

/**
 * What stands in the way of a speed run now: `why` it must not start, or null, and `notes` to
 * print. KzH's engine or app is a second owner of the GPU and of local.json; a llama-server or a
 * laya.serve with no KzH is one a crash left, holding memory the budget would plan around and the
 * readings would lose. Whatever listens on KzH's port is looked up by its pid: another program, by
 * a command line that can be read and is not KzH's engine, does not stop the run; one that cannot
 * be told from KzH does.
 */
export async function machineCheck({ harness, data, port = KZH_PORT, answers = portAnswers, processes = processList, owner = portOwner, laya = leftoverLaya } = {}) {
  const list = await processes()
  const engine = list?.find((p) => isKzhEngine(p.cmd))
  if (engine) return { why: `KzH is running (its engine, ${engine.name}). ${CLOSE_KZH}`, notes: [] }
  const app = list?.find((p) => /^kz-harness(\.exe)?$/i.test(p.name))
  if (app) return { why: `KzH is running (${app.name}). ${CLOSE_KZH}`, notes: [] }
  const llama = list?.find((p) => /^llama-server(\.exe)?$/i.test(p.name))
  if (llama) return { why: `A llama-server is running with KzH closed (${llama.name}, pid ${llama.pid}), holding memory the readings would lose. End it in Task Manager, or restart the PC, and run this again.`, notes: [] }
  const layaLeft = await laya({ harness, data }).catch(() => null)
  if (layaLeft) return { why: `A Laya an earlier KzH left running (pid ${layaLeft.pid}) holds memory the readings would lose. Start KzH and close it again, which stops it, or end pid ${layaLeft.pid} in Task Manager, and run this again.`, notes: [] }
  if (await answers(port)) {
    const pid = await owner(port)
    const holder = pid ? list?.find((p) => p.pid === pid) : null
    if (holder?.cmd) return { why: null, notes: [`Another program answers on 127.0.0.1:${port} (${holder.name}, pid ${pid}); it is not KzH's engine, so the speed run goes ahead.`] }
    const who = holder ? `${holder.name}, pid ${pid}, whose command line cannot be read (it may run as administrator)` : pid ? `pid ${pid}, which cannot be looked up` : 'a program that cannot be found'
    return { why: `KzH, or another program, answers on 127.0.0.1:${port} (${who}), so nobody can tell whether KzH is running. Close KzH, or the program on that port, and run this again.`, notes: [] }
  }
  return { why: null, notes: [] }
}

/**
 * jev-router's config.local.contextSize in one patch file's text: `{ value }`, `{ unreadable: true }`
 * when the file gives it (or gives config.local) in a form this cannot read, or null when it gives
 * none. The patch files are YAML lists of `- id: <plugin>` entries (config/cordis.patch.yml); this
 * reads the block form and the one-line forms of the keys under a jev-router entry, comments aside.
 * Any other contextSize (another plugin's, an agent's llm.contextSize) is not this one.
 */
export function jevContextSize(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trimEnd())
  const indent = (l) => l.length - l.trimStart().length
  const flow = /^\{[^{}]*\}$/
  let found = null
  for (let i = 0; i < lines.length; i++) {
    const entry = /^(\s*)- id:\s*['"]?jev-router['"]?$/.exec(lines[i])
    if (!entry) continue
    const base = entry[1].length
    const path = []
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      const ind = indent(l)
      if (ind <= base) break
      const kv = /^\s*([\w-]+):\s*(.*)$/.exec(l)
      if (!kv) continue
      while (path.length && path.at(-1).indent >= ind) path.pop()
      const keys = [...path.map((p) => p.key), kv[1]].join('.')
      const v = kv[2].trim()
      if (keys === 'config.local.contextSize') found = /^\d+$/.test(v) ? { value: Number(v) } : { unreadable: true }
      else if (keys === 'config.local' && v) {
        // `local: { ... }` read for its contextSize; anything else (an !include, say) cannot be read here.
        const inline = flow.test(v) ? /\bcontextSize:\s*([^,}\s]+)/.exec(v) : null
        if (!flow.test(v)) found = { unreadable: true }
        else if (inline) found = /^\d+$/.test(inline[1]) ? { value: Number(inline[1]) } : { unreadable: true }
      } else if (keys === 'config' && v && /\blocal\b/.test(v)) {
        const inline = /\blocal:\s*\{[^{}]*\bcontextSize:\s*(\d+)[^{}]*\}/.exec(v)
        if (inline) found = { value: Number(inline[1]) }
        else if (/\bcontextSize\b/.test(v)) found = { unreadable: true }
      }
      if (!v) path.push({ indent: ind, key: kv[1] })
    }
  }
  return found
}

/**
 * The context KzH starts local models with, from the profile: `{ value, file }` for jev-router's
 * local.contextSize (the home patch, read last, winning), `{ unreadable: file }` for a patch file
 * that gives it in a form this cannot read, or null when the profile sets none.
 */
export function profileContext(dshHome) {
  let found = null
  for (const file of [join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), join(dshHome, 'cordis.patch.yml')]) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const got = jevContextSize(text)
    if (got?.unreadable) return { unreadable: file }
    if (got) found = { value: got.value, file }
  }
  return found
}

const PHASES = { loading: 'loading', warming: 'warming up', reading: 'reading the prompt', measuring: 'timed request', restoring: 'putting the engine back as it was' }
const fixed = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '-')
const ctxText = (ctx) => (ctx % 1024 === 0 ? `${ctx / 1024}k` : String(ctx))
const utcMinute = (d) => `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`

/** The table of what was measured, in plain ASCII columns. */
export function table(rows) {
  const head = ['Model', 'Generate tok/s', 'Read tok/s', 'Context', 'GPU layers', 'VRAM GB', 'RAM GB', 'Load s', 'Threads']
  const body = rows.map((r) => [
    r.name,
    r.ok ? fixed(r.reading.tokensPerSec) : 'not measured',
    r.ok ? (r.reading.promptTokensPerSec == null ? 'cached' : fixed(r.reading.promptTokensPerSec, 0)) : '-',
    r.ctx ? ctxText(r.ctx) : '-',
    r.reading?.layersOnGpu ? `${r.reading.layersOnGpu.gpu}/${r.reading.layersOnGpu.total}` : '-',
    fixed(r.memory?.vramGB), fixed(r.memory?.ramGB),
    r.reading?.loadMs != null ? fixed(r.reading.loadMs / 1000) : '-',
    r.reading?.threads != null ? String(r.reading.threads) : '-',
  ])
  const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(width[i])).join('  ').trimEnd()
  return [line(head), line(width.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n')
}

/** Write a run that never started in the history of `data`, with the time it was asked for. */
async function logRefusal(data, at, why) {
  const { SPEED_HISTORY, speedRefusalEntry } = await plugin('local.js')
  const dir = join(data, 'speed-runs')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, SPEED_HISTORY), speedRefusalEntry({ at, by: BY, why }))
}

/**
 * The speed run: refuse while something stands in its way, measure, print; the logs are written
 * by local.js, and a refusal here. Returns its exit code. `interrupts` emits 'interrupt' for a
 * Ctrl+C and 'ended' with the signal's name when the console is closed or the process is ended.
 * `seams` reach what the tests replace: `machineCheck`, `specs` (detectSpecs), `localModels`
 * (createLocalModels options: spawn, fetch, port) and `holds` (whether a pid holds the lock).
 */
export async function speedRun({ harness = defaultHarness(), data = defaultDataDir(), models, context, verbose = false, print = (s) => process.stdout.write(`${s}\n`), interrupts = null, pollMs = 200, stopWaitMs = 10_000, seams = {} } = {}) {
  const { SPEED_HISTORY, SPEED_LOCK, createLocalModels, detectSpecs, readManifest, specsText } = await plugin('local.js')
  const { isAlive, layaPaths } = await plugin('laya-install.js')
  const { processInfo } = await plugin('laya-sidecar.js')
  // The lock's holder: a live process that is a speed run, or one that cannot be read, which is
  // taken for one; a pid Windows gave to another program since is not.
  const holds = seams.holds ?? (async (pid) => {
    if (!isAlive(pid)) return false
    const info = await processInfo(pid).catch(() => null)
    return !info || /speed-run/i.test(info.cmdline ?? '')
  })
  const started = new Date()
  print(`KzH speed run, ${utcMinute(started)}`)

  const logDir = join(data, 'speed-runs')
  const history = join(logDir, SPEED_HISTORY)
  // A run that never starts is written in the history too, so a scheduled run that did nothing
  // says why where its runs are kept.
  const refuse = (code, why) => {
    try { mkdirSync(logDir, { recursive: true }); appendFileSync(history, `${utcMinute(started)}, ${BY}: did not run. ${why.replace(/\s+/g, ' ').trim()}\n\n`) } catch (err) {
      why += `\n(The speed run history could not be written: ${err.code ?? err.message}.)`
    }
    return new Stop(code, why, { logged: true })
  }

  // Ctrl+C from the first moment, said for the step it lands in: before the run exists it ends the
  // script there; while the run goes the first cancels it as the card's Cancel does and a second
  // stops at once; once every model is done there is nothing left to cancel.
  let local = null
  let step = 'before'
  let cancelled = false
  let forced = false
  let detail = null
  let onCancel = () => {}
  const onInterrupt = () => {
    if (forced) return
    if (cancelled) { forced = true; print('Stopping at once.'); onCancel(); return }
    if (step === 'before') { cancelled = true; print('Cancelling: no model has been loaded yet, so the run ends here.'); onCancel(); return }
    if (step === 'after') { print('The run has ended; there is nothing to cancel.'); return }
    try {
      if (local.cancelBenchmark()) { cancelled = true; print('Cancelling: the request in flight is stopped, and the engine put back as it was.') }
    } catch (err) { print(err.message) }
  }
  const cancelledNow = () => { if (cancelled) throw refuse(EXIT.cancelled, 'Cancelled with Ctrl+C before any model was loaded.') }
  // The console closed, or the process ended: the exit that follows stops the engine (local.js's
  // exit hook), and the history says what became of the run, since local.js cannot finish its entry.
  let release = () => {}
  const onEnded = (signal) => {
    try {
      if (detail) appendFileSync(history, `${utcMinute(started)}, ${BY}: ended by ${signal} while it measured (its console was closed, or it was stopped). Readings already taken are kept.\n  Details: ${basename(detail)}\n\n`)
    } catch { /* the exit goes on */ }
    release()
  }
  interrupts?.on('interrupt', onInterrupt)
  interrupts?.on('ended', onEnded)
  try {
    // One Speed-Run at a time, before anything else: a second one would otherwise meet the first's
    // llama-server and be told to end it. A lock whose pid is not alive is one a crash left, and is taken over.
    const lock = join(logDir, SPEED_LOCK)
    try { mkdirSync(logDir, { recursive: true }) } catch { /* the lock's own write says why */ }
    for (let attempt = 0; ; attempt++) {
      try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); release = () => { release = () => {}; rmSync(lock, { force: true }) }; break } catch (err) {
        if (err.code !== 'EEXIST' || attempt > 0) throw refuse(EXIT.couldNotRun, `The speed run lock ${lock} could not be taken: ${err.code ?? err.message}.`)
        const holder = Number(String(readFileSync(lock, 'utf8')).trim())
        if (holder && holder !== process.pid && (await holds(holder))) throw refuse(EXIT.kzhRunning, `Another speed run is going (Speed-Run.bat, pid ${holder}). Let it finish, or end it, and run this again.`)
        rmSync(lock, { force: true })
      }
    }
    const check = await (seams.machineCheck ?? machineCheck)({ harness, data })
    if (check.why) throw refuse(EXIT.kzhRunning, check.why)
    for (const n of check.notes) print(`Note: ${n}`)
    cancelledNow()

    let modules
    try { modules = readManifest(join(harness, 'config', 'local-models.json')) } catch (err) { throw refuse(EXIT.couldNotRun, `The local models manifest did not load: ${err.message}`) }
    const modelsDir = join(harness, 'models')
    const specs = await (seams.specs ?? (() => detectSpecs({ dir: modelsDir })))().catch(() => null)
    print(`PC: ${specs ? specsText(specs) : 'not detected'}`)
    cancelledNow()
    if (context === undefined) {
      const fromProfile = profileContext(dirname(data))
      if (fromProfile?.unreadable) throw refuse(EXIT.couldNotRun, `${fromProfile.unreadable} gives jev-router's local.contextSize in a form this cannot read. Run this again with --context <the number KzH starts local models with>: a reading stands only for a load at the context it was taken at.`)
      if (fromProfile) { context = fromProfile.value; print(`Context: ${context} tokens, jev-router's local.contextSize in ${fromProfile.file}.`) }
    }
    print('Keep KzH closed until this ends: it would load models beside the ones measured.')

    local = createLocalModels({
      modules,
      engineDir: join(harness, 'engine', 'llama'),
      modelsDir,
      settingsFile: join(data, 'local.json'),
      speedLogDir: logDir,
      contextSize: context,
      specs: async () => specs,
      log: (t) => { if (verbose) print(`  [engine] ${t}`) },
      ...seams.localModels,
    })
    // A model file placed by hand is hashed once before it counts as installed, which for a real
    // model takes a while; Ctrl+C ends that wait. One whose hash does not match the manifest is then
    // named by the run as not measured, with why (local.js).
    const hashing = (await local.status()).modules.filter((m) => m.kind === 'model' && m.state === 'verifying')
    if (hashing.length) {
      print(`Checking the SHA256 of ${hashing.map((m) => m.name ?? m.id).join(', ')} (a file placed by hand; this is done once).`)
      await Promise.race([local.settled(), new Promise((r) => { onCancel = r })])
      onCancel = () => {}
    }
    cancelledNow()
    let order
    try { order = await local.benchmark({ ...(models ? { ids: models } : {}), by: BY }) } catch (err) {
      // local.js words an install as KzH's chat command; from a shell the installer does it too.
      const how = /\/install-llm/.test(err.message) ? '\nInstall in KzH (type /install-llm in a chat), or run scripts\\Install-Harness.ps1 -LocalModels <id,id|all>.' : ''
      throw refuse(EXIT.couldNotRun, `${err.message}${how}`)
    }
    step = 'running'
    // A Ctrl+C while benchmark() was starting the run reaches it now.
    if (cancelled) { try { local.cancelBenchmark() } catch (err) { print(err.message) } }
    const nameOf = (id) => modules.find((m) => m.id === id)?.name ?? id
    // The models the run already knows it cannot measure (their lines come first) are not said to be measured.
    const skipped = new Set(local.speedResults().done.map((d) => d.id))
    const measuring = order.filter((id) => !skipped.has(id))
    print(measuring.length ? `Measuring ${measuring.map(nameOf).join(', ')}: a warm-up, the 8,192-token prompt, then three timed requests each.` : 'No model can be measured; each says why below.')
    print('')

    let said = ''
    let shown = 0
    let run
    for (;;) {
      run = (await local.status()).speedRun
      detail = run.state === 'running' ? run.log?.detail ?? null : null
      for (const line of run.done.slice(shown)) print(`${line.ok ? 'OK ' : 'NO '} ${line.text}`)
      shown = run.done.length
      if (run.state === 'idle') break
      const c = run.current
      if (c) {
        const at = order.indexOf(c.id) + 1
        const text = c.phase === 'restoring' ? `     ${PHASES.restoring}` : `     [${at}/${order.length}] ${nameOf(c.id)}: ${PHASES[c.phase] ?? c.phase}${c.run ? ` ${c.run} of 3` : ''}`
        if (text !== said) { said = text; print(text) }
      }
      if (forced) {
        // Stopped at once: the cancelled model is given a few seconds to let go of the engine, so
        // the run can end itself and say so; only then is everything stopped from here.
        const until = Date.now() + stopWaitMs
        while (Date.now() < until && (await local.status()).speedRun.state === 'running') await new Promise((r) => setTimeout(r, 50))
        run = (await local.status()).speedRun
        for (const line of run.done.slice(shown)) print(`${line.ok ? 'OK ' : 'NO '} ${line.text}`)
        break
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    step = 'after'
    if (run.restore) print(run.restore)

    // Each model's figures, as the logs have them: the reading, its context and the memory its load reported.
    const { done } = local.speedResults()
    const results = order.map((id) => {
      const line = done.find((d) => d.id === id)
      return { id, name: nameOf(id), ok: !!line?.ok, ctx: line?.ctx ?? null, reading: line?.ok ? line.reading : null, memory: line?.memory ?? null }
    })
    print('')
    print(table(results))
    if (existsSync(layaPaths({ harnessDir: harness, dataDir: data }).installed)) {
      print('')
      print('Laya is installed and was not loaded during this run. KzH uses these readings while no Laya is held beside the model; with Laya held, run Benchmark in Settings, Local models.')
    }
    print('')
    // A load writes its memory reading to local.json whatever became of the speed, so only the
    // speed readings are counted here.
    const saved = results.filter((r) => r.ok).length
    print(saved ? `${saved === 1 ? '1 speed reading' : `${saved} speed readings`} saved in local.json, where KzH reads them.` : 'No speed reading was saved.')
    // The logs' paths only when they hold this run; else what could not be written.
    if (run.logError) print(`The speed run log could not be written: ${run.logError}. This run is not in it, or not all of it.`)
    else if (run.log) {
      print(`Every speed run on this PC: ${run.log.history}`)
      print(`This run in detail: ${run.log.detail}`)
    }
    return forced || cancelled ? EXIT.cancelled : results.every((r) => r.ok) ? EXIT.measured : EXIT.notMeasured
  } finally {
    interrupts?.off('interrupt', onInterrupt)
    interrupts?.off('ended', onEnded)
    await local?.dispose({ why: 'the speed run was stopped at once' })
    release()
  }
}

/** The value of `--data` in raw arguments, for a refusal that comes before they are read. */
const dataArg = (argv) => { const at = argv.indexOf('--data'); return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? resolve(argv[at + 1]) : null }

export async function main(argv = process.argv.slice(2), { print = (s) => process.stdout.write(`${s}\n`), fail = (s) => process.stderr.write(`${s}\n`), interrupts, seams } = {}) {
  const at = new Date()
  try {
    const a = parseArgs(argv)
    if (a.help) { print(USAGE); return EXIT.measured }
    return await speedRun({ harness: a.harness, data: a.data, models: a.models, context: a.context, verbose: a.verbose, print, interrupts, seams })
  } catch (err) {
    // A bad argument, or something nobody foresaw, is written in the history too: a scheduled run
    // shows nobody its console. The history gets the first line; the console the whole of it.
    const why = err instanceof Stop ? err.message : `speed-run: ${err.message}`
    if (!err.logged) {
      try { await logRefusal(dataArg(argv) ?? defaultDataDir(), at, why.split('\n')[0]) } catch { /* said on the console below */ }
    }
    fail(err instanceof Stop ? why : `${why}\n${err.stack ?? ''}`.trimEnd())
    return err instanceof Stop ? err.code : EXIT.couldNotRun
  }
}

if (runAsScript(import.meta.url)) {
  // Ctrl+C: the first cancels as the card's Cancel does, a second stops at once. Closing the
  // console window (SIGHUP on Windows), Ctrl+Break (SIGBREAK) or an end from outside (SIGTERM)
  // would end node without its exit event, and with it the exit hook that stops llama-server,
  // which runs with no console of its own and would outlive the script with its memory: each is
  // turned into an exit, which runs that hook.
  const { EventEmitter } = await import('node:events')
  const interrupts = new EventEmitter()
  process.on('SIGINT', () => interrupts.emit('interrupt'))
  for (const [signal, n] of [['SIGHUP', 1], ['SIGBREAK', 21], ['SIGTERM', 15]]) {
    process.on(signal, () => { interrupts.emit('ended', signal); process.exit(128 + n) })
  }
  process.exitCode = await main(process.argv.slice(2), { interrupts })
  // Anything left running (the hash of a large model file, cut short by Ctrl+C) must not hold
  // the window open: once the output has had a moment to reach the console, the script ends.
  setTimeout(() => process.exit(), 1000).unref()
}

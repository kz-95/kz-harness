// Laya's sidecar: the official `python -m laya.serve` from Laya's own venv, on 127.0.0.1 only,
// started and stopped by KzH as llama-server is (docs/laya-auto.md 7.4 to 7.9).
//
// A second supervisor beside local.js, never inside it: local.js holds one engine and stops it to
// start another, with llama-specific arguments, memory reading and planning throughout, so a Python
// process in there would touch every one of those paths and could evict the chat model. Nothing
// here can stop llama, and llama's acquire() can never stop Laya; the two meet only in the shared
// residency (residency.js), where one RAM budget covers both and a Laya nothing holds gives way.
//
// Each start gets a fresh port from this module's own allocator and a fresh 48-hex key that lives
// in memory only. It counts as ready only once /health reports the English checkpoint loaded and a
// warm-up has been answered with this start's key, which also proves the server on the port is
// this child and not a leftover. A start that fails is `failed` until the person presses Start; a
// ready Laya that exits is restarted with backoff, and stops trying after the fourth exit in ten
// minutes. Laya's own log lines tell the device it really runs on, since /health only echoes what
// it was asked for.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { constants as osConstants, cpus, setPriority as osSetPriority } from 'node:os'
import { resolve, sep } from 'node:path'
import { createRotatingLog, execText, isAlive as pidAlive, layaPaths, sizeOf, verifyWeights, withoutSecrets } from './laya-install.js'
import { ADAPTER_VERSION } from './laya-questions.js'
import { defaultThreads, freePort, killTree as defaultKillTree, workingSetOf } from './local.js'

const GB = 1024 ** 3
const r1 = (x) => Math.round(x * 10) / 10
const r2 = (x) => Math.round(x * 100) / 100
const r4 = (x) => Math.round(x * 1e4) / 1e4
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => {}); return { promise, resolve, reject } }

const WHERE = 'Settings → Jev setup → Laya decision model'
/** A reason as the inside of a sentence: its own closing period goes, so a reply never reads `budget.).` */
const clause = (reason) => String(reason ?? '').trim().replace(/\.$/, '')

/** What the person reads when Laya cannot be asked, word for word (3.5), and the sidecar's own lines. */
export const LAYA_TEXT = Object.freeze({
  notInstalled: `Laya Auto did not run this: Laya is not installed on this PC. Install it in ${WHERE}, or pick Jev Auto. Nothing was run.`,
  disabled: 'Laya Auto did not run this: Laya is switched off in the configuration (jev-router laya.enabled). Nothing was run.',
  invalid: (message) => `Laya Auto did not run this: Laya's settings are invalid (${message}). Nothing was run.`,
  failed: (reason) => `Laya Auto did not run this: Laya stopped after an error (${clause(reason)}). Press Start in ${WHERE}, where the log is. Nothing was run.`,
  stillStarting: (s) => `Laya Auto did not run this: Laya was still starting after ${s} s. Nothing was run. Send it again once ${WHERE} says Running.`,
  couldNotStart: (reason) => `Laya Auto did not run this: Laya could not start (${clause(reason)}). Press Start in ${WHERE}, where the log is. Nothing was run.`,
  // A start the RAM budget or a GPU with no room turned down ran nothing and logged nothing, and
  // Start is turned down the same way: the reason says what to do (7.7).
  refused: (reason) => `Laya Auto did not run this: ${clause(reason)}. Nothing was run.`,
  stopWhileHeld: 'Laya is deciding for an open Laya Auto run; stop that run first.',
  orphan: (pid, gb) => `Stopped a Laya left running by an earlier session (pid ${pid}, ${gb ?? '?'} GB RAM).`,
  spilling: "Laya's GPU memory is spilling into system memory, so it and the local models are slow. Stop the local model, or pick CPU for Laya.",
  hung: (s) => `Laya spent over ${s} s on one request and was restarted.`,
  temperatures: 'Laya reports uncalibrated confidence for questions with 11 or more options (always taskType and skill; capability, strategy and the agent picks when that many are offered); KzH re-tempers them and marks each such answer uncalibrated.',
  gpuFailed: 'the GPU failed during inference (out of memory, or a CUDA error such as after sleep or hibernation)',
})

/**
 * Laya cannot be asked. `message` is the reply the person reads (3.5); `reason` says which case
 * (`not_installed`, `disabled`, `invalid`, `failed`, `start_timeout`, `start_failed`, `refused`,
 * `disposed`) and `detail` the inner reason, so a caller mid-run can word it as a failed call
 * instead of a refused run.
 */
export class LayaUnavailable extends Error {
  constructor(message, { reason, detail = null } = {}) {
    super(message)
    this.name = 'LayaUnavailable'
    this.code = 'LAYA_UNAVAILABLE'
    this.reason = reason
    this.detail = detail
  }
}

/**
 * A start that did not reach ready: the reason, and the log lines that say why. `refused` is a start
 * the budget or the GPU's room turned down before anything ran, which is not a failure (7.7).
 */
class StartFailed extends Error {
  constructor(message, { lines = [], bind = false, stopped = false, refused = false } = {}) { super(message); Object.assign(this, { lines, bind, stopped, refused }) }
}

const where = (device) => (device === 'cuda' ? 'GPU' : 'CPU')
/** The live line while a run waits for Laya to load (3.3, 3.5). */
export const startingLine = ({ device, elapsedMs = 0, lastMs = null }) =>
  `Starting Laya on this PC: loading the model on the ${where(device)} (${Math.round(elapsedMs / 1000)} s${lastMs ? `; the last start took ${Math.round(lastMs / 1000)} s` : ''})…`
/** The live line once it has loaded. */
export const readyLine = ({ device, loadMs }) => `Laya is ready on the ${where(device)} (loaded in ${Math.round((loadMs ?? 0) / 1000)} s)`
/** The live line while a run waits for a stop under way (an idle stop, a yield, the budget) to end, before Laya starts again (3.5). */
export const stoppingLine = () => 'Waiting for Laya to finish stopping, then starting it…'
/** The live line while a run waits out the pause before a restart after Laya stopped unexpectedly (3.5, 7.5). */
export const restartingLine = ({ why, inMs, attempt, of }) =>
  `Laya stopped unexpectedly (${why}); restarting it in ${Math.max(1, Math.ceil(inMs / 1000))} s (attempt ${attempt} of ${of})…`

/**
 * What one line of laya.serve's output says, or null. Laya prints three device lines of its own,
 * one when CUDA is missing at start, one when the model does not fit on the GPU, one when inference
 * on the GPU fails (for any error whose text mentions memory or cuda, so a context broken by sleep
 * prints it too); the temperature warning names the entries it clamped; uvicorn says when the port
 * was taken after the model loaded.
 */
export function parseServeLine(line) {
  const l = String(line)
  if (/CUDA requested but not available\. Falling back to CPU\./.test(l)) return { device: 'cpu', why: 'PyTorch found no usable CUDA when Laya started' }
  if (/could not place the model on \S+, so it is running on CPU/.test(l)) return { device: 'cpu', why: 'the model could not be placed on the GPU', placing: true }
  if (/GPU memory exceeded during inference\. Falling back to CPU/.test(l)) return { device: 'cpu', why: LAYA_TEXT.gpuFailed }
  const temps = /ships invalid temperatures.*?; using (.+?)\. Treat confidence/.exec(l)
  if (temps) return { warning: { kind: 'temperatures', entries: temps[1].split(/,\s*/), text: LAYA_TEXT.temperatures } }
  if (/address already in use/i.test(l)) return { bind: true }
  const reason = /^\s*Reason:\s*(.+)$/.exec(l)
  if (reason) return { reason: reason[1].split(/\.\s/)[0].replace(/\.$/, '') }
  return null
}

/** The executable path and command line of a running process, or null. */
export async function processInfo(pid, { platform = process.platform, run = execText } = {}) {
  if (platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { "$($_.ExecutablePath)|$($_.CommandLine)" }`])
    const line = String(out ?? '').split(/\r?\n/).find((l) => l.includes('|'))
    if (!line) return null
    const i = line.indexOf('|')
    return { exe: line.slice(0, i).trim(), cmdline: line.slice(i + 1).trim() }
  }
  try {
    return { exe: await readlink(`/proc/${pid}/exe`), cmdline: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ') }
  } catch {
    const args = String((await run('ps', ['-p', String(pid), '-o', 'args='])) ?? '').trim()
    return args ? { exe: args.split(/\s+/)[0], cmdline: args } : null
  }
}

/**
 * On Windows a venv's python.exe can be a redirector that starts the base interpreter as its
 * child, and the model lives in that child: its pid is the one to read RAM from and set priority
 * on. Elsewhere, and when no python.exe child is found, the spawned process is the interpreter.
 */
export async function findInterpreter(pid, { platform = process.platform, run = execText } = {}) {
  if (platform !== 'win32') return null
  const out = await run('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)" }`])
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const [child, name, exe] = line.trim().split('|')
    if (/^pythonw?\.exe$/i.test(name ?? '') && Number(child) > 0) return { pid: Number(child), path: exe || null }
  }
  return null
}

/** Whether `path` lies under `dir`, compared as Windows compares paths there. */
const under = (path, dir, platform) => {
  if (!path) return false
  const norm = (p) => (platform === 'win32' ? p.replaceAll('/', '\\').toLowerCase() : resolve(p))
  const d = norm(dir).replace(/[\\/]+$/, '')
  return norm(path).startsWith(d + (platform === 'win32' ? '\\' : sep))
}

const SETTINGS = {
  startWithKzh: { ok: (v) => typeof v === 'boolean', why: 'Start Laya when KzH starts: true or false' },
  keepLoaded: { ok: (v) => typeof v === 'boolean', why: 'Keep Laya loaded: true or false' },
  idleMinutes: { ok: (v) => Number.isInteger(v) && v >= 1 && v <= 240, why: 'Unload after idle: whole minutes 1-240' },
  device: { ok: (v) => ['auto', 'gpu', 'cpu'].includes(v), why: "Device: 'auto', 'gpu' or 'cpu'" },
  shadow: { ok: (v) => typeof v === 'boolean', why: 'Answer beside Jev in Jev Auto: true or false' },
}
const DEFAULT_SETTINGS = Object.freeze({ startWithKzh: false, keepLoaded: false, idleMinutes: 30, device: 'auto', shadow: true })
const PHASES = ['intent', 'route', 'review']
const emptyDevice = (vram) => ({ identity: null, msPerToken: { intent: null, route: null, review: null }, ramGB: null, ...(vram ? { vramGB: null } : {}), loadMs: [] })
/** The EWMA weight of a new ms-per-token reading (4.5). */
const ALPHA = 0.3
/** How many exits of a ready sidecar within `crashWindowMs` are restarted. */
const RESTARTS = 3
const PORT_TRIES = 20
const LOG_MAX_BYTES = 5 * 1024 * 1024
const STOP_REASONS = { idle: 'idle', budget: 'budget', yielded: 'yielded' }
/** The holds that are not a Laya Auto run: Keep Laya loaded, and Test Laya while it runs (7.6). */
const NOT_RUNS = new Set(['keepLoaded', 'selftest'])
/** route() holds by its run id (2.4); kept as `run:<runId>`, as the status of 8.4 lists it. */
const holdKey = (key) => (NOT_RUNS.has(key) || String(key).startsWith('run:') ? key : `run:${key}`)

/**
 * @param {object} p
 * @param {string} p.harnessDir
 * @param {string} p.dataDir      the plugin's data folder, ~/.kzh/jev-router
 * @param {object} p.config       config.laya as providers.js validated it
 * @param {string|null} [p.configError]  providers.js's layaError: the settings are invalid
 * @param {object} p.pins         config/laya.json (laya-install.js readPins)
 * @param {() => Promise<object|null>} [p.specs]  detectSpecs() for this PC
 * @param {object} [p.residency]  createResidency(), shared with local.js
 * @param {() => Promise<{ maxRamGB?, maxVramGB?, maxCores? }>} [p.readBudget]  the resource budget (local.readSettings)
 * @param {(connection) => object} p.probe  laya-selfcheck.js createProbe, for the warm-up and the install check
 * @param {() => boolean} [p.isLocalBusy]  local.isBusy(): a local model request is in flight
 * @param {() => boolean} [p.isBusy]  the Laya client's gate: a request is on the wire to Laya
 */
export function createLayaSidecar({
  harnessDir, dataDir, config, configError = null, pins, specs = async () => null, residency = null,
  readBudget = async () => ({}), probe, isLocalBusy = () => false, isBusy = () => false,
  spawn = nodeSpawn, fetch = globalThis.fetch, run = execText, log = () => {}, now = Date.now, onChange = () => {},
  platform = process.platform, killTree = defaultKillTree, readWorkingSet = workingSetOf, setPriority = osSetPriority,
  isAlive = pidAlive, timing = {},
}) {
  const cfg = config ?? {}
  const enabled = cfg.enabled !== false
  const basePort = cfg.port ?? 8091
  const startWaitMs = cfg.deadlines?.startWaitMs ?? 300_000
  const hardMs = cfg.deadlines?.hardMs ?? 270_000
  const T = {
    readyPollMs: 500, healthTimeoutMs: 2000, healthEveryMs: 30_000, healthMissTimeoutMs: 10_000, healthMisses: 3,
    backoffMs: [0, 10_000, 60_000], crashWindowMs: 600_000, minuteMs: 60_000, idleCheckMs: 5000, waitLineMs: 5000, exitWaitMs: 15_000,
    ...timing,
  }
  const paths = layaPaths({ harnessDir, dataDir, platform })
  const readJsonSync = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

  // --- what is on disk, cached: status() answers at once ---
  let installedInfo = null
  let weightsInfo = null
  let folderBytes = null // { engine, models }: what each of Laya's folders holds on disk
  function reloadInstalled() {
    installedInfo = existsSync(paths.pythonOf(paths.venv)) ? readJsonSync(paths.installed) : null
    weightsInfo = readJsonSync(paths.weights)
  }
  reloadInstalled()

  // --- laya.json: the per-PC settings, the measurements and the last Test Laya ---
  const stored = readJsonSync(paths.settings) ?? {}
  const settings = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((k) => k in stored && SETTINGS[k].ok(stored[k])).map((k) => [k, stored[k]])) }
  const measured = { cpu: { ...emptyDevice(false), ...stored.measured?.cpu }, cuda: { ...emptyDevice(true), ...stored.measured?.cuda } }
  let lastSelfTest = stored.lastSelfTest ?? null
  let saving = Promise.resolve()
  function persist() {
    saving = saving.then(async () => {
      await mkdir(dataDir, { recursive: true })
      await writeFile(`${paths.settings}.tmp`, JSON.stringify({ ...settings, measured, lastSelfTest }, null, 2))
      await rename(`${paths.settings}.tmp`, paths.settings)
    }).catch((err) => log(`laya: laya.json not saved: ${err.message}`))
    return saving
  }

  // --- the run state ---
  let state = 'stopped' // stopped | starting | ready | restarting | failed | stopping
  let proc = null
  let checkProc = null // the install check's laya.serve (7.2 step 7), while it runs
  let failure = null // { reason, lines }
  let stoppedBecause = null
  let why = null
  let orphanStopped = null
  let restartInfo = null
  let restartAt = null // when the pending restart after an unexpected exit begins
  let lastRestart = null // { kind, why, at }, and an exit's code and signal: the last restart the supervisor made on its own (7.5)
  const warnings = []
  const holds = new Set(settings.keepLoaded ? ['keepLoaded'] : [])
  let crashes = []
  let starting = null
  let stopping = null
  let restartPending = null
  let currentStart = null
  let suspended = null
  let install = null
  // Set for good by dispose(): nothing starts or restarts Laya afterwards, however it was chained.
  let disposed = false
  let priority = 'normal'
  let priorityWarned = false
  let fails500 = 0
  let fails401 = 0
  let busySince = null
  let lastActive = null
  let misses = 0
  let lastCallMs = null
  let spills = 0
  const timers = { restart: null, idle: null, health: null }
  const reserved = new Set()
  const avoid = new Set()
  let portLock = Promise.resolve()
  const tail = [] // { at, text }

  const runHeld = () => [...holds].some((k) => k.startsWith('run:'))
  const changed = () => { try { onChange({ state: publicState() }) } catch (err) { log(`laya: ${err.message}`) } }
  const setState = (s) => { if (state === s) return; state = s; changed() }
  const measureKey = () => `laya-${installedInfo?.laya ?? '?'}|english|${String(weightsInfo?.commit ?? '?').slice(0, 12)}|adapter-${ADAPTER_VERSION}`
  const ramNeedGB = (device) => measured[device]?.ramGB ?? pins.ramEstimateGB?.[device] ?? (device === 'cpu' ? 3.3 : 1.5)
  const vramNeedGB = () => measured.cuda.vramGB ?? pins.vramEstimateGB ?? 2.5
  const lastLoadMs = (device) => measured[device]?.loadMs?.at(-1) ?? null

  function unavailable() {
    if (disposed) return new LayaUnavailable('Laya was stopped with KzH', { reason: 'disposed' })
    if (!installedInfo) return new LayaUnavailable(LAYA_TEXT.notInstalled, { reason: 'not_installed' })
    if (!enabled) return new LayaUnavailable(LAYA_TEXT.disabled, { reason: 'disabled' })
    if (configError) return new LayaUnavailable(LAYA_TEXT.invalid(configError), { reason: 'invalid', detail: configError })
    return null
  }

  function publicState() {
    if (configError || !enabled) return 'disabled'
    if (install && !install.done && !install.error && !install.finishedAt && ['install', 'update', 'repair'].includes(install.kind)) return 'installing'
    // A failed install or update over one that is there reads as that install's own state once it
    // runs again (7.4); its error stays in status().install until the next job (7.10).
    if (install?.error && ['install', 'update'].includes(install.kind) && (!installedInfo || state === 'stopped')) return 'install_failed'
    if (!installedInfo) return 'not_installed'
    return state
  }

  // --- the log: laya-serve.log (rotated at 5 MB, two kept) and the tail kept in memory ---
  const serveLog = createRotatingLog(paths.serveLog, { maxBytes: LOG_MAX_BYTES })
  const appendLog = (text) => serveLog.append(text)

  function onLine(p, line) {
    if (!line.trim()) return
    p.lines.push(line)
    if (p.lines.length > 60) p.lines.shift()
    if (p.main) {
      tail.push({ at: now(), text: line })
      if (tail.length > 500) tail.shift()
    }
    appendLog(`${line}\n`)
    const got = parseServeLine(line)
    if (!got) return
    if (got.bind) p.bind = true
    if (got.warning && !warnings.some((w) => w.kind === got.warning.kind)) { warnings.push(got.warning); changed() }
    if (got.reason && p.placing) { p.deviceWhy = `${p.deviceWhy} (${got.reason})`; p.placing = false; if (p.main) changed() }
    if (got.device && p.device !== got.device) {
      p.device = got.device
      p.deviceWhy = got.why
      p.placing = !!got.placing
      if (p.main) { log(`laya: now on the CPU: ${got.why}`); changed() }
    }
  }

  const lineSplitter = (each) => {
    let buf = ''
    return (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) { each(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1) }
    }
  }

  // --- ports (7.8): one allocator for the main sidecar and the install check ---
  function reservePort() {
    const got = portLock.then(async () => {
      for (let port = basePort; port < basePort + PORT_TRIES; port++) {
        if (reserved.has(port) || avoid.has(port)) continue
        if (await freePort(port, 1).then(() => true, () => false)) { reserved.add(port); return port }
      }
      throw new Error(`no free port for Laya in ${basePort}-${basePort + PORT_TRIES - 1}`)
    })
    portLock = got.catch(() => {})
    return got
  }
  const freePortReservation = (port) => { reserved.delete(port) }

  // --- the GPU ---
  async function gpuMemory() {
    const out = await run('nvidia-smi', ['--query-gpu=memory.free,memory.used,memory.total,name', '--format=csv,noheader,nounits'])
    const first = String(out ?? '').split('\n').map((l) => l.trim()).find(Boolean)
    if (!first) return null
    const [free, used, total, ...name] = first.split(',').map((x) => x.trim())
    if (![free, used, total].every((x) => x !== '' && Number.isFinite(Number(x)))) return null
    return { freeGB: Number(free) / 1024, usedGB: Number(used) / 1024, totalGB: Number(total) / 1024, name: name.join(',') }
  }

  /**
   * Whether Laya fits on the GPU now (7.7), and if not, why, with the numbers. `torchCuda` is
   * whether the PyTorch it runs has CUDA: the installed one's, or for the install check the new one's.
   */
  async function gpuRoom({ torchCuda = !!installedInfo?.cuda } = {}) {
    if (!torchCuda) return { ok: false, why: `PyTorch was installed for the CPU`, cpuInstall: true }
    const smi = await gpuMemory()
    if (!smi) return { ok: false, why: 'nvidia-smi did not answer, so the GPU memory is unknown' }
    const need = vramNeedGB()
    if (smi.freeGB < need + 0.3) return { ok: false, why: `the GPU had ${r1(smi.freeGB)} GB free and Laya needs about ${need} GB` }
    const { maxVramGB = null } = await readBudget().catch(() => ({}))
    if (maxVramGB != null) {
      const others = residency?.othersVramGB('laya') ?? 0
      if (others + need > maxVramGB) {
        const names = residency?.othersNames('laya') ?? []
        return { ok: false, why: `the VRAM budget of ${maxVramGB} GB${others ? ` holds ${others} GB for ${names.join(' and ')}, and` : ' is under what'} Laya needs about ${need} GB` }
      }
    }
    return { ok: true, gpu: smi.name }
  }

  /** The device for a start: `asked` is the setting (or a restart's override). */
  async function chooseDevice(asked) {
    if (asked === 'cpu') return { device: 'cpu', why: null }
    const room = await gpuRoom()
    if (room.ok) return { device: 'cuda', why: null, gpu: room.gpu }
    // An install for the CPU runs on the CPU by its nature, not as a fallback.
    if (room.cpuInstall) return { device: 'cpu', why: null }
    if (asked === 'gpu' || asked === 'cuda') throw new StartFailed(`Laya is set to run on the GPU, and ${room.why}`, { refused: true })
    return { device: 'cpu', why: room.why }
  }

  /** Laya never unloads llama to fit the RAM budget: it refuses to start instead (7.7). */
  async function checkRam(device) {
    const { maxRamGB = null } = await readBudget().catch(() => ({}))
    if (maxRamGB == null) return
    const need = ramNeedGB(device)
    const others = residency?.othersRamGB('laya') ?? 0
    if (need + others <= maxRamGB) return
    const names = residency?.othersNames('laya') ?? []
    if (!names.length) throw new StartFailed(`Laya needs about ${need} GB of RAM; the RAM budget is ${maxRamGB} GB. Raise the RAM budget.`, { refused: true })
    throw new StartFailed(`Laya needs about ${need} GB of RAM; the budget leaves ${r1(Math.max(0, maxRamGB - others))} GB beside ${names.join(' and ')}. Stop the local model or raise the RAM budget.`, { refused: true })
  }

  async function threadsFor() {
    const { maxCores = null } = await readBudget().catch(() => ({}))
    const cpu = (await specs().catch(() => null))?.cpu ?? { cores: null, threads: cpus().length }
    // A core budget is a cap: never more threads than the machine has, as llama.cpp's are counted.
    return maxCores == null ? defaultThreads(cpu) : Math.min(maxCores, cpu.threads || cpus().length)
  }

  // --- one laya.serve process ---

  /** Every TYPESAFE_* variable and the Hugging Face token go: nothing of the person's secrets reaches the child. */
  function childEnv({ port, key, device, threads }) {
    return Object.assign(withoutSecrets(), {
      LAYA_HOST: '127.0.0.1', LAYA_PORT: String(port), LAYA_API_KEY: key, LAYA_MODELS: 'english', LAYA_PRELOAD: '1',
      LAYA_DEVICE: device, LAYA_THREADS: String(threads), LAYA_AUTO_TASK: '0', LAYA_LOG_LEVEL: 'warning',
      HF_HOME: paths.hf, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      TOKENIZERS_PARALLELISM: 'false',
    })
  }

  async function launch({ venv, port, device, threads, main }) {
    const key = randomBytes(24).toString('hex')
    // Laya's Agent reads `convaiinnovations/laya` as a local path whenever that relative path
    // exists, so it runs from a folder that is always empty.
    await rm(paths.run, { recursive: true, force: true })
    await mkdir(paths.run, { recursive: true })
    const exe = paths.pythonOf(venv)
    const child = spawn(exe, ['-I', '-u', '-X', 'utf8', '-m', 'laya.serve'], { cwd: paths.run, env: childEnv({ port, key, device, threads }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const p = {
      child, pid: child.pid, interpreterPid: child.pid, interpreterPath: exe, port, key, device, deviceWhy: null, threads, main,
      startedAt: now(), loadMs: null, lines: [], exited: null, expected: false, bind: false, placing: false, spilling: false, measuring: false,
    }
    appendLog(`--- ${new Date(now()).toISOString()} laya.serve starting on 127.0.0.1:${port} (${device}, ${threads} threads)\n`)
    p.exit = new Promise((done) => {
      const end = (code, signal, error) => { if (p.exited) return; p.exited = { code, signal, error }; done(p.exited) }
      child.once('exit', (code, signal) => end(code, signal, null))
      child.once('error', (err) => { p.lines.push(err.message); end(null, null, err.message) })
    })
    child.stdout?.on('data', lineSplitter((l) => onLine(p, l)))
    child.stderr?.on('data', lineSplitter((l) => onLine(p, l)))
    p.exit.then(() => freePortReservation(p.port))
    return p
  }

  const describeExit = (e) => (e?.error ? e.error : e?.code != null ? `exit code ${e.code}` : `signal ${e?.signal ?? 'unknown'}`)
  const connOf = (p) => ({ url: `http://127.0.0.1:${p.port}`, key: p.key, device: p.device, pid: p.interpreterPid })

  async function health(p, timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  /** Stop one process tree and wait until both its pids have exited, not only until the kill returns. */
  async function kill(p) {
    p.expected = true
    killTree(p.pid)
    if (p.interpreterPid !== p.pid) killTree(p.interpreterPid)
    // The bound goes once the process has exited: a timer left behind would hold a stopping
    // engine's process open for exitWaitMs after every stop, restart and dispose.
    let bound
    await Promise.race([p.exit, new Promise((r) => { bound = setTimeout(r, T.exitWaitMs) })])
    clearTimeout(bound)
    for (const deadline = Date.now() + T.exitWaitMs; p.interpreterPid !== p.pid && isAlive(p.interpreterPid) && Date.now() < deadline;) await sleep(100)
  }

  /**
   * Until the child is ready: alive, /health says the English checkpoint is loaded, and `confirm`
   * (the warm-up, or the install check's protocol calls) is answered with this start's key. A 401
   * there is another server on the port, never this child: waited out, since this child then fails
   * to bind and exits, which is a bind failure the caller retries on the next port.
   */
  async function untilReady(p, { boundMs, confirm, cancelled = () => false }) {
    const deadline = now() + boundMs
    let interpreter = false
    for (;;) {
      if (p.exited) {
        if (p.expected || cancelled()) throw new StartFailed('it was stopped', { stopped: true })
        throw new StartFailed(`laya.serve exited before it was ready (${describeExit(p.exited)})`, { lines: p.lines.slice(-20), bind: p.bind })
      }
      if (p.expected || cancelled()) throw new StartFailed('it was stopped', { stopped: true })
      if (now() >= deadline) {
        await kill(p)
        throw new StartFailed(`laya.serve was not ready after ${Math.round(boundMs / 1000)} s`, { lines: p.lines.slice(-20) })
      }
      const h = await health(p, T.healthTimeoutMs)
      if (h?.status === 'ok' && Array.isArray(h.loaded) && h.loaded.includes('english') && !p.exited) {
        if (!interpreter) {
          interpreter = true
          const found = await findInterpreter(p.pid, { platform, run }).catch(() => null)
          if (found) { p.interpreterPid = found.pid; p.interpreterPath = found.path ?? p.interpreterPath }
        }
        const r = await confirm(connOf(p))
        if (r.ok) return r
        if (r.status !== 401) {
          if (p.exited && (p.expected || cancelled())) throw new StartFailed('it was stopped', { stopped: true })
          throw new StartFailed(r.why, { lines: p.lines.slice(-20) })
        }
      }
      await Promise.race([sleep(T.readyPollMs), p.exit])
    }
  }

  /** Fold one measured figure into the device's ms-per-token for a phase (an EWMA, alpha 0.3). */
  function fold(device, phase, perToken) {
    const m = measured[device].msPerToken
    m[phase] = m[phase] == null ? r4(perToken) : r4(m[phase] + ALPHA * (perToken - m[phase]))
  }

  /**
   * The warm-up of 7.5: Test Laya's two intent probes on every start, which pay CUDA initialisation
   * before the first real call; on the first start per device and identity also the maximal route
   * and review, which measure every phase and the memory peaks the budget reads.
   */
  async function warmUp(p, conn, vramBefore) {
    const key = measureKey()
    const m = measured[p.device]
    if (m.identity !== key) Object.assign(m, emptyDevice(p.device === 'cuda'), { identity: key, loadMs: m.loadMs ?? [] })
    const full = PHASES.some((ph) => m.msPerToken[ph] == null)
    p.measuring = full
    if (full) changed()
    const r = await probe(conn).warmUp({ full })
    if (!r.ok) return { ok: false, status: r.status, why: `the warm-up failed: ${r.error ?? r.problems?.[0] ?? 'no answer'}` }
    // The first intent probe paid the CUDA initialisation; it says nothing about a call's cost.
    for (const c of r.calls.slice(1)) if (c.tokens > 0) fold(p.device, c.phase, c.ms / c.tokens)
    const ram = await readWorkingSet(p.interpreterPid).catch(() => null)
    if (ram != null && full) m.ramGB = r2(ram / GB)
    if (p.device === 'cuda' && vramBefore != null && full) {
      const after = (await gpuMemory())?.usedGB
      if (after != null && after > vramBefore) m.vramGB = r2(after - vramBefore)
    }
    return { ok: true, full }
  }

  /**
   * sidecar.json: the pids of every laya.serve this engine runs, the sidecar's and an install
   * check's (`check`), so the next session's orphan sweep finds whichever a crash left behind; gone
   * once neither runs. Written in turn, so the last write says what runs now; a write that fails
   * rejects for its caller alone.
   */
  let recording = Promise.resolve()
  function writeSidecarJson() {
    const write = recording.then(async () => {
      const entry = (p) => (p && !p.exited ? { pid: p.pid, interpreterPid: p.interpreterPid, interpreterPath: p.interpreterPath, port: p.port, startedAt: new Date(p.startedAt).toISOString() } : null)
      const main = entry(proc)
      const check = entry(checkProc)
      if (!main && !check) { await rm(paths.sidecarJson, { force: true }); return }
      await mkdir(paths.logDir, { recursive: true })
      await writeFile(paths.sidecarJson, JSON.stringify({ ...main, ...(check ? { check } : {}) }))
    })
    recording = write.catch(() => {})
    return write
  }

  function setFailed(reason, lines = []) {
    failure = { reason, lines }
    why = reason
    clearTimers()
    setState('failed')
    log(`laya: failed: ${reason}`)
  }
  const clearTimers = () => { for (const k of Object.keys(timers)) { clearTimeout(timers[k]); clearInterval(timers[k]); timers[k] = null } }

  // --- the start ---

  async function startOnce({ reason, device: asked }) {
    const refuse = unavailable()
    if (refuse) throw refuse
    const me = { cancelled: false }
    currentStart = me
    stoppedBecause = null
    why = null
    failure = null
    const wasRestart = state === 'restarting'
    setState('starting')
    if (!wasRestart) restartInfo = null
    let mine = null // the process this start launched
    try {
      // An install or update swapping the venv in: this start waits until it is done.
      if (suspended) await suspended.promise
      if (me.cancelled) throw new StartFailed('it was stopped', { stopped: true })
      await sweepOrphans()
      const dev = await chooseDevice(asked ?? settings.device)
      await checkRam(dev.device)
      const w = await verifyWeights(paths, { platform, log })
      if (!w.ok) throw new StartFailed(w.why)
      weightsInfo = w.record
      const threads = await threadsFor()
      const vramBefore = dev.device === 'cuda' ? (await gpuMemory())?.usedGB ?? null : null
      for (let attempt = 0; ; attempt++) {
        if (me.cancelled) throw new StartFailed('it was stopped', { stopped: true })
        const port = await reservePort()
        // Stopped or disposed while the port was found: nothing is launched.
        if (me.cancelled) { freePortReservation(port); throw new StartFailed('it was stopped', { stopped: true }) }
        const p = await launch({ venv: paths.venv, port, device: dev.device, threads, main: true })
        mine = p
        p.deviceWhy = dev.why
        p.gpu = dev.gpu ?? null
        proc = p
        p.exit.then(() => onExit(p))
        await writeSidecarJson()
        log(`laya: starting on 127.0.0.1:${port}, ${dev.device}${dev.why ? ` (${dev.why})` : ''}, ${threads} threads (${reason})`)
        changed()
        try {
          const warm = await untilReady(p, { boundMs: startWaitMs, confirm: (conn) => warmUp(p, conn, vramBefore), cancelled: () => me.cancelled })
          await writeSidecarJson()
          // The warm-up's last readings (the working set, the GPU's memory) and that write take a
          // moment after the last answer, and a Stop or an exit in it is this start's to report:
          // the exit handler leaves a start in progress alone. Nothing awaits between here and ready.
          if (me.cancelled || p.expected) throw new StartFailed('it was stopped', { stopped: true })
          if (p.exited) throw new StartFailed(`laya.serve exited before it was ready (${describeExit(p.exited)})`, { lines: p.lines.slice(-20) })
          ready(p, warm)
          return connOf(p)
        } catch (err) {
          // A port taken between the reservation and laya.serve's bind, which it does only after
          // the model loaded: once more, on the next port, not counted as a failure.
          if (err.bind && attempt === 0 && !me.cancelled) {
            avoid.add(port)
            if (proc === p) proc = null
            log(`laya: port ${port} was taken before laya.serve could bind it; trying the next port`)
            continue
          }
          throw err
        }
      }
    } catch (err) {
      if (err instanceof LayaUnavailable) { setState('stopped'); throw err }
      // Whatever this start launched and did not bring up goes, whether it failed or was stopped.
      if (mine && !mine.exited) await kill(mine)
      if (proc === mine && mine) proc = null
      if (err.stopped || me.cancelled) throw new StartFailed('it was stopped', { stopped: true })
      // The RAM budget or a GPU with no room turned it down before anything ran: stopped, with the
      // reason, so it starts once there is room without the person pressing Start.
      if (err.refused) {
        why = err.message
        setState('stopped')
        log(`laya: not started: ${err.message}`)
        throw err
      }
      setFailed(err.message, err.lines?.length ? err.lines : mine?.lines.slice(-20) ?? [])
      throw err
    } finally {
      if (currentStart === me) currentStart = null
    }
  }

  function ready(p, warm) {
    // The intervals armed below replace any an earlier start left, never run beside them.
    clearTimers()
    p.loadMs = now() - p.startedAt
    p.measuring = false
    const m = measured[p.device]
    m.loadMs = [...(m.loadMs ?? []), p.loadMs].slice(-10)
    persist()
    fails500 = 0
    fails401 = 0
    misses = 0
    busySince = null
    // Held only by the holds of 7.6; busy only while an acting request has raised it to normal
    // priority (4.5), so a background comparison never keeps it from giving way.
    p.resident = residency?.set('laya', {
      pid: p.interpreterPid, startedAt: p.startedAt, device: p.device, name: 'Laya', keepWhileHeld: true,
      held: () => holds.size > 0, busy: () => priority === 'normal',
      ramGB: () => ramNeedGB(p.device), vramGB: () => (p.device === 'cuda' ? vramNeedGB() : 0),
      unload: (w) => unloadFor(p, w),
    }) ?? null
    setPriorityLevel('below_normal')
    setState('ready')
    const mem = p.device === 'cuda' ? `${m.vramGB ?? vramNeedGB()} GB VRAM` : `${m.ramGB ?? ramNeedGB('cpu')} GB RAM`
    log(`laya: ready in ${r1(p.loadMs / 1000)} s on ${p.device} (${p.device === 'cuda' ? p.gpu ?? 'GPU' : `${p.threads} threads`}), ${mem}${warm?.full ? ', measured' : ''}`)
    timers.health = setInterval(() => { healthTick(p).catch((err) => log(`laya: health check: ${err.message}`)) }, T.healthEveryMs)
    timers.health.unref?.()
    touchIdle()
    timers.idle = setInterval(idleCheck, T.idleCheckMs)
    timers.idle.unref?.()
  }

  function onExit(p) {
    if (p.resident) residency?.clear('laya', p.resident)
    if (disposed || p !== proc || p.expected) return
    if (state !== 'ready') return // a start in progress reports its own failure
    proc = null
    clearTimers()
    const at = now()
    crashes = [...crashes.filter((t) => at - t < T.crashWindowMs), at]
    const what = describeExit(p.exited)
    if (crashes.length > RESTARTS) {
      setFailed(`laya.serve exited ${crashes.length} times in ${Math.round(T.crashWindowMs / 60_000)} minutes (last: ${what})`, p.lines.slice(-20))
      restartPending?.reject(new StartFailed(failure.reason))
      restartPending = null
      return
    }
    const n = crashes.length
    restartInfo = { attempt: n, of: RESTARTS, code: p.exited.code ?? null, signal: p.exited.signal ?? null }
    why = what
    // The exit itself rides along: a call it cut off says which, after the backoff has ended too.
    lastRestart = { kind: 'exit', why: what, at, code: restartInfo.code, signal: restartInfo.signal }
    restartPending = deferred()
    setState('restarting')
    log(`laya: exited (${p.exited.code != null ? `code ${p.exited.code}` : what}); restarting (${n} of ${RESTARTS})`)
    const pause = T.backoffMs[n - 1] ?? T.backoffMs.at(-1)
    restartAt = at + pause
    timers.restart = setTimeout(runRestart, pause)
  }

  function runRestart() {
    timers.restart = null
    const pending = restartPending
    // A start that fails here sets `failed` and does not enter the backoff again.
    starting = startOnce({ reason: 'restart' }).finally(() => { starting = null })
    starting.then((c) => pending?.resolve(c), (e) => pending?.reject(e))
    if (restartPending === pending) restartPending = null
    starting.catch(() => {})
  }

  /** Start it, or join the start, restart or stop already under way. Resolves the connection once ready. */
  function start({ reason = 'user', device } = {}) {
    const refuse = unavailable()
    if (refuse) return Promise.reject(refuse)
    // The person pressing Start is what clears a failure, a restart already seen, and a failed
    // install's error; the installer starting the old Laya again after a failed update keeps it.
    if (state === 'failed') { failure = null; why = null; crashes = []; setState('stopped') }
    if (reason === 'user') { lastRestart = null; if (install?.error) install = null }
    if (starting) {
      // A start Stop cancelled is only unwinding: this one begins once it has, as from stopped.
      if (currentStart?.cancelled) return starting.catch(() => {}).then(() => start({ reason, device }))
      return starting
    }
    if (state === 'ready' && proc) return Promise.resolve(connOf(proc))
    if (state === 'restarting' && restartPending) {
      const pending = restartPending.promise
      if (reason === 'user') { clearTimeout(timers.restart); runRestart() }
      return pending
    }
    if (state === 'stopping' && stopping) return stopping.then(() => start({ reason, device }))
    starting = startOnce({ reason, device }).finally(() => { starting = null })
    starting.catch(() => {})
    return starting
  }

  // --- the stop ---

  function stop({ reason = 'user', why: because = null } = {}) {
    // An open Laya Auto run keeps a Laya that is starting or ready (7.4); a crash backoff ends
    // whoever holds it.
    if (reason === 'user' && runHeld() && (state === 'starting' || state === 'ready')) return Promise.reject(new Error(LAYA_TEXT.stopWhileHeld))
    if (reason === 'user') lastRestart = null
    if (stopping) return stopping
    clearTimeout(timers.restart)
    timers.restart = null
    const record = () => {
      stoppedBecause = STOP_REASONS[reason] ?? null
      why = reason === 'budget' || reason === 'yielded' ? because : null
    }
    if (state === 'restarting') {
      restartPending?.reject(new StartFailed('it was stopped', { stopped: true }))
      restartPending = null
      restartInfo = null
      record()
      setState('stopped')
      return Promise.resolve()
    }
    if (currentStart) currentStart.cancelled = true
    const p = proc
    if (!p) {
      if (state === 'starting') { record(); setState('stopped') }
      return Promise.resolve()
    }
    setState('stopping')
    stopping = (async () => {
      clearTimers()
      if (p.resident) residency?.clear('laya', p.resident)
      await kill(p)
      if (proc === p) proc = null
      await writeSidecarJson().catch(() => {})
      record()
      setState('stopped')
      log(`laya: stopped (${reason === 'yielded' ? `unloaded so ${because} could have the GPU and RAM` : reason === 'budget' ? `the resource budget: ${because}` : reason})`)
    })().finally(() => { stopping = null })
    return stopping
  }

  /** The residency's unload: for the watchdog (the budget) or for a local model starting (a yield). */
  async function unloadFor(p, w) {
    if (proc !== p) return
    await stop({ reason: w?.kind === 'yield' ? 'yielded' : 'budget', why: w?.kind === 'yield' ? w.for : w?.text ?? null })
  }

  async function restartFor(kind, text) {
    if (state !== 'ready' || !proc) return
    const port = proc.port
    log(`laya: ${text}`)
    // Kept apart from `why`, which the start clears, so the card can say why it was restarted (7.5).
    lastRestart = { kind, why: text, at: now() }
    await stop({ reason: 'restart' })
    // A server answering this port with another key is not this child: start on another port.
    if (kind === 'unauthorized') avoid.add(port)
    await start({ reason: kind }).catch(() => {})
  }

  // --- while ready ---

  async function healthTick(p) {
    if (proc !== p || state !== 'ready') return
    if (isBusy()) {
      busySince ??= now()
      if (now() - busySince > hardMs) { busySince = null; await restartFor('hung', LAYA_TEXT.hung(Math.round(hardMs / 1000))); return }
    } else busySince = null
    const h = await health(p, T.healthMissTimeoutMs)
    if (proc !== p || state !== 'ready') return
    if (h?.status === 'ok') { misses = 0; return }
    // The gate knows the server is busy, and hardMs covers a hung inference: a below-normal Python
    // thread beside llama.cpp can take seconds to answer /health while it computes.
    if (isBusy()) return
    if (++misses >= T.healthMisses) { misses = 0; await restartFor('health', `laya.serve did not answer /health ${T.healthMisses} times in a row; restarting`) }
  }

  /** An acting request, a Test Laya or the end of the last hold: the idle countdown starts again. */
  function touchIdle() { lastActive = now() }

  /**
   * The idle stop (7.6), checked every `idleCheckMs` against the clock: after `idleMinutes` with no
   * acting request and no Test Laya, and never while held or while an acting request is out. A
   * shadow request never counts as activity, so the comparisons alone never keep Laya loaded.
   */
  function idleCheck() {
    if (state !== 'ready' || !proc || holds.size || priority === 'normal') return
    lastActive ??= now()
    if (now() - lastActive < settings.idleMinutes * T.minuteMs) return
    stop({ reason: 'idle' }).catch((err) => log(`laya: idle stop: ${err.message}`))
  }

  function setPriorityLevel(level) {
    if (level !== 'normal' && level !== 'below_normal') throw new Error("laya priority: 'normal' or 'below_normal'")
    priority = level
    const pid = proc?.interpreterPid
    if (!pid) return
    try { setPriority(pid, level === 'normal' ? osConstants.priority.PRIORITY_NORMAL : osConstants.priority.PRIORITY_BELOW_NORMAL) } catch (err) {
      if (!priorityWarned) { priorityWarned = true; log(`laya: could not set the interpreter's priority (${err.code ?? err.message})`) }
    }
  }

  /**
   * After each request: consecutive 500s and 401s, the idle timer (acting requests only), the
   * device's ms-per-token for the phase, and the GPU spill check (7.7). Resolves `{ spilling }`,
   * with the line to show when Laya's GPU memory is spilling into system memory.
   */
  async function noteResult({ status, ms, tokens, phase, role } = {}) {
    const p = proc
    busySince = null
    if (role === 'act') touchIdle()
    if (typeof ms === 'number') lastCallMs = ms
    if (status === 500) {
      if (++fails500 >= 2) {
        fails500 = 0
        const since = now() - (ms ?? 0)
        const said = tail.filter((l) => l.at >= since && !/"(GET|POST) /.test(l.text)).map((l) => l.text.trim())
        await restartFor('500', `two requests in a row failed (${said.length ? said.slice(-3).join(' | ') : 'laya.serve gave no reason'}); restarting`)
      }
      return { spilling: p?.spilling ?? false }
    }
    if (status === 401) {
      if (++fails401 >= 2) { fails401 = 0; await restartFor('unauthorized', 'another server answers on its port; restarting on a fresh port') }
      return { spilling: p?.spilling ?? false }
    }
    if (typeof status === 'number') { fails500 = 0; fails401 = 0 }
    if (!p || status !== 200 || !(tokens > 0) || !(ms >= 0) || !PHASES.includes(phase)) return { spilling: p?.spilling ?? false }
    const before = measured[p.device].msPerToken[phase]
    const perToken = ms / tokens
    // Over three times the device's own figure on the GPU: spilling when dedicated memory is all but
    // full. Judged before the request is folded in, and a spilled one never is: it is not Laya's
    // speed on this device, and folded in, it would raise the figure the next request is judged
    // against, so the warning would clear on the next call while the spill went on (7.7).
    const slow = p.device === 'cuda' && before != null && perToken > 3 * before
    const smi = slow ? await gpuMemory() : null
    const spilled = !!smi && smi.totalGB - smi.usedGB <= 0.3
    if (!spilled) { fold(p.device, phase, perToken); persist() }
    // Only an acting request of the process still running says so.
    if (role !== 'act' || p.device !== 'cuda' || before == null || proc !== p) return { spilling: p.spilling }
    if (spilled) {
      spills++
      if (!p.spilling) { p.spilling = true; log(`laya: ${LAYA_TEXT.spilling}`); changed() }
      return { spilling: true, line: LAYA_TEXT.spilling }
    }
    // The spill is over once an acting request is back under three times the unspilled figure; a
    // slow one with room on the GPU leaves the state as it was.
    if (!slow && p.spilling) { p.spilling = false; changed() }
    return { spilling: slow && p.spilling }
  }

  // --- orphans (7.5) ---

  /**
   * Kill a laya.serve an earlier session left running (an engine crash that skipped the exit
   * hook), the sidecar's or an install check's, from the pids sidecar.json recorded: only a process
   * that is alive, whose executable is under engine/laya (the venv's interpreter, or the base
   * interpreter in engine/laya/python, whose command line names its own path, not the venv's) and
   * whose command line runs laya.serve.
   */
  async function sweepOrphans() {
    const rec = readJsonSync(paths.sidecarJson)
    if (!rec) return []
    const killed = []
    const ours = new Set([proc, checkProc].filter(Boolean).flatMap((p) => [p.pid, p.interpreterPid]))
    for (const pid of new Set([rec.pid, rec.interpreterPid, rec.check?.pid, rec.check?.interpreterPid].filter((x) => Number.isSafeInteger(x) && x > 0))) {
      if (ours.has(pid)) continue
      if (!isAlive(pid)) continue
      const info = await processInfo(pid, { platform, run }).catch(() => null)
      if (!info || !under(info.exe, paths.engine, platform) || !/\blaya\.serve\b/.test(info.cmdline ?? '')) continue
      const bytes = await readWorkingSet(pid).catch(() => null)
      killTree(pid)
      killed.push({ pid, ramGB: bytes == null ? null : r1(bytes / GB) })
    }
    if (!proc) await writeSidecarJson().catch(() => {})
    if (killed.length) {
      orphanStopped = { pid: killed[0].pid, ramGB: killed.some((k) => k.ramGB != null) ? r1(killed.reduce((a, k) => a + (k.ramGB ?? 0), 0)) : null }
      log(`laya: ${LAYA_TEXT.orphan(orphanStopped.pid, orphanStopped.ramGB)}`)
      changed()
    }
    return killed
  }

  // --- the install check (7.2 step 7) ---

  /**
   * The real start of 7.4 from another venv (`venv.new`) on a port from this allocator, then the
   * protocol checks of Test Laya with this start's key, then stop. Refused as a real start is,
   * before anything runs: over the RAM budget beside a local model, or on a GPU with no room, where
   * it would test the wrong device. Recorded in sidecar.json and killed with the engine, as the
   * sidecar is. Registered in the residency, by the real interpreter's pid, as held while it runs,
   * so neither the watchdog nor a local model start takes it away.
   */
  async function checkStart({ venv = paths.venvNew, device = 'cpu' } = {}) {
    let p = null
    let resident = null
    let registered = false
    try {
      // A disposed supervisor has no exit hook to take a check's laya.serve with the engine.
      if (disposed) throw new StartFailed('Laya was stopped with KzH')
      await checkRam(device)
      if (device === 'cuda') {
        const room = await gpuRoom({ torchCuda: true })
        if (!room.ok) throw new StartFailed(`there is no room for Laya on the GPU now: ${room.why}`, { refused: true })
      }
      const threads = await threadsFor()
      for (let attempt = 0; ; attempt++) {
        const port = await reservePort()
        p = await launch({ venv, port, device, threads, main: false })
        checkProc = p
        await writeSidecarJson()
        try {
          await untilReady(p, {
            boundMs: startWaitMs,
            confirm: async (conn) => {
              // The interpreter is known by now: its working set is what the watchdog reads.
              if (!registered) {
                registered = true
                resident = residency?.set('laya-check', {
                  pid: p.interpreterPid, startedAt: p.startedAt, device, name: 'Laya (install check)', keepWhileHeld: true,
                  held: () => true, busy: () => true, ramGB: ramNeedGB(device), vramGB: device === 'cuda' ? vramNeedGB() : 0, unload: async () => {},
                }) ?? null
                await writeSidecarJson()
              }
              const r = await probe(conn).protocol()
              return r.ok ? { ok: true } : { ok: false, status: r.status, why: `the protocol checks failed: ${r.error ?? r.problems?.[0] ?? 'no answer'}` }
            },
          })
          return { ok: true, device: p.device, deviceWhy: p.deviceWhy, loadMs: now() - p.startedAt, problems: [] }
        } catch (err) {
          if (err.bind && attempt === 0) { avoid.add(port); residency?.clear('laya-check', resident); resident = null; registered = false; continue }
          throw err
        }
      }
    } catch (err) {
      return { ok: false, error: err.message, problems: [err.message], lines: err.lines ?? p?.lines.slice(-20) ?? [], device: p?.device ?? device, deviceWhy: p?.deviceWhy ?? null }
    } finally {
      if (p && !p.exited) await kill(p)
      if (resident) residency?.clear('laya-check', resident)
      if (p && checkProc === p) { checkProc = null; await writeSidecarJson().catch(() => {}) }
    }
  }

  // --- waiting for it (3.5) ---

  /**
   * The live lines of a wait for Laya, every waitLineMs, each saying what is happening now: a stop
   * under way to wait out first, the pause before a restart, or the load, timed from when this
   * start's process was launched. In `starting`, `proc` is only ever the process this start launched;
   * in `stopping` it is the one going away, whose age is no load time.
   */
  function waitLines(onWait) {
    if (!onWait) return { ready() {}, stop() {} }
    const expected = () => proc?.device ?? (settings.device === 'cpu' || !installedInfo?.cuda ? 'cpu' : 'cuda')
    const text = () => {
      if (state === 'stopping') return stoppingLine()
      if (state === 'restarting' && restartInfo) return restartingLine({ why: why ?? 'it ended', inMs: (restartAt ?? now()) - now(), attempt: restartInfo.attempt, of: restartInfo.of })
      const device = expected()
      return startingLine({ device, elapsedMs: state === 'starting' && proc ? now() - proc.startedAt : 0, lastMs: lastLoadMs(device) })
    }
    const emit = () => {
      // Ready by now: the ready line follows.
      if (state === 'ready') return
      try { onWait(text()) } catch { /* the caller's line */ }
    }
    emit()
    const t = setInterval(emit, T.waitLineMs)
    t.unref?.()
    return {
      ready() { try { onWait(readyLine({ device: proc?.device, loadMs: proc?.loadMs })) } catch { /* the caller's line */ } },
      stop() { clearInterval(t) },
    }
  }

  /**
   * Before every acting request (and classify): the connection, starting Laya and waiting for it
   * when it is stopped, starting, restarting or stopping, bounded by startWaitMs and the caller's
   * signal, with the line of what it waits for every 5 s through `onWait`. Throws LayaUnavailable
   * with the 3.5 text when it cannot be asked.
   */
  async function ensureReady({ signal, onWait } = {}) {
    const refuse = unavailable()
    if (refuse) throw refuse
    if (state === 'failed') throw new LayaUnavailable(LAYA_TEXT.failed(failure?.reason ?? 'unknown'), { reason: 'failed', detail: failure?.reason ?? null })
    if (state === 'ready' && proc) { touchIdle(); return connOf(proc) }
    signal?.throwIfAborted()
    const t0 = now()
    const lines = waitLines(onWait)
    let timer = null
    let onAbort = null
    try {
      const got = start({ reason: 'ensureReady' })
      got.catch(() => {})
      const bound = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new LayaUnavailable(LAYA_TEXT.stillStarting(Math.round((now() - t0) / 1000) || Math.round(startWaitMs / 1000)), { reason: 'start_timeout' })), startWaitMs)
      })
      const aborted = new Promise((_, reject) => { if (signal) { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }) } })
      const conn = await Promise.race([got, bound, aborted])
      lines.ready()
      touchIdle()
      return conn
    } catch (err) {
      if (err instanceof LayaUnavailable || (signal?.aborted && err === signal.reason)) throw err
      if (err?.refused) throw new LayaUnavailable(LAYA_TEXT.refused(err.message), { reason: 'refused', detail: err.message })
      throw new LayaUnavailable(LAYA_TEXT.couldNotStart(err.message), { reason: 'start_failed', detail: err.message })
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
      lines.stop()
    }
  }

  // --- settings ---

  function publicSettings() { return { ...settings } }

  async function setSettings(patch = {}) {
    for (const k of Object.keys(patch)) if (!SETTINGS[k]) throw new Error(`${k} is not a Laya setting`)
    for (const [k, rule] of Object.entries(SETTINGS)) if (patch[k] !== undefined && !rule.ok(patch[k])) throw new Error(rule.why)
    for (const k of Object.keys(SETTINGS)) if (patch[k] !== undefined) settings[k] = patch[k]
    if (settings.keepLoaded) holds.add('keepLoaded')
    else if (holds.delete('keepLoaded') && !holds.size) touchIdle()
    await persist()
    changed()
    return publicSettings()
  }

  // --- the status of 8.4 ---

  function status() {
    const p = proc
    const s = publicState()
    const m = p ? measured[p.device] : null
    return {
      state: s,
      why: state === 'failed' ? failure?.reason ?? why : why,
      // The job's device, so Try again installs for the one that failed, and when its step began,
      // for the minutes of a step with nothing to download.
      install: install ? { step: install.step, of: install.of ?? 8, name: install.name, received: install.received ?? 0, total: install.total ?? 0, error: install.error ?? null, kind: install.kind, device: install.device ?? null, stepStartedAt: install.stepStartedAt ?? null, failedStep: install.failedStep ?? null, offerCpu: !!install.offerCpu, notes: install.notes ?? [] } : null,
      installed: installedInfo ? {
        laya: installedInfo.laya, torch: installedInfo.torch, cuda: !!installedInfo.cuda, gpu: installedInfo.gpu ?? null, python: installedInfo.python ?? null,
        weights: weightsInfo?.commit ? { commit: weightsInfo.commit, bytes: Object.values(weightsInfo.files ?? {}).reduce((a, f) => a + (f.size ?? 0), 0), downloadedAt: weightsInfo.downloadedAt ?? null } : null,
        // Both folders together, and each one, which the remove dialog names (8.3).
        diskBytes: folderBytes ? folderBytes.engine + folderBytes.models : null,
        bytes: folderBytes ? { ...folderBytes } : null,
      } : null,
      expected: { laya: pins.laya, torch: pins.torch?.version ?? null },
      running: p && ['starting', 'ready', 'stopping'].includes(state) ? {
        port: p.port, pid: p.pid, interpreterPid: p.interpreterPid, device: p.device, deviceWhy: p.deviceWhy, spilling: p.spilling, spills, threads: p.threads,
        loadMs: p.loadMs, startedAt: p.startedAt, measuring: p.measuring, lastLoadMs: lastLoadMs(p.device), gpu: p.gpu ?? null,
        // Where each figure comes from: the working set the budget watchdog reads while a RAM budget
        // is set, else what the first full warm-up on this device measured (7.5), which the GPU's
        // is always, since the GPU memory of one process is not read while it runs.
        ramGB: p.resident?.workingSetGB ?? m?.ramGB ?? null,
        ramSource: p.resident?.workingSetGB != null ? 'working set' : m?.ramGB != null ? 'first start' : null,
        vramGB: p.device === 'cuda' ? m?.vramGB ?? null : null,
        vramSource: p.device === 'cuda' && m?.vramGB != null ? 'first start' : null,
        msPerToken: { ...m.msPerToken }, busy: !!isBusy(), held: [...holds], lastCallMs,
        // A local model request in flight shares the cores with an acting Laya call on the CPU.
        localBusy: !!isLocalBusy(),
      } : null,
      restart: state === 'restarting' ? restartInfo : null,
      lastRestart,
      stoppedBecause: state === 'stopped' ? stoppedBecause : null,
      orphanStopped,
      settings: publicSettings(),
      shadow: null,
      selfTest: lastSelfTest,
      warnings: [...warnings],
      logTail: state === 'failed' ? failure?.lines ?? [] : [],
      configError: configError ?? null,
    }
  }

  // The engine exiting takes every laya.serve it started with it, an install check's too.
  const onProcessExit = () => { for (const p of [proc, checkProc]) if (p && !p.exited) killTree(p.pid) }
  process.on('exit', onProcessExit)

  async function measureDisk() {
    folderBytes = installedInfo ? { engine: await sizeOf(paths.engine), models: await sizeOf(paths.models) } : null
  }
  if (installedInfo) measureDisk().catch(() => {})

  return {
    paths,
    status,
    installed: () => installedInfo,
    isReady: () => state === 'ready' && !!proc,
    start,
    stop,
    async restart({ reason = 'user', device } = {}) {
      // The Laya client's own restart of a request past hardMs, which it sees before the health
      // check would: a restart the supervisor makes on its own, so the card says why (7.5).
      if (reason === 'hung') return restartFor('hung', LAYA_TEXT.hung(Math.round(hardMs / 1000)))
      if (reason === 'user' && runHeld()) throw new Error(LAYA_TEXT.stopWhileHeld)
      // Restart on the GPU: the room is checked before the running instance is stopped, and when
      // there is none, it says so with the numbers and leaves Laya running where it is.
      if (device === 'gpu' || device === 'cuda') {
        const room = await gpuRoom()
        if (!room.ok) throw new Error(`Laya stays on the CPU: ${room.why}.`)
      }
      await stop({ reason: 'restart' })
      return start({ reason, device })
    },
    /** A background start when installed and not failed; never throws. With `atStartup`, only when Start Laya when KzH starts is on. */
    warm({ atStartup = false } = {}) {
      try {
        if ((atStartup && !settings.startWithKzh) || unavailable() || state === 'failed') return
        if (state === 'stopped' || state === 'stopping') start({ reason: atStartup ? 'start with KzH' : 'warm' }).catch(() => {})
      } catch (err) { log(`laya: warm: ${err.message}`) }
    },
    ensureReady,
    /** route() holds by its run id for an open Laya Auto run; Test Laya holds with 'selftest'. */
    hold(key) { holds.add(holdKey(key)) },
    release(key) { if (holds.delete(holdKey(key)) && !holds.size) touchIdle() },
    held: () => [...holds],
    connection: () => (state === 'ready' && proc ? connOf(proc) : null),
    reservePort,
    freePortReservation,
    setPriority: setPriorityLevel,
    noteResult,
    sweepOrphans,
    checkStart,
    /** The installer's progress (laya-install.js), shown as the installing states; a finished job reloads what is on disk. */
    noteInstall(job) {
      const was = publicState()
      install = job
      if (!job || job.done || job.error || job.finishedAt) { reloadInstalled(); measureDisk().catch(() => {}) }
      // A state change is announced (the model menu listens); the progress within a step is read
      // from status() by whoever shows it.
      if (publicState() !== was || !job || job.done || job.error) changed()
    },
    /** While an install swaps the venv, a start waits for it. */
    suspend() { suspended ??= deferred() },
    resume() { suspended?.resolve(); suspended = null },
    /** Test Laya's result, kept in laya.json; running it counts as activity for the idle timer. */
    async noteSelfTest(result) { lastSelfTest = result; touchIdle(); await persist(); changed() },
    readSettings: () => ({ ...publicSettings(), measured: JSON.parse(JSON.stringify(measured)), lastSelfTest }),
    setSettings,
    logTail: (n = 200) => tail.slice(-n).map((l) => l.text),
    async dispose() {
      disposed = true
      process.off('exit', onProcessExit)
      clearTimers()
      if (currentStart) currentStart.cancelled = true
      // A call waiting out a crash backoff hears at once that nothing will start Laya now.
      restartPending?.reject(unavailable())
      restartPending = null
      const p = proc
      proc = null
      if (p && !p.exited) { if (p.resident) residency?.clear('laya', p.resident); await kill(p) }
      // An install check under way goes too; its checkStart then reports it stopped.
      if (checkProc && !checkProc.exited) await kill(checkProc)
      state = 'stopped'
      await saving
    },
  }
}

// Installing, updating, repairing and removing Laya on this PC (docs/laya-auto.md 7.1 to 7.3, 7.10).
//
// One implementation for the Settings card's Install Laya button and for `Install-Harness.ps1
// -Laya` (through laya/install-cli.mjs), so the logic is never copied into PowerShell:
//   1. check the free disk and that every download host answers;
//   2. uv, pinned by version and SHA-256 in config/laya.json;
//   3. a uv-managed Python 3.12 and a new relocatable venv, `venv.new`, beside any running one;
//   4. PyTorch for the GPU from the first PyTorch index the driver's CUDA version allows that has a
//      wheel, or for the CPU from PyPI;
//   5. Laya and every other package from the one universal hash-locked lock, then `uv pip check`
//      and an import that reports what torch sees;
//   6. Laya's weights, fetched by Laya's own loader (laya/fetch_weights.py), offline first, and
//      recorded in weights.json only after they have loaded once;
//   7. the real sidecar start from `venv.new` and the protocol checks of Test Laya;
//   8. a journalled swap of `venv.new` into place, which recover() finishes or rolls back at the
//      next start if the engine is killed half way.
// Every uv call keeps its Python, cache and configuration under engine/laya, so nothing lands in
// the person's profile, and a failed step leaves the previous install exactly as it was.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, lstat, mkdir, open, readFile, readdir, rename as fsRename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { downloadVerified, sha256File } from './local.js'

const GB = 1024 ** 3
const r1 = (x) => Math.round(x * 10) / 10
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- pins and paths ----------

/**
 * config/laya.json: what this KzH version installs (7.2). Checked strictly, as the local models'
 * manifest is: download URLs and hashes come only from here.
 */
export function readPins(harnessDir) {
  const pins = JSON.parse(readFileSync(join(harnessDir, 'config', 'laya.json'), 'utf8'))
  const bad = (why) => { throw new Error(`config/laya.json: ${why}`) }
  const SHA = /^[0-9a-f]{64}$/
  const UV = /^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\//
  const uvBuild = (u, where) => {
    if (!UV.test(u?.source ?? '')) bad(`${where}.source: a github.com/astral-sh/uv release URL`)
    if (!(Number.isSafeInteger(u.size) && u.size > 0)) bad(`${where}.size: bytes`)
    if (!SHA.test(u.sha256 ?? '')) bad(`${where}.sha256: 64 hex characters`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(pins.uv?.version ?? '')) bad('uv.version')
  uvBuild(pins.uv, 'uv')
  if (pins.uv.linux) uvBuild(pins.uv.linux, 'uv.linux')
  if (!/^3\.\d+$/.test(pins.python ?? '')) bad('python: 3.x')
  if (!/^\d+\.\d+\.\d+$/.test(pins.laya ?? '')) bad('laya: a version')
  if (!/^\d+\.\d+\.\d+$/.test(pins.torch?.version ?? '')) bad('torch.version')
  if (!Array.isArray(pins.torch.cuda) || !pins.torch.cuda.every((c) => /^cu\d{3}$/.test(c.tag ?? '') && Number.isFinite(c.minDriverCuda))) bad('torch.cuda: [{ tag: cuXYZ, minDriverCuda }]')
  if (pins.torch.indexBase !== 'https://download.pytorch.org/whl/') bad('torch.indexBase: https://download.pytorch.org/whl/')
  if (pins.lock !== 'config/laya/requirements.lock') bad('lock: config/laya/requirements.lock')
  if (!/^[\w.-]+\/[\w.-]+$/.test(pins.weights?.repo ?? '')) bad('weights.repo')
  if (!(Number.isSafeInteger(pins.weights.approxBytes) && pins.weights.approxBytes > 0)) bad('weights.approxBytes')
  return pins
}

/** Every file and folder Laya uses (7.1). `dataDir` is the plugin's data folder (~/.kzh/jev-router). */
export function layaPaths({ harnessDir, dataDir, platform = process.platform }) {
  const engine = join(harnessDir, 'engine', 'laya')
  const models = join(harnessDir, 'models', 'laya')
  const logDir = join(dataDir, 'laya')
  return {
    engine, models,
    venv: join(engine, 'venv'), venvNew: join(engine, 'venv.new'), venvOld: join(engine, 'venv.old'),
    python: join(engine, 'python'), cache: join(engine, 'cache'), run: join(engine, 'run'),
    swap: join(engine, 'swap.json'), lock: join(engine, 'install.lock'), installed: join(engine, 'installed.json'),
    uvDir: join(harnessDir, 'engine', 'uv'), uv: join(harnessDir, 'engine', 'uv', platform === 'win32' ? 'uv.exe' : 'uv'),
    hf: join(models, 'hf'), hfStaging: join(models, 'hf.staging'), hfOld: join(models, 'hf.old'), weights: join(models, 'weights.json'),
    requirementsLock: join(harnessDir, 'config', 'laya', 'requirements.lock'),
    fetchWeights: join(harnessDir, 'plugins', 'jev-router', 'laya', 'fetch_weights.py'),
    settings: join(dataDir, 'laya.json'), logDir,
    serveLog: join(logDir, 'laya-serve.log'), installLog: join(logDir, 'install.log'), sidecarJson: join(logDir, 'sidecar.json'),
    /** The interpreter of a venv: Scripts\python.exe on Windows, bin/python elsewhere. */
    pythonOf: (venv) => (platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')),
  }
}

/**
 * The PyTorch indexes to try for the GPU, in order: every pinned CUDA tag the driver's CUDA version
 * (nvidia-smi's "CUDA Version") can run. Empty with no NVIDIA driver, or one older than every tag,
 * which means the CPU wheel from PyPI.
 */
export function torchIndexes(cuda, driverCuda) {
  if (!(driverCuda > 0)) return []
  return cuda.filter((c) => c.minDriverCuda <= driverCuda + 1e-9)
}

// ---------- the weights record (7.3) ----------

const readJson = (p) => readFile(p, 'utf8').then(JSON.parse, () => null)
async function writeJson(p, v) {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(`${p}.tmp`, JSON.stringify(v, null, 2))
  await fsRename(`${p}.tmp`, p)
}

/** The folder Laya's own loader reads, in a plain Hugging Face cache. */
export const snapshotDir = (hf, repo, commit) => join(hf, 'hub', `models--${repo.replace('/', '--')}`, 'snapshots', commit)

/** Every regular file under `dir`, relative with forward slashes; symlinks are followed to what they point at. */
async function filesUnder(dir, base = dir) {
  const out = []
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name)
    const st = await stat(p).catch(() => null)
    if (st?.isDirectory()) out.push(...await filesUnder(p, base))
    else if (st?.isFile()) out.push(relative(base, p).split(sep).join('/'))
  }
  return out.sort()
}

/** Bytes of every file under `dir`, links not followed, so a Hugging Face snapshot and its blobs are counted once. */
export async function sizeOf(dir) {
  let n = 0
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name)
    if (d.isDirectory()) n += await sizeOf(p)
    else if (d.isFile()) n += (await lstat(p).catch(() => null))?.size ?? 0
  }
  return n
}

/** `{ <path>: { size, mtimeMs, sha256 } }` for every file of a snapshot. */
export async function hashSnapshot(dir) {
  const files = {}
  for (const rel of await filesUnder(dir)) {
    const p = join(dir, rel)
    const st = await stat(p)
    files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: await sha256File(p) }
  }
  return files
}

/**
 * Write weights.json for a snapshot that has just loaded through Laya: every file's size, mtime
 * and hash. Never called before a load, because loading rewrites the tokenizer config in place.
 */
export async function recordWeights(paths, { repo, commit, downloadedAt, loadedAt }) {
  const files = await hashSnapshot(snapshotDir(paths.hf, repo, commit))
  if (!files['model.safetensors']) throw new Error(`the snapshot ${commit.slice(0, 7)} has no model.safetensors`)
  const record = { repo, commit, files, downloadedAt, loadedAt }
  await writeJson(paths.weights, record)
  return record
}

/** The one file Laya itself may rewrite on load (laya/agent.py `_fix_tokenizer_config`). */
const REWRITTEN_ON_LOAD = 'tokenizer/tokenizer_config.json'

/**
 * Before each start: are the recorded weights still there, unchanged? Size and mtime first; a full
 * hash only for a file whose size or mtime moved, and a file whose hash still matches is simply
 * re-dated. A changed tokenizer config that still parses as JSON is Laya's own rewrite and is
 * recorded again, with a log line; anything else missing or changed refuses the start, so Laya never
 * fails inside its own load with a message nobody can act on.
 * @returns {Promise<{ ok: true, record } | { ok: false, why: string }>}
 */
export async function verifyWeights(paths, { platform = process.platform, log = () => {} } = {}) {
  const copyHint = platform === 'win32' ? 'models\\laya\\hf' : 'models/laya/hf'
  const refuse = (what) => ({ ok: false, why: `Laya's model files are not complete on this PC (${what}). Choose Repair, or copy ${copyHint} from another PC.` })
  const record = await readJson(paths.weights)
  if (!record?.commit || !record.files) return refuse('weights.json is missing')
  const dir = snapshotDir(paths.hf, record.repo, record.commit)
  let changed = false
  for (const [rel, want] of Object.entries(record.files)) {
    const p = join(dir, rel)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) return refuse(`${rel} is missing`)
    if (st.size === want.size && Math.floor(st.mtimeMs) === Math.floor(want.mtimeMs)) continue
    const sha256 = await sha256File(p)
    if (sha256 !== want.sha256) {
      const json = rel === REWRITTEN_ON_LOAD && await readFile(p, 'utf8').then((t) => { try { JSON.parse(t); return true } catch { return false } }, () => false)
      if (!json) return refuse(`${rel} has changed`)
      log(`laya: ${rel} was rewritten by Laya's loader; recorded again`)
    }
    record.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256 }
    changed = true
  }
  if (changed) await writeJson(paths.weights, record)
  return { ok: true, record }
}

// ---------- small process and file helpers ----------

/**
 * A rename that Windows may refuse for a while: a process that is exiting, or an antivirus scan
 * of the new DLLs, keeps a handle on the folder. Retried with backoff for up to `limitMs` on
 * EPERM, EACCES and EBUSY, as training.js retries its own rename.
 */
export async function renameRetry(from, to, { rename = fsRename, sleep = sleepMs, limitMs = 30_000 } = {}) {
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || waited >= limitMs) throw err
      const ms = Math.min(2000, 50 * 2 ** attempt)
      await sleep(ms)
      waited += ms
    }
  }
}

/** Delete a folder, retried the same way. */
export async function rmRetry(path, { sleep = sleepMs, limitMs = 30_000, remove = rm } = {}) {
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try { return await remove(path, { recursive: true, force: true }) } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(err.code) || waited >= limitMs) throw err
      const ms = Math.min(2000, 50 * 2 ** attempt)
      await sleep(ms)
      waited += ms
    }
  }
}

/**
 * A log file of Laya's own (laya-serve.log, install.log): appended in order, rotated once it passes
 * `maxBytes`, with two older files kept (.1 and .2). A write that fails is dropped, never thrown.
 */
export function createRotatingLog(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  let bytes = null
  let queue = Promise.resolve()
  return {
    append(text) {
      queue = queue.then(async () => {
        await mkdir(dirname(file), { recursive: true })
        bytes ??= (await stat(file).catch(() => null))?.size ?? 0
        if (bytes > maxBytes) {
          await fsRename(`${file}.1`, `${file}.2`).catch(() => {})
          await fsRename(file, `${file}.1`).catch(() => {})
          bytes = 0
        }
        await appendFile(file, text)
        bytes += Buffer.byteLength(text)
      }).catch(() => {})
      return queue
    },
    flushed: () => queue,
  }
}

/** A command's stdout, or null when it fails or does not start. Ten seconds at most. */
export function execText(cmd, args, { timeoutMs = 10_000, spawn = nodeSpawn } = {}) {
  return new Promise((done) => {
    let c
    try { c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { done(null); return }
    let out = ''
    const t = setTimeout(() => { c.kill(); done(null) }, timeoutMs)
    t.unref?.()
    c.stdout.on('data', (d) => { out += d })
    c.on('error', () => { clearTimeout(t); done(null) })
    c.on('exit', (code) => { clearTimeout(t); done(code === 0 ? out : null) })
  })
}

/** Whether a pid is a running process (a process owned by someone else still counts). */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/**
 * engine/laya/install.lock: one process installs, updates, repairs or removes at a time, the card
 * or the command line. Created exclusively with this process's pid; a lock whose pid is not alive
 * is left over from a crash and taken over. Returns the release function.
 */
export async function takeInstallLock(paths, { pid = process.pid, alive = isAlive } = {}) {
  await mkdir(dirname(paths.lock), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(paths.lock, 'wx')
      await fh.writeFile(String(pid))
      await fh.close()
      return async () => { await unlink(paths.lock).catch(() => {}) }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const holder = Number((await readFile(paths.lock, 'utf8').catch(() => '')).trim())
      if (holder && alive(holder)) throw new Error(`Another Laya install is running (pid ${holder}).`)
      await unlink(paths.lock).catch(() => {})
    }
  }
  throw new Error('Could not take the Laya install lock.')
}

// ---------- the installer ----------

/** Card and log names of the eight steps (7.2); the torch step names its device when it starts. */
export function stepNames(pins) {
  return {
    1: 'Checking the downloads and disk',
    2: 'Getting uv',
    3: `Getting Python ${pins.python}`,
    4: `Installing PyTorch ${pins.torch.version}`,
    5: `Installing Laya ${pins.laya}`,
    6: 'Downloading the Laya model from Hugging Face',
    7: 'Checking that it starts',
    8: 'Cleaning up',
  }
}

/** Free disk while installing, estimates until the desktop install measures its peak. */
const DISK_NEED_GB = { gpu: 8, cpu: 3 }
/** What the torch download is expected to weigh, for the step's progress only. */
const TORCH_BYTES = { gpu: 2.5 * GB, cpu: 120 * 1024 ** 2 }
/** uv's words when an index has no wheel for this platform, or says 404. */
const NO_WHEEL = /\b404\b|not found|no matching distribution|no solution|no version of torch/i

/** A step failure: which step, and what to offer. */
class StepError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra) }
}

/**
 * @param {object} p
 * @param {string} p.harnessDir
 * @param {string} p.dataDir
 * @param {object} p.pins        readPins()
 * @param {() => Promise<object|null>} [p.specs]  detectSpecs() for this PC (the driver's CUDA version)
 * @param {object} [p.sidecar]   createLayaSidecar(): stopped before a swap, checked in step 7, told of progress
 * @param {Function} [p.spawn]   node's spawn (tests stub it)
 * @param {Function} [p.fetch]   for the host probes and the uv download
 * @param {(dir: string) => Promise<number|null>} [p.freeBytes]  free disk where Laya goes
 * @param {Function} [p.rename]  fs rename (tests inject EBUSY)
 * @param {Function} [p.remove]  fs rm, for the folders it deletes (tests inject EBUSY)
 * @param {number} [p.noProgressMs]  a step with no output and no bytes for this long fails
 */
export function createLayaInstaller({
  harnessDir, dataDir, pins, specs = async () => null, sidecar = null,
  spawn = nodeSpawn, fetch = globalThis.fetch, log = () => {}, now = Date.now, platform = process.platform,
  freeBytes = async (dir) => { const s = await statfs(dir).catch(() => null); return s ? s.bavail * s.bsize : null },
  rename = fsRename, remove = rm, sleep = sleepMs, alive = isAlive, pid = process.pid,
  noProgressMs = 5 * 60_000, progressEveryMs = 2000, probeTimeoutMs = 5000,
}) {
  const paths = layaPaths({ harnessDir, dataDir, platform })
  const NAMES = stepNames(pins)
  let job = null // the install, update, repair, remove or weights job running or last finished
  let running = null // its promise
  let abort = null
  let message = null // the recover() message, for the card
  const uvEnv = () => ({
    ...process.env,
    UV_PYTHON_INSTALL_DIR: paths.python,
    UV_CACHE_DIR: paths.cache,
    UV_NO_CONFIG: '1',
  })

  const installLog = createRotatingLog(paths.installLog)
  const told = () => { try { sidecar?.noteInstall?.(job ? { ...job } : null) } catch (err) { log(`laya install: ${err.message}`) } }
  const say = (line) => {
    log(`laya install: ${line}`)
    installLog.append(`${new Date(now()).toISOString()} ${line}\n`)
    if (job) { job.lines.push(line); told() }
  }

  /**
   * Run one command of a step. Output lines and the growth of `progress()` (bytes) are progress;
   * `noProgressMs` without either kills it and fails the step. Resolves `{ code, output }`.
   */
  function command(cmd, args, { env = process.env, cwd, progress } = {}) {
    return new Promise((resolve, reject) => {
      const step = job?.name ?? 'installing'
      let child
      try { child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { reject(err); return }
      let output = ''
      let last = now()
      let bytes = null
      let over = false
      const moved = () => { last = now() }
      const onData = (d) => { output += d; installLog.append(String(d)); moved() }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      const tick = setInterval(async () => {
        if (progress) {
          const b = await progress().catch(() => null)
          if (b != null && b !== bytes) { bytes = b; if (job) { job.received = b; told() } moved() }
        }
        if (now() - last >= noProgressMs && !over) {
          over = true
          try { child.kill() } catch { /* gone */ }
          const minutes = Math.round(noProgressMs / 60_000)
          reject(new StepError(`No progress for ${minutes} minute${minutes === 1 ? '' : 's'} while ${step}.`))
        }
      }, progressEveryMs)
      const cancel = () => { try { child.kill() } catch { /* gone */ } }
      abort?.signal.addEventListener('abort', cancel, { once: true })
      child.on('error', (err) => { clearInterval(tick); reject(err) })
      installLog.append(`> ${[cmd, ...args].join(' ')}\n`)
      child.on('exit', (code) => {
        clearInterval(tick)
        abort?.signal.removeEventListener('abort', cancel)
        if (over) return
        if (abort?.signal.aborted) { reject(new StepError('Install cancelled.', { cancelled: true })); return }
        resolve({ code, output })
      })
    })
  }

  const lastLine = (out) => String(out).trim().split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? ''
  const uv = async (args, opts = {}) => {
    const r = await command(paths.uv, args, { env: uvEnv(), ...opts })
    if (r.code !== 0) throw new StepError(`uv ${args[0]}${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''} failed: ${lastLine(r.output) || `exit code ${r.code}`}`, { output: r.output })
    return r.output
  }

  const begin = (kind, extra = {}) => {
    job = { kind, step: 0, of: 8, name: null, received: 0, total: 0, error: null, failedStep: null, failedName: null, offerCpu: false, lines: [], notes: [], startedAt: now(), done: false, ...extra }
    abort = new AbortController()
    told()
  }
  const step = (n, name = NAMES[n], total = 0) => {
    if (abort?.signal.aborted) throw new StepError('Install cancelled.', { cancelled: true })
    Object.assign(job, { step: n, name, received: 0, total })
    say(`step ${n} of 8: ${name}`)
  }

  // --- the steps ---

  async function checkDisk(device, { update }) {
    const need = DISK_NEED_GB[device] * GB
    const free = await freeBytes(harnessDir)
    if (free != null && free < need) {
      throw new StepError(`Not enough free disk: Laya needs about ${DISK_NEED_GB[device]} GB while ${update ? 'updating' : 'installing'} for the ${device === 'gpu' ? 'GPU' : 'CPU'}, and ${r1(free / GB)} GB is free.`)
    }
  }

  async function checkHosts(hosts) {
    for (const host of hosts) {
      const ok = await fetch(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(probeTimeoutMs) }).then(() => null, (err) => err?.message ?? String(err))
      if (ok !== null) throw new StepError(`Cannot reach ${host} (${ok}). Check the internet connection, or a firewall or proxy that blocks it.`)
    }
  }

  async function getUv() {
    const version = async () => (await command(paths.uv, ['--version'], { env: uvEnv() }).catch(() => null))?.output ?? ''
    if (existsSync(paths.uv) && new RegExp(`^uv ${pins.uv.version.replaceAll('.', '\\.')}\\b`).test((await version()).trim())) return
    // The installer was not re-run since this KzH version pinned uv: fetch the same pinned build.
    const build = platform === 'win32' ? pins.uv : pins.uv.linux
    if (!build) throw new StepError(`No uv build is pinned for ${platform}; install uv ${pins.uv.version} at ${paths.uv}.`)
    await mkdir(paths.uvDir, { recursive: true })
    const archive = join(paths.uvDir, basename(new URL(build.source).pathname))
    job.total = build.size
    await downloadVerified({ url: build.source, dest: archive, size: build.size, sha256: build.sha256, fetch, onProgress: (n) => { job.received = n; told() } })
    const tar = platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const r = await command(tar, ['-xf', archive, '-C', paths.uvDir, ...(platform === 'win32' ? [] : ['--strip-components=1'])])
    await unlink(archive).catch(() => {})
    if (r.code !== 0) throw new StepError(`unpacking uv failed: ${lastLine(r.output) || `exit code ${r.code}`}`)
    const got = (await version()).trim()
    if (!got.startsWith(`uv ${pins.uv.version}`)) throw new StepError(`uv reports "${got || 'nothing'}", not ${pins.uv.version}.`)
  }

  async function getPython() {
    await uv(['python', 'install', pins.python])
    await rmRetry(paths.venvNew, { sleep, remove })
    await uv(['venv', '--relocatable', '--python', pins.python, '--python-preference', 'only-managed', paths.venvNew])
  }

  /** The site-packages folder of a venv. */
  async function sitePackages(venv) {
    if (platform === 'win32') return join(venv, 'Lib', 'site-packages')
    const lib = join(venv, 'lib')
    const py = (await readdir(lib).catch(() => [])).find((d) => /^python3\.\d+$/.test(d))
    return join(lib, py ?? `python${pins.python}`, 'site-packages')
  }

  /** What step 4 installed, so a later change to the unhashable CUDA wheel is detectable. */
  async function torchRecord(venv) {
    const site = await sitePackages(venv)
    const info = (await readdir(site).catch(() => [])).find((d) => /^torch-[^-]+\.dist-info$/.test(d))
    if (!info) return []
    const record = await readFile(join(site, info, 'RECORD')).catch(() => null)
    return [{ name: 'torch', version: info.slice('torch-'.length, -'.dist-info'.length), recordSha256: record ? createHash('sha256').update(record).digest('hex') : null }]
  }

  async function installTorch(venv, { device, torchIndex }) {
    const py = paths.pythonOf(venv)
    const want = `torch==${pins.torch.version}`
    const progress = () => sizeOf(paths.cache)
    const where = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
    if (device === 'cpu' || torchIndex === 'pypi') {
      job.name = `Installing PyTorch ${pins.torch.version} for the ${device === 'cpu' ? 'CPU' : 'GPU'}`
      job.total = TORCH_BYTES[device]
      told()
      await uv(['pip', 'install', '--python', py, want], { progress })
      return { torchIndex: 'pypi' }
    }
    const driver = (await specs().catch(() => null))?.cuda ?? null
    const tags = torchIndexes(pins.torch.cuda, driver)
    if (!tags.length) {
      const why = driver
        ? `The NVIDIA driver supports CUDA ${driver}; PyTorch ${pins.torch.version} needs CUDA ${Math.min(...pins.torch.cuda.map((c) => c.minDriverCuda))} or newer, so it is installed for the CPU.`
        : `No NVIDIA driver was found, so PyTorch ${pins.torch.version} is installed for the CPU.`
      job.notes.push(why)
      say(why)
      return installTorch(venv, { device: 'cpu' })
    }
    job.name = `Installing PyTorch ${pins.torch.version} for the GPU (CUDA ${driver})`
    job.total = TORCH_BYTES.gpu
    told()
    const tried = []
    for (const [i, c] of tags.entries()) {
      tried.push(c.tag)
      try {
        await uv(['pip', 'install', '--python', py, want, '--index-url', `${pins.torch.indexBase}${c.tag}`], { progress })
        return { torchIndex: c.tag }
      } catch (err) {
        if (err.cancelled || !NO_WHEEL.test(`${err.message}\n${err.output ?? ''}`)) throw err
        const next = tags[i + 1]
        say(next ? `PyTorch ${pins.torch.version} has no ${where} wheel for ${c.tag}; trying ${next.tag}.` : `PyTorch ${pins.torch.version} has no ${where} wheel for ${c.tag}.`)
      }
    }
    throw new StepError(`PyTorch ${pins.torch.version} has no ${where} wheel for ${tried.join(', ')}; the driver supports CUDA ${driver}.`, { offerCpu: true })
  }

  const IMPORT_CHECK = [
    'import json, sys, importlib.metadata as m, torch, laya',
    'cuda = torch.cuda.is_available()',
    "print(json.dumps({'torch': torch.__version__, 'cuda': cuda, 'gpu': torch.cuda.get_device_name(0) if cuda else None, 'laya': m.version('laya'), 'python': sys.version.split()[0]}))",
  ].join('\n')

  async function installLaya(venv, { device }) {
    const py = paths.pythonOf(venv)
    // `install`, never `sync`: sync removes every package the lock does not name, and the lock
    // leaves torch out, because its CUDA wheel cannot be hash-locked from anywhere but this PC.
    await uv(['pip', 'install', '--python', py, '--no-deps', '--require-hashes', '-r', paths.requirementsLock], { progress: () => sizeOf(paths.cache) })
    await uv(['pip', 'check', '--python', py])
    const r = await command(py, ['-I', '-c', IMPORT_CHECK], { cwd: paths.engine })
    let got = null
    try { got = JSON.parse(lastLine(r.output)) } catch { /* reported below */ }
    if (r.code !== 0 || !got) throw new StepError(`Laya does not import: ${lastLine(r.output) || `exit code ${r.code}`}`)
    if (!String(got.torch).startsWith(pins.torch.version)) throw new StepError(`PyTorch ${got.torch} was installed, not ${pins.torch.version}.`)
    if (got.laya !== pins.laya) throw new StepError(`Laya ${got.laya} was installed, not ${pins.laya}.`)
    if (device === 'gpu' && !got.cuda) {
      const driver = (await specs().catch(() => null))?.cuda ?? 'unknown'
      const note = `Installed for the CPU: PyTorch reports no usable CUDA (driver CUDA ${driver}). Update the NVIDIA driver, then choose Reinstall.`
      job.notes.push(note)
      say(note)
    }
    return got
  }

  /**
   * Step 6 and Repair: Laya's own loader fetches what it loads, offline first so a copied cache
   * needs no network, then online; the record is written only once the files have loaded.
   */
  async function fetchWeights(venv, { hf = paths.hf, record = true } = {}) {
    const py = paths.pythonOf(venv)
    job.total = pins.weights.approxBytes
    const base = {
      ...process.env,
      HF_HOME: hf, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      // Without it huggingface_hub fetches Xet-backed files from Xet hosts step 1 never probed,
      // and loses the classic resumable `.incomplete` download.
      HF_HUB_DISABLE_XET: '1',
    }
    await mkdir(paths.run, { recursive: true })
    const once = async (offline) => {
      const env = offline ? { ...base, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : base
      if (!offline) { delete env.HF_HUB_OFFLINE; delete env.TRANSFORMERS_OFFLINE }
      // From the empty run folder, where `convaiinnovations/laya` can never be a relative path.
      return command(py, ['-I', '-u', '-X', 'utf8', paths.fetchWeights, '--repo', pins.weights.repo, '--checkpoint', pins.weights.checkpoint ?? 'english'], { env, cwd: paths.run, progress: () => sizeOf(join(hf, 'hub')) })
    }
    let r = await once(true)
    if (r.code !== 0) {
      say('The model is not on this PC yet; downloading it from Hugging Face.')
      r = await once(false)
    }
    let got = null
    try { got = JSON.parse(lastLine(r.output)) } catch { /* reported below */ }
    if (r.code !== 0 || !got?.commit) throw new StepError(`The Laya model did not download: ${lastLine(r.output) || `exit code ${r.code}`}`)
    if (!record) return got
    const at = new Date(now()).toISOString()
    return recordWeights({ ...paths, hf }, { repo: pins.weights.repo, commit: got.commit, downloadedAt: at, loadedAt: at })
  }

  /**
   * Step 8, the swap, journalled in swap.json so recover() can finish it or roll it back when the
   * engine is killed between the renames. Each rename is retried while Windows holds a handle.
   */
  async function swapIn(installed) {
    const journal = (s) => writeJson(paths.swap, { step: s, from: 'venv', to: 'venv.new', installed })
    await journal('stopping')
    await sidecar?.stop?.({ reason: 'update' })
    const had = existsSync(paths.venv)
    if (had) await renameRetry(paths.venv, paths.venvOld, { rename, sleep })
    await journal('renamed-old')
    await renameRetry(paths.venvNew, paths.venv, { rename, sleep })
    await journal('renamed-new')
    await finishSwap(installed)
  }

  /** The swap's last part: the old venv goes, installed.json is written, the journal and the cache are deleted. */
  async function finishSwap(installed) {
    const before = await sizeOf(paths.cache) + await sizeOf(paths.venvOld)
    await rmRetry(paths.venvOld, { sleep, remove }).catch((err) => log(`laya install: venv.old stays until the next start (${err.message})`))
    await writeJson(paths.installed, installed)
    await unlink(paths.swap).catch(() => {})
    // Deleted so the uv cache never sits beside the venv: the venv's files are hard links, and an
    // update downloads again.
    await rmRetry(paths.cache, { sleep, remove }).catch(() => {})
    return before
  }

  async function lockSha() {
    return createHash('sha256').update(await readFile(paths.requirementsLock)).digest('hex')
  }

  /**
   * Install (or with `update`, rebuild beside the running one) and swap in. `device` is 'gpu' or
   * 'cpu'; `skipWeights` and `torchIndex: 'pypi'` are for the cloud end-to-end test only.
   */
  async function build({ device, update, skipWeights = false, torchIndex = null }) {
    const release = await takeInstallLock(paths, { pid, alive })
    const wasRunning = !!sidecar?.isReady?.()
    let stoppedForCheck = false
    try {
      step(1)
      await checkDisk(device, { update })
      await checkHosts(['github.com', 'pypi.org', 'files.pythonhosted.org', ...(update || skipWeights ? [] : ['huggingface.co']), ...(device === 'gpu' && torchIndex !== 'pypi' ? ['download.pytorch.org'] : [])])
      if (!update) { step(2); await getUv() } else if (!existsSync(paths.uv)) { step(2); await getUv() }
      step(3)
      await getPython()
      step(4, `${NAMES[4]} for the ${device === 'gpu' ? 'GPU' : 'CPU'}`)
      const torch = await installTorch(paths.venvNew, { device, torchIndex })
      const torchWheels = await torchRecord(paths.venvNew)
      step(5)
      const got = await installLaya(paths.venvNew, { device })
      if (!update && !skipWeights) {
        step(6)
        await fetchWeights(paths.venvNew)
      }
      step(7)
      if (sidecar) {
        // A second Laya beside the running one would test the wrong device on a 4 GB GPU. Not while
        // a Laya Auto run is deciding, though: that run needs the one it has.
        if ((sidecar.held?.() ?? []).some((k) => k.startsWith('run:'))) throw new StepError('Laya is deciding for an open Laya Auto run; stop that run first.')
        sidecar.suspend?.()
        if (sidecar.isReady?.() || ['starting', 'restarting'].includes(sidecar.status?.().state)) { await sidecar.stop({ reason: 'update' }); stoppedForCheck = true }
        if (!skipWeights || existsSync(paths.weights)) {
          const check = await sidecar.checkStart({ venv: paths.venvNew, device: got.cuda && device === 'gpu' ? 'cuda' : 'cpu' })
          if (!check.ok) throw new StepError(`The new install did not pass its check: ${check.error ?? check.problems?.[0] ?? 'no answer'}`)
          if (check.deviceWhy) job.notes.push(`The check ran on the CPU: ${check.deviceWhy}.`)
        }
      }
      step(8)
      const installed = {
        laya: got.laya, torch: got.torch, torchIndex: torch.torchIndex, cuda: !!got.cuda, gpu: got.gpu ?? null, python: got.python,
        uv: pins.uv.version, lockSha256: await lockSha(), torchWheels, installedAt: new Date(now()).toISOString(),
      }
      await swapIn(installed)
      job.done = true
      job.installed = installed
      say(update ? `Updated to Laya ${installed.laya}.` : `Installed Laya ${installed.laya}.`)
      return installed
    } catch (err) {
      Object.assign(job, { error: err.message, failedStep: job.step, failedName: job.name, offerCpu: !!err.offerCpu && job.step === 4 })
      say(update ? `Update failed at step ${job.step} (${job.name}); still on Laya ${sidecar?.installed?.()?.laya ?? 'the version installed before'}.` : `Install failed at step ${job.step} (${job.name}): ${err.message}`)
      // The previous install is untouched; only what this run built goes. Hugging Face's partial
      // downloads stay, and resume on Try again.
      if (existsSync(paths.swap)) await recoverLocked()
      else await rmRetry(paths.venvNew, { sleep, remove }).catch(() => {})
      throw err
    } finally {
      // The sidecar hears the job is over first, so it reads the install as it now is, then starts
      // again what was running before: the new install, or after a failure the one it had.
      job.finishedAt = now()
      told()
      sidecar?.resume?.()
      if ((wasRunning || stoppedForCheck) && sidecar?.installed?.()) sidecar.start?.({ reason: 'update' })?.catch?.(() => {})
      await release()
    }
  }

  /**
   * At plugin start, before the orphan sweep: finish or roll back an install the engine was killed
   * in the middle of, so installed.json never points at a venv that is not there.
   *   - swap.json with venv.old and no venv: the old venv goes back (rolled back);
   *   - swap.json past the second rename (renamed-new, or renamed-old with the new venv in place and
   *     no venv.new, a kill between that rename and its journal line): the swap is completed
   *     (venv.old deleted, installed.json written);
   *   - swap.json before any rename: the half-built venv.new goes;
   *   - a venv.new or venv.old with no journal: deleted.
   * Nothing is touched while another process holds install.lock (the command line installing, say):
   * what looks interrupted is its install under way. A lock naming this process is its own, since
   * this runs before any job of this installer. It never throws: an action the OS refuses (a DLL
   * still loaded, an antivirus scan) is logged, said on the card, and tried again at the next start.
   * @returns {Promise<string|null>} what was done, for the card
   */
  async function recover() {
    if (running || !existsSync(paths.engine)) return null
    let release
    try {
      release = await takeInstallLock(paths, { pid, alive: (holder) => holder !== pid && alive(holder) })
    } catch (err) {
      log(`laya install: nothing recovered now: ${err.message}`)
      return null
    }
    try { return await recoverLocked() } finally { await release() }
  }

  /** recover() for a caller that holds install.lock already: build() after a failed swap. */
  async function recoverLocked() {
    const journal = await readJson(paths.swap)
    const has = (p) => existsSync(p)
    const refused = []
    const attempt = async (what, fn) => {
      try { await fn(); return true } catch (err) {
        refused.push(`${what}: ${err.code ?? err.message}`)
        log(`laya install: ${what} failed (${err.message}); tried again at the next start`)
        return false
      }
    }
    let did = null
    if (journal) {
      if (has(paths.venv) && (journal.step === 'renamed-new' || (journal.step === 'renamed-old' && !has(paths.venvNew)))) {
        if (await attempt('completing the swap', () => finishSwap(journal.installed))) did = `An interrupted Laya install was completed; Laya ${journal.installed?.laya} is installed.`
      } else {
        // The old venv back, then the journal, then what the install built, in that order: a kill
        // in between never leaves a journal that reads as a finished swap, and a venv.new left with
        // no journal is deleted at the next start.
        const back = has(paths.venv) || !has(paths.venvOld) || await attempt('renaming venv.old back to venv', () => renameRetry(paths.venvOld, paths.venv, { rename, sleep }))
        if (back && await attempt('deleting swap.json', () => unlink(paths.swap).catch((err) => { if (err.code !== 'ENOENT') throw err }))) {
          await attempt('deleting venv.new', () => rmRetry(paths.venvNew, { sleep, remove }))
          const before = await readJson(paths.installed)
          did = before && has(paths.venv) ? `An interrupted Laya install was rolled back; Laya ${before.laya} is still installed.` : 'An interrupted Laya install was rolled back; Laya is not installed.'
        }
      }
    } else {
      if (has(paths.venvNew) && await attempt('deleting venv.new', () => rmRetry(paths.venvNew, { sleep, remove }))) log('laya install: deleted a venv.new left by an install that stopped')
      if (has(paths.venvOld)) await attempt('deleting venv.old', () => rmRetry(paths.venvOld, { sleep, remove }))
    }
    if (did) log(`laya install: ${did}`)
    const left = refused.length ? `(${refused.join('; ')}); KzH tries again at the next start.` : null
    const said = did && left ? `${did} Some of it could not be tidied up yet ${left}` : did ?? (left ? `An interrupted Laya install could not be tidied up yet ${left}` : null)
    if (said) message = said
    return said
  }

  /** Run a job in the background; its progress is in status() and on the sidecar's status. */
  function launch(kind, fn, extra) {
    if (running) return Promise.reject(new Error(`Another Laya install is running (pid ${pid}).`))
    begin(kind, extra)
    // A job refused before its first step (the lock another process holds) still says why.
    running = fn().catch((err) => { if (!job.error) { job.error = err.message; say(err.message) } throw err }).finally(() => {
      if (job.finishedAt == null) { job.finishedAt = now(); told() }
      running = null
      abort = null
    })
    running.catch(() => {})
    return running
  }

  async function removeAll() {
    const release = await takeInstallLock(paths, { pid, alive })
    try {
      if ((sidecar?.held?.() ?? []).some((k) => k.startsWith('run:'))) throw new StepError('Laya is deciding for an open Laya Auto run; stop that run first.')
      const freed = await sizeOf(paths.engine) + await sizeOf(paths.models)
      await sidecar?.stop?.({ reason: 'remove' })
      await rmRetry(paths.engine, { sleep, remove })
      await rmRetry(paths.models, { sleep, remove })
      job.done = true
      say(`Removed Laya; ${r1(freed / GB)} GB freed. The recorded comparisons and Laya samples are kept.`)
    } catch (err) {
      job.error = err.message
      throw err
    } finally { await release(); told() }
  }

  async function repairWeights() {
    const release = await takeInstallLock(paths, { pid, alive })
    try {
      step(6)
      const rec = await fetchWeights(paths.venv)
      job.done = true
      say(`The Laya model ${rec.commit.slice(0, 7)} is complete and recorded.`)
      return rec
    } catch (err) {
      Object.assign(job, { error: err.message, failedStep: job.step, failedName: job.name })
      throw err
    } finally { await release(); told() }
  }

  /** `Check for a newer model`: main goes into a staging cache, loaded once, and its commit compared. */
  async function checkWeights() {
    const release = await takeInstallLock(paths, { pid, alive })
    try {
      step(6, 'Checking for a newer Laya model')
      const current = (await readJson(paths.weights))?.commit ?? null
      await rmRetry(paths.hfStaging, { sleep, remove })
      const got = await fetchWeights(paths.venv, { hf: paths.hfStaging, record: false })
      const changed = got.commit !== current
      if (!changed) await rmRetry(paths.hfStaging, { sleep, remove })
      job.done = true
      job.weights = { current, latest: got.commit, changed }
      say(changed ? `A newer Laya model is available (${got.commit.slice(0, 7)}; this PC has ${String(current).slice(0, 7)}).` : 'This PC has the newest Laya model.')
      return job.weights
    } catch (err) {
      job.error = err.message
      throw err
    } finally { await release(); told() }
  }

  /** `Use the newer model`: the staged files load once through Laya, then replace the current ones. */
  async function applyWeights() {
    const release = await takeInstallLock(paths, { pid, alive })
    const wasRunning = !!sidecar?.isReady?.()
    try {
      step(6, 'Switching to the newer Laya model')
      if (!existsSync(paths.hfStaging)) throw new StepError('No newer model has been downloaded; choose Check for a newer model first.')
      if ((sidecar?.held?.() ?? []).some((k) => k.startsWith('run:'))) throw new StepError('Laya is deciding for an open Laya Auto run; stop that run first.')
      const got = await fetchWeights(paths.venv, { hf: paths.hfStaging, record: false })
      sidecar?.suspend?.()
      await sidecar?.stop?.({ reason: 'update' })
      if (existsSync(paths.hf)) await renameRetry(paths.hf, paths.hfOld, { rename, sleep })
      await renameRetry(paths.hfStaging, paths.hf, { rename, sleep })
      await rmRetry(paths.hfOld, { sleep, remove }).catch(() => {})
      const at = new Date(now()).toISOString()
      const rec = await recordWeights(paths, { repo: pins.weights.repo, commit: got.commit, downloadedAt: at, loadedAt: at })
      job.done = true
      say(`Laya now uses model ${rec.commit.slice(0, 7)}.`)
      return rec
    } catch (err) {
      job.error = err.message
      throw err
    } finally {
      sidecar?.resume?.()
      if (wasRunning) sidecar?.start?.({ reason: 'update' })?.catch?.(() => {})
      await release()
      told()
    }
  }

  return {
    paths,
    /** install.log once every line so far is written. */
    logged: () => installLog.flushed(),
    /** The job running or last finished, and what recover() did. */
    status: () => ({ job: job ? { ...job, lines: job.lines.slice(-50) } : null, running: !!running, message }),
    install: ({ device = 'gpu', skipWeights, torchIndex } = {}) => launch('install', () => build({ device, update: false, skipWeights, torchIndex }), { device }),
    update: ({ device } = {}) => launch('update', () => build({ device: device ?? (sidecar?.installed?.()?.cuda === false ? 'cpu' : 'gpu'), update: true }), { device }),
    repair: () => launch('repair', repairWeights),
    remove: () => launch('remove', removeAll),
    checkWeights: () => launch('weights', checkWeights),
    applyWeights: () => launch('weights', applyWeights),
    cancel() { abort?.abort() },
    recover,
    /** Whether the pinned Laya or lock differs from what is installed (7.10). */
    updateWanted(installed) {
      if (!installed) return false
      try { return installed.laya !== pins.laya || !String(installed.torch ?? '').startsWith(pins.torch.version) || (installed.lockSha256 && installed.lockSha256 !== createHash('sha256').update(readFileSync(paths.requirementsLock)).digest('hex')) } catch { return false }
    },
  }
}

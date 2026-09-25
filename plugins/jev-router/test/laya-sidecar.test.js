// Laya's sidecar (docs/laya-auto.md 7.4 to 7.9), with the fake laya.serve as the interpreter: the
// sidecar asks for Laya's venv python, and the test runs the fake in its place with exactly the
// command line, folder and environment it was given. What it starts, when it counts as ready, what
// Laya's own lines tell it, the state table every caller reads, restarts and failures, holds and
// the idle stop, the port allocator, the orphan sweep, the GPU's room and spill, and the settings.
import { LAYA_TEXT, LayaUnavailable, createLayaSidecar, findInterpreter, parseServeLine, processInfo, readyLine, startingLine } from '../laya-sidecar.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layaPaths, readPins, recordWeights, snapshotDir } from '../laya-install.js'
import { createProbe } from '../laya-selfcheck.js'
import { createLayaClient } from '../laya-client.js'
import { createJev } from '../jev.js'
import { resolveProviders } from '../providers.js'
import { createResidency } from '../residency.js'
import { defaultThreads, killTree } from '../local.js'
import { startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-laya-serve.mjs', import.meta.url))
const PINS = readPins(REPO)
const COMMIT = '1a2b3c4d5e6f7a8b9c0d'.padEnd(40, '0')
const GPU = 'NVIDIA GeForce RTX 3050 Laptop GPU'
const SPECS = { cpu: { name: 'Test CPU', cores: 6, threads: 12 }, cuda: 12.8 }
const HEX48 = /^[0-9a-f]{48}$/

/** Laya installed on a PC of its own: the venv's interpreter, installed.json and a recorded snapshot. */
async function harness({ cuda = false } = {}) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'laya-sidecar-'))
  const dataDir = join(harnessDir, 'data')
  const paths = layaPaths({ harnessDir, dataDir })
  mkdirSync(dirname(paths.pythonOf(paths.venv)), { recursive: true })
  writeFileSync(paths.pythonOf(paths.venv), '')
  writeFileSync(paths.installed, JSON.stringify({ laya: '0.3.20', torch: cuda ? '2.14.0+cu128' : '2.14.0+cpu', torchIndex: cuda ? 'cu128' : 'pypi', cuda, gpu: cuda ? GPU : null, python: '3.12.11', uv: '0.12.18' }))
  const snap = snapshotDir(paths.hf, PINS.weights.repo, COMMIT)
  mkdirSync(join(snap, 'tokenizer'), { recursive: true })
  writeFileSync(join(snap, 'model.safetensors'), 'weights')
  writeFileSync(join(snap, 'rl_agent_config.json'), '{}')
  writeFileSync(join(snap, 'tokenizer', 'tokenizer_config.json'), '{"tokenizer_class":"PreTrainedTokenizerFast"}')
  await recordWeights(paths, { repo: PINS.weights.repo, commit: COMMIT, downloadedAt: 'then', loadedAt: 'then' })
  return { harnessDir, dataDir, paths }
}

/**
 * The fake as the interpreter: every spawn is recorded as the sidecar asked for it, and the fake runs
 * with that command line, folder and environment. `env(i)` adds the fake's own knobs to the i-th
 * start; `before(i, opts)` runs just before it.
 */
function interpreter({ env = () => ({}), before } = {}) {
  const spawned = []
  const spawn = (cmd, args, opts) => {
    const i = spawned.length
    before?.(i, opts)
    const child = nodeSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, ...env(i, opts) } })
    spawned.push({ cmd, args, opts, child })
    return child
  }
  return { spawn, spawned }
}

/** A port the OS says is free, as the first one this sidecar tries, so files running at once never meet. */
const basePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

/** nvidia-smi as the sidecar reads it: free, used and total MiB, and the name. */
function gpu({ free = 3500, used = 596, total = 4096 } = {}) {
  const g = { free, used, total, calls: [] }
  g.run = async (cmd, args) => {
    g.calls.push([cmd, ...args])
    return cmd === 'nvidia-smi' ? `${g.free}, ${g.used}, ${g.total}, ${GPU}\n` : null
  }
  return g
}

async function sidecarFor(t, h, { config = {}, timing = {}, ...deps } = {}) {
  const logs = []
  const states = []
  const sidecar = createLayaSidecar({
    harnessDir: h.harnessDir, dataDir: h.dataDir, pins: PINS,
    config: { port: await basePort(), ...config },
    specs: async () => SPECS, probe: (conn) => createProbe(conn),
    log: (l) => logs.push(l), onChange: ({ state }) => states.push(state),
    run: async () => null,
    timing: { readyPollMs: 40, healthTimeoutMs: 500, idleCheckMs: 20, exitWaitMs: 5000, ...timing },
    ...deps,
  })
  t.after(() => sidecar.dispose())
  return { sidecar, logs, states }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const exited = (child) => child.exitCode !== null || child.signalCode !== null

/** Poll `read` until `ok` holds or `ms` has passed, and return the last value either way, for an assertion to judge. */
async function settle(read, ok, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    let value
    try { value = read() } catch { value = undefined }
    if (ok(value) || Date.now() >= deadline) return value
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('Laya\'s own lines: the three device lines, the reason under the second, the temperature warning and a taken port', () => {
  assert.deepEqual(parseServeLine('Warning: CUDA requested but not available. Falling back to CPU.'), { device: 'cpu', why: 'PyTorch found no usable CUDA when Laya started' })
  assert.deepEqual(parseServeLine('[laya] Warning: could not place the model on cuda, so it is running on CPU.'), { device: 'cpu', why: 'the model could not be placed on the GPU', placing: true })
  assert.deepEqual(parseServeLine('  Reason: CUDA out of memory. Tried to allocate 64.00 MiB. GPU 0 has a total capacity of 4.00 GiB'), { reason: 'CUDA out of memory' })
  // Printed for any runtime error that mentions memory or cuda, a context broken by sleep included:
  // never read as plain "out of memory".
  assert.deepEqual(parseServeLine('Warning: GPU memory exceeded during inference. Falling back to CPU...'), { device: 'cpu', why: 'the GPU failed during inference (out of memory, or a CUDA error such as after sleep or hibernation)' })
  const temps = parseServeLine('/venv/lib/python3.12/site-packages/laya/router.py:260: RuntimeWarning: laya: this checkpoint ships invalid temperatures or values outside [0.5, 5]; using choice:11+=0.1006 -> 0.5. Treat confidence from the affected entries as uncalibrated.')
  assert.deepEqual(temps.warning.entries, ['choice:11+=0.1006 -> 0.5'])
  assert.equal(temps.warning.text, LAYA_TEXT.temperatures)
  assert.deepEqual(parseServeLine("ERROR:    [Errno 98] error while attempting to bind on address ('127.0.0.1', 8091): address already in use"), { bind: true })
  assert.equal(parseServeLine('INFO:     Started server process [1234]'), null)
  assert.equal(startingLine({ device: 'cuda', elapsedMs: 12_400, lastMs: 41_000 }), 'Starting Laya on this PC: loading the model on the GPU (12 s; the last start took 41 s)…')
  assert.equal(startingLine({ device: 'cpu', elapsedMs: 0 }), 'Starting Laya on this PC: loading the model on the CPU (0 s)…')
  assert.equal(readyLine({ device: 'cuda', loadMs: 41_200 }), 'Laya is ready on the GPU (loaded in 41 s)')
})

test('laya.serve is started as the official entry point, from an empty folder, with its environment and none of the person\'s secrets', async (t) => {
  const saved = Object.fromEntries(['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'].map((k) => [k, process.env[k]]))
  Object.assign(process.env, { TYPESAFE_API_KEY: 'tsk_the_persons_own_secret', TYPESAFE_BASE_URL: 'https://jev.example', HF_TOKEN: 'hf_secret', HUGGING_FACE_HUB_TOKEN: 'hf_secret_older_name' })
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const h = await harness()
  let budget = { maxCores: null }
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, readBudget: async () => budget })
  mkdirSync(h.paths.run, { recursive: true })
  writeFileSync(join(h.paths.run, 'convaiinnovations'), 'a relative path Laya would read as its model')
  const conn = await sidecar.ensureReady()
  const [first] = fake.spawned
  assert.equal(first.cmd, h.paths.pythonOf(h.paths.venv))
  assert.deepEqual(first.args, ['-I', '-u', '-X', 'utf8', '-m', 'laya.serve'])
  assert.equal(first.opts.cwd, h.paths.run)
  assert.deepEqual(readdirSync(h.paths.run), [], 'it runs from a folder that is always empty')
  assert.equal(first.opts.windowsHide, true)
  const env = first.opts.env
  assert.deepEqual(
    Object.fromEntries(['LAYA_HOST', 'LAYA_MODELS', 'LAYA_PRELOAD', 'LAYA_DEVICE', 'LAYA_AUTO_TASK', 'LAYA_LOG_LEVEL', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY', 'TOKENIZERS_PARALLELISM'].map((k) => [k, env[k]])),
    { LAYA_HOST: '127.0.0.1', LAYA_MODELS: 'english', LAYA_PRELOAD: '1', LAYA_DEVICE: 'cpu', LAYA_AUTO_TASK: '0', LAYA_LOG_LEVEL: 'warning', HF_HOME: h.paths.hf, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
  )
  assert.match(env.LAYA_API_KEY, HEX48)
  assert.deepEqual(Object.keys(env).filter((k) => /^TYPESAFE_/i.test(k) || k === 'HF_TOKEN' || k === 'HUGGING_FACE_HUB_TOKEN'), [], 'no TypeSafe setting and no Hugging Face token, under either name, reaches the child')
  assert.equal(env.LAYA_THREADS, String(defaultThreads(SPECS.cpu)), 'no core budget: the thread default local.js uses for llama')
  assert.deepEqual(conn, { url: `http://127.0.0.1:${env.LAYA_PORT}`, key: env.LAYA_API_KEY, device: 'cpu', pid: first.child.pid })
  assert.deepEqual(sidecar.connection(), conn)
  const record = JSON.parse(readFileSync(h.paths.sidecarJson, 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['interpreterPath', 'interpreterPid', 'pid', 'port', 'startedAt'])
  assert.deepEqual([record.pid, record.interpreterPid, record.port], [first.child.pid, first.child.pid, Number(env.LAYA_PORT)])
  assert.ok(!readFileSync(h.paths.sidecarJson, 'utf8').includes(env.LAYA_API_KEY), 'the key is never written down')

  // A core budget is a cap: never more threads than the machine has.
  for (const [maxCores, want] of [[3, '3'], [64, '12']]) {
    budget = { maxCores }
    await sidecar.stop()
    await sidecar.start()
    assert.equal(fake.spawned.at(-1).opts.env.LAYA_THREADS, want, `maxCores ${maxCores}`)
  }
  const keys = fake.spawned.map((s) => s.opts.env.LAYA_API_KEY)
  assert.equal(new Set(keys).size, 3, 'a new key on every start')
  assert.ok(keys.every((k) => HEX48.test(k)))
})

test('ready means English loaded and a warm-up answered with this start\'s key: another server on the port is not ready, and a taken port is retried once on the next, uncounted', async (t) => {
  const h = await harness()
  let foreign = null
  const seen = []
  const fake = interpreter({
    env: () => ({ FAKE_LAYA_LOAD_MS: '1500' }),
    // Between the reservation and laya.serve's bind, which it does only after loading, something
    // else takes the port and answers /health as a loaded Laya would, with another key.
    before: (i, opts) => { if (i === 0) foreign = startFakeLaya({ port: Number(opts.env.LAYA_PORT), apiKey: 'someone-elses-key' }) },
  })
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, onChange: ({ state }) => seen.push([state, fake.spawned.length]) })
  const conn = await sidecar.ensureReady()
  const other = await foreign
  t.after(() => other.close())
  assert.equal(fake.spawned.length, 2)
  assert.ok(other.requests.length > 0, 'the other server was asked')
  assert.ok(other.requests.every((r) => r.authorization === `Bearer ${fake.spawned[0].opts.env.LAYA_API_KEY}` && r.status === 401), 'with this start\'s key, and refused')
  assert.deepEqual(seen.filter(([s]) => s === 'ready'), [['ready', 2]], 'never ready on the other server\'s answers')
  assert.notEqual(conn.url, `http://127.0.0.1:${other.port}`)
  assert.equal(conn.url, `http://127.0.0.1:${fake.spawned[1].opts.env.LAYA_PORT}`)
  assert.ok(logs.includes(`laya: port ${other.port} was taken before laya.serve could bind it; trying the next port`), logs.join('\n'))
  assert.deepEqual([sidecar.status().state, sidecar.status().restart, sidecar.status().why], ['ready', null, null], 'not a failure, not a restart')
})

test('a taken port is retried once only: the second bind failure fails the start', async (t) => {
  const h = await harness()
  const blockers = []
  t.after(() => { for (const b of blockers) b.close() })
  const fake = interpreter({
    env: () => ({ FAKE_LAYA_LOAD_MS: '200' }),
    before: (i, opts) => { const s = createServer().listen(Number(opts.env.LAYA_PORT), '127.0.0.1'); blockers.push(s) },
  })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.couldNotStart('laya.serve exited before it was ready (exit code 1)') })
  assert.equal(fake.spawned.length, 2)
  const s = sidecar.status()
  assert.equal(s.state, 'failed')
  assert.ok(s.logTail.some((l) => /address already in use/.test(l)), s.logTail.join('\n'))
})

test('the first start per device and identity measures every phase with the full warm-up; later starts send the intent probes only', async (t) => {
  const h = await harness({ cuda: true })
  const g = gpu()
  const warmUps = []
  const fake = interpreter()
  const probe = (conn) => { const p = createProbe(conn); return { ...p, warmUp: (o) => { warmUps.push([conn.device, o.full]); return p.warmUp(o) } } }
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, probe, run: g.run })
  const measuredOf = (d) => sidecar.readSettings().measured[d]
  await sidecar.setSettings({ device: 'cpu' })
  await sidecar.start()
  assert.deepEqual(warmUps, [['cpu', true]])
  assert.ok(['intent', 'route', 'review'].every((p) => measuredOf('cpu').msPerToken[p] > 0), JSON.stringify(measuredOf('cpu')))
  assert.equal(measuredOf('cpu').identity, `laya-0.3.20|english|${COMMIT.slice(0, 12)}|adapter-1`)
  assert.ok(measuredOf('cpu').ramGB > 0, 'the RAM the warm-up took')
  assert.equal(measuredOf('cpu').loadMs.length, 1)
  assert.equal(sidecar.status().running.measuring, false)
  await sidecar.stop()
  await sidecar.start()
  assert.deepEqual(warmUps.at(-1), ['cpu', false], 'measured already on this device')
  // Another device has figures of its own.
  await sidecar.stop()
  await sidecar.setSettings({ device: 'auto' })
  await sidecar.start()
  assert.equal(fake.spawned.at(-1).opts.env.LAYA_DEVICE, 'cuda')
  assert.deepEqual(warmUps.at(-1), ['cuda', true])
  assert.ok(measuredOf('cuda').msPerToken.route > 0)
  // Another Laya version is another identity: measured again.
  await sidecar.stop()
  writeFileSync(h.paths.installed, JSON.stringify({ laya: '0.3.21', torch: '2.14.0+cu128', cuda: true, gpu: GPU }))
  sidecar.noteInstall(null)
  await sidecar.start()
  assert.deepEqual(warmUps.at(-1), ['cuda', true])
  assert.match(measuredOf('cuda').identity, /^laya-0\.3\.21\|/)
  // The figures are kept in laya.json for the next session.
  assert.deepEqual(JSON.parse(readFileSync(h.paths.settings, 'utf8')).measured.cpu.msPerToken, measuredOf('cpu').msPerToken)
})

test('Laya\'s device lines move it to the CPU with the reason, however it says so; its temperature warning is kept', async (t) => {
  for (const [print, why] of [
    ['no-cuda', 'PyTorch found no usable CUDA when Laya started'],
    ['cpu-fallback', 'the model could not be placed on the GPU (CUDA out of memory)'],
    ['gpu-oom', 'the GPU failed during inference (out of memory, or a CUDA error such as after sleep or hibernation)'],
  ]) {
    const h = await harness({ cuda: true })
    const fake = interpreter({ env: () => ({ FAKE_LAYA_PRINT: `${print},temps` }) })
    const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, run: gpu().run })
    const conn = await sidecar.ensureReady()
    assert.equal(fake.spawned[0].opts.env.LAYA_DEVICE, 'cuda', 'asked for the GPU')
    const { running, warnings } = sidecar.status()
    assert.deepEqual([running.device, running.deviceWhy], ['cpu', why], print)
    assert.equal(conn.device, 'cpu')
    assert.ok(logs.includes(`laya: now on the CPU: ${why.replace(' (CUDA out of memory)', '')}`), logs.join('\n'))
    assert.deepEqual(warnings.map((w) => [w.kind, w.entries]), [['temperatures', ['choice:11+=0.1006 -> 0.5']]])
    await sidecar.dispose()
  }
})

test('refused before anything runs: not installed, a first install under way or failed, switched off, invalid settings', async (t) => {
  const cases = [
    ['not installed', (h) => rmSync(h.paths.installed), {}, 'not_installed', LAYA_TEXT.notInstalled],
    ['installing', (h) => rmSync(h.paths.pythonOf(h.paths.venv)), {}, 'installing', LAYA_TEXT.notInstalled, { kind: 'install', step: 3, of: 8, name: 'Getting Python 3.12' }],
    ['install failed, nothing installed', (h) => rmSync(h.paths.installed), {}, 'install_failed', LAYA_TEXT.notInstalled, { kind: 'install', step: 4, error: 'no wheel', finishedAt: 1 }],
    ['switched off', () => {}, { config: { enabled: false } }, 'disabled', LAYA_TEXT.disabled],
    ['invalid settings', () => {}, { configError: 'providers: laya.thresholds.accept: low 0.9 is above medium 0.8' }, 'disabled', LAYA_TEXT.invalid('providers: laya.thresholds.accept: low 0.9 is above medium 0.8')],
  ]
  for (const [what, prepare, deps, state, text, job] of cases) {
    const h = await harness()
    prepare(h)
    const fake = interpreter()
    const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, ...deps, config: { ...deps.config } })
    if (job) sidecar.noteInstall(job)
    assert.equal(sidecar.status().state, state, what)
    await assert.rejects(sidecar.ensureReady(), (err) => err instanceof LayaUnavailable && err.message === text, what)
    sidecar.warm()
    await assert.rejects(sidecar.start(), { message: text })
    await sidecar.stop()
    assert.equal(fake.spawned.length, 0, `${what}: nothing started`)
    if (deps.configError) assert.equal(sidecar.status().configError, deps.configError)
  }
})

test('install_failed over an install that is there reads as that install\'s own state: stopped, so it starts', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  sidecar.noteInstall({ kind: 'update', step: 5, of: 8, name: 'Installing Laya 0.3.20', error: 'uv pip check failed', finishedAt: 1 })
  assert.equal(sidecar.status().state, 'install_failed')
  await sidecar.ensureReady()
  assert.equal(fake.spawned.length, 1)
  assert.equal(sidecar.status().state, 'ready')
})

test('stopped: ensureReady starts it and waits, with the starting line every few seconds and the ready line; warm() starts it too', async (t) => {
  const h = await harness()
  const fake = interpreter({ env: () => ({ FAKE_LAYA_LOAD_MS: '700' }) })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, timing: { waitLineMs: 150 } })
  const lines = []
  await sidecar.ensureReady({ onWait: (l) => lines.push(l) })
  const starting = lines.slice(0, -1)
  assert.ok(starting.length >= 3, lines.join('\n'))
  assert.ok(starting.every((l) => /^Starting Laya on this PC: loading the model on the CPU \(\d+ s\)…$/.test(l)), starting.join('\n'))
  assert.match(lines.at(-1), /^Laya is ready on the CPU \(loaded in \d+ s\)$/)
  await sidecar.stop()
  assert.equal(sidecar.status().state, 'stopped')
  // The second wait knows how long the last start took.
  const again = []
  await sidecar.ensureReady({ onWait: (l) => again.push(l) })
  assert.match(again[0], /^Starting Laya on this PC: loading the model on the CPU \(\d+ s; the last start took \d+ s\)…$/)
  await sidecar.stop()
  sidecar.warm()
  await waitFor('warm() started it', () => sidecar.status().state, (s) => s === 'ready', { timeoutMs: 20_000 })
  assert.equal(fake.spawned.length, 3)
})

test('a wait says what it waits for: a stop under way, then the load of the new process timed from its launch; the pause before a restart, never a load', async (t) => {
  // A stop that takes a moment (an idle stop, a yield), as a message arrives.
  const h = await harness()
  const fake = interpreter()
  const slowKill = (pid) => { setTimeout(() => killTree(pid), 700) }
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, killTree: slowKill, timing: { waitLineMs: 100 } })
  await sidecar.start()
  const idle = sidecar.stop({ reason: 'idle' })
  const lines = []
  await sidecar.ensureReady({ onWait: (l) => lines.push(l) })
  await idle
  const stopping = lines.filter((l) => l === 'Waiting for Laya to finish stopping, then starting it…')
  assert.ok(stopping.length >= 3, lines.join('\n'))
  assert.deepEqual(lines.slice(0, stopping.length), stopping, 'first the stop, and nothing of a load')
  const loading = lines.slice(stopping.length, -1)
  assert.ok(loading.every((l) => /^Starting Laya on this PC: loading the model on the CPU \(\d+ s; the last start took \d+ s\)…$/.test(l)), loading.join('\n'))
  assert.ok(loading.every((l) => Number(/\((\d+) s;/.exec(l)[1]) <= 1), `the load is timed from this start's launch, not the stopped process's: ${loading.join(' | ')}`)
  assert.match(lines.at(-1), /^Laya is ready on the CPU/)

  // A crash, and a message during the pause before the restart.
  const h2 = await harness()
  const fake2 = interpreter()
  const { sidecar: second } = await sidecarFor(t, h2, { spawn: fake2.spawn, timing: { waitLineMs: 100, backoffMs: [1200, 1200, 1200] } })
  await second.start()
  fake2.spawned[0].child.kill('SIGKILL')
  await waitFor('restarting', () => second.status().state, (s) => s === 'restarting')
  const again = []
  await second.ensureReady({ onWait: (l) => again.push(l) })
  const pausing = again.filter((l) => l.startsWith('Laya stopped unexpectedly'))
  assert.ok(pausing.length >= 3, again.join('\n'))
  assert.ok(pausing.every((l) => /^Laya stopped unexpectedly \(signal SIGKILL\); restarting it in [12] s \(attempt 1 of 3\)…$/.test(l)), pausing.join('\n'))
  assert.deepEqual(again.slice(0, pausing.length), pausing, 'the pause first, and no load said while nothing loads')
  assert.match(again.at(-1), /^Laya is ready on the CPU/)
})

test('starting: ensureReady joins the start and warm() adds nothing; Stop stops it, unless a Laya Auto run holds it', async (t) => {
  const h = await harness()
  const fake = interpreter({ env: () => ({ FAKE_LAYA_LOAD_MS: '1200' }) })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  const first = sidecar.start()
  await waitFor('starting', () => sidecar.status().state, (s) => s === 'starting')
  const joined = sidecar.ensureReady()
  sidecar.warm()
  assert.deepEqual(await joined, await first)
  assert.equal(fake.spawned.length, 1, 'one start')

  await sidecar.stop()
  sidecar.hold('run:abc')
  const held = sidecar.start()
  await waitFor('a process to stop', () => fake.spawned.length, (n) => n === 2)
  await assert.rejects(sidecar.stop(), { message: LAYA_TEXT.stopWhileHeld })
  await held
  sidecar.release('run:abc')
  await sidecar.stop()
  const unheld = sidecar.start()
  unheld.catch(() => {})
  // Stopped while loading: the start ends without a failure, and nothing is left running.
  await waitFor('the third process to spawn', () => fake.spawned.length, (n) => n === 3)
  await sidecar.stop()
  await assert.rejects(unheld, /it was stopped/)
  assert.equal(sidecar.status().state, 'stopped')
  await waitFor('the loading process to be gone', () => fake.spawned[2].child.exitCode ?? fake.spawned[2].child.signalCode, (x) => x !== null)
})

test('ready: ensureReady answers at once and warm() adds nothing; Stop is refused while a Laya Auto run holds it, and stops it otherwise', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn })
  const conn = await sidecar.ensureReady()
  const lines = []
  assert.deepEqual(await sidecar.ensureReady({ onWait: (l) => lines.push(l) }), conn)
  assert.deepEqual(lines, [], 'no waiting, no line')
  sidecar.warm()
  sidecar.hold('run:1')
  sidecar.hold('selftest')
  assert.deepEqual(sidecar.held(), ['run:1', 'selftest'])
  await assert.rejects(sidecar.stop(), { message: 'Laya is deciding for an open Laya Auto run; stop that run first.' })
  await assert.rejects(sidecar.restart(), { message: 'Laya is deciding for an open Laya Auto run; stop that run first.' })
  assert.equal(sidecar.status().state, 'ready')
  sidecar.release('run:1')
  await sidecar.stop()
  assert.equal(fake.spawned.length, 1)
  assert.equal(sidecar.status().state, 'stopped')
  assert.ok(!alive(conn.pid) || fake.spawned[0].child.exitCode !== null || fake.spawned[0].child.signalCode !== null)
  assert.ok(!existsSync(h.paths.sidecarJson), 'nothing recorded once it has stopped')
  assert.ok(logs.includes('laya: stopped (user)'), logs.join('\n'))
})

test('restarting: after an unexpected exit ensureReady waits for the restart, warm() adds nothing, and Stop ends the backoff', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, timing: { backoffMs: [300, 300, 300] } })
  await sidecar.start()
  fake.spawned[0].child.kill('SIGKILL')
  await waitFor('restarting', () => sidecar.status().state, (s) => s === 'restarting')
  assert.deepEqual(sidecar.status().restart, { attempt: 1, of: 3, code: null, signal: 'SIGKILL' })
  assert.ok(logs.includes('laya: exited (signal SIGKILL); restarting (1 of 3)'), logs.join('\n'))
  sidecar.warm()
  const conn = await sidecar.ensureReady()
  assert.equal(conn.pid, fake.spawned[1].child.pid)
  assert.equal(fake.spawned.length, 2)
  fake.spawned[1].child.kill('SIGKILL')
  await waitFor('restarting again', () => sidecar.status().state, (s) => s === 'restarting')
  await sidecar.stop()
  assert.equal(sidecar.status().state, 'stopped')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(fake.spawned.length, 2, 'the backoff ended: no restart after the Stop')
})

test('stopping: ensureReady and warm() wait for the exit, then start it', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  const stopping = sidecar.stop()
  assert.equal(sidecar.status().state, 'stopping')
  const back = sidecar.ensureReady()
  await stopping
  const conn = await back
  assert.equal(conn.pid, fake.spawned[1].child.pid)
  const again = sidecar.stop()
  sidecar.warm()
  await again
  await waitFor('warm() started it after the exit', () => sidecar.status().state, (s) => s === 'ready', { timeoutMs: 20_000 })
  assert.equal(fake.spawned.length, 3)
})

test('a start that fails is failed until Start, with its reason and last lines, and never enters the backoff', async (t) => {
  const h = await harness()
  let broken = true
  const fake = interpreter({ env: () => (broken ? { FAKE_LAYA_LOAD_MS: '3000', FAKE_LAYA_EXIT_AFTER_MS: '150', FAKE_LAYA_PRINT: 'temps' } : {}) })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  const reason = 'laya.serve exited before it was ready (exit code 1)'
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.couldNotStart(reason) })
  const s = sidecar.status()
  assert.deepEqual([s.state, s.why], ['failed', reason])
  assert.ok(s.logTail.some((l) => /invalid temperatures/.test(l)), 'the last lines of the log come with it')
  await waitFor('laya-serve.log has its lines', () => (existsSync(h.paths.serveLog) ? readFileSync(h.paths.serveLog, 'utf8') : ''), (t) => /invalid temperatures/.test(t))
  assert.match(readFileSync(h.paths.serveLog, 'utf8'), /^--- \S+ laya\.serve starting on 127\.0\.0\.1:\d+ \(cpu, 4 threads\)$/m)
  assert.ok(sidecar.logTail().some((l) => /invalid temperatures/.test(l)), 'and in the tail GET /jev-router/laya/log serves')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(fake.spawned.length, 1, 'no restart')
  // Sticky: every caller is refused at once, and nothing starts it but the person.
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.failed(reason) })
  sidecar.warm()
  assert.equal(fake.spawned.length, 1)
  assert.equal(sidecar.status().state, 'failed')
  broken = false
  await sidecar.start()
  assert.equal(sidecar.status().state, 'ready')
  assert.equal(fake.spawned.length, 2)
})

test('a Stop or an exit while the warm-up takes its last readings ends the start: never ready over a Laya that is gone, and nothing left in the residency', async (t) => {
  /** A start whose working-set reading, the warm-up's last step, waits until the test lets it go. */
  async function heldAtTheReading() {
    const h = await harness()
    const fake = interpreter()
    const residency = createResidency()
    let reading = null
    let release
    const gate = new Promise((r) => { release = r })
    const { sidecar, logs } = await sidecarFor(t, h, {
      spawn: fake.spawn, residency,
      readWorkingSet: async () => { reading = true; await gate; return 1.9 * 1024 ** 3 },
    })
    const started = sidecar.start()
    started.catch(() => {})
    await waitFor('the warm-up reads the working set', () => reading, (r) => r === true, { timeoutMs: 20_000 })
    return { sidecar, logs, fake, residency, started, release }
  }

  // Stop pressed while the working set is read.
  const a = await heldAtTheReading()
  const stopped = a.sidecar.stop()
  a.release()
  await stopped
  await assert.rejects(a.started, { message: 'it was stopped' })
  assert.equal(a.sidecar.status().state, 'stopped')
  assert.equal(a.sidecar.status().running, null)
  assert.equal(a.sidecar.isReady(), false)
  assert.equal(a.residency.get('laya'), null, 'no Laya left in the residency for a local model to be sized around')
  assert.ok(!a.logs.some((l) => l.startsWith('laya: ready')), a.logs.join('\n'))
  assert.equal(a.fake.spawned.length, 1)

  // The interpreter dies while the working set is read.
  const b = await heldAtTheReading()
  const child = b.fake.spawned[0].child
  child.kill('SIGKILL')
  await waitFor('the interpreter is gone', () => exited(child), (x) => x === true)
  b.release()
  await assert.rejects(b.started, { message: 'laya.serve exited before it was ready (signal SIGKILL)' })
  assert.deepEqual([b.sidecar.status().state, b.sidecar.status().why], ['failed', 'laya.serve exited before it was ready (signal SIGKILL)'])
  assert.equal(b.sidecar.connection(), null, 'no call is handed the dead connection')
  assert.equal(b.residency.get('laya'), null)
  await assert.rejects(b.sidecar.ensureReady(), { message: LAYA_TEXT.failed('laya.serve exited before it was ready (signal SIGKILL)') })
})

test('a ready Laya that exits is restarted at once, then after a pause, then a longer one, and failed at the fourth exit within ten minutes', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, timing: { backoffMs: [0, 100, 200] } })
  await sidecar.start()
  for (let n = 1; n <= 3; n++) {
    fake.spawned[n - 1].child.kill('SIGKILL')
    await waitFor(`restart ${n}`, () => [fake.spawned.length, sidecar.status().state], ([k, s]) => k === n + 1 && s === 'ready', { timeoutMs: 20_000 })
    assert.ok(logs.includes(`laya: exited (signal SIGKILL); restarting (${n} of 3)`), logs.join('\n'))
  }
  fake.spawned[3].child.kill('SIGKILL')
  await waitFor('failed', () => sidecar.status().state, (s) => s === 'failed')
  assert.match(sidecar.status().why, /^laya\.serve exited 4 times in 10 minutes \(last: signal SIGKILL\)$/)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(fake.spawned.length, 4, 'no fifth start')
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.failed(sidecar.status().why) })
})

test('a call an exit cut off says the exit and whether Laya is restarting: restarting after the first three, stopped until Start after the fourth', async (t) => {
  const h = await harness()
  const fake = interpreter({ env: () => ({ FAKE_LAYA_MS_PER_ROW: '300' }) })
  let client = null
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, isBusy: () => client?.busy() ?? false, timing: { backoffMs: [0, 100, 200] } })
  client = createLayaClient({ sidecar, settings: { deadlines: { floorMs: 30_000, ceilingMs: 60_000, hardMs: 60_000 } } })
  t.after(() => client.dispose())
  const jev = createJev({ provider: resolveProviders({}, {}).laya, client: client.client('act') })
  const said = []
  for (let n = 1; n <= 4; n++) {
    const call = jev.intent({ message: 'Fix the failing test in the parser' })
    call.catch(() => {})
    await waitFor(`call ${n} on the wire`, () => client.busy(), (b) => b === true, { timeoutMs: 20_000 })
    fake.spawned.at(-1).child.kill('SIGKILL')
    said.push(await call.then(() => 'answered', (err) => err.message))
  }
  assert.deepEqual(said, [
    ...Array(3).fill('Laya stopped while answering (signal SIGKILL); it is restarting'),
    'Laya stopped while answering and will not restart until Start is pressed: laya.serve exited 4 times in 10 minutes (last: signal SIGKILL)',
  ])
  assert.equal(sidecar.status().state, 'failed')
  assert.deepEqual(fake.spawned.length, 4, 'and nothing restarted it')
})

test('the exit the supervisor restarted Laya from is kept in status() with its code and signal', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  fake.spawned[0].child.kill('SIGKILL')
  await waitFor('restarted after the exit', () => [fake.spawned.length, sidecar.status().state], ([n, st]) => n === 2 && st === 'ready', { timeoutMs: 20_000 })
  const { kind, why, code, signal } = sidecar.status().lastRestart
  assert.deepEqual({ kind, why, code, signal }, { kind: 'exit', why: 'signal SIGKILL', code: null, signal: 'SIGKILL' })
})

test('the device: the GPU when it has room, else the CPU with the numbers; Restart on the GPU with no room refuses and leaves the CPU instance running', async (t) => {
  const h = await harness({ cuda: true })
  const g = gpu({ free: 900, used: 3196 })
  const fake = interpreter()
  const res = createResidency()
  let budget = {}
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, run: g.run, residency: res, readBudget: async () => budget })
  await sidecar.start()
  const why = 'the GPU had 0.9 GB free and Laya needs about 2.5 GB'
  assert.deepEqual([sidecar.status().running.device, sidecar.status().running.deviceWhy], ['cpu', why])
  assert.equal(fake.spawned[0].opts.env.LAYA_DEVICE, 'cpu')
  const pid = sidecar.connection().pid
  await assert.rejects(sidecar.restart({ device: 'gpu' }), { message: `Laya stays on the CPU: ${why}.` })
  assert.deepEqual([sidecar.status().state, sidecar.connection().pid, fake.spawned.length], ['ready', pid, 1], 'still the CPU instance')
  // With room, Restart on the GPU moves it.
  g.free = 3500
  await sidecar.restart({ device: 'gpu' })
  assert.deepEqual([sidecar.status().running.device, sidecar.status().running.deviceWhy], ['cuda', null])
  // A VRAM budget holds llama and Laya together: over it, Auto takes the CPU and says why.
  await sidecar.stop()
  res.set('llama', { pid: 1, startedAt: 1, name: 'qwen3-8b', held: () => true, busy: () => false, unload: async () => {}, ramGB: 1, vramGB: 1.2 })
  budget = { maxVramGB: 3 }
  await sidecar.start()
  assert.deepEqual([sidecar.status().running.device, sidecar.status().running.deviceWhy], ['cpu', 'the VRAM budget of 3 GB holds 1.2 GB for qwen3-8b, and Laya needs about 2.5 GB'])
  // Set to GPU with no room: it refuses to start, naming the numbers, rather than fall back on its own.
  await sidecar.stop()
  budget = {}
  g.free = 900
  await sidecar.setSettings({ device: 'gpu' })
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.refused(`Laya is set to run on the GPU, and ${why}`) })
})

test('a request busy past hardMs restarts it, with that said', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, isBusy: () => true, config: { deadlines: { hardMs: 1000 } }, timing: { healthEveryMs: 100 } })
  await sidecar.start()
  await waitFor('restarted', () => fake.spawned.length, (n) => n >= 2, { timeoutMs: 20_000 })
  assert.ok(logs.includes('laya: Laya spent over 1 s on one request and was restarted.'), logs.join('\n'))
})

test('the Laya client\'s restart of a request past hardMs is said as the supervisor\'s own, even while a Laya Auto run holds Laya', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, config: { deadlines: { hardMs: 270_000 } } })
  await sidecar.start()
  sidecar.hold('run-7')
  // What the client does when its hard ceiling fires, as laya-client.js classify() asks it.
  await sidecar.restart({ reason: 'hung' })
  await waitFor('running again', () => sidecar.status().state, (s) => s === 'ready', { timeoutMs: 20_000 })
  assert.equal(fake.spawned.length, 2, 'it was restarted')
  const { kind, why } = sidecar.status().lastRestart ?? {}
  assert.deepEqual([kind, why], ['hung', 'Laya spent over 270 s on one request and was restarted.'], 'and the card can say why (7.5)')
  assert.ok(logs.includes('laya: Laya spent over 270 s on one request and was restarted.'), logs.join('\n'))
  assert.deepEqual(sidecar.status().running.held, ['run:run-7'])
})

test('two HTTP 500s in a row restart it; one, or two apart, do not', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  await sidecar.noteResult({ status: 500, ms: 5, phase: 'route', role: 'act' })
  await sidecar.noteResult({ status: 200, ms: 5, tokens: 100, phase: 'route', role: 'act' })
  await sidecar.noteResult({ status: 500, ms: 5, phase: 'route', role: 'shadow' })
  assert.equal(fake.spawned.length, 1)
  await sidecar.noteResult({ status: 500, ms: 5, phase: 'route', role: 'shadow' })
  assert.equal(fake.spawned.length, 2)
  assert.equal(sidecar.status().state, 'ready')
  assert.ok(logs.includes('laya: two requests in a row failed (laya.serve gave no reason); restarting'), logs.join('\n'))
})

test('a second 401 in a row restarts it on a fresh port', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  const first = await sidecar.start()
  await sidecar.noteResult({ status: 401, ms: 3, phase: 'intent', role: 'act' })
  assert.equal(fake.spawned.length, 1, 'one 401 is the client\'s to retry, with a key rebuilt from connection()')
  await sidecar.noteResult({ status: 401, ms: 3, phase: 'intent', role: 'act' })
  assert.equal(fake.spawned.length, 2)
  const second = sidecar.connection()
  assert.notEqual(second.url, first.url, 'a server that is not this child answers on that port')
  assert.notEqual(second.key, first.key)
})

test('/health misses are not counted while a request is in flight; three in a row otherwise restart it', async (t) => {
  const h = await harness()
  const fake = interpreter()
  let busy = false
  let failHealth = false
  const fetch = (url, opts) => (failHealth && String(url).endsWith('/health') ? Promise.reject(new Error('no answer')) : globalThis.fetch(url, opts))
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, fetch, isBusy: () => busy, timing: { healthEveryMs: 40, healthMissTimeoutMs: 40 } })
  await sidecar.start()
  busy = true
  failHealth = true
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(fake.spawned.length, 1, 'ten misses while a request was in flight, none counted')
  busy = false
  await waitFor('restarted after three misses', () => fake.spawned.length, (n) => n === 2, { timeoutMs: 10_000 })
  failHealth = false
  assert.ok(logs.includes('laya: laya.serve did not answer /health 3 times in a row; restarting'), logs.join('\n'))
})

test('the weights are verified before anything is spawned', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  rmSync(join(snapshotDir(h.paths.hf, PINS.weights.repo, COMMIT), 'model.safetensors'))
  const why = "Laya's model files are not complete on this PC (model.safetensors is missing). Choose Repair, or copy models/laya/hf from another PC."
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.couldNotStart(why) })
  assert.equal(fake.spawned.length, 0)
  assert.deepEqual([sidecar.status().state, sidecar.status().why], ['failed', why])
})

test('the idle stop: after idleMinutes without an acting request, never reset by background requests, never while held', async (t) => {
  const h = await harness()
  let clock = 1_000_000
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, now: () => clock })
  await sidecar.setSettings({ idleMinutes: 1 })
  const settle = () => new Promise((r) => setTimeout(r, 120))
  await sidecar.start()
  // Background comparisons keep arriving: they never count as use.
  for (let i = 0; i < 5; i++) { clock += 12_000; await sidecar.noteResult({ status: 200, ms: 30, tokens: 900, phase: 'route', role: 'shadow' }); await settle() }
  assert.equal(sidecar.status().state, 'stopped', 'a minute of background requests only')
  assert.equal(sidecar.status().stoppedBecause, 'idle')

  await sidecar.start()
  clock += 50_000
  await sidecar.noteResult({ status: 200, ms: 30, tokens: 900, phase: 'route', role: 'act' })
  clock += 50_000
  await settle()
  assert.equal(sidecar.status().state, 'ready', '50 s since the acting request')
  clock += 10_001
  await waitFor('idle-stopped', () => sidecar.status().state, (s) => s === 'stopped')

  await sidecar.ensureReady()
  sidecar.hold('run:9')
  clock += 3_600_000
  await settle()
  assert.equal(sidecar.status().state, 'ready', 'held by an open Laya Auto run')
  sidecar.release('run:9')
  clock += 59_000
  await settle()
  assert.equal(sidecar.status().state, 'ready', 'the countdown starts again when the run ends')
  clock += 1_001
  await waitFor('idle-stopped after the run', () => sidecar.status().state, (s) => s === 'stopped')
})

test('Keep Laya loaded holds it; Start Laya when KzH starts warms it at start-up only when switched on; both are kept in laya.json', async (t) => {
  const h = await harness()
  let clock = 5_000_000
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, now: () => clock })
  sidecar.warm({ atStartup: true })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(fake.spawned.length, 0, 'off by default: nothing is loaded at start-up')
  await sidecar.setSettings({ startWithKzh: true, keepLoaded: true, idleMinutes: 1 })
  assert.deepEqual(sidecar.held(), ['keepLoaded'])
  sidecar.warm({ atStartup: true })
  await waitFor('warmed at start-up', () => sidecar.status().state, (s) => s === 'ready', { timeoutMs: 20_000 })
  clock += 24 * 3_600_000
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(sidecar.status().state, 'ready', 'kept loaded')
  assert.deepEqual(sidecar.status().running.held, ['keepLoaded'])
  const saved = JSON.parse(readFileSync(h.paths.settings, 'utf8'))
  assert.deepEqual([saved.startWithKzh, saved.keepLoaded, saved.idleMinutes, saved.device, saved.shadow], [true, true, 1, 'auto', true])
  await sidecar.setSettings({ keepLoaded: false })
  assert.deepEqual(sidecar.held(), [])
  clock += 60_001
  await waitFor('unloaded once nothing holds it', () => sidecar.status().state, (s) => s === 'stopped')
  // A new session reads the switches back, and Keep Laya loaded holds from the start.
  await sidecar.setSettings({ keepLoaded: true })
  const { sidecar: next } = await sidecarFor(t, h, { spawn: fake.spawn })
  assert.deepEqual(next.held(), ['keepLoaded'])
  assert.equal(next.readSettings().startWithKzh, true)
})

test('reservePort never hands out one port twice, skips a port in use, and gives a port back once freed', async (t) => {
  const h = await harness()
  // The port in use is one the OS hands this test, held from the start, and the first port tried is
  // the one below it once that is seen free: binding a chosen port instead could meet another test
  // file running at the same time.
  const listen = (port) => new Promise((r) => { const s = createServer(); s.once('error', () => r(null)); s.listen(port, '127.0.0.1', () => r(s)) })
  let taken
  let base
  for (let tries = 0; !base; tries++) {
    taken = await listen(0)
    const below = await listen(taken.address().port - 1)
    if (below) { base = taken.address().port - 1; await new Promise((r) => below.close(r)) } else if (tries < 20) await new Promise((r) => taken.close(r))
    else throw new Error('no two free ports in a row')
  }
  t.after(() => taken.close())
  const { sidecar } = await sidecarFor(t, h, { config: { port: base } })
  const ports = await Promise.all(Array.from({ length: 6 }, () => sidecar.reservePort()))
  assert.equal(new Set(ports).size, 6, `no port twice: ${ports}`)
  assert.ok(!ports.includes(base + 1), 'the port in use is skipped')
  assert.equal(Math.min(...ports), base)
  sidecar.freePortReservation(base)
  assert.equal(await sidecar.reservePort(), base, 'free again once its process has exited')
})

test('the orphan sweep stops a Laya left by an earlier session, by the venv\'s or the base interpreter\'s path, and nothing else', async (t) => {
  const h = await harness()
  const root = 'C:\\Harness'
  const winPaths = layaPaths({ harnessDir: root, dataDir: h.dataDir, platform: 'win32' })
  mkdirSync(dirname(winPaths.sidecarJson), { recursive: true })
  const venvPy = 'C:\\Harness\\engine\\laya\\venv\\Scripts\\python.exe'
  const basePy = 'C:\\Harness\\engine\\laya\\python\\cpython-3.12.11-windows-x86_64-none\\python.exe'
  const procs = {
    101: `${venvPy}|"${venvPy}" -I -u -X utf8 -m laya.serve`,
    102: `${basePy}|"${basePy}" -I -u -X utf8 -m laya.serve`,
    201: 'C:\\Windows\\System32\\notepad.exe|notepad.exe',
    202: `C:\\Python312\\python.exe|"C:\\Python312\\python.exe" -m laya.serve`,
    203: `${venvPy}|"${venvPy}" -m pip list`,
  }
  const run = async (cmd, args) => {
    const pid = /ProcessId=(\d+)/.exec(args.at(-1) ?? '')?.[1]
    return cmd === 'powershell.exe' && procs[pid] ? `${procs[pid]}\r\n` : null
  }
  const killed = []
  const sweep = async (record) => {
    writeFileSync(winPaths.sidecarJson, JSON.stringify(record))
    const logs = []
    const sidecar = createLayaSidecar({
      harnessDir: root, dataDir: h.dataDir, pins: PINS, config: {}, platform: 'win32', run, log: (l) => logs.push(l),
      isAlive: (pid) => pid !== 999, killTree: (pid) => { killed.push(pid); return true }, readWorkingSet: async () => 2.5 * 1024 ** 3,
    })
    t.after(() => sidecar.dispose())
    const got = await sidecar.sweepOrphans()
    return { got, logs, status: sidecar.status() }
  }
  const { got, logs, status } = await sweep({ pid: 101, interpreterPid: 102, port: 8091 })
  assert.deepEqual(got, [{ pid: 101, ramGB: 2.5 }, { pid: 102, ramGB: 2.5 }])
  assert.deepEqual(killed, [101, 102], 'the redirector and the base interpreter it started')
  assert.deepEqual(status.orphanStopped, { pid: 101, ramGB: 5 })
  assert.ok(logs.includes('laya: Stopped a Laya left running by an earlier session (pid 101, 5 GB RAM).'), logs.join('\n'))
  assert.ok(!existsSync(winPaths.sidecarJson))
  killed.length = 0
  for (const [pid, interpreterPid] of [[201, 999], [202, 203]]) {
    const r = await sweep({ pid, interpreterPid })
    assert.deepEqual(r.got, [], `${pid}, ${interpreterPid}`)
    assert.equal(r.status.orphanStopped, null)
  }
  assert.deepEqual(killed, [], 'a reused pid, a Python outside engine\\laya and one not running laya.serve are left alone')
})

test('a process\'s path and command line, and the real interpreter behind a venv redirector on Windows', async () => {
  const asked = []
  const run = async (cmd, args) => {
    asked.push([cmd, ...args])
    if (args.at(-1).includes('ParentProcessId=500')) return '612|python.exe|C:\\Harness\\engine\\laya\\python\\cpython-3.12.11-windows-x86_64-none\\python.exe\r\n'
    if (args.at(-1).includes('ProcessId=612')) return 'C:\\Harness\\engine\\laya\\python\\cpython\\python.exe|"C:\\Harness\\engine\\laya\\python\\cpython\\python.exe" -I -u -X utf8 -m laya.serve\r\n'
    return ''
  }
  assert.deepEqual(await findInterpreter(500, { platform: 'win32', run }), { pid: 612, path: 'C:\\Harness\\engine\\laya\\python\\cpython-3.12.11-windows-x86_64-none\\python.exe' })
  assert.deepEqual(asked[0], ['powershell.exe', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "ParentProcessId=500" | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)" }'])
  assert.equal(await findInterpreter(501, { platform: 'win32', run }), null, 'no python.exe child: the spawned process is the interpreter')
  assert.equal(await findInterpreter(500, { platform: 'linux', run }), null)
  assert.deepEqual(await processInfo(612, { platform: 'win32', run }), { exe: 'C:\\Harness\\engine\\laya\\python\\cpython\\python.exe', cmdline: '"C:\\Harness\\engine\\laya\\python\\cpython\\python.exe" -I -u -X utf8 -m laya.serve' })
  assert.equal(await processInfo(613, { platform: 'win32', run }), null)
  if (process.platform === 'linux') {
    const me = await processInfo(process.pid)
    assert.equal(me.exe, process.execPath)
    assert.ok(me.cmdline.includes('laya-sidecar.test.js'), me.cmdline)
  }
})

test('Laya\'s GPU memory spilling into system memory is said when an acting GPU request takes over three times its figure while dedicated memory is full', async (t) => {
  const h = await harness({ cuda: true })
  const g = gpu()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn, run: g.run })
  await sidecar.start()
  assert.equal(sidecar.status().running.device, 'cuda')
  const figure = sidecar.readSettings().measured.cuda.msPerToken.route
  assert.ok(figure > 0)
  const slow = { status: 200, ms: figure * 4 * 1000, tokens: 1000, phase: 'route' }
  // Slow, but with room on the GPU: not a spill.
  assert.deepEqual(await sidecar.noteResult({ ...slow, role: 'act' }), { spilling: false })
  g.used = 3900
  g.free = 196
  const base = sidecar.readSettings().measured.cuda.msPerToken.route
  assert.deepEqual(await sidecar.noteResult({ ...slow, ms: base * 4 * 1000, role: 'shadow' }), { spilling: false }, 'a background request says nothing about it')
  const spill = await sidecar.noteResult({ ...slow, ms: sidecar.readSettings().measured.cuda.msPerToken.route * 4 * 1000, role: 'act' })
  assert.deepEqual(spill, { spilling: true, line: "Laya's GPU memory is spilling into system memory, so it and the local models are slow. Stop the local model, or pick CPU for Laya." })
  assert.equal(sidecar.status().running.spilling, true)
  assert.equal(sidecar.status().running.spills, 1)
  assert.ok(logs.includes(`laya: ${spill.line}`))
  // Back to its usual speed: no longer spilling.
  assert.deepEqual(await sidecar.noteResult({ ...slow, ms: sidecar.readSettings().measured.cuda.msPerToken.route * 1000, role: 'act' }), { spilling: false })
  assert.equal(sidecar.status().running.spilling, false)
})

test('status() says where each running figure comes from: the working set the budget reads, else what the first start measured', async (t) => {
  const h = await harness({ cuda: true })
  const g = gpu()
  // nvidia-smi, as the start reads it: the room first, then the memory before the load, then after it.
  let reads = 0
  const run = async (cmd, args) => { if (cmd === 'nvidia-smi' && ++reads >= 3) g.used = 2900; return g.run(cmd, args) }
  const residency = createResidency()
  const { sidecar } = await sidecarFor(t, h, { spawn: interpreter().spawn, run, residency, readWorkingSet: async () => 1.9 * 1024 ** 3 })
  await sidecar.start()
  let r = sidecar.status().running
  assert.deepEqual([r.device, r.vramGB, r.vramSource, r.ramGB, r.ramSource], ['cuda', 2.25, 'first start', 1.9, 'first start'])
  // A RAM budget set, the watchdog reads the working set, and the RAM figure is that reading.
  residency.get('laya').workingSetGB = 2.1
  r = sidecar.status().running
  assert.deepEqual([r.ramGB, r.ramSource, r.vramSource], [2.1, 'working set', 'first start'])
  // On the CPU there is no GPU figure, and so no source for one.
  const hc = await harness()
  const { sidecar: onCpu } = await sidecarFor(t, hc, { spawn: interpreter().spawn })
  await onCpu.start()
  assert.deepEqual([onCpu.status().running.vramGB, onCpu.status().running.vramSource], [null, null])
})

test('a spill goes on being said while it lasts: a spilled request is never folded into the figure the next one is judged against', async (t) => {
  const h = await harness({ cuda: true })
  const g = gpu()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, run: g.run })
  await sidecar.start()
  assert.equal(sidecar.status().running.device, 'cuda')
  const figure = sidecar.readSettings().measured.cuda.msPerToken.route
  assert.ok(figure > 0, 'the warm-up measured the route')
  // Dedicated memory all but full, and every acting route at four times the unspilled figure.
  g.used = 3900
  g.free = 196
  const said = []
  for (let n = 0; n < 4; n++) said.push(await sidecar.noteResult({ status: 200, ms: figure * 4 * 1000, tokens: 1000, phase: 'route', role: 'act' }))
  // A comparison in the background, as slow, moves the figure no more than an acting request.
  await sidecar.noteResult({ status: 200, ms: figure * 4 * 1000, tokens: 1000, phase: 'route', role: 'shadow' })
  assert.deepEqual(said.map((r) => r.spilling), [true, true, true, true], 'every spilled call says so, in its run\'s lines')
  assert.ok(said.every((r) => r.line === LAYA_TEXT.spilling))
  assert.deepEqual([sidecar.status().running.spilling, sidecar.status().running.spills], [true, 4], 'and the card goes on saying it')
  assert.equal(sidecar.readSettings().measured.cuda.msPerToken.route, figure, 'the figure is Laya\'s unspilled speed')
  await waitFor('laya.json keeps it', () => JSON.parse(readFileSync(h.paths.settings, 'utf8')).measured.cuda.msPerToken.route, (x) => x === figure)
  // Back under three times the unspilled figure: the spill is over, and that request is folded in.
  assert.deepEqual(await sidecar.noteResult({ status: 200, ms: figure * 2 * 1000, tokens: 1000, phase: 'route', role: 'act' }), { spilling: false })
  assert.equal(sidecar.status().running.spilling, false)
  assert.ok(sidecar.readSettings().measured.cuda.msPerToken.route > figure)
})

test('the settings: each field checked with its own message, a refused patch saves nothing, unknown fields refused', async (t) => {
  const h = await harness()
  const { sidecar } = await sidecarFor(t, h, {})
  assert.deepEqual(sidecar.readSettings().startWithKzh, false)
  for (const [patch, message] of [
    [{ idleMinutes: 0 }, 'Unload after idle: whole minutes 1-240'],
    [{ idleMinutes: 241 }, 'Unload after idle: whole minutes 1-240'],
    [{ idleMinutes: 2.5 }, 'Unload after idle: whole minutes 1-240'],
    [{ device: 'gpu0' }, "Device: 'auto', 'gpu' or 'cpu'"],
    [{ startWithKzh: 'yes' }, 'Start Laya when KzH starts: true or false'],
    [{ keepLoaded: 1 }, 'Keep Laya loaded: true or false'],
    [{ shadow: null }, 'Answer beside Jev in Jev Auto: true or false'],
    [{ measured: {} }, 'measured is not a Laya setting'],
    [{ idleMinutes: 20, device: 'fast' }, "Device: 'auto', 'gpu' or 'cpu'"],
  ]) await assert.rejects(sidecar.setSettings(patch), { message }, JSON.stringify(patch))
  assert.equal(sidecar.readSettings().idleMinutes, 30, 'the valid half of a refused patch was not saved')
  assert.deepEqual(await sidecar.setSettings({ idleMinutes: 240, device: 'cpu', shadow: false }), { startWithKzh: false, keepLoaded: false, idleMinutes: 240, device: 'cpu', shadow: false })
  assert.deepEqual(sidecar.status().settings, { startWithKzh: false, keepLoaded: false, idleMinutes: 240, device: 'cpu', shadow: false })
  await sidecar.noteSelfTest({ protocol: { ok: true }, identity: 'x' })
  const file = JSON.parse(readFileSync(h.paths.settings, 'utf8'))
  assert.deepEqual([file.idleMinutes, file.device, file.shadow, file.lastSelfTest], [240, 'cpu', false, { protocol: { ok: true }, identity: 'x' }])
  assert.deepEqual(Object.keys(file.measured), ['cpu', 'cuda'])
  assert.deepEqual(sidecar.status().selfTest, { protocol: { ok: true }, identity: 'x' })
})

test('route() holds by its run id, as 2.4 writes it: listed as run:<id>, and Stop and Restart are refused until it is released', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.ensureReady()
  const runId = randomUUID()
  sidecar.hold(runId)
  assert.deepEqual(sidecar.held(), [`run:${runId}`], 'the status of 8.4 lists it as run:<runId>, which the installer reads too')
  await assert.rejects(sidecar.stop(), { message: LAYA_TEXT.stopWhileHeld })
  await assert.rejects(sidecar.restart(), { message: LAYA_TEXT.stopWhileHeld })
  assert.equal(sidecar.status().state, 'ready')
  sidecar.hold('selftest')
  sidecar.release(runId)
  assert.deepEqual(sidecar.held(), ['selftest'], 'Test Laya\'s hold is not a run')
  await sidecar.stop()
  assert.equal(sidecar.status().state, 'stopped')
})

test('restarting: Stop ends the backoff even while a Laya Auto run holds it', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, timing: { backoffMs: [600, 600, 600] } })
  await sidecar.start()
  sidecar.hold('run:open')
  fake.spawned[0].child.kill('SIGKILL')
  await waitFor('restarting', () => sidecar.status().state, (s) => s === 'restarting')
  await assert.doesNotReject(sidecar.stop(), 'the 7.4 table: in restarting, Stop stops it and ends the backoff')
  assert.equal(sidecar.status().state, 'stopped')
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(fake.spawned.length, 1, 'no restart after the Stop')
})

test('Stop while a start has not spawned yet, then a Laya Auto message: it starts afresh and waits, as from stopped', async (t) => {
  const h = await harness()
  const fake = interpreter()
  // The budget stands for a slow step before the spawn; a weights re-hash after a copy is another.
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, readBudget: () => new Promise((r) => setTimeout(() => r({}), 300)) })
  const first = sidecar.start()
  first.catch(() => {})
  await new Promise((r) => setTimeout(r, 50))
  await sidecar.stop()
  assert.equal(sidecar.status().state, 'stopped')
  await assert.doesNotReject(sidecar.ensureReady(), 'the 7.4 table: in stopped, ensureReady starts it and waits')
  assert.equal(sidecar.status().state, 'ready')
  assert.equal(fake.spawned.length, 1, 'the stopped start never spawned')
  await assert.rejects(first, /it was stopped/)
})

test('a start the RAM budget or a GPU with no room turns down is refused, not failed: stopped with the reason, and the next message starts it once there is room', async (t) => {
  const h = await harness()
  const res = createResidency()
  const llama = res.set('llama', { pid: 1, startedAt: 1, name: 'qwen3-8b', held: () => true, busy: () => false, ramGB: 6, unload: async () => {} })
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, residency: res, readBudget: async () => ({ maxRamGB: 8 }) })
  const refusal = 'Laya needs about 3.3 GB of RAM; the budget leaves 2 GB beside qwen3-8b. Stop the local model or raise the RAM budget.'
  await assert.rejects(sidecar.ensureReady(), { message: LAYA_TEXT.refused(refusal) })
  assert.deepEqual([sidecar.status().state, sidecar.status().why, fake.spawned.length], ['stopped', refusal, 0], 'the 7.4 table sets failed only for a start that ran and did not come up')
  // The local model is unloaded: the next message starts Laya, with no Start pressed.
  res.clear('llama', llama)
  await assert.doesNotReject(sidecar.ensureReady())
  assert.equal(sidecar.status().state, 'ready')

  // Device GPU with no room is the same: stopped, and started once the GPU has room.
  const hg = await harness({ cuda: true })
  const g = gpu({ free: 900, used: 3196 })
  const fg = interpreter()
  const { sidecar: onGpu } = await sidecarFor(t, hg, { spawn: fg.spawn, run: g.run })
  await onGpu.setSettings({ device: 'gpu' })
  const noRoom = 'Laya is set to run on the GPU, and the GPU had 0.9 GB free and Laya needs about 2.5 GB'
  await assert.rejects(onGpu.ensureReady(), { message: LAYA_TEXT.refused(noRoom) })
  assert.deepEqual([onGpu.status().state, onGpu.status().why], ['stopped', noRoom])
  g.free = 3500
  await assert.doesNotReject(onGpu.ensureReady())
  assert.equal(onGpu.status().running.device, 'cuda')
})

test('a start the budget or the GPU turned down is refused with its own reason: no Start to press and no log to read, and no reason ends twice', async (t) => {
  const h = await harness()
  const res = createResidency()
  res.set('llama', { pid: 1, startedAt: 1, name: 'qwen3-8b', held: () => true, busy: () => false, ramGB: 6, unload: async () => {} })
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, residency: res, readBudget: async () => ({ maxRamGB: 8 }) })
  await assert.rejects(sidecar.ensureReady(), {
    message: 'Laya Auto did not run this: Laya needs about 3.3 GB of RAM; the budget leaves 2 GB beside qwen3-8b. Stop the local model or raise the RAM budget. Nothing was run.',
    reason: 'refused',
  })
  // A call of a run already under way says only the reason.
  const client = createLayaClient({ sidecar })
  t.after(() => client.dispose())
  await assert.rejects(createJev({ provider: resolveProviders({}, {}).laya, client: client.client('act') }).intent({ message: 'Fix the parser' }), {
    message: 'Laya needs about 3.3 GB of RAM; the budget leaves 2 GB beside qwen3-8b. Stop the local model or raise the RAM budget',
  })
  assert.equal(fake.spawned.length, 0)

  const hg = await harness({ cuda: true })
  const g = gpu({ free: 900, used: 3196 })
  const { sidecar: onGpu } = await sidecarFor(t, hg, { spawn: interpreter().spawn, run: g.run })
  await onGpu.setSettings({ device: 'gpu' })
  await assert.rejects(onGpu.ensureReady(), { message: 'Laya Auto did not run this: Laya is set to run on the GPU, and the GPU had 0.9 GB free and Laya needs about 2.5 GB. Nothing was run.' })

  // A start that ran and failed still says where the log is, with the reason's own period once.
  const hw = await harness()
  const { sidecar: broken } = await sidecarFor(t, hw, { spawn: interpreter().spawn })
  rmSync(join(snapshotDir(hw.paths.hf, PINS.weights.repo, COMMIT), 'model.safetensors'))
  await assert.rejects(broken.ensureReady(), { message: "Laya Auto did not run this: Laya could not start (Laya's model files are not complete on this PC (model.safetensors is missing). Choose Repair, or copy models/laya/hf from another PC). Press Start in Settings → Jev setup → Laya decision model, where the log is. Nothing was run." })
})

test('why the supervisor restarted Laya stays in status() once it is ready again, until the person presses Start or Stop', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  await sidecar.noteResult({ status: 500, ms: 5, phase: 'route', role: 'act' })
  await sidecar.noteResult({ status: 500, ms: 5, phase: 'route', role: 'act' })
  const s = sidecar.status()
  assert.equal(s.state, 'ready')
  assert.deepEqual([s.lastRestart?.kind, s.lastRestart?.why], ['500', 'two requests in a row failed (laya.serve gave no reason); restarting'], 'the reason 7.5 says is shown')
  assert.ok(Number.isFinite(s.lastRestart.at))
  // An unexpected exit of a ready Laya is said the same way.
  fake.spawned[1].child.kill('SIGKILL')
  await waitFor('restarted after the exit', () => [fake.spawned.length, sidecar.status().state], ([n, st]) => n === 3 && st === 'ready', { timeoutMs: 20_000 })
  assert.deepEqual([sidecar.status().lastRestart.kind, sidecar.status().lastRestart.why], ['exit', 'signal SIGKILL'])
  await sidecar.stop()
  assert.equal(sidecar.status().lastRestart, null, 'the person has seen it')
})

test('a failed update over a running Laya keeps its error in status() once the old one runs again, until the next job', async (t) => {
  const h = await harness()
  const fake = interpreter()
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  // build()'s order (laya-install.js): the job at step 7, the running Laya stopped for the check,
  // the check failing, the finished job told, then the old Laya started again.
  const job = { kind: 'update', step: 7, of: 8, name: 'Checking that it starts', received: 0, total: 0, error: null, lines: [], notes: [], done: false }
  sidecar.noteInstall({ ...job })
  sidecar.suspend()
  await sidecar.stop({ reason: 'update' })
  const error = 'The new install did not pass its check: the protocol checks failed: intent.task: 500 inference failed'
  Object.assign(job, { error, failedStep: 7, failedName: job.name, finishedAt: 1 })
  sidecar.noteInstall({ ...job })
  assert.equal(sidecar.status().state, 'install_failed')
  sidecar.resume()
  await sidecar.start({ reason: 'update' })
  const s = sidecar.status()
  assert.equal(s.state, 'ready', 'the old install runs, and reads as running (7.4)')
  assert.deepEqual([s.install?.kind, s.install?.step, s.install?.failedStep, s.install?.name, s.install?.error], ['update', 7, 7, 'Checking that it starts', error], 'so the card can still say the update failed (7.10)')
  await sidecar.ensureReady()
  assert.equal(sidecar.status().install?.error, error, 'a Laya Auto message leaves it')
  await sidecar.stop()
  assert.equal(sidecar.status().state, 'install_failed', 'stopped, the failure is what the card shows, with Try again')
  sidecar.noteInstall({ ...job, error: null, failedStep: null, finishedAt: null, step: 1, name: 'Checking the downloads and disk' })
  assert.equal(sidecar.status().install.error, null, 'the next job replaces it')
})

test('the install check is refused as a real start is, before anything runs: over the RAM budget beside a local model, or on a GPU with no room', async (t) => {
  const h = await harness()
  rmSync(h.paths.installed)
  mkdirSync(dirname(h.paths.pythonOf(h.paths.venvNew)), { recursive: true })
  writeFileSync(h.paths.pythonOf(h.paths.venvNew), '')
  const res = createResidency()
  const unloads = []
  res.set('llama', { pid: 1, startedAt: 1, name: 'qwen3-8b', held: () => true, busy: () => false, ramGB: 6, unload: async (w) => { unloads.push(w) } })
  let budget = { maxRamGB: 8 }
  const g = gpu({ free: 900, used: 3196 })
  const fake = interpreter()
  t.after(() => { for (const s of fake.spawned) s.child.kill('SIGKILL') })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, residency: res, readBudget: async () => budget, run: g.run })
  const ram = await sidecar.checkStart({ venv: h.paths.venvNew, device: 'cpu' })
  assert.deepEqual([ram.ok, ram.error], [false, 'Laya needs about 3.3 GB of RAM; the budget leaves 2 GB beside qwen3-8b. Stop the local model or raise the RAM budget.'], 'never unloads llama to fit (7.7)')
  budget = {}
  const noRoom = await sidecar.checkStart({ venv: h.paths.venvNew, device: 'cuda' })
  assert.deepEqual([noRoom.ok, noRoom.error], [false, 'there is no room for Laya on the GPU now: the GPU had 0.9 GB free and Laya needs about 2.5 GB'], 'it would test the wrong device')
  assert.equal(fake.spawned.length, 0, 'nothing was started')
  assert.deepEqual(unloads, [])
  g.free = 3500
  const ok = await sidecar.checkStart({ venv: h.paths.venvNew, device: 'cuda' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(fake.spawned[0].opts.env.LAYA_DEVICE, 'cuda')
})

test('the install check is in the residency by the real interpreter\'s pid, as the sidecar is, so the watchdog reads what it holds', async (t) => {
  const h = await harness()
  // On Windows the venv's python.exe starts the base interpreter as its child; this stands for it.
  const child = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const run = async (cmd, args) => (cmd === 'powershell.exe' && /ParentProcessId=/.test(args.at(-1)) ? `${child.pid}|python.exe|C:\\Harness\\engine\\laya\\python\\python.exe\r\n` : null)
  const res = createResidency()
  const seen = []
  const probe = (conn) => { const p = createProbe(conn); return { ...p, protocol: () => { seen.push(res.get('laya-check')?.pid); return p.protocol() } } }
  const fake = interpreter()
  t.after(() => { for (const s of fake.spawned) s.child.kill('SIGKILL') })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn, residency: res, probe, run, platform: 'win32' })
  const r = await sidecar.checkStart({ venv: h.paths.venvNew, device: 'cpu' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(seen, [child.pid], 'the interpreter, not the launcher the venv starts')
  assert.equal(res.get('laya-check'), null, 'gone once the check is over')
})

test('an install check is recorded in sidecar.json while it runs, and the engine exiting kills it', async (t) => {
  const h = await harness()
  const fake = interpreter({ env: () => ({ FAKE_LAYA_LOAD_MS: '60000' }) })
  t.after(() => { for (const s of fake.spawned) s.child.kill('SIGKILL') })
  const before = new Set(process.listeners('exit'))
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  const onEngineExit = process.listeners('exit').find((l) => !before.has(l))
  const checking = sidecar.checkStart({ venv: h.paths.venvNew, device: 'cpu' })
  await waitFor('the check to spawn', () => fake.spawned.length, (n) => n === 1)
  const { child } = fake.spawned[0]
  const recorded = await settle(() => JSON.parse(readFileSync(h.paths.sidecarJson, 'utf8')).check?.pid, (pid) => pid === child.pid)
  assert.equal(recorded, child.pid, 'the check\'s pid is in sidecar.json, for the next session\'s sweep')
  onEngineExit()
  assert.ok(await settle(() => exited(child), (x) => x), 'killed with the engine')
  const r = await checking
  assert.equal(r.ok, false)
  assert.ok(await settle(() => !existsSync(h.paths.sidecarJson), (x) => x), 'nothing recorded once it has gone')
})

test('nothing starts Laya once its supervisor is disposed: not a start chained on a stop, not a restart, not a call waiting out a crash backoff', async (t) => {
  // A message arrives while an idle stop is under way, and the plugin is disposed before the stop ends.
  const h = await harness()
  const fake = interpreter()
  const { sidecar, logs } = await sidecarFor(t, h, { spawn: fake.spawn })
  await sidecar.start()
  sidecar.stop({ reason: 'idle' }).catch(() => {})
  const waiting = sidecar.ensureReady({})
  waiting.catch(() => {})
  await sidecar.dispose()
  await assert.rejects(waiting, { message: 'Laya was stopped with KzH' })
  await assert.rejects(sidecar.start({ reason: 'update' }), { message: 'Laya was stopped with KzH' }, 'nor the installer starting it again')
  sidecar.warm()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(fake.spawned.length, 1, `one laya.serve only: ${logs.join(' | ')}`)
  await waitFor('the stopped one has exited', () => exited(fake.spawned[0].child), (x) => x === true)
  assert.equal((await sidecar.checkStart({ venv: h.paths.venv })).ok, false, 'and no install check')
  assert.equal(fake.spawned.length, 1)

  // A crash, and a call waiting out the backoff: it hears at once, and the backoff starts nothing.
  const h2 = await harness()
  const fake2 = interpreter()
  const { sidecar: second } = await sidecarFor(t, h2, { spawn: fake2.spawn, timing: { backoffMs: [1500, 1500, 1500] } })
  await second.start()
  fake2.spawned[0].child.kill('SIGKILL')
  await waitFor('restarting', () => second.status().state, (s) => s === 'restarting')
  const t0 = Date.now()
  const pending = second.ensureReady({})
  pending.catch(() => {})
  await second.dispose()
  await assert.rejects(pending, { message: 'Laya was stopped with KzH' })
  assert.ok(Date.now() - t0 < 1000, 'at once, not after the backoff or the start bound')
  await new Promise((r) => setTimeout(r, 1800))
  assert.equal(fake2.spawned.length, 1, 'the backoff ended with the supervisor')
})

test('a disposed supervisor leaves nothing that keeps the engine\'s process alive: it can exit at once', async (t) => {
  const h = await harness()
  const url = (f) => new URL(f, import.meta.url).href
  // The engine, as a process of its own: Laya started on the fake with the real timings, then disposed.
  const script = `
    import { spawn } from 'node:child_process'
    import { createLayaSidecar } from ${JSON.stringify(url('../laya-sidecar.js'))}
    import { createProbe } from ${JSON.stringify(url('../laya-selfcheck.js'))}
    import { readPins } from ${JSON.stringify(url('../laya-install.js'))}
    const [harnessDir, dataDir, port] = process.argv.slice(1)
    const sidecar = createLayaSidecar({
      harnessDir, dataDir, pins: readPins(${JSON.stringify(REPO)}), config: { port: Number(port) },
      specs: async () => (${JSON.stringify(SPECS)}), probe: (c) => createProbe(c), run: async () => null,
      spawn: (cmd, args, opts) => spawn(process.execPath, [${JSON.stringify(FAKE)}, ...args], opts),
    })
    await sidecar.start()
    await sidecar.dispose()
    process.stdout.write('disposed\\n')
  `
  const child = nodeSpawn(process.execPath, ['--input-type=module', '-e', script, h.harnessDir, h.dataDir, String(await basePort())], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => { if (!exited(child)) child.kill('SIGKILL') })
  let disposedAt = null
  child.stdout.on('data', (d) => { if (String(d).includes('disposed')) disposedAt ??= Date.now() })
  const code = await new Promise((r) => child.once('exit', (c) => r(c)))
  assert.equal(code, 0)
  assert.ok(disposedAt, 'the engine disposed its supervisor')
  const lived = Date.now() - disposedAt
  assert.ok(lived < 3000, `it exited ${lived} ms after dispose, not after the 15 s bound of a stop`)
})

test('dispose kills an install check under way', async (t) => {
  const h = await harness()
  const fake = interpreter({ env: () => ({ FAKE_LAYA_LOAD_MS: '60000' }) })
  t.after(() => { for (const s of fake.spawned) s.child.kill('SIGKILL') })
  const { sidecar } = await sidecarFor(t, h, { spawn: fake.spawn })
  const checking = sidecar.checkStart({ venv: h.paths.venvNew, device: 'cpu' })
  await waitFor('the check to spawn', () => fake.spawned.length, (n) => n === 1)
  await sidecar.dispose()
  assert.ok(await settle(() => exited(fake.spawned[0].child), (x) => x), 'the plugin going takes the check with it')
  assert.equal((await checking).ok, false)
})

test('the orphan sweep also stops an install check an earlier session left', async (t) => {
  const h = await harness()
  const root = 'C:\\Harness'
  const winPaths = layaPaths({ harnessDir: root, dataDir: h.dataDir, platform: 'win32' })
  mkdirSync(dirname(winPaths.sidecarJson), { recursive: true })
  writeFileSync(winPaths.sidecarJson, JSON.stringify({ check: { pid: 301, interpreterPid: 302, port: 8092, startedAt: 'then' } }))
  const py = 'C:\\Harness\\engine\\laya\\venv.new\\Scripts\\python.exe'
  const base = 'C:\\Harness\\engine\\laya\\python\\cpython-3.12.11-windows-x86_64-none\\python.exe'
  const procs = { 301: `${py}|"${py}" -I -u -X utf8 -m laya.serve`, 302: `${base}|"${base}" -I -u -X utf8 -m laya.serve` }
  const run = async (cmd, args) => { const pid = /ProcessId=(\d+)/.exec(args.at(-1) ?? '')?.[1]; return cmd === 'powershell.exe' && procs[pid] ? `${procs[pid]}\r\n` : null }
  const killed = []
  const next = createLayaSidecar({
    harnessDir: root, dataDir: h.dataDir, pins: PINS, config: {}, platform: 'win32', run,
    isAlive: () => true, killTree: (pid) => { killed.push(pid); return true }, readWorkingSet: async () => 1.5 * 1024 ** 3,
  })
  t.after(() => next.dispose())
  assert.deepEqual(await next.sweepOrphans(), [{ pid: 301, ramGB: 1.5 }, { pid: 302, ramGB: 1.5 }])
  assert.deepEqual(killed, [301, 302], 'the check\'s launcher and the interpreter it started')
  assert.deepEqual(next.status().orphanStopped, { pid: 301, ramGB: 3 })
  assert.ok(!existsSync(winPaths.sidecarJson))
})

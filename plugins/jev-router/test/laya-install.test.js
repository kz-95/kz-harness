// Installing Laya (docs/laya-auto.md 7.2, 7.3, 7.10), with every command stubbed: `spawn` is a small
// machine that answers uv, the new venv's Python and fetch_weights.py as they answer on Windows,
// and records every call. The steps in order with their exact commands, the PyTorch index by the
// driver's CUDA version, what a failure leaves, the journalled swap and its recovery, the install
// lock, an update around a running Laya, the records written, and the step that stops moving.
import { createLayaInstaller, createRotatingLog, isAlive, layaPaths, readPins, recordWeights, snapshotDir, takeInstallLock, torchIndexes, verifyWeights } from '../laya-install.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { rename as fsRename, rm as fsRm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitFor } from './wait-for.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PINS = readPins(REPO)
const LOCK_SHA = createHash('sha256').update(readFileSync(join(REPO, 'config', 'laya', 'requirements.lock'))).digest('hex')
const GPU = 'NVIDIA GeForce RTX 3050 Laptop GPU'
const COMMIT = '9f8e7d6c5b4a39281706'.padEnd(40, 'f')
const GB = 1024 ** 3
const sha = (s) => createHash('sha256').update(s).digest('hex')
// What Laya's loader leaves in the tokenizer config after its fix-up on load (laya/agent.py).
const FIXED_TOKENIZER = '{\n  "tokenizer_class": "PreTrainedTokenizerFast"\n}'

/** A harness folder with the repo's lock, as the installer reads it, and a data folder. */
function harness() {
  const harnessDir = mkdtempSync(join(tmpdir(), 'laya-install-'))
  const dataDir = join(harnessDir, 'data')
  mkdirSync(join(harnessDir, 'config', 'laya'), { recursive: true })
  writeFileSync(join(harnessDir, 'config', 'laya', 'requirements.lock'), readFileSync(join(REPO, 'config', 'laya', 'requirements.lock')))
  const paths = layaPaths({ harnessDir, dataDir, platform: 'win32' })
  return { harnessDir, dataDir, paths }
}

/** uv in place at the pinned version, as Install-Harness.ps1 leaves it. */
function withUv(h) {
  mkdirSync(dirname(h.paths.uv), { recursive: true })
  writeFileSync(h.paths.uv, '')
}

/** A working install: a venv with a file of its own and its installed.json. */
function installedBefore(h, laya = '0.3.19') {
  mkdirSync(join(h.paths.venv, 'Scripts'), { recursive: true })
  writeFileSync(h.paths.pythonOf(h.paths.venv), '')
  writeFileSync(join(h.paths.venv, 'old-install.txt'), 'the running install')
  writeFileSync(h.paths.installed, JSON.stringify({ laya, torch: '2.14.0+cu128', cuda: true }))
}

/** A Hugging Face snapshot as Laya's loader leaves it: loaded, the tokenizer config fixed up. */
function plantSnapshot(hf, commit = COMMIT) {
  const snap = snapshotDir(hf, PINS.weights.repo, commit)
  for (const [rel, body] of [['model.safetensors', 'weights'], ['rl_agent_config.json', '{"temperatures":{}}'], ['tokenizer/tokenizer.json', '{}'], ['tokenizer/tokenizer_config.json', FIXED_TOKENIZER], ['encoder/config.json', '{}']]) {
    mkdirSync(dirname(join(snap, rel)), { recursive: true })
    writeFileSync(join(snap, rel), body)
  }
  mkdirSync(join(hf, 'hub', `models--${PINS.weights.repo.replace('/', '--')}`, 'refs'), { recursive: true })
  writeFileSync(join(hf, 'hub', `models--${PINS.weights.repo.replace('/', '--')}`, 'refs', 'main'), commit)
  return snap
}

/**
 * The commands, answered. `answer(call)` may return { code, out, err } or 'hang'; unanswered
 * commands succeed as the real ones do when all is well.
 */
function machine(h, { answer = () => null, torch = () => 'ok', imported = {}, hubCommit = COMMIT } = {}) {
  const calls = []
  const py = (venv) => h.paths.pythonOf(venv)
  const ok = (out = '') => ({ code: 0, out })
  const standard = (call) => {
    const { cmd, args, env } = call
    if (cmd === h.paths.uv) {
      if (args[0] === '--version') return ok('uv 0.12.18 (8b4c7f0f3 2026-09-20 x86_64-pc-windows-msvc)\n')
      if (args[0] === 'python') return ok()
      if (args[0] === 'venv') { mkdirSync(join(args.at(-1), 'Scripts'), { recursive: true }); writeFileSync(py(args.at(-1)), ''); return ok() }
      if (args[0] === 'pip' && args[1] === 'install' && args.includes(`torch==${PINS.torch.version}`)) {
        const tag = args.includes('--index-url') ? args[args.indexOf('--index-url') + 1].split('/').pop() : 'cpu'
        const how = torch(tag)
        if (how === '404') return { code: 2, err: `error: Failed to fetch: \`https://download.pytorch.org/whl/${tag}/torch/\`\n  Caused by: HTTP status client error (404 Not Found) for url (https://download.pytorch.org/whl/${tag}/torch/)\n` }
        if (how === 'no-solution') return { code: 1, err: `  x No solution found when resolving dependencies:\n  Because there is no version of torch==${PINS.torch.version} and you require torch==${PINS.torch.version}, we can conclude that your requirements are unsatisfiable.\n` }
        if (how !== 'ok') return { code: 1, err: `error: ${how}\n` }
        const site = join(args[args.indexOf('--python') + 1], '..', '..', 'Lib', 'site-packages', `torch-${PINS.torch.version}+${tag}.dist-info`)
        mkdirSync(site, { recursive: true })
        writeFileSync(join(site, 'RECORD'), `torch/__init__.py,sha256=abc,100\n# ${tag}\n`)
        return ok()
      }
      if (args[0] === 'pip' && args[1] === 'install') return ok('Installed 61 packages in 2.1s\n')
      if (args[0] === 'pip' && args[1] === 'check') return ok('Checked 62 packages in 4ms\nAll installed packages are compatible\n')
    }
    if (args[0] === '-I' && args[1] === '-c') return ok(`${JSON.stringify({ torch: `${PINS.torch.version}+cu128`, cuda: true, gpu: GPU, laya: PINS.laya, python: '3.12.11', ...imported })}\n`)
    if (args.includes(h.paths.fetchWeights)) {
      // Offline, only what the cache holds loads; online, the Hub's main is fetched into it.
      const refs = join(env.HF_HOME, 'hub', `models--${PINS.weights.repo.replace('/', '--')}`, 'refs', 'main')
      const cached = existsSync(refs) ? readFileSync(refs, 'utf8') : null
      if (env.HF_HUB_OFFLINE === '1' && !cached) return { code: 1, err: "fetch_weights: Laya could not load english: We couldn't connect to 'https://huggingface.co' to load the files, and couldn't find them in the cached files.\n" }
      const commit = env.HF_HUB_OFFLINE === '1' ? cached : hubCommit
      const snap = env.HF_HUB_OFFLINE === '1' ? snapshotDir(env.HF_HOME, PINS.weights.repo, commit) : plantSnapshot(env.HF_HOME, commit)
      return ok(`${JSON.stringify({ repo: PINS.weights.repo, checkpoint: 'english', commit, snapshot: snap, files: { 'model.safetensors': 7 } })}\n`)
    }
    if (basename(cmd) === 'tar.exe') { writeFileSync(h.paths.uv, ''); return ok() }
    return { code: 127, err: `no such command in this machine: ${cmd} ${args.join(' ')}\n` }
  }
  const spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 40_000 + calls.length, killed: false })
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')) }
    const call = { cmd, args, env: opts.env, cwd: opts.cwd, child }
    calls.push(call)
    setImmediate(async () => {
      const r = (await answer(call)) ?? standard(call)
      if (r === 'hang') return
      if (r.out) child.stdout.emit('data', Buffer.from(r.out))
      if (r.err) child.stderr.emit('data', Buffer.from(r.err))
      child.emit('exit', r.code ?? 0, null)
    })
    return child
  }
  return { spawn, calls, uvCalls: () => calls.filter((c) => c.cmd === h.paths.uv).map((c) => c.args) }
}

/** The running sidecar, as the installer sees it. */
function sidecarStub({ ready = false, held = [], check = { ok: true, device: 'cuda', deviceWhy: null }, installed = null } = {}) {
  const s = { calls: [], jobs: [] }
  Object.assign(s, {
    isReady: () => ready,
    status: () => ({ state: ready ? 'ready' : 'stopped' }),
    held: () => held,
    installed: () => installed,
    suspend: () => s.calls.push('suspend'),
    resume: () => s.calls.push('resume'),
    stop: async ({ reason }) => { s.calls.push(`stop:${reason}`); ready = false },
    start: async ({ reason }) => { s.calls.push(`start:${reason}`); ready = true },
    checkStart: async (o) => { s.calls.push(`check:${o.device}:${basename(o.venv)}`); return typeof check === 'function' ? check(o) : check },
    noteInstall: (j) => { if (j) s.jobs.push({ step: j.step, name: j.name, done: j.done, error: j.error }) },
  })
  return s
}

function installerFor(h, m, { sidecar = sidecarStub(), driver = 12.8, fetch, ...deps } = {}) {
  const probes = []
  const logs = []
  const installer = createLayaInstaller({
    harnessDir: h.harnessDir, dataDir: h.dataDir, pins: PINS, platform: 'win32', spawn: m.spawn, sidecar,
    specs: async () => ({ cuda: driver, gpus: driver ? [{ name: GPU, vendor: 'nvidia' }] : [] }),
    fetch: fetch ?? (async (url) => { probes.push(new URL(url).host); return { ok: true, status: 200 } }),
    freeBytes: async () => 100 * GB, sleep: async () => {}, log: (l) => logs.push(l), progressEveryMs: 5,
    ...deps,
  })
  return { installer, probes, logs, sidecar }
}

test('the torch indexes to try: every pinned CUDA tag the driver can run, newest first; none without a driver or one too old', () => {
  const tags = (d) => torchIndexes(PINS.torch.cuda, d).map((c) => c.tag)
  assert.deepEqual(tags(13.1), ['cu130', 'cu128', 'cu126'])
  assert.deepEqual(tags(13.0), ['cu130', 'cu128', 'cu126'])
  assert.deepEqual(tags(12.8), ['cu128', 'cu126'])
  assert.deepEqual(tags(12.6), ['cu126'])
  assert.deepEqual(tags(12.4), [])
  assert.deepEqual(tags(null), [])
})

test('an install for the GPU: every step in order with its exact command, uv pip install and never sync, and the records it leaves', async () => {
  const h = harness()
  withUv(h)
  const m = machine(h)
  const { installer, probes, sidecar } = installerFor(h, m)
  const got = await installer.install({ device: 'gpu' })
  const venvNewPy = h.paths.pythonOf(h.paths.venvNew)
  assert.deepEqual(probes, ['github.com', 'pypi.org', 'files.pythonhosted.org', 'huggingface.co', 'download.pytorch.org'], 'every download host is probed first')
  assert.deepEqual(m.uvCalls(), [
    ['--version'],
    ['python', 'install', '3.12'],
    ['venv', '--relocatable', '--python', '3.12', '--python-preference', 'only-managed', h.paths.venvNew],
    ['pip', 'install', '--python', venvNewPy, 'torch==2.14.0', '--index-url', 'https://download.pytorch.org/whl/cu128'],
    ['pip', 'install', '--python', venvNewPy, '--no-deps', '--require-hashes', '-r', h.paths.requirementsLock],
    ['pip', 'check', '--python', venvNewPy],
  ])
  assert.ok(m.calls.every((c) => !c.args.includes('sync')), 'never uv pip sync: it would uninstall torch, which the lock leaves out')
  for (const c of m.calls.filter((x) => x.cmd === h.paths.uv)) {
    assert.deepEqual([c.env.UV_PYTHON_INSTALL_DIR, c.env.UV_CACHE_DIR, c.env.UV_NO_CONFIG], [h.paths.python, h.paths.cache, '1'], 'nothing lands in the person\'s profile')
  }
  const others = m.calls.filter((c) => c.cmd !== h.paths.uv)
  assert.deepEqual(others.map((c) => [c.cmd, ...c.args.slice(0, 2)]), [[venvNewPy, '-I', '-c'], [venvNewPy, '-I', '-u'], [venvNewPy, '-I', '-u']], 'the import check, then the weights offline and online')
  assert.deepEqual(others[1].args, ['-I', '-u', '-X', 'utf8', h.paths.fetchWeights, '--repo', 'convaiinnovations/laya', '--checkpoint', 'english'])
  assert.equal(others[1].cwd, h.paths.run)
  assert.deepEqual(sidecar.calls, ['suspend', 'check:cuda:venv.new', 'stop:update', 'resume'], 'the new install is started and checked before the swap')
  assert.deepEqual([...new Set(sidecar.jobs.map((j) => `${j.step} ${j.name}`))], [
    '0 null', '1 Checking the downloads and disk', '2 Getting uv', '3 Getting Python 3.12', '4 Installing PyTorch 2.14.0 for the GPU',
    '4 Installing PyTorch 2.14.0 for the GPU (CUDA 12.8)', '5 Installing Laya 0.3.20', '6 Downloading the Laya model from Hugging Face', '7 Checking that it starts', '8 Cleaning up',
  ])
  assert.equal(sidecar.jobs.at(-1).done, true)

  // The swap is complete: one venv, nothing left beside it.
  assert.ok(existsSync(h.paths.pythonOf(h.paths.venv)))
  for (const p of [h.paths.venvNew, h.paths.venvOld, h.paths.swap, h.paths.cache, h.paths.lock]) assert.ok(!existsSync(p), `${basename(p)} is gone`)
  const installed = JSON.parse(readFileSync(h.paths.installed, 'utf8'))
  assert.deepEqual(Object.keys(installed), ['laya', 'torch', 'torchIndex', 'cuda', 'gpu', 'python', 'uv', 'lockSha256', 'torchWheels', 'installedAt'])
  assert.deepEqual({ ...installed, installedAt: null }, {
    laya: '0.3.20', torch: '2.14.0+cu128', torchIndex: 'cu128', cuda: true, gpu: GPU, python: '3.12.11', uv: '0.12.18', lockSha256: LOCK_SHA,
    torchWheels: [{ name: 'torch', version: '2.14.0+cu128', recordSha256: sha('torch/__init__.py,sha256=abc,100\n# cu128\n') }], installedAt: null,
  })
  assert.deepEqual(got, installed)
  // weights.json: every file of the snapshot as it was after the load, with size, mtime and hash.
  const weights = JSON.parse(readFileSync(h.paths.weights, 'utf8'))
  assert.deepEqual([weights.repo, weights.commit], [PINS.weights.repo, COMMIT])
  assert.deepEqual(Object.keys(weights.files), ['encoder/config.json', 'model.safetensors', 'rl_agent_config.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json'])
  const snap = snapshotDir(h.paths.hf, PINS.weights.repo, COMMIT)
  for (const [rel, f] of Object.entries(weights.files)) {
    const st = statSync(join(snap, rel))
    assert.deepEqual(f, { size: st.size, mtimeMs: st.mtimeMs, sha256: sha(readFileSync(join(snap, rel))) }, rel)
  }
  assert.equal(weights.files['tokenizer/tokenizer_config.json'].sha256, sha(FIXED_TOKENIZER), 'recorded after the load rewrote it')
  assert.ok(weights.downloadedAt && weights.loadedAt)
  // Every step and every command, with its output, in install.log.
  await installer.logged()
  const log = readFileSync(h.paths.installLog, 'utf8')
  assert.match(log, /^\S+ step 1 of 8: Checking the downloads and disk$/m)
  assert.ok(log.includes(`> ${h.paths.uv} pip check --python ${venvNewPy}\nChecked 62 packages in 4ms\nAll installed packages are compatible\n`), log)
  assert.match(log, /Installed Laya 0\.3\.20\.$/m)
})

test('the card is told each step\'s start and the device the install is for, and what an install takes before there is one', async () => {
  const h = harness()
  withUv(h)
  let clock = 1_000_000
  const sidecar = sidecarStub()
  const told = []
  sidecar.noteInstall = (j) => { if (j) told.push({ step: j.step, device: j.device, stepStartedAt: j.stepStartedAt }) }
  const { installer } = installerFor(h, machine(h), { sidecar, now: () => (clock += 1000) })
  await installer.install({ device: 'gpu' })
  const steps = told.filter((j) => j.step >= 1)
  assert.ok(steps.length >= 8 && steps.every((j) => j.device === 'gpu'), JSON.stringify(told))
  assert.ok(steps.every((j) => typeof j.stepStartedAt === 'number'), 'every step says when it began')
  const byStep = new Map()
  for (const j of steps) byStep.set(j.step, [...(byStep.get(j.step) ?? []), j.stepStartedAt])
  assert.ok([...byStep.values()].every((v) => new Set(v).size === 1), 'the same in every report of one step')
  const began = [...byStep.values()].map((v) => v[0])
  assert.equal(new Set(began).size, 8, 'each step its own start')
  assert.deepEqual(began, [...began].sort((a, b) => a - b), 'in order')
  // Before anything is installed: the GPU where the driver runs a pinned CUDA build, and the figures.
  const { installOffer } = await import('../laya-install.js')
  assert.equal(typeof installOffer, 'function')
  assert.deepEqual(installOffer(PINS, { cuda: 12.8, gpus: [{ name: GPU, vendor: 'nvidia' }] }), {
    gpu: { name: GPU, cuda: 12.8 }, python: '3.12',
    disk: { gpu: { installingGB: 8 }, cpu: { installingGB: 3 } },
    torch: { gpu: { bytes: 2.5 * GB, source: 'download.pytorch.org' }, cpu: { bytes: 120 * 1024 ** 2, source: 'PyPI' } },
  })
  assert.equal(installOffer(PINS, { cuda: 12.4, gpus: [{ name: GPU, vendor: 'nvidia' }] }).gpu, null, 'a driver older than every pinned build: the CPU')
  assert.equal(installOffer(null, null).torch, null, 'pins that could not be read name no download')
})

test('a log of Laya\'s own is rotated past its size, keeping two older files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'laya-log-'))
  const file = join(dir, 'install.log')
  const log = createRotatingLog(file, { maxBytes: 10 })
  for (const line of ['one 123456\n', 'two 123456\n', 'three 1234\n', 'four 12345\n']) log.append(line)
  await log.flushed()
  assert.deepEqual([readFileSync(file, 'utf8'), readFileSync(`${file}.1`, 'utf8'), readFileSync(`${file}.2`, 'utf8')], ['four 12345\n', 'three 1234\n', 'two 123456\n'])
})

test('Check for a newer model fetches main into a staging cache and compares commits; Use the newer model loads it, swaps it in and records it', async () => {
  const h = harness()
  installedBefore(h, '0.3.20')
  plantSnapshot(h.paths.hf)
  await recordWeights(h.paths, { repo: PINS.weights.repo, commit: COMMIT, downloadedAt: 'then', loadedAt: 'then' })
  const same = installerFor(h, machine(h)).installer
  assert.deepEqual(await same.checkWeights(), { current: COMMIT, latest: COMMIT, changed: false })
  assert.ok(!existsSync(h.paths.hfStaging), 'nothing staged when nothing changed')
  const NEWER = 'ab'.repeat(20)
  const sidecar = sidecarStub({ ready: true })
  const m = machine(h, { hubCommit: NEWER })
  const { installer } = installerFor(h, m, { sidecar })
  assert.deepEqual(await installer.checkWeights(), { current: COMMIT, latest: NEWER, changed: true })
  assert.ok(existsSync(snapshotDir(h.paths.hfStaging, PINS.weights.repo, NEWER)))
  assert.equal(JSON.parse(readFileSync(h.paths.weights, 'utf8')).commit, COMMIT, 'checking changes nothing in use')
  const rec = await installer.applyWeights()
  assert.equal(rec.commit, NEWER)
  const runs = m.calls.filter((c) => c.args.includes(h.paths.fetchWeights))
  assert.deepEqual(runs.at(-1).env.HF_HUB_OFFLINE, '1', 'the staged files are loaded once through Laya, offline, before they are used')
  assert.deepEqual(sidecar.calls, ['suspend', 'stop:update', 'resume', 'start:update'])
  assert.equal(JSON.parse(readFileSync(h.paths.weights, 'utf8')).commit, NEWER)
  assert.ok(existsSync(snapshotDir(h.paths.hf, PINS.weights.repo, NEWER)) && !existsSync(h.paths.hfStaging) && !existsSync(h.paths.hfOld))
  await assert.rejects(installer.applyWeights(), { message: 'No newer model has been downloaded; choose Check for a newer model first.' })
})

test('a fresh PC without uv gets the pinned build, checked by size and SHA-256', async () => {
  const h = harness()
  const archive = Buffer.from('the uv release archive')
  const pins = { ...PINS, uv: { ...PINS.uv, size: archive.length, sha256: sha(archive) } }
  const m = machine(h)
  const fetched = []
  const fetch = async (url, opts) => {
    if (opts?.method === 'HEAD') return { ok: true, status: 200 }
    fetched.push(url)
    return { ok: true, status: 200, body: (async function* () { yield archive })() }
  }
  const installer = createLayaInstaller({ harnessDir: h.harnessDir, dataDir: h.dataDir, pins, platform: 'win32', spawn: m.spawn, sidecar: sidecarStub(), specs: async () => ({ cuda: 12.8 }), fetch, freeBytes: async () => 100 * GB, sleep: async () => {}, progressEveryMs: 5 })
  await installer.install({ device: 'gpu' })
  assert.deepEqual(fetched, [PINS.uv.source])
  const tar = m.calls.find((c) => basename(c.cmd) === 'tar.exe')
  assert.deepEqual(tar.args, ['-xf', join(h.paths.uvDir, 'uv-x86_64-pc-windows-msvc.zip'), '-C', h.paths.uvDir])
  assert.ok(!existsSync(join(h.paths.uvDir, 'uv-x86_64-pc-windows-msvc.zip')), 'the archive goes once unpacked')
  const version = m.calls.findIndex((c) => c.cmd === h.paths.uv && c.args[0] === '--version')
  assert.ok(version > m.calls.indexOf(tar), 'the version is checked once it is unpacked')
})

test('PyTorch falls through the CUDA tags on a 404 or no matching distribution, naming each tag tried; with every tag failing it offers the CPU', async () => {
  const h = harness()
  withUv(h)
  const m = machine(h, { torch: (tag) => ({ cu130: '404', cu128: 'no-solution' })[tag] ?? 'ok' })
  const { installer, logs } = installerFor(h, m, { driver: 13.1 })
  const got = await installer.install({ device: 'gpu' })
  assert.deepEqual(m.uvCalls().filter((a) => a.includes('torch==2.14.0')).map((a) => a.at(-1)), ['https://download.pytorch.org/whl/cu130', 'https://download.pytorch.org/whl/cu128', 'https://download.pytorch.org/whl/cu126'])
  const lines = installer.status().job.lines
  assert.ok(lines.includes('PyTorch 2.14.0 has no Windows wheel for cu130; trying cu128.'), lines.join('\n'))
  assert.ok(lines.includes('PyTorch 2.14.0 has no Windows wheel for cu128; trying cu126.'))
  assert.equal(got.torchIndex, 'cu126')
  assert.ok(logs.includes('laya install: PyTorch 2.14.0 has no Windows wheel for cu130; trying cu128.'))

  const h2 = harness()
  withUv(h2)
  installedBefore(h2)
  const none = machine(h2, { torch: () => '404' })
  const { installer: failing } = installerFor(h2, none, { driver: 12.8 })
  await assert.rejects(failing.install({ device: 'gpu' }), { message: 'PyTorch 2.14.0 has no Windows wheel for cu128, cu126; the driver supports CUDA 12.8.' })
  const job = failing.status().job
  assert.deepEqual([job.failedStep, job.failedName, job.offerCpu], [4, 'Installing PyTorch 2.14.0 for the GPU (CUDA 12.8)', true], 'Install for the CPU instead is offered')
  assert.ok(!existsSync(h2.paths.venvNew))
  assert.ok(existsSync(join(h2.paths.venv, 'old-install.txt')), 'the install that was there is untouched')
})

test('the CPU: no NVIDIA driver means the CPU wheel from PyPI, and PyTorch reporting no CUDA on an NVIDIA machine says so and what to do', async () => {
  const h = harness()
  withUv(h)
  const m = machine(h, { imported: { torch: '2.14.0+cpu', cuda: false, gpu: null } })
  const { installer, probes } = installerFor(h, m, { driver: null })
  const got = await installer.install({ device: 'gpu' })
  assert.deepEqual(m.uvCalls().find((a) => a.includes('torch==2.14.0')), ['pip', 'install', '--python', h.paths.pythonOf(h.paths.venvNew), 'torch==2.14.0'], 'PyPI, no index URL')
  assert.ok(installer.status().job.notes.includes('No NVIDIA driver was found, so PyTorch 2.14.0 is installed for the CPU.'))
  assert.deepEqual([got.cuda, got.torchIndex], [false, 'pypi'])
  assert.ok(probes.includes('download.pytorch.org'), 'asked for the GPU, so its host was probed')

  const h2 = harness()
  withUv(h2)
  const m2 = machine(h2, { imported: { torch: '2.14.0+cu128', cuda: false, gpu: null } })
  const { installer: second } = installerFor(h2, m2, { driver: 12.8 })
  const got2 = await second.install({ device: 'gpu' })
  assert.ok(second.status().job.notes.includes('Installed for the CPU: PyTorch reports no usable CUDA (driver CUDA 12.8). Update the NVIDIA driver, then choose Remove and Install Laya again.'))
  assert.equal(got2.cuda, false)
  assert.equal(m2.uvCalls().filter((a) => a.includes('torch==2.14.0')).length, 1, 'nothing is retried silently')

  const h3 = harness()
  withUv(h3)
  const m3 = machine(h3, { imported: { torch: '2.14.0+cpu', cuda: false, gpu: null } })
  const { installer: cpu, probes: cpuProbes, sidecar } = installerFor(h3, m3)
  await cpu.install({ device: 'cpu' })
  assert.ok(!cpuProbes.includes('download.pytorch.org'), 'the CPU install needs no PyTorch index')
  assert.ok(sidecar.calls.includes('check:cpu:venv.new'))
})

test('a failed step keeps the previous install exactly as it was and removes only what it built', async () => {
  const h = harness()
  withUv(h)
  installedBefore(h)
  const before = readFileSync(h.paths.installed, 'utf8')
  const m = machine(h, { answer: (c) => (c.args[1] === 'check' ? { code: 1, err: 'error: laya 0.3.20 requires transformers>=5.1, but 4.57.0 is installed\n' } : null) })
  const { installer, sidecar } = installerFor(h, m, { sidecar: sidecarStub({ installed: { laya: '0.3.19' } }) })
  await assert.rejects(installer.install({ device: 'gpu' }), { message: 'uv pip check failed: error: laya 0.3.20 requires transformers>=5.1, but 4.57.0 is installed' })
  const job = installer.status().job
  assert.deepEqual([job.failedStep, job.failedName], [5, 'Installing Laya 0.3.20'])
  assert.ok(job.lines.includes('Install failed at step 5 (Installing Laya 0.3.20): uv pip check failed: error: laya 0.3.20 requires transformers>=5.1, but 4.57.0 is installed'))
  assert.ok(!existsSync(h.paths.venvNew), 'venv.new removed')
  assert.ok(existsSync(join(h.paths.venv, 'old-install.txt')), 'the running venv untouched')
  assert.equal(readFileSync(h.paths.installed, 'utf8'), before)
  assert.ok(!existsSync(h.paths.lock), 'the lock is given back')
  assert.ok(!sidecar.calls.some((c) => c.startsWith('stop')), 'nothing was stopped')
  // Step 1 names a host that does not answer.
  const h2 = harness()
  const { installer: offline } = installerFor(h2, machine(h2), { fetch: async (url) => { if (url.includes('huggingface')) throw new Error('getaddrinfo ENOTFOUND huggingface.co'); return { ok: true } } })
  await assert.rejects(offline.install({ device: 'gpu' }), { message: 'Cannot reach huggingface.co (getaddrinfo ENOTFOUND huggingface.co). Check the internet connection, or a firewall or proxy that blocks it.' })
  const h3 = harness()
  const { installer: full } = installerFor(h3, machine(h3), { freeBytes: async () => 5 * GB })
  await assert.rejects(full.install({ device: 'gpu' }), { message: 'Not enough free disk: Laya needs about 8 GB while installing for the GPU, and 5 GB is free.' })
})

test('the swap retries a rename Windows refuses for a while (EBUSY) and completes', async () => {
  const h = harness()
  withUv(h)
  installedBefore(h)
  const renames = []
  let busy = 2
  const rename = async (from, to) => {
    renames.push(`${basename(from)} -> ${basename(to)}`)
    if (basename(from) === 'venv.new' && busy-- > 0) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
    return fsRename(from, to)
  }
  const { installer } = installerFor(h, machine(h), { rename, sidecar: sidecarStub({ ready: true, installed: { laya: '0.3.19' } }) })
  await installer.install({ device: 'gpu' })
  assert.deepEqual(renames, ['venv -> venv.old', 'venv.new -> venv', 'venv.new -> venv', 'venv.new -> venv'])
  assert.ok(!existsSync(join(h.paths.venv, 'old-install.txt')), 'the new venv is in place')
  assert.ok(!existsSync(h.paths.venvOld) && !existsSync(h.paths.swap))
  assert.equal(JSON.parse(readFileSync(h.paths.installed, 'utf8')).laya, '0.3.20')
})

test('an engine killed between the two renames is rolled back by recover() at the next start; one killed after them is completed', async () => {
  const h = harness()
  withUv(h)
  installedBefore(h)
  // The second rename never returns: the engine is gone at that moment.
  const rename = (from, to) => (basename(from) === 'venv.new' ? new Promise(() => {}) : fsRename(from, to))
  const { installer: dying } = installerFor(h, machine(h), { rename })
  dying.install({ device: 'gpu' }).catch(() => {})
  await waitFor('killed between the renames', () => existsSync(h.paths.swap) && JSON.parse(readFileSync(h.paths.swap, 'utf8')).step, (s) => s === 'renamed-old', { timeoutMs: 10_000 })
  assert.ok(!existsSync(h.paths.venv) && existsSync(h.paths.venvOld) && existsSync(h.paths.venvNew), 'no venv at all: what the kill leaves')
  // The next start, in a new engine.
  const logs = []
  const { installer: next } = installerFor(h, machine(h), { log: (l) => logs.push(l) })
  assert.equal(await next.recover(), 'An interrupted Laya install was rolled back; Laya 0.3.19 is still installed.')
  assert.ok(existsSync(join(h.paths.venv, 'old-install.txt')), 'the old venv is back')
  for (const p of [h.paths.venvOld, h.paths.venvNew, h.paths.swap]) assert.ok(!existsSync(p), basename(p))
  assert.equal(JSON.parse(readFileSync(h.paths.installed, 'utf8')).laya, '0.3.19')
  assert.equal(next.status().message, 'An interrupted Laya install was rolled back; Laya 0.3.19 is still installed.')
  assert.ok(logs.includes('laya install: An interrupted Laya install was rolled back; Laya 0.3.19 is still installed.'))

  // Killed after the second rename, before installed.json: the journal carries it, and the swap is finished.
  mkdirSync(h.paths.venvOld, { recursive: true })
  writeFileSync(join(h.paths.venvOld, 'old-install.txt'), 'old')
  writeFileSync(h.paths.swap, JSON.stringify({ step: 'renamed-new', from: 'venv', to: 'venv.new', installed: { laya: '0.3.20', torch: '2.14.0+cu128' } }))
  assert.equal(await next.recover(), 'An interrupted Laya install was completed; Laya 0.3.20 is installed.')
  assert.equal(JSON.parse(readFileSync(h.paths.installed, 'utf8')).laya, '0.3.20')
  assert.ok(!existsSync(h.paths.venvOld) && !existsSync(h.paths.swap))
})

test('a stale venv.new with no journal is deleted at the next start, and so is a venv.old left by a delete that failed', async () => {
  const h = harness()
  installedBefore(h)
  mkdirSync(join(h.paths.venvNew, 'Lib'), { recursive: true })
  mkdirSync(h.paths.venvOld, { recursive: true })
  const logs = []
  const { installer } = installerFor(h, machine(h), { log: (l) => logs.push(l) })
  assert.equal(await installer.recover(), null, 'nothing to say on the card')
  assert.ok(!existsSync(h.paths.venvNew) && !existsSync(h.paths.venvOld))
  assert.ok(existsSync(join(h.paths.venv, 'old-install.txt')))
  assert.ok(logs.includes('laya install: deleted a venv.new left by an install that stopped'))
})

test('install.lock: one installer at a time, a second caller refused with the pid, a dead holder\'s lock taken over; the CLI refuses while Kz-harness runs', async (t) => {
  const h = harness()
  const release = await takeInstallLock(h.paths, { pid: 4321, alive: () => true })
  await assert.rejects(takeInstallLock(h.paths, { pid: 999, alive: () => true }), { message: 'Another Laya install is running (pid 4321).' })
  const second = installerFor(h, machine(h), { alive: () => true }).installer
  await assert.rejects(second.install({ device: 'cpu' }), { message: 'Another Laya install is running (pid 4321).' })
  assert.equal(second.status().job.error, 'Another Laya install is running (pid 4321).', 'the card says why')
  const takeover = await takeInstallLock(h.paths, { pid: 777, alive: (pid) => pid !== 4321 })
  assert.equal(readFileSync(h.paths.lock, 'utf8'), '777', 'a lock whose holder has gone is taken over')
  await takeover()
  await release()
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(2147483647), false)

  // The command line: refused while the engine answers on its port, a usage error otherwise.
  const { main, HARNESS_RUNNING } = await import('../laya/install-cli.mjs')
  const engine = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => r(s)) })
  t.after(() => engine.close())
  const err = []
  const asked = []
  const stub = { recover: async () => null, install: async (o) => { asked.push(o); return { laya: '0.3.20', cuda: false, torchIndex: 'pypi' } }, status: () => ({ job: { notes: [] } }) }
  assert.equal(await main(['install'], { enginePort: engine.address().port, installer: stub, err: (l) => err.push(l), out: () => {} }), 1)
  assert.deepEqual(err, ['Close Kz-harness first, or install Laya from Settings → Jev setup → Laya decision model.'])
  assert.equal(HARNESS_RUNNING, err[0])
  assert.deepEqual(asked, [], 'nothing was run')
  const free = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
  const out = []
  assert.equal(await main(['install', '--cpu'], { enginePort: free, installer: stub, out: (l) => out.push(l), err: () => {} }), 0)
  assert.deepEqual(asked, [{ device: 'cpu' }])
  assert.deepEqual(out, ['ok: Laya 0.3.20 installed (for the CPU).'])
  assert.equal(await main(['frobnicate'], { enginePort: free, installer: stub, err: () => {} }), 2)
})

test('an update builds beside the running Laya, stops it for step 7, and starts the old one again when the check fails; refused while a Laya Auto run holds it', async () => {
  const h = harness()
  withUv(h)
  installedBefore(h, '0.3.20')
  const sidecar = sidecarStub({ ready: true, installed: { laya: '0.3.20' }, check: { ok: false, error: 'the protocol checks failed: intent.task: 500 inference failed' } })
  const { installer, probes } = installerFor(h, machine(h), { sidecar })
  await assert.rejects(installer.update(), { message: 'The new install did not pass its check: the protocol checks failed: intent.task: 500 inference failed' })
  assert.deepEqual(sidecar.calls, ['suspend', 'stop:update', 'check:cuda:venv.new', 'resume', 'start:update'], 'stopped before the check, started again after it failed')
  assert.ok(installer.status().job.lines.includes('Update failed at step 7 (Checking that it starts); still on Laya 0.3.20.'))
  assert.ok(existsSync(join(h.paths.venv, 'old-install.txt')) && !existsSync(h.paths.venvNew))
  assert.ok(!probes.includes('huggingface.co'), 'an update leaves the weights alone')

  const ok = sidecarStub({ ready: true, installed: { laya: '0.3.20' } })
  const { installer: updating } = installerFor(h, machine(h), { sidecar: ok })
  await updating.update()
  assert.deepEqual(ok.calls, ['suspend', 'stop:update', 'check:cuda:venv.new', 'stop:update', 'resume', 'start:update'], 'the new one runs once swapped in')
  assert.ok(!existsSync(join(h.paths.venv, 'old-install.txt')))

  // A Laya Auto run that opens while the update downloads is still refused at step 7.
  const holds = ['keepLoaded']
  const held = sidecarStub({ ready: true, held: holds, installed: { laya: '0.3.20' } })
  const opens = machine(h, { answer: (c) => { if (c.cmd === h.paths.uv && c.args[0] === 'pip' && c.args[1] === 'install') holds.push('run:42') } })
  const { installer: refused } = installerFor(h, opens, { sidecar: held })
  await assert.rejects(refused.update(), { message: 'Laya is deciding for an open Laya Auto run; stop that run first.' })
  assert.ok(!held.calls.some((c) => c.startsWith('stop')), 'the open run keeps its Laya')
  assert.equal(refused.status().job.failedStep, 7)
})

test('an update is refused before it downloads anything while a Laya Auto run holds Laya: nothing is run, stopped or started, and the job says why', async () => {
  const h = harness()
  withUv(h)
  installedBefore(h, '0.3.20')
  const held = sidecarStub({ ready: true, held: ['run:42', 'keepLoaded'], installed: { laya: '0.3.20' } })
  const m = machine(h)
  const { installer, probes } = installerFor(h, m, { sidecar: held })
  await assert.rejects(installer.update(), { message: 'Laya is deciding for an open Laya Auto run; stop that run first.' })
  assert.deepEqual(m.calls.map((c) => [c.cmd, ...c.args].join(' ')), [], 'no command ran: nothing was downloaded or built')
  assert.deepEqual(probes, [], 'and no host was probed')
  assert.deepEqual(held.calls, [], 'the running Laya was neither stopped nor started')
  const { job } = installer.status()
  assert.deepEqual([job.kind, job.step, job.failedStep, job.error], ['update', 0, null, 'Laya is deciding for an open Laya Auto run; stop that run first.'])
  assert.ok(job.lines.includes('Laya is deciding for an open Laya Auto run; stop that run first.'), 'the install log says why')
  assert.ok(existsSync(join(h.paths.venv, 'old-install.txt')), 'the running install is untouched')
})

test('no command the installer runs gets the person\'s secrets: no TypeSafe setting and no Hugging Face token reaches uv, Python or Laya\'s loader', async (t) => {
  const planted = { TYPESAFE_API_KEY: 'tsk_PROBE_SECRET_123456789', TYPESAFE_BASE_URL: 'https://jev.example', typesafe_org: 'lowercase-too', HF_TOKEN: 'hf_PROBE_SECRET', HUGGING_FACE_HUB_TOKEN: 'hf_PROBE_OLD_NAME' }
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]))
  Object.assign(process.env, planted)
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const h = harness()
  withUv(h)
  const m = machine(h)
  const { installer } = installerFor(h, m)
  await installer.install({ device: 'gpu' })
  await installer.repair()
  const ran = (c) => [basename(c.cmd), ...c.args.slice(0, 2)].join(' ')
  assert.ok(m.calls.length >= 10, `the install and the repair ran their commands: ${m.calls.map(ran).join(', ')}`)
  assert.ok(m.calls.some((c) => c.args.includes(h.paths.fetchWeights) && c.env.HF_HUB_OFFLINE !== '1'), 'Laya\'s loader among them, online')
  for (const c of m.calls) {
    assert.deepEqual(Object.keys(c.env).filter((k) => k in planted), [], `${ran(c)}: none of the secrets`)
    assert.ok(!Object.values(c.env).some((v) => /PROBE|lowercase-too/.test(String(v))), `${ran(c)}: nor their values under any name`)
  }
  assert.equal(process.env.TYPESAFE_API_KEY, planted.TYPESAFE_API_KEY, 'the harness\'s own environment keeps them')
})

test('the weights: offline first with Xet off, online only when that fails, and recorded only after a load; Repair of a copied cache needs no network', async () => {
  const h = harness()
  withUv(h)
  const m = machine(h)
  const { installer } = installerFor(h, m)
  await installer.install({ device: 'gpu' })
  const runs = m.calls.filter((c) => c.args.includes(h.paths.fetchWeights))
  assert.equal(runs.length, 2)
  const env = (c) => Object.fromEntries(['HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_XET', 'HF_HUB_DISABLE_TELEMETRY', 'HF_HUB_DISABLE_SYMLINKS_WARNING'].map((k) => [k, c.env[k]]))
  assert.deepEqual(env(runs[0]), { HF_HOME: h.paths.hf, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_XET: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' })
  assert.deepEqual(env(runs[1]), { HF_HOME: h.paths.hf, HF_HUB_OFFLINE: undefined, TRANSFORMERS_OFFLINE: undefined, HF_HUB_DISABLE_XET: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' })

  // Nothing loads: nothing is recorded.
  const h2 = harness()
  withUv(h2)
  const broken = machine(h2, { answer: (c) => (c.args.includes(h2.paths.fetchWeights) ? { code: 1, err: 'fetch_weights: Laya could not load english: 403 Forbidden\n' } : null) })
  const { installer: failing } = installerFor(h2, broken)
  await assert.rejects(failing.install({ device: 'gpu' }), { message: 'The Laya model did not download: fetch_weights: Laya could not load english: 403 Forbidden' })
  assert.ok(!existsSync(h2.paths.weights), 'weights.json only ever follows a load')
  assert.equal(failing.status().job.failedStep, 6)

  // A cache copied from another PC: Repair loads it offline, records it, and never reaches the network.
  const h3 = harness()
  installedBefore(h3, '0.3.20')
  plantSnapshot(h3.paths.hf)
  const copied = machine(h3)
  let fetched = 0
  const { installer: repairing } = installerFor(h3, copied, { fetch: async () => { fetched++; return { ok: true } } })
  const rec = await repairing.repair()
  assert.equal(rec.commit, COMMIT)
  assert.equal(copied.calls.length, 1, 'one offline run')
  assert.equal(copied.calls[0].cmd, h3.paths.pythonOf(h3.paths.venv), 'with the installed venv')
  assert.equal(fetched, 0)
  assert.ok(existsSync(h3.paths.weights))
})

test('the start-time check of the weights: a tokenizer config Laya rewrote on load is recorded again, anything else changed or missing refuses', async () => {
  const h = harness()
  const snap = plantSnapshot(h.paths.hf)
  await recordWeights(h.paths, { repo: PINS.weights.repo, commit: COMMIT, downloadedAt: 'then', loadedAt: 'then' })
  const logs = []
  const check = () => verifyWeights(h.paths, { platform: 'win32', log: (l) => logs.push(l) })
  assert.equal((await check()).ok, true)
  // Rewritten on a load, still JSON: re-recorded, with a line in the log.
  writeFileSync(join(snap, 'tokenizer', 'tokenizer_config.json'), '{"tokenizer_class": "PreTrainedTokenizerFast", "model_max_length": 512}')
  assert.equal((await check()).ok, true)
  assert.deepEqual(logs, ['laya: tokenizer/tokenizer_config.json was rewritten by Laya\'s loader; recorded again'])
  assert.equal(JSON.parse(readFileSync(h.paths.weights, 'utf8')).files['tokenizer/tokenizer_config.json'].sha256, sha('{"tokenizer_class": "PreTrainedTokenizerFast", "model_max_length": 512}'))
  // Only a new mtime, the same bytes: re-dated, nothing said.
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(snap, 'model.safetensors'), later, later)
  assert.equal((await check()).ok, true)
  assert.equal(logs.length, 1)
  assert.equal(Math.floor(JSON.parse(readFileSync(h.paths.weights, 'utf8')).files['model.safetensors'].mtimeMs), Math.floor(statSync(join(snap, 'model.safetensors')).mtimeMs))
  // Anything else refuses, naming the file.
  writeFileSync(join(snap, 'tokenizer', 'tokenizer_config.json'), 'not json {')
  assert.deepEqual(await check(), { ok: false, why: "Laya's model files are not complete on this PC (tokenizer/tokenizer_config.json has changed). Choose Repair, or copy models\\laya\\hf from another PC." })
  writeFileSync(join(snap, 'tokenizer', 'tokenizer_config.json'), '{}')
  writeFileSync(join(snap, 'model.safetensors'), 'other weights')
  assert.deepEqual(await check(), { ok: false, why: "Laya's model files are not complete on this PC (model.safetensors has changed). Choose Repair, or copy models\\laya\\hf from another PC." })
  rmSync(join(snap, 'model.safetensors'))
  assert.deepEqual(await check(), { ok: false, why: "Laya's model files are not complete on this PC (model.safetensors is missing). Choose Repair, or copy models\\laya\\hf from another PC." })
  rmSync(h.paths.weights)
  assert.equal((await check()).ok, false)
})

test('a step with no output and no bytes for 5 minutes fails, naming the step, and its command is stopped', async () => {
  const h = harness()
  withUv(h)
  let clock = 1_000_000
  let hung = null
  const m = machine(h, { answer: (c) => (c.args.includes('--require-hashes') ? (hung = c, 'hang') : null) })
  const { installer } = installerFor(h, m, { now: () => clock })
  const run = installer.install({ device: 'gpu' })
  run.catch(() => {})
  await waitFor('the lock install to be running', () => hung, (c) => c !== null, { timeoutMs: 10_000 })
  await new Promise((r) => setTimeout(r, 30))
  clock += 299_000
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(hung.child.killed, false, 'under 5 minutes')
  clock += 1_001
  await assert.rejects(run, { message: 'No progress for 5 minutes while Installing Laya 0.3.20.' })
  assert.equal(hung.child.killed, true)
  assert.ok(!existsSync(h.paths.venvNew))
})

test('Remove stops Laya and deletes engine\\laya and models\\laya; the recorded comparisons and samples stay; Cancel ends an install', async () => {
  const h = harness()
  installedBefore(h)
  plantSnapshot(h.paths.hf)
  mkdirSync(h.dataDir, { recursive: true })
  for (const f of ['laya-shadow.jsonl', 'laya-samples.jsonl', 'laya-standing.jsonl']) writeFileSync(join(h.dataDir, f), '{}\n')
  const sidecar = sidecarStub({ ready: true })
  const { installer } = installerFor(h, machine(h), { sidecar })
  await installer.remove()
  assert.deepEqual(sidecar.calls, ['stop:remove'])
  assert.ok(!existsSync(h.paths.engine) && !existsSync(h.paths.models))
  for (const f of ['laya-shadow.jsonl', 'laya-samples.jsonl', 'laya-standing.jsonl']) assert.ok(existsSync(join(h.dataDir, f)), f)
  assert.match(installer.status().job.lines.at(-1), /^Removed Laya; [\d.]+ GB freed\. The recorded comparisons and Laya samples are kept\.$/)

  const h2 = harness()
  withUv(h2)
  let hung = null
  const m = machine(h2, { answer: (c) => (c.args[0] === 'python' ? (hung = c, 'hang') : null) })
  const { installer: cancelled } = installerFor(h2, m)
  const run = cancelled.install({ device: 'gpu' })
  run.catch(() => {})
  await waitFor('Python being fetched', () => hung, (c) => c !== null, { timeoutMs: 10_000 })
  cancelled.cancel()
  await assert.rejects(run, { message: 'Install cancelled.' })
  assert.equal(hung.child.killed, true)
  assert.equal(cancelled.status().job.failedStep, 3)
})

test('the repo pins: uv by version, size and SHA-256 for Windows and for the Linux end-to-end test, torch tags newest first, and the lock they name', () => {
  assert.equal(PINS.uv.version, '0.12.18')
  assert.deepEqual([PINS.uv.size, PINS.uv.sha256], [17891221, 'cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff'])
  assert.match(PINS.uv.linux.source, /\/0\.12\.18\/uv-x86_64-unknown-linux-gnu\.tar\.gz$/)
  assert.deepEqual(PINS.torch.cuda.map((c) => c.tag), ['cu130', 'cu128', 'cu126'])
  const lock = readFileSync(join(REPO, 'config', 'laya', 'requirements.lock'), 'utf8')
  assert.match(lock, /^laya==0\.3\.20 \\$/m)
  assert.ok(!/^torch==/m.test(lock), 'torch is left out of the lock')
  assert.match(lock, /^#\s+\(uv 0\.12\.18, from PyPI/m, 'the lock says which uv made it')
  assert.ok(lock.split('\n').filter((l) => /^[a-z0-9][\w.-]*==/i.test(l)).every((l) => l.endsWith('\\')), 'every package has its hashes')
  const bad = (patch) => { const dir = mkdtempSync(join(tmpdir(), 'laya-pins-')); mkdirSync(join(dir, 'config')); writeFileSync(join(dir, 'config', 'laya.json'), JSON.stringify({ ...PINS, ...patch })); return () => readPins(dir) }
  assert.throws(bad({ uv: { ...PINS.uv, source: 'https://example.com/uv.zip' } }), /config\/laya\.json: uv\.source/)
  assert.throws(bad({ uv: { ...PINS.uv, sha256: 'abc' } }), /uv\.sha256/)
  assert.throws(bad({ torch: { ...PINS.torch, indexBase: 'https://mirror.example/whl/' } }), /torch\.indexBase/)
})

test('fetch_weights.py compiles, and the command line module loads without running', async () => {
  const py = await new Promise((r) => { const c = nodeSpawn('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', join(REPO, 'plugins', 'jev-router', 'laya', 'fetch_weights.py')], { stdio: 'ignore' }); c.on('error', () => r('no python3')); c.on('exit', (code) => r(code)) })
  assert.ok(py === 0 || py === 'no python3', `fetch_weights.py: ${py}`)
  const cli = await import('../laya/install-cli.mjs')
  assert.equal(typeof cli.main, 'function')
})

test('recover() touches nothing while another process holds install.lock, the command line installing say; once that holder has gone it recovers and gives the lock back', async () => {
  const h = harness()
  installedBefore(h)
  mkdirSync(join(h.paths.venvNew, 'Lib'), { recursive: true })
  writeFileSync(join(h.paths.venvNew, 'Lib', 'torch-being-installed'), 'x')
  let cliRunning = true
  const release = await takeInstallLock(h.paths, { pid: 4321, alive: () => true })
  const { installer } = installerFor(h, machine(h), { alive: (pid) => pid === 4321 && cliRunning })
  assert.equal(await installer.recover(), null)
  assert.ok(existsSync(join(h.paths.venvNew, 'Lib', 'torch-being-installed')), 'the other install\'s venv.new is untouched')
  assert.equal(readFileSync(h.paths.lock, 'utf8'), '4321', 'and so is its lock')
  cliRunning = false
  await installer.recover()
  assert.ok(!existsSync(h.paths.venvNew), 'left by an install that stopped: deleted')
  assert.ok(!existsSync(h.paths.lock), 'the lock given back')
  await release()
})

test('an engine killed between the second rename and its journal line is completed by recover(), not rolled back over the new venv', async () => {
  const h = harness()
  mkdirSync(h.paths.venvOld, { recursive: true })
  writeFileSync(join(h.paths.venvOld, 'old-install.txt'), 'the old install')
  mkdirSync(h.paths.venv, { recursive: true })
  writeFileSync(join(h.paths.venv, 'new-install.txt'), 'the new install')
  writeFileSync(h.paths.installed, JSON.stringify({ laya: '0.3.19', torch: '2.14.0+cpu', cuda: false }))
  writeFileSync(h.paths.swap, JSON.stringify({ step: 'renamed-old', from: 'venv', to: 'venv.new', installed: { laya: '0.3.20', torch: '2.14.0+cu128', cuda: true } }))
  const { installer } = installerFor(h, machine(h))
  assert.equal(await installer.recover(), 'An interrupted Laya install was completed; Laya 0.3.20 is installed.')
  assert.deepEqual(JSON.parse(readFileSync(h.paths.installed, 'utf8')), { laya: '0.3.20', torch: '2.14.0+cu128', cuda: true }, 'installed.json describes the venv in place')
  assert.ok(existsSync(join(h.paths.venv, 'new-install.txt')))
  for (const p of [h.paths.venvOld, h.paths.swap]) assert.ok(!existsSync(p), basename(p))
})

test('recover() never throws: what the OS will not let go of is logged, said on the card, and tried again at the next start', async () => {
  const busy = (name) => async (p, o) => { if (basename(p) === name) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: 'EBUSY' }); return fsRm(p, o) }
  // A venv.new left with no journal, a DLL in it still loaded.
  const h = harness()
  installedBefore(h)
  mkdirSync(join(h.paths.venvNew, 'Lib'), { recursive: true })
  const logs = []
  const { installer } = installerFor(h, machine(h), { remove: busy('venv.new'), log: (l) => logs.push(l) })
  let said
  await assert.doesNotReject(async () => { said = await installer.recover() })
  const leftover = 'An interrupted Laya install could not be tidied up yet (deleting venv.new: EBUSY); KzH tries again at the next start.'
  assert.equal(said, leftover)
  assert.equal(installer.status().message, leftover)
  assert.ok(logs.some((l) => l.startsWith('laya install: deleting venv.new failed (EBUSY')), logs.join('\n'))
  assert.equal(await installerFor(h, machine(h)).installer.recover(), null)
  assert.ok(!existsSync(h.paths.venvNew), 'gone at the next start')

  // Killed between the renames, and venv.old will not go back: nothing else is touched, and the
  // journal stays for the next start.
  const killedBetween = () => {
    const k = harness()
    mkdirSync(join(k.paths.venvOld, 'Scripts'), { recursive: true })
    writeFileSync(join(k.paths.venvOld, 'old-install.txt'), 'the running install')
    mkdirSync(join(k.paths.venvNew, 'Lib'), { recursive: true })
    writeFileSync(k.paths.installed, JSON.stringify({ laya: '0.3.19', torch: '2.14.0+cu128', cuda: true }))
    writeFileSync(k.paths.swap, JSON.stringify({ step: 'renamed-old', from: 'venv', to: 'venv.new', installed: { laya: '0.3.20' } }))
    return k
  }
  const k = killedBetween()
  const refuse = async () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) }
  let stuck
  await assert.doesNotReject(async () => { stuck = await installerFor(k, machine(k), { rename: refuse }).installer.recover() })
  assert.equal(stuck, 'An interrupted Laya install could not be tidied up yet (renaming venv.old back to venv: EPERM); KzH tries again at the next start.')
  assert.ok([k.paths.swap, k.paths.venvOld, k.paths.venvNew].every((p) => existsSync(p)), 'the journal kept')
  assert.equal(await installerFor(k, machine(k)).installer.recover(), 'An interrupted Laya install was rolled back; Laya 0.3.19 is still installed.')
  assert.ok(existsSync(join(k.paths.venv, 'old-install.txt')))

  // Rolled back, but venv.new will not go: the journal goes first, so the next start deletes it as
  // a leftover and never reads the swap as finished.
  const r = killedBetween()
  assert.equal(await installerFor(r, machine(r), { remove: busy('venv.new') }).installer.recover(),
    'An interrupted Laya install was rolled back; Laya 0.3.19 is still installed. Some of it could not be tidied up yet (deleting venv.new: EBUSY); KzH tries again at the next start.')
  assert.ok(!existsSync(r.paths.swap) && existsSync(r.paths.venvNew) && existsSync(join(r.paths.venv, 'old-install.txt')))
  assert.equal(await installerFor(r, machine(r)).installer.recover(), null)
  assert.ok(!existsSync(r.paths.venvNew))
  assert.equal(JSON.parse(readFileSync(r.paths.installed, 'utf8')).laya, '0.3.19', 'still the old install\'s record')
})

// The Laya card on the settings page: Settings → Jev setup → Laya decision model (docs/laya-auto.md
// 8.1 to 8.3). The page is a browser file the test runner cannot import, so this checks what it
// renders from. The words come from a marked block of pure helpers, evaluated here on their own, and
// fed Laya statuses in the shape laya-sidecar.js status() answers GET /jev-router/laya with: the
// real status() of a sidecar where one can be had without starting Laya, and that shape by hand for
// the states only a running Laya reaches. The card itself is run with a stand-in React that keeps
// state, behind stubbed routes, so its buttons, switches, dialogs and refusals are what the page
// really does.
//
// Nothing here has been seen in the running app. What these tests pin is what the card says and
// which buttons it offers in each state, and what each one sends, not how it looks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const client = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

// The pure Laya helpers, evaluated on their own, the way budgetpanel.test.js evaluates the budget
// helpers: nothing in the block may reach outside it. Read inside each test, so a client without
// them fails the test by assertion rather than the file.
function helpers() {
  const start = client.indexOf('// ---- pure laya helpers')
  const end = client.indexOf('// ---- end pure laya helpers')
  assert.ok(start > 0 && end > start, 'the Laya helper block is marked')
  return new Function(`${client.slice(start, end)}\nreturn { LAYA_INTRO, LAYA_BUTTONS, jevHostLine, layaState, layaCounters, selfTestLine, layaNotes, layaVersions, layaHelp, layaInstallDialog, layaRemoveDialog }`)()
}

const GB = 1024 ** 3
const GPU = 'NVIDIA GeForce RTX 3050 Laptop GPU'
const COMMIT = '1a2b3c4d5e6f'.padEnd(40, '0')
const IDENTITY = `laya-0.3.20|english|${COMMIT.slice(0, 12)}|adapter-1|corr:choice:11+=3.27|margin:0.1`
const NOW = Date.parse('2026-09-24T12:00:00.000Z')

/** A Laya status in the shape of 8.4, as laya-sidecar.js status() fills it: installed for the GPU, stopped. */
function status(over = {}) {
  return {
    state: 'stopped',
    why: null,
    install: null,
    installed: {
      laya: '0.3.20', torch: '2.14.0+cu128', cuda: true, gpu: GPU, python: '3.12.11',
      weights: { commit: COMMIT, bytes: 842609220, downloadedAt: '2026-09-20T09:30:00.000Z' }, diskBytes: 4.1 * GB,
    },
    expected: { laya: '0.3.20', torch: '2.14.0' },
    running: null,
    restart: null,
    lastRestart: null,
    stoppedBecause: null,
    orphanStopped: null,
    settings: { startWithKzh: false, keepLoaded: false, idleMinutes: 30, device: 'auto', shadow: true },
    shadow: { answered: 0, partial: 0, skipped: { not_running: 0, starting: 0, queue_full: 0, too_old: 0, jev_failed: 0, yielded: 0 }, failed: 0 },
    selfTest: null,
    warnings: [],
    logTail: [],
    configError: null,
    ...over,
  }
}
/** A running Laya's figures, as status() reports them, with what a task costs it here. */
const running = (over = {}) => ({
  port: 8091, pid: 1234, interpreterPid: 1240, device: 'cuda', deviceWhy: null, spilling: false, spills: 0, threads: 6,
  loadMs: 41000, startedAt: NOW - 12_400, measuring: false, lastLoadMs: 41000, gpu: GPU, ramGB: 1.9, vramGB: 2.3,
  msPerToken: { intent: 0.2, route: 0.3, review: 0.2 }, busy: false, held: [], lastCallMs: 950, localBusy: false,
  routeMs: 1400, reviewMs: 900, ...over,
})
/** The figures an install needs before anything is installed, and where Laya lives. */
const OFFER = {
  python: '3.12',
  gpu: { name: GPU, cuda: 12.8 },
  disk: { gpu: { installingGB: 8, afterGB: 4.4 }, cpu: { installingGB: 3, afterGB: 2 } },
  torch: { gpu: { size: 'about 2.5 GB', source: 'download.pytorch.org' }, cpu: { size: 'about 120 MB', source: 'PyPI' } },
}
const PATHS = { engine: 'C:\\Harness\\engine\\laya', models: 'C:\\Harness\\models\\laya' }

/** What the card says and offers for one status: its lines and its buttons, in their words. */
const seen = (h, st) => { const v = h.layaState(st, NOW); return { lines: v.lines.map((l) => l.text), buttons: v.buttons.map((b) => h.LAYA_BUTTONS[b]), log: v.log } }

test('every state has its own words and buttons, before and during an install', () => {
  const h = helpers()
  assert.equal(h.LAYA_INTRO, 'Laya is an open decision model (Apache-2.0) that runs on this PC. In Laya Auto it routes and reviews instead of Jev, and no routing or review question leaves this PC. In Jev Auto it can answer the same questions in the background, so you can compare the two.')
  // Not installed, on a PC with a usable NVIDIA GPU, and on one without.
  const bare = { installed: null, state: 'not_installed', offer: OFFER, paths: PATHS }
  assert.deepEqual(seen(h, status(bare)), {
    lines: ['Not installed. Needs about 8 GB of free disk while installing and 4.4 GB after, and the internet once.', `PyTorch with CUDA will be installed for your ${GPU}.`],
    buttons: ['Install Laya…'], log: [],
  })
  assert.deepEqual(seen(h, status({ ...bare, offer: { ...OFFER, gpu: null } })).lines, [
    'Not installed. Needs about 3 GB of free disk while installing and 2 GB after, and the internet once.',
    'No usable NVIDIA GPU found: Laya will run on the CPU. On a 4-core test machine that took about 20 s to route a task and about 10 s to review each attempt; this PC is not measured yet.',
  ])
  // A server that does not say what an install takes: the card says less, and guesses nothing.
  assert.deepEqual(seen(h, status({ ...bare, offer: undefined })).lines, ['Not installed. Installing it needs free disk and the internet once.'])

  // Installing: the step, and the bytes of a download or the minutes of a step with none. The
  // installer's notes say each CUDA tag it tried.
  const step4 = { step: 4, of: 8, name: 'Installing PyTorch 2.14.0 for the GPU (CUDA 12.8)', received: 1.2 * GB, total: 2.5 * GB, error: null, kind: 'install', failedStep: null, offerCpu: false, notes: ['PyTorch 2.14.0 has no Windows wheel for cu130; trying cu128.'] }
  assert.deepEqual(seen(h, status({ installed: null, state: 'installing', install: step4 })), {
    lines: ['Installing, step 4 of 8: Installing PyTorch 2.14.0 for the GPU (CUDA 12.8) (1.2 GB of about 2.5 GB).', 'PyTorch 2.14.0 has no Windows wheel for cu130; trying cu128.'],
    buttons: ['Cancel'], log: [],
  })
  assert.equal(seen(h, status({ installed: null, state: 'installing', install: { ...step4, step: 3, name: 'Getting Python 3.12', received: 0, total: 0, notes: [], startedAt: NOW - 3 * 60_000 } })).lines[0], 'Installing, step 3 of 8: Getting Python 3.12 (3 min).')

  // Failed: at which step and why, and the CPU is offered only when the GPU's PyTorch step failed.
  const failed4 = { ...step4, error: 'PyTorch 2.14.0 has no Windows wheel for cu130, cu128, cu126; the driver supports CUDA 12.8.', failedStep: 4, offerCpu: true, notes: [] }
  assert.deepEqual(seen(h, status({ installed: null, state: 'install_failed', install: failed4 })), {
    lines: ['Install failed at step 4 (Installing PyTorch 2.14.0 for the GPU (CUDA 12.8)): PyTorch 2.14.0 has no Windows wheel for cu130, cu128, cu126; the driver supports CUDA 12.8. The previous install, if any, is untouched.'],
    buttons: ['Try again', 'Show log', 'Install for the CPU instead'], log: [],
  })
  assert.deepEqual(seen(h, status({ installed: null, state: 'install_failed', install: { ...failed4, step: 6, failedStep: 6, name: 'Downloading the Laya model from Hugging Face', error: 'No progress for 5 minutes while Downloading the Laya model from Hugging Face.', offerCpu: false } })).buttons, ['Try again', 'Show log'])
  // A failed update keeps the Laya that was there, and says so.
  const update = { step: 5, of: 8, name: 'Installing Laya 0.3.24', error: 'uv pip install failed: no solution', kind: 'update', failedStep: 5, offerCpu: false, notes: [] }
  assert.deepEqual(seen(h, status({ state: 'install_failed', install: update })).lines, ['Update failed at step 5 (Installing Laya 0.3.24); still on Laya 0.3.20.'])
  assert.ok(seen(h, status({ state: 'ready', running: running(), install: update })).lines.includes('Update failed at step 5 (Installing Laya 0.3.24); still on Laya 0.3.20.'), 'and while the old Laya runs')
})

test('every state of an installed Laya has its own words and buttons: stopped, starting, running, restarting, failed, off', () => {
  const h = helpers()
  assert.deepEqual(seen(h, status()), {
    lines: ['Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cu128 (for the GPU, CUDA 12.8).'],
    buttons: ['Start', 'Test Laya', 'Remove…'], log: [],
  })
  const cpu = status({ installed: { ...status().installed, torch: '2.14.0+cpu', cuda: false, gpu: null } })
  assert.equal(seen(h, cpu).lines[0], 'Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cpu (for the CPU).')
  // Why it stopped: the idle time, the resource budget, or a local model it gave its memory to.
  assert.deepEqual(seen(h, status({ stoppedBecause: 'idle' })), { lines: ['Stopped after 30 min without a Laya Auto request. It starts again when Laya Auto needs it; the Jev Auto comparisons never start it.'], buttons: ['Start'], log: [] })
  assert.deepEqual(seen(h, status({ stoppedBecause: 'budget', why: 'the RAM budget of 8 GB was over for 30 s with qwen3-8b and Laya loaded.' })), { lines: ['Stopped by the resource budget: the RAM budget of 8 GB was over for 30 s with qwen3-8b and Laya loaded.'], buttons: ['Start'], log: [] })
  assert.deepEqual(seen(h, status({ stoppedBecause: 'yielded', why: 'qwen3-8b' })), { lines: ['Unloaded so qwen3-8b could have the GPU and RAM; it starts again when Laya Auto needs it.'], buttons: ['Start'], log: [] })
  // A Laya an earlier session left running, stopped at start: said above the state's own line.
  assert.deepEqual(seen(h, status({ orphanStopped: { pid: 4321, ramGB: 3.1 } })).lines, [
    'Stopped a Laya left running by an earlier session (pid 4321, 3.1 GB RAM).',
    'Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cu128 (for the GPU, CUDA 12.8).',
  ])

  // Starting: how long it has taken, how long the last start took, and the first full warm-up.
  assert.deepEqual(seen(h, status({ state: 'starting', running: running() })), { lines: ['Starting: loading the model on the GPU (12 s; the last start took 41 s)…'], buttons: ['Stop'], log: [] })
  assert.equal(seen(h, status({ state: 'starting', running: running({ device: 'cpu', startedAt: NOW - 3000, lastLoadMs: null, measuring: true }) })).lines[0], 'Starting: loading the model on the CPU (3 s), measuring Laya on this PC…')

  // Running: where, what it holds, and what a task costs it here.
  assert.deepEqual(seen(h, status({ state: 'ready', running: running() })), {
    lines: [`Running on the GPU (${GPU}): 2.3 GB VRAM, 1.9 GB RAM. Measured here: about 1.4 s to route a task and 0.9 s to review each attempt.`],
    buttons: ['Stop', 'Restart', 'Test Laya'], log: [],
  })
  assert.deepEqual(seen(h, status({ state: 'ready', settings: { ...status().settings, device: 'cpu' }, running: running({ device: 'cpu', vramGB: null, ramGB: 3.26, routeMs: 19_000, reviewMs: 8700 }) })), {
    lines: ['Running on the CPU (6 threads): 3.3 GB RAM. Measured here: about 19 s to route a task and 8.7 s to review each attempt.'],
    buttons: ['Stop', 'Restart', 'Test Laya'], log: [],
  })
  // On the CPU for a reason: the reason, and the GPU offered again, where PyTorch has CUDA.
  const fell = running({ device: 'cpu', deviceWhy: 'the GPU had 0.9 GB free and Laya needs about 2.5 GB', vramGB: null, routeMs: null, reviewMs: null, msPerToken: { intent: null, route: null, review: null } })
  assert.deepEqual(seen(h, status({ state: 'ready', running: fell })), {
    lines: ['Running on the CPU, not the GPU: the GPU had 0.9 GB free and Laya needs about 2.5 GB. Not measured on this PC yet.'],
    buttons: ['Restart on the GPU', 'Stop', 'Test Laya'], log: [],
  })
  assert.deepEqual(seen(h, status({ state: 'ready', installed: cpu.installed, running: fell })).buttons, ['Stop', 'Restart', 'Test Laya'], 'no GPU to go back to')
  // The GPU's memory spilling into system memory, which raises no error of its own.
  assert.deepEqual(seen(h, status({ state: 'ready', running: running({ spilling: true }) })), {
    lines: ["Running on the GPU, but its memory is spilling into system memory, so Laya and the local models are slow. Stop the local model, pick CPU for Laya, or set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel."],
    buttons: ['Stop', 'Restart', 'Test Laya'], log: [],
  })
  // A restart the supervisor made on its own is said until the person starts it again.
  const restarted = (lastRestart) => seen(h, status({ state: 'ready', running: running(), lastRestart: { at: NOW, ...lastRestart } })).lines.slice(1)
  assert.deepEqual(restarted({ kind: 'hung', why: 'Laya spent over 270 s on one request and was restarted.' }), ['Laya spent over 270 s on one request and was restarted.'])
  assert.deepEqual(restarted({ kind: 'exit', why: 'exit code 3221225477' }), ['Laya stopped unexpectedly (exit code 3221225477) and was restarted.'])
  assert.deepEqual(restarted({ kind: 'health', why: 'laya.serve did not answer /health 3 times in a row; restarting' }), ['Laya was restarted: laya.serve did not answer /health 3 times in a row.'])
  assert.deepEqual(restarted({ kind: 'unauthorized', why: 'another server answers on its port; restarting on a fresh port' }), ['Laya was restarted: another server answers on its port.'])

  // Restarting after a crash, and Stop, which ends the backoff (7.4).
  assert.deepEqual(seen(h, status({ state: 'restarting', why: 'exit code 3221225477', restart: { attempt: 1, of: 3, code: 3221225477, signal: null } })), {
    lines: ['Laya stopped unexpectedly (exit code 3221225477) and is restarting (attempt 1 of 3).'], buttons: ['Stop'], log: [],
  })
  // Failed: the reason, the last log lines, Start and the log.
  assert.deepEqual(seen(h, status({ state: 'failed', why: 'laya.serve exited 4 times in 10 minutes (last: exit code 1)', logTail: ['Traceback (most recent call last):', 'RuntimeError: CUDA error'] })), {
    lines: ['Stopped after an error: laya.serve exited 4 times in 10 minutes (last: exit code 1). Laya Auto refuses messages until you press Start.'],
    buttons: ['Start', 'Show log'], log: ['Traceback (most recent call last):', 'RuntimeError: CUDA error'],
  })
  // Switched off, and a settings error, which outranks every state.
  assert.deepEqual(seen(h, status({ state: 'disabled' })), { lines: ['Switched off in the configuration (jev-router laya.enabled is false).'], buttons: [], log: [] })
  assert.deepEqual(seen(h, status({ state: 'disabled', configError: 'providers: laya.thresholds.accept: low 0.9 is above medium 0.8' })), {
    lines: ['Laya settings error: providers: laya.thresholds.accept: low 0.9 is above medium 0.8. Fix jev-router laya in cordis.patch.yml; Laya Auto is off until then.'], buttons: [], log: [],
  })
})

/** A Laya sidecar over `harnessDir`, as index.js makes one, with nothing that can start a real Laya. */
async function layaSidecar(harnessDir, over = {}) {
  const { createLayaSidecar } = await import('../laya-sidecar.js')
  const { readPins } = await import('../laya-install.js')
  return createLayaSidecar({ harnessDir, dataDir: join(harnessDir, 'data'), pins: readPins(REPO), config: {}, specs: async () => null, run: async () => null, log: () => {}, onChange: () => {}, ...over })
}

/**
 * Laya installed on a PC of its own, as laya-install.js leaves it: the venv's interpreter,
 * installed.json and the model recorded after a load; for the GPU unless `cuda` is false.
 */
async function installedLaya({ cuda = true } = {}) {
  const { layaPaths, readPins, recordWeights, snapshotDir } = await import('../laya-install.js')
  const pins = readPins(REPO)
  const harnessDir = mkdtempSync(join(tmpdir(), 'laya-card-'))
  const paths = layaPaths({ harnessDir, dataDir: join(harnessDir, 'data') })
  mkdirSync(dirname(paths.pythonOf(paths.venv)), { recursive: true })
  writeFileSync(paths.pythonOf(paths.venv), '')
  writeFileSync(paths.installed, JSON.stringify({ laya: pins.laya, torch: `${pins.torch.version}+${cuda ? 'cu128' : 'cpu'}`, torchIndex: cuda ? 'cu128' : 'pypi', cuda, gpu: cuda ? GPU : null, python: '3.12.11', uv: '0.12.18' }))
  const snap = snapshotDir(paths.hf, pins.weights.repo, COMMIT)
  mkdirSync(join(snap, 'tokenizer'), { recursive: true })
  writeFileSync(join(snap, 'model.safetensors'), 'weights')
  await recordWeights(paths, { repo: pins.weights.repo, commit: COMMIT, downloadedAt: '2026-09-20T09:30:00.000Z', loadedAt: '2026-09-20T09:31:00.000Z' })
  return harnessDir
}

test('the words come from the real status() of a Laya sidecar, by the names status() uses', async () => {
  const h = helpers()
  const { readPins } = await import('../laya-install.js')
  const pins = readPins(REPO)
  const sidecar = async (harnessDir, over = {}) => {
    const s = await layaSidecar(harnessDir, over)
    const st = s.status()
    await s.dispose()
    return st
  }
  // Nothing installed.
  const bare = mkdtempSync(join(tmpdir(), 'laya-card-'))
  const none = await sidecar(bare)
  assert.equal(none.state, 'not_installed')
  assert.deepEqual(seen(h, none).buttons, ['Install Laya…'])
  // Installed for the GPU.
  const harnessDir = await installedLaya()
  const stopped = await sidecar(harnessDir)
  assert.deepEqual(seen(h, stopped), {
    lines: [`Installed, not running. Laya ${pins.laya}, English checkpoint 1a2b3c4, PyTorch ${pins.torch.version}+cu128 (for the GPU, CUDA 12.8).`],
    buttons: ['Start', 'Test Laya', 'Remove…'], log: [],
  })
  assert.deepEqual(h.layaVersions(stopped).map((v) => v.text), [`Laya ${pins.laya}, pinned by this KzH version. Model 1a2b3c4, downloaded 2026-09-20.`])
  // Switched off, and a settings error.
  assert.deepEqual(seen(h, await sidecar(harnessDir, { config: { enabled: false } })).lines, ['Switched off in the configuration (jev-router laya.enabled is false).'])
  const bad = await sidecar(harnessDir, { configError: 'providers: laya.minTopMargin: 1.5 is above 1' })
  assert.deepEqual(seen(h, bad).lines, ['Laya settings error: providers: laya.minTopMargin: 1.5 is above 1. Fix jev-router laya in cordis.patch.yml; Laya Auto is off until then.'])
  assert.deepEqual(h.layaVersions(bad), [], 'and nothing else of Laya is offered')
})

test('a start the RAM budget or a GPU with no room turned down says so on the card, with its numbers, from the real status()', async () => {
  const h = helpers()
  const { readPins } = await import('../laya-install.js')
  const pins = readPins(REPO)
  const installedLine = (torch, where) => `Installed, not running. Laya ${pins.laya}, English checkpoint 1a2b3c4, PyTorch ${pins.torch.version}+${torch} (${where}).`
  // Over the RAM budget: stopped, with the reason and no stoppedBecause (7.7), and nothing started.
  const onCpu = await layaSidecar(await installedLaya({ cuda: false }), { readBudget: async () => ({ maxRamGB: 1 }) })
  await assert.rejects(onCpu.start(), { message: 'Laya needs about 3.3 GB of RAM; the RAM budget is 1 GB. Raise the RAM budget.' })
  const ram = onCpu.status()
  assert.deepEqual([ram.state, ram.stoppedBecause, ram.running], ['stopped', null, null])
  assert.deepEqual(seen(h, ram), {
    lines: ['Not started: Laya needs about 3.3 GB of RAM; the RAM budget is 1 GB. Raise the RAM budget.', installedLine('cpu', 'for the CPU')],
    buttons: ['Start', 'Test Laya', 'Remove…'], log: [],
  })
  assert.equal(h.layaState(ram, NOW).lines[0].tone, 'warn')
  await onCpu.dispose()
  // Device GPU on a GPU with no room: the same, with the GPU's numbers.
  const onGpu = await layaSidecar(await installedLaya(), { run: async (cmd) => (cmd === 'nvidia-smi' ? `900, 3196, 4096, ${GPU}\n` : null) })
  await onGpu.setSettings({ device: 'gpu' })
  await assert.rejects(onGpu.start())
  assert.deepEqual(seen(h, onGpu.status()).lines, [
    'Not started: Laya is set to run on the GPU, and the GPU had 0.9 GB free and Laya needs about 2.5 GB.',
    installedLine('cu128', 'for the GPU, CUDA 12.8'),
  ])
  await onGpu.dispose()
  // Stopped by the person, nothing was refused, and nothing more is said.
  assert.deepEqual(seen(h, status()).lines, ['Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cu128 (for the GPU, CUDA 12.8).'])
})

test('a start that has not launched Laya yet says it is getting ready, and names no device, from the real status()', async () => {
  const h = helpers()
  const sidecar = await layaSidecar(await installedLaya())
  // An update swapping the venv in holds the start before anything is loaded (7.4).
  sidecar.suspend()
  const starting = sidecar.start({ device: 'gpu' })
  starting.catch(() => {})
  const st = sidecar.status()
  assert.deepEqual([st.state, st.running], ['starting', null])
  assert.deepEqual(seen(h, st), { lines: ['Starting: getting ready…'], buttons: ['Stop'], log: [] })
  await sidecar.stop()
  sidecar.resume()
  await assert.rejects(starting)
  await sidecar.dispose()
  // Once launched, the device it loads on is named, as before.
  assert.equal(seen(h, status({ state: 'starting', running: running() })).lines[0], 'Starting: loading the model on the GPU (12 s; the last start took 41 s)…')
})

test('a Laya its warm-up measured is never called unmeasured when the server gives no time for a task', () => {
  const h = helpers()
  // status() carries the per-phase figures of the warm-up (msPerToken), not what a task costs.
  const measured = running({ routeMs: undefined, reviewMs: undefined })
  assert.deepEqual(seen(h, status({ state: 'ready', running: measured })).lines, [`Running on the GPU (${GPU}): 2.3 GB VRAM, 1.9 GB RAM.`])
  assert.deepEqual(seen(h, status({ state: 'ready', running: { ...measured, device: 'cpu', vramGB: null } })).lines, ['Running on the CPU (6 threads): 1.9 GB RAM.'])
  assert.deepEqual(seen(h, status({ state: 'ready', running: { ...measured, device: 'cpu', deviceWhy: 'the GPU had 0.9 GB free and Laya needs about 2.5 GB' } })).lines, ['Running on the CPU, not the GPU: the GPU had 0.9 GB free and Laya needs about 2.5 GB.'])
  // With no figure for the device it runs on, it is not measured yet.
  const fresh = { ...measured, msPerToken: { intent: null, route: null, review: null } }
  assert.deepEqual(seen(h, status({ state: 'ready', running: fresh })).lines, [`Running on the GPU (${GPU}): 2.3 GB VRAM, 1.9 GB RAM. Not measured on this PC yet.`])
})

test('a Laya left running by an earlier session whose memory the sweep could not read is named by its pid alone', () => {
  const h = helpers()
  assert.deepEqual(seen(h, status({ orphanStopped: { pid: 4321, ramGB: null } })).lines, [
    'Stopped a Laya left running by an earlier session (pid 4321).',
    'Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cu128 (for the GPU, CUDA 12.8).',
  ])
})

test('the counters, the last Test Laya with its seven pairs and the kind pair, the warnings and the lines around the switches', async () => {
  const h = helpers()
  // The counters come from the comparison of the last 7 days (8.4).
  const compare = {
    questions: [
      { name: 'taskType', agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } } },
      { name: 'risk', agree: { all: { n: 41, agree: 30 }, informative: { n: 20, agree: 15 } } },
    ],
    skips: { answered: 120, partial: 2, failed: 1, skipped: { not_running: 3, starting: 1, queue_full: 0, too_old: 4, jev_failed: 1, yielded: 2 }, atContextLimit: 0 },
  }
  assert.equal(h.layaCounters(compare), 'Last 7 days: Laya answered 122 of 134 Jev calls in the background (11 skipped: 3 not running, 1 starting, 0 queue full, 4 waited too long, 2 gave way to a local model, 1 Jev call failed). Agreement 63%.')
  assert.equal(h.layaCounters({ ...compare, questions: [] }).endsWith('No answers compared yet.'), true)
  assert.equal(h.layaCounters(null), null, 'nothing until the comparison has been read')

  // Test Laya: the card's line is laya-selfcheck.js's, word for word, for every kind of result.
  const { selfTestLine } = await import('../laya-selfcheck.js')
  const pairs = (miss = {}) => ['alsoWork', 'needsPerson', 'unrelatedChanges', 'addressed', 'complete', 'continueHandoff', 'humanReview'].map((name) => {
    const [yes, no] = miss[name] ?? [0.9, 0.1]
    return { name, yes, no, separates: yes - no >= 0.2, noOnYes: yes < 0.5, yesOnNo: no > 0.5 }
  })
  const base = { at: '2026-09-24T12:00:00.000Z', identity: IDENTITY, device: 'cuda', protocol: { ok: true, problems: [] }, timings: { intent: 310, route: 950, review: 620 }, kind: { task: 0.91, question: 0.12, separates: true }, error: null }
  const results = {
    all: { ...base, pairs: pairs() },
    some: { ...base, pairs: pairs({ needsPerson: [0.3, 0.25], complete: [0.45, 0.4], humanReview: [0.62, 0.58] }), kind: { task: 0.5, question: 0.49, separates: false } },
    none: { ...base, device: 'cpu', pairs: pairs(Object.fromEntries(['alsoWork', 'needsPerson', 'unrelatedChanges', 'addressed', 'complete', 'continueHandoff', 'humanReview'].map((n) => [n, [0.5, 0.49]]))) },
    failed: { ...base, protocol: { ok: false, problems: ['route: timed out after 16 s'] }, timings: null, pairs: [], kind: null, error: 'route: timed out after 16 s' },
  }
  for (const [name, r] of Object.entries(results)) assert.equal(h.selfTestLine(r), selfTestLine(r), name)
  assert.equal(h.selfTestLine(results.all), 'Test Laya (model 1a2b3c4): protocol ok. On the GPU: intent 310 ms, routing 950 ms, review 620 ms. 7 of 7 yes/no questions separate. Task or question: separates.')
  assert.equal(h.selfTestLine(results.some), 'Test Laya (model 1a2b3c4): protocol ok. On the GPU: intent 310 ms, routing 950 ms, review 620 ms. 4 of 7 yes/no questions separate; needsPerson, complete and humanReview do not (2 answered no to the clear yes, the pattern of Laya issue #156; 1 answered yes to the clear no). Task or question: does not separate.')
  assert.match(h.selfTestLine(results.none), /On the CPU: .* 0 of 7 yes\/no questions separate; alsoWork, needsPerson, unrelatedChanges, addressed, complete, continueHandoff and humanReview do not\. Task or question: separates\.$/)
  assert.equal(h.selfTestLine(results.failed), 'Test Laya (model 1a2b3c4): protocol failed (route: timed out after 16 s).')

  // The lines under the switches: after an install, the switches to test both; while the
  // comparisons are on and Laya is not running, that nothing is compared; then the counters, the
  // last Test Laya and Laya's own warnings, as the sidecar parsed them from Laya's log.
  const { LAYA_TEXT } = await import('../laya-sidecar.js')
  const done = { step: 8, of: 8, name: 'Cleaning up', error: null, kind: 'install', failedStep: null, offerCpu: false, notes: [] }
  const st = status({ install: done, selfTest: results.some, warnings: [{ kind: 'temperatures', entries: ['choice:11+=0.1006 -> 0.5'], text: LAYA_TEXT.temperatures }] })
  assert.deepEqual(h.layaNotes(st, compare).map((n) => n.text), [
    'To test Jev and Laya together, turn on Start Laya when KzH starts and Keep Laya loaded.',
    'Laya is not running, so Jev Auto records no comparisons now. Press Start, or turn on Start Laya when KzH starts and Keep Laya loaded.',
    h.layaCounters(compare),
    h.selfTestLine(results.some),
    'Laya reports uncalibrated confidence for questions with 11 or more options (always taskType and skill; capability, strategy and the agent picks when that many are offered); KzH re-tempers them and marks each such answer uncalibrated.',
  ])
  // Both switches on: nothing more to suggest; running: nothing is missed; comparisons off: nothing to say about them.
  const on = status({ install: done, state: 'ready', running: running(), settings: { ...status().settings, startWithKzh: true, keepLoaded: true } })
  assert.deepEqual(h.layaNotes(on, null), [])
  assert.deepEqual(h.layaNotes(status({ settings: { ...status().settings, shadow: false } }), null), [])
})

test('the versions, the model buttons and an update this KzH version pins', () => {
  const h = helpers()
  const words = (v) => v.map((x) => [x.text, x.buttons.map((b) => h.LAYA_BUTTONS[b])])
  assert.deepEqual(words(h.layaVersions(status())), [['Laya 0.3.20, pinned by this KzH version. Model 1a2b3c4, downloaded 2026-09-20.', ['Check for a newer model', 'Repair']]])
  // A newer model found by the check can be used from here.
  assert.deepEqual(words(h.layaVersions(status({ weights: { current: COMMIT, latest: 'fedcba9'.padEnd(40, '1'), changed: true } }))), [
    ['Laya 0.3.20, pinned by this KzH version. Model 1a2b3c4, downloaded 2026-09-20.', ['Check for a newer model', 'Use the newer model', 'Repair']],
    ['A newer Laya model is available (fedcba9; this PC has 1a2b3c4).', []],
  ])
  assert.deepEqual(words(h.layaVersions(status({ weights: { current: COMMIT, latest: COMMIT, changed: false } })))[1], ['This PC has the newest Laya model.', []])
  // This KzH version pins another Laya: Update Laya.
  assert.deepEqual(words(h.layaVersions(status({ expected: { laya: '0.3.24', torch: '2.14.0' } }))), [
    ['Laya 0.3.20. Model 1a2b3c4, downloaded 2026-09-20.', ['Check for a newer model', 'Repair']],
    ['This KzH version pins Laya 0.3.24; 0.3.20 is installed.', ['Update Laya']],
  ])
  assert.deepEqual(h.layaVersions(status({ installed: null, state: 'not_installed' })), [])
})

test('the switches say what they do and what Laya then holds, and the dialogs say what installing and removing do', () => {
  const h = helpers()
  const need = { device: 'cuda', cpu: { ramGB: 3.3 }, cuda: { ramGB: 1.5, vramGB: 2.5 } }
  const help = h.layaHelp(status({ need }))
  assert.equal(help.device, "While Laya is loaded on the GPU and kept loaded, the VRAM budget holds Laya and the chat model together. On a 4 GB GPU, pick CPU here if the chat model needs the whole GPU. If Laya gets slow on the GPU, set Prefer No Sysmem Fallback for Laya's python.exe in the NVIDIA Control Panel.")
  assert.equal(help.startWithKzh, 'Laya then has its model loaded before your first message. Unless Keep Laya loaded is on, it still unloads after the idle time, and whenever a local model needs its memory.')
  assert.equal(help.keepLoaded, "Laya stays loaded and keeps its memory even when a local model starts: about 2.5 GB of GPU memory, so local models get fewer GPU layers, or about 3.3 GB of RAM, which the RAM budget counts before a local model's context is sized.")
  assert.equal(help.shadow, "Laya answers every Jev question too, on this PC, and both answers are recorded side by side. It never delays a Jev Auto run and never starts or keeps Laya loaded: when Laya is busy, starting or not running, or a local model is answering or needs Laya's memory, the comparison waits or is skipped and counted. Only Keep Laya loaded makes Laya hold memory beside a local model. Nothing is sent anywhere.")
  // Running, the figure it holds now wins over the estimate for its next start.
  assert.match(h.layaHelp(status({ need, state: 'ready', running: running() })).keepLoaded, /about 2\.3 GB of GPU memory/)
  // Installed for the CPU only: only RAM; with no figure at all: no number is made up.
  assert.equal(h.layaHelp(status({ need, installed: { ...status().installed, cuda: false } })).keepLoaded, "Laya stays loaded and keeps its memory even when a local model starts: about 3.3 GB of RAM, which the RAM budget counts before a local model's context is sized.")
  assert.doesNotMatch(h.layaHelp(status()).keepLoaded, /\d/)

  const bare = status({ installed: null, state: 'not_installed', offer: OFFER, paths: PATHS })
  assert.deepEqual(h.layaInstallDialog(bare, 'gpu'), {
    title: 'Install Laya',
    lines: [
      'Where: C:\\Harness\\engine\\laya (Python and PyTorch) and C:\\Harness\\models\\laya (the model).',
      "Downloads once, then works offline: Python 3.12 (about 30 MB, GitHub), PyTorch 2.14.0 (about 2.5 GB, download.pytorch.org), Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).",
      'Needs about 8 GB of free disk while installing and 4.4 GB after.',
    ],
    choices: [
      { value: 'gpu', label: `GPU: ${GPU} with CUDA 12.8 (speed not measured on this PC yet; Test Laya measures it after the install)` },
      { value: 'cpu', label: 'CPU only (smaller download; on a 4-core test machine, about 20 s to route a task and about 10 s to review each attempt)' },
    ],
  })
  assert.deepEqual(h.layaInstallDialog(bare, 'cpu').lines.slice(1), [
    "Downloads once, then works offline: Python 3.12 (about 30 MB, GitHub), PyTorch 2.14.0 (about 120 MB, PyPI), Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).",
    'Needs about 3 GB of free disk while installing and 2 GB after.',
  ])
  assert.deepEqual(h.layaInstallDialog({ ...bare, offer: { ...OFFER, gpu: null } }, 'cpu').choices.map((c) => c.value), ['cpu'], 'no GPU choice without a usable GPU')
  // A server that does not say what the PC has: both, and the installer falls back to the CPU itself.
  const unknown = h.layaInstallDialog({ ...bare, offer: undefined, paths: undefined }, 'gpu')
  assert.deepEqual(unknown.choices.map((c) => c.label), [
    'GPU (speed not measured on this PC yet; Test Laya measures it after the install)',
    'CPU only (smaller download; on a 4-core test machine, about 20 s to route a task and about 10 s to review each attempt)',
  ])
  assert.deepEqual(unknown.lines, ["Downloads once, then works offline: Python (about 30 MB, GitHub), PyTorch 2.14.0, Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face)."])
  assert.deepEqual(h.layaRemoveDialog(status({ paths: PATHS, installed: { ...status().installed, bytes: { engine: 3.2 * GB, models: 0.8 * GB } } })), {
    title: 'Remove Laya?',
    body: 'Stops Laya and deletes C:\\Harness\\engine\\laya (3.2 GB) and C:\\Harness\\models\\laya (819 MB). Your recorded comparisons and Laya samples are kept. Laya Auto leaves the model menu.',
    confirmLabel: 'Remove Laya',
  })
})

// ---------- the card, as the page runs it, behind stubbed routes ----------

const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const nodes = (n) => (n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [])
const textOf = (n) => (n == null || n === false ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

/** client.js run as the page runs it, with the browser globals a test hands it. */
function loadPlugin(React, globals = {}) {
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } }, addEventListener() {}, removeEventListener() {} }
  const names = Object.keys(globals)
  new Function('window', ...names, client)(window, ...names.map((k) => globals[k]))
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

/**
 * A stand-in React that keeps state across renders for the one component mounted, as
 * budgetpanel.test.js has it; the components it renders are called in place.
 */
function statefulReact() {
  let current = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const slot = () => { const v = current; return [v, v.i++] }
  const React = {
    createElement,
    Fragment: 'fragment',
    useState: (init) => {
      const [v, k] = slot()
      if (!(k in v.slots)) v.slots[k] = typeof init === 'function' ? init() : init
      return [v.slots[k], (x) => { const next = typeof x === 'function' ? x(v.slots[k]) : x; if (!Object.is(next, v.slots[k])) { v.slots[k] = next; v.schedule() } }]
    },
    useEffect: (fn, deps) => {
      const [v, k] = slot()
      const prev = v.slots[k]
      if (prev && same(prev.deps, deps)) return
      v.slots[k] = { deps, cleanup: null }
      v.effects.push(() => { prev?.cleanup?.(); v.slots[k].cleanup = fn() ?? null })
    },
    useCallback: (f, deps) => {
      const [v, k] = slot()
      if (v.slots[k] && same(v.slots[k].deps, deps)) return v.slots[k].f
      v.slots[k] = { f, deps }
      return f
    },
    useRef: (init) => { const [v, k] = slot(); if (!(k in v.slots)) v.slots[k] = { current: init }; return v.slots[k] },
  }
  const expand = (n) => (!n || typeof n !== 'object' ? n : typeof n.type === 'function' ? expand(n.type({ ...n.props, children: n.children })) : { ...n, children: n.children.map(expand) })
  // `shallow` leaves the components in the tree as they are, to be found by their type.
  const mount = (Component, props, { shallow = false } = {}) => {
    const view = { slots: [], i: 0, effects: [], queued: false, tree: null }
    view.render = () => {
      view.queued = false; view.i = 0; view.effects = []
      current = view
      const out = Component(props)
      current = null
      view.tree = shallow ? out : expand(out)
      for (const run of view.effects) run()
    }
    view.schedule = () => { if (!view.queued) { view.queued = true; queueMicrotask(view.render) } }
    view.unmount = () => { for (const x of view.slots) x?.cleanup?.() }
    view.render()
    return view
  }
  return { React, mount }
}

/**
 * The Laya card behind the routes of 8.4: GET /jev-router/laya answers `page.status`, the comparison
 * and the log answer what they are given, and every POST is recorded and answered by `replies`
 * (by path: a status code and a body, or a function run before answering). The polls never run by
 * themselves: `page.polls()` says how often each one the card has set would run, and
 * `page.poll(ms)` runs those set for every `ms` once.
 */
async function card(st, { compare = null, replies = {}, logLines = [] } = {}) {
  const page = { status: st, posts: [], gets: [], asked: [] }
  const intervals = new Map()
  let ids = 0
  let busy = 0
  const fetch = async (path, init = {}) => {
    busy++
    try {
      const method = init.method ?? 'GET'
      let code = 200
      let body = { error: 'not found' }
      if (method === 'GET') {
        page.gets.push(path)
        if (path === '/jev-router/laya') body = page.status
        else if (path === '/jev-router/laya/compare?days=7&identity=current') { body = compare ?? { error: 'not set up' }; code = compare ? 200 : 404 }
        else if (path === '/jev-router/laya/log?lines=200') body = { lines: logLines }
        else code = 404
      } else {
        const sent = JSON.parse(init.body)
        page.posts.push([path, sent])
        const r = replies[path]
        if (typeof r === 'function') body = await r(sent) ?? { ok: true }
        else if (r) { code = r.code ?? 200; body = r.body ?? { ok: true } }
        else body = { ok: true }
      }
      const text = JSON.stringify(body)
      return { ok: code === 200, status: code, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const setInterval = (f, ms) => { intervals.set(++ids, { f, ms }); return ids }
  const clearInterval = (id) => { intervals.delete(id) }
  const { LayaCard } = loadPlugin(React, { fetch, document: { hidden: false }, setInterval, clearInterval }).__test
  assert.equal(typeof LayaCard, 'function', 'client.js has the Laya card')
  const view = mount(LayaCard, { ask: (c) => page.asked.push(c) })
  page.settle = async () => {
    for (let quiet = 0, until = Date.now() + 10_000; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) {
      if (Date.now() > until) throw new Error('the card never settled')
      await new Promise((r) => setImmediate(r))
    }
  }
  await page.settle()
  page.all = () => nodes(view.tree)
  page.text = () => textOf(view.tree)
  page.buttons = () => page.all().filter((n) => n.type === 'button').map(textOf)
  page.press = async (label) => {
    const b = page.all().find((n) => n.type === 'button' && textOf(n) === label)
    assert.ok(b, `a ${label} button (have: ${page.buttons().join(', ')})`)
    await b.props.onClick()
    await page.settle()
  }
  page.alerts = () => page.all().filter((n) => n.props.role === 'alert').map(textOf)
  page.polls = () => [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b)
  page.poll = async (ms) => { for (const t of [...intervals.values()]) if (t.ms === ms) t.f(); await page.settle() }
  page.input = (id) => page.all().find((n) => (n.type === 'input' || n.type === 'select') && n.props.id === id)
  page.close = () => view.unmount()
  return page
}

test('the card shows the state, its buttons and the lines under them, and each button posts to its route', async () => {
  const page = await card(status({ state: 'ready', running: running(), selfTest: null }), { compare: { questions: [], skips: { answered: 3, partial: 0, failed: 0, skipped: { not_running: 1, starting: 0, queue_full: 0, too_old: 0, jev_failed: 0, yielded: 0 } } } })
  const all = page.all()
  const heading = all.find((n) => n.props.id === 'jevi-laya-h')
  assert.equal(textOf(heading), 'Laya decision model')
  assert.equal(all.find((n) => n.type === 'section').props['aria-labelledby'], 'jevi-laya-h', 'the card is named by its heading')
  const text = page.text()
  assert.ok(text.includes(helpers().LAYA_INTRO))
  assert.ok(text.includes(`Running on the GPU (${GPU}): 2.3 GB VRAM, 1.9 GB RAM. Measured here: about 1.4 s to route a task and 0.9 s to review each attempt.`))
  assert.ok(text.includes('Last 7 days: Laya answered 3 of 4 Jev calls in the background (1 skipped: 1 not running, 0 starting, 0 queue full, 0 waited too long, 0 gave way to a local model, 0 Jev call failed). No answers compared yet.'), 'the counters, from the comparison')
  assert.ok(text.includes('While Laya is held (Keep Laya loaded, or a Laya Auto run), the VRAM budget holds Laya and the chat model together, and on a 4 GB GPU local models get about 2.3 GB less. Otherwise Laya gives the GPU up when a local model starts.'), 'what a held Laya costs on the GPU')
  assert.deepEqual(page.buttons(), ['Stop', 'Restart', 'Test Laya', 'Check for a newer model', 'Repair'])
  for (const [label, route, body] of [['Restart', '/jev-router/laya/restart', {}], ['Test Laya', '/jev-router/laya/selftest', {}], ['Check for a newer model', '/jev-router/laya/weights/check', {}], ['Repair', '/jev-router/laya/repair', {}]]) {
    await page.press(label)
    assert.deepEqual(page.posts.at(-1), [route, body], label)
  }
  // Stop while a Laya Auto run is open: the server refuses, and the card says so in its words.
  page.status = status({ state: 'ready', running: running({ held: ['run:5f0c'] }) })
  const refused = await card(page.status, { replies: { '/jev-router/laya/stop': { code: 409, body: { error: 'Laya is deciding for an open Laya Auto run; stop that run first.' } } } })
  await refused.press('Stop')
  assert.deepEqual(refused.posts, [['/jev-router/laya/stop', {}]])
  assert.deepEqual(refused.alerts(), ['Laya is deciding for an open Laya Auto run; stop that run first.'])
  page.close(); refused.close()

  // On the CPU for a reason: Restart on the GPU asks for the GPU.
  const fell = await card(status({ state: 'ready', running: running({ device: 'cpu', deviceWhy: 'the GPU had 0.9 GB free and Laya needs about 2.5 GB' }) }))
  await fell.press('Restart on the GPU')
  assert.deepEqual(fell.posts, [['/jev-router/laya/restart', { device: 'gpu' }]])
  fell.close()

  // Failed: the last log lines are shown, and Show log reads the rest.
  const failed = await card(status({ state: 'failed', why: 'laya.serve exited 4 times in 10 minutes (last: exit code 1)', logTail: ['RuntimeError: CUDA error: unspecified launch failure'] }), { logLines: ['INFO: started', 'RuntimeError: CUDA error: unspecified launch failure'] })
  assert.ok(failed.text().includes('RuntimeError: CUDA error: unspecified launch failure'))
  assert.ok(failed.text().includes('Laya is not running, so Jev Auto records no comparisons now.'))
  await failed.press('Show log')
  assert.ok(failed.gets.includes('/jev-router/laya/log?lines=200'))
  assert.ok(failed.text().includes('INFO: started\nRuntimeError'), 'the log, as the server gave it')
  await failed.press('Start')
  assert.deepEqual(failed.posts, [['/jev-router/laya/start', {}]])
  failed.close()

  // Install failed at the GPU's PyTorch step: try again, or install for the CPU instead.
  const install = { step: 4, of: 8, name: 'Installing PyTorch 2.14.0 for the GPU (CUDA 12.8)', received: 0, total: 0, error: 'no wheel', kind: 'install', failedStep: 4, offerCpu: true, notes: [], device: 'gpu' }
  const broke = await card(status({ installed: null, state: 'install_failed', install, offer: OFFER }))
  assert.deepEqual(broke.buttons(), ['Try again', 'Show log', 'Install for the CPU instead'])
  await broke.press('Try again')
  await broke.press('Install for the CPU instead')
  assert.deepEqual(broke.posts, [['/jev-router/laya/install', { device: 'gpu' }], ['/jev-router/laya/install', { device: 'cpu' }]])
  broke.close()

  // Installing: Cancel.
  const busy = await card(status({ installed: null, state: 'installing', install: { ...install, error: null, failedStep: null, received: GB, total: 2.5 * GB } }))
  assert.deepEqual(busy.buttons(), ['Cancel'])
  await busy.press('Cancel')
  assert.deepEqual(busy.posts, [['/jev-router/laya/install/cancel', {}]])
  busy.close()
})

test('installing from the card: the dialog says what it takes, offers the GPU or the CPU, and installs for the one picked', async () => {
  const page = await card(status({ installed: null, state: 'not_installed', offer: OFFER, paths: PATHS }))
  assert.deepEqual(page.buttons(), ['Install Laya…'])
  assert.ok(!page.all().some((n) => n.type === 'dl'), 'no switches before there is a Laya to switch')
  await page.press('Install Laya…')
  const dialog = page.all().find((n) => n.props.role === 'dialog')
  assert.ok(dialog, 'the install dialog')
  assert.equal(textOf(page.all().find((n) => n.props.id === dialog.props['aria-labelledby'])), 'Install Laya')
  assert.ok(textOf(dialog).includes('Where: C:\\Harness\\engine\\laya (Python and PyTorch) and C:\\Harness\\models\\laya (the model).'))
  const radios = nodes(dialog).filter((n) => n.type === 'input' && n.props.type === 'radio')
  assert.deepEqual(radios.map((r) => [r.props.value, r.props.checked]), [['gpu', true], ['cpu', false]], 'the GPU first, where there is one')
  radios[1].props.onChange()
  await page.settle()
  assert.ok(textOf(page.all().find((n) => n.props.role === 'dialog')).includes('PyTorch 2.14.0 (about 120 MB, PyPI)'), 'the dialog follows the choice')
  await page.press('Install')
  assert.deepEqual(page.posts, [['/jev-router/laya/install', { device: 'cpu' }]])
  assert.ok(!page.all().some((n) => n.props.role === 'dialog'), 'and closes')
  // Cancel closes it and sends nothing.
  await page.press('Install Laya…')
  await page.press('Cancel')
  assert.equal(page.posts.length, 1)
  assert.ok(!page.all().some((n) => n.props.role === 'dialog'))
  page.close()
})

test('removing from the card asks first, in the dialog\'s words, and removes only when confirmed', async () => {
  const page = await card(status({ paths: PATHS, installed: { ...status().installed, bytes: { engine: 3.2 * GB, models: 0.8 * GB } } }))
  await page.press('Remove…')
  assert.deepEqual(page.posts, [], 'nothing is removed before the person confirms')
  const [asked] = page.asked
  assert.deepEqual({ title: asked.title, body: asked.body, confirmLabel: asked.confirmLabel }, helpers().layaRemoveDialog(page.status))
  await asked.run()
  assert.deepEqual(page.posts, [['/jev-router/laya/remove', {}]])
  page.close()
})

test('the switches save what they say, the idle time only while Laya is not kept loaded, and a refused value is shown', async () => {
  const page = await card(status({ need: { device: 'cuda', cpu: { ramGB: 3.3 }, cuda: { ramGB: 1.5, vramGB: 2.5 } } }), {
    replies: { '/jev-router/laya/settings': (sent) => { page.status = status({ settings: { ...page.status.settings, ...sent } }) } },
  })
  const device = page.input('jevi-laya-device')
  assert.deepEqual(device.children.map((o) => [o.props.value, textOf(o)]), [['auto', 'Auto (the GPU when it has room)'], ['gpu', 'GPU'], ['cpu', 'CPU']])
  assert.equal(device.props.value, 'auto')
  const labels = page.all().filter((n) => n.type === 'input' && n.props.role === 'switch').map((n) => n.props['aria-label'])
  assert.deepEqual(labels, ['Start Laya when KzH starts', 'Keep Laya loaded', 'Answer beside Jev in Jev Auto'])
  assert.equal(page.input('jevi-laya-idle').props.value, '30')
  assert.equal(page.input('jevi-laya-idle').props.disabled, false)
  device.props.onChange({ target: { value: 'cpu' } })
  await page.settle()
  page.input('jevi-laya-keep').props.onChange({ target: { checked: true } })
  await page.settle()
  assert.deepEqual(page.posts, [['/jev-router/laya/settings', { device: 'cpu' }], ['/jev-router/laya/settings', { keepLoaded: true }]])
  assert.equal(page.input('jevi-laya-keep').props.checked, true, 'the saved value, reloaded')
  assert.equal(page.input('jevi-laya-idle').props.disabled, true, 'the idle time means nothing while Laya is kept loaded')
  page.close()

  // A value the server refuses is shown as it words it; the idle time saves when it loses focus.
  const strict = await card(status(), { replies: { '/jev-router/laya/settings': { code: 400, body: { error: 'idleMinutes: 1 to 240' } } } })
  const idle = strict.input('jevi-laya-idle')
  idle.props.onChange({ target: { value: '500' } })
  await strict.settle()
  strict.input('jevi-laya-idle').props.onBlur()
  await strict.settle()
  assert.deepEqual(strict.posts, [['/jev-router/laya/settings', { idleMinutes: 500 }]])
  assert.deepEqual(strict.alerts(), ['idleMinutes: 1 to 240'])
  strict.close()
})

test('Try again after a failed install asks for the device again when the status does not say which the install was for, and never guesses the GPU', async () => {
  // The real status() of a failed first install the person started for the CPU: the job knew its
  // device, and the status carries none.
  const sidecar = await layaSidecar(mkdtempSync(join(tmpdir(), 'laya-card-')))
  const name = 'Downloading the Laya model from Hugging Face'
  sidecar.noteInstall({ kind: 'install', device: 'cpu', step: 6, of: 8, name, received: 0, total: 0, error: `No progress for 5 minutes while ${name}.`, failedStep: 6, failedName: name, offerCpu: false, lines: [], notes: [], startedAt: NOW, finishedAt: NOW, done: false })
  const st = sidecar.status()
  await sidecar.dispose()
  assert.equal(st.state, 'install_failed')
  for (const offer of [undefined, OFFER]) {
    const page = await card({ ...st, offer })
    await page.press('Try again')
    assert.deepEqual(page.posts, [], 'nothing is installed for a device nobody chose')
    const dialog = page.all().find((n) => n.props.role === 'dialog')
    assert.ok(dialog, 'the install dialog asks again')
    nodes(dialog).find((n) => n.type === 'input' && n.props.value === 'cpu').props.onChange()
    await page.settle()
    await page.press('Install')
    assert.deepEqual(page.posts, [['/jev-router/laya/install', { device: 'cpu' }]], 'for the one the person picks')
    page.close()
  }
  // A status that says which device the install was for is tried again for that one, at once.
  const page = await card({ ...st, install: { ...st.install, device: 'cpu' }, offer: OFFER })
  await page.press('Try again')
  assert.deepEqual(page.posts, [['/jev-router/laya/install', { device: 'cpu' }]])
  assert.ok(!page.all().some((n) => n.props.role === 'dialog'))
  page.close()
})

test('the status is read every 5 s, every 1.5 s while Laya moves, and a read never puts the saved idle time back over one being typed', async () => {
  const page = await card(status(), { compare: { questions: [], skips: null }, replies: { '/jev-router/laya/settings': (sent) => { page.status = status({ settings: { ...page.status.settings, ...sent } }) } } })
  const reads = () => page.gets.filter((g) => g === '/jev-router/laya').length
  const idle = () => page.input('jevi-laya-idle').props.value
  // The status every 5 s, and the comparison once a minute.
  assert.deepEqual(page.polls(), [5000, 60_000])
  assert.equal(reads(), 1)
  await page.poll(5000)
  assert.equal(reads(), 2)
  // Starting: every 1.5 s, and every 5 s again once it is up.
  page.status = status({ state: 'starting', running: running() })
  await page.poll(5000)
  assert.deepEqual(page.polls(), [1500, 60_000])
  page.status = status({ state: 'ready', running: running() })
  await page.poll(1500)
  assert.deepEqual(page.polls(), [5000, 60_000])

  // The person clears the idle time to type another, and a read lands in between.
  assert.equal(idle(), '30')
  page.input('jevi-laya-idle').props.onChange({ target: { value: '' } })
  await page.settle()
  await page.poll(5000)
  assert.equal(idle(), '', 'the field being typed in is left alone')
  page.input('jevi-laya-idle').props.onChange({ target: { value: '120' } })
  await page.poll(5000)
  assert.equal(idle(), '120')
  page.input('jevi-laya-idle').props.onBlur()
  await page.settle()
  assert.deepEqual(page.posts, [['/jev-router/laya/settings', { idleMinutes: 120 }]])
  assert.equal(idle(), '120', 'the saved value, reloaded')
  // Not being typed in, the field follows what is saved, a change made elsewhere included.
  page.status = status({ state: 'ready', running: running(), settings: { ...page.status.settings, idleMinutes: 45 } })
  await page.poll(5000)
  assert.equal(idle(), '45')
  // Leaving the field unchanged sends nothing.
  page.input('jevi-laya-idle').props.onChange({ target: { value: '45' } })
  page.input('jevi-laya-idle').props.onBlur()
  await page.settle()
  assert.equal(page.posts.length, 1)
  page.close()
  assert.deepEqual(page.polls(), [], 'and closing the card stops every read')

  // A value the server refuses: the refusal as it words it, and the field shows what is saved.
  const strict = await card(status(), { replies: { '/jev-router/laya/settings': { code: 400, body: { error: 'Unload after idle: whole minutes 1-240' } } } })
  strict.input('jevi-laya-idle').props.onChange({ target: { value: '500' } })
  await strict.settle()
  strict.input('jevi-laya-idle').props.onBlur()
  await strict.settle()
  assert.deepEqual(strict.posts, [['/jev-router/laya/settings', { idleMinutes: 500 }]])
  assert.deepEqual(strict.alerts(), ['Unload after idle: whole minutes 1-240'])
  assert.equal(strict.input('jevi-laya-idle').props.value, '30')
  strict.close()
})

test('the Jev router card says where Jev calls go, and when TYPESAFE_BASE_URL sends them elsewhere', async () => {
  const h = helpers()
  assert.equal(h.jevHostLine({ configured: true, credentialRef: 'env:TYPESAFE_API_KEY', host: 'api.typesafe.ai', hostFromEnv: false }), 'Jev calls go to api.typesafe.ai.')
  assert.equal(h.jevHostLine({ host: 'jev.example:8443', hostFromEnv: true }), 'TYPESAFE_BASE_URL is set, so Jev calls go to jev.example:8443, and the Jev column of the comparisons is that server\'s answers.')
  assert.equal(h.jevHostLine({ configured: true }), null, 'a server that does not say is not guessed for')
  // On the Jev setup page, behind GET /jev-router/setup: the line on the Jev router card, the Laya
  // card right after it, and what the Laya card asks shown in the page's own dialog.
  const jev = { configured: true, credentialRef: 'env:TYPESAFE_API_KEY', host: 'jev.example:8443', hostFromEnv: true }
  let busy = 0
  const fetch = async (path) => {
    busy++
    try {
      const text = JSON.stringify(path === '/jev-router/setup' ? { agents: [], providers: [], tools: [], jev } : {})
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection, LayaCard } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof SetupSection, 'function', 'the Jev setup page can be rendered')
  const view = mount(SetupSection, {}, { shallow: true })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const cards = view.tree.children.filter((n) => n && typeof n === 'object')
  const at = cards.findIndex((n) => n.props.className === 'card' && textOf(n.children[0]) === 'Jev router')
  assert.ok(at > 0, 'the Jev router card')
  assert.ok(textOf(cards[at]).endsWith(h.jevHostLine(jev)), 'says where Jev calls go')
  assert.equal(cards[at + 1].type, LayaCard, 'and the Laya card comes right after it')
  let ran = 0
  cards[at + 1].props.ask({ ...h.layaRemoveDialog(status()), run: async () => { ran++ } })
  await settle()
  const asked = () => nodes(view.tree).find((n) => n.props.title === 'Remove Laya?')
  assert.equal(asked()?.props.confirmLabel, 'Remove Laya', 'the page asks in the Laya card\'s words')
  assert.equal(ran, 0, 'and runs nothing before the person confirms')
  asked().props.onConfirm()
  await settle()
  assert.equal(ran, 1)
  assert.equal(asked(), undefined)
  view.unmount()
})

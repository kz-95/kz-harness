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
import { waitFor } from './wait-for.js'

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
      weights: { commit: COMMIT, bytes: 842609220, downloadedAt: '2026-09-20T09:30:00.000Z' }, diskBytes: 4.1 * GB, bytes: { engine: 3.3 * GB, models: 0.8 * GB },
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
/** The figures an install needs before anything is installed, as laya-install.js installOffer gives them on a PC with an RTX 3050, and where Laya lives. */
const OFFER = {
  gpu: { name: GPU, cuda: 12.8 },
  python: '3.12',
  disk: { gpu: { installingGB: 8 }, cpu: { installingGB: 3 } },
  torch: { gpu: { bytes: 2.5 * GB, source: 'download.pytorch.org' }, cpu: { bytes: 120 * 1024 ** 2, source: 'PyPI' } },
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
    lines: ['Not installed. Needs about 8 GB of free disk while installing, and the internet once.', `PyTorch with CUDA will be installed for your ${GPU}.`],
    buttons: ['Install Laya…'], log: [],
  })
  assert.deepEqual(seen(h, status({ ...bare, offer: { ...OFFER, gpu: null } })).lines, [
    'Not installed. Needs about 3 GB of free disk while installing, and the internet once.',
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
  assert.equal(seen(h, status({ installed: null, state: 'installing', install: { ...step4, step: 3, name: 'Getting Python 3.12', received: 0, total: 0, notes: [], stepStartedAt: NOW - 3 * 60_000 } })).lines[0], 'Installing, step 3 of 8: Getting Python 3.12 (3 min).')

  // The bar. Steps carry it and a step that reports bytes fills its own share, so the PyTorch
  // step - most of the gigabytes, and most of the wait - moves instead of sitting still.
  const bar = (st) => h.layaState(st, NOW).progress
  assert.deepEqual(bar(status({ installed: null, state: 'installing', install: step4 })), { value: (3 + 1.2 / 2.5) / 8, label: 'Installing Laya' })
  // A step that reports no bytes still stands at the steps done before it, never at nothing.
  assert.equal(bar(status({ installed: null, state: 'installing', install: { ...step4, step: 3, received: 0, total: 0 } })).value, 2 / 8)
  // Before the first step there is nothing to measure: the bar says working rather than zero.
  assert.equal(bar(status({ installed: null, state: 'installing', install: { ...step4, step: null } })).value, null)
  // An update says so on the bar too, since that is all a screen reader is given.
  assert.equal(bar(status({ installed: null, state: 'installing', install: { ...step4, kind: 'update' } })).label, 'Updating Laya')
  // Starting is not measurable - the model loads inside a process that says so only when done -
  // so it is working with no figure, and every settled state has no bar at all.
  assert.deepEqual(bar(status({ state: 'starting', running: running() })), { value: null, label: 'Starting Laya' })
  for (const st of [status({ state: 'ready', running: running() }), status({ installed: null, state: 'not_installed', offer: OFFER, paths: PATHS })]) {
    assert.equal(bar(st), null, 'nothing is happening, so nothing claims to be')
  }

  // And the card renders it. The panel is a browser file the runner cannot import, so this is the
  // tripwire for a bar that is worked out and then never drawn.
  assert.match(client, /view\.progress \? h\('div'/, 'the card draws the bar')
  assert.match(client, /h\('progress', \{/, "as a plain `progress`, which reads as one to a screen reader")

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

test('an install or update refused before its first step says why, never a step it did not reach', () => {
  const h = helpers()
  const refused = { step: 0, of: 8, name: null, received: 0, total: 0, error: 'Laya is deciding for an open Laya Auto run; stop that run first.', kind: 'update', failedStep: null, offerCpu: false, notes: [] }
  const said = 'The update did not start: Laya is deciding for an open Laya Auto run; stop that run first.'
  assert.deepEqual(seen(h, status({ state: 'ready', running: running({ held: ['run:42'] }), install: refused })).lines.slice(1), [said], 'beside the Laya that keeps running')
  assert.deepEqual(seen(h, status({ state: 'install_failed', install: refused })).lines, [said])
  const locked = { ...refused, kind: 'install', error: 'Another Laya install is running (pid 4242).' }
  assert.deepEqual(seen(h, status({ installed: null, state: 'install_failed', install: locked })).lines, ['The install did not start: Another Laya install is running (pid 4242).'])
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
  const STOPPED = ['Start', 'Test Laya', 'Remove…']
  assert.deepEqual(seen(h, status({ stoppedBecause: 'idle' })), { lines: ['Stopped after 30 min without a Laya Auto request. It starts again when Laya Auto needs it; the Jev Auto comparisons never start it.'], buttons: STOPPED, log: [] })
  assert.deepEqual(seen(h, status({ stoppedBecause: 'budget', why: 'the RAM budget of 8 GB was over for 30 s with qwen3-8b and Laya loaded.' })), { lines: ['Stopped by the resource budget: the RAM budget of 8 GB was over for 30 s with qwen3-8b and Laya loaded.'], buttons: STOPPED, log: [] })
  assert.deepEqual(seen(h, status({ stoppedBecause: 'yielded', why: 'qwen3-8b' })), { lines: ['Unloaded so qwen3-8b could have the GPU and RAM; it starts again when Laya Auto needs it.'], buttons: STOPPED, log: [] })
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
  // Killed by a signal: named as a signal, never as an exit code.
  assert.deepEqual(seen(h, status({ state: 'restarting', why: 'signal SIGKILL', restart: { attempt: 2, of: 3, code: null, signal: 'SIGKILL' } })).lines,
    ['Laya stopped unexpectedly (signal SIGKILL) and is restarting (attempt 2 of 3).'])
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

test('pins that cannot be read send the person to Update-Harness.ps1, never to cordis.patch.yml, and a settings error beside them keeps its own remedy', () => {
  const h = helpers()
  const ENOENT = "ENOENT: no such file or directory, open 'C:\\Harness\\config\\laya.json'"
  const pins = `Laya's pinned versions could not be read (${ENOENT}); run Update-Harness.ps1. Laya Auto is off until then.`
  // As GET /jev-router/laya answers it: the pins apart from any error in the laya block (index.js).
  const unread = status({ state: 'disabled', configError: null, pinsError: ENOENT })
  assert.deepEqual(seen(h, unread), { lines: [pins], buttons: [], log: [] })
  assert.equal(h.layaState(unread, NOW).lines[0].tone, 'err')
  assert.deepEqual([h.layaNotes(unread, null), h.layaVersions(unread)], [[], []], 'and nothing else of Laya is offered')
  const both = status({ state: 'disabled', configError: 'providers: laya.minTopMargin: 1.5 is above 1', pinsError: ENOENT })
  assert.deepEqual(seen(h, both).lines, ['Laya settings error: providers: laya.minTopMargin: 1.5 is above 1. Fix jev-router laya in cordis.patch.yml; Laya Auto is off until then.', pins])
})

test('the card reads what the server really sends: what an install takes, from the installer; a step\'s minutes and each folder\'s size, from the real status()', async () => {
  const h = helpers()
  const { installOffer, layaPaths, readPins } = await import('../laya-install.js')
  assert.equal(typeof installOffer, 'function', 'the installer says what an install takes')
  // On a PC with an RTX 3050 whose driver runs CUDA 12.8: the shape the card is fed above.
  const offer = installOffer(readPins(REPO), { gpus: [{ vendor: 'nvidia', name: GPU }], cuda: 12.8 })
  assert.deepEqual(offer, OFFER)
  const bare = status({ installed: null, state: 'not_installed', offer, paths: PATHS })
  assert.equal(seen(h, bare).lines[0], 'Not installed. Needs about 8 GB of free disk while installing, and the internet once.')
  assert.deepEqual(h.layaInstallDialog(bare, 'gpu').lines.slice(1), [
    "Downloads once, then works offline: Python 3.12 (about 30 MB, GitHub), PyTorch 2.14.0 (about 2.5 GB, download.pytorch.org), Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).",
    'Needs about 8 GB of free disk while installing.',
  ])
  assert.equal(installOffer(readPins(REPO), null).gpu, null, 'with no NVIDIA GPU it installs for the CPU')
  // A step with nothing to download says how long it has taken, from when the installer began it.
  const sidecar = await layaSidecar(mkdtempSync(join(tmpdir(), 'laya-card-')))
  sidecar.noteInstall({ kind: 'install', device: 'cpu', step: 5, of: 8, name: 'Installing Laya 0.3.20', received: 0, total: 0, error: null, lines: [], notes: [], startedAt: NOW - 9 * 60_000, stepStartedAt: NOW - 3 * 60_000, done: false })
  assert.equal(seen(h, sidecar.status()).lines[0], 'Installing, step 5 of 8: Installing Laya 0.3.20 (3 min).')
  await sidecar.dispose()
  // Installed: the remove dialog names each folder's size.
  const harnessDir = await installedLaya()
  const paths = layaPaths({ harnessDir, dataDir: join(harnessDir, 'data') })
  writeFileSync(join(paths.venv, 'torch.bin'), Buffer.alloc(3 * 1024 ** 2))
  writeFileSync(join(paths.models, 'more.bin'), Buffer.alloc(2 * 1024 ** 2))
  const installed = await layaSidecar(harnessDir)
  const st = await waitFor('the folders are measured', () => installed.status(), (x) => typeof x.installed?.diskBytes === 'number')
  await installed.dispose()
  assert.equal(h.layaRemoveDialog({ ...st, paths: PATHS }).body, 'Stops Laya and deletes C:\\Harness\\engine\\laya (3 MB) and C:\\Harness\\models\\laya (2 MB). Your recorded comparisons and Laya samples are kept. Laya Auto leaves the model menu.')
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

test('a Laya stopped for a reason, or under an update that failed, still offers Test Laya and Remove, and a failed update offers Start', async () => {
  const h = helpers()
  // The idle stop is the usual way Laya ends up stopped, and its reason stays until the next start.
  for (const stoppedBecause of ['idle', 'budget', 'yielded']) assert.deepEqual(seen(h, status({ stoppedBecause, why: 'qwen3-8b' })).buttons, ['Start', 'Test Laya', 'Remove…'], stoppedBecause)
  // The real status() of an update that failed while Laya was stopped: the old install is there.
  const sidecar = await layaSidecar(await installedLaya())
  const name = 'Installing Laya 0.3.24'
  sidecar.noteInstall({ kind: 'update', step: 5, of: 8, name, received: 0, total: 0, error: 'uv pip install failed: no solution', failedStep: 5, failedName: name, offerCpu: false, lines: [], notes: [], startedAt: NOW, stepStartedAt: NOW, finishedAt: NOW, done: false })
  const st = sidecar.status()
  await sidecar.dispose()
  assert.equal(st.state, 'install_failed')
  assert.deepEqual(seen(h, st), { lines: ['Update failed at step 5 (Installing Laya 0.3.24); still on Laya 0.3.20.'], buttons: ['Try again', 'Show log', 'Start', 'Test Laya', 'Remove…'], log: [] })
  assert.deepEqual(h.layaNotes(st, null).map((n) => n.text), ['Laya is not running, so Jev Auto records no comparisons now. Press Start, or turn on Start Laya when KzH starts and Keep Laya loaded.'])
  // A failed first install has nothing to start.
  const first = status({ installed: null, state: 'install_failed', install: { step: 6, of: 8, name: 'Downloading the Laya model from Hugging Face', error: 'No progress for 5 minutes.', kind: 'install', failedStep: 6, offerCpu: false, notes: [] } })
  assert.deepEqual(seen(h, first).buttons, ['Try again', 'Show log'])
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

test('a Laya an earlier session left that the sweep could not check (run as administrator) is named, with how to stop it', () => {
  const h = helpers()
  assert.deepEqual(seen(h, status({ orphansUnchecked: [601, 602] })).lines, [
    'A Laya an earlier session left may still be running (pid 601, 602); it could not be checked or stopped from here (it may run as administrator). End it in Task Manager (Details, right-click pid 601, End process tree; run Task Manager as administrator if it says access is denied), or restart the PC.',
    'Installed, not running. Laya 0.3.20, English checkpoint 1a2b3c4, PyTorch 2.14.0+cu128 (for the GPU, CUDA 12.8).',
  ])
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
      'Needs about 8 GB of free disk while installing.',
    ],
    choices: [
      { value: 'gpu', label: `GPU: ${GPU} with CUDA 12.8 (speed not measured on this PC yet; Test Laya measures it after the install)` },
      { value: 'cpu', label: 'CPU only (smaller download; on a 4-core test machine, about 20 s to route a task and about 10 s to review each attempt)' },
    ],
  })
  assert.deepEqual(h.layaInstallDialog(bare, 'cpu').lines.slice(1), [
    "Downloads once, then works offline: Python 3.12 (about 30 MB, GitHub), PyTorch 2.14.0 (about 120 MB, PyPI), Laya 0.3.20 and its libraries (about 100 MB, PyPI), and Laya's English model (0.8 to 1.7 GB, Hugging Face).",
    'Needs about 3 GB of free disk while installing.',
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

/** A reply function's answer with a status code of its own, where a plain return is the body of a 200. */
const answer = (code, body) => ({ answer: true, code, body })

/**
 * The Laya card behind the routes of 8.4: GET /jev-router/laya answers `page.status`, the comparison
 * and the log answer what they are given, and every POST is recorded and answered by `replies`
 * (by path: a status code and a body, or a function run before answering, which may return the body
 * or `answer(code, body)`). The polls never run by themselves: `page.polls()` says how often each one
 * the card has set would run, and `page.poll(ms)` runs those set for every `ms` once. `page.pressing`
 * presses a button whose request stays on its way, and `{ inFlight }` lets the card settle with that
 * many requests still unanswered.
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
        else if (path === '/jev-router/laya/compare?days=7&identity=current') {
          if (compare?.answer === true) { code = compare.code; body = compare.body } else { body = compare ?? { error: 'not set up' }; code = compare ? 200 : 404 }
        }
        else if (path === '/jev-router/laya/log?lines=200') body = { lines: logLines }
        else code = 404
      } else {
        const sent = JSON.parse(init.body)
        page.posts.push([path, sent])
        const r = replies[path]
        if (typeof r === 'function') {
          const got = await r(sent)
          if (got?.answer === true) { code = got.code; body = got.body } else body = got ?? { ok: true }
        }
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
  page.settle = async ({ inFlight = 0 } = {}) => {
    for (let quiet = 0, until = Date.now() + 10_000; quiet < 2; quiet = busy <= inFlight && !view.queued ? quiet + 1 : 0) {
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
  page.pressing = async (label, { inFlight = 1 } = {}) => {
    const b = page.all().find((n) => n.type === 'button' && textOf(n) === label)
    assert.ok(b, `a ${label} button (have: ${page.buttons().join(', ')})`)
    b.props.onClick()
    await page.settle({ inFlight })
  }
  page.button = (label) => page.all().find((n) => n.type === 'button' && textOf(n) === label)
  page.alerts = () => page.all().filter((n) => n.props.role === 'alert').map(textOf)
  page.polls = () => [...intervals.values()].map((t) => t.ms).sort((a, b) => a - b)
  page.poll = async (ms, { inFlight = 0 } = {}) => { for (const t of [...intervals.values()]) if (t.ms === ms) t.f(); await page.settle({ inFlight }) }
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

test('Try again after a failed install installs again for the device the real status says it was for, and asks when a status does not say, never guessing the GPU', async () => {
  // The real status() of a failed first install the person started for the CPU carries its device.
  const sidecar = await layaSidecar(mkdtempSync(join(tmpdir(), 'laya-card-')))
  const name = 'Downloading the Laya model from Hugging Face'
  sidecar.noteInstall({ kind: 'install', device: 'cpu', step: 6, of: 8, name, received: 0, total: 0, error: `No progress for 5 minutes while ${name}.`, failedStep: 6, failedName: name, offerCpu: false, lines: [], notes: [], startedAt: NOW, stepStartedAt: NOW, finishedAt: NOW, done: false })
  const st = sidecar.status()
  await sidecar.dispose()
  assert.equal(st.state, 'install_failed')
  assert.equal(st.install.device, 'cpu')
  const page = await card({ ...st, offer: OFFER })
  await page.press('Try again')
  assert.deepEqual(page.posts, [['/jev-router/laya/install', { device: 'cpu' }]])
  assert.ok(!page.all().some((n) => n.props.role === 'dialog'))
  page.close()
  // A status that does not say which device (as from a server before it did) asks again.
  for (const offer of [undefined, OFFER]) {
    const asked = await card({ ...st, install: { ...st.install, device: null }, offer })
    await asked.press('Try again')
    assert.deepEqual(asked.posts, [], 'nothing is installed for a device nobody chose')
    const dialog = asked.all().find((n) => n.props.role === 'dialog')
    assert.ok(dialog, 'the install dialog asks again')
    nodes(dialog).find((n) => n.type === 'input' && n.props.value === 'cpu').props.onChange()
    await asked.settle()
    await asked.press('Install')
    assert.deepEqual(asked.posts, [['/jev-router/laya/install', { device: 'cpu' }]], 'for the one the person picks')
    asked.close()
  }
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

test('a comparison the server could not work out is said under the switches, and one there is none of says nothing', async () => {
  const failing = await card(status({ state: 'ready', running: running() }), { compare: answer(500, { error: 'the comparison worker exited with code 1' }) })
  assert.ok(failing.text().includes('The comparisons could not be read: the comparison worker exited with code 1.'), failing.text())
  failing.close()
  const none = await card(status({ state: 'ready', running: running() }), { compare: answer(404, { error: 'Laya cannot be asked on this PC, and nothing has been compared' }) })
  assert.ok(!none.text().includes('could not be read'), none.text())
  none.close()
})

test('Stop stays pressable while a start from the card loads the model, the card follows the start at once, and the start Stop ended is no error of its own', async () => {
  let startAnswered
  const page = await card(status(), {
    replies: {
      // The server answers Start once the model has loaded, which can take minutes.
      '/jev-router/laya/start': () => new Promise((r) => { startAnswered = r }),
      // Stop ends the start, which the server then answers as stopped.
      '/jev-router/laya/stop': () => { page.status = status(); startAnswered(answer(400, { error: 'it was stopped' })) },
    },
  })
  assert.deepEqual(page.polls(), [5000, 60_000])
  await page.pressing('Start')
  assert.deepEqual(page.polls(), [1500, 60_000], 'the status is read every 1.5 s while the start is on its way')
  page.status = status({ state: 'starting', running: running() })
  await page.poll(1500, { inFlight: 1 })
  assert.ok(page.text().includes('Starting: loading the model on the GPU'), page.text())
  assert.equal(page.button('Stop').props.disabled, false, 'Stop can end the start')
  assert.equal(page.button('Repair').props.disabled, true, 'while nothing else can be pressed')
  await page.press('Stop')
  assert.deepEqual(page.posts, [['/jev-router/laya/start', {}], ['/jev-router/laya/stop', {}]])
  assert.deepEqual(page.alerts(), [], 'the start that Stop ended says nothing of its own')
  assert.deepEqual(page.buttons(), ['Start', 'Test Laya', 'Remove…', 'Check for a newer model', 'Repair'])
  assert.ok(page.all().filter((n) => n.type === 'button').every((b) => !b.props.disabled), 'and every button can be pressed again')
  assert.deepEqual(page.polls(), [5000, 60_000])
  // Test Laya on a stopped Laya starts it too, and Stop can end that start the same way.
  const tested = await card(status(), { replies: { '/jev-router/laya/selftest': () => new Promise(() => {}) } })
  await tested.pressing('Test Laya')
  tested.status = status({ state: 'starting', running: running() })
  await tested.poll(1500, { inFlight: 1 })
  assert.equal(tested.button('Stop').props.disabled, false)
  page.close(); tested.close()
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

test('Jev setup says to restart while the server says a restart would move a provider onto another key, and names the Jev key in use, both following the polled reading', async () => {
  let pending = ['deepseek']
  let jevActiveKey = 'fresh'
  let jevCredentialSet = true
  let busy = 0
  let giveNames
  const namesArrive = new Promise((r) => { giveNames = r })
  const fetch = async (path) => {
    busy++
    try {
      // The names come late, after the page has settled once.
      if (path === '/jev-router/names') { busy--; await namesArrive; busy++ }
      const body = path === '/jev-router/setup' ? { agents: [], providers: [], tools: [], jev: { configured: true, activeKey: 'fresh', credentialRef: 'TYPESAFE_API_KEY' }, keysRestartPending: ['deepseek'] }
        : path.startsWith('/jev-router/usage') ? { agents: [], keys: {}, keysRestartPending: pending, jevActiveKey, jevCredentialSet }
        : path === '/jev-router/names' ? { providers: { deepseek: 'DeepSeek' }, models: {}, agents: {} } : {}
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }
    } finally { busy-- }
  }
  const polls = []
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection, RestartLine } = loadPlugin(React, { fetch, document, setInterval: (fn, ms) => { polls.push([fn, ms]); return polls.length }, clearInterval: () => {} }).__test
  let renders = 0
  const view = mount((p) => { renders++; return SetupSection(p) }, {}, { shallow: true })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const line = () => nodes(view.tree).find((n) => n.type === RestartLine)
  assert.ok(line(), 'the page renders the restart line')
  // The provider names arrive: the page renders again with them.
  const before = renders
  giveNames()
  await settle()
  assert.ok(renders > before, 'the page follows the names as they arrive')
  assert.equal(textOf(RestartLine(line().props)), 'Restart the harness to apply the DeepSeek key change (Kz-harness → Restart harness)')
  const jevCard = () => view.tree.children.filter((n) => n && typeof n === 'object').find((n) => n.props.className === 'card' && textOf(n.children[0]) === 'Jev router')
  assert.match(textOf(jevCard()), /Jev key 'fresh' is active\. Jev routes and reviews\./)
  // A run moved the active DeepSeek key back to the one in use, and Jev on to its next key: the
  // next reading says so, and the page follows.
  pending = []
  jevActiveKey = 'second'
  for (const [fn, ms] of polls) if (ms === 30000) fn()
  await settle()
  assert.equal(RestartLine(line().props), null)
  assert.match(textOf(jevCard()), /Jev key 'second' is active\. Jev routes and reviews\./)
  // That key's value gone, and no credential to fall back to: the card says so, its dot off.
  jevActiveKey = null
  jevCredentialSet = false
  for (const [fn, ms] of polls) if (ms === 30000) fn()
  await settle()
  assert.match(textOf(jevCard()), /^Jev routerTYPESAFE_API_KEY missing\. Routing falls back to the default agent\./)
  assert.ok(nodes(jevCard()).some((n) => n.props?.className === 'dot off'))
})

test('Jev setup reads the page back after an action that failed, and still shows why it failed', async () => {
  let setupReads = 0
  let busy = 0
  const fetch = async (path, init) => {
    busy++
    try {
      if (path === '/jev-router/agents' && init?.method === 'POST') return { ok: false, status: 500, json: async () => ({ error: 'the setup file could not be written' }) }
      if (path === '/jev-router/setup') setupReads++
      const body = path === '/jev-router/setup' ? { agents: [{ id: 'deepseek', enabled: setupReads > 1 }], providers: [], tools: [], jev: { configured: false, credentialRef: 'TYPESAFE_API_KEY' }, keysRestartPending: [] }
        : path.startsWith('/jev-router/usage') ? { agents: [], keys: {} } : {}
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  const view = mount(SetupSection, {}, { shallow: true })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const chips = nodes(view.tree).find((n) => typeof n.props?.onToggle === 'function')
  chips.props.onToggle('deepseek', true)
  await settle()
  assert.equal(setupReads, 2, 'read back after the failed action')
  assert.equal(nodes(view.tree).find((n) => typeof n.props?.onToggle === 'function').props.agents[0].enabled, true, 'showing the state the server is in')
  assert.equal(textOf(nodes(view.tree).find((n) => n.props?.role === 'alert')), 'the setup file could not be written')
})

test('Jev setup shows the Chat replies card, whose rows post the wait in whole milliseconds and the progress setting, each as the settings route takes it', async () => {
  const { validChatReplies } = await import('../index.js')
  let saved = { waitMs: 15_000, progress: 'milestones', askWhenWrong: true }
  const posts = []
  let busy = 0
  const fetch = async (path, init) => {
    busy++
    try {
      let code = 200
      let body = {}
      if (path === '/jev-router/setup') body = { agents: [], providers: [], tools: [], jev: { configured: true, credentialRef: 'TYPESAFE_API_KEY' }, keysRestartPending: [] }
      else if (path === '/jev-router/chat-replies/settings' && init?.method === 'POST') {
        // Answered as the route answers it: the patch laid over what is saved, or a 400 saying why not.
        const sent = JSON.parse(init.body)
        posts.push(sent)
        try { saved = validChatReplies(sent, saved); body = saved } catch (err) { code = 400; body = { error: err.message } }
      } else if (path === '/jev-router/chat-replies/settings') body = saved
      const text = JSON.stringify(body)
      return { ok: code === 200, status: code, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection, ChatRepliesCard } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof ChatRepliesCard, 'function', 'client.js has the Chat replies card')
  const settle = async (view) => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  const page = mount(SetupSection, {}, { shallow: true })
  await settle(page)
  assert.ok(page.tree.children.some((n) => n?.type === ChatRepliesCard), 'the Jev setup page shows it, where the README sends the owner')
  page.unmount()
  // The card as the page runs it, behind the settings route.
  const card = mount(ChatRepliesCard, {})
  await settle(card)
  const select = (id) => nodes(card.tree).find((n) => n.type === 'select' && n.props.id === id)
  const alerts = () => nodes(card.tree).filter((n) => n.props.role === 'alert').map(textOf)
  assert.equal(textOf(nodes(card.tree).find((n) => n.props.id === 'jevi-replies-h')), 'Chat replies')
  assert.deepEqual([select('jevi-rp-w')?.props.value, select('jevi-rp-p')?.props.value], ['15000', 'milestones'], 'the saved settings')
  await select('jevi-rp-w').props.onChange({ target: { value: '5000' } })
  await settle(card)
  assert.deepEqual(posts, [{ waitMs: 5000 }], 'the wait goes as whole milliseconds')
  assert.deepEqual(alerts(), [], 'which the route takes')
  assert.equal(select('jevi-rp-w').props.value, '5000', 'and the row shows what it kept')
  await select('jevi-rp-p').props.onChange({ target: { value: 'off' } })
  await settle(card)
  assert.deepEqual(posts.at(-1), { progress: 'off' })
  assert.deepEqual(alerts(), [])
  assert.equal(select('jevi-rp-p').props.value, 'off')
  assert.deepEqual(saved, { waitMs: 5000, progress: 'off', askWhenWrong: true })
  card.unmount()
})

test('Jev setup shows the Live agent view card: whether each agent\'s work shows live, from the engine patch, and rows that post the live settings as the settings route takes them', async () => {
  const { validLiveSettings } = await import('../index.js')
  let saved = { claudeSteer: false, claudeThinking: 'default', transcripts: 'last20' }
  const posts = []
  let busy = 0
  const why = 'dsh-subagent-codex 0.1.6 is installed, and this patch was written for 0.1.5-rc.2'
  const fetch = async (path, init) => {
    busy++
    try {
      let code = 200
      let body = {}
      if (path === '/jev-router/setup') body = { agents: [], providers: [], tools: [], jev: { configured: true, credentialRef: 'TYPESAFE_API_KEY' }, keysRestartPending: [] }
      else if (path === '/jev-router/engine-patches') body = { 'claude-code': { on: true, why: null }, codex: { on: false, why } }
      else if (path === '/jev-router/live/settings' && init?.method === 'POST') {
        // Answered as the route answers it: the patch laid over what is saved, or a 400 saying why not.
        const sent = JSON.parse(init.body)
        posts.push(sent)
        try { saved = validLiveSettings(sent, saved); body = saved } catch (err) { code = 400; body = { error: err.message } }
      } else if (path === '/jev-router/live/settings') body = saved
      const text = JSON.stringify(body)
      return { ok: code === 200, status: code, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection, LiveAgentViewCard } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof LiveAgentViewCard, 'function', 'client.js has the Live agent view card')
  const settle = async (view) => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  const page = mount(SetupSection, {}, { shallow: true })
  await settle(page)
  assert.ok(page.tree.children.some((n) => n?.type === LiveAgentViewCard), 'the Jev setup page shows it, where the README sends the owner')
  page.unmount()
  const card = mount(LiveAgentViewCard, {})
  await settle(card)
  const terms = nodes(card.tree).filter((n) => n.type === 'dt').map(textOf)
  const words = nodes(card.tree).filter((n) => n.type === 'dd').map(textOf)
  assert.deepEqual(terms.slice(0, 3).map((x, i) => [x, words[i]]), [
    ['Claude Code', 'live detail on'],
    ['Codex', `live detail off (${why})`],
    ['DeepSeek, API and local models', 'always on (no patch needed)'],
  ])
  const select = (id) => nodes(card.tree).find((n) => n.type === 'select' && n.props.id === id)
  const toggle = () => nodes(card.tree).find((n) => n.type === 'input' && n.props.role === 'switch')
  const alerts = () => nodes(card.tree).filter((n) => n.props.role === 'alert').map(textOf)
  assert.deepEqual([toggle()?.props.checked, select('jevi-lv-t')?.props.value, select('jevi-lv-k')?.props.value], [false, 'default', 'last20'], 'the settings as shipped')
  assert.deepEqual(nodes(select('jevi-lv-k')).filter((n) => n.type === 'option').map((n) => [n.props.value, textOf(n)]), [['last20', 'Last 20 tasks'], ['last100', 'Last 100 tasks'], ['off', 'Off']])
  await toggle().props.onChange({ target: { checked: true } })
  await settle(card)
  await select('jevi-lv-t').props.onChange({ target: { value: 'summarized' } })
  await settle(card)
  await select('jevi-lv-k').props.onChange({ target: { value: 'last100' } })
  await settle(card)
  assert.equal(select('jevi-lv-k').props.value, 'last100', 'Last 100 tasks is still one the route takes')
  await select('jevi-lv-k').props.onChange({ target: { value: 'off' } })
  await settle(card)
  assert.deepEqual(posts, [{ claudeSteer: true }, { claudeThinking: 'summarized' }, { transcripts: 'last100' }, { transcripts: 'off' }])
  assert.deepEqual(alerts(), [], 'each one the route takes')
  assert.deepEqual([toggle().props.checked, select('jevi-lv-t').props.value, select('jevi-lv-k').props.value], [true, 'summarized', 'off'], 'and the rows show what it kept')
  assert.deepEqual(saved, { claudeSteer: true, claudeThinking: 'summarized', transcripts: 'off' })
  card.unmount()
})

test('the Chat replies card says what Milestones post: a notice when a task starts on an agent its reply did not name, at another effort, again as work that writes, or moves to another agent; and that Start and result only keeps the one for an agent its reply guessed', async () => {
  let busy = 0
  const fetch = async (path) => {
    busy++
    try {
      const text = JSON.stringify(path === '/jev-router/chat-replies/settings' ? { waitMs: 15_000, progress: 'milestones', askWhenWrong: true } : {})
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { ChatRepliesCard } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof ChatRepliesCard, 'function', 'client.js has the Chat replies card')
  const card = mount(ChatRepliesCard, {})
  for (let quiet = 0; quiet < 2; quiet = !busy && !card.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r))
  // The four kinds of notice the README's Milestone notices list names, and nothing else, and the one
  // Start and result only keeps (decided by the owner, 9 Oct), so the owner choosing between them is
  // told what the choice posts.
  assert.equal(textOf(nodes(card.tree).find((n) => n.props.className === 'why')), 'A task you send starts in the background. Its reply names the agent, model and effort once Jev has picked them, waiting for the pick at most this long, or the guessed ones before the pick once How Jev replies shows quick replies on; a task that waits its turn is answered at once. Milestones add a short notice when a task starts on an agent its reply did not name, starts at another effort than its reply named, starts again as work that writes once its read pass hands it back, or moves to another agent on a retry. Start and result only drops all of them but one: a task that starts on another agent than its reply guessed still gets that notice.')
  card.unmount()
})

test('the How Jev replies card renders the gate figures from a stubbed /replies/summary', async () => {
  // What GET /jev-router/replies/summary answers (index.js repliesSummary), as a PC some way along has it.
  const summary = {
    learning: true,
    startReplies: { medianMs: 2400, n: 3, days: 7 },
    prediction: {
      gates: { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } }, labelled: 75, minRows: 60, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 },
      records: { jev: { quick: { decider: 'jev', of: 50, n: 50, right: 41 }, likely: { decider: 'jev', of: 20, n: 20, right: 15 } }, laya: { quick: { decider: 'laya', of: 50, n: 20, right: 18 }, likely: { decider: 'laya', of: 20, n: 20, right: 18 } } },
    },
    recent: [
      { jobId: 'jev-12', decider: 'jev', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'routed', ms: 2400 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1', runId: 'run-12' }, predicted: { agent: 'claude', level: 'high', confidence: 0.81, trusted: true }, match: true },
      { jobId: 'jev-11', decider: 'jev', said: { agent: null, effort: null, model: null, how: 'waited', ms: 15_000 }, ran: { agent: 'tool:fixer', level: null, effort: null, model: null, runId: 'run-11' }, predicted: null, match: null },
      { jobId: 'jev-10', decider: 'jev', said: { agent: 'codex', effort: null, model: null, how: 'forced', ms: 40 }, ran: null, predicted: null, match: null },
    ],
    intent: { maturity: 'SHADOW', verified: 212, classes: { task: 190, question: 22 }, recent: { accuracy: 0.952, n: 100 }, needs: { samples: 750, perClass: 100, recentAccuracy: 0.94 } },
    names: { claude: 'Claude Code', codex: 'Codex' },
  }
  const asked = []
  let busy = 0
  const fetch = async (path) => {
    busy++
    try {
      asked.push(path)
      const body = path === '/jev-router/replies/summary' ? summary
        : path === '/jev-router/setup' ? { agents: [], providers: [], tools: [], jev: { configured: true, credentialRef: 'TYPESAFE_API_KEY' }, keysRestartPending: [] }
          : path === '/jev-router/chat-replies/settings' ? { waitMs: 15_000, progress: 'milestones', askWhenWrong: true } : {}
      const text = JSON.stringify(body)
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { SetupSection, ChatRepliesCard, HowJevRepliesCard, SortTable, howJevRepliesLines } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof HowJevRepliesCard, 'function', 'client.js has the How Jev replies card')
  const settle = async (view) => { for (let quiet = 0; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  const page = mount(SetupSection, {}, { shallow: true })
  await settle(page)
  const cards = page.tree.children
  assert.equal(cards[cards.findIndex((n) => n?.type === ChatRepliesCard) + 1]?.type, HowJevRepliesCard, 'the Jev setup page shows it after the Chat replies card')
  page.unmount()
  // The card behind the summary route. Shallow, because its table keeps state of its own.
  const card = mount(HowJevRepliesCard, {}, { shallow: true })
  await settle(card)
  assert.ok(asked.includes('/jev-router/replies/summary'))
  assert.equal(textOf(nodes(card.tree).find((n) => n.props.id === 'jevi-how-h')), 'How Jev replies')
  assert.deepEqual(card.tree.children.filter((n) => n?.type === 'div' && !n.props.className).map(textOf), [
    'Start replies: after routing (median 2.4 s this week)',
    'Task or question: learning, 212 of 750 checked examples (task 190, question 22 of 100 needed); 95% right of the last 100 checked (needs 94%).',
    'Agent and effort prediction: right 41 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).',
    'Under Laya Auto: right 18 of the last 20 (quick replies need 45; "likely" needs 16 of the last 20).',
  ])
  const table = nodes(card.tree).find((n) => n.type === SortTable)
  assert.ok(table, 'the recent replies are a table with a sort and a filter on every column')
  assert.deepEqual(table.props.columns.map((c) => c.label), ['Job', 'What it said', 'What ran', 'How', 'Rating'])
  assert.deepEqual(table.props.rows.map((r) => r.map((c) => c.text)), [
    ['jev-12', 'Claude Code · claude-opus-4-1 · effort high', 'Claude Code · claude-opus-4-1 · effort high', 'after routing', ''],
    ['jev-11', 'no agent named', 'the fixer tool', 'waited', ''],
    ['jev-10', 'Codex', 'not routed yet', 'your pick', ''],
  ])
  card.unmount()
  // Earlier and later on: nothing waited this week, nothing scored or trained yet, a rung that reads
  // tasks on this PC, and learning off.
  const early = { ...summary, startReplies: { medianMs: null, n: 0, days: 7 }, intent: { ...summary.intent, maturity: 'JEV_PRIMARY', verified: 3, classes: { task: 3 }, recent: null }, prediction: { ...summary.prediction, labelled: 12, trained: null } }
  assert.deepEqual(howJevRepliesLines(early), [
    'Start replies: after routing (none timed this week)',
    'Task or question: learning, 3 of 750 checked examples (task 3, question 0 of 100 needed); not scored yet.',
    'Agent and effort prediction: not trained yet; it starts once 60 routed tasks are on record (12 so far).',
    'Under Laya Auto: right 18 of the last 20 (quick replies need 45; "likely" needs 16 of the last 20).',
  ])
  const unscored = { decider: 'jev', of: 50, n: 0, right: 0 }
  assert.equal(howJevRepliesLines({ ...summary, prediction: { ...summary.prediction, records: { jev: { quick: unscored }, laya: { quick: { ...unscored, decider: 'laya' } } } } })[2], 'Agent and effort prediction: trained on 75 routed tasks; no guess has been checked yet (quick replies need 45; "likely" needs 16 of the last 20).')
  assert.equal(howJevRepliesLines({ ...summary, intent: { ...summary.intent, maturity: 'GUARDED_LOCAL', verified: 812 } })[1], 'Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 95% right of the last 100 checked.')
  assert.equal(howJevRepliesLines({ ...summary, learning: false, intent: null })[1], 'Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.')
})

/**
 * The How Jev replies card behind a stubbed GET /jev-router/replies/summary that answers `summary`,
 * shallow, since its table keeps state of its own, once it has settled; with client.js's test exports.
 */
async function howJevRepliesCard(summary) {
  let busy = 0
  const fetch = async (path) => {
    busy++
    try {
      const text = JSON.stringify(path === '/jev-router/replies/summary' ? summary : {})
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const lib = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof lib.HowJevRepliesCard, 'function', 'client.js has the How Jev replies card')
  const card = mount(lib.HowJevRepliesCard, {}, { shallow: true })
  for (let quiet = 0; quiet < 2; quiet = !busy && !card.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r))
  return { card, lib, why: textOf(nodes(card.tree).find((n) => n.props.className === 'why')), lines: card.tree.children.filter((n) => n?.type === 'div' && !n.props.className).map(textOf) }
}
const HOW_GATES = { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } }
const howScored = (decider, n, right) => ({ quick: { decider, of: 50, n, right }, likely: { decider, of: 20, n: Math.min(n, 20), right: Math.min(right, 20) } })

test('with learning off the How Jev replies card says nothing here learns: no start reply is timed or recorded, and the prediction is off, neither trained nor checked, whatever it learned before', async () => {
  // What GET /jev-router/replies/summary answers with routing.learn false (index.js repliesSummary):
  // no intent domain, and a ledger that records nothing.
  const off = {
    learning: false, startReplies: { medianMs: null, n: 0, days: 7 }, intent: null, recent: [], names: {},
    prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
  }
  const { card, lib, why, lines } = await howJevRepliesCard(off)
  assert.equal(why, 'A start reply names the agent once routing has picked it. Learning is switched off (routing.learn in the jev-router configuration), so nothing here learns, and no start reply is recorded.')
  assert.deepEqual(lines, [
    'Start replies: after routing (not timed while learning is off)',
    'Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.',
    'Agent and effort prediction: off while learning is off; nothing is recorded for it, so it does not train.',
  ], 'no count that cannot grow, and no promise that it starts')
  assert.equal(nodes(card.tree).find((n) => n.type === lib.SortTable)?.props.empty, 'No start reply is recorded while learning is off.')
  card.unmount()
  // Switched off after a predictor was trained and scored, with replies from before on record: what
  // they say is from before, so the card neither times them as this week's nor gives the old record.
  const before = {
    ...off, startReplies: { medianMs: 2400, n: 3, days: 7 },
    prediction: { ...off.prediction, labelled: 75, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 }, records: { jev: howScored('jev', 50, 41), laya: howScored('laya', 20, 18) } },
  }
  assert.deepEqual(lib.howJevRepliesLines(before), [
    'Start replies: after routing (not timed while learning is off)',
    'Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.',
    'Agent and effort prediction: off while learning is off; it was trained on 75 routed tasks before, and no guess is made or checked now.',
  ])
  // With learning on, the same figures are this week's and the predictor's own.
  assert.deepEqual(lib.howJevRepliesLines({ ...before, learning: true }), [
    'Start replies: after routing (median 2.4 s this week)',
    'Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.',
    'Agent and effort prediction: right 41 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).',
    'Under Laya Auto: right 18 of the last 20 (quick replies need 45; "likely" needs 16 of the last 20).',
  ])
})

test('the How Jev replies card says which replies the guess at the agent changes once its record keeps the gates, and that task or question changes one only once it is read on this PC, for a message it is sure is a task, which Jev is not asked about and so runs as work that writes, its quick reply instant', async () => {
  const on = {
    learning: true, startReplies: { medianMs: 2400, n: 3, days: 7 }, recent: [], names: {},
    intent: { maturity: 'GUARDED_LOCAL', verified: 812, classes: { task: 690, question: 122 }, recent: { accuracy: 0.952, n: 100 }, needs: { samples: 750, perClass: 100, recentAccuracy: 0.94 } },
    prediction: { gates: HOW_GATES, labelled: 75, minRows: 60, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 }, records: { jev: howScored('jev', 50, 41), laya: howScored('laya', 0, 0) } },
  }
  const { card, why, lines } = await howJevRepliesCard(on)
  assert.equal(why, 'A start reply names the agent once routing has picked it. Two things learn in the background to make that sooner: whether a message is a task or a question, read on this PC once it has been right often enough, and a guess at the agent and effort, checked against what routing then picks. Once the guess has been right 45 of the last 50 times, a task that starts at once is told the guessed agent before routing picks (a quick reply), and once right 16 of the last 20, a task that waits its turn is told the agent likely to run it. Routing still picks, and a pick it makes otherwise is said in a notice, even with Progress in chat at Start and result only, and asked about under the reply while Ask which was right is on. Task or question changes a reply only once it is read on this PC, and then only for a message it is sure is a task: Jev is not asked about that message, so it gets no read-only verdict and runs as work that writes, and a quick reply to it is instant, with no Jev call at all.')
  assert.equal(lines[1], 'Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 95% right of the last 100 checked.', 'the rung where it does, which the line beside it names')
  card.unmount()
})

test('with adaptive routing off the How Jev replies card opens by saying only the guess at the agent learns, as the line on task or question below it says: Jev reads every message, and nothing is learned from it', async () => {
  // What GET /jev-router/replies/summary answers with routing.enabled false and learning on
  // (index.js repliesSummary): no intent domain, and a ledger that still keeps each start reply.
  const off = {
    learning: true, startReplies: { medianMs: 2400, n: 3, days: 7 }, intent: null, recent: [], names: {},
    prediction: { gates: HOW_GATES, labelled: 75, minRows: 60, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 }, records: { jev: howScored('jev', 50, 41), laya: howScored('laya', 0, 0) } },
  }
  const { card, why, lines } = await howJevRepliesCard(off)
  assert.equal(why, 'A start reply names the agent once routing has picked it. A guess at the agent and effort learns in the background to make that sooner, checked against what routing then picks. Once the guess has been right 45 of the last 50 times, a task that starts at once is told the guessed agent before routing picks (a quick reply), and once right 16 of the last 20, a task that waits its turn is told the agent likely to run it. Routing still picks, and a pick it makes otherwise is said in a notice, even with Progress in chat at Start and result only, and asked about under the reply while Ask which was right is on. Task or question is not learned while adaptive routing is off (routing.enabled in the jev-router configuration): Jev reads every message.')
  assert.doesNotMatch(why, /whether a message is a task or a question|read on this PC/, 'no promise that task or question learns')
  assert.deepEqual(lines, [
    'Start replies: after routing (median 2.4 s this week)',
    'Task or question: Jev reads every message, and nothing is learned from it while adaptive routing or its learning is off.',
    'Agent and effort prediction: right 41 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).',
  ], 'the lines are as they were')
  card.unmount()
})

test('the How Jev replies card times the start replies whose wait for the pick ran out with those that named it, says how many ran out, and says replies go out at once when the wait for the pick is set to none', async () => {
  const base = { learning: true, intent: null, recent: [], names: {}, prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } } }
  // Routing slower than the wait all week: every reply went out when its wait ran out.
  const { card, lib, lines } = await howJevRepliesCard({ ...base, startReplies: { medianMs: 15_020, n: 3, atBound: 3, days: 7, waitMs: 15_000 } })
  assert.equal(lines[0], 'Start replies: after routing (median 15 s this week; 3 of 3 went out when the wait ran out, before the pick)')
  card.unmount()
  const first = (startReplies) => lib.howJevRepliesLines({ ...base, startReplies })[0]
  assert.equal(first({ medianMs: 9500, n: 4, atBound: 2, days: 7, waitMs: 15_000 }), 'Start replies: after routing (median 9.5 s this week; 2 of 4 went out when the wait ran out, before the pick)')
  assert.equal(first({ medianMs: 4200, n: 5, atBound: 0, days: 7, waitMs: 15_000 }), 'Start replies: after routing (median 4.2 s this week)')
  assert.equal(first({ medianMs: null, n: 0, atBound: 0, days: 7, waitMs: 15_000 }), 'Start replies: after routing (none timed this week)')
  // With the wait for the pick set to none, no reply waits for routing, whatever the week's replies did before.
  assert.equal(first({ medianMs: 4200, n: 5, atBound: 0, days: 7, waitMs: 0 }), 'Start replies: at once, without waiting for the pick (Reply at once, in Chat replies)')
  // The table says whose wait ran out.
  const recent = [{ jobId: 'jev-7', said: { agent: null, effort: null, model: null, how: 'bound', ms: 15_020 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1' } }]
  assert.deepEqual(lib.recentReplyRows({ ...base, recent, names: { claude: 'Claude Code' } }).map((r) => r.map((c) => c.text)), [['jev-7', 'no agent named', 'Claude Code · claude-opus-4-1 · effort high', 'wait ran out', '']])
})

test('at a rung where task or question is read on this PC, the How Jev replies card gives its recent accuracy without the bar it climbed past, which is not what keeps it there', async () => {
  const at = (maturity, accuracy, n, verified = 812) => ({
    learning: true, startReplies: { medianMs: 2400, n: 3, atBound: 0, days: 7, waitMs: 15_000 }, recent: [], names: {},
    intent: { maturity, verified, classes: { task: verified - 122, question: 122 }, recent: { accuracy, n }, needs: { samples: 750, perClass: 100, recentAccuracy: 0.94 } },
    prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
  })
  // Under the 94% it climbed past and over the 93% under which a rung starts to be lost: it keeps its rung.
  const { card, lib, lines } = await howJevRepliesCard(at('GUARDED_LOCAL', 0.932, 225))
  assert.equal(lines[1], 'Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 93% right of the last 225 checked.', 'no "needs 94%" beside a rung it holds')
  card.unmount()
  assert.equal(lib.howJevRepliesLines(at('LOCAL_ONLY', 0.931, 300))[1], 'Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 93% right of the last 300 checked.')
  // While it learns, the bar it needs is still the one to read on this PC.
  assert.equal(lib.howJevRepliesLines(at('SHADOW', 0.932, 225, 600))[1], 'Task or question: learning, 600 of 750 checked examples (task 478, question 122 of 100 needed); 93% right of the last 225 checked (needs 94%).')
})

test('the How Jev replies card never rounds the recent accuracy of task or question up to a bar it misses: 211 right of the last 225 reads 93% beside a need of 94%, as the domain holds the share itself to the bar, and a bar set between two whole percents is given as set', async () => {
  const at = (maturity, accuracy, n, recentAccuracy = 0.94) => ({
    learning: true, startReplies: { medianMs: 2400, n: 3, atBound: 0, days: 7, waitMs: 15_000 }, recent: [], names: {},
    intent: { maturity, verified: 760, classes: { task: 640, question: 120 }, recent: { accuracy, n }, needs: { samples: 750, perClass: 100, recentAccuracy } },
    prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
  })
  // 93.8% right: under the 94% domains.js gatesOf holds the share to, so the domain stays at SHADOW
  // with every other figure met.
  const { card, lib, lines } = await howJevRepliesCard(at('SHADOW', 211 / 225, 225))
  assert.equal(lines[1], 'Task or question: learning, 760 of 750 checked examples (task 640, question 120 of 100 needed); 93% right of the last 225 checked (needs 94%).')
  card.unmount()
  const right = (maturity, accuracy, n, bar) => lib.howJevRepliesLines(at(maturity, accuracy, n, bar))[1].split('; ').at(-1)
  // A share at the bar reads as the bar, and a share that is a whole percent is never cut below it.
  assert.equal(right('SHADOW', 141 / 150, 150), '94% right of the last 150 checked (needs 94%).')
  assert.equal(right('SHADOW', 282 / 300, 300), '94% right of the last 300 checked (needs 94%).')
  assert.equal(right('SHADOW', 57 / 100, 100), '57% right of the last 100 checked (needs 94%).')
  // A bar a policy sets between two whole percents is given as set, and the share to the same tenth.
  assert.equal(right('SHADOW', 377 / 400, 400, 0.945), '94.2% right of the last 400 checked (needs 94.5%).')
  assert.equal(right('SHADOW', 189 / 200, 200, 0.945), '94.5% right of the last 200 checked (needs 94.5%).')
  // At a rung where it is read on this PC no bar follows it, and it is still never rounded up.
  assert.equal(right('GUARDED_LOCAL', 211 / 225, 225), '93% right of the last 225 checked.')
})

test('the How Jev replies card says nothing ran for a reply whose task ended before routing picked anything, and how it ended, and says not routed yet only while its task is still to run', async () => {
  const none = { agent: null, effort: null, model: null }
  const summary = {
    learning: true, startReplies: { medianMs: 2400, n: 3, atBound: 1, days: 7, waitMs: 15_000 }, intent: null, names: { claude: 'Claude Code' },
    prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
    // What GET /jev-router/replies/summary answers (index.js repliesSummary): `ended` is the final
    // state of the reply's task, true for one no longer on the task list, and null while it is live.
    recent: [
      { jobId: 'jev-9', said: { ...none, how: 'waited', ms: 40 }, ran: null, ended: 'stopped' },
      { jobId: 'jev-8', said: { ...none, how: 'bound', ms: 15_010 }, ran: null, ended: 'needs_human' },
      { jobId: 'jev-7', said: { ...none, how: 'waited', ms: 30 }, ran: null, ended: true },
      { jobId: 'jev-6', said: { ...none, how: 'waited', ms: 20 }, ran: null, ended: null },
      { jobId: 'jev-5', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'routed', ms: 2400 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1' }, ended: 'completed' },
    ],
  }
  const { card, lib } = await howJevRepliesCard(summary)
  const table = nodes(card.tree).find((n) => n.type === lib.SortTable)
  assert.deepEqual(table?.props.rows.map((r) => r.map((c) => c.text)), [
    ['jev-9', 'no agent named', 'nothing ran (Stopped)', 'waited', ''],
    ['jev-8', 'no agent named', 'nothing ran (Needs input)', 'wait ran out', ''],
    ['jev-7', 'no agent named', 'nothing ran', 'waited', ''],
    ['jev-6', 'no agent named', 'not routed yet', 'waited', ''],
    ['jev-5', 'Claude Code · claude-opus-4-1 · effort high', 'Claude Code · claude-opus-4-1 · effort high', 'after routing', ''],
  ], 'stopped as it waited, read as needing a person once its wait ran out, gone from the task list, still waiting, and routed and done')
  card.unmount()
})

test('the How Jev replies card says a prediction not trained yet is training while its first training runs, and that one that failed is tried again after more routed tasks, never that it starts once 60 are on record beside more than 60', async () => {
  const base = { learning: true, startReplies: { medianMs: 2400, n: 3, atBound: 0, days: 7, waitMs: 15_000 }, intent: null, recent: [], names: {} }
  const untrained = (over) => ({ ...base, prediction: { gates: HOW_GATES, labelled: 70, minRows: 60, retrainEvery: 25, training: false, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) }, ...over } })
  // What the summary says as the ledger trains on the seventy it read after a start with no predictor saved.
  const { card, lib, lines } = await howJevRepliesCard(untrained({ training: true }))
  assert.equal(lines[2], 'Agent and effort prediction: not trained yet; it is training now, on the routed tasks on record (70 so far).')
  card.unmount()
  assert.equal(lib.howJevRepliesLines(untrained({}))[2], 'Agent and effort prediction: not trained yet; its training failed, and it is tried again after 25 more routed tasks (70 so far).')
  assert.equal(lib.howJevRepliesLines(untrained({ labelled: 12 }))[2], 'Agent and effort prediction: not trained yet; it starts once 60 routed tasks are on record (12 so far).')
})

test('the How Jev replies card never says no guess has been checked beside a record of Laya\'s: a predictor trained with none of Jev\'s guesses checked yet says that of Jev Auto alone, above the record of Laya\'s guesses', async () => {
  // Someone who routes on Laya Auto only: the predictor trained on Laya's picks, and twenty of its
  // guesses scored against them, with no task routed under Jev yet. Laya records no intent sample.
  const summary = {
    learning: true, startReplies: { medianMs: 1200, n: 20, atBound: 0, days: 7, waitMs: 15_000 }, recent: [], names: {},
    intent: { maturity: 'JEV_PRIMARY', verified: 0, classes: {}, recent: null, needs: { samples: 750, perClass: 100, recentAccuracy: 0.94 } },
    prediction: { gates: HOW_GATES, labelled: 75, minRows: 60, retrainEvery: 25, training: false, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 }, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 20, 18) } },
  }
  const { card, lib, lines } = await howJevRepliesCard(summary)
  assert.deepEqual(lines.slice(2), [
    'Agent and effort prediction: trained on 75 routed tasks; no guess under Jev Auto has been checked yet (quick replies need 45; "likely" needs 16 of the last 20).',
    'Under Laya Auto: right 18 of the last 20 (quick replies need 45; "likely" needs 16 of the last 20).',
  ], 'none of Jev\'s checked, and twenty of Laya\'s')
  assert.ok(!lines.some((l) => l.includes('no guess has been checked yet')), lines.join('\n'))
  card.unmount()
  // With no guess of either checked yet, none has been.
  const neither = { ...summary, prediction: { ...summary.prediction, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } } }
  assert.deepEqual(lib.howJevRepliesLines(neither).slice(2), ['Agent and effort prediction: trained on 75 routed tasks; no guess has been checked yet (quick replies need 45; "likely" needs 16 of the last 20).'])
})

test('the How Jev replies card says a start reply that went out at once beside a task that starts at once went out at once, as its first line says replies do with the wait for the pick set to none, and never that it waited', async () => {
  const none = { agent: null, effort: null, model: null }
  const summary = {
    learning: true, startReplies: { medianMs: null, n: 0, atBound: 0, days: 7, waitMs: 0 }, intent: null, names: { claude: 'Claude Code' },
    prediction: { gates: HOW_GATES, labelled: 0, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
    // What GET /jev-router/replies/summary answers (index.js repliesSummary): `now` for a reply that
    // went out at once beside a task that starts at once, `waited` for one whose task waits its turn.
    recent: [
      { jobId: 'jev-3', said: { ...none, how: 'waited', ms: 30 }, ran: null, ended: null },
      { jobId: 'jev-2', said: { ...none, how: 'now', ms: 20 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1' }, ended: null },
    ],
  }
  const { card, lib, lines } = await howJevRepliesCard(summary)
  assert.equal(lines[0], 'Start replies: at once, without waiting for the pick (Reply at once, in Chat replies)')
  const table = nodes(card.tree).find((n) => n.type === lib.SortTable)
  assert.deepEqual(table?.props.rows.map((r) => r.map((c) => c.text)), [
    ['jev-3', 'no agent named', 'not routed yet', 'waited', ''],
    ['jev-2', 'no agent named', 'Claude Code · claude-opus-4-1 · effort high', 'at once', ''],
  ], 'one whose task waits its turn, and one that went out at once')
  card.unmount()
})

// ---------- your ratings of the replies' picks (docs/live-agent-view.md Feature 4, slice 6) ----------
test('the How Jev replies card counts your ratings of the replies\' picks, lists what the newest changed, and gives each reply\'s rating in its table', async () => {
  const summary = {
    learning: true,
    startReplies: { medianMs: 2400, n: 1, days: 7 },
    prediction: { gates: HOW_GATES, labelled: 3, minRows: 60, trained: null, records: { jev: howScored('jev', 0, 0), laya: howScored('laya', 0, 0) } },
    ratings: { liked: 12, disliked: 3, changed: [{ jobId: 'jev-4', line: 'Learned: this run\'s task type is marked wrong for the local classifier.' }, { jobId: 'jev-2', line: 'Saved. It is applied when jev-2 ends.' }] },
    recent: [
      { jobId: 'jev-4', decider: 'jev', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'routed', ms: 2400 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1', runId: 'run-4' }, verdict: { verdict: 'dislike', tag: 'misread my question' } },
      { jobId: 'jev-3', decider: 'jev', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'routed', ms: 2400 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1', runId: 'run-3' }, verdict: { verdict: 'like', tag: null } },
      { jobId: 'jev-1', decider: 'jev', said: { agent: null, effort: null, model: null, how: 'waited', ms: 15_000 }, ran: null, verdict: null },
    ],
    intent: null,
    names: { claude: 'Claude Code' },
  }
  const { card, lib, lines } = await howJevRepliesCard(summary)
  assert.equal(typeof lib.ratingChanges, 'function', 'client.js lists what your ratings changed')
  assert.equal(lines.at(-1), 'Your ratings on replies: 12 liked, 3 disliked')
  const all = nodes(card.tree)
  const heading = all.findIndex((n) => n.props?.className === 'label' && textOf(n) === 'What it changed')
  assert.ok(heading > 0, 'What it changed has a heading of its own')
  assert.deepEqual(all.filter((n) => n.props?.className === 'muted').map(textOf), ['jev-4: Learned: this run\'s task type is marked wrong for the local classifier.', 'jev-2: Saved. It is applied when jev-2 ends.'])
  const table = all.find((n) => n.type === lib.SortTable)
  assert.deepEqual(table.props.rows.map((r) => r.at(-1).text), ['Disliked: misread my question', 'Liked', ''])
  assert.equal(lib.howJevRepliesLines({ ...summary, ratings: { liked: 0, disliked: 0, changed: [] } }).some((l) => l.startsWith('Your ratings')), false, 'no ratings, no line')
  card.unmount()
})

test('the How Jev replies card shows when each reply the guess earns switches on: quick replies on, with instant ones while task or question is read on this PC, paused at 43 of 50, the likely agent on or paused, Laya\'s apart, and a first line saying replies can go out before routing', async () => {
  // What GET /jev-router/replies/summary answers once the record kept its gates (reply-ledger.js
  // gateState): Jev's quick replies on and its likely agent paused, Laya's quick replies paused at 43
  // of 50 and its likely agent on.
  const record = (decider, right, likelyRight) => ({ quick: { decider, of: 50, n: 50, right }, likely: { decider, of: 20, n: 20, right: likelyRight } })
  const summary = {
    learning: true, startReplies: { medianMs: 2400, n: 3, atBound: 0, days: 7, waitMs: 15_000 }, names: { claude: 'Claude Code', codex: 'Codex' },
    intent: { maturity: 'GUARDED_LOCAL', verified: 812, classes: { task: 690, question: 122 }, recent: { accuracy: 0.952, n: 100 }, needs: { samples: 750, perClass: 100, recentAccuracy: 0.94 } },
    prediction: {
      gates: HOW_GATES, labelled: 75, minRows: 60, trained: { at: '2026-09-30T10:00:00.000Z', rows: 75 },
      records: { jev: record('jev', 47, 15), laya: record('laya', 43, 18) },
      states: { jev: { quick: 'on', likely: 'paused' }, laya: { quick: 'paused', likely: 'on' } },
    },
    recent: [
      { jobId: 'jev-7', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'instant', ms: 40 }, ran: { agent: 'claude', level: 'high', effort: 'high', model: 'claude-opus-4-1' }, ended: null },
      { jobId: 'jev-6', said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1', how: 'quick', ms: 1900 }, ran: { agent: 'codex', level: 'medium', effort: 'medium', model: 'gpt-5.5' }, ended: null },
      { jobId: 'jev-5', said: { agent: 'codex', effort: 'medium', model: 'gpt-5.5', how: 'likely', ms: 30 }, ran: null, ended: null },
    ],
  }
  const { card, lib, lines } = await howJevRepliesCard(summary)
  assert.deepEqual(lines, [
    'Start replies: before routing when the guess has earned it, else after routing (median 2.4 s this week)',
    'Task or question: read on this PC when it is sure a message is a task, and by Jev otherwise (812 checked examples); 95% right of the last 100 checked.',
    'Agent and effort prediction: right 47 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).',
    'Quick replies on: right 47 of the last 50, so a task that starts at once is told the guessed agent before routing picks.',
    'Instant replies on: a message read on this PC as a task gets its reply with no Jev call.',
    '"Likely" paused: right 15 of the last 20 (it needs 16), so a reply that waits names no agent again.',
    'Under Laya Auto: right 43 of the last 50 (quick replies need 45; "likely" needs 16 of the last 20).',
    'Under Laya Auto, quick replies paused: right 43 of the last 50 (they need 45), so replies wait for routing again.',
    'Under Laya Auto, "likely" on: right 18 of the last 20, so a task that waits its turn is told the agent likely to run it.',
  ])
  const table = nodes(card.tree).find((n) => n.type === lib.SortTable)
  assert.deepEqual(table.props.rows.map((r) => [r[0].text, r[1].text, r[2].text, r[3].text]), [
    ['jev-7', 'Claude Code · claude-opus-4-1 · effort high', 'Claude Code · claude-opus-4-1 · effort high', 'instant'],
    ['jev-6', 'Claude Code · claude-opus-4-1 · effort high', 'Codex · gpt-5.5 · effort medium', 'quick'],
    ['jev-5', 'Codex · gpt-5.5 · effort medium', 'not routed yet', 'likely'],
  ])
  card.unmount()
  // Quick replies on while task or question still learns: no instant reply yet; and with adaptive routing off, none at all.
  const learning = { ...summary, intent: { ...summary.intent, maturity: 'SHADOW', verified: 212 } }
  assert.ok(lib.howJevRepliesLines(learning).includes('Instant replies: not until task or question is read on this PC.'))
  assert.ok(lib.howJevRepliesLines({ ...summary, intent: null }).includes('Instant replies: none while adaptive routing is off, since Jev reads every message.'))
  // Nothing switched on yet, or learning off: the lines are as they were.
  const never = { ...summary, prediction: { ...summary.prediction, states: { jev: { quick: 'off', likely: 'off' }, laya: { quick: 'off', likely: 'off' } } } }
  assert.equal(lib.howJevRepliesLines(never)[0], 'Start replies: after routing (median 2.4 s this week)')
  assert.equal(lib.howJevRepliesLines(never).length, 4)
})

test('Settings, Effort names what your ratings moved, with Reset, and Let my ratings move Auto effort, whose save sends nothing of what was read with it', async () => {
  const posted = []
  let effort = { default: 'auto', perAgent: {}, codexSpeed: 'normal', ratingsMove: true, learned: [{ family: 'codex', taskType: 'debugging', shift: 1, agree: 3, n: 4, text: 'Learned from your ratings: Codex Auto effort one step higher for debugging (3 of your last 4 "wrong effort" ratings).' }] }
  let busy = 0
  const fetch = async (path, init) => {
    busy++
    try {
      if (init?.method === 'POST') posted.push([path, JSON.parse(init.body)])
      if (path === '/jev-router/effort/ratings-reset') effort = { ...effort, ratingsResetAt: '2026-10-01T10:00:00.000Z', learned: [] }
      else if (path === '/jev-router/effort' && init?.method === 'POST') { const { learned: _l, ...saved } = { ...effort, ...JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => saved } }
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(path.startsWith('/jev-router/effort') ? effort : {})) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const lib = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  assert.equal(typeof lib.ratedEffortLines, 'function', 'client.js says what your ratings moved')
  const card = mount(lib.EffortCard, {}, { shallow: true })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !card.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const all = () => nodes(card.tree)
  assert.deepEqual(all().filter((n) => n.props?.className === 'muted').map(textOf), ['Learned from your ratings: Codex Auto effort one step higher for debugging (3 of your last 4 "wrong effort" ratings).'])
  const toggle = all().find((n) => n.type === 'input' && n.props['aria-label'] === 'Let my ratings move Auto effort')
  assert.equal(toggle.props.checked, true, 'on by default')
  toggle.props.onChange({ target: { checked: false } })
  await settle()
  assert.deepEqual(posted.at(-1), ['/jev-router/effort', { default: 'auto', perAgent: {}, codexSpeed: 'normal', ratingsMove: false }], 'what was learned is never sent back')
  assert.match(all().filter((n) => n.props?.className === 'muted').map(textOf).at(-1), /does not follow these while Let my ratings move Auto effort is off/)
  all().find((n) => n.type === 'button' && textOf(n) === 'Reset').props.onClick()
  await settle()
  assert.equal(posted.at(-1)[0], '/jev-router/effort/ratings-reset')
  assert.deepEqual(all().filter((n) => n.props?.className === 'muted').map(textOf), [], 'after Reset nothing is moved by the ratings before it')
  assert.equal(all().some((n) => n.type === 'button' && textOf(n) === 'Reset'), false)
  card.unmount()
})

test('Settings, Effort has Claude Code speed beside Codex speed, says Fast costs more whichever way it is set, and saves claudeSpeed', async () => {
  const posted = []
  let effort = { default: 'auto', perAgent: {}, codexSpeed: 'normal', claudeSpeed: 'normal', ratingsMove: true, learned: [] }
  let busy = 0
  const fetch = async (path, init) => {
    busy++
    try {
      if (init?.method === 'POST') { posted.push([path, JSON.parse(init.body)]); effort = { ...effort, ...JSON.parse(init.body) } }
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(path.startsWith('/jev-router/effort') ? effort : {})) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const lib = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  const card = mount(lib.EffortCard, {}, { shallow: true })
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !card.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const all = () => nodes(card.tree)
  const terms = all().filter((n) => n.type === 'dt').map(textOf)
  assert.ok(terms.includes('Claude Code speed'), 'the card has the setting')
  assert.equal(terms.indexOf('Claude Code speed'), terms.indexOf('Codex speed') + 1, 'beside Codex speed')
  const toggle = () => all().find((n) => n.type === 'input' && n.props['aria-label'] === 'Claude Code fast mode')
  const costs = () => all().filter((n) => n.props?.className === 'why' && /costs more/.test(textOf(n))).map(textOf)
  assert.equal(toggle().props.checked, false, 'Normal by default')
  assert.equal(costs().length, 1, 'the cost is said before Fast is chosen')
  assert.match(costs()[0], /usage credits/)
  toggle().props.onChange({ target: { checked: true } })
  await settle()
  assert.deepEqual(posted.at(-1), ['/jev-router/effort', { default: 'auto', perAgent: {}, codexSpeed: 'normal', claudeSpeed: 'fast', ratingsMove: true }])
  assert.equal(toggle().props.checked, true)
  assert.ok(all().some((n) => n.type === 'label' && /Fast \(costs more\)/.test(textOf(n))), 'and the switch says it once on')
  assert.equal(costs().length, 1)
})

test('the Chat replies card switches the ask under a reply whose plan changed back on, or off, as Don\'t ask me this does', async () => {
  const { validChatReplies } = await import('../index.js')
  let saved = { waitMs: 15_000, progress: 'milestones', askWhenWrong: false }
  const posts = []
  let busy = 0
  const fetch = async (path, init) => {
    busy++
    try {
      if (path === '/jev-router/chat-replies/settings' && init?.method === 'POST') { posts.push(JSON.parse(init.body)); saved = validChatReplies(JSON.parse(init.body), saved) }
      const text = JSON.stringify(path === '/jev-router/chat-replies/settings' ? saved : {})
      return { ok: true, status: 200, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const document = { hidden: false, getElementById: () => ({}), head: { appendChild() {} } }
  const { ChatRepliesCard } = loadPlugin(React, { fetch, document, setInterval: () => 0, clearInterval: () => {} }).__test
  const card = mount(ChatRepliesCard, {})
  const settle = async () => { for (let quiet = 0; quiet < 2; quiet = !busy && !card.queued ? quiet + 1 : 0) await new Promise((r) => setImmediate(r)) }
  await settle()
  const toggle = () => nodes(card.tree).find((n) => n.type === 'input' && n.props['aria-label'] === 'Ask which was right when what ran is not what the reply said')
  assert.ok(toggle(), 'the card has the ask\'s switch')
  assert.equal(toggle().props.checked, false, 'off, as Don\'t ask me this left it')
  toggle().props.onChange({ target: { checked: true } })
  await settle()
  assert.deepEqual(posts, [{ askWhenWrong: true }])
  assert.equal(toggle().props.checked, true)
  card.unmount()
})

// ---------------------------------------------------------------- colibri Laya, side by side (13)

/** The card's colibri lines, from the helper block on its own; a block without them fails by assertion. */
function colibriLines(figures) {
  const start = client.indexOf('// ---- pure laya helpers')
  const end = client.indexOf('// ---- end pure laya helpers')
  const block = client.slice(start, end)
  assert.match(block, /function colibriLines\(/, 'the Laya helpers say what colibri compared')
  return new Function(`${block}\nreturn colibriLines`)()(figures)
}

/** The colibri figures as GET /jev-router/laya carries them (colibri-laya.js summary()). */
const COLIBRI_FIGURES = {
  on: true, address: 'http://127.0.0.1:8000', used: false, file: 'colibri-laya.jsonl',
  reachable: { ok: true, why: null, checkedAt: '2026-10-10T08:00:00.000Z', ms: 230, model: 'laya', checking: false, how: "one test question, since colibri's /health lists no loaded model" },
  compared: { requests: 12, partial: 0, questions: 87, since: '2026-10-10T08:00:01.000Z' },
  failed: { timeout: 1, unreachable: 0, refused: 0, bad_answer: 0 },
  dropped: { busy: 3, local_busy: 0, laya_busy: 0, not_reachable: 0 },
  agreement: { choice: { compared: 40, agreed: 38 }, score: { compared: 10, agreed: 9, tolerance: 0.5 }, noul: { compared: 37, agreed: 30 } },
  medianMs: { laya: 1300, colibri: 700 },
  rawNouls: 37,
  confidenceUnknown: 37,
}

test('colibri Laya, side by side (13): whether colibri answers or why not, what was compared, agreement with laya.serve by question type, the median time of each, colibri\'s three gaps, and that nothing it answers is used', () => {
  const lines = colibriLines(COLIBRI_FIGURES)
  assert.deepEqual(lines.map((l) => l.text), [
    "Reachable: colibri answered its test question in 0.2 s as laya. KzH checks it with one test question, since colibri's /health lists no loaded model.",
    'Compared 87 questions in 12 requests since 2026-10-10. Not answered: 1 past its deadline. Not asked since KzH started: 3 while colibri was answering another.',
    'Agreement with laya.serve: choice 38 of 40 (95%), score 9 of 10 (90%) within 0.5 of a level and yes/no 30 of 37 (81%).',
    'Median time per request: laya.serve 1.3 s, colibri 0.7 s.',
    'Yes/no questions go to colibri as KzH sends them, labels and all; colibri ignores the labels, so it reads each in its raw false/true form, unlike laya.serve (37 so far).',
    'colibri gives a yes/no answer no confidence: each is recorded as unknown and left out of every figure that needs one (37 so far).',
    'Nothing colibri answers is used: it decides nothing, and nothing learns from it. Its answers are kept in colibri-laya.jsonl only.',
  ])
  assert.deepEqual(lines.map((l) => l.tone), ['', 'why', '', 'why', 'why', 'why', 'note'])

  // Not reachable, with why; and while it is being asked, or not asked yet.
  const why = 'nothing answers at http://127.0.0.1:8000: start colibri with its Laya engine, or empty the address'
  const down = colibriLines({ ...COLIBRI_FIGURES, reachable: { ok: false, why } })
  assert.deepEqual(down[0], { text: `Not reachable: ${why}. KzH checks it with one test question, since colibri's /health lists no loaded model.`, tone: 'warn' })
  assert.match(colibriLines({ ...COLIBRI_FIGURES, reachable: { ok: null, checking: true } })[0].text, /^Asking colibri its test question…/)
  assert.match(colibriLines({ ...COLIBRI_FIGURES, reachable: { ok: null } })[0].text, /^Not checked yet\./)
  // A server on the address that names another model than Laya is said so.
  assert.deepEqual(colibriLines({ ...COLIBRI_FIGURES, reachable: { ok: true, ms: 900, model: 'qwen36' } })[1], { text: "colibri says it serves qwen36, not Laya: start it with Laya's model, as its docs/laya.md says.", tone: 'warn' })

  // Nothing compared yet: no agreement and no time, and the gaps and the rule still said.
  const fresh = colibriLines({ ...COLIBRI_FIGURES, compared: { requests: 0, partial: 0, questions: 0, since: null }, failed: {}, dropped: {}, agreement: { choice: { compared: 0, agreed: 0 }, score: { compared: 0, agreed: 0, tolerance: 0.5 }, noul: { compared: 0, agreed: 0 } }, medianMs: { laya: null, colibri: null }, rawNouls: 0, confidenceUnknown: 0 })
  assert.deepEqual(fresh.map((l) => l.text.split(/[:;]/)[0]), ['Reachable', 'Nothing compared yet', 'Yes/no questions go to colibri as KzH sends them, labels and all', 'colibri gives a yes/no answer no confidence', 'Nothing colibri answers is used'])
  assert.ok(fresh.every((l) => !l.text.includes('so far')), 'no count of nothing')
  // A share is never rounded up: 199 of 200 is 99%.
  assert.match(colibriLines({ ...COLIBRI_FIGURES, agreement: { choice: { compared: 200, agreed: 199 } } })[2].text, /choice 199 of 200 \(99%\)/)
  // Each way a request went unanswered is named, an answer KzH could not read among them, and each
  // reason one was not asked, a request laya.serve had more after on the CPU among them.
  assert.match(colibriLines({ ...COLIBRI_FIGURES, failed: { timeout: 0, unreachable: 1, refused: 2, bad_answer: 1 } })[1].text, / Not answered: 2 refused by colibri, 1 cut off and 1 answered in a shape KzH could not read\. Not asked /)
  assert.match(colibriLines({ ...COLIBRI_FIGURES, dropped: { busy: 0, local_busy: 1, laya_busy: 4, not_reachable: 0 } })[1].text, / Not asked since KzH started: 1 while a local model was answering and 4 while laya\.serve had more to answer on the CPU\.$/)
  // No address, no section.
  assert.deepEqual(colibriLines({ ...COLIBRI_FIGURES, on: false }), [])
})

test('the card has the colibri Laya address among Laya\'s settings: empty is off and shows no section; it saves as typed, less the spaces around it; a refused one is shown as the server words it; once set the card shows colibri Laya, side by side (13)', async () => {
  const page = await card(status(), {
    replies: { '/jev-router/laya/settings': (sent) => { page.status = status({ settings: { ...page.status.settings, ...sent }, colibri: { ...COLIBRI_FIGURES, address: sent.colibriUrl } }) } },
  })
  const field = page.input('jevi-laya-colibri')
  assert.ok(field, 'the colibri Laya address field')
  assert.deepEqual([field.props.value, field.props.placeholder], ['', 'http://127.0.0.1:8000'])
  assert.match(page.text(), /colibri Laya address/)
  assert.match(page.text(), /Empty is off\. The address of a colibri you run yourself on this PC with its Laya engine/)
  assert.ok(!page.text().includes('colibri Laya, side by side'), 'no section while it is empty')
  field.props.onChange({ target: { value: ' http://127.0.0.1:8000 ' } })
  await page.settle()
  await page.input('jevi-laya-colibri').props.onBlur()
  await page.settle()
  assert.deepEqual(page.posts, [['/jev-router/laya/settings', { colibriUrl: 'http://127.0.0.1:8000' }]])
  assert.equal(page.input('jevi-laya-colibri').props.value, 'http://127.0.0.1:8000', 'the saved value, reloaded')
  const section = page.all().find((n) => n.type === 'section' && n.props['aria-labelledby'] === 'jevi-laya-colibri-h')
  assert.ok(section, 'the section, once the address is set')
  assert.deepEqual(section.children.slice(1).map(textOf), colibriLines(COLIBRI_FIGURES).map((l) => l.text), 'with the lines of the figures the status carries')
  assert.equal(textOf(section.children[0]), 'colibri Laya, side by side')
  page.close()

  const strict = await card(status(), { replies: { '/jev-router/laya/settings': { code: 400, body: { error: 'colibri Laya address: this PC only (127.0.0.1, localhost or [::1]), not 192.168.1.20' } } } })
  strict.input('jevi-laya-colibri').props.onChange({ target: { value: 'http://192.168.1.20:8000' } })
  await strict.settle()
  await strict.input('jevi-laya-colibri').props.onBlur()
  await strict.settle()
  assert.deepEqual(strict.alerts(), ['colibri Laya address: this PC only (127.0.0.1, localhost or [::1]), not 192.168.1.20'])
  assert.equal(strict.input('jevi-laya-colibri').props.value, '', 'the saved value, beside the refusal')
  strict.close()
})

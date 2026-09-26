// Local models and offline mode, with no network and no real llama-server:
// offline routing rule, local agent eligibility, the connectivity cache,
// llama-server arguments, verified resumable downloads, the wire format,
// and the resource budget the engine is started and watched under.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badgesOf, buildCatalog, contextSteps, defaultThreads, estimateMemory, parsePsRss, parseTasklistMemory, workingSetOf, kvGbPerToken, readMemoryUsage, createConnectivity, createLocalModels, defaultsFor, detectSpecs, downloadVerified, installLlmCommand, llamaArgs, localAdapter, looksLikeQuestion, offlinePick, parseLlmArgs, pickEngineVariant, rateModule, readManifest, removeLlmCommand, specsLine, suggest, toWire, translate } from '../local.js'
import { fileURLToPath } from 'node:url'
// A namespace as well, for what the speed benchmark adds to local.js (docs/benchmark.md 5): the file
// then still loads where local.js lacks it, and each of those tests fails by its own assertion.
import * as localJs from '../local.js'
import { waitFor } from './wait-for.js'
import { answerOf, fakeLlamaServer } from './fixtures/fake-llama-server.mjs'
import { formatReport, runRouted } from '../router.js'
import { kindOf, keyProviderOf } from '../accounts.js'
import { jevAdapter } from '../adapter.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'jev-local-'))

// ---------- offline routing ----------
const config = {
  agents: [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
    { id: 'deepseek', provider: 'spawn', description: 'b', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
    // `role` as the manifest declares it: offline routing ranks by it, so the fixture carries it.
    { id: 'qwen-local', provider: 'spawn', description: 'c', enabled: true, kind: 'local', role: 'best-quality', llm: { provider: 'local', model: 'qwen3-8b' } },
    { id: 'gemma-local', provider: 'spawn', description: 'd', enabled: true, kind: 'local', role: 'fast', llm: { provider: 'local', model: 'gemma4-e4b' } },
  ],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 5 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
}
function repo() {
  const dir = tmp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}
const history = () => ({ recent: async () => [], append: async () => {} })
const signal = new AbortController().signal

test('offline: fixed rule picks qwen-local, never asks Jev, reviews with checks only, report says OFFLINE', async () => {
  const dir = repo()
  const ran = []
  const execute = async (a) => { ran.push(a.id); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'done' } }
  const r = await runRouted({ task: 'fix it', cwd: dir, config, signal, deps: { offline: true, jev: null, jevUnavailableReason: 'offline', execute, history: history() } })
  assert.equal(r.routing.mode, 'offline')
  assert.deepEqual(ran, ['qwen-local'])
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(r.assessments[0].mode, 'fallback')
  assert.match(formatReport(r), /OFFLINE: local models only/)
})

test('offline: gemma-local when qwen-local is not ready; cloud agents are never eligible', async () => {
  const dir = repo()
  const ran = []
  const execute = async (a) => { ran.push(a.id); return { stopReason: 'completed', answerText: 'x' } }
  const ready = { 'qwen-local': { loggedIn: false, detail: 'model file missing' }, claude: { loggedIn: true }, deepseek: { loggedIn: true }, 'gemma-local': { loggedIn: true } }
  const r = await runRouted({ task: 'explain', cwd: dir, config, signal, answerOnly: true, deps: { offline: true, ready, jev: null, execute, history: history() } })
  assert.equal(r.routing.primaryAgent, 'gemma-local')
  assert.ok(ran.every((id) => id === 'gemma-local'))
  await assert.rejects(runRouted({ task: 'x', cwd: dir, config, signal, forceAgent: 'claude', deps: { offline: true, jev: null, execute, history: history() } }), /needs the internet/)
  const none = { ...ready, 'gemma-local': { loggedIn: false, detail: 'missing' } }
  await assert.rejects(runRouted({ task: 'x', cwd: dir, config, signal, deps: { offline: true, ready: none, jev: null, execute, history: history() } }), /offline, and no local model is ready/)
})

test('online: local agents are ordinary agents Jev may pick', async () => {
  const dir = repo()
  let offered
  const jev = {
    route: async ({ agents }) => { offered = agents.map((a) => a.id); return { primaryAgent: 'gemma-local', agentConfidence: 0.9, agentProbabilities: {}, taskType: 'q', taskTypeConfidence: 1, complexity: 0.1, risk: 0.1, needsSecondOpinion: 0, needsHumanReview: 0, needsTests: 0 } },
    assess: async () => ({ addressed: 0.9, complete: 0.9, unrelatedChanges: 0, regressionRisk: 0, needsPerson: 0 }),
  }
  const r = await runRouted({ task: 'x', cwd: dir, config, signal, answerOnly: true, deps: { jev, execute: async () => ({ stopReason: 'completed', answerText: 'a' }), history: history() } })
  assert.deepEqual(offered, ['claude', 'deepseek', 'qwen-local', 'gemma-local'])
  assert.equal(r.attempts[0].agent, 'gemma-local')
})

test('offlinePick and question heuristic', () => {
  assert.equal(offlinePick(config.agents).id, 'qwen-local')
  assert.equal(offlinePick(config.agents.filter((a) => a.id !== 'qwen-local')).id, 'gemma-local')
  assert.equal(offlinePick(config.agents.filter((a) => a.kind !== 'local')), null)
  // A model no fixed list knows: its role alone puts it ahead of the faster one.
  const newer = { id: 'new-local', provider: 'spawn', description: 'e', enabled: true, kind: 'local', role: 'best-quality' }
  assert.equal(offlinePick([...config.agents.filter((a) => a.id === 'gemma-local'), newer]).id, 'new-local')
  assert.ok(looksLikeQuestion('how does login work'))
  assert.ok(looksLikeQuestion('the tests fail?'))
  assert.ok(!looksLikeQuestion('fix the failing test in users.ts'))
})

// ---------- manifest modules, install state, local agent eligibility ----------
const sha = (s) => createHash('sha256').update(s).digest('hex')
const MANIFEST_MODULES = [
  { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') },
  { id: 'eng-cpu', kind: 'engine', variant: 'cpu', name: 'cpu engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/c.zip', file: 'c.zip', size: 1, sha256: sha('c') },
  { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * 1024 ** 3, sha256: sha('big'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 8192, maxContext: 40960, agent: { id: 'big-local', description: 'big' } },
  { id: 'small', kind: 'model', name: 'Small', source: 'https://huggingface.co/Org/Small-GGUF/resolve/main/small.gguf', file: 'small.gguf', size: 3 * 1024 ** 3, sha256: sha('small'), reliability: 'official-stable', verified: true, role: 'fast', rank: 2, recommendedVramGB: 3.8, minRamGB: 8, contextSize: 8192, agent: { id: 'small-local', description: 'small' } },
  { id: 'exp', kind: 'model', name: 'Exp', source: 'https://huggingface.co/Org/Exp-GGUF/resolve/main/exp.gguf', file: 'exp.gguf', size: 1024 ** 3, sha256: sha('exp'), reliability: 'official-preview', verified: false, rank: 3, recommendedVramGB: 2 },
  { id: 'small-vision', kind: 'vision', for: 'small', name: 'Small vision', source: 'https://huggingface.co/Org/Small-GGUF/resolve/main/mmproj.gguf', file: 'mmproj.gguf', size: 1024 ** 3, sha256: sha('v'), reliability: 'official-stable', verified: false, role: 'vision-addon' },
]
function localIn(root, extra = {}) {
  const engineDir = join(root, 'engine'); const modelsDir = join(root, 'models')
  mkdirSync(engineDir, { recursive: true }); mkdirSync(modelsDir, { recursive: true })
  return { engineDir, modelsDir, local: createLocalModels({ modules: MANIFEST_MODULES, engineDir, modelsDir, settingsFile: join(root, 'local.json'), ...extra }) }
}

test('manifest: strict fields, official sources only; the repo manifest loads', () => {
  const dir = tmp()
  const write = (modules) => { const p = join(dir, `m${Math.random()}.json`); writeFileSync(p, JSON.stringify({ modules })); return p }
  assert.equal(readManifest(write(MANIFEST_MODULES)).length, 6)
  assert.throws(() => readManifest(write([{ ...MANIFEST_MODULES[2], source: 'https://huggingface.co.evil.com/x/y/resolve/main/big.gguf' }])), /official/)
  assert.throws(() => readManifest(write([{ ...MANIFEST_MODULES[2], source: 'http://huggingface.co/Org/Big/resolve/main/big.gguf' }])), /official/)
  assert.throws(() => readManifest(write([{ ...MANIFEST_MODULES[2], sha256: 'abc' }])), /sha256/)
  assert.throws(() => readManifest(write([{ ...MANIFEST_MODULES[2], file: '../big.gguf' }])), /file/)
  assert.throws(() => readManifest(write([MANIFEST_MODULES[5]])), /for:/)
  const real = readManifest(fileURLToPath(new URL('../../../config/local-models.json', import.meta.url)))
  assert.ok(real.some((m) => m.agent?.id === 'qwen-local') && real.some((m) => m.agent?.id === 'gemma-local'))
})

test('local agents: kind local, no key provider; they exist only once their model is installed and verified', async () => {
  const q = config.agents[2]
  assert.equal(kindOf(q), 'local')
  assert.equal(keyProviderOf(q), null)
  assert.equal(kindOf(config.agents[1]), 'api')
  const changes = []
  const { engineDir, modelsDir, local } = localIn(tmp(), { onChange: (m) => changes.push(m.id) })
  assert.deepEqual(await local.agents('p'), [])
  assert.match((await local.readiness('big')).detail, /engine not installed/)
  // Engine: exe plus a marker per module of one variant.
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  mkdirSync(join(engineDir, '.installed'))
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  assert.equal(await local.engineVariant(), 'cuda12')
  // A model placed by hand is hashed once in the background, then counts.
  writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  assert.equal((await local.status()).modules.find((m) => m.id === 'big').state, 'verifying')
  await local.settled()
  assert.equal((await local.status()).modules.find((m) => m.id === 'big').state, 'installed')
  assert.deepEqual(changes, ['big'])
  assert.deepEqual((await local.agents('p')).map((a) => [a.id, a.llm.provider, a.llm.model]), [['big-local', 'local', 'big']])
  assert.equal((await local.readiness('big')).loggedIn, true)
  assert.equal(await local.chatModel(), 'big')
  // A file whose hash differs from the manifest never counts.
  writeFileSync(join(modelsDir, 'small.gguf'), 'tampered')
  await local.status(); await local.settled()
  assert.equal((await local.status()).modules.find((m) => m.id === 'small').state, 'corrupt')
  assert.deepEqual((await local.agents('p')).map((a) => a.id), ['big-local'])
  // Removing deletes the file and its marker.
  await local.remove('big')
  assert.ok(!existsSync(join(modelsDir, 'big.gguf')))
  assert.deepEqual(await local.agents('p'), [])
  await local.dispose()
})

test('chat model default: the quickest installed model, not the first in the manifest', async () => {
  const { engineDir, modelsDir, local } = localIn(tmp())
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  mkdirSync(join(engineDir, '.installed'))
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  writeFileSync(join(modelsDir, 'small.gguf'), 'small')
  await local.installed() // schedules the background hash of the hand-placed files
  await local.settled()
  // `big` is first in the manifest and best-quality; `small` declares the fast role.
  assert.deepEqual((await local.installed()).map((m) => m.id), ['big', 'small'], 'manifest order')
  assert.equal(await local.chatModel(), 'small', 'a direct answer goes to the fast role, whatever the manifest order')
  // An explicit choice in Settings -> Jev setup -> Local models still wins over the default.
  await local.setSettings({ chatModel: 'big' })
  assert.equal(await local.chatModel(), 'big')
  await local.dispose()
})

// ---------- this PC ----------
const PC = {
  gpus: [{ name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramGB: 4 }, { name: 'Intel(R) UHD Graphics', vendor: 'intel', vramGB: 0 }],
  cuda: 12.7, ramGB: 23.7, cpu: { name: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 52 * 1024 ** 3,
}

test('detectSpecs: nvidia-smi, Win32_VideoController fallback, RAM, CPU, free disk (fake probe)', async () => {
  const run = async (cmd, args) => {
    if (cmd === 'nvidia-smi' && args.length) return 'NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 0, 566.07\n'
    if (cmd === 'nvidia-smi') return '| NVIDIA-SMI 566.07   Driver Version: 566.07   CUDA Version: 12.7 |'
    return 'NVIDIA GeForce RTX 3050 Laptop GPU|4293918720\nIntel(R) UHD Graphics|1073741824\nCORES|6\n'
  }
  const os = { totalmem: () => 24 * 1024 ** 3, freemem: () => 8 * 1024 ** 3, cpus: () => Array(12).fill({ model: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz' }) }
  const s = await detectSpecs({ dir: 'C:/Harness/models', probe: { run, os, statfs: async () => ({ bavail: 52 * 1024 ** 2, bsize: 1024 }) } })
  assert.equal(s.cuda, 12.7)
  assert.deepEqual(s.gpus.map((g) => [g.vendor, g.vramGB]), [['nvidia', 4], ['intel', 0]])
  assert.equal(s.cpu.cores, 6)
  assert.equal(specsLine(s), 'RTX 3050 Laptop 4 GB · 24 GB RAM · Core i5-11400H 6 cores · 52 GB free')
  const none = await detectSpecs({ dir: 'x', probe: { run: async () => null, os, statfs: async () => { throw new Error('no') } } })
  assert.deepEqual(none.gpus, [])
  assert.equal(none.diskFreeBytes, null)
  // With no nvidia-smi, AdapterRAM is all there is, and it is a 32-bit field: every card of 4 GB or
  // more reads 4293918720 bytes there. That figure is marked, since it is where the field stops and
  // not what the card has; a smaller card reads its own size and is not.
  const amd = await detectSpecs({ dir: 'x', probe: { run: async (cmd) => (cmd === 'powershell.exe' ? 'AMD Radeon RX 6600|4293918720\nAMD Radeon RX 550|2147483648\n' : null), os, statfs: async () => { throw new Error('no') } } })
  assert.deepEqual(amd.gpus.map((g) => [g.name, g.vramGB, !!g.sizeCapped]), [['AMD Radeon RX 6600', 4293918720 / 1024 ** 3, true], ['AMD Radeon RX 550', 2, false]])
  assert.equal(s.gpus.some((g) => g.sizeCapped), false, "nvidia-smi's size is the real one, whatever AdapterRAM says for the same card")
  // And the line that describes this PC says the size is unknown rather than print the ceiling as one.
  assert.equal(specsLine(amd), 'AMD Radeon RX 6600 (memory unknown, 4 GB or more) · 24 GB RAM · Core i5-11400H 12 threads')
})

test('engine build follows the hardware: CUDA 12/13 by driver, Vulkan for other GPUs, else CPU', () => {
  const mods = [...MANIFEST_MODULES, { ...MANIFEST_MODULES[0], id: 'e13', variant: 'cuda13', minCuda: 13.3 }, { ...MANIFEST_MODULES[1], id: 'vk', variant: 'vulkan' }]
  assert.equal(pickEngineVariant(PC, mods), 'cuda12')
  assert.equal(pickEngineVariant({ ...PC, cuda: 13.4 }, mods), 'cuda13')
  assert.equal(pickEngineVariant({ ...PC, cuda: 11.8 }, mods), 'vulkan')
  assert.equal(pickEngineVariant({ ...PC, gpus: [{ name: 'AMD Radeon', vendor: 'amd', vramGB: 8 }], cuda: null }, mods), 'vulkan')
  assert.equal(pickEngineVariant({ ...PC, gpus: [], cuda: null }, mods), 'cpu')
})

test('a rough memory estimate, before anything has run, that answers what a context size costs', () => {
  const [, , big] = MANIFEST_MODULES
  const ctx = 16384
  // Nothing on the GPU: the whole model sits in RAM and no desktop reserve is spent.
  const cpu = estimateMemory(big, { ctx, vramGB: 0 })
  assert.equal(cpu.vramGB, 0)
  assert.ok(cpu.ramGB > big.size / 1024 ** 3, 'the weights plus their context, so more than the file')
  assert.equal(cpu.source, 'estimated')
  // A bigger context costs only the KV cache, and costs it in proportion.
  const wide = estimateMemory(big, { ctx: ctx * 2, vramGB: 0 })
  assert.ok(wide.ramGB > cpu.ramGB)
  assert.ok(Math.abs((wide.ramGB - cpu.ramGB) - kvGbPerToken(big) * ctx) < 0.2, `${cpu.ramGB} -> ${wide.ramGB}`)
  // Room for all of it: everything on the GPU, and the desktop's reserve spent once.
  const roomy = estimateMemory(big, { ctx, vramGB: 64 })
  assert.equal(roomy.ramGB, 0)
  assert.equal(roomy.gpuFraction, 1)
  // Not enough room: it splits, and the two halves still add up to the whole model.
  const split = estimateMemory(big, { ctx, vramGB: 4 })
  assert.ok(split.vramGB > 0 && split.ramGB > 0, `${split.vramGB} / ${split.ramGB}`)
  assert.ok(split.gpuFraction > 0 && split.gpuFraction < 1)
  assert.ok(Math.abs(split.totalGB - (split.vramGB + split.ramGB)) < 0.15)
  // A reading from a run that really happened is not an estimate and does not pretend to be one.
  const real = estimateMemory(big, { ctx, vramGB: 4, measured: { vramGB: 3.2, ramGB: 1.1 } })
  assert.deepEqual([real.vramGB, real.ramGB, real.source], [3.2, 1.1, 'measured'])
})

test('what the engine reports it took is read back per device, and says nothing until it has', () => {
  // The engine names the device holding each buffer, so the split between the GPU and RAM is read
  // rather than worked out: anything on a device called CPU is RAM, everything else is the GPU.
  const lines = [
    'load_tensors:        CUDA0 model buffer size =  4437.23 MiB',
    'load_tensors:   CPU_Mapped model buffer size =   512.00 MiB',
    'llama_kv_cache:      CUDA0 KV buffer size =   736.00 MiB',
    'llama_context:       CUDA0 compute buffer size =   304.00 MiB',
    'llama_context:        CPU compute buffer size =    24.01 MiB',
    'srv    load_model: loading model',
  ]
  assert.deepEqual(readMemoryUsage(lines), { vramGB: 5.3, ramGB: 0.5, totalGB: 5.9, gpuFraction: 0.9 })
  // A CPU-only run is not a GPU run that happened to take nothing.
  assert.deepEqual(readMemoryUsage(['load_tensors:   CPU_Mapped model buffer size =  1024.00 MiB']), { vramGB: 0, ramGB: 1, totalGB: 1, gpuFraction: 0 })
  // Nothing said yet is not nothing allocated, and the caller has to be able to tell them apart.
  assert.equal(readMemoryUsage(['srv    load_model: loading model', '']), null)
})

test('fit rating: full GPU, GPU+CPU split with a speed estimate, CPU only, and hard blocks', () => {
  const [, , big, small] = MANIFEST_MODULES
  assert.equal(rateModule(small, PC, 'cuda12').fit, 'gpu')
  const split = rateModule(big, PC, 'cuda12')
  assert.equal(split.fit, 'split')
  assert.ok(split.wordsPerSec >= 4 && split.wordsPerSec <= 9, `estimate ${split.wordsPerSec}`) // measured ~6 words/s on this PC
  assert.equal(rateModule(big, PC, 'cpu').fit, 'cpu')
  assert.match(rateModule(big, { ...PC, diskFreeBytes: 2 * 1024 ** 3 }, 'cuda12').reason, /free disk/)
  assert.equal(rateModule(big, { ...PC, diskFreeBytes: 2 * 1024 ** 3 }, 'cuda12', { installed: true }).fit, 'split')
  assert.match(rateModule(big, { ...PC, ramGB: 8 }, 'cuda12').reason, /12 GB RAM/)
  assert.deepEqual(defaultsFor(big, { ...PC, ramGB: 8 }, 'cpu'), { ctx: 12288, gpuLayers: 0 })
  assert.deepEqual(defaultsFor(big, PC, 'cuda12'), { ctx: 12288, gpuLayers: 'auto' })
})

test('suggestions: reliable (official-stable + verified) first, then fit, then quality; others say why', () => {
  const rows = MANIFEST_MODULES.filter((m) => m.kind !== 'engine').map((m) => ({ m, installed: false, rating: rateModule(m, PC, 'cuda12') }))
  const s = suggest(rows, PC)
  assert.deepEqual(s.picks.map((p) => p.id), ['big', 'small'])
  assert.match(s.picks[0].reason, /best quality that still runs on your 4 GB GPU \+ 24 GB RAM/)
  assert.match(s.picks[1].reason, /vision add-on/)
  assert.match(s.why.exp, /official-preview/)
  // Tiny PC: nothing reliable fits -> say so, name the smallest, point at cloud agents.
  const tiny = { ...PC, gpus: [], cuda: null, ramGB: 4, diskFreeBytes: 100 * 1024 ** 3 }
  const t = suggest(MANIFEST_MODULES.filter((m) => m.kind === 'model').map((m) => ({ m, installed: false, rating: rateModule(m, tiny, 'cpu') })), tiny)
  assert.deepEqual(t.picks, [])
  assert.match(t.none, /cloud agents/)
  assert.deepEqual(badgesOf(MANIFEST_MODULES[2]), ['Official', 'Stable', 'Verified'])
})

test('a GPU sized from the AdapterRAM ceiling is rated, suggested and described as of unknown size, never as a 4 GB card', () => {
  const [, , big, small] = MANIFEST_MODULES
  // Huge splits so far onto the CPU of a 4 GB card that it is slow there.
  const huge = { ...big, id: 'huge', name: 'Huge', size: 9 * 1024 ** 3, recommendedVramGB: 11, minRamGB: 16, rank: 1 }
  const on = (gpu) => ({ ...PC, cuda: null, gpus: [gpu] })
  const four = on({ name: 'AMD Radeon RX 6500 XT', vendor: 'amd', vramGB: 4 })
  // Every card of 4 GB or more reads 4293918720 bytes in AdapterRAM, so this one has at least that
  // much and nobody can say how much more: it may be the 4 GB card above, or an 8 or 16 GB one.
  const capped = on({ name: 'AMD Radeon RX 6600', vendor: 'amd', vramGB: 4293918720 / 1024 ** 3, sizeCapped: true })

  // rateModule. On a real 4 GB card Big splits, at about 6 words/s.
  assert.deepEqual(rateModule(big, four, 'vulkan'), { fit: 'split', label: 'Splits GPU + CPU (slower, ~6 words/s est.)', wordsPerSec: 6, source: 'estimated' })
  // On the capped card it may split like that, or run fully on the GPU. Which is not known, so the
  // rating says so and gives the speed of each, not one of them as if it were the answer.
  assert.deepEqual(rateModule(big, capped, 'vulkan'), { fit: 'unknown', label: "Runs on the GPU as far as its memory allows (this GPU's memory is unknown, 4 GB or more: ~6 to ~20 words/s est.)", wordsPerSec: null, wordsPerSecRange: [6, 20], source: 'estimated' })
  // What 4 GB is enough for runs fully on the GPU whatever more the card has, and is rated as before.
  assert.deepEqual(rateModule(small, capped, 'vulkan'), rateModule(small, four, 'vulkan'))
  assert.equal(rateModule(small, capped, 'vulkan').fit, 'gpu')
  // The CPU build puts nothing on a GPU, so its size changes nothing.
  assert.equal(rateModule(big, capped, 'cpu').fit, 'cpu')

  // suggest. On the 4 GB card Huge is slow, so the lighter model comes first.
  const rows = (pc) => [huge, small].map((m) => ({ m, installed: false, rating: rateModule(m, pc, 'vulkan') }))
  const known = suggest(rows(four), four)
  assert.deepEqual(known.picks.map((p) => p.id), ['small', 'huge'])
  assert.match(known.picks[1].reason, /on your 4 GB GPU \+ 24 GB RAM \(Splits GPU \+ CPU, ~2 words\/s\)$/)
  // On the capped card it is slow only if the card is 4 GB, which nothing says, so it is not ranked
  // down on that guess, and the reason gives both speeds and says the size is not known.
  const unknown = suggest(rows(capped), capped)
  assert.deepEqual(unknown.picks.map((p) => p.id), ['huge', 'small'])
  assert.equal(unknown.picks[0].reason, 'Huge: best quality that still runs on your GPU (memory unknown, 4 GB or more) + 24 GB RAM (Runs on the GPU as far as its memory allows, ~2 to ~11 words/s)')
  for (const p of unknown.picks) assert.doesNotMatch(p.reason, /4 GB GPU/)
  // What is slow even fully on the GPU is slow whatever the card's size, which is no guess, so it is
  // ranked down as before, and the lighter model comes first. Giant is too big for any GPU to hold.
  const giant = { ...big, id: 'giant', name: 'Giant', size: 48 * 1024 ** 3, recommendedVramGB: 50, minRamGB: undefined, rank: 1 }
  const roomy = { ...capped, diskFreeBytes: 200 * 1024 ** 3 }
  const slow = rateModule(giant, roomy, 'vulkan')
  assert.deepEqual([slow.fit, slow.wordsPerSecRange], ['unknown', [1, 2]])
  const slowRows = [giant, small].map((m) => ({ m, installed: false, rating: rateModule(m, roomy, 'vulkan') }))
  assert.deepEqual(suggest(slowRows, roomy).picks.map((p) => p.id), ['small', 'giant'])

  // specsLine.
  assert.equal(specsLine(four), 'AMD Radeon RX 6500 XT 4 GB · 24 GB RAM · Core i5-11400H 6 cores · 52 GB free')
  assert.equal(specsLine(capped), 'AMD Radeon RX 6600 (memory unknown, 4 GB or more) · 24 GB RAM · Core i5-11400H 6 cores · 52 GB free')
})

test('/install-llm and /remove-llm: argument parsing and the confirm step', async () => {
  const ids = ['big', 'small', 'small-vision']
  assert.deepEqual(parseLlmArgs('', ids), { ids: [], unknown: [], all: false, confirm: false, empty: true })
  assert.deepEqual(parseLlmArgs('Big, small', ids).ids, ['big', 'small'])
  assert.deepEqual(parseLlmArgs('all', ids).ids, ids)
  assert.deepEqual(parseLlmArgs('nope big', ids).unknown, ['nope'])
  assert.equal(parseLlmArgs('big confirm', ids).confirm, true)

  const { modelsDir, local } = localIn(tmp(), { specs: async () => PC })
  const catalog = async () => buildCatalog(local, PC)
  const bare = await installLlmCommand('', { local, catalog })
  assert.match(bare.text, /Your PC:\*\* RTX 3050 Laptop 4 GB/)
  assert.match(bare.text, /Suggested:[\s\S]*Big: best quality/)
  assert.equal((await installLlmCommand('nope', { local, catalog })).kind, 'error')

  writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  await local.status(); await local.settled()
  const ask = await removeLlmCommand('big', { local })
  assert.match(ask.text, /This deletes: big\.gguf \(5\.0 GB\)[\s\S]*\/remove-llm big confirm/)
  assert.ok(existsSync(join(modelsDir, 'big.gguf')), 'nothing deleted before confirm')
  assert.match((await removeLlmCommand('big confirm', { local })).text, /Removed: Big/)
  assert.ok(!existsSync(join(modelsDir, 'big.gguf')))
  assert.equal((await removeLlmCommand('big confirm', { local })).kind, 'error')
  await local.dispose()
})

test('install plan: engine build for this PC first, a vision add-on brings its model; disk space is checked', async () => {
  const { local } = localIn(tmp(), { specs: async () => PC })
  assert.deepEqual((await local.plan(['small-vision'])).map((m) => m.id), ['eng', 'small', 'small-vision'])
  const cpuOnly = localIn(tmp(), { specs: async () => ({ ...PC, gpus: [], cuda: null }) }).local
  assert.deepEqual((await cpuOnly.plan(['big'])).map((m) => m.id), ['eng-cpu', 'big'])
  const full = localIn(tmp(), { specs: async () => ({ ...PC, diskFreeBytes: 1024 ** 3 }) }).local
  await assert.rejects(full.install(['big']), /not enough disk space/)
  await Promise.all([local.dispose(), cpuOnly.dispose(), full.dispose()])
})

test('vision add-on: images go to llama-server as data URLs only when the add-on is installed', () => {
  const msg = { model: 'small', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: { attachmentId: 'a1' } }] }] }
  assert.equal(toWire(msg).messages[0].content, 'what is this?[image omitted: this local model reads text only]')
  const parts = toWire(msg, new Map([['a1', { mediaType: 'image/png', data: Buffer.from('png') }]])).messages[0].content
  assert.equal(parts[1].type, 'image_url')
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${Buffer.from('png').toString('base64')}`)
})

test('usage: a local agent is ok, free, and has no limits to edit', async () => {
  const { stateOf } = await import('../usage.js')
  assert.equal(stateOf({ kind: 'local', limits: {} }).state, 'ok')
  assert.equal(stateOf({ kind: 'local', limits: {}, exhausted: { until: new Date(Date.now() + 60_000).toISOString() } }).state, 'exhausted')
})

// ---------- connectivity ----------
test('connectivity: online if the probe answers, offline if it fails, cached for the ttl, DeepSeek never contacted', async () => {
  const urls = []
  let calls = 0
  let t = 0
  let up = false
  const fetch = async (url) => { calls++; urls.push(url); if (up) return { status: 404 }; throw new Error('ENOTFOUND') }
  const c = createConnectivity({ fetch, now: () => t, ttlMs: 30_000 })
  assert.equal(await c.online(), false)
  assert.equal(calls, 1, 'one probe')
  assert.equal(urls[0], 'https://api.typesafe.ai', 'the Jev endpoint is the only probe')
  up = true
  t = 10_000
  assert.equal(await c.online(), false, 'cached within 30 s')
  assert.equal(calls, 1)
  t = 31_000
  assert.equal(await c.online(), true, 'an answering probe (any status) means online')
  assert.equal(calls, 2)
  assert.deepEqual(urls, ['https://api.typesafe.ai', 'https://api.typesafe.ai'], 'the second check probes the same single endpoint')
  assert.ok(!urls.some((u) => u.includes('deepseek')), 'DeepSeek is never probed, so no DeepSeek request can leave the machine')
})

// ---------- llama-server args ----------
test('llamaArgs: 127.0.0.1 only, jinja, one slot, context, GPU layers; no key on the command line', () => {
  const a = llamaArgs({ modelPath: 'C:/m/q.gguf', alias: 'qwen3-8b', port: 8081, ctx: 8192 })
  const at = (f) => a[a.indexOf(f) + 1]
  assert.equal(at('--host'), '127.0.0.1')
  assert.equal(at('--port'), '8081')
  assert.equal(at('-c'), '8192')
  assert.equal(at('-ngl'), 'auto')
  assert.equal(at('-np'), '1')
  assert.ok(a.includes('--jinja'))
  assert.equal(at('--reasoning'), 'off')
  assert.ok(!a.some((x) => /api-key/.test(x)))
  assert.equal(llamaArgs({ modelPath: 'm', alias: 'x', port: 1, ctx: 1, gpuLayers: 20 })[a.indexOf('-ngl') + 1], '20')
})

// ---------- verified downloads ----------
const body = Buffer.from('GGUF'.repeat(1000))
const bodySha = createHash('sha256').update(body).digest('hex')
const fakeFetch = (data, { honorRange = true } = {}) => {
  const seen = []
  const f = async (url, { headers = {} } = {}) => {
    seen.push(headers.range ?? null)
    const from = honorRange && headers.range ? Number(/bytes=(\d+)-/.exec(headers.range)[1]) : 0
    const slice = data.subarray(from)
    return { ok: true, status: from ? 206 : 200, body: (async function* () { yield slice.subarray(0, 1000); yield slice.subarray(1000) })() }
  }
  f.seen = seen
  return f
}

test('download: verified file lands under its name; partial resumes with a Range request', async () => {
  const dir = tmp()
  const dest = join(dir, 'm.gguf')
  writeFileSync(`${dest}.part`, body.subarray(0, 1500))
  const fetch = fakeFetch(body)
  let last = 0
  const r = await downloadVerified({ url: 'u', dest, size: body.length, sha256: bodySha, fetch, onProgress: (n) => { last = n } })
  assert.equal(r.sha256, bodySha)
  assert.deepEqual(fetch.seen, ['bytes=1500-'])
  assert.equal(last, body.length)
  assert.ok(readFileSync(dest).equals(body))
  assert.ok(!existsSync(`${dest}.part`))
})

test('download: SHA256 mismatch deletes the file and fails; server ignoring Range restarts cleanly', async () => {
  const dir = tmp()
  const dest = join(dir, 'm.gguf')
  await assert.rejects(downloadVerified({ url: 'u', dest, size: body.length, sha256: 'f'.repeat(64), fetch: fakeFetch(body) }), /SHA256 mismatch/)
  assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`))
  writeFileSync(`${dest}.part`, body.subarray(0, 700))
  await downloadVerified({ url: 'u', dest, size: body.length, sha256: bodySha, fetch: fakeFetch(body, { honorRange: false }) })
  assert.ok(readFileSync(dest).equals(body))
  await assert.rejects(downloadVerified({ url: 'u', dest: join(dir, 'x.gguf'), size: body.length + 5, sha256: bodySha, fetch: fakeFetch(body) }), /incomplete/)
})

// ---------- wire format ----------
test('toWire: system, tool calls and tool results in OpenAI shape', () => {
  const w = toWire({
    model: 'qwen3-8b',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":1}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file' }] }] },
    ],
    tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
  })
  assert.deepEqual(w.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(w.messages[2].tool_calls[0].function.name, 'read')
  assert.equal(w.messages[3].tool_call_id, 'c1')
  assert.equal(w.tools[0].type, 'function')
})

test('translate: text and a streamed tool call become DSH chunks, usage before finish', async () => {
  const p = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ].map((x) => JSON.stringify(x))
  const out = []
  for await (const c of translate((async function* () { yield* p; yield '[DONE]' })())) out.push(c)
  const ends = out.filter((c) => c.type === 'block-end').map((c) => c.block)
  assert.deepEqual(ends[0], { type: 'text', text: 'Hello' })
  assert.deepEqual(ends[1], { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"a":1}' })
  assert.deepEqual(out.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
  assert.deepEqual(out.at(-1).reason, { kind: 'tool-calls' })
  const empty = []
  for await (const c of translate((async function* () { yield '[DONE]' })())) empty.push(c)
  assert.equal(empty.at(-1).reason.kind, 'error')
})

// ---------- direct answers ----------
const say = (text) => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]
const runAdapter = async (a) => {
  const chunks = []
  for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'what is x?' }] }], sessionId: 's', signal })) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

test('direct answer: the local chat model answers first, and the cloud is never asked', async () => {
  const asked = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(o.provider); yield* (o.provider === 'local' ? say('local says hi') : say('deepseek says hi')) } } }
  let routed = false
  const a = jevAdapter({ ctx, route: async () => { routed = true; return '' }, classify: async () => ({ kind: 'question' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, isOffline: async () => false, localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }) })
  const text = await runAdapter(a)
  assert.deepEqual(asked, ['local'], 'everyday conversation stays on this PC')
  assert.match(text, /^local says hi[\s\S]*Answered by: local\/qwen3-8b/)
  assert.equal(routed, false)
})

test('direct answer: a local model that cannot answer hands the question to the cloud, and says so', async () => {
  const asked = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(o.provider); yield* (o.provider === 'local' ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_ENGINE' } } }] : say('cloud says hi')) } } }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, isOffline: async () => false, localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }) })
  const text = await runAdapter(a)
  assert.deepEqual(asked, ['local', 'deepseek'])
  assert.match(text, /the local model could not answer this, so Answered by: deepseek/)
})

test('direct answer: Jev saying the question is deep puts the cloud model first', async () => {
  const asked = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(o.provider); yield* say(`${o.provider} says hi`) } } }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question', confidence: 0.9, depth: 'deep' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, isOffline: async () => false, localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }) })
  const text = await runAdapter(a)
  assert.deepEqual(asked, ['deepseek'])
  assert.match(text, /Jev judged this worth the stronger model, so Answered by: deepseek/)
})

test('direct answer offline: only the local chat model is asked, and the credit says OFFLINE', async () => {
  const asked = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(o.provider); yield* say('ok') } } }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, isOffline: async () => true, localChat: async () => ({ provider: 'local', model: 'gemma4-e4b' }) })
  assert.match(await runAdapter(a), /OFFLINE: local models only\. Answered by: local\/gemma4-e4b/)
  assert.deepEqual(asked, ['local'])
})

test('session title goes to the chat model with thinking off; the answer credit names DeepSeek', async () => {
  const seen = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { seen.push(o); yield* say('A title') } } }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' }, isOffline: async () => false, localChat: async () => null })
  for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], purpose: 'session-title', reasoningEffort: 'high', signal })) { /* drain */ }
  assert.equal(seen[0].provider, 'deepseek')
  assert.equal(seen[0].reasoningEffort, 'off')
  assert.match(await runAdapter(a), /Answered by: deepseek\/deepseek-flash/)
})

test('engine install: verified zip is unpacked with the OS tar, marker written, zip removed', { skip: process.platform !== 'win32' }, async () => {
  const root = tmp()
  const src = join(root, 'src'); mkdirSync(src)
  writeFileSync(join(src, 'llama-server.exe'), 'exe')
  const zip = join(root, 'e.zip')
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', src, 'llama-server.exe'])
  const data = readFileSync(zip)
  const mods = [{ ...MANIFEST_MODULES[0], size: data.length, sha256: createHash('sha256').update(data).digest('hex') }, ...MANIFEST_MODULES.slice(1)]
  const engineDir = join(root, 'engine'); const modelsDir = join(root, 'models')
  const fetch = async () => ({ ok: true, status: 200, body: (async function* () { yield data })() })
  const local = createLocalModels({ modules: mods, engineDir, modelsDir, settingsFile: join(root, 'l.json'), fetch, specs: async () => PC })
  assert.deepEqual(await local.install(['eng']), ['eng'])
  for (let i = 0; i < 100 && (await local.status()).modules[0].job?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal((await local.status()).modules[0].state, 'installed')
  assert.equal(readFileSync(join(engineDir, 'llama-server.exe'), 'utf8'), 'exe')
  assert.ok(!existsSync(join(engineDir, 'e.zip')))
  assert.equal(await local.engineVariant(), 'cuda12')
  await local.dispose()
})

test('a local model this PC does not have the memory for is not ready, with the reason, like one not installed', async () => {
  const specs = (ramGB) => async () => ({ ramGB, gpus: [], cpu: { cores: 8 }, diskFreeBytes: null })
  for (const [ramGB, ready] of [[4, false], [32, true]]) {
    const { engineDir, modelsDir, local } = localIn(tmp(), { specs: specs(ramGB) })
    writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
    mkdirSync(join(engineDir, '.installed'))
    writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
    writeFileSync(join(modelsDir, 'big.gguf'), 'big')
    await local.status(); await local.settled()
    const r = await local.readiness('big')
    assert.equal(r.loggedIn, ready, `${ramGB} GB of RAM for a model that needs 12`)
    if (!ready) assert.match(r.detail, /this PC cannot run big\.gguf: needs 12 GB RAM, this PC has 4 GB/)
  }
})

test('a local agent carries the context window it will really run with, and the registry turns it into a size limit', async () => {
  const { executorsFrom, CHARS_PER_TOKEN } = await import('../capabilities.js')
  const { engineDir, modelsDir, local } = localIn(tmp(), { specs: async () => ({ ramGB: 32, gpus: [], cpu: { cores: 8 }, diskFreeBytes: null }) })
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  mkdirSync(join(engineDir, '.installed'))
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  await local.status(); await local.settled()
  const [agent] = await local.agents('p')
  // The manifest asks for 8192, but nothing here starts a model with less than MIN_CTX (12288),
  // and the model allows up to 40960: 12288 is what llama-server gets, so 12288 is what it holds.
  assert.equal(agent.llm.contextSize, 12288)
  const [exec] = executorsFrom({ agents: [{ ...agent, kind: 'local' }] })
  assert.equal(exec.maxInputBytes, 12288 * CHARS_PER_TOKEN)
})

// ---------- the resource budget ----------
const BUDGET_FIELDS = ['maxVramGB', 'maxRamGB', 'maxCores', 'maxConcurrentTasks']
const budgetOf = (s) => Object.fromEntries(BUDGET_FIELDS.map((k) => [k, s[k]]))

test('the resource budget is kept with the local settings, every limit optional, and read back by the same GET', async () => {
  const { local } = localIn(tmp())
  // Unset is no limit, which is how KzH behaved before there was a budget.
  assert.deepEqual(budgetOf((await local.status()).settings), { maxVramGB: null, maxRamGB: null, maxCores: null, maxConcurrentTasks: null })
  const saved = await local.setSettings({ maxVramGB: 3, maxRamGB: 8.5, maxCores: 6, maxConcurrentTasks: 2 })
  assert.deepEqual(budgetOf(saved), { maxVramGB: 3, maxRamGB: 8.5, maxCores: 6, maxConcurrentTasks: 2 })
  assert.deepEqual(budgetOf((await local.status()).settings), budgetOf(saved), 'GET /jev-router/local serves status().settings')
  // null lifts one limit and leaves the others as they were.
  await local.setSettings({ maxRamGB: null })
  assert.deepEqual(budgetOf((await local.status()).settings), { maxVramGB: 3, maxRamGB: null, maxCores: 6, maxConcurrentTasks: 2 })
  for (const [patch, why] of [
    [{ maxVramGB: 0 }, { message: 'max VRAM: GB above 0, at most 1024, or null for no limit' }],
    [{ maxVramGB: '3' }, /max VRAM/],
    [{ maxVramGB: 2000 }, /max VRAM/],
    [{ maxRamGB: -1 }, { message: 'max RAM: GB above 0, at most 4096, or null for no limit' }],
    [{ maxRamGB: Number.NaN }, /max RAM/],
    [{ maxRamGB: 5000 }, /max RAM/],
    [{ maxCores: 2.5 }, { message: 'max cores: whole number 1-256, or null for no limit' }],
    [{ maxCores: 0 }, /max cores/],
    [{ maxCores: 257 }, /max cores/],
    [{ maxConcurrentTasks: 0 }, { message: 'max concurrent tasks: whole number 1-64, or null for no limit' }],
    [{ maxConcurrentTasks: true }, /max concurrent tasks/],
    [{ maxConcurrentTasks: 65 }, /max concurrent tasks/],
  ]) await assert.rejects(local.setSettings(patch), why, JSON.stringify(patch))
  // A refused patch saves nothing, not even the half of it that was valid.
  await assert.rejects(local.setSettings({ maxCores: 4, maxConcurrentTasks: 'two' }), /max concurrent tasks/)
  assert.equal((await local.status()).settings.maxCores, 6)
  // Each upper bound is itself allowed.
  assert.deepEqual(budgetOf(await local.setSettings({ maxVramGB: 1024, maxRamGB: 4096, maxCores: 256, maxConcurrentTasks: 64 })), { maxVramGB: 1024, maxRamGB: 4096, maxCores: 256, maxConcurrentTasks: 64 })
  await local.dispose()
})

test('a saved settings change is handed on, so whatever follows the budget sees it; a refused one is not', async () => {
  const seen = []
  const { local } = localIn(tmp(), { onSettings: (s) => seen.push(budgetOf(s)) })
  await local.setSettings({ maxConcurrentTasks: 3 })
  await assert.rejects(local.setSettings({ maxConcurrentTasks: -3 }), /max concurrent tasks/)
  await local.setSettings({ maxConcurrentTasks: null })
  assert.deepEqual(seen.map((s) => s.maxConcurrentTasks), [3, null], 'once per saved change, with the settings as saved')
  await local.dispose()
  // A listener that fails is logged, and the change it was told of stays saved: it was saved first.
  const logs = []
  const { local: loud } = localIn(tmp(), { onSettings: () => { throw new Error('the lanes are gone') }, log: (t) => logs.push(t) })
  assert.equal((await loud.setSettings({ maxCores: 2 })).maxCores, 2)
  assert.equal((await loud.status()).settings.maxCores, 2)
  assert.ok(logs.includes('local: settings change not handed on: the lanes are gone'), logs.join('\n'))
  await loud.dispose()
})

/**
 * A stand-in for llama-server: it records what it was started with and answers /health at once.
 * Its pid, 2147483647, is one no process can have (a Windows process id is a multiple of 4, and
 * Linux ids stop far below it), because the Windows stop path calls taskkill on the pid and must
 * never reach a real process from a test. `report` gives the load report each start prints, as
 * llama-server writes it on stderr before it answers /health, so start() reads it as from a real run.
 */
function fakeEngine({ report = () => [] } = {}) {
  const started = []
  const spawn = (cmd, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: 2147483647 })
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
    started.push({ cmd, args, child, reported: false })
    return child
  }
  const fetch = async () => {
    const run = started.at(-1)
    if (run && !run.reported) { run.reported = true; for (const l of report()) run.child.stderr.emit('data', `${l}\n`) }
    return { ok: true }
  }
  return { started, spawn, fetch }
}

/** An engine build (the CUDA one unless said) and the `big` model in place, as a hand install leaves them, on the PC above. */
async function installedIn(root, { engine = MANIFEST_MODULES[0], ...extra } = {}) {
  const made = localIn(root, { specs: async () => PC, port: 0, ...extra })
  writeFileSync(join(made.engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  mkdirSync(join(made.engineDir, '.installed'))
  writeFileSync(join(made.engineDir, '.installed', `${engine.id}.json`), JSON.stringify({ sha256: engine.sha256 }))
  writeFileSync(join(made.modelsDir, 'big.gguf'), 'big')
  await made.local.installed()
  await made.local.settled()
  return made
}
const argOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const VULKAN = { id: 'eng-vk', kind: 'engine', variant: 'vulkan', name: 'vulkan engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/v.zip', file: 'v.zip', size: 1, sha256: sha('vk') }

test('llama-server always gets a thread count: the core budget when set, else a default that leaves the app room', async () => {
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch })
  await local.start('big')
  // The PC above has 6 physical cores. Left to itself llama.cpp takes all six and the PC crawls.
  assert.equal(argOf(eng.started[0].args, '-t'), '4', '6 cores: 4 threads, 2 cores left for the app, the browser view and the agents')
  await local.stop()
  await local.setSettings({ maxCores: 3 })
  await local.start('big')
  assert.equal(argOf(eng.started[1].args, '-t'), '3', 'the core budget, when there is one')
  await local.stop()
  // A budget above what the machine has is a budget of the whole machine, never more threads than
  // it has processors: oversubscribed, llama.cpp is exactly the crawl the thread cap is there to stop.
  await local.setSettings({ maxCores: 64 })
  await local.start('big')
  assert.equal(argOf(eng.started[2].args, '-t'), '12', 'the PC above has 12 logical processors')
  assert.equal((await local.status()).budget.threads, 12, 'and the page shows the count it will really get')
  await local.dispose()
})

test('the engine\'s start line counts its threads in words and speaks of GPU room only when the model has layers on a GPU', async () => {
  const eng = fakeEngine()
  const logs = []
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, log: (t) => logs.push(t) })
  await local.setSettings({ maxCores: 1 })
  await local.start('big')
  assert.ok(logs.some((l) => /^local: engine starting big on 127\.0\.0\.1:\d+ \(ctx \d+, GPU layers auto, 1 thread, 256 MiB kept free on the GPU\)$/.test(l)), logs.join('\n'))
  await local.stop()
  // GPU layers 0: the whole model on the CPU, so there is no GPU room to speak of.
  await local.setSettings({ maxCores: 3, gpuLayers: 0 })
  await local.start('big')
  assert.ok(logs.some((l) => /^local: engine starting big on 127\.0\.0\.1:\d+ \(ctx \d+, GPU layers 0, 3 threads\)$/.test(l)), logs.join('\n'))
  await local.dispose()
})

test('--fit-target keeps free what the GPU has beyond the VRAM budget, so the model stays under it', async () => {
  const eng = fakeEngine()
  const logs = []
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, log: (t) => logs.push(t) })
  // What the budget makes of the next load, for the settings page, before anything is loaded.
  assert.deepEqual((await local.status()).budget, { threads: 4, defaultThreads: 4, fitTargetMiB: 256, vramNotApplied: null })
  await local.start('big')
  assert.equal(argOf(eng.started[0].args, '--fit-target'), '256', 'no budget: the small margin llama.cpp always kept')
  await local.stop()
  // A 4 GB GPU and a 2.5 GB budget: 1.5 GB stays free, so whatever else holds GPU memory, the model gets 2.5 GB at most.
  await local.setSettings({ maxVramGB: 2.5 })
  assert.deepEqual((await local.status()).budget, { threads: 4, defaultThreads: 4, fitTargetMiB: 1536, vramNotApplied: null })
  await local.start('big')
  assert.equal(argOf(eng.started[1].args, '--fit-target'), '1536')
  // Once loaded, the status says what the running engine was really started with.
  const { engine } = await local.status()
  assert.deepEqual([engine.threads, engine.fitTargetMiB], [4, 1536])
  await local.stop()
  // A budget bigger than the GPU changes nothing: the margin never drops below the usual one.
  await local.setSettings({ maxVramGB: 16 })
  await local.start('big')
  assert.equal(argOf(eng.started[2].args, '--fit-target'), '256')
  await local.dispose()

  // A GPU of unknown size gives nothing to take the budget from, and the log says the budget was not applied.
  const blind = fakeEngine()
  const unknown = await installedIn(tmp(), { spawn: blind.spawn, fetch: blind.fetch, specs: async () => ({ ...PC, gpus: [] }), log: (t) => logs.push(t) })
  await unknown.local.setSettings({ maxVramGB: 2.5 })
  assert.equal((await unknown.local.status()).budget.vramNotApplied, "this PC's GPU memory is unknown")
  await unknown.local.start('big')
  assert.equal(argOf(blind.started[0].args, '--fit-target'), '256')
  assert.ok(logs.some((l) => /VRAM budget of 2\.5 GB not applied: this PC's GPU memory is unknown/.test(l)), logs.join('\n'))
  // Layers pinned in Settings are loaded as pinned, which --fit does not move, and the log says so.
  await unknown.local.stop()
  await unknown.local.setSettings({ gpuLayers: 20 })
  await unknown.local.start('big')
  assert.ok(logs.some((l) => /VRAM budget of 2\.5 GB not applied: GPU layers are pinned to 20/.test(l)), logs.join('\n'))
  await unknown.local.dispose()

  // An AMD card on the Vulkan build, sized from AdapterRAM, which stops at 4 GB: an 8 GB card reads
  // as 4. Keeping free what that figure has beyond a 3 GB budget would keep 1 GB free on a card with
  // 8, and let the model take 7. Its size is as unknown as no size at all, and treated the same.
  const amd = fakeEngine()
  const capped = await installedIn(tmp(), {
    engine: VULKAN, modules: [...MANIFEST_MODULES, VULKAN], spawn: amd.spawn, fetch: amd.fetch, log: (t) => logs.push(t),
    specs: async () => ({ ...PC, cuda: null, gpus: [{ name: 'AMD Radeon RX 6600', vendor: 'amd', vramGB: 4293918720 / 1024 ** 3, sizeCapped: true }] }),
  })
  assert.equal(await capped.local.engineVariant(), 'vulkan')
  await capped.local.setSettings({ maxVramGB: 3 })
  assert.equal((await capped.local.status()).budget.vramNotApplied, 'this GPU reports its memory through a 32-bit field that stops at 4 GB')
  await capped.local.start('big')
  assert.equal(argOf(amd.started[0].args, '--fit-target'), '256')
  assert.ok(logs.some((l) => l === 'local: VRAM budget of 3 GB not applied: this GPU reports its memory through a 32-bit field that stops at 4 GB'), logs.join('\n'))
  await capped.local.dispose()
})

test('the thread default leaves the app at least a quarter of the machine, and two cores from three cores up', () => {
  for (const [cpu, want] of [
    [{ cores: 6, threads: 12 }, 4],
    [{ cores: 8, threads: 16 }, 6],
    [{ cores: 10, threads: 20 }, 7],
    [{ cores: 14, threads: 28 }, 10],
    [{ cores: 16, threads: 32 }, 12],
    [{ cores: 4, threads: 8 }, 2],
    [{ cores: 3, threads: 6 }, 1],
    [{ cores: 2, threads: 4 }, 1],
    [{ cores: 1, threads: 1 }, 1],
    // Physical cores are read on Windows only; elsewhere half the logical processors stand in.
    [{ cores: null, threads: 12 }, 4],
    [{ cores: null, threads: 1 }, 1],
  ]) assert.equal(defaultThreads(cpu), want, JSON.stringify(cpu))
  // And as a rule, on every size of machine: llama.cpp needs one thread, so a one-core machine is the one exception.
  for (let n = 1; n <= 256; n++) {
    const t = defaultThreads({ cores: n, threads: 2 * n })
    assert.ok(t >= 1, `${n} cores: at least one thread`)
    if (n >= 2) assert.ok(n - t >= n / 4, `${n} cores: ${t} threads leaves less than a quarter`)
    if (n >= 3) assert.ok(n - t >= 2, `${n} cores: ${t} threads leaves fewer than two cores`)
  }
})

test('a model whose memory figure is over the budget is refused before it loads, naming the figure, its source and the budget', async () => {
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch })
  const big = async () => (await local.status()).modules.find((m) => m.id === 'big')
  // Big at 12288 context on the 4 GB GPU above: about 4 GB of VRAM and 2.7 GB of RAM, estimated.
  // 12288 is the floor, so there is no smaller context to size it to, and the refusal says so.
  await local.setSettings({ maxRamGB: 2 })
  const refused = 'Big needs about 2.7 GB of RAM even at the 12k context floor (estimated: 4 GB VRAM + 2.7 GB RAM), over the resource budget of 2 GB RAM. Raise the RAM budget or use a smaller model.'
  await assert.rejects(local.start('big'), { message: refused })
  assert.equal(eng.started.length, 0, 'refused before anything was started')
  // The router hears the same answer before any judgment, rather than picking it and failing at the load.
  assert.deepEqual(await local.readiness('big'), { installed: true, loggedIn: false, detail: refused })
  // And the settings page gets it per model, beside the figure it came from.
  assert.equal((await big()).overBudget, refused)

  // A VRAM budget moves the layers it keeps off the GPU into RAM, and the figure follows them there.
  await local.setSettings({ maxVramGB: 2, maxRamGB: 4 })
  assert.deepEqual((({ vramGB, ramGB, source }) => ({ vramGB, ramGB, source }))((await big()).memory), { vramGB: 2, ramGB: 4.7, source: 'estimated' })
  await assert.rejects(local.start('big'), { message: 'Big needs about 4.7 GB of RAM even at the 12k context floor (estimated: 2 GB VRAM + 4.7 GB RAM), over the resource budget of 2 GB VRAM + 4 GB RAM. Raise the RAM budget or use a smaller model.' })
  await local.setSettings({ maxRamGB: 5 })
  assert.equal((await big()).overBudget, null)
  assert.equal((await local.readiness('big')).loggedIn, true)
  await local.start('big')
  assert.equal(eng.started.length, 1, 'inside the budget it loads')
  // With no RAM budget there is nothing to refuse: VRAM is held by --fit, not by refusing.
  await local.stop()
  await local.setSettings({ maxVramGB: 1, maxRamGB: null })
  assert.equal((await big()).overBudget, null)
  await local.dispose()
})

test('a measured figure stands only for a run like the one it was measured on: the same GPU room and the same GPU layers', async () => {
  // The load report each start prints, as llama-server writes it: one line per buffer, in MiB.
  let report = []
  const eng = fakeEngine({ report: () => report })
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch })
  const big = async () => (await local.status()).modules.find((m) => m.id === 'big')
  const figure = async () => (({ vramGB, ramGB, source }) => ({ vramGB, ramGB, source }))((await big()).memory)
  const run = async (lines) => { report = lines; await local.start('big'); await local.stop() }

  // A run with the whole 4 GB GPU to itself: 3.5 GB on the GPU, 3 GB in RAM. From then on that is
  // the figure for this run, and a refusal says it was measured.
  await run(['CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 3072.00 MiB'])
  assert.deepEqual(await figure(), { vramGB: 3.5, ramGB: 3, source: 'measured' })
  await local.setSettings({ maxRamGB: 2.5 })
  await assert.rejects(local.start('big'), { message: 'Big needs about 3 GB of RAM even at the 12k context floor (measured: 3.5 GB VRAM + 3 GB RAM), over the resource budget of 2.5 GB RAM. Raise the RAM budget or use a smaller model.' })
  await local.setSettings({ maxRamGB: 4 })
  assert.equal((await big()).overBudget, null)

  // With no layers on the GPU all of it lands in RAM. What the GPU run left in RAM says nothing
  // about that, and taking it for this run would let a 5.9 GB model through a 4 GB budget.
  await local.setSettings({ gpuLayers: 0 })
  assert.deepEqual(await figure(), { vramGB: 0, ramGB: 5.9, source: 'estimated' })
  await assert.rejects(local.start('big'), { message: 'Big needs about 5.9 GB of RAM even at the 12k context floor (estimated: 0 GB VRAM + 5.9 GB RAM), over the resource budget of 4 GB RAM. Raise the RAM budget or use a smaller model.' })
  // Nor for layers pinned by hand, which --fit does not place, so they split the model their own way.
  await local.setSettings({ gpuLayers: 20 })
  assert.equal((await figure()).source, 'estimated')

  // A run held to a 2 GB VRAM budget leaves more in RAM, and under that budget its reading is refused.
  await local.setSettings({ gpuLayers: null, maxRamGB: null, maxVramGB: 2 })
  await run(['CUDA0 model buffer size = 1228.80 MiB', 'CPU model buffer size = 4812.80 MiB'])
  await local.setSettings({ maxRamGB: 4 })
  assert.deepEqual(await figure(), { vramGB: 1.2, ramGB: 4.7, source: 'measured' })
  assert.match((await big()).overBudget, /needs about 4\.7 GB of RAM even at the 12k context floor \(measured: 1\.2 GB VRAM \+ 4\.7 GB RAM\)/)
  // Lifting the VRAM budget gives it the GPU back. The tight run no longer describes the one it would
  // get, and holding that reading against it would refuse it for good: a refused model never runs
  // again to be measured.
  await local.setSettings({ maxVramGB: null })
  assert.deepEqual(await figure(), { vramGB: 4, ramGB: 2.7, source: 'estimated' })
  assert.equal((await big()).overBudget, null)
  await local.start('big')
  assert.equal(eng.started.length, 3, 'it loads')
  await local.dispose()
})

// A model whose manifest states its KV cost outright, 0.1 GB per 1k of context, and asks for 32k. On
// the PC above each 1k step of context is a clean 0.1 GB, so the largest context that fits is plain to see.
const WIDE = { id: 'wide', kind: 'model', name: 'Wide', source: 'https://huggingface.co/Org/Wide-GGUF/resolve/main/wide.gguf', file: 'wide.gguf', size: 2 * 1024 ** 3, sha256: sha('wide'), reliability: 'official-stable', verified: true, role: 'fast', rank: 2, kvGbPerToken: 0.1 / 1024, contextSize: 32768, agent: { id: 'wide-local', description: 'wide' } }
/** installedIn, with Wide installed beside Big. */
async function wideIn(root, extra = {}) {
  const made = await installedIn(root, { modules: [...MANIFEST_MODULES, WIDE], ...extra })
  writeFileSync(join(made.modelsDir, 'wide.gguf'), 'wide')
  await made.local.installed()
  await made.local.settled()
  return made
}

test('the contexts a budget may size a model to: what it asks for, then each whole k below it, down to the floor and never under it', () => {
  assert.deepEqual(contextSteps(16384), [16384, 15360, 14336, 13312, 12288])
  // A context that is no whole number of k is tried as it is first, then the whole k below it.
  assert.deepEqual(contextSteps(20000).slice(0, 3), [20000, 19456, 18432])
  assert.equal(contextSteps(20000).at(-1), 12288)
  assert.deepEqual(contextSteps(12288), [12288], 'at the floor there is nothing smaller to try')
  // A context the plugin config set under the floor is left where it is: the budget never raises it.
  assert.deepEqual(contextSteps(8192), [8192])
})

test('a RAM budget sizes the context to the largest that fits, and only a model over it even at the 12k floor is refused', async () => {
  const eng = fakeEngine()
  const logs = []
  const { local } = await wideIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, log: (t) => logs.push(t) })
  const wide = async () => (await local.status()).modules.find((m) => m.id === 'wide')
  const figure = (m) => (({ vramGB, ramGB, source }) => ({ vramGB, ramGB, source }))(m.memory)
  // No budget: the context it asks for, exactly as before there was a budget.
  let m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, figure(m)], [32768, null, { vramGB: 4, ramGB: 2.3, source: 'estimated' }])
  await local.start('wide')
  assert.equal(argOf(eng.started[0].args, '-c'), '32768')
  await local.stop()

  // At 32k Wide puts 2.3 GB into RAM, over a 1.25 GB budget. Each 1k less takes 0.1 GB off, so 21k
  // (1.2 GB) is the largest context that fits, and 22k (1.3 GB) is not.
  await local.setSettings({ maxRamGB: 1.25 })
  m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, figure(m), m.overBudget], [21504, 32768, { vramGB: 4, ramGB: 1.2, source: 'estimated' }, null])
  assert.ok(estimateMemory(WIDE, { ctx: 22528, vramGB: 4 }).ramGB > 1.25, 'the next step up does not fit')
  assert.equal((await local.readiness('wide')).loggedIn, true, 'sized down, it fits, so it is ready')
  // What the page shows is what the load gets.
  await local.start('wide')
  assert.equal(argOf(eng.started[1].args, '-c'), '21504')
  assert.equal((await local.status()).engine.ctx, 21504)
  assert.ok(logs.includes('local: the resource budget reduced wide\'s context from 32768 to 21504, the largest that fits it'), logs.join('\n'))
  await local.stop()
  // The router and DSH are told the window it really runs with, so nothing sends it more than it holds.
  assert.equal((await local.agents('p')).find((a) => a.id === 'wide-local').llm.contextSize, 21504)
  assert.equal(local.contextOf('wide'), 21504)

  // Where a VRAM budget applies it keeps layers off the GPU, and what they take lands in RAM, so the
  // context is sized to the figure under both: at 2 GB of VRAM and 3.05 GB of RAM, 19k.
  await local.setSettings({ maxVramGB: 2, maxRamGB: 3.05 })
  m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, figure(m)], [19456, 32768, { vramGB: 2, ramGB: 3, source: 'estimated' }])
  // A VRAM budget alone refuses nothing, since --fit holds it, so it sizes nothing either.
  await local.setSettings({ maxRamGB: null })
  assert.deepEqual([(await wide()).ctx, (await wide()).ctxReducedFrom], [32768, null])

  // Even at the 12k floor Wide puts 0.3 GB into RAM. Under a 0.2 GB budget nothing fits, and the
  // refusal says it is the floor that does not fit, with the figure there.
  await local.setSettings({ maxVramGB: null, maxRamGB: 0.2 })
  const floor = 'Wide needs about 0.3 GB of RAM even at the 12k context floor (estimated: 4 GB VRAM + 0.3 GB RAM), over the resource budget of 0.2 GB RAM. Raise the RAM budget or use a smaller model.'
  await assert.rejects(local.start('wide'), { message: floor })
  assert.equal(eng.started.length, 2, 'refused before anything was started')
  m = await wide()
  assert.deepEqual([m.ctx, figure(m), m.overBudget], [12288, { vramGB: 4, ramGB: 0.3, source: 'estimated' }, floor])
  assert.equal((await local.readiness('wide')).detail, floor)
  await local.dispose()
})

test('a context sized by the budget is what a reading is kept under, and a reading over the budget there moves the next load down', async () => {
  let report = []
  const eng = fakeEngine({ report: () => report })
  const { local } = await wideIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch })
  const wide = async () => (await local.status()).modules.find((m) => m.id === 'wide')
  await local.setSettings({ maxRamGB: 1.25 })
  // Estimated at 1.2 GB, it really took 1.5 GB of RAM at 21k: kept against 21k, the context it ran with.
  report = ['CUDA0 model buffer size = 3276.80 MiB', 'CPU model buffer size = 1536.00 MiB']
  await local.start('wide')
  await local.stop()
  const kept = (await local.readSettings()).measured
  assert.deepEqual(Object.keys(kept), ['wide@21504'])
  assert.deepEqual([kept['wide@21504'].vramGB, kept['wide@21504'].ramGB], [3.2, 1.5])
  // A reading stands for its own context only. At 21k it is over the budget, so 21k no longer fits,
  // and the next load takes 20k, where nothing has been measured and the estimate stands in.
  const m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, m.memory.ramGB, m.memory.source], [20480, 32768, 1.1, 'estimated'])
  await local.start('wide')
  assert.equal(argOf(eng.started[1].args, '-c'), '20480')
  await local.dispose()
})

test('while a model runs, DSH and the router are never told a window larger than the one llama-server was started with', async () => {
  const eng = fakeEngine()
  const { local } = await wideIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch })
  const wide = async () => (await local.status()).modules.find((m) => m.id === 'wide')
  const routerWindow = async () => (await local.agents('p')).find((a) => a.id === 'wide-local').llm.contextSize
  const dshWindow = async () => (await localAdapter(local).resolveModel('local', 'wide')).context.contextWindow
  // Sized to 21k by the budget, and started there.
  await local.setSettings({ maxRamGB: 1.25 })
  await local.start('wide')
  assert.equal(argOf(eng.started[0].args, '-c'), '21504')
  // The budget is lifted while it stays loaded. The next load would take 32k, and the page says so,
  // but a loaded model is not restarted for it: asked again, it answers from the 21k it holds.
  await local.setSettings({ maxRamGB: null })
  assert.deepEqual([(await wide()).ctx, (await wide()).ctxReducedFrom], [32768, null])
  await local.start('wide')
  assert.equal(eng.started.length, 1, 'not restarted')
  assert.equal(local.contextOf('wide'), 21504)
  assert.equal(await dshWindow(), 21504)
  assert.equal(await routerWindow(), 21504)
  // Once it is unloaded, the next load is the window a request meets.
  await local.stop()
  assert.equal(local.contextOf('wide'), 32768)
  assert.equal(await routerWindow(), 32768)

  // The other way: loaded at 32k, then a budget that sizes the next load to 21k. DSH asks at each
  // request, and while the 32k run is up it may fill 32k. The router keeps what it is told until the
  // next change, and the model may be unloaded and loaded again at 21k before then, so it is told
  // the smaller of the two, never a window the next load will not have.
  await local.start('wide')
  assert.equal(argOf(eng.started[1].args, '-c'), '32768')
  await local.setSettings({ maxRamGB: 1.25 })
  assert.equal(await routerWindow(), 21504)
  assert.equal(local.contextOf('wide'), 32768)
  await local.stop()
  assert.equal(local.contextOf('wide'), 21504)
  await local.start('wide')
  assert.equal(argOf(eng.started[2].args, '-c'), '21504')
  await local.dispose()
})

test('a model the watchdog unloaded is refused only at the context it was unloaded at and above: a smaller one that fits still loads', async () => {
  const GIB = 1024 ** 3
  let clock = 0
  let rss = 2.3 * GIB
  const eng = fakeEngine()
  const changed = []
  const { local } = await wideIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, now: () => clock, readWorkingSet: async () => rss, watchEveryMs: 3_600_000, onChange: (m) => changed.push(m.id) })
  changed.length = 0 // the install's own verification is not what this test is about
  const wide = async () => (await local.status()).modules.find((m) => m.id === 'wide')
  const trip = async () => {
    await local.checkMemory()
    clock += 31_000
    await local.checkMemory()
    assert.equal((await local.status()).engine.running, false, 'unloaded by the watchdog')
  }
  // Loaded at 32k with no budget, then a 1.25 GB budget is set while it runs. Its 2.3 GB stays over
  // it and the watchdog unloads it. That says 32k is too much, not that Wide is: at 21k its figure
  // fits the budget, and it loads there.
  await local.start('wide')
  await local.setSettings({ maxRamGB: 1.25 })
  await trip()
  let m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, m.overBudget], [21504, 32768, null])
  assert.equal((await local.readiness('wide')).loggedIn, true)
  // At 21k its real use is 1.5 GB, and the watchdog unloads it again. The estimate there still says
  // 1.2 GB, but the run said otherwise, so 21k is not tried again: the next load steps down to 20k,
  // where the figure fits and nothing has said it does not.
  rss = 1.5 * GIB
  await local.start('wide')
  assert.equal(argOf(eng.started[1].args, '-c'), '21504')
  await trip()
  assert.ok(estimateMemory(WIDE, { ctx: 21504, vramGB: 4 }).ramGB <= 1.25, 'the figure at 21k fits: only the unload rules it out')
  m = await wide()
  assert.deepEqual([m.ctx, m.ctxReducedFrom, m.memory.ramGB, m.overBudget], [20480, 32768, 1.1, null])
  await local.start('wide')
  assert.equal(argOf(eng.started[2].args, '-c'), '20480')
  await local.stop()
  // A setting that changes nothing about its memory changes nothing here either.
  await local.setSettings({ idleMinutes: 20 })
  assert.equal((await wide()).ctx, 20480)
  // A new RAM budget is a fresh start. Under 0.3 GB it loads at the 12k floor, and unloaded there it
  // has nothing smaller left to load with: it is refused, with the watchdog's reason.
  await local.setSettings({ maxRamGB: 0.3 })
  assert.equal((await wide()).ctx, 12288)
  await local.start('wide')
  await trip()
  const why = 'the RAM watchdog unloaded Wide: its working set stayed over the 0.3 GB RAM budget for 31 s (last reading 1.5 GB). Raise the RAM budget to load it again.'
  assert.equal((await wide()).overBudget, why)
  await assert.rejects(local.start('wide'), { message: why })
  assert.deepEqual(changed, ['wide', 'wide', 'wide'], 'each unload told whoever follows the local models')
  await local.dispose()
})

test('a context the plugin config set under the floor is not raised by the budget, and its refusal names that context', async () => {
  const { local } = await installedIn(tmp(), { contextSize: 8192 })
  await local.setSettings({ maxRamGB: 1 })
  const big = (await local.status()).modules.find((m) => m.id === 'big')
  assert.deepEqual([big.ctx, big.ctxReducedFrom], [8192, null])
  assert.match(big.overBudget, /^Big needs about [\d.]+ GB of RAM at 8192 context \(estimated: /)
  await local.dispose()
})

test('the chat model is one the budget lets load: titles and direct answers never go to a model it refuses', async () => {
  const { local, modelsDir } = await installedIn(tmp())
  writeFileSync(join(modelsDir, 'small.gguf'), 'small')
  await local.installed(); await local.settled()
  await local.setSettings({ chatModel: 'big' })
  assert.equal(await local.chatModel(), 'big')
  // On the PC above, Big needs about 2.7 GB of RAM and Small about 1.3.
  await local.setSettings({ maxRamGB: 2 })
  assert.equal(await local.chatModel(), 'small', 'the chosen one is over the budget, so the quickest one that fits')
  assert.equal((await local.status()).settings.chatModel, 'small', 'and the page shows the one really answering')
  await local.setSettings({ maxRamGB: 1 })
  assert.equal(await local.chatModel(), null, 'none fits: no local chat model, so the next agent answers')
  await local.setSettings({ maxRamGB: null })
  assert.equal(await local.chatModel(), 'big', 'the choice stands again once it fits')
  await local.dispose()
})

test('the RAM watchdog unloads a model whose working set stays over the budget for 30 seconds, says why, and keeps it unloaded', async () => {
  const GIB = 1024 ** 3
  let clock = 1_000_000
  let rss = 3 * GIB
  const reads = []
  const logs = []
  const changed = []
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), {
    spawn: eng.spawn, fetch: eng.fetch, log: (t) => logs.push(t),
    onChange: (m) => changed.push(m.id),
    now: () => clock,
    readWorkingSet: async (pid) => { reads.push(pid); return rss },
    // No timer here: every reading below is taken by hand, on the test's own clock.
    watchEveryMs: 3_600_000,
  })
  changed.length = 0 // the install's own verification is not what this test is about
  const running = async () => (await local.status()).engine.running
  await local.start('big')
  await local.checkMemory()
  assert.deepEqual(reads, [], 'no RAM budget, nothing to watch, nothing read')
  await local.setSettings({ maxRamGB: 4 })
  await local.checkMemory()
  assert.deepEqual(reads, [2147483647], "llama-server's own process is the one read")
  assert.equal((await local.status()).engine.workingSetGB, 3, 'the latest reading is on the status, for the page')

  rss = 5 * GIB
  await local.checkMemory() // over from here
  clock += 25_000
  await local.checkMemory()
  assert.equal(await running(), true, '25 seconds over is not 30')
  rss = 3.5 * GIB
  clock += 5_000
  await local.checkMemory() // back under: the count starts again
  rss = 5 * GIB
  clock += 5_000
  await local.checkMemory()
  clock += 29_000
  await local.checkMemory()
  assert.equal(await running(), true, 'the count started again when it dipped under')
  assert.deepEqual(changed, [])
  clock += 1_000
  await local.checkMemory()
  assert.equal(await running(), false, '30 seconds over the budget: unloaded')
  assert.ok(logs.includes('local: unloaded big: its working set stayed over the 4 GB RAM budget for 30 s (last reading 5 GB)'), logs.join('\n'))
  // The router caches readiness for minutes. Told at once, it stops offering the model now rather
  // than sending it tasks that each fail at the load.
  assert.deepEqual(changed, ['big'], 'whoever follows the local models hears of it, once')

  // Big was unloaded at 12k, the context floor, so there is no smaller context to load it with, and
  // loading it again would only end the same way: it is refused, with the reading, until the budget changes.
  const why = 'the RAM watchdog unloaded Big: its working set stayed over the 4 GB RAM budget for 30 s (last reading 5 GB). Raise the RAM budget to load it again.'
  await assert.rejects(local.start('big'), { message: why })
  assert.equal((await local.readiness('big')).detail, why)
  assert.equal((await local.status()).modules.find((m) => m.id === 'big').overBudget, why)
  assert.equal(await local.chatModel(), null, 'nor is it the chat model any more')
  await local.setSettings({ idleMinutes: 20 })
  await assert.rejects(local.start('big'), { message: why }, 'a setting that changes nothing about its memory changes nothing here')
  await local.setSettings({ maxRamGB: 6 })
  await local.start('big')
  assert.equal(await running(), true, 'a changed budget is a fresh start')

  // A reading that cannot be taken says nothing either way, so it restarts the count rather than adding to it.
  rss = 7 * GIB
  await local.checkMemory()
  rss = null
  clock += 20_000
  await local.checkMemory()
  rss = 7 * GIB
  clock += 20_000
  await local.checkMemory()
  assert.equal(await running(), true, 'forty seconds, but not thirty of them seen over')
  await local.dispose()
})

test('the engine counts its loads and the RAM watchdog\'s unloads, which a capability benchmark reads around a local agent\'s task, and nothing else moves the counts', async () => {
  const GIB = 1024 ** 3
  let clock = 1_000_000
  let rss = 3 * GIB
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, now: () => clock, readWorkingSet: async () => rss, watchEveryMs: 3_600_000 })
  assert.equal(typeof local.engineCounters, 'function')
  const counts = () => local.engineCounters()
  assert.deepEqual(counts(), { loads: 0, unloads: 0 })
  await local.start('big')
  assert.deepEqual(counts(), { loads: 1, unloads: 0 }, 'a load')
  await local.start('big')
  await local.status()
  await local.checkMemory()
  assert.deepEqual(counts(), { loads: 1, unloads: 0 }, 'a start of the model that is loaded, a status and a reading under the budget move nothing')
  await local.stop()
  assert.deepEqual(counts(), { loads: 1, unloads: 0 }, 'a stop is not the watchdog\'s unload')
  await local.setSettings({ maxRamGB: 4 })
  await local.start('big')
  assert.deepEqual(counts(), { loads: 2, unloads: 0 }, 'a second load')
  rss = 5 * GIB
  await local.checkMemory()
  clock += 30_000
  await local.checkMemory()
  assert.equal((await local.status()).engine.running, false)
  assert.deepEqual(counts(), { loads: 2, unloads: 1 }, 'the watchdog\'s unload')
  const copy = counts()
  copy.loads = 99
  assert.equal(counts().loads, 2, 'a reader gets a copy')
  await local.dispose()
})

test('a model the watchdog unloaded loads again once what decides its RAM changes, and not when the same value is saved again', async () => {
  const GIB = 1024 ** 3
  let clock = 0
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, now: () => clock, readWorkingSet: async () => 5 * GIB, watchEveryMs: 3_600_000 })
  const running = async () => (await local.status()).engine.running
  // Loads (so it was not refused), then stays over the 4 GB budget for 30 seconds.
  const loadAndTrip = async () => {
    await local.start('big')
    await local.checkMemory()
    clock += 30_000
    await local.checkMemory()
    assert.equal(await running(), false, 'unloaded by the watchdog')
  }
  const unloaded = /the RAM watchdog unloaded Big/
  await local.setSettings({ maxRamGB: 4 })
  await loadAndTrip()
  // A settings form that posts the whole budget on every save sends the same values again.
  await local.setSettings({ maxRamGB: 4, maxVramGB: null, gpuLayers: null })
  await assert.rejects(local.start('big'), unloaded, 'the same values again change nothing about its memory')
  // A different VRAM budget does: it moves some of the model between the GPU and RAM.
  await local.setSettings({ maxVramGB: 3 })
  await loadAndTrip()
  await assert.rejects(local.start('big'), unloaded)
  // So do different GPU layers.
  await local.setSettings({ gpuLayers: 20 })
  await local.start('big')
  assert.equal(await running(), true)
  await local.dispose()
})

test('the RAM watchdog takes one reading at a time, and a late one from an engine since replaced changes nothing', async () => {
  const GIB = 1024 ** 3
  let clock = 0
  // Every reading waits for the test to answer it, as a slow tasklist would.
  const answers = []
  let taken = () => {}
  const nextReading = () => new Promise((r) => { taken = r })
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), {
    spawn: eng.spawn, fetch: eng.fetch, now: () => clock, watchEveryMs: 3_600_000,
    readWorkingSet: () => new Promise((answer) => { answers.push(answer); taken() }),
  })
  await local.setSettings({ maxRamGB: 4 })
  await local.start('big')
  let reading = nextReading()
  const first = local.checkMemory()
  assert.equal(local.checkMemory(), first, 'a check while a reading is out joins it rather than taking a second')
  await reading
  answers[0](5 * GIB) // over the budget from here
  await first
  clock += 29_000
  reading = nextReading()
  const late = local.checkMemory()
  await reading
  // Before that reading comes back, the model is unloaded and loaded again: a new engine, a new count.
  await local.stop()
  await local.start('big')
  clock += 2_000
  answers[1](5 * GIB)
  await late
  assert.equal(answers.length, 2, 'one reading per check')
  assert.equal((await local.status()).engine.running, true, "the old engine's thirty seconds do not unload the new one")
  assert.equal((await local.readiness('big')).loggedIn, true, 'nor mark the model unloaded')
  await local.dispose()
})

test('the working set is read per platform: tasklist on Windows, ps elsewhere, and no reading is null, never zero', async () => {
  const asked = []
  const answer = (out) => async (cmd, args) => { asked.push([cmd, ...args]); return out }
  // tasklist writes the working set in KB with the locale's own thousands separator.
  assert.equal(await workingSetOf(2140, { platform: 'win32', run: answer('"llama-server.exe","2140","Console","1","1,234,567 K"\r\n') }), 1234567 * 1024)
  assert.deepEqual(asked[0], ['tasklist', '/FI', 'PID eq 2140', '/FO', 'CSV', '/NH'])
  assert.equal(parseTasklistMemory('"llama-server.exe","2140","Console","1","1.234.567 K"'), 1234567 * 1024, 'a German separator')
  assert.equal(parseTasklistMemory('"llama-server.exe","2140","Console","1","1 234 567 Ko"'), 1234567 * 1024, 'a French one, and its unit')
  assert.equal(parseTasklistMemory('INFO: No tasks are running which match the specified criteria.\r\n'), null, 'the process has gone')
  // ps reports RSS in KiB.
  assert.equal(await workingSetOf(2140, { platform: 'linux', run: answer('  524288\n') }), 512 * 1024 ** 2)
  assert.deepEqual(asked[1], ['ps', '-o', 'rss=', '-p', '2140'])
  assert.equal(parsePsRss(''), null)
  assert.equal(parsePsRss('RSS\n1024\n'), null, 'anything but the one number is no reading')
  // The command failing (exec gives null) or no pid at all is no reading either.
  assert.equal(await workingSetOf(2140, { platform: 'win32', run: async () => null }), null)
  assert.equal(await workingSetOf(2140, { platform: 'darwin', run: async () => null }), null)
  assert.equal(await workingSetOf(undefined, { run: answer('1') }), null)
  assert.equal(asked.length, 2, 'nothing is run without a pid')
})

test('the RAM watchdog reads on its own once the model is loaded, and stops when the engine does', async () => {
  let reads = 0
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, readWorkingSet: async () => { reads++; return 1024 }, watchEveryMs: 1 })
  await local.setSettings({ maxRamGB: 8 })
  await local.start('big')
  // Waits for the first reading rather than for a length of time, so a loaded machine only makes it slower.
  await waitFor('the watchdog took a reading by itself', () => reads, (n) => n > 0, { timeoutMs: 10_000 })
  await local.stop()
  await local.checkMemory() // lets a reading already in flight finish
  const after = reads
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(reads, after, 'no reading once the engine is stopped')
  await local.dispose()
})

// ---------- the shared residency: llama beside Laya (docs/laya-auto.md 7.7) ----------

/**
 * A residency of the shape residency.js has, kept here so these tests load against a local.js that
 * never had one: residents in a Map, a generation that moves whenever one comes or goes, and a
 * record of what local.js asked of it.
 */
function residencyStub() {
  const residents = new Map()
  let gen = 0
  const asked = []
  const ramOf = (r) => r.workingSetGB ?? (typeof r.ramGB === 'function' ? r.ramGB() : r.ramGB) ?? 0
  const others = (id, heldOnly) => [...residents.values()].filter((r) => r.id !== id && (!heldOnly || r.held()))
  return {
    asked,
    set(id, entry) {
      const stored = { busy: () => false, held: () => false, keepWhileHeld: false, name: id, ...entry, id, workingSetGB: null }
      residents.set(id, stored)
      gen++
      asked.push(['set', id])
      return stored
    },
    clear(id, entry) {
      if (!residents.has(id) || (entry && residents.get(id) !== entry)) return
      residents.delete(id)
      gen++
      asked.push(['clear', id])
    },
    get: (id) => residents.get(id) ?? null,
    list: () => [...residents.values()],
    generation: () => gen,
    othersRamGB: (id, { heldOnly = false } = {}) => Math.round(others(id, heldOnly).reduce((a, r) => a + ramOf(r), 0) * 10) / 10,
    othersVramGB: (id, { heldOnly = false } = {}) => others(id, heldOnly).reduce((a, r) => a + (r.vramGB ?? 0), 0),
    othersNames: (id, { heldOnly = false } = {}) => others(id, heldOnly).map((r) => r.name),
    async yieldFor(id, { name = id } = {}) {
      asked.push(['yieldFor', id])
      const gone = []
      for (const r of others(id, false)) {
        if (r.held() || r.busy()) continue
        await r.unload({ kind: 'yield', for: name, text: `unloaded so ${name} could have the GPU and RAM` })
        gone.push(r.id)
      }
      return gone
    },
  }
}

/** A Laya registered the way laya-sidecar.js registers it: its unload leaves the residency, as its stop does. */
function layaIn(res, { held = false, busy = false, ramGB = 3.3, startedAt = Date.now() + 1000, pid = 4242 } = {}) {
  const laya = { held, busy, unloads: [] }
  laya.entry = res.set('laya', {
    pid, startedAt, device: 'cuda', name: 'Laya', keepWhileHeld: true, ramGB, vramGB: 2.5,
    held: () => laya.held, busy: () => laya.busy,
    unload: async (why) => { laya.unloads.push(why); res.clear('laya', laya.entry) },
  })
  return laya
}

test('isBusy() says a request holds the engine: true while a stream is open, false once it has finished', async () => {
  let finish
  const body = new ReadableStream({ start(c) { finish = () => { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); c.close() } } })
  const eng = fakeEngine()
  const fetch = async (url) => (String(url).endsWith('/health') ? eng.fetch() : new Response(body))
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch })
  assert.equal(typeof local.isBusy, 'function', 'the local models say whether a request is in flight')
  assert.equal(local.isBusy(), false, 'nothing asked yet')
  const chunks = []
  const reading = (async () => { for await (const c of local.stream({ model: 'big', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(c) })()
  await waitFor('the stream is open', () => local.isBusy(), (b) => b === true, { timeoutMs: 10_000 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(local.isBusy(), true, 'still open: nothing has come back yet')
  finish()
  await reading
  assert.equal(local.isBusy(), false, 'the stream has ended')
  assert.ok(chunks.some((c) => c.type === 'text-delta'), JSON.stringify(chunks))
  await local.dispose()
})

test('the loaded engine registers in the shared residency as llama, held, and leaves it when it stops', async () => {
  const res = residencyStub()
  const eng = fakeEngine()
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, residency: res })
  assert.equal(res.get('llama'), null, 'not resident before it is loaded')
  await local.start('big')
  const llama = res.get('llama')
  assert.ok(llama, 'resident once it is ready')
  assert.deepEqual([llama.pid, llama.name, llama.held(), llama.busy(), llama.keepWhileHeld], [2147483647, 'big', true, false, false])
  assert.ok(llama.ramGB() > 0 && llama.vramGB() > 0, 'it says what it holds, for the budget beside it')
  assert.equal(typeof llama.unload, 'function')
  await local.stop()
  assert.equal(res.get('llama'), null, 'gone once stopped')
  assert.deepEqual(res.asked.filter(([what]) => what !== 'yieldFor'), [['set', 'llama'], ['clear', 'llama']])
  await local.dispose()
})

test('an engine that exits on its own leaves the shared residency, and a late exit never clears a newer engine', async () => {
  const res = residencyStub()
  const eng = fakeEngine()
  let healthy = true
  const fetch = async () => (healthy ? eng.fetch() : { ok: false })
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch, residency: res })
  await local.start('big')
  assert.ok(res.get('llama'), 'the setting: resident once ready')
  // A CUDA error, an access violation or a kill from Task Manager: nobody stopped it.
  const crashed = eng.started[0].child
  crashed.exitCode = 3221225477
  crashed.emit('exit', 3221225477)
  await new Promise((r) => setImmediate(r))
  assert.equal((await local.status()).engine.running, false)
  assert.equal(res.get('llama'), null, 'a dead engine holds no RAM or VRAM in the budget beside Laya')
  assert.deepEqual([res.othersRamGB('laya'), res.othersVramGB('laya'), res.othersNames('laya')], [0, 0, []])

  // An engine that fails while it is still loading (Node's 'error': it could not be killed, say)
  // and whose process only exits later, once a newer engine is ready: that exit leaves the newer
  // engine where it is, since the one that failed was never resident.
  healthy = false
  const loading = local.start('big').catch((err) => err)
  await waitFor('the second engine is spawned', () => eng.started.length, (n) => n === 2, { timeoutMs: 10_000 })
  const failed = eng.started[1].child
  failed.emit('error', new Error('kill EPERM'))
  assert.match(String((await loading)?.message), /llama-server exited: .*kill EPERM/)
  healthy = true
  await local.start('big')
  const newer = res.get('llama')
  assert.ok(newer && eng.started.length === 3, 'the setting: the third engine is resident')
  failed.exitCode = 1
  failed.emit('exit', 1)
  await new Promise((r) => setImmediate(r))
  assert.equal(res.get('llama'), newer, 'the late exit of an engine that never became ready clears nothing')
  assert.equal((await local.status()).engine.running, true)
  // And a late exit of one that was ready clears only its own entry: the newer one stays.
  const third = eng.started[2].child
  third.kill = () => {}
  await local.stop()
  await local.start('big')
  const fourth = res.get('llama')
  third.exitCode = 0
  third.emit('exit', 0)
  await new Promise((r) => setImmediate(r))
  assert.equal(res.get('llama'), fourth)
  await local.dispose()
})

test('a local model start first unloads a Laya nothing holds; the plan counts only a held Laya against the RAM budget, and never unloads', async () => {
  const wideOf = async (local) => (await local.status()).modules.find((m) => m.id === 'wide')
  // What Wide gets with no Laya at all: under 5 GB it takes its whole 32k, and under the 1.7 GB a
  // held Laya's 3.3 GB would leave of those 5, less.
  const alone = fakeEngine()
  const { local: plain } = await wideIn(tmp(), { spawn: alone.spawn, fetch: alone.fetch })
  await plain.setSettings({ maxRamGB: 5 })
  assert.equal((await wideOf(plain)).ctx, 32768)
  await plain.start('wide')
  const aloneArgs = alone.started[0].args
  await plain.setSettings({ maxRamGB: 1.7 })
  const heldCtx = (await wideOf(plain)).ctx
  assert.ok(heldCtx < 32768, 'the smaller room sizes the context down')
  await plain.dispose()

  // A Laya nothing holds: planned as if it were not there, and unloaded when the model starts, so
  // llama gets the context and the --fit target it would have had without Laya.
  const res = residencyStub()
  const eng = fakeEngine()
  const { local } = await wideIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, residency: res })
  await local.setSettings({ maxRamGB: 5 })
  const unheld = layaIn(res, { held: false })
  assert.equal((await wideOf(local)).ctx, 32768, 'a Laya nothing holds does not size llama down')
  assert.equal((await local.readiness('wide')).loggedIn, true)
  assert.deepEqual(unheld.unloads, [], 'reading the plan unloads nothing')
  await local.start('wide')
  assert.deepEqual(unheld.unloads.map((w) => [w.kind, w.for]), [['yield', 'wide']], 'Laya gave way before the load')
  const i = res.asked.findIndex(([what]) => what === 'yieldFor')
  assert.ok(i >= 0 && res.asked.findIndex(([what, id]) => what === 'set' && id === 'llama') > i, 'unloaded before llama came up')
  for (const flag of ['-c', '--fit-target', '-ngl', '-t']) assert.equal(argOf(eng.started[0].args, flag), argOf(aloneArgs, flag), `${flag} as without Laya`)
  await local.stop()

  // A held Laya stays, and its RAM comes off the budget before llama's context is sized.
  const held = layaIn(res, { held: true })
  assert.equal((await wideOf(local)).ctx, heldCtx, 'sized as under 5 GB less the 3.3 GB Laya holds')
  await local.start('wide')
  assert.deepEqual(held.unloads, [], 'a held Laya is never unloaded for llama')
  assert.equal(argOf(eng.started[1].args, '-c'), String(heldCtx))
  await local.stop()
  // Over what is left even at the floor: the refusal says what Laya holds.
  await local.setSettings({ maxRamGB: 3.5 })
  const refusal = 'Wide needs about 0.3 GB of RAM even at the 12k context floor (estimated: 4 GB VRAM + 0.3 GB RAM), over the resource budget of 3.5 GB RAM, less the 3.3 GB Laya holds. Raise the RAM budget or use a smaller model.'
  assert.equal((await wideOf(local)).overBudget, refusal)
  await assert.rejects(local.start('wide'), { message: refusal })
  await local.dispose()
})

test('the RAM watchdog counts llama and Laya together, unloads a Laya nothing holds before a busy llama, and never trips llama on Laya\'s share', async () => {
  const GIB = 1024 ** 3
  let clock = 0
  const res = residencyStub()
  const eng = fakeEngine()
  const rss = { 2147483647: 3 * GIB, 4242: 3 * GIB }
  const { local } = await installedIn(tmp(), { spawn: eng.spawn, fetch: eng.fetch, residency: res, now: () => clock, readWorkingSet: async (pid) => rss[pid] ?? null, watchEveryMs: 3_600_000 })
  await local.setSettings({ maxRamGB: 5 })
  await local.start('big')
  const conn = await local.acquire('big') // a request in flight: llama is busy
  const laya = layaIn(res, { held: false })
  await local.checkMemory()
  clock += 29_000
  await local.checkMemory()
  assert.deepEqual(laya.unloads, [], '6 GB together, over 5 GB, but not yet for 30 seconds')
  clock += 1_000
  await local.checkMemory()
  assert.deepEqual(laya.unloads.map((w) => w.kind), ['budget'], 'the Laya nothing holds goes first')
  assert.match(laya.unloads[0].text, /^the local models together stayed over the 5 GB RAM budget for 30 s \(last reading 6 GB: big 3 GB, Laya 3 GB\)$/)
  assert.equal((await local.status()).engine.running, true, 'the busy llama keeps running')
  assert.equal((await local.readiness('big')).loggedIn, true, "and llama's context is not marked as tripped on Laya's account")
  conn.release()
  // llama alone and over the budget is unloaded as it always was.
  rss[2147483647] = 6 * GIB
  await local.checkMemory()
  clock += 30_000
  await local.checkMemory()
  assert.equal((await local.status()).engine.running, false)
  assert.match((await local.readiness('big')).detail, /^the RAM watchdog unloaded Big: its working set stayed over the 5 GB RAM budget for 30 s \(last reading 6 GB\)/)
  await local.dispose()
})

test('killTree stops a process and every process it started, by pid; on Windows through taskkill /t /f', async () => {
  const { killTree } = await import('../local.js')
  assert.equal(typeof killTree, 'function', 'local.js exports killTree(pid)')
  const calls = []
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 } }
  assert.equal(killTree(1234, { platform: 'win32', run }), true)
  assert.deepEqual(calls, [['taskkill', '/pid', '1234', '/t', '/f']])
  assert.equal(killTree(undefined), false, 'no pid, nothing to do')
  assert.equal(killTree(0), false)
  if (process.platform === 'win32') return
  const { spawn } = await import('node:child_process')
  // A parent that starts a child of its own and prints its pid: both must go.
  const parent = spawn(process.execPath, ['-e', "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  const childPid = Number(await new Promise((r) => parent.stdout.once('data', (d) => r(String(d).trim()))))
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.ok(alive(parent.pid) && alive(childPid))
  assert.equal(killTree(parent.pid), true)
  await waitFor('the parent and its child have exited', () => [parent.exitCode === null && parent.signalCode === null, alive(childPid)], (x) => !x[0] && !x[1], { timeoutMs: 10_000 })
})

// ---------- the speed benchmark (docs/benchmark.md 2 and 5.1) ----------

// The load report of a split run: 29 of Big's 37 layers on the 4 GB GPU, the rest in RAM.
const SPLIT_REPORT = ['load_tensors: offloaded 29/37 layers to GPU', 'CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 1024.00 MiB']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Today as a reading taken in this test is dated: "25 Sep". */
const today = (d = new Date()) => `${d.getDate()} ${MONTH[d.getMonth()]}`

/**
 * The CUDA engine build and the models `ids` in place, as a hand install leaves them, on the PC above,
 * over the fake llama-server `server` (test/fixtures/fake-llama-server.mjs).
 */
async function speedIn({ ids = ['big'], modules = MANIFEST_MODULES, server = fakeLlamaServer({ report: () => SPLIT_REPORT }), ...extra } = {}) {
  const made = localIn(tmp(), { specs: async () => PC, port: 0, modules, spawn: server.spawn, fetch: server.fetch, ...extra })
  writeFileSync(join(made.engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  mkdirSync(join(made.engineDir, '.installed'))
  writeFileSync(join(made.engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  for (const id of ids) writeFileSync(join(made.modelsDir, modules.find((m) => m.id === id).file), id)
  await made.local.installed()
  await made.local.settled()
  return { ...made, server }
}
/** Until the speed run has ended; its status then. */
async function speedEnded(local, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = (await local.status()).speedRun
    if (run?.state === 'idle') return run
    if (Date.now() > deadline) throw new Error(`the speed run did not end: ${JSON.stringify(run)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const modelIn = async (local, id) => (await local.status()).modules.find((m) => m.id === id)
const measuredRequests = (server) => server.to('/completion').filter((r) => r.body.n_predict === 128)

test('readTimings works both speeds out from llama-server\'s own counts and milliseconds, and refuses timings it cannot trust, each with its reason', () => {
  assert.equal(typeof localJs.readTimings, 'function', 'local.js exports readTimings')
  const { readTimings } = localJs
  // The rate fields are there, and wrong: the speeds come from the counts and the milliseconds.
  // predicted_ms times the 127 tokens after the first, which the prompt pass gives (llama-server b10964).
  const body = (t = {}) => ({ content: '...', timings: { prompt_n: 8192, prompt_ms: 20480, predicted_n: 128, predicted_ms: 6350, prompt_per_second: 1, predicted_per_second: 1, ...t } })
  assert.deepEqual(readTimings(body(), { nPredict: 128 }), { ok: true, tokensPerSec: 20, promptTokensPerSec: 400, promptTokens: 8192 })
  // The real server's own figures of one timed request: 207.99 ms for 128 tokens is its 610.61 tokens/s.
  assert.equal(readTimings({ timings: { prompt_n: 1, prompt_ms: 2.52, predicted_n: 128, predicted_ms: 207.99 } }, { nPredict: 128 }).tokensPerSec.toFixed(2), '610.61')
  // The fill generates one token, from the prompt pass: no generation is timed, and its predicted_ms may be 0.
  assert.deepEqual(readTimings(body({ predicted_n: 1, predicted_ms: 0 }), { nPredict: 1 }), { ok: true, tokensPerSec: null, promptTokensPerSec: 400, promptTokens: 8192 })
  // No timings, or one of the four fields missing or no positive finite number: never read as zero.
  const untrusted = { ok: false, reason: 'llama-server did not report its timings' }
  assert.deepEqual(readTimings({ content: '...' }, { nPredict: 128 }), untrusted)
  assert.deepEqual(readTimings(null, { nPredict: 128 }), untrusted)
  for (const t of [{ prompt_n: undefined }, { prompt_ms: 0 }, { predicted_n: -128 }, { predicted_ms: 'fast' }, { predicted_ms: Infinity }, { prompt_ms: Number.NaN }]) {
    assert.deepEqual(readTimings(body(t), { nPredict: 128 }), untrusted, JSON.stringify(t))
  }
  // Every model generates exactly the tokens asked for, or two would be timed on different lengths.
  assert.deepEqual(readTimings(body({ predicted_n: 100 }), { nPredict: 128 }), { ok: false, reason: 'llama-server generated 100 tokens, not 128' })
})

test('a speed run loads the model afresh through reload(), which waits until nothing holds the engine, at the planned context, also when that model is loaded already', async () => {
  const server = fakeLlamaServer()
  const { local } = await speedIn({ ids: ['wide'], modules: [...MANIFEST_MODULES, WIDE], server })
  assert.equal(typeof local.reload, 'function', 'the local models reload a model')
  assert.equal(typeof local.benchmark, 'function', 'and run a speed benchmark')
  // Loaded at the 32k it asks for; then a budget sizes its next load to 21k while it stays loaded.
  await local.start('wide')
  await local.setSettings({ maxRamGB: 1.25 })
  assert.equal((await modelIn(local, 'wide')).ctx, 21504)
  await local.start('wide')
  assert.equal(server.started.length, 1, 'acquire() reuses the running engine and the context it was started with')
  // reload() waits while a request holds the engine: it would unload the model mid-answer.
  const conn = await local.acquire('wide')
  let reloaded = false
  const reloading = local.reload('wide').then((c) => { reloaded = true; return c })
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual([reloaded, server.started.length], [false, 1], 'nothing is stopped while a request holds the engine')
  conn.release()
  const again = await reloading
  assert.equal(server.started.length, 2, 'then it is stopped and started again')
  assert.equal(server.started[0].child.exitCode, 0, 'the old load was stopped')
  assert.equal(server.started[1].ctx, 21504, 'at the context the plan gives today')
  assert.equal(local.isBusy(), true, 'and it holds the engine until released')
  again.release()
  assert.equal(local.isBusy(), false)
  // A speed run does the same for the model loaded now: loaded again, under today's settings.
  await local.setSettings({ maxRamGB: 1.05 })
  assert.deepEqual(await local.benchmark({ ids: ['wide'] }), ['wide'])
  await speedEnded(local)
  assert.equal(server.started.length, 3)
  assert.equal(server.started[2].ctx, 19456)
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['wide@19456'])
  await local.dispose()
})

test('a speed run sends a warm-up, a fill of exactly the first 8,192 tokens of the speed text, and three timed generations of 128 tokens, all with the engine\'s key, and keeps the median and all three', async () => {
  // The three timed generations at 19.5, 21 and 20 tokens a second: the median is 20.
  const tps = [19.5, 21, 20]
  const server = fakeLlamaServer({
    report: () => SPLIT_REPORT,
    timings: (entry, worked) => (entry.body.n_predict === 128 ? { ...worked, predicted_ms: (127 / tps[measured++]) * 1000 } : worked),
  })
  let measured = 0
  const { local } = await speedIn({ server })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  assert.deepEqual(await local.benchmark(), ['big'], 'Benchmark all: every installed chat model')
  const run = await speedEnded(local)
  const [started] = server.started
  // In order: the warm-up, the speed text in the model's own tokens, the fill, three generations.
  assert.deepEqual(server.requests.map((r) => [r.path, r.body.n_predict ?? null]), [['/completion', 16], ['/tokenize', null], ['/completion', 1], ['/completion', 128], ['/completion', 128], ['/completion', 128]])
  for (const r of server.requests) assert.equal(r.headers.authorization, `Bearer ${started.key}`, `${r.path} carries the engine's own key`)
  assert.deepEqual(server.to('/tokenize')[0].body, { content: localJs.SPEED_TEXT })
  const [, fill, ...timed] = server.to('/completion')
  const first = Array.from({ length: 8192 }, (_, n) => 1000 + n)
  assert.deepEqual(fill.body, { prompt: first, n_predict: 1, ignore_eos: true, cache_prompt: true, temperature: 0, seed: 1, stream: true })
  for (const t of timed) assert.deepEqual(t.body, { prompt: first, n_predict: 128, ignore_eos: true, cache_prompt: true, temperature: 0, seed: 1, stream: true })
  // The speed text is synthetic, fixed and long: far more than 8,192 tokens in any tokenizer.
  assert.ok(localJs.SPEED_TEXT.length > 60_000 && localJs.SPEED_TEXT.length < 70_000, String(localJs.SPEED_TEXT.length))
  assert.match(localJs.SPEED_TEXT, /^\/\/ Step 1 of the pipeline\.\nfunction step1\(value\) \{/)
  // Kept under the model and the context it ran at, beside the memory reading of the same load.
  const s = await local.readSettings()
  assert.deepEqual(Object.keys(s.speed), ['big@12288'])
  assert.deepEqual(Object.keys(s.measured), ['big@12288'])
  const r = s.speed['big@12288']
  assert.deepEqual({ ...r, at: null, loadMs: null }, {
    at: null, tokensPerSec: 20, promptTokensPerSec: 400, depth: 8192, nPredict: 128,
    runs: [{ tokensPerSec: 19.5 }, { tokensPerSec: 21 }, { tokensPerSec: 20 }],
    loadMs: null, roomGB: 4, gpuLayers: 'auto', threads: 4,
    engine: { variant: 'cuda12', sha256: sha('e') }, weights: { file: 'big.gguf', sha256: sha('big') }, layersOnGpu: { gpu: 29, total: 37 }, vision: false, laya: null,
  })
  assert.ok(Number.isFinite(r.loadMs) && r.loadMs >= 0, 'the load time from spawn to a healthy /health')
  assert.ok(Math.abs(Date.parse(r.at) - Date.now()) < 60_000)
  assert.deepEqual(run.done, [{ id: 'big', ok: true, text: 'Big: 20.0 tokens/s generating and 400 tokens/s reading, 8,192 tokens into a conversation, at 12k context.' }])
  await local.dispose()
})

test('every speed run is logged: its summary appended to speed-runs.log, and every phase, request and engine line of it in its own detail log', async () => {
  assert.equal(localJs.SPEED_HISTORY, 'speed-runs.log', 'local.js names the speed run history')
  const logs = join(tmp(), 'speed-runs')
  // Small's timed requests come back short, so it records nothing, with the reason.
  const server = fakeLlamaServer({ report: () => SPLIT_REPORT, timings: (entry, worked) => (entry.model === 'small' && entry.body.n_predict === 128 ? { ...worked, predicted_n: 100 } : worked) })
  const { local } = await speedIn({ ids: ['big', 'small'], server, speedLogDir: logs })
  await local.benchmark({ by: 'Speed-Run.bat' })
  const run = await speedEnded(local)
  // Where they are, for the card, and each model's figures for the shell's table.
  const detail = readdirSync(logs).filter((f) => /^speed-run-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.log$/.test(f))
  assert.equal(detail.length, 1)
  assert.deepEqual(run.log, { history: join(logs, 'speed-runs.log'), detail: join(logs, detail[0]) })
  assert.equal(run.logError, null)
  const results = local.speedResults()
  assert.deepEqual(results.order, ['big', 'small'])
  assert.deepEqual(results.done.map((d) => [d.id, d.ok, d.ctx ?? null, d.why ?? null]), [['big', true, 12288, null], ['small', false, null, 'llama-server generated 100 tokens, not 128']])
  assert.deepEqual(results.done[0].memory, { vramGB: 3.5, ramGB: 1, totalGB: 4.5, gpuFraction: 0.8 })
  assert.equal(results.done[0].reading.tokensPerSec, 20)

  // The history: one entry, the machine it ran on, each model's figures or why, the restore, the detail log's name.
  const history = readFileSync(join(logs, 'speed-runs.log'), 'utf8')
  const lines = history.split('\n')
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Speed-Run\.bat: 1 of 2 measured$/)
  assert.equal(lines[1], '  PC: RTX 3050 Laptop 4 GB, 24 GB RAM, Core i5-11400H 6 cores, 52 GB free; engine: cuda12 build ' + sha('e').slice(0, 12) + '; budget: GPU layers auto; no Laya held')
  assert.equal(lines[2], '  Big    20.0 tokens/s generating, 400 tokens/s reading, 12k context, 29/37 layers on the GPU, 3.5 GB VRAM + 1.0 GB RAM, loaded in ' + (results.done[0].reading.loadMs / 1000).toFixed(1) + ' s, 4 threads')
  assert.equal(lines[3], '  Small  not measured: llama-server generated 100 tokens, not 128')
  assert.equal(lines[4], '  The engine is stopped again, as it was before.')
  assert.equal(lines[5], `  Details: ${detail[0]}`)
  assert.deepEqual(lines.slice(6), ['', ''], 'a blank line after each entry')
  assert.ok(/^[\x20-\x7e\n]*$/.test(history), 'plain ASCII, for any editor on Windows')

  // The detail log: the head, then every step with its time, in order.
  const text = readFileSync(join(logs, detail[0]), 'utf8')
  assert.match(text, /^KzH speed run, started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC from Speed-Run\.bat\nPC: RTX 3050 Laptop 4 GB, 24 GB RAM, Core i5-11400H 6 cores, 52 GB free\nEngine: llama\.cpp cuda12 build, sha256 [0-9a-f]{64}\nBudget: GPU layers auto\nLaya: none held\nModels, in this order: Big \(big\), Small \(small\)\n/)
  const steps = text.split('\n').filter((l) => /^\d\d:\d\d:\d\d\.\d{3} {2}/.test(l)).map((l) => l.slice(14))
  const want = [
    /^speed benchmark of big, small$/,
    /^Big: loading at the context its runs get$/,
    /^engine starting big on 127\.0\.0\.1:\d+ \(ctx 12288, GPU layers auto, 4 threads, \d+ MiB kept free on the GPU\)$/,
    /^Big: warm-up request, not timed$/,
    /^Big: reading the 8,192-token prompt$/,
    /^Big: read 8192 tokens of prompt at 400 tokens\/s$/,
    /^Big: timed request 1 of 3$/, /^Big: timed request 1 of 3: 20\.0 tokens\/s generating$/,
    /^Big: timed request 2 of 3$/, /^Big: timed request 2 of 3: 20\.0 tokens\/s generating$/,
    /^Big: timed request 3 of 3$/, /^Big: timed request 3 of 3: 20\.0 tokens\/s generating$/,
    /^Big: 20\.0 tokens\/s generating and 400 tokens\/s reading, 8,192 tokens into a conversation, at 12k context\.$/,
    /^Small: loading at the context its runs get$/,
  ]
  let at = 0
  for (const line of steps) if (at < want.length && want[at].test(line)) at++
  assert.equal(at, want.length, `every step in order; stopped before ${want[at]}:\n${steps.join('\n')}`)
  assert.ok(steps.includes('Small not measured: llama-server generated 100 tokens, not 128'))
  // llama-server's own lines, whole, as it printed them: its load report among them.
  for (const l of SPLIT_REPORT) assert.ok(steps.includes(`llama-server: ${l}`), l)
  assert.ok(steps.includes('putting the engine back as it was'))
  assert.equal(steps.at(-1), 'The engine is stopped again, as it was before.')
  assert.match(text, /\nEnded after \d+\.\d s\. The summary is in speed-runs\.log\.\n$/)

  // A second run adds an entry and a detail log of its own; lines logged after a run go to neither.
  await local.benchmark({ ids: ['big'] })
  await speedEnded(local)
  const after = readFileSync(join(logs, 'speed-runs.log'), 'utf8')
  assert.ok(after.startsWith(history), 'the history is appended to, never rewritten')
  assert.match(after.slice(history.length), /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, Settings, Local models: 1 of 1 measured\n/)
  const second = readdirSync(logs).filter((f) => f.startsWith('speed-run-') && f !== detail[0])
  assert.equal(second.length, 1)
  // The second run measured Big alone; Small loaded after it has ended is in neither detail log.
  const secondText = readFileSync(join(logs, second[0]), 'utf8')
  await local.start('small')
  assert.equal(readFileSync(join(logs, second[0]), 'utf8'), secondText, 'a finished run\'s detail log takes nothing more')
  assert.ok(!secondText.includes('engine starting small'))
  await local.dispose()

  // Who started it is a short text; anything else is refused before the run starts.
  const { local: other } = await speedIn({ speedLogDir: join(tmp(), 'speed-runs') })
  for (const by of ['', '   ', 'x'.repeat(61), 7]) await assert.rejects(other.benchmark({ by }), (err) => err.status === 400 && /^by: /.test(err.message))
  await other.dispose()
})

test('Benchmark all names a model whose file does not match the manifest as not measured, first, and counts the models it measures on from it', async () => {
  const server = fakeLlamaServer({ report: () => SPLIT_REPORT })
  const { local, modelsDir } = await speedIn({ ids: ['big'], server })
  writeFileSync(join(modelsDir, 'small.gguf'), 'not small')
  await local.status()
  await local.settled()
  const held = server.hold((e) => e.body?.n_predict === 128)
  assert.deepEqual(await local.benchmark(), ['small', 'big'])
  await held.arrived
  const run = (await local.status()).speedRun
  assert.deepEqual(run.done, [{ id: 'small', ok: false, text: "Small not measured: its file does not match the manifest's SHA256; install it again (type /install-llm small)" }])
  assert.equal(run.current.id, 'big')
  // A local agent waiting on the run is told which model of how many it is on: Big, the second.
  const said = []
  const waiting = local.localAgentAttempt(async () => 'ran', { onWait: (t) => said.push(t) })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(said, ['Waiting for the speed benchmark to finish (Big, 2 of 2).'])
  held.release()
  const ended = await speedEnded(local)
  assert.equal(await waiting, 'ran')
  assert.deepEqual(ended.done.map((d) => [d.id, d.ok]), [['small', false], ['big', true]])
  // Named, it is refused with the same why.
  await assert.rejects(local.benchmark({ ids: ['small'] }), (err) => err.status === 400 && err.message === "Small cannot be measured: its file does not match the manifest's SHA256; install it again (type /install-llm small).")
  await local.dispose()
})

test('a speed run cut off before its end (KzH killed for a restart or an update) gets its history entry when the local models next start', async () => {
  const logs = join(tmp(), 'speed-runs')
  mkdirSync(logs, { recursive: true })
  const cut = 'speed-run-2026-09-26T05-18-59-100Z.log'
  writeFileSync(join(logs, cut), [
    'KzH speed run, started 2026-09-26 05:18:59 UTC from Settings, Local models', 'PC: RTX 3080 10 GB', '',
    '05:18:59.515  speed benchmark of big, small',
    '05:18:59.516  Big: loading at the context its runs get',
    '05:19:30.001  Big: 71.3 tokens/s generating and 2210 tokens/s reading, 8,192 tokens into a conversation, at 16k context.',
    '05:19:30.002  Small: loading at the context its runs get',
    '05:19:31.100  llama-server: load_tensors: offloaded 37/37 layers to GPU',
    '',
  ].join('\n'))
  // One that ended, and one the history already has (Speed-Run.bat's own "ended by" entry): both left alone.
  writeFileSync(join(logs, 'speed-run-2026-09-25T10-00-00-000Z.log'), 'KzH speed run, started 2026-09-25 10:00:00 UTC from Speed-Run.bat\n\nEnded after 12.0 s. The summary is in speed-runs.log.\n')
  writeFileSync(join(logs, 'speed-run-2026-09-25T11-00-00-000Z.log'), 'KzH speed run, started 2026-09-25 11:00:00 UTC from Speed-Run.bat\n')
  const had = '2026-09-25 11:00 UTC, Speed-Run.bat: ended by SIGHUP while it measured (its console was closed, or it was stopped). Readings already taken are kept.\n  Details: speed-run-2026-09-25T11-00-00-000Z.log\n\n'
  writeFileSync(join(logs, 'speed-runs.log'), had)
  const said = []
  const { local } = localIn(tmp(), { speedLogDir: logs, log: (t) => said.push(t) })
  assert.equal(typeof local.speedLogsRecovered, 'function', 'the local models look for a speed run cut off before its end')
  await local.speedLogsRecovered()
  assert.equal(readFileSync(join(logs, 'speed-runs.log'), 'utf8'), had + [
    '2026-09-26 05:18 UTC, Settings, Local models: cut off before it ended (KzH was closed, restarted or updated during it, or it stopped); found when the local models next started',
    '  Big: 71.3 tokens/s generating and 2210 tokens/s reading, 8,192 tokens into a conversation, at 16k context.',
    '  Readings of the models it had finished are kept.',
    `  Details: ${cut} (it ends where the run was cut off)`, '', '',
  ].join('\n'))
  assert.ok(said.includes(`local: a speed run cut off before its end is now in speed-runs.log (${cut})`))
  await local.dispose()
  // Once written, never again.
  const again = localIn(tmp(), { speedLogDir: logs })
  await again.local.speedLogsRecovered()
  assert.equal(readFileSync(join(logs, 'speed-runs.log'), 'utf8').split(cut).length - 1, 1)
  await again.local.dispose()

  // A Speed-Run going in another process holds the lock: its detail log is still being written.
  const busy = join(tmp(), 'speed-runs')
  mkdirSync(busy, { recursive: true })
  writeFileSync(join(busy, 'speed-run-2026-09-26T06-00-00-000Z.log'), 'KzH speed run, started 2026-09-26 06:00:00 UTC from Speed-Run.bat\n')
  writeFileSync(join(busy, localJs.SPEED_LOCK), String(process.ppid))
  const held = localIn(tmp(), { speedLogDir: busy })
  await held.local.speedLogsRecovered()
  assert.ok(!existsSync(join(busy, 'speed-runs.log')))
  await held.local.dispose()
})

test('a model\'s row in the speed run history says a figure its reading lacks is missing, never a zero', () => {
  assert.equal(typeof localJs.speedFigures, 'function', 'local.js words a model\'s row in the speed run history')
  const { speedFigures } = localJs
  const line = { ctx: 16384, memory: { vramGB: 6, ramGB: 0.5 }, reading: { tokensPerSec: 64, promptTokensPerSec: 2048, layersOnGpu: { gpu: 37, total: 37 }, loadMs: 4200, threads: 1 } }
  assert.equal(speedFigures(line), '64.0 tokens/s generating, 2048 tokens/s reading, 16k context, 37/37 layers on the GPU, 6.0 GB VRAM + 0.5 GB RAM, loaded in 4.2 s, 1 thread')
  const bare = { ctx: 12500, memory: null, reading: { tokensPerSec: 3.25, promptTokensPerSec: null, layersOnGpu: null, loadMs: null, threads: undefined } }
  assert.equal(speedFigures(bare), '3.3 tokens/s generating, reading speed not measured (prompt cache), 12500-token context, layers on the GPU not reported, memory not reported, load time not reported, threads not reported')
})

test('a speed run log that cannot be written never stops the run: the readings are kept, and the status says what failed', async () => {
  const root = tmp()
  // A file where the logs' folder should be: neither log can be made.
  writeFileSync(join(root, 'speed-runs'), 'in the way')
  const said = []
  const { local } = await speedIn({ speedLogDir: join(root, 'speed-runs'), log: (t) => said.push(t) })
  await local.benchmark()
  const run = await speedEnded(local)
  assert.equal(run.done[0].ok, true, run.done[0].text)
  assert.ok((await local.readSettings()).speed['big@12288'], 'the reading is kept')
  assert.match(run.logError, /^.*speed-runs: (EEXIST|ENOTDIR)$/)
  assert.ok(said.some((l) => /^local: the speed run log could not be written \(/.test(l)), said.join('\n'))
  await local.dispose()
  // With no folder given, nothing is logged and nothing is said of it.
  const { local: none } = await speedIn()
  await none.benchmark()
  const bare = await speedEnded(none)
  assert.deepEqual([bare.log, bare.logError], [null, null])
  await none.dispose()
})

test('every /completion of a speed run is streamed, so text llama-server\'s output parser refuses is measured all the same, and an error says what llama-server said', async () => {
  // llama-server b10964 parses the whole of an answer that is not streamed at the end and answers
  // HTTP 500 when its parser refuses the text; a streamed answer ends with its timings all the same.
  const refusing = fakeLlamaServer({ report: () => SPLIT_REPORT, parserRefuses: () => true })
  const { local } = await speedIn({ server: refusing })
  await local.benchmark()
  const run = await speedEnded(local)
  assert.equal(run.done[0].ok, true, run.done[0].text)
  assert.ok(refusing.to('/completion').every((r) => r.body.stream === true), 'the warm-up, the fill and the timed requests are streamed')
  await local.dispose()

  // What each failure says, in llama-server's own words rather than its JSON.
  const failing = async (answer) => {
    const base = fakeLlamaServer({ report: () => SPLIT_REPORT })
    const fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null
      if (String(url).endsWith('/completion') && body?.n_predict === 128) return answer()
      return base.fetch(url, init)
    }
    const { local: l } = await speedIn({ server: { ...base, fetch } })
    await l.benchmark()
    const [line] = (await speedEnded(l)).done
    await l.dispose()
    return line
  }
  const sse = (...events) => () => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  assert.equal((await failing(json(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }))).text, 'Big not measured: llama-server answered HTTP 503: Loading model')
  assert.equal((await failing(sse({ content: 'x', stop: false }, { error: { code: 500, message: 'The model produced output that does not match the expected Content-only format.' } }))).text, 'Big not measured: llama-server stopped with an error: The model produced output that does not match the expected Content-only format')
  assert.equal((await failing(sse({ content: 'x', stop: false }))).text, 'Big not measured: llama-server ended its answer before it finished')
  // An error given as text alone, or with no message, is said as it is, never as "[object Object]" or in quotes.
  assert.equal((await failing(sse({ error: 'slot unavailable' }))).text, 'Big not measured: llama-server stopped with an error: slot unavailable')
  assert.equal((await failing(sse({ error: { code: 500, message: { detail: 'x' } } }))).text, 'Big not measured: llama-server stopped with an error: {"code":500,"message":{"detail":"x"}}')
  assert.equal((await failing(json(503, { error: 'busy' }))).text, 'Big not measured: llama-server answered HTTP 503: busy')
  assert.equal((await failing(json(500, { error: { code: 500 } }))).text, 'Big not measured: llama-server answered HTTP 500: {"error":{"code":500}}')
  assert.equal((await failing(() => new Response('data: {nope\n\n', { headers: { 'content-type': 'text/event-stream' } }))).text, 'Big not measured: llama-server answered with something that is not JSON')
})

test('a reading takes its key and its conditions from the engine that ran, never from a plan made after it', async () => {
  const server = fakeLlamaServer()
  const { local } = await speedIn({ ids: ['wide'], modules: [...MANIFEST_MODULES, WIDE], server })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const held = server.hold((e) => e.body?.n_predict === 1)
  await local.benchmark({ ids: ['wide'] })
  await held.arrived
  // While it is measured, the budget changes: its next load would get 21k and two threads.
  await local.setSettings({ maxRamGB: 1.25, maxCores: 2 })
  held.release()
  await speedEnded(local)
  const { speed } = await local.readSettings()
  assert.deepEqual(Object.keys(speed), ['wide@32768'], 'under the context it really ran with')
  assert.deepEqual([speed['wide@32768'].threads, speed['wide@32768'].roomGB, speed['wide@32768'].gpuLayers], [4, 4, 'auto'])
  // And for the next load it does not stand, and the card is told why.
  const next = (await modelIn(local, 'wide')).speed
  assert.deepEqual([next.stands, next.why], [false, 'it was measured at 32k context and the next load gets 21k'])
  assert.equal(next.reading.tokensPerSec, 20)
  await local.dispose()
})

test('a speed text shorter than the depth records nothing and says so; a fill served from the prompt cache keeps the generation speed and says the reading speed was not measured', async () => {
  const short = fakeLlamaServer({ tokens: () => 8000 })
  const { local } = await speedIn({ server: short })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  await local.benchmark()
  assert.deepEqual((await speedEnded(local)).done, [{ id: 'big', ok: false, text: 'Big not measured: the speed text is shorter than 8,192 tokens for this model' }])
  assert.deepEqual((await local.readSettings()).speed, {})
  assert.equal(short.to('/completion').filter((r) => r.body.n_predict !== 16).length, 0, 'nothing is timed on a prompt it cannot fill')
  await local.dispose()

  // The fill reads 100 tokens: llama-server had most of the prompt in its cache already.
  const cached = fakeLlamaServer({ timings: (entry, worked) => (entry.body.n_predict === 1 ? { ...worked, prompt_n: 100 } : worked) })
  const { local: again } = await speedIn({ server: cached })
  await again.benchmark()
  const run = await speedEnded(again)
  const r = (await again.readSettings()).speed['big@12288']
  assert.deepEqual([r.tokensPerSec, r.promptTokensPerSec], [20, null])
  assert.equal(run.done[0].text, 'Big: 20.0 tokens/s generating; its reading speed was not measured, because llama-server reused its prompt cache, 8,192 tokens into a conversation, at 12k context.')
  await again.dispose()
})

test('three generation speeds more than 15 percent apart record nothing; a request that had company is run again, and after three repeats nothing is recorded', async () => {
  // 20, 20 and 24 tokens a second: 4 apart, over 15 percent of the median 20.
  const tps = [20, 20, 24]
  let n = 0
  const spread = fakeLlamaServer({ timings: (entry, worked) => (entry.body.n_predict === 128 ? { ...worked, predicted_ms: (127 / tps[n++]) * 1000 } : worked) })
  const { local } = await speedIn({ server: spread })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  await local.benchmark()
  assert.deepEqual((await speedEnded(local)).done.map((d) => d.text), ['Big not measured: the three runs disagreed; something else was using the machine'])
  assert.deepEqual((await local.readSettings()).speed, {})
  await local.dispose()

  // A chat title for the model being measured reaches the engine during the first timed request,
  // and Laya is answering a call as the second starts: each is run again, and three are kept.
  let layaBusy = false
  const company = fakeLlamaServer()
  const { local: busy } = await speedIn({ server: company, layaBusy: () => layaBusy })
  const first = company.hold((e) => e.body?.n_predict === 128)
  await busy.benchmark()
  await first.arrived
  await busy.start('big')
  layaBusy = true
  const second = company.hold((e) => e.body?.n_predict === 128)
  first.release()
  await second.arrived
  layaBusy = false
  second.release()
  const run = await speedEnded(busy)
  assert.equal(run.done[0].ok, true, run.done[0].text)
  assert.equal(measuredRequests(company).length, 5, 'three timed requests and the two that had company')
  assert.equal((await busy.readSettings()).speed['big@12288'].runs.length, 3)
  await busy.dispose()

  // Laya answers through every one of them: the first and three repeats, then nothing is recorded.
  layaBusy = false
  const always = fakeLlamaServer()
  const { local: noisy } = await speedIn({ server: always, layaBusy: () => layaBusy })
  const hold = always.hold((e) => e.body?.n_predict === 128)
  await noisy.benchmark()
  await hold.arrived
  layaBusy = true
  hold.release()
  assert.deepEqual((await speedEnded(noisy)).done.map((d) => d.text), ['Big not measured: other requests kept arriving while it was measured'])
  assert.equal(measuredRequests(always).length, 4)
  assert.deepEqual((await noisy.readSettings()).speed, {})
  await noisy.dispose()
})

test('a speed reading stands only for a load of the same weights with the same context, GPU room, GPU layers, threads, engine build, depth and Laya, and each difference says so in its own words', async () => {
  assert.equal(typeof localJs.speedFor, 'function', 'local.js exports speedFor')
  const { speedFor } = localJs
  const weights = { file: 'big.gguf', sha256: sha('big') }
  const reading = { at: '2026-09-25T10:00:00.000Z', tokensPerSec: 21.2, promptTokensPerSec: 412.7, depth: 8192, nPredict: 128, roomGB: 4, gpuLayers: 'auto', threads: 6, engine: { variant: 'cuda12', sha256: sha('e') }, weights, layersOnGpu: { gpu: 29, total: 37 }, vision: false, laya: null }
  const s = { speed: { 'big@16384': reading, 'small@16384': { ...reading, tokensPerSec: 47 } } }
  const next = { ctx: 16384, roomGB: 4, gpuLayers: 'auto', threads: 6, engine: { variant: 'cuda12', sha256: sha('e') }, weights, depth: 8192, laya: null }
  assert.deepEqual(speedFor(s, 'big', next), { reading, stands: true, why: null })
  assert.deepEqual(speedFor({ speed: {} }, 'big', next), { reading: null, stands: false, why: null })
  assert.deepEqual(speedFor({}, 'big', next), { reading: null, stands: false, why: null }, 'a local.json from before there were speed readings')
  for (const [change, why] of [
    [{ ctx: 14336 }, 'it was measured at 16k context and the next load gets 14k'],
    [{ ctx: 16000 }, 'it was measured at a context of 16384 tokens and the next load gets 16000'],
    [{ threads: 4 }, 'it was measured with 6 threads and the next load gets 4'],
    [{ roomGB: 2 }, 'it was measured with 4 GB of GPU room and the VRAM budget now leaves 2 GB'],
    [{ gpuLayers: 20 }, 'it was measured with GPU layers auto and they are now pinned to 20'],
    [{ engine: { variant: 'cuda12', sha256: sha('newer') } }, 'it was measured on another engine build'],
    [{ engine: { variant: 'vulkan', sha256: sha('e') } }, 'it was measured on another engine build'],
    [{ engine: null }, 'it was measured on another engine build'],
    [{ laya: 'cuda' }, 'it was measured without Laya beside it and Laya is now on the GPU beside it'],
    [{ depth: 4096 }, 'it was measured at another depth'],
    // Another quantisation under the same model id, as a manifest update ships it: another file and SHA-256.
    [{ weights: { file: 'big-q5.gguf', sha256: sha('big-q5') } }, 'it was measured on other weights of this model'],
    [{ weights: { file: 'big.gguf', sha256: sha('big-rebuilt') } }, 'it was measured on other weights of this model'],
  ]) {
    const got = speedFor(s, 'big', { ...next, ...change })
    assert.deepEqual([got.stands, got.why], [false, why], JSON.stringify(change))
    assert.equal(got.reading, reading, 'the reading is still given, with why it does not stand')
  }
  assert.equal(speedFor({ speed: { 'big@16384': { ...reading, gpuLayers: 20 } } }, 'big', next).why, 'it was measured with GPU layers pinned to 20 and they are now auto')
  assert.equal(speedFor({ speed: { 'big@16384': { ...reading, laya: 'cuda' } } }, 'big', next).why, 'it was measured with Laya on the GPU beside it and the next load will not have Laya beside it')
  // A reading that does not say which weights it was taken on stands for none.
  assert.equal(speedFor({ speed: { 'big@16384': { ...reading, weights: undefined } } }, 'big', next).why, 'it does not say which weights of this model it was measured on')
  assert.equal(speedFor({ speed: { 'big@16384': { ...reading, laya: 'cpu' } } }, 'big', { ...next, laya: 'cuda' }).why, 'it was measured with Laya on the CPU beside it and Laya is now on the GPU')
  assert.equal(speedFor({ speed: { 'big@16384': { ...reading, laya: 'cuda' } } }, 'big', { ...next, laya: 'cuda' }).stands, true)
  // The newest reading at another context is the one given, when there is none at the next load's.
  const older = { ...reading, at: '2026-09-20T10:00:00.000Z', tokensPerSec: 9 }
  assert.equal(speedFor({ speed: { 'big@12288': older, 'big@14336': reading } }, 'big', next).why, 'it was measured at 14k context and the next load gets 16k')
  // A model whose id is another's with more after it is not that model.
  assert.equal(speedFor({ speed: { 'big-2@16384': reading } }, 'big', next).reading, null)

  // In status(), from the real conditions of the next load; a plain load after the reading keeps it.
  const { local } = await speedIn()
  await local.benchmark()
  await speedEnded(local)
  let big = await modelIn(local, 'big')
  assert.deepEqual([big.speed.stands, big.speed.why, big.speed.reading.tokensPerSec], [true, null, 20])
  await local.stop()
  await local.start('big')
  await local.stop()
  big = await modelIn(local, 'big')
  assert.equal(big.speed.stands, true, 'a load that did not measure speed never erases a speed reading')
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['big@12288'])
  // And each setting that decides the speed takes the reading away from the next load, with its words.
  await local.setSettings({ maxCores: 3 })
  assert.equal((await modelIn(local, 'big')).speed.why, 'it was measured with 4 threads and the next load gets 3')
  await local.setSettings({ maxCores: null, maxVramGB: 2 })
  assert.equal((await modelIn(local, 'big')).speed.why, 'it was measured with 4 GB of GPU room and the VRAM budget now leaves 2 GB')
  await local.setSettings({ maxVramGB: null, gpuLayers: 20 })
  assert.equal((await modelIn(local, 'big')).speed.why, 'it was measured with GPU layers auto and they are now pinned to 20')
  await local.dispose()
})

test('a speed run is refused, each with its reason, while a local model answers, while a local agent works between its model calls and while Laya answers; a model over the budget is skipped with the budget\'s refusal word for word', async () => {
  let layaBusy = false
  const { local, server } = await speedIn({ ids: ['big', 'small'], layaBusy: () => layaBusy })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const refused = async (message, status = 400) => {
    const err = await local.benchmark().then(() => null, (e) => e)
    assert.ok(err, `refused: ${message}`)
    assert.deepEqual([err.message, err.status], [message, status])
  }
  const conn = await local.acquire('big')
  await refused('A local model is answering right now; a speed benchmark would unload it mid-answer. Try again when it is idle.')
  conn.release()
  // A local agent between its model calls: nothing holds the engine, and it is at work all the same.
  let finish
  const working = local.localAgentAttempt(() => new Promise((r) => { finish = r }))
  await new Promise((r) => setImmediate(r))
  assert.equal(local.isBusy(), false, 'no request holds the engine')
  await refused('A local agent is working on a task; start the speed benchmark when it has finished.')
  finish('done')
  assert.equal(await working, 'done')
  layaBusy = true
  await refused('Laya is answering a call right now, and would slow the measurement. Try again when it is idle.')
  layaBusy = false
  // What cannot be measured at all.
  for (const [ids, message] of [
    [['nope'], 'No local chat model is named nope.'],
    [['small-vision'], 'No local chat model is named small-vision.'],
    [['exp'], 'Exp is not installed (type /install-llm exp).'],
    [[], 'ids: the local chat models to measure, or none for every installed one'],
  ]) {
    const err = await local.benchmark({ ids }).then(() => null, (e) => e)
    assert.deepEqual([err?.message, err?.status], [message, 400], JSON.stringify(ids))
  }
  // A model over the RAM budget is skipped with the refusal a load would throw, and the others are
  // measured. One run at a time: a second is refused while the first goes.
  await local.setSettings({ maxVramGB: 2, maxRamGB: 4 })
  const over = (await modelIn(local, 'big')).overBudget
  assert.match(over, /^Big needs about 4\.7 GB of RAM/)
  const hold = server.hold((e) => e.body?.n_predict === 1)
  await local.benchmark()
  await hold.arrived
  await refused('A speed benchmark is already running.', 409)
  hold.release()
  const run = await speedEnded(local)
  // Big was loaded before the run, so it comes last; and the budget that skipped it keeps it from
  // being loaded again, which the last line says rather than claim the engine is as it was.
  assert.deepEqual(run.done.map((d) => [d.id, d.ok, d.ok ? null : d.text]), [['small', true, null], ['big', false, `Big not measured: ${over}`]])
  assert.equal(run.restore, `Could not load Big again: ${over.replace(/\.$/, '')}.`)
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['small@12288'])
  // With nothing installed there is nothing to measure.
  const { local: bare } = await speedIn({ ids: [] })
  const none = await bare.benchmark().then(() => null, (e) => e)
  assert.deepEqual([none?.message, none?.status], ['No local chat model is installed (type /install-llm).', 400])
  await bare.dispose()
  await local.dispose()
})

test('while a speed run goes, a local agent\'s attempt waits before it starts, says what it waits for as the run moves on, and starts when the run ends', async () => {
  const { local, server } = await speedIn({ ids: ['big', 'small'] })
  assert.equal(typeof local.localAgentAttempt, 'function', 'the local models hold a local agent\'s attempt back during a speed run')
  const bigFill = server.hold((e) => e.model === 'big' && e.body?.n_predict === 1)
  const smallFill = server.hold((e) => e.model === 'small' && e.body?.n_predict === 1)
  await local.benchmark()
  await bigFill.arrived
  const said = []
  let started = false
  const attempt = local.localAgentAttempt(async () => { started = true; return 'worked' }, { onWait: (t) => said.push(t) })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(started, false, 'it has not started its subagent')
  assert.deepEqual(said, ['Waiting for the speed benchmark to finish (Big, 1 of 2).'])
  bigFill.release()
  await smallFill.arrived
  assert.equal(started, false)
  assert.deepEqual(said, ['Waiting for the speed benchmark to finish (Big, 1 of 2).', 'Waiting for the speed benchmark to finish (Small, 2 of 2).'], 'a new line when the run moves on to the next model')
  smallFill.release()
  assert.equal(await attempt, 'worked', 'and it runs once the run has ended')
  assert.equal((await local.status()).speedRun.state, 'idle')
  assert.equal(said.length, 2)

  // Stopped, or out of time, while it waits: it ends with an error that says it was waiting.
  const held = server.hold((e) => e.body?.n_predict === 1)
  await local.benchmark({ ids: ['small'] })
  await held.arrived
  const stop = new AbortController()
  const waiting = local.localAgentAttempt(async () => 'never', { signal: stop.signal })
  stop.abort(new Error('stopped by the user'))
  await assert.rejects(waiting, { message: 'stopped while it waited for the speed benchmark to finish (stopped by the user)' })
  held.release()
  await speedEnded(local)
  await local.dispose()
})

test('a speed run leaves the engine as it found it: the model that was loaded is measured last and stays loaded, and an engine that was stopped is stopped again', async () => {
  const { local, server } = await speedIn({ ids: ['big', 'small'] })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  // Big loaded: Benchmark all measures Small first and Big last, so the run ends with Big loaded,
  // reloaded once, to be measured.
  await local.start('big')
  assert.deepEqual(await local.benchmark(), ['small', 'big'])
  let run = await speedEnded(local)
  assert.deepEqual(server.started.map((s) => s.model), ['big', 'small', 'big'])
  assert.equal(run.restore, 'Big is loaded again, as it was before.')
  assert.equal((await local.status()).engine.model, 'big')
  assert.equal(local.isLoaded('big'), true)
  // Only Small measured, with Big loaded: Big is loaded again after it.
  await local.benchmark({ ids: ['small'] })
  run = await speedEnded(local)
  assert.deepEqual(server.started.map((s) => s.model).slice(3), ['small', 'big'])
  assert.equal(run.restore, 'Big is loaded again, as it was before.')
  assert.equal(local.isLoaded('big'), true)
  // Nothing loaded: stopped again at the end.
  await local.stop()
  await local.benchmark()
  run = await speedEnded(local)
  assert.deepEqual(run.done.map((d) => [d.id, d.ok]), [['big', true], ['small', true]], 'manifest order')
  assert.equal(run.restore, 'The engine is stopped again, as it was before.')
  assert.equal((await local.status()).engine.running, false)
  await local.dispose()
})

test('Cancel aborts the request in flight, records nothing for that model, keeps the readings taken, and restores; during a load it stops the engine at once', async () => {
  const { local, server } = await speedIn({ ids: ['big', 'small'] })
  assert.equal(typeof local.cancelBenchmark, 'function', 'the local models cancel a speed run')
  const held = server.hold((e) => e.model === 'small' && e.body?.n_predict === 128)
  await local.benchmark()
  const request = await held.arrived
  local.cancelBenchmark()
  const run = await speedEnded(local)
  assert.deepEqual(run.done.map((d) => [d.id, d.ok, d.ok ? null : d.text]), [['big', true, null], ['small', false, 'Small not measured: cancelled']])
  assert.equal(run.restore, 'Stopped. Readings already taken are kept; the engine is stopped again, as it was before.')
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['big@12288'], "Big's reading is kept")
  assert.ok(request, 'the request was on its way')
  assert.equal(measuredRequests(server).filter((r) => r.model === 'small').length, 1, 'and it was not run again')
  assert.equal((await local.status()).engine.running, false)
  held.release()
  await local.dispose()

  // During a load there is no request to abort: the loading engine is stopped at once, rather than
  // left to load for minutes before the restore.
  let loads = false
  const slow = fakeLlamaServer({ healthy: () => loads })
  const { local: loading } = await speedIn({ server: slow })
  await loading.benchmark()
  await waitFor('the engine is loading', () => slow.started.length, (n) => n === 1, { timeoutMs: 5000 })
  const t0 = Date.now()
  loading.cancelBenchmark()
  const stopped = await speedEnded(loading)
  assert.ok(Date.now() - t0 < 2000, `stopped in ${Date.now() - t0} ms`)
  assert.equal(slow.started[0].child.exitCode, 0, 'the loading engine was stopped')
  assert.deepEqual(stopped.done.map((d) => d.text), ['Big not measured: cancelled'])
  assert.equal(stopped.restore, 'Stopped. Readings already taken are kept; the engine is stopped again, as it was before.')
  assert.equal(slow.to('/completion').length, 0)
  loads = true
  // And a Cancel with nothing running changes nothing.
  loading.cancelBenchmark()
  assert.equal((await loading.status()).speedRun.state, 'idle')
  await loading.dispose()
})

test('a settings change and a memory reading that land while a speed reading is written are all kept in local.json', async () => {
  const writes = []
  let local = null
  const server = fakeLlamaServer({
    // The load report is read as the model becomes ready, right before its memory reading is kept:
    // a settings change sent then lands beside that write.
    report: () => { writes.push(local.setSettings({ idleMinutes: 7 })); return SPLIT_REPORT },
    // The last timed request answers right before the speed reading is written.
    timings: (entry, worked) => { if (entry.body.n_predict === 128 && measuredRequests(server).length === 3) writes.push(local.setSettings({ keepWarm: true })); return worked },
  })
  ;({ local } = await speedIn({ server }))
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  await local.benchmark()
  await speedEnded(local)
  await Promise.all(writes)
  assert.equal(writes.length, 2)
  const s = await local.readSettings()
  assert.deepEqual([s.idleMinutes, s.keepWarm, Object.keys(s.measured), Object.keys(s.speed)], [7, true, ['big@12288'], ['big@12288']])
  // And settings changes sent together are all kept, not only the last one to save.
  await Promise.all([local.setSettings({ maxCores: 3 }), local.setSettings({ maxRamGB: 20 }), local.setSettings({ gpuLayers: 'auto' })])
  const after = await local.readSettings()
  assert.deepEqual([after.maxCores, after.maxRamGB, after.gpuLayers, Object.keys(after.speed)], [3, 20, 'auto', ['big@12288']])
  // setSettings never takes a speed patch: only a speed run writes readings.
  await local.setSettings({ speed: {} })
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['big@12288'])
  await local.dispose()
})

test('a held Laya beside the model is kept with its reading, and whether it is there decides whether the reading stands', async () => {
  const res = residencyStub()
  const { local } = await speedIn({ residency: res })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const laya = layaIn(res, { held: true })
  await local.benchmark()
  await speedEnded(local)
  const r = (await local.readSettings()).speed['big@12288']
  assert.equal(r?.laya, 'cuda', 'measured with Laya held on the GPU beside it')
  assert.equal((await modelIn(local, 'big')).speed.stands, true)
  // Laya let go and gone: the next load has the GPU to itself, and the reading does not stand for it.
  laya.held = false
  res.clear('laya', laya.entry)
  assert.equal((await modelIn(local, 'big')).speed.why, 'it was measured with Laya on the GPU beside it and the next load will not have Laya beside it')
  await local.dispose()
})

test('the install picker and /install-llm rate an installed model from a reading that stands, as measured, and every other one as estimated', async () => {
  const { local } = await speedIn()
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const [, , big, small] = MANIFEST_MODULES
  // Before anything is measured, every model rating is an estimate and says so.
  let c = await buildCatalog(local, PC)
  assert.deepEqual(c.modules.filter((x) => x.kind === 'model').map((x) => [x.id, x.rating.source]), [['big', 'estimated'], ['small', 'estimated'], ['exp', 'estimated']])
  assert.match(c.modules.find((x) => x.id === 'big').rating.label, /est\.\)$/)
  const suggestedBefore = c.suggestions
  await local.benchmark()
  await speedEnded(local)
  const measured = `20 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 15 words/s)`
  c = await buildCatalog(local, PC)
  assert.deepEqual(c.modules.find((x) => x.id === 'big').rating, { fit: 'split', label: `Splits GPU + CPU (29 of 37 layers on the GPU): ${measured}`, wordsPerSec: 15, source: 'measured' })
  assert.deepEqual(c.modules.find((x) => x.id === 'small').rating, rateModule(small, PC, 'cuda12'), 'not installed: nobody can have measured it')
  assert.equal(c.modules.find((x) => x.id === 'small').rating.source, 'estimated')
  assert.deepEqual(c.suggestions, suggestedBefore, 'suggest() only suggests models that are not installed, so a reading changes none of it')
  // status() carries the same rating, for the card.
  assert.deepEqual((await modelIn(local, 'big')).rating, c.modules.find((x) => x.id === 'big').rating)
  // /install-llm prints it.
  const text = (await installLlmCommand('', { local, catalog: () => buildCatalog(local, PC) })).text
  assert.ok(text.includes(`\`big\` Big · 5.0 GB · Splits GPU + CPU (29 of 37 layers on the GPU): ${measured}`), text)
  // A reading that does not stand is not used: the rating is the estimate again.
  await local.setSettings({ maxCores: 3 })
  assert.equal((await buildCatalog(local, PC)).modules.find((x) => x.id === 'big').rating.source, 'estimated')

  // Where it ran comes from the engine's own count of layers: all, some or none on the GPU. With
  // no count the estimate's fit stays, and the label says that part is estimated.
  const reading = { at: new Date().toISOString(), tokensPerSec: 21.2, depth: 8192, layersOnGpu: { gpu: 37, total: 37 } }
  assert.deepEqual(rateModule(big, PC, 'cuda12', { installed: true, speed: reading }), { fit: 'gpu', label: `Runs fully on GPU: 21 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 16 words/s)`, wordsPerSec: 16, source: 'measured' })
  assert.deepEqual(rateModule(big, PC, 'cuda12', { installed: true, speed: { ...reading, tokensPerSec: 2.9, layersOnGpu: { gpu: 0, total: 37 } } }), { fit: 'cpu', label: `CPU only: 2.9 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 2 words/s)`, wordsPerSec: 2, source: 'measured' })
  assert.deepEqual(rateModule(big, PC, 'cuda12', { installed: true, speed: { ...reading, layersOnGpu: null } }), { fit: 'split', label: `21 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 16 words/s); the engine did not report its GPU split, so where it runs is estimated`, wordsPerSec: 16, source: 'measured' })
  // A reading from another year says the year.
  assert.match(rateModule(big, PC, 'cuda12', { installed: true, speed: { ...reading, at: '2024-03-02T12:00:00.000Z' } }).label, / on 2 Mar 2024, /)
  await local.dispose()
})

test('a model the RAM watchdog unloads while it is measured, or one that does not load, records nothing and says why, and the run goes on', async () => {
  let clock = 0
  const rss = { 2147483647: 6 * 1024 ** 3 }
  const { local, server } = await speedIn({ ids: ['big', 'small'], now: () => clock, readWorkingSet: async (pid) => rss[pid] ?? null, watchEveryMs: 3_600_000 })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  await local.setSettings({ maxRamGB: 5 })
  // Big's working set stays over the 5 GB budget for 30 seconds while its first generation is timed.
  const held = server.hold((e) => e.model === 'big' && e.body?.n_predict === 128)
  await local.benchmark()
  await held.arrived
  await local.checkMemory()
  clock += 30_000
  await local.checkMemory()
  assert.equal((await local.status()).engine.running, false, 'the watchdog unloaded it')
  rss[2147483647] = 1 * 1024 ** 3
  held.release()
  const run = await speedEnded(local)
  assert.deepEqual(run.done.map((d) => d.text).slice(0, 1), ['Big not measured: the RAM watchdog unloaded it: its working set stayed over the 5 GB RAM budget for 30 s (last reading 6 GB)'])
  assert.equal(run.done[1].ok, true, 'Small is measured all the same')
  assert.deepEqual(Object.keys((await local.readSettings()).speed), ['small@12288'])
  await local.dispose()

  // An engine that exits while it loads.
  const broken = fakeLlamaServer({ healthy: () => false })
  const { local: failing } = await speedIn({ server: broken })
  await failing.benchmark()
  await waitFor('the engine is loading', () => broken.started.length, (n) => n === 1, { timeoutMs: 5000 })
  broken.started[0].child.stderr.emit('data', 'CUDA error: out of memory\n')
  broken.started[0].child.kill()
  const failed = await speedEnded(failing)
  assert.deepEqual(failed.done.map((d) => d.text), ['Big not measured: it did not load (llama-server exited: CUDA error: out of memory)'])
  await failing.dispose()
})

test('a speed reading records the Laya that was resident when the model loaded, held or not: one answering a call as the load starts, and one let go while it is measured', async () => {
  // A Laya nothing holds, answering a call (a shadow of a Jev Auto run, say) when the load starts: it
  // does not give way, so the layers are placed around it on the GPU, whatever it does after.
  const res = residencyStub()
  const answering = layaIn(res, { held: false })
  const { local, server } = await speedIn({ residency: res, layaBusy: () => answering.busy })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const warm = server.hold((e) => e.body?.n_predict === 16)
  await local.benchmark()
  answering.busy = true
  await warm.arrived
  assert.deepEqual(answering.unloads, [], 'it did not give way to the load')
  // Its call ends before the timed requests, and it stays resident, idle, through them.
  answering.busy = false
  warm.release()
  assert.equal((await speedEnded(local)).done[0].ok, true)
  assert.equal((await local.readSettings()).speed['big@12288'].laya, 'cuda', 'measured beside a Laya on the GPU')
  // Nothing holds it, so the next load has the GPU to itself: the reading does not stand for that load.
  assert.deepEqual([(await modelIn(local, 'big')).speed.stands, (await modelIn(local, 'big')).speed.why], [false, 'it was measured with Laya on the GPU beside it and the next load will not have Laya beside it'])
  await local.dispose()

  // A Laya held when the model loads (a Laya Auto run, say) and let go while the prompt is read: it
  // stays resident, and the reading is still one taken beside it.
  const res2 = residencyStub()
  const held = layaIn(res2, { held: true })
  const { local: local2, server: server2 } = await speedIn({ residency: res2 })
  const fill = server2.hold((e) => e.body?.n_predict === 1)
  await local2.benchmark()
  await fill.arrived
  held.held = false
  fill.release()
  assert.equal((await speedEnded(local2)).done[0].ok, true)
  assert.equal((await local2.readSettings()).speed['big@12288'].laya, 'cuda')
  assert.equal((await modelIn(local2, 'big')).speed.why, 'it was measured with Laya on the GPU beside it and the next load will not have Laya beside it')
  await local2.dispose()
})

test('a Laya loaded or unloaded beside the model while it is measured leaves nothing recorded, and says why: the split the model loaded with is not the one that ran', async () => {
  const notMeasured = ['Big not measured: Laya was loaded or unloaded beside it while it was measured']
  // Unloaded while the prompt is read: the layers were placed around it.
  const res = residencyStub()
  const laya = layaIn(res, { held: true })
  const { local, server } = await speedIn({ residency: res })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  const fill = server.hold((e) => e.body?.n_predict === 1)
  await local.benchmark()
  await fill.arrived
  res.clear('laya', laya.entry)
  fill.release()
  assert.deepEqual((await speedEnded(local)).done.map((d) => d.text), notMeasured)
  assert.deepEqual((await local.readSettings()).speed, {})
  await local.dispose()

  // Loaded during a timed request, after the layers had the GPU to themselves.
  const res2 = residencyStub()
  const { local: local2, server: server2 } = await speedIn({ residency: res2 })
  const second = server2.hold((e) => e.body?.n_predict === 128)
  await local2.benchmark()
  await second.arrived
  layaIn(res2, { held: true })
  second.release()
  assert.deepEqual((await speedEnded(local2)).done.map((d) => d.text), notMeasured)
  assert.equal(measuredRequests(server2).length, 1, 'no request is run again: that would not undo the split')
  await local2.dispose()

  // Stopped and started again between two requests, on the same device: another process all the same.
  const res3 = residencyStub()
  layaIn(res3, { held: true })
  const { local: local3, server: server3 } = await speedIn({ residency: res3 })
  const first = server3.hold((e) => e.body?.n_predict === 128)
  await local3.benchmark()
  await first.arrived
  res3.clear('laya', res3.get('laya'))
  layaIn(res3, { held: true })
  first.release()
  assert.deepEqual((await speedEnded(local3)).done.map((d) => d.text), notMeasured)
  await local3.dispose()
})

test('Cancel while the speed run loads again the model it found loaded is refused with why, rather than ignored, and the run says whether it has been cancelled', async (t) => {
  const { local, server } = await speedIn({ ids: ['big', 'small'] })
  assert.equal(typeof local.cancelBenchmark, 'function', 'the local models cancel a speed run')
  // Big is loaded, and only Small is measured, so the run ends by loading Big again; a chat title
  // for Small holds the engine meanwhile, so that load waits.
  await local.start('big')
  const timed = server.hold((e) => e.model === 'small' && e.body?.n_predict === 128)
  await local.benchmark({ ids: ['small'] })
  await timed.arrived
  const title = await local.acquire('small')
  t.after(async () => { title.release(); timed.release(); await speedEnded(local); await local.dispose() })
  assert.equal((await local.status()).speedRun.cancelled, false, 'not cancelled while it measures')
  timed.release()
  let run = null
  for (let i = 0; i < 500 && run?.current?.phase !== 'restoring'; i++) {
    run = (await local.status()).speedRun
    if (run.current?.phase !== 'restoring') await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(run.current?.phase, 'restoring')
  assert.throws(() => local.cancelBenchmark(), (err) => err.status === 409 && err.message === 'The speed benchmark has measured every model it will and is putting the engine back as it was before it; that cannot be cancelled.')
  assert.deepEqual([(await local.status()).speedRun.state, (await local.status()).speedRun.cancelled], ['running', false], 'nothing changed')
  title.release()
  assert.equal((await speedEnded(local)).restore, 'Big is loaded again, as it was before.')
})

test('KzH closing while a speed run waits to load the model it found loaded loads nothing: no engine outlives it, and the last line says why', async () => {
  const { local, server } = await speedIn({ ids: ['big', 'small'] })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  // Big is loaded, and only Small is measured, so the run ends by loading Big again.
  await local.start('big')
  const timed = server.hold((e) => e.model === 'small' && e.body?.n_predict === 128)
  await local.benchmark({ ids: ['small'] })
  await timed.arrived
  // A chat title for Small reaches the engine meanwhile, so the restore's load of Big waits for it.
  const title = await local.acquire('small')
  timed.release()
  let phase = null
  for (let i = 0; i < 500 && phase !== 'restoring'; i++) {
    phase = (await local.status()).speedRun.current?.phase ?? null
    if (phase !== 'restoring') await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(phase, 'restoring', 'the restore waits for the title')
  const spawned = server.started.length
  await local.dispose()
  title.release()
  // The restore's load looks again every 500 ms while another model holds the engine.
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(server.started.length, spawned, 'nothing was loaded after KzH closed')
  assert.ok(server.started.every((s) => s.child.exitCode !== null), 'and every engine it started has stopped')
  assert.equal((await local.status()).engine.running, false)
  const run = await speedEnded(local)
  assert.equal(run.restore, 'Stopped. Readings already taken are kept; KzH closed during the speed benchmark, so nothing was loaded again.')
  // Nor does anything else load a model once KzH has closed.
  await assert.rejects(local.acquire('big'), { message: 'KzH is closing, so Big was not loaded' })
  assert.equal(server.started.length, spawned)
})

test('a model whose context cannot hold the 8,192-token prompt and the 128 tokens generated after it is not measured, and says so before anything is loaded', async () => {
  // The plugin config may start every model at 8k, below the 12k floor.
  const { local, server } = await speedIn({ contextSize: 8192 })
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  assert.equal((await modelIn(local, 'big')).ctx, 8192)
  await local.benchmark()
  assert.deepEqual((await speedEnded(local)).done.map((d) => d.text), ['Big not measured: its context of 8k cannot hold the 8,192-token prompt and the 128 tokens generated after it'])
  assert.equal(server.started.length, 0, 'nothing was loaded for it')
  assert.deepEqual((await local.readSettings()).speed, {})
  await local.dispose()
  // A context that is no whole number of k is given in tokens.
  const { local: odd, server: oddServer } = await speedIn({ contextSize: 8300 })
  await odd.benchmark()
  assert.deepEqual((await speedEnded(odd)).done.map((d) => d.text), ['Big not measured: its context of 8300 tokens cannot hold the 8,192-token prompt and the 128 tokens generated after it'])
  assert.equal(oddServer.started.length, 0)
  await odd.dispose()
  // One that holds them is measured, below the floor as it is.
  const { local: enough } = await speedIn({ contextSize: 9216 })
  await enough.benchmark()
  assert.equal((await speedEnded(enough)).done[0].ok, true)
  assert.deepEqual(Object.keys((await enough.readSettings()).speed), ['big@9216'])
  await enough.dispose()
})

test('a timed request that has to read the whole prompt again, because a request for the same model took the one slot\'s cache, has the fill\'s time for it and is run again', async () => {
  // Time scaled so that a minute is 60 ms. This engine reads 10 tokens a second, as a CPU may: the
  // 8,192-token prompt takes 13.7 minutes to read, over 10 minutes and under the fill's 30.
  const scale = 60 / 60_000
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms) => realTimeout.call(AbortSignal, Math.max(1, Math.round(ms * scale)))
  try {
    const base = fakeLlamaServer({ report: () => SPLIT_REPORT, speed: () => ({ generate: 20, read: 10 }) })
    // Each /completion answers when llama-server would, scaled: once it has read the prompt and generated.
    const fetch = async (url, init = {}) => {
      const r = await base.fetch(url, init)
      const t = String(url).endsWith('/completion') && r.ok ? (await answerOf(r.clone())).timings : null
      if (t) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, (t.prompt_ms + t.predicted_ms) * scale)
          init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
        })
      }
      return r
    }
    const { local } = await speedIn({ server: { ...base, fetch } })
    assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
    const first = base.hold((e) => e.body?.n_predict === 128)
    await local.benchmark()
    await first.arrived
    // A chat title for Big reaches the engine before the first timed request: its own prompt takes
    // the one slot's cache, so that request reads all 8,192 tokens again.
    const conn = await local.acquire('big')
    await base.fetch(`${conn.url}/completion`, { method: 'POST', headers: { authorization: `Bearer ${conn.key}` }, body: JSON.stringify({ prompt: [1, 2, 3], n_predict: 4, cache_prompt: true }) })
    conn.release()
    first.release()
    const run = await speedEnded(local, { timeoutMs: 20_000 })
    assert.equal(run.done[0].ok, true, run.done[0].text)
    const timed = measuredRequests(base)
    assert.equal(timed.length, 4, 'the request that had company, and three more')
    assert.equal((await local.readSettings()).speed['big@12288'].tokensPerSec, 20)
    await local.dispose()
  } finally {
    AbortSignal.timeout = realTimeout
  }
})

test('a speed reading stands only for the weights it was measured on: once a manifest update ships other weights under the same model id, the card and the install picker give the estimate, and the card says why', async () => {
  const { local, engineDir, modelsDir } = await speedIn()
  assert.equal(typeof local.benchmark, 'function', 'the local models run a speed benchmark')
  await local.benchmark()
  await speedEnded(local)
  assert.equal((await modelIn(local, 'big')).speed.stands, true)
  await local.dispose()
  // The manifest now ships another quantisation of Big, another file and SHA-256, installed in its place.
  const modules = MANIFEST_MODULES.map((m) => (m.id === 'big' ? { ...m, file: 'big-q5.gguf', sha256: sha('big-q5') } : m))
  writeFileSync(join(modelsDir, 'big-q5.gguf'), 'big-q5')
  const server = fakeLlamaServer({ report: () => SPLIT_REPORT })
  const again = createLocalModels({ modules, engineDir, modelsDir, settingsFile: join(engineDir, '..', 'local.json'), specs: async () => PC, port: 0, spawn: server.spawn, fetch: server.fetch })
  await again.installed()
  await again.settled()
  const big = await modelIn(again, 'big')
  assert.equal(big.state, 'installed')
  assert.deepEqual([big.speed.stands, big.speed.why], [false, 'it was measured on other weights of this model'])
  assert.equal(big.rating.source, 'estimated')
  const picked = (await buildCatalog(again, PC)).modules.find((x) => x.id === 'big')
  assert.equal(picked.rating.source, 'estimated')
  assert.match(picked.rating.label, /est\.\)$/)
  // Measured again, on the new weights, it stands, and says which weights it was measured on.
  await again.benchmark()
  await speedEnded(again)
  assert.equal((await modelIn(again, 'big')).speed.stands, true)
  assert.deepEqual((await again.readSettings()).speed['big@12288'].weights, { file: 'big-q5.gguf', sha256: sha('big-q5') })
  await again.dispose()
})

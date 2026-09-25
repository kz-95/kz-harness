// Local models and offline mode, with no network and no real llama-server:
// offline routing rule, local agent eligibility, the connectivity cache,
// llama-server arguments, verified resumable downloads, the wire format,
// and the resource budget the engine is started and watched under.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badgesOf, buildCatalog, contextSteps, defaultThreads, estimateMemory, parsePsRss, parseTasklistMemory, workingSetOf, kvGbPerToken, readMemoryUsage, createConnectivity, createLocalModels, defaultsFor, detectSpecs, downloadVerified, installLlmCommand, llamaArgs, localAdapter, looksLikeQuestion, offlinePick, parseLlmArgs, pickEngineVariant, rateModule, readManifest, removeLlmCommand, specsLine, suggest, toWire, translate } from '../local.js'
import { fileURLToPath } from 'node:url'
import { waitFor } from './wait-for.js'
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
  assert.deepEqual(rateModule(big, four, 'vulkan'), { fit: 'split', label: 'Splits GPU + CPU (slower, ~6 words/s est.)', wordsPerSec: 6 })
  // On the capped card it may split like that, or run fully on the GPU. Which is not known, so the
  // rating says so and gives the speed of each, not one of them as if it were the answer.
  assert.deepEqual(rateModule(big, capped, 'vulkan'), { fit: 'unknown', label: "Runs on the GPU as far as its memory allows (this GPU's memory is unknown, 4 GB or more: ~6 to ~20 words/s est.)", wordsPerSec: null, wordsPerSecRange: [6, 20] })
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

// A ~30B mixture-of-experts local model on KzH's own llama-server path, with no network and no real
// llama-server: its fit and speed on a PC (local.js moeLayout), the candidate row nothing downloads
// until scripts/pin-model.mjs pins it, its place among the suggestions, its start with its experts
// in RAM, and the speed run's peak RAM. Every figure of a file here is a test's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// A namespace, so the file loads where local.js lacks what this adds, and each test fails by its own assertion.
import * as localJs from '../local.js'
import { createResidency } from '../residency.js'
import { fakeLlamaServer } from './fixtures/fake-llama-server.mjs'

const { rateModule, suggest, readManifest, createLocalModels, llamaArgs, buildCatalog, installLlmCommand, downloadVerified } = localJs
const MANIFEST = fileURLToPath(new URL('../../../config/local-models.json', import.meta.url))
const INSTALLER = fileURLToPath(new URL('../../../scripts/Install-Harness.ps1', import.meta.url))
const GIB = 1024 ** 3
const sha = (s) => createHash('sha256').update(s).digest('hex')
const tmp = () => mkdtempSync(join(tmpdir(), 'jev-moe-'))
const FILE = 'Qwen3-30B-A3B-Q4_K_M.gguf'
const PIN = 'not checked yet: run node scripts\\pin-model.mjs qwen3-30b-a3b'

// The candidate row as config/local-models.json ships it (the first test holds the two together).
const MOE = {
  id: 'qwen3-30b-a3b', kind: 'model', name: 'Qwen3 30B A3B', source: `https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF/resolve/main/${FILE}`, hfRepo: 'Qwen/Qwen3-30B-A3B-GGUF', file: FILE,
  license: 'Apache-2.0', reliability: 'official-stable', verified: false, role: 'best-quality', rank: 0,
  moe: { totalParamsB: 30.5, activeParamsB: 3.3, expertShare: 0.95, layers: 48 }, kvGbPerToken: 0.000091552734375,
  contextSize: 16384, maxContext: 40960, gpuLayers: 'auto', agent: { id: 'qwen-moe-local', description: 'Qwen3 30B A3B running on this PC through llama.cpp.' },
}
// Pinned, it weighs what the estimate gives it, so its figures are the ones above; its file holds `moe`.
const PINNED = { ...MOE, size: Math.round((30.5e9 * 4.9) / 8), sha256: sha('moe'), verified: true }
// A dense model like Qwen3 8B, which runs fully on a 10 GB GPU.
const DENSE = { id: 'dense', kind: 'model', name: 'Dense', source: 'https://huggingface.co/Qwen/Dense-GGUF/resolve/main/dense.gguf', file: 'dense.gguf', size: 5 * GIB, sha256: sha('dense'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 16384, agent: { id: 'dense-local', description: 'Dense running on this PC through llama.cpp.' } }
const ENGINE = { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') }

// The owner's PC (RTX 3080 10 GB, 32 GB RAM, Windows 11) and the test laptop (RTX 3050 Laptop 4 GB, 24 GB RAM), as detectSpecs reads them.
const OWNER = { gpus: [{ name: 'NVIDIA GeForce RTX 3080', vendor: 'nvidia', vramGB: 10 }], cuda: 12.7, ramGB: 31.9, cpu: { name: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 200 * GIB }
const LAPTOP = { gpus: [{ name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramGB: 4 }, { name: 'Intel(R) UHD Graphics', vendor: 'intel', vramGB: 0 }], cuda: 12.7, ramGB: 23.7, cpu: { name: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 52 * GIB }
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const today = (d = new Date()) => `${d.getDate()} ${MONTH[d.getMonth()]}`
const argOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

/**
 * The engine build and the models `ids` in place, as a hand install leaves them, over a stand-in
 * llama-server: it records each start, prints `report` as its load report and answers /health and
 * /v1/models with the start's key, unless `fails(args)`, when it exits as a load that ran out of
 * memory does. Its pid is one no process can have.
 */
async function moeIn({ ids = ['qwen3-30b-a3b'], modules = [ENGINE, PINNED, DENSE], specs = OWNER, fails = () => false, report = () => [], ...extra } = {}) {
  const root = tmp()
  const engineDir = join(root, 'engine'); const modelsDir = join(root, 'models')
  mkdirSync(join(engineDir, '.installed'), { recursive: true }); mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  for (const id of ids) writeFileSync(join(modelsDir, modules.find((m) => m.id === id).file), id === 'qwen3-30b-a3b' ? 'moe' : id)
  const started = []
  const spawn = (cmd, args, opts = {}) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: 2147483647 })
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close') }
    const run = { args, child, key: opts.env?.LLAMA_API_KEY ?? null, fails: fails(args), reported: false }
    started.push(run)
    if (run.fails) setImmediate(() => { child.stderr.emit('data', 'cudaMalloc failed: out of memory\n'); child.exitCode = 1; child.emit('exit', 1); child.emit('close') })
    return child
  }
  const fetch = async (url = '', init = {}) => {
    const run = started.at(-1)
    if (run?.fails) return Response.json({ error: { code: 503, message: 'Loading model' } }, { status: 503 })
    if (run && !run.reported) { run.reported = true; for (const l of report()) run.child.stderr.emit('data', `${l}\n`) }
    if (String(url).endsWith('/v1/models')) return init.headers?.authorization === `Bearer ${run?.key}` ? Response.json({ data: [{ id: argOf(run.args, '--alias') }] }) : Response.json({}, { status: 401 })
    return Response.json({ status: 'ok' })
  }
  const logs = []
  const local = createLocalModels({ modules, engineDir, modelsDir, settingsFile: join(root, 'local.json'), specs: async () => specs, port: 0, spawn, fetch, log: (t) => logs.push(t), findPort: async (from) => from, ...extra })
  await local.installed(); await local.settled()
  return { local, started, logs, root, modelsDir }
}

test('the manifest offers Qwen3 30B A3B as a candidate: Qwen\'s own GGUF repo, its mixture-of-experts fields, no size and no SHA-256, and it loads; a half-pinned row or one from an uploader does not', () => {
  const row = readManifest(MANIFEST).find((m) => m.id === 'qwen3-30b-a3b')
  assert.ok(row, 'config/local-models.json has the candidate row')
  for (const k of ['source', 'hfRepo', 'file', 'moe', 'kvGbPerToken', 'contextSize', 'role', 'rank', 'reliability', 'verified']) assert.deepEqual(row[k], MOE[k], k)
  assert.equal(row.size, undefined)
  assert.equal(row.sha256, undefined)
  assert.equal(localJs.isPinned?.(row), false, 'local.js says it is not pinned')
  const dir = tmp()
  const write = (modules) => { const p = join(dir, `m${Math.random()}.json`); writeFileSync(p, JSON.stringify({ modules })); return p }
  assert.equal(readManifest(write([MOE, { ...PINNED, id: 'pinned' }])).length, 2)
  assert.throws(() => readManifest(write([{ ...MOE, sha256: sha('x') }])), /size: bytes/)
  assert.throws(() => readManifest(write([{ ...MOE, size: 5 }])), /sha256: 64 hex/)
  assert.throws(() => readManifest(write([{ ...DENSE, size: undefined, sha256: undefined }])), /only a mixture-of-experts model row \(moe\) may leave both out/)
  assert.throws(() => readManifest(write([{ ...MOE, hfRepo: 'unsloth/Qwen3-30B-A3B-GGUF', source: `https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/${FILE}` }])), /a maker's own organization \(Qwen, google\)/)
  assert.throws(() => readManifest(write([{ ...MOE, source: 'https://huggingface.co/Qwen/Other-GGUF/resolve/main/other.gguf' }])), /its source is that repo's resolve\/main URL of its file/)
  assert.throws(() => readManifest(write([{ ...MOE, moe: { ...MOE.moe, expertShare: 1.2 } }])), /moe: on a model row/)
  assert.throws(() => readManifest(write([{ ...MOE, moe: { ...MOE.moe, activeParamsB: 1 } }])), /the active share above the share outside the experts/)
})

test('a mixture-of-experts row fits by its experts in RAM and the rest on the GPU: on the owner\'s RTX 3080 10 GB and 32 GB the last 16 layers\' experts go to the GPU too, on the 4 GB, 24 GB laptop every expert stays in RAM', () => {
  assert.equal(typeof localJs.moeLayout, 'function', 'local.js lays out a mixture-of-experts model')
  assert.deepEqual(rateModule(MOE, OWNER, 'cuda12'), {
    fit: 'moe', label: 'Fits this PC: experts in RAM (about 11.0 GB), the rest on the GPU (~21 words/s est.)', wordsPerSec: 21,
    moe: { ramGB: 11, gpuGB: 9, cpuLayers: 32, layers: 48, sizeEstimated: true }, source: 'estimated',
  })
  assert.deepEqual(rateModule(MOE, LAPTOP, 'cuda12'), {
    fit: 'moe', label: 'Fits this PC: experts in RAM (about 16.5 GB), the rest on the GPU (~16 words/s est.)', wordsPerSec: 16,
    moe: { ramGB: 16.5, gpuGB: 3.5, cpuLayers: 48, layers: 48, sizeEstimated: true }, source: 'estimated',
  })
  // Behind them: 17.4 GB from 30.5 B parameters at 4.9 bits until it is pinned, 16.5 GB of it experts;
  // the GPU holds the rest, the 1.5 GB KV cache at 16k, the compute buffers and the desktop's 0.8 GB.
  const lay = localJs.moeLayout(MOE, { vramGB: 10, ctx: 16384 })
  const r2 = (x) => Math.round(x * 100) / 100
  assert.deepEqual([r2(lay.sizeGB), r2(lay.expertsGB), r2(lay.gpuNeedGB), lay.cpuLayers, r2(lay.ramGB), r2(lay.gpuGB), r2(lay.tokensPerSec)], [17.4, 16.53, 3.47, 32, 11.02, 8.98, 28.53])
  assert.equal(lay.sizeEstimated, true)
  assert.equal(localJs.moeLayout(PINNED, { vramGB: 10, ctx: 16384 }).sizeEstimated, false, 'pinned, its own size')
  // Not a dense model of its file size: read whole per token, the same file splits and crawls.
  const dense = rateModule({ ...PINNED, moe: undefined, recommendedVramGB: 18.5 }, OWNER, 'cuda12')
  assert.equal(dense.fit, 'split')
  assert.ok(dense.wordsPerSec <= 3, `${dense.wordsPerSec} words/s as a dense model`)
  // Its memory figure is the same layout: the experts it keeps in RAM, the rest on the GPU.
  assert.deepEqual(localJs.estimateMemory(MOE, { ctx: 16384, vramGB: 10, cpuMoe: { layers: 48, cpuLayers: 32 } }), { vramGB: 9, ramGB: 11, totalGB: 20, gpuFraction: 0.4, source: 'estimated' })
})

test('a mixture-of-experts row this PC cannot hold says why and is never suggested, and the picks are the ones the PC got without it', () => {
  const won = (specs, variant = 'cuda12') => rateModule(PINNED, specs, variant)
  assert.deepEqual(won({ ...OWNER, ramGB: 15.7 }), { fit: 'no', label: "Won't fit", reason: 'needs about 18 GB RAM, 11.0 GB for its experts and 6 GB for Windows and KzH, and this PC has 16 GB', source: 'estimated' })
  assert.equal(won({ ...OWNER, gpus: [{ name: 'NVIDIA GeForce GTX 1050', vendor: 'nvidia', vramGB: 2 }] }).reason, 'needs about 3.5 GB of GPU memory for all but its experts, and this GPU has 2 GB')
  assert.equal(won(OWNER, 'cpu').reason, 'needs about 3.5 GB of GPU memory for all but its experts, and the CPU build of the engine uses no GPU')
  assert.equal(won({ ...OWNER, gpus: [] }, 'vulkan').reason, 'needs about 3.5 GB of GPU memory for all but its experts, and this PC has no GPU the engine can use')
  assert.equal(won({ ...OWNER, diskFreeBytes: 10 * GIB }).reason, 'needs 19.1 GB free disk, 10.0 GB free')
  assert.equal(rateModule(MOE, { ...OWNER, diskFreeBytes: 10 * GIB }, 'cuda12').reason, 'needs about 19.1 GB free disk, 10.0 GB free', 'about, while its size is estimated')
  const small = { ...OWNER, ramGB: 15.7 }
  const rowsOf = (mods) => mods.map((m) => ({ m, installed: false, rating: rateModule(m, small, 'cuda12') }))
  const withIt = suggest(rowsOf([DENSE, PINNED]), small)
  assert.deepEqual(withIt.picks, suggest(rowsOf([DENSE]), small).picks, 'nothing changes on a PC it does not fit')
  assert.equal(withIt.why['qwen3-30b-a3b'], 'needs about 18 GB RAM, 11.0 GB for its experts and 6 GB for Windows and KzH, and this PC has 16 GB')
})

test('a candidate row is never suggested and says what pins it; pinned and tested, it is picked first where it fits, as the best quality, and the dense model after it as the lighter one', () => {
  const rowsOf = (mods, specs) => mods.map((m) => ({ m, installed: false, rating: rateModule(m, specs, 'cuda12') }))
  const unpinned = suggest(rowsOf([DENSE, MOE], OWNER), OWNER)
  assert.deepEqual(unpinned.picks.map((p) => p.id), ['dense'])
  assert.equal(unpinned.why['qwen3-30b-a3b'], PIN)
  const pinned = suggest(rowsOf([DENSE, PINNED], OWNER), OWNER)
  assert.deepEqual(pinned.picks, [
    { id: 'qwen3-30b-a3b', reason: 'Qwen3 30B A3B: best quality that still runs on your 10 GB GPU + 32 GB RAM (experts in RAM, the rest on the GPU, ~21 words/s)' },
    { id: 'dense', reason: 'Dense: lighter and faster (Runs fully on GPU, ~20 words/s)' },
  ])
  // Not tested with this engine yet, as the shipped row is, it is not suggested even pinned.
  assert.equal(suggest(rowsOf([DENSE, { ...PINNED, verified: false }], OWNER), OWNER).why['qwen3-30b-a3b'], 'not suggested: not tested with this engine yet')
  // On the laptop the dense model splits and the MoE fits: it is first there too.
  assert.equal(suggest(rowsOf([DENSE, PINNED], LAPTOP), LAPTOP).picks[0].id, 'qwen3-30b-a3b')
})

test('its speed is estimated from the weights a token reads until a speed run measures it, and the measured figure takes over in the experts\' words', () => {
  const at = new Date().toISOString()
  const reading = { at, tokensPerSec: 24.6, promptTokensPerSec: 300, depth: 8192, layersOnGpu: { gpu: 49, total: 49 }, cpuMoe: { layers: 48, cpuLayers: 32 } }
  const measured = rateModule(PINNED, OWNER, 'cuda12', { installed: true, speed: reading })
  assert.deepEqual({ ...measured, moe: undefined }, { fit: 'moe', label: `Fits this PC: experts in RAM, the rest on the GPU: 25 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 18 words/s)`, wordsPerSec: 18, source: 'measured', moe: undefined })
  assert.equal(rateModule(PINNED, OWNER, 'cuda12', { installed: true }).label, 'Fits this PC: experts in RAM (about 11.0 GB), the rest on the GPU (~21 words/s est.)')
})

test('a GPU that holds every expert too runs all of it there, and its rating, suggestion, measured figure, start and speed reading say so, never "experts in RAM (about 0.0 GB)"', async () => {
  // A 24 GB GPU beside the owner's 32 GB RAM: the GPU's room beyond the rest takes all 48 layers' experts.
  const BIG = { ...OWNER, gpus: [{ name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', vramGB: 24 }] }
  assert.deepEqual(rateModule(PINNED, BIG, 'cuda12'), {
    fit: 'moe', label: 'Fits this PC: all on the GPU, experts included (~60 words/s est.)', wordsPerSec: 60,
    moe: { ramGB: 0, gpuGB: 20, cpuLayers: 0, layers: 48, sizeEstimated: false }, source: 'estimated',
  })
  const picks = suggest([DENSE, PINNED].map((m) => ({ m, installed: false, rating: rateModule(m, BIG, 'cuda12') })), BIG).picks
  assert.equal(picks[0].reason, 'Qwen3 30B A3B: best quality that still runs on your 24 GB GPU + 32 GB RAM (all on the GPU, experts included, ~60 words/s)')
  const reading = { at: new Date().toISOString(), tokensPerSec: 80.4, promptTokensPerSec: 900, depth: 8192, layersOnGpu: { gpu: 49, total: 49 }, cpuMoe: { layers: 48, cpuLayers: 0 } }
  assert.equal(rateModule(PINNED, BIG, 'cuda12', { installed: true, speed: reading }).label, `Fits this PC: all on the GPU, experts included: 80 tokens/s measured on this PC on ${today()}, 8,192 tokens into a conversation (about 60 words/s)`)
  // It starts with neither --cpu-moe nor --n-cpu-moe, and its log line says where the experts are.
  const { local, started, logs } = await moeIn({ specs: BIG })
  await local.start('qwen3-30b-a3b')
  assert.ok(!started[0].args.some((a) => /cpu-moe/.test(a)), started[0].args.join(' '))
  assert.ok(logs.some((l) => /^local: engine starting qwen3-30b-a3b on .*, every expert on the GPU\)$/.test(l)), logs.join('\n'))
  await local.dispose()
  // A reading taken that way does not stand for a load that keeps some experts in RAM, in those words.
  const at = { gpuLayers: 'auto', roomGB: 24, threads: 4, engine: { variant: 'cuda12', sha256: 'e' }, weights: { sha256: 'w' }, laya: null }
  const next = { ...at, ctx: 16384, depth: 8192, cpuMoe: { layers: 48, cpuLayers: 12 } }
  assert.equal(localJs.speedFor({ speed: { 'qwen3-30b-a3b@16384': { ...reading, ...at } } }, 'qwen3-30b-a3b', next).why,
    'it was measured with every expert on the GPU and the next load has the experts of 12 of 48 layers in RAM')
})

test('llama-server keeps the experts in RAM with --n-cpu-moe N for some layers or --cpu-moe for all, and gets neither for a dense model', () => {
  const base = { modelPath: 'm.gguf', alias: 'm', port: 8081, ctx: 16384, threads: 4 }
  const some = llamaArgs({ ...base, cpuMoe: { layers: 48, cpuLayers: 32 } })
  assert.equal(argOf(some, '--n-cpu-moe'), '32')
  assert.ok(!some.includes('--cpu-moe'))
  assert.equal(argOf(some, '-ngl'), 'auto', 'every layer still goes to the GPU')
  const all = llamaArgs({ ...base, cpuMoe: { layers: 48, cpuLayers: 48 } })
  assert.ok(all.includes('--cpu-moe') && !all.includes('--n-cpu-moe'))
  for (const cpuMoe of [null, { layers: 48, cpuLayers: 0 }]) {
    const args = llamaArgs({ ...base, cpuMoe })
    assert.ok(!args.includes('--cpu-moe') && !args.includes('--n-cpu-moe'), JSON.stringify(cpuMoe))
  }
})

test('a mixture-of-experts model starts with the experts its plan keeps in RAM: the first 32 layers\' on a 10 GB GPU, more beside a held Laya on the GPU, none by --n-cpu-moe with GPU layers pinned or on the CPU', async () => {
  const residency = createResidency()
  const { local, started, logs } = await moeIn({ residency })
  const moe = async () => (await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b')
  assert.deepEqual((await moe()).memory, { vramGB: 9, ramGB: 11, totalGB: 20, gpuFraction: 0.4, source: 'estimated' })
  const err = await local.start('qwen3-30b-a3b').then(() => null, (e) => e)
  assert.equal(err, null)
  assert.equal(argOf(started[0].args, '--n-cpu-moe'), '32')
  assert.ok(logs.some((l) => /^local: engine starting qwen3-30b-a3b on 127\.0\.0\.1:\d+ \(ctx 16384, GPU layers auto, 4 threads, 256 MiB kept free on the GPU, the experts of 32 of 48 layers in RAM\)$/.test(l)), logs.join('\n'))
  await local.stop()
  // A Laya held on the GPU keeps its 2 GB there, as --fit would have seen: 6 more layers' experts stay in RAM.
  residency.set('laya', { pid: 4242, startedAt: Date.now(), device: 'cuda', name: 'laya.serve', held: () => true, unload: async () => {}, ramGB: 3.3, vramGB: 2 })
  await local.start('qwen3-30b-a3b')
  assert.equal(argOf(started[1].args, '--n-cpu-moe'), '38')
  await local.stop()
  residency.clear('laya')
  // GPU layers pinned by hand: placed by layers, as any model is; on the CPU, all of it in RAM.
  await local.setSettings({ gpuLayers: 20 })
  await local.start('qwen3-30b-a3b')
  assert.ok(!started[2].args.some((a) => /cpu-moe/.test(a)))
  await local.stop()
  await local.setSettings({ gpuLayers: 0 })
  await local.start('qwen3-30b-a3b')
  assert.ok(!started[3].args.some((a) => /cpu-moe/.test(a)))
  assert.equal((await moe()).memory.vramGB, 0)
  await local.dispose()
})

test('a load with experts on the GPU that fails is made once more with every expert in RAM, and the loads after it start that way, unless the RAM budget refuses that', async () => {
  const { local, started, logs } = await moeIn({ fails: (args) => args.includes('--n-cpu-moe') })
  const err = await local.start('qwen3-30b-a3b').then(() => null, (e) => e)
  assert.equal(err, null, 'it loads at the second try')
  assert.deepEqual(started.map((r) => r.args.find((a) => /cpu-moe/.test(a))), ['--n-cpu-moe', '--cpu-moe'])
  assert.ok(logs.some((l) => /^local: qwen3-30b-a3b did not load with the experts of 16 layers on the GPU \(llama-server exited: .*\); loading it again with every expert in RAM$/.test(l)), logs.join('\n'))
  // Loaded again in this session, it keeps every expert in RAM from the first try, and its figure says so.
  await local.stop()
  await local.start('qwen3-30b-a3b')
  assert.deepEqual(started.slice(2).map((r) => r.args.find((a) => /cpu-moe/.test(a))), ['--cpu-moe'])
  assert.equal((await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b').memory.ramGB, 16.5)
  await local.dispose()
  // 12 GB of RAM holds the plan's 11 GB of experts, not all 16.5 GB: no second try.
  const tight = await moeIn({ fails: (args) => args.includes('--n-cpu-moe') })
  await tight.local.setSettings({ maxRamGB: 12 })
  const refused = await tight.local.start('qwen3-30b-a3b').then(() => null, (e) => e)
  assert.match(String(refused?.message), /^llama-server exited/)
  assert.equal(tight.started.length, 1)
  assert.ok(tight.logs.some((l) => /did not load with the experts of 16 layers on the GPU, and the budget refuses it with every expert in RAM: Qwen3 30B A3B needs about 16\.5 GB of RAM/.test(l)), tight.logs.join('\n'))
  await tight.local.dispose()
})

test('a load that exits with experts on the GPU and again with every expert in RAM keeps nothing: once the failure stops, the next start lays the experts out as planned', async () => {
  let failing = true
  const { local, started } = await moeIn({ fails: () => failing })
  const err = await local.start('qwen3-30b-a3b').then(() => null, (e) => e)
  assert.match(String(err?.message), /^llama-server exited/)
  assert.deepEqual(started.map((r) => r.args.find((a) => /cpu-moe/.test(a))), ['--n-cpu-moe', '--cpu-moe'])
  // Its cause fixed (a driver, a DLL, another program let go of the GPU), the next start is the plan's own.
  failing = false
  await local.start('qwen3-30b-a3b')
  assert.equal(argOf(started[2].args, '--n-cpu-moe'), '32', 'the last 16 layers\' experts on the GPU, as planned')
  assert.equal((await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b').memory.ramGB, 11)
  await local.dispose()
})

test('nothing downloads a file it has no SHA-256 for: the download, the install, /install-llm and Install-Harness.ps1 each refuse a candidate row before any request', async () => {
  const calls = []
  const fetch = async (url) => { calls.push(String(url)); return new Response('x', { status: 404 }) }
  await assert.rejects(downloadVerified({ url: MOE.source, dest: join(tmp(), FILE), size: undefined, sha256: undefined, fetch }), /^Error: download refused: Qwen3-30B-A3B-Q4_K_M\.gguf has no size and SHA-256 to check it against$/)
  await assert.rejects(downloadVerified({ url: MOE.source, dest: join(tmp(), FILE), size: 5, sha256: 'not a hash', fetch }), /download refused/)
  // The install, with no engine either: refused whole, nothing queued.
  const root = tmp()
  const engineDir = join(root, 'engine'); const modelsDir = join(root, 'models')
  mkdirSync(engineDir); mkdirSync(modelsDir)
  const local = createLocalModels({ modules: [ENGINE, MOE, DENSE], engineDir, modelsDir, settingsFile: join(root, 'local.json'), specs: async () => OWNER, fetch, port: 0 })
  await assert.rejects(local.install(['qwen3-30b-a3b']), /^Error: Qwen3 30B A3B is not checked yet: run node scripts\\pin-model\.mjs qwen3-30b-a3b; nothing downloads a file it has no size and SHA-256 for$/)
  assert.equal((await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b').job, null)
  // /install-llm: named, refused with the line; listed, with it; `all` leaves it out.
  const asked = []
  const plain = { ...local, install: async (ids) => { asked.push(ids); return [] } }
  const catalog = () => buildCatalog(local, OWNER)
  const named = await installLlmCommand('qwen3-30b-a3b', { local, catalog })
  assert.deepEqual(named, { kind: 'error', text: `Qwen3 30B A3B is ${PIN}; nothing downloads a file it has no size and SHA-256 for.` })
  const listed = await installLlmCommand('', { local, catalog })
  assert.ok(listed.text.includes(`- \`qwen3-30b-a3b\` Qwen3 30B A3B · size not checked yet · Fits this PC: experts in RAM (about 11.0 GB), the rest on the GPU (~21 words/s est.) · agent qwen-moe-local · ${PIN}`), listed.text)
  await installLlmCommand('all', { local: plain, catalog })
  assert.deepEqual(asked, [['dense']])
  assert.deepEqual(calls, [], 'not one request')
  // Install-Harness.ps1 (PowerShell 5.1, not run here): the check comes before curl, `all` leaves candidates out, a named one is refused.
  const ps1 = readFileSync(INSTALLER, 'utf8')
  const guard = ps1.indexOf('if (-not (Test-Pinned $m)) { throw "$($m.file): no size and SHA256 to check it against, so it is not downloaded" }')
  assert.ok(guard > 0 && guard < ps1.indexOf('& curl.exe -fL --retry 5 -C - -o $part $m.source'), 'Get-Verified refuses before curl')
  assert.ok(ps1.includes("$want = if ($ids -contains 'all') { @($models | Where-Object { Test-Pinned $_ }) }"))
  assert.ok(ps1.includes('if (-not (Test-Pinned $m)) { throw "$id is not checked yet: run node scripts\\pin-model.mjs $id first; nothing was downloaded" }'))
  assert.ok(ps1.includes('not checked yet: run node scripts\\pin-model.mjs {0}'), 'its list says so')
  await local.dispose()
})

test('a candidate row is never installed, hashed or offered as an agent, even with its file put in place by hand, and its status says what pins it', async () => {
  const { local, modelsDir } = await moeIn({ modules: [ENGINE, MOE, DENSE], ids: ['dense'] })
  writeFileSync(join(modelsDir, FILE), 'moe')
  const row = (await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b')
  assert.deepEqual([row.state, row.unpinned, row.size, row.moe, row.rating?.fit], ['unpinned', PIN, null, true, 'moe'])
  await local.settled()
  assert.equal(existsSync(join(modelsDir, '.verified', `${FILE}.json`)), false, 'not hashed')
  assert.deepEqual((await local.installed()).map((m) => m.id), ['dense'])
  assert.deepEqual((await local.agents()).map((a) => a.id), ['dense-local'])
  await local.dispose()
})

test('the speed run records the engine\'s peak working set, the RAM watchdog\'s reading, beside the speed in local.json and in its lines, and where a mixture-of-experts model kept its experts', async () => {
  const reads = [5 * GIB, 21.2 * GIB, 12 * GIB]
  let n = 0
  const pids = []
  const readWorkingSet = async (pid) => { pids.push(pid); return reads[Math.min(n++, reads.length - 1)] }
  const server = fakeLlamaServer({ report: () => ['load_tensors: offloaded 49/49 layers to GPU', 'CUDA0 model buffer size = 9200.00 MiB', 'CPU_Mapped model buffer size = 11280.00 MiB'] })
  const { local, root } = await moeIn({ spawn: server.spawn, fetch: server.fetch, readWorkingSet, watchEveryMs: 5 })
  await local.benchmark({ ids: ['qwen3-30b-a3b'] })
  for (const until = Date.now() + 10_000; (await local.status()).speedRun.state !== 'idle';) {
    assert.ok(Date.now() < until, 'the speed run ends')
    await new Promise((r) => setTimeout(r, 10))
  }
  const results = local.speedResults()
  assert.equal(results.done[0].ok, true, results.done[0].text)
  assert.equal(results.done[0].text, 'Qwen3 30B A3B: 20.0 tokens/s generating and 400 tokens/s reading, 8,192 tokens into a conversation, at 16k context, peak RAM 21.2 GB.')
  assert.ok(pids.length >= 2 && pids.every((p) => p === 2147483647), 'the engine\'s own pid, read more than once')
  const saved = JSON.parse(readFileSync(join(root, 'local.json'), 'utf8')).speed['qwen3-30b-a3b@16384']
  assert.equal(saved.peakRamGB, 21.2)
  assert.deepEqual(saved.cpuMoe, { layers: 48, cpuLayers: 32 })
  assert.match(localJs.speedFigures(results.done[0]), /, 4 threads, peak RAM 21\.2 GB$/)
  // The reading stands for the next load, and the picker shows it measured, in the experts' words.
  const row = (await local.status()).modules.find((m) => m.id === 'qwen3-30b-a3b')
  assert.equal(row.speed.stands, true, row.speed.why)
  assert.match(row.rating.label, /^Fits this PC: experts in RAM, the rest on the GPU: 20 tokens\/s measured on this PC/)
  // A load that would keep other layers' experts in RAM is another split: the reading no longer stands.
  assert.equal(localJs.speedFor({ speed: { 'qwen3-30b-a3b@16384': saved } }, 'qwen3-30b-a3b', { ctx: 16384, roomGB: 10, gpuLayers: 'auto', cpuMoe: { layers: 48, cpuLayers: 38 }, threads: 4, engine: saved.engine, weights: saved.weights, depth: 8192, laya: null }).why,
    'it was measured with the experts of 32 of 48 layers in RAM and the next load has the experts of 38 of 48 layers in RAM')
  await local.dispose()
})

// Local models and offline mode, with no network and no real llama-server:
// offline routing rule, local agent eligibility, the connectivity cache,
// llama-server arguments, verified resumable downloads, and the wire format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badgesOf, buildCatalog, createConnectivity, createLocalModels, defaultsFor, detectSpecs, downloadVerified, installLlmCommand, llamaArgs, looksLikeQuestion, offlinePick, parseLlmArgs, pickEngineVariant, rateModule, readManifest, removeLlmCommand, specsLine, suggest, toWire, translate } from '../local.js'
import { fileURLToPath } from 'node:url'
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
})

test('engine build follows the hardware: CUDA 12/13 by driver, Vulkan for other GPUs, else CPU', () => {
  const mods = [...MANIFEST_MODULES, { ...MANIFEST_MODULES[0], id: 'e13', variant: 'cuda13', minCuda: 13.3 }, { ...MANIFEST_MODULES[1], id: 'vk', variant: 'vulkan' }]
  assert.equal(pickEngineVariant(PC, mods), 'cuda12')
  assert.equal(pickEngineVariant({ ...PC, cuda: 13.4 }, mods), 'cuda13')
  assert.equal(pickEngineVariant({ ...PC, cuda: 11.8 }, mods), 'vulkan')
  assert.equal(pickEngineVariant({ ...PC, gpus: [{ name: 'AMD Radeon', vendor: 'amd', vramGB: 8 }], cuda: null }, mods), 'vulkan')
  assert.equal(pickEngineVariant({ ...PC, gpus: [], cuda: null }, mods), 'cpu')
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
test('connectivity: online if any probe answers, offline if all fail, cached for the ttl', async () => {
  let calls = 0
  let t = 0
  let up = false
  const fetch = async (url) => { calls++; if (up && url.includes('deepseek')) return { status: 404 }; throw new Error('ENOTFOUND') }
  const c = createConnectivity({ fetch, now: () => t, ttlMs: 30_000 })
  assert.equal(await c.online(), false)
  assert.equal(calls, 2)
  up = true
  t = 10_000
  assert.equal(await c.online(), false, 'cached within 30 s')
  assert.equal(calls, 2)
  t = 31_000
  assert.equal(await c.online(), true, 'one answering probe (any status) means online')
  assert.equal(calls, 4)
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

// The speed benchmark's routes (docs/benchmark.md 2.10 and 5.1), through apply() and index.js only:
// POST /jev-router/local/benchmark and .../benchmark/cancel, GET /jev-router/local reporting the run,
// and the refusals index.js wires in, a local agent at work through the normal run path and Laya
// answering a call. The plugin runs on a PC of its own: a minimal host, the local models over the fake
// llama-server of test/fixtures (models of this file's own, not the harness's), Laya on a fake
// laya.serve where a test installs it, and a network on which only this PC answers.
//
// First, an engine home of this file's own, before the plugin is loaded (it reads DSH_HOME once):
// the accounts keep their .env there, and a test must neither read nor write the person's own.
import 'data:text/javascript,import{mkdtempSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";process.env.DSH_HOME=mkdtempSync(join(tmpdir(),"kz-speed-dsh-"))'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
// A namespace, so the file loads where the plugin lacks what these tests are about, and each test
// fails by its own assertion there.
import * as jevRouter from '../index.js'
import { fakeLlamaServer } from './fixtures/fake-llama-server.mjs'
import { startFakeLaya } from './fixtures/fake-laya-serve.mjs'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const made = [process.env.DSH_HOME]
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const SESSION = 'session-speed'
const COMMIT = '1a2b3c4d5e6f7a8b9c0d'.padEnd(40, '0')

// The network as this file allows it: this PC and nothing else, so every run is offline, nothing
// reaches TypeSafe, and Laya's own calls reach the fake laya.serve.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}

const sha = (s) => createHash('sha256').update(s).digest('hex')
const GIB = 1024 ** 3
// The engine build and the model the local models have here: Big, as local.test.js has it, with no
// agent of its own, since the config below names its agent.
const MODULES = [
  { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') },
  { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * GIB, sha256: sha('big'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 8192, maxContext: 40960 },
]
const PC = {
  gpus: [{ name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramGB: 4 }],
  cuda: 12.7, ramGB: 23.7, cpu: { name: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 52 * GIB,
}
const SPLIT = ['load_tensors: offloaded 29/37 layers to GPU', 'CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 1024.00 MiB']

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
/** Poll an asynchronous read until `ok` holds, with a deadline; throws with the last value read. */
async function until(label, read, ok, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await read() } catch (err) { value = `not readable yet: ${err.message}` }
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: still not true after ${timeoutMs} ms, last: ${JSON.stringify(value)?.slice(0, 800)}`)
    await tick(20)
  }
}

/** Laya as its install leaves it (docs/laya-auto.md 7.1), as test/laya-integration.test.js has it. */
async function installLaya(harnessDir, dataDir) {
  const { layaPaths, readPins, recordWeights, snapshotDir } = await import('../laya-install.js')
  const paths = layaPaths({ harnessDir, dataDir })
  mkdirSync(dirname(paths.pythonOf(paths.venv)), { recursive: true })
  writeFileSync(paths.pythonOf(paths.venv), '')
  writeFileSync(paths.installed, JSON.stringify({ laya: '0.3.20', torch: '2.14.0+cpu', torchIndex: 'pypi', cuda: false, gpu: null, python: '3.12.11', uv: '0.12.18' }))
  const snap = snapshotDir(paths.hf, readPins(REPO).weights.repo, COMMIT)
  mkdirSync(join(snap, 'tokenizer'), { recursive: true })
  writeFileSync(join(snap, 'model.safetensors'), 'weights')
  writeFileSync(join(snap, 'rl_agent_config.json'), '{}')
  writeFileSync(join(snap, 'tokenizer', 'tokenizer_config.json'), '{"tokenizer_class":"PreTrainedTokenizerFast"}')
  await recordWeights(paths, { repo: readPins(REPO).weights.repo, commit: COMMIT, downloadedAt: 'then', loadedAt: 'then' })
}

/**
 * The plugin on a PC of its own, closed when the test ends. Its one agent, `big-local`, runs Big on
 * this PC; `world.work` is what its subagent does before it finishes (a promise to hold it at work).
 * With `laya`, Laya is installed and its supervisor keeps a fake laya.serve, found in `world.fakes`.
 * `config` is laid over the plugin config below.
 */
async function plugin(t, { laya = false, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-speed-'))
  made.push(root)
  const dataDir = join(root, 'data')
  const harnessDir = join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  const pinsFile = join(harnessDir, 'config', 'laya.json')
  mkdirSync(dirname(pinsFile), { recursive: true })
  copyFileSync(join(REPO, 'config', 'laya.json'), pinsFile)
  if (laya) await installLaya(harnessDir, dataDir)
  // The local models' folders, with the engine and Big in place as a hand install leaves them.
  const engineDir = join(root, 'engine')
  const modelsDir = join(root, 'models')
  mkdirSync(join(engineDir, '.installed'), { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  const server = fakeLlamaServer({ report: () => SPLIT })
  // A git repository for the session's workspace, as every run needs one.
  const workspace = join(root, 'work')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: workspace })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')

  const world = { work: null, started: [], fakes: [], children: [] }
  const spawnLaya = (cmd, args, opts) => {
    const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], opts)
    world.children.push(child)
    const fake = startFakeLaya({ host: opts.env.LAYA_HOST, port: Number(opts.env.LAYA_PORT), apiKey: opts.env.LAYA_API_KEY, device: opts.env.LAYA_DEVICE, models: ['english'] })
    fake.then((f) => world.fakes.push(f), () => child.kill('SIGKILL'))
    child.once('exit', () => { fake.then((f) => f.close(), () => {}) })
    return child
  }
  const subagents = {
    async start(provider, opts) {
      world.started.push({ provider, prompt: opts.prompt?.[0]?.text ?? '', model: opts.agentOptions?.model ?? null })
      const result = (async () => {
        await world.work?.(opts)
        opts.signal?.throwIfAborted()
        writeFileSync(join(workspace, 'state.txt'), 'fixed')
        return { stopReason: 'completed', output: [{ type: 'text', text: 'Fixed it.' }], usage: {} }
      })()
      return { result, dispose: async () => {} }
    },
  }
  const agent = { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append: () => {} }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const routes = []
  const runtime = {
    effect,
    llm: { registerAdapter: () => () => {}, stream: () => (async function* () {})(), resolveModel: async () => null, listProviders: () => [], listModels: async () => [] },
    emit: () => {}, get: () => null,
    agents: { get: () => agent, currentInitiator: () => agent },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => 0 },
    workspaceRegistry: { list: () => [] },
  }
  const ctx = {
    credentials: { resolve: async () => undefined },
    effect, subagents,
    get: () => null,
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    tools: { register: () => {} },
    inject: (_deps, fn) => fn(runtime),
  }
  jevRouter.apply(ctx, jevRouter.Config({
    agents: [{ id: 'big-local', name: 'Big (local)', provider: 'spawn', description: 'Big on this PC through llama.cpp.', enabled: true, llm: { provider: 'local', model: 'big' } }],
    fallbackAgent: 'big-local',
    historyFile: join(dataDir, 'history.jsonl'),
    checks: { enabled: false, scripts: [], timeoutMs: 60_000, outputChars: 500 },
    format: { enabled: false },
    ...config,
    laya: { port: await freePort(), connectivityUrl: 'http://connectivity.kzh-test.invalid/connecttest.txt' },
  }), {
    laya: { harnessDir, spawn: spawnLaya, run: async () => null, timing: { readyPollMs: 20, healthTimeoutMs: 1000, idleCheckMs: 20, exitWaitMs: 2000 } },
    localModels: { modules: MODULES, engineDir, modelsDir, specs: async () => PC, port: 0, spawn: server.spawn, fetch: server.fetch },
  })
  t.after(async () => {
    for (const d of effects.reverse()) { try { await d() } catch { /* already gone */ } }
    for (const c of world.children) c.kill('SIGKILL')
    for (const f of world.fakes) await f.close().catch(() => {})
  })

  /** One request to the plugin's routes, answered as JSON. */
  function http(method, path, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } })
    return new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }) } }
      routes[0].handler(req, res).catch(reject)
    })
  }
  const slash = (name, rawInput) => commands.get(name).handler({ agent, rawInput, signal: new AbortController().signal })
  const local = async () => (await http('GET', '/jev-router/local')).body
  assert.ok((await local()).modules.some((m) => m.id === 'big'), "the local models are this test's, not the harness's")
  // Big is hashed once, in the background, the first time its state is read.
  await until('Big is installed', local, (s) => s.modules?.find((m) => m.id === 'big')?.state === 'installed')
  return { http, slash, local, world, server, dataDir }
}

test('POST /jev-router/local/benchmark queues the models, answers 409 while a run goes and 400 with the reason otherwise; Cancel stops it; GET /jev-router/local follows the run', async (t) => {
  const p = await plugin(t)
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: ['nope'] }), { status: 400, body: { error: 'No local chat model is named nope.' } })
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: 'big' }), { status: 400, body: { error: 'ids: the local chat models to measure, or none for every installed one' } })
  // Benchmark all: every installed chat model. It answers at once, and the run goes on.
  const fill = p.server.hold((e) => e.body?.n_predict === 1)
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', {}), { status: 200, body: { queued: ['big'] } })
  await fill.arrived
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: ['big'] }), { status: 409, body: { error: 'A speed benchmark is already running.' } })
  const going = (await p.local()).speedRun
  assert.deepEqual([going.state, going.current, going.queue, going.done, going.restore], ['running', { id: 'big', phase: 'reading', run: null }, [], [], null])
  // Cancel: the request in flight is aborted, nothing is recorded for Big, and the engine is stopped again.
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark/cancel', {}), { status: 200, body: { ok: true } })
  const cancelled = await until('the run has ended', async () => (await p.local()).speedRun, (r) => r.state === 'idle')
  assert.deepEqual(cancelled.done, [{ id: 'big', ok: false, text: 'Big not measured: cancelled' }])
  assert.equal(cancelled.restore, 'Stopped. Readings already taken are kept; the engine is stopped again, as it was before.')
  fill.release()
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark/cancel', {}), { status: 200, body: { ok: true } }, 'also when nothing runs')
  // Run again to the end: Big's reading stands for its next load, and it is rated from it.
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: ['big'] }), { status: 200, body: { queued: ['big'] } })
  const ended = await until('the run has ended', async () => (await p.local()).speedRun, (r) => r.state === 'idle' && r.done.length === 1)
  assert.equal(ended.done[0].ok, true, ended.done[0].text)
  const big = (await p.local()).modules.find((m) => m.id === 'big')
  assert.deepEqual([big.speed.stands, big.speed.reading.tokensPerSec, big.rating.source], [true, 20, 'measured'])
})

test('a speed run is refused while a local agent works on a task through the normal run path, and a local agent that starts during one waits for it, saying so in its run', async (t) => {
  const p = await plugin(t)
  let finish
  p.world.work = () => new Promise((r) => { finish = r })
  const running = p.slash('big-local', 'Fix the state file')
  await until('the local agent is at work', () => p.world.started.length, (n) => n === 1)
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', {}), { status: 400, body: { error: 'A local agent is working on a task; start the speed benchmark when it has finished.' } })
  finish()
  assert.equal((await running).kind, 'success')
  // Now a speed run goes, and the agent's next attempt waits before its subagent starts.
  p.world.work = null
  const fill = p.server.hold((e) => e.body?.n_predict === 1)
  assert.equal((await p.http('POST', '/jev-router/local/benchmark', {})).status, 200)
  await fill.arrived
  const next = p.slash('big-local', 'Fix the state file again')
  const said = 'Waiting for the speed benchmark to finish (Big, 1 of 1).'
  await until('the run says it waits', async () => (await p.http('GET', `/jev-router/log?session=${SESSION}`)).body, (runs) => runs.some((r) => r.events.some((e) => e.text === said)))
  assert.equal(p.world.started.length, 1, 'its subagent has not started')
  fill.release()
  assert.equal((await next).kind, 'success')
  assert.equal(p.world.started.length, 2, 'it started once the run had ended')
  assert.equal((await p.local()).speedRun.state, 'idle')
})

test('a local agent held back by a speed run for longer than its time limit starts once the run ends and does the task, and the wait is neither a failed attempt nor evidence against its model', async (t) => {
  // A time limit of 400 ms, and a speed run that holds the agent back for 1.5 s: the wait stands
  // outside the attempt's own time, as a long Benchmark all on a CPU would outlast the 20 minutes.
  const p = await plugin(t, { config: { agentTimeoutMs: 400 } })
  const fill = p.server.hold((e) => e.body?.n_predict === 1)
  assert.equal((await p.http('POST', '/jev-router/local/benchmark', {})).status, 200)
  await fill.arrived
  const next = p.slash('big-local', 'Fix the state file')
  // The wait is timed from when the run says it waits, which is after the task was routed, to the
  // release of the speed run: the attempt's wait began before the first and ends after the second.
  const said = 'Waiting for the speed benchmark to finish (Big, 1 of 1).'
  await until('the run says it waits', async () => (await p.http('GET', `/jev-router/log?session=${SESSION}`)).body, (runs) => runs.some((r) => r.events.some((e) => e.text === said)))
  const seenWaiting = Date.now()
  await tick(1500)
  assert.equal(p.world.started.length, 0, 'its subagent waits for the speed run')
  const released = Date.now()
  fill.release()
  assert.equal((await next).kind, 'success')
  assert.equal(p.world.started.length, 1, 'it started once, when the run had ended')
  const rows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const [record] = await until('the run is in the history', () => rows(join(p.dataDir, 'history.jsonl')), (r) => r.length === 1)
  assert.deepEqual(record.attempts.map((a) => [a.agent, a.role, a.stopReason]), [['big-local', 'primary', 'completed']], 'one attempt, which did the work: no error and no retry')
  assert.equal(record.finalStatus, 'accepted')
  assert.ok(record.attempts[0].waitedMs >= released - seenWaiting, `the wait is kept apart: ${record.attempts[0].waitedMs} ms, at least the ${released - seenWaiting} ms it was seen waiting`)
  assert.ok(record.attempts[0].durationMs < 1400, `from the attempt's own time: ${record.attempts[0].durationMs} ms`)
  // What the run says of Big is what it did, which was to complete the task: nothing counts against it.
  const evidence = await until('the run\'s evidence is written', () => rows(join(p.dataDir, 'capability-evidence.jsonl')), (r) => r.length > 0)
  assert.ok(evidence.every((e) => e.subject.model === 'big'))
  assert.deepEqual(evidence.filter((e) => e.score !== 1).map((e) => [e.dimension, e.score]), [], 'no row scores the wait')
})

test('a speed run is refused while Laya is answering a call', async (t) => {
  const p = await plugin(t, { laya: true })
  assert.equal((await p.http('POST', '/jev-router/laya/start', {})).status, 200)
  const [fake] = await until('laya.serve is up', () => p.world.fakes, (f) => f.length === 1)
  // Test Laya's first call does not come back while this test runs: it stays on the wire.
  const before = fake.requests.length
  fake.hang()
  const selftest = p.http('POST', '/jev-router/laya/selftest', {}).catch(() => null)
  await until('Laya is answering a call', () => fake.requests.length, (n) => n > before)
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', {}), { status: 400, body: { error: 'Laya is answering a call right now, and would slow the measurement. Try again when it is idle.' } })
  assert.equal((await p.local()).speedRun.state, 'idle', 'nothing was started')
  void selftest
})

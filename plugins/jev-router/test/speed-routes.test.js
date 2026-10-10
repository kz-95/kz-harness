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
    let readable = true
    try { value = await read() } catch (err) { value = `not readable yet: ${err.message}`; readable = false }
    if (readable && ok(value)) return value
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
 * With `world.steered` a list, each subagent has an in-process agent, which keeps each steer it is
 * given there, with the number of its start, and takes it in at once, as its inbox says.
 * With `laya`, Laya is installed and its supervisor keeps a fake laya.serve, found in `world.fakes`.
 * `config` is laid over the plugin config below. `tasks` are task records the plugin finds saved in
 * tasks.jsonl as it starts, as an earlier run of the app left them, and `files` other files of its
 * data folder, by name. With `jobs` the engine has a job service, so a task typed into the chat runs
 * in the background; `world.onJob(id)` hears each job it starts. `replies` goes to apply() as its
 * seam of that name. Everything the plugin appends to the chat is in `world.appended`, and
 * `adapter()` is the chat's adapter, for a test that reads a reply's chunks itself. `modules` are the
 * local models' modules, each model among them installed, and `elsewhere(id)` is a chat of its own,
 * by its session id, in a git folder of its own, for `slash(name, input, { as })` to run in.
 */
async function plugin(t, { laya = false, config = {}, tasks = null, files = {}, jobs = false, replies = null, modules = MODULES, localSeams = {}, greedy = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-speed-'))
  made.push(root)
  const dataDir = join(root, 'data')
  const harnessDir = join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  if (tasks) writeFileSync(join(dataDir, 'tasks.jsonl'), tasks.map((r) => `${JSON.stringify(r)}\n`).join(''))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dataDir, name), body)
  const pinsFile = join(harnessDir, 'config', 'laya.json')
  mkdirSync(dirname(pinsFile), { recursive: true })
  copyFileSync(join(REPO, 'config', 'laya.json'), pinsFile)
  if (laya) await installLaya(harnessDir, dataDir)
  // The local models' folders, with the engine and each model (Big) in place as a hand install leaves them.
  const engineDir = join(root, 'engine')
  const modelsDir = join(root, 'models')
  mkdirSync(join(engineDir, '.installed'), { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  for (const m of modules) if (m.kind === 'model') writeFileSync(join(modelsDir, m.file), m.id)
  // `greedy`, when given, answers the speed run's output check (docs/benchmark.md 2.15).
  const server = fakeLlamaServer({ report: () => SPLIT, greedy })
  // A git repository for the session's workspace, as every run needs one.
  const gitFolder = (name) => {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, 'state.txt'), 'broken')
    const g = (...a) => execFileSync('git', a, { cwd: dir })
    g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    return dir
  }
  const workspace = gitFolder('work')

  const world = { work: null, started: [], fakes: [], children: [], appended: [], onJob: null, steered: null }
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
      const n = world.started.push({ provider, prompt: opts.prompt?.[0]?.text ?? '', model: opts.agentOptions?.model ?? null })
      const result = (async () => {
        await world.work?.(opts)
        opts.signal?.throwIfAborted()
        writeFileSync(join(workspace, 'state.txt'), 'fixed')
        return { stopReason: 'completed', output: [{ type: 'text', text: 'Fixed it.' }], usage: {} }
      })()
      if (!world.steered) return { result, dispose: async () => {} }
      const on = new Map()
      const localAgent = {
        steer: (message) => { world.steered.push({ n, ...message }); on.get('agent/inbox/claimed')?.({ message }) },
        ctx: { on: (name, fn) => { on.set(name, fn); return () => on.delete(name) } },
        session: { seq: 0, snapshotEvents: () => [] },
      }
      return { id: `child-session-${n}`, result, localAgent, dispose: async () => {} }
    },
  }
  let jobCount = 0
  const jobService = {
    start: (spec) => { const id = `jev-${++jobCount}`; spec.run(); world.onJob?.(id); return id },
    wait: () => new Promise(() => {}),
    read: (id) => ({ text: '', snapshot: { id } }),
    kill: () => 'requested',
  }
  const agent = { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append: (_kind, msg, opts) => world.appended.push({ msg, opts }) }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const routes = []
  let adapter = null
  const runtime = {
    effect,
    llm: { registerAdapter: (ids, a) => { if (ids.includes('jev')) adapter = a; return () => {} }, stream: () => (async function* () {})(), resolveModel: async () => null, listProviders: () => [], listModels: async () => [] },
    emit: () => {}, get: () => null,
    agents: { get: () => agent, currentInitiator: () => agent },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => 0 },
    workspaceRegistry: { list: () => [] },
  }
  const ctx = {
    credentials: { resolve: async () => undefined },
    effect, subagents,
    get: (name) => (name === 'jobs' && jobs ? jobService : null),
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
    localModels: { modules, engineDir, modelsDir, specs: async () => PC, port: 0, spawn: server.spawn, fetch: server.fetch, ...localSeams },
    ...(replies ? { replies } : {}),
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
  const slash = (name, rawInput, { as = agent } = {}) => commands.get(name).handler({ agent: as, rawInput, signal: new AbortController().signal })
  const elsewhere = (id) => ({ id, session: { id, header: { cwd: gitFolder(id) }, append: (_kind, msg, opts) => world.appended.push({ msg, opts }) }, whenIdle: async () => {} })
  // One message typed into Jev Auto, or to the agent `model` names, as the engine streams it through
  // the adapter: the reply's text, or the error that ended it. The chat so far goes with it, as the
  // engine sends it.
  const chat = []
  async function say(text, { signal, model = 'jev-auto' } = {}) {
    chat.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const out = { text: '', error: null }
    try {
      for await (const e of adapter.stream({ model, messages: [...chat], sessionId: SESSION, signal: signal ?? new AbortController().signal })) if (e.type === 'text-delta') out.text += e.text
    } catch (err) { out.error = err }
    chat.push({ role: 'assistant', content: [{ type: 'text', text: out.text }] })
    return out
  }
  const local = async () => (await http('GET', '/jev-router/local')).body
  assert.ok((await local()).modules.some((m) => m.id === 'big'), "the local models are this test's, not the harness's")
  // Each model (Big) is hashed once, in the background, the first time its state is read.
  for (const m of modules) if (m.kind === 'model') await until(`${m.name} is installed`, local, (s) => s.modules?.find((x) => x.id === m.id)?.state === 'installed')
  return { http, slash, elsewhere, say, local, world, server, dataDir, workspace, adapter: () => adapter }
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

test('GET /jev-router/local/log serves the tail of llama-server\'s log, kept beside local.json, with the start\'s key taken out', async (t) => {
  const p = await plugin(t)
  assert.deepEqual(await p.http('POST', '/jev-router/local/start', { model: 'big' }), { status: 200, body: { ok: true } })
  const got = await p.http('GET', '/jev-router/local/log?lines=50')
  assert.equal(got.status, 200)
  assert.equal(got.body.file, join(p.dataDir, 'llama-server.log'))
  assert.ok(got.body.lines.some((l) => / KzH: starting big on 127\.0\.0\.1:\d+: /.test(l)), got.body.lines.join('\n'))
  assert.ok(got.body.lines.some((l) => / KzH: ready: big on 127\.0\.0\.1:\d+ after /.test(l)), got.body.lines.join('\n'))
  assert.ok(!readFileSync(join(p.dataDir, 'llama-server.log'), 'utf8').includes(p.server.started.at(-1).key), 'the key is not in the file')
  assert.equal((await p.http('GET', '/jev-router/local/log?lines=1')).body.lines.length, 1, 'as many lines as asked for')
  assert.equal((await p.http('GET', '/jev-router/local/log')).body.lines.length, got.body.lines.length, '200 unless said, of the few there are')
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

// A second model, Small, and a local agent for each model.
const SMALL = { id: 'small', kind: 'model', name: 'Small', source: 'https://huggingface.co/Org/Small-GGUF/resolve/main/small.gguf', file: 'small.gguf', size: 2 * GIB, sha256: sha('small'), reliability: 'official-stable', verified: true, role: 'fast', rank: 2, recommendedVramGB: 3, minRamGB: 8, contextSize: 8192, maxContext: 40960 }
const LOCAL_AGENTS = [
  { id: 'big-local', name: 'Big (local)', provider: 'spawn', description: 'Big on this PC through llama.cpp.', enabled: true, llm: { provider: 'local', model: 'big' } },
  { id: 'small-local', name: 'Small (local)', provider: 'spawn', description: 'Small on this PC through llama.cpp.', enabled: true, llm: { provider: 'local', model: 'small' } },
]

/**
 * A clock for the capped wait for a model: `now` and `setTimer` for the local models, which stand
 * still until `advance(ms)` moves the clock on and runs every timer due by then.
 */
function fakeClock() {
  let at = 0
  let timers = []
  return {
    now: () => at,
    setTimer: (fn, ms) => { const x = { due: at + ms, fn }; timers.push(x); return () => { timers = timers.filter((y) => y !== x) } },
    advance(ms) {
      at += ms
      const due = timers.filter((x) => x.due <= at)
      timers = timers.filter((x) => x.due > at)
      for (const x of due) x.fn()
    },
  }
}

test('the plugin config caps a local agent\'s wait for another model at 2 minutes by default, takes 1 to 60, and has no setting without a cap', () => {
  assert.equal(jevRouter.Config({}).local.modelWaitCapMinutes, 2)
  assert.equal(jevRouter.Config({ local: { modelWaitCapMinutes: 60 } }).local.modelWaitCapMinutes, 60)
  for (const bad of [0, 61, 1.5]) assert.throws(() => jevRouter.Config({ local: { modelWaitCapMinutes: bad } }), /modelWaitCapMinutes/, `${bad} is refused`)
})

test('a local agent on another model waits before it starts while local agents\' attempts hold theirs, its line naming the task that holds it, or another run for a run started from the chat; one on the same model starts at once until the one waiting has waited the cap the plugin config sets, and then waits behind it, whose line says it is next', async (t) => {
  // The clock stands still until the test moves it on, and the cap is 3 minutes, not the 2 by default.
  const clock = fakeClock()
  const p = await plugin(t, { jobs: true, modules: [...MODULES, SMALL], config: { agents: LOCAL_AGENTS, local: { modelWaitCapMinutes: 3 } }, localSeams: { now: clock.now, setTimer: clock.setTimer } })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const waits = async (session) => (await p.http('GET', `/jev-router/log?session=${session}`)).body.flatMap((r) => r.events.map((e) => e.text)).filter((x) => /^Waiting for /.test(x ?? ''))
  // A task of the chat on Big, jev-1, holds Big for its whole attempt.
  await p.say('Fix the state file', { model: 'agent-big-local' })
  await until('the task is at work', () => p.world.started.length, (n) => n === 1)
  // A run on Small in another folder, so no folder's line holds it back, waits for Big to be let go.
  const small = p.slash('small-local', 'Fix the state file there', { as: p.elsewhere('session-small') })
  await until('the run on Small waits or starts', async () => (await waits('session-small')).length + p.world.started.length, (n) => n > 1)
  assert.equal(p.world.started.length, 1, 'its subagent waits while the task holds Big')
  assert.deepEqual(await waits('session-small'), ['Waiting for jev-1 to finish with Big: one local model works at a time.'])
  // Short of the 3 minutes, a run on Big in a third folder starts at once beside the task.
  clock.advance(179_999)
  const big = p.slash('big-local', 'Fix the state file too', { as: p.elsewhere('session-big') })
  await until('the second run on Big starts', () => p.world.started.length, (n) => n === 2)
  assert.deepEqual(p.world.started.map((s) => s.model), ['big', 'big'])
  // The task ends, and the run on Small waits on for the run on Big, which holds Big now.
  finishes.shift()()
  await until('the run on Small says what it waits for now', () => waits('session-small'), (l) => l.length === 2)
  assert.deepEqual(await waits('session-small'), ['Waiting for jev-1 to finish with Big: one local model works at a time.', 'Waiting for another run to finish with Big: one local model works at a time.'])
  assert.equal(p.world.started.length, 2, 'its subagent still waits')
  // At 3 minutes a run on Big in a fourth folder waits behind the run on Small, whose line says it is next.
  clock.advance(1)
  const late = p.slash('big-local', 'Fix the state file as well', { as: p.elsewhere('session-late') })
  await until('the late run on Big waits or starts', async () => (await waits('session-late')).length + p.world.started.length, (n) => n > 2)
  assert.equal(p.world.started.length, 2, 'no run joins Big ahead of the one that has waited the cap')
  assert.deepEqual(await waits('session-late'), ['Waiting for another run, which has waited longer, to finish with Small: one local model works at a time.'])
  await until('the run on Small says it is next', () => waits('session-small'), (l) => l.length === 3)
  assert.equal((await waits('session-small'))[2], 'Waiting for another run to finish with Big; it is next once that ends.')
  // Big is let go once the run already on it ends, Small goes next, and the late run on Big after it.
  finishes.shift()()
  assert.equal((await big).kind, 'success')
  await until('the run on Small starts once no attempt holds Big', () => p.world.started.length, (n) => n === 3)
  assert.equal(p.world.started[2].model, 'small')
  await until('the late run on Big says it waits for Small now', () => waits('session-late'), (l) => l.at(-1) === 'Waiting for another run to finish with Small: one local model works at a time.')
  finishes.shift()()
  assert.equal((await small).kind, 'success')
  await until('the late run on Big starts once Small is let go', () => p.world.started.length, (n) => n === 4)
  assert.equal(p.world.started[3].model, 'big')
  finishes.shift()()
  assert.equal((await late).kind, 'success')
})

test('words steered into a task while its local agent waits for another model, its prompt built already, go to that agent as it starts, which reads them, rather than end as not used', async (t) => {
  const p = await plugin(t, { jobs: true, modules: [...MODULES, SMALL], config: { agents: LOCAL_AGENTS } })
  p.world.steered = []
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const task = async () => (await p.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1')
  // A run on Big in a folder of its own holds Big, and a task of the chat on Small, jev-1, waits for it.
  const big = p.slash('big-local', 'Fix the state file there', { as: p.elsewhere('session-big') })
  await until('the run on Big is at work', () => p.world.started.length, (n) => n === 1)
  await p.say('Fix the state file', { model: 'agent-small-local' })
  const said = 'Waiting for another run to finish with Big: one local model works at a time.'
  await until('the task waits for Big', async () => (await p.http('GET', `/jev-router/log?session=${SESSION}`)).body, (runs) => runs.some((r) => r.events.some((e) => e.text === said)))
  const waiting = await task()
  assert.deepEqual([waiting?.controls?.steer?.path, waiting?.controls?.steer?.why], [null, 'between'], 'no agent of the task is at work yet')
  const steer = await p.http('POST', '/jev-router/tasks/steer', { key: waiting.key, text: 'use tabs', how: 'live' })
  assert.deepEqual([steer.status, steer.body.result, steer.body.words], [200, 'pending', 'jev-1 has no agent at work right now, so this goes with its next attempt, if there is one.'])
  // Big is let go, and the task's agent starts on the prompt built before the words, which go to its inbox as it starts.
  finishes.shift()()
  assert.equal((await big).kind, 'success')
  const working = await until('the agent on Small is at work', task, (x) => x?.controls?.steer?.path === 'spawn')
  assert.deepEqual(p.world.started.map((s) => s.model), ['big', 'small'])
  assert.doesNotMatch(p.world.started[1].prompt, /use tabs/, 'its prompt was built before the words were given')
  assert.deepEqual(p.world.steered.map((m) => [m.n, m.role, m.content[0].text]), [[2, 'user', '(Added by the person while you work on this task.) use tabs']])
  assert.deepEqual(working.steers.map((s) => [s.how, s.state, s.attempt, s.agent, s.name]), [['live', 'delivered', 0, 'small-local', 'Small (local)']], 'its agent read them')
  // Its work done, the words stay read, not returned as not used.
  finishes.shift()()
  const done = await until('the task ends', task, (x) => x?.state === 'completed')
  assert.deepEqual(done.steers.map((s) => s.state), ['delivered'])
  assert.equal(p.world.steered.length, 1, 'given once')
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

test('POST /jev-router/tasks/seen {results:[{jobId, name}]} acknowledges only a finished task with that name', async (t) => {
  // Two finished results posted and not yet seen when the app was closed, so their notices are in the
  // chat and can still be read. The engine counts job ids from 1 again after a restart, so the chat
  // can still hold an older task's notice under jev-2. The third record is in a state this build does
  // not know, which it keeps as it loads: not finished, it has no result to read even under its own
  // name (one still running when the app was closed would come back stopped instead).
  const row = (jobId, taskName, state = 'completed') => ({ jobId, sessionId: SESSION, workspace: 'C:/w', taskName, taskText: taskName, state, finishedAt: 1, deliveryState: 'delivering', seq: 2, report: `${taskName} report` })
  const p = await plugin(t, { tasks: [row('jev-1', 'Fix the parser · keep the tests green'), row('jev-2', 'Tidy the docs'), row('jev-3', 'Wait for approval', 'archived')] })
  const seen = (body) => p.http('POST', '/jev-router/tasks/seen', body)
  const unread = async () => Object.fromEntries((await p.http('GET', '/jev-router/tasks')).body.tasks.map((x) => [x.jobId, x.deliveryState]))
  // jev-1 under its own name, however the separator is spaced; jev-2 under the older task's name;
  // jev-3 under its own; an id nobody has; and an entry with no name, which a page that names
  // results never sends.
  assert.deepEqual(await seen({ results: [{ jobId: 'jev-1', name: 'Fix the parser·keep the tests green' }, { jobId: 'jev-2', name: 'Write the changelog' }, { jobId: 'jev-3', name: 'Wait for approval' }, { jobId: 'jev-9', name: 'x' }, { jobId: 'jev-2' }] }), { status: 200, body: { acknowledged: ['jev-1'] } })
  assert.deepEqual(await unread(), { 'jev-1': 'delivered', 'jev-2': 'pending', 'jev-3': 'pending' }, 'the older task\'s notice marked nothing read, and the unfinished task\'s own name nothing either')
  assert.deepEqual(await seen({ results: [{ jobId: 'jev-2', name: 'Tidy the docs' }] }), { status: 200, body: { acknowledged: ['jev-2'] } })
  assert.deepEqual(await unread(), { 'jev-1': 'delivered', 'jev-2': 'delivered', 'jev-3': 'pending' })
  // A page from before, which names only ids, is still heard.
  const q = await plugin(t, { tasks: [row('jev-1', 'Fix the parser')] })
  assert.deepEqual(await q.http('POST', '/jev-router/tasks/seen', { jobIds: ['jev-1', 'not an id'] }), { status: 200, body: { acknowledged: ['jev-1'] } })
})

test('POST /jev-router/tasks/seen {sessionId, results} marks read only a result of the chat the rows are in', async (t) => {
  // A result posted in this chat and not yet seen when the app was closed, so its notice is in the chat.
  const p = await plugin(t, { tasks: [{ jobId: 'jev-1', sessionId: SESSION, workspace: 'C:/w', taskName: 'run the tests', taskText: 'run the tests', state: 'completed', finishedAt: 1, deliveryState: 'delivering', seq: 2, report: 'the report' }] })
  const seen = (sessionId) => p.http('POST', '/jev-router/tasks/seen', { sessionId, results: [{ jobId: 'jev-1', name: 'run the tests' }] })
  const state = async () => (await p.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1').deliveryState
  // Another chat is on screen, whose older row names the same id and task, as the same words sent
  // there before a restart leave it; and chats that are no session id, which match nothing.
  for (const chat of ['session-other', 'not a chat/..', 7, { id: SESSION }]) {
    assert.deepEqual(await seen(chat), { status: 200, body: { acknowledged: [] } }, JSON.stringify(chat))
  }
  assert.equal(await state(), 'pending', 'still unread')
  assert.deepEqual(await seen(SESSION), { status: 200, body: { acknowledged: ['jev-1'] } })
  assert.equal(await state(), 'delivered')
})

// ---------------------------------------------------------------- the start reply and its notices
// A result's summary names its task between `·`s (delivery.js); a milestone notice's never holds one.
const isResult = (a) => String(a.msg.source?.summary ?? '').includes('·')
const noticesOf = (p) => p.world.appended.filter((a) => a.msg.source?.plugin === 'jev-router' && a.msg.source?.form === 'notice' && !isResult(a))
const resultsOf = (p) => p.world.appended.filter(isResult)
const folderOf = (dir) => dir.split(/[\\/]/).filter(Boolean).at(-1)

test('a task whose reply was aborted gets exactly one started notice via the guard timer', async (t) => {
  // The reply waits 200 ms for the pick, and one that said nothing is taken to have named nothing
  // 100 ms after that.
  const p = await plugin(t, { jobs: true, files: { 'chat-replies.json': JSON.stringify({ waitMs: 200 }) }, replies: { graceMs: 100 } })
  let finish = null
  p.world.work = () => new Promise((r) => { finish = r })
  // Stopped the moment the task is queued, so the reply is stopped in its wait for the pick.
  const stop = new AbortController()
  p.world.onJob = () => stop.abort()
  const said = await p.say('Fix the state file', { signal: stop.signal })
  await until('the agent is at work', () => p.world.started.length, (n) => n === 1)
  const posted = await until('the started notice is posted', () => noticesOf(p), (n) => n.length > 0, { timeoutMs: 5000 }).catch(() => noticesOf(p))
  finish?.()
  await until('the result is posted', () => resultsOf(p).length, (n) => n === 1).catch(() => 0)
  assert.equal(said.text, '', 'the stopped reply said nothing')
  assert.equal(said.error?.name, 'AbortError')
  assert.deepEqual(posted.map((a) => a.msg.source.summary), ['jev-1 started: Big (local), big'])
  assert.equal(posted[0].msg.content[0].text, `**jev-1** started: **Big (local)** (big) is working on it in ${folderOf(p.workspace)}. Watch it in the Live tab; the result posts here when it's done.`)
  assert.deepEqual(posted[0].opts, { surfaceOp: 'append' })
  assert.equal(noticesOf(p).length, 1, 'exactly one notice, beside its result')
  assert.equal(resultsOf(p).length, 1)
})

test('a task queued behind another whose reply B is dropped before it goes out gets exactly one started notice via the guard timer', async (t) => {
  // The guard fires 200 ms and then 100 ms after the task is queued, long before the first task ends.
  // The first task's own guard fires too, while it still works, and must leave alone the plan its
  // reply A already named.
  const p = await plugin(t, { jobs: true, files: { 'chat-replies.json': JSON.stringify({ waitMs: 200 }) }, replies: { graceMs: 100 } })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  await p.say('Fix the state file')
  await until('the first task is at work', () => p.world.started.length, (n) => n === 1)
  // The second waits its turn. Its reply is read up to its first words and dropped there, as the
  // engine drops a stream once Stop lands, so it never says what it named. p.say would read on.
  const reply = p.adapter().stream({ model: 'jev-auto', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Now tidy the state file' }] }], sessionId: SESSION, signal: new AbortController().signal })
  let said = ''
  while (!said) { const { value, done } = await reply.next(); if (done) break; if (value.type === 'text-delta') said = value.text }
  await reply.return()
  await tick(500)
  finishes.shift()?.()
  await until('the second task is at work', () => p.world.started.length, (n) => n === 2).catch(() => 0)
  const two = () => noticesOf(p).filter((a) => a.msg.source.summary.startsWith('jev-2'))
  const posted = await until('its started notice is posted', two, (n) => n.length > 0, { timeoutMs: 5000 }).catch(() => two())
  finishes.shift()?.()
  await until('both results are posted', () => resultsOf(p).length, (n) => n === 2).catch(() => 0)
  assert.match(said, /^OK, \*\*jev-2\*\* is queued: /, 'reply B, which names no plan')
  assert.deepEqual(posted.map((a) => a.msg.source.summary), ['jev-2 started: Big (local), big'])
  assert.equal(two().length, 1, 'exactly one, beside its result')
  assert.deepEqual(noticesOf(p).map((a) => a.msg.source.summary), ['jev-2 started: Big (local), big'], 'none for jev-1, whose reply A named its plan before its guard fired')
  assert.equal(resultsOf(p).length, 2)
})

test('a task in an idle folder gets reply A naming the agent and model its row shows, and one queued behind it gets B and then exactly one started notice', async (t) => {
  const p = await plugin(t, { jobs: true })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const one = await p.say('Fix the state file')
  await until('the first task is at work', () => p.world.started.length, (n) => n === 1)
  const two = await p.say('Now tidy the state file')
  // The second waits over a second for the folder, which its started notice says.
  await tick(1500)
  finishes.shift()?.()
  await until('the second task is at work', () => p.world.started.length, (n) => n === 2).catch(() => 0)
  const notices = await until('its started notice is posted', () => noticesOf(p), (n) => n.length > 0, { timeoutMs: 5000 }).catch(() => noticesOf(p))
  finishes.shift()?.()
  await until('both results are posted', () => resultsOf(p).length, (n) => n === 2).catch(() => 0)
  const rows = (await p.http('GET', '/jev-router/tasks')).body.tasks
  const first = rows.find((x) => x.jobId === 'jev-1')
  const where = folderOf(p.workspace)
  // The reply said what the task list later shows for the run: its agent (by name), its model and no effort.
  assert.deepEqual([first.agent, first.model, first.effort], ['big-local', 'big', null])
  const [said, credit, job, run, agents] = one.text.split('\n\n')
  assert.equal(said, `OK, I'll run **Big (local)** with **big** in the background as **jev-1** in ${where}. I'll report back here when it's done. Keep chatting.`)
  assert.match(credit ?? '', /^> Picked on this PC in (under 0\.1|\d+(\.\d)?) s, no Jev call\.$/, 'offline, the rule on this PC picked it')
  assert.equal(job, `[jev-job]: kzh-job-1-${first.key}`)
  assert.equal(run, `[jev-run]: kzh-run-1-${first.runId}`)
  assert.deepEqual(JSON.parse(Buffer.from(/kzh-agents-1-(\S+)$/.exec(agents ?? '')?.[1] ?? '', 'base64url').toString() || 'null'), [{ agent: 'big-local', model: 'big', roles: ['work'] }])
  assert.equal(two.text, `OK, **jev-2** is queued: 2nd in line for ${where} (another task is running there). Jev picks the agent when it starts; I'll say which here, and report back when it's done. Keep chatting.\n\n[jev-job]: kzh-job-1-${rows.find((x) => x.jobId === 'jev-2').key}`)
  assert.deepEqual(notices.map((a) => a.msg.source.summary), ['jev-2 started: Big (local), big'], 'a notice for the task whose reply named no plan, and none for the one whose reply did')
  assert.match(notices[0].msg.content[0].text, new RegExp(`^\\*\\*jev-2\\*\\* started: \\*\\*Big \\(local\\)\\*\\* \\(big\\) is working on it in ${where}\\. It waited \\d+ s for the folder\\. Watch it in the Live tab; the result posts here when it's done\\.$`), 'and how long it waited, for what')
  assert.equal(noticesOf(p).length, 1)
})

test('GET and POST /jev-router/chat-replies/settings: 15 s and milestones as shipped, a patch changes its own fields and is kept, and a wrong field is refused with what it takes', async (t) => {
  const p = await plugin(t)
  const settings = (body) => p.http(body === undefined ? 'GET' : 'POST', '/jev-router/chat-replies/settings', body)
  assert.deepEqual(await settings(), { status: 200, body: { waitMs: 15_000, progress: 'milestones', askWhenWrong: true } })
  assert.deepEqual(await settings({ waitMs: 5000 }), { status: 200, body: { waitMs: 5000, progress: 'milestones', askWhenWrong: true } })
  assert.deepEqual(await settings({ progress: 'off', askWhenWrong: false, unknown: 1 }), { status: 200, body: { waitMs: 5000, progress: 'off', askWhenWrong: false } })
  for (const [patch, error] of [
    [{ waitMs: 60_001 }, 'waitMs: whole milliseconds from 0 to 60000 (0 replies at once)'],
    [{ waitMs: 1.5, progress: 'milestones' }, 'waitMs: whole milliseconds from 0 to 60000 (0 replies at once)'],
    [{ progress: 'sometimes' }, "progress: 'milestones', or 'off' for the start reply and the result only"],
    [{ askWhenWrong: 'yes' }, 'askWhenWrong: true or false'],
    [[1], 'chat replies: an object of the settings to change'],
  ]) assert.deepEqual(await settings(patch), { status: 400, body: { error } }, JSON.stringify(patch))
  const saved = readFileSync(join(p.dataDir, 'chat-replies.json'), 'utf8')
  assert.deepEqual(JSON.parse(saved), { waitMs: 5000, progress: 'off', askWhenWrong: false }, 'a refused patch saved nothing')
  // As the app starts again, it reads them back.
  const q = await plugin(t, { files: { 'chat-replies.json': saved } })
  assert.deepEqual((await q.http('GET', '/jev-router/chat-replies/settings')).body, { waitMs: 5000, progress: 'off', askWhenWrong: false })
})

test('a task that fails before its pick, while its reply waits for it, is answered that it ended, and its result follows as its own message', async (t) => {
  // Every agent is excluded by the routing policy, so the router fails the task before it picks one.
  const p = await plugin(t, { jobs: true, config: { routing: { disabledResources: ['big-local'] } } })
  const said = await p.say('Fix the state file')
  const [result] = await until('the result is posted', () => resultsOf(p), (r) => r.length === 1)
  const [row] = (await p.http('GET', '/jev-router/tasks')).body.tasks
  assert.equal(row.state, 'failed')
  assert.equal(said.text, `**jev-1** ended before Jev picked its agent (Failed). Its result is posted here as its own message.\n\n[jev-job]: kzh-job-1-${row.key}\n\n[jev-run]: kzh-run-1-${row.runId}`, 'not C, which would say it is starting and promise the pick; and with the run that ended')
  assert.equal(result.msg.source.summary, 'jev-1 · Fix the state file · Failed')
  assert.match(result.msg.content[0].text, /every agent is excluded by the routing policy: big-local \(disabled by configuration\)/, 'the result says why')
  assert.deepEqual([p.world.started.length, noticesOf(p).length], [0, 0], 'no agent started, and nothing but its result is posted')
})

test('a started notice owed once the reply says what it named is posted then, not at the guard, when the pick lands before the reply is out', async (t) => {
  // The reply waits 1 ms for the pick, so it is C; the guard would post the started notice only 20 s on.
  const p = await plugin(t, { jobs: true, files: { 'chat-replies.json': JSON.stringify({ waitMs: 1 }) }, replies: { graceMs: 20_000 } })
  let finish = null
  p.world.work = () => new Promise((r) => { finish = r })
  // The reply is read up to its text and held there, as a reader slower than the pick would.
  const reply = p.adapter().stream({ model: 'jev-auto', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the state file' }] }], sessionId: SESSION, signal: new AbortController().signal })
  let text = ''
  while (!text) { const { value, done } = await reply.next(); if (done) break; if (value.type === 'text-delta') text = value.text }
  assert.match(text, /^OK, \*\*jev-1\*\* is starting in [^,]+, and Jev is still choosing the agent/, text)
  await until('the agent is at work', () => p.world.started.length, (n) => n === 1)
  assert.deepEqual(noticesOf(p), [], 'picked, but the reply has not yet said that it named nothing')
  for (;;) { const { done } = await reply.next(); if (done) break }
  const posted = await until('the started notice is posted', () => noticesOf(p), (n) => n.length > 0, { timeoutMs: 5000 })
  assert.deepEqual(posted.map((a) => a.msg.source.summary), ['jev-1 started: Big (local), big'])
  finish?.()
  await until('the result is posted', () => resultsOf(p).length, (n) => n === 1)
  assert.equal(noticesOf(p).length, 1, 'exactly one notice, beside its result')
  const [row] = (await p.http('GET', '/jev-router/tasks')).body.tasks
  assert.match(text, new RegExp(`\\n\\n\\[jev-run\\]: kzh-run-1-${row.runId}$`, 'm'), 'C was written once its task had begun its run, and carries it')
})

test('with Start and result only saved, the replies promise only the result and no milestone notice is posted, the started one included', async (t) => {
  // The reply waits 1 ms for the pick, so the first is C, built from what the task's enqueue answers;
  // one that said nothing is taken to have named nothing 100 ms after that.
  const p = await plugin(t, { jobs: true, files: { 'chat-replies.json': JSON.stringify({ waitMs: 1 }) }, replies: { graceMs: 100 } })
  assert.equal((await p.http('POST', '/jev-router/chat-replies/settings', { progress: 'off' })).status, 200)
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const one = await p.say('Fix the state file')
  await until('the first task is at work', () => p.world.started.length, (n) => n === 1)
  const two = await p.say('Now tidy the state file')
  finishes.shift()?.()
  await until('the second task is at work', () => p.world.started.length, (n) => n === 2)
  // Long enough for a started notice to have been posted, and past each task's guard.
  await tick(500)
  const notices = noticesOf(p)
  finishes.shift()?.()
  await until('both results are posted', () => resultsOf(p).length, (n) => n === 2)
  assert.equal(one.text.split('\n\n')[0], `OK, **jev-1** is starting in ${folderOf(p.workspace)}, and Jev is still choosing the agent (0 s so far). I'll report back here when it's done. Keep chatting.`, 'C promises no word of the pick')
  assert.equal(two.text.split('\n\n[jev-job]')[0], `OK, **jev-2** is queued: 2nd in line for ${folderOf(p.workspace)} (another task is running there). Jev picks the agent when it starts; I'll report back here when it's done. Keep chatting.`)
  assert.deepEqual(notices, [], 'both tasks started on an agent their replies did not name, and no notice said so')
  assert.deepEqual(noticesOf(p), [])
})

/**
 * Two agents that run Big on this PC, where offline the rule gives the work to the last of them, Big
 * Two, and the reply ledger and predictor of 60 earlier tasks like 'Fix the state file' that routing
 * gave Big (local), but for four: the predictor's guesses of the newest 50 scored, 47 right, so quick
 * replies and the likely agent are earned, and its guess for such a task is Big (local). As files of
 * the plugin's data folder, with the agents for its config.
 */
async function earnedGuesses() {
  const { replyFeatures, trainPredictor } = await import('../reply-ledger.js')
  const { saveArtifact } = await import('../classifier.js')
  const bigLocal = { id: 'big-local', name: 'Big (local)', provider: 'spawn', description: 'Big on this PC through llama.cpp.', enabled: true, llm: { provider: 'local', model: 'big' } }
  const bigTwo = { id: 'big-two', name: 'Big Two (local)', provider: 'spawn', description: 'Big again, as a second agent.', enabled: true, llm: { provider: 'local', model: 'big' } }
  const available = ['big-local', 'big-two']
  const misses = new Set([3, 13, 23, 33])
  const rows = Array.from({ length: 60 }, (_, i) => {
    const ran = { agent: misses.has(i) ? 'big-two' : 'big-local', level: null, effort: null, model: 'big' }
    return {
      ts: new Date(Date.now() - (60 - i) * 60_000).toISOString(), sessionId: 'earlier', key: `seed-${i}`, jobId: `jev-${i}`, decider: 'jev', mode: 'auto', forced: false,
      features: replyFeatures({ text: 'Fix the state file', available, mode: 'auto', level: 'auto', decider: 'jev' }),
      predicted: { agent: 'big-local', level: null, confidence: 0.97, trusted: true }, said: { agent: null, effort: null, model: null, how: 'routed', ms: 900 }, ran, match: !misses.has(i), verdict: null, ask: null,
    }
  })
  const modelFile = join(mkdtempSync(join(tmpdir(), 'kz-speed-model-')), 'reply-model.json')
  made.push(dirname(modelFile))
  saveArtifact(modelFile, trainPredictor(rows))
  return { agents: [bigLocal, bigTwo], files: { 'reply-ledger.jsonl': rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'reply-model.json': readFileSync(modelFile, 'utf8') } }
}

test('a predicted reply whose route differs posts exactly one change-of-plan notice, and its task\'s row holds what the ask reads: the guess the reply named and what ran', async (t) => {
  const earned = await earnedGuesses()
  // The reply goes out at once (Reply at once), so it names the guess whatever routing does meanwhile.
  const p = await plugin(t, { jobs: true, config: { agents: earned.agents }, files: { ...earned.files, 'chat-replies.json': JSON.stringify({ waitMs: 0 }) } })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const said = await p.say('Fix the state file')
  await until('the task is at work', () => p.world.started.length, (n) => n === 1)
  const posted = await until('its change of plan is posted', () => noticesOf(p), (n) => n.length > 0, { timeoutMs: 5000 }).catch(() => noticesOf(p))
  finishes.shift()?.()
  await until('its result is posted', () => resultsOf(p).length, (n) => n === 1)
  await tick(300)
  const where = folderOf(p.workspace)
  const [reply, credit] = said.text.split('\n\n')
  assert.equal(reply, `OK, I'll run **Big (local)** with **big** in the background as **jev-1** in ${where}. I'll report back here when it's done. Keep chatting.`, 'the guess, before routing picked')
  assert.equal(credit, '> Predicted on this PC from your recent tasks (right 47 of the last 50). The pick is checked again when it starts.', 'offline, no decider read the message')
  const row = (await p.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1')
  assert.equal(row.agent, 'big-two', 'routing gave the work to the other agent')
  assert.deepEqual(posted.map((a) => [a.msg.source.summary, a.msg.content[0].text]), [['jev-1: Big Two (local) instead of Big (local)', 'The local router picked Big Two (local) (big) when it started.']])
  assert.equal(noticesOf(p).length, 1, 'exactly one notice beside the result: no started notice too')
  // What the ask under the reply reads (client.js askFor): the agent the reply named, and the one that ran.
  const ledgerRow = (await p.http('GET', `/jev-router/replies?key=${row.key}`)).body
  assert.deepEqual([ledgerRow.said?.agent, ledgerRow.said?.how, ledgerRow.said?.model, ledgerRow.ran?.agent], ['big-local', 'quick', 'big', 'big-two'])
  // The change of plan is the guess's miss: 46 of the newest 50, still keeping the gate.
  const summary = (await p.http('GET', '/jev-router/replies/summary')).body
  assert.deepEqual([summary.prediction.records.jev.quick.right, summary.prediction.records.jev.quick.n], [46, 50])
  assert.equal(summary.prediction.states.jev.quick, 'on')
})

test('a rating of the pick under a quick reply whose guess routing did not pick is stamped with the agent that ran, not the guess the reply named', async (t) => {
  const earned = await earnedGuesses()
  const p = await plugin(t, { jobs: true, config: { agents: earned.agents }, files: { ...earned.files, 'chat-replies.json': JSON.stringify({ waitMs: 0 }) } })
  await p.say('Fix the state file')
  await until('its result is posted', () => resultsOf(p).length, (n) => n === 1)
  const key = (await p.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1').key
  const row = await until('the reply\'s row holds what it named and what ran', async () => (await p.http('GET', `/jev-router/replies?key=${key}`)).body, (r) => !!(r?.said && r?.ran))
  assert.deepEqual([row.said.agent, row.said.how, row.ran.agent], ['big-local', 'quick', 'big-two'], 'the reply named the guess, and routing gave the work to the other agent')
  // A quick reply carries no agent strip, so the rating sends no agent of its own.
  const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-1', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong agent' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.record.planAgent, res.body.record.planModel], ['big-two', 'big'], 'it is about the pick that ran, as README\'s Rate the pick says, not the guess the reply named')
})

test('a task that waits its turn is told the agent likely to run it once that is earned, and when another starts it, exactly one change-of-plan notice says so', async (t) => {
  const earned = await earnedGuesses()
  const p = await plugin(t, { jobs: true, config: { agents: earned.agents }, files: earned.files })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  await p.say('Fix the state file')
  await until('the first task is at work', () => p.world.started.length, (n) => n === 1)
  const two = await p.say('Fix the state file')
  finishes.shift()?.()
  await until('the second task is at work', () => p.world.started.length, (n) => n === 2)
  const jev2 = () => noticesOf(p).filter((a) => a.msg.source.summary.startsWith('jev-2'))
  const posted = await until('its change of plan is posted', jev2, (n) => n.length > 0, { timeoutMs: 5000 }).catch(() => jev2())
  finishes.shift()?.()
  await until('both results are posted', () => resultsOf(p).length, (n) => n === 2)
  await tick(300)
  assert.equal(two.text.split('\n\n[jev-job]')[0], `OK, **jev-2** is queued: 2nd in line for ${folderOf(p.workspace)} (another task is running there). Jev picks the agent when it starts, likely **Big (local)**; I'll say which here, and report back when it's done. Keep chatting.`)
  assert.deepEqual(posted.map((a) => [a.msg.source.summary, a.msg.content[0].text]), [['jev-2: Big Two (local) instead of Big (local)', 'The local router picked Big Two (local) (big) when it started.']])
  assert.equal(jev2().length, 1, 'exactly one, and no started notice beside it')
  const key = (await p.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-2').key
  const row = (await p.http('GET', `/jev-router/replies?key=${key}`)).body
  assert.deepEqual([row.said?.agent, row.said?.how, row.ran?.agent], ['big-local', 'likely', 'big-two'], 'what the ask under the reply reads')
})

test('with Start and result only saved, a quick reply\'s guess and a waiting task\'s likely agent that routing does not pick each get the change-of-plan notice Milestones would post, and no other notice', async (t) => {
  const earned = await earnedGuesses()
  // The first reply goes out at once (Reply at once), so it names the guess whatever routing does meanwhile.
  const p = await plugin(t, { jobs: true, config: { agents: earned.agents }, files: { ...earned.files, 'chat-replies.json': JSON.stringify({ waitMs: 0, progress: 'off' }) } })
  const finishes = []
  p.world.work = () => new Promise((r) => finishes.push(r))
  const one = await p.say('Fix the state file')
  await until('the first task is at work', () => p.world.started.length, (n) => n === 1)
  const two = await p.say('Fix the state file')
  await until('the first change of plan is posted', () => noticesOf(p).length, (n) => n > 0, { timeoutMs: 5000 }).catch(() => null)
  finishes.shift()?.()
  await until('the second task is at work', () => p.world.started.length, (n) => n === 2)
  const posted = await until('the second change of plan is posted', () => noticesOf(p), (n) => n.length > 1, { timeoutMs: 5000 }).catch(() => noticesOf(p))
  finishes.shift()?.()
  await until('both results are posted', () => resultsOf(p).length, (n) => n === 2)
  await tick(300)
  const where = folderOf(p.workspace)
  assert.equal(one.text.split('\n\n')[0], `OK, I'll run **Big (local)** with **big** in the background as **jev-1** in ${where}. I'll report back here when it's done. Keep chatting.`, 'the guess, before routing picked')
  assert.equal(two.text.split('\n\n[jev-job]')[0], `OK, **jev-2** is queued: 2nd in line for ${where} (another task is running there). Jev picks the agent when it starts, likely **Big (local)**; I'll report back here when it's done. Keep chatting.`, 'the likely agent, with only the result promised')
  assert.deepEqual(posted.map((a) => [a.msg.source.summary, a.msg.content[0].text]), [
    ['jev-1: Big Two (local) instead of Big (local)', 'The local router picked Big Two (local) (big) when it started.'],
    ['jev-2: Big Two (local) instead of Big (local)', 'The local router picked Big Two (local) (big) when it started.'],
  ], 'each guess routing did not pick, worded as under Milestones')
  assert.equal(noticesOf(p).length, 2, 'and no started notice beside them')
})

test('POST /jev-router/local/benchmark/accept-output takes the figure a speed run kept aside because its output differed from its baseline, and answers 400 with why when there is none; the plugin config holds the output to half its baseline by default', async (t) => {
  assert.equal(jevRouter.Config({}).local.outputCheckShare, 0.5)
  assert.equal(jevRouter.Config({ local: { outputCheckShare: 1 } }).local.outputCheckShare, 1)
  for (const bad of [-0.1, 1.5]) assert.throws(() => jevRouter.Config({ local: { outputCheckShare: bad } }), /outputCheckShare/, `${bad} is refused`)
  // 64 words, those from `from` on spelt differently: the greedy answer of the output check.
  const answer = (from = 64) => Array.from({ length: 64 }, (_, i) => `${i < from ? 'w' : 'x'}${i}`).join(' ')
  let text = answer()
  const p = await plugin(t, { greedy: () => text })
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark/accept-output', { id: 'big' }), { status: 400, body: { error: 'Big has no new output waiting to be accepted.' } })
  const runOnce = async (n) => {
    assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: ['big'] }), { status: 200, body: { queued: ['big'] } })
    return until(`run ${n} has ended`, async () => (await p.local()).speedRun, (r) => r.state === 'idle' && r.done.length === 1)
  }
  await runOnce(1)
  text = answer(12)
  const second = await runOnce(2)
  assert.match(second.done[0].text, /Its output differs from the .+ baseline after 12 tokens \(32 needed\), so this figure is not taken as its speed until the new output is accepted\.$/)
  const kept = (await p.local()).modules.find((m) => m.id === 'big').speed
  assert.deepEqual([kept.reading.output.state, kept.held?.output.state], ['baseline', 'differs'])
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark/accept-output', { id: 'big' }), { status: 200, body: { ok: true } })
  const taken = (await p.local()).modules.find((m) => m.id === 'big').speed
  assert.deepEqual([taken.reading.at, taken.reading.output.state, taken.held, taken.stands], [kept.held.at, 'accepted', undefined, true])
})

test('the plugin config\'s local.outputCheckShare is the share Benchmark in the card holds a model\'s output to: at 1, an answer that agrees for 40 of 64 tokens is kept aside, which the 0.5 shipped would take as the same', async (t) => {
  assert.ok('outputCheckShare' in jevRouter.Config({}).local, 'the plugin config has local.outputCheckShare')
  const answer = (from = 64) => Array.from({ length: 64 }, (_, i) => `${i < from ? 'w' : 'x'}${i}`).join(' ')
  let text = answer()
  const p = await plugin(t, { greedy: () => text, config: { local: { outputCheckShare: 1 } } })
  const runOnce = async (n) => {
    assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', { ids: ['big'] }), { status: 200, body: { queued: ['big'] } })
    return until(`run ${n} has ended`, async () => (await p.local()).speedRun, (r) => r.state === 'idle' && r.done.length === 1)
  }
  await runOnce(1)
  text = answer(40)
  const second = await runOnce(2)
  assert.match(second.done[0].text, /Its output differs from the .+ baseline after 40 tokens \(64 needed\), so this figure is not taken as its speed until the new output is accepted\.$/)
  assert.equal((await p.local()).modules.find((m) => m.id === 'big').speed.held?.output.state, 'differs')
})

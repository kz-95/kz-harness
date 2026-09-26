// The capability benchmark through apply() and index.js only (docs/benchmark.md 3.7, 3.8, 3.12 and
// 5.2): its routes, each task through runRouted() with the scratch chat's root agent as parent, the
// effort and speed it fixes, what it writes and what it leaves alone, and its refusals. The plugin
// runs on a PC of its own: a minimal host whose subagent start is a stub that does what the test
// says (solve the task, write nothing, edit a protected file, write outside its folder, reject, or
// run past a short time limit), a Codex command-line tool of this file's own that says it is signed
// in and answers the usage questions, and a network on which only this PC answers.
//
// It reads the task files from benchmark-tasks/ directly and imports no module the benchmark added.
// At a commit without benchmark-tasks/ the file stops as it loads, on the missing task files; with
// them in place, as red-check's step 4 puts them, each test fails on the routes, by its own
// assertion, where the plugin lacks them.
//
// First, an engine home of this file's own, before the plugin is loaded (it reads DSH_HOME once):
// the accounts keep their .env there, and a test must neither read nor write the person's own.
import 'data:text/javascript,import{mkdtempSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";process.env.DSH_HOME=mkdtempSync(join(tmpdir(),"kz-bench-run-dsh-"))'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
// A namespace, as test/speed-routes.test.js has it: the file loads whatever the plugin exports.
import * as jevRouter from '../index.js'
import { fakeLlamaServer } from './fixtures/fake-llama-server.mjs'

const TASKS = fileURLToPath(new URL('../benchmark-tasks/', import.meta.url))
const made = [process.env.DSH_HOME]
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir }

// The network as this file allows it: this PC and nothing else, and, while `net.online` is set, an
// answer to the connectivity probe alone, so a routed run in a project may go to a cloud agent.
// Every URL asked for is kept, so a test can say that nothing reached a TypeSafe host.
const fetched = []
const net = { online: false }
const isTypesafe = (u) => { try { const h = new URL(u).host; return h === 'typesafe.ai' || h.endsWith('.typesafe.ai') } catch { return false } }
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  fetched.push(url)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (net.online && init?.method === 'HEAD' && isTypesafe(url)) return Promise.resolve(new Response(null, { status: 204 }))
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}
const typesafe = () => fetched.filter(isTypesafe)

// A Codex command-line tool of this file's own, first on the PATH: `codex login status` says it is
// signed in, and `codex app-server` answers the usage questions with a weekly window read from a
// file a test may change. Claude Code's and Codex's settings are read from folders of this file's
// own, so the model Codex runs is known and the person's own are never read.
const bin = temp('kz-bench-run-bin-')
const weeklyFile = join(bin, 'weekly.txt')
writeFileSync(weeklyFile, '10')
writeFileSync(join(bin, 'fake-codex.mjs'), `
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }
if (args[0] !== 'app-server') { console.error('fake codex: ' + args.join(' ')); process.exit(2) }
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', (text) => {
  let m
  try { m = JSON.parse(text) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ id: m.id, result: {} })
  if (m.method === 'account/rateLimits/read') {
    const weekly = Number(readFileSync(${JSON.stringify(weeklyFile)}, 'utf8'))
    return send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 }, secondary: { usedPercent: weekly, windowDurationMins: 10080 } } } })
  }
  if (m.method === 'account/read') return send({ id: m.id, result: { account: { email: 'kzh-test@example.invalid', planType: 'plus' } } })
  send({ id: m.id, error: { message: 'unknown method' } })
})
lines.on('close', () => process.exit(0))
`)
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-codex.mjs')}" "$@"\n`)
chmodSync(join(bin, 'codex'), 0o755)
writeFileSync(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(bin, 'fake-codex.mjs')}" %*\r\n`)
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
process.env.CODEX_HOME = temp('kz-bench-run-codex-')
writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-test-codex"\n')
process.env.CLAUDE_CONFIG_DIR = temp('kz-bench-run-claude-')

// ---------- the task set, read from the files ----------

/** The task set's digest as docs/benchmark.md 3.5 defines it, worked out here from the files. */
function digestOf(dir) {
  const files = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), r)
      else files.push(r)
    }
  }
  walk(dir, '')
  const h = createHash('sha256')
  for (const path of files.sort()) {
    if (path === 'task-set.json') continue
    h.update(path).update('\0').update(readFileSync(join(dir, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n')).update('\0')
  }
  return h.digest('hex')
}

/** A task set of these tasks of the real one, with its own digest, in a folder of its own. */
function taskSetOf(ids) {
  const dir = temp('kz-bench-run-tasks-')
  for (const id of ids) cpSync(join(TASKS, id), join(dir, id), { recursive: true })
  writeFileSync(join(dir, 'task-set.json'), JSON.stringify({ id: 'kzh-capability', version: '1', digest: digestOf(dir), tasks: ids }))
  return dir
}

const TASK = Object.fromEntries(['preflight', 'debugging-1', 'investigation-1', 'simple_change-1'].map((id) => [id, JSON.parse(readFileSync(join(TASKS, id, 'task.json'), 'utf8'))]))
const nodeVersion = () => execFileSync('node', ['--version'], { encoding: 'utf8' })

/** Writes a task's reference solution into `folder`: for the preflight, what node --version prints. */
function solve(taskId, folder) {
  if (taskId === 'preflight') return writeFileSync(join(folder, 'hello.txt'), nodeVersion())
  const solutions = join(TASKS, taskId, 'solutions')
  cpSync(join(solutions, readdirSync(solutions).sort()[0]), folder, { recursive: true })
}

/**
 * What an agent that wants git to run its code would write in its folder: a clean filter on every
 * file, named in the .git of the folder, a repository of its own when the folder holds none. The
 * filter keeps the key it finds in its environment in LEAK and adds it to what git stores.
 */
const LEAK = join(temp('kz-bench-run-leak-'), 'leak.txt')
const PROBE_KEY = 'sk-kzh-probe-secret'
function plantFilter(folder) {
  const probe = `${LEAK}.mjs`
  writeFileSync(probe, `import { appendFileSync } from 'node:fs'\nlet s = ''\nprocess.stdin.on('data', (d) => { s += d })\nprocess.stdin.on('end', () => { const k = process.env.KZH_PROBE_API_KEY ?? 'none'; appendFileSync(${JSON.stringify(LEAK)}, k + '\\n'); process.stdout.write(s + '// ' + k + '\\n') })\n`)
  const dotGit = join(folder, '.git')
  if (!existsSync(join(dotGit, 'HEAD'))) execFileSync('git', ['init', '-q'], { cwd: folder })
  appendFileSync(join(dotGit, 'config'), `[filter "probe"]\n\tclean = "${process.execPath.replace(/\\/g, '/')}" "${probe.replace(/\\/g, '/')}"\n`)
  mkdirSync(join(dotGit, 'info'), { recursive: true })
  appendFileSync(join(dotGit, 'info', 'attributes'), '* filter=probe\n')
}

/** Where agent-written code records, for each process that runs it, which npm script ran it and the key it found. */
const SEEN = join(temp('kz-bench-run-seen-'), 'seen.jsonl')
const probeEnv = (folder) => appendFileSync(join(folder, 'src', 'cart.js'), `\nimport { appendFileSync as seen } from 'node:fs'\nseen(${JSON.stringify(SEEN)}, JSON.stringify({ script: process.env.npm_lifecycle_event ?? null, key: process.env.KZH_PROBE_API_KEY ?? null }) + '\\n')\n`)

// ---------- the plugin on a PC of its own ----------

const SCRATCH = 'session-scratch'
const PROJECT = 'session-project'
const GIB = 1024 ** 3
const sha = (s) => createHash('sha256').update(s).digest('hex')
// The local model, as test/speed-routes.test.js has it, with a window of 16,384 tokens.
const MODULES = [
  { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') },
  { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * GIB, sha256: sha('big'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 16384, maxContext: 40960 },
]
const PC = {
  gpus: [{ name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramGB: 4 }],
  cuda: 12.7, ramGB: 23.7, cpu: { name: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 52 * GIB,
}
const SPLIT = ['load_tensors: offloaded 29/37 layers to GPU', 'CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 1024.00 MiB']
// The agents: Codex through its command-line tool, and three on a pinned API model, two of which run
// the same model.
const AGENTS = [
  { id: 'codex', name: 'Codex', provider: 'codex', description: 'Codex.', enabled: true },
  { id: 'deep', name: 'Deep', provider: 'spawn', description: 'DeepSeek chat.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-chat' } },
  { id: 'lite', name: 'Lite', provider: 'spawn', description: 'DeepSeek lite.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-lite' } },
  { id: 'twin', name: 'Twin', provider: 'spawn', description: 'DeepSeek chat again.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-chat' } },
]
const LOCAL_AGENT = { id: 'big-local', name: 'Big (local)', provider: 'spawn', description: 'Big on this PC through llama.cpp.', enabled: true, llm: { provider: 'local', model: 'big' } }

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
const rows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
/** Poll an asynchronous read until `ok` holds, with a deadline; throws with the last value read. */
async function until(label, read, ok, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await read() } catch (err) { value = `not readable yet: ${err.message}` }
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: still not true after ${timeoutMs} ms, last: ${JSON.stringify(value)?.slice(0, 1200)}`)
    await tick(50)
  }
}
const abortOf = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })

/**
 * The plugin on a PC of its own, closed when the test ends, with the benchmark's scratch workspace
 * in a folder of this test's own over the tasks `tasks` of the real set. Two chats are loaded: one
 * in the scratch workspace and one in a project. `behave(agent, task, n)` says what the stub does on
 * the `n`th start of that agent on that task (task null for a run in the project): 'solve',
 * 'nothing', 'protected', 'outside', 'reject', 'dispose', 'late-aborted', 'late-reject', 'handoff',
 * which solves and keeps the handoff note the prompt asks for, 'plant-filter', which solves and names
 * a git filter in its folder (plantFilter), 'reload', which solves while the engine loads its model
 * again, 'probe-env', which solves and adds code that records
 * its environment (probeEnv), 'comment', which adds a comment to src/cart.js and fixes
 * nothing, 'solve-then-stop', which solves and
 * presses the inspector's Stop before its attempt returns, or 'hold', which waits for
 * `world.release()` or the run's stop and then solves. Settings name effort low and
 * Codex speed fast. With `local`, the agent big-local runs Big on this PC; with `scratchInGit`, the
 * scratch folder is inside the project's repository; with `jevKey` false, no TypeSafe key is set.
 */
async function plugin(t, { tasks = ['preflight', 'debugging-1', 'investigation-1'], behave = () => 'solve', local = false, scratchInGit = false, jevKey = true, config = {} } = {}) {
  // A task's checks run its own `node --test`, which would inherit this runner's NODE_TEST_CONTEXT
  // and, under it, report to a parent that is not there and exit 0 whatever its tests do. Without
  // it they fail when the task's tests fail, as they do on the person's PC. It goes here, inside a
  // test, since the runner reads it once as it starts and this file's own report depends on it.
  delete process.env.NODE_TEST_CONTEXT
  const root = temp('kz-bench-run-')
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  // Settings name another effort and Codex's fast speed, which the benchmark does not use.
  writeFileSync(join(dataDir, 'effort.json'), JSON.stringify({ default: 'low', perAgent: { codex: 'low', deepseek: 'low' }, codexSpeed: 'fast' }))
  // A git repository for the project chat's workspace, as every run needs one.
  const workspace = join(root, 'work')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: workspace })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const scratchRoot = scratchInGit ? join(workspace, 'kzh-scratch') : join(root, 'kzh-scratch')
  mkdirSync(scratchRoot, { recursive: true })
  const engineDir = join(root, 'engine')
  const modelsDir = join(root, 'models')
  mkdirSync(join(engineDir, '.installed'), { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  if (local) {
    writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
    writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
    writeFileSync(join(modelsDir, 'big.gguf'), 'big')
  }
  const server = fakeLlamaServer({ report: () => SPLIT })

  const world = { started: [], counts: {}, gates: [], behave }
  world.release = () => { for (const open of world.gates.splice(0)) open() }
  // Another request has the engine load the model again while an agent works, as a swap or the RAM
  // watchdog would: the model is stopped and loaded.
  world.reloadModel = async () => {
    assert.equal((await http('POST', '/jev-router/local/stop', {})).status, 200)
    assert.equal((await http('POST', '/jev-router/local/start', { model: 'big' })).status, 200)
  }
  // The inspector's Stop on the run under way in the scratch chat, which is its newest entry.
  world.stopFromInspector = async () => {
    const entries = (await http('GET', `/jev-router/log?session=${SCRATCH}`)).body
    assert.deepEqual(await http('POST', '/jev-router/runs/stop', { runId: entries.at(-1).id }), { status: 200, body: { ok: true } })
  }
  const scratchAgent = { id: SCRATCH, session: { id: SCRATCH, header: { cwd: scratchRoot }, append: () => {} }, whenIdle: async () => {} }
  const projectAgent = { id: PROJECT, session: { id: PROJECT, header: { cwd: workspace }, append: () => {} }, whenIdle: async () => {} }
  const sessions = { [SCRATCH]: scratchAgent, [PROJECT]: projectAgent }
  const subagents = {
    async start(provider, opts) {
      const text = opts.prompt?.[0]?.text ?? ''
      const agent = String(opts.label ?? '').replace(/^jev:/, '')
      const folder = text.match(/Workspace: (.+)\. Work only inside this workspace\./)?.[1] ?? null
      const task = Object.values(TASK).find((x) => text.includes(x.prompt))?.id ?? null
      const key = `${agent}:${task}`
      world.counts[key] = (world.counts[key] ?? 0) + 1
      const what = world.behave(agent, task, world.counts[key])
      const signal = opts.signal
      world.started.push({ provider, agent, task, folder, text, parent: opts.parent, what, codexEffort: process.env.KZ_CODEX_EFFORT ?? null, codexTier: process.env.KZ_CODEX_SERVICE_TIER ?? null, reasoningEffort: opts.agentOptions?.reasoningEffort ?? null })
      const result = (async () => {
        if (what === 'hold') {
          await Promise.race([new Promise((open) => world.gates.push(open)), abortOf(signal)])
          signal.throwIfAborted()
        }
        if (what === 'late-aborted') { await abortOf(signal); return { stopReason: 'aborted', output: [], usage: {} } }
        if (what === 'late-reject') { await abortOf(signal); throw signal.reason }
        if (what === 'reject') throw new Error('socket hang up')
        if (task === null) writeFileSync(join(folder, 'state.txt'), 'fixed')
        else if (what !== 'nothing' && what !== 'comment') solve(task, folder)
        // The person presses the inspector's Stop as the attempt completes, so the run is stopped
        // after its agent's work, while the router has its checks still to run.
        if (what === 'solve-then-stop') await world.stopFromInspector()
        if (what === 'reload') await world.reloadModel()
        if (what === 'protected') appendFileSync(join(folder, 'test', 'cart.test.js'), '\n// changed\n')
        if (what === 'plant-filter') plantFilter(folder)
        if (what === 'probe-env') probeEnv(folder)
        // Looks at the code and fixes nothing: the task's own checks still fail.
        if (what === 'comment') appendFileSync(join(folder, 'src', 'cart.js'), '\n// looked at it\n')
        if (what === 'outside') writeFileSync(join(scratchRoot, 'stray.txt'), 'x')
        // The note the router asks for, at the path its prompt names, taken from the agent's own
        // working directory: its parent's folder, the scratch root (docs/benchmark.md 3.7).
        if (what === 'handoff') {
          const note = resolve(opts.parent.session.header.cwd, text.match(/Keep (.+?)(?: \(in the workspace\))? updated as you work/)[1])
          mkdirSync(dirname(note), { recursive: true })
          writeFileSync(note, '## Done\nSolved the task.\n')
        }
        return { stopReason: 'completed', output: [{ type: 'text', text: 'Done.' }], usage: { inputTokens: 1200, outputTokens: 300 } }
      })()
      return { result, dispose: async () => { if (what === 'dispose') throw new Error('the process did not exit') } }
    },
  }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const routes = []
  const runtime = {
    effect,
    llm: { registerAdapter: () => () => {}, stream: () => (async function* () {})(), resolveModel: async () => null, listProviders: () => [], listModels: async () => [] },
    emit: () => {}, get: () => null,
    agents: { get: (id) => sessions[id], currentInitiator: () => scratchAgent },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => 0 },
    workspaceRegistry: { list: () => [{ path: scratchRoot, title: 'KzH scratch' }, { path: workspace, title: 'work' }] },
  }
  const ctx = {
    // A TypeSafe key is set, unless `jevKey` is false, so a run that asked Jev anything would reach a
    // TypeSafe host.
    credentials: { resolve: async (ref) => (jevKey && ref === 'TYPESAFE_API_KEY' ? { value: 'kzh-test-typesafe-key' } : undefined) },
    effect, subagents,
    get: () => null,
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    tools: { register: () => {} },
    inject: (_deps, fn) => fn(runtime),
  }
  jevRouter.apply(ctx, jevRouter.Config({
    agents: [...AGENTS, ...(local ? [LOCAL_AGENT] : [])],
    fallbackAgent: 'codex',
    historyFile: join(dataDir, 'history.jsonl'),
    checks: { enabled: false, scripts: [], timeoutMs: 60_000, outputChars: 500 },
    format: { enabled: false },
    ...config,
    laya: { port: await freePort(), connectivityUrl: 'http://connectivity.kzh-test.invalid/connecttest.txt' },
  }), {
    localModels: { modules: MODULES, engineDir, modelsDir, specs: async () => PC, port: 0, spawn: server.spawn, fetch: server.fetch },
    benchmark: { scratchRoot, tasksDir: taskSetOf(tasks) },
  })
  /** KzH closing: every disposer the plugin registered runs, the last registered first, once. */
  const close = async () => { while (effects.length) { const d = effects.pop(); try { await d() } catch { /* already gone */ } } }
  t.after(async () => {
    world.release()
    await close()
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
  const slash = (name, rawInput, agent) => commands.get(name).handler({ agent, rawInput, signal: new AbortController().signal })
  const state = async (session = SCRATCH) => (await http('GET', `/jev-router/benchmark?session=${session}`)).body
  /** Plans and starts a run on `agents` from the scratch chat; resolves to its run id. */
  async function begin(agents) {
    const plan = await http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents })
    assert.equal(plan.status, 200, JSON.stringify(plan.body))
    const started = await http('POST', '/jev-router/benchmark/start', { session: SCRATCH, agents, planId: plan.body.planId })
    assert.equal(started.status, 200, JSON.stringify(started.body))
    return started.body.runId
  }
  /** Waits for the run `runId` to end; resolves to the card's state then. */
  const ended = (runId) => until('the benchmark has ended', () => state(), (s) => s?.run === null && s?.last?.runId === runId, { timeoutMs: 120_000 })
  const file = (name) => join(dataDir, name)

  // The card answers, and Codex's model is known before anything is planned, so a plan does not
  // change under a test when the settings are first read.
  const first = await http('GET', `/jev-router/benchmark?session=${SCRATCH}`)
  assert.equal(first.status, 200, `GET /jev-router/benchmark answers: ${JSON.stringify(first.body)}`)
  await until('Codex\'s model is read', () => state(), (s) => s?.agents?.find((a) => a.id === 'codex')?.model === 'gpt-test-codex')
  if (local) await until('Big is installed', async () => (await http('GET', '/jev-router/local')).body, (s) => s.modules?.find((m) => m.id === 'big')?.state === 'installed')
  return { http, slash, state, begin, ended, file, world, server, dataDir, scratchRoot, workspace, scratchAgent, projectAgent, close }
}

// ---------- the tests ----------

test('each task runs through runRouted(): the stub is started with the scratch chat\'s root agent as parent, in a folder of its own named in its prompt, at high effort and Codex\'s normal tier whatever Settings say, with nothing sent to TypeSafe, history.jsonl untouched, usage marked, and evidence for every agent that finished', async (t) => {
  const p = await plugin(t, {
    // codex solves every task; deep edits a protected file and writes outside its folder; lite writes nothing.
    behave: (agent, task) => (agent === 'lite' ? 'nothing' : agent === 'deep' && task === 'debugging-1' ? 'protected' : agent === 'deep' && task === 'investigation-1' ? 'outside' : 'solve'),
  })
  const before = await p.state()
  assert.equal(before.where.state, 'scratch')
  assert.equal(before.where.text, `This chat is in the KzH scratch workspace (${p.scratchRoot}), which holds nothing of yours: the benchmark runs here.`)
  fetched.length = 0
  const runId = await p.begin(['codex', 'deep', 'lite'])
  const s = await p.ended(runId)
  assert.equal(s.last.status, 'finished')

  // Every start: the scratch chat's root agent as parent, the task's own text, the Workspace: line
  // of its own folder, which is a new folder of the scratch root for every task.
  assert.deepEqual(p.world.started.map((x) => `${x.agent}:${x.task}`), ['codex:preflight', 'codex:debugging-1', 'codex:investigation-1', 'deep:preflight', 'deep:debugging-1', 'deep:investigation-1', 'lite:preflight'])
  const folders = new Set()
  for (const x of p.world.started) {
    assert.equal(x.parent, p.scratchAgent, 'started with the scratch chat\'s root agent as parent')
    assert.ok(x.text.includes(TASK[x.task].prompt), 'the prompt holds the task\'s text')
    assert.match(x.folder, /[\\/][0-9a-f]{12}$/)
    assert.equal(join(x.folder, '..'), p.scratchRoot, 'its folder is in the scratch root')
    folders.add(x.folder)
  }
  assert.equal(folders.size, 7, 'a folder of its own for every task')
  assert.deepEqual(readdirSync(p.scratchRoot), [], 'every folder is deleted once graded, and what deep wrote outside its own is deleted too')

  // The effort the benchmark fixes, although Settings name low and Codex's fast speed.
  for (const x of p.world.started.filter((y) => y.agent === 'codex')) assert.deepEqual([x.codexEffort, x.codexTier], ['high', null])
  for (const x of p.world.started.filter((y) => y.agent !== 'codex')) assert.equal(x.reasoningEffort, 'high')
  const log = rows(p.file('benchmark.jsonl'))
  const taskRows = log.filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => r.effort), ['high', 'high', 'high', 'high', 'high', 'high', 'high'])

  // What each came to, graded as the task set says.
  assert.deepEqual(taskRows.map((r) => [r.agent, r.task, r.outcome]), [
    ['codex', 'preflight', 'passed'], ['codex', 'debugging-1', 'passed'], ['codex', 'investigation-1', 'passed'],
    ['deep', 'preflight', 'passed'], ['deep', 'debugging-1', 'failed'], ['deep', 'investigation-1', 'failed'],
    ['lite', 'preflight', 'failed'],
  ])
  assert.match(taskRows[4].reason, /changed test\/cart\.test\.js, which the task protects/)
  assert.match(taskRows[5].reason, /wrote outside its folder: stray\.txt/)
  assert.ok(taskRows.every((r) => r.checks.length === 1 && r.checks[0].name === 'test'), 'the task\'s own test script ran as the run\'s checks')
  const agentRows = log.filter((r) => r.type === 'agent')
  // `recorded` counts the evidence rows: debugging-1 credits three dimensions and investigation-1 one.
  assert.deepEqual(agentRows.map((r) => [r.agent, r.status, r.recorded]), [['codex', 'finished', 4], ['deep', 'finished', 4], ['lite', 'preflight_failed', 0]])
  assert.ok(agentRows[2].line.startsWith('lite could not do the first, one-file task ('), agentRows[2].line)
  assert.ok(agentRows[2].line.endsWith('): it has to run node in its folder. Nothing else was run on it.'), agentRows[2].line)

  // No decider asked and nothing sent to TypeSafe, although a TypeSafe key is set.
  assert.deepEqual(typesafe(), [], 'nothing reached a TypeSafe host')
  assert.equal(existsSync(p.file('history.jsonl')), false, 'history.jsonl is untouched')
  const usage = rows(p.file('usage.jsonl'))
  assert.equal(usage.length, 7, 'one usage row per attempt, and no decider\'s row')
  for (const u of usage) {
    assert.deepEqual([u.purpose, u.benchmarkRunId, u.role], ['benchmark', runId, 'primary'])
    assert.ok(folders.has(u.workspace), 'kept under the task\'s own folder')
  }
  // The evidence of the two agents that finished, under this run, and nothing of lite's.
  const evidence = rows(p.file('capability-evidence.jsonl'))
  assert.ok(evidence.length > 0)
  assert.ok(evidence.every((e) => e.source === 'benchmark' && e.runId === runId && e.benchmark.id === 'kzh-capability' && e.benchmark.version === '1' && e.confidence === 0.9))
  assert.deepEqual([...new Set(evidence.map((e) => e.subject.model))].sort(), ['deepseek-chat', 'gpt-test-codex'])
  assert.deepEqual(evidence.filter((e) => e.subject.model === 'deepseek-chat').map((e) => [e.note, e.dimension, e.score]), [
    ['debugging-1', 'debugging', 0], ['debugging-1', 'coding', 0], ['debugging-1', 'general_reasoning', 0], ['investigation-1', 'general_reasoning', 0],
  ])
  // Each task's run is logged under the scratch chat, where the inspector shows it.
  const inspector = (await p.http('GET', `/jev-router/log?session=${SCRATCH}`)).body
  assert.equal(inspector.length, 7)
  // The card's results: the tasks of every agent's last run, and the dimensions of those that finished.
  assert.equal(s.results.tasks.length, 7)
  assert.deepEqual([...new Set(s.results.dimensions.map((r) => r[0].text))].sort(), ['codex', 'deep'])
})

test('a stub that runs past the time limit is timed out, whether its provider resolves aborted or rejects with the timeout\'s DOMException; one that rejects otherwise, or whose dispose() throws, is errored and runs once more', async (t) => {
  const p = await plugin(t, {
    tasks: ['preflight', 'debugging-1'],
    config: { agentTimeoutMs: 2000 },
    behave: (agent, task, n) => {
      if (task === 'debugging-1' && agent === 'codex') return 'late-aborted'
      if (task === 'debugging-1' && agent === 'deep') return 'late-reject'
      if (agent === 'lite' && task === 'preflight') return n === 1 ? 'reject' : 'solve'
      if (agent === 'lite' && task === 'debugging-1') return 'dispose'
      return 'solve'
    },
  })
  const runId = await p.begin(['codex', 'deep', 'lite'])
  await p.ended(runId)
  const log = rows(p.file('benchmark.jsonl'))
  const taskRows = log.filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => [r.agent, r.task, r.rerun, r.outcome]), [
    ['codex', 'preflight', false, 'passed'], ['codex', 'debugging-1', false, 'timed_out'],
    ['deep', 'preflight', false, 'passed'], ['deep', 'debugging-1', false, 'timed_out'],
    ['lite', 'preflight', false, 'errored'], ['lite', 'preflight', true, 'passed'],
    ['lite', 'debugging-1', false, 'errored'], ['lite', 'debugging-1', true, 'errored'],
  ])
  assert.equal(taskRows[1].reason, 'it ran past its time limit of 2 s')
  assert.equal(taskRows[3].reason, 'it ran past its time limit of 2 s')
  assert.match(taskRows[4].reason, /socket hang up/)
  assert.equal(taskRows[6].reason, 'its process did not close (the process did not exit)')
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.recorded]), [['codex', 'finished', 3], ['deep', 'finished', 3], ['lite', 'errored', 0]], 'the evidence rows of debugging-1, which credits three dimensions')
  assert.equal(log.find((r) => r.type === 'agent' && r.agent === 'lite').line, 'lite stopped at debugging-1: it ended in an error twice (its process did not close (the process did not exit)). Nothing is recorded for it.')
  // A timed-out task is scored as failed; lite, which stopped, records nothing.
  const evidence = rows(p.file('capability-evidence.jsonl'))
  assert.deepEqual([...new Set(evidence.map((e) => e.subject.model))].sort(), ['deepseek-chat', 'gpt-test-codex'])
  assert.ok(evidence.every((e) => e.note === 'debugging-1' && e.score === 0))
})

test('the benchmark starts only from a chat in the scratch workspace, and a normal routed task there is refused', async (t) => {
  const p = await plugin(t)
  const elsewhere = await p.state(PROJECT)
  assert.equal(elsewhere.where.state, 'elsewhere')
  assert.equal(elsewhere.where.text, `Capability runs happen in the KzH scratch workspace (${p.scratchRoot}), so no agent is started in one of your projects. Open it from the project list as KzH scratch, start a chat there, and run the benchmark from that chat's Jev tab.`)
  const notLoaded = await p.state('session-gone')
  assert.deepEqual([notLoaded.where.state, notLoaded.where.text], ['not_loaded', 'This chat is not loaded in the engine; send any message in it, then try again.'])
  const only = `The capability benchmark runs only from a chat in the KzH scratch workspace (${p.scratchRoot}).`
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/plan', { session: PROJECT, agents: ['codex'] }), { status: 400, body: { error: only } })
  const plan = await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['codex'] })
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/start', { session: PROJECT, agents: ['codex'], planId: plan.body.planId }), { status: 400, body: { error: only } })
  // A task routed in the scratch workspace, forced or not, is refused before anything runs.
  const refused = 'jev-router: The KzH scratch workspace is for the capability benchmark only; open one of your projects to run tasks.'
  assert.deepEqual(await p.slash('codex', 'Fix the state file', p.scratchAgent), { kind: 'error', text: refused })
  assert.deepEqual(await p.slash('auto', 'Fix the state file', p.scratchAgent), { kind: 'error', text: refused })
  assert.deepEqual(p.world.started, [], 'no agent was started')
  assert.equal(rows(p.file('benchmark.jsonl')).length, 0, 'nothing ran')
})

test('a scratch folder inside a git repository is refused, with the repository named', async (t) => {
  const p = await plugin(t, { scratchInGit: true })
  const text = `The KzH scratch folder ${p.scratchRoot} is inside the git repository ${p.workspace}, where an agent would take that repository for its project.`
  const s = await p.state()
  assert.deepEqual([s.where.state, s.where.text], ['in_git', text])
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['codex'] }), { status: 400, body: { error: text } })
})

test('git runs on a task folder with no key of KzH\'s and never runs a filter the agent names there, for the router\'s changes as for the grade\'s: the folder\'s repository is kept outside the scratch root', async (t) => {
  process.env.KZH_PROBE_API_KEY = PROBE_KEY
  t.after(() => { delete process.env.KZH_PROBE_API_KEY })
  const p = await plugin(t, { tasks: ['preflight', 'debugging-1'], behave: (agent, task) => (task === 'debugging-1' ? 'plant-filter' : 'solve') })
  const runId = await p.begin(['codex'])
  await p.ended(runId)
  assert.equal(existsSync(LEAK), false, 'the filter the agent named never ran')
  assert.ok(!readFileSync(p.file('benchmark.jsonl'), 'utf8').includes(PROBE_KEY), 'no key of KzH\'s in the log')
  const taskRows = rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => [r.task, r.outcome, r.changed]), [['preflight', 'passed', ['hello.txt']], ['debugging-1', 'passed', ['src/cart.js']]], taskRows.map((r) => r.reason).join('; '))
  // The router saw the change through the folder's own repository too.
  const inspector = (await p.http('GET', `/jev-router/log?session=${SCRATCH}`)).body
  const attempt = inspector.at(-1).events.find((e) => e.type === 'attempt_end')?.attempt
  assert.deepEqual(attempt?.changedFiles, ['src/cart.js'], JSON.stringify(attempt))
  // Nothing of the task repositories is left once each task is graded.
  assert.deepEqual(readdirSync(p.scratchRoot), [])
  assert.deepEqual(readdirSync(join(p.dataDir, 'benchmark-git')), [])
})

test('a start whose plan changed, a second start and two picks of one model are refused; the inspector\'s Stop stops the task under way, and that agent records nothing', async (t) => {
  const p = await plugin(t, { behave: (agent, task) => (agent === 'codex' && task === 'preflight' ? 'hold' : 'solve') })
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['deep', 'twin'] }), { status: 400, body: { error: 'deep and twin both run deepseek deepseek-chat, and one run records one set of results per model; pick one of them.' } })
  // Codex's weekly window passes its gate between the confirmation and the start.
  const plan = await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['codex'] })
  assert.equal(plan.status, 200)
  writeFileSync(weeklyFile, '85')
  t.after(() => writeFileSync(weeklyFile, '10'))
  assert.equal((await p.http('GET', '/jev-router/usage?force=1')).status, 200)
  const changed = await p.http('POST', '/jev-router/benchmark/start', { session: SCRATCH, agents: ['codex'], planId: plan.body.planId })
  assert.equal(changed.status, 409)
  assert.match(changed.body.error, /^What the benchmark would run or spend changed since you confirmed it \(.*codex is now past its weekly gate.*\); review it again\.$/)
  // Back under it, a fresh plan starts; a second start while it runs is refused.
  writeFileSync(weeklyFile, '10')
  assert.equal((await p.http('GET', '/jev-router/usage?force=1')).status, 200)
  const runId = await p.begin(['codex'])
  await until('codex is at work', () => p.world.started.length, (n) => n === 1)
  const again = await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['deep'] })
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/start', { session: SCRATCH, agents: ['deep'], planId: again.body.planId }), { status: 409, body: { error: 'A capability benchmark is already running.' } })
  // The inspector's Stop, on the task's own run under the scratch chat.
  const [entry] = (await p.http('GET', `/jev-router/log?session=${SCRATCH}`)).body
  assert.deepEqual(await p.http('POST', '/jev-router/runs/stop', { runId: entry.id }), { status: 200, body: { ok: true } })
  const s = await p.ended(runId)
  assert.deepEqual(s.last.lines, ['codex stopped at preflight: it was stopped from the inspector. Nothing is recorded for it.'])
  assert.deepEqual(rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task').map((r) => [r.task, r.outcome]), [['preflight', 'not_scored']])
  assert.deepEqual(rows(p.file('capability-evidence.jsonl')), [])
  assert.deepEqual(readdirSync(p.scratchRoot), [])
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/stop', {}), { status: 200, body: { ok: true } }, 'also when nothing runs')
})

test('a Stop is a stop however the run comes back: the inspector\'s on a provider that settles it as aborted, the inspector\'s as the attempt completes, and the benchmark\'s own on a provider that settles it as aborted each leave the task not scored, started once, with nothing recorded for that agent', async (t) => {
  // A short time limit, so a stopped task that were run again would end within the test.
  const p = await plugin(t, {
    tasks: ['preflight', 'debugging-1'],
    config: { agentTimeoutMs: 6000 },
    behave: (agent, task) => (task !== 'preflight' ? 'solve' : agent === 'deep' ? 'solve-then-stop' : 'late-aborted'),
  })
  const runId = await p.begin(['codex', 'deep', 'lite'])
  // codex: the inspector's Stop, which its provider settles as aborted rather than by rejecting.
  await until('codex is at work', () => p.world.started.length, (n) => n === 1)
  await p.world.stopFromInspector()
  // deep presses it itself as its attempt completes; lite gets the benchmark's own Stop.
  await until('lite is at work', () => p.world.started.some((x) => x.agent === 'lite'), (on) => on)
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/stop', {}), { status: 200, body: { ok: true } })
  const s = await p.ended(runId)
  assert.deepEqual(p.world.started.map((x) => `${x.agent}:${x.task}`), ['codex:preflight', 'deep:preflight', 'lite:preflight'], 'a stopped task is never run again')
  const log = rows(p.file('benchmark.jsonl'))
  assert.deepEqual(log.filter((r) => r.type === 'task').map((r) => [r.agent, r.task, r.outcome, r.reason]), [
    ['codex', 'preflight', 'not_scored', 'it was stopped from the inspector'],
    ['deep', 'preflight', 'not_scored', 'it was stopped from the inspector'],
    ['lite', 'preflight', 'not_scored', 'the benchmark was stopped'],
  ])
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.recorded]), [['codex', 'not_scored', 0], ['deep', 'not_scored', 0], ['lite', 'stopped', 0]])
  assert.deepEqual(s.last.lines, [
    'codex stopped at preflight: it was stopped from the inspector. Nothing is recorded for it.',
    'deep stopped at preflight: it was stopped from the inspector. Nothing is recorded for it.',
    'lite was stopped at preflight. Nothing is recorded for it.',
  ])
  assert.deepEqual(rows(p.file('capability-evidence.jsonl')), [])
})

test('a start with a local pick is refused while a speed run goes, and a speed run is refused while a local agent\'s task is pending', async (t) => {
  // The project's task goes to Codex, which needs the network to be up, and asks no decider.
  const p = await plugin(t, { local: true, jevKey: false, behave: (agent, task) => (task === null ? 'hold' : 'solve') })
  net.online = true
  t.after(() => { net.online = false })
  // A speed run holds the engine: the benchmark refuses a start with the local agent.
  const fill = p.server.hold((e) => e.body?.n_predict === 1)
  assert.equal((await p.http('POST', '/jev-router/local/benchmark', {})).status, 200)
  await fill.arrived
  const plan = await p.http('POST', '/jev-router/benchmark/plan', { session: SCRATCH, agents: ['big-local'] })
  assert.equal(plan.status, 200, JSON.stringify(plan.body))
  assert.deepEqual(await p.http('POST', '/jev-router/benchmark/start', { session: SCRATCH, agents: ['big-local'], planId: plan.body.planId }), { status: 409, body: { error: 'A speed benchmark is running; start this when it has finished, or leave the local agents out.' } })
  assert.equal((await p.http('POST', '/jev-router/local/benchmark/cancel', {})).status, 200)
  fill.release()
  await until('the speed run has ended', async () => (await p.http('GET', '/jev-router/local')).body.speedRun, (r) => r.state === 'idle')

  // One task at a time on this PC, and a task in the project holds that one slot: the local agent's
  // first task waits for it, and meanwhile a speed run is refused.
  assert.equal((await p.http('POST', '/jev-router/local/settings', { maxConcurrentTasks: 1 })).status, 200)
  const project = p.slash('codex', 'Fix the state file', p.projectAgent)
  await until('the project task is at work', () => p.world.started.length, (n) => n === 1)
  // The project's run reads Settings: its effort and Codex's speed are the ones they name.
  assert.deepEqual([p.world.started[0].codexEffort, p.world.started[0].codexTier], ['low', 'priority'])
  const runId = await p.begin(['big-local'])
  await until('the local agent waits for a free slot', () => p.state(), (s) => s.run?.agents?.[0]?.task?.waiting === 'Waiting for a free slot: the resource budget caps how many tasks run at once')
  assert.deepEqual(await p.http('POST', '/jev-router/local/benchmark', {}), { status: 400, body: { error: "A capability benchmark is running a local model's tasks; start the speed benchmark when they have finished." } })
  p.world.release()
  assert.equal((await project).kind, 'success')
  await p.ended(runId)
  const log = rows(p.file('benchmark.jsonl'))
  assert.deepEqual(log.filter((r) => r.type === 'task').map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['debugging-1', 'passed'], ['investigation-1', 'passed']])
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status]), [['big-local', 'finished']])
  const evidence = rows(p.file('capability-evidence.jsonl')).filter((e) => e.source === 'benchmark')
  assert.ok(evidence.length > 0 && evidence.every((e) => e.subject.model === 'big' && e.runId === runId))
  // With the local agent's tasks done, a speed run may go again.
  assert.equal((await p.http('POST', '/jev-router/local/benchmark', {})).status, 200)
  assert.equal((await p.http('POST', '/jev-router/local/benchmark/cancel', {})).status, 200)
})

test('the task\'s own checks run the agent\'s code with no key of KzH\'s in its environment', async (t) => {
  process.env.KZH_PROBE_API_KEY = PROBE_KEY
  t.after(() => { delete process.env.KZH_PROBE_API_KEY })
  const p = await plugin(t, { tasks: ['preflight', 'debugging-1'], behave: (agent, task) => (task === 'debugging-1' ? 'probe-env' : 'solve') })
  const runId = await p.begin(['codex'])
  await p.ended(runId)
  const seen = readFileSync(SEEN, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(seen.some((x) => x.script === 'test'), `the checks ran the agent's code: ${JSON.stringify(seen)}`)
  assert.deepEqual(seen.filter((x) => x.key !== null), [], 'with no key of KzH\'s, in the checks as in the grade')
  assert.deepEqual(rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task').map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['debugging-1', 'passed']])
})

test('a forced agent whose task\'s own checks still fail is started once for it: no retry, no review and no other agent, and the failing check is recorded', async (t) => {
  const p = await plugin(t, { tasks: ['preflight', 'debugging-1'], behave: (agent, task) => (task === 'debugging-1' ? 'comment' : 'solve') })
  const runId = await p.begin(['deep'])
  await p.ended(runId)
  assert.deepEqual(p.world.started.map((x) => `${x.agent}:${x.task}`), ['deep:preflight', 'deep:debugging-1'])
  assert.deepEqual(rows(p.file('usage.jsonl')).map((u) => [u.agent, u.role]), [['deep', 'primary'], ['deep', 'primary']], 'one work attempt per task, and no review')
  const taskRows = rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => [r.task, r.outcome, r.checks]), [['preflight', 'passed', [{ name: 'test', passed: true }]], ['debugging-1', 'failed', [{ name: 'test', passed: false }]]], 'the checks ran the task\'s own tests')
})

test('a local agent whose provider rejects on its time limit is timed out and scored against its weights, as its other tasks are, and its results are recorded', async (t) => {
  const p = await plugin(t, { local: true, tasks: ['preflight', 'debugging-1'], config: { agentTimeoutMs: 2000 }, behave: (agent, task) => (task === 'debugging-1' ? 'late-reject' : 'solve') })
  const runId = await p.begin(['big-local'])
  await p.ended(runId)
  const log = rows(p.file('benchmark.jsonl'))
  const taskRows = log.filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['debugging-1', 'timed_out']])
  const weights = taskRows[0].modelVersion
  assert.match(String(weights), /^[0-9a-f]{12,}$/, 'the preflight names the weights it ran on')
  assert.deepEqual(taskRows.map((r) => [r.modelVersion, r.subject?.version]), [[weights, weights], [weights, weights]], 'the timed-out task names them too')
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.recorded]), [['big-local', 'finished', 3]])
  const evidence = rows(p.file('capability-evidence.jsonl')).filter((e) => e.source === 'benchmark')
  assert.deepEqual(evidence.map((e) => [e.note, e.score, e.subject.model, e.subject.version]), ['debugging', 'coding', 'general_reasoning'].map(() => ['debugging-1', 0, 'big', weights]))
})

test('a local agent\'s task during which the engine loads a model again is the machine\'s doing: errored and run again, never graded against the model', async (t) => {
  const p = await plugin(t, { local: true, tasks: ['preflight', 'debugging-1'], behave: (agent, task, n) => (task === 'debugging-1' && n === 1 ? 'reload' : 'solve') })
  const runId = await p.begin(['big-local'])
  await p.ended(runId)
  const log = rows(p.file('benchmark.jsonl'))
  assert.deepEqual(log.filter((r) => r.type === 'task').map((r) => [r.task, r.rerun, r.outcome, r.reason]), [
    ['preflight', false, 'passed', 'passed all 1 checks'],
    ['debugging-1', false, 'errored', 'the engine loaded or unloaded a model while it worked'],
    ['debugging-1', true, 'passed', 'passed all 8 checks'],
  ])
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status]), [['big-local', 'finished']])
})

test('KzH closing stops a run: the task under way is not scored, and nothing is recorded for the agent at work or those after it', async (t) => {
  const p = await plugin(t, { tasks: ['preflight', 'debugging-1'], behave: (agent, task) => (agent === 'codex' && task === 'preflight' ? 'hold' : 'solve') })
  await p.begin(['codex', 'deep'])
  await until('codex is at work', () => p.world.started.length, (n) => n === 1)
  await p.close()
  const log = await until('the run has ended', () => rows(p.file('benchmark.jsonl')), (r) => r.some((x) => x.type === 'end'), { timeoutMs: 20_000 })
  assert.deepEqual(log.filter((r) => r.type === 'task').map((r) => [r.agent, r.task, r.outcome, r.reason]), [['codex', 'preflight', 'not_scored', 'the benchmark was stopped']])
  assert.deepEqual(log.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status]), [['codex', 'stopped'], ['deep', 'not_run']])
  assert.equal(log.at(-1).status, 'stopped')
  assert.deepEqual(rows(p.file('capability-evidence.jsonl')), [])
  assert.deepEqual(p.world.started.map((x) => x.agent), ['codex'], 'deep was never started')
})

test('the Router tab\'s route shows a dimension that only a benchmark has measured and no prior covers, with its benchmark summary', async (t) => {
  // simple_change-1 credits instruction following, for which no family has a prior.
  const p = await plugin(t, { tasks: ['preflight', 'simple_change-1'] })
  const runId = await p.begin(['codex'])
  await p.ended(runId)
  const codex = (await p.http('GET', '/jev-router/routing')).body.profiles.find((x) => x.id === 'codex')
  const d = codex.dimensions.instruction_following
  assert.ok(d, JSON.stringify(Object.keys(codex.dimensions)))
  assert.equal(d.prior ?? null, null, 'no prior covers it')
  assert.equal(d.samples, 0, 'no run has measured it')
  assert.deepEqual([d.benchmark.tasks, d.benchmark.passed, d.benchmark.score], [1, 1, 1], JSON.stringify(rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task').map((r) => [r.task, r.outcome, r.reason])))
})

test('an agent that keeps the handoff note its prompt asks for, from its working directory in the scratch root, keeps it in its own folder and is not failed for it', async (t) => {
  const p = await plugin(t, { tasks: ['preflight', 'debugging-1'], behave: () => 'handoff' })
  const runId = await p.begin(['codex'])
  await p.ended(runId)
  for (const x of p.world.started) assert.ok(x.text.includes(`Keep ${join(x.folder, '.kz-harness', 'handoff.md')} updated as you work`), 'the prompt names the note in the task\'s own folder')
  const taskRows = rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'task')
  assert.deepEqual(taskRows.map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['debugging-1', 'passed']], taskRows.map((r) => r.reason).join('; '))
  assert.ok(taskRows.every((r) => !/wrote outside its folder/.test(r.reason)))
  assert.deepEqual(readdirSync(p.scratchRoot), [], 'nothing was written beside the task folders')
  assert.deepEqual(rows(p.file('benchmark.jsonl')).filter((r) => r.type === 'agent').map((r) => [r.agent, r.status]), [['codex', 'finished']])
})

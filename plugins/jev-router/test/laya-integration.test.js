// Laya wired into the plugin (docs/laya-auto.md 2.4, 3.4, 3.5, 5, 6, 8.4 and 9.3): apply() with
// just enough of the plugin runtime for it, Laya installed on a PC of its own with its real
// supervisor keeping a fake laya.serve, Jev as the TypeSafe SDK answering from this file, agents
// that fix a small repo, and a network on which only this PC, Laya's connectivity probe and Jev's
// own probe answer. Whole runs through the model menu's rows, /laya, background tasks and the
// routes, and the integrity invariants that need them (6.9: 1, 4, 5, 7 and 9).
//
// First, an engine home of this file's own, before the plugin is loaded (it reads DSH_HOME once):
// the accounts keep their .env there, and a test must neither read nor write the person's own.
import 'data:text/javascript,import{mkdtempSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";process.env.DSH_HOME=mkdtempSync(join(tmpdir(),"kz-laya-dsh-"))'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
// A namespace, so the file still loads where the plugin lacks what these tests are about, and each
// test fails by its own assertion there rather than all of them at link time (9.1).
import * as jevRouter from '../index.js'
import { renderOptions, startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
// Every folder this file makes, the engine home above first, removed once more when the file is
// done: the engine home has no test of its own to remove it, and a run of a closed plugin still at
// work when its test ended (one a test left held) still appends to its data folder as it ends.
const made = [process.env.DSH_HOME]
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const COMMIT = '1a2b3c4d5e6f7a8b9c0d'.padEnd(40, '0')
// The model label and identity the Laya client gives what laya.serve answered (4.5).
const LABEL = 'laya-english/0.3.20@1a2b3c4'
const CONNECTIVITY = 'http://connectivity.kzh-test.invalid/connecttest.txt'
const SESSION = 'session-1'
const WHERE = 'Settings → Jev setup → Laya decision model'
// What the person reads when Laya cannot be asked, word for word as docs/laya-auto.md 3.5 has it.
const TEXT = {
  notInstalled: `Laya Auto did not run this: Laya is not installed on this PC. Install it in ${WHERE}, or pick Jev Auto. Nothing was run.`,
  disabled: 'Laya Auto did not run this: Laya is switched off in the configuration (jev-router laya.enabled). Nothing was run.',
  invalid: (m) => `Laya Auto did not run this: Laya's settings are invalid (${m}). Nothing was run.`,
  routingOff: 'Laya Auto needs adaptive routing (routing.enabled in the jev-router configuration). Nothing was run.',
  failed: (r) => `Laya Auto did not run this: Laya stopped after an error (${r}). Press Start in ${WHERE}, where the log is. Nothing was run.`,
  stillStarting: (s) => `Laya Auto did not run this: Laya was still starting after ${s} s. Nothing was run. Send it again once ${WHERE} says Running.`,
  couldNotStart: (r) => `Laya Auto did not run this: Laya could not start (${r}). Press Start in ${WHERE}, where the log is. Nothing was run.`,
}

// ---------------------------------------------------------------- the network and Jev

// The network as this file allows it: this PC, Laya's connectivity probe, and Jev's own probe while
// `online`. Anything else is refused, and every request is kept, so a test can say where nothing went.
const realFetch = globalThis.fetch
const net = { seen: [], online: true, deepseekBalance: null }
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  net.seen.push(url)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  // DeepSeek's balance, per key value, when a test says what it is.
  if (url === 'https://api.deepseek.com/user/balance' && net.deepseekBalance) {
    const amount = net.deepseekBalance(String(init?.headers?.authorization ?? '').replace(/^Bearer /, ''))
    return Promise.resolve(new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: String(amount) }] })))
  }
  if (url === CONNECTIVITY || url.startsWith('https://api.typesafe.ai')) return net.online ? Promise.resolve(new Response('')) : Promise.reject(new TypeError('fetch failed'))
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}
const typesafe = (url) => { try { return /typesafe/i.test(new URL(url).host) } catch { return false } }

// Jev, as the TypeSafe SDK answers for every client that is not Laya's on this PC: each call kept
// as it would leave the machine, each question answered from `jev.said` (a value or a function of
// the call's state), else by its type. A call for which `jev.refuses` (a function of the call's
// questions) returns true fails, as a call to a Jev that is down does.
const realSystemOne = TypeSafeClient.prototype.systemOne
const jev = { calls: [], said: {}, refuses: null }
TypeSafeClient.prototype.systemOne = function systemOne(request, options) {
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL)) return realSystemOne.call(this, request, options)
  jev.calls.push({ baseURL: this.baseURL, body: JSON.stringify(request) })
  if (jev.refuses?.(request.questions)) return Promise.reject(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))
  const answers = {}
  for (const [name, q] of Object.entries(request.questions)) {
    const s = typeof jev.said[name] === 'function' ? jev.said[name](request.state) : jev.said[name]
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria)
      const c = keys.includes(s) ? s : name === 'capability' && keys.includes('project_change') ? 'project_change' : name === 'kind' ? 'task' : keys[0]
      answers[name] = { type: 'choice', choice: c, confidence: 0.85, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.85 : 0.15 / Math.max(1, keys.length - 1)])) }
    } else if (q.type === 'score') answers[name] = { type: 'score', score: s ?? 1, confidence: 0.8 }
    else answers[name] = { type: 'noul', noul: s ?? (['addressed', 'complete', 'needsTests'].includes(name) ? 0.95 : 0.05), confidence: 0.9 }
  }
  return Promise.resolve({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers })
}

// What Laya answers unless a test says otherwise: a task, needing a project change, done well.
const LAYA_SAYS = {
  kind: (state) => (JSON.stringify(state).includes('?') ? 'question' : 'task'), depth: 'everyday', alsoWork: 0.05,
  capability: 'project_change', handler: 'agent', disposition: 'PASS',
  addressed: 0.95, complete: 0.95, unrelatedChanges: 0.05, regressionRisk: 0.05, needsPerson: 0.05,
}

/**
 * The fake laya.serve's answer: every question sure of what `said` names (a choice's key, a score's
 * level, a yes/no's P(true), or a function of the view Laya was sent), else of its first option.
 */
function layaAnswers(world) {
  return (name, q, state) => {
    const s = { ...LAYA_SAYS, ...world.said }
    const want = typeof s[name] === 'function' ? s[name](state) : s[name]
    if (q.type === 'noul') { const p = typeof want === 'number' ? want : 0.1; return [1 - p, p] }
    const k = renderOptions(q).length
    const keys = q.type === 'choice' ? (Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria)) : q.criteria.map((_, i) => String(i))
    const at = Math.max(0, keys.indexOf(String(want ?? keys[0])))
    return keys.map((_, i) => (i === at ? 0.99 : 0.01 / (k - 1)))
  }
}

// ---------------------------------------------------------------- the PC and the plugin

const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

// A repo whose check passes only once an agent has written "fixed" into state.txt.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-laya-work-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

/** Laya as the install leaves it (7.1): the venv's interpreter, installed.json, and weights recorded after a load. */
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
  return paths
}

/**
 * What a test leaves in the temp folder goes when it ends: each plugin it made is closed first,
 * which waits for what it still has to write to its data folder (index.js closeWithin), and then
 * each folder it made is removed. One hook per test, so a plugin made later on another's folders
 * is closed before either goes. `dirs` are that test's folders to remove.
 */
const cleanups = new WeakMap()
function cleanUp(t, ...dirs) {
  let c = cleanups.get(t)
  if (!c) {
    c = { closes: [], dirs: [] }
    cleanups.set(t, c)
    t.after(async () => {
      for (const close of c.closes) await close()
      for (const dir of c.dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    })
  }
  c.dirs.push(...dirs)
  made.push(...dirs)
  return c
}

const AGENTS = [
  { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', description: 'The native harness agent on the DeepSeek API, paid per token.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'kimi', name: 'Kimi agent', provider: 'spawn', description: 'An agent on the Moonshot API, paid per token.', enabled: true, llm: { provider: 'moonshot', model: 'kimi-k2' } },
]

/**
 * The plugin on a PC of its own. `installed` puts Laya's install there, and `pins` the harness's
 * config/laya.json; `laya` is the jev-router `laya` block; `settings` is laya.json (the card's
 * switches); `config` is more of the Config; `jobs` gives it the background job service;
 * `supervisor` more seams for Laya's supervisor; `local` stands in for the local models'. The
 * supervisor's interpreter is a child that only stays alive, and the fake laya.serve answers on
 * the port and key it was handed, from this process, as `world.said` says; with `world.failStart`
 * the next start exits before it is ready, and `world.loadMs` is how long the model takes to load.
 * `replies` goes to apply() as its seam of that name (how soon a start reply that never said what it
 * named is taken to have named nothing). A message the plugin appends to the chat for which
 * `world.refuseAppend` returns true is refused, as a chat that cannot take it at that moment does.
 * `world.attachments`, when a test sets it, is the engine's store of attached pictures, which reads
 * a picture's bytes (`readImageRequest`) for a task that must hand it to an agent.
 */
async function plugin(t, { installed = true, pins = true, laya = {}, settings, config = {}, jobs = false, supervisor = {}, local, localModels = {}, dataDir: sharedData, harnessDir: sharedHarness, accounts, onSpawn, replies } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-laya-integration-'))
  const cleanup = cleanUp(t, root)
  const dataDir = sharedData ?? join(root, 'data')
  const harnessDir = sharedHarness ?? join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  if (installed && !sharedHarness) await installLaya(harnessDir, dataDir)
  const pinsFile = join(harnessDir, 'config', 'laya.json')
  if (pins && !existsSync(pinsFile)) { mkdirSync(dirname(pinsFile), { recursive: true }); copyFileSync(join(REPO, 'config', 'laya.json'), pinsFile) }
  if (settings) { mkdirSync(join(dataDir), { recursive: true }); writeFileSync(join(dataDir, 'laya.json'), JSON.stringify(settings)) }
  if (accounts) writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify(accounts))
  const workspace = repo()
  cleanUp(t, workspace)
  const children = []
  const world = { said: {}, fakes: [], spawned: [], children, loadMs: 0, failStart: false, work: null, reply: null, outcome: null, beforeDispose: null, delivered: [], notices: [], refuseAppend: null, chat: [], emitted: [], disposed: [], providers: {}, readTools: ['read', 'glob', 'grep'], toolMode: 'native', childSees: null, attachments: null }

  const spawn = (cmd, args, opts) => {
    world.spawned.push({ cmd, args, env: opts.env })
    onSpawn?.()
    if (world.failStart) {
      const child = nodeSpawn(process.execPath, ['-e', "process.stderr.write('laya.serve: the model did not load\\n'); process.exit(3)"], opts)
      children.push(child)
      return child
    }
    const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], opts)
    children.push(child)
    const fake = startFakeLaya({
      host: opts.env.LAYA_HOST, port: Number(opts.env.LAYA_PORT), apiKey: opts.env.LAYA_API_KEY, device: opts.env.LAYA_DEVICE,
      models: ['english'], loadMs: world.loadMs, answer: layaAnswers(world),
    })
    fake.then((f) => world.fakes.push(f), () => child.kill('SIGKILL'))
    child.once('exit', () => { fake.then((f) => f.close(), () => {}) })
    return child
  }

  const ran = []
  const subagents = {
    // The providers as the engine names them: spawn takes a per-start tool filter, and any other
    // (the plan-mode Claude Code row) is what a test puts in `world.providers`.
    getProvider: (name) => world.providers[name] ?? (name === 'spawn' ? { capabilities: { toolFilter: true } } : undefined),
    async start(provider, opts) {
      const allow = opts.toolFilter?.allow ?? null
      const entry = { provider, label: opts.label, prompt: opts.prompt?.[0]?.text ?? '', toolFilter: opts.toolFilter ?? null }
      const n = ran.push(entry)
      // An engine may await before its provider reads the environment: the Claude effort a start
      // really got is read after that.
      await world.beforeStart?.(n)
      entry.effortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null
      const result = (async () => {
        await world.work?.(opts, n)
        // A stopped agent's run rejects, as the engine's subagents do.
        opts.signal?.throwIfAborted()
        // What an agent came to on its own, when a test says so.
        const own = world.outcome?.(n)
        if (own) return own
        // Started with only the read tools, or on a row in plan mode, it has nothing to write with.
        if (!allow && world.providers[provider]?.config?.permissionMode !== 'plan') writeFileSync(join(workspace, 'state.txt'), 'fixed')
        return { stopReason: 'completed', output: [{ type: 'text', text: world.reply?.(n) ?? `Fixed it (attempt ${n}).` }], usage: {} }
      })()
      // A child stopped before anyone reads its result must not fail the file as unhandled.
      result.catch(() => {})
      // Ending a child's process can take a while (`world.beforeDispose`).
      return { result, localAgent: { id: `child-${n}`, allow }, dispose: async () => { await world.beforeDispose?.(n); world.disposed.push(n) } }
    },
  }
  let jobCount = 0
  const jobService = {
    start: (spec) => { const id = `jev-${++jobCount}`; spec.run(); return id },
    wait: () => new Promise(() => {}),
    read: (id) => ({ text: '', snapshot: { id } }),
    kill: () => 'requested',
  }

  // A result's summary names its task between `·`s (delivery.js); a milestone notice's never holds
  // one (reply-words.js), and is kept apart, so `delivered` counts results as it always has.
  const isResult = (msg) => String(msg?.source?.summary ?? '').includes('·')
  const append = (_kind, msg) => {
    if (world.refuseAppend?.(msg)) throw new Error('the chat could not take it')
    ;(isResult(msg) ? world.delivered : world.notices).push(msg)
  }
  const agent = { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const tools = new Map()
  const routes = []
  let adapter = null
  const llm = {
    registerAdapter: (ids, a) => { if (ids.includes('jev')) adapter = a; return () => {} },
    // A chat model that answers every question the same way, and keeps what it was sent.
    stream: (opts) => (async function* () {
      world.chat.push({ provider: opts.provider, model: opts.model, purpose: opts.purpose ?? null, messages: opts.messages ?? [] })
      const text = 'A monad chains computations that carry a context.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    resolveModel: async () => null,
    listProviders: () => [],
    listModels: async () => [],
  }
  const runtime = {
    effect, llm, emit: (name) => world.emitted.push(name), get: () => null,
    agents: { get: () => agent, currentInitiator: () => agent },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => 0 },
    workspaceRegistry: { list: () => [] },
  }
  const ctx = {
    credentials: { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'tsk_integration_test' } : undefined) },
    effect, subagents,
    get: (name) => (name === 'jobs' && jobs ? jobService : name === 'attachments' ? world.attachments : null),
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    // The registry as a scope sees it: the read tools mounted (`world.readTools`), presented natively
    // (`world.toolMode`), and a child seeing its allow list, or what `world.childSees` says it sees.
    tools: {
      register: (tool) => { tools.set(tool.name, tool) },
      get: (name) => tools.get(name) ?? (world.readTools.includes(name) ? { name } : undefined),
      modeFor: () => world.toolMode,
      schemas: (scope) => (scope?.allow ? (world.childSees?.(scope.allow) ?? scope.allow) : [...tools.keys()]).map((name) => ({ name })),
    },
    inject: (_deps, fn) => fn(runtime),
  }
  const { timing, ...seams } = supervisor
  jevRouter.apply(ctx, jevRouter.Config({
    agents: AGENTS,
    historyFile: join(dataDir, 'history.jsonl'),
    checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
    format: { enabled: false },
    ...config,
    laya: { port: await freePort(), connectivityUrl: CONNECTIVITY, ...laya },
  }), {
    laya: {
      harnessDir, spawn, run: async () => null,
      timing: { readyPollMs: 20, healthTimeoutMs: 1000, idleCheckMs: 20, exitWaitMs: 2000, ...timing },
      ...seams,
    },
    local,
    // No model of this machine's reaches these tests. Without this the manifest and the models
    // folder of the real installation are read, so whatever the owner happens to have installed
    // becomes an extra routing candidate and the answer depends on the PC the suite runs on. A
    // model this harness wants is given through `config.agents`, as the local agent already is.
    localModels: { modules: [], modelsDir: join(harnessDir, 'no-models'), ...localModels },
    ...(replies ? { replies } : {}),
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const d of effects.reverse()) { try { await d() } catch { /* already gone */ } }
    await waitFor('every laya.serve stand-in has exited', () => children.every((c) => c.exitCode !== null || c.signalCode !== null), Boolean, { timeoutMs: 10_000 }).catch(() => children.forEach((c) => c.kill('SIGKILL')))
    for (const f of world.fakes) await f.close().catch(() => {})
  }
  cleanup.closes.push(close)

  const messages = []
  /**
   * One message typed into the row `model` (Laya Auto by default), as the engine streams it through
   * the adapter, with `images`, the content parts of the pictures attached to it. `hold`, when a test
   * gives it, is awaited with each event and the reply so far before the next event is read, as a
   * chat slow to take a reply holds it.
   */
  async function say(text, { model = 'laya-auto', purpose, signal, effort, images = [], hold } = {}) {
    if (!purpose) messages.push({ role: 'user', content: [{ type: 'text', text }, ...images] })
    const out = { text: '', reasoning: '' }
    const options = purpose ? { model, purpose, messages: [{ role: 'user', content: [{ type: 'text', text }] }], sessionId: SESSION } : { model, messages: [...messages], sessionId: SESSION, signal, ...(effort ? { reasoningEffort: effort } : {}) }
    for await (const e of adapter.stream(options)) {
      if (e.type === 'text-delta') out.text += e.text
      if (e.type === 'reasoning-delta') out.reasoning += e.text
      await hold?.(e, out)
    }
    if (!purpose) messages.push({ role: 'assistant', content: [{ type: 'text', text: out.text }] })
    return out
  }

  /** One request to the plugin's routes, answered as JSON. */
  function http(method, path, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } })
    return new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }) } }
      routes[0].handler(req, res).catch(reject)
    })
  }

  /** A slash command as the engine runs it. */
  const slash = (name, rawInput, { signal = new AbortController().signal } = {}) => {
    assert.ok(commands.has(name), `/${name} is registered`)
    return commands.get(name).handler({ agent, rawInput, signal })
  }

  const read = (name) => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), 'utf8') : '')
  const rows = (name) => read(name).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dataDir, harnessDir, workspace, world, ran, commands, tools, agent, say, http, slash, read, rows, close, adapter: () => adapter }
}

/** Every file under `dir`, with its size and time, so a test can wait until nothing more is written. */
function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) filesUnder(p, out)
    // A tab, not a colon: `C:\path` splits on a colon and every reader would open `...\C`.
    else { const s = statSync(p); out.push(`${p}\t${s.size}\t${s.mtimeMs}`) }
  }
  return out
}
/** Until nothing under `dir` has changed for `forMs`: what a run writes after it returns (learning, the standing) has landed. */
async function quiet(dir, { forMs = 600, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = JSON.stringify(filesUnder(dir))
  let since = Date.now()
  while (Date.now() - since < forMs) {
    if (Date.now() > deadline) throw new Error(`${dir} kept changing`)
    await tick(50)
    const now = JSON.stringify(filesUnder(dir))
    if (now !== last) { last = now; since = Date.now() }
  }
}
/** Poll an asynchronous read until `ok` holds, with a deadline; throws with the last value read. */
async function until(label, read, ok, { timeoutMs = 10_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await read() } catch (err) { value = `not readable yet: ${err.message}` }
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: still not true after ${timeoutMs} ms, last: ${JSON.stringify(value)?.slice(0, 800)}`)
    await tick(everyMs)
  }
}
/** The bytes of every file under `dir`, by path. */
const bytesUnder = (dir) => Object.fromEntries(filesUnder(dir).map((l) => l.split('\t')[0]).map((p) => [p, readFileSync(p, 'utf8')]))

const laya = (p) => p.http('GET', '/jev-router/laya').then((r) => r.body)
const started = async (p) => { const r = await p.http('POST', '/jev-router/laya/start', {}); assert.equal(r.status, 200, JSON.stringify(r.body)); return laya(p) }

// ---------------------------------------------------------------- the picker's figures

test('what a task and a review cost Laya on this PC: from each phase\'s measured ms per token, and nothing until every phase has one', () => {
  const { layaCosts, layaReason } = jevRouter
  assert.equal(typeof layaCosts, 'function', 'the plugin works out what Laya costs')
  assert.equal(typeof layaReason, 'function', 'and says why Laya could not be asked')
  assert.deepEqual(layaCosts(null), {})
  assert.deepEqual(layaCosts({ intent: 0.5, route: null, review: 0.5 }), {}, 'a phase not measured yet: nothing is said')
  const intentOnly = layaCosts({ intent: 1, route: 0, review: 0 })
  const routeOnly = layaCosts({ intent: 0, route: 1, review: 0 })
  const reviewOnly = layaCosts({ intent: 0, route: 0, review: 1 })
  assert.ok(intentOnly.routeMs > 0 && intentOnly.reviewMs === 0, 'a task is its intent and its routing call')
  assert.ok(routeOnly.routeMs > intentOnly.routeMs, 'the routing call is the bigger part of a task')
  assert.ok(reviewOnly.reviewMs > 0 && reviewOnly.routeMs === 0, 'and each attempt costs one review call')
  assert.deepEqual(layaCosts({ intent: 2, route: 2, review: 2 }), { routeMs: (intentOnly.routeMs + routeOnly.routeMs) * 2, reviewMs: reviewOnly.reviewMs * 2 })
  // A refusal said as the reason one call could not be asked (3.4).
  assert.equal(layaReason({ reason: 'not_installed' }), 'Laya is not installed on this PC')
  assert.equal(layaReason({ reason: 'disabled' }), 'Laya is switched off in the configuration')
  assert.equal(layaReason({ reason: 'invalid', detail: 'x' }), "Laya's settings are invalid (x)")
  assert.equal(layaReason({ reason: 'pins', detail: 'z' }), "Laya's pinned versions could not be read (z)")
  assert.equal(layaReason({ reason: 'failed', detail: 'y' }), 'Laya stopped after an error (y)')
  assert.equal(layaReason(new Error('timed out after 8 s')), 'timed out after 8 s')
})

test('what routing a task costs counts every call it sends Laya: the intent, the task group, and the resource and judgments call', async () => {
  const selfcheck = await import('../laya-selfcheck.js')
  const { estimateRequestTokens, renderForLaya } = await import('../laya-questions.js')
  assert.equal(typeof selfcheck.taskCalls, 'function', 'the self-check holds what routing one task sends')
  const calls = selfcheck.taskCalls()
  assert.deepEqual(calls.map((c) => c.phase), ['intent', 'route', 'route'], 'an intent, then two route calls, as decision.js sends them')
  const [, group, resource] = calls
  assert.ok(group.questions.taskType && !group.questions.strategy, 'the task group first')
  assert.ok(resource.questions.strategy && resource.questions.secondOpinion && !resource.questions.taskType, 'then the resource and judgments call, once the pool exists')
  const tokens = (c) => renderForLaya(c, { role: 'act' }).reduce((n, r) => n + estimateRequestTokens(r), 0)
  const { layaCosts } = jevRouter
  assert.equal(typeof layaCosts, 'function', 'the plugin works out what Laya costs')
  assert.equal(layaCosts({ intent: 1, route: 0, review: 0 }).routeMs, tokens(calls[0]))
  assert.equal(layaCosts({ intent: 0, route: 1, review: 0 }).routeMs, tokens(group) + tokens(resource), 'the routing figure is both route calls, never the task group alone')
})

test('the model menu offers Laya Auto only while Laya can be asked, and says what it costs once this PC has measured it', async (t) => {
  const none = await plugin(t, { installed: false })
  assert.deepEqual((await none.adapter().listModels('jev')).map((m) => m.id).filter((id) => !id.startsWith('agent-')), ['jev-auto'], 'not installed: no Laya Auto row')
  const off = await plugin(t, { config: { routing: { enabled: false } } })
  assert.deepEqual((await off.adapter().listModels('jev')).map((m) => m.id).filter((id) => !id.startsWith('agent-')), ['jev-auto'], 'routing off: no Laya Auto row')

  const p = await plugin(t)
  const rowOf = async () => (await p.adapter().listModels('jev')).find((m) => m.id === 'laya-auto')
  assert.deepEqual((await p.adapter().listModels('jev')).map((m) => m.id).slice(0, 2), ['jev-auto', 'laya-auto'], 'right after Jev Auto')
  assert.ok((await rowOf()).description.endsWith('Laya is not running; the first message starts it.'), (await rowOf()).description)
  const before = p.world.emitted.filter((e) => e === 'llm/adapters-updated').length
  const s = await started(p)
  assert.equal(s.state, 'ready')
  assert.ok(p.world.emitted.filter((e) => e === 'llm/adapters-updated').length > before, 'every change of Laya\'s state refreshes the menu')
  // The first start measures every phase (7.5), so the row can say what a task costs here.
  assert.equal(typeof s.running.routeMs, 'number', JSON.stringify(s.running))
  assert.equal(typeof s.running.reviewMs, 'number')
  assert.match((await rowOf()).description, /Measured on this PC, on the CPU: about [\d.]+ s to route a task and [\d.]+ s to review each attempt\.$/)
  await p.http('POST', '/jev-router/laya/stop', {})
  assert.match((await rowOf()).description, /Laya is not running; the first message starts it \(the last start took [\d.]+ s\)\.$/)
})

test('the model menu keeps what this PC measured while Laya restarts after a crash, never calling it unmeasured', async (t) => {
  // A long crash backoff, so the restart waits while the menu is read.
  const p = await plugin(t, { supervisor: { timing: { backoffMs: [60_000] } } })
  const rowOf = async () => (await p.adapter().listModels('jev')).find((m) => m.id === 'laya-auto')
  const MEASURED = /Measured on this PC, on the CPU: about [\d.]+ s to route a task and [\d.]+ s to review each attempt\.$/
  await started(p)
  assert.match((await rowOf()).description, MEASURED)
  p.world.children.at(-1).kill('SIGKILL')
  await until('Laya is restarting', () => laya(p), (s) => s.state === 'restarting')
  assert.match((await rowOf()).description, MEASURED, 'a crash does not take away what this PC measured')
})

// ---------------------------------------------------------------- Laya Auto, end to end

test('a Laya Auto run end to end: Laya starts, sorts the message, routes and reviews, with its own lines and records, no Jev call and nothing shadowed', async (t) => {
  const p = await plugin(t)
  const jevBefore = jev.calls.length
  const out = await p.say('Fix the failing test in the parser')
  const report = out.text
  assert.match(report, /^\*\*Laya router\*\* · AUTO \(Laya and routing rules decided\)/, report)
  assert.match(out.reasoning, /Starting Laya on this PC: loading the model on the CPU \(\d+ s\)…/, 'it waited for the start, and said so')
  assert.match(out.reasoning, /Laya is ready on the CPU \(loaded in \d+ s\)/)
  assert.match(out.reasoning, /Laya route: \d+\/\d+ questions in \d+ ms on the CPU/)
  assert.match(out.reasoning, /Routed to \w+ \(laya\)/)
  assert.match(out.reasoning, /Review: accept\./)
  assert.doesNotMatch(`${out.reasoning}\n${report}`, /\bJev\b/, 'no line of a Laya Auto run mentions Jev')
  assert.equal(jev.calls.length, jevBefore, 'and Jev was never asked')

  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  assert.equal(record.routing.decider, 'laya')
  assert.equal(record.routing.model, LABEL)
  assert.equal(record.finalStatus, 'accepted')
  assert.ok(record.assessments.length && record.assessments.every((a) => a.mode === 'laya'), 'Laya reviewed every attempt')
  // Usage: Laya's acting calls at $0 under the run's id, the intent under 'intent', and no Jev row.
  const usage = p.rows('usage.jsonl')
  const decisions = usage.filter((u) => u.agent === 'laya')
  assert.ok(decisions.some((u) => u.phase === 'intent' && u.runId === 'intent'))
  assert.ok(decisions.some((u) => u.phase === 'route' && u.runId === record.runId))
  assert.ok(decisions.some((u) => u.phase === 'review' && u.runId === record.runId))
  assert.ok(decisions.every((u) => u.costUsd === 0 && u.model === LABEL))
  assert.equal(usage.filter((u) => u.agent === 'jev').length, 0)
  // Its samples went to Laya's store only (invariant 1), each under the run's id.
  const samples = p.rows('laya-samples.jsonl').filter((r) => r.domain)
  assert.ok(samples.some((s) => s.domain === 'task_classification' && s.authority === 'laya' && s.runId === record.runId && s.teacher === null))
  assert.equal(p.read('routing-samples.jsonl'), '', 'nothing of a Laya-decided run reaches the Jev store')
  // Laya Auto has no shadow (5.1): with the shadow on, as it is by default, none of Laya's own
  // calls is compared, which would record Laya's answers as Jev's side of the comparison.
  assert.notEqual((await laya(p)).settings.shadow, false, 'the setting: the shadow is on')
  assert.equal(p.read('laya-shadow.jsonl'), '', 'a Laya Auto run writes no shadow row')
  // The inspector's entry is the run.
  const { body: log } = await p.http('GET', `/jev-router/log?session=${SESSION}`)
  assert.equal(log.at(-1).id, record.runId)
  assert.ok(!log.at(-1).events.some((e) => e.type === 'shadow'), 'and its inspector entry holds none')
  assert.deepEqual((await laya(p)).running.held, [], 'the run let go of Laya when it returned')
})

test('a Laya call that fails mid-run is said and filled by the rules, never asked of Jev: the run stays Laya\'s and Jev is not called', async (t) => {
  const p = await plugin(t)
  await started(p)
  // The task group fails on the server once the run has started: Laya is up, and only this call breaks.
  p.world.said.taskType = () => { throw new Error('model error') }
  const jevBefore = jev.calls.length
  const out = await p.say('Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\* · AUTO/, out.text)
  assert.match(out.text, /\n- Laya did not answer: route: /, 'the report says which call Laya did not answer')
  assert.equal(jev.calls.length, jevBefore, 'Jev is never asked in its place')
  assert.doesNotMatch(`${out.reasoning}\n${out.text}`, /\bJev\b/, 'and no line of the run names Jev')
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  assert.equal(record.routing.decider, 'laya')
  assert.equal(record.routing.decision.domains.task_classification.authority, 'fallback', 'the rules gave what Laya did not answer')
  assert.equal(p.rows('usage.jsonl').filter((u) => u.agent === 'jev').length, 0, 'and no Jev call was paid for')
})

test('offline, Laya Auto keeps deciding: Laya routes the task to a local model, and Jev is not asked', async (t) => {
  const local = { readiness: async () => ({ installed: true, loggedIn: true, detail: 'ready' }), chatModel: async () => 'qwen3-8b' }
  const agents = [...AGENTS, { id: 'qwen-local', name: 'Local agent', provider: 'spawn', description: 'The native harness agent on the local model on this PC.', enabled: true, llm: { provider: 'local', model: 'qwen3-8b' } }]
  const p = await plugin(t, { local, config: { agents } })
  await started(p)
  net.online = false
  t.after(() => { net.online = true })
  const jevBefore = jev.calls.length
  const out = await p.say('Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\* · AUTO \(Laya and routing rules decided\)/, out.text)
  assert.ok(out.text.split('\n')[0].includes('OFFLINE: local models only'), 'the heading says it is offline')
  assert.match(out.reasoning, /Laya route: \d+\/\d+ questions in \d+ ms on the CPU/, 'Laya was asked offline')
  assert.match(out.reasoning, /Routed to qwen-local \(laya, local\)/, 'and routed to the local model')
  assert.doesNotMatch(out.reasoning, /no Laya call/)
  assert.equal(jev.calls.length, jevBefore, 'Jev is not asked')
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  assert.equal(record.routing.decider, 'laya')
  assert.equal(record.routing.decision.domains.task_classification.authority, 'laya', 'Laya decided the task')
})

test('invariant 5: a Laya Auto session never builds a TypeSafe client without 127.0.0.1 and never reaches a TypeSafe host: a question, a task and a title', async (t) => {
  // A local chat model, so a title has somewhere else to go and asks whether the cloud can be
  // reached: with none, offline and online pick the same model and the title path asks nothing.
  const p = await plugin(t, { local: { chatModel: async () => 'qwen-local' } })
  // Every read of TYPESAFE_BASE_URL from inside the SDK: the SDK reads it only while it builds a
  // client that was handed no baseURL.
  const env = process.env
  const reads = []
  process.env = new Proxy(env, { get(o, k) { if (k === 'TYPESAFE_BASE_URL' && /@typesafe-ai[\\/]sdk/.test(new Error().stack)) reads.push(k); return Reflect.get(o, k) } })
  t.after(() => { process.env = env })
  net.seen = []
  const jevBefore = jev.calls.length

  // The title first, so what it reached is all the network has seen: Laya's connectivity probe,
  // asked with the row's decider, never Jev's probe of a TypeSafe host.
  const title = await p.say('Name this chat', { purpose: 'session-title' })
  assert.match(title.text, /A monad/)
  assert.deepEqual(net.seen, [CONNECTIVITY], 'the title asked laya.connectivityUrl whether the cloud can be reached, and nothing else')
  const question = await p.say('What is a monad?')
  assert.match(question.text, /A monad chains computations/, 'the chat model answered the question')
  assert.equal(p.world.chat.length, 2)
  const task = await p.say('Fix the failing test in the parser')
  assert.match(task.text, /^\*\*Laya router\*\*/)
  assert.deepEqual(p.world.chat.map((c) => c.purpose), ['session-title', null])

  assert.deepEqual(net.seen.filter(typesafe), [], 'no request reached a TypeSafe host')
  assert.ok(net.seen.every((u) => u.startsWith('http://127.0.0.1:') || u === CONNECTIVITY), net.seen.join('\n'))
  assert.equal(jev.calls.length, jevBefore, 'no TypeSafe client was asked anything')
  assert.deepEqual(reads, [], 'no TypeSafe client was built without an explicit baseURL')
  // The spy itself: a client built without a baseURL is seen.
  assert.ok(new TypeSafeClient({ apiKey: 'tsk_spy' }))
  assert.equal(reads.length, 1)
  // The question was answered through a row Laya decides, so "Saved by Jev" does not count it.
  const direct = (await quiet(p.dataDir), p.rows('usage.jsonl')).filter((u) => u.role === 'direct-answer')
  assert.equal(direct.length, 1)
  assert.equal(direct[0].decider, 'laya')
})

test('classify for Laya waits for a start with its line and never probes TypeSafe; only a refusal or a timeout makes a message a task', async (t) => {
  const p = await plugin(t)
  net.seen = []
  const q = await p.say('What does the --fit flag in llama.cpp do?')
  assert.match(q.reasoning, /Starting Laya on this PC: loading the model on the CPU/, 'the message waited for Laya to start')
  assert.match(q.text, /A monad chains computations/, 'and was then asked, and answered as the question it is')
  assert.deepEqual(net.seen.filter(typesafe), [])

  // Laya that is still loading when the start's bound passes: the message is a task, and says why.
  const slow = await plugin(t, { laya: { deadlines: { startWaitMs: 300 } } })
  slow.world.loadMs = 5000
  net.seen = []
  const r = await slow.say('What is a monad?')
  assert.match(r.reasoning, /Laya could not sort this message \(timed out: Laya was still starting after \d+ s\); treating it as a task\./, r.reasoning)
  assert.equal(slow.world.chat.length, 0, 'a message Laya could not sort is not handed to a chat model')
  // As a task, it waits for the same start, which fails at its own bound: the run is refused.
  //
  // Two bounds are running from the same moment: the wait for laya.serve to answer, and the wait
  // for the model to finish loading. Which trips first is a race, and they refuse in different
  // words - one says press Start, the other says send it again once it is Running. Both are the
  // right answer, so both are named here; a third wording would still fail this.
  const refusals = [TEXT.couldNotStart('laya.serve was not ready after 0 s'), TEXT.stillStarting(0)]
  assert.ok(refusals.some((end) => r.text.endsWith(end)), r.text)
  assert.equal(slow.ran.length, 0)
  assert.deepEqual(net.seen.filter(typesafe), [])
})

// ---------------------------------------------------------------- the refusals of 3.5

test('every refusal of 3.5 word for word, before anything runs: through a message, /laya, and never handed to Jev', async (t) => {
  const cases = [
    { name: 'not installed', opts: { installed: false }, text: TEXT.notInstalled },
    { name: 'switched off', opts: { laya: { enabled: false } }, text: TEXT.disabled },
    { name: 'routing off', opts: { config: { routing: { enabled: false } } }, text: TEXT.routingOff },
  ]
  for (const c of cases) {
    const p = await plugin(t, c.opts)
    const jevBefore = jev.calls.length
    const said = await p.say('Fix the failing test in the parser')
    assert.equal(said.text, c.text, `${c.name}: the message's reply`)
    const cmd = await p.slash('laya', 'Fix the failing test in the parser')
    assert.deepEqual(cmd, { kind: 'error', text: c.text }, `${c.name}: /laya`)
    assert.equal(jev.calls.length, jevBefore, `${c.name}: Jev is never asked instead`)
    assert.equal(p.ran.length, 0, `${c.name}: no agent ran`)
    assert.equal(p.world.spawned.length, 0, `${c.name}: Laya was not started`)
  }
})

test('a laya block with a range error leaves the plugin loadable and Jev Auto working, with Laya Auto refused and no Laya-decided run under Jev\'s record', async (t) => {
  const p = await plugin(t, { laya: { thresholds: { accept: { low: 1.5 } } } })
  const s = await laya(p)
  assert.equal(s.state, 'disabled')
  assert.match(s.configError, /^providers: laya\.thresholds\.accept/, s.configError)
  assert.deepEqual((await p.adapter().listModels('jev')).map((m) => m.id).filter((id) => !id.startsWith('agent-')), ['jev-auto'], 'Laya Auto leaves the menu')
  const jevBefore = jev.calls.length
  const refused = await p.say('Fix the failing test in the parser')
  assert.equal(refused.text, TEXT.invalid(s.configError))
  assert.deepEqual(await p.slash('laya', 'Fix the failing test'), { kind: 'error', text: TEXT.invalid(s.configError) })
  assert.equal(jev.calls.length, jevBefore, 'a decider laya run with no Laya record is refused, never run on Jev')
  // Jev Auto runs on, with no shadow.
  const ok = await p.say('Fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(ok.text, /^\*\*Jev router\*\* · AUTO/, ok.text)
  assert.doesNotMatch(ok.reasoning, /Laya/)
  assert.ok(jev.calls.length > jevBefore)
  await quiet(p.dataDir)
  assert.equal(p.read('laya-shadow.jsonl'), '')
  assert.equal(p.world.spawned.length, 0)
})

test('Laya\'s pins that cannot be read take Laya out as the harness file they are, to put back with Update-Harness.ps1, never as the laya block\'s settings', async (t) => {
  // The harness without config/laya.json, as a hand-deleted file or an update cut short leaves it.
  const p = await plugin(t, { pins: false })
  const s = await laya(p)
  assert.match(String(s.pinsError), /ENOENT.*config[\\/]laya\.json/, 'the status says why, apart from any error in the laya block')
  const why = `Laya's pinned versions could not be read (${s.pinsError}); run Update-Harness.ps1`
  const refusal = `Laya Auto did not run this: ${why}. Nothing was run.`
  assert.deepEqual((await p.adapter().listModels('jev')).map((m) => m.id).filter((id) => !id.startsWith('agent-')), ['jev-auto'], 'Laya Auto leaves the menu')
  const jevBefore = jev.calls.length
  assert.equal((await p.say('Fix the failing test in the parser')).text, refusal, 'a message says what is wrong and what puts it right')
  assert.deepEqual(await p.slash('laya', 'Fix the failing test in the parser'), { kind: 'error', text: refusal })
  assert.deepEqual(await p.http('POST', '/jev-router/laya/install', { device: 'cpu' }), { status: 400, body: { error: why } }, 'an install says the same')
  assert.equal(jev.calls.length, jevBefore, 'never handed to Jev')
  assert.equal(p.world.spawned.length, 0, 'and Laya was never started')
})

test('the status says pins that cannot be read apart from an error in the laya block, so the card can give each its own remedy', async (t) => {
  const unread = await laya(await plugin(t, { pins: false }))
  assert.equal(unread.state, 'disabled')
  assert.equal(unread.configError, null, 'nothing is wrong with the laya block')
  assert.match(String(unread.pinsError), /ENOENT.*config[\\/]laya\.json/)
  const both = await laya(await plugin(t, { pins: false, laya: { thresholds: { accept: { low: 1.5 } } } }))
  assert.match(String(both.configError), /^providers: laya\.thresholds\.accept/, both.configError)
  assert.match(String(both.pinsError), /ENOENT.*config[\\/]laya\.json/)
})

test('a Laya that cannot start refuses the run with its reason, through /laya, a message and a task queued before it failed', async (t) => {
  // The start fails: the run that waited for it is refused as 3.5 says, and Laya is then `failed`.
  const p = await plugin(t)
  p.world.failStart = true
  const first = await p.slash('laya', 'Fix the failing test in the parser')
  const s = await laya(p)
  assert.equal(s.state, 'failed')
  assert.match(first.text, /^Laya Auto did not run this: Laya could not start \(.+\)\. Press Start in /, first.text)
  assert.equal(first.text, TEXT.couldNotStart(/could not start \((.+)\)\. Press/.exec(first.text)[1]))
  assert.equal(p.ran.length, 0, 'nothing ran')
  // Failed is sticky until Start: every way in says so at once, and nothing starts it again.
  const spawned = p.world.spawned.length
  assert.deepEqual(await p.slash('laya', 'Fix it'), { kind: 'error', text: TEXT.failed(s.why) })
  assert.equal((await p.say('Fix the failing test in the parser')).text, TEXT.failed(s.why))
  assert.equal(p.world.spawned.length, spawned)

  // Still starting when the bound passes.
  const slow = await plugin(t, { laya: { deadlines: { startWaitMs: 300 } } })
  slow.world.loadMs = 5000
  const late = await slow.slash('laya', 'Fix the failing test in the parser')
  assert.equal(late.text, TEXT.stillStarting(/after (\d+) s/.exec(late.text)?.[1]), late.text)
  assert.equal(slow.ran.length, 0)

  // A task queued while Laya could be asked, which fails before the task runs: refused when it runs,
  // however long after it was queued, with the reply as its reason.
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const one = await q.say('Fix the failing test in the parser')
  assert.match(one.text, /^OK, I'll run \*\*[^*]+\*\* with [^\n]* as \*\*jev-1\*\* in [^\n]*\n\n> Picked by Laya on this PC in /, one.text)
  await waitFor('the first task is running', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const two = await q.say('Now fix the failing lint in the parser')
  assert.match(two.text, /^OK, \*\*jev-2\*\* is queued: 2nd in line for [^ ]+ \(another task is running there[^)]*\)\. Laya picks the agent when it starts;/, two.text)
  // Laya goes down under the open run, and cannot come back.
  q.world.failStart = true
  q.world.children.at(-1).kill('SIGKILL')
  const { why } = await until('Laya is failed', () => laya(q), (s) => s.state === 'failed')
  release()
  const done = await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const second = done.find((m) => m.content[0].text.includes('jev-2')).content[0].text
  assert.match(second, /Status: Failed/)
  assert.ok(second.includes(TEXT.failed(why)), second)
  assert.equal(q.ran.length, 1, 'the refused task ran no agent')
})

// ---------------------------------------------------------------- the waiting line

test('a task waiting behind another in its workspace says why and, from past runs, about how long, through the task list', async (t) => {
  // Five finished runs per agent, with their wall-clock time, as router.js now writes them; and one
  // older row with none, which says nothing about how long work takes.
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-wait-data-'))
  made.push(dataDir)
  const past = AGENTS.flatMap((a) => [3, 4, 5, 6, 7].map((m) => ({ ts: new Date().toISOString(), workspace: 'C:\\elsewhere', routing: { primaryAgent: a.id }, finalStatus: 'accepted', attempts: [{ agent: a.id, role: 'primary' }], wallMs: m * 60_000 })))
  writeFileSync(join(dataDir, 'history.jsonl'), `${[...past, { routing: { primaryAgent: 'deepseek' }, finalStatus: 'accepted' }].map((r) => JSON.stringify(r)).join('\n')}\n`)
  const q = await plugin(t, { jobs: true, dataDir })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const one = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(one.text, /^OK, I'll run \*\*[^*]+\*\* with [^\n]* as \*\*jev-1\*\* in [^\n]*\n\n> Picked by Jev in /, one.text)
  await waitFor('the first task is running', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const two = await q.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
  assert.match(two.text, /^OK, \*\*jev-2\*\* is queued: 2nd in line for [^ ]+ \(another task is running there[^)]*\)\. Jev picks the agent when it starts;/, two.text)
  const waiting = await until('the second task says how long', async () => (await q.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-2')?.waiting, (w) => w?.estimate).catch(() => null)
  assert.ok(waiting, 'the second task says what it waits for and how long')
  assert.equal(waiting.why, 'workspace')
  assert.equal(waiting.reason, 'Waiting: another task is running in this workspace')
  assert.deepEqual([waiting.ahead, waiting.placeText, waiting.slotsAhead], [0, '2nd in line', 0])
  // The running task's own runs have no effort on record here, so the figure is drawn from its agent's.
  assert.match(waiting.estimate.text, /^Starts in about \d+ to \d+ min, estimated from 5 past runs of (deepseek|kimi)\.$/, waiting.estimate.text)
  assert.equal(waiting.text, `Waiting: another task is running in this workspace. ${waiting.estimate.text}`)
  assert.ok(waiting.estimate.lowMs > 0 && waiting.estimate.lowMs < waiting.estimate.highMs)
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  // The runs that just ended wrote their wall-clock time for the next estimate.
  const rows = q.rows('history.jsonl').slice(past.length + 1)
  assert.equal(rows.length, 2)
  for (const r of rows) assert.ok(Number.isFinite(r.wallMs) && Date.parse(r.startedAt) <= Date.parse(r.ts), JSON.stringify(r).slice(0, 200))
})

test('a foreground /auto beside a background task in its workspace waits its turn, and a routed agent still cannot route its own task', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  let nested = null
  q.world.work = async (opts, n) => {
    if (n !== 1) return
    // The agent the router started calls jev_route on its own task, as a child of the chat.
    const child = { id: 'child-1', session: { id: 'child-1', header: { cwd: q.workspace, parentSession: SESSION, origin: 'subagent' } } }
    nested = await q.tools.get('jev_route').execute({ task: 'do it for me' }, { agent: child, signal: opts.signal }).then((r) => ({ ran: r }), (e) => ({ refused: e.message }))
    await blocked
  }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first task is running', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  await waitFor('the nested call was answered', () => nested, Boolean, { timeoutMs: 10_000 })
  assert.deepEqual(nested, { refused: 'a routed agent must do its task directly, not call jev_route: it would wait for its own run to end' })
  let settled = false
  const fg = q.slash('auto', 'Fix the failing lint in the parser').finally(() => { settled = true })
  await tick(300)
  assert.equal(settled, false, 'it waits for the task that holds the folder, rather than refusing')
  assert.equal(q.ran.length, 1, 'and starts no agent beside it')
  release()
  const r = await fg
  assert.equal(r.kind, 'success', JSON.stringify(r).slice(0, 300))
  assert.match(r.text, /Final status: ACCEPTED/)
  assert.equal(q.ran.length, 2, 'it ran once the folder was free')
  // The task's run can still be ending as the foreground one returns: a run still going when its
  // plugin closes appends to the data folder as the clean-up removes it.
  await until('the task has ended', () => taskRow(q, 'jev-1'), (x) => x?.state === 'completed', { timeoutMs: 20_000 })
})


test('a task queued behind a run from the chat says a run from the chat holds its folder, in the chat and in the task list', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const fg = q.slash('auto', 'Fix the failing lint in the parser')
  await waitFor('the run from the chat is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const queued = await q.say('Now fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(queued.text, /2nd in line for [^ ]+ \(a run started from the chat is using it\)/, queued.text)
  const row = (await q.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1')
  assert.equal(row?.waiting?.text, 'Waiting: a run started from the chat is using this workspace.')
  release()
  await fg
  await waitFor('the task ran once the folder was free', () => q.ran.length, (n) => n === 2, { timeoutMs: 30_000 })
})

test('Remove through the task list stops a task only while it waits: one that started as the person confirmed runs on', async (t) => {
  // The task list's Remove posts onlyIfWaiting, because its dialog said nothing had started yet.
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const row = async (jobId) => (await q.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === jobId)
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await until('the first task is running', () => row('jev-1'), (r) => r?.state === 'running', { timeoutMs: 20_000 })
  await q.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
  assert.equal((await row('jev-2')).state, 'queued')
  const running = await q.http('POST', '/jev-router/tasks/stop', { jobId: 'jev-1', onlyIfWaiting: true })
  assert.deepEqual([running.status, running.body], [200, { result: 'started' }])
  const waiting = await q.http('POST', '/jev-router/tasks/stop', { jobId: 'jev-2', onlyIfWaiting: true })
  assert.deepEqual([waiting.status, waiting.body], [200, { result: 'requested' }])
  await until('the waiting task is stopped', () => row('jev-2'), (r) => r?.state === 'stopped')
  release()
  // The agent reads its signal only as it returns, so a run stopped by Remove would end stopped here.
  const first = await until('the first task finished', () => row('jev-1'), (r) => r?.finishedAt, { timeoutMs: 30_000 })
  assert.equal(first.state, 'completed', 'the task that had started ran on to its end')
  assert.equal(q.ran.length, 1, 'the removed task never started an agent')
})

// ---------------------------------------------------------------- read-only work

/** Jev reads the next messages as only reading at `p`, routed as `capability`, until the test ends. */
function jevReads(t, { p = 0.93, capability = 'project_read' } = {}) {
  jev.said.readOnly = p
  jev.said.capability = capability
  t.after(() => { delete jev.said.readOnly; delete jev.said.capability })
}
const taskRow = async (q, jobId) => (await q.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === jobId)
const folderOf = (q) => q.workspace.split(/[\\/]/).filter(Boolean).at(-1)
/**
 * A Claude Code command-line tool of this test's own, first on the PATH until the test ends:
 * `claude auth status --json` says it is signed in. Claude's settings and usage are read from a
 * home of the test's own, so the person's own login and weekly usage never decide who runs, and
 * the effort a Claude start sets in the environment goes with the test.
 */
function claudeSignedIn(t, { loggedIn = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kz-laya-claude-'))
  cleanUp(t, home)
  writeFileSync(join(home, 'claude'), `#!/bin/sh\necho '{"loggedIn":${loggedIn},"authMethod":"claude.ai"}'\n`)
  chmodSync(join(home, 'claude'), 0o755)
  writeFileSync(join(home, 'claude.cmd'), `@echo {"loggedIn":${loggedIn},"authMethod":"claude.ai"}\r\n`)
  const saved = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EFFORT_LEVEL'].map((k) => [k, process.env[k]]))
  Object.assign(process.env, { PATH: `${home}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') })
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
}

test('a task Jev reads as only reading runs locked beside the task writing in its workspace, and the writer keeps its own diff', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t)
  const said = await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  assert.match(said.text, new RegExp(`^OK, I'll run \\*\\*[^*]+\\*\\* with \\*\\*[^*]+\\*\\*( \\(effort [^)]+\\))? in the background as \\*\\*jev-2\\*\\* in ${folderOf(q)}\\. Read only: Jev judged it only reads the project \\(93%, its bar is 80%\\), so it runs on an agent locked against writing, beside any task changing ${folderOf(q)}\\. I'll report back here when it's done\\. Keep chatting\\.\\n`), said.text)
  await waitFor('the reader\'s result is posted while the writer still works', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal(q.ran.length, 2)
  assert.deepEqual(q.ran[1].toolFilter, { allow: ['read', 'glob', 'grep'] }, 'the reader was started with the read tools only')
  assert.equal(q.ran[0].toolFilter?.allow, undefined, 'the writer was not')
  assert.match(q.ran[1].prompt, /This run is locked to reading/)
  assert.equal((await taskRow(q, 'jev-1')).state, 'running', 'the writer is still at work')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const rows = q.rows('history.jsonl')
  const reader = rows.find((r) => r.access?.mode === 'read')
  const writer = rows.find((r) => r !== reader)
  assert.ok(reader && writer, JSON.stringify(rows.map((r) => r.access ?? null)))
  assert.equal(reader.finalStatus, 'answered')
  assert.deepEqual(reader.attempts.map((a) => [a.changedFiles, a.locked]), [[[], true]])
  assert.deepEqual(reader.access.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  assert.deepEqual(writer.attempts[0].changedFiles, ['state.txt'], 'the writer\'s diff is its own')
  const readerRow = await taskRow(q, 'jev-2')
  assert.deepEqual([readerRow.access, readerRow.readVerdict?.p, readerRow.readVerdict?.bar], ['read', 0.93, 0.8])
})

test('a task Jev reads as only reading that Claude takes starts on its plan-mode row, and the writer beside it on the ordinary one', async (t) => {
  claudeSignedIn(t)
  // Claude alone, so both tasks are its and only the row each starts on tells them apart.
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const q = await plugin(t, { jobs: true, config: { agents: [claude] } })
  q.world.providers['claude-code-readonly'] = { config: { permissionMode: 'plan' } }
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the reader\'s result is posted while the writer still works', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.deepEqual(q.ran.map((r) => [r.provider, r.toolFilter]), [['claude-code', null], ['claude-code-readonly', null]], 'the writer on Claude Code, the reader on its plan-mode row')
  assert.equal(readFileSync(join(q.workspace, 'state.txt'), 'utf8'), 'broken', 'the reader changed nothing beside the writer')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const reader = q.rows('history.jsonl').find((r) => r.access?.mode === 'read')
  assert.deepEqual(reader?.access.lock, { claude: 'Claude Code plan mode' })
})

test('two Claude starts at once, a writer and a read pass beside it, each start at their own effort', async (t) => {
  claudeSignedIn(t)
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const q = await plugin(t, { jobs: true, config: { agents: [claude] } })
  q.world.providers['claude-code-readonly'] = { config: { permissionMode: 'plan' } }
  // The writer's start is held until the reader's start begins, or 3 s at most: had the effort
  // variable been set by the reader meanwhile, the writer would read the reader's.
  let readerStarting
  const reader = new Promise((r) => { readerStarting = r })
  q.world.beforeStart = async (n) => { if (n === 2) readerStarting(); if (n === 1) await Promise.race([reader, new Promise((r) => setTimeout(r, 3000))]) }
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto', effort: 'high' })
  await waitFor('the writer is starting', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto', effort: 'low' })
  await waitFor('the reader\'s result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  assert.deepEqual(q.ran.map((r) => [r.provider, r.effortEnv]), [['claude-code', 'high'], ['claude-code-readonly', 'low']])
})

test('a read task whose routing says it changes files waits for the writer, then runs once as a writer at the effort it was queued with', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t, { capability: 'project_change' })
  await q.say('Look at the parser and tidy it', { model: 'jev-auto', effort: 'low' })
  const back = await until('the read task is back in its folder\'s line', () => taskRow(q, 'jev-2'), (r) => r?.state === 'queued' && r.access === 'write' && !!r.accessWhy).catch(() => null)
  assert.ok(back, 'the read pass handed the task back to its folder\'s line')
  assert.match(back.accessWhy, /^Jev's routing named project_change \(\d+%\), which may change files$/)
  assert.equal(back.waiting?.why, 'workspace')
  assert.equal(back.effort, 'low')
  assert.equal(q.ran.length, 1, 'no agent ran for the read pass')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  assert.equal(q.ran.length, 2, 'it ran once, as a writer')
  assert.equal(q.ran[1].toolFilter?.allow, undefined)
  const row = q.rows('history.jsonl').find((r) => r.access?.from === 'read')
  assert.ok(row, 'the writer pass says it came from a read pass')
  assert.equal(row.access.mode, 'write')
  assert.match(row.access.why, /which may change files$/)
  assert.equal(q.rows('history.jsonl').length, 2, 'a read pass that ran no agent writes no row')
  assert.equal(row.attempts[0].effort, 'low', 'at the effort it was queued with')
})

test('a locked child that can still see a tool outside its allow list is stopped before it works, and its task goes to the folder\'s line', async (t) => {
  const q = await plugin(t, { jobs: true })
  q.world.childSees = (allow) => [...allow, 'write']
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal(q.ran.length, 2, 'the locked start, then the writer pass')
  assert.deepEqual(q.ran[0].toolFilter, { allow: ['read', 'glob', 'grep'] })
  assert.ok(q.world.disposed.includes(1), 'the locked child was stopped')
  assert.equal(q.ran[1].toolFilter?.allow, undefined)
  const [readPass, writer] = q.rows('history.jsonl')
  assert.equal(readPass.finalStatus, 'needs_write')
  assert.match(readPass.statusReason, /^deepseek could not be started locked: its child could still see write$/)
  assert.equal(readPass.attempts[0].notStarted, true)
  assert.equal(writer.access.from, 'read')
  assert.equal(writer.finalStatus.startsWith('accepted'), true, writer.finalStatus)
})

test('a locked child whose view cannot be read is stopped before it works, and its task goes to the folder\'s line', async (t) => {
  const q = await plugin(t, { jobs: true })
  q.world.childSees = () => { throw new Error('the registry is gone') }
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal(q.ran.length, 2, 'the locked start, then the writer pass')
  assert.deepEqual(q.ran[0].toolFilter, { allow: ['read', 'glob', 'grep'] })
  assert.ok(q.world.disposed.includes(1), 'the locked child was stopped')
  const [readPass, writer] = q.rows('history.jsonl')
  assert.equal(readPass.finalStatus, 'needs_write')
  assert.match(readPass.statusReason, /^deepseek could not be started locked: what its child can see could not be read$/)
  assert.equal(readPass.attempts[0].notStarted, true)
  assert.equal(writer.access.from, 'read')
})

test('a lock that stops holding after routing is read again as the agent starts, and that start is refused', async (t) => {
  const q = await plugin(t, { jobs: true })
  jevReads(t)
  // The routing found deepseek lockable; by its last call (the strategy) the spawn provider takes no
  // tool filter any more, so only the check at the start itself can see it.
  jev.said.strategy = () => { q.world.providers.spawn = { capabilities: { toolFilter: false } }; return undefined }
  t.after(() => { delete jev.said.strategy })
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal(q.ran.length, 1, 'nothing started locked, only the writer pass')
  assert.equal(q.ran[0].toolFilter?.allow, undefined)
  const [readPass, writer] = q.rows('history.jsonl')
  assert.equal(readPass.finalStatus, 'needs_write')
  assert.match(readPass.statusReason, /^deepseek could not be started locked: its provider takes no per-start tool filter$/)
  assert.deepEqual(readPass.attempts.map((a) => [!!a.locked, !!a.notStarted]), [[false, true]], 'it was never started')
  assert.equal(writer.access.from, 'read')
})

test('with no agent that can be locked, a task read as only reading is queued for its folder\'s line and the chat says why', async (t) => {
  const q = await plugin(t, { jobs: true })
  q.world.providers.spawn = { capabilities: { toolFilter: false } }
  jevReads(t)
  const said = await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  assert.match(said.text, new RegExp(`Read only: Jev judged it only reads the project \\(93%, its bar is 80%\\), but no agent here can be locked against writing \\(deepseek: its provider takes no per-start tool filter; kimi: its provider takes no per-start tool filter\\), so it runs as work that writes, and a task changing ${folderOf(q)} waits for it\\. I'll report back here when it's done\\. Keep chatting\\.\\n`), said.text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const row = await taskRow(q, 'jev-1')
  assert.deepEqual([row.access, row.readVerdict?.reads], ['write', true])
  assert.equal(q.ran[0].toolFilter?.allow, undefined, 'it ran as work that writes')
  const [record] = q.rows('history.jsonl')
  assert.deepEqual(record.access, { mode: 'write', verdict: { p: 0.93, bar: 0.8, by: 'jev', reads: true }, why: 'no agent here can be locked against writing (deepseek: its provider takes no per-start tool filter; kimi: its provider takes no per-start tool filter)' })
})

test('a parallel opinion whose own result is in is not taken to be stopped by a primary that breaks off while its process is ended', async (t) => {
  // Two agents of one tier, so the two answer side by side.
  const q = await plugin(t, { jobs: true, config: { agents: [AGENTS[0], { ...AGENTS[0], id: 'deepseek-b', name: 'DeepSeek B' }] } })
  jevReads(t)
  jev.said.strategy = 'PARALLEL_SECOND_OPINION'
  t.after(() => { delete jev.said.strategy })
  // The primary's agent fails outright while the opinion, which failed on its own, is being ended.
  q.world.work = async (_opts, n) => { if (n === 1) { await new Promise((r) => setTimeout(r, 150)); throw new Error('its process exited with code 1') } }
  q.world.outcome = (n) => (n === 2 ? { stopReason: 'error', diagnostic: 'HTTP 500 from the provider', output: [], usage: {} } : null)
  q.world.beforeDispose = async (n) => { if (n === 2) await new Promise((r) => setTimeout(r, 600)) }
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const [primary, opinion] = q.ran
  assert.ok(primary?.toolFilter?.allow && opinion?.toolFilter?.allow, 'both started locked')
  const read = q.rows('history.jsonl').find((r) => r.attempts?.some((a) => a.role === 'opinion'))
  const o = read?.attempts.find((a) => a.role === 'opinion')
  assert.deepEqual([o?.diagnostic, o?.cutOff], ['HTTP 500 from the provider', undefined], JSON.stringify(read?.attempts))
  // Both agents that can be locked tried it, so neither is asked again: the task goes to its line.
  assert.equal(q.ran.length, 3, JSON.stringify(q.ran.map((r) => [r.label, r.toolFilter])))
  assert.equal(q.ran[2].toolFilter?.allow, undefined, 'it then ran as work that writes')
})

test('a primary and its parallel opinion on DeepSeek keys both at their limit: only the key they ran on is spent, the next is switched to once for after a restart, and neither goes on within the run', async (t) => {
  // Two agents on DeepSeek's stored keys, k1 active as the harness started, k2 and k3 in reserve.
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\nKZ_KEY__deepseek__k2=sk-two\nKZ_KEY__deepseek__k3=sk-three\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before) })
  const on = (id) => ({ ...AGENTS[0], id, name: id })
  const q = await plugin(t, { jobs: true, config: { agents: [on('ds-a'), on('ds-b')] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }, { name: 'k2', active: false }, { name: 'k3', active: false }] } } })
  jevReads(t)
  jev.said.strategy = 'PARALLEL_SECOND_OPINION'
  t.after(() => { delete jev.said.strategy })
  // Both calls on k1 come back out of credit.
  q.world.outcome = (n) => (n <= 2 ? { stopReason: 'error', diagnostic: 'HTTP 402: insufficient balance', output: [], usage: {} } : null)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  const read = await waitFor('the read pass is on the record', () => q.rows('history.jsonl').find((r) => r.access?.mode === 'read'), (r) => !!r, { timeoutMs: 30_000 })
  assert.deepEqual(read.attempts.map((a) => [a.agent, a.role, a.limitHit]), [['ds-a', 'primary', true], ['ds-b', 'opinion', true]])
  assert.ok(!read.limits.some((l) => l.action === 'rotated'), JSON.stringify(read.limits))
  const state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  // Only the key is marked: it holds both agents out while their calls go out on it, and after a
  // restart onto k2 they are usable at once.
  assert.deepEqual(Object.keys(state.exhausted), ['deepseek:k1'], JSON.stringify(state.exhausted))
  // Switched once: to k2, not on past it to k3.
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k1', false], ['k2', true], ['k3', false]])
  // Each call's usage row names the key it ran on.
  const used = q.rows('usage.jsonl').filter((u) => u.runId && (u.agent === 'ds-a' || u.agent === 'ds-b')).slice(0, 2).map((u) => u.account)
  assert.deepEqual(used, ['k1', 'k1'])
})

test('an agent that falls below its own Stop below during an attempt marks no key and switches none: the key is judged by each agent\'s own floor', async (t) => {
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\nKZ_KEY__deepseek__k2=sk-two\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  // k1 holds 21 until the attempt spends it to 19, under this agent's floor of 20.
  let spentTo = 21
  net.deepseekBalance = (key) => (key === 'sk-one' ? spentTo : 50)
  const q = await plugin(t, { config: { agents: [{ ...AGENTS[0], id: 'ds-a', name: 'ds-a' }] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }, { name: 'k2', active: false }] }, limits: { 'ds-a': { minBalance: 20, handoffAtBalance: 22 } } } })
  q.world.work = async (_opts, n) => { if (n === 1) spentTo = 19 }
  await q.slash('auto', 'Fix the failing lint in the parser')
  const [row] = await waitFor('the run is on the record', () => q.rows('history.jsonl'), (rows) => rows.length >= 1, { timeoutMs: 30_000 })
  assert.equal(row.attempts[0].limitHit, true, JSON.stringify(row.attempts))
  const state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.exhausted ?? {}), [], 'nothing marked: the reading says it')
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k1', true], ['k2', false]])
})

test('a DeepSeek key added in Settings beside an active key under every agent\'s floor takes over for after a restart; beside one still over the lowest floor it waits in reserve', async (t) => {
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  let k1 = 10
  net.deepseekBalance = (key) => (key === 'sk-one' ? k1 : 50)
  const on = (id) => ({ ...AGENTS[0], id, name: id })
  const q = await plugin(t, { config: { agents: [on('pro'), on('flash')] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }] }, limits: { pro: { minBalance: 20, handoffAtBalance: 22 }, flash: { minBalance: 5, handoffAtBalance: 6 } } } })
  // At 10, k1 is under pro's floor and over flash's: its row stays usable.
  await q.http('GET', '/jev-router/usage?force=1')
  assert.equal((await q.http('POST', '/jev-router/keys', { provider: 'deepseek', name: 'k2', key: 'sk-two' })).body.restartRequired, false)
  let state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k1', true], ['k2', false]], 'flash still uses k1')
  // Under every floor: a key added now takes over.
  k1 = 3
  await q.http('GET', '/jev-router/usage?force=1')
  const added = await q.http('POST', '/jev-router/keys', { provider: 'deepseek', name: 'k3', key: 'sk-three' })
  assert.equal(added.body.restartRequired, true)
  state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k1', false], ['k2', false], ['k3', true]])
})

test('after one agent\'s attempt, a key still over another switched-on agent\'s floor is not taken for out: a key added beside it waits in reserve', async (t) => {
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  // pro's attempt spends k1 from 25 to 10: under pro's floor of 20, over flash's of 5. flash is on,
  // but held out for now, so pro does the work.
  let k1 = 25
  net.deepseekBalance = (key) => (key === 'sk-one' ? k1 : 50)
  const on = (id) => ({ ...AGENTS[0], id, name: id })
  const hour = new Date(Date.now() + 3_600_000).toISOString()
  const q = await plugin(t, { config: { agents: [on('pro'), on('flash')] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }] }, limits: { pro: { minBalance: 20, handoffAtBalance: 22 }, flash: { minBalance: 5, handoffAtBalance: 6 } }, exhausted: { flash: { until: hour, reason: 'held out by the test' } } } })
  q.world.work = async (_opts, n) => { if (n === 1) k1 = 10 }
  await q.slash('auto', 'Fix the failing lint in the parser')
  const [row] = await waitFor('the run is on the record', () => q.rows('history.jsonl'), (rows) => rows.length >= 1, { timeoutMs: 30_000 })
  assert.equal(row.attempts[0].agent, 'pro', 'the test needs pro to work first')
  // The balance check after pro's attempt left k1's row as the next routing and Settings read it.
  const added = await q.http('POST', '/jev-router/keys', { provider: 'deepseek', name: 'k2', key: 'sk-two' })
  assert.equal(added.status, 200)
  const state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k1', true], ['k2', false]], 'flash can still use k1')
})

test('removing the active DeepSeek key moves on to the next one usable by its reading, and Settings says to restart while that change waits for one, whatever other keys are then added', async (t) => {
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\nKZ_KEY__deepseek__k2=sk-two\nKZ_KEY__deepseek__k3=sk-three\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  // k2 is under the agent's floor of 5.
  net.deepseekBalance = (key) => (key === 'sk-two' ? 1 : 50)
  const q = await plugin(t, { config: { agents: [{ ...AGENTS[0], id: 'ds-a', name: 'ds-a' }] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }, { name: 'k2', active: false }, { name: 'k3', active: false }] }, limits: { 'ds-a': { minBalance: 5, handoffAtBalance: 6 } } } })
  assert.deepEqual((await q.http('GET', '/jev-router/usage?force=1')).body.keysRestartPending, [])
  assert.deepEqual((await q.http('GET', '/jev-router/setup')).body.keysRestartPending, [])
  assert.equal((await q.http('DELETE', '/jev-router/keys?provider=deepseek&name=k1')).status, 200)
  const state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k2', false], ['k3', true]])
  // Said on the setup page and on the reading Settings polls.
  assert.deepEqual((await q.http('GET', '/jev-router/setup')).body.keysRestartPending, ['deepseek'])
  assert.deepEqual((await q.http('GET', '/jev-router/usage')).body.keysRestartPending, ['deepseek'])
  // A Jev key added and chosen meanwhile changes nothing of that, and is the Jev key in use at once.
  assert.equal((await q.http('POST', '/jev-router/keys', { provider: 'jev', name: 'j2', key: 'ts-two' })).status, 200)
  assert.equal((await q.http('POST', '/jev-router/keys/activate', { provider: 'jev', name: 'j2' })).status, 200)
  assert.deepEqual((await q.http('GET', '/jev-router/setup')).body.keysRestartPending, ['deepseek'])
  assert.equal((await q.http('GET', '/jev-router/setup')).body.jev.activeKey, 'j2')
  assert.equal((await q.http('GET', '/jev-router/usage')).body.jevActiveKey, 'j2')
})

test('a stored Jev key whose value is gone from .env is not named as the Jev key in use, on Settings or the Usage tab', async (t) => {
  const q = await plugin(t, { accounts: { keys: { jev: [{ name: 'ghost', active: true }] } } })
  const setup = (await q.http('GET', '/jev-router/setup')).body
  assert.equal(setup.jev.activeKey, null, 'Jev falls back to its credential for it, as its calls do')
  assert.equal(setup.jev.credentialSet, true)
  const usage = (await q.http('GET', '/jev-router/usage')).body
  assert.deepEqual([usage.jevActiveKey, usage.jevCredentialSet], [null, true])
  assert.equal(usage.agents.find((a) => a.id === 'jev').account.label, 'default', 'the Usage tab names the credential Jev calls on')
})

test('a limit on the launch key\'s call does not switch away from another key the person added under its name and chose meanwhile', async (t) => {
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\nKZ_KEY__deepseek__k2=sk-two\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before) })
  const q = await plugin(t, { config: { agents: [{ ...AGENTS[0], id: 'ds-a', name: 'ds-a' }] }, accounts: { keys: { deepseek: [{ name: 'k1', active: true }, { name: 'k2', active: false }] } } })
  // While the call on k1 runs, the person replaces k1 with a new key of that name and makes it active.
  q.world.work = async (_opts, n) => {
    if (n !== 1) return
    assert.equal((await q.http('DELETE', '/jev-router/keys?provider=deepseek&name=k1')).status, 200)
    assert.equal((await q.http('POST', '/jev-router/keys', { provider: 'deepseek', name: 'k1', key: 'sk-new' })).status, 200)
    assert.equal((await q.http('POST', '/jev-router/keys/activate', { provider: 'deepseek', name: 'k1' })).status, 200)
  }
  q.world.outcome = (n) => (n === 1 ? { stopReason: 'error', diagnostic: 'HTTP 402: insufficient balance', output: [], usage: {} } : null)
  await q.slash('auto', 'Fix the failing lint in the parser')
  await waitFor('the run is on the record', () => q.rows('history.jsonl'), (rows) => rows.length >= 1, { timeoutMs: 30_000 })
  const state = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual(state.keys.deepseek.map((k) => [k.name, k.active]), [['k2', false], ['k1', true]], 'the person\'s choice stands')
  assert.equal(state.exhausted['deepseek:k1'], undefined, 'the new k1 made no call')
})

test('an agent switched off, or not the one asked for, is no lock at intake: the task waits for its folder as work that writes', async (t) => {
  // Claude could be locked (its plan-mode row is here) but is switched off; the others cannot be.
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: false }
  const q = await plugin(t, { jobs: true, config: { agents: [...AGENTS, claude] } })
  q.world.providers['claude-code-readonly'] = { config: { permissionMode: 'plan' } }
  q.world.providers.spawn = { capabilities: { toolFilter: false } }
  jevReads(t)
  const said = await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  assert.match(said.text, /but no agent here can be locked against writing \(deepseek: its provider takes no per-start tool filter; kimi: its provider takes no per-start tool filter\), so it runs as work that writes/, said.text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal((await taskRow(q, 'jev-1')).access, 'write')
  assert.equal(q.rows('history.jsonl').length, 1, 'no read pass ran, only the work itself')
})

test('an agent signed out is no lock at intake either: the task runs as work that writes and no read pass is tried', async (t) => {
  // Claude could be locked (its plan-mode row is here) and is switched on, but signed out.
  claudeSignedIn(t, { loggedIn: false })
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const q = await plugin(t, { jobs: true, config: { agents: [...AGENTS, claude] } })
  q.world.providers['claude-code-readonly'] = { config: { permissionMode: 'plan' } }
  q.world.providers.spawn = { capabilities: { toolFilter: false } }
  jevReads(t)
  const said = await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  // The one agent that could have been locked is named, with why it cannot be.
  assert.match(said.text, /but no agent here can be locked against writing \(deepseek: its provider takes no per-start tool filter; kimi: its provider takes no per-start tool filter; claude: not signed in\), so it runs as work that writes/, said.text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal((await taskRow(q, 'jev-1')).access, 'write')
  assert.equal(q.rows('history.jsonl').length, 1, 'no read pass ran, only the work itself')
})

test('a lock breach is warned about, and that agent takes no more read-only work until restart; Jev setup says so', async (t) => {
  const q = await plugin(t, { jobs: true })
  // The locked run's files change although nothing writes the folder: the lock did not hold.
  q.world.work = async (opts) => { if (opts.toolFilter?.allow) writeFileSync(join(q.workspace, 'breach.txt'), 'x') }
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const [record] = q.rows('history.jsonl')
  const who = record.attempts[0].agent
  assert.equal(record.access?.mode, 'read', 'the task ran as a read pass')
  assert.deepEqual(record.access.lockCheck, { measured: true, changed: ['breach.txt'] })
  assert.match(JSON.stringify(q.world.delivered[0]), new RegExp(`Warning: breach\\.txt changed in this repository while this locked run was reading and no other run was going on in it\\. Either you edited it, or the lock on ${who} did not hold; ${who} takes no read-only work until the harness restarts\\.`))
  const setup = (await q.http('GET', '/jev-router/setup')).body
  const agent = setup.agents.find((a) => a.id === who)
  assert.equal(agent.readOnly.how, null)
  assert.match(agent.readOnly.why, /^files changed while it ran locked at \d\d:\d\d UTC \(breach\.txt\), so its lock is not trusted until the harness restarts$/)
  const other = setup.agents.find((a) => a.id !== who)
  assert.deepEqual(other.readOnly, { how: 'read tools only, checked as each run starts', why: null })
})

test('two read passes in one folder at once: a change during them is pinned on neither, and neither agent is distrusted', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (opts, n) => {
    // The first reader's lock does not hold; the second reader is only beside it.
    if (n === 1) writeFileSync(join(q.workspace, 'breach.txt'), 'x')
    await blocked
  }
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await q.say('How does the lexer find a keyword', { model: 'jev-auto' })
  const together = await waitFor('both read passes are working', () => q.ran.length, (n) => n === 2, { timeoutMs: 20_000 }).then(() => true, () => false)
  release()
  assert.ok(together, 'the two read passes ran at the same time')
  assert.ok(q.ran.every((r) => r.toolFilter?.allow), 'both ran locked')
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const rows = q.rows('history.jsonl')
  assert.equal(rows.length, 2)
  for (const r of rows) assert.deepEqual(r.access?.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  const setup = (await q.http('GET', '/jev-router/setup')).body
  assert.deepEqual(setup.agents.map((a) => a.readOnly.how), ['read tools only, checked as each run starts', 'read tools only, checked as each run starts'], 'nobody is distrusted for a change nobody can pin')
})

test('a read pass that outlasts the writer it started beside: the writer\'s change is not pinned on the reader\'s agent, and nobody is distrusted', async (t) => {
  const q = await plugin(t, { jobs: true })
  let releaseWriter
  let releaseReader
  const writing = new Promise((r) => { releaseWriter = r })
  const reading = new Promise((r) => { releaseReader = r })
  q.world.work = async (_opts, n) => { await (n === 1 ? writing : reading) }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the reader is working beside it', () => q.ran.length, (n) => n === 2, { timeoutMs: 20_000 })
  // The writer changes state.txt and is gone before the reader's check: only the run that was going
  // at the reader's start tells its change apart from a lock that did not hold.
  releaseWriter()
  await waitFor('the writer\'s result is posted while the reader still works', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal((await taskRow(q, 'jev-2')).state, 'running', 'the reader is still at work')
  releaseReader()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const rows = q.rows('history.jsonl')
  const reader = rows.find((r) => r.access?.mode === 'read')
  const writer = rows.find((r) => r !== reader)
  assert.deepEqual(writer?.attempts[0].changedFiles, ['state.txt'], 'the writer changed a file while the reader worked')
  assert.deepEqual(reader?.access.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  const setup = (await q.http('GET', '/jev-router/setup')).body
  assert.deepEqual(setup.agents.map((a) => a.readOnly.how), ['read tools only, checked as each run starts', 'read tools only, checked as each run starts'], 'nobody is distrusted for the writer\'s change')
  // What the runs write after they reply (Laya's standing) lands before the plugin is closed.
  await quiet(q.dataDir)
})

test('a writer that starts and ends while a read pass works: its change is not pinned on the reader\'s agent, and nobody is distrusted', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the reader is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  // Nothing else was going at the reader's start and nothing is at its check: only the run that
  // started since tells the writer's change to state.txt apart from a lock that did not hold.
  jevReads(t, { p: 0.05, capability: 'project_change' })
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer\'s result is posted while the reader still works', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal((await taskRow(q, 'jev-1')).state, 'running', 'the reader is still at work')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const rows = q.rows('history.jsonl')
  const reader = rows.find((r) => r.access?.mode === 'read')
  const writer = rows.find((r) => r !== reader)
  assert.deepEqual(writer?.attempts[0].changedFiles, ['state.txt'], 'the writer changed a file while the reader worked')
  assert.deepEqual(reader?.access.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  const setup = (await q.http('GET', '/jev-router/setup')).body
  assert.deepEqual(setup.agents.map((a) => a.readOnly.how), ['read tools only, checked as each run starts', 'read tools only, checked as each run starts'], 'nobody is distrusted for the writer\'s change')
  // What the runs write after they reply (Laya's standing) lands before the plugin is closed.
  await quiet(q.dataDir)
})

test('a writer at the root and a read pass in another folder of the same repository: the writer\'s change is not pinned on the reader, and no agent is distrusted', async (t) => {
  const q = await plugin(t, { jobs: true })
  // This chat is opened in docs, a folder of the repository, and a second chat at its root writes.
  const docs = join(q.workspace, 'docs')
  mkdirSync(docs)
  q.agent.session.header.cwd = docs
  const atRoot = { id: 'session-2', session: { id: 'session-2', header: { cwd: q.workspace } } }
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => {
    // The writer writes state.txt only once the reader is at work, and the reader reads on until it has.
    if (n === 1) await blocked
    if (n === 2) { release(); await waitFor('the writer has written state.txt', () => readFileSync(join(q.workspace, 'state.txt'), 'utf8'), (s) => s === 'fixed', { timeoutMs: 20_000 }) }
  }
  const fg = q.commands.get('auto').handler({ agent: atRoot, rawInput: 'Fix the failing test in the parser', signal: new AbortController().signal })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t)
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  // The reader's result first: a reader that never started would leave the writer blocked for good.
  await waitFor('the reader\'s result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match((await fg).text, /Final status: ACCEPTED/)
  assert.deepEqual(q.ran[1].toolFilter, { allow: ['read', 'glob', 'grep'] }, 'the reader was started with the read tools only')
  const rows = q.rows('history.jsonl')
  const reader = rows.find((r) => r.access?.mode === 'read')
  const writer = rows.find((r) => r !== reader)
  assert.deepEqual([writer?.workspace, reader?.workspace], [q.workspace, docs], 'the writer ran at the root and the reader in docs')
  assert.deepEqual(reader.attempts.map((a) => [a.locked, a.stopReason]), [[true, 'completed']], 'one locked attempt, which read on until the writer had changed state.txt')
  assert.deepEqual(reader.access.lockCheck, { measured: false, reason: 'another run was going on in this repository at the same time' })
  const setup = (await q.http('GET', '/jev-router/setup')).body
  assert.deepEqual(setup.agents.map((a) => a.readOnly.how), ['read tools only, checked as each run starts', 'read tools only, checked as each run starts'], 'no agent is distrusted for the writer\'s change')
})

// ---------------------------------------------------------------- Jev Auto and the shadow

test('a Jev Auto run with the shadow: Laya answers the same calls beside Jev, Jev\'s calls are byte-identical to a run without it, and nothing else of it shows', async (t) => {
  const withShadow = await plugin(t, { settings: { shadow: true } })
  await started(withShadow)
  const jevFrom = jev.calls.length
  const on = await withShadow.say('Fix the failing test in the parser', { model: 'jev-auto' })
  const sentOn = jev.calls.slice(jevFrom).map((c) => c.body)
  assert.match(on.text, /^\*\*Jev router\*\* · AUTO/)
  assert.match(on.reasoning, /\nLaya is answering the same questions in the background; compare them in Jev → Decisions\n/)
  assert.equal(on.reasoning.match(/Laya/g).length, 1, 'nothing else about the shadow reaches the live lines')
  await quiet(withShadow.dataDir)
  const [record] = withShadow.rows('history.jsonl')
  const { body: shadow } = await withShadow.http('GET', `/jev-router/laya/shadow?runId=${record.runId}`)
  assert.ok(shadow.rows.length >= 2, 'a row for every Jev call of the run')
  assert.ok(shadow.rows.every((r) => r.runId === record.runId && r.status === 'answered'), JSON.stringify(shadow.rows.map((r) => [r.status, r.reason])))
  assert.ok(shadow.rows.some((r) => r.phase === 'review' && r.actions?.laya))
  const { body: log } = await withShadow.http('GET', `/jev-router/log?session=${SESSION}`)
  assert.ok(log.at(-1).events.some((e) => e.type === 'shadow'), 'each row also reaches the run\'s inspector log')
  assert.ok(withShadow.rows('usage.jsonl').every((u) => u.agent !== 'laya'), 'a shadow call is never a usage row')

  // The same run with the card's switch off.
  const without = await plugin(t, { settings: { shadow: false } })
  await started(without)
  const from = jev.calls.length
  const off = await without.say('Fix the failing test in the parser', { model: 'jev-auto' })
  const sentOff = jev.calls.slice(from).map((c) => c.body)
  assert.doesNotMatch(off.reasoning, /Laya/)
  assert.deepEqual(sentOn, sentOff, 'Jev is sent the same bytes with the shadow on and off')
  await quiet(without.dataDir)
  assert.equal(without.read('laya-shadow.jsonl'), '')

  // On, with Laya not running: the run says it is not compared, and the shadow never starts Laya.
  const stopped = await plugin(t)
  const said = await stopped.say('Fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(said.reasoning, /\nLaya is not running, so this run is not compared\n/)
  assert.equal(stopped.world.spawned.length, 0)
})

test('a Jev Auto run replies without waiting for the shadow: with Laya at 20 s a question, the reply comes before Laya has answered any of its calls', async (t) => {
  const p = await plugin(t, { settings: { shadow: true } })
  await started(p)
  // Laya, loaded and ready, now takes 20 s a question, so even the intent's three take it a
  // minute: a run that waited for any comparison would reply no sooner than that (5.2). At 3 s a
  // question the run itself, slowed by a full suite running beside it, could outlast Laya's first
  // answer and fail a test that is about waiting, not speed.
  const MS_PER_ROW = 20_000
  const fake = p.world.fakes.at(-1)
  fake.setMsPerRow(MS_PER_ROW)
  const t0 = Date.now()
  const out = await p.say('Fix the failing test in the parser', { model: 'jev-auto' })
  const took = Date.now() - t0
  assert.match(out.text, /^\*\*Jev router\*\* · AUTO/, out.text)
  assert.match(out.reasoning, /\nLaya is answering the same questions in the background; /, 'the setting: the run is shadowed')
  const [record] = p.rows('history.jsonl')
  const { body: shadow } = await p.http('GET', `/jev-router/laya/shadow?runId=${record.runId}`)
  assert.deepEqual(shadow.rows, [], 'no comparison of the run had landed when it replied')
  const phases = shadow.waiting.map((w) => w.phase)
  assert.ok(phases.includes('route') && phases.includes('review'), `its route and review calls still wait for Laya: ${JSON.stringify(shadow.waiting)}`)
  const asked = fake.requests.filter((r) => r.arrivedAt >= t0)
  assert.ok(asked.length >= 1, 'Laya was being asked meanwhile')
  assert.ok(asked.every((r) => r.finishedAt == null), 'and had answered nothing when the run replied')
  assert.ok(took < 3 * MS_PER_ROW, `the run replied in ${took} ms, before Laya could answer even the intent's three questions`)
  // What the run writes after it replies (its learning) lands before the plugin is closed.
  await quiet(p.dataDir)
})

test('every line of a run\'s step reaches the server log under [jev], a step of several lines included, so the app files each one as the router\'s', async (t) => {
  const p = await plugin(t, { settings: { shadow: true } })
  await started(p)
  // The server log as the Kz-harness app reads it: the plugin's writes, split into lines, each
  // filed as a router line only by its own `[jev] ` prefix (app/main.js levelOf).
  const written = []
  const write = process.stdout.write
  process.stdout.write = function capture(chunk, ...rest) {
    if (String(chunk).startsWith('[jev] ')) { written.push(String(chunk)); return true }
    return write.call(this, chunk, ...rest)
  }
  let out
  try { out = await p.say('Fix the failing test in the parser', { model: 'jev-auto' }) } finally { process.stdout.write = write }
  const note = 'Laya is answering the same questions in the background; compare them in Jev → Decisions'
  assert.match(out.reasoning, new RegExp(`\\nRouted to \\w+ \\(jev\\)[^\\n]*\\n${note}\\n`), 'the setting: the routed step carries the shadow\'s note on a second line')
  const lines = written.join('').split('\n').slice(0, -1)
  assert.ok(lines.some((l) => /^\[jev\] Routed to \w+ \(jev\)/.test(l)), lines.join('\n'))
  assert.ok(lines.includes(`[jev] ${note}`), `the note is a router line of its own:\n${lines.join('\n')}`)
  for (const l of lines) assert.match(l, /^\[jev\] /, 'no line of a step reaches the log without the prefix')
})

test('one run id: usage.jsonl, history.jsonl, the shadow\'s rows, the inspector\'s entry and Stop all name the run alike', async (t) => {
  const p = await plugin(t)
  await started(p)
  let stopHere
  const reached = new Promise((r) => { stopHere = r })
  p.world.work = (opts) => { stopHere(); return opts.signal.aborted ? null : new Promise((r) => opts.signal.addEventListener('abort', r, { once: true })) }
  const running = p.slash('auto', 'Fix the failing test in the parser')
  await reached
  const { body: log } = await p.http('GET', `/jev-router/log?session=${SESSION}`)
  const id = log.at(-1).id
  assert.deepEqual((await p.http('POST', '/jev-router/runs/stop', { runId: id })).body, { ok: true })
  const r = await running
  assert.equal(r.kind, 'error')
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  assert.equal(record.runId, id)
  assert.equal(record.finalStatus, 'stopped')
  const jevRows = p.rows('usage.jsonl').filter((u) => u.agent === 'jev')
  assert.ok(jevRows.length && jevRows.every((u) => u.runId === id))
  const { body: shadow } = await p.http('GET', `/jev-router/laya/shadow?runId=${id}`)
  assert.ok(shadow.rows.length > 0)
  assert.ok(p.rows('laya-shadow.jsonl').every((row) => row.runId === id))
})

test('a background task is known by its key: acknowledged while it runs it stays unread, its result posts once and is read under its name in its own chat, and its history row and the inspector\'s entry name it', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  const row = async () => (await q.http('GET', '/jev-router/tasks')).body.tasks.find((x) => x.jobId === 'jev-1')
  const running = await until('the task is running', row, (r) => r?.state === 'running' && q.ran.length === 1, { timeoutMs: 20_000 })
  assert.match(String(running.key), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // What a page showing the chat `sessionId` posts for a row naming jev-1 and this task.
  const seen = async (sessionId) => (await q.http('POST', '/jev-router/tasks/seen', { sessionId, results: [{ jobId: 'jev-1', name: running.taskName }] })).body
  // A page acknowledging jev-1 while it runs, as an older task's notice under a reused id would.
  assert.deepEqual(await seen(SESSION), { acknowledged: [] })
  assert.equal((await row()).deliveryState, 'pending', 'nothing is marked read before it has a result')
  const { body: log } = await q.http('GET', `/jev-router/log?session=${SESSION}`)
  assert.deepEqual(log.filter((e) => e.jobId === 'jev-1').map((e) => e.taskKey), [running.key], 'the inspector names the task its pass is of')
  release()
  const [msg] = await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.equal(msg.source.summary, `jev-1 · ${running.taskName} · Completed`)
  // Posted in the chat it was sent from: a page showing another chat marks nothing read, and one showing this chat does.
  assert.deepEqual(await seen('session-2'), { acknowledged: [] })
  assert.deepEqual(await seen(SESSION), { acknowledged: ['jev-1'] })
  const [record] = await until('the run is in the history', () => q.rows('history.jsonl'), (r) => r.length === 1)
  assert.equal(record.taskKey, running.key, 'the history row is the task\'s by its key')
  await quiet(q.dataDir)
  assert.equal(q.world.delivered.length, 1, 'and the result posted once')
})

// ---------------------------------------------------------------- holding Laya, and learning integrity

test('an open Laya Auto run holds Laya: with idleMinutes 1 and an agent that works for 2 minutes, the review is Laya\'s, not the fallback\'s', async (t) => {
  const p = await plugin(t, { settings: { idleMinutes: 1 }, supervisor: { timing: { minuteMs: 100 } } })
  p.world.work = () => tick(350)
  const out = await p.slash('laya', 'Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\*/, out.text)
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  const review = record.assessments[0]
  assert.equal(review.mode, 'laya', 'the review was Laya\'s')
  assert.doesNotMatch(review.why, /fallback/)
  assert.equal(p.world.spawned.length, 1, 'Laya was never idle-stopped and started again during the run')
  // Let go once the run returned, it goes after its idle time.
  await until('Laya is stopped for being idle', () => laya(p), (s) => s.stoppedBecause === 'idle')
})

test('invariants 1 and 4: a Laya Auto run and its learning leave the Jev store and every domain state file byte-identical, and the Jev evaluation pass does not run after it', async (t) => {
  // A Jev Auto run first, so the Jev store and the domain states are on disk.
  const a = await plugin(t)
  await a.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await quiet(a.dataDir)
  await a.close()
  const domains = join(a.dataDir, 'domains')
  assert.ok(readdirSync(domains).some((f) => f.endsWith('.state.json')), 'the evaluation pass after a Jev run saved the domain states')

  // Next session, on the same files: its evaluation pass has not run yet, so were it to run after
  // the Laya run it would stamp every state.
  const b = await plugin(t, { dataDir: a.dataDir, harnessDir: a.harnessDir })
  const jevStore = b.read('routing-samples.jsonl')
  const states = bytesUnder(domains)
  const out = await b.say('Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\*/)
  await quiet(b.dataDir)
  assert.equal(b.read('routing-samples.jsonl'), jevStore, 'invariant 1: nothing appended to routing-samples.jsonl')
  assert.deepEqual(bytesUnder(domains), states, 'invariant 4: no domain state or artifact changed on Laya\'s account')
  assert.ok(b.rows('laya-samples.jsonl').length > 0, 'the run\'s samples went to Laya\'s store')
  // The same session's next Jev Auto run does evaluate, and that changes the states: so the Laya
  // run's leaving them alone is its own doing.
  await b.say('Fix the failing lint in the parser', { model: 'jev-auto' })
  await quiet(b.dataDir)
  assert.notDeepEqual(bytesUnder(domains), states)
})

test('a Laya review sample\'s outcome lands in laya-samples.jsonl, and invariant 9: a verdict on a Laya-decided run relabels in the Laya store only', async (t) => {
  const p = await plugin(t)
  // The first attempt's answer is judged not to address the task (retry), the second passes; the
  // disposition Laya gave for the first, PASS, is then contradicted by what followed.
  p.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : 'SECOND-TRY: fixed the parser')
  p.world.said.addressed = (state) => (JSON.stringify(state).includes('FIRST-TRY') ? 0.05 : 0.95)
  const out = await p.slash('laya', 'Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\*/, out.text)
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  assert.deepEqual(record.assessments.map((a) => a.action), ['retry', 'accept'])
  const rows = p.rows('laya-samples.jsonl')
  const review = rows.find((r) => r.domain === 'outcome_disposition' && r.extra?.decidedAt === 0)
  assert.ok(review, 'the first review\'s sample is in Laya\'s store')
  const outcome = rows.filter((r) => r.id === review.id && r.outcome).at(-1)?.outcome
  assert.equal(outcome?.labelSource, 'verified_outcome', JSON.stringify(rows.filter((r) => r.id === review.id)))
  assert.equal(outcome.negativeLabel, 'PASS')
  assert.equal(p.read('routing-samples.jsonl'), '')

  // A person says Laya misread the question: the label lands in Laya's store, never Jev's.
  const task = rows.find((r) => r.domain === 'task_classification' && r.runId === record.runId)
  const verdict = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'answer-1', verdict: 'dislike', tag: 'misread my question', runId: record.runId })
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body))
  await quiet(p.dataDir)
  const relabelled = p.rows('laya-samples.jsonl').filter((r) => r.id === task.id && r.outcome).at(-1)?.outcome
  assert.equal(relabelled?.labelSource, 'human')
  assert.equal(relabelled.negativeLabel, task.provider.label)
  assert.equal(p.read('routing-samples.jsonl'), '', 'invariant 9: the Jev store is untouched')
})

test('a Laya Auto run is read under the identity that decided it: its samples name Laya\'s identity and script, and the comparison and the standing count the run and a person\'s word on it', async (t) => {
  const p = await plugin(t)
  const out = await p.say('Fix the failing test in the parser')
  assert.match(out.text, /^\*\*Laya router\*\*/, out.text)
  await quiet(p.dataDir)
  const [record] = p.rows('history.jsonl')
  const { body: log } = await p.http('GET', `/jev-router/log?session=${SESSION}`)
  const identity = log.at(-1).events.find((e) => e.type === 'jev' && e.trace.phase === 'route')?.trace.meta?.identity
  assert.equal(identity?.split('|')[2], COMMIT.slice(0, 12), 'the setting: the route call\'s trace names the identity that answered')
  // Every sample Laya decided names that identity and the script of what it read, the review's too.
  const decided = p.rows('laya-samples.jsonl').filter((r) => r.domain && r.authority === 'laya')
  assert.deepEqual([...new Set(decided.map((s) => s.domain))].sort(), ['execution_strategy', 'outcome_disposition', 'second_opinion', 'skill_selection', 'task_classification'])
  for (const s of decided) assert.deepEqual([s.provider.identity, s.provider.lang], [identity, 'latin'], s.domain)
  // The standing recorded after the run counts it under the current identity.
  const recorded = p.rows('laya-standing.jsonl').find((r) => r.domain === 'task_classification')
  assert.equal(recorded?.identity, identity)
  assert.deepEqual(recorded.laya.layaAutoFailed, { runs: 1, failed: null }, 'laya-standing.jsonl counts the Laya Auto run, whose task type no outcome can fault')
  // A person says the pick was good: the comparison the card asks for reads it as said of Laya.
  const said = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'answer-1', verdict: 'like', tag: 'good pick', runId: record.runId })
  assert.equal(said.status, 200, JSON.stringify(said.body))
  await quiet(p.dataDir)
  const compare = (await p.http('GET', '/jev-router/laya/compare?days=7&identity=current')).body
  assert.equal(compare.identity, identity)
  const task = compare.domains.find((d) => d.domain === 'task_classification')
  assert.deepEqual(task.layaAutoRuns, { runs: 1, failed: null }, 'the side-by-side card counts the Laya Auto run')
  const standing = compare.standing.find((s) => s.domain === 'task_classification')
  assert.deepEqual(standing.laya.personSaid, { n: 1, right: 1 }, 'and the person\'s word on it')
  assert.deepEqual(standing.laya.layaAutoFailed, { runs: 1, failed: null })
})

test('invariant 7: "Saved by Jev" and Jev\'s spend are unchanged by Laya\'s usage rows, a Laya Auto direct answer, and a Laya Auto run that ran a tool with a limited agent skipped', async (t) => {
  const tools = [{ id: 'fixer', description: 'Writes fixed into state.txt and nothing else', command: "node -e \"require('fs').writeFileSync('state.txt','fixed')\"", params: {}, enabled: true }]
  // kimi is out of its allowance, so every run skips it.
  const p = await plugin(t, { config: { tools }, accounts: { exhausted: { kimi: { until: new Date(Date.now() + 86_400_000).toISOString(), reason: 'HTTP 429' } } } })
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  await p.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await p.say('What is a monad?', { model: 'jev-auto' })
  await quiet(p.dataDir)
  const savings = async () => { const r = await p.http('GET', '/jev-router/usage'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.savings.periods.all }
  const jevSpend = () => p.rows('usage.jsonl').filter((u) => u.agent === 'jev').reduce((s, u) => s + u.costUsd, 0)
  const before = await savings()
  const spent = jevSpend()
  assert.ok(before.decisions > 0 && before.directAnswers === 1 && before.limitsAvoided > 0, JSON.stringify(before))

  await started(p)
  await p.say('What is a monad?')
  Object.assign(p.world.said, { handler: 'fixer', 'fixer.fits': 0.95, capability: 'other' })
  const tool = await p.say('Write fixed into state.txt')
  assert.match(tool.reasoning, /Routed to tool fixer/, tool.reasoning)
  await quiet(p.dataDir)
  const record = p.rows('history.jsonl').at(-1)
  assert.equal(record.routing.decider, 'laya')
  assert.deepEqual(record.attempts.filter((a) => a.role !== 'review').map((a) => a.role), ['tool'])
  assert.ok(record.finalStatus.startsWith('accepted'))
  assert.deepEqual(record.availability.out.map((o) => o.id), ['kimi'])

  const after = await savings()
  const { layaDecisions, layaTokens, ...jevFigures } = after
  const { layaDecisions: none, layaTokens: _t, ...jevBefore } = before
  assert.deepEqual(jevFigures, jevBefore, 'every figure of "Saved by Jev" is as it was')
  assert.ok(layaDecisions > none, 'Laya\'s decisions are counted apart')
  assert.equal(jevSpend(), spent, 'Jev\'s monthly spend is as it was')
  assert.ok(p.rows('usage.jsonl').filter((u) => u.agent === 'laya').every((u) => u.costUsd === 0))
})

// ---------------------------------------------------------------- start-up, privacy and the routes

test('the orphan sweep runs first in apply(): a Laya an earlier session left running is stopped before Laya is started with KzH', async (t) => {
  const order = []
  // A process that has exited: its pid is free, and the sweep is told it is alive and running laya.serve.
  const gone = nodeSpawn(process.execPath, ['-e', ''])
  await new Promise((r) => gone.once('exit', r))
  const root = mkdtempSync(join(tmpdir(), 'kz-laya-orphan-'))
  cleanUp(t, root)
  const dataDir = join(root, 'data')
  const harnessDir = join(root, 'harness')
  const paths = await installLaya(harnessDir, dataDir)
  mkdirSync(dirname(paths.sidecarJson), { recursive: true })
  writeFileSync(paths.sidecarJson, JSON.stringify({ pid: gone.pid, interpreterPid: gone.pid, port: 8091, startedAt: 'earlier' }))
  const venvPython = paths.pythonOf(paths.venv)
  const p = await plugin(t, {
    dataDir, harnessDir, settings: { startWithKzh: true },
    onSpawn: () => order.push('start'),
    supervisor: {
      isAlive: (pid) => pid === gone.pid && !order.includes(`kill ${pid}`),
      // Both ways of asking, because the platform decides which is used: `ps` on Linux, and
      // PowerShell's Get-CimInstance on Windows, which answers `exe|command line` on one line.
      // Stubbing only the first left the orphan unrecognised here and the sweep untested.
      run: async (cmd, args) => {
        const line = `${venvPython} -I -u -X utf8 -m laya.serve`
        if (cmd === 'ps' && args.includes(String(gone.pid))) return `${line}\n`
        if (/powershell/i.test(cmd) && args.some((a) => String(a).includes(`ProcessId=${gone.pid}`))) return `${venvPython}|${line}\n`
        return null
      },
      // The orphan is only noted; this session's own laya.serve is stopped for real.
      killTree: (pid) => {
        order.push(`kill ${pid}`)
        if (pid !== gone.pid) { try { process.kill(pid, 'SIGKILL') } catch { /* gone already */ } }
        return true
      },
    },
  })
  // Until it has started, or what came of it by then: the order is the assertion.
  await until('Laya started with KzH', async () => p.world.spawned.length, (n) => n === 1).catch(() => {})
  assert.deepEqual(order, [`kill ${gone.pid}`, 'start'], 'the orphan was stopped before the start')
  const status = await until('started with KzH, before any message', () => laya(p), (s) => s.state === 'ready')
  assert.equal(status.orphanStopped.pid, gone.pid)
})

test('a plugin disposed while its startup sweep runs never starts Laya afterwards: not to start it with KzH, not for a message that waited for the sweep', async (t) => {
  // An earlier session's laya.serve for the sweep to look at, under a pid another program has taken
  // since (it reads as that program, so the sweep settles the record and removes it), whose look
  // waits until the test lets it go: the plugin is disposed in between, as a reload or a quit during
  // a slow sweep does (on Windows it asks PowerShell about each recorded pid).
  const EARLIER = 4_999_999
  async function sweeping(settings) {
    const root = mkdtempSync(join(tmpdir(), 'kz-laya-dispose-'))
    cleanUp(t, root)
    const dataDir = join(root, 'data')
    const harnessDir = join(root, 'harness')
    const paths = await installLaya(harnessDir, dataDir)
    mkdirSync(dirname(paths.sidecarJson), { recursive: true })
    writeFileSync(paths.sidecarJson, JSON.stringify({ pid: EARLIER, interpreterPid: EARLIER, port: 8091, startedAt: 'earlier' }))
    const gate = { reached: false, closed: false }
    const held = new Promise((r) => { gate.letGo = r })
    const p = await plugin(t, {
      dataDir, harnessDir, settings,
      // A laya.serve started for a plugin that is gone would outlive it, so none is let run here.
      onSpawn: () => { if (gate.closed) throw new Error('started after the plugin was disposed') },
      supervisor: {
        isAlive: (pid) => pid === EARLIER,
        run: async (_cmd, args) => {
          if (!args.join(' ').includes(String(EARLIER))) return null
          gate.reached = true
          await held
          return 'node.exe|node C:\\other\\program.js\r\n'
        },
      },
    })
    await until('the startup sweep', async () => gate.reached, Boolean).catch(() => {})
    assert.ok(gate.reached, 'the startup sweep is looking at the earlier laya.serve')
    return { p, paths, gate }
  }
  /** Dispose the plugin, let its sweep finish, and read Laya's state once the sweep has. */
  async function disposeThenSweep({ p, paths, gate }) {
    gate.closed = true
    await p.close()
    gate.letGo()
    await until('the sweep has finished', async () => existsSync(paths.sidecarJson), (there) => !there)
    await tick(200)
    return laya(p)
  }

  const withKzh = await sweeping({ startWithKzh: true })
  assert.equal((await disposeThenSweep(withKzh)).state, 'stopped', 'Start Laya when KzH starts did not start it for a plugin that is gone')
  assert.equal(withKzh.p.world.spawned.length, 0)

  const waited = await sweeping({})
  const stop = new AbortController()
  const reply = waited.p.say('What is a monad?', { signal: stop.signal }).catch((err) => err)
  // The message's intent call is now waiting for the sweep before it may start Laya.
  await tick(50)
  assert.equal((await disposeThenSweep(waited)).state, 'stopped', 'nor did the message that was waiting for it')
  assert.equal(waited.p.world.spawned.length, 0)
  stop.abort()
  await reply
})

test('a marker in a Laya Auto task, a tool description and a tool option key never reaches laya.json, laya-samples.jsonl, laya-shadow.jsonl or laya-standing.jsonl', async (t) => {
  const MARKER = 'zqmarker7f3a'
  const tools = [{ id: 'deploy', description: `Deploys the ${MARKER} service`, command: 'node -e ""', params: { target: { question: 'Where to?', options: { [`stage_${MARKER}`]: `The ${MARKER} stage`, prod: 'Production' } } }, enabled: true }]
  const p = await plugin(t, { config: { tools }, settings: { shadow: true } })
  await started(p)
  await p.say(`Fix the failing test in the ${MARKER} parser`, { model: 'jev-auto' })
  await p.say(`Fix the failing lint in the ${MARKER} parser`)
  await quiet(p.dataDir)
  await waitFor('the standing is written', () => p.read('laya-standing.jsonl'), Boolean, { timeoutMs: 20_000 })
  const sent = p.world.fakes.flatMap((f) => f.requests).map((r) => JSON.stringify(r.body))
  assert.ok(sent.some((b) => b.includes(MARKER)), 'Laya was asked about the task and the tool, marker and all')
  for (const file of ['laya.json', 'laya-samples.jsonl', 'laya-shadow.jsonl', 'laya-standing.jsonl']) {
    const text = p.read(file)
    assert.ok(text.length > 0, `${file} was written`)
    assert.ok(!text.includes(MARKER), `${file} holds no task text, tool description or option key`)
  }
})

test('the comparison is not found on a PC where Laya cannot be asked and nothing was compared, so the Router tab shows no card of nothing', async (t) => {
  const bare = await plugin(t, { installed: false })
  const none = await bare.http('GET', '/jev-router/laya/compare?days=7&identity=current')
  assert.equal(none.status, 404, JSON.stringify(none.body))
  assert.equal(none.body.error, 'Laya cannot be asked on this PC, and nothing has been compared')
  // Installed, the comparison is there from the start, with nothing in it yet.
  const p = await plugin(t)
  const fresh = await p.http('GET', '/jev-router/laya/compare?days=7&identity=current')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.skips.answered, 0)
})

test('the routes of 8.4: Laya\'s status, its settings, log, Test Laya, Stop while a run holds it, the shadow\'s rows and the comparison', async (t) => {
  const p = await plugin(t)
  const status = await laya(p)
  for (const key of ['state', 'why', 'install', 'installed', 'expected', 'running', 'stoppedBecause', 'orphanStopped', 'settings', 'shadow', 'selfTest', 'warnings', 'logTail', 'configError']) {
    assert.ok(key in status, `status has ${key}`)
  }
  assert.equal(status.state, 'stopped')
  assert.equal(status.installed.weights.commit, COMMIT)
  assert.deepEqual(Object.keys(status.shadow.skipped), ['not_running', 'starting', 'queue_full', 'too_old', 'jev_failed', 'yielded'])
  assert.deepEqual(status.paths, { engine: join(p.harnessDir, 'engine', 'laya'), models: join(p.harnessDir, 'models', 'laya') })
  const setup = (await p.http('GET', '/jev-router/setup')).body
  assert.equal(setup.laya.state, 'stopped')
  assert.equal(setup.jev.host, 'api.typesafe.ai')
  // The resource budget table reads Laya's share beside llama's, from the local models' status (7.7):
  // what it would take at its next start, on the device it would start on, until it has measured it.
  const budget = (await p.http('GET', '/jev-router/local')).body
  assert.equal(budget.laya.state, 'stopped')
  assert.deepEqual(budget.laya.need, { device: 'cpu', cpu: { ramGB: 3.3 }, cuda: { ramGB: 1.5, vramGB: 2.5 } })
  const none = await plugin(t, { installed: false })
  assert.equal((await none.http('GET', '/jev-router/local')).body.laya, null, 'no Laya installed, no share')

  // Settings: a partial laya.json, checked per field.
  assert.equal((await p.http('POST', '/jev-router/laya/settings', { idleMinutes: 0 })).status, 400)
  const saved = await p.http('POST', '/jev-router/laya/settings', { idleMinutes: 45 })
  assert.equal(saved.body.idleMinutes, 45)
  assert.equal(JSON.parse(p.read('laya.json')).idleMinutes, 45)
  assert.equal((await p.http('POST', '/jev-router/laya/install', { device: 'tpu' })).status, 400)

  // Test Laya runs through the real client, starting Laya, and is kept.
  const selftest = (await p.http('POST', '/jev-router/laya/selftest', {})).body
  assert.equal(selftest.protocol.ok, true, JSON.stringify(selftest.protocol))
  assert.equal(selftest.pairs.length, 7)
  assert.equal(selftest.identity.split('|')[2], COMMIT.slice(0, 12))
  assert.deepEqual((await laya(p)).selfTest, selftest)
  assert.deepEqual((await laya(p)).running.held, [], 'Test Laya let go of Laya when it finished')
  assert.ok((await p.http('GET', '/jev-router/laya/log?lines=5')).body.lines.length <= 5)

  // Stop is refused while a Laya Auto run holds Laya.
  let release
  const blocked = new Promise((r) => { release = r })
  p.world.work = () => blocked
  const running = p.slash('laya', 'Fix the failing test in the parser')
  await waitFor('the agent is working', () => p.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const refused = await p.http('POST', '/jev-router/laya/stop', {})
  assert.deepEqual(refused, { status: 400, body: { error: 'Laya is deciding for an open Laya Auto run; stop that run first.' } })
  assert.equal((await laya(p)).running.held.length, 1)
  release()
  await running

  // The shadow's rows by run, and the comparison.
  assert.equal((await p.http('GET', '/jev-router/laya/shadow')).status, 400)
  assert.deepEqual((await p.http('GET', '/jev-router/laya/shadow?runId=nothing-ran')).body.rows, [])
  assert.equal((await p.http('GET', '/jev-router/laya/compare?days=soon')).status, 400)
  const compare = (await p.http('GET', '/jev-router/laya/compare?days=7&identity=current')).body
  assert.deepEqual(Object.keys(compare).sort(), ['actions', 'days', 'domains', 'identity', 'jevHost', 'latency', 'questions', 'skips', 'standing', 'thresholds'])
  assert.equal(compare.days, 7)
  assert.equal(compare.jevHost, 'api.typesafe.ai')
  assert.equal((await p.http('GET', '/jev-router/laya/compare?days=all&identity=all')).body.identity, 'all')
})

// ---------------------------------------------------------------- the start reply and its notices

test('a read task handed back before its pick is told it waits for its folder like work that writes, naming the run of its read pass, which a verdict on the reply is credited to nothing for, and gets one notice when it starts again as work that writes', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the writer is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jevReads(t, { capability: 'project_change' })
  const said = await q.say('Look at the parser and tidy it', { model: 'jev-auto', effort: 'low' })
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const where = folderOf(q)
  assert.match(said.text, new RegExp(`^OK, \\*\\*jev-2\\*\\* is queued: 2nd in line for ${where} \\(another task is running there\\)\\. Read only: Jev judged it only reads the project \\(93%, its bar is 80%\\), but Jev's routing named project_change \\(\\d+%\\), which may change files, so it waits for ${where} like work that writes\\. Jev picks the agent when it starts; I'll say which here, and report back when it's done\\. Keep chatting\\.\\n\\n\\[jev-job\\]: kzh-job-1-[0-9a-f-]{36}\\n\\n\\[jev-run\\]: kzh-run-1-[\\w-]+$`), said.text)
  // The run it names is its read pass's, which ended before its pick and so has no history row.
  const run = /^\[jev-run\]: kzh-run-1-([\w-]+)$/m.exec(said.text)?.[1]
  assert.equal(run, (await taskRow(q, 'jev-2'))?.runIds?.[0], 'the read pass, the run its task had begun as the reply was written')
  await quiet(q.dataDir)
  assert.equal(q.rows('history.jsonl').filter((r) => r.runId === run).length, 0, 'a run with no history row')
  const notices = q.world.notices.filter((m) => m.source.summary.startsWith('jev-2'))
  assert.deepEqual(notices.map((m) => m.source.summary), ['jev-2 started again as work that writes'], 'one notice, for the pass that writes, and none for the read pass it replaced')
  assert.equal(notices[0].content[0].text, '**jev-2** needed to change files, so it started again as work that writes: **DeepSeek agent** (deepseek-flash, effort low).')
  assert.deepEqual(q.world.notices.filter((m) => m.source.summary.startsWith('jev-1')), [], 'the first task\'s reply named its plan: no notice')
  // A verdict on the reply goes with the run it names (client.js messageRunId), so it relabels no
  // run's routing, where one with no run named would land on whichever run of this chat ended last.
  const verdict = await q.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'start-reply-2', verdict: 'dislike', tag: 'misread my question', runId: run })
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body))
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('routing-samples.jsonl').filter((r) => r.outcome?.labelSource === 'human').map((r) => r.id), [], 'no sample of any run was relabelled by it')
})

test('a read task handed back before its pick in a free folder is told it starts again as work that writes, naming the run of its pass that writes, which a verdict on the reply is credited to', async (t) => {
  const q = await plugin(t, { jobs: true })
  // The first task is done, so the folder is free when the second one's read pass hands it back.
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  jevReads(t, { capability: 'project_change' })
  const said = await q.say('Look at the parser and tidy it', { model: 'jev-auto' })
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const where = folderOf(q)
  assert.match(said.text, new RegExp(`^OK, \\*\\*jev-2\\*\\* is starting in ${where}, and Jev is choosing the agent\\. Read only: Jev judged it only reads the project \\(93%, its bar is 80%\\), but Jev's routing named project_change \\(\\d+%\\), which may change files, so it runs as work that writes, and a task changing ${where} waits for it\\. I'll say here which one it picks, and report back when it's done\\. Keep chatting\\.\\n\\n\\[jev-job\\]: kzh-job-1-[0-9a-f-]{36}\\n\\n\\[jev-run\\]: kzh-run-1-[\\w-]+$`), said.text)
  const run = /^\[jev-run\]: kzh-run-1-([\w-]+)$/m.exec(said.text)?.[1]
  const runIds = (await taskRow(q, 'jev-2'))?.runIds ?? []
  assert.equal(runIds.length, 2, 'a read pass, then a pass that writes')
  assert.equal(run, runIds[1], 'the pass that writes, which had begun as the reply was written')
  await quiet(q.dataDir)
  assert.equal(q.rows('history.jsonl').filter((r) => r.runId === run && r.sessionId === SESSION).length, 1, 'a run of this chat with its history row, which a verdict on the reply is credited to')
})

test('a forced agent that waits is named at once with the effort it would start at, and a notice says so when it starts at another', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const said = await q.say('Now fix the failing lint in the parser', { model: 'agent-deepseek' })
  const where = folderOf(q)
  assert.equal(said.text.split('\n\n[jev-job]')[0], `OK, I'll run **DeepSeek agent** with **deepseek-flash** (effort high) in the background as **jev-2** in ${where}. It waits 2nd in line (another task is running there). I'll report back here when it's done. Keep chatting.\n\n> You picked DeepSeek agent; effort high (Auto in Settings).`)
  // DeepSeek's own effort is set in Settings while the task waits, so it starts at that one.
  assert.equal((await q.http('POST', '/jev-router/effort', { default: 'auto', perAgent: { deepseek: 'max' }, codexSpeed: 'normal' })).status, 200)
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const notices = q.world.notices.filter((m) => m.source.summary.startsWith('jev-2'))
  assert.deepEqual(notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-2: effort max instead of high', 'It started on DeepSeek agent (deepseek-flash, effort max).']])
  const result = q.world.delivered.find((m) => m.source.summary.startsWith('jev-2')).content[0].text
  assert.match(result, /^Agent: DeepSeek agent · deepseek-flash · effort max · took \d+ s$/m, 'and the result names what it ran')
})

test('a forced task whose agent list cannot be read as it is queued still gets its start reply, not an error, and runs once', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  // The agent list cannot be read the moment the second task is queued (a save or a scan holding it,
  // say), and can again by the time that task starts.
  const setup = join(q.dataDir, 'agents.json')
  writeFileSync(setup, '{ damaged')
  const said = await q.say('Now fix the failing lint in the parser', { model: 'agent-deepseek' })
  rmSync(setup)
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  const row = await taskRow(q, 'jev-2')
  assert.match(said.text, new RegExp(`^OK, \\*\\*jev-2\\*\\* is queued: 2nd in line for ${folderOf(q)} \\(another task is running there\\)\\. `), 'the reply says it is queued, since it is: an error would say nothing was, and sent again it would run twice')
  assert.match(said.text, new RegExp(`\\n\\n\\[jev-job\\]: kzh-job-1-${row.key}$`))
  assert.deepEqual(q.world.notices.filter((m) => m.source.summary.startsWith('jev-2')).map((m) => m.source.summary), ['jev-2 started: DeepSeek agent, deepseek-flash, effort high'], 'its reply named no plan, so the started notice names it')
  const results = q.world.delivered.filter((m) => m.source.summary.startsWith('jev-2 '))
  assert.equal(results.length, 1, 'it ran once')
  assert.match(results[0].content[0].text, /^Agent: DeepSeek agent · deepseek-flash · effort high · took \d+ s$/m)
  assert.equal(row.state, 'completed')
})

test('reply A for a forced agent names the effort it starts at and where it came from: a pick in the model menu, the default in Settings, or one set for the agent in Settings, and no effort notice follows', async (t) => {
  const q = await plugin(t, { jobs: true })
  const where = folderOf(q)
  let done = 0
  /** Reply A's words to one task sent to DeepSeek agent's own row at `effort`, once its result is in, so the next starts in an idle folder. */
  const replyOf = async (effort) => {
    const said = await q.say('Fix the failing test in the parser', { model: 'agent-deepseek', effort })
    done += 1
    await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === done, { timeoutMs: 30_000 }).catch(() => [])
    return said.text.split('\n\n[jev-job]')[0]
  }
  const reply = (jobId, effort, from) => `OK, I'll run **DeepSeek agent** with **deepseek-flash** (effort ${effort}) in the background as **${jobId}** in ${where}. I'll report back here when it's done. Keep chatting.\n\n> You picked DeepSeek agent; effort ${effort} (${from}).`
  const settings = (body) => q.http('POST', '/jev-router/effort', { default: 'auto', perAgent: {}, codexSpeed: 'normal', ...body })
  assert.equal(await replyOf('max'), reply('jev-1', 'max', 'your pick in the model menu'))
  assert.equal((await settings({ default: 'xhigh' })).status, 200)
  assert.equal(await replyOf(), reply('jev-2', 'max', 'the default in Settings'), 'xhigh is DeepSeek\'s max')
  assert.equal((await settings({ perAgent: { deepseek: 'low' } })).status, 200)
  assert.equal(await replyOf('high'), reply('jev-3', 'low', 'set for this agent in Settings'), 'the agent\'s own setting wins over the menu')
  await quiet(q.dataDir)
  assert.deepEqual(q.world.notices.map((m) => m.source.summary), [], 'each started at the effort its reply named, so no notice says otherwise')
  const heads = ['jev-1', 'jev-2', 'jev-3'].map((jobId) => /^Agent: .*$/m.exec(q.world.delivered.find((m) => m.source.summary.startsWith(`${jobId} `))?.content[0].text ?? '')?.[0])
  assert.deepEqual(heads.map((h) => h?.replace(/ · took \d+ s$/, '')), ['max', 'max', 'low'].map((e) => `Agent: DeepSeek agent · deepseek-flash · effort ${e}`), 'and each result names the effort it ran at')
})

test('a retry on another agent gets one moved notice, with the router\'s own lines for why', async (t) => {
  const q = await plugin(t, { jobs: true })
  // DeepSeek's first attempt finds its key out of balance, so the work goes to Kimi.
  q.world.outcome = (n) => (n === 1 ? { stopReason: 'error', diagnostic: 'HTTP 402: insufficient balance', output: [], usage: {} } : null)
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry']])
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'deepseek hit its usage limit: handing the task to another agent\nRunning kimi (retry)…']], 'why, then the retry: once, and no other notice, since the reply named DeepSeek')
})

test('a retry on the agent the work is already on gets no moved notice', async (t) => {
  const q = await plugin(t, { jobs: true })
  // Jev's review sends DeepSeek's first answer back to DeepSeek (RETRY_SAME_TIER), and takes its second.
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : 'SECOND-TRY: fixed the parser')
  const second = (state) => JSON.stringify(state).includes('SECOND-TRY')
  jev.said.disposition = (state) => (second(state) ? 'PASS' : 'RETRY_SAME_TIER')
  jev.said.addressed = (state) => (second(state) ? 0.95 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['deepseek', 'retry']], 'retried on DeepSeek')
  assert.deepEqual(q.world.notices, [], 'the work never moved, and the reply named DeepSeek: no notice')
})

test('a retry Jev\'s review sends to another agent gets one moved notice whose body says why: the review\'s line, then the retry\'s', async (t) => {
  const q = await plugin(t, { jobs: true })
  // Jev's review finds DeepSeek's first answer wrong in a way a different resource should try
  // (RETRY_DIFFERENT_RESOURCE), and takes the second, Kimi's.
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : 'SECOND-TRY: fixed the parser')
  const second = (state) => JSON.stringify(state).includes('SECOND-TRY')
  jev.said.disposition = (state) => (second(state) ? 'PASS' : 'RETRY_DIFFERENT_RESOURCE')
  jev.said.addressed = (state) => (second(state) ? 0.95 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry']], 'retried on Kimi')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'Review: retry. quality 0.05 ≤ 0.3\nRunning kimi (retry)…']], 'why, then the retry: once, and no other notice, since the reply named DeepSeek')
})

test('a retry on another agent after DeepSeek\'s credit falls under its floor gets one moved notice whose body says why: the balance\'s line, the limit\'s, then the retry\'s', async (t) => {
  // DeepSeek on its one key, which holds 50 until the first attempt spends it to 19, under DeepSeek's
  // floor of 20, before it has fixed anything; Kimi takes the task over and fixes it.
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  let credit = 50
  net.deepseekBalance = (key) => (key === 'sk-one' ? credit : 50)
  const q = await plugin(t, { jobs: true, accounts: { keys: { deepseek: [{ name: 'k1', active: true }] }, limits: { deepseek: { minBalance: 20, handoffAtBalance: 22 } } } })
  q.world.work = async (_opts, n) => { if (n === 1) credit = 19 }
  q.world.outcome = (n) => (n === 1 ? { stopReason: 'completed', output: [{ type: 'text', text: 'Read the parser; out of credit before the fix.' }], usage: {} } : null)
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry']], 'handed to Kimi')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'deepseek credit 19 USD: below the floor, handing the task over\ndeepseek hit its usage limit: handing the task to another agent\nRunning kimi (retry)…']], 'why, then the retry: once, and no other notice, since the reply named DeepSeek')
})

test('a retry Jev\'s review sends to another agent after DeepSeek\'s credit only ran low gets a moved notice whose body is the review\'s line, then the retry\'s: a credit over its floor keeps the work where it is, so it is no reason', async (t) => {
  // DeepSeek on its one key, which holds 50 until the first attempt spends it to 21: under the 22 at
  // which DeepSeek works in small steps, still over its floor of 20, so the work stays on it. Jev's
  // review then finds the answer wrong in a way a different resource should try, and Kimi takes it.
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__deepseek__k1=sk-one\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before); net.deepseekBalance = null })
  let credit = 50
  net.deepseekBalance = (key) => (key === 'sk-one' ? credit : 50)
  const q = await plugin(t, { jobs: true, accounts: { keys: { deepseek: [{ name: 'k1', active: true }] }, limits: { deepseek: { minBalance: 20, handoffAtBalance: 22 } } } })
  q.world.work = async (_opts, n) => { if (n === 1) credit = 21 }
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : 'SECOND-TRY: fixed the parser')
  const second = (state) => JSON.stringify(state).includes('SECOND-TRY')
  jev.said.disposition = (state) => (second(state) ? 'PASS' : 'RETRY_DIFFERENT_RESOURCE')
  jev.said.addressed = (state) => (second(state) ? 0.95 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  const row = q.rows('history.jsonl')[0]
  assert.deepEqual(row?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry']], 'retried on Kimi')
  assert.deepEqual(row?.availability, { out: [], near: ['deepseek'] }, 'the run heard DeepSeek\'s credit run low, and never run out')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'Review: retry. quality 0.05 ≤ 0.3\nRunning kimi (retry)…']], 'the review moved the work, and the credit that ran low did not')
})

test('a retry Jev\'s review sends to another agent after Jev switched its own key in the review gets a moved notice whose body is the review\'s line, then the retry\'s: Jev\'s limit moves no work, so it is no reason', async (t) => {
  // Jev on two keys: the review's first call on j1 meets a 429, so Jev goes on with j2 and finds
  // DeepSeek's answer wrong in a way a different resource should try, and Kimi takes it.
  const env = join(process.env.DSH_HOME, '.env')
  const before = existsSync(env) ? readFileSync(env, 'utf8') : null
  writeFileSync(env, `${before ?? ''}KZ_KEY__jev__j1=tsk-one\nKZ_KEY__jev__j2=tsk-two\n`)
  t.after(() => { if (before === null) rmSync(env, { force: true }); else writeFileSync(env, before) })
  const q = await plugin(t, { jobs: true, accounts: { keys: { jev: [{ name: 'j1', active: true }, { name: 'j2', active: false }] } } })
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : 'SECOND-TRY: fixed the parser')
  const second = (state) => JSON.stringify(state).includes('SECOND-TRY')
  jev.said.disposition = (state) => (second(state) ? 'PASS' : 'RETRY_DIFFERENT_RESOURCE')
  jev.said.addressed = (state) => (second(state) ? 0.95 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const answer = TypeSafeClient.prototype.systemOne
  let reviews = 0
  TypeSafeClient.prototype.systemOne = function limitedJev(request, options) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL) && request.questions.disposition && reviews++ === 0) return Promise.reject(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
    return answer.call(this, request, options)
  }
  t.after(() => { TypeSafeClient.prototype.systemOne = answer })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry']], 'retried on Kimi')
  const accounts = JSON.parse(readFileSync(join(q.dataDir, 'accounts.json'), 'utf8'))
  assert.deepEqual([accounts.keys.jev.map((k) => [k.name, k.active]), Object.keys(accounts.exhausted)], [[['j1', false], ['j2', true]], ['jev:j1']], 'Jev switched to j2 in the review')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'Review: retry. quality 0.05 ≤ 0.3\nRunning kimi (retry)…']], 'the review moved the work, and Jev\'s own limit did not')
})

test('a retry Jev\'s review keeps on DeepSeek and then sends to another agent gets one moved notice whose body holds only the review since the attempt before it, then the retry\'s line', async (t) => {
  const q = await plugin(t, { jobs: true })
  // Jev's review sends DeepSeek's first answer back to DeepSeek (RETRY_SAME_TIER), finds its second
  // wrong in a way a different resource should try (RETRY_DIFFERENT_RESOURCE), and takes Kimi's. The
  // two reviews score the answers apart, so their lines differ.
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : n === 2 ? 'SECOND-TRY: still nothing useful' : 'THIRD-TRY: fixed the parser')
  const has = (state, s) => JSON.stringify(state).includes(s)
  jev.said.disposition = (state) => (has(state, 'THIRD-TRY') ? 'PASS' : has(state, 'SECOND-TRY') ? 'RETRY_DIFFERENT_RESOURCE' : 'RETRY_SAME_TIER')
  jev.said.addressed = (state) => (has(state, 'THIRD-TRY') ? 0.95 : has(state, 'SECOND-TRY') ? 0.1 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['deepseek', 'retry'], ['kimi', 'retry']], 'retried on DeepSeek, then on Kimi')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'Review: retry. quality 0.10 ≤ 0.3\nRunning kimi (retry)…']], 'the review that moved the work, never the one that kept it on DeepSeek')
})

test('a task whose work moves twice in one routing gets one moved notice, for its first move: Jev\'s review sends DeepSeek\'s answer to Kimi and Kimi\'s back to DeepSeek', async (t) => {
  const q = await plugin(t, { jobs: true })
  q.world.reply = (n) => (n === 1 ? 'FIRST-TRY: changed nothing useful' : n === 2 ? 'SECOND-TRY: still nothing useful' : 'THIRD-TRY: fixed the parser')
  const third = (state) => JSON.stringify(state).includes('THIRD-TRY')
  jev.said.disposition = (state) => (third(state) ? 'PASS' : 'RETRY_DIFFERENT_RESOURCE')
  jev.said.addressed = (state) => (third(state) ? 0.95 : 0.05)
  t.after(() => { delete jev.said.disposition; delete jev.said.addressed })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  await quiet(q.dataDir)
  assert.deepEqual(q.rows('history.jsonl')[0]?.attempts.map((a) => [a.agent, a.role]), [['deepseek', 'primary'], ['kimi', 'retry'], ['deepseek', 'retry']], 'moved to Kimi, then back to DeepSeek')
  assert.deepEqual(q.world.notices.map((m) => [m.source.summary, m.content[0].text]), [['jev-1 moved to Kimi agent', 'Review: retry. quality 0.05 ≤ 0.3\nRunning kimi (retry)…']], 'one moved notice per routing: the first move\'s')
  assert.deepEqual((await taskRow(q, 'jev-1'))?.progressPosted, { moved: 1 }, 'claimed once, for the routing it was posted in')
})

test('a pick that lands after the guard\'s grace but within the reply\'s wait gets reply A and no started notice: the guard waits out the reply\'s own wait before its grace', async (t) => {
  // A reply that never says what it named is taken to have named nothing 100 ms after its wait, which
  // is 15 s as shipped. Jev answers each call 400 ms late, so its pick lands a second or so after the
  // task is queued: long after the grace alone, and well within the wait.
  const q = await plugin(t, { jobs: true, replies: { graceMs: 100 } })
  const answer = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async function slowJev(request, options) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL)) await tick(400)
    return answer.call(this, request, options)
  }
  t.after(() => { TypeSafeClient.prototype.systemOne = answer })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  assert.match(said.text, /^OK, I'll run \*\*DeepSeek agent\*\* /, said.text)
  const took = Number(/^> Picked by Jev in ([\d.]+) s/m.exec(said.text)?.[1])
  assert.ok(took * 1000 > 100, `the pick took ${took} s, past the grace: ${said.text}`)
  assert.deepEqual(q.world.notices.map((m) => m.source.summary), [], 'the reply named the plan, so no started notice goes beside it')
})

test('a reply stopped in its wait whose work moves to another agent gets its started notice before the moved notice, naming the agent the work started on, and none after it', async (t) => {
  // The reply waits up to 3 s for the pick, and one that said nothing is taken to have named nothing
  // 100 ms after that: its guard fires while Kimi still works.
  const q = await plugin(t, { jobs: true, replies: { graceMs: 100 } })
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 3000 })).status, 200)
  // Stopped while Jev routes the task, so the reply ends in its wait and never says what it named.
  const stop = new AbortController()
  jev.said.capability = () => { stop.abort(); return undefined }
  t.after(() => { delete jev.said.capability })
  // DeepSeek's first attempt finds its key out of balance, so the work goes to Kimi, held at work.
  q.world.outcome = (n) => (n === 1 ? { stopReason: 'error', diagnostic: 'HTTP 402: insufficient balance', output: [], usage: {} } : null)
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 2) await blocked }
  const queued = Date.now()
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto', signal: stop.signal }).catch((err) => err)
  await waitFor('Kimi is at work', () => q.ran.length, (n) => n === 2, { timeoutMs: 20_000 }).catch(() => 0)
  // Past the reply's wait and its guard, with Kimi still at work.
  await tick(Math.max(0, queued + 3000 + 100 + 700 - Date.now()))
  const notices = q.world.notices.map((m) => [m.source.summary, m.content[0].text])
  release()
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  assert.equal(said?.name, 'AbortError', 'the reply was stopped in its wait')
  const row = await taskRow(q, 'jev-1')
  assert.equal(row?.plan?.agent, 'deepseek', 'the work started on DeepSeek')
  assert.deepEqual(notices, [
    [`jev-1 started: DeepSeek agent, deepseek-flash${row.plan.effort ? `, effort ${row.plan.effort}` : ''}`, `**jev-1** started: **DeepSeek agent** (deepseek-flash${row.plan.effort ? `, effort ${row.plan.effort}` : ''}) is working on it in ${folderOf(q)}. Watch it on the work board; the result posts here when it's done.`],
    ['jev-1 moved to Kimi agent', 'deepseek hit its usage limit: handing the task to another agent\nRunning kimi (retry)…'],
  ], 'where the work started, then where it went: never a started notice after the moved one')
  assert.equal(q.world.notices.length, 2, 'and nothing more once the guard had fired')
})

test('a task\'s notices go out in the order they were claimed: a started notice slow to post still comes before the moved notice claimed after it', async (t) => {
  const q = await plugin(t, { jobs: true })
  // Stopped while Jev routes the task, so the reply ends in its wait and never says what it named:
  // when the work moves, the started notice is claimed, then the moved notice.
  const stop = new AbortController()
  jev.said.capability = () => { stop.abort(); return undefined }
  t.after(() => { delete jev.said.capability })
  // DeepSeek's first attempt finds its key out of balance, so the work goes to Kimi, held at work.
  q.world.outcome = (n) => (n === 1 ? { stopReason: 'error', diagnostic: 'HTTP 402: insufficient balance', output: [], usage: {} } : null)
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 2) await blocked }
  // The chat cannot take the started notice the first time, so it goes out a second later, on its retry.
  let offered = 0
  q.world.refuseAppend = (msg) => /^jev-1 started: /.test(msg.source?.summary ?? '') && offered++ === 0
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto', signal: stop.signal }).catch((err) => err)
  const summaries = () => q.world.notices.map((m) => m.source.summary)
  const notices = await until('both notices are posted', summaries, (n) => n.length === 2).catch(() => summaries())
  release()
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  assert.equal(said?.name, 'AbortError', 'the reply was stopped in its wait')
  assert.equal(offered, 2, 'the started notice was refused once, and taken on its retry')
  assert.deepEqual(notices.map((n) => n.split(':')[0]), ['jev-1 started', 'jev-1 moved to Kimi agent'], 'the order they were claimed in, not the order they were ready')
  assert.match(notices[0], /^jev-1 started: DeepSeek agent, deepseek-flash/)
})

test('reply A\'s credit says where its effort came from: a pick in the model menu, the default in Settings, or one set for the agent in Settings', async (t) => {
  const q = await plugin(t, { jobs: true })
  let done = 0
  /** The credit under the reply to one task sent at `effort`, once its result is in, so the next starts in an idle folder. */
  const creditOf = async (effort) => {
    const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto', effort })
    done += 1
    await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === done, { timeoutMs: 30_000 }).catch(() => [])
    return said.text.split('\n\n')[1] ?? said.text
  }
  const settings = (body) => q.http('POST', '/jev-router/effort', { default: 'auto', perAgent: {}, codexSpeed: 'normal', ...body })
  assert.match(await creditOf('max'), /^> Picked by Jev in (under 0\.1|[\d.]+) s: a design question, low risk; effort max \(your pick in the model menu\)\.$/)
  assert.equal((await settings({ default: 'max' })).status, 200)
  assert.match(await creditOf(), /^> Picked by Jev in (under 0\.1|[\d.]+) s: a design question, low risk; effort max \(the default in Settings\)\.$/)
  assert.equal((await settings({ perAgent: { deepseek: 'max' } })).status, 200)
  assert.match(await creditOf('high'), /^> Picked by Jev in (under 0\.1|[\d.]+) s: a design question, low risk; effort max \(set for this agent in Settings\)\.$/, 'the agent\'s own setting wins over the menu')
})

test('reply A\'s credit says the routing rules picked when Jev could not, and why', async (t) => {
  // Routing that asks Jev itself (no adaptive routing), and a Jev that is down for the routing call.
  const q = await plugin(t, { jobs: true, config: { routing: { enabled: false } } })
  jev.refuses = (questions) => 'capability' in questions || 'agent' in questions
  t.after(() => { jev.refuses = null })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  jev.refuses = null
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  const [reply, credit] = said.text.split('\n\n')
  assert.match(reply ?? '', /^OK, I'll run \*\*DeepSeek agent\*\* with \*\*deepseek-flash\*\* \(effort high\) /, said.text)
  assert.match(credit ?? '', /^> Picked by the routing rules in (under 0\.1|[\d.]+) s, since Jev could not pick \(Error: 503 Service Unavailable\); effort high \(Auto in Settings\)\.$/, said.text)
})

test('a plugin closed as soon as its task\'s result is posted has written all it will: the claim of that result is on disk, and nothing in its data folder changes after its close', async (t) => {
  const q = await plugin(t, { jobs: true })
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await q.close()
  const closed = filesUnder(q.dataDir)
  assert.equal(q.rows('tasks.jsonl').find((r) => r.jobId === 'jev-1')?.deliveryState, 'delivering', 'the result was claimed before it was posted, and the claim is saved')
  // What it had under way as it closed (that claim, what the run taught, Laya's standing) would land within this.
  await tick(1500)
  assert.deepEqual(filesUnder(q.dataDir), closed, 'nothing written after the plugin closed')
})

test('closing waits for the writes under way, and for one that never ends only so long, saying so', async () => {
  const { closeWithin } = jevRouter
  assert.equal(typeof closeWithin, 'function', 'index.js bounds what closing waits for')
  const logs = []
  let landed = false
  await closeWithin([tick(50).then(() => { landed = true }), null], { ms: 5000, log: (m) => logs.push(m) })
  assert.equal(landed, true, 'a write under way has landed once closing resolves')
  const started = Date.now()
  await closeWithin([new Promise(() => {}), tick(10)], { ms: 200, log: (m) => logs.push(m) })
  assert.ok(Date.now() - started < 2000, 'a write that never ends holds closing for the bound only')
  assert.deepEqual(logs, ['1 of 2 still under way after 0.2 s; closing without waiting for it'])
})

test('a plugin applied again keeps the task records it writes: a task of the plugin closed before it, still at work then, ends without rewriting tasks.jsonl or posting its result', async (t) => {
  const before = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  before.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await before.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the task is at work', () => before.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  await before.close()
  // The engine applies the plugin again on the same data: it reads that task back as stopped, and
  // hands the next one the same job id.
  const after = await plugin(t, { jobs: true, dataDir: before.dataDir, harnessDir: before.harnessDir })
  await after.say('Fix the failing lint in the parser', { model: 'jev-auto' })
  await waitFor('its result is posted', () => after.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const theirs = (await after.http('GET', '/jev-router/tasks')).body.tasks.map((x) => x.key)
  await quiet(after.dataDir)
  // The task of the plugin that closed gets to its end now, in that plugin.
  release()
  const ended = await until('the closed plugin\'s task has ended', () => taskRow(before, 'jev-1'), (r) => r?.state === 'completed', { timeoutMs: 30_000 }).catch(() => null)
  assert.equal(ended?.state, 'completed', 'the task of the closed plugin ran to its end')
  await quiet(after.dataDir)
  assert.deepEqual(after.rows('tasks.jsonl').map((r) => r.key), theirs, 'tasks.jsonl holds the records of the plugin applied again')
  assert.equal(before.world.delivered.length, 0, 'the closed plugin posted no result it could not mark as posted')
})

test('reply A\'s credit says the routing rules picked when Jev\'s routing calls failed and the routing domains filled in without them, as the strip under it does, never Jev and never that no Jev call was made', async (t) => {
  // Adaptive routing, as shipped, and a Jev that is down for the routing calls but sorts the message:
  // each routing call fails, and the routing domains fill in by their rules, which is no fallback.
  const q = await plugin(t, { jobs: true })
  jev.refuses = (questions) => ['taskType', 'strategy', 'secondOpinion', 'agent'].some((k) => k in questions)
  t.after(() => { jev.refuses = null })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  jev.refuses = null
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  // What the run's own log holds before its pick: Jev calls that failed, and none that answered.
  const { body: log } = await q.http('GET', `/jev-router/log?session=${SESSION}`)
  const events = log.find((e) => e.jobId === 'jev-1')?.events ?? []
  const routed = events.findIndex((e) => e.type === 'routed')
  const before = events.slice(0, Math.max(0, routed)).map((e) => e.type)
  assert.ok(routed > 0 && before.includes('decider-error') && !before.includes('jev'), JSON.stringify(before))
  assert.equal(events[routed]?.routing?.mode, 'jev', 'the routing domains picked, not the fallback')
  const credit = said.text.split('\n\n')[1] ?? said.text
  assert.match(credit, /^> Picked by the routing rules in (under 0\.1|[\d.]+) s, since Jev could not pick \(Error: 503 Service Unavailable\); effort high \(Auto in Settings\)\.$/, said.text)
  assert.doesNotMatch(credit, /no Jev call/, 'Jev was called, and failed')
  // The strip under the reply names the same picker: the routing rules, then the worker.
  const strip = JSON.parse(Buffer.from(/^\[jev-agents\]: kzh-agents-1-(\S+)$/m.exec(said.text)?.[1] ?? '', 'base64url').toString() || 'null')
  assert.deepEqual(strip?.[0], { agent: 'Routing rules', model: '', roles: [] }, said.text)
})

test('reply A\'s credit says when your feedback moved the pick off another agent', async (t) => {
  const q = await plugin(t, { jobs: true })
  // A dislike in this chat that says DeepSeek was the wrong agent and Kimi the right one.
  const verdict = await q.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'answer-1', verdict: 'dislike', tag: 'wrong agent', provider: 'deepseek', suggestedAgent: 'kimi' })
  assert.equal(verdict.status, 200, JSON.stringify(verdict.body))
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  const [reply, credit] = said.text.split('\n\n')
  assert.match(reply ?? '', /^OK, I'll run \*\*Kimi agent\*\* with \*\*kimi-k2\*\* /, said.text)
  assert.match(credit ?? '', /^> Picked by Jev in (under 0\.1|[\d.]+) s: a design question, low risk\. Your feedback moved it off DeepSeek agent\.$/, said.text)
})

test('reply A carries the agent strip of the pick it names: who picked, with the model its answers came from, then the worker by its id with its model and effort, for a Jev pick and a Laya pick', async (t) => {
  const stripOf = (text) => JSON.parse(Buffer.from(/^\[jev-agents\]: kzh-agents-1-(\S+)$/m.exec(text)?.[1] ?? '', 'base64url').toString() || 'null')
  const q = await plugin(t, { jobs: true })
  const byJev = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  assert.match(byJev.text, /^OK, I'll run \*\*DeepSeek agent\*\* with \*\*deepseek-flash\*\* \(effort high\) /, byJev.text)
  assert.deepEqual(stripOf(byJev.text), [{ agent: 'Jev', model: 'jev-1.13.0', roles: [] }, { agent: 'deepseek', model: 'deepseek-flash, high', roles: ['work'] }], 'Jev, with the model its answers came from, then the worker')
  const p = await plugin(t, { jobs: true })
  await started(p)
  const byLaya = await p.say('Fix the failing test in the parser', { model: 'laya-auto' })
  await waitFor('its result is posted', () => p.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  assert.match(byLaya.text, /^OK, I'll run \*\*DeepSeek agent\*\* with \*\*deepseek-flash\*\* \(effort low\) /, byLaya.text)
  assert.deepEqual(stripOf(byLaya.text), [{ agent: 'Laya', model: LABEL, roles: [] }, { agent: 'deepseek', model: 'deepseek-flash, low', roles: ['work'] }], 'Laya, with its model\'s label, then the worker')
})

test('a message Laya could not sort says why it runs as a task in every start reply: A once Laya picks, B while it waits its turn, and C when the reply does not wait for the pick', async (t) => {
  const q = await plugin(t, { jobs: true })
  await started(q)
  // Laya fails the call that sorts each message, and answers every routing call.
  q.world.said.kind = () => { throw new Error('model error') }
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const one = await q.say('Fix the failing test in the parser')
  await waitFor('the first task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const two = await q.say('Now fix the failing lint in the parser')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 }).catch(() => [])
  // A reply that does not wait for the pick is C, as the task is queued.
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 0 })).status, 200)
  const three = await q.say('And tidy the parser')
  await waitFor('every result is posted', () => q.world.delivered, (d) => d.length === 3, { timeoutMs: 30_000 }).catch(() => [])
  const why = /Laya could not sort this message \(.+\); treating it as a task\./.exec(one.text)?.[0] ?? 'none'
  const where = folderOf(q)
  const said = (text) => text.split('\n\n[jev-job]')[0]
  assert.match(said(one.text), new RegExp(`^OK, I'll run \\*\\*DeepSeek agent\\*\\* with \\*\\*deepseek-flash\\*\\* \\(effort \\w+\\) in the background as \\*\\*jev-1\\*\\* in ${where}\\. Laya could not sort this message \\(.+\\); treating it as a task\\. I'll report back here when it's done\\. Keep chatting\\.\\n\\n> Picked by Laya on this PC `), one.text)
  assert.equal(said(two.text), `OK, **jev-2** is queued: 2nd in line for ${where} (another task is running there). ${why} Laya picks the agent when it starts; I'll say which here, and report back when it's done. Keep chatting.`)
  assert.equal(said(three.text), `OK, **jev-3** is starting in ${where}, and Laya is choosing the agent. ${why} I'll say here which one it picks, and report back when it's done. Keep chatting.`)
})

test('a question asked while a task works is told what that task is doing now, and of no task in another chat or one that has ended', async (t) => {
  const q = await plugin(t, { jobs: true })
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  // Another chat queues a task in the same folder, where it waits.
  for await (const _ of q.adapter().stream({ model: 'jev-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'Now fix the failing lint in the parser' }] }], sessionId: 'session-2', signal: new AbortController().signal })) { /* the reply */ }
  assert.equal((await taskRow(q, 'jev-2'))?.state, 'queued')
  const about = () => q.world.chat.at(-1)?.messages.at(-1)?.content[0]?.text ?? ''
  const question = await q.say('How is it going?', { model: 'jev-auto' })
  assert.match(question.text, /^A monad/, 'the chat model answered it')
  assert.match(about(), /^You are talking with the person who runs this app: .* Right now in this chat: jev-1 is running on DeepSeek agent \(\d+ s, last: .+\)\.$/, about())
  assert.doesNotMatch(about(), /jev-2/, 'the task another chat queued is not this chat\'s')
  release()
  await waitFor('both results are posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  await q.say('And now?', { model: 'jev-auto' })
  assert.doesNotMatch(about(), /Right now/, 'nothing runs in this chat now')
})

test('a task Jev reads as needing a person names no agent: its reply says it ended, one that waited gets no started notice, and each result reads Needs input', async (t) => {
  const q = await plugin(t, { jobs: true })
  // Jev reads the next message as needing a person, at 85%, over its bar of 60%. It is sent at a
  // level picked in the model menu, which no attempt of its run starts at.
  jev.said.capability = 'human_required'
  t.after(() => { delete jev.said.capability })
  const one = await q.say('Deploy this to production with my AWS keys', { model: 'jev-auto', effort: 'xhigh' })
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  // A task at work in the folder, so the next one waits its turn.
  delete jev.said.capability
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the task between them is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  jev.said.capability = 'human_required'
  const three = await q.say('Now deploy it to production with my AWS keys', { model: 'jev-auto' })
  release()
  await waitFor('every result is posted', () => q.world.delivered, (d) => d.length === 3, { timeoutMs: 30_000 })
  assert.equal(one.text.split('\n\n')[0], '**jev-1** ended before Jev picked its agent (Needs input). Its result is posted here as its own message.', 'no agent is named for a run that starts none')
  assert.match(one.text, new RegExp(`\\n\\n\\[jev-job\\]: kzh-job-1-${(await taskRow(q, 'jev-1')).key}(\\n|$)`))
  assert.doesNotMatch(one.text, /\[jev-agents\]/, 'and no agent strip names one')
  assert.match(three.text, /^OK, \*\*jev-3\*\* is queued: 2nd in line for [^ ]+ \(another task is running there[^)]*\)\. Jev picks the agent when it starts;/, three.text)
  assert.deepEqual(q.world.notices.filter((m) => !m.source.summary.startsWith('jev-2')).map((m) => m.source.summary), [], 'no notice says an agent started for either')
  for (const jobId of ['jev-1', 'jev-3']) {
    const result = q.world.delivered.find((m) => m.source.summary.startsWith(`${jobId} `))
    assert.match(result?.source.summary ?? '', / · Needs input$/, jobId)
    assert.match(result.content[0].text, /^Agent: Jev picks$/m, 'its head names no agent and no effort, as its reply named none')
    assert.match(result.content[0].text, /^Status: Needs input$/m)
    assert.match(result.content[0].text, /Jev read this as needing a person/)
  }
  assert.equal(q.ran.length, 1, 'only the task between them ran an agent')
})

test('a read task whose agent could not be started locked is told, as it starts again as work that writes, the lock it could not have, not that it needed to change files', async (t) => {
  const q = await plugin(t, { jobs: true })
  jevReads(t)
  // The routing found deepseek lockable; by its last call the spawn provider takes no tool filter any
  // more, so its locked start is refused and the task goes to its folder's line.
  jev.said.strategy = () => { q.world.providers.spawn = { capabilities: { toolFilter: false } }; return undefined }
  t.after(() => { delete jev.said.strategy })
  await q.say('How does the parser read its tokens', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const notices = await until('its notice is posted', () => q.world.notices.filter((m) => m.source.summary.startsWith('jev-1')), (n) => n.length > 0).catch(() => [])
  assert.deepEqual(notices.map((m) => m.source.summary), ['jev-1 started again as work that writes'])
  assert.match(notices[0].content[0].text, /^\*\*jev-1\*\* could not run locked against writing \(deepseek could not be started locked: its provider takes no per-start tool filter\), so it started again as work that writes: \*\*[^*]+\*\* \([^)]+\)\.$/, notices[0].content[0].text)
})

test('while a start reply waits for a pick that takes a moment, its block shows the router\'s own lines after its choosing line, before the reply names the agent', async (t) => {
  const q = await plugin(t, { jobs: true })
  await started(q)
  // Laya, loaded and ready, now takes 100 ms a question, so its routing calls take over a second.
  q.world.fakes.at(-1).setMsPerRow(100)
  const chunks = []
  for await (const c of q.adapter().stream({ model: 'laya-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the failing test in the parser' }] }], sessionId: SESSION, signal: new AbortController().signal })) chunks.push(c)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  // A message that took a moment to sort says so first, in a block of its own.
  const wait = reasoning.slice(Math.max(0, reasoning.indexOf('Queued as jev-1.')))
  assert.match(wait, /^Queued as jev-1\. Choosing the agent \(I reply once it's picked, at most 15 s\)\. Stop here ends this reply only; the task keeps going \(stop it on the work board\)\.\n/, reasoning)
  const lines = wait.split('\n').slice(1)
  const route = lines.findIndex((l) => /^Laya route: \d+\/\d+ questions in \d+ ms/.test(l))
  const routed = lines.findIndex((l) => /^Routed to \w+ \(laya\)/.test(l))
  assert.ok(route >= 0 && routed > route, `the router's own lines, as they came: ${JSON.stringify(lines)}`)
  assert.ok(chunks.findLastIndex((c) => c.type === 'reasoning-delta') < chunks.findIndex((c) => c.type === 'text-delta'), 'all of them before the reply')
  assert.match(text, /^OK, I'll run \*\*[^*]+\*\* with [^\n]* as \*\*jev-1\*\* in [^\n]*\n\n> Picked by Laya on this PC in /, text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
})

test('a task read as needing a person whose routing takes a moment names no agent in its reply\'s block either: the router\'s line says no agent runs', async (t) => {
  const q = await plugin(t, { jobs: true })
  await started(q)
  // Laya reads the message as needing a person, over its bar, and its routing calls take over a second.
  q.world.said.capability = 'human_required'
  q.world.fakes.at(-1).setMsPerRow(100)
  const chunks = []
  for await (const c of q.adapter().stream({ model: 'laya-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'Deploy this to production with my AWS keys' }] }], sessionId: SESSION, signal: new AbortController().signal })) chunks.push(c)
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 }).catch(() => [])
  assert.equal(text.split('\n\n')[0], '**jev-1** ended before Laya picked its agent (Needs input). Its result is posted here as its own message.')
  const wait = reasoning.slice(Math.max(0, reasoning.indexOf('Queued as jev-1.')))
  assert.match(wait, /^Queued as jev-1\. Choosing the agent /, 'the reply waited in a block of its own')
  assert.match(wait, /^Laya read this as needing a person: no agent runs$/m, 'the router\'s line for the routing that stopped for a person')
  assert.doesNotMatch(reasoning, /Routed to|deepseek|kimi/i, 'and nothing in the block names an agent that would have run')
  assert.equal(q.ran.length, 0)
})

// ---------------------------------------------------------------- task or question, and the reply ledger, in shadow

/** The intent samples in a plugin's store `file`, each with its newest outcome. */
const intentSamples = (p, file = 'routing-samples.jsonl') => {
  const all = p.rows(file)
  return all.filter((r) => r.domain === 'intent').map((s) => ({ ...s, outcome: all.filter((r) => r.id === s.id && r.outcome).at(-1)?.outcome ?? null }))
}
/** How many intent calls Jev has been sent: the call whose questions hold `alsoWork`. */
const jevIntentCalls = () => jev.calls.filter((c) => 'alsoWork' in (JSON.parse(c.body).questions ?? {})).length

test('under Jev Auto each message is one intent sample with Jev\'s answer as the teacher\'s, still one Jev call a message: a direct answer ends with its mark, and a task carries its sample to its run, which labels it', async (t) => {
  const q = await plugin(t, { jobs: true })
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  const calls = jevIntentCalls()
  const answer = await q.say('What is a monad?', { model: 'jev-auto' })
  assert.match(answer.text, /^A monad chains computations/, 'the question was answered directly')
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  assert.equal(jevIntentCalls() - calls, 2, 'Jev was asked once a message, as before')
  assert.equal(q.rows('usage.jsonl').filter((u) => u.agent === 'jev' && u.phase === 'intent').length, 2, 'and paid once a message')
  const samples = intentSamples(q)
  assert.deepEqual(samples.map((s) => [s.teacher?.label, s.authority]), [['question', 'jev'], ['task', 'jev']], 'one sample a message, Jev deciding and teaching while the domain learns')
  const [question, task] = samples
  assert.ok(answer.text.endsWith(`no agents or project work\n\n[jev-intent]: kzh-intent-1-${question.id}`), answer.text)
  assert.equal(question.outcome, null, 'only a person\'s word labels a direct answer')
  const [record] = q.rows('history.jsonl')
  assert.equal(record.intentSample, task.id, 'the run\'s record carries the sample of the message that asked for it')
  assert.equal(q.rows('tasks.jsonl').find((r) => r.jobId === 'jev-1')?.intentSample, task.id, 'and so does its task')
  assert.deepEqual([task.outcome?.label, task.outcome?.labelSource, task.outcome?.verified], ['task', 'verified_outcome', true], 'an accepted run that changed files says it was a task')
  assert.doesNotMatch(JSON.stringify(samples), /monad|parser|failing/i, 'a sample keeps features, never the words')
})

/** A picture attached to a message, as the engine gives it, and the store that reads its bytes. */
const PICTURE = { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', attachment: { attachmentId: 'shot-1' } }
const PICTURES = { readImageRequest: async () => ({ mediaType: 'image/png', data: Buffer.from('a picture') }) }

test('a message\'s intent sample says whether a picture came with it, as classify hands the intent domain the message\'s modalities', async (t) => {
  const q = await plugin(t, { jobs: true })
  q.world.attachments = PICTURES
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  await q.say('What is this?', { model: 'jev-auto', images: [PICTURE] })
  await q.say('What is a monad?', { model: 'jev-auto' })
  await quiet(q.dataDir)
  const features = intentSamples(q).map((s) => s.input?.features)
  assert.deepEqual(features.map((f) => [f?.numeric?.has_image, f?.categorical?.modality]), [[1, 'text+image'], [0, 'text']], 'the screenshot sent with its question, and the question sent alone')
})

test('the reply ledger keeps what a Jev Auto start reply named and what the router then ran, with no words of the task, and GET /jev-router/replies/summary shows it', async (t) => {
  const q = await plugin(t, { jobs: true })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(said.text, /^OK, I'll run \*\*[^*]+\*\* with /, said.text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const [record] = q.rows('history.jsonl')
  const picked = record.routing.primaryAgent
  const rows = q.rows('reply-ledger.jsonl')
  assert.equal(new Set(rows.map((r) => r.key)).size, 1, 'one task, one row')
  const row = rows.at(-1)
  assert.deepEqual([row.jobId, row.decider, row.mode, row.forced, row.predicted, row.match], ['jev-1', 'jev', 'auto', false, null, null], 'no predictor is trained yet: no guess, and nothing scored')
  assert.deepEqual([row.said.how, row.said.agent], ['routed', picked], 'the reply waited for the pick and named it')
  assert.ok(Number.isFinite(row.said.ms) && row.said.ms >= 0, JSON.stringify(row.said))
  assert.deepEqual([row.ran.agent, row.ran.runId], [picked, record.runId], 'what the router ran, from its first routing')
  const plan = q.rows('tasks.jsonl').find((r) => r.jobId === 'jev-1')?.plan
  assert.ok(plan?.effort && plan?.model, `the setting: the router planned an effort and a model: ${JSON.stringify(plan)}`)
  assert.equal(row.ran.level, plan.level, 'at the level of the effort the router planned, which a guess is scored on')
  assert.deepEqual([row.said.effort, row.said.model], [plan.effort, plan.model], 'the reply named the effort and the model of the pick')
  assert.deepEqual([row.ran.effort, row.ran.model], [plan.effort, plan.model], 'and the router ran them')
  assert.deepEqual(AGENTS.map((a) => row.features.numeric[`avail:${a.id}`]), [1, 1], 'with the pool it was picked from')
  assert.doesNotMatch(q.read('reply-ledger.jsonl'), /parser|failing/i, 'and no words of the task')
  // The intent domain's evaluation after the run, which counts the label the run gave the message.
  const evaluated = await until('the intent domain is evaluated with the run\'s label', () => JSON.parse(q.read(join('domains', 'intent.state.json')) || 'null')?.lastEvaluation ?? null, (ev) => ev?.samples?.verified >= 1).catch(() => null)
  const { status, body } = await q.http('GET', '/jev-router/replies/summary')
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.learning, true)
  assert.deepEqual([body.startReplies.n, body.startReplies.days], [1, 7], 'one reply waited for routing this week')
  assert.equal(body.startReplies.medianMs, row.said.ms)
  assert.deepEqual(body.recent.map((r) => [r.jobId, r.said.how, r.ran.agent, r.match]), [['jev-1', 'routed', picked, null]])
  assert.deepEqual(body.recent.map((r) => [r.said.effort, r.said.model, r.ran.effort, r.ran.model]), [[plan.effort, plan.model, plan.effort, plan.model]], 'with the effort and the model of each, for the card to name')
  assert.deepEqual([body.prediction.labelled, body.prediction.minRows, body.prediction.trained], [1, 60, null])
  assert.deepEqual(body.prediction.gates, { quick: { right: 45, of: 50 }, likely: { right: 16, of: 20 } })
  assert.deepEqual(body.prediction.records.jev.quick, { decider: 'jev', of: 50, n: 0, right: 0 })
  assert.equal(body.intent.maturity, 'JEV_PRIMARY')
  assert.deepEqual(body.intent.needs, { samples: 750, perClass: 100, recentAccuracy: 0.94 })
  assert.deepEqual([body.intent.verified, body.intent.classes, body.intent.recent], [evaluated?.samples?.verified, evaluated?.classes?.counts, null], 'the checked examples and those of each class, as the domain\'s last evaluation counted them, with no classifier yet to score')
  assert.deepEqual([body.intent.verified, body.intent.classes], [1, { task: 1 }], 'the one message, checked as a task by its run')
  assert.equal(body.names[picked], AGENTS.find((a) => a.id === picked).name)
  assert.doesNotMatch(JSON.stringify(body), /parser|failing/i)
})

test('the summary gives the How Jev replies card the message intent\'s figures as the domain\'s last evaluation counted them: its checked examples, those of each class, and how often its classifier was right of the newest it was not trained on', async (t) => {
  const { intentFeatures } = await import('../features.js')
  assert.equal(typeof intentFeatures, 'function', 'features.js reads a message for its intent')
  const { calibrate, saveArtifact, trainMulticlass } = await import('../classifier.js')
  const { createTrainingStore } = await import('../training.js')
  const TASKS = ['Fix the failing test in the parser', 'Add a dark mode switch to the settings page', 'Rename the config loader to settings loader']
  const QUESTIONS = ['What is a monad?', 'Why does the build fail on Windows?']
  // Forty messages in Jev's store, each checked by what its run did: every fourth a question, and the
  // rest tasks, but for three worded as tasks that ran as answers and changed no file, so checked as
  // questions. The classifier was trained through the tenth, and is right of the thirty after it but
  // for those three.
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-intent-figures-'))
  cleanUp(t, dataDir)
  const store = createTrainingStore({ file: join(dataDir, 'routing-samples.jsonl') })
  const ids = []
  for (let i = 0; i < 40; i++) {
    const worded = i % 4 === 3 ? 'question' : 'task'
    const label = [16, 26, 36].includes(i) ? 'question' : worded
    const row = await store.append({ domain: 'intent', input: { features: intentFeatures(worded === 'task' ? TASKS[i % 3] : QUESTIONS[i % 2]) }, teacher: { label: worded, probabilities: { [worded]: 0.9 }, confidence: 0.9, model: 'jev-test' }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { label, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
    ids.push(row.id)
  }
  const samples = [...TASKS.flatMap((m) => Array.from({ length: 6 }, () => ({ features: intentFeatures(m), label: 'task' }))), ...QUESTIONS.flatMap((m) => Array.from({ length: 6 }, () => ({ features: intentFeatures(m), label: 'question' })))]
  saveArtifact(join(dataDir, 'classifiers', 'intent.json'), calibrate(trainMulticlass({ samples, domain: 'intent', options: { epochs: 300, learningRate: 0.3 }, extras: { verifiedSamples: 10, trainedThrough: ids[9], calibratedThrough: ids[9] } }), samples))
  const q = await plugin(t, { dataDir })
  // The evaluation pass a run starts on its own, asked for at once.
  const { status, body: evaluatedNow } = await q.http('POST', '/jev-router/routing/evaluate', {})
  assert.equal(status, 200, JSON.stringify(evaluatedNow))
  const ev = JSON.parse(q.read(join('domains', 'intent.state.json')) || 'null')?.lastEvaluation
  assert.deepEqual([ev?.samples?.verified, ev?.classes?.counts, ev?.recent?.n, ev?.recent?.accuracy], [40, { task: 27, question: 13 }, 30, 0.9], 'the setting: forty checked, thirty of them scored, twenty-seven right')
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body?.intent?.verified, body?.intent?.classes, body?.intent?.recent], [40, { task: 27, question: 13 }, { accuracy: 0.9, n: 30 }], 'the figures the card reads, as the evaluation counted them')
})

test('the summary gives the How Jev replies card the bars task or question is held to by the routing policy in force, not the ones that ship: checked examples, those of each class, and a recent accuracy set between two whole percents', async (t) => {
  // The message intent is a LOW domain, so the LOW gates are its own.
  const q = await plugin(t, { config: { routing: { gates: { LOW: { guardedSamples: 600, perClassSamples: 50, guarded: { recentAccuracy: 0.945 } } } } } })
  const { status, body } = await q.http('GET', '/jev-router/replies/summary')
  assert.equal(status, 200, JSON.stringify(body))
  assert.deepEqual(body?.intent?.needs, { samples: 600, perClass: 50, recentAccuracy: 0.945 }, 'the bars the policy sets')
  const held = (await q.http('GET', '/jev-router/routing')).body?.policy?.gates?.LOW
  assert.deepEqual([held?.guardedSamples, held?.perClassSamples, held?.guarded?.recentAccuracy], [600, 50, 0.945], 'which are those the Router tab says the domains are held to')
})

test('the reply ledger keeps how each start reply came to name what it named: the pick it waited for as routed, none for a reply that waits its turn, and an agent picked in the model menu as forced, which teaches the predictor nothing and is not timed with the replies that waited for routing', async (t) => {
  const q = await plugin(t, { jobs: true })
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  const first = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const second = await q.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
  const third = await q.say('Then tidy the parser', { model: 'agent-deepseek' })
  release()
  await waitFor('every result is posted', () => q.world.delivered, (d) => d.length === 3, { timeoutMs: 60_000 })
  await quiet(q.dataDir)
  assert.match(first.text, /^OK, I'll run \*\*[^*]+\*\* with /, 'the first waited for its pick and named it')
  assert.match(second.text, /^OK, \*\*jev-2\*\* is queued: /, 'the second waits its turn, so its reply named no plan')
  assert.match(third.text, /^OK, I'll run \*\*DeepSeek agent\*\* with \*\*deepseek-flash\*\* /, 'the third named the agent picked in the model menu')
  // Each task's newest line, which holds its whole row, by job.
  const rows = Object.fromEntries([...new Map(q.rows('reply-ledger.jsonl').map((r) => [r.key, r])).values()].map((r) => [r.jobId, r]))
  assert.deepEqual(Object.keys(rows).sort(), ['jev-1', 'jev-2', 'jev-3'], 'a row a task')
  const picked = q.rows('history.jsonl').find((h) => h.taskKey === rows['jev-1'].key)?.routing?.primaryAgent
  assert.deepEqual(['jev-1', 'jev-2', 'jev-3'].map((j) => [j, rows[j].forced, rows[j].said?.how, rows[j].said?.agent ?? null]), [
    ['jev-1', false, 'routed', picked],
    ['jev-2', false, 'waited', null],
    ['jev-3', true, 'forced', 'deepseek'],
  ])
  assert.deepEqual([rows['jev-2'].said.effort, rows['jev-2'].said.model], [null, null], 'a reply that named no plan named no effort or model either')
  assert.deepEqual([rows['jev-3'].said.model, rows['jev-3'].predicted], ['deepseek-flash', null], 'the forced reply named its model, and nothing was guessed for a task nobody routes')
  assert.deepEqual(['jev-1', 'jev-2', 'jev-3'].map((j) => !!rows[j].ran?.agent), [true, true, true], 'each was routed once it started')
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body.startReplies.n, body.startReplies.medianMs], [1, rows['jev-1'].said.ms], 'only the reply that waited for routing is timed')
  assert.equal(body.prediction.labelled, 2, 'and the predictor learns from the two tasks routing picked for, not from your pick')
  assert.deepEqual(body.recent.map((r) => [r.jobId, r.said.how]), [['jev-3', 'forced'], ['jev-2', 'waited'], ['jev-1', 'routed']])
})

test('the reply ledger keeps a pick that gives the work to a tool as the tool its start reply named, as what ran names it, never the agent that takes over only if the tool fails', async (t) => {
  const tools = [{ id: 'fixer', description: 'Writes fixed into state.txt and nothing else', command: "node -e \"require('fs').writeFileSync('state.txt','fixed')\"", params: {}, enabled: true }]
  const q = await plugin(t, { jobs: true, config: { tools } })
  // Jev's routing hands the work to the fixer tool; the router names an agent behind it all the same.
  Object.assign(jev.said, { handler: 'fixer', 'fixer.fits': 0.95, capability: 'other' })
  t.after(() => { for (const k of ['handler', 'fixer.fits', 'capability']) delete jev.said[k] })
  const said = await q.say('Write fixed into state.txt', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  assert.match(said.text, /^OK, I'll run the \*\*fixer\*\* tool on this in the background as \*\*jev-1\*\* /, said.text)
  const rows = q.rows('reply-ledger.jsonl')
  assert.equal(new Set(rows.map((r) => r.key)).size, 1, 'one task, one row')
  const row = rows.at(-1)
  assert.deepEqual([row.ran?.agent, row.ran?.effort, row.ran?.model], ['tool:fixer', null, null], 'the tool ran')
  assert.ok(q.rows('history.jsonl')[0]?.routing?.primaryAgent, 'with an agent behind it, should it fail')
  assert.deepEqual([row.said?.agent, row.said?.effort, row.said?.model, row.said?.how], ['tool:fixer', null, null, 'routed'], 'and the reply is kept as naming the tool, as what ran names it')
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual(body.recent.map((r) => [r.said.agent, r.ran.agent]), [['tool:fixer', 'tool:fixer']])
})

test('a start reply whose wait for the pick runs out is kept as such and timed with the replies that named the pick, and the card is told when replies wait for no pick at all', async (t) => {
  const q = await plugin(t, { jobs: true })
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 300 })).status, 200)
  // Jev's routing and review calls take a second, longer than the reply waits; sorting the message does not.
  const answer = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async function systemOne(request, options) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL) && !('alsoWork' in (request.questions ?? {}))) await tick(1000)
    return answer.call(this, request, options)
  }
  t.after(() => { TypeSafeClient.prototype.systemOne = answer })
  const said = await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  assert.match(said.text, /^OK, \*\*jev-1\*\* is starting in .+, and Jev is still choosing the agent \(0\.3 s so far\)\./, said.text)
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const row = q.rows('reply-ledger.jsonl').at(-1)
  assert.deepEqual([row?.said?.how, row?.said?.agent], ['bound', null], 'kept as a reply whose wait ran out before the pick')
  assert.ok(row.said.ms >= 300, JSON.stringify(row.said))
  let { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body.startReplies?.n, body.startReplies?.atBound, body.startReplies?.medianMs, body.startReplies?.waitMs], [1, 1, row.said.ms, 300], 'timed, counted as one whose wait ran out, beside the wait replies are given now')
  // With the wait set to none, a reply waits for no pick, and the card is told so.
  TypeSafeClient.prototype.systemOne = answer
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 0 })).status, 200)
  await q.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
  await waitFor('the second result is posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const second = [...new Map(q.rows('reply-ledger.jsonl').map((r) => [r.key, r])).values()].find((r) => r.jobId === 'jev-2')
  assert.equal(second?.said?.how, 'now', 'a reply that waited for no pick went out at once, and is not one whose wait ran out')
  ;({ body } = await q.http('GET', '/jev-router/replies/summary'))
  assert.deepEqual([body.startReplies.n, body.startReplies.atBound, body.startReplies.waitMs], [1, 1, 0], 'and is not timed')
})

test('a start reply that goes out at once beside a task that starts at once is kept as going out at once, never as one that waited: the sentence of work asked for beside a question answered directly, whatever the wait for the pick, and C with that wait set to none; a reply whose task waits its turn waited', async (t) => {
  const q = await plugin(t, { jobs: true })
  // A question that also asks for work, in an idle folder, with the wait for the pick as it ships.
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  jev.said.alsoWork = 0.95
  t.after(() => { delete jev.said.kind; delete jev.said.alsoWork })
  const answered = await q.say('What does the parser do, and can you also fix its failing test?', { model: 'jev-auto' })
  assert.match(answered.text, /^A monad chains computations[\s\S]*\n\nOK, \*\*jev-1\*\* is starting in /, answered.text)
  delete jev.said.alsoWork
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  // With the wait for the pick set to none, a task in the idle folder, and one that waits its turn behind it.
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 0 })).status, 200)
  // The second task is held at work by its own words, however many agents started before it.
  let release
  const blocked = new Promise((r) => { release = r })
  let held = false
  q.world.work = async (opts) => { if (String(opts.prompt?.[0]?.text ?? '').includes('Fix the failing lint in the parser')) { held = true; await blocked } }
  const atOnce = await q.say('Fix the failing lint in the parser', { model: 'jev-auto' })
  assert.match(atOnce.text, /^OK, \*\*jev-2\*\* is starting in /, atOnce.text)
  await waitFor('the second task is at work', () => held, Boolean, { timeoutMs: 20_000 })
  const queued = await q.say('Then tidy the parser', { model: 'jev-auto' })
  assert.match(queued.text, /^OK, \*\*jev-3\*\* is queued: /, queued.text)
  release()
  await waitFor('every result is posted', () => q.world.delivered, (d) => d.length === 3, { timeoutMs: 60_000 })
  await quiet(q.dataDir)
  // Each task's newest line, which holds its whole row, by job.
  const rows = Object.fromEntries([...new Map(q.rows('reply-ledger.jsonl').map((r) => [r.key, r])).values()].map((r) => [r.jobId, r]))
  assert.deepEqual(['jev-1', 'jev-2', 'jev-3'].map((j) => [j, rows[j]?.said?.how ?? null, rows[j]?.said?.agent ?? null]), [['jev-1', 'now', null], ['jev-2', 'now', null], ['jev-3', 'waited', null]], `the work beside the answer and C each went out at once, and B waited its turn; none named an agent: ${JSON.stringify(Object.values(rows).map((r) => [r.jobId, r.said]))}`)
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body?.startReplies?.n, body?.recent?.map((r) => [r.jobId, r.said?.how])], [0, [['jev-3', 'waited'], ['jev-2', 'now'], ['jev-1', 'now']]], 'none of them waited for a pick, so none is timed')
})

test('the summary tells a reply whose task ended before routing picked anything from one whose task is still to be routed: a task stopped as it waited its turn, and one Jev read as needing a person once its reply\'s wait ran out', async (t) => {
  const q = await plugin(t, { jobs: true })
  const recentOf = async (jobId) => ((await q.http('GET', '/jev-router/replies/summary')).body?.recent ?? []).find((r) => r.jobId === jobId)
  // A task at work in the folder, so the next one waits its turn.
  let release
  const blocked = new Promise((r) => { release = r })
  q.world.work = async (_opts, n) => { if (n === 1) await blocked }
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the first task is working', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const second = await q.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
  assert.match(second.text, /^OK, \*\*jev-2\*\* is queued: /, 'the second waits its turn, so its reply named no plan')
  const waiting = await until('the waiting task\'s reply is kept', () => recentOf('jev-2'), (r) => r?.said?.how === 'waited', { timeoutMs: 5000 }).catch(() => null)
  assert.deepEqual([waiting?.said?.how, waiting?.ran, waiting?.ended ?? null], ['waited', null, null], 'its task is still to be routed')
  assert.deepEqual((await q.http('POST', '/jev-router/tasks/stop', { jobId: 'jev-2', onlyIfWaiting: true })).body, { result: 'requested' })
  const stopped = await until('the stopped task\'s reply says it ended', () => recentOf('jev-2'), (r) => !!r?.ended, { timeoutMs: 5000 }).catch(() => null)
  assert.deepEqual([stopped?.ran, stopped?.ended], [null, 'stopped'], 'stopped as it waited: nothing ran, and nothing will')
  // Cleared from the task list, which only a finished task leaves, it is still one that ended.
  assert.deepEqual((await q.http('POST', '/jev-router/tasks/clear', { jobIds: ['jev-2'] })).body, { cleared: ['jev-2'] })
  assert.equal((await recentOf('jev-2'))?.ended, true, 'gone from the task list, and ended')
  release()
  await waitFor('the first result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  // Jev's routing takes a second, longer than the reply waits, and reads the next task as needing a person.
  assert.equal((await q.http('POST', '/jev-router/chat-replies/settings', { waitMs: 300 })).status, 200)
  const answer = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async function systemOne(request, options) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL) && !('alsoWork' in (request.questions ?? {}))) await tick(1000)
    return answer.call(this, request, options)
  }
  t.after(() => { TypeSafeClient.prototype.systemOne = answer })
  jev.said.capability = 'human_required'
  t.after(() => { delete jev.said.capability })
  const third = await q.say('Now deploy it to production with my AWS keys', { model: 'jev-auto' })
  assert.match(third.text, /^OK, \*\*jev-3\*\* is starting in .+, and Jev is still choosing the agent/, third.text)
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const person = await recentOf('jev-3')
  assert.deepEqual([person?.said?.how, person?.ran, person?.ended], ['bound', null, 'needs_human'], 'routed as needing a person after its wait ran out: nothing ran, and nothing will')
  const first = await recentOf('jev-1')
  assert.deepEqual([!!first?.ran?.agent, first?.ended], [true, 'completed'], 'and the task that ran is said to have run what it ran')
  assert.equal(q.ran.length, 1, 'only the first task started an agent')
})

test('a start reply that goes out once its task has ended is kept all the same: one whose wait for the pick, as it ships, ended as Jev read the task as needing a person, and reply A for an agent picked in the model menu that refused the task at once, kept as your pick and not as one that waited for routing', async (t) => {
  // Claude is switched on but signed out, so a task sent to it from the model menu ends as it starts.
  claudeSignedIn(t, { loggedIn: false })
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const q = await plugin(t, { jobs: true, config: { agents: [...AGENTS, claude] } })
  const recentOf = async (jobId) => ((await q.http('GET', '/jev-router/replies/summary')).body?.recent ?? []).find((r) => r.jobId === jobId)
  // Jev reads the message as needing a person well within the wait for the pick as it ships (15 s),
  // so the reply's wait ends with its task, and the reply goes out once the task has ended.
  jev.said.capability = 'human_required'
  t.after(() => { delete jev.said.capability })
  const person = await q.say('Deploy this to production with my AWS keys', { model: 'jev-auto' })
  assert.match(person.text, /^\*\*jev-1\*\* ended before Jev picked its agent \(Needs input\)\. /, person.text)
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  delete jev.said.capability
  // Reply A for Claude, held once its text is out until its task has ended, as a chat slow to take
  // it holds it, so it says what it named only after that.
  const forced = await q.say('Fix the failing test in the parser', {
    model: 'agent-claude',
    hold: async (e) => { if (e.type === 'block-end' && e.block?.type === 'text') await until('the task Claude refused has ended', () => taskRow(q, 'jev-2'), (r) => r?.state === 'failed', { timeoutMs: 20_000 }) },
  })
  assert.match(forced.text, /^OK, I'll run \*\*Claude Code\*\* /, forced.text)
  await waitFor('its result is posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  // Each task's newest line, which holds its whole row, by job.
  const rows = Object.fromEntries([...new Map(q.rows('reply-ledger.jsonl').map((r) => [r.key, r])).values()].map((r) => [r.jobId, r]))
  assert.deepEqual([rows['jev-1']?.said?.how, rows['jev-1']?.said?.agent, rows['jev-1']?.ran], ['waited', null, null], `the reply that waited for a pick that did not come, and named none, is kept: ${JSON.stringify(rows['jev-1'])}`)
  assert.deepEqual([rows['jev-2']?.forced, rows['jev-2']?.said?.how, rows['jev-2']?.said?.agent, rows['jev-2']?.ran], [true, 'forced', 'claude', null], `and so is reply A, as naming your pick, not a pick it waited for: ${JSON.stringify(rows['jev-2'])}`)
  const needsYou = await recentOf('jev-1')
  assert.deepEqual([needsYou?.said?.how, needsYou?.ran, needsYou?.ended], ['waited', null, 'needs_human'], 'Recent replies holds the reply, whose task ran nothing as it needed a person')
  const refused = await recentOf('jev-2')
  assert.deepEqual([refused?.said?.how, refused?.ran, refused?.ended], ['forced', null, 'failed'], 'and reply A, whose task ran nothing as its agent refused it')
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body?.startReplies?.n, body?.recent?.map((r) => r.jobId)], [0, ['jev-2', 'jev-1']], 'neither is timed with the replies that named the pick they waited for')
  assert.equal(q.ran.length, 0, 'no agent started on either')
})

test('after a restart hands out a job id again, the summary reads each reply\'s task by its key: the reply of the task stopped before the restart still ended, and the new one under that job id is still to be routed', async (t) => {
  /** A task at work in the plugin `p`'s folder, held until the returned function lets it go, and a second that waits its turn behind it. */
  const twoTasks = async (p) => {
    let release
    const blocked = new Promise((r) => { release = r })
    p.world.work = async (_opts, n) => { if (n === 1) await blocked }
    await p.say('Fix the failing test in the parser', { model: 'jev-auto' })
    await waitFor('the first task is working', () => p.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
    const second = await p.say('Now fix the failing lint in the parser', { model: 'jev-auto' })
    assert.match(second.text, /^OK, \*\*jev-2\*\* is queued: /, 'the second waits its turn as jev-2')
    return release
  }
  const repliesOf = async (p, jobId) => ((await p.http('GET', '/jev-router/replies/summary')).body?.recent ?? []).filter((r) => r.jobId === jobId)
  const before = await plugin(t, { jobs: true })
  const release = await twoTasks(before)
  await until('the waiting task\'s reply is kept', () => repliesOf(before, 'jev-2'), (rows) => rows[0]?.said?.how === 'waited', { timeoutMs: 5000 }).catch(() => null)
  assert.deepEqual((await before.http('POST', '/jev-router/tasks/stop', { jobId: 'jev-2', onlyIfWaiting: true })).body, { result: 'requested' })
  const stopped = await until('the stopped task\'s reply says it ended', () => repliesOf(before, 'jev-2'), (rows) => !!rows[0]?.ended, { timeoutMs: 5000 }).catch(() => null)
  assert.deepEqual(stopped?.map((r) => r.ended), ['stopped'], 'stopped as it waited its turn, before the restart')
  release()
  await waitFor('the first result is posted', () => before.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(before.dataDir)
  await before.close()
  // KzH started again on the same data: the job ids start again, so the next task waiting its turn is jev-2 too.
  const after = await plugin(t, { jobs: true, dataDir: before.dataDir, harnessDir: before.harnessDir })
  const releaseAfter = await twoTasks(after)
  const both = await until('both replies under jev-2 are kept', () => repliesOf(after, 'jev-2'), (rows) => rows.length === 2 && rows.every((r) => r.said?.how), { timeoutMs: 5000 }).catch(() => null)
  assert.deepEqual(both?.map((r) => [r.said?.how, r.ran, r.ended]), [['waited', null, null], ['waited', null, true]], 'newest first: the new task, still to be routed, and the one stopped before the restart, which has left the task list and still ended')
  releaseAfter()
  await waitFor('both results after the restart are posted', () => after.world.delivered, (d) => d.length === 2, { timeoutMs: 60_000 })
  await quiet(after.dataDir)
})

test('a trained reply predictor guesses as a task is queued, from the agents routing could pick then, and the guess is scored once routing picks: right when the router runs the agent and level it named, and counted against the gates config.replies sets', async (t) => {
  const { replyFeatures, trainPredictor } = await import('../reply-ledger.js').catch(() => ({}))
  assert.equal(typeof trainPredictor, 'function', 'reply-ledger.js trains a predictor of the pick')
  const { saveArtifact } = await import('../classifier.js')
  // A predictor that learned what the router runs here for this task (DeepSeek at medium, as the
  // test of what a start reply named above has it) and for other words something else, saved where
  // the plugin keeps it before it starts.
  const task = 'Fix the failing test in the parser'
  const pool = { available: AGENTS.map((a) => a.id), mode: 'auto', level: 'auto', decider: 'jev' }
  const rows = Array.from({ length: 60 }, (_, i) => (i % 3 === 2
    ? { key: `seed-${i}`, features: replyFeatures({ text: 'Write the docs for the logger', ...pool }), ran: { agent: 'kimi', level: 'low' } }
    : { key: `seed-${i}`, features: replyFeatures({ text: task, ...pool }), ran: { agent: 'deepseek', level: 'medium' } }))
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-predictor-'))
  cleanUp(t, dataDir)
  saveArtifact(join(dataDir, 'reply-model.json'), trainPredictor(rows))
  const q = await plugin(t, { jobs: true, dataDir, config: { replies: { quick: { right: 3, of: 4 } } } })
  await q.say(task, { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const plan = q.rows('tasks.jsonl').find((r) => r.jobId === 'jev-1')?.plan
  assert.deepEqual([plan?.agent, plan?.level], ['deepseek', 'medium'], 'the setting: the router runs what the predictor learned it runs')
  const row = q.rows('reply-ledger.jsonl').at(-1)
  assert.deepEqual([row.predicted?.agent, row.predicted?.level, row.predicted?.trusted], ['deepseek', 'medium', true], 'guessed as it was queued, every agent it could name being one routing could pick')
  assert.equal(row.ran?.level, plan.level, 'what ran keeps the level of the effort the router planned')
  assert.equal(row.match, true, 'and the guess is scored right')
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual(body.prediction.gates, { quick: { right: 3, of: 4 }, likely: { right: 16, of: 20 } }, 'the gates config.replies sets')
  assert.equal(body.prediction.trained?.rows, 60, 'the predictor in service is the one it found')
  assert.deepEqual([body.prediction.records.jev.quick, body.prediction.records.jev.likely], [{ decider: 'jev', of: 4, n: 1, right: 1 }, { decider: 'jev', of: 20, n: 1, right: 1 }], 'its record, against each gate')
  assert.deepEqual(body.recent.map((r) => [r.jobId, r.predicted?.agent, r.match]), [['jev-1', 'deepseek', true]])
})

test('a trained reply predictor guesses only among the agents routing could pick as the task is queued: one whose favourite is switched on but signed out names the best agent left, and is not trusted', async (t) => {
  const { replyFeatures, trainPredictor } = await import('../reply-ledger.js').catch(() => ({}))
  assert.equal(typeof trainPredictor, 'function', 'reply-ledger.js trains a predictor of the pick')
  const { predict, saveArtifact } = await import('../classifier.js')
  // Claude is switched on but signed out, so routing cannot pick it; the predictor learned that the
  // router runs Claude at high for this task, and DeepSeek at medium for other words.
  claudeSignedIn(t, { loggedIn: false })
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const task = 'Fix the failing test in the parser'
  const pool = { available: AGENTS.map((a) => a.id), mode: 'auto', level: 'auto', decider: 'jev' }
  const rows = Array.from({ length: 60 }, (_, i) => (i % 3 === 2
    ? { key: `seed-${i}`, features: replyFeatures({ text: 'Write the docs for the logger', ...pool }), ran: { agent: 'deepseek', level: 'medium' } }
    : { key: `seed-${i}`, features: replyFeatures({ text: task, ...pool }), ran: { agent: 'claude', level: 'high' } }))
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-masked-'))
  cleanUp(t, dataDir)
  const predictor = trainPredictor(rows)
  saveArtifact(join(dataDir, 'reply-model.json'), predictor)
  const q = await plugin(t, { jobs: true, dataDir, config: { agents: [...AGENTS, claude] } })
  await q.say(task, { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  const row = q.rows('reply-ledger.jsonl').at(-1)
  assert.deepEqual(Object.keys(row?.features?.numeric ?? {}).filter((k) => k.startsWith('avail:')).sort(), ['avail:deepseek', 'avail:kimi'], 'the setting: Claude is no agent routing could pick')
  assert.equal(predict(predictor, row.features).label, 'claude|high', 'the setting: unmasked, the predictor names Claude')
  assert.deepEqual([row.predicted?.agent, row.predicted?.level, row.predicted?.trusted], ['deepseek', 'medium', false], 'the best agent routing could pick, not trusted, since its favourite is out of reach')
})

test('a replies gate whose right is above its of stops the plugin at start-up with the key\'s name, rather than starting it on the gates that ship', async (t) => {
  await assert.rejects(plugin(t, { config: { replies: { likely: { right: 21, of: 20 } } } }), /^Error: replies\.likely: right and of are whole numbers from 1, right no more than of$/)
})

test('the reply ledger keeps the pool each task was picked from: the effort picked in the model menu, the row\'s mode and who decides, a picture, each tool switched on, and only the agents routing could pick then, never one signed out', async (t) => {
  // Claude is switched on but signed out; the fixer tool is switched on, the linter is not.
  claudeSignedIn(t, { loggedIn: false })
  const claude = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code.', enabled: true }
  const tools = [
    { id: 'fixer', description: 'Writes fixed into state.txt and nothing else', command: "node -e \"require('fs').writeFileSync('state.txt','fixed')\"", params: {}, enabled: true },
    { id: 'linter', description: 'Lints the project', command: 'node -e "0"', params: {}, enabled: false },
  ]
  const q = await plugin(t, { jobs: true, config: { agents: [...AGENTS, claude], tools } })
  q.world.attachments = PICTURES
  await q.say('Fix what this screenshot shows in the parser', { model: 'jev-auto', effort: 'xhigh', images: [PICTURE] })
  await waitFor('the first result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await q.say('Now fix the failing lint in the parser', { model: 'jev-online' })
  await waitFor('the second result is posted', () => q.world.delivered, (d) => d.length === 2, { timeoutMs: 30_000 })
  await started(q)
  await q.say('Then tidy the parser', { model: 'laya-auto' })
  await waitFor('the third result is posted', () => q.world.delivered, (d) => d.length === 3, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  // Each task's newest line, which holds its whole row, by job; and the pool's own features of it.
  const rows = Object.fromEntries([...new Map(q.rows('reply-ledger.jsonl').map((r) => [r.key, r])).values()].map((r) => [r.jobId, r]))
  const pool = (jobId) => Object.keys(rows[jobId]?.features?.numeric ?? {}).filter((k) => /^(avail|mode|level|decider|modal):/.test(k)).sort()
  assert.deepEqual(pool('jev-1'), ['avail:deepseek', 'avail:kimi', 'avail:tool:fixer', 'decider:jev', 'level:xhigh', 'modal:image', 'mode:auto'], 'Jev Auto at Extra High, with a screenshot')
  assert.equal(rows['jev-1'].features.numeric.has_image, 1, 'which the words\' own features say too')
  assert.deepEqual(pool('jev-2'), ['avail:deepseek', 'avail:kimi', 'avail:tool:fixer', 'decider:jev', 'level:auto', 'mode:online'], 'Jev Auto Online, at the effort routing picks')
  assert.deepEqual(pool('jev-3'), ['avail:deepseek', 'avail:kimi', 'avail:tool:fixer', 'decider:laya', 'level:auto', 'mode:auto'], 'Laya Auto')
  assert.deepEqual(['jev-1', 'jev-2', 'jev-3'].map((j) => rows[j]?.decider), ['jev', 'jev', 'laya'], 'and each row is its decider\'s, so a guess under Laya Auto is scored in Laya\'s record, apart from Jev\'s')
})

test('the reply ledger reads a task sent with a picture by the person\'s own words, as its intent sample does, never by the line that hands the agent the picture, which names folders of this PC and the attachment', async (t) => {
  const { intentFeatures } = await import('../features.js')
  assert.equal(typeof intentFeatures, 'function', 'features.js reads a message for its intent')
  const q = await plugin(t, { jobs: true })
  q.world.attachments = PICTURES
  const message = 'Fix what this screenshot shows in the parser'
  await q.say(message, { model: 'jev-auto', images: [PICTURE] })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
  assert.match(q.rows('tasks.jsonl').find((r) => r.jobId === 'jev-1')?.taskText ?? '', /^The person attached an image\. Open `[^`]*shot-1\.png` /, 'the setting: the task is sent with the line that hands the agent the picture by its path in this folder')
  const row = q.rows('reply-ledger.jsonl').at(-1)
  // The row's features but for the pool's: what the predictor reads of the words.
  const pool = /^(avail|mode|level|decider|modal):/
  const words = { numeric: Object.fromEntries(Object.entries(row?.features?.numeric ?? {}).filter(([k]) => !pool.test(k))), categorical: row?.features?.categorical ?? {} }
  assert.deepEqual(words, intentFeatures(message, { modalities: ['text', 'image'] }), 'the message as the person wrote it, with the picture as has_image')
  assert.deepEqual(words, intentSamples(q).at(-1)?.input?.features, 'as its intent sample reads it')
  assert.equal(row?.features?.numeric?.['modal:image'], 1, 'and the pool says a picture came with it')
})

test('the plugin\'s reply ledger retrains in a worker thread, and closing the plugin ends a retrain under way: its worker is ended, and nothing it trained is saved for the next start', async (t) => {
  const { replyFeatures } = await import('../reply-ledger.js').catch(() => ({}))
  assert.equal(typeof replyFeatures, 'function', 'reply-ledger.js keeps the features a predictor of the pick learns from')
  // Fifty-nine tasks routing picked for are on record, so the next one routed starts the first retrain.
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-retrain-'))
  cleanUp(t, dataDir)
  const pool = { available: AGENTS.map((a) => a.id), mode: 'auto', level: 'auto', decider: 'jev' }
  const seeded = Array.from({ length: 59 }, (_, i) => ({ key: `seed-${i}`, jobId: `seed-${i}`, decider: 'jev', mode: 'auto', forced: false, ts: new Date().toISOString(), features: replyFeatures({ text: 'Fix the failing test in the parser', ...pool }), ran: { agent: 'deepseek', level: 'medium' } }))
  writeFileSync(join(dataDir, 'reply-ledger.jsonl'), seeded.map((r) => `${JSON.stringify(r)}\n`).join(''))
  // Every worker thread of reply-ledger.js started (shadow.js has workers of its own), with what it says
  // when it ends held until the test lets it go, so the retrain is under way for as long as the test
  // needs it to be, and each one ended by terminate().
  const wt = createRequire(import.meta.url)('node:worker_threads')
  const Real = wt.Worker
  const started = []
  const ended = []
  const held = []
  let holding = true
  wt.Worker = class extends Real {
    constructor(...a) {
      super(...a)
      this.retrains = String(a[0]).endsWith('/reply-ledger.js')
      if (this.retrains) started.push(this)
    }
    once(event, fn) { return super.once(event, this.retrains && ['message', 'error', 'exit'].includes(event) ? (...v) => (holding ? held.push(() => fn(...v)) : fn(...v)) : fn) }
    terminate() { if (this.retrains) ended.push(this); return super.terminate() }
  }
  syncBuiltinESMExports()
  t.after(() => { wt.Worker = Real; syncBuiltinESMExports() })
  const q = await plugin(t, { jobs: true, dataDir })
  await q.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  const worker = await until('the sixtieth task routing picked for starts a retrain', () => started.length, (n) => n >= 1, { timeoutMs: 5000 }).then(() => started[0], () => null)
  assert.ok(worker, 'in a worker thread')
  await q.close()
  assert.deepEqual([ended.length, ended[0] === worker], [1, true], 'closing the plugin ended it')
  holding = false
  for (const go of held.splice(0)) go()
  if (worker.threadId !== -1) await new Promise((r) => worker.on('exit', r))
  await quiet(dataDir)
  assert.equal(existsSync(join(dataDir, 'reply-model.json')), false, 'and nothing it trained was saved')
  assert.equal(started.length, 1, 'one retrain, and no other')
})

test('with learning off the plugin trains no predictor of the pick from the ledger the card still reads, however many tasks routing picked for are on record and none trained through them', async (t) => {
  const { replyFeatures } = await import('../reply-ledger.js').catch(() => ({}))
  assert.equal(typeof replyFeatures, 'function', 'reply-ledger.js keeps the features a predictor of the pick learns from')
  // Seventy tasks routing picked for, from before learning was switched off, and no predictor saved.
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-learning-off-'))
  cleanUp(t, dataDir)
  const pool = { available: AGENTS.map((a) => a.id), mode: 'auto', level: 'auto', decider: 'jev' }
  const seeded = Array.from({ length: 70 }, (_, i) => ({ key: `seed-${i}`, jobId: `seed-${i}`, decider: 'jev', mode: 'auto', forced: false, ts: new Date().toISOString(), features: replyFeatures({ text: 'Fix the failing test in the parser', ...pool }), ran: { agent: 'deepseek', level: 'medium' } }))
  writeFileSync(join(dataDir, 'reply-ledger.jsonl'), seeded.map((r) => `${JSON.stringify(r)}\n`).join(''))
  const q = await plugin(t, { dataDir, config: { routing: { learn: false } } })
  const { body } = await q.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([body?.learning, body?.prediction?.labelled, body?.prediction?.training, body?.prediction?.trained], [false, 70, false, null], 'the card reads the ledger, and nothing trains')
  await quiet(dataDir)
  assert.equal(existsSync(join(dataDir, 'reply-model.json')), false, 'and nothing is saved')
})

test('no intent sample is recorded where Jev teaches nothing: Jev Auto offline or with no network, Laya Auto, and learning or adaptive routing off; there an answer carries no mark, and with learning off no reply is kept either', async (t) => {
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  const local = { chatModel: async () => 'qwen-local' }
  /**
   * A question on the row `model`: answered, with no mark, no intent sample in either store, and
   * `jevCalls` intent calls to Jev. The plugin is closed after, unless it is to be `kept`.
   */
  const nothingKept = async (p, label, { model = 'jev-auto', jevCalls = 0, kept = false } = {}) => {
    const calls = jevIntentCalls()
    const out = await p.say('What is a monad?', { model })
    assert.match(out.text, /A monad chains computations/, `${label}: answered`)
    assert.doesNotMatch(out.text, /jev-intent/, `${label}: no mark`)
    await quiet(p.dataDir)
    assert.deepEqual(intentSamples(p), [], `${label}: no sample in Jev's store`)
    assert.deepEqual(intentSamples(p, 'laya-samples.jsonl'), [], `${label}: nor in Laya's`)
    assert.equal(jevIntentCalls() - calls, jevCalls, `${label}: Jev's intent calls`)
    if (!kept) await p.close()
  }
  await nothingKept(await plugin(t, { local }), 'Jev Auto offline', { model: 'jev-offline' })
  const dead = await plugin(t, { local })
  net.online = false
  t.after(() => { net.online = true })
  await nothingKept(dead, 'a dead network')
  net.online = true
  await nothingKept(await plugin(t), 'Laya Auto', { model: 'laya-auto' })
  const routingOff = await plugin(t, { config: { routing: { enabled: false } } })
  await nothingKept(routingOff, 'adaptive routing off', { jevCalls: 1, kept: true })
  const { body: routingOffSummary } = await routingOff.http('GET', '/jev-router/replies/summary')
  assert.deepEqual([routingOffSummary.learning, routingOffSummary.intent], [true, null], 'adaptive routing off: the card is told start replies are still learned from, and task or question is not')
  await routingOff.close()
  const off = await plugin(t, { jobs: true, config: { routing: { learn: false } } })
  await nothingKept(off, 'learning off', { jevCalls: 1, kept: true })
  await off.say('Fix the failing test in the parser', { model: 'jev-auto' })
  await waitFor('the result is posted', () => off.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(off.dataDir)
  assert.equal(off.rows('history.jsonl')[0]?.intentSample, undefined, 'learning off: the run carries no sample')
  assert.equal(off.read('reply-ledger.jsonl'), '', 'learning off: no reply is kept')
  assert.equal((await off.http('GET', '/jev-router/replies/summary')).body.learning, false, 'and the card is told so')
})

test('where no task can run, in No project and the scratch workspace, Jev reads every message on a Jev row, so a question the local classifier is sure is a task is answered there, not refused; in a project folder that classifier decides', async (t) => {
  const { intentFeatures } = await import('../features.js')
  assert.equal(typeof intentFeatures, 'function', 'features.js reads a message for its intent')
  const { calibrate, saveArtifact, trainMulticlass } = await import('../classifier.js')
  const { STATE_VERSION } = await import('../domains.js')
  // The intent domain at LOCAL_ONLY, as one that earned the rung leaves it, with a classifier sure
  // that this question is a task, as one that learned it wrong would be.
  const taken = 'How do I center a div?'
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-intent-'))
  cleanUp(t, dataDir)
  const samples = [
    ...Array.from({ length: 20 }, () => ({ features: intentFeatures(taken), label: 'task' })),
    ...['What is a monad?', 'Why does the build fail?', 'Can you explain closures?', 'How does the cache work?'].flatMap((m) => Array.from({ length: 5 }, () => ({ features: intentFeatures(m), label: 'question' }))),
  ]
  saveArtifact(join(dataDir, 'classifiers', 'intent.json'), calibrate(trainMulticlass({ samples, domain: 'intent', options: { epochs: 300, learningRate: 0.3 } }), samples))
  mkdirSync(join(dataDir, 'domains'), { recursive: true })
  writeFileSync(join(dataDir, 'domains', 'intent.state.json'), JSON.stringify({ stateVersion: STATE_VERSION, domain: 'intent', riskClass: 'LOW', kind: 'multiclass', maturity: 'LOCAL_ONLY', since: new Date().toISOString() }))
  const q = await plugin(t, { jobs: true, dataDir })
  jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
  t.after(() => { delete jev.said.kind })
  const project = q.agent.session.header.cwd
  for (const [where, cwd] of [['No project', join(REPO, 'no-project')], ['the scratch workspace', join(REPO, '..', 'kzh-scratch')]]) {
    q.agent.session.header.cwd = cwd
    const calls = jevIntentCalls()
    const out = await q.say(taken, { model: 'jev-auto' })
    assert.match(out.text, /^A monad chains computations/, `${where}: the question is answered, not refused: ${out.text}`)
    assert.equal(jevIntentCalls() - calls, 1, `${where}: Jev read it`)
    const sample = intentSamples(q).at(-1)
    assert.deepEqual([sample?.authority, sample?.teacher?.label, sample?.local?.label], ['jev', 'question', 'task'], `${where}: the classifier's answer is recorded beside Jev's, and decides nothing`)
  }
  // In the project folder the same classifier decides, with no Jev call, and the message runs as a task.
  q.agent.session.header.cwd = project
  const calls = jevIntentCalls()
  const out = await q.say(taken, { model: 'jev-auto' })
  assert.match(out.text, /^OK, I'll run \*\*[^*]+\*\* with /, out.text)
  assert.equal(jevIntentCalls() - calls, 0, 'the project folder: no Jev call for it')
  assert.deepEqual([intentSamples(q).at(-1)?.authority, intentSamples(q).length], ['local', 3], 'the project folder: decided on this PC, one sample a message')
  await waitFor('the result is posted', () => q.world.delivered, (d) => d.length === 1, { timeoutMs: 30_000 })
  await quiet(q.dataDir)
})

test('Jev\'s routing samples are read as the plugin starts, in the background, so the first message on a Jev row, which records its intent sample there before it is answered, does not wait for the whole file to be read', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-laya-samples-'))
  cleanUp(t, dataDir)
  writeFileSync(join(dataDir, 'routing-samples.jsonl'), '')
  // Every read of the store's file, as training.js makes it.
  const fsp = createRequire(import.meta.url)('node:fs/promises')
  const real = fsp.readFile
  const reads = []
  fsp.readFile = function readFile(path, ...rest) {
    if (String(path).startsWith(dataDir) && String(path).endsWith('routing-samples.jsonl')) reads.push(String(path))
    return real.call(this, path, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const q = await plugin(t, { dataDir })
    const atStart = await until('the store is read', () => reads.length, (n) => n >= 1, { timeoutMs: 5000 }).catch(() => reads.length)
    assert.equal(atStart, 1, 'read once as the plugin starts, with no message sent')
    jev.said.kind = (state) => (String(state?.message).includes('?') ? 'question' : 'task')
    t.after(() => { delete jev.said.kind })
    const out = await q.say('What is a monad?', { model: 'jev-auto' })
    assert.match(out.text, /^A monad chains computations/)
    await quiet(q.dataDir)
    assert.equal(intentSamples(q).length, 1, 'the question\'s intent sample is in the store')
    assert.equal(reads.length, 1, 'which it found read: the question did not wait for another read')
  } finally {
    fsp.readFile = real
    syncBuiltinESMExports()
  }
})

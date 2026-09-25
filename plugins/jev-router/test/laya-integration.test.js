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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
// done: a plugin can still be finishing a write (Laya's standing, a task record) after its test
// closed it, and that write makes its data folder again.
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
const net = { seen: [], online: true }
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  net.seen.push(url)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (url === CONNECTIVITY || url.startsWith('https://api.typesafe.ai')) return net.online ? Promise.resolve(new Response('')) : Promise.reject(new TypeError('fetch failed'))
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}
const typesafe = (url) => { try { return /typesafe/i.test(new URL(url).host) } catch { return false } }

// Jev, as the TypeSafe SDK answers for every client that is not Laya's on this PC: each call kept
// as it would leave the machine, each question answered from `jev.said` (a value or a function of
// the call's state), else by its type.
const realSystemOne = TypeSafeClient.prototype.systemOne
const jev = { calls: [], said: {} }
TypeSafeClient.prototype.systemOne = function systemOne(request, options) {
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(this.baseURL)) return realSystemOne.call(this, request, options)
  jev.calls.push({ baseURL: this.baseURL, body: JSON.stringify(request) })
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
 * since one that is closing still writes to its data folder, and then each folder it made is
 * removed. One hook per test, so a plugin made later on another's folders is closed before either
 * goes. `dirs` are that test's folders to remove.
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
 */
async function plugin(t, { installed = true, pins = true, laya = {}, settings, config = {}, jobs = false, supervisor = {}, local, dataDir: sharedData, harnessDir: sharedHarness, accounts, onSpawn } = {}) {
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
  const world = { said: {}, fakes: [], spawned: [], children, loadMs: 0, failStart: false, work: null, reply: null, delivered: [], chat: [], emitted: [] }

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
    async start(provider, opts) {
      const n = ran.push({ provider, label: opts.label, prompt: opts.prompt?.[0]?.text ?? '' })
      const result = (async () => {
        await world.work?.(opts, n)
        // A stopped agent's run rejects, as the engine's subagents do.
        opts.signal?.throwIfAborted()
        writeFileSync(join(workspace, 'state.txt'), 'fixed')
        return { stopReason: 'completed', output: [{ type: 'text', text: world.reply?.(n) ?? `Fixed it (attempt ${n}).` }], usage: {} }
      })()
      return { result, dispose: async () => {} }
    },
  }
  let jobCount = 0
  const jobService = {
    start: (spec) => { const id = `jev-${++jobCount}`; spec.run(); return id },
    wait: () => new Promise(() => {}),
    read: (id) => ({ text: '', snapshot: { id } }),
    kill: () => 'requested',
  }

  const agent = { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append: (_kind, msg) => world.delivered.push(msg) }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const routes = []
  let adapter = null
  const llm = {
    registerAdapter: (ids, a) => { if (ids.includes('jev')) adapter = a; return () => {} },
    // A chat model that answers every question the same way.
    stream: (opts) => (async function* () {
      world.chat.push({ provider: opts.provider, model: opts.model, purpose: opts.purpose ?? null })
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
    get: (name) => (name === 'jobs' && jobs ? jobService : null),
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    tools: { register: () => {} },
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
  /** One message typed into the row `model` (Laya Auto by default), as the engine streams it through the adapter. */
  async function say(text, { model = 'laya-auto', purpose, signal } = {}) {
    if (!purpose) messages.push({ role: 'user', content: [{ type: 'text', text }] })
    const out = { text: '', reasoning: '' }
    const options = purpose ? { model, purpose, messages: [{ role: 'user', content: [{ type: 'text', text }] }], sessionId: SESSION } : { model, messages: [...messages], sessionId: SESSION, signal }
    for await (const e of adapter.stream(options)) {
      if (e.type === 'text-delta') out.text += e.text
      if (e.type === 'reasoning-delta') out.reasoning += e.text
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
  return { dataDir, harnessDir, workspace, world, ran, commands, agent, say, http, slash, read, rows, close, adapter: () => adapter }
}

/** Every file under `dir`, with its size and time, so a test can wait until nothing more is written. */
function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) filesUnder(p, out)
    else { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`) }
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
const bytesUnder = (dir) => Object.fromEntries(filesUnder(dir).map((l) => l.split(':')[0]).map((p) => [p, readFileSync(p, 'utf8')]))

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
  assert.ok(r.text.endsWith(TEXT.couldNotStart('laya.serve was not ready after 0 s')), r.text)
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
  assert.match(one.text, /^Queued → Laya picks as \*\*jev-1\*\*/, one.text)
  await waitFor('the first task is running', () => q.ran.length, (n) => n === 1, { timeoutMs: 20_000 })
  const two = await q.say('Now fix the failing lint in the parser')
  assert.match(two.text, /^Queued → Laya picks as \*\*jev-2\*\* \(2nd in line/, two.text)
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

test('a Jev Auto run replies without waiting for the shadow: with Laya at 3 s a question, the reply comes before Laya has answered any of its calls', async (t) => {
  const p = await plugin(t, { settings: { shadow: true } })
  await started(p)
  // Laya, loaded and ready, now takes 3 s a question, so even the intent's three take it 9 s: a
  // run that waited for any comparison would reply no sooner than that (5.2).
  const MS_PER_ROW = 3000
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
      run: async (cmd, args) => (cmd === 'ps' && args.includes(String(gone.pid)) ? `${venvPython} -I -u -X utf8 -m laya.serve\n` : null),
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
  // An earlier session's laya.serve for the sweep to look at, under a pid no process has, whose
  // look waits until the test lets it go: the plugin is disposed in between, as a reload or a quit
  // during a slow sweep does (on Windows it asks PowerShell about each recorded pid).
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
        run: async (_cmd, args) => { if (args.join(' ').includes(String(EARLIER))) { gate.reached = true; await held } return null },
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

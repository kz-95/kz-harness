// The jev-router plugin booted with apply() on the e2e harness, for the whole-run steps of the cloud
// end-to-end test (docs/laya-auto.md 9.4 steps 6 and 7): KzH's real Laya supervisor starting the
// real laya.serve from the harness's venv, the real Laya client, shadow and stores, and around them
// only what the engine would give the plugin, as test/laya-integration.test.js stands it in: a
// model menu adapter to stream messages through, agents that fix a small git repo, routes, and
// Jev as the TypeSafe SDK answering from this file after 300 ms.
//
// Every request this process makes goes through one spy on globalThis.fetch, which the TypeSafe
// SDK and the connectivity probes call at request time: 127.0.0.1 reaches the real laya.serve,
// the connectivity probes are answered here, and anything else is refused, and each one is kept
// with its time. Jev's calls are kept by the SDK's systemOne, and a TypeSafe client built without
// a baseURL (one that would read TYPESAFE_BASE_URL) by a spy on the environment, so a step can say
// that nothing reached TypeSafe.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { TypeSafeClient } from '@typesafe-ai/sdk'

export const CONNECTIVITY = 'http://connectivity.kzh-e2e.invalid/connecttest.txt'
export const SESSION = 'e2e-session'
const JEV_MS = 300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the network and Jev

/** Every request this process made: `{ url, method, at, endAt, status, error, body }`, loopback ones included. */
export const net = { seen: [], online: true }
const realFetch = globalThis.fetch
let spying = false

/** Whether a URL names a TypeSafe host. */
export const typesafe = (url) => { try { return /typesafe/i.test(new URL(url).host) } catch { return false } }

function installFetchSpy() {
  if (spying) return
  spying = true
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input)
    const rec = { url, method: init?.method ?? 'GET', at: Date.now(), endAt: null, status: null, error: null, body: null }
    net.seen.push(rec)
    const settle = (p) => p.then((r) => { rec.endAt = Date.now(); rec.status = r.status; return r }, (e) => { rec.endAt = Date.now(); rec.error = String(e?.message ?? e); throw e })
    if (url.startsWith('http://127.0.0.1:')) {
      if (typeof init?.body === 'string') { try { rec.body = JSON.parse(init.body) } catch { rec.body = null } }
      return settle(realFetch(input, init))
    }
    if (url === CONNECTIVITY || url.startsWith('https://api.typesafe.ai')) return settle(net.online ? Promise.resolve(new Response('')) : Promise.reject(new TypeError('fetch failed')))
    return settle(Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`)))
  }
}

/**
 * Jev as the TypeSafe SDK answers for every client that is not Laya's on this PC: each call kept
 * with its body and times, answered after 300 ms: a task that changes the project, done well.
 */
export const jev = { calls: [] }
const realSystemOne = TypeSafeClient.prototype.systemOne
function installJev() {
  TypeSafeClient.prototype.systemOne = function systemOne(request, options) {
    if (/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(this.baseURL)) return realSystemOne.call(this, request, options)
    const call = { baseURL: this.baseURL, body: JSON.stringify(request), at: Date.now(), endAt: null }
    jev.calls.push(call)
    const answers = {}
    for (const [name, q] of Object.entries(request.questions)) {
      if (q.type === 'choice') {
        const keys = Array.isArray(q.criteria) ? q.criteria.map(String) : Object.keys(q.criteria)
        const c = name === 'capability' && keys.includes('project_change') ? 'project_change' : name === 'kind' ? 'task' : name === 'verdict' && keys.includes('accept') ? 'accept' : name === 'disposition' && keys.includes('PASS') ? 'PASS' : keys[0]
        answers[name] = { type: 'choice', choice: c, confidence: 0.85, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.85 : 0.15 / Math.max(1, keys.length - 1)])) }
      } else if (q.type === 'score') answers[name] = { type: 'score', score: 1, confidence: 0.8 }
      else answers[name] = { type: 'noul', noul: ['addressed', 'complete', 'needsTests'].includes(name) ? 0.95 : 0.05, confidence: 0.9 }
    }
    return sleep(JEV_MS).then(() => { call.endAt = Date.now(); return { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers } })
  }
}

/** Every TYPESAFE_BASE_URL read from inside the SDK: the SDK reads it only while it builds a client handed no baseURL. */
export const sdkEnvReads = []
function installEnvSpy() {
  const env = process.env
  process.env = new Proxy(env, { get(o, k) { if (k === 'TYPESAFE_BASE_URL' && /@typesafe-ai[\\/]sdk/.test(new Error().stack)) sdkEnvReads.push(Date.now()); return Reflect.get(o, k) } })
  return () => { process.env = env }
}

// ---------------------------------------------------------------- the PC and the plugin

const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

/** A repo whose check passes only once an agent has written "fixed" into state.txt. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kzh-laya-e2e-work-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const AGENTS = [
  { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', description: 'The native harness agent on the DeepSeek API, paid per token.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'kimi', name: 'Kimi agent', provider: 'spawn', description: 'An agent on the Moonshot API, paid per token.', enabled: true, llm: { provider: 'moonshot', model: 'kimi-k2' } },
]

/**
 * The plugin on the harness at `harnessDir`, its data in `dataDir` (made fresh; `measuredFrom`, a
 * laya.json this PC already measured, is copied in, so the first start is not a full warm-up
 * again). The DSH_HOME the plugin reads must already point at a folder of the caller's own.
 * `world.work(opts, n)` is how long each agent works before it writes the fix.
 */
export async function bootPlugin({ harnessDir, dataDir, measuredFrom, onLine = () => {} }) {
  installFetchSpy()
  installJev()
  const restoreEnv = installEnvSpy()
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  if (measuredFrom && existsSync(measuredFrom)) copyFileSync(measuredFrom, join(dataDir, 'laya.json'))
  const workspace = repo()
  // The engine home the plugin reads once, when it is first loaded: the accounts keep their .env
  // there, and this test must neither read nor write the person's own.
  const dshHome = mkdtempSync(join(tmpdir(), 'kzh-laya-e2e-dsh-'))
  process.env.DSH_HOME = dshHome
  const jevRouter = await import('../../index.js')

  // The plugin writes its lines as `[jev] ...` to stdout: kept here, and not printed.
  const lines = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk)
    if (s.startsWith('[jev] ')) { for (const l of s.trimEnd().split('\n')) { lines.push({ at: Date.now(), text: l }); onLine(l) } return true }
    return write(chunk, ...rest)
  }

  const world = { work: null, ran: [], delivered: [], chat: [], emitted: [] }
  const subagents = {
    async start(provider, opts) {
      const n = world.ran.push({ provider, label: opts.label, at: Date.now(), endAt: null })
      const result = (async () => {
        await world.work?.(opts, n)
        opts.signal?.throwIfAborted()
        writeFileSync(join(workspace, 'state.txt'), 'fixed')
        world.ran[n - 1].endAt = Date.now()
        return { stopReason: 'completed', output: [{ type: 'text', text: `Fixed it (attempt ${n}).` }], usage: {} }
      })()
      return { result, dispose: async () => {} }
    },
  }
  const agent = { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append: (_kind, msg) => world.delivered.push(msg) }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const commands = new Map()
  const routes = []
  let adapter = null
  const llm = {
    registerAdapter: (ids, a) => { if (ids.includes('jev')) adapter = a; return () => {} },
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
    credentials: { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'tsk_e2e_fake_jev' } : undefined) },
    effect, subagents,
    get: () => null,
    commands: { register: (cmd) => { commands.set(cmd.name, cmd) } },
    tools: { register: () => {} },
    inject: (_deps, fn) => fn(runtime),
  }
  jevRouter.apply(ctx, jevRouter.Config({
    agents: AGENTS,
    historyFile: join(dataDir, 'history.jsonl'),
    checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
    format: { enabled: false },
    laya: { port: await freePort(), connectivityUrl: CONNECTIVITY },
  }), { laya: { harnessDir } })

  const messages = []
  /** One message typed into the row `model`, as the engine streams it through the adapter. */
  async function say(text, { model = 'laya-auto', signal } = {}) {
    messages.push({ role: 'user', content: [{ type: 'text', text }] })
    const out = { text: '', reasoning: '' }
    for await (const e of adapter.stream({ model, messages: [...messages], sessionId: SESSION, signal })) {
      if (e.type === 'text-delta') out.text += e.text
      if (e.type === 'reasoning-delta') out.reasoning += e.text
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: out.text }] })
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

  const read = (name) => (existsSync(join(dataDir, name)) ? readFileSync(join(dataDir, name), 'utf8') : '')
  const rows = (name) => read(name).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  /** The workspace as it was before the first run, so each run starts from a failing check. */
  const resetWorkspace = () => writeFileSync(join(workspace, 'state.txt'), 'broken')

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const d of effects.reverse()) { try { await d() } catch { /* already gone */ } }
    process.stdout.write = write
    restoreEnv()
    TypeSafeClient.prototype.systemOne = realSystemOne
    globalThis.fetch = realFetch
    spying = false
    rmSync(workspace, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  }

  return { dataDir, workspace, world, lines, say, http, read, rows, resetWorkspace, close, adapter: () => adapter, commands }
}

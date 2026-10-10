// The live view through the plugin (docs/live-agent-view.md Feature 1, slice 4): apply() with just
// enough of the plugin runtime for it, Jev as the TypeSafe SDK answering from this file, background
// tasks on a job service, and spawn agents whose child is a stand-in for the engine's in-process
// agent: `localAgent.ctx.on` takes the agent-scoped listeners, `localAgent.session.snapshotEvents`
// reads its committed log, and the agent's work streams frames to the one and commits events to the
// other, in the shapes the pinned engine gives them (dsh-agent AssistantStreamFrame, dsh-session
// SessionEvent). Every route here answers 404 in the code before the slice, and `activity` is absent.
//
// First, an engine home of this file's own, before the plugin is loaded (it reads DSH_HOME once).
import 'data:text/javascript,import{mkdtempSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";process.env.DSH_HOME=mkdtempSync(join(tmpdir(),"kz-live-dsh-"))'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
// A namespace, so the file loads where the plugin lacks what these tests are about, and each test
// fails by its own assertion there.
import * as jevRouter from '../index.js'
import { waitFor } from './wait-for.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const made = [process.env.DSH_HOME]
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const SESSION = 'session-live'
const CONNECTIVITY = 'http://connectivity.kzh-test.invalid/connecttest.txt'
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })
/**
 * Poll a read until `ok` holds or the deadline passes, and give the last value read either way, for
 * the test to assert on: the code before the slice then fails by that assertion, not by a timeout.
 */
async function eventually(read, ok, { timeoutMs = 10_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await read() } catch { value = undefined }
    if (ok(value) || Date.now() > deadline) return value
    await tick(everyMs)
  }
}
/** Poll an asynchronous read until `ok` holds, with a deadline; throws with the last value read. */
async function until(label, read, ok, { timeoutMs = 10_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    let readable = true
    try { value = await read() } catch (err) { value = `not readable yet: ${err.message}`; readable = false }
    if (readable && ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${label}: still not true after ${timeoutMs} ms, last: ${JSON.stringify(value)?.slice(0, 800)}`)
    await tick(everyMs)
  }
}

// The network as this file allows it: this PC and Jev; anything else is refused.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (url === CONNECTIVITY || url.startsWith('https://api.typesafe.ai')) return Promise.resolve(new Response(''))
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}

// Jev, as the TypeSafe SDK answers: each question from `jev.said` (a value or a function of the
// call's state), else by its type, as test/laya-integration.test.js answers.
const jev = { said: {} }
TypeSafeClient.prototype.systemOne = function systemOne(request) {
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

// A repo whose check passes only once an agent has written "fixed" into state.txt.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-live-work-'))
  made.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const AGENTS = [
  { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', description: 'The native harness agent on the DeepSeek API, paid per token.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]

/**
 * The in-process child a spawn start publishes, as far as the live view reads it: `ctx.on` keeps the
 * agent-scoped listeners (throwing when `world.ctxThrows`), `session.snapshotEvents(from)` returns the
 * frozen log from `from`, and each read is recorded in `world.order`. `stream(frame)` publishes a
 * frame to the listeners and `commit(type, data)` appends an event to the log, as the agent loop does.
 * `steer(message)` keeps a Steer in `steers`, its inbox, and `claim(id)` takes one in at the next step,
 * as the agent loop does: its inbox says so, and its session commits the message. For Send now,
 * `inbox.remove(id)` takes a steer not claimed yet back out, `cancel` and `followup` are kept in
 * `world.order` as they come, and a follow-up waits in `followups` until `claim(id)` starts its turn.
 */
function childAgent(world, n) {
  const listeners = new Map()
  const log = []
  const child = {
    allow: null,
    ctx: {
      on(name, fn) {
        if (world.ctxThrows) throw new Error('this context is gone')
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(fn)
        return () => listeners.get(name)?.delete(fn)
      },
    },
    session: {
      get seq() { return log.length },
      snapshotEvents(from = 0) { world.order.push(`snapshot:${n}`); return Object.freeze(log.slice(from).map((e) => Object.freeze(e))) },
    },
    stream(frame) { for (const fn of [...(listeners.get('agent/assistant-stream') ?? [])]) fn({ agent: child, frame: Object.freeze(frame) }) },
    commit(type, data) { log.push({ seq: log.length, time: Date.now(), type, data }) },
    steers: [],
    steer(message) { child.steers.push(message) },
    claim(id) {
      const message = [...child.steers, ...child.followups].find((m) => m.id === id)
      child.claimed.add(id)
      for (const fn of [...(listeners.get('agent/inbox/claimed') ?? [])]) fn({ agent: child, message, turn: 1 })
      child.commit('user/message', message)
    },
    claimed: new Set(),
    inbox: {
      remove(id) {
        const i = child.steers.findIndex((m) => m.id === id)
        if (i < 0 || child.claimed.has(id)) return false
        child.steers.splice(i, 1)
        world.order.push(`remove:${id}`)
        return true
      },
    },
    cancel(cause, options) { world.order.push(`cancel:${cause?.kind}:${options?.keepInbox === true ? 'keepInbox' : 'clear'}`) },
    followups: [],
    followup(message) { world.order.push(`followup:${message.id}`); child.followups.push(message) },
    listening: (name) => listeners.get(name)?.size ?? 0,
  }
  return child
}

/** One model step of a child that thinks, says `text`, and calls `tool` with `args`, which gives `result`; frames, then what is committed. */
function step(child, { attempt = 'llm-1', turn = 1, step: s = 1, reasoning = 'Look first.', text, tool, callId = 'call-1', args = {}, result = 'ok', meta } = {}) {
  const a = JSON.stringify(args)
  child.stream({ type: 'start', attemptId: attempt, revision: 1, turn, step: s })
  let i = 0
  const chunk = (c) => child.stream({ type: 'chunk', attemptId: attempt, revision: 1, index: i++, time: Date.now(), chunk: c })
  chunk({ type: 'block-start', index: 0, blockType: 'reasoning' })
  chunk({ type: 'reasoning-delta', index: 0, text: reasoning })
  chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
  if (text) {
    chunk({ type: 'block-start', index: 1, blockType: 'text' })
    chunk({ type: 'text-delta', index: 1, text })
    chunk({ type: 'block-end', index: 1, block: { type: 'text', text } })
  }
  if (tool) {
    chunk({ type: 'block-start', index: 2, blockType: 'tool-call' })
    chunk({ type: 'tool-call-delta', index: 2, id: callId, name: tool, argumentsDelta: a })
    chunk({ type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: tool, arguments: a } })
  }
  chunk({ type: 'usage', usage: { inputTokens: 900, outputTokens: 100 } })
  const content = [{ type: 'reasoning', text: reasoning }, ...(text ? [{ type: 'text', text }] : []), ...(tool ? [{ type: 'tool-call', id: callId, name: tool, arguments: a }] : [])]
  child.commit('assistant/message', { turn, step: s, message: { id: `m-${turn}-${s}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content }, stream: [], usage: { inputTokens: 900, outputTokens: 100 } })
  child.stream({ type: 'end', attemptId: attempt, revision: 1, index: i, outcome: { kind: 'committed', eventType: 'assistant/message', seq: child.session.seq - 1 } })
  if (tool) {
    child.commit('tool/call', { turn, step: s, callId, name: tool, arguments: a })
    child.commit('tool/result', { turn, step: s, message: { id: `r-${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: result }] }] }, ...(meta ? { meta } : {}) })
  }
}

/**
 * The plugin on a PC of its own, closed when the test ends. `world.work(opts, n, child)` is what the
 * n-th agent started does before it answers `world.reply?.(n)` (a promise to hold it at work); a
 * child that is not locked writes "fixed" into state.txt as it ends, and `world.dispose?.(n)` holds
 * its dispose(). Each start keeps the prompt it was handed. A start of the `claude-code` provider has no in-process child, as Claude Code's
 * connector has none, and each start keeps the engine patch's fields it was handed (`kzhTap`,
 * `kzhControl`), whose hooks `world.publish(control, n, provider)` fills as the start returns, as the
 * patch does. `dataDir` shares a data folder with an earlier plugin, as a restart does,
 * `liveStore(dataDir)` gives the plugin a live store of the test's own, and `providers` are provider
 * rows `getProvider` knows besides spawn (Claude Code's read-only row, say). `reload` names the plugin
 * closed just before, which the engine applies again as a setting changes: the engine's parts are that
 * one's (the data folder, the workspace, the chat's agent, the agents it starts and its job service),
 * and so is the registry its work still going is handed over through (handover.js), where a plugin
 * on a data folder shared otherwise starts as after a restart of the app, with nothing handed over.
 * `processRegistry` hands it no registry, so it uses the process's own, as the engine applies it.
 */
async function plugin(t, { config = {}, dataDir: shared = null, workspace: sharedWork = null, liveStore = null, providers = {}, reload = null, processRegistry = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-live-'))
  made.push(root)
  // Imported here, so this file still loads where there is no handover.js.
  const { createHandover } = await import('../handover.js').catch(() => ({}))
  const handover = processRegistry ? undefined : reload?.engine.handover ?? createHandover?.()
  const dataDir = reload?.dataDir ?? shared ?? join(root, 'data')
  const harnessDir = join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  const pinsFile = join(harnessDir, 'config', 'laya.json')
  mkdirSync(dirname(pinsFile), { recursive: true })
  copyFileSync(join(REPO, 'config', 'laya.json'), pinsFile)
  const workspace = reload?.workspace ?? sharedWork ?? repo()
  // `usage` is what a child's result says it spent; left undefined, the result has no `usage`, as the Claude Code and Codex connectors' results have none.
  const world = reload?.world ?? { work: null, reply: null, order: [], children: [], started: [], ctxThrows: false, notices: [], delivered: [], usage: {} }
  const subagents = reload?.engine.subagents ?? {
    getProvider: (name) => (name === 'spawn' ? { capabilities: { toolFilter: true } } : providers[name]),
    async start(provider, opts) {
      const n = world.started.push({ provider, label: opts.label, prompt: opts.prompt?.[0]?.text ?? '', toolFilter: opts.toolFilter ?? null, kzhTap: opts.kzhTap ?? null, kzhControl: opts.kzhControl ?? null })
      // A patched connector fills the control's hooks as its run starts, before the start returns.
      if (opts.kzhControl) world.publish?.(opts.kzhControl, n, provider)
      const child = provider === 'spawn' ? childAgent(world, n) : null
      if (child) child.allow = opts.toolFilter?.allow ?? null
      world.children.push(child)
      const result = (async () => {
        // A child's first model call is a round trip away, so its first frame comes after the start
        // has returned, as the engine's does.
        await tick(0)
        await world.work?.(opts, n, child)
        opts.signal?.throwIfAborted()
        // Claude Code in plan mode, its read-only row, writes nothing either.
        if (!opts.toolFilter?.allow && provider !== 'claude-code-readonly') writeFileSync(join(workspace, 'state.txt'), 'fixed')
        return { stopReason: 'completed', output: [{ type: 'text', text: world.reply?.(n) ?? `Fixed it (attempt ${n}).` }], ...(world.usage === undefined ? {} : { usage: world.usage }) }
      })()
      result.catch(() => {})
      return { id: `child-session-${n}`, result, localAgent: child ?? undefined, dispose: async () => { world.order.push(`dispose:${n}`); await world.dispose?.(n) } }
    },
  }
  let jobCount = 0
  const jobService = reload?.engine.jobService ?? { start: (spec) => { const id = `jev-${++jobCount}`; spec.run(); return id }, wait: () => new Promise(() => {}), read: (id) => ({ text: '', snapshot: { id } }), kill: () => 'requested' }
  const isResult = (msg) => String(msg?.source?.summary ?? '').includes('·')
  const agent = reload?.engine.agent ?? { id: SESSION, session: { id: SESSION, header: { cwd: workspace }, append: (_kind, msg) => (isResult(msg) ? world.delivered : world.notices).push(msg) }, whenIdle: async () => {} }
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const routes = []
  const tools = new Map()
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
    credentials: { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'tsk_live_test_key' } : undefined) },
    effect, subagents,
    get: (name) => (name === 'jobs' ? jobService : null),
    commands: { register: () => {} },
    // The read tools are mounted and presented natively, and a child sees its allow list.
    tools: {
      register: (tool) => { tools.set(tool.name, tool) },
      get: (name) => tools.get(name) ?? (['read', 'glob', 'grep'].includes(name) ? { name } : undefined),
      modeFor: () => 'native',
      schemas: (scope) => (scope?.allow ?? [...tools.keys()]).map((name) => ({ name })),
    },
    inject: (_deps, fn) => fn(runtime),
  }
  jevRouter.apply(ctx, jevRouter.Config({
    agents: AGENTS,
    historyFile: join(dataDir, 'history.jsonl'),
    checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
    format: { enabled: false },
    ...config,
    laya: { port: await freePort(), connectivityUrl: CONNECTIVITY },
  }), {
    laya: { harnessDir, run: async () => null, timing: { readyPollMs: 20, healthTimeoutMs: 1000, idleCheckMs: 20, exitWaitMs: 2000 } },
    localModels: { modules: [], modelsDir: join(harnessDir, 'no-models') },
    live: { pumpMs: 20, ...(liveStore ? { store: liveStore(dataDir) } : {}) },
    handover,
  })
  let closed = false
  const close = async () => { if (closed) return; closed = true; for (const d of effects.reverse()) { try { await d() } catch { /* already gone */ } } }
  t.after(close)
  // A request to the plugin's routes: `body` as JSON, or `raw` text as `type` says.
  function http(method, path, body, { type = 'application/json', raw = null } = {}) {
    const req = Readable.from(raw !== null ? [Buffer.from(raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: method === 'GET' ? {} : { 'content-type': type } })
    return new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }) } }
      routes[0].handler(req, res).catch(reject)
    })
  }
  const messages = []
  async function say(text, { model = 'jev-auto' } = {}) {
    messages.push({ role: 'user', content: [{ type: 'text', text }] })
    let out = ''
    for await (const e of adapter.stream({ model, messages: [...messages], sessionId: SESSION, signal: new AbortController().signal })) if (e.type === 'text-delta') out += e.text
    messages.push({ role: 'assistant', content: [{ type: 'text', text: out }] })
    return out
  }
  const tasks = async () => (await http('GET', '/jev-router/tasks')).body.tasks
  const live = async (q) => http('GET', `/jev-router/live?${q}`)
  return { dataDir, workspace, world, http, say, tasks, live, close, engine: { subagents, jobService, agent, handover } }
}

const keyOf = (reply) => /\[jev-job\]: kzh-job-1-([\w-]+)/.exec(reply)?.[1] ?? null
/** Until the file has not changed for `forMs`: the task list's coalesced writes have landed. */
async function settled(file, { forMs = 900 } = {}) {
  let last = existsSync(file) ? readFileSync(file, 'utf8') : ''
  let since = Date.now()
  for (const deadline = Date.now() + 15_000; Date.now() - since < forMs;) {
    if (Date.now() > deadline) throw new Error(`${file} kept changing`)
    await tick(50)
    const now = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (now !== last) { last = now; since = Date.now() }
  }
  return last
}

test('a spawn fake with localAgent.ctx.on and session.snapshotEvents: GET /jev-router/live?task=<key> returns its items across a read pass and the writer pass after it', async (t) => {
  const p = await plugin(t)
  // Jev reads the message as only reading, routed as a reading of the project: a read pass first.
  jev.said = { readOnly: 0.93, capability: 'project_read' }
  t.after(() => { jev.said = {} })
  p.world.work = async (_opts, n, child) => {
    if (n === 1) step(child, { reasoning: 'Read the parser.', text: 'The fix needs a file changed.', tool: 'read', callId: 'r1', args: { file_path: 'state.txt' }, result: 'broken' })
    else step(child, { reasoning: 'Write the fix.', tool: 'edit', callId: 'e1', args: { file_path: 'state.txt', old_string: 'broken', new_string: 'fixed' }, meta: { diffs: [{ path: 'state.txt', oldText: 'broken', newText: 'fixed' }] } })
  }
  // The read pass says it needs to write, which hands the task back to its folder's line.
  p.world.reply = (n) => (n === 1 ? 'I can see the bug.\nNEEDS-WRITE-ACCESS\nstate.txt has to change.' : 'Fixed it.')
  const reply = await p.say('Look at the parser and tidy it')
  const key = keyOf(reply)
  assert.ok(key, reply)
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const row = (await p.tasks()).find((x) => x.key === key)
  assert.equal(row.runIds.length, 2, 'a read pass, then a pass that writes')
  assert.equal(p.world.started[0].toolFilter?.allow?.length > 0, true, 'the first ran locked')
  const res = await p.live(`task=${key}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const { runs, done, saved, task } = res.body
  assert.deepEqual(runs.map((r) => r.runId), row.runIds, 'both passes, in order')
  assert.deepEqual([done, saved, task.state], [true, false, 'completed'])
  const [read, write] = runs
  const shown = (r) => r.items.filter((i) => !i.meta.hidden).map((i) => [i.kind, i.title])
  assert.deepEqual(shown(read).filter(([k]) => k !== 'status'), [['reasoning', 'Thinking'], ['text', ''], ['tool', 'Read state.txt']], 'the read pass\'s own steps')
  assert.ok(read.items.some((i) => i.kind === 'text' && i.text === 'The fix needs a file changed.'))
  assert.ok(shown(read).some(([, title]) => /^Needs the folder after all/.test(title)), 'and the hand-back, in the router\'s words')
  assert.deepEqual(shown(write).filter(([k]) => k !== 'status'), [['reasoning', 'Thinking'], ['file', 'Edited state.txt +1 -1']], 'the writer\'s')
  assert.deepEqual(write.attempts.map((a) => [a.role, a.name, a.detail, a.child?.id]), [['primary', 'DeepSeek agent', 'live', 'child-session-2']])
  assert.equal(write.summary.done.label, 'Completed')
  assert.equal(read.summary.done.label, 'Handed back to its folder\'s line')
  // Only what changed since a version a poll already has comes again.
  const again = await p.live(`task=${key}&after=${res.body.v}`)
  assert.deepEqual(again.body.runs.map((r) => r.items.length), [0, 0])
  assert.deepEqual((await p.live('task=not-a-task')).status, 404)
  assert.deepEqual((await p.live(`task=${key}&run=x`)).status, 400)
  assert.deepEqual((await p.live(`task=${key}&after=-1`)).status, 400)
})

test('GET /jev-router/live?run=<runId> reads one run by its id, whole and then only what changed since, and says done once it has ended; an unknown run is 404', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => release())
  let child = null
  p.world.work = async (_opts, _n, c) => { child = c; step(c, { reasoning: 'Run the check.', tool: 'bash', callId: 'b1', args: { command: 'npm test' }, result: 'FAIL' }); await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  const id = await eventually(async () => (await p.tasks()).find((x) => x.key === key)?.runIds?.at(-1), Boolean)
  const working = await eventually(() => p.live(`run=${id}`), (r) => r?.body?.runs?.[0]?.items?.some((i) => i.kind === 'command'))
  assert.equal(working?.status, 200, JSON.stringify(working?.body))
  assert.deepEqual(working.body.runs.map((r) => r.runId), [id], 'that run alone')
  assert.deepEqual([working.body.done, working.body.saved, working.body.task], [false, false, undefined], 'still at work, and read by its id, not its task')
  release()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const ended = await p.live(`run=${id}&after=${working.body.v}`)
  assert.equal(ended.body.done, true, 'it has ended')
  assert.ok(ended.body.runs[0].items.length > 0 && ended.body.runs[0].items.every((i) => i.v > working.body.v), 'what changed since, and only that')
  assert.equal(ended.body.runs[0].summary.done.label, 'Completed')
  assert.equal((await p.live('run=no-such-run')).status, 404)
})

test('a run still going as the plugin closes saves no transcript as it ends: the plugin applied again keeps the task list and the files beside it, so a task it clears meanwhile leaves none behind', async (t) => {
  const { createLiveStore } = await import('../live.js')
  let old = null
  const p = await plugin(t, { liveStore: (dataDir) => (old = createLiveStore({ dir: join(dataDir, 'live') })) })
  let release
  const held = new Promise((r) => { release = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => release())
  let working = false
  p.world.work = async () => { working = true; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => working, Boolean, { timeoutMs: 20_000 })
  assert.equal((await p.live(`task=${key}`)).status, 200, 'the task has a live view')
  const file = join(p.dataDir, 'live', `${key}.jsonl`)
  // The plugin closes while the task's agent works, and one is applied on the same data with nothing
  // handed over to it, as when none was applied again within the bound (handover.js): the task the
  // closed plugin still runs is not its own.
  await p.close()
  const q = await plugin(t, { dataDir: p.dataDir, workspace: p.workspace })
  const row = await until('the plugin applied again reads the task as stopped', async () => (await q.tasks()).find((x) => x.key === key), (r) => r?.state === 'stopped')
  assert.deepEqual((await q.http('POST', '/jev-router/tasks/clear', { jobIds: [row.jobId] })).body, { cleared: [row.jobId] })
  // The old plugin's agent answers, and its run ends.
  release()
  await until('the old run has ended', async () => old.stats().live, (n) => n === 0, { timeoutMs: 30_000 })
  await old.flushed()
  assert.equal(existsSync(file), false, 'no transcript was saved for the task no list holds')
  assert.deepEqual((await q.tasks()).filter((x) => x.key === key), [])
})

test('a run still going as the engine applies the plugin again goes on in the plugin applied again, which takes its task over: its live view goes on there, Steer from there reaches its agent and is read back there, and its transcript is saved as it ends', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  const at = await eventually(() => p.live(`task=${key}`), (r) => r?.body?.runs?.length === 1)
  assert.equal(at?.status, 200, 'the task has a live view')
  // The engine applies the plugin again, a setting changed, while the task's agent works.
  await p.close()
  const q = await plugin(t, { reload: p })
  const row = await eventually(() => rowOf(q, key), Boolean)
  assert.equal(row?.state, 'running', 'at work in the plugin applied again, not stopped by a restart')
  const seen = await q.live(`task=${key}`)
  assert.equal(seen.status, 200, JSON.stringify(seen.body))
  assert.deepEqual([seen.body.saved, seen.body.done, seen.body.runs.map((r) => r.runId)], [false, false, at.body.runs.map((r) => r.runId)], 'the same run, live, still going')
  // Steer from the plugin applied again reaches the agent at work in the closed one, and what becomes
  // of the words is read back here.
  const res = await steerOf(q, key, 'use tabs')
  assert.deepEqual([res.status, res.body?.result], [200, 'sent'], JSON.stringify(res.body))
  assert.deepEqual(child.steers.map((x) => x.id), [res.body.id], 'its inbox has the words')
  child.claim(res.body.id)
  const read = await eventually(async () => (await rowOf(q, key))?.steers?.[0], (x) => x?.state === 'delivered')
  assert.equal(read?.state, 'delivered')
  const since = await eventually(() => q.live(`task=${key}&after=${seen.body.v}`), (r) => r?.body?.runs?.[0]?.items?.some((i) => i.kind === 'steer' && i.meta?.state === 'delivered'))
  assert.ok(since?.body?.runs?.[0]?.items?.some((i) => i.kind === 'steer' && i.meta?.state === 'delivered'), 'its live view there has the words read, as a change since')
  open()
  await waitFor('the result is posted', () => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.match(q.world.delivered[0].content[0].text, /^Your guidance "use tabs": read by DeepSeek agent\.$/m)
  assert.equal(await eventually(() => existsSync(join(q.dataDir, 'live', `${key}.jsonl`)), Boolean), true, 'its transcript is saved as it ends')
  assert.equal((await rowOf(q, key))?.state, 'completed')
})

test('a run the plugin applied again took over keeps its transcript by that plugin\'s Keep transcripts as it ends: switched off there, none is saved', async (t) => {
  const { createLiveStore } = await import('../live.js')
  let store
  const p = await plugin(t, { liveStore: (dataDir) => (store = createLiveStore({ dir: join(dataDir, 'live') })) })
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  await p.close()
  const q = await plugin(t, { reload: p })
  assert.equal((await eventually(() => rowOf(q, key), Boolean))?.state, 'running', 'taken over')
  assert.equal((await q.http('POST', '/jev-router/live/settings', { transcripts: 'off' })).body.transcripts, 'off')
  open()
  await waitFor('the result is posted', () => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal((await eventually(() => rowOf(q, key), (r) => r?.state === 'completed'))?.state, 'completed')
  // The plugin applied again goes on with the same store, so this waits for what its run's end asked of it.
  await store.flushed()
  assert.equal(existsSync(join(q.dataDir, 'live', `${key}.jsonl`)), false, 'no transcript is saved under Off, though the plugin that started the run kept them')
})

test('a run that ends after the plugin closed, before the engine has applied it again, has its transcript saved by the plugin applied again as it takes the task over', async (t) => {
  const { createLiveStore } = await import('../live.js')
  let old
  const p = await plugin(t, { liveStore: (dataDir) => (old = createLiveStore({ dir: join(dataDir, 'live') })) })
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  await p.close()
  // The agent answers while the plugin is closed and not yet applied again: the run ends in the
  // closures of the plugin that closed, whose live store saves nothing then.
  open()
  await until('the run has ended', async () => old.stats().live, (n) => n === 0, { timeoutMs: 30_000 })
  await old.flushed()
  const file = join(p.dataDir, 'live', `${key}.jsonl`)
  assert.equal(existsSync(file), false, 'no transcript is saved while no plugin is applied')
  const q = await plugin(t, { reload: p })
  assert.equal(await eventually(() => existsSync(file), Boolean), true, 'the plugin applied again saves it as it goes on with the live store')
  assert.equal((await q.live(`task=${key}`)).body?.runs?.length, 1, 'and its Live tab shows the run')
  const posted = await eventually(() => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal(posted, 1, 'its result is posted, once')
  assert.equal((await rowOf(q, key))?.state, 'completed')
})

test('a plugin applied again with no registry handed in takes over through the process\'s own the task the plugin closed before it still had at work, as the engine applies it', async (t) => {
  const p = await plugin(t, { processRegistry: true })
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  await p.close()
  const q = await plugin(t, { reload: p, processRegistry: true })
  const row = await eventually(() => rowOf(q, key), Boolean)
  assert.equal(row?.state, 'running', 'at work in the plugin applied again, not stopped by a restart')
  open()
  const posted = await eventually(() => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal(posted, 1, 'its result is posted there, once')
  assert.equal((await rowOf(q, key))?.state, 'completed')
})

test('the recorded call order shows the last snapshot read before dispose()', async (t) => {
  const p = await plugin(t)
  // The child commits its last step just as it answers, after the pump last ran: a call and its result,
  // which only its session holds, since what streams says only that the call is being made.
  p.world.work = async (_opts, _n, child) => { await tick(60); step(child, { reasoning: 'Done thinking.', text: 'All fixed.', tool: 'bash', callId: 'b1', args: { command: 'npm test' }, result: 'ok' }) }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const order = p.world.order.filter((x) => x.endsWith(':1'))
  const lastRead = order.lastIndexOf('snapshot:1')
  assert.ok(lastRead >= 0, `the child's session was read: ${order.join(', ')}`)
  assert.equal(order.indexOf('dispose:1'), lastRead + 1, `read last, then disposed of, and never read after: ${order.join(', ')}`)
  const res = await p.live(`task=${key}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.ok(res.body.runs[0].items.some((i) => i.kind === 'text' && i.text === 'All fixed.'), 'what it streamed last is there')
  const ran = res.body.runs[0].items.find((i) => i.kind === 'command')
  assert.deepEqual([ran?.title, ran?.state], ['Ran npm test', 'done'], 'and the result it committed last, read before the child was disposed of')
  assert.equal(p.world.children[0].listening('agent/assistant-stream'), 0, 'and its listener was let go')
})

test('a ctx.on that throws still yields items from the pump', async (t) => {
  const p = await plugin(t)
  p.world.ctxThrows = true
  p.world.work = async (_opts, _n, child) => { step(child, { reasoning: 'Check the state file.', text: 'Running the check.', tool: 'bash', callId: 'b1', args: { command: 'npm test' }, result: 'ok' }); await tick(80) }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const res = await p.live(`task=${key}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const { runs } = res.body
  const agentItems = runs[0].items.filter((i) => !i.router)
  assert.deepEqual(agentItems.map((i) => [i.kind, i.title, i.state]), [['reasoning', 'Thinking', 'done'], ['text', '', 'done'], ['command', 'Ran npm test', 'done']])
  assert.equal(runs[0].summary.tools, 1)
  assert.equal(runs[0].summary.tokens, 1000)
})

test('500 live events leave tasks.jsonl byte-identical after tasks.flushed()', async (t) => {
  const p = await plugin(t)
  let streamNow
  let finish
  const held = new Promise((r) => { finish = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => finish())
  p.world.work = async (_opts, _n, child) => { streamNow = child; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => streamNow, Boolean, { timeoutMs: 20_000 })
  const file = join(p.dataDir, 'tasks.jsonl')
  // Past the task list's coalesced write, so the file holds the running task as it stands: the
  // plugin keeps its task list to itself, so the file settling stands in for tasks.flushed().
  const before = await settled(file)
  assert.match(before, new RegExp(key))
  assert.equal((await p.live(`task=${key}`)).status, 200, 'the task has a live view')
  streamNow.stream({ type: 'start', attemptId: 'llm-9', revision: 1, turn: 1, step: 1 })
  streamNow.stream({ type: 'chunk', attemptId: 'llm-9', revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  for (let i = 0; i < 498; i++) streamNow.stream({ type: 'chunk', attemptId: 'llm-9', revision: 1, index: i + 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } })
  const live = await eventually(async () => (await p.live(`task=${key}`)).body, (b) => b?.runs?.[0]?.items?.some((i) => i.kind === 'text' && i.text.length === 498))
  assert.ok(live?.runs?.[0]?.items?.some((i) => i.kind === 'text' && i.text === 'x'.repeat(498)), 'the live view has every delta')
  assert.equal(live.done, false)
  const after = await settled(file)
  assert.equal(after, before, 'not one event reached the task\'s record')
  finish()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
})

test('GET /tasks shows activity for a live task', async (t) => {
  const p = await plugin(t)
  let finish
  const held = new Promise((r) => { finish = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => finish())
  let child
  p.world.work = async (_opts, _n, c) => {
    child = c
    step(c, { reasoning: 'Run the tests first.', tool: 'bash', callId: 'b1', args: { command: 'npm test' }, result: 'FAIL' })
    c.stream({ type: 'start', attemptId: 'llm-2', revision: 1, turn: 1, step: 2 })
    c.stream({ type: 'chunk', attemptId: 'llm-2', revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    c.stream({ type: 'chunk', attemptId: 'llm-2', revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'The test fails because' } })
    await held
  }
  const reply = await p.say('Fix the state file', { model: 'agent-deepseek' })
  const key = keyOf(reply)
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  const row = await eventually(async () => (await p.tasks()).find((x) => x.key === key), (r) => r?.activity?.tools === 1)
  assert.ok(row?.activity, 'the row says what its work does')
  const a = row.activity
  assert.equal(a.phrase, 'Writing')
  assert.equal(a.agent, 'DeepSeek agent')
  assert.equal(a.tokens, 1000)
  assert.equal(a.detail, 'live')
  assert.equal(a.live, true)
  assert.equal(typeof a.rate, 'number')
  assert.ok(a.lastActivityAt > 0 && a.quietMs >= 0)
  assert.deepEqual(a.recent.map((r) => r.title).slice(-3), ['Thinking', 'Ran npm test', 'The test fails because'])
  assert.equal(a.done, null)
  finish()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const ended = (await p.tasks()).find((x) => x.key === key).activity
  assert.match(ended.phrase, /^Done in \d+s$/)
  assert.equal(ended.done.label, 'Completed')
  // The activity is worked out as the list is read, and never saved with the task.
  assert.doesNotMatch(readFileSync(join(p.dataDir, 'tasks.jsonl'), 'utf8'), /"activity"/)
})

test('Clear deletes dataDir/live/<key>.jsonl', async (t) => {
  const p = await plugin(t)
  p.world.work = async (_opts, _n, child) => { step(child, { text: 'Fixed.' }) }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const file = join(p.dataDir, 'live', `${key}.jsonl`)
  assert.equal(await eventually(() => existsSync(file), Boolean), true, 'its transcript is saved')
  assert.match(readFileSync(file, 'utf8'), /"Fixed\."/)
  const row = (await p.tasks()).find((x) => x.key === key)
  // Marked read, as the page does once the result is on screen, which a clear does not need but a
  // trim would.
  assert.deepEqual((await p.http('POST', '/jev-router/tasks/clear', { jobIds: [row.jobId] })).body, { cleared: [row.jobId] })
  assert.equal(await eventually(() => existsSync(file), (x) => x === false), false, 'its transcript is gone')
})

test('after a restart the Live tab reads a finished task from its saved transcript, and says so', async (t) => {
  const p = await plugin(t)
  p.world.work = async (_opts, _n, child) => { step(child, { reasoning: 'Look at it.', text: 'Fixed the state file.', tool: 'bash', callId: 'b1', args: { command: 'npm test' }, result: 'ok' }) }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const first = await p.live(`task=${key}`)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const fresh = first.body
  assert.equal(await eventually(() => existsSync(join(p.dataDir, 'live', `${key}.jsonl`)), Boolean), true, 'its transcript is saved')
  await p.close()
  const q = await plugin(t, { dataDir: p.dataDir, workspace: p.workspace })
  const res = await q.live(`task=${key}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.saved, true)
  assert.equal(res.body.done, true)
  assert.deepEqual(res.body.runs[0].items.map((i) => [i.kind, i.title, i.text]), fresh.runs[0].items.map((i) => [i.kind, i.title, i.text]))
  assert.equal(res.body.runs[0].summary.done.label, 'Completed')
  assert.equal((await q.live(`task=${key}&after=${res.body.v + 1}`)).body.runs.length, 0, 'read once: it does not change')
})

test('a Claude Code task shows the router\'s steps and says its live detail is off, and why', async (t) => {
  const p = await plugin(t, { config: { agents: [{ id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'The Claude Code CLI.', enabled: true }] } })
  let finish
  const held = new Promise((r) => { finish = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => finish())
  p.world.work = async () => { await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-claude' }))
  await until('it is at work', async () => (await p.tasks()).find((x) => x.key === key), (r) => r?.state === 'running', { timeoutMs: 20_000 })
  const row = await eventually(async () => (await p.tasks()).find((x) => x.key === key), (r) => r?.activity?.detail === 'off')
  assert.equal(row?.activity?.detail, 'off', 'its row says its live detail is off')
  assert.equal(row.activity.phrase, 'Working (live detail is off for Claude Code: see Settings, Jev setup, Live agent view)')
  assert.equal(row.activity.rate, null, 'no rate for a stream this build cannot read')
  const read = await p.live(`task=${key}`)
  assert.equal(read.status, 200, JSON.stringify(read.body))
  const res = read.body
  // This file's engine home has no connectors at all: the engine patch has nothing to be in.
  assert.deepEqual(res.patches['claude-code'], { on: false, why: 'its connector is not installed' })
  assert.deepEqual(res.runs[0].attempts.map((a) => [a.name, a.detail, a.why, a.child]), [['Claude Code', 'off', 'its connector is not installed', null]])
  assert.deepEqual(res.runs[0].items.map((i) => i.title), ['You picked Claude Code', 'Checks before start: test fail'])
  finish()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
})

test('once an agent this build cannot hear has answered, its task\'s line says its checks come next, not that it still works, while its process is let go', async (t) => {
  const p = await plugin(t, { config: { agents: [{ id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'The Claude Code CLI.', enabled: true }] } })
  let release
  const disposing = new Promise((r) => { release = r })
  // Let go of the agent's process however the test ends, so its run ends too.
  t.after(() => release())
  let answered = false
  p.world.dispose = async () => { answered = true; await disposing }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-claude' }))
  await waitFor('its agent has answered', () => answered, Boolean, { timeoutMs: 20_000 })
  const row = (await p.tasks()).find((x) => x.key === key)
  assert.equal(row?.activity?.phrase, 'Running your checks: test', 'its result is in, and its checks are what come next')
  assert.equal(row.activity.heard, true, 'the router\'s steps, which this build hears')
  release()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
})

test('a task whose read pass the store let go of: a poll reads that pass from its saved transcript with the version of what it read, calls nothing saved while the task works, and the pass that writes is saved beside it', async (t) => {
  const { createLiveStore } = await import('../live.js')
  let store = null
  let gate = null
  let loading = 0
  const p = await plugin(t, {
    liveStore: (dataDir) => {
      store = createLiveStore({ dir: join(dataDir, 'live') })
      // A read of a saved transcript waits for the test, so the work can move on meanwhile.
      const load = store.load
      store.load = async (key) => { loading++; await gate; return load(key) }
      return store
    },
  })
  // Jev reads the message as only reading: a read pass first, which hands the task back to write.
  jev.said = { readOnly: 0.93, capability: 'project_read' }
  t.after(() => { jev.said = {} })
  let writer = null
  let finish
  const held = new Promise((r) => { finish = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => finish())
  p.world.work = async (_opts, n, child) => {
    if (n === 1) { step(child, { reasoning: 'Read the parser.', text: 'The fix needs a file changed.', tool: 'read', callId: 'r1', args: { file_path: 'state.txt' }, result: 'broken' }); return }
    step(child, { reasoning: 'Write the fix.', text: 'Writing the fix.' })
    writer = child
    await held
  }
  p.world.reply = (n) => (n === 1 ? 'I can see the bug.\nNEEDS-WRITE-ACCESS\nstate.txt has to change.' : 'Fixed it.')
  const key = keyOf(await p.say('Look at the parser and tidy it'))
  await waitFor('the pass that writes is at work', () => writer, Boolean, { timeoutMs: 30_000 })
  const ids = await eventually(async () => (await p.tasks()).find((x) => x.key === key)?.runIds, (r) => r?.length === 2)
  assert.equal(ids?.length, 2, 'a read pass, then a pass that writes')
  const [readPass, writePass] = ids
  const file = join(p.dataDir, 'live', `${key}.jsonl`)
  assert.equal(await eventually(() => existsSync(file), Boolean), true, 'the read pass was saved as it ended')
  // Forty other runs end while the task works, and the store lets go of its read pass (LIVE_CAPS.finished).
  for (let i = 0; i < 40; i++) { store.open(`other-${i}`, {}); store.finish(`other-${i}`) }
  assert.equal(store.has(readPass), false, 'its read pass is no longer held')
  // A poll from the start reads the pass that writes, then the saved read pass; meanwhile the pass that
  // writes says more.
  let open
  gate = new Promise((r) => { open = r })
  const pending = p.live(`task=${key}`)
  assert.equal(await eventually(() => loading, Boolean), 1, 'the saved read pass is being read')
  writer.stream({ type: 'start', attemptId: 'llm-9', revision: 1, turn: 1, step: 2 })
  writer.stream({ type: 'chunk', attemptId: 'llm-9', revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  writer.stream({ type: 'chunk', attemptId: 'llm-9', revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Now the docs.' } })
  open()
  const first = await pending
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.runs.map((r) => r.runId), [readPass, writePass], 'the read pass from its file, the pass that writes as it works')
  assert.equal(first.body.saved, false, 'a task still at work is not a saved transcript, whose report is in the chat')
  const next = await p.live(`task=${key}&after=${first.body.v}`)
  assert.ok(next.body.runs.some((r) => r.items.some((i) => i.text === 'Now the docs.')), 'what changed as the file was read comes with the next poll')
  // The pass that writes ends and is saved; in time the store lets go of it too.
  gate = null
  finish()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  await store.flushed()
  for (let i = 40; i < 80; i++) { store.open(`other-${i}`, {}); store.finish(`other-${i}`) }
  assert.equal(store.has(writePass), false)
  const res = await p.live(`task=${key}`)
  assert.deepEqual(res.body.runs.map((r) => r.runId), [readPass, writePass], 'both passes are on disk: saving the second kept the first')
  assert.equal(res.body.saved, true, 'the task has ended, and its report is in the chat')
})

// ---- the engine patch for Claude Code and Codex (slice 5) -------------------------------------------

const CLAUDE = { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'The Claude Code CLI.', enabled: true }
const CODEX = { id: 'codex', name: 'Codex', provider: 'codex', description: 'The Codex CLI.', enabled: true }
const MARKER = '/* KZH_AGENT_LIVE 2: patched by Kz-harness scripts/patch-agent-live.mjs */'
/** Put a connector in this file's engine home, patched or not; it is taken away when the test ends. */
function connector(t, pkg, patched) {
  const file = join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai', `dsh-subagent-${pkg}`, 'lib', 'index.js')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, patched ? `var a = 1;\n${MARKER}\n` : 'var a = 1;\n')
  t.after(() => rmSync(join(process.env.DSH_HOME, 'profiles'), { recursive: true, force: true }))
}
const handed = (s) => [s.provider, s.kzhTap === null ? 'no tap' : typeof s.kzhTap, s.kzhControl === null ? 'no control' : typeof s.kzhControl]
/**
 * A Codex command-line tool of the test's own, first on the PATH while the test runs: signed in, and an
 * app-server that answers the usage questions with room to spare (as test/benchmark-run.test.js has it),
 * so Codex can be picked; the runs themselves go through the fake subagent service.
 */
function codexOnPath(t) {
  const bin = mkdtempSync(join(tmpdir(), 'kz-live-codex-'))
  made.push(bin)
  writeFileSync(join(bin, 'fake-codex.mjs'), `
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0) }
if (args[0] !== 'app-server') process.exit(2)
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', (text) => {
  let m
  try { m = JSON.parse(text) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ id: m.id, result: {} })
  if (m.method === 'account/rateLimits/read') return send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 }, secondary: { usedPercent: 5, windowDurationMins: 10080 } } } })
  if (m.method === 'account/read') return send({ id: m.id, result: { account: { email: 'kzh-test@example.invalid', planType: 'plus' } } })
  send({ id: m.id, error: { message: 'unknown method' } })
})
lines.on('close', () => process.exit(0))
`)
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-codex.mjs')}" "$@"\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  writeFileSync(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(bin, 'fake-codex.mjs')}" %*\r\n`)
  const was = { path: process.env.PATH, home: process.env.CODEX_HOME }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  process.env.CODEX_HOME = bin
  t.after(() => { process.env.PATH = was.path; if (was.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = was.home })
}

test('with the engine patch in its connector a Claude Code or Codex run is handed the tap and the control, Claude Code\'s read-only row as well, and without it neither', async (t) => {
  codexOnPath(t)
  connector(t, 'claude-code', true)
  connector(t, 'codex', false)
  const p = await plugin(t, { config: { agents: [CLAUDE, CODEX] } })
  await p.say('Fix the state file', { model: 'agent-claude' })
  await waitFor('the Claude Code task is done', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  await p.say('Fix the state file again', { model: 'agent-codex' })
  await waitFor('the Codex task is done', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.deepEqual(p.world.started.map(handed), [['claude-code', 'function', 'object'], ['codex', 'no tap', 'no control']])
  const patches = await p.http('GET', '/jev-router/engine-patches')
  assert.equal(patches.status, 200)
  assert.deepEqual(patches.body, { 'claude-code': { on: true, why: null }, codex: { on: false, why: 'the engine patch has not run on it yet; Start-KzH runs it at each start' } })

  // Jev reads a task as only reading: Claude Code runs it on its read-only row, the same connector.
  const r = await plugin(t, { config: { agents: [CLAUDE] }, providers: { 'claude-code-readonly': { config: { permissionMode: 'plan' } } } })
  jev.said = { readOnly: 0.93, capability: 'project_read' }
  t.after(() => { jev.said = {} })
  r.world.reply = () => 'The state file says fixed.'
  await r.say('What does the state file say?')
  await waitFor('the read-only task is done', () => r.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.deepEqual(r.world.started.map(handed), [['claude-code-readonly', 'function', 'object']])
  jev.said = {}

  // Another plugin reads the connectors afresh: now only Codex carries the patch.
  connector(t, 'claude-code', false)
  connector(t, 'codex', true)
  const q = await plugin(t, { config: { agents: [CLAUDE, CODEX] } })
  await q.say('Fix the state file', { model: 'agent-claude' })
  await waitFor('the Claude Code task is done', () => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  await q.say('Fix the state file again', { model: 'agent-codex' })
  await waitFor('the Codex task is done', () => q.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.deepEqual(q.world.started.map(handed), [['claude-code', 'no tap', 'no control'], ['codex', 'function', 'object']])
})

test('a patched Claude Code run\'s tap fills the Live tab, and with no usage in its result the tapped tokens, the API-equivalent cost and the served model go on its usage.jsonl row and its attempt, and no model version', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE] } })
  // The connector's own result, as it ships: `{ output, stopReason }`, with no usage.
  p.world.usage = undefined
  p.world.work = async (opts) => {
    if (typeof opts.kzhTap !== 'function') return
    const tap = (message) => opts.kzhTap({ provider: 'claude-code', message })
    tap({ type: 'system', subtype: 'init', session_id: 's', uuid: 'u0', model: 'claude-opus-4-1', apiKeySource: 'none', cwd: '/w', tools: [], mcp_servers: [], permissionMode: 'acceptEdits', slash_commands: [], output_style: 'default', skills: [], claude_code_version: '2.1.0' })
    tap({ type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } } })
    tap({ type: 'user', parent_tool_use_id: null, session_id: 's', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] }, tool_use_result: { stdout: '1 passing', stderr: '', interrupted: false } })
    tap({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed it.', session_id: 's', uuid: 'res', num_turns: 2, duration_ms: 900, duration_api_ms: 800, stop_reason: 'end_turn', total_cost_usd: 0.42, usage: {}, permission_denials: [], modelUsage: { 'claude-opus-4-1': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 8000, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.42, contextWindow: 200000, maxOutputTokens: 32000 } } })
  }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-claude' }))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const res = await p.live(`task=${key}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const run = res.body.runs[0]
  assert.deepEqual(run.attempts.map((a) => [a.name, a.detail, a.model, a.tools]), [['Claude Code', 'live', 'claude-opus-4-1', 1]])
  assert.ok(run.items.some((i) => i.kind === 'command' && i.title === 'Ran npm test' && i.text === '1 passing'), JSON.stringify(run.items.map((i) => i.title)))
  const rows = readFileSync(join(p.dataDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.agent === 'claude')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].tokens, { input: 1200, output: 300, cacheRead: 8000, reasoning: 0 })
  assert.deepEqual([rows[0].apiEquivalentUsd, rows[0].costUsd], [0.42, null], 'a subscription\'s cost is no money spent')
  const record = JSON.parse(readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  const attempt = record.attempts.find((a) => a.agent === 'claude')
  assert.equal(attempt.servedModel, 'claude-opus-4-1')
  assert.equal('modelVersion' in attempt, false, 'capability evidence keeps the key of the model asked for')
})

test('a patched Claude Code run on an API key records what the tap heard it cost as money spent, and a connector result that says what it spent is taken over what the tap heard', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE] } })
  p.world.usage = undefined
  p.world.work = async (opts) => {
    if (typeof opts.kzhTap !== 'function') return
    const tap = (message) => opts.kzhTap({ provider: 'claude-code', message })
    tap({ type: 'system', subtype: 'init', session_id: 's', uuid: 'u0', model: 'claude-opus-4-1', apiKeySource: 'ANTHROPIC_API_KEY', cwd: '/w', tools: [], mcp_servers: [], permissionMode: 'acceptEdits', slash_commands: [], output_style: 'default', skills: [], claude_code_version: '2.1.0' })
    tap({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed it.', session_id: 's', uuid: 'res', num_turns: 1, duration_ms: 900, duration_api_ms: 800, stop_reason: 'end_turn', total_cost_usd: 0.42, usage: {}, permission_denials: [], modelUsage: { 'claude-opus-4-1': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 8000, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.42, contextWindow: 200_000, maxOutputTokens: 32_000 } } })
  }
  await p.say('Fix the state file', { model: 'agent-claude' })
  await waitFor('the first result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  // A connector of another build that counts what its run spent: its own count stands.
  p.world.usage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
  await p.say('Fix the state file again', { model: 'agent-claude' })
  await waitFor('the second result is posted', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  const rows = readFileSync(join(p.dataDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.agent === 'claude')
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].tokens, rows[0].costUsd, 'apiEquivalentUsd' in rows[0]], [{ input: 1200, output: 300, cacheRead: 8000, reasoning: 0 }, 0.42, false], 'on an API key the cost is money spent')
  assert.deepEqual(rows[1].tokens, { input: 7, output: 3, cacheRead: 0, reasoning: 0 })
})

test('Settings, Jev setup, Live agent view: the live settings are read and saved whole, a wrong field or a body that is not JSON is refused, and Keep transcripts off deletes the kept ones and keeps no more', async (t) => {
  const p = await plugin(t)
  const shipped = await p.http('GET', '/jev-router/live/settings')
  assert.deepEqual([shipped.status, shipped.body], [200, { claudeSteer: false, claudeThinking: 'default', transcripts: 'last20' }])
  const set = await p.http('POST', '/jev-router/live/settings', { claudeThinking: 'summarized', unknown: 1 })
  assert.deepEqual([set.status, set.body], [200, { claudeSteer: false, claudeThinking: 'summarized', transcripts: 'last20' }])
  assert.deepEqual(JSON.parse(readFileSync(join(p.dataDir, 'live.json'), 'utf8')), set.body, 'saved whole')
  const wrong = await p.http('POST', '/jev-router/live/settings', { transcripts: 'forever' })
  assert.equal(wrong.status, 400)
  assert.match(wrong.body.error, /^transcripts: /)
  const notJson = await p.http('POST', '/jev-router/live/settings', undefined, { type: 'application/x-www-form-urlencoded', raw: 'transcripts=off' })
  assert.equal(notJson.status, 415)
  // A task's transcript is kept as its run ends, until Keep transcripts goes off.
  const key = keyOf(await p.say('Fix the state file'))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const file = join(p.dataDir, 'live', `${key}.jsonl`)
  await waitFor('its transcript is saved', () => existsSync(file), Boolean)
  const off = await p.http('POST', '/jev-router/live/settings', { transcripts: 'off' })
  assert.equal(off.body.transcripts, 'off')
  await waitFor('the kept transcript is deleted', () => existsSync(file), (x) => !x)
  const second = keyOf(await p.say('Fix the other state file'))
  await waitFor('the second result is posted', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  await settled(join(p.dataDir, 'tasks.jsonl'))
  assert.equal(existsSync(join(p.dataDir, 'live', `${second}.jsonl`)), false, 'none is kept with it off')
})

test('Keep transcripts, Last 20 tasks: as the plugin starts and as a run ends, a finished task past the task list\'s newest 20 loses its transcript and keeps its record, and a saved Last 100 tasks keeps them all', async (t) => {
  // 24 finished tasks, oldest first, each with a transcript.
  const seed = (dataDir, saved) => {
    mkdirSync(join(dataDir, 'live'), { recursive: true })
    if (saved) writeFileSync(join(dataDir, 'live.json'), JSON.stringify(saved))
    const rows = Array.from({ length: 24 }, (_, i) => ({ key: `k-${i}`, jobId: `old-${i}`, sessionId: 's-old', workspace: join(tmpdir(), 'kz-live-old'), taskName: `Old ${i}`, taskText: `Old ${i}`, state: 'completed', queuedAt: 10 + i, startedAt: 11 + i, finishedAt: 12 + i, deliveryState: 'delivered' }))
    writeFileSync(join(dataDir, 'tasks.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
    for (const r of rows) writeFileSync(join(dataDir, 'live', `${r.key}.jsonl`), `${JSON.stringify({ t: 'run', runId: `r-${r.key}`, taskKey: r.key, openedAt: r.queuedAt, status: 'completed' })}\n`)
  }
  const kept = (dataDir) => Array.from({ length: 24 }, (_, i) => existsSync(join(dataDir, 'live', `k-${i}.jsonl`)))
  const shipped = mkdtempSync(join(tmpdir(), 'kz-live-last20-'))
  made.push(shipped)
  seed(shipped, null)
  const p = await plugin(t, { dataDir: shipped })
  assert.equal((await p.http('GET', '/jev-router/live/settings')).body.transcripts, 'last20', 'Last 20 tasks as shipped')
  // The newest 20 keep theirs, and the four further back lose theirs.
  await waitFor('the transcripts past the newest 20 are deleted', () => kept(shipped), (k) => k.filter((x) => !x).length === 4, { timeoutMs: 15_000 })
  assert.deepEqual(kept(shipped), [...Array(4).fill(false), ...Array(20).fill(true)])
  assert.equal((await p.tasks()).length, 24, 'every task keeps its record')
  // One more task: as its run ends, the oldest finished one left in the newest 20 goes too.
  const key = keyOf(await p.say('Fix the state file'))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  await waitFor('its own transcript is saved', () => existsSync(join(shipped, 'live', `${key}.jsonl`)), Boolean)
  await waitFor('the one now past the newest 20 is deleted', () => kept(shipped)[4], (x) => x === false, { timeoutMs: 15_000 })
  assert.deepEqual(kept(shipped), [...Array(5).fill(false), ...Array(19).fill(true)])
  assert.equal((await p.tasks()).length, 25)

  // Last 100 tasks saved before Last 20 was a choice keeps working, and keeps every transcript.
  const hundred = mkdtempSync(join(tmpdir(), 'kz-live-last100-'))
  made.push(hundred)
  seed(hundred, { claudeSteer: false, claudeThinking: 'default', transcripts: 'last100' })
  const q = await plugin(t, { dataDir: hundred })
  assert.deepEqual((await q.http('GET', '/jev-router/live/settings')).body.transcripts, 'last100')
  await q.say('Fix the state file')
  await waitFor('the result is posted', () => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  await settled(join(hundred, 'tasks.jsonl'))
  assert.deepEqual(kept(hundred), Array(24).fill(true))
  assert.equal((await q.http('POST', '/jev-router/live/settings', { transcripts: 'last20' })).body.transcripts, 'last20', 'and Last 20 can be chosen again')
})

// ---------- your verdict on a start reply's pick, through the plugin (docs/live-agent-view.md Feature 4, slice 6) ----------
// POST /jev-router/feedback answers what a verdict changed (`effects`) in the code before the slice
// with nothing, and GET /jev-router/replies, POST /jev-router/replies/ask and POST
// /jev-router/effort/ratings-reset answer 404 there.

/** The newest label of the run's sample of one routing domain, as routing-samples.jsonl holds it. */
function labelOf(dataDir, runId, domain) {
  const rows = readFileSync(join(dataDir, 'routing-samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const sample = rows.find((r) => r.domain === domain && r.runId === runId && !('outcomeTs' in r))
  return sample ? rows.filter((r) => r.id === sample.id && 'outcomeTs' in r).at(-1)?.outcome ?? null : null
}

test('a dislike of a start reply\'s pick given while its task runs is saved, stamped with the plan from the reply ledger, and applied to the run as it ends; GET /jev-router/replies?key= gives the reply\'s row, which keeps the ask\'s answer', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  p.world.work = async () => { await held }
  const reply = await p.say('Fix the failing check in state.txt')
  const key = keyOf(reply)
  assert.ok(key, reply)
  const running = await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  const task = running.find((x) => x.key === key)
  const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', reason: 'I asked for a plan', provider: 'deepseek' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.effects, [`Saved. It is applied when ${task.jobId} ends.`])
  assert.deepEqual([res.body.record.planAgent, res.body.record.planFamily, res.body.record.runId], ['deepseek', 'deepseek', task.runIds.at(-1)], 'stamped with the plan the reply ledger noted as routing picked it')
  assert.equal(typeof res.body.record.taskType, 'string')
  release()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const runId = res.body.record.runId
  const label = await waitFor('the run is labelled with the person\'s word', () => labelOf(p.dataDir, runId, 'task_classification'), (o) => o?.labelSource === 'human', { timeoutMs: 15_000 })
  assert.equal(label.label, null, 'a misread is a negative')
  const row = await until('the reply\'s row says what the verdict changed', () => p.http('GET', `/jev-router/replies?key=${key}`), (r) => /^Learned:/.test(r.body?.verdict?.learned ?? ''), { timeoutMs: 15_000 })
  assert.equal(row.status, 200)
  assert.deepEqual([row.body.jobId, row.body.said?.agent, row.body.ran?.agent, row.body.verdict.verdict, row.body.verdict.tag, row.body.ask, row.body.askWhenWrong, row.body.ended], [task.jobId, 'deepseek', 'deepseek', 'dislike', 'misread my question', null, true, 'completed'])
  assert.equal(row.body.verdict.learned, 'Learned: this run\'s task type is marked wrong for the local classifier.')
  assert.equal((await p.http('GET', `/jev-router/replies?key=${key}&session=another-chat`)).status, 404, 'a reply of another chat is none of this one\'s')
  assert.equal((await p.http('GET', '/jev-router/replies?key=jev-1')).status, 400)
  // The ask's answer is kept on the row, so the reply is never asked about again.
  assert.equal((await p.http('POST', '/jev-router/replies/ask', { key, answer: 'maybe' })).status, 400)
  assert.equal((await p.http('POST', '/jev-router/replies/ask', { key: '7c9e6679-7425-40de-944b-e07fc1f90ae7', answer: 'either' })).status, 404)
  const asked = await p.http('POST', '/jev-router/replies/ask', { key, answer: 'either', sessionId: SESSION })
  assert.equal(asked.status, 200, JSON.stringify(asked.body))
  assert.equal((await p.http('GET', `/jev-router/replies?key=${key}`)).body.ask?.answer, 'either')
  const summary = (await p.http('GET', '/jev-router/replies/summary')).body
  assert.deepEqual([summary.ratings?.liked, summary.ratings?.disliked, summary.ratings?.changed?.[0]?.line], [0, 1, 'Learned: this run\'s task type is marked wrong for the local classifier.'], 'the How Jev replies card counts it, and says what it changed')
  assert.equal(summary.recent[0].verdict?.verdict, 'dislike')
  // A clear, which carries only its keys, takes the rating off the reply's row.
  assert.equal((await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', verdict: 'clear' })).status, 200)
  assert.equal((await p.http('GET', `/jev-router/replies?key=${key}`)).body.verdict, null)
  assert.equal((await p.http('GET', '/jev-router/replies/summary')).body.ratings.disliked, 0)
})

test('a verdict about a start reply\'s pick is stamped only from a reply of its own chat, and with the run the reply ledger noted whatever run the client sent', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  p.world.work = async () => { await held }
  const reply = await p.say('Fix the failing check in state.txt')
  const key = keyOf(reply)
  assert.ok(key, reply)
  const running = await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  const task = running.find((x) => x.key === key)
  // From another chat, naming this task: nothing of its plan is stamped, and its reply's row is not rated.
  const other = await p.http('POST', '/jev-router/feedback', { sessionId: 'another-chat', messageId: 'm-other', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question' })
  assert.equal(other.status, 200, JSON.stringify(other.body))
  assert.equal((await p.http('GET', `/jev-router/replies?key=${key}`)).body?.verdict, null, 'the reply\'s row is not rated from another chat')
  assert.deepEqual(['planAgent', 'planEffort', 'planLevel', 'planModel', 'planFamily', 'taskType', 'runId'].filter((k) => k in other.body.record), [], 'nothing of another chat\'s plan is stamped')
  // In its own chat, with a run the client chose: the run the reply ledger noted is the one kept.
  const own = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', runId: 'run-client-chosen' })
  assert.equal(own.status, 200, JSON.stringify(own.body))
  assert.deepEqual([own.body.record.runId, own.body.record.planAgent], [task.runIds.at(-1), 'deepseek'], 'the server\'s facts over what the client sent')
  release()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
})

test('a dislike of a start reply\'s pick given while its task runs is applied to the run when the task is stopped, and the reply\'s row says what it changed', async (t) => {
  const p = await plugin(t)
  // The agent works until the task is stopped.
  p.world.work = (opts) => new Promise((resolve) => { if (opts.signal?.aborted) resolve(); else opts.signal?.addEventListener('abort', resolve, { once: true }) })
  const reply = await p.say('Fix the failing check in state.txt')
  const key = keyOf(reply)
  assert.ok(key, reply)
  const running = await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  const task = running.find((x) => x.key === key)
  const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', provider: 'deepseek' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.effects, [`Saved. It is applied when ${task.jobId} ends.`])
  const runId = res.body.record.runId
  assert.equal((await p.http('POST', '/jev-router/tasks/stop', { jobId: task.jobId })).status, 200)
  await until('the task is stopped', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'stopped'), { timeoutMs: 15_000 })
  // A stopped run is not labelled from how it ended, but the person's word about its pick is applied to it.
  const label = await eventually(() => labelOf(p.dataDir, runId, 'task_classification'), (o) => o?.labelSource === 'human', { timeoutMs: 15_000 })
  assert.equal(label?.labelSource, 'human', `the stopped run's task type is marked wrong by the person: ${JSON.stringify(label)}`)
  assert.equal(label.label, null, 'a misread is a negative')
  const row = await eventually(() => p.http('GET', `/jev-router/replies?key=${key}`), (r) => /^Learned:/.test(r?.body?.verdict?.learned ?? ''), { timeoutMs: 15_000 })
  assert.equal(row?.body?.verdict?.learned, 'Learned: this run\'s task type is marked wrong for the local classifier.', 'the reply\'s row no longer says it waits for the task to end')
})

// What the line under a rated start reply says once its task has ended with no run on record to apply it to.
const NO_RUN = 'Saved. The task ended with no run on record to apply it to.'

test('a rating of a start reply\'s pick given while its task runs, which a restart stops with no run on record, is told there is none to apply it to as the plugin starts again; one given after says so at once', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  // Let go of the agent however the test ends, so its run ends too.
  t.after(() => release())
  p.world.work = async () => { await held }
  const key = keyOf(await p.say('Fix the failing check in state.txt'))
  assert.ok(key)
  const running = await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  const task = running.find((x) => x.key === key)
  const given = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong agent', provider: 'deepseek' })
  assert.equal(given.status, 200, JSON.stringify(given.body))
  assert.deepEqual(given.body.effects, [`Saved. It is applied when ${task.jobId} ends.`])
  // The app restarts while the agent works, so its run writes no row.
  await p.close()
  const q = await plugin(t, { dataDir: p.dataDir, workspace: p.workspace })
  await until('the restart stops the task', () => q.tasks(), (list) => list.some((x) => x.key === key && x.state === 'stopped'), { timeoutMs: 15_000 })
  const row = await eventually(() => q.http('GET', `/jev-router/replies?key=${key}`), (r) => r?.body?.verdict?.learned === NO_RUN, { timeoutMs: 15_000 })
  assert.equal(row?.body?.verdict?.learned, NO_RUN, 'the reply\'s row no longer says it waits for the task to end')
  // Rated again after the restart: no run is said to come, where the engine may give its job id to another task.
  const again = await q.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', provider: 'deepseek' })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.deepEqual(again.body.effects, [NO_RUN])
  assert.equal((await q.http('GET', `/jev-router/replies?key=${key}`)).body?.verdict?.learned, NO_RUN)
})

test('a rating of a start reply\'s pick given to the plugin applied again, while the task it took over still runs, is applied to that task\'s run as it ends, and the reply\'s row says what it changed, not that there is no run', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  p.world.work = async () => { await held }
  const key = keyOf(await p.say('Fix the failing check in state.txt'))
  assert.ok(key)
  await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  // The engine applies the plugin again, a setting changed, while the agent works.
  await p.close()
  const q = await plugin(t, { reload: p })
  const task = await eventually(() => rowOf(q, key), Boolean)
  assert.equal(task?.state, 'running', 'the task is at work in the plugin applied again')
  const res = await q.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', provider: 'deepseek' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.effects, [`Saved. It is applied when ${task.jobId} ends.`])
  const runId = res.body.record.runId
  open()
  await waitFor('the result is posted', () => q.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const row = await eventually(() => q.http('GET', `/jev-router/replies?key=${key}`), (r) => /^Learned:/.test(r?.body?.verdict?.learned ?? ''), { timeoutMs: 15_000 })
  assert.equal(row?.body?.verdict?.learned, 'Learned: this run\'s task type is marked wrong for the local classifier.', 'applied to its run, never told it has none')
  const label = await eventually(() => labelOf(q.dataDir, runId, 'task_classification'), (o) => o?.labelSource === 'human', { timeoutMs: 15_000 })
  assert.equal(label?.labelSource, 'human', `its run's task type is marked wrong by the person: ${JSON.stringify(label)}`)
})

test('a rating of a start reply\'s pick given to the plugin applied again, while the task it took over still runs, is applied to that task\'s run when the task is stopped from there, and the reply\'s row says what it changed', async (t) => {
  const p = await plugin(t)
  // The agent works until the task is stopped.
  p.world.work = (opts) => new Promise((resolve) => { if (opts.signal?.aborted) resolve(); else opts.signal?.addEventListener('abort', resolve, { once: true }) })
  const key = keyOf(await p.say('Fix the failing check in state.txt'))
  assert.ok(key)
  await until('the task runs', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'running'), { timeoutMs: 15_000 })
  await p.close()
  const q = await plugin(t, { reload: p })
  const task = await eventually(() => rowOf(q, key), Boolean)
  assert.equal(task?.state, 'running', 'the task is at work in the plugin applied again')
  const res = await q.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'misread my question', provider: 'deepseek' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.effects, [`Saved. It is applied when ${task.jobId} ends.`])
  const runId = res.body.record.runId
  // Stop from the plugin applied again ends the run in the closures of the one that closed, which
  // learns nothing from a stopped run but applies the person's word about its pick, there.
  assert.equal((await q.http('POST', '/jev-router/tasks/stop', { jobId: task.jobId })).status, 200)
  const stopped = await eventually(() => rowOf(q, key), (r) => r?.state === 'stopped', { timeoutMs: 15_000 })
  assert.equal(stopped?.state, 'stopped')
  const label = await eventually(() => labelOf(q.dataDir, runId, 'task_classification'), (o) => o?.labelSource === 'human', { timeoutMs: 15_000 })
  assert.equal(label?.labelSource, 'human', `the stopped run's task type is marked wrong by the person: ${JSON.stringify(label)}`)
  assert.equal(label.label, null, 'a misread is a negative')
  const row = await eventually(() => q.http('GET', `/jev-router/replies?key=${key}`), (r) => /^Learned:/.test(r?.body?.verdict?.learned ?? ''), { timeoutMs: 15_000 })
  assert.equal(row?.body?.verdict?.learned, 'Learned: this run\'s task type is marked wrong for the local classifier.', 'the reply\'s row no longer says it waits for the task to end')
})

test('a rating of a waiting task\'s pick is told there is no run to apply it to once the task is stopped before it ran', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  t.after(() => release())
  p.world.work = async (_opts, n) => { if (n === 1) await held }
  const first = keyOf(await p.say('Fix the failing check in state.txt'))
  await until('the first task runs', () => p.tasks(), (list) => list.some((x) => x.key === first && x.state === 'running'), { timeoutMs: 15_000 })
  const key = keyOf(await p.say('Fix the failing check in state.txt once more'))
  const waiting = (await p.tasks()).find((x) => x.key === key)
  assert.equal(waiting?.state, 'queued', 'it waits in its folder\'s line')
  const given = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-waiting', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong agent' })
  assert.equal(given.status, 200, JSON.stringify(given.body))
  assert.deepEqual(given.body.effects, [`Saved. It is applied when ${waiting.jobId} ends.`])
  assert.equal((await p.http('POST', '/jev-router/tasks/stop', { jobId: waiting.jobId })).status, 200)
  await until('the task is stopped', () => p.tasks(), (list) => list.some((x) => x.key === key && x.state === 'stopped'), { timeoutMs: 15_000 })
  const row = await eventually(() => p.http('GET', `/jev-router/replies?key=${key}`), (r) => r?.body?.verdict?.learned === NO_RUN, { timeoutMs: 15_000 })
  assert.equal(row?.body?.verdict?.learned, NO_RUN, 'the reply\'s row no longer says it waits for the task to end')
  release()
  await until('the first task ends', () => p.tasks(), (list) => list.some((x) => x.key === first && x.state === 'completed'), { timeoutMs: 30_000 })
})

test('three wrong effort ratings of one agent\'s pick on one kind of work are named in Settings, Effort, and its Reset leaves them reading nothing, with nothing deleted', async (t) => {
  const p = await plugin(t)
  const reply = await p.say('Fix the failing check in state.txt')
  const key = keyOf(reply)
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const before = await p.http('GET', '/jev-router/effort')
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.learned, [], 'no rating has moved anything yet')
  const said = []
  for (const m of ['m-1', 'm-2', 'm-3']) {
    const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: m, about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong effort', suggestedEffort: 'max', provider: 'deepseek' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    said.push(res.body.effects?.[0] ?? '')
  }
  assert.match(said[0], /^Learned: 1 of 3 "effort too low" ratings for DeepSeek on /)
  assert.match(said[2], /^Learned: Auto effort for DeepSeek on .* now runs one step higher \(Settings, Effort to reset\)\.$/)
  const learned = (await p.http('GET', '/jev-router/effort')).body.learned
  assert.equal(learned.length, 1)
  assert.deepEqual([learned[0].family, learned[0].shift, learned[0].agree, learned[0].n], ['deepseek', 1, 3, 3])
  assert.match(learned[0].text, /^Learned from your ratings: DeepSeek Auto effort one step higher for .* \(3 of your last 3 "wrong effort" ratings\)\.$/)
  // A save of the card's own settings keeps no copy of what was read with them.
  const saved = await p.http('POST', '/jev-router/effort', { ...before.body, learned: [{ text: 'stale' }] })
  assert.equal(saved.status, 200)
  assert.equal('learned' in JSON.parse(readFileSync(join(p.dataDir, 'effort.json'), 'utf8')), false)
  const reset = await p.http('POST', '/jev-router/effort/ratings-reset', {})
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  assert.ok(Date.parse(reset.body.ratingsResetAt) > 0, 'the time of the Reset is kept')
  assert.deepEqual(reset.body.learned, [], 'and the ratings before it move nothing')
  assert.equal((await p.http('GET', '/jev-router/feedback?session=' + SESSION)).body.feedback.length, 3, 'nothing is deleted')
})

test('wrong effort ratings of a waiting task\'s pick, given before routing picked anything, are stamped with the plan it ran as its run ends: they move Auto effort, and the reply\'s row says so', async (t) => {
  const p = await plugin(t)
  let release
  const held = new Promise((r) => { release = r })
  p.world.work = async (_opts, n) => { if (n === 1) await held }
  const first = keyOf(await p.say('Fix the failing check in state.txt'))
  await until('the first task runs', () => p.tasks(), (list) => list.some((x) => x.key === first && x.state === 'running'), { timeoutMs: 15_000 })
  const reply = await p.say('Fix the failing check in state.txt once more')
  const key = keyOf(reply)
  assert.ok(key, reply)
  assert.equal((await p.tasks()).find((x) => x.key === key)?.state, 'queued', 'it waits in its folder\'s line, so routing has picked nothing for it yet')
  const given = []
  for (const m of ['m-1', 'm-2', 'm-3']) {
    const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: m, about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong effort', suggestedEffort: 'max' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    given.push(res.body.record)
  }
  assert.deepEqual(given.flatMap((r) => ['planAgent', 'planLevel', 'planFamily', 'taskType'].filter((k) => k in r)), [], 'there is no plan to stamp them with yet')
  release()
  await waitFor('both results are posted', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  const rows = await eventually(async () => (await p.http('GET', `/jev-router/feedback?session=${SESSION}`)).body.feedback, (list) => list?.length === 3 && list.every((r) => r.planLevel))
  assert.ok(rows?.length === 3 && rows.every((r) => r.planLevel), `stamped with the plan the task ran as its run ends: ${JSON.stringify(rows)}`)
  assert.deepEqual(rows.map((r) => [r.messageId, r.ts, r.planAgent, r.planFamily, typeof r.taskType]), given.map((r) => [r.messageId, r.ts, 'deepseek', 'deepseek', 'string']), 'each the same verdict, dated as it was given')
  const learned = (await p.http('GET', '/jev-router/effort')).body.learned
  assert.deepEqual(learned.map((b) => [b.family, b.taskType, b.shift, b.agree, b.n]), [['deepseek', rows[0].taskType, 1, 3, 3]], 'three of them move Auto effort, as three given after the pick do')
  // The row is told each verdict's effect in turn as the three are applied, 1 of 3 and 2 of 3 before
  // the step, and the third's comes after its stamped row is on file: it is read once that is in.
  const row = await eventually(() => p.http('GET', `/jev-router/replies?key=${key}`), (r) => / now runs one step /.test(r?.body?.verdict?.learned ?? ''))
  assert.match(row?.body?.verdict?.learned ?? '', /^Learned: Auto effort for DeepSeek on .* now runs one step higher \(Settings, Effort to reset\)\.$/, 'and the reply\'s row says what they changed')
})

test('a wrong effort rating of a pick your ratings moved is stamped with the level Auto would have chosen, and read against it: one that asks for that level asks for no step past it', async (t) => {
  const p = await plugin(t)
  const first = keyOf(await p.say('Fix the failing check in state.txt'))
  await waitFor('the first result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  for (const m of ['m-1', 'm-2', 'm-3']) {
    const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: m, about: 'plan', taskKey: first, verdict: 'dislike', tag: 'wrong effort', suggestedEffort: 'max', provider: 'deepseek' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
  }
  const own = (await p.http('GET', `/jev-router/feedback?session=${SESSION}`)).body.feedback[0].planLevel
  const rungs = ['low', 'medium', 'high', 'xhigh']
  assert.ok(rungs.indexOf(own) >= 0 && rungs.indexOf(own) < rungs.length - 1, `Auto chose ${own}, a level a step can be added to`)
  // The next task of the kind runs a step above the level Auto chooses for it.
  const key = keyOf(await p.say('Fix the failing check in state.txt once more'))
  await waitFor('the second result is posted', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  const res = await p.http('POST', '/jev-router/feedback', { sessionId: SESSION, messageId: 'm-4', about: 'plan', taskKey: key, verdict: 'dislike', tag: 'wrong effort', suggestedEffort: own, provider: 'deepseek' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.record.planLevel, res.body.record.planUnmoved], [rungs[rungs.indexOf(own) + 1], own], 'stamped with the level it ran at and the level Auto would have chosen')
  assert.deepEqual(res.body.effects, ['Saved.'], 'it asks for Auto\'s own level, so it is no rating of the effort as too high')
  const learned = (await p.http('GET', '/jev-router/effort')).body.learned
  assert.deepEqual(learned.map((b) => [b.shift, b.agree, b.n]), [[1, 3, 4]], 'the step stays until such ratings take the place of the ones that moved it')
})

// ---------- Steer on a running task (docs/live-agent-view.md Feature 5, slice 8) ----------

/** Steer the task with this key, as the Steer dialog does (`how` 'live') or the chat ('auto'). */
const steerOf = (p, key, text, how = 'live') => p.http('POST', '/jev-router/tasks/steer', { key, text, how })
/** The task with this key as GET /tasks has it. */
const rowOf = async (p, key) => (await p.tasks()).find((x) => x.key === key)
const fsp = createRequire(import.meta.url)('node:fs/promises')
/**
 * Run `fn` with `name` of node:fs/promises replaced by `fake(real)`, as every module that imports it
 * sees it: syncBuiltinESMExports carries the swap over to the named imports index.js holds.
 */
async function swapped(name, fake, fn) {
  const real = fsp[name]
  fsp[name] = fake(real)
  syncBuiltinESMExports()
  try { return await fn() } finally {
    fsp[name] = real
    syncBuiltinESMExports()
  }
}
/** A promise the test resolves, and lets go of however the test ends. */
function holdOpen(t) {
  let open
  const held = new Promise((r) => { open = r })
  t.after(() => open())
  return { held, open }
}

test('Steer on a spawn agent at work: the words go to its inbox as the person\'s, prefixed, under the steer\'s id; once it claims them they read as read in the Tasks row, the Live tab and the result head, its history row says it was steered, and a restart keeps it', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'spawn')
  assert.deepEqual(row?.controls?.steer, { path: 'spawn', why: null, agent: 'deepseek', name: 'DeepSeek agent', sendable: true, words: 'DeepSeek agent takes this in at its next step.', now: { path: 'spawn', why: null, words: 'Send now stops DeepSeek agent\'s current step and gives it your words at once.' } })
  const res = await steerOf(p, key, 'use tabs')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['sent', 'pending', 'Sent to jev-1: DeepSeek agent takes it in at its next step.'])
  assert.deepEqual(child.steers, [{ id: res.body.id, role: 'user', content: [{ type: 'text', text: '(Added by the person while you work on this task.) use tabs' }], source: { kind: 'user' } }])
  assert.deepEqual((await rowOf(p, key)).steers.map((s) => [s.text, s.how, s.state, s.words]), [['use tabs', 'live', 'pending', 'Waiting for its next step']])
  // It takes them in at its next step: its inbox says so, and its session commits them.
  child.claim(res.body.id)
  const read = await eventually(async () => (await rowOf(p, key)).steers[0], (s) => s?.state === 'delivered')
  assert.equal(read?.state, 'delivered')
  assert.match(read.words, /^Read by DeepSeek agent at \d\d:\d\d$/)
  const bubble = (await p.live(`task=${key}`)).body.runs[0].items.find((i) => i.kind === 'steer')
  assert.deepEqual([bubble?.title, bubble?.text, bubble?.meta?.state, bubble?.meta?.words], ['You: use tabs', 'use tabs', 'delivered', read.words])
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "use tabs": read by DeepSeek agent\.$/m)
  const record = JSON.parse(readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(record.steered, 1, 'its history row says the person steered it, which what is learned from it leaves out')
  await p.close()
  const q = await plugin(t, { dataDir: p.dataDir, workspace: p.workspace })
  const again = await eventually(() => rowOf(q, key), Boolean)
  assert.deepEqual(again?.steers?.map((s) => [s.text, s.state, s.words]), [['use tabs', 'delivered', read.words]], 'a restart reads what became of it back')
})

test('a spawn agent whose result comes in before it takes the words in: they were not used, the agent that finished first says so, and the result head says not used', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'spawn')
  const res = await steerOf(p, key, 'and update the changelog', 'auto')
  assert.equal(res.body.result, 'sent', JSON.stringify(res.body))
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const s = (await rowOf(p, key)).steers[0]
  assert.deepEqual([s.state, s.words], ['returned', 'Not used: DeepSeek agent finished first'])
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "and update the changelog": not used \(arrived after the work finished\)\.$/m)
  const bubble = (await p.live(`task=${key}`)).body.runs[0].items.find((i) => i.kind === 'steer')
  assert.deepEqual([bubble?.meta?.state, bubble?.meta?.words], ['returned', 'Not used: DeepSeek agent finished first'], 'its bubble says so before its transcript is saved')
  const record = JSON.parse(readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal('steered' in record, false, 'words no agent took in did not steer it')
  // A task that ended takes no more words.
  assert.equal((await steerOf(p, key, 'too late')).body.words, 'jev-1 already finished. Send your words as a new message to start a new task.')
})

test('words sent while the checks run wait, are said to, and the next attempt\'s prompt carries them', async (t) => {
  // Checks that take a while and fail until the third run: before the start, after the first attempt, after the second.
  const dir = mkdtempSync(join(tmpdir(), 'kz-live-work-'))
  made.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"const fs=require('fs');const n=fs.existsSync('runs.txt')?Number(fs.readFileSync('runs.txt','utf8')):0;fs.writeFileSync('runs.txt',String(n+1));setTimeout(()=>process.exit(n>=2?0:1),1500)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const p = await plugin(t, { workspace: dir })
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.why === 'checks' && p.world.started.length === 1, { timeoutMs: 30_000 })
  assert.deepEqual([row?.controls?.steer?.path, row?.controls?.steer?.sendable], [null, true], 'no agent at work, and the words still go')
  const res = await steerOf(p, key, 'keep the old grammar working')
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['pending', 'pending', 'jev-1 is running its checks right now, so this goes with its next attempt, if there is one.'])
  await waitFor('the next attempt starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.ok(p.world.started[1].prompt.endsWith('The person added this while the task ran; follow it:\n- keep the old grammar working'), p.world.started[1].prompt)
  assert.doesNotMatch(p.world.started[0].prompt, /The person added this/)
  const s = await eventually(async () => (await rowOf(p, key)).steers[0], (x) => x?.state === 'carried')
  assert.deepEqual([s?.state, s?.words], ['carried', 'Goes to the next attempt (DeepSeek agent, retry)'])
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 60_000 })
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "keep the old grammar working": went to the next attempt \(DeepSeek agent, retry\)\.$/m)
})

test('Steer on a patched Codex run: turn/steer with the steer\'s id as its client id, read once a userMessage item carries that id, and @jev-N in the chat sends it the same way; a turn that refuses the words leaves them for the next attempt, whose prompt carries them', async (t) => {
  codexOnPath(t)
  connector(t, 'codex', true)
  const p = await plugin(t, { config: { agents: [CODEX] } })
  const { held, open } = holdOpen(t)
  const turns = []
  let refuse = false
  p.world.work = async (opts, n) => {
    // The engine patch fills the control as the connector's wire is made: its steer is turn/steer.
    opts.kzhControl.steer = async (text, clientId) => {
      turns.push([n, text, clientId])
      if (refuse) throw Object.assign(new Error('no turn is running'), { code: 'kzh-no-turn' })
      setTimeout(() => opts.kzhTap({ provider: 'codex', method: 'item/completed', params: { threadId: 'th', turnId: 'tu', item: { type: 'userMessage', id: `item-${turns.length}`, clientId, content: [{ type: 'text', text }] } } }), 10)
      return { turnId: 'tu' }
    }
    if (n === 1 || n === 2) await held
  }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-codex' }))
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'codex', { timeoutMs: 20_000 })
  assert.deepEqual([row?.controls?.steer?.words, row?.controls?.steer?.sendable], ['Codex takes this in at its next step.', true])
  assert.equal(await p.say('@jev-1 use tabs'), 'Sent to jev-1: Codex takes it in at its next step.')
  assert.deepEqual(turns.map(([n, text]) => [n, text]), [[1, '(Added by the person while you work on this task.) use tabs']])
  const read = await eventually(async () => (await rowOf(p, key)).steers[0], (s) => s?.state === 'delivered')
  assert.equal(turns[0][2], read?.id, 'its id is the client id the userMessage item carries back')
  assert.match(read.words, /^Read by Codex at \d\d:\d\d$/)
  // The turn refuses the next words: they wait, and the next attempt's prompt carries them.
  refuse = true
  const res = await steerOf(p, key, 'run the linter')
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['pending', 'pending', 'Codex could not take it at this step. It goes to the next attempt if there is one.'])
  // Jev's review of the first attempt sends it back, so another attempt follows.
  let reviews = 0
  jev.said = { addressed: () => (++reviews === 1 ? 0.1 : 0.95), complete: () => (reviews === 1 ? 0.1 : 0.95) }
  t.after(() => { jev.said = {} })
  open()
  await waitFor('the next attempt starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.match(p.world.started[1].prompt, /The person added this while the task ran; follow it:\n- use tabs\n- run the linter$/)
  const steers = await eventually(async () => (await rowOf(p, key)).steers, (list) => list?.[1]?.state === 'carried')
  assert.deepEqual(steers.map((s) => s.state), ['delivered', 'carried'])
  assert.equal(steers[1].words, 'Goes to the next attempt (Codex, retry)')
})

test('Steer on a Claude Code task started with Let Steer reach a running Claude Code off: its control\'s steer and sendNow are never called, also once the switch is on, since the task has no input channel; the words wait for the next attempt and say why, and the dialog cannot send them now', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE] } })
  const { held, open } = holdOpen(t)
  let called = 0
  p.world.work = async (opts) => {
    // The engine patch fills Claude Code's control too; a run started without its channel is never steered through it.
    Object.assign(opts.kzhControl, { steer: async () => { called++ }, sendNow: async () => { called++ } })
    await held
  }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-claude' }))
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.why === 'claude-off', { timeoutMs: 20_000 })
  const off = 'Claude Code can\'t take messages mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code"). It goes to the next attempt if there is one.'
  assert.deepEqual(row?.controls?.steer, { path: null, why: 'claude-off', agent: 'claude', name: 'Claude Code', sendable: false, words: off, now: { path: null, why: 'claude-off', words: 'Send now can\'t stop Claude Code mid-run here (Settings, Jev setup, "Let Steer reach a running Claude Code").' } })
  const res = await steerOf(p, key, 'use tabs')
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['pending', 'pending', off])
  assert.equal((await p.http('POST', '/jev-router/live/settings', { claudeSteer: true })).status, 200)
  const on = await steerOf(p, key, 'and run the linter')
  assert.equal(on.body.words, 'Claude Code started before "Let Steer reach a running Claude Code" was on, so it can\'t take messages mid-run. It goes to the next attempt if there is one.')
  const now = await steerOf(p, key, 'stop and do this instead', 'now')
  assert.deepEqual([now.body.result, now.body.state, now.body.words], ['not-now', null, 'Send now can\'t stop Claude Code mid-run: it started before "Let Steer reach a running Claude Code" was on.'])
  assert.equal(p.world.started[0].kzhControl.channel, undefined, 'started with the switch off, it has no input channel')
  assert.equal(called, 0, 'control.steer is never called')
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.deepEqual((await rowOf(p, key)).steers.map((s) => s.state), ['returned', 'returned'], 'a Send now refused is noted nowhere')
  assert.equal(called, 0)
})

test('words for a task that ends while the steer reads the agents\' names are answered as for a task that ended: no piece of guidance is noted on it, and none reaches its agent', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  // The steer's read of the agents' names, from disk, waits until the task has ended.
  const names = holdOpen(t)
  const setup = join(p.dataDir, 'agents.json')
  let reading = false
  const res = await swapped('readFile', (real) => (file, ...rest) => {
    if (String(file) !== setup || !/steerTask/.test(new Error().stack)) return real(file, ...rest)
    reading = true
    return names.held.then(() => real(file, ...rest))
  }, async () => {
    const steering = steerOf(p, key, 'use tabs', 'auto')
    await waitFor('the steer reads the names', () => reading, Boolean)
    open()
    await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
    names.open()
    return steering
  })
  assert.deepEqual([res.status, res.body?.result, res.body?.words], [200, 'already-finished', 'jev-1 already finished. Send your words as a new message to start a new task.'])
  assert.deepEqual((await rowOf(p, key)).steers ?? [], [], 'a task that ended takes no piece of guidance')
  assert.deepEqual(child.steers, [])
})

test('words longer than a task\'s record keeps reach the agent at work whole, and so does the prompt of its next attempt, while the record keeps them clipped', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, n, c) => { if (n === 1) { child = c; await held } }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'spawn')
  const words = `Keep this stack trace in mind: ${'at parse (parser.js:12) '.repeat(110)}end`
  assert.ok(words.length > 2500)
  const res = await steerOf(p, key, words)
  assert.equal(res.body?.result, 'sent', JSON.stringify(res.body)?.slice(0, 300))
  assert.equal(child.steers[0]?.content[0].text, `(Added by the person while you work on this task.) ${words}`, 'its agent reads them whole')
  assert.equal((await rowOf(p, key)).steers[0].text.length, 2000, 'the task\'s record keeps them clipped')
  // Jev's review of the first attempt sends it back, so another attempt follows, whose prompt carries them whole.
  let reviews = 0
  jev.said = { addressed: () => (++reviews === 1 ? 0.1 : 0.95), complete: () => (reviews === 1 ? 0.1 : 0.95) }
  t.after(() => { jev.said = {} })
  open()
  await waitFor('the next attempt starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.ok(p.world.started[1].prompt.endsWith(`The person added this while the task ran; follow it:\n- ${words}`), p.world.started[1].prompt.slice(-300))
})

test('while an agent reviews the work, Steer says the work is being reviewed and the words wait for the next attempt, which the dialog still sends; the reviewer is never given them', async (t) => {
  // Claude Code does the work and DeepSeek reviews it, as a cheap execute with a frontier review plans it.
  const p = await plugin(t, { config: { agents: [AGENTS[0], CLAUDE] } })
  jev.said = { risk: 4, strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW' }
  t.after(() => { jev.said = {} })
  const { held, open } = holdOpen(t)
  p.world.work = async (_opts, n) => { if (n === 2) await held }
  const key = keyOf(await p.say('Fix the state file'))
  await waitFor('the review starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.match(p.world.started[1].prompt, /^Independently review the work another agent did/)
  const reviewing = 'jev-1\'s work is being reviewed right now, so this goes with its next attempt, if there is one.'
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.why === 'review')
  assert.deepEqual(row?.controls?.steer, { path: null, why: 'review', agent: 'deepseek', name: 'DeepSeek agent', sendable: true, words: reviewing, now: { path: null, why: 'review', words: 'Send now has nothing to stop while jev-1\'s work is being reviewed.' } })
  const res = await steerOf(p, key, 'use tabs')
  assert.deepEqual([res.body?.result, res.body?.state, res.body?.words], ['pending', 'pending', reviewing])
  assert.deepEqual(p.world.children[1]?.steers, [], 'a reviewer is never given the words')
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
})

test('words given to a read pass that hands its task back are kept for the pass that writes, whose first prompt carries them: they go to the next attempt, not unused', async (t) => {
  const p = await plugin(t)
  // Jev reads the message as only reading: a read pass first, which hands the task back to write.
  jev.said = { readOnly: 0.93, capability: 'project_read' }
  t.after(() => { jev.said = {} })
  const { held, open } = holdOpen(t)
  let reader
  p.world.work = async (_opts, n, c) => { if (n === 1) { reader = c; await held } }
  p.world.reply = (n) => (n === 1 ? 'I can see the bug.\nNEEDS-WRITE-ACCESS\nstate.txt has to change.' : 'Fixed it.')
  const key = keyOf(await p.say('Look at the parser and tidy it'))
  await waitFor('the read pass is at work', () => reader, Boolean, { timeoutMs: 20_000 })
  await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'spawn')
  const res = await steerOf(p, key, 'keep the old grammar working')
  assert.equal(res.body?.result, 'sent', JSON.stringify(res.body))
  // The read pass ends before it takes them in, and hands the task back.
  open()
  await waitFor('the pass that writes starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.ok(p.world.started[1].prompt.endsWith('The person added this while the task ran; follow it:\n- keep the old grammar working'), p.world.started[1].prompt.slice(-300))
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  const s = (await rowOf(p, key)).steers[0]
  assert.deepEqual([s?.state, s?.words], ['carried', 'Goes to the next attempt (DeepSeek agent, work)'])
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "keep the old grammar working": went to the next attempt \(DeepSeek agent, work\)\.$/m)
})

// ---- Send now into a running agent, and Claude Code's input channel (slice 10) -----------------------

const PREFIX = '(Added by the person while you work on this task.) '
const titlesOf = async (p, key) => (await p.live(`task=${key}`)).body.runs.flatMap((r) => r.items.map((i) => i.title))

test('Let Steer reach a running Claude Code on starts a Claude Code task\'s work with its input channel (kzhControl.channel === true), and off without it; Claude Code thinking: Summarized asks the run for summarized thinking as it starts, and As Claude Code shows it asks nothing', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE] } })
  const asked = []
  p.world.publish = (control, n) => Object.assign(control, { steer: async () => {}, sendNow: async () => {}, thinkingDisplay: async (display) => { asked.push([n, display]) } })
  await p.say('Fix the state file', { model: 'agent-claude' })
  await waitFor('the first task is done', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal((await p.http('POST', '/jev-router/live/settings', { claudeSteer: true, claudeThinking: 'summarized' })).status, 200)
  await p.say('Fix the state file again', { model: 'agent-claude' })
  await waitFor('the second task is done', () => p.world.delivered.length, (n) => n === 2, { timeoutMs: 30_000 })
  assert.equal((await p.http('POST', '/jev-router/live/settings', { claudeSteer: false, claudeThinking: 'default' })).status, 200)
  await p.say('And once more', { model: 'agent-claude' })
  await waitFor('the third task is done', () => p.world.delivered.length, (n) => n === 3, { timeoutMs: 30_000 })
  assert.deepEqual(p.world.started.map((s) => [s.provider, s.kzhControl?.channel === true]), [['claude-code', false], ['claude-code', true], ['claude-code', false]])
  assert.deepEqual(asked, [[2, 'summarized']], 'thinkingDisplay is called only while Summarized is chosen')
})

test('Let Steer reach a running Claude Code on starts only a task\'s work with its input channel: a Claude Code review of that work starts with the engine patch\'s control but no channel, since a review takes no words', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE, { ...CLAUDE, id: 'claude2', name: 'Claude Code 2' }] } })
  jev.said = { risk: 4, strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW' }
  t.after(() => { jev.said = {} })
  p.world.publish = (control) => Object.assign(control, { steer: async () => {}, sendNow: async () => {} })
  assert.equal((await p.http('POST', '/jev-router/live/settings', { claudeSteer: true })).status, 200)
  await p.say('Fix the state file')
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal(p.world.started.length, 2)
  assert.match(p.world.started[1].prompt, /^Independently review the work another agent did/)
  assert.deepEqual(p.world.started.map((s) => [s.provider, Boolean(s.kzhControl), s.kzhControl?.channel === true]), [['claude-code', true, true], ['claude-code', true, false]], 'the work has the channel, and its review none')
})

test('Steer and Send now on a Claude Code task started with Let Steer reach a running Claude Code on: the words go through its channel, read once Claude Code says a turn took them and unknown when it closes its input without saying; Send now interrupts it, and the turn it replaced reads Replaced by your message', async (t) => {
  connector(t, 'claude-code', true)
  const p = await plugin(t, { config: { agents: [CLAUDE] } })
  assert.equal((await p.http('POST', '/jev-router/live/settings', { claudeSteer: true })).status, 200)
  const { held, open } = holdOpen(t)
  const handed = []
  let control
  p.world.publish = (c) => { control = c; Object.assign(c, { steer: async (text, uuid) => { handed.push(['steer', text, uuid]); return uuid }, sendNow: async (text, uuid) => { handed.push(['sendNow', text, uuid]); return uuid } }) }
  p.world.work = async () => { await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-claude' }))
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.path === 'claude', { timeoutMs: 20_000 })
  const folds = 'Claude Code takes this in between tool calls; if it finishes first you\'ll be told it wasn\'t used.'
  assert.deepEqual([row?.controls?.steer?.words, row?.controls?.steer?.sendable, row?.controls?.steer?.now?.path], [folds, true, 'claude'])
  const res = await steerOf(p, key, 'use tabs')
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['sent', 'pending', 'Sent to jev-1: Claude Code takes it in between tool calls; if it finishes first you\'ll be told it wasn\'t used.'])
  // A result names its uuid among those its turn took in.
  control.onOutcome(res.body.id, 'delivered')
  const read = await eventually(async () => (await rowOf(p, key)).steers[0], (s) => s?.state === 'delivered')
  assert.match(read?.words ?? '', /^Read by Claude Code at \d\d:\d\d$/)
  const second = await steerOf(p, key, 'and the docs')
  // Its channel closes with the words still pending: Claude Code never said whether it read them.
  control.onOutcome(second.body.id, 'unknown')
  const unsure = await eventually(async () => (await rowOf(p, key)).steers[1], (s) => s?.state === 'unknown')
  assert.equal(unsure?.words, 'Sent; Claude Code did not say whether it read it')
  const now = await steerOf(p, key, 'stop and fix the lexer first', 'now')
  assert.deepEqual([now.body.result, now.body.state, now.body.words], ['replaced', 'pending', 'Sent to jev-1 now: Claude Code stops what it is doing and starts on your words.'])
  assert.deepEqual(handed, [['steer', `${PREFIX}use tabs`, res.body.id], ['steer', `${PREFIX}and the docs`, second.body.id], ['sendNow', `${PREFIX}stop and fix the lexer first`, now.body.id]])
  // The turn it interrupted ends with a result of its own.
  p.world.started[0].kzhTap({ provider: 'claude-code', message: { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', session_id: 's1', uuid: 'r1' } })
  const titles = await eventually(() => titlesOf(p, key), (list) => list?.includes('Replaced by your message'))
  assert.ok(titles.includes('Replaced by your message'), JSON.stringify(titles))
  control.onOutcome(now.body.id, 'delivered')
  await eventually(async () => (await rowOf(p, key)).steers[2], (s) => s?.state === 'delivered')
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "stop and fix the lexer first": read by Claude Code\.$/m)
  const record = JSON.parse(readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(record.steered, 3, 'two read, one sent with no word back')
})

test('Send now on a spawn agent at work takes the steer it has not taken in back out of its inbox, cancels its turn with its inbox kept, and queues the words after that steer as its next turn; once it takes them in both read, the step it stopped reads Replaced by your message, and its history row says it was steered', async (t) => {
  const p = await plugin(t)
  const { held, open } = holdOpen(t)
  let child
  p.world.work = async (_opts, _n, c) => { child = c; await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-deepseek' }))
  await waitFor('the agent is at work', () => child, Boolean, { timeoutMs: 20_000 })
  const row = await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.now?.path === 'spawn')
  assert.deepEqual(row?.controls?.steer?.now, { path: 'spawn', why: null, words: 'Send now stops DeepSeek agent\'s current step and gives it your words at once.' })
  const steer = await steerOf(p, key, 'use tabs')
  assert.equal(steer.body.result, 'sent')
  // A model call streams, mid-answer.
  child.stream({ type: 'start', attemptId: 'llm-1', revision: 1, turn: 1, step: 1 })
  child.stream({ type: 'chunk', attemptId: 'llm-1', revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  child.stream({ type: 'chunk', attemptId: 'llm-1', revision: 1, index: 1, time: 0, chunk: { type: 'text-delta', index: 0, text: 'Rewriting the parser' } })
  const res = await steerOf(p, key, 'stop and fix the lexer first', 'now')
  assert.deepEqual([res.body.result, res.body.state, res.body.words], ['replaced', 'pending', 'Sent to jev-1 now: DeepSeek agent stops what it is doing and starts on your words.'])
  assert.deepEqual(p.world.order.filter((x) => /^(remove|cancel|followup):/.test(x)), [`remove:${steer.body.id}`, 'cancel:parent:keepInbox', `followup:${res.body.id}`])
  assert.deepEqual(child.followups, [{ id: res.body.id, role: 'user', content: [{ type: 'text', text: `${PREFIX}use tabs` }, { type: 'text', text: `${PREFIX}stop and fix the lexer first` }], source: { kind: 'user' } }])
  // The call it was making stops, and its turn ends cancelled.
  child.stream({ type: 'chunk', attemptId: 'llm-1', revision: 1, index: 2, time: 0, chunk: { type: 'finish', reason: { kind: 'aborted' } } })
  child.stream({ type: 'end', attemptId: 'llm-1', revision: 1, index: 3, outcome: { kind: 'abandoned' } })
  child.commit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } })
  // Its next turn takes the words in.
  child.claim(res.body.id)
  const steers = await eventually(async () => (await rowOf(p, key)).steers, (list) => list?.length === 2 && list.every((s) => s.state === 'delivered'))
  assert.deepEqual(steers?.map((s) => [s.text, s.how, s.state]), [['use tabs', 'live', 'delivered'], ['stop and fix the lexer first', 'now', 'delivered']])
  const titles = await titlesOf(p, key)
  assert.equal(titles.filter((x) => x === 'Replaced by your message').length, 1, JSON.stringify(titles))
  assert.ok(!titles.includes('The model call was stopped'), 'the stopped call is not said as a failure')
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "stop and fix the lexer first": read by DeepSeek agent\.$/m)
  const record = JSON.parse(readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(record.steered, 2)
})

test('Send now on a patched Codex run hands the engine patch\'s sendNow the words with the piece\'s id, read once Codex goes on with them on the same thread (continued), its interrupted turn reading Replaced by your message; one whose turn completed first was not used, and the next attempt\'s prompt is not given it', async (t) => {
  codexOnPath(t)
  connector(t, 'codex', true)
  const p = await plugin(t, { config: { agents: [CODEX] } })
  const { held, open } = holdOpen(t)
  const handed = []
  let control
  p.world.publish = (c, n) => {
    if (n === 1) control = c
    Object.assign(c, {
      steer: async () => ({ turnId: 'tu' }),
      sendNow: async (text, id) => {
        handed.push([n, text, id])
        if (text.endsWith('the changelog')) throw Object.assign(new Error('no turn is running'), { code: 'kzh-no-turn' })
      },
    })
  }
  p.world.work = async (_opts, n) => { if (n === 1) await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-codex' }))
  await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.now?.path === 'codex', { timeoutMs: 20_000 })
  const res = await steerOf(p, key, 'run the linter first', 'now')
  assert.deepEqual([res.body.result, res.body.words], ['replaced', 'Sent to jev-1 now: Codex stops what it is doing and starts on your words.'])
  assert.deepEqual(handed, [[1, `${PREFIX}run the linter first`, res.body.id]])
  // Its turn ends interrupted, and the run goes on with the words as its next turn.
  p.world.started[0].kzhTap({ provider: 'codex', method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu1', status: 'interrupted', items: [] } } })
  control.onOutcome(res.body.id, 'continued')
  const read = await eventually(async () => (await rowOf(p, key)).steers[0], (s) => s?.state === 'delivered')
  assert.match(read?.words ?? '', /^Read by Codex at \d\d:\d\d$/)
  assert.ok((await titlesOf(p, key)).includes('Replaced by your message'))
  // A second Send now whose turn completes before the interrupt lands: the connector keeps it (kzhNext) and never goes on with it.
  const late = await steerOf(p, key, 'and the docs', 'now')
  assert.equal(late.body.result, 'replaced')
  // A third that Codex refuses, between two turns: it waits for the next attempt, as a refused steer does.
  const refused = await steerOf(p, key, 'and the changelog', 'now')
  assert.deepEqual([refused.body.result, refused.body.state, refused.body.words], ['pending', 'pending', 'Codex could not take it at this step. It goes to the next attempt if there is one.'])
  // Jev's review sends the first attempt back, so another attempt follows.
  let reviews = 0
  jev.said = { addressed: () => (++reviews === 1 ? 0.1 : 0.95), complete: () => (reviews === 1 ? 0.1 : 0.95) }
  t.after(() => { jev.said = {} })
  open()
  await waitFor('the next attempt starts', () => p.world.started.length, (n) => n === 2, { timeoutMs: 30_000 })
  const steers = await eventually(async () => (await rowOf(p, key)).steers, (list) => list?.[2]?.state === 'carried')
  assert.deepEqual(steers.map((s) => [s.text, s.state]), [['run the linter first', 'delivered'], ['and the docs', 'returned'], ['and the changelog', 'carried']])
  assert.equal(steers[1].words, 'Not used: Codex finished first')
  assert.match(p.world.started[1].prompt, /The person added this while the task ran; follow it:\n- run the linter first\n- and the changelog$/, 'the next attempt has the words its agent read and those it refused, and not those it never took in')
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.match(p.world.delivered[0].content[0].text, /^Your guidance "and the docs": not used \(arrived after the work finished\)\.$/m)
})

test('a Send now Codex refuses on the last attempt of its run stops nothing, so a later stop of its turn is no replacement, and was not used once the run ends: its bubble in the Live tab says so, as its Tasks row does', async (t) => {
  codexOnPath(t)
  connector(t, 'codex', true)
  const p = await plugin(t, { config: { agents: [CODEX] } })
  const { held, open } = holdOpen(t)
  p.world.publish = (c) => Object.assign(c, { sendNow: async () => { throw Object.assign(new Error('no turn is running'), { code: 'kzh-no-turn' }) } })
  p.world.work = async () => { await held }
  const key = keyOf(await p.say('Fix the state file', { model: 'agent-codex' }))
  await eventually(() => rowOf(p, key), (r) => r?.controls?.steer?.now?.path === 'codex', { timeoutMs: 20_000 })
  const refused = await steerOf(p, key, 'and the changelog', 'now')
  assert.deepEqual([refused.body.result, refused.body.state], ['pending', 'pending'])
  // A turn that ends interrupted after it, as a Stop of another kind leaves it, was not stopped for the words.
  p.world.started[0].kzhTap({ provider: 'codex', method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu1', status: 'interrupted', items: [] } } })
  assert.equal((await titlesOf(p, key)).includes('Replaced by your message'), false, 'the refusal took back the step it was to replace')
  open()
  await waitFor('the result is posted', () => p.world.delivered.length, (n) => n === 1, { timeoutMs: 30_000 })
  assert.equal(p.world.started.length, 1, 'no attempt followed the one that refused the words')
  const s = (await rowOf(p, key)).steers[0]
  assert.deepEqual([s.state, s.words], ['returned', 'Not used: Codex finished first'])
  const bubble = (await p.live(`task=${key}`)).body.runs[0].items.find((i) => i.kind === 'steer')
  assert.deepEqual([bubble?.title, bubble?.meta?.state, bubble?.meta?.words], ['You: and the changelog', 'returned', 'Not used: Codex finished first'], 'its bubble says so before its transcript is saved, not Waiting for its next step')
})

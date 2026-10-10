// Send now, Put first in line and Steer for waiting work through the plugin (docs/live-agent-view.md
// Feature 5, slice 7): POST /jev-router/tasks/start-now and /jev-router/tasks/steer, the /now and
// /steer commands, and `@jev-5 <words>` in the chat. apply() gets just enough of the plugin runtime for
// it, as test/live-routes.test.js gives it: Jev as the TypeSafe SDK answering from this file, background
// tasks on a job service, and a spawn agent each start of which works until the test lets it end.
// Two chats, each in a folder of its own, so a task can wait for a free slot rather than its folder.
// Every route here answers 404 in the code before the slice.
//
// First, an engine home of this file's own, before the plugin is loaded (it reads DSH_HOME once).
import 'data:text/javascript,import{mkdtempSync}from"node:fs";import{tmpdir}from"node:os";import{join}from"node:path";process.env.DSH_HOME=mkdtempSync(join(tmpdir(),"kz-steer-dsh-"))'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
// A namespace, so the file loads where the plugin lacks what these tests are about.
import * as jevRouter from '../index.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const made = [process.env.DSH_HOME]
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
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

// The network as this file allows it: this PC and Jev; anything else is refused.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input)
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (url === CONNECTIVITY || url.startsWith('https://api.typesafe.ai')) return Promise.resolve(new Response(''))
  return Promise.reject(new TypeError(`fetch failed: ${url} is not reachable from this test`))
}

// Jev, as the TypeSafe SDK answers: every message is work that changes the project, every review accepts.
TypeSafeClient.prototype.systemOne = function systemOne(request) {
  const answers = {}
  for (const [name, q] of Object.entries(request.questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria)
      const c = name === 'capability' && keys.includes('project_change') ? 'project_change' : name === 'kind' ? 'task' : keys[0]
      answers[name] = { type: 'choice', choice: c, confidence: 0.85, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.85 : 0.15 / Math.max(1, keys.length - 1)])) }
    } else if (q.type === 'score') answers[name] = { type: 'score', score: 1, confidence: 0.8 }
    else answers[name] = { type: 'noul', noul: ['addressed', 'complete', 'needsTests'].includes(name) ? 0.95 : 0.05, confidence: 0.9 }
  }
  return Promise.resolve({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers })
}

/** A git folder of its own for a chat's tasks to work in. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-steer-work-'))
  made.push(dir)
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const AGENTS = [
  { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', description: 'The native harness agent on the DeepSeek API, paid per token.', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]

/**
 * The plugin on a PC of its own, closed when the test ends, with two chats, `a` and `b`, each in a
 * folder of its own. Each agent start is kept in `world.started` with the prompt and the effort it was
 * handed, and works until `world.finish(n)` lets the n-th end, or it is stopped. Its in-process agent
 * keeps each steer it is given in `world.steered`, and never reads one. `jobs` overrides the job
 * service, and `rows` are the tasks tasks.jsonl holds as the plugin starts.
 */
async function plugin(t, { jobs: jobService = null, rows = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kz-steer-'))
  made.push(root)
  const dataDir = join(root, 'data')
  const harnessDir = join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  // Tasks from before the app restarted, as tasks.jsonl keeps them.
  if (rows.length) writeFileSync(join(dataDir, 'tasks.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  const pinsFile = join(harnessDir, 'config', 'laya.json')
  mkdirSync(dirname(pinsFile), { recursive: true })
  copyFileSync(join(REPO, 'config', 'laya.json'), pinsFile)
  const world = { started: [], ends: new Map(), delivered: [], notices: [], steered: [] }
  world.finish = (n) => world.ends.get(n)?.()
  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { capabilities: { toolFilter: true } } : undefined),
    async start(provider, opts) {
      const n = world.started.push({ provider, prompt: opts.prompt?.[0]?.text ?? '', label: opts.label, effort: opts.agentOptions?.reasoningEffort ?? null })
      const result = new Promise((res, rej) => {
        world.ends.set(n, () => res({ stopReason: 'completed', output: [{ type: 'text', text: `Did it (attempt ${n}).` }] }))
        opts.signal?.addEventListener('abort', () => rej(opts.signal.reason), { once: true })
      })
      result.catch(() => {})
      // With `world.deaf` its agent has no inbox, so it takes no words while it works.
      const localAgent = { ...(world.deaf ? {} : { steer: (message) => { world.steered.push({ n, ...message }) } }), ctx: { on: () => () => {} }, session: { seq: 0, snapshotEvents: () => [] } }
      return { id: `child-session-${n}`, result, localAgent, dispose: async () => {} }
    },
  }
  let jobCount = 0
  const jobs = jobService ?? { start: (spec) => { const id = `jev-${++jobCount}`; spec.run(); return id }, wait: () => new Promise(() => {}), read: (id) => ({ text: '', snapshot: { id } }), kill: () => 'requested' }
  const isResult = (msg) => String(msg?.source?.summary ?? '').includes('·')
  const chat = (id) => {
    const workspace = repo()
    return { id, session: { id, header: { cwd: workspace }, append: (_kind, msg) => (isResult(msg) ? world.delivered : world.notices).push(msg) }, whenIdle: async () => {} }
  }
  const chats = { a: chat('s-a'), b: chat('s-b') }
  const byId = Object.fromEntries(Object.values(chats).map((c) => [c.id, c]))
  const effects = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') effects.push(d) }
  const routes = []
  const commands = new Map()
  let adapter = null
  const runtime = {
    effect,
    llm: { registerAdapter: (ids, a) => { if (ids.includes('jev')) adapter = a; return () => {} }, stream: () => (async function* () {})(), resolveModel: async () => (world.seesImages ? { inputModalities: ['text', 'image'] } : null), listProviders: () => [], listModels: async () => [] },
    emit: () => {}, get: () => null,
    agents: { get: (id) => byId[id] ?? null, currentInitiator: () => chats.a },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => 0 },
    workspaceRegistry: { list: () => [] },
  }
  const tools = new Map()
  const ctx = {
    credentials: { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'tsk_live_test_key' } : undefined) },
    effect, subagents,
    // The engine's store of attached pictures, which hands each one over as it was attached.
    get: (name) => (name === 'jobs' ? jobs : name === 'attachments' ? { readImageRequest: async () => ({ mediaType: 'image/png', data: Buffer.from('a picture') }) } : null),
    commands: { register: (c) => { commands.set(c.name, c) } },
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
    checks: { enabled: false },
    format: { enabled: false },
    laya: { port: await freePort(), connectivityUrl: CONNECTIVITY },
  }), {
    laya: { harnessDir, run: async () => null, timing: { readyPollMs: 20, healthTimeoutMs: 1000, idleCheckMs: 20, exitWaitMs: 2000 } },
    localModels: { modules: [], modelsDir: join(harnessDir, 'no-models') },
    live: { pumpMs: 20 },
    // A task with no start reply gets its started notice after this grace, not 5 s.
    replies: { graceMs: 50 },
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const end of world.ends.values()) end()
    for (const d of effects.reverse()) { try { await d() } catch { /* already gone */ } }
  }
  t.after(close)
  function http(method, path, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: method === 'GET' ? {} : { 'content-type': 'application/json' } })
    return new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }) } }
      routes[0].handler(req, res).catch(reject)
    })
  }
  const said = { a: [], b: [] }
  /** One typed message in chat `in` ('a' or 'b'), with the `effort` picked and the `images` attached, if any, and the reply's text. */
  async function say(text, { in: which = 'a', effort = null, images = [] } = {}) {
    const messages = said[which]
    messages.push({ role: 'user', content: [{ type: 'text', text }, ...images] })
    let out = ''
    for await (const e of adapter.stream({ model: 'jev-auto', messages: [...messages], sessionId: chats[which].id, signal: new AbortController().signal, ...(effort ? { reasoningEffort: effort } : {}) })) if (e.type === 'text-delta') out += e.text
    messages.push({ role: 'assistant', content: [{ type: 'text', text: out }] })
    return out
  }
  /** A command as the chat runs it: `/now jev-2` is command('now', 'jev-2'). */
  const command = (name, rawInput, { in: which = 'a' } = {}) => commands.get(name)?.handler({ agent: chats[which], rawInput, signal: new AbortController().signal })
  const tasks = async () => (await http('GET', '/jev-router/tasks')).body.tasks
  const task = async (jobId) => (await tasks()).find((x) => x.jobId === jobId)
  return { dataDir, world, chats, http, say, command, commands, tasks, task, close }
}

/** The job id a start reply names. */
const jobOf = (reply) => /\*\*(jev-\d+)\*\*/.exec(reply)?.[1] ?? null

test('POST /tasks/start-now starts a task waiting for a free slot at once, over Tasks at once, and says so; one behind a task in its folder is refused with that task\'s id, and Stop it and start this stops that task and starts it in its place', async (t) => {
  const p = await plugin(t)
  assert.equal((await p.http('POST', '/jev-router/local/settings', { maxConcurrentTasks: 1 })).status, 200)
  const first = jobOf(await p.say('Fix the parser'))
  await eventually(() => p.world.started.length, (n) => n === 1)
  const other = jobOf(await p.say('Tidy the docs', { in: 'b' }))
  const behind = jobOf(await p.say('Then add a test'))
  assert.deepEqual([first, other, behind], ['jev-1', 'jev-2', 'jev-3'])
  const waiting = await p.task(other)
  assert.deepEqual([waiting.state, waiting.waiting?.why], ['queued', 'cap'])
  const res = await p.http('POST', '/jev-router/tasks/start-now', { key: waiting.key })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, { result: 'started', holder: null, words: 'jev-2 started, over your limit of 1 task at once: the next task to end frees no slot.' })
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2, 'its agent started beside the first')
  assert.notEqual((await p.task(other)).state, 'queued')
  // Behind the task changing its folder: refused, naming that task, and nothing moves.
  const third = await p.task(behind)
  assert.equal(third.controls.sendNow, 'workspace')
  const refused = await p.http('POST', '/jev-router/tasks/start-now', { key: third.key })
  assert.deepEqual(refused.body, { result: 'workspace-busy', holder: 'jev-1', words: `jev-3 could not start now: jev-1 is changing ${basename(p.chats.a.session.header.cwd)}, and two tasks never write one folder at once. It stays in line; Run next puts it first.` })
  assert.equal(p.world.started.length, 2)
  // Stop it and start this: the first task stops, and the third takes its folder.
  const swap = await p.http('POST', '/jev-router/tasks/start-now', { key: third.key, stop: 'jev-1' })
  assert.deepEqual(swap.body, { result: 'stopping', holder: 'jev-1', words: 'Stopping jev-1; jev-3 starts as soon as it has stopped.' })
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 3), 3, 'the third started once the first had stopped')
  assert.equal((await p.task(first)).state, 'stopped')
  assert.match(p.world.started[2].prompt, /Then add a test/)
  // A key that names no task, and a request that names none at all.
  assert.equal((await p.http('POST', '/jev-router/tasks/start-now', { key: 'no-such-task' })).status, 404)
  assert.equal((await p.http('POST', '/jev-router/tasks/start-now', {})).status, 400)
  assert.equal((await p.http('POST', '/jev-router/tasks/start-now', { key: third.key })).body.result, 'not-waiting')
})

test('/now jev-N starts a task of its chat waiting for a free slot at once, over Tasks at once, as Send now does; one behind a task in its folder is refused in that task\'s words and nothing starts, and an id that is no task id gets the usage', async (t) => {
  const p = await plugin(t)
  assert.equal((await p.http('POST', '/jev-router/local/settings', { maxConcurrentTasks: 1 })).status, 200)
  const first = jobOf(await p.say('Fix the parser'))
  await eventually(() => p.world.started.length, (n) => n === 1)
  const other = jobOf(await p.say('Tidy the docs', { in: 'b' }))
  const behind = jobOf(await p.say('Then add a test'))
  assert.deepEqual([first, other, behind], ['jev-1', 'jev-2', 'jev-3'])
  assert.deepEqual(await p.command('now', 'jev 2', { in: 'b' }), { kind: 'error', text: 'Usage: /now <task id>, e.g. /now jev-5' })
  assert.deepEqual(await p.command('now', behind), { kind: 'error', text: `jev-3 could not start now: jev-1 is changing ${basename(p.chats.a.session.header.cwd)}, and two tasks never write one folder at once. It stays in line; Run next puts it first.` })
  assert.equal(p.world.started.length, 1, 'nothing started for it')
  assert.deepEqual(await p.command('now', other, { in: 'b' }), { kind: 'success', text: 'jev-2 started, over your limit of 1 task at once: the next task to end frees no slot.' })
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2, 'its agent started beside the first')
  assert.match(p.world.started[1].prompt, /Tidy the docs/)
  assert.notEqual((await p.task(other)).state, 'queued')
  assert.equal((await p.task(behind)).state, 'queued', 'the task behind the writer still waits')
})

test('POST /tasks/steer with how amend adds the words to a waiting task, which its agent is handed and its history row keeps; @jev-N in the chat does the same, and /steer and /now answer for a task by its id', async (t) => {
  const p = await plugin(t)
  const first = jobOf(await p.say('Fix the parser'))
  await eventually(() => p.world.started.length, (n) => n === 1)
  const second = jobOf(await p.say('Tidy the docs'))
  const queued = await p.task(second)
  assert.equal(queued.state, 'queued')
  const res = await p.http('POST', '/jev-router/tasks/steer', { key: queued.key, text: 'also update the README', how: 'amend' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body, { result: 'added', state: 'added', words: 'Added to jev-2 before it starts. Jev chooses the agent with it.' })
  const reply = await p.say('@jev-2 and keep the changelog short')
  assert.equal(reply, 'jev-2 hasn\'t started, so I added this to its task.')
  assert.equal((await p.tasks()).length, 2, 'nothing new was queued')
  const amended = 'Tidy the docs\n\nAdded while it waited: also update the README\n\nAdded while it waited: and keep the changelog short'
  const row = await p.task(second)
  assert.equal(row.taskText, amended)
  assert.deepEqual(row.steers.map((s) => [s.how, s.state, s.text]), [['amend', 'added', 'also update the README'], ['amend', 'added', 'and keep the changelog short']])
  // /steer from the chat, by the task's id.
  assert.deepEqual(await p.command('steer', `${second} and link the guide`), { kind: 'success', text: 'Added to jev-2 before it starts. Jev chooses the agent with it.' })
  assert.deepEqual(await p.command('steer', 'jev-9 anything'), { kind: 'error', text: 'There is no jev-9 in this chat, so nothing was sent.' })
  assert.deepEqual(await p.command('now', 'jev-2', { in: 'b' }), { kind: 'error', text: 'There is no jev-2 in this chat, so nothing was sent.' }, 'a task of another chat is no task of this one')
  assert.equal((await p.command('steer', 'jev-2')).kind, 'error', 'no words, nothing to add')
  // Its run is handed the task with every piece added once the first ends.
  p.world.finish(1)
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2)
  assert.ok(p.world.started[1].prompt.includes(`${amended}\n\nAdded while it waited: and link the guide`), p.world.started[1].prompt)
  // Since slice 8 words for a task at work go to the agent at work.
  assert.equal(await p.say('@jev-2 one more thing'), 'Sent to jev-2: DeepSeek agent takes it in at its next step.')
  assert.equal((await p.http('POST', '/jev-router/tasks/steer', { key: row.key, text: 'late', how: 'amend' })).body.result, 'started')
  assert.deepEqual(await p.command('now', 'jev-2'), { kind: 'error', text: 'jev-2 has already started.' })
  p.world.finish(2)
  await eventually(() => p.world.delivered.length, (n) => n === 2)
  const history = readFileSync(join(p.dataDir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(history.some((r) => r.taskKey === row.key && String(r.task).startsWith(amended)), 'the history row of its run keeps the words')
  assert.equal(await p.say(`@${first} what about the tests`), `${first} already finished. Send it without @${first} to start a new task.`)
  assert.equal((await p.http('POST', '/jev-router/tasks/steer', { key: row.key, text: '' })).status, 400)
  assert.deepEqual((await p.http('POST', '/jev-router/tasks/steer', { key: row.key, text: 'x', how: 'live' })).body.result, 'already-finished', 'since slice 8 a task at work takes words live, and one that ended none')
  assert.deepEqual((await p.http('POST', '/jev-router/tasks/steer', { key: row.key, text: 'x', how: 'now' })).body.result, 'already-finished', 'since slice 10 Send now stops a task at work for the words, and one that ended takes none')
  assert.equal((await p.http('POST', '/jev-router/tasks/steer', { key: row.key, text: 'x', how: 'later' })).status, 400)
})

test('POST /tasks/steer with how follow-up queues a task of its own on the agent the task works on, first in its folder\'s line; restart stops the task and starts it again with the words, saying why in its result, and its started notice tells the chat', async (t) => {
  const p = await plugin(t)
  const first = jobOf(await p.say('Fix the parser'))
  await eventually(() => p.world.started.length, (n) => n === 1)
  const later = jobOf(await p.say('Tidy the docs'))
  const running = await eventually(() => p.task(first), (x) => x?.agent === 'deepseek')
  const res = await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'add a test for it', how: 'follow-up' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.result, 'queued')
  const follow = await p.task(res.body.jobId)
  assert.deepEqual([follow.taskText, follow.agent, follow.state, follow.waiting?.ahead], ['Follow-up to jev-1: add a test for it', 'deepseek', 'queued', 0], 'forced to the same agent, first in line')
  assert.equal((await p.task(later)).waiting.ahead, 1, 'the task queued before it now waits behind it')
  assert.equal(res.body.words, `Queued ${follow.jobId} as a follow-up to jev-1, first in line in ${basename(p.chats.a.session.header.cwd)}, on DeepSeek agent.`)
  // Restart: the task at work stops, and starts again with the words, first in line.
  const again = await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'use the new grammar', how: 'restart' })
  assert.equal(again.body.result, 'restarting')
  const fresh = again.body.jobId
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2, 'it started again once the first had stopped')
  assert.ok(p.world.started[1].prompt.includes('Fix the parser\n\nThe earlier attempt (jev-1) was stopped; its changes are in the working tree. Also: use the new grammar'), p.world.started[1].prompt)
  const stopped = await eventually(() => p.task(first), (x) => x?.state === 'stopped')
  assert.equal(stopped.terminalReason, `Stopped to start again as ${fresh} with your guidance.`)
  assert.equal((await p.task(fresh)).agent, 'deepseek')
  // No start reply went out for it, so its started notice tells the chat it began.
  const started = await eventually(() => p.world.notices.map((m) => m.source?.summary), (s) => s.some((x) => x?.startsWith(`${fresh} started`)))
  assert.ok(started.some((x) => x?.startsWith(`${fresh} started: DeepSeek agent`)), JSON.stringify(started))
  // A waiting task is steered by amending it, not by a follow-up or a fresh start.
  const waiting = await p.task(later)
  assert.equal((await p.http('POST', '/jev-router/tasks/steer', { key: waiting.key, text: 'x', how: 'follow-up' })).body.words, `${later} hasn't started: Steer adds your words to it before it starts.`)
})

test('a fresh start runs as its task was asked for, at the effort it was queued with and with its pictures, while a follow-up is queued as the person\'s words alone at Auto effort', async (t) => {
  const p = await plugin(t)
  p.world.seesImages = true
  const picture = { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', attachment: { attachmentId: 'shot-1' } }
  const first = jobOf(await p.say('Fix the parser as in this screenshot', { effort: 'xhigh', images: [picture] }))
  const running = await eventually(() => p.task(first), (x) => x?.agent === 'deepseek')
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 1), 1)
  assert.equal(p.world.started[0].effort, 'max', 'Extra High runs DeepSeek at Max')
  const follow = (await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'add a test for it', how: 'follow-up' })).body.jobId
  const fresh = (await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'use the new grammar', how: 'restart' })).body.jobId
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2, 'it started again once the first had stopped')
  assert.equal(p.world.started[1].effort, 'max', 'at the effort it was queued with, not at Auto')
  const rows = await eventually(() => readFileSync(join(p.dataDir, 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), (r) => !!r?.some((x) => x.jobId === fresh))
  const row = (jobId) => rows.find((x) => x.jobId === jobId)
  assert.deepEqual(row(fresh)?.modalities, ['text', 'image'], 'with its pictures, as it was queued')
  assert.deepEqual(row(follow)?.modalities, ['text'], 'a follow-up is the person\'s words alone')
  assert.equal((await p.task(follow)).effort, null, 'at Auto effort')
})

test('Steer queues nothing for a task from before the app restarted, which has no chat agent to queue for, nor where background tasks are unavailable, and stops nothing for a fresh start it could not queue', async (t) => {
  let n = 0
  let unavailable = false
  const jobs = {
    start: (spec) => { if (unavailable) throw new Error('background jobs are unavailable: no job controller'); const id = `jev-${++n}`; spec.run(); return id },
    wait: () => new Promise(() => {}), read: (id) => ({ text: '', snapshot: { id } }), kill: () => 'requested',
  }
  const old = { key: 'k-old', jobId: 'jev-7', sessionId: 's-a', workspace: join(tmpdir(), 'kz-steer-old'), taskName: 'Old work', taskText: 'Old work', state: 'done', queuedAt: 1, startedAt: 2, finishedAt: 3, deliveryState: 'delivered' }
  const p = await plugin(t, { jobs, rows: [old] })
  const res = await p.http('POST', '/jev-router/tasks/steer', { key: 'k-old', text: 'and its tests', how: 'follow-up' })
  assert.deepEqual([res.status, res.body], [200, { result: 'no-owner', state: null, words: 'jev-7 is from before the app restarted, so nothing can be queued for it from here. Send your words as a new message to start a new task.' }])
  const first = jobOf(await p.say('Fix the parser'))
  const running = await eventually(() => p.task(first), (x) => x?.agent === 'deepseek')
  unavailable = true
  for (const how of ['follow-up', 'restart']) {
    const r = await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'again', how })
    assert.deepEqual(r.body, { result: 'unavailable', state: null, words: 'Background tasks are not available in this chat, so nothing was queued.' }, how)
  }
  assert.equal((await p.task(first)).state, 'running', 'the task at work goes on')
  assert.deepEqual((await p.tasks()).map((x) => x.jobId).sort(), ['jev-1', 'jev-7'], 'nothing was queued')
})

test('the job limit refuses a follow-up with the readable words, and nothing is stopped for a fresh start it could not queue', async (t) => {
  let n = 0
  const jobs = {
    start: (spec) => { if (n >= 1) throw new Error('background job limit reached for this owner (limit: 1); use job_kill to stop an unneeded job, wait for it to finish, then retry'); const id = `jev-${++n}`; spec.run(); return id },
    wait: () => new Promise(() => {}), read: (id) => ({ text: '', snapshot: { id } }), kill: () => 'requested',
  }
  const p = await plugin(t, { jobs })
  const first = jobOf(await p.say('Fix the parser'))
  const running = await eventually(() => p.task(first), (x) => x?.agent === 'deepseek')
  const res = await p.http('POST', '/jev-router/tasks/steer', { key: running?.key, text: 'add a test', how: 'follow-up' })
  assert.deepEqual([res.status, res.body], [400, { error: 'Too many background tasks in this chat (1). Wait for one to finish or remove a waiting one, then send it again.' }])
  const restart = await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'again', how: 'restart' })
  assert.equal(restart.body.error, 'Too many background tasks in this chat (1). Wait for one to finish or remove a waiting one, then send it again.')
  assert.notEqual((await p.task(first)).state, 'stopped', 'the task at work goes on')
})

test('Steer on a task at work goes to its agent, and Stop it and start again stops it and starts the continuation, forced to the same agent and ahead of the task queued before it; the words its agent never took in come back on the stopped result as not used', async (t) => {
  const p = await plugin(t)
  const first = jobOf(await p.say('Fix the parser'))
  const running = await eventually(() => p.task(first), (x) => x?.agent === 'deepseek' && x?.controls?.steer?.path === 'spawn')
  const later = jobOf(await p.say('Tidy the docs'))
  const live = await p.http('POST', '/jev-router/tasks/steer', { key: running?.key, text: 'use tabs', how: 'live' })
  assert.equal(live.status, 200, JSON.stringify(live.body))
  assert.deepEqual([live.body.result, live.body.words], ['sent', 'Sent to jev-1: DeepSeek agent takes it in at its next step.'])
  // /steer in the chat gives words to it as Now, while it works does, and says so as a success.
  assert.deepEqual(await p.command('steer', `${first} use spaces in the docs`), { kind: 'success', text: 'Sent to jev-1: DeepSeek agent takes it in at its next step.' })
  assert.deepEqual(p.world.steered.map((m) => [m.n, m.role, m.content[0].text]), [[1, 'user', '(Added by the person while you work on this task.) use tabs'], [1, 'user', '(Added by the person while you work on this task.) use spaces in the docs']])
  const again = await p.http('POST', '/jev-router/tasks/steer', { key: running.key, text: 'use the new grammar', how: 'restart' })
  assert.equal(again.body.result, 'restarting')
  const fresh = again.body.jobId
  assert.equal(await eventually(() => p.world.started.length, (n) => n === 2), 2, 'the fresh start goes ahead of the task queued before it')
  assert.ok(p.world.started[1].prompt.startsWith('Fix the parser\n\nThe earlier attempt (jev-1) was stopped; its changes are in the working tree. Also: use the new grammar'), p.world.started[1].prompt)
  assert.equal((await p.task(fresh)).agent, 'deepseek', 'forced to the agent the stopped task worked on')
  assert.equal((await p.task(later)).state, 'queued')
  const stopped = await eventually(() => p.world.delivered.find((m) => m.source.summary.startsWith(`${first} `)), Boolean)
  assert.match(stopped?.content[0].text ?? '', /^Your guidance "use tabs": not used \(arrived after the work finished\)\.$/m)
  assert.deepEqual((await p.task(first)).steers.map((s) => [s.state, s.words]), [['returned', 'Not used: DeepSeek agent finished first'], ['returned', 'Not used: DeepSeek agent finished first']])
})

test('/steer jev-N on a task whose agent takes no words while it works notes them for its next attempt and says so, as a success', async (t) => {
  const p = await plugin(t)
  p.world.deaf = true
  const first = jobOf(await p.say('Fix the parser'))
  const running = await eventually(() => p.task(first), (x) => x?.controls?.steer?.why === 'none')
  assert.deepEqual([running?.controls?.steer?.path, running?.controls?.steer?.sendable], [null, false])
  assert.deepEqual(await p.command('steer', `${first} use tabs`), { kind: 'success', text: 'DeepSeek agent can\'t take messages mid-run. It goes to the next attempt if there is one.' })
  assert.deepEqual((await p.task(first)).steers.map((s) => [s.text, s.how, s.state]), [['use tabs', 'live', 'pending']])
  assert.deepEqual(p.world.steered, [])
  p.world.finish(1)
  await eventually(() => p.world.delivered.length, (n) => n === 1)
  assert.deepEqual((await p.task(first)).steers.map((s) => s.state), ['returned'])
})

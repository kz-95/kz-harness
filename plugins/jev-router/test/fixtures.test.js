// The shared test code in test/fixtures, which every group's tests run against (docs/laya-auto.md
// 9.2): the fake laya.serve, and kzh-bodies.json, KzH's four request bodies.
//
// These tests test test code, not the plugin: the fake imports nothing of it, and kzh-bodies.json
// is held to the jev.js builders, which this change leaves as they were. So they pass on any code
// with those builders, the code before Laya included, and are not asked to fail there as every other
// new test is: scripts/red-check.mjs runs this file at the base instead, and every new test in it
// must pass there, which shows it tests only the fixtures (9.1). A test that needs code the change
// adds or edits belongs in that code's own test file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createJev } from '../jev.js'
import { CAPABILITIES } from '../capabilities.js'
import { defaultAnswer, startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-laya-serve.mjs', import.meta.url))
const BODIES = JSON.parse(readFileSync(new URL('./fixtures/kzh-bodies.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- kzh-bodies.json

/** Every call the jev.js builders send while `run` runs, taken at the SDK boundary; nothing is sent. */
function capture(run) {
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = function (body) { sent.push(body); return new Promise(() => {}) }
  try { run(createJev({ apiKey: 'tsk_test_key' })) } finally { TypeSafeClient.prototype.systemOne = real }
  return sent
}
const clone = (o) => JSON.parse(JSON.stringify(o))
const ALL_CAPABILITIES = Object.keys(CAPABILITIES).filter((c) => c !== 'human_required')

// A staleness guard, which passes on any code whose jev.js builders are these: the fixture held to
// the builder calls it was made from.
test('kzh-bodies.json holds the four bodies the jev.js builders send, the review state 9,206 characters', () => {
  const task = 'The login form in src/auth/LoginForm.tsx lets a user submit twice when they double-click, which creates two sessions. Fix it so a second submit is ignored while the first is in flight, and add a test for it.'
  const patch = 'diff --git a/src/auth/LoginForm.tsx b/src/auth/LoginForm.tsx\n' + Array.from({ length: 120 }, (_, i) => (i % 3 ? '+  const [submitting, setSubmitting] = useState(false) // line ' + i : '-  onSubmit={handleSubmit} // old line ' + i)).join('\n')
  const context = BODIES.task.state.workspace
  const [intent, taskCall, resource, review] = capture((jev) => {
    jev.intent({ message: 'why does the login form create two sessions?' })
    jev.route({ task, context, capabilities: ALL_CAPABILITIES, ask: { task: true, resource: false, judgments: false } })
    jev.route({ task, context, candidates: [{ key: 'RESOURCE_A' }, { key: 'RESOURCE_B' }], strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT', 'PREMIUM_DIRECT', 'CHEAP_THEN_PREMIUM_REVIEW'], taskProfile: { complexity: 0.4 }, ask: { task: false, resource: true, judgments: true } })
    jev.assess({ task, routing: { taskType: 'debugging', risk: 0.4, complexity: 0.3 }, attempts: [{ agent: 'claude', role: 'executor', stopReason: 'end_turn', answerText: 'I added a submitting flag to LoginForm and disabled the button while the request is in flight. '.repeat(20), changedFiles: ['src/auth/LoginForm.tsx', 'src/auth/LoginForm.test.tsx'] }], checks: { results: [{ name: 'test', passed: true, exitCode: 0, durationMs: 4000, output: 'PASS src/auth/LoginForm.test.tsx\n  ok 12 tests\n'.repeat(10) }], regressed: [], fixed: [], failing: [] }, diff: { stat: ' src/auth/LoginForm.tsx | 14 +++--\n src/auth/LoginForm.test.tsx | 30 ++++++', patch }, agents: [{ id: 'claude', description: 'Claude Code' }, { id: 'codex', description: 'Codex CLI' }] })
  })
  // A stale fixture fails here: rebuild it from these same builder calls.
  assert.deepEqual(BODIES, {
    intent: { phase: 'intent', ...clone(intent) },
    task: { phase: 'route', ...clone(taskCall) },
    resource: { phase: 'route', ...clone(resource) },
    review: { phase: 'review', ...clone(review) },
  })
  assert.equal(JSON.stringify(BODIES.review.state).length, 9206)
  assert.deepEqual(Object.keys(BODIES.task.questions).length, 20)
})

// ---------------------------------------------------------------- the fake laya.serve

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const post = (url, body, key, signal) => fetch(`${url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal })
const NOUL = { type: 'noul', instructions: 'Is it?' }

test('the fake answers /health only once loaded, echoing the device, and checks the key, the size and the labels', async (t) => {
  const port = await freePort()
  const starting = startFakeLaya({ port, apiKey: 'k', loadMs: 300, device: 'cuda' })
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'the port is not listening while the model loads')
  const fake = await starting
  t.after(() => fake.close())
  assert.deepEqual(await (await fetch(`${fake.url}/health`)).json(), { status: 'ok', loaded: ['english'], device: 'cuda' })

  const q = { questions: { x: NOUL } }
  let res = await post(fake.url, q)
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { detail: 'invalid or missing bearer token' })
  assert.equal((await post(fake.url, q, 'wrong')).status, 401)
  assert.equal((await post(fake.url, q, 'k')).status, 200)
  res = await post(fake.url, { questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, NOUL])) }, 'k')
  assert.equal(res.status, 413)
  assert.deepEqual(await res.json(), { detail: 'too many questions (65 > 64)' })
  res = await post(fake.url, { questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { a: null }, labels: { true: 'A', false: 'B' } } } }, 'k')
  assert.equal(res.status, 422)
  assert.deepEqual(await res.json(), { detail: "question 'pick': 'labels' is only supported for noul questions" })
  res = await post(fake.url, { questions: { yes: { ...NOUL, labels: { true: 'A', false: 'A' } } } }, 'k')
  assert.equal(res.status, 422)
  assert.match((await res.json()).detail, /^question 'yes': noul labels must map exactly/)
  res = await post(fake.url, { questions: { yes: { ...NOUL, criteria: { yes: 'x' } } } }, 'k')
  assert.equal(res.status, 422)
  assert.equal((await post(fake.url, { questions: { yes: { ...NOUL, labels: { true: 'A', false: 'B' }, criteria: { true: 'y', false: 'n' } } } }, 'k')).status, 200)
})

test('the fake refuses a malformed question with laya/agent.py\'s own 422 text, word for word', async (t) => {
  const fake = await startFakeLaya()
  t.after(() => fake.close())
  const choiceNeeds = "a choice question takes 'criteria' as a dict of label -> description, or a list of labels"
  const cases = [
    [{ q: ['noul'] }, "question 'q': definition must be a dict, got list"],
    [{ q: null }, "question 'q': definition must be a dict, got NoneType"],
    [{ q: 1.5 }, "question 'q': definition must be a dict, got float"],
    [{ q: { type: 'nouls', instructions: 'x' } }, "question 'q': unknown type 'nouls'; use one of ['choice', 'noul', 'score']"],
    [{ q: { instructions: 'x' } }, "question 'q': unknown type None; use one of ['choice', 'noul', 'score']"],
    // Python's %r quotes an id holding a single quote in double quotes, and escapes a newline.
    [{ "it's": { type: 'noul' } }, `question "it's": no 'instructions'; add the text the model should answer`],
    [{ 'a\nb': { type: 'noul' } }, "question 'a\\nb': no 'instructions'; add the text the model should answer"],
    [{ q: { type: 'choice', instructions: 'x' } }, `question 'q': ${choiceNeeds}`],
    [{ q: { type: 'choice', instructions: 'x', criteria: 'a' } }, `question 'q': ${choiceNeeds}`],
    [{ q: { type: 'choice', instructions: 'x', criteria: [] } }, "question 'q': a choice question needs at least one criterion"],
    [{ q: { type: 'score', instructions: 'x', criteria: { 0: 'none' } } }, "question 'q': a score question takes 'criteria' as a list of level descriptions, index 0 first"],
    [{ q: { type: 'score', instructions: 'x', criteria: [] } }, "question 'q': a score question needs at least one level"],
    [{ q: { type: 'noul', instructions: 'x', criteria: ['yes'] } }, "question 'q': a noul question takes 'criteria' as a dict with optional 'true'/'false' descriptions, or omits it"],
    [{ yes: { type: 'noul', instructions: 'x', criteria: { yes: 'x', TRUE: 'y' } } }, "question 'yes': a noul question takes 'criteria' keyed only 'true'/'false' (either or both, and omitted is fine), got ['true', 'yes']. "
      + "Those keys are the option texts the model reads; any other key was silently dropped and replaced with the defaults. If you want the answer worded differently, keep 'criteria' keyed 'true'/'false' and set 'labels' instead."],
    [{ q: { type: 'choice', instructions: 'x', criteria: ['a'], labels: null } }, "question 'q': 'labels' is only supported for noul questions"],
    [{ q: { type: 'noul', instructions: 'x', labels: { true: 'A', false: ' A ' } } }, "question 'q': noul labels must map exactly 'false' and 'true' to distinct non-empty strings"],
  ]
  for (const [questions, detail] of cases) {
    const res = await post(fake.url, { model: 'english', questions })
    assert.equal(res.status, 422, detail)
    assert.deepEqual(await res.json(), { detail })
  }
  // `labels: null` on a noul is Laya's default pair; a type Python cannot hash is a bare 500.
  assert.equal((await post(fake.url, { model: 'english', questions: { q: { ...NOUL, labels: null } } })).status, 200)
  const unhashable = await post(fake.url, { model: 'english', questions: { q: { type: ['noul'], instructions: 'x' } } })
  assert.equal(unhashable.status, 500)
  assert.deepEqual(await unhashable.json(), { detail: 'inference failed' })
})

test('the fake answers an exception in the model with laya.serve\'s bare 500, and serves the next request', async (t) => {
  const answer = (name, question, state) => { if (name === 'boom') throw new Error('model blew up'); return defaultAnswer(name, question, state) }
  const fake = await startFakeLaya({ answer })
  t.after(() => fake.close())
  const res = await post(fake.url, { model: 'english', questions: { boom: NOUL } }, 'k', AbortSignal.timeout(3000)).catch((err) => err)
  assert.equal(res.status, 500, `an answer, not ${res.name}`)
  assert.deepEqual(await res.json(), { detail: 'inference failed' })
  assert.equal(fake.requests[0].status, 500)
  assert.equal(fake.busy(), false)
  assert.equal((await post(fake.url, { model: 'english', questions: { fine: NOUL } })).status, 200, 'the lock was let go')
  // A throwing onInference hook is the same model error.
  const hooked = await startFakeLaya({ onInference: () => { throw new Error('out of memory') } })
  t.after(() => hooked.close())
  const again = await post(hooked.url, { model: 'english', questions: { x: NOUL } }, 'k', AbortSignal.timeout(3000)).catch((err) => err)
  assert.equal(again.status, 500, `an answer, not ${again.name}`)
})

test('each of the fake\'s requests is the parsed body itself, with the key, the times and the status beside it', async (t) => {
  const fake = await startFakeLaya({ apiKey: 'k' })
  t.after(() => fake.close())
  const body = { model: 'english', state: { task: 'rename foo' }, questions: { x: NOUL } }
  assert.equal((await post(fake.url, body, 'k')).status, 200)
  const [r] = fake.requests
  // As 9.2 has it, `requests[0].questions`, and whole as `body`.
  assert.equal(r.model, 'english')
  assert.deepEqual(r.state, body.state)
  assert.deepEqual(r.questions, body.questions)
  assert.deepEqual(r.body, body)
  assert.equal(r.authorization, 'Bearer k')
  assert.equal(r.status, 200)
  assert.ok(r.arrivedAt <= r.startedAt && r.startedAt <= r.finishedAt)
})

test('the fake runs one request at a time, rows x msPerRow each, and keeps computing when the client goes away', async (t) => {
  const fake = await startFakeLaya({ msPerRow: 80 })
  t.after(() => fake.close())
  const three = { model: 'english', questions: { a: NOUL, b: NOUL, c: NOUL } }
  const abort = new AbortController()
  const first = post(fake.url, { ...three, state: 'first' }, 'k')
  await waitFor('the first request to start', () => fake.busy(), Boolean)
  const second = post(fake.url, { ...three, state: 'second' }, 'k')
  const third = fetch(`${fake.url}/v1/systemone`, { method: 'POST', body: JSON.stringify({ ...three, state: 'abandoned' }), signal: abort.signal }).catch((e) => e)
  await waitFor('all three to arrive', () => fake.requests.length, (n) => n === 3)
  abort.abort()
  assert.equal((await first).status, 200)
  assert.equal((await second).status, 200)
  await waitFor('the abandoned one to finish anyway', () => fake.requests[2].finishedAt, Boolean, { timeoutMs: 5000 })
  const [a, b, c] = fake.requests
  assert.ok(b.startedAt >= a.finishedAt && c.startedAt >= b.finishedAt, 'one at a time, in order')
  for (const r of [a, b, c]) assert.ok(r.finishedAt - r.startedAt >= 3 * 80 - 5, `rows x msPerRow: ${r.finishedAt - r.startedAt}`)
  assert.equal(c.status, 200, 'the abandoned request was computed in full')
  assert.equal(fake.busy(), false)
  fake.setMsPerRow(0)
  assert.equal((await post(fake.url, { ...three, state: 'fast' })).status, 200)
  const fast = fake.requests[3]
  assert.ok(fast.finishedAt - fast.startedAt < 3 * 80, `setMsPerRow(0) applies to the next request: ${fast.finishedAt - fast.startedAt} ms`)
})

test('the fake fails on request: a 500, a 401, a 422, and a hang that close() ends', async (t) => {
  const fake = await startFakeLaya({ apiKey: 'k' })
  t.after(() => fake.close())
  const body = { model: 'english', state: {}, questions: { first: NOUL, second: NOUL } }
  fake.failNext(500)
  let res = await post(fake.url, body, 'k')
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { detail: 'inference failed' })
  assert.equal((await post(fake.url, body, 'k')).status, 200, 'only the next one')
  fake.failNext(401)
  assert.equal((await post(fake.url, body, 'k')).status, 401, 'even with the right key')
  fake.failNext(422)
  res = await post(fake.url, body, 'k')
  assert.equal(res.status, 422)
  assert.match((await res.json()).detail, /^question 'first': /)
  // An unloaded checkpoint cannot be loaded offline: laya.serve answers a bare 500.
  assert.equal((await post(fake.url, { ...body, model: 'multilingual' }, 'k')).status, 500)
  fake.hang()
  const hung = post(fake.url, body, 'k').then((r) => r.status, () => 'closed')
  await waitFor('the hung request to start', () => fake.busy(), Boolean)
  assert.equal((await fetch(`${fake.url}/health`)).status, 200, '/health answers while inference hangs')
  await fake.close()
  assert.equal(await hung, 'closed')
})

test('the fake answers in Laya\'s shape, rounded as Laya rounds, with input tokens by the stated formula', async (t) => {
  const answer = (name) => ({ pick: [0.12345678, 0.87654322], level: [0.1, 0.2, 0.3, 0.2, 0.2], yes: [0.25, 0.75] })[name]
  const fake = await startFakeLaya({ answer })
  t.after(() => fake.close())
  const questions = {
    pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'the first', b: 'the second' } },
    level: { type: 'score', instructions: 'How much?', criteria: ['none', 'little', 'some', 'much', 'all'] },
    yes: { ...NOUL, labels: { true: 'A', false: 'B' }, criteria: { true: 'yes: it is', false: 'no: it is not' } },
  }
  const state = { task: 'x'.repeat(300) }
  const body = await (await post(fake.url, { model: 'english', state, questions })).json()
  assert.equal(body.model, 'laya-rl-agent')
  assert.deepEqual(body.routing, { model: 'english', reason: "explicit model='english'" })
  // Per question, min(512, ceil(head chars / 3.6) + ceil(state chars / 3.0)): the state is 311
  // characters of JSON (104), and the heads 'Which?' with 'a: the first' and 'b: the second' (31, so
  // 9), 'How much?' with its five 'level <i>: <text>' lines (75, so 21), and 'Is it?' with
  // 'B: no: it is not' and 'A: yes: it is' (35, so 10). laya-questions.test.js holds the adapter's
  // estimate to the same count.
  assert.deepEqual(body.usage, { input_tokens: (9 + 104) + (21 + 104) + (10 + 104), output_tokens: 0 })
  const { pick, level, yes } = body.answers
  assert.deepEqual(Object.keys(pick), ['type', 'choice', 'probabilities', 'confidence', 'answer_confidence', 'action'])
  assert.deepEqual([pick.type, pick.choice, pick.probabilities], ['choice', 'b', { a: 0.1235, b: 0.8765 }])
  assert.equal(pick.answer_confidence, 0.8765)
  const h = -(0.12345678 * Math.log(0.12345678) + 0.87654322 * Math.log(0.87654322)) / Math.log(2)
  assert.equal(pick.confidence, Math.round((1 - h) * 1e4) / 1e4, 'normalised entropy, as Laya serves it')
  assert.deepEqual(Object.keys(level), ['type', 'score', 'legend', 'probabilities', 'confidence', 'answer_confidence', 'action'])
  assert.equal(level.score, 2.2, 'the expected level')
  assert.deepEqual(level.legend, { 0: 'none', 1: 'little', 2: 'some', 3: 'much', 4: 'all' })
  assert.deepEqual(level.probabilities, { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.2, 4: 0.2 })
  assert.deepEqual(Object.keys(yes), ['type', 'noul', 'confidence', 'answer_confidence', 'action'])
  assert.deepEqual([yes.noul, yes.confidence, yes.answer_confidence], [0.75, 0.75, 0.75])
  assert.equal(typeof yes.action.act_probability, 'number')
  // A request with no checkpoint named is routed by the server itself; the default answers are
  // deterministic per question and state.
  const again = await startFakeLaya()
  t.after(() => again.close())
  const one = await (await post(again.url, { state, questions })).json()
  const two = await (await post(again.url, { state, questions })).json()
  assert.deepEqual(one.answers, two.answers)
  assert.equal(one.routing.reason, 'English Latin text')
})

/** Retry an async read until it resolves, with a deadline: a spawned server takes a moment to bind. */
async function eventually(label, read, { timeoutMs = 10000, everyMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return await read() } catch (err) { if (Date.now() >= deadline) throw new Error(`${label}: still failing after ${timeoutMs}ms: ${err.message}`) }
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

/** Spawn the fake as the interpreter, the way the sidecar spawns laya.serve. */
function spawnFake(env, file = FAKE) {
  const child = spawn(process.execPath, [file, '-I', '-u', '-X', 'utf8', '-m', 'laya.serve'], { env: { ...process.env, LAYA_HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '', code: undefined }
  child.stdout.on('data', (d) => { out.stdout += d })
  child.stderr.on('data', (d) => { out.stderr += d })
  child.on('exit', (code) => { out.code = code })
  return { child, out }
}

test('run as the interpreter, the fake reads laya.serve\'s environment and prints Laya\'s own warning lines', async (t) => {
  const port = await freePort()
  const { child, out } = spawnFake({ LAYA_PORT: String(port), LAYA_API_KEY: 'k', LAYA_MODELS: 'english', LAYA_DEVICE: 'cuda', FAKE_LAYA_LOAD_MS: '200', FAKE_LAYA_MS_PER_ROW: '1', FAKE_LAYA_PRINT: 'no-cuda,temps,cpu-fallback,gpu-oom' })
  t.after(() => child.kill())
  const health = await eventually('the fake to listen', async () => (await fetch(`http://127.0.0.1:${port}/health`)).json())
  assert.deepEqual(health, { status: 'ok', loaded: ['english'], device: 'cuda' })
  assert.ok(out.stdout.startsWith('Warning: CUDA requested but not available. Falling back to CPU.\n'))
  assert.match(out.stdout, /\n\[laya\] Warning: could not place the model on cuda, so it is running on CPU\.\n {2}Reason: /)
  assert.match(out.stderr, /RuntimeWarning: laya: this checkpoint ships invalid temperatures or values outside \[0\.5, 5\]; using choice:11\+=0\.1006 -> 0\.5\. Treat confidence from the affected entries as uncalibrated\./)
  assert.ok(!out.stdout.includes('GPU memory exceeded'), 'the GPU fallback line comes with an inference')
  assert.equal((await post(`http://127.0.0.1:${port}`, { questions: { x: NOUL } }, 'wrong')).status, 401)
  assert.equal((await post(`http://127.0.0.1:${port}`, { questions: { x: NOUL } }, 'k')).status, 200)
  await waitFor('the GPU fallback line', () => out.stdout, (s) => s.includes('Warning: GPU memory exceeded during inference. Falling back to CPU...\n'))
})

test('run as the interpreter through a symlink or a junction to its folder, the fake still serves', async (t) => {
  // Node names the main module by its real path, which a link does not share with argv[1].
  const dir = mkdtempSync(join(tmpdir(), 'kz-fake-laya-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const link = join(dir, 'fixtures')
  symlinkSync(dirname(FAKE), link, 'junction')
  const port = await freePort()
  const { child, out } = spawnFake({ LAYA_PORT: String(port), LAYA_MODELS: 'english', LAYA_DEVICE: 'cpu' }, join(link, basename(FAKE)))
  t.after(() => child.kill())
  const seen = await eventually('the fake to listen, or to exit', async () => (out.code !== undefined ? { exited: out.code } : (await fetch(`http://127.0.0.1:${port}/health`)).json()))
  assert.deepEqual(seen, { status: 'ok', loaded: ['english'], device: 'cpu' })
})

test('run as the interpreter, the fake exits when told to, and a taken port fails the way uvicorn does', async (t) => {
  const crash = spawnFake({ LAYA_PORT: String(await freePort()), FAKE_LAYA_EXIT_AFTER_MS: '300' })
  t.after(() => crash.child.kill())
  await waitFor('the planned exit', () => crash.out.code, (c) => c !== undefined, { timeoutMs: 10000 })
  assert.equal(crash.out.code, 1)

  const holder = await startFakeLaya()
  t.after(() => holder.close())
  const taken = spawnFake({ LAYA_PORT: String(holder.port) })
  t.after(() => taken.child.kill())
  await waitFor('the bind failure', () => taken.out.code, (c) => c !== undefined, { timeoutMs: 10000 })
  assert.equal(taken.out.code, 1)
  assert.equal(taken.out.stderr, `ERROR:    [Errno 98] error while attempting to bind on address ('127.0.0.1', ${holder.port}): address already in use\n`)
})

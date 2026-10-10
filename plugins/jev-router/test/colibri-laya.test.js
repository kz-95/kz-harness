// colibri's C Laya beside laya.serve (docs/laya-auto.md 13), against the fake colibri
// (test/fixtures/fake-colibri-laya.mjs), which answers /v1/systemone in colibri's own shapes: the
// address it may be sent to, readiness by one test question, the comparison recorded side by side
// with colibri's three gaps marked, one request at a time and dropped under load or while laya.serve
// on the CPU has more to answer, a slow answer, a refusal, an answer in a shape KzH cannot read and
// a dead server, colibri's words kept to one line, an address emptied under a request, the figures,
// closing, and that the Laya client never waits for it.
import { COLIBRI, COLIBRI_CAP, SCORE_TOLERANCE, colibriAddressProblem, createColibriLaya } from '../colibri-laya.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLayaClient } from '../laya-client.js'
import { createJev } from '../jev.js'
import { renderForLaya } from '../laya-questions.js'
import { startFakeColibri } from './fixtures/fake-colibri-laya.mjs'
import { startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const LAYA_KEY = 'b'.repeat(48)

/** A data folder of the test's own, removed when it ends. */
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'colibri-laya-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fake colibri and the comparison pointed at it, both closed when the test ends. */
async function rig(t, { fake: fakeOpts = {}, address, ...opts } = {}) {
  const fake = await startFakeColibri(fakeOpts)
  const dir = folder(t)
  const file = join(dir, 'colibri-laya.jsonl')
  const logs = []
  const colibri = createColibriLaya({ file, address: () => address?.() ?? fake.url, log: (m) => logs.push(m), ...opts })
  t.after(async () => { await colibri.dispose(); await fake.close() })
  const rows = () => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
  return { fake, colibri, file, logs, rows }
}

/** A request as the Laya client sends laya.serve one, and laya.serve's answer to it. */
function answered({ runId = 'run-1', role = 'act', phase = 'route', ms = 40 } = {}) {
  const request = {
    key: 'view', model: 'english',
    state: { task: 'MARKER-STATE-TEXT: fix the parser' },
    questions: {
      kind: { type: 'choice', instructions: 'MARKER-QUESTION-TEXT: what is it?', criteria: { task: 'work to do', question: 'a question' } },
      alsoWork: { type: 'noul', labels: { true: 'A', false: 'B' }, instructions: 'Does it also ask for work?', criteria: { true: 'yes: it asks for work', false: 'no: it only asks' } },
      complexity: { type: 'score', instructions: 'How hard is it?', criteria: ['trivial', 'some', 'hard'] },
      'deploy.target': { type: 'choice', instructions: 'Where to?', criteria: { 'MARKER-TOOL-KEY-eu': 'the EU', 'MARKER-TOOL-KEY-us': 'the US' } },
    },
  }
  const response = {
    model: 'laya-rl-agent',
    usage: { input_tokens: 812, output_tokens: 0 },
    answers: {
      kind: { type: 'choice', choice: 'task', probabilities: { task: 0.9, question: 0.1 }, confidence: 0.531, answer_confidence: 0.9 },
      alsoWork: { type: 'noul', noul: 0.8, confidence: 0.8, answer_confidence: 0.8 },
      complexity: { type: 'score', score: 1.1, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 }, confidence: 0.06 },
      'deploy.target': { type: 'choice', choice: 'MARKER-TOOL-KEY-us', probabilities: { 'MARKER-TOOL-KEY-eu': 0.3, 'MARKER-TOOL-KEY-us': 0.7 }, confidence: 0.12 },
    },
  }
  return { request, response, ms, phase, role, runId, device: 'cpu' }
}

/** What colibri says to answered()'s questions: the same choice, a score 0.3 of a level away, a noul on the other side, and the other tool key. */
const COLIBRI_SAYS = (name) => ({
  kind: [0.8, 0.2], alsoWork: [0.6, 0.4], complexity: [0.1, 0.5, 0.4], 'deploy.target': [0.6, 0.4], ready: [0.2, 0.8],
})[name]

const settled = (colibri) => waitFor('the comparison has settled', () => colibri.busy(), (b) => b === false, { timeoutMs: 5000 })

// ---------------------------------------------------------------- the address

test('the address: empty is off; otherwise plain http on this PC with its port, and nothing else', () => {
  for (const ok of ['', 'http://127.0.0.1:8000', 'http://127.0.0.1:8000/', 'http://localhost:8000', 'HTTP://LOCALHOST:8000', 'http://[::1]:8000', 'http://127.0.0.2:9000', 'http://127.0.0.1:80']) {
    assert.equal(colibriAddressProblem(ok), null, ok)
  }
  for (const [bad, why] of [
    ['https://127.0.0.1:8000', /plain http/],
    ['http://10.0.0.5:8000', /this PC only .*not 10\.0\.0\.5$/],
    ['http://0.0.0.0:8000', /this PC only/],
    ['http://192.168.1.20:8000', /this PC only/],
    ['http://colibri.example:8000', /this PC only/],
    ['http://127.0.0.1', /with its port/],
    ['http://localhost/', /with its port/],
    ['http://127.0.0.1:8000/v1/systemone', /no path/],
    ['http://127.0.0.1:8000/?key=x', /no path/],
    ['http://me:secret@127.0.0.1:8000', /no user name or password/],
    ['http://127.0.0.1:0', /a port from 1 to 65535/],
    [' http://127.0.0.1:8000', /no spaces/],
    ['colibri', /is not an address/],
    [null, /text such as/],
  ]) assert.match(colibriAddressProblem(bad) ?? '', why, String(bad))
})

test('colibri\'s own provider record decides and teaches nothing', () => {
  assert.deepEqual({ ...COLIBRI }, { id: 'colibri', name: 'colibri Laya', teacher: false, local: true, decides: false })
  assert.ok(Object.isFrozen(COLIBRI))
})

// ---------------------------------------------------------------- readiness

test('readiness is one tiny test question, never /health, sent with no key: reachable with the model colibri names, and the record says how it was decided', async (t) => {
  const { fake, colibri, rows } = await rig(t)
  // The person's TypeSafe secret in the environment, where the TypeSafe SDK would pick it up.
  const before = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = 'tsk_never_sent_to_colibri'
  t.after(() => { if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before })
  assert.equal(await colibri.check(), true)
  const r = colibri.summary().reachable
  assert.deepEqual([r.ok, r.why, r.model, r.checking], [true, null, 'laya', false])
  assert.match(r.how, /one test question, since colibri's \/health lists no loaded model/)
  assert.equal(fake.requests.length, 1)
  const [asked] = fake.requests
  assert.deepEqual([asked.method, asked.path], ['POST', '/v1/systemone'], 'the test question, and no /health')
  assert.deepEqual(Object.values(asked.body.questions).map((q) => q.type), ['noul'], 'one question, a yes/no')
  assert.ok(JSON.stringify(asked.body).length < 200, 'and tiny')
  assert.equal(asked.headers.authorization, undefined, 'no key of any kind')
  assert.equal(asked.headers['x-api-key'], undefined)
  assert.ok(!JSON.stringify(asked).includes('tsk_never_sent_to_colibri'), 'the TypeSafe key is nowhere in it')
  await colibri.dispose()
  const [row] = rows()
  assert.deepEqual([row.kind, row.provider, row.used, row.ok, row.model], ['readiness', 'colibri', false, true, 'laya'])
  assert.match(row.how, /one test question/)
})

test('readiness says why not: nothing answering, a key asked for, an answer of another shape, or a server that is not colibri', async (t) => {
  // Nothing answers: a fake that was closed again.
  const gone = await startFakeColibri()
  await gone.close()
  const dead = await rig(t, { address: () => gone.url })
  assert.equal(await dead.colibri.check(), false)
  assert.match(dead.colibri.summary().reachable.why, /^nothing answers at http:\/\/127\.0\.0\.1:\d+: start colibri with its Laya engine, or empty the address$/)

  // Started with COLI_API_KEY: KzH has no key of colibri's, and sends none.
  const keyed = await rig(t, { fake: { apiKey: 'colibri-own-key' } })
  assert.equal(await keyed.colibri.check(), false)
  assert.match(keyed.colibri.summary().reachable.why, /asks for an API key \(HTTP 401\), and KzH sends it none: start colibri without COLI_API_KEY/)
  assert.equal(keyed.fake.requests[0].headers.authorization, undefined)

  // A server that names itself colibri but answers the test question in no System One shape.
  const shapeless = await rig(t)
  shapeless.fake.reshapeNext((reply) => ({ ...reply, answers: { ready: { type: 'choice', choice: 'yes' } } }))
  assert.equal(await shapeless.colibri.check(), false)
  assert.match(shapeless.colibri.summary().reachable.why, /^the server at http:\/\/127\.0\.0\.1:\d+ answered the test question with something that is not a System One answer$/)

  // System One servers that are not colibri: one naming another provider, and laya.serve itself.
  const notColibri = await rig(t, { fake: { provider: 'someone-else' } })
  assert.equal(await notColibri.colibri.check(), false)
  assert.match(notColibri.colibri.summary().reachable.why, /is not colibri: its answer names no colibri provider/)
  const laya = await startFakeLaya({ apiKey: null })
  t.after(() => laya.close())
  const odd = await rig(t, { address: () => laya.url })
  assert.equal(await odd.colibri.check(), false)
  assert.match(odd.colibri.summary().reachable.why, /is not colibri/, 'laya.serve answers the test question in System One\'s shape, but it is not colibri')
})

// ---------------------------------------------------------------- the comparison

test('a request laya.serve answered is asked of colibri as it was sent, and both answers are recorded side by side under colibri\'s record, with its gaps marked and no text of the task, the question or a tool\'s options', async (t) => {
  const { fake, colibri, rows, logs, file } = await rig(t, { fake: { answer: COLIBRI_SAYS } })
  const a = answered()
  assert.deepEqual(colibri.offer(a), { queued: true })
  await settled(colibri)
  await colibri.dispose()
  // The test question first, since readiness was not known, then the request itself.
  assert.equal(fake.requests.length, 2)
  const sent = fake.requests[1].body
  assert.deepEqual(sent, { model: 'english', state: a.request.state, questions: a.request.questions }, 'exactly as laya.serve was sent it')
  assert.deepEqual(sent.questions.alsoWork.labels, { true: 'A', false: 'B' }, 'the noul with KzH\'s labels, which colibri ignores')

  const row = rows().find((r) => r.kind === 'compare')
  assert.deepEqual([row.provider, row.used, row.status, row.role, row.runId, row.phase], ['colibri', false, 'answered', 'act', 'run-1', 'route'])
  assert.deepEqual(row.laya, { ms: 40, device: 'cpu', model: 'laya-rl-agent', tokens: 812 })
  assert.equal(row.colibri.model, 'laya')
  assert.equal(typeof row.colibri.ms, 'number')
  const q = row.questions
  assert.deepEqual(q.kind, { type: 'choice', laya: { answer: 'task', p: [0.9, 0.1], confidence: 0.531 }, colibri: { answer: 'task', p: [0.8, 0.2], confidence: 0.6 }, agree: true, gap: 0.1 })
  assert.deepEqual(q.alsoWork, {
    type: 'noul', laya: { answer: 0.8, p: 0.8, confidence: 0.8 }, colibri: { answer: 0.4, p: 0.4, confidence: null },
    colibriSaw: 'raw', confidenceUnknown: true, agree: false, gap: 0.4,
  }, 'a noul read raw, its confidence unknown')
  assert.deepEqual(q.complexity, { type: 'score', laya: { answer: 1.1, p: [0.2, 0.5, 0.3], confidence: 0.06 }, colibri: { answer: 1.3, p: [0.1, 0.5, 0.4], confidence: 0.25 }, agree: true, gap: 0.2 })
  assert.equal(SCORE_TOLERANCE, 0.5)
  assert.deepEqual([q['deploy.target'].laya.answer, q['deploy.target'].colibri.answer, q['deploy.target'].agree], ['#1', '#0', false], 'a tool parameter by its option\'s index')
  const text = readFileSync(file, 'utf8')
  for (const marker of ['MARKER-STATE-TEXT', 'MARKER-QUESTION-TEXT', 'MARKER-TOOL-KEY']) assert.ok(!text.includes(marker), `${marker} is not in the record`)
  assert.ok(logs.some((l) => l === `colibri Laya route: 4 answered in ${row.colibri.ms} ms (laya.serve 40 ms), 2/4 agree with laya.serve`), logs.join('\n'))
})

test('Test Laya\'s fixed calls are not compared, nor is anything while the address is empty, and nothing is sent then', async (t) => {
  let address = ''
  const { fake, colibri } = await rig(t, { address: () => address })
  assert.deepEqual(colibri.offer(answered()), { skipped: 'off' })
  assert.equal(await colibri.check(), null)
  address = fake.url
  assert.deepEqual(colibri.offer(answered({ runId: null, role: 'act' })), { skipped: 'not_a_run' }, 'an acting call with no run is Test Laya\'s')
  assert.equal(fake.requests.length, 0)
  assert.deepEqual(colibri.offer(answered({ runId: null, role: 'shadow', phase: 'intent' })), { queued: true }, 'the shadow\'s intent has no run id and is compared')
  await settled(colibri)
  assert.equal(colibri.summary().compared.requests, 1)
})

test('one request at a time, never queued: dropped while one is on its way or a local model is answering, and counted', async (t) => {
  let localBusy = false
  const { fake, colibri } = await rig(t, { fake: { msPerRequest: 150 }, isLocalBusy: () => localBusy })
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  assert.deepEqual(colibri.offer(answered()), { dropped: 'busy' })
  assert.equal(colibri.busy(), true)
  await settled(colibri)
  localBusy = 'Qwen3 8B'
  assert.deepEqual(colibri.offer(answered()), { dropped: 'local_busy' })
  localBusy = false
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  const s = colibri.summary()
  assert.deepEqual(s.dropped, { busy: 1, local_busy: 1, laya_busy: 0, not_reachable: 0 })
  assert.equal(s.compared.requests, 2)
  assert.equal(fake.requests.length, 3, 'the test question and two comparisons, never two at once')
  for (let i = 1; i < fake.requests.length; i++) assert.ok(fake.requests[i].arrivedAt >= fake.requests[i - 1].finishedAt)
})

test('with laya.serve on the CPU, a request is compared only once laya.serve has nothing more to answer at once, so colibri never takes the cores of its next request; on the GPU each one is', async (t) => {
  const { fake, colibri } = await rig(t)
  assert.equal(await colibri.check(), true)
  assert.deepEqual(colibri.offer({ ...answered(), more: true }), { dropped: 'laya_busy' }, 'another request of the call, or another call, is next on the CPU')
  assert.equal(colibri.busy(), false)
  assert.deepEqual(colibri.offer({ ...answered(), more: false }), { queued: true }, 'the last one laya.serve had to answer')
  await settled(colibri)
  assert.deepEqual(colibri.offer({ ...answered(), device: 'cuda', more: true }), { queued: true }, 'on the GPU laya.serve does not answer on the cores colibri takes')
  await settled(colibri)
  const s = colibri.summary()
  assert.deepEqual([s.dropped, s.compared.requests], [{ busy: 0, local_busy: 0, laya_busy: 1, not_reachable: 0 }, 2])
  assert.equal(fake.requests.length, 3, 'the test question and the two compared')
})

test('a slow answer past its short deadline, a refusal in colibri\'s words, and a server that dies: each recorded as not compared, with colibri left alone a while after it died', async (t) => {
  let clock = Date.now()
  const { fake, colibri, rows } = await rig(t, { now: () => clock, timing: { minMs: 150, maxMs: 300, recheckMs: 60_000 } })
  assert.equal(await colibri.check(), true)
  // Slow: 2 s against a deadline of twice laya.serve's 40 ms, at least 150 ms.
  fake.setMsPerRequest(2000)
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  fake.setMsPerRequest(0)
  // A refusal: colibri's 422, in its own envelope.
  fake.refuseNext(422, '`questions.kind.criteria` must be a non-empty object of label: description.')
  colibri.offer(answered())
  await settled(colibri)
  assert.equal(colibri.summary().reachable.ok, true, 'a refusal is about one request: colibri is still reachable')
  // Dead: it goes away between two requests.
  await fake.close()
  colibri.offer(answered())
  await settled(colibri)
  await waitFor('the three are on disk', () => rows().filter((r) => r.kind === 'compare').length, (n) => n === 3)
  const failed = rows().filter((r) => r.kind === 'compare').map((r) => [r.status, r.reason, r.colibri.status])
  assert.deepEqual(failed, [['failed', 'timeout', null], ['failed', 'refused', 422], ['failed', 'unreachable', null]])
  const [slow, refused, dead] = rows().filter((r) => r.kind === 'compare')
  assert.equal(slow.colibri.deadlineMs, 150)
  assert.equal(slow.why, 'colibri did not answer this request within 1 s')
  assert.equal(refused.why, 'colibri refused it (HTTP 422: `questions.kind.criteria` must be a non-empty object of label: description.)')
  assert.match(dead.why, /^nothing answers at http:\/\/127\.0\.0\.1:\d+/)
  assert.ok(!slow.questions && !refused.questions && !dead.questions, 'no answer is recorded for colibri when it gave none')
  const s = colibri.summary()
  assert.deepEqual([s.reachable.ok, s.failed], [false, { timeout: 1, unreachable: 1, refused: 1, bad_answer: 0 }])
  // Found gone, it is not asked again until a minute has passed, and then the test question goes first.
  assert.deepEqual(colibri.offer(answered()), { dropped: 'not_reachable' })
  clock += 60_000
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  assert.equal(colibri.summary().dropped.not_reachable, 2, 'the test question was not answered either')
  assert.equal(rows().filter((r) => r.kind === 'compare').length, 3, 'and nothing was compared')
})

test('an answer in a shape KzH cannot read: with no answers at all the request is not compared, and a question left out or answered in another shape makes the row partial, the rest compared as ever', async (t) => {
  const { fake, colibri, rows, logs } = await rig(t)
  assert.equal(await colibri.check(), true)
  fake.reshapeNext(({ answers, ...reply }) => reply)
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  // The score answered with no score, and the tool parameter left out.
  fake.reshapeNext((reply) => ({ ...reply, answers: { kind: reply.answers.kind, alsoWork: reply.answers.alsoWork, complexity: { type: 'score' } } }))
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  await waitFor('both are on disk', () => rows().filter((r) => r.kind === 'compare').length, (n) => n === 2)
  const [none, partial] = rows().filter((r) => r.kind === 'compare')
  assert.deepEqual([none.status, none.reason, none.why, none.colibri.status, none.questions], ['failed', 'bad_answer', 'colibri answered with something that is not a System One answer', 200, undefined])
  assert.deepEqual([partial.status, partial.reason, partial.why], ['partial', 'bad_answer', 'colibri gave no usable answer to 2 of 4 questions'])
  assert.deepEqual(partial.questions.complexity, { type: 'score', laya: { answer: 1.1, p: [0.2, 0.5, 0.3], confidence: 0.06 }, colibri: null, agree: null, gap: null })
  assert.deepEqual([partial.questions['deploy.target'].colibri, partial.questions['deploy.target'].agree], [null, null])
  assert.deepEqual([partial.questions.kind.agree, partial.questions.alsoWork.agree], [true, false], 'the two it answered, compared')
  const s = colibri.summary()
  assert.deepEqual([s.failed, s.compared.requests, s.compared.partial, s.compared.questions], [{ timeout: 0, unreachable: 0, refused: 0, bad_answer: 1 }, 1, 1, 2])
  assert.equal(s.reachable.ok, true, 'an answer it could not read is about one request: colibri is still reachable')
  assert.ok(logs.includes('colibri Laya route: not compared (colibri answered with something that is not a System One answer)'), logs.join('\n'))
})

test('what the server at the address says is kept to one plain line: a refusal or a model name carrying line breaks and terminal codes adds no line of its own to the server log', async (t) => {
  const { fake, colibri, rows, logs } = await rig(t, { fake: { model: 'laya\r\n[jev] laya: a forged line' } })
  assert.equal(await colibri.check(), true)
  assert.equal(colibri.summary().reachable.model, 'laya [jev] laya: a forged line')
  fake.refuseNext(422, 'bad\n[jev] laya: a forged line \u001b[31mred\u2028and on')
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await settled(colibri)
  await waitFor('the row is on disk', () => rows().filter((r) => r.kind === 'compare').length, (n) => n === 1)
  const [row] = rows().filter((r) => r.kind === 'compare')
  assert.equal(row.why, 'colibri refused it (HTTP 422: bad [jev] laya: a forged line [31mred and on)')
  assert.ok(logs.includes(`colibri Laya route: not compared (${row.why})`), logs.join('\n'))
  assert.ok(logs.every((l) => !/[\n\r\u001b\u2028]/.test(l)), 'no line break or terminal code in any line logged')
})

test('emptying the address stops it: what comes back afterwards for a request on its way, a test question or a comparison, is not written and moves no figure', async (t) => {
  let address = null
  const { fake, colibri, rows, logs } = await rig(t, { fake: { msPerRequest: 300 }, address: () => address ?? fake.url })
  assert.equal(await colibri.check(), true)
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await waitFor('colibri has the comparison', () => fake.requests.length, (n) => n === 2)
  address = ''
  await settled(colibri)
  // An address set again and emptied while its test question is on its way.
  address = null
  const asked = colibri.check()
  await waitFor('colibri has the test question', () => fake.requests.length, (n) => n === 3)
  address = ''
  assert.equal(await asked, null, 'nothing found for an address no longer set')
  await colibri.dispose()
  assert.equal(fake.answered(), 3, 'colibri answered all three')
  assert.deepEqual(rows().map((r) => r.kind), ['readiness'], 'only the readiness found while the address was set')
  const s = colibri.summary()
  assert.deepEqual([s.compared.requests, s.failed, s.dropped], [0, { timeout: 0, unreachable: 0, refused: 0, bad_answer: 0 }, { busy: 0, local_busy: 0, laya_busy: 0, not_reachable: 0 }])
  assert.ok(!logs.some((l) => l.startsWith('colibri Laya')), logs.join('\n'))
})

// ---------------------------------------------------------------- the figures

test('the figures: agreement by question type, a score within the tolerance, the median time of each, and colibri\'s confidence-less nouls left out of every figure that needs a confidence; read back from the file after a restart', async (t) => {
  let says = COLIBRI_SAYS
  const { fake, colibri, file } = await rig(t, { fake: { answer: (n, q, s) => says(n, q, s) } })
  for (const ms of [40, 60, 80]) {
    colibri.offer(answered({ ms }))
    await settled(colibri)
  }
  // A fourth, where colibri agrees on the noul and is a level and more off on the score.
  says = (name) => ({ kind: [0.2, 0.8], alsoWork: [0.1, 0.9], complexity: [0, 0, 1], 'deploy.target': [0.3, 0.7] })[name]
  colibri.offer(answered({ ms: 100 }))
  await settled(colibri)
  const s = colibri.summary()
  assert.deepEqual(s.compared, { requests: 4, partial: 0, questions: 16, since: s.compared.since })
  assert.deepEqual(s.agreement, {
    choice: { compared: 8, agreed: 4 }, // kind thrice then not, the tool key never then once
    score: { compared: 4, agreed: 3, tolerance: 0.5 },
    noul: { compared: 4, agreed: 1 },
  })
  assert.deepEqual(s.medianMs.laya, 70)
  assert.equal(typeof s.medianMs.colibri, 'number')
  assert.deepEqual([s.rawNouls, s.confidenceUnknown], [4, 4])
  assert.deepEqual(s.confidence.noul, { laya: 0.8, colibri: null }, 'colibri\'s nouls have no confidence, and none is made up for them')
  assert.equal(s.confidence.choice.laya, (0.12 + 0.531) / 2, 'the median of the four tool picks\' 0.12 and the four kinds\' 0.531')
  // colibri's own figure, (n * peak - 1) / (n - 1), not laya.serve's normalised entropy: the kind
  // at 0.8 reads 0.6 from colibri, where laya.serve's 0.9 reads 0.531.
  assert.equal(s.confidence.choice.colibri, 0.5, 'the median of the four kinds\' 0.6 and the tool picks\' 0.2, 0.2, 0.2 and 0.4')
  assert.deepEqual([s.used, s.provider.id, s.provider.decides, s.file], [false, 'colibri', false, 'colibri-laya.jsonl'])
  assert.equal(fake.requests.length, 5)

  // Another start reads the same figures back from the file.
  await colibri.dispose()
  const again = createColibriLaya({ file, address: () => fake.url })
  t.after(() => again.dispose())
  await waitFor('the rows are read back', () => again.summary().compared.requests, (n) => n === 4)
  const back = again.summary()
  assert.deepEqual([back.agreement, back.medianMs, back.confidence, back.rawNouls, back.confidenceUnknown], [s.agreement, s.medianMs, s.confidence, s.rawNouls, s.confidenceUnknown])
  assert.equal(back.reachable.ok, null, 'readiness is asked again, never taken from an earlier day')
})

test('the file keeps its newest rows, cut back once it runs past them', async (t) => {
  const { colibri, rows } = await rig(t, { cap: 3 })
  for (let i = 0; i < 8; i++) {
    colibri.offer(answered({ ms: 10 + i }))
    await settled(colibri)
  }
  await colibri.dispose()
  const kept = rows()
  assert.ok(kept.length <= 6 && kept.length >= 3, `${kept.length} rows on disk`)
  assert.deepEqual(kept.slice(-3).map((r) => r.laya.ms), [15, 16, 17], 'the newest are the ones kept')
  assert.equal(colibri.summary().compared.requests, 3, 'and the figures keep as many')
  assert.equal(COLIBRI_CAP, 2000)
})

// ---------------------------------------------------------------- never in the way

test('closing abandons the request on its way with its socket, writes nothing of it, and resolves once what came before is on disk', async (t) => {
  const { fake, colibri, rows } = await rig(t)
  assert.equal(await colibri.check(), true)
  fake.hangNext()
  assert.deepEqual(colibri.offer(answered()), { queued: true })
  await waitFor('colibri has the request', () => fake.requests.length, (n) => n === 2)
  const t0 = Date.now()
  await colibri.dispose()
  assert.ok(Date.now() - t0 < 1000, 'at once, not at the deadline')
  await waitFor('the socket went with it', () => fake.requests[1].closedEarly, Boolean)
  assert.deepEqual(rows().map((r) => r.kind), ['readiness'], 'nothing of the abandoned request was written')
  assert.equal(colibri.busy(), false)
  assert.deepEqual(colibri.offer(answered()), { skipped: 'off' }, 'and nothing new starts')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(fake.requests.length, 2)
})

/** The body one jev.js builder call sends, captured before anything goes out. */
function built(run) {
  let body = null
  const capture = { systemOne: (b) => { body ??= b; return new Promise(() => {}) } }
  run(createJev({ apiKey: 'capture', client: capture }))?.catch?.(() => {})
  return { state: body.state, questions: body.questions }
}

/** The sidecar as the Laya client sees it, ready on the fake laya.serve. */
const readySidecar = (laya) => ({
  isReady: () => true,
  connection: () => ({ url: laya.url, key: LAYA_KEY, device: 'cpu', pid: 1 }),
  ensureReady: async () => ({ url: laya.url, key: LAYA_KEY, device: 'cpu', pid: 1 }),
  noteResult: async () => ({}),
  setPriority: () => {},
  status: () => ({ state: 'ready', installed: { laya: '0.3.20', weights: { commit: '0'.repeat(40) } } }),
  installed: () => ({ laya: '0.3.20' }),
  readSettings: () => ({ measured: { cpu: { msPerToken: {} }, cuda: { msPerToken: {} } } }),
})

test('a run never waits on it: with colibri at 3 s a request, a Laya Auto call through the Laya client is answered at laya.serve\'s pace, while colibri is still at its comparison', async (t) => {
  const laya = await startFakeLaya({ apiKey: LAYA_KEY })
  t.after(() => laya.close())
  const { fake, colibri, rows } = await rig(t, { fake: { msPerRequest: 0 } })
  assert.equal(await colibri.check(), true)
  fake.setMsPerRequest(3000)
  const client = createLayaClient({
    sidecar: readySidecar(laya),
    settings: { deadlines: { floorMs: 20_000, ceilingMs: 60_000, hardMs: 60_000 } },
    onAnswered: (a) => colibri.offer(a),
  })
  t.after(() => client.dispose())
  const call = built((j) => j.intent({ message: 'Fix the failing test in src/parser.ts' }))
  const t0 = Date.now()
  const answer = await client.client('act', { runId: 'intent' }).systemOne(call, { phase: 'intent' })
  const took = Date.now() - t0
  assert.ok(answer.answers.kind, 'Laya\'s answer')
  assert.ok(took < 2000, `answered in ${took} ms, without waiting for colibri's 3 s`)
  assert.equal(colibri.busy(), true, 'colibri is still at its comparison')
  await waitFor('colibri has been asked', () => fake.requests.length, (n) => n === 2)
  assert.ok(fake.requests[1].arrivedAt >= laya.requests[0].finishedAt, 'after laya.serve answered')
  assert.equal(fake.answered(), 1, 'and has answered only the test question')
  assert.deepEqual(fake.requests[1].body.questions, renderForLaya({ phase: 'intent', ...call }, { role: 'act' })[0].questions, 'what it was asked is what laya.serve was asked')
  await waitFor('the comparison is on disk', () => rows().filter((r) => r.kind === 'compare' && r.status === 'answered').length, (n) => n === 1, { timeoutMs: 5000 })
})

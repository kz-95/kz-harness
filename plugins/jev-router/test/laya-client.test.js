// The Laya client's gate (docs/laya-auto.md 4.5), against the fake laya.serve (9.2), with the
// sidecar as a stub object: one request on the wire, acting calls first, measured deadlines that
// never reach the socket, no retries but the 401, the hard ceiling, priority, and what an answer says.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLayaClient, langOf } from '../laya-client.js'
import { createJev } from '../jev.js'
import { estimateRequestTokens, renderForLaya } from '../laya-questions.js'
import { resolveProviders } from '../providers.js'
import { defaultAnswer, startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const KEY = 'a'.repeat(48)
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const IDENTITY = 'laya-0.3.20|english|0123456789ab|adapter-1|corr:choice:11+=3.27|margin:0.1'
const { laya: LAYA } = resolveProviders({}, {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The body one jev.js builder call sends, captured before anything goes out. */
function built(run) {
  let body = null
  const capture = { systemOne: (b) => { body ??= b; return new Promise(() => {}) } }
  run(createJev({ apiKey: 'capture', client: capture }))?.catch?.(() => {})
  return { state: body.state, questions: body.questions }
}
const INTENT = built((j) => j.intent({ message: 'Fix the failing test in src/parser.ts' }))
const ROUTE = built((j) => j.route({ task: 'Rename the variable foo to bar in utils.js', context: { gitRepo: true, branch: 'main', fileTypes: { '.js': 3 } } }))
const intentOf = (message) => built((j) => j.intent({ message }))
/** What the client will predict for a call: the rendered requests' tokens times ms per token. */
const tokensOf = (call, phase) => renderForLaya({ phase, ...call }, { role: 'act' }).reduce((n, r) => n + estimateRequestTokens(r), 0)

/** The sidecar as the client sees it, recording what the client asked of it. */
function stubSidecar(fake, { device = 'cpu', key = KEY, state = 'ready', stoppedBecause = null, why = null, measured = {} } = {}) {
  const calls = { ensureReady: 0, noteResult: [], setPriority: [], restart: [] }
  const s = {
    calls, state, stoppedBecause, why,
    conn: fake ? { url: fake.url, key, device, pid: 4242 } : null,
    latest: null, // what connection() gives when it differs from what ensureReady handed out
    starting: null, // a promise ensureReady waits for, as a start or a restart
    isReady: () => s.state === 'ready' && !!s.conn,
    connection: () => (s.state === 'ready' ? s.latest ?? s.conn : null),
    async ensureReady({ onWait } = {}) {
      calls.ensureReady++
      if (s.starting) { onWait?.('Starting Laya on this PC: loading the model on the CPU (0 s)…'); await s.starting }
      return s.conn
    },
    async noteResult(r) { calls.noteResult.push({ ...r, at: Date.now() }); return {} },
    setPriority(level) { calls.setPriority.push({ level, at: Date.now() }) },
    async restart(o) { calls.restart.push(o) },
    status: () => ({ state: s.state, why: s.why, stoppedBecause: s.state === 'stopped' ? s.stoppedBecause : null, installed: { laya: '0.3.20', weights: { commit: COMMIT } } }),
    installed: () => ({ laya: '0.3.20' }),
    readSettings: () => ({
      measured: {
        cpu: { msPerToken: { intent: null, route: null, review: null, ...measured.cpu } },
        cuda: { msPerToken: { intent: null, route: null, review: null, ...measured.cuda } },
      },
    }),
  }
  return s
}

/** A fake, a stub sidecar and a client, closed after the test. */
async function rig(t, { fake: fakeOpts = {}, sidecar: sidecarOpts = {}, settings = {}, ...clientOpts } = {}) {
  const fake = await startFakeLaya({ apiKey: KEY, ...fakeOpts })
  const sidecar = stubSidecar(fake, sidecarOpts)
  const client = createLayaClient({ sidecar, settings: { deadlines: { floorMs: 20_000, ceilingMs: 60_000, hardMs: 60_000 }, ...settings }, ...clientOpts })
  t.after(async () => { client.dispose(); await fake.close() })
  return { fake, sidecar, client }
}

/** Offer one call to the shadow queue and resolve what its onDone gets. */
function shadowOf(client, call, { phase = 'route', callId = `c-${Math.random()}` } = {}) {
  let offered
  const done = new Promise((resolve) => { offered = client.offerShadow({ callId, runId: 'r', phase, ...call, onDone: resolve }) })
  return { offered, done, callId }
}
const isIntent = (req) => Object.hasOwn(req.questions ?? {}, 'kind')

// ---------------------------------------------------------------- the gate

test('one request is on the wire at a time, whoever asks', async (t) => {
  const { fake, client } = await rig(t, { fake: { msPerRow: 15 } })
  const act = client.client('act')
  const a = shadowOf(client, ROUTE)
  const b = shadowOf(client, INTENT, { phase: 'intent' })
  const answers = await Promise.all([act.systemOne(INTENT, { phase: 'intent' }), act.systemOne(ROUTE, { phase: 'route' }), a.done, b.done])
  assert.equal(answers[2].status, 'answered')
  assert.equal(answers[3].status, 'answered')
  const byArrival = [...fake.requests].sort((x, y) => x.arrivedAt - y.arrivedAt)
  assert.ok(byArrival.length > 6)
  for (let i = 1; i < byArrival.length; i++) {
    assert.ok(byArrival[i].arrivedAt >= byArrival[i - 1].finishedAt, `request ${i} arrived while request ${i - 1} was still on the wire`)
  }
  assert.equal(client.busy(), false)
})

test('an acting request goes before the shadow chunks queued behind the one on the wire', async (t) => {
  const { fake, client } = await rig(t, { fake: { msPerRow: 40 } })
  const shadow = shadowOf(client, ROUTE)
  await waitFor('the first chunk on the wire', () => fake.requests.length, (n) => n === 1)
  const answer = await client.client('act').systemOne(INTENT, { phase: 'intent' })
  assert.deepEqual(Object.keys(answer.answers), ['kind', 'depth', 'alsoWork'])
  assert.equal((await shadow.done).status, 'answered')
  const order = fake.requests.map((r) => (isIntent(r) ? 'act' : 'shadow'))
  assert.deepEqual(order.slice(0, 3), ['shadow', 'act', 'shadow'], 'the acting request waited for one chunk only')
  assert.ok(order.length > 3, 'the shadow call was split into chunks of four')
  for (const r of fake.requests.filter((x) => !isIntent(x))) assert.ok(Object.keys(r.questions).length <= 4)
})

test('each drop reason: not running, starting, gave way to a local model, queue full, too old, and a withdrawn job', async (t) => {
  const stopped = createLayaClient({ sidecar: stubSidecar(null, { state: 'stopped' }) })
  assert.deepEqual(stopped.offerShadow({ callId: 'x', phase: 'intent', ...INTENT }), { dropped: 'not_running' })
  const starting = createLayaClient({ sidecar: stubSidecar(null, { state: 'starting' }) })
  assert.deepEqual(starting.offerShadow({ callId: 'x', phase: 'intent', ...INTENT }), { dropped: 'starting' })
  const restarting = createLayaClient({ sidecar: stubSidecar(null, { state: 'restarting' }) })
  assert.deepEqual(restarting.offerShadow({ callId: 'x', phase: 'intent', ...INTENT }), { dropped: 'starting' })
  const yielded = createLayaClient({ sidecar: stubSidecar(null, { state: 'stopped', stoppedBecause: 'yielded' }) })
  assert.deepEqual(yielded.offerShadow({ callId: 'x', phase: 'intent', ...INTENT }), { dropped: 'yielded' })
  assert.equal(yielded.counters().skipped.yielded, 1)

  // Queue full: one job on the wire, two waiting, the next is dropped.
  const full = await rig(t, { fake: { msPerRow: 60 }, settings: { shadow: { maxQueue: 2 } } })
  const first = shadowOf(full.client, INTENT, { phase: 'intent' })
  await waitFor('the first job on the wire', () => full.fake.requests.length, (n) => n === 1)
  assert.deepEqual(shadowOf(full.client, INTENT, { phase: 'intent' }).offered, { queued: true })
  assert.deepEqual(shadowOf(full.client, INTENT, { phase: 'intent' }).offered, { queued: true })
  assert.deepEqual(shadowOf(full.client, INTENT, { phase: 'intent' }).offered, { dropped: 'queue_full' })
  assert.equal((await first.done).status, 'answered')

  // Too old: a job that waits past maxAgeMs behind a busy local model is dropped before it is sent.
  const old = await rig(t, { fake: { msPerRow: 5 }, settings: { shadow: { maxAgeMs: 150 } }, isLocalBusy: () => 'qwen3-8b', timing: { pollMs: 10 } })
  const aged = await shadowOf(old.client, INTENT, { phase: 'intent' }).done
  assert.equal(aged.status, 'skipped')
  assert.equal(aged.reason, 'too_old')
  assert.ok(aged.queuedMs >= 150)
  assert.equal(old.fake.requests.length, 0, 'never sent')
  // One whose remaining chunks aged out is partial, with the answers it has: here a local model
  // starts answering while Laya computes the first chunk.
  let localBusy = false
  const late = await rig(t, {
    fake: { msPerRow: 5, answer: (...a) => { localBusy = true; return defaultAnswer(...a) } },
    settings: { shadow: { maxAgeMs: 150 } }, isLocalBusy: () => localBusy, timing: { pollMs: 10 },
  })
  const partial = await shadowOf(late.client, ROUTE).done
  assert.equal(partial.status, 'partial')
  assert.equal(partial.reason, 'too_old')
  assert.equal(late.fake.requests.length, 1)
  assert.deepEqual(Object.keys(partial.answer.answers), Object.keys(late.fake.requests[0].questions))
  assert.ok(Object.keys(partial.answer.answers).length < Object.keys(ROUTE.questions).length)

  // Withdrawn: while queued it never reaches the server; once started its chunk on the wire
  // finishes and nothing more of it is sent.
  const w = await rig(t, { fake: { msPerRow: 30 } })
  const running = shadowOf(w.client, ROUTE, { callId: 'running' })
  const queued = shadowOf(w.client, INTENT, { phase: 'intent', callId: 'queued' })
  await waitFor('the route job on the wire', () => w.fake.requests.length, (n) => n === 1)
  assert.equal(w.client.withdraw('queued', 'jev_failed'), true)
  assert.deepEqual(await queued.done, { queuedMs: (await queued.done).queuedMs, ms: 0, status: 'skipped', reason: 'jev_failed' })
  assert.equal(w.client.withdraw('running', 'jev_failed'), true)
  const gone = await running.done
  assert.equal(gone.status, 'skipped')
  assert.equal(gone.reason, 'jev_failed')
  await sleep(50)
  assert.equal(w.fake.requests.length, 1, 'no chunk after the one on the wire, and the queued job never went')
  assert.equal(w.client.withdraw('running'), false, 'a finished job cannot be withdrawn')
  assert.equal(w.client.counters().skipped.jev_failed, 2)
})

test('the deadline rejects on time, while the slot stays held until the server answers', async (t) => {
  const { fake, sidecar, client } = await rig(t, {
    fake: { msPerRow: 700 },
    settings: { deadlines: { floorMs: 1000, ceilingMs: 1000, hardMs: 60_000 } },
    sidecar: { measured: { cpu: { intent: 0.001 } } },
  })
  const t0 = Date.now()
  await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => {
    assert.equal(err.name, 'Error')
    assert.equal(err.code, 'LAYA_TIMEOUT')
    assert.equal(err.message, 'timed out after 1 s')
    return true
  })
  const took = Date.now() - t0
  assert.ok(took >= 950 && took < 1800, `rejected after ${took} ms`)
  assert.equal(client.busy(), true, 'the request is still on the wire')
  assert.equal(fake.requests[0].finishedAt, null)
  // What comes next waits for the abandoned request's own answer.
  const next = shadowOf(client, INTENT, { phase: 'intent' })
  assert.equal((await next.done).status, 'answered')
  assert.equal(fake.requests.length, 2)
  assert.ok(fake.requests[1].arrivedAt >= fake.requests[0].finishedAt)
  const first = sidecar.calls.noteResult[0]
  assert.equal(first.status, 200, 'the socket was kept: the abandoned response arrived')
  assert.ok(first.ms >= 2000)
})

test('the caller\'s signal never reaches the socket, and a queued request whose caller left is never sent', async (t) => {
  const { fake, sidecar, client } = await rig(t, { fake: { msPerRow: 250 } })
  const act = client.client('act')
  const stop = new AbortController()
  const call = act.systemOne(INTENT, { phase: 'intent', signal: stop.signal })
  await waitFor('the request on the wire', () => fake.requests.length, (n) => n === 1)
  const t0 = Date.now()
  stop.abort(new Error('stopped by the person'))
  await assert.rejects(call, /stopped by the person/)
  assert.ok(Date.now() - t0 < 200, 'rejected at once')
  assert.equal(client.busy(), true)
  // Queued behind it: aborted, and a passed deadline, both before they are sent.
  const leave = new AbortController()
  const queuedAbort = act.systemOne(intentOf('Why does the build fail?'), { phase: 'intent', signal: leave.signal })
  const measuredFast = stubSidecar(fake, { measured: { cpu: { intent: 0.0001, route: 0.0001 } } })
  const quick = createLayaClient({ sidecar: measuredFast, settings: { deadlines: { floorMs: 300, ceilingMs: 300, hardMs: 60_000 } } })
  t.after(() => quick.dispose())
  await sleep(30)
  leave.abort(new Error('the run ended'))
  await assert.rejects(queuedAbort, /the run ended/)
  // A second client on the same server: its own gate is empty, so it would send at once. Kept
  // behind a shadow chunk of its own instead, it passes its deadline while queued.
  const block = shadowOf(quick, ROUTE)
  await waitFor('the other client\'s chunk sent', () => fake.requests.length, (n) => n === 2)
  await assert.rejects(quick.client('act').systemOne(intentOf('What is a monad?'), { phase: 'intent' }), (err) => err.code === 'LAYA_TIMEOUT')
  quick.withdraw(block.callId, 'jev_failed')
  await waitFor('every request answered', () => fake.requests.every((r) => r.finishedAt != null) && !client.busy() && !quick.busy(), Boolean, { timeoutMs: 5000 })
  const messages = fake.requests.filter(isIntent).map((r) => r.state.message)
  assert.deepEqual(messages, ['Fix the failing test in src/parser.ts'], 'neither queued request reached the server')
  assert.equal(sidecar.calls.noteResult[0].status, 200, 'the aborted request was answered on its open socket')
})

test('the prediction counts the request in flight and every acting call ahead, and fails fast', async (t) => {
  const tokens = tokensOf(INTENT, 'intent')
  const perToken = 2000 / tokens // every intent call is predicted at 2 s
  const { fake, client } = await rig(t, {
    fake: { msPerRow: 100 },
    settings: { deadlines: { floorMs: 5000, ceilingMs: 5000, hardMs: 60_000 } },
    sidecar: { measured: { cpu: { intent: perToken } } },
  })
  const act = client.client('act')
  const a = act.systemOne(INTENT, { phase: 'intent' })
  await waitFor('the first call on the wire', () => fake.requests.length, (n) => n === 1)
  const b = act.systemOne(INTENT, { phase: 'intent' })
  await sleep(20)
  const t0 = Date.now()
  await assert.rejects(act.systemOne(INTENT, { phase: 'intent' }), (err) => {
    assert.equal(err.code, 'LAYA_PREDICTED_OVER')
    assert.match(err.message, /^Laya would need about [56] s for this call on the CPU, over its 5 s deadline$/)
    return true
  })
  assert.ok(Date.now() - t0 < 100, 'failed at once')
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(ra.meta.predictedMs, 2000)
  assert.equal(rb.meta.deadlineMs, 5000)
  assert.equal(fake.requests.length, 2, 'the refused call sent nothing')
})

test('an acting request that has waited 2 s says so, and priority is raised for it at once', async (t) => {
  const { fake, sidecar, client } = await rig(t, { fake: { msPerRow: 900 } })
  const shadow = shadowOf(client, intentOf('A shadowed message long enough to matter'), { phase: 'intent' })
  await waitFor('the shadow chunk on the wire', () => fake.requests.length, (n) => n === 1)
  const lines = []
  const t0 = Date.now()
  const answer = await client.client('act', { onWait: (text) => lines.push({ text, at: Date.now() - t0 }) }).systemOne(INTENT, { phase: 'intent' })
  assert.ok(answer.meta.waitedMs >= 1500, `waited ${answer.meta.waitedMs} ms`)
  const waits = lines.filter((l) => l.text.startsWith('Waiting for Laya'))
  assert.equal(waits.length, 1)
  assert.equal(waits[0].text, 'Waiting for Laya: it is answering an earlier call (2 s)…')
  assert.ok(waits[0].at >= 1900, `the line came after ${waits[0].at} ms`)
  await shadow.done
  const raised = sidecar.calls.setPriority.find((p) => p.level === 'normal')
  assert.ok(raised.at < fake.requests[0].finishedAt, 'raised while the shadow chunk was still computing')
})

test('a call that went straight out waited for nothing, however the clock moved while it was queued, and one behind another says how long', async (t) => {
  // A clock that moves 1 ms each time it is read: queueing a lone call and starting it read it
  // several times, as a real millisecond can tick between the two.
  let clock = 1_000_000
  const { client } = await rig(t, { fake: { msPerRow: 5 }, now: () => clock++ })
  const act = client.client('act')
  assert.equal((await act.systemOne(INTENT, { phase: 'intent' })).meta.waitedMs, 0, 'nothing was ahead of it')
  const [first, second] = await Promise.all([act.systemOne(INTENT, { phase: 'intent' }), act.systemOne(intentOf('Explain the parser'), { phase: 'intent' })])
  assert.equal(first.meta.waitedMs, 0)
  assert.ok(second.meta.waitedMs > 0, `the second waited for the first (${second.meta.waitedMs} ms)`)
  // The shadow's jobs likewise: alone, it waited for no earlier answer.
  const alone = await shadowOf(client, INTENT, { phase: 'intent' }).done
  assert.equal(alone.status, 'answered')
  assert.equal(alone.answer.meta.waitedMs, 0)
})

test('priority: below normal for shadow work, normal for acting requests, lowered after them', async (t) => {
  const { fake, sidecar, client } = await rig(t, { fake: { msPerRow: 60 } })
  const shadow = shadowOf(client, INTENT, { phase: 'intent' })
  await waitFor('the shadow chunk on the wire', () => fake.requests.length, (n) => n === 1)
  await client.client('act').systemOne(intentOf('Explain the parser'), { phase: 'intent' })
  await shadow.done
  await sleep(20)
  const levels = sidecar.calls.setPriority.map((p) => p.level)
  assert.equal(levels[0], 'below_normal', 'the shadow chunk ran below normal')
  assert.ok(levels.indexOf('normal') > 0, 'raised for the acting request')
  assert.equal(levels.at(-1), 'below_normal', 'lowered once no acting request was left')
})

test('with an intent-only warm-up, the first route is predicted at its own measured cost and does not time out', async (t) => {
  // An earlier start measured every phase; this start's warm-up sent the intent probes only.
  const routeTokens = tokensOf(ROUTE, 'route')
  const routePerToken = 300 / routeTokens
  const intentPerToken = routePerToken / 2.2
  const rows = Object.keys(ROUTE.questions).length
  const { client } = await rig(t, {
    fake: { msPerRow: Math.ceil(300 / rows) },
    settings: { deadlines: { floorMs: 1, ceilingMs: 120_000, hardMs: 60_000 } },
    sidecar: { measured: { cpu: { intent: intentPerToken, route: routePerToken } } },
  })
  const answer = await client.client('act').systemOne(ROUTE, { phase: 'route' })
  assert.equal(Object.keys(answer.answers).length, rows)
  assert.equal(answer.meta.predictedMs, 300, 'the route figure, not the intent one')
  assert.equal(answer.meta.deadlineMs, 2600)
  // A phase with no figure takes the largest one the device has; a device with none, 4 ms a token.
  const review = await client.client('act').systemOne(INTENT, { phase: 'review' })
  assert.equal(review.meta.predictedMs, Math.round(tokensOf(INTENT, 'review') * routePerToken))
  const bare = await rig(t, { sidecar: { device: 'cuda' }, settings: { deadlines: { floorMs: 1, ceilingMs: 120_000, hardMs: 60_000 } } })
  const cold = await bare.client.client('act').systemOne(INTENT, { phase: 'intent' })
  assert.equal(cold.meta.predictedMs, tokensOf(INTENT, 'intent') * 4)
})

test('ensureReady runs before every request, so a restart within a call or between two calls of a run is waited out', async (t) => {
  const first = await startFakeLaya({ apiKey: KEY })
  const second = await startFakeLaya({ apiKey: 'b'.repeat(48) })
  t.after(async () => { await first.close(); await second.close() })
  const sidecar = stubSidecar(first, { measured: { cpu: { intent: 0.0001, route: 0.0001 } } })
  const client = createLayaClient({ sidecar, settings: { deadlines: { floorMs: 400, ceilingMs: 400, hardMs: 60_000 } } })
  t.after(() => client.dispose())
  const lines = []
  const act = client.client('act', { onWait: (l) => lines.push(l) })
  await act.systemOne(INTENT, { phase: 'intent' })
  assert.equal(sidecar.calls.ensureReady, 2, 'once to learn the device, once before the request')
  // Right after the route's first request, Laya crashes and restarts on a new port with a new key:
  // the next request waits for it, and the wait, longer than the call's own 400 ms deadline, does
  // not count against it.
  const requests = renderForLaya({ phase: 'route', ...ROUTE }, { role: 'act' }).length
  assert.ok(requests >= 2)
  const note = sidecar.noteResult
  let crashed = false
  sidecar.noteResult = async (r) => {
    const out = await note(r)
    if (r.phase === 'route' && !crashed) {
      crashed = true
      sidecar.state = 'restarting'
      sidecar.starting = new Promise((resolve) => setTimeout(() => {
        sidecar.conn = { url: second.url, key: 'b'.repeat(48), device: 'cpu', pid: 7 }
        sidecar.state = 'ready'
        sidecar.starting = null
        resolve()
      }, 600))
    }
    return out
  }
  const t0 = Date.now()
  const answer = await act.systemOne(ROUTE, { phase: 'route' })
  assert.ok(Date.now() - t0 >= 600)
  assert.equal(Object.keys(answer.answers).length, Object.keys(ROUTE.questions).length)
  assert.equal(sidecar.calls.ensureReady, 2 + 1 + requests, 'before every request')
  assert.equal(first.requests.length, 2)
  assert.equal(second.requests.length, requests - 1)
  assert.ok(second.requests.every((r) => r.authorization === `Bearer ${'b'.repeat(48)}`))
  assert.ok(lines.some((l) => l.startsWith('Starting Laya on this PC')))
  // And between two calls: the review, minutes after the route, finds Laya restarting again.
  sidecar.state = 'restarting'
  sidecar.starting = new Promise((resolve) => setTimeout(() => { sidecar.state = 'ready'; sidecar.starting = null; resolve() }, 500))
  const later = await act.systemOne(intentOf('Review the rename'), { phase: 'review' })
  assert.deepEqual(Object.keys(later.answers), ['kind', 'depth', 'alsoWork'])
  assert.equal(second.requests.length, requests)
})

test('past hardMs the socket goes and Laya restarts, and Node\'s headers timeout takes the same path', async (t) => {
  const { fake, sidecar, client } = await rig(t, { settings: { deadlines: { floorMs: 5000, ceilingMs: 5000, hardMs: 1000 } } })
  fake.hang()
  const t0 = Date.now()
  await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => {
    assert.equal(err.code, 'LAYA_TIMEOUT')
    assert.equal(err.message, 'Laya spent over 1 s on one request and was restarted')
    return true
  })
  assert.ok(Date.now() - t0 < 2500)
  assert.deepEqual(sidecar.calls.restart, [{ reason: 'hung' }])
  assert.equal(client.busy(), false, 'the slot is free again')

  const headersTimeout = () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
    return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }))
  }
  const other = stubSidecar(fake)
  const viaNode = createLayaClient({ sidecar: other, fetch: headersTimeout })
  t.after(() => viaNode.dispose())
  await assert.rejects(viaNode.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => err.code === 'LAYA_TIMEOUT' && err.hard === true)
  assert.deepEqual(other.calls.restart, [{ reason: 'hung' }])
  // A shadow chunk on the same path fails its row as a timeout.
  const shadow = await shadowOf(viaNode, INTENT, { phase: 'intent' }).done
  assert.equal(shadow.status, 'failed')
  assert.equal(shadow.reason, 'timeout')
})

test('a 401 rebuilds the client from the current connection and is sent once more; a second one fails the call', async (t) => {
  const fresh = 'c'.repeat(48)
  const { fake, sidecar, client } = await rig(t, { fake: { apiKey: fresh } })
  // ensureReady hands out the key of before a restart; connection() already has the new one.
  sidecar.latest = { url: fake.url, key: fresh, device: 'cpu', pid: 9 }
  const answer = await client.client('act').systemOne(INTENT, { phase: 'intent' })
  assert.deepEqual(Object.keys(answer.answers), ['kind', 'depth', 'alsoWork'])
  assert.deepEqual(fake.requests.map((r) => r.status), [401, 200])
  assert.equal(fake.requests[1].authorization, `Bearer ${fresh}`)
  assert.deepEqual(sidecar.calls.noteResult.map((r) => r.status), [401, 200])

  fake.failNext(401)
  fake.failNext(401)
  await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => err.code === 'LAYA_HTTP_401')
  assert.deepEqual(fake.requests.slice(2).map((r) => r.status), [401, 401], 'sent twice, never a third time')
  assert.deepEqual(sidecar.calls.noteResult.slice(2).map((r) => r.status), [401, 401], 'the sidecar hears both, and restarts on the second')
})

test('a 500 is not retried', async (t) => {
  const { fake, sidecar, client } = await rig(t)
  fake.failNext(500)
  await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => {
    assert.equal(err.name, 'Error')
    assert.equal(err.code, 'LAYA_HTTP_500')
    assert.equal(err.message, 'Laya failed on this call (inference failed)')
    return true
  })
  assert.equal(fake.requests.length, 1)
  assert.deepEqual(sidecar.calls.noteResult.map((r) => [r.status, r.phase, r.role]), [[500, 'intent', 'act']])
})

/**
 * The sidecar's noteResult as the real one counts: the second 500 or the second 401 in a row
 * restarts Laya, which leaves ready at once, as the real stop does, and resolves only once the stop
 * and the start (`restartMs`) are over.
 */
function restartingOnSecondFailure(sidecar, restartMs) {
  const fails = { 500: 0, 401: 0 }
  sidecar.noteResult = (r) => {
    sidecar.calls.noteResult.push({ ...r, at: Date.now() })
    if (r.status === 200) { fails[500] = 0; fails[401] = 0 }
    if ((r.status !== 500 && r.status !== 401) || ++fails[r.status] < 2) return Promise.resolve({})
    fails[r.status] = 0
    sidecar.state = 'restarting'
    sidecar.starting = new Promise((resolve) => setTimeout(() => { sidecar.state = 'ready'; sidecar.starting = null; resolve() }, restartMs))
    return sidecar.starting.then(() => ({}))
  }
  return fails
}
const settle = (p) => p.then((answer) => ({ answer, at: Date.now() }), (error) => ({ error, at: Date.now() }))

test('a request that fails does not wait for the restart it causes, and an acting call queued behind it waits for the start', async (t) => {
  for (const status of [500, 401]) {
    const { fake, sidecar, client } = await rig(t, {
      fake: { msPerRow: 60 },
      settings: { deadlines: { floorMs: 1500, ceilingMs: 1500, hardMs: 60_000 } },
      sidecar: { measured: { cpu: { intent: 0.0001 } } },
    })
    restartingOnSecondFailure(sidecar, 2500)
    // The first failure, then the second: a 500 twice, or one 401 and the retry's.
    fake.failNext(status)
    if (status === 500) await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => err.code === 'LAYA_HTTP_500')
    fake.failNext(status)
    const lines = []
    const t0 = Date.now()
    const failing = settle(client.client('act').systemOne(INTENT, { phase: 'intent' }))
    const queued = settle(client.client('act', { onWait: (l) => lines.push(l) }).systemOne(intentOf('Explain the parser'), { phase: 'intent' }))
    const b = await failing
    assert.equal(b.error?.code, `LAYA_HTTP_${status}`, `${status}: the failure is reported as it is, not as a timeout`)
    assert.ok(b.at - t0 < 1000, `${status}: rejected after ${b.at - t0} ms, before the restart ended`)
    const c = await queued
    assert.equal(c.error, undefined, `${status}: the queued call was answered`)
    assert.ok(c.at - t0 >= 2400, `${status}: it waited for the restart`)
    assert.ok(lines.some((l) => l.startsWith('Starting Laya on this PC')), `${status}: with the Starting line`)
    assert.equal(lines.some((l) => l.startsWith('Waiting for Laya')), false, `${status}: not behind an earlier call`)
  }
})

test('a 401 that begins a restart is not sent again to the server going away', async (t) => {
  const { fake, sidecar, client } = await rig(t, { sidecar: { measured: { cpu: { intent: 0.0001 } } } })
  const fails = restartingOnSecondFailure(sidecar, 300)
  // An earlier call's 401 was followed by a 500, so this call's first 401 is the second in a row.
  fails[401] = 1
  fake.failNext(401)
  await assert.rejects(client.client('act').systemOne(INTENT, { phase: 'intent' }), (err) => err.code === 'LAYA_HTTP_401')
  assert.equal(fake.requests.length, 1, 'sent once')
  await waitFor('Laya running again', () => sidecar.state, (s) => s === 'ready')
  assert.deepEqual(Object.keys((await client.client('act').systemOne(INTENT, { phase: 'intent' })).answers), ['kind', 'depth', 'alsoWork'])
})

test('Laya stopped on purpose under a request: a shadow job is skipped as the stop says, and an acting call says Laya was stopped', async (t) => {
  /** A request on the wire, then the sidecar's stop: `stopping` at once, the process gone, then `stopped` with its reason. */
  async function stoppedUnder(run, { stoppedBecause, why = null, restarts = false }) {
    const fake = await startFakeLaya({ apiKey: KEY, msPerRow: 400 })
    const sidecar = stubSidecar(fake)
    const client = createLayaClient({ sidecar, settings: { deadlines: { floorMs: 20_000, ceilingMs: 60_000, hardMs: 60_000 } } })
    t.after(() => client.dispose())
    const result = settle(run(client))
    await waitFor('the request on the wire', () => fake.requests.length, (n) => n === 1)
    sidecar.state = restarts ? 'ready' : 'stopping'
    await fake.close()
    setTimeout(() => { Object.assign(sidecar, { state: restarts ? 'restarting' : 'stopped', stoppedBecause, why }) }, 150)
    return { out: await result, client }
  }
  const shadow = (client) => shadowOf(client, INTENT, { phase: 'intent' }).done

  // residency.yieldFor: the memory went to a local model.
  const yielded = await stoppedUnder(shadow, { stoppedBecause: 'yielded', why: 'qwen3-8b' })
  assert.equal(yielded.out.answer.status, 'skipped')
  assert.equal(yielded.out.answer.reason, 'yielded')
  assert.equal(yielded.client.counters().failed, 0)
  assert.equal(yielded.client.counters().skipped.yielded, 1)
  // The idle stop, the budget and a Stop: Laya is not running.
  for (const because of ['idle', 'budget', null]) {
    const { out, client } = await stoppedUnder(shadow, { stoppedBecause: because, why: because === 'budget' ? 'RAM over 12 GB' : null })
    assert.deepEqual([out.answer.status, out.answer.reason], ['skipped', 'not_running'], `stopped because ${because}`)
    assert.equal(client.counters().skipped.not_running, 1)
  }
  // A crash is still a failed row: Laya is restarting.
  const crashed = await stoppedUnder(shadow, { restarts: true })
  assert.deepEqual([crashed.out.answer.status, crashed.out.answer.reason], ['failed', 'LAYA_EXITED'])
  assert.equal(crashed.out.answer.error.message, 'Laya stopped while answering (the process ended); it is restarting')

  // An acting call says Laya was stopped, and why, never that it is restarting.
  const act = (client) => client.client('act').systemOne(INTENT, { phase: 'intent' })
  const budget = await stoppedUnder(act, { stoppedBecause: 'budget', why: 'RAM over 12 GB' })
  assert.equal(budget.out.error.code, 'LAYA_EXITED')
  assert.equal(budget.out.error.message, 'Laya was stopped while answering (the resource budget: RAM over 12 GB)')
  const gave = await stoppedUnder(act, { stoppedBecause: 'yielded', why: 'qwen3-8b' })
  assert.equal(gave.out.error.message, 'Laya was stopped while answering (it gave its memory to qwen3-8b)')
  const stopped = await stoppedUnder(act, { stoppedBecause: null })
  assert.equal(stopped.out.error.message, 'Laya was stopped while answering')
})

// ---------------------------------------------------------------- what an answer says

test('the answer is relabelled with what answered, its meta is complete, and its identity does not follow the device', async (t) => {
  const { fake, sidecar, client } = await rig(t, { fake: { msPerRow: 2 } })
  const traces = []
  const jev = createJev({ provider: LAYA, client: client.client('act'), onTrace: (tr) => traces.push(tr) })
  const intent = await jev.intent({ message: 'Fix the failing test in src/parser.ts' })
  assert.equal(intent.kind === 'task' || intent.kind === 'question', true)
  const [trace] = traces
  assert.equal(trace.model, 'laya-english/0.3.20@0123456')
  assert.equal(trace.provider, 'laya')
  assert.equal(trace.requestId, undefined)
  assert.deepEqual(Object.keys(trace.meta).sort(), ['atContextLimit', 'corrected', 'deadlineMs', 'device', 'identity', 'lang', 'predictedMs', 'provider', 'requests', 'rows', 'uninformative', 'waitedMs'])
  assert.equal(trace.meta.provider, 'laya')
  assert.equal(trace.meta.device, 'cpu')
  assert.equal(trace.meta.identity, IDENTITY)
  assert.equal(trace.meta.requests, 1)
  assert.equal(trace.meta.rows, 3)
  assert.equal(trace.meta.lang, 'latin')
  assert.ok(trace.questions.every((q) => typeof q.informative === 'boolean' && typeof q.corrected === 'boolean'))
  assert.ok(fake.requests.every((r) => r.model === 'english'))

  const route = await client.client('act').systemOne(ROUTE, { phase: 'route' })
  assert.ok(route.meta.corrected.includes('taskType') && route.meta.corrected.includes('skill'), 'the 11+ bucket re-tempered')
  assert.ok(route.answers.taskType.corrected)

  sidecar.conn = { ...sidecar.conn, device: 'cuda' }
  const onGpu = await client.client('act').systemOne(intentOf('Почему этот тест падает после обновления?'), { phase: 'intent' })
  assert.equal(onGpu.meta.device, 'cuda')
  assert.equal(onGpu.meta.identity, IDENTITY, 'the device is beside the identity, never in it')
  assert.equal(onGpu.meta.lang, 'non-latin')
  assert.equal(client.identity(), IDENTITY)
  assert.equal(langOf({ task: '修复解析器中失败的测试' }), 'non-latin')
  assert.equal(langOf({ task: 'Fix the parser: ça ne marche pas' }), 'latin')
})

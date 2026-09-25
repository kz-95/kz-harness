// The end-to-end check against the real laya.serve (docs/laya-auto.md 9.4), run by hand:
//   KZH_LAYA_E2E=1 KZH_LAYA_HARNESS=<dir> [KZH_LAYA_DATA=<dir>] npm --prefix plugins/jev-router run test:e2e
// <dir> is a harness laid out as the installer leaves one: engine/laya/venv with laya and torch,
// engine/laya/installed.json, models/laya/hf holding a planted snapshot of convaiinnovations/laya,
// config/ and plugins/ (links to this repo will do). The cloud cannot download Laya's weights, so
// the snapshot there holds random weights at the real English architecture, which
// test/e2e/make_ckpt.py builds and test/e2e/plant_hf_cache.py plants, both run with Laya's venv:
//   <venv python> make_ckpt.py <ckpt>
//   <venv python> plant_hf_cache.py <ckpt> <dir>/models/laya/hf --link
// Every answer is meaningless, and this proves the rest, being the real process, protocol,
// supervision, deadlines, memory, whole runs through the plugin and the rendering, through KzH's
// own code. Every assertion is about behaviour, never about what an answer says. It is outside
// test/*.test.js, so npm test never runs it.
//
// Each step of 9.4 runs on its own: a step that fails is reported with its reason and the numbers
// it measured, and the next one runs. It writes what it measured to e2e-report.json in the data
// folder, and exits 1 when any step failed. Steps 2 to 5 and 8 drive the supervisor and client
// directly; steps 6 and 7 boot the plugin with apply() on the same harness, after the first
// supervisor has gone, since one harness has one Laya; step 9 needs no server.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createJev } from '../../jev.js'
import { createLayaClient } from '../../laya-client.js'
import { layaPaths, readPins, recordWeights } from '../../laya-install.js'
import { estimateRequestTokens, renderForLaya } from '../../laya-questions.js'
import { createLayaSidecar } from '../../laya-sidecar.js'
import { createProbe } from '../../laya-selfcheck.js'
import { workingSetOf } from '../../local.js'
import { resolveProviders } from '../../providers.js'
import { createBudgetWatchdog, createResidency } from '../../residency.js'
import { renderCheck } from '../../../../scripts/laya-render-check.mjs'
import { bootPlugin, jev, net, sdkEnvReads, typesafe } from './plugin-host.mjs'

if (process.env.KZH_LAYA_E2E !== '1') { console.log('skipped: set KZH_LAYA_E2E=1 to run against a real laya.serve'); process.exit(0) }
const harnessDir = process.env.KZH_LAYA_HARNESS
assert.ok(harnessDir && existsSync(join(harnessDir, 'engine', 'laya', 'installed.json')), 'KZH_LAYA_HARNESS names an installed harness')
const dataDir = process.env.KZH_LAYA_DATA ?? join(harnessDir, '..', 'data')
mkdirSync(dataDir, { recursive: true })

const GB = 1024 ** 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const since = (t) => Date.now() - t
const bodies = JSON.parse(readFileSync(new URL('../fixtures/kzh-bodies.json', import.meta.url), 'utf8'))
const ask = (b) => ({ state: b.state, questions: b.questions })
const TASK = 'Fix the failing test in the parser'
// The machine as the run found it: every figure below is only as good as the cores it had.
const report = { startedAt: new Date().toISOString(), harnessDir, dataDir, cpus: cpus().length, loadAtStart: loadavg(), steps: [] }
const lines = []

/**
 * One step of 9.4: `run(m)` fills `m` with what it measured as it goes, so a step that fails still
 * reports the numbers it got to. A failure is recorded and printed, and the next step runs.
 */
async function step(id, title, run) {
  const m = {}
  const t0 = Date.now()
  try {
    await run(m)
    report.steps.push({ id, title, ok: true, ms: since(t0), ...m })
    console.log(`ok    ${id}  ${title}  ${JSON.stringify(m)}`)
  } catch (err) {
    report.steps.push({ id, title, ok: false, ms: since(t0), error: String(err?.stack ?? err), ...m })
    console.log(`FAIL  ${id}  ${title}  ${err?.message ?? err}\n      measured: ${JSON.stringify(m)}`)
  }
}
const notRun = (id, title, why) => { report.steps.push({ id, title, ok: null, notRun: why }); console.log(`--    ${id}  ${title}  not run: ${why}`) }

/** Until `ok(read())` holds, polling every `everyMs`; throws with the last value past `timeoutMs`. */
async function until(label, read, ok, { timeoutMs, everyMs = 250 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v
    try { v = await read() } catch (err) { v = `not readable: ${err.message}` }
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`${label}: not so after ${timeoutMs} ms (last: ${JSON.stringify(v)?.slice(0, 400)})`)
    await sleep(everyMs)
  }
}

/**
 * A fetch for the SDK a Laya client builds, which sees the wire as laya.serve does: every POST it
 * sends, with its question names, when it went out, and when its response came back, which for
 * laya.serve is when the inference ended, since it sends no header before. It counts how many
 * requests were ever on the wire at once.
 */
function wireSpy() {
  const sent = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch = async (input, init) => {
    let questions = []
    try { questions = Object.keys(JSON.parse(String(init?.body ?? '{}')).questions ?? {}) } catch { questions = [] }
    const rec = { questions, sentAt: Date.now(), answeredAt: null, status: null }
    sent.push(rec)
    maxInFlight = Math.max(maxInFlight, ++inFlight)
    try {
      const r = await globalThis.fetch(input, init)
      rec.status = r.status
      return r
    } finally { rec.answeredAt = Date.now(); inFlight-- }
  }
  return { fetch, sent, maxInFlight: () => maxInFlight, of: (b) => sent.filter((r) => r.questions.some((q) => Object.hasOwn(b.questions, q))) }
}

// --- the harness's Laya, as steps 2 to 5 and 8 drive it ---

const paths = layaPaths({ harnessDir, dataDir })
const { laya: LAYA, layaSettings } = resolveProviders({}, {})
const residency = createResidency({ log: (m) => lines.push(`residency: ${m}`) })
const states = [] // every state the supervisor announced, with its time
const sidecar = createLayaSidecar({
  harnessDir, dataDir, config: { ...layaSettings, device: 'cpu' }, pins: readPins(harnessDir), residency,
  probe: (conn) => createProbe(conn, { temperatureCorrections: layaSettings.temperatureCorrections, minTopMargin: layaSettings.minTopMargin }),
  log: (m) => lines.push(m),
  onChange: ({ state }) => { if (states.at(-1)?.state !== state) states.push({ state, at: Date.now() }) },
})
const client = createLayaClient({ sidecar, settings: layaSettings, log: (m) => lines.push(m) })
const act = client.client('act')

// --- 1. the install, for real, except the weights ---
{
  let free = null
  let packages = null
  try { free = Math.round((statfsSync(dataDir).bavail * statfsSync(dataDir).bsize) / GB * 10) / 10 } catch { free = null }
  try { packages = Math.round(Number(execFileSync('du', ['-sbL', join(paths.venv, 'lib')], { encoding: 'utf8' }).split(/\s/)[0]) / GB * 10) / 10 } catch { packages = null }
  notRun('1', 'install through laya-install.js with { skipWeights, torchIndex: pypi }', `the disk has ${free ?? '?'} GB free and the venv's packages already take ${packages ?? '?'} GB; a second torch install does not fit, so the venv the harness links (laya 0.3.20, torch 2.14.0, transformers 5.17.0 from the pinned lock) stands in for it`)
}

// --- 2. the checkpoint planted and loaded once, the weights recorded after that load (7.3) ---
await step('2', 'the planted checkpoint and its weights record', async (m) => {
  const hub = join(paths.hf, 'hub', 'models--convaiinnovations--laya')
  assert.ok(existsSync(join(hub, 'refs', 'main')), `no snapshot planted under ${paths.hf}: build one with test/e2e/make_ckpt.py and plant it with test/e2e/plant_hf_cache.py`)
  m.commit = readFileSync(join(hub, 'refs', 'main'), 'utf8').trim()
  assert.ok(existsSync(join(hub, 'snapshots', m.commit, 'model.safetensors')), 'the planted snapshot is complete')
  if (!existsSync(paths.weights)) await recordWeights(paths, { repo: 'convaiinnovations/laya', commit: m.commit, downloadedAt: Date.now(), loadedAt: Date.now() })
  m.weightsRecorded = existsSync(paths.weights)
})

// --- 3. the real supervisor starts the real laya.serve on the CPU ---
await step('3', 'start through the supervisor, a wrong key and a non-loopback connection refused', async (m) => {
  const t0 = Date.now()
  const conn = await sidecar.ensureReady()
  m.readyMs = since(t0)
  const st = sidecar.status()
  assert.equal(st.state, 'ready')
  assert.match(conn.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'laya.serve listens on the loopback only')
  assert.equal(st.running?.device, 'cpu', 'laya.serve runs on the CPU here')
  Object.assign(m, { device: st.running.device, threads: st.running.threads, ramGB: st.running.ramGB, url: conn.url, warnings: (st.warnings ?? []).map((w) => w.kind ?? w) })
  m.fullWarmUp = lines.some((l) => /^laya: ready in .*, measured$/.test(l))
  assert.ok(m.warnings.includes('temperatures'), "Laya's own temperature warning was parsed")

  const wrong = await fetch(new URL('/v1/systemone', conn.url), { method: 'POST', headers: { authorization: 'Bearer not-the-key', 'content-type': 'application/json' }, body: JSON.stringify(ask(bodies.intent)) })
  m.wrongKeyStatus = wrong.status
  assert.equal(wrong.status, 401, 'a wrong key is refused')

  const outside = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null
  m.nonLoopbackAddress = outside
  if (outside) {
    const port = new URL(conn.url).port
    m.nonLoopback = await fetch(`http://${outside}:${port}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => `answered ${r.status}`, (e) => `refused (${e.cause?.code ?? e.name})`)
    assert.match(m.nonLoopback, /^refused/, "the machine's other address reaches nothing")
  }
})

// --- 4. KzH's real bodies through the Laya client, the adapter and the gate, then createJev ---
await step('4', "KzH's four real bodies, and createJev with Laya's record", async (m) => {
  m.calls = {}
  for (const name of ['intent', 'resource', 'task', 'review']) {
    const b = bodies[name]
    const t0 = Date.now()
    const answer = await act.systemOne(ask(b), { phase: b.phase })
    const got = answer?.answers ?? {}
    const names = Object.keys(b.questions)
    for (const q of names) assert.ok(got[q], `${name}: ${q} was answered`)
    m.calls[name] = { questions: names.length, ms: since(t0), flat: names.filter((q) => got[q]?.informative === false).length, requests: answer.meta.requests, atContextLimit: answer.meta.atContextLimit, model: answer.model }
    assert.match(answer.model, /^laya-english\/0\.3\.20@[0-9a-f]{7}$/, 'relabelled with what really answered')
    assert.equal(answer.meta.atContextLimit, 0, `${name}: no request reached the context limit`)
  }
  const j = createJev({ provider: LAYA, client: act })
  const t0 = Date.now()
  const intent = await j.intent({ message: 'Rename the helper in utils.js and update its callers', context: {} })
  m.createJevIntent = { ms: since(t0), kind: intent?.kind ?? null, uninformative: intent?.uninformative ?? null }
  assert.ok(['task', 'question'].includes(intent?.kind))
})

// --- 5. the gate against the real lock (4.5) ---
await step('5', 'the gate against the real lock: deadline, abort, a queued call never sent', async (m) => {
  const task = bodies.task
  const intent = bodies.intent
  const taskParts = renderForLaya({ phase: 'route', ...ask(task) }, { role: 'act' })
  const intentTokens = renderForLaya({ phase: 'intent', ...ask(intent) }, { role: 'act' }).reduce((n, r) => n + estimateRequestTokens(r), 0)
  m.routeRequests = taskParts.map((r) => `${r.key} (${Object.keys(r.questions).length} questions)`)

  // a. This PC's own figures, a 3 s deadline: the prediction refuses the call at once, and nothing is sent.
  {
    const spy = wireSpy()
    const c = createLayaClient({ sidecar, settings: { ...layaSettings, deadlines: { ...layaSettings.deadlines, floorMs: 3000, ceilingMs: 3000 } }, fetch: spy.fetch, log: (l) => lines.push(l) })
    const t0 = Date.now()
    const err = await c.client('act').systemOne(ask(task), { phase: 'route' }).then(() => null, (e) => e)
    m.predicted = { ms: since(t0), code: err?.code ?? null, message: err?.message ?? null, sent: spy.sent.length }
    c.dispose()
    assert.equal(err?.code, 'LAYA_PREDICTED_OVER', 'over its deadline by prediction, it fails at once')
    assert.equal(spy.sent.length, 0, 'and never reaches the server')
  }

  // b and c: the one input set here is the prediction, through a view of the supervisor: a route
  // figure small enough that the route call is sent with the 3 s floor as its deadline, and an
  // intent figure large enough that an intent queued behind it can wait the held slot out. The
  // server, its lock, the wire and the gate are all real.
  const view = { ...sidecar, readSettings: () => ({ ...sidecar.readSettings(), measured: { cpu: { msPerToken: { route: 0.0001, review: 0.0001, intent: 45_000 / intentTokens } } } }) }
  const spy = wireSpy()
  const c = createLayaClient({ sidecar: view, settings: { ...layaSettings, deadlines: { ...layaSettings.deadlines, floorMs: 3000, ceilingMs: 120_000 } }, fetch: spy.fetch, log: (l) => lines.push(l) })
  const gate = c.client('act')
  try {
    // b. The deadline rejects at 3 s; the slot stays held until laya.serve answers; the call's
    // second request is never sent; an intent sent in the meantime goes out only then, alone.
    {
      const t0 = Date.now()
      const err = await gate.systemOne(ask(task), { phase: 'route' }).then(() => null, (e) => e)
      const rejectedMs = since(t0)
      const heldAtReject = c.busy()
      const i0 = Date.now()
      const answered = await gate.systemOne(ask(intent), { phase: 'intent' })
      const intentMs = since(i0)
      const [route] = spy.of(task)
      const [intentReq] = spy.of(intent)
      m.deadline = {
        code: err?.code ?? null, message: err?.message ?? null, rejectedMs, heldAtReject,
        routeRequestsSent: spy.of(task).length, serverAnsweredMs: route ? route.answeredAt - t0 : null,
        intentQueuedMs: intentReq ? intentReq.sentAt - i0 : null, intentOnWireMs: intentReq ? intentReq.answeredAt - intentReq.sentAt : null, intentMs,
      }
      assert.equal(err?.code, 'LAYA_TIMEOUT')
      assert.equal(err.message, 'timed out after 3 s')
      assert.ok(rejectedMs >= 2900 && rejectedMs < 4000, `rejected at ${rejectedMs} ms, on its 3 s deadline`)
      assert.ok(heldAtReject, 'the request is still on the wire when the caller has its error')
      assert.equal(spy.of(task).length, 1, 'only the request already on the wire went; the rest of the call never did')
      assert.ok(route.answeredAt - t0 > rejectedMs + 5000, 'laya.serve answered long after the deadline')
      assert.ok(intentReq.sentAt >= route.answeredAt, 'the intent went out only once laya.serve had answered the abandoned request')
      assert.ok(answered?.answers && Object.keys(answered.answers).length === 3, 'and was answered')
      assert.ok(intentReq.answeredAt - intentReq.sentAt < 5000, 'alone: no abandoned work ahead of it on the server')
    }
    // c. The caller aborts at 2 s: the same; an intent queued behind it and aborted before it could
    // be sent never reaches the server; the next call runs alone once the slot is free.
    {
      const before = spy.sent.length
      const stop = new AbortController()
      const t0 = Date.now()
      setTimeout(() => stop.abort(new Error('stopped by the caller at 2 s')), 2000)
      const err = await gate.systemOne(ask(task), { phase: 'route', signal: stop.signal }).then(() => null, (e) => e)
      const rejectedMs = since(t0)
      const drop = new AbortController()
      const q0 = Date.now()
      const queued = gate.systemOne(ask(intent), { phase: 'intent', signal: drop.signal }).then(() => 'answered', (e) => e)
      await sleep(1000)
      drop.abort(new Error('stopped while queued'))
      const queuedOutcome = await queued
      const queuedRejectedMs = since(q0)
      const route = spy.sent.slice(before).find((r) => r.questions.some((q) => Object.hasOwn(task.questions, q)))
      await until('laya.serve answers the aborted route request', () => route.answeredAt, (x) => x != null, { timeoutMs: 180_000 })
      await sleep(2000)
      const intentSentWhileHeld = spy.sent.slice(before).filter((r) => r.questions.some((q) => Object.hasOwn(intent.questions, q))).length
      const n0 = Date.now()
      await gate.systemOne(ask(intent), { phase: 'intent' })
      const next = spy.sent.at(-1)
      m.abort = {
        message: err?.message ?? null, rejectedMs, serverAnsweredMs: route.answeredAt - t0,
        queuedRejectedAfterAbortMs: queuedRejectedMs - 1000, queuedOutcome: queuedOutcome?.message ?? queuedOutcome, queuedIntentSent: intentSentWhileHeld,
        nextIntentMs: since(n0), nextOnWireMs: next.answeredAt - next.sentAt,
      }
      assert.equal(err?.message, 'stopped by the caller at 2 s', "the caller's own reason")
      assert.ok(rejectedMs >= 1900 && rejectedMs < 2600, `rejected at ${rejectedMs} ms, when the caller aborted`)
      assert.ok(route.answeredAt - t0 > rejectedMs + 5000, 'the slot was held until laya.serve answered')
      assert.equal(queuedOutcome?.message, 'stopped while queued')
      assert.ok(queuedRejectedMs - 1000 < 200, 'a queued call rejects at once when aborted')
      assert.equal(intentSentWhileHeld, 0, 'the aborted queued intent never reached the server')
      assert.ok(next.sentAt >= route.answeredAt && next.answeredAt - next.sentAt < 5000, 'the next call ran alone')
    }
    m.maxOnWire = spy.maxInFlight()
    assert.equal(m.maxOnWire, 1, 'never more than one request on the wire')
  } finally { c.dispose() }
})

// --- 8. supervision: figures, a kill, the watchdog, the idle stop, starting again ---
await step('8', 'supervision: warm-up figures, a kill mid-call, the RAM watchdog, the idle stop, ensureReady', async (m) => {
  // a. What the first start's full warm-up measured on this PC, and the working set now.
  const cpu = sidecar.readSettings().measured.cpu
  m.measured = { msPerToken: cpu.msPerToken, ramGB: cpu.ramGB, loadMs: cpu.loadMs }
  for (const phase of ['intent', 'route', 'review']) assert.ok(cpu.msPerToken[phase] > 0, `a figure for ${phase}`)
  assert.ok(cpu.ramGB > 0 && cpu.ramGB < 3.5, 'a RAM peak under 3.5 GB')
  const ws = await workingSetOf(sidecar.status().running.interpreterPid)
  m.workingSetGB = Math.round((ws / GB) * 100) / 100
  assert.ok(ws > 0 && ws < 3.5 * GB, 'the working set is positive and under 3.5 GB')

  // b. The interpreter killed mid-call: the call fails with the reason, restarting then ready, the next call answers.
  {
    const pid = sidecar.status().running?.interpreterPid
    assert.ok(pid, 'the supervisor names the interpreter it runs')
    const from = states.length
    const pending = act.systemOne(ask(bodies.task), { phase: 'route' }).then(() => 'answered', (err) => err)
    await sleep(1500)
    try { process.kill(pid, 'SIGKILL') } catch {}
    const outcome = await pending
    const t0 = Date.now()
    await sidecar.ensureReady()
    const again = await act.systemOne(ask(bodies.intent), { phase: 'intent' })
    const seen = states.slice(from).map((s) => s.state)
    m.kill = { reason: String(outcome?.message ?? outcome), states: seen, recoveredMs: since(t0), answeredAfter: !!again?.answers }
    assert.notEqual(outcome, 'answered', 'the call on the killed interpreter fails')
    assert.match(String(outcome?.message), /^Laya stopped while answering \(.+\); it is restarting$/)
    assert.ok(seen.indexOf('restarting') >= 0 && seen.lastIndexOf('ready') > seen.indexOf('restarting'), `restarting, then ready: ${seen.join(', ')}`)
    assert.notEqual(sidecar.status().running?.interpreterPid, pid, 'a new interpreter answers')
  }

  // c. A tiny RAM budget: the watchdog passes a held Laya by, takes llama before a held Laya, and
  // takes an unheld Laya first. llama is a stand-in resident on this process's own pid, held as
  // the local chat model always is.
  {
    const unloads = []
    const wlog = []
    const watchdog = createBudgetWatchdog({ residency, readSettings: async () => ({ maxRamGB: 1 }), graceMs: 1000, log: (t) => wlog.push(t) })
    const twice = async () => { await watchdog.check(); await sleep(1100); await watchdog.check() }
    const llama = () => residency.set('llama', { pid: process.pid, startedAt: Date.now(), device: 'cpu', name: 'llama-server (stand-in)', held: () => true, busy: () => false, ramGB: 0.2, unload: async (w) => { unloads.push({ id: 'llama', kind: w.kind }); residency.clear('llama') } })
    const pid = sidecar.status().running.interpreterPid
    sidecar.hold('run:e2e-watchdog')
    await twice()
    const heldAlone = { state: sidecar.status().state, samePid: sidecar.status().running?.interpreterPid === pid, unloads: unloads.length, log: wlog.at(-1) ?? null }
    llama()
    await twice()
    const heldBesideLlama = { state: sidecar.status().state, unloaded: unloads.map((u) => u.id) }
    llama()
    sidecar.release('run:e2e-watchdog')
    await twice()
    const s = sidecar.status()
    const unheld = { state: s.state, stoppedBecause: s.stoppedBecause, why: s.why, unloaded: unloads.map((u) => u.id), llamaStillResident: !!residency.get('llama') }
    residency.clear('llama')
    m.watchdog = { heldAlone, heldBesideLlama, unheld }
    assert.equal(heldAlone.state, 'ready', 'a held Laya alone over the budget is never unloaded')
    assert.ok(heldAlone.samePid && heldAlone.unloads === 0)
    assert.match(String(heldAlone.log), /every resident is held/)
    assert.equal(heldBesideLlama.state, 'ready', 'beside llama, a held Laya still stays')
    assert.deepEqual(heldBesideLlama.unloaded, ['llama'], "and llama goes, by today's rule")
    assert.equal(unheld.state, 'stopped', 'an unheld Laya is unloaded')
    assert.equal(unheld.stoppedBecause, 'budget')
    assert.match(String(unheld.why), /RAM budget/)
    assert.deepEqual(unheld.unloaded, ['llama'], 'and it went first: llama was not touched again')
    assert.ok(unheld.llamaStillResident)
  }

  // d. ensureReady starts it again.
  {
    const t0 = Date.now()
    await sidecar.ensureReady()
    m.afterBudget = { restartMs: since(t0), state: sidecar.status().state }
    const a = await act.systemOne(ask(bodies.intent), { phase: 'intent' })
    assert.ok(a?.answers)
  }

  // e. Unload after idle, 1 minute: shadow requests keep arriving and are answered, and never keep
  // Laya loaded; the comparison cut by the stop is a skip, and a stopped Laya is never started by one.
  {
    await sidecar.setSettings({ idleMinutes: 1 })
    await act.systemOne(ask(bodies.intent), { phase: 'intent' })
    const lastActing = Date.now()
    const results = []
    let offered = 0
    let n = 0
    while (sidecar.status().state === 'ready' && since(lastActing) < 120_000) {
      const r = client.offerShadow({ callId: `e2e-idle-${++n}`, phase: 'intent', ...ask(bodies.intent), onDone: (res) => results.push({ status: res.status, reason: res.reason, at: Date.now() }) })
      if (r.queued) offered++
      await sleep(3000)
    }
    const stoppedAt = states.findLast((s) => s.state === 'stopped')?.at ?? Date.now()
    await sleep(1500)
    const s = sidecar.status()
    const late = client.offerShadow({ callId: 'e2e-idle-late', phase: 'intent', ...ask(bodies.intent), onDone: () => {} })
    await sleep(3000)
    m.idle = {
      stoppedAfterMs: stoppedAt - lastActing, stoppedBecause: s.stoppedBecause, offered,
      answered: results.filter((r) => r.status === 'answered' && r.at < stoppedAt).length,
      cutByStop: results.filter((r) => r.status !== 'answered').map((r) => `${r.status}:${r.reason}`),
      afterStop: late.dropped ?? 'queued', stateAfterOffer: sidecar.status().state,
    }
    assert.equal(s.state, 'stopped')
    assert.equal(s.stoppedBecause, 'idle')
    assert.ok(m.idle.stoppedAfterMs >= 60_000 && m.idle.stoppedAfterMs <= 72_000, `stopped ${m.idle.stoppedAfterMs} ms after the last acting request`)
    assert.ok(m.idle.answered >= 3, 'shadow requests kept arriving and were answered while the minute ran')
    assert.ok(m.idle.cutByStop.every((x) => x === 'skipped:not_running'), 'a comparison the stop cut is a skip, never a failure')
    assert.equal(late.dropped, 'not_running', 'a shadow request finds Laya stopped')
    assert.equal(m.idle.stateAfterOffer, 'stopped', 'and never starts it')
  }

  // f. ensureReady starts it again, and it answers.
  {
    const t0 = Date.now()
    await sidecar.ensureReady()
    const a = await act.systemOne(ask(bodies.intent), { phase: 'intent' })
    m.afterIdle = { restartMs: since(t0), answered: !!a?.answers }
    assert.ok(a?.answers)
  }
})

// The settings as found, and this supervisor gone: one harness has one Laya, and the plugin's own
// supervisor takes it over for steps 6 and 7.
await sidecar.setSettings({ idleMinutes: 30 }).catch(() => {})
report.supervisor = { status: sidecar.status(), counters: client.counters(), logTail: sidecar.logTail(60) }
client.dispose()
await sidecar.dispose()

// --- 6 and 7: whole runs through the plugin, with KzH's own supervisor starting the real laya.serve ---
let host = null
await step('6', 'Jev Auto with the shadow: the run takes Jev\'s time, and the shadow rows land later', async (m) => {
  host = await bootPlugin({ harnessDir, dataDir: join(dataDir, 'plugin'), measuredFrom: paths.settings })
  const AGENT_MS = 500
  host.world.work = () => sleep(AGENT_MS)
  const started = await host.http('POST', '/jev-router/laya/start', {})
  assert.equal(started.status, 200, JSON.stringify(started.body))
  const run = async (shadow) => {
    await host.http('POST', '/jev-router/laya/settings', { shadow })
    host.resetWorkspace()
    const jevFrom = jev.calls.length
    const ranFrom = host.world.ran.length
    const wireFrom = net.seen.length
    const t0 = Date.now()
    const out = await host.say(TASK, { model: 'jev-auto' })
    const endAt = Date.now()
    const calls = jev.calls.slice(jevFrom)
    const agents = host.world.ran.slice(ranFrom)
    return {
      out, t0, endAt, ms: endAt - t0, wireFrom,
      jevCalls: calls.length, jevMs: calls.reduce((n, c) => n + (c.endAt - c.at), 0),
      agents: agents.length, agentMs: agents.reduce((n, a) => n + ((a.endAt ?? endAt) - a.at), 0),
    }
  }
  const off = await run(false)
  const on = await run(true)
  const runId = host.rows('history.jsonl').at(-1)?.runId
  m.off = { ms: off.ms, jevCalls: off.jevCalls, jevMs: off.jevMs, agentMs: off.agentMs }
  m.on = { ms: on.ms, jevCalls: on.jevCalls, jevMs: on.jevMs, agentMs: on.agentMs, otherMs: on.ms - on.jevMs - on.agentMs }
  assert.match(off.out.text, /^\*\*Jev router\*\* · AUTO/, off.out.text.slice(0, 200))
  assert.doesNotMatch(off.out.reasoning, /Laya/, 'with the switch off, nothing of Laya shows')
  assert.match(on.out.text, /^\*\*Jev router\*\* · AUTO/, on.out.text.slice(0, 200))
  assert.match(on.out.reasoning, /\nLaya is answering the same questions in the background; compare them in Jev → Decisions\n/)

  const layaRequests = () => net.seen.slice(on.wireFrom).filter((r) => r.url.startsWith('http://127.0.0.1:') && r.url.endsWith('/v1/systemone'))
  const rows = await until('every shadow row of the run has landed', async () => (await host.http('GET', `/jev-router/laya/shadow?runId=${runId}`)).body, (b) => b.rows.length >= on.jevCalls - 1 && b.waiting.length === 0, { timeoutMs: 400_000, everyMs: 1000 })
  const intentRow = host.rows('laya-shadow.jsonl').find((r) => r.phase === 'intent' && Date.parse(r.ts) >= on.t0)
  const all = [...rows.rows, ...(intentRow ? [intentRow] : [])]
  const lastAt = Math.max(...all.map((r) => Date.parse(r.ts)))
  const wire = layaRequests()
  m.shadow = {
    rows: all.map((r) => ({ phase: r.phase, status: r.status, reason: r.reason, requests: r.requests, rows: r.rows, queuedMs: r.queuedMs, ms: r.ms, landedAfterRunMs: Date.parse(r.ts) - on.endAt })),
    firstLayaRequestAfterStartMs: wire[0] ? wire[0].at - on.t0 : null, layaRequestsDuringRun: wire.filter((r) => r.at < on.endAt).length, layaRequests: wire.length,
    lastRowAfterRunMs: lastAt - on.endAt,
  }
  assert.ok(on.ms <= off.ms + 1000, `the run with the shadow took ${on.ms} ms, the run without it ${off.ms} ms`)
  assert.ok(m.shadow.layaRequestsDuringRun > 0, 'Laya was computing while the run went on')
  assert.ok(lastAt > on.endAt, 'the shadow rows landed after the run had returned')
  assert.ok(intentRow, 'the intent has its row, with no run id')
  assert.equal(rows.rows.length, on.jevCalls - 1, 'a row for every Jev call of the run')
  assert.ok(all.every((r) => r.status === 'answered'), JSON.stringify(all.map((r) => [r.phase, r.status, r.reason])))
  assert.ok(host.rows('usage.jsonl').every((u) => u.agent !== 'laya'), 'a shadow call is never a usage row')
})

await step('7', 'Laya Auto through the plugin: no TypeSafe contact, flat answers filled by the rules, held open for 2 minutes', async (m) => {
  assert.ok(host, 'the plugin booted in step 6')
  const AGENT_MS = 125_000
  await host.http('POST', '/jev-router/laya/settings', { idleMinutes: 1 })
  host.resetWorkspace()
  // The run's first agent works for over 2 minutes, twice the idle time; any later one (a second
  // review, a retry) finishes at once.
  const ranFrom = host.world.ran.length
  host.world.work = (_opts, n) => sleep(n === ranFrom + 1 ? AGENT_MS : 500)
  const seenFrom = net.seen.length
  const jevFrom = jev.calls.length
  const envFrom = sdkEnvReads.length
  const lineFrom = host.lines.length
  // Laya's state and interpreter through the run, every 2 s.
  const watch = []
  let watching = true
  const watcher = (async () => {
    while (watching) {
      const s = (await host.http('GET', '/jev-router/laya')).body
      watch.push({ at: Date.now(), state: s.state, pid: s.running?.pid ?? null, held: s.running?.held ?? [] })
      await sleep(2000)
    }
  })()
  const t0 = Date.now()
  let out
  try { out = await host.say(TASK, { model: 'laya-auto' }) } finally { watching = false; await watcher }
  const endAt = Date.now()
  const record = host.rows('history.jsonl').at(-1)
  const agent = host.world.ran[ranFrom]
  const text = `${out.reasoning}\n${out.text}`
  const heldWatch = watch.filter((w) => w.held.some((h) => h.startsWith('run:')))
  m.run = {
    ms: endAt - t0, heading: out.text.split('\n')[0], agents: host.world.ran.length - ranFrom, agentMs: agent?.endAt ? agent.endAt - agent.at : null,
    layaLines: out.reasoning.split('\n').filter((l) => /^Laya|^Starting Laya|^Waiting for Laya/.test(l)),
    filledLine: out.text.split('\n').find((l) => l.startsWith('- Filled by the routing rules')) ?? null,
    decider: record?.routing?.decider ?? null, model: record?.routing?.model ?? null, finalStatus: record?.finalStatus ?? null,
    reviews: (record?.assessments ?? []).map((a) => a.mode), deciderErrors: record?.routing?.deciderErrors ?? [],
  }
  m.typesafe = { requests: net.seen.slice(seenFrom).filter((r) => typesafe(r.url)).length, jevCalls: jev.calls.length - jevFrom, clientsWithoutBaseURL: sdkEnvReads.length - envFrom, otherHosts: [...new Set(net.seen.slice(seenFrom).map((r) => r.url).filter((u) => !u.startsWith('http://127.0.0.1:')).map((u) => new URL(u).host))] }
  m.hold = { heldPolls: heldWatch.length, pids: [...new Set(heldWatch.map((w) => w.pid))], statesWhileHeld: [...new Set(heldWatch.map((w) => w.state))], heldForMs: heldWatch.length ? heldWatch.at(-1).at - heldWatch[0].at : 0 }

  assert.match(out.text, /^\*\*Laya router\*\* · AUTO/, out.text.slice(0, 300))
  assert.match(out.reasoning, /Laya route: \d+\/\d+ questions in \d+ ms on the CPU/)
  assert.match(out.reasoning, /Laya route: \d+ answers? too flat to use \(.+\); the routing rules filled (it|them)/, 'the lines say the rules filled what Laya answered flat')
  assert.ok(m.run.filledLine, 'and so does the report')
  assert.doesNotMatch(text, /\bJev\b/, 'no line of a Laya Auto run mentions Jev')
  assert.equal(m.typesafe.requests, 0, 'no request reached a TypeSafe host')
  assert.equal(m.typesafe.jevCalls, 0, 'no TypeSafe client was asked anything')
  assert.equal(m.typesafe.clientsWithoutBaseURL, 0, 'no TypeSafe client was built without an explicit baseURL')
  assert.equal(record.routing.decider, 'laya')
  assert.match(record.routing.model, /^laya-english\/0\.3\.20@[0-9a-f]{7}$/)
  assert.ok(record.assessments.length && record.assessments.every((a) => a.mode === 'laya'), 'Laya reviewed every attempt')
  // 8, last item: an open Laya Auto run holds Laya past its 1-minute idle time.
  assert.ok(m.run.agentMs >= AGENT_MS, 'the agent worked for over 2 minutes')
  assert.ok(m.hold.heldForMs >= 120_000, `held for ${m.hold.heldForMs} ms`)
  assert.deepEqual(m.hold.statesWhileHeld, ['ready'], 'never stopped while held')
  assert.equal(m.hold.pids.length, 1, 'one interpreter for the whole run')
  // Let go when the run returned, it goes after its idle minute.
  const s = await until('Laya is stopped for being idle', async () => (await host.http('GET', '/jev-router/laya')).body, (b) => b.stoppedBecause === 'idle', { timeoutMs: 100_000, everyMs: 1000 })
  m.idleAfterRunMs = Date.now() - endAt
  assert.equal(s.state, 'stopped')
  m.pluginLines = host.lines.slice(lineFrom).map((l) => l.text).filter((l) => /\[jev\] laya:/.test(l))
  await host.http('POST', '/jev-router/laya/settings', { idleMinutes: 30 })
})
if (host) { report.plugin = { lines: host.lines.slice(-80).map((l) => l.text) }; await host.close() }

// --- 9. the render check: Laya's own build_sequence over every request KzH sends ---
await step('9', "render check with Laya's own build_sequence and the planted checkpoint's tokenizer", async (m) => {
  const r = await renderCheck({ harnessDir })
  Object.assign(m, {
    calls: r.calls, requests: r.requests, rows: r.rows, ms: r.ms, maxRowTokens: r.maxRowTokens, minStateRoom: r.minStateRoom, maxStateTokens: r.maxStateTokens, minSpareTokens: r.minSpareTokens,
    optionsCut: r.optionsCut.length, viewsCut: r.viewsCut.length, instructionsCut: r.headsCut.length, refused: r.refused.length,
    cuts: [...r.optionsCut, ...r.viewsCut, ...r.headsCut, ...r.refused].slice(0, 20),
  })
  assert.equal(r.refused.length, 0, 'Laya accepts every question')
  assert.equal(r.optionsCut.length, 0, 'no option of any KzH choice is cut')
  assert.equal(r.viewsCut.length, 0, 'no view is cut')
})

report.lines = lines.slice(-120)
report.finishedAt = new Date().toISOString()
writeFileSync(join(dataDir, 'e2e-report.json'), JSON.stringify(report, null, 2))
const failed = report.steps.filter((s) => s.ok === false)
console.log(`done: ${report.steps.filter((s) => s.ok).length} passed, ${failed.length} failed, ${report.steps.filter((s) => s.ok === null).length} not run; report in ${join(dataDir, 'e2e-report.json')}`)
process.exit(failed.length ? 1 : 0)

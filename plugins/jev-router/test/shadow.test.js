// The Laya shadow in Jev Auto (docs/laya-auto.md 5): it never delays or changes a Jev Auto run,
// pairs each Jev call with Laya's answer, records every skip, and writes numbers and nothing else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHADOW_CAP, createShadow } from '../shadow.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createDecisionEngine } from '../decision.js'
import { createJev } from '../jev.js'
import { createLayaClient } from '../laya-client.js'
import { createCapabilityRegistry, loadPriors } from '../profiles.js'
import { resolveProviders } from '../providers.js'
import { snapshotResources } from '../resources.js'
import { runRouted } from '../router.js'
import { resolvePolicy } from '../routing-policy.js'
import { compare, thresholdsHash } from '../shadow-stats.js'
import { startFakeLaya } from './fixtures/fake-laya-serve.mjs'
import { waitFor } from './wait-for.js'

const PROVIDERS = resolveProviders({}, {})
const { jev: JEV, laya: LAYA_RECORD } = PROVIDERS
const KEY = 'd'.repeat(48)
const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98'
const MARKER = 'QV-MARKER-51c9'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- a fake Jev and a stub Laya

/** One answer in TypeSafe's shape, the pick named where the run needs a sensible one. */
const PICKS = {
  taskType: 'implementation', skill: 'implementation', minimumCapability: 'standard', preferredCapability: 'strong',
  capability: 'project_change', handler: 'agent', verdict: 'accept', disposition: 'PASS', kind: 'task', depth: 'everyday',
}
const NOULS = { needsPerson: 0.05, humanReview: 0.1, needsTests: 0.9, secondOpinion: 0.2, addressed: 0.9, complete: 0.9, unrelatedChanges: 0.1, regressionRisk: 0.1, continueHandoff: 0.1 }
function jevAnswer(name, q) {
  if (q.type === 'noul') { const p = NOULS[name] ?? 0.3; return { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) } }
  if (q.type === 'score') {
    const p = q.criteria.map((_, i) => (i === 2 ? 0.6 : 0.4 / (q.criteria.length - 1)))
    return { type: 'score', score: p.reduce((s, x, i) => s + i * x, 0), probabilities: Object.fromEntries(p.map((x, i) => [String(i), x])), confidence: 0.6 }
  }
  const keys = Object.keys(q.criteria)
  const pick = keys.includes(PICKS[name]) ? PICKS[name] : name === 'strategy' && keys.includes('STANDARD_DIRECT') ? 'STANDARD_DIRECT' : keys[0]
  return { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])), confidence: 0.8 }
}
/** A Jev client that answers after `latencyMs`, keeping every body it was sent as JSON. */
function fakeJev({ latencyMs = 40, fail } = {}) {
  const bodies = []
  return {
    bodies,
    systemOne(body) {
      bodies.push(JSON.stringify(body))
      if (fail) return Promise.reject(fail)
      const answers = Object.fromEntries(Object.entries(body.questions).map(([n, q]) => [n, jevAnswer(n, q)]))
      return new Promise((r) => setTimeout(() => r({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers }), latencyMs))
    },
  }
}

/** Laya's normalised answers to a set of questions, as the Laya client hands them over. */
function layaAnswer(questions, { flat = [] } = {}) {
  const answers = {}
  for (const [name, q] of Object.entries(questions)) {
    const a = jevAnswer(`laya:${name}`, q)
    if (a.type === 'choice') { const keys = Object.keys(q.criteria); a.choice = keys.at(-1); a.probabilities = Object.fromEntries(keys.map((k, i) => [k, i === keys.length - 1 ? 0.7 : 0.3 / Math.max(1, keys.length - 1)])); a.confidence = 0.7 }
    answers[name] = { ...a, informative: !flat.includes(name), corrected: a.type === 'choice' && Object.keys(q.criteria).length >= 11, servedConfidence: 0.3 }
  }
  return {
    model: 'laya-english/0.3.20@fedcba9', answers, usage: { input_tokens: 500, output_tokens: 0 },
    meta: { provider: 'laya', device: 'cpu', waitedMs: 0, requests: 1, rows: Object.keys(questions).length, atContextLimit: 1, uninformative: flat, corrected: [], lang: 'latin', identity: 'laya-0.3.20|english|fedcba987654|adapter-1|corr:choice:11+=3.27|margin:0.1' },
  }
}

/** A Laya client stand-in that keeps each offer, so a test settles it when and how it likes. */
function stubLaya({ drop = null } = {}) {
  const offers = new Map()
  const withdrawn = []
  return {
    offers, withdrawn,
    identity: () => 'laya-0.3.20|english|fedcba987654|adapter-1|corr:choice:11+=3.27|margin:0.1',
    offerShadow(job) {
      const reason = typeof drop === 'function' ? drop(job) : drop
      if (reason) return { dropped: reason }
      offers.set(job.callId, job)
      return { queued: true }
    },
    withdraw(callId, reason) {
      withdrawn.push([callId, reason])
      const job = offers.get(callId)
      job?.onDone({ status: 'skipped', reason, queuedMs: 0, ms: 0 })
      return !!job
    },
    answer(callId, { flat } = {}) { const j = offers.get(callId); j.onDone({ status: 'answered', reason: null, answer: layaAnswer(j.questions, { flat }), queuedMs: 3, ms: 950 }) },
  }
}

/** The sidecar as the Laya client sees it: always ready, on the fake. */
const sidecarOn = (fake) => {
  const conn = { url: fake?.url ?? 'http://127.0.0.1:1', key: KEY, device: 'cpu', pid: 1 }
  return {
    isReady: () => true, connection: () => conn, ensureReady: async () => conn,
    noteResult: async () => ({}), setPriority: () => {}, restart: async () => {},
    status: () => ({ state: 'ready', installed: { laya: '0.3.20', weights: { commit: COMMIT } } }),
    installed: () => ({ laya: '0.3.20' }), readSettings: () => ({ measured: { cpu: { msPerToken: { intent: 1, route: 1, review: 1 } } } }),
  }
}

const tmp = (name) => mkdtempSync(join(tmpdir(), `kz-shadow-${name}-`))
const rowsIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// Calls as jev.js builds them, with a tool whose description and option keys the person wrote.
const TOOLS = [{ id: 'fmt', description: `Formats the code ${MARKER}`, params: { style: { question: 'Which style?', options: { [`${MARKER}_KEY`]: 'the marked style', plain: 'plain' } } } }]
const ATTEMPTS = [{ agent: 'claude', role: 'primary', stopReason: 'completed', answerText: `I fixed it. ${MARKER}`, changedFiles: ['state.txt'] }]
// The run's decision record: the review and retry picks are asked over its anonymous keys.
const candidate = (id, key, tier) => ({ id, key, tier, source: 'subscription', capabilities: { coding: { score: 0.8, confidence: 0.6, samples: 4 } }, marginalCost: 'low', expectedCost: { total: 0.2, class: 'low' }, latency: 'medium', availability: 'ok', reliability: { score: 0.8, confidence: 0.6 }, evidenceSamples: 4, fit: 0.7 })
const DECISION = { candidates: [candidate('claude', 'RESOURCE_A', 'frontier'), candidate('codex', 'RESOURCE_B', 'strong')], excluded: [] }
const REVIEW_INPUT = { task: `make the test pass ${MARKER}`, routing: { taskType: 'implementation', risk: 0.4, complexity: 0.5, decision: DECISION }, attempts: ATTEMPTS, checks: { results: [] }, diff: { stat: '1 file changed', patch: `+${MARKER}` }, agents: [{ id: 'claude', description: 'a' }, { id: 'codex', description: 'b' }] }

// ---------------------------------------------------------------- a Jev Auto run, with and without the shadow

const PRIORS = loadPriors(fileURLToPath(new URL('../../../config/capability-priors.json', import.meta.url)))
const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]
const modelOf = (a) => a.llm?.model ?? (a.provider === 'claude-code' ? 'claude-opus-5' : 'gpt-5.6')
const NOW = Date.parse('2026-09-22T10:00:00.000Z')
const CONFIG = {
  agents: AGENTS, tools: [], fallbackAgent: 'claude', agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 6 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: false, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [], effort: {},
}
const RUN = 'run-fixed-0001'

/** The same repository at the same path every time, so two runs see the same workspace. */
function freshRepo(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T00:00:00Z' }
  const g = (...a) => execFileSync('git', a, { cwd: dir, env })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
}

/** Two consecutive Jev Auto runs through the real router, decision engine and createJev. */
async function twoRuns(dir, { onCall } = {}) {
  freshRepo(dir)
  const policy = resolvePolicy()
  const profiles = createCapabilityRegistry({ file: join(dir, '..', `evidence-${Math.random()}.jsonl`), priors: PRIORS, policy })
  const engine = createDecisionEngine({ policy, domains: null, profiles, priors: PRIORS, store: null })
  const ready = Object.fromEntries(AGENTS.map((a) => [a.id, { installed: true, loggedIn: true, detail: 'ok' }]))
  const snapshots = snapshotResources({ agents: AGENTS, usage: {}, ready, config: {}, now: NOW, modelOf, policy })
  const client = fakeJev()
  const records = []
  for (const task of ['make the test pass', 'now tidy the fix']) {
    const jev = createJev({ provider: JEV, apiKey: 'k', client, ...(onCall ? { onCall } : {}) })
    const deps = {
      jev, runId: RUN, modelOf,
      execute: async () => { writeFileSync(join(dir, 'state.txt'), `fixed: ${task}`); return { stopReason: 'completed', answerText: `done: ${task}` } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      decide: (args) => engine.decide({ ...args, snapshots }),
    }
    records.push(await runRouted({ task, cwd: dir, config: CONFIG, deps }))
  }
  return { records, bodies: client.bodies }
}

/** A record with what differs between any two runs removed: its id, its times and its durations. */
function comparable(v) {
  if (Array.isArray(v)) return v.map(comparable)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['ts', 'runId', 'durationMs', 'ms'].includes(k)).map(([k, x]) => [k, comparable(x)]))
  return v
}

/** The shadow's hook, timed: every moment it spends on the run's own thread. */
function timed(onCall, spent) {
  return (arg) => {
    const t0 = performance.now()
    const settle = onCall(arg)
    spent.push(performance.now() - t0)
    return typeof settle === 'function' ? (x) => { const t1 = performance.now(); settle(x); spent.push(performance.now() - t1) } : settle
  }
}

test('a Jev Auto run is the same run with the shadow on, whatever Laya does, and waits for none of it', async (t) => {
  const dir = join(tmp('runs'), 'repo')
  const off = await twoRuns(dir)
  assert.equal(off.records[0].finalStatus, 'accepted')
  assert.ok(off.records[0].assessments.length >= 1, 'the run was reviewed, so the review call is shadowed too')
  assert.ok(off.bodies.length >= 6, 'route groups and reviews, in both runs')

  const garbage = () => Promise.resolve(new Response(JSON.stringify({ model: 'laya-rl-agent', answers: { nothing: 'useful' }, usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const variants = {
    'answers after 5 s': async (fake) => createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings }),
    throws: async () => ({ identity() { throw new Error('laya exploded') }, offerShadow() { throw new Error('laya exploded') }, withdraw() { throw new Error('laya exploded') } }),
    hangs: async (fake) => { fake.hang(); return createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings }) },
    'returns garbage': async (fake) => createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings, fetch: garbage }),
    'has an adapter that throws': async (fake) => createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings, adapter: { renderForLaya() { throw new Error('the adapter broke') } } }),
  }
  for (const [name, make] of Object.entries(variants)) {
    const fake = await startFakeLaya({ apiKey: KEY, msPerRow: 1250 })
    const laya = await make(fake)
    const file = join(tmp('file'), 'laya-shadow.jsonl')
    const shadow = createShadow({ file, laya, providers: PROVIDERS, now: () => NOW })
    const spent = []
    try {
      const on = await twoRuns(dir, { onCall: timed(shadow.offerer({ runId: RUN }), spent) })
      assert.deepEqual(comparable(on.records), comparable(off.records), `${name}: the record is the run without the shadow`)
      assert.deepEqual(on.bodies, off.bodies, `${name}: Jev was sent byte-identical bodies`)
      assert.equal(spent.length, 2 * off.bodies.length, `${name}: every Jev call was offered and settled`)
      const total = spent.reduce((a, b) => a + b, 0)
      assert.ok(total < 50, `${name}: the shadow spent ${total.toFixed(1)} ms on the run's thread`)
      if (name === 'answers after 5 s' || name === 'hangs') {
        assert.ok(fake.requests.length >= 1, `${name}: Laya was being asked`)
        assert.ok(fake.requests.every((r) => r.finishedAt == null), `${name}: both runs ended before Laya answered anything`)
        assert.deepEqual(shadow.read({}), [], `${name}: no comparison had landed`)
        assert.equal(shadow.waiting({ runId: RUN }).length, off.bodies.length, `${name}: every call is waiting for Laya`)
      } else {
        await waitFor(`${name}: a row per call`, () => shadow.read({ runId: RUN }).length, (n) => n === off.bodies.length)
        assert.ok(shadow.read({ runId: RUN }).every((r) => r.status === 'failed'), `${name}: every row failed, and nothing else did`)
      }
    } finally {
      laya.dispose?.()
      await fake.close()
    }
  }
})

// ---------------------------------------------------------------- pairing, skips, and failed Jev calls

test('a row pairs Jev\'s answer and Laya\'s by call id, in either order they arrive', async () => {
  const laya = stubLaya()
  const file = join(tmp('pair'), 'laya-shadow.jsonl')
  const shadow = createShadow({ file, laya, providers: PROVIDERS })
  const jevA = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 30 }), onCall: shadow.offerer({ runId: 'r1' }) })
  const first = jevA.intent({ message: 'first message' })
  const second = jevA.intent({ message: 'second message' })
  const [idA, idB] = [...laya.offers.keys()]
  // Laya answers the first before Jev does; Jev answers the second before Laya does.
  laya.answer(idA)
  await Promise.all([first, second])
  await sleep(10)
  assert.equal(shadow.read({}).length, 1, 'the second waits for Laya')
  assert.deepEqual(shadow.waiting({}), [{ callId: idB, phase: 'intent' }])
  laya.answer(idB, { flat: ['depth'] })
  await shadow.flush()
  const rows = shadow.read({})
  assert.deepEqual(rows.map((r) => r.callId).sort(), [idA, idB].sort())
  for (const r of rows) {
    assert.equal(r.status, 'answered')
    assert.equal(r.runId, null, 'an intent row carries no run id')
    assert.deepEqual(Object.keys(r.jev.questions), ['kind', 'depth', 'alsoWork'])
    assert.deepEqual(Object.keys(r.laya.questions), ['kind', 'depth', 'alsoWork'])
    assert.equal(r.jev.questions.kind.answer, 'task')
    assert.equal(r.laya.questions.kind.answer, 'question')
    assert.deepEqual(r.jev.questions.kind.p, [0.8, 0.2])
    assert.equal(r.jev.model, 'jev-1.13.0')
    assert.equal(r.jev.host, 'api.typesafe.ai')
    assert.equal(r.identity, 'laya-0.3.20|english|fedcba987654|adapter-1|corr:choice:11+=3.27|margin:0.1')
  }
  const b = rows.find((r) => r.callId === idB)
  assert.equal(b.laya.questions.depth.informative, false)
  assert.equal(b.atContextLimit, 1)
  assert.deepEqual(shadow.rowOf(idA).callId, idA)
  assert.deepEqual(rowsIn(file).map((r) => r.callId).sort(), [idA, idB].sort())
  assert.equal(shadow.counters().answered, 2)
})

test('every skip reason is recorded and counted, and a failed Laya call too', async () => {
  const reasons = ['not_running', 'starting', 'queue_full', 'yielded']
  let n = 0
  const laya = stubLaya({ drop: () => reasons[n++] ?? null })
  const file = join(tmp('skips'), 'laya-shadow.jsonl')
  const shadow = createShadow({ file, laya, providers: PROVIDERS })
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 1 }), onCall: shadow.offerer({ runId: 'r' }) })
  for (let i = 0; i < 4; i++) await jev.intent({ message: `m${i}` })
  // Offered: one ages out in the queue, one fails on Laya's side, one is withdrawn by a failed Jev call.
  const aged = jev.intent({ message: 'aged' })
  const broken = jev.intent({ message: 'broken' })
  const [idAged, idBroken] = [...laya.offers.keys()]
  laya.offers.get(idAged).onDone({ status: 'skipped', reason: 'too_old', queuedMs: 600_000, ms: 0 })
  laya.offers.get(idBroken).onDone({ status: 'failed', reason: 'LAYA_HTTP_500', queuedMs: 1, ms: 20 })
  await Promise.all([aged, broken])
  const failing = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ fail: Object.assign(new Error('Jev is down'), { status: 503 }) }), onCall: shadow.offerer({ runId: 'r' }) })
  await assert.rejects(failing.intent({ message: 'jev fails' }))
  await shadow.flush()
  const rows = shadow.read({})
  const why = rows.map((r) => [r.status, r.reason]).sort()
  assert.deepEqual(why, [['failed', 'LAYA_HTTP_500'], ...[...reasons, 'too_old', 'jev_failed'].map((r) => ['skipped', r])].sort())
  assert.deepEqual(shadow.counters(), { answered: 0, partial: 0, skipped: { not_running: 1, starting: 1, queue_full: 1, too_old: 1, jev_failed: 1, yielded: 1 }, failed: 1 })
  const failedJev = rows.find((r) => r.reason === 'jev_failed')
  assert.deepEqual(failedJev.jev.error, { class: 'Error', code: null, status: 503 })
  assert.deepEqual(failedJev.laya.questions, {})
  assert.equal(rowsIn(file).length, 7)
})

test('a failed Jev call withdraws its job, and a 429 that is rotated and repeated yields one compared row', async (t) => {
  const fake = await startFakeLaya({ apiKey: KEY, msPerRow: 5 })
  const laya = createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings })
  t.after(async () => { laya.dispose(); await fake.close() })
  const file = join(tmp('rotate'), 'laya-shadow.jsonl')
  const shadow = createShadow({ file, laya, providers: PROVIDERS })
  const offer = shadow.offerer({ runId: 'r-429' })
  const limited = Object.assign(new Error('429 rate limited'), { status: 429 })
  // makeJev's rotation: the call fails on the first key and is repeated on a new client.
  const onFirstKey = createJev({ provider: JEV, apiKey: 'k1', client: fakeJev({ fail: limited }), onCall: offer })
  await assert.rejects(onFirstKey.assess(REVIEW_INPUT, new AbortController().signal, { attempt: 0, risk: 0.4, blockAccept: false, reviewed: false }))
  const onSecondKey = createJev({ provider: JEV, apiKey: 'k2', client: fakeJev(), onCall: offer })
  await onSecondKey.assess(REVIEW_INPUT, new AbortController().signal, { attempt: 0, risk: 0.4, blockAccept: false, reviewed: false })
  await waitFor('both rows', () => shadow.read({ runId: 'r-429' }).length, (n) => n === 2, { timeoutMs: 5000 })
  const rows = shadow.read({ runId: 'r-429' })
  assert.deepEqual(rows.map((r) => r.status).sort(), ['answered', 'skipped'])
  assert.equal(rows.find((r) => r.status === 'skipped').reason, 'jev_failed')
  assert.equal(rows.filter((r) => r.status === 'answered' || r.status === 'partial').length, 1, 'one compared row')
  const requests = fake.requests.length
  const perCall = rows.find((r) => r.status === 'answered').requests
  assert.equal(requests, perCall, 'the withdrawn job never reached Laya')
})

// ---------------------------------------------------------------- what a row holds

test('a review row carries the context numbers, a tool parameter\'s answer is its index, and no text is written', async (t) => {
  const fake = await startFakeLaya({ apiKey: KEY, msPerRow: 1 })
  const laya = createLayaClient({ sidecar: sidecarOn(fake), settings: PROVIDERS.layaSettings })
  t.after(async () => { laya.dispose(); await fake.close() })
  const file = join(tmp('text'), 'laya-shadow.jsonl')
  const events = []
  const lines = []
  const shadow = createShadow({ file, laya, providers: PROVIDERS, onRow: (row) => events.push({ type: 'shadow', row }), log: (m) => lines.push(m) })
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 5 }), onCall: shadow.offerer({ runId: 'r-text' }) })
  await jev.route({ task: `Format utils.js ${MARKER}`, context: { gitRepo: true, branch: MARKER }, tools: TOOLS, handoff: `Earlier: ${MARKER}` })
  await jev.assess(REVIEW_INPUT, new AbortController().signal, { attempt: 2, risk: 0.37, blockAccept: true, reviewed: false, note: MARKER })
  await jev.intent({ message: `What is ${MARKER}?` })
  await waitFor('three rows', () => shadow.read({}).length, (n) => n === 3, { timeoutMs: 5000 })
  await shadow.flush()
  const [route] = shadow.read({ runId: 'r-text' }).filter((r) => r.phase === 'route')
  const [review] = shadow.read({ runId: 'r-text' }).filter((r) => r.phase === 'review')
  const [intent] = shadow.read({}).filter((r) => r.phase === 'intent')
  assert.equal(route.status, 'answered')
  assert.deepEqual(route.groups, ['task'])
  assert.equal(route.attempt, null)
  assert.equal(route.review, null)
  assert.match(route.jev.questions['fmt.style'].answer, /^#[01]$/)
  assert.match(route.laya.questions['fmt.style'].answer, /^#[01]$/)
  assert.equal(route.jev.questions['fmt.style'].p.length, 2)
  assert.equal(route.jev.questions.taskType.p.length, 12)
  assert.equal(route.laya.questions.taskType.corrected, true)
  assert.equal(review.attempt, 2)
  assert.deepEqual(review.review, { risk: 0.37, blockAccept: true, reviewed: false })
  for (const side of ['jev', 'laya']) {
    assert.match(review[side].questions.reviewAgent.answer, /^RESOURCE_[AB]$/, 'the anonymous key, as asked')
    assert.match(review[side].questions.retryAgent.answer, /^RESOURCE_[AB]$/)
  }
  assert.equal(intent.runId, null)
  assert.equal(route.device, 'cpu')
  assert.equal(route.lang, 'latin')
  assert.equal(route.identity, `laya-0.3.20|english|${COMMIT.slice(0, 12)}|adapter-1|corr:choice:11+=3.27|margin:0.1`)
  assert.deepEqual(route.thresholds, { jev: thresholdsHash(JEV.thresholds), laya: thresholdsHash(LAYA_RECORD.thresholds) })
  const text = readFileSync(file, 'utf8')
  assert.equal(text.includes(MARKER), false, 'no task, answer, tool description or tool option key reaches the file')
  assert.equal(JSON.stringify(events).includes(MARKER), false)
  assert.equal(events.length, 3)
  assert.equal(lines.some((l) => l.includes(MARKER)), false)
  assert.ok(lines.some((l) => /^Laya shadow route: \d+ answered in \d+ ms, \d+\/\d+ agree with Jev$/.test(l)), lines.join('\n'))
})

test('each route call records the groups it asked, and only the judgments group\'s second opinion teaches second_opinion', async () => {
  const laya = stubLaya()
  const shadow = createShadow({ file: join(tmp('groups'), 'laya-shadow.jsonl'), laya, providers: PROVIDERS })
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 1 }), onCall: shadow.offerer({ runId: 'r-groups' }) })
  // The candidates as decision.js sends them: anonymous, their keys and properties only.
  const candidates = DECISION.candidates.map(({ id, ...c }) => c)
  const strategies = ['CHEAP_DIRECT', 'STANDARD_DIRECT']
  // The decision engine's two calls (decision.js askJev): the task group, then the resource call
  // with both of its groups open, and later with only the judgments group's noul still open.
  await jev.route({ task: 'Rename foo to bar', ask: { task: true, resource: false, judgments: false } })
  await jev.route({ task: 'Rename foo to bar', candidates, strategies, ask: { task: false, resource: true, judgments: true } })
  await jev.route({ task: 'Rename foo to bar', candidates, strategies, ask: { task: false, resource: false, judgments: true } })
  // The legacy named-agent call, with adaptive routing off (router.js): the task group and the agent pick.
  await jev.route({ task: 'Rename foo to bar', agents: AGENTS })
  for (const callId of laya.offers.keys()) laya.answer(callId)
  await shadow.flush()
  const rows = shadow.read({ runId: 'r-groups' })
  assert.deepEqual(rows.map((r) => r.groups), [['task'], ['resource', 'judgments'], ['judgments'], ['task']])
  assert.deepEqual(Object.keys(rows[2].jev.questions), ['secondOpinion'])
  for (const r of [rows[0], rows[3]]) assert.ok(r.jev.questions.secondOpinion, 'a task-group call carries the profile\'s second opinion')
  assert.ok(rows[3].jev.questions.agent)
  // The comparison reads second_opinion from the two judgments calls and from neither task-group call.
  const cmp = compare({ shadowRows: rows, identity: laya.identity(), thresholds: { jev: JEV.thresholds, laya: LAYA_RECORD.thresholds }, scope: 'all', days: 'all' })
  assert.deepEqual(cmp.domains.find((d) => d.domain === 'second_opinion').agree.all, { n: 2, agree: 2 })
  assert.deepEqual(cmp.actions.wouldHaveActedSame.find((w) => w.what === 'second_opinion'), { what: 'second_opinion', n: 2, same: 2 })
})

test('with learning off, the shadow asks Laya nothing and writes nothing', async () => {
  const laya = stubLaya()
  const file = join(tmp('off'), 'laya-shadow.jsonl')
  let enabled = false
  const shadow = createShadow({ file, laya, providers: PROVIDERS, enabled: () => enabled })
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 1 }), onCall: shadow.offerer({ runId: 'r' }) })
  await jev.intent({ message: 'hello' })
  await jev.route({ task: 'do it' })
  await shadow.flush()
  assert.equal(laya.offers.size, 0)
  assert.equal(existsSync(file), false)
  assert.deepEqual(shadow.read({}), [])
  enabled = true
  await jev.intent({ message: 'hello again' })
  assert.equal(laya.offers.size, 1, 'the switch is read on every call')
})

// ---------------------------------------------------------------- the file

/** A route row of about the real size: twenty questions with their probabilities. */
function bigRow(i) {
  const q = Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`q${k}`, { type: 'choice', answer: 'x', p: [0.412, 0.188, 0.2, 0.1, 0.05, 0.05], confidence: 0.412, informative: true, corrected: false }]))
  return { id: `row-${i}`, ts: new Date(NOW + i).toISOString(), runId: `run-${i}`, callId: `call-${i}`, phase: 'route', groups: ['task'], attempt: null, review: null, identity: 'id', device: 'cpu', lang: 'latin', thresholds: { jev: 'a', laya: 'b' }, status: 'answered', reason: null, queuedMs: 1, ms: 900, rows: 20, requests: 5, atContextLimit: 0, jev: { model: 'jev-1.13.0', host: 'api.typesafe.ai', ms: 800, error: null, questions: q }, laya: { questions: q } }
}

test('on a file at the cap, the rows of a run are read from memory in well under 20 ms, and the file keeps its newest rows', async () => {
  assert.equal(SHADOW_CAP, 10_000)
  const file = join(tmp('cap'), 'laya-shadow.jsonl')
  writeFileSync(file, Array.from({ length: SHADOW_CAP }, (_, i) => `${JSON.stringify(bigRow(i))}\n`).join(''))
  const laya = stubLaya({ drop: 'not_running' })
  const shadow = createShadow({ file, laya, providers: PROVIDERS, slack: 1 })
  await shadow.loaded()
  const t0 = performance.now()
  const rows = shadow.read({ runId: `run-${SHADOW_CAP - 1}` })
  const took = performance.now() - t0
  assert.ok(took < 20, `read took ${took.toFixed(2)} ms`)
  assert.equal(rows.length, 1)
  assert.equal(shadow.read({ runId: 'run-5' }).length, 0, 'only the newest rows are read into memory at start')
  assert.equal(shadow.read({}).length, 2000)

  // Three more rows push the file past its cap: it is rewritten with its newest 10,000.
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 1 }), onCall: shadow.offerer({ runId: 'late' }) })
  for (let i = 0; i < 3; i++) await jev.intent({ message: `late ${i}` })
  await waitFor('three late rows in memory', () => shadow.read({}).length, (n) => n === 2003)
  await shadow.flush()
  const kept = rowsIn(file)
  assert.equal(kept.length, SHADOW_CAP)
  assert.equal(kept[0].id, 'row-3', 'the three oldest went')
  assert.deepEqual(kept.slice(-3).map((r) => r.status), ['skipped', 'skipped', 'skipped'])
  assert.equal(existsSync(`${file}.tmp`), false)
})

test('the comparison is computed off the main thread and reused for a minute or a hundred rows', async () => {
  let now = NOW
  const laya = stubLaya({ drop: 'starting' })
  const file = join(tmp('cmp'), 'laya-shadow.jsonl')
  const shadow = createShadow({ file, laya, providers: PROVIDERS, now: () => now })
  const jev = createJev({ provider: JEV, apiKey: 'k', client: fakeJev({ latencyMs: 0 }), onCall: shadow.offerer({ runId: 'r' }) })
  await jev.intent({ message: 'one' })
  await shadow.flush()
  const first = await shadow.compare({ days: 'all' })
  assert.equal(first.skips.skipped.starting, 1)
  assert.equal(await shadow.compare({ days: 'all' }), first, 'reused')
  for (let i = 0; i < 99; i++) await jev.intent({ message: `m${i}` })
  await shadow.flush()
  assert.equal(await shadow.compare({ days: 'all' }), first, 'still reused after 99 rows')
  await jev.intent({ message: 'the hundredth' })
  await shadow.flush()
  const second = await shadow.compare({ days: 'all' })
  assert.notEqual(second, first)
  assert.equal(second.skips.skipped.starting, 101)
  now += 61_000
  assert.notEqual(await shadow.compare({ days: 'all' }), second, 'a minute later it is computed again')
})

// Test Laya and the warm-up probe (docs/laya-auto.md 4.6, 7.5). The fake laya.serve they run
// against is tested in fixtures.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { PAIR_NOULS, SEPARATION, createProbe, runSelfTest, selfTestCalls, selfTestLine, warmUpCalls } from '../laya-selfcheck.js'
import { estimateRequestTokens, renderForLaya } from '../laya-questions.js'
import { defaultAnswer, startFakeLaya } from './fixtures/fake-laya-serve.mjs'

const IDENTITY = 'laya-0.3.20|english|0123456789ab|adapter-1|corr:choice:11+=3.27|margin:0.1'

// ---------------------------------------------------------------- the fixed calls

test('the fixed calls are KzH\'s own shapes, built by the jev.js builders without sending anything', () => {
  const realFetch = globalThis.fetch
  const realSystemOne = TypeSafeClient.prototype.systemOne
  let fetched = 0
  globalThis.fetch = async () => { fetched++; throw new Error('no network in a capture') }
  let calls
  try { calls = selfTestCalls() } finally { globalThis.fetch = realFetch }
  assert.equal(fetched, 0, 'building a call sends nothing')
  assert.equal(TypeSafeClient.prototype.systemOne, realSystemOne, 'the SDK is left as it was')

  const { protocol, pairs } = calls
  assert.deepEqual(protocol.map((c) => [c.name, c.phase]), [['intent.task', 'intent'], ['intent.question', 'intent'], ['route', 'route'], ['review', 'review']])
  assert.equal(protocol[0].state.message, 'Fix the failing test in src/parser.ts')
  assert.equal(protocol[1].state.message, 'What does the --fit flag in llama.cpp do?')
  assert.deepEqual(Object.keys(protocol[0].questions), ['kind', 'depth', 'alsoWork'])
  assert.equal(protocol[2].state.task, 'Rename the variable foo to bar in utils.js')
  assert.ok(protocol[2].questions.taskType && protocol[2].questions['req.coding'])
  assert.equal(Object.keys(protocol[2].questions.capability.criteria).length, 11, 'every capability offered, as KzH does')
  assert.deepEqual(Object.keys(protocol[3].questions), ['verdict', 'disposition', 'addressed', 'complete', 'unrelatedChanges', 'regressionRisk', 'needsPerson', 'reviewAgent', 'retryAgent'])
  assert.deepEqual(Object.keys(protocol[3].questions.reviewAgent.criteria), ['RESOURCE_A', 'RESOURCE_B', 'RESOURCE_C'], 'the review picks over the anonymous table')
  assert.equal(protocol[3].state.attempts.at(-1).resource, 'RESOURCE_A')

  assert.deepEqual(PAIR_NOULS, ['alsoWork', 'needsPerson', 'unrelatedChanges', 'addressed', 'complete', 'continueHandoff', 'humanReview'])
  assert.deepEqual(pairs.map((p) => p.name), PAIR_NOULS)
  for (const p of pairs) {
    for (const side of ['yes', 'no']) {
      assert.deepEqual(Object.keys(p[side].questions), [p.name], `${p.name} ${side}: that one question alone`)
      assert.equal(p[side].questions[p.name].type, 'noul')
      assert.equal(p[side].phase, p.phase)
    }
    assert.notDeepEqual(p.yes.state, p.no.state)
  }
  assert.equal(pairs.find((p) => p.name === 'continueHandoff').yes.state.handoff.includes('parser refactor'), true)
  assert.equal(SEPARATION, 0.2)

  const warm = warmUpCalls()
  assert.deepEqual(warm, protocol.slice(0, 2), 'always the two intent probes')
  const full = warmUpCalls({ full: true })
  assert.deepEqual(full.map((c) => c.name), ['intent.task', 'intent.question', 'route.maximal', 'review.maximal'])
  const [, , route, review] = full
  assert.ok(route.questions.continueHandoff && route.questions.handler && route.questions['format_code.fits'] && route.questions['bump_version.level'])
  assert.equal(Object.keys(review.questions.reviewAgent.criteria).length, 8)
  for (const c of full) for (const r of renderForLaya(c)) assert.ok(JSON.stringify(r.state).length <= 950)
})

// ---------------------------------------------------------------- Test Laya

/** What the fake answers for each probe: P(true) per pair side, and P(task) per intent. */
function planned(plan, kind) {
  const byState = new Map()
  for (const p of selfTestCalls().pairs) {
    for (const side of ['yes', 'no']) byState.set(`${p.name}|${JSON.stringify(renderForLaya(p[side])[0].state)}`, plan[p.name][side])
  }
  return (name, question, state) => {
    const pTrue = byState.get(`${name}|${JSON.stringify(state)}`)
    if (question.type === 'noul' && pTrue !== undefined) return [1 - pTrue, pTrue]
    if (name === 'kind' && kind[state.message] !== undefined) return [kind[state.message], 1 - kind[state.message]]
    return defaultAnswer(name, question, state)
  }
}

test('seven noul pairs and the kind pair are reported apart, with the direction of each miss', async (t) => {
  const plan = {
    alsoWork: { yes: 0.9, no: 0.1 },
    needsPerson: { yes: 0.3, no: 0.2 }, // the #156 pattern: the clear yes answered no
    unrelatedChanges: { yes: 0.8, no: 0.7 }, // the opposite bias: the clear no answered yes
    addressed: { yes: 0.4, no: 0.6 }, // both
    complete: { yes: 0.55, no: 0.45 }, // too close, in neither direction
    continueHandoff: { yes: 0.95, no: 0.05 },
    humanReview: { yes: 0.7, no: 0.3 },
  }
  const fake = await startFakeLaya({ apiKey: 'start-key', answer: planned(plan, { 'Fix the failing test in src/parser.ts': 0.8, 'What does the --fit flag in llama.cpp do?': 0.3 }) })
  t.after(() => fake.close())
  let clock = 0
  const probe = createProbe({ url: fake.url, key: 'start-key', device: 'cpu' }, { now: () => (clock += 100) })
  const result = await probe.selfTest({ identity: IDENTITY })
  assert.equal(result.error, null)
  assert.deepEqual(result.protocol, { ok: true, problems: [] })
  assert.equal(result.identity, IDENTITY)
  assert.equal(result.device, 'cpu')
  assert.deepEqual(result.timings, { intent: 100, route: 100, review: 100 })
  assert.deepEqual(result.kind, { task: 0.8, question: 0.3, separates: true })
  assert.deepEqual(result.pairs, [
    { name: 'alsoWork', yes: 0.9, no: 0.1, separates: true, noOnYes: false, yesOnNo: false },
    { name: 'needsPerson', yes: 0.3, no: 0.2, separates: false, noOnYes: true, yesOnNo: false },
    { name: 'unrelatedChanges', yes: 0.8, no: 0.7, separates: false, noOnYes: false, yesOnNo: true },
    { name: 'addressed', yes: 0.4, no: 0.6, separates: false, noOnYes: true, yesOnNo: true },
    { name: 'complete', yes: 0.55, no: 0.45, separates: false, noOnYes: false, yesOnNo: false },
    { name: 'continueHandoff', yes: 0.95, no: 0.05, separates: true, noOnYes: false, yesOnNo: false },
    { name: 'humanReview', yes: 0.7, no: 0.3, separates: true, noOnYes: false, yesOnNo: false },
  ])
  assert.equal(selfTestLine(result), 'Test Laya (model 0123456): protocol ok. On the CPU: intent 100 ms, routing 100 ms, review 100 ms. '
    + '3 of 7 yes/no questions separate; needsPerson, unrelatedChanges, addressed and complete do not '
    + '(2 answered no to the clear yes, the pattern of Laya issue #156; 2 answered yes to the clear no). Task or question: separates.')
  // Every probe went to this start's server with this start's key, pinned to English.
  assert.ok(fake.requests.length >= 4 + 14)
  assert.ok(fake.requests.every((r) => r.authorization === 'Bearer start-key' && r.body.model === 'english' && r.status === 200))
  // A pair is asked alone: one question, in one request.
  assert.equal(fake.requests.filter((r) => Object.keys(r.body.questions).length === 1 && 'needsPerson' in r.body.questions).length, 3)
})

test('a pair that differs by exactly 0.2 separates, whatever floating point makes of 0.7 - 0.5', async (t) => {
  // Laya answers in 4 decimals, so these are ordinary answers; 0.7 - 0.5 is 0.19999999999999996.
  const plan = {
    alsoWork: { yes: 0.7, no: 0.5 },
    needsPerson: { yes: 0.6, no: 0.4 },
    unrelatedChanges: { yes: 0.9, no: 0.7 },
    addressed: { yes: 0.6999, no: 0.5 }, // just under
    complete: { yes: 0.8, no: 0.6 },
    continueHandoff: { yes: 0.3, no: 0.1 },
    humanReview: { yes: 0.55, no: 0.35 },
  }
  const fake = await startFakeLaya({ answer: planned(plan, { 'Fix the failing test in src/parser.ts': 0.6, 'What does the --fit flag in llama.cpp do?': 0.4 }) })
  t.after(() => fake.close())
  const result = await createProbe({ url: fake.url, key: 'k', device: 'cpu' }).selfTest({ identity: IDENTITY })
  assert.equal(result.error, null)
  assert.deepEqual(result.pairs.map((p) => [p.name, p.yes, p.no, p.separates]), PAIR_NOULS.map((name) => [name, plan[name].yes, plan[name].no, name !== 'addressed']))
  assert.deepEqual(result.kind, { task: 0.6, question: 0.4, separates: true })
  assert.match(selfTestLine(result), /ms\. 6 of 7 yes\/no questions separate; addressed does not\. Task or question: separates\.$/)
})

test('the card text for all, some and no pairs separating', () => {
  const pairs = (f) => PAIR_NOULS.map((name, i) => ({ name, ...f(name, i) }))
  const base = { identity: IDENTITY, device: 'cuda', protocol: { ok: true, problems: [] }, timings: { intent: 120, route: 950, review: 800 }, kind: { task: 0.9, question: 0.1, separates: true }, error: null }
  const all = { ...base, pairs: pairs(() => ({ yes: 0.9, no: 0.1, separates: true, noOnYes: false, yesOnNo: false })) }
  assert.equal(selfTestLine(all), 'Test Laya (model 0123456): protocol ok. On the GPU: intent 120 ms, routing 950 ms, review 800 ms. 7 of 7 yes/no questions separate. Task or question: separates.')
  const one = { ...base, pairs: pairs((name) => (name === 'needsPerson' ? { yes: 0.2, no: 0.1, separates: false, noOnYes: true, yesOnNo: false } : { yes: 0.9, no: 0.1, separates: true, noOnYes: false, yesOnNo: false })) }
  assert.equal(selfTestLine(one), 'Test Laya (model 0123456): protocol ok. On the GPU: intent 120 ms, routing 950 ms, review 800 ms. '
    + '6 of 7 yes/no questions separate; needsPerson does not (1 answered no to the clear yes, the pattern of Laya issue #156). Task or question: separates.')
  const some = { ...base, device: 'cpu', pairs: pairs((name, i) => (i < 4 ? { yes: 0.6, no: 0.7, separates: false, noOnYes: false, yesOnNo: true } : { yes: 0.9, no: 0.1, separates: true, noOnYes: false, yesOnNo: false })) }
  assert.equal(selfTestLine(some), 'Test Laya (model 0123456): protocol ok. On the CPU: intent 120 ms, routing 950 ms, review 800 ms. '
    + '3 of 7 yes/no questions separate; alsoWork, needsPerson, unrelatedChanges and addressed do not (4 answered yes to the clear no). Task or question: separates.')
  // Random weights: the protocol passes and nothing separates, which is what the cloud run shows.
  const none = { ...base, device: 'cpu', kind: { task: 0.51, question: 0.49, separates: false }, pairs: pairs(() => ({ yes: 0.52, no: 0.51, separates: false, noOnYes: false, yesOnNo: false })) }
  assert.equal(selfTestLine(none), 'Test Laya (model 0123456): protocol ok. On the CPU: intent 120 ms, routing 950 ms, review 800 ms. '
    + '0 of 7 yes/no questions separate; alsoWork, needsPerson, unrelatedChanges, addressed, complete, continueHandoff and humanReview do not. Task or question: does not separate.')
  assert.equal(selfTestLine({ identity: null, protocol: { ok: false, problems: [] }, timings: null, pairs: [], kind: null, error: 'route: 500 inference failed' }),
    'Test Laya (model unknown): protocol failed (route: 500 inference failed).')
  assert.equal(selfTestLine({ ...all, protocol: { ok: false, problems: ['review: verdict confidence 1.2 is not in [0, 1]'] } }),
    'Test Laya (model 0123456): protocol failed (review: verdict confidence 1.2 is not in [0, 1]). On the GPU: intent 120 ms, routing 950 ms, review 800 ms. 7 of 7 yes/no questions separate. Task or question: separates.')
})

test('runSelfTest over any client: a failure stops it with the reason, a slow call or a bad answer fails the protocol', async () => {
  const answering = (patch = () => ({})) => async ({ questions }) => ({
    answers: Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, {
      ...(q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i, all) => [k, 1 / all.length])) }
        : q.type === 'score' ? { type: 'score', score: 2, probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2 } } : { type: 'noul', noul: 0.5 }),
      confidence: 0.5, ...patch(n, q),
    }])),
  })
  const ok = await runSelfTest(answering(), { device: 'cuda', identity: IDENTITY })
  assert.equal(ok.protocol.ok, true)
  assert.equal(ok.pairs.length, 7)
  assert.ok(ok.pairs.every((p) => !p.separates && !p.noOnYes && !p.yesOnNo))

  const seen = []
  const failing = await runSelfTest(async (call, { phase }) => { seen.push(phase); if (phase === 'route') throw Object.assign(new Error('timed out after 42 s'), { code: 'LAYA_TIMEOUT' }); return answering()(call) })
  assert.equal(failing.error, 'route: timed out after 42 s')
  assert.equal(failing.protocol.ok, false)
  assert.deepEqual(failing.pairs, [])
  assert.equal(failing.timings, null)
  assert.deepEqual(seen, ['intent', 'intent', 'route'], 'nothing is asked after a failure')

  let clock = 0
  const slow = await runSelfTest(answering(), { now: () => (clock += 5000), deadlineMs: (phase) => (phase === 'review' ? 4000 : 60000) })
  assert.equal(slow.protocol.ok, false)
  assert.ok(slow.protocol.problems.includes('review: took 5000 ms, over its 4000 ms deadline'), slow.protocol.problems.join('; '))

  const bad = await runSelfTest(answering((n) => (n === 'verdict' ? { confidence: 1.2 } : n === 'depth' ? { type: 'noul' } : n === 'skill' ? { choice: 'juggling' }
    : n === 'risk' ? { probabilities: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.1, 4: 0.1 } } : {})))
  assert.equal(bad.protocol.ok, false)
  assert.ok(bad.protocol.problems.includes('review: verdict confidence 1.2 is not in [0, 1]'))
  assert.ok(bad.protocol.problems.includes('intent.task: depth was answered as a noul, asked as a choice'))
  assert.ok(bad.protocol.problems.includes('route: skill chose juggling, which was not offered'))
  assert.ok(bad.protocol.problems.includes('route: risk probabilities do not sum to 1'), 'they sum to 0.8')
  const missing = await runSelfTest(async (call) => { const r = await answering()(call); delete r.answers.alsoWork; return r })
  assert.ok(missing.protocol.problems.includes('intent.task: alsoWork was not answered'))
})

test('a failure among the pairs fails the protocol too, and the card leaves the unfinished pairs out', async () => {
  let n = 0
  let clock = 0
  // The four protocol calls, then two probes per pair: the ninth call is the third pair's clear yes.
  const result = await runSelfTest(async ({ state, questions }) => {
    if (++n === 9) throw Object.assign(new Error('500 inference failed'), { status: 500 })
    return {
      answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
        if (q.type === 'noul') return [name, { type: 'noul', noul: n > 4 && n % 2 ? 0.9 : 0.1, confidence: 0.9 }]
        const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
        const top = name === 'kind' && state.message.startsWith('What') ? 1 : 0
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === top ? 0.9 : 0.1 / (keys.length - 1)]))
        return [name, { type: q.type, ...(q.type === 'choice' ? { choice: keys[top] } : { score: 1 }), probabilities, confidence: 0.9 }]
      })),
    }
  }, { identity: IDENTITY, device: 'cuda', now: () => (clock += 10) })
  assert.equal(result.error, 'unrelatedChanges (clear yes): 500 inference failed')
  assert.equal(result.protocol.ok, false)
  assert.equal(result.protocol.problems[0], result.error)
  assert.deepEqual(result.pairs.map((p) => [p.name, p.separates]), [['alsoWork', true], ['needsPerson', true]], 'what was measured is kept')
  assert.equal(selfTestLine(result), 'Test Laya (model 0123456): protocol failed (unrelatedChanges (clear yes): 500 inference failed). '
    + 'On the GPU: intent 10 ms, routing 10 ms, review 10 ms. Task or question: separates.')
})

// ---------------------------------------------------------------- createProbe against the fake

test('createProbe against the fake: the warm-up, the protocol checks, no retries, and the start\'s key', async (t) => {
  const fake = await startFakeLaya({ apiKey: 'start-key' })
  t.after(() => fake.close())
  const probe = createProbe({ url: fake.url, key: 'start-key', device: 'cuda' })

  const warm = await probe.warmUp()
  assert.equal(warm.ok, true, warm.error ?? warm.problems.join('; '))
  assert.deepEqual(warm.calls.map((c) => [c.name, c.phase, c.requests, c.rows]), [['intent.task', 'intent', 1, 3], ['intent.question', 'intent', 1, 3]])
  assert.deepEqual(fake.requests.map((r) => Object.keys(r.body.questions)), [['kind', 'depth', 'alsoWork'], ['kind', 'depth', 'alsoWork']])
  // Each call reports what it cost, for the per-phase figures of 4.5.
  const sent = renderForLaya(warmUpCalls()[0])
  assert.equal(warm.calls[0].tokens, estimateRequestTokens(sent[0]))
  assert.ok(warm.calls.every((c) => c.ms >= 0 && c.tokens > 0))

  const full = await probe.warmUp({ full: true })
  assert.equal(full.ok, true, full.error ?? full.problems.join('; '))
  assert.deepEqual(full.calls.map((c) => [c.name, c.phase, c.requests]), [['intent.task', 'intent', 1], ['intent.question', 'intent', 1], ['route.maximal', 'route', 3], ['review.maximal', 'review', 4]])
  assert.equal(fake.requests.length, 2 + 2 + 3 + 4)
  assert.ok(Math.max(...fake.requests.map((r) => Object.keys(r.body.questions).length)) >= 24, 'the maximal route task view goes as one request')

  const protocol = await probe.protocol()
  assert.equal(protocol.ok, true)
  assert.deepEqual(protocol.calls.map((c) => c.name), ['intent.task', 'intent.question', 'route', 'review'])
  assert.ok(fake.requests.every((r) => r.authorization === 'Bearer start-key' && r.body.model === 'english' && r.status === 200))

  // Another server on the port, or a stale key, is refused: the warm-up fails and says so, once.
  const before = fake.requests.length
  const stale = await createProbe({ url: fake.url, key: 'old-key' }).warmUp()
  assert.equal(stale.ok, false)
  assert.equal(stale.status, 401)
  assert.match(stale.error, /^intent\.task: 401 invalid or missing bearer token$/)
  assert.equal(fake.requests.length, before + 1, 'no retry')

  fake.failNext(500)
  const broken = await probe.protocol()
  assert.equal(broken.ok, false)
  assert.equal(broken.status, 500)
  assert.match(broken.error, /^intent\.task: 500 inference failed$/)
  assert.equal(fake.requests.length, before + 2, 'a 500 is not retried either')
})

test('createProbe refuses a connection without a key or a url, so the SDK never fills one in from the person\'s TypeSafe settings', async (t) => {
  const fake = await startFakeLaya()
  t.after(() => fake.close())
  const saved = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = 'tsk_the_persons_own_secret'
  t.after(() => { if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved })
  for (const key of [undefined, null, '', 42]) {
    assert.throws(() => createProbe({ url: fake.url, key }), /laya-selfcheck: the connection has no key/, `key ${key}`)
  }
  assert.throws(() => createProbe(undefined), /laya-selfcheck: the connection has no key/)
  // Without a url the SDK would send to TYPESAFE_BASE_URL, or to TypeSafe itself.
  for (const url of [undefined, '']) assert.throws(() => createProbe({ url, key: 'k' }), /laya-selfcheck: the connection has no url/)
  assert.equal(fake.requests.length, 0, 'nothing was sent')
})

test('createProbe gives each request its own timeout, not the SDK\'s 10 s default', async (t) => {
  const fake = await startFakeLaya({ msPerRow: 150 })
  t.after(() => fake.close())
  const slow = await createProbe({ url: fake.url, key: 'k' }, { timeoutMs: 200 }).warmUp()
  assert.equal(slow.ok, false)
  assert.match(slow.error, /timed out/i)
  const patient = await createProbe({ url: fake.url, key: 'k' }, { timeoutMs: 5000 }).warmUp()
  assert.equal(patient.ok, true)
})

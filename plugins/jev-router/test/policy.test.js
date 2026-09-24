// Review decision bands and tool selection signals, without a repo or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createReview } from '../../jev-review/index.js'
import { createJev } from '../jev.js'

const thresholds = { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7 }
const signal = new AbortController().signal
const cmp = { regressed: [], failing: [] }
const input = (routing, over = {}) => ({
  task: 't', routing, attempts: [{ agent: 'a', stopReason: 'completed' }], checks: [], cmp, diff: {}, agents: [],
  blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'b', ...over,
})
// quality = min(addressed, complete, 1 - unrelated, 1 - regression) = q
const nouls = (q, over = {}) => ({ verdict: 'accept', verdictConfidence: 0.9, addressed: q, complete: 1, unrelatedChanges: 0, regressionRisk: 0, needsPerson: 0, ...over })
const run = (answers, routing, over) => createReview({ assess: async () => answers }, thresholds)(input(routing, over), signal)

test('accept bar scales with routing risk', async () => {
  assert.equal((await run(nouls(0.6), { risk: 0.1 })).action, 'accept')
  assert.equal((await run(nouls(0.6), { risk: 0.4 })).action, 'second_review')
  assert.equal((await run(nouls(0.8), { risk: 0.4 })).action, 'accept')
  assert.equal((await run(nouls(0.8), { risk: 0.9 })).action, 'second_review')
  assert.equal((await run(nouls(0.8), {})).action, 'accept') // missing risk = 0.5 -> medium bar
  const r = await run(nouls(0.72), { risk: 0.02 })
  assert.equal(r.why, 'quality 0.72 ≥ bar 0.55 (risk 0.02)')
  assert.equal(r.status, 'accepted')
})

test('low band retries, middle band goes to a person once reviewed', async () => {
  assert.equal((await run(nouls(0.3), { risk: 0.1 })).action, 'retry')
  assert.equal((await run(nouls(0.95, { unrelatedChanges: 0.8 }), { risk: 0.1 })).action, 'retry')
  assert.equal((await run(nouls(0.5), { risk: 0.1 }, { reviewed: true })).action, 'human')
})

test('needsPerson goes to human; blockAccept always wins', async () => {
  assert.equal((await run(nouls(0.95, { needsPerson: 0.7 }), { risk: 0.1 })).action, 'human')
  const r = await run(nouls(0.95, { needsPerson: 0.9 }), { risk: 0.1 }, { blockAccept: true, cmp: { regressed: ['test'], failing: [] } })
  assert.equal(r.action, 'retry')
  assert.match(r.why, /regressed: test/)
})

test('accept still asks for a second opinion and flags human review', async () => {
  assert.equal((await run(nouls(0.9), { risk: 0.1, needsSecondOpinion: 0.9 })).action, 'second_review')
  const r = await run(nouls(0.9), { risk: 0.1, needsSecondOpinion: 0.9, needsHumanReview: 0.9 }, { reviewed: true })
  assert.equal(r.action, 'accept')
  assert.equal(r.status, 'accepted_pending_human_review')
})

test('route asks a fits Noul per tool and reports weakest argument confidence', async (t) => {
  const traces = []
  let asked
  t.mock.method(TypeSafeClient.prototype, 'systemOne', async ({ questions }) => {
    asked = questions
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k,
      q.type === 'noul' ? { type: 'noul', noul: k === 'weather.fits' ? 0.8 : 0.1 }
        : q.type === 'score' ? { type: 'score', score: 1, confidence: 0.9 }
          : { type: 'choice', choice: k === 'handler' ? 'weather' : Object.keys(q.criteria)[0], confidence: k === 'weather.days' ? 0.55 : 0.9 }]))
    return { model: 'jev-1.13.0', usage: {}, answers }
  })
  const jev = createJev({ apiKey: 'k', model: 'jev-1.13.0', onTrace: (x) => traces.push(x) })
  const tools = [
    { id: 'weather', description: 'weather lookup', params: { units: { question: 'Units?', options: { c: 'C', f: 'F' } }, days: { question: 'Days?', options: { one: '1', seven: '7' } } } },
    { id: 'clock', description: 'current time' },
  ]
  const r = await jev.route({ task: 't', context: {}, agents: [{ id: 'a', description: 'a' }], tools }, signal)
  assert.equal(asked['clock.fits'].type, 'noul')
  assert.equal(r.toolFits, 0.8)
  assert.equal(r.toolArgConfidence, 0.55)
  assert.deepEqual(r.toolArgs, { units: 'c', days: 'one' })
  const used = Object.fromEntries(traces[0].questions.map((q) => [q.name, q.used]))
  assert.equal(used['weather.fits'], true)
  assert.equal(used['weather.days'], true)
  assert.equal(used['clock.fits'], false)
})

test('route adds availability and the continueHandoff Noul only when given', async (t) => {
  const calls = []
  t.mock.method(TypeSafeClient.prototype, 'systemOne', async ({ state, questions }) => {
    calls.push({ state, questions })
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k,
      q.type === 'noul' ? { type: 'noul', noul: k === 'continueHandoff' ? 0.8 : 0.1 }
        : q.type === 'score' ? { type: 'score', score: 1, confidence: 0.9 }
          : { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 }]))
    return { model: 'jev-1.13.0', usage: {}, answers }
  })
  const jev = createJev({ apiKey: 'k', model: 'jev-1.13.0' })
  const agents = [{ id: 'a', description: 'a' }]
  const r = await jev.route({ task: 'continue', context: {}, agents, availability: { a: 'near limit' }, handoff: 'x'.repeat(5000) }, signal)
  assert.equal(r.continueHandoff, 0.8)
  assert.deepEqual(calls[0].state.agent_availability, { a: 'near limit' })
  assert.ok(calls[0].state.handoff.length < 3100)
  const plain = await jev.route({ task: 't', context: {}, agents }, signal)
  assert.equal(plain.continueHandoff, undefined)
  assert.equal('continueHandoff' in calls[1].questions, false)
  assert.equal('handoff' in calls[1].state, false)
})

test('built-in limit matcher ignores completed runs that merely mention rate limits', async () => {
  const { builtinLimit } = await import('../router.js')
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: 'You have hit your usage limit' }).hit, true)
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: { category: 'limit' } }).hit, true)
  assert.equal(builtinLimit({ stopReason: 'completed', answerText: 'added a rate limit to the API' }).hit, false)
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: 'exit 1: TypeError' }).hit, false)
})

// --- the routing policy itself (routing-policy.js) ------------------------------------------

test('the per-class recall floor is tierable by risk, with the global value as the default', async () => {
  const { ROUTING_DEFAULTS, RISK_CLASSES, gatesFor, resolvePolicy } = await import('../routing-policy.js')
  const base = resolvePolicy()
  for (const rc of RISK_CLASSES) assert.equal(base.gates[rc].minClassRecall, base.minClassRecall, `${rc} inherits the global floor`)
  const tiered = resolvePolicy({ gates: { HIGH: { minClassRecall: 0.95 } } })
  assert.equal(tiered.gates.HIGH.minClassRecall, 0.95, 'a risk class can demand more')
  assert.equal(tiered.gates.LOW.minClassRecall, 0.85, 'and the others keep the global')
  assert.equal(gatesFor(tiered, 'frontier_escalation').minClassRecall, 0.95, 'a domain reads it from its own gate block')
  assert.equal(gatesFor(tiered, 'task_classification').minClassRecall, 0.85)
  const raised = resolvePolicy({ minClassRecall: 0.9, gates: { LOW: { minClassRecall: 0.8 } } })
  assert.deepEqual(RISK_CLASSES.map((rc) => raised.gates[rc].minClassRecall), [0.8, 0.9, 0.9], 'the global is the default, a tier value wins')
  assert.throws(() => resolvePolicy({ gates: { MEDIUM: { minClassRecall: 1.5 } } }), /gates\.MEDIUM\.minClassRecall/)
  assert.throws(() => resolvePolicy({ minClassRecall: -0.1 }), /minClassRecall/)
  assert.equal(ROUTING_DEFAULTS.gates.HIGH.minClassRecall, undefined, 'the frozen defaults are never written to')
})

test('the policy carries no threshold that nothing reads', async () => {
  const { resolvePolicy } = await import('../routing-policy.js')
  // `lowConfidence` duplicated the operator's config.policy.minRoutingConfidence, which is the
  // number router.js's low-confidence handling really reads; a second copy only invites changing
  // the wrong one and seeing nothing happen.
  assert.equal('lowConfidence' in resolvePolicy(), false)
})

test('conservation is a hard limit in the decision engine, not a routing domain with cuts of its own', async () => {
  const { DOMAINS, resolvePolicy } = await import('../routing-policy.js')
  // A domain is something a classifier learns to decide. Conservation reads the governor's level
  // for the most capable resource and moves the work in code (decision.js), so it has no ladder,
  // no training lane and no probability cuts to tune.
  const policy = resolvePolicy()
  assert.equal('conservation' in DOMAINS, false)
  assert.equal('conservation' in policy.domains, false)
  assert.deepEqual(Object.keys(policy.codeJudgments), ['frontierReview'], 'the frontier review is the one judgment left answered in code')
})

test('the resource ranking\'s local classifier never decides, and no policy can say it does', async () => {
  const { DOMAINS, resolvePolicy } = await import('../routing-policy.js')
  // The owner's decision: the ranking makes the pick at every rung (decision.js). The domain
  // carries it, so the controller and the Router tab read the same thing.
  assert.equal(DOMAINS.resource_selection.localDecides, false)
  assert.deepEqual(Object.keys(DOMAINS).filter((id) => DOMAINS[id].localDecides === false), ['resource_selection'], 'the one domain it holds for')
  // decision.js takes that pick from the ranking whatever the policy says, so a policy that
  // switched the classifier back on would only make the Router tab promise what nothing does.
  assert.throws(() => resolvePolicy({ domains: { resource_selection: { localDecides: true } } }), /routing policy: domain resource_selection: localDecides/)
  assert.throws(() => resolvePolicy({ domains: { task_classification: { localDecides: 'no' } } }), /routing policy: domain task_classification: localDecides must be true or false/)
  // Taking a domain's local authority away is a choice the policy may make.
  assert.equal(resolvePolicy({ domains: { task_classification: { localDecides: false } } }).domains.task_classification.localDecides, false)
})

test('the domains a rule in code decides are the ones decision.js asks Jev nothing for, and no policy moves them', async () => {
  const { DOMAINS, resolvePolicy } = await import('../routing-policy.js')
  // The resource ranking and the frontier review are comparisons of numbers: a rule decides each,
  // and the Router tab says so at the rungs where it would otherwise say Jev decides.
  assert.deepEqual(Object.keys(DOMAINS).filter((id) => DOMAINS[id].teacher === 'code'), ['resource_selection', 'frontier_escalation'])
  assert.throws(() => resolvePolicy({ domains: { frontier_escalation: { teacher: 'jev' } } }), /routing policy: domain frontier_escalation: teacher cannot be changed/)
  assert.throws(() => resolvePolicy({ domains: { second_opinion: { teacher: 'code' } } }), /routing policy: domain second_opinion: teacher cannot be changed/)
  assert.throws(() => resolvePolicy({ domains: { task_classification: { teacher: 'someone' } } }), /routing policy: domain task_classification: teacher must be jev or code/)
  assert.equal(resolvePolicy().domains.frontier_escalation.teacher, 'code')
})

test('the subscription-to-metered crossover falls where the policy comment says', async () => {
  const { resolvePolicy } = await import('../routing-policy.js')
  const { CURVE_KNEES, conservationCurve, expectedJobCost } = await import('../governor.js')
  const policy = resolvePolicy()
  const profile = { risk: 0.5, requirements: { coding: 0.8 } }
  const cand = (marginalCost, scarcity) => ({ marginalCost, scarcity, scarcityConfidence: 1, reliability: { score: 0.8, confidence: 0.5 }, capabilities: { coding: { score: 0.8, confidence: 0.5 } } })
  const total = (mc, s) => expectedJobCost({ candidate: cand(mc, s), profile, policy }).total
  const bisect = (f, lo = 0, hi = 1) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m)) lo = m; else hi = m } return lo }
  const gap = bisect((s) => total('low', s) < total('metered', 0))
  const { marginal, scarcityWeight } = policy.governor.cost
  assert.ok(Math.abs(gap - (marginal.metered - marginal.low) / scarcityWeight) < 1e-6, `a subscription loses once 0.3 more scarce (${gap})`)
  const curves = { default: policy.governor.conservation.default, ...policy.governor.conservation.plans }
  const at = Object.fromEntries(Object.entries(curves).map(([k, c]) => [k, Math.round(bisect((p) => conservationCurve(p, c) < gap) * 100)]))
  assert.deepEqual(at, { default: 65, pro: 60, plus: 60, max: 74, team: 74 }, 'the pressure at which it happens, per plan')
  for (const c of Object.values(curves)) assert.ok(conservationCurve(c.aggressiveAt, c) === CURVE_KNEES.aggressive && gap < CURVE_KNEES.aggressive, 'well before the aggressive knee, not past it')
})

test('a rollback destination must be under every rung it rolls back from', async () => {
  const { resolvePolicy } = await import('../routing-policy.js')
  // Accepted before: a "severe regression" from GUARDED_LOCAL that moved the domain UP to
  // LOCAL_ONLY with no gates, and wiped the rollback record on the way.
  assert.throws(() => resolvePolicy({ rollback: { severeTo: 'LOCAL_ONLY' } }), /rollback\.severeTo must be below GUARDED_LOCAL/)
  assert.throws(() => resolvePolicy({ rollback: { significantTo: 'GUARDED_LOCAL' } }), /rollback\.significantTo must be below GUARDED_LOCAL/)
  assert.throws(() => resolvePolicy({ rollback: { minorTo: 'LOCAL_ONLY' } }), /rollback\.minorTo must be below LOCAL_ONLY/)
  assert.throws(() => resolvePolicy({ rollback: { minorTo: 'nowhere' } }), /rollback\.minorTo must be a maturity state/)
  // Every rung under the source, and the ROLLBACK waiting state, is a real way down.
  for (const to of ['JEV_PRIMARY', 'SHADOW', 'ROLLBACK']) {
    assert.equal(resolvePolicy({ rollback: { severeTo: to, significantTo: to } }).rollback.severeTo, to)
  }
  assert.equal(resolvePolicy({ rollback: { minorTo: 'SHADOW' } }).rollback.minorTo, 'SHADOW')
  assert.doesNotThrow(() => resolvePolicy())
})

test('the governor values the arithmetic depends on are checked like the gates are', async () => {
  const { resolvePolicy } = await import('../routing-policy.js')
  const bad = [
    [{ staleConfidence: -1 }, /governor\.staleConfidence/],
    [{ staleConfidence: 2 }, /governor\.staleConfidence/],
    [{ staleConfidence: '0.5' }, /governor\.staleConfidence/],
    [{ staleAfterMinutes: -5 }, /governor\.staleAfterMinutes/],
    [{ staleAfterMinutes: Infinity }, /governor\.staleAfterMinutes/],
    [{ resetProximityWeight: 1.5 }, /governor\.resetProximityWeight/],
    [{ budgetSoftMultiple: 1 }, /governor\.budgetSoftMultiple/],
    [{ budgetSoftMultiple: 0.5 }, /governor\.budgetSoftMultiple/],
    [{ cost: { scarcityWeight: -1 } }, /governor\.cost\.scarcityWeight/],
    [{ cost: { marginal: { metered: NaN } } }, /governor\.cost\.marginal\.metered/],
    [{ conservation: { default: { startAt: 1.2 } } }, /governor\.conservation\.default\.startAt/],
    [{ conservation: { default: { startAt: 0.9, aggressiveAt: 0.5 } } }, /governor\.conservation\.default/],
    [{ conservation: { plans: { pro: { startAt: 0.5, aggressiveAt: -1 } } } }, /governor\.conservation\.plans\.pro\.aggressiveAt/],
  ]
  for (const [governor, why] of bad) assert.throws(() => resolvePolicy({ governor }), why, JSON.stringify(governor))
  // A governor that is not a block at all says so, rather than failing on a property read.
  for (const governor of [null, 'fast', [1]]) assert.throws(() => resolvePolicy({ governor }), /routing policy: governor must be an object/, JSON.stringify(governor))
  // The edges that still mean something are accepted: no trust in stale usage, no reset discount,
  // a plan curve of its own.
  for (const governor of [{ staleConfidence: 0 }, { staleConfidence: 1 }, { resetProximityWeight: 0 }, { staleAfterMinutes: 0 }, { budgetSoftMultiple: 1.01 }, { conservation: { plans: { enterprise: { startAt: 0.8, aggressiveAt: 0.8 } } } }]) {
    assert.doesNotThrow(() => resolvePolicy({ governor }), JSON.stringify(governor))
  }
})

test('the minimum review thresholds are described as the fallback they are, not a floor', async () => {
  // decision.js passes them only as the fallback of the second-opinion and frontier judgments; a
  // Jev "no" at any risk stands. The policy file is where the README sends operators to read what
  // a key means, so it must not promise a review the code does not force.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../routing-policy.js', import.meta.url), 'utf8')
  // The whole comment block over the key, however long it grows.
  const above = src.slice(0, src.indexOf('minimumReview: Object.freeze')).split('\n').slice(0, -1)
  const note = above.slice(above.findLastIndex((l) => !l.trim().startsWith('//')) + 1).join('\n')
  assert.doesNotMatch(note, /always gets an independent review/)
  assert.match(note, /FALLBACK/)
  assert.match(note, /not a floor/)
  // An operator who edits these keys also moves the conservation limit and the fallback strategy,
  // so the note says so. It must not send them to a fallback resource pick: there is none, the
  // ranking makes the pick at every risk (decision.js), and nothing there reads these cuts.
  assert.match(note, /conservation/)
  assert.match(note, /strategy/)
  assert.doesNotMatch(note, /fallback resource pick/)
})

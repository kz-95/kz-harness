// The governor: scarcity from the binding limit through the plan's curve, the reset discount,
// money budgets against their floors, expected job cost from the policy, and the signals and
// hints the decision engine reads. Every snapshot here is a fixture built by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePolicy } from '../routing-policy.js'
import { USAGE_CONFIDENCE, snapshotResources, validateSnapshot } from '../resources.js'
import { COST_CLASSES, CURVE_KNEES, RESET_CURVE, conservationCurve, conservationHint, expectedJobCost, governorSignals, scarcityOf } from '../governor.js'

const NOW = '2026-09-22T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const minutesFromNow = (m) => new Date(NOW_MS + m * 60_000).toISOString()
const policy = resolvePolicy()
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

/** A rolling-window limit, percent based. */
const rolling = (id, usedPercent, { minutes = 10080, resetIn = null, confidence = 0.95 } = {}) => ({
  id, kind: 'rolling_window', scope: 'account', used: usedPercent, remaining: 100 - usedPercent, total: 100, unit: 'percent',
  ratioUsed: usedPercent / 100, resetsAt: resetIn == null ? null : minutesFromNow(resetIn), durationMinutes: minutes, rolling: true,
  source: 'provider_api', confidence, checkedAt: NOW,
})
/** A money limit; `total` null means only the floors can be read. */
const money = (remaining, { total = null, confidence = 0.95 } = {}) => ({
  id: 'balance', kind: 'monetary_budget', scope: 'account', used: total == null ? null : total - remaining, remaining, total, unit: 'CNY',
  ratioUsed: total == null ? null : 1 - remaining / total, resetsAt: null, durationMinutes: null, rolling: null,
  source: 'provider_api', confidence, checkedAt: NOW,
})
/** A valid snapshot with overrides. */
const snap = (over = {}) => validateSnapshot({
  resourceId: 'r1', provider: 'claude-code', adapter: 'anthropic-subscription', source: 'subscription', model: null, modelVersion: null, plan: null,
  limits: [], availability: { state: 'ok', until: null, reason: null, loggedIn: true },
  economics: { marginalCost: 'low', pricing: null, rateNow: null, peak: null, budget: null },
  hardware: null, usageSource: 'provider_api', confidence: 0.95, checkedAt: NOW, ...over,
})
const budgetSnap = (remaining, over = {}) => snap({
  resourceId: 'ds', provider: 'deepseek', adapter: 'deepseek-api', source: 'api', limits: [money(remaining, over)],
  economics: { marginalCost: 'metered', pricing: null, rateNow: null, peak: null, budget: { remaining, currency: 'CNY', soft: 10, hard: 5 } },
})
const localSnap = snap({ resourceId: 'local', provider: 'local', adapter: 'local-model', source: 'local', economics: { marginalCost: 'none', pricing: null, rateNow: null, peak: null, budget: null }, usageSource: 'unknown', confidence: 0 })
const profile = (over = {}) => ({ taskType: 'implementation', complexity: 0.5, risk: 0.5, requirements: { coding: 0.9, debugging: 0.4 }, ...over })
const candidate = (over = {}) => ({ id: 'r1', key: 'RESOURCE_A', source: 'subscription', tier: 'strong', capabilities: { coding: { score: 0.9, confidence: 0.8, samples: 40 }, debugging: { score: 0.8, confidence: 0.6, samples: 20 } }, scarcity: 0.2, scarcityConfidence: 0.9, marginalCost: 'low', reliability: { score: 0.9, confidence: 0.7, samples: 40 }, ...over })

test('scenario D: 82% used with the reset in ten minutes is far less scarce than with five days to go', () => {
  const near = scarcityOf(snap({ limits: [rolling('weekly', 82, { resetIn: 10 })] }), policy, NOW_MS)
  const far = scarcityOf(snap({ limits: [rolling('weekly', 82, { resetIn: 5 * 24 * 60 })] }), policy, NOW_MS)
  assert.ok(near.scarcity < far.scarcity, `near ${near.scarcity} is under far ${far.scarcity}`)
  // By hand: proximity (1 - 10/10080)^3, pressure 0.82 * (1 - 0.5 * proximity), under startAt so
  // pressure / 0.6 * 0.2. The cube is what keeps a mid-window reset from reading as comfortable.
  const prox = (left) => (1 - left / 10080) ** RESET_CURVE
  assert.ok(close(near.pressure, 0.82 * (1 - 0.5 * prox(10))))
  assert.ok(close(near.scarcity, near.pressure / 0.6 * 0.2))
  assert.ok(close(near.resetInMinutes, 10))
  assert.ok(close(near.resetProximity, prox(10)))
  // Far: five days of a seven-day window still to run, so the discount is nearly nothing.
  assert.ok(close(far.pressure, 0.82 * (1 - 0.5 * prox(7200))))
  assert.ok(far.pressure > 0.81, 'a reset five days out barely discounts anything')
  assert.ok(close(far.scarcity, 0.7 + 0.3 * ((far.pressure - 0.85) / 0.15)))
  assert.equal(near.basis, 'limit:weekly')
  assert.equal(near.confidence, 0.95, 'the binding limit lends its confidence')
  assert.equal(near.plan, null)
  // Without a reset time the raw ratio stands, and an operator can switch the discount off.
  const raw = scarcityOf(snap({ limits: [rolling('weekly', 82)] }), policy, NOW_MS)
  assert.ok(close(raw.pressure, 0.82))
  assert.equal(raw.resetProximity, null)
  assert.equal(raw.resetInMinutes, null)
  const flat = scarcityOf(snap({ limits: [rolling('weekly', 82, { resetIn: 10 })] }), resolvePolicy({ governor: { resetProximityWeight: 0 } }), NOW_MS)
  assert.ok(close(flat.pressure, 0.82))
})

test('scenario E: no limits is scarcity null at confidence 0, basis unknown, nothing invented', () => {
  const s = scarcityOf(snap({ limits: [], usageSource: 'unknown', confidence: 0 }), policy, NOW_MS)
  assert.deepEqual(s, { scarcity: null, confidence: 0, basis: 'unknown', pressure: null, resetInMinutes: null, resetProximity: null, plan: null })
  // A limit with neither a ratio nor a readable balance says nothing either.
  const mute = scarcityOf(snap({ limits: [{ ...rolling('weekly', 0), ratioUsed: null, used: null }] }), policy, NOW_MS)
  assert.equal(mute.scarcity, null)
  assert.equal(mute.basis, 'unknown')
  const signals = governorSignals({ snapshots: [snap({ limits: [] })], policy, now: NOW_MS })
  assert.equal(signals.get('r1').scarcity, null)
  assert.equal(signals.get('r1').scarcityConfidence, 0)
})

test('the binding limit is the one under the most adjusted pressure', () => {
  const s = scarcityOf(snap({ limits: [rolling('5h', 90, { minutes: 300, resetIn: 290 }), rolling('weekly', 40, { resetIn: 5000 })] }), policy, NOW_MS)
  assert.equal(s.basis, 'limit:5h')
  assert.ok(close(s.pressure, 0.9 * (1 - 0.5 * ((1 - 290 / 300) ** RESET_CURVE))))
  // The same 5h window one minute from its reset gives way to the weekly one: the discount is
  // steep only at the very end of a window, which is when the allowance really is about to return.
  const t = scarcityOf(snap({ limits: [rolling('5h', 99, { minutes: 300, resetIn: 1 }), rolling('weekly', 70, { resetIn: 5000 })] }), policy, NOW_MS)
  assert.equal(t.basis, 'limit:weekly')
  // A tie keeps the first limit, so the answer does not depend on object identity.
  const tie = scarcityOf(snap({ limits: [rolling('a', 50), rolling('b', 50)] }), policy, NOW_MS)
  assert.equal(tie.basis, 'limit:a')
})

test('scenario F: a rolling window and a money budget are read by the same governor without being treated as equal', () => {
  const rollingS = scarcityOf(snap({ limits: [rolling('weekly', 73)] }), policy, NOW_MS)
  const withTotal = scarcityOf(budgetSnap(20, { total: 50 }), policy, NOW_MS)
  assert.equal(rollingS.basis, 'limit:weekly')
  assert.equal(withTotal.basis, 'limit:balance')
  assert.ok(close(rollingS.pressure, 0.73), 'a window is pressure by share used')
  assert.ok(close(withTotal.pressure, 1 - 20 / 50), 'a budget with a total is pressure by share spent')
  assert.notEqual(rollingS.scarcity, withTotal.scarcity)
  // Without a total the floors decide: at or under hard is 1, between the floors 0.7 to 1, above soft eases out.
  const g = policy.governor
  assert.equal(scarcityOf(budgetSnap(4), policy, NOW_MS).pressure, 1)
  assert.equal(scarcityOf(budgetSnap(5), policy, NOW_MS).pressure, 1)
  assert.ok(close(scarcityOf(budgetSnap(7.5), policy, NOW_MS).pressure, 0.7 + 0.3 * (2.5 / 5)))
  // Above soft it eases from the aggressive knee down to nothing at budgetSoftMultiple times the floor.
  const flush = 10 * g.budgetSoftMultiple
  assert.ok(close(scarcityOf(budgetSnap(15), policy, NOW_MS).pressure, 0.7 * (flush - 15) / (flush - 10)))
  // Continuous at the soft floor: the band below ends at the knee and the line above starts there.
  assert.ok(close(scarcityOf(budgetSnap(10), policy, NOW_MS).pressure, 0.7))
  assert.ok(Math.abs(scarcityOf(budgetSnap(10.01), policy, NOW_MS).pressure - 0.7) < 0.001, 'a cent over the floor reads the same')
  assert.equal(scarcityOf(budgetSnap(40), policy, NOW_MS).pressure, 0, 'floored at 0 far above the soft limit')
  assert.equal(scarcityOf(budgetSnap(4), policy, NOW_MS).scarcity, 1)
  assert.equal(scarcityOf(budgetSnap(4), policy, NOW_MS).resetProximity, null, 'money has no reset')
  // No floors at all: the balance alone says nothing.
  const bare = budgetSnap(20)
  bare.economics.budget = null
  assert.equal(scarcityOf(bare, policy, NOW_MS).scarcity, null)
  // The same two snapshots through the real adapters.
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }]
  const usage = {
    claude: { kind: 'subscription', provider: 'claude-code', windows: [{ name: 'weekly', minutes: 10080, usedPercent: 73, resetsAt: minutesFromNow(3000) }], limits: {}, error: null, checkedAt: NOW, state: 'ok', until: null },
    deepseek: { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 7.5, currency: 'CNY' }, creditPercent: null, creditPeak: null, limits: { minBalance: 5, handoffAtBalance: 10 }, error: null, checkedAt: NOW, state: 'near', until: null },
  }
  const signals = governorSignals({ snapshots: snapshotResources({ agents, usage, now: NOW_MS }), policy, now: NOW_MS })
  assert.equal(signals.get('claude').basis, 'limit:weekly')
  assert.equal(signals.get('deepseek').basis, 'limit:balance')
  assert.ok(close(signals.get('deepseek').pressure, 0.85))
  assert.equal(signals.get('deepseek').availability, 'near')
  assert.equal(signals.get('deepseek').marginalCost, 'metered')
  assert.equal(signals.get('claude').marginalCost, 'low')
})

test('the plan curves: pro conserves earlier than max, and the curve bends where the policy says', () => {
  const at = (plan, used) => scarcityOf(snap({ plan: plan ? { name: plan, source: 'provider_cli', confidence: 0.9 } : null, limits: [rolling('weekly', used)] }), policy, NOW_MS)
  assert.ok(at('pro', 60).scarcity > at('max', 60).scarcity, 'pro is already past its startAt at 60%, max is not')
  assert.ok(close(at('pro', 60).scarcity, 0.2 + 0.5 * (0.05 / 0.25)))
  assert.ok(close(at('max', 60).scarcity, 0.6 / 0.7 * 0.2))
  assert.equal(at('Pro', 60).plan, 'pro', 'plan names are matched lower case')
  assert.ok(close(at('unknown-plan', 60).scarcity, at(null, 60).scarcity), 'an unknown plan takes the default curve')
  const curves = policy.governor.conservation
  for (const [name, c] of Object.entries({ default: curves.default, ...curves.plans })) {
    assert.ok(close(conservationCurve(0, c), 0), `${name}: nothing used is nothing scarce`)
    assert.ok(close(conservationCurve(c.startAt, c), CURVE_KNEES.start), `${name}: startAt is the first knee`)
    assert.ok(close(conservationCurve(c.aggressiveAt, c), CURVE_KNEES.aggressive), `${name}: aggressiveAt is the second knee`)
    assert.ok(close(conservationCurve(1, c), 1), `${name}: everything used is fully scarce`)
    assert.ok(conservationCurve((c.startAt + c.aggressiveAt) / 2, c) > CURVE_KNEES.start, `${name}: rising between the knees`)
  }
  assert.ok(close(conservationCurve(0.5, { startAt: 0, aggressiveAt: 1 }), 0.2 + 0.25), 'degenerate curves do not divide by zero')
  assert.ok(close(conservationCurve(2, { startAt: 0.6, aggressiveAt: 0.85 }), 1), 'clamped above 1')
})

test('stale data lowers the confidence of the scarcity read from it', () => {
  const stale = resolvePolicy().governor
  const fresh = scarcityOf(snap({ limits: [rolling('weekly', 70, { confidence: 0.95 })] }), policy, NOW_MS)
  const old = scarcityOf(snap({ limits: [rolling('weekly', 70, { confidence: 0.95 * stale.staleConfidence })] }), policy, NOW_MS)
  assert.equal(fresh.scarcity, old.scarcity, 'the figure is the same')
  assert.ok(close(old.confidence, fresh.confidence * stale.staleConfidence))
  // End to end through the adapter: a row checked an hour ago.
  const agents = [{ id: 'claude', provider: 'claude-code' }]
  const row = { kind: 'subscription', provider: 'claude-code', windows: [{ name: 'weekly', minutes: 10080, usedPercent: 70, resetsAt: null }], limits: {}, error: null, checkedAt: minutesFromNow(-60), state: 'ok', until: null }
  const [s] = snapshotResources({ agents, usage: { claude: row }, now: NOW_MS })
  assert.ok(close(scarcityOf(s, policy, NOW_MS).confidence, 0.95 * stale.staleConfidence))
})

test('a local resource has zero scarcity at full confidence, whatever else it reports', () => {
  const s = scarcityOf(localSnap, policy, NOW_MS)
  assert.deepEqual(s, { scarcity: 0, confidence: 1, basis: 'local', pressure: 0, resetInMinutes: null, resetProximity: null, plan: null })
  const signals = governorSignals({ snapshots: [localSnap], policy, now: NOW_MS })
  assert.equal(signals.get('local').scarcity, 0)
  assert.equal(signals.get('local').marginalCost, 'none')
  assert.equal(signals.get('local').latencyClass, 'fast')
  assert.equal(signals.get('local').unavailable, null)
})

test('an unavailable resource carries its reason as the hard fact; ok and near stay soft', () => {
  const out = snap({ resourceId: 'out', availability: { state: 'unavailable', until: null, reason: 'not signed in. Run: claude  then /login', loggedIn: false }, limits: [rolling('weekly', 20)] })
  const stopped = snap({ resourceId: 'stopped', availability: { state: 'stopped', until: minutesFromNow(90), reason: null, loggedIn: true }, limits: [rolling('weekly', 98)] })
  const exhausted = snap({ resourceId: 'gone', availability: { state: 'exhausted', until: null, reason: 'provider reported exhaustion', loggedIn: true } })
  const near = snap({ resourceId: 'near', availability: { state: 'near', until: null, reason: null, loggedIn: true }, limits: [rolling('weekly', 88)] })
  const unknown = snap({ resourceId: 'unknown', availability: { state: 'unknown', until: null, reason: 'Claude usage HTTP 503', loggedIn: null } })
  const signals = governorSignals({ snapshots: [out, stopped, exhausted, near, unknown], policy, now: NOW_MS })
  assert.equal(signals.get('out').unavailable, 'not signed in. Run: claude  then /login')
  assert.equal(signals.get('out').availability, 'unknown')
  assert.equal(signals.get('out').scarcity !== null, true, 'the windows are still read; the login is the blocker')
  assert.match(signals.get('stopped').unavailable, /^stopped until /)
  assert.equal(signals.get('gone').unavailable, 'provider reported exhaustion')
  assert.equal(signals.get('near').unavailable, null)
  assert.equal(signals.get('near').availability, 'near')
  assert.equal(signals.get('unknown').unavailable, null, 'unknown never blocks')
  assert.equal(signals.get('unknown').availability, 'unknown')
  assert.equal(signals.size, 5)
  assert.deepEqual(Object.keys(signals.get('near')).sort(), ['availability', 'basis', 'latencyClass', 'marginalCost', 'plan', 'pressure', 'resetInMinutes', 'resetProximity', 'scarcity', 'scarcityConfidence', 'unavailable'])
  assert.equal(signals.get('near').latencyClass, 'slow', 'an agentic CLI is the slow class')
  assert.equal(governorSignals({ snapshots: [budgetSnap(20)], policy, now: NOW_MS }).get('ds').latencyClass, 'medium')
})

test('expectedJobCost follows the policy formula and classes the total', () => {
  const c = policy.governor.cost
  const p = profile()
  const cand = candidate()
  const r = expectedJobCost({ candidate: cand, profile: p, policy })
  const execution = c.marginal.low + c.scarcityWeight * 0.2
  // fit from candidateFeatures, rounded to 3 decimals as the feature is: (0.9 * 0.9 + 0.4 * 0.8) / 1.3.
  const fit = Math.round(((0.9 * 0.9 + 0.4 * 0.8) / 1.3) * 1000) / 1000
  const pFail = 1 - 0.9 * (0.5 + 0.5 * fit)
  assert.ok(close(r.execution, execution))
  assert.ok(close(r.retry, c.retryWeight * pFail * execution))
  assert.ok(close(r.review, c.reviewWeight * 0.5))
  assert.ok(close(r.escalation, c.escalationWeight * pFail * 0.5))
  assert.ok(close(r.total, r.execution + r.retry + r.review + r.escalation))
  assert.equal(r.confidence, 0.7, 'the lower of scarcity and reliability confidence')
  assert.equal(r.class, COST_CLASSES.find(([, bound]) => r.total < bound)[0])
  // Risk raises review and escalation; a less reliable resource raises retry and escalation.
  const risky = expectedJobCost({ candidate: cand, profile: profile({ risk: 0.9 }), policy })
  assert.ok(risky.review > r.review && risky.escalation > r.escalation)
  assert.equal(risky.execution, r.execution)
  const flaky = expectedJobCost({ candidate: candidate({ reliability: { score: 0.4, confidence: 0.7, samples: 10 } }), profile: p, policy })
  assert.ok(flaky.retry > r.retry && flaky.escalation > r.escalation)
  // Classes at their bounds.
  const classes = [[0.1, 'very_low'], [0.3, 'low'], [0.7, 'medium'], [1.5, 'high']]
  for (const [scarcityWeight, expected] of classes) {
    const tuned = resolvePolicy({ governor: { cost: { marginal: { none: 0, low: 0, metered: 0 }, scarcityWeight, retryWeight: 0, reviewWeight: 0, escalationWeight: 0 } } })
    const out = expectedJobCost({ candidate: candidate({ scarcity: 1 }), profile: p, policy: tuned })
    assert.ok(close(out.total, scarcityWeight))
    assert.equal(out.class, expected, `${scarcityWeight} is ${expected}`)
  }
})

test('scenario H: a cheaper rate or cost class lowers expected cost through config alone', () => {
  const p = profile()
  const metered = candidate({ source: 'api', marginalCost: 'metered', scarcity: 0.1, scarcityConfidence: 0.9 })
  const before = expectedJobCost({ candidate: metered, profile: p, policy })
  const cheaper = expectedJobCost({ candidate: metered, profile: p, policy: resolvePolicy({ governor: { cost: { marginal: { metered: 0.2 } } } }) })
  assert.ok(cheaper.total < before.total, 'the policy number moved, no code did')
  assert.ok(close(cheaper.execution, 0.2 + policy.governor.cost.scarcityWeight * 0.1))
  // The same through the adapter: the operator reclassifies the resource's cost.
  const agents = [{ id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }]
  const usage = { deepseek: { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 40, currency: 'CNY' }, creditPercent: 80, creditPeak: { amount: 50, currency: 'CNY' }, limits: { minBalance: 5, handoffAtBalance: 10 }, error: null, checkedAt: NOW, state: 'ok', until: null } }
  const [full] = snapshotResources({ agents, usage, now: NOW_MS })
  const [low] = snapshotResources({ agents, usage, now: NOW_MS, config: { resources: { economics: { deepseek: { marginalCost: 'low' } } } } })
  const fromSnap = (snapshot) => expectedJobCost({ snapshot, candidate: { capabilities: {}, reliability: { score: 0.8, confidence: 0.5 } }, profile: p, policy, now: NOW_MS })
  assert.ok(fromSnap(low).total < fromSnap(full).total)
  assert.ok(close(fromSnap(full).execution, policy.governor.cost.marginal.metered + policy.governor.cost.scarcityWeight * scarcityOf(full, policy, NOW_MS).scarcity), 'scarcity is read from the snapshot when the candidate has none')
  assert.equal(fromSnap(full).confidence, 0.5, 'min of scarcity confidence 0.95 and reliability confidence 0.5')
})

test('expectedJobCost: unknown scarcity counts as none, and a local resource keeps a confidence floor', () => {
  const p = profile()
  const unknown = expectedJobCost({ candidate: candidate({ scarcity: null, scarcityConfidence: 0 }), profile: p, policy })
  assert.ok(close(unknown.execution, policy.governor.cost.marginal.low))
  assert.equal(unknown.confidence, 0)
  const local = expectedJobCost({ candidate: candidate({ source: 'local', marginalCost: 'none', scarcity: 0, scarcityConfidence: 1, reliability: { score: 0.6, confidence: 0.1, samples: 2 } }), profile: p, policy })
  assert.equal(local.confidence, 0.5, 'the floor for local')
  assert.ok(close(local.execution, policy.governor.cost.marginal.none))
  const localSure = expectedJobCost({ candidate: candidate({ source: 'local', marginalCost: 'none', scarcity: 0, scarcityConfidence: 1, reliability: { score: 0.6, confidence: 0.9, samples: 50 } }), profile: p, policy })
  assert.equal(localSure.confidence, 0.9, 'the floor never lowers a real confidence')
  const bare = expectedJobCost({ policy })
  assert.equal(typeof bare.total, 'number')
  assert.equal(bare.confidence, 0, 'nothing known, nothing trusted')
  // The snapshot's local source counts when the candidate does not say.
  assert.equal(expectedJobCost({ snapshot: localSnap, candidate: { reliability: { score: 0.5, confidence: 0.2 } }, profile: p, policy }).confidence, 0.5)
})

test('conservationHint gives a level and a note per resource, a Map for a Map and one hint for one signal', () => {
  const snapshots = [
    snap({ resourceId: 'fresh', limits: [rolling('weekly', 20)] }),
    snap({ resourceId: 'rising', plan: { name: 'pro', source: 'provider_cli', confidence: 0.9 }, limits: [rolling('weekly', 70, { resetIn: 5 * 24 * 60 })] }),
    snap({ resourceId: 'tight', limits: [rolling('weekly', 95)] }),
    snap({ resourceId: 'gone', availability: { state: 'exhausted', until: minutesFromNow(30), reason: null, loggedIn: true }, limits: [rolling('weekly', 99)] }),
    snap({ resourceId: 'blind', limits: [], usageSource: 'unknown', confidence: 0 }),
    localSnap,
  ]
  const signals = governorSignals({ snapshots, policy, now: NOW_MS })
  const hints = conservationHint(signals, profile({ complexity: 0.8, risk: 0.7 }), policy)
  assert.ok(hints instanceof Map)
  assert.deepEqual([...hints.keys()], ['fresh', 'rising', 'tight', 'gone', 'blind', 'local'])
  assert.equal(hints.get('fresh').level, 'healthy')
  assert.match(hints.get('fresh').note, /weekly limit at 20% pressure/)
  assert.match(hints.get('fresh').note, /conservation starts at 60% used/)
  assert.equal(hints.get('rising').level, 'increasing')
  assert.match(hints.get('rising').note, /pro plan conserves from 55% used|prefer a cheaper resource/)
  assert.match(hints.get('rising').note, /complexity 0\.8, risk 0\.7/)
  assert.equal(hints.get('tight').level, 'high')
  assert.match(hints.get('tight').note, /reserve for hard or risky work/)
  assert.equal(hints.get('gone').level, 'exhausted')
  assert.match(hints.get('gone').note, /not usable now: exhausted until/)
  assert.equal(hints.get('blind').level, 'healthy')
  assert.match(hints.get('blind').note, /usage unknown/)
  assert.equal(hints.get('local').level, 'healthy')
  assert.match(hints.get('local').note, /local, nothing to conserve/)
  const single = conservationHint(signals.get('tight'), profile(), policy)
  assert.deepEqual(single, conservationHint(signals, profile(), policy).get('tight'), 'one signal gives the same hint the Map holds for it')
  assert.equal(single.level, 'high')
  for (const h of hints.values()) {
    assert.equal(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`).test(h.note), false, 'no dashes in a note that reaches a prompt')
    assert.equal(typeof h.note, 'string')
  }
  // A reset close at hand is mentioned; the level thresholds are the curve's knees.
  const soon = conservationHint(governorSignals({ snapshots: [snap({ limits: [rolling('5h', 90, { minutes: 300, resetIn: 20 })] })], policy, now: NOW_MS }), profile(), policy)
  assert.match(soon.get('r1').note, /reset in 20 minutes/)
  assert.equal(conservationHint({ scarcity: CURVE_KNEES.start, basis: 'limit:x', pressure: 0.6, unavailable: null, plan: null }, profile(), policy).level, 'increasing')
  assert.equal(conservationHint({ scarcity: CURVE_KNEES.aggressive, basis: 'limit:x', pressure: 0.85, unavailable: null, plan: null }, profile(), policy).level, 'high')
  assert.equal(conservationHint({ scarcity: CURVE_KNEES.start - 0.01, basis: 'limit:x', pressure: 0.5, unavailable: null, plan: null }, profile(), policy).level, 'healthy')
})

test('the clock is injectable in every form and the defaults resolve the policy on their own', () => {
  const s = snap({ limits: [rolling('weekly', 82, { resetIn: 10 })] })
  const a = scarcityOf(s, policy, NOW_MS)
  assert.ok(close(scarcityOf(s, policy, NOW).scarcity, a.scarcity))
  assert.ok(close(scarcityOf(s, policy, () => NOW_MS).scarcity, a.scarcity))
  assert.ok(close(scarcityOf(s, undefined, NOW_MS).scarcity, a.scarcity), 'no policy given means the defaults')
  assert.ok(close(governorSignals({ snapshots: [s], now: NOW_MS }).get('r1').scarcity, a.scarcity))
})

/** A balance whose share spent is an estimate against a locally observed high-water mark, as the deepseek adapter reports it. */
const estimated = (remaining, peak, { confidence = 0.95 } = {}) => {
  const ratioUsed = Math.max(0, 1 - remaining / peak)
  const guess = { source: 'estimate', confidence: confidence * USAGE_CONFIDENCE.estimate }
  return { ...money(remaining, { total: peak, confidence }), ratioUsed, fieldSources: { used: guess, total: { source: 'local_observation', confidence: confidence * USAGE_CONFIDENCE.local_observation }, ratioUsed: guess } }
}
const estSnap = (limit, budget = { remaining: limit.remaining, currency: 'CNY', soft: 10, hard: 5 }) => snap({
  resourceId: 'ds', provider: 'deepseek', adapter: 'deepseek-api', source: 'api', limits: [limit],
  economics: { marginalCost: 'metered', pricing: null, rateNow: null, peak: null, budget },
})

test('a measured shortage is never softened by a low estimate of how much was spent', () => {
  // 7.5 CNY sits between the floors (5 hard, 10 soft): measured pressure 0.85. The key has never
  // been seen above 8, so the ESTIMATED share spent is about 6%. Read as a measurement that guess
  // made a key one top-up from the stop look untouched; weighed into a blend it still made it look
  // less scarce than the same balance with no high-water mark at all. The measurement is the floor.
  const mC = 0.95
  const cases = [[7.5, 8], [9.9, 10], [5.01, 5.1], [6, 8]]
  for (const [balance, peak] of cases) {
    const withMark = scarcityOf(estSnap(estimated(balance, peak)), policy, NOW_MS)
    const measured = scarcityOf(budgetSnap(balance), policy, NOW_MS)
    assert.equal(withMark.pressure, measured.pressure, `${balance} of ${peak}: the guess moved a measured reading down`)
    assert.equal(withMark.scarcity, measured.scarcity, 'in the scarcity the router acts on, too')
    assert.equal(conservationHint(withMark).level, conservationHint(measured).level)
    assert.equal(withMark.confidence, mC, 'the reading rests on the measurement alone, at its confidence')
    assert.equal(withMark.basis, 'limit:balance')
  }
  // At or under the hard floor, likewise.
  assert.equal(scarcityOf(estSnap(estimated(5, 5)), policy, NOW_MS).pressure, 1)
  assert.equal(scarcityOf(estSnap(estimated(4, 4)), policy, NOW_MS).confidence, mC)
})

test('a high estimate raises the reading in proportion to how far it is trusted', () => {
  const mC = 0.95
  const eC = 0.95 * USAGE_CONFIDENCE.estimate
  const blend = (share, floors) => (share * eC + floors * mC) / (eC + mC)
  // Most of a large top-up is gone: a real hint the key is being drawn down, so it may count.
  const floorsAt = (remaining) => 0.7 + 0.3 * ((10 - remaining) / 5)
  const drainedLow = scarcityOf(estSnap(estimated(7.5, 400)), policy, NOW_MS)
  assert.ok(close(drainedLow.pressure, blend(1 - 7.5 / 400, floorsAt(7.5))), `pressure ${drainedLow.pressure}`)
  assert.ok(drainedLow.pressure > floorsAt(7.5), 'a guess can make a shortage look worse')
  const flush = 0.7 * (30 - 20) / (30 - 10)
  const drainedHigh = scarcityOf(estSnap(estimated(20, 400)), policy, NOW_MS)
  assert.ok(close(drainedHigh.pressure, blend(0.95, flush)))
  assert.ok(drainedHigh.pressure > flush && drainedHigh.pressure < 0.95, 'raised toward the guess, not to it')
  assert.ok(close(drainedHigh.confidence, (eC ** 2 + mC ** 2) / (eC + mC)))
  assert.ok(drainedHigh.confidence < mC && drainedHigh.confidence > eC, 'trusted less than a measurement, more than a guess')
  // The same balance against a far higher mark reads scarcer.
  assert.ok(scarcityOf(estSnap(estimated(40, 400)), policy, NOW_MS).pressure > scarcityOf(estSnap(estimated(40, 41)), policy, NOW_MS).pressure)
  // With no floor to weigh it against, the estimate is used alone, at an estimate's confidence.
  const alone = scarcityOf(estSnap(estimated(20, 50), null), policy, NOW_MS)
  assert.ok(close(alone.pressure, 0.6))
  assert.ok(close(alone.confidence, eC), 'not the provider confidence the balance itself carries')
  // A share as solid as the balance (a provider-reported total) still stands on its own.
  assert.ok(close(scarcityOf(budgetSnap(20, { total: 50 }), policy, NOW_MS).pressure, 0.6))
})

test('there is no step at the soft floor: a cent either side reads almost the same', () => {
  // The clamp this replaced held a balance a hair under the soft floor at the aggressive knee and
  // let one a hair above it fall to the blend: one cent flipped the hint level.
  for (const peak of [10.1, 12, 400]) {
    const under = scarcityOf(estSnap(estimated(10, peak)), policy, NOW_MS)
    const over = scarcityOf(estSnap(estimated(10.01, peak)), policy, NOW_MS)
    assert.ok(Math.abs(under.pressure - over.pressure) < 0.01, `peak ${peak}: ${under.pressure} vs ${over.pressure}`)
  }
})

test('the same rule end to end through the deepseek adapter, and into the expected job cost', () => {
  const agents = [{ id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }]
  const rowAt = (amount, peak, creditPercent) => ({ kind: 'api', provider: 'spawn', windows: [], balance: { amount, currency: 'CNY' }, creditPercent, creditPeak: { amount: peak, currency: 'CNY' }, limits: { minBalance: 5, handoffAtBalance: 10 }, error: null, checkedAt: NOW, state: 'near', until: null })
  const sigOf = (row) => {
    const [s] = snapshotResources({ agents, usage: { deepseek: row }, now: NOW_MS })
    return { s, sig: governorSignals({ snapshots: [s], policy, now: NOW_MS }).get('deepseek') }
  }
  // Low guess: the measured floors decide, at the measurement's confidence.
  const low = sigOf(rowAt(7.5, 8, 94))
  assert.ok(close(low.sig.pressure, 0.85), `pressure ${low.sig.pressure} is the measured floors, not the 6% the estimate says`)
  assert.equal(low.sig.scarcityConfidence, USAGE_CONFIDENCE.provider_api)
  // High guess: it raises the reading, and the lower trust of the estimate comes with it.
  const high = sigOf(rowAt(7.5, 400, 2))
  assert.ok(high.sig.pressure > low.sig.pressure)
  assert.ok(high.sig.scarcityConfidence < USAGE_CONFIDENCE.provider_api, 'an estimate in the reading lowers its confidence')
  const cost = expectedJobCost({ snapshot: high.s, candidate: { capabilities: {}, reliability: { score: 0.8, confidence: 0.99 } }, profile: profile(), policy, now: NOW_MS })
  assert.ok(close(cost.confidence, high.sig.scarcityConfidence), 'the expected cost inherits the lower trust')
})

test('the hard floor has no step either, whatever the soft floor is set to', () => {
  // With the soft floor at, under or missing from the hard one there is no band between them, and
  // the line above used to start at the aggressive knee regardless: a balance at the hard floor
  // read 1 and one a cent over it 0.7 (scarcity 1 to 0.4).
  const at = (remaining, soft, hard) => scarcityOf(snap({
    resourceId: 'ds', provider: 'deepseek', adapter: 'deepseek-api', source: 'api', limits: [money(remaining)],
    economics: { marginalCost: 'metered', pricing: null, rateNow: null, peak: null, budget: { remaining, currency: 'CNY', soft, hard } },
  }), policy, NOW_MS)
  for (const [soft, hard] of [[5, 5], [3, 5], [0, 5], [null, 5], [10, 5], [10, null]]) {
    const edge = hard ?? 0
    const floor = at(edge, soft, hard)
    const cent = at(edge + 0.01, soft, hard)
    assert.equal(floor.pressure, 1, `soft ${soft} hard ${hard}: at the hard floor`)
    assert.ok(cent.pressure > 0.99, `soft ${soft} hard ${hard}: a cent over reads ${cent.pressure}`)
    assert.ok(Math.abs(floor.scarcity - cent.scarcity) < 0.01, `soft ${soft} hard ${hard}: scarcity ${floor.scarcity} vs ${cent.scarcity}`)
    // And the soft floor's own edge, where there is one.
    const top = Math.max(soft ?? edge, edge)
    assert.ok(Math.abs(at(top, soft, hard).pressure - at(top + 0.01, soft, hard).pressure) < 0.01, `soft ${soft} hard ${hard}: at the soft floor`)
    assert.equal(at(top * policy.governor.budgetSoftMultiple, soft, hard).pressure, 0, 'eased out at the multiple')
  }
  // Collapsed floors ease out from 1 over the same span a soft floor would.
  assert.ok(close(at(10, 5, 5).pressure, (15 - 10) / (15 - 5)))
  // Floors of nothing have no length to ease over: an empty balance still reads 1, anything
  // above it reads as unfloored rather than as a cliff to 0.
  assert.equal(at(0, 0, 0).pressure, 1)
  assert.equal(at(0.01, 0, 0).pressure, null)
  assert.equal(at(0.01, null, 0).basis, 'unknown')
})

test('the measurement stays the floor when both confidences are 0', () => {
  // staleConfidence 0 ("do not trust stale usage") put the estimate and the balance both at 0,
  // and the tie went to the estimate: a balance between the floors read barely touched.
  const agents = [{ id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }]
  const row = { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 6, currency: 'CNY' }, creditPercent: Math.round(6 / 7 * 100), creditPeak: { amount: 7, currency: 'CNY' }, limits: { minBalance: 5, handoffAtBalance: 10 }, error: null, checkedAt: minutesFromNow(-60), state: 'near', until: null }
  const measured = 0.7 + 0.3 * ((10 - 6) / 5)
  for (const staleConfidence of [0, 0.01, 0.5, 1]) {
    const pol = resolvePolicy({ governor: { staleConfidence } })
    const [s] = snapshotResources({ agents, usage: { deepseek: row }, now: NOW_MS, policy: pol })
    const sc = scarcityOf(s, pol, NOW_MS)
    assert.ok(close(sc.pressure, measured), `staleConfidence ${staleConfidence}: pressure ${sc.pressure}`)
    assert.ok(sc.scarcity > 0.85, `staleConfidence ${staleConfidence}: scarcity ${sc.scarcity}`)
  }
  // By hand too: a low share at confidence 0 against a floor reading at confidence 0.
  const zero = estimated(7.5, 8, { confidence: 0 })
  assert.equal(scarcityOf(estSnap(zero), policy, NOW_MS).pressure, scarcityOf(budgetSnap(7.5), policy, NOW_MS).pressure)
  // And a provider-reported total (a tie at full confidence) never reads under its floors either.
  assert.ok(close(scarcityOf(budgetSnap(7.5, { total: 12 }), policy, NOW_MS).pressure, 0.85), 'a share of 37.5% does not hide a balance between the floors')
})

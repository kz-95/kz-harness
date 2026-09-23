// The maturity ladder: what a routing domain must prove before it decides alone, what pulls the
// privilege back, and how it is earned again. Scenarios R through AC of the routing design.
//
// The gates are lowered through the policy so a test can reach LOCAL_ONLY in a second; the shape
// of every check is the shipped one, only the sample counts are small. Samples are synthetic and
// separable, so a correctly trained classifier really is accurate and a deliberately noisy one
// really is not: nothing here asserts on a number a stub handed it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_VERSION, createDomainController, createDomainRegistry, jsDivergence, psi, splitRows } from '../domains.js'
import { createTrainingStore } from '../training.js'
import { mergePolicy, resolvePolicy } from '../routing-policy.js'

const dir = () => mkdtempSync(join(tmpdir(), 'kz-domains-'))
const NOW = Date.parse('2026-09-22T12:00:00.000Z')

/**
 * Small gates, shipped shape. Every threshold a test relies on is stated here, not in the code.
 * Recent accuracy is read from rows the classifier was not trained on, and it trains on the oldest
 * 70%, so a rung's recent window is the smaller of 30 and the unseen share of its sample gate:
 * 12 rows for GUARDED_LOCAL (of 40) and 18 for LOCAL_ONLY (of 60).
 */
const smallPolicy = (over = {}) => resolvePolicy(mergePolicy({
  gates: {
    LOW: {
      shadowSamples: 20, guardedSamples: 40, localOnlySamples: 60,
      perClassSamples: 10, holdoutSamples: 5, recentWindow: 30,
      guarded: { accuracy: 0.9, recentAccuracy: 0.9, macroF1: 0.85, maxEce: 0.2 },
      localOnly: { accuracy: 0.9, recentAccuracy: 0.9, macroF1: 0.85, maxEce: 0.25 },
      maxHighConfidenceError: 0.2, confidenceThreshold: 0.7,
      minOutcomeBacked: 0.5, maxTeacherOnly: 0.5,
      rollback: { recentAccuracyFloor: 0.8, maxEce: 0.3, repromoteSamples: 5 },
    },
    MEDIUM: {
      shadowSamples: 20, guardedSamples: 40, localOnlySamples: 60,
      perClassSamples: 10, holdoutSamples: 5, recentWindow: 30,
      guarded: { accuracy: 0.9, recentAccuracy: 0.9, macroF1: 0.85, maxEce: 0.2 },
      localOnly: { accuracy: 0.9, recentAccuracy: 0.9, macroF1: 0.85, maxEce: 0.25 },
      maxHighConfidenceError: 0.2, confidenceThreshold: 0.7,
      minOutcomeBacked: 0.5, maxTeacherOnly: 0.5,
      rollback: { recentAccuracyFloor: 0.8, maxEce: 0.3, repromoteSamples: 5 },
    },
  },
  retrain: { minSamples: 10, everyNewSamples: 1, epochs: 400, learningRate: 0.3 },
  minClassRecall: 0.5,
}, over))

/** A separable two-class problem: `score` above 0.5 is 'high'. */
const sample = (i, { noisy = false, shift = 0 } = {}) => {
  const high = i % 2 === 0
  const score = (high ? 0.75 : 0.25) + ((i % 5) - 2) * 0.02 + shift
  return {
    features: { numeric: { score, other: (i % 7) / 7 }, categorical: { kind: high ? 'a' : 'b' } },
    label: noisy && i % 3 === 0 ? (high ? 'low' : 'high') : high ? 'high' : 'low',
  }
}

/** Fill a store with verified samples for one domain. */
async function fill(store, domain, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    const s = sample(i, opts)
    const row = await store.append({
      domain,
      input: { features: s.features },
      teacher: { label: s.label, probabilities: { [s.label]: 0.9 }, confidence: 0.9, model: 'jev-test' },
      local: null,
      authority: 'jev',
    })
    await store.resolveOutcome(row.id, {
      label: s.label,
      labelSource: opts.teacherOnly ? 'teacher_confirmed' : 'verified_outcome',
      verified: true,
      details: { finalStatus: opts.failing && i % 2 === 0 ? 'needs_human' : 'accepted', attempts: opts.attempts ?? 1, escalated: false },
    })
  }
}

const controller = ({ domain = 'task_classification', policy = smallPolicy(), store, root = dir(), now = () => NOW } = {}) =>
  createDomainController({ domain, policy, store, artifactsDir: join(root, 'classifiers'), stateFile: join(root, `${domain}.state.json`), now })

const storeAt = (root) => createTrainingStore({ file: join(root, 'samples.jsonl') })
const teacher = (label, confidence = 0.9) => async () => ({ label, probabilities: { [label]: confidence }, confidence, model: 'jev-test' })
const fallback = (label = 'low') => () => ({ label, probabilities: { [label]: 1 }, confidence: 0.5 })
const highFeatures = { numeric: { score: 0.8, other: 0.3 }, categorical: { kind: 'a' } }

/** Climb the ladder by evaluating until the target is reached or the budget runs out. */
async function climbTo(ctl, target, rounds = 8) {
  for (let i = 0; i < rounds && ctl.state().maturity !== target; i++) await ctl.evaluate()
  return ctl.state().maturity
}

test('scenario R: accurate but far too few samples is not a promotion', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 12)
  const ctl = controller({ store, root })
  const ev = await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'twelve samples cannot buy a rung, however separable they are')
  const gate = ev.gates.find((g) => g.name === 'verified samples')
  assert.equal(gate.required, 20)
  assert.equal(gate.actual, 12)
  assert.equal(gate.ok, false)
  assert.ok(ctl.state().progress.blocked.includes('verified samples'), 'and the inspector is told which gate blocked it')
})

/** A verified row that says what the answer was NOT: a failed run, or a person's correction. */
async function refute(store, domain, teacherLabel, { human = false, features = highFeatures } = {}) {
  const row = await store.append({ domain, input: { features }, teacher: { label: teacherLabel, probabilities: { [teacherLabel]: 0.9 }, confidence: 0.9, model: 'jev-test' }, local: null, authority: 'jev' })
  await store.resolveOutcome(row.id, { label: null, negativeLabel: teacherLabel, labelSource: human ? 'human' : 'verified_negative', verified: true, details: { finalStatus: 'needs_human', attempts: 1, escalated: false } })
}

test('recent accuracy over a thin window is not a promotion, however many rows were verified', async () => {
  // Enough VERIFIED rows to pass the sample gate, but most of them are refutations, which say
  // what the answer was not and so are not examples the classifier can learn from or be scored
  // on. The 40-row sample gate implies a recent window of at least 12 unseen rows (what a 70%
  // training slice leaves of 40); the largest window this domain has is far smaller.
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 25)
  for (let i = 0; i < 30; i++) await refute(store, 'task_classification', 'high')
  const ctl = controller({ store, root })
  const reached = await climbTo(ctl, 'GUARDED_LOCAL')
  assert.equal(reached, 'SHADOW', 'the sample gate passed, the thin recent window did not')
  const ev = ctl.state().lastEvaluation
  assert.ok(ev.samples.verified >= 40, `the verified count alone would have allowed it (${ev.samples.verified})`)
  const gate = ctl.state().progress.gates.find((g) => g.name === 'recent window')
  assert.equal(gate.required, 12)
  // Of the 25 real examples the classifier trained on the oldest 17, so only 8 are rows it has
  // not seen, and only those can say how it does on recent traffic.
  assert.equal(gate.actual, 8)
  assert.equal(gate.ok, false)
  assert.ok(ctl.state().progress.blocked.includes('recent window'))
})

test('a refuted answer is never counted as the right one', async () => {
  // A failed run and a person's "that was a misread" both record what the answer was NOT. Neither
  // may be read back as the teacher having been right, which is what falling through to the
  // teacher's label did - and the person's correction counted at full, outcome-backed weight.
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 40)
  for (let i = 0; i < 10; i++) await refute(store, 'task_classification', 'high', { features: { numeric: { score: 0.25, other: 0.1 }, categorical: { kind: 'b' } } })
  for (let i = 0; i < 10; i++) await refute(store, 'task_classification', 'high', { human: true, features: { numeric: { score: 0.25, other: 0.1 }, categorical: { kind: 'b' } } })
  const ctl = controller({ store, root })
  const ev = await ctl.evaluate()
  assert.equal(ev.samples.verified, 60, 'all sixty rows are verified evidence')
  assert.equal(ev.classes.counts.high, 20, 'but only the twenty real "high" answers are counted as high, not the twenty refuted ones')
  assert.equal(ev.classes.counts.low, 20)
})

test('a resource ranker learns from the picks that worked, not from the ones runs proved wrong', async () => {
  // The teacher keeps picking the worst-fitting resource and the runs keep proving it wrong; far
  // fewer runs show the best fit winning. Read as positives, the refutations outvote the truth
  // and the ranker learns the teacher's mistake. Read correctly, only the real wins teach it.
  const root = dir()
  const store = storeAt(root)
  const domain = 'resource_selection'
  const set = (best) => [0, 1, 2].map((k) => ({ key: `RESOURCE_${'ABC'[k]}`, features: { numeric: { fit: k === best ? 0.9 : 0.3, scarcity: 0.2 }, categorical: { source: 'api' } } }))
  for (let i = 0; i < 400; i++) {
    const best = i % 3
    const candidates = set(best)
    const refuted = i % 4 !== 0
    const worst = (best + 1) % 3
    const pick = refuted ? candidates[worst].key : candidates[best].key
    const row = await store.append({ domain, input: { features: { numeric: { risk: 0.2 }, categorical: {} }, candidates }, teacher: { chosenKey: pick, probabilities: {}, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, refuted
      ? { chosenKey: null, negativeKey: pick, labelSource: 'verified_negative', verified: true, details: { finalStatus: 'needs_human', attempts: 1, escalated: false } }
      : { chosenKey: pick, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const ctl = controller({ domain, store, root })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  const d = await ctl.decide({ features: { numeric: { risk: 0.2 }, categorical: {} }, candidates: set(2), jev: async () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 1 }), fallback: () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 0.5 }) })
  assert.equal(d.chosenKey, 'RESOURCE_C', 'it picks the best fit, not the worst fit the teacher kept failing with')
})

test('scenario S: high accuracy with poor calibration does not promote past SHADOW', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 80)
  // The shipped gates with a calibration ceiling nothing can meet: accuracy and samples pass,
  // calibration is the only thing standing in the way, which is exactly what is under test.
  const ctl = controller({ store, root, policy: smallPolicy({ gates: { LOW: { guarded: { accuracy: 0.9, recentAccuracy: 0.9, macroF1: 0.85, maxEce: 0 } } } }) })
  await climbTo(ctl, 'SHADOW')
  assert.equal(ctl.state().maturity, 'SHADOW')
  const ev = await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'SHADOW', 'calibration is a gate, not a nicety')
  assert.ok(ev.holdout.accuracy >= 0.9, 'the classifier really is accurate')
  const gate = ev.gates.find((g) => g.name === 'calibration error')
  assert.equal(gate.ok, false)
  assert.equal(gate.atMost, true, 'and it is reported as a ceiling, not a floor')
})

test('scenarios T and V: GUARDED_LOCAL decides the confident familiar cases and defers the rest', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')

  let asked = 0
  const confident = await ctl.decide({ features: highFeatures, jev: async () => { asked++; return { label: 'low', probabilities: { low: 1 }, confidence: 1 } }, fallback: fallback() })
  assert.equal(confident.authority, 'local')
  assert.equal(confident.label, 'high')
  assert.equal(confident.jevCalled, false, 'a confident in-distribution decision costs no Jev call')
  assert.equal(asked, 0)
  assert.ok(confident.confidence >= confident.requiredConfidence)

  // Scenario V: an input the classifier cannot call goes to the teacher, and says why.
  const unsure = { numeric: { score: 0.5, other: 0.5 }, categorical: { kind: 'a' } }
  const deferred = await ctl.decide({ features: unsure, jev: teacher('low'), fallback: fallback() })
  if (deferred.authority === 'jev') {
    assert.equal(deferred.jevCalled, true)
    assert.match(deferred.reason, /confidence|distribution/)
  } else {
    assert.ok(deferred.confidence >= deferred.requiredConfidence, 'it only decided locally because it was confident')
  }
})

test('scenario U and AC: LOCAL_ONLY handles a normal workload with no Jev calls at all', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'LOCAL_ONLY'), 'LOCAL_ONLY')
  let asked = 0
  const jev = async () => { asked++; return { label: 'low', probabilities: { low: 1 }, confidence: 1 } }
  let local = 0
  for (let i = 0; i < 50; i++) {
    const d = await ctl.decide({ features: sample(i).features, jev, fallback: fallback() })
    if (d.authority === 'local') local++
  }
  assert.equal(asked, 0, 'fifty in-distribution decisions, zero teacher calls')
  assert.equal(local, 50)
})

test('the ladder is climbed one rung at a time and never skipped', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 200)
  const ctl = controller({ store, root })
  const seen = [ctl.state().maturity]
  for (let i = 0; i < 4; i++) { await ctl.evaluate(); seen.push(ctl.state().maturity) }
  assert.deepEqual(seen.slice(0, 4), ['JEV_PRIMARY', 'SHADOW', 'GUARDED_LOCAL', 'LOCAL_ONLY'], 'one rung per evaluation, in order')
})

test('scenario P: in SHADOW the teacher decides and both answers are recorded', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 25)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'SHADOW')
  assert.equal(ctl.state().maturity, 'SHADOW')
  const d = await ctl.decide({ features: highFeatures, jev: teacher('low'), fallback: fallback() })
  assert.equal(d.authority, 'jev', 'shadow means the teacher still decides')
  assert.equal(d.label, 'low')
  assert.ok(d.local, 'while the local classifier answered too')
  assert.equal(d.local.label, 'high')
  const row = await store.get(d.sampleId)
  assert.equal(row.teacher.label, 'low')
  assert.equal(row.local.label, 'high')
  const stats = await store.stats('task_classification')
  assert.ok(stats.localAgreement.n >= 1, 'and the disagreement is counted for the shadow comparison')
})

test('scenario W: an unseen category pulls LOCAL_ONLY down and hands the decision to the teacher', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  const strange = { numeric: { score: 0.8, other: 0.3 }, categorical: { kind: 'something-new' } }
  const d = await ctl.decide({ features: strange, jev: teacher('low'), fallback: fallback() })
  assert.equal(d.authority, 'jev')
  assert.ok(d.ood.flag)
  assert.ok(d.ood.reasons.some((r) => r.startsWith('unseen_category')))
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'and the domain steps down rather than deciding alone next time')
  assert.match(ctl.state().rollbackReason, /out of distribution/)
})

test('scenario X: a sustained accuracy breach rolls LOCAL_ONLY back, and one window alone does not', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  // Fresh evidence that contradicts the artifact: the same features, the opposite labels.
  for (let i = 0; i < 40; i++) {
    const s = sample(i)
    const flipped = s.label === 'high' ? 'low' : 'high'
    const row = await store.append({ domain: 'task_classification', input: { features: s.features }, teacher: { label: flipped, probabilities: { [flipped]: 0.9 }, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { label: flipped, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const ev = await ctl.evaluate({ retrain: false })
  assert.ok(ev.recent.accuracy < 0.8, `recent accuracy collapsed (${ev.recent.accuracy})`)
  assert.notEqual(ctl.state().maturity, 'LOCAL_ONLY', 'a collapse that large is severe and does not wait for a second window')
  assert.equal(ctl.state().rollbackSeverity, 'severe')
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'a severe regression goes all the way back to the teacher')
})

test('scenario Y: a critical failure drops the domain to JEV_PRIMARY at once', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  ctl.noteCriticalFailure('a safety rule was bypassed by a routing defect')
  const s = ctl.state()
  assert.equal(s.maturity, 'JEV_PRIMARY')
  assert.equal(s.rollbackSeverity, 'critical')
  assert.match(s.rollbackReason, /safety rule/)
  const d = await ctl.decide({ features: highFeatures, jev: teacher('low'), fallback: fallback() })
  assert.equal(d.authority, 'jev', 'and it decides nothing by itself until it climbs again')
})

test('scenario Z: after a rollback the rung is earned back, not handed back', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const policy = smallPolicy({ repromotion: { consecutiveWindows: 2 } })
  const ctl = controller({ store, root, policy })
  await climbTo(ctl, 'GUARDED_LOCAL')
  ctl.noteEnvironmentChange({ kind: 'new_resource', detail: 'a resource appeared' })
  ctl.noteCriticalFailure('verified high-risk mistake')
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY')
  // A critical rollback is the worst kind, so it faces the same re-promotion gate as any other
  // rollback and not a weaker one: the ninety samples already in hand when the rung was lost buy
  // nothing, however often the domain is evaluated.
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'evaluating is not evidence')
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'and evaluating twice is not evidence either')
  await fill(store, 'task_classification', 10)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'one good window on new evidence is one short')
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'and the same window looked at twice is still one window')
  await fill(store, 'task_classification', 2)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'SHADOW', 'two consecutive good windows on new evidence earn one rung')
  // The rung it lost was GUARDED_LOCAL, so that one is owed too, and it is owed on evidence that
  // arrived after SHADOW was earned, not on the rows that just earned SHADOW.
  await ctl.evaluate()
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'SHADOW', 'every rung up to the one lost is re-earned, not only the first')
  await fill(store, 'task_classification', 6)
  await ctl.evaluate()
  await fill(store, 'task_classification', 2)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'on new rows over two windows of its own')
  assert.equal(ctl.state().rollbackAt, null, 'and back on the rung it lost, the rollback is paid off')
  assert.equal(ctl.state().recoverTo, null)
})

test('re-promotion after a non-critical rollback waits for new evidence and two good windows', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const policy = smallPolicy()
  const ctl = controller({ store, root, policy })
  await climbTo(ctl, 'LOCAL_ONLY')
  const strange = { numeric: { score: 0.8, other: 0.3 }, categorical: { kind: 'brand-new' } }
  await ctl.decide({ features: strange, jev: teacher('low'), fallback: fallback() })
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
  // No new verified evidence yet: the rung stays lost however good the old numbers look.
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'the same evidence that lost the rung cannot win it back')
  // The one decision it has made was the unfamiliar one, so its OOD rate is over oodRateDegrade,
  // and LOCAL_ONLY with that rate is a rung it would lose again at once. Ordinary traffic brings
  // the rate down; until then the rate alone keeps it where it is.
  await fill(store, 'task_classification', 10)
  await ctl.evaluate()
  await fill(store, 'task_classification', 2)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'a pending out-of-distribution rate is not a window to climb on')
  assert.ok(ctl.state().progress.blocked.includes('no pending regression'))
  for (let i = 0; i < 20; i++) await ctl.decide({ features: sample(i).features, jev: teacher(sample(i).label), fallback: fallback() })
  await fill(store, 'task_classification', 2)
  await ctl.evaluate()
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'one batch of new rows is one window, however often it is evaluated')
  await fill(store, 'task_classification', 2)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'LOCAL_ONLY', 'new evidence over two consecutive windows does')
})

test('the rows that caused a rollback are not the new evidence that undoes it', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  // Forty contradicting rows arrive between one evaluation and the next: the same features with
  // the opposite labels, which is what collapses the recent window and loses the rung.
  for (let i = 0; i < 40; i++) {
    const s = sample(i)
    const flipped = s.label === 'high' ? 'low' : 'high'
    const row = await store.append({ domain: 'task_classification', input: { features: s.features }, teacher: { label: flipped, probabilities: { [flipped]: 0.9 }, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { label: flipped, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'a collapse that large is severe')
  assert.equal(ctl.state().samplesAtRollback, 140, 'the rollback point is the evidence in hand at the rollback, not at the evaluation before it')
  const ev = await ctl.evaluate({ retrain: false })
  assert.equal(ev.samples.sinceRollback, 0, 'so the forty rows that lost the rung count for nothing towards winning it back')
  await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'and no number of windows over that same evidence hands a rung back')
})

test('a critical rollback found at start-up fixes its point at the first evaluation after it', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  // Twenty more rows land, and only then is the artifact found corrupt at start-up. The count the
  // last evaluation wrote down is stale by twenty, and nothing counted the store in between, so
  // the rollback point is unknown rather than zero or ninety.
  await fill(store, 'task_classification', 20)
  const file = join(root, 'classifiers', 'task_classification.json')
  const artifact = JSON.parse(readFileSync(file, 'utf8'))
  artifact.bias = artifact.bias.map((b) => b + 1) // the checksum no longer matches
  writeFileSync(file, JSON.stringify(artifact))

  const fresh = controller({ store, root })
  fresh.load()
  assert.equal(fresh.state().maturity, 'JEV_PRIMARY')
  assert.equal(fresh.state().rollbackSeverity, 'critical')
  assert.equal(fresh.state().samplesAtRollback, null, 'an uncounted rollback point is unknown, not zero')
  const ev = await fresh.evaluate()
  assert.equal(ev.samples.sinceRollback, 0, 'the whole history is what the domain had when it fell, not evidence it has earned since')
  assert.equal(fresh.state().maturity, 'JEV_PRIMARY')
  await fresh.evaluate()
  assert.equal(fresh.state().maturity, 'JEV_PRIMARY', 'a hundred and ten old samples do not buy a rung back')
  await fill(store, 'task_classification', 10)
  await fresh.evaluate()
  await fill(store, 'task_classification', 2)
  await fresh.evaluate()
  assert.equal(fresh.state().maturity, 'SHADOW', 'new ones over two consecutive windows do')
})

test('scenario AA and AB: domains mature on their own, and a new resource touches only the resource ranker', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const reg = createDomainRegistry({ policy: smallPolicy(), store, artifactsDir: join(root, 'classifiers'), stateDir: root, now: () => NOW })
  const task = reg.get('task_classification')
  const security = reg.get('frontier_escalation')
  await climbTo(task, 'LOCAL_ONLY')
  assert.equal(task.state().maturity, 'LOCAL_ONLY')
  assert.equal(security.state().maturity, 'JEV_PRIMARY', 'a domain with no evidence of its own is still the teacher\'s')
  const d = await security.decide({ features: highFeatures, jev: teacher('yes'), fallback: fallback('no') })
  assert.equal(d.authority, 'jev')

  // Scenario AB: a new resource is about the resource-ranking space, not about task types.
  reg.noteEnvironmentChange({ kind: 'new_resource', detail: 'a coding model was added' })
  assert.equal(task.state().maturity, 'LOCAL_ONLY', 'the mature task classifier is untouched')
  assert.equal(reg.get('resource_selection').state().maturity, 'JEV_PRIMARY')
})

test('a resource ranker at LOCAL_ONLY steps down when a resource is added', async () => {
  const root = dir()
  const store = storeAt(root)
  const domain = 'resource_selection'
  // Ranking samples: three candidates, the one with the best fit is the right answer.
  for (let i = 0; i < 100; i++) {
    const best = i % 3
    const candidates = [0, 1, 2].map((k) => ({ key: `RESOURCE_${'ABC'[k]}`, features: { numeric: { fit: k === best ? 0.9 : 0.3, scarcity: 0.2 }, categorical: { source: 'api' } } }))
    const row = await store.append({ domain, input: { features: { numeric: { risk: 0.2 }, categorical: {} }, candidates }, teacher: { chosenKey: candidates[best].key, probabilities: {}, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { chosenKey: candidates[best].key, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const ctl = controller({ domain, store, root })
  assert.equal(await climbTo(ctl, 'LOCAL_ONLY'), 'LOCAL_ONLY')
  const candidates = [0, 1, 2].map((k) => ({ key: `RESOURCE_${'ABC'[k]}`, features: { numeric: { fit: k === 1 ? 0.9 : 0.3, scarcity: 0.2 }, categorical: { source: 'api' } } }))
  const d = await ctl.decide({ features: { numeric: { risk: 0.2 }, categorical: {} }, candidates, jev: async () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 1 }), fallback: () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 0.5 }) })
  assert.equal(d.authority, 'local')
  assert.equal(d.chosenKey, 'RESOURCE_B', 'it learned to read the fit, not the position')
  ctl.noteEnvironmentChange({ kind: 'new_resource', detail: 'RESOURCE_D appeared' })
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
})

test('an unfamiliar candidate is out of distribution even when every feature is ordinary', async () => {
  const root = dir()
  const store = storeAt(root)
  const domain = 'resource_selection'
  for (let i = 0; i < 100; i++) {
    const best = i % 2
    const candidates = [0, 1].map((k) => ({ key: `RESOURCE_${'AB'[k]}`, features: { numeric: { fit: k === best ? 0.9 : 0.3 }, categorical: { source: 'api' } } }))
    const row = await store.append({ domain, input: { features: { numeric: { risk: 0.2 }, categorical: {} }, candidates }, teacher: { chosenKey: candidates[best].key, probabilities: {}, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { chosenKey: candidates[best].key, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const ctl = controller({ domain, store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  const withNew = [
    { key: 'RESOURCE_A', features: { numeric: { fit: 0.9 }, categorical: { source: 'api' } } },
    { key: 'RESOURCE_Z', features: { numeric: { fit: 0.3 }, categorical: { source: 'api' } } },
  ]
  const d = await ctl.decide({ features: { numeric: { risk: 0.2 }, categorical: {} }, candidates: withNew, jev: async () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 1 }), fallback: () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 0.5 }) })
  assert.equal(d.authority, 'jev', 'a resource this domain has never ranked is not something to decide alone')
  assert.ok(d.ood.reasons.includes('unfamiliar_candidate:RESOURCE_Z'))
})

test('with the teacher down, an immature domain uses the fallback and never invents a classification', async () => {
  const root = dir()
  const store = storeAt(root)
  const ctl = controller({ store, root })
  const down = async () => { throw new Error('HTTP 503') }
  const d = await ctl.decide({ features: highFeatures, jev: down, fallback: fallback('low') })
  assert.equal(d.authority, 'fallback')
  assert.equal(d.label, 'low', 'the deterministic answer, not a guess dressed up as a classification')
  assert.match(d.reason, /unavailable/)
  assert.equal(d.local, null)
})

test('a mature domain is unaffected by the teacher being down, and still defers what it cannot call', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  const down = async () => { throw new Error('HTTP 503') }
  // Confident and familiar: it never needed the teacher, so the teacher being down changes nothing.
  const confident = await ctl.decide({ features: highFeatures, jev: down, fallback: fallback('low') })
  assert.equal(confident.authority, 'local')
  assert.equal(confident.label, 'high')
  assert.equal(confident.jevCalled, false)
  // Unfamiliar: it would have asked, the teacher is gone, so it takes the deterministic answer
  // rather than deciding something it has no standing to decide.
  const strange = { numeric: { score: 0.8, other: 0.3 }, categorical: { kind: 'never-seen' } }
  const deferred = await ctl.decide({ features: strange, jev: down, fallback: fallback('low') })
  assert.equal(deferred.authority, 'fallback')
  assert.equal(deferred.label, 'low')
  assert.match(deferred.reason, /unavailable/)
})

test('every decision becomes a training sample, whoever made it', async () => {
  const root = dir()
  const store = storeAt(root)
  const ctl = controller({ store, root })
  const a = await ctl.decide({ features: highFeatures, jev: teacher('high'), fallback: fallback() })
  const b = await ctl.decide({ features: highFeatures, jev: null, fallback: fallback('low') })
  assert.ok(a.sampleId && b.sampleId)
  const rows = await store.list({ domain: 'task_classification' })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.authority), ['jev', 'fallback'])
  assert.equal(rows[0].teacher.label, 'high')
  assert.equal(rows[1].teacher, null)
})

test('a corrupt artifact is a critical fact, not a missing file', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  const { writeFileSync } = await import('node:fs')
  const file = join(root, 'classifiers', 'task_classification.json')
  const artifact = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'))
  artifact.bias = artifact.bias.map((b) => b + 1) // the checksum no longer matches
  writeFileSync(file, JSON.stringify(artifact))
  const fresh = controller({ store, root })
  fresh.load()
  assert.equal(fresh.state().maturity, 'JEV_PRIMARY')
  assert.match(fresh.state().rollbackReason, /artifact unusable/)
  assert.equal(fresh.state().rollbackSeverity, 'critical')
})

test('state and artifact survive a restart', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  const fresh = controller({ store: storeAt(root), root })
  const s = fresh.load()
  assert.equal(s.maturity, 'GUARDED_LOCAL')
  assert.ok(s.artifact, 'and its classifier came back with it')
  assert.equal(s.artifact.featureSchemaVersion, 1)
})

test('psi and jsDivergence on hand-built distributions', () => {
  const same = Array.from({ length: 100 }, (_, i) => i / 100)
  assert.ok(psi(same, same) < 1e-9, 'a distribution against itself is no drift at all')
  const shifted = same.map((v) => v + 1)
  assert.ok(psi(same, shifted) > 0.2, `a full shift is meaningful drift (${psi(same, shifted)})`)
  assert.equal(psi([], [1, 2]), 0, 'nothing to compare is not drift')
  assert.equal(psi([1, 1, 1], [1, 1, 1]), 0, 'a constant feature cannot drift')

  assert.equal(jsDivergence({ a: 5 }, { a: 5 }), 0)
  assert.equal(jsDivergence({ a: 1 }, { b: 1 }), 1, 'two disjoint vocabularies are one bit apart')
  assert.ok(jsDivergence({ a: 9, b: 1 }, { a: 1, b: 9 }) > 0.2)
  assert.equal(jsDivergence({}, { a: 1 }), 0, 'an empty side says nothing')
})

test('splitRows keeps time order: oldest trains, newest is held out', () => {
  const rows = Array.from({ length: 10 }, (_, i) => i)
  const { train, validation, holdout } = splitRows(rows, { train: 0.7, validation: 0.15, holdout: 0.15 })
  assert.deepEqual(train, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(validation, [7])
  assert.deepEqual(holdout, [8, 9])
  assert.ok(Math.max(...train) < Math.min(...holdout), 'no future row can leak into training')
})

test('label quality gates LOCAL_ONLY: teacher-confirmed evidence alone is not enough', async () => {
  const root = dir()
  const store = storeAt(root)
  // Every label here is `teacher_confirmed`: the teacher's own pick went on to be accepted, which
  // is the teacher agreeing with itself rather than the run proving anything.
  await fill(store, 'task_classification', 100, { teacherOnly: true })
  const ctl = controller({ store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
  const ev = await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'copying the teacher does not earn independence from it')
  const gate = ev.gates.find((g) => g.name === 'teacher-only share')
  assert.equal(gate.ok, false)
  assert.equal(ev.labelQuality.outcomeBackedShare, 0, 'none of it is independent evidence')
  // The same domain with evidence the runs proved does reach LOCAL_ONLY.
  const proven = dir()
  const store2 = storeAt(proven)
  await fill(store2, 'task_classification', 100)
  const ctl2 = controller({ store: store2, root: proven })
  assert.equal(await climbTo(ctl2, 'LOCAL_ONLY'), 'LOCAL_ONLY')
})

test('a high-risk domain is held to its own recall floor, not the global one', async () => {
  // Labels flipped on a third of the rows: the classifier still learns the separable feature, so
  // every class is recalled about two times in three. The other bars are set loose enough that
  // recall is the only thing standing between SHADOW and GUARDED_LOCAL.
  const high = (minClassRecall) => ({
    shadowSamples: 20, guardedSamples: 40, localOnlySamples: 60,
    perClassSamples: 10, holdoutSamples: 5, recentWindow: 30,
    guarded: { accuracy: 0.5, recentAccuracy: 0.5, macroF1: 0.5, maxEce: 1 },
    localOnly: { accuracy: 0.5, recentAccuracy: 0.5, macroF1: 0.5, maxEce: 1 },
    maxHighConfidenceError: 1, confidenceThreshold: 0.7,
    minOutcomeBacked: 0.5, maxTeacherOnly: 0.5,
    rollback: { recentAccuracyFloor: 0.3, maxEce: 1, repromoteSamples: 5 },
    ...(minClassRecall === undefined ? {} : { minClassRecall }),
  })
  const run = async (policy) => {
    const root = dir()
    const store = storeAt(root)
    await fill(store, 'frontier_escalation', 100, { noisy: true })
    const ctl = controller({ domain: 'frontier_escalation', store, root, policy })
    await climbTo(ctl, 'GUARDED_LOCAL')
    return ctl.state()
  }
  const global = await run(smallPolicy({ gates: { HIGH: high() } }))
  assert.equal(global.maturity, 'GUARDED_LOCAL', 'the global 0.5 floor passes this recall')
  const strict = await run(smallPolicy({ gates: { HIGH: high(0.9) } }))
  assert.equal(strict.maturity, 'SHADOW', 'the high-risk floor does not')
  const gate = strict.progress.gates.find((g) => g.name === 'recall on every significant class')
  assert.equal(gate.required, 0.9)
  assert.ok(gate.actual >= 0.5 && gate.actual < 0.9, `recall ${gate.actual} sits between the two floors`)
  assert.deepEqual(strict.progress.blocked, ['recall on every significant class'])
  // A policy put together without resolvePolicy has no per-risk value written in, and still has a floor.
  const bare = smallPolicy({ gates: { HIGH: high() } })
  const unresolved = { ...bare, minClassRecall: 0.9, gates: { ...bare.gates, HIGH: { ...bare.gates.HIGH, minClassRecall: undefined } } }
  assert.equal((await run(unresolved)).maturity, 'SHADOW', 'the global floor stands in for a missing per-risk one')
})

/** Drive a LOCAL_ONLY domain into a severe rollback with forty contradicting rows. Returns the controller. */
async function rolledBack(store, root) {
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'LOCAL_ONLY')
  for (let i = 0; i < 40; i++) {
    const s = sample(i)
    const flipped = s.label === 'high' ? 'low' : 'high'
    const row = await store.append({ domain: 'task_classification', input: { features: s.features }, teacher: { label: flipped, probabilities: { [flipped]: 0.9 }, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { label: flipped, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY')
  assert.equal(ctl.state().samplesAtRollback, 140)
  assert.equal(ctl.state().recoverTo, 'LOCAL_ONLY', 'and every rung up to LOCAL_ONLY is owed')
  return ctl
}

test('a rollback saved by the old code is re-anchored once, so its causes do not count towards undoing it', async () => {
  const root = dir()
  const store = storeAt(root)
  await rolledBack(store, root)
  // What the old code wrote: no version, and the count from the evaluation before the rollback,
  // which leaves the forty rows that caused it on the "new evidence" side of the line.
  const file = join(root, 'task_classification.state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.stateVersion, STATE_VERSION, 'the current code stamps what it writes')
  delete saved.stateVersion
  saved.samplesAtRollback = 100
  writeFileSync(file, JSON.stringify(saved))

  const upgraded = controller({ store, root })
  upgraded.load()
  assert.equal(upgraded.state().samplesAtRollback, null, 'the inherited point is not trusted')
  assert.equal(upgraded.state().stateVersion, STATE_VERSION)
  const ev = await upgraded.evaluate({ retrain: false })
  assert.equal(ev.samples.sinceRollback, 0, 'everything already in the store predates the upgrade')
  await upgraded.evaluate({ retrain: false })
  assert.equal(upgraded.state().maturity, 'JEV_PRIMARY', 'the rows that caused the rollback buy nothing back')
  // Once re-anchored and saved, a further restart keeps the point it fixed.
  const again = controller({ store, root })
  again.load()
  assert.equal(again.state().samplesAtRollback, 140)
})

test('a current rollback point survives every restart, so a restarted domain can still earn the rung back', async () => {
  const root = dir()
  const store = storeAt(root)
  await rolledBack(store, root)
  await fill(store, 'task_classification', 10)
  // A restart before each evaluation: were the point re-anchored on load, every one would reset
  // the count to zero and the ten new rows would never be enough.
  let ctl = controller({ store, root })
  ctl.load()
  assert.equal(ctl.state().samplesAtRollback, 140, 'a point the current code wrote is kept as it is')
  let ev = await ctl.evaluate({ retrain: false })
  assert.equal(ev.samples.sinceRollback, 10)
  // The second window needs rows of its own: the first one counted is remembered across the
  // restart, so evaluating the same ten again is not a second window.
  ctl = controller({ store, root })
  ctl.load()
  ev = await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY', 'the same ten rows after a restart are not a new window')
  await fill(store, 'task_classification', 2)
  ctl = controller({ store, root })
  ctl.load()
  ev = await ctl.evaluate({ retrain: false })
  assert.equal(ev.samples.sinceRollback, 12)
  assert.equal(ctl.state().maturity, 'SHADOW', 'two good windows on new evidence, across a restart, earn the rung')
})

test('a sample is written with the run it belongs to', async () => {
  const root = dir()
  const store = storeAt(root)
  const ctl = controller({ store, root })
  const d = await ctl.decide({ features: highFeatures, jev: teacher('high'), fallback: fallback(), context: { runId: 'run-7' } })
  assert.equal((await store.get(d.sampleId)).runId, 'run-7')
  const bare = await ctl.decide({ features: highFeatures, jev: teacher('high'), fallback: fallback() })
  assert.equal((await store.get(bare.sampleId)).runId, null, 'and none is invented when the caller has none')
})

test('a brand-new resource that inherits a familiar key is still unfamiliar', async () => {
  // RESOURCE_x is positional over the pool: remove codex and add a newcomer, and the newcomer can
  // wear the key codex wore. Familiarity is counted by the resource, not the key it happens to get.
  const root = dir()
  const store = storeAt(root)
  const domain = 'resource_selection'
  for (let i = 0; i < 100; i++) {
    const best = i % 2
    const candidates = [['claude', 'RESOURCE_A'], ['codex', 'RESOURCE_B']].map(([id, key], k) => ({ key, id, features: { numeric: { fit: k === best ? 0.9 : 0.3 }, categorical: { source: 'api' } } }))
    const row = await store.append({ domain, input: { features: { numeric: { risk: 0.2 }, categorical: {} }, candidates }, teacher: { chosenKey: candidates[best].key, probabilities: {}, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { chosenKey: candidates[best].key, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const ctl = controller({ domain, store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  const ask = (candidates) => ctl.decide({ features: { numeric: { risk: 0.2 }, categorical: {} }, candidates, jev: async () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 1 }), fallback: () => ({ chosenKey: 'RESOURCE_A', probabilities: {}, confidence: 0.5 }) })
  const known = await ask([{ key: 'RESOURCE_A', id: 'claude', features: { numeric: { fit: 0.9 }, categorical: { source: 'api' } } }, { key: 'RESOURCE_B', id: 'codex', features: { numeric: { fit: 0.3 }, categorical: { source: 'api' } } }])
  assert.ok(!known.ood?.reasons?.some((r) => r.startsWith('unfamiliar_candidate')), 'the resources it trained on are familiar')
  const d = await ask([{ key: 'RESOURCE_A', id: 'claude', features: { numeric: { fit: 0.9 }, categorical: { source: 'api' } } }, { key: 'RESOURCE_B', id: 'newcomer', features: { numeric: { fit: 0.3 }, categorical: { source: 'api' } } }])
  assert.equal(d.authority, 'jev', 'a resource this domain has never ranked is not something to decide alone')
  assert.ok(d.ood.reasons.includes('unfamiliar_candidate:RESOURCE_B'), 'flagged under its key, recognised by its id')
  assert.deepEqual(Object.keys(ctl.artifact().extras.candidateSamples).sort(), ['claude', 'codex'])
  // An artifact trained before the counts were kept by id is read the old way until its next
  // retrain, instead of calling every candidate new at once and flooding the OOD rate.
  const extras = ctl.artifact().extras
  delete extras.candidateKeying
  extras.candidateSamples = { RESOURCE_A: 45, RESOURCE_B: 45 }
  const old = await ask([{ key: 'RESOURCE_A', id: 'claude', features: { numeric: { fit: 0.9 }, categorical: { source: 'api' } } }, { key: 'RESOURCE_B', id: 'codex', features: { numeric: { fit: 0.3 }, categorical: { source: 'api' } } }])
  assert.ok(!old.ood?.reasons?.some((r) => r.startsWith('unfamiliar_candidate')), 'an old artifact does not call its own resources new')
})

/** Verified rows over the same separable features, with the label flipped wherever `flip(i)` says. */
async function labelled(store, n, flip, domain = 'task_classification') {
  for (let i = 0; i < n; i++) {
    const s = sample(i)
    const label = flip(i) ? (s.label === 'high' ? 'low' : 'high') : s.label
    const row = await store.append({ domain, input: { features: s.features }, teacher: { label, probabilities: { [label]: 0.9 }, confidence: 0.9 }, local: null, authority: 'jev' })
    await store.resolveOutcome(row.id, { label, labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
}

test('a pending regression blocks the climb, and the climb does not wipe it', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  // Thirty new rows that all needed a retry: every gate for LOCAL_ONLY passes on them, and the
  // retry rate is several times its baseline, which is the rollback check's first bad window.
  await fill(store, 'task_classification', 30, { attempts: 2 })
  const ev = await ctl.evaluate()
  assert.ok(ev.rates.retry.recent > ev.rates.retry.baseline * 1.5, `the retry rate regressed (${JSON.stringify(ev.rates.retry)})`)
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'a window with a regression in it is not a promotion')
  assert.equal(ctl.state().consecutiveBadWindows, 1, 'and the bad window it counted is still counted')
  const gate = ev.gates.find((g) => g.name === 'no pending regression')
  assert.equal(gate.ok, false)
  assert.match(gate.detail.join(' '), /retry rate/)
  // The same rows again are the same window: pending, not confirmed, and still no climb.
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'looking again is not a second window')
  assert.equal(ctl.state().consecutiveBadWindows, 1)
  // New rows that still need retries confirm it: a sustained regression, one rung down.
  await fill(store, 'task_classification', 5, { attempts: 2 })
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'SHADOW')
  assert.equal(ctl.state().rollbackSeverity, 'significant')
  assert.match(ctl.state().rollbackReason, /retry rate/)
})

test('an out-of-distribution rate over oodRateDegrade blocks the climb to LOCAL_ONLY', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  // At GUARDED_LOCAL an unfamiliar input only goes to the teacher, so nothing else notices that
  // most of what the domain now sees is unfamiliar. LOCAL_ONLY with that rate is a rung the next
  // evaluation would take away again.
  for (let i = 0; i < 5; i++) await ctl.decide({ features: { numeric: { score: 0.8, other: 0.3 }, categorical: { kind: `new-${i}` } }, jev: teacher('high'), fallback: fallback() })
  await fill(store, 'task_classification', 2)
  const ev = await ctl.evaluate()
  assert.ok(ev.oodRate > 0.1, `the OOD rate is over oodRateDegrade (${ev.oodRate})`)
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
  assert.deepEqual(ctl.state().progress.blocked, ['no pending regression'], 'and that is the only thing in the way')
})

test('the rollback calibration check reads the recent window, not the artifact from training time', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  // A ceiling the separable history meets easily, and an accuracy floor the recent window stays over.
  const policy = smallPolicy({ gates: { LOW: { rollback: { recentAccuracyFloor: 0.8, maxEce: 0.1 } } } })
  const ctl = controller({ store, root, policy })
  assert.equal(await climbTo(ctl, 'LOCAL_ONLY'), 'LOCAL_ONLY')
  // One recent row in seven now goes the other way. The classifier is as sure of itself as ever,
  // so its confidence no longer matches how often it is right.
  await labelled(store, 30, (i) => i % 7 === 0)
  const ev = await ctl.evaluate({ retrain: false })
  assert.ok(ev.calibration.ece <= 0.1, `the training-time figure still looks fine (${ev.calibration.ece})`)
  assert.ok(ev.recent.accuracy >= 0.8, `recent accuracy is over its floor (${ev.recent.accuracy})`)
  assert.ok(ev.recent.calibration.ece > 0.1, `calibration on the recent window is not (${ev.recent.calibration.ece})`)
  assert.equal(ctl.state().consecutiveBadWindows, 1, 'which is a bad window')
  await labelled(store, 7, (i) => i % 7 === 0)
  await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().maturity, 'SHADOW', 'and a second one is a sustained regression')
  assert.match(ctl.state().rollbackReason, /calibration error .* on the recent window/)
})

test('recent accuracy is measured only on rows the classifier was not trained on', async () => {
  const root = dir()
  const store = storeAt(root)
  // Sixty rows pass the 40-row sample gate, and the newest thirty of them look like a full recent
  // window. The classifier trained on the oldest 42, so only 18 of those thirty are unseen.
  await fill(store, 'task_classification', 60)
  const ctl = controller({ store, root })
  await climbTo(ctl, 'GUARDED_LOCAL')
  const ev = ctl.state().lastEvaluation
  assert.equal(ev.recent.n, 18, 'the recent window holds only the 18 rows the classifier never saw, not 30 partly in-sample')
  // 18 unseen rows is the largest valid window here (the 40-row sample gate implies 12), so the
  // domain is measured on them and promotes. It is not held to a full window of 30, which the
  // design does not ask for: "use the largest valid recent window".
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
  // An artifact from before the training slice was marked is taken to have seen every row that was
  // verified when it was trained, so only rows after that count as recent.
  const extras = ctl.artifact().extras
  delete extras.trainedThrough
  delete extras.calibratedThrough
  await fill(store, 'task_classification', 10)
  const later = await ctl.evaluate({ retrain: false })
  assert.equal(later.recent.n, 10)
  assert.equal(later.recent.calibration.n, 10)
})

test('a bad window from a rung that was lost does not follow the domain back up', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  // One bad window at GUARDED_LOCAL, and then a critical failure takes the rung before a second
  // window could confirm or clear it.
  await fill(store, 'task_classification', 30, { attempts: 2 })
  await ctl.evaluate()
  assert.equal(ctl.state().consecutiveBadWindows, 1)
  ctl.noteCriticalFailure('verified high-risk mistake')
  assert.equal(ctl.state().consecutiveBadWindows, 0, 'the rollback settles the windows that came before it')
  for (let i = 0; i < 12 && ctl.state().maturity !== 'GUARDED_LOCAL'; i++) {
    await fill(store, 'task_classification', 30)
    await ctl.evaluate()
  }
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'the rung is earned back on clean rows')
  // At the re-earned rung one bad window is the first of a pair, not the second.
  await fill(store, 'task_classification', 30, { attempts: 2 })
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'a small breach needs two consecutive windows')
  assert.equal(ctl.state().consecutiveBadWindows, 1)
})

test('a saved bad-window count at a rung that decides nothing is not carried forward', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const stateFile = join(root, 'task_classification.state.json')
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'SHADOW'), 'SHADOW')
  // A state written by the code that let the count ride a rollback down.
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  writeFileSync(stateFile, JSON.stringify({ ...saved, consecutiveBadWindows: 1, badWindowSamples: 90 }))
  const again = controller({ store, root })
  again.load()
  assert.equal(again.state().consecutiveBadWindows, 0)
  assert.equal(again.state().badWindowSamples, null)
})

test('a bad window counted at the rung it holds keeps the domain from climbing past it', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const policy = smallPolicy({ gates: { LOW: { rollback: { recentAccuracyFloor: 0.8, maxEce: 0.05 } } } })
  const ctl = controller({ store, root, policy })
  assert.equal(await climbTo(ctl, 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  // One confidently wrong row: calibration on the 16 unfitted rows breaches the ceiling, which is
  // read over GUARDED_LOCAL's 12-row window. LOCAL_ONLY reads it over 18 rows, where 16 are too
  // few, so its own gates saw nothing wrong and the domain climbed in the very evaluation that
  // counted the bad window.
  await labelled(store, 1, () => true)
  const ev = await ctl.evaluate({ retrain: false })
  assert.ok(ev.recent.calibration.n >= 12 && ev.recent.calibration.n < 18, `the setting: ${ev.recent.calibration.n} unfitted rows`)
  assert.equal(ctl.state().consecutiveBadWindows, 1, 'a bad window at GUARDED_LOCAL')
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL', 'and no climb while it waits for its next window')
  const gate = ctl.state().progress.gates.find((g) => g.name === 'no pending regression')
  assert.equal(gate.ok, false)
  assert.match(gate.detail.join(' '), /bad window at GUARDED_LOCAL/)
})

test('a recent window too short to measure is not read as a regression', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  const ctl = controller({ store, root })
  assert.equal(await climbTo(ctl, 'LOCAL_ONLY'), 'LOCAL_ONLY')
  // An artifact trained before the training slice was marked: only the rows verified after it
  // count as recent, so right after the upgrade that window is a handful of rows.
  const extras = ctl.artifact().extras
  delete extras.trainedThrough
  delete extras.calibratedThrough
  await labelled(store, 3, (i) => i === 0)
  const ev = await ctl.evaluate({ retrain: false })
  assert.equal(ev.recent.n, 3)
  assert.ok(ev.recent.accuracy < 0.8 - 0.05, `one miss in three reads as a collapse (${ev.recent.accuracy})`)
  assert.equal(ctl.state().maturity, 'LOCAL_ONLY', 'three rows say nothing about a classifier that earned LOCAL_ONLY')
  assert.equal(ctl.state().consecutiveBadWindows, 0, 'not even a bad window')
  // A window as large as the rung's own gate reads is evidence, and a collapse on it acts at once.
  await labelled(store, 20, () => true)
  await ctl.evaluate({ retrain: false })
  assert.equal(ctl.state().rollbackSeverity, 'severe')
  assert.equal(ctl.state().maturity, 'JEV_PRIMARY')
})

test('drift is read from the rows the classifier was not trained on', async () => {
  const root = dir()
  const store = storeAt(root)
  // Sixty rows: the classifier trains on the oldest 42, and the 18 after them are all it has not
  // seen. Thirty is the drift minimum, so a window padded with training rows would be read.
  await fill(store, 'task_classification', 60)
  const ctl = controller({ store, root })
  const ev = await ctl.evaluate()
  assert.ok(ctl.artifact(), 'a classifier was trained')
  assert.equal(ev.drift.level, 'stable')
  assert.match(ev.drift.note, /only 18 recent observations/, 'the 42 rows it trained on are not recent evidence of drift')
})

test('an artifact is not retrained until everyNewSamples new rows arrived', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 200)
  const ctl = controller({ store, root, policy: smallPolicy({ retrain: { everyNewSamples: 50 } }) })
  await ctl.evaluate()
  const first = ctl.artifact()
  assert.equal(first.extras.verifiedSamples, 200)
  await fill(store, 'task_classification', 10)
  const ev = await ctl.evaluate()
  assert.equal(ev.samples.sinceArtifact, 10, 'ten rows since the artifact, not every row outside its training slice')
  assert.equal(ctl.artifact(), first, 'so it is not retrained')
})

test('a retrained classifier serves at a local rung only after passing that rung\'s gates', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  let clock = NOW
  const ctl = controller({ store, root, now: () => (clock += 1000) })
  assert.equal(await climbTo(ctl, 'LOCAL_ONLY'), 'LOCAL_ONLY')
  const serving = ctl.artifact()
  // One new row in six contradicts the rest. The challenger trained on this history scores under
  // the 0.9 LOCAL_ONLY bar on the rows it has not seen; the classifier in service is still over
  // the 0.8 rollback floor on the same rows.
  await labelled(store, 32, (i) => i % 6 === 0)
  const ev = await ctl.evaluate()
  assert.equal(ctl.artifact(), serving, 'the one that earned the rung keeps it')
  assert.equal(ctl.state().maturity, 'LOCAL_ONLY')
  assert.ok(ev.recent.accuracy >= 0.8, 'and it is still over its rollback floor')
  const challenger = ctl.state().challenger
  assert.equal(challenger.rung, 'LOCAL_ONLY')
  assert.ok(challenger.blocked.includes('recent accuracy'), `the challenger was turned down for what it scored (${challenger.blocked})`)
  // It is not retried on every evaluation, only after everyNewSamples more rows.
  await ctl.evaluate()
  assert.equal(ctl.state().challenger.at, challenger.at)
  // Clean evidence makes a challenger that passes, and that one goes into service.
  await fill(store, 'task_classification', 100)
  await ctl.evaluate()
  assert.notEqual(ctl.artifact(), serving)
  assert.equal(ctl.state().challenger, null)
  assert.equal(ctl.state().maturity, 'LOCAL_ONLY')
})

test('with no classifier in service, a challenger that fails the rung steps the domain down', async () => {
  const root = dir()
  const store = storeAt(root)
  await fill(store, 'task_classification', 100)
  // No artifacts directory: the rung is restored from the state file and there is no classifier to
  // restore with it. The new evidence is noisy, so the first one trained fails the rung.
  const stateOnly = () => createDomainController({ domain: 'task_classification', policy: smallPolicy(), store, stateFile: join(root, 'task_classification.state.json'), now: () => NOW })
  assert.equal(await climbTo(stateOnly(), 'GUARDED_LOCAL'), 'GUARDED_LOCAL')
  await labelled(store, 32, (i) => i % 6 === 0)
  const ctl = stateOnly()
  ctl.load()
  assert.equal(ctl.state().maturity, 'GUARDED_LOCAL')
  assert.equal(ctl.artifact(), null)
  await ctl.evaluate()
  assert.equal(ctl.state().maturity, 'SHADOW', 'nothing that passed the rung is left to decide at it')
  assert.equal(ctl.state().rollbackSeverity, 'significant')
  assert.match(ctl.state().rollbackReason, /failed the GUARDED_LOCAL gates/)
  assert.ok(ctl.artifact(), 'and the new classifier is kept, where it only shadows the teacher')
})

test('a version 2 state keeps its rollback point and owes every rung', async () => {
  const root = dir()
  const store = storeAt(root)
  await rolledBack(store, root)
  const file = join(root, 'task_classification.state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.stateVersion = 2
  delete saved.recoverTo
  delete saved.windowSamples
  saved.consecutiveGoodWindows = 1
  writeFileSync(file, JSON.stringify(saved))
  const ctl = controller({ store, root })
  ctl.load()
  assert.equal(ctl.state().samplesAtRollback, 140, 'a version 2 point was counted at the rollback and is kept')
  assert.equal(ctl.state().recoverTo, 'LOCAL_ONLY')
  assert.equal(ctl.state().consecutiveGoodWindows, 0, 'a window it counted may have had no new rows in it')
})

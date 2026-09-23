// The local classifier library: training on separable synthetic problems, calibration and
// its metrics, out-of-distribution checks, evaluation arithmetic and the artifact round trip.
// Every random-looking number comes from a seeded generator, so a run is a run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEATURE_SCHEMA_VERSION } from '../features.js'
import { ROUTING_DEFAULTS } from '../routing-policy.js'
import {
  LIBRARY_VERSION, buildIndex, calibrate, calibrationMetrics, evaluate, loadArtifact, oodCheck, predict, rank,
  saveArtifact, trainMulticlass, trainRanker, vectorize, verifyArtifact,
} from '../classifier.js'

/** A tiny linear congruential generator: the same seed gives the same sequence on every platform. */
const generator = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const CENTERS = { alpha: [-3, 0], beta: [3, 0], gamma: [0, 3] }
const LABELS = Object.keys(CENTERS)
/** One multiclass sample near its class centre, with a categorical that partly agrees with the label. */
const sampleOf = (rnd, label) => ({
  features: { numeric: { x: CENTERS[label][0] + rnd() - 0.5, y: CENTERS[label][1] + rnd() - 0.5 }, categorical: { shape: label === 'gamma' ? 'tall' : 'wide' } },
  label,
})
const multiclassSet = (n, seed = 7) => { const rnd = generator(seed); return Array.from({ length: n }, (_, i) => sampleOf(rnd, LABELS[i % 3])) }
/** Ranking groups where the right pick is the candidate with the largest fit minus scarcity. */
const groupsOf = (n, seed = 11) => {
  const rnd = generator(seed)
  return Array.from({ length: n }, () => {
    const candidates = Array.from({ length: 3 }, (_, i) => ({ key: `RESOURCE_${'ABC'[i]}`, features: { numeric: { fit: rnd(), scarcity: rnd() } } }))
    const chosenIndex = candidates.map((c, i) => [c.features.numeric.fit - c.features.numeric.scarcity, i]).sort((a, b) => b[0] - a[0])[0][1]
    return { candidates, chosenIndex }
  })
}
/** Groups whose chosen candidate is wrong four times in ten: enough noise to need cooling down. */
const noisyGroups = (groups, seed = 77) => {
  const rnd = generator(seed)
  return groups.map((g) => ({ ...g, chosenIndex: rnd() < 0.4 ? Math.floor(rnd() * g.candidates.length) : g.chosenIndex }))
}
/**
 * Negative log likelihood of a set of raw (temperature 1) probability rows at temperature T,
 * rebuilt from the probabilities alone: softmax(log(p) / T) is softmax(z / T) up to the constant
 * the softmax cancels, so this recomputes the grid search without reading the artifact's weights.
 */
const nllAt = (rows, T) => rows.reduce((acc, { p, truth }) => {
  const z = p.map((v) => Math.log(Math.max(1e-300, v)) / T)
  const m = Math.max(...z)
  const e = z.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return acc - Math.log(Math.max(1e-300, e[truth] / s))
}, 0) / rows.length
/** Every temperature the contract's grid search may return: [0.5, 5] in steps of 0.05. */
const GRID = Array.from({ length: 91 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100)
const clock = () => Date.parse('2026-09-22T00:00:00.000Z')
const tmp = () => mkdtempSync(join(tmpdir(), 'kz-classifier-'))
const near = (actual, expected, message, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${message}: ${actual} is not ${expected}`)

test('learns a separable multiclass problem and is deterministic', () => {
  const all = multiclassSet(300)
  const train = all.slice(0, 200)
  const artifact = trainMulticlass({ samples: train, domain: 'task_classification', now: clock })
  const held = evaluate(artifact, all.slice(200))
  assert.ok(held.accuracy > 0.95, `held-out accuracy ${held.accuracy} should beat 0.95`)
  assert.deepEqual(artifact.classes, ['alpha', 'beta', 'gamma'], 'classes are sorted')
  assert.equal(artifact.kind, 'multiclass')
  assert.equal(artifact.domain, 'task_classification')
  assert.equal(artifact.classifierVersion, 'task_classification@2026-09-22T00:00:00.000Z')
  assert.equal(artifact.featureSchemaVersion, FEATURE_SCHEMA_VERSION)
  assert.equal(artifact.libraryVersion, LIBRARY_VERSION)
  assert.equal(artifact.sampleCount, 200)
  assert.equal(artifact.calibration, null)
  assert.equal(artifact.promotionState, null)
  assert.deepEqual(artifact.supportedDistribution.categorical, { shape: ['tall', 'wide'] })
  assert.ok(artifact.supportedDistribution.numeric.x.min < artifact.supportedDistribution.numeric.x.max, 'the numeric range is recorded')
  const again = trainMulticlass({ samples: train, domain: 'task_classification', now: clock })
  assert.equal(again.checksum, artifact.checksum, 'the same samples give the same artifact, byte for byte')
  const p = predict(artifact, all[0].features)
  assert.equal(p.label, 'alpha')
  near(Object.values(p.probabilities).reduce((a, b) => a + b, 0), 1, 'probabilities sum to 1')
  assert.equal(p.confidence, p.rawConfidence, 'without a calibration the two confidences agree')
  assert.ok(p.margin > 0.5 && p.entropy < 0.5, 'a clear sample is a confident prediction')
  assert.equal(p.ood.flag, false)
})

test('learns a ranking problem: higher fit and lower scarcity win', () => {
  const groups = groupsOf(220)
  const artifact = trainRanker({ groups: groups.slice(0, 170), domain: 'resource_selection', now: clock })
  assert.equal(artifact.kind, 'ranking')
  assert.deepEqual(artifact.classes, [], 'a ranker has no class list of its own')
  assert.deepEqual(artifact.index.numeric, ['fit', 'scarcity'])
  const [fitWeight, scarcityWeight] = artifact.weights[0]
  assert.ok(fitWeight > 0, 'fit is rewarded')
  assert.ok(scarcityWeight < 0, 'scarcity is penalised')
  const held = evaluate(artifact, groups.slice(170))
  assert.ok(held.accuracy > 0.9, `top-1 agreement ${held.accuracy} should beat 0.9`)
  assert.ok('RESOURCE_A' in held.perClass, 'per-class results are keyed by candidate key')
  const r = rank(artifact, [
    { features: { numeric: { fit: 0.4, scarcity: 0.8 } } },
    { features: { numeric: { fit: 0.9, scarcity: 0.1 } } },
  ])
  assert.equal(r.chosenIndex, 1)
  near(r.probabilities[0] + r.probabilities[1], 1, 'candidate probabilities sum to 1')
  assert.equal(r.confidence, r.probabilities[1])
  assert.ok(r.margin > 0.5)
  assert.equal(r.ood.flag, false)
  assert.deepEqual(rank(artifact, []), { chosenIndex: -1, probabilities: [], confidence: 0, rawConfidence: 0, margin: 0, ood: { flag: true, reasons: ['no_candidates'] } })
  assert.throws(() => predict(artifact, {}), /needs a multiclass artifact/, 'predict refuses a ranker')
})

test('calibration lowers ECE on an overconfident set and stores the temperature', () => {
  const all = multiclassSet(400)
  const artifact = trainMulticlass({ samples: all.slice(0, 200), domain: 'task_classification', now: clock })
  // The model is sure of itself, but a third of these labels are wrong: the confident answers must cool down.
  const rnd = generator(99)
  const noisy = all.slice(200).map((s) => ({ ...s, label: rnd() < 0.3 ? LABELS[Math.floor(rnd() * 3)] : s.label }))
  const before = calibrationMetrics(noisy.map((s) => predict(artifact, s.features)), noisy.map((s) => s.label))
  const calibrated = calibrate(artifact, noisy)
  assert.ok(calibrated.calibration.temperature > 1, `an overconfident model gets a temperature above 1, got ${calibrated.calibration.temperature}`)
  assert.ok(calibrated.calibration.ece < before.ece, `ECE ${calibrated.calibration.ece} should be under the uncalibrated ${before.ece}`)
  assert.equal(calibrated.calibration.n, noisy.length)
  assert.equal(calibrated.calibration.reliability.length, 10)
  assert.equal(artifact.calibration, null, 'the input artifact is untouched')
  assert.equal(verifyArtifact(calibrated).ok, true, 'the calibrated copy carries a fresh checksum')
  const p = predict(calibrated, all[0].features)
  assert.ok(p.confidence < p.rawConfidence, 'the calibrated confidence is lower than the raw one')
  assert.equal(p.label, 'alpha', 'the temperature never changes the answer')
  const empty = calibrate(artifact, [])
  assert.equal(empty.calibration.temperature, 1)
  assert.equal(empty.calibration.ece, null, 'no validation set means no invented metric')
  assert.equal(empty.calibration.n, 0)
})

test('a ranking artifact calibrates over its candidate softmax', () => {
  const groups = groupsOf(260)
  const artifact = trainRanker({ groups: groups.slice(0, 200), domain: 'resource_selection', now: clock })
  const calibrated = calibrate(artifact, groups.slice(200))
  assert.ok(calibrated.calibration.temperature >= 0.5 && calibrated.calibration.temperature <= 5)
  assert.equal(calibrated.calibration.n, 60)
  assert.equal(typeof calibrated.calibration.ece, 'number')
  const r = rank(calibrated, groups[0].candidates)
  near(r.probabilities.reduce((a, b) => a + b, 0), 1, 'calibrated candidate probabilities still sum to 1')
})

test('calibrationMetrics: ECE is 0 for perfect calibration and a known value by hand', () => {
  // Ten predictions at 0.8, eight of them right: the 0.8-0.9 bin has mean confidence 0.8 and accuracy 0.8.
  const perfect = Array.from({ length: 10 }, () => ({ probabilities: { a: 0.8, b: 0.2 }, label: 'a' }))
  const truth = Array.from({ length: 10 }, (_, i) => (i < 8 ? 'a' : 'b'))
  const m = calibrationMetrics(perfect, truth)
  near(m.ece, 0, 'perfectly calibrated')
  assert.equal(m.n, 10)
  const bin = m.reliability.find((b) => b.range === '0.8-0.9')
  assert.deepEqual(bin, { range: '0.8-0.9', n: 10, meanConfidence: 0.8, accuracy: 0.8 })
  assert.equal(m.reliability.length, 10)
  // Four at 0.9 all right (gap 0.1) and six at 0.6 with three right (gap 0.1): ECE = 0.4 * 0.1 + 0.6 * 0.1.
  const mixed = [
    ...Array.from({ length: 4 }, () => ({ probabilities: { a: 0.9, b: 0.1 }, label: 'a' })),
    ...Array.from({ length: 6 }, () => ({ probabilities: { a: 0.6, b: 0.4 }, label: 'a' })),
  ]
  const mixedTruth = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b']
  near(calibrationMetrics(mixed, mixedTruth).ece, 0.1, 'hand-built ECE')
  // Brier is multi-class: {a: 0.7, b: 0.3} against truth a is 0.3^2 + 0.3^2.
  near(calibrationMetrics([{ probabilities: { a: 0.7, b: 0.3 } }], ['a']).brier, 0.18, 'multi-class Brier')
  near(calibrationMetrics([{ probabilities: { a: 1 } }], ['zzz']).brier, 2, 'a truth outside the probabilities counts as predicted at 0')
  assert.equal(calibrationMetrics([{ probabilities: { a: 1 } }], ['a']).reliability.at(-1).n, 1, 'a confidence of exactly 1 lands in the top bin')
})

test('calibrationMetrics: the high-confidence error rate counts only predictions at or above the threshold', () => {
  const predictions = [
    { probabilities: { a: 0.95, b: 0.05 }, label: 'a' }, // wrong, counted
    { probabilities: { a: 0.9, b: 0.1 }, label: 'a' }, // right, counted (at the threshold)
    { probabilities: { a: 0.89, b: 0.11 }, label: 'a' }, // wrong, under the threshold: ignored
    { probabilities: { a: 0.5, b: 0.5 }, label: 'b' }, // wrong, ignored
  ]
  const m = calibrationMetrics(predictions, ['b', 'a', 'b', 'a'])
  assert.equal(m.highConfidenceN, 2)
  assert.equal(m.highConfidenceErrorRate, 0.5)
  assert.equal(calibrationMetrics(predictions, ['b', 'a', 'b', 'a'], { highConfidence: 0.99 }).highConfidenceErrorRate, 0, 'nothing reached the threshold: no error was observed')
  assert.equal(calibrationMetrics(predictions, ['b', 'a', 'b', 'a'], { highConfidence: 0.99 }).highConfidenceN, 0)
})

test('OOD: an unseen category and an out-of-range numeric are flagged, hashed text never is', () => {
  const rnd = generator(3)
  const samples = Array.from({ length: 60 }, (_, i) => ({
    features: { numeric: { size: 0.5 + rnd() * 0.1, h17: i % 7 === 0 ? 1.1 : 0 }, categorical: { tier: i % 2 ? 'strong' : 'frontier' } },
    label: i % 2 ? 'small' : 'large',
  }))
  const artifact = trainMulticlass({ samples, domain: 'skill_selection', now: clock })
  const ood = { maxEntropyShare: 0.75, minMargin: 0.1, rangeSigmas: 4 }
  const familiar = oodCheck(artifact, { numeric: { size: 0.55, h17: 0 }, categorical: { tier: 'strong' } }, ood)
  assert.deepEqual(familiar.reasons.filter((r) => !/^(high_entropy|low_margin)$/.test(r)), [], 'an in-distribution sample raises no feature reason')
  const unseen = oodCheck(artifact, { numeric: { size: 0.55 }, categorical: { tier: 'weird' } }, ood)
  assert.equal(unseen.flag, true)
  assert.ok(unseen.reasons.includes('unseen_category:tier=weird'), unseen.reasons.join(','))
  const far = oodCheck(artifact, { numeric: { size: 9 }, categorical: { tier: 'strong' } }, ood)
  assert.ok(far.reasons.includes('out_of_range:size'), far.reasons.join(','))
  const hashed = oodCheck(artifact, { numeric: { size: 0.55, h17: 500 }, categorical: { tier: 'strong' } }, ood)
  assert.equal(hashed.reasons.some((r) => r.startsWith('out_of_range')), false, 'a hashed text bucket is exempt from the range check')
  const unknownName = oodCheck(artifact, { numeric: { size: 0.55, nobody: 1e9 }, categorical: { tier: 'strong', colour: 'red' } }, ood)
  assert.equal(unknownName.reasons.some((r) => r.includes('nobody') || r.includes('colour')), false, 'names outside the index are ignored')
  const p = predict(artifact, { numeric: { size: 0.55 }, categorical: { tier: 'weird' } }, { ood })
  assert.equal(p.ood.flag, true, 'predict carries the same reasons')
  // A wide-open policy still reports the feature reasons, only the indecision ones depend on it.
  assert.equal(oodCheck(artifact, { numeric: { size: 9 }, categorical: {} }, { ...ood, rangeSigmas: 1000 }).reasons.includes('out_of_range:size'), false)
})

test('OOD: an indecisive prediction is high entropy and low margin', () => {
  // Two classes on top of each other: nothing separates them, so the artifact must say so.
  const samples = Array.from({ length: 40 }, (_, i) => ({ features: { numeric: { x: 1 } }, label: i % 2 ? 'yes' : 'no' }))
  const artifact = trainMulticlass({ samples, domain: 'conservation', now: clock })
  const p = predict(artifact, { numeric: { x: 1 } })
  assert.ok(p.ood.reasons.includes('high_entropy'), p.ood.reasons.join(','))
  assert.ok(p.ood.reasons.includes('low_margin'), p.ood.reasons.join(','))
  near(p.confidence, 0.5, 'an even split', 1e-6)
  const r = rank(trainRanker({ groups: groupsOf(30), now: clock }), [{ features: { numeric: { fit: 0.5, scarcity: 0.5 } } }, { features: { numeric: { fit: 0.5, scarcity: 0.5 } } }])
  assert.ok(r.ood.reasons.includes('low_margin'), 'two identical candidates cannot be told apart')
})

test('vectorize: standardised numerics in index order, one-hot categoricals, unknown names ignored', () => {
  const index = buildIndex([
    { features: { numeric: { b: 2, a: 1 }, categorical: { tier: 'strong' } } },
    { features: { numeric: { a: 3 }, categorical: { tier: 'frontier' } } },
  ])
  assert.deepEqual(index, { numeric: ['a', 'b'], categorical: { tier: ['frontier', 'strong'] } })
  assert.deepEqual([...vectorize(index, { numeric: { a: 3, zzz: 9 }, categorical: { tier: 'strong', nobody: 'x' } })], [3, 0, 0, 1], 'an absent numeric is 0, unknown names are dropped')
  assert.deepEqual([...vectorize(index, { numeric: { a: 5 }, categorical: { tier: 'weird' } }, { mean: [1, 0], std: [2, 1] })], [2, 0, 0, 0], 'standardised with the given stats, an unseen value is all zeros')
  assert.deepEqual([...vectorize(index, {})], [0, 0, 0, 0])
})

test('artifacts round-trip through save and load', () => {
  const dir = tmp()
  const file = join(dir, 'classifiers', 'task_classification.json')
  const artifact = trainMulticlass({ samples: multiclassSet(60), domain: 'task_classification', now: clock })
  const written = saveArtifact(file, { ...artifact, promotionState: 'SHADOW' })
  assert.equal(written.promotionState, 'SHADOW')
  assert.notEqual(written.checksum, artifact.checksum, 'a metadata change is a new checksum')
  const { artifact: back, reason } = loadArtifact(file, { domain: 'task_classification' })
  assert.equal(reason, undefined)
  assert.deepEqual(back, written)
  assert.equal(verifyArtifact(back).ok, true)
  assert.equal(predict(back, multiclassSet(1)[0].features).label, predict(artifact, multiclassSet(1)[0].features).label)
  assert.deepEqual(loadArtifact(file).artifact, written, 'without a domain any domain loads')
  assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true)
  const ranker = trainRanker({ groups: groupsOf(20), domain: 'resource_selection', now: clock })
  const rankFile = join(dir, 'resource_selection.json')
  saveArtifact(rankFile, ranker)
  assert.deepEqual(loadArtifact(rankFile, { domain: 'resource_selection' }).artifact, ranker)
})

test('a missing, corrupted, wrong-schema or wrong-domain artifact loads as null with a reason', () => {
  const dir = tmp()
  const artifact = trainMulticlass({ samples: multiclassSet(30), domain: 'task_classification', now: clock })
  const missing = loadArtifact(join(dir, 'nope.json'), { domain: 'task_classification' })
  assert.equal(missing.artifact, null)
  assert.match(missing.reason, /missing/)
  const garbage = join(dir, 'garbage.json')
  writeFileSync(garbage, '{"domain": "task_class')
  assert.equal(loadArtifact(garbage).artifact, null)
  assert.match(loadArtifact(garbage).reason, /unreadable/)
  // A flipped weight on disk: the checksum no longer matches the content.
  const tampered = join(dir, 'tampered.json')
  const doc = JSON.parse(JSON.stringify(saveArtifact(join(dir, 'ok.json'), artifact)))
  doc.weights[0][0] += 1
  writeFileSync(tampered, JSON.stringify(doc))
  assert.equal(loadArtifact(tampered, { domain: 'task_classification' }).artifact, null)
  assert.match(loadArtifact(tampered, { domain: 'task_classification' }).reason, /checksum/)
  const otherSchema = join(dir, 'schema.json')
  saveArtifact(otherSchema, { ...artifact, featureSchemaVersion: FEATURE_SCHEMA_VERSION + 1 })
  const schema = loadArtifact(otherSchema, { domain: 'task_classification' })
  assert.equal(schema.artifact, null)
  assert.match(schema.reason, /feature schema version/)
  const otherDomain = loadArtifact(join(dir, 'ok.json'), { domain: 'skill_selection' })
  assert.equal(otherDomain.artifact, null)
  assert.match(otherDomain.reason, /domain task_classification differs from skill_selection/)
  assert.doesNotThrow(() => loadArtifact(join(dir, 'ok.json'), { domain: 'skill_selection', featureSchemaVersion: 99 }))
})

test('verifyArtifact: finite weights, consistent shapes, matching checksum', () => {
  const artifact = trainMulticlass({ samples: multiclassSet(30), domain: 'task_classification', now: clock })
  assert.deepEqual(verifyArtifact(artifact), { ok: true, reason: null })
  assert.equal(verifyArtifact(null).ok, false)
  assert.match(verifyArtifact({ ...artifact, kind: 'linear' }).reason, /kind/)
  assert.match(verifyArtifact({ ...artifact, weights: artifact.weights.slice(1) }).reason, /rows/)
  const nan = { ...artifact, weights: artifact.weights.map((row) => row.map(() => NaN)) }
  assert.match(verifyArtifact(nan).reason, /finite/)
  assert.match(verifyArtifact({ ...artifact, bias: [1] }).reason, /bias/)
  assert.match(verifyArtifact({ ...artifact, checksum: 'deadbeef' }).reason, /checksum/)
  const wider = { ...artifact, index: { ...artifact.index, numeric: [...artifact.index.numeric, 'extra'] } }
  assert.equal(verifyArtifact(wider).ok, false, 'a column with no weight is a shape mismatch')
})

test('evaluate: balanced accuracy and macro F1 on an imbalanced hand-built case', () => {
  // One feature decides everything: x = -1 is "no", x = 1 is "yes".
  const artifact = trainMulticlass({
    samples: Array.from({ length: 20 }, (_, i) => ({ features: { numeric: { x: i % 2 ? 1 : -1 } }, label: i % 2 ? 'yes' : 'no' })),
    domain: 'second_opinion',
    now: clock,
  })
  // Truth: 10 "no" of which 2 sit at x = 1 (predicted yes), 2 "yes" both at x = 1 (predicted yes).
  const samples = [
    ...Array.from({ length: 8 }, () => ({ features: { numeric: { x: -1 } }, label: 'no' })),
    ...Array.from({ length: 2 }, () => ({ features: { numeric: { x: 1 } }, label: 'no' })),
    ...Array.from({ length: 2 }, () => ({ features: { numeric: { x: 1 } }, label: 'yes' })),
  ]
  const e = evaluate(artifact, samples)
  assert.equal(e.n, 12)
  near(e.accuracy, 10 / 12, 'accuracy is 10 right of 12')
  // recall: no 8/10, yes 2/2 -> balanced (0.8 + 1) / 2
  near(e.balancedAccuracy, 0.9, 'balanced accuracy is the mean recall')
  // precision: no 8/8, yes 2/4 -> f1: no 2*1*0.8/1.8, yes 2*0.5*1/1.5
  const f1No = (2 * 1 * 0.8) / 1.8
  const f1Yes = (2 * 0.5 * 1) / 1.5
  near(e.macroF1, (f1No + f1Yes) / 2, 'macro F1 is the mean of the per-class F1')
  assert.equal(e.perClass.no.n, 10)
  assert.equal(e.perClass.yes.n, 2)
  near(e.perClass.no.precision, 1, 'no precision')
  near(e.perClass.no.recall, 0.8, 'no recall')
  near(e.perClass.yes.precision, 0.5, 'yes precision')
  near(e.perClass.yes.recall, 1, 'yes recall')
  assert.deepEqual(e.confusion, { no: { no: 8, yes: 2 }, yes: { yes: 2 } })
  assert.deepEqual(evaluate(artifact, []), { n: 0, accuracy: 0, balancedAccuracy: 0, macroF1: 0, perClass: {}, confusion: {} })
})

test('training options: the policy defaults are recorded, balance can be switched off, and empty input is refused', () => {
  const samples = multiclassSet(30)
  const artifact = trainMulticlass({ samples, now: clock })
  assert.deepEqual(artifact.options, { epochs: 200, learningRate: 0.1, l2: 0.001, balance: true })
  assert.equal(artifact.domain, 'unknown')
  const custom = trainMulticlass({ samples, options: { epochs: 10, learningRate: 0.5, l2: 0, balance: false }, now: clock })
  assert.deepEqual(custom.options, { epochs: 10, learningRate: 0.5, l2: 0, balance: false })
  assert.notEqual(custom.checksum, artifact.checksum)
  assert.throws(() => trainMulticlass({ samples: [], now: clock }), /at least one training sample/)
  assert.throws(() => trainRanker({ groups: [{ candidates: [{ features: {} }], chosenIndex: 3 }], now: clock }), /chosenIndex/)
  // Inverse-frequency weights keep a rare class from being ignored.
  const rnd = generator(5)
  const skewed = Array.from({ length: 120 }, (_, i) => {
    const label = i % 12 === 0 ? 'rare' : 'common'
    return { features: { numeric: { x: (label === 'rare' ? 1 : 0) + rnd() * 0.2 } }, label }
  })
  const balanced = trainMulticlass({ samples: skewed, options: { epochs: 30 }, now: clock })
  assert.equal(predict(balanced, { numeric: { x: 1.1 } }).label, 'rare')
})

test('degenerate inputs stay honest: one class, one candidate, an unusable group', () => {
  const single = trainMulticlass({ samples: Array.from({ length: 8 }, (_, i) => ({ features: { numeric: { x: i } }, label: 'only' })), domain: 'conservation', now: clock })
  assert.deepEqual(single.classes, ['only'])
  assert.deepEqual(single.weights[0].filter((w) => w !== 0), [], 'one class leaves nothing to learn, so no weight moves')
  const p = predict(single, { numeric: { x: 3 } })
  assert.equal(p.label, 'only')
  near(p.confidence, 1, 'the only class carries the whole probability mass')
  near(p.entropy, 0, 'a certain answer has no entropy')
  assert.equal(p.ood.reasons.includes('high_entropy'), false, 'one class cannot be indecisive')
  const ranker = trainRanker({ groups: groupsOf(20), domain: 'resource_selection', now: clock })
  const one = rank(ranker, [{ features: { numeric: { fit: 0.9, scarcity: 0.1 } } }])
  assert.equal(one.chosenIndex, 0)
  near(one.confidence, 1, 'a lone candidate is the pick')
  const e = evaluate(ranker, [{ candidates: [{ key: 'RESOURCE_A', features: { numeric: { fit: 1, scarcity: 0 } } }], chosenIndex: 4 }])
  assert.equal(e.n, 0, 'a chosen index pointing at no candidate is not evidence')
})

test('the stored temperature is the grid minimum of the validation likelihood', () => {
  const all = multiclassSet(400)
  const artifact = trainMulticlass({ samples: all.slice(0, 200), domain: 'task_classification', now: clock })
  const rnd = generator(99)
  const noisy = all.slice(200).map((s) => ({ ...s, label: rnd() < 0.3 ? LABELS[Math.floor(rnd() * 3)] : s.label }))
  const { temperature } = calibrate(artifact, noisy).calibration
  assert.ok(GRID.includes(temperature), `${temperature} is not a point of the [0.5, 5] step 0.05 grid`)
  // The uncalibrated artifact reports raw probabilities, which is all the search needs.
  const rows = noisy.map((s) => ({ p: artifact.classes.map((c) => predict(artifact, s.features).probabilities[c]), truth: artifact.classes.indexOf(s.label) }))
  const best = nllAt(rows, temperature)
  for (const T of GRID) assert.ok(best <= nllAt(rows, T) + 1e-9, `temperature ${temperature} loses to ${T} on the validation likelihood`)
})

test('a calibrated ranker cools its candidate softmax and leaves the pick alone', () => {
  const groups = groupsOf(260)
  const artifact = trainRanker({ groups: groups.slice(0, 200), domain: 'resource_selection', now: clock })
  const calibrated = calibrate(artifact, noisyGroups(groups.slice(200)))
  assert.ok(calibrated.calibration.temperature > 1, `a ranker that is wrong four times in ten must cool down, got ${calibrated.calibration.temperature}`)
  const before = rank(artifact, groups[0].candidates)
  const after = rank(calibrated, groups[0].candidates)
  assert.equal(after.chosenIndex, before.chosenIndex, 'the temperature never changes the pick')
  assert.equal(after.rawConfidence, before.confidence, 'rawConfidence is the uncalibrated top probability')
  assert.ok(after.confidence < after.rawConfidence, 'the calibrated confidence is the lower of the two')
  near(after.probabilities.reduce((a, b) => a + b, 0), 1, 'the cooled candidate probabilities still sum to 1')
})

test('an incomplete out-of-distribution policy falls back to the routing defaults', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ features: { numeric: { size: i % 2 } }, label: i % 2 ? 'big' : 'small' }))
  const artifact = trainMulticlass({ samples, domain: 'skill_selection', now: clock })
  const far = { numeric: { size: 50 } }
  // A block naming one limit must not silently switch the other checks off.
  assert.equal(oodCheck(artifact, far, { maxEntropyShare: 0.9 }).reasons.includes('out_of_range:size'), true, 'rangeSigmas comes from the policy when the caller omits it')
  assert.equal(oodCheck(artifact, far, {}).reasons.includes('out_of_range:size'), true, 'an empty block is the policy, not no check at all')
  assert.deepEqual(oodCheck(artifact, far).reasons, oodCheck(artifact, far, ROUTING_DEFAULTS.ood).reasons, 'omitting the block is passing the defaults')
  assert.deepEqual(predict(artifact, far, { ood: null }).ood.reasons, predict(artifact, far).ood.reasons, 'a null block is the defaults too')
  const ranker = trainRanker({ groups: groupsOf(20), domain: 'resource_selection', now: clock })
  assert.deepEqual(rank(ranker, [{ features: { numeric: { fit: 0.5, scarcity: 0.5 } } }, { features: { numeric: { fit: 0.5, scarcity: 0.5 } } }], { ood: {} }).ood.reasons.includes('low_margin'), true, 'minMargin comes from the policy for a ranker too')
})

test('a constant column and an absent sample list do not break the arithmetic', () => {
  // `k` never varies, so its standard deviation is 0: the scale must not be a division by it.
  const artifact = trainMulticlass({
    samples: Array.from({ length: 10 }, (_, i) => ({ features: { numeric: { x: i % 2, k: 5 } }, label: i % 2 ? 'yes' : 'no' })),
    domain: 'conservation',
    now: clock,
  })
  assert.equal(artifact.standardization.std[0], 0, 'the constant column has no spread')
  assert.equal(verifyArtifact(artifact).ok, true, 'every weight is still finite')
  const p = predict(artifact, { numeric: { x: 1, k: 5 } })
  assert.equal(p.label, 'yes')
  assert.equal(Number.isFinite(p.confidence), true, 'the confidence is a number, not a NaN')
  assert.deepEqual(evaluate(artifact, undefined), { n: 0, accuracy: 0, balancedAccuracy: 0, macroF1: 0, perClass: {}, confusion: {} }, 'no samples is an empty report, not a throw')
  assert.throws(
    () => vectorize(artifact.index, { numeric: { x: 1 } }, { mean: [0], std: [1] }),
    /standardization has 1 means for 2 numeric features/,
    'stats that do not line up with the index are refused rather than turned into NaN',
  )
})

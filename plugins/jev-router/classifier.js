// The local classifier library: a small, dependency-free multinomial logistic regression that
// the routing domains train on their own samples, plus the calibration, evaluation and artifact
// plumbing around it.
//
// Two decisions shape everything here. First, the model is deliberately simple and linear:
// features.js already builds explicit interaction terms, and a linear scorer over standardised
// columns is easy to inspect, deterministic to train (weights start at zero, full-batch gradient
// descent, no random initialisation) and cheap to retrain. Second, an artifact is a
// self-describing JSON document carrying its own feature index, standardisation statistics,
// schema version, calibration and checksum, so a stale or corrupted one loads as null with a
// reason rather than as a confident wrong answer. No threshold is defined here: OOD limits and
// training defaults come from the policy, and every caller may pass its own.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FEATURE_SCHEMA_VERSION } from './features.js'
import { ROUTING_DEFAULTS } from './routing-policy.js'

export { FEATURE_SCHEMA_VERSION }
export const LIBRARY_VERSION = 'kzh-classifier/1'
const KINDS = Object.freeze(['multiclass', 'ranking'])
// Hashed text buckets look like h17: a sparse count that is usually 0 and sometimes not, which
// is exactly the shape a standard-deviation range check calls out of range, so they are exempt.
const HASHED = /^h\d+$/
// A constant training column has no scale of its own; it is left unscaled rather than divided by 0.
const scaleOf = (std) => (std > 0 ? std : 1)
// The smallest absolute distance from the training mean that may count as out of range. A feature
// that barely moved while training (every run so far had the same risk, say) has a spread of
// almost nothing, and dividing by it turns any ordinary later value into tens of sigmas: the
// router would declare every decision unfamiliar and hand all of them back to the teacher. A value
// is unfamiliar when it is far in sigmas AND far in absolute terms.
const MIN_RANGE_TOLERANCE = 0.1
const featuresOf = (item) => (item && item.features ? item.features : item) ?? {}
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The feature index of a training set: every numeric name and every categorical vocabulary
 * seen, sorted, so the column layout is a function of the data and nothing else.
 * @param {Array<{ features?: object, numeric?: object, categorical?: object }>} samples items with a feature set (or bare feature sets)
 * @returns {{ numeric: string[], categorical: Record<string, string[]> }}
 */
export function buildIndex(samples) {
  const numeric = new Set()
  const categorical = new Map()
  for (const s of samples) {
    const f = featuresOf(s)
    for (const k of Object.keys(f.numeric ?? {})) numeric.add(k)
    for (const [k, v] of Object.entries(f.categorical ?? {})) {
      if (!categorical.has(k)) categorical.set(k, new Set())
      categorical.get(k).add(String(v))
    }
  }
  const out = { numeric: [...numeric].sort(), categorical: {} }
  for (const k of [...categorical.keys()].sort()) out.categorical[k] = [...categorical.get(k)].sort()
  return out
}

/** Number of columns a vector built from this index has. */
const dimensionOf = (index) => index.numeric.length + Object.values(index.categorical).reduce((n, v) => n + v.length, 0)

/**
 * Per-column mean, standard deviation, minimum and maximum of the numeric features, aligned
 * with `index.numeric`. A numeric name absent from a sample counts as 0, the same way it does
 * when the sample is vectorised. Population standard deviation: the training set is the whole
 * population the artifact knows.
 * @returns {{ standardization: { mean: number[], std: number[] }, distribution: Record<string, { min: number, max: number, mean: number, std: number }> }}
 */
export function standardizationOf(index, samples) {
  const n = Math.max(1, samples.length)
  const mean = index.numeric.map(() => 0)
  const min = index.numeric.map(() => Infinity)
  const max = index.numeric.map(() => -Infinity)
  const values = samples.map((s) => index.numeric.map((name) => numOf(featuresOf(s).numeric?.[name])))
  for (const row of values) row.forEach((x, i) => { mean[i] += x / n; min[i] = Math.min(min[i], x); max[i] = Math.max(max[i], x) })
  const std = index.numeric.map((_, i) => Math.sqrt(values.reduce((acc, row) => acc + (row[i] - mean[i]) ** 2, 0) / n))
  const distribution = {}
  index.numeric.forEach((name, i) => {
    distribution[name] = { min: samples.length ? min[i] : 0, max: samples.length ? max[i] : 0, mean: mean[i], std: std[i] }
  })
  return { standardization: { mean, std }, distribution }
}

/**
 * One feature set as a dense vector: standardised numerics in index order, then one-hot
 * categoricals. A numeric name absent from the sample is 0 before standardisation; a name or a
 * categorical value absent from the index is ignored (the OOD check is where it is reported).
 * @param {{ numeric: string[], categorical: Record<string, string[]> }} index
 * @param {{ numeric?: object, categorical?: object }} features
 * @param {{ mean: number[], std: number[] }|null} [standardization] omitted means raw values
 */
export function vectorize(index, features, standardization = null) {
  if (standardization && standardization.mean?.length !== index.numeric.length) {
    throw new Error(`classifier: standardization has ${standardization.mean?.length ?? 0} means for ${index.numeric.length} numeric features`)
  }
  const x = new Float64Array(dimensionOf(index))
  const f = features ?? {}
  index.numeric.forEach((name, i) => {
    const raw = numOf(f.numeric?.[name])
    x[i] = standardization ? (raw - standardization.mean[i]) / scaleOf(standardization.std[i]) : raw
  })
  let offset = index.numeric.length
  for (const [name, vocab] of Object.entries(index.categorical)) {
    const at = f.categorical?.[name] === undefined ? -1 : vocab.indexOf(String(f.categorical[name]))
    if (at >= 0) x[offset + at] = 1
    offset += vocab.length
  }
  return x
}

const softmax = (z) => {
  const m = Math.max(...z)
  const e = z.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}
const logits = (artifact, x) => artifact.weights.map((row, k) => row.reduce((acc, w, j) => acc + w * x[j], artifact.bias[k]))
const vectorOf = (artifact, features) => vectorize(artifact.index, features, artifact.standardization)
const temperatureOf = (artifact) => artifact.calibration?.temperature ?? 1
const entropyOf = (p) => -p.reduce((acc, v) => acc + (v > 0 ? v * Math.log(v) : 0), 0)
const topTwo = (p) => {
  let best = -1; let second = -1
  for (let i = 0; i < p.length; i++) {
    if (best < 0 || p[i] > p[best]) { second = best; best = i } else if (second < 0 || p[i] > p[second]) second = i
  }
  return { best, margin: best < 0 ? 0 : p[best] - (second < 0 ? 0 : p[second]) }
}
const requireKind = (artifact, kind, what) => {
  if (!artifact || artifact.kind !== kind) throw new Error(`classifier: ${what} needs a ${kind} artifact, got ${artifact?.kind ?? 'nothing'}`)
}
// A caller may hand over a partial ood block, or none at all. Every limit it leaves out falls back
// to the policy, because a safety check that silently never fires is worse than one that is strict:
// an undefined `rangeSigmas` would make every comparison false and call everything in distribution.
const oodOf = (ood) => ({ ...ROUTING_DEFAULTS.ood, ...(ood ?? {}) })

/** Softmax of K scores into a preallocated buffer, same arithmetic and order as `softmax`. */
function softmaxInto(z, p, K) {
  let m = -Infinity
  for (let k = 0; k < K; k++) if (z[k] > m) m = z[k]
  let s = 0
  for (let k = 0; k < K; k++) { p[k] = Math.exp(z[k] - m); s += p[k] }
  for (let k = 0; k < K; k++) p[k] /= s
}

/**
 * Full-batch gradient descent on a softmax (K rows) or logistic (1 row) linear scorer with L2.
 * `rows` are `[x, targetIndex, weight]`; for the logistic case the target is 1 for a positive
 * and 0 for a negative and the single score is read as the logit of the positive class.
 * The design matrix is copied into one flat buffer and the inner loops allocate nothing: this is
 * the hot path of every retrain, and a task-classification vector is a few thousand columns wide.
 * `logistic` is passed rather than inferred from K, because a one-class multiclass problem also
 * has K === 1 and must stay a softmax that simply always answers its only class.
 */
function descend(rows, dim, K, { epochs, learningRate, l2 }, logistic = false) {
  const n = rows.length
  const X = new Float64Array(n * dim)
  const target = new Float64Array(n)
  const weight = new Float64Array(n)
  rows.forEach(([x, t, w], i) => { X.set(x, i * dim); target[i] = t; weight[i] = w })
  const W = new Float64Array(K * dim)
  const b = new Float64Array(K)
  const gW = new Float64Array(K * dim)
  const gb = new Float64Array(K)
  const z = new Float64Array(K)
  const p = new Float64Array(K)
  let total = 0
  for (let i = 0; i < n; i++) total += weight[i]
  if (!total) total = 1
  for (let epoch = 0; epoch < epochs; epoch++) {
    gW.fill(0)
    gb.fill(0)
    for (let i = 0; i < n; i++) {
      const at = i * dim
      for (let k = 0; k < K; k++) {
        let acc = b[k]
        const row = k * dim
        for (let j = 0; j < dim; j++) acc += W[row + j] * X[at + j]
        z[k] = acc
      }
      if (logistic) p[0] = 1 / (1 + Math.exp(-z[0]))
      else softmaxInto(z, p, K)
      for (let k = 0; k < K; k++) {
        const err = (p[k] - (logistic ? target[i] : (k === target[i] ? 1 : 0))) * weight[i] / total
        gb[k] += err
        const row = k * dim
        for (let j = 0; j < dim; j++) gW[row + j] += err * X[at + j]
      }
    }
    for (let k = 0; k < K; k++) {
      b[k] -= learningRate * gb[k]
      const row = k * dim
      for (let j = 0; j < dim; j++) W[row + j] -= learningRate * (gW[row + j] + l2 * W[row + j])
    }
  }
  return { weights: Array.from({ length: K }, (_, k) => [...W.subarray(k * dim, (k + 1) * dim)]), bias: [...b] }
}

const trainingOptions = (options = {}) => {
  const d = ROUTING_DEFAULTS.retrain
  return {
    epochs: Number.isInteger(options.epochs) && options.epochs >= 0 ? options.epochs : d.epochs,
    learningRate: typeof options.learningRate === 'number' ? options.learningRate : d.learningRate,
    l2: typeof options.l2 === 'number' ? options.l2 : d.l2,
    balance: options.balance !== false,
  }
}

/** Assemble the metadata every artifact carries, then seal it with its checksum. */
function artifactOf({ domain, kind, trainingDataVersion, createdAt, sampleCount, classes, index, standardization, distribution, weights, bias, options, extras }) {
  return finalizeArtifact({
    domain,
    kind,
    classifierVersion: `${domain}@${createdAt}`,
    trainingDataVersion: trainingDataVersion ?? null,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    libraryVersion: LIBRARY_VERSION,
    createdAt,
    sampleCount,
    classes,
    index,
    standardization,
    weights,
    bias,
    options,
    validation: null,
    calibration: null,
    supportedDistribution: { numeric: distribution, categorical: index.categorical },
    extras: extras ?? {},
    promotionState: null,
    checksum: null,
  })
}

/**
 * Train a multinomial logistic regression. Weights start at zero and the descent is full batch,
 * so the same samples in the same order always give the same artifact. Class imbalance is
 * handled by inverse-frequency sample weights unless `options.balance` is false.
 * @param {object} p
 * @param {Array<{ features: object, label: string, weight?: number }>} p.samples
 * @param {{ epochs?: number, learningRate?: number, l2?: number, balance?: boolean }} [p.options] defaults from the policy's retrain block
 * @param {string} [p.domain] routing domain the artifact serves
 * @param {string|null} [p.trainingDataVersion]
 * @param {object} [p.extras] anything the caller wants stored next to the weights (numbers and ids only)
 * @param {() => number|string} [p.now] the clock, for `createdAt`
 * @returns {object} the artifact
 */
export function trainMulticlass({ samples, options, domain = 'unknown', trainingDataVersion = null, extras = {}, now = () => Date.now() }) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('classifier: at least one training sample is required')
  const opts = trainingOptions(options)
  const classes = [...new Set(samples.map((s) => String(s.label)))].sort()
  const index = buildIndex(samples)
  const { standardization, distribution } = standardizationOf(index, samples)
  const counts = {}
  for (const s of samples) counts[String(s.label)] = (counts[String(s.label)] ?? 0) + 1
  const rows = samples.map((s) => {
    const label = String(s.label)
    const balance = opts.balance ? samples.length / (classes.length * counts[label]) : 1
    return [vectorize(index, s.features, standardization), classes.indexOf(label), numOf(s.weight ?? 1) * balance]
  })
  const { weights, bias } = descend(rows, dimensionOf(index), classes.length, opts)
  return artifactOf({
    domain, kind: 'multiclass', trainingDataVersion, createdAt: new Date(now()).toISOString(), sampleCount: samples.length,
    classes, index, standardization, distribution, weights, bias, options: opts, extras,
  })
}

/**
 * Train a ranking artifact: one logistic scorer over candidate features, label 1 for the chosen
 * candidate of each group and 0 for the rest. At inference the candidate scores go through a
 * softmax (and the calibration temperature), so a group's probabilities sum to 1.
 * @param {object} p
 * @param {Array<{ candidates: Array<{ features: object }>, chosenIndex: number, weight?: number }>} p.groups
 * @param {{ epochs?: number, learningRate?: number, l2?: number, balance?: boolean }} [p.options]
 * @param {string} [p.domain]
 * @param {string|null} [p.trainingDataVersion]
 * @param {object} [p.extras]
 * @param {() => number|string} [p.now]
 * @returns {object} the artifact, `kind: 'ranking'`
 */
export function trainRanker({ groups, options, domain = 'unknown', trainingDataVersion = null, extras = {}, now = () => Date.now() }) {
  if (!Array.isArray(groups) || !groups.length) throw new Error('classifier: at least one training group is required')
  const opts = trainingOptions(options)
  const flat = []
  for (const g of groups) {
    if (!Array.isArray(g.candidates) || !g.candidates.length) throw new Error('classifier: every training group needs candidates')
    if (!Number.isInteger(g.chosenIndex) || g.chosenIndex < 0 || g.chosenIndex >= g.candidates.length) throw new Error('classifier: chosenIndex must point at a candidate')
    g.candidates.forEach((c, i) => flat.push({ features: c.features, positive: i === g.chosenIndex ? 1 : 0, weight: numOf(g.weight ?? 1) }))
  }
  const index = buildIndex(flat)
  const { standardization, distribution } = standardizationOf(index, flat)
  const positives = flat.filter((r) => r.positive).length
  const negatives = flat.length - positives
  // Chosen candidates are one per group, so they are always the minority: weigh them up.
  const balanceOf = (positive) => (opts.balance && positives && negatives ? flat.length / (2 * (positive ? positives : negatives)) : 1)
  const rows = flat.map((r) => [vectorize(index, r.features, standardization), r.positive, r.weight * balanceOf(r.positive)])
  const { weights, bias } = descend(rows, dimensionOf(index), 1, opts, true)
  return artifactOf({
    domain, kind: 'ranking', trainingDataVersion, createdAt: new Date(now()).toISOString(), sampleCount: groups.length,
    classes: [], index, standardization, distribution, weights, bias, options: opts, extras,
  })
}

/** Reasons a feature set is unfamiliar to an artifact, from its index and distribution alone. */
function featureOodReasons(artifact, features, ood) {
  const reasons = []
  const f = features ?? {}
  for (const [name, vocab] of Object.entries(artifact.index.categorical)) {
    const v = f.categorical?.[name]
    if (v !== undefined && !vocab.includes(String(v))) reasons.push(`unseen_category:${name}=${String(v)}`)
  }
  const { mean, std } = artifact.standardization
  artifact.index.numeric.forEach((name, i) => {
    if (HASHED.test(name)) return
    const delta = numOf(f.numeric?.[name]) - mean[i]
    const far = Math.abs(delta) > MIN_RANGE_TOLERANCE * Math.max(1, Math.abs(mean[i]))
    if (Math.abs(delta / scaleOf(std[i])) > ood.rangeSigmas && far) reasons.push(`out_of_range:${name}`)
  })
  return reasons
}

/** Reasons a probability vector is indecisive: entropy over the share allowed, or a thin top-two margin. */
function distributionOodReasons(p, ood) {
  const reasons = []
  if (p.length > 1 && entropyOf(p) > ood.maxEntropyShare * Math.log(p.length)) reasons.push('high_entropy')
  if (p.length > 1 && topTwo(p).margin < ood.minMargin) reasons.push('low_margin')
  return reasons
}

/**
 * Is this feature set something the artifact has seen the like of? Reports every reason, so
 * the inspector can show why a decision went back to Jev.
 * `unseen_category:<name>=<value>` for a categorical value outside the training vocabulary,
 * `out_of_range:<name>` for a standardised numeric further than `rangeSigmas` from the mean
 * (hashed text buckets are exempt), `high_entropy` and `low_margin` for an indecisive
 * prediction (multiclass artifacts only: a ranking artifact needs the whole group, see `rank`).
 * @param {object} artifact
 * @param {object} features
 * @param {{ maxEntropyShare: number, minMargin: number, rangeSigmas: number }} [ood] the policy's ood block; any limit it leaves out comes from the routing defaults
 * @returns {{ flag: boolean, reasons: string[] }}
 */
export function oodCheck(artifact, features, ood = ROUTING_DEFAULTS.ood) {
  const limits = oodOf(ood)
  const reasons = featureOodReasons(artifact, features, limits)
  if (artifact.kind === 'multiclass') reasons.push(...distributionOodReasons(softmax(logits(artifact, vectorOf(artifact, features)).map((z) => z / temperatureOf(artifact))), limits))
  return { flag: reasons.length > 0, reasons }
}

/**
 * Classify one feature set. `confidence` is the calibrated top probability (temperature
 * applied), `rawConfidence` the uncalibrated one; entropy and margin are of the calibrated
 * distribution.
 * @param {object} artifact a multiclass artifact
 * @param {object} features
 * @param {{ ood?: object }} [p] `ood` is the policy's ood block; every limit it leaves out comes from the routing defaults
 * @returns {{ label: string, probabilities: Record<string, number>, confidence: number, rawConfidence: number, entropy: number, margin: number, ood: { flag: boolean, reasons: string[] } }}
 */
export function predict(artifact, features, { ood } = {}) {
  requireKind(artifact, 'multiclass', 'predict')
  const limits = oodOf(ood)
  const z = logits(artifact, vectorOf(artifact, features))
  const raw = softmax(z)
  const p = softmax(z.map((v) => v / temperatureOf(artifact)))
  const { best, margin } = topTwo(p)
  const probabilities = {}
  artifact.classes.forEach((c, i) => { probabilities[c] = p[i] })
  const reasons = [...featureOodReasons(artifact, features, limits), ...distributionOodReasons(p, limits)]
  return {
    label: artifact.classes[best],
    probabilities,
    confidence: p[best],
    rawConfidence: raw[best],
    entropy: entropyOf(p),
    margin,
    ood: { flag: reasons.length > 0, reasons },
  }
}

/**
 * Rank a group of candidates: softmax over their scores, temperature applied for `confidence`
 * and `probabilities`, not for `rawConfidence`. OOD reasons are the union over the candidates'
 * feature sets plus the indecision checks over the group distribution. An empty group cannot be
 * ranked: chosenIndex is -1 and the ood reason says so.
 * @param {object} artifact a ranking artifact
 * @param {Array<{ features: object, key?: string }>} candidates
 * @param {{ ood?: object }} [p]
 * @returns {{ chosenIndex: number, probabilities: number[], confidence: number, rawConfidence: number, margin: number, ood: { flag: boolean, reasons: string[] } }}
 */
export function rank(artifact, candidates, { ood } = {}) {
  requireKind(artifact, 'ranking', 'rank')
  const limits = oodOf(ood)
  if (!Array.isArray(candidates) || !candidates.length) {
    return { chosenIndex: -1, probabilities: [], confidence: 0, rawConfidence: 0, margin: 0, ood: { flag: true, reasons: ['no_candidates'] } }
  }
  const scores = candidates.map((c) => logits(artifact, vectorOf(artifact, c.features))[0])
  const raw = softmax(scores)
  const p = softmax(scores.map((s) => s / temperatureOf(artifact)))
  const { best, margin } = topTwo(p)
  const reasons = new Set()
  for (const c of candidates) for (const r of featureOodReasons(artifact, c.features, limits)) reasons.add(r)
  for (const r of distributionOodReasons(p, limits)) reasons.add(r)
  return { chosenIndex: best, probabilities: p, confidence: p[best], rawConfidence: raw[best], margin, ood: { flag: reasons.size > 0, reasons: [...reasons] } }
}

/** Uncalibrated logit rows and truth indexes of a validation set, for either artifact kind. */
function validationRows(artifact, samples) {
  const rows = []
  if (artifact.kind === 'ranking') {
    for (const g of samples) {
      if (!Array.isArray(g.candidates) || !g.candidates.length || !Number.isInteger(g.chosenIndex) || g.chosenIndex < 0 || g.chosenIndex >= g.candidates.length) continue
      rows.push({ z: g.candidates.map((c) => logits(artifact, vectorOf(artifact, c.features))[0]), truth: g.chosenIndex, names: g.candidates.map((c, i) => String(c.key ?? i)) })
    }
    return rows
  }
  for (const s of samples) {
    const truth = artifact.classes.indexOf(String(s.label))
    if (truth < 0) continue // a label the artifact cannot express says nothing about its temperature
    rows.push({ z: logits(artifact, vectorOf(artifact, s.features)), truth, names: artifact.classes })
  }
  return rows
}

const nllAt = (rows, T) => rows.reduce((acc, { z, truth }) => acc - Math.log(Math.max(1e-300, softmax(z.map((v) => v / T))[truth])), 0) / rows.length

/**
 * Temperature scaling on a validation set: a grid search over [0.5, 5] in steps of 0.05 for the
 * temperature that minimises the negative log likelihood, then the calibration metrics at that
 * temperature. Returns a new artifact; the input is not touched. Ranking artifacts are
 * calibrated on the softmax over each group's candidate scores. An empty (or unusable)
 * validation set leaves the temperature at 1 and the metrics null: nothing is invented.
 * @param {object} artifact
 * @param {Array<object>} validationSamples `{ features, label }` items, or `{ candidates, chosenIndex }` groups for a ranking artifact
 * @param {{ bins?: number, highConfidence?: number }} [p] metric options, see `calibrationMetrics`
 */
export function calibrate(artifact, validationSamples, { bins = 10, highConfidence = ROUTING_DEFAULTS.highConfidence } = {}) {
  const rows = validationRows(artifact, validationSamples ?? [])
  let temperature = 1
  if (rows.length) {
    let bestNll = Infinity
    for (let step = 0; step <= 90; step++) {
      const T = Math.round((0.5 + step * 0.05) * 100) / 100
      const nll = nllAt(rows, T)
      if (nll < bestNll - 1e-12) { bestNll = nll; temperature = T }
    }
  }
  const predictions = rows.map(({ z, names }) => {
    const p = softmax(z.map((v) => v / temperature))
    const probabilities = {}
    names.forEach((name, i) => { probabilities[name] = p[i] })
    return { probabilities, label: names[topTwo(p).best] }
  })
  const metrics = rows.length
    ? calibrationMetrics(predictions, rows.map(({ names, truth }) => names[truth]), { bins, highConfidence })
    : { ece: null, brier: null, highConfidenceErrorRate: null, reliability: [] }
  return finalizeArtifact({ ...artifact, calibration: { temperature, ...metrics, n: rows.length } })
}

const r3 = (x) => Math.round(x * 1000) / 1000

/**
 * How well stated confidence matches observed accuracy.
 * ECE is the confidence-weighted gap between accuracy and mean confidence over equal-width
 * bins (a confidence of exactly 1 lands in the top bin). Brier is multi-class: the squared
 * error summed over classes and averaged over predictions; a truth label missing from a
 * prediction's probabilities counts as predicted with probability 0. The high-confidence error
 * rate is the share of wrong answers among predictions at or above `highConfidence`, 0 when no
 * prediction reached it. The reliability table is for people, so its numbers are rounded.
 * @param {Array<{ probabilities: Record<string, number>, label?: string }>} predictions
 * @param {string[]} labels the truth, aligned with `predictions`
 * @param {{ bins?: number, highConfidence?: number }} [p]
 * @returns {{ ece: number, brier: number, highConfidenceErrorRate: number, reliability: Array<{ range: string, n: number, meanConfidence: number|null, accuracy: number|null }>, n: number, highConfidenceN: number }}
 */
export function calibrationMetrics(predictions, labels, { bins = 10, highConfidence = ROUTING_DEFAULTS.highConfidence } = {}) {
  const n = predictions.length
  // One bin is the floor: a bin count of zero would leave nothing to put a confidence in.
  const width = Math.max(1, Math.trunc(bins))
  const table = Array.from({ length: width }, (_, i) => ({ lo: i / width, hi: (i + 1) / width, n: 0, confidence: 0, correct: 0 }))
  let brier = 0; let highN = 0; let highWrong = 0
  predictions.forEach((pred, i) => {
    const truth = String(labels[i])
    const entries = Object.entries(pred.probabilities ?? {})
    const top = entries.reduce((m, e) => (m === null || e[1] > m[1] ? e : m), null)
    const predicted = pred.label !== undefined ? String(pred.label) : top?.[0]
    const confidence = top ? top[1] : 0
    const correct = predicted === truth ? 1 : 0
    const bin = table[Math.min(width - 1, Math.max(0, Math.floor(confidence * width)))]
    bin.n += 1; bin.confidence += confidence; bin.correct += correct
    let sq = 0; let sawTruth = false
    for (const [c, p] of entries) { sawTruth = sawTruth || c === truth; sq += (p - (c === truth ? 1 : 0)) ** 2 }
    brier += sq + (sawTruth ? 0 : 1)
    if (confidence >= highConfidence) { highN += 1; highWrong += 1 - correct }
  })
  const ece = n ? table.reduce((acc, b) => acc + (b.n ? (b.n / n) * Math.abs(b.correct / b.n - b.confidence / b.n) : 0), 0) : 0
  const reliability = table.map((b) => ({
    range: `${Math.round(b.lo * 1000) / 1000}-${Math.round(b.hi * 1000) / 1000}`,
    n: b.n,
    meanConfidence: b.n ? r3(b.confidence / b.n) : null,
    accuracy: b.n ? r3(b.correct / b.n) : null,
  }))
  return { ece, brier: n ? brier / n : 0, highConfidenceErrorRate: highN ? highWrong / highN : 0, reliability, n, highConfidenceN: highN }
}

/**
 * Accuracy, balanced accuracy, macro F1, per-class precision/recall/F1 and the confusion table
 * on a labelled set. Per-class entries and macro F1 cover every class that appears as truth or
 * as a prediction; balanced accuracy is the mean recall over the classes with truth samples.
 * For a ranking artifact the samples are groups, accuracy is top-1 agreement with
 * `chosenIndex`, and the class of a group is its chosen candidate's `key` (its index when
 * candidates carry no key).
 * @param {object} artifact
 * @param {Array<object>} samples
 * @returns {{ n: number, accuracy: number, balancedAccuracy: number, macroF1: number, perClass: Record<string, { n: number, precision: number, recall: number, f1: number }>, confusion: Record<string, Record<string, number>> }}
 */
export function evaluate(artifact, samples) {
  const pairs = []
  const list = samples ?? []
  if (artifact.kind === 'ranking') {
    for (const g of list) {
      // A group whose chosen index points at no candidate is not evidence either way: counting it
      // would invent a truth class out of a stray number.
      if (!Array.isArray(g.candidates) || !g.candidates.length || !Number.isInteger(g.chosenIndex) || g.chosenIndex < 0 || g.chosenIndex >= g.candidates.length) continue
      const keyOf = (i) => String(g.candidates[i]?.key ?? i)
      pairs.push([keyOf(g.chosenIndex), keyOf(rank(artifact, g.candidates).chosenIndex)])
    }
  } else {
    for (const s of list) pairs.push([String(s.label), predict(artifact, s.features).label])
  }
  const n = pairs.length
  const classes = [...new Set(pairs.flat())].sort()
  const confusion = {}
  for (const [truth, predicted] of pairs) {
    confusion[truth] ??= {}
    confusion[truth][predicted] = (confusion[truth][predicted] ?? 0) + 1
  }
  const perClass = {}
  for (const c of classes) {
    const tp = confusion[c]?.[c] ?? 0
    const truthN = Object.values(confusion[c] ?? {}).reduce((a, b) => a + b, 0)
    const predictedN = classes.reduce((acc, t) => acc + (confusion[t]?.[c] ?? 0), 0)
    const precision = predictedN ? tp / predictedN : 0
    const recall = truthN ? tp / truthN : 0
    perClass[c] = { n: truthN, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 }
  }
  const withTruth = classes.filter((c) => perClass[c].n > 0)
  return {
    n,
    accuracy: n ? pairs.filter(([t, p]) => t === p).length / n : 0,
    balancedAccuracy: withTruth.length ? withTruth.reduce((acc, c) => acc + perClass[c].recall, 0) / withTruth.length : 0,
    macroF1: classes.length ? classes.reduce((acc, c) => acc + perClass[c].f1, 0) / classes.length : 0,
    perClass,
    confusion,
  }
}

/** JSON with keys in sorted order at every level, so the checksum does not depend on insertion order. */
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v === undefined ? null : v)
}

/** The checksum of an artifact: sha256 of everything except the checksum itself. */
export function checksumOf(artifact) {
  const { checksum, ...rest } = artifact
  return createHash('sha256').update(canonical(rest)).digest('hex')
}

/** A copy of the artifact with its checksum recomputed. Every function that changes an artifact ends here. */
export function finalizeArtifact(artifact) {
  const out = { ...artifact }
  out.checksum = checksumOf(out)
  return out
}

const finiteRow = (row, length) => Array.isArray(row) && row.length === length && row.every((v) => typeof v === 'number' && Number.isFinite(v))

/**
 * Is this artifact something that can safely serve predictions: the right kind, finite weights,
 * shapes that agree with its index and classes, and a checksum that matches its content.
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifyArtifact(artifact) {
  const fail = (reason) => ({ ok: false, reason })
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return fail('not an artifact object')
  if (!KINDS.includes(artifact.kind)) return fail(`kind must be ${KINDS.join(' or ')}`)
  const index = artifact.index
  if (!index || !Array.isArray(index.numeric) || !index.categorical || typeof index.categorical !== 'object') return fail('index is malformed')
  if (Object.values(index.categorical).some((v) => !Array.isArray(v))) return fail('index categorical vocabularies are malformed')
  if (!Array.isArray(artifact.classes)) return fail('classes must be an array')
  const dim = dimensionOf(index)
  const rows = artifact.kind === 'ranking' ? 1 : artifact.classes.length
  if (!Array.isArray(artifact.weights) || artifact.weights.length !== rows) return fail(`weights must have ${rows} rows`)
  if (!artifact.weights.every((row) => finiteRow(row, dim))) return fail(`every weight row must hold ${dim} finite numbers`)
  if (!finiteRow(artifact.bias, rows)) return fail(`bias must hold ${rows} finite numbers`)
  const st = artifact.standardization
  if (!st || !finiteRow(st.mean, index.numeric.length) || !finiteRow(st.std, index.numeric.length)) return fail('standardization must hold a finite mean and std per numeric feature')
  if (typeof artifact.checksum !== 'string' || artifact.checksum !== checksumOf(artifact)) return fail('checksum does not match the content')
  return { ok: true, reason: null }
}

/**
 * Write an artifact atomically: the JSON goes to a temporary file next to the target and is
 * renamed over it, so a reader never sees a half-written artifact. The checksum is recomputed
 * first, so an artifact whose metadata the caller updated (promotion state, validation) still
 * verifies when it comes back.
 * @returns {object} the artifact as written
 */
export function saveArtifact(file, artifact) {
  const sealed = finalizeArtifact(artifact)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(sealed)}\n`)
  renameSync(tmp, file)
  return sealed
}

/**
 * Read an artifact back, or say why it cannot be used. Never throws for an unloadable file:
 * missing, unparseable, failing verification, a different feature schema version or a different
 * domain each come back as `{ artifact: null, reason }` for the inspector to show.
 * @param {string} file
 * @param {{ domain?: string, featureSchemaVersion?: number }} [expect] omit `domain` to accept any
 * @returns {{ artifact: object|null, reason?: string }}
 */
export function loadArtifact(file, { domain, featureSchemaVersion = FEATURE_SCHEMA_VERSION } = {}) {
  if (!existsSync(file)) return { artifact: null, reason: `missing: ${file}` }
  let artifact
  try { artifact = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { artifact: null, reason: `unreadable: ${e.message}` } }
  const verdict = verifyArtifact(artifact)
  if (!verdict.ok) return { artifact: null, reason: `invalid: ${verdict.reason}` }
  if (artifact.featureSchemaVersion !== featureSchemaVersion) return { artifact: null, reason: `feature schema version ${artifact.featureSchemaVersion} differs from ${featureSchemaVersion}` }
  if (domain !== undefined && artifact.domain !== domain) return { artifact: null, reason: `domain ${artifact.domain} differs from ${domain}` }
  return { artifact }
}

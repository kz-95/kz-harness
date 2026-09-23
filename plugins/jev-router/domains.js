// The routing domain controller: who decides, and how a domain earns the right to decide alone.
//
// One controller per routing domain. It answers exactly one question per decision, "Jev, the
// local classifier, or the safe fallback?", and it answers it from evidence rather than hope:
// how many verified samples the domain has, how accurate and how well calibrated its classifier
// is on a held-out slice and on the recent window, whether the input looks like anything it was
// trained on, and whether the world has drifted since. Every decision it routes is recorded as a
// training sample, so using the router is what makes the router better.
//
// The maturity ladder is walked one rung at a time and never skipped:
//
//   JEV_PRIMARY -> SHADOW -> GUARDED_LOCAL -> LOCAL_ONLY
//
// and it is walked back down the moment the evidence stops supporting it. Three things can
// never be argued past: a rung is only reached with the samples, accuracy, calibration, recent
// performance and label quality its risk class demands; an out-of-distribution input goes to Jev
// whatever the classifier's confidence says; and a critical failure drops the domain to
// JEV_PRIMARY immediately. Local authority is a privilege the evidence keeps paying for.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  FEATURE_SCHEMA_VERSION, calibrate, calibrationMetrics, evaluate, loadArtifact, predict, rank, saveArtifact, trainMulticlass, trainRanker, verifyArtifact,
} from './classifier.js'
import { MATURITY, gatesFor, resolvePolicy } from './routing-policy.js'

/** The ladder, in order. ROLLBACK is a state, not a rung: it is where a domain waits to re-earn one. */
export const LADDER = Object.freeze(['JEV_PRIMARY', 'SHADOW', 'GUARDED_LOCAL', 'LOCAL_ONLY'])
/** States in which the local classifier may decide anything at all. */
export const LOCAL_STATES = Object.freeze(['GUARDED_LOCAL', 'LOCAL_ONLY'])
/** How bad a rollback was, worst first. Severity picks the destination and the way back. */
export const SEVERITIES = Object.freeze(['critical', 'severe', 'significant', 'minor'])
/**
 * The shape of a persisted domain state. 2: `samplesAtRollback` is the verified count at the
 * rollback itself, or null until an evaluation counts it. A state file with no version predates
 * that, and its rollback point was copied from the evaluation BEFORE the rollback. 3: a rollback
 * is kept open until the domain is back on `recoverTo`, the rung it lost, with the point moved up
 * to the verified count at each rung re-earned on the way, and a window only counts
 * with verified rows that arrived after the last one counted (`windowSamples`,
 * `badWindowSamples`). A version 2 file has neither, and the windows it counted may have been the
 * same evidence evaluated twice.
 */
export const STATE_VERSION = 3

// How many bins of a numeric feature's training histogram must hold something before drift on it
// means anything. Below this the feature is effectively a flag, and PSI over it is noise.
const MIN_DRIFT_BINS = 3
// How many recent observations a drift reading needs before it means anything.
const MIN_DRIFT_SAMPLES = 30

const nextRung = (state) => LADDER[LADDER.indexOf(state) + 1] ?? null
/** The higher of two states on the ladder; anything off it (null, ROLLBACK) is below every rung. */
const higherRung = (a, b) => (LADDER.indexOf(b) > LADDER.indexOf(a) ? b : LADDER.includes(a) ? a : null)
const isLocal = (state) => LOCAL_STATES.includes(state)
const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
/** How many verified samples an artifact was trained from: the whole history it saw, all slices. */
const trainedFrom = (a) => (a ? num(a.extras?.verifiedSamples, num(a.sampleCount)) : 0)

/**
 * Population Stability Index between a baseline and a current sample of one numeric feature.
 * Equal-width bins over the union range; a bin empty on one side is floored so the logarithm
 * stays finite. 0 means the two look alike; the policy's thresholds say how much is too much.
 * @param {number[]} baseline
 * @param {number[]} current
 * @param {number} [bins]
 * @returns {number} 0 when either side is empty: no comparison is not drift.
 */
export function histogram(values, lo, hi, bins = 10) {
  const width = Math.max(1, Math.trunc(bins))
  const out = new Array(width).fill(0)
  if (!(hi > lo)) return out
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    out[Math.min(width - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * width)))] += 1
  }
  return out
}

/** PSI between two histograms over the same bins. Empty bins are floored so the logarithm is finite. */
export function psiFromCounts(baseline, current) {
  const na = baseline.reduce((a, b) => a + b, 0)
  const nb = current.reduce((a, b) => a + b, 0)
  if (!na || !nb || baseline.length !== current.length) return 0
  // A zero share would send the logarithm to infinity, so an empty bin is treated as holding
  // less than one observation rather than none: the drift it reports stays finite and ordered.
  const floor = 1 / (2 * Math.max(na, nb))
  let total = 0
  for (let i = 0; i < baseline.length; i++) {
    const pa = Math.max(floor, baseline[i] / na)
    const pb = Math.max(floor, current[i] / nb)
    total += (pb - pa) * Math.log(pb / pa)
  }
  return total
}

export function psi(baseline, current, bins = 10) {
  const a = (baseline ?? []).filter((v) => Number.isFinite(v))
  const b = (current ?? []).filter((v) => Number.isFinite(v))
  if (!a.length || !b.length) return 0
  const lo = Math.min(...a, ...b)
  const hi = Math.max(...a, ...b)
  if (!(hi > lo)) return 0
  const width = Math.max(1, Math.trunc(bins))
  return psiFromCounts(histogram(a, lo, hi, width), histogram(b, lo, hi, width))
}

/**
 * Jensen-Shannon divergence between two categorical count maps, in bits (0 to 1). The right
 * measure for a categorical feature, where PSI's bins mean nothing.
 * @param {Record<string, number>} countsA
 * @param {Record<string, number>} countsB
 */
export function jsDivergence(countsA = {}, countsB = {}) {
  const keys = [...new Set([...Object.keys(countsA), ...Object.keys(countsB)])]
  const sum = (c) => Object.values(c).reduce((a, b) => a + num(b), 0)
  const na = sum(countsA)
  const nb = sum(countsB)
  if (!na || !nb || !keys.length) return 0
  const term = (p, m) => (p > 0 ? p * Math.log2(p / m) : 0)
  let total = 0
  for (const k of keys) {
    const p = num(countsA[k]) / na
    const q = num(countsB[k]) / nb
    const m = (p + q) / 2
    if (m > 0) total += 0.5 * term(p, m) + 0.5 * term(q, m)
  }
  return total
}

/** Counts of each value of one categorical feature across a set of feature objects. */
const categoryCounts = (featureSets, name) => {
  const out = {}
  for (const f of featureSets) {
    const v = f?.categorical?.[name]
    if (typeof v === 'string') out[v] = (out[v] ?? 0) + 1
  }
  return out
}

/** The feature objects of a sample row, whichever kind the domain is. */
const featuresOf = (row) => {
  const own = row?.input?.features
  const cands = (row?.input?.candidates ?? []).map((c) => c.features).filter(Boolean)
  return own ? [own, ...cands] : cands
}

/**
 * The label a row is judged against: the outcome's, once there is an outcome, and the teacher's
 * only while there is none.
 *
 * Never "the outcome's, else the teacher's". A run that proves the pick wrong records what it was
 * NOT (`label: null` / `chosenKey: null`, with the rejected answer in `negativeLabel` /
 * `negativeKey`), and a person tagging a misread records the same thing. Falling through to the
 * teacher there turned "this answer was wrong" into "this answer was right": trained on at a
 * reduced weight for a failed run, at FULL weight for a person's correction (labelSource 'human'
 * counts as outcome-backed), and scored as ground truth when accuracy was measured. A null here
 * means the row says what the answer isn't, which is not a positive example of anything.
 */
const truthOf = (row) => (row?.outcome
  ? row.outcome.label ?? row.outcome.chosenKey ?? null
  : row?.teacher?.label ?? row?.teacher?.chosenKey ?? null)
/**
 * Evidence that does not come from the teacher: the run proved the label, or a person stated it.
 *
 * Deliberately stricter than the training store's own `outcomeBacked` counter, which also counts
 * `teacher_confirmed`. That source means the teacher's own pick went on to be accepted, which is
 * the teacher agreeing with itself: useful, and enough to train on at a reduced weight, but not
 * the independent evidence a domain must show before it is trusted to route without the teacher.
 * A router promoted on teacher-confirmed labels alone would have learned to copy the teacher's
 * mistakes and nothing else.
 */
const isOutcomeBacked = (row) => row?.outcome?.verified === true && ['verified_outcome', 'human'].includes(row?.outcome?.labelSource)

/**
 * A verified row as a training item. A ranking domain needs its candidate group and the index of
 * the candidate the outcome justified; a multiclass domain needs its features and its label.
 * Returns null for a row that cannot teach anything (the labelled candidate is gone, or the row
 * carries no features).
 */
function trainingItem(row, kind) {
  if (kind === 'ranking') {
    const candidates = row?.input?.candidates ?? []
    const key = truthOf(row)
    const chosenIndex = candidates.findIndex((c) => c.key === key)
    if (!candidates.length || chosenIndex < 0 || candidates.some((c) => !c.features)) return null
    return { candidates: candidates.map((c) => ({ features: c.features, key: c.key })), chosenIndex, weight: isOutcomeBacked(row) ? 1 : 0.6 }
  }
  const label = truthOf(row)
  const features = row?.input?.features
  if (!label || !features) return null
  // A teacher-only label is weaker evidence than one a run proved, and says so in its weight.
  return { features, label, weight: isOutcomeBacked(row) ? 1 : 0.6 }
}

/** Time-aware split: oldest for training, then calibration, newest held out. Never shuffled. */
export function splitRows(rows, split) {
  const n = rows.length
  const trainEnd = Math.floor(n * split.train)
  const valEnd = trainEnd + Math.floor(n * split.validation)
  return { train: rows.slice(0, trainEnd), validation: rows.slice(trainEnd, valEnd), holdout: rows.slice(valEnd) }
}

/** `context.extra`, resolved: an object as given, or what the function makes of the answer. */
function extraOf(extra, context) {
  const value = typeof extra === 'function' ? extra(context) : extra
  return value && typeof value === 'object' && Object.keys(value).length ? { extra: value } : null
}

/** The classes that carry enough of the data to matter, and their sample counts. */
function significantClasses(rows, share) {
  const counts = {}
  for (const r of rows) { const l = truthOf(r); if (l) counts[l] = (counts[l] ?? 0) + 1 }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const significant = Object.entries(counts).filter(([, n]) => total && n / total >= share).map(([c]) => c)
  return { counts, significant, total }
}

/**
 * One routing domain's controller.
 *
 * @param {object} p
 * @param {string} p.domain        a key of `policy.domains`
 * @param {object} [p.policy]      resolvePolicy() result
 * @param {object} p.store         createTrainingStore() result
 * @param {string} [p.artifactsDir] where classifier artifacts live
 * @param {string} [p.stateFile]   where this domain's maturity state is kept
 * @param {Function} [p.now]       the clock, ms
 * @param {Function} [p.log]
 */
export function createDomainController({ domain, policy = resolvePolicy(), store, artifactsDir, stateFile, now = () => Date.now(), log = () => {} } = {}) {
  const spec = policy.domains[domain]
  if (!spec) throw new Error(`routing domain: unknown domain ${domain}`)
  const gates = gatesFor(policy, domain)
  const kind = spec.kind
  const artifactFile = artifactsDir ? join(artifactsDir, `${domain}.json`) : null
  const previousFile = artifactsDir ? join(artifactsDir, `${domain}.previous.json`) : null

  let state = {
    stateVersion: STATE_VERSION,
    domain,
    riskClass: spec.risk,
    kind,
    maturity: 'JEV_PRIMARY',
    since: new Date(now()).toISOString(),
    previousMaturity: null,
    rollbackReason: null,
    rollbackSeverity: null,
    rollbackAt: null,
    samplesAtRollback: 0,
    // The rung a rollback took away, kept until the domain stands on it again: every rung up to it
    // is re-earned on new evidence, not only the first one. Null when nothing is owed.
    recoverTo: null,
    consecutiveGoodWindows: 0,
    consecutiveBadWindows: 0,
    // The verified count at the last good and the last bad window counted. A window is new
    // evidence or it is not a window: evaluating the same rows twice is one look, not two.
    windowSamples: null,
    badWindowSamples: null,
    // The last retrained artifact that was measured against the rung the domain holds and failed.
    challenger: null,
    lastEvaluation: null,
    lastDrift: null,
    artifactVersion: null,
    artifactReason: null,
    oodRecent: { n: 0, flagged: 0 },
  }
  let artifact = null
  let artifactReason = 'not trained yet'

  const persist = () => {
    if (!stateFile) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, stateFile)
    } catch (err) { log(`routing domain ${domain}: state not saved (${err.message})`) }
  }

  /**
   * Walk to `next`, up or down. `samples` is the verified count AT this moment, and only a caller
   * holding a fresh count can supply it: the last evaluation's count is the count from BEFORE the
   * rows that caused the rollback, so reading it here would credit exactly those rows as the new
   * evidence that undoes the rollback. A caller with no count of its own (a critical failure, an
   * unfamiliar input, an artifact that will not load) passes none, and the rollback point stays
   * null until the next evaluate() fixes it against the store.
   */
  const setMaturity = (next, { reason, severity = null, samples = null } = {}) => {
    if (state.maturity === next) return
    const down = LADDER.indexOf(next) < LADDER.indexOf(state.maturity) || next === 'JEV_PRIMARY'
    // Still short of the rung a rollback took: the record stays open, and its point moves up to
    // this promotion, so the next rung needs evidence that arrived after this one was earned.
    // Clearing it at the first step up let every rung above that be climbed on the old evidence,
    // one back-to-back evaluate() each, which undid a critical rollback on a handful of rows.
    const recovering = !down && state.recoverTo && LADDER.indexOf(next) < LADDER.indexOf(state.recoverTo)
    state = {
      ...state,
      previousMaturity: state.maturity,
      maturity: next,
      since: new Date(now()).toISOString(),
      consecutiveGoodWindows: 0,
      windowSamples: null,
      // Going down records why and from how much evidence, and remembers the highest rung owed;
      // going up past what was owed clears the whole record, so the rung after it is judged on its
      // own gates rather than on a debt already paid. Going down also settles the bad windows: they
      // were about the rung just lost, and whatever took it (their own count, a critical failure,
      // an unfamiliar input) has acted. Left standing, one bad window before a critical rollback
      // rode the whole climb back and made the first bad window at the re-earned rung "sustained".
      ...(down
        ? { rollbackReason: reason ?? null, rollbackSeverity: severity, rollbackAt: new Date(now()).toISOString(), samplesAtRollback: samples, recoverTo: higherRung(state.recoverTo, state.maturity), consecutiveBadWindows: 0, badWindowSamples: null }
        : recovering
          ? { samplesAtRollback: samples }
          : { rollbackReason: null, rollbackSeverity: null, rollbackAt: null, samplesAtRollback: 0, recoverTo: null }),
    }
    log(`routing domain ${domain}: ${state.previousMaturity} -> ${next}${reason ? ` (${reason})` : ''}`)
    persist()
  }

  /** The local prediction for one input, or null when there is no usable artifact. */
  const localAnswer = (features, candidates) => {
    if (!artifact) return null
    try {
      if (kind === 'ranking') {
        const list = (candidates ?? []).map((c) => ({ features: c.features, key: c.key }))
        if (!list.length) return null
        const r = rank(artifact, list, { ood: policy.ood })
        if (r.chosenIndex < 0) return null
        const probabilities = {}
        list.forEach((c, i) => { probabilities[c.key ?? i] = r.probabilities[i] })
        return { chosenKey: list[r.chosenIndex].key, probabilities, confidence: r.confidence, rawConfidence: r.rawConfidence, margin: r.margin, ood: r.ood, artifactVersion: artifact.classifierVersion }
      }
      const p = predict(artifact, features, { ood: policy.ood })
      return { label: p.label, probabilities: p.probabilities, confidence: p.confidence, rawConfidence: p.rawConfidence, margin: p.margin, ood: p.ood, artifactVersion: artifact.classifierVersion }
    } catch (err) {
      // A prediction that throws is a broken artifact, not an unlucky input: stop trusting it.
      artifactReason = `prediction failed: ${err.message}`
      artifact = null
      api.noteEnvironmentChange({ kind: 'artifact_unloadable', detail: artifactReason })
      return null
    }
  }

  /**
   * An unfamiliar candidate is one this domain has barely routed: a new resource, or one whose
   * key the artifact has never scored. It is the OOD signal the design calls for when the routing
   * space itself changes, and it is checked in code because a classifier cannot know it is new.
   */
  const unfamiliarCandidates = (candidates) => {
    if (kind !== 'ranking' || !artifact) return []
    const seen = artifact.extras?.candidateSamples ?? {}
    // An artifact trained before the counts were kept by id still has them by key; it is read the
    // old way until the next retrain rather than calling every candidate new at once, which would
    // flood the OOD rate and could roll a sound domain back for nothing but an upgrade.
    const byId = artifact.extras?.candidateKeying === 'id'
    return (candidates ?? []).filter((c) => (seen[byId ? c.id ?? c.key : c.key] ?? 0) < policy.ood.familiarCandidateSamples).map((c) => c.key)
  }

  const noteOod = (flagged) => {
    const window = gates.recentWindow
    const o = state.oodRecent
    // A running share over the recent window, kept as counts so it survives a restart.
    const n = Math.min(window, o.n + 1)
    const decay = o.n >= window ? (o.flagged * (window - 1)) / window : o.flagged
    state.oodRecent = { n, flagged: decay + (flagged ? 1 : 0) }
  }
  const oodRate = () => (state.oodRecent.n ? state.oodRecent.flagged / state.oodRecent.n : 0)

  const api = {
    /** The domain's whole state, for the inspector. Pure read: nothing here decides anything. */
    state() {
      const ev = state.lastEvaluation
      return {
        ...state,
        // The counts belong at the top level: every reader wants them, and digging them out of
        // the last evaluation is how a view ends up reporting zero for a domain full of evidence.
        samples: ev?.samples ?? { total: 0, verified: 0, outcomeBacked: 0, teacherOnly: 0, sinceRollback: 0, sinceArtifact: 0 },
        artifact: artifact
          ? { version: artifact.classifierVersion, createdAt: artifact.createdAt, sampleCount: artifact.sampleCount, classes: artifact.classes, featureSchemaVersion: artifact.featureSchemaVersion, calibration: artifact.calibration ? { temperature: artifact.calibration.temperature, ece: r3(artifact.calibration.ece), brier: r3(artifact.calibration.brier), highConfidenceErrorRate: r3(artifact.calibration.highConfidenceErrorRate), n: artifact.calibration.n } : null, validation: artifact.validation ?? null }
          : null,
        artifactReason: artifact ? null : artifactReason,
        requiredConfidence: gates.confidenceThreshold,
        oodRate: r3(oodRate()),
        progress: progressOf(ev),
      }
    },

    /**
     * Who decides this one, and what they decided.
     *
     * @param {object} p
     * @param {object} p.features     routing-time features (features.js shapes)
     * @param {Array<{ key: string, id?: string, features: object }>} [p.candidates] for a ranking domain
     * @param {null|(() => Promise<object|null>)} [p.jev]  the teacher call
     * @param {() => object} p.fallback  the deterministic safe answer
     * @param {object} [p.context]    `extra` is stored on the training sample
     * @returns {Promise<object>} `{ authority, label|chosenKey, probabilities, confidence, local, teacher, reason, maturity, requiredConfidence, ood, jevCalled, sampleId }`
     */
    async decide({ features, candidates, jev, fallback, context = {} } = {}) {
      const maturity = state.maturity
      const local = localAnswer(features, candidates)
      const unfamiliar = unfamiliarCandidates(candidates)
      const ood = {
        flag: !!local?.ood?.flag || unfamiliar.length > 0,
        reasons: [...(local?.ood?.reasons ?? []), ...unfamiliar.map((k) => `unfamiliar_candidate:${k}`)],
      }
      noteOod(ood.flag)
      const threshold = gates.confidenceThreshold
      // What counts as significant unfamiliarity: something the classifier has never seen at all,
      // rather than a merely uncertain answer. This is the signal that pulls a LOCAL_ONLY domain
      // back down rather than just deferring one decision.
      const significantOod = ood.reasons.some((r) => r.startsWith('unseen_category') || r.startsWith('unfamiliar_candidate')) || oodRate() > policy.drift.oodRateDegrade

      let authority = 'jev'
      let reason = ''
      if (isLocal(maturity) && local && !ood.flag && local.confidence >= threshold) {
        authority = 'local'
        reason = `local classifier at ${r3(local.confidence)} confidence, at or above the ${threshold} this ${spec.risk} domain needs`
      } else if (isLocal(maturity)) {
        reason = !local ? `no usable local classifier (${artifactReason})`
          : ood.flag ? `out of distribution: ${ood.reasons.slice(0, 3).join(', ')}`
            : `local confidence ${r3(local.confidence)} is under the ${threshold} this ${spec.risk} domain needs`
        if (maturity === 'LOCAL_ONLY' && significantOod) {
          // Leaving LOCAL_ONLY is the point: an unfamiliar routing space is not something to
          // decide alone, and the domain re-earns the rung once the new shape is evidence.
          setMaturity('GUARDED_LOCAL', { reason: `out of distribution: ${ood.reasons.slice(0, 3).join(', ')}`, severity: 'minor' })
        }
      } else {
        reason = `${maturity}: the teacher decides while this domain is still learning`
      }

      let teacher = null
      let jevCalled = false
      let answer = null
      if (authority === 'local') {
        answer = local
      } else if (jev) {
        try {
          jevCalled = true
          teacher = await jev()
          if (teacher) answer = teacher
          else { authority = 'fallback'; reason = 'the teacher had no answer for this question' }
        } catch (err) {
          // Jev is down. A mature domain may still answer for itself when it is confident and the
          // input is familiar; an immature one must not invent a classification.
          if (isLocal(maturity) && local && !ood.flag && local.confidence >= threshold) {
            authority = 'local'
            answer = local
            reason = `teacher unavailable (${err.message}); local classifier is confident and in distribution`
          } else {
            authority = 'fallback'
            reason = `teacher unavailable (${err.message}); using the deterministic fallback`
          }
        }
      } else {
        authority = 'fallback'
        reason = isLocal(maturity) ? `${reason}, and no teacher is configured` : 'no teacher is configured and this domain has no local authority'
      }
      if (!answer) {
        answer = fallback ? fallback() : null
        if (!answer) throw new Error(`routing domain ${domain}: nothing could decide and no fallback was given`)
        if (authority !== 'fallback') { authority = 'fallback'; reason = reason || 'no answer from the chosen authority' }
      }

      // Every decision is a training candidate, whoever made it. This is the line that makes
      // using the router the thing that teaches it.
      let sampleId = null
      if (store) {
        try {
          const row = await store.append({
            domain,
            runId: context.runId ?? null,
            input: { features, ...(candidates ? { candidates: candidates.map((c) => ({ key: c.key, id: c.id, features: c.features })) } : {}) },
            teacher: teacher ? { label: teacher.label, chosenKey: teacher.chosenKey, probabilities: teacher.probabilities ?? {}, confidence: num(teacher.confidence, 0), model: teacher.model ?? null } : null,
            local: local ? { label: local.label, chosenKey: local.chosenKey, probabilities: local.probabilities ?? {}, confidence: num(local.confidence, 0), artifactVersion: local.artifactVersion ?? null, ood: !!ood.flag } : null,
            authority,
            // `extra` may be a function, because what is worth keeping is often only known once
            // the answer is in: the task domain stores the numeric profile the teacher produced,
            // which is what later lets a locally classified task type recover a real profile
            // instead of a generic one.
            ...(extraOf(context.extra, { authority, answer, teacher, local }) ?? {}),
          })
          sampleId = row.id
        } catch (err) { log(`routing domain ${domain}: sample not recorded (${err.message})`) }
      }

      return {
        authority,
        label: answer.label,
        chosenKey: answer.chosenKey,
        probabilities: answer.probabilities ?? {},
        confidence: num(answer.confidence, 0.5),
        local,
        teacher,
        reason,
        maturity: state.maturity,
        requiredConfidence: threshold,
        ood,
        jevCalled,
        sampleId,
      }
    },

    /**
     * Train, measure, and move the domain up or down the ladder. Safe to call at any time; it
     * reads the store, so it is the only place the maturity state changes on evidence.
     * @returns {Promise<object>} the evaluation
     */
    async evaluate({ retrain = true } = {}) {
      const all = await store.list({ domain })
      const verified = all.filter((r) => r.outcome?.verified === true)
      const outcomeBacked = verified.filter(isOutcomeBacked)
      // A rollback raised outside an evaluation could not count what it had, so its point is fixed
      // here, at the first evaluation after it. Everything already in the store was in hand when
      // the rung was lost, whether or not anyone had looked at it: only later rows are new evidence.
      if (state.rollbackAt && state.samplesAtRollback === null) state.samplesAtRollback = verified.length
      const samples = {
        total: all.length,
        verified: verified.length,
        outcomeBacked: outcomeBacked.length,
        teacherOnly: verified.length - outcomeBacked.length,
        sinceRollback: Math.max(0, verified.length - (state.samplesAtRollback ?? 0)),
        // Against the verified count the artifact was trained from, not its training-row count:
        // that is only the oldest 70% of it, so the difference passed everyNewSamples as soon as
        // the history was a few hundred rows long and every evaluation retrained.
        sinceArtifact: Math.max(0, verified.length - trainedFrom(artifact)),
      }
      const evaluation = { at: new Date(now()).toISOString(), samples, holdout: null, recent: null, calibration: null, drift: null, labelQuality: null, rates: null, gates: [] }

      // Retrain when there is enough new evidence, or when there is no artifact yet. A challenger
      // that was measured and turned down is not retried until that much more evidence arrived.
      const lastTrained = Math.max(trainedFrom(artifact), num(state.challenger?.verified))
      if (retrain && verified.length >= policy.retrain.minSamples && (!artifact || verified.length - lastTrained >= policy.retrain.everyNewSamples)) {
        await api.retrain({ rows: verified })
      }

      Object.assign(evaluation, measure(artifact, verified))
      state.lastDrift = evaluation.drift

      // Rates the design asks to watch even when accuracy still looks fine.
      evaluation.rates = ratesOf(verified, gates.recentWindow)
      evaluation.oodRate = r3(oodRate())

      // A window with a regression in it is never also a promotion: the "no pending regression"
      // gate stops it, so the first bad window is neither climbed past nor wiped by the climb.
      const rolledBack = applyRollback(evaluation)
      if (!rolledBack) applyPromotion(evaluation)
      evaluation.gates = gatesOf(evaluation, nextRung(state.maturity === 'ROLLBACK' ? 'JEV_PRIMARY' : state.maturity))
      evaluation.maturity = state.maturity
      state.lastEvaluation = evaluation
      persist()
      return evaluation
    },

    /**
     * Train a fresh artifact from the verified rows and calibrate it on the validation slice. At a
     * rung where the classifier decides, it goes into service only once it has passed that rung's
     * gates; one that does not is returned as null and recorded in `state.challenger`.
     */
    async retrain({ rows, force = false } = {}) {
      const verified = rows ?? (await store.list({ domain, verifiedOnly: true }))
      const usable = verified.map((r) => [r, trainingItem(r, kind)]).filter(([, item]) => item)
      const items = usable.map(([, item]) => item)
      if (items.length < (force ? 1 : policy.retrain.minSamples)) {
        artifactReason = `only ${items.length} usable verified samples, ${policy.retrain.minSamples} needed`
        return null
      }
      const { train, validation } = splitRows(items, policy.split)
      const trainRows = train.length ? train : items
      // How often each resource has been ranked, so an unfamiliar one can be recognised later.
      // Counted by the resource's stable id, not its RESOURCE_x key: the key is positional over
      // the current pool, so a brand-new resource could inherit a key an old one had used and read
      // as familiar. The id never reaches the classifier - this is a code-level check, and the
      // training items above carry features and keys only.
      const candidateSamples = {}
      if (kind === 'ranking') {
        const rawTrain = usable.slice(0, trainRows.length).map(([r]) => r)
        for (const r of rawTrain) for (const c of r.input?.candidates ?? []) { const k = c.id ?? c.key; if (k) candidateSamples[k] = (candidateSamples[k] ?? 0) + 1 }
      }
      // Where the rows it was fitted on end, by sample id: the weights on the training slice, the
      // temperature on the validation slice after it (on the training slice when there is none).
      // Recent accuracy and recent calibration are then measured only on rows after these, never
      // on rows the artifact has already seen. An id and not a count, because a row appended
      // earlier and verified later lands inside the history rather than at its end.
      const trainedThrough = usable[trainRows.length - 1][0].id ?? null
      const calibratedThrough = validation.length ? usable[train.length + validation.length - 1][0].id ?? null : trainedThrough
      const extras = { candidateSamples, candidateKeying: 'id', verifiedSamples: verified.length, trainedThrough, calibratedThrough, baseline: baselineOf(trainRows) }
      let fresh
      try {
        fresh = kind === 'ranking'
          ? trainRanker({ groups: trainRows, options: policy.retrain, domain, trainingDataVersion: String(verified.length), extras, now })
          : trainMulticlass({ samples: trainRows, options: policy.retrain, domain, trainingDataVersion: String(verified.length), extras, now })
      } catch (err) {
        artifactReason = `training failed: ${err.message}`
        log(`routing domain ${domain}: ${artifactReason}`)
        return null
      }
      fresh = calibrate(fresh, validation.length ? validation : trainRows, { highConfidence: policy.highConfidence })
      const check = verifyArtifact(fresh)
      if (!check.ok) { artifactReason = `new artifact rejected: ${check.reason}`; return null }
      // At a rung where the classifier decides, a new artifact is a challenger: it decides nothing
      // until it has passed the gates of the rung it would decide at, the ones the artifact in
      // service passed to get there. One that fails is not put into service, and the one in
      // service keeps deciding: it earned the rung, and the rollback checks keep measuring it on
      // every window, so it is not trusted blindly either. Stepping the domain down instead would
      // turn every unlucky retrain into a rollback of a classifier nothing has shown to be wrong.
      // Only with nothing in service to keep does the domain step down, to SHADOW, where the new
      // artifact's answers are recorded and never used.
      if (isLocal(state.maturity)) {
        const trial = { samples: { verified: verified.length }, ...measure(fresh, verified) }
        const blocked = gatesOf(trial, state.maturity, { challenger: true }).filter((g) => !g.ok).map((g) => g.name)
        if (blocked.length) {
          state.challenger = { version: fresh.classifierVersion, at: new Date(now()).toISOString(), verified: verified.length, rung: state.maturity, blocked }
          const why = `a retrained classifier failed the ${state.maturity} gates (${blocked.join(', ')})`
          log(`routing domain ${domain}: ${why}${artifact ? '; the one in service stays' : ''}`)
          if (artifact) { persist(); return null }
          setMaturity('SHADOW', { reason: why, severity: 'significant', samples: verified.length })
        }
      }
      if (artifactFile) {
        try {
          if (artifact && previousFile) saveArtifact(previousFile, artifact)
          saveArtifact(artifactFile, fresh)
        } catch (err) { log(`routing domain ${domain}: artifact not saved (${err.message})`) }
      }
      artifact = fresh
      artifactReason = null
      state.artifactVersion = fresh.classifierVersion
      state.artifactReason = null
      state.challenger = null
      persist()
      return fresh
    },

    /**
     * A failure serious enough that the domain has no business deciding anything: a safety rule
     * bypassed by a routing defect, a corrupt artifact, a verified high-risk mistake. Immediate,
     * and the way back is the full set of gates again.
     */
    noteCriticalFailure(reason) {
      setMaturity('JEV_PRIMARY', { reason, severity: 'critical' })
      return api.state()
    },

    /**
     * The world changed. A new resource narrows only the domains that route over resources; a
     * schema or artifact problem is critical for this domain alone. Deliberately narrow: the
     * design is explicit that adding a coding model must not reset a mature task classifier.
     * @param {{ kind: string, detail?: string, scope?: string[] }} change
     */
    noteEnvironmentChange({ kind: changeKind, detail, scope } = {}) {
      if (scope && !scope.includes(domain)) return api.state()
      if (changeKind === 'schema' || changeKind === 'artifact_unloadable') {
        artifact = null
        artifactReason = detail ?? changeKind
        setMaturity('JEV_PRIMARY', { reason: `${changeKind}${detail ? `: ${detail}` : ''}`, severity: 'critical' })
        return api.state()
      }
      if (changeKind === 'new_resource') {
        // Only a domain that ranks resources is affected by one appearing.
        if (kind !== 'ranking') return api.state()
        if (state.maturity === 'LOCAL_ONLY') setMaturity('GUARDED_LOCAL', { reason: `a new resource changed the routing space${detail ? `: ${detail}` : ''}`, severity: 'minor' })
        return api.state()
      }
      return api.state()
    },

    /** Read the persisted state and artifact back. Call once at start-up. */
    load() {
      if (stateFile) {
        try {
          const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
          if (saved && MATURITY.includes(saved.maturity)) {
            // A rollback recorded by the old code carries the count from the evaluation before
            // it, a number, so the null that makes evaluate() re-anchor never appears, and the
            // rows that caused the rollback would still count towards undoing it. Forgetting that
            // point sends it back to evaluate(), which fixes it at everything in the store: the
            // conservative choice, since only rows after the upgrade are then new evidence. Only
            // an unversioned file: a current one holds a real point, and re-anchoring it on every
            // start would reset the count each restart, so a domain restarted often enough could
            // never gather repromoteSamples.
            const version = typeof saved.stateVersion === 'number' ? saved.stateVersion : 1
            state = {
              ...state, ...saved, domain, riskClass: spec.risk, kind, stateVersion: STATE_VERSION,
              ...(version < 2 && saved.rollbackAt ? { samplesAtRollback: null } : {}),
              // An open rollback from before version 3 does not say which rung it took, and the
              // good windows it counted may be one set of rows looked at twice. Owing every rung up
              // to the top, and counting windows from none, is the reading that cannot hand back a
              // rung the evidence has not earned; the cost is that a domain that never held
              // LOCAL_ONLY re-earns it on new evidence too.
              ...(version < 3 && saved.rollbackAt ? { recoverTo: 'LOCAL_ONLY', consecutiveGoodWindows: 0, windowSamples: null } : {}),
              // Only a rung that decides counts bad windows, and leaving one settles them. A count
              // saved at any other rung was carried down by an earlier version and belongs to no
              // window the domain can still be judged on.
              ...(!isLocal(saved.maturity) ? { consecutiveBadWindows: 0, badWindowSamples: null } : {}),
            }
          }
        } catch { /* no state yet, or a damaged file: start from JEV_PRIMARY */ }
      }
      if (artifactFile) {
        const { artifact: loaded, reason } = loadArtifact(artifactFile, { domain, featureSchemaVersion: FEATURE_SCHEMA_VERSION })
        if (loaded) { artifact = loaded; artifactReason = null; state.artifactVersion = loaded.classifierVersion }
        else {
          artifact = null
          artifactReason = reason ?? 'no artifact'
          // An artifact that exists but cannot be trusted is a critical fact, not a missing file.
          if (reason && !/not found|no artifact/i.test(reason) && isLocal(state.maturity)) {
            setMaturity('JEV_PRIMARY', { reason: `artifact unusable: ${reason}`, severity: 'critical' })
          }
        }
      }
      return api.state()
    },

    /** The artifact in force, for tests and the inspector. */
    artifact: () => artifact,
  }

  // --- the gates, in one place --------------------------------------------------------------

  const samplesFor = (rung) => (rung === 'SHADOW' ? gates.shadowSamples : rung === 'GUARDED_LOCAL' ? gates.guardedSamples : gates.localOnlySamples)

  /**
   * The fewest recent rows a figure about `rung` is read from: the policy's window, or the share of
   * that rung's sample gate a time-aware split leaves unseen when that is smaller (see the "recent
   * window" gate). Counted exactly as splitRows splits, so floating point cannot move it by a row.
   */
  function recentWindowAt(rung) {
    const need = samplesFor(rung)
    return Math.min(gates.recentWindow, need - Math.floor(need * (policy.split?.train ?? 0.7)))
  }

  /**
   * The named checks for reaching `target`, each with what it needs and what it has. `challenger`
   * marks a retrained artifact's trial, judged on its own figures and not on the one in service.
   */
  function gatesOf(ev, target, { challenger = false } = {}) {
    if (!target) return []
    const g = []
    const add = (name, required, actual) => g.push({ name, required, actual: r3(actual), ok: typeof actual === 'number' && actual >= required })
    const need = samplesFor(target)
    add('verified samples', need, ev.samples.verified)
    if (target === 'SHADOW') {
      g.push({ name: 'a trained classifier', required: 1, actual: artifact ? 1 : 0, ok: !!artifact })
      return g
    }
    const bar = target === 'GUARDED_LOCAL' ? gates.guarded : gates.localOnly
    add('holdout accuracy', bar.accuracy, ev.holdout?.accuracy)
    // Recent accuracy means something only over a full window. The sample gate above counts
    // verified rows, but a row the classifier cannot train on (a ranking row whose chosen
    // resource has since gone, a row with no features) is verified and still absent here, so
    // without this a domain could pass on "recent accuracy" measured over a handful of items.
    // Recent accuracy is measured on the largest window of rows the serving artifact never trained
    // on, up to the policy's window: the design's rule is "if insufficient recent decisions exist,
    // use the largest valid recent window". VALID means as large as this rung's sample gate
    // implies - the share of it a time-aware split leaves unseen - so the published sample gate is
    // the real one (demanding a FULL window of unseen rows quietly raised it by a third), while rows
    // the classifier cannot learn from still cannot stand in for rows it can: a domain whose
    // verified rows are mostly untrainable is measured over too few to count, and waits.
    add('recent window', recentWindowAt(target), ev.recent?.n)
    add('recent accuracy', bar.recentAccuracy, ev.recent?.accuracy)
    add('macro F1', bar.macroF1, ev.holdout?.macroF1)
    g.push({ name: 'calibration error', required: bar.maxEce, actual: r3(ev.calibration?.ece), ok: typeof ev.calibration?.ece === 'number' && ev.calibration.ece <= bar.maxEce, atMost: true })
    g.push({ name: 'high-confidence mistakes', required: gates.maxHighConfidenceError, actual: r3(ev.calibration?.highConfidenceErrorRate), ok: typeof ev.calibration?.highConfidenceErrorRate === 'number' && ev.calibration.highConfidenceErrorRate <= gates.maxHighConfidenceError, atMost: true })
    g.push({ name: 'no meaningful drift', required: 1, actual: ev.drift?.level === 'drift' ? 0 : 1, ok: ev.drift?.level !== 'drift' })
    const { significant, counts } = ev.classes ?? { significant: [], counts: {} }
    const worstRecall = significant.length ? Math.min(...significant.map((c) => ev.holdout?.perClass?.[c]?.recall ?? 0)) : null
    // The risk class's own floor: a high-risk domain can demand more recall on its rare classes
    // than a low-risk one. resolvePolicy writes it into every gate block; the fallback keeps a
    // policy assembled by hand, without that step, on the global floor rather than on none.
    if (significant.length) add('recall on every significant class', gates.minClassRecall ?? policy.minClassRecall, worstRecall)
    // Anything the rollback check would act on at the target rung is not a window to climb on.
    // Without this a retry spike, or an OOD rate over oodRateDegrade, neither of which any other
    // gate reads, could promote the domain in the very evaluation that counted its first bad
    // window, and the promotion then wiped that window. The OOD rate only counts towards
    // LOCAL_ONLY, the one rung it takes away; at GUARDED_LOCAL an unfamiliar input already goes
    // to the teacher. A challenger's trial carries no rates and no OOD rate, which say nothing
    // about one artifact against another, so only its own recent accuracy and calibration count.
    // The retry, escalation and failure rates count towards the first local rung too, although at
    // SHADOW the teacher made every decision behind them. That is deliberate: they are the rates
    // the rollback check reads at GUARDED_LOCAL, so a domain promoted into a spike (an outage, a
    // bad provider day) would start the rung one window from losing it, and the classifier's
    // first decisions would be judged on traffic that says nothing about them. Waiting for the
    // spike to pass costs a few windows at SHADOW, where nothing is lost.
    const pending = regressionsOf(ev, target)
    // A bad window counted at the rung the domain holds is still pending, whatever the target's
    // own reading says. The target's window is the larger one, so a calibration breach counted over
    // the smaller window may not show in it, and the domain would climb in the very evaluation
    // that counted the bad window, taking it up to the next rung, where one more is "sustained".
    if (!challenger && isLocal(state.maturity) && state.consecutiveBadWindows > 0) pending.push(`a bad window at ${state.maturity} is waiting for its next window`)
    if (target === 'LOCAL_ONLY' && typeof ev.oodRate === 'number' && ev.oodRate > policy.drift.oodRateDegrade) pending.push(`${r3(ev.oodRate)} of recent decisions were out of distribution`)
    g.push({ name: 'no pending regression', required: 0, actual: pending.length, ok: pending.length === 0, atMost: true, ...(pending.length ? { detail: pending } : {}) })
    if (target === 'LOCAL_ONLY') {
      add('holdout samples', gates.holdoutSamples, ev.holdout?.n)
      add('outcome-backed share', gates.minOutcomeBacked, ev.labelQuality?.outcomeBackedShare)
      g.push({ name: 'teacher-only share', required: gates.maxTeacherOnly, actual: r3(ev.labelQuality?.teacherOnlyShare), ok: typeof ev.labelQuality?.teacherOnlyShare === 'number' && ev.labelQuality.teacherOnlyShare <= gates.maxTeacherOnly, atMost: true })
      const thinnest = significant.length ? Math.min(...significant.map((c) => counts[c] ?? 0)) : null
      if (significant.length) add('samples for every significant class', gates.perClassSamples, thinnest)
    }
    return g
  }

  function progressOf(ev) {
    const target = nextRung(state.maturity === 'ROLLBACK' ? 'JEV_PRIMARY' : state.maturity)
    if (!target || !ev) return { next: target, gates: [] }
    const g = ev.gates?.length ? ev.gates : gatesOf(ev, target)
    return { next: target, gates: g, blocked: g.filter((x) => !x.ok).map((x) => x.name) }
  }

  /** Move up one rung when every gate for it passes. Never more than one rung per evaluation. */
  function applyPromotion(ev) {
    const from = state.maturity === 'ROLLBACK' ? 'JEV_PRIMARY' : state.maturity
    const target = nextRung(from)
    if (!target) { state.consecutiveGoodWindows = 0; return }
    const g = gatesOf(ev, target)
    const passing = g.every((x) => x.ok)
    if (!passing) { state.consecutiveGoodWindows = 0; return }
    // After a rollback the domain must show it again, over consecutive windows and on evidence
    // that arrived since, before it gets a rung back, and that holds for every rung up to the one
    // it lost (setMaturity keeps the record open and moves its point up with each one). Severity
    // never excuses this gate: exempting the critical ones made the way back from a safety
    // breach, a corrupt artifact or a schema change the easiest climb in the system. A critical
    // rollback is still the longest way back, because it starts from JEV_PRIMARY.
    if (state.rollbackAt) {
      if (ev.samples.sinceRollback < gates.rollback.repromoteSamples) { state.consecutiveGoodWindows = 0; return }
      // A window is new evidence: without a verified row since the last window counted, this is
      // the same window looked at again, and it neither counts nor breaks the run.
      const last = state.windowSamples ?? state.samplesAtRollback ?? ev.samples.verified
      if (!(ev.samples.verified > last)) return
      state.windowSamples = ev.samples.verified
      state.consecutiveGoodWindows += 1
      if (state.consecutiveGoodWindows < policy.repromotion.consecutiveWindows) return
    }
    // No bad-window count to clear: the gate above refuses a climb while one is pending, and a
    // rung that decides nothing never holds one (stepping down from a local rung settles it).
    setMaturity(target, { reason: null, samples: ev.samples.verified })
  }

  /**
   * What in this window says the classifier is doing worse than it was: recent accuracy under its
   * floor, recent calibration error over its ceiling, a retry, escalation or failure rate well
   * over its own baseline. The rollback check acts on these, and a promotion waits for them.
   *
   * Accuracy and calibration count only over as many recent rows as `rung` is judged on
   * (recentWindowAt). Fewer is not a measurement: an artifact trained before its training slice
   * was marked has, right after the upgrade, a recent window of the few rows verified since, and
   * one miss in three read as a severe collapse that dropped a LOCAL_ONLY domain to the teacher.
   */
  function regressionsOf(ev, rung) {
    const floor = gates.rollback.recentAccuracyFloor
    const window = recentWindowAt(rung)
    const recent = (ev.recent?.n ?? 0) >= window ? ev.recent.accuracy : null
    // Calibration measured on the recent window, on rows the artifact never fitted its weights or
    // its temperature on. The artifact's own figure is from training time, fixed until the next
    // retrain, so a domain whose confidence stopped meaning anything would never have tripped it.
    const ece = (ev.recent?.calibration?.n ?? 0) >= window ? ev.recent.calibration.ece : null
    const breaches = []
    if (typeof recent === 'number' && recent < floor) breaches.push(`recent accuracy ${r3(recent)} is under the ${floor} floor`)
    if (typeof ece === 'number' && ece > gates.rollback.maxEce) breaches.push(`calibration error ${r3(ece)} on the recent window is over the ${gates.rollback.maxEce} ceiling`)
    for (const [name, r] of Object.entries(ev.rates ?? {})) {
      if (r.baseline > 0 && r.recent > r.baseline * policy.drift.rateIncreaseFactor) breaches.push(`${name} rate ${r3(r.recent)} is more than ${policy.drift.rateIncreaseFactor} times its ${r3(r.baseline)} baseline`)
    }
    return breaches
  }

  /** Drop a rung (or several) when the evidence stops supporting local authority. */
  function applyRollback(ev) {
    if (!isLocal(state.maturity)) return false
    const floor = gates.rollback.recentAccuracyFloor
    const recent = (ev.recent?.n ?? 0) >= recentWindowAt(state.maturity) ? ev.recent.accuracy : null
    const breaches = regressionsOf(ev, state.maturity)
    const severe = typeof recent === 'number' && recent < floor - policy.rollback.severeAccuracyGap
    const drifted = ev.drift?.level === 'drift'
    const oodHigh = (ev.oodRate ?? 0) > policy.drift.oodRateDegrade

    // Every rollback here is decided from this evaluation, so it knows exactly how much evidence
    // the domain had when it lost the rung: the rows that caused the rollback are on this side of
    // the line, not on the side that earns it back.
    const atRollback = ev.samples.verified
    if (severe) {
      setMaturity(policy.rollback.severeTo, { reason: `severe regression: ${breaches[0]}`, severity: 'severe', samples: atRollback })
      state.consecutiveBadWindows = 0
      state.badWindowSamples = null
      return true
    }
    if (breaches.length) {
      // The same rule as a good window: a second look at the same rows is not a second window.
      // The breach stays pending (and blocks promotion) until new evidence confirms or clears it.
      if (state.badWindowSamples !== null && !(atRollback > state.badWindowSamples)) return false
      state.consecutiveBadWindows += 1
      state.badWindowSamples = atRollback
      if (state.consecutiveBadWindows >= policy.rollback.consecutiveWindows) {
        setMaturity(policy.rollback.significantTo, { reason: `sustained regression: ${breaches.join('; ')}`, severity: 'significant', samples: atRollback })
        state.consecutiveBadWindows = 0
        state.badWindowSamples = null
        return true
      }
      return false
    }
    state.consecutiveBadWindows = 0
    state.badWindowSamples = null
    if ((drifted || oodHigh) && state.maturity === 'LOCAL_ONLY') {
      setMaturity(policy.rollback.minorTo, { reason: drifted ? `meaningful drift: ${ev.drift.worst?.feature} at ${r3(ev.drift.worst?.value)}` : `${r3(ev.oodRate)} of recent decisions were out of distribution`, severity: 'minor', samples: atRollback })
      return true
    }
    return false
  }

  /**
   * How many of the oldest verified rows `a` may have been fitted on, through the slice `marker`
   * names (`trainedThrough` for the weights, `calibratedThrough` for the temperature too). Found
   * by the row's id; an artifact from before the markers were kept, or one whose marker row is no
   * longer in the store, is taken to have seen every row that was verified when it was trained,
   * which leaves its recent window short until the next retrain rather than partly in-sample. A
   * short window is not read as a regression either (regressionsOf), so the domain keeps its rung
   * until the window holds enough rows to say something.
   */
  function seenThrough(a, verified, marker) {
    const id = a?.extras?.[marker]
    const at = id ? verified.findIndex((r) => r.id === id) : -1
    if (at >= 0) return at + 1
    return Math.min(verified.length, typeof a?.extras?.verifiedSamples === 'number' ? a.extras.verifiedSamples : verified.length)
  }

  /** Calibration of `a` on labelled items, at the temperature it serves with. Null on none. */
  function calibrationOn(a, items) {
    const predictions = []
    const labels = []
    for (const it of items) {
      if (a.kind === 'ranking') {
        const names = it.candidates.map((c, i) => String(c.key ?? i))
        const r = rank(a, it.candidates)
        if (r.chosenIndex < 0) continue
        predictions.push({ probabilities: Object.fromEntries(names.map((k, i) => [k, r.probabilities[i]])), label: names[r.chosenIndex] })
        labels.push(names[it.chosenIndex])
      } else {
        const p = predict(a, it.features)
        predictions.push({ probabilities: p.probabilities, label: p.label })
        labels.push(String(it.label))
      }
    }
    if (!predictions.length) return null
    const m = calibrationMetrics(predictions, labels, { highConfidence: policy.highConfidence })
    return { ece: m.ece, brier: m.brier, highConfidenceErrorRate: m.highConfidenceErrorRate, n: m.n }
  }

  /**
   * Everything the gates read about artifact `a` over the verified rows: holdout and recent
   * performance, calibration, drift, class counts and label quality. Used for the artifact in
   * service at every evaluation, and for a challenger before it is allowed to serve.
   *
   * The recent window is the newest rows `a` was not trained on. Taken as the newest rows of the
   * whole history, it overlapped the training slice whenever the history was shorter than the
   * window over the holdout-and-validation share, which is exactly when a domain is first judged
   * for GUARDED_LOCAL: "recent accuracy" was then partly scored on the rows the weights were
   * fitted to, and so was the rollback floor. A window with too few unseen rows is short, and the
   * "recent window" gate says so, rather than being padded with rows the classifier has seen.
   */
  function measure(a, verified) {
    const usable = verified.map((row, at) => ({ at, item: trainingItem(row, kind) })).filter((u) => u.item)
    const out = { holdout: null, recent: null, calibration: null }
    const trainEnd = a ? seenThrough(a, verified, 'trainedThrough') : verified.length
    if (a) {
      const { validation, holdout } = splitRows(usable.map((u) => u.item), policy.split)
      const holdoutRows = holdout.length ? holdout : validation
      out.holdout = holdoutRows.length ? evaluate(a, holdoutRows) : null
      const window = gates.recentWindow
      const fitEnd = Math.max(trainEnd, seenThrough(a, verified, 'calibratedThrough'))
      const recentRows = usable.filter((u) => u.at >= trainEnd).slice(-window).map((u) => u.item)
      const unfitted = usable.filter((u) => u.at >= fitEnd).slice(-window).map((u) => u.item)
      out.recent = recentRows.length ? { ...evaluate(a, recentRows), n: recentRows.length, calibration: calibrationOn(a, unfitted) } : null
      out.calibration = a.calibration ?? null
    }
    // Which labels carry enough of the data to have their own gate. Counts only: the rows
    // themselves must never end up in the persisted state file.
    const classInfo = significantClasses(verified, policy.significantClassShare)
    out.classes = { counts: classInfo.counts, significant: classInfo.significant }
    // Label quality: how much of the verified evidence a run or a person backed, rather than
    // the teacher agreeing with itself.
    const backed = verified.filter(isOutcomeBacked).length
    out.labelQuality = {
      outcomeBackedShare: verified.length ? backed / verified.length : 0,
      teacherOnlyShare: verified.length ? (verified.length - backed) / verified.length : 0,
    }
    // Drift: the recent rows the artifact was not trained on, against what it was trained on.
    out.drift = driftOf(a, verified.slice(trainEnd))
    return out
  }

  /**
   * Drift of the recent window against the histogram the artifact was actually trained on.
   *
   * The baseline has to be the real training distribution, not a summary stood in for one: a
   * normal curve fitted to a mean and a spread looks nothing like a feature with two clusters,
   * and comparing against it reports drift on perfectly healthy data. `retrain` therefore stores
   * the bins themselves next to the weights, and this reads them back.
   */
  function driftOf(a, rows) {
    const base = a?.extras?.baseline
    if (!base || rows.length < 2) return { level: 'stable', worst: null, features: {}, note: a ? 'not enough recent evidence to compare' : 'no artifact to compare against' }
    const recent = rows.slice(-gates.recentWindow).flatMap(featuresOf)
    if (!recent.length) return { level: 'stable', worst: null, features: {}, note: 'no recent features' }
    // PSI over a handful of observations swings on sampling noise alone, and a domain rolled back
    // by noise learns nothing while it waits. Below this the shape of the recent window is not
    // evidence about anything, so it is reported as stable and said to be so.
    if (recent.length < MIN_DRIFT_SAMPLES) return { level: 'stable', worst: null, features: {}, note: `only ${recent.length} recent observations, too few to read drift from` }
    const features = {}
    let worst = null
    for (const [name, b] of Object.entries(base.numeric ?? {})) {
      const values = recent.map((f) => f?.numeric?.[name]).filter((v) => Number.isFinite(v))
      if (values.length < 2 || !(b.hi > b.lo)) continue
      const value = psiFromCounts(b.counts, histogram(values, b.lo, b.hi, b.counts.length))
      features[name] = { metric: 'psi', value: r3(value) }
      if (!worst || value > worst.value) worst = { feature: name, metric: 'psi', value }
    }
    for (const [name, counts] of Object.entries(base.categorical ?? {})) {
      const value = jsDivergence(counts, categoryCounts(recent, name))
      features[name] = { metric: 'js', value: r3(value) }
      if (!worst || value > worst.value) worst = { feature: name, metric: 'js', value }
    }
    const level = !worst ? 'stable'
      : worst.metric === 'psi'
        ? (worst.value >= policy.drift.psiDrift ? 'drift' : worst.value >= policy.drift.psiWarn ? 'warning' : 'stable')
        : (worst.value >= policy.drift.jsDrift ? 'drift' : worst.value >= policy.drift.jsWarn ? 'warning' : 'stable')
    return { level, worst: worst ? { ...worst, value: r3(worst.value) } : null, features, note: null }
  }

  /**
   * The histograms the next drift check compares against: for every numeric feature the bins and
   * their counts, for every categorical one the counts per value. Hashed text columns are left
   * out on purpose: there are two thousand of them, they are sparse by construction, and drift in
   * one bucket of a hash says nothing anyone can act on.
   */
  function baselineOf(items) {
    const sets = items.flatMap((it) => (it.candidates ? it.candidates.map((c) => c.features) : [it.features])).filter(Boolean)
    const numericNames = new Set()
    const categoricalNames = new Set()
    for (const f of sets) {
      for (const n of Object.keys(f.numeric ?? {})) if (!/^h\d+$/.test(n)) numericNames.add(n)
      for (const n of Object.keys(f.categorical ?? {})) categoricalNames.add(n)
    }
    const numeric = {}
    for (const name of numericNames) {
      const values = sets.map((f) => f.numeric?.[name]).filter((v) => Number.isFinite(v))
      if (values.length < 2) continue
      const lo = Math.min(...values)
      const hi = Math.max(...values)
      if (!(hi > lo)) continue
      const counts = histogram(values, lo, hi, policy.drift.bins)
      // A feature that only ever takes two or three values has no shape for PSI to compare. Its
      // bins are nearly empty either side, so an ordinary shift between them reports as enormous
      // drift, and a routing domain would be rolled back over a task title getting one character
      // longer. Drift is only measured where there is a distribution to measure.
      if (counts.filter((c) => c > 0).length < MIN_DRIFT_BINS) continue
      numeric[name] = { lo, hi, counts }
    }
    const categorical = {}
    for (const name of categoricalNames) categorical[name] = categoryCounts(sets, name)
    return { numeric, categorical }
  }

  /** Retry, escalation and deterministic-failure rates: lifetime baseline against the recent window. */
  function ratesOf(verified, window) {
    const of = (rows, pick) => (rows.length ? rows.filter(pick).length / rows.length : 0)
    const recent = verified.slice(-window)
    const d = (r) => r.outcome?.details ?? {}
    return {
      retry: { baseline: of(verified, (r) => num(d(r).attempts, 1) > 1), recent: of(recent, (r) => num(d(r).attempts, 1) > 1) },
      escalation: { baseline: of(verified, (r) => d(r).escalated === true), recent: of(recent, (r) => d(r).escalated === true) },
      failure: { baseline: of(verified, (r) => typeof d(r).finalStatus === 'string' && !d(r).finalStatus.startsWith('accepted')), recent: of(recent, (r) => typeof d(r).finalStatus === 'string' && !d(r).finalStatus.startsWith('accepted')) },
    }
  }

  return api
}

/**
 * One controller per policy domain, sharing a store and a directory.
 * @param {object} p  as createDomainController, minus `domain`
 */
export function createDomainRegistry({ policy = resolvePolicy(), store, artifactsDir, stateDir, now, log } = {}) {
  const byId = new Map()
  for (const domain of Object.keys(policy.domains)) {
    byId.set(domain, createDomainController({
      domain, policy, store, artifactsDir,
      stateFile: stateDir ? join(stateDir, `${domain}.state.json`) : null,
      now, log,
    }))
  }
  return {
    get: (domain) => byId.get(domain) ?? null,
    all: () => [...byId.values()],
    states: () => Object.fromEntries([...byId].map(([id, c]) => [id, c.state()])),
    load: () => Object.fromEntries([...byId].map(([id, c]) => [id, c.load()])),
    /** Evaluate every domain; used by the scheduled retrain pass. */
    evaluateAll: async (opts) => Object.fromEntries(await Promise.all([...byId].map(async ([id, c]) => [id, await c.evaluate(opts)]))),
    /** Tell every domain about a change in the world; each decides whether it is affected. */
    noteEnvironmentChange: (change) => [...byId.values()].map((c) => c.noteEnvironmentChange(change)),
  }
}

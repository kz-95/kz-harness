// The governor: how scarce each resource is right now, and what a job on it is expected to cost.
//
// It reads ResourceSnapshots (resources.js) and never a provider name. Scarcity is pressure on
// the binding limit run through the plan's conservation curve, where the binding limit is the
// one under the most adjusted pressure; a reset close at hand discounts the pressure, because
// 82% used with the window resetting in ten minutes is not 82% used with five days to go. A
// money budget with no total is read against the soft and hard floors the router already
// applies, so the same shapes serve a rolling window and a prepaid balance without treating
// them as the same thing. A share spent that is only an estimate (a balance against a locally
// observed high-water mark rather than a provider's total) is weighed against the measured floor
// reading by how far each can be trusted, never taken in its place.
//
// Everything here is a signal, not a rule: the decision engine, Jev and later the local
// classifier decide what to do with a scarcity of 0.6. Every number comes from the policy.
import { candidateFeatures } from './features.js'
import { provenanceOf } from './resources.js'
import { resolvePolicy } from './routing-policy.js'

/** Where the conservation curve bends: scarcity at `startAt` and at `aggressiveAt` of a limit used. */
export const CURVE_KNEES = Object.freeze({ start: 0.2, aggressive: 0.7 })
// Exponent on the reset-proximity discount; see limitPressure. 1 would be linear.
export const RESET_CURVE = 3
/** Expected job cost classes, by total; each entry is the exclusive upper bound of its class. */
export const COST_CLASSES = Object.freeze([['very_low', 0.25], ['low', 0.5], ['medium', 0.9], ['high', Infinity]])
/** Conservation levels, from spend freely to nothing left. */
export const CONSERVATION_LEVELS = Object.freeze(['healthy', 'increasing', 'high', 'exhausted'])
/** Confidence floor for a local resource's expected cost: its scarcity is a fact, not a reading. */
const LOCAL_COST_CONFIDENCE = 0.5

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
const r2 = (x) => Math.round(x * 100) / 100
const toMs = (now) => {
  const v = typeof now === 'function' ? now() : now
  if (isNum(v)) return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? Date.now() : t
}
const planOf = (snapshot) => (typeof snapshot?.plan?.name === 'string' && snapshot.plan.name ? snapshot.plan.name.toLowerCase() : null)

/**
 * Pressure to scarcity for one plan's curve: 0 to 0.2 below `startAt`, 0.2 to 0.7 up to
 * `aggressiveAt`, 0.7 to 1 above it. Piecewise linear so a change of one number in the policy
 * moves the whole curve predictably.
 * @param {number} pressure  0..1
 * @param {{ startAt: number, aggressiveAt: number }} curve
 */
export function conservationCurve(pressure, curve) {
  const p = clamp(pressure)
  const startAt = clamp(curve?.startAt ?? 0)
  const aggressiveAt = clamp(Math.max(curve?.aggressiveAt ?? 1, startAt))
  if (p < startAt) return (p / Math.max(startAt, 1e-9)) * CURVE_KNEES.start
  if (p < aggressiveAt) return CURVE_KNEES.start + (CURVE_KNEES.aggressive - CURVE_KNEES.start) * ((p - startAt) / Math.max(aggressiveAt - startAt, 1e-9))
  return clamp(CURVE_KNEES.aggressive + (1 - CURVE_KNEES.aggressive) * ((p - aggressiveAt) / Math.max(1 - aggressiveAt, 1e-9)))
}

/**
 * Pressure from a remaining balance with no total to divide by: 1 at or under the hard floor,
 * 0.7 to 1 between the soft and hard floors, and easing towards 0 above the soft floor over
 * `budgetSoftMultiple` times it. Null when no floor is known: unknown is not invented.
 *
 * Continuous for any pair of floors an operator can write. A soft floor at or under the hard one
 * (or none) leaves no band between them, so the line above starts at 1 rather than at the knee;
 * starting it at the knee regardless dropped the reading from 1 to 0.7 a cent over the hard
 * floor, the same step the soft floor used to have. Floors of nothing give the line no length to
 * ease out over: an empty balance still reads 1, and anything above it reads as having no floor
 * (null, so a share spent or 'unknown' speaks instead) rather than as a cliff from 1 to 0.
 */
function budgetPressure(remaining, budget, governor) {
  const hard = isNum(budget?.hard) ? budget.hard : isNum(budget?.soft) ? 0 : null
  if (hard == null) return null
  const soft = isNum(budget?.soft) ? Math.max(budget.soft, hard) : hard
  if (remaining <= hard) return 1
  if (soft <= 0) return null
  if (remaining <= soft) return CURVE_KNEES.aggressive + (1 - CURVE_KNEES.aggressive) * ((soft - remaining) / (soft - hard))
  // Above the soft floor the reading falls from where the band below ends (the aggressive knee,
  // or 1 when there is no band) to nothing at `budgetSoftMultiple` times the floor. It starts
  // there so that a cent either side of the floor reads the same; a line that restarted
  // elsewhere left a step, and a balance drifting around the floor flipped the conservation hint
  // on a cent. resolvePolicy keeps the multiple above 1, so the line has a length.
  const top = soft > hard ? CURVE_KNEES.aggressive : 1
  const flush = soft * governor.budgetSoftMultiple
  return Math.max(0, top * (flush - remaining) / Math.max(flush - soft, 1e-9))
}

/**
 * One limit's adjusted pressure and how far it can be trusted, with the reset facts that
 * produced it. Pressure null when the limit says nothing usable.
 *
 * A money budget can be read two ways: by its share spent (`ratioUsed`) and by its measured
 * balance against the router's floors. The floors are the operator's own lines, and a balance
 * under them is short whatever share of some total it is, so the measurement is the floor of the
 * reading whatever either confidence says: a share that says less was spent than the balance
 * implies is ignored. A share that says more may raise the reading. When it is at least as
 * solid as the balance (a provider's own total) it stands; when it is weaker (a guess about a
 * total nobody reported) it is blended in by the two confidences, so it counts as far as it is
 * trusted. That never falls under the measurement in pressure or in scarcity, and it is
 * continuous, so there is no step at either floor.
 */
function limitPressure(l, budget, governor, nowMs) {
  let resetInMinutes = null
  let resetProximity = null
  if (l.resetsAt) {
    const t = Date.parse(l.resetsAt)
    if (!Number.isNaN(t)) resetInMinutes = Math.max(0, (t - nowMs) / 60_000)
  }
  // How close the reset is, curved rather than linear. Linearly, a weekly window three days from
  // its reset would have its pressure cut by nearly half, so a subscription 88% through its week
  // would read as comfortable on a Wednesday: exactly the mistake that empties an allowance
  // before the week ends. Cubed, the discount stays near zero for most of the window and only
  // matters when the reset is genuinely close, which is the case the discount exists for.
  if (resetInMinutes != null && isNum(l.durationMinutes) && l.durationMinutes > 0) resetProximity = (1 - clamp(resetInMinutes / l.durationMinutes)) ** RESET_CURVE
  let share = null
  if (isNum(l.ratioUsed)) {
    let pressure = clamp(l.ratioUsed)
    if (resetProximity != null) pressure *= 1 - governor.resetProximityWeight * resetProximity
    share = { pressure, confidence: provenanceOf(l, 'ratioUsed').confidence }
  }
  let floors = null
  if (l.kind === 'monetary_budget' && isNum(l.remaining)) {
    const pressure = budgetPressure(l.remaining, budget, governor)
    if (pressure != null) floors = { pressure, confidence: provenanceOf(l, 'remaining').confidence }
  }
  const facts = { resetInMinutes, resetProximity }
  if (!share && !floors) return { pressure: null, confidence: 0, ...facts }
  if (!floors) return { ...share, ...facts }
  if (!share) return { ...floors, ...facts }
  // The measurement is the floor, and it is checked before the confidences are. A low guess
  // about how much was spent can never make a measured shortage read as plenty, or a key that
  // once held a little more (and so has a high-water mark) would read as LESS scarce than the
  // same balance with no mark at all. Comparing confidences first let a tie through: stale
  // usage at staleConfidence 0 put both at 0, and 0 >= 0 handed the reading to the guess. The
  // result never falls under the measurement, so it is the same in pressure space and in the
  // scarcity space the router acts on.
  if (share.pressure <= floors.pressure) return { ...floors, ...facts }
  // A higher share as solid as the balance is the better reading and stands on its own.
  if (share.confidence >= floors.confidence) return { ...share, ...facts }
  // A higher but weaker estimate is still worth something - a balance far below its high-water
  // mark is a hint it is being drawn down - so it raises the reading in proportion to how far it
  // is trusted.
  // Positive: the floors' confidence is above the share's, which is at least 0.
  const weight = share.confidence + floors.confidence
  return {
    pressure: (share.pressure * share.confidence + floors.pressure * floors.confidence) / weight,
    // The blend is trusted as its parts are, in the same proportions: less than the
    // measurement alone, more than the guess alone.
    confidence: (share.confidence ** 2 + floors.confidence ** 2) / weight,
    ...facts,
  }
}

/**
 * How scarce one resource is. Local: 0 at full confidence. Otherwise the binding limit (highest
 * adjusted pressure) through the plan's curve, at the confidence of the figures that reading
 * rests on (an estimated share spent lowers it). No usable limit: scarcity null, confidence 0,
 * basis 'unknown'.
 * @param {object} snapshot  ResourceSnapshot
 * @param {object} [policy]  resolvePolicy result
 * @param {Function|number|string} [now]  the clock
 * @returns {{ scarcity: number|null, confidence: number, basis: string, pressure: number|null, resetInMinutes: number|null, resetProximity: number|null, plan: string|null }}
 */
export function scarcityOf(snapshot, policy = resolvePolicy(), now = Date.now) {
  const governor = policy.governor
  const plan = planOf(snapshot)
  const base = { scarcity: null, confidence: 0, basis: 'unknown', pressure: null, resetInMinutes: null, resetProximity: null, plan }
  if (snapshot?.source === 'local') return { ...base, scarcity: 0, confidence: 1, basis: 'local', pressure: 0 }
  const nowMs = toMs(now)
  let binding = null
  for (const l of snapshot?.limits ?? []) {
    const p = limitPressure(l, snapshot.economics?.budget, governor, nowMs)
    if (p.pressure == null) continue
    // Strictly greater: on a tie the first limit stays binding, so the order is deterministic.
    if (!binding || p.pressure > binding.pressure) binding = { ...p, limit: l }
  }
  if (!binding) return base
  const curve = governor.conservation.plans?.[plan] ?? governor.conservation.default
  return {
    scarcity: conservationCurve(binding.pressure, curve),
    confidence: clamp(isNum(binding.confidence) ? binding.confidence : 0),
    basis: `limit:${binding.limit.id}`,
    pressure: binding.pressure,
    resetInMinutes: binding.resetInMinutes,
    resetProximity: binding.resetProximity,
    plan,
  }
}

const costClass = (total) => COST_CLASSES.find(([, bound]) => total < bound)[0]

/**
 * What a job on this resource is expected to cost, in the policy's unitless scale: the
 * execution itself (marginal cost plus scarcity), the retry a failure would cost, the review the
 * task's risk calls for, and the escalation a failure on a risky task would need. The candidate
 * carries the governor's own scarcity and reliability when decision.js built it; the snapshot
 * fills in whatever the candidate does not say.
 * @param {object} p
 * @param {object} [p.snapshot]   ResourceSnapshot
 * @param {object} [p.candidate]  candidate as decision.js builds it
 * @param {object} [p.profile]    task profile
 * @param {object} [p.policy]     resolvePolicy result
 * @param {Function|number|string} [p.now]  the clock, for scarcity read from the snapshot
 * @returns {{ execution: number, retry: number, review: number, escalation: number, total: number, class: string, confidence: number }}
 */
export function expectedJobCost({ snapshot, candidate = {}, profile = {}, policy = resolvePolicy(), now = Date.now } = {}) {
  const cost = policy.governor.cost
  const source = candidate.source ?? snapshot?.source
  const sc = 'scarcity' in candidate
    ? { scarcity: candidate.scarcity, confidence: isNum(candidate.scarcityConfidence) ? candidate.scarcityConfidence : 0 }
    : snapshot ? scarcityOf(snapshot, policy, now) : { scarcity: null, confidence: 0 }
  const marginalCost = candidate.marginalCost ?? snapshot?.economics?.marginalCost ?? 'metered'
  const marginal = isNum(cost.marginal[marginalCost]) ? cost.marginal[marginalCost] : cost.marginal.metered
  const execution = marginal + cost.scarcityWeight * (isNum(sc.scarcity) ? sc.scarcity : 0)
  const fit = candidateFeatures(profile, candidate).numeric.fit
  const reliability = candidate.reliability ?? {}
  const pFail = clamp(1 - (isNum(reliability.score) ? reliability.score : 0.5) * (0.5 + 0.5 * fit))
  const risk = isNum(profile.risk) ? profile.risk : 0.5
  const retry = cost.retryWeight * pFail * execution
  const review = cost.reviewWeight * risk
  const escalation = cost.escalationWeight * pFail * risk
  const total = execution + retry + review + escalation
  let confidence = Math.min(clamp(sc.confidence ?? 0), clamp(isNum(reliability.confidence) ? reliability.confidence : 0))
  if (source === 'local') confidence = Math.max(confidence, LOCAL_COST_CONFIDENCE)
  return { execution, retry, review, escalation, total, class: costClass(total), confidence }
}

const AVAILABILITY_CLASS = { ok: 'ok', near: 'near' }
const LATENCY_CLASS = { local: 'fast', api: 'medium', subscription: 'slow' }

/** The hard fact: a reason string when the resource cannot be used now, else null. */
const unavailableReason = (s) => {
  const a = s?.availability ?? {}
  if (!['stopped', 'exhausted', 'unavailable'].includes(a.state)) return null
  return a.reason ?? `${a.state}${a.until ? ` until ${a.until}` : ''}`
}

/**
 * The governor's signals per resource, for decision.js to build candidates from. `availability`
 * is the soft class (ok, near, unknown); `unavailable` the hard fact. Latency is by source: a
 * local model answers fastest, an API next, an agentic CLI slowest.
 * @param {object} p
 * @param {object[]} [p.snapshots]  ResourceSnapshot[]
 * @param {object} [p.policy]       resolvePolicy result
 * @param {Function|number|string} [p.now]  the clock
 * @returns {Map<string, object>} resourceId -> { scarcity, scarcityConfidence, resetProximity, resetInMinutes, marginalCost, availability, unavailable, latencyClass, plan, basis, pressure }
 */
export function governorSignals({ snapshots = [], policy = resolvePolicy(), now = Date.now } = {}) {
  const out = new Map()
  for (const s of snapshots) {
    if (!s?.resourceId) continue
    const sc = scarcityOf(s, policy, now)
    out.set(s.resourceId, {
      scarcity: sc.scarcity,
      scarcityConfidence: sc.confidence,
      resetProximity: sc.resetProximity,
      resetInMinutes: sc.resetInMinutes,
      marginalCost: s.economics?.marginalCost ?? 'metered',
      availability: AVAILABILITY_CLASS[s.availability?.state] ?? 'unknown',
      unavailable: unavailableReason(s),
      latencyClass: LATENCY_CLASS[s.source] ?? 'medium',
      plan: sc.plan,
      basis: sc.basis,
      pressure: sc.pressure,
    })
  }
  return out
}

const levelOf = (signal) => {
  if (signal.unavailable) return 'exhausted'
  if (!isNum(signal.scarcity)) return 'healthy'
  if (signal.scarcity >= CURVE_KNEES.aggressive) return 'high'
  if (signal.scarcity >= CURVE_KNEES.start) return 'increasing'
  return 'healthy'
}

function hintOf(signal, profile, policy) {
  const level = levelOf(signal)
  const curve = policy.governor.conservation.plans?.[signal.plan] ?? policy.governor.conservation.default
  const where = signal.basis && signal.basis !== 'unknown' && signal.basis !== 'local' ? `${signal.basis.replace(/^limit:/, '')} limit` : null
  const soon = isNum(signal.resetInMinutes) && isNum(signal.resetProximity) && signal.resetProximity > 0.5 ? `, reset in ${Math.round(signal.resetInMinutes)} minutes` : ''
  const task = `this task is complexity ${r2(isNum(profile?.complexity) ? profile.complexity : 0.5)}, risk ${r2(isNum(profile?.risk) ? profile.risk : 0.5)}`
  const plan = signal.plan ? `${signal.plan} plan conserves from ${Math.round(curve.startAt * 100)}% used` : `conservation starts at ${Math.round(curve.startAt * 100)}% used`
  let note
  if (level === 'exhausted') note = `not usable now: ${signal.unavailable}`
  else if (signal.basis === 'local') note = 'local, nothing to conserve'
  else if (!isNum(signal.scarcity)) note = 'usage unknown: no limit data, so nothing here argues for or against spending it'
  else if (level === 'healthy') note = `${where ?? 'usage'} at ${Math.round((signal.pressure ?? 0) * 100)}% pressure${soon}: spend normally (${plan})`
  else if (level === 'increasing') note = `${where ?? 'usage'} at ${Math.round((signal.pressure ?? 0) * 100)}% pressure${soon}: prefer a cheaper resource for easy work; ${task}`
  else note = `${where ?? 'usage'} at ${Math.round((signal.pressure ?? 0) * 100)}% pressure${soon}: reserve for hard or risky work; ${task}`
  return { level, note }
}

/**
 * A conservation level and a one-line note per resource. Never a rule: nothing here removes a
 * resource from the pool. The decision engine's conservation limit reads the level (anything but
 * `healthy` is a resource being used up) and decides there. Given the signals Map it returns a
 * Map of hints by resourceId; given one signal it returns that resource's hint.
 * @param {Map<string, object>|object} signals  governorSignals output, or one of its values
 * @param {object} [profile]  task profile
 * @param {object} [policy]   resolvePolicy result
 * @returns {Map<string, { level: string, note: string }>|{ level: string, note: string }}
 */
export function conservationHint(signals, profile = {}, policy = resolvePolicy()) {
  if (signals instanceof Map) return new Map([...signals].map(([id, s]) => [id, hintOf(s, profile, policy)]))
  return hintOf(signals ?? {}, profile, policy)
}

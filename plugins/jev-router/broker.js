// The model broker: an execution strategy plus a pool of candidates becomes the concrete
// steps the routing loop runs. The router picks a strategy (Jev at first, a local classifier
// once that domain matures); this file says what the strategy means in agents and roles, and
// which strategies are even possible with the candidates at hand.
//
// Eligibility is deterministic and lives here, never in a prompt: a plan-then-execute strategy
// needs two distinct resources with a real strength gap, a review strategy needs a reviewer
// other than the worker, a parallel second opinion needs read-only work (one mutating task per
// workspace is a hard rule of the harness), and a local-first strategy needs a local model.
// Named models never appear: a "premium" resource is whichever candidate the capability
// registry currently rates strongest for this task.
import { STRATEGIES, resolvePolicy, tierAtLeast } from './routing-policy.js'

const TIER_RANK = { weak: 0, unknown: 1, standard: 2, strong: 3, frontier: 4 }
const rankOf = (c) => TIER_RANK[c.tier] ?? 1
// Number.isFinite, not typeof: NaN is a number, and one of them reaching the ranking below
// spreads through every score, leaves the sort comparing NaN so it keeps the input order, and
// picks arbitrarily with nothing reported wrong. A missing reading is the neutral 0.5 instead.
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const fitOf = (c) => num(c.fit, 0.5)
const costOf = (c) => num(c.expectedCost?.total, 0.5)

/** Strongest candidate: highest tier, then best fit, then cheaper. `except` ids are skipped. */
export function strongestOf(candidates, { except = [] } = {}) {
  return [...candidates].filter((c) => !except.includes(c.id))
    .sort((a, b) => rankOf(b) - rankOf(a) || fitOf(b) - fitOf(a) || costOf(a) - costOf(b) || String(a.id).localeCompare(String(b.id)))[0] ?? null
}

/**
 * Cheapest candidate that still meets the tier floor: lowest expected cost among those at or
 * above `minimumTier` (an unknown tier is not excluded: unknown is not insufficient). When
 * nothing meets the floor, the cheapest of all, so a caller can still tell "no sufficient
 * candidate" from "no candidate" by comparing tiers itself.
 */
export function cheapestOf(candidates, { minimumTier = 'standard', except = [] } = {}) {
  const pool = candidates.filter((c) => !except.includes(c.id))
  const ok = pool.filter((c) => c.tier === 'unknown' || tierAtLeast(c.tier, minimumTier))
  const from = ok.length ? ok : pool
  return [...from].sort((a, b) => costOf(a) - costOf(b) || fitOf(b) - fitOf(a) || String(a.id).localeCompare(String(b.id)))[0] ?? null
}

/**
 * How far a candidate's capability numbers may be believed: the mean, over the dimensions this
 * task depends on, of the recorded confidence discounted by how few verified runs stand behind
 * it. A score nobody has measured is a prior, and a prior must not outweigh a measured one.
 */
function evidenceTrust(c, profile, policy) {
  const caps = c.capabilities ?? {}
  const wanted = Object.entries(profile.requirements ?? {}).filter(([d, w]) => w >= 0.5 && caps[d]).map(([d]) => d)
  const dims = wanted.length ? wanted : Object.keys(caps)
  if (!dims.length) return 0
  const { evidenceRuns, evidenceFloor } = policy.ranking
  let sum = 0
  for (const d of dims) {
    const v = caps[d] ?? {}
    const conf = typeof v.confidence === 'number' ? v.confidence : 0
    const runs = evidenceRuns > 0 ? Math.min(1, (v.samples ?? 0) / evidenceRuns) : 1
    // The owner's priors are the starting point of every fresh install and must still steer the
    // pick, so an unmeasured score counts a share of what a measured one would, never nothing.
    sum += evidenceFloor + (1 - evidenceFloor) * conf * (0.5 + 0.5 * runs)
  }
  return sum / dims.length
}

/**
 * Rank the eligible candidates for this task, in code. This is the resource pick: comparing
 * capability against cost against scarcity is arithmetic over numbers, which is the one thing a
 * snap-judgment classifier cannot do, so it is not asked of one.
 *
 * The rule, which is the rule the old prompt stated in words. A candidate whose known tier is
 * under what the task needs is not picked at all while one that meets it exists, however cheap
 * it is. Among the rest one score decides: the extra capability is worth only as much as the
 * task needs it (its complexity or its risk, whichever is higher), the expected job cost always
 * counts against a candidate, and scarce capacity counts against one exactly in proportion to
 * how little this task needs what that capacity buys - which is what spends a subscription on
 * the hard work and leaves the easy work to a cheaper candidate. A capability score with low
 * confidence or few verified runs is pulled toward neutral first, so a guess cannot win on paper.
 *
 * The scores become probabilities through a softmax, so `probabilities` reads downstream exactly
 * as a Choice answer's did, and the confidence is the margin between the first and the second:
 * two candidates that score alike answer with half a confidence, and nothing downstream has to
 * know that a rule rather than a judgment said so.
 *
 * @param {object} p
 * @param {Array<object>} p.candidates  decision.js candidate shape (key, tier, fit, scarcity, expectedCost, capabilities)
 * @param {object} [p.profile]          task profile (minimumCapability, complexity, risk, requirements)
 * @param {object} [p.policy]           resolvePolicy result
 * @returns {{ ordered: object[], chosenKey: string|null, probabilities: Record<string, number>, confidence: number, scores: Record<string, number> }}
 */
export function rankCandidates({ candidates = [], profile = {}, policy = resolvePolicy() } = {}) {
  if (!candidates.length) return { ordered: [], chosenKey: null, probabilities: {}, confidence: 0, scores: {} }
  const w = policy.ranking
  const minimum = profile.minimumCapability ?? 'standard'
  // The same reading of the floor cheapestOf uses: unknown is not insufficient, and when nothing
  // meets the floor the whole pool is ranked, because a pick is still owed.
  const meets = candidates.filter((c) => c.tier === 'unknown' || tierAtLeast(c.tier, minimum))
  const pool = meets.length ? meets : candidates
  // How much the extra capability is worth here, and never nothing: even routine work is worth
  // doing well, so the task's own complexity and risk move this over the top half of the range
  // rather than switching capability on and off.
  // Number.isFinite, not typeof: one NaN here would spread through every score, the sort would
  // silently keep the input order, and the pick would be arbitrary with nothing reported wrong.
  // Clamped, because a complexity over 1 would turn the scarcity penalty below into a bonus.
  const demand = clamp(Math.max(num(profile.complexity, 0.5), num(profile.risk, 0.5)), 0, 1)
  const need = 0.5 + 0.5 * demand
  const scores = {}
  for (const c of pool) {
    const trust = evidenceTrust(c, profile, policy)
    const capability = 0.5 + (fitOf(c) - 0.5) * trust
    const scarcity = clamp(num(c.scarcity, 0), 0, 1)
    scores[c.key] = w.capabilityWeight * need * capability - w.costWeight * costOf(c) - w.scarcityWeight * (1 - demand) * scarcity
  }
  const ordered = [...pool].sort((a, b) => scores[b.key] - scores[a.key] || costOf(a) - costOf(b) || String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)))
  const top = scores[ordered[0].key]
  // A temperature of zero is 0/0, which is NaN rather than the hard pick it reads like.
  const weights = ordered.map((c) => Math.exp((scores[c.key] - top) / Math.max(w.temperature, 1e-6)))
  const sum = weights.reduce((a, b) => a + b, 0)
  const probabilities = Object.fromEntries(ordered.map((c, i) => [c.key, weights[i] / sum]))
  // Every candidate the floor ruled out is still named, at zero, so a caller narrowing the
  // answer to a smaller pool reads a refusal rather than a missing key.
  for (const c of candidates) if (probabilities[c.key] === undefined) probabilities[c.key] = 0
  const first = weights[0] / sum
  const second = ordered.length > 1 ? weights[1] / sum : 0
  return { ordered, chosenKey: ordered[0].key, probabilities, confidence: first / (first + second), scores }
}

/** Is `b` materially stronger than `a` for this task: a higher tier, or the same tier with a clearly better fit. */
export const strongerThan = (b, a) => !!a && !!b && (rankOf(b) > rankOf(a) || (rankOf(b) === rankOf(a) && fitOf(b) - fitOf(a) >= 0.1))

/**
 * Which opening strategies the candidates make possible for this task. Pure and deterministic.
 * @param {object} p
 * @param {Array<object>} p.candidates  eligible candidates (decision.js shape: id, tier, fit, expectedCost, source)
 * @param {object} [p.profile]          task profile (minimumCapability, risk)
 * @param {boolean} [p.answerOnly]      read-only answer: no files change
 * @returns {string[]} strategy ids, in STRATEGIES order
 */
export function eligibleStrategies({ candidates = [], reviewCandidates, profile = {}, answerOnly = false } = {}) {
  if (!candidates.length) return []
  const reviewers = reviewCandidates?.length ? reviewCandidates : candidates
  const minimum = profile.minimumCapability ?? 'standard'
  const strongest = strongestOf(candidates)
  const cheapest = cheapestOf(candidates, { minimumTier: minimum })
  const twoDistinct = candidates.length >= 2
  const someoneElseCanJudge = reviewers.some((c) => c.id !== (cheapest ?? strongest ?? {}).id) || reviewers.length > candidates.length
  const gap = twoDistinct && cheapest && strongest && cheapest.id !== strongest.id && strongerThan(strongest, cheapest)
  const local = candidates.some((c) => c.source === 'local')
  const out = new Set(['STANDARD_DIRECT'])
  if (cheapest) out.add('CHEAP_DIRECT')
  if (strongest) out.add('PREMIUM_DIRECT')
  if (local && candidates.some((c) => c.source !== 'local')) out.add('LOCAL_FIRST')
  if (gap) { out.add('CHEAP_THEN_PREMIUM_REVIEW'); out.add('PREMIUM_PLAN_CHEAP_EXECUTE') }
  // A forced review needs someone other than the worker, and that someone may come from the wider
  // reviewer pool: the work pool can be one resource deep while a gated or lower-tier one judges.
  if (someoneElseCanJudge && reviewers.length >= 2) out.add('CHEAP_EXECUTE_FRONTIER_REVIEW')
  if (answerOnly && twoDistinct) out.add('PARALLEL_SECOND_OPINION')
  return Object.keys(STRATEGIES).filter((s) => out.has(s))
}

/**
 * Turn a strategy and a primary pick into steps the routing loop runs.
 *
 * The primary is the resource the resource domain chose; the strategy says what surrounds it.
 * When the two disagree (Jev chose the strongest resource and a cheap-execute strategy) the
 * pick wins and the strategy degrades to what is still meaningful: a reviewer is then the
 * strongest OTHER candidate, and a planner that would be the worker itself becomes a plan step
 * by the same agent, which is still a plan-first run rather than nothing.
 *
 * `reviewCandidates` is who may JUDGE, which is a wider set than who may do the work: a resource
 * past its weekly gate is kept for exactly this, and a resource under the task's capability floor
 * is still a useful second pair of eyes. Defaults to the work pool.
 *
 * @returns {{ strategy: string, steps: Array<{ role: 'plan'|'primary', agent: string }>, reviewer: string|null,
 *   forceReview: boolean, frontierReview: boolean, parallelWith: string|null, fallbackOrder: string[], notes: string[] }}
 */
export function planStrategy({ strategy, primaryId, candidates = [], reviewCandidates, profile = {}, answerOnly = false } = {}) {
  const notes = []
  const primary = candidates.find((c) => c.id === primaryId) ?? null
  if (!primary) throw new Error(`broker: primary ${primaryId} is not among the candidates`)
  const reviewers = reviewCandidates?.length ? reviewCandidates : candidates
  const eligible = eligibleStrategies({ candidates, reviewCandidates: reviewers, profile, answerOnly })
  let s = strategy && STRATEGIES[strategy] ? strategy : 'STANDARD_DIRECT'
  if (!eligible.includes(s)) {
    notes.push(`${s} is not possible with these candidates; running ${primary.id} directly`)
    s = 'STANDARD_DIRECT'
  }
  // Two different "someone else"s. A REVIEWER only judges the work, so it may come from the wider
  // review pool, which keeps a gated or conserved resource available on purpose. A PLANNER writes
  // the plan and a PARALLEL answerer answers the whole task: both are work, so both come from the
  // work pool, or they would spend exactly the capacity the gate or conservation just kept back.
  const strongestOther = strongestOf(reviewers, { except: [primary.id] })
  const strongestOtherWorker = strongestOf(candidates, { except: [primary.id] })
  const strongest = strongestOf(candidates)
  // Fallback order for a mid-run hand-over: strongest first among the rest, local last.
  const fallbackOrder = [...candidates].filter((c) => c.id !== primary.id)
    .sort((a, b) => (a.source === 'local') - (b.source === 'local') || rankOf(b) - rankOf(a) || costOf(a) - costOf(b)).map((c) => c.id)
  const plan = { strategy: s, steps: [{ role: 'primary', agent: primary.id }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: null, fallbackOrder, notes }
  switch (s) {
    case 'LOCAL_FIRST':
      if (primary.source !== 'local') {
        const local = candidates.find((c) => c.source === 'local')
        if (local) { plan.steps = [{ role: 'primary', agent: local.id }]; plan.fallbackOrder = [primary.id, ...fallbackOrder.filter((id) => id !== local.id && id !== primary.id)]; notes.push(`local model ${local.id} goes first; ${primary.id} takes over on failure`) }
      }
      break
    case 'CHEAP_THEN_PREMIUM_REVIEW':
    case 'CHEAP_EXECUTE_FRONTIER_REVIEW':
      plan.reviewer = strongestOther?.id ?? null
      plan.forceReview = !!plan.reviewer
      plan.frontierReview = s === 'CHEAP_EXECUTE_FRONTIER_REVIEW' && !!plan.reviewer
      if (!plan.reviewer) notes.push('no other candidate can review; running directly')
      break
    case 'PREMIUM_PLAN_CHEAP_EXECUTE': {
      const planner = strongerThan(strongestOtherWorker, primary) ? strongestOtherWorker : strongest
      plan.steps = [{ role: 'plan', agent: planner.id }, { role: 'primary', agent: primary.id }]
      plan.reviewer = planner.id !== primary.id ? planner.id : strongestOther?.id ?? null
      plan.forceReview = !!plan.reviewer
      if (planner.id === primary.id) notes.push(`${primary.id} plans and then implements; no stronger candidate to plan for it`)
      break
    }
    case 'PARALLEL_SECOND_OPINION':
      plan.parallelWith = strongestOtherWorker?.id ?? null
      if (!plan.parallelWith) notes.push('no second candidate for a parallel opinion; running directly')
      break
    default:
      break
  }
  // Whether this run gets a review, beyond what the strategy itself plans, is not decided here:
  // it is the second-opinion and frontier-escalation judgments' call (decision.js), and the
  // policy's minimumReview thresholds are only their deterministic fallback when neither Jev nor a
  // trusted local classifier answers.
  return plan
}

/**
 * What the review's disposition means for the next step, as a role and an agent. Deterministic
 * facts (a failing check) have already forced a retry by the time this is called.
 * @returns {{ role: 'retry'|'review'|null, agent: string|null, escalate: boolean }}
 */
export function nextFromDisposition({ disposition, producer, candidates = [], lastAgent, retryAgent, reviewAgent } = {}) {
  const others = candidates.filter((c) => c.id !== producer)
  const strongestOther = strongestOf(candidates, { except: [producer] })
  switch (disposition) {
    case 'PASS': return { role: null, agent: null, escalate: false }
    case 'RETRY_SAME_TIER': return { role: 'retry', agent: retryAgent ?? lastAgent ?? producer, escalate: false }
    case 'RETRY_DIFFERENT_RESOURCE': return { role: 'retry', agent: others.find((c) => c.id === retryAgent)?.id ?? others[0]?.id ?? null, escalate: false }
    case 'WRONG': return { role: 'retry', agent: strongestOther?.id ?? retryAgent ?? null, escalate: true }
    case 'SECOND_OPINION': return { role: 'review', agent: reviewAgent && reviewAgent !== producer ? reviewAgent : others[0]?.id ?? null, escalate: false }
    case 'FRONTIER_REVIEW': return { role: 'review', agent: strongestOther?.id ?? null, escalate: true }
    case 'HUMAN': return { role: null, agent: null, escalate: true }
    default: return { role: null, agent: null, escalate: false }
  }
}

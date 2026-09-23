// jev-review: judges one finished attempt (agent or tool) and decides what happens next: pass,
// second opinion, retry (escalate), or human. Jev answers atomic yes/no questions; the decision
// is made here in code from those, deterministic evidence, and risk-scaled thresholds. router.js
// imports createReview directly and calls it after every attempt, with the router's own Jev
// client (the one that rotates keys on 429/402) and the router's `thresholds`, so review policy
// lives in one place and is configured in one place: the jev-router row.
//
// The outcome is also a routing domain (outcome_disposition). While it is immature Jev is the
// teacher and its disposition is recorded next to the deterministic facts; once the domain has
// earned local authority the disposition comes from the local classifier and Jev is not called
// for a routine, in-distribution outcome. Either way a failing required check is a fact that no
// classifier can override: blockAccept wins before any judgment is read.
import { outcomeFeatures } from '../jev-router/features.js'

export const name = 'jev-review'

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')
const NEEDS_PERSON = 0.6
const REJECT = 0.3
const describeError = (err) => (err?.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err?.message ?? String(err))

/** The coarse verdict a disposition implies, for the local path and for the record. */
export const ACTION_OF_DISPOSITION = Object.freeze({
  PASS: 'accept', RETRY_SAME_TIER: 'retry', RETRY_DIFFERENT_RESOURCE: 'retry', WRONG: 'retry',
  SECOND_OPINION: 'second_review', FRONTIER_REVIEW: 'second_review', HUMAN: 'human',
})
/**
 * The disposition an old-style verdict maps to. A bare `retry` says nothing about WHICH
 * resource should retry, so it maps to nothing here and the router keeps Jev's own retry pick;
 * only the teacher label for the outcome domain needs a value, and it takes the weak default.
 */
const DISPOSITION_OF_VERDICT = Object.freeze({ accept: 'PASS', second_review: 'SECOND_OPINION', human: 'HUMAN' })

/**
 * Whether the routing asked for a second opinion of an accepted result. With a decision record
 * the second_opinion routing domain has answered, and its answer IS the decision: that answer is
 * the sample the run labels, so acting on anything else would have an accepted run confirm a
 * 'yes' that never happened (a yes at 0.55 under a 0.6 bar, or a yes on a run that changed no
 * file). The question the domain answers is about the result of the task, not about a diff, so a
 * yes is acted on whether or not files changed. Without a domain answer (routing switched off,
 * a legacy route) the task profile's own estimate is all there is, and nothing is labelled from
 * it, so the configured bar and the changed-code condition still govern.
 */
export function wantsSecondOpinion(routing, thresholds, touchedCode) {
  const label = routing?.decision?.domains?.second_opinion?.label
  if (label === 'yes' || label === 'no') return label === 'yes'
  return (routing?.needsSecondOpinion ?? 0) >= thresholds.secondOpinion && !!touchedCode
}

/**
 * @param {object|null} jev           createJev() client, or null when unavailable
 * @param {object} thresholds
 * @param {string} [unavailableReason]
 * @param {object} [options]
 * @param {object} [options.outcome]  the outcome_disposition domain controller (domains.js); absent means Jev or fallback only
 * @param {(agent: object) => string|undefined} [options.modelOf]  the model an agent really runs
 *   (a CLI agent's own config), so the review call masks that model id as the routing call does
 * @returns {(input: object, signal: AbortSignal) => Promise<object>} one assessment with `action` and `why`
 */
export function createReview(jev, thresholds, unavailableReason = 'Jev not configured', { outcome, modelOf: defaultModelOf } = {}) {
  return async function review({ task, routing, attempts, checks, cmp, diff, agents, blockAccept, reviewed, touchedCode, pickOther, strategy, runId, modelOf = defaultModelOf }, signal) {
    const last = attempts.at(-1)
    let a
    const assess = async () => ({ mode: 'jev', ...(await jev.assess({ task, routing, attempts, checks: { results: checks, ...cmp }, diff, agents, strategy, modelOf }, signal)) })
    const fallbackDisposition = () => (last.stopReason !== 'completed' || blockAccept ? 'RETRY_SAME_TIER' : 'PASS')
    let domain = null
    if (outcome) {
      // The domain controller decides who judges: Jev while the domain is immature, the local
      // classifier once it has earned it. Its features are deterministic facts only.
      const features = outcomeFeatures({ profile: routing.profile ?? routing, strategy, checks: { results: checks, ...cmp }, attempts, reviewed, touchedCode, diff })
      const teacher = jev ? async () => {
        const raw = await assess()
        const label = raw.disposition ?? DISPOSITION_OF_VERDICT[raw.verdict] ?? (raw.verdict === 'retry' ? 'RETRY_SAME_TIER' : 'HUMAN')
        return { label, probabilities: raw.dispositionProbabilities ?? { [label]: raw.dispositionConfidence ?? raw.verdictConfidence ?? 0.5 }, confidence: raw.dispositionConfidence ?? raw.verdictConfidence ?? 0.5, model: raw.model, raw }
      } : null
      try {
        domain = await outcome.decide({ features, jev: teacher, fallback: () => { const label = fallbackDisposition(); return { label, probabilities: { [label]: 1 }, confidence: 0.5 } }, context: { extra: { decidedAt: attempts.length - 1 }, runId } })
      } catch (err) {
        if (signal.aborted) throw err
        domain = null
        a = { mode: 'fallback', reason: describeError(err) }
      }
      if (domain?.authority === 'jev' && domain.teacher?.raw) a = domain.teacher.raw
      else if (domain?.authority === 'local') a = { mode: 'local', disposition: domain.label, dispositionConfidence: domain.confidence, dispositionProbabilities: domain.probabilities }
      else if (domain && !a) a = { mode: 'fallback', reason: domain.reason ?? unavailableReason }
    } else if (jev) {
      try {
        a = await assess()
      } catch (err) {
        if (signal.aborted) throw err
        a = { mode: 'fallback', reason: describeError(err) }
      }
    } else a = { mode: 'fallback', reason: unavailableReason }
    if (a.mode === 'fallback' || a.mode === 'local') {
      // No Jev answer to split, so both jobs fall back to the same peer pick.
      a.reviewAgent = pickOther({}, last.agent)
      a.retryAgent = a.reviewAgent
    }
    if (a.mode === 'fallback') {
      a.verdict = last.stopReason !== 'completed' || blockAccept ? 'retry' : 'accept'
      a.disposition = fallbackDisposition()
    }
    if (a.mode === 'jev' && !a.disposition) a.disposition = DISPOSITION_OF_VERDICT[a.verdict]
    if (domain) a.outcomeDomain = { authority: domain.authority, maturity: domain.maturity, confidence: domain.confidence, requiredConfidence: domain.requiredConfidence, ood: domain.ood ?? null, reason: domain.reason, jevCalled: !!domain.jevCalled, sampleId: domain.sampleId ?? null, local: domain.local ? { label: domain.local.label, confidence: domain.local.confidence } : null }

    // Jev-mode policy: atomic Nouls, three bands, risk-scaled bar.
    //   blockAccept (agent failed / regressed / required checks failing) -> retry
    //   needsPerson >= 0.6                                   -> human
    //   quality = min(addressed, complete, 1 - unrelatedChanges, 1 - regressionRisk)
    //   bar = accept.low | medium | high for risk < 0.25 | < 0.6 | else (no risk: 0.5)
    //   quality >= bar -> accept; quality <= 0.3 -> retry;
    //   between -> second_review if not yet reviewed, else human
    // Noul probabilities are compared only with these bars, never a Choice confidence threshold.
    let action = a.verdict
    let why = `fallback policy (${a.reason})`
    if (a.mode === 'jev') {
      const risk = routing.risk ?? 0.5
      const bar = risk < 0.25 ? thresholds.accept.low : risk < 0.6 ? thresholds.accept.medium : thresholds.accept.high
      a.quality = Math.min(a.addressed, a.complete, 1 - a.unrelatedChanges, 1 - a.regressionRisk)
      a.bar = bar
      const q = `quality ${pct(a.quality)}`
      if (blockAccept) { action = 'retry'; why = q }
      else if (a.needsPerson >= NEEDS_PERSON) { action = 'human'; why = `needs a person ${pct(a.needsPerson)} ≥ ${NEEDS_PERSON}` }
      else if (a.quality >= bar) { action = 'accept'; why = `${q} ≥ bar ${pct(bar)} (risk ${pct(risk)})` }
      else if (a.quality <= REJECT) { action = 'retry'; why = `${q} ≤ ${REJECT}` }
      else { action = reviewed ? 'human' : 'second_review'; why = `${q} between ${REJECT} and bar ${pct(bar)} (risk ${pct(risk)})${reviewed ? ', already reviewed' : ''}` }
    }
    // Local-authority policy: the disposition says what happens, deterministic facts still win.
    if (a.mode === 'local') {
      action = ACTION_OF_DISPOSITION[a.disposition] ?? 'human'
      why = `local outcome classifier: ${a.disposition} (confidence ${pct(a.dispositionConfidence)})`
      if (blockAccept) { action = 'retry'; why = `deterministic failure overrides the local classifier (${a.disposition})` }
      else if (action === 'second_review' && reviewed) { action = 'accept'; why += ', already reviewed' }
    }
    if (blockAccept) why += `; blocked (${last.stopReason}, regressed: ${cmp.regressed.join(', ') || 'none'}, failing: ${cmp.failing.join(', ') || 'none'})`
    if (action === 'accept' && !reviewed && wantsSecondOpinion(routing, thresholds, touchedCode)) { action = 'second_review'; why += `; routing asked for a second opinion (${pct(routing.needsSecondOpinion)})` }
    const status = action === 'accept' ? ((routing.needsHumanReview ?? 0) >= thresholds.humanReview ? 'accepted_pending_human_review' : 'accepted') : undefined
    return { ...a, action, why, status }
  }
}

// This row used to provide a `jevReview` service with its own Config (credentialRef, jevModel,
// jevTimeoutMs, thresholds). Nothing ever injected it: the router calls createReview above
// directly. A documented config block that changes nothing is worse than none, because a person
// tunes it and the review keeps using the jev-router values, so it is gone. The plugin row stays
// loadable (config/cordis.patch.yml still inserts it) and does nothing at runtime.
export function apply() {}

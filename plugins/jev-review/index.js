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
//
// Whoever decides the run answers the review: Jev, or Laya in a Laya Auto run (docs/laya-auto.md
// 2.5). The decider's own record names it, its thresholds are the ones handed in, and the review
// policy reads the same yes/no answers from either, against that provider's bars.
import { outcomeFeatures } from '../jev-router/features.js'
import { DECIDER_IDS, TEACHER, providerName } from '../jev-router/providers.js'

export const name = 'jev-review'

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')
// Jev's bars before they were thresholds, for a caller that hands in an old-shape object.
const NEEDS_PERSON = 0.6
const REJECT = 0.3
const RISK_BANDS = Object.freeze({ low: 0.25, medium: 0.6 })
const describeError = (err) => (err?.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err?.message ?? String(err))
// The answer the outcome domain decided on: the provider's in a Laya run, else the teacher's.
const rawOf = (d) => d?.provider?.raw ?? d?.teacher?.raw

/**
 * The review policy over one assessment's yes/no answers, a pure function so the Laya shadow can
 * work out the action either provider would have taken from its own answers (shadow-stats.js):
 *
 *   blockAccept (agent failed / regressed / required checks failing) -> retry
 *   needsPerson >= thresholds.needsPerson                -> human
 *   quality = min(addressed, complete, 1 - unrelatedChanges, 1 - regressionRisk)
 *   bar = accept.low | medium | high for risk < riskBands.low | < riskBands.medium | else (no risk: 0.5)
 *   quality >= bar -> accept; quality <= thresholds.reject -> retry;
 *   between -> second_review if not yet reviewed, else human
 *
 * Noul probabilities are compared only with these bars, never a Choice confidence threshold. A
 * provider other than the teacher says so when its quality stops under its own accept bar, so the
 * cost of its higher bars is visible on every review it stops.
 * @param {object} a  the assessment: `addressed`, `complete`, `unrelatedChanges`, `regressionRisk`,
 *   `needsPerson`, and `mode`, the provider that answered
 * @param {{ risk?: number|null, blockAccept?: boolean, reviewed?: boolean }} context
 * @param {object} thresholds  the answering provider's (providers.js), or an old-shape object
 * @returns {{ action: string, why: string, quality: number, bar: number }}
 */
export function reviewAction(a, { risk, blockAccept = false, reviewed = false } = {}, thresholds) {
  const r = risk ?? 0.5
  const bands = { ...RISK_BANDS, ...thresholds.riskBands }
  const needsPerson = thresholds.needsPerson ?? NEEDS_PERSON
  const reject = thresholds.reject ?? REJECT
  const bar = r < bands.low ? thresholds.accept.low : r < bands.medium ? thresholds.accept.medium : thresholds.accept.high
  const quality = Math.min(a.addressed, a.complete, 1 - a.unrelatedChanges, 1 - a.regressionRisk)
  const q = `quality ${pct(quality)}`
  const own = a.mode && a.mode !== TEACHER ? providerName(a.mode) : null
  let action
  let why
  if (blockAccept) { action = 'retry'; why = q }
  else if (a.needsPerson >= needsPerson) { action = 'human'; why = `needs a person ${pct(a.needsPerson)} ≥ ${needsPerson}` }
  else if (quality >= bar) { action = 'accept'; why = `${q} ≥ bar ${pct(bar)} (risk ${pct(r)})` }
  else if (quality <= reject) { action = 'retry'; why = `${q} ≤ ${reject}` }
  else {
    action = reviewed ? 'human' : 'second_review'
    why = own ? `${q} under ${own}'s accept bar ${pct(bar)} (risk ${pct(r)})` : `${q} between ${reject} and bar ${pct(bar)} (risk ${pct(r)})`
    if (reviewed) why += ', already reviewed'
  }
  return { action, why, quality, bar }
}

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
 * @param {object|null} decider       createJev() client of whoever decides the run (Jev, or Laya),
 *   or null when unavailable; its `provider` record names who answers, Jev when it carries none
 * @param {object} thresholds         the deciding provider's
 * @param {string} [unavailableReason]
 * @param {object} [options]
 * @param {object} [options.outcome]  the outcome_disposition domain controller (domains.js); absent means Jev or fallback only.
 *   For a Laya run the router hands a facade that decides for Laya into Laya's store, so nothing
 *   here knows about stores
 * @param {(agent: object) => string|undefined} [options.modelOf]  the model an agent really runs
 *   (a CLI agent's own config), so the review call masks that model id as the routing call does
 * @returns {(input: object, signal: AbortSignal) => Promise<object>} one assessment with `action` and `why`
 */
export function createReview(decider, thresholds, unavailableReason = 'Jev not configured', { outcome, modelOf: defaultModelOf } = {}) {
  return async function review({ task, routing, attempts, checks, cmp, diff, agents, blockAccept, reviewed, touchedCode, pickOther, strategy, runId, modelOf = defaultModelOf }, signal) {
    const last = attempts.at(-1)
    // Who answers, read once here and never off the assessment: on the success path below the
    // assessment does not exist yet when the domain's answer is matched against it.
    const mode = decider?.provider?.id ?? TEACHER
    const who = providerName(mode)
    // What the review knows and the review state does not carry, numbers only: the watchers of the
    // call (the Laya shadow) work out from it the action either provider would have taken.
    const context = { attempt: attempts.length - 1, risk: routing.risk ?? null, blockAccept, reviewed }
    let a
    const assess = async () => ({ mode, ...(await decider.assess({ task, routing, attempts, checks: { results: checks, ...cmp }, diff, agents, strategy, modelOf }, signal, context)) })
    // Both ways a review can end up without an answer name the provider that did not give one.
    const unanswered = (err) => (mode === TEACHER ? describeError(err) : `${who} unavailable (${err?.message ?? err})`)
    const fallbackDisposition = () => (last.stopReason !== 'completed' || blockAccept ? 'RETRY_SAME_TIER' : 'PASS')
    let domain = null
    if (outcome) {
      // The domain controller decides who judges: Jev while the domain is immature, the local
      // classifier once it has earned it, Laya in a Laya run. Its features are deterministic facts only.
      const features = outcomeFeatures({ profile: routing.profile ?? routing, strategy, checks: { results: checks, ...cmp }, attempts, reviewed, touchedCode, diff })
      const teacher = decider ? async () => {
        const raw = await assess()
        const label = raw.disposition ?? DISPOSITION_OF_VERDICT[raw.verdict] ?? (raw.verdict === 'retry' ? 'RETRY_SAME_TIER' : 'HUMAN')
        // A disposition too flat to use still decides here, for Laya too: it only labels the
        // sample, and what the review does comes from the yes/no answers below.
        return {
          label, probabilities: raw.dispositionProbabilities ?? { [label]: raw.dispositionConfidence ?? raw.verdictConfidence ?? 0.5 }, confidence: raw.dispositionConfidence ?? raw.verdictConfidence ?? 0.5, model: raw.model, raw,
          informative: !raw.uninformative?.includes('disposition'), identity: raw.meta?.identity, lang: raw.meta?.lang,
        }
      } : null
      try {
        // Who answers rides along, so a controller handed a Laya run without the facade refuses it
        // for want of Laya's store, rather than taking Laya's answer for the teacher's and writing
        // it where the local classifiers learn. The facade sets both itself.
        domain = await outcome.decide({ features, jev: teacher, fallback: () => { const label = fallbackDisposition(); return { label, probabilities: { [label]: 1 }, confidence: 0.5 } }, context: { extra: { decidedAt: attempts.length - 1 }, runId }, answeredBy: mode })
      } catch (err) {
        if (signal.aborted) throw err
        domain = null
        a = { mode: 'fallback', reason: describeError(err) }
      }
      if (domain?.authority === mode && rawOf(domain)) a = rawOf(domain)
      else if (domain?.authority === 'local') a = { mode: 'local', disposition: domain.label, dispositionConfidence: domain.confidence, dispositionProbabilities: domain.probabilities }
      else if (domain && !a) a = { mode: 'fallback', reason: domain.reason ?? unavailableReason }
    } else if (decider) {
      try {
        a = await assess()
      } catch (err) {
        if (signal.aborted) throw err
        a = { mode: 'fallback', reason: unanswered(err) }
      }
    } else a = { mode: 'fallback', reason: unavailableReason }
    if (a.mode === 'fallback' || a.mode === 'local') {
      // No decider's answer to split, so both jobs fall back to the same peer pick.
      a.reviewAgent = pickOther({}, last.agent)
      a.retryAgent = a.reviewAgent
    }
    // A pick the decider answered too flat to mean anything is replaced by that same peer pick,
    // and its probabilities go with it, so the router ranks by nothing rather than by noise.
    const flatPicks = DECIDER_IDS.includes(a.mode) ? ['reviewAgent', 'retryAgent'].filter((k) => a.uninformative?.includes(k)) : []
    for (const k of flatPicks) {
      a[k] = pickOther({}, last.agent)
      delete a[`${k}Probabilities`]
    }
    if (a.mode === 'fallback') {
      a.verdict = last.stopReason !== 'completed' || blockAccept ? 'retry' : 'accept'
      a.disposition = fallbackDisposition()
    }
    if (DECIDER_IDS.includes(a.mode) && !a.disposition) a.disposition = DISPOSITION_OF_VERDICT[a.verdict]
    if (domain) a.outcomeDomain = { authority: domain.authority, maturity: domain.maturity, confidence: domain.confidence, requiredConfidence: domain.requiredConfidence, ood: domain.ood ?? null, reason: domain.reason, jevCalled: !!domain.jevCalled, sampleId: domain.sampleId ?? null, local: domain.local ? { label: domain.local.label, confidence: domain.local.confidence } : null }

    // A decider's answers: the yes/no policy of reviewAction, against the thresholds handed in.
    let action = a.verdict
    let why = `fallback policy (${a.reason})`
    if (DECIDER_IDS.includes(a.mode)) {
      const r = reviewAction(a, context, thresholds)
      a.quality = r.quality
      a.bar = r.bar
      action = r.action
      why = r.why
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
    // A disposition too flat to mean anything labels the outcome sample and nothing else. The
    // router reads the disposition for who reviews (FRONTIER_REVIEW: the strongest) and who retries
    // (RETRY_SAME_TIER: the same producer), so it is handed the one this action implies instead,
    // and a retry names none and keeps the retry pick, as a Jev answer with no disposition does.
    if (DECIDER_IDS.includes(a.mode) && a.uninformative?.includes('disposition')) {
      const implied = DISPOSITION_OF_VERDICT[action]
      if (implied) a.disposition = implied
      else delete a.disposition
      delete a.dispositionConfidence
      delete a.dispositionProbabilities
      why += `; ${providerName(a.mode)}'s disposition was too flat to use, so the review action stands in for it`
    }
    // No agent is named: the router picks a reviewer from the judges and may put a named or
    // promised one first, so the peer pick here is not always who reviews or retries.
    if (flatPicks.length) {
      const jobs = flatPicks.map((k) => (k === 'reviewAgent' ? 'review' : 'retry')).join(' and ')
      why += `; ${providerName(a.mode)}'s ${jobs} ${flatPicks.length > 1 ? 'picks were' : 'pick was'} too flat to use, so the peer rule stands in for ${flatPicks.length > 1 ? 'them' : 'it'}`
    }
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

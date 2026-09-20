// jev-review: DSH plugin. Judges one finished attempt (agent or tool) and
// decides what happens next: pass, second opinion, retry (escalate), or human.
// Jev answers atomic yes/no questions; the decision is made here in code
// from those, deterministic evidence, and risk-scaled thresholds. The router calls this after every attempt through the
// `jevReview` service, so review policy lives in one place.
import Schema from '@deepseek-ai/schemastery'
import { createJev } from '../jev-router/jev.js'

export const name = 'jev-review'
export const inject = ['credentials']

export const Config = Schema.object({
  credentialRef: Schema.string().default('TYPESAFE_API_KEY'),
  jevModel: Schema.string().default('jev-1.13.0').description('Pinned so tuned thresholds keep their meaning.'),
  jevTimeoutMs: Schema.natural().default(20_000),
  thresholds: Schema.object({
    accept: Schema.object({
      low: Schema.number().min(0).max(1).default(0.55),
      medium: Schema.number().min(0).max(1).default(0.7),
      high: Schema.number().min(0).max(1).default(0.85),
    }).description('Minimum quality to accept, by routing risk (< 0.25, < 0.6, else).'),
    secondOpinion: Schema.number().min(0).max(1).default(0.6),
    humanReview: Schema.number().min(0).max(1).default(0.7),
  }),
})

const pct = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a')
const NEEDS_PERSON = 0.6
const REJECT = 0.3
const describeError = (err) => (err?.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err?.message ?? String(err))

/**
 * @param {object|null} jev           createJev() client, or null when unavailable
 * @param {object} thresholds
 * @param {string} [unavailableReason]
 * @returns {(input: object, signal: AbortSignal) => Promise<object>} one assessment with `action` and `why`
 */
export function createReview(jev, thresholds, unavailableReason = 'Jev not configured') {
  return async function review({ task, routing, attempts, checks, cmp, diff, agents, blockAccept, reviewed, touchedCode, pickOther }, signal) {
    const last = attempts.at(-1)
    let a
    if (jev) {
      try {
        a = { mode: 'jev', ...(await jev.assess({ task, routing, attempts, checks: { results: checks, ...cmp }, diff, agents }, signal)) }
      } catch (err) {
        if (signal.aborted) throw err
        a = { mode: 'fallback', reason: describeError(err) }
      }
    } else a = { mode: 'fallback', reason: unavailableReason }
    if (a.mode === 'fallback') {
      a.verdict = last.stopReason !== 'completed' || blockAccept ? 'retry' : 'accept'
      // No Jev answer to split, so both jobs fall back to the same peer pick.
      a.reviewAgent = pickOther({}, last.agent)
      a.retryAgent = a.reviewAgent
    }

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
    if (blockAccept) why += `; blocked (${last.stopReason}, regressed: ${cmp.regressed.join(', ') || 'none'}, failing: ${cmp.failing.join(', ') || 'none'})`
    if (action === 'accept' && !reviewed && (routing.needsSecondOpinion ?? 0) >= thresholds.secondOpinion && touchedCode) { action = 'second_review'; why += `; routing asked for a second opinion (${pct(routing.needsSecondOpinion)})` }
    const status = action === 'accept' ? ((routing.needsHumanReview ?? 0) >= thresholds.humanReview ? 'accepted_pending_human_review' : 'accepted') : undefined
    return { ...a, action, why, status }
  }
}

export function apply(ctx, config) {
  ctx.provide('jevReview', {
    /** Build a reviewer for one routed run; `onTrace` receives each Jev call for the Inspector. */
    // `thresholds` from the caller (the router's config row) win over this row's defaults.
    async create({ onTrace, thresholds } = {}) {
      const key = await ctx.credentials.resolve(config.credentialRef).catch(() => undefined)
      const jev = key?.value ? createJev({ apiKey: key.value, model: config.jevModel, timeoutMs: config.jevTimeoutMs, onTrace }) : null
      return createReview(jev, { ...config.thresholds, ...thresholds }, `${config.credentialRef} not configured`)
    },
  })
}

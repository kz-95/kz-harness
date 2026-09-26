// The decision providers: who answers the routing, intent and review questions, and the cut-offs
// every answer is read against.
//
// Jev is one provider and Laya, a decision model on this PC, is the other (docs/laya-auto.md).
// Each is a frozen record built once in apply(), and every place that compares a provider's
// answer against a bar reads the bar from the record of the provider that answered, never from a
// constant shared by both. For Jev the record carries exactly today's values, so a Jev run makes
// today's decisions; for Laya the values lean toward the error that is cheaper to recover from,
// because Laya is zero-shot on these questions (the table in docs/laya-auto.md 2.6 says why each
// one is where it is).
//
// A record deliberately carries no key and no endpoint: Jev's key rotates on 429 and 402 and
// Laya's key and port change on every sidecar start, so either would go stale on a record that
// traces and the inspector show. The key and the client are handed to createJev beside it.
import Schema from '@deepseek-ai/schemastery'

/** The provider whose answers teach the routing domains; Laya is never a teacher. */
export const TEACHER = 'jev'
export const DECIDER_IDS = Object.freeze(['jev', 'laya'])
/** The name every UI string uses for a provider. */
export const providerName = (id) => ({ jev: 'Jev', laya: 'Laya' })[id] ?? String(id)

/** What Jev charges per input token (output is free); Laya runs on this PC and costs nothing. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6

/** Freeze a plain value and everything inside it. Returns the value. */
export function deepFreeze(v, seen = new WeakSet()) {
  if (!v || typeof v !== 'object' || seen.has(v)) return v
  seen.add(v)
  for (const x of Object.values(v)) deepFreeze(x, seen)
  return Object.freeze(v)
}

// The Jev column of docs/laya-auto.md 2.6: the constants the code used before they were keys,
// so a config that sets none of them decides exactly as it did.
export const JEV_THRESHOLDS = deepFreeze({
  minQuestionConfidence: 0.6, alsoWork: 0.7,
  supportingSkill: 0.15, verificationChecks: 0.5,
  continueHandoff: 0.5, tool: 0.5, toolArgConfidence: 0.5, needsTests: 0.5,
  humanRequired: 0.6,
  judgmentYes: 0.5, riskForReview: 0.6, riskForFrontierReview: 0.8,
  easyComplexity: 0.5, requirementWanted: 0.5,
  needsPerson: 0.6, reject: 0.3, accept: { low: 0.55, medium: 0.7, high: 0.85 },
  riskBands: { low: 0.25, medium: 0.6 }, humanReview: 0.7, secondOpinion: 0.6,
  effortBands: { medium: 0.25, high: 0.6 },
})

// The Laya column. None of these is a calibration: section 10 of the design names the data that
// will set them. 'always' is a string because Schemastery reads null as "not set".
export const LAYA_THRESHOLDS = deepFreeze({
  minQuestionConfidence: 0.8, alsoWork: 0.8,
  supportingSkill: 0.2, verificationChecks: 'always',
  continueHandoff: 0.6, tool: 0.8, toolArgConfidence: 0.7, needsTests: 'always',
  humanRequired: 0.8,
  judgmentYes: 0.5, riskForReview: 0.45, riskForFrontierReview: 0.7,
  easyComplexity: 0.4, requirementWanted: 0.6,
  needsPerson: 0.6, reject: 0.3, accept: { low: 0.65, medium: 0.8, high: 0.9 },
  riskBands: { low: 0.25, medium: 0.6 }, humanReview: 0.6, secondOpinion: 0.6,
  effortBands: { medium: 0.25, high: 0.6 },
})

/**
 * The two keys Jev reads from `routing.minimumReview` (resolvePolicy), not from `thresholds`: that
 * block has always been their one source, so Jev's `thresholds` schema leaves them out.
 */
export const MINIMUM_REVIEW_KEYS = Object.freeze(['riskForReview', 'riskForFrontierReview'])

// The two bars where "always" is a value: always require checks, whatever the answer. A 0 would
// not do it, because `undefined >= 0` is false and a missing answer would skip the checks.
const ALWAYS_KEYS = new Set(['verificationChecks', 'needsTests'])

const DESCRIPTIONS = {
  minQuestionConfidence: 'How sure the decider must be that a message is a question before it is answered directly instead of run as a task.',
  alsoWork: 'How sure the decider must be that a question also asks for work before that work is queued.',
  supportingSkill: 'Probability a skill besides the primary one needs to be handed to the agent as a supporting skill.',
  verificationChecks: 'needsTests probability at or over which the task profile lists checks; "always" always lists them.',
  continueHandoff: 'Probability at or over which the earlier unfinished note is handed to the agent.',
  tool: 'Minimum "tool fits" probability to run a tool instead of an agent.',
  toolArgConfidence: 'Minimum confidence of the weakest tool-argument choice to run a tool.',
  needsTests: 'needsTests probability at or over which checks must pass before a result is accepted; "always" always requires them.',
  humanRequired: 'Confidence at which an answer that the task needs a person stops the run as needs_human.',
  judgmentYes: 'Probability at or over which the second-opinion judgment reads yes.',
  riskForReview: 'Risk at which the deterministic fallback asks for a review, and above which work is not moved off the scarcest resource.',
  riskForFrontierReview: 'Risk at which the deterministic fallback asks for a frontier review.',
  easyComplexity: 'Complexity under which work counts as easy enough to move off the scarcest resource.',
  requirementWanted: 'Requirement score at or over which a capability dimension counts as wanted.',
  needsPerson: 'needsPerson probability at or over which the review hands the run to a person.',
  reject: 'Review quality at or under which the attempt is retried.',
  accept: 'Minimum review quality to accept, by routing risk band (under riskBands.low, under riskBands.medium, else).',
  riskBands: 'The risk cuts of the accept bands.',
  humanReview: 'humanReview probability at or over which an accepted result is flagged for a person.',
  secondOpinion: 'Second-opinion bar for a run with no routing decision (routing switched off, a forced agent): accepted changed code at or over it is reviewed first. A routed run follows its second-opinion decision instead.',
  effortBands: 'Auto effort from the larger of complexity and risk: medium under effortBands.medium, high under effortBands.high, else xhigh.',
}

/**
 * The Schemastery object for one provider's thresholds, every key defaulting to `defaults`: the
 * `thresholds` block of the jev-router Config for Jev (with `omit: MINIMUM_REVIEW_KEYS`), and
 * `laya.thresholds` inside LAYA_SCHEMA. Every bar is a number from 0 to 1.
 */
export function thresholdsSchema(defaults, { omit = [] } = {}) {
  const bar = (d) => Schema.number().min(0).max(1).default(d)
  const shape = {}
  for (const [k, d] of Object.entries(defaults)) {
    if (omit.includes(k)) continue
    const s = ALWAYS_KEYS.has(k) ? Schema.union([Schema.number().min(0).max(1), Schema.const('always')]).default(d)
      : d && typeof d === 'object' ? Schema.object(Object.fromEntries(Object.entries(d).map(([b, v]) => [b, bar(v)]))).default({})
        : bar(d)
    shape[k] = DESCRIPTIONS[k] ? s.description(DESCRIPTIONS[k]) : s
  }
  return Schema.object(shape).default({})
}

/**
 * The `laya` block of the jev-router Config. The Config itself declares `laya` as Schema.any(),
 * because the host refuses to load the plugin on a Schemastery error, and one bad Laya value must
 * not take Jev Auto down: resolveProviders runs this inside its own try/catch instead.
 */
export const LAYA_SCHEMA = Schema.object({
  enabled: Schema.boolean().default(true).description('Offer Laya Auto and the Laya shadow once Laya is installed. Off, KzH never starts Laya.'),
  port: Schema.natural().default(8091).description('First 127.0.0.1 port for laya.serve; the next ones are tried when it is taken.'),
  connectivityUrl: Schema.string().default('http://www.msftconnecttest.com/connecttest.txt').description('What Laya Auto probes to learn whether cloud agents can run. Never a TypeSafe address.'),
  deadlines: Schema.object({
    floorMs: Schema.natural().default(8000),
    ceilingMs: Schema.natural().default(120000),
    // Below Node's own 300 s headers timeout: laya.serve sends no header until inference ends.
    hardMs: Schema.natural().max(290000).default(270000),
    // How long a request waits for a start before it is refused.
    startWaitMs: Schema.natural().default(300000),
  }).default({}),
  shadow: Schema.object({
    maxQueue: Schema.natural().min(1).default(8),
    maxAgeMs: Schema.natural().default(600000),
    chunkRows: Schema.natural().min(1).default(4),
  }).default({}),
  temperatureCorrections: Schema.dict(Schema.number().min(0.2).max(5)).default({ 'choice:11+': 3.27 }),
  minTopMargin: Schema.number().min(0).max(1).default(0.1),
  thresholds: thresholdsSchema(LAYA_THRESHOLDS),
}).default({})

// Laya's own temperature buckets: the answer type, then the option count.
const BUCKET = /^(choice|score|noul):(2|3-5|6-10|11\+)$/

/**
 * Checks what Laya Auto probes to learn whether cloud agents can run: an http or https address on
 * a host that is not TypeSafe's (typesafe.ai or any name under it, or the host TYPESAFE_BASE_URL
 * sends Jev to), because nothing in a Laya Auto session contacts TypeSafe (docs/laya-auto.md 6.9,
 * invariant 5). Anything else would fail every probe, and every Laya Auto run would be narrowed to
 * the local agents as if this PC were offline. Throws naming the key.
 * @param {string} value  laya.connectivityUrl
 * @param {object} env    the environment TYPESAFE_BASE_URL is read from
 */
function checkConnectivityUrl(value, env) {
  const fail = (what) => { throw new Error(`providers: laya.connectivityUrl: ${what}`) }
  let url = null
  try { url = new URL(value) } catch { /* not a URL: refused below */ }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) fail(`'${value}' is not an http or https address`)
  const host = url.hostname.replace(/\.$/, '')
  let jevHost = null
  try { jevHost = new URL(String(env?.TYPESAFE_BASE_URL ?? '').trim()).host } catch { /* unset or not a URL: Jev calls go to api.typesafe.ai */ }
  if (host === 'typesafe.ai' || host.endsWith('.typesafe.ai') || url.host === jevHost) {
    fail(`${url.host} is a TypeSafe address, and a Laya Auto session never contacts TypeSafe; name another, such as the default ${LAYA_SCHEMA({}).connectivityUrl}`)
  }
}

/** Where a provider's thresholds live in the config, for messages the person can act on. */
const pathOf = (id, key) => `${id === 'jev' ? (MINIMUM_REVIEW_KEYS.includes(key) ? 'routing.minimumReview' : 'thresholds') : `${id}.thresholds`}.${key}`

/**
 * The orderings a set of thresholds must keep, which a per-key type check cannot see. Throws
 * naming the key: `providers: laya.thresholds.accept: low 0.9 is above medium 0.8`.
 * @param {object} t   a filled thresholds object
 * @param {string} id  the provider, for the config path in the message
 */
export function validateThresholds(t, id) {
  const fail = (key, what) => { throw new Error(`providers: ${pathOf(id, key)}: ${what}`) }
  const { accept, riskBands, effortBands } = t
  if (accept.low > accept.medium) fail('accept', `low ${accept.low} is above medium ${accept.medium}`)
  if (accept.medium > accept.high) fail('accept', `medium ${accept.medium} is above high ${accept.high}`)
  if (!(t.reject < accept.low)) fail('reject', `${t.reject} is not below accept.low ${accept.low}`)
  if (!(riskBands.low < riskBands.medium)) fail('riskBands', `low ${riskBands.low} is not below medium ${riskBands.medium}`)
  if (t.riskForReview > t.riskForFrontierReview) fail('riskForReview', `${t.riskForReview} is above riskForFrontierReview ${t.riskForFrontierReview}`)
  if (!(effortBands.medium < effortBands.high)) fail('effortBands', `medium ${effortBands.medium} is not below high ${effortBands.high}`)
}

/** Every key of `defaults`, taken from `t` where it is set there, one level into the bands. */
function fill(t, defaults) {
  const set = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null))
  const out = {}
  for (const [k, d] of Object.entries(defaults)) {
    out[k] = d && typeof d === 'object' ? { ...d, ...set(t?.[k]) } : t?.[k] ?? d
  }
  return out
}

/** A Schemastery error names the path from `$`; the person reads it from where they wrote it. */
function schemaError(err, root) {
  const m = String(err?.message ?? err)
  return new Error(`providers: ${m.startsWith('$') ? `${root}${m.slice(1)}` : `${root}: ${m}`}`)
}

const record = (r) => deepFreeze({
  id: r.id,
  name: providerName(r.id),
  teacher: r.id === TEACHER,
  local: r.local,
  model: r.model,
  timeoutMs: r.timeoutMs,
  maxRetries: r.maxRetries,
  usdPerInputToken: r.usdPerInputToken,
  thresholds: r.thresholds,
})

const JEV_MODEL = 'jev-1.13.0'
const JEV_TIMEOUT_MS = 20_000
// One figure per attempt for every phase: Jev's calls are all about as fast.
const perPhase = (ms) => (ms == null ? null : { intent: ms, route: ms, review: ms })

/**
 * A Jev record for callers that name no provider: `createJev`'s old form and the router's
 * `deps.provider` default. Thresholds are Jev's defaults unless given.
 * @param {{ model?: string, timeoutMs?: number, thresholds?: object }} [o]
 */
export function jevRecord({ model, timeoutMs, thresholds } = {}) {
  return record({
    id: 'jev', local: false, model: model || undefined, timeoutMs: perPhase(timeoutMs),
    // The SDK's own default, unchanged: two retries on a 408, 429 or 5xx.
    maxRetries: 2, usdPerInputToken: JEV_USD_PER_INPUT_TOKEN,
    thresholds: fill(thresholds, JEV_THRESHOLDS),
  })
}

/** Jev as the Config defaults make it, for callers that are handed no record. */
export const DEFAULT_JEV = jevRecord({ model: JEV_MODEL, timeoutMs: JEV_TIMEOUT_MS })

/**
 * Both provider records from the plugin config, built once in apply().
 *
 * Jev's is built from the keys that exist today (`jevModel`, `jevTimeoutMs`, `thresholds`, and
 * `routing.minimumReview` through the resolved policy), so no existing config changes meaning; a
 * bad Jev value throws, as a bad Jev threshold always has. Laya's comes from the `laya` block,
 * and any error in it, a type or a range as much as an ordering or a connectivity address Laya
 * Auto may not probe, is caught: Jev's record stands, `laya` is null and `layaError` says what is
 * wrong, so Laya Auto leaves the picker and the shadow stops while Jev Auto runs on.
 *
 * `layaSettings` is the validated `laya` block (deadlines, shadow, corrections and the rest, every
 * default filled), which the sidecar and the Laya client read; null when `layaError` is set.
 * @param {object} config  the jev-router Config
 * @param {{ policy: object, env?: object }} o  resolvePolicy(config.routing), and the environment
 *   TYPESAFE_BASE_URL is read from (process.env), so laya.connectivityUrl never names Jev's host
 * @returns {{ jev: object, laya: object | null, layaError: string | null, layaSettings: object | null }}
 */
export function resolveProviders(config = {}, { policy, env = process.env } = {}) {
  let own
  try { own = thresholdsSchema(JEV_THRESHOLDS, { omit: MINIMUM_REVIEW_KEYS })(config.thresholds ?? {}) } catch (err) { throw schemaError(err, 'thresholds') }
  const minimumReview = Object.fromEntries(MINIMUM_REVIEW_KEYS.map((k) => [k, policy?.minimumReview?.[k]]))
  const jevThresholds = fill({ ...own, ...minimumReview }, JEV_THRESHOLDS)
  validateThresholds(jevThresholds, 'jev')
  const jev = jevRecord({ model: config.jevModel ?? JEV_MODEL, timeoutMs: config.jevTimeoutMs ?? JEV_TIMEOUT_MS, thresholds: jevThresholds })

  try {
    let block
    try { block = LAYA_SCHEMA(config.laya ?? {}) } catch (err) { throw schemaError(err, 'laya') }
    checkConnectivityUrl(block.connectivityUrl, env)
    for (const key of Object.keys(block.temperatureCorrections)) {
      if (!BUCKET.test(key)) throw new Error(`providers: laya.temperatureCorrections: '${key}' is not one of Laya's buckets (choice, score or noul, then 2, 3-5, 6-10 or 11+, as in choice:11+)`)
    }
    const thresholds = fill(block.thresholds, LAYA_THRESHOLDS)
    validateThresholds(thresholds, 'laya')
    const laya = record({ id: 'laya', local: true, model: 'english', timeoutMs: null, maxRetries: 0, usdPerInputToken: 0, thresholds })
    return { jev, laya, layaError: null, layaSettings: deepFreeze({ ...block, thresholds: laya.thresholds }) }
  } catch (err) {
    return { jev, laya: null, layaError: String(err?.message ?? err), layaSettings: null }
  }
}

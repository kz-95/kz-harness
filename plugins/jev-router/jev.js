// TypeSafe Jev judgments for routing and post-execution assessment.
// Jev only answers typed questions; all policy (thresholds, limits, overrides)
// lives in router.js and decision.js so raw judgments stay reusable and inspectable.
//
// Three judgment groups live here, each the teacher for one or more routing domains:
//   task      what the request needs: type, complexity, risk, the capability dimensions it
//             requires, skills, the minimum tier of model that could do it, verification
//   resource  which anonymous candidate (RESOURCE_A, RESOURCE_B ...) should do the work and
//             how (the execution strategy), judged from each candidate's machine-readable
//             capability profile, scarcity and economics, never from a provider name
//   outcome   what should happen after an attempt: the disposition, and the atomic yes/no
//             judgments jev-review turns into a decision
// `route()` batches whichever of the first two groups are still needed into one call, so a
// domain that has matured locally costs no Jev tokens while the others still ask.
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'
import { CAPABILITIES } from './capabilities.js'
import { redactSecrets } from './export.js'
import { identityNames, modelIdOf } from './features.js'
import { DISPOSITIONS, REQUIREMENT_DIMENSIONS, SKILLS, STRATEGIES } from './routing-policy.js'

export const TASK_TYPES = {
  architecture: 'Designing structure, data flow, or a strategy across components before or instead of writing code',
  implementation: 'Writing new code or features to a known requirement',
  debugging: 'Finding and fixing the cause of incorrect behavior, a failing test, or an error',
  review: 'Reading existing code or a diff and reporting problems, without being asked to change it',
  refactor: 'Restructuring or renaming existing code without changing behavior',
  testing: 'Writing or repairing tests',
  documentation: 'Writing or updating docs, comments, or READMEs',
  investigation: 'Researching how something works or why something happens, producing findings rather than a change',
  security: 'Work whose main concern is authentication, authorization, secrets, or vulnerabilities',
  performance: 'Work whose main concern is speed, memory, or resource usage',
  simple_change: 'A small, mechanical, low-judgment edit such as a typo, constant, or one-line fix',
  other: 'None of the above fits',
}

const COMPLEXITY_LEVELS = [
  'Trivial: a mechanical edit in one place with an obvious answer',
  'Small: a contained change in one or two files with a clear approach',
  'Moderate: several files or some design judgment, but a well-understood problem',
  'Hard: cross-cutting change, unclear root cause, or real design trade-offs',
  'Extremely complex: ambiguous requirements, many interacting systems, or concurrency and distributed-state reasoning',
]

const RISK_LEVELS = [
  'Negligible: a mistake has no user-visible effect, for example docs or a test fixture',
  'Low: a mistake causes a minor, easily noticed and reverted defect',
  'Moderate: a mistake could break a feature for some users until fixed',
  'High: a mistake could corrupt data, break a core flow, or cause an outage',
  'Production-critical: a mistake could compromise security, authentication, money, or irreversible data',
]

// One scale for every requirement dimension: how much the task leans on it.
const REQUIREMENT_LEVELS = [
  'Not needed: the task does not call on this at all',
  'Marginal: a little helps but a weak model would still manage',
  'Useful: noticeably better results with real strength here',
  'Important: a model weak at this would likely produce a wrong or poor result',
  'Central: the task is essentially this; only real strength here gives an acceptable result',
]

const REQUIREMENT_TEXT = {
  general_reasoning: 'careful multi-step reasoning',
  architecture: 'architecture and system design judgment',
  planning: 'planning the work and its sequence before doing it',
  explanation: 'explaining, communicating trade-offs and reasoning to a person',
  coding: 'writing correct code',
  debugging: 'finding the cause of incorrect behaviour',
  security_review: 'finding security flaws and subtle implementation problems',
  code_review: 'reviewing code critically for defects',
  testing: 'writing or repairing tests',
  long_context: 'holding and reasoning over a large amount of project context at once',
}

const TIERS = {
  standard: { what: 'A competent mid-range model: routine work with clear instructions' },
  strong: { what: 'A strong model: real judgment, several files, non-obvious fixes' },
  frontier: { what: 'The strongest models available: subtle multi-module reasoning, difficult design, security-sensitive or high-risk work' },
}

export const VERDICTS = {
  accept: {
    what: 'The evidence shows the task is done: the result addresses the request and verification supports it',
    not_for: 'Results with failing required checks, unaddressed parts of the task, or open risk that deserves another look',
  },
  second_review: {
    what: 'The result looks plausible, but its risk or uncertainty justifies an independent review by a different agent',
    not_for: 'Results that are clearly wrong (retry) or clearly fine (accept)',
  },
  retry: {
    what: 'The result is incomplete or wrong, or checks fail because of it, and another attempt could fix it',
    not_for: 'Problems that need a human decision such as unclear scope, destructive actions, or credentials',
  },
  human: {
    what: 'A person should decide: scope is unclear, the change is risky or destructive, agents failed repeatedly, or evidence is missing',
    not_for: 'Routine outcomes an agent can settle',
  },
}

/** The outcome dispositions as Jev is asked to choose between them. Deterministic failures override the answer in code. */
export const DISPOSITION_CRITERIA = {
  PASS: { what: 'The result is done and verified well enough to accept' },
  RETRY_SAME_TIER: { what: 'Wrong or incomplete, but a model of the same strength would likely fix it with the feedback' },
  RETRY_DIFFERENT_RESOURCE: { what: 'Wrong or incomplete in a way this resource keeps getting wrong: a different resource should try' },
  SECOND_OPINION: { what: 'Plausible but uncertain: an independent review by another resource is worth its cost' },
  FRONTIER_REVIEW: { what: 'Plausible but risky or subtle enough that only the strongest available resource should judge it before acceptance' },
  WRONG: { what: 'Clearly wrong and not worth retrying as is: the approach itself must change' },
  HUMAN: { what: 'A person must decide: unclear scope, a destructive or irreversible action, repeated failure, or missing evidence' },
}

/**
 * Mask key-shaped strings on anything that goes to Jev, with the same scrubber the
 * Markdown export uses. A key pasted into the chat was already masked in the log and
 * in the export; sending it verbatim to a third party was the one path that missed.
 * Secrets only, on purpose: the routing judgment is made of the task text, the diff
 * and the check output, so stripping code, paths or branch names would quietly make
 * every routing decision worse.
 */
const scrub = (text) => (typeof text === 'string' ? redactSecrets(text) : text)
/**
 * `scrub` every string inside a nested plain object or array. The track record is built from the
 * person's own feedback, including the free text they typed in the Why? box, so it is the one
 * payload on the routing call that can carry an arbitrary sentence. A key pasted into that box
 * must not ride out with it, and the README promises keys are masked in everything sent to Jev.
 */
const scrubDeep = (v) => (Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]))
    : scrub(v))

function clip(text, max) {
  const s = scrub(text)
  if (typeof s !== 'string') return s
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`
}

function agentCriteria(agents) {
  return Object.fromEntries(agents.map((a) => [a.id, { what: a.description }]))
}

// --- anonymity -------------------------------------------------------------------------------
// The candidate table is anonymous so the teacher cannot form brand preferences. That only holds
// if every other channel in the same call speaks the same keys: a track record keyed 'claude'
// next to a table keyed RESOURCE_A aligns trivially, because the facts in both are the same.
// So in any call that carries the table, each identity channel is re-keyed to RESOURCE_x or
// dropped. The information stays; the name goes.

/** What a masked name reads as when it is not a candidate in this call. */
const UNNAMED = '[resource]'

// Words that name a vendor or a model family. A free-text field inside an identity channel (a
// reason typed in the Why? box, a price note from config, an executor's diagnostic) can name a
// resource with no id attached, so these are masked there along with the configured ids,
// providers and models. Never applied to the task, the workspace, the diff or the answer: those
// are the work itself, and a task about this very harness names these words legitimately.
const BRAND_TERMS = ['anthropic', 'claude', 'openai', 'chatgpt', 'gpt', 'codex', 'deepseek', 'gemini', 'gemma', 'qwen', 'llama', 'mistral', 'mixtral', 'opus', 'sonnet', 'haiku', 'grok', 'xai', 'kimi', 'moonshot', 'glm', 'zhipu', 'cohere']

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A version glued to a brand word: an optional '-' or '_', a number with any dotted parts, and
// the letters or digits that finish the token ('4o', '2.5', '3.1', '5-mini' stops at the '-').
const VERSION_SUFFIX = '(?:[-_]?\\d+(?:\\.\\d+)*[a-z0-9]*)?'
// A point release after any name ('grok-2' in 'grok-2.1', 'claude' in 'claude.2'): part of a
// longer version string, taken whole so it can be masked whole.
const POINT_RELEASE = '(?:\\.\\d[a-z0-9]*)*'

// The same label scheme as features.js anonymize(), so a key minted here for an agent outside
// the decision's table can never collide with one the decision engine already handed out.
const resourceLabel = (i) => `RESOURCE_${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`
const labelIndex = (key) => {
  const m = /^RESOURCE_([A-Z])(\d*)$/.exec(String(key ?? ''))
  return m ? m[1].charCodeAt(0) - 65 + 26 * Number(m[2] || 0) : -1
}

// Words the router itself uses as categories: task types, cost tiers, capability tiers, skills,
// strategies, dispositions, the executor mechanism. The masker replaces a name wherever it appears
// in free text, so one of these accepted as a name (a provider of 'spawn', an agent whose id is
// 'review', a model called 'local') would rewrite ordinary words about the work. None of them
// identifies a resource, so none of them is ever a name, whoever passes it.
const GENERIC_WORDS = new Set([
  ...Object.keys(TASK_TYPES), ...Object.keys(TIERS), ...Object.keys(VERDICTS), ...Object.keys(SKILLS),
  ...Object.keys(STRATEGIES), ...Object.keys(CAPABILITIES), ...REQUIREMENT_DIMENSIONS, ...DISPOSITIONS,
  // Cost tiers as router.js trackRecord() writes them, and the words they are made of.
  'free-local', 'free', 'local', 'api', 'subscription', 'metered', 'paid',
  // How an agent runs, which many agents share.
  'spawn', 'cli', 'agent', 'agents', 'model', 'models', 'tool', 'tools', 'resource', 'provider', 'default', 'custom',
].map((w) => String(w).toLowerCase()))

// A short token counts as a name only when it mixes letters and digits, which is how short model
// ids look ('o3', 'o1', 'r1'). A short all-letter token ('ab', 'ok') is an ordinary word.
const modelLike = (w) => /[a-z]/.test(w) && /\d/.test(w)

/**
 * Whether a configured string is specific enough to stand for one resource. Short words,
 * category words and names made only of them ('Local agent', 'api-model') are refused: they
 * appear in text that is not about any agent, and a placeholder there would destroy the fact.
 * A short model id is kept: refusing 'o3' for its length left it readable in every reason and
 * diagnostic of a call that exists to hide it.
 */
function specificName(n) {
  if (typeof n !== 'string') return false
  const t = n.trim().toLowerCase()
  if (GENERIC_WORDS.has(t) || t === UNNAMED || /^resource_[a-z]\d*$/.test(t)) return false
  if (t.length < 3 && !modelLike(t)) return false
  const words = t.split(/[^a-z0-9]+/).filter(Boolean)
  return words.some((w) => (w.length >= 3 && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w)) || modelLike(w))
}

/**
 * The one mapping an anonymous call uses: agent id <-> RESOURCE_x key, and a masker for free text.
 * @param {{ id: string, key?: string, names?: string[] }[]} entries  every resource the call may
 *   mention; `key` only for the ones that are candidates in it. A name that belongs to exactly one
 *   keyed resource becomes that key, so "claude kept failing" reads "RESOURCE_A kept failing" and
 *   the evidence survives; any other identity word becomes a neutral placeholder. Only specific
 *   names count (see specificName): a generic one is dropped even when a caller passes it.
 *
 * `mask` rewrites one string. `maskFree` walks a structured value and rewrites its string
 * values, never its object keys (a map keyed by task type stays keyed by task type; the maps
 * keyed by agent id are re-keyed through `keyOf` by the caller, before this). Every string value
 * is masked, categorical or not: a category the router wrote (a cost tier, a task type, an
 * outcome) can never be a name, because specificName refuses every such word, so masking leaves
 * it exactly as it was; and a field that merely LOOKS categorical but came from outside (an
 * executor's diagnostic with a `status` or `source`) is precisely where a name would otherwise
 * ride out unmasked.
 */
export function anonymity(entries = []) {
  const keyById = new Map(entries.filter((e) => e?.id && e.key).map((e) => [e.id, e.key]))
  const idByKey = new Map([...keyById].map(([id, key]) => [key, id]))
  const owners = new Map()
  for (const e of entries) {
    if (!e?.id) continue
    for (const n of [e.id, ...(e.names ?? [])]) {
      if (!specificName(n)) continue
      const t = n.trim().toLowerCase()
      owners.set(t, (owners.get(t) ?? new Set()).add(e.key ?? UNNAMED))
    }
  }
  for (const t of BRAND_TERMS) if (!owners.has(t)) owners.set(t, new Set([UNNAMED]))
  // A name two resources share identifies neither, so it maps to the placeholder.
  const replacement = new Map([...owners].map(([t, ks]) => [t, ks.size === 1 ? [...ks][0] : UNNAMED]))
  // Longest first, so 'claude-code' is replaced whole before 'claude' could split it. A brand word
  // also takes a version glued to it ('qwen2.5', 'llama3', 'gpt4o', 'gpt-4o'): the brand followed
  // by a version is still the brand, and the word boundary alone let every such name through. The
  // suffix must start with a digit, so an ordinary word that merely begins with the letters
  // ('gptext', 'opusculum') is still no name. A configured name longer than the brand still wins
  // ('gpt-5.6' as a model id reads as its own key), because it comes first in the alternation.
  // Every name also takes a point release after it: 'gpt-5.6' is a longer version string than
  // 'gpt-5', not that name, and refusing the match there sent a configured name that is no brand
  // word ('grok-2.1' with 'grok-2' configured) out verbatim, with nothing longer to catch it.
  const ordered = [...replacement.keys()].sort((a, b) => b.length - a.length)
  const brands = new Set(BRAND_TERMS)
  const alt = ordered.map((t) => `${escapeRe(t)}${brands.has(t) ? VERSION_SUFFIX : ''}${POINT_RELEASE}`)
  const re = new RegExp(`(?<![a-z0-9])(?:${alt.join('|')})(?![a-z0-9])`, 'gi')
  // A versioned name is not the name it starts with (an agent whose id is 'claude' is not every
  // 'claude3', and 'grok-2' is not 'grok-2.1'), so only an exact name reads as a key; the rest is
  // the placeholder.
  const mask = (text) => (typeof text === 'string' ? text.replace(re, (m) => replacement.get(m.toLowerCase()) ?? UNNAMED) : text)
  const maskFree = (v) => (Array.isArray(v) ? v.map(maskFree)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskFree(x)]))
      : mask(v))
  return { keyOf: (id) => keyById.get(id), idOf: (key) => idByKey.get(key), mask, maskFree }
}

/** A tool step in the attempt log: router.js records it as `tool:<tool id>`. */
const isToolAttempt = (agent) => typeof agent === 'string' && agent.startsWith('tool:')

/** The names a configured agent goes by, for the masker: the same list the routing call uses. */
const namesOf = identityNames

/**
 * Why an agent outside the work table is not a candidate for the work, in the words Jev reads.
 * The decision record says why for everything it excluded, and says whether that was a hard fact
 * or not: a weekly gate, the capability floor and conservation are policy and judgment, and a
 * resource kept out by them is kept for review on purpose. Telling Jev a judgment was a hard fact
 * made the resource conserved for harder work look unfit to judge. An agent a current record does
 * not mention never reached the engine: the router offers it only what the executor registry says
 * can take this request. A record from before `excluded` was kept says nothing either way, and
 * then nothing is claimed.
 */
function outsideLine(o) {
  const why = o.reason
    ? `${o.hard ? 'a hard fact kept it out' : 'kept out by policy or judgment, not by a hard fact'}: ${o.reason}`
    : o.unrecorded
      ? 'the decision record does not say why it is outside the work table'
      : 'the router did not offer it for the work, because the executor registry does not list it as able to take this request here (its input, file changes, locality or context size)'
  return `Not a candidate for the work in this run: ${why}`
}

/**
 * The review and retry options as anonymous candidates, built from the run's own decision record
 * (`routing.decision.candidates`, which carries the id next to each key, and `excluded`, which
 * says why each other resource is out). Every agent the router may hand the job to gets a key:
 * the decision's key when it was a candidate, a fresh one past the highest used otherwise. Null
 * without a decision record (legacy routing, or a run that fell back before the engine
 * answered): those runs keep the named options. `attempts` add the model each attempt really ran
 * on to that agent's names, and name an agent that ran but is no longer configured.
 */
function reviewTable(decision, agents, { modelOf, attempts = [] } = {}) {
  const decisionCandidates = decision?.candidates
  if (!Array.isArray(decisionCandidates) || !decisionCandidates.length) return null
  const byId = new Map(decisionCandidates.filter((c) => c?.id && c?.key).map((c) => [c.id, c]))
  if (!byId.size) return null
  const recorded = Array.isArray(decision.excluded)
  const whyOut = new Map((recorded ? decision.excluded : []).filter((e) => e?.id).map((e) => [e.id, e]))
  // What cleared the hard facts but does not do the work: the same numbers as the work table.
  const reviewOnly = new Map((Array.isArray(decision.reviewOnly) ? decision.reviewOnly : []).filter((c) => c?.id).map((c) => [c.id, c]))
  const ran = new Map()
  for (const at of attempts) {
    if (!at?.agent || isToolAttempt(at.agent)) continue
    const seen = ran.get(at.agent) ?? []
    ran.set(at.agent, [...seen, modelIdOf(at.model), modelIdOf(at.modelVersion)])
  }
  const pool = agents?.length ? agents : [...byId.keys()].map((id) => ({ id }))
  const used = new Set([...byId.values()].map((c) => c.key))
  // A review-only resource keeps the key the routing call gave it, so one resource reads as one
  // key across the run's calls; only an agent the engine never keyed gets a fresh one.
  const adopted = new Map()
  for (const [id, r] of reviewOnly) if (r.key && labelIndex(r.key) >= 0 && !used.has(r.key)) { used.add(r.key); adopted.set(id, r.key) }
  let next = Math.max(-1, ...[...used].map(labelIndex)) + 1
  const rows = []
  const entries = []
  for (const a of [...pool].sort((x, y) => String(x.id).localeCompare(String(y.id)))) {
    const c = byId.get(a.id)
    let key = c?.key ?? adopted.get(a.id)
    if (!key) { do key = resourceLabel(next++); while (used.has(key)); used.add(key) }
    // The decision record keeps reliability as a capability dimension; the table reads it top level.
    const out = whyOut.get(a.id)
    const numbers = c ?? reviewOnly.get(a.id)
    const row = numbers ? { ...numbers, key, reliability: numbers.reliability ?? numbers.capabilities?.reliability } : { key }
    rows.push(c ? row : { ...row, outside: true, hard: !!out?.hard, reason: out?.reason, ...(!out && !recorded ? { unrecorded: true } : {}) })
    entries.push({ id: a.id, key, names: [...namesOf(a, modelOf), ...(ran.get(a.id) ?? [])] })
  }
  // An agent that ran in this run but is not in the list the review offers (removed from config
  // since) is no option, but its name is still in the attempts: it masks to the placeholder.
  for (const [id, models] of ran) if (!pool.some((a) => a.id === id)) entries.push({ id, names: models })
  rows.sort((x, y) => labelIndex(x.key) - labelIndex(y.key))
  const anon = anonymity(entries)
  // The engine's reason is its own words, but a reason can carry what an adapter reported
  // ('claude: logged out'), so it is masked like every other identity channel.
  for (const r of rows) if (r.reason) r.reason = anon.mask(scrub(r.reason))
  return { rows, anon }
}

// Normalize a Score over N described levels to 0..1.
const unit = (answer, levels) => answer.score / (levels.length - 1)
const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)

/**
 * One anonymous candidate as Jev reads it: its machine-readable properties and nothing that
 * names a provider or a model. The same numbers ride `state.candidates` in full; the criteria
 * line is the compact form the choice is made over.
 */
export function candidateLine(c) {
  if (c.outside) return c.capabilities ? `${outsideLine(c)}; for review: ${numbersLine(c)}` : `${outsideLine(c)}. No capability data is recorded for it here`
  return numbersLine(c)
}

function numbersLine(c) {
  const caps = Object.entries(c.capabilities ?? {})
    .filter(([, v]) => typeof v?.score === 'number')
    .map(([d, v]) => `${d} ${r2(v.score)}${typeof v.confidence === 'number' && v.confidence < 0.5 ? ' (low confidence)' : ''}`)
  const parts = [
    `tier ${c.tier ?? 'unknown'}`,
    ...caps,
    `source ${c.source}`,
    `scarcity ${c.scarcity == null ? 'unknown' : r2(c.scarcity)}`,
    c.resetInMinutes != null ? `reset in ${Math.round(c.resetInMinutes)} min` : '',
    `expected cost ${c.expectedCost?.class ?? 'unknown'}`,
    `latency ${c.latency ?? 'unknown'}`,
    c.reliability?.score != null ? `reliability ${r2(c.reliability.score)}` : '',
    `${c.evidenceSamples ?? 0} verified runs${c.cold ? ' (new, little evidence)' : ''}`,
    c.availability && c.availability !== 'ok' ? `availability ${c.availability}` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

/** The candidate table sent as state: numbers and categories only, no names. */
export function candidateState(candidates) {
  return candidates.map((c) => (c.outside ? {
    key: c.key,
    candidate_for_work: false,
    // Why it is out, and whether that was a hard fact: a resource conserved or gated by policy is
    // kept to review on purpose, and the review pick should know that.
    kept_out_by: c.reason ? (c.hard ? 'hard_fact' : 'policy_or_judgment') : c.unrecorded ? 'unrecorded' : 'not_offered_for_this_request',
    ...(c.reason ? { reason: c.reason } : {}),
    // A review-only resource carries the numbers it would be judged on, as a work candidate does.
    ...(c.capabilities ? numbersState(c) : {}),
  } : { ...numbersState(c) }))
}

function numbersState(c) {
  return {
    key: c.key,
    tier: c.tier,
    capabilities: Object.fromEntries(Object.entries(c.capabilities ?? {}).map(([d, v]) => [d, { score: r2(v.score), confidence: r2(v.confidence), samples: v.samples ?? 0 }])),
    source: c.source,
    scarcity: r2(c.scarcity),
    scarcity_confidence: r2(c.scarcityConfidence),
    reset_in_minutes: c.resetInMinutes == null ? null : Math.round(c.resetInMinutes),
    marginal_cost: c.marginalCost,
    expected_cost: c.expectedCost ? { total: r2(c.expectedCost.total), class: c.expectedCost.class } : null,
    latency: c.latency,
    availability: c.availability,
    reliability: c.reliability ? { score: r2(c.reliability.score), confidence: r2(c.reliability.confidence) } : null,
    verified_runs: c.evidenceSamples ?? 0,
    new_resource: !!c.cold,
    // Only the decision record has it (the fit for THIS task); the routing call's table does not.
    ...(typeof c.fit === 'number' ? { task_fit: r2(c.fit) } : {}),
  }
}

/** One Jev call as the Inspector shows it: timing, usage, every question and its full answer. */
function traceOf(phase, questions, res, ms, used) {
  return {
    phase,
    ms,
    model: res.model,
    // The call's own id from `x-typesafe-request-id`. The quick reference's house rule is to log
    // it with the model, because it is the only handle TypeSafe support can act on when a
    // judgment looks wrong.
    requestId: res.requestId,
    usage: res.usage,
    questions: Object.entries(questions).map(([name, q]) => {
      const a = res.answers[name]
      return {
        name,
        type: q.type,
        question: typeof q.instructions === 'string' ? q.instructions : q.instructions.question,
        options: q.type === 'choice' ? Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, typeof v === 'string' ? v : v?.what])) : q.type === 'score' ? { ...q.criteria } : undefined,
        answer: a.type === 'choice' ? a.choice : a.type === 'score' ? a.score : a.noul,
        confidence: a.confidence,
        probabilities: a.probabilities,
        used: used(name, res.answers),
      }
    }),
  }
}

/** The task profile from the task-group answers, in the shape the rest of the router reads. */
export function profileFromAnswers(answers) {
  const requirements = {}
  for (const d of REQUIREMENT_DIMENSIONS) if (answers[`req.${d}`]) requirements[d] = unit(answers[`req.${d}`], REQUIREMENT_LEVELS)
  const primary = answers.skill?.choice
  // Supporting skills: the next strongest choices of the same question, above a floor. One
  // question instead of one per skill, and never more than three, so the prompt stays clean.
  const supporting = Object.entries(answers.skill?.probabilities ?? {})
    .filter(([k, p]) => k !== primary && p >= 0.15)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k)
  const verification = []
  if ((answers.needsTests?.noul ?? 0) >= 0.5) verification.push('checks')
  return {
    taskType: answers.taskType?.choice,
    taskTypeConfidence: answers.taskType?.confidence,
    taskTypeProbabilities: answers.taskType?.probabilities,
    complexity: answers.complexity ? unit(answers.complexity, COMPLEXITY_LEVELS) : undefined,
    risk: answers.risk ? unit(answers.risk, RISK_LEVELS) : undefined,
    requirements,
    skills: primary ? { primary, supporting } : undefined,
    skillConfidence: answers.skill?.confidence,
    capability: answers.capability?.choice,
    capabilityConfidence: answers.capability?.confidence,
    minimumCapability: answers.minimumCapability?.choice,
    minimumCapabilityConfidence: answers.minimumCapability?.confidence,
    preferredCapability: answers.preferredCapability?.choice,
    verification,
    needsSecondOpinion: answers.secondOpinion?.noul,
    needsHumanReview: answers.humanReview?.noul,
    needsTests: answers.needsTests?.noul,
    continueHandoff: answers.continueHandoff?.noul,
  }
}

export function createJev({ apiKey, model, timeoutMs, onTrace }) {
  const client = new TypeSafeClient({ apiKey, ...(model ? { defaultModel: model } : {}) })
  const ask = async (phase, state, questions, signal, used = () => true) => {
    const t0 = Date.now()
    const call = client.systemOne({ state, questions }, { timeout: timeoutMs, signal })
    // `.withResponse()` is how the SDK hands back the request id; without it the id never
    // reaches the log. Falls back cleanly if a future SDK drops the method.
    const { data: res, requestId } = typeof call?.withResponse === 'function'
      ? await call.withResponse()
      : { data: await call, requestId: undefined }
    onTrace?.(traceOf(phase, questions, requestId ? { ...res, requestId } : res, Date.now() - t0, used))
    return res
  }

  return {
    /**
     * Routing. One batched call over whichever judgment groups are still needed:
     *
     *   task      (default on)  what the request needs: type, complexity, risk, the requirement
     *                           dimensions, skills, minimum and preferred tier, verification,
     *                           capability category, tools
     *   resource  (when `candidates` is given)  which anonymous candidate should do the work
     *                           and which execution strategy
     *   judgments (when `candidates` is given)  second opinion, conservation, frontier review:
     *                           three yes/no judgments that teach three domains of their own
     *   agent     (legacy: `agents` without `candidates`)  the old named-agent choice
     *
     * `ask.task` false skips the task group when a local classifier already produced the
     * profile; that profile then rides `state.task_profile` so the resource judgment can
     * read it. Every tool's parameter questions are asked speculatively in the same call.
     *
     * `history`, `availability` and `trackRecord` arrive keyed by agent id. Only the legacy named
     * question reads them that way. In a call with the anonymous table they are re-keyed through
     * `identities` ([{ id, key, names }], from the decision engine), and without it they are left out.
     */
    async route({ task, context, agents = [], candidates, strategies, tools = [], history, availability, trackRecord, identities, handoff, capabilities, taskProfile, ask: want = {} }, signal) {
      const askTask = want.task !== false
      const askResource = !!candidates?.length && want.resource !== false
      // The judgment nouls (second opinion, conservation, frontier review) are their own group:
      // they teach three routing domains that mature on their own, so they must be askable
      // without the resource choice and skippable when only the resource choice is still open.
      const askJudgments = !!candidates?.length && want.judgments !== false
      const carriesTable = askResource || askJudgments
      // The named-agent question never rides a call that carries the anonymous table: its
      // options would print the very names the table exists to withhold.
      const askAgent = !carriesTable && agents.length > 0 && want.agent !== false
      const state = { task: scrub(task), workspace: context }
      if (askAgent) {
        // Legacy named routing: the question is asked over names, so its evidence is keyed by name.
        state.recent_outcomes = history
        if (availability) state.agent_availability = availability
        if (trackRecord) state.agent_track_record = scrubDeep(trackRecord)
      } else {
        // `identities` ({ id, key, names }) is how an id becomes the key the table uses; only a key
        // that is really in this call's table counts, so a resource the pool dropped reads as
        // unnamed rather than as a key nothing describes. Without it (or in a call with no
        // table, which asks nothing about resources) the per-agent maps have nothing they may be
        // keyed by, so they are left out rather than sent under the real names.
        const offered = new Set((candidates ?? []).map((c) => c.key))
        const anon = carriesTable && identities?.length
          ? anonymity(identities.map((e) => ({ ...e, key: offered.has(e.key) ? e.key : undefined })))
          : null
        if (Array.isArray(history)) {
          state.recent_outcomes = history.map(({ first_agent: first, ...rest }) => {
            const key = anon && first ? anon.keyOf(first) : undefined
            return { ...(anon ? anon.maskFree(rest) : rest), ...(key ? { first_resource: key } : {}) }
          })
        }
        if (anon) {
          // These two maps are keyed by agent id, and only their top level is: that key goes
          // through the id->key mapping. Everything under it (task types, cost tiers) is the
          // evidence itself, so only its free text is masked.
          const byKey = (map) => Object.fromEntries(Object.entries(map ?? {}).map(([id, v]) => [anon.keyOf(id), v]).filter(([k]) => k))
          if (availability) state.candidate_availability = anon.maskFree(byKey(availability))
          if (trackRecord) state.candidate_track_record = anon.maskFree(scrubDeep(byKey(trackRecord)))
        }
      }
      if (handoff) state.handoff = clip(handoff, 3000)
      if (carriesTable) state.candidates = candidateState(candidates)
      if (!askTask && taskProfile) state.task_profile = scrubDeep(taskProfile)
      const questions = {}
      if (askAgent) {
        questions.agent = choice(
          {
            question: 'Which coding agent should handle `task` first?',
            focus: 'Match the nature of `task` and the facts in `workspace` to each agent\'s strengths. `recent_outcomes` shows how agents did on earlier tasks here.'
              + (trackRecord ? ' Prefer the cheapest agent likely to succeed, judged by `agent_track_record` (accepted rate for this kind of task here, then overall): free-local and free agents for simple or read-only work, api agents for routine work, subscription agents for hard, risky or cross-cutting work or where cheaper agents keep failing. Avoid agents with repeated limit hits. Where `price_now` says an agent is on its standard (not off-peak) rate, prefer an equally capable agent that is not, unless the task needs that one.' : '')
              + (availability ? ' Prefer agents that are \'ok\' in `agent_availability` over those \'near limit\'.' : ''),
          },
          agentCriteria(agents),
        )
      }
      if (askTask) {
        Object.assign(questions, {
          taskType: choice('What kind of work does `task` ask for?', TASK_TYPES),
          complexity: score('How complex is `task` to carry out correctly in this workspace?', COMPLEXITY_LEVELS),
          risk: score('How much harm could a wrong result for `task` cause if shipped?', RISK_LEVELS),
          humanReview: noul('Should a person inspect the result of `task` before it is accepted, even if checks pass?'),
          needsTests: noul('Should deterministic checks (tests, type checker, lint, build) be required to pass before the result of `task` is accepted?'),
          skill: choice(
            { question: 'Which skill is the primary one `task` calls for?', focus: 'The one discipline that finishing the task mostly is; supporting skills are read from the other probabilities.' },
            Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, { what: v }])),
          ),
          minimumCapability: choice(
            { question: 'What is the weakest tier of model that could complete `task` acceptably?', focus: 'Judge the task, not the models on offer. Acceptable means passes verification without a person redoing it.' },
            TIERS,
          ),
          preferredCapability: choice(
            { question: 'Which tier of model would give the best result for `task` if cost did not matter?', focus: 'Judge the task, not the models on offer.' },
            TIERS,
          ),
        })
        for (const d of REQUIREMENT_DIMENSIONS) {
          questions[`req.${d}`] = score({ question: `How much does doing \`task\` well depend on ${REQUIREMENT_TEXT[d]}?`, focus: 'Judge the task as written, in this workspace.' }, REQUIREMENT_LEVELS)
        }
        // Without a judgments group in this call (the legacy named-agent path), the second-opinion
        // noul still rides the task group so the profile keeps its `needsSecondOpinion`.
        if (!askJudgments) questions.secondOpinion = noul('Would an independent second agent reviewing the result of `task` likely catch mistakes worth the extra time?')
        if (handoff) questions.continueHandoff = noul('Does `task` ask to continue the earlier unfinished work described in `handoff`?')
        // What kind of outcome this needs. Batched with everything else, so it costs only its own
        // tokens and no extra round trip. The options are the capabilities some pickable executor
        // really has: a category nothing on this machine can carry out is never offered, and
        // `human_required` is always available because a person always is.
        if (capabilities?.length) {
          questions.capability = choice(
            {
              question: 'What kind of outcome does `task` need?',
              focus: 'Choose what finishing the task actually requires. Explaining while changing code is still `project_change`; reading the project without changing it is `project_read`.',
            },
            {
              ...Object.fromEntries(capabilities.map((c) => [c, { what: CAPABILITIES[c] }])),
              human_required: { what: CAPABILITIES.human_required },
              // Choice is relative, so something always wins (quick reference rule 6): without an
              // escape hatch a request that fits nothing is forced into the nearest wrong category.
              other: { what: 'Nothing in this list fits: the request needs something these executors are not described as doing' },
            },
          )
        }
        if (tools.length) {
          questions.handler = choice(
            {
              question: 'Can a fixed tool fully handle `task`, or does it need an AI coding agent?',
              focus: 'Pick a tool only when it does exactly what `task` asks with no judgment, writing, or code changes. Anything else needs an agent.',
            },
            { agent: { what: 'An AI coding agent is needed: the task involves reasoning, writing, or changing code' }, ...Object.fromEntries(tools.map((t) => [t.id, { what: t.description }])) },
          )
          for (const t of tools) {
            // Atomic yes/no per tool (skill-suggestion cookbook); the handler choice alone is too broad.
            questions[`${t.id}.fits`] = noul({
              question: `Does the \`${t.id}\` tool do exactly what \`task\` asks, with nothing left for an AI agent?`,
              focus: `The \`${t.id}\` tool: ${t.description}`,
            })
            for (const [p, def] of Object.entries(t.params ?? {})) {
              questions[`${t.id}.${p}`] = choice(def.question, Object.fromEntries(Object.entries(def.options).map(([k, v]) => [k, { what: v }])))
            }
          }
        }
      }
      if (askResource) {
        const profileNote = askTask ? 'Judge the task from `task` itself.' : 'The task profile is `task_profile`: what the task needs, how complex and risky it is.'
        questions.resource = choice(
          {
            question: 'Which candidate in `candidates` should do the work for `task`?',
            focus: `${profileNote} Each candidate is anonymous: judge it only by its capability scores on the dimensions the task needs (a score with low confidence or few verified runs is a guess), its scarcity (subscription capacity is already paid for but runs out; spend scarce capacity where its extra capability matters and not on work a cheaper candidate can do), its expected cost including likely retries, its reliability and latency. Do not choose a candidate materially weaker than the task needs just because it is cheap.`
              + (state.candidate_track_record ? ' `candidate_track_record` and `candidate_availability` use the same keys: how each candidate has done on earlier work here, and whether it is near a limit.' : ''),
          },
          Object.fromEntries(candidates.map((c) => [c.key, { what: candidateLine(c) }])),
        )
        const strategyKeys = (strategies?.length ? strategies : Object.keys(STRATEGIES)).filter((s) => STRATEGIES[s])
        if (strategyKeys.length > 1) {
          questions.strategy = choice(
            {
              question: 'How should the work for `task` be organised across the candidates?',
              focus: 'A direct strategy runs one candidate with the usual checks and review. The plan-then-execute and review strategies spend the strongest candidate only on planning or judging and a cheaper one on the bulk work. Prefer the least expensive strategy that still gives the required quality.',
            },
            Object.fromEntries(strategyKeys.map((s) => [s, { what: STRATEGIES[s] }])),
          )
        }
      }
      if (askJudgments) {
        // Only the judgments a decision reads. Every question costs tokens and latency on every
        // routed run, so one whose answer nothing acts on is not asked: "is the cheapest enough"
        // is what the conservation question already decides, and a consistency-review answer had
        // no step that would carry it out.
        Object.assign(questions, {
          secondOpinion: noul('Would an independent second agent reviewing the result of `task` likely catch mistakes worth the extra time?'),
          conserve: noul({ question: 'Should the scarce capacity of the most capable candidate in `candidates` be conserved for harder work than `task`?', focus: 'Yes when a cheaper candidate is likely enough for this task; no when the extra capability matters here.' }),
          frontierReview: noul({ question: 'Should the strongest candidate in `candidates` review the result of `task` before it is accepted?', focus: 'Yes for security-sensitive, high-risk or subtle multi-module work; no for routine work the checks already cover.' }),
        })
      }
      if (!Object.keys(questions).length) throw new Error('jev.route: nothing to ask')
      // Per-tool fits/params are speculative; only the handler's pick is used.
      const used = (name, ans) => !name.includes('.') || name.startsWith('req.') || name.startsWith(`${ans.handler?.choice}.`)
      const { answers, model: usedModel } = await ask('route', state, questions, signal, used)
      const handler = answers.handler?.choice ?? 'agent'
      const params = handler === 'agent' ? [] : Object.keys(tools.find((t) => t.id === handler)?.params ?? {})
      const profile = askTask ? profileFromAnswers(answers) : null
      const validKey = (k) => candidates?.some((c) => c.key === k)
      return {
        model: usedModel,
        ...(askAgent ? {
          primaryAgent: answers.agent.choice,
          agentConfidence: answers.agent.confidence,
          agentProbabilities: answers.agent.probabilities,
        } : {}),
        ...(askResource ? {
          resource: {
            // A key outside the offered set (a mocked or confused answer) is not a pick.
            chosenKey: validKey(answers.resource?.choice) ? answers.resource.choice : undefined,
            confidence: answers.resource?.confidence,
            probabilities: answers.resource?.probabilities ?? {},
          },
          strategy: answers.strategy ? { choice: answers.strategy.choice, confidence: answers.strategy.confidence, probabilities: answers.strategy.probabilities ?? {} } : undefined,
        } : {}),
        ...(askJudgments ? {
          secondOpinion: answers.secondOpinion?.noul,
          conserve: answers.conserve?.noul,
          frontierReview: answers.frontierReview?.noul,
        } : {}),
        ...(profile ? {
          profile,
          // What the request needs. Undefined when no registry was wired, so nothing downstream
          // has to guess whether the answer is meaningful.
          capability: profile.capability,
          capabilityConfidence: profile.capabilityConfidence,
          taskType: profile.taskType,
          taskTypeConfidence: profile.taskTypeConfidence,
          complexity: profile.complexity,
          risk: profile.risk,
          needsSecondOpinion: profile.needsSecondOpinion,
          needsHumanReview: profile.needsHumanReview,
          needsTests: profile.needsTests,
          continueHandoff: profile.continueHandoff,
          handler,
          handlerConfidence: answers.handler?.confidence,
          toolFits: handler === 'agent' ? undefined : answers[`${handler}.fits`]?.noul,
          // Call confidence = weakest argument (function-calling cookbook); 1 when the tool takes none.
          toolArgConfidence: handler === 'agent' ? undefined : Math.min(1, ...params.map((p) => answers[`${handler}.${p}`].confidence)),
          toolArgs: handler === 'agent' ? undefined : Object.fromEntries(params.map((p) => [p, answers[`${handler}.${p}`].choice])),
        } : {}),
      }
    },

    /**
     * Is the latest message work to carry out in the project, or a question to answer directly?
     * And how much does answering it well depend on real reasoning?
     *
     * Both ride the one call (~0.1 s), so the second question costs no extra round trip. It
     * decides which model answers: everyday talk goes to the local model first (free, private,
     * instant), and Jev is the one that decides when it is worth waking a bigger model.
     */
    async intent({ message }, signal) {
      const { answers } = await ask('intent', { message: scrub(message) }, {
        kind: choice(
          { question: 'What does `message` ask for?', focus: 'Only work that reads or changes the project counts as a task. Questions about tools, accounts, concepts or this app are questions.' },
          {
            task: { what: 'Work to carry out in the code project: fix, build, change, refactor, review, test, investigate or explain its code or files', not_for: 'General questions or chat that need no project files' },
            question: { what: 'A question or conversation to answer directly, such as how something works, why something happened, or advice', not_for: 'Requests to read, change or check files in the project' },
          },
        ),
        depth: choice(
          { question: 'How much does answering `message` well depend on careful reasoning or wide, current knowledge?', focus: 'Judge the question itself, not who is asking it or how it is worded.' },
          {
            everyday: { what: 'Greetings, small talk, thanks, a short how-to or factual answer, or something a small local model handles well', not_for: 'Anything whose answer needs several steps of reasoning, wide or current knowledge, or the details of this project' },
            deep: { what: 'Needs careful step-by-step reasoning, wide or up-to-date knowledge, or knowledge of this project: worth the strongest available model', not_for: 'Greetings, thanks, small talk, and one-line factual or how-to answers' },
          },
        ),
        // One message may do both: answer it and ask for work. Asked independently so a message
        // that is mostly a question can still queue the change it mentions - the old single
        // question-versus-task choice could not express that at all.
        alsoWork: noul('Even if `message` is a question to answer directly, does it also ask for work to be carried out in the project?'),
      }, signal)
      return {
        kind: answers.kind.choice,
        confidence: answers.kind.confidence,
        // Undefined when Jev did not answer that one: the caller then keeps the cheap default.
        depth: answers.depth?.choice,
        depthConfidence: answers.depth?.confidence,
        alsoWork: answers.alsoWork?.noul,
      }
    },

    /**
     * Post-execution assessment over summarized, deterministic evidence. The disposition is the
     * teacher label for the outcome domain; the atomic Nouls are what jev-review decides from,
     * and deterministic facts (a failing required check) override both in code.
     */
    async assess({ task, routing, attempts, checks, diff, agents = [], strategy, modelOf }, signal) {
      // With a decision record the review and retry picks are made over the same anonymous,
      // machine-readable candidate data the resource pick was, never over prose descriptions:
      // a description is a capability claim, and it would outvote the owner's priors and the
      // measured evidence on every review and every retry. `modelOf` (agent -> the model it runs)
      // is how the masker learns a CLI agent's model id, as the routing call's does.
      const table = reviewTable(routing?.decision, agents, { modelOf, attempts })
      const anon = table?.anon
      // jev-review hands over `{ results, regressed, fixed, failing }`; a bare array is accepted
      // too. Reading only the array form threw on every real review, and the review then fell
      // back to the deterministic policy without anyone seeing why.
      const results = Array.isArray(checks) ? checks : Array.isArray(checks?.results) ? checks.results : []
      // Check output is test and build stdout, which prints whatever the run had in env.
      const scrubbedResults = results.map((c) => ({ ...c, output: scrub(c.output) }))
      const state = {
        task: scrub(task),
        routing: { task_type: routing.taskType, risk: routing.risk, complexity: routing.complexity, ...(strategy ? { strategy } : {}) },
        // Only the newest attempt is sent in full. Earlier ones shrink to what the review
        // actually uses them for: who tried, how it ended, and whether anything moved. Round 3
        // used to resend rounds 1 and 2 at full length, paying for the same words every round.
        attempts: attempts.map((a, i) => ({
          // Who tried is an identity channel: a key when the options are keys. The executor's
          // diagnostic is metadata about the resource, not the work, so it is masked too. A tool
          // attempt ('tool:<id>') is not an anonymous resource and is never a review or retry
          // option, so its id goes out as is: masking it would only hide which tool ran.
          ...(anon ? { resource: isToolAttempt(a.agent) ? a.agent : anon.keyOf(a.agent) ?? UNNAMED } : { agent: a.agent }),
          role: a.role,
          status: a.stopReason,
          diagnostic: anon ? anon.maskFree(scrubDeep(a.diagnostic)) : scrub(a.diagnostic),
          ...(i === attempts.length - 1 ? { answer: clip(a.answerText, 2500) } : {}),
          changed_files: a.changedFiles,
        })),
        verification: Array.isArray(checks) ? scrubbedResults : { ...checks, results: scrubbedResults },
        diff: { stat: diff.stat, excerpt: clip(diff.patch, 6000) },
      }
      if (table) state.candidates = candidateState(table.rows)
      const options = table ? Object.fromEntries(table.rows.map((r) => [r.key, { what: candidateLine(r) }])) : agentCriteria(agents)
      const who = table
        ? 'Each option is an anonymous candidate in `candidates`: judge it only by its capability scores on what this job needs, its tier, reliability, scarcity and cost. The `resource` of an agent entry in `attempts` is its key; a `tool:<id>` entry is a fixed tool that already ran, not a candidate.'
        : ''
      // The chosen key goes back to an agent id here, in code; the caller never sees a key.
      const toId = (k) => (anon ? anon.idOf(k) : k)
      const probsById = (p) => (anon ? Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [toId(k), v]).filter(([id]) => id)) : p)
      // One snap judgment per question: atomic Nouls (yes = the thing named) decide
      // in jev-review; the broad verdict and the disposition are kept as displayed signals and
      // as the outcome domain's teacher label.
      const { answers } = await ask('review', state, {
        verdict: choice(
          {
            question: 'Given the latest entry in `attempts`, `verification`, and `diff`, what should happen next for `task`?',
            focus: 'Judge the evidence, not the agent\'s own claims. A failing required check in `verification` means the task is not done.',
          },
          VERDICTS,
        ),
        disposition: choice(
          {
            question: 'Which disposition fits the latest entry in `attempts` for `task`?',
            focus: 'The finer version of the verdict: whether a retry should stay on the same kind of resource or move, and whether a review needs the strongest resource or any independent one.',
          },
          DISPOSITION_CRITERIA,
        ),
        addressed: noul('Does the latest entry in `attempts` (its answer and `diff`) do what `task` asked?'),
        complete: noul('Is every part of `task` handled by the latest entry in `attempts` and `diff`, with nothing left undone?'),
        unrelatedChanges: noul('Does `diff` change anything `task` did not ask for?'),
        regressionRisk: noul('Does `diff` carry meaningful risk of breaking behavior that `task` did not ask to change?'),
        needsPerson: noul('Does the latest entry in `attempts` ask a question, report being blocked, or need a decision only a person can make?'),
        // Asked separately because they are different jobs. A careful critic and a strong
        // fixer are rarely the same agent, and one answer spent on both meant whichever the
        // run happened to need got the other one's pick. Both ride this same call, so the
        // split costs no extra round trip.
        reviewAgent: choice(
          {
            question: 'If another agent REVIEWS the latest attempt without changing it, which agent should judge it?',
            focus: `Judging rewards care and independence over speed or cost, and costs few tokens. Prefer ${table ? 'a candidate other than the `resource` of the latest work entry in `attempts`' : 'an agent other than the one that produced the work'}, unless it is clearly the best judge.${who ? ` ${who}` : ''}`,
          },
          options,
        ),
        retryAgent: choice(
          {
            question: 'If another agent has to FIX the latest attempt, which agent should do the work?',
            focus: `Fixing is bulk work: weigh track record on this kind of task and cost. Prefer ${table ? 'a candidate other than the `resource` that just failed' : 'an agent other than the one that just failed'}, unless it is clearly the best fit.${who ? ` ${who}` : ''}`,
          },
          options,
        ),
      }, signal, (name) => name !== 'verdict')
      return {
        verdict: answers.verdict.choice,
        verdictConfidence: answers.verdict.confidence,
        verdictProbabilities: answers.verdict.probabilities,
        disposition: DISPOSITIONS.includes(answers.disposition?.choice) ? answers.disposition.choice : undefined,
        dispositionConfidence: answers.disposition?.confidence,
        dispositionProbabilities: answers.disposition?.probabilities,
        addressed: answers.addressed.noul,
        complete: answers.complete.noul,
        unrelatedChanges: answers.unrelatedChanges.noul,
        regressionRisk: answers.regressionRisk.noul,
        needsPerson: answers.needsPerson.noul,
        reviewAgent: toId(answers.reviewAgent.choice),
        reviewAgentProbabilities: probsById(answers.reviewAgent.probabilities),
        retryAgent: toId(answers.retryAgent.choice),
        retryAgentProbabilities: probsById(answers.retryAgent.probabilities),
      }
    },
  }
}

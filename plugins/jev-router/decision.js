// The decision engine: one routing decision, made domain by domain.
//
// The router hands this the request and the pool of agents its hard filters let through; the
// engine hands back the routing object the loop runs on. In between, each routing domain is
// asked in turn through its own controller (domains.js), which is what lets task classification
// mature locally while another domain still asks Jev: the controller decides who is
// authoritative, and this file only supplies the inputs, the teacher call and a deterministic
// answer per domain.
//
// Not every domain has a teacher. Which resource does the work and whether the strongest resource
// should review are comparisons of numbers, and a snap-judgment classifier cannot compare
// magnitudes. Both are rules in code, reported as `code` rather than `fallback`, which means the
// opposite: nobody could decide. Their local classifiers still learn, from the runs that
// contradict a rule's answer. The resource ranking's is only ever recorded beside the ranking and
// never decides (see section 3); the frontier review's may decide once its evidence earns a local
// rung.
//
// Inputs that reach Jev or a local classifier are the machine-readable ones: the capability
// registry's effective profiles (profiles.js), the governor's scarcity and cost signals
// (governor.js), the task profile. Candidates are anonymous (RESOURCE_A ...) on both paths.
// Hard facts and limits are applied here in code and never delegated: an unavailable resource, a
// context window the input would not fit, a capability floor the task requires, the weekly gate,
// and keeping easy work off a most capable resource whose allowance is being used up. What is
// left is judgment, and judgment is what the domains learn.
//
// One Jev call per run at most in the common case: the first domain that needs Jev triggers a
// batched call carrying every question group some not-yet-local domain may still need; later
// domains read from the same answer. A domain that is LOCAL_ONLY contributes no questions, so
// a mature domain costs nothing.
//
// The decider need not be Jev (docs/laya-auto.md 2.5). The router hands over the provider record
// of whoever decides this run beside its client, and every cut-off here is read from that record
// through a per-run policy object, so a Laya run is judged against Laya's bars. A Laya run's
// domains are decided by Laya or by the rules, never by a local classifier, and their samples go
// to Laya's own store (`sink`), never to the one Jev teaches the classifiers from.
import { MARGINAL_COST_BY_KIND, kindOf, marginalCostOf } from './accounts.js'
import { CHARS_PER_TOKEN } from './capabilities.js'
import { cheapestOf, eligibleStrategies, planStrategy, rankCandidates, strongestOf } from './broker.js'
import { anonymize, candidateFeatures, mergeFeatures, poolFeatures, profileFeatures, taskTextFeatures } from './features.js'
import { conservationHint, expectedJobCost, governorSignals } from './governor.js'
import { subjectOf } from './profiles.js'
import { DEFAULT_JEV, TEACHER } from './providers.js'
import { DIMENSIONS, DOMAINS, REQUIREMENT_DIMENSIONS, SKILLS, TASK_DIMENSIONS, TASK_SKILLS, tierAtLeast, tierOf } from './routing-policy.js'

// Which domains a Jev call group is asked for. Resource selection and the frontier review are
// missing on purpose: each of them is a comparison of numbers, which a rule in code decides here
// (`teacher: 'code'` in routing-policy.js DOMAINS), so neither can open a call.
const GROUP_DOMAINS = Object.freeze({
  task: ['task_classification', 'skill_selection'],
  resource: ['execution_strategy'],
  judgments: ['second_opinion'],
})
const NOT_LOCAL = new Set(['JEV_PRIMARY', 'SHADOW', 'ROLLBACK', 'GUARDED_LOCAL'])
// Capabilities that name no particular ability: every agent can answer, and 'other' and
// 'human_required' are not work anyone is being chosen for.
const NOT_WORK_CAPABILITIES = new Set(['quick_answer', 'reasoned_answer', 'other', 'human_required'])
const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)

/**
 * The refusal for "every candidate failed a hard fact". It carries a code because the caller must
 * treat it differently from every other failure: an outage falls back to a default agent, but this
 * cannot, since the only agents left to fall back to are the ones just excluded. A code rather
 * than a message match, so rewording the message can never quietly turn the stop back into a
 * fallback. `excluded` rides along so the caller can say who was ruled out and why.
 */
export const NO_CANDIDATES = 'NO_CANDIDATES'

const noCandidates = (message, excluded) => Object.assign(new Error(message), { code: NO_CANDIDATES, excluded: excluded.map((e) => ({ ...e })) })

const isSkill = (s) => typeof s === 'string' && Object.hasOwn(SKILLS, s)

/**
 * The skills the work is done with, always in SKILLS vocabulary: the chosen primary when it is a
 * known skill, else the one the task type calls for, and at most three known supporting skills.
 * The router puts these into the worker's instructions, so a label outside the vocabulary (a task
 * type such as `refactor` passed off as a skill) would tell the worker nothing.
 */
export function resolveSkills(skills, taskType) {
  const primary = isSkill(skills?.primary) ? skills.primary : TASK_SKILLS[taskType] ?? 'implementation'
  const supporting = [...new Set((Array.isArray(skills?.supporting) ? skills.supporting : []).filter((s) => isSkill(s) && s !== primary))].slice(0, 3)
  return { primary, supporting }
}

/**
 * A safe task profile from the text alone, for when neither Jev nor a trusted local classifier
 * can answer. Deterministic and deliberately unconfident: every number is 0.5 except what the
 * words plainly say, and the profile says so through `heuristic: true`.
 */
export function heuristicProfile(task) {
  const t = String(task ?? '').toLowerCase()
  const type = /\b(security|auth|vulnerab|secret|token|permission)\b/.test(t) ? 'security'
    : /\b(test|spec|coverage)\b/.test(t) ? 'testing'
      : /\b(bug|fix|error|fail|crash|broken|exception)\b/.test(t) ? 'debugging'
        : /\b(review|audit)\b/.test(t) ? 'review'
          : /\b(refactor|rename|restructure|clean ?up)\b/.test(t) ? 'refactor'
            : /\b(doc|readme|comment)\b/.test(t) ? 'documentation'
              : /\b(design|architect|plan|strategy)\b/.test(t) ? 'architecture'
                : /\b(explain|how|why|what|investigate|understand)\b/.test(t) ? 'investigation'
                  : /\b(typo|constant|one[- ]line)\b/.test(t) ? 'simple_change'
                    : 'implementation'
  const requirements = {}
  for (const d of TASK_DIMENSIONS[type] ?? []) if (REQUIREMENT_DIMENSIONS.includes(d)) requirements[d] = 0.7
  return {
    taskType: type, taskTypeConfidence: 0.3, complexity: 0.5, risk: type === 'security' ? 0.7 : 0.5,
    requirements, skills: { primary: TASK_SKILLS[type] ?? 'implementation', supporting: [] },
    minimumCapability: 'standard', preferredCapability: 'strong', verification: ['checks'],
    needsSecondOpinion: 0.5, needsHumanReview: 0.3, needsTests: 0.7, heuristic: true,
  }
}

/**
 * A provider's profile with the answers it marked too flat filled by the rules, field by field
 * (docs/laya-auto.md 4.3). `answered` is the profile jev.js built, where a flat score or choice is
 * left out; `heuristic` is heuristicProfile() of the same task. Every top-level field the provider
 * answered is the provider's. The requirements are merged per dimension, so a flat one takes the
 * heuristic's 0.7 where the task type exercises that dimension and is otherwise absent, which
 * reads as not wanted. Flat tiers take the heuristic's fixed 'standard' and 'strong'. The result is
 * not marked `heuristic`: it is mostly the provider's, and the skill it names is not a fallback.
 */
export function fillFlat(heuristic, answered = {}) {
  const out = { ...heuristic }
  for (const [k, v] of Object.entries(answered)) if (v !== undefined && k !== 'requirements') out[k] = v
  out.requirements = { ...heuristic.requirements, ...answered.requirements }
  delete out.heuristic
  return out
}

/** Numeric parts of a profile, the only thing a training sample keeps of it. */
export function profileNumbers(profile = {}) {
  const out = { complexity: profile.complexity, risk: profile.risk, needsSecondOpinion: profile.needsSecondOpinion, needsHumanReview: profile.needsHumanReview, needsTests: profile.needsTests }
  for (const d of REQUIREMENT_DIMENSIONS) out[`req_${d}`] = profile.requirements?.[d]
  for (const k of Object.keys(out)) if (typeof out[k] !== 'number') delete out[k]
  return out
}

/**
 * The mean numeric profile per task type, from the teacher profiles in the training store. This
 * is how a locally classified task type becomes a full profile without a regression model: the
 * class average of what Jev said for that type, with the spread reported as confidence.
 */
export function classProfiles(rows) {
  const acc = new Map()
  for (const r of rows) {
    // The same rule as domains.js truthOf: once a row has an outcome, the teacher's label is never
    // the truth. A refuted answer (a person's "misread my question", a verified negative) records
    // what the task was NOT; reading the teacher's label there averaged a misread task's numbers
    // into the very type it was not, and every later task classified as that type inherited them.
    const label = r.outcome ? r.outcome.label ?? null : r.teacher?.label
    const nums = r.extra?.profile
    if (!label || !nums) continue
    const a = acc.get(label) ?? { n: 0, sum: {}, sq: {}, tiers: { minimum: {}, preferred: {} } }
    a.n++
    for (const [k, v] of Object.entries(nums)) { if (typeof v !== 'number') continue; a.sum[k] = (a.sum[k] ?? 0) + v; a.sq[k] = (a.sq[k] ?? 0) + v * v }
    // The capability tiers the teacher named for this kind of task, counted rather than averaged:
    // they are categories, and the one it said most often is the one to reproduce.
    for (const which of ['minimum', 'preferred']) {
      const t = r.extra?.tiers?.[which]
      if (typeof t === 'string') a.tiers[which][t] = (a.tiers[which][t] ?? 0) + 1
    }
    acc.set(label, a)
  }
  const modal = (counts) => Object.entries(counts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null
  const out = {}
  for (const [label, a] of acc) {
    const mean = {}; let spread = 0; let k = 0
    for (const key of Object.keys(a.sum)) { mean[key] = a.sum[key] / a.n; const v = a.sq[key] / a.n - mean[key] ** 2; spread += Math.sqrt(Math.max(0, v)); k++ }
    out[label] = { n: a.n, mean, spread: k ? spread / k : 0, tiers: { minimum: modal(a.tiers.minimum), preferred: modal(a.tiers.preferred) } }
  }
  return out
}

/** A profile from a locally predicted task type and the class averages. */
export function profileFromClass(label, probabilities, classes, { capability } = {}) {
  const c = classes?.[label]
  const m = c?.mean ?? {}
  const requirements = {}
  for (const d of REQUIREMENT_DIMENSIONS) if (typeof m[`req_${d}`] === 'number') requirements[d] = m[`req_${d}`]
  if (!Object.keys(requirements).length) for (const d of TASK_DIMENSIONS[label] ?? []) if (REQUIREMENT_DIMENSIONS.includes(d)) requirements[d] = 0.7
  const top = Object.entries(requirements).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0.5
  // The tier the teacher actually named for this kind of task, when it is known. Falling back to
  // a rule read off the requirement scores would make the local path demand a different class of
  // resource than the teacher ever asked for, which is a different routing decision wearing the
  // same label; the rule is only for a class nothing has been recorded about yet.
  const tiers = c?.tiers ?? {}
  return {
    taskType: label, taskTypeConfidence: probabilities?.[label], taskTypeProbabilities: probabilities,
    complexity: m.complexity ?? 0.5, risk: m.risk ?? 0.5, requirements,
    skills: { primary: TASK_SKILLS[label] ?? 'implementation', supporting: [] },
    capability,
    minimumCapability: tiers.minimum ?? (top >= 0.85 ? 'frontier' : top >= 0.65 ? 'strong' : 'standard'),
    preferredCapability: tiers.preferred ?? (top >= 0.7 ? 'frontier' : 'strong'),
    verification: (m.needsTests ?? 0.7) >= 0.5 ? ['checks'] : [],
    needsSecondOpinion: m.needsSecondOpinion ?? 0.5, needsHumanReview: m.needsHumanReview ?? 0.3, needsTests: m.needsTests ?? 0.7,
    classSamples: c?.n ?? 0, classSpread: c?.spread,
  }
}

/**
 * Effective tier of a candidate for a task: the requirement-weighted score over the dimensions
 * this task actually leans on and the registry can speak to.
 *
 * The bar is the capability's STATED confidence (the owner's own prior, or the confidence real
 * evidence has earned), not the registry's saturating precision figure. A precision figure needs
 * dozens of observations to pass any threshold, so reading the bar off it would mean no capability
 * floor existed at all until a machine had routed for weeks: every candidate would be 'unknown',
 * and a request that needs frontier judgment would be as happy with a 4B local model. A prior the
 * owner wrote down is knowledge, and it is allowed to exclude; a weak family guess about an
 * unrecognised model (its confidence is discounted at source) is not.
 */
export function candidateTier(capabilities, requirements, policy) {
  const entries = Object.entries(requirements ?? {}).filter(([, r]) => typeof r === 'number' && r > 0)
  // The dimensions the task really leans on, or all of them when it leans on none strongly: an
  // easy task must still get a tier, otherwise every candidate reads 'unknown' and the floor,
  // the strategy and the report all lose the one number they were about to use. What counts as
  // leaning on one is the deciding provider's cut (a decision's per-run policy), Jev's by default.
  const strong = entries.filter(([, r]) => r >= (policy.requirementWanted ?? 0.5))
  let sum = 0; let w = 0
  for (const [d, r] of (strong.length ? strong : entries)) {
    const cap = capabilities?.[d]
    if (!cap || (cap.stated ?? cap.confidence ?? 0) < policy.floorConfidence) continue
    sum += r * cap.score; w += r
  }
  if (!w) return { tier: 'unknown', score: null }
  return { tier: tierOf(sum / w, policy.capabilityTiers), score: sum / w }
}

/** Rough size of what the agent must read: the task, the handoff note and a context reserve. */
export const contextEstimate = (task, handoff) => Math.ceil((String(task ?? '').length + String(handoff ?? '').length) / CHARS_PER_TOKEN) + 4000

/**
 * @param {object} p
 * @param {object} p.policy      resolvePolicy() result
 * @param {object} p.domains     createDomainRegistry() result: get(domain) -> controller
 * @param {object} p.profiles    createCapabilityRegistry() result
 * @param {object} p.priors      loaded priors (for subjectOf)
 * @param {object} [p.store]     training store, for class profiles
 * @param {object} [p.economics] config.resources.economics: agent id -> { marginalCost }, the
 *   operator's word on how a job is funded; a decide() call may pass its own
 * @param {Function} [p.now]
 * @param {Function} [p.log]
 */
export function createDecisionEngine({ policy, domains, profiles, priors, store, economics: configuredEconomics, now = () => Date.now(), log = () => {} }) {
  // The class averages behind a locally classified task type, cached for a minute because they
  // move slowly. An empty result is never cached: on a cold start there is nothing to average
  // yet, and holding that emptiness for a minute would hand the first runs of a freshly matured
  // task classifier a generic profile instead of the one it learned.
  let classCache = { at: 0, value: {} }
  const classProfilesFor = async () => {
    if (!store) return {}
    const fresh = now() - classCache.at < 60_000 && Object.keys(classCache.value).length > 0
    if (fresh) return classCache.value
    try {
      const value = classProfiles(await store.list({ domain: 'task_classification' }))
      classCache = { at: now(), value }
      return value
    } catch { return classCache.value }
  }

  const controllerOf = (id) => domains?.get?.(id) ?? null
  const maturityOf = (id) => controllerOf(id)?.state?.()?.maturity ?? 'JEV_PRIMARY'

  /**
   * One decision. Returns `{ routing, profile, candidates, excluded, plan, domains, samples, jevCalls }`.
   * `routing` is the shape router.js already reads (primaryAgent, agentProbabilities, taskType ...),
   * extended with `strategy`, `profile`, `decision`.
   *
   * `modelOf` and `versionOf` ((agent, model) => string | undefined) name the subject a profile is
   * read for, exactly as profiles.js keys the evidence it records. `economics` is
   * config.resources.economics (agent id -> { marginalCost }), for agents with no snapshot yet.
   *
   * `decider` is the client of whoever decides this run (createJev() of Jev or of Laya), `jev` the
   * old name for it. `provider` is that decider's record (providers.js), always the one the router
   * hands over and never read off the client, so a missing client can never make a Laya run use
   * Jev's record; without one this is a Jev run on Jev's defaults and the policy's minimumReview.
   * A client whose own record names another provider is refused, so a Laya client handed over
   * without Laya's record never runs as Jev.
   * `sink` is the store a run decided by a provider other than the teacher writes its samples to
   * (laya-samples.jsonl); it is required for such a run, and a Jev run never writes to it.
   */
  async function decide({ task, context, history, handoff, tools = [], agents = [], gated = [], snapshots = [], modelOf, versionOf, economics = configuredEconomics, answerOnly = false, modalities = ['text'], capabilitySet, availability, trackRecord, jev: legacyJev, decider = legacyJev, provider, sink, jevUnavailableReason, signal, emit, runId, capableFor } = {}) {
    const P = provider ?? DEFAULT_JEV
    // A client is never run under another provider's record: a Laya client handed over without
    // Laya's record, under either name, would otherwise be a Jev run, and its answers Jev's
    // teaching in the store the local classifiers learn from.
    if (decider?.provider && decider.provider.id !== P.id) throw new Error(`decision: ${decider.provider.name ?? decider.provider.id}'s client was handed ${P.name}'s record; a run is decided only under the record of the provider that answers it`)
    // Rows 20 and 21 of docs/laya-auto.md 2.6 keep their one source for Jev, routing.minimumReview,
    // whichever Jev record the run is handed: the router's default one carries fixed values.
    const T = P.teacher ? { ...P.thresholds, riskForReview: policy.minimumReview.riskForReview, riskForFrontierReview: policy.minimumReview.riskForFrontierReview } : P.thresholds
    // The deciding provider's cut-offs, in the policy object candidateTier and broker.js already
    // receive: nothing new crosses into broker.js, and nothing is added to the stored profile.
    const pol = {
      ...policy,
      minimumReview: { ...policy.minimumReview, riskForReview: T.riskForReview, riskForFrontierReview: T.riskForFrontierReview },
      requirementWanted: T.requirementWanted,
      easyComplexity: T.easyComplexity,
      judgmentYes: T.judgmentYes,
    }
    // Who the domains hear the answers from, and which store this run's samples belong in: a Jev
    // run's go to each domain's own store whatever `sink` says, so no wiring can send Jev's samples
    // to a store that would refuse them.
    const answeredBy = P.teacher ? TEACHER : P.id
    const into = answeredBy === TEACHER ? {} : { sink }
    // Every sample this decision writes carries the run it belongs to, so a verdict given later
    // about that run's answer can find and relabel them (index.js onVerdict), and goes to the store
    // of whoever decided it.
    const controller = (id) => {
      const c = controllerOf(id)
      return c ? { ...c, decide: (args = {}) => c.decide({ ...args, answeredBy, ...into, context: runId ? { ...(args.context ?? {}), runId } : args.context }) } : c
    }
    // Which store a sample of this run is in, for whoever labels it later (index.js learnFrom).
    const storeKind = answeredBy
    // The answer the domain decided on, whoever gave it: the provider's in a Laya run, else Jev's.
    const rawOf = (d) => d?.provider?.raw ?? d?.teacher?.raw
    // The route answer's own mark on a question it answered too flat to act on (jev.js).
    const flat = (r, name) => !!r?.uninformative?.includes(name)
    // A profile the provider answered only in part, filled by the rules where it was flat.
    const filled = (p) => (p?.filledByRules?.length ? fillFlat(heuristicProfile(task), p) : p)
    const jevCalls = []
    const samples = []
    const domainReport = {}
    const signals = governorSignals({ snapshots, policy, now })
    const disabled = new Set(policy.disabledResources ?? [])
    const allowed = policy.allowedResources?.length ? new Set(policy.allowedResources) : null
    const excluded = []
    const snapById = new Map(snapshots.map((s) => [s.resourceId, s]))

    // --- candidates: facts first, judgment later ---------------------------------------------
    const subjects = new Map()
    const build = (a, taskType) => {
      // versionOf rides along exactly as modelOf does, so the subject read here has the same key
      // as the one evidenceFromRun records against: a reported version must not split them.
      const subject = subjects.get(a.id) ?? subjectOf(a, { modelOf, versionOf, priors })
      subjects.set(a.id, subject)
      const prof = profiles.profileOf(subject, taskType ? { taskType } : {})
      const capabilities = {}
      for (const d of DIMENSIONS) {
        const p = prof.dimensions?.[d]
        if (!p) continue
        // `confidence` is how much evidence stands behind the score and saturates slowly;
        // `stated` is how sure whoever last spoke about it was, which is what a floor may act on.
        capabilities[d] = { score: p.score, confidence: p.confidence, samples: p.samples ?? 0, stated: Math.max(p.prior?.confidence ?? 0, p.confidence ?? 0) }
      }
      const sig = signals.get(a.id) ?? {}
      const snap = snapById.get(a.id)
      // Who funds the work is an account fact. A live snapshot says it first; without one the
      // agent's billing kind does (index.js sets it through accounts.js kindOf, which is where
      // provider knowledge lives), and the operator's economics override outranks the kind's
      // default cost. Never a provider-name test here: a new resource funded the same way must be
      // routed the same way the moment its kind says so.
      const kind = Object.hasOwn(MARGINAL_COST_BY_KIND, a.kind) ? a.kind : kindOf(a)
      const source = snap?.source ?? kind
      const override = economics?.[a.id]?.marginalCost
      const operatorCost = Object.values(MARGINAL_COST_BY_KIND).includes(override) ? override : null
      return {
        id: a.id,
        source,
        capabilities,
        subject,
        scarcity: sig.scarcity ?? null,
        scarcityConfidence: sig.scarcityConfidence ?? 0,
        resetProximity: sig.resetProximity ?? null,
        resetInMinutes: sig.resetInMinutes ?? null,
        marginalCost: sig.marginalCost ?? operatorCost ?? marginalCostOf({ ...a, kind }),
        latency: sig.latencyClass ?? (source === 'local' ? 'medium' : 'slow'),
        availability: sig.availability ?? 'unknown',
        reliability: capabilities.reliability ?? { score: 0.5, confidence: 0, samples: 0 },
        cold: !!prof.cold,
        evidenceSamples: prof.samples ?? 0,
        contextTokens: snap?.hardware?.contextTokens ?? null,
        plan: sig.plan ?? null,
      }
    }
    let pool = []
    for (const a of agents) {
      const sig = signals.get(a.id)
      // `hard` marks a fact about the resource, not a judgment about this task: the router must
      // honour it on every move it makes of its own (a swap, a retry, a review), not only here.
      if (disabled.has(a.id)) { excluded.push({ id: a.id, reason: 'disabled by configuration', hard: true }); continue }
      if (allowed && !allowed.has(a.id)) { excluded.push({ id: a.id, reason: 'not in the allowed resources', hard: true }); continue }
      if (sig?.unavailable) { excluded.push({ id: a.id, reason: sig.unavailable, hard: true }); continue }
      pool.push(build(a))
    }
    if (!pool.length) throw noCandidates(`no resource is available: ${excluded.map((e) => `${e.id} (${e.reason})`).join(', ') || 'no agents'}`, excluded)
    const names = anonymize(pool)
    for (const c of pool) c.key = names.keyOf(c.id)

    // --- the Jev calls ---------------------------------------------------------------------------
    // Two groups, and at most one call each. They cannot be one call: what the resource judgment
    // needs to see (each candidate's tier and fit for THIS task, and the expected job cost that
    // follows from them) only exists once the task profile does. Batching them anyway would hand
    // Jev a candidate table with the capability numbers missing, which is the one thing the design
    // insists must reach it. Within a group every question still rides together.
    //
    // A group whose domains have all matured locally is never asked, so a fully mature router
    // makes no call at all, and a half-mature one makes exactly the call it still needs. In a run
    // another provider decides every group is open: Jev's ladder says nothing about that run, and
    // the provider is asked every question Jev would be asked at JEV_PRIMARY (docs/laya-auto.md 4.1).
    let profile = null
    let strategies = []
    const calls = new Map()
    const groupOpen = (group) => answeredBy !== TEACHER || GROUP_DOMAINS[group].some((id) => NOT_LOCAL.has(maturityOf(id)))
    // What a domain hears besides the answer: whether the provider marked it too flat to act on,
    // and which model identity and script answered (the Laya client's, on the call's meta).
    const marks = (r, name) => ({ informative: !flat(r, name), identity: r.meta?.identity, lang: r.meta?.lang })
    // The decider's call, under its old name: whoever decides, it is asked once per group.
    const askJev = (group) => {
      if (!decider) throw new Error(jevUnavailableReason ?? `${P.name} unavailable`)
      const wanted = group === 'task' ? 'task' : 'resource'
      if (calls.has(wanted)) return calls.get(wanted)
      const ask = wanted === 'task'
        ? { task: true, resource: false, judgments: false }
        // The resource call carries whichever of its two groups is still open, so a mature
        // resource domain does not pay for questions a judgment domain still needs, or the reverse.
        : { task: false, resource: group === 'resource' || groupOpen('resource'), judgments: group === 'judgments' || groupOpen('judgments') }
      // What rides out is anonymous by construction: the key and the machine-readable properties,
      // never the agent id, the provider or the model the subject names. Building the list here
      // rather than letting jev.js strip fields means a field added to a candidate cannot leak by
      // being forgotten in a scrubber.
      const candidates = pool.map((c) => ({
        key: c.key, tier: c.tier, capabilities: c.capabilities, source: c.source,
        scarcity: c.scarcity, scarcityConfidence: c.scarcityConfidence, resetInMinutes: c.resetInMinutes,
        marginalCost: c.marginalCost, expectedCost: c.expectedCost, latency: c.latency,
        availability: c.availability, reliability: c.reliability, evidenceSamples: c.evidenceSamples, cold: c.cold,
      }))
      const promise = decider.route({
        task, context, history, tools, availability, trackRecord, handoff, capabilities: capabilitySet,
        candidates: wanted === 'resource' ? candidates : undefined,
        // Only what eligibleStrategies() says this pool can run: before the pool exists (the task
        // call) there is nothing to offer, and jev.js asks no strategy question over an empty list.
        strategies,
        taskProfile: wanted === 'resource' && profile ? profileNumbers(profile) : undefined,
        ask,
      }, signal).then((r) => { jevCalls.push({ group: wanted, ask, model: r.model }); return r })
      calls.set(wanted, promise)
      return promise
    }

    // --- 1. task classification ------------------------------------------------------------------
    const textFeatures = taskTextFeatures(task, { context, modalities })
    const classes = await classProfilesFor()
    const taskCtl = controller('task_classification')
    const taskDecision = taskCtl ? await taskCtl.decide({
      features: textFeatures,
      jev: decider ? async () => {
        const r = await askJev('task')
        if (!r.profile) return null
        // A type too flat to use is left out of the profile, and so are its probabilities.
        const probabilities = flat(r, 'taskType') ? {} : r.profile.taskTypeProbabilities ?? { [r.profile.taskType]: r.profile.taskTypeConfidence ?? 1 }
        return { label: r.profile.taskType, probabilities, confidence: r.profile.taskTypeConfidence ?? 0.5, model: r.model, raw: r, ...marks(r, 'taskType') }
      } : null,
      fallback: () => { const p = heuristicProfile(task); return { label: p.taskType, probabilities: { [p.taskType]: 1 }, confidence: p.taskTypeConfidence, raw: { profile: p } } },
      // The numbers the teacher put on this task ride the sample, so a task type decided locally
      // later can be turned back into a full profile from the class average rather than a
      // generic one. Numbers only: no task text ever reaches the store. Another provider's numbers
      // are kept under a name of their own, which no class average reads, and only when it gave
      // them: the rules' profile, when it gave none, is not its numbers.
      context: {
        extra: ({ teacher: t, provider: given, answer }) => {
          const p = P.teacher ? (t?.raw?.profile ?? answer?.raw?.profile) : given?.raw?.profile
          return p ? { [P.teacher ? 'profile' : 'providerProfile']: profileNumbers(p), tiers: { minimum: p.minimumCapability, preferred: p.preferredCapability } } : {}
        },
      },
    }) : null
    let routed = null
    const answered = rawOf(taskDecision)
    if (taskDecision?.authority === P.id && answered?.profile) { routed = answered; profile = filled(routed.profile) }
    // The provider's type was too flat to use: the rules give the type, and the provider still
    // gives every field it did answer, the tool it picked and that tool's numbers included.
    else if (taskDecision?.authority === 'fallback' && answered?.profile) { routed = answered; profile = filled(answered.profile) }
    else if (taskDecision?.authority === 'local') profile = profileFromClass(taskDecision.label, taskDecision.probabilities, classes, {})
    else if (taskDecision?.authority === 'fallback') profile = heuristicProfile(task)
    else if (!taskCtl && decider) { try { routed = await askJev('task'); profile = filled(routed.profile) } catch (err) { if (signal?.aborted) throw err; profile = { ...heuristicProfile(task), fallbackReason: String(err?.message ?? err) } } }
    else profile = heuristicProfile(task)
    if (!profile) profile = heuristicProfile(task)
    if (taskDecision?.sampleId) samples.push({ domain: 'task_classification', id: taskDecision.sampleId, store: storeKind, profile: profileNumbers(profile) })
    // With no controller wired (learning off) the report still says who answered, rather than
    // 'none', so the run's "who decided" line names the decider when it read the task.
    domainReport.task_classification = report(taskDecision ?? { authority: routed?.profile && !flat(routed, 'taskType') ? P.id : 'fallback', confidence: profile.taskTypeConfidence, model: routed?.model }, { label: profile.taskType })

    // Skill selection rides the same features and the same teacher answer. Skill is HOW the work
    // is done, not WHO does it, so it never touches the candidate pool: it is handed to the router
    // in the plan (plan.skill) for the worker's instructions. Whoever the domain made authoritative
    // decides it, Jev included: when the task type came from a mature local classifier and the
    // skill domain still asks Jev, Jev's skill is the one the run uses, not a copy of the task type.
    const skillCtl = controller('skill_selection')
    let skillAuthority = profile.heuristic ? 'fallback' : 'profile'
    let skillDecision = null
    if (skillCtl) {
      const d = await skillCtl.decide({
        features: textFeatures,
        // A skill too flat to use is no skill in the profile, and still an answer the domain hears.
        jev: decider ? async () => { const r = await askJev('task'); return r.profile?.skills || flat(r, 'skill') ? { label: r.profile?.skills?.primary, probabilities: {}, confidence: r.profile?.skillConfidence ?? 0.5, model: r.model, raw: { supporting: r.profile?.skills?.supporting ?? [] }, ...marks(r, 'skill') } : null } : null,
        fallback: () => ({ label: resolveSkills(profile.skills, profile.taskType).primary, probabilities: {}, confidence: 0.3 }),
      })
      if (d?.label) {
        const supporting = d.authority === P.id ? rawOf(d)?.supporting ?? profile.skills?.supporting : profile.skills?.supporting
        profile = { ...profile, skills: { primary: d.label, supporting: supporting ?? [] } }
        skillAuthority = d.authority
      }
      skillDecision = d
    }
    // What the worker is told is always a SKILLS entry. When the answer was outside that
    // vocabulary (a task type such as `refactor` offered as a skill), the skill the run uses is
    // the task type's own, chosen by the deterministic rule, so that is the authority reported,
    // and the label shown is the skill that really rides the plan, with the raw answer beside it.
    const rawSkill = profile.skills?.primary
    profile = { ...profile, skills: resolveSkills(profile.skills, profile.taskType) }
    const skillMappedFrom = rawSkill !== profile.skills.primary ? rawSkill ?? null : undefined
    if (skillMappedFrom !== undefined) skillAuthority = 'fallback'
    if (skillCtl) {
      // A mapped answer is not what the run used, so the run cannot confirm it: labelling it
      // would teach the skill domain an off-vocabulary label from runs that used another skill.
      // The sample stays teacher-only, as the resource pick does when conservation moves it.
      if (skillDecision?.sampleId && skillMappedFrom === undefined) samples.push({ domain: 'skill_selection', id: skillDecision.sampleId, store: storeKind })
      domainReport.skill_selection = {
        ...report(skillDecision, { label: profile.skills.primary }),
        label: profile.skills.primary,
        ...(skillMappedFrom !== undefined ? { authority: 'fallback', decidedBy: skillDecision?.authority ?? 'none', mappedFrom: skillMappedFrom } : {}),
      }
    }

    // --- 2. hard facts that need the profile ----------------------------------------------------
    const need = contextEstimate(task, handoff)
    const namedWork = typeof profile.capability === 'string' && !NOT_WORK_CAPABILITIES.has(profile.capability) ? profile.capability : null
    const canDoNamed = namedWork && typeof capableFor === 'function' ? capableFor(namedWork) : null
    pool = pool.map((c) => build(agents.find((a) => a.id === c.id), profile.taskType)).map((c) => ({ ...c, key: names.keyOf(c.id) }))
    const kept = []
    for (const c of pool) {
      if (typeof c.contextTokens === 'number' && c.contextTokens < need) { excluded.push({ id: c.id, reason: `context window ${c.contextTokens} tokens is under the ${need} this request needs`, hard: true }); continue }
      // The capability the task profile names is a hard fact too, and it is applied here, before
      // the resource and strategy judgments, not only re-checked by the router afterwards: a
      // resource that cannot do it (a local model with no network, asked to look something up) is
      // not a candidate to be weighed, and must not be picked as a parallel answerer either.
      if (canDoNamed && !canDoNamed.has(c.id)) { excluded.push({ id: c.id, reason: `cannot do what this request needs (${profile.capability})`, hard: true }); continue }
      const t = candidateTier(c.capabilities, profile.requirements, pol)
      c.tier = t.tier; c.tierScore = t.score
      c.fit = candidateFeatures(profile, c).numeric.fit
      kept.push(c)
    }
    const minimum = profile.minimumCapability ?? 'standard'
    const floorOk = kept.filter((c) => c.tier === 'unknown' || tierAtLeast(c.tier, minimum))
    let belowFloor = false
    if (floorOk.length) { for (const c of kept) if (!floorOk.includes(c)) excluded.push({ id: c.id, reason: `capability tier ${c.tier} is under the ${minimum} floor this task needs` }); pool = floorOk }
    else { pool = kept; belowFloor = true }
    // The subscription gate is a hard policy the operator set (router.js enforces it on the pick),
    // with one exception decided here in code: a task that needs frontier capability which no
    // ungated resource has keeps the gated frontier resource for the work. Otherwise a gated
    // resource is not a candidate for the work at all; it stays available to review.
    const gatedSet = new Set(gated ?? [])
    let gateOverride = false
    if (gatedSet.size && pool.some((c) => gatedSet.has(c.id))) {
      const ungated = pool.filter((c) => !gatedSet.has(c.id))
      const ungatedFrontier = ungated.some((c) => tierAtLeast(c.tier, 'frontier'))
      if (minimum === 'frontier' && !ungatedFrontier && pool.some((c) => gatedSet.has(c.id) && tierAtLeast(c.tier, 'frontier'))) {
        gateOverride = true
        // Only the gated frontier resource is kept for the work; any other gated one is past its
        // gate like always, and the record says so (the review call tells Jev why each resource
        // is outside the work table, and an unrecorded one could only be guessed at).
        for (const c of pool) if (gatedSet.has(c.id) && !tierAtLeast(c.tier, 'frontier')) excluded.push({ id: c.id, reason: 'past its weekly gate: kept for review only' })
        pool = pool.filter((c) => !gatedSet.has(c.id) || tierAtLeast(c.tier, 'frontier'))
      } else if (ungated.length) {
        for (const c of pool) if (gatedSet.has(c.id)) excluded.push({ id: c.id, reason: 'past its weekly gate: kept for review only' })
        pool = ungated
      }
    }
    if (!pool.length) throw noCandidates(`no resource can take this request: ${excluded.map((e) => `${e.id} (${e.reason})`).join(', ')}`, excluded)
    for (const c of pool) {
      const snap = snapById.get(c.id)
      c.expectedCost = expectedJobCost({ snapshot: snap, candidate: c, profile, policy })
    }
    // Who may review is wider than who may do the work (see reviewPool below), and the plan is
    // built over both, so the strategies it may choose from are too. The same call is made again
    // if conservation moves the work, so the two paths can never disagree about what is eligible.
    const strategiesFor = (work) => eligibleStrategies({ candidates: work, reviewCandidates: kept.length ? kept : work, profile, answerOnly })
    strategies = strategiesFor(pool)
    // The tier of every resource that cleared the hard facts, for the samples of the domains that
    // are labelled by what the run did rather than by who it picked (the strategy and the yes/no
    // judgments). Without it the training rule that recognises a stronger resource rescuing the
    // run has nothing to compare, and can never fire. Ids, keys and tier names only.
    const tierTable = kept.map((c) => ({ id: c.id, key: c.key, tier: c.tier }))
    const poolStats = { size: pool.length, bestFit: Math.max(...pool.map((c) => c.fit)), cheapestFit: (cheapestOf(pool, { minimumTier: minimum })?.fit) ?? 0 }
    const candidateRows = pool.map((c) => ({ key: c.key, id: c.id, features: candidateFeatures(profile, c, poolStats) }))
    let pFeatures = mergeFeatures(profileFeatures(profile), poolFeatures(profile, pool))

    // --- 3. resource selection -------------------------------------------------------------------
    const idOf = (key) => pool.find((c) => c.key === key)?.id
    // Who does the work is ranked in code (broker.js), not asked of Jev: the pick weighs capability
    // against expected cost against scarcity, and weighing numbers against each other is the one
    // thing a snap-judgment classifier cannot do. The ranking is this domain's authority, so it is
    // reported as `code` and never as `fallback`, which means the opposite: nobody could decide.
    const ranking = rankCandidates({ candidates: pool, profile, policy: pol })
    const pick = { key: ranking.chosenKey, probabilities: ranking.probabilities, confidence: ranking.confidence }
    // The ranking decides at every rung of this domain's ladder, by the owner's decision, and the
    // local classifier never outranks it. The domain has no teacher, so its classifier learns only
    // from the runs that contradict the ranking (a rescue, a failure, a person's `good pick` tag):
    // whatever rung it climbs to, it climbed on a diet of failures, and a classifier matured on
    // that must not overrule arithmetic that is right. The controller still runs, so every pick is
    // a sample and the classifier's own answer is recorded beside the ranking's for comparison (on
    // the sample, and as `local` in the decision report), but it never decides the pick. The pick
    // is taken from the ranking here, not from the controller's answer, so nothing a controller
    // returns can move it.
    const resCtl = controller('resource_selection')
    const resDecision = resCtl ? await resCtl.decide({
      features: pFeatures,
      candidates: candidateRows,
      jev: null,
      // The controller speaks `chosenKey`, the contract's ranking shape; this file works in `key`.
      fallback: () => ({ chosenKey: pick.key, probabilities: pick.probabilities, confidence: pick.confidence }),
      codeAuthority: true,
      // The domain says so itself (`localDecides: false` in routing-policy.js DOMAINS), which is
      // what the Router tab reads; saying it here as well keeps the controller's record honest
      // under a registry built from any policy.
      localMayDecide: false,
    }) : null
    domainReport.resource_selection = report(resDecision ?? { authority: 'code', chosenKey: pick.key, confidence: pick.confidence }, { label: pick.key })

    // One yes/no judgment. With its domain controller wired the controller decides who answers;
    // without one (a fresh install, or a caller that passed no registry) the batched Jev answer is
    // read directly, and with no Jev either the deterministic rule stands in. The shape is the
    // same on all three paths, so nothing downstream has to know which one answered. The sample
    // is left teacher-only here: the caller pushes it for outcome labelling itself, once it knows
    // whether the answer changed anything the run could test.
    // `rule` answers the judgment in code with a probability of yes. Where the domain says a rule
    // in code teaches it (`teacher: 'code'` in routing-policy.js DOMAINS) the rule is the authority
    // and no teacher is asked, exactly as the resource ranking is, for a judgment that is a
    // comparison of numbers rather than a snap judgment. Otherwise the rule is only the
    // deterministic fallback for when nobody else answers, and says so at half confidence.
    // A provider's P(true) is read at its own `judgmentYes`; the rule's own outputs (0, 1, or the
    // codeJudgments cuts) keep 0.5 whoever decides, since that is what their stored label means.
    const judgment = async (domain, key, rule) => {
      const code = DOMAINS[domain]?.teacher === 'code'
      const asJudgment = (p, authority, model, cut = 0.5) => ({ label: p >= cut ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p }, confidence: Math.max(p, 1 - p), authority, model })
      const fallback = () => {
        const p = rule()
        return code ? asJudgment(p) : { label: p >= 0.5 ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p }, confidence: 0.5, authority: 'fallback' }
      }
      const ctl = controller(domain)
      let d
      if (ctl) {
        d = await ctl.decide({
          features: pFeatures,
          jev: decider && !code ? async () => { const r = await askJev('judgments'); const p = r[key]; return typeof p === 'number' ? { label: p >= pol.judgmentYes ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p }, confidence: Math.max(p, 1 - p), model: r.model, ...marks(r, key) } : null } : null,
          fallback,
          codeAuthority: code,
          context: { extra: { candidates: tierTable } },
        })
      } else if (code) {
        d = { ...asJudgment(rule()), authority: 'code' }
      } else if (decider) {
        try {
          const r = await askJev('judgments')
          d = typeof r[key] === 'number' && !flat(r, key) ? asJudgment(r[key], P.id, r.model, pol.judgmentYes) : fallback()
        } catch (err) {
          if (signal?.aborted) throw err
          d = fallback()
        }
      } else d = fallback()
      domainReport[domain] = report(d, { label: d?.label })
      return d
    }
    const yes = (d) => (d ? d.label === 'yes' : false)
    const prob = (d) => (d ? d.probabilities?.yes ?? (d.label === 'yes' ? 1 : 0) : undefined)
    const risk = profile.risk ?? 0.5

    // --- 4. conservation ------------------------------------------------------------------------
    // A hard limit, beside the weekly gate and the capability floor: when the most capable
    // candidate's allowance is being used up and this task is easy enough to do elsewhere, that
    // resource leaves the work pool and stays available to review. The governor only prices
    // scarcity (it is a signal, never a rule); this is what acts on it. It comes after the resource
    // pick and before the strategy, because it can change who works, and the strategy must be
    // planned around whoever really does it.
    //
    // The ranking already declines to spend a pressing allowance on work a cheaper candidate
    // covers, so by the time this runs the work has often moved of its own accord. What is left is
    // to make that stick: taking the resource out of the pool is what stops a mid-run hand-over
    // from spending the very capacity the ranking just kept back, and it is still there to review.
    // Nothing in it is a judgment, so no domain answers it and no run labels it.
    //
    // Every condition is a fact. A local model has nothing to conserve, nor does a resource with no
    // marginal cost, nor one the governor calls healthy: under its plan's first knee, sparing an
    // allowance that is barely touched is not conservation but a second-best pick, and unknown
    // usage argues for nothing either way. The work must be easy enough to move off, by the task's
    // own complexity and its risk against the review cut the policy already sets, because hard or
    // risky work is what the capacity is kept for. And the work moves only to a candidate whose
    // KNOWN tier meets the floor, because moving it off a resource known to be capable onto one
    // nobody has measured is a gamble, not a saving. That one rule also covers an unmet floor and a
    // gate that yielded to a frontier floor: in both, nothing else has a known tier at the floor,
    // so the scarce resource keeps the work it alone can do.
    let primary = pool.find((c) => c.id === idOf(pick.key))
    const mostCapable = strongestOf(pool)
    const hint = conservationHint(signals.get(mostCapable?.id) ?? {}, profile, policy)
    const canConserve = !!mostCapable && mostCapable.source !== 'local' && mostCapable.marginalCost !== 'none' && hint.level !== 'healthy'
    const easyEnoughToMoveOff = (profile.complexity ?? 0.5) < pol.easyComplexity && risk < pol.minimumReview.riskForReview
    const ranked = pick.probabilities ?? {}
    const costOf = (c) => (typeof c.expectedCost?.total === 'number' ? c.expectedCost.total : 0.5)
    // Who does the work once the scarce one is out. When the ranking already chose somebody else
    // that is the answer; otherwise the best of the rest by the ranking, then the cheaper.
    const known = (c) => c.id !== mostCapable.id && c.tier !== 'unknown' && tierAtLeast(c.tier, minimum)
    const target = !canConserve || !easyEnoughToMoveOff ? null
      : known(primary) ? primary
        : pool.filter(known).sort((a, b) => (ranked[b.key] ?? 0) - (ranked[a.key] ?? 0) || costOf(a) - costOf(b) || String(a.id).localeCompare(String(b.id)))[0] ?? null
    let conserved = null
    if (target) {
      // A limit has no probability behind it that could have come out the other way, so it is
      // recorded as certain, and as code's: nothing else decided it.
      conserved = { from: mostCapable.id, to: target.id, confidence: 1, authority: 'code' }
      excluded.push({ id: mostCapable.id, reason: 'conserved for harder work: kept for review only' })
      pool = pool.filter((c) => c.id !== mostCapable.id)
      primary = target
      // What the strategy and the remaining judgments see is the pool the work really has.
      strategies = strategiesFor(pool)
      pFeatures = mergeFeatures(profileFeatures(profile), poolFeatures(profile, pool))
    }
    // The pick is still the pick unless conservation took the work off it: a run that conserved a
    // resource the ranking had already passed over tests exactly the resource the ranking chose.
    const pickMoved = primary.id !== idOf(pick.key)
    if (resDecision?.sampleId && !pickMoved) samples.push({ domain: 'resource_selection', id: resDecision.sampleId, store: storeKind })
    if (pickMoved) domainReport.resource_selection = { ...domainReport.resource_selection, movedBy: 'conservation' }

    // --- 5. strategy and the remaining judgments ------------------------------------------------
    const stratCtl = controller('execution_strategy')
    const strategyFallback = () => {
      const risk = profile.risk ?? 0.5
      const cheapish = primary.marginalCost !== 'low' || primary.tier === 'standard' || primary.tier === 'weak'
      const label = risk >= pol.minimumReview.riskForFrontierReview && cheapish && strategies.includes('CHEAP_EXECUTE_FRONTIER_REVIEW') ? 'CHEAP_EXECUTE_FRONTIER_REVIEW'
        : primary.source === 'local' && strategies.includes('LOCAL_FIRST') ? 'LOCAL_FIRST'
          : primary.tier === 'frontier' ? 'PREMIUM_DIRECT' : cheapish && strategies.includes('CHEAP_DIRECT') ? 'CHEAP_DIRECT' : 'STANDARD_DIRECT'
      return { label, probabilities: { [label]: 1 }, confidence: 0.5 }
    }
    let strategyPick = null
    const stratDecision = stratCtl ? await stratCtl.decide({
      features: pFeatures,
      // One eligible strategy is nothing to choose between, and it is now the only question the
      // resource call carries: asking would buy a call whose answer is already known.
      jev: decider && strategies.length > 1 ? async () => { const r = await askJev('resource'); return r.strategy?.choice ? { label: r.strategy.choice, probabilities: r.strategy.probabilities ?? {}, confidence: r.strategy.confidence ?? 0.5, model: r.model, ...marks(r, 'strategy') } : null } : null,
      fallback: strategyFallback,
      context: { allowed: strategies, extra: { candidates: tierTable } },
    }) : null
    if (stratDecision?.label) {
      const label = strategies.includes(stratDecision.label) ? stratDecision.label
        : Object.entries(stratDecision.probabilities ?? {}).filter(([k]) => strategies.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? strategyFallback().label
      strategyPick = { label, confidence: stratDecision.confidence, authority: stratDecision.authority, restricted: label !== stratDecision.label }
    } else if (!stratCtl && decider && strategies.length > 1) {
      try {
        const r = await askJev('resource')
        strategyPick = r.strategy?.choice && strategies.includes(r.strategy.choice) && !flat(r, 'strategy') ? { label: r.strategy.choice, confidence: r.strategy.confidence, authority: P.id } : { ...strategyFallback(), authority: 'fallback' }
      } catch (err) {
        if (signal?.aborted) throw err
        strategyPick = { ...strategyFallback(), authority: 'fallback' }
      }
    } else strategyPick = { ...strategyFallback(), authority: 'fallback' }
    domainReport.execution_strategy = report(stratDecision ?? { authority: strategyPick.authority, confidence: strategyPick.confidence }, { label: strategyPick.label })

    // Both are labelled below, and only where their answer could change the run (see there).
    const secondOpinion = await judgment('second_opinion', 'secondOpinion', () => (risk >= pol.minimumReview.riskForReview ? 1 : 0))
    // Answered in code for the same reason: it read the task's risk against a threshold, and a
    // threshold is arithmetic. Risky work gets the strongest reviewer; work that is merely risky
    // enough to review gets one too when what it needs is frontier capability, which is where a
    // subtle mistake is least likely to be caught by the checks alone.
    const frontierProbability = () => {
      const cuts = policy.codeJudgments.frontierReview
      if (risk >= pol.minimumReview.riskForFrontierReview) return cuts.risky
      const wantsFrontier = profile.minimumCapability === 'frontier' || profile.preferredCapability === 'frontier' || (profile.requirements?.security_review ?? 0) >= pol.requirementWanted
      return risk >= pol.minimumReview.riskForReview && wantsFrontier ? cuts.frontierWork : cuts.otherwise
    }
    const frontier = await judgment('frontier_escalation', 'frontierReview', frontierProbability)

    // --- 6. the plan and the routing object -----------------------------------------------------
    // Who may judge: everything that cleared the hard facts, not only what cleared the capability
    // floor and the weekly gate. A gated subscription is kept for review by design, and a strong
    // resource that missed a frontier floor still reads a diff better than nobody.
    const reviewPool = kept.length ? kept : pool
    const plan = planStrategy({ strategy: strategyPick.label, primaryId: primary.id, candidates: pool, reviewCandidates: reviewPool, profile, answerOnly })
    // The strategy domain is labelled by the run only when the run carries out ITS answer. A label
    // mapped to another because it was not eligible (after conservation, say), or one the broker
    // could not build with these candidates, would have the run confirm a strategy it never tried
    // - the same guard the resource and skill samples already have.
    if (stratDecision?.sampleId && plan.strategy === stratDecision.label) samples.push({ domain: 'execution_strategy', id: stratDecision.sampleId, store: storeKind })
    // The skill rides the plan because the plan is what the loop runs: the router writes it into
    // the instructions of every step that does the work (see router.js basePrompt).
    plan.skill = { ...profile.skills, description: SKILLS[profile.skills.primary], authority: skillAuthority, ...(skillMappedFrom !== undefined ? { mappedFrom: skillMappedFrom } : {}) }
    if (conserved) plan.notes.push(`${conserved.from} conserved for harder work: ${conserved.to} does it, ${conserved.from} stays available to review`)
    // The same rule as the strategy: a judgment is labelled by the run only when its answer could
    // have changed the run, or an accepted run confirms a 'yes' that never happened (and a failed
    // one refutes it). A frontier review changes the run only when the plan did not already have
    // one, the floor does not add one anyway, a reviewer exists, and the run reviews at all: an
    // answer-only run never does.
    const strongestReviewer = strongestOf(reviewPool, { except: [primary.id] })
    const frontierCouldAct = !answerOnly && !plan.frontierReview && !belowFloor && !!strongestReviewer
    if (yes(frontier) && frontierCouldAct) { plan.reviewer = strongestReviewer.id; plan.forceReview = true; plan.frontierReview = true; plan.notes.push('frontier review added by the frontier-escalation domain') }
    if (frontier?.sampleId && frontierCouldAct) samples.push({ domain: 'frontier_escalation', id: frontier.sampleId, store: storeKind })
    if (belowFloor) {
      if (strongestReviewer) { plan.reviewer = strongestReviewer.id; plan.forceReview = true; plan.frontierReview = true }
      plan.notes.push(`no candidate meets the ${minimum} floor; the strongest available reviews`)
    }
    // A second opinion is asked for only of accepted work that no review has seen (jev-review), so
    // a plan that already promises a review, or an answer-only run, which is never reviewed, gets
    // the same run whatever the answer was.
    if (secondOpinion?.sampleId && !answerOnly && !plan.forceReview) samples.push({ domain: 'second_opinion', id: secondOpinion.sampleId, store: storeKind })
    // One row per resource as the review call and the inspector read it: the numbers the choice
    // was made over, and never a name beyond the id the router maps back from.
    const rowOf = (c) => ({
      id: c.id, key: c.key, source: c.source, tier: c.tier, fit: r2(c.fit), scarcity: r2(c.scarcity), scarcityConfidence: r2(c.scarcityConfidence),
      resetInMinutes: c.resetInMinutes == null ? null : Math.round(c.resetInMinutes), marginalCost: c.marginalCost, expectedCost: c.expectedCost ? { total: r2(c.expectedCost.total), class: c.expectedCost.class } : null,
      latency: c.latency, availability: c.availability, cold: c.cold, evidenceSamples: c.evidenceSamples, plan: c.plan,
      capabilities: Object.fromEntries(Object.entries(c.capabilities).filter(([d]) => (profile.requirements?.[d] ?? 0) >= pol.requirementWanted || d === 'reliability').map(([d, v]) => [d, { score: r2(v.score), confidence: r2(v.confidence), samples: v.samples }])),
    })
    const agentProbabilities = Object.fromEntries(Object.entries(pick.probabilities ?? {}).map(([k, p]) => [idOf(k), p]).filter(([id]) => id))
    for (const c of pool) if (agentProbabilities[c.id] === undefined) agentProbabilities[c.id] = 0
    const routing = {
      model: routed?.model ?? jevCalls[0]?.model,
      primaryAgent: primary.id,
      // When conservation moved the work, the pick's confidence was about the resource it moved
      // away from; what put this primary here is the conservation limit, which is certain. Read as
      // the ranking's doubt instead, it could send the router's low-confidence tie-break after it.
      agentConfidence: pickMoved ? conserved.confidence : pick.confidence,
      ...(conserved ? { conservedFrom: conserved.from } : {}),
      agentProbabilities,
      capability: profile.capability,
      capabilityConfidence: profile.capabilityConfidence,
      taskType: profile.taskType,
      taskTypeConfidence: profile.taskTypeConfidence,
      complexity: profile.complexity,
      risk: profile.risk,
      needsSecondOpinion: secondOpinion ? prob(secondOpinion) : profile.needsSecondOpinion,
      needsHumanReview: profile.needsHumanReview,
      needsTests: profile.needsTests,
      continueHandoff: profile.continueHandoff,
      handler: routed?.handler ?? 'agent',
      handlerConfidence: routed?.handlerConfidence,
      toolFits: routed?.toolFits,
      toolArgConfidence: routed?.toolArgConfidence,
      toolArgs: routed?.toolArgs,
      strategy: plan.strategy,
      profile,
      decision: {
        candidates: pool.map(rowOf),
        // What cleared the hard facts but is not doing the work (past its weekly gate, under the
        // capability floor, conserved): it can still review, and the review call weighs it on the
        // same numbers as the work table, not on a bare "not a candidate".
        reviewOnly: kept.filter((c) => !pool.includes(c)).map(rowOf),
        excluded,
        belowFloor,
        gateOverride,
        conservation: conserved,
        minimumCapability: minimum,
        strategies,
        plan: { ...plan, notes: plan.notes },
        domains: domainReport,
        judgments: { secondOpinion: prob(secondOpinion), frontierReview: prob(frontier) },
        jevCalls: jevCalls.length,
        // Who decided, so every line that counts `jevCalls` names the provider that was called.
        decider: P.id,
        // With the store each is in, so a verdict given later relabels it where it is.
        samples: samples.map(({ domain, id, store }) => ({ domain, id, store })),
      },
    }
    emit?.('decision', { at: now(), decision: routing.decision, profile: profileNumbers(profile), taskType: profile.taskType, strategy: plan.strategy, primary: primary.id })
    return { routing, profile, candidates: pool, excluded, plan, domains: domainReport, samples, jevCalls }
  }

  return { decide, classProfiles: classProfilesFor }
}

/** The per-domain line the inspector shows: who decided, at what maturity, how sure, and why. */
function report(d, { label } = {}) {
  if (!d) return { authority: 'none', label }
  return {
    authority: d.authority,
    maturity: d.maturity,
    label: d.label ?? d.chosenKey ?? label,
    confidence: r2(d.confidence),
    requiredConfidence: r2(d.requiredConfidence),
    ood: d.ood ?? null,
    reason: d.reason,
    jevCalled: !!d.jevCalled,
    teacher: d.teacher ? { label: d.teacher.label ?? d.teacher.chosenKey, confidence: r2(d.teacher.confidence) } : null,
    // What another provider said, whether or not it decided (an answer too flat to act on).
    ...(d.provider ? { provider: { label: d.provider.label ?? d.provider.chosenKey, confidence: r2(d.provider.confidence), informative: d.provider.informative !== false } } : {}),
    local: d.local ? { label: d.local.label ?? d.local.chosenKey, confidence: r2(d.local.confidence), ood: d.local.ood } : null,
    sampleId: d.sampleId ?? null,
  }
}

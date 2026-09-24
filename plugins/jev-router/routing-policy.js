// Every number the adaptive router is allowed to reason with, in one place.
//
// Promotion gates, calibration ceilings, drift thresholds, rollback floors, evidence weights,
// conservation curves and capability tiers used to be the kind of thing that ends up scattered
// through routing code as magic numbers. Here they are one object, keyed by routing-domain risk
// class where the requirement differs by risk, and `resolvePolicy` layers the plugin config over
// them so an operator can change any of them without touching code. Nothing else in the plugin
// may define a threshold of its own: a module that needs one reads it from the policy it is
// handed.
//
// Names are deliberately plain. A gate is "how many samples", "how accurate", "how well
// calibrated"; a risk class is LOW, MEDIUM or HIGH; a maturity state is one of the five in
// MATURITY. The words match the design document (docs/adaptive-routing.md), so a number here can
// be found there and the other way round.

export const MATURITY = Object.freeze(['JEV_PRIMARY', 'SHADOW', 'GUARDED_LOCAL', 'LOCAL_ONLY', 'ROLLBACK'])
export const RISK_CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH'])

/**
 * The routing domains, each maturing on its own. `kind` says what its local classifier predicts.
 * Quota conservation is not one: whether the most capable resource leaves the work pool is a hard
 * limit in decision.js, read off the governor's level, and there is nothing in it to learn.
 *
 * `localDecides: false` says the domain's local classifier never decides, at any rung: it still
 * climbs the ladder and its answer is recorded beside the one that decided, for comparison, but
 * the rung buys it nothing. Resource selection is the one, by the owner's decision: it has no
 * teacher, so its classifier learns only from the runs that contradict the ranking, and one that
 * matured on a diet of failures must not overrule arithmetic that is right (decision.js takes the
 * pick from rankCandidates() at every rung). The controller and the Router tab both read it here.
 *
 * `teacher: 'code'` says a rule in code is the domain's authority and no teacher is ever asked:
 * each of these is a comparison of numbers, which a snap-judgment classifier cannot make. The
 * rule decides wherever the local classifier does not, so the rungs where Jev would decide
 * elsewhere are the rule's here. Without it the teacher is Jev.
 */
export const DOMAINS = Object.freeze({
  task_classification: { risk: 'LOW', kind: 'multiclass', label: 'task classification' },
  skill_selection: { risk: 'LOW', kind: 'multiclass', label: 'skill selection' },
  resource_selection: { risk: 'MEDIUM', kind: 'ranking', label: 'resource selection', localDecides: false, teacher: 'code' },
  execution_strategy: { risk: 'MEDIUM', kind: 'multiclass', label: 'execution strategy' },
  second_opinion: { risk: 'MEDIUM', kind: 'multiclass', label: 'second opinion' },
  frontier_escalation: { risk: 'HIGH', kind: 'multiclass', label: 'frontier escalation', teacher: 'code' },
  outcome_disposition: { risk: 'HIGH', kind: 'multiclass', label: 'outcome disposition' },
})

/** Execution strategies the router may choose. Eligibility is decided in code (broker.js). */
export const STRATEGIES = Object.freeze({
  CHEAP_DIRECT: 'The cheapest eligible resource does the work directly, with the usual checks and review',
  STANDARD_DIRECT: 'A mid-tier eligible resource does the work directly',
  PREMIUM_DIRECT: 'The strongest eligible resource does the work directly',
  LOCAL_FIRST: 'A local model on this PC does the work first; a stronger resource takes over if it fails',
  CHEAP_THEN_PREMIUM_REVIEW: 'A cheap resource does the work and a stronger resource reviews it before acceptance',
  PREMIUM_PLAN_CHEAP_EXECUTE: 'The strongest resource writes a plan, a cheaper resource implements it, checks run, and the strongest resource reviews',
  CHEAP_EXECUTE_FRONTIER_REVIEW: 'A cheap resource does the work; the strongest available resource must review before acceptance',
  PARALLEL_SECOND_OPINION: 'Two resources answer independently and the answers are compared (read-only work only)',
  RETRY_DIFFERENT_RESOURCE: 'After a failure, retry on a different resource',
  FRONTIER_ESCALATION: 'Escalate the work to the strongest available resource',
  HUMAN_ESCALATION: 'Stop and hand the decision to a person',
})

/** Outcome dispositions the review can reach. Deterministic failures always force RETRY or HUMAN. */
export const DISPOSITIONS = Object.freeze(['PASS', 'RETRY_SAME_TIER', 'RETRY_DIFFERENT_RESOURCE', 'SECOND_OPINION', 'FRONTIER_REVIEW', 'WRONG', 'HUMAN'])

/** Capability dimensions a task can require and a resource can be good at. Extensible by config. */
export const DIMENSIONS = Object.freeze([
  'general_reasoning', 'architecture', 'system_design', 'planning', 'explanation', 'coding', 'code_review',
  'security_review', 'debugging', 'frontend', 'backend', 'database', 'testing', 'tool_use', 'long_context',
  'vision', 'instruction_following', 'reliability', 'first_pass_quality',
])

/** The dimensions a task profile scores. A subset of DIMENSIONS, asked of Jev one Score each. */
export const REQUIREMENT_DIMENSIONS = Object.freeze([
  'general_reasoning', 'architecture', 'planning', 'explanation', 'coding', 'debugging', 'security_review',
  'code_review', 'testing', 'long_context',
])

/** Skills describe HOW work is done; resources describe WHO does it. One primary, a few supporting. */
export const SKILLS = Object.freeze({
  debugging: 'Finding the cause of incorrect behaviour and fixing it',
  implementation: 'Writing new code to a known requirement',
  refactoring: 'Restructuring code without changing behaviour',
  architecture: 'Designing structure, data flow and boundaries',
  explanation: 'Explaining how something works or why a choice was made',
  review: 'Reading code or a diff and reporting problems',
  security: 'Authentication, authorization, secrets, vulnerabilities',
  testing: 'Writing or repairing tests',
  frontend: 'User interface code, layout, browser behaviour',
  backend: 'Services, APIs, background jobs',
  database: 'Schemas, queries, migrations, data integrity',
  performance: 'Speed, memory and resource usage',
  documentation: 'Docs, comments, READMEs',
  devops: 'Build, packaging, deployment, environments',
})

/** Which capability dimensions a task type exercises, for turning run outcomes into evidence. */
export const TASK_DIMENSIONS = Object.freeze({
  architecture: ['architecture', 'system_design', 'planning', 'explanation'],
  implementation: ['coding', 'first_pass_quality', 'instruction_following'],
  debugging: ['debugging', 'coding', 'general_reasoning'],
  review: ['code_review', 'security_review'],
  refactor: ['coding', 'long_context', 'reliability'],
  testing: ['testing', 'coding'],
  documentation: ['explanation', 'instruction_following'],
  investigation: ['general_reasoning', 'explanation', 'long_context'],
  security: ['security_review', 'code_review'],
  performance: ['debugging', 'general_reasoning'],
  simple_change: ['instruction_following', 'reliability'],
  other: ['general_reasoning'],
})

/**
 * The skill a task type calls for when nothing better is known. Task types and skills are two
 * vocabularies (a task is a `refactor`, the discipline is `refactoring`), and a skill that is not
 * one of SKILLS names no way of working, so the fallback maps rather than copies.
 */
export const TASK_SKILLS = Object.freeze({
  architecture: 'architecture', implementation: 'implementation', debugging: 'debugging', review: 'review',
  refactor: 'refactoring', testing: 'testing', documentation: 'documentation', investigation: 'explanation',
  security: 'security', performance: 'performance', simple_change: 'implementation', other: 'implementation',
})

/** Task types that share enough for evidence on one to say something about the other. */
export const RELATED_TASK_TYPES = Object.freeze({
  implementation: ['refactor', 'testing', 'simple_change'],
  refactor: ['implementation', 'simple_change'],
  debugging: ['performance', 'investigation'],
  review: ['security'],
  security: ['review'],
  architecture: ['investigation', 'documentation'],
  investigation: ['architecture', 'debugging'],
  testing: ['implementation'],
  documentation: ['architecture'],
  performance: ['debugging'],
  simple_change: ['implementation', 'refactor'],
})

const gate = (o) => Object.freeze(o)

/**
 * The defaults. `resolvePolicy(overrides)` deep-merges a config object over this and validates
 * the result; everything downstream reads the merged object and never this one directly, so a
 * per-install change reaches every consumer.
 */
export const ROUTING_DEFAULTS = Object.freeze({
  domains: DOMAINS,
  // Promotion gates by risk class. Sample counts are VERIFIED samples: a Jev call with no outcome
  // evidence does not count. The recent window is how many of the newest verified decisions the
  // recent-accuracy and rollback checks read.
  gates: Object.freeze({
    LOW: gate({
      shadowSamples: 250, guardedSamples: 750, localOnlySamples: 1500,
      perClassSamples: 100, holdoutSamples: 300, recentWindow: 300,
      guarded: { accuracy: 0.94, recentAccuracy: 0.94, macroF1: 0.92, maxEce: 0.06 },
      localOnly: { accuracy: 0.96, recentAccuracy: 0.95, macroF1: 0.95, maxEce: 0.04 },
      maxHighConfidenceError: 0.01, confidenceThreshold: 0.90,
      minOutcomeBacked: 0.60, maxTeacherOnly: 0.40,
      rollback: { recentAccuracyFloor: 0.93, maxEce: 0.07, repromoteSamples: 250 },
    }),
    MEDIUM: gate({
      shadowSamples: 500, guardedSamples: 1500, localOnlySamples: 3000,
      perClassSamples: 200, holdoutSamples: 600, recentWindow: 500,
      guarded: { accuracy: 0.96, recentAccuracy: 0.96, macroF1: 0.95, maxEce: 0.04 },
      localOnly: { accuracy: 0.98, recentAccuracy: 0.97, macroF1: 0.97, maxEce: 0.03 },
      maxHighConfidenceError: 0.005, confidenceThreshold: 0.95,
      minOutcomeBacked: 0.70, maxTeacherOnly: 0.30,
      rollback: { recentAccuracyFloor: 0.95, maxEce: 0.05, repromoteSamples: 500 },
    }),
    HIGH: gate({
      shadowSamples: 1000, guardedSamples: 3000, localOnlySamples: 6000,
      perClassSamples: 400, holdoutSamples: 1200, recentWindow: 1000,
      guarded: { accuracy: 0.98, recentAccuracy: 0.98, macroF1: 0.97, maxEce: 0.025 },
      localOnly: { accuracy: 0.99, recentAccuracy: 0.985, macroF1: 0.985, maxEce: 0.02 },
      maxHighConfidenceError: 0.002, confidenceThreshold: 0.985,
      minOutcomeBacked: 0.80, maxTeacherOnly: 0.20,
      rollback: { recentAccuracyFloor: 0.98, maxEce: 0.03, repromoteSamples: 1000 },
    }),
  }),
  // A prediction counts as "high confidence" for the high-confidence-error metric at or above this.
  highConfidence: 0.9,
  // Rare but important classes must each keep this recall before a domain leaves SHADOW. This is
  // the default for every risk class; `gates.<RISK>.minClassRecall` overrides it for one class, so
  // the recall floor can scale with risk the way every other quality number does. resolvePolicy
  // writes the value in force into each gate block, so a domain reads it from its own gates.
  minClassRecall: 0.85,
  // A significant class is one that carries at least this share of the verified samples.
  significantClassShare: 0.05,
  drift: Object.freeze({
    psiWarn: 0.10, psiDrift: 0.20,
    jsWarn: 0.10, jsDrift: 0.20,
    // Unexpected out-of-distribution rate in the recent window that degrades LOCAL_ONLY.
    oodRateDegrade: 0.10,
    // A retry, repair, escalation or deterministic-failure rate this many times the domain's
    // historical baseline is a regression even when classification accuracy still looks fine.
    rateIncreaseFactor: 1.5,
    // Bins used for the histograms behind PSI and JS divergence.
    bins: 10,
  }),
  rollback: Object.freeze({
    // Smaller breaches need this many consecutive evaluation windows; a severe breach needs one.
    consecutiveWindows: 2,
    minorTo: 'GUARDED_LOCAL', significantTo: 'SHADOW', severeTo: 'JEV_PRIMARY',
    // Recent accuracy this far under the floor is severe, closer is significant.
    severeAccuracyGap: 0.05,
  }),
  repromotion: Object.freeze({ consecutiveWindows: 2 }),
  retrain: Object.freeze({
    // Retrain once this many new verified samples arrived since the last artifact, or on drift.
    everyNewSamples: 100,
    minSamples: 50,
    epochs: 200,
    learningRate: 0.1,
    l2: 0.001,
  }),
  // Time-aware split: oldest for training, next for calibration, newest held out.
  split: Object.freeze({ train: 0.7, validation: 0.15, holdout: 0.15 }),
  ood: Object.freeze({
    // Softmax entropy above this share of the maximum entropy is unfamiliar.
    maxEntropyShare: 0.75,
    // Top-two probability margin under this is indecision.
    minMargin: 0.10,
    // Numeric feature this many standard deviations outside the training mean is out of range.
    rangeSigmas: 4,
    // A resource with fewer verified samples than this in the domain is an unfamiliar candidate.
    familiarCandidateSamples: 20,
  }),
  evidence: Object.freeze({
    // Reliability of each evidence class, in the order the design ranks them.
    reliability: {
      objective_deterministic: 1.0,
      human_outcome: 0.9,
      independent_review: 0.75,
      benchmark: 0.7,
      jev_label: 0.5,
      self_assessment: 0.15,
    },
    // How many pseudo-samples a prior at confidence 1 is worth; a weak family prior is worth less.
    priorStrength: 8,
    familyPriorStrength: 4,
    // Confidence saturates as 1 - exp(-precision / confidenceScale): about 30 solid samples reach 0.63,
    // a few hundred approach 1.
    confidenceScale: 30,
    // Execution evidence halves in weight every this many days; benchmarks decay slower.
    halfLifeDays: 60,
    benchmarkHalfLifeDays: 180,
    // Recent window for regression detection, and how far recent must fall under lifetime to count.
    recentN: 20,
    minRecent: 5,
    regressionMargin: 0.1,
    regressionWeight: 0.6,
    // Task similarity weights: same type, a related type, anything else.
    similarity: { same: 1, related: 0.5, other: 0.25 },
    // An unknown dimension is scored neutral at zero confidence; routing sees the zero confidence.
    unknownScore: 0.5,
  }),
  governor: Object.freeze({
    // Where conservation starts and where it becomes aggressive, as a share of a limit used. The
    // ranking prices the scarcity this curve gives (broker.js), and from `startAt` on the
    // conservation limit in decision.js keeps easy work off the most capable resource. Keys are
    // plan names as the provider adapter reports them, lower case.
    conservation: {
      default: { startAt: 0.6, aggressiveAt: 0.85 },
      plans: {
        pro: { startAt: 0.55, aggressiveAt: 0.8 },
        plus: { startAt: 0.55, aggressiveAt: 0.8 },
        max: { startAt: 0.7, aggressiveAt: 0.9 },
        team: { startAt: 0.7, aggressiveAt: 0.9 },
      },
    },
    // How much a near reset discounts pressure: 82% used with the reset in ten minutes is not
    // 82% used with the reset in five days.
    resetProximityWeight: 0.5,
    // Usage older than this is stale and its confidence is multiplied by staleConfidence.
    staleAfterMinutes: 15,
    staleConfidence: 0.5,
    // Relative cost weights for the expected job cost. Unitless: subscription capacity has a
    // scarcity value even when no invoice follows. `marginal` is what one job costs at the margin
    // by funding type, and `scarcityWeight` is what using up scarce capacity is worth. Their ratio
    // sets the crossover that makes subscription-first stop being subscription-wasteful.
    //
    // Where it falls (governor.js): execution = marginal + scarcityWeight * scarcity, and the retry
    // term is a multiple of execution while review and escalation do not depend on the resource,
    // so between two candidates of equal reliability and fit the total orders exactly as execution
    // does. A subscription (0.3) therefore loses to a metered key (0.6) once its scarcity is
    // (0.6 - 0.3) / scarcityWeight = 0.3 above the key's. Against a key with no pressure of its
    // own that is scarcity 0.3, which the conservation curve (0.2 at startAt, 0.7 at aggressiveAt)
    // reaches a fifth of the way from the start knee to the aggressive one: at 65% of the binding
    // limit used on the default curve, 60% on pro and plus, 74% on max and team (reset-discounted
    // pressure, so a little later in raw use when the reset is near). That is early in the
    // conservation band, well before the aggressive knee (scarcity 0.7), and deliberately so: a
    // subscription starts yielding routine work as soon as it starts conserving. A key that is
    // itself under budget pressure moves the crossover up by its own scarcity. A scarcityWeight
    // under 0.3 (the marginal gap) would put the crossover above scarcity 1, so even an exhausted
    // subscription would still look cheapest, which is the mistake.
    cost: { marginal: { none: 0.05, low: 0.3, metered: 0.6 }, scarcityWeight: 1.0, retryWeight: 0.8, reviewWeight: 0.3, escalationWeight: 1.0 },
    // Monetary budgets: pressure from a remaining balance against the soft and hard limits.
    budgetSoftMultiple: 3,
  }),
  // Minimum effective score on the required dimensions for a capability tier. `weak` is the rest.
  capabilityTiers: Object.freeze({ frontier: 0.88, strong: 0.75, standard: 0.5 }),
  // A capability floor only excludes a candidate whose score is known at least this confidently;
  // unknown is not the same as insufficient.
  floorConfidence: 0.4,
  // Resources the operator has switched off or pinned on. Ids, matched against agent ids.
  disabledResources: Object.freeze([]),
  allowedResources: Object.freeze([]),
  // Minimum review policy: the risk cuts of the DETERMINISTIC FALLBACKS, used only when neither
  // Jev nor a trusted local classifier answers: for the second-opinion (riskForReview) and
  // frontier-escalation (riskForFrontierReview) judgments, risk at or above the cut then counts as
  // yes. The same cuts are read elsewhere in decision.js: riskForFrontierReview decides when the
  // fallback strategy is a cheap execute with a frontier review, and riskForReview is where the
  // conservation limit stops, because work at or above it is not easy enough to move off the most
  // capable resource. The resource pick reads neither: the ranking below makes it at any risk.
  // They are not a floor under any answer - a Jev "no" at any risk stands (decision.js
  // judgment()).
  minimumReview: Object.freeze({ riskForReview: 0.6, riskForFrontierReview: 0.8 }),
  // The resource ranking (broker.js rankCandidates), which is the authority on which candidate
  // does the work. Unitless weights over one score per candidate: what the extra capability is
  // worth on a task that needs it, what the expected job cost counts against it, and what
  // spending scarce subscription capacity on work that does not need it counts against it.
  // `evidenceRuns` is how many verified runs a capability score needs before it is trusted in
  // full; under that it is discounted toward neutral, because an unmeasured score is a guess,
  // and `evidenceFloor` is the share of its confidence that survives with no runs at all.
  // `temperature` turns the score gaps into probabilities: lower makes the leader more certain.
  ranking: Object.freeze({
    capabilityWeight: 2.0, costWeight: 0.6, scarcityWeight: 0.8,
    evidenceRuns: 5, evidenceFloor: 0.5, temperature: 0.25,
  }),
  // The judgment answered in code rather than asked of a snap classifier, because it is a
  // comparison of numbers: the frontier review reads the task's risk against the minimumReview
  // cuts above. It answers with a probability, so the judgment carries a confidence the way one
  // from anywhere else does.
  codeJudgments: Object.freeze({
    frontierReview: Object.freeze({ risky: 0.9, frontierWork: 0.7, otherwise: 0.15 }),
  }),
  // Where the machine-readable capability priors live, relative to the harness root.
  priorsFile: 'config/capability-priors.json',
})

/** Deep merge of plain objects; arrays and scalars replace. Frozen inputs are never mutated. */
export function mergePolicy(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergePolicy(out[k], v) : v
  }
  return out
}

const unit = (v, name) => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`routing policy: ${name} must be a number between 0 and 1`)
}
const count = (v, name) => {
  if (!Number.isInteger(v) || v < 0) throw new Error(`routing policy: ${name} must be a whole number`)
}
const nonNegative = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`routing policy: ${name} must be a number of 0 or more`)
}

// Where each rollback lands must be under every rung it can fire from, or a "rollback" climbs:
// minor fires only from LOCAL_ONLY, significant and severe from either local rung (domains.js
// applyRollback). ROLLBACK is a state below the ladder, so it is under both.
const ROLLBACK_BELOW = Object.freeze({ minorTo: 'LOCAL_ONLY', significantTo: 'GUARDED_LOCAL', severeTo: 'GUARDED_LOCAL' })
const RUNGS = Object.freeze(['JEV_PRIMARY', 'SHADOW', 'GUARDED_LOCAL', 'LOCAL_ONLY'])
const isBelow = (state, rung) => MATURITY.includes(state) && (state === 'ROLLBACK' || RUNGS.indexOf(state) < RUNGS.indexOf(rung))

/** The governor values the arithmetic in governor.js and resources.js depends on. */
function checkGovernor(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('routing policy: governor must be an object')
  const curve = (c, name) => {
    unit(c?.startAt, `${name}.startAt`)
    unit(c?.aggressiveAt, `${name}.aggressiveAt`)
    if (c.startAt > c.aggressiveAt) throw new Error(`routing policy: ${name}: startAt must not be above aggressiveAt`)
  }
  curve(g.conservation?.default, 'governor.conservation.default')
  for (const [plan, c] of Object.entries(g.conservation?.plans ?? {})) curve(c, `governor.conservation.plans.${plan}`)
  // A weight over 1 would turn a near reset into negative pressure.
  unit(g.resetProximityWeight, 'governor.resetProximityWeight')
  nonNegative(g.staleAfterMinutes, 'governor.staleAfterMinutes')
  unit(g.staleConfidence, 'governor.staleConfidence')
  for (const f of ['none', 'low', 'metered']) nonNegative(g.cost?.marginal?.[f], `governor.cost.marginal.${f}`)
  for (const f of ['scarcityWeight', 'retryWeight', 'reviewWeight', 'escalationWeight']) nonNegative(g.cost?.[f], `governor.cost.${f}`)
  // Pressure above the soft floor eases out to 0 at this multiple of it; at 1 or under there is
  // no room to ease out over, and the reading would drop from the knee to 0 a cent over the floor.
  if (typeof g.budgetSoftMultiple !== 'number' || !Number.isFinite(g.budgetSoftMultiple) || !(g.budgetSoftMultiple > 1)) throw new Error('routing policy: governor.budgetSoftMultiple must be a number above 1')
}

/**
 * The policy in force: config overrides over the defaults, checked. Throws on a value that could
 * not mean anything (a share over 1, a negative sample count, an unknown risk class), because a
 * wrong threshold silently accepted is exactly how a classifier gets promoted on nothing.
 * @param {object} [overrides] the `routing` block of the plugin config
 */
export function resolvePolicy(overrides = {}) {
  const p = mergePolicy(ROUTING_DEFAULTS, overrides ?? {})
  unit(p.minClassRecall, 'minClassRecall')
  for (const [id, d] of Object.entries(p.domains)) {
    if (!RISK_CLASSES.includes(d.risk)) throw new Error(`routing policy: domain ${id}: risk must be ${RISK_CLASSES.join(', ')}`)
    if (!['multiclass', 'ranking'].includes(d.kind)) throw new Error(`routing policy: domain ${id}: kind must be multiclass or ranking`)
    if (d.localDecides !== undefined && typeof d.localDecides !== 'boolean') throw new Error(`routing policy: domain ${id}: localDecides must be true or false`)
    // A policy may take a classifier's authority away, never give back one the code withholds:
    // decision.js takes such a pick from its rule whatever this says, so switching it on would
    // only make the Router tab promise an authority nothing gives it.
    if (DOMAINS[id]?.localDecides === false && d.localDecides !== false) throw new Error(`routing policy: domain ${id}: localDecides cannot be switched on; its local classifier never decides`)
    // Who teaches a domain is fixed by the code that asks: decision.js opens no Jev question for a
    // domain a rule decides and asks nobody else for one Jev teaches, so a policy saying otherwise
    // would only make the Router tab and the controller disagree with what happens.
    if (d.teacher !== undefined && !['jev', 'code'].includes(d.teacher)) throw new Error(`routing policy: domain ${id}: teacher must be jev or code`)
    if (DOMAINS[id] && (d.teacher ?? 'jev') !== (DOMAINS[id].teacher ?? 'jev')) throw new Error(`routing policy: domain ${id}: teacher cannot be changed; it is ${DOMAINS[id].teacher ?? 'jev'}`)
  }
  for (const rc of RISK_CLASSES) {
    const g = p.gates[rc]
    if (!g) throw new Error(`routing policy: gates.${rc} missing`)
    for (const f of ['shadowSamples', 'guardedSamples', 'localOnlySamples', 'perClassSamples', 'holdoutSamples', 'recentWindow']) count(g[f], `gates.${rc}.${f}`)
    if (!(g.shadowSamples <= g.guardedSamples && g.guardedSamples <= g.localOnlySamples)) throw new Error(`routing policy: gates.${rc}: sample gates must not decrease from SHADOW to LOCAL_ONLY`)
    for (const stage of ['guarded', 'localOnly']) for (const f of ['accuracy', 'recentAccuracy', 'macroF1', 'maxEce']) unit(g[stage][f], `gates.${rc}.${stage}.${f}`)
    for (const f of ['maxHighConfidenceError', 'confidenceThreshold', 'minOutcomeBacked', 'maxTeacherOnly']) unit(g[f], `gates.${rc}.${f}`)
    unit(g.rollback.recentAccuracyFloor, `gates.${rc}.rollback.recentAccuracyFloor`)
    unit(g.rollback.maxEce, `gates.${rc}.rollback.maxEce`)
    count(g.rollback.repromoteSamples, `gates.${rc}.rollback.repromoteSamples`)
    // The per-class recall floor: the risk class's own when it has one, else the global. Written
    // into a copy of the gate block (the defaults are frozen), so every reader of the gates sees
    // one number and none has to know about the fallback.
    if (g.minClassRecall !== undefined) unit(g.minClassRecall, `gates.${rc}.minClassRecall`)
    p.gates = { ...p.gates, [rc]: { ...g, minClassRecall: g.minClassRecall ?? p.minClassRecall } }
  }
  for (const f of ['psiWarn', 'psiDrift', 'jsWarn', 'jsDrift', 'oodRateDegrade']) unit(p.drift[f], `drift.${f}`)
  for (const [f, from] of Object.entries(ROLLBACK_BELOW)) {
    if (!MATURITY.includes(p.rollback[f])) throw new Error(`routing policy: rollback.${f} must be a maturity state`)
    if (!isBelow(p.rollback[f], from)) throw new Error(`routing policy: rollback.${f} must be below ${from}, the lowest rung it rolls back from`)
  }
  const s = p.split
  if (Math.abs(s.train + s.validation + s.holdout - 1) > 1e-9) throw new Error('routing policy: split shares must add up to 1')
  for (const [k, v] of Object.entries(p.capabilityTiers)) unit(v, `capabilityTiers.${k}`)
  unit(p.floorConfidence, 'floorConfidence')
  checkGovernor(p.governor)
  return p
}

/** The gate block for one domain, from its risk class. */
export const gatesFor = (policy, domain) => {
  const d = policy.domains[domain]
  if (!d) throw new Error(`routing policy: unknown domain ${domain}`)
  return policy.gates[d.risk]
}

/** Tier name for an effective score: frontier, strong, standard or weak. */
export function tierOf(score, tiers) {
  if (typeof score !== 'number') return 'unknown'
  if (score >= tiers.frontier) return 'frontier'
  if (score >= tiers.strong) return 'strong'
  if (score >= tiers.standard) return 'standard'
  return 'weak'
}

const TIER_ORDER = { weak: 0, standard: 1, strong: 2, frontier: 3 }
/** Is tier `a` at least tier `b`? Unknown never satisfies anything. */
export const tierAtLeast = (a, b) => TIER_ORDER[a] !== undefined && TIER_ORDER[b] !== undefined && TIER_ORDER[a] >= TIER_ORDER[b]

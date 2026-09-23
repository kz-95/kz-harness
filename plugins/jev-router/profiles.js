// Capability profiles: what each model version is good at, held as evidence rather than as a rule.
//
// A subject is one model version on one provider, keyed provider|model|version. Its score on a
// dimension is a precision-weighted mean of a prior (the owner's observations in
// config/capability-priors.json) and every evidence row recorded for it, each row weighted by
// how trustworthy its source is, how sure it was, how many observations it carries, how old it is
// and how close its task type is to the one being asked about. Three things fall out of that on
// purpose: hundreds of observations cannot be moved much by a couple of new ones, real evidence
// overtakes any prior, and a dimension nobody has observed stays unknown at zero confidence
// instead of being invented. Evidence is append-only JSONL keyed by version, so a new version
// that is PINNED (a dated snapshot or a content digest, see versionPinned) starts cold, with
// nothing but its family's prior, and nothing an old version did is credited to it.
//
// An unpinned subject gets a weaker promise. Most of what this plugin can read is a model NAME the
// provider may repoint (a CLI alias such as `opus`, an API id such as `deepseek-chat`), not a
// version, and a new version served behind the same name has the same key. Such a subject only
// counts evidence from the last UNPINNED_WINDOW_DAYS, so a silent upgrade behind the name DOES
// inherit the old version's record, for up to that long, and never for ever.
//
// Confidence is how much evidence there is AND how well it agrees: contradictory evidence pins
// the score less well than unanimous evidence of the same weight (see dimensionProfile).
//
// Benchmark evidence has a source, a reliability and a half-life here, but NOTHING produces it
// yet: no importer, fetcher or job in this plugin records a `benchmark` row or a
// `benchmark_prior`. The effective capability today is the prior plus execution evidence (runs,
// reviews, feedback); the benchmark slots exist so a future importer has a schema to write to.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DIMENSIONS, RELATED_TASK_TYPES, TASK_DIMENSIONS, resolvePolicy } from './routing-policy.js'

/**
 * Where a piece of evidence came from, best first. The weights per source live in the policy.
 * `benchmark` is accepted and weighted but has no producer yet: nothing records one today.
 */
export const EVIDENCE_SOURCES = Object.freeze(['objective_deterministic', 'human_outcome', 'independent_review', 'benchmark', 'jev_label', 'self_assessment'])
/**
 * Where a prior came from. `family_prior` marks a family entry reached through the provider alone.
 * `benchmark_prior` is accepted in a priors file, but no shipped prior and no code writes one.
 */
export const PRIOR_SOURCES = Object.freeze(['owner_prior', 'family_prior', 'benchmark_prior'])

// A family prior reached through the provider alone keeps this share of the family's confidence:
// the model id is unknown or unrecognised, so the family is a guess about it, not an observation.
// Fixed by the module contract rather than the policy, which carries no field for it.
const FAMILY_PRIOR_CONFIDENCE = 0.75
// How far back evidence counts for a subject whose version is not pinned. Its name may have been
// repointed to a new version at any moment we cannot see, so this is the longest a new version
// can be credited with the old one's record. Shorter than the 60-day half-life so it really
// bounds something; long enough that a resource in daily use still has dozens of rows inside it.
// Fixed by the module contract, like the discount above: the policy carries no field for it.
export const UNPINNED_WINDOW_DAYS = 45
const DAY_MS = 86_400_000
// A dated snapshot id (claude-opus-4-1-20250805, gpt-4o-2024-08-06): providers that publish these
// document them as immutable, unlike the undated alias they sit behind.
const DATED_SNAPSHOT = /(?:^|[-_.@])20\d{2}-?(?:0[1-9]|1[0-2])-?(?:0[1-9]|[12]\d|3[01])$/
// A content digest (the SHA-256 of a local weights file): the bytes themselves, so it cannot move.
const CONTENT_DIGEST = /(?:^|[@:])[0-9a-f]{64}$/i
// A verdict's identity, sessionId/messageId: the key feedback.js upserts on. Ids only, no text.
const VERDICT_KEY = /^[\w.:/-]{1,300}$/
// One record()/recordMany() call, stamped on the verdict rows it stores (see the registry).
const BATCH = /^[\w-]{1,64}$/
// How recently a run must have ended for the version reported NOW to be taken as the one that
// ran it: the learning step straight after a run is inside this, a backfill over history or a
// verdict given an hour later is not, and a past run is never credited to a version installed
// since. Long enough for a slow learning step, far shorter than any upgrade cycle.
const REPORTED_VERSION_MS = 10 * 60_000
// A note is a short label for the inspector, never a place for text from a run.
const MAX_NOTE = 200
const VERDICT_SCORE = { like: 1, dislike: 0 }
// A verdict about speed says nothing about whether the work was good.
const NOT_A_CAPABILITY_TAG = 'too slow'

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const str = (v) => (typeof v === 'string' && v ? v : null)

function validateCapabilities(caps, where, dimensions) {
  if (!isObject(caps)) throw new Error(`capability priors: ${where}: capabilities must be an object`)
  for (const [dim, c] of Object.entries(caps)) {
    if (!dimensions.includes(dim)) throw new Error(`capability priors: ${where}: unknown dimension "${dim}"`)
    if (!isObject(c) || !unit(c.score)) throw new Error(`capability priors: ${where}.${dim}: score must be a number between 0 and 1`)
    if (!unit(c.confidence)) throw new Error(`capability priors: ${where}.${dim}: confidence must be a number between 0 and 1`)
    if (c.source !== undefined && !PRIOR_SOURCES.includes(c.source)) throw new Error(`capability priors: ${where}.${dim}: source must be ${PRIOR_SOURCES.join(', ')}`)
  }
}

/**
 * Check a priors object (the shape of config/capability-priors.json). Throws naming the field
 * on a score or confidence outside 0..1, a dimension the policy does not know, a family match
 * that is not providers plus a valid regular expression, or a `models` entry naming a family
 * that does not exist. Returns the object unchanged.
 * @param {object} obj
 * @param {{ dimensions?: readonly string[] }} [opts] the dimension list, DIMENSIONS by default
 */
export function validatePriors(obj, { dimensions = DIMENSIONS } = {}) {
  if (!isObject(obj)) throw new Error('capability priors: an object is required')
  if (!isObject(obj.families)) throw new Error('capability priors: families must be an object')
  for (const [id, f] of Object.entries(obj.families)) {
    if (!isObject(f) || !isObject(f.match)) throw new Error(`capability priors: families.${id}: match is required`)
    const { providers, modelPattern } = f.match
    if (providers !== undefined && (!Array.isArray(providers) || providers.some((p) => typeof p !== 'string'))) throw new Error(`capability priors: families.${id}.match.providers: an array of provider ids`)
    if (modelPattern !== undefined) {
      if (typeof modelPattern !== 'string') throw new Error(`capability priors: families.${id}.match.modelPattern: a regular expression string`)
      try { new RegExp(modelPattern) } catch { throw new Error(`capability priors: families.${id}.match.modelPattern: not a valid regular expression`) }
    }
    if (providers === undefined && modelPattern === undefined) throw new Error(`capability priors: families.${id}.match: providers or modelPattern is required`)
    validateCapabilities(f.capabilities, `families.${id}`, dimensions)
  }
  const models = obj.models ?? {}
  if (!isObject(models)) throw new Error('capability priors: models must be an object')
  for (const [id, m] of Object.entries(models)) {
    if (!isObject(m)) throw new Error(`capability priors: models.${id}: an object is required`)
    if (m.family !== undefined && !obj.families[m.family]) throw new Error(`capability priors: models.${id}: unknown family "${m.family}"`)
    validateCapabilities(m.capabilities, `models.${id}`, dimensions)
  }
  return obj
}

/**
 * Read and validate a priors file. Synchronous: it is read once at start-up, and a broken
 * priors file should stop the plugin loading rather than route on nothing.
 * @param {string} file path to capability-priors.json
 * @param {{ dimensions?: readonly string[] }} [opts]
 */
export function loadPriors(file, opts) {
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { throw new Error(`capability priors: cannot read ${file}: ${err.message}`) }
  return validatePriors(parsed, opts)
}

const providerMatches = (family, provider) => !!provider && Array.isArray(family?.match?.providers) && family.match.providers.includes(provider)
const modelMatches = (family, model) => !!model && typeof family?.match?.modelPattern === 'string' && new RegExp(family.match.modelPattern).test(model)

/**
 * The subject an agent definition stands for: provider, model, version and the priors family.
 * provider is `llm.provider` (a spawn agent's real backend) or the agent's `provider`; model is
 * `llm.model`, else what `modelOf` reads from the installed CLI (a name the owner configured,
 * often an alias). version is what `versionOf(agentDef, model)` reports when the caller really
 * knows one (the snapshot the provider served, the SHA-256 of a local weights file), else the
 * model name itself, which is the most that is known and is treated as unpinned (versionPinned).
 * The family is the first whose `match.providers` names the provider; failing that, the first
 * whose `modelPattern` matches the model id. The provider is checked first because it is where
 * the model runs: a DeepSeek distillation served locally is a local small model, not the hosted
 * DeepSeek the owner observed.
 * @param {object} agentDef  a config.agents entry
 * @param {{ modelOf?: (agentDef: object) => string|undefined, versionOf?: (agentDef: object, model: string|null) => string|undefined, priors?: object }} [opts]
 * @returns {{ provider: string|null, family: string|null, model: string|null, version: string|null }}
 */
export function subjectOf(agentDef, { modelOf, versionOf, priors } = {}) {
  const provider = str(agentDef?.llm?.provider) ?? str(agentDef?.provider)
  const named = str(agentDef?.llm?.model) ?? str(modelOf?.(agentDef)) ?? null
  const reported = str(versionOf?.(agentDef, named))
  // With no configured name, the version the provider reported is the best name there is.
  const model = named ?? reported
  const families = Object.entries(priors?.families ?? {})
  const match = families.find(([, f]) => providerMatches(f, provider)) ?? families.find(([, f]) => modelMatches(f, model))
  return { provider, family: match?.[0] ?? null, model, version: reported ?? model }
}

/**
 * The evidence key of a subject: one model version on one provider. The version part is only as
 * precise as what was reported; an unpinned one is bounded in time by the registry instead.
 */
export const subjectKey = (s) => `${s?.provider ?? ''}|${s?.model ?? ''}|${s?.version ?? ''}`

/**
 * True when a version string names bytes that cannot change under it: a dated snapshot id or a
 * content digest. Anything else (an alias, an undated API id, a local tag, nothing at all) is a
 * name its provider may repoint without telling us, so evidence under it is time-bounded.
 * @param {string|null|undefined} version
 */
export const versionPinned = (version) => typeof version === 'string' && (DATED_SNAPSHOT.test(version) || CONTENT_DIGEST.test(version))

const copyPrior = (caps, factor, source) => Object.fromEntries(Object.entries(caps ?? {}).map(([d, c]) => [d, { score: c.score, confidence: c.confidence * factor, source: source ?? c.source ?? 'owner_prior' }]))

/**
 * The prior for a subject, one `{ score, confidence, source }` per dimension the owner observed.
 * An exact `models` entry wins as written. Otherwise the family entry applies: at its full
 * confidence when the model id matches the family's pattern (the id confirms the family the
 * owner observed), or at 0.75 of it with source `family_prior` when only the provider matched,
 * so an unrecognised or unknown model inherits a weak family prior rather than the family's
 * full confidence. No family, no prior: `{}`.
 * @param {{ provider, family, model, version }} subject
 * @param {object} priors  a validated priors object
 * @param {object} [policy] accepted for symmetry with the registry; the discount is fixed by contract
 */
export function priorFor(subject, priors, policy) {
  if (!subject || !priors) return {}
  void policy
  const exact = subject.model ? priors.models?.[subject.model] : undefined
  if (exact) return copyPrior(exact.capabilities, 1, null)
  const family = subject.family ? priors.families?.[subject.family] : undefined
  if (!family) return {}
  if (modelMatches(family, subject.model)) return copyPrior(family.capabilities, 1, null)
  return copyPrior(family.capabilities, FAMILY_PRIOR_CONFIDENCE, 'family_prior')
}

// One stored row, and nothing else: unknown keys are dropped here so a caller cannot store a
// prompt, a diff or a task text by accident, and every field that is kept is checked.
function normaliseEvidence(e, { dimensions, nowIso }) {
  if (!isObject(e)) throw new Error('capability evidence: an object is required')
  if (!dimensions.includes(e.dimension)) throw new Error(`capability evidence: unknown dimension "${e.dimension}"`)
  if (!EVIDENCE_SOURCES.includes(e.source)) throw new Error(`capability evidence: source must be ${EVIDENCE_SOURCES.join(', ')}`)
  if (!unit(e.score)) throw new Error('capability evidence: score must be a number between 0 and 1')
  const confidence = e.confidence === undefined ? 1 : e.confidence
  if (!unit(confidence)) throw new Error('capability evidence: confidence must be a number between 0 and 1')
  const n = e.n === undefined ? 1 : e.n
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error('capability evidence: n must be a positive number')
  const s = e.subject
  if (!isObject(s) || !str(s.provider)) throw new Error('capability evidence: subject.provider is required')
  const ts = e.ts === undefined ? nowIso() : e.ts
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) throw new Error('capability evidence: ts must be an ISO timestamp')
  if (e.note !== undefined && (typeof e.note !== 'string' || e.note.length > MAX_NOTE)) throw new Error(`capability evidence: note must be a string of at most ${MAX_NOTE} characters`)
  if (e.benchmark !== undefined && (!isObject(e.benchmark) || !str(e.benchmark.id))) throw new Error('capability evidence: benchmark must be { id, version }')
  if (e.verdictKey !== undefined && (typeof e.verdictKey !== 'string' || !VERDICT_KEY.test(e.verdictKey))) throw new Error('capability evidence: verdictKey must be the verdict\'s sessionId/messageId')
  return {
    ts,
    subject: { provider: s.provider, family: str(s.family), model: str(s.model), version: str(s.version) ?? str(s.model) },
    dimension: e.dimension,
    score: e.score,
    source: e.source,
    confidence,
    n,
    ...(str(e.taskType) ? { taskType: e.taskType } : {}),
    ...(e.benchmark ? { benchmark: { id: e.benchmark.id, version: str(e.benchmark.version) } } : {}),
    ...(str(e.runId) ? { runId: e.runId } : {}),
    ...(e.verdictKey ? { verdictKey: e.verdictKey } : {}),
    ...(e.note ? { note: e.note } : {}),
  }
}

// A retraction line as stored: the verdict's key, when, the batch it opens, and the run the
// verdict had been credited to. Anything else on the line is dropped, as for an evidence row.
function normaliseRetraction(e) {
  if (typeof e.verdictKey !== 'string' || !VERDICT_KEY.test(e.verdictKey)) throw new Error('capability retraction: verdictKey is required')
  if (typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) throw new Error('capability retraction: ts must be an ISO timestamp')
  if (typeof e.batch !== 'string' || !BATCH.test(e.batch)) throw new Error('capability retraction: batch is required')
  return { ts: e.ts, verdictKey: e.verdictKey, retracted: true, batch: e.batch, ...(str(e.runId) ? { runId: e.runId } : {}) }
}

// Precision-weighted mean of items by their weight; the plain mean when every weight is zero,
// so a source the policy weights at nothing still reports what it saw.
const weightedMean = (items) => {
  let w = 0; let ws = 0
  for (const it of items) { w += it.weight; ws += it.weight * it.row.score }
  if (w > 0) return ws / w
  return items.length ? items.reduce((s, it) => s + it.row.score, 0) / items.length : null
}
const countOf = (items) => items.reduce((s, it) => s + it.row.n, 0)

/**
 * The weight of one evidence row: source reliability, its own confidence, its observation count,
 * time decay and task similarity, multiplied. Exported for the inspector and the tests.
 * @param {object} row       a stored evidence row
 * @param {object} p
 * @param {object} p.policy  the resolved routing policy
 * @param {number} p.nowMs   the clock, in ms
 * @param {string} [p.taskType] the task type being asked about; none means every row is fully relevant
 */
export function evidenceWeight(row, { policy, nowMs, taskType }) {
  const ev = policy.evidence
  const reliability = ev.reliability[row.source] ?? 0
  const at = Date.parse(row.ts)
  const ageDays = Number.isFinite(at) ? Math.max(0, (nowMs - at) / DAY_MS) : 0
  const halfLife = row.source === 'benchmark' ? ev.benchmarkHalfLifeDays : ev.halfLifeDays
  const decay = 0.5 ** (ageDays / halfLife)
  // A row with no task type is general evidence (a benchmark, a reliability count): fully relevant.
  const similarity = !taskType || !row.taskType ? 1
    : row.taskType === taskType ? ev.similarity.same
      : (RELATED_TASK_TYPES[taskType] ?? []).includes(row.taskType) ? ev.similarity.related : ev.similarity.other
  return { weight: reliability * row.confidence * row.n * decay * similarity, reliability, decay, similarity, ageDays }
}

/**
 * How well the evidence rows agree, as the factor confidence is multiplied by. The arithmetic:
 *   spread²   = sum(w * (s - m)²) / sum(w), the weighted variance of the row scores around their
 *               own weighted mean m. Scores live in 0..1, so spread is at most 0.5 (half at 0,
 *               half at 1).
 *   stdError  = spread / sqrt(precision), the standard error of the score when every unit of
 *               precision counts as one observation, which is what the weights already mean
 *               (a fresh objective row at confidence 1 weighs exactly 1).
 *   agreement = 1 - 2 * stdError, clamped to 0..1: the share of the 0..1 score range left
 *               outside the +-1 standard-error band around the score.
 * Unanimous rows have spread 0, so agreement is exactly 1 at any amount of evidence and a
 * well-evidenced unanimous subject is never made to look uncertain. Contradictory rows widen the
 * band; more of them narrow it again (1/sqrt(n)), so ten runs split 5/5 read as far less sure
 * than ten that agree, while three hundred mixed runs still pin the score well. The prior is left
 * out of the spread on purpose: it is an opinion, and evidence overtaking it is not a
 * contradiction within the evidence.
 * @returns {{ spread: number, stdError: number, agreement: number }}
 */
export function agreementOf(items, precision) {
  let w = 0; let ws = 0
  for (const it of items) { w += it.weight; ws += it.weight * it.row.score }
  if (w <= 0 || precision <= 0) return { spread: 0, stdError: 0, agreement: 1 }
  const m = ws / w
  let v = 0
  for (const it of items) v += it.weight * (it.row.score - m) ** 2
  const spread = Math.sqrt(Math.max(0, v / w))
  const stdError = spread / Math.sqrt(precision)
  return { spread, stdError, agreement: Math.min(1, Math.max(0, 1 - 2 * stdError)) }
}

// The full profile of one dimension from its prior and its rows. Everything the registry reports
// on a dimension comes from here, so profileOf, effective and explain cannot disagree.
function dimensionProfile(rows, prior, { policy, nowMs, taskType }) {
  const ev = policy.evidence
  const k0 = prior ? prior.confidence * (prior.source === 'family_prior' ? ev.familyPriorStrength : ev.priorStrength) : 0
  const items = rows.map((row, index) => ({ row, index, ...evidenceWeight(row, { policy, nowMs, taskType }) }))
  let sumW = 0; let sumWS = 0
  const contributions = new Map()
  if (prior) contributions.set(prior.source, k0)
  for (const it of items) {
    sumW += it.weight; sumWS += it.weight * it.row.score
    contributions.set(it.row.source, (contributions.get(it.row.source) ?? 0) + it.weight)
  }
  const precision = k0 + sumW
  const base = { prior: prior ?? null, k0, sumW, precision, items, samples: countOf(items), lastUpdate: items.length ? items.map((it) => it.row.ts).sort().at(-1) : null }
  if (precision <= 0) return { ...base, score: ev.unknownScore, confidence: 0, amount: 0, spread: 0, stdError: 0, agreement: 1, benchmark: null, execution: null, sources: [], source: 'unknown' }
  let score = (k0 * (prior?.score ?? 0) + sumWS) / precision
  // How much evidence there is, times how well it agrees (agreementOf).
  const amount = 1 - Math.exp(-precision / ev.confidenceScale)
  const { spread, stdError, agreement } = agreementOf(items, precision)
  const confidence = amount * agreement
  const bench = items.filter((it) => it.row.source === 'benchmark')
  const benchmark = bench.length ? { score: weightedMean(bench), n: countOf(bench) } : null
  const exec = items.filter((it) => it.row.source !== 'benchmark')
  let execution = null
  if (exec.length) {
    const lifetime = weightedMean(exec)
    // Newest first; among equal timestamps the later-recorded row is the newer one.
    const recent = [...exec].sort((a, b) => Date.parse(b.row.ts) - Date.parse(a.row.ts) || b.index - a.index).slice(0, ev.recentN)
    const recentN = countOf(recent)
    const recentScore = weightedMean(recent)
    let trend = 'stable'
    if (recentN >= ev.minRecent) {
      if (recentScore < lifetime - ev.regressionMargin) trend = 'declining'
      else if (recentScore > lifetime + ev.regressionMargin) trend = 'improving'
    }
    // A resource that changed is scored closer to what it does now than to what it did.
    if (trend !== 'stable') score = score * (1 - ev.regressionWeight) + recentScore * ev.regressionWeight
    execution = { score: lifetime, n: countOf(exec), recentScore, recentN, trend }
  }
  // The source that carries the most precision: what the number mostly rests on.
  let source = 'unknown'; let best = -1
  for (const [s, p] of contributions) if (p > best) { best = p; source = s }
  const sources = [...contributions.keys()]
  return { ...base, score, confidence, amount, spread, stdError, agreement, benchmark, execution, sources, source }
}

const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)

/**
 * The capability registry: evidence rows on disk and in memory, and the profiles computed from
 * them and the priors. Synchronous throughout: rows are small, the file is append-only, and the
 * inspector and the decision engine read profiles in the middle of a request.
 * @param {object} p
 * @param {string} [p.file]     capability-evidence.jsonl; omitted keeps everything in memory
 * @param {object} [p.priors]   a validated priors object (loadPriors); omitted means no priors
 * @param {object} [p.policy]   resolvePolicy(...) output; the defaults when omitted
 * @param {() => number|string} [p.now] the clock, ms or ISO, injectable for tests
 * @param {readonly string[]} [p.dimensions] the dimension list, DIMENSIONS by default
 */
export function createCapabilityRegistry({ file, priors, policy = resolvePolicy(), now = () => Date.now(), dimensions = DIMENSIONS } = {}) {
  const nowMs = () => { const v = now(); return typeof v === 'number' ? v : Date.parse(v) }
  const nowIso = () => new Date(nowMs()).toISOString()
  // key -> dimension -> rows, in file order; key -> subject for subjects().
  const memory = new Map()
  const known = new Map()
  // verdictKey -> { batch, runId, retracted }: the recording of a verdict that counts. One
  // person's verdict on one answer is one piece of evidence, however often and against whatever
  // run it is derived, the same "newest wins" rule feedback.js reads with. So the unit that
  // supersedes is the BATCH (one record()/recordMany() call), not the row: only the newest batch
  // holding a key counts, and every older row with that key is dropped whatever its dimension. A
  // per-dimension rule let one verdict derived against two runs of different task types count
  // twice, once on each run's dimensions. A retraction (the verdict was cleared, or its newest
  // form says nothing about capability) is a batch with no rows, so nothing of it counts until it
  // is given again. runId is the run it was credited to, kept across a retraction so the same
  // answer's verdict is credited to the same run when it comes back (creditedRun). score is what
  // the counting batch says (every row of one verdict carries the same one), so a caller can tell
  // whether what counts is still what the person says now (countsAs).
  const verdicts = new Map()

  const remember = (row) => {
    const key = subjectKey(row.subject)
    if (!known.has(key)) known.set(key, { key, ...row.subject })
    if (!memory.has(key)) memory.set(key, new Map())
    const dims = memory.get(key)
    if (!dims.has(row.dimension)) dims.set(row.dimension, [])
    dims.get(row.dimension).push(row)
    if (row.verdictKey) verdicts.set(row.verdictKey, { batch: row.batch, runId: row.runId ?? verdicts.get(row.verdictKey)?.runId ?? null, retracted: false, score: row.score })
    return row
  }
  const rememberRetraction = (line) => {
    verdicts.set(line.verdictKey, { batch: line.batch, runId: line.runId ?? verdicts.get(line.verdictKey)?.runId ?? null, retracted: true, score: null })
  }
  // The rows that count now: a verdict row only from its verdict's newest batch, and for a
  // subject whose version is not pinned only the last UNPINNED_WINDOW_DAYS, so a version swapped
  // in behind the same name inherits the old one's record for a bounded time at most.
  const counts = (subject, at) => {
    const floor = versionPinned(subject?.version) ? -Infinity : at - UNPINNED_WINDOW_DAYS * DAY_MS
    return (row) => (!row.verdictKey || verdicts.get(row.verdictKey)?.batch === row.batch) && !(Date.parse(row.ts) < floor)
  }
  // Verdict rows carry the batch they were recorded in; nothing else needs one.
  const stamp = (rows) => {
    const batch = randomUUID()
    return rows.map((r) => (r.verdictKey ? { ...r, batch } : r))
  }
  const allRowsOf = (subject, dim) => memory.get(subjectKey(subject))?.get(dim) ?? []
  const rowsOf = (subject, dim, at = nowMs()) => allRowsOf(subject, dim).filter(counts(subject, at))
  const liveRows = (subject) => {
    const keep = counts(subject, nowMs())
    return [...(memory.get(subjectKey(subject))?.values() ?? [])].map((rows) => rows.filter(keep))
  }
  const priorOf = (subject) => priorFor(subject, priors, policy)
  const dimsOf = (subject) => {
    const set = new Set(dimensions)
    for (const d of Object.keys(priorOf(subject))) set.add(d)
    for (const d of memory.get(subjectKey(subject))?.keys() ?? []) set.add(d)
    return [...set]
  }
  const profile = (subject, dim, taskType) => {
    const at = nowMs()
    return dimensionProfile(rowsOf(subject, dim, at), priorOf(subject)[dim] ?? null, { policy, nowMs: at, taskType })
  }
  const versionOfSubject = (subject) => {
    const pinned = versionPinned(subject?.version)
    return { id: subject?.version ?? null, pinned, windowDays: pinned ? null : UNPINNED_WINDOW_DAYS }
  }
  const persist = (rows) => {
    if (!file || !rows.length) return
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  }

  const api = {
    /**
     * Read the JSONL into memory, replacing what was there. Same tolerance as feedback.js: a
     * line that does not parse or does not validate is dropped, a missing file is empty.
     * @returns {number} rows loaded
     */
    load() {
      memory.clear(); known.clear(); verdicts.clear()
      let raw = ''
      try { raw = readFileSync(file, 'utf8') } catch { raw = '' }
      let count = 0
      for (const [i, l] of raw.split('\n').filter(Boolean).entries()) {
        try {
          const parsed = JSON.parse(l)
          if (parsed?.retracted === true) { rememberRetraction(normaliseRetraction(parsed)); continue }
          const row = normaliseEvidence(parsed, { dimensions, nowIso })
          // File order is recording order, so the batch stamped on the line says which recording
          // of a verdict is newest. A verdict line without one (written by hand) is its own batch.
          remember(row.verdictKey ? { ...row, batch: typeof parsed.batch === 'string' && BATCH.test(parsed.batch) ? parsed.batch : `line-${i}` } : row)
          count++
        } catch { /* a truncated or foreign line */ }
      }
      return count
    },
    /** Validate, append to disk and keep in memory. Returns the stored row. Throws on a bad row. */
    record(evidence) {
      const [row] = stamp([normaliseEvidence(evidence, { dimensions, nowIso })])
      persist([row])
      return remember(row)
    },
    /**
     * `record` for a list, validated whole before anything is written, so a bad row stores
     * nothing. One call is one batch: for a verdict it holds, it replaces every earlier recording.
     */
    recordMany(list) {
      const rows = stamp((list ?? []).map((e) => normaliseEvidence(e, { dimensions, nowIso })))
      persist(rows)
      return rows.map(remember)
    },
    /**
     * Stop counting a verdict: it was cleared, or its newest form is not about capability (a
     * `too slow` tag, a run it does not name). Appends a retraction line, so a reload keeps it.
     * A later recording of the same verdict counts again. False when nothing of it counted.
     * @param {object} verdict a feedback.js row (its sessionId and messageId are the key)
     */
    retract(verdict) {
      const verdictKey = verdictKeyOf(verdict)
      const current = verdictKey ? verdicts.get(verdictKey) : undefined
      if (!current || current.retracted) return false
      const line = { ts: nowIso(), verdictKey, retracted: true, batch: randomUUID(), ...(current.runId ? { runId: current.runId } : {}) }
      persist([line])
      rememberRetraction(line)
      return true
    },
    /**
     * The runId a verdict was last credited to, or null. A verdict re-posted later (a reason
     * edited, a tag or a mind changed) is about the same answer, so it belongs to the same run
     * even when newer runs have ended in the session since.
     * @param {object} verdict a feedback.js row
     */
    creditedRun(verdict) {
      const verdictKey = verdictKeyOf(verdict)
      return (verdictKey && verdicts.get(verdictKey)?.runId) || null
    },
    /**
     * True when this verdict counts now with exactly the score this form of it gives: a like
     * counted as a like, a dislike as a dislike. False when nothing of it counts, when it was
     * retracted, when what counts is an earlier form the person has since changed, and for a form
     * that credits nothing (a `too slow` tag), since whatever counts is then not this form. A caller
     * keeping old evidence on the strength of "the verdict did not change" asks this, not only
     * the feedback log, because the registry is what routing reads.
     * @param {object} verdict a feedback.js row
     */
    countsAs(verdict) {
      const verdictKey = verdictKeyOf(verdict)
      const current = verdictKey ? verdicts.get(verdictKey) : undefined
      return !!current && !current.retracted && verdict?.tag !== NOT_A_CAPABILITY_TAG && VERDICT_SCORE[verdict?.verdict] !== undefined && current.score === VERDICT_SCORE[verdict.verdict]
    },
    /**
     * The full profile of a subject for the inspector: every dimension with its prior, its
     * benchmark and execution summaries, trend and sources. Numbers are rounded to 3 decimals
     * here because this is what people read; `effective` keeps the raw values for routing.
     * @param {object} subject
     * @param {{ taskType?: string }} [opts] weigh evidence by closeness to this task type
     */
    profileOf(subject, { taskType } = {}) {
      const out = {}
      let samples = 0; let lastUpdate = null
      for (const dim of dimsOf(subject)) {
        const p = profile(subject, dim, taskType)
        samples += p.samples
        if (p.lastUpdate && (!lastUpdate || p.lastUpdate > lastUpdate)) lastUpdate = p.lastUpdate
        out[dim] = {
          score: r3(p.score),
          confidence: r3(p.confidence),
          // How much of the confidence the disagreement between rows took away (agreementOf).
          agreement: r3(p.agreement),
          samples: p.samples,
          prior: p.prior ? { score: r3(p.prior.score), confidence: r3(p.prior.confidence), source: p.prior.source } : null,
          benchmark: p.benchmark ? { score: r3(p.benchmark.score), n: p.benchmark.n } : null,
          execution: p.execution ? { score: r3(p.execution.score), n: p.execution.n, recentScore: r3(p.execution.recentScore), recentN: p.execution.recentN, trend: p.execution.trend } : null,
          sources: p.sources,
          lastUpdate: p.lastUpdate,
        }
      }
      return { subject: { ...subject }, version: versionOfSubject(subject), dimensions: out, samples, lastUpdate, cold: api.cold(subject) }
    },
    /**
     * The effective capabilities for routing: `{ [dim]: { score, confidence, samples, source } }`,
     * unrounded, with nothing that names the subject. `source` is the source carrying the most
     * precision behind the number.
     * @param {object} subject
     * @param {readonly string[]} [dims] the dimensions wanted, all by default
     * @param {{ taskType?: string }} [opts]
     */
    effective(subject, dims = dimensions, { taskType } = {}) {
      const out = {}
      for (const dim of dims) {
        const p = profile(subject, dim, taskType)
        out[dim] = { score: p.score, confidence: p.confidence, samples: p.samples, source: p.source }
      }
      return out
    },
    /**
     * Why a dimension scores what it does: the prior and its pseudo-samples, every row with the
     * weight it got and why, and the aggregate. Raw numbers, for the inspector's detail view.
     * @param {object} subject
     * @param {string} dim
     * @param {{ taskType?: string }} [opts]
     */
    explain(subject, dim, { taskType } = {}) {
      const p = profile(subject, dim, taskType)
      return {
        dimension: dim,
        taskType: taskType ?? null,
        version: versionOfSubject(subject),
        // Rows stored for this subject that do not count now: outside the unpinned window, or an
        // older copy of a verdict that was recorded again.
        notCounted: allRowsOf(subject, dim).length - p.items.length,
        prior: p.prior,
        priorStrength: p.k0,
        items: p.items.map(({ row, weight, reliability, decay, similarity, ageDays }) => ({
          ts: row.ts, source: row.source, score: row.score, confidence: row.confidence, n: row.n,
          taskType: row.taskType ?? null, runId: row.runId ?? null, verdictKey: row.verdictKey ?? null, benchmark: row.benchmark ?? null, note: row.note ?? null,
          weight, reliability, decay, similarity, ageDays,
        })),
        evidenceWeight: p.sumW,
        precision: p.precision,
        score: p.score,
        confidence: p.confidence,
        amount: p.amount,
        spread: p.spread,
        stdError: p.stdError,
        agreement: p.agreement,
        samples: p.samples,
        benchmark: p.benchmark,
        execution: p.execution,
        sources: p.sources,
        source: p.source,
      }
    },
    /**
     * True until the subject has execution evidence of its own that still counts; a benchmark
     * alone leaves it cold, and so does an unpinned subject whose rows all fell out of its window.
     */
    cold(subject) {
      for (const rows of liveRows(subject)) if (rows.some((r) => r.source !== 'benchmark')) return false
      return true
    },
    /** Every subject with evidence, as `{ key, provider, family, model, version }`. */
    subjects: () => [...known.values()].map((s) => ({ ...s })),
    /** Observations that count for the subject now, across every dimension (the sum of `n`). */
    evidenceCount(subject) {
      let total = 0
      for (const rows of liveRows(subject)) for (const r of rows) total += r.n
      return total
    },
  }
  return api
}

const isSuccess = (status) => String(status ?? '').startsWith('accepted') || status === 'answered'
// A run that ran out of allowance or was stopped by the person says nothing about the work.
const NO_EVIDENCE = new Set(['paused_limit', 'stopped'])
const isWork = (a) => (a.role === 'primary' || a.role === 'retry') && !a.limitHit
const checksFailed = (a) => Array.isArray(a.checks) && a.checks.some((c) => c && c.passed === false)
// What a review assessment said about the work: accepted 1, sent back or handed to a person 0,
// anything else (a second review, a skipped reviewer) is not a verdict.
const verdictOf = (a) => (a?.action === 'accept' ? 1 : a?.action === 'retry' || a?.action === 'human' || a?.action === 'wrong' ? 0 : null)

// When a timestamp is, in ms; NaN for anything unreadable, which every comparison below refuses.
const at = (ts) => (typeof ts === 'string' ? Date.parse(ts) : NaN)
const verdictKeyOf = (f) => {
  const k = str(f?.sessionId) && str(f?.messageId) ? `${f.sessionId}/${f.messageId}` : null
  return k && VERDICT_KEY.test(k) ? k : null
}

/**
 * Is this like or dislike about this run? By runId when the verdict carries one. Otherwise by
 * session, and only when it names an agent and was given after this run's answer existed
 * (record.ts is written when the run ends) and before `until`, the next run in the session when
 * the caller knows it. A session verdict given before this run ended is about an earlier answer,
 * so crediting it here would count one verdict again for every later run of the same agent.
 */
function verdictIsAbout(f, record, until) {
  if (!f || VERDICT_SCORE[f.verdict] === undefined || f.tag === NOT_A_CAPABILITY_TAG) return false
  if (f.runId) return f.runId === record.runId
  if (!f.provider || !record.sessionId || f.sessionId !== record.sessionId) return false
  const given = at(f.ts); const ended = at(record.ts)
  if (!(given >= ended)) return false
  return until === undefined || until === null || given < at(until)
}

// One `human_outcome` row per dimension for each verdict about this run, credited to ONE attempt:
// the last scored attempt the verdict names, or the last work attempt (which produced the answer)
// when it names none. A verdict naming an agent that ran both first and last is still one
// verdict, credited once, to the attempt whose answer the person saw last.
function humanRows(record, verdicts, scored, { lastWork, reviewDims, until, push }) {
  for (const f of verdicts) {
    if (!verdictIsAbout(f, record, until)) continue
    const names = (x) => (f.provider === x.attempt.agent || f.provider === x.subject.provider) && (!f.model || !x.subject.model || f.model === x.subject.model)
    const target = f.provider ? scored.filter(names).at(-1) : scored.find((x) => x.attempt === lastWork)
    if (!target) continue
    const verdictKey = verdictKeyOf(f)
    for (const dim of reviewDims) push(target.subject, dim, 'human_outcome', VERDICT_SCORE[f.verdict], 0.8, verdictKey ? { verdictKey } : {})
  }
}

// The subject an attempt stood for, from what the attempt recorded and never from what is
// configured now: the run is in the past. router.js stamps every attempt with the model the agent
// was set to when it ran (its pinned llm.model, else the CLI's own setting), so the record is the
// answer. An attempt that recorded no model ran on whatever the CLI defaulted to, which nobody
// named; it stays unnamed, which cannot move when settings change later. Falling back to today's
// model instead moved a past run onto a model configured since, so a verdict re-posted on it
// named no scored attempt any more and was retracted by a settings change. A version is taken
// from the attempt, or from versionOf when the caller passes it (only for a run that just ended).
function subjectOfAttempt(attempt, def, { versionOf, priors }) {
  const recorded = str(attempt.model)
  const asRan = def.llm ? { ...def, llm: { ...def.llm, model: recorded ?? undefined } } : def
  return subjectOf(asRan, { modelOf: () => recorded ?? undefined, versionOf: (d, m) => str(attempt.modelVersion) ?? versionOf?.(d, m), priors })
}

/**
 * True when the attempt a verdict is credited to ran on an agent that is no longer configured,
 * and that is the ONLY reason the verdict gives no rows for this run: it is a like or dislike
 * about capability (no `too slow` tag), it is about this run, the run gives evidence at all, and
 * the answering attempt (the scored one it names, or the last work attempt when it names none)
 * is missing from `agents`. An agent the verdict is not about, such as a reviewer, is never the
 * reason. A verdict naming a provider rather than an agent id may be about any missing scored
 * attempt, since a deleted agent's provider can no longer be read.
 * @param {object} verdict one feedback.js row
 * @param {object} record  the history.jsonl row of the run it is about
 * @param {{ agents?: object[] }} [deps]
 */
export function answererUnconfigured(verdict, record, { agents = [] } = {}) {
  if (!record || NO_EVIDENCE.has(record.finalStatus) || !verdictIsAbout(verdict, record)) return false
  const work = (Array.isArray(record.attempts) ? record.attempts : []).filter(isWork)
  if (!work.length) return false
  const scored = work.length === 1 ? work : [work[0], work.at(-1)]
  const gone = (a) => !(agents ?? []).some((d) => d?.id === a.agent)
  if (!verdict.provider) return gone(work.at(-1))
  const named = scored.filter((a) => a.agent === verdict.provider)
  return named.length ? gone(named.at(-1)) : scored.some(gone)
}

// What evidenceFromRun and evidenceFromFeedback share: the work attempts worth scoring, each with
// the subject it stands for, and the dimensions the task type exercises.
function runShape(record, { versionOf, agents, priors, now }) {
  if (!record || NO_EVIDENCE.has(record.finalStatus)) return null
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const work = attempts.filter(isWork)
  if (!work.length) return null
  const taskType = str(record.routing?.taskType) ?? 'other'
  const dims = TASK_DIMENSIONS[taskType] ?? TASK_DIMENSIONS.other
  const first = work[0]; const last = work.at(-1)
  // The version reported now says what runs NOW. It is only the version that ran this record when
  // the run has just ended; for an older record (a backfill, a verdict given later) it may be one
  // installed since, and a past run must not be credited to it, least of all under a pinned id
  // that nothing bounds in time. Such a record without a modelVersion of its own is keyed by its
  // model name: unpinned, so the registry bounds it by UNPINNED_WINDOW_DAYS.
  const clock = now?.()
  const nowMs = typeof clock === 'number' ? clock : Date.parse(clock)
  const justEnded = Math.abs(nowMs - at(record.ts)) <= REPORTED_VERSION_MS
  const scored = []
  for (const attempt of first === last ? [first] : [first, last]) {
    const def = agents.find((a) => a.id === attempt.agent)
    if (!def) continue // an agent no longer configured: no subject to credit, nothing invented
    scored.push({ attempt, subject: subjectOfAttempt(attempt, def, { versionOf: justEnded ? versionOf : undefined, priors }) })
  }
  const out = []
  const push = (subject, dimension, source, score, confidence, extra = {}) => out.push({
    ...(record.ts ? { ts: record.ts } : {}), subject, dimension, score, source, confidence, n: 1, taskType, ...(record.runId ? { runId: record.runId } : {}), ...extra,
  })
  return { attempts, work, first, last, taskType, dims, reviewDims: dims.filter((d) => d !== 'reliability'), scored, out, push }
}

/**
 * Evidence rows from one history.jsonl record, as router.js writes it. Limit-hit attempts,
 * paused and stopped runs give nothing. The first and the last work attempt are scored, on the
 * dimensions the task type exercises: `objective_deterministic` 1 when the run was accepted on
 * that attempt with its checks passing, 0 when another agent had to retry after it or its checks
 * failed; `first_pass_quality` 1 when the first attempt carried the run alone; `reliability` 1
 * when the attempt completed; an `independent_review` row from Jev's assessment of the attempt or
 * from a completed review by another agent; a `human_outcome` row from a like or dislike that is
 * about THIS run (verdictIsAbout), credited to one attempt and keyed by the verdict so the
 * registry counts it once however often it is derived. Nothing from the record's text reaches a
 * row: ids, numbers, categories and timestamps only.
 * @param {object} record  one history.jsonl row
 * @param {{ versionOf?: Function, agents?: object[], feedback?: object[], until?: string, priors?: object, now?: () => number|string }} [deps]
 *   `until` is the ts of the next run in the same session, when known (a backfill over history).
 *   `versionOf` is consulted only for a record that ended within REPORTED_VERSION_MS of `now`.
 *   No `modelOf`: the model is the one each attempt recorded (subjectOfAttempt), never today's.
 */
export function evidenceFromRun(record, { versionOf, agents = [], feedback = [], until, priors, now = Date.now } = {}) {
  const shape = runShape(record, { versionOf, agents, priors, now })
  if (!shape) return []
  const { attempts, work, first, last, dims, reviewDims, scored, out, push } = shape
  // Two dimensions have their own rule below, so the task loop leaves them out.
  const taskDims = dims.filter((d) => d !== 'first_pass_quality' && d !== 'reliability')
  const success = isSuccess(record.finalStatus)
  // Assessments line up with the attempts that were not limit hits, in order (router.js).
  const assessed = attempts.filter((a) => !a.limitHit)
  const assessmentOf = (attempt) => record.assessments?.[assessed.indexOf(attempt)]
  for (const { attempt, subject } of scored) {
    const idx = attempts.indexOf(attempt)
    const followedByOther = work.some((w) => attempts.indexOf(w) > idx && w.agent !== attempt.agent)
    const failed = checksFailed(attempt)
    const objective = attempt === last && success && !failed ? 1 : followedByOther || failed ? 0 : null
    if (objective !== null) for (const dim of taskDims) push(subject, dim, 'objective_deterministic', objective, 0.9)
    if (attempt === first) push(subject, 'first_pass_quality', 'objective_deterministic', success && work.length === 1 ? 1 : 0, 0.9)
    push(subject, 'reliability', 'objective_deterministic', attempt.stopReason === 'completed' ? 1 : 0, 0.9)
    // The last word on this attempt: Jev's own assessment, or a completed review by another agent
    // before the next work attempt.
    const own = assessmentOf(attempt)
    let verdict = own?.mode === 'jev' ? verdictOf(own) : null
    for (let i = idx + 1; i < attempts.length && !isWork(attempts[i]); i++) {
      const a = attempts[i]
      if (a.role !== 'review' || a.agent === attempt.agent || a.stopReason !== 'completed' || a.limitHit) continue
      const v = verdictOf(assessmentOf(a))
      if (v !== null) verdict = v
    }
    if (verdict !== null) for (const dim of reviewDims) push(subject, dim, 'independent_review', verdict, 0.7)
  }
  humanRows(record, Array.isArray(feedback) ? feedback : [], scored, { lastWork: last, reviewDims, until, push })
  return out
}

/**
 * The `human_outcome` rows one like or dislike gives, for the run it is about, and nothing else:
 * the call to make when a verdict arrives, since a run's own evidence was recorded when it ended,
 * before anyone could judge its answer. The caller passes the run the verdict is about (the run
 * it was credited to before, else the last run of the session that ended before it); a verdict
 * that is not about that run gives nothing. Rows carry the verdict's key, so a changed verdict
 * replaces the earlier one in the registry.
 * @param {object} verdict  one feedback.js row
 * @param {object} record   the history.jsonl row of the run it is about
 * @param {{ versionOf?: Function, agents?: object[], until?: string, priors?: object, now?: () => number|string }} [deps]
 */
export function evidenceFromFeedback(verdict, record, { versionOf, agents = [], until, priors, now = Date.now } = {}) {
  const shape = runShape(record, { versionOf, agents, priors, now })
  if (!shape) return []
  humanRows(record, [verdict], shape.scored, { lastWork: shape.last, reviewDims: shape.reviewDims, until, push: shape.push })
  return shape.out
}

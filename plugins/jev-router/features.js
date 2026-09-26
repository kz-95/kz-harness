// The feature schema: what a local routing classifier is allowed to see, and nothing else.
//
// Every routing domain turns its inputs into one flat, named feature vector here, so the
// training store, the classifier and the decision engine cannot disagree about what a column
// means. The schema is versioned: an artifact trained on version 1 refuses to serve version 2
// inputs, which is what keeps a renamed feature from silently becoming a wrong prediction.
//
// Two rules are enforced by construction. First, a feature is only ever something that was
// genuinely known at decision time: nothing here reads an outcome, a check result or an
// assessment into a routing-time vector (outcome features are a separate builder for the
// outcome domain, and it is only called after the run). Second, candidates are anonymous: a
// resource is RESOURCE_A with properties, never a provider name, so a classifier learns "strong
// coding, scarce, metered" and not "Claude" or "GPT".
import { REQUIREMENT_DIMENSIONS } from './routing-policy.js'

export const FEATURE_SCHEMA_VERSION = 1

/** Numeric feature buckets for hashed text tokens. Small on purpose: this is a router, not a language model. */
export const TEXT_BUCKETS = 2048

const MARGINAL = { none: 0, low: 0.5, metered: 1 }
const LATENCY = { fast: 0, medium: 0.5, slow: 1 }
const AVAILABILITY = { ok: 0, near: 0.5, unknown: 0.25 }
const TIER = { weak: 0, standard: 0.33, strong: 0.66, frontier: 1, unknown: 0.5 }
const SOURCE = { local: 0, api: 0.5, subscription: 1 }

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const r3 = (x) => Math.round(x * 1000) / 1000

/**
 * FNV-1a over a string, for feature hashing. Deterministic across runs and platforms, which
 * matters because the same token must land in the same bucket at training and at inference.
 */
export function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'this', 'that', 'with', 'be', 'as', 'at', 'by', 'from'])

/**
 * Hashed unigram and bigram counts of a task text: `h<bucket>` -> log1p(count). Tokens are
 * lower-cased words and identifier-like runs; stop words are dropped from unigrams but kept
 * inside bigrams, where "fix the test" and "write the test" differ by them.
 */
export function hashedText(text, { buckets = TEXT_BUCKETS, prefix = 'h' } = {}) {
  const out = {}
  const tokens = String(text ?? '').toLowerCase().match(/[a-z0-9_][a-z0-9_.-]*/g) ?? []
  const bump = (key) => { const k = `${prefix}${fnv1a(key) % buckets}`; out[k] = (out[k] ?? 0) + 1 }
  for (let i = 0; i < tokens.length; i++) {
    if (!STOP.has(tokens[i])) bump(`u:${tokens[i]}`)
    if (i + 1 < tokens.length) bump(`b:${tokens[i]} ${tokens[i + 1]}`)
  }
  for (const k of Object.keys(out)) out[k] = r3(Math.log1p(out[k]))
  return out
}

/**
 * Routing-time features of the request itself, for the task-classification domain: a few
 * shape signals plus hashed text. `context` is the workspace summary the router already
 * gathers (file counts, scripts, dependencies); only counts are read, never contents.
 * @returns {{ numeric: Record<string, number>, categorical: Record<string, string> }}
 */
export function taskTextFeatures(task, { context = {}, modalities = ['text'] } = {}) {
  const t = String(task ?? '')
  const lines = t.split('\n')
  const numeric = {
    text_length_log: r3(Math.log1p(t.length)),
    line_count_log: r3(Math.log1p(lines.length)),
    question_mark: /\?\s*$/.test(t.trim()) || /\?/.test(t) ? 1 : 0,
    code_fence: /```/.test(t) ? 1 : 0,
    has_path: /[\w-]+\/[\w./-]+|\w+\.(js|ts|py|go|rs|java|cs|md|json|yml|yaml|css|html)\b/.test(t) ? 1 : 0,
    has_error_text: /\b(error|exception|traceback|stack ?trace|failed|failing|crash)\b/i.test(t) ? 1 : 0,
    has_image: modalities.includes('image') ? 1 : 0,
    file_count_log: r3(Math.log1p(num(context.fileCount ?? context.files))),
    dependency_count_log: r3(Math.log1p(num(context.dependencyCount ?? (Array.isArray(context.dependencies) ? context.dependencies.length : 0)))),
    has_tests_script: Array.isArray(context.scripts) && context.scripts.some((s) => /test/i.test(String(s))) ? 1 : 0,
    changed_files_log: r3(Math.log1p(num(Array.isArray(context.changedFiles) ? context.changedFiles.length : context.changedFileCount))),
    ...hashedText(t),
  }
  return { numeric, categorical: { modality: modalities.includes('image') ? 'text+image' : 'text' } }
}

/**
 * Features of a task profile (the task classifier's output), for the domains that decide what
 * to do about it: strategy, second opinion, frontier escalation. Everything here is known before
 * any resource runs.
 */
export function profileFeatures(profile = {}) {
  const numeric = { complexity: num(profile.complexity, 0.5), risk: num(profile.risk, 0.5) }
  for (const d of REQUIREMENT_DIMENSIONS) numeric[`req_${d}`] = num(profile.requirements?.[d], 0)
  numeric.second_opinion_hint = num(profile.needsSecondOpinion, 0)
  numeric.needs_tests_hint = num(profile.needsTests, 0)
  numeric.explanation_share = r3(numeric.req_explanation / Math.max(1e-6, numeric.req_explanation + numeric.req_coding))
  return {
    numeric,
    categorical: {
      task_type: String(profile.taskType ?? 'other'),
      minimum_capability: String(profile.minimumCapability ?? 'unknown'),
      capability: String(profile.capability ?? 'unknown'),
    },
  }
}

/**
 * Anonymous candidate keys, RESOURCE_A upward, in a stable order so the same pool maps the same
 * way on every call. The mapping is returned for the inspector; it is never sent to Jev.
 */
export function anonymize(candidates) {
  const sorted = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const label = (i) => `RESOURCE_${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`
  const map = new Map(sorted.map((c, i) => [c.id, label(i)]))
  return { keyOf: (id) => map.get(id), idOf: (key) => [...map].find(([, k]) => k === key)?.[0], entries: [...map].map(([id, key]) => ({ id, key })) }
}

/**
 * A model string, when it is shaped like a model id: it carries a version digit or a separator
 * ('claude-opus-5', 'gpt-5.6', 'o3', 'qwen2.5-coder:7b', 'deepseek-flash'). A model setting is
 * often an ALIAS instead ('best', 'default', 'opus', 'sonnet'), and an alias is not specific:
 * handed to the masker as a name, 'best' would be replaced inside every reason that says "the
 * best fit". The vendor and family words among the aliases are masked anyway, as brand terms
 * (jev.js), so nothing identifying is lost by leaving an alias out. The routing call and the
 * review call both name agents through this, so both hide the same model ids.
 */
export const modelIdOf = (m) => (typeof m === 'string' && (/\d/.test(m) || /[-.:/]/.test(m.trim())) ? m : undefined)

/**
 * The names an agent goes by, for the masker of every Jev call that carries the anonymous table:
 * its display name, its provider and model provider, its configured model, and the model its CLI
 * really runs by its own config (`modelOf`), each model only when shaped like an id. The masker
 * (jev.js anonymity) adds the id, refuses every generic word (a provider of `spawn`, a model
 * provider of `local`), and reads a name several agents share as the placeholder, so a provider
 * word is masked exactly where it names one agent. The routing call and the review call both name
 * agents through this, so a name hidden in one call is hidden in the other.
 */
export const identityNames = (a, modelOf) => [a?.name, a?.provider, a?.llm?.provider, modelIdOf(a?.llm?.model), modelIdOf(modelOf?.(a))]

/**
 * One candidate against one task profile, for the ranking classifier. Task-level features are
 * repeated per candidate and multiplied into the candidate ones, because a linear scorer can only
 * learn "scarcity matters more when the task is easy" from an explicit product.
 * @param {object} profile   task profile
 * @param {object} c         candidate as decision.js builds it (capabilities, scarcity, cost, ...)
 * @param {object} [pool]    pool-level context: { size, bestFit, cheapestFit }
 */
export function candidateFeatures(profile = {}, c = {}, pool = {}) {
  const req = profile.requirements ?? {}
  const caps = c.capabilities ?? {}
  const numeric = {}
  let fitSum = 0; let reqSum = 0; let minGap = 0; let confSum = 0; let confN = 0
  for (const d of REQUIREMENT_DIMENSIONS) {
    const r = num(req[d], 0)
    const cap = caps[d]
    const score = num(cap?.score, 0.5)
    const conf = num(cap?.confidence, 0)
    numeric[`cap_${d}`] = r3(score)
    numeric[`capconf_${d}`] = r3(conf)
    numeric[`gap_${d}`] = r3(Math.max(0, r - score))
    fitSum += r * score; reqSum += r
    if (r >= 0.5) minGap = Math.max(minGap, r - score)
    confSum += conf * r; confN += r
  }
  const fit = reqSum > 0 ? fitSum / reqSum : 0.5
  const complexity = num(profile.complexity, 0.5)
  const risk = num(profile.risk, 0.5)
  const scarcity = num(c.scarcity, 0)
  Object.assign(numeric, {
    fit: r3(fit),
    fit_confidence: r3(confN > 0 ? confSum / confN : 0),
    max_gap: r3(minGap),
    tier: TIER[c.tier] ?? 0.5,
    scarcity: r3(scarcity),
    scarcity_confidence: r3(num(c.scarcityConfidence, 0)),
    reset_proximity: r3(num(c.resetProximity, 0)),
    marginal_cost: MARGINAL[c.marginalCost] ?? 0.5,
    expected_cost: r3(num(c.expectedCost?.total, 0.5)),
    latency: LATENCY[c.latency] ?? 0.5,
    availability: AVAILABILITY[c.availability] ?? 0.25,
    source: SOURCE[c.source] ?? 0.5,
    reliability: r3(num(c.reliability?.score, 0.5)),
    reliability_confidence: r3(num(c.reliability?.confidence, 0)),
    first_pass: r3(num(caps.first_pass_quality?.score, 0.5)),
    cold: c.cold ? 1 : 0,
    evidence_samples_log: r3(Math.log1p(num(c.evidenceSamples, 0))),
    complexity: r3(complexity),
    risk: r3(risk),
    // Interactions the design calls out: scarcity matters less as the task gets harder or riskier,
    // fit matters more as it gets riskier, and a metered resource is cheaper when the job is small.
    scarcity_x_ease: r3(scarcity * (1 - complexity)),
    risk_x_fit: r3(risk * fit),
    risk_x_gap: r3(risk * minGap),
    cost_x_ease: r3((MARGINAL[c.marginalCost] ?? 0.5) * (1 - complexity)),
    fit_vs_best: r3(fit - num(pool.bestFit, fit)),
    fit_vs_cheapest: r3(fit - num(pool.cheapestFit, fit)),
    pool_size_log: r3(Math.log1p(num(pool.size, 1))),
  })
  return { numeric, categorical: { source: String(c.source ?? 'unknown'), tier: String(c.tier ?? 'unknown') } }
}

/**
 * The pool as a whole, for the strategy domain: is a frontier resource there, how scarce is
 * it, is a cheap sufficient one there. Combined with the profile features by the caller.
 */
export function poolFeatures(profile = {}, candidates = []) {
  const fits = candidates.map((c) => candidateFeatures(profile, c).numeric)
  const by = (pred) => candidates.map((c, i) => [c, fits[i]]).filter(([c]) => pred(c))
  const best = fits.reduce((m, f) => Math.max(m, f.fit), 0)
  const frontier = by((c) => c.tier === 'frontier')
  const cheap = by((c) => c.marginalCost !== 'metered' ? c.source === 'local' : c.marginalCost === 'metered')
  const cheapFit = cheap.reduce((m, [, f]) => Math.max(m, f.fit), 0)
  const distinct = new Set(candidates.map((c) => c.tier)).size
  return {
    numeric: {
      pool_size_log: r3(Math.log1p(candidates.length)),
      best_fit: r3(best),
      cheap_fit: r3(cheapFit),
      cheap_gap: r3(best - cheapFit),
      frontier_available: frontier.length ? 1 : 0,
      frontier_scarcity: r3(frontier.reduce((m, [c]) => Math.max(m, num(c.scarcity, 0)), 0)),
      cheap_available: cheap.length ? 1 : 0,
      local_available: candidates.some((c) => c.source === 'local') ? 1 : 0,
      tier_variety: r3(distinct / 4),
      any_cold: candidates.some((c) => c.cold) ? 1 : 0,
    },
    categorical: {},
  }
}

/**
 * Outcome-domain features: the deterministic facts the reviewer had in front of it after an
 * attempt. Called only after execution; nothing here may feed a routing-time vector. Jev's own
 * yes/no judgments (addressed, complete, regression risk) are deliberately NOT features: they
 * are the teacher's inputs, and a local classifier that needed them could never take over
 * without calling Jev, which is the whole point of it maturing.
 */
export function outcomeFeatures({ profile = {}, strategy, checks = {}, attempts = [], reviewed = false, touchedCode = false, diff = {} } = {}) {
  const work = attempts.filter((a) => a.role === 'primary' || a.role === 'retry')
  const last = attempts.at(-1) ?? {}
  const p = profileFeatures(profile)
  const answer = String(last.answerText ?? last.answerExcerpt ?? '')
  return {
    numeric: {
      ...p.numeric,
      checks_failing: num(checks.failing?.length, 0) > 0 ? 1 : 0,
      checks_regressed: num(checks.regressed?.length, 0) > 0 ? 1 : 0,
      checks_run: num(checks.results?.length, 0) > 0 ? 1 : 0,
      attempt_index: attempts.length,
      retries_so_far: Math.max(0, work.length - 1),
      reviewed: reviewed ? 1 : 0,
      touched_code: touchedCode ? 1 : 0,
      stop_completed: last.stopReason === 'completed' ? 1 : 0,
      changed_files_log: r3(Math.log1p(num(last.changedFiles?.length, 0))),
      answer_length_log: r3(Math.log1p(answer.length)),
      answer_mentions_blocker: /\b(cannot|can't|unable|blocked|need(s)? (your|a) (decision|permission|input)|clarif)/i.test(answer) ? 1 : 0,
      diff_files_log: r3(Math.log1p(num(Array.isArray(diff.files) ? diff.files.length : 0))),
      diff_size_log: r3(Math.log1p(String(diff.stat ?? '').length)),
    },
    categorical: { ...p.categorical, strategy: String(strategy ?? 'unknown'), last_role: String(last.role ?? 'none') },
  }
}

/** Merge feature sets, later ones winning on a name clash. */
export function mergeFeatures(...sets) {
  const out = { numeric: {}, categorical: {} }
  for (const s of sets) {
    if (!s) continue
    Object.assign(out.numeric, s.numeric ?? {})
    Object.assign(out.categorical, s.categorical ?? {})
  }
  return out
}

/** A feature set is well formed: finite numerics, string categoricals, nothing else. Throws otherwise. */
export function validateFeatures(f) {
  if (!f || typeof f !== 'object') throw new Error('features: an object with numeric and categorical maps is required')
  for (const [k, v] of Object.entries(f.numeric ?? {})) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`features: numeric ${k} must be a finite number`)
  for (const [k, v] of Object.entries(f.categorical ?? {})) if (typeof v !== 'string') throw new Error(`features: categorical ${k} must be a string`)
  return f
}

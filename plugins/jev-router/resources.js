// Resource adapters: one normalised snapshot per agent, whatever the provider counts in.
//
// A subscription counts in rolling windows, a prepaid API key in money, a local model in
// nothing at all. Each provider's way of saying "how much is left" is translated here, in its
// adapter, into the same Limit and ResourceSnapshot shapes, so the governor and the decision
// engine read one vocabulary and never a provider name. Provider semantics live in the adapters
// and nowhere else: a new provider is a registered adapter, not another branch downstream.
//
// Two rules are enforced by construction. Unknown is never invented: a row without windows or a
// balance yields no limits, confidence 0 and usageSource 'unknown', never a guessed figure. And
// every limit carries the source it came from and how far it can be trusted, so a stale cache
// and a live provider answer are not the same number even when they agree. When one limit mixes
// a measured figure with figures worked out from it, `fieldSources` gives the worked-out ones
// their own source and confidence, so an estimate never borrows the provider's word.
import { resolvePolicy } from './routing-policy.js'

export const LIMIT_KINDS = Object.freeze(['rolling_window', 'fixed_window', 'token_budget', 'request_budget', 'monetary_budget', 'credit_budget', 'provider_defined'])
export const LIMIT_SCOPES = Object.freeze(['account', 'plan', 'model', 'model_group', 'feature'])
export const USAGE_SOURCES = Object.freeze(['provider_api', 'provider_cli', 'local_cache', 'local_observation', 'estimate', 'manual', 'unknown'])
export const RESOURCE_SOURCES = Object.freeze(['subscription', 'api', 'local'])
export const AVAILABILITY_STATES = Object.freeze(['ok', 'near', 'stopped', 'exhausted', 'unknown', 'unavailable'])
export const MARGINAL_COSTS = Object.freeze(['none', 'low', 'metered'])

/**
 * How far a usage figure can be trusted, by where it came from. Data quality of a source, not
 * a routing threshold: the policy says what to do with a number, this says how solid it is.
 * `errored` is a row whose last refresh failed but still carries its previous figures.
 * `local_observation` is a figure this codebase recorded itself (a balance high-water mark) that
 * no provider vouches for; `estimate` is a figure worked out from others by an assumption. For a
 * figure derived from a measurement they multiply that measurement's confidence, because a
 * derived figure can be no more solid than what it was derived from.
 */
export const USAGE_CONFIDENCE = Object.freeze({ provider_api: 0.95, provider_cli: 0.9, local_cache: 0.8, local_observation: 0.6, estimate: 0.4, manual: 1, errored: 0.3 })

/** The figures a limit can give a provenance of their own; any not listed share the limit's. */
export const PROVENANCE_FIELDS = Object.freeze(['used', 'remaining', 'total', 'ratioUsed'])

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isUnit = (v) => isNum(v) && v >= 0 && v <= 1
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
const fail = (message) => { throw new Error(message) }
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const orNull = (v) => (v === undefined ? null : v)
const toIso = (ms) => new Date(ms).toISOString()
const toMs = (now) => {
  const v = typeof now === 'function' ? now() : now
  if (isNum(v)) return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? Date.now() : t
}

/**
 * One limit, checked. Throws naming the field, because a limit with a ratio over 1 or a source
 * nobody defined would otherwise reach the governor as a real number.
 * @param {object} l  a Limit as in the contract
 * @param {string} [where]  prefix for the error message
 */
export function validateLimit(l, where = 'limit') {
  if (!l || typeof l !== 'object' || Array.isArray(l)) fail(`${where}: an object is required`)
  if (typeof l.id !== 'string' || !l.id) fail(`${where}: id must be a non-empty string`)
  const w = `${where} ${l.id}`
  if (!LIMIT_KINDS.includes(l.kind)) fail(`${w}: kind must be one of ${LIMIT_KINDS.join(', ')}`)
  if (!LIMIT_SCOPES.includes(l.scope)) fail(`${w}: scope must be one of ${LIMIT_SCOPES.join(', ')}`)
  for (const f of ['used', 'remaining', 'total', 'durationMinutes']) if (l[f] != null && !isNum(l[f])) fail(`${w}: ${f} must be a finite number or null`)
  // Remaining may go below zero (an overdrawn balance), but nothing can have been used a
  // negative amount of, a total of zero has nothing to divide by, and a window lasts some time.
  if (l.used != null && l.used < 0) fail(`${w}: used must not be negative`)
  if (l.total != null && !(l.total > 0)) fail(`${w}: total must be greater than 0 or null`)
  if (l.durationMinutes != null && !(l.durationMinutes > 0)) fail(`${w}: durationMinutes must be greater than 0 or null`)
  if (l.ratioUsed != null && !isUnit(l.ratioUsed)) fail(`${w}: ratioUsed must be a number between 0 and 1 or null`)
  if (l.unit != null && typeof l.unit !== 'string') fail(`${w}: unit must be a string or null`)
  if (l.resetsAt != null && !isIso(l.resetsAt)) fail(`${w}: resetsAt must be an ISO timestamp or null`)
  if (l.rolling != null && typeof l.rolling !== 'boolean') fail(`${w}: rolling must be true, false or null`)
  // The two window kinds are a claim about how the allowance comes back, so the rolling flag
  // may leave it unsaid but must not contradict it.
  if (l.kind === 'rolling_window' && l.rolling === false) fail(`${w}: rolling must not be false on a rolling_window`)
  if (l.kind === 'fixed_window' && l.rolling === true) fail(`${w}: rolling must not be true on a fixed_window`)
  if (!USAGE_SOURCES.includes(l.source)) fail(`${w}: source must be one of ${USAGE_SOURCES.join(', ')}`)
  if (!isUnit(l.confidence)) fail(`${w}: confidence must be a number between 0 and 1`)
  if (l.fieldSources != null) {
    if (!isPlainObject(l.fieldSources)) fail(`${w}: fieldSources must be an object or null`)
    for (const [f, p] of Object.entries(l.fieldSources)) {
      if (!PROVENANCE_FIELDS.includes(f)) fail(`${w}: fieldSources.${f} must be one of ${PROVENANCE_FIELDS.join(', ')}`)
      if (!isPlainObject(p)) fail(`${w}: fieldSources.${f} must be an object`)
      if (!USAGE_SOURCES.includes(p.source)) fail(`${w}: fieldSources.${f}.source must be one of ${USAGE_SOURCES.join(', ')}`)
      if (!isUnit(p.confidence)) fail(`${w}: fieldSources.${f}.confidence must be a number between 0 and 1`)
    }
  }
  if (!isIso(l.checkedAt)) fail(`${w}: checkedAt must be an ISO timestamp`)
  return l
}

/**
 * Where one figure of a limit came from and how far it can be trusted: its own entry in
 * `fieldSources` when it has one, else the limit's. Readers that weigh a figure (the governor)
 * ask this rather than the limit, so an estimate is weighed as an estimate.
 * @param {object} l  a Limit
 * @param {string} field  one of PROVENANCE_FIELDS
 * @returns {{ source: string, confidence: number }}
 */
export function provenanceOf(l, field) {
  const own = l?.fieldSources?.[field]
  if (own) return { source: own.source, confidence: isUnit(own.confidence) ? own.confidence : 0 }
  return { source: USAGE_SOURCES.includes(l?.source) ? l.source : 'unknown', confidence: isUnit(l?.confidence) ? l.confidence : 0 }
}

/**
 * One resource snapshot, checked, limits included. Throws naming the field.
 * @param {object} s  a ResourceSnapshot as in the contract
 */
export function validateSnapshot(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('snapshot: an object is required')
  if (typeof s.resourceId !== 'string' || !s.resourceId) fail('snapshot: resourceId must be a non-empty string')
  const w = `snapshot ${s.resourceId}`
  if (typeof s.provider !== 'string' || !s.provider) fail(`${w}: provider must be a non-empty string`)
  if (typeof s.adapter !== 'string' || !s.adapter) fail(`${w}: adapter must be a non-empty string`)
  if (!RESOURCE_SOURCES.includes(s.source)) fail(`${w}: source must be one of ${RESOURCE_SOURCES.join(', ')}`)
  if (s.model != null && typeof s.model !== 'string') fail(`${w}: model must be a string or null`)
  if (s.modelVersion != null && typeof s.modelVersion !== 'string') fail(`${w}: modelVersion must be a string or null`)
  if (s.plan != null) {
    if (typeof s.plan !== 'object') fail(`${w}: plan must be an object or null`)
    if (s.plan.name != null && typeof s.plan.name !== 'string') fail(`${w}: plan.name must be a string or null`)
    if (!USAGE_SOURCES.includes(s.plan.source)) fail(`${w}: plan.source must be one of ${USAGE_SOURCES.join(', ')}`)
    if (!isUnit(s.plan.confidence)) fail(`${w}: plan.confidence must be a number between 0 and 1`)
  }
  if (!Array.isArray(s.limits)) fail(`${w}: limits must be an array`)
  s.limits.forEach((l, i) => validateLimit(l, `${w}: limits[${i}]`))
  const a = s.availability
  if (!a || typeof a !== 'object') fail(`${w}: availability must be an object`)
  if (!AVAILABILITY_STATES.includes(a.state)) fail(`${w}: availability.state must be one of ${AVAILABILITY_STATES.join(', ')}`)
  if (a.until != null && !isIso(a.until)) fail(`${w}: availability.until must be an ISO timestamp or null`)
  if (a.reason != null && typeof a.reason !== 'string') fail(`${w}: availability.reason must be a string or null`)
  if (a.loggedIn != null && typeof a.loggedIn !== 'boolean') fail(`${w}: availability.loggedIn must be true, false or null`)
  const e = s.economics
  if (!e || typeof e !== 'object') fail(`${w}: economics must be an object`)
  if (!MARGINAL_COSTS.includes(e.marginalCost)) fail(`${w}: economics.marginalCost must be one of ${MARGINAL_COSTS.join(', ')}`)
  if (e.pricing != null && typeof e.pricing !== 'object') fail(`${w}: economics.pricing must be an object or null`)
  if (e.rateNow != null && typeof e.rateNow !== 'string') fail(`${w}: economics.rateNow must be a string or null`)
  if (e.peak != null && typeof e.peak !== 'boolean') fail(`${w}: economics.peak must be true, false or null`)
  if (e.budget != null) {
    if (typeof e.budget !== 'object') fail(`${w}: economics.budget must be an object or null`)
    for (const f of ['remaining', 'soft', 'hard']) if (e.budget[f] != null && !isNum(e.budget[f])) fail(`${w}: economics.budget.${f} must be a finite number or null`)
    if (e.budget.currency != null && typeof e.budget.currency !== 'string') fail(`${w}: economics.budget.currency must be a string or null`)
  }
  if (s.hardware != null) {
    if (typeof s.hardware !== 'object') fail(`${w}: hardware must be an object or null`)
    for (const f of ['vramGB', 'ramGB', 'contextTokens', 'tokensPerSecond']) if (s.hardware[f] != null && !isNum(s.hardware[f])) fail(`${w}: hardware.${f} must be a finite number or null`)
  }
  if (!USAGE_SOURCES.includes(s.usageSource)) fail(`${w}: usageSource must be one of ${USAGE_SOURCES.join(', ')}`)
  if (!isUnit(s.confidence)) fail(`${w}: confidence must be a number between 0 and 1`)
  if (!isIso(s.checkedAt)) fail(`${w}: checkedAt must be an ISO timestamp`)
  return s
}

const ADAPTER_METHODS = ['matches', 'discoverResources', 'getUsage', 'getCapabilities', 'getEconomics', 'getAvailability']

/**
 * Adapters by id, first registered wins a match. `adapterFor` returns null when nothing
 * matches; `snapshotResources` then falls back to the generic adapter on its own.
 */
export function createAdapterRegistry() {
  const byId = new Map()
  return {
    register(adapter) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id) fail('adapter: id must be a non-empty string')
      for (const m of ADAPTER_METHODS) if (typeof adapter[m] !== 'function') fail(`adapter ${adapter.id}: ${m} must be a function`)
      if (byId.has(adapter.id)) fail(`adapter ${adapter.id} is already registered`)
      byId.set(adapter.id, adapter)
      return adapter
    },
    all: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    adapterFor: (agentDef) => [...byId.values()].find((a) => { try { return !!a.matches(agentDef) } catch { return false } }) ?? null,
  }
}

// --- shared pieces the adapters are built from ------------------------------------------

/** A Limit with every optional field present as null, so readers never meet undefined. */
const limit = (fields) => ({
  used: null, remaining: null, total: null, unit: null, ratioUsed: null, resetsAt: null, durationMinutes: null, rolling: null, fieldSources: null, ...fields,
})

const checkedAtOf = (ctx) => (isIso(ctx.usageRow?.checkedAt) ? ctx.usageRow.checkedAt : toIso(toMs(ctx.now)))

/**
 * Subscription windows as rolling limits. A row whose refresh failed keeps its old windows at
 * `errored` confidence: the figures are real, just not fresh. No windows means no limits.
 */
function windowLimits(ctx, source) {
  const row = ctx.usageRow
  const windows = (row?.windows ?? []).filter((w) => w && isNum(w.usedPercent))
  const confidence = row?.error ? USAGE_CONFIDENCE.errored : USAGE_CONFIDENCE[source]
  const checkedAt = checkedAtOf(ctx)
  return windows.map((w, i) => limit({
    id: String(w.name ?? (isNum(w.minutes) ? `${w.minutes}m` : `window${i}`)),
    kind: 'rolling_window',
    scope: 'account',
    used: clamp(w.usedPercent, 0, 100),
    remaining: 100 - clamp(w.usedPercent, 0, 100),
    total: 100,
    unit: 'percent',
    ratioUsed: clamp(w.usedPercent / 100),
    resetsAt: isIso(w.resetsAt) ? w.resetsAt : null,
    durationMinutes: isNum(w.minutes) && w.minutes > 0 ? w.minutes : null,
    rolling: true,
    source,
    confidence,
    checkedAt,
  }))
}

/** An operator's own word on a plan wins over anything a provider reports. */
const manualPlan = (ctx) => {
  const name = ctx.config?.resources?.plans?.[ctx.agentDef?.id]
  return typeof name === 'string' && name ? { name: name.toLowerCase(), source: 'manual', confidence: USAGE_CONFIDENCE.manual } : null
}

const describeState = (state, until) => {
  const when = until ? `, until ${until}` : ''
  if (state === 'stopped') return `usage limit reached${when}`
  if (state === 'exhausted') return `provider reported exhaustion${when}`
  return null
}

/**
 * ok / near / stopped / exhausted from the row's state; not signed in wins over all of them,
 * with the readiness detail as the reason. No row and no readiness is unknown, unless the
 * adapter says its resource needs no check (local).
 */
function availabilityOf(ctx, { fallback = 'unknown' } = {}) {
  const { usageRow: row, ready } = ctx
  const loggedIn = typeof ready?.loggedIn === 'boolean' ? ready.loggedIn : null
  if (loggedIn === false) return { state: 'unavailable', until: null, reason: ready.detail ?? 'not signed in', loggedIn }
  const state = row?.state
  if (state === 'stopped' || state === 'exhausted') {
    const until = isIso(row.until) ? row.until : null
    return { state, until, reason: describeState(state, until), loggedIn }
  }
  if (state === 'ok' || state === 'near') return { state, until: null, reason: null, loggedIn }
  return { state: fallback, until: null, reason: typeof row?.error === 'string' ? row.error : null, loggedIn }
}

/** Pricing and the rate in force, from config, the row or the rates map; the operator can override the cost class. */
function economicsOf(ctx, marginalCost) {
  const id = ctx.agentDef?.id
  const override = ctx.config?.resources?.economics?.[id] ?? {}
  const pricing = override.pricing ?? ctx.config?.pricing?.peak?.[id] ?? null
  const rateNow = ctx.rates?.[id] ?? ctx.usageRow?.rateNow ?? null
  return {
    marginalCost: MARGINAL_COSTS.includes(override.marginalCost) ? override.marginalCost : marginalCost,
    pricing: pricing && typeof pricing === 'object' ? pricing : null,
    rateNow: typeof rateNow === 'string' ? rateNow : null,
    peak: typeof rateNow === 'string' ? /^peak\b/i.test(rateNow) : null,
    budget: null,
  }
}

/** The balance and the soft/hard floors the router already applies, so the governor can read pressure without a total. */
function budgetOf(row) {
  if (!row) return null
  const b = row.balance
  return {
    remaining: isNum(b?.amount) ? b.amount : null,
    currency: typeof b?.currency === 'string' ? b.currency : null,
    soft: isNum(row.limits?.handoffAtBalance) ? row.limits.handoffAtBalance : null,
    hard: isNum(row.limits?.minBalance) ? row.limits.minBalance : null,
  }
}

const modelOfCtx = (ctx) => {
  const m = ctx.agentDef?.llm?.model ?? ctx.modelOf?.(ctx.agentDef) ?? null
  return typeof m === 'string' && m ? m : null
}

// --- built-in adapters -----------------------------------------------------------------

const discover = (adapter, provider, source) => ({ agents = [] }) =>
  agents.filter((a) => adapter.matches(a)).map((a) => ({ resourceId: a.id, provider: typeof provider === 'function' ? provider(a) : provider, source }))

/** Claude Code: 5-hour and weekly rolling windows from the OAuth usage endpoint or the OMC statusline cache. */
export const anthropicSubscriptionAdapter = {
  id: 'anthropic-subscription',
  provider: 'claude-code',
  source: 'subscription',
  matches: (a) => a?.provider === 'claude-code',
  discoverResources: (p) => discover(anthropicSubscriptionAdapter, 'claude-code', 'subscription')(p),
  getUsage(ctx) {
    const via = String(ctx.usageRow?.via ?? '')
    // The usage module reads either the OAuth endpoint or the OMC cache; a row that does not
    // say which is taken as the endpoint, the only path that produces windows on its own.
    const source = /cache|omc|statusline/i.test(via) ? 'local_cache' : 'provider_api'
    return windowLimits(ctx, source)
  },
  getCapabilities: () => ({ hardware: null, contextTokens: null }),
  getEconomics: (ctx) => economicsOf(ctx, 'low'),
  getAvailability: (ctx) => availabilityOf(ctx),
  plan: (ctx) => manualPlan(ctx),
}

/** Codex: primary and secondary rolling windows and the plan name, both from the CLI's own account read. */
export const openaiSubscriptionAdapter = {
  id: 'openai-subscription',
  provider: 'codex',
  source: 'subscription',
  matches: (a) => a?.provider === 'codex',
  discoverResources: (p) => discover(openaiSubscriptionAdapter, 'codex', 'subscription')(p),
  getUsage: (ctx) => windowLimits(ctx, 'provider_cli'),
  getCapabilities: () => ({ hardware: null, contextTokens: null }),
  getEconomics: (ctx) => economicsOf(ctx, 'low'),
  getAvailability: (ctx) => availabilityOf(ctx),
  plan(ctx) {
    const manual = manualPlan(ctx)
    if (manual) return manual
    const name = ctx.usageRow?.plan
    return typeof name === 'string' && name ? { name: name.toLowerCase(), source: 'provider_cli', confidence: USAGE_CONFIDENCE.provider_cli } : null
  },
}

const DEEPSEEK_PROVIDERS = ['deepseek', 'deepseek-official']

/**
 * DeepSeek: a prepaid balance as a monetary budget, the high-water mark standing in for a total.
 * The balance endpoint reports the balance and nothing else, so only `remaining` is the
 * provider's word. `total` is the most this key has been seen to hold, a mark accounts.js keeps
 * from balances it happened to read (money spent before the first read, or between two reads
 * around a top-up, never raised it); `used` and `ratioUsed` treat that mark as if it were a
 * total. They are useful, and they are guesses, so they carry their own provenance.
 */
export const deepseekApiAdapter = {
  id: 'deepseek-api',
  provider: 'deepseek',
  source: 'api',
  matches: (a) => DEEPSEEK_PROVIDERS.includes(a?.llm?.provider),
  discoverResources: (p) => discover(deepseekApiAdapter, 'deepseek', 'api')(p),
  getUsage(ctx) {
    const row = ctx.usageRow
    const b = row?.balance
    if (!isNum(b?.amount)) return []
    const currency = typeof b.currency === 'string' ? b.currency : null
    const peak = row.creditPeak
    const total = isNum(peak?.amount) && peak.amount > 0 && peak.currency === currency ? peak.amount : null
    const used = total != null ? Math.max(0, total - b.amount) : null
    const ratioUsed = isNum(row.creditPercent) ? clamp(1 - row.creditPercent / 100) : null
    const measured = row.error ? USAGE_CONFIDENCE.errored : USAGE_CONFIDENCE.provider_api
    const derived = (source) => ({ source, confidence: measured * USAGE_CONFIDENCE[source] })
    const fieldSources = Object.fromEntries([
      ['used', used, 'estimate'],
      ['total', total, 'local_observation'],
      ['ratioUsed', ratioUsed, 'estimate'],
    ].filter(([, v]) => v != null).map(([f, , source]) => [f, derived(source)]))
    return [limit({
      id: 'balance',
      kind: 'monetary_budget',
      scope: 'account',
      used,
      remaining: b.amount,
      total,
      unit: currency,
      ratioUsed,
      // The limit's own provenance is its measured figure's: the balance, from the provider.
      source: 'provider_api',
      confidence: measured,
      fieldSources: Object.keys(fieldSources).length ? fieldSources : null,
      checkedAt: checkedAtOf(ctx),
    })]
  },
  getCapabilities: () => ({ hardware: null, contextTokens: null }),
  getEconomics: (ctx) => ({ ...economicsOf(ctx, 'metered'), budget: budgetOf(ctx.usageRow) }),
  getAvailability: (ctx) => availabilityOf(ctx),
  plan: (ctx) => manualPlan(ctx),
}

const isLocalAgent = (a) => a?.kind === 'local' || a?.llm?.provider === 'local'

/** A model on this PC: no limits, no login, hardware from the detected specs, nothing metered. */
export const localModelAdapter = {
  id: 'local-model',
  provider: 'local',
  source: 'local',
  matches: isLocalAgent,
  discoverResources: (p) => discover(localModelAdapter, 'local', 'local')(p),
  getUsage: () => [],
  getCapabilities(ctx) {
    const specs = ctx.specs
    const vram = (specs?.gpus ?? []).reduce((m, g) => Math.max(m, isNum(g?.vramGB) ? g.vramGB : 0), 0)
    const contextTokens = isNum(ctx.agentDef?.llm?.contextSize) ? ctx.agentDef.llm.contextSize : isNum(ctx.config?.local?.contextSize) ? ctx.config.local.contextSize : null
    const hardware = specs ? { vramGB: vram, ramGB: isNum(specs.ramGB) ? specs.ramGB : null, contextTokens, tokensPerSecond: null } : { contextTokens, tokensPerSecond: null }
    return { hardware, contextTokens }
  },
  getEconomics: (ctx) => economicsOf(ctx, 'none'),
  getAvailability: (ctx) => availabilityOf(ctx, { fallback: 'ok' }),
  plan: () => null,
}

/** Any other spawn agent: a metered key we know nothing about. Limits empty, confidence 0, never a guess. */
export const genericApiAdapter = {
  id: 'generic-api',
  provider: null,
  source: 'api',
  matches: (a) => !!a && !isLocalAgent(a) && a.provider !== 'claude-code' && a.provider !== 'codex' && !DEEPSEEK_PROVIDERS.includes(a.llm?.provider),
  discoverResources: (p) => discover(genericApiAdapter, (a) => a.llm?.provider ?? a.provider ?? 'unknown', 'api')(p),
  getUsage: () => [],
  getCapabilities: () => ({ hardware: null, contextTokens: null }),
  getEconomics: (ctx) => ({ ...economicsOf(ctx, 'metered'), budget: budgetOf(ctx.usageRow) }),
  getAvailability: (ctx) => availabilityOf(ctx),
  plan: (ctx) => manualPlan(ctx),
}

/** Registration order is match order: the specific adapters first, the generic one last. */
export const BUILTIN_ADAPTERS = Object.freeze([anthropicSubscriptionAdapter, openaiSubscriptionAdapter, deepseekApiAdapter, localModelAdapter, genericApiAdapter])

const builtinRegistry = () => {
  const r = createAdapterRegistry()
  for (const a of BUILTIN_ADAPTERS) r.register(a)
  return r
}

/**
 * One ResourceSnapshot per agent. An agent no adapter matches gets the generic one. Usage
 * older than `policy.governor.staleAfterMinutes` keeps its figures with confidence multiplied
 * by `staleConfidence`, on the snapshot and on each limit, so the governor discounts it too.
 *
 * @param {object} p
 * @param {object[]} p.agents            config.agents entries
 * @param {Record<string, object>} [p.usage]  usage.js snapshot, keyed by agent id
 * @param {Record<string, object>} [p.ready]  setup.js readiness, keyed by agent id
 * @param {object} [p.config]            plugin config (resources.plans, resources.economics, pricing.peak, routing)
 * @param {object|null} [p.specs]        local.js detectSpecs result
 * @param {object} [p.adapters]          an adapter registry; the built-ins by default
 * @param {Function|number|string} [p.now]  the clock: ms, ISO, or a function returning either
 * @param {Function} [p.modelOf]         agentDef -> model id, for agents whose model is not pinned
 * @param {object} [p.policy]            resolvePolicy result; resolved from config.routing when absent
 * @param {Record<string, string>} [p.rates]  router.js pricingNow output, keyed by agent id
 * @returns {object[]} ResourceSnapshot[]
 */
export function snapshotResources({ agents = [], usage = {}, ready = {}, config = {}, specs = null, adapters, now = Date.now, modelOf, policy, rates = {} } = {}) {
  const registry = adapters ?? builtinRegistry()
  const pol = policy ?? resolvePolicy(config?.routing ?? {})
  const nowMs = toMs(now)
  const staleMs = pol.governor.staleAfterMinutes * 60_000
  const out = []
  for (const agentDef of agents) {
    if (!agentDef?.id) continue
    const adapter = registry.adapterFor(agentDef) ?? genericApiAdapter
    const ctx = { agentDef, usageRow: usage?.[agentDef.id] ?? null, ready: ready?.[agentDef.id] ?? null, config, specs, now: nowMs, modelOf, policy: pol, rates }
    const checkedAt = checkedAtOf(ctx)
    const stale = ctx.usageRow != null && nowMs - Date.parse(checkedAt) > staleMs
    const discount = stale ? pol.governor.staleConfidence : 1
    const limits = (adapter.getUsage(ctx) ?? []).map((l, i) => {
      validateLimit(l, `${adapter.id} ${agentDef.id}: limits[${i}]`)
      // Staleness discounts every figure alike, derived ones included, so a stale estimate
      // stays behind a stale measurement by the same margin it was behind a fresh one.
      const fieldSources = l.fieldSources
        ? Object.fromEntries(Object.entries(l.fieldSources).map(([f, p]) => [f, { source: p.source, confidence: clamp(p.confidence * discount) }]))
        : null
      return { ...l, fieldSources, confidence: clamp(l.confidence * discount) }
    })
    // The snapshot's own trust is its best limit's: no limits, nothing to trust.
    const best = limits.reduce((m, l) => (m == null || l.confidence > m.confidence ? l : m), null)
    const caps = adapter.getCapabilities(ctx) ?? {}
    const model = modelOfCtx(ctx)
    const provider = adapter.discoverResources({ agents: [agentDef] })[0]?.provider ?? adapter.provider ?? agentDef.llm?.provider ?? agentDef.provider
    out.push(validateSnapshot({
      resourceId: agentDef.id,
      provider: String(provider ?? 'unknown'),
      adapter: adapter.id,
      source: adapter.source,
      model,
      modelVersion: model,
      plan: adapter.plan?.(ctx) ?? null,
      limits,
      availability: adapter.getAvailability(ctx),
      economics: adapter.getEconomics(ctx),
      hardware: orNull(caps.hardware),
      usageSource: best?.source ?? 'unknown',
      confidence: best?.confidence ?? 0,
      stale,
      checkedAt,
    }))
  }
  return out
}

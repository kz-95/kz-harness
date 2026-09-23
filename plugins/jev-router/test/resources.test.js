// Resource adapters: every provider's way of counting normalised into the same Limit and
// ResourceSnapshot shapes, with unknown left unknown and stale data trusted less. Every row
// here is a fixture; no provider is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePolicy } from '../routing-policy.js'
import {
  AVAILABILITY_STATES, BUILTIN_ADAPTERS, LIMIT_KINDS, LIMIT_SCOPES, PROVENANCE_FIELDS, RESOURCE_SOURCES, USAGE_CONFIDENCE, USAGE_SOURCES,
  anthropicSubscriptionAdapter, createAdapterRegistry, deepseekApiAdapter, genericApiAdapter, localModelAdapter, openaiSubscriptionAdapter,
  provenanceOf, snapshotResources, validateLimit, validateSnapshot,
} from '../resources.js'

const NOW = '2026-09-22T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const minutesFromNow = (m) => new Date(NOW_MS + m * 60_000).toISOString()

const claude = { id: 'claude', provider: 'claude-code', name: 'Claude Code' }
const codex = { id: 'codex', provider: 'codex', name: 'Codex' }
const deepseek = { id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }
const localAgent = { id: 'qwen-small', provider: 'spawn', role: 'fast', llm: { provider: 'local', model: 'qwen3-4b' } }
const byok = { id: 'mistral', provider: 'spawn', llm: { provider: 'mistral', model: 'mistral-medium' } }

/** A subscription usage row as usage.js writes it. */
const subRow = (provider, over = {}) => ({
  kind: 'subscription', provider, limits: { handoffAtPercent: 85, stopAtPercent: 97 },
  windows: [
    { name: '5h', minutes: 300, usedPercent: 40, resetsAt: minutesFromNow(120) },
    { name: 'weekly', minutes: 10080, usedPercent: 82, resetsAt: minutesFromNow(5 * 24 * 60) },
  ],
  balance: null, creditPercent: null, error: null, checkedAt: NOW, state: 'ok', until: null, ...over,
})
/** A prepaid API key row. */
const apiRow = (over = {}) => ({
  kind: 'api', provider: 'spawn', keyProvider: 'deepseek', limits: { minBalance: 5, handoffAtBalance: 10 },
  windows: [], balance: { amount: 36.5, currency: 'CNY' }, creditPercent: 73, creditPeak: { amount: 50, currency: 'CNY' },
  error: null, checkedAt: NOW, state: 'ok', until: null, ...over,
})
const one = (agent, over = {}) => snapshotResources({ agents: [agent], now: NOW_MS, ...over })[0]
/** A valid limit to break one field of. */
const lim = (over = {}) => ({ id: 'weekly', kind: 'rolling_window', scope: 'account', used: 82, remaining: 18, total: 100, unit: 'percent', ratioUsed: 0.82, resetsAt: NOW, durationMinutes: 10080, rolling: true, source: 'provider_api', confidence: 0.95, checkedAt: NOW, ...over })

test('the vocabularies are frozen and hold the contract values', () => {
  assert.deepEqual([...LIMIT_KINDS], ['rolling_window', 'fixed_window', 'token_budget', 'request_budget', 'monetary_budget', 'credit_budget', 'provider_defined'])
  assert.deepEqual([...LIMIT_SCOPES], ['account', 'plan', 'model', 'model_group', 'feature'])
  assert.deepEqual([...USAGE_SOURCES], ['provider_api', 'provider_cli', 'local_cache', 'local_observation', 'estimate', 'manual', 'unknown'])
  assert.deepEqual([...RESOURCE_SOURCES], ['subscription', 'api', 'local'])
  assert.deepEqual([...AVAILABILITY_STATES], ['ok', 'near', 'stopped', 'exhausted', 'unknown', 'unavailable'])
  for (const list of [LIMIT_KINDS, LIMIT_SCOPES, USAGE_SOURCES, RESOURCE_SOURCES]) assert.equal(Object.isFrozen(list), true, 'a vocabulary cannot be edited at runtime')
})

test('validateLimit names the field it rejects', () => {
  const good = lim()
  assert.equal(validateLimit(good), good, 'a good limit passes and is returned as is')
  const bad = [
    [null, /an object is required/],
    [lim({ id: '' }), /id/],
    [lim({ kind: 'window' }), /kind/],
    [lim({ scope: 'user' }), /scope/],
    [lim({ used: 'a lot' }), /used/],
    [lim({ ratioUsed: 1.2 }), /ratioUsed/],
    [lim({ resetsAt: 'tomorrow' }), /resetsAt/],
    [lim({ rolling: 'yes' }), /rolling/],
    [lim({ source: 'guess' }), /source/],
    [lim({ confidence: 2 }), /confidence/],
    [lim({ checkedAt: 12 }), /checkedAt/],
  ]
  for (const [input, re] of bad) assert.throws(() => validateLimit(input), re, JSON.stringify(input))
  assert.doesNotThrow(() => validateLimit(lim({ used: null, remaining: null, total: null, unit: null, ratioUsed: null, resetsAt: null, durationMinutes: null, rolling: null })), 'null is how unknown is written')
})

test('validateSnapshot names the field it rejects, limits included', () => {
  const good = one(claude, { usage: { claude: subRow('claude-code') } })
  assert.equal(validateSnapshot(good), good)
  const bad = [
    [{ ...good, resourceId: '' }, /resourceId/],
    [{ ...good, source: 'cloud' }, /source must be/],
    [{ ...good, limits: [lim({ kind: 'nope' })] }, /limits\[0\] weekly: kind/],
    [{ ...good, availability: { ...good.availability, state: 'busy' } }, /availability.state/],
    [{ ...good, economics: { ...good.economics, marginalCost: 'free' } }, /economics.marginalCost/],
    [{ ...good, plan: { name: 'pro', source: 'rumour', confidence: 1 } }, /plan.source/],
    [{ ...good, usageSource: 'vibes' }, /usageSource/],
    [{ ...good, confidence: -1 }, /confidence/],
    [{ ...good, checkedAt: 'soon' }, /checkedAt/],
  ]
  for (const [input, re] of bad) assert.throws(() => validateSnapshot(input), re)
})

test('the registry matches in registration order and refuses a duplicate or a half adapter', () => {
  const r = createAdapterRegistry()
  for (const a of BUILTIN_ADAPTERS) r.register(a)
  assert.deepEqual(r.all().map((a) => a.id), ['anthropic-subscription', 'openai-subscription', 'deepseek-api', 'local-model', 'generic-api'])
  assert.equal(r.get('deepseek-api'), deepseekApiAdapter)
  assert.equal(r.get('nope'), null)
  assert.equal(r.adapterFor(claude), anthropicSubscriptionAdapter)
  assert.equal(r.adapterFor(codex), openaiSubscriptionAdapter)
  assert.equal(r.adapterFor(deepseek), deepseekApiAdapter)
  assert.equal(r.adapterFor({ ...deepseek, llm: { provider: 'deepseek-official', model: 'x' } }), deepseekApiAdapter)
  assert.equal(r.adapterFor(localAgent), localModelAdapter)
  assert.equal(r.adapterFor({ id: 'k', kind: 'local' }), localModelAdapter, 'kind local matches too')
  assert.equal(r.adapterFor(byok), genericApiAdapter)
  assert.throws(() => r.register(anthropicSubscriptionAdapter), /already registered/)
  assert.throws(() => r.register({ id: 'half', matches: () => true }), /discoverResources must be a function/)
  assert.throws(() => r.register({ matches: () => true }), /id/)
  const empty = createAdapterRegistry()
  assert.equal(empty.adapterFor(claude), null, 'nothing registered matches nothing')
})

test('discoverResources lists only the agents the adapter owns, with the anonymous-safe provider', () => {
  const agents = [claude, codex, deepseek, localAgent, byok]
  assert.deepEqual(anthropicSubscriptionAdapter.discoverResources({ agents }), [{ resourceId: 'claude', provider: 'claude-code', source: 'subscription' }])
  assert.deepEqual(deepseekApiAdapter.discoverResources({ agents }), [{ resourceId: 'deepseek', provider: 'deepseek', source: 'api' }])
  assert.deepEqual(localModelAdapter.discoverResources({ agents }), [{ resourceId: 'qwen-small', provider: 'local', source: 'local' }])
  assert.deepEqual(genericApiAdapter.discoverResources({ agents }), [{ resourceId: 'mistral', provider: 'mistral', source: 'api' }])
})

test('anthropic windows become rolling limits with the duration, the ratio and the endpoint confidence', () => {
  const s = one(claude, { usage: { claude: subRow('claude-code', { via: 'oauth-usage' }) } })
  assert.equal(s.adapter, 'anthropic-subscription')
  assert.equal(s.provider, 'claude-code')
  assert.equal(s.source, 'subscription')
  assert.equal(s.limits.length, 2)
  const weekly = s.limits.find((l) => l.id === 'weekly')
  assert.equal(weekly.kind, 'rolling_window')
  assert.equal(weekly.durationMinutes, 10080)
  assert.equal(weekly.ratioUsed, 0.82)
  assert.equal(weekly.unit, 'percent')
  assert.equal(weekly.rolling, true)
  assert.equal(weekly.resetsAt, minutesFromNow(5 * 24 * 60))
  assert.equal(weekly.source, 'provider_api')
  assert.equal(weekly.confidence, USAGE_CONFIDENCE.provider_api)
  assert.equal(s.usageSource, 'provider_api')
  assert.equal(s.confidence, 0.95)
  assert.equal(s.plan, null, 'Anthropic reports no plan; none is invented')
  assert.equal(s.economics.marginalCost, 'low', 'subscription capacity is paid for but not per call')
  assert.equal(s.availability.state, 'ok')
  assert.equal(s.stale, false)
  assert.equal(s.checkedAt, NOW)
  assert.equal(s.model, null, 'no model pinned and no modelOf given')
  const named = one(claude, { usage: { claude: subRow('claude-code') }, modelOf: () => 'claude-opus-4' })
  assert.equal(named.model, 'claude-opus-4')
  assert.equal(named.modelVersion, 'claude-opus-4')
})

test('the OMC statusline cache is trusted less than the endpoint, and a manual plan carries its source', () => {
  const s = one(claude, { usage: { claude: subRow('claude-code', { via: 'omc-cache' }) }, config: { resources: { plans: { claude: 'Max' } } } })
  assert.equal(s.usageSource, 'local_cache')
  assert.equal(s.confidence, USAGE_CONFIDENCE.local_cache)
  assert.deepEqual(s.plan, { name: 'max', source: 'manual', confidence: 1 })
})

test('codex windows come from the CLI with its plan, at CLI confidence', () => {
  const row = subRow('codex', { plan: 'Plus', windows: [{ name: '5h', minutes: 300, usedPercent: 10, resetsAt: minutesFromNow(60) }, { name: 'weekly', minutes: 10080, usedPercent: 55, resetsAt: minutesFromNow(3000) }] })
  const s = one(codex, { usage: { codex: row } })
  assert.equal(s.adapter, 'openai-subscription')
  assert.equal(s.provider, 'codex')
  assert.deepEqual(s.plan, { name: 'plus', source: 'provider_cli', confidence: 0.9 })
  assert.equal(s.usageSource, 'provider_cli')
  assert.equal(s.confidence, 0.9)
  assert.deepEqual(s.limits.map((l) => [l.id, l.kind, l.ratioUsed]), [['5h', 'rolling_window', 0.1], ['weekly', 'rolling_window', 0.55]])
  const noPlan = one(codex, { usage: { codex: subRow('codex') } })
  assert.equal(noPlan.plan, null)
})

test('a deepseek balance is a monetary budget: remaining, currency, the high-water mark as total, the soft and hard floors', () => {
  const s = one(deepseek, { usage: { deepseek: apiRow() } })
  assert.equal(s.adapter, 'deepseek-api')
  assert.equal(s.provider, 'deepseek')
  assert.equal(s.source, 'api')
  assert.equal(s.limits.length, 1)
  const b = s.limits[0]
  assert.equal(b.id, 'balance')
  assert.equal(b.kind, 'monetary_budget')
  assert.equal(b.remaining, 36.5)
  assert.equal(b.unit, 'CNY')
  assert.equal(b.total, 50)
  assert.equal(b.used, 13.5)
  assert.ok(Math.abs(b.ratioUsed - 0.27) < 1e-9, 'ratioUsed is 1 minus the credit percent')
  assert.equal(b.rolling, null)
  assert.equal(b.resetsAt, null)
  assert.equal(b.durationMinutes, null)
  assert.equal(b.source, 'provider_api')
  assert.equal(b.confidence, 0.95)
  assert.equal(s.economics.marginalCost, 'metered')
  assert.deepEqual(s.economics.budget, { remaining: 36.5, currency: 'CNY', soft: 10, hard: 5 })
  assert.equal(s.model, 'deepseek-flash')
  // A peak in another currency is not a total for this balance, and no credit percent means no ratio.
  const mixed = one(deepseek, { usage: { deepseek: apiRow({ creditPeak: { amount: 20, currency: 'USD' }, creditPercent: null }) } })
  assert.equal(mixed.limits[0].total, null)
  assert.equal(mixed.limits[0].used, null)
  assert.equal(mixed.limits[0].ratioUsed, null)
})

test('scenario E: no row, or a failed refresh with nothing cached, invents nothing', () => {
  for (const [label, usage] of [['no row', {}], ['error and no windows', { claude: subRow('claude-code', { windows: [], error: 'Claude usage HTTP 500', state: 'unknown' }) }]]) {
    const s = one(claude, { usage })
    assert.deepEqual(s.limits, [], `${label}: no limits`)
    assert.equal(s.confidence, 0, `${label}: confidence 0`)
    assert.equal(s.usageSource, 'unknown', `${label}: source unknown`)
    assert.equal(s.availability.state, 'unknown', `${label}: availability unknown`)
    assert.equal(s.plan, null)
  }
  const ds = one(deepseek, { usage: { deepseek: apiRow({ balance: null, creditPercent: null, creditPeak: null, error: 'key value missing', state: 'unknown' }) } })
  assert.deepEqual(ds.limits, [])
  assert.equal(ds.confidence, 0)
  assert.equal(ds.usageSource, 'unknown')
  assert.deepEqual(ds.economics.budget, { remaining: null, currency: null, soft: 10, hard: 5 }, 'the floors are config, not a reading, so they stay')
})

test('a failed refresh that still carries its last windows keeps them at low confidence', () => {
  const s = one(claude, { usage: { claude: subRow('claude-code', { error: 'Claude usage HTTP 503' }) } })
  assert.equal(s.limits.length, 2)
  assert.equal(s.confidence, USAGE_CONFIDENCE.errored)
  assert.equal(s.limits[0].confidence, 0.3)
  assert.equal(s.availability.state, 'ok', 'the state the row computed still stands')
})

test('stale usage keeps its figures and halves the confidence on the snapshot and on every limit', () => {
  const policy = resolvePolicy()
  const age = policy.governor.staleAfterMinutes + 1
  const s = one(claude, { usage: { claude: subRow('claude-code', { checkedAt: minutesFromNow(-age) }) } })
  assert.equal(s.stale, true)
  assert.ok(Math.abs(s.confidence - 0.95 * policy.governor.staleConfidence) < 1e-9)
  for (const l of s.limits) assert.ok(Math.abs(l.confidence - 0.95 * policy.governor.staleConfidence) < 1e-9, l.id)
  assert.equal(s.limits.find((l) => l.id === 'weekly').ratioUsed, 0.82, 'the figure itself is untouched')
  const fresh = one(claude, { usage: { claude: subRow('claude-code', { checkedAt: minutesFromNow(-(policy.governor.staleAfterMinutes - 1)) }) } })
  assert.equal(fresh.stale, false)
  assert.equal(fresh.confidence, 0.95)
  // The threshold is the policy's, so an operator can move it.
  const patient = one(claude, { usage: { claude: subRow('claude-code', { checkedAt: minutesFromNow(-age) }) }, policy: resolvePolicy({ governor: { staleAfterMinutes: 60 } }) })
  assert.equal(patient.stale, false)
})

test('a local model has no limits, costs nothing per call and reports the hardware it runs on', () => {
  const specs = { gpus: [{ name: 'RTX 3050', vendor: 'nvidia', vramGB: 4 }, { name: 'Intel UHD', vendor: 'intel', vramGB: 0 }], ramGB: 24, cpu: { name: 'i5', threads: 12 } }
  const s = one(localAgent, { specs, config: { local: { contextSize: 16384 } } })
  assert.equal(s.adapter, 'local-model')
  assert.equal(s.provider, 'local')
  assert.equal(s.source, 'local')
  assert.deepEqual(s.limits, [])
  assert.equal(s.economics.marginalCost, 'none')
  assert.deepEqual(s.hardware, { vramGB: 4, ramGB: 24, contextTokens: 16384, tokensPerSecond: null })
  assert.equal(s.availability.state, 'ok', 'no login and no quota: usable unless the readiness says otherwise')
  assert.equal(s.usageSource, 'unknown')
  assert.equal(s.confidence, 0)
  assert.equal(s.model, 'qwen3-4b')
  const noSpecs = one(localAgent)
  assert.deepEqual(noSpecs.hardware, { contextTokens: null, tokensPerSecond: null })
  const missing = one(localAgent, { ready: { 'qwen-small': { installed: false, loggedIn: false, detail: 'model file not downloaded' } } })
  assert.equal(missing.availability.state, 'unavailable')
  assert.equal(missing.availability.reason, 'model file not downloaded')
})

test('an unavailable resource carries the reason: signed out, stopped or exhausted', () => {
  const out = one(claude, { usage: { claude: subRow('claude-code') }, ready: { claude: { installed: true, loggedIn: false, detail: 'not signed in. Run: claude  then /login' } } })
  assert.equal(out.availability.state, 'unavailable')
  assert.equal(out.availability.reason, 'not signed in. Run: claude  then /login')
  assert.equal(out.availability.loggedIn, false)
  assert.equal(out.limits.length, 2, 'the windows are still reported; the login is the blocker')
  const until = minutesFromNow(90)
  const stopped = one(claude, { usage: { claude: subRow('claude-code', { state: 'stopped', until }) }, ready: { claude: { installed: true, loggedIn: true, detail: 'signed in' } } })
  assert.equal(stopped.availability.state, 'stopped')
  assert.equal(stopped.availability.until, until)
  assert.match(stopped.availability.reason, /usage limit reached/)
  assert.equal(stopped.availability.loggedIn, true)
  const exhausted = one(deepseek, { usage: { deepseek: apiRow({ state: 'exhausted', until }) } })
  assert.equal(exhausted.availability.state, 'exhausted')
  assert.match(exhausted.availability.reason, /exhaustion/)
  const near = one(deepseek, { usage: { deepseek: apiRow({ state: 'near', balance: { amount: 8, currency: 'CNY' } }) } })
  assert.equal(near.availability.state, 'near')
  assert.equal(near.availability.reason, null)
})

test('an agent no adapter knows gets the generic one: metered, unknown usage, nothing invented', () => {
  const s = one(byok, { usage: { mistral: { kind: 'api', provider: 'spawn', limits: { minBalance: 5, handoffAtBalance: 10 }, windows: [], balance: null, error: null, checkedAt: NOW, state: 'ok', until: null } } })
  assert.equal(s.adapter, 'generic-api')
  assert.equal(s.provider, 'mistral')
  assert.equal(s.source, 'api')
  assert.deepEqual(s.limits, [])
  assert.equal(s.confidence, 0)
  assert.equal(s.usageSource, 'unknown')
  assert.equal(s.economics.marginalCost, 'metered')
  assert.deepEqual(s.economics.budget, { remaining: null, currency: null, soft: 10, hard: 5 })
  assert.equal(s.availability.state, 'ok')
  // A registry with nothing in it still yields the generic snapshot rather than dropping the agent.
  const bare = snapshotResources({ agents: [claude], adapters: createAdapterRegistry(), now: NOW_MS })
  assert.equal(bare.length, 1)
  assert.equal(bare[0].adapter, 'generic-api')
})

test('scenario F: a rolling provider and a monetary provider normalise through the same shapes with different kinds', () => {
  const list = snapshotResources({ agents: [claude, deepseek, localAgent, codex], usage: { claude: subRow('claude-code'), deepseek: apiRow(), codex: subRow('codex', { plan: 'pro' }) }, now: NOW_MS })
  assert.deepEqual(list.map((s) => s.resourceId), ['claude', 'deepseek', 'qwen-small', 'codex'], 'one per agent, input order')
  for (const s of list) assert.doesNotThrow(() => validateSnapshot(s), s.resourceId)
  const kinds = Object.fromEntries(list.map((s) => [s.resourceId, s.limits.map((l) => l.kind)]))
  assert.deepEqual(kinds, { claude: ['rolling_window', 'rolling_window'], deepseek: ['monetary_budget'], 'qwen-small': [], codex: ['rolling_window', 'rolling_window'] })
  const keys = (l) => Object.keys(l).sort()
  assert.deepEqual(keys(list[0].limits[0]), keys(list[1].limits[0]), 'the same Limit fields whatever the provider counts in')
  assert.equal(list[0].limits[0].unit, 'percent')
  assert.equal(list[1].limits[0].unit, 'CNY')
})

test('scenario H: economics change through config, not code: cost class, pricing and the rate in force', () => {
  const pricing = { windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }], daysUtc: [1, 2, 3, 4, 5], note: 'twice off-peak' }
  const base = one(deepseek, { usage: { deepseek: apiRow() }, config: { pricing: { peak: { deepseek: pricing } } }, rates: { deepseek: 'peak rate until 04:00 UTC: twice its off-peak price' } })
  assert.equal(base.economics.marginalCost, 'metered')
  assert.deepEqual(base.economics.pricing, pricing)
  assert.equal(base.economics.peak, true)
  assert.match(base.economics.rateNow, /^peak rate/)
  const cheap = one(deepseek, { usage: { deepseek: apiRow({ rateNow: 'off-peak rate right now: the cheapest it gets' }) }, config: { resources: { economics: { deepseek: { marginalCost: 'low' } } } } })
  assert.equal(cheap.economics.marginalCost, 'low', 'the operator reclassified the resource without touching an adapter')
  assert.equal(cheap.economics.peak, false)
  assert.equal(cheap.economics.pricing, null)
  const silent = one(deepseek, { usage: { deepseek: apiRow() } })
  assert.equal(silent.economics.rateNow, null)
  assert.equal(silent.economics.peak, null, 'no rate information is null, not off-peak')
  const bogus = one(deepseek, { usage: { deepseek: apiRow() }, config: { resources: { economics: { deepseek: { marginalCost: 'free' } } } } })
  assert.equal(bogus.economics.marginalCost, 'metered', 'an unknown cost class is ignored rather than stored')
})

test('a custom adapter registered ahead of the built-ins takes its agents', () => {
  const r = createAdapterRegistry()
  r.register({
    id: 'acme',
    provider: 'acme',
    source: 'api',
    matches: (a) => a.llm?.provider === 'acme',
    discoverResources: ({ agents }) => agents.filter((a) => a.llm?.provider === 'acme').map((a) => ({ resourceId: a.id, provider: 'acme', source: 'api' })),
    getUsage: (ctx) => [lim({ id: 'tokens', kind: 'token_budget', used: 1000, remaining: 9000, total: 10000, unit: 'tokens', ratioUsed: 0.1, resetsAt: null, durationMinutes: null, rolling: false, source: 'provider_api', checkedAt: new Date(ctx.now).toISOString() })],
    getCapabilities: () => ({ hardware: null, contextTokens: 200000 }),
    getEconomics: () => ({ marginalCost: 'metered', pricing: null, rateNow: null, peak: null, budget: null }),
    getAvailability: () => ({ state: 'ok', until: null, reason: null, loggedIn: true }),
  })
  for (const a of BUILTIN_ADAPTERS) r.register(a)
  const [s] = snapshotResources({ agents: [{ id: 'acme-1', provider: 'spawn', llm: { provider: 'acme', model: 'm1' } }], adapters: r, now: NOW_MS })
  assert.equal(s.adapter, 'acme')
  assert.equal(s.limits[0].kind, 'token_budget')
  assert.equal(s.confidence, 0.95)
  assert.equal(s.plan, null, 'an adapter without plan() reports none')
  // A bad limit from an adapter is refused with the adapter and agent named.
  const broken = createAdapterRegistry()
  broken.register({ ...genericApiAdapter, id: 'broken', matches: () => true, getUsage: () => [lim({ ratioUsed: 7 })] })
  assert.throws(() => snapshotResources({ agents: [claude], adapters: broken, now: NOW_MS }), /broken claude: limits\[0\] weekly: ratioUsed/)
})

test('the clock can be a function, a number or an ISO string, and an agent without an id is skipped', () => {
  const rowless = (now) => snapshotResources({ agents: [claude, { name: 'nameless' }], now })[0]
  assert.equal(rowless(() => NOW_MS).checkedAt, NOW)
  assert.equal(rowless(NOW).checkedAt, NOW)
  assert.equal(rowless(() => NOW).checkedAt, NOW)
  assert.equal(snapshotResources({ agents: [claude, { name: 'nameless' }], now: NOW_MS }).length, 1)
})

test('a snapshot carries ids, numbers and categories, never the row error text beyond the reason', () => {
  const s = one(deepseek, { usage: { deepseek: apiRow({ error: 'DeepSeek balance HTTP 401 sk-not-a-real-key' }) } })
  const text = JSON.stringify({ ...s, availability: { ...s.availability, reason: null } })
  assert.equal(text.includes('sk-not-a-real-key'), false, 'the only place an error string can appear is the availability reason')
})

const near = (a, b) => Math.abs(a - b) < 1e-9

test('deepseek: only the balance is the provider\'s word; the high-water mark and what is worked out from it say so', () => {
  const s = one(deepseek, { usage: { deepseek: apiRow() } })
  const b = s.limits[0]
  // The measured figure keeps the provider's provenance, and so does the snapshot it lends its trust to.
  assert.deepEqual(provenanceOf(b, 'remaining'), { source: 'provider_api', confidence: 0.95 })
  assert.equal(s.usageSource, 'provider_api')
  // The total is a mark this codebase recorded from balances it happened to read; used and the
  // ratio treat that mark as if it were a total. None of them is presented as measured.
  const measured = USAGE_CONFIDENCE.provider_api
  assert.equal(b.fieldSources.total.source, 'local_observation')
  assert.ok(near(b.fieldSources.total.confidence, measured * USAGE_CONFIDENCE.local_observation))
  for (const f of ['used', 'ratioUsed']) {
    assert.equal(provenanceOf(b, f).source, 'estimate', f)
    assert.ok(near(provenanceOf(b, f).confidence, measured * USAGE_CONFIDENCE.estimate), f)
    assert.ok(provenanceOf(b, f).confidence < provenanceOf(b, 'remaining').confidence, `${f} is trusted less than the measurement`)
  }
  assert.equal('remaining' in b.fieldSources, false, 'a measured figure needs no provenance of its own')
  // A failed refresh lowers the derived figures with the measurement they come from.
  const errored = one(deepseek, { usage: { deepseek: apiRow({ error: 'DeepSeek balance HTTP 503' }) } }).limits[0]
  assert.ok(near(errored.fieldSources.ratioUsed.confidence, USAGE_CONFIDENCE.errored * USAGE_CONFIDENCE.estimate))
  // Staleness discounts them too, keeping the estimate behind the measurement.
  const policy = resolvePolicy()
  const stale = one(deepseek, { usage: { deepseek: apiRow({ checkedAt: minutesFromNow(-(policy.governor.staleAfterMinutes + 1)) }) } }).limits[0]
  assert.ok(near(stale.fieldSources.ratioUsed.confidence, measured * USAGE_CONFIDENCE.estimate * policy.governor.staleConfidence))
  assert.ok(near(stale.confidence, measured * policy.governor.staleConfidence))
  // Nothing derived, nothing to label.
  const mixed = one(deepseek, { usage: { deepseek: apiRow({ creditPeak: { amount: 20, currency: 'USD' }, creditPercent: null }) } }).limits[0]
  assert.equal(mixed.fieldSources, null)
  // Every limit carries the key, so readers never meet undefined.
  assert.equal(one(claude, { usage: { claude: subRow('claude-code') } }).limits[0].fieldSources, null)
})

test('validateLimit checks fieldSources and the facts every kind claims', () => {
  assert.deepEqual([...PROVENANCE_FIELDS], ['used', 'remaining', 'total', 'ratioUsed'])
  assert.equal(Object.isFrozen(PROVENANCE_FIELDS), true)
  const est = { source: 'estimate', confidence: 0.4 }
  assert.doesNotThrow(() => validateLimit(lim({ fieldSources: { ratioUsed: est, total: { source: 'local_observation', confidence: 0.6 } } })))
  assert.doesNotThrow(() => validateLimit(lim({ fieldSources: null })))
  const bad = [
    [lim({ fieldSources: [] }), /fieldSources must be an object/],
    [lim({ fieldSources: { unit: est } }), /fieldSources.unit must be one of/],
    [lim({ fieldSources: { ratioUsed: 'estimate' } }), /fieldSources.ratioUsed must be an object/],
    [lim({ fieldSources: { ratioUsed: { source: 'hunch', confidence: 0.4 } } }), /fieldSources.ratioUsed.source/],
    [lim({ fieldSources: { total: { source: 'estimate', confidence: 1.5 } } }), /fieldSources.total.confidence/],
    [lim({ kind: 'rolling_window', rolling: false }), /rolling must not be false on a rolling_window/],
    [lim({ kind: 'fixed_window', rolling: true }), /rolling must not be true on a fixed_window/],
    [lim({ used: -1 }), /used must not be negative/],
    [lim({ total: 0 }), /total must be greater than 0/],
    [lim({ durationMinutes: 0 }), /durationMinutes must be greater than 0/],
  ]
  for (const [input, re] of bad) assert.throws(() => validateLimit(input), re, JSON.stringify(input))
  assert.doesNotThrow(() => validateLimit(lim({ kind: 'monetary_budget', remaining: -2, used: null, total: null, ratioUsed: null, rolling: null })), 'an overdrawn balance is a real reading')
  // provenanceOf falls back to the limit's own for a figure without an entry.
  assert.deepEqual(provenanceOf(lim(), 'ratioUsed'), { source: 'provider_api', confidence: 0.95 })
  assert.deepEqual(provenanceOf(lim({ fieldSources: { ratioUsed: est } }), 'ratioUsed'), est)
})

test('every declared kind and scope round-trips through validateLimit and snapshotResources', () => {
  // Most of these no shipped adapter produces; the normalised model still has to carry them, so
  // a new adapter can use any of them without touching anything downstream.
  const shapes = {
    rolling_window: { unit: 'percent', used: 30, remaining: 70, total: 100, ratioUsed: 0.3, durationMinutes: 300, resetsAt: minutesFromNow(60), rolling: true },
    fixed_window: { unit: 'requests', used: 400, remaining: 600, total: 1000, ratioUsed: 0.4, durationMinutes: 1440, resetsAt: minutesFromNow(600), rolling: false },
    token_budget: { unit: 'tokens', used: 1e6, remaining: 9e6, total: 1e7, ratioUsed: 0.1, durationMinutes: null, resetsAt: null, rolling: null },
    request_budget: { unit: 'requests', used: 50, remaining: 150, total: 200, ratioUsed: 0.25, durationMinutes: null, resetsAt: null, rolling: null },
    monetary_budget: { unit: 'USD', used: null, remaining: 12.5, total: null, ratioUsed: null, durationMinutes: null, resetsAt: null, rolling: null },
    credit_budget: { unit: 'credits', used: 800, remaining: 200, total: 1000, ratioUsed: 0.8, durationMinutes: null, resetsAt: null, rolling: null, fieldSources: { total: { source: 'manual', confidence: 1 } } },
    provider_defined: { unit: null, used: null, remaining: null, total: null, ratioUsed: 0.5, durationMinutes: null, resetsAt: null, rolling: null },
  }
  assert.deepEqual(Object.keys(shapes), [...LIMIT_KINDS], 'every kind is exercised')
  const limits = []
  for (const kind of LIMIT_KINDS) for (const scope of LIMIT_SCOPES) {
    const l = { id: `${kind}:${scope}`, kind, scope, source: 'provider_api', confidence: 0.9, checkedAt: NOW, fieldSources: null, ...shapes[kind] }
    assert.equal(validateLimit(l), l, `${kind} at ${scope} scope is valid`)
    limits.push(l)
  }
  const r = createAdapterRegistry()
  r.register({ ...genericApiAdapter, id: 'every-kind', matches: () => true, getUsage: () => limits })
  const [s] = snapshotResources({ agents: [byok], adapters: r, now: NOW_MS })
  assert.doesNotThrow(() => validateSnapshot(s))
  assert.equal(s.limits.length, LIMIT_KINDS.length * LIMIT_SCOPES.length)
  s.limits.forEach((out, i) => assert.deepEqual(out, limits[i], `${limits[i].id} comes out as it went in`))
})

// The decision engine end to end, without a git repo: real capability priors, real resource
// snapshots through the provider adapters, the real governor, a fake Jev that answers from the
// anonymous candidate table it is handed. Scenarios A, B, C, J and K of the routing design:
// healthy subscription, subscription under pressure, scarce but critical review, hard
// incompatibility, and the owner's priors reaching routing as numbers rather than names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eligibleStrategies, strongestOf } from '../broker.js'
import { NO_CANDIDATES, candidateTier, classProfiles, createDecisionEngine, heuristicProfile, resolveSkills } from '../decision.js'
import { createDomainRegistry } from '../domains.js'
import { createCapabilityRegistry, loadPriors, subjectOf } from '../profiles.js'
import { snapshotResources } from '../resources.js'
import { SKILLS, TASK_SKILLS, resolvePolicy } from '../routing-policy.js'
import { attachOutcomes, createTrainingStore } from '../training.js'

const PRIORS = loadPriors(fileURLToPath(new URL('../../../config/capability-priors.json', import.meta.url)))
const policy = resolvePolicy()
const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'qwen-local', provider: 'spawn', description: 'd', enabled: true, kind: 'local', role: 'best-quality', llm: { provider: 'local', model: 'qwen3-8b' } },
]
const modelOf = (a) => a.llm?.model ?? (a.provider === 'claude-code' ? 'claude-opus-5' : a.provider === 'codex' ? 'gpt-5.6' : undefined)
const now = Date.parse('2026-09-22T10:00:00.000Z')
const at = (minutes) => new Date(now + minutes * 60_000).toISOString()
const win = (name, minutes, usedPercent, resetsAt) => ({ name, minutes, usedPercent, resetsAt })

/** Usage rows as usage.js produces them; weekly percent per subscription, a balance for the key. */
function usageRows({ claudeWeekly = 20, codexWeekly = 20, claudeReset = 3 * 24 * 60, balance = 20 } = {}) {
  const checkedAt = at(-1)
  return {
    claude: { kind: 'subscription', provider: 'claude-code', windows: [win('5h', 300, 10, at(200)), win('weekly', 10080, claudeWeekly, at(claudeReset))], via: 'oauth-usage', plan: null, state: claudeWeekly >= 97 ? 'stopped' : claudeWeekly >= 85 ? 'near' : 'ok', until: null, error: null, checkedAt, limits: { handoffAtPercent: 85, stopAtPercent: 97 } },
    codex: { kind: 'subscription', provider: 'codex', windows: [win('5h', 300, 5, at(200)), win('weekly', 10080, codexWeekly, at(5 * 24 * 60))], via: 'codex-app-server', plan: 'plus', state: 'ok', until: null, error: null, checkedAt, limits: { handoffAtPercent: 85, stopAtPercent: 97 } },
    deepseek: { kind: 'api', provider: 'spawn', keyProvider: 'deepseek', windows: [], balance: { amount: balance, currency: 'USD' }, creditPercent: 50, creditPeak: { amount: 40, currency: 'USD' }, state: 'ok', until: null, error: null, checkedAt, limits: { minBalance: 5, handoffAtBalance: 10 } },
    'qwen-local': { kind: 'local', provider: 'spawn', windows: [], balance: null, state: 'ok', until: null, error: null, checkedAt, limits: {} },
  }
}
const ready = Object.fromEntries(AGENTS.map((a) => [a.id, { installed: true, loggedIn: true, detail: 'ok' }]))
const snapshots = (rows) => snapshotResources({ agents: AGENTS, usage: rows, ready, config: {}, specs: { gpus: [{ name: 'RTX', vendor: 'nvidia', vramGB: 4 }], ramGB: 24 }, now, modelOf, policy })

/** A profile answer as jev.route returns it for the task group. */
const profileOf = (over = {}) => ({
  taskType: 'implementation', taskTypeConfidence: 0.9, complexity: 0.3, risk: 0.2,
  requirements: { coding: 0.8, testing: 0.4 }, skills: { primary: 'implementation', supporting: [] },
  minimumCapability: 'standard', preferredCapability: 'strong', verification: ['checks'],
  needsSecondOpinion: 0.2, needsHumanReview: 0.1, needsTests: 0.8, ...over,
})

/**
 * A fake Jev that classifies as told and picks the candidate `pick(candidates)` names. Records
 * every call so a test can see exactly what rode out.
 */
function fakeJev({ profile = profileOf(), pick = (cs) => cs[0], strategy = 'STANDARD_DIRECT', conserve = 0.5 } = {}) {
  const calls = []
  return {
    calls,
    route: async (args) => {
      calls.push(args)
      const out = { model: 'jev-test' }
      if (args.ask?.task !== false) { out.profile = profile; Object.assign(out, { taskType: profile.taskType, complexity: profile.complexity, risk: profile.risk, handler: 'agent' }) }
      if (args.candidates && args.ask?.resource !== false) {
        const chosen = pick(args.candidates)
        out.resource = { chosenKey: chosen.key, confidence: 0.8, probabilities: Object.fromEntries(args.candidates.map((c) => [c.key, c.key === chosen.key ? 0.8 : 0.2 / Math.max(1, args.candidates.length - 1)])) }
        out.strategy = { choice: strategy, confidence: 0.7, probabilities: { [strategy]: 0.7 } }
      }
      if (args.candidates && args.ask?.judgments !== false) Object.assign(out, { secondOpinion: 0.2, conserve, frontierReview: profile.risk >= 0.8 ? 0.9 : 0.1 })
      return out
    },
  }
}

const engine = () => createDecisionEngine({ policy, domains: undefined, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, now: () => now })
const decide = (e, jev, over = {}) => e.decide({ task: 'implement the parser change', context: {}, history: [], agents: AGENTS, snapshots: snapshots(usageRows()), modelOf, jev, ...over })
const byKey = (d, id) => d.candidates.find((c) => c.id === id)

test('scenario A: a healthy subscription carries low scarcity and a subscription pick is honoured', async () => {
  const jev = fakeJev({ pick: (cs) => cs.reduce((m, c) => (c.capabilities.coding?.score > (m.capabilities.coding?.score ?? 0) ? c : m)) })
  const d = await decide(engine(), jev)
  const claude = byKey(d, 'claude')
  assert.ok(claude.scarcity < 0.3, `a subscription at 20% of its week is not scarce (${claude.scarcity})`)
  assert.equal(claude.marginalCost, 'low', 'already paid for: low marginal cost, never free')
  assert.equal(d.routing.primaryAgent, 'claude', 'Jev picked the strongest coder by its capability profile and code ran with it')
  // Two calls, not one: the resource judgment cannot be asked before the task profile exists,
  // because the capability numbers it must weigh are computed against that profile.
  assert.equal(d.jevCalls.length, 2)
  assert.deepEqual(jev.calls[0].ask, { task: true, resource: false, judgments: false })
  assert.deepEqual(jev.calls[1].ask, { task: false, resource: true, judgments: true })
  assert.equal(jev.calls[0].candidates, undefined, 'the task call carries no candidate table')
  const table = jev.calls[1].candidates
  assert.ok(table.every((c) => c.tier && c.expectedCost && c.capabilities), 'the resource call carries tier, cost and capabilities for every candidate')
})

test('scenario B: under pressure, trivial work sees a scarce subscription and a cheap capable candidate', async () => {
  const rows = usageRows({ claudeWeekly: 88, codexWeekly: 86, claudeReset: 5 * 24 * 60 })
  const profile = profileOf({ taskType: 'simple_change', complexity: 0.05, risk: 0.05, requirements: { coding: 0.4 }, minimumCapability: 'standard' })
  const jev = fakeJev({ profile, pick: (cs) => cs.reduce((m, c) => ((c.expectedCost?.total ?? 1) < (m.expectedCost?.total ?? 1) ? c : m)) })
  const d = await decide(engine(), jev, { snapshots: snapshots(rows) })
  const claude = byKey(d, 'claude'); const ds = byKey(d, 'deepseek')
  assert.ok(claude.scarcity >= 0.7, `88% of the week used, five days from the reset, is scarce (${claude.scarcity})`)
  assert.ok(ds.scarcity < claude.scarcity, 'the metered key is the cheap alternative while the subscription is spent')
  assert.ok(ds.expectedCost.total < claude.expectedCost.total, 'and that scarcity shows up in the expected job cost, which is what routing reads')
  assert.equal(d.routing.primaryAgent, 'deepseek', 'cheap capable work went to the cheap resource')
  // Scarcity is contextual, not a rule: nothing removed the subscriptions from the pool.
  assert.ok(d.candidates.some((c) => c.id === 'claude'), 'the scarce subscription is still a candidate')
  // The weak local model is a different matter: the owner's own prior puts it under the standard
  // floor for coding, so it is excluded as insufficient rather than kept as cheap.
  assert.ok(d.excluded.some((e) => e.id === 'qwen-local' && /floor/.test(e.reason)))
})

test('scenario C: a scarce frontier resource stays eligible for a critical security review, and the weaker one is floored out', async () => {
  const rows = usageRows({ claudeWeekly: 90, codexWeekly: 90 })
  const profile = profileOf({ taskType: 'security', complexity: 0.9, risk: 0.95, requirements: { security_review: 0.95, code_review: 0.9, coding: 0.3 }, minimumCapability: 'frontier', preferredCapability: 'frontier' })
  const jev = fakeJev({ profile, pick: (cs) => cs.reduce((m, c) => (c.capabilities.security_review?.score > (m.capabilities.security_review?.score ?? 0) ? c : m)) })
  const d = await decide(engine(), jev, { snapshots: snapshots(rows), gated: ['claude', 'codex'] })
  assert.ok(d.candidates.some((c) => c.id === 'claude'), 'the frontier-tier resource is eligible despite scarcity and its gate')
  assert.ok(!d.candidates.some((c) => c.id === 'deepseek'), 'the materially weaker resource is under the frontier floor')
  assert.ok(!d.candidates.some((c) => c.id === 'qwen-local'), 'so is the local model')
  assert.ok(d.excluded.some((e) => e.id === 'deepseek' && /floor/.test(e.reason)), 'and the exclusion says why')
  assert.equal(d.routing.primaryAgent, 'claude')
  assert.equal(d.routing.decision.gateOverride, true, 'the gate yielded to the capability floor, in code, and said so')
  assert.equal(d.plan.forceReview, true, 'high risk plus the frontier-review judgment adds a review')
  // The reviewer comes from the wider pool: under a frontier floor the work pool can be one
  // resource deep, and a gated or merely strong resource still reads the diff.
  assert.equal(d.plan.reviewer, 'codex')
  assert.ok(!d.candidates.some((c) => c.id === 'codex'), 'though codex was not eligible to do the work')
})

test('when no context window can hold the request, the engine refuses with a code the router stops on', async () => {
  // The second of the engine's two refusals: the pool survived the availability filters and then
  // every candidate failed the context-length hard fact. It must be told apart from an outage by
  // its code, because an outage falls back to a default agent and this must not - every agent
  // left to fall back to is one that cannot hold the request.
  const jev = fakeJev()
  const big = `fix ${'x'.repeat(70_000)}`
  const snaps = snapshots(usageRows()).map((s) => ({ ...s, hardware: { ...s.hardware, contextTokens: 8_192 } }))
  const err = await decide(engine(), jev, { task: big, snapshots: snaps }).then(() => null, (e) => e)
  assert.ok(err, 'the engine refused')
  assert.equal(err.code, NO_CANDIDATES)
  assert.match(err.message, /no resource can take this request/)
  assert.deepEqual(err.excluded.map((e) => e.id).sort(), AGENTS.map((a) => a.id).sort(), 'and says who was ruled out')
  assert.ok(err.excluded.every((e) => /context window/.test(e.reason)), 'and why')
  assert.ok(!jev.calls.some((c) => c.candidates), 'no resource judgment was asked over an empty field')
})

test('the availability refusal carries the same code', async () => {
  const policyAll = resolvePolicy({ disabledResources: AGENTS.map((a) => a.id) })
  const e = createDecisionEngine({ policy: policyAll, domains: undefined, profiles: createCapabilityRegistry({ priors: PRIORS, policy: policyAll }), priors: PRIORS, now: () => now })
  const err = await decide(e, fakeJev()).then(() => null, (x) => x)
  assert.equal(err?.code, NO_CANDIDATES)
  assert.match(err.message, /no resource is available/)
  assert.ok(err.excluded.every((x) => x.reason === 'disabled by configuration'))
})

test('scenario J: a resource whose context window cannot hold the request is removed before any judgment', async () => {
  const jev = fakeJev({ pick: (cs) => cs[0] })
  const big = `fix ${'x'.repeat(70_000)}`
  const snaps = snapshots(usageRows()).map((s) => (s.resourceId === 'qwen-local' ? { ...s, hardware: { ...s.hardware, contextTokens: 16_384 } } : s))
  const d = await decide(engine(), jev, { task: big, snapshots: snaps })
  assert.ok(!d.candidates.some((c) => c.id === 'qwen-local'), 'the 16k local model cannot hold a 70k-character task')
  assert.ok(d.excluded.some((e) => e.id === 'qwen-local' && /context window/.test(e.reason)))
  // The resource call is made after the hard filter, so the incapable resource was never offered
  // to any judgment at all: code decided it, and no classifier got the chance to pick it.
  const offered = jev.calls.find((c) => c.candidates)?.candidates.map((c) => c.key) ?? []
  assert.equal(offered.length, d.candidates.length)
  assert.ok(!offered.includes(byKey(d, 'claude') && d.routing.decision.excluded.find((e) => e.id === 'qwen-local')?.key))
  assert.notEqual(d.routing.primaryAgent, 'qwen-local')
})

test('scenario K: the owner priors reach Jev as anonymous machine-readable features, never as names', async () => {
  const profile = profileOf({ taskType: 'architecture', requirements: { architecture: 0.95, explanation: 0.9, coding: 0.3 } })
  const jev = fakeJev({ profile, pick: (cs) => cs.reduce((m, c) => (c.capabilities.architecture?.score > (m.capabilities.architecture?.score ?? 0) ? c : m)) })
  const d = await decide(engine(), jev)
  const sent = jev.calls.at(-1).candidates
  const keyOf = (id) => d.candidates.find((c) => c.id === id).key
  const a = sent.find((c) => c.key === keyOf('codex')); const b = sent.find((c) => c.key === keyOf('claude'))
  assert.ok(a.capabilities.architecture.score > b.capabilities.architecture.score, 'family A carries the stronger architecture prior')
  assert.ok(a.capabilities.explanation.score > b.capabilities.explanation.score, 'and explanation')
  assert.ok(b.capabilities.coding.score > a.capabilities.coding.score, 'family B carries the stronger coding prior')
  assert.ok(b.capabilities.security_review.score > a.capabilities.security_review.score, 'and security review')
  const text = JSON.stringify(sent)
  for (const word of ['claude', 'codex', 'gpt', 'deepseek', 'qwen', 'anthropic', 'openai']) assert.ok(!text.toLowerCase().includes(word), `${word} must not reach the candidate table`)
  assert.ok(/RESOURCE_[A-D]/.test(text), 'candidates are anonymous keys with properties')
  assert.equal(d.routing.primaryAgent, 'codex', 'the pick followed the architecture prior with no model-name rule anywhere')
  assert.equal(candidateTier(byKey(d, 'codex').capabilities, profile.requirements, policy).tier, 'frontier')
})

test('the anonymous keys are stable across calls and map back to ids in the record only', async () => {
  const jev = fakeJev()
  const d1 = await decide(engine(), jev)
  const d2 = await decide(engine(), jev)
  assert.deepEqual(d1.candidates.map((c) => [c.id, c.key]), d2.candidates.map((c) => [c.id, c.key]))
  assert.ok(d1.routing.decision.candidates.every((c) => c.id && c.key), 'the record carries the mapping for the inspector')
})

test('without Jev and without a mature domain the engine falls back deterministically and says so', async () => {
  const d = await decide(engine(), null, { jevUnavailableReason: 'no key' })
  assert.ok(d.routing.primaryAgent, 'something was picked')
  assert.equal(d.routing.profile.heuristic, true, 'the profile is the heuristic one, not an invented classification')
  assert.equal(d.jevCalls.length, 0)
  assert.ok(d.candidates.length >= 2)
})

test('heuristicProfile reads the obvious words and nothing more', () => {
  assert.equal(heuristicProfile('rotate the auth token secret').taskType, 'security')
  assert.equal(heuristicProfile('the build is broken with a TypeError').taskType, 'debugging')
  assert.equal(heuristicProfile('add a widget').taskType, 'implementation')
  assert.equal(heuristicProfile('add a widget').heuristic, true)
})

test('a cold model version inherits a weak family prior and is marked cold in the candidate table', async () => {
  const agents = [...AGENTS, { id: 'claude-next', provider: 'claude-code', description: 'new', enabled: true, kind: 'subscription' }]
  const rows = { ...usageRows(), 'claude-next': usageRows().claude }
  const snaps = snapshotResources({ agents, usage: rows, ready: { ...ready, 'claude-next': ready.claude }, config: {}, now, modelOf: (a) => (a.id === 'claude-next' ? 'brand-new-model' : modelOf(a)), policy })
  const jev = fakeJev()
  const d = await decide(engine(), jev, { agents, snapshots: snaps, modelOf: (a) => (a.id === 'claude-next' ? 'brand-new-model' : modelOf(a)) })
  const c = byKey(d, 'claude-next')
  assert.equal(c.cold, true)
  assert.ok(c.capabilities.coding.confidence < byKey(d, 'claude').capabilities.coding.confidence, 'less confident than the recognised version')
  assert.equal(subjectOf(agents[4], { modelOf: () => 'brand-new-model', priors: PRIORS }).family, 'anthropic-claude')
})

/**
 * A domain registry whose controllers answer the way a real one does at the maturity named:
 * JEV_PRIMARY asks the teacher (falling back when there is none), LOCAL_ONLY returns the local
 * answer given. Every decision records a sample, so a test can see which samples the run would
 * label.
 */
function fakeDomains({ local = {} } = {}) {
  const ctl = (id) => ({
    state: () => ({ maturity: local[id] ? 'LOCAL_ONLY' : 'JEV_PRIMARY' }),
    decide: async ({ jev, fallback }) => {
      if (local[id]) return { ...local[id], authority: 'local', sampleId: `${id}#1` }
      const t = jev ? await jev() : null
      return { ...(t ?? fallback()), authority: t ? 'jev' : 'fallback', teacher: t, sampleId: `${id}#1` }
    },
  })
  return { get: (id) => ctl(id) }
}
const engineWith = (domains) => createDecisionEngine({ policy, domains, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, now: () => now })
const strongestCoder = (cs) => cs.reduce((m, c) => (c.capabilities.coding?.score > (m.capabilities.coding?.score ?? 0) ? c : m))
const scarce = () => snapshots(usageRows({ claudeWeekly: 88, claudeReset: 5 * 24 * 60 }))

test('conservation acts: a yes moves easy work off the scarce strongest resource, which stays available to review', async () => {
  const d = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.9 }), { snapshots: scarce() })
  assert.notEqual(d.routing.primaryAgent, 'claude', 'the conservation answer changed who does the work')
  assert.deepEqual(d.routing.decision.conservation, { from: 'claude', to: d.routing.primaryAgent, confidence: 0.9, authority: 'jev' })
  assert.equal(d.routing.conservedFrom, 'claude')
  assert.equal(d.routing.agentConfidence, 0.9, 'the confidence reported is the judgment that placed this primary')
  assert.ok(d.excluded.some((e) => e.id === 'claude' && /conserved/.test(e.reason)), 'kept out of the work pool, and says why')
  assert.ok(!('claude' in d.routing.agentProbabilities), 'so no later re-read of the probabilities can hand the work straight back')
  assert.ok(d.plan.steps.every((st) => st.agent !== 'claude'), 'no work step runs on the conserved resource')
  assert.ok(!d.plan.fallbackOrder.includes('claude'))
  assert.ok(d.plan.notes.some((n) => /claude conserved for harder work/.test(n)))
  // Moved to a resource whose KNOWN tier meets the floor, never to an unmeasured one.
  const to = byKey(d, d.routing.primaryAgent)
  assert.ok(['standard', 'strong', 'frontier'].includes(to.tier))
})

test('conservation that says no, or cannot decide, leaves the pick alone', async () => {
  for (const conserve of [0.1, 0.5]) {
    const d = await decide(engine(), fakeJev({ pick: strongestCoder, conserve }), { snapshots: scarce() })
    assert.equal(d.routing.primaryAgent, 'claude', `conserve ${conserve} does not move the work`)
    assert.equal(d.routing.decision.conservation, null)
  }
})

test('conservation moves work only to a resource whose capability is known to meet the floor', async () => {
  // Only one prior family speaks to planning, so for a planning task every other resource's tier
  // is unknown. The floor lets an unknown stay a candidate (unknown is not insufficient), but
  // conservation must not hand it work taken off a resource known to be capable: that is a
  // gamble, not a saving.
  const profile = profileOf({ taskType: 'architecture', requirements: { planning: 0.9, coding: 0.3 } })
  const agents = AGENTS.filter((a) => a.id === 'codex' || a.id === 'deepseek')
  const strongestPlanner = (cs) => cs.reduce((m, c) => (c.capabilities.planning?.score > (m.capabilities.planning?.score ?? 0) ? c : m))
  const d = await decide(engine(), fakeJev({ profile, pick: strongestPlanner, conserve: 0.99 }), { agents, snapshots: snapshots(usageRows({ codexWeekly: 90 })) })
  assert.equal(byKey(d, 'codex').tier, 'frontier')
  assert.equal(byKey(d, 'deepseek').tier, 'unknown', 'the setting: the only alternative is unmeasured')
  assert.equal(d.routing.primaryAgent, 'codex')
  assert.equal(d.routing.decision.conservation, null)
})

test('when conservation moves the work, the resource pick is not handed to the run for labelling', async () => {
  const d = await decide(engineWith(fakeDomains()), fakeJev({ pick: strongestCoder, conserve: 0.9 }), { snapshots: scarce() })
  assert.ok(d.routing.decision.conservation, 'conservation moved the work')
  const domainsLabelled = d.samples.map((x) => x.domain)
  assert.ok(!domainsLabelled.includes('resource_selection'), 'the run tests another resource; it cannot confirm or refute the pick')
  assert.ok(domainsLabelled.includes('conservation'), 'the conservation decision is the one the run tests')
  assert.equal(d.domains.resource_selection.movedBy, 'conservation')
  const kept = await decide(engineWith(fakeDomains()), fakeJev({ pick: strongestCoder, conserve: 0.1 }), { snapshots: scarce() })
  assert.ok(kept.samples.some((x) => x.domain === 'resource_selection'), 'an unmoved pick is labelled as before')
})

test('the selected skill is handed to the router in the plan, in the SKILLS vocabulary', async () => {
  const d = await decide(engine(), fakeJev({ profile: profileOf({ skills: { primary: 'testing', supporting: ['debugging', 'no-such-skill'] } }) }))
  assert.equal(d.plan.skill.primary, 'testing')
  assert.deepEqual(d.plan.skill.supporting, ['debugging'], 'an unknown supporting skill is dropped')
  assert.equal(d.plan.skill.description, SKILLS.testing)
  assert.equal(d.routing.decision.plan.skill.primary, 'testing', 'and the routing record carries it')
  // The heuristic path names a skill, not a task type: `refactor` is a task, `refactoring` the skill.
  const h = await decide(engine(), null, { task: 'refactor the parser', jevUnavailableReason: 'no key' })
  assert.equal(h.plan.skill.primary, 'refactoring')
  assert.ok(Object.hasOwn(SKILLS, h.plan.skill.primary))
})

test('the skill domain decides the skill even when the task type came from a mature local classifier', async () => {
  const local = { task_classification: { label: 'refactor', probabilities: { refactor: 0.97 }, confidence: 0.97 } }
  const jev = fakeJev({ profile: profileOf({ skills: { primary: 'testing', supporting: ['debugging'] } }) })
  const d = await decide(engineWith(fakeDomains({ local })), jev)
  assert.equal(d.profile.taskType, 'refactor', 'the local classifier set the task type')
  assert.equal(d.domains.skill_selection.authority, 'jev')
  assert.equal(d.plan.skill.primary, 'testing', 'and Jev, the skill domain\'s authority, set the skill')
  assert.deepEqual(d.plan.skill.supporting, ['debugging'])
  assert.equal(d.plan.skill.authority, 'jev')
})

test('resolveSkills keeps known skills, maps a task type to its skill, and never trusts a prototype key', () => {
  assert.deepEqual(resolveSkills({ primary: 'security', supporting: ['review', 'security', 'review'] }, 'security'), { primary: 'security', supporting: ['review'] })
  assert.deepEqual(resolveSkills({ primary: 'investigation' }, 'investigation'), { primary: 'explanation', supporting: [] })
  assert.equal(resolveSkills({ primary: 'constructor' }, 'simple_change').primary, 'implementation')
  assert.equal(resolveSkills(undefined, 'nonsense').primary, 'implementation')
})

test('with no snapshot, the billing kind and the economics override set the cost, never the provider name', async () => {
  // A resource the governor has no snapshot for yet: its funding is whatever its account says.
  // An unfamiliar provider string on a subscription must read as a subscription, a provider name
  // that happens to be a known subscription CLI must not outrank the kind it was given, and the
  // operator's economics override must outrank the kind's default.
  const agents = [
    { id: 'acme', provider: 'acme-cli', description: 'new', enabled: true, kind: 'subscription' },
    { id: 'renamed', provider: 'claude-code', description: 'metered', enabled: true, kind: 'api' },
    { id: 'byok', provider: 'spawn', description: 'key', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  ]
  const d = await decide(engine(), fakeJev(), { agents, snapshots: [], economics: { byok: { marginalCost: 'low' } } })
  const c = (id) => d.routing.decision.candidates.find((x) => x.id === id) ?? d.candidates.find((x) => x.id === id)
  assert.equal(c('acme').source, 'subscription')
  assert.equal(c('acme').marginalCost, 'low', 'an unfamiliar provider on a subscription is low marginal cost')
  assert.equal(c('renamed').source, 'api', 'the kind decides, not the provider string')
  assert.equal(c('renamed').marginalCost, 'metered')
  assert.equal(c('byok').marginalCost, 'low', 'the operator override outranks the kind')
  // The engine may also be given the override once, the way index.js holds the config.
  const e = createDecisionEngine({ policy, domains: undefined, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, economics: { acme: { marginalCost: 'metered' } }, now: () => now })
  const d2 = await decide(e, fakeJev(), { agents, snapshots: [] })
  assert.equal(d2.candidates.find((x) => x.id === 'acme').marginalCost, 'metered')
})

test('conservation does not move a pick that is not the most capable candidate: it is already conserving', async () => {
  const snaps = scarce()
  const probe = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.1 }), { snapshots: snaps })
  const top = strongestOf(probe.candidates)
  const other = probe.candidates.find((c) => c.id !== top.id && c.tier !== 'unknown')
  assert.ok(top && other, 'the setting: a most capable candidate and a measured alternative')
  const pickOther = (cs) => cs.find((c) => c.key === other.key)
  const d = await decide(engineWith(fakeDomains()), fakeJev({ pick: pickOther, conserve: 0.9 }), { snapshots: snaps })
  assert.equal(d.routing.primaryAgent, other.id, 'the cheaper pick stands')
  assert.equal(d.routing.decision.conservation, null)
  // A yes that could not act is not labelled by the run: the run is exactly what it would have
  // been without the yes, so an accepted run would confirm a conservation that never happened.
  assert.ok(!d.samples.some((x) => x.domain === 'conservation'), 'a yes that could not act stays teacher-only')
  assert.ok(d.samples.some((x) => x.domain === 'resource_selection'), 'the pick itself ran and is labelled')
})

test('the conservation sample is labelled only when the answer decided what the run tests', async () => {
  const run = (conserve) => decide(engineWith(fakeDomains()), fakeJev({ pick: strongestCoder, conserve }), { snapshots: scarce() })
  const moved = await run(0.9)
  assert.ok(moved.routing.decision.conservation)
  assert.ok(moved.samples.some((x) => x.domain === 'conservation'), 'a yes that moved the work')
  const no = await run(0.1)
  assert.equal(no.routing.decision.conservation, null)
  assert.ok(no.samples.some((x) => x.domain === 'conservation'), 'a no where a yes would have acted')
  const flip = await run(0.5)
  assert.equal(flip.domains.conservation.label, 'yes', 'the setting: a coin flip reads yes')
  assert.equal(flip.routing.decision.conservation, null, 'and moves nothing')
  assert.ok(!flip.samples.some((x) => x.domain === 'conservation'), 'so the run cannot confirm it')
  // No measured target at all: a yes could not act either (see the planning-task test above).
  const profile = profileOf({ taskType: 'architecture', requirements: { planning: 0.9, coding: 0.3 } })
  const strongestPlanner = (cs) => cs.reduce((m, c) => (c.capabilities.planning?.score > (m.capabilities.planning?.score ?? 0) ? c : m))
  const agents = AGENTS.filter((a) => a.id === 'codex' || a.id === 'deepseek')
  const stuck = await decide(engineWith(fakeDomains()), fakeJev({ profile, pick: strongestPlanner, conserve: 0.99 }), { agents, snapshots: snapshots(usageRows({ codexWeekly: 90 })) })
  assert.equal(stuck.routing.decision.conservation, null)
  assert.ok(!stuck.samples.some((x) => x.domain === 'conservation'), 'a yes with nowhere to move the work stays teacher-only')
})

test('end to end: a stronger resource rescuing a conserved run labels conservation no', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kz-decision-'))
  const store = createTrainingStore({ file: join(root, 'samples.jsonl') })
  const domains = createDomainRegistry({ policy, store, artifactsDir: join(root, 'classifiers'), stateDir: root })
  const e = createDecisionEngine({ policy, domains, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, store, now: () => now })
  // Without the second frontier resource, the only measured place to move the work is a tier down.
  const agents = AGENTS.filter((a) => a.id !== 'codex')
  const d = await decide(e, fakeJev({ pick: strongestCoder, conserve: 0.9 }), { agents, snapshots: scarce() })
  const { from, to } = d.routing.decision.conservation ?? {}
  assert.ok(from && to, 'conservation moved the work')
  const ref = d.samples.find((x) => x.domain === 'conservation')
  const stored = await store.get(ref.id)
  const tiers = Object.fromEntries((stored.extra?.candidates ?? []).map((c) => [c.id, c.tier]))
  assert.ok(tiers[from] && tiers[to], 'the judgment sample carries the tiers the rescue rule compares')
  assert.deepEqual([tiers[from], tiers[to]], ['frontier', 'strong'], 'the setting: the work moved a tier down')
  assert.equal(JSON.stringify(stored.extra.candidates).includes('capabilities'), false, 'tiers only, no capability table')
  // The conserved resource had to come back and redo the work the cheaper one failed.
  const record = {
    runId: 'r1', sessionId: 's1', ts: at(5), finalStatus: 'accepted', strategy: d.plan.strategy,
    attempts: [{ agent: to, role: 'primary', stopReason: 'error' }, { agent: from, role: 'retry', stopReason: 'completed' }],
  }
  assert.match(record.strategy, /_DIRECT$/, 'the setting: a strategy that planned no second resource')
  const out = await attachOutcomes(store, record, d.samples)
  const cons = out.find((o) => o.domain === 'conservation')?.outcome
  assert.deepEqual([cons?.label, cons?.negativeLabel, cons?.labelSource], ['no', 'yes', 'verified_outcome'], 'conserving was wrong, and the run proved it')
})

test('the strategies are eligible over the pool that does the work and the wider pool that reviews it', async () => {
  // A frontier floor with a gated frontier resource leaves a work pool one resource deep. The
  // gated resource and the merely strong one still review, and the plan is built with them, so
  // the eligible strategies must count them too.
  const rows = usageRows({ claudeWeekly: 90, codexWeekly: 90 })
  const profile = profileOf({ taskType: 'security', complexity: 0.9, risk: 0.95, requirements: { security_review: 0.95, code_review: 0.9, coding: 0.3 }, minimumCapability: 'frontier', preferredCapability: 'frontier' })
  const jev = fakeJev({ profile, pick: (cs) => cs[0] })
  const d = await decide(engine(), jev, { snapshots: snapshots(rows), gated: ['claude', 'codex'] })
  assert.equal(d.candidates.length, 1, 'the setting: one resource does the work')
  assert.ok(d.routing.decision.strategies.includes('CHEAP_EXECUTE_FRONTIER_REVIEW'), 'a reviewer exists outside the work pool')
  assert.deepEqual(jev.calls.at(-1).strategies, d.routing.decision.strategies, 'and that is what Jev was offered')
  // After a conservation move the list is recomputed with the same arguments over the new pool.
  const snaps = scarce()
  const unmoved = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.1 }), { snapshots: snaps })
  const moved = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.9 }), { snapshots: snaps })
  assert.ok(moved.routing.decision.conservation)
  const expected = eligibleStrategies({ candidates: moved.candidates, reviewCandidates: unmoved.candidates, profile: moved.profile, answerOnly: false })
  assert.deepEqual(moved.routing.decision.strategies, expected)
})

test('after a conservation move the strategy is chosen over the pool that really does the work', async () => {
  // Two resources: a scarce frontier one and a strong one. Before the move there is a capability
  // gap, so a cheap-then-premium strategy is on offer. Once the frontier one is conserved one
  // resource does the work, so no strategy that needs two workers can be - but the conserved one
  // still reviews, so a frontier review still can. And the strategy domain must be shown the
  // one-resource pool, not the two-resource pool the decision started from.
  const two = AGENTS.filter((a) => a.id === 'claude' || a.id === 'deepseek')
  const seen = {}
  const spy = () => {
    const inner = fakeDomains()
    return { get: (id) => { const c = inner.get(id); return { ...c, decide: async (args) => { (seen[id] ??= []).push(args); return c.decide(args) } } } }
  }
  const unmoved = await decide(engineWith(fakeDomains()), fakeJev({ pick: strongestCoder, conserve: 0.1 }), { agents: two, snapshots: scarce() })
  const moved = await decide(engineWith(spy()), fakeJev({ pick: strongestCoder, conserve: 0.9 }), { agents: two, snapshots: scarce() })
  assert.equal(moved.routing.decision.conservation?.from, 'claude', 'the setting: conservation moved the work')
  assert.equal(moved.routing.primaryAgent, 'deepseek')
  assert.ok(unmoved.routing.decision.strategies.includes('CHEAP_THEN_PREMIUM_REVIEW'), 'two workers with a gap before the move')
  assert.ok(!moved.routing.decision.strategies.includes('CHEAP_THEN_PREMIUM_REVIEW'), 'one worker after it')
  assert.ok(!moved.routing.decision.strategies.includes('PREMIUM_PLAN_CHEAP_EXECUTE'))
  assert.ok(moved.routing.decision.strategies.includes('CHEAP_EXECUTE_FRONTIER_REVIEW'), 'the conserved resource still reviews')
  assert.notDeepEqual(moved.routing.decision.strategies, unmoved.routing.decision.strategies)
  const strategyFeatures = seen.execution_strategy?.at(-1)?.features?.numeric
  assert.ok(strategyFeatures, 'the strategy domain was consulted')
  assert.equal(strategyFeatures.pool_size_log, Math.round(Math.log1p(1) * 1000) / 1000, 'and saw a one-resource pool')
  assert.equal(strategyFeatures.frontier_available, 0, 'with no frontier worker in it')
})

test('an off-vocabulary skill is reported as the skill the run really uses, and not labelled by the run', async () => {
  const jev = () => fakeJev({ profile: profileOf({ skills: { primary: 'refactor', supporting: [] } }) })
  const plain = await decide(engine(), jev())
  const resolved = TASK_SKILLS.implementation
  assert.equal(plain.plan.skill.primary, resolved)
  assert.equal(plain.plan.skill.authority, 'fallback', 'the deterministic rule chose the skill, not the profile')
  assert.equal(plain.plan.skill.mappedFrom, 'refactor')
  const d = await decide(engineWith(fakeDomains()), jev())
  assert.equal(d.domains.skill_selection.label, resolved, 'the report shows the resolved skill, not the raw label')
  assert.equal(d.domains.skill_selection.authority, 'fallback')
  assert.equal(d.domains.skill_selection.decidedBy, 'jev')
  assert.equal(d.domains.skill_selection.mappedFrom, 'refactor')
  assert.equal(d.plan.skill.authority, 'fallback')
  assert.ok(!d.samples.some((x) => x.domain === 'skill_selection'), 'the run used another skill, so it cannot confirm refactor')
  // A skill in the vocabulary is untouched.
  const ok = await decide(engineWith(fakeDomains()), fakeJev({ profile: profileOf({ skills: { primary: 'testing', supporting: [] } }) }))
  assert.equal(ok.domains.skill_selection.authority, 'jev')
  assert.equal(ok.domains.skill_selection.mappedFrom, undefined)
  assert.ok(ok.samples.some((x) => x.domain === 'skill_selection'))
})

test('versionOf reaches the subject, so the profile read is keyed the way evidence is recorded', async () => {
  const base = createCapabilityRegistry({ priors: PRIORS, policy })
  const seen = []
  const profiles = { ...base, profileOf: (subject, opts) => { seen.push(subject); return base.profileOf(subject, opts) } }
  const e = createDecisionEngine({ policy, domains: undefined, profiles, priors: PRIORS, now: () => now })
  const versionOf = (a, model) => (a.id === 'claude' ? `${model}-20260901` : undefined)
  await decide(e, fakeJev(), { versionOf })
  const claude = seen.find((s) => s.model === 'claude-opus-5')
  assert.equal(claude?.version, 'claude-opus-5-20260901')
  assert.deepEqual(claude, subjectOf(AGENTS[0], { modelOf, versionOf, priors: PRIORS }), 'the same subject profiles.js records against')
})

test('the resource call carries identities keyed like the anonymous table, with specific names only', async () => {
  const jev = fakeJev()
  const d = await decide(engine(), jev)
  assert.equal(jev.calls[0].identities, undefined, 'the task call carries no candidate table, so no identities')
  const call = jev.calls.find((c) => c.candidates)
  const ids = call.identities
  assert.ok(Array.isArray(ids) && ids.length === AGENTS.length, 'every agent, so an excluded one is masked too')
  const tableKeys = new Set(call.candidates.map((c) => c.key))
  for (const entry of ids) {
    const inPool = d.routing.decision.candidates.find((c) => c.id === entry.id)
    if (inPool) assert.equal(entry.key, inPool.key, `${entry.id} carries the key the table uses`)
    if (entry.key) assert.ok(tableKeys.has(entry.key) || !inPool, `${entry.key} is a key the table offers`)
    const a = AGENTS.find((x) => x.id === entry.id)
    const own = new Set([a.id, a.name, a.provider, a.llm?.provider, a.llm?.model, modelOf(a)].filter(Boolean))
    for (const n of entry.names) assert.ok(own.has(n), `${entry.id}: ${n} is its id, name, provider or model id`)
  }
  assert.ok(ids.find((x) => x.id === 'claude').names.includes('claude-opus-5'), 'the model id is named')
  // Through the masker the call really uses: a generic token is never a name, so it is never
  // masked inside values that have nothing to do with any agent ('free-local' stays), while a
  // provider word that names one agent reads as that agent's key, as it does in the review call.
  const { anonymity } = await import('../jev.js')
  const anon = anonymity(ids)
  const claudeKey = ids.find((x) => x.id === 'claude').key
  assert.equal(anon.mask('free-local tier, spawned via spawn on local'), 'free-local tier, spawned via spawn on local')
  assert.equal(anon.mask('claude-code timed out'), `${claudeKey} timed out`)
})

test('the routing call and the review call mask the same names', async () => {
  // A provider word that names one agent (here a gateway nobody else uses) was masked in the
  // review call and sent as typed in the routing call, next to the same anonymous table.
  const { anonymity } = await import('../jev.js')
  const agents = [...AGENTS, { id: 'gw', provider: 'spawn', description: 'e', enabled: true, kind: 'api', llm: { provider: 'openrouter', model: 'router-large-2' } }]
  const jev = fakeJev()
  await decide(engine(), jev, { agents })
  const ids = jev.calls.find((c) => c.candidates).identities
  const gw = ids.find((x) => x.id === 'gw')
  assert.ok(gw.names.includes('openrouter'), JSON.stringify(gw))
  assert.equal(anonymity(ids).mask('openrouter returned 502'), `${gw.key ?? '[resource]'} returned 502`)
})

test('a model ALIAS from a CLI setting is not an identity name; a model id is', async () => {
  // Claude Code's model setting is often an alias. 'best' registered as a name would be masked
  // inside every reason that says "the best fit"; 'opus' is a brand term and masked anyway.
  for (const alias of ['best', 'default', 'opus', 'sonnet']) {
    const jev = fakeJev()
    await decide(engine(), jev, { modelOf: (a) => (a.provider === 'claude-code' ? alias : modelOf(a)) })
    const claude = jev.calls.find((c) => c.candidates).identities.find((x) => x.id === 'claude')
    assert.ok(!claude.names.includes(alias), `the alias ${alias} is not a name`)
    assert.ok(claude.names.includes('claude'), 'the id still is')
  }
  const jev = fakeJev()
  await decide(engine(), jev, { modelOf: (a) => (a.provider === 'codex' ? 'o3' : modelOf(a)) })
  assert.ok(jev.calls.find((c) => c.candidates).identities.find((x) => x.id === 'codex').names.includes('o3'), 'a short model id is')
})

test('every domain decision a run makes carries its run id, so a later verdict can find the samples', async () => {
  const seen = []
  const inner = fakeDomains()
  const spy = { get: (id) => { const c = inner.get(id); return { ...c, decide: async (args) => { seen.push([id, args.context?.runId]); return c.decide(args) } } } }
  await decide(engineWith(spy), fakeJev(), { runId: 'run-42' })
  assert.ok(seen.length >= 4, `the domains were consulted (${seen.length})`)
  for (const [id, runId] of seen) assert.equal(runId, 'run-42', `${id} got the run id`)
})

test('a resource whose allowance is healthy is never conserved, however sure the judgment is', async () => {
  // 20% of the week used: the governor says spend normally. A confident "conserve" from Jev or a
  // matured classifier would otherwise send easy work to a second-best resource for no saving.
  const d = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.95 }))
  assert.ok(byKey(d, 'claude').scarcity < 0.2, 'the setting: nothing is being used up')
  assert.equal(d.routing.primaryAgent, 'claude')
  assert.equal(d.routing.decision.conservation, null)
  assert.equal(d.routing.conservedFrom, undefined)
  // The same judgment against a scarce allowance still acts.
  const scarceRun = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.95 }), { snapshots: scarce() })
  assert.equal(scarceRun.routing.conservedFrom, 'claude')
})

test('a task type a person refuted is not averaged into the type it was not', () => {
  const row = (label, risk, outcome) => ({ teacher: { label }, extra: { profile: { risk, complexity: 0.5 } }, ...(outcome === undefined ? {} : { outcome }) })
  const classes = classProfiles([
    row('security', 0.9, { label: 'security', labelSource: 'teacher_confirmed', verified: true }),
    row('security', 0.9, { label: 'security', labelSource: 'teacher_confirmed', verified: true }),
    row('security', 0.1, { label: null, negativeLabel: 'security', labelSource: 'human', verified: true }),
    row('security', 0.9),
  ])
  assert.equal(classes.security.n, 3, 'the refuted row is not a security example')
  assert.equal(classes.security.mean.risk, 0.9, 'so its low risk does not drag the class down')
})

test('the capability the task needs is a hard fact applied before any judgment, and says so', async () => {
  const jev = fakeJev({ profile: profileOf({ capability: 'web_research' }) })
  const capableFor = (cap) => (cap === 'web_research' ? new Set(['claude', 'codex', 'deepseek']) : null)
  const d = await decide(engine(), jev, { capableFor })
  assert.ok(!d.candidates.some((c) => c.id === 'qwen-local'), 'a model with no network is not weighed for a look-up')
  const out = d.excluded.find((e) => e.id === 'qwen-local')
  assert.ok(out?.hard && /cannot do what this request needs \(web_research\)/.test(out.reason))
  const offered = jev.calls.find((c) => c.candidates)?.candidates ?? []
  assert.equal(offered.length, d.candidates.length, 'the resource judgment never saw it')
  // A capability nothing here has refuses the run with the code the router stops on.
  const err = await decide(engine(), fakeJev({ profile: profileOf({ capability: 'web_research' }) }), { capableFor: () => new Set() }).then(() => null, (e) => e)
  assert.equal(err?.code, NO_CANDIDATES)
})

test('the resource call masks every configured agent, not only the ones in this pool', async () => {
  const jev = fakeJev()
  const pool = AGENTS.filter((a) => a.id !== 'codex')
  await decide(engine(), jev, { agents: pool, everyAgent: AGENTS })
  const ids = jev.calls.find((c) => c.candidates).identities
  const codex = ids.find((x) => x.id === 'codex')
  assert.ok(codex, 'an agent outside the pool is still named for the masker')
  assert.equal(codex.key, undefined, 'with no key, so it masks to the neutral placeholder')
  assert.ok(codex.names.includes('gpt-5.6'), 'and its model id is among the names masked')
})

test('the strategy domain is labelled only by a run that carries out its answer', async () => {
  const two = AGENTS.filter((a) => a.id === 'claude' || a.id === 'deepseek')
  // Unrestricted: the answer runs, and the run labels it.
  const ran = await decide(engineWith(fakeDomains()), fakeJev({ strategy: 'STANDARD_DIRECT' }), { agents: two })
  assert.equal(ran.plan.strategy, 'STANDARD_DIRECT')
  assert.ok(ran.samples.some((x) => x.domain === 'execution_strategy'))
  // After conservation leaves one worker, CHEAP_THEN_PREMIUM_REVIEW cannot run; the run does not
  // get to "confirm" it.
  const moved = await decide(engineWith(fakeDomains()), fakeJev({ pick: strongestCoder, conserve: 0.9, strategy: 'CHEAP_THEN_PREMIUM_REVIEW' }), { agents: two, snapshots: scarce() })
  assert.equal(moved.routing.conservedFrom, 'claude', 'the setting: conservation moved the work')
  assert.notEqual(moved.plan.strategy, 'CHEAP_THEN_PREMIUM_REVIEW')
  assert.ok(!moved.samples.some((x) => x.domain === 'execution_strategy'), 'a strategy that never ran is not labelled')
})

test('the broker takes the planner and the parallel answerer from the work pool, the reviewer from the review pool', async () => {
  const { planStrategy } = await import('../broker.js')
  const c = (id, tier, over = {}) => ({ id, tier, fit: 0.8, source: 'api', marginalCost: 'metered', expectedCost: { total: 0.5 }, ...over })
  const work = [c('cheap', 'standard'), c('mid', 'strong')]
  const review = [...work, c('kept', 'frontier')]
  const par = planStrategy({ strategy: 'PARALLEL_SECOND_OPINION', primaryId: 'cheap', candidates: work, reviewCandidates: review, answerOnly: true })
  assert.equal(par.parallelWith, 'mid', 'the frontier resource kept for review does not answer the task')
  const planned = planStrategy({ strategy: 'PREMIUM_PLAN_CHEAP_EXECUTE', primaryId: 'cheap', candidates: work, reviewCandidates: review })
  assert.equal(planned.steps.find((st) => st.role === 'plan')?.agent, 'mid', 'nor does it write the plan')
  const reviewed = planStrategy({ strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW', primaryId: 'cheap', candidates: work, reviewCandidates: review })
  assert.equal(reviewed.reviewer, 'kept', 'but it does review, which is what it was kept for')
})


test('a judgment that cannot change the run is not labelled by it', async () => {
  const labelled = (d) => d.samples.map((x) => x.domain)
  // A direct plan with no review in it: a second opinion or a frontier review would change the run.
  const plain = await decide(engineWith(fakeDomains()), fakeJev({ strategy: 'STANDARD_DIRECT' }))
  assert.equal(plain.plan.forceReview, false, 'the setting: no review planned')
  assert.ok(labelled(plain).includes('second_opinion'))
  assert.ok(labelled(plain).includes('frontier_escalation'))
  // An answer-only run is never reviewed, so neither answer can do anything.
  const answer = await decide(engineWith(fakeDomains()), fakeJev({ strategy: 'STANDARD_DIRECT' }), { answerOnly: true })
  assert.ok(!labelled(answer).includes('second_opinion'), 'an accepted answer would confirm a second opinion nobody gave')
  assert.ok(!labelled(answer).includes('frontier_escalation'))
  // A plan that already has its frontier review: the run is reviewed whatever either answer was.
  const risky = profileOf({ risk: 0.9, complexity: 0.6 })
  const planned = await decide(engineWith(fakeDomains()), fakeJev({ profile: risky, strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW' }))
  assert.equal(planned.plan.strategy, 'CHEAP_EXECUTE_FRONTIER_REVIEW', 'the setting: the plan reviews')
  assert.ok(planned.plan.forceReview && planned.plan.frontierReview)
  assert.ok(!labelled(planned).includes('second_opinion'))
  assert.ok(!labelled(planned).includes('frontier_escalation'))
  // A frontier yes that adds the review is labelled: it is exactly what the run then tests.
  const added = await decide(engineWith(fakeDomains()), fakeJev({ profile: risky, strategy: 'STANDARD_DIRECT' }))
  assert.ok(added.plan.notes.includes('frontier review added by the frontier-escalation domain'))
  assert.ok(labelled(added).includes('frontier_escalation'))
})

test('what cleared the hard facts but does not do the work is recorded with its numbers, for the review', async () => {
  const d = await decide(engine(), fakeJev({ pick: strongestCoder, conserve: 0.9 }), { snapshots: scarce() })
  assert.equal(d.routing.conservedFrom, 'claude', 'the setting: claude was conserved')
  const conserved = d.routing.decision.reviewOnly.find((r) => r.id === 'claude')
  assert.ok(conserved, 'the conserved resource is kept to review, so its numbers are too')
  assert.equal(conserved.tier, 'frontier')
  assert.equal(typeof conserved.capabilities.coding.score, 'number')
  assert.ok(!d.routing.decision.candidates.some((c) => c.id === 'claude'), 'and it is still no candidate for the work')
  // The floored-out local model is review-only too, and one excluded by a hard fact is neither.
  assert.ok(d.routing.decision.reviewOnly.some((r) => r.id === 'qwen-local'))
  const small = await decide(engine(), fakeJev(), { snapshots: snapshots(usageRows()).map((s) => (s.resourceId === 'qwen-local' ? { ...s, hardware: { ...s.hardware, contextTokens: 10 } } : s)) })
  assert.ok(small.excluded.some((e) => e.id === 'qwen-local' && e.hard))
  assert.ok(!small.routing.decision.reviewOnly.some((r) => r.id === 'qwen-local'))
})

test('a gated resource the frontier exception does not keep is recorded as past its gate', async () => {
  // A frontier task that only a gated resource can do keeps that one for the work. A gated
  // resource whose tier for the task is unknown also clears the floor (unknown is not
  // insufficient), and it is still past its gate: the record says so rather than dropping it
  // without a word, which left the review call to guess why it was out.
  const profile = profileOf({ taskType: 'architecture', requirements: { planning: 0.9, coding: 0.3 }, minimumCapability: 'frontier', preferredCapability: 'frontier' })
  const agents = AGENTS.filter((a) => a.id === 'codex' || a.id === 'deepseek')
  const d = await decide(engine(), fakeJev({ profile }), { agents, gated: ['codex', 'deepseek'] })
  assert.equal(d.routing.decision.gateOverride, true, 'the setting: the gate yielded for the frontier resource')
  assert.deepEqual(d.candidates.map((c) => c.id), ['codex'])
  assert.deepEqual(d.excluded.filter((e) => e.id === 'deepseek').map((e) => e.reason), ['past its weekly gate: kept for review only'])
  assert.deepEqual(d.routing.decision.reviewOnly.map((r) => r.id), ['deepseek'], 'and it is kept to review, with its numbers')
})

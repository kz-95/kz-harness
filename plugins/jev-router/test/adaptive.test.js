// The whole chain, through the real routing loop: provider adapters, capability registry,
// governor, decision engine, broker, the maturity ladder and the training store, with only the
// agents and Jev faked. Scenarios I (plan, execute, check, review), L (evidence changes routing),
// Q (a verified outcome overrides the teacher's label) and AC (a mature domain stops calling Jev).
//
// The point of this file is that nothing is stubbed between the modules: a test that passes here
// passes because the pieces really fit, not because a mock said they did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createDecisionEngine } from '../decision.js'
import { createJev } from '../jev.js'
import { createReview } from '../../jev-review/index.js'
import { createDomainRegistry } from '../domains.js'
import { createCapabilityRegistry, loadPriors, subjectOf } from '../profiles.js'
import { snapshotResources } from '../resources.js'
import { formatReport, runRouted } from '../router.js'
import { mergePolicy, resolvePolicy } from '../routing-policy.js'
import { createTrainingStore, labelFromRun } from '../training.js'

const PRIORS = loadPriors(fileURLToPath(new URL('../../../config/capability-priors.json', import.meta.url)))
const signal = new AbortController().signal

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-adaptive-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" } }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]
const modelOf = (a) => a.llm?.model ?? (a.provider === 'claude-code' ? 'claude-opus-5' : 'gpt-5.6')
const NOW = Date.parse('2026-09-22T10:00:00.000Z')
const at = (m) => new Date(NOW + m * 60_000).toISOString()
const win = (name, minutes, usedPercent, resetsAt) => ({ name, minutes, usedPercent, resetsAt })
const usageRows = ({ weekly = 20 } = {}) => ({
  claude: { kind: 'subscription', provider: 'claude-code', windows: [win('5h', 300, 10, at(120)), win('weekly', 10080, weekly, at(5 * 24 * 60))], via: 'oauth-usage', state: 'ok', checkedAt: at(-1), limits: {} },
  codex: { kind: 'subscription', provider: 'codex', windows: [win('5h', 300, 8, at(120)), win('weekly', 10080, weekly, at(5 * 24 * 60))], via: 'codex-app-server', plan: 'plus', state: 'ok', checkedAt: at(-1), limits: {} },
  deepseek: { kind: 'api', provider: 'spawn', windows: [], balance: { amount: 30, currency: 'USD' }, creditPercent: 75, creditPeak: { amount: 40, currency: 'USD' }, state: 'ok', checkedAt: at(-1), limits: { minBalance: 5, handoffAtBalance: 10 } },
})
const ready = Object.fromEntries(AGENTS.map((a) => [a.id, { installed: true, loggedIn: true, detail: 'ok' }]))

const config = {
  agents: AGENTS,
  tools: [],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 6 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
  effort: {},
}

const profileOf = (over = {}) => ({
  taskType: 'implementation', taskTypeConfidence: 0.9, complexity: 0.6, risk: 0.3,
  requirements: { coding: 0.9, testing: 0.4 }, skills: { primary: 'implementation', supporting: [] },
  minimumCapability: 'standard', preferredCapability: 'strong', verification: ['checks'],
  needsSecondOpinion: 0.2, needsHumanReview: 0.1, needsTests: 0.9, ...over,
})
const verdict = (v, over = {}) => ({
  verdict: v, verdictConfidence: 0.9, verdictProbabilities: {},
  disposition: v === 'accept' ? 'PASS' : v === 'second_review' ? 'SECOND_OPINION' : 'RETRY_DIFFERENT_RESOURCE',
  dispositionConfidence: 0.9, dispositionProbabilities: {},
  ...(v === 'accept' ? { addressed: 0.9, complete: 0.9 } : { addressed: 0.2, complete: 0.2 }),
  unrelatedChanges: 0.1, regressionRisk: 0.1, needsPerson: 0.05,
  reviewAgent: 'claude', reviewAgentProbabilities: { claude: 0.6, codex: 0.4 },
  retryAgent: 'claude', retryAgentProbabilities: { claude: 0.6, codex: 0.4 },
  ...over,
})

/** A fake Jev whose resource pick and strategy the test names, recording what it was asked. */
function fakeJev({ profile = profileOf(), pick, strategy = 'STANDARD_DIRECT', assess = () => verdict('accept') } = {}) {
  const calls = []
  return {
    calls,
    route: async (args) => {
      calls.push(args)
      const out = { model: 'jev-test' }
      if (args.ask?.task) { out.profile = profile; Object.assign(out, { taskType: profile.taskType, complexity: profile.complexity, risk: profile.risk, handler: 'agent' }) }
      if (args.candidates && args.ask?.resource) {
        const chosen = pick ? pick(args.candidates) : args.candidates[0]
        out.resource = { chosenKey: chosen.key, confidence: 0.85, probabilities: Object.fromEntries(args.candidates.map((c) => [c.key, c.key === chosen.key ? 0.85 : 0.15 / Math.max(1, args.candidates.length - 1)])) }
        out.strategy = { choice: strategy, confidence: 0.8, probabilities: { [strategy]: 0.8 } }
      }
      if (args.candidates && args.ask?.judgments) Object.assign(out, { secondOpinion: 0.2, conserve: 0.3, frontierReview: profile.risk >= 0.8 ? 0.9 : 0.1 })
      return out
    },
    assess: async (...a) => assess(...a),
  }
}

const smallGates = {
  shadowSamples: 10, guardedSamples: 20, localOnlySamples: 30, perClassSamples: 5, holdoutSamples: 3, recentWindow: 20,
  guarded: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.3 },
  localOnly: { accuracy: 0.85, recentAccuracy: 0.85, macroF1: 0.8, maxEce: 0.35 },
  maxHighConfidenceError: 0.35, confidenceThreshold: 0.6, minOutcomeBacked: 0.5, maxTeacherOnly: 0.5,
  rollback: { recentAccuracyFloor: 0.7, maxEce: 0.4, repromoteSamples: 5 },
}
const testPolicy = (over = {}) => resolvePolicy(mergePolicy({
  gates: { LOW: smallGates, MEDIUM: smallGates, HIGH: smallGates },
  retrain: { minSamples: 8, everyNewSamples: 1, epochs: 300, learningRate: 0.3 },
  minClassRecall: 0.4,
}, over))

/** Everything the router needs, wired the way index.js wires it. */
function stack({ policy = testPolicy(), root = mkdtempSync(join(tmpdir(), 'kz-stack-')), learn = true, usage = usageRows() } = {}) {
  const profiles = createCapabilityRegistry({ file: join(root, 'evidence.jsonl'), priors: PRIORS, policy })
  const store = createTrainingStore({ file: join(root, 'samples.jsonl') })
  const domains = learn ? createDomainRegistry({ policy, store, artifactsDir: join(root, 'classifiers'), stateDir: root }) : null
  const engine = createDecisionEngine({ policy, domains, profiles, priors: PRIORS, store })
  const snapshots = snapshotResources({ agents: AGENTS, usage, ready, config: {}, now: NOW, modelOf, policy })
  return { policy, root, profiles, store, domains, engine, snapshots }
}

const deps = (s, jev, execute, extra = {}) => ({
  jev,
  execute,
  history: { recent: async () => [], records: async () => [], append: async () => {} },
  modelOf,
  decide: async (args) => {
    const d = await s.engine.decide({ ...args, snapshots: s.snapshots })
    s.lastSamples = d.samples ?? []
    return d
  },
  outcomeDomain: s.domains?.get('outcome_disposition') ?? null,
  ...extra,
})

const fixer = (dir) => { writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'fixed it' } }

test('scenario I: plan on the strongest, implement on the cheaper, check, then review', async () => {
  const dir = repo()
  // The subscriptions are well into their week, so the metered key is genuinely the cheaper
  // resource and the strongest one is genuinely dearer: the gap a plan-then-execute needs.
  const s = stack({ usage: usageRows({ weekly: 88 }) })
  const seen = []
  // Jev picks the cheapest capable resource and asks for the plan-then-execute strategy.
  const jev = fakeJev({
    pick: (cs) => cs.reduce((m, c) => ((c.expectedCost?.total ?? 1) < (m.expectedCost?.total ?? 1) ? c : m)),
    strategy: 'PREMIUM_PLAN_CHEAP_EXECUTE',
    assess: () => verdict('accept'),
  })
  const execute = async (a, prompt) => {
    seen.push({ id: a.id, plan: /Plan, but do not carry out/.test(prompt), followsPlan: /A stronger model planned this work first/.test(prompt), review: /Independently review/.test(prompt) })
    if (/Plan, but do not carry out/.test(prompt)) return { stopReason: 'completed', answerText: 'THE PLAN: change state.txt' }
    if (/Independently review/.test(prompt)) return { stopReason: 'completed', answerText: 'looks right' }
    return fixer(dir)
  }
  const r = await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, execute) })

  const roles = r.attempts.map((a) => a.role)
  assert.deepEqual(roles, ['plan', 'primary', 'review'], 'a plan step, the work, then an independent review')
  assert.equal(seen[0].plan, true, 'the planner was told to plan and not to act')
  assert.equal(seen[1].followsPlan, true, 'and the worker was handed that plan')
  assert.notEqual(r.attempts[0].agent, r.attempts[1].agent, 'the planner is not the worker')
  assert.equal(r.attempts[2].agent, r.attempts[0].agent, 'the strongest resource comes back to judge the result')
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(r.strategy, 'PREMIUM_PLAN_CHEAP_EXECUTE')
  const report = formatReport(r)
  assert.match(report, /Strategy: PREMIUM_PLAN_CHEAP_EXECUTE/)
  assert.match(report, /plan by/)
})

test('a strategy that promises a review gets one even when the review would have accepted', async () => {
  const dir = repo()
  const s = stack()
  const jev = fakeJev({ strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW', pick: (cs) => cs[0], assess: () => verdict('accept') })
  const used = []
  const execute = async (a, prompt) => { used.push(a.id); return /Independently review/.test(prompt) ? { stopReason: 'completed', answerText: 'fine' } : fixer(dir) }
  const r = await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, execute) })
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[1].role, 'review')
  assert.notEqual(used[1], used[0], 'and by someone other than the worker')
  assert.match(r.assessments[0].why, /strategy requires/)
  assert.equal(r.finalStatus, 'accepted')
})

test('the candidate table Jev sees carries capability evidence and no provider names', async () => {
  const dir = repo()
  const s = stack()
  const jev = fakeJev({ pick: (cs) => cs[0] })
  await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, async () => fixer(dir)) })
  const resourceCall = jev.calls.find((c) => c.candidates)
  assert.ok(resourceCall, 'the resource judgment was asked')
  const text = JSON.stringify(resourceCall.candidates)
  for (const word of ['claude', 'codex', 'deepseek', 'anthropic', 'openai', 'gpt']) {
    assert.ok(!text.toLowerCase().includes(word), `${word} must not reach the candidate table`)
  }
  for (const c of resourceCall.candidates) {
    assert.match(c.key, /^RESOURCE_[A-Z]/)
    assert.equal(typeof c.capabilities.coding.score, 'number')
    assert.equal(typeof c.capabilities.coding.confidence, 'number')
    assert.ok(['none', 'low', 'metered'].includes(c.marginalCost))
  }
})

test('scenario Q: a verified rescue labels the rescuer, not the teacher\'s pick', async () => {
  const dir = repo()
  const s = stack()
  // Jev picks the first candidate; it fails, and the retry by another resource succeeds.
  let attempt = 0
  const jev = fakeJev({
    pick: (cs) => cs[0],
    assess: () => (attempt === 1 ? verdict('retry') : verdict('accept')),
  })
  const used = []
  const execute = async (a) => {
    used.push(a.id)
    attempt++
    if (attempt === 1) return { stopReason: 'completed', answerText: 'no idea' }
    return fixer(dir)
  }
  const r = await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, execute) })
  assert.equal(r.finalStatus, 'accepted')
  assert.notEqual(used[1], used[0], 'a different resource rescued the run')

  const sample = (await s.store.list({ domain: 'resource_selection' })).at(-1)
  const outcome = labelFromRun('resource_selection', sample, r)
  assert.ok(outcome, 'the run taught the resource domain something')
  assert.equal(outcome.verified, true)
  assert.equal(outcome.labelSource, 'verified_outcome')
  assert.notEqual(outcome.chosenKey, sample.teacher.chosenKey, 'the label is the rescuer, not the pick that failed')
  assert.equal(outcome.negativeKey, sample.teacher.chosenKey, 'and the failed pick is recorded as the negative')
})

test('a pick that worked confirms the teacher rather than contradicting it', async () => {
  const dir = repo()
  const s = stack()
  const jev = fakeJev({ pick: (cs) => cs[0] })
  const r = await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, async () => fixer(dir)) })
  const sample = (await s.store.list({ domain: 'resource_selection' })).at(-1)
  const outcome = labelFromRun('resource_selection', sample, r)
  assert.equal(outcome.labelSource, 'teacher_confirmed')
  assert.equal(outcome.chosenKey, sample.teacher.chosenKey)
})

test('scenario L: recorded execution evidence moves the effective capability, with no code change', async () => {
  const s = stack()
  const weak = AGENTS.find((a) => a.id === 'deepseek')
  const strong = AGENTS.find((a) => a.id === 'claude')
  const weakSubject = subjectOf(weak, { modelOf, priors: PRIORS })
  const strongSubject = subjectOf(strong, { modelOf, priors: PRIORS })
  const before = {
    weak: s.profiles.profileOf(weakSubject).dimensions.coding.score,
    strong: s.profiles.profileOf(strongSubject).dimensions.coding.score,
  }
  assert.ok(before.weak < before.strong, 'the owner prior starts the cheaper resource lower on coding')
  // Sixty verified wins for the cheaper resource, sixty verified losses for the other.
  const rows = []
  for (let i = 0; i < 60; i++) {
    rows.push({ subject: weakSubject, dimension: 'coding', score: 1, source: 'objective_deterministic', confidence: 0.9, n: 1, taskType: 'implementation' })
    rows.push({ subject: strongSubject, dimension: 'coding', score: 0, source: 'objective_deterministic', confidence: 0.9, n: 1, taskType: 'implementation' })
  }
  s.profiles.recordMany(rows)
  const after = {
    weak: s.profiles.profileOf(weakSubject, { taskType: 'implementation' }).dimensions.coding.score,
    strong: s.profiles.profileOf(strongSubject, { taskType: 'implementation' }).dimensions.coding.score,
  }
  assert.ok(after.weak > after.strong, `verified evidence overtook the prior (${after.weak} over ${after.strong})`)

  // And the routing that reads those numbers follows, with nothing in the code changed.
  const dir = repo()
  const jev = fakeJev({ pick: (cs) => cs.reduce((m, c) => (c.capabilities.coding.score > m.capabilities.coding.score ? c : m)) })
  const used = []
  await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, async (a) => { used.push(a.id); return fixer(dir) }) })
  assert.equal(used[0], 'deepseek', 'the resource the evidence favours now gets the work')
})

test('scenario M: two fresh wins cannot overturn hundreds of observations', async () => {
  const s = stack()
  const subject = subjectOf(AGENTS[0], { modelOf, priors: PRIORS })
  const many = Array.from({ length: 300 }, () => ({ subject, dimension: 'coding', score: 0.2, source: 'objective_deterministic', confidence: 0.9, n: 1, taskType: 'implementation' }))
  s.profiles.recordMany(many)
  const settled = s.profiles.profileOf(subject, { taskType: 'implementation' }).dimensions.coding.score
  s.profiles.recordMany([
    { subject, dimension: 'coding', score: 1, source: 'objective_deterministic', confidence: 1, n: 1, taskType: 'implementation' },
    { subject, dimension: 'coding', score: 1, source: 'objective_deterministic', confidence: 1, n: 1, taskType: 'implementation' },
  ])
  const moved = s.profiles.profileOf(subject, { taskType: 'implementation' }).dimensions.coding.score
  assert.ok(moved - settled < 0.02, `two samples moved a 300-sample score by ${moved - settled}, which is too much`)
  assert.ok(moved > settled, 'though they did move it, in the right direction')
})

test('scenario AC: once the routing domains have matured, a normal run makes no Jev routing call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kz-mature-'))
  const s = stack({ root })
  // Teach every routing domain from runs that all look the same, which is what "in distribution"
  // means: the same kind of task, the same pool, the same answer.
  const jev = fakeJev({ pick: (cs) => cs[0] })
  for (let i = 0; i < 40; i++) {
    const dir = repo()
    const r = await runRouted({ task: `make the test pass ${i}`, cwd: dir, config, signal, deps: deps(s, jev, async () => fixer(dir)) })
    for (const { domain, id } of s.lastSamples) {
      const sample = await s.store.get(id)
      const outcome = labelFromRun(domain, sample, r)
      if (outcome) await s.store.resolveOutcome(id, outcome)
    }
  }
  for (let i = 0; i < 4; i++) await s.domains.evaluateAll()
  const states = s.domains.states()
  const mature = Object.entries(states).filter(([, st]) => st.maturity === 'GUARDED_LOCAL' || st.maturity === 'LOCAL_ONLY').map(([id]) => id)
  assert.ok(mature.includes('task_classification'), `the task classifier matured (states: ${JSON.stringify(Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.maturity])))})`)
  assert.ok(mature.includes('resource_selection'), 'and so did resource selection')

  // Now a run of the same shape: the domains that matured decide for themselves.
  const before = jev.calls.length
  const dir = repo()
  const r = await runRouted({ task: 'make the test pass 99', cwd: dir, config, signal, deps: deps(s, jev, async () => fixer(dir)) })
  const asked = jev.calls.slice(before)
  const domainsReport = r.routing.decision.domains
  assert.equal(domainsReport.task_classification.authority, 'local', 'the task profile came from the local classifier')
  assert.equal(domainsReport.resource_selection.authority, 'local', `and so did the resource pick (${JSON.stringify(domainsReport.resource_selection)})`)
  assert.equal(asked.filter((c) => c.ask?.task).length, 0, 'no task-classification call was made')
  assert.equal(r.finalStatus, 'accepted')
  assert.match(formatReport(r), /local router decided|Jev and the local router decided/)
})

test('routing switched off leaves the old behaviour exactly as it was', async () => {
  const dir = repo()
  const jev = {
    route: async () => ({ primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { claude: 0.1, codex: 0.8, deepseek: 0.1 }, taskType: 'debugging', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2, needsSecondOpinion: 0.1, needsHumanReview: 0.1, needsTests: 0.9 }),
    assess: async () => verdict('accept'),
  }
  const used = []
  // No `decide` dep at all: the loop asks Jev directly, the way it did before any of this.
  const r = await runRouted({
    task: 'make the test pass', cwd: dir, config, signal,
    deps: { jev, execute: async (a) => { used.push(a.id); return fixer(dir) }, history: { recent: async () => [], records: async () => [], append: async () => {} } },
  })
  assert.equal(r.routing.mode, 'jev')
  assert.equal(r.routing.primaryAgent, 'codex')
  assert.deepEqual(used, ['codex'])
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(r.routing.decision, undefined, 'and no decision record is invented for it')
})

// ---------------------------------------------------------------- the whole outgoing payload

// Every word that names a real resource in this stack: ids, providers, models, vendors, families.
const IDENTITY = ['claude', 'codex', 'deepseek', 'anthropic', 'openai', 'gpt', 'opus', 'spawn']
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out) }
  return out
}
const leaks = (payload) => strings(payload).flatMap((s) => IDENTITY.filter((w) => s.toLowerCase().includes(w)).map((w) => `${w} in ${JSON.stringify(s).slice(0, 160)}`))

/**
 * The real jev.js with only the TypeSafe transport faked: every call's state AND questions are
 * captured exactly as they would leave the machine, and each question is answered by its type.
 * `pick[name](state, keys)` chooses for a choice question, from what the call itself carried.
 */
function transport(pick = {}) {
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async ({ state, questions }) => {
    sent.push({ state, questions })
    const answers = {}
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria)
        const wanted = typeof pick[name] === 'function' ? pick[name](state, keys) : pick[name]
        const c = keys.includes(wanted) ? wanted : keys[0]
        answers[name] = { type: 'choice', choice: c, confidence: 0.85, probabilities: Object.fromEntries(keys.map((k) => [k, k === c ? 0.85 : 0.15 / Math.max(1, keys.length - 1)])) }
      } else if (q.type === 'score') answers[name] = { type: 'score', score: 1, confidence: 0.8 }
      else answers[name] = { type: 'noul', noul: typeof pick[name] === 'function' ? pick[name](state) : ['addressed', 'complete', 'needsTests'].includes(name) ? 0.95 : 0.05, confidence: 0.9 }
    }
    return { model: 'jev-test', usage: {}, answers }
  }
  return { sent, restore: () => { TypeSafeClient.prototype.systemOne = real } }
}

// The agents as the shipped config used to describe them: capability claims in prose, which is
// exactly what must never reach a call that carries the anonymous table.
const DESCRIBED = AGENTS.map((a) => ({
  ...a,
  name: { claude: 'Claude Code', codex: 'Codex (GPT)', deepseek: 'DeepSeek agent' }[a.id],
  description: { claude: 'Claude Code: architecture, planning', codex: 'OpenAI Codex: implementation, debugging', deepseek: 'DeepSeek: code review, second opinions' }[a.id],
}))

// Evidence that names the agents in every channel the router builds: history, the track record
// (with a reason typed into the Why? box), availability and a price note.
const namedHistory = (dir) => {
  const rec = (agent, status) => ({ workspace: dir, routing: { taskType: 'implementation', primaryAgent: agent }, finalStatus: status, attempts: [{ agent, role: 'primary', durationMs: 1000 }] })
  const records = [rec('claude', 'accepted'), rec('codex', 'accepted'), rec('claude', 'accepted'), rec('deepseek', 'needs_human'), rec('claude', 'accepted')]
  return {
    recent: async () => records.map((r) => ({ task_type: r.routing.taskType, first_agent: r.routing.primaryAgent, attempts: r.attempts.length, outcome: r.finalStatus })),
    records: async () => records,
    feedback: async () => [{ verdict: 'dislike', provider: 'codex', tag: 'wrong agent', reason: 'codex broke it, Claude would not have', suggestedAgent: 'claude' }],
    append: async () => {},
  }
}
const namedConfig = { ...config, agents: DESCRIBED, pricing: { peak: { deepseek: { windowsUtc: [{ fromUtc: '00:00', toUtc: '23:59' }], daysUtc: [0, 1, 2, 3, 4, 5, 6], note: 'DeepSeek charges double at peak' } } } }
const namedQuota = { claude: { state: 'ok', kind: 'subscription', weeklyPercent: 20 }, codex: { state: 'near', kind: 'subscription', weeklyPercent: 30 }, deepseek: { state: 'ok', kind: 'api' } }

test('no Jev call of an adaptive run names a resource anywhere: route and review, state and questions', async (t) => {
  // Findings 4, 12, 17 and 11, and the gap (18) that hid them: the old test looked only at
  // `call.candidates`, while history, availability and the track record rode the same call keyed
  // by the real ids, and the review call chose its reviewer and fixer over prose descriptions.
  const { sent, restore } = transport()
  t.after(restore)
  const dir = repo()
  const s = stack()
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const r = await runRouted({
    task: 'make the failing test pass', cwd: dir, config: namedConfig, signal,
    deps: deps(s, jev, async () => fixer(dir), { history: namedHistory(dir), quota: namedQuota }),
  })
  assert.ok(r.routing.decision, 'the decision engine routed this run')
  const tableCalls = sent.filter((c) => Array.isArray(c.state.candidates))
  assert.ok(tableCalls.some((c) => c.questions.resource), 'the resource call carried the anonymous table')
  assert.ok(tableCalls.some((c) => c.questions.reviewAgent), 'and so did the review call')
  for (const call of sent) {
    const kind = Object.keys(call.questions).includes('verdict') ? 'review' : 'route'
    assert.deepEqual(leaks(call), [], `the ${kind} call named a resource`)
  }
  // The review assessed with Jev rather than falling back: the check shape no longer throws.
  assert.equal(r.assessments[0].mode, 'jev', JSON.stringify(r.assessments[0]))
})

test('the production resource call carries the evidence under the anonymous keys, and still names nothing', async (t) => {
  // The guard above proves nothing leaks, and an empty call passes it too: without the decision
  // engine's id-to-key mapping jev.js drops the track record, the availability and who ran each
  // earlier task, and the teacher picks with no history at all. This walks the real stack (router,
  // decision engine, jev.js) and checks the evidence arrived, keyed right, as well as anonymous.
  const { sent, restore } = transport()
  t.after(restore)
  const dir = repo()
  const s = stack()
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const r = await runRouted({
    task: 'make the failing test pass', cwd: dir, config: namedConfig, signal,
    deps: deps(s, jev, async () => fixer(dir), { history: namedHistory(dir), quota: namedQuota }),
  })
  const call = sent.find((c) => c.questions.resource)
  assert.ok(call, 'the decision engine asked the resource question')
  assert.deepEqual(leaks(call), [], 'the resource call named a resource')
  const { state } = call
  // Which key is which agent, from the run's own decision record: the test reads it, Jev never does.
  const keyOf = Object.fromEntries(r.routing.decision.candidates.map((c) => [c.id, c.key]))
  const offered = state.candidates.map((c) => c.key)
  assert.deepEqual(Object.keys(keyOf).sort(), ['claude', 'codex', 'deepseek'])

  const record = state.candidate_track_record
  assert.ok(record && Object.keys(record).length, 'the track record rides the resource call')
  assert.deepEqual(Object.keys(record).sort(), [...offered].sort(), 'keyed by exactly the table keys')
  // Each record sits under the key of the agent it describes, with its categorical facts intact.
  assert.equal(record[keyOf.claude].here_by_task_type.implementation.attempts, 3, 'three runs by claude in this workspace')
  assert.equal(record[keyOf.codex].availability, 'near limit')
  assert.equal(record[keyOf.codex].feedback.dislikes, 1)
  assert.equal(record[keyOf.codex].feedback.recent_reasons[0], `wrong agent: ${keyOf.codex} broke it, ${keyOf.claude} would not have`, 'a typed reason keeps its meaning under the keys')
  assert.equal(record[keyOf.deepseek].cost_tier, 'api')
  assert.equal(record[keyOf.claude].cost_tier, 'subscription')
  assert.match(record[keyOf.deepseek].price_now, /^peak rate until/)
  assert.deepEqual(state.candidate_availability, { [keyOf.claude]: 'ok', [keyOf.codex]: 'near limit', [keyOf.deepseek]: 'ok' })

  // Who ran each earlier task, as the key of the agent that ran it.
  assert.deepEqual(state.recent_outcomes.map((h) => h.first_resource), [keyOf.claude, keyOf.codex, keyOf.claude, keyOf.deepseek, keyOf.claude])
  assert.ok(state.recent_outcomes.every((h) => h.task_type === 'implementation' && !('first_agent' in h)))
  assert.equal(state.agent_track_record, undefined)
  assert.ok(call.questions.resource.instructions.focus.includes('candidate_track_record'), 'and the question tells the teacher to read it')
})

test('the retry pick is made over the anonymous machine data and lands on the agent that key stands for', async (t) => {
  // Jev sees no names, so it can only choose by properties: here the metered API candidate. The
  // chosen key goes back to an agent id in code, and the router acts on that id.
  let round = 0
  const { sent, restore } = transport({
    resource: (state) => state.candidates.find((c) => c.source === 'subscription')?.key,
    strategy: () => 'STANDARD_DIRECT',
    verdict: () => (round === 1 ? 'retry' : 'accept'),
    disposition: () => (round === 1 ? 'RETRY_DIFFERENT_RESOURCE' : 'PASS'),
    // The review policy decides from these, not from the verdict: round 1 is plainly unfinished.
    addressed: () => (round === 1 ? 0.1 : 0.95),
    complete: () => (round === 1 ? 0.1 : 0.95),
    retryAgent: (state) => state.candidates.find((c) => c.marginal_cost === 'metered')?.key,
  })
  t.after(restore)
  const dir = repo()
  const s = stack()
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const used = []
  const execute = async (a) => {
    used.push(a.id)
    round++
    if (round === 1) return { stopReason: 'completed', answerText: 'not yet' }
    return fixer(dir)
  }
  const r = await runRouted({ task: 'make the failing test pass', cwd: dir, config: namedConfig, signal, deps: deps(s, jev, execute) })
  assert.notEqual(used[0], 'deepseek', 'the work started on a subscription')
  assert.equal(r.assessments[0].retryAgent, 'deepseek', 'the key Jev chose came back as the agent id it stands for')
  assert.equal(used[1], 'deepseek', `the retry went to the resource Jev chose by its data (${used})`)
  assert.equal(r.finalStatus, 'accepted')
  for (const call of sent) assert.deepEqual(leaks(call), [])
})

// ---------------------------------------------------------------- a resource added across a restart

test('a provider added to config and picked up by a restart narrows the ranking domain', async () => {
  // The in-memory set was seeded on the first call of each process, so the ordinary workflow
  // (edit config, restart) put the new id into the seed and new_resource never fired.
  const { createResourceTracker } = await import('../index.js')
  const root = mkdtempSync(join(tmpdir(), 'kz-known-'))
  const changes = []
  const domains = { noteEnvironmentChange: (c) => changes.push(c) }
  const file = join(root, 'known-resources.json')
  const first = createResourceTracker({ file, store: null, domains })
  assert.deepEqual(await first.note([{ id: 'claude' }, { id: 'codex' }]), [], 'a fresh install has learned nothing a new resource could invalidate')
  // Restart: a new process, a new tracker, and one more agent in config.
  const second = createResourceTracker({ file, store: null, domains })
  assert.deepEqual(await second.note([{ id: 'claude' }, { id: 'codex' }, { id: 'deepseek' }]), ['deepseek'])
  assert.deepEqual(changes, [{ kind: 'new_resource', detail: 'deepseek' }])
  assert.deepEqual(await second.note([{ id: 'claude' }, { id: 'codex' }, { id: 'deepseek' }]), [], 'and only once')

  // An install from before the file existed rebuilds the set from what its samples show was routed.
  const store = { list: async ({ domain }) => (domain === 'resource_selection' ? [{ input: { candidates: [{ key: 'RESOURCE_A', id: 'claude' }, { key: 'RESOURCE_B', id: 'codex' }] } }] : []) }
  const upgraded = createResourceTracker({ file: join(root, 'none', 'known-resources.json'), store, domains })
  assert.deepEqual(await upgraded.note([{ id: 'claude' }, { id: 'codex' }, { id: 'qwen-local' }]), ['qwen-local'])
})

test('the upgrade seed counts every agent a decision record saw, even one that never ran', async () => {
  // deepseek was always ruled out inside the engine (too small a context window, under the floor):
  // it never ran and was never a ranked candidate, but the decision record names it. Announcing
  // it as new on the first start after the upgrade would narrow a mature ranking domain for nothing.
  const { createResourceTracker } = await import('../index.js')
  const root = mkdtempSync(join(tmpdir(), 'kz-known-'))
  const changes = []
  const domains = { noteEnvironmentChange: (c) => changes.push(c) }
  const store = { list: async ({ domain }) => (domain === 'resource_selection' ? [{ input: { candidates: [{ key: 'RESOURCE_A', id: 'claude' }] } }] : []) }
  const records = async () => [{ routing: { primaryAgent: 'claude', decision: { candidates: [{ id: 'claude' }], excluded: [{ id: 'deepseek', reason: 'context window 8192 tokens is under the 17600 this request needs' }] } }, attempts: [{ agent: 'claude' }] }]
  const upgraded = createResourceTracker({ file: join(root, 'known-resources.json'), store, records, domains })
  assert.deepEqual(await upgraded.note([{ id: 'claude' }, { id: 'deepseek' }]), [], 'deepseek was already seen')
  assert.deepEqual(changes, [])
})

// ---------------------------------------------------------------- one answer governs the second opinion

test('the second-opinion judgment is carried out exactly as the run labels it', async () => {
  // The domain decided 'yes' at 0.5, jev-review acted only at 0.6 and only on changed code, and
  // the sample was labelled either way: an accepted run then confirmed a 'yes' that never happened.
  const nouls = { mode: 'jev', verdict: 'accept', addressed: 0.95, complete: 0.95, unrelatedChanges: 0, regressionRisk: 0, needsPerson: 0 }
  const review = createReview({ assess: async () => nouls }, config.thresholds)
  const input = (routing, over = {}) => ({
    task: 't', routing: { risk: 0.1, ...routing }, attempts: [{ agent: 'codex', stopReason: 'completed' }], checks: [], cmp: { regressed: [], failing: [] }, diff: {},
    agents: [], blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'claude', ...over,
  })
  const judged = (label, p) => ({ needsSecondOpinion: p, decision: { domains: { second_opinion: { label } } } })
  assert.equal((await review(input(judged('yes', 0.55)), signal)).action, 'second_review', 'a yes under the old 0.6 bar')
  assert.equal((await review(input(judged('yes', 0.9), { touchedCode: false }), signal)).action, 'second_review', 'a yes on a run that changed no file')
  assert.equal((await review(input(judged('no', 0.45)), signal)).action, 'accept')
  assert.equal((await review(input(judged('yes', 0.9), { reviewed: true }), signal)).action, 'accept', 'already reviewed')
  // Without a domain answer nothing is labelled, and the configured bar still governs.
  assert.equal((await review(input({ needsSecondOpinion: 0.55 }), signal)).action, 'accept')
  assert.equal((await review(input({ needsSecondOpinion: 0.9 }), signal)).action, 'second_review')
  assert.equal((await review(input({ needsSecondOpinion: 0.9 }, { touchedCode: false }), signal)).action, 'accept')
})

test('through the real engine, a second-opinion yes at 0.55 gets its review and is the sample the run labels', async () => {
  const dir = repo()
  const s = stack()
  const base = fakeJev({ pick: (cs) => cs[0], assess: () => verdict('accept') })
  const jev = { ...base, route: async (args) => { const out = await base.route(args); if (args.candidates && args.ask?.judgments) out.secondOpinion = 0.55; return out } }
  const execute = async (a, prompt) => (/Independently review/.test(prompt) ? { stopReason: 'completed', answerText: 'looks right' } : fixer(dir))
  const r = await runRouted({ task: 'make the test pass', cwd: dir, config, signal, deps: deps(s, jev, execute) })
  assert.equal(r.routing.decision.domains.second_opinion.label, 'yes')
  assert.ok(s.lastSamples.some((x) => x.domain === 'second_opinion'), 'the yes is a labelled sample')
  assert.deepEqual(r.attempts.map((x) => x.role), ['primary', 'review'], 'so the run carries it out')
  assert.match(r.assessments[0].why, /routing asked for a second opinion \(0\.55\)/)
  assert.equal(r.finalStatus, 'accepted')
})

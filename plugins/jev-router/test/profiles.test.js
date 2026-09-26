// Capability profiles: priors load and validate, evidence aggregates by precision, hundreds of
// observations resist a couple of new ones, a new model version starts cold, a regression shows
// up as a declining trend, and a run record turns into evidence rows with none of its text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIMENSIONS, TASK_DIMENSIONS, resolvePolicy } from '../routing-policy.js'
import {
  EVIDENCE_SOURCES, PRIOR_SOURCES, UNPINNED_WINDOW_DAYS, agreementOf, createCapabilityRegistry, evidenceFromFeedback, evidenceFromRun, loadPriors, priorFor, subjectKey, subjectOf, validatePriors, versionPinned,
} from '../profiles.js'
// A namespace as well, for what the capability benchmark added (benchmarkEvidence), so this file
// loads where the plugin lacks it and each of those tests fails by its own assertion.
import * as profilesModule from '../profiles.js'

const PRIORS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'capability-priors.json')
const DAY = 86_400_000
const T0 = '2026-09-01T00:00:00.000Z'
const NOW = Date.parse(T0)
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString()
const policy = resolvePolicy()
const priors = loadPriors(PRIORS_FILE)

const tmp = () => join(mkdtempSync(join(tmpdir(), 'kz-profiles-')), 'capability-evidence.jsonl')
const registry = (over = {}) => createCapabilityRegistry({ file: tmp(), priors, policy, now: () => NOW, ...over })
const subject = (provider, model, family = null) => ({ provider, family, model, version: model })
const row = (s, dimension, score, over = {}) => ({ ts: T0, subject: s, dimension, score, source: 'objective_deterministic', confidence: 1, n: 1, ...over })
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
// A priors object of our own for the cases that need a specific family shape.
const testPriors = (families, models = {}) => validatePriors({ families, models })
const cap = (score, confidence = 0.6) => ({ score, confidence, source: 'owner_prior' })

test('the shipped priors file loads and every dimension in it is one the policy knows', () => {
  assert.equal(priors.version, 1)
  assert.match(priors.about, /initial observations/)
  assert.match(priors.about, /not a routing rule|not routing rules|evidence, not a routing rule/)
  assert.match(priors.about, /evidence/)
  for (const f of Object.values(priors.families)) for (const d of Object.keys(f.capabilities)) assert.ok(DIMENSIONS.includes(d), `${d} is a policy dimension`)
  for (const f of Object.values(priors.families)) for (const d of ['vision', 'database', 'frontend', 'backend', 'testing']) assert.equal(f.capabilities[d], undefined, `${d} was not observed by the owner`)
  assert.deepEqual([...EVIDENCE_SOURCES], Object.keys(policy.evidence.reliability), 'the evidence sources are exactly the ones the policy weights')
  assert.deepEqual([...PRIOR_SOURCES], ['owner_prior', 'family_prior', 'benchmark_prior'])
})

test('scenario K: family A leads on architecture and explanation, family B on coding and security, and the numbers name nobody', () => {
  const reg = registry()
  const a = subjectOf({ id: 'codex', provider: 'codex' }, { modelOf: () => 'gpt-5', priors })
  const b = subjectOf({ id: 'claude', provider: 'claude-code' }, { modelOf: () => 'claude-sonnet-4-5', priors })
  assert.equal(a.family, 'openai-gpt')
  assert.equal(b.family, 'anthropic-claude')
  const dims = ['architecture', 'explanation', 'coding', 'security_review']
  const ea = reg.effective(a, dims)
  const eb = reg.effective(b, dims)
  for (const d of dims) {
    assert.equal(typeof ea[d].score, 'number')
    assert.equal(ea[d].source, 'owner_prior', 'with no evidence the number rests on the owner prior')
    assert.equal(eb[d].source, 'owner_prior')
    assert.ok(ea[d].confidence > 0 && ea[d].confidence < 1)
    assert.equal(ea[d].samples, 0)
  }
  assert.ok(ea.architecture.score > eb.architecture.score, 'A is the better architect')
  assert.ok(ea.explanation.score > eb.explanation.score, 'A explains better')
  assert.ok(eb.coding.score > ea.coding.score, 'B codes better')
  assert.ok(eb.security_review.score > ea.security_review.score, 'B reviews security better')
  assert.ok(close(eb.coding.score, priors.families['anthropic-claude'].capabilities.coding.score), 'a prior alone is returned as written')
  const text = JSON.stringify([ea, eb])
  assert.doesNotMatch(text, /claude|codex|anthropic|openai|gpt/i, 'no agent id or provider name in the numbers')
})

test('validatePriors rejects an unknown dimension, an out-of-range score and a broken pattern', () => {
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: { vibes: cap(0.5) } } }), /unknown dimension "vibes"/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: { coding: cap(1.2) } } }), /coding: score/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: { coding: cap(-0.1) } } }), /coding: score/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: { coding: { score: 0.5, confidence: 2 } } } }), /confidence/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'], modelPattern: '(' }, capabilities: {} } }), /modelPattern/)
  assert.throws(() => testPriors({ x: { match: {}, capabilities: {} } }), /providers or modelPattern/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: { coding: { score: 0.5, confidence: 0.5, source: 'rumour' } } } }), /source/)
  assert.throws(() => testPriors({ x: { match: { providers: ['x'] }, capabilities: {} } }, { m1: { family: 'nope', capabilities: {} } }), /unknown family/)
  assert.throws(() => validatePriors({}), /families/)
  assert.throws(() => loadPriors(join(tmpdir(), 'kz-no-such-priors.json')), /cannot read/)
})

test('subjectOf: the provider first, then the model pattern; no match leaves the family null', () => {
  assert.deepEqual(subjectOf({ id: 'claude', provider: 'claude-code' }, { modelOf: () => 'claude-opus-4-1', priors }), { provider: 'claude-code', family: 'anthropic-claude', model: 'claude-opus-4-1', version: 'claude-opus-4-1' })
  assert.deepEqual(subjectOf({ id: 'deep', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-chat' } }, { priors }), { provider: 'deepseek', family: 'deepseek', model: 'deepseek-chat', version: 'deepseek-chat' })
  assert.equal(subjectOf({ id: 'byok', provider: 'spawn', llm: { provider: 'openrouter', model: 'gpt-5' } }, { priors }).family, 'openai-gpt', 'a BYOK provider is recognised by the model id')
  assert.equal(subjectOf({ id: 'ollama', provider: 'spawn', llm: { provider: 'local', model: 'deepseek-r1:8b' } }, { priors }).family, 'local-small', 'where it runs comes before what it is called')
  assert.deepEqual(subjectOf({ id: 'claude', provider: 'claude-code' }, { modelOf: () => undefined, priors }), { provider: 'claude-code', family: 'anthropic-claude', model: null, version: null })
  assert.equal(subjectOf({ id: 'x', provider: 'spawn', llm: { provider: 'mystery', model: 'thing-1' } }, { priors }).family, 'local-small', 'the shipped local-small pattern is a catch-all for any model id')
  assert.deepEqual(subjectOf({ id: 'x', provider: 'spawn', llm: { provider: 'mystery' } }, { priors }), { provider: 'mystery', family: null, model: null, version: null }, 'no provider match and no model id: no family')
  const strict = testPriors({ fam: { match: { providers: ['acme'], modelPattern: '^acme' }, capabilities: {} } })
  assert.deepEqual(subjectOf({ id: 'x', provider: 'spawn', llm: { provider: 'mystery', model: 'thing-1' } }, { priors: strict }), { provider: 'mystery', family: null, model: 'thing-1', version: 'thing-1' })
  assert.equal(subjectKey(subject('p', 'm')), 'p|m|m')
  assert.equal(subjectKey(subject('p', null)), 'p||')
})

test('priorFor: an exact model entry wins, a recognised model gets the family as written, a provider-only match gets a weak family prior', () => {
  const p = testPriors(
    { fam: { match: { providers: ['acme'], modelPattern: '^acme-v1' }, capabilities: { coding: cap(0.9), explanation: cap(0.7, 0.5) } } },
    { 'acme-v1-turbo': { family: 'fam', capabilities: { coding: cap(0.95, 0.8) } } },
  )
  assert.deepEqual(priorFor(subject('acme', 'acme-v1-turbo', 'fam'), p, policy), { coding: { score: 0.95, confidence: 0.8, source: 'owner_prior' } })
  assert.deepEqual(priorFor(subject('acme', 'acme-v1', 'fam'), p, policy), { coding: { score: 0.9, confidence: 0.6, source: 'owner_prior' }, explanation: { score: 0.7, confidence: 0.5, source: 'owner_prior' } })
  const weak = priorFor(subject('acme', 'acme-v2', 'fam'), p, policy)
  assert.equal(weak.coding.source, 'family_prior')
  assert.ok(close(weak.coding.confidence, 0.6 * 0.75))
  assert.ok(close(weak.explanation.confidence, 0.5 * 0.75))
  assert.equal(weak.coding.score, 0.9, 'the score is inherited, only the confidence is discounted')
  assert.deepEqual(priorFor(subject('nobody', 'x'), p, policy), {})
  assert.deepEqual(priorFor(subject('acme', null, 'fam'), null, policy), {})
})

test('scenario G: a weaker prior plus strong evidence overtakes a stronger prior with no evidence', () => {
  const p = testPriors({
    strong: { match: { providers: ['strong'], modelPattern: '^s' }, capabilities: { coding: cap(0.9, 0.6) } },
    weak: { match: { providers: ['weak'], modelPattern: '^w' }, capabilities: { coding: cap(0.6, 0.5) } },
  })
  const reg = registry({ priors: p })
  const s = subject('strong', 's1', 'strong')
  const w = subject('weak', 'w1', 'weak')
  assert.ok(reg.effective(s, ['coding']).coding.score > reg.effective(w, ['coding']).coding.score, 'before evidence the stronger prior leads')
  for (let i = 0; i < 30; i++) reg.record(row(w, 'coding', 1, { runId: `r${i}` }))
  const es = reg.effective(s, ['coding']).coding
  const ew = reg.effective(w, ['coding']).coding
  assert.ok(ew.score > es.score, `evidence overtakes: ${ew.score} > ${es.score}`)
  assert.ok(ew.confidence > es.confidence, 'and is more confident than any prior')
  assert.equal(ew.source, 'objective_deterministic', 'the number now rests on the evidence')
  // The formula, by hand: k0 = 0.5 * priorStrength, thirty rows of weight 1 at score 1.
  const k0 = 0.5 * policy.evidence.priorStrength
  assert.ok(close(ew.score, (k0 * 0.6 + 30) / (k0 + 30)))
  assert.ok(close(ew.confidence, 1 - Math.exp(-(k0 + 30) / policy.evidence.confidenceScale)))
})

test('scenario L: B repeatedly outperforms A on verified evidence and its effective coding rises above A', () => {
  const reg = registry()
  const a = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  const b = subject('codex', 'gpt-5', 'openai-gpt')
  assert.ok(reg.effective(a, ['coding']).coding.score > reg.effective(b, ['coding']).coding.score, 'the priors put A ahead')
  for (let i = 0; i < 25; i++) {
    reg.record(row(a, 'coding', i % 2, { taskType: 'implementation', runId: `a${i}` }))
    reg.record(row(b, 'coding', 1, { taskType: 'implementation', runId: `b${i}` }))
  }
  const ea = reg.effective(a, ['coding']).coding
  const eb = reg.effective(b, ['coding']).coding
  assert.ok(eb.score > ea.score, `B leads after the evidence: ${eb.score} > ${ea.score}`)
  assert.ok(eb.score > priors.families['openai-gpt'].capabilities.coding.score, 'B rose above its own prior')
  assert.ok(ea.score < priors.families['anthropic-claude'].capabilities.coding.score, 'A fell below its prior')
})

test('scenario M: two successes at confidence 1 cannot move three hundred observations by more than the formula allows', () => {
  const reg = registry()
  const s = subject('mystery', 'm1') // no family: the bound is about the evidence alone
  // Two thirds successes, interleaved so the newest twenty look like the rest and no trend fires.
  for (let i = 0; i < 300; i++) reg.record(row(s, 'coding', i % 3 === 2 ? 0 : 1, { runId: `r${i}` }))
  const before = reg.effective(s, ['coding']).coding
  const weightBefore = reg.explain(s, 'coding').evidenceWeight
  assert.equal(before.samples, 300)
  assert.ok(close(weightBefore, 300), 'fresh objective rows at confidence 1 weigh exactly 1 each')
  reg.record(row(s, 'coding', 1, { runId: 'new1' }))
  reg.record(row(s, 'coding', 1, { runId: 'new2' }))
  const after = reg.effective(s, ['coding']).coding
  // score' = (W * s + 2) / (W + 2), so the move is 2 * (1 - s) / (W + 2): the exact bound.
  const bound = 2 * (1 - before.score) / (weightBefore + 2)
  assert.ok(after.score > before.score, 'two successes still count')
  assert.ok(after.score - before.score <= bound + 1e-12, `moved ${after.score - before.score}, bound ${bound}`)
  assert.ok(bound < 0.003, 'a small amount: under three thousandths')
  assert.equal(reg.profileOf(s).dimensions.coding.execution.trend, 'stable')
  assert.equal(after.samples, 302)
})

test('scenario N: a new model version of a known family is cold, with a weak family prior and none of the old version\'s evidence', () => {
  const p = testPriors({ acme: { match: { providers: ['acme'], modelPattern: '^acme-v1' }, capabilities: { coding: cap(0.9, 0.6), reliability: cap(0.8, 0.6) } } })
  const reg = registry({ priors: p })
  const modelOf = (a) => ({ old: 'acme-v1', fresh: 'acme-v2' })[a.id]
  const known = subjectOf({ id: 'old', provider: 'acme' }, { modelOf, priors: p })
  const fresh = subjectOf({ id: 'fresh', provider: 'acme' }, { modelOf, priors: p })
  assert.equal(known.family, 'acme')
  assert.equal(fresh.family, 'acme', 'the provider places the new version in the family')
  assert.notEqual(subjectKey(known), subjectKey(fresh))
  for (let i = 0; i < 12; i++) reg.record(row(known, 'coding', 1, { runId: `r${i}` }))
  assert.equal(reg.cold(known), false)
  assert.equal(reg.cold(fresh), true)
  const pf = reg.profileOf(fresh)
  assert.equal(pf.cold, true)
  assert.equal(pf.samples, 0)
  assert.equal(pf.dimensions.coding.execution, null, 'no execution evidence inherited')
  assert.deepEqual(pf.dimensions.coding.prior, { score: 0.9, confidence: 0.45, source: 'family_prior' })
  assert.deepEqual(pf.dimensions.coding.sources, ['family_prior'])
  const ef = reg.effective(fresh, ['coding']).coding
  const ek = reg.effective(known, ['coding']).coding
  assert.equal(ef.source, 'family_prior')
  assert.ok(close(ef.confidence, 1 - Math.exp(-(0.45 * policy.evidence.familyPriorStrength) / policy.evidence.confidenceScale)), 'a family prior is worth familyPriorStrength pseudo-samples')
  assert.ok(ef.confidence < ek.confidence)
  assert.equal(reg.evidenceCount(fresh), 0)
  assert.equal(reg.evidenceCount(known), 12)
  // With the shipped file, a known provider whose model could not be read gets the same weak prior.
  const unread = subjectOf({ id: 'claude', provider: 'claude-code' }, { modelOf: () => undefined, priors })
  const shipped = registry().profileOf(unread).dimensions.coding.prior
  assert.equal(shipped.source, 'family_prior')
  assert.ok(close(shipped.confidence, 0.45))
})

test('scenario O: a strong resource that starts failing scores lower and its trend is declining', () => {
  const reg = registry()
  const s = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  for (let i = 0; i < 40; i++) reg.record(row(s, 'coding', 1, { ts: daysAgo(30), runId: `ok${i}` }))
  const healthy = reg.effective(s, ['coding']).coding.score
  assert.ok(healthy > 0.9)
  assert.equal(reg.profileOf(s).dimensions.coding.execution.trend, 'stable')
  for (let i = 0; i < 8; i++) reg.record(row(s, 'coding', 0, { ts: daysAgo(0), runId: `bad${i}` }))
  const ex = reg.explain(s, 'coding')
  assert.equal(ex.execution.trend, 'declining')
  assert.ok(ex.execution.recentScore < ex.execution.score - policy.evidence.regressionMargin, 'the recent window fell under lifetime by more than the margin')
  assert.ok(ex.score < healthy - 0.2, `the effective score dropped: ${ex.score} from ${healthy}`)
  // The blend, by hand: the unblended mean pulled regressionWeight of the way to the recent score.
  const unblended = (ex.priorStrength * ex.prior.score + ex.items.reduce((t, i) => t + i.weight * i.score, 0)) / ex.precision
  assert.ok(close(ex.score, unblended * (1 - policy.evidence.regressionWeight) + ex.execution.recentScore * policy.evidence.regressionWeight))
  assert.equal(reg.profileOf(s).dimensions.coding.execution.trend, 'declining')
  // The mirror: a weak history followed by fresh successes reads as improving. The history has
  // to be longer than the recent window, or recent and lifetime are the same rows.
  const t = subject('codex', 'gpt-5', 'openai-gpt')
  for (let i = 0; i < 30; i++) reg.record(row(t, 'coding', 0, { ts: daysAgo(20), runId: `w${i}` }))
  for (let i = 0; i < 10; i++) reg.record(row(t, 'coding', 1, { ts: daysAgo(0), runId: `g${i}` }))
  const up = reg.explain(t, 'coding').execution
  assert.equal(up.recentN, policy.evidence.recentN)
  assert.equal(up.trend, 'improving')
})

test('evidence decay: an old benchmark weighs less than a new one, and slower than execution evidence', () => {
  const reg = registry()
  // Dated snapshot ids: decay is about a version that cannot change under its name. An unpinned
  // name drops rows older than UNPINNED_WINDOW_DAYS outright, which has its own test below.
  const s = subject('mystery', 'm1-20250101')
  reg.record(row(s, 'coding', 0, { ts: daysAgo(360), source: 'benchmark', benchmark: { id: 'bench', version: '1' } }))
  reg.record(row(s, 'coding', 1, { ts: daysAgo(0), source: 'benchmark', benchmark: { id: 'bench', version: '2' } }))
  const ex = reg.explain(s, 'coding')
  const [old, fresh] = ex.items
  assert.ok(close(old.decay, 0.5 ** (360 / policy.evidence.benchmarkHalfLifeDays)))
  assert.equal(fresh.decay, 1)
  assert.ok(old.weight < fresh.weight)
  assert.ok(ex.score > 0.5, 'the new benchmark wins')
  assert.ok(close(ex.score, fresh.weight / (fresh.weight + old.weight)))
  // The benchmark summary is the plain pass rate over its rows, one per task, and the weight they carry now.
  assert.deepEqual(ex.benchmark, { score: 0.5, tasks: 2, passed: 1, weight: old.weight + fresh.weight })
  assert.equal(ex.execution, null)
  assert.equal(reg.cold(s), true, 'a benchmark alone does not warm a subject')
  // Execution evidence of the same age has decayed further: a shorter half-life.
  const t = subject('mystery', 'm2-20250101')
  reg.record(row(t, 'coding', 1, { ts: daysAgo(360) }))
  assert.ok(reg.explain(t, 'coding').items[0].decay < old.decay)
  const gone = subject('mystery', 'm3-20160101')
  reg.record(row(gone, 'coding', 1, { ts: daysAgo(3650) }))
  assert.ok(reg.effective(gone, ['coding']).coding.confidence < 0.01, 'ten-year-old evidence is nearly worthless')
})

test('similarity: evidence from the same task type weighs more than from a related one, and that more than from any other', () => {
  const reg = registry()
  const s = subject('mystery', 'm1')
  reg.record(row(s, 'coding', 1, { taskType: 'implementation' }))
  reg.record(row(s, 'coding', 0, { taskType: 'security' }))
  const sim = policy.evidence.similarity
  const asked = (taskType) => reg.explain(s, 'coding', { taskType })
  const impl = asked('implementation')
  assert.equal(impl.items[0].similarity, sim.same)
  assert.equal(impl.items[1].similarity, sim.other)
  assert.ok(impl.score > 0.5, 'asked about implementation, the implementation success dominates')
  const sec = asked('security')
  assert.ok(sec.score < 0.5, 'asked about security, the security failure dominates')
  const refactor = asked('refactor')
  assert.equal(refactor.items[0].similarity, sim.related, 'implementation is related to refactor')
  assert.equal(refactor.items[1].similarity, sim.other)
  assert.ok(refactor.score > 0.5 && refactor.score < impl.score)
  const none = asked(undefined)
  assert.equal(none.items[0].similarity, 1)
  assert.ok(close(none.score, 0.5), 'with no task type asked, every row is fully relevant')
  assert.equal(reg.effective(s, ['coding'], { taskType: 'implementation' }).coding.score, impl.score)
  const general = subject('mystery', 'm2')
  reg.record(row(general, 'coding', 1, { source: 'benchmark', benchmark: { id: 'b' } }))
  assert.equal(reg.explain(general, 'coding', { taskType: 'security' }).items[0].similarity, 1, 'a row with no task type is general evidence')
})

test('unknown stays unknown: no prior and no evidence is unknownScore at zero confidence, never a number above it', () => {
  const reg = registry()
  const s = subject('mystery', 'm1')
  const e = reg.effective(s, ['coding', 'vision'])
  assert.deepEqual(e.coding, { score: policy.evidence.unknownScore, confidence: 0, samples: 0, source: 'unknown' })
  assert.deepEqual(e.vision, { score: policy.evidence.unknownScore, confidence: 0, samples: 0, source: 'unknown' })
  // A known family is unknown on a dimension the owner never observed.
  const known = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  assert.deepEqual(reg.effective(known, ['vision']).vision, { score: policy.evidence.unknownScore, confidence: 0, samples: 0, source: 'unknown' })
  const p = reg.profileOf(known)
  assert.equal(p.dimensions.vision.prior, null)
  assert.deepEqual(p.dimensions.vision.sources, [])
  assert.ok(Object.keys(p.dimensions).length >= DIMENSIONS.length, 'the profile lists every dimension, unknown ones included')
  assert.equal(p.cold, true)
  assert.equal(p.lastUpdate, null)
  assert.deepEqual(reg.subjects(), [])
})

const agents = [
  { id: 'claude', provider: 'claude-code' },
  { id: 'codex', provider: 'codex' },
  { id: 'deep', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-chat' } },
]
const modelOf = (a) => ({ claude: 'claude-sonnet-4-5', codex: 'gpt-5' })[a.id]
const MARKER = 'MARKER_TASK_TEXT'
// What router.js stamps on an attempt: the model the agent was set to when it ran, its pinned
// llm.model first, else the CLI's own setting (index.js modelOf), and nothing when neither names one.
const modelAtRun = (id) => agents.find((a) => a.id === id)?.llm?.model ?? modelOf({ id })
const attempt = (agent, role, over = {}) => ({ agent, role, stopReason: 'completed', durationMs: 1000, checks: [{ name: 'test', passed: true }], answerExcerpt: `${MARKER} answer`, diagnostic: `${MARKER} diag`, ...(modelAtRun(agent) ? { model: modelAtRun(agent) } : {}), ...over })
const run = (over = {}) => ({ ts: T0, runId: 'run-1', sessionId: 'sess-1', workspace: '/w', task: `${MARKER} rewrite the login`, routing: { taskType: 'implementation', primaryAgent: 'claude' }, attempts: [attempt('claude', 'primary')], assessments: [{ mode: 'jev', action: 'accept', why: `${MARKER} looks fine` }], finalStatus: 'accepted', ...over })
const pick = (rows, source, dimension) => rows.filter((r) => r.source === source && (!dimension || r.dimension === dimension))
const forAgent = (rows, provider) => rows.filter((r) => r.subject.provider === provider)

test('evidenceFromRun: one accepted attempt credits every dimension the task exercises, and no text leaves the record', () => {
  const rows = evidenceFromRun(run(), { modelOf, agents, priors })
  const dims = TASK_DIMENSIONS.implementation
  assert.deepEqual(dims, ['coding', 'first_pass_quality', 'instruction_following'])
  for (const r of rows) {
    assert.deepEqual(r.subject, { provider: 'claude-code', family: 'anthropic-claude', model: 'claude-sonnet-4-5', version: 'claude-sonnet-4-5' })
    assert.equal(r.ts, T0)
    assert.equal(r.runId, 'run-1')
    assert.equal(r.taskType, 'implementation')
    assert.equal(r.n, 1)
  }
  const objective = pick(rows, 'objective_deterministic')
  assert.deepEqual(objective.map((r) => [r.dimension, r.score, r.confidence]).sort(), [['coding', 1, 0.9], ['first_pass_quality', 1, 0.9], ['instruction_following', 1, 0.9], ['reliability', 1, 0.9]])
  assert.equal(pick(rows, 'objective_deterministic', 'first_pass_quality').length, 1, 'first pass is scored once, by its own rule')
  const review = pick(rows, 'independent_review')
  assert.deepEqual(review.map((r) => [r.dimension, r.score, r.confidence]).sort(), [['coding', 1, 0.7], ['first_pass_quality', 1, 0.7], ['instruction_following', 1, 0.7]])
  assert.equal(pick(rows, 'human_outcome').length, 0)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(MARKER), 'no task text, answer text, diagnostic or review wording')
  assert.doesNotMatch(JSON.stringify(rows), /rewrite|login|answer|diag/)
})

test('evidenceFromRun: a retry by another agent marks the first attempt down and the rescuer up; limit hits are skipped', () => {
  const r = run({
    attempts: [attempt('claude', 'primary'), attempt('deep', 'retry', { limitHit: true, stopReason: 'error' }), attempt('codex', 'retry')],
    assessments: [{ mode: 'jev', action: 'retry' }, { mode: 'jev', action: 'accept' }],
    finalStatus: 'accepted_pending_human_review',
  })
  const rows = evidenceFromRun(r, { modelOf, agents, priors })
  assert.equal(forAgent(rows, 'deepseek').length, 0, 'the limit-hit attempt is not evidence of anything')
  const claude = forAgent(rows, 'claude-code')
  assert.deepEqual(pick(claude, 'objective_deterministic').map((x) => [x.dimension, x.score]).sort(), [['coding', 0], ['first_pass_quality', 0], ['instruction_following', 0], ['reliability', 1]])
  assert.ok(pick(claude, 'independent_review').every((x) => x.score === 0), 'Jev sent it back')
  const codex = forAgent(rows, 'codex')
  assert.deepEqual(pick(codex, 'objective_deterministic').map((x) => [x.dimension, x.score]).sort(), [['coding', 1], ['instruction_following', 1], ['reliability', 1]])
  assert.equal(pick(codex, 'objective_deterministic', 'first_pass_quality').length, 0, 'first pass is about the first attempt only')
  assert.ok(pick(codex, 'independent_review').every((x) => x.score === 1))
  assert.equal(codex[0].subject.model, 'gpt-5')
})

test('evidenceFromRun: failed checks, an incomplete stop, a human hand-off and a review by another agent', () => {
  const failed = evidenceFromRun(run({
    attempts: [attempt('claude', 'primary', { stopReason: 'error', checks: [{ name: 'test', passed: false }] })],
    assessments: [{ mode: 'jev', action: 'human' }],
    finalStatus: 'needs_human',
  }), { modelOf, agents, priors })
  assert.deepEqual(pick(failed, 'objective_deterministic').map((x) => [x.dimension, x.score]).sort(), [['coding', 0], ['first_pass_quality', 0], ['instruction_following', 0], ['reliability', 0]])
  assert.ok(pick(failed, 'independent_review').every((x) => x.score === 0))
  // A completed review by another agent is the last word on the attempt.
  const reviewed = evidenceFromRun(run({
    attempts: [attempt('claude', 'primary'), attempt('codex', 'review')],
    assessments: [{ mode: 'jev', action: 'second_review' }, { mode: 'jev', action: 'accept' }],
  }), { modelOf, agents, priors })
  assert.equal(forAgent(reviewed, 'codex').length, 0, 'a reviewer is not scored as a worker')
  assert.ok(pick(forAgent(reviewed, 'claude-code'), 'independent_review').every((x) => x.score === 1))
  // A reviewer that crashed says nothing; a deterministic fallback assessment is not an independent review.
  const noVerdict = evidenceFromRun(run({
    attempts: [attempt('claude', 'primary'), attempt('codex', 'review', { stopReason: 'error' })],
    assessments: [{ mode: 'fallback', action: 'second_review' }, { mode: 'skipped', action: 'human' }],
    finalStatus: 'needs_human',
  }), { modelOf, agents, priors })
  assert.equal(pick(noVerdict, 'independent_review').length, 0)
  assert.equal(pick(noVerdict, 'objective_deterministic', 'coding').length, 0, 'not accepted, not retried, checks fine: no objective verdict either')
  assert.deepEqual(pick(noVerdict, 'objective_deterministic').map((x) => [x.dimension, x.score]), [['first_pass_quality', 0], ['reliability', 1]])
})

test('evidenceFromRun: paused, stopped, unknown agents and runs without work give nothing', () => {
  assert.deepEqual(evidenceFromRun(run({ finalStatus: 'paused_limit' }), { modelOf, agents, priors }), [])
  assert.deepEqual(evidenceFromRun(run({ finalStatus: 'stopped' }), { modelOf, agents, priors }), [])
  assert.deepEqual(evidenceFromRun(run({ attempts: [attempt('claude', 'primary', { limitHit: true })] }), { modelOf, agents, priors }), [])
  assert.deepEqual(evidenceFromRun(run({ attempts: [attempt('tool:lint', 'tool')] }), { modelOf, agents, priors }), [])
  assert.deepEqual(evidenceFromRun(run({ attempts: [attempt('gone', 'primary')] }), { modelOf, agents, priors }), [], 'an agent no longer configured has no subject to credit')
  assert.deepEqual(evidenceFromRun(null, { modelOf, agents, priors }), [])
  assert.deepEqual(evidenceFromRun({}, { modelOf, agents, priors }), [])
})

test('evidenceFromRun: the attempt\'s recorded model names the version, and a task type it does not know falls back to other', () => {
  const rows = evidenceFromRun(run({ attempts: [attempt('claude', 'primary', { model: 'claude-opus-4-1' })], routing: { taskType: 'made_up' } }), { modelOf, agents, priors })
  assert.ok(rows.length)
  assert.ok(rows.every((r) => r.subject.model === 'claude-opus-4-1' && r.subject.version === 'claude-opus-4-1'))
  assert.deepEqual(pick(rows, 'objective_deterministic').map((r) => r.dimension).sort(), ['first_pass_quality', 'general_reasoning', 'reliability'])
  const answered = evidenceFromRun(run({ attempts: [attempt('claude', 'primary', { checks: undefined })], assessments: [], finalStatus: 'answered' }), { modelOf, agents, priors })
  assert.equal(pick(answered, 'objective_deterministic', 'coding')[0].score, 1, 'a completed direct answer is a success without checks')
})

test('evidenceFromRun: a like or dislike becomes a human_outcome row when it matches the run or the session and agent', () => {
  const feedback = [
    { ts: T0, sessionId: 'sess-1', messageId: 'm1', verdict: 'like', provider: 'codex', model: 'gpt-5', reason: `${MARKER} nice` },
    { ts: T0, sessionId: 'sess-1', messageId: 'm2', verdict: 'dislike', provider: 'claude', tag: 'wrong scope', reason: MARKER },
    { ts: T0, sessionId: 'sess-1', messageId: 'm3', verdict: 'dislike', provider: 'claude', tag: 'too slow' },
    { ts: T0, sessionId: 'sess-other', messageId: 'm4', verdict: 'dislike', provider: 'codex' },
    { ts: T0, sessionId: 'sess-1', messageId: 'm5', verdict: 'dislike', provider: 'codex', model: 'gpt-4' },
    { ts: T0, sessionId: 'sess-x', messageId: 'm6', runId: 'run-1', verdict: 'like' },
  ]
  const r = run({ attempts: [attempt('claude', 'primary'), attempt('codex', 'retry')], assessments: [{ mode: 'jev', action: 'retry' }, { mode: 'jev', action: 'accept' }] })
  const rows = evidenceFromRun(r, { modelOf, agents, feedback, priors })
  const claude = pick(forAgent(rows, 'claude-code'), 'human_outcome')
  assert.deepEqual(claude.map((x) => [x.dimension, x.score, x.confidence]).sort(), [['coding', 0, 0.8], ['first_pass_quality', 0, 0.8], ['instruction_following', 0, 0.8]], 'one dislike by agent id; too slow is not about capability')
  const codex = pick(forAgent(rows, 'codex'), 'human_outcome')
  assert.equal(codex.length, 6, 'the like by provider and model, plus the like by runId for the last work attempt; other sessions and models do not match')
  assert.ok(codex.every((x) => x.score === 1))
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(MARKER), 'the reason text never rides along')
})

test('evidenceFromRun: a run Laya decided gives only whether each attempt completed, with no task type, and no verdict about it counts', async () => {
  const { answererUnconfigured, evidenceWeight } = await import('../profiles.js')
  const layaRun = run({
    routing: { taskType: 'security', decider: 'laya', primaryAgent: 'claude' },
    attempts: [attempt('claude', 'primary', { stopReason: 'error', checks: [{ name: 'test', passed: false }] }), attempt('codex', 'review'), attempt('deep', 'retry')],
    assessments: [{ mode: 'laya', action: 'retry' }, { mode: 'laya', action: 'retry' }, { mode: 'laya', action: 'accept' }],
  })
  const rows = evidenceFromRun(layaRun, { modelOf, agents, priors })
  assert.deepEqual(rows.map((r) => [r.subject.provider, r.dimension, r.source, r.score, r.confidence]), [['claude-code', 'reliability', 'objective_deterministic', 0, 0.9], ['deepseek', 'reliability', 'objective_deterministic', 1, 0.9]], 'completed or not, which rests on no judgment of Laya\'s')
  assert.ok(rows.every((r) => !('taskType' in r) && r.runId === 'run-1'), 'Laya\'s task type never rides a row')
  assert.equal(evidenceWeight(rows[1], { policy, nowMs: NOW, taskType: 'documentation' }).similarity, 1, 'so it never sets how much the row weighs when Jev Auto reads a profile')
  // The same record, decided by Jev, gives everything it always did.
  const taught = { ...layaRun, routing: { taskType: 'security', primaryAgent: 'claude' }, assessments: layaRun.assessments.map((a) => ({ ...a, mode: 'jev' })) }
  const all = evidenceFromRun(taught, { modelOf, agents, priors })
  assert.ok(pick(all, 'independent_review').length > 0 && all.every((r) => r.taskType === 'security'))
  // A verdict is credited on the dimensions of the run's task type, which was Laya's: nothing.
  const verdict = { ts: T0, runId: 'run-1', sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', provider: 'deep' }
  assert.deepEqual(evidenceFromFeedback(verdict, layaRun, { modelOf, agents, priors }), [])
  assert.ok(evidenceFromFeedback(verdict, taught, { modelOf, agents, priors }).length > 0, 'while about the Jev run it is a person\'s evidence')
  assert.equal(answererUnconfigured(verdict, layaRun, { agents: [] }), false, 'an uninstalled agent is never the reason a Laya run gives a verdict no rows')
  assert.equal(answererUnconfigured(verdict, taught, { agents: [] }), true)
})

test('registry persistence: rows append as JSONL, load reads them back, and a truncated line or a foreign line is dropped', () => {
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  assert.equal(reg.load(), 0, 'no file yet is empty, not an error')
  const s = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  reg.record(row(s, 'coding', 1, { runId: 'r1' }))
  reg.recordMany([row(s, 'coding', 0, { runId: 'r2' }), row(s, 'debugging', 1, { runId: 'r3', taskType: 'debugging' })])
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['ts', 'subject', 'dimension', 'score', 'source', 'confidence', 'n', 'runId'])
  appendFileSync(file, '{"ts":"2026-09-01T00:00:00.000Z","subject":{"provider":"claude-code"},"dimension":"cod')
  appendFileSync(file, '\n{"not":"evidence"}\n')
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  assert.equal(again.load(), 3, 'the truncated and the foreign line are dropped')
  assert.equal(again.evidenceCount(s), 3)
  assert.equal(again.effective(s, ['coding']).coding.samples, 2)
  assert.deepEqual(again.subjects(), [{ key: 'claude-code|claude-sonnet-4-5|claude-sonnet-4-5', provider: 'claude-code', family: 'anthropic-claude', model: 'claude-sonnet-4-5', version: 'claude-sonnet-4-5' }])
  assert.equal(again.profileOf(s).lastUpdate, T0)
  assert.equal(again.explain(s, 'coding').items.length, 2)
  // Loading twice does not double anything.
  assert.equal(again.load(), 3)
  assert.equal(again.evidenceCount(s), 3)
  // A memory-only registry works the same, minus the file.
  const mem = createCapabilityRegistry({ priors, policy, now: () => NOW })
  mem.record(row(s, 'coding', 1))
  assert.equal(mem.evidenceCount(s), 1)
})

test('registry record: bad rows are rejected before anything is written, and unknown keys never reach the disk', () => {
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  const s = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  assert.throws(() => reg.record(row(s, 'vibes', 1)), /unknown dimension "vibes"/)
  assert.throws(() => reg.record(row(s, 'coding', 1.5)), /score/)
  assert.throws(() => reg.record(row(s, 'coding', 1, { source: 'rumour' })), /source/)
  assert.throws(() => reg.record(row(s, 'coding', 1, { confidence: 3 })), /confidence/)
  assert.throws(() => reg.record(row(s, 'coding', 1, { n: 0 })), /n must be/)
  assert.throws(() => reg.record(row(s, 'coding', 1, { ts: 'yesterday' })), /ts/)
  assert.throws(() => reg.record(row({ model: 'x' }, 'coding', 1)), /subject.provider/)
  assert.throws(() => reg.record(row(s, 'coding', 1, { note: 'x'.repeat(201) })), /note/)
  assert.throws(() => reg.recordMany([row(s, 'coding', 1), row(s, 'coding', 2)]), /score/)
  assert.equal(existsSync(file), false, 'nothing was written, not even the file')
  const stored = reg.record({ ...row(s, 'coding', 1), prompt: MARKER, task: MARKER, diff: MARKER, note: 'nightly' })
  assert.equal(stored.note, 'nightly')
  assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(MARKER), 'unknown keys are dropped, not stored')
  const withoutTs = reg.record({ subject: s, dimension: 'coding', score: 1, source: 'jev_label' })
  assert.equal(withoutTs.ts, T0, 'the clock fills a missing timestamp')
  assert.equal(withoutTs.confidence, 1)
  assert.equal(withoutTs.n, 1)
})

test('effective source and evidence weights follow the policy: an objective row outweighs a self-assessment', () => {
  const reg = registry()
  const s = subject('mystery', 'm1')
  reg.record(row(s, 'coding', 0, { source: 'self_assessment', confidence: 1 }))
  reg.record(row(s, 'coding', 1, { source: 'objective_deterministic', confidence: 1 }))
  const ex = reg.explain(s, 'coding')
  assert.equal(ex.items[0].reliability, policy.evidence.reliability.self_assessment)
  assert.equal(ex.items[1].reliability, policy.evidence.reliability.objective_deterministic)
  assert.ok(ex.score > 0.8, 'the objective row carries the number')
  assert.equal(ex.source, 'objective_deterministic')
  assert.deepEqual(ex.sources, ['self_assessment', 'objective_deterministic'])
  // A row weighted by its own confidence and count.
  const t = subject('mystery', 'm2')
  reg.record(row(t, 'coding', 1, { confidence: 0.5, n: 4 }))
  assert.equal(reg.explain(t, 'coding').items[0].weight, 2)
  assert.equal(reg.effective(t, ['coding']).coding.samples, 4)
})

// --- model versions are independent subjects ---------------------------------------------------

test('finding 15: a reported version is part of the key, so a new version behind the same alias starts cold on the family prior', () => {
  const p = testPriors({ acme: { match: { providers: ['acme'], modelPattern: '^acme' }, capabilities: { coding: cap(0.9, 0.6) } } })
  const reg = registry({ priors: p })
  const def = { id: 'a', provider: 'acme' }
  // The CLI setting says `acme-best` both times; what was served changed underneath it.
  let served = 'acme-best-20260101'
  const versionOf = (_d, model) => (model === 'acme-best' ? served : undefined)
  const before = subjectOf(def, { modelOf: () => 'acme-best', versionOf, priors: p })
  assert.deepEqual(before, { provider: 'acme', family: 'acme', model: 'acme-best', version: 'acme-best-20260101' })
  for (let i = 0; i < 40; i++) reg.record(row(before, 'coding', 0, { runId: `r${i}` }))
  served = 'acme-best-20260801'
  const after = subjectOf(def, { modelOf: () => 'acme-best', versionOf, priors: p })
  assert.notEqual(subjectKey(before), subjectKey(after), 'the version, not the alias, keys the evidence')
  assert.equal(reg.cold(after), true)
  const pf = reg.profileOf(after)
  assert.equal(pf.samples, 0, 'none of the old version\'s execution evidence is inherited')
  assert.deepEqual(pf.dimensions.coding.sources, ['owner_prior'], 'the family prior is all it starts with')
  assert.equal(pf.dimensions.coding.score, 0.9)
  assert.deepEqual(pf.version, { id: 'acme-best-20260801', pinned: true, windowDays: null })
  // The run record's own modelVersion wins over what is reported now: the run is in the past.
  const rows = evidenceFromRun(run({ attempts: [attempt('claude', 'primary', { modelVersion: 'claude-sonnet-4-5-20250929' })] }), { modelOf, versionOf: () => 'claude-sonnet-4-5-20991231', agents, priors })
  assert.ok(rows.length)
  assert.ok(rows.every((r) => r.subject.model === 'claude-sonnet-4-5' && r.subject.version === 'claude-sonnet-4-5-20250929'))
})

test('finding 15: which versions are pinned: dated snapshots and content digests, never an alias or a bare name', () => {
  for (const v of ['claude-opus-4-1-20250805', 'gpt-4o-2024-08-06', 'a'.repeat(64), `sha256:${'b'.repeat(64)}`]) assert.equal(versionPinned(v), true, v)
  for (const v of ['opus', 'sonnet', 'claude-sonnet-4-5', 'gpt-5', 'deepseek-chat', 'deepseek-r1:8b', 'gpt-5.6', '', null, undefined]) assert.equal(versionPinned(v), false, String(v))
})

test('finding 15: under an unpinned name the old record is inherited for a bounded time only, and a pinned version keeps its own', () => {
  const reg = registry()
  const alias = subject('claude-code', 'opus', 'anthropic-claude')
  const pinned = subject('claude-code', 'claude-opus-4-1-20250805', 'anthropic-claude')
  const outside = UNPINNED_WINDOW_DAYS + 1
  for (let i = 0; i < 30; i++) {
    reg.record(row(alias, 'coding', 0, { ts: daysAgo(outside), runId: `old${i}` }))
    reg.record(row(pinned, 'coding', 0, { ts: daysAgo(outside), runId: `p${i}` }))
  }
  // Thirty failures from before the window: whatever version `opus` was then, they no longer count.
  const a = reg.explain(alias, 'coding')
  assert.equal(a.samples, 0)
  assert.equal(a.notCounted, 30)
  assert.deepEqual(a.version, { id: 'opus', pinned: false, windowDays: UNPINNED_WINDOW_DAYS })
  assert.equal(reg.cold(alias), true, 'nothing inside the window: the alias is cold again')
  assert.equal(reg.evidenceCount(alias), 0)
  assert.equal(reg.effective(alias, ['coding']).coding.source, 'family_prior', 'back to the family prior (an alias the pattern does not recognise: the weak one)')
  // The same rows under a pinned snapshot are that version's own record: decayed, never dropped.
  const p = reg.explain(pinned, 'coding')
  assert.equal(p.samples, 30)
  assert.equal(p.notCounted, 0)
  assert.equal(reg.cold(pinned), false)
  // Inside the window the alias's evidence counts as usual.
  for (let i = 0; i < 5; i++) reg.record(row(alias, 'coding', 1, { ts: daysAgo(UNPINNED_WINDOW_DAYS - 1), runId: `new${i}` }))
  assert.equal(reg.explain(alias, 'coding').samples, 5)
  assert.equal(reg.cold(alias), false)
})

// --- one verdict is one piece of evidence ------------------------------------------------------

const later = (min) => new Date(NOW + min * 60_000).toISOString()

test('finding 16: a session verdict is credited to the run it is about, once, not to every later run of the same agent', () => {
  // Run 1 ends at T0, the person likes its answer a minute later, and five more runs by the same
  // agent follow in the same session, each learning from the whole session's feedback.
  const like = { ts: later(1), sessionId: 'sess-1', messageId: 'm1', verdict: 'like', provider: 'claude' }
  const runs = [run({ runId: 'run-1', ts: T0 })]
  for (let i = 2; i <= 6; i++) runs.push(run({ runId: `run-${i}`, ts: later(i * 10) }))
  const reg = registry()
  for (const [i, r] of runs.entries()) reg.recordMany(evidenceFromRun(r, { modelOf, agents, feedback: [like], until: runs[i + 1]?.ts, priors }))
  const s = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  const human = reg.explain(s, 'coding').items.filter((it) => it.source === 'human_outcome')
  assert.equal(human.length, 1, 'one like, one row')
  assert.equal(human[0].runId, 'run-1', 'about the answer that existed when it was given')
  assert.equal(human[0].verdictKey, 'sess-1/m1')
  // The live flow learns from a run the moment it ends, before its answer can be judged: a
  // verdict from before this run ended is about an earlier answer and gives nothing here.
  assert.equal(pick(evidenceFromRun(runs[3], { modelOf, agents, feedback: [like], priors }), 'human_outcome').length, 0)
})

test('finding 16: a verdict on a run whose first and last attempts are the same agent is credited once, to the last', () => {
  const r = run({ attempts: [attempt('claude', 'primary'), attempt('claude', 'retry')], assessments: [{ mode: 'jev', action: 'retry' }, { mode: 'jev', action: 'accept' }] })
  const rows = evidenceFromRun(r, { modelOf, agents, feedback: [{ ts: T0, sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', provider: 'claude' }], priors })
  const human = pick(rows, 'human_outcome')
  assert.deepEqual(human.map((x) => x.dimension).sort(), ['coding', 'first_pass_quality', 'instruction_following'], 'one row per dimension, not two')
})

test('finding 16: the registry counts a verdict once however often it is recorded, and a changed verdict replaces it', () => {
  const reg = registry()
  const r = run()
  const like = { ts: T0, sessionId: 'sess-1', messageId: 'm1', verdict: 'like', provider: 'claude' }
  const once = evidenceFromFeedback(like, r, { modelOf, agents, priors })
  assert.ok(once.length && once.every((x) => x.source === 'human_outcome'), 'a verdict yields its own rows and nothing of the run')
  reg.recordMany(once)
  reg.recordMany(evidenceFromFeedback(like, r, { modelOf, agents, priors }))
  reg.recordMany(evidenceFromRun(r, { modelOf, agents, feedback: [like], priors }).filter((x) => x.source === 'human_outcome'))
  const s = subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
  const ex = reg.explain(s, 'coding')
  assert.equal(ex.samples, 1, 'three recordings of one like are one sample')
  assert.equal(ex.notCounted, 2)
  assert.equal(ex.items[0].score, 1)
  // The person changes their mind: the dislike replaces the like, it does not join it.
  reg.recordMany(evidenceFromFeedback({ ...like, ts: later(5), verdict: 'dislike' }, r, { modelOf, agents, priors }))
  const now = reg.explain(s, 'coding')
  assert.equal(now.samples, 1)
  assert.equal(now.items[0].score, 0)
  // And a reload from disk keeps the same rule.
  const file = tmp()
  const disk = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  disk.recordMany(once); disk.recordMany(once)
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  again.load()
  assert.equal(again.explain(s, 'coding').samples, 1)
  // A verdict that is not about the run passed in gives nothing.
  assert.deepEqual(evidenceFromFeedback({ ...like, ts: later(-5) }, r, { modelOf, agents, priors }), [])
  assert.throws(() => reg.record(row(s, 'coding', 1, { verdictKey: 'has spaces and text' })), /verdictKey/)
})

// --- contradictory evidence is less certain than unanimous evidence ---------------------------

test('dispersion: ten runs split 5 excellent / 5 terrible are less certain than ten that agree, by the documented arithmetic', () => {
  const reg = registry()
  const split = subject('mystery', 'split-20260101')
  const agree = subject('mystery', 'agree-20260101')
  for (let i = 0; i < 10; i++) {
    reg.record(row(split, 'coding', i % 2, { runId: `s${i}` }))
    reg.record(row(agree, 'coding', 0.75, { runId: `a${i}` }))
  }
  const es = reg.explain(split, 'coding')
  const ea = reg.explain(agree, 'coding')
  const scale = policy.evidence.confidenceScale
  assert.ok(close(ea.confidence, 1 - Math.exp(-10 / scale)), 'unanimous evidence keeps exactly the amount-only confidence')
  assert.equal(ea.agreement, 1)
  assert.ok(close(es.spread, 0.5))
  assert.ok(close(es.stdError, 0.5 / Math.sqrt(10)))
  assert.ok(close(es.confidence, (1 - Math.exp(-10 / scale)) * (1 - 2 * 0.5 / Math.sqrt(10))))
  assert.ok(es.confidence < ea.confidence * 0.75, `split ${es.confidence} vs unanimous ${ea.confidence}`)
  assert.equal(reg.profileOf(split).dimensions.coding.agreement, Math.round(es.agreement * 1000) / 1000)
  // Routing reads effective(): the discount reaches it.
  assert.ok(close(reg.effective(split, ['coding']).coding.confidence, es.confidence))
})

test('dispersion: a well-evidenced unanimous subject is not made to look uncertain, and many mixed runs still pin the score', () => {
  const reg = registry()
  const unanimous = subject('mystery', 'u-20260101')
  const mixed = subject('mystery', 'm-20260101')
  for (let i = 0; i < 300; i++) {
    reg.record(row(unanimous, 'coding', 1, { runId: `u${i}` }))
    reg.record(row(mixed, 'coding', i % 3 === 2 ? 0 : 1, { runId: `m${i}` }))
  }
  const u = reg.explain(unanimous, 'coding')
  assert.equal(u.agreement, 1)
  assert.ok(close(u.confidence, 1 - Math.exp(-300 / policy.evidence.confidenceScale)))
  const m = reg.explain(mixed, 'coding')
  assert.ok(m.confidence < u.confidence, 'disagreement still costs something')
  assert.ok(m.confidence > 0.9, `but three hundred runs are still a lot of evidence: ${m.confidence}`)
  // The factor on its own: no rows, a zero-weight set and a single row all leave confidence alone.
  assert.deepEqual(agreementOf([], 5), { spread: 0, stdError: 0, agreement: 1 })
  assert.equal(agreementOf([{ weight: 0, row: { score: 1 } }, { weight: 0, row: { score: 0 } }], 1).agreement, 1)
  assert.equal(agreementOf([{ weight: 1, row: { score: 0.3 } }], 1).agreement, 1)
})

// --- a verdict is credited when it is given, once, to the run it is about ---------------------

const claudeSubject = () => subject('claude-code', 'claude-sonnet-4-5', 'anthropic-claude')
// Every counted human_outcome row of a subject, across all its dimensions.
const humanOf = (reg, s) => DIMENSIONS.flatMap((d) => reg.explain(s, d).items.filter((it) => it.source === 'human_outcome').map((it) => ({ ...it, dimension: d })))

test('the live flow: a verdict given after its run ended is one piece of human evidence for that run, and the run end records none', async () => {
  const { creditVerdict, runEvidence } = await import('../index.js')
  const { createFeedback, validFeedback } = await import('../feedback.js')
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  const deps = { modelOf, agents, priors, now: () => NOW }
  const history = []
  const fb = createFeedback({ file: join(dirname(file), 'feedback.jsonl') })
  // What index.js does when a run ends, and when POST /jev-router/feedback stores a verdict.
  const end = (r) => { history.push(r); reg.recordMany(runEvidence(r, deps)) }
  const give = async (body, ts) => creditVerdict(await fb.append(validFeedback({ sessionId: 'sess-1', messageId: 'm1', provider: 'claude', ...body }, { now: () => ts })), history, { capabilities: reg, ...deps })
  const s = claudeSubject()
  const human = (r = reg) => humanOf(r, s)

  end(run({ runId: 'run-1', ts: T0 }))
  assert.equal(human().length, 0, 'nobody could judge the answer before it existed')
  await give({ verdict: 'like' }, later(1))
  end(run({ runId: 'run-2', ts: later(10) }))
  assert.deepEqual(human().map((h) => [h.dimension, h.runId, h.score]).sort(), TASK_DIMENSIONS.implementation.map((d) => [d, 'run-1', 1]).sort(), 'one like, credited to run 1, once per dimension it exercises')
  assert.ok(human().every((h) => h.verdictKey === 'sess-1/m1'))

  // The run end never records a verdict, even one that would look like it is about the run.
  const atEnd = { ts: later(10), sessionId: 'sess-1', messageId: 'm9', verdict: 'like', provider: 'claude' }
  assert.equal(pick(runEvidence(history[1], { ...deps, feedback: [atEnd] }), 'human_outcome').length, 0, 'feedback is credited in one place only')

  // A reason edited after run 2 ended is about the same answer: still run 1, still one.
  await give({ verdict: 'like', reason: 'clear and short' }, later(20))
  assert.equal(human().length, 3)
  assert.ok(human().every((h) => h.runId === 'run-1'))
  // A changed mind replaces the like.
  await give({ verdict: 'dislike' }, later(21))
  assert.deepEqual([...new Set(human().map((h) => `${h.runId}:${h.score}`))], ['run-1:0'])
  // Its newest form says nothing about capability, so nothing of it counts any more.
  await give({ verdict: 'dislike', tag: 'too slow' }, later(22))
  assert.equal(human().length, 0)
  // Cleared, then given again: back on run 1, once.
  await give({ verdict: 'like' }, later(23))
  await give({ verdict: 'clear' }, later(24))
  assert.equal(human().length, 0, 'a cleared verdict is not evidence')
  await give({ verdict: 'like' }, later(25))
  assert.deepEqual([...new Set(human().map((h) => `${h.runId}:${h.score}`))], ['run-1:1'])
  assert.equal(human().length, 3)
  // A reload from disk reads the same.
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  again.load()
  assert.deepEqual(human(again).map((h) => [h.dimension, h.runId, h.score]).sort(), human().map((h) => [h.dimension, h.runId, h.score]).sort())
  // A verdict on another answer, given after run 2, is about run 2.
  await give({ messageId: 'm2', verdict: 'dislike' }, later(30))
  assert.deepEqual([...new Set(human().filter((h) => h.verdictKey === 'sess-1/m2').map((h) => `${h.runId}:${h.score}`))], ['run-2:0'])
})

test('one verdict derived against runs of two task types counts once, from the newest derivation, whatever the dimensions', () => {
  const reg = registry()
  const like = { ts: T0, sessionId: 'sess-1', messageId: 'm1', verdict: 'like', provider: 'claude' }
  const impl = run({ runId: 'run-a' })
  const dbg = run({ runId: 'run-b', routing: { taskType: 'debugging' } })
  reg.recordMany(evidenceFromFeedback(like, impl, { modelOf, agents, priors }))
  reg.recordMany(evidenceFromFeedback(like, dbg, { modelOf, agents, priors }))
  const s = claudeSubject()
  const human = humanOf(reg, s)
  assert.deepEqual(human.map((h) => h.dimension).sort(), [...TASK_DIMENSIONS.debugging].sort(), 'only the debugging derivation counts')
  assert.ok(human.every((h) => h.runId === 'run-b'), 'nothing of the implementation derivation survives, not even on dimensions the newer one does not touch')
  // The same after a reload, where file order is the only record of which came last.
  const file = tmp()
  const disk = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  disk.recordMany(evidenceFromFeedback(like, impl, { modelOf, agents, priors }))
  disk.recordMany(evidenceFromFeedback(like, dbg, { modelOf, agents, priors }))
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  again.load()
  assert.deepEqual(humanOf(again, s).map((h) => `${h.runId}:${h.dimension}`).sort(), human.map((h) => `${h.runId}:${h.dimension}`).sort())
})

test('a past run without a recorded version is keyed by its model name, never by the version reported now', () => {
  // After an upgrade the provider reports a new pinned snapshot; the run three days ago did not run it.
  const versionOf = () => 'claude-sonnet-4-5-20991231'
  const deps = { modelOf, versionOf, agents, priors, now: () => NOW }
  const old = run({ ts: daysAgo(3) })
  const rows = evidenceFromRun(old, deps)
  assert.ok(rows.length)
  assert.ok(rows.every((r) => r.subject.version === 'claude-sonnet-4-5'), 'the model name: unpinned, so the registry bounds it in time')
  assert.equal(versionPinned(rows[0].subject.version), false)
  const late = evidenceFromFeedback({ ts: daysAgo(2), sessionId: 'sess-1', messageId: 'm1', verdict: 'like', provider: 'claude' }, old, deps)
  assert.ok(late.length && late.every((r) => r.subject.version === 'claude-sonnet-4-5'), 'a late verdict on a past run does not credit the current version either')
  // A run that has just ended ran what is reported now.
  const fresh = evidenceFromRun(run({ ts: new Date(NOW - 60_000).toISOString() }), deps)
  assert.ok(fresh.every((r) => r.subject.version === 'claude-sonnet-4-5-20991231'))
  // And a version the record carries wins at any age.
  const stamped = evidenceFromRun(run({ ts: daysAgo(3), attempts: [attempt('claude', 'primary', { modelVersion: 'claude-sonnet-4-5-20250929' })] }), deps)
  assert.ok(stamped.every((r) => r.subject.version === 'claude-sonnet-4-5-20250929'))
})

test('one versionOf keys a local model by its weights digest, for the evidence a run records and the profile a decision reads', async () => {
  const { localVersionOf } = await import('../index.js')
  const SHA = 'c'.repeat(64)
  const versionOf = localVersionOf({ modelOf: (id) => (id === 'qwen3-8b' ? { id, sha256: SHA } : undefined) })
  const qwen = { id: 'qwen-local', provider: 'spawn', llm: { provider: 'local', model: 'qwen3-8b' } }
  const read = subjectOf(qwen, { modelOf, versionOf, priors })
  assert.equal(read.version, SHA)
  assert.equal(versionPinned(read.version), true, 'the bytes cannot move under a digest')
  assert.equal(versionOf(agents[0], 'claude-sonnet-4-5'), undefined, 'nothing reliable is reported for anything else')
  assert.equal(subjectOf(agents[2], { modelOf, versionOf, priors }).version, 'deepseek-chat')
  // What execute stamps on a local attempt, read back two days on: the same key the reader uses.
  const reg = registry()
  const rows = evidenceFromRun(run({ ts: daysAgo(2), attempts: [attempt('qwen-local', 'primary', { model: 'qwen3-8b', modelVersion: SHA })] }), { modelOf, versionOf, agents: [qwen], priors, now: () => NOW })
  assert.ok(rows.length && rows.every((r) => subjectKey(r.subject) === subjectKey(read)))
  reg.recordMany(rows)
  assert.equal(reg.cold(read), false, 'the decision reads the evidence the run recorded')
})

test('an upgrade without known-resources.json seeds from history as well as samples, so an agent that ran is not announced as new', async () => {
  const { createResourceTracker } = await import('../index.js')
  const root = mkdtempSync(join(tmpdir(), 'kz-known-'))
  const changes = []
  const domains = { noteEnvironmentChange: (c) => changes.push(c) }
  const store = { list: async ({ domain }) => (domain === 'resource_selection' ? [{ input: { candidates: [{ key: 'RESOURCE_A', id: 'claude' }] } }] : []) }
  // codex ran, deepseek was out of allowance, kimi was gated: none of them was ever a ranked candidate.
  const records = async () => [{ routing: { primaryAgent: 'claude' }, attempts: [{ agent: 'claude' }, { agent: 'codex' }], gated: ['kimi'], availability: { out: [{ id: 'deepseek', until: null }], near: [] } }]
  const tracker = createResourceTracker({ file: join(root, 'known-resources.json'), store, records, domains })
  assert.deepEqual(await tracker.note([{ id: 'claude' }, { id: 'codex' }, { id: 'deepseek' }, { id: 'kimi' }, { id: 'qwen-local' }]), ['qwen-local'])
  assert.deepEqual(changes, [{ kind: 'new_resource', detail: 'qwen-local' }])
  // With no samples nothing has matured, and history alone announces nothing.
  const fresh = createResourceTracker({ file: join(root, 'b', 'known-resources.json'), store: { list: async () => [] }, records, domains })
  assert.deepEqual(await fresh.note([{ id: 'claude' }, { id: 'zeta' }]), [])
})

test('shipped text: the priors say where benchmark evidence comes from and how much it weighs, and the local agents say what they are, not what they are good at', () => {
  assert.doesNotMatch(priors.about, /benchmarks overtakes/)
  assert.doesNotMatch(priors.about, /nothing imports or records any benchmark/)
  assert.match(priors.about, /capability benchmark in the Router tab/)
  assert.match(priors.about, /as three observations/)
  const manifest = JSON.parse(readFileSync(join(dirname(PRIORS_FILE), 'local-models.json'), 'utf8'))
  const descriptions = (Array.isArray(manifest) ? manifest : manifest.modules ?? Object.values(manifest).find(Array.isArray) ?? []).filter((m) => m.agent).map((m) => m.agent.description)
  assert.ok(descriptions.length >= 2)
  for (const d of descriptions) {
    assert.match(d, /llama\.cpp/)
    assert.doesNotMatch(d, /good for|not for|weak|strong|tricky|hard/i, d)
  }
})

// ---------- onVerdict: what the feedback route does when a verdict is given ----------

async function verdictHarness() {
  const { onVerdict, verdictRow } = await import('../index.js')
  const { createFeedback, validFeedback } = await import('../feedback.js')
  const { createTrainingStore } = await import('../training.js')
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  const fb = createFeedback({ file: join(dirname(file), 'feedback.jsonl') })
  const training = createTrainingStore({ file: join(dirname(file), 'routing-samples.jsonl') })
  const history = []
  let agentList = agents
  let modelNow = modelOf
  let learn = true
  const give = async (body, ts) => {
    // Stored as the feedback route stores it (acceptVerdict): marked when learning is off.
    const stored = await fb.append(verdictRow(validFeedback({ sessionId: 'sess-1', messageId: 'm1', provider: 'claude', ...body }, { now: () => ts }), learn))
    return onVerdict(stored, { feedbackRows: await fb.history('sess-1'), records: history, capabilities: reg, training, modelOf: modelNow, agents: agentList, priors, learn })
  }
  return { reg, fb, training, history, give, setAgents: (a) => { agentList = a }, setModelOf: (f) => { modelNow = f }, setLearn: (on) => { learn = on } }
}

test('a verdict first given about run 1, re-tagged after run 2 ended, is still about run 1', async () => {
  // The first form credits nothing (too slow says nothing about capability), so nothing is
  // remembered about which run it was; the re-tag used to be dated when it was made and so moved
  // onto run 2. The answer judged is the one that existed when it was FIRST judged.
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  await h.give({ verdict: 'dislike', tag: 'too slow' }, later(1))
  h.history.push(run({ runId: 'run-2', ts: later(10) }))
  const out = await h.give({ verdict: 'like' }, later(20))
  assert.equal(out.run.runId, 'run-1')
  assert.ok(humanOf(h.reg, claudeSubject()).length > 0)
  assert.ok(humanOf(h.reg, claudeSubject()).every((x) => x.runId === 'run-1'), 'none of it credited to run 2')
})

test('a reason edited after an agent was uninstalled does not wipe the verdict it already counted', async () => {
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  await h.give({ verdict: 'like' }, later(1))
  const counted = humanOf(h.reg, claudeSubject()).length
  assert.ok(counted > 0, 'the setting: the like counted')
  h.setAgents(agents.filter((a) => a.id !== 'claude'))
  await h.give({ verdict: 'like', reason: 'clear and short' }, later(2))
  assert.equal(humanOf(h.reg, claudeSubject()).length, counted, 'the config changed, the verdict did not')
  // A clear still retracts, whatever the config.
  await h.give({ verdict: 'clear' }, later(3))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0)
})

test('a verdict relabels the routing samples of the run it is about, once', async () => {
  // At run end no verdict can exist, so the task-classification sample is labelled from the run
  // alone. A "misread my question" given afterwards must reach it, or human feedback never
  // teaches routing anything.
  const { labelFromRun } = await import('../training.js')
  const h = await verdictHarness()
  const r1 = run({ runId: 'run-1', ts: T0 })
  h.history.push(r1)
  const features = { numeric: { x: 1 }, categorical: {} }
  const sample = await h.training.append({ domain: 'task_classification', runId: 'run-1', input: { features }, teacher: { label: 'implementation', probabilities: { implementation: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  const other = await h.training.append({ domain: 'task_classification', runId: 'run-0', input: { features }, teacher: { label: 'debugging', probabilities: { debugging: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  await h.training.resolveOutcome(sample.id, labelFromRun('task_classification', await h.training.get(sample.id), r1))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'teacher_confirmed', 'the setting: labelled from the run alone')
  const out = await h.give({ verdict: 'dislike', tag: 'misread my question' }, later(1))
  assert.deepEqual(out.relabelled, [sample.id], 'only that run\'s sample')
  const now = (await h.training.get(sample.id)).outcome
  assert.deepEqual([now.label, now.negativeLabel, now.labelSource], [null, 'implementation', 'human'])
  assert.equal((await h.training.get(other.id)).outcome, null, 'another run\'s sample is untouched')
  // The same verdict again changes nothing, so nothing is written again.
  assert.deepEqual((await h.give({ verdict: 'dislike', tag: 'misread my question', reason: 'again' }, later(2))).relabelled, [])
})


test('a verdict relabels only the samples its run labels, never one the engine left out', async () => {
  // An off-vocabulary skill answer is replaced by the task type's own skill, and its sample is
  // left out of the samples the run labels: the run carried out another skill, so it says nothing
  // about that answer. A later verdict about the run said nothing about it either, and labelled it.
  const { labelFromRun } = await import('../training.js')
  const h = await verdictHarness()
  const features = { numeric: { x: 1 }, categorical: {} }
  const teach = (domain, label) => ({ domain, runId: 'run-1', input: { features }, teacher: { label, probabilities: { [label]: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  const task = await h.training.append(teach('task_classification', 'implementation'))
  const skill = await h.training.append(teach('skill_selection', 'no-such-skill'))
  const r1 = run({ runId: 'run-1', ts: T0, routing: { taskType: 'implementation', primaryAgent: 'claude', decision: { samples: [{ domain: 'task_classification', id: task.id }] } } })
  h.history.push(r1)
  await h.training.resolveOutcome(task.id, labelFromRun('task_classification', await h.training.get(task.id), r1))
  const out = await h.give({ verdict: 'like', tag: 'good pick' }, later(1))
  assert.deepEqual(out.relabelled, [task.id], 'the run\'s own sample is relabelled')
  assert.equal((await h.training.get(skill.id)).outcome, null, 'the one the engine left out stays unlabelled')
})

// ---------- which evidence a verdict keeps when it is re-posted, changed or withdrawn ----------

const scoresOf = (reg, s) => [...new Set(humanOf(reg, s).map((x) => `${x.runId}:${x.score}`))]

test('an unrelated agent removed from the setup page never keeps a withdrawn verdict counting', async () => {
  // claude did the work, deep only reviewed it. The review is never credited, so deep being
  // removed says nothing about why a verdict on claude's answer gives no rows.
  const h = await verdictHarness()
  const reviewed = { attempts: [attempt('claude', 'primary'), attempt('deep', 'review')], assessments: [{ mode: 'jev', action: 'accept' }, { mode: 'review', action: 'accept' }] }
  h.history.push(run({ runId: 'run-1', ts: T0, ...reviewed }))
  await h.give({ verdict: 'like' }, later(1))
  assert.deepEqual(scoresOf(h.reg, claudeSubject()), ['run-1:1'], 'the setting: the like counted')
  h.setAgents(agents.filter((a) => a.id !== 'deep'))
  await h.give({ verdict: 'dislike', tag: 'too slow' }, later(2))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'a too slow tag credits nothing, so the like is withdrawn')
})

test('with the answering agent uninstalled, only the same verdict re-posted keeps what it counted', async () => {
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  await h.give({ verdict: 'like', tag: 'good pick' }, later(1))
  const counted = humanOf(h.reg, claudeSubject()).length
  assert.ok(counted > 0)
  h.setAgents(agents.filter((a) => a.id !== 'claude'))
  await h.give({ verdict: 'like', tag: 'good pick', reason: 'edited' }, later(2))
  assert.equal(humanOf(h.reg, claudeSubject()).length, counted, 'same verdict, same tag: the config changed, the verdict did not')
  // A changed mind cannot be credited to a deleted agent, and the like it replaces stops counting.
  await h.give({ verdict: 'dislike', tag: 'good pick' }, later(3))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'a like changed to a dislike does not keep counting as a like')

  // A changed tag is a changed verdict too.
  const t = await verdictHarness()
  t.history.push(run({ runId: 'run-1', ts: T0 }))
  await t.give({ verdict: 'like', tag: 'good pick' }, later(1))
  t.setAgents(agents.filter((a) => a.id !== 'claude'))
  await t.give({ verdict: 'like', tag: 'wrong scope' }, later(2))
  assert.equal(humanOf(t.reg, claudeSubject()).length, 0)
})

test('an unchanged re-post keeps evidence only when the registry still counts that same form', async () => {
  // Evidence the earlier code left counting after a change it never took back (a like flipped to
  // a dislike with learning off). Re-posting the dislike must not keep the stale like.
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  await h.give({ verdict: 'like' }, later(1))
  await h.fb.append({ ts: later(2), sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', reason: '', provider: 'claude' })
  assert.deepEqual(scoresOf(h.reg, claudeSubject()), ['run-1:1'], 'the setting: the stale like still counts')
  h.setAgents(agents.filter((a) => a.id !== 'claude'))
  await h.give({ verdict: 'dislike', reason: 'again' }, later(3))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0)
  // The same with learning off, where a like later tagged too slow was never taken back: that
  // form credits nothing, so re-posting it cannot keep the like.
  const t = await verdictHarness()
  t.history.push(run({ runId: 'run-1', ts: T0 }))
  await t.give({ verdict: 'like' }, later(1))
  await t.fb.append({ ts: later(2), sessionId: 'sess-1', messageId: 'm1', verdict: 'like', tag: 'too slow', reason: '', provider: 'claude' })
  t.setLearn(false)
  await t.give({ verdict: 'like', tag: 'too slow', reason: 'again' }, later(3))
  assert.equal(humanOf(t.reg, claudeSubject()).length, 0)
})

test('a verdict on a run whose attempt recorded no model is not moved or retracted by a model configured later', async () => {
  // settings.json named no model, so router.js stamped none; the chain reads "claude (high)" and
  // the client posts model "high". The owner then sets a model.
  const h = await verdictHarness()
  h.setModelOf(() => undefined)
  h.history.push(run({ runId: 'run-1', ts: T0, attempts: [attempt('claude', 'primary', { model: undefined, effort: 'high' })] }))
  const unnamed = subject('claude-code', null)
  await h.give({ verdict: 'like', model: 'high' }, later(1))
  const counted = humanOf(h.reg, unnamed).length
  assert.ok(counted > 0, 'the setting: the like counted, under no model')
  h.setModelOf((a) => (a.id === 'claude' ? 'opus' : undefined))
  await h.give({ verdict: 'like', model: 'high', reason: 'edited' }, later(2))
  assert.equal(humanOf(h.reg, unnamed).length, counted, 'still counted, on the same subject')
  assert.equal(humanOf(h.reg, subject('claude-code', 'opus')).length, 0, 'never credited to a model the run did not run')
  // The same for the run's own evidence read back later (a backfill).
  const rows = evidenceFromRun(h.history[0], { modelOf: () => 'opus', agents, priors, now: () => NOW })
  assert.ok(rows.length && rows.every((r) => r.subject.model === null))
  // And an agent's pinned model edited since: the attempt's own record wins.
  const edited = agents.map((a) => (a.id === 'deep' ? { ...a, llm: { ...a.llm, model: 'deepseek-v4' } } : a))
  const deepRows = evidenceFromRun(run({ attempts: [attempt('deep', 'primary')] }), { modelOf, agents: edited, priors, now: () => NOW })
  assert.ok(deepRows.length && deepRows.every((r) => r.subject.model === 'deepseek-chat'))
})

test('a verdict naming the run of its answer is credited to that run, not to the newest one', async () => {
  const { validFeedback } = await import('../feedback.js')
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  h.history.push(run({ runId: 'run-2', ts: later(5), routing: { taskType: 'debugging' } }))
  const out = await h.give({ messageId: 'answer-of-run-1', verdict: 'dislike', runId: 'run-1' }, later(9))
  assert.equal(out.run.runId, 'run-1')
  assert.deepEqual(scoresOf(h.reg, claudeSubject()), ['run-1:0'])
  // Without a runId the time rule still guesses the newest run (the documented limit).
  const g = await verdictHarness()
  g.history.push(run({ runId: 'run-1', ts: T0 }), run({ runId: 'run-2', ts: later(5) }))
  assert.equal((await g.give({ verdict: 'dislike' }, later(9))).run.runId, 'run-2')
  // A runId that is not a run of the verdict's session is about nothing here.
  const other = await verdictHarness()
  other.history.push(run({ runId: 'run-9', sessionId: 'sess-2', ts: T0 }), run({ runId: 'run-1', ts: T0 }))
  const lost = await other.give({ verdict: 'like', runId: 'run-9' }, later(1))
  assert.equal(lost.run, null)
  assert.equal(humanOf(other.reg, claudeSubject()).length, 0)
  assert.equal(validFeedback({ sessionId: 'sess-1', messageId: 'm1', verdict: 'like', runId: 'run-1' }).runId, 'run-1')
})

test('route() marks an answer with its run, in a form that renders as nothing and reads back exactly', async () => {
  const { RUN_MARK, withRunMark } = await import('../index.js')
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const text = withRunMark('**Final status: accepted**\nThe answer.', id)
  assert.match(text, /\n\n\[jev-run\]: kzh-run-1-0f8fad5b/, 'a link reference definition after a blank line')
  assert.equal(RUN_MARK.exec(text)?.[1], id)
  assert.equal(withRunMark('x', undefined), 'x', 'no run, no mark')
  assert.equal(withRunMark('x', 'bad id!'), 'x')
})

test('with learning off, a withdrawn or changed verdict still stops counting, and nothing new is credited', async () => {
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }))
  await h.give({ verdict: 'like' }, later(1))
  const counted = humanOf(h.reg, claudeSubject()).length
  assert.ok(counted > 0)
  h.setLearn(false)
  await h.give({ verdict: 'like', reason: 'edited' }, later(2))
  assert.equal(humanOf(h.reg, claudeSubject()).length, counted, 'the same verdict re-posted keeps what it counted')
  await h.give({ verdict: 'dislike' }, later(3))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'the like is withdrawn; the dislike waits for learning')
  await h.give({ messageId: 'm2', verdict: 'like' }, later(4))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'a new verdict is new learning')

  const c = await verdictHarness()
  c.history.push(run({ runId: 'run-1', ts: T0 }))
  await c.give({ verdict: 'like' }, later(1))
  c.setLearn(false)
  await c.give({ verdict: 'clear' }, later(2))
  assert.equal(humanOf(c.reg, claudeSubject()).length, 0, 'a clear retracts')
})

test('with learning off, a cleared verdict takes back the routing label it gave, and a new one gives none', async () => {
  const { labelFromRun } = await import('../training.js')
  const h = await verdictHarness()
  const r1 = run({ runId: 'run-1', ts: T0 })
  h.history.push(r1)
  const features = { numeric: { x: 1 }, categorical: {} }
  const sample = await h.training.append({ domain: 'task_classification', runId: 'run-1', input: { features }, teacher: { label: 'implementation', probabilities: { implementation: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  await h.training.resolveOutcome(sample.id, labelFromRun('task_classification', await h.training.get(sample.id), r1))
  await h.give({ verdict: 'dislike', tag: 'misread my question' }, later(1))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'human', 'the setting: the verdict relabelled it')
  h.setLearn(false)
  assert.deepEqual((await h.give({ verdict: 'dislike', tag: 'misread my question', reason: 'again' }, later(2))).relabelled, [], 'the same verdict again takes nothing back')
  await h.give({ verdict: 'clear' }, later(3))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'teacher_confirmed', 'back to what the run alone says')
  await h.give({ verdict: 'dislike', tag: 'misread my question' }, later(4))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'teacher_confirmed', 'a new verdict waits for learning')
})

test('with learning off, a withdrawal does not bring in a verdict that was never learnt from', async () => {
  const { labelFromRun } = await import('../training.js')
  const h = await verdictHarness()
  const r1 = run({ runId: 'run-1', ts: T0 })
  h.history.push(r1)
  const features = { numeric: { x: 1 }, categorical: {} }
  const sample = await h.training.append({ domain: 'task_classification', runId: 'run-1', input: { features }, teacher: { label: 'implementation', probabilities: { implementation: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  await h.training.resolveOutcome(sample.id, labelFromRun('task_classification', await h.training.get(sample.id), r1))
  await h.give({ verdict: 'dislike', tag: 'misread my question' }, later(1))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'human', 'the setting: m1 relabelled it')
  h.setLearn(false)
  // A like on another message about the same run, given while learning is off: stored, not learnt.
  await h.give({ messageId: 'm2', verdict: 'like' }, later(2))
  assert.equal((await h.training.get(sample.id)).outcome.labelSource, 'human', 'unchanged by the new like')
  // Withdrawing m1 takes back its label, and nothing else steps in: m2 was never learnt from.
  await h.give({ verdict: 'clear' }, later(3))
  const now = (await h.training.get(sample.id)).outcome
  assert.equal(now.labelSource, 'teacher_confirmed', `back to what the run alone says, not m2's like (${JSON.stringify(now)})`)
})

test('a verdict re-posted naming another answerer or another run is not the same verdict', async () => {
  const h = await verdictHarness()
  h.history.push(run({ runId: 'run-1', ts: T0 }), run({ runId: 'run-2', ts: later(5) }))
  await h.give({ verdict: 'like', runId: 'run-1' }, later(10))
  assert.ok(humanOf(h.reg, claudeSubject()).length > 0)
  h.setLearn(false)
  // Learning is off, so only an unchanged form keeps what it counted. The same like, said to be
  // about another run, is a different verdict: what it counted on run 1 is taken back.
  await h.give({ verdict: 'like', runId: 'run-2' }, later(11))
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0)
})

test('the feedback route with learning off stores the verdict and still applies a clear', async () => {
  const { acceptVerdict } = await import('../index.js')
  const { createFeedback, validFeedback } = await import('../feedback.js')
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  const fb = createFeedback({ file: join(dirname(file), 'feedback.jsonl') })
  const history = [run({ runId: 'run-1', ts: T0 })]
  const post = (body, ts, learn) => acceptVerdict(validFeedback({ sessionId: 'sess-1', messageId: 'm1', provider: 'claude', ...body }, { now: () => ts }), {
    feedback: fb, records: async () => history, agents: async () => agents, capabilities: reg, priors, learn,
  })
  await post({ verdict: 'like' }, later(1), true)
  assert.ok(humanOf(reg, claudeSubject()).length > 0)
  const stored = await post({ verdict: 'clear' }, later(2), false)
  assert.equal(stored.verdict, 'clear')
  assert.deepEqual(await fb.list('sess-1'), [], 'stored')
  assert.equal(humanOf(reg, claudeSubject()).length, 0, 'and the like it withdrew no longer counts')
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  again.load()
  assert.equal(humanOf(again, claudeSubject()).length, 0, 'after a restart too')
})

// ---------- POST /jev-router/feedback, the route itself ----------
// apply() needs the whole plugin runtime, so the route's handling is a function of its own
// (createFeedbackRoute) that apply() serves the route with. These drive it with the request body
// as text, over a real feedback log, capability registry and training store, wired as apply() does.
async function routeHarness({ slowLike = false, failOnce = false } = {}) {
  const { createFeedbackRoute } = await import('../index.js')
  const { createFeedback } = await import('../feedback.js')
  const { createTrainingStore, labelFromRun } = await import('../training.js')
  const file = tmp()
  const reg = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  const fb = createFeedback({ file: join(dirname(file), 'feedback.jsonl') })
  const training = createTrainingStore({ file: join(dirname(file), 'routing-samples.jsonl') })
  const r1 = run({ runId: 'run-1', ts: T0 })
  // The run's task-classification sample, labelled from the run alone, as it is when a run ends.
  const sample = await training.append({ domain: 'task_classification', runId: 'run-1', input: { features: { numeric: { x: 1 }, categorical: {} } }, teacher: { label: 'implementation', probabilities: { implementation: 0.9 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev' })
  await training.resolveOutcome(sample.id, labelFromRun('task_classification', await training.get(sample.id), r1))
  let learn = true
  // A like that takes a while to reach the disk, so a verdict posted after it could overtake it.
  // Or one whose first write fails (a full disk, say), and every write after it succeeds.
  let failed = false
  const log = slowLike ? { ...fb, append: async (r) => { if (r.verdict === 'like') await new Promise((ok) => setTimeout(ok, 50)); return fb.append(r) } }
    : failOnce ? { ...fb, append: async (r) => { if (!failed) { failed = true; throw new Error('ENOSPC: no space left on device') } return fb.append(r) } }
      : fb
  const post = createFeedbackRoute({ feedback: log, records: async () => [r1], capabilities: reg, training, agents: async () => agents, priors, learn: () => learn })
  const body = (over) => JSON.stringify({ sessionId: 'sess-1', messageId: 'm1', provider: 'claude', runId: 'run-1', ...over })
  const labelSource = async () => (await training.get(sample.id)).outcome.labelSource
  return { reg, fb, training, sample, post, body, labelSource, setLearn: (on) => { learn = on } }
}

test('POST /jev-router/feedback: a verdict is stored, credited to its run and relabels it, and the reply is the stored row', async () => {
  const h = await routeHarness()
  const res = await h.post(h.body({ verdict: 'dislike', tag: 'misread my question', reason: 'I asked for a plan' }))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(await h.fb.list('sess-1'), [res.body.record], 'stored, and the reply carries exactly what was stored')
  assert.equal(res.body.record.runId, 'run-1')
  const label = (await h.training.get(h.sample.id)).outcome
  assert.deepEqual([label.label, label.negativeLabel, label.labelSource], [null, 'implementation', 'human'], 'the run\'s routing sample now carries the person\'s label')
  assert.ok(humanOf(h.reg, claudeSubject()).length > 0, 'and the verdict is capability evidence')
  assert.ok(humanOf(h.reg, claudeSubject()).every((x) => x.runId === 'run-1' && x.score === 0), 'a dislike, about run 1')
})

test('POST /jev-router/feedback: a bad body is a 400 with the reason, and changes nothing', async () => {
  const h = await routeHarness()
  for (const [raw, reason] of [
    ['{not json', /JSON/],
    ['[]', /expected an object/],
    [h.body({ verdict: 'meh' }), /verdict: like, dislike, or clear/],
    [h.body({ verdict: 'dislike', tag: 'wrong model' }), /tag: one of/],
    [h.body({ verdict: 'like', runId: 'run 1' }), /runId/],
    [h.body({ verdict: 'like', sessionId: '' }), /sessionId/],
  ]) {
    const res = await h.post(raw)
    assert.equal(res.status, 400, raw)
    assert.match(res.body.error, reason)
  }
  assert.deepEqual(await h.fb.history(), [], 'nothing was stored')
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'nothing was credited')
  assert.equal(await h.labelSource(), 'teacher_confirmed', 'nothing was relabelled')
  assert.equal((await h.post(h.body({ verdict: 'like' }))).status, 200, 'and the route still takes a good one after them')
})

test('POST /jev-router/feedback with learning off: stored and marked, nothing learnt, and a clear still withdraws', async () => {
  const h = await routeHarness()
  assert.equal((await h.post(h.body({ verdict: 'like' }))).status, 200)
  const counted = humanOf(h.reg, claudeSubject()).length
  assert.ok(counted > 0, 'the setting: with learning on the like counted')
  h.setLearn(false)
  const off = await h.post(h.body({ messageId: 'm2', verdict: 'dislike', tag: 'misread my question' }))
  assert.equal(off.status, 200)
  assert.equal(off.body.record.learningOff, true, 'stored, and marked as given while learning was off')
  assert.equal(humanOf(h.reg, claudeSubject()).length, counted, 'no new evidence')
  assert.equal(await h.labelSource(), 'teacher_confirmed', 'and no new label')
  assert.equal((await h.post(h.body({ verdict: 'clear' }))).status, 200)
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'the like withdrawn with learning off no longer counts')
  assert.deepEqual((await h.fb.list('sess-1')).map((r) => r.messageId), ['m2'], 'the log reads back what the person thinks now')
})

test('POST /jev-router/feedback: verdicts posted together are applied in the order they are stored', async () => {
  const h = await routeHarness({ slowLike: true })
  // A quick like then dislike on one answer, the second posted before the first has answered,
  // and the like slow to store: only the one queue keeps the dislike from landing first.
  const [a, b] = await Promise.all([h.post(h.body({ verdict: 'like' })), h.post(h.body({ verdict: 'dislike' }))])
  assert.deepEqual([a.status, b.status], [200, 200])
  assert.deepEqual((await h.fb.history('sess-1')).map((r) => r.verdict), ['like', 'dislike'], 'stored in the order given')
  const scores = humanOf(h.reg, claudeSubject()).map((x) => x.score)
  assert.ok(scores.length > 0 && scores.every((s) => s === 0), `what counts is the dislike, the newest: ${scores}`)
})

test('POST /jev-router/feedback: a verdict that could not be stored fails alone, and the next one is taken', async () => {
  const h = await routeHarness({ failOnce: true })
  // The route throws, and the HTTP handler answers that as it answers any other failure.
  await assert.rejects(h.post(h.body({ verdict: 'like' })), /ENOSPC/)
  assert.deepEqual(await h.fb.history(), [], 'nothing was stored')
  assert.equal(humanOf(h.reg, claudeSubject()).length, 0, 'and nothing credited')
  // One failed write must not become the queue: every verdict after it would fail too.
  const next = await h.post(h.body({ verdict: 'dislike' }))
  assert.equal(next.status, 200)
  assert.deepEqual((await h.fb.list('sess-1')).map((r) => r.verdict), ['dislike'], 'the next verdict is stored')
  assert.ok(humanOf(h.reg, claudeSubject()).length > 0, 'and applied')
})

// ---------- the history deps apply() gives the router ----------
// createHistoryDeps is what apply() hands runRouted as deps.history. Its runOfVerdict is the one
// place the registry's credit (creditedRun) reaches the router's feedback prior, so it is driven
// here over the same registry the route credits verdicts in.
test('createHistoryDeps: a verdict with no runId is placed on the run the route credited it to, whatever ended since', async () => {
  const { createHistoryDeps } = await import('../index.js')
  const h = await routeHarness()
  // The first form names its run, so the route credits it to run 1.
  const first = await h.post(h.body({ verdict: 'dislike' }))
  assert.equal(first.status, 200)
  // A newer run of the session, of another kind, ended before a later form that names no run.
  const historyFile = join(dirname(tmp()), 'history.jsonl')
  const runs = [run({ runId: 'run-1', ts: T0 }), run({ runId: 'run-2', ts: daysAgo(-1), routing: { taskType: 'documentation', primaryAgent: 'claude' } })]
  writeFileSync(historyFile, runs.map((r) => `${JSON.stringify(r)}\n`).join(''))
  const later = { ...first.body.record, runId: undefined, ts: daysAgo(-2) }
  const deps = createHistoryDeps({ historyFile, feedback: h.fb, capabilities: h.reg })
  assert.equal(deps.runOfVerdict(later, await deps.records())?.runId, 'run-1', 'the run its evidence is on')
  const blind = createHistoryDeps({ historyFile, feedback: h.fb })
  assert.equal(blind.runOfVerdict(later, await blind.records())?.runId, 'run-2', 'without the registry it would be read as the newer run')
})

// ---------- the capability benchmark's evidence (docs/benchmark.md 3.9) ----------

// The task set's shape: nine skills of three tasks each, crediting what 3.2 says.
const BENCH = { id: 'kzh-capability', version: '1' }
const BENCH_CREDITED = {
  implementation: ['coding', 'instruction_following'], debugging: ['debugging', 'coding', 'general_reasoning'], refactor: ['coding'],
  testing: ['testing', 'coding'], review: ['code_review'], security: ['security_review', 'code_review'],
  performance: ['debugging', 'general_reasoning'], simple_change: ['instruction_following'], investigation: ['general_reasoning'],
}
const BENCH_TASKS = Object.entries(BENCH_CREDITED).flatMap(([skill, dimensions]) => [1, 2, 3].map((level) => ({ id: `${skill}-${level}`, skill, level, dimensions })))
/** One agent's task rows of a run, the preflight's first, each task's outcome as `outcome` says. */
const benchRows = (outcome = () => 'passed', { model = 'gpt-5', modelVersion = null, ts = T0 } = {}) => [
  { task: 'preflight', outcome: 'passed', ts, model, modelVersion },
  ...BENCH_TASKS.map((t) => ({ task: t.id, outcome: outcome(t), ts, model, modelVersion })),
]
const benchEvidence = (agent, runId, outcome, over = {}, benchmark = BENCH) => profilesModule.benchmarkEvidence(benchRows(outcome, over), { tasks: BENCH_TASKS, agent, priors, benchmark, runId })
const CODEX = { id: 'codex', provider: 'codex' }

test('benchmarkEvidence: a row per task and credited dimension, of the model the attempts recorded, with n of 3 over the tasks crediting the dimension, so a whole run weighs 1.89 on coding when fresh', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  // 9 of the 12 coding tasks pass: the three level-3 ones of implementation, refactor and testing fail.
  const failing = new Set(['implementation-3', 'refactor-3', 'testing-3'])
  const rows = benchEvidence(CODEX, 'bench-1', (t) => (failing.has(t.id) ? 'failed' : 'passed'))
  const s = subjectOf(CODEX, { modelOf: () => 'gpt-5', priors })
  assert.equal(rows.length, 45, 'one row per task and dimension it credits')
  assert.deepEqual(rows.find((r) => r.note === 'debugging-2' && r.dimension === 'debugging'), {
    ts: T0, subject: s, dimension: 'debugging', score: 1, source: 'benchmark', confidence: 0.9, n: 0.5, taskType: 'debugging', benchmark: BENCH, runId: 'bench-1', note: 'debugging-2',
  })
  assert.equal(rows.find((r) => r.note === 'refactor-3').score, 0)
  const nOf = (dim) => [...new Set(rows.filter((r) => r.dimension === dim).map((r) => r.n))]
  assert.deepEqual(
    Object.fromEntries(['coding', 'general_reasoning', 'debugging', 'instruction_following', 'code_review', 'testing', 'security_review'].map((d) => [d, nOf(d)])),
    { coding: [3 / 12], general_reasoning: [3 / 9], debugging: [3 / 6], instruction_following: [3 / 6], code_review: [3 / 6], testing: [3 / 3], security_review: [3 / 3] },
  )
  // Recorded, a whole run weighs on coding as three observations at the benchmark's reliability do.
  const reg = registry()
  reg.recordMany(rows)
  const coding = reg.explain(s, 'coding')
  assert.equal(coding.items.length, 12)
  assert.ok(close(coding.evidenceWeight, 3 * 0.9 * policy.evidence.reliability.benchmark), `weight ${coding.evidenceWeight}`)
  assert.ok(close(coding.evidenceWeight, 1.89))
  assert.ok(close(coding.score, (coding.priorStrength * coding.prior.score + coding.evidenceWeight * 0.75) / (coding.priorStrength + coding.evidenceWeight)), 'the pass rate pulls the prior by the run\'s capped weight')
})

test('benchmarkEvidence: a task that did not fit the window KzH gives a local model gives no row at all, since the window is KzH\'s setting and not the model; the others keep their weight', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  const rows = benchEvidence(CODEX, 'bench-1', (t) => (t.id === 'implementation-3' ? 'did_not_fit' : 'passed'))
  assert.deepEqual(rows.filter((r) => r.note === 'implementation-3'), [], 'nothing of the task that did not fit')
  assert.deepEqual(rows.filter((r) => r.dimension === 'long_context'), [], 'and no long context row')
  assert.equal(rows.length, 45 - 2, 'every other task keeps its rows: implementation-3 credits coding and instruction following')
  assert.deepEqual([...new Set(rows.filter((r) => r.dimension === 'coding').map((r) => r.n))], [3 / 12], 'n is still over the set\'s tasks, so a run with a task that did not fit weighs less')
})

test('benchmarkEvidence: a timed-out task scores 0, and a run that describes no one model or holds an unscored task gives nothing', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  const rows = benchEvidence(CODEX, 'bench-1', (t) => (t.id === 'debugging-1' ? 'timed_out' : 'passed'))
  assert.deepEqual(rows.filter((r) => r.note === 'debugging-1').map((r) => r.score), [0, 0, 0])
  const mixed = benchRows()
  mixed[3] = { ...mixed[3], model: 'gpt-4.1' }
  assert.throws(() => profilesModule.benchmarkEvidence(mixed, { tasks: BENCH_TASKS, agent: CODEX, priors, benchmark: BENCH, runId: 'bench-2' }), /codex ran on more than one model during the benchmark \(gpt-5, gpt-4\.1\)/)
  assert.throws(() => benchEvidence(CODEX, 'bench-3', (t) => (t.id === 'review-2' ? 'errored' : 'passed')), /codex's review-2 was not scored \(errored\)/)
})

test('benchmark rows are not runs: they are left out of samples and evidenceSamples, reported as the dimension\'s benchmark summary with its tasks, passes and weight, and leave the model cold', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  const reg = registry()
  const s = subjectOf(CODEX, { modelOf: () => 'gpt-5', priors })
  reg.recordMany(benchEvidence(CODEX, 'bench-1', (t) => (t.level === 3 ? 'failed' : 'passed')))
  const profile = reg.profileOf(s)
  assert.equal(profile.samples, 0, 'no verified run behind the profile: what the ranking and Jev read as evidenceSamples')
  assert.equal(profile.dimensions.coding.samples, 0)
  assert.equal(reg.effective(s, ['coding']).coding.samples, 0)
  assert.deepEqual(profile.dimensions.coding.benchmark, { score: 0.667, tasks: 12, passed: 8, weight: 1.89 }, 'the pass rate, the tasks, the passes and the weight now')
  assert.deepEqual(profile.dimensions.testing.benchmark, { score: 0.667, tasks: 3, passed: 2, weight: 1.89 })
  assert.equal(reg.cold(s), true, 'a benchmark alone leaves a model cold')
  // A run's own row does count as a sample beside them.
  reg.record(row(s, 'coding', 1, { n: 1 }))
  assert.equal(reg.profileOf(s).dimensions.coding.samples, 1)
  assert.equal(reg.profileOf(s).dimensions.coding.benchmark.tasks, 12)
})

test('a newer benchmark run replaces an older one for the same model and benchmark, also after a reload, and explain() counts the older rows as not counted', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  const file = tmp()
  const reg = registry({ file })
  const s = subjectOf(CODEX, { modelOf: () => 'gpt-5', priors })
  const other = subjectOf(CODEX, { modelOf: () => 'gpt-4.1', priors })
  reg.recordMany(benchEvidence(CODEX, 'bench-1', () => 'passed', { ts: daysAgo(3) }))
  reg.recordMany(benchEvidence(CODEX, 'bench-2', () => 'failed', { ts: daysAgo(1) }))
  // Another model's run, and a run of another benchmark on this model, are not replaced by it.
  reg.recordMany(benchEvidence(CODEX, 'bench-9', () => 'passed', { model: 'gpt-4.1', ts: daysAgo(2) }))
  reg.recordMany(benchEvidence(CODEX, 'other-1', () => 'passed', { ts: daysAgo(2) }, { id: 'another-benchmark', version: '1' }))
  const check = (r, label) => {
    const ex = r.explain(s, 'coding')
    assert.deepEqual([...new Set(ex.items.map((it) => it.runId))].sort(), ['bench-2', 'other-1'], `${label}: only the newest run of each benchmark counts`)
    assert.equal(ex.notCounted, 12, `${label}: the older run's rows stay on file, not counted`)
    assert.deepEqual(r.explain(other, 'coding').items.map((it) => it.runId), Array(12).fill('bench-9'), `${label}: another model keeps its own`)
  }
  check(reg, 'as recorded')
  const again = createCapabilityRegistry({ file, priors, policy, now: () => NOW })
  again.load()
  check(again, 'after a reload')
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 4 * 45, 'nothing is deleted from the file')
})

test('benchmark rows of a model known only by a name stop counting 45 days after the run, and those of a local model pinned by its weights do not', () => {
  assert.equal(typeof profilesModule.benchmarkEvidence, 'function')
  const reg = registry()
  const claude = { id: 'claude', provider: 'claude-code' }
  const qwen = { id: 'qwen-local', provider: 'spawn', llm: { provider: 'local', model: 'qwen3-8b' } }
  const SHA = 'c'.repeat(64)
  const old = daysAgo(UNPINNED_WINDOW_DAYS + 1)
  reg.recordMany(benchEvidence(claude, 'bench-c', () => 'passed', { model: 'opus', ts: old }))
  reg.recordMany(benchEvidence(qwen, 'bench-q', () => 'passed', { model: 'qwen3-8b', modelVersion: SHA, ts: old }))
  const opus = subjectOf(claude, { modelOf: () => 'opus', priors })
  const local = subjectOf(qwen, { modelOf: () => 'qwen3-8b', versionOf: () => SHA, priors })
  assert.deepEqual([versionPinned(opus.version), versionPinned(local.version)], [false, true])
  const byName = reg.explain(opus, 'coding')
  assert.deepEqual([byName.items.length, byName.notCounted, byName.benchmark], [0, 12, null], 'opus may be another model by now')
  const pinned = reg.explain(local, 'coding')
  assert.equal(pinned.items.length, 12, 'the same weights are the same model')
  assert.ok(pinned.items.every((it) => it.decay < 1 && it.decay > 0.8), 'and its rows age on the benchmark\'s half-life')
  // Inside the window a name's rows count.
  const fresh = registry()
  fresh.recordMany(benchEvidence(claude, 'bench-d', () => 'passed', { model: 'opus', ts: daysAgo(UNPINNED_WINDOW_DAYS - 1) }))
  assert.equal(fresh.explain(opus, 'coding').items.length, 12)
})

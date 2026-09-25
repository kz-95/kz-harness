// Learning integrity (docs/laya-auto.md 6.9): a run Laya decides teaches nothing that Jev Auto
// learns from. Its samples go to a store of their own, the Jev store refuses them, the local
// classifiers' class averages never see its numbers, its runs credit no capability evidence but
// whether each attempt completed, and an accepted run never confirms a Laya pick. These are the
// invariants that hold module by module (2, 3, 6 and 8); 1, 4, 5, 7 and 9 need whole runs or
// index.js and are in laya-integration.test.js, and the verdictWeight part of 6 is router.js's.
//
// A Laya run here is the decision engine and the review with a fake Laya client, wired as the
// router and index.js wire them: the record beside the client, Laya's store as the sink, and the
// outcome domain behind a facade that decides for Laya.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReview } from '../../jev-review/index.js'
import { classProfiles, createDecisionEngine } from '../decision.js'
import { createDomainRegistry } from '../domains.js'
import { createCapabilityRegistry, evidenceFromRun, loadPriors } from '../profiles.js'
import { resolveProviders } from '../providers.js'
import { resolvePolicy } from '../routing-policy.js'
import { attachOutcomes, createTrainingStore } from '../training.js'

const PRIORS = loadPriors(fileURLToPath(new URL('../../../config/capability-priors.json', import.meta.url)))
const policy = resolvePolicy()
const { laya: LAYA } = resolveProviders({}, { policy })
const signal = new AbortController().signal
const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true, kind: 'subscription' },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true, kind: 'subscription' },
  { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, kind: 'api', llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]
const modelOf = (a) => a.llm?.model ?? (a.provider === 'claude-code' ? 'claude-opus-5' : 'gpt-5.6')
// Placed in the task, the agent's answer, the diff, a check's output, a tool's description and a
// tool option key. None of it may reach a sample.
const MARKER = 'MARKER_c41d_LAYA_TEXT'
const TOOLS = [{ id: 'fmt', description: `${MARKER} formats the code`, params: { style: { question: 'Which style?', options: { [`${MARKER}_key`]: `${MARKER} style`, plain: 'plain' } } } }]

/**
 * Laya's answers, as createJev returns them over the Laya client: the relabelled model and the
 * flat marks, and no `meta`, which createJev keeps on the trace (docs/laya-auto.md 2.3).
 */
function fakeLaya() {
  const said = { model: 'laya-english/0.3.20@1a2b3c4', uninformative: [] }
  return {
    provider: LAYA,
    route: async (args) => ({
      ...said,
      ...(args.ask?.task !== false ? {
        profile: {
          taskType: 'debugging', taskTypeConfidence: 0.7, taskTypeProbabilities: { debugging: 0.7, implementation: 0.3 }, complexity: 0.4, risk: 0.3,
          requirements: { coding: 0.8, debugging: 0.9 }, skills: { primary: 'debugging', supporting: [] }, skillConfidence: 0.6,
          minimumCapability: 'standard', preferredCapability: 'strong', verification: ['checks'], needsSecondOpinion: 0.2, needsHumanReview: 0.1, needsTests: 0.9,
        },
        handler: 'fmt', handlerConfidence: 0.2, toolFits: 0.1, toolArgConfidence: 0.9, toolArgs: { style: `${MARKER}_key` },
      } : {}),
      ...(args.candidates ? { strategy: { choice: 'STANDARD_DIRECT', confidence: 0.6, probabilities: { STANDARD_DIRECT: 0.6 } }, secondOpinion: 0.2 } : {}),
    }),
    assess: async () => ({
      ...said, verdict: 'accept', verdictConfidence: 0.6, disposition: 'PASS', dispositionConfidence: 0.6, dispositionProbabilities: { PASS: 0.6 },
      addressed: 0.95, complete: 0.95, unrelatedChanges: 0.05, regressionRisk: 0.05, needsPerson: 0.05, reviewAgent: 'codex', retryAgent: 'codex',
    }),
  }
}

/** Jev's store and Laya's store, the domain registry over Jev's, and the engine that reads both. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'kz-integrity-'))
  const store = createTrainingStore({ file: join(root, 'routing-samples.jsonl') })
  const sink = createTrainingStore({ file: join(root, 'laya-samples.jsonl'), kind: 'laya' })
  const domains = createDomainRegistry({ policy, store, artifactsDir: join(root, 'classifiers'), stateDir: join(root, 'domains') })
  const engine = createDecisionEngine({ policy, domains, profiles: createCapabilityRegistry({ priors: PRIORS, policy }), priors: PRIORS, store })
  // What index.js hands runRouted for a Laya run, so jev-review stays ignorant of stores.
  const outcome = { decide: (args) => domains.get('outcome_disposition').decide({ ...args, answeredBy: 'laya', sink }) }
  return { root, store, sink, engine, outcome, domains }
}

/**
 * One Laya-decided run: the decision, one attempt, its review, and the labels the finished run
 * gives. `client` is handed under the router's old name, `jev`, which decision.js keeps as an
 * alias, beside Laya's record: which name carries it must not matter to where the samples go.
 * Without the record, or without the facade, the run is refused (the last two tests).
 */
async function layaRun(w, { finalStatus = 'accepted' } = {}) {
  const client = fakeLaya()
  const task = `Fix the ${MARKER} parser`
  const d = await w.engine.decide({ task, context: {}, history: [], agents: AGENTS, tools: TOOLS, modelOf, jev: client, provider: LAYA, sink: w.sink, runId: 'run-laya' })
  const attempts = [{ agent: d.routing.primaryAgent, role: 'primary', stopReason: 'completed', answerText: `${MARKER} done`, changedFiles: [`${MARKER}.js`] }]
  const a = await createReview(client, LAYA.thresholds, 'x', { outcome: w.outcome })({
    task, routing: d.routing, attempts, checks: [{ name: 'test', passed: true, output: MARKER }], cmp: { regressed: [], failing: [] }, diff: { stat: MARKER, patch: MARKER },
    agents: AGENTS, blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'codex', strategy: d.plan.strategy, runId: 'run-laya',
  }, signal)
  const record = { ts: new Date().toISOString(), runId: 'run-laya', sessionId: 's', strategy: d.plan.strategy, routing: { ...d.routing, decider: 'laya' }, attempts, assessments: [a], finalStatus }
  const refs = [...d.samples, { domain: 'outcome_disposition', id: a.outcomeDomain?.sampleId, store: 'laya' }]
  const outcomes = await attachOutcomes(w.sink, record, refs)
  return { d, a, record, refs, outcomes }
}

test('invariant 2: the Jev store refuses a Laya row, and the Laya store refuses a teacher', async () => {
  const w = world()
  const features = { numeric: { complexity: 0.5 }, categorical: { task_type: 'implementation' } }
  const row = { domain: 'task_classification', input: { features }, local: null }
  await assert.rejects(() => w.store.append({ ...row, teacher: null, authority: 'laya' }), /a laya sample was refused by the jev store/)
  await assert.rejects(() => w.store.append({ ...row, teacher: { label: 'implementation', confidence: 0.9 }, authority: 'jev', provider: { id: 'laya', label: 'implementation' } }), /a laya sample was refused by the jev store/)
  await assert.rejects(() => w.sink.append({ ...row, teacher: { label: 'implementation', confidence: 0.9 }, authority: 'laya', provider: { id: 'laya', label: 'implementation' } }), /a sample with a teacher was refused by the laya store/)
  assert.equal(existsSync(join(w.root, 'routing-samples.jsonl')), false, 'nothing refused was written')
  assert.equal(existsSync(join(w.root, 'laya-samples.jsonl')), false)
})

test('invariant 3: the class averages over the Jev store are identical before and after a Laya Auto run', async () => {
  const w = world()
  // Jev has taught the store what an implementation task looks like.
  const features = { numeric: { complexity: 0.5 }, categorical: { task_type: 'implementation' } }
  for (let i = 0; i < 3; i++) {
    const s = await w.store.append({ domain: 'task_classification', input: { features }, teacher: { label: 'implementation', probabilities: { implementation: 0.9 }, confidence: 0.9, model: 'jev-1.13.0' }, local: null, authority: 'jev', extra: { profile: { complexity: 0.3 + i / 10, risk: 0.2 }, tiers: { minimum: 'standard', preferred: 'strong' } } })
    await w.store.resolveOutcome(s.id, { label: 'implementation', labelSource: 'teacher_confirmed', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  }
  const jevRows = async () => w.store.list({ domain: 'task_classification' })
  const before = classProfiles(await jevRows())
  const ids = (await w.store.list()).map((r) => r.id)
  const { refs } = await layaRun(w)
  assert.deepEqual(classProfiles(await jevRows()), before)
  assert.deepEqual((await w.store.list()).map((r) => r.id), ids, 'the Jev store gained no row')
  assert.equal(await w.engine.classProfiles().then((c) => c.implementation?.n), 3, 'and the engine reads the same three')
  // Laya's own numbers are kept under a name no class average reads, even were one handed them.
  const layaRows = await w.sink.list({ domain: 'task_classification' })
  assert.equal(layaRows.length, 1)
  assert.ok(layaRows[0].extra.providerProfile)
  assert.deepEqual(classProfiles(layaRows), {})
  assert.ok(refs.every((r) => r.store === 'laya'))
})

test('invariant 6: a Laya-decided run gives capability evidence of reliability only, and Jev Auto keeps its own local-mode review evidence', () => {
  const ts = new Date().toISOString()
  const attempts = [{ agent: 'deepseek', role: 'primary', stopReason: 'completed', model: 'deepseek-flash' }, { agent: 'claude', role: 'review', stopReason: 'completed', model: 'claude-opus-5' }]
  const laya = evidenceFromRun({ ts, runId: 'r1', routing: { taskType: 'security', decider: 'laya' }, attempts, assessments: [{ mode: 'laya', action: 'second_review' }, { mode: 'laya', action: 'accept' }], finalStatus: 'accepted' }, { agents: AGENTS, priors: PRIORS })
  assert.ok(laya.length > 0)
  assert.deepEqual([...new Set(laya.map((r) => `${r.source}/${r.dimension}`))], ['objective_deterministic/reliability'], 'whether the attempt completed, and nothing that rests on Laya')
  assert.ok(laya.every((r) => !('taskType' in r)), 'with no task type, which would be Laya\'s')
  assert.equal(laya.filter((r) => r.source === 'independent_review').length, 0, 'a mode laya assessment is never an independent review')
  // Jev Auto, reviewed by a local-mode assessment: credited as it always was.
  const jev = evidenceFromRun({ ts, runId: 'r2', routing: { taskType: 'security' }, attempts, assessments: [{ mode: 'jev', action: 'second_review' }, { mode: 'local', action: 'accept' }], finalStatus: 'accepted' }, { agents: AGENTS, priors: PRIORS })
  const review = jev.filter((r) => r.source === 'independent_review')
  assert.ok(review.length > 0 && review.every((r) => r.score === 1 && r.taskType === 'security'), 'a local-mode review in a Jev-decided run still credits independent_review')
})

test('invariant 8: an accepted run that agrees with a Laya pick yields no label, and one that contradicts it does', async () => {
  const w = world()
  const { refs, outcomes } = await layaRun(w)
  assert.ok(refs.length >= 5, `the run labels its samples (${refs.map((r) => r.domain).join(', ')})`)
  const rows = await w.sink.list()
  const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r]))
  for (const domain of ['task_classification', 'skill_selection', 'execution_strategy', 'second_opinion', 'outcome_disposition']) {
    assert.equal(byDomain[domain]?.authority, 'laya', `${domain} was Laya's pick`)
  }
  assert.deepEqual(outcomes, [], 'the accept that would confirm them came from Laya\'s own review')
  assert.ok(rows.every((r) => r.outcome === null))
  // The same picks, in a run that ended with a person: that contradicts the plan Laya chose.
  const again = world()
  const { outcomes: refuted } = await layaRun(again, { finalStatus: 'needs_human' })
  const strategy = refuted.find((o) => o.domain === 'execution_strategy')
  assert.deepEqual([strategy?.outcome.labelSource, strategy?.outcome.negativeLabel], ['verified_negative', 'STANDARD_DIRECT'])
  assert.equal((await again.sink.get(strategy.id)).outcome.labelSource, 'verified_negative', 'and it is labelled in Laya\'s store')
})

test('no text of a Laya-decided run reaches laya-samples.jsonl: task, answer, diff, check output, tool description or tool option key', async () => {
  const w = world()
  const { d, a } = await layaRun(w)
  assert.equal(d.routing.toolArgs.style, `${MARKER}_key`, 'the setting: the marker rode the run itself')
  const file = join(w.root, 'laya-samples.jsonl')
  assert.ok(existsSync(file), 'the run wrote Laya\'s store')
  const text = readFileSync(file, 'utf8')
  const rows = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(rows.length >= 7, `every domain of the run, and its review (${rows.length})`)
  assert.ok(rows.some((r) => r.id === a.outcomeDomain.sampleId))
  assert.ok(!text.includes(MARKER), 'no marker anywhere in the file')
  assert.ok(!/formats the code|parser|done/.test(text))
  assert.equal(existsSync(join(w.root, 'routing-samples.jsonl')), false, 'and nothing reached the store Jev teaches from')
  for (const r of rows) assert.deepEqual(Object.keys(r.provider ?? {}).filter((k) => !['id', 'label', 'chosenKey', 'probabilities', 'confidence', 'informative', 'model', 'identity', 'lang'].includes(k)), [], 'a provider answer is numbers, labels and names only')
})

test('a Laya client handed to the decision engine without Laya\'s record, under either name, is refused, and writes no row anywhere', async () => {
  const w = world()
  const client = fakeLaya()
  const { jev: JEV } = resolveProviders({}, { policy })
  const input = { task: `Fix the ${MARKER} parser`, context: {}, history: [], agents: AGENTS, modelOf, sink: w.sink, runId: 'run-alias' }
  for (const handed of [{ jev: client }, { decider: client }, { decider: client, provider: null }, { jev: client, provider: JEV }]) {
    await assert.rejects(() => w.engine.decide({ ...input, ...handed }), /Laya's client was handed Jev's record/, Object.keys(handed).join(' and '))
  }
  assert.equal(existsSync(join(w.root, 'routing-samples.jsonl')), false, 'nothing reached the store Jev teaches from')
  assert.equal(existsSync(join(w.root, 'laya-samples.jsonl')), false, 'nor Laya\'s: the run never started')
})

test('a Laya review handed the outcome controller itself, not the facade that decides for Laya, falls back and writes no row to the Jev store', async () => {
  const w = world()
  const attempts = [{ agent: 'deepseek', role: 'primary', stopReason: 'completed' }]
  const a = await createReview(fakeLaya(), LAYA.thresholds, 'x', { outcome: w.domains.get('outcome_disposition') })({
    task: 't', routing: { risk: 0.1 }, attempts, checks: [], cmp: { regressed: [], failing: [] }, diff: {}, agents: AGENTS,
    blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'codex', runId: 'run-raw',
  }, signal)
  assert.equal(a.mode, 'fallback')
  assert.match(a.why, /a Laya decision needs the store its sample goes to/, 'and the review says why')
  assert.equal(existsSync(join(w.root, 'routing-samples.jsonl')), false, 'Laya\'s answer never became a teacher row')
})

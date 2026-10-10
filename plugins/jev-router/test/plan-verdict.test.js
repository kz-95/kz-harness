// A verdict about the pick a start reply named (docs/live-agent-view.md Feature 4, slice 6), through
// POST /jev-router/feedback as the plugin serves it (index.js createFeedbackRoute) and the bindRun it
// is applied by as its task's run ends: stamped with the plan, bound to the task by its key, applied
// to the labels of the run its reply named the plan of, and answered with what it changed. Over real
// feedback and training stores, with the capability registry a stand-in that records its calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A namespace, so the file loads where the plugin lacks what these tests are about, and each test
// fails by its own assertion there.
import * as index from '../index.js'
import * as router from '../router.js'
import { createFeedback } from '../feedback.js'
import { createTrainingStore, labelFromRun } from '../training.js'

const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OLD_KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SESSION = 'sess-plan'
const AGENTS = [{ id: 'claude', provider: 'claude-code', enabled: true }, { id: 'codex', provider: 'codex', enabled: true }]
const NAMES = { claude: 'Claude Code', codex: 'Codex' }
const T = (min) => `2026-10-01T10:${String(min).padStart(2, '0')}:00.000Z`

const features = { numeric: { complexity: 0.5 }, categorical: { task_type: 'implementation' } }
const CANDIDATES = [{ key: 'RESOURCE_A', id: 'claude', features: { numeric: { fit: 0.8 }, categorical: { tier: 'frontier' } } }, { key: 'RESOURCE_B', id: 'codex', features: { numeric: { fit: 0.7 }, categorical: { tier: 'frontier' } } }]
/** The run a task's routing ran, as history.jsonl keeps it once it has ended. */
const runOf = (over = {}) => ({
  ts: T(20), runId: 'run-4', sessionId: SESSION, taskKey: KEY, finalStatus: 'accepted', strategy: 'STANDARD_DIRECT',
  attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed' }], assessments: [],
  routing: { taskType: 'implementation', primaryAgent: 'claude', decider: 'jev' }, ...over,
})

/**
 * The route as apply() makes it, over stores of the test's own: `records` is history.jsonl as it
 * stands (a run is on it once it has ended), `capabilities` records every call made to it, and the
 * plan a verdict is stamped with is the ledger row the test sets (`ledger`), whose `ended` says its
 * task has ended.
 */
async function harness({ ledger = {}, learn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kz-plan-verdict-'))
  const feedback = createFeedback({ file: join(dir, 'feedback.jsonl') })
  const training = createTrainingStore({ file: join(dir, 'routing-samples.jsonl') })
  const layaStore = createTrainingStore({ file: join(dir, 'laya-samples.jsonl'), kind: 'laya' })
  const calls = []
  const capabilities = { recordMany: (rows) => calls.push(['recordMany', rows]), retract: (v) => calls.push(['retract', v]), countsAs: () => false, creditedRun: () => null }
  const history = []
  const rows = { ...ledger }
  const post = index.createFeedbackRoute({
    feedback, records: async () => history, capabilities, training, layaStore, agents: async () => AGENTS, learn: () => learn,
    planOf: async (v) => { const r = rows[v.taskKey]; return r ? { jobId: r.jobId, facts: r.facts, ended: r.ended === true } : null },
    explain: async () => ({ nameOf: (id) => NAMES[id] ?? id, intentChecked: 214, ratings: { rows: await feedback.list(), resetAt: null, move: true } }),
  })
  const say = async (body) => post(JSON.stringify({ sessionId: SESSION, messageId: 'm-reply', about: 'plan', taskKey: KEY, ...body }))
  /** A sample of the run, labelled from the run alone as learnFrom labels it once the run has ended. */
  const sample = async (store, row, run) => {
    const s = await store.append(row)
    if (run) { const o = labelFromRun(row.domain, await store.get(s.id), run); if (o) await store.resolveOutcome(s.id, o) }
    return s
  }
  const outcome = async (store, id) => (await store.get(id)).outcome
  return { feedback, training, layaStore, calls, history, post, say, sample, outcome, ledger: rows }
}
const classification = (runId = 'run-4', over = {}) => ({ domain: 'task_classification', runId, input: { features }, teacher: { label: 'implementation', probabilities: { implementation: 0.9, debugging: 0.1 }, confidence: 0.9, model: 'jev-1' }, local: null, authority: 'jev', ...over })

test('a plan verdict records no capability evidence (recordMany and retract never called)', async () => {
  const h = await harness()
  h.history.push(runOf())
  for (const body of [{ verdict: 'dislike', tag: 'wrong agent', provider: 'claude', suggestedAgent: 'codex', runId: 'run-4' }, { verdict: 'like', tag: 'good pick', provider: 'claude' }, { verdict: 'clear' }]) {
    const res = await h.say(body)
    assert.equal(res.status, 200, JSON.stringify(res.body))
  }
  assert.deepEqual(h.calls, [], 'the pick is judged, not an answer')
  // The setting: a verdict about the answer of the same run is a person's evidence, as it always was.
  await h.post(JSON.stringify({ sessionId: SESSION, messageId: 'm-answer', verdict: 'like', provider: 'claude', runId: 'run-4' }))
  assert.equal(h.calls.length > 0, true)
})

test('given while the run is going it reports \'Saved. It is applied when jev-4 ends.\' and relabels nothing; bindRun at run end relabels task_classification as human negative; a second bindRun changes nothing', async () => {
  const h = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts: { planAgent: 'claude', planLevel: 'high', planEffort: 'high', planFamily: 'claude', taskType: 'implementation', runId: 'run-4' } } } })
  const run = runOf()
  const s = await h.sample(h.training, classification())
  const res = await h.say({ verdict: 'dislike', tag: 'misread my question', reason: 'I asked for a plan', provider: 'claude' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.effects, ['Saved. It is applied when jev-4 ends.'])
  assert.deepEqual([res.body.record.planAgent, res.body.record.planLevel, res.body.record.taskType, res.body.record.runId], ['claude', 'high', 'implementation', 'run-4'], 'stamped with the plan it judged')
  assert.equal(await h.outcome(h.training, s.id), null, 'nothing is labelled while the run goes on')
  // The run ends: learnFrom labels it from the run alone, then the route binds the verdict to it.
  h.history.push(run)
  await h.training.resolveOutcome(s.id, labelFromRun('task_classification', await h.training.get(s.id), run))
  assert.equal(typeof h.post.bindRun, 'function', 'the route applies a task\'s verdicts as its run ends')
  const bound = await h.post.bindRun(run)
  const o = await h.outcome(h.training, s.id)
  assert.deepEqual([o.label, o.negativeLabel, o.labelSource], [null, 'implementation', 'human'])
  assert.deepEqual(bound.map((b) => b.effects), [['Learned: this run\'s task type is marked wrong for the local classifier.']])
  assert.deepEqual(await h.post.bindRun(run), [], 'a second bindRun changes nothing')
  assert.deepEqual((await h.outcome(h.training, s.id)).labelSource, 'human')
  assert.deepEqual(h.calls, [])
})

test('binding follows taskKey, not jobId: a pre-restart verdict for jev-3 never touches the new jev-3\'s run', async () => {
  const h = await harness()
  // Before a restart, jev-3 was a task with its own key, rated as it ran and never finished.
  const old = await h.post(JSON.stringify({ sessionId: SESSION, messageId: 'm-old-reply', about: 'plan', taskKey: OLD_KEY, verdict: 'dislike', tag: 'misread my question', provider: 'claude' }))
  assert.equal(old.status, 200)
  // After it, the engine numbers jobs from 1 again: the new jev-3 is another task, which runs and ends after the verdict was given.
  const fresh = runOf({ runId: 'run-new-3', taskKey: KEY, ts: T(30) })
  const s = await h.sample(h.training, classification('run-new-3'), fresh)
  h.history.push(fresh)
  assert.equal(typeof h.post.bindRun, 'function')
  await h.post.bindRun(fresh)
  assert.equal((await h.outcome(h.training, s.id)).labelSource, 'teacher_confirmed', 'the new run keeps the label its own run gave it')
  assert.equal(index.runOfVerdict({ sessionId: SESSION, about: 'plan', taskKey: OLD_KEY, ts: T(40) }, h.history), null, 'and the old verdict is about no run, by time or otherwise')
  assert.equal(index.runOfVerdict({ sessionId: SESSION, about: 'plan', taskKey: KEY, ts: T(1) }, h.history)?.runId, 'run-new-3', 'while a verdict naming the task is about its run, given before it ended too')
})

test('a Laya-decided run is relabelled in layaStore only', async () => {
  const h = await harness()
  const run = runOf({ runId: 'run-laya', routing: { taskType: 'implementation', primaryAgent: 'claude', decider: 'laya' } })
  const laya = await h.sample(h.layaStore, classification('run-laya', { teacher: null, authority: 'laya', provider: { id: 'laya', label: 'implementation', probabilities: { implementation: 0.7, debugging: 0.3 }, confidence: 0.7, informative: true, model: 'laya-english/0.3.20@1a2b3c4', identity: 'laya-0.3.20|english|1a2b3c4d5e6f|adapter-1|corr:choice:11+=3.27|margin:0.1', lang: 'latin' } }), run)
  const jev = await h.sample(h.training, classification('run-laya'), run)
  h.history.push(run)
  const res = await h.say({ verdict: 'dislike', tag: 'wrong scope', provider: 'claude' })
  assert.match(res.body.effects?.[0] ?? '', /marked wrong for Laya's record/)
  const o = await h.outcome(h.layaStore, laya.id)
  assert.deepEqual([o.negativeLabel, o.labelSource], ['implementation', 'human'], 'Laya\'s own sample takes the person\'s label')
  assert.equal((await h.outcome(h.training, jev.id)).labelSource, 'teacher_confirmed', 'and no Jev sample of the run does')
})

test('\'should have been a question\' labels the run\'s intent sample human question', async () => {
  const h = await harness()
  const intent = await h.training.append({ domain: 'intent', input: { features }, teacher: { label: 'task', probabilities: { task: 0.8, question: 0.2 }, confidence: 0.8, model: 'jev-1' }, local: null, authority: 'jev' })
  const run = runOf({ intentSample: intent.id, attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', changedFiles: ['a.js'] }] })
  await h.training.resolveOutcome(intent.id, labelFromRun('intent', await h.training.get(intent.id), run))
  assert.equal((await h.outcome(h.training, intent.id)).label, 'task', 'the setting: the run changed a file, so its example says task')
  h.history.push(run)
  const res = await h.say({ verdict: 'dislike', tag: 'should have been a question', provider: 'claude' })
  const o = await h.outcome(h.training, intent.id)
  assert.deepEqual([o.label, o.negativeLabel, o.labelSource], ['question', 'task', 'human'])
  assert.deepEqual(res.body.effects, ['Learned: marked as a question for the task-or-question classifier (it has 214 checked examples).'])
  // A direct answer's own example is labelled by `should have been a task`, with nothing run.
  const asked = await h.training.append({ domain: 'intent', input: { features }, teacher: { label: 'question', probabilities: { task: 0.2, question: 0.8 }, confidence: 0.8, model: 'jev-1' }, local: null, authority: 'jev' })
  const answer = await h.post(JSON.stringify({ sessionId: 'sess-other', messageId: 'm-answer', verdict: 'dislike', tag: 'should have been a task', intentSample: asked.id }))
  const a = await h.outcome(h.training, asked.id)
  assert.deepEqual([a.label, a.negativeLabel, a.labelSource], ['task', 'question', 'human'])
  assert.deepEqual(answer.body.effects, ['Learned: marked as a task for the task-or-question classifier (it has 214 checked examples).'])
})

test('\'wrong agent\' with Codex labels resource_selection human and sets the session suggestion', async () => {
  const h = await harness()
  const run = runOf()
  const pick = await h.sample(h.training, { domain: 'resource_selection', runId: 'run-4', input: { features, candidates: CANDIDATES }, teacher: { chosenKey: 'RESOURCE_A', probabilities: { RESOURCE_A: 0.6, RESOURCE_B: 0.4 }, confidence: 0.6, model: 'jev-1' }, local: null, authority: 'jev' }, run)
  h.history.push(run)
  const res = await h.say({ verdict: 'dislike', tag: 'wrong agent', provider: 'claude', suggestedAgent: 'codex' })
  const o = await h.outcome(h.training, pick.id)
  assert.deepEqual([o.chosenKey, o.negativeKey, o.labelSource], ['RESOURCE_B', 'RESOURCE_A', 'human'])
  const prior = router.feedbackPrior(await h.feedback.list(SESSION), AGENTS)
  assert.equal(prior.suggestion, 'codex', 'the next task in this chat goes to Codex')
  assert.equal(prior.agents.get('claude').dislikes, 1)
  assert.deepEqual(res.body.effects, ['Learned: the next task in this chat goes to Codex unless you pick one, and this run\'s pick is labelled for the local router.'])
})

test('\'wrong agent\' given before routing picked anything, on a reply that named no agent, is stamped with the plan as its run ends and votes on the agent that ran; a second bindRun stamps nothing again', async () => {
  // The task waits in its folder's line: the ledger has its reply's row, and routing has noted no plan on it.
  const h = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts: {} } } })
  const res = await h.say({ verdict: 'dislike', tag: 'wrong agent' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal('planAgent' in res.body.record, false, 'there is no plan to stamp it with yet')
  assert.equal(router.feedbackPrior(await h.feedback.list(SESSION), AGENTS).agents.get('claude'), undefined, 'so it votes on no agent')
  // Routing picks Claude Code, and the run ends.
  h.ledger[KEY] = { jobId: 'jev-4', facts: { planAgent: 'claude', planLevel: 'high', planEffort: 'high', planFamily: 'claude', taskType: 'implementation', runId: 'run-4' } }
  h.history.push(runOf())
  await h.post.bindRun(runOf())
  const [row] = await h.feedback.list(SESSION)
  assert.deepEqual([row.ts, row.verdict, row.tag, row.planAgent, row.planLevel, row.planFamily, row.taskType], [res.body.record.ts, 'dislike', 'wrong agent', 'claude', 'high', 'claude', 'implementation'], 'the same verdict, dated as it was given, with the plan it judged')
  assert.equal(row.runId, undefined, 'and about its task\'s run by the task\'s key, as it was given')
  assert.equal(router.feedbackPrior(await h.feedback.list(SESSION), AGENTS).agents.get('claude')?.dislikes, 1, 'and it votes on the agent that ran')
  const forms = (await h.feedback.history(SESSION)).length
  await h.post.bindRun(runOf())
  assert.equal((await h.feedback.history(SESSION)).length, forms, 'a verdict with its plan on it is not stamped again')
})

test('effects words match what changed', async () => {
  const stamp = { planAgent: 'codex', planLevel: 'high', planEffort: 'high', planFamily: 'codex', taskType: 'documentation' }
  const h = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts: stamp } } })
  const run = runOf({ routing: { taskType: 'documentation', primaryAgent: 'codex', decider: 'jev' }, attempts: [{ agent: 'codex', role: 'primary', stopReason: 'completed' }] })
  const kind = await h.sample(h.training, classification('run-4', { teacher: { label: 'documentation', probabilities: { documentation: 0.9 }, confidence: 0.9, model: 'jev-1' } }), run)
  h.history.push(run)
  // A good pick confirms the run's pick, now that the run has ended.
  assert.deepEqual((await h.say({ verdict: 'like', tag: 'good pick', provider: 'codex' })).body.effects, ['Learned: this run\'s pick is confirmed for the local router.'])
  assert.equal((await h.outcome(h.training, kind.id)).labelSource, 'human')
  // Three ratings that the effort was too high, on three replies: two say how far they have come, the third that Auto moved.
  const effortSaid = []
  for (const m of ['m-1', 'm-2', 'm-3']) {
    const res = await h.post(JSON.stringify({ sessionId: SESSION, messageId: m, about: 'plan', taskKey: KEY, verdict: 'dislike', tag: 'wrong effort', suggestedEffort: 'medium', provider: 'codex' }))
    effortSaid.push(res.body.effects?.[0])
  }
  assert.deepEqual(effortSaid, [
    'Learned: 1 of 3 "effort too high" ratings for Codex on doc edits; at 3, Auto effort there drops one step.',
    'Learned: 2 of 3 "effort too high" ratings for Codex on doc edits; at 3, Auto effort there drops one step.',
    'Learned: Auto effort for Codex on doc edits now runs one step lower (Settings, Effort to reset).',
  ])
  // Nothing to learn from is said to be saved, and nothing more; a clear has no line.
  assert.deepEqual((await h.say({ messageId: 'm-plain', verdict: 'like', provider: 'codex' })).body.effects, ['Saved.'])
  assert.deepEqual((await h.say({ messageId: 'm-plain', verdict: 'clear' })).body.effects, [])
  // A rating of the pick whose labels wait for the run says so, with the job, before the run has ended.
  const waiting = await harness({ ledger: { [KEY]: { jobId: 'jev-7', facts: stamp } } })
  assert.deepEqual((await waiting.say({ verdict: 'dislike', tag: 'wrong agent', provider: 'codex', suggestedAgent: 'claude' })).body.effects,
    ['Learned: the next task in this chat goes to Claude Code unless you pick one. The rest is applied when jev-7 ends.'])
  // With learning off nothing new is learnt, and the line says so.
  const off = await harness({ learn: false })
  assert.deepEqual((await off.say({ verdict: 'like', tag: 'good pick', provider: 'codex' })).body.effects, ['Saved. Learning is off, so nothing is learned from it.'])
})

/** The run's pick between the two candidates, as the decision engine records it. */
const selection = (runId = 'run-4') => ({ domain: 'resource_selection', runId, input: { features, candidates: CANDIDATES }, teacher: { chosenKey: 'RESOURCE_A', probabilities: { RESOURCE_A: 0.6, RESOURCE_B: 0.4 }, confidence: 0.6, model: 'jev-1' }, local: null, authority: 'jev' })
/** The message's intent example, with Jev's answer as the teacher's. */
const intentOf = (label) => ({ domain: 'intent', input: { features }, teacher: { label, probabilities: label === 'task' ? { task: 0.8, question: 0.2 } : { task: 0.2, question: 0.8 }, confidence: 0.8, model: 'jev-1' }, local: null, authority: 'jev' })

test('a clear of a verdict about the pick takes back what it labelled on the run its last form named, though a newer run of the chat has ended since', async () => {
  const h = await harness()
  const intent = await h.training.append(intentOf('task'))
  const run = runOf({ intentSample: intent.id, attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', changedFiles: ['a.js'] }] })
  await h.training.resolveOutcome(intent.id, labelFromRun('intent', await h.training.get(intent.id), run))
  const kind = await h.sample(h.training, classification(), run)
  const pick = await h.sample(h.training, selection(), run)
  // Another task of the chat runs and ends after it.
  const later = runOf({ ts: T(30), runId: 'run-5', taskKey: OLD_KEY })
  const other = await h.sample(h.training, classification('run-5'), later)
  h.history.push(run, later)
  const labels = async () => {
    const [i, k, p] = await Promise.all([intent.id, kind.id, pick.id].map((id) => h.outcome(h.training, id)))
    return [i?.label, i?.labelSource, k?.label, k?.labelSource, p?.chosenKey, p?.negativeKey ?? null, p?.labelSource]
  }
  const own = await labels()
  assert.deepEqual(own, ['task', 'verified_outcome', 'implementation', 'teacher_confirmed', 'RESOURCE_A', null, 'teacher_confirmed'], 'the setting: each labelled from the run alone')
  for (const body of [{ tag: 'wrong agent', suggestedAgent: 'codex' }, { tag: 'misread my question' }, { tag: 'should have been a question' }]) {
    await h.say({ verdict: 'dislike', provider: 'claude', ...body })
    assert.notDeepEqual(await labels(), own, `'${body.tag}' labels the run`)
    // The clear carries only its keys: what it takes back is about the run its last form named.
    const res = await h.say({ verdict: 'clear' })
    assert.equal(res.status, 200)
    assert.deepEqual(await labels(), own, `the clear of '${body.tag}' gives the run its own labels back`)
  }
  assert.equal((await h.outcome(h.training, other.id)).labelSource, 'teacher_confirmed', 'and the newer run was never touched')
})

test('a verdict about the pick given while its run went, applied as the run ended, is taken back by its clear', async () => {
  const h = await harness()
  const s = await h.training.append(classification())
  const res = await h.say({ verdict: 'dislike', tag: 'misread my question', provider: 'claude' })
  assert.equal(res.status, 200)
  // The run ends after the verdict was given: learnFrom labels it from the run alone, then the route binds the verdict.
  const run = runOf({ ts: new Date(Date.parse(res.body.record.ts) + 60_000).toISOString() })
  h.history.push(run)
  await h.training.resolveOutcome(s.id, labelFromRun('task_classification', await h.training.get(s.id), run))
  assert.equal(typeof h.post.bindRun, 'function', 'the route applies a task\'s verdicts as its run ends')
  await h.post.bindRun(run)
  assert.equal((await h.outcome(h.training, s.id)).labelSource, 'human')
  // The clear is dated by the verdict's first form, given before the run ended: no run had ended then.
  assert.equal((await h.say({ verdict: 'clear' })).status, 200)
  const o = await h.outcome(h.training, s.id)
  assert.deepEqual([o.label, o.labelSource], ['implementation', 'teacher_confirmed'], 'the run\'s own label is back')
})

test('a clear takes back the label a verdict about the pick gave a run that gives none of its own, a stopped one', async () => {
  const h = await harness()
  const stopped = runOf({ finalStatus: 'stopped', statusReason: 'stopped by the user' })
  const s = await h.sample(h.training, classification(), stopped)
  assert.equal(await h.outcome(h.training, s.id), null, 'the setting: a stopped run labels nothing')
  h.history.push(stopped)
  await h.say({ verdict: 'dislike', tag: 'misread my question', provider: 'claude' })
  assert.equal((await h.outcome(h.training, s.id))?.labelSource, 'human', 'the person\'s word labels it')
  assert.equal((await h.say({ verdict: 'clear' })).status, 200)
  assert.equal(await h.outcome(h.training, s.id), null, 'and the clear leaves it unlabelled, as the run left it')
})

test('a direct answer\'s \'should have been a task\' is taken back by its clear, and by a change to a verdict that says nothing of what the message was', async () => {
  const h = await harness()
  const asked = await h.training.append(intentOf('question'))
  const answer = (body) => h.post(JSON.stringify({ sessionId: 'sess-other', messageId: 'm-answer', intentSample: asked.id, ...body }))
  await answer({ verdict: 'dislike', tag: 'should have been a task' })
  assert.equal((await h.outcome(h.training, asked.id))?.label, 'task', 'the setting: the person\'s word labels the example')
  // The clear carries only its keys: the example is the one its last form named.
  assert.equal((await h.post(JSON.stringify({ sessionId: 'sess-other', messageId: 'm-answer', verdict: 'clear' }))).status, 200)
  assert.equal(await h.outcome(h.training, asked.id), null, 'nothing ran, so no label is left')
  await answer({ verdict: 'dislike', tag: 'should have been a task' })
  assert.equal((await h.outcome(h.training, asked.id))?.label, 'task')
  await answer({ verdict: 'dislike', tag: 'not enough detail' })
  assert.equal(await h.outcome(h.training, asked.id), null, 'a dislike of the detail says nothing of what the message was')
  await answer({ verdict: 'like' })
  const o = await h.outcome(h.training, asked.id)
  assert.deepEqual([o?.label, o?.labelSource], ['question', 'human'], 'a Like says it was a question')
})

test('a verdict naming its task is about the earliest run of that task in its chat, the one its reply named: a read pass handed back before the pass that writes', async () => {
  const h = await harness()
  // Given while the task went on, so it waits for the task's run; nothing stamped it with a run.
  assert.equal((await h.say({ verdict: 'dislike', tag: 'misread my question', provider: 'claude' })).status, 200)
  const reader = runOf({ ts: T(10), runId: 'run-read', finalStatus: 'needs_write' })
  const writer = runOf({ ts: T(20), runId: 'run-write' })
  const read = await h.sample(h.training, classification('run-read'), reader)
  const write = await h.sample(h.training, classification('run-write'), writer)
  // The earliest by when each ended, whichever history.jsonl lists first.
  for (const order of [[reader, writer], [writer, reader]]) {
    assert.equal(index.runOfVerdict({ sessionId: SESSION, about: 'plan', taskKey: KEY, ts: T(40) }, order)?.runId, 'run-read', `listed ${order.map((x) => x.runId).join(', ')}`)
    assert.equal(index.runOfVerdict({ sessionId: SESSION, about: 'plan', taskKey: KEY, runId: 'run-write', ts: T(40) }, order)?.runId, 'run-write', 'while a verdict stamped with its run finds that run')
  }
  h.history.push(reader, writer)
  // The pass that writes ends, and the route binds the verdict: to the pass the reply named.
  assert.equal(typeof h.post.bindRun, 'function', 'the route applies a task\'s verdicts as its run ends')
  await h.post.bindRun(writer)
  const [r, w] = [await h.outcome(h.training, read.id), await h.outcome(h.training, write.id)]
  assert.deepEqual([r?.negativeLabel, r?.labelSource], ['implementation', 'human'], 'the read pass takes the person\'s label')
  assert.equal(w.labelSource, 'teacher_confirmed', 'and the pass that writes keeps its own')
})

test('a suggestion bound at its run\'s end is not said to send the chat\'s next task, which it did as it was given', async () => {
  const h = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts: { planAgent: 'claude', planLevel: 'high', planEffort: 'high', planFamily: 'claude', taskType: 'implementation', runId: 'run-4' } } } })
  const given = await h.say({ verdict: 'dislike', tag: 'wrong agent', provider: 'claude', suggestedAgent: 'codex' })
  assert.deepEqual(given.body.effects, ['Learned: the next task in this chat goes to Codex unless you pick one. The rest is applied when jev-4 ends.'])
  const run = runOf()
  const pick = await h.sample(h.training, selection(), run)
  h.history.push(run)
  assert.equal(typeof h.post.bindRun, 'function', 'the route applies a task\'s verdicts as its run ends')
  const bound = await h.post.bindRun(run)
  assert.equal((await h.outcome(h.training, pick.id)).labelSource, 'human')
  assert.deepEqual(bound.map((b) => b.effects), [['Learned: this run\'s pick is labelled for the local router.']], 'by then a newer task may have gone elsewhere')
})

test('a verdict about the pick told its labels wait for its task\'s run is told there is none to apply them to once the task ends with no run on record (noRun), and one given after it ended is told so at once; a task with a run on record is left to bindRun', async () => {
  const facts = { planAgent: 'claude', planLevel: 'high', planEffort: 'high', planFamily: 'claude', taskType: 'implementation', runId: 'run-4' }
  const h = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts } } })
  const given = await h.say({ verdict: 'dislike', tag: 'wrong agent', provider: 'claude', suggestedAgent: 'codex' })
  assert.deepEqual(given.body.effects, ['Learned: the next task in this chat goes to Codex unless you pick one. The rest is applied when jev-4 ends.'])
  // Its task fails, or a restart stops it, before routing wrote its row.
  assert.equal(typeof h.post.noRun, 'function', 'the route tells a task\'s verdicts that no run of it is on record')
  const told = await h.post.noRun({ taskKey: KEY, sessionId: SESSION })
  assert.deepEqual(told.map((b) => [b.record.messageId, b.effects]), [['m-reply', ['Saved. The task ended with no run on record to apply it to.']]], 'by then a newer task may have gone elsewhere')
  h.ledger[KEY] = { jobId: 'jev-4', facts, ended: true }
  const after = await h.say({ messageId: 'm-later', verdict: 'dislike', tag: 'wrong agent', provider: 'claude', suggestedAgent: 'codex' })
  assert.deepEqual(after.body.effects, ['Learned: the next task in this chat goes to Codex unless you pick one. The task ended with no run on record to apply the rest to.'])
  // A task with a run on record is bindRun's, whatever its verdicts said.
  h.history.push(runOf())
  assert.deepEqual(await h.post.noRun({ taskKey: KEY, sessionId: SESSION }), [])
  // One given with learning off was told nothing waits, so nothing is told again.
  const off = await harness({ ledger: { [KEY]: { jobId: 'jev-4', facts } }, learn: false })
  assert.deepEqual((await off.say({ verdict: 'dislike', tag: 'wrong agent', provider: 'claude' })).body.effects, ['Saved. Learning is off, so nothing is learned from it.'])
  assert.deepEqual(await off.post.noRun({ taskKey: KEY, sessionId: SESSION }), [])
})

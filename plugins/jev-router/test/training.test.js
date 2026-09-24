// The training store and the run-to-label rules: append and join, the shadow comparison,
// which outcome a finished run justifies per domain, the refusal to guess or to store text, and
// the cap that keeps the file from growing for ever without starving the maturity gates.
// Every row is a fixture; no real task text is anywhere near this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDomainController, splitRows } from '../domains.js'
import { FEATURE_SCHEMA_VERSION } from '../features.js'
import { resolvePolicy } from '../routing-policy.js'
import { AUTHORITIES, LABEL_SOURCES, OUTCOME_BACKED, attachOutcomes, createTrainingStore, labelFromRun, samplesCap } from '../training.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'kz-training-')), 'routing-samples.jsonl')
/** A clock that ticks one second per call, so rows order deterministically. */
const clock = () => { let t = Date.parse('2026-09-21T00:00:00.000Z'); return () => new Date((t += 1000)).toISOString() }
const features = (over = {}) => ({ numeric: { complexity: 0.5, risk: 0.4, ...over }, categorical: { task_type: 'implementation' } })
const candidate = (key, id, tier = 'strong') => ({ key, id, features: { numeric: { fit: 0.8 }, categorical: { source: 'api', tier } } })
const CANDIDATES = [candidate('RESOURCE_A', 'claude', 'frontier'), candidate('RESOURCE_B', 'codex', 'frontier'), candidate('RESOURCE_C', 'deepseek', 'standard')]
const sample = (over = {}) => ({
  runId: 'run-1',
  domain: 'task_classification',
  input: { features: features() },
  teacher: { label: 'implementation', probabilities: { implementation: 0.9, debugging: 0.1 }, confidence: 0.9, model: 'jev-1' },
  local: null,
  authority: 'jev',
  ...over,
})
const resourceSample = (chosenKey = 'RESOURCE_C', over = {}) => sample({
  domain: 'resource_selection',
  input: { features: features(), candidates: CANDIDATES },
  teacher: { chosenKey, probabilities: { RESOURCE_A: 0.2, RESOURCE_B: 0.2, RESOURCE_C: 0.6 }, confidence: 0.6, model: 'jev-1' },
  ...over,
})
const attempt = (agent, role = 'primary', over = {}) => ({ agent, role, stopReason: 'completed', ...over })
// `ts` is when the run ended, which is what a session verdict is timed against.
const RUN_END = '2026-09-21T01:00:00.000Z'
const AFTER = '2026-09-21T01:00:30.000Z'
const record = (over = {}) => ({ runId: 'run-1', sessionId: 'sess-1', ts: RUN_END, finalStatus: 'accepted', strategy: 'STANDARD_DIRECT', attempts: [attempt('deepseek')], assessments: [], ...over })

test('constants: the label sources, the outcome-backed subset and the authorities', () => {
  assert.deepEqual([...LABEL_SOURCES], ['verified_outcome', 'human', 'teacher_confirmed', 'verified_negative'])
  for (const s of OUTCOME_BACKED) assert.ok(LABEL_SOURCES.includes(s), `${s} is a label source`)
  assert.equal(OUTCOME_BACKED.includes('verified_negative'), false, 'a negative alone does not back a label')
  assert.deepEqual([...AUTHORITIES], ['jev', 'local', 'code', 'deterministic', 'fallback'])
})

test('append stamps an id, the time and the feature schema version', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  const row = await store.append(sample())
  assert.equal(typeof row.id, 'string')
  assert.ok(row.id.length > 0, 'an id was assigned')
  assert.equal(row.ts, '2026-09-21T00:00:01.000Z')
  assert.equal(row.featureSchemaVersion, FEATURE_SCHEMA_VERSION)
  assert.equal(row.outcome, null)
  const kept = await store.append(sample({ id: 'given-id', featureSchemaVersion: 999 }))
  assert.equal(kept.id, 'given-id', 'a caller id is kept')
  assert.equal(kept.featureSchemaVersion, FEATURE_SCHEMA_VERSION, 'the store stamps the schema version, the caller cannot')
  const listed = await store.list()
  assert.deepEqual(listed.map((r) => r.id), [row.id, 'given-id'])
})

test('append rejects a sample with no domain or no features', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  await assert.rejects(() => store.append(sample({ domain: undefined })), /domain/)
  await assert.rejects(() => store.append(sample({ input: {} })), /input\.features/)
  await assert.rejects(() => store.append(null), /an object/)
  await assert.rejects(() => store.append(sample({ input: { features: { numeric: { complexity: Number.NaN }, categorical: {} } } })), /complexity/, 'features.js validates the vector, this file does not restate the rule')
  const badCandidate = { key: 'RESOURCE_A', id: 'claude', features: { numeric: {}, categorical: { tier: 3 } } }
  await assert.rejects(() => store.append(resourceSample('RESOURCE_A', { input: { features: features(), candidates: [badCandidate] } })), /tier/, 'a candidate vector is validated too')
})

test('scenario P: a sample stores both predictions and stats compares them', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  const local = (label, ood = false) => ({ label, probabilities: { [label]: 0.8 }, confidence: 0.8, artifactVersion: 'task_classification@1', ood })
  await store.append(sample({ local: local('implementation') }))
  await store.append(sample({ local: local('debugging') }))
  await store.append(sample({ local: local('implementation') }))
  await store.append(sample({ local: null }))
  const row = (await store.list())[0]
  assert.equal(row.teacher.label, 'implementation')
  assert.equal(row.local.label, 'implementation')
  const s = await store.stats('task_classification')
  assert.deepEqual(s.localAgreement, { n: 3, agree: 2 }, 'only rows with both answers are compared')
  assert.equal(s.total, 4)
})

test('scenario Q: Jev chose C, C failed, A succeeded: the label is A and C is the negative', () => {
  const run = record({ attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('claude', 'retry')] })
  const out = labelFromRun('resource_selection', resourceSample('RESOURCE_C'), run)
  assert.equal(out.chosenKey, 'RESOURCE_A')
  assert.equal(out.labelSource, 'verified_outcome')
  assert.equal(out.negativeKey, 'RESOURCE_C')
  assert.equal(out.verified, true)
  assert.deepEqual(out.details, { finalStatus: 'accepted', attempts: 2, escalated: true })
})

test('resource selection: teacher_confirmed when the pick did the accepted work', () => {
  const out = labelFromRun('resource_selection', resourceSample('RESOURCE_C'), record())
  assert.deepEqual(out, { chosenKey: 'RESOURCE_C', labelSource: 'teacher_confirmed', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  const reviewed = record({ attempts: [attempt('deepseek'), attempt('claude', 'review')] })
  assert.equal(labelFromRun('resource_selection', resourceSample('RESOURCE_C'), reviewed).labelSource, 'teacher_confirmed', 'a review after the work does not unseat the pick')
})

test('resource selection: verified_negative when nothing worked', () => {
  const human = record({ finalStatus: 'needs_human', attempts: [attempt('deepseek', 'primary', { stopReason: 'error' })] })
  assert.deepEqual(labelFromRun('resource_selection', resourceSample('RESOURCE_C'), human), { chosenKey: null, negativeKey: 'RESOURCE_C', labelSource: 'verified_negative', verified: true, details: { finalStatus: 'needs_human', attempts: 1, escalated: true } })
  const limit = record({ finalStatus: 'limit_reached', attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('deepseek', 'retry', { stopReason: 'error' })] })
  assert.equal(labelFromRun('resource_selection', resourceSample('RESOURCE_C'), limit).labelSource, 'verified_negative')
  assert.equal(labelFromRun('resource_selection', resourceSample('RESOURCE_C'), limit).chosenKey, null)
})

test('resource selection: no outcome for paused_limit, stopped or a handoff continuation', () => {
  const s = resourceSample('RESOURCE_C')
  // Each of these runs would label if the status were read before the no-evidence check: the
  // first two would file a verified negative against the pick, the third would confirm it.
  const failed = [attempt('deepseek', 'primary', { stopReason: 'error' })]
  assert.equal(labelFromRun('resource_selection', s, record({ finalStatus: 'paused_limit', attempts: failed })), null)
  assert.equal(labelFromRun('resource_selection', s, record({ finalStatus: 'stopped', attempts: failed })), null)
  assert.equal(labelFromRun('resource_selection', s, record({ continuedFromHandoff: true })), null)
  assert.equal(labelFromRun('resource_selection', s, record({ attempts: [attempt('deepseek', 'primary', { limitHit: true })] })), null, 'a limit-hit attempt is not work')
  // The status is the reason, not the shape of the run: the same attempts under an ordinary
  // status do produce a label, so the three nulls above are the guard and nothing else.
  assert.equal(labelFromRun('resource_selection', s, record({ finalStatus: 'needs_human', attempts: failed })).labelSource, 'verified_negative')
  assert.equal(labelFromRun('resource_selection', s, record()).labelSource, 'teacher_confirmed')
})

test('resource selection: a run that goes as planned never confirms the local classifier to itself', () => {
  // The pick was the classifier's own, so "it worked" is it agreeing with itself. Training on that
  // closes the loop, and the label would name a teacher nobody asked.
  const s = resourceSample('RESOURCE_C', { authority: 'local', teacher: null, local: { chosenKey: 'RESOURCE_A', probabilities: { RESOURCE_A: 0.97 }, confidence: 0.97, artifactVersion: 'resource_selection@1', ood: false } })
  assert.equal(labelFromRun('resource_selection', s, record({ attempts: [attempt('claude')] })), null)
  // Evidence that contradicts it is real either way: a rescue still names the rescuer.
  const rescued = labelFromRun('resource_selection', s, record({ attempts: [attempt('claude'), attempt('codex')] }))
  assert.deepEqual([rescued.chosenKey, rescued.negativeKey, rescued.labelSource], ['RESOURCE_B', 'RESOURCE_A', 'verified_outcome'])
  assert.equal(labelFromRun('resource_selection', resourceSample('RESOURCE_C', { teacher: null }), record()), null, 'no pick at all is no evidence')
  // A local answer recorded beside a decision something else made is shadow data. It never ran,
  // so the run can neither confirm nor contradict it.
  const localAnswer = { chosenKey: 'RESOURCE_A', probabilities: { RESOURCE_A: 0.9 }, confidence: 0.9, artifactVersion: 'resource_selection@1', ood: false }
  const shadow = resourceSample('RESOURCE_C', { authority: 'fallback', teacher: null, local: localAnswer })
  assert.equal(labelFromRun('resource_selection', shadow, record({ attempts: [attempt('claude')] })), null, 'the fallback picked, not the local classifier')
  const shadowTask = sample({ authority: 'fallback', teacher: null, local: { label: 'debugging', probabilities: { debugging: 0.9 }, confidence: 0.9, artifactVersion: 'task_classification@1', ood: false } })
  assert.equal(labelFromRun('task_classification', shadowTask, record()), null, 'an accepted run confirms the classification that ran, not the shadow one')
})

test('classification: feedback tags outrank the run, an accepted run confirms, the rest is nothing', () => {
  const s = sample()
  const misread = [{ ts: AFTER, sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', tag: 'misread my question' }]
  assert.deepEqual(labelFromRun('task_classification', s, record(), { feedback: misread }), { label: null, negativeLabel: 'implementation', labelSource: 'human', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  const scope = [{ runId: 'run-1', sessionId: 'other', messageId: 'm1', verdict: 'dislike', tag: 'wrong scope' }]
  assert.equal(labelFromRun('skill_selection', sample({ domain: 'skill_selection' }), record(), { feedback: scope }).labelSource, 'human', 'matched by runId')
  // Only the routing tag counts: a plain thumbs-up is about the answer, not about who was picked.
  const good = [{ ts: AFTER, sessionId: 'sess-1', messageId: 'm1', verdict: 'like', tag: 'good pick' }]
  assert.deepEqual(labelFromRun('task_classification', s, record({ finalStatus: 'needs_human' }), { feedback: good }).label, 'implementation', 'a good-pick tag confirms even when the run stalled')
  const like = [{ ts: AFTER, sessionId: 'sess-1', messageId: 'm1', verdict: 'like' }]
  assert.equal(labelFromRun('task_classification', s, record({ finalStatus: 'needs_human' }), { feedback: like }), null, 'a bare like says nothing about the routing')
  const otherRun = [{ runId: 'run-9', sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', tag: 'misread my question' }]
  assert.equal(labelFromRun('task_classification', s, record(), { feedback: otherRun }).labelSource, 'teacher_confirmed', 'feedback on another run of the session is ignored')
  const otherAgent = [{ ts: AFTER, sessionId: 'sess-1', messageId: 'm1', verdict: 'dislike', tag: 'wrong scope', provider: 'codex' }]
  assert.equal(labelFromRun('task_classification', s, record(), { feedback: otherAgent }).labelSource, 'teacher_confirmed', 'a verdict naming another agent is about another answer')
  assert.equal(labelFromRun('task_classification', s, record()).labelSource, 'teacher_confirmed')
  assert.equal(labelFromRun('task_classification', s, record({ finalStatus: 'needs_human' })), null)
  assert.equal(labelFromRun('task_classification', s, record({ finalStatus: 'paused_limit' })), null)
  assert.equal(labelFromRun('task_classification', s, record({ finalStatus: 'paused_limit' }), { feedback: misread }).labelSource, 'human', 'a person saying the question was misread is evidence whatever the run did next')
  assert.equal(labelFromRun('task_classification', s, record({ finalStatus: 'accepted', continuedFromHandoff: true })), null)
})

test('strategy domains: confirmed, rescued, or negative', () => {
  const strat = sample({ domain: 'execution_strategy', input: { features: features(), candidates: CANDIDATES }, teacher: { label: 'CHEAP_DIRECT', probabilities: { CHEAP_DIRECT: 0.7 }, confidence: 0.7, model: 'jev-1' } })
  assert.equal(labelFromRun('execution_strategy', strat, record({ strategy: 'CHEAP_DIRECT' })).labelSource, 'teacher_confirmed')
  const reviewRescue = record({ strategy: 'CHEAP_DIRECT', attempts: [attempt('deepseek'), attempt('claude', 'review')] })
  assert.deepEqual(labelFromRun('execution_strategy', strat, reviewRescue), { label: 'CHEAP_EXECUTE_FRONTIER_REVIEW', negativeLabel: 'CHEAP_DIRECT', labelSource: 'verified_outcome', verified: true, details: { finalStatus: 'accepted', attempts: 2, escalated: true } })
  const retryRescue = record({ strategy: 'CHEAP_DIRECT', attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('codex', 'retry')] })
  assert.equal(labelFromRun('execution_strategy', strat, retryRescue).label, 'RETRY_DIFFERENT_RESOURCE')
  const sameTier = record({ strategy: 'PREMIUM_DIRECT', attempts: [attempt('claude', 'primary', { stopReason: 'error' }), attempt('codex', 'retry')] })
  assert.equal(labelFromRun('execution_strategy', strat, sameTier).labelSource, 'teacher_confirmed', 'a peer of the same tier is not an escalation')
  const planned = record({ strategy: 'CHEAP_THEN_PREMIUM_REVIEW', attempts: [attempt('deepseek'), attempt('claude', 'review')] })
  assert.equal(labelFromRun('execution_strategy', strat, planned).labelSource, 'teacher_confirmed', 'a review the strategy planned is not a rescue')
  assert.deepEqual(labelFromRun('execution_strategy', strat, record({ finalStatus: 'needs_human' })).labelSource, 'verified_negative')
  assert.equal(labelFromRun('execution_strategy', strat, record({ finalStatus: 'needs_human' })).negativeLabel, 'CHEAP_DIRECT')
  assert.equal(labelFromRun('execution_strategy', strat, record({ finalStatus: 'paused_limit' })), null)
  assert.equal(labelFromRun('execution_strategy', strat, record({ continuedFromHandoff: true })), null, 'an accepted handoff continuation confirms no strategy')
  const unknownTier = record({ strategy: 'CHEAP_DIRECT', attempts: [attempt('deepseek'), attempt('mystery', 'review')] })
  assert.equal(labelFromRun('execution_strategy', strat, unknownTier).labelSource, 'teacher_confirmed', 'a reviewer outside the candidate table has no known tier and is no escalation')
  // The yes/no domains: a rescue means the answer should have been yes.
  const yesno = (label, domain) => sample({ domain, input: { features: features(), candidates: CANDIDATES }, teacher: { label, probabilities: { yes: 0.3, no: 0.7 }, confidence: 0.7, model: 'jev-1' } })
  assert.deepEqual([labelFromRun('frontier_escalation', yesno('no', 'frontier_escalation'), reviewRescue).label, labelFromRun('frontier_escalation', yesno('no', 'frontier_escalation'), reviewRescue).labelSource], ['yes', 'verified_outcome'])
  assert.equal(labelFromRun('second_opinion', yesno('yes', 'second_opinion'), reviewRescue).labelSource, 'teacher_confirmed')
  // Conservation is a hard limit now, not a domain: a sample an older version left in the store is
  // labelled by nothing, whatever the run did.
  assert.equal(labelFromRun('conservation', yesno('no', 'conservation'), record()), null)
})

test('outcome disposition: what the run needed after the decided attempt', () => {
  const disp = (label, decidedAt = 0) => sample({ domain: 'outcome_disposition', teacher: { label, probabilities: { [label]: 0.9 }, confidence: 0.9, model: 'jev-1' }, extra: { decidedAt } })
  assert.deepEqual(labelFromRun('outcome_disposition', disp('PASS'), record()), { label: 'PASS', labelSource: 'teacher_confirmed', verified: true, details: { finalStatus: 'accepted', attempts: 1, escalated: false } })
  const retried = record({ attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('deepseek', 'retry')] })
  assert.deepEqual([labelFromRun('outcome_disposition', disp('PASS'), retried).label, labelFromRun('outcome_disposition', disp('PASS'), retried).labelSource], ['RETRY_SAME_TIER', 'verified_outcome'])
  const other = record({ attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('claude', 'retry')] })
  assert.equal(labelFromRun('outcome_disposition', disp('RETRY_DIFFERENT_RESOURCE'), other).labelSource, 'teacher_confirmed')
  assert.equal(labelFromRun('outcome_disposition', disp('PASS', 1), other).label, 'PASS', 'decided on the retry, which was accepted')
  assert.equal(labelFromRun('outcome_disposition', disp('PASS'), record({ finalStatus: 'needs_human' })).label, 'HUMAN')
  assert.equal(labelFromRun('outcome_disposition', disp('PASS', 5), record()), null, 'an attempt index the run never reached is no evidence')
  assert.equal(labelFromRun('outcome_disposition', sample({ domain: 'outcome_disposition' }), record()), null, 'no decidedAt is no evidence')
  assert.equal(labelFromRun('outcome_disposition', disp('PASS'), record({ finalStatus: 'stopped' })), null)
  assert.equal(labelFromRun('outcome_disposition', disp('PASS'), record({ continuedFromHandoff: true })), null, 'an accepted handoff continuation proves no disposition')
})

test('labelFromRun: an unknown domain or a missing record is null, never a throw', () => {
  assert.equal(labelFromRun('nope', sample(), record()), null)
  assert.equal(labelFromRun('task_classification', sample(), null), null)
  assert.equal(labelFromRun('task_classification', null, record()), null)
})

test('the store never contains task text', async () => {
  const file = tmp()
  const store = createTrainingStore({ file, now: clock() })
  const marker = 'MARKER_ZEBRA_PROMPT_9f1c'
  const task = `Please fix the login bug ${marker} in auth.js`
  // What decision.js hands over is built from the task, never the task: only shape numbers reach the row.
  const row = await store.append(sample({ input: { features: { numeric: { text_length_log: Math.log1p(task.length) }, categorical: { modality: 'text' } } } }))
  await store.resolveOutcome(row.id, labelFromRun('task_classification', row, record({ task, attempts: [attempt('deepseek', 'primary', { answerExcerpt: `done: ${marker}` })] })))
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(marker), false, 'neither the task nor the answer reached the file')
  assert.equal(raw.includes('auth.js'), false)
})

test('list joins the newest outcome and filters by domain, verification and time', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  const a = await store.append(sample({ id: 'a' }))
  await store.append(sample({ id: 'b', domain: 'skill_selection' }))
  const c = await store.append(sample({ id: 'c' }))
  await store.resolveOutcome(a.id, { label: 'implementation', labelSource: 'teacher_confirmed', verified: true, details: {} })
  await store.resolveOutcome(a.id, { label: null, negativeLabel: 'implementation', labelSource: 'human', verified: true, details: {} })
  await store.resolveOutcome(c.id, { label: 'implementation', labelSource: 'teacher_confirmed', verified: false, details: {} })
  const all = await store.list()
  assert.deepEqual(all.map((r) => r.id), ['a', 'b', 'c'], 'oldest first, newest last')
  assert.equal(all[0].outcome.labelSource, 'human', 'the newest outcome wins')
  assert.equal(all[0].outcomeTs, '2026-09-21T00:00:05.000Z')
  assert.equal(all[1].outcome, null)
  assert.deepEqual((await store.list({ domain: 'skill_selection' })).map((r) => r.id), ['b'])
  assert.deepEqual((await store.list({ verifiedOnly: true })).map((r) => r.id), ['a'], 'an unverified outcome does not count as verified')
  assert.deepEqual((await store.list({ since: '2026-09-21T00:00:02.500Z' })).map((r) => r.id), ['c'])
  assert.deepEqual((await store.get('a')).outcome.labelSource, 'human')
  assert.equal(await store.get('zzz'), null)
})

test('stats counts verified, outcome-backed, teacher-only, labels, sources and authorities', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  const ids = []
  for (const [label, authority] of [['implementation', 'jev'], ['debugging', 'jev'], ['implementation', 'local'], ['review', 'fallback']]) {
    ids.push((await store.append(sample({ authority, teacher: { label, probabilities: {}, confidence: 0.8, model: 'jev-1' } }))).id)
  }
  await store.resolveOutcome(ids[0], { label: 'implementation', labelSource: 'teacher_confirmed', verified: true, details: {} })
  await store.resolveOutcome(ids[1], { label: null, negativeLabel: 'debugging', labelSource: 'verified_negative', verified: true, details: {} })
  await store.resolveOutcome(ids[2], { label: 'implementation', labelSource: 'human', verified: true, details: {} })
  const s = await store.stats('task_classification')
  assert.equal(s.total, 4)
  assert.equal(s.verified, 3)
  assert.equal(s.outcomeBacked, 2, 'a verified negative is verified but backs no label')
  assert.equal(s.teacherOnly, 1)
  assert.deepEqual(s.byLabel, { implementation: 2, debugging: 1, review: 1 })
  assert.deepEqual(s.byLabelSource, { teacher_confirmed: 1, verified_negative: 1, human: 1 })
  assert.deepEqual(s.byAuthority, { jev: 2, local: 1, fallback: 1 })
  assert.deepEqual(s.localAgreement, { n: 0, agree: 0 })
  assert.equal((await store.stats('skill_selection')).total, 0)
  assert.equal((await store.stats()).total, 4, 'no domain counts everything')
})

test('a truncated last line is tolerated, and load() reads back what was written', async () => {
  const file = tmp()
  const first = createTrainingStore({ file, now: clock() })
  const row = await first.append(sample({ id: 'good' }))
  await first.resolveOutcome(row.id, { label: 'implementation', labelSource: 'teacher_confirmed', verified: true, details: {} })
  appendFileSync(file, '{"id":"cut","domain":"task_classification","input":{"fea') // the write died mid-line
  const second = createTrainingStore({ file, now: clock() })
  assert.deepEqual(await second.load(), { samples: 1, outcomes: 1 })
  const list = await second.list()
  assert.deepEqual(list.map((r) => r.id), ['good'])
  assert.equal(list[0].outcome.labelSource, 'teacher_confirmed', 'the outcome row survived the truncated one after it')
  assert.deepEqual(await createTrainingStore({ file: tmp(), now: clock() }).list(), [], 'a missing file is empty, not an error')
})

test('attachOutcomes labels every sample of a run, from rows or from id references', async () => {
  const store = createTrainingStore({ file: tmp(), now: clock() })
  const res = await store.append(resourceSample('RESOURCE_C'))
  const task = await store.append(sample())
  const paused = await store.append(sample({ id: 'paused', runId: 'run-2' }))
  const run = record({ attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('claude', 'retry')] })
  const out = await attachOutcomes(store, run, [{ domain: 'resource_selection', id: res.id }, task, { id: 'missing' }])
  assert.deepEqual(out.map((o) => [o.domain, o.outcome.labelSource]), [['resource_selection', 'verified_outcome'], ['task_classification', 'teacher_confirmed']])
  assert.equal((await store.get(res.id)).outcome.chosenKey, 'RESOURCE_A')
  assert.equal((await store.get(res.id)).outcome.negativeKey, 'RESOURCE_C')
  const none = await attachOutcomes(store, record({ runId: 'run-2', finalStatus: 'paused_limit' }), [paused])
  assert.deepEqual(none, [], 'a run with no evidence appends nothing')
  assert.equal((await store.get('paused')).outcome, null)
  assert.equal((await store.stats()).verified, 2)
})

test('a session verdict labels exactly one run: the last one that ended at or before it', () => {
  // Two runs in one session, the same agent answering both. One Like, given between them, is
  // about the first answer; one given after the second is about the second. Session-wide
  // matching made each Like confirm both runs.
  const s = sample()
  const first = record({ runId: 'run-1', ts: '2026-09-21T01:00:00.000Z' })
  const second = record({ runId: 'run-2', ts: '2026-09-21T01:10:00.000Z' })
  const humanOn = (run, feedback, until) => labelFromRun('task_classification', s, run, { feedback, until })?.labelSource === 'human'
  const between = [{ ts: '2026-09-21T01:05:00.000Z', sessionId: 'sess-1', messageId: 'm1', verdict: 'like', tag: 'good pick' }]
  assert.deepEqual([humanOn(first, between, second.ts), humanOn(second, between)], [true, false], 'the Like between the runs labels the first only')
  const after = [{ ts: '2026-09-21T01:15:00.000Z', sessionId: 'sess-1', messageId: 'm2', verdict: 'like', tag: 'good pick' }]
  assert.deepEqual([humanOn(first, after, second.ts), humanOn(second, after)], [false, true], 'the Like after both labels the second only')
  // A verdict whose time cannot be read is about no run in particular, so it labels none.
  assert.equal(humanOn(second, [{ sessionId: 'sess-1', messageId: 'm3', verdict: 'like', tag: 'good pick' }]), false)
  // A verdict that names its run is matched by that alone.
  assert.equal(humanOn(first, [{ runId: 'run-1', ts: '2026-09-21T00:00:00.000Z', sessionId: 'sess-1', messageId: 'm4', verdict: 'like', tag: 'good pick' }], second.ts), true)
})

test('a judgment sample is read against a rescue through the tiers recorded beside it', () => {
  // A judgment sample has no candidate features; the engine records each resource's tier beside
  // it, and that is all the rescue rule needs.
  const tiers = [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier' }, { id: 'deepseek', key: 'RESOURCE_C', tier: 'standard' }]
  const judged = (label, domain) => sample({ domain, extra: { candidates: tiers }, teacher: { label, probabilities: { yes: label === 'yes' ? 0.9 : 0.1 }, confidence: 0.9, model: 'jev-1' } })
  const rescued = record({ strategy: 'CHEAP_DIRECT', attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('claude', 'retry')] })
  // A yes/no domain reads a rescue as "more should have been planned".
  const out = labelFromRun('frontier_escalation', judged('no', 'frontier_escalation'), rescued)
  assert.deepEqual([out.label, out.negativeLabel, out.labelSource], ['yes', 'no', 'verified_outcome'])
  assert.equal(labelFromRun('frontier_escalation', judged('yes', 'frontier_escalation'), rescued).labelSource, 'teacher_confirmed', 'a yes is what the rescue says')
  // Without the recorded tiers nobody is known to be stronger, so the run only confirms.
  assert.equal(labelFromRun('frontier_escalation', sample({ domain: 'frontier_escalation', teacher: { label: 'no', probabilities: {}, confidence: 0.9, model: 'jev-1' } }), rescued).labelSource, 'teacher_confirmed')
  // Conservation read the same rescue the other way round ("the strongest should not have been
  // spared"). It is a hard limit now, and a sample of it an older version left is labelled by nothing.
  assert.equal(labelFromRun('conservation', judged('yes', 'conservation'), rescued), null)
})

test('a review the plan forced is the design working, not a rescue', () => {
  // The conservation limit moved the work to deepseek, and the frontier review had the conserved
  // claude review it. The run was accepted exactly as planned: nothing was rescued, so the direct
  // strategy that planned it is confirmed rather than taught that it needed a review.
  const tiers = [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier' }, { id: 'deepseek', key: 'RESOURCE_C', tier: 'standard' }]
  const judged = (label, domain) => sample({ domain, extra: { candidates: tiers }, teacher: { label, probabilities: { [label]: 0.9 }, confidence: 0.9, model: 'jev-1' } })
  const asPlanned = record({
    strategy: 'STANDARD_DIRECT',
    plan: { strategy: 'STANDARD_DIRECT', reviewer: 'claude', forceReview: true },
    attempts: [attempt('deepseek'), attempt('claude', 'review')],
  })
  assert.equal(labelFromRun('execution_strategy', judged('STANDARD_DIRECT', 'execution_strategy'), asPlanned).labelSource, 'teacher_confirmed', 'the direct run went as planned')
  assert.equal(labelFromRun('second_opinion', judged('no', 'second_opinion'), asPlanned).labelSource, 'teacher_confirmed', 'and nothing else is relabelled')
  // The same review, NOT forced by the plan, is still a rescue.
  const unplanned = { ...asPlanned, plan: { ...asPlanned.plan, forceReview: false } }
  assert.equal(labelFromRun('execution_strategy', judged('STANDARD_DIRECT', 'execution_strategy'), unplanned).label, 'CHEAP_EXECUTE_FRONTIER_REVIEW')
  // A review by someone other than the named reviewer is still a rescue.
  const other = { ...asPlanned, plan: { ...asPlanned.plan, reviewer: 'codex' } }
  assert.equal(labelFromRun('execution_strategy', judged('STANDARD_DIRECT', 'execution_strategy'), other).label, 'CHEAP_EXECUTE_FRONTIER_REVIEW')
})

// --- the cap ------------------------------------------------------------------------------

/** The rows of a samples file as they are on disk, by kind. */
const onDisk = (file) => {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return {
    lines: rows.length,
    samples: rows.filter((r) => typeof r.domain === 'string' && !('outcomeTs' in r)).map((r) => r.id),
    outcomes: rows.filter((r) => 'outcomeTs' in r),
    dropped: rows.find((r) => r.dropped)?.dropped ?? null,
  }
}
const verifiedOutcome = (labelSource = 'teacher_confirmed', verified = true) => ({ label: 'implementation', labelSource, verified, details: {} })
/**
 * Gates small enough to fill in a test, shaped like the shipped ones: LOCAL_ONLY wants 20 verified
 * rows and a holdout of 3, which a 15% holdout share carves out of 20, so the cap they imply is a
 * quarter again, 25.
 */
const small = { shadowSamples: 5, guardedSamples: 10, localOnlySamples: 20, perClassSamples: 2, holdoutSamples: 3, recentWindow: 5 }
const fsp = createRequire(import.meta.url)('node:fs/promises')
/**
 * Run `fn` with node:fs/promises' `name` replaced by `fake(real)`, as every module that imports it
 * sees it: syncBuiltinESMExports carries the swap over to the named imports training.js holds.
 */
async function swapped(name, fake, fn) {
  const real = fsp[name]
  fsp[name] = fake(real)
  syncBuiltinESMExports()
  try { return await fn() } finally {
    fsp[name] = real
    syncBuiltinESMExports()
  }
}
const refusal = (code) => Object.assign(new Error(`${code}: refused by the test`), { code })

test('the cap holds every verified row the most demanding gate counts, with room to spare', () => {
  const policy = resolvePolicy()
  // HIGH asks the most: 6000 verified samples for LOCAL_ONLY, and a holdout of 1200, which a 15%
  // holdout share only carves out of 8000. A quarter on top of 8000 is 10000.
  assert.equal(samplesCap(policy), 10_000)
  // The room is for verified rows the classifier cannot learn from (a verified negative carries
  // no label): with a fifth of the kept verified rows like that, every risk class still passes
  // both sample gates on the rest, counted exactly as the time-aware split counts.
  const usable = Math.floor(samplesCap(policy) * 0.8)
  for (const [risk, g] of Object.entries(policy.gates)) {
    assert.ok(usable >= g.localOnlySamples, `${risk}: the LOCAL_ONLY sample gate`)
    assert.ok(splitRows(new Array(usable).fill(null), policy.split).holdout.length >= g.holdoutSamples, `${risk}: the holdout gate`)
  }
  assert.equal(samplesCap(resolvePolicy({ gates: { HIGH: { localOnlySamples: 20_000 } } })), 25_000, 'a gate raised in config raises the cap with it')
  assert.equal(samplesCap(resolvePolicy({ gates: { LOW: { holdoutSamples: 3000 } } })), 25_000, 'and so does a larger holdout, through the share that carves it')
  // A split that holds nothing out has its holdout gate scored on the validation slice (measure()
  // in domains.js), so that is the share the holdout has to come out of: HIGH's 1200 from a 20%
  // slice needs 6000 rows, level with its sample gate, and a quarter on top is 7500.
  assert.equal(samplesCap(resolvePolicy({ split: { train: 0.8, validation: 0.2, holdout: 0 } })), 7500, 'no holdout share is still a cap')
  // With no validation slice either there is nothing to score the holdout gate on at any size,
  // so only the sample gate can need rows.
  assert.equal(samplesCap(resolvePolicy({ split: { train: 1, validation: 0, holdout: 0 } })), 7500)
  // The store takes the policy it is handed: the small gates cap it at 25.
  assert.equal(samplesCap(resolvePolicy({ gates: { LOW: small, MEDIUM: small, HIGH: small } })), 25)
})

test('an over-cap file loads only the newest samples of each domain, and is cut down on disk', async () => {
  const file = tmp()
  const writer = createTrainingStore({ file, now: clock() })
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) await writer.append(sample({ id }))
  for (const id of ['b1', 'b2']) await writer.append(sample({ id, domain: 'skill_selection' }))
  await writer.resolveOutcome('a2', verifiedOutcome('teacher_confirmed', false))
  const before = readFileSync(file, 'utf8')
  // Within the slack the file is left as it is, but memory already holds only what the cap keeps.
  const reader = createTrainingStore({ file, now: clock(), cap: 3, slack: 100 })
  assert.deepEqual(await reader.load(), { samples: 5, outcomes: 0 })
  assert.deepEqual((await reader.list({ domain: 'task_classification' })).map((r) => r.id), ['a4', 'a5', 'a6'], 'the newest three')
  assert.deepEqual((await reader.list({ domain: 'skill_selection' })).map((r) => r.id), ['b1', 'b2'], 'a domain under the cap keeps everything')
  assert.equal(await reader.get('a1'), null)
  assert.equal(readFileSync(file, 'utf8'), before, 'not rewritten: it is not yet a slack past what the cap keeps')
  // Past the slack, loading it rewrites it to the capped set.
  await createTrainingStore({ file, now: clock(), cap: 3, slack: 1 }).load()
  const disk = onDisk(file)
  assert.deepEqual(disk.samples, ['a4', 'a5', 'a6', 'b1', 'b2'])
  assert.deepEqual(disk.outcomes, [], 'the outcome of a dropped sample went with it')
  assert.deepEqual(disk.dropped, { task_classification: { samples: 3, verified: 0 } })
})

test('the newest samples the cap keeps are the newest by time, as list() orders them, not by place in the file', async () => {
  const file = tmp()
  // A caller's own timestamp is kept as given, so the file and the clock can disagree on the order.
  const writer = createTrainingStore({ file })
  await writer.append(sample({ id: 'late', ts: '2026-09-21T00:00:09.000Z' }))
  await writer.append(sample({ id: 'early', ts: '2026-09-21T00:00:01.000Z' }))
  const reader = createTrainingStore({ file, cap: 1, slack: 100 })
  assert.deepEqual((await reader.list()).map((r) => r.id), ['late'], 'the one list() and the domains read as the newest')
})

test('compaction keeps the newest outcome of every kept sample, and verified samples outlive rows that proved nothing', async () => {
  const file = tmp()
  // A slack of one rewrites the file whenever the cap lets anything go.
  const store = createTrainingStore({ file, now: clock(), cap: 2, slack: 1 })
  for (const id of ['v1', 'v2', 'v3']) {
    await store.append(sample({ id }))
    await store.resolveOutcome(id, verifiedOutcome())
  }
  await store.resolveOutcome('v3', verifiedOutcome('human'))
  await store.append(sample({ id: 'u1' }))
  await store.append(sample({ id: 'u2' }))
  await store.resolveOutcome('u2', verifiedOutcome('teacher_confirmed', false))
  await store.append(sample({ id: 'u3' }))
  const disk = onDisk(file)
  // The newest two, whatever became of them, and the newest two a run verified: v1 is the third
  // verified one back, and u1 is neither.
  assert.deepEqual(disk.samples, ['v2', 'v3', 'u2', 'u3'])
  assert.deepEqual(disk.outcomes.map((o) => [o.id, o.outcome.labelSource]), [['v2', 'teacher_confirmed'], ['v3', 'human'], ['u2', 'teacher_confirmed']], 'one outcome row per kept sample, the newest')
  assert.deepEqual(disk.dropped, { task_classification: { samples: 2, verified: 1 } })
  const reread = createTrainingStore({ file, now: clock(), cap: 2, slack: 1 })
  const joined = (await reread.list()).map((r) => [r.id, r.outcome?.labelSource ?? null, r.outcome?.verified ?? null])
  assert.deepEqual(joined, [['v2', 'teacher_confirmed', true], ['v3', 'human', true], ['u2', 'teacher_confirmed', false], ['u3', null, null]])
  assert.deepEqual((await reread.stats()).dropped, { samples: 2, verified: 1 }, 'what was let go is still counted after a restart')
  assert.deepEqual((await reread.stats('skill_selection')).dropped, { samples: 0, verified: 0 })
})

test('the file is rewritten only once it has grown a slack past what the cap keeps', async () => {
  const file = tmp()
  const store = createTrainingStore({ file, now: clock(), cap: 2, slack: 4 })
  const lines = []
  for (let i = 0; i < 9; i++) {
    await store.append(sample())
    lines.push(onDisk(file).lines)
  }
  // Looked at every fourth row. At the fourth the rewrite would save one row (two samples and the
  // count of the two it let go, against four), so it is skipped; at the eighth it would save five,
  // and it happens. Rewriting whenever anything could go, or looking at every row, would have cut
  // the file at the fourth row or the seventh.
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 6, 7, 3, 4])
})

test('a row appended while a compaction runs is never lost', async () => {
  const file = tmp()
  const store = createTrainingStore({ file, now: clock(), cap: 5, slack: 5 })
  for (let i = 1; i <= 6; i++) await store.append(sample({ id: `s${i}` }))
  // Ten appends issued together: the ninth crosses the slack and compacts the file while the
  // tenth is already on its way. Had it been written into the file the compaction was replacing,
  // the rename would have taken it with it.
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(sample({ id: `s${i + 7}` }))))
  const disk = onDisk(file)
  assert.deepEqual(disk.dropped, { task_classification: { samples: 10, verified: 0 } }, 'the file was compacted')
  assert.deepEqual(disk.samples, ['s11', 's12', 's13', 's14', 's15', 's16'], 'the five the cap kept, and the row that raced it')
  assert.deepEqual((await store.list()).map((r) => r.id), disk.samples, 'memory and disk agree')
})

test('a row appended while a load compacts the file is never lost', async () => {
  const file = tmp()
  const now = clock()
  const writer = createTrainingStore({ file, now })
  for (let i = 0; i < 10; i++) await writer.append(sample({ id: `w${i}` }))
  const store = createTrainingStore({ file, now, cap: 2, slack: 3 })
  await store.list()
  assert.ok(onDisk(file).dropped, 'the first load compacted the file')
  // Another writer grows it past the slack again, so the next load compacts it once more, and an
  // append is issued at the same moment. A load that read the file around the append would have
  // replaced it, and memory, with a copy that never saw the row.
  for (let i = 10; i < 15; i++) await writer.append(sample({ id: `w${i}` }))
  await Promise.all([store.append(sample({ id: 'x' })), store.load()])
  assert.ok(onDisk(file).samples.includes('x'), 'the row is on disk')
  assert.ok((await store.list()).map((r) => r.id).includes('x'), 'and in memory')
})

test('a file that could not be read is never rewritten, since the copy would hold only what was read', async () => {
  const file = tmp()
  const writer = createTrainingStore({ file, now: clock() })
  for (let i = 0; i < 6; i++) await writer.append(sample({ id: `old${i}` }))
  const logs = []
  // A transient refusal, as a scanner or a backup holding the file on Windows gives.
  await swapped('readFile', (real) => async (path, ...rest) => {
    if (path === file) throw refusal('EBUSY')
    return real(path, ...rest)
  }, async () => {
    const store = createTrainingStore({ file, now: clock(), cap: 2, slack: 2, log: (m) => logs.push(m) })
    for (let i = 0; i < 8; i++) await store.append(sample({ id: `new${i}` }))
  })
  assert.deepEqual(onDisk(file).samples.filter((id) => id.startsWith('old')), ['old0', 'old1', 'old2', 'old3', 'old4', 'old5'], 'every row it could not read is still there')
  assert.equal(onDisk(file).dropped, null, 'and the file was never compacted')
  assert.ok(logs.some((m) => m.startsWith('routing samples not read: EBUSY')), logs.join('; '))
})

test('a compaction is written to a temporary file and renamed over the samples, retrying a rename Windows refuses for a moment', async () => {
  const file = tmp()
  const renames = []
  const logs = []
  await swapped('rename', (real) => async (from, to) => {
    // What the copy holds at the moment it replaces the file: complete, and already compacted.
    renames.push({ from, to, rows: onDisk(from).lines })
    // Refused twice, as a reader holding the destination open makes Windows refuse it.
    if (renames.length <= 2) throw refusal('EPERM')
    return real(from, to)
  }, async () => {
    const store = createTrainingStore({ file, now: clock(), cap: 2, slack: 3, log: (m) => logs.push(m) })
    for (let i = 0; i < 6; i++) await store.append(sample({ id: `s${i}` }))
  })
  assert.deepEqual(renames.map((r) => [r.from, r.to, r.rows]), Array(3).fill([`${file}.tmp`, file, 3]), 'one copy of the two kept rows and the count, renamed on the third try')
  assert.deepEqual(onDisk(file).dropped, { task_classification: { samples: 4, verified: 0 } }, 'the file was compacted')
  assert.deepEqual(onDisk(file).samples, ['s4', 's5'])
  assert.equal(existsSync(`${file}.tmp`), false, 'and the copy is gone, renamed over it')
  assert.deepEqual(logs, [])
})

test('a compaction that cannot replace the file leaves it exactly as it was', async () => {
  const file = tmp()
  const logs = []
  const store = createTrainingStore({ file, now: clock(), cap: 2, slack: 3, log: (m) => logs.push(m) })
  for (let i = 0; i < 5; i++) await store.append(sample({ id: `s${i}` }))
  const before = readFileSync(file, 'utf8')
  // A refusal that is not a moment's lock (another device, say) is not retried.
  let tries = 0
  const row = await swapped('rename', () => async () => { tries++; throw refusal('EXDEV') }, () => store.append(sample({ id: 's5' })))
  assert.equal(tries, 1)
  assert.equal(readFileSync(file, 'utf8'), `${before}${JSON.stringify(row)}\n`, 'every row it held, and the one just appended, byte for byte')
  assert.ok(logs.some((m) => m.startsWith('routing samples not compacted: EXDEV')), logs.join('; '))
  // Nothing was lost: read afresh, the file gives back the rows the cap keeps.
  assert.deepEqual((await createTrainingStore({ file, cap: 2, slack: 100 }).list()).map((r) => r.id), ['s4', 's5'])
})

/** A separable two-class task sample, `score` above 0.5 being 'high', so a classifier can learn it. */
const separable = (i, over = {}) => {
  const label = i % 2 === 0 ? 'high' : 'low'
  const score = (label === 'high' ? 0.75 : 0.25) + ((i % 5) - 2) * 0.02
  return sample({
    input: { features: { numeric: { score }, categorical: { kind: label === 'high' ? 'a' : 'b' } } },
    teacher: { label, probabilities: { [label]: 0.9 }, confidence: 0.9, model: 'jev-1' },
    ...over,
  })
}

test('a capped store still hands the maturity gates every verified row they count', async () => {
  // The small gates cap the store at 25.
  const policy = resolvePolicy({ gates: { LOW: small, MEDIUM: small, HIGH: small }, retrain: { minSamples: 10, everyNewSamples: 1, epochs: 300, learningRate: 0.3 } })
  const root = mkdtempSync(join(tmpdir(), 'kz-training-'))
  const file = join(root, 'routing-samples.jsonl')
  const writer = createTrainingStore({ file, now: clock(), policy, slack: 10 })
  // Twenty-five decisions a run verified, then sixty the local classifier made alone, which an
  // accepted run cannot confirm (confirms()): the regime a domain is in once it holds a local rung.
  for (let i = 0; i < 25; i++) {
    const row = await writer.append(separable(i))
    await writer.resolveOutcome(row.id, { label: row.teacher.label, labelSource: 'verified_outcome', verified: true, details: {} })
  }
  for (let i = 0; i < 60; i++) {
    const label = i % 2 === 0 ? 'high' : 'low'
    await writer.append(separable(i, { authority: 'local', teacher: null, local: { label, probabilities: { [label]: 0.95 }, confidence: 0.95, artifactVersion: 'task_classification@1', ood: false } }))
  }
  assert.ok(onDisk(file).dropped, 'the file was capped')
  const ctl = createDomainController({
    domain: 'task_classification', policy, store: createTrainingStore({ file, policy }),
    artifactsDir: join(root, 'classifiers'), stateFile: join(root, 'task_classification.state.json'),
  })
  const ev = await ctl.evaluate()
  // Keeping only the newest 25 rows would have kept none of these: all sixty unverified rows are
  // newer than every verified one.
  assert.equal(ev.samples.verified, 25, 'every verified row outlived the newer rows that proved nothing')
  assert.equal(ev.samples.total, 50, 'and of those, the newest 25 are kept')
  assert.ok(ev.samples.verified >= policy.gates.LOW.localOnlySamples, 'the LOCAL_ONLY sample gate can pass')
  assert.ok(ev.holdout?.n >= policy.gates.LOW.holdoutSamples, `the holdout gate can pass (${ev.holdout?.n} held out)`)
})

test('a domain at its cap keeps retraining, and keeps a recent window to judge the classifier on', async () => {
  const policy = resolvePolicy({ gates: { LOW: small, MEDIUM: small, HIGH: small }, retrain: { minSamples: 10, everyNewSamples: 5, epochs: 100, learningRate: 0.3 } })
  const root = mkdtempSync(join(tmpdir(), 'kz-training-'))
  const store = createTrainingStore({ file: join(root, 'routing-samples.jsonl'), now: clock(), policy, slack: 10 })
  const ctl = createDomainController({ domain: 'task_classification', policy, store, artifactsDir: join(root, 'classifiers'), stateFile: join(root, 'task_classification.state.json') })
  let n = 0
  const verify = async (count) => {
    for (let k = 0; k < count; k++, n++) {
      const row = await store.append(separable(n))
      await store.resolveOutcome(row.id, { label: row.teacher.label, labelSource: 'verified_outcome', verified: true, details: {} })
    }
  }
  await verify(30)
  await ctl.evaluate()
  assert.ok((await store.stats('task_classification')).dropped.verified > 0, 'the store is at its cap')
  const atCap = ctl.artifact()
  // Sixty more verified rows, ten at a time. After each batch the store holds its 25 newest again,
  // so a count of what it holds stands still, and nothing that arrives would ever look new.
  let ev
  for (let k = 0; k < 6; k++) {
    await verify(10)
    ev = await ctl.evaluate()
  }
  assert.notEqual(ctl.artifact(), atCap, 'retrained on rows that arrived after the cap')
  assert.equal(ev.samples.seen, 90, 'every verified row the domain has had, the ones the cap let go of included')
  assert.equal(ctl.artifact().extras.verifiedSamples, 90, 'and the classifier in service was trained after the last batch')
  assert.ok(ev.recent?.n > 0, 'it is still measured on rows it never saw, so the rollback checks can see')
})

test('a classifier whose training rows the cap let go of is measured on exactly the rows verified after it', async () => {
  // A recent window wider than the store holds, so the count below is every row it is read from.
  const policy = resolvePolicy({ gates: { LOW: { ...small, recentWindow: 30 }, MEDIUM: small, HIGH: small }, retrain: { minSamples: 10, everyNewSamples: 5, epochs: 100, learningRate: 0.3 } })
  const root = mkdtempSync(join(tmpdir(), 'kz-training-'))
  const store = createTrainingStore({ file: join(root, 'routing-samples.jsonl'), now: clock(), policy, cap: 25, slack: 10 })
  const ctl = createDomainController({ domain: 'task_classification', policy, store, artifactsDir: join(root, 'classifiers'), stateFile: join(root, 'task_classification.state.json') })
  let n = 0
  const verify = async (count) => {
    for (let k = 0; k < count; k++, n++) {
      const row = await store.append(separable(n))
      await store.resolveOutcome(row.id, { label: row.teacher.label, labelSource: 'verified_outcome', verified: true, details: {} })
    }
  }
  // Trained with 30 verified rows seen, of which the store held the newest 25, rows 5 to 29.
  await verify(30)
  await ctl.evaluate()
  assert.equal(ctl.artifact().extras.verifiedSamples, 30)
  // Twenty more, not trained on. The store now holds rows 25 to 49, and the rows that mark where
  // the classifier's training and calibration slices ended (21 and 24) have gone with the cap.
  await verify(20)
  const ev = await ctl.evaluate({ retrain: false })
  const held = (await store.list({ verifiedOnly: true })).map((r) => r.id)
  assert.ok(!held.includes(ctl.artifact().extras.trainedThrough) && !held.includes(ctl.artifact().extras.calibratedThrough), 'the markers are gone')
  // Taken to have seen every row verified when it was trained: 30, of which the oldest 25 are no
  // longer held, so of the held rows it saw the first five and none of the twenty after them.
  assert.equal(ev.recent?.n, 20, 'the twenty rows verified since it was trained')
  assert.equal(ev.recent.calibration?.n, 20)
})

test('the plugin hands its training store the policy it resolved, so the gates in config set the cap', async () => {
  const { apply, Config } = await import('../index.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'kz-training-'))
  const writer = createTrainingStore({ file: join(dataDir, 'routing-samples.jsonl'), now: clock() })
  for (let i = 0; i < 40; i++) await writer.append(sample())
  const routes = []
  const disposers = []
  const effect = (f) => { const d = f(); if (typeof d === 'function') disposers.push(d) }
  // Just enough of the plugin runtime for apply() to build the router and register its routes.
  const ctx = {
    credentials: { resolve: async () => undefined }, effect, subagents: {}, get: () => null,
    commands: { register: () => {} }, tools: { register: () => {} },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ effect, webServer: { register: (r) => { routes.push(r); return () => {} } }, connection: { requestRejection: () => 0 } })
    },
  }
  // No agents, so nothing is shelled out to for a login check.
  apply(ctx, Config({ agents: [], historyFile: join(dataDir, 'history.jsonl'), routing: { gates: { LOW: small, MEDIUM: small, HIGH: small } } }))
  try {
    const res = await new Promise((resolve) => {
      const r = { statusCode: 0, setHeader() {}, end(body) { r.body = body; resolve(r) } }
      routes[0].handler({ method: 'GET', url: '/jev-router/routing', headers: {} }, r)
    })
    assert.equal(res.statusCode, 200)
    // The shipped gates cap it at 10000, which would keep all forty.
    const { training } = JSON.parse(res.body)
    assert.equal(training.total, 25, 'the small gates in config cap the store at 25')
    assert.deepEqual(training.dropped, { samples: 15, verified: 0 })
  } finally { for (const d of disposers) d() }
})

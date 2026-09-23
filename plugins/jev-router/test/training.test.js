// The training store and the run-to-label rules: append and join, the shadow comparison,
// which outcome a finished run justifies per domain, and the refusal to guess or to store text.
// Every row is a fixture; no real task text is anywhere near this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEATURE_SCHEMA_VERSION } from '../features.js'
import { AUTHORITIES, LABEL_SOURCES, OUTCOME_BACKED, attachOutcomes, createTrainingStore, labelFromRun } from '../training.js'

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
  assert.deepEqual([...AUTHORITIES], ['jev', 'local', 'deterministic', 'fallback'])
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

test('resource selection: the local pick is the one confirmed when the local classifier had authority', () => {
  const s = resourceSample('RESOURCE_C', { authority: 'local', teacher: null, local: { chosenKey: 'RESOURCE_A', probabilities: { RESOURCE_A: 0.97 }, confidence: 0.97, artifactVersion: 'resource_selection@1', ood: false } })
  const out = labelFromRun('resource_selection', s, record({ attempts: [attempt('claude')] }))
  assert.deepEqual([out.chosenKey, out.labelSource], ['RESOURCE_A', 'teacher_confirmed'])
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
  const like = [{ ts: AFTER, sessionId: 'sess-1', messageId: 'm1', verdict: 'like' }]
  assert.deepEqual(labelFromRun('task_classification', s, record({ finalStatus: 'needs_human' }), { feedback: like }).label, 'implementation', 'a like is a human confirmation even when the run stalled')
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
  assert.equal(labelFromRun('conservation', yesno('no', 'conservation'), record()).labelSource, 'teacher_confirmed')
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
  const between = [{ ts: '2026-09-21T01:05:00.000Z', sessionId: 'sess-1', messageId: 'm1', verdict: 'like' }]
  assert.deepEqual([humanOn(first, between, second.ts), humanOn(second, between)], [true, false], 'the Like between the runs labels the first only')
  const after = [{ ts: '2026-09-21T01:15:00.000Z', sessionId: 'sess-1', messageId: 'm2', verdict: 'like' }]
  assert.deepEqual([humanOn(first, after, second.ts), humanOn(second, after)], [false, true], 'the Like after both labels the second only')
  // A verdict whose time cannot be read is about no run in particular, so it labels none.
  assert.equal(humanOn(second, [{ sessionId: 'sess-1', messageId: 'm3', verdict: 'like' }]), false)
  // A verdict that names its run is matched by that alone.
  assert.equal(humanOn(first, [{ runId: 'run-1', ts: '2026-09-21T00:00:00.000Z', sessionId: 'sess-1', messageId: 'm4', verdict: 'like' }], second.ts), true)
})

test('conservation: a stronger resource rescuing the run says conserving was wrong', () => {
  // A judgment sample has no candidate features; the engine records each resource's tier beside
  // it, and that is all the rescue rule needs.
  const tiers = [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier' }, { id: 'deepseek', key: 'RESOURCE_C', tier: 'standard' }]
  const judged = (label, domain = 'conservation') => sample({ domain, extra: { candidates: tiers }, teacher: { label, probabilities: { yes: label === 'yes' ? 0.9 : 0.1 }, confidence: 0.9, model: 'jev-1' } })
  const rescued = record({ strategy: 'CHEAP_DIRECT', attempts: [attempt('deepseek', 'primary', { stopReason: 'error' }), attempt('claude', 'retry')] })
  const out = labelFromRun('conservation', judged('yes'), rescued)
  assert.deepEqual([out.label, out.negativeLabel, out.labelSource], ['no', 'yes', 'verified_outcome'])
  assert.equal(labelFromRun('conservation', judged('no'), rescued).labelSource, 'teacher_confirmed', 'a no is what the rescue says')
  // The other yes/no domains keep their reading: a rescue means more should have been planned.
  assert.equal(labelFromRun('frontier_escalation', judged('no', 'frontier_escalation'), rescued).label, 'yes')
  // Without the recorded tiers nobody is known to be stronger, so the run only confirms.
  assert.equal(labelFromRun('conservation', sample({ domain: 'conservation', teacher: { label: 'yes', probabilities: {}, confidence: 0.9, model: 'jev-1' } }), rescued).labelSource, 'teacher_confirmed')
})

test('a review the plan forced is the design working, not a rescue that proves conservation wrong', () => {
  // Conservation moved the work to deepseek, and frontier escalation had the conserved claude
  // review it. The run was accepted exactly as planned: nothing was rescued.
  const tiers = [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier' }, { id: 'deepseek', key: 'RESOURCE_C', tier: 'standard' }]
  const judged = (label, domain = 'conservation') => sample({ domain, extra: { candidates: tiers }, teacher: { label, probabilities: { yes: label === 'yes' ? 0.9 : 0.1 }, confidence: 0.9, model: 'jev-1' } })
  const asPlanned = record({
    strategy: 'STANDARD_DIRECT',
    plan: { strategy: 'STANDARD_DIRECT', reviewer: 'claude', forceReview: true },
    attempts: [attempt('deepseek'), attempt('claude', 'review')],
  })
  assert.equal(labelFromRun('conservation', judged('yes'), asPlanned).labelSource, 'teacher_confirmed', 'conserving was right')
  assert.equal(labelFromRun('second_opinion', judged('no', 'second_opinion'), asPlanned).labelSource, 'teacher_confirmed', 'and nothing else is relabelled')
  // The same review, NOT forced by the plan, is still a rescue.
  const unplanned = { ...asPlanned, plan: { ...asPlanned.plan, forceReview: false } }
  assert.equal(labelFromRun('conservation', judged('yes'), unplanned).label, 'no')
  // A review by someone other than the named reviewer is still a rescue.
  const other = { ...asPlanned, plan: { ...asPlanned.plan, reviewer: 'codex' } }
  assert.equal(labelFromRun('conservation', judged('yes'), other).label, 'no')
})

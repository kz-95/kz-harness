// The shadow's figures (docs/laya-auto.md 5.5, 6.7, 8.4): the outcome judge, agreement with Jev,
// what either would have done, and Laya's standing, whose sources are never pooled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUPS, compare, isYesNo, judge, standing, thresholdsHash } from '../shadow-stats.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewAction } from '../../jev-review/index.js'
import { validFeedback } from '../feedback.js'
import { resolveProviders } from '../providers.js'
import { DOMAINS } from '../routing-policy.js'

const { jev: JEV, laya: LAYA } = resolveProviders({}, {})
const THRESHOLDS = { jev: JEV.thresholds, laya: LAYA.thresholds }
const HASHES = { jev: thresholdsHash(JEV.thresholds), laya: thresholdsHash(LAYA.thresholds) }
const ID = 'laya-0.3.20|english|0123456789ab|adapter-1|corr:choice:11+=3.27|margin:0.1'
const HOST = 'api.typesafe.ai'
const NOW = Date.parse('2026-09-24T12:00:00.000Z')
const iso = (minutesAgo = 5) => new Date(NOW - minutesAgo * 60_000).toISOString()
const MARKER = 'ZX-MARKER-7f3a'

// Answers as a shadow row records them: the pick, the probabilities in option order, the confidence.
const choice = (answer, p, marks = {}) => ({ type: 'choice', answer, p, confidence: Math.max(...p), ...marks })
const noul = (p, marks = {}) => ({ type: 'noul', answer: p, p, confidence: Math.max(p, 1 - p), ...marks })
const score = (level, p, marks = {}) => ({ type: 'score', answer: level, p, confidence: Math.max(...p), ...marks })
const laya = (a, informative = true, corrected = false) => ({ ...a, informative, corrected })
const P12 = (i, top = 0.6) => Array.from({ length: 12 }, (_, k) => (k === i ? top : (1 - top) / 11))
const TYPES = ['architecture', 'implementation', 'debugging', 'review', 'refactor', 'testing', 'documentation', 'investigation', 'security', 'performance', 'simple_change', 'other']
const taskType = (name, top) => choice(name, P12(TYPES.indexOf(name), top))

let seq = 0
function row({ runId = `run-${++seq}`, phase = 'route', groups = phase === 'route' ? ['task'] : null, jev = {}, laya: l = {}, status = 'answered', reason = null, attempt = null, review = null, identity = ID, thresholds = HASHES, host = HOST, ts = iso(), ms = 900, jevMs = 700 } = {}) {
  return {
    id: `row-${seq}`, ts, runId: phase === 'intent' ? null : runId, callId: `call-${seq}`, phase, groups,
    attempt, review, identity, device: 'cpu', lang: 'latin', thresholds, status, reason,
    queuedMs: 10, ms, rows: Object.keys(l).length, requests: 1, atContextLimit: 0,
    jev: { model: 'jev-1.13.0', host, ms: jevMs, error: null, questions: jev },
    laya: { questions: l },
  }
}
const sample = (domain, runId, teacherLabel, outcome, extra) => ({
  id: `s-${++seq}`, ts: iso(), runId, domain, authority: 'jev', teacher: { label: teacherLabel, probabilities: {}, confidence: 0.8 },
  outcome: outcome ? { verified: true, ...outcome } : null, ...(extra ? { extra } : {}),
})
const layaSample = (domain, runId, label, outcome, { informative = true, identity = ID, extra } = {}) => ({
  id: `l-${++seq}`, ts: iso(), runId, domain, authority: 'laya', teacher: null,
  provider: { id: 'laya', label, probabilities: {}, confidence: 0.7, informative, identity, lang: 'latin' },
  outcome: outcome ? { verified: true, ...outcome } : null, ...(extra ? { extra } : {}),
})
const standingOf = (rows, group) => rows.find((r) => r.domain === group)
const domainOf = (cmp, group) => cmp.domains.find((d) => d.domain === group)

// ---------------------------------------------------------------- the judge

test('the outcome judge, row by row of the table', () => {
  const tc = 'task_classification'
  // human with a label (good pick)
  assert.equal(judge('debugging', { labelSource: 'human', label: 'debugging' }, tc), 'right')
  assert.equal(judge('refactor', { labelSource: 'human', label: 'debugging' }, tc), 'wrong')
  // human with only negativeLabel X (misread my question): included, and decisive only where it can be
  assert.equal(judge('debugging', { labelSource: 'human', label: null, negativeLabel: 'debugging' }, tc), 'wrong')
  assert.equal(judge('refactor', { labelSource: 'human', label: null, negativeLabel: 'debugging' }, tc), 'undetermined')
  assert.equal(judge('yes', { labelSource: 'human', negativeLabel: 'no' }, 'second_opinion'), 'right')
  assert.equal(judge('no', { labelSource: 'human', negativeLabel: 'no' }, 'second_opinion'), 'wrong')
  // verified_outcome with a label
  assert.equal(judge('CHEAP_THEN_PREMIUM_REVIEW', { labelSource: 'verified_outcome', label: 'CHEAP_THEN_PREMIUM_REVIEW', negativeLabel: 'CHEAP_DIRECT' }, 'execution_strategy'), 'right')
  assert.equal(judge('CHEAP_DIRECT', { labelSource: 'verified_outcome', label: 'CHEAP_THEN_PREMIUM_REVIEW', negativeLabel: 'CHEAP_DIRECT' }, 'execution_strategy'), 'wrong')
  // verified_negative X
  assert.equal(judge('CHEAP_DIRECT', { labelSource: 'verified_negative', negativeLabel: 'CHEAP_DIRECT' }, 'execution_strategy'), 'wrong')
  assert.equal(judge('PREMIUM_DIRECT', { labelSource: 'verified_negative', negativeLabel: 'CHEAP_DIRECT' }, 'execution_strategy'), 'undetermined')
  assert.equal(judge('yes', { labelSource: 'verified_negative', negativeLabel: 'no' }, 'second_opinion'), 'right')
  // teacher_confirmed: the acting router agreeing with itself, undetermined for both providers
  assert.equal(judge('debugging', { labelSource: 'teacher_confirmed', label: 'debugging' }, tc), 'undetermined')
  assert.equal(judge('refactor', { labelSource: 'teacher_confirmed', label: 'debugging' }, tc), 'undetermined')
  // no outcome, no answer
  assert.equal(judge('debugging', null, tc), 'undetermined')
  assert.equal(judge(null, { labelSource: 'human', label: 'debugging' }, tc), 'undetermined')
})

test('a yes/no group is one whose labels are yes and no, whatever routing-policy calls its kind', () => {
  assert.equal(DOMAINS.second_opinion.kind, 'multiclass')
  assert.equal(isYesNo('second_opinion'), true)
  for (const g of ['task_classification', 'skill_selection', 'execution_strategy', 'outcome_disposition', 'review_action', 'intent']) assert.equal(isYesNo(g), false, g)
  assert.deepEqual(GROUPS, ['task_classification', 'skill_selection', 'execution_strategy', 'second_opinion', 'outcome_disposition', 'review_action', 'intent'])
})

test('the review groups: every verified_outcome is undetermined, and a dislike after an accept is decisive', () => {
  for (const g of ['outcome_disposition', 'review_action']) {
    const accept = g === 'review_action' ? 'accept' : 'PASS'
    const other = g === 'review_action' ? 'second_review' : 'SECOND_OPINION'
    assert.equal(judge(accept, { labelSource: 'verified_outcome', label: accept }, g), 'undetermined')
    assert.equal(judge(other, { labelSource: 'verified_outcome', label: 'RETRY_SAME_TIER', negativeLabel: other }, g), 'undetermined')
    assert.equal(judge(accept, { labelSource: 'teacher_confirmed', label: accept }, g), 'undetermined')
    assert.equal(judge(accept, { labelSource: 'human', verdict: 'dislike' }, g), 'wrong')
    assert.equal(judge(accept, { labelSource: 'human', verdict: 'like' }, g), 'right')
    assert.equal(judge(other, { labelSource: 'human', verdict: 'dislike' }, g), 'undetermined')
    assert.equal(judge(accept, { labelSource: 'later_review', accepted: false }, g), 'wrong')
    assert.equal(judge(other, { labelSource: 'later_review', accepted: false }, g), 'undetermined')
  }

  // Through the standing: Jev's nouls accept, Laya's stop under its higher bar; the person disliked
  // the answer. Jev's accept is wrong; Laya's second review is not judged by it.
  const nouls = (q) => ({ addressed: noul(q), complete: noul(q), unrelatedChanges: noul(0.1), regressionRisk: noul(0.1), needsPerson: noul(0.1) })
  const r = row({ runId: 'rev', phase: 'review', attempt: 0, review: { risk: 0.5, blockAccept: false, reviewed: false }, jev: { ...nouls(0.75), disposition: choice('PASS', [0.7, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]) }, laya: Object.fromEntries(Object.entries({ ...nouls(0.75), disposition: choice('SECOND_OPINION', [0.1, 0.1, 0.1, 0.4, 0.1, 0.1, 0.1]) }).map(([k, v]) => [k, laya(v)])) })
  const history = [{ runId: 'rev', finalStatus: 'accepted', attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed' }] }]
  const feedback = [{ ts: iso(), sessionId: 'sess-1', messageId: 'm1', runId: 'rev', verdict: 'dislike', reason: `bad ${MARKER}` }]
  const got = standing({ shadowRows: [r], feedback, history, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(standingOf(got, 'review_action').jev.personSaid, { n: 1, right: 0 })
  assert.deepEqual(standingOf(got, 'review_action').laya.personSaid, { n: 0, right: 0 })
  assert.deepEqual(standingOf(got, 'outcome_disposition').jev.personSaid, { n: 1, right: 0 })
  // A like instead: Jev's accept is right.
  const liked = standing({ shadowRows: [r], feedback: [{ ts: iso(), sessionId: 'sess-1', messageId: 'm1', runId: 'rev', verdict: 'like' }], history, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(standingOf(liked, 'review_action').jev.personSaid, { n: 1, right: 1 })
  // A later review by another agent that did not accept: Jev's accept was contradicted.
  const reviewed = [{ runId: 'rev', finalStatus: 'needs_human', attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed' }, { agent: 'codex', role: 'review', stopReason: 'completed' }] }]
  const later = standing({ shadowRows: [r], history: reviewed, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(standingOf(later, 'review_action').laya.whereJevWasContradicted, { n: 0, right: 0 }, 'a second review is not judged by it')
  // The Jev sample's own verified outcome judges neither.
  const jevSamples = [sample('outcome_disposition', 'rev', 'PASS', { labelSource: 'verified_outcome', label: 'RETRY_SAME_TIER', negativeLabel: 'PASS' }, { decidedAt: 0 })]
  const verified = standing({ shadowRows: [r], jevSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(standingOf(verified, 'outcome_disposition').laya.whereJevWasContradicted, { n: 0, right: 0 })
  assert.deepEqual(standingOf(verified, 'outcome_disposition').jev.personSaid, { n: 0, right: 0 })
})

test('a verdict is read back as feedback.js reads it: the newest per message, and one the person cleared says nothing', async () => {
  // The rows feedback.jsonl holds, as validFeedback writes them: a clear is a tombstone with no run.
  let clock = NOW - 60 * 60_000
  const said = (messageId, verdict, runId) => validFeedback({ sessionId: 'sess-1', messageId, verdict, ...(runId ? { runId } : {}) }, { now: () => new Date(clock += 1000).toISOString() })
  const liked = said('m1', 'like', 'rev')
  const cleared = said('m1', 'clear')
  assert.equal(cleared.runId, undefined)
  const both = (q) => ({ addressed: noul(q), complete: noul(q), unrelatedChanges: noul(0.1), regressionRisk: noul(0.1), needsPerson: noul(0.1) })
  const review = (runId) => row({ runId, phase: 'review', attempt: 0, review: { risk: 0.5, blockAccept: false, reviewed: false }, jev: both(0.9), laya: Object.fromEntries(Object.entries(both(0.9)).map(([k, v]) => [k, laya(v)])) })
  const r = review('rev')
  const history = [{ runId: 'rev', finalStatus: 'accepted', attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed' }] }]
  const reviewActionOf = (feedback) => standingOf(standing({ shadowRows: [r], feedback, history, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW }), 'review_action')
  const withdrawn = reviewActionOf([liked, cleared])
  assert.deepEqual(withdrawn.jev.personSaid, { n: 0, right: 0 }, 'the like was cleared')
  assert.deepEqual(withdrawn.laya.personSaid, { n: 0, right: 0 })
  assert.deepEqual(reviewActionOf([said('m1', 'like', 'rev'), said('m1', 'dislike', 'rev')]).jev.personSaid, { n: 1, right: 0 }, 'the newest verdict is the person\'s word')
  assert.deepEqual(reviewActionOf([liked, cleared, said('m1', 'like', 'rev')]).jev.personSaid, { n: 1, right: 1 }, 'liked again after the clear')

  // Through the file and the worker, as index.js asks for the standing: the clear reaches the reading,
  // and a like nobody cleared still counts.
  const { createShadow } = await import('../shadow.js')
  const dir = mkdtempSync(join(tmpdir(), 'kz-cleared-'))
  const files = { feedback: join(dir, 'feedback.jsonl'), history: join(dir, 'history.jsonl'), standing: join(dir, 'laya-standing.jsonl') }
  const shadowFile = join(dir, 'laya-shadow.jsonl')
  const jl = (rows) => rows.map((x) => `${JSON.stringify(x)}\n`).join('')
  writeFileSync(shadowFile, jl([r, review('rev2')]))
  writeFileSync(files.history, jl([...history, { ...history[0], runId: 'rev2' }]))
  writeFileSync(files.feedback, jl([liked, said('m2', 'like', 'rev2'), cleared]))
  const shadow = createShadow({ file: shadowFile, laya: { identity: () => ID, offerShadow: () => ({ dropped: 'not_running' }), withdraw: () => false }, providers: { jev: JEV, laya: LAYA }, jevHost: HOST, files, now: () => NOW })
  const rows = await shadow.recordStanding()
  assert.deepEqual(standingOf(rows, 'review_action').jev.personSaid, { n: 1, right: 1 }, 'rev2 only')
  assert.deepEqual(domainOf(await shadow.compare({ days: 'all' }), 'review_action').personSaid, { n: 1, jevRight: 1, layaRight: 1 })
})

// ---------------------------------------------------------------- agreement

test('agreement for choice, noul and score, over every answer and over Laya\'s informative ones', () => {
  const rows = [
    row({ jev: { taskType: taskType('debugging', 0.7), humanReview: noul(0.65), complexity: score(2.2, [0.05, 0.2, 0.4, 0.3, 0.05]) },
      laya: { taskType: laya(taskType('debugging', 0.5), true, true), humanReview: laya(noul(0.62)), complexity: laya(score(1.8, [0.1, 0.3, 0.3, 0.2, 0.1])) } }),
    row({ jev: { taskType: taskType('refactor', 0.7), humanReview: noul(0.3), complexity: score(3.4, [0, 0.05, 0.15, 0.2, 0.6]) },
      laya: { taskType: laya(choice('debugging', P12(2, 0.09).map((p, i) => (i === 4 ? 0.085 : p))), false, true), humanReview: laya(noul(0.6)), complexity: laya(score(1.2, [0.2, 0.5, 0.2, 0.05, 0.05])) } }),
  ]
  const cmp = compare({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const q = (name) => cmp.questions.find((x) => x.name === name)
  const tt = q('taskType')
  assert.deepEqual([tt.type, tt.options, tt.compared, tt.corrected, tt.flat], ['choice', 12, 2, 2, 1])
  assert.deepEqual(tt.agree, { all: { n: 2, agree: 1 }, informative: { n: 1, agree: 1 } })
  assert.equal(tt.inTopTwo, 2, 'Jev\'s refactor is Laya\'s second choice')
  assert.equal(tt.meanDifference, null)
  assert.equal(tt.atBar, null)
  const hr = q('humanReview')
  assert.deepEqual(hr.agree, { all: { n: 2, agree: 1 }, informative: { n: 2, agree: 1 } })
  assert.equal(hr.meanDifference, 0.165)
  // At each provider's own bar (Jev 0.7, Laya 0.6): 0.65 is a no for Jev and 0.62 a yes for Laya.
  assert.deepEqual(hr.atBar, { n: 2, agree: 0 })
  const cx = q('complexity')
  assert.deepEqual(cx.agree, { all: { n: 2, agree: 1 }, informative: { n: 2, agree: 1 } })
  assert.equal(cx.meanDifference, 0.325, 'in unit scale')
  assert.equal(cx.inTopTwo, null)
  assert.equal(cx.layaMedianMs, 900)
  const td = domainOf(cmp, 'task_classification')
  assert.equal(td.question, 'taskType')
  assert.equal(td.layaAnswered, 2)
  assert.deepEqual(td.agree, { all: { n: 2, agree: 1 }, informative: { n: 1, agree: 1 } })
})

test('a row whose Jev call failed counts in coverage and never in agreement', () => {
  const answered = row({ jev: { taskType: taskType('debugging', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } })
  const failed = row({ status: 'skipped', reason: 'jev_failed', jev: { taskType: taskType('refactor', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } })
  const skipped = row({ status: 'skipped', reason: 'not_running' })
  const errored = row({ status: 'failed', reason: 'LAYA_HTTP_500' })
  const cmp = compare({ shadowRows: [answered, failed, skipped, errored], identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(cmp.questions.find((x) => x.name === 'taskType').agree.all, { n: 1, agree: 1 })
  assert.deepEqual(domainOf(cmp, 'task_classification').agree.all, { n: 1, agree: 1 })
  assert.deepEqual(cmp.skips, { answered: 1, partial: 0, failed: 1, skipped: { not_running: 1, starting: 0, queue_full: 0, too_old: 0, jev_failed: 1, yielded: 0 }, atContextLimit: 0 })
  const st = standing({ shadowRows: [answered, failed], identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.equal(standingOf(st, 'task_classification').laya.answered, 1)
  assert.equal(standingOf(st, 'task_classification').jev.acted, 1)
})

// ---------------------------------------------------------------- would it have acted the same

test('review actions come from reviewAction with the row\'s own context, and the stops under each accept bar are counted', () => {
  const nouls = (q, np = 0.1) => ({ addressed: noul(q), complete: noul(q), unrelatedChanges: noul(0.1), regressionRisk: noul(0.1), needsPerson: noul(np) })
  const rev = (context, jq, lq, lnp = 0.1) => row({ phase: 'review', attempt: 1, review: context, jev: nouls(jq), laya: Object.fromEntries(Object.entries(nouls(lq, lnp)).map(([k, v]) => [k, laya(v)])) })
  const cases = [
    rev({ risk: 0.5, blockAccept: false, reviewed: false }, 0.9, 0.9), // both accept
    rev({ risk: 0.5, blockAccept: false, reviewed: false }, 0.75, 0.75), // Jev accepts at 0.70, Laya stops under 0.80
    rev({ risk: 0.1, blockAccept: false, reviewed: false }, 0.6, 0.6), // low band: 0.55 against 0.65
    rev({ risk: 0.9, blockAccept: false, reviewed: true }, 0.8, 0.8), // high band, already reviewed: both human
    rev({ risk: 0.5, blockAccept: true, reviewed: false }, 0.9, 0.9), // blocked: both retry
    rev({ risk: 0.5, blockAccept: false, reviewed: false }, 0.9, 0.9, 0.7), // Laya: a person is needed
  ]
  const expected = (r, side, T) => reviewAction(Object.fromEntries(Object.entries(r[side].questions).map(([k, v]) => [k, v.answer])), r.review, T).action
  const jevActions = cases.map((r) => expected(r, 'jev', JEV.thresholds))
  const layaActions = cases.map((r) => expected(r, 'laya', LAYA.thresholds))
  assert.deepEqual(jevActions, ['accept', 'accept', 'accept', 'human', 'retry', 'accept'])
  assert.deepEqual(layaActions, ['accept', 'second_review', 'second_review', 'human', 'retry', 'human'])
  const cmp = compare({ shadowRows: cases, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.deepEqual(cmp.actions.review, {
    jev: { accept: 4, second_review: 0, human: 1, retry: 1, belowAcceptBar: 1 },
    laya: { accept: 1, second_review: 2, human: 2, retry: 1, belowAcceptBar: 3 },
  })
  assert.deepEqual(cmp.actions.wouldHaveActedSame.find((w) => w.what === 'review_action'), { what: 'review_action', n: 6, same: 3 })
})

test('would it have acted the same: each provider on its own answers and bars', () => {
  const rows = [
    // Checks: Jev 0.4 under its 0.5, Laya 'always'. The stop: Jev at 0.7 over its 0.6, Laya at 0.7 under its 0.8.
    row({ jev: { taskType: taskType('debugging', 0.7), needsTests: noul(0.4), capability: choice('human_required', [0.7, 0.2, 0.1]) },
      laya: { taskType: laya(taskType('debugging', 0.6)), needsTests: laya(noul(0.4)), capability: laya(choice('human_required', [0.7, 0.2, 0.1])) } }),
    // A flat task type is filled by the rules: no row says what they chose, so it is not compared.
    row({ jev: { taskType: taskType('refactor', 0.7) }, laya: { taskType: laya(taskType('refactor', 0.09), false) } }),
    // The second opinion at each own judgmentYes (both 0.5).
    row({ groups: ['resource', 'judgments'], jev: { secondOpinion: noul(0.3), strategy: choice('CHEAP_DIRECT', [0.6, 0.4]) }, laya: { secondOpinion: laya(noul(0.55)), strategy: laya(choice('CHEAP_DIRECT', [0.7, 0.3])) } }),
  ]
  const cmp = compare({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const w = Object.fromEntries(cmp.actions.wouldHaveActedSame.map((x) => [x.what, [x.n, x.same]]))
  assert.deepEqual(w, { task_type: [1, 1], capability: [1, 1], strategy: [1, 1], second_opinion: [1, 0], checks_required: [1, 0], needs_human: [1, 0], review_action: [0, 0] })
})

// ---------------------------------------------------------------- the sources, never pooled

test('the sources are never pooled: an always-yes Laya on second_opinion gets no accuracy from contradicted rows', () => {
  const rows = []
  const jevSamples = []
  for (let i = 0; i < 6; i++) {
    const r = row({ groups: ['resource', 'judgments'], jev: { secondOpinion: noul(0.2) }, laya: { secondOpinion: laya(noul(0.9)) } })
    rows.push(r)
    // Four rescues of Jev's no, two confirmations of it.
    jevSamples.push(sample('second_opinion', r.runId, 'no', i < 4 ? { labelSource: 'verified_outcome', label: 'yes', negativeLabel: 'no' } : { labelSource: 'teacher_confirmed', label: 'no' }))
  }
  const st = standing({ shadowRows: rows, jevSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const so = standingOf(st, 'second_opinion')
  assert.deepEqual(so.laya.whereJevWasContradicted, { n: 4, right: 4 })
  assert.deepEqual(so.laya.personSaid, { n: 0, right: 0 }, 'no accuracy: nobody said anything')
  assert.deepEqual(so.jev.personSaid, { n: 0, right: 0 })
  assert.deepEqual(so.laya.agreementWithJev, { all: { n: 6, agree: 0 }, informative: { n: 6, agree: 0 } })
  const cmp = compare({ shadowRows: rows, jevSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const d = domainOf(cmp, 'second_opinion')
  assert.deepEqual(d.personSaid, { n: 0 }, 'a source with no rows is { n: 0 }, never a rate')
  assert.deepEqual(d.whereJevWasContradicted, { n: 4, layaRight: 4 })

  // A person's word is the only accuracy, paired where both answers are determined.
  const tcRows = [
    row({ runId: 'p1', jev: { taskType: taskType('debugging', 0.7) }, laya: { taskType: laya(taskType('refactor', 0.6)) } }),
    row({ runId: 'p2', jev: { taskType: taskType('testing', 0.7) }, laya: { taskType: laya(taskType('testing', 0.6)) } }),
    row({ runId: 'p3', jev: { taskType: taskType('review', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.09), false) } }),
  ]
  const said = [
    sample('task_classification', 'p1', 'debugging', { labelSource: 'human', label: 'refactor', negativeLabel: 'debugging' }),
    sample('task_classification', 'p2', 'testing', { labelSource: 'human', label: 'testing' }),
    // Laya's answer was too flat: never a row of any source.
    sample('task_classification', 'p3', 'review', { labelSource: 'human', label: null, negativeLabel: 'review' }),
  ]
  // Laya Auto: its own runs, a person's word on them and their failures, kept apart.
  const layaSamples = [
    layaSample('task_classification', 'la1', 'debugging', { labelSource: 'human', label: 'debugging' }),
    layaSample('task_classification', 'la2', 'refactor', { labelSource: 'verified_negative', negativeLabel: 'refactor' }),
    layaSample('task_classification', 'la3', 'testing', null),
    layaSample('task_classification', 'la4', 'other', { labelSource: 'verified_negative', negativeLabel: 'other' }, { informative: false }),
    layaSample('task_classification', 'la5', 'review', { labelSource: 'human', label: 'review' }, { identity: 'laya-0.3.24|english|ffffffffffff|adapter-1|corr:choice:11+=3.27|margin:0.1' }),
  ]
  const tc = standingOf(standing({ shadowRows: tcRows, jevSamples: said, layaSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW }), 'task_classification')
  assert.deepEqual(tc.laya.personSaid, { n: 3, right: 3 }, 'p1 and p2 in the shadow, la1 in Laya Auto')
  assert.deepEqual(tc.jev.personSaid, { n: 3, right: 1 })
  assert.deepEqual(tc.laya.layaAutoFailed, { runs: 3, failed: 1 })
  assert.deepEqual(tc.laya.whereJevWasContradicted, { n: 0, right: 0 })
  const cd = domainOf(compare({ shadowRows: tcRows, jevSamples: said, layaSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW }), 'task_classification')
  assert.deepEqual(cd.personSaid, { n: 2, jevRight: 1, layaRight: 2 })
  assert.deepEqual(cd.layaAutoRuns, { runs: 3, failed: 1 })
})

test('the runs Laya decided are counted apart: what Laya answered, and its informative share, are the shadow\'s', () => {
  const P7 = [0.4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]
  const rev = (informative) => row({ phase: 'review', attempt: 0, review: { risk: 0.5, blockAccept: false, reviewed: false }, jev: { disposition: choice('PASS', P7) }, laya: { disposition: laya(choice('PASS', P7), informative) } })
  const shadowRows = [rev(true), rev(false)]
  // Laya Auto: one disposition as Laya gave it, and three too flat to use, which still decide the
  // review domain and which 6.3 keeps out of every figure.
  const layaSamples = [
    layaSample('outcome_disposition', 'la1', 'PASS', null, { extra: { decidedAt: 0 } }),
    ...[2, 3, 4].map((i) => layaSample('outcome_disposition', `la${i}`, 'PASS', null, { informative: false, extra: { decidedAt: 0 } })),
    layaSample('task_classification', 'la5', 'debugging', null),
  ]
  const at = (rows, samples) => standing({ shadowRows: rows, layaSamples: samples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const od = standingOf(at(shadowRows, layaSamples), 'outcome_disposition')
  assert.equal(od.laya.answered, 2)
  assert.equal(od.laya.informativeShare, 0.5)
  assert.deepEqual(od.laya.layaAutoFailed, { runs: 1, failed: 0 })
  const alone = standingOf(at([], layaSamples), 'outcome_disposition')
  assert.equal(alone.laya.answered, 0, 'nothing was answered beside Jev')
  assert.equal(alone.laya.informativeShare, null)
  assert.deepEqual(alone.laya.layaAutoFailed, { runs: 1, failed: 0 })
  const tc = standingOf(at([], layaSamples), 'task_classification')
  assert.deepEqual([tc.laya.answered, tc.laya.informativeShare], [0, null])
  const cmp = compare({ shadowRows, layaSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.equal(domainOf(cmp, 'outcome_disposition').layaAnswered, 2)
  assert.equal(domainOf(cmp, 'task_classification').layaAnswered, 0)
  assert.deepEqual(domainOf(cmp, 'task_classification').layaAutoRuns, { runs: 1, failed: 0 })
})

test('a domain with no Laya Auto runs has { n: 0 } there, as every source with no rows', () => {
  const cmp = compare({ shadowRows: [row({ jev: { taskType: taskType('debugging', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } })], identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  for (const d of cmp.domains) {
    assert.deepEqual(d.layaAutoRuns, { n: 0 }, d.domain)
    assert.deepEqual(d.personSaid, { n: 0 }, d.domain)
    assert.deepEqual(d.whereJevWasContradicted, { n: 0 }, d.domain)
  }
})

test('with Laya\'s settings invalid, a comparison of every identity reads the stored rows and leaves out what needs Laya\'s bars', () => {
  const { laya: none, layaError } = resolveProviders({ laya: { thresholds: { accept: { low: 1.5 } } } }, {})
  assert.equal(none, null)
  assert.ok(layaError)
  const thresholds = { jev: JEV.thresholds, laya: none }
  const nouls = (q, mark = (a) => a) => Object.fromEntries(Object.entries({ addressed: noul(q), complete: noul(q), unrelatedChanges: noul(0.1), regressionRisk: noul(0.1), needsPerson: noul(0.1) }).map(([k, v]) => [k, mark(v)]))
  // Recorded earlier, under valid settings.
  const stored = [
    row({ phase: 'review', attempt: 0, review: { risk: 0.5, blockAccept: false, reviewed: false }, jev: nouls(0.9), laya: nouls(0.9, laya) }),
    row({ groups: ['resource', 'judgments'], jev: { secondOpinion: noul(0.3) }, laya: { secondOpinion: laya(noul(0.55)) } }),
    row({ jev: { taskType: taskType('debugging', 0.7), needsTests: noul(0.4), humanReview: noul(0.65) }, laya: { taskType: laya(taskType('debugging', 0.6)), needsTests: laya(noul(0.4)), humanReview: laya(noul(0.62)) } }),
  ]
  let cmp
  assert.doesNotThrow(() => { cmp = compare({ shadowRows: stored, identity: ID, thresholds, jevHost: HOST, scope: 'all', days: 'all', now: NOW }) })
  // What needs no bar is read as always.
  assert.deepEqual(cmp.questions.find((q) => q.name === 'taskType').agree.all, { n: 1, agree: 1 })
  assert.deepEqual(cmp.questions.find((q) => q.name === 'humanReview').agree.all, { n: 1, agree: 1 })
  assert.deepEqual(domainOf(cmp, 'task_classification').agree.all, { n: 1, agree: 1 })
  assert.equal(cmp.actions.review.jev.accept, 1, 'Jev\'s own action at its own bars')
  // What needs Laya's bars is left out, never read against no bar.
  assert.equal(cmp.questions.find((q) => q.name === 'humanReview').atBar, null)
  assert.deepEqual(cmp.actions.review.laya, { accept: 0, second_review: 0, human: 0, retry: 0, belowAcceptBar: 0 })
  assert.deepEqual(Object.fromEntries(cmp.actions.wouldHaveActedSame.map((w) => [w.what, w.n])), { task_type: 1, capability: 0, strategy: 0, second_opinion: 0, checks_required: 0, needs_human: 0, review_action: 0 })
  assert.equal(domainOf(cmp, 'second_opinion').layaAnswered, 0)
  assert.equal(domainOf(cmp, 'review_action').layaAnswered, 0)
  let st
  assert.doesNotThrow(() => { st = standing({ shadowRows: stored, identity: ID, thresholds, jevHost: HOST, now: NOW }) })
  assert.equal(st.length, GROUPS.length)
})

// ---------------------------------------------------------------- separation

test('identity, thresholds and Jev host are kept apart', () => {
  const same = { jev: { taskType: taskType('debugging', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } }
  const rows = [
    row(same),
    row({ ...same, identity: 'laya-0.3.24|english|ffffffffffff|adapter-1|corr:choice:11+=3.27|margin:0.1' }),
    row({ ...same, thresholds: { jev: HASHES.jev, laya: 'aaaaaaaaaaaa' } }),
    row({ ...same, host: 'jev.example.test' }),
    row({ ...same, ts: iso(8 * 24 * 60) }),
  ]
  const current = compare({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.equal(current.questions.find((x) => x.name === 'taskType').compared, 1)
  assert.equal(current.identity, ID)
  assert.deepEqual(current.thresholds, HASHES)
  assert.equal(current.jevHost, HOST)
  const week = compare({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, scope: 'all', now: NOW })
  assert.equal(week.questions.find((x) => x.name === 'taskType').compared, 4)
  const ever = compare({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, scope: 'all', days: 'all', now: NOW })
  assert.equal(ever.questions.find((x) => x.name === 'taskType').compared, 5)
  assert.equal(ever.identity, 'all')
  // A change of Laya's thresholds changes the pair every figure is read under.
  const moved = resolveProviders({ laya: { thresholds: { tool: 0.9 } } }, {}).laya.thresholds
  assert.notEqual(thresholdsHash(moved), HASHES.laya)
  assert.equal(thresholdsHash({ b: 1, a: { d: 2, c: 3 } }), thresholdsHash({ a: { c: 3, d: 2 }, b: 1 }), 'key order does not matter')
  const st = standing({ shadowRows: rows, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  assert.equal(standingOf(st, 'task_classification').laya.answered, 2, 'the standing reads the current identity, pair and host, of any age')
})

// ---------------------------------------------------------------- the shapes

/** The comparison of 8.4 as the design writes it: the shape to match, key for key. */
const DESIGN_8_4 = {
  identity: 'x', thresholds: { jev: 'x', laya: 'x' }, jevHost: 'x', days: 7,
  questions: [{ name: 'taskType', type: 'choice', options: 12, corrected: 40, compared: 41, agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } }, inTopTwo: 33, meanDifference: null, atBar: null, flat: 11, layaMedianMs: 950 }],
  domains: [{ domain: 'task_classification', question: 'taskType', layaAnswered: 41, agree: { all: { n: 41, agree: 22 }, informative: { n: 30, agree: 19 } }, personSaid: { n: 4, jevRight: 3, layaRight: 2 }, whereJevWasContradicted: { n: 3, layaRight: 1 }, layaAutoRuns: { runs: 12, failed: 2 }, fieldAgreement: { risk: 0.64 } }],
  actions: { wouldHaveActedSame: [{ what: 'review_action', n: 20, same: 11 }], review: { jev: { accept: 12, second_review: 3, human: 1, retry: 4, belowAcceptBar: 3 }, laya: { accept: 5, second_review: 10, human: 1, retry: 4, belowAcceptBar: 10 } } },
  skips: { answered: 120, partial: 2, failed: 1, skipped: { not_running: 3, starting: 1, queue_full: 0, too_old: 0, jev_failed: 1, yielded: 2 }, atContextLimit: 0 },
  latency: { jev: { intent: 110, route: 900, review: 800 }, laya: { intent: 300, route: 950, review: 600 } },
  standing: [],
}
/** The standing row of 6.7. */
const DESIGN_6_7 = {
  ts: 'x', identity: 'x', domain: 'x',
  laya: { answered: 1, informativeShare: 1, agreementWithJev: { all: { n: 1, agree: 1 }, informative: { n: 1, agree: 1 } }, personSaid: { n: 1, right: 1 }, whereJevWasContradicted: { n: 1, right: 1 }, layaAutoFailed: { runs: 1, failed: 1 }, fieldAgreement: { risk: 0.64 } },
  jev: { acted: 1, personSaid: { n: 1, right: 1 } },
}
/** Every key path of a value, arrays read through their first item, open maps (fieldAgreement) as one. */
function shape(v, path = '$', out = new Set()) {
  if (path.endsWith('.fieldAgreement')) return out
  if (Array.isArray(v)) { out.add(`${path}[]`); if (v.length) shape(v[0], `${path}[]`, out) } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) { out.add(`${path}.${k}`); shape(v[k], `${path}.${k}`, out) }
  }
  return out
}

test('the comparison has exactly the shape of 8.4, and the standing that of 6.7', () => {
  const r = row({ runId: 'shape', jev: { taskType: taskType('debugging', 0.7), risk: score(2, [0.1, 0.2, 0.4, 0.2, 0.1]) }, laya: { taskType: laya(taskType('debugging', 0.6)), risk: laya(score(2.1, [0.1, 0.2, 0.3, 0.3, 0.1])) } })
  const contradicted = row({ runId: 'shape2', jev: { taskType: taskType('refactor', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } })
  const jevSamples = [
    sample('task_classification', 'shape', 'debugging', { labelSource: 'human', label: 'debugging' }),
    sample('task_classification', 'shape2', 'refactor', { labelSource: 'verified_outcome', label: 'debugging', negativeLabel: 'refactor' }),
  ]
  const layaSamples = [layaSample('task_classification', 'la', 'debugging', { labelSource: 'verified_negative', negativeLabel: 'debugging' })]
  const cmp = compare({ shadowRows: [r, contradicted], jevSamples, layaSamples, identity: ID, thresholds: THRESHOLDS, jevHost: HOST, now: NOW })
  const td = domainOf(cmp, 'task_classification')
  const got = shape({ ...cmp, questions: cmp.questions.filter((q) => q.name === 'taskType'), domains: [td], standing: [] })
  assert.deepEqual([...got].sort(), [...shape(DESIGN_8_4)].sort())
  assert.deepEqual(td.fieldAgreement, { risk: 1 })
  assert.deepEqual(cmp.domains.map((d) => d.domain), GROUPS)
  const tcStanding = standingOf(cmp.standing, 'task_classification')
  assert.deepEqual([...shape(tcStanding)].sort(), [...shape(DESIGN_6_7)].sort())
  assert.equal(tcStanding.identity, ID)
  assert.equal(tcStanding.ts, new Date(NOW).toISOString())
  assert.equal(cmp.standing.length, GROUPS.length)
})

// ---------------------------------------------------------------- no text

test('no text reaches laya-standing.jsonl or the comparison: a marker in a task, an answer, a reason and a tool option key never appears', async () => {
  const { createShadow } = await import('../shadow.js')
  const dir = mkdtempSync(join(tmpdir(), 'kz-standing-'))
  const files = {
    jevSamples: join(dir, 'routing-samples.jsonl'), layaSamples: join(dir, 'laya-samples.jsonl'),
    feedback: join(dir, 'feedback.jsonl'), history: join(dir, 'history.jsonl'), standing: join(dir, 'laya-standing.jsonl'),
  }
  const shadowFile = join(dir, 'laya-shadow.jsonl')
  const r = row({ runId: 'm1', jev: { taskType: taskType('debugging', 0.7) }, laya: { taskType: laya(taskType('debugging', 0.6)) } })
  const rv = row({ runId: 'm1', phase: 'review', attempt: 0, review: { risk: 0.4, blockAccept: false, reviewed: false }, jev: { addressed: noul(0.9), complete: noul(0.9), unrelatedChanges: noul(0.1), regressionRisk: noul(0.1), needsPerson: noul(0.1) }, laya: { addressed: laya(noul(0.9)), complete: laya(noul(0.9)), unrelatedChanges: laya(noul(0.1)), regressionRisk: laya(noul(0.1)), needsPerson: laya(noul(0.1)) } })
  const jl = (rows) => rows.map((x) => `${JSON.stringify(x)}\n`).join('')
  writeFileSync(shadowFile, jl([r, rv]))
  const taught = { ...sample('task_classification', 'm1', 'debugging', null), input: { features: { text: MARKER } } }
  writeFileSync(files.jevSamples, jl([taught, { id: taught.id, outcomeTs: iso(), outcome: { verified: true, labelSource: 'human', label: 'debugging', note: MARKER } }]))
  writeFileSync(files.layaSamples, jl([{ ...layaSample('task_classification', 'la', 'debugging', { labelSource: 'human', label: 'debugging' }), extra: { providerProfile: { note: MARKER } } }]))
  writeFileSync(files.feedback, jl([{ ts: iso(), sessionId: 's', messageId: 'm', runId: 'm1', verdict: 'dislike', reason: `wrong ${MARKER}`, tag: 'misread my question' }]))
  writeFileSync(files.history, jl([{ runId: 'm1', task: `Fix ${MARKER}`, workspace: `/home/${MARKER}`, context: { branch: MARKER }, finalStatus: 'accepted', attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', answerExcerpt: MARKER, changedFiles: [`${MARKER}.js`] }], routing: { toolArgs: { style: MARKER } } }]))
  const shadow = createShadow({ file: shadowFile, laya: { identity: () => ID, offerShadow: () => ({ dropped: 'not_running' }), withdraw: () => false }, providers: { jev: JEV, laya: LAYA }, jevHost: HOST, files, now: () => NOW })
  const rows = await shadow.recordStanding()
  assert.equal(rows.length, GROUPS.length)
  assert.deepEqual(standingOf(rows, 'review_action').jev.personSaid, { n: 1, right: 0 }, 'the dislike was read, its words were not')
  const written = readFileSync(files.standing, 'utf8')
  assert.equal(written.trim().split('\n').length, GROUPS.length)
  assert.equal(written.includes(MARKER), false)
  const cmp = await shadow.compare({ days: 'all' })
  assert.equal(JSON.stringify(cmp).includes(MARKER), false)
  // Both files were read: the shadow row is what Laya answered, the Laya Auto run is counted apart.
  assert.equal(domainOf(cmp, 'task_classification').layaAnswered, 1)
  assert.deepEqual(domainOf(cmp, 'task_classification').layaAutoRuns, { runs: 1, failed: 0 })
})

// What scripts/jev-triage.mjs is allowed to throw away, and what it must do when Jev is
// not there. A filter in front of VERIFY only pays for itself if a failed network call
// cannot cost a real finding, and if everything it removed can still be read afterwards.
// Jev is stubbed here: the shape of the call is checked, the API is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { triage } from '../../../scripts/jev-triage.mjs'

const FINDINGS = [
  { file: 'a.js', line: 10, severity: 'medium', problem: 'sum() returns NaN for an empty list', failure: 'totals render as NaN', fix: 'return 0' },
  { file: 'a.js', line: 12, severity: 'critical', problem: 'empty input makes the total NaN', failure: 'the dashboard shows NaN', fix: 'guard the empty case' },
  { file: 'b.js', line: 4, severity: 'high', problem: 'this file feels over-engineered', failure: 'harder to read', fix: 'simplify' },
]

/** One stubbed Jev call. `plan` overrides answers per finding index; everything else is a confident keep. */
function stub(plan = {}) {
  const calls = []
  const ask = async (state, questions) => {
    calls.push({ state, questions })
    const answers = {}
    for (const name of Object.keys(questions)) {
      const i = Number(name.split('.')[1].slice(1))
      if (name.startsWith('testable.')) answers[name] = { type: 'noul', noul: plan.testable?.[i] ?? 0.9 }
      if (name.startsWith('severity.')) answers[name] = { type: 'score', score: plan.severity?.[i] ?? 2, confidence: 0.9, probabilities: {} }
      if (name.startsWith('dup.')) answers[name] = { type: 'choice', choice: plan.dup?.[i] ?? 'none', confidence: plan.dupConfidence?.[i] ?? 0.95, probabilities: {} }
    }
    return { model: 'jev-test', requestId: 'req_1', ms: 700, usage: { input_tokens: 1000, output_tokens: 20 }, answers }
  }
  return { ask, calls }
}

test('Jev unreachable: every finding passes through and stats says why', async () => {
  const out = await triage(FINDINGS, { ask: async () => { throw new Error('fetch failed') } })
  assert.deepEqual(out.kept, FINDINGS)
  assert.deepEqual(out.dropped, [])
  assert.equal(out.stats.jev.ran, false)
  assert.match(out.stats.jev.reason, /fetch failed/)
  assert.equal(out.stats.kept, FINDINGS.length)
})

test('an answer that does not parse fails open too', async () => {
  const out = await triage(FINDINGS, { ask: async () => ({ model: 'jev-test', answers: { 'testable.f0': { noul: 'yes' } } }) })
  assert.deepEqual(out.kept, FINDINGS)
  assert.equal(out.stats.jev.ran, false)
})

test('a dropped finding is always in `dropped`, with a reason and a confidence', async () => {
  const { ask } = stub({ testable: { 2: 0.05 }, dup: { 1: 'f0' } })
  const { kept, dropped, stats } = await triage(FINDINGS, { ask })

  assert.equal(kept.length, 1, 'one merged pair kept, the opinion dropped')
  assert.equal(dropped.length, 2)
  assert.equal(kept.length + dropped.length, FINDINGS.length, 'nothing vanished')
  for (const d of dropped) {
    assert.ok(d.reason, 'a dropped finding carries a reason')
    assert.ok(typeof d.confidence === 'number' && d.confidence > 0, 'and the confidence behind it')
    assert.ok(d.problem, 'and its own text, so it can still be read')
  }
  assert.match(dropped.find((d) => d.file === 'b.js').reason, /no testable claim/)
  assert.match(dropped.find((d) => d.file === 'a.js').reason, /merged/)
  assert.equal(stats.merged, 1)
  assert.equal(stats.droppedNoClaim, 1)
  assert.equal(stats.jev.ran, true)
  assert.equal(stats.jev.tokens.input, 1000)
  assert.ok(stats.jev.costUsd > 0)
})

test('merging keeps the harshest severity and counts the reviewers who saw it', async () => {
  const { ask } = stub({ dup: { 1: 'f0' } })
  const { kept } = await triage(FINDINGS, { ask })
  const merged = kept.find((k) => k.file === 'a.js')

  assert.equal(merged.severity, 'critical', 'the harshest of the two, not the first one seen')
  assert.equal(merged.line, 10, 'the rest of the entry is the first reviewer\'s')
  assert.equal(merged.mergedFrom.length, 1)
  assert.equal(merged.mergedFrom[0].problem, FINDINGS[1].problem)
  assert.equal(merged.jevSeverity, 'medium', 'Jev\'s own severity rides alongside, it does not replace')
})

test('an unconfident judgment keeps the finding', async () => {
  // 0.4 is a shrug about whether there is a claim, and 0.6 a shrug about the duplicate.
  // Neither is allowed to remove anything: a filter is only as safe as this test.
  const { ask } = stub({ testable: { 2: 0.4 }, dup: { 1: 'f0' }, dupConfidence: { 1: 0.6 } })
  const { kept, dropped } = await triage(FINDINGS, { ask })
  assert.equal(kept.length, 3)
  assert.deepEqual(dropped, [])
})

test('one call, a question per finding, and no cross-file comparison', async () => {
  const { ask, calls } = stub()
  await triage(FINDINGS, { ask })

  assert.equal(calls.length, 1, 'the whole set rides one call')
  const names = Object.keys(calls[0].questions)
  // 3 findings: testable and severity each, plus one duplicate question for the second
  // finding in a.js. b.js is alone in its file, so it is never compared with anything.
  assert.equal(names.length, 7)
  assert.deepEqual(names.filter((n) => n.startsWith('dup.')), ['dup.f1'])
  assert.deepEqual(Object.keys(calls[0].questions['dup.f1'].criteria), ['none', 'f0'])
})

test('an empty list costs nothing', async () => {
  const { ask, calls } = stub()
  const out = await triage([], { ask })
  assert.equal(calls.length, 0)
  assert.deepEqual(out.kept, [])
  assert.equal(out.stats.jev.ran, false)
})

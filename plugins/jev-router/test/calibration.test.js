// Confidence calibration: decile bucketing, the routing-quality label, and the refusal to
// report a rate from too few runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_CALIBRATION_SAMPLES, calibration } from '../usage.js'

/** One run: confidence `c`, picked `agent`, ending `finalStatus` after `work` attempts. */
const run = (c, { agent = 'claude', finalStatus = 'accepted', work = [{ agent, role: 'primary' }], ...rest } = {}) =>
  ({ routing: { agentConfidence: c, primaryAgent: agent }, attempts: work, finalStatus, ...rest })
const many = (n, c, opts) => Array.from({ length: n }, () => run(c, opts))
const bucket = (r, range) => r.buckets.find((b) => b.range === range)

test('deciles: one bucket per tenth, 1.0 lands in the top one', () => {
  const r = calibration([run(0), run(0.09), run(0.1), run(0.56), run(0.99), run(1)])
  assert.equal(bucket(r, '0-0.1').n, 2)
  assert.equal(bucket(r, '0.1-0.2').n, 1)
  assert.equal(bucket(r, '0.5-0.6').n, 1)
  assert.equal(bucket(r, '0.9-1').n, 2)
  assert.equal(r.buckets.length, 10)
  assert.equal(r.scored, 6)
  assert.equal(bucket(r, '0.5-0.6').meanConfidence, 0.56)
  assert.equal(bucket(r, '0.9-1').meanConfidence, 1) // (0.99 + 1) / 2, rounded to 2dp
})

test('too few runs: counts are reported, rates are refused', () => {
  const r = calibration(many(MIN_CALIBRATION_SAMPLES - 1, 0.85))
  const b = bucket(r, '0.8-0.9')
  assert.equal(b.n, MIN_CALIBRATION_SAMPLES - 1)
  assert.equal(b.successes, MIN_CALIBRATION_SAMPLES - 1)
  assert.equal(b.successRate, null)
  assert.equal(r.overall.successRate, null)
  assert.match(r.note, /not enough data/)
  // Every bucket carries its own n, so no rate can be read without one.
  for (const x of r.buckets) assert.equal(typeof x.n, 'number')
})

test('enough runs: the rate appears, still next to its n', () => {
  const rows = [...many(MIN_CALIBRATION_SAMPLES - 2, 0.85), ...many(2, 0.85, { finalStatus: 'needs_human' })]
  const b = bucket(calibration(rows), '0.8-0.9')
  assert.equal(b.n, MIN_CALIBRATION_SAMPLES)
  assert.equal(b.successRate, (MIN_CALIBRATION_SAMPLES - 2) / MIN_CALIBRATION_SAMPLES)
  assert.equal(calibration(rows).note, `1 of 10 deciles have at least ${MIN_CALIBRATION_SAMPLES} scored runs; the rest report counts only`)
})

test('label: accepted by the picked agent counts, a peer rescue does not', () => {
  const own = run(0.5, { agent: 'deepseek', work: [{ agent: 'deepseek', role: 'primary' }, { agent: 'deepseek', role: 'retry' }] })
  const peer = run(0.5, { agent: 'deepseek', work: [{ agent: 'deepseek', role: 'primary' }, { agent: 'claude', role: 'retry' }] })
  const pending = run(0.5, { agent: 'deepseek', finalStatus: 'accepted_pending_human_review' })
  const human = run(0.5, { agent: 'deepseek', finalStatus: 'needs_human' })
  const r = calibration([own, peer, pending, human], { minSamples: 1 })
  assert.equal(bucket(r, '0.5-0.6').n, 4)
  assert.equal(bucket(r, '0.5-0.6').successes, 2)
  assert.equal(bucket(r, '0.5-0.6').successRate, 0.5)
})

test('label: a review attempt after the work does not break the pick', () => {
  const r = calibration([run(0.5, { work: [{ agent: 'claude', role: 'primary' }, { agent: 'codex', role: 'review' }] })], { minSamples: 1 })
  assert.equal(bucket(r, '0.5-0.6').successes, 1)
})

test('dropped: no confidence, usage limits and handoff continuations are not failures', () => {
  const r = calibration([
    { routing: { primaryAgent: 'claude' }, finalStatus: 'accepted' },
    run(null),
    run(1.5),
    run(0.5, { finalStatus: 'paused_limit' }),
    run(0.5, { work: [{ agent: 'claude', role: 'primary', limitHit: true }] }),
    run(0.5, { continuedFromHandoff: true }),
  ], { minSamples: 1 })
  assert.equal(r.runs, 6)
  assert.equal(r.scored, 0)
  assert.deepEqual(r.skipped, { noConfidence: 3, unscorable: 3 })
  assert.equal(r.overall.successRate, null)
  assert.equal(r.overall.meanConfidence, null)
})

test('no rows at all', () => {
  const r = calibration([])
  assert.equal(r.scored, 0)
  assert.equal(r.minSamples, MIN_CALIBRATION_SAMPLES)
  assert.equal(r.buckets.every((b) => b.successRate === null && b.meanConfidence === null), true)
})

// Review decision bands and tool selection signals, without a repo or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createReview } from '../../jev-review/index.js'
import { createJev } from '../jev.js'

const thresholds = { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7 }
const signal = new AbortController().signal
const cmp = { regressed: [], failing: [] }
const input = (routing, over = {}) => ({
  task: 't', routing, attempts: [{ agent: 'a', stopReason: 'completed' }], checks: [], cmp, diff: {}, agents: [],
  blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'b', ...over,
})
// quality = min(addressed, complete, 1 - unrelated, 1 - regression) = q
const nouls = (q, over = {}) => ({ verdict: 'accept', verdictConfidence: 0.9, addressed: q, complete: 1, unrelatedChanges: 0, regressionRisk: 0, needsPerson: 0, ...over })
const run = (answers, routing, over) => createReview({ assess: async () => answers }, thresholds)(input(routing, over), signal)

test('accept bar scales with routing risk', async () => {
  assert.equal((await run(nouls(0.6), { risk: 0.1 })).action, 'accept')
  assert.equal((await run(nouls(0.6), { risk: 0.4 })).action, 'second_review')
  assert.equal((await run(nouls(0.8), { risk: 0.4 })).action, 'accept')
  assert.equal((await run(nouls(0.8), { risk: 0.9 })).action, 'second_review')
  assert.equal((await run(nouls(0.8), {})).action, 'accept') // missing risk = 0.5 -> medium bar
  const r = await run(nouls(0.72), { risk: 0.02 })
  assert.equal(r.why, 'quality 0.72 ≥ bar 0.55 (risk 0.02)')
  assert.equal(r.status, 'accepted')
})

test('low band retries, middle band goes to a person once reviewed', async () => {
  assert.equal((await run(nouls(0.3), { risk: 0.1 })).action, 'retry')
  assert.equal((await run(nouls(0.95, { unrelatedChanges: 0.8 }), { risk: 0.1 })).action, 'retry')
  assert.equal((await run(nouls(0.5), { risk: 0.1 }, { reviewed: true })).action, 'human')
})

test('needsPerson goes to human; blockAccept always wins', async () => {
  assert.equal((await run(nouls(0.95, { needsPerson: 0.7 }), { risk: 0.1 })).action, 'human')
  const r = await run(nouls(0.95, { needsPerson: 0.9 }), { risk: 0.1 }, { blockAccept: true, cmp: { regressed: ['test'], failing: [] } })
  assert.equal(r.action, 'retry')
  assert.match(r.why, /regressed: test/)
})

test('accept still asks for a second opinion and flags human review', async () => {
  assert.equal((await run(nouls(0.9), { risk: 0.1, needsSecondOpinion: 0.9 })).action, 'second_review')
  const r = await run(nouls(0.9), { risk: 0.1, needsSecondOpinion: 0.9, needsHumanReview: 0.9 }, { reviewed: true })
  assert.equal(r.action, 'accept')
  assert.equal(r.status, 'accepted_pending_human_review')
})

test('route asks a fits Noul per tool and reports weakest argument confidence', async (t) => {
  const traces = []
  let asked
  t.mock.method(TypeSafeClient.prototype, 'systemOne', async ({ questions }) => {
    asked = questions
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k,
      q.type === 'noul' ? { type: 'noul', noul: k === 'weather.fits' ? 0.8 : 0.1 }
        : q.type === 'score' ? { type: 'score', score: 1, confidence: 0.9 }
          : { type: 'choice', choice: k === 'handler' ? 'weather' : Object.keys(q.criteria)[0], confidence: k === 'weather.days' ? 0.55 : 0.9 }]))
    return { model: 'jev-1.13.0', usage: {}, answers }
  })
  const jev = createJev({ apiKey: 'k', model: 'jev-1.13.0', onTrace: (x) => traces.push(x) })
  const tools = [
    { id: 'weather', description: 'weather lookup', params: { units: { question: 'Units?', options: { c: 'C', f: 'F' } }, days: { question: 'Days?', options: { one: '1', seven: '7' } } } },
    { id: 'clock', description: 'current time' },
  ]
  const r = await jev.route({ task: 't', context: {}, agents: [{ id: 'a', description: 'a' }], tools }, signal)
  assert.equal(asked['clock.fits'].type, 'noul')
  assert.equal(r.toolFits, 0.8)
  assert.equal(r.toolArgConfidence, 0.55)
  assert.deepEqual(r.toolArgs, { units: 'c', days: 'one' })
  const used = Object.fromEntries(traces[0].questions.map((q) => [q.name, q.used]))
  assert.equal(used['weather.fits'], true)
  assert.equal(used['weather.days'], true)
  assert.equal(used['clock.fits'], false)
})

test('route adds availability and the continueHandoff Noul only when given', async (t) => {
  const calls = []
  t.mock.method(TypeSafeClient.prototype, 'systemOne', async ({ state, questions }) => {
    calls.push({ state, questions })
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k,
      q.type === 'noul' ? { type: 'noul', noul: k === 'continueHandoff' ? 0.8 : 0.1 }
        : q.type === 'score' ? { type: 'score', score: 1, confidence: 0.9 }
          : { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.9 }]))
    return { model: 'jev-1.13.0', usage: {}, answers }
  })
  const jev = createJev({ apiKey: 'k', model: 'jev-1.13.0' })
  const agents = [{ id: 'a', description: 'a' }]
  const r = await jev.route({ task: 'continue', context: {}, agents, availability: { a: 'near limit' }, handoff: 'x'.repeat(5000) }, signal)
  assert.equal(r.continueHandoff, 0.8)
  assert.deepEqual(calls[0].state.agent_availability, { a: 'near limit' })
  assert.ok(calls[0].state.handoff.length < 3100)
  const plain = await jev.route({ task: 't', context: {}, agents }, signal)
  assert.equal(plain.continueHandoff, undefined)
  assert.equal('continueHandoff' in calls[1].questions, false)
  assert.equal('handoff' in calls[1].state, false)
})

test('built-in limit matcher ignores completed runs that merely mention rate limits', async () => {
  const { builtinLimit } = await import('../router.js')
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: 'You have hit your usage limit' }).hit, true)
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: { category: 'limit' } }).hit, true)
  assert.equal(builtinLimit({ stopReason: 'completed', answerText: 'added a rate limit to the API' }).hit, false)
  assert.equal(builtinLimit({ stopReason: 'error', diagnostic: 'exit 1: TypeError' }).hit, false)
})

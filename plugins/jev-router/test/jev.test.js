// What the router hands to TypeSafe. A key pasted into the chat is masked in the
// log and in the export, so it must not ride along in a Jev payload either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createJev } from '../jev.js'

const KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF'
// One answer shape serves every question: the test only cares what went out.
const ANSWER = { choice: 'claude', score: 2, noul: 0.5, confidence: 1, probabilities: {} }
const AGENTS = [{ id: 'claude', description: 'an agent' }]

/** Capture the state handed to the SDK instead of calling the API. */
function capture() {
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async ({ state }) => {
    sent.push(state)
    return { model: 'jev-test', usage: {}, answers: new Proxy({}, { get: () => ANSWER }) }
  }
  return { sent, restore: () => { TypeSafeClient.prototype.systemOne = real } }
}

test('a key in a task, a diff excerpt or a message never reaches the payload', async (t) => {
  const { sent, restore } = capture()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })

  await jev.route({ task: `call the api with ${KEY}`, context: { branch: 'main' }, agents: AGENTS, history: [] })
  await jev.assess({
    task: 'ship it',
    routing: { taskType: 'implementation', risk: 0.2, complexity: 0.2 },
    attempts: [{ agent: 'claude', role: 'primary', stopReason: 'completed', answerText: `used ${KEY}`, changedFiles: ['a.js'] }],
    checks: [{ check: 'test', passed: false, exit_code: 1, output: `401 for ${KEY}` }],
    diff: { stat: '1 file changed', patch: `+const key = '${KEY}'` },
    agents: AGENTS,
  })
  await jev.intent({ message: `is ${KEY} still valid?` })

  assert.equal(sent.length, 3)
  for (const state of sent) assert.ok(!JSON.stringify(state).includes(KEY), 'a key survived into the payload')
  assert.match(JSON.stringify(sent[0]), /sk-ant\.\.\.REDACTED/)
  // Only the secret goes: gutting the diff or the task would wreck the routing judgment.
  const assessed = JSON.stringify(sent[1])
  assert.ok(assessed.includes('const key ='), 'the diff excerpt is still there')
  assert.ok(assessed.includes('1 file changed') && assessed.includes('a.js'))
})

test('a key typed into the feedback box does not ride out in the track record', async (t) => {
  // agent_track_record is built from the person's own Like/Dislike reasons, so it is the one
  // payload on the routing call that can carry an arbitrary typed sentence. It was the last
  // unscrubbed field, while the README promised keys are masked in everything sent to Jev.
  const { sent, restore } = capture()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })

  await jev.route({
    task: 'fix the parser',
    context: { branch: 'main' },
    agents: AGENTS,
    history: [],
    trackRecord: { claude: { cost_tier: 'subscription', feedback: { likes: 1, dislikes: 0, recent_reasons: [`it kept using ${KEY}`] } } },
  })

  const payload = JSON.stringify(sent[0])
  assert.ok(!payload.includes(KEY), 'a key survived into the track record')
  assert.match(payload, /sk-ant\.\.\.REDACTED/)
  // The reason itself must survive: it is why the record is sent at all.
  assert.ok(payload.includes('it kept using'), 'the reason text was gutted, not just the key')
  assert.ok(payload.includes('subscription'), 'the rest of the record is untouched')
})

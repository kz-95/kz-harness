// What the router hands to TypeSafe. A key pasted into the chat is masked in the
// log and in the export, so it must not ride along in a Jev payload either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { anonymity, createJev } from '../jev.js'

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

// ---------------------------------------------------------------- anonymity of the whole payload

// Every word that names a real resource in these fixtures: ids, providers, models, vendors. Not
// 'spawn': it is the executor mechanism every llm-backed agent shares, so it identifies none, and
// masking it rewrote ordinary diagnostics (decision.js refuses it as a name for the same reason).
const IDENTITY = ['claude', 'codex', 'deepseek', 'anthropic', 'openai', 'gpt', 'opus']

/** Every string in a value, object keys included, however deep. */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out) }
  return out
}
const leaks = (payload) => strings(payload).flatMap((s) => IDENTITY.filter((w) => s.toLowerCase().includes(w)).map((w) => `${w} in ${JSON.stringify(s).slice(0, 120)}`))

/** Capture the whole call (state AND questions) and answer each question by its type. */
function captureCalls(pick = {}) {
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async ({ state, questions }) => {
    sent.push({ state, questions })
    const answers = {}
    for (const [name, q] of Object.entries(questions)) {
      const keys = q.type === 'choice' ? Object.keys(q.criteria) : []
      const choiceOf = typeof pick[name] === 'function' ? pick[name](state, keys) : pick[name] ?? keys[0]
      answers[name] = q.type === 'choice'
        ? { type: 'choice', choice: choiceOf, confidence: 0.8, probabilities: Object.fromEntries(keys.map((k) => [k, k === choiceOf ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) }
        : q.type === 'score' ? { type: 'score', score: 2, confidence: 0.8 } : { type: 'noul', noul: 0.3, confidence: 0.8 }
    }
    return { model: 'jev-test', usage: {}, answers }
  }
  return { sent, restore: () => { TypeSafeClient.prototype.systemOne = real } }
}

const TABLE = [
  { key: 'RESOURCE_A', tier: 'frontier', source: 'subscription', capabilities: { coding: { score: 0.9, confidence: 0.8, samples: 4 } }, scarcity: 0.4, marginalCost: 'low', expectedCost: { total: 0.3, class: 'low' }, latency: 'slow', availability: 'ok', evidenceSamples: 4 },
  { key: 'RESOURCE_B', tier: 'strong', source: 'subscription', capabilities: { coding: { score: 0.8, confidence: 0.8, samples: 9 } }, scarcity: 0.7, marginalCost: 'low', expectedCost: { total: 0.4, class: 'low' }, latency: 'slow', availability: 'near', evidenceSamples: 9 },
]
// What the decision engine knows and the table does not show: which key is which agent.
const IDS = [
  { id: 'claude', key: 'RESOURCE_A', names: ['Claude Code', 'claude-code', 'claude-opus-5'] },
  { id: 'codex', key: 'RESOURCE_B', names: ['Codex (GPT)', 'codex', 'gpt-5.6'] },
  // Configured, but not in this call's table (a hard fact dropped it): it has no key here.
  { id: 'deepseek', key: 'RESOURCE_C', names: ['DeepSeek agent', 'spawn', 'deepseek', 'deepseek-flash'] },
]
const HISTORY = [{ task_type: 'implementation', first_agent: 'claude', attempts: 1, outcome: 'accepted' }, { task_type: 'debugging', first_agent: 'deepseek', attempts: 2, outcome: 'needs_human' }]
const AVAILABILITY = { claude: 'ok', codex: 'near limit', deepseek: 'ok' }
const TRACK = {
  claude: { cost_tier: 'subscription', availability: 'ok', here_by_task_type: { implementation: { attempts: 4, accepted_rate: 0.75 } }, overall: { attempts: 4, accepted_rate: 0.75 }, feedback: { likes: 2, dislikes: 0, recent_reasons: ['good pick: claude fixed it where GPT gave up'] } },
  codex: { cost_tier: 'subscription', price_now: 'off-peak rate right now (OpenAI promo)', availability: 'near limit', here_by_task_type: {}, overall: 'no runs yet' },
  deepseek: { cost_tier: 'api', availability: 'ok', here_by_task_type: {}, overall: 'no runs yet' },
}

test('a routing call with the anonymous table names no agent in any field, and keeps the evidence under the keys', async (t) => {
  // Findings 4, 12 and 17: the table was anonymous, but the same call carried recent_outcomes,
  // agent_availability and agent_track_record keyed by the real ids, with the same facts as the
  // table, so the names lined up with the keys trivially.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({
    task: 'make the failing test pass', context: { branch: 'main' },
    candidates: TABLE, history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, identities: IDS,
    taskProfile: { complexity: 0.5, risk: 0.3 }, ask: { task: false, resource: true, judgments: true },
  })
  assert.equal(sent.length, 1)
  assert.deepEqual(leaks(sent[0]), [], 'a real name rode out next to the anonymous table')
  const s = sent[0].state
  // The information stays; only the name goes.
  assert.equal(s.recent_outcomes[0].first_resource, 'RESOURCE_A', 'the history row is re-keyed to the table key')
  assert.equal(s.recent_outcomes[1].first_resource, undefined, 'a resource outside the table gets no key nothing describes')
  assert.equal(s.recent_outcomes[1].outcome, 'needs_human', 'and the rest of the row survives')
  assert.equal(s.candidate_availability.RESOURCE_B, 'near limit')
  assert.equal(s.candidate_track_record.RESOURCE_A.overall.accepted_rate, 0.75)
  assert.equal(s.candidate_track_record.RESOURCE_A.feedback.recent_reasons[0], 'good pick: RESOURCE_A fixed it where [resource] gave up', 'a typed reason keeps its meaning under the key')
  assert.match(s.candidate_track_record.RESOURCE_B.price_now, /off-peak rate right now/)
  assert.deepEqual(Object.keys(s.candidate_track_record).sort(), ['RESOURCE_A', 'RESOURCE_B'], 'no record for a resource the table does not offer')
  assert.equal(s.agent_track_record, undefined)
  assert.equal(s.agent_availability, undefined)
})

test('without the id-to-key mapping, the per-agent channels are dropped rather than sent under the names', async (t) => {
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({ task: 'fix it', context: {}, candidates: TABLE, history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, ask: { task: false, resource: true } })
  // The decision engine's task-only call carries no table and asks nothing about resources.
  await jev.route({ task: 'fix it', context: {}, history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, ask: { task: true } })
  assert.equal(sent.length, 2)
  for (const call of sent) {
    assert.deepEqual(leaks(call), [])
    assert.equal(call.state.candidate_track_record, undefined)
    assert.equal(call.state.recent_outcomes[0].task_type, 'implementation', 'the history row stays, minus who ran it')
  }
})

test('the legacy named-agent call still reads names: routing.enabled false is documented behaviour', async (t) => {
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const r = await jev.route({ task: 'fix it', context: {}, agents: [{ id: 'claude', description: 'my own words about it' }, { id: 'codex', description: 'mine too' }], history: HISTORY, trackRecord: TRACK })
  assert.equal(r.primaryAgent, 'claude')
  assert.equal(sent[0].questions.agent.criteria.claude.what, 'my own words about it', 'a description the person wrote stays theirs')
  assert.ok(sent[0].state.agent_track_record.claude)
  assert.equal(sent[0].state.recent_outcomes[0].first_agent, 'claude')
})

// The run's own decision record: the id next to each key, and the machine data per candidate.
const DECISION = {
  candidates: [
    { id: 'claude', key: 'RESOURCE_A', source: 'subscription', tier: 'frontier', fit: 0.88, scarcity: 0.4, marginalCost: 'low', expectedCost: { total: 0.3, class: 'low' }, latency: 'slow', availability: 'ok', cold: false, evidenceSamples: 4, plan: 'max', capabilities: { coding: { score: 0.9, confidence: 0.8, samples: 4 }, reliability: { score: 0.85, confidence: 0.6, samples: 4 } } },
    { id: 'deepseek', key: 'RESOURCE_C', source: 'api', tier: 'strong', fit: 0.7, scarcity: 0, marginalCost: 'metered', expectedCost: { total: 0.2, class: 'low' }, latency: 'medium', availability: 'ok', cold: false, evidenceSamples: 12, plan: null, capabilities: { coding: { score: 0.75, confidence: 0.7, samples: 12 } } },
  ],
}
const REVIEW_AGENTS = [
  { id: 'claude', name: 'Claude Code', provider: 'claude-code', description: 'Claude Code: architecture, planning, large-context understanding' },
  { id: 'codex', name: 'Codex (GPT)', provider: 'codex', description: 'OpenAI Codex: implementation, debugging, writing and running tests' },
  { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' }, description: 'DeepSeek: code review, second opinions' },
]
const assessInput = (routing) => ({
  task: 'make the failing test pass',
  routing: { taskType: 'implementation', risk: 0.3, complexity: 0.4, ...routing },
  attempts: [
    { agent: 'deepseek', role: 'primary', stopReason: 'error', diagnostic: { message: 'deepseek-flash via spawn: 429 from the DeepSeek API' }, answerText: 'ran out', changedFiles: [] },
    { agent: 'claude', role: 'retry', stopReason: 'completed', answerText: 'fixed the parser', changedFiles: ['a.js'] },
  ],
  // The shape jev-review really hands over: results plus the comparison, not a bare array.
  checks: { results: [{ check: 'test', passed: true, exit_code: 0, output: '' }], regressed: [], fixed: ['test'], failing: [] },
  diff: { stat: '1 file changed', patch: '+ok' },
  agents: REVIEW_AGENTS,
  strategy: 'STANDARD_DIRECT',
})

test('the review and retry picks are made over the anonymous candidate data, and the key comes back as an agent id', async (t) => {
  // Finding 11: the reviewAgent and retryAgent options were the agents' prose descriptions,
  // keyed by id, with no machine data in the state at all, so the prose (which contradicted
  // the owner's capability priors) decided every review and every retry.
  const { sent, restore } = captureCalls({
    // Answer from the machine data: the reviewer is the frontier one, the fixer the metered one.
    reviewAgent: (state) => state.candidates.find((c) => c.tier === 'frontier')?.key,
    retryAgent: (state) => state.candidates.find((c) => c.marginal_cost === 'metered')?.key,
  })
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const a = await jev.assess(assessInput({ decision: DECISION }))

  assert.equal(sent.length, 1)
  assert.deepEqual(leaks(sent[0]), [], 'a real name rode out in the review call')
  const { state, questions } = sent[0]
  for (const q of ['reviewAgent', 'retryAgent']) {
    const keys = Object.keys(questions[q].criteria)
    assert.ok(keys.every((k) => /^RESOURCE_[A-Z]\d*$/.test(k)), `${q} options are keys: ${keys}`)
    assert.ok(!JSON.stringify(questions[q]).includes('architecture'), `${q} is not answered over a capability claim in prose`)
    assert.match(questions[q].criteria.RESOURCE_A.what, /tier frontier · coding 0\.9/, 'the option is the machine-readable line')
  }
  // codex was not in the decision table (the record does not say why); it still gets a key, one
  // that cannot collide with the engine's, and is marked as outside the table.
  const outside = state.candidates.find((c) => c.candidate_for_work === false)
  assert.ok(outside && !['RESOURCE_A', 'RESOURCE_C'].includes(outside.key), JSON.stringify(state.candidates))
  assert.equal(state.candidates.find((c) => c.key === 'RESOURCE_A').task_fit, 0.88)
  assert.equal(state.candidates.find((c) => c.key === 'RESOURCE_A').reliability.score, 0.85)
  assert.deepEqual(state.attempts.map((x) => x.resource), ['RESOURCE_C', 'RESOURCE_A'], 'who tried is a key too')
  // Every name in it belongs to the one keyed resource, so it reads as that key and keeps its meaning.
  // 'spawn' is how the agent runs, shared by every llm-backed agent: it names nothing, so it stays.
  assert.equal(state.attempts[0].diagnostic.message, 'RESOURCE_C via spawn: 429 from the RESOURCE_C API', 'and the executor diagnostic is masked, not dropped')
  assert.deepEqual(state.verification.fixed, ['test'], 'the check comparison rides along')
  assert.equal(state.verification.results[0].check, 'test')

  // Mapped back in code: the caller acts on agent ids, exactly as before.
  assert.equal(a.reviewAgent, 'claude')
  assert.equal(a.retryAgent, 'deepseek')
  assert.deepEqual(Object.keys(a.retryAgentProbabilities).sort(), ['claude', 'codex', 'deepseek'])
  assert.equal(a.retryAgentProbabilities.deepseek, 0.8)
})

test('the review call accepts the check shape jev-review really sends', async (t) => {
  // jev-review passes `{ results, ...compareChecks }`. Reading it as an array threw on every
  // real review since the scrubber landed, and the review silently fell back to the policy.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const a = await jev.assess(assessInput({}))
  assert.equal(sent.length, 1, 'the call was made instead of throwing before it')
  assert.equal(typeof a.addressed, 'number')
  // No decision record (legacy routing): the options stay the named agents and their descriptions.
  assert.equal(sent[0].questions.reviewAgent.criteria.codex.what, REVIEW_AGENTS[1].description)
  assert.equal(a.reviewAgent, 'claude')
})

// ---------------------------------------------------------------- what the masker may touch

// A local agent as config.example.json has it: the provider and the cost tier are generic words.
const LOCAL_AGENT = { id: 'qwen-local', name: 'Qwen local', provider: 'spawn', kind: 'local', llm: { provider: 'local', model: 'qwen2.5-coder:7b' } }
// A caller that passes every string it has, generic ones included. The masker must refuse those.
const LOCAL_IDS = [{ id: 'qwen-local', key: 'RESOURCE_A', names: ['Qwen local', 'local', 'spawn', 'free-local', 'qwen2.5-coder:7b'] }]
const LOCAL_TABLE = [{ key: 'RESOURCE_A', tier: 'standard', source: 'local', capabilities: { coding: { score: 0.5, confidence: 0.5, samples: 2 } }, scarcity: 0, marginalCost: 'free', expectedCost: { total: 0, class: 'free' }, latency: 'fast', availability: 'ok', evidenceSamples: 2 }]
const localTrack = () => ({
  'qwen-local': {
    cost_tier: 'free-local', availability: 'ok',
    here_by_task_type: { review: { attempts: 3, accepted_rate: 0.67 }, implementation: { attempts: 1, accepted_rate: null, note: 'too few attempts to judge' } },
    overall: { attempts: 4, accepted_rate: 0.5 },
    feedback: { likes: 1, dislikes: 0, suggested: 0, recent_reasons: ['qwen2.5-coder:7b did the review fine, local is fast'] },
  },
})

test('a local agent keeps its cost tier and its per-task-type record: structured values and keys are never masked', async (t) => {
  // The masker treated every configured string as a name and rewrote every string and object key
  // in the channel, so with a name of 'local' the one categorical cost fact went out as
  // 'free-[resource]' (or 'free-RESOURCE_A' with one local agent), and a task type that is also
  // an agent id became a key.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({
    task: 'review the parser', context: {}, candidates: LOCAL_TABLE, identities: LOCAL_IDS,
    history: [{ task_type: 'review', first_agent: 'qwen-local', attempts: 1, outcome: 'accepted' }],
    availability: { 'qwen-local': 'ok' }, trackRecord: localTrack(),
    taskProfile: { complexity: 0.2, risk: 0.1 }, ask: { task: false, resource: true, judgments: false },
  })
  const s = sent[0].state
  const rec = s.candidate_track_record.RESOURCE_A
  assert.equal(rec.cost_tier, 'free-local', 'the cost tier is a category, not text to mask')
  assert.deepEqual(Object.keys(rec.here_by_task_type).sort(), ['implementation', 'review'], 'task-type keys stay task types')
  assert.equal(rec.here_by_task_type.implementation.note, 'too few attempts to judge')
  // Free text is still masked, by the specific names only: the model id is this resource, 'local' is a word.
  assert.equal(rec.feedback.recent_reasons[0], 'RESOURCE_A did the review fine, local is fast')
  assert.deepEqual(s.recent_outcomes[0], { task_type: 'review', attempts: 1, outcome: 'accepted', first_resource: 'RESOURCE_A' })
  assert.equal(s.candidate_availability.RESOURCE_A, 'ok')
  assert.ok(!JSON.stringify(s).toLowerCase().includes('qwen'), 'and the specific names are gone')
})

test('with two local agents a shared generic word is still not a name, and a task-type id is re-keyed only where it is an id', async (t) => {
  // An agent whose id is a task-type word: its record is re-keyed by id (the map's keys ARE ids),
  // but the word itself is never masked in a task-type key, a history row or a sentence.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const table = [LOCAL_TABLE[0], { ...LOCAL_TABLE[0], key: 'RESOURCE_B' }]
  const track = { ...localTrack(), review: { cost_tier: 'free-local', here_by_task_type: { review: { attempts: 5, accepted_rate: 0.8 } }, overall: { attempts: 5, accepted_rate: 0.8 }, feedback: { likes: 0, dislikes: 1, suggested: 0, recent_reasons: ['the review agent missed a bug in review'] } } }
  await jev.route({
    task: 'review the parser', context: {}, candidates: table,
    identities: [...LOCAL_IDS, { id: 'review', key: 'RESOURCE_B', names: ['review', 'local', 'free-local', 'rv'] }],
    history: [{ task_type: 'review', first_agent: 'review', attempts: 1, outcome: 'accepted' }, { task_type: 'debugging', first_agent: 'qwen-local', attempts: 2, outcome: 'failed' }],
    trackRecord: track, taskProfile: { complexity: 0.2, risk: 0.1 }, ask: { task: false, resource: true, judgments: false },
  })
  const s = sent[0].state
  assert.deepEqual(Object.keys(s.candidate_track_record).sort(), ['RESOURCE_A', 'RESOURCE_B'], 'the id-keyed map is re-keyed through the mapping')
  for (const k of ['RESOURCE_A', 'RESOURCE_B']) assert.equal(s.candidate_track_record[k].cost_tier, 'free-local')
  assert.deepEqual(Object.keys(s.candidate_track_record.RESOURCE_B.here_by_task_type), ['review'])
  assert.equal(s.candidate_track_record.RESOURCE_B.feedback.recent_reasons[0], 'the review agent missed a bug in review', 'a task-type word is not a name')
  assert.deepEqual(s.recent_outcomes.map((h) => [h.task_type, h.first_resource]), [['review', 'RESOURCE_B'], ['debugging', 'RESOURCE_A']])
})

test('the masker refuses generic names and leaves keys and categorical values alone', () => {
  const anon = anonymity([
    { id: 'review', key: 'RESOURCE_A', names: ['local', 'spawn', 'free-local', 'ab', 'Local agent', 'implementation', 'SECOND_OPINION'] },
    { id: 'qwen-local', key: 'RESOURCE_B', names: ['qwen2.5-coder:7b'] },
  ])
  const text = 'review: local agent via spawn, free-local tier, ab test, implementation, SECOND_OPINION'
  assert.equal(anon.mask(text), text, 'no generic word is treated as a name')
  assert.equal(anon.mask('qwen-local and qwen2.5-coder:7b and Qwen'), 'RESOURCE_B and RESOURCE_B and [resource]')
  const v = { here_by_task_type: { review: { attempts: 1 } }, cost_tier: 'free-local', outcome: 'accepted', notes: ['qwen-local stalled'] }
  assert.deepEqual(anon.maskFree(v), { here_by_task_type: { review: { attempts: 1 } }, cost_tier: 'free-local', outcome: 'accepted', notes: ['RESOURCE_B stalled'] })
  // A field that looks categorical is no hiding place: an executor's diagnostic is not a category
  // the router wrote, and a name in it is still a name. Real categories survive because none of
  // them can be a name.
  assert.deepEqual(anon.maskFree({ status: 'qwen-local', source: 'qwen2.5-coder:7b exited' }), { status: 'RESOURCE_B', source: 'RESOURCE_B exited' })
  assert.deepEqual(anon.maskFree({ cost_tier: 'free-local', task_type: 'implementation', finalStatus: 'accepted', disposition: 'SECOND_OPINION' }),
    { cost_tier: 'free-local', task_type: 'implementation', finalStatus: 'accepted', disposition: 'SECOND_OPINION' })
})

test('a short model id is a name: o3 is masked, a short word is not', () => {
  const anon = anonymity([{ id: 'codex', key: 'RESOURCE_B', names: ['Codex (GPT)', 'o3'] }, { id: 'claude', key: 'RESOURCE_A', names: ['r1'] }])
  assert.equal(anon.mask('codex: model o3 is not available'), 'RESOURCE_B: model RESOURCE_B is not available')
  assert.equal(anon.mask('r1 timed out'), 'RESOURCE_A timed out')
  // All-letter short tokens and bare numbers stay ordinary words.
  const plain = anonymity([{ id: 'x-agent', key: 'RESOURCE_C', names: ['ab', 'ok', '42'] }])
  assert.equal(plain.mask('ab ok 42'), 'ab ok 42')
})

test('a tool attempt keeps its tool id in an anonymous review call', async (t) => {
  // A tool has no key (it is never a review or retry option), so it went out as '[resource]'
  // and the review could not see which tool had already run.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = assessInput({ decision: DECISION })
  input.attempts = [{ agent: 'tool:npm-test', role: 'tool', stopReason: 'completed', diagnostic: { message: 'npm test exited 1', category: 'failed' }, answerText: '1 failing', changedFiles: [] }, ...input.attempts]
  input.agents = [...REVIEW_AGENTS, LOCAL_AGENT]
  await jev.assess(input)
  const { attempts } = sent[0].state
  assert.deepEqual(attempts.map((a) => a.resource), ['tool:npm-test', 'RESOURCE_C', 'RESOURCE_A'])
  assert.deepEqual(attempts[0].diagnostic, { message: 'npm test exited 1', category: 'failed' })
  assert.deepEqual(leaks(sent[0]), [])
})

// ---------------------------------------------------------------- versioned names, CLI models, and why a resource is out

test('a brand word glued to a version is still the brand, and a word that merely starts with it is not', () => {
  // The word boundary after a brand refused every versioned name: 'qwen2.5', 'llama3' and 'gpt4o'
  // went out verbatim in a track-record reason, while bare 'qwen' was masked.
  const anon = anonymity([{ id: 'claude', key: 'RESOURCE_A', names: ['claude-opus-4'] }, { id: 'codex', key: 'RESOURCE_B', names: ['gpt-5.6'] }])
  assert.equal(anon.mask('qwen2.5 was slow'), '[resource] was slow')
  assert.equal(anon.mask('llama3 failed, llama3.1 too.'), '[resource] failed, [resource] too.')
  assert.equal(anon.mask('gpt4o is better than gpt-4o-mini'), '[resource] is better than [resource]-mini')
  assert.equal(anon.mask('claude3 opus4.1 Sonnet-4'), '[resource] [resource] [resource]')
  // A versioned brand is not the agent whose id is the bare brand: only an exact name is a key.
  assert.equal(anon.mask('claude kept failing, claude2 did not'), 'RESOURCE_A kept failing, [resource] did not')
  // A configured model id still reads as its own key, and a longer version is not that id.
  assert.equal(anon.mask('gpt-5.6 and claude-opus-4 ran; gpt-5.6.1 did not'), 'RESOURCE_B and RESOURCE_A ran; [resource] did not')
  // Ordinary words that begin with the letters are untouched.
  const plain = 'gptext, opusculum, codexes, llamas and a qwenlike parser'
  assert.equal(anon.mask(plain), plain)
})

test('a point release after a configured name is a longer version, masked whole, not sent out', () => {
  // Refusing 'grok-2' inside 'grok-2.1' is right, but a configured name that is no brand word had
  // nothing longer to fall back to, so the whole version string went out verbatim.
  const anon = anonymity([{ id: 'local', key: 'RESOURCE_B', names: ['grok-2', 'o3', 'glm-4'] }, { id: 'codex', key: 'RESOURCE_A', names: ['gpt-5'] }])
  assert.equal(anon.mask('fell back from grok-2.1 to grok-2'), 'fell back from [resource] to RESOURCE_B')
  assert.equal(anon.mask('glm-4.5 broke, o3.1 too, o3 did not'), '[resource] broke, [resource] too, RESOURCE_B did not')
  assert.equal(anon.mask('gpt-5.6 is not gpt-5.'), '[resource] is not RESOURCE_A.')
  // The same for a brand word with a dotted version, and for one that already carries a version.
  assert.equal(anon.mask('wrote claude.2.txt with gpt4o.1'), 'wrote [resource].txt with [resource]')
  // A file extension or the end of a sentence is not a version.
  assert.equal(anon.mask('see o3.md and grok-2.'), 'see RESOURCE_B.md and RESOURCE_B.')
})

test('a vendor name nobody configured is still a name', () => {
  const anon = anonymity([])
  assert.equal(anon.mask('grok and kimi were tried, then glm-4.5 and mixtral'), '[resource] and [resource] were tried, then [resource] and [resource]')
})

test('the review call masks the model a CLI agent really runs, as the routing call does', async (t) => {
  // codex with no pinned llm.model runs whatever ~/.codex/config.toml says (here 'o3'). The
  // routing call masked it through modelOf; the review call knew only llm.model, so 'o3' went out
  // verbatim in the executor diagnostic, next to the anonymous table.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = assessInput({ decision: DECISION })
  input.attempts = [
    { agent: 'codex', role: 'primary', stopReason: 'error', diagnostic: { message: 'o3 via codex exec: 429 rate limited', status: 'o3 failed' }, answerText: '', changedFiles: [] },
    { ...input.attempts[1], diagnostic: 'picked as the best fit' },
  ]
  await jev.assess({ ...input, modelOf: (a) => (a.id === 'codex' ? 'o3' : a.id === 'claude' ? 'best' : a.llm?.model) })
  const s = sent[0].state
  const key = s.attempts[0].resource
  assert.match(key, /^RESOURCE_[A-Z]$/)
  assert.deepEqual(s.attempts[0].diagnostic, { message: `${key} via ${key} exec: 429 rate limited`, status: `${key} failed` })
  assert.ok(!/\bo3\b/.test(JSON.stringify(sent[0])), 'o3 rode out in the review call')
  // A CLI alias is not a model id: 'best' is an ordinary word and stays one.
  assert.equal(s.attempts[1].diagnostic, 'picked as the best fit', 'an alias was masked as a name')
  assert.deepEqual(leaks(sent[0]), [])
})

test('the model an attempt recorded is masked even when the caller passes no modelOf', async (t) => {
  // router.js stores `model` (and the served `modelVersion`) on every attempt: that alone is
  // enough to mask the model of every agent that ran.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = assessInput({ decision: DECISION })
  input.attempts = [
    { agent: 'codex', model: 'o3', modelVersion: 'o3-2026-04-16', role: 'primary', stopReason: 'error', diagnostic: 'o3-2026-04-16 via o3: 429', answerText: '', changedFiles: [] },
    // An agent that ran but is no longer offered: its model still masks, to the placeholder.
    { agent: 'mistral-box', model: 'devstral-24b', role: 'retry', stopReason: 'error', diagnostic: 'devstral-24b crashed', answerText: '', changedFiles: [] },
    ...input.attempts.slice(1),
  ]
  await jev.assess(input)
  const [first, second] = sent[0].state.attempts
  assert.equal(first.diagnostic, `${first.resource} via ${first.resource}: 429`)
  assert.equal(second.resource, '[resource]')
  assert.equal(second.diagnostic, '[resource] crashed')
})

test('jev-review hands its modelOf to the review call', async () => {
  const { createReview } = await import('../../jev-review/index.js')
  const seen = []
  const jev = { assess: async (args) => { seen.push(args.modelOf); return { verdict: 'accept', addressed: 1, complete: 1, unrelatedChanges: 0, regressionRisk: 0, needsPerson: 0 } } }
  const modelOf = () => 'o3'
  const base = { task: 't', routing: { risk: 0.1 }, attempts: [{ agent: 'codex', stopReason: 'completed' }], checks: [], cmp: { regressed: [], failing: [] }, diff: {}, agents: [], blockAccept: false, reviewed: false, touchedCode: true, pickOther: () => 'claude' }
  await createReview(jev, { accept: { low: 0.5, medium: 0.5, high: 0.5 }, secondOpinion: 0.6, humanReview: 0.7 }, 'x', { modelOf })(base, new AbortController().signal)
  const perCall = () => 'gpt-5.6'
  await createReview(jev, { accept: { low: 0.5, medium: 0.5, high: 0.5 }, secondOpinion: 0.6, humanReview: 0.7 })({ ...base, modelOf: perCall }, new AbortController().signal)
  assert.deepEqual(seen, [modelOf, perCall])
})

test('the review call says truthfully why a resource is outside the work table', async (t) => {
  // It told Jev that a hard fact kept every such resource out. Conservation is a judgment and the
  // weekly gate and the floor are policy: the resource conserved for harder work is kept to review
  // on purpose, and telling the reviewer pick otherwise made it look unfit to judge.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const agents = [...REVIEW_AGENTS, { id: 'gemini-box', name: 'Gemini box', provider: 'spawn', llm: { provider: 'google', model: 'gemini-3-pro' } }, LOCAL_AGENT]
  const decision = {
    ...DECISION,
    excluded: [
      { id: 'codex', reason: 'conserved for harder work: kept for review only' },
      { id: 'gemini-box', reason: 'context window 8192 tokens is under the 17600 this request needs', hard: true },
    ],
    conservation: { from: 'codex', to: 'claude' },
  }
  await jev.assess({ ...assessInput({ decision }), agents })
  const { state, questions } = sent[0]
  const outside = state.candidates.filter((c) => c.candidate_for_work === false)
  assert.equal(outside.length, 3, JSON.stringify(state.candidates))
  const line = (k) => questions.reviewAgent.criteria[k].what
  const [conserved, tooSmall, notOffered] = outside
  assert.equal(conserved.kept_out_by, 'policy_or_judgment')
  assert.equal(conserved.reason, 'conserved for harder work: kept for review only')
  assert.match(line(conserved.key), /kept out by policy or judgment, not by a hard fact: conserved for harder work/)
  assert.ok(!/hard fact kept it out/.test(line(conserved.key)))
  assert.equal(tooSmall.kept_out_by, 'hard_fact')
  assert.match(line(tooSmall.key), /a hard fact kept it out: context window 8192 tokens/)
  // Never handed to the engine at all: the router offers it only what the registry says can take the request.
  assert.equal(notOffered.kept_out_by, 'not_offered_for_this_request')
  assert.match(line(notOffered.key), /executor registry does not list it/)
  assert.deepEqual(leaks(sent[0]), [])
  assert.ok(!/gemini|qwen/i.test(JSON.stringify(sent[0])), 'a name in an outside row rode out')
})

test('a review-only resource is weighed on its numbers, and a reason the record lacks is not made up', async (t) => {
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  // codex was conserved: it cleared every hard fact and is kept to review, so the record carries
  // the numbers it would be judged on, under the key the routing call gave it.
  const codexRow = { id: 'codex', key: 'RESOURCE_B', source: 'subscription', tier: 'frontier', fit: 0.9, scarcity: 0.8, marginalCost: 'low', expectedCost: { total: 0.4, class: 'medium' }, latency: 'slow', availability: 'ok', cold: false, evidenceSamples: 9, capabilities: { coding: { score: 0.93, confidence: 0.8, samples: 9 } } }
  const decision = { ...DECISION, excluded: [{ id: 'codex', reason: 'conserved for harder work: kept for review only' }], reviewOnly: [codexRow] }
  await jev.assess({ ...assessInput({ decision }), agents: REVIEW_AGENTS })
  const conserved = sent[0].state.candidates.find((c) => c.candidate_for_work === false)
  assert.equal(conserved.key, 'RESOURCE_B')
  assert.equal(conserved.kept_out_by, 'policy_or_judgment')
  assert.equal(conserved.tier, 'frontier')
  assert.equal(conserved.capabilities.coding.score, 0.93)
  assert.ok(!('id' in conserved))
  assert.match(sent[0].questions.reviewAgent.criteria.RESOURCE_B.what, /conserved for harder work: kept for review only; for review: tier frontier · coding 0\.93/)
  assert.deepEqual(leaks(sent[0]), [])
  // A record from before the engine said why anything was out: nothing is claimed about codex.
  sent.length = 0
  await jev.assess({ ...assessInput({ decision: DECISION }), agents: REVIEW_AGENTS })
  const unknown = sent[0].state.candidates.find((c) => c.candidate_for_work === false)
  assert.equal(unknown.kept_out_by, 'unrecorded')
  const what = sent[0].questions.reviewAgent.criteria[unknown.key].what
  assert.match(what, /the decision record does not say why/)
  assert.ok(!/executor registry/.test(what), what)
})

test('the routing call asks no question whose answer nothing reads', async (t) => {
  // cheapSufficient and consistencyReview were asked on every routed run and never read.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const r = await jev.route({ task: 'fix it', context: {}, candidates: TABLE, identities: IDS, ask: { task: true, resource: true, judgments: true } })
  const asked = Object.keys(sent[0].questions)
  assert.ok(!asked.includes('cheapSufficient') && !asked.includes('consistencyReview'), asked.join(', '))
  for (const q of ['secondOpinion', 'conserve', 'frontierReview', 'resource', 'taskType', 'needsTests']) assert.ok(asked.includes(q), `${q} is still asked`)
  assert.ok(!('cheapSufficient' in r))
  assert.deepEqual(r.profile.verification, [], 'needsTests at 0.3 asks for no checks, and nothing else rides verification')
})

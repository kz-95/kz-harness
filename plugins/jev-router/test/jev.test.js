// What the router hands to TypeSafe. A key pasted into the chat is masked in the
// log and in the export, so it must not ride along in a Jev payload either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { DISPOSITION_CRITERIA, TASK_TYPES, VERDICTS, anonymity, createJev, profileFromAnswers } from '../jev.js'

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
const HISTORY = [{ task_type: 'implementation', first_agent: 'claude', attempts: 1, outcome: 'accepted' }, { task_type: 'debugging', first_agent: 'deepseek', attempts: 2, outcome: 'needs_human' }]
const AVAILABILITY = { claude: 'ok', codex: 'near limit', deepseek: 'ok' }
const TRACK = {
  claude: { cost_tier: 'subscription', availability: 'ok', here_by_task_type: { implementation: { attempts: 4, accepted_rate: 0.75 } }, overall: { attempts: 4, accepted_rate: 0.75 }, feedback: { likes: 2, dislikes: 0, recent_reasons: ['good pick: claude fixed it where GPT gave up'] } },
  codex: { cost_tier: 'subscription', price_now: 'off-peak rate right now (OpenAI promo)', availability: 'near limit', here_by_task_type: {}, overall: 'no runs yet' },
  deepseek: { cost_tier: 'api', availability: 'ok', here_by_task_type: {}, overall: 'no runs yet' },
}

test('a routing call with the anonymous table names no agent in any field, and sends nothing no question reads', async (t) => {
  // Findings 4, 12 and 17: the table was anonymous, but the same call carried recent_outcomes,
  // agent_availability and agent_track_record keyed by the real ids, with the same facts as the
  // table, so the names lined up with the keys trivially. The per-candidate track record and
  // availability have since gone entirely: the resource question that read them is decided in
  // code now, and state no question reads costs tokens and accuracy on the state that is read.
  // The history re-keyed to the table went the same way once the table itself stopped riding the
  // strategy call: a key nothing in the call describes tells the teacher nothing.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({
    task: 'make the failing test pass', context: { branch: 'main' },
    candidates: TABLE, history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK,
    strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT'], taskProfile: { complexity: 0.5, risk: 0.3 }, ask: { task: false, resource: true, judgments: true },
  })
  assert.equal(sent.length, 1)
  assert.deepEqual(leaks(sent[0]), [], 'a real name rode out in a call about the anonymous candidates')
  const s = sent[0].state
  assert.equal(s.recent_outcomes, undefined, 'no question reads the history, so it is not sent')
  assert.equal(s.candidates, undefined, 'nor the table it was keyed to')
  assert.equal(s.candidate_track_record, undefined, 'no question reads it, so it is not sent')
  assert.equal(s.candidate_availability, undefined)
  assert.equal(s.agent_track_record, undefined)
  assert.equal(s.agent_availability, undefined)
})

test('a call that does not ask the named question carries no per-agent channel, and the id-to-key mapping changes nothing', async (t) => {
  // The per-agent channels once rode the anonymous calls re-keyed through the decision engine's
  // id-to-key mapping. No question in those calls reads them, so they are not sent at all, and the
  // mapping has nothing left to re-key: a call made with it must be the call made without it.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const strategyCall = { task: 'fix it', context: {}, candidates: TABLE, strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT'], history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, ask: { task: false, resource: true } }
  await jev.route(strategyCall)
  // The decision engine's task-only call carries no table and asks nothing about resources.
  await jev.route({ task: 'fix it', context: {}, history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, ask: { task: true } })
  assert.equal(sent.length, 2)
  for (const call of sent) {
    assert.deepEqual(leaks(call), [])
    assert.equal(call.state.candidate_track_record, undefined)
    // Only the named question reads the history, and neither of these calls asks it.
    assert.equal(call.state.recent_outcomes, undefined, 'the history rode a call that does not read it')
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

test('a local agent is re-keyed in the review call like any other, and its generic words survive', async (t) => {
  // The masker treated every configured string as a name and rewrote every string and object key
  // it carried, so with a name of 'local' a categorical fact went out as 'free-[resource]', and a
  // task type that is also an agent id became a key. The routing calls no longer carry anything
  // per resource, so the review call's attempts are the channel that proves a generic word is not
  // a name: the agent's own names ('spawn' and 'local' among them) are what the masker is handed.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = assessInput({ taskType: 'review', decision: DECISION })
  input.agents = [...REVIEW_AGENTS, LOCAL_AGENT]
  input.attempts = [
    { agent: 'qwen-local', role: 'primary', stopReason: 'error', diagnostic: 'qwen2.5-coder:7b via spawn: the local model on the free-local tier ran out of context', answerText: '', changedFiles: [] },
    input.attempts[1],
  ]
  await jev.assess(input)
  const { attempts } = sent[0].state
  const key = attempts[0].resource
  assert.match(key, /^RESOURCE_[A-Z]$/)
  assert.equal(attempts[0].diagnostic, `${key} via spawn: the local model on the free-local tier ran out of context`, 'the generic words stay and only the model id becomes the key')
  assert.ok(!JSON.stringify(sent[0]).toLowerCase().includes('qwen'), 'and the specific names are gone')
})

test('with two local agents a shared generic word is still not a name, and a task-type id is re-keyed only where it is an id', async (t) => {
  // An agent whose id is a task-type word: where it ran an attempt it reads as its key, but the
  // word itself is never masked where it is a category or in a sentence. Both are in the
  // diagnostic, which the masker walks: `routing.task_type` is copied as it is, so a check on it
  // would pass whatever the masker did.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const reviewer = { id: 'review', name: 'rv', provider: 'spawn', kind: 'local', llm: { provider: 'local', model: 'rv-7b' } }
  const input = assessInput({ taskType: 'review', decision: DECISION })
  input.agents = [...REVIEW_AGENTS, LOCAL_AGENT, reviewer]
  input.attempts = [
    { agent: 'review', role: 'primary', stopReason: 'completed', diagnostic: { message: 'the review agent missed a bug in review', category: 'review' }, answerText: 'looks fine', changedFiles: [] },
    { agent: 'qwen-local', role: 'retry', stopReason: 'completed', diagnostic: 'picked over the other local, free-local agent', answerText: 'found the bug', changedFiles: ['a.js'] },
  ]
  await jev.assess(input)
  const { attempts } = sent[0].state
  assert.ok(attempts.every((a) => /^RESOURCE_[A-Z]$/.test(a.resource)), 'the id is re-keyed where it is the runner')
  assert.notEqual(attempts[0].resource, attempts[1].resource)
  assert.equal(attempts[0].diagnostic.category, 'review', 'and left alone where it is a category')
  assert.equal(attempts[0].diagnostic.message, 'the review agent missed a bug in review', 'and in a sentence')
  assert.equal(attempts[1].diagnostic, 'picked over the other local, free-local agent', 'a generic word two local agents share is no name')
  assert.deepEqual(leaks(sent[0]), [])
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

test('the review call masks a provider word that names one agent, while a generic one stays a word', async (t) => {
  // A gateway nobody else uses names that one agent as surely as its id does. 'spawn' is how many
  // agents run, so it names none of them and must stay readable wherever it appears.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = assessInput({ decision: DECISION })
  input.agents = [...REVIEW_AGENTS, { id: 'gw', provider: 'spawn', llm: { provider: 'openrouter', model: 'router-large-2' }, description: 'e' }]
  input.attempts = [{ ...input.attempts[0], diagnostic: 'openrouter returned 502 while spawn waited' }, ...input.attempts.slice(1)]
  await jev.assess(input)
  const diagnostic = sent[0].state.attempts[0].diagnostic
  assert.match(diagnostic, /^(RESOURCE_[A-Z]|\[resource\]) returned 502 while spawn waited$/)
  assert.ok(!/openrouter/i.test(JSON.stringify(sent[0])), 'the provider word rode out in the review call')
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

test('the routing call asks no question whose answer nothing reads, and none that weighs numbers', async (t) => {
  // cheapSufficient and consistencyReview were asked on every routed run and never read. The
  // resource pick, the conservation judgment and the frontier review are gone for the other
  // reason: each of them handed Jev numbers and asked which was bigger, which it cannot do.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const r = await jev.route({ task: 'fix it', context: {}, candidates: TABLE, strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT', 'PREMIUM_PLAN_CHEAP_EXECUTE'], ask: { task: true, resource: true, judgments: true } })
  const asked = Object.keys(sent[0].questions)
  for (const q of ['cheapSufficient', 'consistencyReview', 'resource', 'conserve', 'frontierReview']) assert.ok(!asked.includes(q), `${q} is still asked`)
  for (const q of ['secondOpinion', 'strategy', 'taskType', 'needsTests']) assert.ok(asked.includes(q), `${q} is no longer asked`)
  assert.ok(!('cheapSufficient' in r))
  assert.deepEqual(r.profile.verification, [], 'needsTests at 0.3 asks for no checks, and nothing else rides verification')
})

// ---------------------------------------------------------------- a key in every channel

// One key per channel, each in the shape its issuer really uses, so a failure names the channel
// it leaked through.
const PLANTED = {
  handoff: `sk-proj-${'Pq3x'.repeat(12)}`, // an OpenAI project key the earlier agent printed
  workspace: `ghp_${'a1B2'.repeat(9)}`, // a GitHub token that ended up in an untracked file's name
  history: `hf_${'Xy7k'.repeat(9)}`, // a Hugging Face token in a history row
  agent: `sk-ant-api03-${'k9Lm'.repeat(10)}`, // an Anthropic key pasted into an agent's description
  tool: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWxlYXNlIn0', // a bearer token in a tool's description
  diagnostic: 'AKIAIOSFODNN7EXAMPLE', // an AWS key id an executor's error quoted
  changedFiles: `xoxb-2400-1180-${'Zq9s'.repeat(4)}`, // a Slack token in a changed file's name
  diffStat: `AIzaSy${'D4e5'.repeat(8)}`, // a Google key in the file list of the diff
}
const leaked = (call) => Object.entries(PLANTED).filter(([, key]) => JSON.stringify(call).includes(key)).map(([channel]) => channel)

test('a key an agent printed or a file name carries never reaches the routing call, in any channel', async (t) => {
  // The task text was scrubbed and the handoff was scrubbed by clip(), but the workspace facts went
  // out as gathered, and so did the history rows and every description in the questions.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = {
    task: 'finish the release script',
    // gatherContext lists the untracked file by name, and counts it under its extension.
    context: { branch: 'main', uncommittedFiles: ['src/release.js', `notes/token.${PLANTED.workspace}`], fileTypes: { '.js': 1, [`.${PLANTED.workspace}`]: 1 }, scripts: ['test'] },
    handoff: `Step 2 of 3 done. I ran export OPENAI_API_KEY=${PLANTED.handoff} and the dry run passed.`,
    history: [{ task_type: 'implementation', first_agent: 'claude', attempts: 1, outcome: `failed: 401 for ${PLANTED.history}` }],
    tools: [{
      id: 'release',
      description: `Posts the release notes: curl -H "Authorization: Bearer ${PLANTED.tool}" https://hooks.example.com/release`,
      params: { channel: { question: `Which channel should the notes go to? The hook sends Authorization: Bearer ${PLANTED.tool}`, options: { stable: 'The stable channel', beta: `The beta channel, same Bearer ${PLANTED.tool}` } } },
    }],
  }
  // The named call reads the workspace, the history and each agent's own description.
  await jev.route({ ...input, agents: [{ id: 'claude', description: `Claude Code on the team key ${PLANTED.agent}` }] })
  // The decision engine's task call reads the workspace and the handoff.
  await jev.route({ ...input, ask: { task: true, resource: false, judgments: false } })

  assert.equal(sent.length, 2)
  for (const call of sent) assert.deepEqual(leaked(call), [], 'a key rode out in the routing call')
  // Only the secret goes: the rest of every channel is the routing judgment's evidence.
  const [named, taskCall] = sent
  for (const { state } of sent) {
    assert.deepEqual(state.workspace.uncommittedFiles, ['src/release.js', 'notes/token.ghp_a1...REDACTED'])
    assert.deepEqual(state.workspace.fileTypes, { '.js': 1, '.ghp_a1...REDACTED': 1 }, 'an extension is a file name too')
    assert.match(state.handoff, /^Step 2 of 3 done\. I ran export OPENAI_API_KEY=sk-pro\.\.\.REDACTED and the dry run passed\.$/)
  }
  assert.equal(named.state.recent_outcomes[0].outcome, 'failed: 401 for hf_Xy7...REDACTED')
  assert.equal(named.questions.agent.criteria.claude.what, 'Claude Code on the team key sk-ant...REDACTED')
  for (const { questions } of sent) {
    assert.match(questions.handler.criteria.release.what, /Authorization: Bearer \.\.\.REDACTED" https:\/\/hooks\.example\.com\/release$/)
    assert.match(questions['release.fits'].instructions.focus, /Bearer \.\.\.REDACTED/)
    assert.match(questions['release.channel'].instructions, /Bearer \.\.\.REDACTED$/)
    assert.equal(questions['release.channel'].criteria.beta.what, 'The beta channel, same Bearer ...REDACTED')
  }
  assert.ok(taskCall.questions.continueHandoff, 'the task call reads the handoff it carries')
})

test('a key an executor quoted or a file name carries never reaches the review call, with or without the anonymous table', async (t) => {
  // The answer, the diff excerpt and the check output were scrubbed. The diff's file list and each
  // attempt's changed files were not, and neither was a diagnostic that arrived as an object when
  // the review had no decision record to mask it with.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const input = (routing) => ({
    ...assessInput(routing),
    attempts: [
      { agent: 'deepseek', role: 'primary', stopReason: 'error', diagnostic: { message: `aws s3 cp refused: InvalidAccessKeyId ${PLANTED.diagnostic}`, category: 'failed' }, answerText: '', changedFiles: [] },
      { agent: 'claude', role: 'retry', stopReason: 'completed', answerText: 'wired the notifier', changedFiles: ['src/notify.js', `slack/${PLANTED.changedFiles}.json`] },
    ],
    diff: { stat: ` src/notify.js | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\nnew untracked: config/${PLANTED.diffStat}.json`, patch: '+notify()' },
    agents: REVIEW_AGENTS.map((a) => (a.id === 'codex' ? { ...a, description: `${a.description}; on the team key ${PLANTED.agent}` } : a)),
  })
  // No decision record (a forced agent, or a run whose engine fell back): the named options.
  await jev.assess(input({}))
  await jev.assess(input({ decision: DECISION }))

  assert.equal(sent.length, 2)
  for (const call of sent) assert.deepEqual(leaked(call), [], 'a key rode out in the review call')
  const [named, anonymous] = sent
  assert.deepEqual(named.state.attempts[0].diagnostic, { message: 'aws s3 cp refused: InvalidAccessKeyId AKIAIO...REDACTED', category: 'failed' })
  assert.match(named.questions.reviewAgent.criteria.codex.what, /^OpenAI Codex: implementation, debugging, writing and running tests; on the team key sk-ant\.\.\.REDACTED$/)
  for (const { state } of sent) {
    assert.deepEqual(state.attempts[1].changed_files, ['src/notify.js', 'slack/xoxb-2...REDACTED.json'])
    assert.equal(state.diff.stat, ' src/notify.js | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\nnew untracked: config/AIzaSy...REDACTED.json')
  }
  assert.equal(anonymous.state.attempts[0].diagnostic.message, 'aws s3 cp refused: InvalidAccessKeyId AKIAIO...REDACTED', 'the anonymous path scrubbed it already, and still does')
})

// ---------------------------------------------------------------- what each call carries

// Everything a routing call can be handed. Each call shape must carry only the state its own
// questions read, so a shape that carries more than that shows up as an extra key.
const EVERYTHING = {
  task: 'make the failing test pass',
  context: { branch: 'main', uncommittedFiles: ['a.js'], scripts: ['test'] },
  handoff: 'Step 1 of 2 done: the parser is fixed, the printer is next.',
  history: HISTORY, availability: AVAILABILITY, trackRecord: TRACK, candidates: TABLE,
  strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT', 'PREMIUM_PLAN_CHEAP_EXECUTE'],
  taskProfile: { complexity: 0.5, risk: 0.3, needsSecondOpinion: 0.4 },
}
const stateKeys = (call) => Object.keys(call.state).filter((k) => call.state[k] !== undefined).sort()

test('the task call carries the task, its workspace and its handoff, and nothing about other tasks or resources', async (t) => {
  // The task group judges `task` "in this workspace" and asks whether it continues `handoff`. No
  // question in it reads the earlier tasks' outcomes, a track record or an availability map.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  // The decision engine's task call: no candidate table.
  await jev.route({ ...EVERYTHING, candidates: undefined, ask: { task: true, resource: false, judgments: false } })
  assert.deepEqual(stateKeys(sent[0]), ['handoff', 'task', 'workspace'])
  assert.ok(sent[0].questions.taskType && sent[0].questions.continueHandoff)
})

test('the strategy call carries the task and its profile, and neither the candidate table nor the history', async (t) => {
  // The strategy question reads `task` and weighs the required quality, which is what the task
  // profile states. It names no field of the candidate table, and what the table decides about the
  // strategy is decided before the call: every option it is offered is one the pool allows.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({ ...EVERYTHING, ask: { task: false, resource: true, judgments: false } })
  const [call] = sent
  assert.deepEqual(Object.keys(call.questions), ['strategy'])
  assert.equal(call.state.candidates, undefined, 'the numeric table rode a call whose question reads none of it')
  assert.deepEqual(stateKeys(call), ['task', 'task_profile'])
  assert.deepEqual(Object.keys(call.questions.strategy.criteria), EVERYTHING.strategies, 'the options are the strategies the pool allows')
  assertReadsOnlyWhatRides(call)
  // A cold router batches the second opinion into the same call: it carries what the two read.
  await jev.route({ ...EVERYTHING, ask: { task: false, resource: true, judgments: true } })
  assert.deepEqual(Object.keys(sent[1].questions).sort(), ['secondOpinion', 'strategy'])
  assert.deepEqual(stateKeys(sent[1]), ['task', 'task_profile'])
  assert.deepEqual(leaks(sent[1]), [])
  // Asked beside the task group, the call has no profile yet, so the question must not quote one.
  await jev.route({ ...EVERYTHING, ask: { task: true, resource: true, judgments: false } })
  assert.equal(sent[2].state.task_profile, undefined)
  assertReadsOnlyWhatRides(sent[2])
})

/**
 * The strategy question reads only what its call carries: every field it quotes rides the call,
 * and it speaks of no candidates, because the call carries none. A question about facts it is not
 * given is answered from nothing, and reads as though they were there.
 */
function assertReadsOnlyWhatRides(call) {
  const { question, focus } = call.questions.strategy.instructions
  for (const [, field] of `${question} ${focus}`.matchAll(/`(\w+)`/g)) assert.ok(field in call.state, `the strategy question quotes \`${field}\`, which this call does not carry`)
  assert.ok(!/candidate/i.test(`${question} ${focus}`), `the strategy question speaks of candidates the call does not carry: ${question} ${focus}`)
}

test('a strategy call offers only the strategies the caller says the pool can run', async (t) => {
  // The call carries nothing about the pool, so Jev cannot tell an option the pool can run from
  // one it cannot. Without the caller's list every strategy was offered, planning on the
  // strongest resource included, to a pool of one local model.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  const onlyLocal = [{ key: 'RESOURCE_A', tier: 'standard', source: 'local' }]
  await jev.route({ task: 'fix a typo', candidates: onlyLocal, ask: { task: false, resource: true, judgments: true } })
  assert.deepEqual(Object.keys(sent[0].questions), ['secondOpinion'], 'no strategy question without the strategies it may offer')
  await assert.rejects(jev.route({ task: 'fix a typo', candidates: onlyLocal, ask: { task: false, resource: true, judgments: false } }), /nothing to ask/)
  // The list the caller passes is the whole of what is offered, less anything that is no strategy.
  await jev.route({ task: 'fix a typo', candidates: onlyLocal, strategies: ['LOCAL_FIRST', 'STANDARD_DIRECT', 'NOT_A_STRATEGY'], ask: { task: false, resource: true, judgments: false } })
  assert.deepEqual(Object.keys(sent[1].questions.strategy.criteria), ['LOCAL_FIRST', 'STANDARD_DIRECT'])
})

test('the judgments-only call carries the task alone', async (t) => {
  // The second opinion reads `task` and nothing else: no workspace, no handoff, no profile, and no
  // history keyed to a table the call does not carry.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.route({ ...EVERYTHING, ask: { task: false, resource: false, judgments: true } })
  assert.deepEqual(Object.keys(sent[0].questions), ['secondOpinion'])
  assert.deepEqual(stateKeys(sent[0]), ['task'])
  // One eligible strategy is nothing to choose between, so a resource call asks no strategy
  // question, and what is left of it is a judgments-only call.
  await jev.route({ ...EVERYTHING, strategies: ['STANDARD_DIRECT'], ask: { task: false, resource: true, judgments: true } })
  assert.deepEqual(Object.keys(sent[1].questions), ['secondOpinion'])
  assert.deepEqual(stateKeys(sent[1]), ['task'])
})

test('the review call still carries its own full table: the reviewer and fixer picks are made over it', async (t) => {
  // The strategy call no longer carries a table. The review call's questions choose between the
  // candidates by their data, so its table must not have lost a field on the way.
  const { sent, restore } = captureCalls()
  t.after(restore)
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await jev.assess(assessInput({ decision: DECISION }))
  // As it leaves the machine: the SDK sends JSON, so an undefined field is no field.
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].state.candidates)), [
    {
      key: 'RESOURCE_A', tier: 'frontier',
      capabilities: { coding: { score: 0.9, confidence: 0.8, samples: 4 }, reliability: { score: 0.85, confidence: 0.6, samples: 4 } },
      source: 'subscription', scarcity: 0.4, reset_in_minutes: null, marginal_cost: 'low', expected_cost: { total: 0.3, class: 'low' },
      latency: 'slow', availability: 'ok', reliability: { score: 0.85, confidence: 0.6 }, verified_runs: 4, new_resource: false, task_fit: 0.88,
    },
    {
      key: 'RESOURCE_C', tier: 'strong',
      capabilities: { coding: { score: 0.75, confidence: 0.7, samples: 12 } },
      source: 'api', scarcity: 0, reset_in_minutes: null, marginal_cost: 'metered', expected_cost: { total: 0.2, class: 'low' },
      latency: 'medium', availability: 'ok', reliability: null, verified_runs: 12, new_resource: false, task_fit: 0.7,
    },
    { key: 'RESOURCE_D', candidate_for_work: false, kept_out_by: 'unrecorded' },
  ])
  assert.ok(Object.keys(sent[0].questions.reviewAgent.criteria).every((k) => sent[0].state.candidates.some((c) => c.key === k)), 'every option is a row of it')
})

// ---------------------------------------------------------------- the provider record, and who watches a call

// Records in the shape providers.js builds, with only the fields these tests read. A test of
// jev.js must not depend on how the records are resolved from config.
const JEV_RECORD = Object.freeze({
  id: 'jev', name: 'Jev', teacher: true, local: false, model: 'jev-9.9.9', maxRetries: 1, usdPerInputToken: 0.042 / 1e6,
  timeoutMs: Object.freeze({ intent: 1100, route: 2200, review: 3300 }),
  thresholds: Object.freeze({ supportingSkill: 0.15, verificationChecks: 0.5 }),
})
const LAYA_RECORD = Object.freeze({
  id: 'laya', name: 'Laya', teacher: false, local: true, model: 'english', maxRetries: 0, usdPerInputToken: 0, timeoutMs: null,
  thresholds: Object.freeze({ supportingSkill: 0.2, verificationChecks: 'always' }),
})

/** An answer of the right type for any question: the first option, a middling score, a low noul. */
function byType(_name, q) {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria)
    return { type: 'choice', choice: keys[0], confidence: 0.8, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / Math.max(1, keys.length - 1)])) }
  }
  if (q.type === 'score') return { type: 'score', score: 2, confidence: 0.6, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 2 ? 0.6 : 0.1])) }
  return { type: 'noul', noul: 0.3, confidence: 0.7 }
}

/**
 * A client in the SDK's shape, as the Laya client is: `systemOne` returns a plain promise. It
 * records every body and per-call options object it was handed.
 */
function fakeClient({ answer = byType, fail, meta, model = 'fake-model', delayMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    async systemOne(body, options) {
      calls.push({ body, options })
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (fail) throw fail
      const answers = Object.fromEntries(Object.entries(body.questions).map(([n, q]) => [n, answer(n, q)]))
      return { model, usage: { input_tokens: 10, output_tokens: 0 }, answers, ...(meta ? { meta } : {}) }
    },
  }
}

/** A test that hands createJev its own client fails by assertion, not on the network, if the client is ignored. */
const noRealClient = (t) => t.mock.method(TypeSafeClient.prototype, 'systemOne', () => {
  throw new assert.AssertionError({ message: 'the SDK client was used instead of the one handed to createJev' })
})

const deepFrozen = (v, seen = new Set()) => {
  if (!v || typeof v !== 'object' || seen.has(v)) return true
  seen.add(v)
  return Object.isFrozen(v) && Object.values(v).every((x) => deepFrozen(x, seen))
}

test('the new form builds its client from the record: its model, its retries, and a timeout per phase', async (t) => {
  const seen = []
  t.mock.method(TypeSafeClient.prototype, 'systemOne', function (body, options) {
    seen.push({ model: this.defaultModel, maxRetries: this.retry.maxRetries, timeout: options.timeout, phase: options.phase, signal: options.signal })
    return Promise.resolve({ model: this.defaultModel, usage: {}, answers: Object.fromEntries(Object.entries(body.questions).map(([n, q]) => [n, byType(n, q)])) })
  })
  const jev = createJev({ provider: JEV_RECORD, apiKey: 'tsk_test_key' })
  const signal = new AbortController().signal
  await jev.intent({ message: 'hi' }, signal)
  await jev.route({ task: 'fix it', ask: { task: true } }, signal)
  await jev.assess(assessInput({}), signal)
  assert.deepEqual(seen.map(({ signal: s, ...rest }) => ({ ...rest, signal: s === signal })), [
    { model: 'jev-9.9.9', maxRetries: 1, timeout: 1100, phase: 'intent', signal: true },
    { model: 'jev-9.9.9', maxRetries: 1, timeout: 2200, phase: 'route', signal: true },
    { model: 'jev-9.9.9', maxRetries: 1, timeout: 3300, phase: 'review', signal: true },
  ])
  assert.equal(jev.provider, JEV_RECORD, 'the returned object carries the record every consumer reads')
  // A record with no timeouts (Laya's) leaves the per-call timeout to the client, and a client
  // handed in is used as it is, with `phase` on every call.
  const client = fakeClient()
  const laya = createJev({ provider: LAYA_RECORD, apiKey: 'tsk_test_key', client })
  await laya.intent({ message: 'hi' })
  assert.equal(seen.length, 3, 'the SDK client was not built for it')
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].options.timeout, undefined)
  assert.equal(client.calls[0].options.phase, 'intent')
})

test('a failed call goes to onError with its class, never to onTrace, and the caller still gets the error', async (t) => {
  noRealClient(t)
  class APIError extends Error {}
  const boom = Object.assign(new APIError('500 inference failed'), { status: 500, code: 'LAYA_HTTP_500' })
  const errors = []
  const traces = []
  const client = fakeClient({ fail: boom })
  const jev = createJev({ provider: LAYA_RECORD, apiKey: 'k', client, onTrace: (x) => traces.push(x), onError: (e) => errors.push(e) })
  await assert.rejects(jev.route({ task: 't', ask: { task: true } }), (e) => e === boom)
  assert.equal(errors.length, 1)
  const [e] = errors
  assert.equal(e.phase, 'route')
  assert.equal(e.provider, 'laya')
  assert.match(e.callId, /^[0-9a-f-]{36}$/)
  assert.equal(typeof e.ms, 'number')
  assert.deepEqual(e.error, { class: 'APIError', code: 'LAYA_HTTP_500', status: 500, message: '500 inference failed' })
  assert.deepEqual(traces, [], 'a failed call answered nothing, so it is never a trace')
  // An error with no code or status says so with null, and an onError that throws is not what
  // the caller gets.
  const plain = new TypeError('fetch failed')
  const noisy = createJev({ provider: JEV_RECORD, apiKey: 'k', client: fakeClient({ fail: plain }), onError: (x) => { errors.push(x); throw new Error('hook broke') } })
  await assert.rejects(noisy.intent({ message: 'm' }), (x) => x === plain)
  assert.deepEqual(errors[1].error, { class: 'TypeError', code: null, status: null, message: 'fetch failed' })
})

test('an answered call always settles: an answer the response left out is traced without one, and a response with no answers fails the call', async (t) => {
  // Every question answered but alsoWork.
  const partial = ({ questions }) => ({ model: 'm', usage: { input_tokens: 5, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(questions).filter(([n]) => n !== 'alsoWork').map(([n, q]) => [n, byType(n, q)])) })
  t.mock.method(TypeSafeClient.prototype, 'systemOne', (body) => Promise.resolve(partial(body)))
  // The old form with no onTrace never built a trace, so a missing answer never stopped it.
  await assert.doesNotReject(createJev({ apiKey: 'tsk_test_key' }).intent({ message: 'm' }), 'the old form answers as it always did')
  const traces = []
  const settled = []
  const errors = []
  const hooks = { onTrace: (x) => traces.push(x), onError: (e) => errors.push(e), onCall: () => (s) => { settled.push(s) } }
  const jev = createJev({ provider: JEV_RECORD, apiKey: 'k', client: { systemOne: async (body) => partial(body) }, ...hooks })
  let r
  await assert.doesNotReject(async () => { r = await jev.intent({ message: 'm' }) }, 'a trace of what did come back is no reason to fail the call')
  assert.equal(r.kind, 'task')
  assert.equal(r.alsoWork, undefined)
  assert.equal(traces.length, 1)
  assert.deepEqual(settled, [{ trace: traces[0] }], 'the watcher heard of the call once, with its trace')
  assert.deepEqual(errors, [])
  const also = traces[0].questions.find((q) => q.name === 'alsoWork')
  assert.ok(also, 'the question that went out is in the trace')
  assert.deepEqual([also.answer, also.confidence, also.probabilities, also.used], [undefined, undefined, undefined, false], 'with no answer, and not used')
  // A response with no answers at all is no answer: the watchers hear of it as a failed call, once.
  const broken = createJev({ provider: JEV_RECORD, apiKey: 'k', client: { systemOne: async () => ({ model: 'm', usage: {} }) }, ...hooks })
  await assert.rejects(broken.intent({ message: 'm' }), TypeError)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].error.class, 'TypeError')
  assert.equal(settled.length, 2)
  assert.ok(settled[1].error instanceof TypeError, 'the settle function got the error')
  assert.equal(traces.length, 1, 'and it is never a trace')
})

test('a provider that runs on this PC needs its own client: without one, createJev refuses rather than ask TypeSafe', (t) => {
  noRealClient(t)
  const refusal = { message: 'createJev: Laya runs on this PC and needs its own client' }
  assert.throws(() => createJev({ provider: LAYA_RECORD, apiKey: 'tsk_the_jev_key', onTrace: () => {} }), refusal)
  assert.throws(() => createJev({ provider: LAYA_RECORD, client: undefined }), refusal)
  // Jev with no client of its own still gets the SDK's, as the first test of this section shows.
  assert.equal(createJev({ provider: JEV_RECORD, apiKey: 'k' }).provider, JEV_RECORD)
})

test('onCall sees each call once before it is sent, with the state as sent and the questions deep-frozen', async (t) => {
  noRealClient(t)
  const client = fakeClient()
  const seen = []
  const jev = createJev({ provider: JEV_RECORD, apiKey: 'k', client, onCall: (c) => { seen.push({ ...c, sentBefore: client.calls.length }) } })
  const context = Object.freeze({ attempt: 1, risk: 0.4, blockAccept: false, reviewed: true })
  await jev.route({ task: 'fix the parser', context: { branch: 'main' }, handoff: 'step 1 done', ask: { task: true } })
  await jev.intent({ message: 'why does it fail?' })
  await jev.assess(assessInput({ decision: DECISION }), undefined, context)
  assert.equal(seen.length, 3, 'once per call')
  assert.deepEqual(seen.map((c) => c.phase), ['route', 'intent', 'review'])
  for (const [i, c] of seen.entries()) {
    assert.equal(c.sentBefore, i, `${c.phase}: seen before it was sent`)
    assert.equal(c.state, client.calls[i].body.state, `${c.phase}: the very state that is sent, not a rendering of it`)
    assert.equal(c.questions, client.calls[i].body.questions, `${c.phase}: the very questions, never a copy`)
    assert.ok(deepFrozen(c.questions), `${c.phase}: the questions are frozen all the way down`)
    assert.match(c.callId, /^[0-9a-f-]{36}$/)
    assert.equal(typeof c.used, 'function')
  }
  assert.equal(new Set(seen.map((c) => c.callId)).size, 3, 'one id per call')
  // assess's third argument is the review's context; the other calls have none.
  assert.deepEqual(seen.map((c) => c.context), [null, null, context])
  assert.ok(!JSON.stringify(client.calls[2].body).includes('blockAccept'), 'the context never goes out with the call')
  // The constants a question points to are shared with every later request, so they cannot be changed.
  assert.equal(seen[0].questions.taskType.criteria, TASK_TYPES)
  assert.throws(() => { seen[0].questions.taskType.criteria.debugging = 'anything' }, TypeError)
  assert.throws(() => { seen[2].questions.verdict.criteria.accept.what = 'anything' }, TypeError)
  assert.throws(() => { seen[0].questions.complexity.criteria.push('Beyond extreme') }, TypeError)
})

test("onCall's settle function gets the trace or the error, and no hook can delay or break the call", async (t) => {
  noRealClient(t)
  const events = []
  const hooks = {
    // Settles into a promise that never resolves: nothing waits for it.
    'never settles': () => (s) => { events.push(['never settles', s]); return new Promise(() => {}) },
    'onCall throws': () => { events.push(['onCall throws']); throw new Error('hook failed') },
    'settle throws': () => (s) => { events.push(['settle throws', s]); throw new Error('settle failed') },
    'settle rejects': () => async (s) => { events.push(['settle rejects', s]); throw new Error('settle rejected') },
    'onCall rejects': async () => { events.push(['onCall rejects']); throw new Error('hook rejected') },
  }
  for (const [name, onCall] of Object.entries(hooks)) {
    const traces = []
    const jev = createJev({ provider: JEV_RECORD, apiKey: 'k', client: fakeClient({ delayMs: 20 }), onCall, onTrace: (x) => traces.push(x) })
    const t0 = Date.now()
    const r = await jev.intent({ message: 'm' })
    assert.ok(Date.now() - t0 < 1000, `${name}: the call waited for its hook`)
    assert.equal(r.kind, 'task', `${name}: the call answered as usual`)
    assert.equal(traces.length, 1, `${name}: and was traced`)
    const settled = events.filter(([n, s]) => n === name && s)
    if (settled.length) assert.deepEqual(settled.map(([, s]) => s), [{ trace: traces[0] }], `${name}: the settle function got the same trace`)
  }
  assert.deepEqual(events.map(([n]) => n), Object.keys(hooks))
  // A call that fails settles with its error.
  const boom = new Error('timed out after 40 s')
  const got = []
  const failing = createJev({ provider: LAYA_RECORD, apiKey: 'k', client: fakeClient({ fail: boom }), onCall: () => (s) => { got.push(s) } })
  await assert.rejects(failing.assess(assessInput({})), (e) => e === boom)
  assert.deepEqual(got, [{ error: boom }])
})

test('a trace carries its call id, its provider, the client\'s meta, and the marks a provider set on each answer', async (t) => {
  noRealClient(t)
  const meta = { provider: 'laya', device: 'cpu', waitedMs: 0, requests: 1, rows: 3 }
  const marks = { depth: { informative: false, corrected: false, servedConfidence: 0.02 }, kind: { informative: true, corrected: true, servedConfidence: 0.4 } }
  const client = fakeClient({ meta, model: 'laya-english/0.3.20@1a2b3c4', answer: (n, q) => ({ ...byType(n, q), ...marks[n] }) })
  const traces = []
  const ids = []
  const laya = createJev({ provider: LAYA_RECORD, apiKey: 'k', client, onTrace: (x) => traces.push(x), onCall: (c) => { ids.push(c.callId) } })
  await laya.intent({ message: 'm' })
  assert.equal(traces.length, 1)
  const [trace] = traces
  assert.equal(trace.callId, ids[0])
  assert.equal(trace.provider, 'laya')
  assert.deepEqual(trace.meta, meta)
  assert.equal(trace.model, 'laya-english/0.3.20@1a2b3c4')
  const q = Object.fromEntries(trace.questions.map((x) => [x.name, x]))
  assert.deepEqual([q.depth.informative, q.depth.corrected, q.depth.servedConfidence], [false, false, 0.02])
  assert.deepEqual([q.kind.informative, q.kind.corrected, q.kind.servedConfidence], [true, true, 0.4])
  for (const k of ['informative', 'corrected', 'servedConfidence']) assert.ok(!(k in q.alsoWork), `an answer without ${k} gets none`)
  // A Jev call carries no meta and no marks: the trace is today's, plus who answered it.
  const jevTraces = []
  await createJev({ provider: JEV_RECORD, apiKey: 'k', client: fakeClient(), onTrace: (x) => jevTraces.push(x) }).intent({ message: 'm' })
  assert.equal(jevTraces[0].provider, 'jev')
  assert.ok(!('meta' in jevTraces[0]))
  assert.ok(jevTraces[0].questions.every((x) => !('informative' in x)))
})

test('the criteria constants, exported or not, are frozen from the moment jev.js loads, and a question points to them', async (t) => {
  // A fresh copy of the module: no call has touched its constants yet, so nothing but the module
  // itself can have frozen them.
  const fresh = await import('../jev.js?criteria-frozen-at-load')
  assert.ok(fresh.CRITERIA, 'the constants that are not exported on their own are reachable')
  const all = { TASK_TYPES: fresh.TASK_TYPES, VERDICTS: fresh.VERDICTS, DISPOSITION_CRITERIA: fresh.DISPOSITION_CRITERIA, ...fresh.CRITERIA }
  assert.deepEqual(Object.keys(all).sort(), ['COMPLEXITY_LEVELS', 'DISPOSITION_CRITERIA', 'REQUIREMENT_LEVELS', 'RISK_LEVELS', 'TASK_TYPES', 'TIERS', 'VERDICTS'])
  for (const [name, c] of Object.entries(all)) assert.ok(deepFrozen(c), `${name} is frozen at load`)
  assert.ok(Object.isFrozen(fresh.CRITERIA))
  for (const c of [TASK_TYPES, VERDICTS, DISPOSITION_CRITERIA]) assert.ok(deepFrozen(c))
  // The SDK keeps these very objects in the questions it builds.
  const sent = []
  t.mock.method(TypeSafeClient.prototype, 'systemOne', ({ questions }) => {
    sent.push(questions)
    return Promise.resolve({ model: 'jev-test', usage: {}, answers: Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, byType(n, q)])) })
  })
  await fresh.createJev({ apiKey: 'tsk_test_key' }).route({ task: 't', ask: { task: true } })
  const [q] = sent
  assert.equal(q.taskType.criteria, fresh.TASK_TYPES)
  assert.equal(q.complexity.criteria, fresh.CRITERIA.COMPLEXITY_LEVELS)
  assert.equal(q.risk.criteria, fresh.CRITERIA.RISK_LEVELS)
  assert.equal(q['req.coding'].criteria, fresh.CRITERIA.REQUIREMENT_LEVELS)
  assert.equal(q.minimumCapability.criteria, fresh.CRITERIA.TIERS)
  assert.equal(q.preferredCapability.criteria, fresh.CRITERIA.TIERS)
})

test("route(), intent() and assess() name the answers marked too flat, and Jev's list is always empty", async (t) => {
  noRealClient(t)
  const flat = new Set(['strategy', 'secondOpinion', 'risk', 'depth', 'disposition', 'reviewAgent', 'retryAgent'])
  const answer = (n, q) => ({ ...byType(n, q), ...(flat.has(n) ? { informative: false } : { informative: true }) })
  const laya = createJev({ provider: LAYA_RECORD, apiKey: 'k', client: fakeClient({ answer }) })
  const r = await laya.route({ task: 't', candidates: TABLE, strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT'], ask: { task: true, resource: true, judgments: true } })
  assert.deepEqual(r.uninformative?.slice().sort(), ['risk', 'secondOpinion', 'strategy'])
  // The strategy and the second opinion carry no flag of their own: the list is how a caller knows.
  assert.equal(r.strategy.choice, 'CHEAP_DIRECT')
  assert.equal(typeof r.secondOpinion, 'number')
  const i = await laya.intent({ message: 'm' })
  assert.deepEqual(i.uninformative, ['depth'])
  assert.equal(i.depth, 'everyday', 'intent() hands the flat depth over; the caller drops it')
  const a = await laya.assess(assessInput({}))
  assert.deepEqual(a.uninformative?.slice().sort(), ['disposition', 'retryAgent', 'reviewAgent'])
  // Jev sets no flag, so its list is always there and always empty.
  const jev = createJev({ provider: JEV_RECORD, apiKey: 'k', client: fakeClient() })
  const jr = await jev.route({ task: 't', candidates: TABLE, strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT'], ask: { task: true, resource: true, judgments: true } })
  assert.deepEqual(jr.uninformative, [])
  assert.deepEqual((await jev.intent({ message: 'm' })).uninformative, [])
  assert.deepEqual((await jev.assess(assessInput({}))).uninformative, [])
  assert.ok(!('filledByRules' in jr.profile), 'a Jev profile never lists filled fields')
})

test('profileFromAnswers reads the provider\'s supporting-skill and checks bars, leaves out flat scores and choices, and keeps flat nouls', () => {
  const answers = {
    taskType: { type: 'choice', choice: 'debugging', confidence: 0.2, probabilities: { debugging: 0.2 }, informative: false },
    complexity: { type: 'score', score: 2, informative: false },
    risk: { type: 'score', score: 3, informative: true },
    'req.planning': { type: 'score', score: 2, informative: false },
    'req.coding': { type: 'score', score: 4 },
    skill: { type: 'choice', choice: 'debugging', confidence: 0.5, probabilities: { debugging: 0.5, testing: 0.18, refactoring: 0.16, documentation: 0.1 } },
    minimumCapability: { type: 'choice', choice: 'strong', confidence: 0.4, informative: false },
    preferredCapability: { type: 'choice', choice: 'frontier', confidence: 0.7 },
    capability: { type: 'choice', choice: 'human_required', confidence: 0.12, informative: false },
    needsTests: { type: 'noul', noul: 0.1, informative: false },
    humanReview: { type: 'noul', noul: 0.5, informative: false },
    secondOpinion: { type: 'noul', noul: 0.45, informative: false },
    continueHandoff: { type: 'noul', noul: 0.52, informative: false },
  }
  const p = profileFromAnswers(answers, LAYA_RECORD.thresholds)
  assert.deepEqual(p.filledByRules, ['taskType', 'complexity', 'minimumCapability', 'capability', 'req.planning'])
  for (const k of ['taskType', 'taskTypeConfidence', 'taskTypeProbabilities', 'complexity', 'minimumCapability', 'minimumCapabilityConfidence', 'capability', 'capabilityConfidence']) assert.equal(p[k], undefined, k)
  assert.equal(p.risk, 0.75)
  assert.equal(p.preferredCapability, 'frontier')
  assert.deepEqual(p.requirements, { coding: 1 }, 'a flat requirement is left for the rules')
  // Laya's supporting-skill bar is 0.2, so neither runner-up clears it.
  assert.deepEqual(p.skills, { primary: 'debugging', supporting: [] })
  // 'always' lists checks whatever the answer, and a flat noul keeps its value.
  assert.deepEqual(p.verification, ['checks'])
  assert.deepEqual([p.needsTests, p.needsHumanReview, p.needsSecondOpinion, p.continueHandoff], [0.1, 0.5, 0.45, 0.52])
  assert.deepEqual(profileFromAnswers({}, { verificationChecks: 'always' }).verification, ['checks'], 'even with no answer at all')
  // A lower bar lets a runner-up through, and a numeric checks bar reads the noul.
  const tuned = profileFromAnswers(answers, { supportingSkill: 0.17, verificationChecks: 0.05 })
  assert.deepEqual(tuned.skills.supporting, ['testing'])
  assert.deepEqual(tuned.verification, ['checks'])
  // Jev's bars by default, and without flags nothing is left out.
  const plain = Object.fromEntries(Object.entries(answers).map(([k, { informative, ...a }]) => [k, a]))
  const jev = profileFromAnswers(plain)
  assert.ok(!('filledByRules' in jev))
  assert.equal(jev.taskType, 'debugging')
  assert.deepEqual(jev.skills.supporting, ['testing', 'refactoring'])
  assert.deepEqual(jev.verification, [])
})

test('route() builds its profile with the answering provider\'s bars', async (t) => {
  noRealClient(t)
  // Every noul at 0.3: under Jev's 0.5 checks bar, and Laya's is 'always'.
  const answer = (n, q) => ({ ...byType(n, q), ...(n === 'risk' ? { informative: false } : {}) })
  const laya = await createJev({ provider: LAYA_RECORD, apiKey: 'k', client: fakeClient({ answer }) }).route({ task: 't', ask: { task: true } })
  assert.deepEqual(laya.profile.verification, ['checks'])
  assert.deepEqual(laya.profile.filledByRules, ['risk'])
  assert.equal(laya.risk, undefined, 'the flat risk is left for the rules')
  const jev = await createJev({ provider: JEV_RECORD, apiKey: 'k', client: fakeClient() }).route({ task: 't', ask: { task: true } })
  assert.deepEqual(jev.profile.verification, [])
})

test('assess returns the model that served it', async (t) => {
  t.mock.method(TypeSafeClient.prototype, 'systemOne', ({ questions }) => Promise.resolve({ model: 'jev-1.13.0', usage: {}, answers: Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, byType(n, q)])) }))
  const a = await createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 }).assess(assessInput({}))
  assert.equal(a.model, 'jev-1.13.0')
})

test('the old form still works, as Jev with the values it names', async (t) => {
  const seen = []
  t.mock.method(TypeSafeClient.prototype, 'systemOne', function (body, options) {
    seen.push({ model: this.defaultModel, maxRetries: this.retry.maxRetries, timeout: options.timeout, phase: options.phase })
    return Promise.resolve({ model: 'jev-1.13.0', usage: {}, answers: Object.fromEntries(Object.entries(body.questions).map(([n, q]) => [n, byType(n, q)])) })
  })
  const traces = []
  const jev = createJev({ apiKey: 'tsk_test_key', model: 'jev-1.13.0', timeoutMs: 1234, onTrace: (x) => traces.push(x) })
  assert.ok(jev.provider, 'it carries the Jev record it built')
  assert.equal(jev.provider.id, 'jev')
  assert.equal(jev.provider.model, 'jev-1.13.0')
  assert.deepEqual(jev.provider.timeoutMs, { intent: 1234, route: 1234, review: 1234 })
  assert.equal(jev.provider.thresholds.supportingSkill, 0.15)
  const r = await jev.route({ task: 'fix it', ask: { task: true } })
  assert.equal(r.taskType, 'architecture')
  assert.deepEqual(seen, [{ model: 'jev-1.13.0', maxRetries: 2, timeout: 1234, phase: 'route' }])
  assert.equal(traces[0].provider, 'jev')
  // Without a model or a timeout the SDK keeps choosing both, as it always did.
  const bare = createJev({ apiKey: 'tsk_test_key' })
  assert.equal(bare.provider.model, undefined)
  await bare.intent({ message: 'm' })
  assert.equal(seen[1].model, new TypeSafeClient({ apiKey: 'x' }).defaultModel)
  assert.equal(seen[1].timeout, undefined)
})

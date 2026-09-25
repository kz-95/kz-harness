// The Laya wire adapter (docs/laya-auto.md 4.2, 4.3): Laya is asked exactly Jev's questions, only
// rendered for its English checkpoint, and its answers are read the way KzH's bars expect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk'
import { createJev, DISPOSITION_CRITERIA, TASK_TYPES, VERDICTS } from '../jev.js'
import { CAPABILITIES } from '../capabilities.js'
import { SKILLS, STRATEGIES } from '../routing-policy.js'
import {
  ADAPTER_VERSION, HEAD_BUDGET, LAYA_SHORT, NOUL_LABELS, NOUL_TEXT, VIEW_LIMIT,
  estimateHeadTokens, estimateRequestTokens, headChars, mergeLaya, normalizeLayaAnswers, noulText, renderForLaya, renderOptions,
} from '../laya-questions.js'
import { startFakeLaya } from './fixtures/fake-laya-serve.mjs'

const BODIES = JSON.parse(readFileSync(new URL('./fixtures/kzh-bodies.json', import.meta.url), 'utf8'))

/** Every call the jev.js builders send while `run` runs, taken at the SDK boundary; nothing is sent. */
function capture(run) {
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = function (body) { sent.push(body); return new Promise(() => {}) }
  try { run(createJev({ apiKey: 'tsk_test_key' })) } finally { TypeSafeClient.prototype.systemOne = real }
  return sent
}

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) }
  return o
}
const clone = (o) => JSON.parse(JSON.stringify(o))

// ---------------------------------------------------------------- maximal inputs

const ALL_CAPABILITIES = Object.keys(CAPABILITIES).filter((c) => c !== 'human_required')
const LONG = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')
const CONTEXT = {
  gitRepo: true, productionCritical: true, branch: 'feature/checkout-rewrite',
  uncommittedFiles: Array.from({ length: 30 }, (_, i) => `src/checkout/step-${i}/component-${i}.tsx`), uncommittedFileCount: 64,
  trackedFileCount: 2400, fileTypes: { '.ts': 900, '.tsx': 700, '.js': 300, '.json': 200, '.md': 120, '.css': 90, '.yml': 50, '.sql': 40 },
  scripts: ['build', 'test', 'lint', 'typecheck', 'format', 'migrate', 'release'], dependencies: Array.from({ length: 25 }, (_, i) => `dependency-${i}`),
}
const TOOLS = [
  { id: 'format_code', description: 'Runs prettier over the whole repository and then commits every formatted file as one single commit.', params: { scope: { question: 'Which files should be formatted by the formatter?', options: { all: 'Every file in the repository, including generated and vendored code', changed: 'Only the files changed on this branch compared with main' } } } },
  { id: 'bump_version', description: 'Bumps the package version in package.json and writes a changelog entry for it.', params: { level: { question: 'Which part of the version should change?', options: { major: 'A breaking change for every user', minor: 'A new feature', patch: 'A bug fix only' } } } },
  { id: 'regen_docs', description: 'Regenerates the API reference from the source comments.' },
]
const NAMED = [{ id: 'claude', description: 'The Claude Code CLI, signed in with its own login and paid for by your Claude subscription.' }, { id: 'codex', description: 'The OpenAI Codex CLI, signed in with its own login.' }, { id: 'deepseek', description: 'The native harness agent on the DeepSeek API.' }, { id: 'qwen-local', description: 'A local Qwen model on this PC.' }]
const candidate = (i) => ({
  id: `agent-${i}`, key: `RESOURCE_${String.fromCharCode(65 + i)}`, tier: ['frontier', 'strong', 'standard'][i % 3], source: 'subscription',
  capabilities: { coding: { score: 0.7, confidence: 0.6, samples: 9 } }, scarcity: 0.3, scarcityConfidence: 0.5, marginalCost: 'low',
  expectedCost: { total: 0.2, class: i % 2 ? 'low' : 'metered' }, latency: 'medium', availability: 'ok', reliability: { score: 0.8, confidence: 0.6 }, evidenceSamples: 12, fit: 0.5 + i / 30,
})

function reviewCall(n, { answer = LONG(600, 'answer'), task = LONG(300, 'task') } = {}) {
  const cands = Array.from({ length: n }, (_, i) => candidate(i))
  const [body] = capture((jev) => jev.assess({
    task,
    routing: { taskType: 'debugging', risk: 0.7, complexity: 0.6, decision: { candidates: cands, excluded: [] } },
    attempts: [
      { agent: 'agent-1', role: 'primary', stopReason: 'max_turns', answerText: LONG(200, 'earlier'), changedFiles: ['a.ts'] },
      { agent: 'agent-0', role: 'retry', stopReason: 'end_turn', answerText: answer, changedFiles: CONTEXT.uncommittedFiles },
    ],
    checks: { results: ['typecheck', 'lint', 'test', 'build'].map((name, i) => ({ name, passed: i !== 2, exitCode: i === 2 ? 1 : 0, durationMs: 900, output: `${name} said\n`.repeat(300) })), regressed: ['test'], fixed: [], failing: ['test'] },
    diff: { stat: CONTEXT.uncommittedFiles.map((f) => ` ${f} | 9 +++++----`).join('\n'), patch: Array.from({ length: 500 }, (_, i) => `+ const line${i} = "quoted" // ${i}`).join('\n') },
    agents: cands.map((c) => ({ id: c.id, description: `The ${c.id} agent.` })),
  }))
  return { phase: 'review', ...body }
}

/** Every call KzH makes, each at its largest: the invariant of 4.1 is asserted over these. */
function maximalCalls() {
  const [intent, task, resource, named] = capture((jev) => {
    jev.intent({ message: LONG(700, 'message') })
    jev.route({ task: LONG(400, 'task'), context: CONTEXT, capabilities: ALL_CAPABILITIES, tools: TOOLS, handoff: LONG(600, 'handoff'), ask: { task: true, resource: false, judgments: false } })
    jev.route({
      task: LONG(400, 'task'), candidates: [{ key: 'RESOURCE_A' }, { key: 'RESOURCE_B' }], strategies: Object.keys(STRATEGIES),
      taskProfile: { complexity: 0.4123, risk: 0.61, needsSecondOpinion: 0.55, needsHumanReview: 0.2, needsTests: 0.9, ...Object.fromEntries(['general_reasoning', 'architecture', 'planning', 'explanation', 'coding', 'debugging', 'security_review', 'code_review', 'testing', 'long_context'].map((d, i) => [`req_${d}`, i / 9])) },
      ask: { task: false, resource: true, judgments: true },
    })
    jev.route({ task: LONG(300, 'task'), context: CONTEXT, agents: NAMED, history: [{ task_type: 'debugging', first_agent: 'claude', attempts: 2, outcome: 'accepted' }], availability: { claude: 'ok', codex: 'near limit' }, trackRecord: { claude: { cost_tier: 'subscription', overall: { attempts: 4, accepted_rate: 0.75 } } } })
  })
  return [
    { name: 'intent', phase: 'intent', ...intent },
    { name: 'route task group', phase: 'route', ...task },
    { name: 'route resource and judgments', phase: 'route', ...resource },
    { name: 'route legacy named agent', phase: 'route', ...named },
    { name: 'review, 8 anonymous candidates', ...reviewCall(8) },
    { name: 'review, captured', ...BODIES.review },
  ]
}

// ---------------------------------------------------------------- the fixture

test('kzh-bodies.json holds the four bodies the jev.js builders send, the review state 9,206 characters', () => {
  const task = 'The login form in src/auth/LoginForm.tsx lets a user submit twice when they double-click, which creates two sessions. Fix it so a second submit is ignored while the first is in flight, and add a test for it.'
  const patch = 'diff --git a/src/auth/LoginForm.tsx b/src/auth/LoginForm.tsx\n' + Array.from({ length: 120 }, (_, i) => (i % 3 ? '+  const [submitting, setSubmitting] = useState(false) // line ' + i : '-  onSubmit={handleSubmit} // old line ' + i)).join('\n')
  const context = BODIES.task.state.workspace
  const [intent, taskCall, resource, review] = capture((jev) => {
    jev.intent({ message: 'why does the login form create two sessions?' })
    jev.route({ task, context, capabilities: ALL_CAPABILITIES, ask: { task: true, resource: false, judgments: false } })
    jev.route({ task, context, candidates: [{ key: 'RESOURCE_A' }, { key: 'RESOURCE_B' }], strategies: ['CHEAP_DIRECT', 'STANDARD_DIRECT', 'PREMIUM_DIRECT', 'CHEAP_THEN_PREMIUM_REVIEW'], taskProfile: { complexity: 0.4 }, ask: { task: false, resource: true, judgments: true } })
    jev.assess({ task, routing: { taskType: 'debugging', risk: 0.4, complexity: 0.3 }, attempts: [{ agent: 'claude', role: 'executor', stopReason: 'end_turn', answerText: 'I added a submitting flag to LoginForm and disabled the button while the request is in flight. '.repeat(20), changedFiles: ['src/auth/LoginForm.tsx', 'src/auth/LoginForm.test.tsx'] }], checks: { results: [{ name: 'test', passed: true, exitCode: 0, durationMs: 4000, output: 'PASS src/auth/LoginForm.test.tsx\n  ok 12 tests\n'.repeat(10) }], regressed: [], fixed: [], failing: [] }, diff: { stat: ' src/auth/LoginForm.tsx | 14 +++--\n src/auth/LoginForm.test.tsx | 30 ++++++', patch }, agents: [{ id: 'claude', description: 'Claude Code' }, { id: 'codex', description: 'Codex CLI' }] })
  })
  // A stale fixture fails here: rebuild it from these same builder calls.
  assert.deepEqual(BODIES, {
    intent: { phase: 'intent', ...clone(intent) },
    task: { phase: 'route', ...clone(taskCall) },
    resource: { phase: 'route', ...clone(resource) },
    review: { phase: 'review', ...clone(review) },
  })
  assert.equal(JSON.stringify(BODIES.review.state).length, 9206)
  assert.deepEqual(Object.keys(BODIES.task.questions).length, 20)
})

// ---------------------------------------------------------------- 4.1, the invariant

test('the invariant: every call at maximal inputs keeps its question names, types and option keys, and the fake Laya answers every one', async (t) => {
  const fake = await startFakeLaya({ apiKey: 'k' })
  t.after(() => fake.close())
  const client = new TypeSafeClient({ apiKey: 'k', baseURL: fake.url, defaultModel: 'english', retry: { maxRetries: 0 } })
  for (const call of maximalCalls()) {
    for (const role of ['act', 'shadow']) {
      const requests = renderForLaya(call, { role, chunkRows: 4 })
      const asked = requests.flatMap((r) => Object.keys(r.questions))
      assert.deepEqual([...asked].sort(), Object.keys(call.questions).sort(), `${call.name} (${role}): every question exactly once`)
      assert.equal(new Set(requests.map((r) => r.key)).size, requests.length, `${call.name}: request keys are unique`)
      for (const r of requests) {
        assert.equal(r.model, 'english', `${call.name}: the checkpoint is pinned on every request`)
        for (const [name, q] of Object.entries(r.questions)) {
          const was = call.questions[name]
          assert.equal(q.type, was.type, `${call.name}: ${name} keeps its type`)
          if (was.type === 'choice') assert.deepEqual(Object.keys(q.criteria), Object.keys(was.criteria), `${call.name}: ${name} keeps its option keys, in order`)
          if (was.type === 'score') assert.equal(q.criteria.length, was.criteria.length, `${call.name}: ${name} keeps its levels`)
          if (was.type === 'noul') assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true'])
          assert.equal(typeof q.instructions, 'string', `${call.name}: ${name} has one plain instruction`)
        }
      }
    }
    // Sent for real, labels and all: laya.serve refuses a malformed question with 422.
    const requests = renderForLaya(call, { role: 'act' })
    const parts = []
    for (const r of requests) parts.push({ key: r.key, response: await client.systemOne({ model: r.model, state: r.state, questions: r.questions }) })
    const merged = mergeLaya(call, parts)
    assert.deepEqual(Object.keys(merged.answers), Object.keys(call.questions), `${call.name}: answers come back in the order asked`)
    assert.deepEqual(merged.meta.missing, [])
    assert.equal(merged.meta.requests, requests.length)
    assert.equal(merged.meta.rows, Object.keys(call.questions).length)
    assert.equal(merged.meta.atContextLimit, 0, `${call.name}: no view reaches the context limit`)
    const norm = normalizeLayaAnswers(merged.answers, call.questions)
    for (const [name, a] of Object.entries(norm.answers)) {
      if (a.type === 'choice') assert.deepEqual(Object.keys(a.probabilities), Object.keys(call.questions[name].criteria), `${call.name}: ${name} keeps its keys`)
    }
  }
  assert.ok(fake.requests.every((r) => r.status === 200), 'no request was refused')
})

test('the rendering changes only what Laya reads: option text, instructions, noul labels and criteria', () => {
  const [task] = capture((jev) => jev.route({ task: 'fix it', context: CONTEXT, capabilities: ALL_CAPABILITIES, tools: TOOLS, ask: { task: true, resource: false, judgments: false } }))
  const q = Object.assign({}, ...renderForLaya({ phase: 'route', ...task }).map((r) => r.questions))
  assert.equal(q.taskType.criteria.debugging, LAYA_SHORT.taskType.debugging)
  assert.equal(q.skill.criteria.devops, LAYA_SHORT.skill.devops)
  assert.equal(q.capability.criteria.human_required, LAYA_SHORT.capability.human_required)
  assert.equal(q.minimumCapability.criteria.frontier, LAYA_SHORT.tier.frontier)
  assert.deepEqual(q.risk.criteria, LAYA_SHORT.risk)
  assert.deepEqual(q['req.coding'].criteria, LAYA_SHORT.requirement)
  assert.equal(q.handler.criteria.agent, LAYA_SHORT.handler.agent)
  // Person-written text, a tool's description and its parameter options, keeps its first 8 words.
  assert.equal(q.handler.criteria.format_code, 'Runs prettier over the whole repository and then')
  assert.equal(q['format_code.scope'].criteria.all, 'Every file in the repository, including generated and')
  assert.equal(q['bump_version.level'].criteria.patch, 'A bug fix only')
  // Any other `{ what, not_for }` becomes the plain `what`.
  const [other] = renderForLaya({ phase: 'route', state: { task: 't' }, questions: { mystery: choice('Which?', { a: { what: 'the first one', not_for: 'the second' }, b: 'plain' }) } })
  assert.deepEqual(other.questions.mystery.criteria, { a: 'the first one', b: 'plain' })
})

// ---------------------------------------------------------------- 4.2 a, noul labels and criteria

test('every noul gets labels and NOUL_TEXT criteria, and a noul without text fails', () => {
  const layaNoul = (name, q) => {
    const text = noulText(name)
    assert.ok(text, `${name} has no NOUL_TEXT entry: add one to laya-questions.js`)
    assert.deepEqual(q.labels, { true: 'A', false: 'B' }, `${name}: labels`)
    assert.deepEqual(q.criteria, { true: text.true, false: text.false }, `${name}: criteria`)
    assert.match(q.criteria.true, /^yes: /)
    assert.match(q.criteria.false, /^no: /)
  }
  const seen = new Set()
  for (const call of maximalCalls()) {
    for (const r of renderForLaya(call)) {
      for (const [name, q] of Object.entries(r.questions)) if (q.type === 'noul') { layaNoul(name, q); seen.add(name.endsWith('.fits') ? '<tool>.fits' : name) }
    }
  }
  // NOUL_TEXT covers exactly the nouls KzH sends, the per-tool fits question included.
  assert.deepEqual([...seen].sort(), Object.keys(NOUL_TEXT).sort())
  assert.deepEqual(NOUL_LABELS, { true: 'A', false: 'B' })
  assert.equal(noulText('format_code.fits').true, 'yes: the format_code tool does exactly what the task asks')
  assert.equal(noulText('format_code.fits').false, 'no: the task needs an AI agent, not the format_code tool')
  assert.deepEqual(noulText('needsPerson'), { true: 'yes: the attempt asks a question, says it is blocked, or needs a decision only a person can make', false: 'no: the attempt finished or failed on its own' })
  // A noul jev.js gains without an entry fails the check above, and still renders at run time.
  const [r] = renderForLaya({ phase: 'review', state: {}, questions: { brandNew: noul('Is it new?') } })
  assert.equal(noulText('brandNew'), null)
  assert.throws(() => layaNoul('brandNew', r.questions.brandNew), /brandNew has no NOUL_TEXT entry/)
  assert.deepEqual(r.questions.brandNew.labels, { true: 'A', false: 'B' })
})

// ---------------------------------------------------------------- 4.2 b and c, option texts and the head

test('estimateHeadTokens is ceil(chars / 3.6) + 4 per option + 8, over the instruction and the option texts', () => {
  // The key, level or label before each option text is what the 4 per option stand for.
  const q = { type: 'choice', instructions: 'Pick one', criteria: { a: 'first', b: null } }
  assert.deepEqual(renderOptions(q), ['a: first', 'b'])
  assert.equal(estimateHeadTokens(q), Math.ceil(('Pick one'.length + 'first'.length) / 3.6) + 2 * 4 + 8)
  const n = { type: 'noul', instructions: 'Is it?', criteria: { true: 'yes: it is', false: 'no: it is not' }, labels: { true: 'A', false: 'B' } }
  assert.deepEqual(renderOptions(n), ['B: no: it is not', 'A: yes: it is'])
  assert.equal(estimateHeadTokens(n), Math.ceil(('Is it?'.length + 'no: it is not'.length + 'yes: it is'.length) / 3.6) + 2 * 4 + 8)
  const s = { type: 'score', instructions: 'x', criteria: ['low', 'high'] }
  assert.deepEqual(renderOptions(s), ['level 0: low', 'level 1: high'])
  assert.equal(estimateHeadTokens(s), Math.ceil(8 / 3.6) + 2 * 4 + 8)
  assert.deepEqual(renderOptions({ type: 'noul', instructions: 'x' }), ['false: no, the statement does not hold', 'true: yes, the statement holds'])
  // The request estimate counts the whole head, keys included: every character is tokenised.
  assert.equal(headChars(q), 'Pick one'.length + 'a: first'.length + 'b'.length)
  assert.equal(estimateRequestTokens({ state: { k: 'v' }, questions: { q, n } }), Math.ceil(headChars(q) / 3.6) + Math.ceil(headChars(n) / 3.6) + 2 * Math.ceil(9 / 3))
})

test('every choice at its maximum option count estimates within 170 head tokens, and the focus rides only while it fits', () => {
  assert.equal(HEAD_BUDGET, 170)
  const sizes = {}
  for (const call of [...maximalCalls(), { name: 'review, 24 candidates', ...reviewCall(24) }]) {
    const rendered = Object.assign({}, ...renderForLaya(call).map((r) => r.questions))
    for (const [name, q] of Object.entries(rendered)) {
      assert.ok(estimateHeadTokens(q) <= HEAD_BUDGET, `${call.name}: ${name} estimates ${estimateHeadTokens(q)} head tokens`)
      if (q.type === 'choice') sizes[name] = Math.max(sizes[name] ?? 0, Object.keys(q.criteria).length)
      const ins = call.questions[name].instructions
      if (ins && typeof ins === 'object' && ins.focus) {
        // The question and the focus as this question's view words them, each rendered alone.
        const worded = (text) => Object.assign({}, ...renderForLaya({ ...call, questions: { [name]: { ...call.questions[name], instructions: text } } }).map((r) => r.questions))[name].instructions
        const withFocus = `${worded(ins.question)} ${worded(ins.focus)}`
        if (q.instructions === withFocus) continue
        assert.equal(q.instructions, worded(ins.question), `${call.name}: ${name} is the question alone`)
        assert.ok(estimateHeadTokens({ ...q, instructions: withFocus }) > HEAD_BUDGET, `${call.name}: ${name} left out a focus that fits`)
      }
    }
  }
  // The largest option sets KzH offers: 12 task types, 14 skills, all 9 capabilities with
  // human_required and other, all 11 strategies, and a review over 24 candidates.
  assert.equal(sizes.taskType, 12)
  assert.equal(sizes.skill, 14)
  assert.equal(sizes.capability, 11)
  assert.equal(sizes.strategy, 11)
  assert.equal(sizes.reviewAgent, 24)
  // The fixed option sets fit with their hand-written texts whole.
  const [task] = maximalCalls().slice(1)
  const q = Object.assign({}, ...renderForLaya(task).map((r) => r.questions))
  for (const [name, family] of [['taskType', 'taskType'], ['skill', 'skill'], ['capability', 'capability'], ['minimumCapability', 'tier']]) {
    assert.deepEqual(q[name].criteria, Object.fromEntries(Object.keys(q[name].criteria).map((k) => [k, LAYA_SHORT[family][k]])), name)
  }
  // A few candidates keep every number; the more there are, the less telling numbers go first.
  const pick = (n) => Object.assign({}, ...renderForLaya(reviewCall(n)).map((r) => r.questions)).reviewAgent.criteria
  assert.equal(pick(3).RESOURCE_B, 'tier strong, fit 0.53, cost low, reliability 0.80')
  assert.equal(pick(8).RESOURCE_B, 'tier strong, cost low, reliability 0.80')
  assert.equal(pick(12).RESOURCE_B, 'tier strong')
  assert.ok(Object.values(pick(24)).every((text) => text === ''), 'past what the head holds, only the keys go')
})

test('LAYA_SHORT has a text for every option KzH can offer, at most 8 words, and at most 6 per score level', () => {
  const wordsOf = (s) => s.split(/\s+/).filter(Boolean).length
  const need = {
    taskType: Object.keys(TASK_TYPES), skill: Object.keys(SKILLS), capability: [...Object.keys(CAPABILITIES), 'other'],
    tier: ['standard', 'strong', 'frontier'], strategy: Object.keys(STRATEGIES), verdict: Object.keys(VERDICTS),
    disposition: Object.keys(DISPOSITION_CRITERIA), kind: ['task', 'question'], depth: ['everyday', 'deep'], handler: ['agent'],
  }
  for (const [family, keys] of Object.entries(need)) {
    assert.deepEqual(Object.keys(LAYA_SHORT[family]).sort(), [...keys].sort(), `LAYA_SHORT.${family} covers exactly its options`)
    for (const k of keys) assert.ok(wordsOf(LAYA_SHORT[family][k]) <= 8, `${family}.${k}: ${LAYA_SHORT[family][k]}`)
  }
  for (const family of ['complexity', 'risk', 'requirement']) {
    assert.equal(LAYA_SHORT[family].length, 5)
    for (const level of LAYA_SHORT[family]) assert.ok(wordsOf(level) <= 6, `${family}: ${level}`)
  }
  assert.equal(LAYA_SHORT.taskType.debugging, 'find and fix the cause of a bug')
  assert.equal(LAYA_SHORT.risk[4], 'critical: security, money or irreversible data')
  assert.ok(Object.isFrozen(LAYA_SHORT.taskType) && Object.isFrozen(NOUL_TEXT.needsPerson))
  assert.equal(ADAPTER_VERSION, 1)
})

// ---------------------------------------------------------------- 4.2 d, state views

test('every view is at most 950 characters, with checks first in the outcome view, on the captured 9,206-character review state', () => {
  const call = BODIES.review
  assert.equal(JSON.stringify(call.state).length, 9206)
  const requests = renderForLaya(call)
  const byKey = Object.fromEntries(requests.map((r) => [r.key, r]))
  assert.deepEqual(requests.map((r) => r.key), ['outcome', 'diff', 'person', 'pick'])
  for (const r of requests) assert.ok(JSON.stringify(r.state).length <= VIEW_LIMIT, `${r.key}: ${JSON.stringify(r.state).length} characters`)
  assert.deepEqual(Object.keys(byKey.outcome.questions), ['verdict', 'disposition', 'addressed', 'complete'])
  assert.deepEqual(Object.keys(byKey.diff.questions), ['unrelatedChanges', 'regressionRisk'])
  assert.deepEqual(Object.keys(byKey.person.questions), ['needsPerson'])
  assert.deepEqual(Object.keys(byKey.pick.questions), ['reviewAgent', 'retryAgent'])
  // Checks first, so Laya's right-truncation can never drop them; today neither the checks nor the
  // diff reach the model at all.
  assert.deepEqual(Object.keys(byKey.outcome.state), ['checks', 'task', 'diff_stat', 'files', 'answer_end'])
  assert.equal(byKey.outcome.state.checks, 'test pass')
  assert.equal(byKey.outcome.state.files, 'src/auth/LoginForm.tsx, src/auth/LoginForm.test.tsx')
  assert.ok(byKey.outcome.state.answer_end.endsWith('while the request is in flight. '))
  assert.ok(byKey.outcome.state.answer_end.startsWith('…'))
  assert.ok(byKey.diff.state.diff.startsWith('diff --git a/src/auth/LoginForm.tsx'))
  assert.deepEqual(Object.keys(byKey.person.state), ['status', 'answer_end', 'task'])
  assert.equal(byKey.person.state.status, 'end_turn')
  assert.deepEqual(byKey.pick.state, { task: `${call.state.task.slice(0, 199)}…`, task_type: 'debugging', risk: 0.4, latest: { resource: 'claude', status: 'end_turn' } })
  // Every view of every maximal call holds the limit too.
  for (const c of maximalCalls()) for (const r of renderForLaya(c)) assert.ok(JSON.stringify(r.state).length <= VIEW_LIMIT, `${c.name} ${r.key}`)
})

test('every field an instruction names in backticks is one its view carries, the review\'s spelled as its views spell them', () => {
  const keysOf = (v, out = new Set()) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) out.add(k); keysOf(x, out) }
    return out
  }
  // One candidate with no numbers leaves the review and retry picks room for their focus.
  const [lone] = capture((jev) => jev.assess({
    task: 't', routing: { taskType: 'debugging', risk: 0.3, decision: { candidates: [{ id: 'agent-0', key: 'RESOURCE_A', tier: 'strong' }], excluded: [] } },
    attempts: [{ agent: 'agent-0', role: 'primary', stopReason: 'end_turn', answerText: 'done', changedFiles: ['a.js'] }], checks: [],
    diff: { stat: ' a.js | 2 +-', patch: 'diff --git a/a.js b/a.js\n-x\n+y' }, agents: [{ id: 'agent-0', description: 'x' }],
  }))
  const loneCall = { name: 'review, one bare candidate', phase: 'review', ...lone }
  for (const call of [...maximalCalls(), { name: 'review, 3 anonymous candidates', ...reviewCall(3) }, loneCall]) {
    for (const r of renderForLaya(call)) {
      const fields = keysOf(r.state)
      for (const [name, q] of Object.entries(r.questions)) {
        // A tool's fits question names the tool, and a focus may name an option: neither is a field.
        const own = [/^(.+)\.fits$/.exec(name)?.[1], ...(q.type === 'choice' ? Object.keys(q.criteria) : [])]
        for (const [, ref] of q.instructions.matchAll(/`([A-Za-z_][\w.]*)`/g)) {
          if (!own.includes(ref)) assert.ok(fields.has(ref), `${call.name} ${r.key}: ${name} names \`${ref}\`, which its view does not carry`)
        }
      }
    }
  }
  const pick = renderForLaya(loneCall).find((r) => r.key === 'pick').questions
  assert.match(pick.retryAgent.instructions, /other than the `resource` that just failed, .* Each option is an anonymous candidate: .* The `resource` in `latest` is its key;/)
  const q = Object.assign({}, ...renderForLaya(BODIES.review).map((r) => r.questions))
  assert.equal(q.verdict.instructions, 'Given the latest attempt (`answer_end`, `files`), `checks`, and `diff_stat`, what should happen next for `task`? Judge the evidence, not the agent\'s own claims. A failing required check in `checks` means the task is not done.')
  assert.equal(q.disposition.instructions, 'Which disposition fits the latest attempt (`answer_end`, `files`) for `task`?')
  assert.equal(q.addressed.instructions, 'Does the latest attempt (its `answer_end`, `files` and `diff_stat`) do what `task` asked?')
  assert.equal(q.complete.instructions, 'Is every part of `task` handled by the latest attempt (`answer_end`, `files`) and `diff_stat`, with nothing left undone?')
  assert.equal(q.needsPerson.instructions, 'Does the latest attempt (`status`, `answer_end`) ask a question, report being blocked, or need a decision only a person can make?')
  // The diff view carries `diff` itself, so its questions are sent as jev.js words them.
  assert.equal(q.unrelatedChanges.instructions, BODIES.review.questions.unrelatedChanges.instructions)
  assert.equal(BODIES.review.questions.verdict.instructions.question, 'Given the latest entry in `attempts`, `verification`, and `diff`, what should happen next for `task`?', 'jev.js is unchanged')
})

test('the pick view keeps a class profile\'s mean risk, rounded to 4 decimals, where it left a long one out', () => {
  // decision.js profileFromClass gives the class mean, which is routinely sixteen digits long.
  for (const [risk, shown] of [[1 / 3, 0.3333], [2 / 3, 0.6667], [0.5864, 0.5864], [0.4, 0.4]]) {
    const state = { ...BODIES.review.state, routing: { ...BODIES.review.state.routing, risk } }
    const [pick] = renderForLaya({ phase: 'review', state, questions: { reviewAgent: BODIES.review.questions.reviewAgent } })
    assert.deepEqual(Object.keys(pick.state), ['task', 'task_type', 'risk', 'latest'], `risk ${risk}`)
    assert.equal(pick.state.risk, shown)
  }
})

test('views cut in the right places: the checks line puts failures first when long, the answer end is real text, the message keeps head and tail', () => {
  // jev.js clips a long answer to its first 2500 characters and marks the cut; the person view's
  // tail must end on the answer's own words, not on that marker.
  const long = reviewCall(3, { answer: `${LONG(800, 'word')} Should I drop the old table?` })
  const views = Object.fromEntries(renderForLaya(long).map((r) => [r.key, r.state]))
  const sent = long.state.attempts.at(-1).answer
  assert.match(sent, /\n\.\.\.\[truncated \d+ chars\]$/)
  assert.ok(!views.person.answer_end.includes('[truncated'), views.person.answer_end.slice(-60))
  assert.ok(views.person.answer_end.endsWith(sent.slice(2450, 2500)), 'the tail ends where the text jev.js kept ends')
  assert.equal(views.outcome.checks, 'typecheck pass, lint pass, test FAIL (regressed), build pass')
  const many = { ...long.state, verification: { results: Array.from({ length: 9 }, (_, i) => ({ name: `check-number-${i}`, passed: i !== 7 })), regressed: [] } }
  const outcome = renderForLaya({ phase: 'review', state: many, questions: { verdict: long.questions.verdict } })[0].state
  assert.match(outcome.checks, /^check-number-7 FAIL, check-number-0 pass/)
  assert.ok(outcome.checks.length <= 90)
  const message = `${'a'.repeat(1000)}${'b'.repeat(1000)}`
  const intent = renderForLaya({ phase: 'intent', state: { message }, questions: { kind: choice('k', { task: 'x', question: 'y' }) } })[0].state
  assert.equal(intent.message, `${'a'.repeat(600)} … ${'b'.repeat(300)}`)
  assert.equal(renderForLaya({ phase: 'intent', state: { message: 'short' }, questions: { kind: choice('k', { task: 'x', question: 'y' }) } })[0].state.message, 'short')
})

test('views hold the limit whatever the text escapes to, and never split a character', () => {
  const nasty = `${'"\\\n\t'.repeat(400)}${'\u{1F600}'.repeat(400)}\u0001`
  const state = {
    task: nasty, workspace: { note: nasty, files: Array(50).fill(nasty) }, handoff: nasty, task_profile: { risk: 0.5, note: nasty },
    attempts: [{ agent: nasty, status: nasty, answer: nasty, changed_files: [nasty, nasty] }], verification: [{ name: nasty, passed: false }],
    diff: { stat: nasty, excerpt: nasty }, routing: { task_type: nasty, risk: 0.2 }, message: nasty,
  }
  const questions = (names) => Object.fromEntries(names.map((n) => [n, noul('q')]))
  for (const [phase, names] of [['review', ['verdict', 'unrelatedChanges', 'needsPerson', 'reviewAgent']], ['route', ['taskType', 'continueHandoff', 'strategy', 'agent']], ['intent', ['kind']], ['other', ['x']]]) {
    for (const r of renderForLaya({ phase, state, questions: questions(names) })) {
      const text = JSON.stringify(r.state)
      assert.ok(text.length <= VIEW_LIMIT, `${phase} ${r.key}: ${text.length}`)
      assert.ok(!/\\ud[89a-f][0-9a-f]{2}/i.test(text), `${phase} ${r.key}: a character was split`)
    }
  }
})

// ---------------------------------------------------------------- 4.2 e and f, requests and truncation

test('an acting call sends one request per view; a shadow call sends chunks of chunkRows questions within each view', () => {
  const [, task] = maximalCalls()
  const act = renderForLaya(task, { role: 'act' })
  assert.deepEqual(act.map((r) => r.key), ['task', 'handoff', 'resource'])
  assert.deepEqual(Object.keys(act[1].questions), ['continueHandoff'])
  assert.deepEqual(Object.keys(act[2].questions), ['secondOpinion'])
  const shadow = renderForLaya(task, { role: 'shadow', chunkRows: 4 })
  const taskRows = Object.keys(act[0].questions).length
  assert.equal(shadow.length, Math.ceil(taskRows / 4) + 2)
  for (const r of shadow) {
    assert.ok(Object.keys(r.questions).length <= 4)
    assert.equal(r.model, 'english')
  }
  assert.deepEqual(shadow.filter((r) => r.key.startsWith('task.')).map((r) => r.state), Array(Math.ceil(taskRows / 4)).fill(act[0].state), 'every chunk of a view carries that view')
  assert.deepEqual(shadow.flatMap((r) => Object.keys(r.questions)), act.flatMap((r) => Object.keys(r.questions)), 'chunks keep the order')
  assert.ok(renderForLaya(task, { role: 'shadow', chunkRows: 1 }).every((r) => Object.keys(r.questions).length === 1))
  // laya.serve refuses more than 64 questions, so even an acting view is split there.
  const wide = { phase: 'route', state: { task: 't' }, questions: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`q${i}`, noul('q')])) }
  assert.deepEqual(renderForLaya(wide).map((r) => Object.keys(r.questions).length), [64, 6])
  assert.deepEqual(renderForLaya(wide, { role: 'shadow', chunkRows: 100 }).map((r) => Object.keys(r.questions).length), [64, 6], 'and so is a shadow chunk larger than that')
})

test('atContextLimit comes from usage: a request whose rows average 97% of 512 tokens counts', async (t) => {
  const part = (rows, perRow) => ({ key: 'k', response: { answers: Object.fromEntries(Array.from({ length: rows }, (_, i) => [`q${i}`, { type: 'noul', noul: 0.5 }])), usage: { input_tokens: rows * perRow } } })
  const questions = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`q${i}`, noul('q')]))
  assert.equal(mergeLaya({ questions }, [part(4, 497)]).meta.atContextLimit, 1)
  assert.equal(mergeLaya({ questions }, [part(4, 496)]).meta.atContextLimit, 0)
  const merged = mergeLaya({ questions }, [part(2, 512), part(4, 300)])
  assert.equal(merged.meta.atContextLimit, 1)
  assert.equal(merged.usage.input_tokens, 2 * 512 + 4 * 300)
  // For real: the review as Jev gets it fills every row; its views do not.
  const fake = await startFakeLaya()
  t.after(() => fake.close())
  const client = new TypeSafeClient({ apiKey: 'k', baseURL: fake.url, retry: { maxRetries: 0 } })
  const call = BODIES.review
  const unviewed = await client.systemOne({ model: 'english', state: call.state, questions: renderForLaya(call).reduce((q, r) => ({ ...q, ...r.questions }), {}) })
  assert.equal(mergeLaya(call, [{ key: 'all', response: unviewed }]).meta.atContextLimit, 1)
  assert.equal(unviewed.usage.input_tokens, 9 * 512)
  const parts = []
  for (const r of renderForLaya(call)) {
    const response = await client.systemOne({ model: r.model, state: r.state, questions: r.questions })
    assert.equal(response.usage.input_tokens, estimateRequestTokens(r), `${r.key}: the estimate is what the fake counts`)
    parts.push({ key: r.key, response })
  }
  assert.equal(mergeLaya(call, parts).meta.atContextLimit, 0)
})

// ---------------------------------------------------------------- never mutating its input

test('renderForLaya on deep-frozen inputs, in strict mode, never throws and returns new objects', () => {
  for (const call of maximalCalls()) {
    const before = JSON.stringify(call)
    deepFreeze(call)
    for (const role of ['act', 'shadow']) {
      const requests = renderForLaya(call, { role })
      for (const r of requests) {
        assert.ok(!Object.isFrozen(r.state) && r.state !== call.state)
        for (const [name, q] of Object.entries(r.questions)) {
          assert.notEqual(q, call.questions[name])
          assert.notEqual(q.criteria, call.questions[name].criteria)
          if (q.labels) assert.notEqual(q.labels, NOUL_LABELS)
          q.criteria.extra = 'written by a consumer'
        }
        for (const v of Object.values(r.state)) if (v && typeof v === 'object') for (const w of Object.values(call.state)) assert.notEqual(v, w)
      }
    }
    assert.equal(JSON.stringify(call), before, `${call.name}: the input is unchanged`)
  }
  // Rendering the same call again is unaffected by what a consumer wrote into the last rendering.
  const call = deepFreeze(clone(BODIES.task))
  const first = renderForLaya(call)
  first[0].questions.taskType.criteria.debugging = 'changed'
  assert.equal(renderForLaya(call)[0].questions.taskType.criteria.debugging, LAYA_SHORT.taskType.debugging)
  const answers = deepFreeze({ kind: { type: 'choice', choice: 'task', probabilities: { task: 0.9, question: 0.1 }, confidence: 0.53 } })
  const norm = normalizeLayaAnswers(answers, BODIES.intent.questions)
  assert.notEqual(norm.answers.kind, answers.kind)
})

// ---------------------------------------------------------------- 4.3, normalisation

const choiceAnswer = (keys, p, confidence = 0.1) => ({ type: 'choice', choice: keys[p.indexOf(Math.max(...p))], probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]])), confidence, answer_confidence: Math.max(...p), action: { act_probability: 0.5 } })
const retempered = (p, tau) => { const w = p.map((x) => x ** (1 / tau)); const s = w.reduce((a, b) => a + b, 0); return w.map((x) => Math.round((x / s) * 1e4) / 1e4) }

test('normalizeLayaAnswers re-tempers exactly the answers asked with 11 or more options, at the default 3.27, and keeps keys', () => {
  const route = (capabilities) => capture((jev) => jev.route({ task: 't', capabilities, ask: { task: true, resource: false, judgments: false } }))[0].questions
  const nine = route(ALL_CAPABILITIES)
  const seven = route(ALL_CAPABILITIES.slice(0, 7))
  assert.equal(Object.keys(nine.capability.criteria).length, 11)
  assert.equal(Object.keys(seven.capability.criteria).length, 9)
  const spread = (k) => { const raw = Array.from({ length: k }, (_, i) => (i === 0 ? 0.4 : 0.6 / (k - 1))); return raw }
  const answersFor = (qs) => Object.fromEntries(Object.entries(qs).map(([n, q]) => [n, q.type === 'choice' ? choiceAnswer(Object.keys(q.criteria), spread(Object.keys(q.criteria).length))
    : q.type === 'score' ? { type: 'score', score: 1.2, probabilities: { 0: 0.2, 1: 0.4, 2: 0.2, 3: 0.1, 4: 0.1 }, confidence: 0.1 }
      : { type: 'noul', noul: 0.7, confidence: 0.7 }]))
  const n9 = normalizeLayaAnswers(answersFor(nine), nine)
  const n7 = normalizeLayaAnswers(answersFor(seven), seven)
  assert.deepEqual(n9.corrected.sort(), ['capability', 'skill', 'taskType'])
  assert.deepEqual(n7.corrected.sort(), ['skill', 'taskType'], 'a capability question with seven capabilities has nine options, and is not corrected')
  const keys = Object.keys(nine.capability.criteria)
  const cap = n9.answers.capability
  assert.equal(cap.corrected, true)
  assert.deepEqual(Object.keys(cap.probabilities), keys, 'keys kept, in order')
  assert.deepEqual(Object.values(cap.probabilities), retempered(spread(11), 3.27))
  assert.equal(cap.choice, 'quick_answer', 'the pick is unchanged by re-tempering')
  assert.ok(cap.probabilities.quick_answer < 0.4, 'a flatter, honest distribution')
  assert.equal(n7.answers.capability.corrected, false)
  assert.deepEqual(n7.answers.capability.probabilities, answersFor(seven).capability.probabilities)
  for (const n of ['minimumCapability', 'risk', 'humanReview']) assert.equal(n9.answers[n].corrected, false, n)
  // Another bucket is corrected only when configured, a score's expected level moves with it.
  const custom = normalizeLayaAnswers(answersFor(nine), nine, { temperatureCorrections: { 'score:3-5': 2, 'noul:2': 2 } })
  assert.deepEqual(custom.corrected.filter((n) => n === 'risk' || n === 'humanReview'), ['risk', 'humanReview'])
  const p = retempered([0.2, 0.4, 0.2, 0.1, 0.1], 2)
  assert.deepEqual(Object.values(custom.answers.risk.probabilities), p)
  assert.equal(custom.answers.risk.score, Math.round(p.reduce((s, x, i) => s + i * x, 0) * 1e4) / 1e4)
  assert.equal(custom.answers.humanReview.noul, retempered([0.3, 0.7], 2)[1])
  assert.equal(custom.answers.taskType.corrected, false, 'the configured corrections replace the default')
})

test('a re-tempered answer\'s answer_confidence is its new max probability, not the one Laya served before the correction', () => {
  const questions = BODIES.task.questions
  const keys = Object.keys(questions.taskType.criteria)
  assert.equal(keys.length, 12)
  const p = keys.map((_, i) => (i === 3 ? 0.9 : 0.1 / (keys.length - 1)))
  const { answers } = normalizeLayaAnswers({ taskType: choiceAnswer(keys, p, 0.61), risk: { type: 'score', score: 1, probabilities: { 0: 0.1, 1: 0.6, 2: 0.1, 3: 0.1, 4: 0.1 }, confidence: 0.3, answer_confidence: 0.6 } }, questions)
  const a = answers.taskType
  assert.equal(a.corrected, true)
  assert.equal(a.confidence, Math.max(...retempered(p, 3.27)))
  assert.equal(a.answer_confidence, a.confidence, 'one max probability on a corrected answer, not two')
  assert.equal(a.servedConfidence, 0.61)
  // An answer that is not re-tempered keeps what Laya served, which already is its max probability.
  assert.equal(answers.risk.corrected, false)
  assert.equal(answers.risk.answer_confidence, 0.6)
})

test('normalizeLayaAnswers sets max-probability confidence, keeps servedConfidence, and marks flat answers', () => {
  const questions = {
    sure: choice('q', { a: null, b: null, c: null }),
    flat: choice('q', { a: null, b: null, c: null, d: null, e: null }),
    risk: { type: 'score', instructions: 'q', criteria: ['0', '1', '2', '3', '4'] },
    yes: noul('q'), unsure: noul('q'), edge: noul('q'),
  }
  const answers = {
    sure: choiceAnswer(['a', 'b', 'c'], [0.7, 0.2, 0.1], 0.2),
    flat: choiceAnswer(['a', 'b', 'c', 'd', 'e'], [0.29, 0.18, 0.18, 0.18, 0.17], 0.01),
    risk: { type: 'score', score: 2, probabilities: { 0: 0.17, 1: 0.17, 2: 0.32, 3: 0.17, 4: 0.17 }, confidence: 0.05, legend: {} },
    yes: { type: 'noul', noul: 0.85, confidence: 0.85 },
    unsure: { type: 'noul', noul: 0.45, confidence: 0.55 },
    edge: { type: 'noul', noul: 0.6, confidence: 0.6 },
  }
  const { answers: out, uninformative, corrected } = normalizeLayaAnswers(answers, questions)
  assert.deepEqual(corrected, [])
  assert.equal(out.sure.confidence, 0.7)
  assert.equal(out.sure.servedConfidence, 0.2, 'the served normalised entropy is kept for the trace')
  assert.equal(out.sure.informative, true)
  assert.equal(out.flat.confidence, 0.29)
  assert.equal(out.flat.informative, false, '0.29 is under 1/5 + 0.1')
  // A score whose expected level lands on 0.5 passes: the filter reads the top probability.
  assert.equal(out.risk.informative, true)
  assert.equal(out.risk.confidence, 0.32)
  assert.equal(out.yes.confidence, 0.85)
  assert.equal(out.unsure.informative, false)
  assert.equal(out.unsure.confidence, 0.55)
  assert.equal(out.edge.informative, true, 'at 1/2 + 0.1 exactly an answer counts')
  assert.deepEqual(uninformative, ['flat', 'unsure'])
  assert.equal(out.flat.choice, 'a')
  assert.deepEqual(out.flat.probabilities, answers.flat.probabilities)
  // minTopMargin 0 switches the filter off, even for an exactly uniform answer.
  const off = normalizeLayaAnswers({ ...answers, even: choiceAnswer(['a', 'b', 'c'], [0.3333, 0.3333, 0.3334]) }, { ...questions, even: choice('q', { a: null, b: null, c: null }) }, { minTopMargin: 0 })
  assert.deepEqual(off.uninformative, [])
  const wider = normalizeLayaAnswers(answers, questions, { minTopMargin: 0.3 })
  assert.deepEqual(wider.uninformative, ['flat', 'risk', 'unsure', 'edge'])
})

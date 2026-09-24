// Drives the real routing loop against a throwaway git repo with fake Jev and
// fake agents: fallback labelling, loop limits, second review, manual override,
// and deterministic checks blocking a wrong "accept".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareAnswers, formatReport, runRouted } from '../router.js'
import { NO_CANDIDATES } from '../decision.js'

const config = {
  agents: [
    { id: 'claude', provider: 'x', description: 'a', enabled: true },
    { id: 'codex', provider: 'x', description: 'b', enabled: true },
    { id: 'deepseek', provider: 'x', description: 'c', enabled: true },
  ],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 3, maxReviews: 2, maxRounds: 5 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
}

// Repo whose `npm test` passes only when state.txt says "fixed".
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-router-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" },
  }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const history = () => { const rows = []; return { rows, recent: async () => [], append: async (r) => { rows.push(r) } } }
const fixer = (dir) => async () => { writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'fixed it' } }
const noop = async () => ({ stopReason: 'completed', answerText: 'looked, changed nothing' })
const routeResult = (over = {}) => ({
  primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { claude: 0.1, codex: 0.8, deepseek: 0.1 },
  taskType: 'debugging', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2,
  needsSecondOpinion: 0.1, needsHumanReview: 0.1, needsTests: 0.9, ...over,
})
// 'accept' = strong nouls (quality 0.9), 'retry' = weak (quality 0.2).
const verdict = (v, over = {}) => ({
  verdict: v, verdictConfidence: 0.9, verdictProbabilities: {},
  ...(v === 'accept' ? { addressed: 0.9, complete: 0.9 } : { addressed: 0.2, complete: 0.2 }),
  unrelatedChanges: 0.1, regressionRisk: 0.1, needsPerson: 0.05,
  reviewAgent: 'claude', reviewAgentProbabilities: { claude: 0.5, codex: 0.3, deepseek: 0.2 }, retryAgent: 'claude', retryAgentProbabilities: { claude: 0.5, codex: 0.3, deepseek: 0.2 }, ...over,
})
const signal = new AbortController().signal

test('Jev unavailable: labelled fallback, deterministic accept', async () => {
  const dir = repo()
  const h = history()
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev: null, jevUnavailableReason: 'TYPESAFE_API_KEY not configured', execute: fixer(dir), history: h } })
  assert.equal(r.routing.mode, 'fallback')
  assert.equal(r.routing.primaryAgent, 'claude')
  assert.equal(r.finalStatus, 'accepted')
  assert.deepEqual(r.attempts[0].changedFiles, ['state.txt'])
  assert.equal(h.rows.length, 1)
  assert.match(formatReport(r), /JEV UNAVAILABLE: routing fallback activated/)
})

test('Jev throws: fallback is labelled, never presented as a Jev decision', async () => {
  const dir = repo()
  const jev = { route: async () => { throw new Error('timeout') }, assess: async () => { throw new Error('timeout') } }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, execute: fixer(dir), history: history() } })
  assert.equal(r.routing.mode, 'fallback')
  assert.match(r.routing.reason, /timeout/)
  assert.equal(r.assessments[0].mode, 'fallback')
})

test('failing checks override a Jev accept; loop stops at maxAttempts', async () => {
  const dir = repo()
  const used = []
  const jev = { route: async () => routeResult(), assess: async () => verdict('accept') }
  const execute = async (a) => { used.push(a.id); writeFileSync(join(dir, `touch-${used.length}.txt`), 'x'); return { stopReason: 'completed', answerText: 'done' } }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, execute, history: history() } })
  assert.equal(r.finalStatus, 'limit_reached')
  assert.equal(r.attempts.length, 3)
  assert.equal(used[0], 'codex')
  assert.ok(r.assessments.every((s) => s.action === 'retry'))
})

test('second opinion goes to a different agent, then accepts', async () => {
  const dir = repo()
  const used = []
  const jev = { route: async () => routeResult({ needsSecondOpinion: 0.9 }), assess: async () => verdict('accept', { reviewAgentProbabilities: { codex: 0.9, claude: 0.05, deepseek: 0.05 }, retryAgentProbabilities: { codex: 0.9, claude: 0.05, deepseek: 0.05 } }) }
  const execute = async (a, prompt) => { used.push(a.id); return used.length === 1 ? fixer(dir)() : noop() }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, execute, history: history() } })
  assert.deepEqual(used, ['codex', 'claude'])
  assert.equal(r.attempts[1].role, 'review')
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(readFileSync(join(dir, 'state.txt'), 'utf8'), 'fixed')
})

test('manual override bypasses routing but Jev still assesses', async () => {
  const dir = repo()
  let routed = false
  const jev = { route: async () => { routed = true; return routeResult() }, assess: async () => verdict('accept') }
  const r = await runRouted({ task: 'fix', cwd: dir, forceAgent: 'deepseek', config, signal, deps: { jev, execute: fixer(dir), history: history() } })
  assert.equal(routed, false)
  assert.equal(r.routing.mode, 'manual')
  assert.equal(r.attempts[0].agent, 'deepseek')
  assert.equal(r.assessments[0].mode, 'jev')
  assert.equal(r.finalStatus, 'accepted')
})

test('agent failure is recorded and rerouted, needsPerson goes to human', async () => {
  const dir = repo()
  const used = []
  let n = 0
  const jev = { route: async () => routeResult(), assess: async () => (++n === 1 ? verdict('retry') : verdict('accept', { needsPerson: 0.8 })) }
  const execute = async (a) => { used.push(a.id); if (used.length === 1) throw new Error('login expired'); return fixer(dir)() }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, execute, history: history() } })
  assert.equal(r.attempts[0].stopReason, 'error')
  assert.match(r.attempts[0].diagnostic, /login expired/)
  assert.equal(used[1], 'claude')
  assert.equal(r.finalStatus, 'needs_human')
})

test('missing workspace is rejected', async () => {
  await assert.rejects(runRouted({ task: 'x', cwd: join(tmpdir(), 'nope-jev-router'), config, signal, deps: { jev: null, execute: noop, history: history() } }), /workspace missing/)
})

const tools = [{ id: 'weather', description: 'weather lookup', command: 'x', params: { units: { question: 'Units?', options: { c: 'Celsius', f: 'Fahrenheit' } } } }]
const toolRoute = (over = {}) => routeResult({ handler: 'weather', toolFits: 0.9, toolArgConfidence: 0.8, toolArgs: { units: 'f' }, ...over })

test('Jev picks a tool: no agent runs when the review accepts its output', async () => {
  const dir = repo()
  const events = []
  let agentRan = false
  const jev = { route: async () => toolRoute(), assess: async () => verdict('accept') }
  const runTool = async (t, args) => ({ stopReason: 'completed', answerText: `${t.id} ${args.units}` })
  const r = await runRouted({ task: 'weather?', cwd: dir, config: { ...config, tools }, signal, deps: { jev, runTool, execute: async () => { agentRan = true; return {} }, history: history(), emit: (e) => events.push(e.type) } })
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(r.attempts[0].agent, 'tool:weather')
  assert.equal(agentRan, false)
  assert.deepEqual(events, ['start', 'routed', 'attempt_start', 'attempt_end', 'review', 'final'])
})

test('tool output rejected by review escalates to the routed agent', async () => {
  const dir = repo()
  let n = 0
  const jev = { route: async () => toolRoute(), assess: async () => verdict(n++ === 0 ? 'retry' : 'accept') }
  const runTool = async () => ({ stopReason: 'completed', answerText: 'nope' })
  const r = await runRouted({ task: 'fix', cwd: dir, config: { ...config, tools }, signal, deps: { jev, runTool, execute: fixer(dir), history: history() } })
  assert.deepEqual(r.attempts.map((a) => `${a.agent}/${a.role}`), ['tool:weather/tool', 'codex/primary'])
  assert.equal(r.finalStatus, 'accepted')
})

test('weak tool fit or weak argument ignores the tool', async () => {
  for (const over of [{ toolFits: 0.4 }, { toolArgConfidence: 0.3 }]) {
    const dir = repo()
    const jev = { route: async () => toolRoute(over), assess: async () => verdict('accept') }
    const r = await runRouted({ task: 'fix', cwd: dir, config: { ...config, tools }, signal, deps: { jev, execute: fixer(dir), history: history() } })
    assert.equal(r.attempts[0].agent, 'codex', JSON.stringify(over))
  }
})

test('signed-out agents are never picked; none signed in is an error', async () => {
  const dir = repo()
  const ready = { claude: { loggedIn: false, detail: 'not signed in' }, codex: { loggedIn: false, detail: 'not signed in' }, deepseek: { loggedIn: true } }
  const jev = { route: async () => routeResult(), assess: async () => verdict('accept') }
  const used = []
  const execute = async (a) => { used.push(a.id); return fixer(dir)() }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { ready, jev, execute, history: history() } })
  assert.deepEqual(used, ['deepseek'])
  assert.equal(r.finalStatus, 'accepted')
  await assert.rejects(runRouted({ task: 'fix', cwd: dir, forceAgent: 'claude', config, signal, deps: { ready, jev, execute, history: history() } }), /claude cannot run/)
  const none = { ...ready, deepseek: { loggedIn: false, detail: 'key missing' } }
  await assert.rejects(runRouted({ task: 'fix', cwd: dir, config, signal, deps: { ready: none, jev, execute, history: history() } }), /no LLM agent is switched on and signed in/)
})

test('after a tool escalates, an agent that breaks a passing test is not accepted', async () => {
  const dir = repo()
  writeFileSync(join(dir, 'state.txt'), 'fixed') // test passes before any work
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'pass'], { cwd: dir })
  let n = 0
  const jev = { route: async () => toolRoute({ needsTests: 0.1 }), assess: async () => verdict(n++ === 0 ? 'retry' : 'accept') }
  const runTool = async () => ({ stopReason: 'completed', answerText: 'nope' })
  const breaker = async () => { writeFileSync(join(dir, 'state.txt'), 'broken'); return { stopReason: 'completed', answerText: 'done' } }
  const r = await runRouted({ task: 'fix', cwd: dir, config: { ...config, tools, limits: { ...config.limits, maxAttempts: 2 } }, signal, deps: { jev, runTool, execute: breaker, history: history() } })
  assert.deepEqual(r.baseline, [{ name: 'test', passed: true }])
  assert.notEqual(r.finalStatus, 'accepted')
  assert.match(r.assessments[1].why, /regressed: test/)
})

test('a crashed reviewer hands the review to another agent instead of redoing the work', async () => {
  const dir = repo()
  const used = []
  let n = 0
  const jev = { route: async () => routeResult({ needsSecondOpinion: 0.9 }), assess: async () => verdict('accept') }
  const execute = async (a) => {
    used.push(a.id)
    if (used.length === 1) return fixer(dir)()
    if (used.length === 2) return { stopReason: 'error', diagnostic: 'boom', answerText: '' }
    n++
    return { stopReason: 'completed', answerText: 'looks right' }
  }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, execute, history: history() } })
  assert.deepEqual(r.attempts.map((a) => a.role), ['primary', 'review', 'review'])
  assert.equal(new Set(used).size, 3)
  assert.equal(n, 1)
  assert.match(r.assessments[1].why, /reviewer .* failed/)
  assert.equal(r.finalStatus, 'accepted')
})

test('answeredBy names Jev and each agent with its model and role', async () => {
  const { answeredBy } = await import('../router.js')
  const r = { routing: { mode: 'jev', model: 'jev-1.13.0' }, attempts: [
    { agent: 'deepseek', model: 'deepseek-flash', role: 'primary' },
    { agent: 'claude', model: 'opus', role: 'review' },
  ] }
  assert.equal(answeredBy(r), 'Jev (jev-1.13.0) → deepseek (deepseek-flash) → claude (opus) [reviewer]')
})

test('the chain keeps a return visit, and folds only a back-to-back repeat', async () => {
  const { answeredBy } = await import('../router.js')
  const chain = (attempts) => answeredBy({ routing: { mode: 'jev', model: 'j1' }, attempts })
  // deepseek works, claude reviews, codex retries, claude reviews AGAIN. Deduplicating agents
  // across the whole run would hide that last hop and end the story at codex.
  assert.equal(
    chain([
      { agent: 'deepseek', model: 'ds', role: 'primary' },
      { agent: 'claude', model: 'opus', role: 'review' },
      { agent: 'codex', model: 'gpt-5', role: 'retry' },
      { agent: 'claude', model: 'opus', role: 'review' },
    ]),
    'Jev (j1) → deepseek (ds) → claude (opus) [reviewer] → codex (gpt-5) → claude (opus) [reviewer]',
  )
  // Same agent twice running is one step, not two identical links.
  assert.equal(
    chain([
      { agent: 'deepseek', model: 'ds', role: 'primary' },
      { agent: 'deepseek', model: 'ds', role: 'retry' },
      { agent: 'claude', model: 'opus', role: 'review' },
    ]),
    'Jev (j1) → deepseek (ds) → claude (opus) [reviewer]',
  )
})

test('the credit rides along as a marker the chat renders as chips, not as text', async () => {
  const { formatReport, answeredSteps } = await import('../router.js')
  const r = {
    routing: { mode: 'jev', model: 'jev-1.13.0', primaryAgent: 'qwen-local', agentProbabilities: {}, taskType: 'simple_change', complexity: 0.01, risk: 0.03 },
    context: {}, availability: { out: [], near: [] }, limits: [], baseline: [], assessments: [],
    attempts: [
      { agent: 'qwen-local', role: 'primary', model: 'qwen3-8b', stopReason: 'completed', durationMs: 1000, changedFiles: ['a.txt'], answerExcerpt: 'THE ANSWER TEXT' },
      { agent: 'codex', role: 'review', model: 'gpt-5', stopReason: 'completed', durationMs: 1000, changedFiles: [] },
    ],
    finalStatus: 'accepted', statusReason: '', lastAnswer: 'THE ANSWER TEXT',
  }
  const out = formatReport(r)
  // A link reference definition renders as nothing, so the chain is carried without being read out.
  const marker = out.match(/^\[jev-agents\]: kzh-agents-1-([A-Za-z0-9_-]+)$/m)
  assert.ok(marker, 'the chain marker is there')
  assert.ok(out.indexOf(marker[0]) > out.indexOf('THE ANSWER TEXT'), 'after the answer, never before it')
  assert.equal(out.trimEnd().endsWith(marker[0]), true, 'and it is the last thing in the report')
  assert.deepEqual(JSON.parse(Buffer.from(marker[1], 'base64url').toString()), answeredSteps(r))
  // The old plain-markdown credit is gone: the strip draws it now, and two of them is one too many.
  assert.equal(out.includes('Answer by '), false)
  assert.equal(out.includes('**Answer from'), false)
})

test('the chain marker names the agent that wrote the answer, and only that one', async () => {
  const { answeredSteps } = await import('../router.js')
  const steps = answeredSteps({ routing: { mode: 'jev', model: 'j1' }, attempts: [
    { agent: 'deepseek', model: 'ds', role: 'primary', answerExcerpt: 'first try' },
    { agent: 'codex', model: 'gpt-5', role: 'retry', answerExcerpt: 'the answer you read' },
    { agent: 'claude', model: 'opus', role: 'review' },
  ] })
  assert.deepEqual(steps.map((s) => [s.agent, s.answered === true]), [['Jev', false], ['deepseek', false], ['codex', true], ['claude', false]])
})

// ---------- capability routing ----------
const { executorsFrom } = await import('../capabilities.js')
const CAP_CONFIG = { ...config, agents: [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
  { id: 'deepseek', provider: 'spawn', description: 'b', enabled: true },
] }

test('an executor that cannot do the request is never offered to Jev', async () => {
  const dir = repo()
  let offered = null
  const jev = { route: async ({ agents }) => { offered = agents.map((a) => a.id); return routeResult({ primaryAgent: 'deepseek', agentProbabilities: { deepseek: 0.9, claude: 0.1 } }) }, assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents, seesImages: (id) => id === 'claude' })
  const r = await runRouted({ task: 'read the receipt', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: noop, history: history(), executors, inputModalities: ['image'] } })
  assert.deepEqual(offered, ['claude'], 'the text-only agent is filtered out before Jev sees the options')
  assert.equal(r.routing.primaryAgent, 'claude')
})

test('Jev is offered the capability categories this machine can actually carry out', async () => {
  const dir = repo()
  let asked = null
  const jev = { route: async ({ capabilities }) => { asked = capabilities; return routeResult({ primaryAgent: 'claude', agentProbabilities: { claude: 0.9, deepseek: 0.1 } }) }, assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  await runRouted({ task: 'fix the parser', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: fixer(dir), history: history(), executors } })
  assert.ok(asked.includes('project_change'), 'the agents can change the project')
  assert.ok(asked.includes('project_read'))
  assert.equal(asked.includes('deterministic_tool'), false, 'the tool category has its own question')
  assert.equal(asked.includes('ocr'), false, 'nothing here can do OCR, so it is never offered')
})

test('a pick that cannot do the work is replaced by one that can', async () => {
  const dir = repo()
  const used = []
  // Jev ignores the filtered list and names an agent that was not offered.
  const jev = { route: async () => routeResult({ primaryAgent: 'claude', agentProbabilities: { claude: 0.9 } }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents, seesImages: (id) => id === 'deepseek' })
  const execute = async (a) => { used.push(a.id); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'done' } }
  const r = await runRouted({ task: 'read this image', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute, history: history(), executors, inputModalities: ['image'] } })
  assert.equal(used[0], 'deepseek', 'the agent that can read the image took the work')
  assert.equal(r.routing.capabilityFrom, 'claude')
  assert.ok(r.attempts.some((a) => a.agent === 'deepseek'), 'and the run reports who really worked')
})

test('when nothing can do the request it says so instead of pretending', async () => {
  const dir = repo()
  const jev = { route: async () => routeResult(), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  await assert.rejects(
    runRouted({ task: 'read this image', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: noop, history: history(), executors, inputModalities: ['image'] } }),
    /nothing here can do this request/,
  )
})

test('Jev reading a request as needing a person stops the run instead of guessing', async () => {
  const dir = repo()
  let ran = false
  const jev = { route: async () => routeResult({ capability: 'human_required', capabilityConfidence: 0.9 }), assess: async () => verdict('accept') }
  const r = await runRouted({
    task: 'delete the production database', cwd: dir, config, signal,
    deps: { jev, execute: async () => { ran = true; return { stopReason: 'completed', answerText: 'did it' } }, history: history() },
  })
  assert.equal(ran, false, 'no agent runs when the request needs a person')
  assert.equal(r.finalStatus, 'needs_human')
  assert.equal(r.attempts.length, 0, 'nothing was attempted')
  assert.match(formatReport(r), /NEEDS HUMAN/)
  assert.match(formatReport(r), /needing a person/)
})

test('an unsure "needs a person" does not stall ordinary work', async () => {
  const dir = repo()
  const jev = { route: async () => routeResult({ capability: 'human_required', capabilityConfidence: 0.2 }), assess: async () => verdict('accept') }
  const r = await runRouted({ task: 'fix the parser', cwd: dir, config, signal, deps: { jev, execute: fixer(dir), history: history() } })
  assert.equal(r.finalStatus, 'accepted', 'below the threshold the work still happens')
  assert.equal(r.attempts.length, 1)
})

test('a forced agent is never overruled by the capability question', async () => {
  const dir = repo()
  let ran = false
  const jev = { route: async () => routeResult({ capability: 'human_required', capabilityConfidence: 0.99 }), assess: async () => verdict('accept') }
  const r = await runRouted({
    task: 'do it anyway', cwd: dir, config, signal, forceAgent: 'claude',
    deps: { jev, execute: async (a) => { ran = a.id === 'claude'; writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'done' } }, history: history() },
  })
  assert.equal(ran, true, 'picking an agent by hand still runs it')
  assert.equal(r.finalStatus, 'accepted')
})

test('"other" is an escape hatch, not an empty field', async () => {
  // Choice is relative, so something always wins; without this option an uncategorised request
  // would be forced into the nearest wrong capability - or refused for naming nothing.
  const dir = repo()
  const jev = { route: async () => routeResult({ capability: 'other', capabilityConfidence: 0.9 }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  const r = await runRouted({ task: 'something odd', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: fixer(dir), history: history(), executors } })
  assert.equal(r.finalStatus, 'accepted', 'an uncategorised request still runs')
  assert.equal(r.attempts.length, 1)
})

test('a look-up is never handed to an agent with no network', async () => {
  const dir = repo()
  const localConfig = { ...config, agents: [{ id: 'gemma-local', provider: 'x', kind: 'local', description: 'on this PC', enabled: true }] }
  let ran = false
  const jev = {
    route: async () => routeResult({ primaryAgent: 'gemma-local', agentProbabilities: { 'gemma-local': 0.9 }, capability: 'web_research', capabilityConfidence: 0.9 }),
    assess: async () => verdict('accept'),
  }
  const executors = executorsFrom({ agents: localConfig.agents })
  await assert.rejects(
    runRouted({ task: 'what is the latest release?', cwd: dir, config: localConfig, signal, deps: { jev, execute: async () => { ran = true }, history: history(), executors } }),
    /nothing here can do this request as "web_research"/,
  )
  assert.equal(ran, false, 'and nothing was run anyway')
})
test('an answer-shaped capability never refuses the run', async () => {
  // Every agent can answer, so naming an answer capability must not stop the work: the adapter
  // normally answers questions itself, and a request that reaches the router is better served by
  // an agent than by an error nobody can act on.
  const dir = repo()
  const jev = { route: async () => routeResult({ capability: 'quick_answer', capabilityConfidence: 0.95 }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  const r = await runRouted({ task: 'what does this project do?', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: fixer(dir), history: history(), executors } })
  assert.equal(r.finalStatus, 'accepted')
  assert.equal(r.attempts.length, 1)
})

// Every earlier capability test passed no deps.executors, which disables the post-Jev guard -
// and that is exactly how a real regression got through: with a registry wired, `human_required`
// was refused by the capability filter before the "stop and ask" handler could run.
test('a person-needed answer stops and asks when a registry is wired', async () => {
  const dir = repo()
  let ran = false
  const jev = { route: async () => routeResult({ capability: 'human_required', capabilityConfidence: 0.95 }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  const r = await runRouted({
    task: 'delete the production database', cwd: dir, config: CAP_CONFIG, signal,
    deps: { jev, execute: async () => { ran = true; return { stopReason: 'completed', answerText: 'did it' } }, history: history(), executors },
  })
  assert.equal(ran, false, 'nothing runs')
  assert.equal(r.finalStatus, 'needs_human', 'and it is not refused: no executor can declare human_required')
  assert.match(formatReport(r), /NEEDS HUMAN/)
})

test('a hand-picked agent still runs with a registry wired', async () => {
  const dir = repo()
  const used = []
  const jev = { route: async () => routeResult({ capability: 'web_research', capabilityConfidence: 0.99 }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  const r = await runRouted({
    task: 'do it anyway', cwd: dir, config: CAP_CONFIG, signal, forceAgent: 'claude',
    deps: { jev, execute: async (a) => { used.push(a.id); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'done' } }, history: history(), executors },
  })
  assert.deepEqual(used, ['claude'], 'picking by hand is never overruled, even by a capability nothing here has')
  assert.equal(r.finalStatus, 'accepted')
})

test('"other" still runs with a registry wired', async () => {
  const dir = repo()
  const jev = { route: async () => routeResult({ capability: 'other', capabilityConfidence: 0.9 }), assess: async () => verdict('accept') }
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })
  const r = await runRouted({ task: 'something odd', cwd: dir, config: CAP_CONFIG, signal, deps: { jev, execute: fixer(dir), history: history(), executors } })
  assert.equal(r.finalStatus, 'accepted')
})

test('offline routing never consults the capability filter', async () => {
  // Offline picks an agent by fixed rule without asking Jev, so there is no capability answer to
  // enforce - and enforcing one would demand a network-capable executor on a machine with none.
  const dir = repo()
  const localConfig = { ...config, agents: [{ id: 'gemma-local', provider: 'x', kind: 'local', description: 'on this PC', enabled: true }] }
  const r = await runRouted({
    task: 'fix the parser', cwd: dir, config: localConfig, signal,
    deps: { jev: null, offline: true, jevUnavailableReason: 'offline', execute: fixer(dir), history: history(), executors: executorsFrom({ agents: localConfig.agents }) },
  })
  assert.equal(r.routing.mode, 'offline')
  assert.equal(r.finalStatus, 'accepted')
})
test('with Jev down, the fallback still picks something that can do the job', async () => {
  // The error path must not bypass capability: the configured fallback is a preference, and with
  // an image attached a text-only fallback would be handed work it cannot read.
  const dir = repo()
  const used = []
  const executors = executorsFrom({ agents: CAP_CONFIG.agents, seesImages: (id) => id === 'deepseek' })
  const r = await runRouted({
    task: 'read this receipt', cwd: dir, config: { ...CAP_CONFIG, fallbackAgent: 'claude' }, signal,
    deps: {
      jev: null, jevUnavailableReason: 'no key', inputModalities: ['image'], executors,
      execute: async (a) => { used.push(a.id); writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'read it' } },
      history: history(),
    },
  })
  assert.equal(r.routing.mode, 'fallback')
  assert.deepEqual(used, ['deepseek'], 'the agent that can read the image, not the configured default')
  assert.equal(r.routing.capabilityFrom, 'claude', 'and the run says the default was passed over')
})

test('with Jev down and nothing able to do the job, it says so', async () => {
  const dir = repo()
  const executors = executorsFrom({ agents: CAP_CONFIG.agents })   // neither reads images
  await assert.rejects(
    runRouted({
      task: 'read this receipt', cwd: dir, config: CAP_CONFIG, signal,
      deps: { jev: null, jevUnavailableReason: 'no key', inputModalities: ['image'], executors, execute: noop, history: history() },
    }),
    /nothing here can do this request/,
  )
})

// ---------- Like/Dislike feedback as a routing signal ----------
// The rows are fixtures; the join is provider -> agent, because the engine's message id never
// reaches the server and `messageId` only dedupes a changed verdict on read.
const FB_CONFIG = { ...config, agents: [
  { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
  { id: 'codex', provider: 'codex', description: 'b', enabled: true },
] }
const fbRow = (over = {}) => ({ ts: '2026-09-21T00:00:00.000Z', sessionId: 's', messageId: 'm1', verdict: 'dislike', reason: '', provider: 'codex', ...over })
const fbHistory = (rows) => ({ rows: [], recent: async () => [], records: async () => [], feedback: async () => rows, append: async () => {} })
const closeRoute = (over = {}) => routeResult({ primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { codex: 0.55, claude: 0.45 }, ...over })

test('routing: a disliked agent is demoted when the picks are close', async () => {
  const dir = repo()
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const rows = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}` }))
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory(rows) } })
  assert.equal(r.attempts[0].agent, 'claude', 'three dislikes cost codex the close call')
  assert.equal(r.routing.feedbackFrom, 'codex')
  assert.ok(r.routing.feedback.some((m) => m.agent === 'codex' && m.dislikes === 3), 'the demotion is recorded in the run')
})

test('routing: a single verdict does not swing a close call', async () => {
  const dir = repo()
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory([fbRow()]) } })
  assert.equal(r.attempts[0].agent, 'codex', 'one click is a nudge, not a ruling')
  assert.equal(r.routing.feedbackFrom, undefined)
})

test('routing: a liked agent is promoted when the picks are close', async () => {
  const dir = repo()
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const rows = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, verdict: 'like', provider: 'claude' }))
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory(rows) } })
  assert.equal(r.attempts[0].agent, 'claude', 'three likes raised claude over a close codex pick')
  assert.equal(r.routing.feedbackFrom, 'codex')
})

test('routing: suggestedAgent is the strongest signal and wins the pick', async () => {
  const dir = repo()
  const jev = { route: async () => routeResult({ primaryAgent: 'codex', agentConfidence: 0.9, agentProbabilities: { codex: 0.8, claude: 0.2 } }), assess: async () => verdict('accept') }
  const rows = [fbRow({ reason: 'should have been claude', suggestedAgent: 'claude' })]
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory(rows) } })
  assert.equal(r.attempts[0].agent, 'claude')
  assert.equal(r.routing.feedbackFrom, 'codex')
  assert.match(formatReport(r), /Feedback moved the pick off codex to claude/)
})

test('routing: the written reason rides the track record into the routing prompt', async () => {
  const dir = repo()
  let seen
  const jev = { route: async (args) => { seen = args.trackRecord; return closeRoute() }, assess: async () => verdict('accept') }
  const rows = [fbRow({ reason: 'the parser is architecture, Claude should have had it' })]
  await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory(rows) } })
  assert.equal(seen.codex.feedback.dislikes, 1)
  assert.deepEqual(seen.codex.feedback.recent_reasons, ['the parser is architecture, Claude should have had it'])
})

test('routing: no feedback, or no feedback reader at all, leaves the pick exactly as Jev made it', async () => {
  const dir = repo()
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const empty = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: fbHistory([]) } })
  assert.equal(empty.attempts[0].agent, 'codex')
  assert.equal(empty.routing.feedbackFrom, undefined)
  const noReader = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: history() } })
  assert.equal(noReader.attempts[0].agent, 'codex')
})

test('feedbackPrior: attributes by provider, drops unknown agents, and keeps only the newest suggestion', async () => {
  const { feedbackPrior } = await import('../router.js')
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }]
  const p = feedbackPrior([
    { verdict: 'dislike', reason: 'a', provider: 'codex' },
    { verdict: 'like', provider: 'ghost' },
    { verdict: 'dislike', reason: 'b', provider: 'codex', suggestedAgent: 'claude' },
  ], agents)
  assert.equal(p.agents.get('codex').dislikes, 2, 'both dislikes land on codex')
  assert.equal(p.agents.get('codex').likes, 0)
  assert.deepEqual(p.agents.get('codex').reasons, ['a', 'b'])
  assert.equal(p.agents.has('ghost'), false, 'a verdict naming no known agent is dropped, not guessed')
  assert.equal(p.agents.get('claude').suggested, 1)
  assert.equal(p.suggestion, 'claude')
})

test('feedbackPrior: an answer-only tag is context, never a vote', async () => {
  const { feedbackPrior } = await import('../router.js')
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }]
  // A routing tag counts, exactly as an untagged row always has.
  const routing = feedbackPrior([{ verdict: 'dislike', provider: 'codex', tag: 'wrong agent', reason: 'a' }], agents)
  assert.equal(routing.agents.get('codex').dislikes, 1)
  assert.ok(routing.agents.get('codex').bias < 0, 'a routing dislike moves the bias')
  // An answer-only tag does not, in either direction, while its words still reach the prompt.
  const answer = feedbackPrior([{ verdict: 'dislike', provider: 'codex', tag: 'not enough detail', reason: 'a' }], agents)
  assert.equal(answer.agents.get('codex').likes, 0)
  assert.equal(answer.agents.get('codex').dislikes, 0, 'the vote is not counted')
  assert.equal(answer.agents.get('codex').bias, 0, 'so the bias cannot move')
  assert.deepEqual(answer.agents.get('codex').reasons, ['not enough detail: a'], 'words and tag still ride the track record')
  const liked = feedbackPrior([{ verdict: 'like', provider: 'codex', tag: 'good answer' }], agents)
  assert.equal(liked.agents.get('codex').likes, 0, 'an answer-only like cannot promote either')
  assert.equal(liked.agents.get('codex').bias, 0)
  // A suggestion is a promotion, so an answer-only row may not carry one either.
  assert.equal(feedbackPrior([{ verdict: 'dislike', provider: 'codex', tag: 'too slow', suggestedAgent: 'claude' }], agents).suggestion, undefined)
  // Untagged is unchanged: it still counts and can still suggest.
  assert.equal(feedbackPrior([{ verdict: 'dislike', provider: 'codex', suggestedAgent: 'claude' }], agents).suggestion, 'claude')
})

test('routing: an answer-only dislike cannot move the pick, a routing dislike does', async () => {
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  // The same three dislikes that demote codex when they are about the pick (see the test above).
  const dir1 = repo()
  const answerOnly = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, tag: 'not enough detail' }))
  const kept = await runRouted({ task: 'fix', cwd: dir1, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir1), history: fbHistory(answerOnly) } })
  assert.equal(kept.attempts[0].agent, 'codex', 'three answer-only dislikes leave the pick alone')
  assert.equal(kept.routing.feedbackFrom, undefined)
  const dir2 = repo()
  const routing = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, tag: 'wrong agent' }))
  const moved = await runRouted({ task: 'fix', cwd: dir2, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir2), history: fbHistory(routing) } })
  assert.equal(moved.attempts[0].agent, 'claude', 'the same three dislikes about the pick do demote codex')
  assert.equal(moved.routing.feedbackFrom, 'codex')
  // An answer-only dislike that names another agent cannot promote it either.
  const dir3 = repo()
  const suggest = [fbRow({ messageId: 'm1', tag: 'not enough detail', suggestedAgent: 'claude' })]
  const r3 = await runRouted({ task: 'fix', cwd: dir3, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir3), history: fbHistory(suggest) } })
  assert.equal(r3.attempts[0].agent, 'codex', 'the suggestion is ignored behind an answer-only tag')
})

// ---------- the feedback bias, matched by task type across sessions ----------
// The wiring apply() gives the router, made by the same factory (createHistoryDeps): a real
// history.jsonl holding the runs, the real feedback log beside it, whose reader returns every
// session when it is given none, and runOfVerdict to find the run each verdict is about, whose
// routing.taskType says what kind of work was judged. closeRoute routes debugging work.
async function typedHistory(verdicts, runs, capabilities = null) {
  const { createFeedback } = await import('../feedback.js')
  const { createHistoryDeps } = await import('../index.js')
  const dir = mkdtempSync(join(tmpdir(), 'jev-fb-'))
  const historyFile = join(dir, 'history.jsonl')
  writeFileSync(historyFile, runs.map((r) => `${JSON.stringify(r)}\n`).join(''))
  const fb = createFeedback({ file: join(dir, 'feedback.jsonl') })
  for (const v of verdicts) await fb.append(v)
  return createHistoryDeps({ historyFile, feedback: fb, capabilities })
}
const typedRun = (runId, sessionId, taskType) => ({ ts: '2026-09-20T00:00:00.000Z', runId, sessionId, routing: { taskType, primaryAgent: 'claude' } })
const r2 = (x) => Math.round(x * 100) / 100
// The movement the prior applied to one agent's probability, or 0 when it applied none.
const nudge = (r, id) => { const m = r.routing.feedback?.find((x) => x.agent === id && 'to' in x); return m ? m.to - m.from : 0 }

test('feedback prior: a like on work of the same type moves the pick more than one on another type', async () => {
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const runs = [typedRun('r-debug', 's', 'debugging'), typedRun('r-docs', 's', 'documentation')]
  const likes = (runId) => [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, verdict: 'like', provider: 'claude', runId }))
  const dir1 = repo()
  const same = await runRouted({ task: 'fix', cwd: dir1, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir1), history: await typedHistory(likes('r-debug'), runs) } })
  const dir2 = repo()
  const other = await runRouted({ task: 'fix', cwd: dir2, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir2), history: await typedHistory(likes('r-docs'), runs) } })
  assert.equal(same.attempts[0].agent, 'claude', 'three likes on debugging work raise claude over a close debugging pick')
  assert.equal(other.attempts[0].agent, 'codex', 'three likes on documentation work do not')
  assert.ok(nudge(same, 'claude') > nudge(other, 'claude'), `same type ${nudge(same, 'claude')} against another type ${nudge(other, 'claude')}`)
  assert.ok(nudge(other, 'claude') > 0, 'a verdict on other work still counts, a little')
})

test('feedback prior: verdicts from another session now count, and their words stay out of this routing call', async () => {
  let seen
  const jev = { route: async (args) => { seen = args.trackRecord; return closeRoute() }, assess: async () => verdict('accept') }
  const runs = [typedRun('r-past', 'past', 'debugging')]
  const past = [1, 2, 3].map((i) => fbRow({ sessionId: 'past', messageId: `m${i}`, runId: 'r-past', reason: 'codex looped on the stack trace' }))
  const dir = repo()
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: await typedHistory(past, runs) } })
  assert.equal(r.attempts[0].agent, 'claude', 'three dislikes on debugging work in an earlier session cost codex this debugging call')
  assert.equal(r.routing.feedbackFrom, 'codex')
  // The typed reasons ride the routing call exactly as before: this session's only.
  assert.equal(seen.codex.feedback, undefined, 'another session\'s reason did not ride this session\'s routing call')
})

test('feedback prior: a verdict with no runId is weighed by the run it was credited to, as its evidence was', async () => {
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  // An earlier session's debugging run, then a documentation run, both ended before the verdicts.
  const runs = [{ ...typedRun('r-debug', 'past', 'debugging'), ts: '2026-09-20T10:00:00.000Z' }, { ...typedRun('r-docs', 'past', 'documentation'), ts: '2026-09-20T10:10:00.000Z' }]
  const past = [1, 2, 3].map((i) => fbRow({ ts: '2026-09-20T10:15:00.000Z', sessionId: 'past', messageId: `m${i}` }))
  // The registry credited them to the debugging run (creditedRun), whatever ended since.
  const credited = { creditedRun: (v) => (v.sessionId === 'past' ? 'r-debug' : null) }
  const dir1 = repo()
  const r = await runRouted({ task: 'fix', cwd: dir1, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir1), history: await typedHistory(past, runs, credited) } })
  assert.equal(r2(nudge(r, 'codex')), -0.15, 'three dislikes on debugging work, at full weight')
  assert.equal(r.attempts[0].agent, 'claude')
  const dir2 = repo()
  const guessed = await runRouted({ task: 'fix', cwd: dir2, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir2), history: await typedHistory(past, runs) } })
  assert.equal(r2(nudge(guessed, 'codex')), -0.04, 'with no credit to go by, the newest run before them is the documentation one')
})

test('feedback prior: an edited verdict with no runId is placed by when it was first given, as its evidence is', async () => {
  const { effectiveVerdicts, runOfVerdict } = await import('../index.js')
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const runs = [{ ...typedRun('r-debug', 'past', 'debugging'), ts: '2026-09-20T10:00:00.000Z' }, { ...typedRun('r-docs', 'past', 'documentation'), ts: '2026-09-20T10:10:00.000Z' }]
  // Three answers of the debugging run disliked at 10:05, each re-tagged at 10:15, after the
  // documentation run ended, and never credited (learning was off).
  const past = [1, 2, 3].flatMap((i) => [
    fbRow({ ts: '2026-09-20T10:05:00.000Z', sessionId: 'past', messageId: `m${i}` }),
    fbRow({ ts: '2026-09-20T10:15:00.000Z', sessionId: 'past', messageId: `m${i}`, tag: 'wrong agent' }),
  ])
  const typed = await typedHistory(past, runs)
  const evidence = runOfVerdict(effectiveVerdicts(past)[0], runs, null)
  assert.equal(evidence?.runId, 'r-debug', 'the evidence path reads the debugging run')
  assert.equal(typed.runOfVerdict((await typed.feedback())[0], runs)?.runId, evidence.runId, 'and the router reads the same one')
  const dir = repo()
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: typed } })
  assert.equal(r2(nudge(r, 'codex')), -0.15, 'so the dislikes count as debugging work, fully')
  assert.equal(r.attempts[0].agent, 'claude')
})

test('feedback prior: a suggested agent switches the pick only from this session, never from another', async () => {
  const jev = { route: async () => routeResult({ primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { codex: 0.8, claude: 0.2 } }), assess: async () => verdict('accept') }
  const runs = [typedRun('r-past', 'past', 'debugging'), typedRun('r-here', 's', 'debugging')]
  const should = (sessionId, runId) => fbRow({ sessionId, messageId: 'm1', runId, reason: 'should have been claude', suggestedAgent: 'claude' })
  const dir1 = repo()
  const elsewhere = await runRouted({ task: 'fix', cwd: dir1, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir1), history: await typedHistory([should('past', 'r-past')], runs) } })
  assert.equal(elsewhere.attempts[0].agent, 'codex', 'another session\'s newest correction does not switch this pick')
  assert.equal(elsewhere.routing.feedback?.some((m) => m.suggested), false, 'and is not recorded as a suggestion')
  assert.ok(nudge(elsewhere, 'codex') < 0, 'its dislike still counts as a vote on debugging work')
  const dir2 = repo()
  const here = await runRouted({ task: 'fix', cwd: dir2, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir2), history: await typedHistory([should('s', 'r-here')], runs) } })
  assert.equal(here.attempts[0].agent, 'claude', 'the same correction in this session does')
  assert.ok(here.routing.feedback.some((m) => m.agent === 'claude' && m.suggested))
})

test('feedback prior: no number of matching verdicts moves a probability past the cap', async () => {
  const jev = { route: async () => routeResult({ primaryAgent: 'codex', agentConfidence: 0.8, agentProbabilities: { codex: 0.8, claude: 0.2 } }), assess: async () => verdict('accept') }
  const runs = ['a', 'b', 'c'].map((s) => typedRun(`r-${s}`, s, 'debugging'))
  const rows = []
  for (let i = 0; i < 30; i++) {
    const s = ['a', 'b', 'c'][i % 3]
    rows.push(fbRow({ sessionId: s, messageId: `like${i}`, verdict: 'like', provider: 'claude', runId: `r-${s}` }))
    rows.push(fbRow({ sessionId: s, messageId: `dislike${i}`, provider: 'codex', runId: `r-${s}` }))
  }
  const dir = repo()
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir), history: await typedHistory(rows, runs) } })
  assert.equal(r2(nudge(r, 'claude')), 0.15, 'claude is raised by exactly the cap')
  assert.equal(r2(nudge(r, 'codex')), -0.15, 'codex is lowered by exactly the cap')
  assert.equal(r.attempts[0].agent, 'codex', 'sixty matching verdicts still cannot overturn a confident pick')
})

test('feedback prior: a verdict with no run to match counts as it always did, fully in this session and not at all from another', async () => {
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  // A runId naming no run, and no runId with no run of its session to fall back on.
  const here = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, ...(i === 1 ? { runId: 'gone' } : {}) }))
  const dir1 = repo()
  const kept = await runRouted({ task: 'fix', cwd: dir1, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir1), history: await typedHistory(here, []) } })
  assert.equal(kept.attempts[0].agent, 'claude', 'three dislikes in this session still demote codex, run or no run')
  const elsewhere = [1, 2, 3].map((i) => fbRow({ sessionId: 'past', messageId: `m${i}` }))
  const dir2 = repo()
  const ignored = await runRouted({ task: 'fix', cwd: dir2, sessionId: 's', config: FB_CONFIG, signal, deps: { jev, execute: fixer(dir2), history: await typedHistory(elsewhere, []) } })
  assert.equal(ignored.attempts[0].agent, 'codex', 'another session\'s verdicts about no known work say nothing about this one')
  assert.equal(ignored.routing.feedback, undefined)
})

test('feedbackPrior: a weighted vote moves the bias by its weight, and the cap holds at any weight', async () => {
  const { feedbackPrior, verdictWeight } = await import('../router.js')
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }]
  const runs = new Map([['r-debug', { routing: { taskType: 'debugging' } }], ['r-docs', { routing: { taskType: 'documentation' } }], ['r-manual', { routing: {} }]])
  const weightOf = verdictWeight({ taskType: 'debugging', sessionId: 's', runOf: (v) => runs.get(v.runId) ?? null })
  assert.equal(weightOf({ sessionId: 'x', runId: 'r-debug' }), 1, 'the same type counts fully, from any session')
  assert.equal(weightOf({ sessionId: 's', runId: 'r-docs' }), 0.25, 'another type counts a little, even in this session')
  assert.equal(weightOf({ sessionId: 's', runId: 'r-manual' }), 1, 'a run that never had a type is no match: this session counts as before')
  assert.equal(weightOf({ sessionId: 'x', runId: 'r-none' }), 0, 'and another session is not read, as before')
  assert.equal(verdictWeight({ sessionId: 's', runOf: (v) => runs.get(v.runId) })({ sessionId: 's', runId: 'r-docs' }), 1, 'no task type now: exactly the old prior')
  const throwing = verdictWeight({ taskType: 'debugging', sessionId: 's', runOf: () => { throw new Error('history unreadable') } })
  assert.deepEqual([throwing({ sessionId: 's' }), throwing({ sessionId: 'x' })], [1, 0], 'a reader that throws has found no run: the old prior, and nothing escapes')
  assert.equal(verdictWeight({})({ sessionId: 'x' }), 1, 'no session: every row reads as this session\'s, as list() with no session returns them')
  const like = (runId) => ({ sessionId: 's', verdict: 'like', provider: 'claude', runId })
  assert.equal(feedbackPrior([like('r-debug')], agents, { weightOf }).agents.get('claude').bias, 0.05)
  assert.equal(feedbackPrior([like('r-docs')], agents, { weightOf }).agents.get('claude').bias, 0.01)
  assert.equal(feedbackPrior(Array.from({ length: 50 }, () => like('r-debug')), agents, { weightOf }).agents.get('claude').bias, 0.15)
  assert.equal(feedbackPrior(Array.from({ length: 50 }, () => like('r-docs')), agents, { weightOf }).agents.get('claude').bias, 0.15, 'many small votes reach the cap and stop there')
  assert.equal(feedbackPrior([like('r-debug')], agents).agents.get('claude').bias, 0.05, 'no weights: every vote counts fully, as before')
})

test('feedbackPrior: the window holds twenty verdicts\' worth of weight, so votes on other work cannot crowd out ones on this work', async () => {
  const { feedbackPrior, verdictWeight } = await import('../router.js')
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }, { id: 'deepseek', provider: 'deepseek' }]
  const runs = new Map([['r-here', { routing: { taskType: 'debugging' } }], ['r-docs', { routing: { taskType: 'documentation' } }]])
  const weightOf = verdictWeight({ taskType: 'debugging', sessionId: 's', runOf: (v) => runs.get(v.runId) ?? null })
  // This session's three dislikes of codex on debugging work, then twenty newer verdicts on
  // documentation work from another session, a quarter each.
  const here = [1, 2, 3].map((i) => ({ sessionId: 's', messageId: `h${i}`, verdict: 'dislike', provider: 'codex', runId: 'r-here' }))
  const docs = (provider) => Array.from({ length: 20 }, (_, i) => ({ sessionId: 'other', messageId: `o${i}`, verdict: 'like', provider, runId: 'r-docs' }))
  const crowded = feedbackPrior([...here, ...docs('deepseek')], agents, { weightOf })
  assert.deepEqual([crowded.agents.get('codex')?.dislikes, crowded.agents.get('codex')?.bias], [3, -0.15], 'the dislikes on this work still count in full')
  assert.equal(crowded.agents.get('deepseek').likes, 20, 'and the twenty on other work are read as well')
  const outvoted = feedbackPrior([...here, ...docs('codex')], agents, { weightOf }).agents.get('codex')
  assert.deepEqual([outvoted.likes, outvoted.dislikes], [20, 3], 'every verdict is read')
  assert.equal(outvoted.bias, 0.04, 'twenty likes on other work weigh five, against three dislikes on this work')
  // Rows at full weight fill the window exactly as before: twenty of them, the newest.
  const full = Array.from({ length: 25 }, (_, i) => ({ sessionId: 's', messageId: `f${i}`, verdict: i < 5 ? 'like' : 'dislike', provider: 'codex', runId: 'r-here' }))
  assert.deepEqual([feedbackPrior(full, agents, { weightOf }).agents.get('codex').likes, feedbackPrior(full, agents).agents.get('codex').dislikes], [0, 20])
})

test('feedbackPrior: a verdict that weighs nothing is not in the window at all, nor the newest verdict', async () => {
  const { feedbackPrior, verdictWeight } = await import('../router.js')
  const agents = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }, { id: 'deepseek', provider: 'deepseek' }]
  const runs = new Map([['r-here', { routing: { taskType: 'debugging' } }]])
  const weightOf = verdictWeight({ taskType: 'debugging', sessionId: 's', runOf: (v) => runs.get(v.runId) ?? null })
  const here = [1, 2, 3].map((i) => ({ sessionId: 's', messageId: `h${i}`, verdict: 'dislike', provider: 'codex', runId: 'r-here' }))
  // Twenty newer dislikes from another session about no run anyone knows, each naming deepseek.
  const unplaced = Array.from({ length: 20 }, (_, i) => ({ sessionId: 'other', messageId: `o${i}`, verdict: 'dislike', provider: 'claude', suggestedAgent: 'deepseek' }))
  assert.equal(weightOf(unplaced[0]), 0)
  const p = feedbackPrior([...here, ...unplaced], agents, { weightOf })
  assert.deepEqual([p.agents.get('codex')?.dislikes, p.agents.get('codex')?.bias], [3, -0.15], 'they crowd nothing out')
  assert.equal(p.agents.has('claude'), false, 'they are not counted, even as whole verdicts')
  assert.equal(p.agents.has('deepseek'), false, 'nor their suggestions')
  assert.equal(p.suggestion, undefined, 'and the newest of them is not the newest verdict')
})

test('routing: twenty newer verdicts on other work from another session do not erase this session\'s on this work', async () => {
  const jev = { route: async () => closeRoute(), assess: async () => verdict('accept') }
  const cfg = { ...FB_CONFIG, agents: [...FB_CONFIG.agents, { id: 'deepseek', provider: 'deepseek', description: 'c', enabled: true }] }
  const runs = [typedRun('r-here', 's', 'debugging'), typedRun('r-docs', 'other', 'documentation')]
  const here = [1, 2, 3].map((i) => fbRow({ ts: '2026-09-21T00:00:00.000Z', messageId: `h${i}`, runId: 'r-here' }))
  const docs = Array.from({ length: 20 }, (_, i) => fbRow({ ts: '2026-09-22T00:00:00.000Z', sessionId: 'other', messageId: `o${i}`, verdict: 'like', provider: 'deepseek', runId: 'r-docs' }))
  const dir = repo()
  const r = await runRouted({ task: 'fix', cwd: dir, sessionId: 's', config: cfg, signal, deps: { jev, execute: fixer(dir), history: await typedHistory([...here, ...docs], runs) } })
  assert.equal(r2(nudge(r, 'codex')), -0.15, 'codex keeps the full demotion from three dislikes on debugging work')
  assert.equal(r.attempts[0].agent, 'claude', 'so it still loses the close debugging call')
})

// ---------- hard facts, marginal cost, and the strategy's own steps ----------
// Regressions for six defects: a provider NAME deciding a routing swap, admin exclusions that
// only decision.js honoured, a filtered-out field swallowed into a fallback, a tool offered to
// Jev that could not run, a second opinion that replaced the answer instead of being compared
// with it, and a strategy's executor overwritten before it ever ran.

const ADAPTIVE_AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'a subscription the code knows by name', enabled: true },
  { id: 'deepseek', provider: 'spawn', description: 'a metered key', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'acme', provider: 'acme-subscription', description: 'a subscription this code has never heard of', enabled: true },
  { id: 'qwen-local', kind: 'local', provider: 'spawn', description: 'a model on this PC', enabled: true },
]
const adaptiveConfig = (extra = {}) => ({
  agents: ADAPTIVE_AGENTS,
  tools: [],
  fallbackAgent: 'claude',
  limits: { maxAttempts: 4, maxReviews: 2, maxRounds: 6 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  productionWorkspaces: [],
  agentTimeoutMs: 20_000,
  checks: {},
  effort: {},
  ...extra,
})
const accept = async () => ({ status: 'accepted', action: 'accept', quality: 0.9 })
const quiet = { recent: async () => [], records: async () => [], append: async () => {} }
const pick = (primaryAgent, agentConfidence, agentProbabilities, over = {}) => ({
  primaryAgent, agentConfidence, agentProbabilities,
  taskType: 'implementation', complexity: 0.3, risk: 0.3, needsSecondOpinion: 0.1, needsHumanReview: 0.1, needsTests: 0.1, ...over,
})
/** One run with the review forced to accept, recording which agents were actually executed. */
async function adaptiveRun({ config: cfg = adaptiveConfig(), deps = {}, task = 'do a thing', answerOnly = false, answers = {} } = {}) {
  const dir = repo()
  const seen = []
  const r = await runRouted({
    task, cwd: dir, config: cfg, answerOnly, signal,
    deps: {
      review: accept,
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: answers[a.id] ?? 'done', diagnostic: null } },
      history: quiet,
      ...deps,
    },
  })
  return { r, seen }
}

test('the indifference tie-break follows marginal cost, so a subscription this code never heard of wins it', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const jev = { route: async () => pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34, 'qwen-local': 0.3 }), assess: async () => ({}) }
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { jev } })
  assert.equal(r.routing.primaryAgent, 'acme', 'the swap is about what a job costs at the margin, not who the provider is')
  assert.equal(r.routing.tiebrokeFrom, 'deepseek')
  assert.equal(seen[0], 'acme')
})

test('a resource declared metered is not the tie-break answer, whatever its provider is called', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { claude: { marginalCost: 'metered' } } } })
  const jev = { route: async () => pick('deepseek', 0.3, { deepseek: 0.36, claude: 0.34 }), assess: async () => ({}) }
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { jev } })
  assert.equal(r.routing.tiebrokeFrom, undefined, 'nothing tied is cheap at the margin, so nothing moves')
  assert.equal(seen[0], 'deepseek')
})

test('the run\'s own decision snapshot says what a job costs before any default does', async () => {
  const decide = async () => ({
    routing: { ...pick('deepseek', 0.3, { deepseek: 0.36, claude: 0.34 }), decision: { candidates: [{ id: 'deepseek', marginalCost: 'low' }, { id: 'claude', marginalCost: 'metered' }] } },
    plan: null,
  })
  const { r, seen } = await adaptiveRun({ deps: { decide } })
  assert.equal(r.routing.tiebrokeFrom, undefined, 'the pick is already the low-marginal-cost one')
  assert.equal(seen[0], 'deepseek')
})

test('an admin-disabled resource is out of the pool, so no later swap can hand it the work', async () => {
  let offered = null
  const cfg = adaptiveConfig({ routing: { disabledResources: ['claude'] } })
  const jev = { route: async ({ agents }) => { offered = agents.map((a) => a.id); return pick('deepseek', 0.3, { deepseek: 0.36, claude: 0.34 }) }, assess: async () => ({}) }
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { jev } })
  assert.ok(!offered.includes('claude'), 'never offered')
  assert.equal(r.routing.tiebrokeFrom, undefined, 'the tie-break cannot resurrect it either')
  assert.ok(!seen.includes('claude'), `claude took the work anyway: ${seen.join(', ')}`)
})

test('an allow-list is a hard fact: a pick outside it is replaced, not honoured', async () => {
  const cfg = adaptiveConfig({ routing: { allowedResources: ['deepseek'] } })
  const jev = { route: async () => pick('claude', 0.9, { claude: 0.9 }), assess: async () => ({}) }
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { jev } })
  assert.equal(r.routing.primaryAgent, 'deepseek')
  assert.deepEqual(seen, ['deepseek'])
})

test('excluding every resource stops the run, and a manual pick cannot reach an excluded one', async () => {
  const dir = repo()
  const all = adaptiveConfig({ routing: { disabledResources: ['claude', 'deepseek', 'acme', 'qwen-local'] } })
  await assert.rejects(
    runRouted({ task: 'fix', cwd: dir, config: all, signal, deps: { jev: null, execute: noop, history: history() } }),
    /excluded by the routing policy/,
  )
  const one = adaptiveConfig({ routing: { disabledResources: ['claude'] } })
  await assert.rejects(
    runRouted({ task: 'fix', cwd: dir, config: one, forceAgent: 'claude', signal, deps: { jev: null, execute: noop, history: history() } }),
    /claude is excluded by the routing policy \(disabled by configuration\)/,
  )
})

test('every candidate filtered out stops the run instead of routing to an excluded resource', async () => {
  // Both of the engine's refusals, including the context-window one whose wording the first
  // version of this stop did not match: the router keys on the code, not on the message.
  const refusals = [
    'no resource is available: claude (disabled by configuration), deepseek (not in the allowed resources)',
    'no resource can take this request: claude (context window 8192 tokens is under the 17600 this request needs)',
  ]
  for (const message of refusals) {
    const dir = repo()
    const seen = []
    await assert.rejects(
      runRouted({
        task: 'fix', cwd: dir, config: adaptiveConfig(), signal,
        deps: {
          decide: async () => { throw Object.assign(new Error(message), { code: NO_CANDIDATES, excluded: [] }) },
          execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done' } },
          review: accept, history: quiet,
        },
      }),
      (err) => err.message === message,
    )
    assert.deepEqual(seen, [], `nothing ran for "${message.split(':')[0]}"; the refusal was not swallowed into a fallback`)
  }
})

test('an engine that merely crashed still falls back: only a filtered-out field stops the run', async () => {
  const jev = { route: async () => pick('claude', 0.9, { claude: 0.9 }), assess: async () => ({}) }
  const { r, seen } = await adaptiveRun({ deps: { decide: async () => { throw new Error('ECONNRESET') }, jev } })
  assert.equal(r.routing.mode, 'fallback')
  assert.deepEqual(seen, ['claude'])
})

test('a tool that cannot take the attached input is never offered to Jev', async () => {
  const dir = repo()
  const agents = [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'deepseek', provider: 'spawn', description: 'b', enabled: true },
  ]
  const cfg = { ...adaptiveConfig(), agents, tools }
  const executors = executorsFrom({ agents, tools, seesImages: (id) => id === 'claude' })
  const offered = []
  const jev = { route: async (args) => { offered.push(args.tools.map((t) => t.id)); return pick('claude', 0.9, { claude: 0.9 }) }, assess: async () => ({}) }
  await runRouted({
    task: 'read the receipt', cwd: dir, config: cfg, signal,
    deps: { jev, review: accept, execute: noop, history: quiet, executors, inputModalities: ['image'] },
  })
  assert.deepEqual(offered[0], [], 'the text-only script is dropped before judgment, not after it')
})

test('a tool this run can actually use is still offered', async () => {
  const dir = repo()
  const agents = [{ id: 'claude', provider: 'claude-code', description: 'a', enabled: true }]
  const cfg = { ...adaptiveConfig(), agents, tools }
  const executors = executorsFrom({ agents, tools })
  const offered = []
  const jev = { route: async (args) => { offered.push(args.tools.map((t) => t.id)); return pick('claude', 0.9, { claude: 0.9 }) }, assess: async () => ({}) }
  await runRouted({
    task: 'what is the weather', cwd: dir, config: cfg, signal,
    deps: { jev, review: accept, execute: noop, history: quiet, executors, inputModalities: ['text'] },
  })
  assert.deepEqual(offered[0], ['weather'])
})

const parallelPlan = (over = {}) => ({ strategy: 'PARALLEL_SECOND_OPINION', steps: [{ role: 'primary', agent: 'deepseek' }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: 'claude', fallbackOrder: [], notes: [], ...over })
const parallelDecide = async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), strategy: 'PARALLEL_SECOND_OPINION' }, plan: parallelPlan() })

test('a parallel second opinion is compared, and the answer shown is the primary\'s', async () => {
  const answers = {
    deepseek: 'The primary says the cache is warmed on boot by the loader',
    claude: 'Totally unrelated: rabbits enjoy carrots throughout winter',
  }
  const { r } = await adaptiveRun({ answerOnly: true, deps: { decide: parallelDecide }, answers })
  assert.equal(r.finalStatus, 'answered')
  assert.equal(r.lastAnswer, answers.deepseek, 'the opinion was pushed last but it is not the answer')
  assert.match(r.lastAnswerBy, /^deepseek/)
  assert.equal(r.secondOpinion.agent, 'claude')
  assert.equal(r.secondOpinion.compared, true)
  assert.equal(r.secondOpinion.agree, false)
  const report = formatReport(r)
  assert.match(report, /Second opinion \(claude\)/)
  assert.match(report, /DIFFER/)
  assert.match(report, /rabbits enjoy carrots/, 'the disagreeing answer is shown, not silently dropped')
})

test('two answers that say the same thing are reported as agreeing', async () => {
  const answers = {
    deepseek: 'The cache is warmed on boot by the loader',
    claude: 'The cache is warmed on boot by the loader process',
  }
  const { r } = await adaptiveRun({ answerOnly: true, deps: { decide: parallelDecide }, answers })
  assert.equal(r.secondOpinion.agree, true)
  assert.ok(r.secondOpinion.similarity > 0.6)
  assert.match(formatReport(r), /the two answers agree/)
})

const localFirstPlan = (fallbackOrder = []) => ({ strategy: 'LOCAL_FIRST', steps: [{ role: 'primary', agent: 'qwen-local' }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: null, fallbackOrder, notes: [] })

test('a strategy that puts a different executor in the primary step is respected, not overwritten', async () => {
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['claude']) })
  const { r, seen } = await adaptiveRun({ deps: { decide } })
  assert.equal(seen[0], 'qwen-local', 'the local model went first, as LOCAL_FIRST said it would')
  assert.deepEqual(r.plan.steps, [{ role: 'primary', agent: 'qwen-local' }])
  assert.match(formatReport(r), /qwen-local does the work under this strategy/)
})

const directPlan = (agent, over = {}) => ({ strategy: 'STANDARD_DIRECT', steps: [{ role: 'primary', agent }], reviewer: null, forceReview: false, frontierReview: false, parallelWith: null, fallbackOrder: [], notes: [], ...over })

test('a primary step the router really did reassign still follows the swap', async () => {
  // claude is past its weekly gate, and the step names claude ITSELF, so the gate swap moves the
  // primary and the step must move with it rather than keep naming the resource just rejected.
  // (This used to name qwen-local in the step, which never tested the step following anything.)
  const decide = async () => ({ routing: pick('claude', 0.9, { deepseek: 0.9, 'qwen-local': 0.1 }), plan: directPlan('claude') })
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  const { r, seen } = await adaptiveRun({ deps: { decide, quota } })
  assert.equal(r.routing.gatedFrom, 'claude')
  assert.equal(r.routing.primaryAgent, 'deepseek')
  assert.equal(seen[0], 'deepseek', 'the step followed the reassignment')
  assert.deepEqual(r.plan.steps, [{ role: 'primary', agent: 'deepseek' }])
})

test('a step naming the agent the tie-break moved off follows the tie-break', async () => {
  // deepseek passes every hard check, so only "the step names the swapped-from agent" can move it.
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const decide = async () => ({ routing: pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34 }), plan: directPlan('deepseek') })
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { decide } })
  assert.equal(r.routing.tiebrokeFrom, 'deepseek')
  assert.equal(seen[0], 'acme', 'the step did not keep the agent the tie-break rejected')
})

test('every move the router makes is recorded with where it went, and the report says each one', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const decide = async () => ({ routing: pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34 }), plan: directPlan('deepseek') })
  const { r } = await adaptiveRun({ config: cfg, deps: { decide } })
  assert.deepEqual(r.routing.moves, [{ kind: 'tiebreak', from: 'deepseek', to: 'acme' }])
  // The tie-break was the one move the report never mentioned.
  assert.match(formatReport(r), /deepseek was barely ahead of acme, a near tie, and acme costs less at the margin: acme took the work/)
  // Two moves in one run: each names its own target, not the final primary twice.
  const twoHops = { ...r, routing: { ...r.routing, primaryAgent: 'claude', capability: 'web_research', moves: [{ kind: 'capability', from: 'qwen-local', to: 'acme' }, { kind: 'gate', from: 'acme', to: 'claude' }] } }
  const report = formatReport(twoHops)
  assert.match(report, /qwen-local cannot do this \(web_research\): acme took the work/)
  assert.match(report, /Work moved off acme \(past its weekly gate\) to claude/)
  // A record from before moves were kept still reads, from its fields.
  const legacy = { ...r, routing: { ...r.routing, moves: undefined, primaryAgent: 'claude', gatedFrom: 'acme', tiebrokeFrom: undefined } }
  assert.match(formatReport(legacy), /Work moved off acme \(past its weekly gate\) to claude/)
})

test('a swap of the resource BEHIND a LOCAL_FIRST step leaves the local model its step', async () => {
  // The gate moves the routed resource from claude to deepseek. That says nothing against the
  // local model, so LOCAL_FIRST still runs it first instead of going inert under its own label.
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { deepseek: 0.9, 'qwen-local': 0.1 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['claude', 'deepseek']) })
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  const { r, seen } = await adaptiveRun({ deps: { decide, quota } })
  assert.equal(r.routing.gatedFrom, 'claude')
  assert.equal(r.routing.primaryAgent, 'deepseek')
  assert.equal(seen[0], 'qwen-local', 'the local model still went first')
  assert.deepEqual(r.plan.steps, [{ role: 'primary', agent: 'qwen-local' }])
})

test('a kept strategy step must pass the capability Jev named, like the pick had to', async () => {
  // LOCAL_FIRST puts qwen-local first, but the request is web_research and a local model has no
  // network. Keeping the step because it is "enabled" ran exactly the mismatch routing forbids.
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), strategy: 'LOCAL_FIRST', capability: 'web_research' }, plan: localFirstPlan(['claude']) })
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS })
  const { r, seen } = await adaptiveRun({ deps: { decide, executors } })
  assert.ok(!seen.includes('qwen-local'), `a model with no network ran a look-up: ${seen.join(', ')}`)
  assert.equal(seen[0], 'claude')
  assert.deepEqual(r.plan.steps, [{ role: 'primary', agent: 'claude' }])
})

test('the strategy\'s fallback order is what takes over when its executor fails', async () => {
  const dir = repo()
  const seen = []
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['acme']) })
  const r = await runRouted({
    task: 'answer me', cwd: dir, config: adaptiveConfig(), answerOnly: true, signal,
    deps: {
      decide,
      execute: async (a) => {
        seen.push(a.id)
        return a.id === 'acme' ? { stopReason: 'completed', answerText: 'done' } : { stopReason: 'error', diagnostic: 'not available', answerText: '' }
      },
      review: accept, history: quiet,
    },
  })
  // LOCAL_FIRST promises "the local model goes first; the routed resource takes over on failure"
  // (broker.js writes exactly that note), so claude is the first hand-over, and the strategy's own
  // order decides after it - not the generic ranking. (This test once expected acme straight
  // after the local model, which is the promise broken.)
  assert.deepEqual(seen, ['qwen-local', 'claude', 'acme'], 'the hand-over kept the promise, then followed the strategy')
  assert.equal(r.finalStatus, 'answered')
})

// ---------- round three: exclusions in the capability path, hand-overs, conservation, skill ----------

test('a policy-excluded agent is not counted as able to do the request', async () => {
  // claude and deepseek could look this up, but the policy excludes both; the local model left
  // cannot. Signing them out stops the run, and excluding them must stop it the same way rather
  // than let the excluded agents fool the guard and run the job on the one that cannot do it.
  const dir = repo()
  const agents = [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'deepseek', provider: 'spawn', description: 'b', enabled: true },
    { id: 'qwen-local', kind: 'local', provider: 'spawn', description: 'c', enabled: true },
  ]
  const cfg = { ...adaptiveConfig(), agents, routing: { disabledResources: ['claude', 'deepseek'] } }
  let offered = null
  const ran = []
  const jev = {
    route: async ({ capabilities }) => { offered = capabilities; return pick('qwen-local', 0.9, { 'qwen-local': 0.9 }, { capability: 'web_research', capabilityConfidence: 0.9 }) },
    assess: async () => ({}),
  }
  await assert.rejects(
    runRouted({ task: 'what is the latest release?', cwd: dir, config: cfg, answerOnly: true, signal, deps: { jev, review: accept, execute: async (a) => { ran.push(a.id); return { stopReason: 'completed', answerText: 'x' } }, history: quiet, executors: executorsFrom({ agents }) } }),
    /nothing here can do this request as "web_research"/,
  )
  assert.deepEqual(ran, [], 'nothing ran anyway')
  assert.equal(offered.includes('web_research'), false, 'and only an excluded agent has it, so it was never offered')
})

test('the policy-exclusion stop names the policy only when the policy alone emptied the pool', async () => {
  const dir = repo()
  const agents = [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'deepseek', provider: 'spawn', description: 'b', enabled: true },
  ]
  const until = new Date(Date.now() + 3_600_000).toISOString()
  const cfg = { ...adaptiveConfig(), agents, routing: { disabledResources: ['claude'] } }
  await assert.rejects(
    runRouted({ task: 'fix', cwd: dir, config: cfg, signal, deps: { jev: null, quota: { deepseek: { state: 'exhausted', until } }, execute: noop, history: history() } }),
    (err) => /usage limits/.test(err.message) && /earliest reset/.test(err.message) && !/excluded by the routing policy/.test(err.message),
  )
})

/** A review that rejects the first work attempt with `first`, then accepts. */
const rejectOnce = (first) => {
  let n = 0
  return async () => (n++ === 0 ? { status: 'rejected', action: 'retry', why: 'wrong', ...first } : { status: 'accepted', action: 'accept', why: 'ok' })
}

test('Jev\'s retry ranking outranks a plain strategy\'s generic fallback order', async () => {
  // broker.js gives every plan a fallbackOrder; only a strategy that put someone else in the
  // primary step promised a hand-over, so here Jev's ranking for this failure decides.
  const decide = async () => ({ routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek', { fallbackOrder: ['acme', 'claude'] }) })
  const review = rejectOnce({ disposition: 'RETRY_DIFFERENT_RESOURCE', retryAgentProbabilities: { claude: 0.95, acme: 0.03, 'qwen-local': 0.02 } })
  const { seen } = await adaptiveRun({ deps: { decide, review } })
  assert.deepEqual(seen, ['deepseek', 'claude'])
})

test('with no retry ranking from Jev, the fallback order still decides', async () => {
  const decide = async () => ({ routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek', { fallbackOrder: ['acme', 'claude'] }) })
  const review = rejectOnce({ disposition: 'RETRY_DIFFERENT_RESOURCE' })
  const { seen } = await adaptiveRun({ deps: { decide, review } })
  assert.deepEqual(seen, ['deepseek', 'acme'])
})

test('a second review goes to the reviewer the plan named, whatever asked for it', async () => {
  // The plan promised acme's (frontier) review. The review asks for a second review on its own
  // account, the second-opinion judgment's yes, and ranks claude for it. The run counts as
  // reviewed after one review, so handing it to claude would mean acme never looked at the work.
  const decide = async () => ({ routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek', { reviewer: 'acme', forceReview: true, frontierReview: true }) })
  let n = 0
  const review = async () => (n++ === 0
    ? { action: 'second_review', why: 'routing asked for a second opinion', reviewAgentProbabilities: { claude: 0.95, acme: 0.05 } }
    : { status: 'accepted', action: 'accept', why: 'ok' })
  const { r, seen } = await adaptiveRun({ deps: { decide, review } })
  assert.deepEqual(seen, ['deepseek', 'acme'])
  assert.equal(r.finalStatus, 'accepted')
})

test('the review call is handed the model each CLI agent really runs, so it can mask it', async () => {
  let given = null
  const jev = { route: async () => pick('deepseek', 0.9, { deepseek: 0.9 }), assess: async (input) => { given = input.modelOf; return verdict('accept') } }
  const modelOf = (a) => (a?.id === 'claude' ? 'o3-pro' : undefined)
  await adaptiveRun({ deps: { jev, modelOf, review: undefined } })
  assert.equal(typeof given, 'function', 'the review call got no modelOf, so an agent that has not run yet keeps its model name')
  assert.equal(given({ id: 'claude' }), 'o3-pro')
})

test('a LOCAL_FIRST hand-over is kept even when Jev ranks someone else', async () => {
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['claude', 'acme']) })
  const review = rejectOnce({ disposition: 'WRONG', retryAgentProbabilities: { acme: 0.95, claude: 0.05 } })
  const { seen } = await adaptiveRun({ deps: { decide, review } })
  assert.deepEqual(seen, ['qwen-local', 'claude'], 'the strategy promised claude takes over')
})

test('a parallel opinion is not "already worked", so the fallback order may still hand over to it', async () => {
  const dir = repo()
  const seen = []
  const decide = async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), strategy: 'PARALLEL_SECOND_OPINION' }, plan: parallelPlan({ fallbackOrder: ['claude', 'acme'] }) })
  const r = await runRouted({
    task: 'answer me', cwd: dir, config: adaptiveConfig(), answerOnly: true, signal,
    deps: {
      decide, review: accept, history: quiet,
      execute: async (a) => { seen.push(a.id); return a.id === 'deepseek' ? { stopReason: 'error', diagnostic: 'boom', answerText: '' } : { stopReason: 'completed', answerText: `${a.id} says the cache warms on boot` } },
    },
  })
  assert.deepEqual(seen, ['deepseek', 'claude', 'claude'], 'claude only gave an opinion, so it takes over the work')
  assert.equal(r.finalStatus, 'answered')
})

test('the second-opinion line says whose answer is shown when it is not the primary\'s', async () => {
  // The primary came back empty and the opinion answered: its answer is shown, so saying
  // "the answer below is the primary's" was false.
  const { r } = await adaptiveRun({ answerOnly: true, deps: { decide: parallelDecide }, answers: { deepseek: '', claude: 'The cache is warmed on boot' } })
  assert.equal(r.lastAnswer, 'The cache is warmed on boot')
  const report = formatReport(r)
  assert.doesNotMatch(report, /The answer below is the primary's/)
  assert.match(report, /the answer below is the second opinion from claude/)
  assert.match(report, /nothing came back to compare/)
  // The primary failed and a retry answered: that retry is who the person is reading.
  const dir = repo()
  const failed = await runRouted({
    task: 'answer me', cwd: dir, config: adaptiveConfig(), answerOnly: true, signal,
    deps: {
      decide: async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), strategy: 'PARALLEL_SECOND_OPINION' }, plan: parallelPlan({ fallbackOrder: ['acme'] }) }),
      review: accept, history: quiet,
      execute: async (a) => (a.id === 'deepseek' ? { stopReason: 'error', diagnostic: 'boom', answerText: '' } : { stopReason: 'completed', answerText: `${a.id} answered` }),
    },
  })
  assert.equal(failed.lastAnswer, 'acme answered')
  const second = formatReport(failed)
  assert.doesNotMatch(second, /The answer below is the primary's/)
  assert.match(second, /The answer below is acme's \(retry\)/)
})

test('answers in any script, and short numeric answers, are compared rather than reported empty', async () => {
  const { compareAnswers } = await import('../router.js')
  assert.deepEqual(compareAnswers('42', '42'), { compared: true, similarity: 1, agree: true })
  assert.equal(compareAnswers('Кэш прогревается при загрузке', 'Кэш прогревается при загрузке сервера').agree, true)
  assert.equal(compareAnswers('Le cache est préchargé au démarrage', 'Le cache est préchargé au démarrage').agree, true)
  assert.equal(compareAnswers('缓存在启动时预热', '缓存在启动时预热').compared, true)
  // Nothing came back is one thing; two answers with nothing to measure is another.
  assert.equal(compareAnswers('', 'an answer').empty, true)
  // Two short answers with no word in common are compared, and differ.
  assert.deepEqual(compareAnswers('a b', 'c d'), { compared: true, similarity: 0, agree: false })
  // Only answers with no words at all are left uncompared.
  const odd = compareAnswers('...', '!!!')
  assert.equal(odd.compared, false)
  assert.equal(odd.empty, false)
  const report = formatReport({
    routing: { mode: 'manual', primaryAgent: 'deepseek' }, availability: { out: [], near: [] }, limits: [], baseline: [], assessments: [],
    attempts: [{ agent: 'deepseek', role: 'primary', stopReason: 'completed', durationMs: 1, changedFiles: [], answerExcerpt: '...' }, { agent: 'claude', role: 'opinion', stopReason: 'completed', durationMs: 1, changedFiles: [], answerExcerpt: '!!!' }],
    secondOpinion: { agent: 'claude', ...odd }, finalStatus: 'answered', statusReason: '', lastAnswer: '...',
  })
  assert.match(report, /could not be compared word for word/)
  assert.doesNotMatch(report, /nothing came back/)
})

test('the router\'s own swaps do not hand conserved work back to the resource it was kept off', async () => {
  // decision.js moved the work off claude to conserve it. Three net Likes for claude would
  // otherwise promote it straight back through the feedback re-read.
  const conservedDecide = (over = {}) => async () => ({
    routing: { ...pick('deepseek', 0.9, { claude: 0.5, deepseek: 0.5 }), conservedFrom: 'claude', decision: { candidates: [] }, ...over },
    plan: directPlan('deepseek'),
  })
  const likes = [1, 2, 3].map((i) => fbRow({ messageId: `m${i}`, verdict: 'like', provider: 'claude' }))
  const fed = await adaptiveRun({ deps: { decide: conservedDecide(), history: fbHistory(likes) } })
  assert.deepEqual(fed.seen, ['deepseek'], 'feedback did not pull the work back')
  assert.equal(fed.r.routing.feedbackFrom, undefined)
  assert.match(formatReport(fed.r), /Work kept off claude to conserve it for harder work; it stays available to review/)
  // The low-confidence tie-break would pick claude too: it is the low-marginal-cost one in the tie.
  const cfg = adaptiveConfig({ policy: { minRoutingConfidence: 0.95 } })
  const tied = await adaptiveRun({ config: cfg, deps: { decide: conservedDecide({ agentConfidence: 0.3, agentProbabilities: { deepseek: 0.36, claude: 0.34 } }) } })
  assert.deepEqual(tied.seen, ['deepseek'], 'the tie-break did not pull the work back either')
  assert.equal(tied.r.routing.tiebrokeFrom, undefined)
})

test('the plan\'s skill reaches the worker, the planner, the record and the report', async () => {
  const skill = { primary: 'debugging', description: 'Finding the cause of incorrect behaviour and fixing it', supporting: ['testing'], authority: 'jev' }
  const prompts = {}
  const decide = async () => ({
    routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), decision: { candidates: [] } },
    plan: { ...directPlan('deepseek'), strategy: 'PREMIUM_PLAN_CHEAP_EXECUTE', steps: [{ role: 'plan', agent: 'claude' }, { role: 'primary', agent: 'deepseek' }], skill },
  })
  const { r } = await adaptiveRun({ deps: { decide, execute: async (a, prompt) => { prompts[a.id] = prompt; return { stopReason: 'completed', answerText: 'done' } } } })
  const line = 'Approach this mainly as debugging work (Finding the cause of incorrect behaviour and fixing it). It also draws on testing.'
  const worker = prompts.deepseek.split('\n')
  assert.equal(worker[worker.findIndex((l) => l.startsWith('Workspace: ')) + 1], line, 'the line right after the workspace line')
  assert.ok(prompts.claude.includes(line), 'the plan step gets it too')
  assert.deepEqual(r.plan.skill, skill, 'history keeps it')
  assert.match(formatReport(r), /^- Skill: debugging \(\+ testing\)$/m)
})

test('a plan without a skill gets no invented one', async () => {
  const prompts = []
  const decide = async () => ({ routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek') })
  const { r } = await adaptiveRun({ deps: { decide, execute: async (a, prompt) => { prompts.push(prompt); return { stopReason: 'completed', answerText: 'done' } } } })
  assert.doesNotMatch(prompts[0], /Approach this mainly as/)
  assert.equal(r.plan.skill, undefined)
  assert.doesNotMatch(formatReport(r), /- Skill:/)
  // The router's own fallback plan has none either.
  const fb = await adaptiveRun({ deps: { jev: null, execute: async (a, prompt) => { prompts.push(prompt); return { stopReason: 'completed', answerText: 'done' } } } })
  assert.doesNotMatch(prompts[1], /Approach this mainly as/)
  assert.equal(fb.r.plan.skill, undefined)
})

test('the model an executor says it served is kept on the attempt, and never invented', async () => {
  const served = { claude: { modelVersion: 'opus-2026-09-01' }, deepseek: { model: 'deepseek-v4-0922' }, acme: {} }
  for (const [agent, extra] of Object.entries(served)) {
    const { r } = await adaptiveRun({ deps: { jev: { route: async () => pick(agent, 0.9, { [agent]: 0.9 }), assess: async () => ({}) }, execute: async () => ({ stopReason: 'completed', answerText: 'done', ...extra }) } })
    assert.equal(r.attempts[0].agent, agent)
    const want = extra.modelVersion ?? extra.model
    if (want) assert.equal(r.attempts[0].modelVersion, want)
    else assert.equal('modelVersion' in r.attempts[0], false, 'an executor that reports nothing gets no field')
  }
})

// ---------- the weekly gate is policy, and the engine may override it ----------

test('with the capability registry wired, a gated agent still reaches the decision engine', async () => {
  // Scenario C in a real install: the gate is cost policy that a frontier floor may outrank, so
  // the engine has to SEE the gated frontier resource to be able to keep it. Asked with the gate
  // counted as unavailability, no gated agent was ever "capable" once executors were wired.
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS })
  let offered = null
  const decide = async (args) => { offered = args.agents.map((a) => a.id); return { routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek') } }
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  await adaptiveRun({ deps: { decide, quota, executors } })
  assert.ok(offered.includes('claude'), `the gated agent was offered to the engine (offered: ${offered})`)
})

test('an engine override of the weekly gate survives the router\'s capability checks', async () => {
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS })
  const decide = async () => ({
    routing: { ...pick('claude', 0.9, { claude: 0.9 }, { taskType: 'security', risk: 0.95 }), decision: { gateOverride: true, candidates: [{ id: 'claude', key: 'RESOURCE_A' }] } },
    plan: directPlan('claude'),
  })
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  const { r, seen } = await adaptiveRun({ deps: { decide, quota, executors } })
  assert.equal(seen[0], 'claude', 'the resource the engine kept past its gate did the work')
  assert.equal(r.routing.capabilityFrom, undefined, 'no capability swap undid the override')
  assert.equal(r.routing.gatedFrom, undefined, 'and no gate swap')
})

// ---------- every swap respects the capability: hard facts outrank conservation and the gate ----------

test('a conserved agent that alone can do the named job takes it: a capability outranks conservation', async () => {
  const two = ADAPTIVE_AGENTS.filter((a) => a.id === 'claude' || a.id === 'qwen-local')
  const executors = executorsFrom({ agents: two })
  const decide = async () => ({ routing: { ...pick('qwen-local', 0.9, { 'qwen-local': 0.9 }), capability: 'web_research', conservedFrom: 'claude' }, plan: directPlan('qwen-local') })
  const { r, seen } = await adaptiveRun({ config: adaptiveConfig({ agents: two }), deps: { decide, executors } })
  assert.deepEqual(seen, ['claude'], 'the local model cannot look anything up, so the conserved agent does')
  assert.equal(r.routing.capabilityFrom, 'qwen-local')
})

test('after a tie-break, a LOCAL_FIRST hand-over goes to the new routed resource, not the one it moved off', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const decide = async () => ({ routing: { ...pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34, 'qwen-local': 0.3 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['deepseek', 'acme']) })
  const seen = []
  const { r } = await adaptiveRun({
    config: cfg,
    answerOnly: true,
    deps: { decide, execute: async (a) => { seen.push(a.id); return a.id === 'qwen-local' ? { stopReason: 'error', diagnostic: 'not loaded', answerText: '' } : { stopReason: 'completed', answerText: 'done' } } },
  })
  assert.equal(r.routing.tiebrokeFrom, 'deepseek', 'the setting: the tie-break moved the routed resource')
  assert.deepEqual(seen, ['qwen-local', 'acme'], 'the metered agent the tie-break moved off did not take over')
})

test('the tie-break never moves the work onto an agent that cannot do it', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS, seesImages: (id) => id === 'deepseek' })
  const decide = async () => ({ routing: pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34 }), plan: directPlan('deepseek') })
  const { r, seen } = await adaptiveRun({ config: cfg, deps: { decide, executors, inputModalities: ['image'] } })
  assert.equal(r.routing.tiebrokeFrom, undefined, 'acme cannot read the image, so it is not a tie-break target')
  assert.equal(seen[0], 'deepseek')
})

test('the weekly gate yields when nothing ungated can do the job, and the report says so', async () => {
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS, seesImages: (id) => id === 'claude' })
  const decide = async () => ({ routing: pick('claude', 0.9, { claude: 0.9 }), plan: directPlan('claude') })
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  const { r, seen } = await adaptiveRun({ deps: { decide, quota, executors, inputModalities: ['image'] } })
  assert.equal(seen[0], 'claude', 'only claude can read the image; moving the work would route a mismatch')
  assert.equal(r.routing.gatedFrom, undefined)
  assert.equal(r.routing.gateYielded, 'capability')
  const report = formatReport(r)
  assert.match(report, /despite its weekly gate: nothing ungated can do this request/)
  assert.doesNotMatch(report, /kept for review only: claude/, 'the agent that did the work is not also listed as held back')
})

test('a retry, ranked or named, never goes to an agent that cannot do the job', async () => {
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS, seesImages: (id) => id === 'deepseek' || id === 'claude' })
  const decide = async () => ({ routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek') })
  for (const assessment of [
    { status: 'retry', action: 'retry', disposition: 'RETRY_DIFFERENT_RESOURCE', retryAgentProbabilities: { acme: 0.9, claude: 0.1 } },
    { status: 'retry', action: 'retry', disposition: 'RETRY_DIFFERENT_RESOURCE', retryAgent: 'acme', retryAgentProbabilities: { acme: 0.9 } },
  ]) {
    let calls = 0
    const review = async () => (calls++ === 0 ? { quality: 0.2, ...assessment } : { status: 'accepted', action: 'accept', quality: 0.9 })
    const { seen } = await adaptiveRun({ deps: { decide, executors, review, inputModalities: ['image'] } })
    assert.deepEqual(seen.slice(0, 2), ['deepseek', 'claude'], `${assessment.retryAgent ? 'named' : 'ranked'}: acme cannot read the image`)
  }
})

test('two identical one-word answers are compared, and agree', () => {
  for (const [a, b] of [['ok', 'ok'], ['no', 'No.'], ['Да', 'да']]) {
    const c = compareAnswers(a, b)
    assert.equal(c.compared, true, `${a} / ${b}`)
    assert.equal(c.agree, true)
  }
  assert.equal(compareAnswers('yes', 'no').agree, false)
})

test('a local-only run emptied with the policy\'s help says so, instead of sending you to download a model you have', async () => {
  const cfg = adaptiveConfig({ routing: { disabledResources: ['qwen-local'] } })
  await assert.rejects(
    runRouted({ task: 'fix', cwd: repo(), config: cfg, signal, deps: { localOnly: true, review: accept, history: quiet, execute: async () => ({ stopReason: 'completed', answerText: 'done' }) } }),
    /no local model is ready \(qwen-local is disabled by configuration\)\. Allow it in the routing settings/,
  )
})

test('a Jev-routed local-only run refuses a job nothing on this PC can do, instead of running it anyway', async () => {
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS })
  const decide = async () => ({ routing: { ...pick('qwen-local', 0.9, { 'qwen-local': 0.9 }), capability: 'web_research' }, plan: directPlan('qwen-local') })
  const seen = []
  await assert.rejects(
    runRouted({ task: 'what changed in node 24', cwd: repo(), config: adaptiveConfig(), signal, deps: { localOnly: true, decide, executors, review: accept, history: quiet, execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done' } } } }),
    /nothing on this PC can do this request as "web_research"/,
  )
  assert.deepEqual(seen, [], 'the local model was not handed a look-up it cannot do')
})

// ---------- round five: every move honours every hard fact, and every strategy does what it says ----------

test('an agent whose context window cannot hold the request is out before any judgment, online and offline', async () => {
  const small = ADAPTIVE_AGENTS.map((a) => (a.id === 'qwen-local' ? { ...a, llm: { provider: 'local', model: 'q', contextSize: 2048 } } : a))
  const executors = executorsFrom({ agents: small })
  const big = `fix ${'x'.repeat(40_000)}`
  let offered = null
  const decide = async (args) => { offered = args.agents.map((a) => a.id); return { routing: pick('deepseek', 0.9, { deepseek: 0.9 }), plan: directPlan('deepseek') } }
  await adaptiveRun({ config: adaptiveConfig({ agents: small }), task: big, deps: { decide, executors } })
  assert.ok(offered && !offered.includes('qwen-local'), `the 2k local model was never offered for a 10k-token request (offered: ${offered})`)
  // Offline only the local model could run, and it cannot hold the request: the run stops rather
  // than hand the work to a model that would truncate it.
  const seen = []
  await assert.rejects(
    runRouted({ task: big, cwd: repo(), config: adaptiveConfig({ agents: small }), signal, deps: { offline: true, executors, review: accept, history: quiet, execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done' } } } }),
    /room for about \d+ tokens of context/,
  )
  assert.deepEqual(seen, [])
})

test('an agent the engine excluded as a fact is never handed the work by a router swap or a retry', async () => {
  const excluded = { excluded: [{ id: 'deepseek', reason: 'context window 1000 tokens is under the 4005 this request needs', hard: true }], candidates: [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier' }, { id: 'acme', key: 'RESOURCE_B', tier: 'strong' }] }
  // The weekly gate moves the work off claude: never onto deepseek.
  const gatedDecide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9, deepseek: 0.5 }), decision: excluded }, plan: directPlan('claude') })
  const quota = { claude: { kind: 'subscription', state: 'ok', weeklyPercent: 95 } }
  const gated = await adaptiveRun({ deps: { decide: gatedDecide, quota } })
  assert.equal(gated.r.routing.gatedFrom, 'claude', 'the setting: the gate moved the work')
  assert.ok(!gated.seen.includes('deepseek'), `deepseek cannot hold the request (ran: ${gated.seen})`)
  // A retry Jev names outright: not deepseek either.
  let calls = 0
  const review = async () => (calls++ === 0 ? { quality: 0.2, status: 'retry', action: 'retry', disposition: 'RETRY_DIFFERENT_RESOURCE', retryAgent: 'deepseek', retryAgentProbabilities: { deepseek: 0.9 } } : { status: 'accepted', action: 'accept', quality: 0.9 })
  const retried = await adaptiveRun({ deps: { decide: async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), decision: excluded }, plan: directPlan('claude') }), review } })
  assert.equal(retried.seen[0], 'claude')
  assert.ok(!retried.seen.includes('deepseek'), `the named retry was refused (ran: ${retried.seen})`)
})

test('a usage-limit hand-over goes only to an agent that can do the job, not to the usual peer', async () => {
  const three = [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'codex', provider: 'codex', description: 'b', enabled: true },
    { id: 'deepseek', provider: 'spawn', description: 'c', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  ]
  const executors = executorsFrom({ agents: three, seesImages: (id) => id !== 'codex' })
  let first = true
  const seen = []
  await runRouted({
    task: 'read this screenshot', cwd: repo(), config: adaptiveConfig({ agents: three }), signal,
    deps: {
      decide: async () => ({ routing: pick('claude', 0.9, { claude: 0.9 }), plan: directPlan('claude') }),
      executors, inputModalities: ['image'], review: accept, history: quiet,
      isLimitError: (a) => (a.id === 'claude' && first ? (first = false, { hit: true, until: null }) : { hit: false }),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done' } },
    },
  })
  assert.deepEqual(seen, ['claude', 'deepseek'], 'codex is claude\'s usual stand-in, but it cannot read the image')
})

test('the parallel answerer and the planner are work: never the conserved resource, never one that cannot do it', async () => {
  const cands = [{ id: 'deepseek', key: 'RESOURCE_A', tier: 'strong', fit: 0.8 }, { id: 'claude', key: 'RESOURCE_B', tier: 'frontier', fit: 0.9 }, { id: 'acme', key: 'RESOURCE_C', tier: 'strong', fit: 0.7 }]
  const parallel = (with_, over = {}) => async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), decision: { candidates: cands }, ...over }, plan: { ...directPlan('deepseek', { strategy: 'PARALLEL_SECOND_OPINION', parallelWith: with_ }) } })
  // claude was conserved: it may review, not answer the whole task beside the worker.
  const kept = await adaptiveRun({ answerOnly: true, deps: { decide: parallel('claude', { conservedFrom: 'claude' }) } })
  assert.ok(!kept.seen.includes('claude'), `the conserved resource did not answer (ran: ${kept.seen})`)
  assert.equal(kept.r.plan.parallelWith, 'acme', 'the strongest agent that could stand beside the worker did')
  // The planner writes the plan: the same rule.
  const planned = await adaptiveRun({ deps: { decide: async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), decision: { candidates: cands }, conservedFrom: 'claude' }, plan: { ...directPlan('deepseek', { strategy: 'PREMIUM_PLAN_CHEAP_EXECUTE' }), steps: [{ role: 'plan', agent: 'claude' }, { role: 'primary', agent: 'deepseek' }] } }) } })
  assert.ok(!planned.seen.includes('claude'), `the conserved resource did not plan (ran: ${planned.seen})`)
})

test('a reviewer the strategy requires is replaced, not dropped, when a swap makes it the worker', async () => {
  const cfg = adaptiveConfig({ resources: { economics: { acme: { marginalCost: 'low' } } } })
  const cands = [{ id: 'claude', key: 'RESOURCE_A', tier: 'frontier', fit: 0.9 }, { id: 'deepseek', key: 'RESOURCE_B', tier: 'strong', fit: 0.8 }, { id: 'acme', key: 'RESOURCE_C', tier: 'strong', fit: 0.7 }]
  const decide = async () => ({
    routing: { ...pick('deepseek', 0.3, { deepseek: 0.36, acme: 0.34 }), decision: { candidates: cands } },
    plan: directPlan('deepseek', { strategy: 'CHEAP_EXECUTE_FRONTIER_REVIEW', reviewer: 'acme', forceReview: true, frontierReview: true }),
  })
  const seen = []
  const { r } = await adaptiveRun({ config: cfg, deps: { decide, execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done' } } } })
  assert.equal(r.routing.tiebrokeFrom, 'deepseek', 'the setting: the tie-break made the planned reviewer the worker')
  assert.equal(r.plan.reviewer, 'claude', 'the strongest other resource reviews instead')
  assert.equal(r.plan.forceReview, true, 'and the review the strategy promises still happens')
})

test('a failed LOCAL_FIRST step hands over to the routed resource even when the review says retry the same tier', async () => {
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), strategy: 'LOCAL_FIRST' }, plan: localFirstPlan(['claude']) })
  let calls = 0
  const review = async () => (calls++ === 0 ? { quality: 0.1, status: 'retry', action: 'retry', disposition: 'RETRY_SAME_TIER' } : { status: 'accepted', action: 'accept', quality: 0.9 })
  const seen = []
  await adaptiveRun({ deps: { decide, review, execute: async (a) => { seen.push(a.id); return a.id === 'qwen-local' ? { stopReason: 'error', diagnostic: 'model not loaded', answerText: '' } : { stopReason: 'completed', answerText: 'done' } } } })
  assert.deepEqual(seen.slice(0, 2), ['qwen-local', 'claude'], 'the promised hand-over, not the local model again')
})

test('a tool that cannot do the capability Jev named does not run', async () => {
  const weather = { id: 'weather', description: 'weather lookup', command: 'x', params: { units: { question: 'Units?', options: { c: 'C', f: 'F' } } } }
  const executors = executorsFrom({ agents: ADAPTIVE_AGENTS, tools: [weather] })
  let toolRan = false
  const decide = async () => ({ routing: { ...pick('claude', 0.9, { claude: 0.9 }), capability: 'web_research', handler: 'weather', toolFits: 0.9, toolArgConfidence: 0.8, toolArgs: { units: 'f' } }, plan: directPlan('claude') })
  const { seen } = await adaptiveRun({ config: adaptiveConfig({ tools: [weather] }), deps: { decide, executors, runTool: async () => { toolRan = true; return { stopReason: 'completed', answerText: '72F' } } } })
  assert.equal(toolRan, false, 'a weather script is not a web research executor')
  assert.equal(seen[0], 'claude')
})

test('each attempt ends under its own index when a parallel opinion rides along', async () => {
  const cands = [{ id: 'deepseek', key: 'RESOURCE_A', tier: 'strong' }, { id: 'claude', key: 'RESOURCE_B', tier: 'frontier' }]
  const decide = async () => ({ routing: { ...pick('deepseek', 0.9, { deepseek: 0.9 }), decision: { candidates: cands } }, plan: directPlan('deepseek', { strategy: 'PARALLEL_SECOND_OPINION', parallelWith: 'claude' }) })
  const events = []
  await adaptiveRun({ answerOnly: true, deps: { decide, emit: (e) => events.push(e) } })
  const starts = events.filter((e) => e.type === 'attempt_start').map((e) => [e.index, e.agent])
  const ends = events.filter((e) => e.type === 'attempt_end').map((e) => [e.index, e.attempt.agent])
  assert.deepEqual(starts, [[0, 'deepseek'], [1, 'claude']])
  assert.deepEqual(ends.sort(), [[0, 'deepseek'], [1, 'claude']], 'the primary\'s end is paired with its start, not filed under the opinion')
})

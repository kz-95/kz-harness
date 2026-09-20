// Drives the real routing loop against a throwaway git repo with fake Jev and
// fake agents: fallback labelling, loop limits, second review, manual override,
// and deterministic checks blocking a wrong "accept".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatReport, runRouted } from '../router.js'

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
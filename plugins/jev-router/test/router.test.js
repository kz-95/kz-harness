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
  nextAgent: 'claude', nextAgentProbabilities: { claude: 0.5, codex: 0.3, deepseek: 0.2 }, ...over,
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
  const jev = { route: async () => routeResult({ needsSecondOpinion: 0.9 }), assess: async () => verdict('accept', { nextAgentProbabilities: { codex: 0.9, claude: 0.05, deepseek: 0.05 } }) }
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
  assert.equal(answeredBy(r), 'Jev (jev-1.13.0) → deepseek (deepseek-flash) · claude (opus), reviewer')
})

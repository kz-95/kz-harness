// Usage limits and handoff: exhausted agents are skipped, a limit hit moves the
// task on (next key, peer agent, or pause) with a handoff note, and a later run
// can continue from that note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatReport, runRouted } from '../router.js'

const config = {
  agents: [
    { id: 'claude', provider: 'claude-code', description: 'a', enabled: true },
    { id: 'codex', provider: 'codex', description: 'b', enabled: true },
    { id: 'deepseek', provider: 'x', description: 'c', enabled: true },
  ],
  fallbackAgent: 'claude',
  agentTimeoutMs: 60_000,
  limits: { maxAttempts: 4, maxReviews: 2, maxRounds: 6 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  checks: { enabled: true, scripts: ['test'], timeoutMs: 60_000, outputChars: 500 },
  productionWorkspaces: [],
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-handoff-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: { test: "node -e \"process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fixed'?0:1)\"" },
  }))
  writeFileSync(join(dir, 'state.txt'), 'broken')
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return dir
}

const history = () => ({ recent: async () => [], append: async () => {} })
const signal = new AbortController().signal
const routeResult = (over = {}) => ({
  primaryAgent: 'claude', agentConfidence: 0.8, agentProbabilities: { claude: 0.6, codex: 0.2, deepseek: 0.2 },
  taskType: 'debugging', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2,
  needsSecondOpinion: 0.1, needsHumanReview: 0.1, needsTests: 0.9, ...over,
})
const accept = { verdict: 'accept', addressed: 0.9, complete: 0.9, unrelatedChanges: 0.1, regressionRisk: 0.1, needsPerson: 0.05, reviewAgent: 'claude', reviewAgentProbabilities: {}, retryAgent: 'claude', retryAgentProbabilities: {} }
const limitHit = { stopReason: 'error', diagnostic: 'Claude usage limit reached', answerText: '' }
const fix = (dir) => { writeFileSync(join(dir, 'state.txt'), 'fixed'); return { stopReason: 'completed', answerText: 'fixed it' } }
const until = new Date(Date.now() + 3_600_000).toISOString()

test('stopped/exhausted agents are excluded; near-limit agents are flagged to Jev and prompted', async () => {
  const dir = repo()
  let routeArgs
  const prompts = []
  const jev = { route: async (a) => { routeArgs = a; return routeResult({ primaryAgent: 'codex' }) }, assess: async () => accept }
  const quota = { codex: { state: 'exhausted', until }, claude: { state: 'near' }, deepseek: { state: 'ok' } }
  const execute = async (a, p) => { prompts.push([a.id, p]); return fix(dir) }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, quota, execute, history: history() } })
  assert.deepEqual(routeArgs.agents.map((a) => a.id), ['claude', 'deepseek'])
  assert.deepEqual(routeArgs.availability, { claude: 'near limit', deepseek: 'ok' })
  assert.equal(prompts[0][0], 'claude')
  assert.match(prompts[0][1], /close to your usage limit/)
  assert.match(prompts[0][1], /\.kz-harness\/handoff\.md/)
  assert.match(formatReport(r), /Out: codex until \d\d:\d\d; near limit: claude/)
  const allOut = { claude: { state: 'stopped' }, codex: { state: 'exhausted', until }, deepseek: { state: 'exhausted' } }
  await assert.rejects(runRouted({ task: 'fix', cwd: dir, config, signal, deps: { jev, quota: allOut, execute, history: history() } }), /at their usage limits \(earliest reset/)
  await assert.rejects(runRouted({ task: 'fix', cwd: dir, forceAgent: 'codex', config, signal, deps: { jev, quota, execute, history: history() } }), /codex is at its usage limit/)
})

test('subscription limit: peer continues with the handoff, no quality review, note archived on accept', async () => {
  const dir = repo()
  const used = []
  const prompts = []
  const events = []
  const onLimit = []
  const logged = []
  let assessed = 0
  const jev = { route: async () => routeResult(), assess: async () => { assessed++; return accept } }
  const execute = async (a, p) => { used.push(a.id); prompts.push(p); return used.length === 1 ? limitHit : fix(dir) }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: {
    jev, execute, history: history(), emit: (e) => events.push(e),
    onLimit: async (id, info) => { onLimit.push([id, info.reason]); return { rotated: false } },
    logAttempt: (e) => logged.push(e),
  } })
  assert.deepEqual(used, ['claude', 'codex'])
  assert.deepEqual(onLimit, [['claude', 'Claude usage limit reached']])
  assert.equal(assessed, 1)
  assert.match(prompts[1], /Handoff \(written by Kz-harness/)
  assert.deepEqual(events.filter((e) => e.type === 'limit').map((e) => e.action), ['peer'])
  assert.deepEqual(events.filter((e) => e.type === 'handoff').map((e) => e.source), ['harness'])
  assert.equal(r.finalStatus, 'accepted')
  assert.deepEqual(r.attempts[1].changedFiles, ['state.txt'])
  assert.deepEqual(logged.map((e) => [e.agent, e.limitHit, e.runId === r.runId]), [['claude', true, true], ['codex', false, true]])
  assert.equal(existsSync(join(dir, '.kz-harness', 'handoff.md')), false)
  assert.equal(readdirSync(join(dir, '.kz-harness')).filter((f) => f.startsWith('handoff-done-')).length, 1)
  assert.match(formatReport(r), /Usage limit: claude → handed to another agent/)
})

test('api key limit with rotation re-runs the same agent with the agent-written note', async () => {
  const dir = repo()
  const used = []
  const prompts = []
  const events = []
  const jev = { route: async () => routeResult({ primaryAgent: 'deepseek' }), assess: async () => accept }
  const execute = async (a, p) => {
    used.push(a.id); prompts.push(p)
    if (used.length > 1) return fix(dir)
    mkdirSync(join(dir, '.kz-harness'), { recursive: true })
    writeFileSync(join(dir, '.kz-harness', 'handoff.md'), 'Done: step 1 AGENT-NOTE')
    return { stopReason: 'error', diagnostic: 'LlmError: 402 Insufficient Balance', answerText: '' }
  }
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: {
    jev, execute, history: history(), emit: (e) => events.push(e),
    isLimitError: (a, res) => ({ hit: /402/.test(res.diagnostic ?? '') }),
    onLimit: async () => ({ rotated: true, key: 'second' }),
  } })
  assert.deepEqual(used, ['deepseek', 'deepseek'])
  assert.deepEqual(r.attempts.map((a) => a.role), ['primary', 'retry'])
  assert.match(prompts[1], /AGENT-NOTE/)
  assert.deepEqual(events.filter((e) => e.type === 'limit').map((e) => e.action), ['rotated'])
  assert.deepEqual(events.filter((e) => e.type === 'handoff').map((e) => e.source), ['agent'])
  assert.equal(r.finalStatus, 'accepted')
})

test('every agent at its limit: paused_limit with a harness handoff that stays', async () => {
  const dir = repo()
  const events = []
  const execute = async () => limitHit
  const r = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: {
    jev: null, execute, history: history(), emit: (e) => events.push(e),
    isLimitError: () => ({ hit: true, until }),
    onLimit: async () => ({ rotated: false }),
  } })
  assert.equal(r.finalStatus, 'paused_limit')
  assert.deepEqual(r.limits.map((l) => l.action), ['peer', 'peer', 'paused'])
  assert.equal(r.assessments.length, 0)
  const note = readFileSync(join(dir, '.kz-harness', 'handoff.md'), 'utf8')
  assert.match(note, /written by Kz-harness/)
  assert.match(note, /Task: fix/)
  assert.match(formatReport(r), /PAUSED: agents at their limits, handoff saved in \.kz-harness\/handoff\.md \(earliest reset \d\d:\d\d\)/)
})

test('a new task that continues the earlier work gets the note; an unrelated one does not', async () => {
  for (const [p, expect] of [[0.9, true], [0.1, false]]) {
    const dir = repo()
    mkdirSync(join(dir, '.kz-harness'))
    writeFileSync(join(dir, '.kz-harness', 'handoff.md'), 'Next: finish NOTE-XYZ')
    let routeArgs
    const prompts = []
    const jev = { route: async (a) => { routeArgs = a; return routeResult({ continueHandoff: p }) }, assess: async () => accept }
    const r = await runRouted({ task: 'keep going', cwd: dir, config, signal, deps: { jev, execute: async (a, pr) => { prompts.push(pr); return fix(dir) }, history: history() } })
    assert.match(routeArgs.handoff, /NOTE-XYZ/)
    assert.equal(prompts[0].includes('NOTE-XYZ'), expect)
    assert.equal(r.continuedFromHandoff, expect)
    assert.equal(/Continuing from handoff/.test(formatReport(r)), expect)
  }
})

test('without Jev, "continue" in the task picks up the note', async () => {
  const dir = repo()
  mkdirSync(join(dir, '.kz-harness'))
  writeFileSync(join(dir, '.kz-harness', 'handoff.md'), 'Next: NOTE-XYZ')
  const prompts = []
  const r = await runRouted({ task: 'please continue', cwd: dir, config, signal, deps: { jev: null, execute: async (a, pr) => { prompts.push(pr); return fix(dir) }, history: history() } })
  assert.match(prompts[0], /NOTE-XYZ/)
  assert.equal(r.continuedFromHandoff, true)
})

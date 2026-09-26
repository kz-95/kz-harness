// Usage limits and handoff: exhausted agents are skipped, a limit hit moves the
// task on (next key, peer agent, or pause) with a handoff note, and a later run
// can continue from that note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { createJev } from '../jev.js'
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
  assert.ok(prompts[0][1].includes(`Keep ${join(dir, '.kz-harness', 'handoff.md')} updated as you work`), 'the note by its full path')
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

test('a harness note is replaced, never wrapped inside its own replacement, however long an attempt took', async () => {
  // The bug this guards: authorship was inferred from the file being newer than a second before
  // the attempt started, so any attempt lasting longer than that read the harness's own note as
  // the agent's and wrapped it under `## Earlier note` inside a fresh one. Each rewrite nested it
  // one deeper, and the 2000-character clip pushed the real earlier note out.
  //
  // Nothing here waits or measures: three rewrites in a row prove it whatever the machine's speed,
  // which is the point - the old rule passed on a fast machine and failed on a slow one.
  const dir = repo()
  mkdirSync(join(dir, '.kz-harness'))
  const file = join(dir, '.kz-harness', 'handoff.md')
  writeFileSync(file, 'The lexer is done. The parser needs the operator table finishing.\n')
  const hourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(file, hourAgo, hourAgo)
  const rewrite = () => runRouted({ task: 'fix', cwd: dir, config, signal, deps: {
    jev: null, execute: async () => ({ ...limitHit, answerText: 'ran out of allowance' }), history: history(),
    isLimitError: () => ({ hit: true, until }),
    onLimit: async () => ({ rotated: false }),
  } })
  for (let i = 0; i < 3; i++) await rewrite()
  const note = readFileSync(file, 'utf8')
  assert.equal((note.match(/## Earlier note/g) ?? []).length, 1, `one earlier note after three rewrites, not one per rewrite:\n${note}`)
  assert.equal((note.match(/written by Kz-harness/g) ?? []).length, 1, 'and one harness note, not a harness note inside a harness note')
  // The thing all of this exists to protect: what the last agent wrote by hand is still there.
  assert.match(note, /The parser needs the operator table finishing/, 'the agent note survived every rewrite')
})

test('a key the harness note would cut in two is masked in it, so the next run sends Jev no piece of it', async (t) => {
  // The harness copies 2000 characters of the last answer and of the earlier note into its own.
  // A key that straddled that cut left its first half in the note, too short for the scrubber to
  // know it for a key, and the next run's routing call carries the note to Jev.
  const answerKey = 'hf_Q8vLm2RtX4nWc7Pz1YkD9sGb3HjF6aKe' // at 1980 of the answer: the cut kept 'hf_' and 17 more
  const noteKey = 'xoxb-KUz9-9nocsomoEDN65Ayn8wqv' // at 1986 of the earlier note: the cut kept 'xoxb-' and 9 more
  const pieces = (text) => [answerKey, noteKey].filter((key) => Array.from({ length: key.length - 9 }, (_, i) => key.slice(i, i + 10)).some((p) => text.includes(p)))
  const dir = repo()
  mkdirSync(join(dir, '.kz-harness'))
  const file = join(dir, '.kz-harness', 'handoff.md')
  writeFileSync(file, `${'Earlier run: the lexer is done, the parser is half done.\n'.repeat(34).padEnd(1986)}${noteKey} posts the build status.\n`)
  // An hour old, so the harness reads it as the earlier note and not as one the agent just wrote.
  const hourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(file, hourAgo, hourAgo)
  const answer = `${'I finished the parser and started on the printer.\n'.repeat(38).padEnd(1980)}${answerKey} is the token the upload used.`
  const paused = await runRouted({ task: 'fix', cwd: dir, config, signal, deps: {
    jev: null, execute: async () => ({ ...limitHit, answerText: answer }), history: history(),
    isLimitError: () => ({ hit: true, until }),
    onLimit: async () => ({ rotated: false }),
  } })
  assert.equal(paused.finalStatus, 'paused_limit')
  const note = readFileSync(file, 'utf8')
  assert.match(note, /written by Kz-harness/)
  assert.deepEqual(pieces(note), [], 'a piece of a key was written into the note')
  assert.match(note, /started on the printer\.\n +hf_Q8v\.\.\.REDACTED is/, 'the answer is still in it, the key masked')
  assert.match(note, /half done\.\n +xoxb-K\.\.\.REDAC/, 'and so is the earlier note')

  // The next run reads the note, and its routing call carries the first 3000 characters of it.
  const sent = []
  const real = TypeSafeClient.prototype.systemOne
  TypeSafeClient.prototype.systemOne = async ({ state, questions }) => {
    sent.push(state)
    const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'choice'
      ? { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.8, probabilities: {} }
      : q.type === 'score' ? { type: 'score', score: 1, confidence: 0.8 } : { type: 'noul', noul: 0.9, confidence: 0.8 }]))
    return { model: 'jev-test', usage: {}, answers }
  }
  t.after(() => { TypeSafeClient.prototype.systemOne = real })
  const jev = createJev({ apiKey: 'tsk_test_key', timeoutMs: 1000 })
  await runRouted({ task: 'continue the fix', cwd: dir, config, signal, deps: { jev, execute: async () => fix(dir), history: history() } })
  assert.match(sent[0].handoff, /hf_Q8v\.\.\.REDACTED/, 'the routing call carried the note')
  for (const state of sent) assert.deepEqual(pieces(JSON.stringify(state)), [], 'a piece of a key rode out to Jev')
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

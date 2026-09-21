// Guards that stop a run spending on nothing: the stall guard, the indifference tiebreak,
// and the two trackRecord defects that were telling Jev the wrong thing about its agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRouted, trackRecord } from '../router.js'

const signal = new AbortController().signal

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-guards-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  return dir
}

const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'subscription', enabled: true },
  { id: 'deepseek', provider: 'spawn', description: 'api', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  { id: 'qwen-local', kind: 'local', provider: 'spawn', description: 'local', enabled: true },
]

const baseConfig = (extra = {}) => ({
  agents: AGENTS,
  tools: [],
  limits: { maxAttempts: 6, maxReviews: 6, maxRounds: 8 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  productionWorkspaces: [],
  agentTimeoutMs: 20_000,
  checks: {},
  effort: {},
  ...extra,
})

/**
 * One run with the review decision forced, so the loop's own behaviour is what is under test
 * rather than the review plugin's thresholds.
 * `touch` writes a file per attempt, which is how an attempt comes to have changedFiles.
 */
async function run({ route, action = 'accept', policy, touch = false, git = true }) {
  const dir = git ? repo() : mkdtempSync(join(tmpdir(), 'kz-guards-nogit-'))
  const seen = []
  const deps = {
    jev: {
      route: async () => route,
      assess: async () => ({}),
    },
    review: async () => (action === 'accept'
      ? { status: 'accepted', action: 'accept', quality: 0.9 }
      : { status: null, action, why: 'not good enough', reviewAgent: null, reviewAgentProbabilities: {}, retryAgent: null, retryAgentProbabilities: {} }),
    execute: async (agentDef) => {
      seen.push(agentDef.id)
      if (touch) writeFileSync(join(dir, `f${seen.length}.txt`), 'y')
      return { stopReason: 'completed', answerText: 'done', diagnostic: null }
    },
    history: { recent: async () => [], records: async () => [], append: async () => {} },
    logAttempt: async () => {},
  }
  const r = await runRouted({ task: 'do a thing', cwd: dir, config: baseConfig(policy ? { policy } : {}), signal, deps })
  return { r, seen }
}

const jevPick = (primaryAgent, agentConfidence, agentProbabilities) => ({
  primaryAgent, agentConfidence, agentProbabilities,
  taskType: 'implementation', complexity: 0.3, risk: 0.3, secondOpinion: 0.1, humanReview: 0.1, needsTests: 0.1, toolFit: {},
})

// ---------------------------------------------------------------- stall guard

test('two work attempts that change no files stop the run instead of retrying again', async () => {
  const { r, seen } = await run({ route: jevPick('claude', 0.9, { claude: 0.9 }), action: 'retry' })
  assert.equal(seen.length, 2, 'stopped after the second empty attempt, no third spend')
  assert.equal(r.finalStatus, 'needs_human')
  assert.match(r.statusReason, /changed no files/)
})

test('attempts that do change files keep retrying: the guard is about nothing happening, not about failing', async () => {
  const { seen } = await run({ route: jevPick('claude', 0.9, { claude: 0.9 }), action: 'retry', touch: true })
  assert.ok(seen.length > 2, `kept going while work was landing, ran ${seen.length}`)
})

test('where changes cannot be measured the guard holds off: unknown is not "changed nothing"', async () => {
  // No git, so changedSince reports null for every attempt even though each one writes a file.
  const { r, seen } = await run({ route: jevPick('claude', 0.9, { claude: 0.9 }), action: 'retry', touch: true, git: false })
  assert.ok(seen.length > 2, `kept going where changes are unknown, ran ${seen.length}`)
  assert.notEqual(r.finalStatus, 'needs_human')
})

test('the stall threshold is configurable', async () => {
  const { seen } = await run({ route: jevPick('claude', 0.9, { claude: 0.9 }), action: 'retry', policy: { stallAfter: 3 } })
  assert.equal(seen.length, 3)
})

// ---------------------------------------------------------------- tiebreak

test('undecided Jev plus a metered pick hands the work to a subscription it rated the same', async () => {
  const { r, seen } = await run({ route: jevPick('deepseek', 0.3, { deepseek: 0.36, claude: 0.34, 'qwen-local': 0.3 }) })
  assert.equal(seen[0], 'claude', 'took the tied subscription instead of the paid key')
  assert.equal(r.routing.tiebrokeFrom, 'deepseek')
})

test('a tie is never broken toward a local model: cheapest must not mean weakest', async () => {
  const { r, seen } = await run({ route: jevPick('deepseek', 0.3, { deepseek: 0.36, 'qwen-local': 0.34, claude: 0.1 }) })
  assert.equal(seen[0], 'deepseek', 'no swap: only the local model was tied')
  assert.equal(r.routing.tiebrokeFrom, undefined)
})

test('a confident pick is left alone even when another agent is close', async () => {
  const { r, seen } = await run({ route: jevPick('deepseek', 0.95, { deepseek: 0.5, claude: 0.45 }) })
  assert.equal(seen[0], 'deepseek')
  assert.equal(r.routing.tiebrokeFrom, undefined)
})

test('a clear win is left alone even when Jev is unsure overall', async () => {
  const { seen } = await run({ route: jevPick('deepseek', 0.3, { deepseek: 0.4, claude: 0.1 }) })
  assert.equal(seen[0], 'deepseek', 'claude was not within the margin')
})

// ---------------------------------------------------------------- gated agents

test('an agent past its weekly gate is not offered to Jev for the work at all', async () => {
  const dir = repo()
  let offered = null
  await runRouted({
    task: 'do a thing',
    cwd: dir,
    signal,
    config: baseConfig({ policy: { gateAtPercent: { default: 90 } } }),
    deps: {
      quota: { claude: { state: 'ok', kind: 'subscription', weeklyPercent: 95 }, deepseek: { state: 'ok', kind: 'api' } },
      jev: {
        route: async (s) => { offered = s.agents.map((a) => a.id); return jevPick('deepseek', 0.9, { deepseek: 0.9 }) },
        assess: async () => ({}),
      },
      review: async () => ({ status: 'accepted', action: 'accept', quality: 0.9 }),
      execute: async () => ({ stopReason: 'completed', answerText: 'done', diagnostic: null }),
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.ok(offered, 'Jev was asked')
  assert.equal(offered.includes('claude'), false, 'the gated subscription was not on the menu')
  assert.ok(offered.includes('deepseek'), 'the ungated agents still were')
})

// ---------------------------------------------------------------- stopped runs

test('a run you stop is written to history as stopped, and still throws', async () => {
  const dir = repo()
  const ac = new AbortController()
  let saved = null
  await assert.rejects(() => runRouted({
    task: 'do a thing',
    cwd: dir,
    sessionId: 'sess-1',
    signal: ac.signal,
    config: baseConfig(),
    deps: {
      jev: { route: async () => jevPick('claude', 0.9, { claude: 0.9 }), assess: async () => ({}) },
      review: async () => ({ status: 'accepted', action: 'accept', quality: 0.9 }),
      execute: async () => { ac.abort(); throw new Error('The operation was aborted') },
      history: { recent: async () => [], records: async () => [], append: async (r) => { saved = r } },
      logAttempt: async () => {},
    },
  }), 'the abort still reaches the caller')
  assert.ok(saved, 'a killed run leaves a row rather than nothing')
  assert.equal(saved.finalStatus, 'stopped')
  assert.match(saved.statusReason, /stopped by the user/)
  assert.equal(saved.sessionId, 'sess-1', 'and it is tied to the conversation it came from')
})

// ---------------------------------------------------------------- trackRecord

const rec = (workspace, finalStatus, attempts) => ({ workspace, finalStatus, routing: { taskType: 'fix' }, attempts })
const AG = [{ id: 'claude', provider: 'claude-code' }, { id: 'deepseek', kind: 'api' }]

test('a quota stop is not counted as a failed attempt', async () => {
  const rows = [
    rec('/w', 'needs_human', [{ agent: 'claude', role: 'primary', limitHit: true, durationMs: 10 }]),
    rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }]),
    rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }]),
    rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }]),
  ]
  const t = trackRecord(rows, '/w', AG, {})
  assert.equal(t.claude.overall.attempts, 3, 'the limited run left the denominator')
  assert.equal(t.claude.overall.accepted_rate, 1, 'three for three, not three for four')
  assert.equal(t.claude.overall.limit_hits, 1, 'still reported, just not as incompetence')
})

test('a rate is withheld until there are enough attempts to mean anything', async () => {
  const one = trackRecord([rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }])], '/w', AG, {})
  assert.equal(one.claude.overall.accepted_rate, null, 'one lucky run must not read as "always works"')
  assert.equal(one.claude.overall.attempts, 1, 'the count still goes out')
  assert.match(one.claude.overall.note, /too few/)

  const rows = Array.from({ length: 3 }, () => rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }]))
  assert.equal(trackRecord(rows, '/w', AG, {}).claude.overall.accepted_rate, 1, 'reported once there are enough')
})

test('an agent that never ran is reported as unknown, not as bad', async () => {
  const t = trackRecord([rec('/w', 'accepted', [{ agent: 'claude', role: 'primary', durationMs: 10 }])], '/w', AG, {})
  assert.equal(t.deepseek.overall, 'no runs yet')
})

// ---------------------------------------------------------------- split picks

test('the reviewer pick and the fixer pick are separate answers, not one answer used twice', async () => {
  const dir = repo()
  const roles = []
  let round = 0
  await runRouted({
    task: 'do a thing',
    cwd: dir,
    signal,
    config: baseConfig(),
    deps: {
      jev: { route: async () => jevPick('deepseek', 0.9, { deepseek: 0.9 }), assess: async () => ({}) },
      // Jev names a careful judge and a different fixer; each must go to its own job.
      review: async () => {
        round++
        if (round === 1) return { status: null, action: 'second_review', why: 'check it', reviewAgentProbabilities: { claude: 0.9 }, retryAgent: 'qwen-local', retryAgentProbabilities: { 'qwen-local': 0.9 } }
        if (round === 2) return { status: null, action: 'retry', why: 'fix it', reviewAgentProbabilities: { claude: 0.9 }, retryAgent: 'qwen-local', retryAgentProbabilities: { 'qwen-local': 0.9 } }
        return { status: 'accepted', action: 'accept', quality: 0.9 }
      },
      execute: async (a) => { roles.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.equal(roles[0], 'deepseek', 'the primary did the work')
  assert.equal(roles[1], 'claude', 'the REVIEW went to the review pick')
  assert.equal(roles[2], 'qwen-local', 'the RETRY went to the retry pick, not the reviewer')
})

test('an unsure pick of a weak local model also moves to a tied subscription', async () => {
  // The case from a real run: confidence 0.26, and the work went to the smallest model in the
  // list. A tie is exactly when Jev cannot tell them apart, so it should not be the coin that
  // decides whether real work goes to a 8B local model.
  const { r, seen } = await run({ route: jevPick('qwen-local', 0.26, { 'qwen-local': 0.41, claude: 0.35, deepseek: 0.19 }) })
  assert.equal(seen[0], 'claude', 'the tied subscription took it')
  assert.equal(r.routing.tiebrokeFrom, 'qwen-local')
})

test('an unsure local pick with no subscription anywhere near it is left alone', async () => {
  const { r, seen } = await run({ route: jevPick('qwen-local', 0.26, { 'qwen-local': 0.6, claude: 0.1, deepseek: 0.3 }) })
  assert.equal(seen[0], 'qwen-local', 'nothing was tied with it')
  assert.equal(r.routing.tiebrokeFrom, undefined)
})

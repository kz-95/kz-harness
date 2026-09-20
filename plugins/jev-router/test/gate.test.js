// The subscription-first gate: past its weekly share an agent stops doing bulk work
// and is kept for judging, where the remaining percent buys the most.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRouted } from '../router.js'

const signal = new AbortController().signal

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-gate-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  return dir
}

const AGENTS = [
  { id: 'claude', provider: 'claude-code', description: 'subscription', enabled: true },
  { id: 'codex', provider: 'codex', description: 'subscription', enabled: true },
  { id: 'deepseek', provider: 'spawn', description: 'api', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]

const baseConfig = (extra = {}) => ({
  agents: AGENTS,
  tools: [],
  limits: { maxAttempts: 2, maxReviews: 1, maxRounds: 3 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  productionWorkspaces: [],
  agentTimeoutMs: 20_000,
  checks: {},
  effort: {},
  ...extra,
})

/** quota rows as quotaFor builds them: kind + the weekly percent the gate reads. */
const q = (kind, weeklyPercent, state = 'ok') => ({ state, until: null, kind, weeklyPercent, summary: null })

/** Run one task and report which agent did the work and which reviewed. */
async function run({ quota, policy, jevPicks = 'claude' }) {
  const dir = repo()
  const seen = []
  const deps = {
    quota,
    jev: {
      route: async () => ({ primaryAgent: jevPicks, agentProbabilities: { claude: 0.9, codex: 0.5, deepseek: 0.4 }, taskType: 'implementation', complexity: 0.3, risk: 0.3, secondOpinion: 0.9, humanReview: 0.1, needsTests: 0.1, toolFit: {} }),
      assess: async () => ({ verdict: 'second_review', quality: 0.5, addressed: true, complete: true, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: null, reviewAgentProbabilities: { codex: 0.8, deepseek: 0.7, claude: 0.6 }, retryAgent: null, retryAgentProbabilities: { codex: 0.8, deepseek: 0.7, claude: 0.6 } }),
    },
    execute: async (agentDef) => { seen.push(agentDef.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
    history: { recent: async () => [], records: async () => [], append: async () => {} },
    logAttempt: async () => {},
  }
  const r = await runRouted({ task: 'do a thing', cwd: dir, config: baseConfig(policy ? { policy } : {}), signal, deps })
  return { r, seen }
}

test('under the gate nothing changes: the picked subscription does the work', async () => {
  const { r, seen } = await run({ quota: { claude: q('subscription', 20), codex: q('subscription', 10), deepseek: q('api', null) } })
  assert.equal(r.routing.primaryAgent, 'claude')
  assert.equal(seen[0], 'claude')
  assert.equal(r.gated, undefined, 'nothing is gated, so nothing is reported')
})

test('over the gate the work moves off, and the gated agent is kept for review', async () => {
  const { r, seen } = await run({ quota: { claude: q('subscription', 92), codex: q('subscription', 10), deepseek: q('api', null) } })
  assert.notEqual(r.routing.primaryAgent, 'claude', 'claude is past its gate and must not do the work')
  assert.equal(r.routing.gatedFrom, 'claude')
  assert.deepEqual(r.gated, ['claude'])
  assert.equal(seen[0], r.routing.primaryAgent, 'the agent that ran is the one routing named')
  // Being gated removes an agent from WORK only; it stays in `agents`, so review can still
  // choose it (JUDGMENT_ROLES). Whether a review runs at all is the review policy's business,
  // not the gate's, so this test does not assert on it.
  assert.ok(r.routing.primaryAgent !== 'claude' && r.gated.includes('claude'))
})

test('work prefers another subscription over the paid api', async () => {
  const { r } = await run({ quota: { claude: q('subscription', 92), codex: q('subscription', 5), deepseek: q('api', null) } })
  assert.equal(r.routing.primaryAgent, 'codex', 'codex is still under its gate and still free at the margin')
})

test('every subscription over the gate is what finally reaches the api agent', async () => {
  const { r } = await run({ quota: { claude: q('subscription', 92), codex: q('subscription', 95), deepseek: q('api', null) } })
  assert.equal(r.routing.primaryAgent, 'deepseek')
  assert.deepEqual(r.gated.sort(), ['claude', 'codex'])
})

test('the gate is per agent and per plan', async () => {
  // 85% is over a Pro gate of 80 but under a Max gate of 90.
  const pro = await run({ quota: { claude: q('subscription', 85), codex: q('subscription', 5), deepseek: q('api', null) }, policy: { gateAtPercent: { default: 80 } } })
  assert.equal(pro.r.routing.gatedFrom, 'claude', 'Pro gates at 80')

  const max = await run({ quota: { claude: q('subscription', 85), codex: q('subscription', 5), deepseek: q('api', null) }, policy: { gateAtPercent: { claude: 90, default: 80 } } })
  assert.equal(max.r.routing.gatedFrom, undefined, 'Max gates at 90, so 85% still works')
  assert.equal(max.r.routing.primaryAgent, 'claude')
})

test('unknown weekly never gates: a cold start must not spend money', async () => {
  // quota empty (cold start), and a failed usage fetch reporting ok with no windows.
  for (const quota of [{}, { claude: q('subscription', null), codex: q('subscription', null), deepseek: q('api', null) }]) {
    const { r } = await run({ quota })
    assert.equal(r.routing.primaryAgent, 'claude', 'unknown means carry on with the subscription')
    assert.equal(r.gated, undefined)
  }
})

test('an api agent is never gated by the weekly rule', async () => {
  // A percent on an api row (however it got there) must not gate it: it has no weekly window.
  const { r } = await run({ quota: { claude: q('subscription', 99), codex: q('subscription', 99), deepseek: q('api', 99) } })
  assert.equal(r.routing.primaryAgent, 'deepseek')
  assert.deepEqual(r.gated.sort(), ['claude', 'codex'], 'only the subscriptions are gated')
})

test('a forced agent is never silently swapped', async () => {
  const dir = repo()
  const seen = []
  const r = await runRouted({
    task: 'do a thing',
    cwd: dir,
    forceAgent: 'claude',
    config: baseConfig(),
    signal,
    deps: {
      quota: { claude: q('subscription', 99), codex: q('subscription', 5), deepseek: q('api', null) },
      jev: null,
      jevUnavailableReason: 'no key',
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.equal(r.routing.primaryAgent, 'claude', 'you asked for claude, you get claude')
  assert.equal(seen[0], 'claude')
})

test('a 5-hour limit hands the work on, and never to a subscription that is also spent', async () => {
  const dir = repo()
  const seen = []
  let first = true
  const r = await runRouted({
    task: 'do a thing',
    cwd: dir,
    config: baseConfig(),
    signal,
    deps: {
      // claude is fine on weekly but will hit its 5-hour limit mid-run.
      // codex is already past its weekly gate, so it must NOT be handed the work.
      quota: { claude: q('subscription', 10), codex: q('subscription', 95), deepseek: q('api', null) },
      jev: null,
      jevUnavailableReason: 'no key',
      isLimitError: (a) => (a.id === 'claude' && first ? (first = false, { hit: true, until: null }) : { hit: false }),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.equal(seen[0], 'claude', 'claude started the work')
  assert.ok(seen.length > 1, 'the work was handed on rather than dropped')
  assert.notEqual(seen[1], 'codex', 'codex is past its weekly gate: handing to it just moves the problem')
  assert.equal(seen[1], 'deepseek', 'the api agent continues')
  assert.match(String(r.finalStatus), /accepted|needs_human|limit_reached/)
})

test('Jev naming a gated agent for the retry is still refused', async () => {
  const dir = repo()
  const seen = []
  let firstAssess = true
  await runRouted({
    task: 'do a thing',
    cwd: dir,
    config: baseConfig(),
    signal,
    deps: {
      // codex is past its gate; Jev nevertheless names it as the next agent on retry.
      quota: { claude: q('subscription', 10), codex: q('subscription', 95), deepseek: q('api', null) },
      jev: {
        route: async () => ({ primaryAgent: 'claude', agentProbabilities: { claude: 0.9, codex: 0.8, deepseek: 0.1 }, taskType: 'implementation', complexity: 0.3, risk: 0.3, secondOpinion: 0.1, humanReview: 0.1, needsTests: 0.1, toolFit: {} }),
        assess: async () => (firstAssess
          ? (firstAssess = false, { verdict: 'retry', quality: 0.2, addressed: false, complete: false, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: 'codex', reviewAgentProbabilities: { codex: 0.9 }, retryAgent: 'codex', retryAgentProbabilities: { codex: 0.9 } })
          : { verdict: 'accept', quality: 0.9, addressed: true, complete: true, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: null, reviewAgentProbabilities: {}, retryAgent: null, retryAgentProbabilities: {} }),
      },
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.equal(seen[0], 'claude')
  assert.ok(seen.length > 1, 'a retry happened')
  assert.notEqual(seen[1], 'codex', 'Jev named codex, but codex is past its weekly gate')
})

test('the cost and history priors actually reach Jev', async () => {
  const dir = repo()
  let state = null
  await runRouted({
    task: 'do a thing',
    cwd: dir,
    config: baseConfig({ pricing: { peak: { deepseek: { windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }], note: 'off-peak discount' } } } }),
    signal,
    deps: {
      quota: { claude: q('subscription', 10), codex: q('subscription', 10), deepseek: q('api', null) },
      jev: {
        route: async (s) => { state = s; return { primaryAgent: 'claude', agentProbabilities: {}, taskType: 'implementation', complexity: 0.2, risk: 0.2, secondOpinion: 0.1, humanReview: 0.1, needsTests: 0.1, toolFit: {} } },
        assess: async () => ({ verdict: 'accept', quality: 0.9, addressed: true, complete: true, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: null, reviewAgentProbabilities: {}, retryAgent: null, retryAgentProbabilities: {} }),
      },
      execute: async () => ({ stopReason: 'completed', answerText: 'done', diagnostic: null }),
      // The production history object omitted records() for a whole session, which silently
      // disabled trackRecord: no cost tier, no track record and no off-peak price ever
      // reached Jev, and nothing failed. This asserts the prior is really delivered.
      history: {
        recent: async () => [],
        append: async () => {},
        records: async () => [{ workspace: dir, finalStatus: 'accepted', routing: { taskType: 'implementation' }, attempts: [{ agent: 'deepseek', role: 'primary', durationMs: 9000 }] }],
      },
      logAttempt: async () => {},
    },
  })
  assert.ok(state?.trackRecord, 'Jev was given the track record')
  assert.equal(state.trackRecord.claude.cost_tier, 'subscription')
  assert.equal(state.trackRecord.deepseek.cost_tier, 'api')
  assert.match(state.trackRecord.deepseek.price_now, /rate/, 'the time-of-day price reached Jev')
  assert.equal(state.trackRecord.deepseek.overall.attempts, 1, 'the history prior reached Jev')
})

test('a metered key is re-read after each attempt, not only at routing time', async () => {
  const dir = repo()
  const seen = []
  const events = []
  // The key drops below its soft tier during the run. Reported on the first re-check so the
  // test does not depend on how many times the router happens to choose this agent.
  let call = 0
  await runRouted({
    task: 'a long job',
    cwd: dir,
    config: baseConfig({ limits: { maxAttempts: 4, maxReviews: 1, maxRounds: 5 } }),
    signal,
    deps: {
      emit: (e) => events.push(e),
      quota: { claude: q('subscription', 10), codex: q('subscription', 10), deepseek: { state: 'ok', until: null, kind: 'api', weeklyPercent: null } },
      jev: {
        route: async () => ({ primaryAgent: 'deepseek', agentProbabilities: { deepseek: 0.9, claude: 0.5 }, taskType: 'implementation', complexity: 0.3, risk: 0.3, secondOpinion: 0.1, humanReview: 0.1, needsTests: 0.1, toolFit: {} }),
        assess: async () => ({ verdict: 'retry', quality: 0.2, addressed: false, complete: false, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: null, reviewAgentProbabilities: {}, retryAgent: null, retryAgentProbabilities: {} }),
      },
      checkBalance: async (id) => (id === 'deepseek' ? (call++, { state: 'near', balance: { amount: 8, currency: 'CNY' }, until: null }) : null),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  const balance = events.filter((e) => e.type === 'balance')
  assert.ok(balance.length >= 1, 'the drop was noticed mid-run and reported')
  assert.ok(balance.some((e) => e.state === 'near'), 'the soft tier was announced')
  assert.equal(seen[0], 'deepseek')
  assert.ok(call >= 1, 'the key was re-read after the attempt, not only at routing time')
})

test('a key that falls below its floor mid-run hands the task over', async () => {
  const dir = repo()
  const seen = []
  const events = []
  await runRouted({
    task: 'a long job',
    cwd: dir,
    config: baseConfig({ limits: { maxAttempts: 4, maxReviews: 1, maxRounds: 5 } }),
    signal,
    deps: {
      emit: (e) => events.push(e),
      quota: { claude: q('subscription', 10), codex: q('subscription', 10), deepseek: { state: 'ok', until: null, kind: 'api', weeklyPercent: null } },
      jev: {
        route: async () => ({ primaryAgent: 'deepseek', agentProbabilities: { deepseek: 0.9 }, taskType: 'implementation', complexity: 0.3, risk: 0.3, secondOpinion: 0.1, humanReview: 0.1, needsTests: 0.1, toolFit: {} }),
        assess: async () => ({ verdict: 'accept', quality: 0.9, addressed: true, complete: true, unrelatedChanges: false, regressionRisk: false, needsPerson: false, reviewAgent: null, reviewAgentProbabilities: {}, retryAgent: null, retryAgentProbabilities: {} }),
      },
      // Below minBalance the moment the first attempt ends.
      checkBalance: async (id) => (id === 'deepseek' ? { state: 'stopped', balance: { amount: 2, currency: 'CNY' }, until: null } : null),
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.equal(seen[0], 'deepseek')
  assert.ok(events.some((e) => e.type === 'balance' && e.state === 'stopped'), 'the floor was announced')
  // The same path a usage limit takes: the handoff is written and someone else continues,
  // rather than the run stopping dead or carrying on spending.
  assert.ok(events.some((e) => e.type === 'limit' || e.type === 'handoff'), 'it handed over')
  assert.ok(seen.slice(1).every((id) => id !== 'deepseek'), 'the spent key is not used again')
})

test('a re-check that fails never stops the run', async () => {
  const dir = repo()
  const seen = []
  const r = await runRouted({
    task: 'do a thing',
    cwd: dir,
    config: baseConfig(),
    signal,
    deps: {
      quota: { claude: q('subscription', 10), codex: q('subscription', 10), deepseek: { state: 'ok', until: null, kind: 'api', weeklyPercent: null } },
      jev: null,
      jevUnavailableReason: 'no key',
      forceAgentless: true,
      checkBalance: async () => { throw new Error('balance endpoint down') },
      execute: async (a) => { seen.push(a.id); return { stopReason: 'completed', answerText: 'done', diagnostic: null } },
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      logAttempt: async () => {},
    },
  })
  assert.ok(seen.length >= 1, 'the run carried on despite the check failing')
  assert.ok(r.finalStatus, 'it reached a verdict')
})

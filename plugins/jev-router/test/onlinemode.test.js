// Jev Auto - Online: the mirror of local-only. Jev still routes, but only over the cloud and
// subscription agents, so nothing waits on this PC's own hardware.
//
// The interesting part is not the filter, it is the PRECEDENCE. `offline` and `localOnly` are
// statements about what this machine CAN do; `remoteOnly` is only a preference about what it
// SHOULD use. So the two restrictions win, and a dead network reports the offline restriction
// rather than handing back an empty agent pool with no explanation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRouted } from '../router.js'
import { eligible } from '../capabilities.js'

const signal = new AbortController().signal

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-online-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  return dir
}

const CLOUD = [
  { id: 'claude', provider: 'claude-code', description: 'subscription', enabled: true },
  { id: 'deepseek', provider: 'spawn', description: 'api', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
]
const LOCAL = [{ id: 'qwen-local', kind: 'local', provider: 'spawn', description: 'local', enabled: true }]

const config = (agents) => ({
  agents,
  tools: [],
  limits: { maxAttempts: 2, maxReviews: 2, maxRounds: 2 },
  thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
  productionWorkspaces: [],
  agentTimeoutMs: 20_000,
  checks: {},
  effort: {},
})

/** One run. Returns the agent ids Jev was offered, plus the run record. */
async function run({ agents = [...CLOUD, ...LOCAL], deps: extra = {} } = {}) {
  const dir = repo()
  let offered = null
  const r = await runRouted({
    task: 'fix it',
    cwd: dir,
    config: config(agents),
    signal,
    deps: {
      jev: {
        route: async (req) => {
          offered = req.agents.map((a) => a.id)
          return { primaryAgent: req.agents[0].id, agentProbabilities: { [req.agents[0].id]: 0.9 }, taskType: 'fix', taskTypeConfidence: 0.9, complexity: 0.2, risk: 0.2 }
        },
        assess: async () => ({}),
      },
      review: async () => ({ status: 'accepted', action: 'accept', quality: 0.9 }),
      execute: async () => ({ stopReason: 'completed', answerText: 'done', diagnostic: null }),
      history: { recent: async () => [], records: async () => [], append: async () => {} },
      ...extra,
    },
  })
  return { offered, r }
}

test('online only: Jev is offered the cloud agents and never a local model', async () => {
  const { offered, r } = await run({ deps: { remoteOnly: true } })
  assert.deepEqual(offered, ['claude', 'deepseek'])
  assert.equal(offered.includes('qwen-local'), false)
  assert.equal(r.routing.mode, 'jev', 'online still routes through Jev, it only narrows the pool')
})

test('online only: the pool is unrestricted without it, so the filter is doing the work', async () => {
  const { offered } = await run()
  assert.deepEqual(offered, ['claude', 'deepseek', 'qwen-local'])
})

test('offline beats online only: a dead network cannot be answered with a cloud agent', async () => {
  // jev is null offline, so the fixed rule picks and `offered` stays null. The point is that the
  // run lands on the LOCAL agent rather than failing with an empty pool.
  const { r } = await run({ deps: { remoteOnly: true, offline: true, jev: null, jevUnavailableReason: 'offline' } })
  assert.equal(r.routing.mode, 'offline')
  assert.equal(r.routing.primaryAgent, 'qwen-local')
})

test('local only beats online only, the same way and for the same reason', async () => {
  const { offered } = await run({ deps: { remoteOnly: true, localOnly: true } })
  assert.deepEqual(offered, ['qwen-local'])
})

test('online only with no cloud agent says so, and names the way out', async () => {
  // The failure a person will actually hit: they pick Online on a machine where only a local
  // model is set up. An empty pool with a generic "no agent" message would send them hunting.
  await assert.rejects(
    run({ agents: LOCAL, deps: { remoteOnly: true } }),
    (e) => /online only/.test(e.message) && /Jev setup/.test(e.message),
  )
})

test('locality hosted is understood by eligible, not silently ignored', async () => {
  // The whole mode rests on this one line. `locality` accepts 'local' or 'hosted'; an unknown
  // string filters nothing and would read as "no restriction", which is why the router must not
  // invent a third word for it.
  const executors = [
    { id: 'local-1', capabilities: ['code'], modalities: ['text'], mutation: true, locality: 'local', network: false, credentials: [], maxInputBytes: null },
    { id: 'cloud-1', capabilities: ['code'], modalities: ['text'], mutation: true, locality: 'hosted', network: true, credentials: [], maxInputBytes: null },
  ]
  assert.deepEqual(eligible(executors, { locality: 'hosted' }).map((e) => e.id), ['cloud-1'])
  assert.deepEqual(eligible(executors, { locality: 'local' }).map((e) => e.id), ['local-1'])
  assert.deepEqual(eligible(executors, {}).map((e) => e.id), ['local-1', 'cloud-1'])
})

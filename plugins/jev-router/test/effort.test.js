// Unified effort ladder -> each agent's accepted values, clamping, precedence, and the Jev Auto menu.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoLevel, codexServiceTier, toAgentEffort } from '../effort.js'
import { jevAdapter } from '../adapter.js'
import { answeredBy, runRouted } from '../router.js'

const claude = { id: 'claude', provider: 'claude-code' }
const codex = { id: 'codex', provider: 'codex' }
const ds = { id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek', model: 'deepseek-flash' } }
const local = { id: 'local', provider: 'spawn', kind: 'local', llm: { provider: 'local', model: 'qwen' } }
const other = { id: 'kimi', provider: 'spawn', llm: { provider: 'moonshot', model: 'k2' } }

test('mapping table', () => {
  const table = Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((l) => [l, [claude, codex, ds, local, other].map((a) => toAgentEffort(l, a))]))
  assert.deepEqual(table, {
    low: ['low', 'low', 'low', null, null],
    medium: ['medium', 'medium', 'high', null, null],
    high: ['high', 'high', 'high', null, null],
    xhigh: ['xhigh', 'xhigh', 'max', null, null],
    max: ['max', 'xhigh', 'max', null, null],
    ultra: ['max', 'xhigh', 'max', null, null],
  })
})

test('auto follows complexity/risk and never picks ultra', () => {
  assert.equal(autoLevel({ complexity: 0.1, risk: 0.2 }), 'medium')
  assert.equal(autoLevel({ complexity: 0.1, risk: 0.5 }), 'high')
  assert.equal(autoLevel({ complexity: 0.9, risk: 0.1 }), 'xhigh')
  assert.equal(autoLevel({}), 'high')
  assert.equal(toAgentEffort('auto', codex, { complexity: 0.99, risk: 0.99 }), 'xhigh')
  assert.equal(toAgentEffort(undefined, ds, { complexity: 0.1, risk: 0.1 }), 'high')
})

test('codex clamps to the model top effort; speed maps to the priority tier', () => {
  assert.equal(toAgentEffort('ultra', codex, { model: 'gpt-5.5' }), 'xhigh')
  assert.equal(toAgentEffort('ultra', codex, { model: 'gpt-5.6-luna' }), 'max')
  assert.equal(toAgentEffort('ultra', codex, { model: 'gpt-5.6-sol' }), 'ultra')
  assert.equal(codexServiceTier('fast'), 'priority')
  assert.equal(codexServiceTier('normal'), null)
})

test('per-agent override wins over level', () => {
  assert.equal(toAgentEffort('max', ds, { override: 'off' }), 'off')
  assert.equal(toAgentEffort('low', claude, { override: 'xhigh' }), 'xhigh')
})

test('adapter declares efforts and forwards the chosen one', async () => {
  let got
  const a = jevAdapter({ ctx: { agents: { get: () => ({}) } }, route: async ({ effort }) => { got = effort; return 'r' }, auxModel: { provider: 'x', model: 'y' } })
  const m = await a.resolveModel('jev', 'jev-auto')
  assert.equal(m.reasoning.defaultEffort, 'auto')
  assert.deepEqual(m.reasoning.efforts.map((e) => e.id), ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'fix it' }] }], reasoningEffort: 'xhigh', sessionId: 's' })) { /* drain */ }
  assert.equal(got, 'xhigh')
})

test('router: menu beats default, per-agent beats menu; effort shows in Answered by', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-effort-'))
  writeFileSync(join(dir, 'a.txt'), 'x')
  const g = (...x) => execFileSync('git', x, { cwd: dir })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i')
  const seen = []
  const config = {
    agents: [{ ...claude, enabled: true, description: 'a' }, { ...ds, enabled: true, description: 'b' }],
    fallbackAgent: 'claude', agentTimeoutMs: 60_000,
    limits: { maxAttempts: 1, maxReviews: 0, maxRounds: 1 },
    thresholds: { accept: { low: 0.55, medium: 0.7, high: 0.85 }, secondOpinion: 0.6, humanReview: 0.7, needsTests: 0.5, tool: 0.5 },
    checks: { enabled: false, scripts: [] }, productionWorkspaces: [],
    effort: { default: 'low', perAgent: {}, codexSpeed: 'normal' },
  }
  const run = (effort, cfg = config) => runRouted({ task: 't', cwd: dir, forceAgent: 'claude', effort, config: cfg, deps: { jev: null, execute: async (_a, _p, _s, o) => { seen.push(o.effort); return { stopReason: 'completed', answerText: 'ok' } }, modelOf: () => 'opus', history: { recent: async () => [], append: async () => {} } } })
  await run(undefined); await run('auto'); await run('high')
  const r = await run('high', { ...config, effort: { ...config.effort, perAgent: { claude: 'max' } } })
  assert.deepEqual(seen, ['low', 'low', 'high', 'max'])
  assert.match(answeredBy(r), /claude \(opus, max\)/)
})

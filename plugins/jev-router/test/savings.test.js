// "Saved by Jev" estimate: decision math, agent median, direct answers, tool runs, limits, periods.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSavings, createUsage } from '../usage.js'

const now = new Date(2026, 8, 20, 15, 0, 0).getTime() // local 15:00
const at = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString()
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)
const baseline = { name: 'test LLM', inputPerMTok: 1, outputPerMTok: 2, outputTokens: 100, latencyMs: 4000 }

const usage = [
  // today: two decisions, one with logged ms, one without (800 ms assumed)
  { ts: at(1), agent: 'jev', phase: 'route', ms: 1000, tokens: { input: 10_000, output: 5 }, costUsd: 10_000 * 0.042 / 1e6 },
  { ts: at(2), agent: 'jev', phase: 'intent', tokens: { input: 1_000, output: 1 }, costUsd: 1_000 * 0.042 / 1e6 },
  // today: a direct answer taking 2 s
  { ts: at(2), agent: 'chat', role: 'direct-answer', durationMs: 2000 },
  // 3 days ago: completed primary attempts 20 s, 40 s, 60 s -> median 40 s; the failed one and the review do not count
  { ts: at(72), agent: 'claude', role: 'primary', stopReason: 'completed', durationMs: 20_000 },
  { ts: at(72), agent: 'codex', role: 'primary', stopReason: 'completed', durationMs: 60_000 },
  { ts: at(72), agent: 'codex', role: 'primary', stopReason: 'completed', durationMs: 40_000 },
  { ts: at(72), agent: 'codex', role: 'primary', stopReason: 'error', durationMs: 1 },
  { ts: at(72), agent: 'claude', role: 'review', stopReason: 'completed', durationMs: 999_000 },
  // 30 days ago: one decision, only in "all"
  { ts: at(24 * 30), agent: 'jev', phase: 'review', ms: 5000, tokens: { input: 0, output: 0 }, costUsd: 0 },
]
const runs = [
  // today: tool accepted, 1 s
  { ts: at(1), attempts: [{ agent: 'tool:fmt', role: 'tool', durationMs: 1000 }], finalStatus: 'accepted', limits: [], availability: { out: [] } },
  // today: tool rejected, escalated to an agent: no tool saving
  { ts: at(1), attempts: [{ role: 'tool', durationMs: 1000 }, { role: 'primary', durationMs: 5000 }], finalStatus: 'accepted', limits: [], availability: { out: [] } },
  // 3 days ago: codex skipped at routing, claude hit a limit -> peer, deepseek rotated a key: 3 saves
  { ts: at(72), attempts: [], finalStatus: 'accepted', limits: [{ agent: 'claude', action: 'peer' }, { agent: 'deepseek', action: 'rotated' }], availability: { out: [{ id: 'codex' }, { id: 'claude' }] } },
  // paused run: nothing avoided
  { ts: at(72), attempts: [], finalStatus: 'paused_limit', limits: [{ agent: 'claude', action: 'paused' }], availability: { out: [{ id: 'claude' }] } },
]

test('decisions: LLM cost vs Jev cost, time, tokens', () => {
  const { periods: { today } } = computeSavings(usage, runs, { baseline }, now)
  assert.equal(today.decisions, 2)
  // LLM: (10000*1 + 100*2)/1e6 + (1000*1 + 100*2)/1e6 = 0.0102 + 0.0012
  close(today.llmCostUsd, 0.0114)
  close(today.jevCostUsd, 11_000 * 0.042 / 1e6)
  close(today.savedUsd, 0.0114 - 11_000 * 0.042 / 1e6)
  assert.equal(today.llmOutputTokensAvoided, 200)
  assert.deepEqual(today.jevTokens, { input: 11_000, output: 6 })
  // time: (4000-1000) + (4000-800) + direct (40000-2000) + tool (40000-1000)
  assert.equal(today.savedMs, 3000 + 3200 + 38_000 + 39_000)
  assert.equal(today.directAnswers, 1)
  assert.equal(today.toolRuns, 1)
  assert.equal(today.limitsAvoided, 0)
})

test('periods and limits avoided', () => {
  const { periods, assumptions } = computeSavings(usage, runs, { baseline }, now)
  assert.equal(assumptions.agentMedianMs, 40_000)
  assert.equal(assumptions.agentMedianSamples, 3)
  assert.equal(periods.week.decisions, 2)
  assert.equal(periods.week.limitsAvoided, 3)
  assert.equal(periods.all.decisions, 3)
  // the old decision: 4000 - 5000 ms and $0 Jev -> negative time, shown as is
  assert.equal(periods.all.savedMs, periods.week.savedMs - 1000)
  close(periods.all.llmCostUsd, 0.0114 + 200 / 1e6)
})

test('no agent history: fallback median; a slow Jev shows a negative saving', () => {
  const s = computeSavings([
    { ts: at(1), agent: 'jev', ms: 9000, tokens: { input: 0, output: 0 }, costUsd: 0 },
    { ts: at(1), agent: 'chat', role: 'direct-answer', durationMs: 3000 },
  ], [], { baseline, agentMedianFallbackMs: 10_000 }, now)
  assert.equal(s.assumptions.agentMedianMs, 10_000)
  assert.equal(s.assumptions.agentMedianSamples, 0)
  assert.equal(s.periods.today.savedMs, (4000 - 9000) + (10_000 - 3000))
})

// ---------------------------------------------------------------- only what Jev decided

// Two acting Laya calls of a Laya Auto run, as usage.logDecision writes them.
const LAYA_ROWS = [
  { ts: at(1), agent: 'laya', runId: 'l1', phase: 'route', ms: 950, model: 'laya-english/0.3.20@1a2b3c4', tokens: { input: 5610, output: 0 }, costUsd: 0 },
  { ts: at(1), agent: 'laya', runId: 'l1', phase: 'review', ms: 600, model: 'laya-english/0.3.20@1a2b3c4', tokens: { input: 3000, output: 0 }, costUsd: 0 },
]

test('a Laya decision is no Jev decision: never priced or timed in "Saved by Jev", and counted on its own line', () => {
  const plain = computeSavings(usage, runs, { baseline }, now)
  const withLaya = computeSavings([...usage, ...LAYA_ROWS], runs, { baseline }, now)
  for (const period of ['today', 'week', 'all']) {
    const { layaDecisions: _a, layaTokens: _b, ...after } = withLaya.periods[period]
    const { layaDecisions: _c, layaTokens: _d, ...before } = plain.periods[period]
    assert.deepEqual(after, before, `${period}: Saved by Jev did not move`)
  }
  assert.deepEqual(withLaya.assumptions, plain.assumptions, 'nor the agent median')
  assert.equal(withLaya.periods.today.layaDecisions, 2)
  assert.deepEqual(withLaya.periods.today.layaTokens, { input: 8610, output: 0 })
  assert.equal(plain.periods.all.layaDecisions, 0)
  assert.deepEqual(plain.periods.all.layaTokens, { input: 0, output: 0 })
})

test('a direct answer counts only when Jev sorted the message, and one from before `decider` counts as today', () => {
  const rows = [
    { ts: at(1), agent: 'chat', role: 'direct-answer', durationMs: 2000 },
    { ts: at(1), agent: 'chat', role: 'direct-answer', durationMs: 2000, decider: 'jev' },
    { ts: at(1), agent: 'chat', role: 'direct-answer', durationMs: 2000, decider: 'laya' },
  ]
  const { periods: { today } } = computeSavings(rows, [], { baseline, agentMedianFallbackMs: 10_000 }, now)
  assert.equal(today.directAnswers, 2)
  assert.equal(today.savedMs, 2 * (10_000 - 2000))
})

test('a Laya Auto run that ran a tool or skipped a limited agent saves nothing by Jev; a run from before `decider` counts as today', () => {
  const tool = (routing) => ({ ts: at(1), routing, attempts: [{ agent: 'tool:fmt', role: 'tool', durationMs: 1000 }], finalStatus: 'accepted', limits: [], availability: { out: [] } })
  // One limit moved to a peer: one limit avoided.
  const limited = (routing) => ({ ts: at(1), routing, attempts: [], finalStatus: 'accepted', limits: [{ agent: 'claude', action: 'peer' }], availability: { out: [{ id: 'claude' }] } })
  const history = [tool(undefined), tool({ mode: 'jev', decider: 'jev' }), tool({ mode: 'jev', decider: 'laya' }), limited({ mode: 'jev' }), limited({ decider: 'jev' }), limited({ decider: 'laya' })]
  const { periods: { today } } = computeSavings([], history, { baseline, agentMedianFallbackMs: 10_000 }, now)
  assert.equal(today.toolRuns, 2)
  assert.equal(today.limitsAvoided, 2)
  assert.equal(today.savedMs, 2 * (10_000 - 1000))
})

test('createUsage().savings reads usage.jsonl and history.jsonl with default baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-save-'))
  writeFileSync(join(dir, 'usage.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), agent: 'jev', tokens: { input: 1_000_000, output: 3 }, costUsd: 0.042 })}\nnot json\n`)
  writeFileSync(join(dir, 'history.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), attempts: [{ role: 'tool', durationMs: 0 }], finalStatus: 'accepted_pending_human_review' })}\n`)
  const s = await createUsage({ dataDir: dir, accounts: {} }).savings()
  assert.equal(s.assumptions.name, 'Chat LLM front desk (DeepSeek Flash)')
  const all = s.periods.all
  close(all.llmCostUsd, 0.28 + 300 * 1.1 / 1e6)
  close(all.savedUsd, 0.28 + 300 * 1.1 / 1e6 - 0.042)
  assert.equal(all.toolRuns, 1)
})

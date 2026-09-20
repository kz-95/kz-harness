// Quota state, limit detection, snapshot over injected fetch/spawn, Jev cost log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccounts } from '../accounts.js'
import { codexRpc, createUsage, creditPercent, detectLimit, longWindowPercent, stateOf } from '../usage.js'

const sub = { handoffAtPercent: 85, stopAtPercent: 97 }
const soon = () => new Date(Date.now() + 60_000).toISOString()

test('stateOf: near, stopped, exhausted, unknown', () => {
  const w = (p) => [{ name: '5h', usedPercent: 10, resetsAt: null }, { name: 'weekly', usedPercent: p, resetsAt: '2026-09-23T06:00:00.000Z' }]
  assert.equal(stateOf({ kind: 'subscription', windows: w(50), limits: sub }).state, 'ok')
  assert.equal(stateOf({ kind: 'subscription', windows: w(87), limits: sub }).state, 'near')
  assert.deepEqual(stateOf({ kind: 'subscription', windows: w(97), limits: sub }), { state: 'stopped', until: '2026-09-23T06:00:00.000Z' })
  assert.equal(stateOf({ kind: 'subscription', windows: [], limits: sub, error: 'HTTP 429' }).state, 'unknown')
  assert.equal(stateOf({ kind: 'subscription', windows: w(10), limits: sub, exhausted: { until: soon() } }).state, 'exhausted')
  assert.equal(stateOf({ kind: 'subscription', windows: w(10), limits: sub, exhausted: { until: '2000-01-01T00:00:00Z' } }).state, 'ok')
  assert.equal(stateOf({ kind: 'api', balance: { amount: 0.2 }, limits: { minBalance: 0.5 } }).state, 'stopped')
  assert.equal(stateOf({ kind: 'api', balance: { amount: 3 }, limits: { minBalance: 0.5 } }).state, 'ok')
  assert.equal(stateOf({ kind: 'api', balance: null, limits: { minBalance: 0.5 }, error: 'timeout' }).state, 'unknown')
})

test('detectLimit: real limit errors per executor, never a completed answer', () => {
  const claude = { provider: 'claude-code' }; const codex = { provider: 'codex' }; const ds = { provider: 'spawn' }
  assert.deepEqual(detectLimit(claude, { stopReason: 'error', diagnostic: 'Claude AI usage limit reached|1789852376' }), { hit: true, until: new Date(1789852376000).toISOString() })
  assert.equal(detectLimit(claude, { stopReason: 'error', diagnostic: 'rate_limit_error' }).hit, true)
  assert.equal(detectLimit(claude, { stopReason: 'completed', answerText: 'added rate limit middleware' }).hit, false)
  assert.equal(detectLimit(codex, { stopReason: 'error', diagnostic: 'Error: subagent-codex: Codex turn ended with status failed: limit' }).hit, true)
  assert.equal(detectLimit(codex, { stopReason: 'error', diagnostic: 'status failed: service' }).hit, false)
  assert.equal(detectLimit(ds, { stopReason: 'error', diagnostic: 'LlmError QUOTA: Insufficient Balance' }).hit, true)
  assert.equal(detectLimit(ds, { stopReason: 'error', diagnostic: 'HTTP 402 Payment Required' }).hit, true)
  assert.equal(detectLimit(ds, { stopReason: 'error', diagnostic: 'ECONNRESET' }).hit, false)
})

test('codexRpc: initialize -> initialized -> requests over newline JSON-RPC', async () => {
  const sent = []
  const fake = () => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter()
    const reply = (m) => setImmediate(() => c.stdout.emit('data', `${JSON.stringify(m)}\n`))
    c.stdin = { write: (l) => { const m = JSON.parse(l); sent.push(m.method); if (m.id === 0) reply({ id: 0, result: {} }); else if (m.id) reply({ id: m.id, result: { method: m.method } }) }, end() {} }
    c.kill = () => {}
    return c
  }
  const r = await codexRpc([['account/rateLimits/read'], ['account/read', {}]], { spawn: fake })
  assert.deepEqual(sent, ['initialize', 'initialized', 'account/rateLimits/read', 'account/read'])
  assert.equal(r['account/read'].method, 'account/read')
})

test('snapshot: per-key DeepSeek balances, agent ok while any key is usable, OMC cache for Claude, Jev spend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-use-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude', 'plugins', 'oh-my-claudecode'), { recursive: true })
  writeFileSync(join(home, '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'), JSON.stringify({ timestamp: Date.now(), data: { fiveHourPercent: 40, fiveHourResetsAt: soon(), weeklyPercent: 90, weeklyResetsAt: soon() } }))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, 'KZ_KEY__deepseek__a=sk-a\nKZ_KEY__deepseek__b=sk-b\n')
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ keys: { deepseek: [{ name: 'a', active: true }, { name: 'b', active: false }], jev: [{ name: 'j1', active: true }] } }))
  const accounts = createAccounts({ dataDir: dir, envFile, run: async () => ({ ok: true, out: '{"loggedIn":true,"email":"me@x"}' }) })
  const calls = []
  const fetch = async (url, { headers }) => {
    calls.push(url)
    const amount = headers.authorization === 'Bearer sk-a' ? '0.10' : '5.00'
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: amount }] }) }
  }
  const usage = createUsage({ dataDir: dir, accounts, fetch, home })
  await usage.logJev({ runId: 'r', account: 'j1', phase: 'route', tokens: { input: 1_000_000, output: 10 } })
  const agents = [
    { id: 'claude', provider: 'claude-code' },
    { id: 'deepseek', provider: 'spawn', llm: { provider: 'deepseek' } },
  ]
  const s = await usage.snapshot(agents)
  assert.equal(s.claude.state, 'near')
  assert.equal(s.claude.account.email, 'me@x')
  assert.ok(!calls.some((u) => u.includes('anthropic')), 'fresh OMC cache: no call to the private endpoint')
  assert.equal(s.deepseek.state, 'ok')
  assert.deepEqual(usage.last().keys.deepseek.map((k) => k.state), ['stopped', 'ok'])
  assert.ok(Math.abs(s.jev.spentUsd - 0.042) < 1e-9)
  await usage.snapshot(agents)
  assert.equal(calls.length, 2, 'balances cached')
  await accounts.markExhausted('deepseek:b', { until: soon(), reason: '402' })
  assert.equal((await usage.snapshot(agents)).deepseek.state, 'stopped')
  const line = (await usage.recent(1))[0]
  assert.equal(line.agent, 'jev')
  assert.ok(!JSON.stringify(await usage.recent()).includes('sk-'))
})

test('creditPercent: a balance as a share of the most that key ever held', () => {
  const cny = (n) => ({ amount: n, currency: 'CNY' })
  assert.equal(creditPercent(cny(363.82), cny(400)), 91)
  assert.equal(creditPercent(cny(400), cny(400)), 100, 'a fresh top-up reads full')
  assert.equal(creditPercent(cny(0), cny(400)), 0)
  // A balance above the mark is clamped; notePeakBalance raises the mark on the next read.
  assert.equal(creditPercent(cny(500), cny(400)), 100)
  // Nothing to compare against, or comparing across currencies, says nothing at all.
  assert.equal(creditPercent(cny(10), null), null)
  assert.equal(creditPercent(null, cny(400)), null)
  assert.equal(creditPercent(cny(10), { amount: 400, currency: 'USD' }), null, 'never compare CNY against USD')
  assert.equal(creditPercent(cny(10), cny(0)), null, 'a zero mark is no mark')
})

test('longWindowPercent: the rationed window, found by duration not by label', () => {
  const w = (name, minutes, usedPercent) => ({ name, minutes, usedPercent })
  assert.equal(longWindowPercent([w('5h', 300, 19), w('weekly', 10080, 3)]), 3)
  // A relabelled window must not switch the gate off: duration decides.
  assert.equal(longWindowPercent([w('5h', 300, 19), w('secondary', 10080, 97)]), 97)
  // Sub-day windows are not the resource the policy rations.
  assert.equal(longWindowPercent([w('5h', 300, 99)]), null)
  assert.equal(longWindowPercent([w('primary', 60, 99)]), null)
  // Unknown is null, never 0: 0 would read as "plenty left" and is the expensive mistake.
  assert.equal(longWindowPercent([]), null)
  assert.equal(longWindowPercent(undefined), null)
  assert.equal(longWindowPercent([{ name: 'weekly', minutes: 10080 }]), null, 'no percent means unknown')
  assert.equal(longWindowPercent([w('weekly', 10080, 0)]), 0, 'a real zero is still zero')
  // Two long windows: the longer one wins.
  assert.equal(longWindowPercent([w('daily', 1440, 50), w('weekly', 10080, 10)]), 10)
})

// The switch for read-only work (docs/queue-and-cost-findings.md 1): the decider's readOnly answer
// at intake becomes a verdict against the answering provider's own bar, rides with the task to
// the queue, and the chat and live lines say what it means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as adapter from '../adapter.js'

const { jevAdapter, line, queuedLine } = adapter
const aux = { provider: 'x', model: 'y' }
const chat = () => ({ agents: { get: () => ({}) }, llm: { async *stream() {} } })
const runAs = async (a, model, text) => {
  const chunks = []
  for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], sessionId: 's', model, signal: new AbortController().signal })) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}
const records = async () => (await import('../providers.js')).resolveProviders({}, { policy: (await import('../routing-policy.js')).resolvePolicy() })
const AGENTS = [{ id: 'claude', name: 'Claude Code', description: 'a', enabled: true }]

test('a task the decider reads as only reading at or over its own bar is queued with that verdict; under it, flat, unsure, offline, forced or unanswered it is queued with none', async () => {
  assert.equal(typeof adapter.readOnlyVerdict, 'function', 'adapter.js has no readOnlyVerdict')
  const { jev, laya } = await records()
  const v = adapter.readOnlyVerdict
  // Jev 0.85 clears its 0.8; Laya 0.85 does not clear its 0.9.
  assert.deepEqual(v({ kind: 'task', readOnly: 0.85, thresholds: jev.thresholds }, 'jev'), { p: 0.85, bar: 0.8, by: 'jev', reads: true })
  assert.deepEqual(v({ kind: 'task', readOnly: 0.85, thresholds: laya.thresholds }, 'laya'), { p: 0.85, bar: 0.9, by: 'laya', reads: false })
  assert.deepEqual(v({ kind: 'task', readOnly: 0.8, thresholds: jev.thresholds }, 'jev').reads, true, 'at the bar reads')
  assert.deepEqual(v({ kind: 'task', readOnly: 0.95, uninformative: ['readOnly'], thresholds: laya.thresholds }, 'laya'), { p: 0.95, bar: 0.9, by: 'laya', reads: false, flat: true })
  for (const [why, cls] of [
    ['unsure', { kind: 'task', unsure: true, readOnly: 0.99, thresholds: laya.thresholds }],
    ['offline', { kind: 'task', offline: true, readOnly: 0.99, thresholds: jev.thresholds }],
    ['unanswered', { kind: 'task', thresholds: jev.thresholds }],
    ['not a number', { kind: 'task', readOnly: '0.9', thresholds: jev.thresholds }],
    ['no bar', { kind: 'task', readOnly: 0.99, thresholds: {} }],
    ['nothing asked', null],
  ]) assert.equal(v(cls, 'jev'), null, why)

  // Through the adapter: what the orchestrator is handed.
  const queued = []
  const make = (cls) => jevAdapter({
    ctx: chat(), auxModel: aux, agents: async () => AGENTS, route: async () => 'unused',
    classify: async () => cls,
    orchestrator: { results: () => [], live: () => 0, enqueue: (fields, extra) => { queued.push(extra); return 'queued' } },
  })
  await runAs(make({ kind: 'task', readOnly: 0.85, thresholds: jev.thresholds }), 'jev-auto', 'how does the parser work?')
  await runAs(make({ kind: 'task', readOnly: 0.85, thresholds: laya.thresholds }), 'laya-auto', 'how does the parser work?')
  await runAs(make({ kind: 'task', readOnly: 0.99, thresholds: jev.thresholds }), 'agent-claude', 'how does the parser work?')
  assert.deepEqual(queued.map((q) => q.readVerdict), [
    { p: 0.85, bar: 0.8, by: 'jev', reads: true },
    { p: 0.85, bar: 0.9, by: 'laya', reads: false },
    null,
  ], 'a forced agent asks nothing, so it has no verdict')
})

test('the chat line says a read task runs locked beside work that writes, with who judged it and the bar, and why when no agent can be locked', () => {
  const base = { jobId: 'jev-5', agent: null, wait: null, workspace: 'C:/work/jev-router-test' }
  const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
  assert.equal(
    queuedLine({ ...base, access: { mode: 'read', verdict } }),
    'Queued → Jev picks as **jev-5** (starting now in jev-router-test). Keep chatting: the result posts here when done. Read only: Jev judged it only reads the project (93%, its bar is 80%), so it runs on an agent locked against writing, beside any task changing jev-router-test.',
  )
  assert.equal(
    queuedLine({ ...base, access: { mode: 'write', verdict, why: 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)' } }),
    'Queued → Jev picks as **jev-5** (starting now in jev-router-test). Keep chatting: the result posts here when done. Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing (codex: Codex cannot be locked through its provider), so it runs as work that writes, and a task changing jev-router-test waits for it.',
  )
  // One waiting only for a free slot does not wait for the folder.
  assert.match(queuedLine({ ...base, wait: { why: 'cap', place: 1, ahead: 0, slot: 1 }, access: { mode: 'write', verdict, why: 'no agent here can be locked against writing' } }), /so it runs as work that writes, and a task changing jev-router-test waits for it\.$/)
  // One that has to wait for the folder says so.
  assert.equal(
    queuedLine({ ...base, wait: { why: 'workspace', place: 2, ahead: 0 }, access: { mode: 'write', verdict, why: 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)' } }),
    'Queued → Jev picks as **jev-5** (2nd in line for jev-router-test: another task is running there). Keep chatting: the result posts here when done. Read only: Jev judged it only reads the project (93%, its bar is 80%), but no agent here can be locked against writing (codex: Codex cannot be locked through its provider), so it waits for jev-router-test like work that writes.',
  )
  // A verdict that does not read, and no verdict at all, say nothing more than today.
  const plain = queuedLine(base)
  assert.equal(queuedLine({ ...base, access: { mode: 'write', verdict: { ...verdict, p: 0.3, reads: false } } }), plain)
  assert.equal(queuedLine({ ...base, access: undefined }), plain)
  assert.match(queuedLine({ ...base, decider: 'laya', access: { mode: 'read', verdict: { p: 0.95, bar: 0.9, by: 'laya', reads: true } } }), /Read only: Laya judged it only reads the project \(95%, its bar is 90%\)/)
})

test('the access lines read as the report does', () => {
  assert.equal(line({ type: 'access', mode: 'read', verdict: { p: 0.93, bar: 0.8, by: 'jev', reads: true } }),
    'Read only (Jev 93%, bar 80%): runs on an agent locked against writing, beside any task changing this folder; no checks, review or handoff note')
  assert.equal(line({ type: 'access', mode: 'write', from: 'read', why: 'claude said it needs to change files: the parser' }),
    'Needs the folder after all: claude said it needs to change files: the parser. It waits its turn there and is decided again when it starts')
})

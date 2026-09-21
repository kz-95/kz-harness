// Overview ledger: grouping by turn, ordering, the run dedupe (a task owns its run, a durable
// record fills a live run rather than repeating it) and the explicit untimed bucket for subagents,
// which this engine never timestamps. All of it is pure data, so it runs without a DOM. client.js
// is a classic browser script - window.__ModuleLoader__.load({ id, factory }) - so the real file
// body runs as a function of `window`, its factory gets a fake `react`, and the pure helpers come
// back as `__test` (the same loader test/tasklist.test.js uses).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const {
  overviewText, conversationLedger, turnWindows, bucketFor, pairRuns,
  runLedgerRows, taskLedgerRows, jobLedgerRows, subagentLedgerRows, buildLedger, recordState,
} = loadPlugin().__test

const CONTEXT = { kind: 'context', seq: 1, time: 1000, content: [{ type: 'text', text: 'recall' }] }
const USER = { kind: 'user', seq: 2, time: 2000, content: [{ type: 'text', text: 'first question' }] }
const ASSISTANT = { kind: 'assistant', seq: 3, time: 2100, messageId: 'm1', blocks: [{ kind: 'text', text: 'first answer' }], timing: { stepStartTime: 2050, completedTime: 2100 } }
const TOOL = { kind: 'tool-result', seq: 4, time: 2200, call: { name: 'bash' }, content: 'ok' }
const USER2 = { kind: 'user', seq: 5, time: 5000, content: [{ type: 'text', text: 'second' }] }
const ASSISTANT2 = { kind: 'assistant', seq: 6, time: 5100, blocks: [{ kind: 'text', text: 'second answer' }] }
const COMPACT = { kind: 'compaction', seq: 7, time: 5200, summary: 'folded', shadowedItemCount: 42 }
const NO_TIME = { kind: 'assistant', seq: 8, blocks: [{ kind: 'text', text: 'late note' }] }

test('overview: node text reads both block shapes in the chat store', () => {
  assert.equal(overviewText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(overviewText([{ kind: 'text', text: 'c' }, { kind: 'tool' }]), 'c')
  assert.equal(overviewText(undefined), '')
})

test('overview: conversation rows keep seq order, open a turn per user message, and mark untimed rows', () => {
  const rows = conversationLedger([CONTEXT, USER, ASSISTANT, TOOL, USER2, ASSISTANT2, COMPACT, NO_TIME])
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8], 'seq order is preserved')
  assert.deepEqual(rows.map((r) => r.turn), [0, 1, 1, 1, 2, 2, 2, 2], 'a turn opens at each user message')
  assert.equal(rows[1].title, 'first question')
  assert.equal(rows[1].who, 'You')
  assert.equal(rows[2].kind, 'assistant')
  assert.equal(rows[2].durationMs, 50)
  assert.equal(rows[3].kind, 'tool')
  assert.equal(rows[3].who, 'bash')
  assert.equal(rows[6].kind, 'compaction')
  const last = rows.at(-1)
  assert.equal(last.at, null)
  assert.equal(last.untimed, true, 'a node with no time is marked untimed, never given one')
})

test('overview: turn windows bound a work row and send later work to the trailing bucket', () => {
  const windows = turnWindows(conversationLedger([CONTEXT, USER, ASSISTANT, TOOL, USER2, ASSISTANT2, COMPACT]))
  assert.deepEqual(windows.map((w) => [w.turn, w.start, w.endBound]), [[0, 1000, 2000], [1, 2000, 5000], [2, 5000, 5200]])
  assert.equal(bucketFor(windows, 1500), 0)
  assert.equal(bucketFor(windows, 2500), 1)
  assert.equal(bucketFor(windows, 4900), 1)
  assert.equal(bucketFor(windows, 5000), 2)
  assert.equal(bucketFor(windows, 5300), 'after', 'after the last turn is its own bucket')
  assert.equal(bucketFor(windows, 500), 'before')
  assert.equal(bucketFor(windows, null), 'untimed')
  assert.equal(bucketFor([], 500), 'after', 'no turns means everything trails')
})

test('overview: a durable record fills a live run instead of repeating it', () => {
  const live = [{ id: 'L1', startedAt: 10_000, task: 'fix bug', events: [] }]
  const records = [
    { runId: 'R1', ts: new Date(20_000).toISOString(), task: 'fix bug', attempts: [{ durationMs: 5000 }], finalStatus: 'accepted_pending_human_review' },
    { runId: 'R2', ts: new Date(60_000).toISOString(), task: 'other', attempts: [{ durationMs: 1000 }], finalStatus: 'needs_human' },
  ]
  const pairs = pairRuns(live, records)
  assert.equal(pairs.length, 2, 'the matched record does not make a third row')
  assert.equal(pairs[0].live.id, 'L1')
  assert.equal(pairs[0].record.runId, 'R1')
  assert.equal(pairs[0].id, 'R1', 'the pair takes the durable run id')
  assert.equal(pairs[1].live, null)
  assert.equal(pairs[1].id, 'R2')
  assert.ok(pairs[0].at <= pairs[1].at, 'oldest first')
  assert.equal(pairRuns([], []).length, 0)
})

test('overview: a task shadows its own run, and a jev job is a shadow too', () => {
  const liveTask = { jobId: 't1', sessionId: 's', state: 'running', runId: 'L1', startedAt: 1000, task: 'work' }
  const liveRows = taskLedgerRows([liveTask], 2000)
  const pairs = [{ id: 'R1', live: { id: 'L1', startedAt: 1000, task: 'work', events: [] }, record: null, at: 1000 }]
  assert.equal(runLedgerRows(pairs, liveRows).length, 0, 'the task owns this run through runId')
  assert.equal(runLedgerRows(pairs, []).length, 1)
  // A durable record never carries the inspector's run id, so it is shadowed by task text and start.
  const record = { runId: 'ROUTER-9', ts: new Date(2500).toISOString(), task: 'work', attempts: [{ durationMs: 1500 }] }
  const recTask = taskLedgerRows([{ jobId: 't2', sessionId: 's', state: 'completed', runId: 'L9', startedAt: 1000, task: 'work', durationMs: 1500 }], 3000)
  assert.equal(runLedgerRows([{ id: 'ROUTER-9', live: null, record, at: 1000 }], recTask).length, 0, 'the durable run its task owns is not repeated')
  assert.equal(runLedgerRows([{ id: 'ROUTER-9', live: null, record, at: 1000 }], []).length, 1)
  const jobs = [{ id: 'j1', kind: 'jev', status: 'running', startedAt: 1000 }, { id: 'j2', kind: 'bash', status: 'running', startedAt: 1100 }]
  const rows = jobLedgerRows(jobs, 2000)
  assert.deepEqual(rows.map((r) => r.key), ['job:j2'], 'only the non-shadow job shows')
})

test('overview: run rows read a durable record without reshaping it', () => {
  const record = { runId: 'R9', ts: new Date(9000).toISOString(), task: 'ship it', routing: { mode: 'manual', primaryAgent: 'claude' }, attempts: [{ agent: 'claude', role: 'primary', durationMs: 400, stopReason: 'completed' }], finalStatus: 'answered' }
  const rows = runLedgerRows([{ id: 'R9', live: null, record, at: 8600 }], [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].durationMs, 400)
  assert.equal(rows[0].who, 'claude')
  assert.equal(rows[0].status, 'done')
  assert.equal(rows[0].record, record, 'the stored record is handed on as it is')
})

test('overview: stored final statuses map to the four ledger states', () => {
  assert.equal(recordState('accepted'), 'done')
  assert.equal(recordState('accepted_pending_human_review'), 'done')
  assert.equal(recordState('answered'), 'done')
  assert.equal(recordState('stopped'), 'stopped')
  assert.equal(recordState('paused_limit'), 'warn')
  assert.equal(recordState('needs_human'), 'warn')
  assert.equal(recordState('weird'), 'failed')
})

test('overview: subagents are untimed, in their own section, never given a time', () => {
  const rows = subagentLedgerRows([{ kind: 'child', id: 's1', label: 'kid', mode: 'fork', activity: 'running' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].untimed, true)
  assert.equal(rows[0].at, null)
  const ledger = buildLedger({ nodes: [USER, ASSISTANT], runs: [], tasks: [], jobs: [], entries: [{ kind: 'child', id: 's1', label: 'kid', mode: 'fork' }], now: 4000 })
  const last = ledger.sections.at(-1)
  assert.equal(last.kind, 'untimed')
  assert.equal(last.title, 'Untimed')
  assert.deepEqual(last.rows.map((r) => r.key), ['kid:s1'])
})

test('overview: the ledger groups by turn, orders oldest first, and trails work after the last turn', () => {
  const ledger = buildLedger({
    nodes: [USER, ASSISTANT, USER2, ASSISTANT2],
    runs: [{ id: 'L1', live: { id: 'L1', startedAt: 2500, task: 'mid work', events: [] }, record: null, at: 2500 }],
    tasks: [],
    jobs: [{ id: 'j2', kind: 'bash', status: 'done', startedAt: 6000, finishedAt: 6100 }],
    entries: [],
    now: 7000,
  })
  assert.deepEqual(ledger.sections.map((s) => s.kind), ['turn', 'turn', 'after'])
  assert.deepEqual(ledger.sections.map((s) => s.title), ['Turn 1: first question', 'Turn 2: second', 'After the last turn'])
  const turn1 = ledger.sections[0].rows.map((r) => r.group)
  assert.deepEqual(turn1, ['conversation', 'conversation', 'runs'], 'the run lands in the turn whose window holds it')
  assert.equal(ledger.sections[2].rows[0].key, 'job:j2')
  assert.equal(ledger.counts.conversation, 4)
  assert.equal(ledger.counts.runs, 1)
  assert.equal(ledger.counts.tasks, 1)
})

test('overview: a task row replaces its run in the ledger', () => {
  const task = { jobId: 't1', sessionId: 's', state: 'running', runId: 'L1', startedAt: 2500, taskText: 'owned work' }
  const ledger = buildLedger({
    nodes: [USER, ASSISTANT],
    runs: [{ id: 'L1', live: { id: 'L1', startedAt: 2500, task: 'owned work', events: [] }, record: null, at: 2500 }],
    tasks: [task],
    jobs: [],
    entries: [],
    now: 4000,
  })
  assert.equal(ledger.counts.runs, 0, 'the run a task owns is not shown twice')
  assert.equal(ledger.counts.tasks, 1)
  const rows = ledger.sections.flatMap((s) => s.rows)
  assert.ok(rows.some((r) => r.key === 'task:t1'))
  assert.ok(!rows.some((r) => r.kind === 'run'))
})

test('overview: rows inside a section are ordered by time, with untimed rows last', () => {
  const tasks = [
    { jobId: 'b', sessionId: 's', state: 'completed', startedAt: 3000, durationMs: 100, taskText: 'later' },
    { jobId: 'a', sessionId: 's', state: 'completed', startedAt: 2500, durationMs: 100, taskText: 'earlier' },
  ]
  const ledger = buildLedger({ nodes: [USER, ASSISTANT], runs: [], tasks, jobs: [], entries: [], now: 4000 })
  const keys = ledger.sections.flatMap((s) => s.rows.filter((r) => r.group === 'tasks').map((r) => r.key))
  assert.deepEqual(keys, ['task:a', 'task:b'])
})

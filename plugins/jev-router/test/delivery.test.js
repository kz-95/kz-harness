// The delivery path: turning a finished task record into its own message in the conversation.
// This is the path the whole design rests on and it had no test at all while it lived inside the
// plugin closure, so it is a module now and these are its tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDelivery } from '../delivery.js'
import { createLanes, createTasks } from '../tasks.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tick = () => new Promise((r) => setImmediate(r))

/** A job registry that does nothing but hand out ids. */
function fakeJobs() {
  let n = 0
  return { start: () => `jev-${++n}`, read: () => ({ text: '' }), kill: () => 'requested', wait: () => new Promise(() => {}) }
}

/** A conversation owner the way the engine hands one over: a session with an append, and a status. */
function owner({ append, idle = true } = {}) {
  const messages = []
  const record = (type, msg, opts) => { messages.push({ type, msg, opts }) }
  return {
    messages,
    status: idle ? 'idle' : 'running',
    whenIdle: async function () { while (this.status !== 'idle') await tick() },
    // `append` may throw, the way a real session can; it still records when it does not.
    session: { append: append ? (type, msg, opts) => { append(type, msg, opts); record(type, msg, opts) } : record },
  }
}

/** Real tasks + real delivery, wired the way index.js wires them. */
function harness({ run } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-delivery-')), 'tasks.jsonl')
  const jobs = fakeJobs()
  const timers = []
  const logs = []
  let delivery
  const tasks = createTasks({
    file,
    lanes: createLanes(),
    jobs: () => jobs,
    run: run ?? (async () => 'the report'),
    onSettled: (result, own) => { delivery.deliverWithRetry(result, own).catch(() => {}) },
  })
  delivery = createDelivery({ tasks, log: (m) => logs.push(m), setTimer: (fn, ms) => { timers.push({ fn, ms }) } })
  return { tasks, delivery, timers, logs, owner: (o) => owner(o) }
}

test('a finished task is appended as its own message, headed by what it is', async () => {
  const h = harness()
  const own = h.owner()
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'Fix the sidebar width', capability: 'project_change' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 1, 'exactly one message')
  const [m] = own.messages
  assert.equal(m.type, 'user/message')
  assert.equal(m.opts.surfaceOp, 'append', 'a surface row, not context the model only sees')
  assert.equal(m.msg.source.kind, 'plugin')
  assert.equal(m.msg.source.plugin, 'jev-router')
  assert.equal(m.msg.source.form, 'notice', 'reuses the engine\u2019s own collapsed notice row')
  const text = m.msg.content[0].text
  assert.match(text, /Background task result/)
  assert.match(text, /Task: Fix the sidebar width/)
  assert.match(text, /Task ID: jev-1/)
  assert.match(text, /Agent: /)
  assert.match(text, /Status: Completed/)
  assert.match(text, /the report/)
  assert.match(m.msg.source.summary, /^jev-1 · Fix the sidebar width · Completed$/, 'the browser matches its rendered row on this')
})

test('it waits for a streaming answer to finish before posting', async () => {
  const h = harness()
  const own = h.owner()
  own.status = 'running'                       // an answer is streaming
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 0, 'nothing is posted into a live answer')
  own.status = 'idle'                           // the answer reached its end
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 1, 'and it lands once the answer is done')
})

test('one result is never appended twice', async () => {
  const h = harness()
  const own = h.owner()
  const t = h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 1)
  const result = h.tasks.results('s1')[0] ?? { jobId: t.jobId, taskName: 'a thing', state: 'completed' }
  // A second attempt at the same result - a retry, or the turn that was streaming - must not add
  // a second message: the claim is what stops it.
  assert.equal(await h.delivery.deliver(result, own), true, 'reported as handled')
  assert.equal(own.messages.length, 1, 'but nothing new was posted')
})

test('an append that throws leaves the result on offer and is retried', async () => {
  let explode = true
  const h = harness()
  const own = h.owner({ append: () => { if (explode) throw new Error('session busy') } })
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(h.tasks.results('s1').length, 1, 'still on offer: the only copy must not be lost')
  assert.match(h.logs.join(' '), /not delivered/)
  assert.equal(h.timers.length, 1, 'and a retry was scheduled')
  // The retry lands once the session accepts it.
  explode = false
  h.timers[0].fn()
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 1, 'the retry posted it')
  assert.equal(h.tasks.get(h.tasks.list()[0].jobId).deliveryState, 'delivering', 'and it waits to be acknowledged')
})

test('with no session to post into, the result stays unread rather than vanishing', async () => {
  const h = harness()
  const own = { messages: [], whenIdle: async () => {}, session: {} }   // no append available
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 0)
  assert.equal(h.tasks.results('s1').length, 1, 'so a later turn can still deliver it')
})

test('retries are bounded, and giving up is said out loud', async () => {
  const h = harness()
  const own = h.owner({ append: () => { throw new Error('never works') } })
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 20; i++) await tick()
  for (let i = 0; i < 10 && h.timers.length; i++) { const t = h.timers.shift(); t.fn(); for (let k = 0; k < 10; k++) await tick() }
  assert.match(h.logs.join(' '), /could not be delivered after 6 attempts/)
  assert.equal(h.tasks.results('s1').length, 1, 'and it is still in the task list as unread')
})

test('two finished tasks are two messages, in the order they finished', async () => {
  // The spec's list: multiple results are delivered in completion order as separate messages.
  const holds = new Map()
  const h = harness({ run: (t) => new Promise((res) => holds.set(t.task, () => res(`${t.task} report`))) })
  const own = h.owner()
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/a', task: 'first' })
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/b', task: 'second' })
  for (let i = 0; i < 20; i++) await tick()
  holds.get('second')()                       // the later one finishes first
  for (let i = 0; i < 20; i++) await tick()
  holds.get('first')()
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 2, 'two results, two messages - never one merged message')
  assert.match(own.messages[0].msg.content[0].text, /Task: second/, 'the one that finished first is posted first')
  assert.match(own.messages[1].msg.content[0].text, /Task: first/)
  for (const m of own.messages) assert.equal(m.opts.surfaceOp, 'append')
})

test('each result has its own message id, so the inbox cannot merge them', async () => {
  const h = harness()
  const own = h.owner()
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/a', task: 'one' })
  h.tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/b', task: 'two' })
  for (let i = 0; i < 30; i++) await tick()
  assert.equal(own.messages.length, 2)
  assert.notEqual(own.messages[0].msg.id, own.messages[1].msg.id, 'a duplicate id is exactly what the inbox rejects')
})
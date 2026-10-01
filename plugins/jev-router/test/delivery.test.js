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

/** Real tasks + real delivery, wired the way index.js wires them; `names` is each agent's name by its id. */
function harness({ run, names } = {}) {
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
  delivery = createDelivery({ tasks, log: (m) => logs.push(m), setTimer: (fn, ms) => { timers.push({ fn, ms }) }, ...(names ? { names } : {}) })
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
test('notify waits for whenIdle, appends one notice with form notice, skips a task that settled meanwhile and the off setting, survives an append that throws, and never changes deliveryState', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-delivery-')), 'tasks.jsonl')
  const holds = new Map()
  const timers = []
  const logs = []
  let progress = 'milestones'
  const tasks = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: (t) => new Promise((res) => holds.set(t.task, () => res('the report'))) })
  const delivery = createDelivery({ tasks, log: (m) => logs.push(m), setTimer: (fn, ms) => { timers.push({ fn, ms }) }, progress: () => progress })
  assert.equal(typeof delivery.notify, 'function', 'delivery.js posts milestone notices')
  const own = owner({ idle: false }) // an answer is streaming
  const t = tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  for (let i = 0; i < 10; i++) await tick()
  const key = tasks.get(t.jobId).key
  const started = { key, summary: 'jev-1 started: Claude Code, claude-opus-4-1, effort high', text: '**jev-1** started: **Claude Code** (claude-opus-4-1, effort high) is working on it in work.' }
  const posting = delivery.notify(own, started)
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(own.messages.length, 0, 'nothing goes into a streaming answer')
  own.status = 'idle'
  assert.equal(await posting, true)
  assert.equal(own.messages.length, 1, 'one notice')
  const [m] = own.messages
  assert.deepEqual([m.type, m.opts, m.msg.role], ['user/message', { surfaceOp: 'append' }, 'user'])
  assert.deepEqual(m.msg.source, { kind: 'plugin', plugin: 'jev-router', form: 'notice', summary: started.summary }, 'the engine\'s own notice row, under its summary')
  assert.deepEqual(m.msg.content, [{ type: 'text', text: started.text }])
  // With milestone notices off, nothing more is posted.
  progress = 'off'
  assert.equal(await delivery.notify(own, started), false)
  assert.equal(own.messages.length, 1)
  progress = 'milestones'
  // An append that throws is tried once more, and a fresh id each time.
  let failures = 1
  const flaky = owner({ append: () => { if (failures-- > 0) throw new Error('session busy') } })
  const retried = delivery.notify(flaky, { ...started, summary: 'jev-1 moved to Codex' })
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(timers.length, 1, 'one retry')
  assert.match(logs.join('\n'), /not posted: session busy/)
  timers.shift().fn()
  assert.equal(await retried, true, 'the retry posted it')
  assert.equal(flaky.messages.length, 1)
  assert.notEqual(flaky.messages[0].msg.id, m.msg.id)
  // One that waited for an answer to end while its task ended posts nothing: the result says the rest.
  const busy = owner({ idle: false })
  const late = delivery.notify(busy, started)
  holds.get('fix the parser')()
  for (let i = 0; i < 20 && tasks.get(t.jobId).state !== 'completed'; i++) await tick()
  busy.status = 'idle'
  assert.equal(await late, false)
  assert.equal(busy.messages.length, 0)
  assert.equal(await delivery.notify(own, { ...started, key: 'no such task' }), false, 'nor for a task nobody has')
  assert.equal(tasks.get(t.jobId).deliveryState, 'pending', 'no notice touched the result\'s delivery state')
  assert.equal(tasks.results('s1').length, 1, 'which is still on offer')
})

test('the result head names agent, model, effort and duration', async () => {
  const messages = []
  const own = { whenIdle: async () => {}, session: { append: (_type, msg) => messages.push(msg) } }
  const delivery = createDelivery({ tasks: { delivering: () => true, undeliver: () => {} }, names: async () => ({ claude: 'Claude Code' }) })
  await delivery.deliver({ jobId: 'jev-3', taskName: 'Fix the sidebar', agent: 'claude', model: 'claude-opus-4-1', effort: 'high', durationMs: 7 * 60_000 + 12_000, state: 'completed', report: 'Done.' }, own)
  assert.match(messages[0].content[0].text, /^Agent: Claude Code · claude-opus-4-1 · effort high · took 7 min$/m, 'named as the start reply named it')
  // A task's own result carries what it ran with and how long it ran, and an id with no name stays an id.
  const h = harness({ run: async (t, { emit, onEntry }) => {
    onEntry({ id: 'run-1' })
    emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'primary', effort: 'xhigh' })
    emit({ type: 'attempt_end', attempt: { agent: 'codex', role: 'primary', model: 'gpt-5.5', effort: 'xhigh', stopReason: 'completed', durationMs: 1000 } })
    return 'the report'
  } })
  const mine = h.owner()
  h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/work', task: 'Fix the sidebar width' })
  for (let i = 0; i < 20 && !mine.messages.length; i++) await tick()
  assert.match(mine.messages[0].msg.content[0].text, /^Agent: codex · gpt-5\.5 · effort xhigh · took \d+ s$/m)
})

test('a reviewed task\'s result head and row name its worker with the worker\'s own model and effort, never its reviewer\'s or its planner\'s', async () => {
  let gate = null
  const h = harness({
    names: async () => ({ claude: 'Claude Code', codex: 'Codex (GPT)' }),
    // Codex writes a plan, Claude Code does the work, and Codex reviews it, as a plan with a
    // planner and a reviewer runs (router.js).
    run: async (t, { emit, onEntry }) => {
      onEntry({ id: 'run-1' })
      emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev' }, primary: { agent: 'claude', model: 'claude-opus-4-1', effort: 'high', level: 'high', speed: null }, planner: { agent: 'codex', model: 'gpt-5.5' }, reviewer: { agent: 'codex', model: 'gpt-5.5' } })
      emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'plan', effort: 'low' })
      emit({ type: 'attempt_end', index: 0, attempt: { agent: 'codex', role: 'plan', model: 'gpt-5.5', effort: 'low', stopReason: 'completed', durationMs: 1000 } })
      emit({ type: 'attempt_start', index: 1, agent: 'claude', role: 'primary', effort: 'high' })
      await new Promise((r) => { gate = r })
      emit({ type: 'attempt_end', index: 1, attempt: { agent: 'claude', role: 'primary', model: 'claude-opus-4-1', effort: 'high', stopReason: 'completed', durationMs: 1000 } })
      emit({ type: 'attempt_start', index: 2, agent: 'codex', role: 'review', effort: 'medium' })
      emit({ type: 'attempt_end', index: 2, attempt: { agent: 'codex', role: 'review', model: 'gpt-5.5', effort: 'medium', stopReason: 'completed', durationMs: 1000 } })
      return 'the report'
    },
  })
  const mine = h.owner()
  const t = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/work', task: 'Fix the sidebar width' })
  for (let i = 0; i < 20 && !gate; i++) await tick()
  const row = () => { const r = h.tasks.get(t.jobId); return [r.agent, r.model, r.effort] }
  assert.deepEqual(row(), ['claude', null, 'high'], 'while Claude Code works: the effort it started at, and not its planner\'s model')
  gate()
  for (let i = 0; i < 20 && !mine.messages.length; i++) await tick()
  assert.deepEqual(row(), ['claude', 'claude-opus-4-1', 'high'], 'the task list names what the work ran with, its review done too')
  assert.match(mine.messages[0]?.msg.content[0].text ?? '', /^Agent: Claude Code · claude-opus-4-1 · effort high · took \d+ s$/m, 'the head names the agent, model and effort the start reply named')
})

test('a task run with a parallel opinion names its worker with the worker\'s own model and effort in its row and its result head, never the opinion\'s agent, model or effort', async () => {
  let release = null
  const gate = new Promise((r) => { release = r })
  // Each run as router.js runs a parallel opinion: the primary starts at its effort and the opinion
  // beside it at none, and the opinion's end comes before the primary's. Claude Code records the
  // model it ran; DeepSeek runs on whatever its settings name, which it records as none.
  const works = {
    claude: { opinion: 'deepseek', opinionModel: 'deepseek-v4', model: 'claude-opus-4-1' },
    deepseek: { opinion: 'claude', opinionModel: 'claude-opus-4-1', model: null },
  }
  const h = harness({
    names: async () => ({ claude: 'Claude Code', deepseek: 'DeepSeek agent' }),
    run: async (t, { emit, onEntry }) => {
      const w = works[t.task]
      onEntry({ id: `run-${t.task}` })
      emit({ type: 'routed', routing: { primaryAgent: t.task, mode: 'jev' }, plan: { strategy: 'PARALLEL_SECOND_OPINION', parallelWith: w.opinion }, primary: { agent: t.task, model: w.model, effort: 'high', level: 'high', speed: null } })
      emit({ type: 'attempt_start', index: 0, agent: t.task, role: 'primary', effort: 'high' })
      emit({ type: 'attempt_start', index: 1, agent: w.opinion, role: 'opinion' })
      await gate
      emit({ type: 'attempt_end', index: 1, attempt: { agent: w.opinion, role: 'opinion', model: w.opinionModel, stopReason: 'completed', durationMs: 1000 } })
      emit({ type: 'attempt_end', index: 0, attempt: { agent: t.task, role: 'primary', ...(w.model ? { model: w.model } : {}), effort: 'high', stopReason: 'completed', durationMs: 1000 } })
      return 'the report'
    },
  })
  const mine = h.owner()
  const claude = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/a', task: 'claude' })
  const deepseek = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/b', task: 'deepseek' })
  for (let i = 0; i < 20; i++) await tick()
  const rows = () => [claude, deepseek].map((t) => { const r = h.tasks.get(t.jobId); return [r.agent, r.model, r.effort] })
  assert.deepEqual(rows(), [['claude', null, 'high'], ['deepseek', null, 'high']], 'while both work: the worker at the effort it started at, not the opinion beside it')
  release()
  for (let i = 0; i < 40 && mine.messages.length < 2; i++) await tick()
  assert.deepEqual(rows(), [['claude', 'claude-opus-4-1', 'high'], ['deepseek', null, 'high']], 'once they end: the worker\'s own model, and none for one that recorded none, never the opinion\'s')
  const head = (jobId) => /^Agent: .*$/m.exec(mine.messages.find((m) => m.msg.source.summary.startsWith(`${jobId} `))?.msg.content[0].text ?? '')?.[0]
  assert.match(head(claude.jobId) ?? '', /^Agent: Claude Code · claude-opus-4-1 · effort high · took \d+ s$/)
  assert.match(head(deepseek.jobId) ?? '', /^Agent: DeepSeek agent · effort high · took \d+ s$/, 'not the opinion\'s model beside DeepSeek')
})

test('a result head names only what the work ran with: no effort for an agent that takes none, whatever level the task was queued at, no model of an agent the work moved off, and the effort of an attempt stopped before it ended', async () => {
  const works = {
    // A local model, queued at max from the model menu, runs with no effort.
    local: (emit) => {
      emit({ type: 'routed', routing: { primaryAgent: 'local-qwen', mode: 'local' }, primary: { agent: 'local-qwen', model: 'qwen3-8b', effort: null, level: null, speed: null } })
      emit({ type: 'attempt_start', index: 0, agent: 'local-qwen', role: 'primary' })
      emit({ type: 'attempt_end', index: 0, attempt: { agent: 'local-qwen', role: 'primary', model: 'qwen3-8b', stopReason: 'completed', durationMs: 1000 } })
    },
    // DeepSeek's attempt, then a retry on Claude Code, whose settings name no model.
    moved: (emit) => {
      emit({ type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary', effort: 'high' })
      emit({ type: 'attempt_end', index: 0, attempt: { agent: 'deepseek', role: 'primary', model: 'deepseek-flash', effort: 'high', stopReason: 'completed', durationMs: 1000 } })
      emit({ type: 'attempt_start', index: 1, agent: 'claude', role: 'retry', effort: 'high' })
      emit({ type: 'attempt_end', index: 1, attempt: { agent: 'claude', role: 'retry', effort: 'high', stopReason: 'completed', durationMs: 1000 } })
    },
  }
  const h = harness({
    names: async () => ({ 'local-qwen': 'Qwen on this PC', claude: 'Claude Code', codex: 'Codex (GPT)' }),
    run: async (t, { signal, emit, onEntry }) => {
      onEntry({ id: `run-${t.task}` })
      if (works[t.task]) { works[t.task](emit); return 'the report' }
      // Queued at max, Codex starts at xhigh, and is stopped before its attempt ends.
      emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'primary', effort: 'xhigh' })
      return new Promise((_, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }))
    },
  })
  const mine = h.owner()
  const local = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/a', task: 'local', effort: 'max' })
  const moved = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/b', task: 'moved' })
  const stopped = h.tasks.enqueue({ owner: mine, sessionId: 's1', workspace: 'C:/c', task: 'stopped', effort: 'max' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(h.tasks.stop(stopped.jobId), 'requested')
  for (let i = 0; i < 20 && mine.messages.length < 3; i++) await tick()
  const head = (jobId) => /^Agent: .*$/m.exec(mine.messages.find((m) => m.msg.source.summary.startsWith(`${jobId} `))?.msg.content[0].text ?? '')?.[0]
  assert.match(head(local.jobId) ?? '', /^Agent: Qwen on this PC · qwen3-8b · took \d+ s$/, 'no effort: the local model takes none')
  assert.equal(h.tasks.get(local.jobId).effort, null, 'nor in the task list')
  assert.match(head(moved.jobId) ?? '', /^Agent: Claude Code · effort high · took \d+ s$/, 'not DeepSeek\'s model beside Claude Code')
  assert.match(head(stopped.jobId) ?? '', /^Agent: Codex \(GPT\) · effort xhigh · took \d+ s$/, 'the effort its attempt started at, not the level it was queued at')
})

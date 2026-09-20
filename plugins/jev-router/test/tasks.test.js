// Background tasks: one lane per workspace, the waiting line, and the results
// a finished task posts back into its chat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TERMINAL_STATES, createLanes, createTasks, laneKey, validJobIds } from '../tasks.js'

const tick = () => new Promise((r) => setImmediate(r))

/** A job registry that does nothing but hand out ids, as tasks.js uses it. */
function fakeJobs() {
  let n = 0
  const jobs = new Map()
  return {
    started: jobs,
    start: (spec) => { const id = `jev-${++n}`; jobs.set(id, { spec, hooks: spec.run() }); return id },
    read: (id) => ({ text: '', snapshot: { id } }),
    kill: (id, _owner, reason) => { jobs.get(id)?.hooks.cancel(reason); return 'requested' },
  }
}

test('lane: one holder per workspace, the rest wait in order', async () => {
  const lanes = createLanes()
  const k = laneKey('C:/work')
  const order = []
  const first = await lanes.acquire(k, 'a')
  assert.equal(lanes.busy(k), true)
  assert.equal(lanes.position(k, 'a'), 0)
  const b = lanes.acquire(k, 'b').then((rel) => { order.push('b'); return rel })
  const c = lanes.acquire(k, 'c').then((rel) => { order.push('c'); return rel })
  await tick()
  assert.deepEqual(order, [], 'nobody starts while a is holding')
  assert.equal(lanes.position(k, 'b'), 2)
  assert.equal(lanes.position(k, 'c'), 3)
  assert.equal(lanes.position(k, 'nope'), -1)
  first()
  ;(await b)()
  ;(await c)()
  assert.deepEqual(order, ['b', 'c'])
  assert.equal(lanes.busy(k), false)
  // A different workspace is a different lane: it never waits.
  const other = await lanes.acquire(laneKey('C:/elsewhere'), 'a')
  other()
})

test('lane: abort while waiting rejects and lets the next one through', async () => {
  const lanes = createLanes()
  const k = laneKey('C:/work')
  const held = await lanes.acquire(k, 'a')
  const ac = new AbortController()
  const b = lanes.acquire(k, 'b', ac.signal)
  const c = lanes.acquire(k, 'c')
  ac.abort()
  await assert.rejects(b, /abort/i)
  held()
  const rel = await c
  assert.equal(lanes.position(k, 'c'), 0)
  rel()
  // An already-aborted signal never joins the lane.
  await assert.rejects(lanes.acquire(k, 'd', AbortSignal.abort()), /abort/i)
})

test('lane: reorder moves waiting tasks to the front, unknown ids throw', async () => {
  const lanes = createLanes()
  const k = laneKey('C:/work')
  const held = await lanes.acquire(k, 'a')
  const order = []
  const rest = ['b', 'c', 'd'].map((id) => lanes.acquire(k, id).then((rel) => { order.push(id); rel() }))
  await tick()
  lanes.reorder(k, ['d'])
  assert.throws(() => lanes.reorder(k, ['a']), /not waiting/, 'the holder is not in the waiting line')
  assert.throws(() => lanes.reorder(k, ['zz']), /not waiting/)
  held()
  await Promise.all(rest)
  assert.deepEqual(order, ['d', 'b', 'c'])
})

test('jobIds: 1-100 short ids, nothing else', () => {
  assert.deepEqual(validJobIds(['jev-1', 'a']), ['jev-1', 'a'])
  for (const bad of [null, [], 'jev-1', [''], ['1bad'], ['a b'], [5], Array(101).fill('a')]) {
    assert.throws(() => validJobIds(bad), /jobIds/, JSON.stringify(bad))
  }
})

/** createTasks wired to a fake registry, with a run() the test drives by hand. */
function harness({ run, file } = {}) {
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({
    file: file ?? join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    run: run ?? (async () => 'done'),
  })
  return { lanes, jobs, tasks }
}

test('acceptance: five tasks in one workspace, every state, then a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-tasks-'))
  const file = join(dir, 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const holds = new Map()
  const tasks = createTasks({
    file,
    lanes,
    jobs: () => jobs,
    // The lane is held by the runner, exactly as index.js does it: that is what makes a second
    // task in the same folder wait, and it is half of what this scenario is checking.
    run: async (t, { signal, emit, onEntry }) => {
      if (lanes.busy(laneKey(t.workspace))) emit({ type: 'queued' })
      const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal)
      try {
        // The real path once it is admitted: Jev routes, then an attempt starts.
        onEntry({ id: 'r' })
        emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev', capability: 'project_change' } })
        emit({ type: 'attempt_start', index: 0, agent: 'claude', role: 'primary' })
        if (t.task === 'fails') throw new Error('agent exploded')
        if (t.task === 'stopped') return await new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true }))
        return await new Promise((res) => holds.set(t.task, () => res(`${t.task} report`)))
      } finally { release() }
    },
  })
  const own = { owner: {}, sessionId: 's1', workspace: 'C:/one' }
  const first = tasks.enqueue({ ...own, task: 'first' })
  const fails = tasks.enqueue({ ...own, task: 'fails' })
  const stopped = tasks.enqueue({ ...own, task: 'stopped' })
  const last = tasks.enqueue({ ...own, task: 'last' })   // waits: one lane, one holder
  const elsewhere = tasks.enqueue({ owner: {}, sessionId: 's2', workspace: 'C:/two', task: 'elsewhere' })

  for (let i = 0; i < 8; i++) await tick()
  // While the first one holds the lane, the ones behind it are honestly "waiting" with a place.
  assert.equal(tasks.get(first.jobId).state, 'running')
  assert.equal(tasks.get(fails.jobId).state, 'queued')
  assert.ok(tasks.get(fails.jobId).position >= 1, 'a waiting task knows its place in line')
  assert.equal(tasks.get(elsewhere.jobId).state, 'running', 'a different workspace never waits')

  tasks.stop(stopped.jobId)
  holds.get('first')()
  holds.get('elsewhere')()
  // The lane hands itself on: the failing task goes next, then the stopped one settles, and
  // only then does the waiting task get its turn.
  for (let i = 0; i < 30 && !holds.has('last'); i++) await tick()
  assert.ok(holds.has('last'), 'the waiting task got its turn once the lane was free')
  holds.get('last')()

  for (let i = 0; i < 10; i++) await tick()
  const byTask = Object.fromEntries(tasks.list().map((t) => [t.task, t]))
  assert.equal(byTask.first.state, 'completed')
  assert.equal(byTask.elsewhere.state, 'completed')
  assert.equal(byTask.stopped.state, 'stopped')
  assert.equal(byTask.fails.state, 'failed')
  assert.match(byTask.fails.terminalReason, /agent exploded/, 'a failure keeps its reason')
  assert.equal(byTask.last.state, 'completed', 'the waiting one ran once the lane was free')
  // Every terminal row is accounted for and none is silently missing a result.
  for (const name of ['first', 'elsewhere', 'stopped', 'fails', 'last']) {
    assert.ok(byTask[name].finishedAt, `${name} has an end time`)
    assert.ok(byTask[name].durationMs >= 0, `${name} has a duration`)
  }
  const unread = tasks.results('s1').map((r) => r.task).sort()
  assert.deepEqual(unread, ['fails', 'first', 'last', 'stopped'], 'everything unread is on offer exactly once')
  // Taking them marks them read, one at a time.
  for (const r of tasks.results('s1')) { tasks.delivering(r.jobId); tasks.delivered(r.jobId) }
  assert.deepEqual(tasks.results('s1'), [], 'nothing is left on offer')

  // The app restarts. Everything keeps its outcome; nothing can come back as still running.
  // Wait for the records to actually reach disk rather than guessing at a delay: persisting is
  // queued, and a restart that read the file too early would see a live task and reconcile it
  // to stopped - which is the correct behaviour for a real interruption, and a false failure here.
  const persisted = () => {
    try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
  for (let i = 0; i < 200; i++) {
    const rows = persisted()
    if (rows.length === 5 && rows.every((r) => TERMINAL_STATES.includes(r.state) && r.deliveryState === 'delivered')) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const after = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'never' })
  await after.ready
  const rows = Object.fromEntries(after.list().map((t) => [t.task, t]))
  assert.equal(Object.keys(rows).length, 5, 'all five rows survive the restart')
  assert.equal(rows.first.state, 'completed')
  assert.equal(rows.fails.state, 'failed')
  assert.equal(rows.stopped.state, 'stopped')
  assert.equal(rows.last.state, 'completed')
  assert.equal(rows.first.deliveryState, 'delivered', 'a read result stays read across a restart')
  assert.equal(rows.fails.deliveryState, 'delivered')
})

test('a finished task is delivered to its own session exactly once', async () => {
  const { tasks } = harness({ run: async (t, { emit }) => { emit({ type: 'final', status: 'accepted' }); return `report for ${t.task}` } })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  assert.equal(t.state, 'queued')
  await tick()
  await tick()
  assert.equal(tasks.get(t.jobId).state, 'completed')
  assert.equal(tasks.report(t.jobId), 'report for fix the parser')
  assert.deepEqual(tasks.results('s2'), [], 'another session sees nothing')
  const out = tasks.results('s1')
  assert.equal(out.length, 1)
  assert.equal(out[0].jobId, t.jobId)
  assert.equal(out[0].status, 'completed')
  assert.equal(out[0].report, 'report for fix the parser')
  assert.equal(out[0].deliveryState, 'pending', 'unread until the renderer takes it')
  // Reading does NOT consume: a turn that dies before the text is shown must not lose it.
  assert.deepEqual(tasks.results('s1'), out, 'still offered until delivered')
  tasks.delivered(t.jobId)
  assert.deepEqual(tasks.results('s1'), [], 'delivered once the message was accepted')
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivered')
  tasks.delivered(t.jobId)
  assert.deepEqual(tasks.results('s1'), [], 'delivering twice is harmless')
})

test('delivery state moves pending -> delivering -> delivered and the unread offer stops at the append', async () => {
  const { tasks } = harness({ run: async () => 'the report' })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(t.jobId).deliveryState, 'pending')
  assert.equal(tasks.results('s1').length, 1, 'pending: not in the conversation yet, so it is offered')
  tasks.delivering(t.jobId)
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivering')
  // The message is in the conversation now. Offering it again would post the report twice,
  // which is exactly the duplicate the record exists to prevent.
  assert.deepEqual(tasks.results('s1'), [], 'once appended it is never offered again')
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivering', 'but it is still unread until the renderer says so')
  tasks.delivered(t.jobId)
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivered')
  assert.ok(tasks.get(t.jobId).deliveredAt, 'the delivery time is recorded')
  tasks.delivered(t.jobId)
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivered', 'acknowledging twice is harmless')
})

test('two attempts to deliver one result cannot both append it', async () => {
  // index.js guards its append with this call, after waiting for the agent to go idle - which is
  // exactly where the race is: the turn that was streaming may have delivered it first.
  const { tasks } = harness({ run: async () => 'the report' })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.delivering(t.jobId), true, 'the first caller wins and appends')
  assert.equal(tasks.delivering(t.jobId), false, 'the second is told it is already on its way')
})

test('a result caught mid-delivery by a restart is offered again, not lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-tasks-'))
  const file = join(dir, 'tasks.jsonl')
  const first = harness({ file, run: async () => 'the report' })
  const t = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 5; i++) await tick()
  first.tasks.delivering(t.jobId)          // the append was about to happen...
  const onDisk = () => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  for (let i = 0; i < 200 && !onDisk().includes('"delivering"'); i++) await new Promise((r) => setTimeout(r, 10))
  assert.match(onDisk(), /"delivering"/, 'the claim reached disk before the crash')
  // ...and the process died there. Nothing is in flight any more.
  const second = harness({ file, run: async () => 'never' })
  await second.tasks.ready
  assert.equal(second.tasks.get(t.jobId).deliveryState, 'pending', 'so the result is on offer again')
  assert.equal(second.tasks.results('s1').length, 1, 'the person still gets told what happened')
})

test('a result whose message was never appended stays on offer', async () => {
  const { tasks } = harness({ run: async () => 'the report' })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'a thing' })
  for (let i = 0; i < 5; i++) await tick()
  // No delivering(): the append failed or there was no session, so it is still pending and a
  // later turn (or a retry) may still deliver it. Losing it would lose the only copy.
  assert.equal(tasks.results('s1').length, 1)
  assert.equal(tasks.results('s1')[0].jobId, t.jobId)
})

test('results arrive in completion order', async () => {
  const holds = new Map()
  const { tasks } = harness({ run: (t) => new Promise((r) => holds.set(t.task, () => r(`${t.task} report`))) })
  const first = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'first' })
  const second = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'second' })
  for (let i = 0; i < 5; i++) await tick()
  holds.get('second')() // finishes first
  for (let i = 0; i < 5; i++) await tick()
  holds.get('first')()
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual(tasks.results('s1').map((r) => r.task), ['second', 'first'], 'delivered in the order they finished')
  assert.equal(tasks.get(first.jobId).state, 'completed')
  assert.equal(tasks.get(second.jobId).state, 'completed')
})

test('the record carries the canonical fields the task list needs', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'routed', routing: { primaryAgent: 'codex', taskType: 'implementation' } })
      emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'primary' })
      emit({ type: 'attempt_end', attempt: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', stopReason: 'completed', durationMs: 1200 } })
      return 'the report'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'add the parser', capability: 'project_change', agent: 'codex' })
  for (let i = 0; i < 20; i++) await tick()
  const row = tasks.get(t.jobId)
  assert.equal(row.taskName, 'add the parser')
  assert.equal(row.taskText, 'add the parser')
  assert.equal(row.capability, 'project_change')
  assert.equal(row.agent, 'codex')
  assert.equal(row.model, 'gpt-5.6-sol')
  assert.equal(row.workspace, 'C:/work')
  assert.equal(row.sessionId, 's1')
  assert.ok(row.queuedAt, 'queuedAt is set')
  assert.ok(row.startedAt, 'startedAt is set when it starts')
  assert.ok(row.finishedAt, 'finishedAt is set when it settles')
  assert.equal(row.terminalReason, null, 'a completed task has no failure reason')
  assert.ok(row.progressText, 'the latest progress line is kept')
  assert.ok(row.phase, 'a phase is reported')
})

test('every transition is recorded with a strictly increasing sequence number', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'routed', routing: { primaryAgent: 'codex' } })
      emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'primary' })
      return 'ok'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'seq' })
  const seen = [tasks.get(t.jobId).seq]
  for (let i = 0; i < 20; i++) { await tick(); seen.push(tasks.get(t.jobId).seq) }
  assert.ok(seen[0] >= 1, 'a record starts sequenced')
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'the sequence never goes backwards')
  assert.ok(seen.at(-1) > seen[0], 'work actually advanced the sequence')
})

test('a terminal task never regresses, whatever arrives late', async () => {
  const { tasks } = harness({ run: async () => 'ok' })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'finished' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'completed')
  const settled = tasks.get(t.jobId)
  // A delayed progress event from before the task ended must not move it back to running.
  tasks.applyEvent(t.jobId, { type: 'progress', text: 'still going' })
  assert.equal(tasks.get(t.jobId).state, 'completed', 'a terminal task stays terminal')
  assert.equal(tasks.get(t.jobId).seq, settled.seq, 'and its sequence does not move')
})

test('an interrupted task is reconciled to stopped on restart, with its progress kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-tasks-'))
  const file = join(dir, 'tasks.jsonl')
  // A previous run left a task mid-flight: written to disk while it was still running.
  // run() mirrors the real contract: it calls onEntry once the lane admits the task.
  const first = harness({ file, run: (t, { signal, onEntry }) => { onEntry({ id: 'run-1' }); return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) } })
  const t = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'long one' })
  for (let i = 0; i < 3; i++) await tick()
  assert.equal(first.tasks.get(t.jobId).state, 'routing', 'onEntry is what starts the clock')
  await new Promise((r) => setTimeout(r, 60))

  // The app restarts: a fresh registry over the same file, with no live job for that id.
  const second = harness({ file, run: async () => 'never runs' })
  await second.tasks.ready
  const row = second.tasks.get(t.jobId)
  assert.ok(row, 'the interrupted task is still listed, not silently dropped')
  assert.equal(row.state, 'stopped', 'an interrupted task cannot stay displayed as running')
  assert.match(row.terminalReason ?? '', /interrupt|restart/i)
  assert.ok(row.finishedAt, 'it is given an end time')
  assert.equal(row.deliveryState, 'pending', 'and its result is still unread, so the person is told')
})

test('the finished result is handed over the moment the task settles', async () => {
  const seen = []
  const lanes = createLanes()
  const jobs = fakeJobs()
  const owner = { id: 'the-session-agent' }
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    run: async () => 'the report',
    onSettled: (result, passedOwner) => seen.push({ result, passedOwner }),
  })
  const t = tasks.enqueue({ owner, sessionId: 's1', workspace: 'C:/work', task: 'do it', capability: 'project_change' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(seen.length, 1, 'handed over exactly once')
  assert.equal(seen[0].result.jobId, t.jobId)
  assert.equal(seen[0].result.state, 'completed')
  assert.equal(seen[0].result.report, 'the report')
  assert.equal(seen[0].result.taskName, 'do it')
  assert.equal(seen[0].result.capability, 'project_change')
  assert.equal(seen[0].passedOwner, owner, 'the conversation owner comes with it, so it can be delivered there')
  assert.equal(tasks.get(t.jobId).deliveryState, 'pending', 'handing it over is not the same as delivering it')
})

test('a stopped task still reports, because its result must explain the stop', async () => {
  let seen = null
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    run: (t, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })),
    onSettled: (result) => { seen = result },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'long one' })
  await tick()
  tasks.stop(t.jobId)
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(seen.state, 'stopped')
  assert.equal(seen.terminalReason, 'stopped by the user', 'the explanation travels with the result')
  assert.equal(tasks.results('s1').length, 1, 'and it is delivered like any other result')
  assert.equal(tasks.results('s1')[0].required, undefined, 'no state is quietly exempt from being shown')
})

test('a task settled twice is only reported once', async () => {
  let calls = 0
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    run: async () => 'ok',
    onSettled: () => { calls++ },
  })
  tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'once' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(calls, 1)
})

test('a task stopped before its turn settles as stopped, with an end time', async () => {
  // The worker honours the abort, as the real one does: it rejects on the signal.
  const { tasks } = harness({ run: (t, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'never ends' })
  await tick()
  assert.equal(tasks.get(t.jobId).state, 'queued', 'still waiting for its turn')
  assert.equal(tasks.stop(t.jobId), 'requested')
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'stopped')
  assert.ok(tasks.get(t.jobId).finishedAt)
  assert.equal(tasks.get(t.jobId).deliveryState, 'pending', 'and the person is still told that it stopped')
})

test('two tasks in one workspace run one at a time, another workspace does not wait', async () => {
  const running = []
  const finish = new Map() // task text -> let this task's run() return
  const { tasks, lanes } = harness({
    run: async (t, { signal }) => {
      const rel = await lanes.acquire(laneKey(t.workspace), t.jobId, signal)
      running.push(t.task)
      try { await new Promise((r) => finish.set(t.task, r)) } finally { rel() }
      return 'ok'
    },
  })
  const own = { owner: {}, sessionId: 's1' }
  const a = tasks.enqueue({ ...own, workspace: 'C:/work', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/work', task: 'b' })
  tasks.enqueue({ ...own, workspace: 'C:/other', task: 'far' })
  await tick()
  assert.deepEqual(running, ['a', 'far'], 'b waits for a; a different workspace does not')
  assert.equal(tasks.get(b.jobId).position, 2)
  assert.equal(tasks.get(a.jobId).position, 0)
  finish.get('a')()
  await tick()
  await tick()
  assert.deepEqual(running, ['a', 'far', 'b'])
  finish.get('b')()
  finish.get('far')()
})

test('stop settles as stopped, not failed, and a finished task cannot be stopped again', async () => {
  const { tasks } = harness({ run: (t, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'long one' })
  await tick()
  assert.equal(tasks.stop(t.jobId), 'requested')
  await tick()
  await tick()
  assert.equal(tasks.get(t.jobId).state, 'stopped')
  assert.equal(tasks.report(t.jobId), null)
  assert.equal(tasks.stop(t.jobId), 'already-finished')
  assert.throws(() => tasks.stop('jev-404'), /no task/)
  const [stopped] = tasks.results('s1')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.task, 'long one')
  assert.match(stopped.terminalReason ?? stopped.status ?? '', /stop/i)
})

test('a failing task reports the error, is saved, and clears on request', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const { tasks } = harness({ file, run: async () => { throw new Error('agent exploded') } })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'boom' })
  await tick()
  await tick()
  assert.equal(tasks.get(t.jobId).state, 'failed')
  const [failed] = tasks.results('s1')
  assert.equal(failed.state, 'failed')
  assert.match(failed.terminalReason, /agent exploded/, 'the failure reason is on the record')
  await new Promise((r) => setTimeout(r, 50))
  assert.match(readFileSync(file, 'utf8'), /agent exploded/, 'finished tasks are on disk')
  assert.deepEqual(tasks.clear([t.jobId]), [t.jobId])
  assert.equal(tasks.get(t.jobId), null)
  assert.deepEqual(tasks.clear([t.jobId]), [], 'clearing an unknown id is a no-op')
})

test('the list names the agent that did the work, not the one that reviewed it', async () => {
  // The run emits the real event shape: routed, then a primary attempt, then a review by a
  // different agent. The list used to take whichever attempt came last, so a run reviewed by
  // claude reported claude for work deepseek did.
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'routed', routing: { primaryAgent: 'deepseek' } })
      emit({ type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
      emit({ type: 'attempt_start', index: 1, agent: 'claude', role: 'review' })
      return 'done'
    },
  })
  tasks.enqueue({ owner: 'a', sessionId: 's', workspace: 'C:/work', task: 'do a thing' })
  for (let i = 0; i < 20; i++) await tick()
  const row = tasks.list().find((t) => t.task === 'do a thing')
  assert.ok(row, 'the task is listed')
  assert.equal(row.agent, 'deepseek', 'the worker, not the reviewer')
})

test('a retry moves the named agent, because a retry is the work', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'attempt_start', index: 0, agent: 'deepseek', role: 'primary' })
      emit({ type: 'attempt_start', index: 1, agent: 'claude', role: 'review' })
      emit({ type: 'attempt_start', index: 2, agent: 'codex', role: 'retry' })
      return 'done'
    },
  })
  tasks.enqueue({ owner: 'a', sessionId: 's', workspace: 'C:/work2', task: 'retried thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(tasks.list().find((t) => t.task === 'retried thing')?.agent, 'codex')
})

test('a run that gave up at its limits is a failure, not a success', async () => {
  // The review kept rejecting until the attempt/round budget was spent. Reporting that as
  // "Completed" tells the person the opposite of what happened.
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'attempt_start', index: 0, agent: 'codex', role: 'primary' })
      emit({ type: 'final', status: 'limit_reached', statusReason: 'maxRounds (5) reached' })
      return 'the report'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'keeps failing review' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'failed')
  assert.match(tasks.get(t.jobId).terminalReason, /maxRounds/)
  assert.equal(tasks.results('s1').length, 1, 'its result still needs showing')
})

test('an accepted run is still a success, whatever the review said along the way', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'final', status: 'accepted_pending_human_review', statusReason: 'look at it' })
      return 'the report'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'done thing' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'completed')
})

test('the router\'s reason for stopping early is kept on the record', async () => {
  // A run can end without a failure: it needs a person, or it paused at a limit. The reason
  // only ever reached the report text, so the task row showed "Needs input" and nothing about
  // what the person was being asked, which is the one thing they need from it.
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'attempt_start', index: 0, agent: 'claude', role: 'primary' })
      emit({ type: 'final', status: 'needs_human', statusReason: 'Jev read this as needing a person (confidence 0.91)' })
      return 'the report'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'delete the database' })
  for (let i = 0; i < 20; i++) await tick()
  const row = tasks.get(t.jobId)
  assert.equal(row.state, 'needs_human')
  assert.match(row.terminalReason, /needing a person/, 'the decision being asked for is on the record')
  assert.equal(tasks.results('s1')[0].terminalReason, row.terminalReason, 'and travels with the result')
})

test('a paused-by-limit run keeps the reset or handoff detail', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'final', status: 'paused_limit', statusReason: 'all agents at their usage limits (earliest reset 03:10)' })
      return 'paused report'
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'a long one' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'paused_limit')
  assert.match(tasks.get(t.jobId).terminalReason, /earliest reset 03:10/)
})

test('a real failure reason still wins over the router status', async () => {
  const { tasks } = harness({
    run: async (t, { emit }) => {
      emit({ type: 'final', status: 'needs_human', statusReason: 'the router said so' })
      throw new Error('agent exploded')
    },
  })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'boom' })
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'failed')
  assert.match(tasks.get(t.jobId).terminalReason, /agent exploded/, 'the actual error is what happened')
})

test('an unposted result is never trimmed away to stay under the cap', async () => {
  // The cap exists to bound a growing file, not to throw away the only copy of a report that
  // has not been posted yet.
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'the report', max: 2 })
  const made = ['a', 'b', 'c'].map((task) => tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task }))
  for (let i = 0; i < 30; i++) await tick()
  assert.equal(tasks.list().length, 3, 'three unposted results survive a cap of two')
  // Post one, then make room: only the posted one may go.
  tasks.delivering(made[0].jobId)
  tasks.delivered(made[0].jobId)
  tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work2', task: 'd' })
  for (let i = 0; i < 30; i++) await tick()
  const left = tasks.list().map((t) => t.task)
  assert.equal(left.includes('a'), false, 'the delivered one made room')
  for (const name of ['b', 'c']) assert.ok(left.includes(name), `${name} is still there, unposted`)
})
test('acknowledging one result does not mark another read', async () => {
  // The spec's list: delivery acknowledgement changes only the matching result.
  const { tasks } = harness({ run: async () => 'the report' })
  const a = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'a' })
  const b = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'b' })
  for (let i = 0; i < 30; i++) await tick()
  assert.equal(tasks.results('s1').length, 2)
  tasks.delivering(a.jobId)
  tasks.delivered(a.jobId)
  assert.deepEqual(tasks.results('s1').map((r) => r.task), ['b'], 'only the acknowledged one is read')
  assert.equal(tasks.get(b.jobId).deliveryState, 'pending', 'the other is untouched')
  assert.equal(tasks.get(a.jobId).deliveryState, 'delivered')
})
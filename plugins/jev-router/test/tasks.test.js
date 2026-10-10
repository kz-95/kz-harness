// Background tasks: one lane per workspace, the waiting line, the cap on tasks at
// once across workspaces, and the results a finished task posts back into its chat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TERMINAL_STATES, WAITING, createLanes, createTasks, laneKey, runAdmitted, validJobIds } from '../tasks.js'
import { line, resultSection } from '../adapter.js'
import { needsLane } from '../capabilities.js'
import { createDelivery } from '../delivery.js'

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

/** Joins a lane and notes who got in, in the order they did. */
const joiner = (lanes, started) => (dir, id, signal) => lanes.acquire(laneKey(dir), id, signal).then((rel) => { started.push(id); return rel })

test('lanes: a global cap across workspaces, and each workspace still one at a time', async () => {
  const lanes = createLanes({ max: 2 })
  const started = []
  const take = joiner(lanes, started)
  const a1 = take('C:/a', 'a1')
  const b1 = take('C:/b', 'b1')
  const c1 = take('C:/c', 'c1') // a third workspace: over the cap
  const a2 = take('C:/a', 'a2') // a1's workspace: waits for a1, cap or no cap
  await tick()
  assert.deepEqual(started, ['a1', 'b1'], 'two at once is the cap')
  assert.equal(lanes.position(laneKey('C:/c'), 'c1'), 1, 'first in its own line, waiting only for a slot')
  assert.equal(lanes.position(laneKey('C:/a'), 'a2'), 2, 'behind the running one in its own workspace')
  assert.equal(lanes.waits(laneKey('C:/d')), true, 'a new workspace would wait as well')
  assert.equal(lanes.busy(laneKey('C:/c')), false, 'busy still means someone holds that workspace')
  ;(await a1)()
  await tick()
  assert.deepEqual(started, ['a1', 'b1', 'c1'], 'the freed slot goes to whoever has waited longest, here in another workspace')
  ;(await b1)()
  await tick()
  assert.deepEqual(started, ['a1', 'b1', 'c1', 'a2'])
  ;(await c1)()
  ;(await a2)()
  assert.equal(lanes.waits(laneKey('C:/d')), false, 'nothing held, nothing waits')
})

test('lanes: raising the cap starts waiting work at once, lowering it never stops what runs, null lifts it', async () => {
  const lanes = createLanes({ max: 1 })
  const started = []
  const take = joiner(lanes, started)
  const a = take('C:/a', 'a')
  const b = take('C:/b', 'b')
  const c = take('C:/c', 'c')
  await tick()
  assert.deepEqual(started, ['a'])
  lanes.setMax(2)
  await tick()
  assert.deepEqual(started, ['a', 'b'], 'raised: the next one starts without waiting for a release')
  lanes.setMax(1)
  await tick()
  assert.deepEqual(started, ['a', 'b'], 'lowered: both keep running and nothing new starts')
  ;(await a)()
  await tick()
  assert.deepEqual(started, ['a', 'b'], 'one still runs, which is the new cap, so c keeps waiting')
  lanes.setMax(null)
  await tick()
  assert.deepEqual(started, ['a', 'b', 'c'], 'no limit, as before there was a budget')
  ;(await b)()
  ;(await c)()
})

test('lanes: a task stopped while it waits for a slot leaves the line holding nothing', async () => {
  const lanes = createLanes({ max: 1 })
  const held = await lanes.acquire(laneKey('C:/a'), 'a')
  const ac = new AbortController()
  const b = lanes.acquire(laneKey('C:/b'), 'b', ac.signal)
  const c = lanes.acquire(laneKey('C:/c'), 'c')
  ac.abort()
  await assert.rejects(b, /abort/i)
  held()
  const rel = await c
  assert.equal(lanes.position(laneKey('C:/c'), 'c'), 0, 'the slot went on to c')
  rel()
})

test('lanes: a task that has to wait is told so as it joins the line, once, with what it waits for', async () => {
  const lanes = createLanes({ max: 1 })
  const told = []
  const take = (dir, id) => lanes.acquire(laneKey(dir), id, undefined, { onWait: (why) => told.push([id, why]) })
  const a = await take('C:/a', 'a')
  assert.deepEqual(told, [], 'a free workspace under the cap starts at once and says nothing')
  const a2 = take('C:/a', 'a2')
  const b = take('C:/b', 'b')
  assert.deepEqual(told, [['a2', 'workspace'], ['b', 'cap']], 'its own workspace is taken, or only the cap on tasks at once is full')
  a()
  ;(await a2)()
  ;(await b)()
  assert.equal(told.length, 2, 'its reason did not change, so it was not told again')
  // A listener that throws is thrown to the caller before the task joins the line, so it leaves
  // nothing behind in it that would hold the workspace for good.
  const held = await take('C:/c', 'c')
  await assert.rejects(lanes.acquire(laneKey('C:/c'), 'c2', undefined, { onWait: () => { throw new Error('no one to tell') } }), /no one to tell/)
  held()
  assert.equal(lanes.busy(laneKey('C:/c')), false, 'the lane is free once its holder is done')
  // What each wait reads as, in the task list and in a foreground run's live lines alike.
  assert.equal(line({ type: 'queued', text: WAITING.cap }), 'Waiting for a free slot: the resource budget caps how many tasks run at once')
  assert.equal(line({ type: 'queued', text: WAITING.workspace }), 'Waiting: another task is running in this workspace')
  assert.equal(line({ type: 'queued' }), WAITING.workspace, 'an event with no text is the workspace wait, as it always was')
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
  // The test's own clock, so every time on the record is exact rather than whatever the machine's
  // load made of it.
  let clock = 1_000
  const tasks = createTasks({
    file,
    lanes,
    jobs: () => jobs,
    now: () => clock,
    // The lane is held by the runner, exactly as index.js does it: that is what makes a second
    // task in the same folder wait, and it is half of what this scenario is checking.
    run: async (t, { signal, emit, onEntry }) => {
      const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
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
  // Nothing is enqueued before the store has read its file: a read still in flight when the first
  // task is written could load that task back as a leftover from an earlier run.
  await tasks.ready
  const own = { owner: {}, sessionId: 's1', workspace: 'C:/one' }
  const first = tasks.enqueue({ ...own, task: 'first' })
  const fails = tasks.enqueue({ ...own, task: 'fails' })
  const stopped = tasks.enqueue({ ...own, task: 'stopped' })
  const last = tasks.enqueue({ ...own, task: 'last' })   // waits: one lane, one holder
  const elsewhere = tasks.enqueue({ owner: {}, sessionId: 's2', workspace: 'C:/two', task: 'elsewhere' })

  // Ticks, not time: everything below moves on promise callbacks alone, so waiting for the state it
  // needs cannot be cut short by a slow machine.
  for (let i = 0; i < 30 && !(holds.has('first') && holds.has('elsewhere')); i++) await tick()
  // While the first one holds the lane, the ones behind it are honestly "waiting" with a place.
  assert.equal(tasks.get(first.jobId).state, 'running')
  assert.equal(tasks.get(fails.jobId).state, 'queued')
  assert.ok(tasks.get(fails.jobId).position >= 1, 'a waiting task knows its place in line')
  assert.equal(tasks.get(elsewhere.jobId).state, 'running', 'a different workspace never waits')

  clock = 4_000
  tasks.stop(stopped.jobId)
  holds.get('first')()
  holds.get('elsewhere')()
  // The lane hands itself on: the failing task goes next, then the stopped one settles, and
  // only then does the waiting task get its turn.
  for (let i = 0; i < 30 && !holds.has('last'); i++) await tick()
  assert.ok(holds.has('last'), 'the waiting task got its turn once the lane was free')
  clock = 9_000
  holds.get('last')()

  for (let i = 0; i < 30 && !tasks.list().every((t) => TERMINAL_STATES.includes(t.state)); i++) await tick()
  const byTask = Object.fromEntries(tasks.list().map((t) => [t.task, t]))
  assert.equal(byTask.first.state, 'completed')
  assert.equal(byTask.elsewhere.state, 'completed')
  assert.equal(byTask.stopped.state, 'stopped')
  assert.equal(byTask.fails.state, 'failed')
  assert.match(byTask.fails.terminalReason, /agent exploded/, 'a failure keeps its reason')
  assert.equal(byTask.last.state, 'completed', 'the waiting one ran once the lane was free')
  // Every terminal row is accounted for and none is silently missing a result.
  for (const name of ['first', 'elsewhere', 'stopped', 'fails', 'last']) assert.ok(byTask[name].finishedAt, `${name} has an end time`)
  // Each ran for exactly as long as the clock says. The stopped one was stopped in the waiting line
  // and never ran, so it has an end time and no duration.
  assert.deepEqual(Object.fromEntries(Object.entries(byTask).map(([name, t]) => [name, t.durationMs])), { first: 3000, fails: 0, stopped: null, last: 5000, elsewhere: 3000 })
  const unread = tasks.results('s1').map((r) => r.task).sort()
  assert.deepEqual(unread, ['fails', 'first', 'last', 'stopped'], 'everything unread is on offer exactly once')
  // Taking them marks them read, one at a time.
  for (const r of tasks.results('s1')) { tasks.delivering(r.jobId); tasks.delivered(r.jobId) }
  assert.deepEqual(tasks.results('s1'), [], 'nothing is left on offer')

  // The app restarts. Everything keeps its outcome; nothing can come back as still running.
  // Every change above queued a rewrite of the whole file, so wait for the store's own queue to
  // drain and read the file once. Polling the file instead raced the writer: under load the queued
  // rewrites outlasted the poll's deadline, and on Windows each poll is a reader holding open the
  // file the writer must rename over, which makes that rename fail until the write is dropped.
  await tasks.flushed()
  const persisted = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(persisted.length, 5, 'the five rows reached disk')
  assert.ok(persisted.every((r) => TERMINAL_STATES.includes(r.state)), 'all of them settled')
  assert.ok(persisted.filter((r) => r.sessionId === 's1').every((r) => r.deliveryState === 'delivered'), 'the delivered ones marked delivered')
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

test('tasks at once across workspaces: the one over the cap waits as queued, first in line, until a slot frees', async () => {
  const lanes = createLanes({ max: 2 })
  const jobs = fakeJobs()
  const holds = new Map()
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    // The runner index.js uses: it says "waiting" whenever it will wait, and what for.
    run: async (t, { signal, emit, onEntry }) => {
      const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
      try {
        onEntry({ id: t.task })
        emit({ type: 'attempt_start', index: 0, agent: 'claude', role: 'primary' })
        return await new Promise((res) => holds.set(t.task, () => res(`${t.task} report`)))
      } finally { release() }
    },
  })
  await tasks.ready
  const own = { owner: {}, sessionId: 's1' }
  const a = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'b' })
  const c = tasks.enqueue({ ...own, workspace: 'C:/c', task: 'c' })
  for (let i = 0; i < 20 && holds.size < 2; i++) await tick()
  assert.deepEqual([a, b, c].map((t) => tasks.get(t.jobId).state), ['running', 'running', 'queued'])
  assert.equal(tasks.get(c.jobId).position, 1, 'first in line: nothing ahead of it in its own workspace')
  assert.equal(tasks.get(c.jobId).progressText, 'Waiting for a free slot: the resource budget caps how many tasks run at once', 'and it says why it is not running')
  holds.get('a')()
  for (let i = 0; i < 20 && !holds.has('c'); i++) await tick()
  assert.equal(tasks.get(c.jobId).state, 'running', 'the slot a freed went to c')
  holds.get('b')()
  holds.get('c')()
  for (let i = 0; i < 20 && tasks.results('s1').length < 3; i++) await tick()
  assert.deepEqual(tasks.results('s1').map((r) => r.state), ['completed', 'completed', 'completed'])
})

test('a waiting task says what it waits for as the line moves, and is told again when that changes', async () => {
  // Cap 1: a1 runs in /a, b1 waits for the slot in /b, a2 and a3 wait behind a1 in /a. When a1
  // ends the slot goes to b1, which arrived first, and nothing runs in /a any more.
  const lanes = createLanes({ max: 1 })
  assert.equal(typeof lanes.waitOf, 'function', 'the lanes say where a waiting run stands')
  const jobs = fakeJobs()
  const holds = new Map()
  const asked = []
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    run: async (t, { signal, emit, onEntry }) => {
      const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { who: { kind: 'task', decider: t.decider }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
      try {
        onEntry({ id: t.task })
        return await new Promise((res) => holds.set(t.task, () => res(`${t.task} report`)))
      } finally { release() }
    },
    wait: (w) => { asked.push(w); return w.why === 'workspace' && !w.slotsAhead ? { lowMs: 60_000, highMs: 120_000, n: 5, text: `Estimate for ${w.ahead} ahead.` } : null },
  })
  await tasks.ready
  const own = { owner: {}, sessionId: 's1' }
  const a1 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a1' })
  for (let i = 0; i < 20 && !holds.has('a1'); i++) await tick()
  const b1 = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'b1' })
  const a2 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a2' })
  const a3 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a3' })
  for (let i = 0; i < 5; i++) await tick()
  const waiting = (t) => tasks.get(t.jobId).waiting
  assert.equal(waiting(a1), null, 'a running task waits for nothing')
  assert.deepEqual([waiting(b1).why, waiting(a2).why, waiting(a3).why], ['cap', 'workspace', 'workspace'])
  assert.deepEqual([waiting(b1).placeText, waiting(a2).placeText, waiting(a3).placeText], ['next for a free slot', '2nd in line', '3rd in line'])
  assert.deepEqual([waiting(a2).ahead, waiting(a3).ahead], [0, 1])
  assert.equal(waiting(a3).since, tasks.get(a3.jobId).queuedAt)
  // b1 arrived before a2: the slot a1 frees goes to b1 first, so a2 is promised nothing.
  assert.deepEqual([waiting(a2).slotsAhead, waiting(a2).estimate], [1, null])
  assert.equal(waiting(a2).text, 'Waiting: another task is running in this workspace. 1 task waiting in another workspace takes a free slot before this one.')
  assert.equal(waiting(b1).text, 'Waiting for a free slot: the resource budget caps how many tasks run at once. Tasks at once: 1 of 1 in use (1 background task).')
  assert.equal(asked.find((w) => w.why === 'workspace').key, laneKey('C:/a'))
  holds.get('a1')()
  for (let i = 0; i < 20 && !holds.has('b1'); i++) await tick()
  assert.equal(tasks.get(b1.jobId).state, 'routing', 'the slot went to b1, which arrived first')
  assert.deepEqual([waiting(a2).why, waiting(a3).why], ['cap', 'line'], 'nothing runs in /a now: a2 waits for the slot, a3 for a2')
  assert.equal(waiting(a3).text, 'Waiting: an earlier task in this workspace is waiting for a free slot first. Tasks at once: 1 of 1 in use (1 background task).')
  // Told again as its reason changed, so its last line follows the line too.
  assert.equal(tasks.get(a2.jobId).progressText, WAITING.cap)
  assert.equal(tasks.get(a3.jobId).progressText, WAITING.line)
  holds.get('b1')()
  for (let i = 0; i < 20 && !holds.has('a2'); i++) await tick()
  assert.equal(waiting(a3).why, 'workspace', 'and back to its workspace once a2 runs')
  assert.deepEqual([waiting(a3).slotsAhead, waiting(a3).estimate?.text], [0, 'Estimate for 0 ahead.'], 'with no one else waiting for a slot, a2\'s end is a3\'s start')
  assert.equal(waiting(a3).text, 'Waiting: another task is running in this workspace. Estimate for 0 ahead.')
  assert.equal(tasks.get(a3.jobId).progressText, WAITING.workspace)
  holds.get('a2')()
  for (let i = 0; i < 20 && !holds.has('a3'); i++) await tick()
  holds.get('a3')()
  for (let i = 0; i < 20 && tasks.results('s1').length < 4; i++) await tick()
  assert.equal(tasks.results('s1').length, 4)
})

test('lanes: slots are ranked by arrival, a lowered cap frees none, and a waiter is told what holds the slots', async () => {
  const lanes = createLanes({ max: 1 })
  const a1 = await lanes.acquire(laneKey('C:/a'), 'a1', undefined, { who: { kind: 'task', decider: 'jev' } })
  const ac = new AbortController()
  const pending = [lanes.acquire(laneKey('C:/b'), 'b1', ac.signal), lanes.acquire(laneKey('C:/c'), 'c1', ac.signal), lanes.acquire(laneKey('C:/b'), 'b2', ac.signal)]
  pending.forEach((p) => p.catch(() => {}))
  await tick()
  assert.deepEqual([lanes.waitOf(laneKey('C:/b'), 'b1').slot, lanes.waitOf(laneKey('C:/c'), 'c1').slot], [1, 2], 'b1 arrived first')
  // Once b1 has started, c1 arrived before b2 and takes the slot b1 frees.
  assert.deepEqual(lanes.waitOf(laneKey('C:/b'), 'b2'), { why: 'line', place: 2, ahead: 1, slotsAhead: 1, slotsAheadHere: 0, overCap: false, chatAhead: 0, holder: null, aheadWho: [null], max: 1, held: { task: 1 } })
  assert.equal(lanes.waitOf(laneKey('C:/a'), 'a1'), null, 'a holder is not waiting')
  // Lowered under what runs: the next to end frees no slot, and every waiter says so.
  lanes.setMax(0)
  assert.equal(lanes.waitOf(laneKey('C:/c'), 'c1').overCap, true)
  lanes.setMax(1)
  ac.abort()
  a1()
})

test('Remove stops a task only while it still waits: one that started meanwhile is left running', async () => {
  const { tasks } = harness({ run: (t, { signal, onEntry }) => { onEntry({ id: 'run-1' }); return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) } })
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'already going' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'routing', 'it started, and its row says routing')
  assert.equal(tasks.get(t.jobId).phase, 'routing', 'not the phase it had while it waited')
  assert.equal(tasks.stop(t.jobId, { onlyIfWaiting: true }), 'started')
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'routing', 'and it runs on')
  assert.equal(tasks.stop(t.jobId), 'requested', 'Stop still stops it')
})

test('an estimate that cannot be made never takes the task list down', async () => {
  const lanes = createLanes()
  const logged = []
  const { tasks } = { tasks: createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => fakeJobs(),
    run: async (t, { signal }) => { const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal); release(); return 'ok' },
    wait: () => { throw new Error('history unreadable') },
    log: (m) => logged.push(m),
  }) }
  const hold = await lanes.acquire(laneKey('C:/w'), 'someone')
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/w', task: 'x' })
  for (let i = 0; i < 5; i++) await tick()
  const w = tasks.list().find((v) => v.jobId === t.jobId).waiting
  assert.ok(w, 'the task list says what the task waits for')
  assert.equal(w.why, 'workspace')
  assert.equal(w.estimate, null)
  assert.match(logged.join('\n'), /no wait estimate for .*history unreadable/)
  hold()
})

test('tasks at once, now: every run holding a slot counts, a foreground run as much as a background task, and a finished one stops counting', async () => {
  const lanes = createLanes({ max: 2 })
  const jobs = fakeJobs()
  const holds = new Map()
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    // The runner index.js uses, as in the test above.
    run: async (t, { signal, emit, onEntry }) => {
      const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
      try {
        onEntry({ id: t.task })
        return await new Promise((res) => holds.set(t.task, () => res(`${t.task} report`)))
      } finally { release() }
    },
  })
  await tasks.ready
  const own = { owner: {}, sessionId: 's1' }
  const until = async (ok) => { for (let i = 0; i < 20 && !ok(); i++) await tick() }
  assert.deepEqual(lanes.slots(), { held: 0, waiting: 0, max: 2 }, 'nothing runs')
  // A foreground /auto, /<agent> or jev_route has no task record: route() takes its workspace's lane
  // itself, under an id of its own, which is how the cap counts it.
  const foreground = await lanes.acquire(laneKey('C:/a'), 'route-1')
  tasks.enqueue({ ...own, workspace: 'C:/b', task: 'b' })
  await until(() => holds.has('b'))
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 0, max: 2 }, 'the foreground run and the background task each hold a slot')
  // Two more: c in a third workspace, which only a slot keeps waiting, and a2 behind the foreground
  // run in its own workspace, which a free slot would not start.
  const c = tasks.enqueue({ ...own, workspace: 'C:/c', task: 'c' })
  const a2 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a2' })
  await until(() => tasks.get(a2.jobId).progressText !== 'Waiting')
  assert.deepEqual([c, a2].map((t) => tasks.get(t.jobId).state), ['queued', 'queued'])
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 1, max: 2 }, 'c waits for a slot; a2 waits for its workspace')
  // The foreground run ends. Its slot goes to c, which waited longest, and a2 now has its workspace
  // to itself and waits only for a slot.
  foreground()
  await until(() => holds.has('c'))
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 1, max: 2 }, 'a finished foreground run no longer counts, and c holds the slot it freed')
  holds.get('b')()
  await until(() => holds.has('a2'))
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 0, max: 2 }, 'a finished background task no longer counts, and a2 holds the slot it freed')
  holds.get('c')()
  holds.get('a2')()
  await until(() => tasks.results('s1').length === 3)
  assert.deepEqual(lanes.slots(), { held: 0, waiting: 0, max: 2 }, 'every run finished, every slot free')

  // With no cap nothing waits for a slot: a run behind another in its own workspace waits for that one.
  const open = createLanes()
  const held = await open.acquire(laneKey('C:/a'), 'route-2')
  const behind = open.acquire(laneKey('C:/a'), 'route-3')
  assert.deepEqual(open.slots(), { held: 1, waiting: 0, max: null })
  held()
  ;(await behind)()
  assert.deepEqual(open.slots(), { held: 0, waiting: 0, max: null })
})

test('index.js serves how many runs hold a slot with the local models\' status, counted by the lanes that hold the cap', () => {
  // The route is inside apply(), which needs the whole plugin runtime, so its line is read from the
  // source. localStatus() itself is run over real lanes in test/budgetpanel.test.js.
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // \r?\n throughout: this reads the file as checked out, and on Windows that is CRLF.
  assert.match(index, /url\.pathname === '\/jev-router\/local'\) \{\r?\n\s*return send\(200, await localStatus\(\{ local, lanes, online: connectivity\.last\(\)\?\.online \?\? null \}\)\)/)
  assert.match(index, /export const localStatus = async \(\{ local, lanes, online \}\) => \(\{ \.\.\.\(await local\.status\(\)\), online, slots: lanes\.slots\(\) \}\)/)
})

test('index.js takes the cap on tasks at once from the local settings, at start and on every change', () => {
  // The lanes are built inside apply(), which needs the whole plugin runtime, so the wiring is read
  // from the source, as the enqueue test below does. Dropping either line leaves the budget's
  // "tasks at once" saved, shown, and obeyed by nothing.
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // The router caches readiness for five minutes, so without the reset a model the new budget
  // refuses would still be picked, and the chat model would stay one the budget will not load. The
  // local agents are read again too: the budget sizes each model's context, and a window the router
  // kept from before the change would send a model more than it holds, or refuse what it could.
  assert.match(index, /onSettings: \(s\) => \{ readyGen\+\+; readyCache = null; lanes\.setMax\(s\.maxConcurrentTasks\); resolveAux\(\); refreshLocal\(\) \}/, 'a budget change clears the readiness cache, reaches the lanes, picks the chat model again and reads the local agents\' windows again')
  assert.match(index, /local\.readSettings\(\)\.then\(\(s\) => lanes\.setMax\(s\.maxConcurrentTasks\)/, 'and the saved cap is read once at start')
  // Every way into a lane says so when it has to wait: the background runner (through runAdmitted,
  // which takes a read-only task's own slot or its workspace's lane), route() for /auto, /<agent>
  // and jev_route, which used to wait on the cap in silence, and a task of the capability
  // benchmark, which tells its card (docs/benchmark.md 3.8).
  // Captured without the line ending rather than trimmed in each pattern below: on a CRLF
  // checkout every line ends in \r, and an anchored pattern would never match one.
  const ways = index.match(/lanes\.acquire\([^\r\n]*/g)
  assert.equal(ways.length, 2, 'route() and the capability benchmark; the background runner goes through runAdmitted')
  assert.match(ways[0], /^lanes\.acquire\(key, `route-\$\{randomUUID\(\)\}`, signal, \{ who, onWait: \(why\) => \{ emit\?\.\(\{ type: 'queued', text: WAITING\[why\] \}\); process\.stdout\.write\(`\[jev\] \$\{WAITING\[why\]\}\\n`\) \} \}\)$/, 'a foreground run tells its live lines and the log')
  assert.ok(index.indexOf(ways[0]) > index.indexOf('async function route('), 'that one is route()')
  assert.match(ways[1], /^lanes\.acquire\(laneKey\(folder\), `benchmark-\$\{runId\}`, signal, \{ who: \{ kind: 'benchmark' \}, onWait: \(why\) => onWait\?\.\(WAITING\[why\]\) \}\)$/, 'a benchmark task tells its card')
  assert.ok(index.indexOf(ways[1]) > index.indexOf('async function runBenchmarkTask('), 'that one is the benchmark\'s')
  assert.match(index, /runAdmitted\(\{ lanes, task: t, signal, who: \{ kind: 'task', decider: t\.decider \?\? 'jev' \}, onWait: \(why\) => emit\(\{ type: 'queued', text: WAITING\[why\] \}\),/, 'a background task tells its row')
  assert.match(index, /const waiting = tasks\.get\(t\.jobId\)\?\.waiting \?\? null/, 'and the start reply says where it stands and why, read off the line it joined as it was queued, so it does not promise "starting now" when the cap is full')
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
  // Its message is posted (delivery claims it first), and the browser says it rendered it.
  tasks.delivering(t.jobId)
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
  await first.tasks.flushed()
  assert.match(readFileSync(file, 'utf8'), /"delivering"/, 'the claim reached disk before the crash')
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
  await first.tasks.flushed()
  const onDisk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.jobId === t.jobId)
  assert.equal(onDisk?.state, 'routing', 'the running task reached disk as routing')

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
    // It is running: the lane let it in (onEntry), as the real runner says before routing.
    run: (t, { signal, onEntry }) => { onEntry({ id: 'run-1' }); return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) },
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
  assert.equal(tasks.get(t.jobId).terminalReason, 'removed from the line before it started', 'and that it never ran')
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
  const { tasks } = harness({ run: (t, { signal, onEntry }) => { onEntry({ id: 'run-1' }); return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) } })
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

test('flushed() writes a progress line still waiting to be coalesced now, rather than half a second later', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  let hold = null
  const { tasks } = harness({
    file,
    run: async (t, { emit, onEntry }) => {
      onEntry({ id: 'r' }) // a state change: written at once
      emit({ type: 'note', text: 'halfway there' }) // a progress line: coalesced with the ones after it
      return new Promise((r) => { hold = r })
    },
  })
  await tasks.ready
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'long one' })
  for (let i = 0; i < 20 && !hold; i++) await tick()
  assert.equal(tasks.get(t.jobId).progressText, 'halfway there')
  await tasks.flushed()
  const row = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.jobId === t.jobId)
  assert.equal(row.progressText, 'halfway there', 'the latest line is on disk once flushed() resolves')
  hold('done')
})

test('a tasks store\'s dispose(), as the plugin closes or is applied again, resolves once every write asked of it before has landed: the claim of a result just posted, and a progress line still waiting to be coalesced', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  let emit = null
  const { tasks } = harness({ file, run: (t, o) => (t.task === 'still going' ? new Promise(() => { emit = o.emit }) : Promise.resolve('the report')) })
  await tasks.ready
  const done = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'done now' })
  const going = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'still going' })
  for (let i = 0; i < 20 && (tasks.get(done.jobId).state !== 'completed' || !emit); i++) await tick()
  await tasks.flushed()
  // A line of the task still going, written half a second later, and the claim of the result just
  // posted, written at once; the plugin closes before either has landed.
  emit({ type: 'note', text: 'halfway there' })
  assert.equal(tasks.delivering(done.jobId), true)
  await tasks.dispose?.()
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(rows.find((r) => r.jobId === done.jobId)?.deliveryState, 'delivering', 'the claim is on disk, so the next start does not post the result as if it never had')
  assert.equal(rows.find((r) => r.jobId === going.jobId)?.progressText, 'halfway there', 'and so is the line')
})

test('a tasks store disposed of, as the plugin closing or applied again leaves it, never rewrites tasks.jsonl from what it holds, since the plugin that replaces it has written its own records there, and claims no result or notice it could not save', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  let finish = null
  const { tasks } = harness({ file, run: (t) => (t.task === 'still going' ? new Promise((r) => { finish = r }) : Promise.resolve('the report')) })
  await tasks.ready
  const done = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'done now' })
  const going = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'still going' })
  for (let i = 0; i < 20 && (tasks.get(done.jobId).state !== 'completed' || !finish); i++) await tick()
  await tasks.flushed()
  await tasks.dispose?.()
  // The plugin that replaces it reads the file and writes a record of its own there.
  const theirs = `${readFileSync(file, 'utf8')}${JSON.stringify({ jobId: 'jev-3', key: 'theirs', sessionId: 's1', workspace: 'C:/c', taskText: 'theirs', state: 'queued' })}\n`
  writeFileSync(file, theirs)
  // What the closed store still hears: a notice claimed for the task still going, which then
  // settles; its finished result claimed for posting, put back on offer; a finished task cleared.
  assert.equal(tasks.claimNotice(going.key, 'started'), false, 'no notice is claimed that could not be saved')
  finish('the late report')
  for (let i = 0; i < 20 && tasks.get(going.jobId).state !== 'completed'; i++) await tick()
  assert.equal(tasks.get(going.jobId).state, 'completed', 'the task still going settles, in memory')
  assert.equal(tasks.delivering(done.jobId), false, 'no result is claimed for posting that could not be saved, so it stays unread on disk for the next start to post')
  tasks.undeliver(done.jobId)
  tasks.clear([done.jobId])
  await tasks.flushed()
  assert.equal(readFileSync(file, 'utf8'), theirs, 'tasks.jsonl is still what the plugin that replaced it wrote')
})

/**
 * A store whose tasks run until the test lets each go, by its text, on lanes the test holds: the
 * store of a plugin, which the engine closes and applies again on the same file.
 */
function closingStore({ file, lanes, jobs, onSettled }) {
  const holds = new Map()
  const run = async (t, { signal, emit, onEntry }) => {
    const release = await lanes.acquire(laneKey(t.workspace), t.jobId, signal, { who: { kind: 'task' }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
    try {
      onEntry({ id: `run-${t.task}` })
      // Stopped, it ends as an agent told to stop does.
      return await new Promise((res, rej) => {
        holds.set(t.task, (report) => res(report))
        signal.addEventListener('abort', () => rej(signal.reason), { once: true })
      })
    } finally { release() }
  }
  return { holds, tasks: createTasks({ file, lanes, jobs: () => jobs, run, onSettled }) }
}

test('a task at work as the plugin closes is taken over by the store of the plugin applied again: it stays at work there, what it does is saved there, and as its run ends in the closed store its result is recorded, saved and handed to that store\'s onSettled once, never to the closed store\'s', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await before.ready
  const t = before.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'going' })
  for (let i = 0; i < 20 && !holds.has('going'); i++) await tick()
  await before.dispose()
  const heard = []
  const restarted = []
  const after = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: before.handOff?.() ?? [], onSettled: (r) => heard.push(r), onRestartStopped: (x) => restarted.push(x.jobId) })
  await after.ready
  assert.equal(after.get(t.jobId)?.state, 'routing', 'at work in the plugin applied again, not stopped by a restart')
  assert.deepEqual(restarted, [])
  // The run, still going in the closed plugin, is routed: the store that took it over saves that.
  before.applyEvent(t.jobId, { type: 'routed', primary: { agent: 'deepseek' }, routing: { primaryAgent: 'deepseek' }, text: 'Routed to deepseek' })
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => [r.state, r.agent]), [['running', 'deepseek']])
  holds.get('going')('the late report')
  for (let i = 0; i < 20 && !heard.length; i++) await tick()
  assert.deepEqual(heard.map((r) => [r.jobId, r.state, r.report]), [[t.jobId, 'completed', 'the late report']], 'reported once, by the store that took it over')
  assert.deepEqual(closedHeard, [], 'never by the closed one')
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => [r.state, r.report, r.deliveryState]), [['completed', 'the late report', 'pending']], 'saved where the plugin applied again keeps its list')
  assert.equal(before.delivering(t.jobId), false, 'the closed store claims nothing')
  assert.equal(after.delivering(t.jobId), true, 'the store that took it over posts it')
  assert.equal(after.delivering(t.jobId), false, 'once')
})

test('a task that ends after the plugin closed but before the plugin applied again has read its list is recorded and reported there once it has, and not by the closed store meanwhile', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await before.ready
  const t = before.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'going' })
  for (let i = 0; i < 20 && !holds.has('going'); i++) await tick()
  await before.dispose()
  const handed = before.handOff?.() ?? []
  holds.get('going')('done meanwhile')
  for (let i = 0; i < 20 && before.get(t.jobId).state !== 'completed'; i++) await tick()
  assert.deepEqual(closedHeard, [], 'held while it waits for the plugin applied again')
  const heard = []
  const after = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: handed, onSettled: (r) => heard.push(r.jobId) })
  await after.ready
  for (let i = 0; i < 20 && !heard.length; i++) await tick()
  assert.deepEqual(heard, [t.jobId])
  assert.equal(after.get(t.jobId).state, 'completed')
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => [r.state, r.report]), [['completed', 'done meanwhile']])
})

test('a task waiting in line as the plugin closes keeps its place in the line the plugin applied again goes on with: it starts as the task ahead of it ends, and the store that took it over saves its start and reports its result', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await before.ready
  const own = { owner: {}, sessionId: 's1', workspace: 'C:/a' }
  const first = before.enqueue({ ...own, task: 'first' })
  const second = before.enqueue({ ...own, task: 'second' })
  for (let i = 0; i < 20 && !holds.has('first'); i++) await tick()
  await before.dispose()
  const heard = []
  const after = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: before.handOff?.() ?? [], onSettled: (r) => heard.push(r.jobId) })
  await after.ready
  assert.deepEqual([after.get(second.jobId)?.state, after.get(second.jobId)?.position], ['queued', 2], 'still second in its folder\'s line')
  holds.get('first')('first report')
  for (let i = 0; i < 20 && !holds.has('second'); i++) await tick()
  assert.equal(after.get(second.jobId).state, 'routing', 'started as the folder came free')
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === second.key).map((r) => r.state), ['routing'], 'its start saved by the store that took it over')
  holds.get('second')('second report')
  for (let i = 0; i < 20 && heard.length < 2; i++) await tick()
  assert.deepEqual(heard, [first.jobId, second.jobId])
  assert.deepEqual(closedHeard, [])
})

test('a plugin applied again that closes in turn before it has read its list hands the tasks it was handed on, as they came, to the plugin applied after it, which takes them over', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const { holds, tasks: first } = closingStore({ file, lanes, jobs })
  await first.ready
  const t = first.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'going' })
  for (let i = 0; i < 20 && !holds.has('going'); i++) await tick()
  await first.dispose()
  const secondHeard = []
  const secondStopped = []
  const second = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: first.handOff?.() ?? [], onSettled: (r) => secondHeard.push(r.jobId), onRestartStopped: (x) => secondStopped.push(x.jobId) })
  // Applied again at once, before the second has read its list.
  const passed = second.handOff?.() ?? []
  await second.dispose()
  const heard = []
  const third = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: passed, onSettled: (r) => heard.push(r.jobId) })
  await Promise.all([second.ready, third.ready])
  assert.equal(third.get(t.jobId)?.state, 'routing', 'at work in the third plugin')
  assert.deepEqual(secondStopped, [], 'the second, closed before it read its list, tells nobody the task was stopped by a restart')
  holds.get('going')('the report')
  for (let i = 0; i < 20 && !heard.length; i++) await tick()
  assert.deepEqual(heard, [t.jobId], 'reported once, by the third')
  assert.deepEqual(secondHeard, [])
  await third.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => r.state), ['completed'])
})

test('a task handed over that no plugin takes over within the bound is reported by the closed store as before, once, which posts nothing, and is held until then; a store started after reads it as stopped by a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await before.ready
  const own = { owner: {}, sessionId: 's1' }
  const ended = before.enqueue({ ...own, workspace: 'C:/a', task: 'ends first' })
  const later = before.enqueue({ ...own, workspace: 'C:/b', task: 'ends later' })
  for (let i = 0; i < 20 && holds.size < 2; i++) await tick()
  await before.dispose()
  const handed = before.handOff?.() ?? []
  holds.get('ends first')('first report')
  for (let i = 0; i < 20 && before.get(ended.jobId).state !== 'completed'; i++) await tick()
  assert.deepEqual(closedHeard, [], 'held while a plugin applied again may still take it over')
  // The bound passes with no plugin applied again.
  for (const x of handed) x.expire()
  for (const x of handed) x.expire()
  assert.deepEqual(closedHeard, [ended.jobId], 'reported as before, once')
  holds.get('ends later')('later report')
  for (let i = 0; i < 20 && closedHeard.length < 2; i++) await tick()
  assert.deepEqual(closedHeard, [ended.jobId, later.jobId], 'one that ends after the bound is reported as it ends')
  assert.equal(before.delivering(ended.jobId), false, 'which posts nothing: the closed store claims no result')
  const restarted = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'x' })
  await restarted.ready
  assert.match(restarted.get(ended.jobId).terminalReason, /^interrupted: the app restarted while this task was running/)
})

test('a task taken over twice, as the engine applies the plugin again twice while it runs, is saved, heard and reported by the newest store, once, and by neither store that closed', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: first } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await first.ready
  const t = first.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'going' })
  for (let i = 0; i < 20 && !holds.has('going'); i++) await tick()
  await first.dispose()
  const second = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: first.handOff?.() ?? [], onSettled: (r) => closedHeard.push(r.jobId) })
  await second.ready
  await second.dispose()
  const heard = []
  const third = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: second.handOff?.() ?? [], onSettled: (r) => heard.push(r) })
  await third.ready
  assert.equal(third.get(t.jobId)?.state, 'routing', 'at work in the newest plugin')
  const said = []
  third.watch(t.key, (e) => said.push(e.type))
  // The run, still going in the first plugin, is routed: the newest store saves that.
  first.applyEvent(t.jobId, { type: 'routed', primary: { agent: 'deepseek' }, routing: { primaryAgent: 'deepseek' }, text: 'Routed to deepseek' })
  await third.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => [r.state, r.agent]), [['running', 'deepseek']])
  holds.get('going')('the late report')
  for (let i = 0; i < 20 && !heard.length; i++) await tick()
  assert.deepEqual(heard.map((r) => [r.jobId, r.state, r.report]), [[t.jobId, 'completed', 'the late report']], 'reported once, by the newest store')
  assert.deepEqual(closedHeard, [], 'never by a store that closed')
  assert.deepEqual(said, ['settled'], 'whose watchers hear it end')
  await third.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => [r.state, r.deliveryState]), [['completed', 'pending']], 'saved where the newest plugin keeps its list')
  assert.equal(third.delivering(t.jobId), true, 'which posts it')
  assert.equal(third.delivering(t.jobId), false, 'once')
})

test('Stop from the plugin applied again stops a task it took over: the run going on in the closed plugin is told to stop through the job, and the store that took the task over records and reports it as stopped, once', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const closedHeard = []
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: (r) => closedHeard.push(r.jobId) })
  await before.ready
  const t = before.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'going' })
  for (let i = 0; i < 20 && !holds.has('going'); i++) await tick()
  await before.dispose()
  const heard = []
  const after = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: before.handOff?.() ?? [], onSettled: (r) => heard.push(r) })
  await after.ready
  assert.equal(after.get(t.jobId)?.state, 'routing', 'at work in the plugin applied again')
  assert.equal(after.stop(t.jobId), 'requested')
  for (let i = 0; i < 20 && !heard.length; i++) await tick()
  assert.deepEqual(heard.map((r) => [r.jobId, r.state, r.terminalReason]), [[t.jobId, 'stopped', 'stopped by the user']], 'reported once, by the store that took it over')
  assert.deepEqual(closedHeard, [])
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === t.key).map((r) => r.state), ['stopped'], 'and saved there')
  assert.equal(lanes.busy(laneKey('C:/a')), false, 'its folder is free again')
})

test('Send now from the plugin applied again starts a task it took over that waited for a slot: the line the closed plugin left lets it in, and the store that took it over saves its start', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  lanes.setMax(1)
  const jobs = fakeJobs()
  const { holds, tasks: before } = closingStore({ file, lanes, jobs, onSettled: () => {} })
  await before.ready
  const own = { owner: {}, sessionId: 's1' }
  before.enqueue({ ...own, workspace: 'C:/a', task: 'first' })
  const second = before.enqueue({ ...own, workspace: 'C:/b', task: 'second' })
  for (let i = 0; i < 20 && !holds.has('first'); i++) await tick()
  await before.dispose()
  const after = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'not run here', takeOver: before.handOff?.() ?? [] })
  await after.ready
  assert.equal(after.get(second.jobId)?.state, 'queued', 'waiting for a slot in the plugin applied again')
  assert.equal(after.startNow(second.key), 'started')
  for (let i = 0; i < 20 && !holds.has('second'); i++) await tick()
  assert.equal(holds.has('second'), true, 'its run starts')
  await after.flushed()
  assert.deepEqual(rowsOf(file).filter((r) => r.key === second.key).map((r) => r.state), ['routing'], 'and the store that took it over saves its start')
  holds.get('first')('one')
  holds.get('second')('two')
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
  await tasks.flushed()
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
test('a state this build does not know is left alone by reconcile', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  // A record written by some other build. Not recognising its state is no evidence that the
  // task was interrupted, and rewriting it buries a settled outcome under a false notice.
  const row = { jobId: 'jev-1', sessionId: 's1', workspace: 'C:/work', taskName: 'a thing', taskText: 'a thing', state: 'archived', terminalReason: null, deliveryState: 'pending', seq: 4, report: 'the report' }
  writeFileSync(file, `${JSON.stringify(row)}\n`)
  const { tasks } = harness({ file })
  await tasks.ready
  const back = tasks.get('jev-1')
  assert.equal(back.state, 'archived', 'an unknown state is not turned into stopped')
  assert.equal(back.terminalReason, null, 'and no interruption is invented for it')
  assert.equal(back.seq, 4, 'the record is not rewritten at all')
})

test('a load over the cap keeps a finished report that was never posted', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  // Three rows for a cap of two. The oldest is finished and still unposted, so it is the one
  // a blind cut of the oldest lines would take, and the next persist() writes that loss back.
  const row = (jobId, deliveryState) => JSON.stringify({ jobId, sessionId: 's1', workspace: 'C:/work', taskName: jobId, taskText: jobId, state: 'completed', finishedAt: 1, deliveryState, report: `${jobId} report`, seq: 2 })
  writeFileSync(file, `${['jev-1', 'jev-2', 'jev-3'].map((id, i) => row(id, i ? 'delivered' : 'pending')).join('\n')}\n`)
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({ file, lanes, jobs: () => jobs, run: async () => 'never', max: 2 })
  await tasks.ready
  assert.ok(tasks.get('jev-1'), 'the unposted report survives a load over the cap')
  assert.equal(tasks.report('jev-1'), 'jev-1 report')
  assert.equal(tasks.results('s1').length, 1, 'and it is still offered to the person')
  assert.equal(tasks.list().length, 2, 'a delivered row made the room instead')
})

test('background enqueue: every field the adapter passes reaches tasks.enqueue', () => {
  // The background path crosses two files with nothing checking the join: adapter.js hands
  // orchestrator.enqueue (index.js) a field set and index.js forwards it to tasks.enqueue below.
  // Dropping one there is silent - `modalities` falls back to text, the capability filter stops
  // demanding image support, and an attached screenshot reaches an agent that cannot see it, which
  // then answers from the words around it. The orchestrator is built inside apply(), so calling it
  // needs the whole plugin runtime; the three source lines are read instead.
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  // Top-level keys of an object literal, shorthand or not. Values holding a comma (an array, a
  // ternary) split into fragments that are not identifiers, so the filter drops them.
  const keysOf = (lit) => lit.split(',').map((p) => p.split(':')[0].trim()).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const callSites = src('adapter.js').match(/orchestrator\.enqueue\(\{([^}]*)\}/g) ?? []
  assert.equal(callSites.length, 2, 'both background call sites are still in adapter.js')
  const passed = new Set(callSites.flatMap((c) => keysOf(c.slice(c.indexOf('{') + 1))))
  assert.ok(passed.has('modalities'), 'the adapter still declares what the task carries')
  const index = src('index.js')
  const taken = keysOf(index.match(/\n\s*(?:async\s+)?enqueue\(\{([^}]*)\}\)/)[1])
  // Names, not keys: the adapter's `agent` is forwarded as `owner: agent`, so what matters is
  // that the field is used on the way through, whatever it is called on the other side.
  const forwarded = index.match(/tasks\.enqueue\(\{([^}]*)\}\)/)[1].match(/[A-Za-z_$][\w$]*/g)
  for (const f of passed) {
    assert.ok(taken.includes(f), `orchestrator.enqueue does not accept ${f}`)
    assert.ok(forwarded.includes(f), `${f} never reaches the task record`)
  }
})

test('a task keeps who decides it: on the record, in the list, on disk, through a restart, and in its result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-tasks-'))
  const file = join(dir, 'tasks.jsonl')
  const ran = []
  const { tasks } = harness({ file, run: async (t) => { ran.push(t.decider); return 'the report' } })
  const laya = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser', decider: 'laya' })
  const jev = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/other', task: 'fix the lexer' })
  assert.equal(tasks.get(laya.jobId).decider, 'laya', 'the list shows who decides it')
  assert.equal(tasks.get(jev.jobId).decider, 'jev', 'a task queued with no decider is Jev\'s, as every task was')
  for (let i = 0; i < 20; i++) await tick()
  assert.deepEqual(ran.sort(), ['jev', 'laya'], 'run() is handed it, so route() asks that one when the task runs')
  const result = tasks.results('s1').find((r) => r.jobId === laya.jobId)
  assert.equal(result.decider, 'laya', 'and so is the result the chat posts')
  await tasks.flushed()
  const onDisk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.deepEqual(onDisk.map((r) => [r.jobId, r.decider]).sort(), [[laya.jobId, 'laya'], [jev.jobId, 'jev']].sort())
  // A restart reads it back; a row an older build wrote without one is Jev's.
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ jobId: 'jev-99', sessionId: 's1', workspace: 'C:/old', task: 'old one', state: 'completed', deliveryState: 'delivered' })}\n`)
  const again = harness({ file, run: async () => 'never' })
  await again.tasks.ready
  assert.equal(again.tasks.get(laya.jobId).decider, 'laya')
  assert.equal(again.tasks.get('jev-99').decider, 'jev')
})

// ---------------------------------------------------------------- the waiting line, second pass

/** createTasks over real lanes, whose run() joins the task's lane as index.js's does and holds it until let go. */
function queue({ max = null, file = join(mkdtempSync(join(tmpdir(), 'kz-f4-')), 'tasks.jsonl'), keyOf = (t) => laneKey(t.workspace), wait } = {}) {
  const lanes = createLanes({ max })
  const jobs = fakeJobs()
  const holds = new Map()
  const tasks = createTasks({
    file, lanes, jobs: () => jobs, wait,
    run: (t, { signal, emit, onEntry }) => lanes.acquire(keyOf(t), t.jobId, signal, { who: { kind: 'task', decider: t.decider }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) })
      .then((release) => { onEntry({ id: `run-${t.jobId}` }); return new Promise((res) => holds.set(t.task, () => { release(); res(`${t.task} report`) })) }),
  })
  return { lanes, tasks, holds, file }
}
const own = { owner: {}, sessionId: 's1' }

test('a task is in its line before enqueue returns, so the chat says what the work board will', async () => {
  const { tasks, holds } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  const now = tasks.get(b.jobId)
  assert.ok(now.waiting, 'no tick later: it already stands in its line')
  assert.deepEqual([now.position, now.waiting.placeText], [2, '2nd in line'])
  for (let i = 0; i < 5; i++) await tick()
  holds.get('a')()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('b')()
})

test('a task that leaves the line stops saying why it waited', async () => {
  const { tasks, holds } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(b.jobId).progressText, WAITING.workspace)
  holds.get('a')()
  for (let i = 0; i < 5; i++) await tick()
  const v = tasks.get(b.jobId)
  assert.equal(v.state, 'routing')
  assert.notEqual(v.progressText, WAITING.workspace, 'its last line is no longer a reason to wait that has ended')
  assert.equal(v.progressText, 'Starting')
  holds.get('b')()
})

test('a task taken out of the line keeps no Waiting phase on its stopped row', async () => {
  const { tasks, holds } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.stop(b.jobId, { onlyIfWaiting: true }), 'requested')
  for (let i = 0; i < 5; i++) await tick()
  const v = tasks.get(b.jobId)
  assert.deepEqual([v.state, v.terminalReason, v.phase], ['stopped', 'removed from the line before it started', null])
  holds.get('a')()
})

test('a task still in line when the app closed comes back as one that never started', async () => {
  const { tasks, holds, file } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'running' })
  const q = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'waiting' })
  for (let i = 0; i < 5; i++) await tick()
  await tasks.flushed()
  const again = queue({ file }).tasks
  await again.ready
  const r = again.get(q.jobId)
  assert.equal(r.state, 'stopped')
  assert.equal(r.terminalReason, 'the app restarted while this task waited in line, so it never started', 'not "interrupted while this task was running"')
  assert.equal(r.progressText, 'Stopped: the app was closed while this task waited in line', 'and not its last reason to wait')
  assert.equal(r.phase, null)
  assert.match(again.get(tasks.list()[0].jobId).terminalReason, /interrupted: the app restarted while this task was running/, 'one that had started is still said to have been running')
  holds.get('running')()
})

test('a run from the chat holding the workspace is named as that, and the estimate is handed who holds it', async () => {
  const asked = []
  const { lanes, tasks, holds } = queue({ wait: (w) => { asked.push(w); return null } })
  const chat = { kind: 'chat', decider: 'jev', answerOnly: false }
  const release = await lanes.acquire(laneKey('C:/w'), 'route-1', undefined, { who: chat })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  for (let i = 0; i < 3; i++) await tick()
  const w = tasks.get(b.jobId).waiting
  assert.equal(w.why, 'chat')
  assert.equal(w.text, 'Waiting: a run started from the chat is using this workspace.', 'the work board shows no task there to be "another task"')
  assert.equal(tasks.get(b.jobId).progressText, WAITING.chat)
  assert.equal(asked.at(-1).holder, chat, 'the estimate reads who holds the lane off the lane itself')
  assert.equal('holder' in w || 'aheadWho' in w, false, 'which never reaches the list')
  release()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('b')()
})

test('a task behind a run from the chat that waits in its line is told so', async () => {
  const { lanes, tasks, holds } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  for (let i = 0; i < 3; i++) await tick()
  const ac = new AbortController()
  lanes.acquire(laneKey('C:/w'), 'route-2', ac.signal, { who: { kind: 'chat', decider: 'jev' } }).catch(() => {})
  const c = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'c' })
  for (let i = 0; i < 3; i++) await tick()
  const w = tasks.get(c.jobId).waiting
  assert.ok(w)
  assert.equal(w.placeText, '3rd in line')
  assert.match(w.text, /1 run from the chat waits ahead of it in this line\./, 'its place counts a run the board has no row for')
  ac.abort()
  holds.get('a')()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('c')()
})

test('a waiting task whose next slot another workspace takes first says so, with no figure', async () => {
  const { lanes, tasks, holds } = queue({ max: 1, wait: () => ({ lowMs: 1, highMs: 2, n: 5, text: 'never shown' }) })
  const a = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a1' })
  for (let i = 0; i < 3; i++) await tick()
  const ac = new AbortController()
  lanes.acquire(laneKey('C:/b'), 'b1', ac.signal, { who: { kind: 'task', decider: 'jev' } }).catch(() => {})
  const a2 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'a2' })
  for (let i = 0; i < 3; i++) await tick()
  const w = tasks.get(a2.jobId).waiting
  assert.equal(w.slotsAhead, 1)
  assert.match(w.text, /^Waiting: another task is running in this workspace\. 1 task waiting in another workspace takes a free slot before this one\./)
  ac.abort()
  holds.get('a1')()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('a2')()
  assert.ok(a)
})

test('a wait for a free slot says what holds the slots, none of which may be on this board', async () => {
  const { lanes, tasks, holds } = queue({ max: 2 })
  const bench = await lanes.acquire(laneKey('C:/scratch/t1'), 'benchmark-1', undefined, { who: { kind: 'benchmark' } })
  const chat = await lanes.acquire(laneKey('C:/x'), 'route-3', undefined, { who: { kind: 'chat', decider: 'jev' } })
  const t = tasks.enqueue({ ...own, workspace: 'C:/w', task: 't' })
  for (let i = 0; i < 3; i++) await tick()
  assert.equal(tasks.get(t.jobId).waiting.text, 'Waiting for a free slot: the resource budget caps how many tasks run at once. Tasks at once: 2 of 2 in use (1 run from the chat and 1 capability benchmark task).')
  lanes.setMax(1)
  bench()
  assert.equal(tasks.get(t.jobId).waiting.text, 'Waiting for a free slot: the resource budget caps how many tasks run at once. Tasks at once: 1 of 1 in use (1 run from the chat).')
  chat()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('t')()
})

test('an estimate that failed says so on the line, rather than looking like a short record', async () => {
  const logged = []
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({ file: join(mkdtempSync(join(tmpdir(), 'kz-f4-')), 'tasks.jsonl'), lanes, jobs: () => jobs, log: (m) => logged.push(m), wait: () => { throw new Error('history unreadable') },
    run: (t, { signal, emit }) => lanes.acquire(laneKey(t.workspace), t.jobId, signal, { onWait: (why) => emit({ type: 'queued', text: WAITING[why] }) }).then(() => new Promise(() => {})) })
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  for (let i = 0; i < 5; i++) await tick()
  const w = tasks.get(b.jobId).waiting
  assert.equal(w.estimate, null)
  assert.equal(w.text, 'Waiting: another task is running in this workspace. No estimate: working it out failed, and the server log says why.')
  assert.match(logged.join('\n'), /history unreadable/)
})

// ---------------------------------------------------------------- the task's key, its plan, and what marks a result read

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const rowsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('delivered() on a running task returns false, deliveryState stays pending, and the later delivery posts exactly once', async () => {
  let finish = null
  let delivery
  const posted = []
  const own = { whenIdle: async () => {}, session: { append: (_type, msg) => posted.push(msg) } }
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes: createLanes(),
    jobs: () => fakeJobs(),
    run: (t, { onEntry }) => { onEntry({ id: 'run-1' }); return new Promise((r) => { finish = () => r('the report') }) },
    // Posted the moment it settles, as index.js wires it.
    onSettled: (result, owner) => { delivery.deliverWithRetry(result, owner).catch(() => {}) },
  })
  delivery = createDelivery({ tasks, setTimer: () => {} })
  const t = tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  for (let i = 0; i < 5 && !finish; i++) await tick()
  assert.equal(tasks.get(t.jobId).state, 'routing', 'it is running')
  // An acknowledgement of its id while it runs: an old notice in the chat under an id the engine handed out again.
  assert.equal(tasks.delivered(t.jobId), false, 'a running task has no result to mark read')
  assert.equal(tasks.delivered(t.jobId, { name: 'fix the parser' }), false, 'not even under its own name')
  assert.deepEqual([tasks.get(t.jobId).deliveryState, tasks.get(t.jobId).deliveredAt], ['pending', null])
  finish()
  for (let i = 0; i < 20 && !posted.length; i++) await tick()
  assert.equal(posted.length, 1, 'its result posts once it ends')
  assert.equal(posted[0].source.summary, `${t.jobId} · fix the parser · Completed`)
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivering', 'and it is unread until the browser says it rendered it')
  assert.equal(tasks.delivered(t.jobId, { name: 'fix the parser' }), true, 'which it then says, under the task\'s name')
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(posted.length, 1, 'posted exactly once')
  assert.equal(tasks.get(t.jobId).deliveryState, 'delivered')
})

test('delivered() refuses a task still waiting in line, which has no result either', async () => {
  const { tasks, holds } = queue()
  tasks.enqueue({ ...own, workspace: 'C:/w', task: 'a' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'b' })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(tasks.get(b.jobId).state, 'queued')
  assert.equal(tasks.delivered(b.jobId, { name: 'b' }), false)
  assert.equal(tasks.get(b.jobId).deliveryState, 'pending')
  holds.get('a')()
  for (let i = 0; i < 5; i++) await tick()
  holds.get('b')()
  for (let i = 0; i < 5 && tasks.get(b.jobId).state !== 'completed'; i++) await tick()
  assert.ok(tasks.results('s1').some((r) => r.jobId === b.jobId), 'its result is on offer once it ends')
})

test('delivered() with a name that is not the task\'s leaves it unread (a job id reused after a restart)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const first = harness({ file, run: async () => 'the parser report' })
  await first.tasks.ready
  const old = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  for (let i = 0; i < 10; i++) await tick()
  // Its notice is posted (delivery claims it first), and the browser says it rendered it.
  first.tasks.delivering(old.jobId)
  assert.equal(first.tasks.delivered(old.jobId, { name: 'fix the parser' }), true, 'its own name marks it read')
  await first.tasks.flushed()
  // The app restarts, and the engine counts its job ids from 1 again.
  const second = harness({ file, run: async () => 'the lexer report' })
  await second.tasks.ready
  const now = second.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the lexer · then the docs' })
  assert.equal(now.jobId, old.jobId, 'the new task has the old one\'s job id')
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(second.tasks.get(now.jobId).state, 'completed')
  // Its notice is posted beside the old task's, which is still in the chat, and a fresh page
  // acknowledges both by their ids and names.
  second.tasks.delivering(now.jobId)
  assert.equal(second.tasks.delivered(now.jobId, { name: 'fix the parser' }), false, 'another task\'s name marks nothing read')
  assert.equal(second.tasks.get(now.jobId).deliveryState, 'delivering', 'the new result is still unread')
  // Its own notice names it, however the separator is spaced.
  assert.equal(second.tasks.delivered(now.jobId, { name: 'fix the lexer·then the docs' }), true)
  assert.equal(second.tasks.get(now.jobId).deliveryState, 'delivered')
})

test('an old notice naming the same task under a reused job id cannot mark the new result read before its own notice has posted', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  // Before the restart: 'run the tests' ran as jev-1, its notice was posted, and the browser said it rendered it.
  const first = harness({ file, run: async () => 'the first report' })
  await first.tasks.ready
  const old = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'run the tests' })
  for (let i = 0; i < 10; i++) await tick()
  first.tasks.delivering(old.jobId)
  assert.equal(first.tasks.delivered(old.jobId, { name: 'run the tests' }), true)
  await first.tasks.flushed()
  // After the restart the same words are sent again, and the engine hands the new task jev-1 too. It
  // settles while an answer is streaming, so its result waits for the chat to go idle before it posts.
  let idle
  const streaming = new Promise((r) => { idle = r })
  const posted = []
  const own = { whenIdle: () => streaming, session: { append: (_type, msg) => posted.push(msg) } }
  let delivery
  const jobs = fakeJobs()
  const tasks = createTasks({
    file, lanes: createLanes(), jobs: () => jobs, run: async () => 'the second report',
    onSettled: (result, owner) => { delivery.deliverWithRetry(result, owner).catch(() => {}) },
  })
  delivery = createDelivery({ tasks, setTimer: () => {} })
  await tasks.ready
  const now = tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'run the tests' })
  assert.equal(now.jobId, old.jobId, 'the new task has the old one\'s job id, and its name')
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual([tasks.get(now.jobId).state, tasks.get(now.jobId).deliveryState, posted.length], ['completed', 'pending', 0], 'finished, its result waiting to post')
  // A page opened now renders the old notice, which names the new task's id and name as well, and acknowledges it.
  assert.equal(tasks.delivered(now.jobId, { name: 'run the tests' }), false, 'no notice of the new task is in the chat yet')
  assert.equal(tasks.delivered(now.jobId), false, 'nor does an older page\'s bare id mark it read')
  assert.equal(tasks.get(now.jobId).deliveryState, 'pending')
  idle()
  for (let i = 0; i < 20 && !posted.length; i++) await tick()
  assert.deepEqual(posted.map((m) => m.source.summary), [`${now.jobId} · run the tests · Completed`], 'the new result posts once the chat is idle')
  // Its own notice, once rendered, marks it read.
  assert.equal(tasks.delivered(now.jobId, { name: 'run the tests' }), true)
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(posted.length, 1, 'posted exactly once')
  assert.equal(tasks.get(now.jobId).deliveryState, 'delivered')
})

/** A run of the app before a restart: `task` runs as jev-1 in chat `sessionId`, its notice is posted, and the browser says it rendered it. */
async function readBeforeRestart(file, { task = 'run the tests', sessionId = 's1' } = {}) {
  const { tasks } = harness({ file, run: async () => 'the first report' })
  await tasks.ready
  const old = tasks.enqueue({ owner: {}, sessionId, workspace: 'C:/work', task })
  for (let i = 0; i < 10; i++) await tick()
  tasks.delivering(old.jobId)
  assert.equal(tasks.delivered(old.jobId, { name: task, sessionId }), true, 'its own notice marks it read')
  await tasks.flushed()
  return old
}

/** createTasks over `file` whose results are posted the moment they settle, as index.js wires it. */
function posting(file, run) {
  let delivery
  const jobs = fakeJobs()
  const tasks = createTasks({ file, lanes: createLanes(), jobs: () => jobs, run, onSettled: (result, owner) => { delivery.deliverWithRetry(result, owner).catch(() => {}) } })
  delivery = createDelivery({ tasks, setTimer: () => {} })
  return tasks
}

test('a task the restart stopped never had a notice, so an older notice naming it under its reused job id leaves it unread, after the next restart too', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const old = await readBeforeRestart(file)
  // After the restart the same words are sent again, the engine hands the new task jev-1 too, and the
  // app is closed while it runs.
  const second = harness({ file, run: (_t, { onEntry }) => { onEntry({ id: 'run-2' }); return new Promise(() => {}) } })
  await second.tasks.ready
  const now = second.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'run the tests' })
  assert.equal(now.jobId, old.jobId, 'the new task has the old one\'s job id, and its name')
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(second.tasks.get(now.jobId).state, 'routing')
  await second.tasks.flushed()
  // The next start stops it, and nothing posts a notice of it. A page opened now renders the old
  // notice, which names it.
  const third = harness({ file })
  await third.tasks.ready
  assert.deepEqual([third.tasks.get(now.jobId).state, third.tasks.get(now.jobId).deliveryState], ['stopped', 'pending'])
  assert.equal(third.tasks.delivered(now.jobId, { name: 'run the tests', sessionId: 's1' }), false, 'no notice of it can be in the chat')
  assert.equal(third.tasks.delivered(now.jobId), false, 'nor does an older page\'s bare id mark it read')
  assert.deepEqual(third.tasks.results('s1').map((r) => r.jobId), [now.jobId], 'it stays unread, so the person is told what happened to it')
  await third.tasks.flushed()
  // It is a finished, unread record on disk now, as one a restart caught posted is, and still refused.
  const fourth = harness({ file })
  await fourth.tasks.ready
  assert.equal(fourth.tasks.delivered(now.jobId, { name: 'run the tests' }), false, 'after the next restart too')
  assert.equal(fourth.tasks.get(now.jobId).deliveryState, 'pending')
  // A task an older build left running, whose row says nothing of a notice either way, is refused alike.
  const older = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  writeFileSync(older, `${JSON.stringify({ jobId: 'jev-1', sessionId: 's1', workspace: 'C:/work', taskName: 'run the tests', taskText: 'run the tests', state: 'running', startedAt: 1, deliveryState: 'pending', seq: 3 })}\n`)
  const loaded = harness({ file: older })
  await loaded.tasks.ready
  assert.equal(loaded.tasks.get('jev-1').state, 'stopped')
  assert.equal(loaded.tasks.delivered('jev-1', { name: 'run the tests' }), false)
})

test('a result the app was closed on before it was posted stays unread after the restart, whatever older notice names it under its reused job id', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const old = await readBeforeRestart(file)
  // After the restart the same words take jev-1 again. The task ends while an answer is streaming,
  // so its result waits for the chat to go idle, and the app is closed before it does.
  const posted = []
  const own = { whenIdle: () => new Promise(() => {}), session: { append: (_type, msg) => posted.push(msg) } }
  const tasks = posting(file, async () => 'the second report')
  await tasks.ready
  const now = tasks.enqueue({ owner: own, sessionId: 's1', workspace: 'C:/work', task: 'run the tests' })
  assert.equal(now.jobId, old.jobId)
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual([tasks.get(now.jobId).state, tasks.get(now.jobId).deliveryState, posted.length], ['completed', 'pending', 0], 'finished, its result waiting to post')
  await tasks.flushed()
  // Nothing posts it after the next start, and a page opened then renders the old notice, which names it.
  const after = harness({ file })
  await after.tasks.ready
  assert.equal(after.tasks.delivered(now.jobId, { name: 'run the tests', sessionId: 's1' }), false, 'no notice of it can be in the chat')
  assert.deepEqual(after.tasks.results('s1').map((r) => [r.jobId, r.report]), [[now.jobId, 'the second report']], 'its report is still on offer, unread')
})

test('a result a restart caught posted and not yet seen is marked read by its notice, after the next restart too', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const first = harness({ file, run: async () => 'the report' })
  await first.tasks.ready
  const t = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'run the tests' })
  for (let i = 0; i < 10; i++) await tick()
  // Its notice is posted, and the app is closed before the chat is opened.
  first.tasks.delivering(t.jobId)
  await first.tasks.flushed()
  const second = harness({ file })
  await second.tasks.ready
  assert.equal(second.tasks.get(t.jobId).deliveryState, 'pending', 'on offer again')
  await second.tasks.flushed()
  // Closed once more before the chat was opened: its notice is still in the chat, and the row the
  // browser renders marks it read.
  const third = harness({ file })
  await third.tasks.ready
  assert.equal(third.tasks.delivered(t.jobId, { name: 'run the tests', sessionId: 's1' }), true)
  assert.equal(third.tasks.get(t.jobId).deliveryState, 'delivered')
})

test('delivered() with the chat named: an older notice in another chat under a reused job id and the same name leaves the new result unread', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const old = await readBeforeRestart(file, { sessionId: 'chat-A' })
  // After the restart the same words, sent in chat B, take jev-1 again, and the result is posted there.
  const posted = []
  const own = { whenIdle: async () => {}, session: { append: (_type, msg) => posted.push(msg) } }
  const tasks = posting(file, async () => 'the second report')
  await tasks.ready
  const now = tasks.enqueue({ owner: own, sessionId: 'chat-B', workspace: 'C:/work', task: 'run the tests' })
  assert.equal(now.jobId, old.jobId)
  for (let i = 0; i < 20 && !posted.length; i++) await tick()
  assert.equal(posted.length, 1)
  assert.equal(tasks.get(now.jobId).deliveryState, 'delivering', 'posted in chat B, and not seen there yet')
  // Chat A is on screen, and its old row names the new task's id and name.
  assert.equal(tasks.delivered(now.jobId, { name: 'run the tests', sessionId: 'chat-A' }), false, 'a row in another chat marks nothing read')
  assert.equal(tasks.get(now.jobId).deliveryState, 'delivering')
  assert.equal(tasks.delivered(now.jobId, { name: 'run the tests', sessionId: 'chat-B' }), true, 'its own row in chat B does')
  assert.equal(tasks.get(now.jobId).deliveryState, 'delivered')
})

test('each task gets a key, kept across a restart, and a reused job id gets a different key', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const first = harness({ file, run: async () => 'the report' })
  await first.tasks.ready
  const a = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'fix the parser' })
  const b = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'fix the lexer' })
  const keyA = first.tasks.get(a.jobId).key
  const keyB = first.tasks.get(b.jobId).key
  assert.match(String(keyA), UUID, 'the list shows each task\'s key')
  assert.notEqual(keyB, keyA, 'and no two tasks share one')
  for (let i = 0; i < 10; i++) await tick()
  await first.tasks.flushed()
  assert.deepEqual(rowsOf(file).map((r) => [r.jobId, r.key]), [[a.jobId, keyA], [b.jobId, keyB]], 'both keys are on disk')
  // The app restarts: every task keeps its key, and the engine counts job ids from 1 again.
  const second = harness({ file, run: async () => 'the report' })
  await second.tasks.ready
  assert.deepEqual([second.tasks.get(a.jobId).key, second.tasks.get(b.jobId).key], [keyA, keyB], 'a restart keeps each key')
  const reused = second.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'fix the docs' })
  assert.equal(reused.jobId, a.jobId, 'the engine hands the old job id out again')
  assert.match(String(second.tasks.get(reused.jobId).key), UUID)
  assert.notEqual(second.tasks.get(reused.jobId).key, keyA, 'the new task under it has a key of its own')
  // A record an older build wrote, with no key, is given one as it loads, and keeps it through the next restart.
  const older = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  writeFileSync(older, `${JSON.stringify({ jobId: 'jev-7', sessionId: 's1', workspace: 'C:/old', taskName: 'old one', taskText: 'old one', state: 'completed', deliveryState: 'delivered', seq: 3 })}\n`)
  const loaded = harness({ file: older })
  await loaded.tasks.ready
  const given = loaded.tasks.get('jev-7').key
  assert.match(String(given), UUID, 'a record from before keys gets one')
  await loaded.tasks.flushed()
  const reloaded = harness({ file: older })
  await reloaded.tasks.ready
  assert.equal(reloaded.tasks.get('jev-7').key, given, 'and keeps it')
})

test('a task\'s plan is saved in tasks.jsonl, and a restart keeps it', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const first = harness({
    file,
    run: async (t, { emit, onEntry }) => {
      onEntry({ id: 'run-1' })
      emit({
        type: 'routed', routing: { primaryAgent: 'codex', mode: 'jev' },
        primary: { agent: 'codex', model: 'codex-model', effort: 'high', level: 'high', speed: null },
        planner: { agent: 'claude', model: 'claude-model' }, reviewer: { agent: 'deepseek', model: null },
      })
      return 'the report'
    },
  })
  await first.tasks.ready
  const t = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  for (let i = 0; i < 10 && first.tasks.get(t.jobId).state !== 'completed'; i++) await tick()
  await first.tasks.flushed()
  const planned = { agent: 'codex', model: 'codex-model', effort: 'high', level: 'high', speed: null, planner: { agent: 'claude', model: 'claude-model' }, reviewer: { agent: 'deepseek', model: null } }
  assert.deepEqual(rowsOf(file).find((r) => r.jobId === t.jobId)?.plan, planned, 'the plan is on the task\'s row')
  const second = harness({ file })
  await second.tasks.ready
  assert.deepEqual(second.tasks.get(t.jobId).plan, planned, 'and a restart keeps it')
})

test('a routed plan says a local model goes first only when it keeps one in front of the routed resource, which takes over if it fails', async () => {
  /** The plan a task keeps from a LOCAL_FIRST routing whose primary step is `worker` and whose pick is `pick`. */
  const planOf = async (worker, pick, routing = {}, strategy = 'LOCAL_FIRST') => {
    const { tasks } = harness({
      run: async (t, { emit, onEntry }) => {
        onEntry({ id: 'run-1' })
        emit({
          type: 'routed', routing: { primaryAgent: pick, mode: 'jev', strategy, ...routing },
          plan: { strategy, steps: [{ role: 'primary', agent: worker }], reviewer: null, forceReview: false, parallelWith: null },
          primary: { agent: worker, model: `${worker}-model`, effort: null, level: null, speed: null },
        })
        return 'the report'
      },
    })
    await tasks.ready
    const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
    for (let i = 0; i < 10 && tasks.get(t.jobId).state !== 'completed'; i++) await tick()
    return tasks.get(t.jobId).plan
  }
  assert.equal((await planOf('qwen-local', 'claude'))?.localFirst, true, 'the local model works first, and claude, the pick, takes over if it fails')
  assert.equal((await planOf('claude', 'claude', { capabilityFrom: 'qwen-local' }))?.localFirst, undefined, 'a capability the local model lacked moved the pick off it and gave its step to claude, which works from the start')
  assert.equal((await planOf('claude', 'claude', { feedbackFrom: 'qwen-local' }))?.localFirst, undefined, 'and so did your feedback')
  assert.equal((await planOf('qwen-local', 'qwen-local'))?.localFirst, undefined, 'a local model that is the pick itself was promised no one to take over')
  assert.equal((await planOf('claude', 'claude', {}, 'STANDARD_DIRECT'))?.localFirst, undefined)
})

test('a task whose plan keeps a local model in front of the routed resource names that local model from the pick on, as its reply did: in its row, in what a direct answer is told, and in its result, stopped or caught by a restart before its attempt starts', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  let routed = false
  const first = harness({
    file,
    run: async (t, { emit, onEntry, signal }) => {
      onEntry({ id: 'run-1' })
      // As router.js emits it for LOCAL_FIRST: the routing picked claude, and the plan puts the local
      // model to work first, claude taking over only if it fails. The run then holds before any
      // attempt starts, as it does while the baseline checks run.
      emit({
        type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev', strategy: 'LOCAL_FIRST' },
        plan: { strategy: 'LOCAL_FIRST', steps: [{ role: 'primary', agent: 'qwen-local' }], reviewer: null, forceReview: false, parallelWith: null },
        primary: { agent: 'qwen-local', model: 'qwen3-8b', effort: null, level: null, speed: null },
      })
      routed = true
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  await first.tasks.ready
  const t = first.tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser' })
  for (let i = 0; i < 10 && !routed; i++) await tick()
  const view = first.tasks.get(t.jobId)
  assert.equal(view.agent, 'qwen-local', 'the row names the local model, not claude, which works only if the local model fails')
  assert.deepEqual([view.state, view.plan?.agent, view.plan?.localFirst], ['running', 'qwen-local', true], 'the plan its start reply names')
  const names = { 'qwen-local': 'Qwen (local)', claude: 'Claude Code' }
  const { liveStatusSentence } = await import('../reply-words.js')
  assert.match(liveStatusSentence([view], names), /^Right now in this chat: jev-1 is running on Qwen \(local\) \(/, 'a direct answer is told the local model runs it')
  const headOf = (r) => /^Agent: .*$/m.exec(resultSection(r, { names }))?.[0]
  // The app restarts before its attempt starts.
  await first.tasks.flushed()
  const after = harness({ file })
  await after.tasks.ready
  const [caught] = after.tasks.results('s1')
  assert.deepEqual([caught?.state, caught?.agent, caught?.effort], ['stopped', 'qwen-local', null], 'caught by a restart, it names the local model')
  assert.match(headOf(caught) ?? '', /^Agent: Qwen \(local\) · took \d+ s$/)
  // And, in the app that ran it, it is stopped before its attempt starts.
  first.tasks.stop(t.jobId)
  for (let i = 0; i < 10 && !first.tasks.results('s1').length; i++) await tick()
  const [stopped] = first.tasks.results('s1')
  assert.deepEqual([stopped?.state, stopped?.agent, stopped?.effort], ['stopped', 'qwen-local', null], 'stopped, it names the local model its reply named, and no effort')
  assert.match(headOf(stopped) ?? '', /^Agent: Qwen \(local\) · took \d+ s$/, 'not claude, which never ran')
})

test('a task keeps the intent sample it was queued with: on the record its run reads, and on disk', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const read = []
  const { tasks } = harness({ file, run: async (t) => { read.push(t.intentSample); return 'the report' } })
  await tasks.ready
  const sampled = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/a', task: 'fix the parser', intentSample: 'sample-1' })
  const plain = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/b', task: 'fix the lexer' })
  for (let i = 0; i < 10; i++) await tick()
  assert.deepEqual(read, ['sample-1', null], 'route() is handed it, for the run\'s history row')
  await tasks.flushed()
  assert.deepEqual(rowsOf(file).map((r) => [r.jobId, r.intentSample]), [[sampled.jobId, 'sample-1'], [plain.jobId, null]])
})

test('watch hears the task\'s router events; planGen is 2 after a read-pass handback and a writer pass; no watcher is left after 100 enqueue and settle cycles', async () => {
  const lanes = createLanes()
  const jobs = fakeJobs()
  const routed = (agent) => ({ type: 'routed', routing: { primaryAgent: agent, mode: 'jev' }, primary: { agent, model: `${agent}-model`, effort: 'high', level: 'high', speed: null } })
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    // index.js's runner: a task judged read only runs a read pass, which here is routed and then
    // hands the task to its folder's line, and runs again as work that writes, routed once more.
    run: (t, { signal, emit, onEntry }) => runAdmitted({ lanes, task: t, signal, run: async (pass) => {
      onEntry({ id: `run-${t.jobId}-${pass.mode}` })
      emit(routed(pass.mode === 'read' ? 'claude' : 'codex'))
      if (pass.mode === 'read') {
        emit({ type: 'access', mode: 'write', from: 'read', why: 'it needs to change files' })
        throw needsLane('it needs to change files')
      }
      return 'the report'
    } }),
  })
  assert.equal(typeof tasks.watch, 'function', 'a task can be watched')
  const t = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'fix the parser', access: 'read' })
  const key = tasks.get(t.jobId).key
  const heard = []
  tasks.watch(key, (e, seen) => heard.push([e.type, seen.planGen, seen.plan?.agent ?? null, seen.state]))
  for (let i = 0; i < 30 && heard.at(-1)?.[0] !== 'settled'; i++) await tick()
  assert.deepEqual(heard, [
    ['routed', 1, 'claude', 'running'],
    ['access', 1, null, 'queued'],
    ['routed', 2, 'codex', 'running'],
    ['settled', 2, 'codex', 'completed'],
  ], 'each event once its record holds it, the plan cleared by the hand-back, and the end')
  const v = tasks.get(t.jobId)
  assert.deepEqual([v.planGen, v.plan], [2, { agent: 'codex', model: 'codex-model', effort: 'high', level: 'high', speed: null }])
  assert.equal(tasks.watching, 0, 'the settled task\'s watcher was let go')
  // A task that has ended, or a key nobody has, is never watched.
  const none = []
  tasks.watch(key, () => none.push('late'))
  tasks.watch('no such key', () => none.push('stray'))
  assert.equal(tasks.watching, 0)
  // One hundred tasks, each watched twice and once let go early by hand: none of it is left.
  for (let i = 0; i < 100; i++) {
    const x = tasks.enqueue({ ...own, workspace: `C:/w${i}`, task: `task ${i}` })
    const k = tasks.get(x.jobId).key
    const off = tasks.watch(k, () => {})
    tasks.watch(k, () => { throw new Error('a watcher that fails') })
    if (i % 2) off()
    for (let j = 0; j < 30 && !TERMINAL_STATES.includes(tasks.get(x.jobId).state); j++) await tick()
    assert.equal(tasks.get(x.jobId).state, 'completed', `task ${i} ran to its end, whatever its watchers did`)
  }
  assert.equal(tasks.watching, 0, 'no watcher is left')
  assert.deepEqual(none, [])
})

test('planGen counts routed events: a read pass handed back before its routing finished leaves the writer pass the task\'s first plan', async () => {
  const lanes = createLanes()
  const jobs = fakeJobs()
  const tasks = createTasks({
    file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'),
    lanes,
    jobs: () => jobs,
    // As router.js does when the routing names work that may change files, or no agent can be locked:
    // the read pass goes to its folder's line before it emits `routed`, and only the writer pass is routed.
    run: (t, { signal, emit, onEntry }) => runAdmitted({ lanes, task: t, signal, run: async (pass) => {
      onEntry({ id: `run-${t.jobId}-${pass.mode}` })
      if (pass.mode === 'read') {
        emit({ type: 'access', mode: 'write', from: 'read', why: 'Jev\'s routing named code_change, which may change files' })
        throw needsLane('Jev\'s routing named code_change, which may change files')
      }
      emit({ type: 'routed', routing: { primaryAgent: 'codex', mode: 'jev' }, primary: { agent: 'codex', model: 'codex-model', effort: 'high', level: 'high', speed: null } })
      return 'the report'
    } }),
  })
  const t = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'fix the parser', access: 'read' })
  for (let i = 0; i < 30 && tasks.get(t.jobId).state !== 'completed'; i++) await tick()
  const v = tasks.get(t.jobId)
  assert.deepEqual([v.state, v.access, v.planGen, v.plan?.agent], ['completed', 'write', 1, 'codex'], 'handed back before it was routed, so routed once, as work that writes')
})

test('a job registry at its per-owner limit fails the enqueue with \'Too many background tasks in this chat (10)...\'', async () => {
  // The engine's own refusal (dsh-jobs-local 0.1.5-rc.2), raised before it starts the job.
  const refusing = (limit) => ({ start: () => { throw new Error(`background job limit reached for this owner (limit: ${limit}); use job_kill to stop an unneeded job, wait for it to finish, then retry`) } })
  let ran = false
  const at = (limit) => createTasks({ file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'), lanes: createLanes(), jobs: () => refusing(limit), run: async () => { ran = true; return 'x' } })
  const tasks = at(10)
  await tasks.ready
  assert.throws(() => tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'one too many' }), { message: 'Too many background tasks in this chat (10). Wait for one to finish or remove a waiting one, then send it again.' })
  assert.deepEqual([tasks.list(), ran], [[], false], 'nothing was queued and nothing ran')
  assert.throws(() => at(32).enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'one too many' }), /^Error: Too many background tasks in this chat \(32\)\./, 'the figure is the engine\'s')
  // No job service serving this chat still runs the task in the chat, as it always did.
  const none = createTasks({ file: join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl'), lanes: createLanes(), jobs: () => ({ start: () => { throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)') } }), run: async () => 'x' })
  assert.equal(none.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'x' }), null)
})

test('startedNoticeDue: null while the reply is pending, null when the reply named gen 1, \'started\' when it named none, \'again\' after a read-pass hand-back, at gen 2 and at gen 1 alike, \'change\' when said differs from the plan; progressPosted survives a restart', async () => {
  const { startedNoticeDue } = await import('../tasks.js')
  assert.equal(typeof startedNoticeDue, 'function', 'tasks.js says which milestone notice a task is owed')
  const plan = { agent: 'claude', model: 'claude-model', effort: 'high', level: 'high', speed: null }
  const said = { agent: 'claude', effort: 'high' }
  const task = (over = {}) => ({ state: 'running', plan, planGen: 1, ackGen: null, said: null, progressPosted: {}, requeuedAt: null, ...over })
  assert.equal(startedNoticeDue(task()), null, 'the reply is still out: it may yet name the plan')
  assert.equal(startedNoticeDue(task({ ackGen: 1, said })), null, 'the reply named gen 1')
  assert.equal(startedNoticeDue(task({ ackGen: 0 })), 'started', 'the reply named none')
  assert.equal(startedNoticeDue(task({ ackGen: 0, plan: null, planGen: 0 })), null, 'not picked yet')
  assert.equal(startedNoticeDue(task({ ackGen: 0, progressPosted: { started: 1 } })), null, 'posted already for this routing')
  assert.equal(startedNoticeDue(task({ ackGen: 1, said, planGen: 2, requeuedAt: 5 })), 'again', 'handed back after it was routed: gen 2')
  assert.equal(startedNoticeDue(task({ ackGen: 0, planGen: 1, requeuedAt: 5 })), 'again', 'handed back while it was routed: gen 1 alike')
  assert.equal(startedNoticeDue(task({ ackGen: 0, planGen: 2, requeuedAt: 5, progressPosted: { started: 1 } })), 'again', 'a started notice for the read pass does not stand for the writer\'s')
  assert.equal(startedNoticeDue(task({ ackGen: 0, planGen: 2, requeuedAt: 5, progressPosted: { started: 1, again: 2 } })), null)
  assert.equal(startedNoticeDue(task({ ackGen: 0, plan: null, planGen: 1, requeuedAt: 5 })), null, 'back in line: not routed again yet')
  assert.equal(startedNoticeDue(task({ ackGen: 1, said: { agent: 'codex', effort: 'high' } })), 'change', 'another agent')
  assert.equal(startedNoticeDue(task({ ackGen: 1, said: { agent: 'claude', effort: 'xhigh' } })), 'change', 'another effort')
  assert.equal(startedNoticeDue(task({ ackGen: 1, said: { agent: 'codex', effort: 'high' }, progressPosted: { change: 1 } })), null)
  assert.equal(startedNoticeDue(task({ state: 'completed', ackGen: 0 })), null, 'a task that ended gets its result')
  assert.equal(startedNoticeDue(null), null)

  // On the record: a read pass routed and handed back, and the writer routed after it.
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  let finish
  const tasks = createTasks({
    file, lanes, jobs: () => jobs,
    run: (t, { signal, emit, onEntry }) => runAdmitted({ lanes, task: t, signal, run: async (pass) => {
      onEntry({ id: `run-${t.jobId}-${pass.mode}` })
      emit({ type: 'routed', routing: { primaryAgent: pass.mode === 'read' ? 'claude' : 'codex', mode: 'jev' }, primary: { agent: pass.mode === 'read' ? 'claude' : 'codex', model: 'm', effort: 'high', level: 'high', speed: null } })
      if (pass.mode === 'read') {
        emit({ type: 'access', mode: 'write', from: 'read', why: 'it needs to change files' })
        throw needsLane('it needs to change files')
      }
      await new Promise((r) => { finish = r })
      return 'the report'
    } }),
  })
  await tasks.ready
  const t = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'fix the parser', access: 'read' })
  const key = tasks.get(t.jobId).key
  for (let i = 0; i < 30 && !finish; i++) await tick()
  const view = () => tasks.get(t.jobId)
  assert.deepEqual([view().planGen, view().plan?.agent, view().ackGen], [2, 'codex', null], 'the writer is routed; no reply has said anything yet')
  assert.equal(startedNoticeDue(view()), null)
  assert.equal(tasks.noteAck(key, { gen: 1, said: { agent: 'claude', effort: 'high' } }), true, 'the reply named the read pass\'s plan')
  assert.deepEqual([view().ackGen, view().said], [1, { agent: 'claude', effort: 'high' }])
  assert.equal(startedNoticeDue(view()), 'again')
  assert.equal(tasks.claimNotice(key, 'again'), true)
  assert.equal(tasks.claimNotice(key, 'again'), false, 'one notice per kind per routing, whoever asks')
  assert.equal(startedNoticeDue(view()), null)
  assert.deepEqual(view().progressPosted, { again: 2 })
  assert.equal(tasks.noteAck('no such key', { gen: 0 }), false)
  assert.equal(tasks.claimNotice('no such key', 'started'), false)
  // A restart keeps what was posted, so none of it is posted again.
  await tasks.flushed()
  assert.deepEqual(rowsOf(file).find((r) => r.jobId === t.jobId)?.progressPosted, { again: 2 }, 'on disk')
  const again = harness({ file })
  await again.tasks.ready
  assert.deepEqual(again.tasks.get(t.jobId).progressPosted, { again: 2 }, 'and read back')
  assert.equal(again.tasks.get(t.jobId).state, 'stopped', 'the restart stopped it')
  assert.equal(again.tasks.noteAck(key, { gen: 0 }), false, 'an ended task hears no more of its reply')
  finish()
})

test('startedNoticeDue for a reply that named a guess before routing picked: the likely agent of a reply that waited owes the started notice when it runs and a change of plan when another does, and a tool that takes the work is a change from any agent a reply named, never from the tool it named', async () => {
  const { startedNoticeDue } = await import('../tasks.js')
  const plan = { agent: 'claude', model: 'claude-model', effort: 'high', level: 'high', speed: null }
  const task = (over = {}) => ({ state: 'running', plan, planGen: 1, ackGen: null, said: null, progressPosted: {}, requeuedAt: null, ...over })
  // Reply B named Claude Code as likely (noteAck at gen 0, with what it named).
  assert.equal(startedNoticeDue(task({ ackGen: 0, said: { agent: 'claude', effort: 'high' } })), 'started', 'the likely agent runs: the notice its reply promised')
  assert.equal(startedNoticeDue(task({ ackGen: 0, said: { agent: 'codex', effort: 'medium' } })), 'change', 'another agent runs')
  assert.equal(startedNoticeDue(task({ ackGen: 0, said: { agent: 'claude', effort: 'medium' } })), 'change', 'at another effort')
  assert.equal(startedNoticeDue(task({ ackGen: 0, said: { agent: 'codex', effort: 'medium' }, progressPosted: { change: 1 } })), null, 'once per routing')
  // A quick reply named the guessed plan (gen 1), and routing gave the work to a tool.
  const lint = { ...plan, tool: 'lint' }
  assert.equal(startedNoticeDue(task({ plan: lint, ackGen: 1, said: { agent: 'claude', effort: 'high' } })), 'change', 'the tool, not the agent that takes over only if it fails')
  assert.equal(startedNoticeDue(task({ plan: lint, ackGen: 1, said: { agent: 'tool:lint', effort: null } })), null, 'the pick it waited for named the tool')
})

test('guessMissed: routing gave the work to another worker than the agent the reply named, the one change of plan Start and result only posts, and never a change of effort alone', async () => {
  const { guessMissed } = await import('../tasks.js')
  assert.equal(typeof guessMissed, 'function', 'tasks.js says whether a guess routing did not pick is behind a change of plan')
  const plan = { agent: 'claude', model: 'claude-model', effort: 'high', level: 'high', speed: null }
  const task = (over = {}) => ({ state: 'running', plan, planGen: 1, ackGen: 1, said: null, progressPosted: {}, requeuedAt: null, ...over })
  assert.equal(guessMissed(task({ said: { agent: 'codex', effort: 'high' } })), true, 'a quick reply\'s guess that routing did not pick')
  assert.equal(guessMissed(task({ ackGen: 0, said: { agent: 'codex', effort: 'medium' } })), true, 'a likely agent that routing did not pick')
  assert.equal(guessMissed(task({ said: { agent: 'claude', effort: 'xhigh' } })), false, 'the agent it named, at another effort')
  assert.equal(guessMissed(task({ said: { agent: 'claude', effort: 'high' } })), false, 'what it named runs')
  assert.equal(guessMissed(task({ plan: { ...plan, tool: 'lint' }, said: { agent: 'claude', effort: 'high' } })), true, 'a tool took the work from the agent it named')
  assert.equal(guessMissed(task({ plan: { ...plan, tool: 'lint' }, said: { agent: 'tool:lint', effort: null } })), false, 'it named the tool')
  assert.equal(guessMissed(task({ ackGen: 0 })), false, 'it named no agent')
  assert.equal(guessMissed(task({ plan: null, said: { agent: 'codex', effort: 'high' } })), false, 'routing has not picked yet')
  assert.equal(guessMissed(null), false)
})

test('a routed event for a run the router stops for a person leaves the task no plan, agent or effort, so no reply or result can name one and no started notice is due', async () => {
  const { startedNoticeDue } = await import('../tasks.js')
  assert.equal(typeof startedNoticeDue, 'function', 'tasks.js says which milestone notice a task is owed')
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  let finish
  const tasks = createTasks({
    file, lanes, jobs: () => jobs,
    run: (t, { signal, emit, onEntry }) => runAdmitted({ lanes, task: t, signal, run: async () => {
      onEntry({ id: `run-${t.jobId}` })
      // As router.js emits it for a run about to stop for a person: it names no agent to run it,
      // though its routing still says whom the decider would have picked.
      emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev', capability: 'human_required', capabilityConfidence: 0.9 }, stopsForPerson: true })
      await new Promise((r) => { finish = r })
      emit({ type: 'final', status: 'needs_human', statusReason: 'Jev read this as needing a person (confidence 0.90)' })
      return 'the report'
    } }),
  })
  await tasks.ready
  // Queued at a level picked in the model menu, which no attempt of this run ever starts at.
  const t = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'deploy it to production with my keys', effort: 'xhigh' })
  const key = tasks.get(t.jobId).key
  for (let i = 0; i < 30 && !finish; i++) await tick()
  assert.equal(tasks.noteAck(key, { gen: 0, said: null }), true, 'its reply named no plan')
  const view = tasks.get(t.jobId)
  assert.deepEqual([view.plan, view.planGen], [null, 0], 'no plan, and no routing that planned one')
  assert.equal(startedNoticeDue(view), null, 'no agent starts, so no notice says one did')
  assert.deepEqual([view.agent, view.model, view.effort], [null, null, null], 'nor an agent, a model or an effort, whatever it was queued at')
  finish()
  for (let i = 0; i < 30 && !tasks.results('s1').length; i++) await tick()
  const [result] = tasks.results('s1')
  assert.deepEqual([result?.state, result?.agent, result?.model, result?.effort], ['needs_human', null, null, null], 'so its result names none of them either')
})

test('a routed task shows no effort until its working attempt starts at its own, so one stopped before that names none in its result', async () => {
  let go
  let started
  const { tasks } = harness({
    run: async (t, { emit, onEntry, signal }) => {
      await new Promise((r) => { go = r })
      onEntry({ id: 'run-1' })
      emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev' }, primary: { agent: 'claude', model: 'claude-model', effort: 'high', level: 'high', speed: null } })
      started = true
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  await tasks.ready
  const t = tasks.enqueue({ owner: {}, sessionId: 's1', workspace: 'C:/work', task: 'fix the parser', effort: 'xhigh' })
  assert.equal(tasks.get(t.jobId).effort, 'xhigh', 'waiting, it shows the level it was queued at')
  go()
  for (let i = 0; i < 10 && !started; i++) await tick()
  assert.deepEqual([tasks.get(t.jobId).agent, tasks.get(t.jobId).effort], ['claude', null], 'routed, it shows the agent picked and no effort: no attempt has started at one')
  tasks.stop(t.jobId)
  for (let i = 0; i < 10 && !tasks.results('s1').length; i++) await tick()
  const [result] = tasks.results('s1')
  assert.deepEqual([result?.state, result?.agent, result?.effort], ['stopped', 'claude', null], 'stopped before its first attempt, it names the agent picked and no effort')
})

test('a forced agent that ends before its working attempt starts names no effort in its row or its result, whatever level it was queued at: refused before it was routed, removed from the line, or caught in line by a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  let release = null
  const tasks = createTasks({
    file, lanes, jobs: () => jobs,
    run: (t, { signal, emit, onEntry }) => runAdmitted({ lanes, task: t, signal, run: async () => {
      onEntry({ id: `run-${t.jobId}` })
      // The router refuses the agent asked for before it routes anything, as one at its usage limit.
      if (t.task === 'refused') throw new Error('claude is at its usage limit until 14:20')
      // The one holding the folder is routed, and its working attempt starts at its own effort.
      emit({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'manual' }, primary: { agent: 'claude', model: 'claude-model', effort: 'high', level: 'high', speed: null } })
      emit({ type: 'attempt_start', index: 0, agent: 'claude', role: 'primary', effort: 'high' })
      await new Promise((r) => { release = r })
      return 'the report'
    } }),
  })
  await tasks.ready
  const names = { claude: 'Claude Code', deepseek: 'DeepSeek agent' }
  const headOf = (r) => /^Agent: .*$/m.exec(resultSection(r, { names }))?.[0]
  const resultOf = async (jobId) => {
    for (let i = 0; i < 30 && !tasks.results('s1').some((r) => r.jobId === jobId); i++) await tick()
    return tasks.results('s1').find((r) => r.jobId === jobId)
  }
  // Each is an agent picked in the model menu at a level. This one is refused before it is routed.
  const refused = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'refused', forceAgent: 'claude', effort: 'high' })
  const one = await resultOf(refused.jobId)
  assert.deepEqual([one?.state, one?.agent, one?.effort], ['failed', 'claude', null], 'refused before it was routed, it never ran at that level')
  assert.match(headOf(one) ?? '', /^Agent: Claude Code · took \d+ s$/, 'so its result\'s head names none')
  assert.equal(tasks.get(refused.jobId).effort, null, 'nor does its row')
  // One holds the folder, and the next waits behind it and is removed from the line.
  const holder = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'holder', forceAgent: 'claude', effort: 'high' })
  for (let i = 0; i < 30 && !release; i++) await tick()
  const removed = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'removed', forceAgent: 'deepseek', effort: 'medium' })
  assert.deepEqual([tasks.get(removed.jobId).state, tasks.get(removed.jobId).effort], ['queued', 'medium'], 'waiting, it shows the level it was queued at')
  assert.equal(tasks.stop(removed.jobId, { onlyIfWaiting: true }), 'requested')
  const two = await resultOf(removed.jobId)
  assert.deepEqual([two?.state, two?.agent, two?.effort], ['stopped', 'deepseek', null], 'removed from the line, it never ran at that level')
  assert.equal(headOf(two), 'Agent: DeepSeek agent')
  assert.equal(tasks.get(removed.jobId).effort, null)
  // Another waits behind the holder as the app restarts, which stops both: only the holder, whose
  // working attempt had started, names an effort, its own.
  const caught = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'caught', forceAgent: 'deepseek', effort: 'max' })
  await tasks.flushed()
  const after = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'never' })
  await after.ready
  const byId = Object.fromEntries(after.results('s1').map((r) => [r.jobId, r]))
  assert.deepEqual([byId[caught.jobId]?.state, byId[caught.jobId]?.agent, byId[caught.jobId]?.effort], ['stopped', 'deepseek', null], 'caught in line by the restart, it never ran at that level')
  assert.equal(headOf(byId[caught.jobId]), 'Agent: DeepSeek agent')
  assert.equal(after.get(caught.jobId).effort, null)
  assert.deepEqual([byId[holder.jobId]?.state, byId[holder.jobId]?.effort], ['stopped', 'high'], 'the holder had started at its own, and keeps it')
  release()
})

// ---------------------------------------------------------------- what a task's work is doing now, and what goes when it does

test('a task\'s activity is worked out as the list is read and never saved, and a task trimmed or cleared away takes its live transcript along', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const jobs = fakeJobs()
  const gone = []
  const logged = []
  let failsFor = null
  const tasks = createTasks({
    file, lanes: createLanes(), jobs: () => jobs, max: 2, log: (m) => logged.push(m),
    run: async (t, { onEntry }) => { onEntry({ id: `run-${t.taskText}` }); return 'the report' },
    // What live.js activityOfRuns would say, from the task's runs; one task's reading fails.
    activity: (t) => { if (t.taskText === 'b') throw new Error('no live view of it'); return { phrase: `Working on ${t.runIds.join(', ')}` } },
    onDrop: (key) => { gone.push(key); if (key === failsFor) throw new Error('the folder is locked') },
  })
  await tasks.ready
  const [a, b] = ['a', 'b'].map((task) => tasks.enqueue({ ...own, workspace: `C:/${task}`, task }))
  for (let i = 0; i < 30; i++) await tick()
  assert.deepEqual(tasks.list().map((t) => [t.task, t.activity]), [['a', { phrase: 'Working on run-a' }], ['b', null]], 'one that cannot be worked out is left out')
  assert.match(logged.join('\n'), /no live activity for jev-2: no live view of it/)
  await tasks.flushed()
  assert.doesNotMatch(readFileSync(file, 'utf8'), /"activity"|Working on/, 'and none of it is saved')
  // Posted, then trimmed away by a third task: its key is handed on, once.
  tasks.delivering(a.jobId)
  tasks.delivered(a.jobId)
  tasks.enqueue({ ...own, workspace: 'C:/c', task: 'c' })
  for (let i = 0; i < 30; i++) await tick()
  assert.deepEqual(gone, [a.key])
  // Cleared, with a hook that fails: the task still leaves the list, and the failure is only logged.
  failsFor = b.key
  assert.deepEqual(tasks.clear([b.jobId]), [b.jobId])
  assert.deepEqual(gone, [a.key, b.key])
  assert.deepEqual(tasks.list().map((t) => t.task), ['c'])
  assert.match(logged.join('\n'), /what was kept beside jev-2 not dropped: the folder is locked/)
})

test('a record replaced under a job id the engine hands out again after a restart takes its live transcript along, and the task now under it keeps its own', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const first = harness({ file, run: async () => 'the report' })
  await first.tasks.ready
  const a = first.tasks.enqueue({ ...own, workspace: 'C:/a', task: 'fix the parser' })
  for (let i = 0; i < 10; i++) await tick()
  await first.tasks.flushed()
  const keyA = first.tasks.get(a.jobId).key
  // The app restarts, and the engine counts job ids from 1 again.
  const gone = []
  const jobs = fakeJobs()
  const second = createTasks({ file, lanes: createLanes(), jobs: () => jobs, run: async () => 'the report', onDrop: (key) => gone.push(key) })
  await second.ready
  const b = second.enqueue({ ...own, workspace: 'C:/a', task: 'fix the docs' })
  assert.equal(b.jobId, a.jobId, 'the engine hands the old job id out again')
  assert.deepEqual(gone, [keyA], 'the record it replaced is handed on, once')
  assert.notEqual(second.get(b.jobId).key, keyA, 'and the task now under it is not')
})

// ---- Send now, Put first in line and Steer on a waiting task (docs/live-agent-view.md Feature 5, slice 7)

/**
 * createTasks over real lanes, whose runner admits each task as index.js's does (runAdmitted) and
 * keeps the text each pass's route() is handed, read as the pass is called, as index.js reads it.
 * Each pass holds until the test ends it (`finish`), or until it is stopped.
 */
function sendNowQueue({ max = null, isLocal, file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl') } = {}) {
  const lanes = createLanes({ max })
  const jobs = fakeJobs()
  const passes = new Map() // job id -> { text, finish }
  const tasks = createTasks({
    file, lanes, jobs: () => jobs, ...(isLocal ? { isLocal } : {}),
    run: (t, { signal, emit, onEntry }) => runAdmitted({
      lanes, task: t, signal, who: { kind: 'task', decider: 'jev' },
      onWait: (why) => emit({ type: 'queued', text: WAITING[why] }),
      run: () => {
        const text = t.task
        onEntry({ id: `run-${t.jobId}` })
        return new Promise((res, rej) => {
          passes.set(t.jobId, { text, finish: () => res(`${t.jobId} report`) })
          signal.addEventListener('abort', () => rej(signal.reason), { once: true })
        })
      },
    }),
  })
  return { lanes, tasks, passes, file }
}

test('lanes.admit starts a task waiting for a slot at once, over the cap, so slots() shows 2 held of 1 and the next to end frees no slot; once both have ended only the next waiter starts', async () => {
  const lanes = createLanes({ max: 1 })
  assert.equal(typeof lanes.admit, 'function', 'the lanes start a waiting task at once (Send now)')
  const started = []
  const take = joiner(lanes, started)
  const a = take('C:/a', 'a')
  const b = take('C:/b', 'b')
  const c = take('C:/c', 'c')
  const d = take('C:/d', 'd')
  await tick()
  assert.deepEqual(started, ['a'])
  assert.deepEqual(lanes.admit(laneKey('C:/c'), 'c'), { result: 'started' })
  await tick()
  assert.deepEqual(started, ['a', 'c'], 'c went past b, which waited longer, and past the cap')
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 2, max: 1 })
  assert.equal(lanes.waitOf(laneKey('C:/b'), 'b').overCap, true, 'b is told the next run to end frees no slot')
  ;(await a)()
  await tick()
  assert.deepEqual(started, ['a', 'c'], 'one run still holds a slot, which is the cap, so b and d wait on')
  ;(await c)()
  await tick()
  assert.deepEqual(started, ['a', 'c', 'b'], 'with both ended, the one that waited longest starts, and only it')
  assert.equal(lanes.waitOf(laneKey('C:/d'), 'd').overCap, false)
  ;(await b)()
  ;(await d)()
})

test('lanes.admit moves nothing while a run holds the workspace, naming it a task\'s or a run from the chat, and an id in no line here is not waiting', async () => {
  const lanes = createLanes({ max: 3 })
  assert.equal(typeof lanes.admit, 'function', 'the lanes start a waiting task at once (Send now)')
  const k = laneKey('C:/w')
  const holder = await lanes.acquire(k, 'jev-1', undefined, { who: { kind: 'task' } })
  const second = lanes.acquire(k, 'jev-2', undefined, { who: { kind: 'task' } })
  assert.deepEqual(lanes.admit(k, 'jev-2'), { result: 'busy', holder: 'jev-1', kind: 'workspace' })
  assert.deepEqual([lanes.position(k, 'jev-1'), lanes.position(k, 'jev-2')], [0, 2], 'nothing moved')
  assert.deepEqual(lanes.slots(), { held: 1, waiting: 0, max: 3 })
  assert.deepEqual(lanes.admit(k, 'jev-9'), { result: 'not-waiting' })
  assert.deepEqual(lanes.admit(laneKey('C:/elsewhere'), 'jev-2'), { result: 'not-waiting' }, 'nor is it waiting in another lane')
  assert.deepEqual(lanes.admit(k, 'jev-1'), { result: 'not-waiting' }, 'the run holding the lane is in no line')
  holder()
  ;(await second)()
  const chat = await lanes.acquire(k, 'route-1', undefined, { who: { kind: 'chat' } })
  const third = lanes.acquire(k, 'jev-3', undefined, { who: { kind: 'task' } })
  assert.deepEqual(lanes.admit(k, 'jev-3'), { result: 'busy', holder: 'route-1', kind: 'chat' })
  assert.deepEqual(lanes.holder(k), { id: 'route-1', kind: 'chat' })
  chat()
  ;(await third)()
  assert.equal(lanes.holder(k), null)
})

test('lanes.admit: those it goes past in its own line are told again that they wait for their workspace now', async () => {
  const lanes = createLanes({ max: 1 })
  assert.equal(typeof lanes.admit, 'function', 'the lanes start a waiting task at once (Send now)')
  const told = []
  const take = (dir, id) => lanes.acquire(laneKey(dir), id, undefined, { onWait: (why) => told.push([id, why]) })
  const a = await take('C:/a', 'a')
  const w1 = take('C:/w', 'w1')
  const w2 = take('C:/w', 'w2')
  const w3 = take('C:/w', 'w3')
  assert.deepEqual(told, [['w1', 'cap'], ['w2', 'line'], ['w3', 'line']])
  told.length = 0
  assert.deepEqual(lanes.admit(laneKey('C:/w'), 'w3'), { result: 'started' })
  assert.deepEqual(told, [['w1', 'workspace'], ['w2', 'workspace']], 'each is told once, as its reason changed')
  assert.deepEqual(['w1', 'w2'].map((id) => lanes.waitOf(laneKey('C:/w'), id).why), ['workspace', 'workspace'])
  a()
  ;(await w3)()
  ;(await w1)()
  ;(await w2)()
})

test('startNow answers started, workspace-busy, chat-busy, not-waiting right after the lane admits, and already-finished', async () => {
  const { tasks, lanes, passes } = sendNowQueue({ max: 1 })
  assert.equal(typeof tasks.startNow, 'function', 'a waiting task can be sent now')
  await tasks.ready
  const a = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'A' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/b', task: 'B' })
  const a2 = tasks.enqueue({ ...own, workspace: 'C:/a', task: 'A2' })
  await tick()
  assert.deepEqual([b, a2].map((t) => tasks.get(t.jobId).waiting.why), ['cap', 'workspace'])
  assert.equal(tasks.startNow(a2.key), 'workspace-busy', 'never past the task writing in its folder')
  assert.equal(tasks.get(a2.jobId).position, 2, 'and nothing moved')
  assert.equal(tasks.startNow(b.key), 'started')
  assert.equal(tasks.get(b.jobId).state, 'queued', 'its record says so once its run has begun')
  assert.equal(tasks.startNow(b.key), 'not-waiting', 'the lane has let it in')
  await tick()
  assert.equal(tasks.get(b.jobId).state, 'routing')
  assert.deepEqual(lanes.slots(), { held: 2, waiting: 0, max: 1 }, 'over the cap of 1')
  passes.get(b.jobId).finish()
  await tick()
  assert.equal(tasks.startNow(b.key), 'already-finished')
  assert.throws(() => tasks.startNow('no-such-key'), (err) => err.status === 404)
  passes.get(a.jobId).finish()
  for (let i = 0; i < 5; i++) await tick()
  passes.get(a2.jobId).finish()
  // A run from the chat holding the folder is named as that.
  const other = sendNowQueue()
  const chat = await other.lanes.acquire(laneKey('C:/c'), 'route-1', undefined, { who: { kind: 'chat' } })
  const c = other.tasks.enqueue({ ...own, workspace: 'C:/c', task: 'C' })
  await tick()
  assert.equal(other.tasks.get(c.jobId).waiting.why, 'chat')
  assert.equal(other.tasks.startNow(c.key), 'chat-busy')
  chat()
  await tick()
  assert.equal(other.tasks.get(c.jobId).state, 'routing')
  other.passes.get(c.jobId).finish()
})

test('Stop it and start this: the task holding the folder is stopped, and the waiting task takes the folder and its slot the moment they are free, before an earlier task of another folder', async () => {
  const { tasks, passes } = sendNowQueue({ max: 1 })
  assert.equal(typeof tasks.startNow, 'function', 'a waiting task can be sent now')
  const a = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'A' })
  const x = tasks.enqueue({ ...own, workspace: 'C:/x', task: 'X' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'B' })
  await tick()
  assert.equal(tasks.startNow(b.key, { stop: x.jobId }), 'workspace-busy', 'a task that does not hold its folder is not stopped for it')
  assert.equal(tasks.get(x.jobId).state, 'queued')
  assert.equal(tasks.startNow(b.key, { stop: a.jobId }), 'stopping')
  assert.equal(tasks.get(b.jobId).position, 2, 'first in its line, behind the task stopping')
  for (let i = 0; i < 10 && tasks.get(b.jobId).state === 'queued'; i++) await tick()
  assert.equal(tasks.get(a.jobId).state, 'stopped')
  assert.equal(tasks.get(a.jobId).terminalReason, 'stopped by the user')
  assert.equal(tasks.get(b.jobId).state, 'routing', 'it took the folder and the slot the stopped task let go')
  assert.equal(tasks.get(x.jobId).waiting.why, 'cap', 'the task of another folder that waited longer waits on')
  passes.get(b.jobId).finish()
  for (let i = 0; i < 5; i++) await tick()
  passes.get(x.jobId).finish()
})

test('amend adds the words to what the next pass\'s route() is handed, keeps the task\'s place, saves its steers, which a restart reads back, and answers started right after the lane admits', async () => {
  const { tasks, passes, file } = sendNowQueue()
  assert.equal(typeof tasks.amend, 'function', 'a waiting task can be steered')
  const a = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'A' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'B' })
  await tick()
  assert.equal(tasks.amend(b.key, '  also update the README  '), 'added')
  const amended = 'B\n\nAdded while it waited: also update the README'
  const v = tasks.get(b.jobId)
  assert.deepEqual([v.taskText, v.task, v.taskName], [amended, amended, 'B'], 'its name stays the one it was queued with')
  assert.deepEqual([v.state, v.position], ['queued', 2], 'it keeps its place in line')
  assert.deepEqual(v.steers.map((s) => [s.how, s.state, s.text]), [['amend', 'added', 'also update the README']])
  assert.equal(typeof v.steers[0].id, 'string')
  assert.equal(typeof v.steers[0].at, 'number')
  assert.throws(() => tasks.amend(b.key, '   '), (err) => err.status === 400, 'no words, nothing to add')
  assert.throws(() => tasks.amend('no-such-key', 'x'), (err) => err.status === 404)
  assert.equal(tasks.amend(b.key, 'x'.repeat(2500)), 'added')
  assert.equal(tasks.get(b.jobId).steers[1].text.length, 2000, 'a piece is saved clipped')
  await tasks.flushed()
  const row = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.key === b.key)
  assert.deepEqual(row.steers.map((s) => s.how), ['amend', 'amend'], 'its steers are saved')
  assert.ok(row.taskText.startsWith(amended))
  const again = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'done' })
  await again.ready
  assert.deepEqual(again.get(b.jobId).steers, tasks.get(b.jobId).steers, 'a restart reads every piece back, clipped as it was saved')
  await again.dispose()
  passes.get(a.jobId).finish()
  await tick()
  assert.ok(passes.get(b.jobId).text.startsWith(`${amended}\n\nAdded while it waited: xxx`), 'route() is handed the task with every piece added')
  assert.equal(tasks.amend(b.key, 'more'), 'started')
  // A task its lane lets in at once has started before its record says so: its run may have read it.
  const c = tasks.enqueue({ ...own, workspace: 'C:/v', task: 'C' })
  assert.equal(tasks.get(c.jobId).state, 'queued')
  assert.equal(tasks.amend(c.key, 'too late'), 'started')
  await tick()
  assert.equal(passes.get(c.jobId).text, 'C', 'nothing was added to it')
  passes.get(b.jobId).finish()
  passes.get(c.jobId).finish()
  await tick()
  assert.equal(tasks.amend(b.key, 'after'), 'already-finished')
})

test('view().controls.sendNow follows the wait reason: slot for a free slot, behind its own line\'s first, or a read-only task; workspace or chat while its folder is held; null for a task in no line', async () => {
  const { tasks, lanes, passes } = sendNowQueue({ max: 1, isLocal: (id) => id === 'qwen-local' })
  const a = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'A', forceAgent: 'qwen-local' })
  const x = tasks.enqueue({ ...own, workspace: 'C:/x', task: 'X' })
  const x2 = tasks.enqueue({ ...own, workspace: 'C:/x', task: 'X2' })
  const w2 = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'W2' })
  const r = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'R', access: 'read', readVerdict: { p: 0.9, bar: 0.8, by: 'jev', reads: true } })
  const l = tasks.enqueue({ ...own, workspace: 'C:/y', task: 'L', forceAgent: 'qwen-local' })
  await tick()
  const c = (t) => tasks.get(t.jobId).controls
  assert.ok(c(a), 'every row carries its controls')
  assert.deepEqual(c(a), { sendNow: null }, 'a task at work is in no line')
  assert.deepEqual(c(x), { sendNow: 'slot', holder: null, heldBy: null, ahead: [], chatAhead: 0, held: 1, max: 1, local: a.jobId, forcedLocal: false })
  assert.deepEqual([c(x2).sendNow, c(x2).ahead], ['slot', [x.jobId]], 'behind its own line\'s first, which waits for a slot')
  assert.deepEqual([c(w2).sendNow, c(w2).holder, c(w2).heldBy], ['workspace', a.jobId, 'task'])
  assert.deepEqual([c(r).sendNow, c(r).holder, c(r).heldBy], ['slot', a.jobId, 'task'], 'a read-only task runs beside the writer')
  assert.deepEqual([c(l).sendNow, c(l).forcedLocal], ['slot', true])
  assert.equal(tasks.startNow(w2.key), 'workspace-busy')
  // A run from the chat holding the folder.
  passes.get(a.jobId).finish()
  for (let i = 0; i < 5; i++) await tick()
  const busy = sendNowQueue()
  const chat = await busy.lanes.acquire(laneKey('C:/c'), 'route-1', undefined, { who: { kind: 'chat' } })
  const q = busy.tasks.enqueue({ ...own, workspace: 'C:/c', task: 'Q' })
  await tick()
  assert.deepEqual([busy.tasks.get(q.jobId).controls.sendNow, busy.tasks.get(q.jobId).controls.holder, busy.tasks.get(q.jobId).controls.heldBy], ['chat', null, 'chat'])
  chat()
  await tick()
  busy.passes.get(q.jobId).finish()
  for (const t of [x, x2, w2, r, l]) tasks.stop(t.jobId)
})

test('queuedWith gives what a task was queued with, for the follow-up or fresh start Steer queues after it: its chat agent, chat, folder, text, mode, decider and kinds of input, the agent it works on unless a tool took it or none is picked yet, and the effort it was asked at; nothing for a task from before a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const { tasks } = harness({ file, run: () => new Promise(() => {}) })
  assert.equal(typeof tasks.queuedWith, 'function', 'Steer queues with what a task was queued with')
  const owner = { id: 'root' }
  const a = tasks.enqueue({ owner, sessionId: 's1', workspace: 'C:/w', task: 'Fix the parser', forceAgent: 'claude', effort: 'xhigh', mode: 'online', decider: 'laya', modalities: ['text', 'image'] })
  assert.deepEqual(tasks.queuedWith(a.key), { owner, sessionId: 's1', workspace: 'C:/w', task: 'Fix the parser', mode: 'online', decider: 'laya', modalities: ['text', 'image'], agent: 'claude', effort: 'xhigh' })
  const tool = tasks.enqueue({ owner, sessionId: 's1', workspace: 'C:/v', task: 'Lint it', forceAgent: 'tool:lint', effort: 'auto' })
  const unpicked = tasks.enqueue({ owner, sessionId: 's1', workspace: 'C:/u', task: 'Tidy the docs' })
  const basis = (t) => { const q = tasks.queuedWith(t.key); return [q.agent, q.effort, q.modalities, q.mode, q.decider] }
  assert.deepEqual(basis(tool), [null, null, ['text'], 'auto', 'jev'], 'a tool\'s pick forces no agent, and Auto effort asks none')
  assert.deepEqual(basis(unpicked), [null, null, ['text'], 'auto', 'jev'], 'nor does a task whose agent is not picked yet; one queued without pictures is text')
  assert.equal(tasks.queuedWith('no-such-key'), null)
  const nobody = tasks.enqueue({ sessionId: 's1', workspace: 'C:/t', task: 'Queued by nobody' })
  assert.equal(tasks.queuedWith(nobody.key), null, 'no chat agent to queue for')
  await tasks.flushed()
  const again = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'done' })
  await again.ready
  assert.ok(again.byKey(a.key), 'the task is there after the restart')
  assert.equal(again.queuedWith(a.key), null, 'a task from before a restart has no chat agent to queue for')
  for (const t of [a, tool, unpicked, nobody]) tasks.stop(t.jobId)
})

// ---------- Steer on a running task: what becomes of each piece of guidance (docs/live-agent-view.md Feature 5, slice 8) ----------

test('noteSteer keeps each piece of guidance given to a task at work with what became of it, saved; a piece still waiting as the task ends, or as a restart stops it, was not used; its row words each piece, its result carries them, and a task at work says what Steer does now', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  const passes = new Map()
  const settled = []
  const tasks = createTasks({
    file, lanes, jobs: () => jobs, onSettled: (r) => settled.push(r),
    // What index.js answers from the attempt at work.
    steering: (t) => ({ path: 'codex', why: null, words: 'Codex takes this in at its next step.', of: t.jobId }),
    run: (t, { signal, emit, onEntry }) => runAdmitted({
      lanes, task: t, signal, who: { kind: 'task', decider: 'jev' }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }),
      run: () => { onEntry({ id: `run-${t.jobId}` }); return new Promise((res, rej) => { passes.set(t.jobId, { finish: () => res(`${t.jobId} report`) }); signal.addEventListener('abort', () => rej(signal.reason), { once: true }) }) },
    }),
  })
  assert.equal(typeof tasks.noteSteer, 'function', 'a task at work keeps the guidance it is given')
  const a = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'A' })
  const b = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'B' })
  await tick()
  const at = new Date(2026, 9, 9, 14, 2).getTime()
  tasks.noteSteer(a.key, 'g1', { text: '  use tabs  ', how: 'live', state: 'pending', agent: 'codex', name: 'Codex' })
  tasks.noteSteer(a.key, 'g2', { text: 'run the linter', how: 'live', state: 'pending', agent: 'codex', name: 'Codex' })
  const read = tasks.noteSteer(a.key, 'g1', { state: 'delivered', readAt: at })
  assert.deepEqual([read.text, read.state, read.name, typeof read.at], ['use tabs', 'delivered', 'Codex', 'number'], 'a change keeps what the piece had')
  assert.equal(tasks.noteSteer('no-such-key', 'g9', { text: 'x' }), null)
  const v = tasks.get(a.jobId)
  assert.deepEqual(v.steers.map((s) => [s.id, s.state, s.words]), [['g1', 'delivered', 'Read by Codex at 14:02'], ['g2', 'pending', 'Waiting for its next step']])
  assert.deepEqual(v.controls.steer, { path: 'codex', why: null, words: 'Codex takes this in at its next step.', of: a.jobId }, 'a task at work says what Steer does now')
  assert.equal(tasks.get(b.jobId).controls.steer, undefined, 'a waiting task is amended instead')
  // The task ends: the piece no agent read was not used, and its result says what became of each.
  passes.get(a.jobId).finish()
  for (let i = 0; i < 10 && !settled.length; i++) await tick()
  assert.deepEqual(settled[0]?.steers?.map((s) => [s.id, s.state]), [['g1', 'delivered'], ['g2', 'returned']])
  assert.equal(typeof settled[0].steers[1].endedAt, 'number')
  assert.equal(tasks.get(a.jobId).controls.steer, undefined, 'a task that ended takes no steer')
  // A piece given to b as it works, then the app restarts with b at work: that piece was not used either.
  for (let i = 0; i < 10 && tasks.get(b.jobId).state === 'queued'; i++) await tick()
  tasks.noteSteer(b.key, 'g3', { text: 'and the docs', how: 'live', state: 'pending' })
  await tasks.flushed()
  const row = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.key === a.key)
  assert.deepEqual(row.steers.map((s) => s.state), ['delivered', 'returned'], 'saved as they ended')
  const again = createTasks({ file, lanes: createLanes(), jobs: () => fakeJobs(), run: async () => 'done' })
  await again.ready
  assert.deepEqual(again.get(b.jobId).steers.map((s) => [s.id, s.state, s.words]), [['g3', 'returned', 'Not used: the work finished first']])
  assert.deepEqual(again.get(a.jobId).steers.map((s) => s.words), ['Read by Codex at 14:02', 'Not used: Codex finished first'], 'a restart reads every piece back as it was')
  await again.dispose()
  passes.get(b.jobId).finish()
})

test('noteSteer takes no new piece of guidance for a task that has ended, which takes no more words, while a piece it holds is still noted', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kz-tasks-')), 'tasks.jsonl')
  const lanes = createLanes()
  const jobs = fakeJobs()
  let finish = null
  const tasks = createTasks({
    file, lanes, jobs: () => jobs,
    run: (t, { signal, emit, onEntry }) => runAdmitted({
      lanes, task: t, signal, who: { kind: 'task', decider: 'jev' }, onWait: (why) => emit({ type: 'queued', text: WAITING[why] }),
      run: () => { onEntry({ id: `run-${t.jobId}` }); return new Promise((res) => { finish = () => res(`${t.jobId} report`) }) },
    }),
  })
  assert.equal(typeof tasks.noteSteer, 'function', 'a task at work keeps the guidance it is given')
  const a = tasks.enqueue({ ...own, workspace: 'C:/w', task: 'A' })
  for (let i = 0; i < 10 && !finish; i++) await tick()
  tasks.noteSteer(a.key, 'g1', { text: 'use tabs', how: 'live', state: 'pending' })
  finish()
  for (let i = 0; i < 10 && tasks.get(a.jobId).state !== 'completed'; i++) await tick()
  assert.equal(tasks.get(a.jobId).state, 'completed')
  assert.equal(tasks.noteSteer(a.key, 'g2', { text: 'too late', how: 'live', state: 'pending' }), null, 'a task that ended takes no more words')
  assert.deepEqual(tasks.get(a.jobId).steers.map((s) => [s.id, s.text, s.state]), [['g1', 'use tabs', 'returned']])
  assert.equal(tasks.noteSteer(a.key, 'g1', { endedAt: 7 })?.endedAt, 7, 'a piece it holds is still noted')
  await tasks.flushed()
  assert.doesNotMatch(readFileSync(file, 'utf8'), /too late/)
  await tasks.dispose()
})

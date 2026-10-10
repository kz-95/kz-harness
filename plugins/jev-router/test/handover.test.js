// The registry a closing plugin hands its work still going through, to the plugin the engine applies
// after it on the same data folder (handover.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { HANDOVER_WAIT_MS, createHandover, processHandover } from '../handover.js'

/** A clock for the bound: timers that fire when the test says. */
function fakeTimers() {
  const timers = new Set()
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.add(t); return t },
    clearTimer: (t) => { timers.delete(t) },
    fire() { for (const t of [...timers]) { timers.delete(t); t.fn() } },
    get size() { return timers.size },
  }
}

const entry = (key, seen) => ({ key, task: { key }, expire: () => seen.push(key) })

test('a plugin closing hands what it still has going to the next plugin applied on its data folder, however the path is spelled, and to no other folder', () => {
  const handover = createHandover()
  const folder = join('C:', 'Users', 'Kz', '.kzh', 'data')
  const first = handover.join(folder)
  assert.equal(first.kept, null, 'the first plugin on the folder takes over nothing')
  assert.deepEqual(first.take({ route: () => 'first' }), [])
  const lanes = { name: 'lanes' }
  const going = [entry('a', []), entry('b', [])]
  first.leave({ kept: { lanes }, tasks: going })
  assert.equal(handover.waiting(folder), true)
  // Another data folder is another plugin's: it finds nothing.
  assert.equal(handover.join(join('C:', 'Users', 'Kz', 'other')).kept, null)
  const again = handover.join(folder.toUpperCase())
  assert.equal(again.kept.lanes, lanes, 'the registries go on in the plugin applied again')
  assert.equal(first.heir(), null, 'nothing has taken the tasks over yet')
  const hooks = { route: () => 'again' }
  assert.equal(again.take(hooks), going, 'and so do the tasks still going, once')
  assert.equal(first.heir(), hooks, 'the plugin that closed reports through the one that took its work over')
  assert.equal(handover.waiting(folder), false)
  assert.deepEqual(handover.join(folder).take({}), [], 'what was taken is taken once')
})

test('what no plugin takes over within the bound expires: each task handed over is told so once, and a plugin applied after finds nothing', () => {
  const timers = fakeTimers()
  const handover = createHandover({ waitMs: 50, ...timers })
  const seen = []
  handover.join('/data').leave({ kept: { lanes: {} }, tasks: [entry('a', seen), entry('b', seen)] })
  assert.equal(timers.size, 1)
  timers.fire()
  assert.deepEqual(seen, ['a', 'b'])
  const late = handover.join('/data')
  assert.equal(late.kept, null)
  assert.deepEqual(late.take({}), [])
  assert.deepEqual(seen, ['a', 'b'], 'told once')
  assert.equal(HANDOVER_WAIT_MS, 60_000, 'a minute by default: the plugin applied again joins at once')
})

test('a plugin that joined before the bound but takes its tasks after it finds them expired, and one that took them never sees them expire', () => {
  const timers = fakeTimers()
  const handover = createHandover({ waitMs: 50, ...timers })
  const seen = []
  handover.join('/data').leave({ tasks: [entry('a', seen)] })
  const slow = handover.join('/data')
  timers.fire()
  assert.deepEqual(slow.take({}), [], 'expired before it was taken')
  assert.deepEqual(seen, ['a'])
  handover.join('/other').leave({ tasks: [entry('b', seen)] })
  const quick = handover.join('/other')
  assert.equal(quick.take({}).length, 1)
  timers.fire()
  assert.deepEqual(seen, ['a'], 'taken, so it never expires')
})

test('after a second reload the plugin that closed first reports through the newest plugin, and a close that replaces a shelf nobody took expires it', () => {
  const handover = createHandover()
  const seen = []
  const one = handover.join('/data')
  one.take({ name: 'one' })
  one.leave({ tasks: [entry('a', seen)] })
  const two = handover.join('/data')
  two.take({ name: 'two' })
  assert.equal(one.heir().name, 'two')
  two.leave({ tasks: [entry('a', seen)] })
  const three = handover.join('/data')
  three.take({ name: 'three' })
  assert.equal(one.heir().name, 'three', 'the newest plugin, through the one between')
  assert.equal(two.heir().name, 'three')
  assert.equal(three.heir(), null)
  // A plugin that closes before one applied after it has taken anything over replaces the shelf:
  // what waited on it is told it expired, and the shelf is the newest close's.
  three.leave({ tasks: [entry('b', seen)] })
  const broken = handover.join('/data')
  broken.leave({ tasks: [entry('c', seen)] })
  assert.deepEqual(seen, ['b'])
  assert.deepEqual(handover.join('/data').take({}).map((x) => x.key), ['c'])
})

test('a pass of the work a closed plugin left that starts before the next plugin has taken it over waits for that plugin, through a second reload too, and for no more than the bound', async () => {
  const timers = fakeTimers()
  const handover = createHandover(timers)
  // Whether a promise has settled once every reaction it queues has run.
  const settled = async (p) => { let done = false; p.then(() => { done = true }); await new Promise((r) => setImmediate(r)); return done }
  const one = handover.join('/data')
  one.take({ name: 'one' })
  assert.equal(await settled(one.handedOver()), true, 'a plugin still applied waits for nothing')
  one.leave({ tasks: [entry('a', [])] })
  const first = one.handedOver()
  assert.equal(await settled(first), false, 'closed, with its work on the shelf, it waits')
  const two = handover.join('/data')
  two.take({ name: 'two' })
  assert.equal(await settled(first), true, 'until the next plugin has taken the work over')
  assert.equal(one.heir().name, 'two')
  two.leave({ tasks: [entry('a', [])] })
  const second = one.handedOver()
  assert.equal(await settled(second), false, 'the plugin that took it over has closed in turn, so it waits again')
  const three = handover.join('/data')
  three.take({ name: 'three' })
  assert.equal(await settled(second), true)
  assert.equal(one.heir().name, 'three')
  three.leave({ tasks: [entry('a', [])] })
  const last = one.handedOver()
  timers.fire()
  assert.equal(await settled(last), true, 'what no plugin takes within the bound is waited for no more')
  assert.equal(one.heir().name, 'three', 'and goes on in the newest plugin that held it, as before')
})

test('a plugin whose start fails before it takes the work over leaves the registries and the tasks together on the shelf, for the next plugin applied on the folder to take both', () => {
  const handover = createHandover()
  const lanes = { name: 'lanes' }
  const going = [entry('a', [])]
  handover.join('/data').leave({ kept: { lanes }, tasks: going })
  const failed = handover.join('/data')
  assert.equal(failed.kept.lanes, lanes, 'it started on the registries')
  // Its start fails here: it never takes the tasks over, and never closes, since it never started.
  const next = handover.join('/data')
  assert.equal(next.kept.lanes, lanes, 'the next plugin starts on the same registries')
  assert.equal(next.take({ name: 'next' }), going, 'and takes the tasks whose runs write to them')
  assert.deepEqual(failed.take({ name: 'failed' }), [], 'which the failed one can no longer take')
})

test('the process has one registry, which a copy of the module imported again finds', async () => {
  const copy = await import(`../handover.js?copy=${Date.now()}`)
  assert.notEqual(copy.createHandover, createHandover, 'a copy of the module')
  assert.equal(copy.processHandover(), processHandover(), 'the same registry')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = (name) => import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', name)).href)
const { createCache } = await load('cache.js')
const { createPrices } = await load('prices.js')
const { createStore } = await load('store.js')

/** Prices over a store and a cache on a clock the test moves by hand. */
function world({ capacity = 10, ttlMs = 60_000, initial = { tea: 450, jam: 390, oat: 210 } } = {}) {
  const clock = { t: 1_000_000 }
  const store = createStore(initial)
  const cache = createCache({ capacity, ttlMs, now: () => clock.t })
  return { clock, store, cache, prices: createPrices({ store, cache }) }
}

test('a changed price is what the next read returns', async () => {
  const { prices } = world()
  assert.equal(await prices.getPrice('tea'), 450)
  await prices.updatePrice('tea', 480)
  assert.equal(await prices.getPrice('tea'), 480)
})

test('a cached price within its time to live does not reach the store', async () => {
  const { clock, store, prices } = world()
  await prices.getPrice('jam')
  clock.t += 30_000
  await prices.getPrice('jam')
  await prices.getPrice('jam')
  assert.equal(store.reads, 1)
})

test('after a change, the new price is cached again', async () => {
  const { store, prices } = world()
  await prices.getPrice('tea')
  await prices.updatePrice('tea', 500)
  const before = store.reads
  assert.equal(await prices.getPrice('tea'), 500)
  assert.equal(await prices.getPrice('tea'), 500)
  assert.ok(store.reads - before <= 1, `the store was read ${store.reads - before} times for one changed price`)
})

test('after a set of a cached key, that key is evicted last', () => {
  const clock = { t: 0 }
  const cache = createCache({ capacity: 3, ttlMs: 60_000, now: () => clock.t })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  cache.set('a', 10)
  cache.set('d', 4)
  assert.equal(cache.get('b'), undefined, 'b was the least recently used')
  assert.equal(cache.get('a'), 10)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.get('d'), 4)
})

test('an imported price that was cached is not the next to go', async () => {
  const { store, prices } = world({ capacity: 3, initial: { tea: 450, jam: 390, oat: 210, rye: 330 } })
  await prices.getPrice('tea')
  await prices.getPrice('jam')
  await prices.getPrice('oat')
  await prices.importPrices([{ sku: 'tea', cents: 470 }])
  await prices.getPrice('rye')
  const before = store.reads
  assert.equal(await prices.getPrice('tea'), 470)
  assert.equal(store.reads, before, 'the price imported a moment ago was read from the store again')
})

test('a set of a cached key starts its time to live again', () => {
  const clock = { t: 0 }
  const cache = createCache({ capacity: 3, ttlMs: 1000, now: () => clock.t })
  cache.set('a', 1)
  clock.t = 800
  cache.set('a', 2)
  clock.t = 1500
  assert.equal(cache.get('a'), 2)
})

test('entries still expire', () => {
  const clock = { t: 0 }
  const cache = createCache({ capacity: 3, ttlMs: 1000, now: () => clock.t })
  cache.set('a', 1)
  clock.t = 999
  assert.equal(cache.get('a'), 1)
  clock.t = 1000
  assert.equal(cache.get('a'), undefined)
})

test('the cache never holds more than its capacity', () => {
  const cache = createCache({ capacity: 3, ttlMs: 60_000, now: () => 0 })
  for (let i = 0; i < 10; i++) {
    cache.set(`k${i}`, i)
    cache.set(`k${Math.max(0, i - 1)}`, i)
    assert.ok(cache.size <= 3, `${cache.size} entries after ${i + 1} sets`)
  }
  assert.equal(cache.get('k9'), 9)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCache } from '../src/cache.js'
import { createPrices } from '../src/prices.js'
import { createStore } from '../src/store.js'

test('a price is read from the store once, then from the cache', async () => {
  const store = createStore({ tea: 450 })
  const prices = createPrices({ store, cache: createCache({ capacity: 10, ttlMs: 60_000 }) })
  assert.equal(await prices.getPrice('tea'), 450)
  assert.equal(await prices.getPrice('tea'), 450)
  assert.equal(store.reads, 1)
})

test('a SKU the store does not have has no price', async () => {
  const prices = createPrices({ store: createStore({}) })
  assert.equal(await prices.getPrice('nothing'), null)
})

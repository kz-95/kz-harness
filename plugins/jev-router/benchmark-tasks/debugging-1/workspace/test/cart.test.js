import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderTotal } from '../src/cart.js'

test('a plain order', () => {
  assert.equal(orderTotal({ lines: [{ price: 250, quantity: 2 }, { price: 199, quantity: 1 }] }), 699)
})

test('an item discount and 20 percent off', () => {
  const order = { lines: [{ price: 1000, quantity: 2, discount: 100 }, { price: 300, quantity: 1 }], percentOff: 20 }
  assert.equal(orderTotal(order), 1680)
})

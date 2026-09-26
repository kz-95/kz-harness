import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pay } from '../src/billing.js'
import { cancel, createOrder } from '../src/orders.js'
import { summary } from '../src/report.js'
import { ship } from '../src/shipping.js'

test('an order is paid, then shipped', () => {
  const order = ship(pay(createOrder('o1', 1200), 1200))
  assert.equal(order.status, 'shipped')
  assert.deepEqual(order.history, ['pending', 'paid', 'shipped'])
})

test('the summary counts orders by state', () => {
  const orders = [createOrder('a', 1), cancel(createOrder('b', 1)), pay(createOrder('c', 5), 5)]
  assert.deepEqual(summary(orders), { pending: 1, paid: 1, shipped: 0, cancelled: 1 })
})

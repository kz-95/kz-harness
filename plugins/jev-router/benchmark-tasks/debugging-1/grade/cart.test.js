import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { orderTotal } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'cart.js')).href)

const ORDERS = [
  ['no discounts and nothing off', { lines: [{ price: 250, quantity: 2 }, { price: 199, quantity: 1 }] }, 699],
  ['an item discount only', { lines: [{ price: 1000, quantity: 3, discount: 150 }] }, 2550],
  ['percentOff only', { lines: [{ price: 1000, quantity: 1 }, { price: 500, quantity: 2 }], percentOff: 10 }, 1800],
  ['an item discount and percentOff', { lines: [{ price: 1000, quantity: 2, discount: 100 }, { price: 300, quantity: 1 }], percentOff: 20 }, 1680],
  ['a quantity of 0', { lines: [{ price: 999, quantity: 0, discount: 100 }, { price: 100, quantity: 1 }] }, 100],
  ['a half cent rounds up', { lines: [{ price: 105, quantity: 1 }], percentOff: 10 }, 95],
  ['100 percent off', { lines: [{ price: 1234, quantity: 2, discount: 34 }], percentOff: 100 }, 0],
  ['discounts on several quantities and 15 percent off', { lines: [{ price: 1999, quantity: 3, discount: 499 }, { price: 250, quantity: 4 }], percentOff: 15 }, 4675],
]
for (const [name, order, total] of ORDERS) {
  test(`${name}: ${total}`, () => {
    assert.equal(orderTotal(order), total)
  })
}

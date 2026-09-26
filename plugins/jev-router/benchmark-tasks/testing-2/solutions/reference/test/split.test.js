import { test } from 'node:test'
import assert from 'node:assert/strict'
import { split } from '../src/split.js'

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

test('one whole share per weight, in order, adding up to the amount', () => {
  const shares = split(1000, [1, 2, 3, 4])
  assert.deepEqual(shares, [100, 200, 300, 400])
  for (const [cents, weights] of [[101, [1, 1, 1]], [7, [2, 5, 1]], [99999, [3, 3, 7, 1]], [0, [1, 2]]]) {
    const s = split(cents, weights)
    assert.equal(s.length, weights.length)
    assert.ok(s.every(Number.isInteger))
    assert.equal(sum(s), cents)
  }
})

test('shares are floored first, then the cents left over go to the largest remainders', () => {
  // 10 by 1:1:1 is 3.33 each; the cent left goes to the first. 5 by 1:1 is 2.5 each.
  assert.deepEqual(split(10, [1, 1, 1]), [4, 3, 3])
  assert.deepEqual(split(5, [1, 1]), [3, 2])
  // 7 by 2:5:1 is 1.75, 4.375, 0.875: floors 1, 4, 0; the two cents go to 0.875 and 0.75.
  assert.deepEqual(split(7, [2, 5, 1]), [2, 4, 1])
  // 11 by 1:2:3 is 1.83, 3.67, 5.5: floors 1, 3, 5, and the two cents left go to 0.83 and 0.67.
  assert.deepEqual(split(11, [1, 2, 3]), [2, 4, 5])
})

test('an equal remainder gives the cent to the earlier share, whatever the weights', () => {
  // 2 by 1:3 is 0.5 and 1.5: the same remainder, and the first share gets the cent.
  assert.deepEqual(split(2, [1, 3]), [1, 1])
  assert.deepEqual(split(2, [3, 1]), [2, 0])
})

test('cents that are negative or not whole are refused', () => {
  assert.throws(() => split(-1, [1]), RangeError)
  assert.throws(() => split(10.5, [1]), RangeError)
})

test('no weights, a negative weight or only zero weights are refused', () => {
  assert.throws(() => split(10, []), RangeError)
  assert.throws(() => split(10, [1, -1]), RangeError)
  assert.throws(() => split(10, [0, 0]), RangeError)
})

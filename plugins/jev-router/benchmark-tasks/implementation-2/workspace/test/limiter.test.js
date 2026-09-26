import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter } from '../src/limiter.js'

test('starts full', () => {
  const limiter = createLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 })
  assert.equal(limiter.take(3), true)
})

test('refuses when empty', () => {
  const limiter = createLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 })
  assert.equal(limiter.take(2), true)
  assert.equal(limiter.take(), false)
})

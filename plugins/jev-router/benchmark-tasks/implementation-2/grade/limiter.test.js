import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createLimiter } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'limiter.js')).href)

/** A limiter on a clock the test moves by hand. */
function clocked(capacity, refillPerSecond) {
  const clock = { t: 0 }
  const limiter = createLimiter({ capacity, refillPerSecond, now: () => clock.t })
  return { clock, limiter }
}

test('starts full, and take(n) removes n tokens', () => {
  const { limiter } = clocked(3, 1)
  assert.equal(limiter.take(2), true)
  assert.equal(limiter.take(1), true)
  assert.equal(limiter.take(), false)
})

test('take(n) removes nothing when fewer than n tokens are there', () => {
  const { limiter } = clocked(3, 1)
  assert.equal(limiter.take(2), true)
  assert.equal(limiter.take(2), false)
  assert.equal(limiter.take(1), true)
})

test('half a token after 500 ms is not enough, and waitMs says 500', () => {
  const { clock, limiter } = clocked(1, 1)
  assert.equal(limiter.take(), true)
  clock.t = 500
  assert.equal(limiter.take(), false)
  assert.equal(limiter.waitMs(), 500)
})

test('tokens come back continuously', () => {
  const { clock, limiter } = clocked(10, 2)
  assert.equal(limiter.take(10), true)
  clock.t = 1500
  assert.equal(limiter.take(3), true)
  assert.equal(limiter.take(), false)
})

test('a long idle refills to capacity and no further', () => {
  const { clock, limiter } = clocked(3, 1)
  assert.equal(limiter.take(3), true)
  clock.t = 1_000_000
  assert.equal(limiter.take(3), true)
  assert.equal(limiter.take(), false)
})

test('a clock that goes backwards adds nothing until it passes the latest time again', () => {
  const { clock, limiter } = clocked(5, 1)
  assert.equal(limiter.take(5), true)
  clock.t = 2000
  assert.equal(limiter.take(2), true)
  clock.t = 1000
  assert.equal(limiter.take(), false, 'the clock went back, and nothing came back with it')
  clock.t = 2500
  assert.equal(limiter.take(), false, 'half a token since the latest time seen')
  clock.t = 3000
  assert.equal(limiter.take(2), false, 'one token since the latest time seen, not two')
  assert.equal(limiter.take(1), true)
})

test('waitMs rounds up to a whole number of milliseconds', () => {
  const { limiter } = clocked(1, 3)
  assert.equal(limiter.take(), true)
  assert.equal(limiter.waitMs(), 334)
})

test('waitMs is 0 when take would succeed now', () => {
  const { limiter } = clocked(4, 1)
  assert.equal(limiter.waitMs(), 0)
  assert.equal(limiter.waitMs(4), 0)
})

test('waitMs is Infinity when n is more than capacity', () => {
  const { limiter } = clocked(4, 1)
  assert.equal(limiter.waitMs(5), Infinity)
})

test('take(0) is true, even when empty', () => {
  const { limiter } = clocked(1, 1)
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(0), true)
})

const INVALID = [
  ['capacity 0', { capacity: 0, refillPerSecond: 1 }],
  ['a negative capacity', { capacity: -1, refillPerSecond: 1 }],
  ['a capacity of NaN', { capacity: NaN, refillPerSecond: 1 }],
  ['an infinite capacity', { capacity: Infinity, refillPerSecond: 1 }],
  ['a capacity given as text', { capacity: '3', refillPerSecond: 1 }],
  ['no capacity', { refillPerSecond: 1 }],
  ['refillPerSecond 0', { capacity: 1, refillPerSecond: 0 }],
  ['a negative refillPerSecond', { capacity: 1, refillPerSecond: -2 }],
  ['a refillPerSecond of NaN', { capacity: 1, refillPerSecond: NaN }],
  ['an infinite refillPerSecond', { capacity: 1, refillPerSecond: Infinity }],
]
for (const [name, options] of INVALID) {
  test(`${name} throws a RangeError`, () => {
    assert.throws(() => createLimiter({ ...options, now: () => 0 }), RangeError)
  })
}

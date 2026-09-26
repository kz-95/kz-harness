import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from '../src/dedupe.js'

test('keeps the first of each value, in order', () => {
  assert.deepEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])
})

test('strings and numbers are different values', () => {
  assert.deepEqual(dedupe(['1', 1, '1']), ['1', 1])
})

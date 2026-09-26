import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration } from '../src/duration.js'

test('hours, minutes and seconds', () => {
  assert.equal(formatDuration(3723000), '1h 02m 03s')
})

test('seconds only', () => {
  assert.equal(formatDuration(5000), '5s')
})

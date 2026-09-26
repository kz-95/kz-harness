import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge, subtract } from '../src/intervals.js'

test('merge joins intervals that overlap', () => {
  assert.deepEqual(merge([[1, 3], [2, 6]]), [[1, 6]])
})

test('merge joins intervals that touch', () => {
  assert.deepEqual(merge([[1, 3], [4, 6]]), [[1, 6]])
  assert.deepEqual(merge([[1, 3], [5, 6]]), [[1, 3], [5, 6]])
})

test('merge keeps an interval that holds another whole', () => {
  assert.deepEqual(merge([[1, 10], [2, 3]]), [[1, 10]])
})

test('merge returns the intervals sorted by start', () => {
  assert.deepEqual(merge([[20, 25], [1, 2], [10, 12]]), [[1, 2], [10, 12], [20, 25]])
})

test('merge never changes its input', () => {
  const list = [[5, 8], [1, 6], [10, 11]]
  const copy = structuredClone(list)
  merge(list)
  assert.deepEqual(list, copy)
})

test('merge refuses an interval that starts after it ends', () => {
  assert.throws(() => merge([[1, 2], [5, 4]]), RangeError)
})

test('subtract removes the cut, its end points included, and splits an interval the cut lies inside', () => {
  assert.deepEqual(subtract([[1, 10]], [4, 6]), [[1, 3], [7, 10]])
  assert.deepEqual(subtract([[1, 5], [8, 12]], [4, 9]), [[1, 3], [10, 12]])
})

test('subtract leaves an empty list when the cut covers everything', () => {
  assert.deepEqual(subtract([[2, 4], [6, 7]], [1, 10]), [])
})

test('subtract keeps what the cut does not touch, and never changes its arguments', () => {
  const list = [[1, 2], [20, 30]]
  const cut = [5, 9]
  assert.deepEqual(subtract(list, cut), [[1, 2], [20, 30]])
  assert.deepEqual(list, [[1, 2], [20, 30]])
  assert.deepEqual(cut, [5, 9])
})

test('subtract refuses a cut that starts after it ends', () => {
  assert.throws(() => subtract([[1, 5]], [4, 2]), RangeError)
})

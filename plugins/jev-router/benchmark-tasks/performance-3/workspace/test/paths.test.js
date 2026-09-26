import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countPaths } from '../src/paths.js'

test('an open 3 by 3 grid has 6 paths', () => {
  assert.equal(countPaths(['...', '...', '...']), 6n)
})

test('a blocked middle leaves 2', () => {
  assert.equal(countPaths(['...', '.#.', '...']), 2n)
})

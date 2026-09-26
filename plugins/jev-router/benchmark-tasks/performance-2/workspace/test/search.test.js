import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIndex } from '../src/search.js'

test('counts whole words, whatever their case', () => {
  const index = createIndex('The cat saw the other cat. Cats!')
  assert.equal(index.count('cat'), 2)
  assert.equal(index.count('THE'), 2)
})

test('a word that is not there counts 0', () => {
  assert.equal(createIndex('one two').count('three'), 0)
})

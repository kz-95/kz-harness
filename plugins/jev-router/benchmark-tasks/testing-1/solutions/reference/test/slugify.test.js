import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.js'

test('lower case', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('accents are removed', () => {
  assert.equal(slugify('Café Crème'), 'cafe-creme')
})

test('a run of other characters becomes one dash', () => {
  assert.equal(slugify('a  &  b__c'), 'a-b-c')
})

test('no dash at either end', () => {
  assert.equal(slugify('  !Hello!  '), 'hello')
})

test('a long title is cut back to the last whole word within 60 characters', () => {
  const title = 'the quick brown fox jumps over the lazy dog and keeps running far away'
  const slug = slugify(title)
  assert.equal(slug, 'the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps')
  assert.ok(slug.length <= 60)
})

test('a first word longer than 60 characters is cut at 60', () => {
  assert.equal(slugify('x'.repeat(70)), 'x'.repeat(60))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cToF, cToK, fToC, kToC } from '../src/convert.js'

test('water boils at 100 C, 212 F and 373.15 K', () => {
  assert.equal(cToF(100), 212)
  assert.equal(fToC(212), 100)
  assert.equal(cToK(100), 373.15)
  assert.equal(kToC(373.15), 100)
})

test('a temperature that is not a number is refused', () => {
  assert.throws(() => cToF('hot'), TypeError)
})

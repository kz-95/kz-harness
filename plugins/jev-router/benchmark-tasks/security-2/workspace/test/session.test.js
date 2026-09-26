import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sign, verify } from '../src/session.js'

const KEY = 'a key for the tests only'

test('a cookie verifies with the key it was signed with', () => {
  const payload = { user: 'ana', exp: Math.floor(Date.now() / 1000) + 3600 }
  assert.deepEqual(verify(sign(payload, KEY), KEY), payload)
})

test('a cookie with another signature does not verify', () => {
  const cookie = sign({ user: 'ana', exp: Math.floor(Date.now() / 1000) + 3600 }, KEY)
  assert.equal(verify(`${cookie.slice(0, cookie.lastIndexOf('.'))}.bad`, KEY), null)
})

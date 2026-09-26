// timingSafeEqual is wrapped before anything of src/ is imported, and the wrapper reaches every
// way of importing node:crypto (syncBuiltinESMExports), so a call is seen whatever form the code
// imports it in.
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let compared = 0
const realTimingSafeEqual = crypto.timingSafeEqual
crypto.timingSafeEqual = function (a, b) {
  compared++
  return realTimingSafeEqual.call(this, a, b)
}
syncBuiltinESMExports()

const { sign, verify } = await import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'session.js')).href)

const KEY = 'the key the shop signs with'
const NOW = Date.parse('2026-09-20T12:00:00Z')
const PAYLOAD = { user: 'ana', role: 'customer', exp: NOW / 1000 + 3600 }
const COOKIE = sign(PAYLOAD, KEY)
const body = COOKIE.slice(0, COOKIE.lastIndexOf('.'))
const signature = COOKIE.slice(COOKIE.lastIndexOf('.') + 1)

test('a valid cookie gives its payload', () => {
  assert.deepEqual(verify(COOKIE, KEY, NOW), PAYLOAD)
})

test('a cookie is signed as before', () => {
  const expected = crypto.createHmac('sha256', KEY).update(body).digest('base64url')
  assert.equal(signature, expected)
  assert.equal(body, Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url'))
})

const REFUSED = [
  ['a missing signature', body],
  ['an empty signature', `${body}.`],
  ['a truncated signature', `${body}.${signature.slice(0, 10)}`],
  ['an altered signature', `${body}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`],
  ['an altered payload', `${Buffer.from(JSON.stringify({ ...PAYLOAD, role: 'admin' })).toString('base64url')}.${signature}`],
  ['another key', sign(PAYLOAD, 'somebody else')],
  ['an expired session', sign({ ...PAYLOAD, exp: NOW / 1000 - 60 }, KEY)],
]
for (const [name, cookie] of REFUSED) {
  test(`${name} gives null`, () => {
    assert.equal(verify(cookie, KEY, NOW), null)
  })
}

test('verify compares signatures with timingSafeEqual from node:crypto', () => {
  const before = compared
  assert.deepEqual(verify(COOKIE, KEY, NOW), PAYLOAD)
  assert.ok(compared > before, 'timingSafeEqual was not called')
})

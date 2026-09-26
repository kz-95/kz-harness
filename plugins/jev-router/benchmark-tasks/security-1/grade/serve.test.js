import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.env.BENCH_WORKSPACE
const { resolveRequest } = await import(pathToFileURL(join(ws, 'src', 'serve.js')).href)
const root = join(ws, 'public')
const secret = join(ws, 'secret.txt')

const OUTSIDE = [
  ['../secret.txt', '../secret.txt'],
  ['an encoded ../', '%2e%2e/secret.txt'],
  ['an encoded slash', '..%2fsecret.txt'],
  ['a detour through a folder', 'a/../../secret.txt'],
  ['a backslash, on every OS', '..\\secret.txt'],
  ['an encoded backslash', '..%5csecret.txt'],
  ['the absolute path of the file', encodeURI(secret)],
]
for (const [name, urlPath] of OUTSIDE) {
  test(`${name} is not served`, () => {
    assert.equal(resolveRequest(root, urlPath), null)
  })
}

const INSIDE = [
  ['index.html', 'index.html', ['index.html']],
  ['a file in a folder', 'css/site.css', ['css', 'site.css']],
  ['a leading slash', '/css/site.css', ['css', 'site.css']],
  ['a detour that stays inside', 'a/../index.html', ['index.html']],
]
for (const [name, urlPath, parts] of INSIDE) {
  test(`${name} is served from inside the public folder`, () => {
    const file = resolveRequest(root, urlPath)
    assert.notEqual(file, null)
    assert.equal(resolve(file), join(root, ...parts))
  })
}

test('a malformed escape gives null and does not throw', () => {
  assert.equal(resolveRequest(root, '%E0%A4%A'), null)
})

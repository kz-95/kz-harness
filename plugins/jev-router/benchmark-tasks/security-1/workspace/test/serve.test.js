import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { resolveRequest } from '../src/serve.js'

const root = resolve('public')

test('the home page is served', () => {
  assert.equal(resolve(resolveRequest(root, '/index.html')), join(root, 'index.html'))
})

test('a style sheet in a folder is served', () => {
  assert.equal(resolve(resolveRequest(root, 'css/site.css')), join(root, 'css', 'site.css'))
})

test('a file that is not there is not served', () => {
  assert.equal(resolveRequest(root, 'nope.html'), null)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'
import { acceptUpload } from '../src/upload.js'

test('a small PDF is accepted', () => {
  const upload = { person: 'ana', name: 'cv.pdf', type: 'application/pdf', size: 1024 * 1024 }
  assert.deepEqual(acceptUpload(createStore(), upload), { person: 'ana', name: 'cv.pdf', size: 1024 * 1024 })
})

test('a 100 MB file is refused as too large', () => {
  const upload = { person: 'ana', name: 'film.png', type: 'image/png', size: 100 * 1024 * 1024 }
  assert.throws(() => acceptUpload(createStore(), upload), { code: 'TOO_LARGE' })
})

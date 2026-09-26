import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = join(process.env.BENCH_WORKSPACE, 'src')
const load = (name) => import(pathToFileURL(join(src, name)).href)
const { acceptUpload } = await load('upload.js')
const { createStore } = await load('store.js')
const { UPLOAD_HINT } = await load('hint.js')
const upload = (size) => ({ person: 'ana', name: 'scan.pdf', type: 'application/pdf', size })

test('26214400 bytes is accepted', () => {
  assert.deepEqual(acceptUpload(createStore(), upload(26214400)), { person: 'ana', name: 'scan.pdf', size: 26214400 })
})

test('one byte more is refused with File too large (max 25 MB)', () => {
  assert.throws(() => acceptUpload(createStore(), upload(26214401)), (err) => err.code === 'TOO_LARGE' && err.message === 'File too large (max 25 MB)')
})

test('the hint says 26214400 bytes', () => {
  assert.equal(UPLOAD_HINT, 'Files up to 26214400 bytes: PNG, JPEG or PDF')
})

test('the old limit is stated nowhere in src/', () => {
  const texts = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? texts(path) : [[name, readFileSync(path, 'utf8')]]
  })
  const left = texts(src).flatMap(([name, text]) => ['10 MB', '10485760', '10 * 1024 * 1024'].filter((old) => text.includes(old)).map((old) => `${name}: ${old}`))
  assert.deepEqual(left, [])
})

test('the other limits are as they were', async () => {
  const { MAX_FILES_PER_PERSON, ACCEPTED_TYPES } = await load('limits.js')
  assert.equal(MAX_FILES_PER_PERSON, 10)
  assert.deepEqual(ACCEPTED_TYPES, ['image/png', 'image/jpeg', 'application/pdf'])
  const store = createStore()
  for (let i = 0; i < 10; i++) acceptUpload(store, { ...upload(10), name: `f${i}.pdf` })
  assert.throws(() => acceptUpload(store, upload(10)), { code: 'TOO_MANY' })
})

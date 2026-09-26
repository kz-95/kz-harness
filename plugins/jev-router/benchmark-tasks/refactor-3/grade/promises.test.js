// Before anything of src/ is imported, every callback function of node:fs is wrapped, and the
// wrappers reach every way of importing node:fs (syncBuiltinESMExports), so a call to one is seen
// whatever form the code imports it in.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CALLBACK_FUNCTIONS = ['access', 'appendFile', 'chmod', 'close', 'copyFile', 'cp', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'read', 'readdir', 'readFile', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'unlink', 'write', 'writeFile']
const called = []
let watching = false
for (const name of CALLBACK_FUNCTIONS) {
  const real = fs[name]
  if (typeof real !== 'function') continue
  fs[name] = function (...args) {
    if (watching) called.push(name)
    return real.apply(this, args)
  }
}
syncBuiltinESMExports()

const ws = process.env.BENCH_WORKSPACE
const load = (name) => import(pathToFileURL(join(ws, 'src', name)).href)
const { readConfig, readConfigs } = await load('read-config.js')
const { deepMerge, mergeFiles } = await load('merge.js')
const { saveConfig } = await load('save.js')
const { main } = await load('index.js')
const A = join(ws, 'fixtures', 'a.json')
const B = join(ws, 'fixtures', 'b.json')
const a = JSON.parse(readFileSync(A, 'utf8'))
const b = JSON.parse(readFileSync(B, 'utf8'))
const MERGED = {
  name: 'shop',
  server: { port: 9090, host: 'localhost', tls: { enabled: true, cert: 'certs/shop.pem' } },
  features: ['search', 'cart'],
  limits: { upload: 10 },
  debug: true,
}
const scratch = () => mkdtempSync(join(tmpdir(), 'kzh-config-'))
const isPromise = (x) => !!x && typeof x.then === 'function'

/** Runs `fn` with the callback functions of node:fs watched; resolves to what it resolved to. */
async function watched(fn) {
  watching = true
  try { return await fn() } finally { watching = false }
}

test('every exported function returns a promise', async () => {
  const out = join(scratch(), 'out.json')
  const results = [readConfig(A), readConfigs([A, B]), mergeFiles([A, B]), saveConfig(out, a), main([A], join(scratch(), 'main.json'))]
  assert.deepEqual(results.map(isPromise), [true, true, true, true, true])
  await Promise.all(results)
})

test('readConfig and readConfigs resolve to the configs', async () => {
  assert.deepEqual(await readConfig(A), a)
  assert.deepEqual(await readConfigs([A, B]), [a, b])
  assert.deepEqual(await readConfigs([]), [])
})

test('mergeFiles resolves to the merged config, and deepMerge is unchanged', async () => {
  assert.deepEqual(await mergeFiles([A, B]), MERGED)
  assert.deepEqual(deepMerge(a, b), MERGED)
})

test('saveConfig writes the file and resolves to its size, and reading it back gives the same config', async () => {
  const out = join(scratch(), 'deeper', 'saved.json')
  const text = `${JSON.stringify(MERGED, null, 2)}\n`
  assert.equal(await saveConfig(out, MERGED), Buffer.byteLength(text))
  assert.equal(readFileSync(out, 'utf8'), text)
  assert.deepEqual(await readConfig(out), MERGED)
})

test('main merges the files and writes the result, resolving to the merged config', async () => {
  const out = join(scratch(), 'main.json')
  assert.deepEqual(await main([A, B], out), MERGED)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), MERGED)
})

test('a missing file rejects with ENOENT', async () => {
  const missing = join(scratch(), 'nope.json')
  await assert.rejects(readConfig(missing), (err) => err.code === 'ENOENT')
  await assert.rejects(readConfigs([A, missing]), (err) => err.code === 'ENOENT')
  await assert.rejects(mergeFiles([missing]), (err) => err.code === 'ENOENT')
  await assert.rejects(main([missing], join(scratch(), 'out.json')), (err) => err.code === 'ENOENT')
})

test('each function takes its old arguments less the callback', () => {
  assert.deepEqual([readConfig.length, readConfigs.length, mergeFiles.length, saveConfig.length, main.length], [1, 1, 1, 2, 2])
})

test('no callback function of node:fs is called', async () => {
  const dir = scratch()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ not json')
  await watched(async () => {
    await readConfig(A)
    await readConfigs([A, B])
    await mergeFiles([A, B])
    await saveConfig(join(dir, 'sub', 'x.json'), MERGED)
    await main([A, B], join(dir, 'main.json'))
    await readConfig(bad).catch(() => {})
  })
  assert.deepEqual([...new Set(called)], [])
})

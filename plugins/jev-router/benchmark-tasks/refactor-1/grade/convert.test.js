import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.env.BENCH_WORKSPACE
const src = join(ws, 'src')
const MESSAGE = 'temperature must be a finite number'
const load = (dir, name) => import(pathToFileURL(join(dir, name)).href)
const convert = await load(src, 'convert.js')
const FUNCTIONS = ['cToF', 'fToC', 'cToK', 'kToC']

test('every conversion gives what it gave before, -0 included', () => {
  assert.equal(convert.cToF(100), 212)
  assert.equal(convert.cToF(-40), -40)
  assert.equal(convert.cToF(-0), 32)
  assert.equal(convert.fToC(32), 0)
  assert.equal(convert.fToC(-0), ((-0 - 32) * 5) / 9)
  assert.equal(convert.cToK(-0), 273.15)
  assert.equal(convert.cToK(-273.15), 0)
  assert.equal(convert.kToC(0), -273.15)
  assert.equal(convert.kToC(-0), -273.15)
})

for (const name of FUNCTIONS) {
  test(`${name} throws the same TypeError as before for text, NaN and Infinity`, () => {
    for (const bad of ['10', NaN, Infinity, -Infinity, null, undefined]) {
      assert.throws(() => convert[name](bad), (err) => err instanceof TypeError && err.message === MESSAGE, `${name}(${String(bad)})`)
    }
  })
}

test('src/check.js exports assertTemperature', async () => {
  const check = await load(src, 'check.js')
  assert.equal(typeof check.assertTemperature, 'function')
  assert.throws(() => check.assertTemperature('x'), (err) => err instanceof TypeError && err.message === MESSAGE)
  assert.doesNotThrow(() => check.assertTemperature(-0))
})

/** Every .js file under src/, as [path from src/, text]. */
function sources(dir = src) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.js') ? [[relative(src, path), readFileSync(path, 'utf8')]] : []
  })
}

test('the error message is written in one place only', () => {
  const places = sources().flatMap(([file, text]) => Array(text.split(MESSAGE).length - 1).fill(file))
  assert.deepEqual(places, ['check.js'])
})

test('src/convert.js imports ./check.js', () => {
  assert.match(readFileSync(join(src, 'convert.js'), 'utf8'), /\bfrom\s*['"]\.\/check\.js['"]/)
})

test('each conversion calls assertTemperature with its argument', async () => {
  // A copy of src/ whose check.js records its calls and throws as the real one does.
  const copy = mkdtempSync(join(tmpdir(), 'kzh-convert-'))
  for (const [file] of sources()) {
    mkdirSync(join(copy, file, '..'), { recursive: true })
    copyFileSync(join(src, file), join(copy, file))
  }
  writeFileSync(join(copy, 'package.json'), '{ "type": "module" }')
  // Whatever else the agent's check.js exports stays there; assertTemperature is the recorder's.
  copyFileSync(join(src, 'check.js'), join(copy, 'check-real.js'))
  writeFileSync(join(copy, 'check.js'), [
    "export * from './check-real.js'",
    'export const calls = []',
    'export function assertTemperature(t) {',
    '  calls.push(t)',
    `  if (typeof t !== 'number' || !Number.isFinite(t)) throw new TypeError('${MESSAGE}')`,
    '}',
  ].join('\n'))
  const recorder = await load(copy, 'check.js')
  const converted = await load(copy, 'convert.js')
  FUNCTIONS.forEach((name, i) => {
    recorder.calls.length = 0
    converted[name](i + 0.5)
    assert.ok(recorder.calls.includes(i + 0.5), `${name} did not call assertTemperature with its argument`)
  })
})

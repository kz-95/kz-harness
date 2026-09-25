// scripts/red-check.mjs, run on a small repository of its own: which failures at the base prove
// that a new test disproves the old code, and which only look as if they do (docs/laya-auto.md 9.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RED_CHECK = fileURLToPath(new URL('../../../scripts/red-check.mjs', import.meta.url))

// The check runs node --test itself, which skips every file when it believes it is inside a test
// runner already, and a git variable from a hook would point it at another repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && !k.startsWith('GIT_')))

const TEST_HEAD = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n"

/**
 * A repository whose base commit holds one plugin: `old.js` and its test. The change on top adds
 * `fresh.js`, a new module, uncommitted, as a group's work is when it runs the check.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kz-redcheck-'))
  const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
  const g = (...x) => execFileSync('git', x, { cwd: dir, env, encoding: 'utf8' }).trim()
  put('plug/package.json', '{ "type": "module" }\n')
  put('plug/old.js', "export const level = () => 'medium'\n")
  put('plug/test/old.test.js', `${TEST_HEAD}import { level } from '../old.js'\n\ntest('the old level', () => { assert.equal(level(), 'medium') })\n`)
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  put('plug/fresh.js', "export const fresh = () => 'new'\n")
  return { dir, put, base: g('rev-parse', 'HEAD') }
}

function redCheck(dir, files, base) {
  const r = spawnSync(process.execPath, [RED_CHECK, ...files, '--base', base], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

test('a missing module proves nothing in a file the base already has: there only an assertion or a missing export counts', () => {
  const { dir, put, base } = repo()
  // Everything it asserts already held at the base; only the import of the new module fails there.
  put('plug/test/old.test.js', `${TEST_HEAD}import { level } from '../old.js'\n\ntest('the old level', () => { assert.equal(level(), 'medium') })\n`
    + "\ntest('imports the new module and asserts the old level', async () => { await import('../fresh.js'); assert.equal(level(), 'medium') })\n"
    + "\ntest('asserts a new export', async () => { const old = await import('../old.js'); assert.equal(old.bands?.(), 'wide') })\n")
  put('plug/old.js', "export const level = () => 'medium'\nexport const bands = () => 'wide'\n")
  const r = redCheck(dir, ['plug/test/old.test.js'], base)
  assert.equal(r.status, 1, `the check let a vacuous test through:\n${r.out}${r.err}`)
  assert.match(r.err, /old\.test\.js: imports the new module and asserts the old level: failed at the base by a missing module \(plug\/fresh\.js\) in a file the base already has/)
  assert.match(r.out, /fails at the base, assertion: asserts a new export/, 'a test that disproves the old code still counts')
  assert.doesNotMatch(r.err, /asserts a new export/)
})

test("a missing module proves only the new module's own tests: a new test file named for anything else is refused", () => {
  const { dir, put, base } = repo()
  // fresh.test.js is fresh.js's own: it cannot load at the base, and that is the proof.
  put('plug/test/fresh.test.js', `${TEST_HEAD}import { fresh } from '../fresh.js'\n\ntest('fresh is new', () => { assert.equal(fresh(), 'new') })\n`)
  // A new file of regression tests that would pass at the base, kept from running there by the
  // same import; and one that loads but imports the new module inside its test.
  put('plug/test/wiring.test.js', `${TEST_HEAD}import { fresh } from '../fresh.js'\nimport { level } from '../old.js'\n\ntest('wiring keeps the old level', () => { assert.equal(typeof fresh, 'function'); assert.equal(level(), 'medium') })\n`)
  put('plug/test/later.test.js', `${TEST_HEAD}import { level } from '../old.js'\n\ntest('later keeps the old level', async () => { await import('../fresh.js'); assert.equal(level(), 'medium') })\n`)
  const r = redCheck(dir, ['plug/test/fresh.test.js', 'plug/test/wiring.test.js', 'plug/test/later.test.js'], base)
  assert.equal(r.status, 1, `the check let a vacuous test through:\n${r.out}${r.err}`)
  assert.match(r.out, /fails at the base, missing module plug\/fresh\.js: fresh is new/, "the module's own test counts")
  assert.match(r.err, /wiring\.test\.js: wiring keeps the old level: a missing module \(plug\/fresh\.js\) that wiring\.test\.js is not named for/)
  assert.match(r.err, /later\.test\.js: later keeps the old level: failed at the base by a missing module \(plug\/fresh\.js\) that later\.test\.js is not named for/)
  assert.doesNotMatch(r.err, /fresh is new/)
})

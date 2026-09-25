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
  // Run again with fresh.js in place, both pass: they test nothing the old code got wrong.
  for (const name of ['wiring keeps the old level', 'later keeps the old level']) assert.match(r.err, new RegExp(`${name}: [^\\n]*; and with the files this change adds in place it passes, so it tests only what the change adds`), name)
  assert.doesNotMatch(r.err, /fresh is new/)
})

test("a new repository script's own tests may fail on its absence too: test/<m>.test.js is named for scripts/<m>.mjs", () => {
  const { dir, put, base } = repo()
  // The scripts' tests live in the plugin's test folder, so the name is what ties them to the script.
  put('scripts/tool.mjs', "export const tool = () => 'made'\n")
  put('plug/test/tool.test.js', `${TEST_HEAD}const { tool } = await import('../../scripts/tool.mjs')\n\ntest('the tool makes', () => { assert.equal(tool(), 'made') })\n`)
  // Named for something else, the same import proves nothing.
  put('plug/test/other.test.js', `${TEST_HEAD}const { tool } = await import('../../scripts/tool.mjs')\n\ntest('other uses the tool', () => { assert.equal(tool(), 'made') })\n`)
  const r = redCheck(dir, ['plug/test/tool.test.js', 'plug/test/other.test.js'], base)
  assert.match(r.out, /fails at the base, missing module scripts\/tool\.mjs: the tool makes/, "the script's own test counts")
  assert.match(r.err, /other\.test\.js: other uses the tool: [^\n]*a missing module \(scripts\/tool\.mjs\) that other\.test\.js is not named for/)
})

test('a test the base cannot run for want of what the change adds is run again with it in place, and counts only if the old code then fails it by an assertion', () => {
  const { dir, put, base } = repo()
  // The change edits old.js to use the new module, and adds a data file beside it, left untracked.
  put('plug/old.js', "import { fresh } from './fresh.js'\nexport const level = () => 'medium'\nexport const tag = () => `${fresh()} tag`\n")
  put('plug/levels.json', '{ "top": "high" }\n')
  const readLevels = "JSON.parse((await import('node:fs')).readFileSync(new URL('../levels.json', import.meta.url), 'utf8'))"
  put('plug/test/old.test.js', `${TEST_HEAD}import { level } from '../old.js'\n\ntest('the old level', () => { assert.equal(level(), 'medium') })\n`
    // Disproves the old old.js once fresh.js is there: counts.
    + "\ntest('tags with the new module', async () => { const { fresh } = await import('../fresh.js'); const old = await import('../old.js'); assert.equal(old.tag?.(), `${fresh()} tag`) })\n"
    // Reads a file the change adds, and then disproves the old old.js: counts.
    + `\ntest('reads the new levels', async () => { const levels = ${readLevels}; const old = await import('../old.js'); assert.equal(old.tag?.(), 'new tag', levels.top) })\n`
    // Breaks on the old old.js rather than disproving it: refused.
    + "\ntest('calls what the old module lacks', async () => { await import('../fresh.js'); const old = await import('../old.js'); assert.equal(old.tag().length, 7) })\n")
  // A new file named for no module: counts where the old code then fails it by an assertion.
  put('plug/test/wiring.test.js', `${TEST_HEAD}import { fresh } from '../fresh.js'\nimport * as old from '../old.js'\n\ntest('old tags with fresh', () => { assert.equal(old.tag?.(), \`\${fresh()} tag\`) })\n`)
  const r = redCheck(dir, ['plug/test/old.test.js', 'plug/test/wiring.test.js'], base)
  assert.equal(r.status, 1, `the check let a broken test through:\n${r.out}${r.err}`)
  assert.match(r.out, /With the 2 files this change adds in place at the base, and none it edits:/)
  for (const name of ['tags with the new module', 'reads the new levels', 'old tags with fresh']) {
    assert.match(r.out, new RegExp(`fails at the base with them, assertion: ${name}\\n`), name)
    assert.doesNotMatch(r.err, new RegExp(name), name)
  }
  assert.match(r.err, /old\.test\.js: calls what the old module lacks: failed at the base by a missing module \(plug\/fresh\.js\) in a file the base already has, where only an assertion or a missing export counts; and with the files this change adds in place by TypeError \(.*\), which is neither an assertion nor a missing export/)
  assert.match(r.err, /red-check: 1 problem:/)
})

test('the tests of the shared fixtures are not asked to fail at the base but to pass there, and one that fails there is sent to the test file of what it tests', () => {
  const { dir, put, base } = repo()
  // The change adds a fixture and its tests, which use nothing of the plugin: they pass on any code.
  put('plug/test/fixtures/echo.mjs', 'export const echo = (x) => x\n')
  const fixtureTests = `${TEST_HEAD}import { echo } from './fixtures/echo.mjs'\n\ntest('the echo fixture echoes', () => { assert.equal(echo(3), 3) })\n`
  put('plug/test/fixtures.test.js', fixtureTests)
  const clean = redCheck(dir, ['plug/test/fixtures.test.js'], base)
  assert.equal(clean.status, 0, `a test of the fixtures was asked to fail at the base:\n${clean.out}${clean.err}`)
  assert.match(clean.out, /plug\/test\/fixtures\.test\.js \(new file\): 1 new of 1 tests, of the fixtures, which must pass at the base/)
  assert.match(clean.out, /passes at the base, as a test of the fixtures does: the echo fixture echoes/)
  assert.match(clean.out, /red-check: all 0 new tests fail at the base by an accepted kind, and the 1 new tests of the fixtures pass there\./)

  // One that needs the change's own code is no test of the fixtures: it fails at the base.
  put('plug/old.js', "export const level = () => 'medium'\nexport const bands = () => 'wide'\n")
  put('plug/test/fixtures.test.js', `${fixtureTests}\ntest('the fixture echoes the new bands', async () => { const old = await import('../old.js'); assert.equal(echo(old.bands?.()), 'wide') })\n`)
  const mixed = redCheck(dir, ['plug/test/fixtures.test.js'], base)
  assert.equal(mixed.status, 1, `a test of the code under test passed as one of the fixtures:\n${mixed.out}${mixed.err}`)
  assert.match(mixed.err, /fixtures\.test\.js: the fixture echoes the new bands: fails at the base \(assertion\), so it tests the code under test rather than the fixtures: move it to that code's own test file/)
  assert.doesNotMatch(mixed.err, /the echo fixture echoes/)
})

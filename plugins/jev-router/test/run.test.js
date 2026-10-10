// test/run.mjs, what `npm test` runs: the node test runner in a temp folder of its own, removed when
// it ends whatever the tests left in it, and the runner's own exit code passed on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Runs test/run.mjs on one test file whose body is `body`, outside this runner's own test context. */
function runOn(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'kz-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'probe.test.js')
  const out = join(dir, 'tmpdir.txt')
  writeFileSync(file, `import { test } from 'node:test'\nimport { mkdtempSync, writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\ntest('probe', () => {\n  writeFileSync(${JSON.stringify(out)}, tmpdir())\n  mkdtempSync(join(tmpdir(), 'left-behind-'))\n  ${body}\n})\n`)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['test/run.mjs', file], { cwd: PLUGIN, env, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, root: readFileSync(out, 'utf8'), output: r.stdout + r.stderr }
}

test('the tests run in a temp folder of their own, which goes when they end, with what they left in it', (t) => {
  const { status, root, output } = runOn(t, '')
  assert.equal(status, 0, output)
  assert.equal(dirname(root), tmpdir(), 'inside the temp folder the runner was started with')
  assert.match(root, /kzh-tests-/)
  assert.equal(existsSync(root), false, 'removed, the folder a test left behind in it included')
})

test('a failing test still fails the run, and its folder still goes', (t) => {
  const { status, root, output } = runOn(t, "throw new Error('no')")
  assert.equal(status, 1, output)
  assert.equal(existsSync(root), false)
})

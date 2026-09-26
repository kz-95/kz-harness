// scripts/ensure-no-project.mjs, which Start-KzH.ps1 runs before DSH starts: it lists KzH's own
// workspaces in DSH, No project for plain chat and KzH scratch for the capability benchmark
// (docs/benchmark.md 3.7), the scratch workspace only when no git repository holds it. Each test
// runs it on a harness folder and a DSH home of its own, never the person's.
//
// Named imports, so where the script exports nothing the file fails to link, and the script's own
// top-level code never runs on the person's DSH home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRATCH_README, ensureWorkspaces, gitTopOf, scratchRootOf } from '../../../scripts/ensure-no-project.mjs'

const made = []
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'kz-ensure-')); made.push(dir); return dir }
/** A DSH home whose workspace store lists `workspaces`. */
function dshHomeWith(workspaces = {}) {
  const home = temp()
  mkdirSync(join(home, 'storages'))
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces }, global: { workspaceIds: Object.keys(workspaces) } }))
  return home
}
const listed = (home) => {
  const store = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  return store.global.workspaceIds.map((id) => ({ title: store.tables.workspaces[id].title, path: store.tables.workspaces[id].path }))
}

test('the scratch workspace is kzh-scratch beside the harness folder, made with its README and listed in DSH as KzH scratch beside No project, once', () => {
  const root = temp()
  const harnessDir = join(root, 'Harness')
  mkdirSync(harnessDir)
  const home = dshHomeWith()
  const scratch = scratchRootOf(harnessDir)
  assert.equal(scratch, resolve(root, 'kzh-scratch'), 'beside the harness folder, outside its tree')
  assert.deepEqual(ensureWorkspaces({ harnessDir, dshHome: home }), [`no-project: added workspace ${join(harnessDir, 'no-project')}`, `kzh-scratch: added workspace ${scratch}`])
  assert.equal(readFileSync(join(scratch, 'README.md'), 'utf8'), SCRATCH_README)
  assert.equal(SCRATCH_README, 'Scratch space. KzH creates and deletes folders here; keep nothing of yours in it.\n')
  assert.deepEqual(listed(home), [{ title: 'No project', path: join(harnessDir, 'no-project') }, { title: 'KzH scratch', path: scratch }])
  // At the next start both are listed already, and nothing is added twice.
  assert.deepEqual(ensureWorkspaces({ harnessDir, dshHome: home }), [])
  assert.equal(listed(home).length, 2)
})

test('a scratch folder a git repository would hold is neither made nor listed, and the line says which repository', () => {
  const repo = temp()
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const harnessDir = join(repo, 'Harness')
  mkdirSync(harnessDir)
  const home = dshHomeWith()
  const scratch = scratchRootOf(harnessDir)
  const top = gitTopOf(scratch)
  assert.ok(top, 'the repository is found from the nearest folder that exists')
  assert.deepEqual(ensureWorkspaces({ harnessDir, dshHome: home }), [
    `no-project: added workspace ${join(harnessDir, 'no-project')}`,
    `kzh-scratch: not added: ${scratch} is inside the git repository ${top}, where an agent would take that repository for its project`,
  ])
  assert.equal(existsSync(scratch), false, 'not made')
  assert.deepEqual(listed(home).map((w) => w.title), ['No project'])
  assert.equal(gitTopOf(temp()), null, 'a folder outside every repository has none')
})

test('before DSH has made its workspace store, both folders are made and nothing is said; the next start lists them', () => {
  const root = temp()
  const harnessDir = join(root, 'Harness')
  mkdirSync(harnessDir)
  const home = temp()
  assert.deepEqual(ensureWorkspaces({ harnessDir, dshHome: home }), [])
  assert.equal(existsSync(join(scratchRootOf(harnessDir), 'README.md')), true)
  assert.equal(existsSync(join(harnessDir, 'no-project', 'README.md')), true)
})

test('run as a script through a link to the harness folder (a junction on Windows), it still lists both workspaces, as Start-KzH.ps1 runs it', () => {
  const root = temp()
  // A harness folder of this test's own, holding only the script, and a link to it.
  const harnessDir = join(root, 'Harness')
  mkdirSync(join(harnessDir, 'scripts'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../../../scripts/ensure-no-project.mjs', import.meta.url)), join(harnessDir, 'scripts', 'ensure-no-project.mjs'))
  const link = join(root, 'Linked')
  symlinkSync(harnessDir, link, 'junction')
  const home = dshHomeWith()
  const out = execFileSync(process.execPath, [join(link, 'scripts', 'ensure-no-project.mjs')], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.deepEqual(listed(home).map((w) => w.title), ['No project', 'KzH scratch'], `it did its work: ${JSON.stringify(out)}`)
  assert.match(out, /no-project: added workspace /)
  assert.match(out, /kzh-scratch: added workspace /)
})

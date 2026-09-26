// scripts/run-as-script.mjs: a script run through a linked folder (a junction on Windows) still
// knows it was asked to run, rather than doing nothing and exiting 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const { runAsScript } = await import(pathToFileURL(join(REPO, 'scripts', 'run-as-script.mjs')).href)

const made = []
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'kz-runas-')); made.push(d); return d }

test('a script is run when node was asked for it by its own path or through a link to its folder, and not when it is imported', () => {
  const dir = tmp()
  const file = join(dir, 'a.mjs')
  writeFileSync(file, '')
  const link = join(tmp(), 'linked')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(runAsScript(pathToFileURL(file).href, { argv1: file }), true)
  assert.equal(runAsScript(pathToFileURL(file).href, { argv1: join(link, 'a.mjs') }), true, 'through a link to its folder')
  assert.equal(runAsScript(pathToFileURL(file).href, { argv1: join(dir, 'b.mjs') }), false, 'another script')
  assert.equal(runAsScript(pathToFileURL(file).href, { argv1: undefined }), false, 'no script at all: a REPL or node -e')
  // Windows paths differ only in case when they name the same file.
  assert.equal(runAsScript(pathToFileURL(join(dir, 'Harness', 'scripts', 'a.mjs')).href, { argv1: join(dir, 'harness', 'SCRIPTS', 'A.mjs'), platform: 'win32' }), true)
  assert.equal(runAsScript(pathToFileURL(join(dir, 'A.mjs')).href, { argv1: join(dir, 'a.mjs'), platform: 'linux' }), false, 'elsewhere case counts')
})

test('every script of the harness that runs as a command answers when started through a link to the harness', () => {
  const link = join(tmp(), 'Harness')
  symlinkSync(REPO, link, process.platform === 'win32' ? 'junction' : 'dir')
  const run = (script, args) => {
    try { return execFileSync(process.execPath, [join(link, 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (err) { return `${err.stdout}${err.stderr}` }
  }
  assert.match(run('speed-run.mjs', ['--help']), /^usage: node scripts\/speed-run\.mjs/)
  assert.match(run('doc-queue.mjs', ['nope']), /usage: doc-queue\.mjs add \| list \| done \| log/)
})

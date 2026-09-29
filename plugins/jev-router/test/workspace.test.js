// Process handling the router relies on: a task text never runs as a command,
// and abort kills the whole tree even when a grandchild holds the pipe open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedSince, ensureHandoffIgnored, gatherContext, run, runChecks, snapshot } from '../workspace.js'

test('task text on stdin is data, not a command', async () => {
  const r = await run('node -e "process.stdin.pipe(process.stdout)"', [], { shell: true, input: 'hello & echo INJECTED %PATH%' })
  assert.equal(r.code, 0)
  assert.equal(r.output.trim(), 'hello & echo INJECTED %PATH%')
})

test('abort kills a shell child and its grandchild promptly', async () => {
  const ac = new AbortController()
  const started = Date.now()
  setTimeout(() => ac.abort(), 300)
  const grandchild = "require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' })"
  const r = await run(`node -e "${grandchild}"`, [], { shell: true, signal: ac.signal })
  assert.notEqual(r.code, 0)
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
})

test('.kz-harness/ is not an agent change and is excluded from git locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const before = await snapshot(dir)
  mkdirSync(join(dir, '.kz-harness'))
  writeFileSync(join(dir, '.kz-harness', 'handoff.md'), 'note')
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.deepEqual((await changedSince(dir, before)).files, ['a.txt'])
  await ensureHandoffIgnored(dir)
  await ensureHandoffIgnored(dir)
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split(/\r?\n/).filter((l) => l === '.kz-harness/').length, 1)
  await ensureHandoffIgnored(mkdtempSync(join(tmpdir(), 'jev-nogit-'))) // outside git: no-op, no throw
})

test('runChecks runs its scripts with the environment it is given, so a check that runs an agent\'s code can be kept from KzH\'s keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kz-checks-env-'))
  const show = "console.log('seen=' + (process.env.KZH_CHECK_SEEN ?? 'unset') + ' key=' + (process.env.KZH_TEST_SECRET_KEY ?? 'none'))"
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'env-check', private: true, scripts: { test: `node -e "${show}"` } }))
  process.env.KZH_TEST_SECRET_KEY = 'in-kzh-only'
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'KZH_TEST_SECRET_KEY'))
    const [given] = await runChecks(dir, { scripts: ['test'], timeoutMs: 60_000, outputChars: 500, env: { ...env, KZH_CHECK_SEEN: 'given' } })
    assert.equal(given.passed, true, given.output)
    assert.match(given.output, /seen=given key=none/, 'the environment given, and nothing of KzH\'s beside it')
    // With none given, the checks run in KzH's own, as they always have.
    const [own] = await runChecks(dir, { scripts: ['test'], timeoutMs: 60_000, outputChars: 500 })
    assert.match(own.output, /seen=unset key=in-kzh-only/)
  } finally {
    delete process.env.KZH_TEST_SECRET_KEY
  }
})

test('run() says when its own time limit ended the command, and not when the caller stopped it', async () => {
  const slow = 'node -e "setTimeout(() => {}, 20000)"'
  const timed = await run(slow, [], { shell: true, timeoutMs: 300 })
  assert.equal(timed.timedOut, true)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const stopped = await run(slow, [], { shell: true, timeoutMs: 60_000, signal: ac.signal })
  assert.equal(stopped.timedOut, undefined, 'a stop is not a time limit')
  const quick = await run('node -e "0"', [], { shell: true })
  assert.equal(quick.timedOut, undefined)
})

test('a time limit ends every process the command started, also one that would spin for good, so a hanging check leaves nothing running', async () => {
  const spin = "const c = require('child_process').spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }); console.log('grandchild ' + c.pid); setInterval(() => {}, 1000)"
  const r = await run(process.execPath, ['-e', spin], { timeoutMs: 1500 })
  const pid = Number(/grandchild (\d+)/.exec(r.output)?.[1])
  assert.ok(pid > 0, r.output)
  // Gone, or a zombie waiting to be reaped, which runs nothing.
  const alive = () => {
    try { process.kill(pid, 0) } catch { return false }
    try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
  }
  try {
    assert.equal(r.timedOut, true)
    const deadline = Date.now() + 5000
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(alive(), false, 'the process the command started is gone')
  } finally {
    // Where it survived, this test does not leave it spinning.
    if (alive()) process.kill(pid, 'SIGKILL')
  }
})

test('reading the tree never rewrites the git index, so an agent committing in the same folder never meets KzH\'s lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'one')
  // Same content, new times: the index entry is stat-dirty, which plain `git status` refreshes by
  // taking .git/index.lock and writing the index back.
  const later = new Date(Date.now() + 120_000)
  utimesSync(join(dir, 'a.txt'), later, later)
  const index = () => readFileSync(join(dir, '.git', 'index'))
  const before = index()
  await snapshot(dir)
  await gatherContext(dir, {})
  assert.ok(index().equals(before), 'the index is byte for byte as it was')
})

test('snapshotDiff names what changed between two snapshots without running git, and changedSince reports the same files', async () => {
  const ws = await import('../workspace.js')
  assert.equal(typeof ws.snapshotDiff, 'function')
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git('add', '.')
  git('commit', '-qm', 'one')
  writeFileSync(join(dir, 'dirty.txt'), 'already here\n')
  const before = await snapshot(dir)
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  writeFileSync(join(dir, 'dirty.txt'), 'changed again\n')
  writeFileSync(join(dir, 'new.txt'), 'n\n')
  const after = await snapshot(dir)
  assert.deepEqual(ws.snapshotDiff(before, after).sort(), ['a.txt', 'dirty.txt', 'new.txt'])
  assert.deepEqual(ws.snapshotDiff(before, before), [])
  assert.equal(ws.snapshotDiff({ git: false }, after), null)
  assert.deepEqual((await changedSince(dir, before)).files.sort(), ['a.txt', 'dirty.txt', 'new.txt'])
})

test('a workspace that is a subfolder of its repository sees a change to a file already changed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-ws-sub-'))
  const g = (...a) => execFileSync('git', a, { cwd: root })
  mkdirSync(join(root, 'app'))
  writeFileSync(join(root, 'app', 'a.txt'), 'one')
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  writeFileSync(join(root, 'app', 'a.txt'), 'two') // already changed before the run
  const cwd = join(root, 'app')
  const before = await snapshot(cwd)
  assert.ok(before.hashes.get('app/a.txt'), 'the changed file was hashed from the repository top')
  writeFileSync(join(root, 'app', 'a.txt'), 'three')
  assert.deepEqual((await changedSince(cwd, before)).files, ['app/a.txt'])
})

test('a path git cannot hash nulls only itself, and is named as unseen', async () => {
  const ws = await import('../workspace.js')
  assert.equal(typeof ws.unseenPaths, 'function')
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-nested-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'one')
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  writeFileSync(join(dir, 'a.txt'), 'two')
  mkdirSync(join(dir, 'vendor'))
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'vendor') })
  writeFileSync(join(dir, 'vendor', 'x.txt'), 'x')
  const before = await snapshot(dir)
  assert.ok(before.hashes.get('a.txt'), 'a hashable file keeps its hash beside one that is not')
  assert.equal(before.hashes.get('vendor/') ?? null, null)
  writeFileSync(join(dir, 'a.txt'), 'three')
  const after = await snapshot(dir)
  assert.deepEqual(ws.snapshotDiff(before, after), ['a.txt'])
  assert.deepEqual(ws.unseenPaths(before, after), ['vendor/'])
})

test('a submodule counts with its superproject as one repository', async () => {
  const ws = await import('../workspace.js')
  assert.equal(typeof ws.outerRepoRoot, 'function')
  const base = mkdtempSync(join(tmpdir(), 'jev-ws-super-'))
  const commit = (cwd) => { execFileSync('git', ['add', '-A'], { cwd }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c'], { cwd }) }
  const lib = join(base, 'lib')
  mkdirSync(lib); execFileSync('git', ['init', '-q'], { cwd: lib }); writeFileSync(join(lib, 'x'), 'x'); commit(lib)
  const top = join(base, 'top')
  mkdirSync(top); execFileSync('git', ['init', '-q'], { cwd: top }); writeFileSync(join(top, 'y'), 'y'); commit(top)
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub'], { cwd: top })
  const real = (p) => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: p, encoding: 'utf8' }).trim()
  assert.equal(await ws.outerRepoRoot(join(top, 'sub')), real(top))
  assert.equal(await ws.outerRepoRoot(top), real(top))
  assert.equal(await ws.outerRepoRoot(tmpdir()), null)
})

// A throwaway repository with the given files committed; `g` runs git in it.
const committed = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-ws-git-'))
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q')
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text) }
  g('add', '-A'); g('commit', '-qm', 'init')
  return { dir, g }
}

test('a staged deletion is nothing to hash and no path git cannot see into', async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'a.txt': 'a', 'old.js': 'old' })
  g('rm', '-q', 'old.js')
  const before = await snapshot(dir)
  assert.equal(before.hashes.get('old.js'), ws.ABSENT)
  const after = await snapshot(dir)
  assert.deepEqual([ws.snapshotDiff(before, after), ws.unseenPaths(before, after)], [[], []])
})

test('a file in a conflict is read from the working tree, whatever its status letters say', async () => {
  const { dir, g } = committed({ 'c.txt': 'base\n' })
  g('checkout', '-q', '-b', 'theirs'); g('rm', '-q', 'c.txt'); g('commit', '-qm', 'gone')
  g('checkout', '-q', '-'); writeFileSync(join(dir, 'c.txt'), 'ours\n'); g('commit', '-qam', 'ours')
  try { g('merge', '-q', 'theirs') } catch { /* the conflict is the point */ }
  const before = await snapshot(dir)
  assert.equal(before.status.get('c.txt'), 'UD')
  assert.match(before.hashes.get('c.txt'), /^[0-9a-f]{40}$/)
  writeFileSync(join(dir, 'c.txt'), 'edited in the conflict\n')
  const ws = await import('../workspace.js')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(dir)), ['c.txt'])
})

test('a rename in the working tree is read as the new path, and its source is no path of its own', async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'a.txt': 'line1\nline2\nline3\n' })
  // Moved on disk and marked with intent to add: git lists the rename in the working tree (' R').
  execFileSync(process.platform === 'win32' ? 'cmd' : 'mv', process.platform === 'win32' ? ['/c', 'move', 'a.txt', 'b.txt'] : ['a.txt', 'b.txt'], { cwd: dir })
  g('add', '-N', 'b.txt')
  const before = await snapshot(dir)
  assert.deepEqual([...before.status.keys()], ['b.txt'])
  assert.deepEqual(ws.unseenPaths(before, await snapshot(dir)), [])
})

test('in a workspace below its repository\'s top the diff names what changed, and the notes there are no change', async () => {
  const { dir } = committed({ 'pkg/src/a.txt': 'one\n', 'other.txt': 'x\n' })
  const cwd = join(dir, 'pkg')
  const before = await snapshot(cwd)
  writeFileSync(join(dir, 'pkg', 'src', 'a.txt'), 'two\n')
  mkdirSync(join(cwd, '.kz-harness'))
  writeFileSync(join(cwd, '.kz-harness', 'handoff.md'), 'notes')
  const c = await changedSince(cwd, before)
  assert.deepEqual(c.files, ['pkg/src/a.txt'])
  assert.match(c.stat, /pkg\/src\/a\.txt \| 2 \+-/)
  assert.match(c.patch, /^\+two$/m)
})

test('an attempt that changed nothing has no diff, however much else is changed in the repository', async () => {
  const { dir } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(dir, 'a.txt'), 'changed before the attempt\n')
  const before = await snapshot(dir)
  assert.deepEqual(await changedSince(dir, before), { files: [], stat: '', patch: '' })
})

test('a nested repository among many changed files: one git process hashes the files, and only the folder is unseen', async () => {
  const ws = await import('../workspace.js')
  const { dir } = committed({ 'a.txt': 'a\n' })
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `new-${i}.txt`), `${i}\n`)
  mkdirSync(join(dir, 'vendor'))
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'vendor') })
  writeFileSync(join(dir, 'vendor', 'x.txt'), 'x')
  // Every git call it starts, counted through a PATH shim that runs the real git.
  const bin = mkdtempSync(join(tmpdir(), 'jev-ws-bin-'))
  const count = join(bin, 'count')
  const realGit = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho x >> "${count}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${path}`
  try {
    const before = await snapshot(dir)
    if (process.platform !== 'win32') assert.ok(readFileSync(count, 'utf8').split('\n').filter(Boolean).length <= 4, 'status, the top folder and one hash-object')
    assert.equal(before.hashes.get('vendor/'), null)
    assert.match(before.hashes.get('new-399.txt'), /^[0-9a-f]{40}$/)
    writeFileSync(join(dir, 'new-7.txt'), 'changed\n')
    const after = await snapshot(dir)
    assert.deepEqual([ws.snapshotDiff(before, after), ws.unseenPaths(before, after)], [['new-7.txt'], ['vendor/']])
  } finally { process.env.PATH = path }
})

// Every git call a function starts while it runs, counted through a PATH shim that runs the real git.
// `slow` names a call ("hash-object --stdin-paths") that waits 3 s before it runs; `vanish` is a
// file removed as the first such call starts, after it was listed and found to be a file.
async function gitCalls(fn, { slow = null, vanish = null } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'jev-ws-bin-'))
  const count = join(bin, 'count')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const wait = slow ? `[ "$1 $2" = "${slow}" ] && sleep 3\n` : ''
  const gone = vanish ? `[ "$1 $2" = "hash-object --stdin-paths" ] && rm -f "${vanish}"\n` : ''
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$1 $2" >> "${count}"\n${wait}${gone}exec "${realGit}" "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const value = await fn()
    // No file at all: not one git process started.
    return { value, calls: (() => { try { return readFileSync(count, 'utf8').split('\n').filter(Boolean) } catch { return [] } })() }
  } finally { process.env.PATH = path }
}

test('a workspace below its repository\'s top is hashed by one git process, and never from a folder beside the repository', { skip: process.platform === 'win32' }, async () => {
  const ws = await import('../workspace.js')
  // A folder of projects: the repository mono, its package web, and a folder web beside mono with
  // the same relative path (an old copy), which must never be what is hashed.
  const projects = mkdtempSync(join(tmpdir(), 'jev-ws-projects-'))
  const mono = join(projects, 'mono')
  mkdirSync(join(mono, 'web', 'src'), { recursive: true })
  writeFileSync(join(mono, 'web', 'src', 'a.js'), 'one\n')
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: mono })
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init')
  mkdirSync(join(projects, 'web', 'src'), { recursive: true })
  writeFileSync(join(projects, 'web', 'src', 'a.js'), 'the copy beside it\n')
  writeFileSync(join(mono, 'web', 'src', 'a.js'), 'two\n') // already changed before the run
  for (let i = 0; i < 200; i++) writeFileSync(join(mono, 'web', `new-${i}.txt`), `${i}\n`)
  const cwd = join(mono, 'web')
  const { value: before, calls } = await gitCalls(() => snapshot(cwd))
  assert.equal(calls.filter((c) => c.startsWith('hash-object')).length, 1, calls.join('; '))
  assert.equal(before.hashes.get('web/src/a.js'), execFileSync('git', ['hash-object', 'src/a.js'], { cwd, encoding: 'utf8' }).trim())
  writeFileSync(join(mono, 'web', 'src', 'a.js'), 'three\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(cwd)), ['web/src/a.js'])
})

test('a stop while the files are hashed ends the reading at once, with no git process per file', { skip: process.platform === 'win32' }, async () => {
  const { dir } = committed({ 'a.txt': 'a\n' })
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, `new-${i}.txt`), `${i}\n`)
  // The one hashing call is slow, and the stop lands while it runs.
  const ac = new AbortController()
  const { calls } = await gitCalls(() => { setTimeout(() => ac.abort(), 400); return snapshot(dir, ac.signal) }, { slow: 'hash-object --stdin-paths' })
  assert.ok(calls.includes('hash-object --stdin-paths'), 'the stop landed while the files were hashed')
  assert.equal(calls.filter((c) => c === 'hash-object --').length, 0, calls.join('; '))
})

test('a file that goes away between the listing and the hashing is absent, and the rest are still hashed by one process', { skip: process.platform === 'win32' }, async () => {
  const { dir } = committed({ 'a.txt': 'a\n' })
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, `new-${i}.txt`), `${i}\n`)
  // An editor's temp file: listed by git status and found to be a file, gone by the time it is hashed.
  writeFileSync(join(dir, 'temp.swp'), 'x')
  const { value: snap, calls } = await gitCalls(() => snapshot(dir), { vanish: join(dir, 'temp.swp') })
  const ws = await import('../workspace.js')
  assert.equal(snap.hashes.get('temp.swp'), ws.ABSENT)
  assert.match(snap.hashes.get('new-49.txt'), /^[0-9a-f]{40}$/)
  assert.deepEqual([calls.filter((c) => c === 'hash-object --stdin-paths').length, calls.filter((c) => c === 'hash-object --').length], [2, 0], 'once more without it, and no git process per file')
})

test('git\'s own files are compared by content: a config written with the value it held is no change, a new hook is', async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'a.txt': 'a\n' })
  g('config', 'core.hooksPath', '.git/hooks')
  const before = await snapshot(dir, undefined, { meta: true })
  g('config', 'core.hooksPath', '.git/hooks') // rewritten, the same value, as husky's install does
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(dir, undefined, { meta: true })), [])
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(dir, undefined, { meta: true })), ['.git/hooks/pre-commit'])
})

test('a hooks folder outside the repository, which any repository may write, is left out of the comparison', async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'a.txt': 'a\n' })
  const shared = mkdtempSync(join(tmpdir(), 'jev-ws-hooks-'))
  g('config', 'core.hooksPath', shared)
  const before = await snapshot(dir, undefined, { meta: true })
  writeFileSync(join(shared, 'pre-push'), '#!/bin/sh\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(dir, undefined, { meta: true })), [])
})

test('two worktrees of one repository share one git folder', async () => {
  const ws = await import('../workspace.js')
  assert.equal(typeof ws.commonGitDir, 'function')
  const { dir, g } = committed({ 'a.txt': 'a\n' })
  const feat = `${dir}-feat`
  g('worktree', 'add', '-q', feat)
  assert.equal(await ws.commonGitDir(feat), await ws.commonGitDir(dir))
  assert.equal(await ws.commonGitDir(tmpdir()), null)
  rmSync(feat, { recursive: true, force: true })
})

test('a workspace reached through a link reads the same files: a subfolder\'s changes, and a hooks folder in the working tree named where it is', { skip: process.platform === 'win32' }, async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'sub/a.txt': 'one\n', '.husky/_/.gitignore': '*\n' })
  g('config', 'core.hooksPath', '.husky/_')
  writeFileSync(join(dir, 'sub', 'a.txt'), 'two\n') // already changed before the run
  writeFileSync(join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\n')
  const links = mkdtempSync(join(tmpdir(), 'jev-ws-links-'))
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(dir, 'sub'), join(links, 'sub-link'))
  symlinkSync(dir, join(links, 'repo-link'))
  // A subfolder of the repository, reached through a link.
  const before = await snapshot(join(links, 'sub-link'))
  assert.match(before.hashes.get('sub/a.txt'), /^[0-9a-f]{40}$/)
  writeFileSync(join(dir, 'sub', 'a.txt'), 'three\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(join(links, 'sub-link'))), ['sub/a.txt'])
  // The repository through a link: its husky hooks are read, under their own names.
  const cwd = join(links, 'repo-link')
  const metaBefore = await snapshot(cwd, undefined, { meta: true })
  writeFileSync(join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\necho planted\n')
  assert.deepEqual(ws.snapshotDiff(metaBefore, await snapshot(cwd, undefined, { meta: true })), ['.husky/_/pre-commit'])
})

test('a tracked hooks folder\'s change is named once, and a linked worktree opened through a link still shares its git folder', { skip: process.platform === 'win32' }, async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ '.githooks/pre-commit': '#!/bin/sh\n' })
  g('config', 'core.hooksPath', '.githooks')
  const before = await snapshot(dir, undefined, { meta: true })
  writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\necho planted\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(dir, undefined, { meta: true })), ['.githooks/pre-commit'])
  const feat = `${dir}-feat`
  g('worktree', 'add', '-q', feat)
  const { symlinkSync } = await import('node:fs')
  const link = `${dir}-link`
  symlinkSync(dir, link)
  assert.equal(await ws.commonGitDir(link), await ws.commonGitDir(feat))
  rmSync(feat, { recursive: true, force: true })
  rmSync(link, { force: true })
})

test('git\'s own files are read through a link into a subfolder too, and its worktrees still share one git folder', { skip: process.platform === 'win32' }, async () => {
  const ws = await import('../workspace.js')
  const { dir, g } = committed({ 'sub/a.txt': 'a\n', '.husky/_/.gitignore': '*\n' })
  g('config', 'core.hooksPath', '.husky/_')
  writeFileSync(join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\n')
  const links = mkdtempSync(join(tmpdir(), 'jev-ws-links-'))
  const { symlinkSync } = await import('node:fs')
  const cwd = join(links, 'sub-link')
  symlinkSync(join(dir, 'sub'), cwd)
  const before = await snapshot(cwd, undefined, { meta: true })
  g('config', 'alias.planted', '!echo planted')
  writeFileSync(join(dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\necho planted\n')
  assert.deepEqual(ws.snapshotDiff(before, await snapshot(cwd, undefined, { meta: true })).sort(), ['.git/config', '.husky/_/pre-commit'])
  assert.equal(await ws.commonGitDir(cwd), await ws.commonGitDir(dir))
})

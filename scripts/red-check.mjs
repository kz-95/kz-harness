// Proves that every new test fails against the code before a change (docs/laya-auto.md 9.1):
//
//   node scripts/red-check.mjs <test files...> [--base <commit>]
//
// A test that passes on the old code proves nothing about the new code, and one failing new test
// in a file must not carry ten that pass, so this reads the result of every test, not of every
// file. It adds a temporary git worktree at the base (default 8e5d376, the commit the Laya Auto
// design was written against), links the current plugin's node_modules into it (a directory
// junction on Windows, a symlink elsewhere: node_modules is untracked, and without it every test
// that imports jev.js or index.js fails on a missing package, never by assertion), and then per
// test file:
//
//   1. runs it on the current code, where every test must pass, to learn the test names;
//   2. runs the base's own version of the file, when there is one, to learn which tests are old;
//   3. copies the current file, with the plugin's test/fixtures, into the base and runs it there.
//
// A test is new when its full name is not among the base version's tests. Every new test must
// fail at the base, and the failure must be one of three kinds: an assertion; a missing module,
// only for a new module's own tests (a test file the base lacks, named for a module this change
// adds: test/<m>.test.js tests <m>.js); or a missing export (`SyntaxError: The requested module
// ... does not provide an export named ...`). Anything else (a TypeError, a timeout, a cancelled
// test) says the test broke rather than disproved the old code, and so does a missing module
// anywhere else: a test that merely imports a module this change adds would fail at the base
// whatever it asserts. An extended test file must still load at the base, so it imports a new
// export of an existing module through a namespace import or a dynamic import() inside the test;
// a new module's own test file may fail to load, on that module.
//
// A new test that failed at the base in a way that proves nothing there (a module or a file this
// change adds was missing, say) gets one more run, on the base with every file this change adds put
// in place and none it edits:
//
//   4. copies in every file the working tree has and the base lacks, and runs those files again.
//
// There it counts only when it fails by an assertion or a missing export: then the old code of the
// files the change edits is what fails it. One that passes there tested only what the change adds,
// and belongs in that module's own test file.
//
// One test file is the exception: test/fixtures.test.js, named for the plugin's test/fixtures
// folder, tests that shared test code (a fake server, captured request bodies), which step 3 copies
// into the base with every test file. Its tests test no code of the plugin, so they cannot fail on
// the old code, and are not asked to: each new one must pass at the base instead, which shows it
// tests only the fixtures, and is listed as such. One that fails there tests the code under test,
// and belongs in that code's own test file, where it counts as a new test.
//
// Exits 0 when every new test failed at the base by an accepted kind and every new test of the
// fixtures passed there, 1 naming each one that did not, 2 on a usage error. The worktree is
// removed on the way out.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const DEFAULT_BASE = '8e5d376'

function usage(message) {
  if (message) console.error(`red-check: ${message}`)
  console.error('usage: node scripts/red-check.mjs <test files...> [--base <commit>] [--keep]')
  process.exit(2)
}

// --- arguments ----------------------------------------------------------------------------------

const args = process.argv.slice(2)
let base = DEFAULT_BASE
// --keep leaves the base checkout in place and says where, to look at why a test did what it did.
let keep = false
const given = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--base') base = args[++i] ?? usage('--base needs a commit')
  else if (a.startsWith('--base=')) base = a.slice('--base='.length)
  else if (a === '--keep') keep = true
  else if (a === '--help' || a === '-h') usage()
  else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else given.push(a)
}
if (!given.length) usage('name at least one test file')

const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let root
try { root = resolve(run('git', ['rev-parse', '--show-toplevel'], process.cwd())) } catch { usage('run it inside the git checkout') }
const gitPath = (p) => p.split(sep).join('/')

let sha
try { sha = run('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root) } catch { usage(`no commit ${base} in this checkout`) }
const atBase = (rel) => spawnSync('git', ['cat-file', '-e', `${sha}:${gitPath(rel)}`], { cwd: root }).status === 0

/**
 * Each test file, with the plugin it belongs to: the folder above its `test` folder, which holds
 * the package.json and the node_modules its imports resolve against.
 */
const files = given.map((g) => {
  const abs = resolve(g)
  if (!existsSync(abs) || !statSync(abs).isFile()) usage(`${g} is not a file`)
  const rel = relative(root, abs)
  if (rel.startsWith('..')) usage(`${g} is outside ${root}`)
  if (basename(dirname(abs)) !== 'test' || !existsSync(join(dirname(dirname(abs)), 'package.json'))) usage(`${g} is not in a plugin's test folder`)
  const plugin = relative(root, dirname(dirname(abs)))
  // The fixtures' own test file, which tests the shared test code rather than the plugin.
  const fixtures = basename(abs) === 'fixtures.test.js' && existsSync(join(dirname(abs), 'fixtures'))
  return { rel, plugin, inPlugin: gitPath(relative(join(root, plugin), abs)), existed: atBase(rel), fixtures }
})

// --- reading node --test's TAP ------------------------------------------------------------------

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' })[c] ?? c)

function unquote(v) {
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
  if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v) } catch { return v.slice(1, -1) } }
  return v
}

/** The `key: value` lines of one test's YAML block, block scalars joined. */
function yamlBlock(lines, indent) {
  const pad = ' '.repeat(indent)
  const out = {}
  for (let k = 0; k < lines.length; k++) {
    const m = /^([A-Za-z_]+):(?: (.*))?$/.exec(lines[k].startsWith(pad) ? lines[k].slice(indent) : '')
    if (!m) continue
    const v = m[2] ?? ''
    if (v === '|-' || v === '|') {
      const more = []
      while (k + 1 < lines.length && (lines[k + 1].startsWith(`${pad}  `) || !lines[k + 1].trim())) more.push(lines[++k].slice(indent + 2))
      out[m[1]] = more.join('\n')
    } else out[m[1]] = unquote(v)
  }
  return out
}

/**
 * Every test in one run, by its full name (`parent > child`), leaves only: a parent passes or
 * fails with its children. A file that did not load is one test named after the file, with an
 * `exitCode`, and the loader's error in the comment lines before it.
 */
function parseTap(text) {
  const lines = text.split(/\r?\n/)
  const all = []
  const comments = []
  const stack = []
  for (let i = 0; i < lines.length; i++) {
    const sub = /^( *)# Subtest: (.*)$/.exec(lines[i])
    if (sub) { const d = sub[1].length / 4; stack.length = d; stack[d] = unescape(sub[2]); continue }
    const res = /^( *)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: .*)?)?$/.exec(lines[i])
    if (res) {
      const d = res[1].length / 4
      const name = [...stack.slice(0, d), unescape(res[3])].join(' > ')
      let diag = {}
      if (lines[i + 1] === `${res[1]}  ---`) {
        let j = i + 2
        const block = []
        while (j < lines.length && lines[j] !== `${res[1]}  ...`) block.push(lines[j++])
        diag = yamlBlock(block, res[1].length + 2)
        i = j
      }
      // The block has a `name` of its own (the error's class), so it stays apart from the test's.
      all.push({ name, ok: res[2] === 'ok', directive: res[4] ?? null, diag })
      stack.length = d
      continue
    }
    const c = /^# (.*)$/.exec(lines[i])
    if (c) comments.push(c[1])
  }
  const parents = new Set(all.flatMap((t) => t.name.split(' > ').slice(0, -1).map((_, k, parts) => parts.slice(0, k + 1).join(' > '))))
  const leaves = all.filter((t) => !parents.has(t.name))
  // Two tests may share a name; the second is told apart by its place.
  const seen = new Map()
  for (const t of leaves) { const n = (seen.get(t.name) ?? 0) + 1; seen.set(t.name, n); t.key = n > 1 ? `${t.name} (#${n})` : t.name }
  const loadFailed = all.length === 1 && 'exitCode' in all[0].diag && !all[0].ok
  return { tests: leaves, loadFailed, comments }
}

function runFile(file, cwd) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 })
  if (r.error) throw new Error(`red-check: could not run ${file} in ${cwd}: ${r.error.message}`)
  return parseTap(r.stdout ?? '')
}

// --- what kind of failure -----------------------------------------------------------------------

/**
 * The module a missing-module error names, repo-relative, when it is inside the base checkout. The
 * loader may report the checkout by its real path (a temporary folder behind a symlink), so both
 * spellings count.
 */
function moduleIn(path, dir) {
  if (!path) return null
  const p = resolve(path)
  for (const d of new Set([resolve(dir), realpathOr(dir)])) if (p.startsWith(d + sep)) return relative(d, p)
  return null
}
const realpathOr = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }

function kindOfTest({ diag: d }) {
  if (/cancel/i.test(d.failureType ?? '')) return { kind: 'cancelled', detail: d.error }
  if (d.failureType === 'testTimeoutFailure') return { kind: 'timeout', detail: d.error }
  if (d.code === 'ERR_ASSERTION' || d.name === 'AssertionError') return { kind: 'assertion' }
  if (d.code === 'ERR_MODULE_NOT_FOUND') return { kind: 'missing module', path: /Cannot find module '([^']+)'/.exec(d.error ?? '')?.[1] }
  if (d.name === 'SyntaxError' && /does not provide an export named/.test(d.error ?? '')) return { kind: 'missing export', detail: d.error }
  return { kind: d.name ?? d.code ?? 'error', detail: d.error }
}

function kindOfLoad(comments) {
  const text = comments.join('\n')
  const missing = /Cannot find module '([^']+)'/.exec(text)
  if (missing && /ERR_MODULE_NOT_FOUND/.test(text)) return { kind: 'missing module', path: missing[1] }
  const exp = /SyntaxError: (The requested module '[^']+' does not provide an export named '[^']+')/.exec(text)
  if (exp) return { kind: 'missing export', detail: exp[1] }
  return { kind: 'load error', detail: comments.find((l) => /Error/.test(l)) ?? 'the file did not load' }
}

/**
 * The modules a test file is named for, repo-relative and without their extension: test/<m>.test.js
 * tests the plugin's <m>.js, or the repository's scripts/<m>.mjs, whose tests live in the plugin's
 * test folder beside the others (red-check.test.js tests this file).
 */
const ownModules = (f) => { const m = basename(f.rel).replace(/\.test\.[cm]?js$/, ''); return [join(f.plugin, m), join('scripts', m)] }

/** Why a failure of a test in file `f` at the base does not count, or null when it does. */
function refused(k, wt, f) {
  if (k.kind === 'assertion' || k.kind === 'missing export') return null
  if (k.kind === 'missing module') {
    const rel = moduleIn(k.path, wt)
    if (!rel) return `a missing module outside the base checkout (${k.path})`
    if (atBase(rel) || !existsSync(join(root, rel))) return `a missing module this change does not add (${gitPath(rel)})`
    // Only a new module's own tests may fail on its absence. Anywhere else a test that merely
    // imports a module this change adds would fail at the base whatever it asserts.
    if (f.existed) return `a missing module (${gitPath(rel)}) in a file the base already has, where only an assertion or a missing export counts`
    if (!ownModules(f).includes(rel.replace(/\.[cm]?js$/, ''))) return `a missing module (${gitPath(rel)}) that ${basename(f.rel)} is not named for: only a new module's own test file (test/<m>.test.js for <m>.js) may fail on the module's absence, and it imports that module first`
    return null
  }
  return `${k.kind}${k.detail ? ` (${String(k.detail).split('\n')[0]})` : ''}, which is not one of assertion, missing module or missing export`
}

const describe = (k, wt) => (k.kind === 'missing module' ? `missing module ${gitPath(moduleIn(k.path, wt) ?? k.path)}` : k.kind)

/**
 * Every file this change adds, repo-relative: in the working tree now and not at the base, whether
 * committed, staged or untracked (never an ignored one, such as node_modules).
 */
function addedFiles() {
  const list = (argv) => run('git', argv, root).split('\0').filter(Boolean)
  const tracked = list(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', sha])
  const untracked = list(['ls-files', '--others', '--exclude-standard', '-z'])
  return [...new Set([...tracked, ...untracked])].filter((rel) => existsSync(join(root, rel)) && statSync(join(root, rel)).isFile())
}

// --- the run ------------------------------------------------------------------------------------

const problems = []
const problem = (file, test, why) => problems.push(`${file.rel}${test ? `: ${test}` : ''}: ${why}`)

// The current code first: the names of every test, and each must pass here, or its failure at the
// base proves nothing.
for (const f of files) {
  const now = runFile(f.inPlugin, join(root, f.plugin))
  if (now.loadFailed) { const k = kindOfLoad(now.comments); problem(f, null, `does not load on the current code: ${k.detail ?? `${k.kind} ${k.path}`}`); f.now = []; continue }
  f.now = now.tests
  for (const t of now.tests) if (!t.ok) problem(f, t.name, 'fails on the current code too')
}

const tmp = mkdtempSync(join(tmpdir(), 'red-check-'))
const wt = join(tmp, 'base')
const links = []
let added = false
function cleanUp() {
  if (keep && added) { console.log(`\nred-check: the base checkout is kept at ${wt}; remove it with git worktree remove --force ${wt}`); return }
  for (const l of links) { try { if (lstatSync(l).isSymbolicLink()) unlinkSync(l) } catch { /* already gone */ } }
  links.length = 0
  // Should git not remove it, the folder goes anyway and git forgets the worktree it no longer finds.
  const removed = !added || spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root }).status === 0
  added = false
  rmSync(tmp, { recursive: true, force: true })
  if (!removed) spawnSync('git', ['worktree', 'prune'], { cwd: root })
}
process.on('SIGINT', () => { cleanUp(); process.exit(130) })

try {
  run('git', ['worktree', 'add', '--detach', '--quiet', wt, sha], root)
  added = true
  const subject = run('git', ['log', '-1', '--format=%h %s', sha], root)
  console.log(`red-check against ${subject}`)

  for (const plugin of new Set(files.map((f) => f.plugin))) {
    const modules = join(root, plugin, 'node_modules')
    if (!existsSync(modules)) continue
    const link = join(wt, plugin, 'node_modules')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(realpathSync(modules), link, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(link)
  }

  // The base's own version of each file that has one, before anything is copied over it.
  for (const f of files) f.old = f.existed ? runFile(f.inPlugin, join(wt, f.plugin)) : null

  for (const plugin of new Set(files.map((f) => f.plugin))) {
    const fixtures = join(root, plugin, 'test', 'fixtures')
    if (existsSync(fixtures)) cpSync(fixtures, join(wt, plugin, 'test', 'fixtures'), { recursive: true })
  }
  for (const f of files) {
    mkdirSync(dirname(join(wt, f.rel)), { recursive: true })
    cpSync(join(root, f.rel), join(wt, f.rel))
  }

  let total = 0
  let ofFixtures = 0
  // New tests that failed at the base in a way that proves nothing there, each with why, for the
  // second run below.
  const again = []
  for (const f of files) {
    if (f.old?.loadFailed) problem(f, null, "the base's own version does not load, so it cannot say which tests are old")
    const oldKeys = new Set(f.old?.tests.map((t) => t.key) ?? [])
    const fresh = f.now.filter((t) => !oldKeys.has(t.key))
    if (f.fixtures) ofFixtures += fresh.length
    else total += fresh.length
    console.log(`\n${f.rel}${f.existed ? '' : ' (new file)'}: ${fresh.length} new of ${f.now.length} tests${f.fixtures ? ', of the fixtures, which must pass at the base' : ''}`)
    if (!fresh.length) { console.log('  no new tests'); continue }
    const then = runFile(f.inPlugin, join(wt, f.plugin))
    const byKey = new Map(then.tests.map((t) => [t.key, t]))
    const load = then.loadFailed ? kindOfLoad(then.comments) : null
    if (f.fixtures) {
      if (load) { problem(f, null, `does not load at the base (${describe(load, wt)}), so it needs code this change adds: move the tests that do to that code's own test file`); continue }
      for (const t of fresh) {
        const at = byKey.get(t.key)
        if (!at) problem(f, t.name, 'did not run at the base')
        else if (at.directive) problem(f, t.name, `was marked ${at.directive} at the base`)
        else if (at.ok) console.log(`  passes at the base, as a test of the fixtures does: ${t.name}`)
        else problem(f, t.name, `fails at the base (${describe(kindOfTest(at), wt)}), so it tests the code under test rather than the fixtures: move it to that code's own test file, where it counts as a new test`)
      }
      continue
    }
    for (const t of fresh) {
      const at = then.loadFailed ? null : byKey.get(t.key)
      if (load) {
        if (f.existed) {
          problem(f, t.name, `the file does not load at the base (${describe(load, wt)}), so none of its tests ran there; import a new export through a namespace import or a dynamic import() inside the test`)
          continue
        }
        const why = refused(load, wt, f)
        if (why) again.push({ f, t, first: why })
        else console.log(`  fails at the base, ${describe(load, wt)}: ${t.name}`)
        continue
      }
      if (!at) { problem(f, t.name, 'did not run at the base'); continue }
      if (at.ok) { problem(f, t.name, at.directive ? `was marked ${at.directive} at the base` : 'passed at the base'); continue }
      const k = kindOfTest(at)
      const why = refused(k, wt, f)
      if (why) again.push({ f, t, first: `failed at the base by ${why}` })
      else console.log(`  fails at the base, ${describe(k, wt)}: ${t.name}`)
    }
  }

  // The second run: the base with every file this change adds put in place beside the code, never a
  // file it edits, for the tests that failed there only in a way that proves nothing. A test that
  // then fails by an assertion or a missing export fails on the old code of the files the change
  // edits; one that passes tested only what the change adds, and belongs in that module's own file.
  if (again.length) {
    // The test files given are in place already.
    const given = new Set(files.map((f) => gitPath(f.rel)))
    const added = addedFiles().filter((rel) => !given.has(gitPath(rel)))
    for (const rel of added) {
      mkdirSync(dirname(join(wt, rel)), { recursive: true })
      cpSync(join(root, rel), join(wt, rel))
    }
    console.log(`\nWith the ${added.length} files this change adds in place at the base, and none it edits:`)
    for (const f of files) {
      const mine = again.filter((a) => a.f === f)
      if (!mine.length) continue
      console.log(`\n${f.rel}: ${mine.length} run again`)
      const then = runFile(f.inPlugin, join(wt, f.plugin))
      const byKey = new Map(then.tests.map((t) => [t.key, t]))
      const load = then.loadFailed ? kindOfLoad(then.comments) : null
      for (const { t, first } of mine) {
        const at = load ? null : byKey.get(t.key)
        const k = load ?? (at && !at.ok ? kindOfTest(at) : null)
        const but = `${first}; and with the files this change adds in place`
        if (load) problem(f, t.name, `${but} the file does not load (${describe(load, wt)})`)
        else if (!at) problem(f, t.name, `${but} it did not run`)
        else if (at.ok) problem(f, t.name, `${but} it passes, so it tests only what the change adds: move it to that module's own test file, or make it disprove the old code of a file the change edits`)
        else if (k.kind === 'assertion' || k.kind === 'missing export') console.log(`  fails at the base with them, ${describe(k, wt)}: ${t.name}`)
        else problem(f, t.name, `${but} by ${k.kind}${k.detail ? ` (${String(k.detail).split('\n')[0]})` : k.path ? ` (${k.path})` : ''}, which is neither an assertion nor a missing export`)
      }
    }
  }

  if (problems.length) {
    console.error(`\nred-check: ${problems.length} problem${problems.length === 1 ? '' : 's'}:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exitCode = 1
  } else console.log(`\nred-check: all ${total} new tests fail at the base by an accepted kind${ofFixtures ? `, and the ${ofFixtures} new tests of the fixtures pass there` : ''}.`)
} finally {
  cleanUp()
}

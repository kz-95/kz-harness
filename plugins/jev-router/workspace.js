// Deterministic workspace facts: lightweight routing context, git change
// detection, and project checks. Nothing here asks a model anything.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { redactSecrets } from './export.js'
import { killTree as killPidTree } from './local.js'

/**
 * Kill a child and everything it started. A plain kill ends only the child: on Windows a shell
 * child's grandchildren (npm, node) survive it, and elsewhere so does every process the child
 * started, such as the file a `node --test` runner runs in a process of its own, which then spins
 * on for good when it is a loop that never ends (a check or an agent's test that hangs).
 */
export function killTree(child) {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  else if (!killPidTree(child.pid)) child.kill('SIGKILL')
}

/**
 * Spawn and collect output. Timeout and abort kill the whole tree, and the
 * promise settles on process exit (plus a short grace for stdio), so a
 * grandchild holding the pipe open cannot hang the caller.
 */
export function run(cmd, args, { cwd, shell = false, timeoutMs = 60_000, signal, env, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let settled = false
    const child = spawn(cmd, args, { cwd, shell, env, windowsHide: true })
    // Set once the time limit, rather than the caller's signal, has killed the child: a caller can
    // then say the command ran out of time instead of calling it a failure.
    let timedOut = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve({ ...r, output: out, durationMs: Date.now() - started, ...(timedOut ? { timedOut } : {}) })
    }
    const stop = () => { killTree(child); setTimeout(() => finish({ code: -1, signal: 'killed' }), 2000) }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', (err) => { out += `\n${err.message}`; finish({ code: -1 }) })
    child.on('exit', (code, sig) => setTimeout(() => finish({ code: code ?? -1, signal: sig }), 200))
    child.on('close', (code, sig) => finish({ code: code ?? -1, signal: sig }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * git in `cwd`, resolving to its output or null when it fails. `env` is the environment it runs with,
 * KzH's own when it is not given; the capability benchmark gives one that names its task's
 * repository, kept outside the folder an agent writes to, and holds no key of KzH's
 * (docs/benchmark.md 3.7).
 *
 * Always with GIT_OPTIONAL_LOCKS=0: `git status` otherwise refreshes the index and takes
 * .git/index.lock to write it back, and an agent's own `git add` or `git commit` in the same folder
 * at that moment fails on the lock. KzH only reads here, so it never needs to write the index.
 * `git diff` still rewrites it whatever the variable says (git 2.43), so every diff here also sets
 * diff.autoRefreshIndex=false (DIFF_NO_REFRESH), and a read pass, which runs beside a task
 * changing the folder, runs no diff at all (router.js). `input` is written to its standard input.
 */
const git = (cwd, args, signal, env, input) => new Promise((resolve) => {
  // A start that fails at once (a command line past the system's limit throws here on some
  // systems) is a failed call like any other, never an exception out of a snapshot.
  try {
    const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal, env: { ...(env ?? process.env), GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => resolve(err ? null : stdout))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  } catch { resolve(null) }
})

// `git diff` refreshes a stat-dirty index and writes it back under .git/index.lock whatever
// GIT_OPTIONAL_LOCKS says; with this it leaves the index alone (git 2.31 or later reads it).
const DIFF_NO_REFRESH = ['-c', 'diff.autoRefreshIndex=false']

const tail = (text, max) => (text.length <= max ? text : `...[${text.length - max} chars omitted]\n${text.slice(-max)}`)

export async function assertWorkspace(cwd) {
  const s = await stat(cwd).catch(() => null)
  if (!s?.isDirectory()) throw new Error(`workspace missing or not a directory: ${cwd}`)
}

async function readPackageJson(cwd) {
  try { return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) } catch { return undefined }
}

/** Porcelain v2 entries: how many space-separated fields come before the path, by entry kind. */
const FIELDS_BEFORE_PATH = { 1: 8, 2: 9, u: 10 }

/**
 * `git status` as Map<path, code>, or null outside a git repo. Paths are from the repository's top
 * folder, whatever folder it runs in. The code is the entry's XY letters ('??' for an untracked
 * path), and for a submodule its S field as well (S<commit><modified><untracked>), so a submodule
 * whose inside changes shows as a changed status. Porcelain v2 keeps a rename's source in a field
 * of its own and marks a submodule, which v1 left to guessing from the letters.
 */
async function statusMap(cwd, signal, env) {
  const out = await git(cwd, ['status', '--porcelain=v2', '-uall', '-z'], signal, env)
  if (out === null) return null
  const map = new Map()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    let path
    let code
    if (entry.startsWith('? ')) { path = entry.slice(2); code = '??' } else if (FIELDS_BEFORE_PATH[entry[0]] && entry[1] === ' ') {
      const fields = entry.split(' ')
      path = fields.slice(FIELDS_BEFORE_PATH[entry[0]]).join(' ')
      code = fields[1] + (fields[2]?.startsWith('S') ? ` ${fields[2]}` : '')
      if (entry[0] === '2') i++ // a rename or copy: its source follows
    } else continue
    // The harness's own notes (.kz-harness/, in the workspace, which may be a folder below the
    // repository's top) are never an agent's change.
    if (path && !`/${path}`.includes('/.kz-harness/')) map.set(path, code)
  }
  return map
}

/** Keep `.kz-harness/` out of git locally via <git dir>/info/exclude. No-op outside git. `env` as for every git call here. */
export async function ensureHandoffIgnored(cwd, { env } = {}) {
  const rel = (await git(cwd, ['rev-parse', '--git-path', 'info/exclude'], undefined, env))?.trim()
  if (!rel) return
  const file = resolve(cwd, rel)
  const text = await readFile(file, 'utf8').catch(() => '')
  if (text.split(/\r?\n/).some((l) => l.trim() === '.kz-harness/')) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}.kz-harness/\n`)
}

/** The content of a path that is not there: deleted, in the index or the working tree. */
export const ABSENT = 'absent'
/** How many single-file git calls run at once when the one-process read of every file fails. */
const HASH_POOL = 4

/**
 * What each path `git status` named holds now: a file's git hash, ABSENT when nothing is there,
 * `link:<target>` for a symbolic link, or null for a folder git lists as one entry (a nested
 * repository, a submodule), whose inside no hash shows. What a path is comes from the file system,
 * not from the status letters, which say nothing certain about the working tree in a conflict or
 * after a rename. The paths are from the repository's top whatever folder the workspace is, and
 * the file system reads them from that top as git names it (`--show-toplevel`, the real folder,
 * even when the workspace is reached through a link, a junction or a subst drive, where a path
 * built up from the workspace's own spelling misses). `hash-object --stdin-paths` reads its input
 * from the top too, so the paths go there as they are, and a file hashed alone is hashed there. Every file is hashed by that one process, so no command line grows
 * with the number of changed files. When it fails because a file went away meanwhile, it runs once
 * more without the files now gone; only then are files hashed one each, a few at a time. A stop
 * ends the reading at once, the files not yet hashed null.
 */
async function hashes(cwd, paths, signal, env) {
  const out = new Map()
  if (paths.length === 0) return out
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'], signal, env))?.trim()
  if (!top) { for (const p of paths) out.set(p, null); return out }
  const at = (p) => join(top, p)
  const kinds = await Promise.all(paths.map((p) => lstat(at(p)).then((s) => s, () => null)))
  const files = []
  for (const [i, p] of paths.entries()) {
    const k = kinds[i]
    if (!k) out.set(p, ABSENT)
    else if (k.isSymbolicLink()) out.set(p, `link:${await readlink(at(p)).catch(() => '')}`)
    else if (k.isFile()) files.push(p)
    else out.set(p, null)
  }
  const inOne = async (list) => {
    if (!list.length) return true
    const all = await git(cwd, ['hash-object', '--stdin-paths'], signal, env, `${list.join('\n')}\n`)
    const lines = all?.trim().split(/\r?\n/) ?? []
    if (all === null || lines.length !== list.length) return false
    list.forEach((p, i) => out.set(p, lines[i]))
    return true
  }
  if (await inOne(files)) return out
  if (signal?.aborted) { for (const p of files) out.set(p, null); return out }
  const stillThere = await Promise.all(files.map((p) => lstat(at(p)).then((k) => k.isFile(), () => false)))
  files.forEach((p, i) => { if (!stillThere[i]) out.set(p, ABSENT) })
  const rest = files.filter((_p, i) => stillThere[i])
  if (await inOne(rest)) return out
  for (let i = 0; i < rest.length; i += HASH_POOL) {
    if (signal?.aborted) { for (const p of rest.slice(i)) out.set(p, null); break }
    const batch = rest.slice(i, i + HASH_POOL)
    const each = await Promise.all(batch.map((p) => git(top, ['hash-object', '--', p], signal, env)))
    const gone = await Promise.all(batch.map((p, j) => (each[j]?.trim() ? false : lstat(at(p)).then(() => false, () => true))))
    batch.forEach((p, j) => out.set(p, each[j]?.trim() || (gone[j] ? ABSENT : null)))
  }
  return out
}

/** A path as the file system really has it (links, junctions and subst drives resolved), or as given. */
const real = (p) => realpath(p).catch(() => p)
/** Whether `p` is `dir` or inside it; without regard to case on Windows, whose file system has none. */
const inside = (p, dir) => {
  const [x, d] = process.platform === 'win32' ? [p.toLowerCase(), dir.toLowerCase()] : [p, dir]
  return x === d || x.startsWith(d.endsWith(sep) ? d : `${d}${sep}`)
}
/** `p` below `dir`, with forward slashes, as git names paths. */
const below = (dir, p) => relative(dir, p).split(sep).join('/')

/**
 * .git/config and every file in the hooks folder, by content: git's own files that `git status`
 * never lists, and where a write that got past a lock would run code later (a hook runs at the next
 * commit). By content, since git rewrites the config file to set a value it already holds. Each is
 * named where it really is: `.git/hooks/pre-commit` in the git folder, `.husky/_/pre-commit` for a
 * hooks folder in the working tree. A hooks folder outside the repository (a core.hooksPath shared
 * by every repository on the PC) is left out: a run in any other repository may write there. The
 * folders are compared as the file system really has them, so a workspace reached through a link
 * or spelled in another case on Windows reads the same files. Only a read pass's lock check
 * compares them (snapshotDiff). Linked worktrees share these files, so runs in them count as
 * related (commonGitDir).
 */
async function gitMeta(cwd, signal, env) {
  const paths = (await git(cwd, ['rev-parse', '--git-path', 'config', '--git-path', 'hooks', '--git-common-dir', '--show-toplevel'], signal, env))?.trim().split(/\r?\n/)
  if (!paths || paths.length !== 4) return null
  // git's relative paths count from the real folder it runs in, not from a link's spelling of it.
  const base = await real(cwd)
  const [config, hooks, common, top] = await Promise.all(paths.map((p) => real(resolve(base, p))))
  const mark = async (file) => { const b = await readFile(file).catch(() => null); return b ? createHash('sha1').update(b).digest('hex') : ABSENT }
  const meta = new Map([[`.git/${below(common, config)}`, await mark(config)]])
  const where = inside(hooks, common) ? `.git/${below(common, hooks)}` : inside(hooks, top) ? below(top, hooks) : null
  if (where !== null) {
    for (const name of (await readdir(hooks).catch(() => [])).sort()) meta.set(`${where}/${name}`, await mark(join(hooks, name)))
  }
  return meta
}

/**
 * The git folder a repository's linked worktrees share (`--git-common-dir`), as the file system
 * really has it, or null outside git. Two worktrees of one repository are separate folders with one
 * .git/config and one set of hooks; the main one names the folder from its own spelling, a linked
 * one from the real path, so both are resolved before they are compared.
 */
export async function commonGitDir(cwd, signal, { env } = {}) {
  const dir = (await git(cwd, ['rev-parse', '--git-common-dir'], signal, env))?.trim()
  return dir ? real(resolve(await real(cwd), dir)) : null
}

/**
 * Snapshot to diff against after an agent runs. `env` as for every git call here. `meta` adds
 * gitMeta, for a read pass's lock check.
 */
export async function snapshot(cwd, signal, { env, meta = false } = {}) {
  const status = await statusMap(cwd, signal, env)
  if (status === null) return { git: false }
  return { git: true, status, hashes: await hashes(cwd, [...status.keys()], signal, env), ...(meta ? { meta: await gitMeta(cwd, signal, env) } : {}) }
}

/**
 * The changed paths whose content a snapshot comparison cannot see: in both snapshots with the same
 * status, but a folder git lists as one entry (a nested repository, a submodule) in either, whose
 * content is null. A change inside one of them shows in neither snapshot.
 */
export function unseenPaths(before, after) {
  if (!before?.git || !after?.git) return []
  return [...after.status.keys()].filter((p) => before.status.get(p) === after.status.get(p)
    && (after.hashes.get(p) === null || before.hashes.get(p) === null))
}

/**
 * The files whose status or content differs between two snapshots, or null when either is not a
 * git snapshot. Pure: it runs no git, and in particular no `git diff`, which rewrites the index
 * whatever GIT_OPTIONAL_LOCKS says; a read-only run's lock check compares two snapshots with it.
 */
export function snapshotDiff(before, after) {
  if (!before?.git || !after?.git) return null
  const files = [...new Set([...after.status.keys(), ...before.status.keys()])].filter((p) =>
    after.status.get(p) !== before.status.get(p) || after.hashes.get(p) !== before.hashes.get(p))
  // git's own files, when both snapshots read them (a read pass's lock check).
  if (before.meta && after.meta) {
    // A hooks folder in the working tree that git also tracks is named the same both ways: once.
    for (const k of new Set([...before.meta.keys(), ...after.meta.keys()])) if ((before.meta.get(k) ?? ABSENT) !== (after.meta.get(k) ?? ABSENT) && !files.includes(k)) files.push(k)
  }
  return files
}

/** The top folder of the git repository `cwd` is in, or null outside one. `env` as for every git call here. */
export async function repoRoot(cwd, signal, { env } = {}) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'], signal, env))?.trim() || null
}

/**
 * The top folder of the outermost repository `cwd` is in: a submodule's superproject, and its own
 * superproject in turn, since the superproject's `git status` shows a submodule that changed.
 * Null outside git. `env` as for every git call here.
 */
export async function outerRepoRoot(cwd, signal, { env } = {}) {
  let root = await repoRoot(cwd, signal, { env })
  // Bounded, so a repository that names itself as its superproject cannot loop.
  for (let depth = 0; root && depth < 16; depth++) {
    const up = (await git(root, ['rev-parse', '--show-superproject-working-tree'], signal, env))?.trim()
    if (!up || up === root) break
    root = up
  }
  return root
}

/** The commit HEAD names, or null outside git or on an unborn branch. `env` as for every git call here. */
export async function headOf(cwd, signal, { env } = {}) {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, env))?.trim() || null
}

/** How many characters of pathspecs one git command line takes, well under Windows' 32,767. */
const SPEC_BUDGET = 8000

/**
 * `git diff HEAD` over these paths, from the repository's top (`:(top,literal)`, since the paths
 * are from there and a workspace can be a folder below it), in as many calls as keep each command
 * line short, their outputs joined. Null when a call fails.
 */
async function diffOf(cwd, paths, extra, signal, env) {
  const outs = []
  for (let i = 0; i < paths.length;) {
    const specs = []
    let size = 0
    for (; i < paths.length && (!specs.length || size + paths[i].length < SPEC_BUDGET); i++) { specs.push(`:(top,literal)${paths[i]}`); size += paths[i].length + 16 }
    const out = await git(cwd, [...DIFF_NO_REFRESH, 'diff', 'HEAD', ...extra, '--', ...specs], signal, env)
    if (out === null) return null
    outs.push(out.trim())
  }
  return outs.filter(Boolean).join('\n')
}

/** Files whose status or content changed since `before`. `env` as for every git call here. */
export async function changedSince(cwd, before, signal, { env } = {}) {
  if (!before.git) return { files: null, stat: 'not a git repository', patch: '' }
  const status = await statusMap(cwd, signal, env)
  // git can fail mid-run (index.lock held by an agent, abort); report it instead of crashing the route.
  if (status === null) return { files: null, stat: 'git status failed; changes unknown', patch: '' }
  const after = { git: true, status, hashes: await hashes(cwd, [...status.keys()], signal, env) }
  const files = snapshotDiff(before, after)
  if (!files.length) return { files, stat: '', patch: '' }
  // Untracked files have no diff against HEAD; they are named below.
  const tracked = files.filter((p) => status.get(p) !== '??')
  const stat = tracked.length ? await diffOf(cwd, tracked, ['--stat'], signal, env) : ''
  const patch = tracked.length ? await diffOf(cwd, tracked, [], signal, env) : ''
  const untracked = files.filter((p) => status.get(p) === '??')
  return {
    files,
    // A diff git could not give is said so, never left empty: an empty stat reads as no change.
    stat: (stat ?? `git diff failed; ${tracked.length} changed file${tracked.length === 1 ? '' : 's'} whose diff is unknown`) + (untracked.length ? `\nnew untracked: ${untracked.join(', ')}` : ''),
    patch: patch ?? '',
  }
}

/** Lightweight routing context. Never reads source contents. `env` as for every git call here. */
export async function gatherContext(cwd, { productionCritical, signal, env, meta = false }) {
  const pkg = await readPackageJson(cwd)
  const snap = await snapshot(cwd, signal, { env, meta })
  const ctx = { gitRepo: snap.git, productionCritical }
  if (snap.git) {
    ctx.branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal, env))?.trim()
    ctx.uncommittedFiles = [...snap.status.keys()].slice(0, 30)
    ctx.uncommittedFileCount = snap.status.size
    const files = ((await git(cwd, ['ls-files'], signal, env)) ?? '').split(/\r?\n/).filter(Boolean)
    const counts = {}
    for (const f of files) { const e = extname(f) || '(none)'; counts[e] = (counts[e] ?? 0) + 1 }
    ctx.trackedFileCount = files.length
    ctx.fileTypes = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8))
  }
  if (pkg) {
    ctx.scripts = Object.keys(pkg.scripts ?? {})
    ctx.dependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 25)
  }
  return { context: ctx, snapshot: snap }
}

/**
 * Run the configured package.json scripts that exist. Order matters: cheap first. `env` is the
 * environment they run with, KzH's own when it is not given; a caller whose checks run code an
 * agent wrote passes one without KzH's keys (docs/benchmark.md 3.8).
 */
export async function runChecks(cwd, { scripts, timeoutMs, outputChars, signal, env }) {
  const pkg = await readPackageJson(cwd)
  const available = scripts.filter((s) => pkg?.scripts?.[s])
  const results = []
  for (const name of available) {
    const r = await run('npm', ['run', '-s', name], { cwd, shell: process.platform === 'win32', timeoutMs, signal, env })
    // A test or a build prints whatever the run had in its environment, and the review sends the
    // output to Jev. It is scrubbed before the tail is taken: a key the cut starts inside loses the
    // prefix the scrubber knows it by, and the rest of it would go out as ordinary text.
    results.push({ name, passed: r.code === 0, exitCode: r.code, durationMs: r.durationMs, output: tail(redactSecrets(r.output.trim()), outputChars) })
  }
  return results
}

/** Compare checks before and after: which regressed, which got fixed. */
export function compareChecks(before, after) {
  const was = new Map(before.map((c) => [c.name, c.passed]))
  return {
    regressed: after.filter((c) => c.passed === false && was.get(c.name) === true).map((c) => c.name),
    fixed: after.filter((c) => c.passed && was.get(c.name) === false).map((c) => c.name),
    failing: after.filter((c) => !c.passed).map((c) => c.name),
  }
}

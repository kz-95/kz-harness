// Deterministic workspace facts: lightweight routing context, git change
// detection, and project checks. Nothing here asks a model anything.
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
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
 */
const git = (cwd, args, signal, env) => new Promise((resolve) => {
  execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal, ...(env ? { env } : {}) }, (err, stdout) => resolve(err ? null : stdout))
})

const tail = (text, max) => (text.length <= max ? text : `...[${text.length - max} chars omitted]\n${text.slice(-max)}`)

export async function assertWorkspace(cwd) {
  const s = await stat(cwd).catch(() => null)
  if (!s?.isDirectory()) throw new Error(`workspace missing or not a directory: ${cwd}`)
}

async function readPackageJson(cwd) {
  try { return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) } catch { return undefined }
}

/** Porcelain status as Map<path, statusCode>, or null outside a git repo. */
async function statusMap(cwd, signal, env) {
  const out = await git(cwd, ['status', '--porcelain=v1', '-uall', '-z'], signal, env)
  if (out === null) return null
  const map = new Map()
  const parts = out.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2)
    // The harness's own notes (.kz-harness/) are never an agent's change.
    if (!parts[i].slice(3).startsWith('.kz-harness/')) map.set(parts[i].slice(3), code)
    if (code[0] === 'R' || code[0] === 'C') i++ // skip rename source
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

async function hashes(cwd, paths, signal, env) {
  if (paths.length === 0) return new Map()
  const out = await git(cwd, ['hash-object', '--', ...paths], signal, env)
  const lines = out ? out.trim().split(/\r?\n/) : []
  return new Map(paths.map((p, i) => [p, lines[i] ?? null]))
}

/** Snapshot to diff against after an agent runs. `env` as for every git call here. */
export async function snapshot(cwd, signal, { env } = {}) {
  const status = await statusMap(cwd, signal, env)
  if (status === null) return { git: false }
  return { git: true, status, hashes: await hashes(cwd, [...status.keys()].filter((p) => status.get(p) !== ' D'), signal, env) }
}

/** Files whose status or content changed since `before`. `env` as for every git call here. */
export async function changedSince(cwd, before, signal, { env } = {}) {
  if (!before.git) return { files: null, stat: 'not a git repository', patch: '' }
  const after = await statusMap(cwd, signal, env)
  // git can fail mid-run (index.lock held by an agent, abort); report it instead of crashing the route.
  if (after === null) return { files: null, stat: 'git status failed; changes unknown', patch: '' }
  const candidates = [...after.keys()].filter((p) => after.get(p) !== ' D')
  const now = await hashes(cwd, candidates, signal, env)
  const files = [...new Set([...after.keys(), ...before.status.keys()])].filter((p) =>
    after.get(p) !== before.status.get(p) || now.get(p) !== before.hashes.get(p))
  const stat = (await git(cwd, ['diff', 'HEAD', '--stat', '--', ...files], signal, env)) ?? ''
  const patch = files.length ? (await git(cwd, ['diff', 'HEAD', '--', ...files], signal, env)) ?? '' : ''
  const untracked = files.filter((p) => after.get(p) === '??')
  return { files, stat: stat.trim() + (untracked.length ? `\nnew untracked: ${untracked.join(', ')}` : ''), patch }
}

/** Lightweight routing context. Never reads source contents. `env` as for every git call here. */
export async function gatherContext(cwd, { productionCritical, signal, env }) {
  const pkg = await readPackageJson(cwd)
  const snap = await snapshot(cwd, signal, { env })
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

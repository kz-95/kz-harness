// Deterministic workspace facts: lightweight routing context, git change
// detection, and project checks. Nothing here asks a model anything.
import { execFile, spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** Kill a child and everything it started. On Windows a shell child's grandchildren (npm, node) survive a plain kill. */
export function killTree(child) {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  else child.kill('SIGKILL')
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
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve({ ...r, output: out, durationMs: Date.now() - started })
    }
    const stop = () => { killTree(child); setTimeout(() => finish({ code: -1, signal: 'killed' }), 2000) }
    const timer = setTimeout(stop, timeoutMs)
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

const git = (cwd, args, signal) => new Promise((resolve) => {
  execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal }, (err, stdout) => resolve(err ? null : stdout))
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
async function statusMap(cwd, signal) {
  const out = await git(cwd, ['status', '--porcelain=v1', '-uall', '-z'], signal)
  if (out === null) return null
  const map = new Map()
  const parts = out.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2)
    map.set(parts[i].slice(3), code)
    if (code[0] === 'R' || code[0] === 'C') i++ // skip rename source
  }
  return map
}

async function hashes(cwd, paths, signal) {
  if (paths.length === 0) return new Map()
  const out = await git(cwd, ['hash-object', '--', ...paths], signal)
  const lines = out ? out.trim().split(/\r?\n/) : []
  return new Map(paths.map((p, i) => [p, lines[i] ?? null]))
}

/** Snapshot to diff against after an agent runs. */
export async function snapshot(cwd, signal) {
  const status = await statusMap(cwd, signal)
  if (status === null) return { git: false }
  return { git: true, status, hashes: await hashes(cwd, [...status.keys()].filter((p) => status.get(p) !== ' D'), signal) }
}

/** Files whose status or content changed since `before`. */
export async function changedSince(cwd, before, signal) {
  if (!before.git) return { files: null, stat: 'not a git repository', patch: '' }
  const after = await statusMap(cwd, signal)
  // git can fail mid-run (index.lock held by an agent, abort); report it instead of crashing the route.
  if (after === null) return { files: null, stat: 'git status failed; changes unknown', patch: '' }
  const candidates = [...after.keys()].filter((p) => after.get(p) !== ' D')
  const now = await hashes(cwd, candidates, signal)
  const files = [...new Set([...after.keys(), ...before.status.keys()])].filter((p) =>
    after.get(p) !== before.status.get(p) || now.get(p) !== before.hashes.get(p))
  const stat = (await git(cwd, ['diff', 'HEAD', '--stat', '--', ...files], signal)) ?? ''
  const patch = files.length ? (await git(cwd, ['diff', 'HEAD', '--', ...files], signal)) ?? '' : ''
  const untracked = files.filter((p) => after.get(p) === '??')
  return { files, stat: stat.trim() + (untracked.length ? `\nnew untracked: ${untracked.join(', ')}` : ''), patch }
}

/** Lightweight routing context. Never reads source contents. */
export async function gatherContext(cwd, { productionCritical, signal }) {
  const pkg = await readPackageJson(cwd)
  const snap = await snapshot(cwd, signal)
  const ctx = { gitRepo: snap.git, productionCritical }
  if (snap.git) {
    ctx.branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal))?.trim()
    ctx.uncommittedFiles = [...snap.status.keys()].slice(0, 30)
    ctx.uncommittedFileCount = snap.status.size
    const files = ((await git(cwd, ['ls-files'], signal)) ?? '').split(/\r?\n/).filter(Boolean)
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

/** Run the configured package.json scripts that exist. Order matters: cheap first. */
export async function runChecks(cwd, { scripts, timeoutMs, outputChars, signal }) {
  const pkg = await readPackageJson(cwd)
  const available = scripts.filter((s) => pkg?.scripts?.[s])
  const results = []
  for (const name of available) {
    const r = await run('npm', ['run', '-s', name], { cwd, shell: process.platform === 'win32', timeoutMs, signal })
    results.push({ name, passed: r.code === 0, exitCode: r.code, durationMs: r.durationMs, output: tail(r.output.trim(), outputChars) })
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

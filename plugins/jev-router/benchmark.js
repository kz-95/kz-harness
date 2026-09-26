// The capability benchmark (docs/benchmark.md section 3): a fixed set of small Node.js tasks, run on
// each agent the person picks through the normal run path with that agent forced, graded by checks
// the agent never sees, and written as `benchmark` evidence (profiles.js benchmarkEvidence).
//
// What lives here: the task set (loading, validating, its digest), whether a task fits an agent's
// window, the task folder (made, listed, graded, deleted), the estimate of what a run will spend,
// the confirmation and the plan id it is held to, and the runner with its one queue, its reruns
// and stops and benchmark.jsonl. index.js gives the runner one function that runs one task through
// runRouted(); nothing here starts an agent itself.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchmarkEvidence, evidenceWeight, priorFor, subjectKey, subjectOfAttempt } from './profiles.js'
import { TASK_DIMENSIONS } from './routing-policy.js'
import { run } from './workspace.js'

// ---------- the task set (3.2 to 3.5) ----------

/** The task set shipped with the plugin. */
export const TASKS_DIR = fileURLToPath(new URL('./benchmark-tasks/', import.meta.url))
/** The task that runs first on every agent, is never scored, and stops an agent that fails it. */
export const PREFLIGHT = 'preflight'
/** The skills, in the order an agent's queue runs them: nine of the router's task types. */
export const SKILLS = Object.freeze(['implementation', 'debugging', 'refactor', 'testing', 'review', 'security', 'performance', 'simple_change', 'investigation'])
/**
 * The dimensions a skill's tasks may credit: the router's TASK_DIMENSIONS for the type without
 * first_pass_quality and reliability, which are rules about runs, and narrowed where the grading
 * cannot see a dimension (3.2).
 */
export const CREDITED = Object.freeze({
  implementation: ['coding', 'instruction_following'],
  debugging: ['debugging', 'coding', 'general_reasoning'],
  refactor: ['coding'],
  testing: ['testing', 'coding'],
  review: ['code_review'],
  security: ['security_review', 'code_review'],
  performance: ['debugging', 'general_reasoning'],
  simple_change: ['instruction_following'],
  investigation: ['general_reasoning'],
})
/** The most a task of each level may hold: its prompt and every file of its workspace, in tokens. */
export const LEVEL_TOKENS = Object.freeze({ 1: 1500, 2: 3000, 3: 6000 })
/** Characters per token, as capabilities.js counts them. */
export const CHARS_PER_TOKEN = 4
/** What an agent's first call carries before any task: its system prompt and tool list (local.js). */
export const AGENT_PROMPT_TOKENS = 8600
/** What an agent's tools print while it works on a task, kept free in its window. */
export const TOOL_OUTPUT_TOKENS = 2000
/** Words a prompt never uses: a model told it is being measured may work differently (3.3). */
const TELLTALE = /benchmark|\bgraded\b|\bhidden\b|\bevaluation\b|test harness/i
const GRADE_KINDS = ['tests', 'mutants', 'findings', 'answer']

/** Every file under `dir`, as paths from it with forward slashes, sorted by UTF-16 code unit. */
export function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** A file's text with CRLF read as LF, so a Windows checkout reads as any other. */
const textOf = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/**
 * The SHA-256 of the task set: for every file under `dir` but task-set.json, in the order of their
 * paths sorted by UTF-16 code unit, its path from `dir` with forward slashes, a NUL, its content
 * with CRLF read as LF, and a NUL that ends it (3.5). The same on every checkout.
 */
export function taskSetDigest(dir = TASKS_DIR) {
  const h = createHash('sha256')
  for (const path of listFiles(dir)) {
    if (path === 'task-set.json') continue
    h.update(path).update('\0').update(textOf(join(dir, path))).update('\0')
  }
  return h.digest('hex')
}

/** The files under `dir` as `{ path, text }`, CRLF read as LF, or none when there is no such folder. */
const filesUnder = (dir) => (existsSync(dir) ? listFiles(dir).map((path) => ({ path, text: textOf(join(dir, path)) })) : [])
/** The folders directly under `dir`, sorted. */
const foldersUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [])

/** A task's size in tokens: its prompt and every file of its workspace, at four characters a token. */
export const taskTokens = (prompt, files) => Math.ceil((prompt.length + files.reduce((n, f) => n + f.text.length, 0)) / CHARS_PER_TOKEN)

/**
 * Whether a task of `tokens` fits an agent whose window is `window` tokens (3.3): the window, less
 * what an agent's first call carries, the task itself and what its tools print, must not fall
 * below 0. A window of null (a cloud agent) fits every task.
 */
export const fitsWindow = (tokens, window) => window == null || window - AGENT_PROMPT_TOKENS - tokens - TOOL_OUTPUT_TOKENS >= 0

function loadTask(dir, id) {
  const taskDir = join(dir, id)
  const spec = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'))
  const files = filesUnder(join(taskDir, 'workspace'))
  const overlays = (sub) => foldersUnder(join(taskDir, sub)).map((name) => ({ name, files: filesUnder(join(taskDir, sub, name)) }))
  return {
    ...spec,
    dir: taskDir,
    files,
    tokens: taskTokens(String(spec.prompt ?? ''), files),
    solutions: overlays('solutions'),
    mutants: overlays('mutants'),
    equivalent: filesUnder(join(taskDir, 'equivalent')),
  }
}

/** Whether `path` names a file of the workspace, or a folder holding one (`test/` or `test`). */
const inWorkspace = (task, path) => {
  const p = String(path).replace(/\/+$/, '')
  return task.files.some((f) => f.path === p || f.path.startsWith(`${p}/`))
}

/** The problems of one task, each a sentence naming the task; none when it is sound. */
export function taskProblems(task) {
  const out = []
  const say = (text) => out.push(`${task.id}: ${text}`)
  const preflight = task.id === PREFLIGHT
  if (preflight ? task.skill !== null : !SKILLS.includes(task.skill) || !TASK_DIMENSIONS[task.skill]) say(`skill ${task.skill} is not one of ${SKILLS.join(', ')}`)
  if (![1, 2, 3].includes(task.level)) say('level must be 1, 2 or 3')
  if (!Array.isArray(task.dimensions)) say('dimensions must be a list')
  else if (preflight ? task.dimensions.length : !task.dimensions.length || task.dimensions.some((d) => !CREDITED[task.skill]?.includes(d))) say(`dimensions must be a non-empty subset of ${CREDITED[task.skill]?.join(', ') ?? 'nothing'}`)
  if (!/^[a-z][a-z0-9-]*$/.test(task.folder ?? '')) say('folder must be a lower-case name')
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) say('prompt must be text')
  else if (TELLTALE.test(task.prompt)) say(`the prompt says ${TELLTALE.exec(task.prompt)[0]}`)
  if (task.tokens > (LEVEL_TOKENS[task.level] ?? 0)) say(`${task.tokens} tokens, over the ${LEVEL_TOKENS[task.level]} of level ${task.level}`)
  let pkg = null
  try { pkg = JSON.parse(task.files.find((f) => f.path === 'package.json')?.text ?? 'null') } catch { /* said below */ }
  if (!pkg) say('its workspace has no package.json')
  else {
    if (pkg.name !== task.folder) say(`package.json names ${pkg.name}, not ${task.folder}`)
    if (pkg.type !== 'module' || pkg.scripts?.test !== 'node --test') say('package.json must be "type": "module" with "test": "node --test"')
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) say('a task installs nothing: package.json lists dependencies')
  }
  for (const key of ['protect', 'onlyChanged']) {
    const list = task[key]
    if (list === null && key === 'onlyChanged') continue
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) say(`${key} must be a list of paths from the folder`)
  }
  for (const p of task.protect ?? []) if (!inWorkspace(task, p)) say(`protected ${p} is not in its workspace`)
  for (const f of listFiles(task.dir)) if (f.split('/').some((part) => part.startsWith('.'))) say(`${f} starts with a dot, which the repository's .gitignore drops`)
  const g = task.grade ?? {}
  if (!GRADE_KINDS.includes(g.kind)) say(`grade.kind must be one of ${GRADE_KINDS.join(', ')}`)
  if (g.kind === 'tests') {
    const entries = Object.entries(g.tests ?? {})
    if (!entries.length) say('grade.tests must name a grade file and its number of tests')
    for (const [file, n] of entries) {
      if (!file.startsWith('grade/') || !existsSync(join(task.dir, file))) say(`grade file ${file} is not in grade/`)
      if (!Number.isInteger(n) || n < 1) say(`grade file ${file} needs its number of tests`)
    }
  }
  if (g.kind === 'mutants') {
    if (!task.files.some((f) => f.path === g.file)) say(`grade.file ${g.file} is not in its workspace`)
    if (!task.mutants.length || task.mutants.some((m) => !m.files.some((f) => f.path === g.file))) say(`every mutant must replace ${g.file}`)
    if (!task.equivalent.some((f) => f.path === g.file)) say(`equivalent/ must hold ${g.file}`)
  }
  if (g.kind === 'findings') {
    const defects = Array.isArray(g.defects) ? g.defects : []
    if (!defects.length) say('grade.defects must list the planted defects')
    for (const d of defects) {
      const file = task.files.find((f) => f.path === d.file)
      const lines = file ? file.text.split('\n').length : 0
      if (!file || !(Number.isInteger(d.from) && Number.isInteger(d.to) && d.from >= 1 && d.from <= d.to && d.to <= lines)) say(`defect ${JSON.stringify(d)} names no lines of its workspace`)
    }
    if (!(Number.isInteger(g.minFound) && g.minFound >= 1 && g.minFound <= defects.length)) say('grade.minFound must be between 1 and the number of defects')
    if (!(Number.isInteger(g.maxExtra) && g.maxExtra >= 0)) say('grade.maxExtra must be a whole number')
  }
  if (g.kind === 'answer' && (!g.expect || typeof g.expect !== 'object')) say('grade.expect must be the answer')
  // The preflight's answer is what node --version prints where it runs, so it keeps none on file.
  if (!preflight && !task.solutions.length) say('it has no reference solution')
  return out
}

/**
 * The task set in `dir` (3.5): its id, version and digest as task-set.json records them, whether
 * the files still hash to that digest, and the tasks, the preflight first. Throws naming every
 * problem of a task that is not sound, or a set without the preflight.
 */
export function loadTaskSet(dir = TASKS_DIR) {
  const set = JSON.parse(readFileSync(join(dir, 'task-set.json'), 'utf8'))
  if (!set || typeof set.id !== 'string' || typeof set.version !== 'string' || !Array.isArray(set.tasks)) throw new Error('task-set.json must hold id, version (text) and the list of tasks')
  const tasks = set.tasks.map((id) => loadTask(dir, id))
  const problems = tasks.flatMap(taskProblems)
  if (tasks[0]?.id !== PREFLIGHT) problems.push(`the first task must be ${PREFLIGHT}`)
  const ids = new Set()
  const folders = new Set()
  for (const t of tasks) {
    if (ids.has(t.id)) problems.push(`${t.id} is listed twice`)
    if (folders.has(t.folder)) problems.push(`${t.id}: folder ${t.folder} is another task's`)
    ids.add(t.id)
    folders.add(t.folder)
  }
  if (problems.length) throw new Error(`The benchmark's task set is not sound: ${problems.join('; ')}`)
  const digest = taskSetDigest(dir)
  return { id: set.id, version: set.version, digest: set.digest, digestOk: digest === set.digest, actualDigest: digest, dir, tasks, preflight: tasks[0], scored: tasks.slice(1) }
}

/** Write `files` into `dest`, each with LF line ends: what the suite graded is what the agent gets. */
export async function writeFiles(files, dest) {
  for (const f of files) {
    const to = join(dest, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, f.text)
  }
}

// ---------- environments (3.6, 3.8) ----------

/**
 * The environment a grade runs the agent's code with: the five variables it needs and nothing else,
 * so no key of KzH's is within reach of what the agent wrote.
 */
export function gradeEnv(workspace, env = process.env) {
  const out = {}
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (env[name] !== undefined) out[name] = env[name]
  out.BENCH_WORKSPACE = workspace
  return out
}

/** A name the engine keeps from its agents' processes: every one holding KEY, PASSWORD, SECRET or TOKEN, and every DSH_ one. */
export const secretName = (name) => /KEY|PASSWORD|SECRET|TOKEN/i.test(name) || /^DSH_/i.test(name)

/**
 * The environment the engine starts its agents' processes from (the scrubbed environment of
 * @deepseek-ai/dsh-subprocess): KzH's, less every name holding KEY, PASSWORD, SECRET or TOKEN and
 * every DSH_ name. The benchmark's checks run the agent's code with it.
 */
export const agentEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([name]) => !secretName(name)))

// ---------- the task folder (3.7) ----------

/**
 * The environment every git call of the benchmark runs with (3.7): the agents' scrubbed one
 * (agentEnv), so no key of KzH's is within reach of anything git starts, less every GIT_ name of the
 * caller's, with core.fsmonitor off. For a task folder, `gitDir` names its repository and `workTree`
 * the folder: the repository is kept outside the scratch root, in a folder of KzH's own, so nothing
 * an agent writes into its folder, a .git/config or a .git/info/attributes that names a filter to
 * run, can configure the git KzH runs there; git never reads a .git inside the work tree it is given.
 */
export function gitEnv({ gitDir = null, workTree = null } = {}, env = process.env) {
  const out = Object.fromEntries(Object.entries(agentEnv(env)).filter(([k]) => !/^GIT_/i.test(k)))
  Object.assign(out, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' })
  if (gitDir) Object.assign(out, { GIT_DIR: gitDir, GIT_WORK_TREE: workTree })
  return out
}

/** git in `cwd` with the environment `env` (gitEnv), resolving to { code, stdout, stderr }. */
function git(cwd, args, env = gitEnv()) {
  return new Promise((done) => {
    execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') }))
  })
}
async function gitOk(cwd, args, env) {
  const r = await git(cwd, args, env)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`}`)
  return r.stdout
}
// Run without the person's hooks or signing, which a commit here has no business with.
const LOCAL_GIT = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']

/** The git repository `dir` is inside, from the nearest folder that exists, or null when there is none. */
export async function gitTopOf(dir) {
  let at = resolve(dir)
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at)
  const r = await git(at, ['rev-parse', '--show-toplevel'])
  return r.code === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : null
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
/** The files of the workspace a task protects, as they are at the start, by path. */
const protectedFiles = (task) => task.files.filter((f) => (task.protect ?? []).some((p) => f.path === p.replace(/\/+$/, '') || f.path.startsWith(`${p.replace(/\/+$/, '')}/`)))

/**
 * A new task folder under `root` (3.7): named with 12 random hex characters, holding the task's
 * workspace with LF line ends, and a git repository with core.autocrlf off, a local user and one
 * commit of those files, with .kz-harness/ excluded as the router's handoff note is. The repository
 * is kept in `gitRoot`, a folder of KzH's own outside the scratch root, under the folder's name, and
 * never inside the folder (gitEnv). Resolves to { name, dir, gitDir, git, commit, protectedHashes },
 * where `git` is the environment every git call on the folder runs with.
 */
export async function prepareFolder(task, root, { gitRoot }) {
  await mkdir(root, { recursive: true })
  const name = randomBytes(6).toString('hex')
  const dir = join(root, name)
  const gitDir = join(resolve(gitRoot), name)
  const env = gitEnv({ gitDir, workTree: dir })
  await mkdir(dir)
  try {
    await mkdir(gitDir, { recursive: true })
    await writeFiles(task.files, dir)
    await gitOk(dir, ['init', '-q', '--template='], env)
    await mkdir(join(gitDir, 'info'), { recursive: true })
    await writeFile(join(gitDir, 'info', 'exclude'), '.kz-harness/\n')
    for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'KzH benchmark'], ['user.email', 'benchmark@kzh.invalid'], ['commit.gpgsign', 'false']]) await gitOk(dir, ['config', k, v], env)
    await gitOk(dir, [...LOCAL_GIT, 'add', '-A'], env)
    await gitOk(dir, [...LOCAL_GIT, '-c', `core.hooksPath=${join(gitDir, 'no-hooks')}`, 'commit', '-q', '--no-verify', '-m', 'the task as it starts'], env)
    const commit = (await gitOk(dir, ['rev-parse', 'HEAD'], env)).trim()
    return { name, dir, gitDir, git: env, commit, protectedHashes: Object.fromEntries(protectedFiles(task).map((f) => [f.path, sha256(f.text)])) }
  } catch (err) {
    // A folder that could not be made whole goes at once: no row names it, so no later start would.
    for (const d of [dir, gitDir]) await rm(d, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** How many entries a listing of the scratch root reads at most before it says it stopped. */
export const LIST_CAP = 50_000

/**
 * Every path under `root` but the folder named `skip`, with forward slashes, mapped to what says
 * it changed: 'dir' for a folder, and size and modification time for anything else. Links are not
 * followed. A listing that reached `cap` entries has `truncated` set.
 */
export async function listTree(root, { skip = null, cap = LIST_CAP } = {}) {
  const out = new Map()
  const walk = async (dir, rel) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!rel && e.name === skip) continue
      if (out.size >= cap) { out.truncated = true; return }
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out.set(r, 'dir'); await walk(join(dir, e.name), r); continue }
      const st = await lstat(join(dir, e.name)).catch(() => null)
      out.set(r, st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'gone')
    }
  }
  await walk(root, '')
  return out
}

/**
 * What an agent did outside its folder (3.6): the paths it added, changed or removed under the
 * scratch root, from listings before and after its task, and the reasons each fails the task. A
 * path it added is deleted, so no later agent finds it; the top-most added folder goes whole. When
 * either listing stopped short (`truncated`), nothing can be read from them: a path would look
 * added or removed only because it moved past the cap, so nothing is deleted and no reason given,
 * and the caller says why the task cannot be checked.
 */
export async function outsideChanges(root, before, after, { skip } = {}) {
  if (before.truncated || after.truncated) return { added: [], changed: [], removed: [], reasons: [], truncated: true }
  const added = [...after.keys()].filter((p) => !before.has(p))
  const removed = [...before.keys()].filter((p) => !after.has(p))
  const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p) && after.get(p) !== 'dir')
  const top = added.filter((p) => !added.some((q) => q !== p && p.startsWith(`${q}/`)))
  const base = resolve(root)
  for (const p of top) {
    const target = resolve(base, ...p.split('/'))
    if (target === base || !target.startsWith(base + sep) || p.split('/')[0] === skip) continue
    await rm(target, { recursive: true, force: true }).catch(() => {})
  }
  const reasons = [...added, ...changed, ...removed].sort().map((p) => `wrote outside its folder: ${p}`)
  return { added, changed, removed, reasons, truncated: false }
}

// ---------- grading (3.6) ----------

/** A grade or a check runs for at most this long. */
export const CHECKS_MS = 60_000
/** How long an agent's own tests may run on one copy of its folder. */
const MUTANT_RUN_MS = 60_000

/**
 * The totals and the failing tests of `node --test --test-reporter=tap` output. Each total is the
 * last one printed, which is the runner's own summary; a failing test is a top-level `not ok`, with
 * the first line of its error when it gave one.
 */
export function parseTap(text) {
  const out = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, failed: [] }
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const total = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(lines[i])
    if (total) { out[total[1]] = Number(total[2]); continue }
    const bad = /^not ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(lines[i])
    if (!bad) continue
    let why = null
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]) && !why; j++) {
      const e = /^\s+error: (.*)$/.exec(lines[j])
      if (!e) continue
      const v = e[1].trim()
      why = v === '|-' || v === '|' ? (lines[j + 1] ?? '').trim() : v.replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
    }
    out.failed.push(why ? `${bad[1]} (${why.slice(0, 160)})` : bad[1])
  }
  return out
}

/** node --test over `files` in `cwd`, with the grading environment of `workspace`. */
const nodeTest = (files, { cwd, workspace, timeoutMs }) => run(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd, env: gradeEnv(workspace), timeoutMs })

const secondsText = (ms) => `${Math.round(ms / 100) / 10} seconds`

async function gradeTests(task, dir, { checksMs = CHECKS_MS } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'kzh-grade-'))
  try {
    const entries = Object.entries(task.grade.tests)
    const want = entries.reduce((n, [, k]) => n + k, 0)
    const r = await nodeTest(entries.map(([f]) => join(task.dir, ...f.split('/'))), { cwd, workspace: dir, timeoutMs: checksMs })
    if (r.timedOut) return { passed: false, reason: `the checks did not finish in ${secondsText(checksMs)}`, detail: { kind: 'tests', timedOut: true } }
    const tap = parseTap(r.output)
    const detail = { kind: 'tests', want, pass: tap.pass, fail: tap.fail, cancelled: tap.cancelled, skipped: tap.skipped, todo: tap.todo, failed: tap.failed.slice(0, 10) }
    if (tap.failed.length) return { passed: false, reason: `failed ${tap.failed.length} of ${want} checks: ${tap.failed.slice(0, 10).join('; ')}`, detail }
    if (tap.cancelled || tap.skipped || tap.todo) return { passed: false, reason: `${tap.cancelled + tap.skipped + tap.todo} of ${want} checks were cancelled, skipped or left to do`, detail }
    // The count is what stops code that ends the process early: node:test then reports the file as
    // one passing test and never runs the rest.
    if (r.code !== 0 || tap.pass !== want || tap.fail) return { passed: false, reason: `only ${tap.pass} of ${want} checks ran to a pass${r.code !== 0 ? ` (exit ${r.code})` : ''}`, detail }
    return { passed: true, reason: `passed all ${want} checks`, detail }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/** The folder's files, without git's, npm's or the router's, as `{ path, buffer }`. */
async function folderFiles(dir) {
  const out = []
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (!rel && ['.git', 'node_modules', '.kz-harness'].includes(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(d, e.name), r)
      else if (e.isFile()) out.push({ path: r, buffer: await readFile(join(d, e.name)) })
    }
  }
  await walk(dir, '')
  return out
}

/** Runs `jobs` (functions returning promises), at most `limit` at once, resolving to their results in order. */
async function inTurn(jobs, limit) {
  const out = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]() }
  }))
  return out
}

async function gradeMutants(task, dir, { mutantMs = MUTANT_RUN_MS } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'kzh-mutants-'))
  try {
    const own = await folderFiles(dir)
    // One copy of the folder per run: as the agent left it, with the equivalent version laid over
    // it, and with each mutant laid over it.
    const runs = [['as it is', []], ['equivalent', task.equivalent], ...task.mutants.map((m) => [m.name, m.files])]
    const results = await inTurn(runs.map(([name, overlay], i) => async () => {
      const copy = join(base, String(i))
      for (const f of own) { const to = join(copy, ...f.path.split('/')); await mkdir(dirname(to), { recursive: true }); await writeFile(to, f.buffer) }
      await writeFiles(overlay, copy)
      const r = await nodeTest([], { cwd: copy, workspace: copy, timeoutMs: mutantMs })
      const tap = parseTap(r.output)
      return { name, timedOut: !!r.timedOut, code: r.code, tap }
    }), 4)
    const passes = (x) => !x.timedOut && x.code === 0 && x.tap.pass >= 1 && !x.tap.fail && !x.tap.cancelled
    const [original, equivalent, ...mutants] = results
    const survived = mutants.filter((m) => m.timedOut || m.code === 0).map((m) => m.name)
    const detail = { kind: 'mutants', tests: original.tap.pass, original: passes(original), equivalent: passes(equivalent), killed: mutants.length - survived.length, mutants: mutants.length, survived }
    if (original.timedOut) return { passed: false, reason: `its tests did not finish in ${secondsText(mutantMs)}`, detail }
    if (!passes(original)) return { passed: false, reason: original.tap.pass ? `its tests fail on ${task.grade.file} as it is: ${original.tap.failed.slice(0, 5).join('; ')}` : 'it wrote no test that runs and passes', detail }
    if (!passes(equivalent)) return { passed: false, reason: equivalent.timedOut ? `its tests did not finish in ${secondsText(mutantMs)} on a version of ${task.grade.file} that behaves the same` : `its tests fail on a version of ${task.grade.file} that behaves the same, written differently, so they check how it is written rather than what it does`, detail }
    if (survived.length) return { passed: false, reason: `its tests missed ${survived.length} of ${mutants.length} changes to ${task.grade.file}: ${survived.join(', ')}`, detail }
    return { passed: true, reason: `its tests caught all ${mutants.length} changes to ${task.grade.file}`, detail }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

/** A path as a finding or an answer may write it: backslashes as slashes, no leading ./ */
const normPath = (p) => String(p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')

/** A JSON file the agent was asked to write, as { value }, or { why } it cannot be read. */
async function readAnswerFile(dir, name) {
  let text
  try { text = await readFile(join(dir, name), 'utf8') } catch { return { why: `${name} was not written` } }
  // A byte order mark, which some editors and shells write, is not part of the JSON.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try { return { value: JSON.parse(json) } } catch (err) { return { why: `${name} is not JSON (${err.message})` } }
}

/**
 * How many planted defects the findings match, and how many findings match none (3.6). A finding
 * matches a defect when its path is the defect's and its line lies in the defect's range; each is
 * matched at most once, and the matching is the largest there is (augmenting paths), so neither
 * count depends on the order of the defects or of the findings.
 */
export function matchFindings(defects, findings) {
  const fits = (d, f) => normPath(f.file) === d.file && f.line >= d.from && f.line <= d.to
  const owner = new Array(findings.length).fill(-1)
  const tryDefect = (d, seen) => {
    for (let f = 0; f < findings.length; f++) {
      if (seen.has(f) || !fits(defects[d], findings[f])) continue
      seen.add(f)
      if (owner[f] < 0 || tryDefect(owner[f], seen)) { owner[f] = d; return true }
    }
    return false
  }
  let found = 0
  for (let d = 0; d < defects.length; d++) if (tryDefect(d, new Set())) found++
  return { found, extra: owner.filter((d) => d < 0).length }
}

async function gradeFindings(task, dir) {
  const { value, why } = await readAnswerFile(dir, 'REVIEW.json')
  if (why) return { passed: false, reason: why, detail: { kind: 'findings' } }
  const ok = Array.isArray(value) && value.every((f) => f && typeof f === 'object' && typeof f.file === 'string' && Number.isInteger(f.line))
  if (!ok) return { passed: false, reason: 'REVIEW.json is not a JSON array of objects with a file and a whole-number line', detail: { kind: 'findings' } }
  const g = task.grade
  const { found, extra } = matchFindings(g.defects, value)
  const detail = { kind: 'findings', found, defects: g.defects.length, findings: value.length, extra }
  const summary = `found ${found} of the ${g.defects.length} defects, with ${extra} finding${extra === 1 ? '' : 's'} that match${extra === 1 ? 'es' : ''} none`
  if (found < g.minFound) return { passed: false, reason: `${summary}; it had to find ${g.minFound}`, detail }
  if (extra > g.maxExtra) return { passed: false, reason: `${summary}; at most ${g.maxExtra} may match none`, detail }
  return { passed: true, reason: summary, detail }
}

/** Whether `answer` deep-equals `expect`, strings compared trimmed and paths as for findings. */
export function answerMatches(expect, answer) {
  if (typeof expect === 'string') return typeof answer === 'string' && normPath(answer) === normPath(expect)
  if (Array.isArray(expect)) return Array.isArray(answer) && answer.length === expect.length && expect.every((e, i) => answerMatches(e, answer[i]))
  if (expect && typeof expect === 'object') {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
    const keys = Object.keys(expect)
    return Object.keys(answer).length === keys.length && keys.every((k) => Object.hasOwn(answer, k) && answerMatches(expect[k], answer[k]))
  }
  return Object.is(expect, answer)
}

async function gradeAnswer(task, dir) {
  const { value, why } = await readAnswerFile(dir, 'ANSWER.json')
  if (why) return { passed: false, reason: why, detail: { kind: 'answer' } }
  const answer = JSON.stringify(value).slice(0, 1000)
  if (!answerMatches(task.grade.expect, value)) return { passed: false, reason: `the answer ${answer.slice(0, 200)} is not the right one`, detail: { kind: 'answer', answer } }
  return { passed: true, reason: 'the answer is right', detail: { kind: 'answer', answer } }
}

const GRADERS = { tests: gradeTests, mutants: gradeMutants, findings: gradeFindings, answer: gradeAnswer }

/** The patch a row keeps of what the agent changed, at most this long. */
const PATCH_CHARS = 20_000

/**
 * What the agent changed in the folder `prepared` (prepareFolder) since its commit (3.6): every path
 * it changed, added or removed, with .kz-harness/ left out, and the patch. A package-lock.json and a
 * node_modules/ that npm leaves in a project with no dependencies are not counted as changes, and
 * are named apart.
 */
export async function changesOf({ dir, git: env, commit }) {
  await gitOk(dir, [...LOCAL_GIT, 'add', '-A'], env)
  const raw = (await gitOk(dir, ['diff', '--cached', '--name-status', '--no-renames', '-z', commit], env)).split('\0').filter(Boolean)
  const all = []
  for (let i = 0; i + 1 < raw.length; i += 2) all.push({ status: raw[i], path: raw[i + 1] })
  const npm = (p) => p === 'package-lock.json' || p === 'node_modules' || p.startsWith('node_modules/')
  const patch = (await gitOk(dir, ['diff', '--cached', '--no-renames', commit, '--', ':!node_modules', ':!package-lock.json'], env)).slice(0, PATCH_CHARS)
  return { changed: all.filter((c) => !npm(c.path)), npmLeft: [...new Set(all.filter((c) => npm(c.path)).map((c) => (c.path.startsWith('node_modules') ? 'node_modules/' : c.path)))], patch }
}

/**
 * Grades a task folder once its agent has finished (3.6): what it changed, the files the task
 * protects, the files that alone may change, what it did outside its folder (`outside`, the
 * reasons outsideChanges gave), and the grade of the task's kind. Every check runs, and the task
 * passes only when all of them hold. Resolves to { passed, reason, detail, changed, npmLeft, patch }.
 * `checksMs` and `mutantMs` are the time limits of a grade and of one run of an agent's own tests.
 */
export async function gradeFolder(task, prepared, { outside = [], checksMs = CHECKS_MS, mutantMs = MUTANT_RUN_MS } = {}) {
  const { changed, npmLeft, patch } = await changesOf(prepared)
  const reasons = [...outside]
  for (const [path, hash] of Object.entries(prepared.protectedHashes ?? {})) {
    let now = null
    try { now = sha256(await readFile(join(prepared.dir, ...path.split('/')), 'utf8')) } catch { /* deleted */ }
    if (now !== hash) reasons.push(`changed ${path}, which the task protects`)
  }
  if (Array.isArray(task.onlyChanged)) {
    for (const c of changed) if (!task.onlyChanged.includes(c.path)) reasons.push(`changed ${c.path}; only ${task.onlyChanged.join(', ')} may change`)
  }
  const graded = await GRADERS[task.grade.kind](task, prepared.dir, { checksMs, mutantMs })
  if (!graded.passed) reasons.push(graded.reason)
  return {
    passed: !reasons.length,
    reason: reasons.length ? reasons.join('; ').slice(0, 1000) : graded.reason,
    detail: graded.detail,
    changed: changed.map((c) => c.path),
    npmLeft,
    patch,
  }
}

// ---------- what an attempt came to (3.6) ----------

const TIMEOUT_NAME = 'TimeoutError'

/**
 * What one task's run came to before any grading (3.6): 'graded' when its agent worked and it is
 * for the grade to say, else 'timed_out', 'errored' (an outcome of the machine, run again) or
 * 'not_scored', each with its reason. `run` is what index.js's task runner resolved to: the run's
 * record, the report of each attempt `execute` ran (whether its signal timed out, whether its
 * process failed to close, a local engine's counters before and after), the error the run threw,
 * and who stopped it.
 */
export function attemptOutcome({ record = null, executed = [], error = null, stoppedBy = null } = {}, { timeLimit = 'its time limit' } = {}) {
  if (stoppedBy === 'person') return { outcome: 'not_scored', reason: 'it was stopped from the inspector' }
  if (stoppedBy === 'benchmark') return { outcome: 'not_scored', reason: 'the benchmark was stopped' }
  const attempt = record?.attempts?.find((a) => a.role === 'primary') ?? null
  const report = executed[0] ?? {}
  if (report.timedOut) return { outcome: 'timed_out', reason: `it ran past ${timeLimit}` }
  if (!attempt) {
    const why = String(error?.message ?? error ?? 'the run ended before its agent started').slice(0, 300)
    return executed.length ? { outcome: 'errored', reason: `the run failed after its agent worked (${why})` } : { outcome: 'not_scored', reason: why }
  }
  if (attempt.limitHit) return { outcome: 'not_scored', reason: `it reached its usage limit${attempt.diagnostic ? ` (${String(attempt.diagnostic).slice(0, 200)})` : ''}` }
  if (report.disposeError) return { outcome: 'errored', reason: `its process did not close (${String(report.disposeError).slice(0, 200)})` }
  const e = report.engine
  if (e && (e.after.loads !== e.before.loads || e.after.unloads !== e.before.unloads)) return { outcome: 'errored', reason: 'the engine loaded or unloaded a model while it worked' }
  if (attempt.stopReason === 'error' || attempt.stopReason === 'aborted') return { outcome: 'errored', reason: attempt.diagnostic ? `it ended in an error (${String(attempt.diagnostic).slice(0, 200)})` : `it ended with ${attempt.stopReason}` }
  if (error) return { outcome: 'errored', reason: `the run failed after its agent worked (${String(error.message ?? error).slice(0, 200)})` }
  return { outcome: 'graded' }
}

/** Whether an attempt's signal ended by its own time limit rather than by a stop of the run. */
export const timedOutBy = (attemptSignal, runSignal) => !!attemptSignal?.aborted && attemptSignal.reason?.name === TIMEOUT_NAME && !runSignal?.aborted

// ---------- words ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day as the card writes it: 25 Sep, with its year when it is not this one. */
export function dayText(iso, now = new Date()) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown day'
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`}`
}
/** A length of time in words: 2 h 10 min, 6 min, under a minute. */
export function durationText(ms) {
  if (!(ms >= 0)) return 'an unknown time'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}
/** A time limit in words: 20-minute, or seconds below a minute. */
const limitText = (ms) => (ms >= 60_000 && ms % 60_000 === 0 ? `the ${ms / 60_000}-minute limit` : `its time limit of ${Math.round(ms / 100) / 10} s`)
/** A number of tokens in words, rounded to what it can say. */
export function tokensText(n) {
  if (!(n >= 0)) return 'an unknown number of'
  if (n >= 1_000_000) return `about ${(n / 1_000_000).toFixed(1)} million`
  if (n >= 10_000) return (Math.round(n / 1000) * 1000).toLocaleString('en-US')
  return (Math.round(n / 100) * 100).toLocaleString('en-US')
}
/** A number of tokens an estimate multiplies out, in words that say it is one. */
const aboutTokens = (n) => { const t = tokensText(n); return t.startsWith('about') ? t : `about ${t}` }
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null }
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pctText = (x) => `${Math.round(x)}%`

// ---------- the estimate (3.10) ----------

/** The windows of a subscription's usage in words: Weekly window at 42% now, 5-hour window at 10%. */
function windowsText(windows) {
  const named = (w) => (w.minutes === 10080 || w.name === 'weekly' ? 'weekly window' : w.minutes === 300 || w.name === '5h' ? '5-hour window' : `${w.name} window`)
  const known = (windows ?? []).filter((w) => typeof w.usedPercent === 'number')
  if (!known.length) return 'Its windows are not known right now.'
  const [first, ...rest] = known.map((w, i) => `${i === 0 ? named(w)[0].toUpperCase() + named(w).slice(1) : named(w)} at ${pctText(w.usedPercent)}${i === 0 ? ' now' : ''}`)
  return `${[first, ...rest].join(', ')}.`
}
const weeklyOf = (windows) => (windows ?? []).find((w) => w.minutes === 10080 || w.name === 'weekly') ?? null

/** When a run started at `at` and lasting `ms` would first reach a peak window, or null when it would not. */
export function reachesPeak(peak, at, ms) {
  const days = peak.daysUtc ?? [1, 2, 3, 4, 5]
  const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m }
  const inPeak = (t) => {
    const d = new Date(t)
    const now = d.getUTCHours() * 60 + d.getUTCMinutes()
    return days.includes(d.getUTCDay()) && (peak.windowsUtc ?? []).some((w) => { const a = mins(w.fromUtc); const b = mins(w.toUtc); return a < b ? now >= a && now < b : now >= a || now < b })
  }
  for (let t = at; t <= at + ms; t += 60_000) if (inPeak(t)) return t
  return null
}

/** The peak hours of a provider in words: from 01:00 to 04:00 and from 06:00 to 10:00 UTC on weekdays. */
function peakWindowText(peak) {
  const days = peak.daysUtc ?? [1, 2, 3, 4, 5]
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const on = [1, 2, 3, 4, 5].every((d) => days.includes(d)) && days.length === 5 ? 'on weekdays' : days.length === 7 ? 'every day' : `on ${listWords(days.map((d) => names[d]))}`
  return `${listWords((peak.windowsUtc ?? []).map((w) => `from ${w.fromUtc} to ${w.toUtc}`))} UTC ${on}`
}

/**
 * The estimate of one agent's run (3.10), from what KzH has measured, and never an invented price:
 * its lines, and its warnings, each a sentence. `last` is its last complete benchmark run
 * ({ at, tasks, wallMs, tokens: [per task], usageBefore, usageAfter }) or null; `other` is its
 * completed work attempts in usage.jsonl, benchmark rows left out ({ durations, tokens }).
 */
export function estimateOf({ agent, kind, runs, fit = null, window = null, last = null, other = { durations: [], tokens: [] }, usage = null, quota = null, gateAt = 80, peak = null, rateNow = null, now = Date.now() }) {
  const lines = []
  const warnings = []
  const id = agent.id
  const byLast = last ? `by its last benchmark (${dayText(last.at, now)}, ${plural(last.tasks, 'task')})` : null
  const medianMs = median(other.durations)
  const medianTokens = median(other.tokens)
  const time = last ? last.wallMs : medianMs != null ? medianMs * runs : null
  const timeLine = last
    ? `About ${durationText(last.wallMs)} ${byLast}.`
    : medianMs != null
      ? `How long it takes is not known until it has run once; its runs on your work took a median of ${durationText(medianMs)} each, about ${durationText(medianMs * runs)} for ${runs} tasks, at whatever effort they ran at.`
      : 'How long it takes is not known until it has run once.'
  if (kind === 'local') {
    lines.push(`Free: runs on this PC. ${timeLine}`)
    // A window that cannot hold even the first task runs nothing: the pick says so, and there is no fit to give.
    if (fit && fit.preflight !== false) {
      const left = fit.total - fit.fit
      lines.push(left
        ? `${fit.fit} of ${fit.total} tasks fit this model's window of ${Number(window).toLocaleString('en-US')} tokens beside an agent's system prompt; the other ${left} ${left === 1 ? 'is not run, and records' : 'are not run, and record'} nothing.`
        : `All ${fit.total} tasks fit this model's window of ${Number(window).toLocaleString('en-US')} tokens beside an agent's system prompt.`)
    }
    return { lines, warnings, timeMs: time }
  }
  const tokensLine = medianTokens != null
    ? `its runs on your work used a median of ${tokensText(medianTokens)} tokens each (${plural(other.tokens.length, 'run')})`
    : 'KzH has no record yet of the tokens its runs use'
  // Where the last benchmark left no reading of the spend, its tokens are the measure there is: the
  // median per task of that benchmark first, else that of the agent's other work (3.10).
  const lastTokens = median(last?.tokens ?? [])
  const lastLine = last ? `The last benchmark on ${id} (${dayText(last.at, now)}, ${plural(last.tasks, 'task')})` : null
  const tokensAfterLast = lastTokens != null
    ? `that benchmark used a median of ${tokensText(lastTokens)} tokens per task, ${aboutTokens(lastTokens * runs)} tokens for ${runs} tasks`
    : medianTokens != null
      ? `KzH has no record of the tokens it used; ${tokensLine}, ${aboutTokens(medianTokens * runs)} tokens for ${runs} tasks`
      : 'KzH has no record of the tokens it used, nor of the tokens its other runs use'
  if (kind === 'subscription') {
    lines.push(`${usage?.account?.label ? `Uses your ${usage.account.label} subscription.` : 'Uses your subscription.'} ${windowsText(usage?.windows)}`)
    const before = weeklyOf(last?.usageBefore?.windows)
    const after = weeklyOf(last?.usageAfter?.windows)
    if (last && before && after) lines.push(`${lastLine} moved the weekly window from ${pctText(before.usedPercent)} to ${pctText(after.usedPercent)}; other use of the account in that time is in that figure too.`)
    else if (last) lines.push(`${lastLine} left no reading of the weekly window before and after it, so what ${runs} tasks take of it is not known; ${tokensAfterLast}.`)
    else lines.push(`How much of the window ${runs} tasks take is not known until one benchmark has run; ${tokensLine}.`)
    lines.push(timeLine)
  } else {
    const balance = usage?.balance ? `balance ${usage.balance.amount.toFixed(2)} ${usage.balance.currency}` : 'balance not known right now'
    lines.push(`Paid from ${usage?.account?.label ?? agent.credentialRef ?? 'its API key'}, ${balance}.`)
    const b0 = last?.usageBefore?.balance
    const b1 = last?.usageAfter?.balance
    if (last && b0 && b1 && b0.currency === b1.currency) lines.push(`${lastLine} took the balance from ${b0.amount.toFixed(2)} to ${b1.amount.toFixed(2)} ${b1.currency}: ${(b0.amount - b1.amount).toFixed(2)} ${b1.currency}.`)
    else if (last) lines.push(`${lastLine} ${b0 && b1 ? `read the balance in ${b0.currency} before it and in ${b1.currency} after it` : 'left no reading of the balance before and after it'}, and KzH has no price table for ${id}, so what ${runs} tasks cost is not known; ${tokensAfterLast}.`)
    else lines.push(`KzH has no price table for ${id}, so what ${runs} tasks cost is not known until one benchmark has run; ${tokensLine}${medianTokens != null ? `, ${aboutTokens(medianTokens * runs)} tokens for ${runs} tasks` : ''}.`)
    lines.push(timeLine)
    if (peak?.windowsUtc?.length) {
      if (rateNow) lines.push(`${rateNow[0].toUpperCase()}${rateNow.slice(1)}.`)
      const at = time == null ? null : reachesPeak(peak, now, time)
      const when = time == null ? 'how long the run takes is not known, so it may reach it'
        : at == null ? `at its estimated ${durationText(time)}, a run started now would end before it`
          : at <= now + 60_000 ? 'a run started now would start in it'
            : `at its estimated ${durationText(time)}, a run started now would reach it at ${new Date(at).toISOString().slice(11, 16)} UTC${new Date(at).getUTCDate() === new Date(now).getUTCDate() ? '' : ` on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(at).getUTCDay()]}`}`
      lines.push(`Its peak rate, twice the off-peak price, applies ${peakWindowText(peak)}; ${when}.`)
    }
  }
  if (kind === 'subscription' && typeof quota?.weeklyPercent === 'number' && quota.weeklyPercent >= gateAt) warnings.push(`${id} is past its weekly gate (${pctText(quota.weeklyPercent)}, gate ${gateAt}%): KzH keeps what is left of its window for reviews, and the benchmark would spend it.`)
  if (quota?.state === 'near') warnings.push(`${id} is near its limit (${quota.summary ?? 'near'}); it may stop partway, and then records nothing.`)
  return { lines, warnings, timeMs: time }
}

// ---------- the plan and its confirmation (3.11) ----------

/**
 * A plan's key: a hash of everything the confirmation promises that cannot move by the minute. A
 * start is refused when the plan worked out again has another key than the one it confirmed.
 */
export const planKeyOf = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
/** How long the confirmation of a plan may start a run after /plan gave it. */
export const PLAN_TTL_MS = 30 * 60_000

/** What changed between two plans, in words, for the refusal of a start whose plan moved. */
export function planChanges(was, now) {
  const out = []
  if (JSON.stringify(was.taskSet) !== JSON.stringify(now.taskSet)) out.push('the task set changed')
  if (was.learn !== now.learn) out.push(`learning was switched ${now.learn ? 'on' : 'off'}`)
  if (JSON.stringify(was.leftovers) !== JSON.stringify(now.leftovers)) out.push('the folders to delete changed')
  if (JSON.stringify(was.strays ?? []) !== JSON.stringify(now.strays ?? [])) out.push('what else it would delete changed')
  const ids = (plan) => plan.picks.map((p) => p.id).join(',')
  if (ids(was) !== ids(now)) out.push('the agents picked changed')
  else {
    now.picks.forEach((p, i) => {
      const w = was.picks[i]
      if (w.model !== p.model) out.push(`${p.id}'s model changed from ${w.model ?? 'its default'} to ${p.model ?? 'its default'}`)
      else if (w.subject !== p.subject) out.push(`${p.id} now runs another version`)
      if (w.kind !== p.kind) out.push(`${p.id} is now paid for another way`)
      if (w.state !== p.state) out.push(`${p.id}'s usage went from ${w.state} to ${p.state}`)
      if (w.gated !== p.gated) out.push(`${p.id} is ${p.gated ? 'now' : 'no longer'} past its weekly gate`)
      if (w.window !== p.window) out.push(`${p.id}'s window changed from ${Number(w.window).toLocaleString('en-US')} to ${Number(p.window).toLocaleString('en-US')} tokens`)
    })
  }
  return out.length ? out.join('; ') : 'something the plan covers changed'
}

/**
 * The line of the confirmation that names what a start deletes first (3.7): the task folders an
 * interrupted run left in the scratch root `root`, and `strays`, the entries that appeared at its
 * top after that run's last task began. Null when there is nothing to delete.
 */
function leftoverLine(leftovers, strays, root) {
  const what = (after) => `what appeared in ${root} after ${after}, which its agent may have written outside its folder: ${listWords(strays.map((p) => relative(root, p)))}`
  if (leftovers.length && strays.length) return `It first deletes ${plural(leftovers.length, 'task folder')} an interrupted run left in ${root}, and ${what("that run's last task began")}.`
  if (strays.length) return `It first deletes ${what('the last task of an interrupted run began')}.`
  return leftovers.length ? `It first deletes ${plural(leftovers.length, 'task folder')} an interrupted run left in ${root}.` : null
}

/**
 * The confirmation the card shows before a run (3.11), written here so it says exactly what the
 * start will do: its title, its paragraphs and its button.
 */
export function confirmation({ picks, estimates, runs, timeoutMs, leftovers, strays = [], root, learn }) {
  const n = picks.length
  const counts = new Set(picks.map((p) => runs[p.id]))
  const names = listWords(picks.map((p) => p.id))
  // `runs` counts the preflight, which is never scored: it is named apart from the tasks that are.
  const tasks = `the first, one-file task, which is not scored, and ${counts.size === 1 ? '' : 'up to '}${Math.max(...counts) - 1} more`
  const codex = picks.some((p) => p.provider === 'codex') ? ' (Codex at normal speed)' : ''
  const body = [
    `Runs ${tasks} on ${n === 1 ? names : `each of ${names}`}, one task at a time${n === 1 ? '' : ', agent after agent'}, each in a new folder of the KzH scratch workspace, with the agent forced, at high effort${codex}, one attempt, no retry and no review.${counts.size === 1 ? '' : ' A local model runs fewer: a task that does not fit its window is not run, and records nothing.'}`,
    `A task that runs past ${limitText(timeoutMs)} counts as failed. One that ends in an error of the machine or the network is run once more, and a second error stops that agent with nothing recorded.`,
    'Each folder is deleted once its task is graded, and what the agent changed in its folder is kept with the result.',
    // What an agent writes beside its folder is deleted too (outsideChanges), so it is named here.
    `Anything that appears elsewhere in ${root} while a task runs is deleted, and fails that task; only its path is kept with the result.`,
    ...picks.flatMap((p) => [`${p.id}: ${estimates[p.id].lines.join(' ')}`, ...estimates[p.id].warnings]),
    'The benchmark takes one slot under your Tasks at once budget like any run, so your own tasks may wait for a free slot.',
    ...[leftoverLine(leftovers, strays, root)].filter(Boolean),
    learn
      ? "Results are recorded as capability evidence for every agent that finishes all its tasks: source benchmark, weighed at 0.7 of a run's own checks, a whole run counting on each dimension as three observations."
      : 'Learning is switched off, so the results are shown here and recorded nowhere else.',
  ]
  return { title: `Run the capability benchmark on ${plural(n, 'agent')}?`, body, confirmLabel: `Run on ${plural(n, 'agent')}` }
}

// ---------- benchmark.jsonl ----------

/** The rows of benchmark.jsonl, in order; a line that does not parse is left out. */
async function readLog(file) {
  const raw = await readFile(file, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r && typeof r === 'object')
}

/** The runs of the log by id, each with its rows. */
function runsOf(rows) {
  const runs = new Map()
  for (const r of rows) {
    if (typeof r.runId !== 'string') continue
    if (!runs.has(r.runId)) runs.set(r.runId, { id: r.runId, run: null, folders: [], tasks: [], agents: [], end: null })
    const x = runs.get(r.runId)
    if (r.type === 'run') x.run = r
    else if (r.type === 'folder') x.folders.push(r)
    else if (r.type === 'task') x.tasks.push(r)
    else if (r.type === 'agent') x.agents.push(r)
    else if (r.type === 'end') x.end = r
  }
  return runs
}

/** Each agent's last run: its agent row, with the task rows of that run, and the run's own row. */
function lastRuns(runs, { finished = false } = {}) {
  const out = new Map()
  for (const x of runs.values()) {
    for (const a of x.agents) {
      if (finished && a.status !== 'finished') continue
      out.set(a.agent, { run: x.run, agent: a, tasks: x.tasks.filter((t) => t.agent === a.agent) })
    }
  }
  return out
}

/**
 * What an interrupted run left in the scratch root `root` (3.7), as full paths. `folders`: the
 * folder of every task with a folder row and no task row, still on disk. `strays`: for the last such
 * task of the newest run in the log, every entry at the top of `root` that its folder row does not
 * list as there when the task began, which its agent may have written outside its folder before KzH
 * stopped; a later start deletes them, so an older run's task has none. The run going, `skipRun`,
 * has left nothing.
 */
function leftoversOf(rows, root, { skipRun = null } = {}) {
  const graded = new Set(rows.filter((r) => r.type === 'task').map((r) => `${r.runId}|${r.folder}`))
  const open = rows.filter((r) => r.type === 'folder' && r.runId !== skipRun && !graded.has(`${r.runId}|${r.folder}`) && /^[0-9a-f]{12}$/.test(r.folder ?? ''))
  const folders = []
  for (const r of open) {
    const dir = join(root, r.folder)
    if (existsSync(dir) && !folders.includes(dir)) folders.push(dir)
  }
  const newest = rows.findLast((r) => r.type === 'run')?.runId
  const last = newest && newest !== skipRun ? open.findLast((r) => r.runId === newest) : null
  if (!Array.isArray(last?.top)) return { folders, strays: [] }
  let names = []
  try { names = readdirSync(root) } catch { /* no scratch root, nothing in it */ }
  const strays = names.filter((n) => n !== last.folder && !last.top.includes(n)).map((n) => join(root, n)).filter((p) => !folders.includes(p)).sort()
  return { folders, strays }
}

// ---------- the runner (3.8) ----------

const refusal = (status, message) => Object.assign(new Error(message), { status })
const kindWords = { local: 'local', subscription: 'subscription', api: 'API key' }
const OUTCOME_WORDS = { passed: 'passed', failed: 'failed', timed_out: 'timed out', errored: 'errored', did_not_fit: 'did not fit', not_scored: 'not scored' }
/** How an agent's queue ended (its agent row's status), in words the card can show. */
export const AGENT_STATUS_WORDS = {
  finished: 'finished',
  stopped: 'stopped',
  errored: 'stopped after an error twice',
  not_scored: 'stopped at a task that was not scored',
  preflight_failed: 'could not do the first task',
  set_changed: 'stopped: the task set changed',
  too_small: 'its window cannot hold the first task, so nothing ran',
  not_run: 'not run',
  not_recorded: 'finished, but its results could not be recorded',
}
const statusWords = (status) => AGENT_STATUS_WORDS[status] ?? String(status).replace(/_/g, ' ')
/** What the card says the benchmark is, always shown. */
export const WHAT_IT_IS = "27 fixed tasks in nine skills, each in a new folder with its own checks, run on each agent you pick, forced, at high effort, with one attempt and no review, one task at a time. Small Node.js tasks only: no architecture, documentation, frontend, database or vision work, so those keep their priors."
/** The note under the results tables. */
export const RESULTS_NOTE = "Pass rates are over three small tasks per skill, so 2 of 3 is not a precise 67%. Prior is the owner's starting observation. Profile now is the score the Router tab shows, read with no task type; routing reads each dimension for the task's own type, which counts benchmark rows of other skills at a half or a quarter, so a routed task can read a different number. A whole run weighs on a dimension as three observations at 0.7 of a run's own checks, and halves every 180 days; for a model KzH knows only by name it stops counting 45 days after the run. A package-lock.json that npm install writes in a task with no dependencies is not counted as a change."

/**
 * The capability benchmark, for index.js (3.8, 3.11, 3.12). Every dependency is a function over
 * the plugin's own state, so the runner holds nothing of it but the run going:
 * @param {object} p
 * @param {string} p.scratchRoot  the KzH scratch workspace, `kzh-scratch` beside the harness
 * @param {string} p.file         benchmark.jsonl in the data folder
 * @param {string} [p.gitRoot]    where the task folders' repositories are kept, outside the scratch
 *                                root: benchmark-git beside benchmark.jsonl by default (3.7)
 * @param {string} [p.tasksDir]   the task set, the plugin's own by default
 * @param {() => Promise<object[]>} p.agents   every configured agent, with `kind` and `enabled`
 * @param {() => Promise<Record<string, { loggedIn: boolean, detail: string }>>} p.readiness
 * @param {(agents: object[]) => Promise<Record<string, { state: string, until?: string, kind?: string, weeklyPercent?: number, summary?: string }>>} p.quota
 * @param {(agents: object[], o: { force: boolean }) => Promise<Record<string, object>>} p.usage  usage.snapshot
 * @param {() => Promise<object[]>} p.usageLines  usage.jsonl
 * @param {(agent: object) => number|null} p.windowOf   a local agent's window in tokens, null for a cloud one
 * @param {(agent: object) => object} p.subjectOf        the subject an agent stands for now (profiles.js subjectOf)
 * @param {object} p.capabilities  the capability registry
 * @param {object} [p.priors]
 * @param {object} p.policy
 * @param {() => boolean} p.learn
 * @param {(o: object) => Promise<object>} p.runTask  index.js: runs one task through runRouted()
 * @param {(sessionId: string) => object|null} p.sessionAgent  the root agent of a chat the engine has loaded
 * @param {() => boolean} p.listed  whether the scratch workspace is in DSH's project list
 * @param {() => boolean} p.speedRunning
 * @param {(agent: object) => Promise<void>} p.loadModel  loads a local agent's model (local.start)
 * @param {(id: string) => number} p.gateAt
 * @param {(id: string) => string|null} p.excludedBy  why the routing policy excludes an agent, or null
 * @param {Record<string, object>} [p.peak]  config.pricing.peak
 * @param {(id: string) => string|null} [p.rateNow]  pricingNow's words for an agent
 * @param {number} p.agentTimeoutMs
 * @param {number} [p.listCap]  how many entries a listing of the scratch root reads at most, LIST_CAP; tests set fewer
 */
export function createBenchmark({
  scratchRoot, file, tasksDir = TASKS_DIR, gitRoot = join(dirname(file), 'benchmark-git'),
  agents, readiness, quota, usage, usageLines, windowOf, subjectOf, capabilities, priors, policy, learn,
  runTask, sessionAgent, listed, speedRunning, loadModel, gateAt, excludedBy, peak = {}, rateNow = () => null, agentTimeoutMs,
  listCap = LIST_CAP, now = Date.now, log = () => {},
}) {
  const root = resolve(scratchRoot)
  let current = null
  const plans = new Map()
  let writes = Promise.resolve()
  /**
   * Appends `row` to benchmark.jsonl, one write at a time, with the time it was handed in as its
   * `ts`. Resolves to the row as written, which is what benchmarkEvidence reads a task's end from
   * (3.9); rejects with an error marked `logFailed` when the file cannot be written.
   */
  const append = (row) => {
    const full = { ts: new Date(now()).toISOString(), ...row }
    const next = writes.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(full)}\n`)
    }).catch((err) => { throw Object.assign(new Error(`the benchmark's log could not be written (${err.message})`), { logFailed: true }) })
    writes = next.catch((err) => log(`benchmark: ${err.message}`))
    return next.then(() => full)
  }
  // The task set as it is on disk, read again whenever its files or task-set.json change, so what a
  // plan checks against its version is what a run then grades: the graders are read from disk (3.5).
  let loaded = null
  const taskSet = () => {
    const key = `${taskSetDigest(tasksDir)}\0${readFileSync(join(tasksDir, 'task-set.json'), 'utf8')}`
    if (loaded?.key !== key) loaded = { key, set: loadTaskSet(tasksDir) }
    return loaded.set
  }
  /** Whether the task set on disk is still the version `run` records. */
  const setIntact = (run) => { try { return taskSetDigest(run.set.dir) === run.set.digest } catch { return false } }
  /** The last run of this process that failed to its end, which its log may not hold (3.8): { runId, status, at, lines }. */
  let ended = null
  const same = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))
  const inside = (p) => same(p, root) || resolve(p).toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)
  const describe = (s) => `${s.family ?? s.provider ?? 'unknown'} ${s.model ?? 'with its default model'}`

  /** Where a chat stands (3.7, 3.11): whether the benchmark can run from it, and the words for why not. */
  async function where(session) {
    const out = { path: root, accountName: false, accountText: null }
    const user = (() => { try { return userInfo().username } catch { return null } })()
    if (user && root.toLowerCase().split(/[\\/]+/).includes(user.toLowerCase())) {
      out.accountName = true
      out.accountText = `This path holds your ${process.platform === 'win32' ? 'Windows ' : ''}account name, and every task's prompt sends it to the agent.`
    }
    const top = await gitTopOf(root)
    if (top) return { ...out, state: 'in_git', top, text: `The KzH scratch folder ${root} is inside the git repository ${top}, where an agent would take that repository for its project.` }
    const agent = session ? sessionAgent(session) : null
    if (session && !agent) return { ...out, state: 'not_loaded', text: 'This chat is not loaded in the engine; send any message in it, then try again.' }
    const cwd = agent?.session?.header?.cwd
    if (cwd && same(cwd, root)) return { ...out, state: 'scratch', agent, text: `This chat is in the KzH scratch workspace (${root}), which holds nothing of yours: the benchmark runs here.` }
    if (!listed()) return { ...out, state: 'not_listed', text: 'The KzH scratch workspace is added to the project list when KzH next starts.' }
    return { ...out, state: 'elsewhere', text: `Capability runs happen in the KzH scratch workspace (${root}), so no agent is started in one of your projects. Open it from the project list as KzH scratch, start a chat there, and run the benchmark from that chat's Jev tab.` }
  }

  /** Why a local agent whose window cannot hold even the first, one-file task runs nothing (3.3). */
  const tooSmall = (id, window) => `${id} cannot hold even the first, one-file task beside an agent's system prompt in its window of ${Number(window).toLocaleString('en-US')} tokens`

  /** Why an agent cannot run now, in the words of readiness, the quota or the routing policy, or null. */
  function cannotRun(a, ready, q) {
    const excluded = excludedBy(a.id)
    if (excluded) return `${a.id} is excluded by the routing policy (${excluded})`
    if (ready[a.id] && !ready[a.id].loggedIn) return `${a.id} cannot run: ${ready[a.id].detail}`
    if (['stopped', 'exhausted'].includes(q[a.id]?.state)) return `${a.id} is at its usage limit${q[a.id].until ? ` until ${new Date(q[a.id].until).toTimeString().slice(0, 5)}` : ''}`
    return null
  }

  /**
   * What one agent's run would be: its window, whether it holds the first, one-file task, how many
   * tasks fit it, how many runs in all.
   */
  const fitOf = (a, set) => {
    const window = a.kind === 'local' ? windowOf(a) : null
    const fit = set.scored.filter((t) => fitsWindow(t.tokens, window)).length
    return { window, preflight: fitsWindow(set.preflight.tokens, window), fit, total: set.scored.length, runs: fit + 1 }
  }

  /** An agent's figures from its other work, benchmark rows left out: its completed work attempts. */
  const otherWork = (lines, id) => {
    const done = lines.filter((l) => l.agent === id && (l.role === 'primary' || l.role === 'retry') && l.stopReason === 'completed' && l.purpose !== 'benchmark')
    return {
      durations: done.map((l) => l.durationMs).filter((x) => Number.isFinite(x)),
      tokens: done.map((l) => (l.tokens ? (l.tokens.input ?? 0) + (l.tokens.output ?? 0) : null)).filter((x) => x > 0),
    }
  }
  /** An agent's last complete benchmark run, as the estimate reads it: `tokens` holds what each of its attempts that reported tokens used. */
  const lastOf = (finishedRuns, id) => {
    const x = finishedRuns.get(id)
    if (!x) return null
    return {
      at: x.agent.ts,
      tasks: x.tasks.filter((t) => !t.rerun && t.outcome !== 'did_not_fit').length,
      wallMs: x.tasks.reduce((n, t) => n + (t.wallMs ?? 0), 0),
      tokens: x.tasks.map((t) => (t.tokens ? (t.tokens.input ?? 0) + (t.tokens.output ?? 0) : 0)).filter((n) => n > 0),
      usageBefore: x.agent.usageBefore ?? null,
      usageAfter: x.agent.usageAfter ?? null,
    }
  }

  /** Everything the card and the plan read about the agents now. */
  async function agentsNow(set, { force = false } = {}) {
    const all = (await agents()).filter((a) => a.enabled)
    const [ready, q] = await Promise.all([readiness(), quota(all)])
    const figures = await usage(all, { force }).catch(() => ({}))
    const lines = await usageLines().catch(() => [])
    const finished = lastRuns(runsOf(await readLog(file)), { finished: true })
    return all.map((a) => {
      const subject = subjectOf(a)
      const f = fitOf(a, set)
      const q1 = q[a.id] ?? null
      const gate = gateAt(a.id)
      const estimate = estimateOf({
        agent: a, kind: a.kind, runs: f.runs, fit: a.kind === 'local' ? f : null, window: f.window, last: lastOf(finished, a.id), other: otherWork(lines, a.id),
        usage: figures?.[a.id] ?? null, quota: q1, gateAt: gate, peak: peak?.[a.id] ?? null, rateNow: rateNow(a.id), now: now(),
      })
      return {
        def: a, id: a.id, name: a.name ?? a.id, kind: a.kind, provider: a.provider, subject, subjectKey: subjectKey(subject), why: cannotRun(a, ready, q) ?? (f.preflight ? null : tooSmall(a.id, f.window)),
        state: q1?.state ?? 'unknown', gated: a.kind === 'subscription' && typeof q1?.weeklyPercent === 'number' && q1.weeklyPercent >= gate,
        fit: f, estimate,
      }
    })
  }

  /** The plan a pick of agents makes, worked out from scratch each time it is asked for (3.11). */
  async function planFor({ session, agents: picks }) {
    const w = await where(session)
    if (w.state === 'in_git' || w.state === 'not_loaded') throw refusal(400, w.text)
    if (w.state !== 'scratch') throw refusal(400, `The capability benchmark runs only from a chat in the KzH scratch workspace (${root}).`)
    const set = taskSet()
    if (!set.digestOk) throw refusal(400, `The task set on disk no longer matches version ${set.version} of it (its files hash to ${set.actualDigest.slice(0, 12)}, not ${String(set.digest).slice(0, 12)}), so no result could say which tasks it was over.`)
    if (!Array.isArray(picks) || !picks.length || picks.some((p) => typeof p !== 'string') || new Set(picks).size !== picks.length) throw refusal(400, 'agents: the ids of the agents to run, at least one, each once')
    const now1 = await agentsNow(set, { force: false })
    const chosen = picks.map((id) => now1.find((a) => a.id === id) ?? (() => { throw refusal(400, `No enabled agent is named ${id}.`) })())
    for (const a of chosen) if (a.why) throw refusal(400, a.why)
    for (let i = 0; i < chosen.length; i++) {
      const twin = chosen.slice(i + 1).find((b) => b.subjectKey === chosen[i].subjectKey)
      if (twin) throw refusal(400, `${chosen[i].id} and ${twin.id} both run ${describe(chosen[i].subject)}, and one run records one set of results per model; pick one of them.`)
    }
    const { folders: leftovers, strays } = leftoversOf(await readLog(file), root, { skipRun: current?.runId })
    const parts = {
      taskSet: { id: set.id, version: set.version, digest: set.digest },
      picks: chosen.map((a) => ({ id: a.id, kind: a.kind, model: a.subject.model ?? null, subject: a.subjectKey, state: a.state, gated: a.gated, window: a.fit.window })),
      learn: !!learn(),
      leftovers,
      strays,
    }
    const runs = Object.fromEntries(chosen.map((a) => [a.id, a.fit.runs]))
    const confirm = confirmation({ picks: chosen, estimates: Object.fromEntries(chosen.map((a) => [a.id, a.estimate])), runs, timeoutMs: agentTimeoutMs, leftovers, strays, root, learn: parts.learn })
    return { parts, confirm, chosen, set, w, leftovers, strays }
  }

  /**
   * The plan of a pick and the confirmation the card shows for it (3.11), with the plan id a start
   * must carry: a random id /plan gives, kept with what the plan covers, good for one start within
   * PLAN_TTL_MS. Nothing but a confirmation shown by this route can start a run that spends.
   */
  async function plan(body) {
    const p = await planFor(body)
    const planId = randomBytes(8).toString('hex')
    for (const [id, x] of plans) if (now() - x.at > PLAN_TTL_MS) plans.delete(id)
    plans.set(planId, { parts: p.parts, at: now() })
    while (plans.size > 20) plans.delete(plans.keys().next().value)
    return { planId, confirm: p.confirm }
  }

  async function start({ session, agents: picks, planId }) {
    if (current) throw refusal(409, 'A capability benchmark is already running.')
    // Taken at once, so a second start with the same id is refused whatever becomes of this one; a
    // start refused below needs a plan, and a confirmation, of its own.
    const issued = typeof planId === 'string' ? plans.get(planId) : undefined
    plans.delete(planId)
    if (!issued) throw refusal(409, 'This confirmation cannot start a run: KzH did not give it, or it has already started one; review it again.')
    if (now() - issued.at > PLAN_TTL_MS) throw refusal(409, `This confirmation cannot start a run: it is over ${PLAN_TTL_MS / 60_000} minutes old; review it again.`)
    const p = await planFor({ session, agents: picks })
    if (planKeyOf(p.parts) !== planKeyOf(issued.parts)) throw refusal(409, `What the benchmark would run or spend changed since you confirmed it (${planChanges(issued.parts, p.parts)}); review it again.`)
    // Read again after every wait above, in the one turn that starts the run: from here on the speed
    // benchmark refuses while a local agent's task is left, and nothing can slip in between.
    if (current) throw refusal(409, 'A capability benchmark is already running.')
    if (p.chosen.some((a) => a.kind === 'local') && speedRunning()) throw refusal(409, 'A speed benchmark is running; start this when it has finished, or leave the local agents out.')
    const runId = `bench-${randomBytes(6).toString('hex')}`
    const order = [...p.chosen.filter((a) => a.kind === 'local'), ...p.chosen.filter((a) => a.kind !== 'local')]
    const run = {
      runId, planId, session, startedAt: now(), set: p.set, controller: new AbortController(), stopped: false, setMoved: false, learn: p.parts.learn,
      // `total`, `done` and the counts are of the scored tasks that fit; `first` is how the preflight went.
      agents: order.map((a) => ({ ...a, total: a.fit.fit, done: 0, first: null, passed: 0, failed: 0, timedOut: 0, reruns: 0, didNotFit: 0, task: null, status: 'waiting', line: null })),
    }
    // Held from here, before the first wait, so no second start slips in; let go again when the run
    // cannot begin, so nothing is left running that never will.
    current = run
    try {
      await append({ type: 'run', runId, taskSet: { id: p.set.id, version: p.set.version, digest: p.set.digest }, picks: order.map((a) => ({ id: a.id, kind: a.kind, model: a.subject.model ?? null, subject: a.subject })), planId, session, learn: run.learn })
    } catch (err) {
      current = null
      throw refusal(500, `The benchmark did not start: ${err.message}.`)
    }
    ended = null
    for (const path of [...p.leftovers, ...p.strays]) if (inside(path) && !same(path, root)) await rm(path, { recursive: true, force: true }).catch((err) => log(`benchmark: ${path} not deleted: ${err.message}`))
    // The repositories of the task folders an interrupted run left: no run goes, so none is in use.
    await rm(gitRoot, { recursive: true, force: true }).catch((err) => log(`benchmark: ${gitRoot} not deleted: ${err.message}`))
    go(run).catch((err) => log(`benchmark: the run failed: ${err.stack ?? err.message}`)).finally(() => { if (current === run) current = null })
    return { runId }
  }

  function stop() {
    if (!current) return
    current.stopped = true
    current.controller.abort(new Error('the benchmark was stopped'))
  }

  /** Whether a local agent still has a task to run in the run going: the speed benchmark refuses meanwhile (2.7). */
  const localPending = () => !!current && current.agents.some((a) => a.kind === 'local' && (a.status === 'waiting' || a.status === 'running'))

  /**
   * A usage snapshot of one agent, reduced to what its spend is read from, taken `when` its tasks
   * are 'before' or 'after' it. While it is read, which may take up to 15 seconds, the agent's
   * `phase` says so, for its progress line (3.11); a local agent spends nothing and is not read.
   */
  const spendOf = async (a, when) => {
    if (a.kind === 'local') return null
    a.phase = `spend-${when}`
    try {
      const out = await usage([a.def], { force: true }).catch(() => null)
      const q = out?.[a.id]
      return q ? { windows: (q.windows ?? []).map((w) => ({ name: w.name, minutes: w.minutes ?? null, usedPercent: w.usedPercent })), balance: q.balance ? { amount: q.balance.amount, currency: q.balance.currency } : null } : null
    } finally {
      a.phase = null
    }
  }

  /**
   * A run to its end (3.8). Whatever ends it early, a log that cannot be written or a failure
   * nothing in the queue catches, ends it here with lines that say so, never as a run KzH did not
   * see end.
   */
  async function go(run) {
    const at = { agent: null, task: null }
    try {
      await queue(run, at)
    } catch (err) {
      const why = err.logFailed ? err.message : `it failed (${err.message})`
      log(`benchmark: the run ended early: ${err.stack ?? err.message}`)
      for (const b of run.agents) {
        if (b.status === 'running') { b.status = 'failed'; b.line = `${b.id} stopped${at.agent === b ? ` at ${at.task.id}` : ''}. Nothing is recorded for it.` }
        else if (b.status === 'waiting') { b.status = 'not_run'; b.line = `${b.id} was not run.` }
      }
      ended = { runId: run.runId, status: 'failed', at: new Date(now()).toISOString(), lines: [...run.agents.map((b) => b.line).filter(Boolean), `The run ended there: ${why}.`] }
      // Said in the log too when it can still be written, so the card reads the same after a restart.
      await append({ type: 'end', runId: run.runId, status: 'failed', reason: why }).catch(() => {})
    }
  }

  /** The run's one queue, agent after agent (3.8); `at` holds the agent and the task under way. */
  async function queue(run, at) {
    for (const a of run.agents) {
      if (run.controller.signal.aborted || run.setMoved) {
        a.status = 'not_run'
        a.line = `${a.id} was not run: ${run.setMoved ? 'the task set on disk changed during the run' : 'the benchmark was stopped'}.`
        await append({ type: 'agent', runId: run.runId, agent: a.id, kind: a.kind, status: 'not_run', line: a.line, subject: a.subject, recorded: 0 })
        continue
      }
      a.status = 'running'
      // A window that cannot hold even the first, one-file task beside an agent's system prompt
      // leaves nothing to run, and no attempt to say which model it was. Such an agent cannot be
      // picked (agentsNow gives it its `why`), so this is a guard no plan reaches.
      if (!fitsWindow(run.set.preflight.tokens, a.fit.window)) {
        a.status = 'too_small'
        a.line = `${tooSmall(a.id, a.fit.window)}. Nothing was run on it.`
        await append({ type: 'agent', runId: run.runId, agent: a.id, kind: a.kind, status: a.status, line: a.line, subject: a.subject, recorded: 0 })
        continue
      }
      const usageBefore = await spendOf(a, 'before')
      const rows = []
      let stopLine = null
      let status = 'finished'
      for (const task of [run.set.preflight, ...run.set.scored]) {
        Object.assign(at, { agent: a, task })
        // The graders are read from disk at every grade: a task set that changed since the start is
        // no longer the version the run records, and nothing more is run on it.
        if (!setIntact(run)) {
          run.setMoved = true
          status = 'set_changed'
          stopLine = `${a.id} stopped at ${task.id}: the task set on disk changed during the run and no longer matches version ${run.set.version}. Nothing is recorded for it.`
          break
        }
        if (!fitsWindow(task.tokens, a.fit.window)) {
          const row = { type: 'task', runId: run.runId, agent: a.id, task: task.id, skill: task.skill, level: task.level, folder: null, rerun: false, outcome: 'did_not_fit', reason: `${task.tokens.toLocaleString('en-US')} tokens of task beside an agent's system prompt do not fit a window of ${Number(a.fit.window).toLocaleString('en-US')}` }
          rows.push(await append(row))
          a.didNotFit++
          continue
        }
        let row = await runOne(run, a, task, false)
        if (row.outcome === 'errored' && !run.controller.signal.aborted) {
          a.reruns++
          row = await runOne(run, a, task, true)
        }
        rows.push(row)
        if (task.id === PREFLIGHT) a.first = row.outcome
        else {
          if (row.outcome === 'passed') a.passed++
          else if (row.outcome === 'failed') a.failed++
          else if (row.outcome === 'timed_out') a.timedOut++
          a.done++
        }
        if (run.controller.signal.aborted) { status = 'stopped'; stopLine = `${a.id} was stopped at ${task.id}. Nothing is recorded for it.`; break }
        if (row.outcome === 'errored') { status = 'errored'; stopLine = `${a.id} stopped at ${task.id}: it ended in an error twice (${row.reason}). Nothing is recorded for it.`; break }
        if (row.outcome === 'not_scored') { status = run.setMoved ? 'set_changed' : 'not_scored'; stopLine = `${a.id} stopped at ${task.id}: ${row.reason}. Nothing is recorded for it.`; break }
        if (task.id === PREFLIGHT && row.outcome !== 'passed') {
          status = 'preflight_failed'
          stopLine = `${a.id} could not do the first, one-file task (${row.reason}): it has to run node in its folder. Nothing else was run on it.${a.provider === 'claude-code' ? ' Claude Code runs only the commands your Claude settings allow.' : ''}`
          break
        }
      }
      a.task = null
      const usageAfter = await spendOf(a, 'after')
      let recorded = 0
      if (status === 'finished') {
        try {
          const evidence = benchmarkEvidence(rows, { tasks: run.set.scored, agent: a.def, priors, benchmark: { id: run.set.id, version: run.set.version }, runId: run.runId })
          a.recordedSubject = evidence[0]?.subject ?? null
          if (run.learn) { capabilities.recordMany(evidence); recorded = evidence.length }
          const ran = run.set.scored.length - a.didNotFit
          a.line = !run.learn ? `${a.id} finished: not recorded, learning is off.`
            : a.didNotFit ? `${a.id} finished: recorded ${ran} of ${plural(run.set.scored.length, 'task')} as evidence; ${a.didNotFit} did not fit its window of ${Number(a.fit.window).toLocaleString('en-US')} tokens and ${a.didNotFit === 1 ? 'was' : 'were'} not run.`
              : `${a.id} finished: recorded ${plural(run.set.scored.length, 'task')} as evidence.`
        } catch (err) {
          status = 'not_recorded'
          a.line = `${a.id} finished, but its results were not recorded: ${err.message}.`
        }
      } else a.line = stopLine
      a.status = status
      await append({ type: 'agent', runId: run.runId, agent: a.id, kind: a.kind, status, line: a.line, subject: a.recordedSubject ?? a.subject, usageBefore, usageAfter, recorded })
    }
    await append({ type: 'end', runId: run.runId, status: run.controller.signal.aborted ? 'stopped' : run.setMoved ? 'set_changed' : 'finished' })
  }

  /** One task on one agent, from its folder to its row (3.6, 3.7): resolves to the row it wrote. */
  async function runOne(run, a, task, rerun) {
    const started = now()
    a.task = { id: task.id, startedAt: started, waiting: null }
    const base = { type: 'task', runId: run.runId, agent: a.id, task: task.id, skill: task.skill, level: task.level, rerun }
    const finish = (row) => append({ ...base, wallMs: now() - started, ...row })
    if (a.kind === 'local') {
      try { await loadModel(a.def) } catch (err) { return finish({ folder: null, outcome: 'errored', reason: `its model did not load (${String(err.message).slice(0, 200)})` }) }
    }
    // The chat the run was started from, as the engine holds it now: every agent is started with
    // its root agent as parent, which is what puts the agent in the scratch workspace (3.7).
    const owner = sessionAgent(run.session)
    if (!owner) return finish({ folder: null, outcome: 'not_scored', reason: 'the chat the benchmark was started from is no longer loaded in the engine' })
    let prepared
    try { prepared = await prepareFolder(task, root, { gitRoot }) } catch (err) { return finish({ folder: null, outcome: 'not_scored', reason: `its folder could not be made (${String(err.message).slice(0, 200)})` }) }
    const removeFolder = async () => {
      for (const d of [prepared.dir, prepared.gitDir]) await rm(d, { recursive: true, force: true }).catch((err) => log(`benchmark: ${d} not deleted: ${err.message}`))
    }
    // The names at the top of the scratch root as the task begins go into its folder row, so a start
    // after KzH stopped during the task can tell what was added since (3.7); null when unread.
    const top = await readdir(root).then((names) => names.filter((n) => n !== prepared.name).sort(), () => null)
    try {
      await append({ type: 'folder', runId: run.runId, agent: a.id, task: task.id, folder: prepared.name, top })
    } catch (err) {
      // With no row naming it, no later start would find the folder: it goes now.
      await removeFolder()
      throw err
    }
    // What the agent writes outside its folder is found by listing the scratch root before and after
    // it works; a root too big to list whole cannot be checked, so no agent is started on it.
    const tooBig = `the scratch root ${root} holds more than ${listCap.toLocaleString('en-US')} entries beside the task's folder, too many to check what its agent writes outside it`
    const before = await listTree(root, { skip: prepared.name, cap: listCap })
    if (before.truncated) {
      await removeFolder()
      return finish({ folder: prepared.name, outcome: 'not_scored', reason: tooBig })
    }
    let result
    try {
      result = await runTask({ agent: a.def, owner, session: run.session, folder: prepared.dir, git: prepared.git, prompt: task.prompt, benchmarkRunId: run.runId, signal: run.controller.signal, onWait: (line) => { if (a.task) a.task.waiting = line }, onStart: () => { if (a.task) a.task.waiting = null } })
    } catch (err) {
      result = { error: err }
    }
    const outside = await outsideChanges(root, before, await listTree(root, { skip: prepared.name, cap: listCap }), { skip: prepared.name })
    const verdict = attemptOutcome(result, { timeLimit: limitText(agentTimeoutMs) })
    if (verdict.outcome === 'graded' && outside.truncated) Object.assign(verdict, { outcome: 'not_scored', reason: tooBig })
    if (verdict.outcome === 'graded' && !setIntact(run)) {
      run.setMoved = true
      verdict.outcome = 'not_scored'
      verdict.reason = `the task set on disk changed while it ran and no longer matches version ${run.set.version}, so it was not graded`
    }
    const attempt = result?.record?.attempts?.find((x) => x.role === 'primary') ?? null
    const report = result?.executed?.[0] ?? {}
    // The weights a local agent's attempt ran on, which its report gives when the router's record
    // has none: an attempt that rejected, on its time limit say, is recorded without them (3.9).
    const modelVersion = attempt ? attempt.modelVersion ?? report.modelVersion ?? null : null
    let graded
    if (verdict.outcome === 'graded') {
      try {
        graded = await gradeFolder(task, prepared, { outside: outside.reasons })
      } catch (err) {
        // A grade that could not run is the machine's, not the agent's: run again once.
        graded = { passed: false, reason: `it could not be graded (${String(err.message).slice(0, 200)})`, detail: null, changed: [], npmLeft: [], patch: '' }
        verdict.outcome = 'errored'
        verdict.reason = graded.reason
      }
    } else {
      const changes = await changesOf(prepared).catch(() => ({ changed: [], npmLeft: [], patch: '' }))
      graded = { ...changes, passed: false, reason: verdict.reason, detail: null }
    }
    await removeFolder()
    const outcome = verdict.outcome === 'graded' ? (graded.passed ? 'passed' : 'failed') : verdict.outcome
    const reasons = verdict.outcome === 'graded' ? graded.reason : [verdict.reason, ...outside.reasons].join('; ')
    return finish({
      folder: prepared.name,
      // The subject the evidence would record for this attempt (3.9), or null when no attempt ran.
      subject: attempt ? subjectOfAttempt({ model: attempt.model ?? undefined, modelVersion: modelVersion ?? undefined }, a.def, { priors }) : null,
      model: attempt?.model ?? null,
      modelVersion,
      effort: attempt?.effort ?? null,
      outcome,
      reason: String(reasons).slice(0, 1000),
      durationMs: attempt?.durationMs ?? null,
      ...(attempt?.waitedMs ? { waitedMs: attempt.waitedMs } : {}),
      tokens: report.tokens ?? null,
      stopReason: attempt?.stopReason ?? null,
      error: attempt?.stopReason === 'error' ? String(attempt.diagnostic ?? '').slice(0, 300) : result?.error ? String(result.error.message ?? result.error).slice(0, 300) : null,
      checks: (attempt?.checks ?? []).map((c) => ({ name: c.name, passed: c.passed })),
      grade: graded.detail,
      changed: graded.changed,
      npmLeft: graded.npmLeft,
      patch: graded.patch,
      answer: attempt?.answerExcerpt ? String(attempt.answerExcerpt).slice(0, 1000) : null,
    })
  }

  /** The run `run`, the one going by default, for the card's progress lines (3.11). */
  function progress(run = current) {
    if (!run) return null
    return {
      runId: run.runId, startedAt: run.startedAt, stopping: run.stopped,
      agents: run.agents.map((a) => ({
        id: a.id, kind: a.kind, status: a.status, phase: a.phase ?? null, total: a.total, done: a.done, first: a.first, passed: a.passed, failed: a.failed, timedOut: a.timedOut, reruns: a.reruns, didNotFit: a.didNotFit,
        task: a.task ? { id: a.task.id, startedAt: a.task.startedAt, waiting: a.task.waiting } : null, line: a.line,
      })),
    }
  }

  /**
   * The two results tables of the card (3.11), as rows of `{ text, value }` cells. A blank cell's
   * value is null, which the table rule sorts last either way; -1 stands only behind a word that
   * should sort below every figure (none, unknown, not recorded).
   */
  function results(rows, set) {
    const runs = runsOf(rows)
    const skillsOf = (dim) => SKILLS.filter((s) => set.scored.some((t) => t.skill === s && t.dimensions.includes(dim)))
    const runCell = (x, note = '') => {
      const version = x.run?.taskSet?.version ?? '?'
      const older = version !== set.version
      return { text: `${dayText(x.agent.ts, now())}, version ${version}${older ? ', older than the task set' : ''}${note}`, value: Date.parse(x.agent.ts) || 0 }
    }
    const dimensions = []
    for (const x of lastRuns(runs, { finished: true }).values()) {
      const agentDef = { id: x.agent.agent, provider: x.agent.subject?.provider ?? null }
      let evidence = []
      try { evidence = benchmarkEvidence(x.tasks, { tasks: set.scored.filter((t) => x.tasks.some((r) => r.task === t.id)), agent: agentDef, priors, benchmark: { id: x.run?.taskSet?.id ?? set.id, version: x.run?.taskSet?.version ?? set.version }, runId: x.agent.runId }) } catch { continue }
      const subject = evidence[0]?.subject ?? x.agent.subject
      const prior = priorFor(subject, priors, policy)
      const profile = capabilities.profileOf(subject)
      const byDim = Map.groupBy(evidence, (e) => e.dimension)
      for (const [dim, list] of byDim) {
        const passed = list.filter((e) => e.score === 1).length
        const explained = x.agent.recorded ? capabilities.explain(subject, dim) : null
        const counting = explained?.items.filter((it) => it.runId === x.agent.runId) ?? []
        const weight = counting.reduce((n, it) => n + it.weight, 0)
        const fresh = list.reduce((n, e) => n + evidenceWeight(e, { policy, nowMs: now() }).weight, 0)
        const p = prior[dim]
        const k0 = p ? p.confidence * (p.source === 'family_prior' ? policy.evidence.familyPriorStrength : policy.evidence.priorStrength) : 0
        const weightText = !x.agent.recorded ? `not recorded (${fresh.toFixed(1)} had it been)` : !counting.length ? 'no longer counted' : p ? `${weight.toFixed(1)} against the prior's ${k0.toFixed(1)}` : `${weight.toFixed(1)}, with no prior`
        const now1 = profile.dimensions?.[dim]
        dimensions.push([
          { text: x.agent.agent, value: x.agent.agent },
          { text: subject.model ?? 'its default model', value: subject.model ?? '' },
          { text: dim.replace(/_/g, ' '), value: dim },
          { text: `${Math.round((passed / list.length) * 100)}% (${passed} of ${list.length})`, value: passed / list.length },
          { text: weightText, value: x.agent.recorded ? weight : -1 },
          { text: p ? `${p.score.toFixed(2)}, ${p.source.replace(/_/g, ' ')}` : 'none', value: p ? p.score : -1 },
          { text: now1 ? `${Math.round(now1.score * 100)}%, ${now1.confidence >= 0.75 ? 'well evidenced' : now1.confidence >= 0.4 ? 'some evidence' : 'little evidence'}` : 'unknown', value: now1 ? now1.score : -1 },
          { text: skillsOf(dim).join(', ').replace(/_/g, ' '), value: skillsOf(dim).join(',') },
          runCell(x),
        ])
      }
    }
    // The tasks behind every dimension row: each agent's last finished run, which the dimensions
    // are read from, and beside it that agent's latest run when it did not finish, marked as not
    // recorded, so a stopped run's tasks can still be read without hiding those that were recorded.
    const tasks = []
    const finished = lastRuns(runs, { finished: true })
    for (const [id, latest] of lastRuns(runs)) {
      const done = finished.get(id)
      const shown = done ? [[done, runCell(done)]] : []
      if (latest.agent !== done?.agent) shown.push([latest, runCell(latest, `, ${statusWords(latest.agent.status)}; not recorded`)])
      for (const [x, run] of shown) {
        for (const t of x.tasks) {
          tasks.push([
            { text: t.agent, value: t.agent },
            { text: t.task, value: t.task },
            { text: `${OUTCOME_WORDS[t.outcome] ?? t.outcome}${t.rerun ? ', run again' : ''}`, value: t.outcome },
            { text: t.reason ?? '', value: t.reason ?? '' },
            { text: t.skill ? t.skill.replace(/_/g, ' ') : 'first task', value: t.skill ?? '' },
            { text: String(t.level ?? ''), value: t.level ?? null },
            { text: t.durationMs == null ? '' : durationText(t.durationMs), value: t.durationMs ?? null },
            { text: t.tokens ? tokensText((t.tokens.input ?? 0) + (t.tokens.output ?? 0)) : '', value: t.tokens ? (t.tokens.input ?? 0) + (t.tokens.output ?? 0) : null },
            { text: t.effort ?? '', value: t.effort ?? '' },
            run,
          ])
        }
      }
    }
    return { dimensions, tasks }
  }

  /** GET /jev-router/benchmark (3.12): what the card shows. */
  async function state({ session } = {}) {
    const set = taskSet()
    const [w, list] = await Promise.all([where(session), agentsNow(set)])
    // The run going and the log are read together, after every wait above (a usage read may take
    // seconds), so they come from one moment: a run is either still going, or has ended with its
    // end row in the log, which it writes before it lets go of `current`. Read before those waits,
    // a log could miss the end of a run that ended during them, and read as interrupted.
    const going = current
    const failed = ended
    const rows = await readLog(file)
    const runs = runsOf(rows)
    const last = lastRuns(runs)
    const lastRun = [...runs.values()].at(-1) ?? null
    // A pick's last run, with its day as the card writes every date and how its queue ended in words.
    const lastRunOf = (x) => {
      const version = x.run?.taskSet?.version ?? null
      return { at: x.agent.ts, day: dayText(x.agent.ts, now()), status: x.agent.status, statusText: statusWords(x.agent.status), version, older: (version ?? set.version) !== set.version }
    }
    return {
      what: WHAT_IT_IS,
      note: RESULTS_NOTE,
      taskSet: {
        id: set.id, version: set.version, digestOk: set.digestOk, tasks: set.scored.length,
        skills: SKILLS.map((skill) => ({ skill, tasks: set.scored.filter((t) => t.skill === skill).length, dimensions: CREDITED[skill] })),
      },
      where: { state: w.state, path: w.path, text: w.text, accountText: w.accountText },
      learn: !!learn(),
      agents: list.map((a) => ({
        id: a.id, name: a.name, kind: a.kind, kindText: kindWords[a.kind] ?? a.kind, model: a.subject.model ?? null, subject: describe(a.subject),
        can: !a.why, why: a.why, estimate: a.estimate.lines, warnings: a.estimate.warnings,
        fit: a.kind === 'local' ? { fit: a.fit.fit, total: a.fit.total, window: a.fit.window } : null,
        lastRun: last.has(a.id) ? lastRunOf(last.get(a.id)) : null,
      })),
      run: progress(going),
      last: going ? null : failed ?? (lastRun ? {
        runId: lastRun.id, status: lastRun.end?.status ?? 'interrupted', at: lastRun.end?.ts ?? lastRun.run?.ts ?? null,
        lines: [...lastRun.agents.map((a) => a.line).filter(Boolean), ...(lastRun.end?.reason ? [`The run ended there: ${lastRun.end.reason}.`] : [])],
      } : null),
      results: results(rows, set),
      leftovers: Object.values(leftoversOf(rows, root, { skipRun: going?.runId })).flat().length,
    }
  }

  return { state, plan, start, stop, localPending, where, running: () => !!current }
}

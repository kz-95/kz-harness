// The capability benchmark's own module (docs/benchmark.md 3 and 5.2): the task set and its digest,
// the task folder and its grade with the real graders in real processes, the estimate, the plan and
// its confirmation, and the runner with a fake task runner over the real lanes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_PROMPT_TOKENS, CREDITED, LEVEL_TOKENS, PREFLIGHT, SKILLS, TASKS_DIR, TOOL_OUTPUT_TOKENS,
  agentEnv, answerMatches, attemptOutcome, confirmation, createBenchmark, estimateOf, fitsWindow, gradeEnv, gradeFolder,
  listTree, loadTaskSet, matchFindings, outsideChanges, parseTap, planChanges, prepareFolder, reachesPeak,
  taskSetDigest, writeFiles,
} from '../benchmark.js'
// A namespace as well, for what a later change added, so the file still loads where it is missing.
import * as benchmarkModule from '../benchmark.js'
import { createCapabilityRegistry, loadPriors } from '../profiles.js'
import { TASK_DIMENSIONS, resolvePolicy } from '../routing-policy.js'
import { createLanes } from '../tasks.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PRIORS = loadPriors(join(REPO, 'config', 'capability-priors.json'))
const POLICY = resolvePolicy()
const SET = loadTaskSet()
const made = []
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const scratch = (name = 'kzh-bench-') => { const dir = mkdtempSync(join(tmpdir(), name)); made.push(dir); return dir }
const task = (id) => SET.tasks.find((t) => t.id === id)
const nodeVersion = () => execFileSync('node', ['--version'], { encoding: 'utf8' })
const PREFLIGHT_SOLUTION = () => [{ path: 'hello.txt', text: nodeVersion() }]
/** A task folder with `files` laid over its workspace, graded. */
async function graded(t, files = [], options = {}) {
  const root = scratch()
  const p = await prepareFolder(t, root, { gitRoot: scratch('kzh-bench-git-') })
  await writeFiles(files, p.dir)
  return { ...(await gradeFolder(t, p, options)), dir: p.dir, prepared: p }
}
const solution = (t, name) => (name ? t.solutions.find((s) => s.name === name) : t.solutions[0]).files
const file = (t, path) => t.files.find((f) => f.path === path).text

// ---------- the task set (3.2 to 3.5) ----------

test('the task set loads and is sound: the preflight, then nine skills of three levels, each within its bounds', () => {
  assert.equal(SET.id, 'kzh-capability')
  assert.equal(typeof SET.version, 'string')
  assert.equal(SET.tasks[0].id, PREFLIGHT)
  assert.equal(SET.scored.length, 27)
  assert.deepEqual(SET.scored.map((t) => t.id), SKILLS.flatMap((s) => [1, 2, 3].map((l) => `${s}-${l}`)), 'skill order, then level order')
  const folders = new Set()
  for (const t of SET.scored) {
    assert.ok(Object.hasOwn(TASK_DIMENSIONS, t.skill), `${t.id}: a task type of the router`)
    assert.ok(t.dimensions.length && t.dimensions.every((d) => CREDITED[t.skill].includes(d)), `${t.id}: dimensions a non-empty subset of what its skill credits`)
    assert.deepEqual(t.dimensions, CREDITED[t.skill], `${t.id}: every credited dimension, so a run's weight per dimension is what 3.9 counts`)
    assert.doesNotMatch(t.prompt, /benchmark|\bgraded\b|\bhidden\b|\bevaluation\b|test harness/i, t.id)
    assert.ok(t.tokens <= LEVEL_TOKENS[t.level], `${t.id}: ${t.tokens} tokens within level ${t.level}`)
    for (const p of t.protect) assert.ok(t.files.some((f) => f.path === p.replace(/\/$/, '') || f.path.startsWith(p.endsWith('/') ? p : `${p}/`)), `${t.id}: protected ${p} is there`)
    assert.ok(!folders.has(t.folder), `${t.id}: folder ${t.folder} is its own`)
    folders.add(t.folder)
    if (t.grade.kind === 'tests') for (const [f, n] of Object.entries(t.grade.tests)) assert.ok(Number.isInteger(n) && n > 0, `${t.id}: ${f} has its test count`)
    assert.ok(t.solutions.length >= 1, `${t.id}: a reference solution`)
  }
  for (const f of readdirSync(TASKS_DIR, { recursive: true })) assert.ok(!String(f).split(/[\\/]/).some((part) => part.startsWith('.')), `${f} does not start with a dot`)
  // The weight per dimension of 3.9: 12 tasks credit coding, 9 general_reasoning, and so on.
  const crediting = (d) => SET.scored.filter((t) => t.dimensions.includes(d)).length
  assert.deepEqual(Object.fromEntries(['coding', 'general_reasoning', 'debugging', 'instruction_following', 'code_review', 'testing', 'security_review'].map((d) => [d, crediting(d)])), { coding: 12, general_reasoning: 9, debugging: 6, instruction_following: 6, code_review: 6, testing: 3, security_review: 3 })
})

test('no file of the task set is dropped by the repository\'s .gitignore', () => {
  const out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', 'plugins/jev-router/benchmark-tasks'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(out, '')
})

/** A task set of the tasks `ids` of the real one, with `edit` done to its folder, as a defect would leave it. */
function setWith(ids, edit) {
  const dir = join(scratch('kzh-bench-set-'), 'tasks')
  for (const id of new Set(ids)) cpSync(join(TASKS_DIR, id), join(dir, id), { recursive: true })
  writeFileSync(join(dir, 'task-set.json'), JSON.stringify({ id: 'kzh-capability', version: '1', digest: 'none', tasks: ids }))
  edit(dir)
  return dir
}
/** Rewrites the JSON file `file` in `dir` with `f`. */
const editJson = (dir, file, f) => { const path = join(dir, ...file.split('/')); writeFileSync(path, JSON.stringify(f(JSON.parse(readFileSync(path, 'utf8'))))) }

test('a task set that is not sound is refused as it loads, naming each defect: its words, its size, its package.json, its paths, a dot file, its grade and its reference solution', () => {
  const task = (id, f) => [['preflight', id], (d) => editJson(d, `${id}/task.json`, f)]
  const pkg = (id, f) => [['preflight', id], (d) => editJson(d, `${id}/workspace/package.json`, f)]
  const cases = [
    ['a telltale word', task('debugging-1', (t) => ({ ...t, prompt: `${t.prompt}\nThis is a benchmark.` })), /debugging-1: the prompt says benchmark/],
    ['a task over its level', task('review-3', (t) => ({ ...t, level: 1 })), /review-3: \d+ tokens, over the 1500 of level 1/],
    ['a skill that is not one', task('debugging-1', (t) => ({ ...t, skill: 'design' })), /debugging-1: skill design is not one of implementation, debugging/],
    ['a dimension the skill does not credit', task('debugging-1', (t) => ({ ...t, dimensions: ['vision'] })), /debugging-1: dimensions must be a non-empty subset of debugging, coding, general_reasoning/],
    ['a level that is not one', task('debugging-1', (t) => ({ ...t, level: 4 })), /debugging-1: level must be 1, 2 or 3/],
    ['a folder that is not a name', task('debugging-1', (t) => ({ ...t, folder: 'Cart Total' })), /debugging-1: folder must be a lower-case name/],
    ['no prompt', task('debugging-1', (t) => ({ ...t, prompt: ' ' })), /debugging-1: prompt must be text/],
    ['a test script of its own', pkg('debugging-1', (p) => ({ ...p, scripts: { test: 'mocha' } })), /debugging-1: package\.json must be "type": "module" with "test": "node --test"/],
    ['a dependency', pkg('debugging-1', (p) => ({ ...p, dependencies: { 'left-pad': '1.3.0' } })), /debugging-1: a task installs nothing: package\.json lists dependencies/],
    ['a package named for another folder', pkg('debugging-1', (p) => ({ ...p, name: 'other' })), /debugging-1: package\.json names other, not cart-total/],
    ['a protected path it lacks', task('debugging-1', (t) => ({ ...t, protect: ['package.json', 'nope/'] })), /debugging-1: protected nope\/ is not in its workspace/],
    ['a path out of its folder', task('debugging-1', (t) => ({ ...t, onlyChanged: ['../x.js'] })), /debugging-1: onlyChanged must be a list of paths from the folder/],
    ['a dot file', [['preflight', 'debugging-1'], (d) => writeFileSync(join(d, 'debugging-1', 'workspace', '.env'), 'X=1\n')], /debugging-1: workspace\/\.env starts with a dot, which the repository's \.gitignore drops/],
    ['a grade of no kind', task('debugging-1', (t) => ({ ...t, grade: { kind: 'vibes' } })), /debugging-1: grade\.kind must be one of tests, mutants, findings, answer/],
    ['a grade file it lacks', task('debugging-1', (t) => ({ ...t, grade: { kind: 'tests', tests: { 'grade/missing.test.js': 3 } } })), /debugging-1: grade file grade\/missing\.test\.js is not in grade\//],
    ['a grade file with no count', task('debugging-1', (t) => ({ ...t, grade: { kind: 'tests', tests: { 'grade/cart.test.js': 0 } } })), /debugging-1: grade file grade\/cart\.test\.js needs its number of tests/],
    ['mutants with no version that behaves the same', [['preflight', 'testing-1'], (d) => rmSync(join(d, 'testing-1', 'equivalent'), { recursive: true })], /testing-1: equivalent\/ must hold /],
    ['a planted defect on no line', task('review-1', (t) => ({ ...t, grade: { ...t.grade, defects: [...t.grade.defects, { file: 'src/paginate.js', from: 900, to: 901 }] } })), /review-1: defect .* names no lines of its workspace/],
    ['more defects to find than there are', task('review-1', (t) => ({ ...t, grade: { ...t.grade, minFound: 9 } })), /review-1: grade\.minFound must be between 1 and the number of defects/],
    ['an answer with nothing to match', task('investigation-1', (t) => ({ ...t, grade: { kind: 'answer' } })), /investigation-1: grade\.expect must be the answer/],
    ['no reference solution', [['preflight', 'debugging-1'], (d) => rmSync(join(d, 'debugging-1', 'solutions'), { recursive: true })], /debugging-1: it has no reference solution/],
    ['no preflight first', [['debugging-1', 'preflight'], () => {}], /the first task must be preflight/],
    ['a task listed twice', [['preflight', 'debugging-1', 'debugging-1'], () => {}], /debugging-1 is listed twice/],
  ]
  for (const [what, [ids, edit], named] of cases) {
    const dir = setWith(ids, edit)
    assert.throws(() => loadTaskSet(dir), (err) => err.message.startsWith("The benchmark's task set is not sound: ") && named.test(err.message), what)
  }
  assert.doesNotThrow(() => loadTaskSet(setWith(['preflight', 'debugging-1', 'testing-1', 'review-1', 'investigation-1'], () => {})), 'the same tasks untouched are sound')
})

test('the digest is the one task-set.json records, over forward-slash paths in code-unit order with CRLF read as LF, and any change to a byte moves it', () => {
  const digest = taskSetDigest(TASKS_DIR)
  assert.equal(SET.digest, digest, `The task set changed: raise version to "${Number(SET.version) + 1}" and set digest to "${digest}".`)
  assert.equal(SET.digestOk, true)
  const copy = join(scratch(), 'tasks')
  cpSync(TASKS_DIR, copy, { recursive: true })
  const one = join(copy, 'debugging-1', 'workspace', 'src', 'cart.js')
  const text = readFileSync(one, 'utf8')
  // \r?\n, not \n: on a CRLF checkout the file already has them, and \n -> \r\n makes \r\r\n.
  writeFileSync(one, text.replace(/\r?\n/g, '\r\n'))
  assert.equal(taskSetDigest(copy), digest, 'CRLF reads as LF')
  writeFileSync(one, text.replace('100 - percentOff', '100 - percentOf'))
  assert.notEqual(taskSetDigest(copy), digest, 'a changed byte')
  const moved = loadTaskSet(copy)
  assert.equal(moved.digestOk, false)
})

test('a task folder gets its workspace with LF line ends, in a git repository of its own with core.autocrlf off and one commit', async () => {
  const t = { ...task('debugging-1'), files: task('debugging-1').files.map((f) => ({ ...f })) }
  const root = scratch()
  const p = await prepareFolder(t, root, { gitRoot: scratch('kzh-bench-git-') })
  assert.match(p.name, /^[0-9a-f]{12}$/)
  assert.equal(readFileSync(join(p.dir, 'src', 'cart.js'), 'utf8'), file(t, 'src/cart.js'))
  assert.ok(!readFileSync(join(p.dir, 'src', 'cart.js'), 'utf8').includes('\r'))
  const git = (...a) => execFileSync('git', a, { cwd: p.dir, env: p.git, encoding: 'utf8' }).trim()
  assert.equal(git('config', 'core.autocrlf'), 'false')
  assert.equal(git('rev-list', '--count', 'HEAD'), '1')
  assert.equal(git('status', '--porcelain'), '', 'nothing but the task in it')
  assert.deepEqual(Object.keys(p.protectedHashes).sort(), ['package.json', 'test/cart.test.js'])
})

// ---------- grading (3.6) ----------

/**
 * Runs `jobs` (functions returning promises) with at most `limit` going at once; resolves to their
 * results in order. The grades time their performance cases and start processes of their own, so
 * this file grades on half the machine's cores and leaves the rest to the test files running beside
 * it: a hundred graders at once slowed a reference solution's two-second case past its time limit
 * on a four-core PC.
 */
async function inPool(jobs, limit = Math.max(2, Math.floor(availableParallelism() / 2))) {
  const out = new Array(jobs.length)
  let next = 0
  const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i]() } }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return out
}

test('every task fails its grade untouched and passes it with each reference solution, with the real graders, and a tests grade runs exactly its counted tests', async () => {
  const jobs = SET.tasks.flatMap((t) => [
    async () => ({ t, name: null, result: await graded(t) }),
    ...(t.id === PREFLIGHT ? [{ name: 'node --version', files: PREFLIGHT_SOLUTION() }] : t.solutions).map((s) => async () => ({ t, name: s.name, result: await graded(t, s.files) })),
  ])
  const done = await inPool(jobs)
  const results = SET.tasks.map((t) => ({
    t,
    untouched: done.find((d) => d.t === t && d.name === null).result,
    solved: done.filter((d) => d.t === t && d.name !== null).map((d) => ({ name: d.name, ...d.result })),
  }))
  for (const { t, untouched, solved } of results) {
    assert.equal(untouched.passed, false, `${t.id} untouched: ${untouched.reason}`)
    for (const s of solved) {
      assert.equal(s.passed, true, `${t.id} with ${s.name}: ${s.reason}`)
      if (t.grade.kind === 'tests') assert.equal(s.detail.pass, Object.values(t.grade.tests).reduce((a, b) => a + b, 0), `${t.id} with ${s.name}: every counted test ran`)
    }
  }
  // Each grade's accepted alternatives are among the solutions the suite passes.
  const names = (id) => task(id).solutions.map((s) => s.name).sort()
  assert.deepEqual(names('refactor-3'), ['fs-dot-promises', 'fs-promises'])
  assert.deepEqual(names('security-2'), ['crypto-default', 'named-import'])
  assert.deepEqual(names('security-3'), ['numbers-plain', 'numbers-quoted'])
  assert.deepEqual(names('debugging-3'), ['drop-on-update', 'set-on-update'])
})

/** A task of its own, for what the shipped ones cannot show: `grade` files and a workspace. */
function ownTask({ grade = {}, workspace = {}, count = 1, protect = [], onlyChanged = null } = {}) {
  const dir = scratch('kzh-own-task-')
  for (const [path, text] of Object.entries({ 'grade/own.test.js': '', ...grade })) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) }
  const files = Object.entries({ 'package.json': '{ "name": "own", "type": "module", "scripts": { "test": "node --test" } }\n', ...workspace }).map(([path, text]) => ({ path, text }))
  return { id: 'own', skill: 'implementation', level: 1, dimensions: ['coding'], folder: 'own', prompt: 'Do it.', protect, onlyChanged, dir, files, grade: { kind: 'tests', tests: { 'grade/own.test.js': count } }, solutions: [], mutants: [], equivalent: [] }
}
const importWorkspace = "import { join } from 'node:path'\nimport { pathToFileURL } from 'node:url'\nconst load = () => import(pathToFileURL(join(process.env.BENCH_WORKSPACE, 'src', 'm.js')).href)\n"

test('a module that ends the process when a grade file imports it fails the grade, and so does a cancelled, skipped or unfinished test', async () => {
  const three = `import { test } from 'node:test'\n${importWorkspace}test('one', async () => { await load() })\ntest('two', () => {})\ntest('three', () => {})\n`
  const exits = ownTask({ grade: { 'grade/own.test.js': three }, workspace: { 'src/m.js': 'process.exit(0)\n' }, count: 3 })
  const exited = await graded(exits)
  assert.equal(exited.passed, false)
  assert.match(exited.reason, /only 1 of 3 checks ran to a pass/)
  const fine = await graded(exits, [{ path: 'src/m.js', text: 'export const ok = true\n' }])
  assert.equal(fine.passed, true, fine.reason)
  // A test that never settles is reported as cancelled by some versions of the runner and simply
  // hangs on others - Node 24 hangs it - so the grade catches it by its own time limit instead.
  // Either way the grade must not pass, which is the whole of what this asserts; the short limit
  // is here because the default one would spend a minute of every suite run proving it.
  for (const [kind, body, opts] of [
    ['skipped', "test('two', { skip: true }, () => {})", {}],
    ['todo', "test('two', { todo: true }, () => {})", {}],
    ['never settles', "test('two', () => new Promise(() => {}))", { checksMs: 1500 }],
  ]) {
    const t = ownTask({ grade: { 'grade/own.test.js': `import { test } from 'node:test'\ntest('one', () => {})\n${body}\n` }, count: 1 })
    const r = await graded(t, [], opts)
    assert.equal(r.passed, false, kind)
    assert.match(r.reason, /cancelled, skipped or left to do|failed|did not finish/, kind)
  }
})

test('checks that run past their time fail with that reason, and the grade environment holds only its five variables', async () => {
  const hangs = ownTask({ grade: { 'grade/own.test.js': "import { test } from 'node:test'\ntest('forever', () => { for (;;) {} })\n" } })
  const r = await graded(hangs, [], { checksMs: 1500 })
  assert.equal(r.passed, false)
  assert.equal(r.reason, 'the checks did not finish in 1.5 seconds')
  // The grade runs the agent's code with PATH, SystemRoot, TEMP, TMP and BENCH_WORKSPACE only (node:test
  // adds its own NODE_TEST_ names to the processes of its files: NODE_TEST_CONTEXT, and
  // NODE_TEST_WORKER_ID on newer Node, so they are matched by prefix rather than listed).
  //
  // Windows does not take that list as final: libuv adds USERNAME, USERPROFILE and six more to any
  // child that leaves them unset, so this promise was false there until `gradeEnv` began passing
  // each of them as an empty string. A variable set to an empty string is the platform's way of
  // saying "not this one", which is why the filter below reads values rather than keys - on
  // Windows the keys are present and empty, and on Linux they are absent, and the point is that
  // neither reaches the agent's code with anything in it.
  process.env.KZH_TEST_API_KEY = 'sk-not-for-the-agent'
  process.env.DSH_TEST_SECRET_THING = 'nor-this'
  try {
    const env = ownTask({ grade: { 'grade/own.test.js': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('env', () => { assert.deepEqual(Object.entries(process.env).filter(([k, v]) => v !== '' && !k.startsWith('NODE_TEST_') && !['PATH', 'SystemRoot', 'TEMP', 'TMP', 'BENCH_WORKSPACE'].includes(k)).map(([k]) => k), []) })\n" } })
    const e = await graded(env)
    assert.equal(e.passed, true, e.reason)
    const only = (o) => Object.entries(o).filter(([, v]) => v !== '').map(([k]) => k).sort()
    assert.deepEqual(only(gradeEnv('/w', { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', TEMP: '/t' })), ['BENCH_WORKSPACE', 'PATH', 'TEMP'])
    // Named one by one, and asserted on every platform rather than only where they exist: this is
    // the list Windows puts back, and it is worth reading in a review on a machine that cannot run it.
    for (const name of ['USERNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'SYSTEMDRIVE', 'WINDIR']) {
      assert.equal(gradeEnv('/w', { PATH: '/bin', [name]: 'someone' })[name], '', `${name} is suppressed, not passed through`)
    }
    // The real thing, on the platform that adds them: a child given this environment sees no
    // account name. On Linux nothing is added and this passes for the ordinary reason.
    const child = spawnSync(process.execPath, ['-e', 'const e = process.env; console.log(Object.entries(e).filter(([, v]) => v !== \'\').map(([k]) => k).sort().join(\' \'))'], { env: gradeEnv('/w'), encoding: 'utf8' })
    assert.deepEqual(child.stdout.trim().split(' ').sort(), ['BENCH_WORKSPACE', 'PATH', 'SystemRoot', 'TEMP', 'TMP'], child.stdout)
    // The run's checks get the engine's scrubbed environment: no name holding KEY, PASSWORD, SECRET or TOKEN, and no DSH_ name.
    const scrubbed = agentEnv()
    assert.equal(scrubbed.KZH_TEST_API_KEY, undefined)
    assert.equal(scrubbed.DSH_TEST_SECRET_THING, undefined)
    assert.deepEqual(Object.keys(agentEnv({ PATH: 'p', MY_TOKEN: 't', DB_PASSWORD: 'p', A_SECRET: 's', GITHUB_KEYS: 'k', DSH_HOME: 'h', HOME: 'h' })).sort(), ['HOME', 'PATH'])
  } finally {
    delete process.env.KZH_TEST_API_KEY
    delete process.env.DSH_TEST_SECRET_THING
  }
})

test('a performance answer whose timed call runs past 2 seconds is killed and fails with its reason, and the untouched performance tasks take seconds, not minutes', async () => {
  const started = Date.now()
  const [p1, p2, p3] = await Promise.all(['performance-1', 'performance-2', 'performance-3'].map((id) => graded(task(id))))
  assert.ok(Date.now() - started < 45_000, `${Date.now() - started} ms`)
  assert.match(p1.reason, /in under 2 seconds \(took longer than 2 seconds: stopped after 4\)/)
  assert.match(p2.reason, /took longer than 2 seconds: stopped after 4/)
  assert.match(p3.reason, /took longer than 2 seconds: stopped after 4/)
})

test('an agent\'s tests: those that pass on the original, the version that behaves the same and kill every mutant pass; tests of the source text, tests that assert nothing and a mutant run that runs out of time do not', async () => {
  const t = task('testing-1')
  const testFile = (body, path = 'test/slugify.test.js') => [{ path, text: `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nimport { slugify } from '../src/slugify.js'\n${body}\n` }]
  const reads = await graded(t, testFile("test('reads', () => { const src = readFileSync(new URL('../src/slugify.js', import.meta.url), 'utf8'); for (const bit of ['toLowerCase', '+/g', '^-+|-+$', 'NFKD', '<= 60']) assert.ok(src.includes(bit), bit) })"))
  assert.equal(reads.passed, false)
  assert.match(reads.reason, /behaves the same, written differently/)
  const nothing = await graded(t, testFile("test('runs', () => { slugify('A b') })"))
  assert.equal(nothing.passed, false)
  assert.match(nothing.reason, /missed 5 of 5 changes to src\/slugify\.js/)
  // A run that hangs on one mutant, rather than failing on it, did not catch it, whatever else failed there.
  const hangs = await graded(t, [...solution(t), ...testFile("test('hangs on upper case', () => { if (slugify('ABC') !== 'abc') for (;;) {} })", 'test/hang.test.js')], { mutantMs: 4000 })
  assert.equal(hangs.passed, false)
  assert.match(hangs.reason, /missed 1 of 5 changes to src\/slugify\.js: no-lower-case/)
  assert.equal(hangs.detail.killed, 4)
})

test('protected files, the only files that may change, what the agent left outside its folder, and the answers it writes each fail a task with their reason', async () => {
  const impl = task('implementation-1')
  const edited = await graded(impl, [...solution(impl), { path: 'test/duration.test.js', text: 'export {}\n' }])
  assert.equal(edited.passed, false)
  assert.match(edited.reason, /changed test\/duration\.test\.js, which the task protects/)
  const removed = await graded(impl, solution(impl))
  rmSync(join(removed.dir, 'package.json'))
  const again = await gradeFolder(impl, removed.prepared)
  assert.match(again.reason, /changed package\.json, which the task protects/)
  // A test the agent adds under a protected folder is its own, and npm's lock file is not a change.
  const added = await graded(impl, [...solution(impl), { path: 'test/extra.test.js', text: "import { test } from 'node:test'\ntest('mine', () => {})\n" }, { path: 'package-lock.json', text: '{ "lockfileVersion": 3 }\n' }])
  assert.equal(added.passed, true, added.reason)
  assert.deepEqual(added.npmLeft, ['package-lock.json'])
  assert.ok(!added.changed.includes('package-lock.json'))
  const greet = task('simple_change-1')
  const readme = await graded(greet, [...solution(greet), { path: 'README.md', text: 'Welcome\n' }, { path: 'src/new.js', text: '\n' }])
  assert.equal(readme.passed, false)
  assert.match(readme.reason, /changed README\.md; only src\/config\.js may change/)
  assert.match(readme.reason, /changed src\/new\.js; only src\/config\.js may change/)
  const review = task('review-1')
  assert.match((await graded(review)).reason, /REVIEW\.json was not written/)
  assert.match((await graded(review, [{ path: 'REVIEW.json', text: '{ nope' }])).reason, /REVIEW\.json is not JSON/)
  assert.match((await graded(review, [{ path: 'REVIEW.json', text: '[{ "file": "src/paginate.js", "line": "23" }]' }])).reason, /not a JSON array of objects with a file and a whole-number line/)
  const answer = task('investigation-1')
  assert.match((await graded(answer)).reason, /ANSWER\.json was not written/)
  assert.match((await graded(answer, [{ path: 'ANSWER.json', text: '{ "timeout": 2500, "source": "env" }' }])).reason, /is not the right one/)
  assert.equal((await graded(answer, [{ path: 'ANSWER.json', text: `${String.fromCharCode(0xfeff)}{ "timeout": 4000, "source": " file " }` }])).passed, true, 'a byte order mark and spaces around a string are nothing')
  // Outside its folder: the listing of the scratch root before and after, and what was added is deleted.
  const root = scratch()
  mkdirSync(join(root, 'mine'))
  writeFileSync(join(root, 'README.md'), 'scratch\n')
  const before = await listTree(root, { skip: 'mine' })
  writeFileSync(join(root, 'stray.txt'), 'left here\n')
  mkdirSync(join(root, 'newdir', 'deep'), { recursive: true })
  writeFileSync(join(root, 'newdir', 'deep', 'x.js'), 'x\n')
  writeFileSync(join(root, 'README.md'), 'changed\n')
  writeFileSync(join(root, 'mine', 'inside.txt'), 'the task folder is its own\n')
  const out = await outsideChanges(root, before, await listTree(root, { skip: 'mine' }), { skip: 'mine' })
  assert.deepEqual(out.reasons, ['wrote outside its folder: README.md', 'wrote outside its folder: newdir', 'wrote outside its folder: newdir/deep', 'wrote outside its folder: newdir/deep/x.js', 'wrote outside its folder: stray.txt'])
  assert.equal(existsSync(join(root, 'stray.txt')), false)
  assert.equal(existsSync(join(root, 'newdir')), false)
  assert.equal(existsSync(join(root, 'mine', 'inside.txt')), true)
  const failedOutside = await graded(impl, solution(impl), { outside: out.reasons })
  assert.equal(failedOutside.passed, false)
  assert.match(failedOutside.reason, /wrote outside its folder: stray\.txt/)
})

/**
 * What an agent that wants git to run its code would write in its folder: a clean filter on every
 * file, named in the .git of the folder, a repository of its own when the folder holds none. The
 * filter keeps the key it finds in its environment in `leak` and adds it to what git stores.
 */
function plantFilter(folder, leak) {
  const probe = `${leak}.mjs`
  writeFileSync(probe, `import { appendFileSync } from 'node:fs'\nlet s = ''\nprocess.stdin.on('data', (d) => { s += d })\nprocess.stdin.on('end', () => { const k = process.env.KZH_PROBE_API_KEY ?? 'none'; appendFileSync(${JSON.stringify(leak)}, k + '\\n'); process.stdout.write(s + '// ' + k + '\\n') })\n`)
  const dotGit = join(folder, '.git')
  if (!existsSync(join(dotGit, 'HEAD'))) execFileSync('git', ['init', '-q'], { cwd: folder })
  appendFileSync(join(dotGit, 'config'), `[filter "probe"]\n\tclean = "${process.execPath.replace(/\\/g, '/')}" "${probe.replace(/\\/g, '/')}"\n`)
  mkdirSync(join(dotGit, 'info'), { recursive: true })
  appendFileSync(join(dotGit, 'info', 'attributes'), '* filter=probe\n')
}

test('a task folder\'s repository is kept outside the scratch root, so a filter an agent names in a .git of its folder never runs when the folder is graded, and no key of KzH\'s reaches the patch', async (t) => {
  const cart = task('debugging-1')
  const p = await prepareFolder(cart, scratch(), { gitRoot: scratch('kzh-bench-git-') })
  process.env.KZH_PROBE_API_KEY = 'sk-kzh-probe-secret'
  t.after(() => { delete process.env.KZH_PROBE_API_KEY })
  await writeFiles(solution(cart), p.dir)
  const leak = join(scratch('kzh-leak-'), 'leak.txt')
  plantFilter(p.dir, leak)
  const g = await gradeFolder(cart, p)
  assert.equal(existsSync(leak), false, 'the filter the agent named never ran')
  assert.ok(!g.patch.includes('sk-kzh-probe-secret'), 'no key of KzH\'s in the patch')
  assert.equal(g.passed, true, g.reason)
  assert.deepEqual(g.changed, ['src/cart.js'], 'the .git the agent made is no change of its')
})

test('a listing of the scratch root that reached its cap says so, and what changed outside a folder is then neither read from it nor deleted by it', async () => {
  const root = scratch()
  mkdirSync(join(root, 'mine'))
  for (let i = 0; i < 6; i++) writeFileSync(join(root, `f${i}.txt`), 'x\n')
  const before = await listTree(root, { skip: 'mine', cap: 5 })
  assert.equal(before.truncated, true)
  writeFileSync(join(root, 'a-new.txt'), 'written outside its folder\n')
  const after = await listTree(root, { skip: 'mine', cap: 5 })
  const out = await outsideChanges(root, before, after, { skip: 'mine' })
  assert.deepEqual([out.truncated, out.reasons], [true, []], 'no reason read from a listing that stopped short')
  assert.deepEqual(readdirSync(root).sort(), ['a-new.txt', 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'mine'], 'and nothing deleted by it')
})

test('findings match a planted defect by path and line range, each at most once, in the largest matching there is whatever order the defects and findings come in; answers are compared trimmed, paths as findings are', () => {
  const defects = [{ file: 'src/a.js', from: 23, to: 24 }, { file: 'src/a.js', from: 19, to: 20 }, { file: 'src/a.js', from: 24, to: 24 }]
  const f = (file, line) => ({ file, line, problem: 'x' })
  assert.deepEqual(matchFindings(defects, [f('src/a.js', 23), f('src/a.js', 19), f('src/a.js', 24)]), { found: 3, extra: 0 })
  assert.deepEqual(matchFindings(defects, [f('src/a.js', 24), f('src/a.js', 24)]), { found: 2, extra: 0 }, 'two findings on one line, one for each defect it can be')
  assert.deepEqual(matchFindings(defects, [f('src/a.js', 24)]), { found: 1, extra: 0 })
  assert.deepEqual(matchFindings(defects, [f('.\\src\\a.js', 20), f('./src/a.js', 23)]), { found: 2, extra: 0 }, 'backslashes and a leading ./')
  assert.deepEqual(matchFindings(defects, [f('src/a.js', 20), f('src/a.js', 20), f('src/b.js', 23), f('src/a.js', 30)]), { found: 1, extra: 3 })
  assert.deepEqual(matchFindings([{ file: 'x.js', from: 1, to: 5 }, { file: 'x.js', from: 3, to: 3 }], [f('x.js', 3), f('x.js', 4)]), { found: 2, extra: 0 }, 'the largest matching there is')
  for (const findings of [[f('src/a.js', 24)], [f('src/a.js', 24), f('src/a.js', 23)], [f('src/a.js', 20), f('src/a.js', 24), f('src/a.js', 24), f('src/a.js', 40)]]) {
    const at = matchFindings(defects, findings)
    assert.deepEqual(matchFindings([...defects].reverse(), findings), at, 'defects in another order')
    assert.deepEqual(matchFindings(defects, [...findings].reverse()), at, 'findings in another order')
  }
  assert.equal(answerMatches({ timeout: 4000, source: 'file' }, { source: ' file', timeout: 4000 }), true)
  assert.equal(answerMatches({ timeout: 4000, source: 'file' }, { timeout: '4000', source: 'file' }), false)
  assert.equal(answerMatches({ timeout: 4000, source: 'file' }, { timeout: 4000, source: 'file', why: 'extra' }), false)
  assert.equal(answerMatches({ file: 'src/rank.js', function: 'topScores' }, { file: '.\\src\\rank.js', function: 'topScores ' }), true)
  assert.equal(answerMatches({ file: 'src/rank.js', function: 'topScores' }, { file: 'src/rank.js', function: 'topscores' }), false)
})

test('the token bucket accepts only the clock rule its prompt states', async () => {
  const t = task('implementation-2')
  // A limiter that takes a clock going back as the time from which tokens count again.
  const naive = solution(t)[0].text.replace('if (t <= latest) return\n', 'if (t <= latest) { latest = t; return }\n')
  assert.notEqual(naive, solution(t)[0].text)
  const r = await graded(t, [{ path: 'src/limiter.js', text: naive }])
  assert.equal(r.passed, false)
  assert.match(r.reason, /a clock that goes backwards adds nothing until it passes the latest time again/)
})

test('whether a task fits a window: level 1 fits 12,288 tokens, level 2 needs about 16k, a level-3 task near its bound fits neither, and a cloud agent fits all', () => {
  const room = (window) => window - AGENT_PROMPT_TOKENS - TOOL_OUTPUT_TOKENS
  assert.equal(room(12_288), 1688)
  assert.equal(fitsWindow(LEVEL_TOKENS[1], 12_288), true)
  assert.equal(fitsWindow(LEVEL_TOKENS[2], 12_288), false)
  assert.equal(fitsWindow(LEVEL_TOKENS[2], 16_384), true)
  assert.equal(fitsWindow(5_900, 16_384), false)
  assert.equal(fitsWindow(5_900, 12_288), false)
  assert.equal(fitsWindow(LEVEL_TOKENS[3], null), true)
  for (const t of SET.tasks.filter((x) => x.level === 1)) assert.equal(fitsWindow(t.tokens, 12_288), true, t.id)
})

test('what an attempt came to: a timeout by its own signal, a limit, a process that did not close, an engine that loaded, an error, a stop and a refusal each read as themselves', () => {
  const rec = (a) => ({ attempts: [{ role: 'primary', stopReason: 'completed', ...a }] })
  assert.deepEqual(attemptOutcome({ record: rec({}), executed: [{}] }), { outcome: 'graded' })
  assert.equal(attemptOutcome({ record: rec({ stopReason: 'aborted' }), executed: [{ timedOut: true }] }, { timeLimit: 'the 20-minute limit' }).reason, 'it ran past the 20-minute limit')
  assert.equal(attemptOutcome({ record: rec({ stopReason: 'error' }), executed: [{ timedOut: true }] }).outcome, 'timed_out')
  assert.equal(attemptOutcome({ record: rec({ limitHit: true, stopReason: 'error', diagnostic: 'rate limit' }), executed: [{}] }).outcome, 'not_scored')
  assert.equal(attemptOutcome({ record: rec({}), executed: [{ disposeError: 'still running' }] }).outcome, 'errored')
  assert.equal(attemptOutcome({ record: rec({}), executed: [{ engine: { before: { loads: 1, unloads: 0 }, after: { loads: 2, unloads: 0 } } }] }).outcome, 'errored')
  assert.equal(attemptOutcome({ record: rec({}), executed: [{ engine: { before: { loads: 1, unloads: 0 }, after: { loads: 1, unloads: 0 } } }] }).outcome, 'graded')
  assert.equal(attemptOutcome({ record: rec({ stopReason: 'error', diagnostic: 'ECONNRESET' }), executed: [{}] }).reason, 'it ended in an error (ECONNRESET)')
  assert.equal(attemptOutcome({ error: new Error('claude is at its usage limit until 10:00') }).reason, 'claude is at its usage limit until 10:00')
  assert.equal(attemptOutcome({ error: new Error('boom'), executed: [{}] }).outcome, 'errored', 'a run that failed after its agent worked is the machine\'s')
  assert.equal(attemptOutcome({ record: rec({}), stoppedBy: 'person' }).outcome, 'not_scored')
  assert.equal(parseTap("TAP version 13\nnot ok 1 - slow\n  ---\n  error: 'took longer than 2 seconds'\n  ...\n# tests 1\n# pass 0\n# fail 1\n").failed[0], 'slow (took longer than 2 seconds)')
})

// ---------- the estimate, the plan and its confirmation (3.10, 3.11) ----------

test('each kind of agent is estimated from its last benchmark, else from its own runs with the benchmark\'s left out, else says it is not known; the gate, the limit and the peak hours are said', () => {
  const now = Date.parse('2026-09-25T00:30:00Z')
  const last = { at: '2026-09-24T12:00:00Z', tasks: 28, wallMs: 130 * 60_000, usageBefore: { windows: [{ name: 'weekly', minutes: 10080, usedPercent: 38 }], balance: { amount: 365.1, currency: 'CNY' } }, usageAfter: { windows: [{ name: 'weekly', minutes: 10080, usedPercent: 44 }], balance: { amount: 364.58, currency: 'CNY' } } }
  const local = estimateOf({ agent: { id: 'qwen-local' }, kind: 'local', runs: 20, fit: { fit: 19, total: 27 }, window: 16384, last, now })
  assert.deepEqual(local.lines, ['Free: runs on this PC. About 2 h 10 min by its last benchmark (24 Sep, 28 tasks).', "19 of 27 tasks fit this model's window of 16,384 tokens beside an agent's system prompt; the other 8 are not run, and record nothing."])
  const fresh = estimateOf({ agent: { id: 'qwen-local' }, kind: 'local', runs: 28, fit: { fit: 27, total: 27 }, window: 16384, other: { durations: [360_000, 300_000, 420_000], tokens: [] }, now })
  assert.match(fresh.lines[0], /^Free: runs on this PC\. How long it takes is not known until it has run once; its runs on your work took a median of 6 min each/)
  assert.equal(fresh.lines[1], "All 27 tasks fit this model's window of 16,384 tokens beside an agent's system prompt.")
  const sub = { account: { label: 'Claude' }, windows: [{ name: 'weekly', minutes: 10080, usedPercent: 82 }, { name: '5h', minutes: 300, usedPercent: 10 }] }
  const claude = estimateOf({ agent: { id: 'claude' }, kind: 'subscription', runs: 28, last, usage: sub, quota: { state: 'near', weeklyPercent: 82, summary: 'near: weekly 82%' }, gateAt: 80, now })
  assert.equal(claude.lines[0], 'Uses your Claude subscription. Weekly window at 82% now, 5-hour window at 10%.')
  assert.equal(claude.lines[1], 'The last benchmark on claude (24 Sep, 28 tasks) moved the weekly window from 38% to 44%; other use of the account in that time is in that figure too.')
  assert.deepEqual(claude.warnings, [
    'claude is past its weekly gate (82%, gate 80%): KzH keeps what is left of its window for reviews, and the benchmark would spend it.',
    'claude is near its limit (near: weekly 82%); it may stop partway, and then records nothing.',
  ])
  const unknown = estimateOf({ agent: { id: 'claude' }, kind: 'subscription', runs: 28, usage: sub, other: { durations: [], tokens: [41_000, 40_000, 42_000] }, now })
  assert.equal(unknown.lines[1], 'How much of the window 28 tasks take is not known until one benchmark has run; its runs on your work used a median of 41,000 tokens each (3 runs).')
  const none = estimateOf({ agent: { id: 'claude' }, kind: 'subscription', runs: 28, now })
  assert.equal(none.lines[1], 'How much of the window 28 tasks take is not known until one benchmark has run; KzH has no record yet of the tokens its runs use.')
  assert.equal(none.lines[2], 'How long it takes is not known until it has run once.')
  const peak = { windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }, { fromUtc: '06:00', toUtc: '10:00' }], daysUtc: [1, 2, 3, 4, 5] }
  const deepseek = estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last, usage: { account: { label: 'DEEPSEEK_API_KEY' }, balance: { amount: 364.02, currency: 'CNY' } }, peak, rateNow: 'off-peak rate right now: the cheapest it gets', now })
  assert.deepEqual(deepseek.lines, [
    'Paid from DEEPSEEK_API_KEY, balance 364.02 CNY.',
    'The last benchmark on deepseek (24 Sep, 28 tasks) took the balance from 365.10 to 364.58 CNY: 0.52 CNY.',
    'About 2 h 10 min by its last benchmark (24 Sep, 28 tasks).',
    'Off-peak rate right now: the cheapest it gets.',
    'Its peak rate, twice the off-peak price, applies from 01:00 to 04:00 and from 06:00 to 10:00 UTC on weekdays; at its estimated 2 h 10 min, a run started now would reach it at 01:00 UTC.',
  ])
  const unpriced = estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, usage: { account: { label: 'DEEPSEEK_API_KEY' }, balance: null }, other: { durations: [], tokens: [38_000, 38_000] }, peak, now })
  assert.equal(unpriced.lines[1], 'KzH has no price table for deepseek, so what 28 tasks cost is not known until one benchmark has run; its runs on your work used a median of 38,000 tokens each (2 runs), about 1.1 million tokens for 28 tasks.')
  assert.match(unpriced.lines.at(-1), /how long the run takes is not known, so it may reach it\.$/)
  const saturday = Date.parse('2026-09-26T09:00:00Z')
  assert.match(estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last, peak, now: saturday }).lines.at(-1), /a run started now would end before it\.$/)
  assert.equal(reachesPeak(peak, Date.parse('2026-09-28T05:30:00Z'), 60 * 60_000), Date.parse('2026-09-28T06:00:00Z'))
})

test('a subscription whose account is not known right now reads as your subscription, once', () => {
  const e = estimateOf({ agent: { id: 'claude', provider: 'claude-code' }, kind: 'subscription', runs: 28, usage: {} })
  assert.equal(e.lines[0], 'Uses your subscription. Its windows are not known right now.')
  const named = estimateOf({ agent: { id: 'claude', provider: 'claude-code' }, kind: 'subscription', runs: 28, usage: { account: { label: 'Claude' }, windows: [] } })
  assert.equal(named.lines[0], 'Uses your Claude subscription. Its windows are not known right now.')
})

test('the confirmation names everything a run deletes: each task folder once graded, keeping what the agent changed in it, and whatever appears elsewhere in the scratch root while a task runs, keeping only its path', () => {
  const body = confirmation({ picks: [{ id: 'claude', provider: 'claude-code' }], estimates: { claude: { lines: [], warnings: [] } }, runs: { claude: 28 }, timeoutMs: 20 * 60_000, leftovers: [], root: '/s', learn: true }).body
  assert.ok(body.includes('Each folder is deleted once its task is graded, and what the agent changed in its folder is kept with the result.'), body.join('\n'))
  assert.ok(body.includes('Anything that appears elsewhere in /s while a task runs is deleted, and fails that task; only its path is kept with the result.'), body.join('\n'))
})

test('the confirmation says what the run will do and spend, with learning on and with it off', () => {
  const picks = [{ id: 'claude', provider: 'claude-code' }, { id: 'codex', provider: 'codex' }]
  const estimates = { claude: { lines: ['Uses your Claude subscription.'], warnings: ['claude is near its limit.'] }, codex: { lines: ['Uses your ChatGPT subscription.'], warnings: [] } }
  const on = confirmation({ picks, estimates, runs: { claude: 28, codex: 28 }, timeoutMs: 20 * 60_000, leftovers: ['/s/a', '/s/b', '/s/c'], root: '/s', learn: true })
  assert.equal(on.title, 'Run the capability benchmark on 2 agents?')
  assert.equal(on.confirmLabel, 'Run on 2 agents')
  assert.deepEqual(on.body, [
    'Runs the first, one-file task, which is not scored, and 27 more on each of claude and codex, one task at a time, agent after agent, each in a new folder of the KzH scratch workspace, with the agent forced, at high effort (Codex at normal speed), one attempt, no retry and no review.',
    'A task that runs past the 20-minute limit counts as failed. One that ends in an error of the machine or the network is run once more, and a second error stops that agent with nothing recorded.',
    'Each folder is deleted once its task is graded, and what the agent changed in its folder is kept with the result.',
    'Anything that appears elsewhere in /s while a task runs is deleted, and fails that task; only its path is kept with the result.',
    'claude: Uses your Claude subscription.',
    'claude is near its limit.',
    'codex: Uses your ChatGPT subscription.',
    'The benchmark takes one slot under your Tasks at once budget like any run, so your own tasks may wait for a free slot.',
    'It first deletes 3 task folders an interrupted run left in /s.',
    "Results are recorded as capability evidence for every agent that finishes all its tasks: source benchmark, weighed at 0.7 of a run's own checks, a whole run counting on each dimension as three observations.",
  ])
  const off = confirmation({ picks: [picks[0]], estimates, runs: { claude: 28 }, timeoutMs: 20 * 60_000, leftovers: [], root: '/s', learn: false })
  assert.equal(off.title, 'Run the capability benchmark on 1 agent?')
  assert.equal(off.body[0], 'Runs the first, one-file task, which is not scored, and 27 more on claude, one task at a time, each in a new folder of the KzH scratch workspace, with the agent forced, at high effort, one attempt, no retry and no review.')
  assert.equal(off.body.at(-1), 'Learning is switched off, so the results are shown here and recorded nowhere else.')
  const parts = { taskSet: { id: 'k', version: '1', digest: 'd' }, picks: [{ id: 'a', kind: 'api', model: 'm', subject: 's', state: 'ok', gated: false, window: null }], learn: true, leftovers: [] }
  const { planKeyOf } = benchmarkModule
  assert.equal(typeof planKeyOf, 'function', 'benchmark.js has the plan key')
  assert.equal(planKeyOf(parts), planKeyOf(structuredClone(parts)))
  assert.notEqual(planKeyOf(parts), planKeyOf({ ...parts, taskSet: { id: 'k', version: '2', digest: 'e' } }), 'another task set is another plan')
  assert.equal(planChanges(parts, { ...parts, learn: false }), 'learning was switched off')
})

// ---------- the runner (3.8, 3.9), with a fake task runner over the real lanes ----------

/**
 * A benchmark over a task set of three tasks copied from the real one (the preflight, an answer and
 * a findings task, which grade without a node process each, unless `ids` names others), agents of
 * this test's own, and a fake task runner that does what `script(agent, task)` says in the task's
 * folder. The lanes are the real createLanes() with a cap of 1. `deps` replaces dependencies of the
 * runner, and `registryNow` is the capability registry's clock.
 */
function world({ agents, script, learn = true, window = 20_000, ids = ['preflight', 'investigation-1', 'review-1'], deps = {}, registryNow = undefined }) {
  const root = scratch('kzh-bench-world-')
  const tasksDir = join(root, 'tasks')
  for (const id of ids) cpSync(join(TASKS_DIR, id), join(tasksDir, id), { recursive: true })
  writeFileSync(join(tasksDir, 'task-set.json'), JSON.stringify({ id: 'kzh-capability', version: '1', digest: taskSetDigest(tasksDir), tasks: ids }))
  const set = loadTaskSet(tasksDir)
  const scratchRoot = join(root, 'scratch')
  mkdirSync(scratchRoot)
  const capabilities = createCapabilityRegistry({ file: join(root, 'capability-evidence.jsonl'), priors: PRIORS, policy: POLICY, ...(registryNow ? { now: registryNow } : {}) })
  const lanes = createLanes({ max: 1 })
  const seen = { order: [], concurrent: 0, most: 0, loads: [] }
  const owner = { session: { id: 's1', header: { cwd: scratchRoot } } }
  const runTask = async ({ agent, folder, prompt, signal, owner: o }) => {
    assert.equal(o, owner, 'every task runs under the scratch chat')
    const release = await lanes.acquire(folder.toLowerCase(), folder, signal)
    seen.concurrent++
    seen.most = Math.max(seen.most, seen.concurrent)
    try {
      const t = set.tasks.find((x) => x.prompt === prompt)
      seen.order.push(`${agent.id}:${t.id}`)
      const what = script(agent, t, seen)
      const record = (a = {}) => ({ attempts: [{ agent: agent.id, role: 'primary', stopReason: 'completed', model: agent.llm?.model ?? `${agent.id}-model`, durationMs: 7, checks: [], ...a }] })
      if (what === 'solve') await writeFiles(t.id === PREFLIGHT ? PREFLIGHT_SOLUTION() : t.solutions[0].files, folder)
      if (what === 'error') return { record: record({ stopReason: 'error', diagnostic: 'ECONNRESET' }), executed: [{}] }
      if (what === 'timeout') return { record: record({ stopReason: 'aborted' }), executed: [{ timedOut: true }] }
      if (what === 'limit') return { record: record({ stopReason: 'error', limitHit: true, diagnostic: 'usage limit' }), executed: [{}] }
      if (what === 'hang') { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { record: record({ stopReason: 'aborted' }), executed: [{}], stoppedBy: 'benchmark' } }
      if (what === 'outside') { await writeFiles(t.solutions[0].files, folder); writeFileSync(join(scratchRoot, 'stray.txt'), 'x') }
      // KzH stops while the agent works: it has written in its folder and, with paths from its own
      // working directory, beside it, and the task never ends.
      if (what === 'die') {
        await writeFiles(t.solutions[0].files, folder)
        mkdirSync(join(scratchRoot, 'src'), { recursive: true })
        writeFileSync(join(scratchRoot, 'src', 'answer.js'), 'export const half = 1\n')
        writeFileSync(join(scratchRoot, 'notes.txt'), 'half done\n')
        return new Promise(() => {})
      }
      return { record: record(), executed: [{ tokens: { input: 100, output: 20 } }] }
    } finally {
      seen.concurrent--
      release()
    }
  }
  const bench = createBenchmark({
    scratchRoot, file: join(root, 'benchmark.jsonl'), tasksDir,
    agents: async () => agents,
    readiness: async () => ({}),
    quota: async () => ({}),
    usage: async () => ({}),
    usageLines: async () => [],
    windowOf: () => window,
    subjectOf: (a) => ({ provider: a.llm?.provider ?? a.provider, family: null, model: a.llm?.model ?? `${a.id}-model`, version: a.llm?.model ?? `${a.id}-model` }),
    capabilities, priors: PRIORS, policy: POLICY,
    learn: () => learn,
    runTask,
    sessionAgent: (id) => (id === 's1' ? owner : null),
    listed: () => true,
    speedRunning: () => false,
    loadModel: async (a) => { seen.loads.push(a.id) },
    gateAt: () => 80,
    excludedBy: () => null,
    agentTimeoutMs: 20 * 60_000,
    ...deps,
  })
  const rows = () => (existsSync(join(root, 'benchmark.jsonl')) ? readFileSync(join(root, 'benchmark.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  const evidence = () => (existsSync(join(root, 'capability-evidence.jsonl')) ? readFileSync(join(root, 'capability-evidence.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  async function runAll(picks) {
    const { planId } = await bench.plan({ session: 's1', agents: picks })
    await bench.start({ session: 's1', agents: picks, planId })
    for (let i = 0; bench.running() && i < 2000; i++) await new Promise((r) => setTimeout(r, 10))
    return rows()
  }
  return { bench, root, scratchRoot, set, seen, rows, evidence, runAll, capabilities, tasksDir }
}
const cloud = (id) => ({ id, provider: 'codex', kind: 'subscription', enabled: true })
const localAgent = (id, model) => ({ id, provider: 'spawn', kind: 'local', enabled: true, llm: { provider: 'local', model } })

test('the runner runs one task at a time, the local agents first and each agent\'s tasks together, grades each in a folder it then deletes, and records a finished agent\'s results', async () => {
  const w = world({ agents: [cloud('cx'), localAgent('ql', 'qwen-test')], script: () => 'solve' })
  const rows = await w.runAll(['cx', 'ql'])
  assert.deepEqual(w.seen.order, ['ql:preflight', 'ql:investigation-1', 'ql:review-1', 'cx:preflight', 'cx:investigation-1', 'cx:review-1'])
  assert.equal(w.seen.most, 1, 'never two tasks at once')
  assert.deepEqual(w.seen.loads, ['ql', 'ql', 'ql'], 'the local model is loaded before each of its tasks')
  assert.deepEqual(rows.map((r) => r.type), ['run', 'folder', 'task', 'folder', 'task', 'folder', 'task', 'agent', 'folder', 'task', 'folder', 'task', 'folder', 'task', 'agent', 'end'])
  for (const t of rows.filter((r) => r.type === 'task')) {
    assert.equal(t.outcome, 'passed', `${t.agent} ${t.task}: ${t.reason}`)
    assert.equal(existsSync(join(w.scratchRoot, t.folder)), false, 'the folder is deleted once graded')
    assert.ok(rows.findIndex((r) => r.type === 'folder' && r.folder === t.folder) < rows.indexOf(t), 'its folder row is written before the agent starts')
  }
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.recorded]), [['ql', 'finished', 2], ['cx', 'finished', 2]])
  const ev = w.evidence()
  assert.ok(ev.every((e) => e.source === 'benchmark' && e.confidence === 0.9 && e.benchmark.id === 'kzh-capability' && e.benchmark.version === '1'))
  assert.deepEqual(ev.filter((e) => e.subject.model === 'qwen-test').map((e) => [e.note, e.dimension, e.score]), [['investigation-1', 'general_reasoning', 1], ['review-1', 'code_review', 1]])
  // What the card shows of it: a row per agent and dimension, and one per task.
  const state = await w.bench.state({ session: 's1' })
  assert.equal(state.where.state, 'scratch')
  assert.equal(state.last.status, 'finished')
  assert.equal(state.results.tasks.length, 6)
  const ql = state.results.dimensions.find((r) => r[0].text === 'ql' && r[2].value === 'code_review')
  assert.equal(ql[3].text, '100% (1 of 1)')
})

test('the runner stops an agent at a failed preflight, at a second error and at a limit, scores a timeout as a failure, runs an errored task again in a fresh folder, and records only what finished', async () => {
  const script = (agent, t, seen) => {
    if (agent.id === 'nopre' && t.id === PREFLIGHT) return 'nothing'
    if (agent.id === 'flaky' && t.id === 'investigation-1') return seen.order.filter((x) => x === 'flaky:investigation-1').length === 1 ? 'error' : 'solve'
    if (agent.id === 'broken' && t.id === 'investigation-1') return 'error'
    if (agent.id === 'limited' && t.id === 'review-1') return 'limit'
    if (agent.id === 'slow' && t.id === 'review-1') return 'timeout'
    return 'solve'
  }
  const w = world({ agents: ['nopre', 'flaky', 'broken', 'limited', 'slow'].map(cloud), script })
  const rows = await w.runAll(['nopre', 'flaky', 'broken', 'limited', 'slow'])
  const agentRow = (id) => rows.find((r) => r.type === 'agent' && r.agent === id)
  assert.equal(agentRow('nopre').status, 'preflight_failed')
  assert.match(agentRow('nopre').line, /^nopre could not do the first, one-file task \(.*hello\.txt was not written.*\): it has to run node in its folder\. Nothing else was run on it\.$/)
  assert.deepEqual(rows.filter((r) => r.type === 'task' && r.agent === 'nopre').map((r) => r.task), ['preflight'])
  const flaky = rows.filter((r) => r.type === 'task' && r.agent === 'flaky' && r.task === 'investigation-1')
  assert.deepEqual(flaky.map((r) => [r.outcome, r.rerun]), [['errored', false], ['passed', true]])
  assert.notEqual(flaky[0].folder, flaky[1].folder, 'run again in a fresh folder')
  assert.equal(agentRow('flaky').status, 'finished')
  assert.equal(agentRow('broken').status, 'errored')
  assert.equal(agentRow('broken').line, 'broken stopped at investigation-1: it ended in an error twice (it ended in an error (ECONNRESET)). Nothing is recorded for it.')
  assert.equal(agentRow('limited').status, 'not_scored')
  assert.match(agentRow('limited').line, /^limited stopped at review-1: it reached its usage limit \(usage limit\)\. Nothing is recorded for it\.$/)
  const slow = rows.find((r) => r.type === 'task' && r.agent === 'slow' && r.task === 'review-1')
  assert.equal(slow.outcome, 'timed_out')
  assert.equal(agentRow('slow').status, 'finished')
  const byModel = (m) => w.evidence().filter((e) => e.subject.model === m)
  assert.deepEqual(byModel('nopre-model'), [])
  assert.deepEqual(byModel('broken-model'), [])
  assert.deepEqual(byModel('limited-model'), [])
  assert.deepEqual(byModel('slow-model').map((e) => [e.note, e.score]), [['investigation-1', 1], ['review-1', 0]], 'a timeout is scored as a failure')
  assert.equal(byModel('flaky-model').length, 2)
})

test('a task that does not fit a local model\'s window is not run and records nothing, and what the card says of it says so: the estimate, the confirmation, the agent\'s line and the tables', async () => {
  // Room for 450 tokens of task: the preflight and review-1 fit it, investigation-1 does not.
  const window = AGENT_PROMPT_TOKENS + TOOL_OUTPUT_TOKENS + 450
  const w = world({ agents: [localAgent('tiny', 'tiny-model'), cloud('cx')], script: () => 'solve', window })
  assert.deepEqual(w.set.tasks.map((t) => [t.id, t.tokens <= 450]), [[PREFLIGHT, true], ['investigation-1', false], ['review-1', true]], JSON.stringify(w.set.tasks.map((t) => [t.id, t.tokens])))
  const { confirm } = await w.bench.plan({ session: 's1', agents: ['tiny', 'cx'] })
  const w0 = window.toLocaleString('en-US')
  assert.ok(confirm.body[0].endsWith(' A local model runs fewer: a task that does not fit its window is not run, and records nothing.'), confirm.body[0])
  assert.ok(confirm.body.includes(`tiny: Free: runs on this PC. How long it takes is not known until it has run once. 1 of 2 tasks fit this model's window of ${w0} tokens beside an agent's system prompt; the other 1 is not run, and records nothing.`), confirm.body.join('\n'))
  const rows = await w.runAll(['tiny'])
  assert.deepEqual(rows.filter((r) => r.type === 'task').map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['investigation-1', 'did_not_fit'], ['review-1', 'passed']])
  assert.ok(!w.seen.order.includes('tiny:investigation-1'), 'never run')
  assert.deepEqual(w.evidence().map((e) => [e.note, e.dimension]), [['review-1', 'code_review']], 'nothing of the task that did not fit, and no long context')
  const agent = rows.find((r) => r.type === 'agent')
  assert.deepEqual([agent.status, agent.recorded, agent.line], ['finished', 1, `tiny finished: recorded 1 of 2 tasks as evidence; 1 did not fit its window of ${w0} tokens and was not run.`])
  const { results } = await w.bench.state({ session: 's1' })
  assert.deepEqual(results.dimensions.map((r) => r[2].text), ['code review'])
  assert.deepEqual(results.tasks.map((r) => [r[1].text, r[2].text]), [['preflight', 'passed'], ['investigation-1', 'did not fit'], ['review-1', 'passed']])
})

test('a read of the card that the end of a run overtakes reads the log as the run left it, never an interrupted run that finished', async () => {
  // The card's usage read waits, as a slow provider's may for up to 4 seconds, until the run has ended.
  const held = { bench: null, on: false }
  const usage = async (list, { force = false } = {}) => { if (held.on && !force) await waitFor(() => !held.bench.running()); return {} }
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { usage } })
  held.bench = w.bench
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await w.bench.start({ session: 's1', agents: ['cx'], planId })
  held.on = true
  const s = await w.bench.state({ session: 's1' })
  assert.equal(s.run, null, 'the run had ended by the time the card was answered')
  assert.deepEqual([s.last.status, s.last.lines], ['finished', ['cx finished: recorded 2 tasks as evidence.']])
  assert.equal(s.results.tasks.length, 3)
})

test('with learning off a run that finishes records nothing: the results are on the card and nowhere else, as the confirmation says', async () => {
  const w = world({ agents: [cloud('cx')], script: () => 'solve', learn: false })
  const { confirm } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  assert.equal(confirm.body.at(-1), 'Learning is switched off, so the results are shown here and recorded nowhere else.')
  const rows = await w.runAll(['cx'])
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.recorded, r.line]), [['cx', 'finished', 0, 'cx finished: not recorded, learning is off.']])
  assert.deepEqual(w.evidence(), [], 'nothing in capability-evidence.jsonl')
  const { results } = await w.bench.state({ session: 's1' })
  assert.ok(results.dimensions.length && results.dimensions.every((r) => /^not recorded \(\d+\.\d had it been\)$/.test(r[4].text)), results.dimensions.map((r) => r[4].text).join('; '))
})

test('the tasks table holds the tasks behind every dimension row: each agent\'s last finished run, and beside it a later run that did not finish, marked as not recorded', async () => {
  let hang = false
  const w = world({ agents: [cloud('cx')], script: (agent, t) => (hang && t.id === 'review-1' ? 'hang' : 'solve') })
  await w.runAll(['cx'])
  hang = true
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await w.bench.start({ session: 's1', agents: ['cx'], planId })
  await waitFor(() => w.seen.order.filter((x) => x === 'cx:review-1').length === 2)
  w.bench.stop()
  await waitFor(() => !w.bench.running())
  const { results } = await w.bench.state({ session: 's1' })
  assert.deepEqual(results.dimensions.map((r) => [r[0].text, r[2].text, r[3].text]), [['cx', 'general reasoning', '100% (1 of 1)'], ['cx', 'code review', '100% (1 of 1)']], 'from the run that finished')
  const cellOf = (row, i) => row[i].text
  const runs = results.tasks.map((r) => [cellOf(r, 1), cellOf(r, 2), cellOf(r, r.length - 1).replace(/^\d+ [A-Z][a-z]{2}(?: \d{4})?, /, '')])
  assert.deepEqual(runs, [
    ['preflight', 'passed', 'version 1'], ['investigation-1', 'passed', 'version 1'], ['review-1', 'passed', 'version 1'],
    ['preflight', 'passed', 'version 1, stopped; not recorded'], ['investigation-1', 'passed', 'version 1, stopped; not recorded'], ['review-1', 'not scored', 'version 1, stopped; not recorded'],
  ])
})

test('while the runner reads an agent\'s usage before its first task and after its last, its progress says which, not that it is starting', async () => {
  const gates = []
  const usage = async (list, { force = false } = {}) => { if (force) await new Promise((open) => gates.push(open)); return {} }
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { usage } })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await w.bench.start({ session: 's1', agents: ['cx'], planId })
  const at = async () => { const a = (await w.bench.state({ session: 's1' })).run.agents[0]; return [a.status, a.task, a.phase] }
  await waitFor(() => gates.length === 1)
  assert.deepEqual(await at(), ['running', null, 'spend-before'])
  gates.shift()()
  await waitFor(() => gates.length === 1)
  assert.deepEqual(await at(), ['running', null, 'spend-after'])
  assert.deepEqual(w.seen.order, ['cx:preflight', 'cx:investigation-1', 'cx:review-1'], 'after its last task')
  gates.shift()()
  await waitFor(() => !w.bench.running())
})

test('each pick\'s last run gives its day as the card writes every date, and how its queue ended in words', async () => {
  const clock = Date.parse('2026-09-26T10:00:00.000Z')
  const script = (agent, t) => (agent.id === 'second' && t.id === 'investigation-1' ? 'hang' : 'solve')
  const w = world({ agents: ['first', 'second', 'third'].map(cloud), script, deps: { now: () => clock } })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['first', 'second', 'third'] })
  await w.bench.start({ session: 's1', agents: ['first', 'second', 'third'], planId })
  await waitFor(() => w.seen.order.includes('second:investigation-1'))
  w.bench.stop()
  await waitFor(() => !w.bench.running())
  const picks = (await w.bench.state({ session: 's1' })).agents
  assert.deepEqual(picks.map((a) => [a.id, a.lastRun.day, a.lastRun.version, a.lastRun.statusText]), [
    ['first', '26 Sep', '1', 'finished'], ['second', '26 Sep', '1', 'stopped'], ['third', '26 Sep', '1', 'not run'],
  ])
})

test('a dimension with no prior gives its weight with no prior to set it against, never a prior of 0.0', async () => {
  // A local model has no prior for instruction following, which simple_change-1 credits.
  const w = world({ agents: [localAgent('ql', 'qwen-test')], script: () => 'solve', ids: ['preflight', 'simple_change-1', 'review-1'] })
  await w.runAll(['ql'])
  const rows = (await w.bench.state({ session: 's1' })).results.dimensions
  const none = rows.filter((r) => r[5].text === 'none')
  assert.ok(none.length > 0, rows.map((r) => r.map((c) => c.text).join(' | ')).join('\n'))
  for (const r of none) assert.match(r[4].text, /^\d+\.\d, with no prior$/, r[2].text)
})

test('the confirmation and the progress count the first, one-file task apart, since it is not scored', async () => {
  const picks = [{ id: 'claude', provider: 'claude-code' }, { id: 'ql', provider: 'spawn' }]
  const estimates = { claude: { lines: [], warnings: [] }, ql: { lines: [], warnings: [] } }
  const confirm = (runs, list = picks) => confirmation({ picks: list, estimates, runs, timeoutMs: 20 * 60_000, leftovers: [], root: '/s', learn: true }).body[0]
  assert.match(confirm({ claude: 28 }, [picks[0]]), /^Runs the first, one-file task, which is not scored, and 27 more on claude, one task at a time, /)
  assert.match(confirm({ claude: 28, ql: 28 }), /^Runs the first, one-file task, which is not scored, and 27 more on each of claude and ql, /)
  assert.match(confirm({ claude: 28, ql: 20 }), /^Runs the first, one-file task, which is not scored, and up to 27 more on each of claude and ql, /)
  const w = world({ agents: [cloud('cx')], script: (agent, t) => (t.id === 'investigation-1' ? 'hang' : 'solve') })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await w.bench.start({ session: 's1', agents: ['cx'], planId })
  await waitFor(() => w.seen.order.includes('cx:investigation-1'))
  const a = (await w.bench.state({ session: 's1' })).run.agents[0]
  assert.deepEqual([a.first, a.done, a.total, a.passed, a.failed], ['passed', 0, 2, 0, 0], 'the first task passed, and none of the 2 scored tasks is done')
  w.bench.stop()
  await waitFor(() => !w.bench.running())
})

test('what an estimate says of an agent\'s runs on your work leaves out the benchmark\'s own attempts', async () => {
  const mine = { agent: 'cx', role: 'primary', stopReason: 'completed', durationMs: 6 * 60_000, tokens: { input: 30_000, output: 11_000 } }
  const bench = { ...mine, purpose: 'benchmark', durationMs: 60_000, tokens: { input: 900, output: 100 } }
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { usageLines: async () => [mine, mine, mine, bench, bench, bench, bench, bench] } })
  const { confirm } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  const line = confirm.body.find((l) => l.startsWith('cx: '))
  assert.ok(line.includes('its runs on your work used a median of 41,000 tokens each (3 runs)'), line)
  assert.ok(line.includes('its runs on your work took a median of 6 min each'), line)
})

test('a scratch root too big to check what an agent writes outside its folder runs no task: the task is not scored, and says why', async () => {
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { listCap: 3 } })
  for (let i = 0; i < 5; i++) writeFileSync(join(w.scratchRoot, `kept-${i}.txt`), 'x\n')
  const rows = await w.runAll(['cx'])
  assert.deepEqual(w.seen.order, [], 'no agent was started')
  const why = `the scratch root ${w.scratchRoot} holds more than 3 entries beside the task's folder, too many to check what its agent writes outside it`
  assert.deepEqual(rows.filter((r) => r.type === 'task').map((r) => [r.task, r.outcome, r.reason]), [['preflight', 'not_scored', why]])
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.status, r.line]), [['not_scored', `cx stopped at preflight: ${why}. Nothing is recorded for it.`]])
  assert.equal(readdirSync(w.scratchRoot).filter((n) => n.startsWith('kept-')).length, 5, 'nothing of it was deleted')
})

test('a task row with no time or tokens has blank cells that a sort puts last, while a word such as none or not recorded sorts low', async () => {
  const w = world({ agents: [localAgent('tiny', 'tiny-model')], script: () => 'solve', window: AGENT_PROMPT_TOKENS + TOOL_OUTPUT_TOKENS + 450 })
  await w.runAll(['tiny'])
  const { results } = await w.bench.state({ session: 's1' })
  const unrun = results.tasks.find((r) => r[1].text === 'investigation-1')
  assert.deepEqual([unrun[6], unrun[7]], [{ text: '', value: null }, { text: '', value: null }], 'a blank is null, which the table rule sorts last either way')
  const ran = results.tasks.find((r) => r[1].text === 'review-1')
  assert.equal(typeof ran[6].value, 'number')
  assert.equal(typeof ran[7].value, 'number')
})

test('a local agent whose window cannot hold even the first task cannot be picked: the card says why, its estimate promises nothing, and a plan is refused', async () => {
  // Room for 40 tokens of task beside an agent's system prompt: not even the preflight fits.
  const window = AGENT_PROMPT_TOKENS + TOOL_OUTPUT_TOKENS + 40
  const w = world({ agents: [localAgent('tiny', 'tiny-model'), cloud('cx')], script: () => 'solve', window })
  assert.ok(w.set.preflight.tokens > 40, `the preflight is ${w.set.preflight.tokens} tokens`)
  const why = `tiny cannot hold even the first, one-file task beside an agent's system prompt in its window of ${window.toLocaleString('en-US')} tokens`
  const tiny = (await w.bench.state({ session: 's1' })).agents.find((a) => a.id === 'tiny')
  assert.deepEqual([tiny.can, tiny.why], [false, why])
  assert.ok(!tiny.estimate.some((l) => /tasks? fits?|long context/.test(l)), tiny.estimate.join(' '))
  await assert.rejects(w.bench.plan({ session: 's1', agents: ['tiny', 'cx'] }), (err) => err.status === 400 && err.message === why)
  assert.deepEqual(w.rows(), [], 'nothing ran')
})

test('a stop records nothing for the agent under way or those after it, while one that finished keeps its results; a run with no end row reads as interrupted after a reload', async () => {
  const script = (agent, t) => (agent.id === 'second' && t.id === 'investigation-1' ? 'hang' : 'solve')
  const w = world({ agents: ['first', 'second', 'third'].map(cloud), script })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['first', 'second', 'third'] })
  await w.bench.start({ session: 's1', agents: ['first', 'second', 'third'], planId })
  for (let i = 0; !w.seen.order.includes('second:investigation-1') && i < 1000; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(w.bench.localPending() === false, 'no local agent here')
  await assert.rejects(w.bench.start({ session: 's1', agents: ['first'], planId }), (err) => err.status === 409 && /already running/.test(err.message))
  w.bench.stop()
  for (let i = 0; w.bench.running() && i < 1000; i++) await new Promise((r) => setTimeout(r, 10))
  const rows = w.rows()
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status]), [['first', 'finished'], ['second', 'stopped'], ['third', 'not_run']])
  assert.equal(rows.at(-1).type, 'end')
  assert.equal(rows.at(-1).status, 'stopped')
  assert.deepEqual([...new Set(w.evidence().map((e) => e.subject.model))], ['first-model'])
  // A run KzH did not see to its end: a run row, a folder row and no task or end row.
  const log = join(w.root, 'benchmark.jsonl')
  mkdirSync(join(w.scratchRoot, 'abcdef012345'))
  writeFileSync(log, `${readFileSync(log, 'utf8')}${JSON.stringify({ type: 'run', runId: 'bench-cut', ts: '2026-09-25T10:00:00Z', picks: [] })}\n${JSON.stringify({ type: 'folder', runId: 'bench-cut', agent: 'first', task: 'preflight', folder: 'abcdef012345' })}\n`)
  const again = createBenchmark({ ...benchDeps(w), file: log })
  const state = await again.state({ session: 's1' })
  assert.equal(state.last.status, 'interrupted')
  assert.equal(state.leftovers, 1)
  const { planId: next, confirm } = await again.plan({ session: 's1', agents: ['first'] })
  assert.ok(confirm.body.includes(`It first deletes 1 task folder an interrupted run left in ${w.scratchRoot}.`))
  // Only the folder of the interrupted task is deleted at the start, nothing else in the scratch root.
  mkdirSync(join(w.scratchRoot, 'keep-me'))
  await again.start({ session: 's1', agents: ['first'], planId: next })
  assert.equal(existsSync(join(w.scratchRoot, 'abcdef012345')), false)
  assert.equal(existsSync(join(w.scratchRoot, 'keep-me')), true)
  for (let i = 0; again.running() && i < 1000; i++) await new Promise((r) => setTimeout(r, 10))
})

/** The dependencies of a world's benchmark, to build a second one over the same files. */
function benchDeps(w) {
  return {
    scratchRoot: w.scratchRoot, tasksDir: w.tasksDir, agents: async () => ['first', 'second', 'third'].map(cloud), readiness: async () => ({}), quota: async () => ({}), usage: async () => ({}), usageLines: async () => [],
    windowOf: () => null, subjectOf: (a) => ({ provider: a.provider, family: null, model: `${a.id}-model`, version: `${a.id}-model` }), capabilities: w.capabilities, priors: PRIORS, policy: POLICY, learn: () => true,
    runTask: async ({ folder, prompt, agent }) => { const t = w.set.tasks.find((x) => x.prompt === prompt); await writeFiles(t.id === PREFLIGHT ? PREFLIGHT_SOLUTION() : t.solutions[0].files, folder); return { record: { attempts: [{ agent: agent.id, role: 'primary', stopReason: 'completed', model: `${agent.id}-model` }] }, executed: [{}] } },
    sessionAgent: (id) => (id === 's1' ? { session: { header: { cwd: w.scratchRoot } } } : null), listed: () => true, speedRunning: () => false, loadModel: async () => {}, gateAt: () => 80, excludedBy: () => null, agentTimeoutMs: 20 * 60_000,
  }
}

test('the plan: refused outside the scratch workspace, for a pick that cannot run and for two picks of one model; a confirmed plan starts through a moved balance and is refused when a state, a model, a version or a window moved', async () => {
  const w = world({ agents: [cloud('a'), cloud('b'), localAgent('l', 'lm')], script: () => 'solve' })
  let quota = { a: { state: 'ok' }, b: { state: 'ok' } }
  let usage = { a: { balance: { amount: 10, currency: 'USD' } } }
  let window = 16_384
  let model = 'model-1'
  const deps = { ...benchDeps(w), file: join(w.root, 'plan.jsonl'), agents: async () => [cloud('a'), cloud('b'), localAgent('l', 'lm')], quota: async () => quota, usage: async () => usage, windowOf: () => window, subjectOf: (a) => ({ provider: a.provider, family: null, model: a.id === 'a' ? model : `${a.id}-m`, version: a.id === 'a' ? model : `${a.id}-m` }) }
  const bench = createBenchmark(deps)
  const plan1 = () => bench.plan({ session: 's1', agents: ['a', 'l'] })
  /** A plan confirmed, then `move` before its start: refused, saying what moved. */
  const movedUnder = async (move, what) => {
    const { planId } = await plan1()
    const undo = move()
    await assert.rejects(bench.start({ session: 's1', agents: ['a', 'l'], planId }), (err) => err.status === 409 && err.message.startsWith('What the benchmark would run or spend changed since you confirmed it (') && err.message.includes(what), what)
    undo()
  }
  await movedUnder(() => { quota = { a: { state: 'near', summary: 'near' } }; return () => { quota = { a: { state: 'ok' } } } }, "a's usage went from ok to near")
  await movedUnder(() => { window = 12_288; return () => { window = 16_384 } }, "l's window changed from 16,384 to 12,288 tokens")
  await movedUnder(() => { model = 'model-2'; return () => { model = 'model-1' } }, "a's model changed from model-1 to model-2")
  await assert.rejects(bench.start({ session: 's1', agents: ['a', 'l'], planId: 'not-this' }), (err) => err.status === 409 && /KzH did not give it/.test(err.message))
  // A balance moves by the minute and is not in the plan: the confirmed plan starts.
  const { planId: confirmed } = await plan1()
  usage = { a: { balance: { amount: 9.5, currency: 'USD' } } }
  assert.match((await bench.start({ session: 's1', agents: ['a', 'l'], planId: confirmed })).runId, /^bench-[0-9a-f]{12}$/)
  await waitFor(() => !bench.running())
  await assert.rejects(bench.plan({ session: 'elsewhere', agents: ['a'] }), (err) => err.status === 400 && err.message === 'This chat is not loaded in the engine; send any message in it, then try again.')
  const other = createBenchmark({ ...deps, sessionAgent: () => ({ session: { header: { cwd: w.root } } }) })
  await assert.rejects(other.plan({ session: 's1', agents: ['a'] }), (err) => err.status === 400 && /runs only from a chat in the KzH scratch workspace/.test(err.message))
  const refusing = createBenchmark({ ...deps, readiness: async () => ({ b: { loggedIn: false, detail: 'not signed in' } }) })
  await assert.rejects(refusing.plan({ session: 's1', agents: ['a', 'b'] }), (err) => err.status === 400 && err.message === 'b cannot run: not signed in')
  const twins = createBenchmark({ ...deps, subjectOf: (a) => ({ provider: 'codex', family: 'openai-gpt', model: 'gpt-5', version: 'gpt-5' }) })
  await assert.rejects(twins.plan({ session: 's1', agents: ['a', 'b'] }), (err) => err.status === 400 && err.message === 'a and b both run openai-gpt gpt-5, and one run records one set of results per model; pick one of them.')
  await assert.rejects(bench.plan({ session: 's1', agents: [] }), (err) => err.status === 400)
  const speeding = createBenchmark({ ...deps, speedRunning: () => true })
  const plan = await speeding.plan({ session: 's1', agents: ['a', 'l'] })
  await assert.rejects(speeding.start({ session: 's1', agents: ['a', 'l'], planId: plan.planId }), (err) => err.status === 409 && err.message === 'A speed benchmark is running; start this when it has finished, or leave the local agents out.')
  const learnOff = createBenchmark({ ...deps, learn: () => false })
  assert.equal((await learnOff.plan({ session: 's1', agents: ['a'] })).confirm.body.at(-1), 'Learning is switched off, so the results are shown here and recorded nowhere else.')
})

test('a plan id starts one run, of the plan /plan gave it with, within 30 minutes: a replayed id, an id /plan never gave and an old one are refused and run nothing', async () => {
  let clock = Date.parse('2026-09-26T10:00:00.000Z')
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { now: () => clock } })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await w.bench.start({ session: 's1', agents: ['cx'], planId })
  await waitFor(() => !w.bench.running())
  const ran = w.seen.order.length
  const refused = (err) => err.status === 409 && err.message === 'This confirmation cannot start a run: KzH did not give it, or it has already started one; review it again.'
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx'], planId }), refused, 'the same id again, after its run')
  // An id worked out from what the plan covers, as anyone could from the card, is none /plan gave.
  const parts = { taskSet: { id: w.set.id, version: w.set.version, digest: w.set.digest }, picks: [{ id: 'cx', kind: 'subscription', model: 'cx-model', subject: 'codex|cx-model|cx-model', state: 'unknown', gated: false, window: null }], learn: true, leftovers: [], strays: [] }
  const computed = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx'], planId: computed }), refused, 'an id worked out, not given')
  const late = await w.bench.plan({ session: 's1', agents: ['cx'] })
  clock += 31 * 60_000
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx'], planId: late.planId }), (err) => err.status === 409 && err.message === 'This confirmation cannot start a run: it is over 30 minutes old; review it again.')
  assert.equal(w.seen.order.length, ran, 'nothing more ran')
  assert.equal(w.rows().filter((r) => r.type === 'run').length, 1)
})

test('a scratch folder whose path holds the account name says that every task\'s prompt sends it to the agent, and one that does not says nothing of it', async () => {
  const w = world({ agents: [cloud('a')], script: () => 'solve' })
  const user = userInfo().username
  const withName = join(scratch('kzh-bench-home-'), user, 'kzh-scratch')
  mkdirSync(withName, { recursive: true })
  const named = createBenchmark({ ...benchDeps(w), file: join(w.root, 'named.jsonl'), scratchRoot: withName, sessionAgent: () => ({ session: { header: { cwd: withName } } }) })
  const where = (await named.state({ session: 's1' })).where
  assert.deepEqual([where.state, where.accountText], ['scratch', `This path holds your ${process.platform === 'win32' ? 'Windows ' : ''}account name, and every task's prompt sends it to the agent.`])
  // The other way round, asked of the same folder: nothing is said when the name is not in it.
  // The name is read through the seam rather than the path being chosen to avoid it, because on
  // Windows there is no writable temporary folder outside the account's own to choose. The real
  // scratch root is C:\kzh-scratch, which holds no name, so the quiet case is the ordinary one.
  const other = createBenchmark({ ...benchDeps(w), file: join(w.root, 'other.jsonl'), scratchRoot: withName, sessionAgent: () => ({ session: { header: { cwd: withName } } }), accountName: () => 'somebody-else-entirely' })
  assert.equal((await other.state({ session: 's1' })).where.accountText, null, `${withName} does not hold somebody-else-entirely`)
  // And it matches a whole folder name, never a fragment of one: a user called `a` must not make
  // every path on the machine look like a leak.
  const fragment = createBenchmark({ ...benchDeps(w), file: join(w.root, 'frag.jsonl'), scratchRoot: withName, sessionAgent: () => ({ session: { header: { cwd: withName } } }), accountName: () => user.slice(0, 1) })
  assert.equal((await fragment.state({ session: 's1' })).where.accountText, null, 'one letter of the name is not the name')
})

test('a scratch folder inside a git repository is refused, where an agent would take the repository for its project', async () => {
  const w = world({ agents: [cloud('a')], script: () => 'solve' })
  const repo = scratch('kzh-repo-')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const inside = join(repo, 'kzh-scratch')
  const bench = createBenchmark({ ...benchDeps(w), file: join(w.root, 'x.jsonl'), scratchRoot: inside, sessionAgent: () => ({ session: { header: { cwd: inside } } }) })
  const state = await bench.state({ session: 's1' })
  assert.equal(state.where.state, 'in_git')
  assert.match(state.where.text, /^The KzH scratch folder .*kzh-scratch is inside the git repository .*, where an agent would take that repository for its project\.$/)
  await assert.rejects(bench.plan({ session: 's1', agents: ['a'] }), (err) => err.status === 400 && err.message === state.where.text)
})

// ---------- what a run records, and the edges of a run (3.5, 3.7 to 3.10) ----------

/** Waits until `ok()` holds, polling every 10 ms, for at most 20 seconds. */
async function waitFor(ok) {
  for (let i = 0; !ok() && i < 2000; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(ok(), 'still not true after 20 seconds')
}

test('an agent row counts the evidence rows it recorded, and each task row names the subject its attempt ran as, which the evidence records', async () => {
  const w = world({ agents: [cloud('cx')], script: () => 'solve', ids: ['preflight', 'debugging-1', 'investigation-1'] })
  const rows = await w.runAll(['cx'])
  const evidence = w.evidence()
  assert.equal(evidence.length, 4, 'debugging-1 credits three dimensions and investigation-1 one')
  const agentRow = rows.find((r) => r.type === 'agent')
  assert.equal(agentRow.recorded, evidence.length)
  assert.equal(agentRow.line, 'cx finished: recorded 2 tasks as evidence.')
  const taskRows = rows.filter((r) => r.type === 'task')
  assert.equal(taskRows.length, 3)
  for (const t of taskRows) assert.deepEqual(t.subject, evidence[0].subject, t.task)
})

test('each evidence row carries the time its task ended by the runner\'s clock, not the time the agent\'s queue was recorded', async () => {
  let tick = 0
  const w = world({ agents: [cloud('cx')], script: () => 'solve', deps: { now: () => Date.parse('2026-09-24T10:00:00Z') + (tick++) * 1000 }, registryNow: () => Date.parse('2026-09-25T12:00:00Z') })
  const rows = await w.runAll(['cx'])
  const ended = Object.fromEntries(rows.filter((r) => r.type === 'task').map((r) => [r.task, r.ts]))
  assert.match(ended['investigation-1'], /^2026-09-24T10:/)
  assert.notEqual(ended['investigation-1'], ended['review-1'])
  assert.deepEqual(w.evidence().map((e) => [e.note, e.ts]), [['investigation-1', ended['investigation-1']], ['review-1', ended['review-1']]])
})

test('a metered agent whose last benchmark left no balance reading says so, and gives the tokens per task of that benchmark before those of its other work', async () => {
  const now = Date.parse('2026-09-25T00:30:00Z')
  const last = { at: '2026-09-24T10:00:00Z', tasks: 28, wallMs: 3 * 3_600_000, tokens: [30_000, 40_000, 50_000], usageBefore: { balance: null }, usageAfter: { balance: null } }
  const usage = { account: { label: 'DEEPSEEK_API_KEY' }, balance: { amount: 364.02, currency: 'CNY' } }
  const other = { durations: [], tokens: [38_000] }
  assert.deepEqual(estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last, other, usage, now }).lines, [
    'Paid from DEEPSEEK_API_KEY, balance 364.02 CNY.',
    'The last benchmark on deepseek (24 Sep, 28 tasks) left no reading of the balance before and after it, and KzH has no price table for deepseek, so what 28 tasks cost is not known; that benchmark used a median of 40,000 tokens per task, about 1.1 million tokens for 28 tasks.',
    'About 3 h by its last benchmark (24 Sep, 28 tasks).',
  ])
  assert.equal(estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last: { ...last, tokens: [] }, other, usage, now }).lines[1],
    'The last benchmark on deepseek (24 Sep, 28 tasks) left no reading of the balance before and after it, and KzH has no price table for deepseek, so what 28 tasks cost is not known; KzH has no record of the tokens it used; its runs on your work used a median of 38,000 tokens each (1 run), about 1.1 million tokens for 28 tasks.')
  assert.equal(estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last: { ...last, tokens: [] }, usage, now }).lines[1],
    'The last benchmark on deepseek (24 Sep, 28 tasks) left no reading of the balance before and after it, and KzH has no price table for deepseek, so what 28 tasks cost is not known; KzH has no record of the tokens it used, nor of the tokens its other runs use.')
  const twoCurrencies = { ...last, usageBefore: { balance: { amount: 10, currency: 'USD' } }, usageAfter: { balance: { amount: 70, currency: 'CNY' } } }
  assert.match(estimateOf({ agent: { id: 'deepseek' }, kind: 'api', runs: 28, last: twoCurrencies, usage, now }).lines[1], /^The last benchmark on deepseek \(24 Sep, 28 tasks\) read the balance in USD before it and in CNY after it, and KzH has no price table/)
  assert.equal(estimateOf({ agent: { id: 'claude' }, kind: 'subscription', runs: 28, last, usage: { account: { label: 'Claude' }, windows: [] }, now }).lines[1],
    'The last benchmark on claude (24 Sep, 28 tasks) left no reading of the weekly window before and after it, so what 28 tasks take of it is not known; that benchmark used a median of 40,000 tokens per task, about 1.1 million tokens for 28 tasks.')

  // The runner hands the estimate the tokens of the last complete run, one figure per attempt.
  const w = world({ agents: [{ id: 'ds', provider: 'spawn', kind: 'api', enabled: true, llm: { provider: 'deepseek', model: 'ds-model' } }], script: () => 'solve' })
  await w.runAll(['ds'])
  const { confirm } = await w.bench.plan({ session: 's1', agents: ['ds'] })
  const line = confirm.body.find((l) => l.startsWith('ds: '))
  assert.match(line, /The last benchmark on ds \(\d+ \w+, 3 tasks\) left no reading of the balance before and after it, and KzH has no price table for ds, so what 3 tasks cost is not known; that benchmark used a median of 100 tokens per task, about 400 tokens for 3 tasks\./)
})

test('a start whose log cannot be written is refused with that reason and leaves nothing running, so the next start and the speed benchmark are not held', async () => {
  const w = world({ agents: [cloud('cx'), localAgent('ql', 'q')], script: () => 'solve' })
  // A folder where the log goes: appending to it fails, as a locked or full disk would.
  mkdirSync(join(w.root, 'benchmark.jsonl'))
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx', 'ql'] })
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx', 'ql'], planId }), (err) => err.status === 500 && /^The benchmark did not start: the benchmark's log could not be written \(.+\)\.$/.test(err.message))
  assert.equal(w.bench.running(), false)
  assert.equal(w.bench.localPending(), false, 'the speed benchmark is not refused for it')
  const state = await w.bench.state({ session: 's1' })
  assert.equal(state.run, null)
  const again = await w.bench.plan({ session: 's1', agents: ['cx'] })
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx'], planId: again.planId }), (err) => err.status === 500, 'refused for the log again, not as a run already going')
  assert.deepEqual(w.seen.order, [], 'no agent was started')
})

test('a log that cannot be written partway ends the run there: the folder no row names is deleted, and the card says why rather than that KzH stopped', async () => {
  let w = null
  let loads = 0
  // The log becomes a folder as the local agent's second task begins, before its folder row.
  const loadModel = async () => { if (++loads === 2) { const log = join(w.root, 'benchmark.jsonl'); rmSync(log); mkdirSync(log) } }
  w = world({ agents: [cloud('cx'), localAgent('ql', 'q')], script: () => 'solve', deps: { loadModel } })
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx', 'ql'] })
  await w.bench.start({ session: 's1', agents: ['cx', 'ql'], planId })
  await waitFor(() => !w.bench.running())
  assert.equal(w.bench.localPending(), false)
  assert.deepEqual(w.seen.order, ['ql:preflight'], 'nothing ran after the log failed')
  assert.deepEqual(readdirSync(w.scratchRoot), [], 'the folder whose row could not be written is deleted, as the graded one was')
  const state = await w.bench.state({ session: 's1' })
  assert.equal(state.last.status, 'failed')
  assert.equal(state.last.lines.length, 3)
  assert.deepEqual(state.last.lines.slice(0, 2), ['ql stopped at investigation-1. Nothing is recorded for it.', 'cx was not run.'])
  assert.match(state.last.lines[2], /^The run ended there: the benchmark's log could not be written \(.+\)\.$/)
  assert.deepEqual(w.evidence(), [])
})

test('a start after KzH stopped during a task deletes, and names first, what appeared at the top of the scratch root after that task began, and nothing that was there before it', async () => {
  const w = world({ agents: [cloud('first')], script: (a, t) => (t.id === 'investigation-1' ? 'die' : 'solve') })
  mkdirSync(join(w.scratchRoot, 'keep-me'))
  writeFileSync(join(w.scratchRoot, 'README.md'), 'Scratch space.\n')
  const { planId } = await w.bench.plan({ session: 's1', agents: ['first'] })
  await w.bench.start({ session: 's1', agents: ['first'], planId })
  await waitFor(() => existsSync(join(w.scratchRoot, 'notes.txt')))
  const folder = w.rows().filter((r) => r.type === 'folder').at(-1)
  assert.deepEqual(folder.top, ['README.md', 'keep-me'], 'the folder row lists what was at the top as the task began')
  // KzH stops here: the task never ends. A runner over the same files is KzH started again.
  const again = createBenchmark({ ...benchDeps(w), file: join(w.root, 'benchmark.jsonl') })
  assert.equal((await again.state({ session: 's1' })).leftovers, 3)
  const { planId: next, confirm } = await again.plan({ session: 's1', agents: ['first'] })
  assert.ok(confirm.body.includes(`It first deletes 1 task folder an interrupted run left in ${w.scratchRoot}, and what appeared in ${w.scratchRoot} after that run's last task began, which its agent may have written outside its folder: notes.txt and src.`), confirm.body.join('\n'))
  await again.start({ session: 's1', agents: ['first'], planId: next })
  await waitFor(() => !again.running())
  assert.deepEqual(readdirSync(w.scratchRoot).sort(), ['README.md', 'keep-me'])
  const rows = w.rows()
  const run = rows.findLast((r) => r.type === 'run').runId
  assert.deepEqual(rows.filter((r) => r.type === 'task' && r.runId === run).map((r) => [r.task, r.outcome]), [['preflight', 'passed'], ['investigation-1', 'passed'], ['review-1', 'passed']])
  assert.equal((await again.state({ session: 's1' })).leftovers, 0, 'nothing is left for a later start')
})

test('the task set is read again when its files change: the card says it no longer matches its version, and a plan or a start is refused', async () => {
  const w = world({ agents: [cloud('cx')], script: () => 'solve' })
  assert.equal((await w.bench.state({ session: 's1' })).taskSet.digestOk, true)
  const { planId } = await w.bench.plan({ session: 's1', agents: ['cx'] })
  appendFileSync(join(w.tasksDir, 'preflight', 'grade', 'hello.test.js'), '\n// changed on disk\n')
  assert.equal((await w.bench.state({ session: 's1' })).taskSet.digestOk, false)
  const refused = (err) => err.status === 400 && /^The task set on disk no longer matches version 1 of it \(its files hash to [0-9a-f]{12}, not [0-9a-f]{12}\)/.test(err.message)
  await assert.rejects(w.bench.plan({ session: 's1', agents: ['cx'] }), refused)
  await assert.rejects(w.bench.start({ session: 's1', agents: ['cx'], planId }), refused)
  assert.deepEqual(w.seen.order, [])
})

test('a task set that changes on disk during a run stops it: the task under way is not graded, the agent records nothing, and no later agent runs; one that finished before keeps its results', async () => {
  let w = null
  const touch = () => appendFileSync(join(w.tasksDir, 'review-1', 'task.json'), '\n')
  // While cx works on investigation-1, the set changes: that task is not graded.
  w = world({ agents: [cloud('cx'), cloud('dx')], script: (a, t) => { if (a.id === 'cx' && t.id === 'investigation-1') touch(); return 'solve' } })
  let rows = await w.runAll(['cx', 'dx'])
  assert.deepEqual(w.seen.order, ['cx:preflight', 'cx:investigation-1'])
  const cut = rows.find((r) => r.type === 'task' && r.task === 'investigation-1')
  assert.deepEqual([cut.outcome, cut.reason], ['not_scored', 'the task set on disk changed while it ran and no longer matches version 1, so it was not graded'])
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.line]), [
    ['cx', 'set_changed', 'cx stopped at investigation-1: the task set on disk changed while it ran and no longer matches version 1, so it was not graded. Nothing is recorded for it.'],
    ['dx', 'not_run', 'dx was not run: the task set on disk changed during the run.'],
  ])
  assert.equal(rows.at(-1).status, 'set_changed')
  assert.deepEqual(w.evidence(), [])
  // Between two agents, before dx's first task: dx runs nothing, and cx keeps what it recorded.
  w = world({ agents: [cloud('cx'), cloud('dx')], script: () => 'solve', deps: { usage: async (list, { force } = {}) => { if (force && list[0]?.id === 'dx') touch(); return {} } } })
  rows = await w.runAll(['cx', 'dx'])
  assert.deepEqual(w.seen.order, ['cx:preflight', 'cx:investigation-1', 'cx:review-1'])
  assert.deepEqual(rows.filter((r) => r.type === 'agent').map((r) => [r.agent, r.status, r.line]), [
    ['cx', 'finished', 'cx finished: recorded 2 tasks as evidence.'],
    ['dx', 'set_changed', 'dx stopped at preflight: the task set on disk changed during the run and no longer matches version 1. Nothing is recorded for it.'],
  ])
  assert.deepEqual([...new Set(w.evidence().map((e) => e.subject.model))], ['cx-model'])
})

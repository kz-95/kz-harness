// The resource budget on the settings page: Settings → Jev setup → Local models. The page is a
// browser file the test runner cannot import, so this checks what it renders from. The figures and
// the words come from a marked block of pure helpers, evaluated here on their own, and fed the real
// status() of a local models instance, so a field renamed on either side fails here rather than
// leaving a blank cell in the app. The section's markup is rendered once with a stand-in React, and
// the whole card is run with one that keeps state, over the same real instance behind stubbed
// routes, so typing, saving, refusals and the order answers land in are what the page really does.
//
// Nothing here has been seen in the running app. What these tests pin is what the page says, which
// inputs it offers and what it does with them, not how it looks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_CTX, createLocalModels } from '../local.js'
import { localStatus } from '../index.js'
import { createLanes, laneKey } from '../tasks.js'

const client = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

// The pure budget helpers, evaluated on their own, the way observability.test.js evaluates the
// display helpers: nothing in the block may reach outside it.
const helpers = (() => {
  const start = client.indexOf('// ---- pure budget helpers')
  const end = client.indexOf('// ---- end pure budget helpers')
  assert.ok(start > 0 && end > start, 'the budget helper block is marked')
  return new Function(`${client.slice(start, end)}\nreturn { MIN_CTX, BUDGET_ROWS, gbText, ctxText, budgetCells, budgetPatch, budgetError, modelFit, budgetNotes, modelName, chatModelOptions }`)()
})()

// ---------- a real local models instance, as the page's GET serves it ----------

const GIB = 1024 ** 3
const sha = (s) => createHash('sha256').update(s).digest('hex')
// The engine build and the two models local.test.js uses, on the same PC: a 4 GB GPU and 6 cores.
// Huge is in the manifest but not on this PC. status() gives it a memory figure all the same, the
// largest of the three, so a peak that took it in would show a model that cannot be loaded here.
const MODULES = [
  { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') },
  { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * GIB, sha256: sha('big'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 8192, maxContext: 40960 },
  { id: 'small', kind: 'model', name: 'Small', source: 'https://huggingface.co/Org/Small-GGUF/resolve/main/small.gguf', file: 'small.gguf', size: 3 * GIB, sha256: sha('small'), reliability: 'official-stable', verified: true, role: 'fast', rank: 2, recommendedVramGB: 3.8, minRamGB: 8, contextSize: 8192 },
  { id: 'huge', kind: 'model', name: 'Huge', source: 'https://huggingface.co/Org/Huge-GGUF/resolve/main/huge.gguf', file: 'huge.gguf', size: 9 * GIB, sha256: sha('huge'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 3, recommendedVramGB: 11, minRamGB: 16, contextSize: 8192 },
  // Wide asks for 32k and states its KV cost, 0.1 GB per 1k of context, so on this PC each 1k the
  // budget takes off its context takes a clean 0.1 GB off its RAM. Installed only where a test says.
  { id: 'wide', kind: 'model', name: 'Wide', source: 'https://huggingface.co/Org/Wide-GGUF/resolve/main/wide.gguf', file: 'wide.gguf', size: 2 * GIB, sha256: sha('wide'), reliability: 'official-stable', verified: true, role: 'fast', rank: 2, kvGbPerToken: 0.1 / 1024, contextSize: 32768 },
]
const PC = {
  gpus: [{ name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramGB: 4 }, { name: 'Intel(R) UHD Graphics', vendor: 'intel', vramGB: 0 }],
  cuda: 12.7, ramGB: 23.7, cpu: { name: '11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 52 * GIB,
}

/**
 * A stand-in for llama-server that prints `report` as its load report and answers /health at once.
 * Its pid is one no process can have, since the Windows stop path calls taskkill on it.
 */
function fakeEngine(report) {
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, pid: 2147483647 })
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
    setImmediate(() => { for (const l of report()) child.stderr.emit('data', `${l}\n`) })
    return child
  }
  return { spawn, fetch: async () => { await new Promise((r) => setImmediate(r)); return { ok: true } } }
}

/** The engine (unless `engine` is false) and the models in `models` (Big and Small unless said) installed, as a hand install leaves them. */
async function installed(extra = {}, { engine = true, models = ['big', 'small'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-budget-'))
  const engineDir = join(root, 'engine'); const modelsDir = join(root, 'models')
  mkdirSync(join(engineDir, '.installed'), { recursive: true }); mkdirSync(modelsDir, { recursive: true })
  if (engine) {
    writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
    writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: sha('e') }))
  }
  for (const id of models) writeFileSync(join(modelsDir, `${id}.gguf`), id)
  let report = []
  let rss = null
  const eng = fakeEngine(() => report)
  const local = createLocalModels({
    modules: MODULES, engineDir, modelsDir, settingsFile: join(root, 'local.json'), specs: async () => PC, port: 0,
    spawn: eng.spawn, fetch: eng.fetch, readWorkingSet: async () => rss, watchEveryMs: 3_600_000, ...extra,
  })
  await local.installed(); await local.settled()
  return {
    local,
    /** Load `id` with this load report, as llama-server prints it. */
    run: async (id, lines) => { report = lines; await local.start(id) },
    /** The watchdog's next reading of the working set, in GB. */
    workingSet: (gb) => { rss = gb * GIB },
  }
}
const byKey = (cells) => Object.fromEntries(cells.map((c) => [c.key, c]))
const modelOf = (status, id) => status.modules.find((m) => m.id === id)

test('the budget helpers stand on their own, and the page holds the context floor where local.js does', () => {
  // The page cannot import local.js, so it keeps its own copy of the floor. This is what keeps the
  // two the same number: a floor explained as 12k over a model clamped at 16k would mislead.
  assert.equal(helpers.MIN_CTX, MIN_CTX)
  assert.deepEqual(helpers.BUDGET_ROWS.map((r) => [r.key, r.label, r.id]), [
    ['maxVramGB', 'VRAM', 'jevi-lm-vram'],
    ['maxRamGB', 'RAM', 'jevi-lm-ram'],
    ['maxCores', 'Cores', 'jevi-lm-cores'],
    ['maxConcurrentTasks', 'Tasks at once', 'jevi-lm-tasks'],
  ])
  assert.equal(helpers.gbText(2.5), '2.5 GB')
  assert.equal(helpers.gbText(null), '-')
  assert.equal(helpers.ctxText(12288), '12k')
  assert.equal(helpers.ctxText(16384), '16k')
  assert.equal(helpers.ctxText(10000), '10000', 'a size that is no whole number of k is printed as it is')
})

test('the budget table reads status() by the names status() uses: each limit, what it uses now and its estimated peak', async () => {
  const { local, run, workingSet } = await installed()
  let cells = byKey(helpers.budgetCells(await local.status()))
  assert.deepEqual(Object.keys(cells), ['maxVramGB', 'maxRamGB', 'maxCores', 'maxConcurrentTasks'], 'VRAM, RAM, Cores, Tasks at once, in that order')
  // No budget: every field blank, which is no limit. Nothing is loaded, so no model row uses anything.
  for (const c of Object.values(cells)) assert.equal(c.value, '', `${c.label} is blank`)
  for (const c of Object.values(cells).filter((c) => c.key !== 'maxConcurrentTasks')) assert.equal(c.now.text, '-', `${c.label} uses nothing now`)
  // Tasks at once is '-' here only because status() alone carries no count of runs (the route adds
  // it, the next test): an idle count reads '0', not '-'.
  assert.equal(cells.maxConcurrentTasks.now.text, '-')
  assert.match(cells.maxConcurrentTasks.now.title, /not reported/, 'status() alone carries no count of runs')
  // The peak is the most any installed model the budget lets load would take, with where the figure
  // came from, and which model it is.
  assert.deepEqual([cells.maxVramGB.peak.text, cells.maxVramGB.peak.note], ['4 GB', 'estimated'])
  assert.deepEqual([cells.maxRamGB.peak.text, cells.maxRamGB.peak.note], ['2.7 GB', 'estimated'])
  assert.match(cells.maxRamGB.peak.title, /^Big at 12k context/)
  // Huge has a larger figure than either, but it is not on this PC, so it can be no part of the peak.
  assert.ok(modelOf(await local.status(), 'huge').memory.ramGB > 2.7, 'Huge has a figure, and a larger one')
  assert.match(cells.maxVramGB.peak.title, /^Big at 12k context/)
  // With no core budget the model still gets a thread cap, the default that leaves the app room.
  assert.deepEqual([cells.maxCores.peak.text, cells.maxCores.peak.note], ['4 threads', 'default'])
  assert.equal(cells.maxConcurrentTasks.peak.text, '-')

  // A budget: Big would put 4.2 GB into a 4 GB RAM budget, so it is refused and the peak is Small's.
  await local.setSettings({ maxVramGB: 2.5, maxRamGB: 4, maxCores: 3, maxConcurrentTasks: 2 })
  cells = byKey(helpers.budgetCells(await local.status()))
  assert.deepEqual(Object.values(cells).map((c) => c.value), ['2.5', '4', '3', '2'])
  assert.deepEqual([cells.maxVramGB.peak.text, cells.maxRamGB.peak.text], ['2.5 GB', '2.8 GB'])
  assert.match(cells.maxRamGB.peak.title, /^Small at 12k context/)
  assert.deepEqual([cells.maxCores.peak.text, cells.maxCores.peak.note], ['3 threads', null])

  // Loaded: VRAM and RAM from the engine's own load report until the watchdog has read the real
  // working set, and the working set from then on. Each says which it is.
  await run('small', ['CUDA0 model buffer size = 2355.20 MiB', 'CPU model buffer size = 2867.20 MiB'])
  cells = byKey(helpers.budgetCells(await local.status()))
  assert.deepEqual([cells.maxVramGB.now.text, cells.maxVramGB.now.note], ['2.3 GB', 'load report'])
  assert.deepEqual([cells.maxRamGB.now.text, cells.maxRamGB.now.note], ['2.8 GB', 'load report'])
  assert.equal(cells.maxCores.now.text, '3 threads')
  // Its figure is measured now, and the peak says so.
  assert.deepEqual([cells.maxVramGB.peak.text, cells.maxVramGB.peak.note], ['2.3 GB', 'measured'])
  workingSet(3.5)
  await local.checkMemory()
  cells = byKey(helpers.budgetCells(await local.status()))
  assert.deepEqual([cells.maxRamGB.now.text, cells.maxRamGB.now.note], ['3.5 GB', 'working set'])
  // status() alone does not carry how many runs hold a slot: the route adds that from the lanes (the
  // next test). Without it the cell says it is not reported rather than print a count of the
  // background tasks alone, which would leave out foreground runs.
  assert.equal(cells.maxConcurrentTasks.now.text, '-')
  assert.match(cells.maxConcurrentTasks.now.title, /not reported/)

  // A core budget above what the PC has gives every processor it has, and the cell says why.
  await local.setSettings({ maxCores: 64 })
  cells = byKey(helpers.budgetCells(await local.status()))
  assert.deepEqual([cells.maxCores.peak.text, cells.maxCores.peak.note], ['12 threads', 'all this PC has'])
  await local.dispose()
})

test('Tasks at once, now: the runs holding a slot, as the route serves them from the lanes that hold the cap, and \'-\' only when no count came', async () => {
  // The lanes as index.js wires them: the saved cap reaches them on every settings change.
  const lanes = createLanes()
  const { local } = await installed({ onSettings: (s) => lanes.setMax(s.maxConcurrentTasks) })
  const tasksNow = async () => byKey(helpers.budgetCells(await localStatus({ local, lanes, online: null }))).maxConcurrentTasks
  // Nothing runs, and that is a figure: 0, not the '-' of a count nobody reported. With no cap
  // nothing waits for a slot, so the cell says nothing of waiting.
  let cell = await tasksNow()
  assert.deepEqual([cell.value, cell.now.text, cell.now.note], ['', '0', null])
  assert.equal(cell.now.title, 'Agent runs holding a slot now, across every workspace: a foreground /auto, /<agent> or jev_route counts as much as a background task.')
  // A foreground run takes its workspace's lane in route(), a background task in its runner, and
  // the cap counts the two alike. A third, in a workspace of its own, waits for a slot.
  await local.setSettings({ maxConcurrentTasks: 2 })
  const foreground = await lanes.acquire(laneKey('C:/a'), 'route-1')
  const background = await lanes.acquire(laneKey('C:/b'), 'jev-1')
  const third = lanes.acquire(laneKey('C:/c'), 'jev-2')
  cell = await tasksNow()
  assert.deepEqual([cell.value, cell.now.text, cell.now.note], ['2', '2', '1 waiting'], 'both count, against a budget of two, and the one over it waits')
  assert.match(cell.now.title, / 1 more waits for a free slot\.$/)
  assert.doesNotMatch(cell.now.title, /more than the budget/, 'two of two is at the budget, not over it')
  // The foreground run ends: it stops counting, and the slot it freed goes to the third.
  foreground()
  const last = await third
  cell = await tasksNow()
  assert.deepEqual([cell.now.text, cell.now.note], ['2', null])
  assert.equal(cell.now.title, 'Agent runs holding a slot now, across every workspace: a foreground /auto, /<agent> or jev_route counts as much as a background task. None waits for a free slot.', 'two of two is at the budget, not over it')
  // Lowering the cap stops nothing that runs, so Now can be over the budget, and it says why.
  await local.setSettings({ maxConcurrentTasks: 1 })
  cell = await tasksNow()
  assert.deepEqual([cell.value, cell.now.text], ['1', '2'])
  assert.match(cell.now.title, /That is more than the budget: lowering it stops nothing that already runs/)
  background()
  last()
  cell = await tasksNow()
  assert.deepEqual([cell.now.text, cell.now.note], ['0', null], 'every run finished')
  // '-' only when the response carries no count, which is not the same as none running.
  const status = await local.status()
  for (const slots of [undefined, null, {}, { held: 'two' }]) {
    const bare = byKey(helpers.budgetCells({ ...status, slots })).maxConcurrentTasks
    assert.deepEqual([bare.now.text, bare.now.title], ['-', 'How many run now is not reported to this page'], JSON.stringify(slots))
  }
  // More than one waiting reads in the plural.
  let given = byKey(helpers.budgetCells({ ...status, slots: { held: 2, waiting: 2, max: 2 } })).maxConcurrentTasks
  assert.deepEqual([given.now.text, given.now.note], ['2', '2 waiting'])
  assert.match(given.now.title, / 2 more wait for a free slot\.$/)
  // With no cap nothing waits for a slot, whatever the count says, so the cell says nothing of waiting.
  given = byKey(helpers.budgetCells({ ...status, slots: { held: 1, waiting: 3, max: null } })).maxConcurrentTasks
  assert.deepEqual([given.now.text, given.now.note], ['1', null])
  assert.doesNotMatch(given.now.title, /wait/)
  await local.dispose()
})

test('each installed model shows what it takes at the context it runs with, estimated or measured, and whether it fits', async () => {
  const { local, run } = await installed()
  const fit = async (id) => { const s = await local.status(); return helpers.modelFit(modelOf(s, id), s.settings, s.budget) }
  // No budget: the figure alone, since there is nothing to fit.
  assert.deepEqual(await fit('big'), { line: '12k context: 4 GB VRAM + 2.7 GB RAM (estimated)', over: null, floor: null, reduced: null })
  await local.setSettings({ maxRamGB: 8 })
  assert.equal((await fit('big')).line, '12k context: 4 GB VRAM + 2.7 GB RAM (estimated) · fits your budget of 8 GB RAM')
  // The figure follows the budget: a VRAM budget moves layers off the GPU and into RAM.
  await local.setSettings({ maxVramGB: 2, maxRamGB: 4 })
  const big = await fit('big')
  assert.equal(big.line, '12k context: 2 GB VRAM + 4.7 GB RAM (estimated)', 'no "fits" on a model that does not')
  assert.equal(big.over, 'Big needs about 4.7 GB of RAM even at the 12k context floor (estimated: 2 GB VRAM + 4.7 GB RAM), over the resource budget of 2 GB VRAM + 4 GB RAM. Raise the RAM budget or use a smaller model.', 'the refusal, word for word what a load would say')
  assert.equal((await fit('small')).line, '12k context: 2 GB VRAM + 3.3 GB RAM (estimated) · fits your budget of 2 GB VRAM + 4 GB RAM')
  // A VRAM budget alone refuses nothing: --fit holds it, and the rest runs from RAM.
  await local.setSettings({ maxRamGB: null })
  assert.deepEqual(await fit('big'), { line: '12k context: 2 GB VRAM + 4.7 GB RAM (estimated) · fits your budget of 2 GB VRAM', over: null, floor: null, reduced: null })
  // Once a run like this one has reported what it took, the figure is that, and says so.
  await local.setSettings({ maxVramGB: null })
  await run('big', ['CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 3072.00 MiB'])
  assert.equal((await fit('big')).line, '12k context: 3.5 GB VRAM + 3 GB RAM (measured)')
  await local.dispose()

  // The plugin config can set every model's context below the floor. The page does not hide it.
  const low = await installed({ contextSize: 8192 })
  const s = await low.local.status()
  const under = helpers.modelFit(modelOf(s, 'big'), s.settings, s.budget)
  assert.match(under.line, /^8k context: /)
  assert.match(under.floor, /8k context is below the 12k floor/)
  assert.match(under.floor, /context-exceeded/)
  await low.local.dispose()
})

test('a model is never said to fit a VRAM budget that does not hold it, in its own line or in the peak', async () => {
  const { local, run } = await installed()
  const status = async () => { const s = await local.status(); return { s, fit: (id) => helpers.modelFit(modelOf(s, id), s.settings, s.budget), cells: byKey(helpers.budgetCells(s)) } }
  // Layers pinned by hand load as pinned, and --fit cannot hold them to the budget. Until a run has
  // reported what it took, the estimate assumes the budget holds, so it cannot be said to fit either.
  await local.setSettings({ maxVramGB: 2, gpuLayers: 20 })
  let { fit, cells } = await status()
  assert.equal(fit('big').line, '12k context: 2 GB VRAM + 4.7 GB RAM (estimated) · VRAM budget not applied')
  // Measured, it took 3.5 GB of GPU memory under a 2 GB budget. Nothing is refused, since only RAM
  // is, but nothing may call that a fit, and the peak in the 2 GB row says it is over.
  await run('big', ['CUDA0 model buffer size = 3584.00 MiB', 'CPU model buffer size = 3072.00 MiB'])
  ;({ fit, cells } = await status())
  assert.deepEqual(fit('big'), { line: '12k context: 3.5 GB VRAM + 3 GB RAM (measured) · VRAM budget not applied', over: null, floor: null, reduced: null })
  assert.equal(cells.maxVramGB.peak.text, '3.5 GB')
  assert.match(cells.maxVramGB.peak.title, /^Big at 12k context, .*\. That is more than the VRAM budget, which is not applied: see below\.$/)
  // A RAM budget beside it: the RAM side fits, but the line still does not claim the whole budget.
  await local.setSettings({ maxRamGB: 8 })
  ;({ fit } = await status())
  assert.equal(fit('big').line, '12k context: 3.5 GB VRAM + 3 GB RAM (measured) · VRAM budget not applied')
  // With the budget applied, a run that still reports more than it is over it, and says so.
  await local.stop()
  await local.setSettings({ gpuLayers: null, maxRamGB: null })
  await run('small', ['CUDA0 model buffer size = 2355.20 MiB', 'CPU model buffer size = 2867.20 MiB'])
  ;({ fit, cells } = await status())
  assert.equal(fit('small').line, '12k context: 2.3 GB VRAM + 2.8 GB RAM (measured) · over your VRAM budget of 2 GB')
  assert.equal(cells.maxVramGB.peak.text, '2.3 GB')
  assert.match(cells.maxVramGB.peak.title, /\. That is more than the VRAM budget\.$/)
  // And a figure the budget does hold is a fit, and its peak says nothing more.
  await local.setSettings({ maxVramGB: 3 })
  ;({ fit, cells } = await status())
  assert.match(fit('small').line, / · fits your budget of 3 GB VRAM$/)
  assert.doesNotMatch(cells.maxVramGB.peak.title, /more than the VRAM budget/)
  await local.dispose()
})

test('the chat model select offers only models the budget lets load, and says when there is none', async () => {
  const { local } = await installed()
  const options = async () => { const s = await local.status(); return helpers.chatModelOptions(s.modules.filter((m) => m.kind === 'model' && m.state === 'installed'), s.settings.chatModel) }
  assert.deepEqual(await options(), [{ value: 'big', label: 'Big', disabled: false }, { value: 'small', label: 'Small', disabled: false }])
  // Big is over this budget. Picked, it would be saved as the choice, and the select would jump
  // back to the model in effect with no word why, so it is named as over and cannot be picked.
  await local.setSettings({ maxVramGB: 2, maxRamGB: 4 })
  assert.deepEqual(await options(), [{ value: 'big', label: 'Big (over budget)', disabled: true }, { value: 'small', label: 'Small', disabled: false }])
  assert.equal((await local.status()).settings.chatModel, 'small')
  // Nothing fits: there is no chat model, and the select must not show the first model as if it were one.
  await local.setSettings({ maxRamGB: 1 })
  assert.equal((await local.status()).settings.chatModel, null)
  assert.deepEqual(await options(), [
    { value: '', label: 'None fits the budget', disabled: true },
    { value: 'big', label: 'Big (over budget)', disabled: true },
    { value: 'small', label: 'Small (over budget)', disabled: true },
  ])
  assert.equal(helpers.modelName({ name: 'Big', overBudget: 'Big needs about...' }), 'Big (over budget)')
  assert.equal(helpers.modelName({ name: 'Small', overBudget: null }), 'Small')
  await local.dispose()
})

test('a budget field saves what was typed: blank lifts the limit, a number sets it, anything else is refused on the page', async () => {
  const { budgetPatch, budgetError } = helpers
  assert.deepEqual(budgetPatch('maxRamGB', '8', null), { patch: { maxRamGB: 8 } })
  assert.deepEqual(budgetPatch('maxRamGB', ' 8,5 ', null), { patch: { maxRamGB: 8.5 } }, 'a decimal comma reads as a point')
  assert.deepEqual(budgetPatch('maxVramGB', '2,75', null), { patch: { maxVramGB: 2.75 } })
  // A thousands separator is not one: read as a point it would save 4.096 GB for 4096.
  assert.deepEqual(budgetPatch('maxRamGB', '4,096', null), { error: 'RAM: a number of GB, or blank for no limit' })
  assert.deepEqual(budgetPatch('maxRamGB', '', 8), { patch: { maxRamGB: null } }, 'blank is no limit')
  assert.deepEqual(budgetPatch('maxRamGB', '  ', 8), { patch: { maxRamGB: null } })
  // Nothing changed, nothing sent: a save reloads the page's figures for no reason.
  assert.deepEqual(budgetPatch('maxRamGB', '8', 8), {})
  assert.deepEqual(budgetPatch('maxCores', '', null), {})
  assert.deepEqual(budgetPatch('maxCores', undefined, 4), {}, 'a field nobody typed in')
  // Text that is no number is never sent. JSON has no NaN, so it would reach the server as null
  // and lift the limit, the opposite of what was typed.
  assert.deepEqual(budgetPatch('maxRamGB', '8 GB', 8), { error: 'RAM: a number of GB, or blank for no limit' })
  assert.deepEqual(budgetPatch('maxVramGB', 'Infinity', null), { error: 'VRAM: a number of GB, or blank for no limit' })
  assert.deepEqual(budgetPatch('maxConcurrentTasks', 'two', null), { error: 'Tasks at once: a number, or blank for no limit' })
  // The bounds are the server's to say. Its refusals speak of null, which the page calls blank.
  const { local } = await installed()
  for (const patch of [{ maxVramGB: 2000 }, { maxRamGB: 5000 }, { maxCores: 2.5 }, { maxConcurrentTasks: 65 }]) {
    const said = await local.setSettings(patch).then(() => null, (e) => e.message)
    assert.ok(said, `${JSON.stringify(patch)} is refused`)
    assert.match(budgetError(said), /, or blank for no limit$/, said)
    assert.doesNotMatch(budgetError(said), /null/, said)
  }
  assert.equal(budgetError('something else went wrong'), 'something else went wrong', 'any other error is shown as it is')
  await local.dispose()
})

test('the page says RAM is a soft limit and the app is never capped, explains the context floor, and says when the VRAM budget is not applied', async () => {
  const { local } = await installed()
  const notes = helpers.budgetNotes(await local.status())
  const text = notes.map((n) => n.text).join('\n')
  assert.ok(notes.every((n) => !n.warn), 'nothing to warn of with no budget')
  // RAM: the honest version, three ways of keeping it and no word of a cap.
  assert.match(text, /RAM is a soft limit/)
  assert.match(text, /refused before it loads/)
  assert.match(text, /watchdog unloads/)
  assert.match(text, /30 seconds/)
  assert.doesNotMatch(text, /RAM is (a )?(hard|real) (cap|limit)/)
  // The app itself.
  assert.match(text, /app window and its browser view are never capped/)
  assert.match(text, /not in these figures/, 'and the page does not pretend it counts them')
  // The floor, in words: why 12k, and what going under it looks like.
  assert.match(text, /12k \(12288 tokens\)/)
  assert.match(text, /about 8\.6k tokens/)
  assert.match(text, /looks like a fault in the model/)
  // The RAM field's own tooltip says the same, since it is read without the words under the table.
  const ramTitle = helpers.BUDGET_ROWS.find((r) => r.key === 'maxRamGB').title
  assert.match(ramTitle, /soft limit/)
  assert.doesNotMatch(ramTitle, /(hard|real) (cap|limit)/)
  // Layers pinned by hand are loaded as pinned, so --fit cannot hold the VRAM budget, and the page says so.
  await local.setSettings({ maxVramGB: 2, gpuLayers: 20 })
  const warned = helpers.budgetNotes(await local.status()).filter((n) => n.warn)
  assert.deepEqual(warned.map((n) => n.text), ['VRAM budget not applied: GPU layers are pinned to 20, which --fit does not move.'])
  await local.dispose()
})

// ---------- the section's markup, rendered once with a stand-in React ----------

const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })

// client.js is a classic script; run its body as a function of `window` (and of any browser globals
// a test hands it in place of the real ones), hand its factory a React whose createElement only
// records what it was asked for, and render from `__test`.
function loadPlugin(React = { createElement, Fragment: 'fragment', useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }, globals = {}) {
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  const names = Object.keys(globals)
  new Function('window', ...names, client)(window, ...names.map((k) => globals[k]))
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}
const nodes = (n) => (n && typeof n === 'object' ? [n, ...n.children.flatMap(nodes)] : [])
const textOf = (n) => (n == null || n === false ? '' : typeof n !== 'object' ? String(n) : n.children.map(textOf).join(''))

test('the budget section is a table of four labelled inputs, sized like the panel\'s other inputs, beside what is in use and the peak', () => {
  const { ResourceBudget } = loadPlugin().__test
  const data = {
    settings: { maxVramGB: 3, maxRamGB: null, maxCores: 6, maxConcurrentTasks: 2 },
    engine: { running: false },
    budget: { threads: 6, defaultThreads: 4, fitTargetMiB: 1024, vramNotApplied: null },
    modules: [],
    slots: { held: 2, waiting: 1, max: 2 },
  }
  const edits = []
  const saves = []
  const tree = ResourceBudget({ data, edits: { maxRamGB: '9' }, errors: { maxRamGB: 'RAM: a number of GB, or blank for no limit', maxCores: '' }, onEdit: (k, v) => edits.push([k, v]), onSave: (k) => saves.push(k) })
  const all = nodes(tree)
  const [table] = all.filter((n) => n.type === 'table')
  assert.equal(table.props.className, 'budget')
  // Named by its heading, the way the card is named by its own.
  const heading = all.find((n) => n.props.id && n.props.id === table.props['aria-labelledby'])
  assert.equal(textOf(heading), 'Resource budget')
  const heads = nodes(table).filter((n) => n.type === 'th' && n.props.scope === 'col')
  assert.deepEqual(heads.map(textOf), ['Budget', 'Now', 'Estimated peak'])
  const rows = nodes(table).filter((n) => n.type === 'tbody').flatMap((b) => b.children.filter((c) => c?.type === 'tr'))
  assert.equal(rows.length, 4)
  // Each input as the panel's own are made: a label naming it, and the width of jevi-lm-idle.
  const width = Number(/id: 'jevi-lm-idle'[^\n]*?style: \{ width: (\d+) \}/.exec(client)?.[1])
  assert.ok(width > 0, 'the idle input still states its width')
  const seen = rows.map((tr) => {
    const [th] = tr.children.filter((c) => c?.type === 'th')
    const label = nodes(th).find((n) => n.type === 'label')
    const input = nodes(tr).find((n) => n.type === 'input')
    assert.equal(th.props.scope, 'row')
    assert.equal(label.props.htmlFor, input.props.id, `${textOf(label)} labels its input`)
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.placeholder, 'no limit')
    assert.deepEqual(input.props.style, { width })
    const cells = tr.children.filter((c) => c?.type === 'td')
    return [textOf(label), input.props.id, input.props.value, textOf(cells[0]).replace(textOf(input), '').trim(), cells.length]
  })
  assert.deepEqual(seen, [
    ['VRAM', 'jevi-lm-vram', '3', 'GB', 3],
    ['RAM', 'jevi-lm-ram', '9', 'GB', 3],
    ['Cores', 'jevi-lm-cores', '6', '', 3],
    ['Tasks at once', 'jevi-lm-tasks', '2', '', 3],
  ], 'an edit in progress shows over the saved value')
  // Now: nothing is loaded, so the model's rows have no figure, and Tasks at once has the runs
  // holding a slot, with the one waiting for a slot beside it.
  assert.deepEqual(rows.map((tr) => textOf(tr.children.filter((c) => c?.type === 'td')[1])), ['-', '-', '-', '2 (1 waiting)'])
  // Typing is kept as typed, and the field saves when it loses focus, as the panel's others do.
  const ram = all.find((n) => n.type === 'input' && n.props.id === 'jevi-lm-ram')
  ram.props.onChange({ target: { value: '7' } })
  ram.props.onBlur()
  assert.deepEqual([edits, saves], [[['maxRamGB', '7']], ['maxRamGB']])
  // The budget's own errors show under the table, one line for each field refused, and the notes after them.
  const alerts = all.filter((n) => n.props.role === 'alert')
  assert.deepEqual(alerts.map((a) => [a.props.className, textOf(a)]), [['err', 'RAM: a number of GB, or blank for no limit']])
  assert.match(textOf(tree), /RAM is a soft limit/)
  assert.match(textOf(tree), /12k \(12288 tokens\)/)
})

test('the local models panel shows the budget section and each model\'s figure, and the table is styled from the DSH tokens', () => {
  const card = client.slice(client.indexOf('function LocalModelsCard('), client.indexOf('// ---------- icons'))
  assert.match(card, /h\(ResourceBudget, \{ data, /)
  assert.match(card, /modelFit\(m, data\.settings, data\.budget\)/)
  // A table has no style of its own in this stylesheet, so it gets one, built from the same tokens
  // as the rest: the .limits row's type and colour, and the dt colour for its headings.
  assert.match(client, /\.jevi table\.budget\{[^}]*font:var\(--dsw-font-xxs-12\)[^}]*color:var\(--dsw-alias-label-secondary\)/)
  assert.match(client, /\.jevi table\.budget thead th\{color:var\(--dsw-alias-label-tertiary\)\}/)
})

// ---------- the whole card, as the page runs it, over a real local models instance ----------

/**
 * A stand-in React that keeps state across renders, enough to run LocalModelsCard: useState,
 * useEffect with its dependencies and cleanup, useCallback and useRef, for the one component
 * mounted. The components it renders are called in place, since none of them has hooks of its own.
 * A state change renders again on the next microtask, as React batches it.
 */
function statefulReact() {
  let current = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const slot = () => { const v = current; return [v, v.i++] }
  const React = {
    createElement,
    Fragment: 'fragment',
    useState: (init) => {
      const [v, k] = slot()
      if (!(k in v.slots)) v.slots[k] = init
      return [v.slots[k], (x) => { const next = typeof x === 'function' ? x(v.slots[k]) : x; if (!Object.is(next, v.slots[k])) { v.slots[k] = next; v.schedule() } }]
    },
    useEffect: (fn, deps) => {
      const [v, k] = slot()
      const prev = v.slots[k]
      if (prev && same(prev.deps, deps)) return
      v.slots[k] = { deps, cleanup: null }
      v.effects.push(() => { prev?.cleanup?.(); v.slots[k].cleanup = fn() ?? null })
    },
    useCallback: (f, deps) => {
      const [v, k] = slot()
      if (v.slots[k] && same(v.slots[k].deps, deps)) return v.slots[k].f
      v.slots[k] = { f, deps }
      return f
    },
    useRef: (init) => { const [v, k] = slot(); if (!(k in v.slots)) v.slots[k] = { current: init }; return v.slots[k] },
  }
  const expand = (n) => (!n || typeof n !== 'object' ? n : typeof n.type === 'function' ? expand(n.type({ ...n.props, children: n.children })) : { ...n, children: n.children.map(expand) })
  const mount = (Component, props) => {
    const view = { slots: [], i: 0, effects: [], queued: false, tree: null }
    view.render = () => {
      view.queued = false; view.i = 0; view.effects = []
      current = view
      const out = Component(props)
      current = null
      view.tree = expand(out)
      for (const run of view.effects) run()
    }
    view.schedule = () => { if (!view.queued) { view.queued = true; queueMicrotask(view.render) } }
    view.unmount = () => { for (const x of view.slots) x?.cleanup?.() }
    view.render()
    return view
  }
  return { React, mount }
}

/**
 * The local models card over a real local models instance, behind the routes index.js serves: GET
 * /jev-router/local answers what the route does (localStatus: status() and the count of runs holding
 * a slot, from lanes wired to the saved cap as index.js wires them) through JSON, and POST /jev-router/local/settings saves through
 * setSettings and answers 400 with its message when it refuses. `hold(method)` holds back the answer
 * to the next request of that method until the function it returns is called, so a test can have
 * two answers land in either order. The 5 s poll never runs by itself; `poll()` runs it once.
 */
async function card(extra, opts) {
  const lanes = createLanes()
  const { local, run } = await installed({ onSettings: (s) => lanes.setMax(s.maxConcurrentTasks), ...extra }, opts)
  const posts = []
  const holds = { GET: [], POST: [] }
  const polls = []
  let busy = 0
  const fetch = async (path, init = {}) => {
    busy++
    try {
      const method = init.method ?? 'GET'
      let code = 200
      let body = { error: 'not found' }
      if (method === 'GET' && path === '/jev-router/local') body = await localStatus({ local, lanes, online: null })
      else if (method === 'POST' && path === '/jev-router/local/settings') {
        const patch = JSON.parse(init.body)
        posts.push(patch)
        body = await local.setSettings(patch).then(() => ({ ok: true }), (e) => { code = 400; return { error: e.message } })
      } else code = 404
      const held = holds[method].shift()
      if (held) { busy--; await held; busy++ }
      const text = JSON.stringify(body)
      return { ok: code === 200, status: code, json: async () => JSON.parse(text) }
    } finally { busy-- }
  }
  const { React, mount } = statefulReact()
  const { LocalModelsCard } = loadPlugin(React, {
    fetch, document: { hidden: false },
    setInterval: (f) => polls.push(f), clearInterval: (id) => { polls[id - 1] = null },
  }).__test
  const view = mount(LocalModelsCard, { ask: () => {} })
  /** Until every request not held back has been answered and every render it caused has run. */
  const settle = async () => {
    for (let quiet = 0, until = Date.now() + 10_000; quiet < 2; quiet = !busy && !view.queued ? quiet + 1 : 0) {
      if (Date.now() > until) throw new Error('the card never settled')
      await new Promise((r) => setImmediate(r))
    }
  }
  await settle()
  const all = () => nodes(view.tree)
  const input = (id) => all().find((n) => n.type === 'input' && n.props.id === id)
  return {
    local, lanes, run, posts, settle, all,
    field: (id) => input(id).props.value,
    /** Typed into a field, rendered, as a keystroke is, before anything else can happen. */
    type: async (id, value) => { input(id).props.onChange({ target: { value } }); await settle() },
    blur: async (id) => { input(id).props.onBlur(); await settle() },
    alerts: () => all().filter((n) => n.props.role === 'alert').map(textOf),
    /** The installed model's row, by its name. */
    row: (name) => all().find((n) => n.type === 'li' && textOf(n.children[0]?.children[0]?.children[0]) === name),
    select: (id) => all().find((n) => n.type === 'select' && (n.props.id === id || n.props['aria-label'] === id)),
    hold: (method) => { let release; holds[method].push(new Promise((r) => { release = r })); return release },
    poll: async () => { polls.filter(Boolean).at(-1)(); await settle() },
    saved: async (key) => (await local.readSettings())[key],
    close: async () => { view.unmount(); await local.dispose() },
  }
}

test('the card saves a budget field when it loses focus, and the field then shows what was saved', async () => {
  const page = await card()
  assert.equal(page.field('jevi-lm-ram'), '')
  await page.type('jevi-lm-ram', '8')
  assert.equal(page.field('jevi-lm-ram'), '8', 'typing shows as it is typed')
  assert.deepEqual(page.posts, [], 'and nothing is sent until the field loses focus')
  await page.blur('jevi-lm-ram')
  assert.deepEqual(page.posts, [{ maxRamGB: 8 }])
  assert.equal(await page.saved('maxRamGB'), 8)
  assert.equal(page.field('jevi-lm-ram'), '8', 'the saved value, reloaded')
  assert.deepEqual(page.alerts(), [])
  // The edit is gone once saved: the field follows what is saved from then on.
  await page.local.setSettings({ maxRamGB: 6 })
  await page.poll()
  assert.equal(page.field('jevi-lm-ram'), '6')
  // The same value again sends nothing. Blank lifts the limit.
  await page.type('jevi-lm-ram', '6'); await page.blur('jevi-lm-ram')
  assert.equal(page.posts.length, 1)
  await page.type('jevi-lm-ram', ''); await page.blur('jevi-lm-ram')
  assert.deepEqual(page.posts.at(-1), { maxRamGB: null })
  assert.equal(await page.saved('maxRamGB'), null)
  assert.equal(page.field('jevi-lm-ram'), '')
  // Text that is no number is refused on the page, never sent, and stays as it was typed.
  await page.type('jevi-lm-ram', '8 GB'); await page.blur('jevi-lm-ram')
  assert.equal(page.posts.length, 2)
  assert.deepEqual(page.alerts(), ['RAM: a number of GB, or blank for no limit'])
  assert.equal(page.field('jevi-lm-ram'), '8 GB')
  // A value the server refuses keeps what was typed too, with the refusal in the page's words.
  await page.type('jevi-lm-ram', ''); await page.blur('jevi-lm-ram')
  await page.type('jevi-lm-vram', '2000'); await page.blur('jevi-lm-vram')
  assert.deepEqual(page.posts.at(-1), { maxVramGB: 2000 })
  assert.deepEqual(page.alerts(), ['max VRAM: GB above 0, at most 1024, or blank for no limit'])
  assert.equal(page.field('jevi-lm-vram'), '2000')
  assert.equal(await page.saved('maxVramGB'), null)
  await page.close()
})

test('a refused budget field keeps its refusal while another field saves', async () => {
  const page = await card()
  await page.type('jevi-lm-vram', '2000'); await page.blur('jevi-lm-vram')
  await page.type('jevi-lm-ram', '8'); await page.blur('jevi-lm-ram')
  assert.equal(await page.saved('maxRamGB'), 8)
  // VRAM still shows 2000, which was never saved: the page must go on saying so.
  assert.equal(page.field('jevi-lm-vram'), '2000')
  assert.deepEqual(page.alerts(), ['max VRAM: GB above 0, at most 1024, or blank for no limit'])
  // Two refused at once are both shown, in the table's order.
  await page.type('jevi-lm-tasks', 'two'); await page.blur('jevi-lm-tasks')
  assert.deepEqual(page.alerts(), ['max VRAM: GB above 0, at most 1024, or blank for no limit', 'Tasks at once: a number, or blank for no limit'])
  // Put right, each one's refusal goes, and only its own.
  await page.type('jevi-lm-vram', '3'); await page.blur('jevi-lm-vram')
  assert.equal(await page.saved('maxVramGB'), 3)
  assert.deepEqual(page.alerts(), ['Tasks at once: a number, or blank for no limit'])
  await page.close()
})

test('typing into a budget field while its save is on the way is kept, and saved at the next blur', async () => {
  const page = await card()
  const release = page.hold('POST')
  await page.type('jevi-lm-ram', '8'); await page.blur('jevi-lm-ram')
  await page.type('jevi-lm-ram', '6')
  release()
  await page.settle()
  assert.equal(page.field('jevi-lm-ram'), '6', 'what was typed since is not thrown away when the first save lands')
  await page.blur('jevi-lm-ram')
  assert.deepEqual(page.posts, [{ maxRamGB: 8 }, { maxRamGB: 6 }])
  assert.equal(await page.saved('maxRamGB'), 6)
  assert.equal(page.field('jevi-lm-ram'), '6')
  await page.close()
})

test('a poll that read the settings before a save cannot put the old value back after it', async () => {
  const page = await card()
  const release = page.hold('GET')
  await page.poll()
  await page.type('jevi-lm-ram', '8'); await page.blur('jevi-lm-ram')
  assert.equal(page.field('jevi-lm-ram'), '8')
  release()
  await page.settle()
  assert.equal(page.field('jevi-lm-ram'), '8', 'the poll from before the save lands last, and changes nothing')
  assert.equal(await page.saved('maxRamGB'), 8)
  await page.close()
})

test('the budget section is there before the engine is installed, since the task cap needs none', async () => {
  const page = await card({}, { engine: false })
  assert.match(textOf(page.all()[0]), /Engine not installed\./)
  assert.ok(page.all().some((n) => n.type === 'table' && n.props.className === 'budget'))
  await page.type('jevi-lm-tasks', '2'); await page.blur('jevi-lm-tasks')
  assert.equal(await page.saved('maxConcurrentTasks'), 2)
  await page.close()
})

test('the card shows how many runs hold a slot now, and follows it at the next poll', async () => {
  const page = await card()
  const tasksNow = () => {
    const row = page.all().find((n) => n.type === 'tr' && textOf(n.children[0]) === 'Tasks at once')
    return textOf(row.children.filter((c) => c?.type === 'td')[1])
  }
  assert.equal(tasksNow(), '0')
  await page.type('jevi-lm-tasks', '1'); await page.blur('jevi-lm-tasks')
  const foreground = await page.lanes.acquire(laneKey('C:/a'), 'route-1')
  const background = page.lanes.acquire(laneKey('C:/b'), 'jev-1')
  await page.poll()
  assert.equal(tasksNow(), '1 (1 waiting)', 'the saved cap reached the lanes, and the one over it waits')
  foreground()
  const release = await background
  await page.poll()
  assert.equal(tasksNow(), '1')
  release()
  await page.poll()
  assert.equal(tasksNow(), '0')
  await page.close()
})

test('each installed model in the card shows its figure against the budget, and the chat model select only offers what fits', async () => {
  const page = await card()
  await page.type('jevi-lm-vram', '2'); await page.blur('jevi-lm-vram')
  await page.type('jevi-lm-ram', '4'); await page.blur('jevi-lm-ram')
  const big = page.row('Big')
  const why = nodes(big).filter((n) => n.props.className === 'why').map(textOf)
  assert.ok(nodes(big).some((n) => n.type === 'span' && n.props.className === 'pill bad' && textOf(n) === 'over budget'), 'Big is marked over budget')
  assert.ok(why.includes('12k context: 2 GB VRAM + 4.7 GB RAM (estimated)'), why.join('\n'))
  const refusal = nodes(big).find((n) => n.props.className === 'why err')
  assert.equal(textOf(refusal), 'Big needs about 4.7 GB of RAM even at the 12k context floor (estimated: 2 GB VRAM + 4.7 GB RAM), over the resource budget of 2 GB VRAM + 4 GB RAM. Raise the RAM budget or use a smaller model.')
  const small = page.row('Small')
  assert.ok(nodes(small).map(textOf).includes('12k context: 2 GB VRAM + 3.3 GB RAM (estimated) · fits your budget of 2 GB VRAM + 4 GB RAM'))
  assert.ok(!nodes(small).some((n) => n.props.className === 'pill bad'), 'Small is not')
  assert.ok(!page.row('Huge'), 'a model not on this PC has no row')
  // The chat model: the one in effect, with Big named as over and not to be picked.
  const chat = page.select('jevi-lm-chat')
  assert.equal(chat.props.value, 'small')
  assert.deepEqual(chat.children.map((o) => [o.props.value, textOf(o), !!o.props.disabled]), [['big', 'Big (over budget)', true], ['small', 'Small', false]])
  assert.deepEqual(page.select('Model to start').children.map(textOf), ['Big (over budget)', 'Small'], 'the start picker names it too')
  // Nothing fits: the select says so rather than show Big as the chat model.
  await page.type('jevi-lm-ram', '1'); await page.blur('jevi-lm-ram')
  const none = page.select('jevi-lm-chat')
  assert.equal(none.props.value, '')
  assert.deepEqual([none.children[0].props.value, textOf(none.children[0]), none.children[0].props.disabled], ['', 'None fits the budget', true])
  // Layers pinned by hand: the budget is not applied, and no model line says it fits.
  await page.type('jevi-lm-ram', ''); await page.blur('jevi-lm-ram')
  await page.local.setSettings({ gpuLayers: 20 })
  await page.poll()
  assert.ok(nodes(page.row('Small')).map(textOf).includes('12k context: 2 GB VRAM + 3.3 GB RAM (estimated) · VRAM budget not applied'))
  await page.close()

  // Under the floor, each model's row says what that will cost.
  const low = await card({ contextSize: 8192 })
  const warn = nodes(low.row('Big')).find((n) => n.props.className === 'warnline')
  assert.match(textOf(warn), /^8k context is below the 12k floor/)
  await low.close()
})

test('a model the budget sizes down shows the context it will load with and says the budget reduced it, from what to what', async () => {
  const { local } = await installed({}, { models: ['wide'] })
  const fit = async (id) => { const s = await local.status(); return helpers.modelFit(modelOf(s, id), s.settings, s.budget) }
  // No budget: the context it asks for, and nothing said of it.
  assert.deepEqual(await fit('wide'), { line: '32k context: 4 GB VRAM + 2.3 GB RAM (estimated)', over: null, floor: null, reduced: null })
  // At 32k it puts 2.3 GB into RAM. Under a 1.25 GB budget it loads with 21k, the largest that fits.
  await local.setSettings({ maxRamGB: 1.25 })
  assert.deepEqual(await fit('wide'), {
    line: '21k context: 4 GB VRAM + 1.2 GB RAM (estimated) · fits your budget of 1.25 GB RAM', over: null, floor: null,
    reduced: 'The budget reduced its context from 32k to 21k, the largest that fits it.',
  })
  // The peak is its figure at the context it will load with, and names that context.
  const cells = byKey(helpers.budgetCells(await local.status()))
  assert.equal(cells.maxRamGB.peak.text, '1.2 GB')
  assert.match(cells.maxRamGB.peak.title, /^Wide at 21k context/)
  // Not even the 12k floor fits: refused, the refusal says so, and nothing speaks of a context it will not load with.
  await local.setSettings({ maxRamGB: 0.2 })
  assert.deepEqual(await fit('wide'), {
    line: '12k context: 4 GB VRAM + 0.3 GB RAM (estimated)',
    over: 'Wide needs about 0.3 GB of RAM even at the 12k context floor (estimated: 4 GB VRAM + 0.3 GB RAM), over the resource budget of 0.2 GB RAM. Raise the RAM budget or use a smaller model.',
    floor: null, reduced: null,
  })
  // The words under the table say a model is sized down before it is refused, and still explain the floor.
  const text = helpers.budgetNotes(await local.status()).map((n) => n.text).join('\n')
  assert.match(text, /smaller context, down to the 12k floor/)
  assert.match(text, /The context floor is 12k \(12288 tokens\): the system prompt and the tool list alone take about 8\.6k tokens/)
  await local.dispose()

  // In the card, the model's row says it under its figure.
  const page = await card({}, { models: ['wide'] })
  await page.type('jevi-lm-ram', '1.25'); await page.blur('jevi-lm-ram')
  const why = nodes(page.row('Wide')).filter((n) => n.props.className === 'why').map(textOf)
  const at = why.indexOf('21k context: 4 GB VRAM + 1.2 GB RAM (estimated) · fits your budget of 1.25 GB RAM')
  assert.ok(at > 0, why.join('\n'))
  assert.equal(why[at + 1], 'The budget reduced its context from 32k to 21k, the largest that fits it.')
  await page.close()

  // A context the plugin config set to no whole number of k cannot be printed in k, so the line
  // gives both ends in tokens rather than one in each unit.
  const odd = await installed({ contextSize: 20000 }, { models: ['wide'] })
  await odd.local.setSettings({ maxRamGB: 1 })
  const s = await odd.local.status()
  assert.deepEqual(helpers.modelFit(modelOf(s, 'wide'), s.settings, s.budget), {
    line: '19k context: 4 GB VRAM + 1 GB RAM (estimated) · fits your budget of 1 GB RAM', over: null, floor: null,
    reduced: 'The budget reduced its context from 20000 tokens to 19456 tokens, the largest that fits it.',
  })
  await odd.local.dispose()
})

// ---------- Laya beside the local models (docs/laya-auto.md 7.7) ----------

/**
 * Laya's status as the route carries it beside the local models' (`laya`, the answer of GET
 * /jev-router/laya, 8.4): installed for the GPU, and running there with the figures status()
 * reports, unless told otherwise. `need` is what it would take at its next start.
 */
const layaStatus = ({ running = {}, ...over } = {}) => ({
  state: running ? 'ready' : 'stopped',
  installed: { laya: '0.3.20', torch: '2.14.0+cu128', cuda: true, gpu: PC.gpus[0].name, python: '3.12.11', weights: null, diskBytes: null },
  running: running && { port: 8091, pid: 1234, interpreterPid: 1240, device: 'cuda', deviceWhy: null, spilling: false, threads: 6, loadMs: 41000, ramGB: 1.9, vramGB: 2.3, msPerToken: { intent: 0.2, route: 0.3, review: 0.2 }, busy: false, held: [], lastCallMs: 950, ...running },
  settings: { startWithKzh: false, keepLoaded: false, idleMinutes: 30, device: 'auto', shadow: true },
  need: { device: 'cuda', cpu: { ramGB: 3.3 }, cuda: { ramGB: 1.5, vramGB: 2.5 } },
  ...over,
})

test('the budget table adds Laya to Now and Estimated peak, with each one\'s share, and counts it with the local model only while it is held', async () => {
  const { local, run } = await installed()
  const status = await local.status()
  const cellsWith = (laya) => byKey(helpers.budgetCells({ ...status, laya }))
  const figure = (c) => [c.text, c.note]
  const alone = cellsWith(undefined)
  // Laya on the GPU, llama.cpp not loaded: Now is Laya's own figure, and says whose it is.
  let cells = cellsWith(layaStatus())
  assert.deepEqual(figure(cells.maxVramGB.now), ['2.3 GB', 'Laya 2.3 GB, llama.cpp not loaded'])
  assert.deepEqual(figure(cells.maxRamGB.now), ['1.9 GB', 'Laya 1.9 GB, llama.cpp not loaded'])
  // Not held, it gives its memory up when a local model starts: the peak is the larger of the two,
  // never both, since llama.cpp's figure is the model it would load (Big, estimated).
  assert.deepEqual(figure(cells.maxVramGB.peak), ['4 GB', 'the larger of Laya 2.3 GB and llama.cpp 4 GB'])
  assert.deepEqual(figure(cells.maxRamGB.peak), ['2.7 GB', 'the larger of Laya 1.9 GB and llama.cpp 2.7 GB'])
  assert.match(cells.maxRamGB.peak.title, /^llama\.cpp: Big at 12k context, .*Laya is not held, so it gives its memory up when a local model starts, and the two are never counted together\.$/)
  // Held (Keep Laya loaded, or a Laya Auto run open), it stays beside the model, and both count.
  for (const held of [layaStatus({ running: { held: ['run:5f0c'] } }), layaStatus({ running: { held: ['keepLoaded'] } })]) {
    cells = cellsWith(held)
    assert.deepEqual(figure(cells.maxVramGB.peak), ['6.3 GB', 'Laya 2.3 GB, llama.cpp 4 GB'])
    assert.deepEqual(figure(cells.maxRamGB.peak), ['4.6 GB', 'Laya 1.9 GB, llama.cpp 2.7 GB'])
    assert.match(cells.maxRamGB.peak.title, /Laya is held \(Keep Laya loaded, or a Laya Auto run\), so it keeps its memory beside a local model, and the two are counted together\.$/)
  }
  // With the local model loaded beside it, Now is the two together, each named.
  await run('small', ['CUDA0 model buffer size = 2355.20 MiB', 'CPU model buffer size = 2867.20 MiB'])
  const loaded = byKey(helpers.budgetCells({ ...(await local.status()), laya: layaStatus() }))
  assert.deepEqual(figure(loaded.maxVramGB.now), ['4.6 GB', 'Laya 2.3 GB, llama.cpp 2.3 GB'])
  assert.deepEqual(figure(loaded.maxRamGB.now), ['4.7 GB', 'Laya 1.9 GB, llama.cpp 2.8 GB'])
  assert.equal(loaded.maxRamGB.now.title, "llama.cpp: What the loaded model took, from the engine's own load report. Its real use is read only while a RAM budget is set. Laya: what it takes now on the GPU.")
  assert.equal(loaded.maxVramGB.now.title, "llama.cpp: What the loaded model took, from the engine's own load report. Laya: what it takes now on the GPU.")
  // On the CPU it holds no GPU memory: the VRAM row is llama.cpp's alone.
  cells = cellsWith(layaStatus({ running: { device: 'cpu', vramGB: null, ramGB: 3.3 } }))
  assert.deepEqual(cells.maxVramGB, alone.maxVramGB)
  assert.deepEqual(figure(cells.maxRamGB.now), ['3.3 GB', 'Laya 3.3 GB, llama.cpp not loaded'])
  // Stopped, it holds nothing now, and the peak takes what its next start would.
  cells = cellsWith(layaStatus({ running: null, settings: { ...layaStatus().settings, keepLoaded: true } }))
  assert.deepEqual([cells.maxVramGB.now, cells.maxRamGB.now], [alone.maxVramGB.now, alone.maxRamGB.now])
  assert.deepEqual(figure(cells.maxVramGB.peak), ['6.5 GB', 'Laya 2.5 GB, llama.cpp 4 GB'])
  assert.match(cells.maxVramGB.peak.title, /Laya: what it would take at its next start, on the GPU\./)
  // Not installed, or a status with no figure: the table is llama.cpp's, as it always was.
  assert.deepEqual(cellsWith(null), alone)
  assert.deepEqual(cellsWith(layaStatus({ installed: null, running: null, need: null })), alone)
  assert.deepEqual(Object.keys(cellsWith(layaStatus())), Object.keys(alone), 'and the rows stay the four limits')
  await local.dispose()
})

test('with no local model the budget lets load, the Estimated peak is Laya\'s, and its note says why, never "llama.cpp no model"', async () => {
  const figure = (c) => [c.text, c.note]
  // No model installed, and models installed that the RAM budget refuses: either way none can load.
  const bare = await installed({}, { models: [] })
  const none = await bare.local.status()
  const refused = await installed()
  await refused.local.setSettings({ maxRamGB: 0.2 })
  const over = await refused.local.status()
  assert.ok(over.modules.filter((m) => m.kind === 'model' && m.state === 'installed').every((m) => m.overBudget), 'every installed model is over the budget')
  for (const status of [none, over]) {
    const cellsWith = (laya) => byKey(helpers.budgetCells({ ...status, laya }))
    for (const laya of [layaStatus(), layaStatus({ running: { held: ['keepLoaded'] } })]) {
      const cells = cellsWith(laya)
      assert.deepEqual(figure(cells.maxVramGB.peak), ['2.3 GB', 'Laya 2.3 GB; no local model the budget lets load'])
      assert.deepEqual(figure(cells.maxRamGB.peak), ['1.9 GB', 'Laya 1.9 GB; no local model the budget lets load'])
      assert.match(cells.maxRamGB.peak.title, /^Laya: what it takes now on the GPU\./)
    }
  }
  await bare.local.dispose()
  await refused.local.dispose()
})

test('the words under the table say what a held Laya costs the local models on the GPU, and the table shows Laya\'s share', async () => {
  const { local } = await installed()
  const status = await local.status()
  const notes = (laya) => helpers.budgetNotes({ ...status, laya }).map((n) => n.text)
  const held = 'While Laya is held (Keep Laya loaded, or a Laya Auto run), the VRAM budget holds Laya and the chat model together, and on a 4 GB GPU local models get about 2.3 GB less. Otherwise Laya gives the GPU up when a local model starts.'
  assert.ok(notes(layaStatus()).includes(held))
  assert.ok(notes(layaStatus({ running: null })).includes(held.replace('2.3 GB', '2.5 GB')), 'stopped, what its next start would take')
  assert.deepEqual(notes(layaStatus({ installed: { ...layaStatus().installed, cuda: false } })), notes(null), 'Laya installed for the CPU holds no GPU memory')
  assert.ok(!notes(null).some((t) => /Laya/.test(t)))
  // In the table, as the person reads it.
  const tree = loadPlugin().__test.ResourceBudget({ data: { ...status, laya: layaStatus() }, edits: {}, errors: {}, onEdit() {}, onSave() {} })
  const row = (label) => nodes(tree).find((n) => n.type === 'tr' && textOf(n.children[0]) === label)
  const now = (label) => textOf(row(label).children.filter((c) => c?.type === 'td')[1])
  assert.equal(now('VRAM'), '2.3 GB (Laya 2.3 GB, llama.cpp not loaded)')
  assert.equal(now('RAM'), '1.9 GB (Laya 1.9 GB, llama.cpp not loaded)')
  assert.ok(textOf(tree).includes(held))
  await local.dispose()
})

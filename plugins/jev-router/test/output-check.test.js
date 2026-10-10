// The speed run's output check (docs/benchmark.md 2.15), with no network and no real llama-server:
// the greedy request each model's measurement ends with, the baseline its first run keeps beside
// local.json, how a later output is held to it, a figure kept aside when its output differs until
// a person accepts it, and a new baseline for another engine build or GPU split. The fake
// llama-server of test/fixtures answers the greedy request with the text a test gives it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A namespace, so the file loads where local.js lacks what these tests are about, and each test
// fails by its own assertion there.
import * as localJs from '../local.js'
import { fakeLlamaServer, tokenOf } from './fixtures/fake-llama-server.mjs'

const GIB = 1024 ** 3
const sha = (s) => createHash('sha256').update(s).digest('hex')
const tmp = () => mkdtempSync(join(tmpdir(), 'jev-output-'))
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Today as a reading taken in this test is dated: "10 Oct". */
const today = (d = new Date()) => `${d.getDate()} ${MONTH[d.getMonth()]}`
const ENGINE = { id: 'eng', kind: 'engine', variant: 'cuda12', minCuda: 12.4, name: 'engine', source: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/e.zip', file: 'e.zip', size: 1, sha256: sha('e') }
const BIG = { id: 'big', kind: 'model', name: 'Big', source: 'https://huggingface.co/Org/Big-GGUF/resolve/main/big.gguf', file: 'big.gguf', size: 5 * GIB, sha256: sha('big'), reliability: 'official-stable', verified: true, role: 'best-quality', rank: 1, recommendedVramGB: 6.5, minRamGB: 12, contextSize: 16384, agent: { id: 'big-local', description: 'big' } }
// The owner's PC: Big runs fully on its 10 GB GPU unless a test's load report says otherwise.
const PC = { gpus: [{ name: 'NVIDIA GeForce RTX 3080', vendor: 'nvidia', vramGB: 10 }], cuda: 12.7, ramGB: 32, cpu: { name: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', threads: 12, cores: 6 }, diskFreeBytes: 200 * GIB }
const loadReport = (gpu) => [`load_tensors: offloaded ${gpu}/37 layers to GPU`, 'CUDA0 model buffer size = 4096.00 MiB', 'CPU model buffer size = 512.00 MiB']

/** 64 words, `w0` to `w63`, with those from `from` on spelt `x12` and so on: a greedy answer that leaves the first one after `from` of its 64 tokens. */
const answer = (from = 64) => Array.from({ length: 64 }, (_, i) => `${i < from ? 'w' : 'x'}${i}`).join(' ')

/**
 * The engine build `engine` and Big in place under `root`, as a hand install leaves them, over a
 * fake llama-server whose greedy answer is `said.text` (or what `said.answer` gives), whose load
 * report puts `said.gpu` of Big's 37 layers on the GPU, and whose speed is `said.generate` tokens a second.
 */
async function speedIn({ share, root = tmp(), engine = ENGINE, said = { text: answer(), gpu: 37, generate: 20 }, ...extra } = {}) {
  const server = fakeLlamaServer({ report: () => loadReport(said.gpu), speed: () => ({ generate: said.generate, read: 400 }), greedy: () => said.answer?.() ?? said.text })
  const engineDir = join(root, 'engine')
  const modelsDir = join(root, 'models')
  const data = join(root, 'data')
  mkdirSync(join(engineDir, '.installed'), { recursive: true })
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(join(engineDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), '')
  writeFileSync(join(engineDir, '.installed', 'eng.json'), JSON.stringify({ sha256: engine.sha256 }))
  writeFileSync(join(modelsDir, BIG.file), 'big')
  const local = localJs.createLocalModels({
    modules: [engine, BIG], engineDir, modelsDir, settingsFile: join(data, 'local.json'), speedLogDir: join(data, 'speed-runs'),
    specs: async () => PC, port: 0, spawn: server.spawn, fetch: server.fetch, findPort: async (from) => from,
    ...(share === undefined ? {} : { outputShare: share }), ...extra,
  })
  await local.installed()
  await local.settled()
  return { local, server, said, data, root }
}
/** One speed run of Big to its end: its line, as the card and the logs have it. */
async function measured(local) {
  await local.benchmark({ ids: ['big'] })
  for (const until = Date.now() + 10_000; (await local.status()).speedRun.state !== 'idle';) {
    assert.ok(Date.now() < until, 'the speed run ends')
    await new Promise((r) => setTimeout(r, 10))
  }
  return local.speedResults().done.at(-1)
}
const settings = (data) => JSON.parse(readFileSync(join(data, 'local.json'), 'utf8'))
const baselines = (data) => JSON.parse(readFileSync(join(data, 'speed-baselines.json'), 'utf8'))
const history = (data) => readFileSync(join(data, 'speed-runs', 'speed-runs.log'), 'utf8')
const detailLogs = (data) => readdirSync(join(data, 'speed-runs')).filter((f) => f.startsWith('speed-run-')).sort().map((f) => readFileSync(join(data, 'speed-runs', f), 'utf8'))
const big = async (local) => (await local.status()).modules.find((m) => m.id === 'big')

test('an output is held to its baseline from its first token: the same when it agrees for the share, in tokens when both carry ids and in characters otherwise; the key is the model, its weights, the engine build and the GPU split', () => {
  assert.equal(typeof localJs.compareOutput, 'function', 'local.js compares an output with its baseline')
  assert.equal(localJs.OUTPUT_SHARE, 0.5, 'half of the baseline by default: the first 32 of its 64 tokens')
  assert.equal(localJs.CHECK_PREDICT, 64)
  const ids = (from = 64) => answer(from).match(/\S+\s*/g).map(tokenOf)
  const base = { at: '2026-10-09T08:00:00.000Z', text: answer(), tokens: ids() }
  assert.deepEqual(localJs.compareOutput(base, { text: answer(), tokens: ids() }), { state: 'same', agreed: 64, of: 64, need: 32, unit: 'tokens', baselineAt: base.at })
  assert.deepEqual(localJs.compareOutput(base, { text: answer(12), tokens: ids(12) }), { state: 'differs', agreed: 12, of: 64, need: 32, unit: 'tokens', baselineAt: base.at })
  // Agreeing for 40 tokens is the same at half, and differs at three quarters (48 needed).
  assert.equal(localJs.compareOutput(base, { text: answer(40), tokens: ids(40) }).state, 'same')
  assert.deepEqual(localJs.compareOutput(base, { text: answer(40), tokens: ids(40) }, 0.75), { state: 'differs', agreed: 40, of: 64, need: 48, unit: 'tokens', baselineAt: base.at })
  // Without token ids on either side, the characters: `w0 ... w11 ` agree, 40 of them.
  const chars = localJs.compareOutput({ ...base, tokens: null }, { text: answer(12), tokens: ids(12) })
  assert.deepEqual(chars, { state: 'differs', agreed: answer(12).indexOf('x12'), of: answer().length, need: Math.ceil(answer().length / 2), unit: 'characters', baselineAt: base.at })

  const r = { weights: { file: 'big.gguf', sha256: sha('big') }, engine: { variant: 'cuda12', sha256: sha('e') }, gpuLayers: 'auto', layersOnGpu: { gpu: 37, total: 37 }, threads: 6, roomGB: 9 }
  const key = localJs.outputKey('big', r)
  assert.equal(key, `big; weights ${sha('big')}; cuda12 build ${sha('e')}; 37/37 layers on the GPU`)
  assert.notEqual(localJs.outputKey('big', { ...r, engine: { variant: 'cuda12', sha256: sha('e2') } }), key, 'another engine build')
  assert.notEqual(localJs.outputKey('big', { ...r, layersOnGpu: { gpu: 30, total: 37 } }), key, 'another GPU split')
  assert.notEqual(localJs.outputKey('big', { ...r, weights: { file: 'big.gguf', sha256: sha('big2') } }), key, 'other weights')
  assert.match(localJs.outputKey('big', { ...r, cpuMoe: { layers: 48, cpuLayers: 32 } }), /; 37\/37 layers on the GPU, the experts of 32 of 48 layers in RAM$/, '--n-cpu-moe')
  assert.match(localJs.outputKey('big', { ...r, layersOnGpu: null, gpuLayers: 20 }), /; GPU layers 20$/, 'the setting, when the engine did not say')
  assert.equal(localJs.outputKey('big', { ...r, threads: 4, roomGB: 6 }), key, 'threads and room change no output key')
})

test('a speed run ends each model with its output check: the fixed prompt decoded greedily, whose first answer is kept beside local.json as the baseline and held to after, said in the history, the detail log and the card\'s speed line', async () => {
  const { local, server, said, data } = await speedIn()
  const first = await measured(local)
  assert.equal(first.ok, true, first.text)
  // The last request: the fixed prompt as text, greedy, uncached, 64 tokens.
  const check = server.to('/completion').at(-1)
  assert.deepEqual(check.body, { prompt: localJs.CHECK_PROMPT, n_predict: 64, ignore_eos: true, cache_prompt: false, temperature: 0, top_k: 1, seed: 1, stream: true })
  const s1 = settings(data)
  assert.deepEqual(s1.speed['big@16384'].output, { state: 'baseline' })
  assert.deepEqual(s1.speedHeld, {})
  const kept = baselines(data)
  const key = localJs.outputKey('big', s1.speed['big@16384'])
  assert.deepEqual(Object.keys(kept), [key])
  assert.deepEqual(kept[key], { id: 'big', at: s1.speed['big@16384'].at, weights: sha('big'), engine: { variant: 'cuda12', sha256: sha('e') }, split: '37/37 layers on the GPU', text: answer(), tokens: answer().match(/\S+\s*/g).map(tokenOf) })
  // The same answer again: the same, and the new figure is the model's speed.
  said.generate = 25
  const second = await measured(local)
  assert.equal(second.text, 'Big: 25.0 tokens/s generating and 400 tokens/s reading, 8,192 tokens into a conversation, at 16k context.', 'the line says nothing more when the output is the same')
  const s2 = settings(data)
  assert.deepEqual(s2.speed['big@16384'].output, { state: 'same', agreed: 64, of: 64, need: 32, unit: 'tokens', baselineAt: s1.speed['big@16384'].at })
  assert.equal(s2.speed['big@16384'].tokensPerSec, 25)
  assert.deepEqual(baselines(data), kept, 'the baseline stays the first output')
  // The logs say which.
  const rows = history(data).split('\n')
  assert.deepEqual(rows.filter((l) => /^ {7}output /.test(l)), ['       output kept as the first baseline for this engine build and GPU split', `       output the same as the ${today()} baseline (its first 64 of 64 tokens agree, 32 needed)`])
  const [, detail] = detailLogs(data)
  assert.match(detail, /\nThen its output check: 64 tokens of a fixed prompt decoded greedily, held to the first output kept for the same weights, engine build and GPU split, with which at least 50% of it must agree from its start \(local\.outputCheckShare 0\.5\)\.\n/)
  assert.match(detail, /\d\d:\d\d:\d\d\.\d{3} {2}Big: output check, decoded greedily, not timed\n/)
  assert.ok(detail.includes(`  Big: output check answered 64 token ids: ${JSON.stringify(answer())}\n`), 'the answer itself, to read beside another run\'s')
  assert.match(detail, new RegExp(`\\d\\d:\\d\\d:\\d\\d\\.\\d{3} {2}Big: output the same as the ${today()} baseline \\(its first 64 of 64 tokens agree, 32 needed\\)\\n`))
  const row = await big(local)
  assert.deepEqual([row.speed.stands, row.speed.reading.output.state, row.speed.held], [true, 'same', undefined])
  await local.dispose()
})

test('output that differs from its baseline keeps its figure aside: the model\'s speed stays the reading it had until the new output is accepted, which makes it the baseline, and the logs say so', async () => {
  const { local, said, data } = await speedIn()
  await measured(local)
  const before = settings(data).speed['big@16384']
  // A faster run whose answer leaves the baseline after 12 tokens.
  said.text = answer(12)
  said.generate = 30
  const line = await measured(local)
  assert.equal(line.text, `Big: 30.0 tokens/s generating and 400 tokens/s reading, 8,192 tokens into a conversation, at 16k context. Its output differs from the ${today()} baseline after 12 tokens (32 needed), so this figure is not taken as its speed until the new output is accepted.`)
  assert.equal(line.held, true)
  const s = settings(data)
  assert.deepEqual(s.speed['big@16384'], before, 'the reading taken as its speed is the one it had')
  const held = s.speedHeld['big@16384']
  assert.equal(held.tokensPerSec, 30)
  assert.deepEqual(held.output, { state: 'differs', agreed: 12, of: 64, need: 32, unit: 'tokens', baselineAt: before.at, text: answer(12), tokens: answer(12).match(/\S+\s*/g).map(tokenOf), baselineText: answer() })
  // The card: the old reading stands, rated from it, and the held one beside it.
  const row = await big(local)
  assert.deepEqual([row.speed.reading.tokensPerSec, row.speed.stands, row.speed.held?.tokensPerSec, row.rating.source], [20, true, 30, 'measured'])
  assert.match(history(data), new RegExp(`\\n {7}output differs from the ${today()} baseline after 12 tokens \\(32 needed\\), so this figure is not taken as its speed until the new output is accepted\\n`))

  // Nothing else is accepted: a model with nothing held, or while a run goes.
  assert.equal(typeof local.acceptOutput, 'function', 'the local models accept new output')
  await assert.rejects(local.acceptOutput('nope'), (err) => err.status === 400 && err.message === 'nope has no new output waiting to be accepted.')
  // Accepted: the figure becomes its speed, marked, and the new output its baseline.
  const { reading } = await local.acceptOutput('big')
  const after = settings(data)
  assert.deepEqual(after.speedHeld, {})
  assert.equal(after.speed['big@16384'].tokensPerSec, 30)
  assert.deepEqual(reading, after.speed['big@16384'])
  const { acceptedAt, ...verdict } = after.speed['big@16384'].output
  assert.deepEqual(verdict, { state: 'accepted', agreed: 12, of: 64, need: 32, unit: 'tokens', baselineAt: before.at })
  assert.ok(Math.abs(Date.parse(acceptedAt) - Date.now()) < 60_000)
  const key = localJs.outputKey('big', after.speed['big@16384'])
  assert.equal(baselines(data)[key].text, answer(12))
  assert.deepEqual([(await big(local)).speed.reading.tokensPerSec, (await big(local)).speed.held], [30, undefined])
  assert.match(history(data), new RegExp(`\\n\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, Settings, Local models: accepted the new output of Big: its figure of ${today()}, 30\\.0 tokens/s generating, is its speed now, and that output the baseline its later runs are held to \\(it differed from the ${today()} baseline after 12 tokens\\)\\.\\n\\n$`))
  await assert.rejects(local.acceptOutput('big'), (err) => err.status === 400 && err.message === 'Big has no new output waiting to be accepted.')
  // The next run of the new output is the same as the accepted baseline.
  await measured(local)
  assert.equal(settings(data).speed['big@16384'].output.state, 'same')

  // A run going: accepting waits for it to end.
  said.text = answer(5)
  await measured(local)
  const fill = local.benchmark({ ids: ['big'] })
  await fill
  await assert.rejects(local.acceptOutput('big'), (err) => err.status === 409)
  for (const until = Date.now() + 10_000; (await local.status()).speedRun.state !== 'idle';) { assert.ok(Date.now() < until); await new Promise((r) => setTimeout(r, 10)) }
  await local.dispose()
})

test('a later run of the model that is not kept aside itself drops the figure kept aside before it, since the newest run describes the machine as it is now: one whose output is the same, and one left unchecked', async () => {
  const { local, said, data } = await speedIn()
  await measured(local)
  // Run 2 leaves the baseline after 12 tokens and is kept aside; run 3 repeats it and is the model's speed.
  said.text = answer(12)
  said.generate = 30
  assert.equal((await measured(local)).held, true)
  said.text = answer()
  said.generate = 25
  assert.equal((await measured(local)).held, undefined)
  const s = settings(data)
  assert.deepEqual([s.speed['big@16384'].tokensPerSec, s.speed['big@16384'].output.state], [25, 'same'])
  assert.deepEqual(s.speedHeld, {})
  assert.equal((await big(local)).speed.held, undefined)
  await assert.rejects(local.acceptOutput('big'), (err) => err.status === 400 && err.message === 'Big has no new output waiting to be accepted.')
  // Kept aside again, then a run whose output cannot be held to a baseline: its figure is taken, unchecked, and the held one goes.
  said.text = answer(12)
  assert.equal((await measured(local)).held, true)
  writeFileSync(join(data, 'speed-baselines.json'), '{ not json')
  said.generate = 22
  assert.equal((await measured(local)).held, undefined)
  const t = settings(data)
  assert.deepEqual([t.speed['big@16384'].tokensPerSec, t.speed['big@16384'].output.state], [22, 'unchecked'])
  assert.deepEqual(t.speedHeld, {})
  assert.equal((await big(local)).speed.held, undefined)
  await local.dispose()
})

test('another GPU split or engine build is another key, whose first output becomes its own baseline rather than differing, and the logs say how far it agrees with the baseline before it', async () => {
  const { local, said, data, root } = await speedIn()
  await measured(local)
  assert.deepEqual(settings(data).speed['big@16384'].output, { state: 'baseline' }, 'the first run keeps the baseline')
  // GPU layers changed: 30 of the 37 on the GPU, and an answer that agrees with the old one for 20 tokens.
  said.gpu = 30
  said.text = answer(20)
  said.generate = 15
  const line = await measured(local)
  assert.equal(line.held, undefined, line.text)
  const s = settings(data)
  assert.equal(s.speed['big@16384'].tokensPerSec, 15, 'taken as its speed')
  assert.deepEqual(s.speed['big@16384'].output, { state: 'baseline', also: { agreed: 20, of: 64, unit: 'tokens', baselineAt: Object.values(baselines(data))[0].at, other: 'another GPU split (37/37 layers on the GPU)' } })
  assert.deepEqual(Object.values(baselines(data)).map((b) => b.split), ['37/37 layers on the GPU', '30/37 layers on the GPU'])
  assert.match(history(data), new RegExp(`\\n {7}output kept as the first baseline for this engine build and GPU split; it agrees with the ${today()} baseline of another GPU split \\(37/37 layers on the GPU\\) for its first 20 of 64 tokens\\n`))
  await local.dispose()
  // Another engine build on the same split, as an update installs it: a baseline of its own again,
  // compared with the newest one of the build before, and an answer that agrees with it throughout.
  const update = await speedIn({ root, engine: { ...ENGINE, sha256: sha('e2') }, said })
  const built = await measured(update.local)
  assert.equal(built.held, undefined, built.text)
  const output = settings(data).speed['big@16384'].output
  assert.deepEqual([output.state, output.also?.other, output.also?.agreed], ['baseline', 'another engine build', 64])
  assert.equal(Object.keys(baselines(data)).length, 3)
  await update.local.dispose()
})

test('an output check that cannot be held to a baseline leaves the figure taken and unchecked, with why: llama-server refusing the request, an answer without token ids compared in characters, and a baselines file that cannot be read, which is never written over', async () => {
  const { local, said, data } = await speedIn({ share: 0.75 })
  said.answer = () => ({ error: 'the model produced nothing' })
  const refused = await measured(local)
  assert.equal(refused.text, 'Big: 20.0 tokens/s generating and 400 tokens/s reading, 8,192 tokens into a conversation, at 16k context. Its output was not checked: llama-server answered HTTP 500: the model produced nothing.')
  assert.deepEqual(settings(data).speed['big@16384'].output, { state: 'unchecked', why: 'llama-server answered HTTP 500: the model produced nothing' })
  // No token ids: the baseline is kept, and a later answer is held to it in characters, at three quarters.
  said.answer = () => ({ text: said.text, ids: false })
  await measured(local)
  assert.equal(Object.values(baselines(data))[0].tokens, null)
  said.text = answer(40)
  const line = await measured(local)
  assert.equal(line.held, true)
  const held = settings(data).speedHeld['big@16384'].output
  assert.deepEqual([held.unit, held.agreed, held.need], ['characters', answer(40).indexOf('x40'), Math.ceil(0.75 * answer().length)])
  // A baselines file that cannot be read: unchecked, and left as it was.
  writeFileSync(join(data, 'speed-baselines.json'), '{ not json')
  const unread = await measured(local)
  assert.match(unread.text, /Its output was not checked: speed-baselines\.json could not be read \(.+\)\.$/)
  assert.equal(readFileSync(join(data, 'speed-baselines.json'), 'utf8'), '{ not json')
  await local.dispose()
})

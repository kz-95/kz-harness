// The render check (docs/laya-auto.md 9.4 step 9, 9.5 step 5): does Laya read every option and
// every state view KzH sends it whole?
//
//   node scripts/laya-render-check.mjs [--harness <dir>] [--json]
//
// Builds every call KzH sends Laya, each at its largest (the four captured bodies, Test Laya's
// calls and the warm-up, and the jev.js builders at maximal inputs: every capability, strategy and
// tool, a long handoff, the named-agent pick, a review over 8 and 24 candidates), renders them
// with the Laya wire adapter exactly as the Laya client does, and has
// plugins/jev-router/test/e2e/check_render.py encode each one in Laya's own venv with Laya's own
// code and the tokenizer of the checkpoint installed in the harness. It prints
// `<n> options cut, <m> views cut` and every cut, and exits 1 when anything was cut or refused, 2
// when it could not run. The harness defaults to the one this script is in.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..', 'plugins', 'jev-router')
const CHECK = join(PLUGIN, 'test', 'e2e', 'check_render.py')
const plugin = (file) => import(pathToFileURL(join(PLUGIN, file)).href)

const LONG = (n, word) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')

/** Every call KzH sends Laya, each at its largest, as `{ name, phase, state, questions }`. */
export async function renderCalls() {
  const { createJev } = await plugin('jev.js')
  const { CAPABILITIES } = await plugin('capabilities.js')
  const { STRATEGIES } = await plugin('routing-policy.js')
  const { selfTestCalls, warmUpCalls } = await plugin('laya-selfcheck.js')

  // One jev.js builder call, taken from the client createJev sends through: nothing is sent, and
  // the call never settles.
  const built = (phase, call) => {
    let sent = null
    const client = { systemOne(body) { sent ??= body; return new Promise(() => {}) } }
    call(createJev({ client }))?.catch?.(() => {})
    if (!sent) throw new Error(`jev.js sent no ${phase} call`)
    return { phase, state: sent.state, questions: sent.questions }
  }

  const capabilities = Object.keys(CAPABILITIES).filter((c) => c !== 'human_required')
  const context = {
    gitRepo: true, productionCritical: true, branch: 'feature/checkout-rewrite',
    uncommittedFiles: Array.from({ length: 30 }, (_, i) => `src/checkout/step-${i}/component-${i}.tsx`), uncommittedFileCount: 64,
    trackedFileCount: 2400, fileTypes: { '.ts': 900, '.tsx': 700, '.js': 300, '.json': 200, '.md': 120, '.css': 90, '.yml': 50, '.sql': 40 },
    scripts: ['build', 'test', 'lint', 'typecheck', 'format', 'migrate', 'release'], dependencies: Array.from({ length: 25 }, (_, i) => `dependency-${i}`),
  }
  const tools = [
    { id: 'format_code', description: 'Runs prettier over the whole repository and then commits every formatted file as one single commit.', params: { scope: { question: 'Which files should be formatted by the formatter?', options: { all: 'Every file in the repository, including generated and vendored code', changed: 'Only the files changed on this branch compared with main' } } } },
    { id: 'bump_version', description: 'Bumps the package version in package.json and writes a changelog entry for it.', params: { level: { question: 'Which part of the version should change?', options: { major: 'A breaking change for every user', minor: 'A new feature', patch: 'A bug fix only' } } } },
    { id: 'regen_docs', description: 'Regenerates the API reference from the source comments.' },
  ]
  const named = [
    { id: 'claude', description: 'The Claude Code CLI, signed in with its own login and paid for by your Claude subscription.' },
    { id: 'codex', description: 'The OpenAI Codex CLI, signed in with its own login.' },
    { id: 'deepseek', description: 'The native harness agent on the DeepSeek API.' },
    { id: 'qwen-local', description: 'A local Qwen model on this PC.' },
  ]
  const candidate = (i) => ({
    id: `agent-${i}`, key: `RESOURCE_${String.fromCharCode(65 + i)}`, tier: ['frontier', 'strong', 'standard'][i % 3], source: 'subscription',
    capabilities: { coding: { score: 0.7, confidence: 0.6, samples: 9 } }, scarcity: 0.3, scarcityConfidence: 0.5, marginalCost: 'low',
    expectedCost: { total: 0.2, class: i % 2 ? 'low' : 'metered' }, latency: 'medium', availability: 'ok', reliability: { score: 0.8, confidence: 0.6 }, evidenceSamples: 12, fit: 0.5 + i / 30,
  })
  const review = (n) => {
    const cands = Array.from({ length: n }, (_, i) => candidate(i))
    return built('review', (jev) => jev.assess({
      task: LONG(300, 'task'),
      routing: { taskType: 'debugging', risk: 0.7, complexity: 0.6, decision: { candidates: cands, excluded: [] } },
      attempts: [
        { agent: 'agent-1', role: 'primary', stopReason: 'max_turns', answerText: LONG(200, 'earlier'), changedFiles: ['a.ts'] },
        { agent: 'agent-0', role: 'retry', stopReason: 'end_turn', answerText: LONG(600, 'answer'), changedFiles: context.uncommittedFiles },
      ],
      checks: { results: ['typecheck', 'lint', 'test', 'build'].map((name, i) => ({ name, passed: i !== 2, exitCode: i === 2 ? 1 : 0, durationMs: 900, output: `${name} said\n`.repeat(300) })), regressed: ['test'], fixed: [], failing: ['test'] },
      diff: { stat: context.uncommittedFiles.map((f) => ` ${f} | 9 +++++----`).join('\n'), patch: Array.from({ length: 500 }, (_, i) => `+ const line${i} = "quoted" // ${i}`).join('\n') },
      agents: cands.map((c) => ({ id: c.id, description: `The ${c.id} agent.` })),
    }))
  }
  const profile = { complexity: 0.4123, risk: 0.61, needsSecondOpinion: 0.55, needsHumanReview: 0.2, needsTests: 0.9, ...Object.fromEntries(['general_reasoning', 'architecture', 'planning', 'explanation', 'coding', 'debugging', 'security_review', 'code_review', 'testing', 'long_context'].map((d, i) => [`req_${d}`, i / 9])) }
  const maximal = [
    { name: 'intent, 700 words', ...built('intent', (jev) => jev.intent({ message: LONG(700, 'message') })) },
    { name: 'route task group, every capability, tools and a handoff', ...built('route', (jev) => jev.route({ task: LONG(400, 'task'), context, capabilities, tools, handoff: LONG(600, 'handoff'), ask: { task: true, resource: false, judgments: false } })) },
    { name: 'route resource and judgments, every strategy', ...built('route', (jev) => jev.route({ task: LONG(400, 'task'), candidates: [{ key: 'RESOURCE_A' }, { key: 'RESOURCE_B' }], strategies: Object.keys(STRATEGIES), taskProfile: profile, ask: { task: false, resource: true, judgments: true } })) },
    { name: 'route legacy named agent', ...built('route', (jev) => jev.route({ task: LONG(300, 'task'), context, agents: named, history: [{ task_type: 'debugging', first_agent: 'claude', attempts: 2, outcome: 'accepted' }], availability: { claude: 'ok', codex: 'near limit' }, trackRecord: { claude: { cost_tier: 'subscription', overall: { attempts: 4, accepted_rate: 0.75 } } } })) },
    { name: 'review, 8 anonymous candidates', ...review(8) },
    { name: 'review, 24 anonymous candidates', ...review(24) },
  ]
  const bodies = JSON.parse(readFileSync(join(PLUGIN, 'test', 'fixtures', 'kzh-bodies.json'), 'utf8'))
  const { protocol, pairs } = selfTestCalls()
  return [
    ...Object.entries(bodies).map(([name, b]) => ({ name: `captured ${name}`, ...b })),
    ...maximal,
    ...warmUpCalls({ full: true }).map((c) => ({ ...c, name: `warm-up ${c.name}` })),
    ...protocol.map((c) => ({ ...c, name: `Test Laya ${c.name}` })),
    ...pairs.flatMap((p) => [{ name: `Test Laya pair ${p.name} yes`, ...p.yes }, { name: `Test Laya pair ${p.name} no`, ...p.no }]),
  ]
}

/** Every request those calls become on the wire, as the Laya client renders an acting call. */
export async function renderRequests() {
  const { renderForLaya } = await plugin('laya-questions.js')
  return (await renderCalls()).flatMap((c) => renderForLaya({ phase: c.phase, state: c.state, questions: c.questions }, { role: 'act' })
    .map((r) => ({ call: c.name, key: r.key, state: r.state, questions: r.questions })))
}

/**
 * Runs the check in the harness's Laya venv against its installed checkpoint. Resolves the counts
 * and cuts check_render.py reports, with `calls`, `ms` and the snapshot it read.
 */
export async function renderCheck({ harnessDir = resolve(here, '..'), timeoutMs = 300_000 } = {}) {
  const { layaPaths, snapshotDir } = await plugin('laya-install.js')
  const paths = layaPaths({ harnessDir, dataDir: tmpdir() })
  const python = paths.pythonOf(paths.venv)
  if (!existsSync(python)) throw new Error(`Laya is not installed in ${harnessDir} (no ${python})`)
  const weights = JSON.parse(readFileSync(paths.weights, 'utf8'))
  const modelDir = snapshotDir(paths.hf, weights.repo, weights.commit)
  if (!existsSync(join(modelDir, 'rl_agent_config.json'))) throw new Error(`no checkpoint at ${modelDir}`)
  const requests = await renderRequests()
  const dir = mkdtempSync(join(tmpdir(), 'kzh-render-check-'))
  const file = join(dir, 'requests.json')
  writeFileSync(file, JSON.stringify(requests))
  const env = { ...process.env, HF_HOME: paths.hf, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' }
  for (const k of Object.keys(env)) if (/^TYPESAFE_/i.test(k) || k.toUpperCase() === 'HF_TOKEN') delete env[k]
  const t0 = Date.now()
  try {
    const { code, out, err } = await new Promise((done, fail) => {
      const child = spawn(python, ['-I', '-X', 'utf8', CHECK, '--model-dir', modelDir, '--requests', file], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', fail)
      child.on('exit', (code) => { clearTimeout(timer); done({ code, out, err }) })
    })
    if (code !== 0) throw new Error(`check_render.py exited ${code}: ${err.trim().split('\n').slice(-5).join(' | ')}`)
    const line = out.trim().split('\n').at(-1)
    return { ...JSON.parse(line), calls: new Set(requests.map((r) => r.call)).size, ms: Date.now() - t0, modelDir }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const where = (c) => `${c.call} / ${c.request} / ${c.question}`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--harness')
  const harnessDir = at >= 0 ? resolve(args[at + 1] ?? '') : resolve(here, '..')
  let r
  try { r = await renderCheck({ harnessDir }) } catch (err) { console.error(`laya-render-check: ${err.message}`); process.exit(2) }
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`${r.calls} calls, ${r.requests} requests, ${r.rows} question rows, encoded by Laya with ${r.modelDir}`)
    for (const c of r.optionsCut) console.log(`option cut: ${where(c)}: ${c.option} kept ${c.kept} of ${c.of} tokens`)
    for (const c of r.viewsCut) console.log(`view cut: ${where(c)}: state kept ${c.kept} of ${c.of} tokens`)
    for (const c of r.headsCut) console.log(`instructions cut: ${where(c)}: kept ${c.kept} of ${c.of} tokens`)
    for (const c of r.refused) console.log(`refused by Laya: ${where(c)}: ${c.why}`)
    console.log(`${r.optionsCut.length} options cut, ${r.viewsCut.length} views cut${r.headsCut.length ? `, ${r.headsCut.length} instructions cut` : ''}${r.refused.length ? `, ${r.refused.length} refused` : ''}`)
  }
  process.exit(r.optionsCut.length || r.viewsCut.length || r.refused.length ? 1 : 0)
}

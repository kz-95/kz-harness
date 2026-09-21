// jev-router: DSH plugin. TypeSafe Jev routes each coding task to one of the
// registered agents, deterministic checks verify the result, and Jev assesses
// it (accept / second review / retry / human) within configured limits.
//
// Executors are DSH subagent providers, so auth and permissions stay native:
//   claude   -> @deepseek-ai/dsh-subagent-claude-code (Claude subscription login)
//   codex    -> @deepseek-ai/dsh-subagent-codex       (ChatGPT login)
//   deepseek -> built-in `spawn` provider              (DSH's DeepSeek model)
// A new agent is one `agents` entry naming any installed subagent provider.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createJev } from './jev.js'
import { formatReport, pricingNow, runRouted } from './router.js'
import { LEVELS, codexServiceTier } from './effort.js'
import { run } from './workspace.js'
import { authAction, canAuth, checkAgents } from './setup.js'
import { JEV_PROVIDER, jevAdapter, line, nameOfAgent, queuedLine } from './adapter.js'
import { executorsFrom } from './capabilities.js'
import { createDelivery } from './delivery.js'
import { createFormatter } from './format.js'
import { createFeedback, validFeedback } from './feedback.js'
import { TERMINAL_STATES, createLanes, createTasks, laneKey, validJobId } from './tasks.js'
import { SESSION_ID, exportSession, redactSecrets } from './export.js'
import { KEY_NAME, createAccounts, keyProviderOf, kindOf, parseUse } from './accounts.js'
import { createUsage, detectLimit, longWindowPercent } from './usage.js'
import { LOCAL_PROVIDER, buildCatalog, createConnectivity, createLocalModels, detectSpecs, installLlmCommand, localAdapter, looksLikeQuestion, readManifest, removeLlmCommand } from './local.js'

export const name = 'jev-router'
export const inject = ['tools', 'commands', 'subagents', 'credentials']

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const harnessDir = fileURLToPath(new URL('../../', import.meta.url))
const LOCAL_PERSONA = 'You are a careful software engineer working as a delegated coding agent on a small local model. Keep changes small and focused, complete the task in the given workspace, and report concisely.'
// How many runs one /jev-router/history response carries, newest last. The cap is a response
// size, not a storage rule: history.jsonl keeps every run.
const HISTORY_RESPONSE_CAP = 200

const Agent = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9_-]*$/).required().description('Short id, also the manual override command name.'),
  provider: Schema.string().required().description('Subagent provider name, e.g. claude-code, codex, spawn.'),
  name: Schema.string().description('Shown in the model menu, the inspector and reports. Defaults to the id, title-cased.'),
  description: Schema.string().required().description('Strengths shown to Jev when choosing. A prior, not a rule.'),
  enabled: Schema.boolean().default(true),
  persona: Schema.string().description('Optional persona for providers that accept one (spawn).'),
  credentialRef: Schema.string().description('API key credential that must be set for this agent to run (BYOK agents).'),
  peer: Schema.string().description('Agent that takes over when this one hits its limit (default: claude <-> codex).'),
  llm: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).description('Model for `spawn` agents, e.g. any provider added in Settings -> Models (BYOK). Required, or the agent inherits Jev as its model.'),
})

const Tool = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9_-]*$/).required(),
  description: Schema.string().required().description('What the tool does exactly. Jev picks it only when it fully covers the task.'),
  command: Schema.string().required().description('Shell command, run in the workspace. The task text arrives on stdin; each param as env var JEV_ARG_<PARAM>.'),
  params: Schema.dict(Schema.object({
    question: Schema.string().required(),
    options: Schema.dict(String).required().description('value -> description; Jev picks one.'),
  })).default({}),
  enabled: Schema.boolean().default(true),
})

export const Config = Schema.object({
  agents: Schema.array(Agent).default([
    {
      id: 'claude',
      name: 'Claude Code',
      provider: 'claude-code',
      description: 'Claude Code: architecture, planning, large-context understanding, complex cross-file reasoning, ambiguous requirements.',
      enabled: true,
    },
    {
      id: 'codex',
      name: 'Codex (GPT)',
      provider: 'codex',
      description: 'OpenAI Codex: implementation, debugging, repository modification, targeted fixes, writing and running tests.',
      enabled: true,
    },
    {
      id: 'deepseek',
      name: 'DeepSeek agent',
      provider: 'spawn',
      description: 'DeepSeek (native harness agent): independent analysis, code review, second opinions, reasoning, broad investigation.',
      enabled: true,
      credentialRef: 'DEEPSEEK_API_KEY',
      llm: { provider: 'deepseek', model: 'deepseek-flash' },
      persona: 'You are a careful senior software engineer working as a delegated coding agent. Complete the task in the given workspace and report concisely.',
    },
  ]).description('Cloud and subscription agents. Local agents (qwen-local, gemma-local, …) come from config/local-models.json once their model is installed.'),
  tools: Schema.array(Tool).default([]).description('Deterministic scripts Jev can run instead of an LLM agent.'),
  auxModel: Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
  }).default({}).description('Real model the Jev Auto model hands session titles, conversation compaction and direct answers to. Unset, these follow this machine: the installed local chat model when there is one, then the first enabled agent that pins llm.provider and llm.model. Set both to pin one.'),
  local: Schema.object({
    port: Schema.natural().default(8081).description('First 127.0.0.1 port for llama-server; the next ones are tried when it is taken.'),
    contextSize: Schema.natural().min(2048).description('Context tokens for every local model; unset = the model\'s manifest value (16,384), 12,288 on PCs with under 12 GB RAM.'),
  }).description('Local models (llama.cpp llama-server under <harness>/engine/llama, GGUF files under <harness>/models).'),
  format: Schema.object({
    enabled: Schema.boolean().default(true).description('Rewrite a finished background result into readable prose with the installed local chat model before it is posted. Off, the report is posted exactly as the agent wrote it.'),
    timeoutMs: Schema.natural().min(1000).default(60_000).description('Wall clock for one rewrite call; on timeout the report is posted as written.'),
    reserveTokens: Schema.natural().default(2048).description('Context kept back for the prompt and the answer when sizing the report body against the model window.'),
  }).default({}).description('Message transfer: the result body is rewritten by the small local model when one is installed. Only the report body changes; the structured head (task, id, agent, status) is never touched.'),
  effort: Schema.object({
    default: Schema.union(LEVELS).default('auto').description('Effort when the model menu says Auto.'),
    perAgent: Schema.object({
      claude: Schema.union(['low', 'medium', 'high', 'xhigh', 'max']),
      codex: Schema.union(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      deepseek: Schema.union(['off', 'low', 'high', 'max']),
    }).default({}).description('Fixed effort per agent; wins over the menu and the default.'),
    codexSpeed: Schema.union(['normal', 'fast']).default('normal').description('fast = Codex 1.5x (service tier priority).'),
  }).default({}),
  pricing: Schema.object({
    peak: Schema.dict(Schema.object({
      windowsUtc: Schema.array(Schema.object({
        fromUtc: Schema.string().pattern(/^\d{1,2}:\d{2}$/).required().description('Window start, UTC "HH:MM".'),
        toUtc: Schema.string().pattern(/^\d{1,2}:\d{2}$/).required().description('Window end, UTC "HH:MM"; an end at or before the start wraps past midnight.'),
      })).default([]).description('The hours the dearer rate applies. Everything outside them is off-peak.'),
      daysUtc: Schema.array(Schema.number().min(0).max(6)).default([1, 2, 3, 4, 5]).description('UTC days peak applies, 0 = Sunday. The default is Monday to Friday.'),
      note: Schema.string().description('Shown to Jev, e.g. what the difference costs.'),
    })).default({
      // DeepSeek charges double during Beijing business hours only: Mon-Fri 09:00-12:00 and
      // 14:00-18:00 CST, which is 01:00-04:00 and 06:00-10:00 UTC. Everything else, every
      // evening and the whole weekend, is already the cheap rate. Confirmed from DeepSeek's
      // 2026-09-10 pricing notice; check https://api-docs.deepseek.com/quick_start/pricing
      // and edit here if they move it.
      deepseek: {
        windowsUtc: [{ fromUtc: '01:00', toUtc: '04:00' }, { fromUtc: '06:00', toUtc: '10:00' }],
        daysUtc: [1, 2, 3, 4, 5],
        note: 'DeepSeek peak is exactly twice off-peak on every line: output 8 vs 4 CNY per million tokens',
      },
    }).description('Agent id -> the hours its provider charges its DEARER rate. Jev prefers an agent on its cheap rate when the choice is otherwise even.'),
  }).default({}).description('Time-of-day pricing, for the providers that have it.'),
  links: Schema.dict(Schema.object({
    keys: Schema.string().description('Where this provider issues API keys.'),
    topUp: Schema.string().description('Where this provider takes payment.'),
  })).default({
    // console.typesafe.ai/keys and /billing both resolve (307 to login), so both are real.
    // DeepSeek serves 403 to anything unauthenticated, so /top_up could not be checked:
    // api_keys is known good, and the rest is editable here if it ever moves.
    deepseek: { keys: 'https://platform.deepseek.com/api_keys', topUp: 'https://platform.deepseek.com/top_up' },
    jev: { keys: 'https://console.typesafe.ai/keys', topUp: 'https://console.typesafe.ai/billing' },
  }).description('Per key-provider links shown on the Usage cards: where to get a key, where to top up.'),
  policy: Schema.object({
    gateAtPercent: Schema.dict(Schema.number().min(0).max(100)).default({
      // Past this share of its WEEKLY window a subscription stops doing bulk work and is
      // kept for reviewing, where its remaining percent buys the most. Set per plan:
      // Claude Pro 80 / Max 90; Codex Plus 80 / Pro 90. The plan cannot be detected
      // reliably (the live endpoint reports none, and the cached credential lags an
      // upgrade), so this is yours to set rather than something guessed for you.
      default: 80,
    }).description('Agent id -> weekly percent at which it stops taking execution work. "default" applies to the rest.'),
    minRoutingConfidence: Schema.number().min(0).max(1).default(0.5)
      .description('Below this confidence Jev is treated as undecided, and a metered pick is swapped for a subscription agent it rated about the same.'),
    tieMargin: Schema.number().min(0).max(1).default(0.1)
      .description('How close another agent must be to the top pick to count as tied, for the swap above.'),
    stallAfter: Schema.number().min(1).max(10).default(2)
      .description('Work attempts in a row that change no files before the run stops and asks a person, instead of retrying again.'),
  }).default({}).description('Cost policy: how far a subscription is spent on bulk work before the API takes over.'),
  fallbackAgent: Schema.string().default('claude').description('Agent used when Jev is unavailable.'),
  credentialRef: Schema.string().default('TYPESAFE_API_KEY').description('Credential name for the TypeSafe API key (env, .credentials.yaml, or .env).'),
  jevModel: Schema.string().default('jev-1.13.0').description('TypeSafe model id, pinned so tuned thresholds keep their meaning.'),
  jevTimeoutMs: Schema.natural().default(20_000),
  agentTimeoutMs: Schema.natural().default(20 * 60_000),
  limits: Schema.object({
    maxAttempts: Schema.natural().min(1).default(3).description('Primary attempt plus retries.'),
    maxReviews: Schema.natural().default(2),
    maxRounds: Schema.natural().min(1).default(5).description('All agent runs, work and review.'),
  }),
  thresholds: Schema.object({
    accept: Schema.object({
      low: Schema.number().min(0).max(1).default(0.55),
      medium: Schema.number().min(0).max(1).default(0.7),
      high: Schema.number().min(0).max(1).default(0.85),
    }).description('Minimum review quality to accept, by routing risk (< 0.25, < 0.6, else).'),
    secondOpinion: Schema.number().min(0).max(1).default(0.6),
    humanReview: Schema.number().min(0).max(1).default(0.7),
    needsTests: Schema.number().min(0).max(1).default(0.5),
    tool: Schema.number().min(0).max(1).default(0.5).description('Minimum "tool fits" probability to run a tool instead of an agent.'),
  }),
  checks: Schema.object({
    enabled: Schema.boolean().default(true),
    scripts: Schema.array(String).default(['typecheck', 'lint', 'test', 'build']).description('package.json scripts to run when present, in order.'),
    timeoutMs: Schema.natural().default(10 * 60_000),
    outputChars: Schema.natural().default(3000),
  }),
  productionWorkspaces: Schema.array(String).default([]).description('Path prefixes Jev is told are production-critical.'),
  historyFile: Schema.string().default(join(dshHome, 'jev-router', 'history.jsonl')),
  registerTool: Schema.boolean().default(true).description('Expose the jev_route tool (used by the Jev Auto preset).'),
  savings: Schema.object({
    baseline: Schema.object({
      name: Schema.string().default('Chat LLM front desk (DeepSeek Flash)'),
      inputPerMTok: Schema.number().min(0).default(0.28).description('Assumed USD per million input tokens.'),
      outputPerMTok: Schema.number().min(0).default(1.1).description('Assumed USD per million output tokens.'),
      outputTokens: Schema.natural().default(300).description('Assumed output tokens per decision.'),
      latencyMs: Schema.natural().default(4000).description('Assumed time per decision.'),
    }).description('The "without Jev" setup the Usage tab estimate compares against: a chat LLM making each Jev decision. Assumptions, not quoted prices.'),
    agentMedianFallbackMs: Schema.natural().default(10_000).description('Agent run time assumed until the usage log has completed agent runs.'),
  }),
})

function textOf(blocks) {
  return (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
}

/**
 * Run a configured tool in the workspace; its output is the attempt's answer.
 * The task text goes to stdin only, never into the environment or the command
 * line: cmd.exe expands %VAR% before parsing & | ", so free text there is
 * command injection. JEV_ARG_* values are safe: they are option keys from config.
 */
function runTool(cwd, timeoutMs) {
  return async (tool, args, task, signal) => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(args).map(([k, v]) => [`JEV_ARG_${k.toUpperCase()}`, v])) }
    const r = await run(tool.command, [], { cwd, shell: true, env, input: task, timeoutMs, signal })
    return {
      stopReason: r.code === 0 ? 'completed' : 'error',
      diagnostic: r.code === 0 ? undefined : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}: ${r.output.slice(-500)}`,
      answerText: r.output.slice(-8000),
    }
  }
}

export function apply(ctx, config) {
  // A spawn agent without a pinned model inherits the parent's model, which is Jev itself.
  const unpinned = config.agents.filter((a) => a.provider === 'spawn' && !(a.llm?.provider && a.llm?.model))
  if (unpinned.length) throw new Error(`jev-router: spawn agents need llm: { provider, model }: ${unpinned.map((a) => a.id).join(', ')}`)
  if (config.auxModel.provider === JEV_PROVIDER) throw new Error('jev-router: auxModel must be a real model, not Jev')
  const dataDir = dirname(config.historyFile)
  // Like/Dislike on a finished answer, next to history.jsonl, read back by the router below.
  const feedback = createFeedback({ file: join(dataDir, 'feedback.jsonl') })
  // ponytail: reads the whole file; switch to a tail read if history grows past a few MB.
  const allRecords = async () => {
    const raw = await readFile(config.historyFile, 'utf8').catch(() => '')
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
  const history = {
    async recent(cwd, n) {
      return (await allRecords()).filter((r) => r.workspace === cwd).slice(-n)
        .map((r) => ({ task_type: r.routing?.taskType, first_agent: r.routing?.primaryAgent, attempts: r.attempts?.length, outcome: r.finalStatus }))
    },
    // Full rows for trackRecord: what each agent costs, how it has done here, and whether it is
    // on its cheap rate right now. Without this the router silently skips all of that and Jev
    // picks with no cost or history prior at all.
    records: allRecords,
    // The same priors path as history.jsonl, one file over: the router reads it to demote an
    // agent whose picks were disliked and promote one whose picks were liked.
    feedback: (sessionId) => feedback.list(sessionId),
    async append(record) {
      await mkdir(dataDir, { recursive: true })
      await appendFile(config.historyFile, `${JSON.stringify(record)}\n`)
    },
  }

  // Setup-page state, layered over config: on/off switches and user-added
  // API-key (BYOK) agents. At least one LLM agent always stays on.
  const setupFile = join(dataDir, 'agents.json')
  const readSetup = async () => {
    let raw
    try { raw = await readFile(setupFile, 'utf8') } catch (err) { if (err.code === 'ENOENT') return { disabled: [], custom: [] }; throw err }
    // A damaged file must not read as empty: the next save would erase every added agent.
    const s = JSON.parse(raw)
    return { disabled: s.disabled ?? [], custom: s.custom ?? [] }
  }
  // All read-modify-write of the setup file goes through one queue, so quick toggles never overwrite each other.
  let setupQueue = Promise.resolve()
  const mutateSetup = (fn) => {
    const next = setupQueue.then(async () => saveSetup(await fn(await readSetup())))
    setupQueue = next.catch(() => {})
    return next
  }
  const customAgent = (c) => ({
    id: c.id,
    provider: 'spawn',
    description: c.description,
    enabled: true,
    custom: true,
    llm: { provider: c.provider, model: c.model },
    persona: 'You are a careful senior software engineer working as a delegated coding agent. Complete the task in the given workspace and report concisely.',
  })
  // Local agents: one per installed model module (config/local-models.json), refreshed when a module changes.
  let localAgents = []
  const allAgents = (s) => [...config.agents, ...localAgents, ...s.custom.map(customAgent)]
  const enabledAgents = async () => {
    const s = await readSetup()
    return allAgents(s).map((a) => ({ ...a, kind: kindOf(a), peer: a.peer ?? PEERS[a.id], enabled: a.enabled && !s.disabled.includes(a.id) }))
  }
  async function saveSetup(s) {
    if (!allAgents(s).some((a) => a.enabled && !s.disabled.includes(a.id))) throw new Error('at least one LLM agent must stay on')
    await mkdir(dataDir, { recursive: true })
    const tmp = `${setupFile}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2))
    await rename(tmp, setupFile)
    readyGen++
    readyCache = null
    // Which agents are on can change the aux fallback; refresh it now.
    resolveAux()
  }

  // Login status per agent, cached so routing does not shell out on every message.
  // A check that started before a newer one (or before a setup change) never overwrites it.
  let readyCache = null
  let readyGen = 0
  let readyPending = null
  const resolveCredential = (ref) => ctx.credentials.resolve(ref)
  async function readiness(force = false) {
    if (force) { readyGen++; readyPending = null }
    else if (readyCache && Date.now() - readyCache.at < 5 * 60_000) return readyCache.value
    if (!readyPending) {
      const gen = readyGen
      readyPending = readSetup().then(async (s) => {
        const list = allAgents(s)
        const value = await checkAgents(list.filter((a) => kindOf(a) !== 'local'), resolveCredential)
        // Local agents: ready when their model file and the engine are present; no login, no quota.
        for (const a of list.filter((x) => kindOf(x) === 'local')) value[a.id] = await local.readiness(a.llm.model)
        return value
      }).then((value) => {
        if (gen === readyGen) readyCache = { at: Date.now(), value }
        return value
      }).finally(() => { if (gen === readyGen) readyPending = null })
    }
    return readyPending
  }

  // Accounts (keys, limits, logins) and usage (quota, state, usage.jsonl).
  const accounts = createAccounts({
    dataDir,
    envFile: join(dshHome, '.env'),
    credentials: ctx.credentials,
    jevCredentialRef: config.credentialRef,
    codexAccount: () => usage.codexAccount(),
  })
  const usage = createUsage({ dataDir, accounts })

  // Local models (llama-server on 127.0.0.1), installed module by module from config/local-models.json.
  let modules = []
  try { modules = readManifest(join(harnessDir, 'config', 'local-models.json')) } catch (err) { process.stdout.write(`[jev] local: manifest not loaded: ${err.message}\n`) }
  let specsCache = null
  const specs = () => {
    if (!specsCache || Date.now() - specsCache.at > 10 * 60_000) specsCache = { at: Date.now(), value: detectSpecs({ dir: join(harnessDir, 'models') }) }
    return specsCache.value
  }
  let llmRuntime = null
  let refreshing = null
  let localLoaded = false
  const refreshLocal = () => (refreshing ??= local.agents(LOCAL_PERSONA).then(async (list) => {
    // A model installed while KzH runs gets its agent switched on, even if it was switched off before a removal.
    // The first load at startup keeps the person's on/off choices.
    const added = localLoaded ? list.filter((a) => !localAgents.some((x) => x.id === a.id)).map((a) => a.id) : []
    localAgents = list
    localLoaded = true
    if (added.length && (await readSetup()).disabled.some((id) => added.includes(id))) {
      await mutateSetup((s) => ({ ...s, disabled: s.disabled.filter((id) => !added.includes(id)) })).catch(() => {})
    }
    readyGen++; readyCache = null
    try { llmRuntime?.emit?.('llm/adapters-updated') } catch {}
  }).catch(() => {}).finally(() => { refreshing = null }))
  const local = createLocalModels({
    modules,
    engineDir: join(harnessDir, 'engine', 'llama'),
    modelsDir: join(harnessDir, 'models'),
    settingsFile: join(dataDir, 'local.json'),
    port: config.local.port,
    contextSize: config.local.contextSize,
    specs,
    log: (t) => process.stdout.write(`[jev] ${t}\n`),
    onChange: () => { refreshLocal(); resolveAux() },
  })
  ctx.effect(() => () => { local.dispose() })
  refreshLocal()
  // Hugging Face download counts: a tie-breaker for suggestions only, cached a day, skipped offline.
  let hfCache = { at: 0, value: {} }
  const hfDownloads = async () => {
    if (Date.now() - hfCache.at < 86_400_000 || !(await connectivity.online())) return hfCache.value
    hfCache = { at: Date.now(), value: hfCache.value }
    const repos = [...new Set(modules.map((m) => m.hfRepo).filter(Boolean))]
    const got = await Promise.all(repos.map((r) => fetch(`https://huggingface.co/api/models/${r}`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).then((j) => [r, j.downloads ?? 0], () => null)))
    hfCache.value = Object.fromEntries(got.filter(Boolean))
    return hfCache.value
  }
  const catalog = async () => buildCatalog(local, await specs(), { downloads: await hfDownloads().catch(() => ({})) })
  const connectivity = createConnectivity()
  const isOffline = async () => !(await connectivity.online())
  const localChat = async () => { const id = await local.chatModel(); return id ? { provider: LOCAL_PROVIDER, model: id } : null }
  // Titles, compaction and direct answers need one real chat model, and none is assumed:
  // a hidden DeepSeek default sent that housekeeping to api.deepseek.com for everyone. An
  // unpinned auxModel follows this machine instead, local chat model first, then the first
  // enabled agent that pins a provider and model. The object is live; the adapter holds this
  // reference and reads it per call, so a model installed later is picked up without a
  // restart. An empty pair means neither was found: the request fails and its caller falls
  // through, never to a DeepSeek call nobody asked for.
  let auxResolved = { provider: '', model: '' }
  const auxPinned = () => (config.auxModel.provider && config.auxModel.model ? { provider: config.auxModel.provider, model: config.auxModel.model } : null)
  const resolveAux = async () => {
    const pinned = auxPinned()
    if (pinned) { auxResolved = pinned; return }
    const local = await localChat().catch(() => null)
    if (local) { auxResolved = local; return }
    const first = (await enabledAgents().catch(() => [])).find((a) => a.enabled && a.llm?.provider && a.llm?.model)
    auxResolved = first ? { provider: first.llm.provider, model: first.llm.model } : { provider: '', model: '' }
  }
  const auxModel = {
    get provider() { return auxResolved.provider },
    get model() { return auxResolved.model },
  }
  // The chat models a direct answer may use: the aux model when one resolved, then the
  // installed local chat model. Only complete pairs are offered, because the capability
  // registry refuses an executor with an empty name.
  const chatPair = async () => {
    const local = await localChat().catch(() => null)
    const aux = auxResolved.provider && auxResolved.model ? { provider: auxResolved.provider, model: auxResolved.model } : null
    const same = !!aux && !!local && aux.provider === local.provider && aux.model === local.model
    return [aux, same ? null : local].filter(Boolean)
  }
  resolveAux()
  accounts.ready().catch((err) => process.stdout.write(`[jev] accounts not loaded: ${err.message}
`))

  // Quota for routing: never waits long; an unanswered fetch leaves the agent 'unknown', which does not block.
  async function quotaFor(agents) {
    await accounts.clearExpired().catch(() => {})
    const snap = await Promise.race([
      usage.snapshot(agents).catch(() => null),
      new Promise((r) => setTimeout(r, 4000, null)),
    ]) ?? usage.last()?.out ?? {}
    // weeklyPercent is what the subscription-first policy rations; it was computed
    // upstream and thrown away here, which is why that policy was unimplementable.
    return Object.fromEntries(Object.entries(snap).map(([id, q]) => [id, {
      state: q.state, until: q.until, kind: q.kind, weeklyPercent: longWindowPercent(q.windows), summary: summaryOf(q),
    }]))
  }

  // A Jev client on the active jev key; on 429/402 it moves to the next jev key and retries the call once.
  async function makeJev({ onTrace, runId, emit }) {
    await accounts.ready().catch(() => {})
    let name = accounts.activeKey('jev')
    let value = name ? await accounts.resolveKey('jev', name) : undefined
    if (!value) { name = 'default'; value = (await resolveCredential(config.credentialRef).catch(() => undefined))?.value }
    if (!value) return null
    const build = () => createJev({
      apiKey: value,
      model: config.jevModel,
      timeoutMs: config.jevTimeoutMs,
      onTrace: (t) => {
        onTrace(t)
        // model and request id together: the two things a TypeSafe support query needs.
        usage.logJev({ runId, account: name, phase: t.phase, ms: t.ms, model: t.model, requestId: t.requestId, tokens: { input: t.usage?.input_tokens ?? 0, output: t.usage?.output_tokens ?? 0 } }).catch(() => {})
      },
    })
    let client = build()
    const call = (method) => async (...args) => {
      try { return await client[method](...args) } catch (err) {
        if (err?.status !== 429 && err?.status !== 402) throw err
        const until = new Date(Date.now() + (err.status === 402 ? 24 : 1) * 3600_000).toISOString()
        await accounts.markExhausted(`jev:${name}`, { until, reason: `HTTP ${err.status}` })
        const next = accounts.nextKey('jev')
        if (!next) throw err
        await accounts.activate('jev', next)
        const nextValue = await accounts.resolveKey('jev', next)
        if (!nextValue) throw err
        emit({ type: 'limit', at: Date.now(), agent: 'jev', until, action: 'rotated' })
        name = next; value = nextValue; client = build()
        return await client[method](...args)
      }
    }
    return { route: call('route'), assess: call('assess'), intent: call('intent') }
  }

  // Task or question? Questions are answered directly by a chat model instead of running agents in the workspace.
  // `mode` is the picked Jev row; 'offline' keeps this on the local heuristic.
  // Without Jev (no key, error) everything is a task, as before.
  async function classify(message, mode) {
    // Offline mode is a choice, not a network state: it must not call out even with the internet up.
    if (mode === 'offline' || await isOffline()) return { kind: looksLikeQuestion(message) ? 'question' : 'task', offline: true }
    const jev = await makeJev({ onTrace: () => {}, runId: 'intent', emit: () => {} }).catch(() => null)
    if (!jev) return { kind: 'task' }
    try { return await jev.intent({ message }, AbortSignal.timeout(config.jevTimeoutMs)) } catch { return { kind: 'task' } }
  }

  // The model each agent runs, for the "Answered by" line. Claude and Codex use their own settings
  // unless the executor pins one; read at most once a minute.
  let modelCache = { at: 0, claude: null, codex: null }
  function refreshModels() {
    if (Date.now() - modelCache.at < 60_000) return
    modelCache.at = Date.now()
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const codexDir = process.env.CODEX_HOME || join(homedir(), '.codex')
    readFile(join(claudeDir, 'settings.json'), 'utf8').then((t) => { modelCache.claude = JSON.parse(t).model ?? null }).catch(() => {})
    readFile(join(codexDir, 'config.toml'), 'utf8').then((t) => { modelCache.codex = t.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null }).catch(() => {})
  }
  function modelOf(agentDef) {
    if (!agentDef) return undefined
    if (agentDef.llm?.model) return agentDef.llm.model
    refreshModels()
    if (agentDef.provider === 'claude-code') return modelCache.claude ?? undefined
    if (agentDef.provider === 'codex') return modelCache.codex ?? undefined
    return undefined
  }
  refreshModels()

  const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString()
  const keyOut = (provider, name) => ['stopped', 'exhausted'].includes(usage.last()?.keys?.[provider]?.find((k) => k.name === name)?.state)
  // Latest reset among the fullest windows: when a subscription agent is usable again.
  const resetOf = (id) => {
    const w = usage.last()?.out?.[id]?.windows ?? []
    const top = Math.max(...w.map((x) => x.usedPercent))
    return w.filter((x) => x.usedPercent === top).map((x) => x.resetsAt).filter(Boolean).sort().at(-1) ?? null
  }

  // A real limit error: api agents move to the next key of their provider (the same agent may run
  // again); subscriptions, and api agents with no usable key left, count as exhausted until reset.
  async function onLimit(a, { until, reason } = {}) {
    if (!a) return { rotated: false }
    const provider = kindOf(a) === 'api' ? keyProviderOf(a) : null
    const active = provider && accounts.activeKey(provider)
    if (active) {
      await accounts.markExhausted(`${provider}:${active}`, { until: until ?? hoursFromNow(6), reason })
      const next = accounts.nextKey(provider, (n) => keyOut(provider, n))
      // A key that only applies after a restart cannot help this run.
      if (next && !(await accounts.activate(provider, next)).restartRequired) return { rotated: true, key: next }
    }
    await accounts.markExhausted(a.id, { until: until ?? (kindOf(a) === 'subscription' ? resetOf(a.id) : null) ?? hoursFromNow(1), reason })
    return { rotated: false }
  }

  // Before routing: an active key already known to be spent gives way to the next usable one.
  async function rotateSpentKeys(agents) {
    for (const p of new Set(agents.filter((a) => a.enabled).map(keyProviderOf).filter(Boolean))) {
      const active = accounts.activeKey(p)
      const next = active && keyOut(p, active) ? accounts.nextKey(p, (n) => keyOut(p, n)) : null
      if (next) await accounts.activate(p, next).catch(() => {})
    }
  }

  // Switch exactly these agents on and the rest off (the /use command and POST /agents/only).
  async function useOnly(ids) {
    await mutateSetup((s) => ({ ...s, disabled: allAgents(s).map((a) => a.id).filter((id) => !ids.includes(id)) }))
    return ids
  }
  const switchable = async () => allAgents(await readSetup()).filter((a) => a.enabled).map((a) => a.id)

  // Router decision log per session, for the Jev inspector. Memory only; history.jsonl is the durable record.
  const logs = new Map() // sessionId -> runs [{ id, startedAt, task, events }], most recently used last
  function logRun(sessionId, task) {
    const runs = logs.get(sessionId) ?? []
    const entry = { id: randomUUID(), startedAt: Date.now(), task, events: [] }
    runs.push(entry)
    if (runs.length > 20) runs.shift()
    logs.delete(sessionId)
    logs.set(sessionId, runs)
    if (logs.size > 50) logs.delete(logs.keys().next().value)
    return entry
  }
  const stoppers = new Map() // log run id -> AbortController, while the run is active (POST /runs/stop)

  // Subagents inherit the jev_route tool and would re-route their own prompt, nesting forever.
  // Also stops two routes editing the same workspace at once.
  const active = new Set()
  async function route({ task, agent, forceAgent, answerOnly, effort, mode = 'auto', laneHeld = false, modalities, signal = new AbortController().signal, emit, onEntry }) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('cannot determine the session workspace; open a workspace first')
    const key = resolve(cwd).toLowerCase()
    // A nested agent calling jev_route would deadlock on the lane its own parent holds,
    // so that case still refuses outright rather than waiting.
    if (active.has(key)) throw new Error('already routing a task in this workspace; wait for it to finish (a nested agent must do its task directly, not call jev_route)')
    // One queue per workspace for every caller. Background tasks and slash commands
    // used to hold two independent mutexes, which let both run in one working tree.
    const release = laneHeld ? () => {} : await lanes.acquire(key, `route-${randomUUID()}`, signal)
    active.add(key)
    const sessionId = sessionIdOf(agent) ?? cwd
    const entry = logRun(sessionId, task)
    onEntry?.(entry)
    const stop = new AbortController()
    stoppers.set(entry.id, stop)
    signal = AbortSignal.any([signal, stop.signal])
    const runId = randomUUID()
    // Each step also goes to the server log, which the Kz-harness app shows in its log window.
    const onEvent = (e) => { entry.events.push({ ...e, text: line(e) }); emit?.(e); process.stdout.write(`[jev] ${redactLine(line(e))}\n`) }
    try {
      const onTrace = (trace) => onEvent({ type: 'jev', at: Date.now(), trace })
      // Review runs on this same client (router's default createReview), so it shares key rotation and the usage log.
      // Offline: no Jev at all (fixed routing rule, deterministic review), so nothing waits on a dead network.
      // 'local' keeps Jev routing but only over local models; 'offline' also drops Jev.
      const localOnly = mode === 'local' || mode === 'offline'
      const offline = mode === 'offline' || await isOffline()
      const jev = offline ? null : await makeJev({ onTrace, runId, emit: onEvent })
      const agents = await enabledAgents()
      await rotateSpentKeys(agents)
      const quota = await quotaFor(agents)
      const byId = new Map(agents.map((a) => [a.id, a]))
      const accountOf = (a) => (kindOf(a) === 'subscription' ? usage.last()?.out?.[a.id]?.account?.email ?? null : accounts.activeKey(keyProviderOf(a)) ?? a.credentialRef ?? null)

      const execute = async (agentDef, prompt, agentSignal, { effort: eff, speed } = {}) => {
        // Claude Code and Codex executors take no per-run options: they read these from process.env
        // when the run starts (Claude: SDK child env; Codex: patched turn/start, see README).
        // ponytail: process-wide env, two workspaces starting Claude/Codex in the same instant can swap efforts.
        if (agentDef.provider === 'claude-code') setEnv('CLAUDE_CODE_EFFORT_LEVEL', eff)
        if (agentDef.provider === 'codex') { setEnv('KZ_CODEX_EFFORT', eff); setEnv('KZ_CODEX_SERVICE_TIER', codexServiceTier(speed)) }
        const sub = await ctx.subagents.start(agentDef.provider, {
          label: `jev:${agentDef.id}`,
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          signal: agentSignal,
          ...(agentDef.persona ? { persona: agentDef.persona } : {}),
          // In-process children see global tools; hide the router so an agent never re-routes its own task.
          ...(agentDef.provider === 'spawn' && config.registerTool ? { toolFilter: { deny: ['jev_route'] } } : {}),
          // Pin the model: a spawn child otherwise inherits the parent's (Jev) model and routes back into Jev.
          ...(agentDef.llm?.provider && agentDef.llm?.model ? { agentOptions: { provider: agentDef.llm.provider, model: agentDef.llm.model, ...(eff ? { reasoningEffort: eff } : {}) } } : {}),
        })
        try {
          const r = await sub.result
          return { stopReason: r.stopReason, diagnostic: r.diagnostic, answerText: textOf(r.output), usage: r.usage }
        } finally {
          await sub.dispose().catch(() => {})
        }
      }

      // Which agents can be handed an image. A fact about their own tool loop, not a guess.
      const seesImages = new Set()
      for (const a of agents) if (await agentSeesImages(a.id).catch(() => false)) seesImages.add(a.id)

      const result = await runRouted({
        task,
        cwd,
        sessionId,
        forceAgent,
        answerOnly,
        effort,
        config: { ...config, agents, effort: await readEffort() },
        signal,
        deps: {
          ready: await readiness(),
          jev,
          offline,
          localOnly,
          jevUnavailableReason: offline ? (mode === 'offline' ? 'offline mode: local models and checks only' : 'offline: no internet, checks only') : `${config.credentialRef} not configured`,
          // Capability routing: what each executor on this machine really is, so code can drop
          // the ones that cannot do this request before Jev is asked (and check its pick after).
          executors: executorsFrom({
            agents,
            tools: config.tools ?? [],
            chat: await chatPair(),
            seesImages: (id) => seesImages.has(id),
          }),
          inputModalities: modalities ?? ['text'],
          execute,
          runTool: runTool(cwd, config.agentTimeoutMs),
          modelOf,
          emit: onEvent,
          history,
          quota,
          isLimitError: detectLimit,
          onLimit: (agentId, info) => onLimit(byId.get(agentId), info),
          // Only metered keys need re-reading; a subscription's window is rationed by the gate,
          // and a local model costs nothing.
          checkBalance: async (agentId) => {
            const a = byId.get(agentId)
            if (!a || kindOf(a) !== 'api') return null
            const snap = await usage.snapshot([a], { force: true }).catch(() => null)
            const q = snap?.[agentId]
            return q ? { state: q.state, balance: q.balance ?? null, until: q.until ?? null } : null
          },
          logAttempt: (entry) => {
            // This run's id (shared with its Jev call lines) and normalized token counts win over the router's.
            const { tokens: u, runId: _routerRunId, answerText: _a, ...rest } = entry
            const a = byId.get(entry.agent)
            return usage.logAttempt({
              ...rest, runId, sessionId, workspace: cwd, provider: a?.provider ?? null, account: a ? accountOf(a) : null,
              tokens: u ? { input: u.inputTokens ?? u.input ?? 0, output: u.outputTokens ?? u.output ?? 0, cacheRead: u.cacheReadTokens ?? u.cacheRead ?? 0, reasoning: u.reasoningTokens ?? u.reasoning ?? 0 } : null,
              costUsd: rest.costUsd ?? null, quotaBefore: quota[entry.agent]?.summary ?? null, quotaAfter: usage.last()?.out?.[entry.agent] ? summaryOf(usage.last().out[entry.agent]) : null,
            }).catch(() => {})
          },
        },
      })
      return formatReport(result)
    } catch (err) {
      onEvent({ type: 'error', at: Date.now(), message: err.message })
      throw err
    } finally {
      active.delete(key)
      release()
      stoppers.delete(entry.id)
    }
  }

  // --- Background tasks -------------------------------------------------
  // A routed task runs as a DSH background job so the chat stays free, and one
  // at a time per workspace (a lane) so two agents never edit the same folder.
  // The result is posted into the chat on the session's next turn.
  const lanes = createLanes()

  // The delivery path lives in its own module so it can be tested (test/delivery.test.js): it is
  // the path a person's result travels, and inside this closure it had no test at all. It needs
  // the task registry, which is built just below with a callback that calls it, so the reference
  // is filled in immediately afterwards.
  let delivery = null
  // The finished result body is rewritten by this before it is posted. Filled in by the llm block
  // below, once the local chat model can be asked; until then (and with no local model) it no-ops.
  let formatter = null
  const tasks = createTasks({
    file: join(dataDir, 'tasks.jsonl'),
    lanes,
    // Optional service: without the tool-jobs plugin there is no job controller,
    // enqueue() returns null and the adapter runs the task blocking, as before.
    // ctx.jobs THROWS when 'jobs' is not in this plugin's inject list, rather than
    // returning undefined, so ask for it the way an optional service must be asked.
    // Absent (no tool-jobs plugin) means enqueue() returns null and tasks run blocking.
    jobs: () => { try { return ctx.get?.('jobs') ?? null } catch { return null } },
    // The result goes to its conversation the moment the task settles, and keeps trying if
    // that first attempt does not land.
    onSettled: (result, owner) => { delivery.deliverWithRetry(result, owner).catch(() => {}) },
    log: (m) => process.stdout.write(`[jev] ${m}
`),
    run: (t, { signal, emit, onEntry }) => {
      // Read before the first emit: `t.agent` becomes the agent the router picked.
      const forceAgent = t.agent ?? undefined
      // Only say "waiting" when something is actually ahead of it.
      if (lanes.busy(laneKey(t.workspace))) emit({ type: 'queued' })
      return lanes.acquire(laneKey(t.workspace), t.jobId, signal).then(async (release) => {
        try {
          return await route({ task: t.task, agent: t.owner, forceAgent, effort: t.effort ?? undefined, mode: t.mode ?? 'auto', laneHeld: true, modalities: t.modalities ?? ['text'], signal, emit, onEntry })
        } finally { release() }
      })
    },
  })
  // Filled in now that the registry exists; onSettled above only dereferences it once a task
  // actually settles, which cannot happen before this line has run.
  delivery = createDelivery({
    tasks,
    log: (m) => process.stdout.write(`[jev] ${m}\n`),
    // Lazy: the formatter is built by the llm block below and is null until then.
    format: (r, text) => (formatter ? formatter(r, text) : text),
  })

  const orchestrator = {
    /** Unread finished results for this session, in the order they finished. */
    results: (sessionId) => tasks.results(sessionId),
    /** How much is still in flight here, so a notice turn can say something true. */
    live: (sessionId) => tasks.list().filter((t) => t.sessionId === sessionId && !TERMINAL_STATES.includes(t.state)).length,
    /** The result is being rendered now; still unread until delivered(). */
    delivering: (jobId) => tasks.delivering(jobId),
    /** The result's message was accepted: stop offering it. */
    delivered: (jobId) => tasks.delivered(jobId),
    /** Queue one chat task; returns the chat line, or null when background jobs are unavailable. */
    // `modalities` rides along: dropped here the task record falls back to text, the capability
    // filter stops requiring image support, and an attached picture reaches an agent that is blind to it.
    enqueue({ agent, task, effort, forceAgent, mode, sessionId, modalities }) {
      const cwd = agent?.session?.header?.cwd
      if (!cwd) throw new Error('cannot determine the session workspace; open a workspace first')
      // sessionId comes from the caller that will also read the results back.
      const t = tasks.enqueue({ owner: agent, sessionId: sessionId ?? sessionIdOf(agent) ?? cwd, workspace: cwd, task, forceAgent, effort, mode, modalities })
      if (!t) return null
      // Counted, not read from the lane: the job joins the lane a tick after enqueue returns.
      const key = laneKey(cwd)
      const ahead = tasks.list().filter((x) => x.jobId !== t.jobId && laneKey(x.workspace) === key && !TERMINAL_STATES.includes(x.state)).length
      return queuedLine({ jobId: t.jobId, agent: t.agent, position: ahead ? ahead + 1 : 0, workspace: cwd })
    },
  }

  ctx.commands.register({
    name: 'use',
    description: 'Switch on exactly these agents, e.g. /use claude ds, /use gpt, /use all (aliases: gpt/chatgpt = codex, ds = deepseek, cc = claude)',
    input: { hint: '<agents…> | all' },
    handler: async ({ rawInput }) => {
      try {
        const on = await useOnly(parseUse(rawInput, await switchable()))
        return { kind: 'success', text: `Agents on: ${on.join(', ')}` }
      } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })

  // Slash commands: /auto lets Jev choose; /<agent-id> forces that agent (post-review still runs).
  // Local models from the chat. A bare /install-llm or /remove-llm opens the picker in the browser
  // (client.js decorates these commands); these server handlers serve the typed forms and any client without the picker.
  ctx.commands.register({
    name: 'install-llm',
    description: 'Install a local model (llama.cpp, runs on this PC, works offline). Bare: picker with suggestions for this PC',
    input: { hint: '[id… | all]' },
    handler: async ({ rawInput }) => {
      try { return await installLlmCommand(rawInput, { local, catalog }) } catch (err) { return { kind: 'error', text: `install-llm: ${err.message}` } }
    },
  })
  ctx.commands.register({
    name: 'remove-llm',
    description: 'Remove an installed local model or the engine. Bare: picker; typed form asks you to repeat it with "confirm"',
    input: { hint: '[id…] [confirm]' },
    handler: async ({ rawInput }) => {
      try { return await removeLlmCommand(rawInput, { local }) } catch (err) { return { kind: 'error', text: `remove-llm: ${err.message}` } }
    },
  })

  ctx.commands.register({
    name: 'auto',
    description: 'Jev routes this task to the best agent, verifies, and reviews the result',
    input: { hint: '<task>' },
    handler: async ({ agent, rawInput, signal }) => {
      const task = rawInput.trim()
      if (!task) return { kind: 'error', text: 'Usage: /auto <task>' }
      try { return { kind: 'success', text: await route({ task, agent, signal }) } } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
    },
  })
  for (const a of config.agents.filter((x) => x.enabled)) {
    ctx.commands.register({
      name: a.id,
      description: `Run this task on ${a.id} (manual override); Jev still reviews the result`,
      input: { hint: '<task>' },
      handler: async ({ agent, rawInput, signal }) => {
        const task = rawInput.trim()
        if (!task) return { kind: 'error', text: `Usage: /${a.id} <task>` }
        try { return { kind: 'success', text: await route({ task, agent, forceAgent: a.id, signal }) } } catch (err) { return { kind: 'error', text: `jev-router: ${err.message}` } }
      },
    })
  }

  if (config.registerTool) {
    ctx.tools.register({
      name: 'jev_route',
      description: 'Hand a coding task to the Jev router. Jev picks Claude Code, Codex or DeepSeek, the agent works in the current workspace, tests/typecheck/lint/build run, and Jev assesses the result. Returns a structured report. Pass the user\'s request verbatim.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The user\'s request, verbatim.' },
          agent: { type: 'string', enum: ['auto', ...config.agents.filter((x) => x.enabled).map((x) => x.id)], description: 'Leave as auto unless the user named an agent.' },
        },
        required: ['task'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const forceAgent = args.agent && args.agent !== 'auto' ? args.agent : undefined
        return await route({ task: args.task, agent: exec.agent, forceAgent, signal: exec.signal })
      },
    })
  }

  // Models the setup page offers for new BYOK agents: everything in Settings -> Models except Jev itself.
  let llm = null
  async function modelProviders() {
    if (!llm) return []
    const out = []
    for (const p of llm.listProviders().filter((x) => x.id !== JEV_PROVIDER)) {
      const models = await llm.listModels(p.id).catch(() => [])
      if (models.length) out.push({ id: p.id, name: p.name ?? p.id, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) })
    }
    return out
  }

  const knownProviders = async () => ['deepseek', 'jev', ...(await modelProviders()).map((p) => p.id)]

  // What a model really takes, asked of the catalog it is registered with: the same
  // declaration the engine's own gate reads, so the picker and the gate cannot disagree.
  async function canSeeImages(m) {
    if (!m?.provider || !m?.model) return false
    const info = await llm?.resolveModel?.(m.provider, m.model).catch(() => null)
    return info?.inputModalities?.includes('image') === true
  }
  // Claude Code and Codex own their tool loop, so they open an image file we name. Every other
  // agent is an in-process model, which reads an image only when that model itself accepts one.
  const OWNS_IMAGE_READING = new Set(['claude-code', 'codex'])
  const agentSeesImages = async (agentId) => {
    const a = (await enabledAgents().catch(() => [])).find((x) => x.id === agentId)
    if (!a) return false
    return OWNS_IMAGE_READING.has(a.provider) || await canSeeImages(a.llm)
  }
  /**
   * Attached image bytes, for an agent that cannot be handed content blocks: written where the
   * agent's own tools can open them, so the path can travel in the prompt. Under the workspace's
   * .kz-harness folder - already git-excluded locally, and already never counted as a change an
   * agent made - so a sandboxed agent reads it as an ordinary project file.
   */
  async function handOffImages(refs, { cwd } = {}) {
    const store = ctx.get?.('attachments')
    if (!store || !cwd || !refs?.length) return []
    const dir = join(cwd, '.kz-harness', 'attachments')
    await mkdir(dir, { recursive: true })
    const out = []
    for (const ref of refs) {
      const img = await store.readImageRequest(ref, { maxPixels: 4_000_000, maxBytes: 8_000_000 }, AbortSignal.timeout(20_000))
      const ext = String(img.mediaType).split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
      const name = String(ref.attachmentId ?? randomUUID()).replace(/[^\w.-]/g, '')
      const file = join(dir, `${name || randomUUID()}.${ext}`)
      await writeFile(file, img.data)
      out.push(file)
    }
    return out
  }

  // Display names for the browser half: providers and models from the live catalog,
  // agents from their own config entry. No table of names in the client, so a new
  // provider, model or agent names itself everywhere it is shown.
  async function displayNames() {
    const providers = { jev: 'Jev' }
    const models = {}
    for (const p of await modelProviders()) {
      providers[p.id] = p.name
      for (const m of p.models) models[`${p.id}/${m.id}`] = m.name
    }
    const agents = { jev: 'Jev', chat: 'Chat model' }
    for (const a of await enabledAgents().catch(() => [])) agents[a.id] = nameOfAgent(a)
    return { providers, models, agents }
  }

  // "Jev Auto" in the model picker: every message goes straight to the router, no chat model in front.
  ctx.inject(['llm', 'agents'], (c) => {
    llm = c.llm
    llmRuntime = c
    // Message transfer: the local chat model rewrites a finished result body into prose. Built
    // here because `c.llm` is what it streams through; it is asked only when a result settles.
    formatter = createFormatter({
      stream: (opts) => c.llm.stream(opts),
      chatModel: () => local.chatModel(),
      contextOf: (id) => local.contextOf(id),
      enabled: config.format?.enabled ?? true,
      timeoutMs: config.format?.timeoutMs ?? 60_000,
      reserveTokens: config.format?.reserveTokens ?? 2048,
      log: (m) => process.stdout.write(`[jev] ${m}\n`),
    })
    c.effect(() => () => { llm = null; llmRuntime = null; formatter = null })
    c.effect(() => c.llm.registerAdapter([JEV_PROVIDER], jevAdapter({
      ctx: c, route, classify, auxModel, isOffline, localChat, orchestrator, agents: enabledAgents,
      canSeeImages, agentSeesImages, handOffImages,
      // Direct answers route through the same registry as background work: a chat model is
      // offered for what it can actually do, and its provider/model ride along so the answer
      // can be streamed from it.
      answerExecutors: async () => {
        const chat = await chatPair()
        const sees = new Set()
        for (const m of chat) if (await canSeeImages(m).catch(() => false)) sees.add(m.model)
        return executorsFrom({ chat, seesImages: (id) => sees.has(id) }).map((e) => {
          const [provider, ...model] = e.id.replace(/^chat:/, '').split('/')
          return { ...e, provider, model: model.join('/') }
        })
      },
      // A question answered without an agent: the "Saved by Jev" estimate counts these.
      onDirectAnswer: (durationMs, m) => usage.logAttempt({ agent: 'chat', role: 'direct-answer', durationMs, provider: m.provider, model: m.model }).catch(() => {}),
    })))
    // Local models in the picker and for local agents: our own adapter, so a request can start llama-server first.
    c.effect(() => c.llm.registerAdapter([LOCAL_PROVIDER], localAdapter(local, { attachments: () => c.get?.('attachments') })))
  })

  // DSH project folders: the only places the Terminal button may open a terminal.
  let workspaceRegistry = null
  ctx.inject(['workspaceRegistry'], (c) => {
    workspaceRegistry = c.workspaceRegistry
    c.effect(() => () => { workspaceRegistry = null })
  })
  const hotkeysFile = join(dataDir, 'hotkeys.json')
  // Effort settings from Settings -> Jev setup, over the Config defaults.
  const effortFile = join(dataDir, 'effort.json')
  const readEffort = async () => { try { return Config.dict.effort({ ...config.effort, ...JSON.parse(await readFile(effortFile, 'utf8').catch(() => '{}')) }) } catch { return config.effort } }

  // HTTP routes for the browser half (inspector tab, setup page), behind DSH's own Host/Origin/cookie checks.
  ctx.inject(['webServer', 'connection'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'prefix',
      path: '/jev-router',
      handler: async (req, res) => {
        const deny = c.connection.requestRejection(req)
        if (deny) { res.statusCode = deny; return res.end() }
        // Writes need a JSON body type: a cross-site form cannot send one without a CORS preflight.
        if (req.method !== 'GET' && !isJsonRequest(req)) { res.statusCode = 415; return res.end() }
        const url = new URL(String(req.url), 'http://localhost')
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET' && url.pathname === '/jev-router/logo.png') {
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'max-age=86400')
            return res.end(await readFile(new URL('./assets/logo.png', import.meta.url)))
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/log') return send(200, logs.get(url.searchParams.get('session')) ?? [])
          // The durable record, not the in-memory tail above: every run this session ever wrote to
          // history.jsonl, newest last, returned as stored. A truncated final line (a crash mid
          // append) is skipped by allRecords the same way tasks.jsonl reading skips one, so a bad
          // last line cannot hide the runs before it.
          if (req.method === 'GET' && url.pathname === '/jev-router/history') {
            const session = url.searchParams.get('session')
            if (!SESSION_ID.test(session ?? '')) return send(400, { error: 'session: a session id' })
            const all = (await allRecords()).filter((r) => r.sessionId === session)
            const records = all.slice(-HISTORY_RESPONSE_CAP)
            return send(200, { session, total: all.length, returned: records.length, truncated: all.length > records.length, records })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/runs/stop') {
            const { runId } = JSON.parse(await readBody(req))
            const stop = stoppers.get(runId)
            // A background task aborts through its own controller, so it settles as stopped, not failed.
            const task = tasks.stopRun(runId)
            if (!stop && !task) return send(404, { error: 'no active run with that id' })
            for (const runs of logs.values()) for (const r of runs) if (r.id === runId) r.stopped = true
            stop?.abort(new Error('stopped by the user'))
            return send(200, { ok: true })
          }
          // Export one chat as Markdown, read from DSH's own stored session log.
          if (req.method === 'GET' && url.pathname === '/jev-router/export') {
            const session = url.searchParams.get('session') ?? ''
            if (!SESSION_ID.test(session)) return send(400, { error: 'session: a session id' })
            try {
              return send(200, await exportSession(join(dshHome, 'sessions'), session, { tools: url.searchParams.get('tools') !== '0' }))
            } catch (err) { return send(err.status ?? 500, { error: err.message }) }
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/names') return send(200, await displayNames())
          // Background tasks: the task list column (queued / running / finished).
          if (req.method === 'GET' && url.pathname === '/jev-router/tasks') {
            await tasks.ready
            const ws = url.searchParams.get('workspace')
            const all = tasks.list()
            return send(200, { tasks: ws ? all.filter((t) => laneKey(t.workspace) === laneKey(ws)) : all })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/tasks/report') {
            await tasks.ready // a task restored from tasks.jsonl has a report before the list is asked for
            const report = tasks.report(url.searchParams.get('id') ?? '')
            return report === null ? send(404, { error: 'no report for that task' }) : send(200, { report })
          }
          if (req.method === 'POST' && url.pathname.startsWith('/jev-router/tasks/')) {
            const body = JSON.parse(await readBody(req))
            try {
              if (url.pathname === '/jev-router/tasks/stop') return send(200, { result: tasks.stop(validJobId(body.jobId)) })
              if (url.pathname === '/jev-router/tasks/reorder') { tasks.reorder(body.workspace, body.order ?? []); return send(200, { ok: true }) }
              if (url.pathname === '/jev-router/tasks/clear') return send(200, { cleared: tasks.clear(body.jobIds ?? []) })
              // The browser reporting that it has actually rendered these result messages. This
              // is the only thing that marks a result read, which is what "unread" means.
              if (url.pathname === '/jev-router/tasks/seen') {
                await tasks.ready
                const seen = (body.jobIds ?? []).map((id) => { try { return validJobId(id) } catch { return null } }).filter(Boolean)
                return send(200, { acknowledged: seen.filter((id) => tasks.delivered(id)) })
              }
            } catch (err) { return send(err.status ?? 400, { error: err.message }) }
          }
          // Shortcuts page: key bindings and the right sidebar width, one small JSON file.
          if (req.method === 'GET' && url.pathname === '/jev-router/effort') return send(200, await readEffort())
          if (req.method === 'POST' && url.pathname === '/jev-router/effort') {
            if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return send(415, { error: 'JSON only' })
            let clean
            try { clean = Config.dict.effort(JSON.parse(await readBody(req))) } catch (err) { return send(400, { error: err.message }) }
            await mkdir(dataDir, { recursive: true })
            await writeFile(`${effortFile}.tmp`, JSON.stringify(clean, null, 2))
            await rename(`${effortFile}.tmp`, effortFile)
            return send(200, clean)
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/hotkeys') {
            const raw = await readFile(hotkeysFile, 'utf8').catch((err) => { if (err.code === 'ENOENT') return '{}'; throw err })
            return send(200, JSON.parse(raw))
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/hotkeys') {
            const clean = validHotkeys(JSON.parse(await readBody(req)))
            await mkdir(dataDir, { recursive: true })
            await writeFile(`${hotkeysFile}.tmp`, JSON.stringify(clean, null, 2))
            await rename(`${hotkeysFile}.tmp`, hotkeysFile)
            return send(200, clean)
          }
          // Like/Dislike on a finished answer, with the person's reason and an optional tag
          // saying what the verdict was about. The client posts one verdict per answer message;
          // a later verdict for the same message replaces the earlier one on read, tag included.
          // A verdict of `clear` appends the tombstone instead, and the GET stops reporting that
          // message, so a cleared verdict survives a reload. An unknown tag is rejected here with
          // a 400 by validFeedback, before it is stored. The GET is for the inspector and for a
          // page that reloads.
          if (req.method === 'POST' && url.pathname === '/jev-router/feedback') {
            let record
            try { record = validFeedback(JSON.parse(await readBody(req))) } catch (err) { return send(400, { error: err.message }) }
            return send(200, { ok: true, record: await feedback.append(record) })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/feedback') {
            const session = url.searchParams.get('session')
            if (session !== null && !SESSION_ID.test(session)) return send(400, { error: 'session: a session id' })
            return send(200, { feedback: await feedback.list(session ?? undefined) })
          }
          // Sign in / out of an agent by running its own CLI. The client sends an agent id and
          // "login" or "logout", never a command: the command is chosen here, by provider.
          if (req.method === 'POST' && url.pathname === '/jev-router/account-auth') {
            const { agentId, action } = JSON.parse(await readBody(req))
            const agent = (await enabledAgents()).find((a) => a.id === agentId)
            if (!agent || !canAuth(agent.provider)) return send(400, { error: 'that agent has no sign-in of its own' })
            if (action !== 'login' && action !== 'logout') return send(400, { error: 'action must be login or logout' })
            // A visible terminal, because the CLI asks questions and opens a browser.
            const terminal = (argv) => {
              const shell = () => spawn('powershell.exe', ['-NoExit', '-Command', argv.join(' ')], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
              spawn('wt.exe', [...argv], { detached: true, stdio: 'ignore' }).on('error', shell).unref()
            }
            try {
              const r = await authAction(agent.provider, action, terminal)
              // The cached readiness is now stale either way.
              await readiness(true).catch(() => {})
              return send(200, r)
            } catch (err) { return send(400, { error: err.message }) }
          }
          // Opens the user's own terminal in a DSH project folder; the client sends only the folder, never a command.
          if (req.method === 'POST' && url.pathname === '/jev-router/open-terminal') {
            const { cwd } = JSON.parse(await readBody(req))
            const dir = await workspaceDir(cwd, (workspaceRegistry?.list() ?? []).map((w) => w.path))
            const shell = () => spawn('powershell.exe', ['-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
            spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' }).on('error', shell).unref()
            return send(200, { ok: true })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/setup') {
            const [agents, status, jevKey] = await Promise.all([
              enabledAgents(),
              readiness(url.searchParams.has('recheck')),
              resolveCredential(config.credentialRef).catch(() => undefined),
            ])
            return send(200, {
              jev: { configured: !!jevKey?.value || !!accounts.activeKey('jev'), credentialRef: config.credentialRef },
              agents: agents.map((a) => ({ id: a.id, provider: a.provider, description: a.description, enabled: a.enabled, custom: !!a.custom, llm: a.llm?.provider ? a.llm : undefined, status: status[a.id] })),
              providers: await modelProviders(),
              tools: (config.tools ?? []).map((t) => ({ id: t.id, description: t.description, command: t.command, enabled: t.enabled })),
            })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/agents') {
            const body = JSON.parse(await readBody(req))
            const target = allAgents(await readSetup()).find((a) => a.id === body.id)
            if (!target) return send(404, { error: `unknown agent ${body.id}` })
            if (!target.enabled && body.enabled) return send(400, { error: `${body.id} is switched off in cordis.patch.yml (enabled: false); change it there` })
            await mutateSetup((s) => ({ ...s, disabled: body.enabled ? s.disabled.filter((x) => x !== body.id) : [...new Set([...s.disabled, body.id])] }))
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/agents/only') {
            const body = JSON.parse(await readBody(req))
            if (!Array.isArray(body.ids)) return send(400, { error: 'ids: array of agent ids' })
            return send(200, { ids: await useOnly(parseUse(body.ids.join(' '), await switchable())) })
          }
          // Accounts and usage. Key values go in (POST /keys) and never come out.
          if (req.method === 'GET' && url.pathname === '/jev-router/usage') {
            const agents = await enabledAgents()
            const snap = await usage.snapshot(agents, { force: url.searchParams.get('force') === '1' })
            const lines = await usage.lines()
            const workspaces = [...new Set(lines.map((l) => l.workspace).filter(Boolean))]
            const handoffs = (await Promise.all(workspaces.map(async (w) => {
              const st = await stat(join(w, '.kz-harness', 'handoff.md')).catch(() => null)
              return st && { workspace: w, updatedAt: st.mtime.toISOString() }
            }))).filter(Boolean)
            // What each agent costs at this hour, for the agents whose provider bills by the clock.
            const rates = pricingNow(config.pricing?.peak)
            return send(200, {
              agents: Object.entries(snap).map(([id, q]) => ({ id, ...q, rateNow: rates[id] ?? null })),
              links: config.links ?? {},
              keys: usage.last().keys,
              recent: lines.slice(-50),
              handoffs,
              savings: await usage.savings({ ...config.savings, historyFile: config.historyFile }).catch(() => null),
            })
          }
          if (url.pathname === '/jev-router/keys' || url.pathname === '/jev-router/keys/activate') {
            const b = req.method === 'DELETE' ? Object.fromEntries(url.searchParams) : req.method === 'POST' ? JSON.parse(await readBody(req)) : {}
            if (!(await knownProviders()).includes(b.provider)) return send(400, { error: `unknown provider ${b.provider}` })
            if (!KEY_NAME.test(b.name ?? '')) return send(400, { error: 'key name: lowercase letters, digits, - or _ (max 32)' })
            let r
            if (req.method === 'POST' && url.pathname === '/jev-router/keys') r = await accounts.addKey(b.provider, b.name, b.key)
            else if (req.method === 'POST') r = await accounts.activate(b.provider, b.name)
            else if (req.method === 'DELETE' && url.pathname === '/jev-router/keys') r = await accounts.removeKey(b.provider, b.name)
            else return send(404, { error: 'not found' })
            return send(200, { ok: true, restartRequired: !!r?.restartRequired })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/limits') {
            const b = JSON.parse(await readBody(req))
            if (b.agentId !== 'jev' && !(await enabledAgents()).some((a) => a.id === b.agentId)) return send(404, { error: `unknown agent ${b.agentId}` })
            await accounts.setLimits(b.agentId, b)
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && (url.pathname === '/jev-router/login' || url.pathname === '/jev-router/logout')) {
            const { provider } = JSON.parse(await readBody(req))
            if (url.pathname.endsWith('/login')) accounts.openLogin(provider)
            else await accounts.logout(provider)
            // The login window finishes on its own; the page's recheck (?recheck) picks up the new status.
            usage.resetLogin()
            readyGen++; readyCache = null
            return send(200, { ok: true })
          }
          // Local models: status for the Settings card, the picker's catalog, installs and removals (manifest ids only).
          if (req.method === 'GET' && url.pathname === '/jev-router/local') {
            return send(200, { ...(await local.status()), online: connectivity.last()?.online ?? null })
          }
          if (req.method === 'GET' && url.pathname === '/jev-router/local/catalog') return send(200, await catalog())
          if (req.method === 'POST' && url.pathname.startsWith('/jev-router/local/')) {
            const b = JSON.parse((await readBody(req)) || '{}')
            const op = url.pathname.slice('/jev-router/local/'.length)
            const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
            if (op === 'start') await local.start(String(b.model ?? ''))
            else if (op === 'stop') await local.stop()
            else if (op === 'install') return send(200, { ids: await local.install(ids) })
            // The page asks for confirmation (Confirm modal naming every file and size) before calling this.
            else if (op === 'remove') { for (const id of ids) await local.remove(id) }
            else if (op === 'settings') await local.setSettings(b)
            else return send(404, { error: 'not found' })
            return send(200, { ok: true })
          }
          if (req.method === 'POST' && url.pathname === '/jev-router/custom') {
            const b = JSON.parse(await readBody(req))
            if (!/^[a-z][a-z0-9_-]{0,31}$/.test(b.id ?? '')) return send(400, { error: 'name: lowercase letters, digits, - or _, starting with a letter' })
            if (!b.description) return send(400, { error: 'say what the agent is good at' })
            const provider = (await modelProviders()).find((p) => p.id === b.provider)
            if (!provider?.models.some((m) => m.id === b.model)) return send(400, { error: `${b.provider} / ${b.model} is not a model in Settings → Models` })
            await mutateSetup((s) => {
              if (allAgents(s).some((a) => a.id === b.id)) throw new Error(`an agent named ${b.id} already exists`)
              return { ...s, custom: [...s.custom, { id: b.id, provider: b.provider, model: b.model, description: String(b.description).slice(0, 500) }] }
            })
            return send(200, { ok: true })
          }
          if (req.method === 'DELETE' && url.pathname === '/jev-router/custom') {
            const id = url.searchParams.get('id')
            await mutateSetup((s) => ({ disabled: s.disabled.filter((x) => x !== id), custom: s.custom.filter((c) => c.id !== id) }))
            return send(200, { ok: true })
          }
          send(404, { error: 'not found' })
        } catch (err) { send(400, { error: err.message }) }
      },
    }))
  })
}

const PEERS = { claude: 'codex', codex: 'claude' }

// A key combo as the Shortcuts page writes it: modifiers in this order, then one key; '' = unbound.
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Z0-9`\-=[\]\;',./]|F([1-9]|1[0-2])|Enter|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/

/** Shortcuts page body -> what gets stored: { bindings: {actionId: combo}, rightbarRatio? }. Throws on anything else. */
export function validHotkeys(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected an object')
  const { bindings = {}, rightbarRatio } = body
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('bindings: object of action id -> key combo')
  const entries = Object.entries(bindings)
  if (entries.length > 40) throw new Error('too many bindings')
  for (const [id, combo] of entries) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`bad action id ${id}`)
    if (typeof combo !== 'string' || (combo !== '' && !COMBO.test(combo))) throw new Error(`bad key combo for ${id}`)
  }
  if (rightbarRatio !== undefined && !(Number.isInteger(rightbarRatio) && rightbarRatio >= 15 && rightbarRatio <= 50)) throw new Error('rightbarRatio: whole number 15-50')
  return { bindings: Object.fromEntries(entries), ...(rightbarRatio !== undefined ? { rightbarRatio } : {}) }
}

/** The folder a terminal may open in: an existing directory that is a DSH project folder. */
export async function workspaceDir(cwd, projectPaths) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd: the session folder')
  const dir = resolve(cwd)
  const same = (p) => resolve(p).toLowerCase() === dir.toLowerCase()
  if (!projectPaths.some(same)) throw new Error('that folder is not a harness project')
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error('that folder does not exist')
  return dir
}

/** One line for Jev and the log: windows, balance or spend. */
function summaryOf(q) {
  const parts = (q.windows ?? []).map((w) => `${w.name} ${Math.round(w.usedPercent)}%`)
  if (q.balance) parts.push(`balance ${q.balance.amount.toFixed(2)} ${q.balance.currency}`)
  if (q.spentUsd != null) parts.push(`$${q.spentUsd.toFixed(2)} this month`)
  return `${q.state}${parts.length ? `: ${parts.join(' · ')}` : ''}`
}

const sessionIdOf = (agent) => agent?.session?.id ?? agent?.session?.header?.id

// Model text can quote anything; mask key-shaped strings before they reach the log.
// One redaction rule for the log and the export, so a provider added to one covers both.
const redactLine = redactSecrets

// Writes must declare a JSON body: a cross-site form cannot send one without a CORS preflight.
export const isJsonRequest = (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (d) => { chunks.push(d); size += d.length; if (size > 64 * 1024) { fail(new Error('body too large')); req.destroy() } })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

function setEnv(name, value) { if (value) process.env[name] = value; else delete process.env[name] }

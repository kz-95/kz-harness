// jev-router: DSH plugin. TypeSafe Jev routes each coding task to one of the
// registered agents, deterministic checks verify the result, and Jev assesses
// it (accept / second review / retry / human) within configured limits.
//
// Executors are DSH subagent providers, so auth and permissions stay native:
//   claude   -> @deepseek-ai/dsh-subagent-claude-code (Claude subscription login)
//   codex    -> @deepseek-ai/dsh-subagent-codex       (ChatGPT login)
//   deepseek -> built-in `spawn` provider              (DSH's DeepSeek model)
// A new agent is one `agents` entry naming any installed subagent provider.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createJev } from './jev.js'
import { formatReport, runRouted } from './router.js'
import { run } from './workspace.js'
import { checkAgents } from './setup.js'
import { JEV_PROVIDER, jevAdapter, line } from './adapter.js'

export const name = 'jev-router'
export const inject = ['tools', 'commands', 'subagents', 'credentials']

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

const Agent = Schema.object({
  id: Schema.string().pattern(/^[a-z][a-z0-9_-]*$/).required().description('Short id, also the manual override command name.'),
  provider: Schema.string().required().description('DSH subagent provider name, e.g. claude-code, codex, spawn.'),
  description: Schema.string().required().description('Strengths shown to Jev when choosing. A prior, not a rule.'),
  enabled: Schema.boolean().default(true),
  persona: Schema.string().description('Optional persona for providers that accept one (spawn).'),
  credentialRef: Schema.string().description('API key credential that must be set for this agent to run (BYOK agents).'),
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
      provider: 'claude-code',
      description: 'Claude Code: architecture, planning, large-context understanding, complex cross-file reasoning, ambiguous requirements.',
      enabled: true,
    },
    {
      id: 'codex',
      provider: 'codex',
      description: 'OpenAI Codex: implementation, debugging, repository modification, targeted fixes, writing and running tests.',
      enabled: true,
    },
    {
      id: 'deepseek',
      provider: 'spawn',
      description: 'DeepSeek (native DSH agent): independent analysis, code review, second opinions, reasoning, broad investigation.',
      enabled: true,
      credentialRef: 'DEEPSEEK_API_KEY',
      llm: { provider: 'deepseek-official', model: 'deepseek-flash' },
      persona: 'You are a careful senior software engineer working as a delegated coding agent. Complete the task in the given workspace and report concisely.',
    },
  ]),
  tools: Schema.array(Tool).default([]).description('Deterministic scripts Jev can run instead of an LLM agent.'),
  auxModel: Schema.object({
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-flash'),
  }).description('Real model the Jev Auto model hands session titles and conversation compaction to.'),
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
  const history = {
    async recent(cwd, n) {
      const raw = await readFile(config.historyFile, 'utf8').catch(() => '')
      // ponytail: reads the whole file; switch to a tail read if history grows past a few MB.
      return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter((r) => r && r.workspace === cwd).slice(-n)
        .map((r) => ({ task_type: r.routing?.taskType, first_agent: r.routing?.primaryAgent, attempts: r.attempts?.length, outcome: r.finalStatus }))
    },
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
  const allAgents = (s) => [...config.agents, ...s.custom.map(customAgent)]
  const enabledAgents = async () => {
    const s = await readSetup()
    return allAgents(s).map((a) => ({ ...a, enabled: a.enabled && !s.disabled.includes(a.id) }))
  }
  async function saveSetup(s) {
    if (!allAgents(s).some((a) => a.enabled && !s.disabled.includes(a.id))) throw new Error('at least one LLM agent must stay on')
    await mkdir(dataDir, { recursive: true })
    const tmp = `${setupFile}.tmp`
    await writeFile(tmp, JSON.stringify(s, null, 2))
    await rename(tmp, setupFile)
    readyGen++
    readyCache = null
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
      readyPending = readSetup().then((s) => checkAgents(allAgents(s), resolveCredential)).then((value) => {
        if (gen === readyGen) readyCache = { at: Date.now(), value }
        return value
      }).finally(() => { if (gen === readyGen) readyPending = null })
    }
    return readyPending
  }

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
    return (e) => { entry.events.push(e) }
  }

  // Subagents inherit the jev_route tool and would re-route their own prompt, nesting forever.
  // Also stops two routes editing the same workspace at once.
  const active = new Set()
  async function route({ task, agent, forceAgent, signal = new AbortController().signal, emit }) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('cannot determine the session workspace; open a workspace in DSH first')
    const key = resolve(cwd).toLowerCase()
    if (active.has(key)) throw new Error('already routing a task in this workspace; wait for it to finish (a nested agent must do its task directly, not call jev_route)')
    active.add(key)
    const log = logRun(sessionIdOf(agent) ?? cwd, task)
    // Each step also goes to the server log, which the Kz Harness app shows in its log window.
    const onEvent = (e) => { log(e); emit?.(e); process.stdout.write(`[jev] ${line(e)}\n`) }
    try {
      const jevKey = await resolveCredential(config.credentialRef).catch(() => undefined)
      const onTrace = (trace) => onEvent({ type: 'jev', at: Date.now(), trace })
      const jev = jevKey?.value ? createJev({ apiKey: jevKey.value, model: config.jevModel, timeoutMs: config.jevTimeoutMs, onTrace }) : null
      const reviewService = ctx.get('jevReview')
      const review = reviewService ? await reviewService.create({ onTrace, thresholds: config.thresholds }) : undefined

      const execute = async (agentDef, prompt, agentSignal) => {
        const sub = await ctx.subagents.start(agentDef.provider, {
          label: `jev:${agentDef.id}`,
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          signal: agentSignal,
          ...(agentDef.persona ? { persona: agentDef.persona } : {}),
          // In-process children see global tools; hide the router so an agent never re-routes its own task.
          ...(agentDef.provider === 'spawn' && config.registerTool ? { toolFilter: { deny: ['jev_route'] } } : {}),
          // Pin the model: a spawn child otherwise inherits the parent's (Jev) model and routes back into Jev.
          ...(agentDef.llm?.provider && agentDef.llm?.model ? { agentOptions: { provider: agentDef.llm.provider, model: agentDef.llm.model } } : {}),
        })
        try {
          const r = await sub.result
          return { stopReason: r.stopReason, diagnostic: r.diagnostic, answerText: textOf(r.output) }
        } finally {
          await sub.dispose().catch(() => {})
        }
      }

      const result = await runRouted({
        task,
        cwd,
        forceAgent,
        config: { ...config, agents: await enabledAgents() },
        signal,
        deps: {
          ready: await readiness(),
          jev,
          jevUnavailableReason: `${config.credentialRef} not configured`,
          execute,
          runTool: runTool(cwd, config.agentTimeoutMs),
          review,
          emit: onEvent,
          history,
        },
      })
      return formatReport(result)
    } catch (err) {
      onEvent({ type: 'error', at: Date.now(), message: err.message })
      throw err
    } finally {
      active.delete(key)
    }
  }

  // Slash commands: /auto lets Jev choose; /<agent-id> forces that agent (post-review still runs).
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

  // "Jev Auto" in the model picker: every message goes straight to the router, no chat model in front.
  ctx.inject(['llm', 'agents'], (c) => {
    llm = c.llm
    c.effect(() => () => { llm = null })
    c.effect(() => c.llm.registerAdapter([JEV_PROVIDER], jevAdapter({ ctx: c, route, auxModel: config.auxModel })))
  })

  // HTTP routes for the browser half (inspector tab, setup page), behind DSH's own Host/Origin/cookie checks.
  ctx.inject(['webServer', 'connection'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'prefix',
      path: '/jev-router',
      handler: async (req, res) => {
        const deny = c.connection.requestRejection(req)
        if (deny) { res.statusCode = deny; return res.end() }
        // Writes need a JSON body type: a cross-site form cannot send one without a CORS preflight.
        if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) { res.statusCode = 415; return res.end() }
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
          if (req.method === 'GET' && url.pathname === '/jev-router/setup') {
            const [agents, status, jevKey] = await Promise.all([
              enabledAgents(),
              readiness(url.searchParams.has('recheck')),
              resolveCredential(config.credentialRef).catch(() => undefined),
            ])
            return send(200, {
              jev: { configured: !!jevKey?.value, credentialRef: config.credentialRef },
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

const sessionIdOf = (agent) => agent?.session?.id ?? agent?.session?.header?.id

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (d) => { chunks.push(d); size += d.length; if (size > 64 * 1024) { fail(new Error('body too large')); req.destroy() } })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', fail)
  })
}

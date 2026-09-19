// "Jev Auto" as a model in the DSH picker. Picking it sends every chat message
// straight to the router: no chat LLM in front deciding whether to call it.
// Live router progress streams as the reasoning block; the report is the reply.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const JEV_PROVIDER = 'jev'
// The "No project" workspace (<harness>/no-project): chat only, agents never run there.
const NO_PROJECT = resolve(fileURLToPath(new URL('../../no-project', import.meta.url))).toLowerCase()
export const isNoProject = (cwd) => !!cwd && resolve(cwd).toLowerCase() === NO_PROJECT
const MODEL = 'jev-auto'

// The router run is not idempotent (agents edit files), so never let the runtime retry it.
const NO_RETRY = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: Object.freeze([]), initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 })

const info = (provider, id = MODEL) => ({
  provider,
  id,
  name: 'Jev Auto',
  description: 'Every message goes straight to the Jev router, which picks Claude, Codex, DeepSeek or a tool, then reviews the result.',
  inputModalities: ['text'],
  reasoning: REASONING,
})

// Effort in the model menu. Ids are Jev's unified ladder (effort.js maps them per agent).
const REASONING = Object.freeze({
  defaultEffort: 'auto',
  efforts: Object.freeze([
    { id: 'auto', name: 'Auto', description: 'Jev picks by task (Settings default applies)' },
    { id: 'low', name: 'Low', description: 'Claude Low · GPT Light · DeepSeek Low' },
    { id: 'medium', name: 'Medium', description: 'Claude Medium · GPT Medium · DeepSeek High' },
    { id: 'high', name: 'High', description: 'Claude High · GPT High · DeepSeek High' },
    { id: 'xhigh', name: 'Extra High', description: 'Claude Extra · GPT Extra High · DeepSeek Max' },
    { id: 'max', name: 'Max', description: 'Claude Max · GPT Max · DeepSeek Max' },
    { id: 'ultra', name: 'Ultra', description: 'Claude Ultracode (its top level) · GPT Ultra · DeepSeek Max' },
  ]),
})

// Text the person typed. DSH also sends plugin context (skill catalogs, reminders)
// as user-role messages and blocks; those must never become the routed task.
const textOf = (content) => (content ?? [])
  .filter((b) => b.type === 'text' && !b.text.trimStart().startsWith('<system-reminder>'))
  .map((b) => b.text).join('\n').trim()
const typedByPerson = (m) => m.role === 'user' && (m.source?.kind ?? 'user') === 'user'

/** One line per router event, for the live reasoning block and the app log. */
export function line(e) {
  switch (e.type) {
    case 'start': return `Task received${e.forceAgent ? ` (forced: ${e.forceAgent})` : ''}`
    case 'jev': return `Jev ${e.trace.phase}: ${e.trace.questions.filter((q) => q.used).length}/${e.trace.questions.length} questions in ${e.trace.ms} ms`
    case 'routed': return e.tool ? `Routed to tool ${e.tool}` : `Routed to ${e.routing.primaryAgent} (${e.routing.mode})`
    case 'checks': return `Baseline checks: ${e.checks.map((c) => `${c.name} ${c.passed ? 'pass' : 'FAIL'}`).join(', ')}`
    case 'attempt_start': return `Running ${e.agent} (${e.role})…`
    case 'attempt_end': return `${e.attempt.agent}${e.attempt.effort ? ` (effort ${e.attempt.effort})` : ''} finished: ${e.attempt.stopReason} in ${Math.round(e.attempt.durationMs / 1000)}s`
    case 'review': return `Review: ${e.assessment.action}. ${e.assessment.why}`
    case 'limit': return `${e.agent} hit its usage limit${e.until ? ` (resets ${new Date(e.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}: ${{ rotated: 'switched API key, continuing', peer: 'handing the task to another agent', paused: 'no agent left, pausing' }[e.action] ?? e.action}`
    case 'handoff': return `Handoff note saved (${e.source === 'agent' ? 'by the agent' : 'by the harness'}): ${e.path}`
    case 'final': return `Final: ${e.status}`
    case 'error': return `Error: ${e.message}`
    default: return e.type
  }
}

/**
 * @param {object} p
 * @param {object} p.ctx     cordis context with `llm` and `agents`
 * @param {Function} p.route the router's route({ task, agent, signal, emit })
 * @param {Function} [p.classify] (message) -> { kind: 'task' | 'question' }
 * @param {{provider: string, model: string}} p.auxModel real model for title and compaction requests
 * @param {(ms: number, model: {provider: string, model: string}) => void} [p.onDirectAnswer] a question in a project was answered by a chat model, no agent
 * @param {() => Promise<boolean>} [p.isOffline] true when the internet is unreachable
 * @param {() => Promise<{provider: string, model: string}|null>} [p.localChat] the local chat model, when one is installed
 */
export function jevAdapter({ ctx, route, classify, auxModel, onDirectAnswer, isOffline, localChat }) {
  // Chat models to try in order: online the aux model, then the local one; offline the local one only.
  const chatModels = async () => {
    const local = await localChat?.().catch(() => null)
    const offline = await isOffline?.().catch(() => false)
    return { offline, models: offline ? (local ? [local] : []) : [auxModel, local].filter(Boolean) }
  }
  return {
    providerInfo: (p) => ({ id: p, name: 'Jev' }),
    providerRetryPolicy: () => NO_RETRY,
    imageRequestPricing: () => undefined,
    listModels: (p) => Promise.resolve([info(p)]),
    resolveModel: (p, m) => Promise.resolve({ ...info(p, m), context: { contextWindow: 1_000_000 } }),
    async prepareCall(p, m, s) { return { model: await this.resolveModel(p, m, s), stream: (o) => this.stream(o) } },

    async *stream(options) {
      const task = textOf(options.messages.findLast((m) => typedByPerson(m) && textOf(m.content))?.content)

      // Side requests (session title, compaction) reuse this route; a real model answers them.
      if (options.purpose) {
        const { reasoningEffort: _r, ...rest } = options
        const m = (await chatModels()).models[0] ?? auxModel
        // A title has a tiny output budget: no thinking, as the official DeepSeek connector did.
        const title = options.purpose === 'session-title' && m.provider !== 'local' ? { reasoningEffort: 'off' } : {}
        yield* ctx.llm.stream({ ...rest, ...title, provider: m.provider, model: m.model })
        return
      }

      const agent = (options.sessionId && ctx.agents.get(options.sessionId)) ?? ctx.agents.currentInitiator?.()
      if (!task) { yield* textReply('Type a task and Jev will route it.'); return }
      // A bare `/skill` message only loads that skill into the conversation; there is nothing to run yet.
      const skill = task.match(/^\/([\w:.-]+)$/)
      if (skill) { yield* textReply(`Skill \`${skill[1]}\` is loaded into this conversation. Tell me what to do with it.`); return }

      // "No project": everything is chat. Project work needs a real folder for the agents.
      if (isNoProject(agent?.session?.header?.cwd)) {
        if ((await classify?.(task).catch(() => null))?.kind === 'task') {
          yield* textReply('This is the **No project** space, so no agent can work on files here. Pick or add your project folder in the workspace menu next to the message box, then send the task again. Questions are answered here directly.')
          return
        }
        const answered = yield* answerWithAny(ctx, options, await chatModels())
        if (answered !== true) yield* textReply(`No chat model could answer (${answered}). Check DeepSeek or Local models in Settings → Jev setup, or ask inside a project folder so an agent can answer.`)
        return
      }

      // Questions get a direct answer from a chat model; only project work goes to the agents.
      let routeTask = task
      let answerOnly = false
      if ((await classify?.(task).catch(() => null))?.kind === 'question') {
        const started = Date.now()
        const answered = yield* answerWithAny(ctx, options, await chatModels(), (m) => onDirectAnswer?.(Date.now() - started, m))
        if (answered === true) return
        // No chat model available: one agent answers, without touching the project, checks or review.
        process.stdout.write(`[jev] No chat model could answer (${answered}); asking an agent\n`)
        routeTask = `Answer this question directly and briefly. Do not modify any files.\n\n${task}`
        answerOnly = true
      }

      // Router events -> live reasoning lines, report -> reply text. A local
      // controller stops the run on Stop and also when the runtime drops this stream.
      const ac = new AbortController()
      const onAbort = () => { ac.abort(options.signal?.reason); wake?.() }
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true })
      const queue = []
      let wake
      let done = false
      let result
      let error
      const emit = (e) => { queue.push(line(e)); wake?.() }
      route({ task: routeTask, answerOnly, agent, effort: options.reasoningEffort, signal: ac.signal, emit })
        .then((r) => { result = r }, (e) => { error = e })
        .finally(() => { done = true; wake?.() })

      try {
        let trace = ''
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        while ((!done || queue.length) && !ac.signal.aborted) {
          if (!queue.length) { await new Promise((r) => { wake = r }); wake = undefined; continue }
          const text = `${queue.shift()}\n`
          trace += text
          yield { type: 'reasoning-delta', index: 0, text }
        }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: trace } }
        if (ac.signal.aborted) throw error ?? new DOMException('Stopped', 'AbortError')
        yield* textReply(error ? `jev-router: ${error.message}` : result, 1)
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        if (!done) ac.abort()
      }
    },
  }
}

const ABOUT = 'You are answering inside Kz-harness, a desktop app where the Jev router sends coding tasks to Claude Code (the user\'s claude.ai login on this PC), Codex (their ChatGPT login on this PC), DeepSeek (API key) and API-key models, runs the project checks, and reviews results. Logins and keys are managed in Settings → Jev setup → Accounts; usage limits are in the Jev inspector → Usage tab. Answer the user\'s question directly and concisely.'

/** Try each chat model in order until one answers; returns true, or the last failure reason. */
async function* answerWithAny(ctx, options, { offline, models }, onAnswered) {
  let why = offline ? 'offline and no local model installed' : 'no chat model configured'
  for (const m of models) {
    const r = yield* answerDirectly(ctx, options, m, offline)
    if (r === true) { onAnswered?.(m); return true }
    process.stdout.write(`[jev] Chat model ${m.provider}/${m.model} could not answer (${r})\n`)
    why = r
  }
  return why
}

const PROVIDER_NAME = { deepseek: 'DeepSeek', 'deepseek-official': 'DeepSeek', local: 'Local model' }

/**
 * Stream the answer from the chat model. Returns true, or the failure reason (having yielded nothing)
 * when that model fails before producing text, so the caller can fall back to an agent.
 */
async function* answerDirectly(ctx, options, auxModel, offline = false) {
  // No tools: a direct answer must not start work (or call the router) on its own.
  const { reasoningEffort: _r, purpose: _p, tools: _t, toolChoice: _tc, ...rest } = options
  const messages = options.messages.map((m, i) => (i === options.messages.length - 1 && m.role === 'user'
    ? { ...m, content: [{ type: 'text', text: ABOUT }, ...m.content] }
    : m))
  const held = []
  let flowing = false
  let lastIndex = 0
  const credit = `\n\n_${offline ? 'OFFLINE: local models only. ' : ''}Answered by: ${PROVIDER_NAME[auxModel.provider] ?? auxModel.provider} (${auxModel.model}), directly: a question, no agents or project work_`
  try {
    for await (const chunk of ctx.llm.stream({ ...rest, messages, provider: auxModel.provider, model: auxModel.model })) {
      if (typeof chunk.index === 'number') lastIndex = Math.max(lastIndex, chunk.index)
      if (flowing && chunk.type === 'finish' && chunk.reason?.kind === 'stop') {
        const i = lastIndex + 1
        yield { type: 'block-start', index: i, blockType: 'text' }
        yield { type: 'text-delta', index: i, text: credit }
        yield { type: 'block-end', index: i, block: { type: 'text', text: credit } }
      }
      if (flowing) { yield chunk; continue }
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return `${chunk.reason.failure?.code ?? 'error'}: ${chunk.reason.failure?.message ?? ''}`.slice(0, 200)
      held.push(chunk)
      if (chunk.type === 'text-delta') { flowing = true; for (const c of held) yield c }
    }
  } catch (err) { if (!flowing) return `${err?.code ?? err?.name ?? 'error'}: ${err?.message ?? ''}`.slice(0, 200); throw new Error('chat model stopped mid-answer') }
  if (!flowing) for (const c of held) yield c
  return true
}

async function* textReply(text, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

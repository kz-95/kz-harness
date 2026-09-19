// "Jev Auto" as a model in the DSH picker. Picking it sends every chat message
// straight to the router: no chat LLM in front deciding whether to call it.
// Live router progress streams as the reasoning block; the report is the reply.
export const JEV_PROVIDER = 'jev'
const MODEL = 'jev-auto'

// The router run is not idempotent (agents edit files), so never let the runtime retry it.
const NO_RETRY = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: Object.freeze([]), initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 })

const info = (provider, id = MODEL) => ({
  provider,
  id,
  name: 'Jev Auto',
  description: 'Every message goes straight to the Jev router, which picks Claude, Codex, DeepSeek or a tool, then reviews the result.',
  inputModalities: ['text'],
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
    case 'attempt_end': return `${e.attempt.agent} finished: ${e.attempt.stopReason} in ${Math.round(e.attempt.durationMs / 1000)}s`
    case 'review': return `Review: ${e.assessment.action}. ${e.assessment.why}`
    case 'final': return `Final: ${e.status}`
    case 'error': return `Error: ${e.message}`
    default: return e.type
  }
}

/**
 * @param {object} p
 * @param {object} p.ctx     cordis context with `llm` and `agents`
 * @param {Function} p.route the router's route({ task, agent, signal, emit })
 * @param {{provider: string, model: string}} p.auxModel real model for title and compaction requests
 */
export function jevAdapter({ ctx, route, auxModel }) {
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
        yield* ctx.llm.stream({ ...rest, provider: auxModel.provider, model: auxModel.model })
        return
      }

      const agent = (options.sessionId && ctx.agents.get(options.sessionId)) ?? ctx.agents.currentInitiator?.()
      if (!task) { yield* textReply('Type a task and Jev will route it.'); return }

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
      route({ task, agent, signal: ac.signal, emit })
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

async function* textReply(text, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

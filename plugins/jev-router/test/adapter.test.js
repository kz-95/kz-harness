// The Jev Auto model must route what the person typed, never injected context.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidedBy, jevAdapter, line, queuedLine, resultSection } from '../adapter.js'

test('routes the typed message, not a later plugin reminder', async () => {
  let routed
  const route = async ({ task, emit }) => { routed = task; emit({ type: 'final', status: 'accepted' }); return 'report' }
  const adapter = jevAdapter({ ctx: { agents: { get: () => ({}) } }, route, auxModel: { provider: 'x', model: 'y' } })
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain src/users.ts' }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'skills', form: 'catalog' }, content: [{ type: 'text', text: '<system-reminder>A skill is…</system-reminder>' }] },
  ]
  const chunks = []
  for await (const c of adapter.stream({ messages, sessionId: 's', signal: new AbortController().signal })) chunks.push(c)
  assert.equal(routed, 'Explain src/users.ts')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'report'))
})

const run = async (adapter, text) => {
  const chunks = []
  for await (const c of adapter.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], sessionId: 's', signal: new AbortController().signal })) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}
const chat = (chunks) => ({ agents: { get: () => ({}) }, llm: { async *stream() { yield* chunks } } })
const aux = { provider: 'x', model: 'y' }
const aux2 = { provider: 'deepseek', model: 'deepseek-flash' }

test('a bare /skill message is acknowledged, not routed', async () => {
  let routed = false
  const a = jevAdapter({ ctx: chat([]), route: async () => { routed = true; return '' }, classify: async () => ({ kind: 'task' }), auxModel: aux })
  assert.match(await run(a, '/typesafe-ai'), /Skill `typesafe-ai` is loaded/)
  assert.equal(routed, false)
})

test('a question is answered by the chat model; no agent runs', async () => {
  let routed = false
  const ok = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'They use your existing logins.' }, { type: 'finish', reason: { kind: 'stop' } }]
  const a = jevAdapter({ ctx: chat(ok), route: async () => { routed = true; return '' }, classify: async () => ({ kind: 'question' }), auxModel: aux })
  const text = await run(a, 'how can you run claude without login?')
  assert.ok(text.startsWith('They use your existing logins.'))
  assert.match(text, /Answered by: x\/y, directly/)
  assert.equal(routed, false)
})

test('an unsure "question" goes to the agents: a task sent to a chat model cannot be done at all', async () => {
  let routed = false
  const ok = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'chat answer' }, { type: 'finish', reason: { kind: 'stop' } }]
  const a = jevAdapter({ ctx: chat(ok), route: async () => { routed = true; return 'agent did it' }, classify: async () => ({ kind: 'question', confidence: 0.4 }), auxModel: aux })
  assert.equal(await run(a, 'fix the thing'), 'agent did it')
  assert.equal(routed, true, 'below the floor it is treated as work, not chat')
})

test('a confident question is still answered directly', async () => {
  let routed = false
  const ok = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'chat answer' }, { type: 'finish', reason: { kind: 'stop' } }]
  const a = jevAdapter({ ctx: chat(ok), route: async () => { routed = true; return '' }, classify: async () => ({ kind: 'question', confidence: 0.9 }), auxModel: aux })
  assert.ok((await run(a, 'how does this work?')).startsWith('chat answer'))
  assert.equal(routed, false)
})

test('a classifier that reports no confidence is taken at its word, so offline mode still answers', async () => {
  let routed = false
  const ok = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'chat answer' }, { type: 'finish', reason: { kind: 'stop' } }]
  const a = jevAdapter({ ctx: chat(ok), route: async () => { routed = true; return '' }, classify: async () => ({ kind: 'question', offline: true }), auxModel: aux })
  assert.ok((await run(a, 'what is this?')).startsWith('chat answer'))
  assert.equal(routed, false, 'the floor must not apply to a classifier with no confidence to give')
})

test('a question falls back to an agent when the chat model fails', async () => {
  let routedTask
  const fail = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA' } } }]
  const a = jevAdapter({ ctx: chat(fail), route: async ({ task }) => { routedTask = task; return 'agent answer' }, classify: async () => ({ kind: 'question' }), auxModel: aux })
  assert.equal(await run(a, 'why?'), 'agent answer')
  assert.match(routedTask, /Do not modify any files[\s\S]*why\?/)
})

test('No project workspace: questions answered, tasks politely refused, agents never run', async () => {
  const { isNoProject } = await import('../adapter.js')
  const { fileURLToPath } = await import('node:url')
  const dir = fileURLToPath(new URL('../../../no-project', import.meta.url))
  assert.ok(isNoProject(dir))
  let routed = false
  const ctx = { agents: { get: () => ({ session: { header: { cwd: dir } } }) }, llm: { async *stream() { yield { type: 'text-delta', index: 0, text: 'hi' }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
  const route = async () => { routed = true; return '' }
  const q = jevAdapter({ ctx, route, classify: async () => ({ kind: 'question' }), auxModel: aux })
  assert.ok((await run(q, 'what is jev?')).startsWith('hi'))
  const t = jevAdapter({ ctx, route, classify: async () => ({ kind: 'task' }), auxModel: aux })
  assert.match(await run(t, 'fix the bug'), /No project/)
  assert.equal(routed, false)
})

// ---------- one pickable model per agent, next to Jev Auto ----------

const AGENTS = [
  // A name is the agent's own, from its config entry; an agent without one is title-cased.
  { id: 'claude', name: 'Claude Code', description: 'Claude Code: planning and large-context work.', enabled: true },
  { id: 'codex', name: 'Codex (GPT)', description: 'OpenAI Codex: implementation and tests.', enabled: true },
  { id: 'my-own-agent', description: 'A custom agent with no name set.', enabled: true },
  { id: 'deepseek', name: 'DeepSeek agent', description: 'DeepSeek: review and analysis.', enabled: false },
]

test('the model list is Jev Auto plus every enabled agent', async () => {
  const a = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => AGENTS })
  const models = await a.listModels('jev')
  assert.deepEqual(models.map((m) => m.id), ['jev-auto', 'agent-claude', 'agent-codex', 'agent-my-own-agent'], 'a disabled agent is not offered')
  assert.deepEqual(models.map((m) => m.name), ['Jev Auto', 'Claude Code', 'Codex (GPT)', 'My Own Agent'], 'an agent with no configured name is title-cased')
  assert.match(models[1].description, /Always Claude Code, no routing/)
  // Every entry keeps the effort ladder, so the menu behaves the same whichever is picked.
  assert.ok(models.every((m) => m.reasoning?.efforts?.length))
})

test('a catalog that cannot be read still offers Jev Auto', async () => {
  const a = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => { throw new Error('no setup file') } })
  assert.deepEqual((await a.listModels('jev')).map((m) => m.id), ['jev-auto'])
  assert.equal((await a.resolveModel('jev', 'agent-claude')).id, 'agent-claude', 'an unknown id still resolves')
})

/** Stream with an explicitly picked model, the way prepareCall hands it over. */
const runAs = async (adapter, model, text, extra = {}) => {
  const chunks = []
  const options = { messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], sessionId: 's', model, signal: new AbortController().signal, ...extra }
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

test('picking an agent forces it, and skips the question/task classifier', async () => {
  let seen
  let classified = false
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ task, forceAgent, emit }) => { seen = { task, forceAgent }; emit({ type: 'final', status: 'accepted' }); return 'done by codex' },
    classify: async () => { classified = true; return { kind: 'question' } },
    auxModel: aux,
    agents: async () => AGENTS,
  })
  assert.match(await runAs(a, 'agent-codex', 'why is the build slow?'), /done by codex/)
  assert.deepEqual(seen, { task: 'why is the build slow?', forceAgent: 'codex' })
  assert.equal(classified, false, 'a picked agent answers everything itself')
})

test('Jev Auto still routes with no forced agent', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, emit }) => { seen = forceAgent; emit({ type: 'final', status: 'accepted' }); return 'routed' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => AGENTS,
  })
  await runAs(a, 'jev-auto', 'add a test for the parser')
  assert.equal(seen, undefined)
})

test('a picked agent is queued as that agent, not left to Jev', async () => {
  let queued
  const a = jevAdapter({
    ctx: chat([]),
    route: async () => 'unused',
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => AGENTS,
    orchestrator: { results: () => [], enqueue: (q) => { queued = q; return `Queued as claude` } },
  })
  assert.match(await runAs(a, 'agent-claude', 'refactor the router'), /Queued as claude/)
  assert.equal(queued.forceAgent, 'claude')
  assert.equal(queued.task, 'refactor the router')
})

test('prepareCall keeps the picked model on the call', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, emit }) => { seen = forceAgent; emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => AGENTS,
  })
  const call = await a.prepareCall('jev', 'agent-claude', {})
  assert.equal(call.model.id, 'agent-claude')
  // The runtime may hand stream() options without the model; prepareCall put it back.
  const chunks = []
  for await (const c of call.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }], sessionId: 's', signal: new AbortController().signal })) chunks.push(c)
  assert.equal(seen, 'claude')
})

test('the local-only rows appear only when a local model is installed', async () => {
  const cloud = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => AGENTS })
  assert.deepEqual((await cloud.listModels('jev')).map((m) => m.id), ['jev-auto', 'agent-claude', 'agent-codex', 'agent-my-own-agent'])

  const withLocal = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => [...AGENTS, { id: 'qwen-local', kind: 'local', enabled: true, description: 'Qwen on this PC.' }] })
  const models = await withLocal.listModels('jev')
  assert.deepEqual(models.map((m) => m.id), ['jev-auto', 'jev-online', 'jev-local', 'jev-offline', 'agent-claude', 'agent-codex', 'agent-my-own-agent', 'agent-qwen-local'])
  // Menu order is a gradient, most off-machine first.
  assert.deepEqual(models.slice(0, 4).map((m) => m.name), ['Jev Auto', 'Jev Auto · Online', 'Jev Auto · Local', 'Offline · Local only'])
})

test('each Jev row routes in its own mode', async () => {
  const seen = []
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ mode, emit }) => { seen.push(mode); emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => AGENTS,
  })
  for (const id of ['jev-auto', 'jev-online', 'jev-local', 'jev-offline']) await runAs(a, id, 'do the thing')
  assert.deepEqual(seen, ['auto', 'online', 'local', 'offline'])
})

test('offline mode answers a question locally, never through the hosted chat model', async () => {
  const hosted = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { hosted.push(o.provider); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'local answer' }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
  const a = jevAdapter({
    ctx,
    route: async () => 'unused',
    classify: async () => ({ kind: 'question' }),
    auxModel: aux,
    localChat: async () => ({ provider: 'local', model: 'qwen' }),
    isOffline: async () => false,
    agents: async () => AGENTS,
  })
  assert.match(await runAs(a, 'jev-offline', 'how does the parser work?'), /local answer/)
  assert.deepEqual(hosted, ['local'], 'the aux model was never asked')
})

const OK_TEXT = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'An answer.' },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('the credit names the model as the picker does, and keeps the id', async () => {
  const ctx = {
    agents: { get: () => ({}) },
    llm: {
      async *stream() { yield* OK_TEXT },
      // The catalog knows deepseek-flash is DeepSeek-V41-Flash; the api id alone
      // does not say which DeepSeek model answered, which is the whole complaint.
      resolveModel: async (provider, model) => (model === 'deepseek-flash' ? { id: model, provider, name: 'DeepSeek-V41-Flash' } : null),
    },
  }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: aux2 })
  assert.match(await run(a, 'what is this?'), /Answered by: DeepSeek-V41-Flash \(`deepseek\/deepseek-flash`\)/)
})

test('a model the catalog cannot name still reads cleanly', async () => {
  const a = jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: aux2 })
  const text = await run(a, 'what is this?')
  assert.match(text, /Answered by: deepseek\/deepseek-flash, directly/)
  assert.equal(text.includes('(`'), false, 'no empty id bracket when the name is already the id')
})

test('a catalog lookup that throws does not break the answer', async () => {
  const ctx = {
    agents: { get: () => ({}) },
    llm: { async *stream() { yield* OK_TEXT }, resolveModel: async () => { throw new Error('catalog down') } },
  }
  const a = jevAdapter({ ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: aux2 })
  const text = await run(a, 'what is this?')
  assert.match(text, /An answer\./)
  assert.match(text, /Answered by: deepseek\/deepseek-flash/)
})

// ---------- an unresolved aux pair is empty strings, not a model ----------
const EMPTY_AUX = { provider: '', model: '' }

test('a side request with an empty aux pair falls back to the local model, never an empty provider', async () => {
  const seen = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { seen.push(o); yield* OK_TEXT } } }
  const a = jevAdapter({
    ctx, route: async () => '', auxModel: EMPTY_AUX,
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    isOffline: async () => false,
  })
  for (const purpose of ['session-title', 'compaction']) {
    for await (const _ of a.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], purpose, signal: new AbortController().signal })) { /* drain */ }
  }
  assert.deepEqual(seen.map((o) => `${o.provider}/${o.model}`), ['local/qwen3-8b', 'local/qwen3-8b'], 'the empty pair never beats the local one')
  assert.ok(seen.every((o) => o.provider !== '' && o.model !== ''), 'no request carries an empty provider and model')
})

test('an empty aux pair is never offered as a chat model: the question falls back to an agent', async () => {
  const asked = []
  let routedTask
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(`${o.provider}/${o.model}`); yield* OK_TEXT } } }
  const a = jevAdapter({
    ctx, route: async ({ task }) => { routedTask = task; return 'agent answer' },
    classify: async () => ({ kind: 'question' }),
    auxModel: EMPTY_AUX,
    localChat: async () => null,
  })
  assert.equal(await run(a, 'what is this?'), 'agent answer')
  assert.deepEqual(asked, [], 'the empty pair is filtered out, so no provider is ever asked with blank names')
  assert.match(routedTask, /Do not modify any files[\s\S]*what is this\?/)
})

test('offline mode classifies locally: the classifier is told the mode, never the network', async () => {
  const seen = []
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ emit }) => { emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async (task, mode) => { seen.push(mode); return { kind: 'task' } },
    auxModel: aux,
    agents: async () => AGENTS,
  })
  await runAs(a, 'jev-offline', 'add a test')
  await runAs(a, 'jev-auto', 'add a test')
  assert.deepEqual(seen, ['offline', 'auto'], 'the picked mode reaches the classifier')
})

const LOCAL_AGENTS = [
  { id: 'claude', name: 'Claude Code', enabled: true },
  { id: 'gemma-local', name: 'Gemma 4 E4B (local)', kind: 'local', enabled: true, size: 4_300_000_000 },
  { id: 'qwen-local', name: 'Qwen3 8B (local)', kind: 'local', enabled: true, size: 8_100_000_000 },
]

test('a local effort forces that local model and keeps the run local', async () => {
  const seen = []
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, mode, effort, emit }) => { seen.push({ forceAgent, mode, effort }); emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => LOCAL_AGENTS,
  })
  await runAs(a, 'jev-auto', 'do it', { reasoningEffort: 'local-low' })
  await runAs(a, 'jev-auto', 'do it', { reasoningEffort: 'local-high' })
  assert.deepEqual(seen[0], { forceAgent: 'gemma-local', mode: 'local', effort: undefined }, 'quick goes to the smaller model')
  assert.deepEqual(seen[1], { forceAgent: 'qwen-local', mode: 'local', effort: undefined }, 'best goes to the larger one')
})

test('an ordinary effort is passed through untouched', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, mode, effort, emit }) => { seen = { forceAgent, mode, effort }; emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => LOCAL_AGENTS,
  })
  await runAs(a, 'jev-auto', 'do it', { reasoningEffort: 'xhigh' })
  assert.deepEqual(seen, { forceAgent: undefined, mode: 'auto', effort: 'xhigh' })
})

test('a picked agent row wins over a local effort', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, emit }) => { seen = forceAgent; emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => LOCAL_AGENTS,
  })
  await runAs(a, 'agent-claude', 'do it', { reasoningEffort: 'local-low' })
  assert.equal(seen, 'claude', 'the row you picked is the agent you get')
})

test('offline stays offline when a local effort is chosen', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ mode, forceAgent, emit }) => { seen = { mode, forceAgent }; emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => LOCAL_AGENTS,
  })
  await runAs(a, 'jev-offline', 'do it', { reasoningEffort: 'local-high' })
  assert.deepEqual(seen, { mode: 'offline', forceAgent: 'qwen-local' }, 'offline is not downgraded to local')
})

test('a local effort with no local model installed does not force anything', async () => {
  let seen
  const a = jevAdapter({
    ctx: chat([]),
    route: async ({ forceAgent, mode, emit }) => { seen = { forceAgent, mode }; emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    agents: async () => [{ id: 'claude', enabled: true }],
  })
  await runAs(a, 'jev-auto', 'do it', { reasoningEffort: 'local-low' })
  assert.deepEqual(seen, { forceAgent: undefined, mode: 'auto' }, 'it routes normally rather than failing')
})

// ---------- capability-routed direct answers ----------

const CHAT_EXECUTORS = [
  { id: 'chat:deepseek/deepseek-flash', provider: 'deepseek', model: 'deepseek-flash', capabilities: ['quick_answer', 'reasoned_answer'], modalities: ['text', 'image'], mutation: false, network: true, locality: 'hosted', latency: 'medium', cost: 'metered' },
  // The local model DOES declare reasoned_answer, as executorsFrom does for every chat model.
  // It must still not answer a deep question: cost ranking is for simple answers only.
  { id: 'chat:local/qwen3-8b', provider: 'local', model: 'qwen3-8b', capabilities: ['quick_answer', 'reasoned_answer'], modalities: ['text'], mutation: false, network: false, locality: 'local', latency: 'fast', cost: 'free' },
]
const answering = (asked, chunks = OK_TEXT) => ({ agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(`${o.provider}/${o.model}`); yield* chunks } } })

test('a registry-routed simple answer goes to the fast local model', async () => {
  const asked = []
  const a = jevAdapter({
    ctx: answering(asked), route: async () => '', classify: async () => ({ kind: 'question' }),
    auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    answerExecutors: async () => CHAT_EXECUTORS,
  })
  await run(a, 'hi there')
  assert.deepEqual(asked, ['local/qwen3-8b'], 'quick_answer is ranked to the free local model')
})

test('a registry-routed deep answer skips the cheaper model that also claims reasoning', async () => {
  const asked = []
  const a = jevAdapter({
    ctx: answering(asked), route: async () => '', classify: async () => ({ kind: 'question', confidence: 0.9, depth: 'deep' }),
    auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    answerExecutors: async () => CHAT_EXECUTORS,
  })
  await run(a, 'why does this deadlock?')
  assert.deepEqual(asked, ['deepseek/deepseek-flash'], 'a hard question goes to the stronger configured model, not the free one')
})

test('a registry-routed image question is never sent to a text-only chat model', async () => {
  const asked = []
  const a = jevAdapter({
    ctx: answering(asked), route: async () => '', classify: async () => ({ kind: 'question' }),
    auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    answerExecutors: async () => CHAT_EXECUTORS,
  })
  await runWith(a, [{ type: 'text', text: 'what does this say?' }, IMAGE])
  assert.deepEqual(asked, ['deepseek/deepseek-flash'], 'only the image-capable model is offered')
})

test('an empty registry falls back to the built-in order rather than answering nothing', async () => {
  const asked = []
  const a = jevAdapter({
    ctx: answering(asked), route: async () => '', classify: async () => ({ kind: 'question' }),
    auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    answerExecutors: async () => [],
  })
  await run(a, 'hi')
  assert.deepEqual(asked, ['local/qwen3-8b'], 'local-first still applies')
})

const projectCtx = (cwd = 'C:\\ws') => ({ agents: { get: () => ({ session: { header: { cwd } } }) }, llm: { async *stream() { yield* OK_TEXT } } })
const failingProjectCtx = (cwd = 'C:\\ws') => ({ agents: { get: () => ({ session: { header: { cwd } } }) }, llm: { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA' } } } } } })
const IMAGE = { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }
const runWith = async (adapter, content, extra = {}) => {
  const chunks = []
  const options = { messages: [{ role: 'user', source: { kind: 'user' }, content }], sessionId: 's', model: 'jev-auto', signal: new AbortController().signal, ...extra }
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
}

test('a Jev row offers images only when something downstream really reads them', async () => {
  const blind = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => AGENTS })
  assert.deepEqual((await blind.listModels('jev')).map((m) => m.inputModalities), [['text'], ['text'], ['text'], ['text']])

  const seeing = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => AGENTS, canSeeImages: async (m) => m.model === 'y' })
  const rows = await seeing.listModels('jev')
  assert.deepEqual(rows[0].inputModalities, ['text', 'image'], 'Jev Auto can carry what the chat model reads')
  assert.deepEqual(rows[1].inputModalities, ['text'], 'a picked agent row is only as capable as that agent')
})

test('an agent that reads image files makes its own row image-capable', async () => {
  const a = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, agents: async () => AGENTS, agentSeesImages: async (id) => id === 'codex' })
  const rows = await a.listModels('jev')
  assert.deepEqual(rows[1].inputModalities, ['text'], 'claude cannot read them here')
  assert.deepEqual(rows[2].inputModalities, ['text', 'image'], 'codex can')
})

test('an image question skips the text-only local model', async () => {
  const asked = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { asked.push(`${o.provider}/${o.model}`); yield* OK_TEXT } } }
  const a = jevAdapter({
    ctx, route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: { provider: 'deepseek', model: 'deepseek-flash' },
    localChat: async () => ({ provider: 'local', model: 'qwen3-8b' }),
    canSeeImages: async (m) => m.model === 'deepseek-flash',
  })
  const text = await runWith(a, [{ type: 'text', text: 'what is in this?' }, IMAGE])
  assert.deepEqual(asked, ['deepseek/deepseek-flash'], 'the local model has no vision add-on, so it is not asked')
  assert.match(text, /An answer\./)
})

test('an image no chat model can read goes to an agent with the file, never dropped', async () => {
  let seen
  const a = jevAdapter({
    ctx: failingProjectCtx(),
    route: async ({ task, answerOnly }) => { seen = { task, answerOnly }; return 'agent looked at it' },
    classify: async () => ({ kind: 'question' }),
    auxModel: aux,
    handOffImages: async (refs, o) => { assert.equal(refs.length, 1); assert.equal(o.cwd, 'C:\\ws'); return ['C:\\ws\\.kz-harness\\attachments\\a1.png'] },
  })
  const text = await runWith(a, [{ type: 'text', text: 'what is in this?' }, IMAGE])
  assert.equal(seen.answerOnly, true)
  assert.match(seen.task, /Open `C:\\ws\\\.kz-harness\\attachments\\a1\.png`/)
  assert.match(text, /agent looked at it/)
})

test('a task with an image carries the path on the agent prompt', async () => {
  let seen
  const a = jevAdapter({
    ctx: projectCtx(),
    route: async ({ task }) => { seen = task; return 'done' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    handOffImages: async () => ['C:\\ws\\.kz-harness\\attachments\\a1.png'],
  })
  await runWith(a, [{ type: 'text', text: 'match this layout' }, IMAGE])
  assert.match(seen, /^The person attached an image\. Open `C:\\ws\\\.kz-harness\\attachments\\a1\.png`/)
  assert.match(seen, /match this layout$/)
})

test('a task whose image cannot be placed is refused, not run blind', async () => {
  let routed = false
  const a = jevAdapter({
    ctx: projectCtx(),
    route: async () => { routed = true; return 'ran' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    handOffImages: async () => [],
  })
  const text = await runWith(a, [{ type: 'text', text: 'match this layout' }, IMAGE])
  assert.equal(routed, false, 'an agent must never work from the words alone')
  assert.match(text, /never see the picture/)
})

test('an image with no words is still a message, not an empty turn', async () => {
  let seen
  const a = jevAdapter({
    ctx: projectCtx(),
    route: async ({ task }) => { seen = task; return 'looked' },
    classify: async () => ({ kind: 'task' }),
    auxModel: aux,
    handOffImages: async () => ['C:\\ws\\.kz-harness\\attachments\\a1.png'],
  })
  const text = await runWith(a, [IMAGE])
  assert.doesNotMatch(text, /Type a task/)
  assert.match(seen, /attachments\\a1\.png/)
})

// ---------- the result never borrows the assistant's voice (the bug the review demonstrated) ----------
const READY_RESULT = {
  jobId: 'jev-3', sessionId: 's1', workspace: 'C:\\ws', task: 'Fix sidebar width', taskName: 'Fix sidebar width',
  capability: 'project_change', agent: 'codex', model: 'gpt-5.6-sol', state: 'completed', status: 'completed',
  terminalReason: null, finalStatus: 'accepted', report: 'ROUTED REPORT TEXT', finishedAt: 1, queuedAt: 0,
  deliveryState: 'pending', seq: 4,
}
const withResults = (results) => ({ results: () => results, delivering: () => true, delivered: () => true, live: () => 0, enqueue: () => null })

test('a finished result is never written into the model\'s answer', async () => {
  const a = jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: async () => ({ kind: 'question' }), auxModel: aux, orchestrator: withResults([READY_RESULT]) })
  const text = await run(a, 'how are you?')
  assert.match(text, /An answer\./, 'the answer is unaffected')
  assert.doesNotMatch(text, /ROUTED REPORT TEXT/, 'the report is not part of the assistant\'s words')
  assert.doesNotMatch(text, /Background task result/, 'and it does not wear the result heading either')
})

test('a notice turn does not smuggle a result in as the assistant either', async () => {
  // A turn with no new typed message: the engine woke the session for a notice. The result is
  // posted by the plugin as its own message, so this turn must not reproduce it as text.
  let routed = false
  const a = jevAdapter({ ctx: projectCtx(), route: async () => { routed = true; return 'ran' }, classify: async () => ({ kind: 'question' }), auxModel: aux, orchestrator: withResults([READY_RESULT]) })
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the sidebar' }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' }, content: [{ type: 'text', text: 'background job jev-3 finished' }] },
  ]
  const chunks = []
  for await (const c of a.stream({ messages, sessionId: 's1', model: 'jev-auto', signal: new AbortController().signal })) chunks.push(c)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.doesNotMatch(text, /ROUTED REPORT TEXT/)
  assert.doesNotMatch(text, /Background task result/)
  assert.equal(routed, false, 'and a notice never re-routes the earlier task')
})
// ---------- one message may do both (spec: the three-stage model) ----------
const BOTH = { kind: 'question', confidence: 0.9, alsoWork: 0.9 }

test('a message can be answered and queue work behind it at the same time', async () => {
  let queued = null
  const a = jevAdapter({
    ctx: chat(OK_TEXT), route: async () => '', classify: async () => BOTH, auxModel: aux,
    orchestrator: { results: () => [], live: () => 0, enqueue: (q) => { queued = q; return 'Queued -> codex as **jev-7** (starting now in Harness). Keep chatting: the result posts here when done.' } },
  })
  const text = await run(a, 'what does the parser do, and also fix the typo in it?')
  assert.match(text, /An answer\./, 'the question is answered')
  assert.match(text, /Queued -> codex as \*\*jev-7\*\*/, 'and the work is queued in the same breath')
  assert.ok(queued, 'the orchestrator was really asked')
  assert.equal(queued.task, 'what does the parser do, and also fix the typo in it?')
})

test('an unsure "also work" leaves it as a plain answer', async () => {
  let asked = false
  const a = jevAdapter({
    ctx: chat(OK_TEXT), route: async () => '', classify: async () => ({ kind: 'question', confidence: 0.9, alsoWork: 0.3 }), auxModel: aux,
    orchestrator: { results: () => [], live: () => 0, enqueue: () => { asked = true; return 'queued' } },
  })
  const text = await run(a, 'how does the parser work?')
  assert.match(text, /An answer\./)
  assert.equal(asked, false, 'nothing is queued on a low-confidence guess')
  assert.doesNotMatch(text, /Queued/)
})

test('a classifier that reports nothing about work still answers normally', async () => {
  const a = jevAdapter({
    ctx: chat(OK_TEXT), route: async () => '', classify: async () => ({ kind: 'question', confidence: 0.9 }), auxModel: aux,
    orchestrator: { results: () => [], live: () => 0, enqueue: () => { throw new Error('must not be called') } },
  })
  assert.match(await run(a, 'hello'), /An answer\./)
})

// ---------- Laya Auto: who decides, in every line the adapter writes (docs/laya-auto.md 3) ----------
const LAYA_RECORD = async () => (await import('../providers.js')).resolveProviders({}, { policy: (await import('../routing-policy.js')).resolvePolicy() })

test('every row says who decides it, and an unknown id is Jev Auto', async () => {
  const { rowOf } = await import('../adapter.js')
  assert.equal(typeof rowOf, 'function', 'adapter.js exports rowOf')
  assert.deepEqual(rowOf('laya-auto'), { mode: 'auto', decider: 'laya' })
  assert.deepEqual(rowOf('jev-auto'), { mode: 'auto', decider: 'jev' })
  assert.deepEqual(rowOf('jev-online'), { mode: 'online', decider: 'jev' })
  assert.deepEqual(rowOf('jev-local'), { mode: 'local', decider: 'jev' })
  assert.deepEqual(rowOf('jev-offline'), { mode: 'offline', decider: 'jev' })
  assert.deepEqual(rowOf('agent-claude'), { mode: 'auto', decider: 'jev' }, 'a picked agent is reviewed by Jev, as before')
  assert.deepEqual(rowOf(undefined), { mode: 'auto', decider: 'jev' })
})

test('the group is named for the app, and its id stays jev', async () => {
  const a = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux })
  assert.deepEqual(a.providerInfo('jev'), { id: 'jev', name: 'Kz-harness' })
})

test('the routed line names who decided: (laya), (laya, local), and Jev\'s reads as before', () => {
  const routed = (routing, extra = {}) => line({ type: 'routed', routing: { primaryAgent: 'claude', ...routing }, plan: { strategy: 'STANDARD_DIRECT' }, ...extra })
  assert.equal(routed({ mode: 'jev', decider: 'laya' }), 'Routed to claude (laya)')
  assert.equal(routed({ mode: 'local', decider: 'laya' }), 'Routed to claude (laya, local)')
  assert.equal(routed({ mode: 'manual', decider: 'laya' }), 'Routed to claude (laya, manual)')
  assert.equal(routed({ mode: 'jev', decider: 'jev' }), 'Routed to claude (jev)')
  assert.equal(routed({ mode: 'local' }), 'Routed to claude (local)', 'a record from before `decider` was kept')
  // In Jev Auto, once per run at the routed event, what the shadow does with this run's questions.
  assert.equal(routed({ mode: 'jev', decider: 'jev' }, { shadow: 'answering' }), 'Routed to claude (jev)\nLaya is answering the same questions in the background; compare them in Jev → Decisions')
  assert.equal(routed({ mode: 'jev', decider: 'jev' }, { shadow: 'not_running' }), 'Routed to claude (jev)\nLaya is not running, so this run is not compared')
})

test('decidedBy names Laya in its place among the authorities, and the decision line counts Laya\'s calls', () => {
  const domains = { task_classification: { authority: 'laya' }, skill_selection: { authority: 'laya' }, resource_selection: { authority: 'code' } }
  assert.equal(decidedBy(domains), 'Laya and routing rules decided')
  const fell = { ...domains, execution_strategy: { authority: 'fallback' } }
  assert.equal(decidedBy(fell), 'Laya, routing rules and the safe fallback (execution strategy) decided')
  assert.equal(decidedBy(fell, { detail: false }), 'Laya, routing rules and the safe fallback decided')
  const decision = (jevCalls) => line({ type: 'decision', decision: { domains, jevCalls, decider: 'laya', candidates: [{}, {}, {}] } })
  assert.equal(decision(2), 'Laya and routing rules decided; 2 Laya calls; 3 candidates considered')
  assert.equal(decision(1), 'Laya and routing rules decided; 1 Laya call; 3 candidates considered')
  assert.equal(decision(0), 'Laya and routing rules decided; no Laya call; 3 candidates considered')
  assert.equal(line({ type: 'decision', decision: { jevCalls: 0, candidates: [] } }), 'Jev decided; no Jev call; 0 candidates considered', 'with no decider named, Jev, as before')
})

test('a Laya call reads as Laya: the device, the wait, answers too flat to use, and evidence cut at the context limit', () => {
  const q = (name, over = {}) => ({ name, type: 'score', used: true, ...over })
  const questions = [q('taskType', { type: 'choice' }), q('risk', { informative: false }), q('req.planning', { informative: false }), q('humanReview', { type: 'noul', informative: false }), q('secondOpinion', { type: 'noul', informative: false }), q('weather.units', { type: 'choice', used: false, informative: false })]
  const trace = { phase: 'route', ms: 950, provider: 'laya', model: 'laya-english/0.3.20@1a2b3c4', questions, meta: { device: 'cuda', waitedMs: 4200, requests: 2, atContextLimit: 0 } }
  assert.equal(line({ type: 'jev', trace }), [
    'Laya route: 5/6 questions in 950 ms on the GPU (waited 4200 ms for an earlier Laya answer)',
    // A flat yes/no the rules do not fill (humanReview, and the second opinion a task-group call
    // carries for the profile) is kept as answered, and an unused speculative question is not said.
    'Laya route: 2 answers too flat to use (risk, req.planning); the routing rules filled them',
  ].join('\n'))
  const review = { phase: 'review', ms: 9000, provider: 'laya', questions: [q('addressed', { type: 'noul' })], meta: { device: 'cpu', waitedMs: 0, requests: 4, atContextLimit: 1 } }
  assert.equal(line({ type: 'jev', trace: review }), 'Laya review: 1/1 questions in 9000 ms on the CPU\nLaya review: 1 of 4 requests reached the 512-token limit, so part of the evidence was cut')
  // Jev's line is today's: no device, no marks.
  assert.equal(line({ type: 'jev', trace: { phase: 'route', ms: 120, provider: 'jev', questions: [q('a'), q('b', { used: false })] } }), 'Jev route: 1/2 questions in 120 ms')
})

test('the second opinion is filled by the routing rules only on the call that asks it for its own domain, never on the task-group call that carries it for the profile', () => {
  const q = (name, over = {}) => ({ name, type: 'noul', used: true, informative: false, ...over })
  const call = (questions) => line({ type: 'jev', trace: { phase: 'route', ms: 900, provider: 'laya', questions, meta: { device: 'cpu', waitedMs: 0 } } }).split('\n').slice(1)
  // The task-group call: its flat second opinion stays in the profile as answered (jev.js).
  assert.deepEqual(call([q('taskType', { type: 'choice' }), q('risk', { type: 'score' }), q('secondOpinion')]), ['Laya route: 2 answers too flat to use (taskType, risk); the routing rules filled them'])
  // The resource and judgments call: the second_opinion domain's rule answers in its place.
  assert.deepEqual(call([q('strategy', { type: 'choice' }), q('secondOpinion')]), ['Laya route: 2 answers too flat to use (strategy, secondOpinion); the routing rules filled them'])
  assert.deepEqual(call([q('secondOpinion')]), ['Laya route: 1 answer too flat to use (secondOpinion); the routing rules filled it'])
})

test('a call that did not answer is a line of its own: who, which call, how long, and why', () => {
  // What createJev hands onError, as the event carries it.
  const failed = (provider, phase, ms, message) => ({ type: 'decider-error', at: 1, error: { phase, callId: 'c1', provider, ms, error: { class: 'Error', code: 'LAYA_TIMEOUT', status: null, message } } })
  assert.equal(line(failed('laya', 'route', 42000, 'timed out (20 questions on the CPU)')), 'Laya route failed after 42000 ms: timed out (20 questions on the CPU); routing rules decide those domains')
  assert.equal(line(failed('laya', 'review', 40000, 'timed out after 40 s')), 'Laya review failed after 40000 ms: timed out after 40 s')
  assert.equal(line(failed('jev', 'route', 900, '503 Service Unavailable')), 'Jev route failed after 900 ms: 503 Service Unavailable')
})

test('a Laya call that timed out says how many questions it asked and where, from what jev.js kept of the error', () => {
  // The Laya client's timeout names only its deadline; its size and device ride beside the message.
  const late = (phase, ms, error) => ({ type: 'decider-error', at: 1, error: { phase, callId: 'c1', provider: 'laya', ms, error: { class: 'Error', status: null, message: 'timed out after 40 s', ...error } } })
  assert.equal(line(late('route', 42000, { code: 'LAYA_TIMEOUT', questions: 20, device: 'cpu' })), 'Laya route failed after 42000 ms: timed out after 40 s (20 questions on the CPU); routing rules decide those domains')
  assert.equal(line(late('review', 41000, { code: 'LAYA_TIMEOUT', questions: 9, device: 'cuda' })), 'Laya review failed after 41000 ms: timed out after 40 s (9 questions on the GPU)')
  // Any other failure says its message alone.
  assert.equal(line(late('route', 0, { code: 'LAYA_PREDICTED_OVER', questions: 20, device: 'cpu', message: 'Laya would need about 150 s for this call on the CPU, over its 120 s deadline' })), 'Laya route failed after 0 ms: Laya would need about 150 s for this call on the CPU, over its 120 s deadline')
})

test('a queued task Laya decides says Laya picks, with the reason it was queued as a task', () => {
  const base = { jobId: 'jev-4', position: 0, workspace: 'C:\\work\\Harness' }
  assert.equal(queuedLine(base), 'Queued → Jev picks as **jev-4** (starting now in Harness). Keep chatting: the result posts here when done.')
  assert.equal(queuedLine({ ...base, decider: 'laya' }), 'Queued → Laya picks as **jev-4** (starting now in Harness). Keep chatting: the result posts here when done.')
  const why = 'Laya could not sort this message (timed out after 8 s); treating it as a task.'
  assert.equal(queuedLine({ ...base, decider: 'laya', why }), `Queued → Laya picks as **jev-4** (starting now in Harness). Keep chatting: the result posts here when done. ${why}`)
  assert.equal(queuedLine({ ...base, agent: 'codex', decider: 'laya' }), 'Queued → codex as **jev-4** (starting now in Harness). Keep chatting: the result posts here when done.', 'a forced agent is named as before')
  assert.match(resultSection({ ...READY_RESULT, agent: null, model: null, decider: 'laya' }), /^Agent: Laya picks$/m, 'a result nobody was picked for yet says who would have')
  assert.match(resultSection({ ...READY_RESULT, agent: null, model: null }), /^Agent: Jev picks$/m)
})

test('a Laya Auto message is sorted by Laya and read against Laya\'s bars, where Jev\'s would answer it', async () => {
  const { jev, laya } = await LAYA_RECORD()
  const sorted = []
  const make = (thresholds, cls, orchestrator) => jevAdapter({
    ctx: chat(OK_TEXT), auxModel: aux, orchestrator,
    route: async ({ decider, emit }) => { emit({ type: 'final', status: 'accepted' }); return `routed by ${decider}` },
    classify: async (task, mode, decider) => { sorted.push([mode, decider]); return { ...cls, thresholds } },
  })
  // A question at 0.7 clears Jev's 0.6 and not Laya's 0.8, so Laya Auto runs it as a task.
  const unsure = { kind: 'question', confidence: 0.7 }
  assert.match(await runAs(make(jev.thresholds, unsure), 'jev-auto', 'what is this?'), /^An answer\./)
  assert.equal(await runAs(make(laya.thresholds, unsure), 'laya-auto', 'what is this?'), 'routed by laya')
  assert.deepEqual(sorted, [['auto', 'jev'], ['auto', 'laya']], 'each row\'s decider sorts its message')
  // "Also do the work" at 0.75 clears Jev's 0.7 and not Laya's 0.8.
  const both = { kind: 'question', confidence: 0.95, alsoWork: 0.75 }
  const queued = []
  const orchestrator = { results: () => [], live: () => 0, enqueue: (fields, extra) => { queued.push(extra); return 'queued' } }
  await runAs(make(jev.thresholds, both, orchestrator), 'jev-auto', 'how does it work, and fix it?')
  await runAs(make(laya.thresholds, both, orchestrator), 'laya-auto', 'how does it work, and fix it?')
  assert.deepEqual(queued, [{ decider: 'jev' }], 'only Jev\'s bar queued the work')
  // Laya's reason for the stronger model is Laya's.
  const deep = await runAs(make(laya.thresholds, { kind: 'question', confidence: 0.95, depth: 'deep' }), 'laya-auto', 'why does this deadlock?')
  assert.match(deep, /Laya judged this worth the stronger model, so Answered by: x\/y/)
})

test('a Laya Auto task is routed and queued as Laya\'s, and a Jev row\'s as Jev\'s', async () => {
  const routed = []
  const queued = []
  const a = jevAdapter({
    ctx: chat([]), auxModel: aux, agents: async () => AGENTS,
    route: async ({ decider, mode, emit }) => { routed.push([decider, mode]); emit({ type: 'final', status: 'accepted' }); return 'ok' },
    classify: async () => ({ kind: 'task' }),
  })
  for (const id of ['laya-auto', 'jev-auto', 'jev-offline']) await runAs(a, id, 'fix the parser')
  assert.deepEqual(routed, [['laya', 'auto'], ['jev', 'auto'], ['jev', 'offline']])
  const b = jevAdapter({
    ctx: chat([]), auxModel: aux, agents: async () => AGENTS, route: async () => 'unused', classify: async () => ({ kind: 'task' }),
    orchestrator: { results: () => [], live: () => 0, enqueue: (fields, extra) => { queued.push({ task: fields.task, ...extra }); return 'queued' } },
  })
  await runAs(b, 'laya-auto', 'fix the parser')
  await runAs(b, 'jev-auto', 'fix the parser')
  assert.deepEqual(queued, [{ task: 'fix the parser', decider: 'laya', why: null }, { task: 'fix the parser', decider: 'jev', why: null }])
  assert.equal(await runAs(b, 'laya-auto', ''), 'Type a task and Laya will route it.')
})

test('nothing Laya Auto shows names Jev: the near-tie line and the Auto effort say who they are', async () => {
  const tie = (decider) => line({ type: 'tiebreak', from: 'deepseek', to: 'claude', confidence: 0.41, margin: 0.1, ...(decider ? { decider } : {}) })
  assert.equal(tie('laya'), 'The routing rules could not tell deepseek from claude (confidence 41%): claude takes the work as the standing policy')
  assert.equal(tie('jev'), 'Jev could not tell deepseek from claude (confidence 41%): claude takes the work as the standing policy')
  assert.equal(tie(), tie('jev'), 'as it always read')
  const a = jevAdapter({ ctx: chat([]), route: async () => '', auxModel: aux, layaRow: async () => ({ state: 'failed' }) })
  const auto = (row) => row.reasoning.efforts.find((e) => e.id === 'auto').description
  const [jevRow, layaRow] = await a.listModels('jev')
  assert.equal(auto(layaRow), 'Laya picks by task (Settings default applies)')
  assert.equal(auto(jevRow), 'Jev picks by task (Settings default applies)')
  assert.deepEqual(layaRow.reasoning.efforts.map((e) => e.id), jevRow.reasoning.efforts.map((e) => e.id), 'the same ladder')
})

test('a Laya call never sent because it would pass its deadline reads word for word as the design writes it', () => {
  const failed = (ms, code, message) => ({ type: 'decider-error', at: 1, error: { phase: 'route', callId: 'c1', provider: 'laya', ms, error: { class: 'Error', code, status: null, message } } })
  assert.equal(line(failed(0, 'LAYA_PREDICTED_OVER', 'Laya would need about 150 s for this call on the CPU, over its 120 s deadline')), 'Laya route failed after 0 ms: Laya would need about 150 s for this call on the CPU, over its 120 s deadline')
  // A call that was sent and did not answer still says the rules decide those domains.
  assert.equal(line(failed(42000, 'LAYA_TIMEOUT', 'timed out (20 questions on the CPU)')), 'Laya route failed after 42000 ms: timed out (20 questions on the CPU); routing rules decide those domains')
})

test('a flat tool pick or tool argument is not said to be filled by the rules: the pick stands and only falls under its bar', () => {
  const q = (name, over = {}) => ({ name, type: 'choice', used: true, informative: false, ...over })
  const meta = { device: 'cpu', waitedMs: 0, requests: 1, atContextLimit: 0 }
  const route = (questions) => line({ type: 'jev', trace: { phase: 'route', ms: 800, provider: 'laya', questions, meta } })
  assert.equal(route([q('handler'), q('weather.fits', { type: 'noul' }), q('weather.units'), q('risk', { type: 'score' }), q('strategy')]), [
    'Laya route: 5/5 questions in 800 ms on the CPU',
    'Laya route: 2 answers too flat to use (risk, strategy); the routing rules filled them',
  ].join('\n'))
  assert.equal(route([q('handler'), q('weather.units'), q('taskType', { informative: true })]), 'Laya route: 3/3 questions in 800 ms on the CPU', 'with only the tool\'s answers flat, nothing is said to be filled')
})

test('a question answered directly tells the usage hook which row it came through: Laya\'s in Laya Auto, Jev\'s in Jev Auto', async () => {
  const hooked = []
  const a = jevAdapter({
    ctx: chat(OK_TEXT), auxModel: aux2, route: async () => 'unused',
    classify: async () => ({ kind: 'question', confidence: 0.95 }),
    onDirectAnswer: (ms, m, row) => hooked.push([typeof ms, m, row]),
  })
  for (const id of ['laya-auto', 'jev-auto']) assert.match(await runAs(a, id, 'what does this flag do?'), /^An answer\./, id)
  assert.deepEqual(hooked, [['number', aux2, { decider: 'laya' }], ['number', aux2, { decider: 'jev' }]])
})

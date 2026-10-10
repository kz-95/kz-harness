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

test('the intent call is told the folder the message was sent in, where its task would run, No project included, where a question it reads is answered', async () => {
  const { fileURLToPath } = await import('node:url')
  const noProject = fileURLToPath(new URL('../../../no-project', import.meta.url))
  const told = []
  const classify = async (message, mode, decider, o) => { told.push(o?.cwd); return { kind: 'question', confidence: 0.95 } }
  const ok = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'Use flexbox.' }, { type: 'finish', reason: { kind: 'stop' } }]
  const ctxIn = (cwd) => ({ agents: { get: () => ({ session: { header: { cwd } } }) }, llm: { async *stream() { yield* ok } } })
  let routed = false
  const route = async () => { routed = true; return '' }
  assert.ok((await run(jevAdapter({ ctx: ctxIn(noProject), route, classify, auxModel: aux }), 'how do I center a div?')).startsWith('Use flexbox.'))
  assert.ok((await run(jevAdapter({ ctx: ctxIn('/work/kz-harness'), route, classify, auxModel: aux }), 'how do I center a div?')).startsWith('Use flexbox.'))
  assert.deepEqual(told, [noProject, '/work/kz-harness'], 'each sorted knowing where it was sent')
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

test('the routed line of a run the router stops for a person names no agent, only who read it so', () => {
  // As router.js emits it: its routing still says whom the decider would have picked.
  const stops = (routing, extra = {}) => line({ type: 'routed', routing: { primaryAgent: 'claude', mode: 'jev', capability: 'human_required', ...routing }, plan: { strategy: 'STANDARD_DIRECT' }, stopsForPerson: true, ...extra })
  assert.equal(stops({ decider: 'jev' }), 'Jev read this as needing a person: no agent runs')
  assert.equal(stops({ decider: 'laya' }), 'Laya read this as needing a person: no agent runs')
  assert.equal(stops({}), 'Jev read this as needing a person: no agent runs', 'a record from before `decider` was kept')
  assert.equal(stops({ decider: 'jev' }, { shadow: 'not_running' }), 'Jev read this as needing a person: no agent runs\nLaya is not running, so this run is not compared')
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
  // Where it will stand, with why, in the work board's words.
  assert.equal(queuedLine({ ...base, wait: null }), 'Queued → Jev picks as **jev-4** (starting now in Harness). Keep chatting: the result posts here when done.')
  assert.equal(queuedLine({ ...base, wait: { why: 'workspace', place: 2, ahead: 0 } }), 'Queued → Jev picks as **jev-4** (2nd in line for Harness: another task is running there). Keep chatting: the result posts here when done.')
  assert.equal(queuedLine({ ...base, wait: { why: 'line', place: 2, ahead: 1 } }), 'Queued → Jev picks as **jev-4** (2nd in line for Harness: an earlier task there is waiting for a free slot). Keep chatting: the result posts here when done.')
  assert.equal(queuedLine({ ...base, wait: { why: 'cap', place: 1, ahead: 0, slot: 1 } }), 'Queued → Jev picks as **jev-4** (next for a free slot to start in Harness: the resource budget caps how many tasks run at once). Keep chatting: the result posts here when done.', 'not "1st in line"')
  assert.equal(queuedLine({ ...base, wait: { why: 'cap', place: 1, ahead: 0, slot: 3 } }).includes('(3rd for a free slot to start in Harness:'), true)
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
  assert.deepEqual(queued, [{ decider: 'jev', readVerdict: null, message: 'how does it work, and fix it?' }], 'only Jev\'s bar queued the work')
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
  assert.deepEqual(queued, [{ task: 'fix the parser', decider: 'laya', why: null, readVerdict: null, message: 'fix the parser' }, { task: 'fix the parser', decider: 'jev', why: null, readVerdict: null, message: 'fix the parser' }])
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

test('a task queued behind a run from the chat says a run from the chat holds its folder', () => {
  const base = { jobId: 'jev-4', position: 0, workspace: 'C:\\work\\Harness' }
  assert.equal(queuedLine({ ...base, wait: { why: 'chat', place: 2, ahead: 0 } }), 'Queued → Jev picks as **jev-4** (2nd in line for Harness: a run started from the chat is using it). Keep chatting: the result posts here when done.')
})

// ---------- the start reply: A, B and C, its marks, and the wait for the pick (docs/live-agent-view.md Feature 2) ----------
const KEY = '5f8d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f'
const PLAN = { agent: 'claude', model: 'claude-opus-4-1', effort: 'high', level: 'high', speed: null }
const PICKED = { plan: PLAN, gen: 1, runId: 'run-4', ms: 2400, decidedBy: { by: 'decider', decider: 'jev', taskType: 'implementation', complexity: 0.4, risk: 0.5, from: 'auto' } }
/** What orchestrator.enqueue answers for a task that starts at once (index.js). */
const startsNow = (over = {}) => ({ line: 'the reply without a wait', jobId: 'jev-4', key: KEY, runId: null, startsNow: true, forcedPlan: null, waitMs: 15_000, progress: 'milestones', waiting: null, access: null, ...over })
const strip = (text) => JSON.parse(Buffer.from(/^\[jev-agents\]: kzh-agents-1-(\S+)$/m.exec(text)?.[1] ?? '', 'base64url').toString() || 'null')
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
/** Stream one typed message, collecting every chunk; `signal` may stop it. */
async function streamOf(adapter, text, { model = 'jev-auto', signal = new AbortController().signal, messages } = {}) {
  const chunks = []
  let error = null
  try {
    for await (const c of adapter.stream({ messages: messages ?? [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], sessionId: 's', model, signal })) chunks.push(c)
  } catch (err) { error = err }
  return { chunks, text: textOf(chunks), error }
}

test('with enqueue returning {line, jobId, key, startsNow:true} and watchPlan resolving in 10 ms, the text starts \'OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high)\', carries the job, run and agents marks, emits no reasoning chunk, and calls noteAck with gen 1', async () => {
  const acks = []
  const waited = []
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: {
      results: () => [], live: () => 0,
      enqueue: async () => startsNow(),
      watchPlan: (key, o) => { waited.push([key, o.waitMs]); return new Promise((r) => setTimeout(() => r(PICKED), 10)) },
      noteAck: (key, ack) => acks.push([key, ack]),
    },
  })
  const { chunks, text } = await streamOf(a, 'fix the parser')
  assert.ok(text.startsWith('OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high)'), text)
  assert.equal(text.split('\n\n[jev-job]')[0], 'OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.\n\n> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.')
  assert.match(text, new RegExp(`^\\[jev-job\\]: kzh-job-1-${KEY}$`, 'm'), 'the task, by its key')
  assert.match(text, /^\[jev-run\]: kzh-run-1-run-4$/m, 'the run')
  assert.deepEqual(strip(text), [{ agent: 'Jev', model: '', roles: [] }, { agent: 'claude', model: 'claude-opus-4-1, high', roles: ['work'] }], 'who picked, then the worker by its id')
  assert.deepEqual(chunks.filter((c) => c.type === 'reasoning-delta' || c.blockType === 'reasoning'), [], 'a quick pick shows no reasoning block')
  assert.deepEqual(waited, [[KEY, 15_000]], 'it waited on the task\'s key, for the setting\'s bound')
  assert.deepEqual(acks, [[KEY, { gen: 1, said: { agent: 'claude', effort: 'high' } }]])
  assert.equal(chunks.at(-1).type, 'finish')
})

test('a pick that gives the work to a tool names no effort in its credit: the effort is the fallback agent\'s, which runs only if the tool fails', async () => {
  // The router fills in the agent that takes over from the tool, with its effort (router.js routed).
  const plan = { agent: 'codex', model: null, effort: 'medium', level: 'medium', speed: null, tool: 'lint' }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: {
      results: () => [], live: () => 0, enqueue: async () => startsNow(), noteAck: () => {},
      watchPlan: async () => ({ plan, gen: 1, runId: 'run-4', ms: 1200, decidedBy: { by: 'decider', decider: 'jev', taskType: 'simple_change', complexity: 0.2, risk: 0.2, from: 'auto' } }),
    },
  })
  const { text } = await streamOf(a, 'lint the parser')
  const said = text.split('\n\n[jev-job]')[0]
  assert.equal(said, 'OK, I\'ll run the **lint** tool on this in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.\n\n> Picked by Jev in 1.2 s: a small change, low risk.')
  assert.doesNotMatch(said, /effort/)
})

test('reply A names the reviewer and the planner the plan has, and says a local model goes first only when the plan says so', async () => {
  /** Reply A's words before its marks, for the plan `plan`. */
  const replyOf = async (plan) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux,
      agents: async () => [...AGENTS, { id: 'qwen-local', name: 'Qwen (local)', description: 'A local model on this PC.', enabled: true }],
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), noteAck: () => {}, watchPlan: async () => ({ ...PICKED, plan }) },
    })
    return (await streamOf(a, 'fix the parser')).text.split('\n\n[jev-job]')[0]
  }
  const credit = '\n\n> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.'
  const reviewed = { ...PLAN, reviewer: { agent: 'codex', model: 'gpt-5.5' }, planner: { agent: 'claude', model: 'claude-opus-4-1' } }
  assert.equal(await replyOf(reviewed), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness, and **Codex (GPT)** reviews it before it's accepted. **Claude Code** (claude-opus-4-1) writes a plan for it first. I'll report back here when it's done. Keep chatting.${credit}`)
  // A local model kept in front of the routed resource, which takes over if it fails (tasks.js planOf).
  const local = { agent: 'qwen-local', model: 'qwen3-8b', effort: null, level: null, speed: null, localFirst: true }
  assert.equal(await replyOf(local), `OK, I'll run **Qwen (local)** with **qwen3-8b** in the background as **jev-4** in kz-harness. If the local model can't finish it, a stronger agent takes over. I'll report back here when it's done. Keep chatting.${credit.replace(', so effort high', '')}`)
  assert.doesNotMatch(await replyOf({ ...local, localFirst: undefined }), /local model/, 'a plan that keeps no local step in front says nothing of one')
})

test('reply A carries the agent strip the orchestrator works out for the pick, its router step first, rather than one of its own', async () => {
  // As index.js planned() gives it: router.js routerStep for the routing (here the local router, which
  // decided every domain), then the worker by its id.
  const steps = [{ agent: 'Local router', model: '', roles: [] }, { agent: 'claude', model: 'claude-opus-4-1, high', roles: ['work'] }]
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), noteAck: () => {}, watchPlan: async () => ({ ...PICKED, steps }) },
  })
  const { text } = await streamOf(a, 'fix the parser')
  assert.ok(text.startsWith('OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high)'), text)
  assert.deepEqual(strip(text), steps, 'the chain as the orchestrator named it')
})

test('reply A credits the pick to whoever the orchestrator says made it, and one made on this PC after the decider was asked says it could not pick, never that no call was made', async () => {
  /** Reply A's credit, for a pick decided as `decidedBy` says (index.js planned()). */
  const creditOf = async (decidedBy) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), noteAck: () => {}, watchPlan: async () => ({ ...PICKED, decidedBy: { ...PICKED.decidedBy, ...decidedBy } }) },
    })
    return (await streamOf(a, 'fix the parser')).text.split('\n\n[jev-job]')[0].split('\n\n')[1]
  }
  const reason = 'Error: 503 Service Unavailable'
  assert.equal(await creditOf({ by: 'local', called: true, reason }), `> Picked on this PC in 2.4 s, since Jev could not pick (${reason}): a code change, medium risk, so effort high.`)
  assert.equal(await creditOf({ by: 'local', called: true }), '> Picked on this PC in 2.4 s, since Jev could not pick: a code change, medium risk, so effort high.', 'asked, and its answers too flat to use')
  assert.equal(await creditOf({ by: 'local', called: false }), '> Picked on this PC in 2.4 s, no Jev call: a code change, medium risk, so effort high.')
  assert.equal(await creditOf({ by: 'rules', called: true, reason }), `> Picked by the routing rules in 2.4 s, since Jev could not pick (${reason}); effort high (Auto in Settings).`)
})

test('reply A\'s credit says your ratings moved its Auto effort a step where the orchestrator says they did, and gives the profile only the step it gave', async () => {
  // Medium risk reads high (effort.js autoLevel), and your ratings ran it a step lower (index.js planned()).
  const plan = { ...PLAN, effort: 'medium', level: 'medium' }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), noteAck: () => {}, watchPlan: async () => ({ ...PICKED, plan, decidedBy: { ...PICKED.decidedBy, nudged: { from: 'high', to: 'medium', why: 'your ratings' } } }) },
  })
  const said = (await streamOf(a, 'fix the parser')).text.split('\n\n[jev-job]')[0]
  assert.equal(said, 'OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort medium) in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.\n\n> Picked by Jev in 2.4 s: a code change, medium risk; effort medium (Auto, lowered one step by your ratings).')
})

test('watchPlan never resolving with waitMs 100: the reasoning block opens only after 600 ms of silence (manual timers) and reply C follows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const acks = []
  const make = (waitMs) => jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs }), watchPlan: () => new Promise(() => {}), noteAck: (key, ack) => acks.push(ack) },
  })
  const reasoning = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  // A bound under the quiet time: C at the bound, and no block at all.
  const quick = { chunks: [], done: null }
  quick.done = (async () => { for await (const c of make(100).stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId: 's', model: 'jev-auto', signal: new AbortController().signal })) quick.chunks.push(c) })()
  await settle()
  t.mock.timers.tick(100)
  await settle()
  await quick.done
  assert.equal(reasoning(quick.chunks), '', 'no block opens before 600 ms')
  assert.equal(textOf(quick.chunks), `OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (0.1 s so far). I'll say here which one it picks, and report back when it's done. Keep chatting.\n\n[jev-job]: kzh-job-1-${KEY}`)
  // A longer bound: nothing for 599 ms, then the block with the wait's own line, then C at the bound.
  const slow = { chunks: [], done: null }
  slow.done = (async () => { for await (const c of make(1500).stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId: 's2', model: 'jev-auto', signal: new AbortController().signal })) slow.chunks.push(c) })()
  await settle()
  t.mock.timers.tick(599)
  await settle()
  assert.equal(slow.chunks.length, 0, 'nothing yet: a quick pick would look instant')
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(slow.chunks.map((c) => c.type), ['block-start', 'reasoning-delta'])
  assert.equal(slow.chunks[0].blockType, 'reasoning')
  assert.equal(reasoning(slow.chunks), 'Queued as jev-4. Choosing the agent (I reply once it\'s picked, at most 1.5 s). Stop here ends this reply only; the task keeps going (stop it on the work board).\n')
  t.mock.timers.tick(900)
  await settle()
  await slow.done
  const blocks = slow.chunks.filter((c) => c.type === 'block-start').map((c) => [c.blockType, c.index])
  assert.deepEqual(blocks, [['reasoning', 0], ['text', 1]], 'the reply is numbered after the block')
  assert.ok(textOf(slow.chunks).startsWith('OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (1.5 s so far).'), textOf(slow.chunks))
  assert.deepEqual(acks, [{ gen: 0, said: null, bound: true }, { gen: 0, said: null, bound: true }], 'each named no plan, so its started notice follows, and went out when its wait ran out')
})

test('a forced agent replies A without calling watchPlan', async () => {
  let watched = false
  const acks = []
  const line = 'OK, I\'ll run **Codex (GPT)** with **gpt-5.5** (effort medium) in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.\n\n> You picked Codex (GPT); effort medium (Auto in Settings).'
  const forcedPlan = { agent: 'codex', model: 'gpt-5.5', effort: 'medium', level: 'medium', speed: null }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ line, runId: 'run-4', forcedPlan }), watchPlan: async () => { watched = true; return PICKED }, noteAck: (key, ack) => acks.push(ack) },
  })
  const { text } = await streamOf(a, 'fix the parser', { model: 'agent-codex' })
  assert.equal(text.split('\n\n[jev-job]')[0], line, 'the plan, known as it was queued')
  assert.match(text, /^\[jev-run\]: kzh-run-1-run-4$/m)
  assert.deepEqual(strip(text), [{ agent: 'codex', model: 'gpt-5.5, medium', roles: ['work'] }], 'nobody picked: the worker alone')
  assert.equal(watched, false, 'nothing to wait for')
  assert.deepEqual(acks, [{ gen: 1, said: { agent: 'codex', effort: 'medium' } }], 'it named the plan its first routing will have')
})

test('an abort during the wait yields no text and never calls noteAck or stop', async () => {
  const stop = new AbortController()
  const calls = []
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => { calls.push('route'); return 'ran' }, classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: {
      results: () => [], live: () => 0,
      // Stopped while the reply waits for the pick.
      enqueue: async () => { setTimeout(() => stop.abort(), 5); return startsNow() },
      watchPlan: () => new Promise(() => {}),
      noteAck: () => calls.push('noteAck'),
      stop: () => calls.push('stop'),
    },
  })
  const { chunks, error } = await streamOf(a, 'fix the parser', { signal: stop.signal })
  assert.deepEqual(chunks.filter((c) => c.type === 'text-delta'), [], 'no text')
  assert.equal(error?.name, 'AbortError', 'the reply ends as stopped')
  assert.deepEqual(calls, [], 'the task goes on: nothing stops it, and the reply named nothing')
})

test('a legacy string from enqueue yields exactly today\'s line', async () => {
  const line = 'Queued → Jev picks as **jev-4** (starting now in kz-harness). Keep chatting: the result posts here when done.'
  const asked = []
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => line, watchPlan: () => { asked.push('watchPlan'); return new Promise(() => {}) }, noteAck: () => { asked.push('noteAck') } },
  })
  const { chunks, text, error } = await streamOf(a, 'fix the parser')
  assert.equal(error, null)
  assert.equal(text, line)
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(asked, [], 'a line with no task key is the reply as it always was: nothing waits, and nothing is noted on a task')
})

test('alsoWork appends C\'s sentence without waiting', async () => {
  let watched = false
  const acks = []
  const a = jevAdapter({
    ctx: { ...projectCtx('C:\\work\\kz-harness'), llm: { async *stream() { yield* OK_TEXT } } }, route: async () => 'unused', classify: async () => BOTH, auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), watchPlan: () => { watched = true; return new Promise(() => {}) }, noteAck: (key, ack) => acks.push(ack) },
  })
  const { text } = await streamOf(a, 'what does the parser do, and also fix the typo in it?')
  assert.ok(text.startsWith('An answer.'), text)
  assert.ok(text.endsWith('\n\nOK, **jev-4** is starting in kz-harness, and Jev is choosing the agent.'), text)
  assert.equal(watched, false, 'the answer is out; nothing waits for the pick')
  assert.deepEqual(acks, [{ gen: 0, said: null, now: true }], 'it named no plan, so a started notice follows, and went out at once beside a task that starts at once')
  // One that waits its turn says where it stands instead.
  const b = jevAdapter({
    ctx: { ...projectCtx('C:\\work\\kz-harness'), llm: { async *stream() { yield* OK_TEXT } } }, route: async () => 'unused', classify: async () => BOTH, auxModel: aux,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ startsNow: false, waiting: { why: 'workspace', place: 2, ahead: 0 } }), noteAck: () => {} },
  })
  assert.ok((await streamOf(b, 'what does the parser do, and also fix the typo in it?')).text.endsWith('\n\nOK, **jev-4** is queued: 2nd in line for kz-harness (another task is running there).'))
})

test('the person\'s own words ride beside each task the adapter queues, for the reply ledger, while the task carries the line that hands the agent the picture: a task asked for, and work asked for beside a question answered directly', async () => {
  const queued = []
  const orchestrator = { results: () => [], live: () => 0, enqueue: async (fields, extra) => { queued.push([fields.task, extra?.message ?? null]); return startsNow() }, watchPlan: async () => null, noteAck: () => {} }
  const sent = (classify) => jevAdapter({ ctx: projectCtx(), route: async () => 'unused', classify, auxModel: aux, canSeeImages: async () => true, handOffImages: async () => ['C:\\ws\\.kz-harness\\attachments\\a1.png'], orchestrator })
  await runWith(sent(async () => ({ kind: 'task' })), [{ type: 'text', text: 'match this layout' }, IMAGE])
  const answered = await runWith(sent(async () => BOTH), [{ type: 'text', text: 'what is in this, and can you also match it?' }, IMAGE])
  assert.match(answered, /^An answer\./, 'the question was answered directly, and its work queued behind it')
  const line = 'The person attached an image. Open `C:\\ws\\.kz-harness\\attachments\\a1.png` and look at it before you answer.\n\n'
  assert.deepEqual(queued, [
    [`${line}match this layout`, 'match this layout'],
    [`${line}what is in this, and can you also match it?`, 'what is in this, and can you also match it?'],
  ])
})

test('the intent call taking over 600 ms opens the \'Jev is reading your message\' block', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const [model, who] of [['jev-auto', 'Jev'], ['laya-auto', 'Laya']]) {
    let sorted
    const a = jevAdapter({ ctx: chat(OK_TEXT), route: async () => 'unused', classify: () => new Promise((r) => { sorted = r }), auxModel: aux })
    const chunks = []
    const done = (async () => { for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'what is a parser?' }] }], sessionId: model, model, signal: new AbortController().signal })) chunks.push(c) })()
    await settle()
    t.mock.timers.tick(599)
    await settle()
    assert.equal(chunks.length, 0, 'a quick call shows nothing')
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'reasoning-delta'])
    assert.equal(chunks[1].text, `${who} is reading your message (task or question)…\n`)
    sorted({ kind: 'question' })
    await settle()
    await done
    const blocks = chunks.filter((c) => c.type === 'block-start').map((c) => [c.blockType, c.index])
    assert.deepEqual(blocks.slice(0, 2), [['reasoning', 0], ['text', 1]], 'the answer follows the block, numbered after it')
    assert.ok(textOf(chunks).startsWith('An answer.'))
  }
})

test('answerDirectly\'s messages drop jev-router progress notices and keep result notices; ABOUT carries the live sentence when tasks are live', async () => {
  const seen = []
  const ctx = { agents: { get: () => ({}) }, llm: { async *stream(o) { seen.push(o.messages); yield* OK_TEXT } } }
  const live = 'Right now in this chat: jev-4 is running on Claude Code (6 min, last: running claude (primary)…); jev-5 waits 2nd in line.'
  const notice = (summary) => ({ role: 'user', source: { kind: 'plugin', plugin: 'jev-router', form: 'notice', summary }, content: [{ type: 'text', text: `body of ${summary}` }] })
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent.' }] },
    notice('jev-4 started: Claude Code, claude-opus-4-1, effort high'),
    notice('jev-3 · Fix the sidebar · Completed'),
    notice('jev-2 moved to Codex'),
    { role: 'user', source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'job x' }, content: [{ type: 'text', text: 'another plugin\'s notice' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'how is it going?' }] },
  ]
  const make = (status) => jevAdapter({ ctx, route: async () => 'unused', classify: async () => ({ kind: 'question' }), auxModel: aux, orchestrator: { results: () => [], live: () => 1, liveStatus: async () => status, enqueue: () => null } })
  assert.ok((await streamOf(make(live), null, { messages })).text.startsWith('An answer.'))
  const sent = seen.at(-1)
  assert.deepEqual(sent.map((m) => m.source?.summary ?? null), [null, null, 'jev-3 · Fix the sidebar · Completed', 'job x', null], 'progress notices are left out; a result and another plugin\'s notice stay')
  const about = sent.at(-1).content[0].text
  assert.ok(about.startsWith('You are talking with the person who runs this app'), about)
  assert.ok(about.endsWith(` ${live}`), 'the live sentence follows ABOUT')
  assert.equal(sent.at(-1).content[1].text, 'how is it going?')
  // Nothing live, nothing said: ABOUT as it always was.
  await streamOf(make(''), null, { messages })
  assert.doesNotMatch(seen.at(-1).at(-1).content[0].text, /Right now/)
})

test('reply C notes that its wait for the pick ran out when it did, and no other reply does: not C written at once with no wait, nor one after a hand-back, nor one whose wait ended early with nothing to say', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  /** What the reply noted for a task that starts at once, with watchPlan and the wait as given, and the clock moved on `ms` once the wait began. */
  const ackOf = async (watchPlan, { waitMs = 100, ms = 0 } = {}) => {
    const acks = []
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs }), watchPlan, noteAck: (key, ack) => acks.push(ack) },
    })
    const done = (async () => { for await (const _ of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId: 's', model: 'jev-auto', signal: new AbortController().signal })) { /* the reply */ } })()
    await settle()
    if (ms) t.mock.timers.tick(ms)
    await settle()
    await done
    return acks
  }
  assert.deepEqual(await ackOf(() => new Promise(() => {}), { ms: 100 }), [{ gen: 0, said: null, bound: true }], 'its wait ran out: C at the bound')
  assert.deepEqual(await ackOf(async () => null), [{ gen: 0, said: null }], 'a wait that ended at once with nothing to say, a task watchPlan could not find, did not run out')
  assert.deepEqual(await ackOf(async () => { throw new Error('the watch failed') }), [{ gen: 0, said: null }], 'nor did one whose watch failed')
  assert.deepEqual(await ackOf(() => new Promise(() => {}), { waitMs: 0 }), [{ gen: 0, said: null, now: true }], 'nor C written at once, with the wait set to none, which notes that it went out at once')
  assert.deepEqual(await ackOf(async () => ({ handedBack: true, waiting: null, why: 'it needs to change files' })), [{ gen: 0, said: null }], 'nor a reply after a read pass handed its task back')
})

test('a task that ends during the wait is answered that it ended, with its job mark, no agents mark, and a noteAck that names no plan', async () => {
  const acks = []
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ runId: 'run-4' }), watchPlan: async () => ({ settled: 'failed' }), noteAck: (key, ack) => acks.push([key, ack]) },
  })
  const { chunks, text } = await streamOf(a, 'fix the parser')
  assert.equal(text.split('\n\n[jev-job]')[0], '**jev-4** ended before Jev picked its agent (Failed). Its result is posted here as its own message.', 'not C, which would say it is starting')
  assert.match(text, new RegExp(`^\\[jev-job\\]: kzh-job-1-${KEY}$`, 'm'), 'the task, by its key')
  assert.match(text, /^\[jev-run\]: kzh-run-1-run-4$/m, 'the run it had begun')
  assert.equal(strip(text), null, 'nobody was picked, so no agent strip')
  assert.deepEqual(chunks.filter((c) => c.type === 'reasoning-delta' || c.blockType === 'reasoning'), [], 'it ended at once: no block opened')
  assert.deepEqual(acks, [[KEY, { gen: 0, said: null }]], 'it named no plan')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('reply C, written once its task has started, carries the run the task began, and so does a reply that it ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  /** The reply for a task queued before its run began, which began run-5 since (orchestrator.runOf), with watchPlan as given. */
  const replyOf = async (watchPlan) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs: 100, runId: null }), watchPlan, noteAck: () => {}, runOf: (key) => (key === KEY ? 'run-5' : null) },
    })
    const chunks = []
    const done = (async () => { for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId: 's', model: 'jev-auto', signal: new AbortController().signal })) chunks.push(c) })()
    await settle()
    t.mock.timers.tick(100)
    await settle()
    await done
    return textOf(chunks)
  }
  const c = await replyOf(() => new Promise(() => {}))
  assert.ok(c.startsWith('OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (0.1 s so far).'), c)
  assert.match(c, /^\[jev-run\]: kzh-run-1-run-5$/m, 'C names the run its task has begun by now')
  const ended = await replyOf(async () => ({ settled: 'failed' }))
  assert.ok(ended.startsWith('**jev-4** ended before Jev picked its agent (Failed).'), ended)
  assert.match(ended, /^\[jev-run\]: kzh-run-1-run-5$/m, 'as does the reply that its task ended')
})

test('a start reply written after a read pass handed its task back carries the run the task is on by then: B, where it waits for its folder again, and C, where it starts again at once', async () => {
  /** The reply for a task queued before its run began, whose read pass handed it back before its pick, and which is on run-5 by now (orchestrator.runOf). */
  const replyOf = async (waiting) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: {
        results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs: 100, runId: null }), noteAck: () => {},
        watchPlan: async () => ({ handedBack: true, waiting, why: 'it needs to change files' }), runOf: (key) => (key === KEY ? 'run-5' : null),
      },
    })
    return (await streamOf(a, 'fix the parser')).text
  }
  const b = await replyOf({ why: 'workspace', place: 2, ahead: 0 })
  assert.ok(b.startsWith('OK, **jev-4** is queued: 2nd in line for kz-harness (another task is running there).'), b)
  assert.match(b, /^\[jev-run\]: kzh-run-1-run-5$/m, 'B names the run its task has begun')
  const c = await replyOf(null)
  assert.ok(c.startsWith('OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent.'), c)
  assert.match(c, /^\[jev-run\]: kzh-run-1-run-5$/m, 'and so does C')
})

test('with Progress in chat off, C at the bound and B or C after a hand-back promise only the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  /** The reply's words before its marks, with watchPlan as given and the clock moved on `ms` once the wait began. */
  const replyOf = async (watchPlan, ms = 0) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs: 100, progress: 'off' }), watchPlan, noteAck: () => {} },
    })
    const chunks = []
    const done = (async () => { for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId: 's', model: 'jev-auto', signal: new AbortController().signal })) chunks.push(c) })()
    await settle()
    if (ms) t.mock.timers.tick(ms)
    await settle()
    await done
    return textOf(chunks).split('\n\n[jev-job]')[0]
  }
  const only = ' I\'ll report back here when it\'s done. Keep chatting.'
  assert.equal(await replyOf(() => new Promise(() => {}), 100), `OK, **jev-4** is starting in kz-harness, and Jev is still choosing the agent (0.1 s so far).${only}`, 'C at the bound says nothing of saying the pick')
  assert.equal(await replyOf(async () => ({ handedBack: true, waiting: { why: 'workspace', place: 2, ahead: 0 }, why: 'it needs to change files' })), `OK, **jev-4** is queued: 2nd in line for kz-harness (another task is running there). Jev picks the agent when it starts;${only}`, 'nor B, once a read pass handed it back to a folder that is busy')
  assert.equal(await replyOf(async () => ({ handedBack: true, waiting: null, why: 'it needs to change files' })), `OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent.${only}`, 'nor C, once one handed it back to a folder that is free')
})

test('the wait\'s block shows the router\'s own lines after its choosing line, those heard before it opened first, and a pick within 600 ms shows none of them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reasoning = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  /** One reply whose watchPlan keeps where the router's lines go (`tell`) and picks when the test says (`pick`). */
  const reply = (sessionId) => {
    const w = { chunks: [], tell: null, pick: null, done: null }
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ waitMs: 1500 }), watchPlan: (key, o) => { w.tell = o.onLine; return new Promise((r) => { w.pick = r }) }, noteAck: () => {} },
    })
    w.done = (async () => { for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] }], sessionId, model: 'jev-auto', signal: new AbortController().signal })) w.chunks.push(c) })()
    return w
  }
  const slow = reply('s1')
  await settle()
  assert.equal(typeof slow.tell, 'function', 'the reply waits on watchPlan, and tells it where the router\'s lines go')
  slow.tell('Jev route: 9/9 questions in 400 ms')
  t.mock.timers.tick(599)
  await settle()
  assert.equal(slow.chunks.length, 0, 'a line heard before the block opens waits for it, so a quick pick still looks instant')
  t.mock.timers.tick(1)
  await settle()
  slow.tell('Routed to claude (jev)')
  await settle()
  slow.pick(PICKED)
  await settle()
  await slow.done
  const choosing = 'Queued as jev-4. Choosing the agent (I reply once it\'s picked, at most 1.5 s). Stop here ends this reply only; the task keeps going (stop it on the work board).'
  assert.equal(reasoning(slow.chunks), `${choosing}\nJev route: 9/9 questions in 400 ms\nRouted to claude (jev)\n`, 'the choosing line, then each router line in the order it came')
  assert.deepEqual(slow.chunks.filter((c) => c.type === 'block-start').map((c) => [c.blockType, c.index]), [['reasoning', 0], ['text', 1]], 'the block, then reply A after it')
  assert.ok(textOf(slow.chunks).startsWith('OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high)'), textOf(slow.chunks))
  // A pick within 600 ms opens no block, whatever lines came before it.
  const quick = reply('s2')
  await settle()
  quick.tell('Jev route: 9/9 questions in 100 ms')
  quick.tell('Routed to claude (jev)')
  quick.pick(PICKED)
  await settle()
  await quick.done
  assert.deepEqual(quick.chunks.filter((c) => c.type === 'reasoning-delta' || c.blockType === 'reasoning'), [], 'no block for a quick pick')
  assert.ok(textOf(quick.chunks).startsWith('OK, I\'ll run **Claude Code**'), textOf(quick.chunks))
})

test('a task queued after a direct answer says, when it is judged read only, that it runs locked or why it waits like work that writes', async () => {
  const verdict = { p: 0.93, bar: 0.8, by: 'jev', reads: true }
  /** What follows the answer, for a task queued as `queued` says. */
  const tail = async (queued) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => BOTH, auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async () => queued, noteAck: () => {} },
    })
    const { text } = await streamOf(a, 'what does the parser do, and also check whether the lexer has the same bug?')
    assert.ok(text.startsWith('An answer.\n\n'), text)
    return text.split('\n\n').at(-1)
  }
  const locked = 'Read only: Jev judged it only reads the project (93%, its bar is 80%), so it runs on an agent locked against writing, beside any task changing kz-harness.'
  assert.equal(await tail(startsNow({ access: { mode: 'read', verdict } })), `OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent. ${locked}`)
  const why = 'no agent here can be locked against writing (codex: Codex cannot be locked through its provider)'
  assert.equal(await tail(startsNow({ startsNow: false, waiting: { why: 'workspace', place: 2, ahead: 0 }, access: { mode: 'write', verdict, why } })), `OK, **jev-4** is queued: 2nd in line for kz-harness (another task is running there). Read only: Jev judged it only reads the project (93%, its bar is 80%), but ${why}, so it waits for kz-harness like work that writes.`)
  assert.equal(await tail(startsNow({ access: { mode: 'write', verdict, why } })), `OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent. Read only: Jev judged it only reads the project (93%, its bar is 80%), but ${why}, so it runs as work that writes, and a task changing kz-harness waits for it.`)
  assert.equal(await tail(startsNow({ startsNow: false, waiting: { why: 'cap', place: 1, ahead: 0, slot: 1 }, access: { mode: 'read', verdict } })), `OK, **jev-4** is queued: next for a free slot to start in kz-harness (the resource budget caps how many tasks run at once). ${locked}`)
  assert.equal(await tail(startsNow({ startsNow: false, waiting: { why: 'cap', place: 1, ahead: 0, slot: 1 }, access: { mode: 'write', verdict, why } })), `OK, **jev-4** is queued: next for a free slot to start in kz-harness (the resource budget caps how many tasks run at once). Read only: Jev judged it only reads the project (93%, its bar is 80%), but ${why}, so it runs as work that writes, and a task changing kz-harness waits for it.`, 'one waiting only for a free slot does not wait for the folder, since nothing holds it')
  assert.equal(await tail(startsNow()), 'OK, **jev-4** is starting in kz-harness, and Jev is choosing the agent.', 'a task not judged read only says nothing of it')
})

test('a message Laya could not sort says why it runs as a task in the start reply the adapter writes: A once the pick lands, C at the bound, and B or C once a read pass hands it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const why = 'Laya could not sort this message (timed out after 8 s); treating it as a task.'
  const enqueued = []
  /** The reply's words before its marks, with watchPlan as given and the clock moved on `ms` once the wait began. */
  const replyOf = async (watchPlan, ms = 0) => {
    const a = jevAdapter({
      ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task', unsure: true, why }), auxModel: aux, agents: async () => AGENTS,
      orchestrator: { results: () => [], live: () => 0, enqueue: async (fields, extra) => { enqueued.push(extra); return startsNow({ waitMs: 100 }) }, watchPlan, noteAck: () => {} },
    })
    const chunks = []
    const done = (async () => { for await (const c of a.stream({ messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'what is wrong with the parser?' }] }], sessionId: 's', model: 'laya-auto', signal: new AbortController().signal })) chunks.push(c) })()
    await settle()
    if (ms) t.mock.timers.tick(ms)
    await settle()
    await done
    return textOf(chunks).split('\n\n[jev-job]')[0]
  }
  const picked = { ...PICKED, decidedBy: { ...PICKED.decidedBy, decider: 'laya' } }
  assert.equal(await replyOf(async () => picked), `OK, I'll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. ${why} I'll report back here when it's done. Keep chatting.\n\n> Picked by Laya on this PC in 2.4 s: a code change, medium risk, so effort high.`)
  assert.equal(await replyOf(() => new Promise(() => {}), 100), `OK, **jev-4** is starting in kz-harness, and Laya is still choosing the agent (0.1 s so far). ${why} I'll say here which one it picks, and report back when it's done. Keep chatting.`)
  assert.equal(await replyOf(async () => ({ handedBack: true, waiting: { why: 'workspace', place: 2, ahead: 0 }, why: 'it needs to change files' })), `OK, **jev-4** is queued: 2nd in line for kz-harness (another task is running there). ${why} Laya picks the agent when it starts; I'll say which here, and report back when it's done. Keep chatting.`)
  assert.equal(await replyOf(async () => ({ handedBack: true, waiting: null, why: 'it needs to change files' })), `OK, **jev-4** is starting in kz-harness, and Laya is choosing the agent. ${why} I'll say here which one it picks, and report back when it's done. Keep chatting.`)
  assert.deepEqual(enqueued.map((e) => e?.why), [why, why, why, why], 'and the orchestrator is told it, for the reply it writes itself')
})

test('a message\'s intent sample rides its queued task and its run, and a question answered directly ends with its mark after the credit', async () => {
  const SAMPLE = '9b2f4c1e-7a6d-4e3b-9c8a-1f2e3d4c5b6a'
  const seen = []
  /** A classify that says `cls`, keeping the modalities each message was sorted with. */
  const says = (cls) => async (message, mode, decider, o) => { seen.push(o?.modalities); return cls }
  const enqueued = []
  const orchestrator = { results: () => [], live: () => 0, enqueue: async (fields, extra) => { enqueued.push(extra); return 'Queued as jev-4.' } }
  await run(jevAdapter({ ctx: projectCtx(), route: async () => 'unused', classify: says({ kind: 'task', intentSample: SAMPLE }), auxModel: aux, orchestrator }), 'fix the parser')
  assert.equal(enqueued.at(-1)?.intentSample, SAMPLE, 'the queued task carries the sample beside who decides it')
  const routed = []
  await run(jevAdapter({ ctx: projectCtx(), route: async (o) => { routed.push(o.intentSample); return 'report' }, classify: says({ kind: 'task', intentSample: SAMPLE }), auxModel: aux }), 'fix the parser')
  assert.deepEqual(routed, [SAMPLE], 'a run the person waits on carries it too')
  const answered = await run(jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: says({ kind: 'question', confidence: 0.95, intentSample: SAMPLE }), auxModel: aux }), 'what does the parser do?')
  assert.ok(answered.endsWith(`Answered by: x/y, directly: a question, no agents or project work\n\n[jev-intent]: kzh-intent-1-${SAMPLE}`), answered)
  enqueued.length = 0
  await run(jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: says({ ...BOTH, intentSample: SAMPLE }), auxModel: aux, orchestrator }), 'what does the parser do, and also fix the typo in it?')
  assert.equal(enqueued.length, 1, 'the work behind the answer is queued')
  assert.equal('intentSample' in enqueued[0], false, 'and carries no sample: the message was a question, whatever its extra work does')
  // No sample, nothing new: no mark, and no sample among the task's extras.
  const plain = await run(jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: says({ kind: 'question', confidence: 0.95 }), auxModel: aux }), 'what does the parser do?')
  assert.ok(plain.endsWith('directly: a question, no agents or project work'), plain)
  enqueued.length = 0
  await run(jevAdapter({ ctx: projectCtx(), route: async () => 'unused', classify: says({ kind: 'task' }), auxModel: aux, orchestrator }), 'fix the parser')
  assert.deepEqual(Object.keys(enqueued[0]).sort(), ['decider', 'message', 'readVerdict', 'why'])
  // The intent call is told whether the message carries an image.
  await runWith(jevAdapter({ ctx: chat(OK_TEXT), route: async () => '', classify: says({ kind: 'question', confidence: 0.95 }), auxModel: aux }), [{ type: 'text', text: 'what is this?' }, IMAGE])
  assert.deepEqual([seen[0], seen.at(-1)], [['text'], ['text', 'image']])
})

// ---------- `@jev-5 <words>`: words for a task of this chat, before anything sorts the message (docs/live-agent-view.md Feature 5) ----------

test('`@jev-5 do X` on a queued task calls orchestrator.steer with amend, replies \'jev-5 hasn\'t started, so I added this to its task.\', and never calls classify', async () => {
  const steered = []
  let classified = 0
  let enqueued = 0
  const chats = { s: { 'jev-5': { key: 'k5', jobId: 'jev-5', state: 'queued' }, 'jev-4': { key: 'k4', jobId: 'jev-4', state: 'running' } } }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => { throw new Error('nothing is routed') }, classify: async () => { classified++; return { kind: 'task' } }, auxModel: aux, agents: async () => AGENTS,
    orchestrator: {
      results: () => [], live: () => 0, noteAck: () => {}, enqueue: async () => { enqueued++; return startsNow() },
      taskOf: (sessionId, jobId) => chats[sessionId]?.[jobId] ?? null,
      steer: async (key, o) => { steered.push([key, o]); return key === 'k5' ? { result: 'added', state: 'added', words: 'jev-5 hasn\'t started, so I added this to its task.' } : { result: 'running', state: null, words: 'jev-4 is already running.' } },
    },
  })
  const reply = await streamOf(a, '@jev-5 do X')
  assert.equal(reply.text, 'jev-5 hasn\'t started, so I added this to its task.')
  assert.deepEqual(steered, [['k5', { text: 'do X', how: 'amend', via: '@' }]])
  assert.deepEqual([classified, enqueued], [0, 0], 'no classify call, and nothing new is queued')
  assert.equal(reply.chunks.at(-1).type, 'finish')
  // A task at work is asked about as it is, and the case of the id does not matter.
  assert.equal((await streamOf(a, '@JEV-4 also run the linter')).text, 'jev-4 is already running.')
  assert.deepEqual(steered[1], ['k4', { text: 'also run the linter', how: 'auto', via: '@' }])
  await streamOf(a, '@jev-5: and the changelog')
  assert.deepEqual(steered[2], ['k5', { text: 'and the changelog', how: 'amend', via: '@' }], 'a colon after the id is no part of the words')
  // No such task in this chat, no words, or a picture: nothing is sent, and nothing is sorted either.
  assert.equal((await streamOf(a, '@jev-9 do Y')).text, 'There is no jev-9 in this chat, so nothing was sent.')
  assert.equal((await streamOf(a, '@jev-5')).text, 'Write what jev-5 should know after its name, like @jev-5 also update the README.')
  const picture = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '@jev-5 use this mockup' }, { type: 'image', attachment: { attachmentId: 'a1' } }] }
  assert.equal((await streamOf(a, '', { messages: [picture] })).text, 'Pictures cannot be added to a task, so nothing was sent to jev-5. Send your words alone, or the picture as a new message.')
  assert.equal(steered.length, 3)
  assert.deepEqual([classified, enqueued], [0, 0])
  // Only a task's id is a shortcut: anything else after an @ is a message like any other.
  await streamOf(a, '@claude fix the parser')
  assert.equal(classified, 1)
})

test('`@jev-4 <words>` on a running Codex task replies \'Sent to jev-4: Codex takes it in at its next step.\', as index.js words what Steer did, and never calls classify', async () => {
  const { steerWords } = await import('../reply-words.js')
  const steered = []
  let classified = 0
  const chats = { s: { 'jev-4': { key: 'k4', jobId: 'jev-4', state: 'running', agent: 'codex' } } }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => { throw new Error('nothing is routed') }, classify: async () => { classified++; return { kind: 'task' } }, auxModel: aux, agents: async () => AGENTS,
    orchestrator: {
      results: () => [], live: () => 0, noteAck: () => {}, enqueue: async () => startsNow(),
      taskOf: (sessionId, jobId) => chats[sessionId]?.[jobId] ?? null,
      // index.js steerTask: the agent at work takes the words, said in reply-words.js's words.
      steer: async (key, o) => { steered.push([key, o]); return { result: 'sent', state: 'pending', words: steerWords({ jobId: 'jev-4', result: 'sent', via: o.via, agent: 'codex', names: { codex: 'Codex' } }) } },
    },
  })
  const reply = await streamOf(a, '@jev-4 also run the linter')
  assert.equal(reply.text, 'Sent to jev-4: Codex takes it in at its next step.')
  assert.deepEqual(steered, [['k4', { text: 'also run the linter', how: 'auto', via: '@' }]])
  assert.equal(classified, 0)
})

// ---------- quick and instant replies, switched on only when earned (docs/live-agent-view.md Feature 3, slice 9) ----------
/** Jev's last 50 scored guesses as the reply ledger keeps them, `right` of them right, the misses oldest. */
const recordOf = (right, decider = 'jev') => Array.from({ length: 50 }, (_, i) => ({ key: `r-${i}`, decider, predicted: { agent: 'claude', level: 'high', confidence: 0.95, trusted: true }, ran: { agent: 'claude', level: 'high' }, match: i >= 50 - right }))
/** A confident guess at an agent available now, as reply-ledger.js predictReply gives it. */
const GUESS = { agent: 'claude', level: 'high', confidence: 0.96, trusted: true }
/**
 * What index.js enqueue gives a task that starts at once of the predictor's guess for it (guessFor):
 * the guessed plan and the record that earned it once the ledger's rows earn it (reply-ledger.js
 * earnedGuess), else nothing, and the reply waits for routing as before.
 */
async function quickOf(rows, predicted, decider = 'jev') {
  const ledger = await import('../reply-ledger.js')
  assert.equal(typeof ledger.earnedGuess, 'function', 'reply-ledger.js says what a reply may name before routing picks')
  const e = ledger.earnedGuess(rows, decider, predicted)
  return e.quick ? { plan: { agent: predicted.agent, model: 'claude-opus-4-1', effort: 'high', level: predicted.level, speed: null }, record: { right: e.quick.right, of: e.quick.of } } : null
}
/** The adapter of a project chat whose orchestrator queues a task that starts at once, with `quick` when given. */
const quickAdapter = ({ quick, watchPlan, acks, classify = async () => ({ kind: 'task', confidence: 0.97 }), queued = [] }) => jevAdapter({
  ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify, auxModel: aux, agents: async () => AGENTS,
  orchestrator: { results: () => [], live: () => 0, enqueue: async (fields, extra) => { queued.push(extra); return startsNow(quick ? { quick } : {}) }, watchPlan, noteAck: (key, ack) => acks.push(ack) },
})
const reasoningOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta' || c.blockType === 'reasoning')
const QUICK_REPLY = 'OK, I\'ll run **Claude Code** with **claude-opus-4-1** (effort high) in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.'

test('quick: with a seeded ledger at 47 of 50 and a confident available prediction, the reply comes before routed, naming the guessed plan with the quick credit, after waiting for the pick no longer than a block of reasoning lines would stay shut, and notes what it named as quick', async () => {
  const acks = []
  const waited = []
  const started = Date.now()
  // Routing is still choosing: the pick never comes within the reply's wait.
  const a = quickAdapter({ quick: await quickOf(recordOf(47), GUESS), acks, watchPlan: (key, o) => { waited.push(o.waitMs); return new Promise(() => {}) } })
  const { chunks, text } = await streamOf(a, 'fix the parser')
  const [said, credit, job, ...rest] = text.split('\n\n')
  assert.equal(said, QUICK_REPLY)
  assert.equal(credit, '> Predicted on this PC from your recent tasks (right 47 of the last 50); Jev read the message in under 0.1 s. The pick is checked again when it starts.')
  assert.equal(job, `[jev-job]: kzh-job-1-${KEY}`)
  assert.deepEqual(rest, [], 'no agent strip: nobody has picked yet')
  assert.deepEqual(reasoningOf(chunks), [], 'no reasoning block')
  assert.deepEqual(waited, [600], 'it waited for the pick at most 600 ms, never the setting\'s 15 s')
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(acks, [{ gen: 1, said: { agent: 'claude', effort: 'high', model: 'claude-opus-4-1' }, guess: 'quick' }], 'it named the first routing\'s plan, by guess')
})

test('instant: with local intent task as well, jev.intent is never called and no reasoning chunk is emitted, and the reply says so', async () => {
  const { classifyIntent } = await import('../intent.js')
  let asked = 0
  // The intent domain at a local rung, sure the message is a task (domains.js decide): no Jev call.
  const domain = { decide: async () => ({ authority: 'local', sampleId: 'intent-1' }) }
  const classify = (task) => classifyIntent({ domain, message: task, ask: async () => { asked++; return { kind: 'task', confidence: 0.99 } } })
  const acks = []
  const a = quickAdapter({ quick: await quickOf(recordOf(47), GUESS), acks, classify, watchPlan: () => new Promise(() => {}) })
  const { chunks, text } = await streamOf(a, 'fix the parser')
  assert.equal(asked, 0, 'jev.intent is never called')
  assert.deepEqual(reasoningOf(chunks), [], 'no reasoning chunk, before the reply or in it')
  assert.equal(text.split('\n\n').slice(0, 2).join('\n\n'), `${QUICK_REPLY}\n\n> Instant reply: read and predicted on this PC, no Jev call (right 47 of the last 50). The pick is checked again when it starts.`)
  assert.equal(acks[0]?.guess, 'instant')
})

test('at 44 of 50 the reply waits for routing, as before quick replies were earned: the setting\'s whole wait, then the pick with the credit of whoever made it', async () => {
  const acks = []
  const waited = []
  assert.equal(await quickOf(recordOf(44), GUESS), null, 'not earned')
  const a = quickAdapter({ quick: await quickOf(recordOf(44), GUESS), acks, watchPlan: (key, o) => { waited.push(o.waitMs); return new Promise((r) => setTimeout(() => r(PICKED), 700)) } })
  const { text } = await streamOf(a, 'fix the parser')
  assert.deepEqual(waited, [15_000])
  assert.equal(text.split('\n\n')[1], '> Picked by Jev in 2.4 s: a code change, medium risk, so effort high.', 'the pick it waited for, after the 600 ms a quick reply would have waited')
  assert.deepEqual(acks, [{ gen: 1, said: { agent: 'claude', effort: 'high' } }])
})

test('an unavailable predicted agent waits: a guess masked to its second best is untrusted, so no reply names it before routing', async () => {
  // Claude is the predictor's favourite, and out of reach now: predictReply gives Codex, untrusted.
  const masked = { agent: 'codex', level: 'medium', confidence: 0.6, trusted: false }
  assert.equal(await quickOf(recordOf(50), masked), null)
  const acks = []
  const waited = []
  const a = quickAdapter({ quick: await quickOf(recordOf(50), masked), acks, watchPlan: (key, o) => { waited.push(o.waitMs); return Promise.resolve(PICKED) } })
  const { text } = await streamOf(a, 'fix the parser')
  assert.deepEqual(waited, [15_000])
  assert.doesNotMatch(text, /Predicted on this PC/)
  assert.deepEqual(acks.map((x) => x.guess), [undefined])
})

test('Laya Auto never uses local intent: Laya reads the message, and its quick reply, earned by Laya\'s own record, says Laya read it on this PC, never that it is instant', async () => {
  const acks = []
  const queued = []
  const sorted = []
  // Even an answer that claimed a local decision is Laya's reading here.
  const classify = async (task, mode, decider) => { sorted.push(decider); return { kind: 'task', confidence: 0.91, decidedBy: 'local' } }
  const a = quickAdapter({ quick: await quickOf(recordOf(46, 'laya'), GUESS, 'laya'), acks, classify, queued, watchPlan: () => new Promise(() => {}) })
  const { text } = await streamOf(a, 'fix the parser', { model: 'laya-auto' })
  assert.deepEqual(sorted, ['laya'])
  assert.equal(queued[0]?.decider, 'laya', 'the task is Laya\'s, and so is the record its reply reads')
  assert.equal(text.split('\n\n')[1], '> Predicted on this PC from your recent tasks (right 46 of the last 50); Laya read the message on this PC in under 0.1 s. The pick is checked again when it starts.')
  assert.equal(acks[0]?.guess, 'quick')
})

test('routed within 600 ms replaces the prediction with the real plan: the Feature 2 credit, the agent strip, no reasoning block, and the pick noted as routed', async () => {
  const acks = []
  const codex = { ...PICKED, plan: { agent: 'codex', model: 'gpt-5.5', effort: 'medium', level: 'medium', speed: null } }
  const a = quickAdapter({ quick: await quickOf(recordOf(47), GUESS), acks, watchPlan: () => new Promise((r) => setTimeout(() => r(codex), 100)) })
  const { chunks, text } = await streamOf(a, 'fix the parser')
  assert.equal(text.split('\n\n[jev-job]')[0], 'OK, I\'ll run **Codex (GPT)** with **gpt-5.5** (effort medium) in the background as **jev-4** in kz-harness. I\'ll report back here when it\'s done. Keep chatting.\n\n> Picked by Jev in 2.4 s: a code change, medium risk, so effort medium.')
  assert.deepEqual(strip(text).at(-1), { agent: 'codex', model: 'gpt-5.5, medium', roles: ['work'] })
  assert.deepEqual(reasoningOf(chunks), [])
  assert.deepEqual(acks, [{ gen: 1, said: { agent: 'codex', effort: 'medium' } }], 'what routing picked, which needs no notice')
})

test('reply B naming the likely agent notes it, so a change of plan follows when another runs; and reply A naming a tool notes the tool, not the agent behind it', async () => {
  const acks = []
  const line = 'OK, **jev-5** is queued: 2nd in line for kz-harness (another task is running there). Jev picks the agent when it starts, likely **Claude Code** (effort high); I\'ll say which here, and report back when it\'s done. Keep chatting.'
  const likely = { agent: 'claude', effort: 'high', model: 'claude-opus-4-1' }
  const b = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow({ line, jobId: 'jev-5', startsNow: false, waiting: { why: 'workspace', place: 2, ahead: 0 }, likely }), watchPlan: () => new Promise(() => {}), noteAck: (key, ack) => acks.push(ack) },
  })
  assert.equal((await streamOf(b, 'tidy the parser')).text, `${line}\n\n[jev-job]: kzh-job-1-${KEY}`)
  assert.deepEqual(acks, [{ gen: 0, said: likely, guess: 'likely' }])
  const tool = { plan: { agent: 'codex', model: null, effort: 'medium', level: 'medium', speed: null, tool: 'lint' }, gen: 1, runId: 'run-4', ms: 1200, decidedBy: { by: 'decider', decider: 'jev', taskType: 'simple_change', complexity: 0.2, risk: 0.2, from: 'auto' } }
  const a = jevAdapter({
    ctx: projectCtx('C:\\work\\kz-harness'), route: async () => 'unused', classify: async () => ({ kind: 'task' }), auxModel: aux, agents: async () => AGENTS,
    orchestrator: { results: () => [], live: () => 0, enqueue: async () => startsNow(), watchPlan: async () => tool, noteAck: (key, ack) => acks.push(ack) },
  })
  await streamOf(a, 'lint the parser')
  assert.deepEqual(acks.at(-1), { gen: 1, said: { agent: 'tool:lint', effort: null } }, 'the tool alone, as the task list keeps it')
})

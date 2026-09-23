// What kind of outcome a request needs, and who on this machine can produce it.
//
// The router used to decide with a code-only question: is this a question or a coding
// task? That vocabulary cannot express OCR, a document, a web lookup or "ask the person",
// so those requests had nowhere to go. Here every executor declares what it can do, code
// removes the ones that cannot do this request before Jev is asked, and Jev picks from
// what is left. Adding an executor is a registration, not another branch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITIES, createRegistry, eligible, executorsFrom, rank, validateExecutor } from '../capabilities.js'

const base = {
  kind: 'agent', capabilities: [], modalities: ['text'], mutation: false, network: true,
  locality: 'hosted', latency: 'medium', cost: 'metered', credentials: [], verification: [], maxInputBytes: null,
}
const agent = (id, over = {}) => ({ ...base, id, name: id, ...over })

test('every capability the spec names exists, with a description Jev can be asked about', () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), [
    'deterministic_tool', 'document_processing', 'human_required', 'image_inspection',
    'ocr', 'project_change', 'project_read', 'quick_answer', 'reasoned_answer', 'web_research',
  ])
  for (const [id, what] of Object.entries(CAPABILITIES)) assert.ok(what.length > 20, `${id} needs a real description`)
})

test('an executor must declare the whole contract, so nothing is silently assumed', () => {
  const r = createRegistry()
  assert.throws(() => r.register({ id: 'x', name: 'x' }), /capabilities/)
  for (const field of ['modalities', 'mutation', 'network', 'locality', 'latency', 'cost', 'verification', 'maxInputBytes']) {
    const partial = { ...base, id: 'x', name: 'x' }
    delete partial[field]
    assert.throws(() => r.register(partial), new RegExp(field), `${field} is required`)
  }
  assert.throws(() => r.register(agent('a', { cost: 'cheap' })), /cost/)
  assert.throws(() => r.register(agent('a', { locality: 'somewhere' })), /locality/)
  assert.equal(r.register(agent('a')).id, 'a')
  assert.throws(() => r.register(agent('a')), /already registered/)
})

test('an executor that does not support the capability is filtered out before Jev is asked', () => {
  const list = [agent('coder', { capabilities: ['project_change'] }), agent('ocr-tool', { kind: 'tool', capabilities: ['ocr'], cost: 'free' })]
  const only = eligible(list, { capability: 'ocr' })
  assert.deepEqual(only.map((e) => e.id), ['ocr-tool'], 'the agent that cannot do OCR is never offered')
})

test('OCR never reaches a text-only executor, even one that claims the capability', () => {
  const list = [
    agent('text-only', { capabilities: ['ocr'] }),
    agent('reads-images', { capabilities: ['ocr'], modalities: ['text', 'image'] }),
  ]
  assert.deepEqual(eligible(list, { capability: 'ocr', modalities: ['image'] }).map((e) => e.id), ['reads-images'],
    'a claimed capability without the modality is not enough')
})

test('a change is never handed to an executor that may not write', () => {
  const list = [agent('reader', { capabilities: ['project_read'] }), agent('writer', { capabilities: ['project_read', 'project_change'], mutation: true })]
  assert.deepEqual(eligible(list, { capability: 'project_change', mutation: true }).map((e) => e.id), ['writer'])
})

test('offline and local-only drop everything that needs the network', () => {
  const list = [agent('cloud', { capabilities: ['quick_answer'] }), agent('on-this-pc', { capabilities: ['quick_answer'], locality: 'local', network: false, cost: 'free' })]
  assert.deepEqual(eligible(list, { capability: 'quick_answer', locality: 'local', network: false }).map((e) => e.id), ['on-this-pc'])
})

test('an executor that is unavailable, unauthenticated or too small is omitted', () => {
  const list = [
    agent('at-limit', { capabilities: ['quick_answer'] }),
    agent('no-key', { capabilities: ['quick_answer'], credentials: ['SOME_KEY'] }),
    agent('tiny', { capabilities: ['document_processing'], maxInputBytes: 1000 }),
  ]
  const got = eligible(list, {
    capability: 'quick_answer',
    available: new Set(['at-limit']),
    credentials: new Set(),
  })
  assert.deepEqual(got.map((e) => e.id), [], 'both are incapable right now')
  assert.deepEqual(eligible(list, { capability: 'document_processing', inputBytes: 5000 }).map((e) => e.id), [],
    'a document larger than the executor accepts is not offered')
  assert.deepEqual(eligible(list, { capability: 'document_processing', inputBytes: 999 }).map((e) => e.id), ['tiny'])
})

test('a deterministic tool beats a model when it fully covers the request', () => {
  const list = [
    agent('strong-agent', { capabilities: ['deterministic_tool'], latency: 'fast', locality: 'local', cost: 'free' }),
    agent('convert-tool', { kind: 'tool', capabilities: ['deterministic_tool'], latency: 'fast', cost: 'free' }),
  ]
  assert.deepEqual(rank(list, { capability: 'deterministic_tool' }).map((e) => e.id), ['convert-tool', 'strong-agent'])
})

test('a simple answer goes to the fastest local model, not the cheapest cloud one', () => {
  const list = [
    agent('cloud-cheap', { capabilities: ['quick_answer'], latency: 'fast', cost: 'metered' }),
    agent('local-snappy', { capabilities: ['quick_answer'], latency: 'fast', locality: 'local', network: false, cost: 'free' }),
    agent('local-slow', { capabilities: ['quick_answer'], latency: 'slow', locality: 'local', network: false, cost: 'free' }),
  ]
  assert.deepEqual(rank(list, { capability: 'quick_answer', simple: true }).map((e) => e.id),
    ['local-snappy', 'local-slow', 'cloud-cheap'])
})

test('otherwise the cheapest capable executor comes first, ties by latency', () => {
  const list = [
    agent('b-metered-slow', { capabilities: ['reasoned_answer'], cost: 'metered', latency: 'slow' }),
    agent('a-metered-fast', { capabilities: ['reasoned_answer'], cost: 'metered', latency: 'fast' }),
    agent('c-subscription', { capabilities: ['reasoned_answer'], cost: 'subscription' }),
    agent('d-local', { capabilities: ['reasoned_answer'], locality: 'local', network: false, cost: 'free', latency: 'slow' }),
  ]
  assert.deepEqual(rank(list, { capability: 'reasoned_answer' }).map((e) => e.id),
    ['d-local', 'c-subscription', 'a-metered-fast', 'b-metered-slow'])
})

test('the registry is data driven: a new executor needs no new branch', () => {
  const r = createRegistry()
  r.register(agent('translator', { capabilities: ['deterministic_tool'], kind: 'tool', cost: 'free' }))
  r.register(agent('coder', { capabilities: ['project_change'], mutation: true }))
  assert.deepEqual(r.offered({ capability: 'deterministic_tool' }).map((e) => e.id), ['translator'])
  assert.deepEqual(r.offered({ capability: 'project_change', mutation: true }).map((e) => e.id), ['coder'])
  assert.deepEqual(r.offered({ capability: 'ocr' }), [], 'nothing here can do OCR, and it says so rather than guessing')
})

// ---------- deriving declarations from the real catalog ----------

const CATALOG = {
  agents: [
    { id: 'claude', name: 'Claude Code', provider: 'claude-code', enabled: true },
    { id: 'deepseek', name: 'DeepSeek agent', provider: 'spawn', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
    { id: 'gemma-local', name: 'Gemma 4 E4B (local)', kind: 'local', role: 'fast', enabled: true, llm: { provider: 'local', model: 'gemma4-e4b' } },
  ],
  tools: [{ id: 'convert', description: 'Convert a file exactly', enabled: true }],
  chat: [{ provider: 'local', model: 'gemma4-e4b', name: 'Gemma (local)' }, { provider: 'deepseek', model: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }],
}

test('the catalog becomes executor declarations, with the capabilities each kind really has', () => {
  const list = executorsFrom(CATALOG)
  const claude = list.find((e) => e.id === 'claude')
  assert.ok(claude.capabilities.includes('project_change'))
  assert.ok(claude.capabilities.includes('project_read'))
  assert.equal(claude.mutation, true)
  assert.equal(claude.locality, 'hosted')
  assert.equal(claude.cost, 'subscription', 'a subscription login is not metered per token')
  assert.ok(claude.network, 'Claude Code needs the network')
  for (const e of list) assert.doesNotThrow(() => validateExecutor(e), `${e.id} declares the full contract`)
})

test('a local model is free, offline-capable and fast; a metered one is not either', () => {
  const list = executorsFrom(CATALOG)
  const gemma = list.find((e) => e.id === 'gemma-local')
  assert.equal(gemma.locality, 'local')
  assert.equal(gemma.network, false)
  assert.equal(gemma.cost, 'free')
  assert.equal(gemma.latency, 'fast', 'its manifest role says fast')
  const ds = list.find((e) => e.id === 'deepseek')
  assert.equal(ds.cost, 'metered')
  assert.ok(ds.network)
})

test('a registered script is a deterministic executor, and ranks ahead of every model', () => {
  const list = executorsFrom(CATALOG)
  const tool = list.find((e) => e.id === 'tool:convert')
  assert.equal(tool.kind, 'tool')
  assert.deepEqual(tool.capabilities, ['deterministic_tool'])
  const offered = rank(eligible(list, { capability: 'deterministic_tool' }), {})
  assert.equal(offered[0].id, 'tool:convert', 'the exact script wins when it covers the request')
})

test('only an executor that really reads images is offered image work', () => {
  const list = executorsFrom({ ...CATALOG, seesImages: (id) => id === 'claude' })
  assert.ok(list.find((e) => e.id === 'claude').capabilities.includes('ocr'))
  assert.equal(list.find((e) => e.id === 'deepseek').capabilities.includes('ocr'), false)
  const offered = eligible(list, { capability: 'ocr', modalities: ['image'] })
  assert.deepEqual(offered.map((e) => e.id), ['claude'], 'the text-only agent is never offered OCR')
})

test('a chat model answers questions and may never change the project', () => {
  const list = executorsFrom(CATALOG)
  const chat = list.find((e) => e.kind === 'chat' && e.cost === 'free')
  assert.deepEqual(chat.capabilities.sort(), ['quick_answer', 'reasoned_answer'])
  assert.equal(chat.mutation, false)
  assert.deepEqual(eligible(list, { capability: 'project_change', mutation: true }).some((e) => e.kind === 'chat'), false,
    'no chat model is ever handed a change')
})

test('the cost class comes from the billing kind and the economics override, never the provider name', () => {
  const agents = [
    { id: 'acme', name: 'Acme', provider: 'acme-cli', kind: 'subscription', enabled: true },
    { id: 'renamed', name: 'Renamed', provider: 'claude-code', kind: 'api', enabled: true },
    { id: 'byok', name: 'Key', provider: 'spawn', kind: 'api', enabled: true, llm: { provider: 'deepseek', model: 'deepseek-flash' } },
  ]
  const list = executorsFrom({ agents, economics: { byok: { marginalCost: 'low' } } })
  const cost = (id) => list.find((e) => e.id === id).cost
  assert.equal(cost('acme'), 'subscription', 'an unfamiliar provider on a subscription is not metered')
  assert.equal(cost('renamed'), 'metered', 'a subscription CLI name does not outrank the kind it was given')
  assert.equal(cost('byok'), 'subscription', 'the operator override outranks the kind')
  // rank() sorts on it, which is what a capability swap lands on.
  assert.deepEqual(rank(list.filter((e) => e.id !== 'byok')).map((e) => e.id), ['acme', 'renamed'])
})

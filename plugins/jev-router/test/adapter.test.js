// The Jev Auto model must route what the person typed, never injected context.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jevAdapter } from '../adapter.js'

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
  assert.match(text, /Answered by: x \(y\), directly/)
  assert.equal(routed, false)
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

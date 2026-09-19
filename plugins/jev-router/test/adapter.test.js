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

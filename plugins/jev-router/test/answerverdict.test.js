// Like/Dislike under an answer: the DOM-free decisions behind the control. The browser half of
// client.js is a classic script, so the pure helpers exposed on `__test` are read the same way
// the transcript and task-list tests read theirs. The live rendering is verified in the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadPlugin() {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (r) => { registration = r } } }
  new Function('window', src)(window)
  const React = { createElement: () => null, Fragment: {}, useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}) }
  return registration.factory((id) => { if (id === 'react') return React; throw new Error(`unexpected require: ${id}`) })
}

const { messageProvenance, messageRunId, verdictProvider, storedVerdict, toggledVerdict, feedbackBody, canSuggest, modelId, tagsFor, toggledTag } = loadPlugin().__test
const marker = (steps) => `Some answer.\n\n[jev-agents]: kzh-agents-1-${Buffer.from(JSON.stringify(steps)).toString('base64url')}\n`

test('answer verdict: a routed answer reports its agent and model from the chain marker', () => {
  const text = marker([
    { agent: 'Jev', model: 'jev-1.13.0', roles: [] },
    { agent: 'deepseek', model: 'deepseek-flash, high', roles: ['work'], answered: true },
  ])
  assert.deepEqual(messageProvenance(text), { agent: 'deepseek', model: 'deepseek-flash', provider: '' })
})

test('answer verdict: a direct answer reports provider and model from the credit line', () => {
  assert.deepEqual(
    messageProvenance('Reply.\n\n> Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly: a question, no agents or project work'),
    { agent: '', model: 'deepseek-flash', provider: 'deepseek' },
  )
  // When the pretty name equals the pair there are no backticks, and the bare pair still names both.
  assert.deepEqual(
    messageProvenance('> Answered by: local/gemma-e4b, directly: a question, no agents or project work'),
    { agent: '', model: 'gemma-e4b', provider: 'local' },
  )
})

test('answer verdict: a message that reports no provenance says so instead of guessing', () => {
  assert.equal(messageProvenance('A background result with no credit at all.'), null)
  assert.equal(messageProvenance(''), null)
  assert.equal(messageProvenance(undefined), null)
})

test('answer verdict: a routed verdict is attributable before the agent list loads', () => {
  // The bug: a click made before loadEnabledAgents() resolves used to post an empty provider,
  // which feedbackPrior drops, so the owner's teaching signal was stored but never moved a pick.
  // The chain chip already names the agent and feedbackPrior resolves an agent id directly
  // (router.js:187), so the verdict is attributable from the answer's own text, with the
  // enabled-agent list left out of the decision entirely.
  const prov = messageProvenance(marker([
    { agent: 'Jev', model: 'jev-1.13.0', roles: [] },
    { agent: 'deepseek', model: 'deepseek-flash, high', roles: ['work'], answered: true },
  ]))
  assert.equal(verdictProvider(prov), 'deepseek', 'the chain chip names the agent itself')
  assert.notEqual(verdictProvider(prov), '', 'a fast click cannot store an empty provider')
  // The exact body the control posts when the list has not arrived: no agents argument exists.
  const body = feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', suggestedAgent: '', provider: verdictProvider(prov), model: prov.model })
  assert.equal(body.provider, 'deepseek', 'the committed row is attributable')
  assert.equal(body.model, 'deepseek-flash')
})

test('answer verdict: a direct answer keeps its provider, and no provenance stays empty', () => {
  const direct = messageProvenance('> Answered by: DeepSeek Flash (`deepseek/deepseek-flash`), directly: a question, no agents or project work')
  assert.equal(verdictProvider(direct), 'deepseek', 'a direct answer names its own provider')
  assert.equal(verdictProvider(null), '', 'a bare result card attributes to nothing rather than guessing')
  assert.equal(verdictProvider(undefined), '')
})

test('answer verdict: the stored verdict is the newest row for that message', () => {
  const rows = [
    { messageId: 'a', verdict: 'like' },
    { messageId: 'b', verdict: 'dislike' },
    { messageId: 'a', verdict: 'dislike', reason: 'wrong agent' },
  ]
  assert.deepEqual(storedVerdict(rows, 'a'), { messageId: 'a', verdict: 'dislike', reason: 'wrong agent' })
  assert.deepEqual(storedVerdict(rows, 'b'), { messageId: 'b', verdict: 'dislike' })
  assert.equal(storedVerdict(rows, 'c'), null)
  assert.equal(storedVerdict(undefined, 'a'), null)
})

test('answer verdict: clicking the active verdict clears it, a different one wins', () => {
  assert.equal(toggledVerdict('like', 'like'), null)
  assert.equal(toggledVerdict('dislike', 'dislike'), null)
  assert.equal(toggledVerdict('like', 'dislike'), 'dislike')
  assert.equal(toggledVerdict('dislike', 'like'), 'like')
  assert.equal(toggledVerdict(null, 'like'), 'like')
})

test('answer verdict: the POST body drops empty optionals and always keeps an empty reason', () => {
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'like', reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'like', reason: '' },
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: 'wrong agent', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: 'wrong agent', suggestedAgent: 'claude', provider: 'codex', model: 'gpt-5' },
  )
})

test('answer verdict: the tag rides the POST only when picked, and never on a clear', () => {
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '' },
    'an unpicked tag is left out, not sent as empty',
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: 'wrong agent', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '', tag: 'wrong agent' },
  )
  // The clear is built with the tag already dropped, so a pending chip cannot outlive the verdict.
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: null, reason: '', tag: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'clear', reason: '' },
  )
})

test('answer verdict: the offered tags match the verdict, and a pick toggles off', () => {
  assert.deepEqual(tagsFor('like'), ['good pick', 'good answer'])
  assert.deepEqual(tagsFor('dislike'), ['wrong agent', 'misread my question', 'wrong scope', 'not enough detail', 'too slow'])
  assert.deepEqual(tagsFor(null), [], 'no verdict, no chips')
  // A tag is optional: the same chip clicked again removes it.
  assert.equal(toggledTag('', 'too slow'), 'too slow')
  assert.equal(toggledTag('too slow', 'too slow'), '')
  assert.equal(toggledTag('too slow', 'wrong agent'), 'wrong agent')
})

test('answer verdict: clicking the active button sends the clear tombstone, not nothing', () => {
  // toggledVerdict nulls the UI state; feedbackBody is what decides the wire value, and a cleared
  // verdict must still be posted so the store can tombstone it.
  assert.equal(toggledVerdict('like', 'like'), null)
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: toggledVerdict('like', 'like'), reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'clear', reason: '' },
  )
  assert.deepEqual(
    feedbackBody({ sessionId: 's', messageId: 'm', verdict: toggledVerdict('like', 'dislike'), reason: '', suggestedAgent: '', provider: '', model: '' }),
    { sessionId: 's', messageId: 'm', verdict: 'dislike', reason: '' },
  )
})

test('answer verdict: the should-have-been list only offers ids the route accepts', () => {
  assert.equal(canSuggest({ id: 'claude' }), true)
  assert.equal(canSuggest({ id: 'gemma-local' }), true)
  assert.equal(canSuggest({ id: 'auto' }), false)
  assert.equal(canSuggest({ id: 'Claude' }), false)
  assert.equal(canSuggest({ id: 'has space' }), false)
  assert.equal(canSuggest(null), false)
})

test('answer verdict: a chain model keeps only the model, not the effort', () => {
  assert.equal(modelId('deepseek-flash, high'), 'deepseek-flash')
  assert.equal(modelId('opus'), 'opus')
  assert.equal(modelId(undefined), '')
})

test('answer verdict: the run an answer came from rides every verdict, read off the answer itself', async () => {
  // Without it the server can only guess the run by time: a first verdict on an older answer,
  // given after a newer run in the session had ended, was credited to the newer run.
  const { withRunMark } = await import('../index.js')
  const { validFeedback } = await import('../feedback.js')
  const text = withRunMark(`The answer.\n\n${marker([{ agent: 'deepseek', model: 'deepseek-flash', roles: ['work'], answered: true }]).trim()}`, 'run-older-1')
  assert.equal(messageRunId(text), 'run-older-1', 'the client reads the mark route() writes')
  assert.equal(messageRunId('A background result with no mark.'), '')
  // A turn that reports two runs is judged on the last, as its provenance is.
  assert.equal(messageRunId(withRunMark(withRunMark('two runs', 'first'), 'second')), 'second')
  const body = feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'dislike', reason: '', provider: 'deepseek', model: 'deepseek-flash', runId: messageRunId(text) })
  assert.equal(body.runId, 'run-older-1')
  assert.equal(validFeedback(body).runId, 'run-older-1', 'and the server stores it as sent')
  assert.ok(!('runId' in feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: null, runId: 'run-older-1' })), 'a clear needs no run')
  assert.ok(!('runId' in feedbackBody({ sessionId: 's-1', messageId: 'm-1', verdict: 'like', runId: '' })), 'no mark, no field')
})

test('answer verdict: the reply route() hands back carries the run mark', () => {
  // route() lives inside apply(), which needs the whole plugin runtime, so its return is read from
  // the source: every routed reply must go through withRunMark, or the client has no run to send.
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = index.indexOf('async function route(')
  const body = index.slice(start, index.indexOf('\n  async function ', start + 1))
  const replies = body.match(/return [^\n]*formatReport\(result\)[^\n]*/g) ?? []
  assert.ok(replies.length >= 1, 'route() returns the formatted report')
  for (const r of replies) assert.match(r, /withRunMark\(formatReport\(result\), result\.runId\)/, r)
})
